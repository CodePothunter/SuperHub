/**
 * 定时安排：主人经接口人建立、接口人给自己定的一次性跟进、系统内置的整理与早晚报，只有这一种机制。
 * 到点在接口人对话里出现一条提醒（配了推送地址时同时推送），「设置 → 定时安排」可查看、开关、删除。
 *
 * 时间写法：周期用 `daily HH:MM` / `weekdays HH:MM` / `weekly mon,thu HH:MM`（不接受 `every`）；
 * 一次性用本地时间 `YYYY-MM-DDTHH:MM`。时区跟随设置。本文件只有类型与纯函数，存储与执行在 src/dsh/schedules.ts。
 */
import { latestSlot, nextSlot, parseClock, slotKey, zonedInstant, type ClockSpec } from './clock.ts'

export type ScheduleContent = 'open-orders' | 'reminder' | 'brief' | 'review' | 'dream'
export const SCHEDULE_CONTENTS: readonly ScheduleContent[] = ['open-orders', 'reminder', 'brief', 'review', 'dream']
/** 建立者：主人经接口人、接口人自定的跟进、系统内置。 */
export type ScheduleBy = 'owner' | 'liaison' | 'system'
/**
 * 一个时段的结果。失败时 `attempts` 是已试次数；还会重试时带 `retryAt`（下一次尝试的时间点），这期间不投递失败说明，
 * 最后一次失败（第 3 次，或下一次会超出宽限）才在接口人对话里说明原因。
 */
export interface ScheduleRun { slot: string; at: string; status: 'delivered' | 'failed' | 'missed'; detail?: string; attempts?: number; retryAt?: string }

export interface Schedule {
  /** 小写字母数字短横线。 */
  id: string
  title: string
  /** 周期：daily / weekdays / weekly；与 at 二选一。 */
  when?: string
  /** 一次性：本地时间 YYYY-MM-DDTHH:MM。 */
  at?: string
  content: ScheduleContent
  /** reminder 到点说的话；brief / review 的补充要求。 */
  text?: string
  enabled: boolean
  by: ScheduleBy
  createdAt: string
  /** 从这一刻起的时段才算数：新建、改时间、重新启用时更新，之前的时段既不补投也不记为错过。缺省同 createdAt。 */
  since?: string
  lastRun?: ScheduleRun
}

export interface ScheduleInput {
  id?: string
  title?: string
  when?: string
  at?: string
  content?: ScheduleContent
  text?: string
}

/** 周期安排错过多久之内仍补投。 */
export const PERIODIC_GRACE = 6 * 3_600_000
/** 一次性安排错过多久之内仍补投。 */
export const ONCE_GRACE = 24 * 3_600_000
/** 执行失败后隔多久重试，一个时段最多试几次。 */
export const RETRY_WAIT = 10 * 60_000
export const MAX_ATTEMPTS = 3
export const MAX_AHEAD_DAYS = 180
export const TITLE_LIMIT = 40
export const TEXT_LIMIT = 500
const ID = /^[a-z][a-z0-9-]{1,40}$/
const AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }) }
export const scheduleGrace = (s: Pick<Schedule, 'at'>) => s.at ? ONCE_GRACE : PERIODIC_GRACE

/** 周期写法：解析并拒绝按间隔重复的 `every`。 */
export function periodicSpec(when: string): Extract<ClockSpec, { kind: 'daily' }> {
  let spec: ClockSpec
  try { spec = parseClock(when) } catch (error) { return fail(`时间规则写法不对（${(error as Error).message}）。可用 daily HH:MM、weekdays HH:MM、weekly mon,thu HH:MM。`) }
  if (spec.kind !== 'daily') return fail('定时安排不支持按间隔重复（every），请写每天、工作日或每周某几天的具体时间。')
  return spec
}

/** 本地时间 YYYY-MM-DDTHH:MM 换成时间点；不合法时报错。 */
export function onceInstant(at: string, timeZone: string): Date {
  const m = AT.exec(at)
  if (!m) return fail('一次性时间要写成本地时间 YYYY-MM-DDTHH:MM，例如 2026-11-27T09:00。')
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number]
  const date = new Date(Date.UTC(y, mo - 1, d))
  if (mo < 1 || mo > 12 || date.getUTCDate() !== d || h > 23 || mi > 59) return fail(`日期或时间不存在：${at}`)
  return zonedInstant(y, mo, d, h * 60 + mi, timeZone)
}

/**
 * 校验并整理一条安排的字段：when 与 at 二选一、content 合法、reminder 必须有 text。
 * 给了 now 时一次性时间还须在现在之后、180 天以内。
 */
export function validateSchedule(input: ScheduleInput, options: { now?: Date; timeZone?: string } = {}): Required<Pick<ScheduleInput, 'title' | 'content'>> & ScheduleInput {
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : ''
  if (!title || title.length > TITLE_LIMIT) fail(`title 需要 1 到 ${TITLE_LIMIT} 字，是给主人看的名字，例如「未关闭工单提醒」。`)
  if (input.id !== undefined && !ID.test(input.id)) fail('id 只能用小写字母、数字和短横线，以字母开头，例如 open-orders。')
  if (!input.content || !SCHEDULE_CONTENTS.includes(input.content)) fail(`content 取 ${SCHEDULE_CONTENTS.join(' / ')}。`)
  const when = typeof input.when === 'string' && input.when.trim() ? input.when.trim().toLowerCase().replace(/\s+/g, ' ') : undefined
  const at = typeof input.at === 'string' && input.at.trim() ? input.at.trim() : undefined
  if (!!when === !!at) fail('when（周期）和 at（一次性）要写且只写一个。')
  if (when) periodicSpec(when)
  if (at) {
    const instant = onceInstant(at, options.timeZone ?? 'UTC')
    if (options.now) {
      const ahead = instant.getTime() - options.now.getTime()
      if (ahead < 30_000) fail(`一次性时间 ${at.replace('T', ' ')} 已经过了，请写现在之后的时间。`)
      if (ahead > MAX_AHEAD_DAYS * 86_400_000) fail(`一次性安排最远只能定到 ${MAX_AHEAD_DAYS} 天后。`)
    }
  }
  const text = typeof input.text === 'string' ? input.text.replace(/\s+/g, ' ').trim() : ''
  if (text.length > TEXT_LIMIT) fail(`text 最多 ${TEXT_LIMIT} 字。`)
  if (input.content === 'reminder' && !text) fail('reminder 需要 text：到点要提醒主人的那句话。')
  return { ...input.id !== undefined && { id: input.id }, title, content: input.content!, ...when && { when }, ...at && { at }, ...text && { text } }
}

/** 最近一个已到的时段：周期取最近一次计划时刻，一次性取 at（到了才有）。 */
export function dueSlot(s: Pick<Schedule, 'when' | 'at'>, now: Date, timeZone: string): { slot: Date; key: string } | undefined {
  if (s.at) {
    const slot = onceInstant(s.at, timeZone)
    return slot.getTime() <= now.getTime() ? { slot, key: s.at } : undefined
  }
  if (!s.when) return undefined
  const slot = latestSlot(periodicSpec(s.when), now, timeZone)
  return slot && { slot, key: slotKey(slot, timeZone) }
}

/** 下一次触发：周期取下一个计划时刻；一次性在未执行时返回 at 的时间点。 */
export function nextRun(s: Pick<Schedule, 'when' | 'at' | 'lastRun'>, now: Date, timeZone: string): Date | undefined {
  if (s.at) {
    if (s.lastRun?.slot === s.at) return undefined
    const slot = onceInstant(s.at, timeZone)
    return slot.getTime() > now.getTime() - ONCE_GRACE ? slot : undefined
  }
  return s.when ? nextSlot(periodicSpec(s.when), now, timeZone) : undefined
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (minute: number) => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`

/** 给人看的时间规则：`工作日 09:00` / `每天 08:30` / `每周日 20:00` / `每周一、四 09:00` / `2026-11-27 09:00 一次`。 */
export function describeWhen(s: Pick<Schedule, 'when' | 'at'>): string {
  if (s.at) return `${s.at.replace('T', ' ')} 一次`
  if (!s.when) return ''
  const spec = periodicSpec(s.when)
  const days = [...new Set(spec.days)].sort((a, b) => (a || 7) - (b || 7))
  const time = hhmm(spec.minute)
  if (days.length === 7) return `每天 ${time}`
  if (days.join() === '1,2,3,4,5') return `工作日 ${time}`
  return `每周${days.map(day => WEEKDAY[day]).join('、')} ${time}`
}

/** 回执与清单里的具体时间：`2026-11-26 周四 09:00`。 */
export function formatLocal(instant: Date, timeZone: string): string {
  const key = slotKey(instant, timeZone)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant)
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
  return `${key.slice(0, 10)} 周${WEEKDAY[day] ?? '?'} ${key.slice(11)}`
}

/** 没给 id 时由标题生成：标题里的英文数字 + 短随机后缀；标题全是中文时用内容类别。 */
export function scheduleId(title: string, content: ScheduleContent, suffix: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 30)
  return `${slug || content}-${suffix}`.replace(/-+/g, '-')
}

export const BY_LABEL: Record<ScheduleBy, string> = { owner: '主人经接口人', liaison: '接口人自定跟进', system: '系统内置' }
