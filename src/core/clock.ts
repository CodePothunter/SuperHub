/**
 * 时钟规则：事件的一种来源。
 *
 * 规则写法（brain/rules.yaml 的 `when` 字段）：
 *   daily 08:30          每天
 *   weekdays 21:30       周一到周五
 *   weekly sun 20:00     每周某天（mon tue wed thu fri sat sun）
 *   every 30m            每隔 N 分钟（m）或小时（h），从 0 点起对齐
 *
 * 每次检查只返回"最近一个已到期的时刻"，配合事件去重键实现：重启不重复触发，错过的只补最近一次。
 */

export type ClockSpec =
  | { readonly kind: 'daily'; readonly minute: number; readonly days: readonly number[] }
  | { readonly kind: 'every'; readonly minutes: number }

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function parseTime(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!match) throw new Error(`时间格式应为 HH:MM：${text}`)
  const h = Number(match[1]), m = Number(match[2])
  if (h > 23 || m > 59) throw new Error(`时间超出范围：${text}`)
  return h * 60 + m
}

export function parseClock(when: string): ClockSpec {
  const parts = when.trim().toLowerCase().split(/\s+/)
  const [head, a, b] = parts
  if (head === 'daily' && a && parts.length === 2) return { kind: 'daily', minute: parseTime(a), days: [0, 1, 2, 3, 4, 5, 6] }
  if (head === 'weekdays' && a && parts.length === 2) return { kind: 'daily', minute: parseTime(a), days: [1, 2, 3, 4, 5] }
  if (head === 'weekly' && a && b && parts.length === 3) {
    const days = a.split(',').map(day => DAYS.indexOf(day))
    if (days.some(day => day < 0)) throw new Error(`星期应为 ${DAYS.join('/')}：${a}`)
    return { kind: 'daily', minute: parseTime(b), days }
  }
  if (head === 'every' && a && parts.length === 2) {
    const match = /^(\d+)([mh])$/.exec(a)
    if (!match) throw new Error(`间隔应写成 30m 或 2h：${a}`)
    const minutes = Number(match[1]) * (match[2] === 'h' ? 60 : 1)
    if (minutes < 5 || minutes > 24 * 60) throw new Error(`间隔应在 5 分钟到 24 小时之间：${a}`)
    return { kind: 'every', minutes }
  }
  throw new Error(`无法识别的时钟规则：${when}`)
}

/** 某时区下的本地日期与分钟数。 */
interface Local { readonly y: number; readonly mo: number; readonly d: number; readonly weekday: number; readonly minute: number }

function localOf(instant: Date, timeZone: string): Local {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(instant).map(part => [part.type, part.value]))
  return {
    y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day),
    weekday: DAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  }
}

/** 把某时区的本地时刻换算成 UTC 时间点（两次迭代，覆盖夏令时切换）。 */
export function zonedInstant(y: number, mo: number, d: number, minute: number, timeZone: string): Date {
  const wanted = Date.UTC(y, mo - 1, d, Math.floor(minute / 60), minute % 60)
  let guess = wanted
  for (let i = 0; i < 2; i++) {
    const local = localOf(new Date(guess), timeZone)
    const seen = Date.UTC(local.y, local.mo - 1, local.d, Math.floor(local.minute / 60), local.minute % 60)
    guess += wanted - seen
  }
  return new Date(guess)
}

/** 返回 `now` 之前（含）最近一次计划时刻；8 天内没有则返回 undefined。 */
export function latestSlot(spec: ClockSpec, now: Date, timeZone: string): Date | undefined {
  const local = localOf(now, timeZone)
  if (spec.kind === 'every') {
    const slotMinute = local.minute - (local.minute % spec.minutes)
    return zonedInstant(local.y, local.mo, local.d, slotMinute, timeZone)
  }
  for (let back = 0; back <= 8; back++) {
    // 用正午换算日期，避开夏令时零点附近的歧义。
    const noon = zonedInstant(local.y, local.mo, local.d, 12 * 60, timeZone)
    const day = localOf(new Date(noon.getTime() - back * 86_400_000), timeZone)
    if (!spec.days.includes(day.weekday)) continue
    const slot = zonedInstant(day.y, day.mo, day.d, spec.minute, timeZone)
    if (slot.getTime() <= now.getTime()) return slot
  }
  return undefined
}

/** 返回 `now` 之后（不含）最近一次计划时刻；`every` 规则和 8 天内没有的返回 undefined。 */
export function nextSlot(spec: ClockSpec, now: Date, timeZone: string): Date | undefined {
  if (spec.kind !== 'daily') return undefined
  const local = localOf(now, timeZone)
  for (let ahead = 0; ahead <= 8; ahead++) {
    const noon = zonedInstant(local.y, local.mo, local.d, 12 * 60, timeZone)
    const day = localOf(new Date(noon.getTime() + ahead * 86_400_000), timeZone)
    if (!spec.days.includes(day.weekday)) continue
    const slot = zonedInstant(day.y, day.mo, day.d, spec.minute, timeZone)
    if (slot.getTime() > now.getTime()) return slot
  }
  return undefined
}

/** 本地时间的可读键，用作去重键的一部分，例如 `2026-11-15T08:30`。 */
export function slotKey(slot: Date, timeZone: string): string {
  const l = localOf(slot, timeZone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${l.y}-${pad(l.mo)}-${pad(l.d)}T${pad(Math.floor(l.minute / 60))}:${pad(l.minute % 60)}`
}
