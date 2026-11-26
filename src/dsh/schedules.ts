/**
 * 定时安排的存储、到点执行、内容生成与 HTTP 接口（类型与时间计算见 src/core/schedules.ts）。
 *
 * 存储：`<brain>/ops/superhub-schedules.json`，原子写入；文件不存在时先迁移旧 `rules.yaml` 的 rules 与
 * `ops/timers.json` 的跟进，再补系统默认项（每周经验整理开启，早报、晚报默认关闭）。
 * 投递：到点在发件箱登记一条带 `schedule` 的接口人提醒（键 `schedule:<id>:<时段>`），未读徽标与推送沿用发件箱规则；
 * 同一时段只投一次，重启后靠发件箱的键与 `lastRun` 不重复；错过超出宽限的记为“已错过”。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { slotKey } from '../core/clock.ts'
import {
  describeWhen, dueSlot, formatLocal, MAX_ATTEMPTS, nextRun, RETRY_WAIT, scheduleGrace, scheduleId, validateSchedule,
  type Schedule, type ScheduleBy, type ScheduleInput, type ScheduleRun,
} from '../core/schedules.ts'
import { orderEnded, workspaceArchived, type V2Delegation } from '../core/workspace-v2.ts'
import type { CalendarWeek } from '../core/workspace-calendar.ts'
import type { Outbox } from './outbox.ts'
import type { Llm, ModelSelection } from './ports.ts'
import { json, type Route } from './http.ts'
import { workspaceError } from './superhub-goals.ts'
import type { WorkspaceV2Store } from './workspace-v2-store.ts'

export const SCHEDULES_FILE = 'superhub-schedules.json'
const MAX_SCHEDULES = 100
const NOTICE_LIMIT = 1500
const MODEL_TIMEOUT = 90_000
const KEEP_FINISHED = 7 * 86_400_000

/** 旧 rules.yaml 里的一条时钟规则（迁移用）。 */
export interface LegacyRule { id: string; when: string; text: string; enabled: boolean }

/** 系统内置的安排：每周经验整理默认开启；早报、晚报迁到接口人后默认关闭，由主人在设置里打开。 */
export const DEFAULT_SCHEDULES: readonly Pick<Schedule, 'id' | 'title' | 'when' | 'content' | 'enabled'>[] = [
  { id: 'weekly-dream', title: '每周经验整理', when: 'weekly sun 20:00', content: 'dream', enabled: true },
  { id: 'morning-brief', title: '早报', when: 'weekdays 08:30', content: 'brief', enabled: false },
  { id: 'evening-review', title: '晚报', when: 'weekdays 21:30', content: 'review', enabled: false },
]

const clip = (text: string, n: number) => text.length > n ? text.slice(0, Math.max(0, n - 1)) + '…' : text
const conflict = (message: string): never => workspaceError(409, message)

export interface ScheduleStoreOptions {
  timeZone: string
  now?: () => Date
  /** 读出旧 rules.yaml 的 rules 交给 save；save 成功后才从 rules.yaml 删掉 rules 键。 */
  takeLegacyRules?: (save: (rules: LegacyRule[]) => void) => void
  warn?: (message: string) => void
}

export class ScheduleStore {
  readonly file: string
  /** 本次启动是否做了初始化（迁移旧规则与跟进、补默认项）。 */
  readonly migrated: boolean
  private schedules: Schedule[] = []
  private readonly now: () => Date

  constructor(root: string, private readonly options: ScheduleStoreOptions) {
    this.file = join(root, 'ops', SCHEDULES_FILE)
    this.now = options.now ?? (() => new Date())
    mkdirSync(dirname(this.file), { recursive: true })
    if (existsSync(this.file)) {
      this.schedules = this.read()
      this.migrated = false
      return
    }
    const timersFile = join(root, 'ops', 'timers.json')
    let saved = false
    const initialize = (rules: LegacyRule[]) => {
      if (saved) return
      const now = this.now()
      const list = [...this.fromRules(rules, now), ...this.fromTimers(timersFile, now)]
      for (const item of DEFAULT_SCHEDULES) {
        if (!list.some(row => row.id === item.id)) list.push({ ...item, by: 'system', createdAt: now.toISOString(), since: now.toISOString() })
      }
      this.schedules = list
      this.save()
      saved = true
    }
    if (options.takeLegacyRules) options.takeLegacyRules(initialize)
    initialize([])
    rmSync(timersFile, { force: true })
    this.migrated = true
  }

  private read(): Schedule[] {
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as { schedules?: unknown }
      return Array.isArray(value.schedules) ? (value.schedules as Schedule[]).filter(row => row && typeof row.id === 'string' && typeof row.title === 'string') : []
    } catch (error) {
      this.options.warn?.(`定时安排文件无法读取，已按空清单处理：${(error as Error).message}`)
      return []
    }
  }

  private save(): void {
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, schedules: this.schedules }, null, 1)}\n`)
    renameSync(temp, this.file)
  }

  /** rules.yaml 的规则：weekly-dream → 经验整理，早报 / 晚报 → 迁移后默认关闭，其他 → 停用的提醒。 */
  private fromRules(rules: LegacyRule[], now: Date): Schedule[] {
    const stamp = now.toISOString()
    const out: Schedule[] = []
    for (const rule of rules) {
      const system = DEFAULT_SCHEDULES.find(item => item.id === rule.id)
      const when = (() => { try { return validateSchedule({ title: 'x', content: 'dream', when: rule.when }).when } catch { return undefined } })()
      if (system) {
        out.push({ ...system, when: when ?? system.when, enabled: rule.id === 'weekly-dream' ? rule.enabled : false, by: 'system', createdAt: stamp, since: stamp })
        continue
      }
      const id = /^[a-z][a-z0-9-]{1,40}$/.test(rule.id) ? rule.id : scheduleId(rule.id, 'reminder', randomUUID().slice(0, 4))
      if (!when || !rule.text.trim() || out.some(row => row.id === id)) {
        this.options.warn?.(`旧定时规则 ${rule.id} 无法迁移为定时安排（时间写法或内容不支持），原文仍在第二大脑的 git 历史里。`)
        continue
      }
      out.push({ id, title: clip(rule.id, 40), when, content: 'reminder', text: clip(rule.text.replace(/\s+/g, ' ').trim(), 500), enabled: false, by: 'owner', createdAt: stamp, since: stamp })
    }
    return out
  }

  /** ops/timers.json 里尚未到点的跟进 → 接口人自定的一次性提醒。 */
  private fromTimers(file: string, now: Date): Schedule[] {
    if (!existsSync(file)) return []
    let rows: unknown
    try { rows = JSON.parse(readFileSync(file, 'utf8')) } catch { return [] }
    if (!Array.isArray(rows)) return []
    const out: Schedule[] = []
    for (const raw of rows as Record<string, unknown>[]) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.at !== 'string' || typeof raw.text !== 'string') continue
      const at = new Date(raw.at)
      if (!(at.getTime() > now.getTime()) || !raw.text.trim()) continue
      const text = clip(raw.text.replace(/\s+/g, ' ').trim(), 500)
      out.push({ id: `followup-${raw.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || randomUUID().slice(0, 8)}`,
        title: clip('跟进：' + text, 40), at: slotKey(at, this.options.timeZone), content: 'reminder', text, enabled: true, by: 'liaison',
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now.toISOString(), since: now.toISOString() })
    }
    return out
  }

  list(): Schedule[] { return this.schedules.map(row => ({ ...row })) }
  get(id: string): Schedule | undefined { const row = this.schedules.find(s => s.id === id); return row && { ...row } }
  private find(id: string): Schedule { return this.schedules.find(s => s.id === id) ?? workspaceError(404, `没有这条定时安排：${id}`) }

  /** 新建（没有这个 id）或修改（只改给出的字段）。改了时间的从现在起重新计时段。 */
  upsert(input: ScheduleInput, by: ScheduleBy): { schedule: Schedule; created: boolean } {
    const now = this.now(), stamp = now.toISOString(), timeZone = this.options.timeZone
    const existing = input.id ? this.schedules.find(s => s.id === input.id) : undefined
    if (existing) {
      if (existing.by === 'system' && input.content && input.content !== existing.content) conflict(`「${existing.title}」是系统内置的安排，不能改内容类别，只能改时间或补充要求。`)
      const timed = !!(input.when || input.at)
      const merged = validateSchedule({ id: existing.id, title: input.title ?? existing.title, content: input.content ?? existing.content,
        ...timed ? { when: input.when, at: input.at } : { when: existing.when, at: existing.at }, text: input.text ?? existing.text },
      timed ? { now, timeZone } : { timeZone })
      const { when: _w, at: _a, text: _t, ...rest } = existing
      const next: Schedule = { ...rest, title: merged.title, content: merged.content, ...merged.when && { when: merged.when }, ...merged.at && { at: merged.at },
        ...merged.text && { text: merged.text }, ...timed && { since: stamp } }
      this.schedules = this.schedules.map(s => s.id === existing.id ? next : s)
      this.save()
      return { schedule: { ...next }, created: false }
    }
    const valid = validateSchedule(input, { now, timeZone })
    if (this.schedules.length >= MAX_SCHEDULES) conflict(`定时安排已有 ${MAX_SCHEDULES} 条，请先删掉不用的。`)
    let id = valid.id
    while (!id || this.schedules.some(s => s.id === id)) id = scheduleId(valid.title, valid.content, randomUUID().slice(0, 4))
    const schedule: Schedule = { id, title: valid.title, ...valid.when && { when: valid.when }, ...valid.at && { at: valid.at }, content: valid.content,
      ...valid.text && { text: valid.text }, enabled: true, by, createdAt: stamp, since: stamp }
    this.schedules.push(schedule)
    this.save()
    return { schedule: { ...schedule }, created: true }
  }

  /** 开或关。重新打开的从现在起计时段：停用期间的时段既不补投也不记错过。 */
  setEnabled(id: string, enabled: boolean): Schedule {
    const row = this.find(id)
    if (row.enabled !== enabled) {
      row.enabled = enabled
      if (enabled) row.since = this.now().toISOString()
      this.save()
    }
    return { ...row }
  }

  remove(id: string): Schedule {
    const row = this.find(id)
    if (row.by === 'system') conflict(`「${row.title}」是系统内置的安排，不能删除，可以停用。`)
    this.schedules = this.schedules.filter(s => s.id !== id)
    this.save()
    return row
  }

  recordRun(id: string, run: ScheduleRun): void {
    const row = this.schedules.find(s => s.id === id)
    if (!row) return
    row.lastRun = run
    this.save()
  }

  /** 已执行（或已错过）满 7 天的一次性安排从清单里移除。 */
  prune(now: Date): void {
    const rest = this.schedules.filter(s => !(s.at && s.lastRun?.slot === s.at && Date.parse(s.lastRun.at) < now.getTime() - KEEP_FINISHED))
    if (rest.length === this.schedules.length) return
    this.schedules = rest
    this.save()
  }
}

/** 清单与回执里的一行：时间规则、下一次触发、能否删除。 */
export function scheduleRow(s: Schedule, now: Date, timeZone: string) {
  let next: Date | undefined
  try { next = s.enabled ? nextRun(s, now, timeZone) : undefined } catch { next = undefined }
  let whenLabel = s.when ?? s.at ?? ''
  try { whenLabel = describeWhen(s) } catch { /* 损坏的旧数据原样显示 */ }
  const retry = s.lastRun?.status === 'failed' && s.lastRun.retryAt ? new Date(s.lastRun.retryAt) : undefined
  return { ...s, whenLabel, ...next && { next: next.toISOString(), nextLabel: formatLocal(next, timeZone) },
    ...retry && !Number.isNaN(retry.getTime()) && { retryLabel: slotKey(retry, timeZone).slice(11) }, removable: s.by !== 'system' }
}
export type ScheduleRow = ReturnType<typeof scheduleRow>

/**
 * 建立或修改后的回执：下一次触发的具体时间、投递位置（接口人对话、是否推送到手机）、在哪里查看。
 * 接口人照这段话转告主人，不得承诺回执以外的渠道。
 */
export function scheduleReceipt(row: ScheduleRow, created: boolean, push: boolean, timeZone: string, self = false): string {
  const head = self ? `已给自己定好跟进「${row.title}」` : `已${created ? '建立' : '修改'}「${row.title}」`
  const where = '到点会在接口人对话里提醒你' + (push ? '，同时推送到手机' : '；还没配置推送地址，所以不会推送到手机') + '。'
  if (!row.enabled) return `${head}：${row.whenLabel}。这条安排目前已停用，在「设置 → 定时安排」打开后才会提醒；${where}`
  const next = row.nextLabel ? `下一次 ${row.nextLabel}（${timeZone}）。` : '近期没有要触发的时间。'
  return `${head}：${row.whenLabel}。${next}${where}可在「设置 → 定时安排」查看、停用或删除。`
}

/** 发件箱里定时提醒的去重键。 */
export const scheduleNoticeKey = (id: string, slot: string) => `schedule:${id}:${slot}`

export interface ScheduleRunnerOptions {
  store: ScheduleStore
  outbox: Pick<Outbox, 'has' | 'enqueue'>
  timeZone: string
  now?: () => Date
  /** 生成到点要说的话；返回 undefined 表示本时段没有要说的（例如经验整理已做过）。抛错即执行失败。 */
  produce: (schedule: Schedule, slot: string, now: Date) => Promise<string | undefined>
  warn?: (message: string) => void
}

export class ScheduleRunner {
  private readonly inflight = new Set<string>()
  private readonly now: () => Date
  constructor(private readonly options: ScheduleRunnerOptions) { this.now = options.now ?? (() => new Date()) }

  /** 检查一遍全部安排。`at` 只给测试用（拨时钟）；平时用当前时间。返回时本次启动的执行都已结束。 */
  async tick(at?: Date): Promise<void> {
    const { store, outbox, timeZone } = this.options
    const now = at ?? this.now()
    store.prune(now)
    const jobs: Promise<void>[] = []
    for (const s of store.list()) {
      if (!s.enabled) continue
      let due: ReturnType<typeof dueSlot>
      try { due = dueSlot(s, now, timeZone) } catch (error) {
        this.options.warn?.(`定时安排 ${s.id} 的时间无效：${(error as Error).message}`)
        continue
      }
      if (!due) continue
      const last = s.lastRun?.slot === due.key ? s.lastRun : undefined
      // 本时段失败过且还会重试：到了 retryAt 再试一次；其他已有结果的时段不再处理。
      const retrying = last?.status === 'failed' && !!last.retryAt
      if (last && !retrying) continue
      if (due.slot.getTime() <= Date.parse(s.since ?? s.createdAt)) continue
      const key = scheduleNoticeKey(s.id, due.key)
      if (outbox.has(key)) { store.recordRun(s.id, { slot: due.key, at: now.toISOString(), status: 'delivered' }); continue }
      const late = now.getTime() - due.slot.getTime() > scheduleGrace(s)
      if (late && retrying) {
        // 重试的时刻已超出宽限（例如宿主停了一阵）：不再试，把最后一次的失败原因告诉主人。
        this.fail(s, due.key, key, last.detail ?? '未知原因', last.attempts ?? 1, at ?? this.now())
        continue
      }
      if (late) {
        store.recordRun(s.id, { slot: due.key, at: now.toISOString(), status: 'missed', detail: `${formatLocal(due.slot, timeZone)} 时没有运行，超过了补投时限` })
        continue
      }
      if (retrying && now.getTime() < Date.parse(last.retryAt!)) continue
      if (this.inflight.has(key)) continue
      this.inflight.add(key)
      jobs.push(this.run(s, due, key, now, at, retrying ? (last.attempts ?? 1) + 1 : 1).finally(() => this.inflight.delete(key)))
    }
    await Promise.all(jobs)
  }

  private async run(s: Schedule, due: { slot: Date; key: string }, key: string, started: Date, injected: Date | undefined, attempt: number): Promise<void> {
    const { store } = this.options
    let body: string | undefined, failure: string | undefined
    try { body = await this.options.produce(s, due.key, started) } catch (error) {
      failure = clip(String((error as Error)?.message ?? error).replace(/\s+/g, ' ').trim() || '未知原因', 200)
    }
    const current = store.get(s.id)
    // 执行期间被停用或删掉：不再投递，也不写回。
    if (!current?.enabled) return
    const at = injected ?? this.now()
    if (failure !== undefined) {
      const retryAt = at.getTime() + RETRY_WAIT
      if (attempt < MAX_ATTEMPTS && retryAt - due.slot.getTime() <= scheduleGrace(current)) {
        store.recordRun(s.id, { slot: due.key, at: at.toISOString(), status: 'failed', detail: failure, attempts: attempt, retryAt: new Date(retryAt).toISOString() })
      } else this.fail(current, due.key, key, failure, attempt, at)
      return
    }
    if (body !== undefined) this.deliver(current, key, body, at)
    store.recordRun(s.id, { slot: due.key, at: at.toISOString(), status: 'delivered', ...body === undefined && { detail: '本时段已处理过，没有新的提醒' } })
  }

  /** 最后一次失败：在接口人对话里说明原因，本时段不再重试。 */
  private fail(s: Schedule, slot: string, key: string, detail: string, attempts: number, at: Date): void {
    this.deliver(s, key, `定时安排「${s.title}」这次没能完成${attempts > 1 ? `（已试 ${attempts} 次）` : ''}：${detail}。`, at)
    this.options.store.recordRun(s.id, { slot, at: at.toISOString(), status: 'failed', detail, attempts })
  }

  private deliver(s: Schedule, key: string, body: string, at: Date): void {
    let when = ''
    try { when = describeWhen(s) } catch { when = s.when ?? s.at ?? '' }
    const footer = `\n— 来自定时安排「${s.title}」· ${when}`
    this.options.outbox.enqueue(key, clip(body.trim(), NOTICE_LIMIT - footer.length) + footer, at, undefined,
      { schedule: { id: s.id, title: s.title, when }, maxLength: NOTICE_LIMIT })
  }
}

// ───────────── 内容生成 ─────────────

const STATUS_LABEL: Record<V2Delegation['status'], string> = { accepted: '已接手', active: '执行中', waiting: '等待', closed: '已关闭', done: '已完成' }
const orderState = (order: V2Delegation) => order.acceptance?.awaitingOwner ? '等你验收' : order.paused ? '已暂停' : STATUS_LABEL[order.status]

export interface OpenOrderGroup { workspace: string; orders: V2Delegation[] }

/** 各未归档工作区里未关闭的工单（不含已完成、已取消）。 */
export function openOrders(workspaces: Pick<WorkspaceV2Store, 'list' | 'view'>): OpenOrderGroup[] {
  return workspaces.list().filter(space => !workspaceArchived(space)).flatMap(space => {
    const orders = workspaces.view(space.id).orders.filter(order => !order.sessionDeletedAt && !orderEnded(order))
    return orders.length ? [{ workspace: space.name, orders }] : []
  })
}

/** 未关闭工单汇总：直接由数据生成，不经模型。 */
export function openOrdersText(groups: readonly OpenOrderGroup[]): string {
  const total = groups.reduce((sum, group) => sum + group.orders.length, 0)
  if (!total) return '各工作区目前没有未关闭的工单。'
  const lines = [`各工作区共有 ${total} 张未关闭的工单：`]
  for (const { workspace, orders } of groups) {
    lines.push(`「${workspace}」${orders.length} 张`)
    for (const order of orders.slice(0, 5)) lines.push(`· ${order.title}（${orderState(order)}）`)
    if (orders.length > 5) lines.push(`· 另有 ${orders.length - 5} 张`)
  }
  const waiting = groups.flatMap(group => group.orders.filter(order => order.acceptance?.awaitingOwner).map(order => `「${order.title}」等你验收`))
  if (waiting.length) lines.push(`需要你处理：${waiting.join('、')}。`)
  return lines.join('\n')
}

const BRIEF_PROMPT = `你是主人的接口人，正在写今天的早报，会直接出现在主人和你的对话里。
只依据用户消息里的 JSON 快照写，不编造快照里没有的工单、人或日程；快照里某部分为空就直接说没有。
中文，口语，600 字以内，不用表格和标题。先说今天最该处理的一两件事和原因，再说需要主人决定或验收的工单、仍在进行的工作、今天的日程。`
const REVIEW_PROMPT = `你是主人的接口人，正在写今天的晚报，会直接出现在主人和你的对话里。
只依据用户消息里的 JSON 快照写，不编造快照里没有的工单、人或日程；快照里某部分为空就直接说没有。
中文，口语，600 字以内，不用表格和标题。说清今天完成了什么、还卡在哪里（等主人的、暂停的）、明天第一件事建议做什么。`

export interface ScheduleContentDeps {
  timeZone: string
  workspaces: Pick<WorkspaceV2Store, 'list' | 'view'>
  learning?: { scheduled(slot: string): Promise<{ failed: number; changes: number } | undefined> }
  llm?: () => Llm | undefined
  model?: () => ModelSelection | undefined
  calendarWeek?: (day?: string) => Promise<CalendarWeek>
}

/** 到点要说的话：未关闭工单汇总和提醒是确定的文字；早报、晚报由接口人的模型依据快照撰写；经验整理调用每周整理。 */
export function scheduleProducer(deps: ScheduleContentDeps): ScheduleRunnerOptions['produce'] {
  async function snapshot(now: Date) {
    const today = slotKey(now, deps.timeZone).slice(0, 10)
    const groups = openOrders(deps.workspaces)
    const doneToday = deps.workspaces.list().filter(space => !workspaceArchived(space)).flatMap(space =>
      deps.workspaces.view(space.id).orders.filter(order => order.status === 'done' && order.completedAt && slotKey(new Date(order.completedAt), deps.timeZone).startsWith(today))
        .map(order => ({ workspace: space.name, title: order.title })))
    let agenda: { start: string; title: string }[] = [], agendaIssue: string | undefined
    if (deps.calendarWeek) {
      try {
        const week = await deps.calendarWeek(today)
        agenda = week.entries.filter(entry => entry.start.slice(0, 10) === today).slice(0, 20).map(entry => ({ start: entry.start, title: entry.title }))
        if (week.issues.length) agendaIssue = '部分日历来源没能读取：' + week.issues.map(issue => issue.message).join('；')
      } catch { agendaIssue = '日历没能读取' }
    }
    return {
      today, now: slotKey(now, deps.timeZone).replace('T', ' '),
      openOrders: groups.flatMap(group => group.orders.map(order => ({ workspace: group.workspace, title: order.title, state: orderState(order) }))).slice(0, 60),
      waitingForOwner: groups.flatMap(group => group.orders.filter(order => order.acceptance?.awaitingOwner).map(order => ({ workspace: group.workspace, title: order.title }))),
      completedToday: doneToday.slice(0, 30),
      agenda, ...agendaIssue && { agendaIssue },
    }
  }
  async function write(system: string, input: unknown): Promise<string> {
    const llm = deps.llm?.(), model = deps.model?.()
    if (!llm?.stream || !model) throw new Error('接口人的模型暂不可用')
    const signal = AbortSignal.timeout(MODEL_TIMEOUT)
    let text = ''
    for await (const chunk of llm.stream({ ...model, system, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] }], signal })) {
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) throw new Error(chunk.reason.failure?.message || '模型没有写完')
      if (text.length > 6000) break
    }
    if (!text.trim()) throw new Error('模型没有给出内容')
    return text.trim()
  }
  return async (s, slot, now) => {
    switch (s.content) {
      case 'open-orders': return openOrdersText(openOrders(deps.workspaces))
      case 'reminder': return `${s.by === 'liaison' ? '接口人跟进' : '提醒'}：${s.text ?? s.title}`
      case 'brief': case 'review': {
        const data = await snapshot(now)
        return await write(s.content === 'brief' ? BRIEF_PROMPT : REVIEW_PROMPT, { ...data, ...s.text && { ownerRequest: s.text } })
      }
      case 'dream': {
        if (!deps.learning) throw new Error('经验整理暂不可用')
        const result = await deps.learning.scheduled(slot)
        if (!result) return undefined
        if (result.failed) throw new Error(`有 ${result.failed} 项经验没能整理，可在工作区「经验」里点「现在整理」重试`)
        return result.changes ? '本周经验整理已完成，新整理的候选在各工作区「经验」里等你核对。' : '本周经验整理已完成，这周没有需要更新的经验。'
      }
    }
  }
}

// ───────────── HTTP ─────────────

export interface ScheduleRouteOptions {
  scope: string
  timeZone: string
  store: ScheduleStore
  push: () => boolean
  now?: () => Date
  /**
   * 验收专用（宿主以 CHIEF_ACCEPTANCE_SCHEDULE_CLOCK=1 启动时才有）：`POST /v2/schedules/debug/tick {now}` 把时钟拨到 now
   * 检查一遍并推送。正常运行时这个路径不存在。
   */
  debugTick?: (now: Date) => Promise<void>
}

export function scheduleRoutes({ scope, timeZone, store, push, now = () => new Date(), debugTick }: ScheduleRouteOptions): Route {
  return async ({ method, seg, url, body, owner }, res) => {
    if (seg[0] !== 'v2' || seg[1] !== 'schedules') return false
    if (owner !== true) return workspaceError(403, '需要主人权限才能查看或修改定时安排。')
    if (url.searchParams.get('scope') !== scope || body.scope !== undefined && body.scope !== scope) return workspaceError(409, '第二大脑已切换，请重新打开。')
    if (method === 'GET' && seg.length === 2) {
      const at = now()
      json(res, 200, { scope, timeZone, push: push(), schedules: store.list().map(row => scheduleRow(row, at, timeZone)) })
      return true
    }
    if (debugTick && method === 'POST' && seg.length === 4 && seg[2] === 'debug' && seg[3] === 'tick') {
      const at = new Date(String(body.now ?? ''))
      if (Number.isNaN(at.getTime())) return workspaceError(400, 'now 需要 ISO 时间')
      await debugTick(at)
      json(res, 200, { scope, ok: true })
      return true
    }
    if (method !== 'POST' || seg.length !== 3 || !seg[2]) return false
    const id = seg[2]
    const action = body.action
    if (action === 'enable' || action === 'disable') {
      const schedule = store.setEnabled(id, action === 'enable')
      json(res, 200, { scope, ok: true, schedule: scheduleRow(schedule, now(), timeZone) })
      return true
    }
    if (action === 'remove') {
      store.remove(id)
      json(res, 200, { scope, ok: true })
      return true
    }
    return workspaceError(400, 'action 取 enable、disable 或 remove')
  }
}
