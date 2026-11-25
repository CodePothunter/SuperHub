import { randomUUID } from 'node:crypto'
import { latestSlot } from '../core/clock.ts'
import { selectableCalendarDate } from '../core/workspace-calendar.ts'
import type { CommitmentKind, CommitmentSource, FollowupView, OrderCommitment, WeeklyReport, WeeklySchedule } from '../core/workspace-followup.ts'
import { messageWorkOrder, orderEnded, type V2Delegation, type V2Message, type V2Session, type V2Transcript } from '../core/workspace-v2.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import { composeWeeklyReport, dueState, localWeek } from './workspace-followup-report.ts'
import { mutationKey, type Mutation, type WorkspaceV2Store } from './workspace-v2-store.ts'

export interface StoredCommitment extends Omit<OrderCommitment, 'resolved' | 'dueState'> {
  recordedAt: string
  resolvedAt?: string
}
interface StoredSchedule extends WeeklySchedule { revision: string; enabledAt: string }
export interface OrderFollowupState {
  commitments: StoredCommitment[]
  schedule?: StoredSchedule
  reports: WeeklyReport[]
}
/** Supplied only by the host after verifying the current human liaison turn. */
export interface FollowupOwnerEvidence { sessionId: string; messageId: string; text: string; at?: string }
type Body = Record<string, unknown>
type Read = (session: V2Session) => Promise<V2Transcript>

function requireText(value: unknown, label: string, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) return workspaceError(400, '请填写有效的' + label)
  return value.trim()
}
function isBody(value: unknown): value is Body {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function deadline(value: unknown): string | undefined {
  if (value === undefined || value === '') return
  if (selectableCalendarDate(value)) return value
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:[0-5]\d)$/.test(value) ||
    !selectableCalendarDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) {
    return workspaceError(400, '到期日需要有效的当地日期，指定时刻请带时区')
  }
  return new Date(value).toISOString()
}
function checkOrder(order: V2Delegation, disable = false) {
  if (!disable && (order.paused || orderEnded(order))) return workspaceError(409, order.status === 'done' ? '这张工单已完成，现有约定和周报仍可查看' : '这张工单已暂停或关闭，现有约定和周报仍可查看')
}

function present(row: StoredCommitment, now: Date, timeZone: string): OrderCommitment {
  const {recordedAt, resolvedAt, ...facts} = row
  return {...facts, resolved: !!resolvedAt, dueState: dueState(row, now, timeZone)}
}

function weeklySchedule(body: Body, previous: StoredSchedule | undefined, now: Date): StoredSchedule | undefined {
  if (body.enabled === false) return previous && { ...previous, enabled: false, revision: randomUUID() }
  const { weekday, time } = body
  if (body.enabled !== undefined && body.enabled !== true || typeof weekday !== 'number' || !Number.isInteger(weekday) ||
    weekday < 0 || weekday > 6 || typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return workspaceError(400, '请选择每周的星期和有效的当地时间 HH:mm')
  }
  if (previous?.enabled && previous.weekday === weekday && previous.time === time) return previous
  return { enabled: true, weekday, time, enabledAt: now.toISOString(), revision: randomUUID() }
}

function scopedRecord(raw: Body, messages: Map<string, V2Message>, session: V2Session, owner: FollowupOwnerEvidence | undefined,
  recordedAt: string): StoredCommitment {
  const kind = raw.kind as CommitmentKind
  if (kind !== 'mine' && kind !== 'theirs' && kind !== 'request') return workspaceError(400, '请选择我方承诺、对方承诺或待回应请求')
  const quote = requireText(raw.quote, '原话片段', 4000)
  const person = raw.person === undefined || raw.person === '' ? undefined : requireText(raw.person, '人物称呼', 160)
  const dueAt = deadline(raw.dueAt)
  let source: CommitmentSource
  let original: string
  if (raw.messageId === undefined && owner) {
    if (!owner.sessionId || !owner.messageId || owner.at && !Number.isFinite(Date.parse(owner.at))) return workspaceError(409, '请重新打开本轮接口人对话')
    source = { kind: 'liaison', sessionId: owner.sessionId, messageId: owner.messageId, author: '我', at: owner.at ?? recordedAt }
    original = owner.text
  } else {
    const message = messages.get(requireText(raw.messageId, '会话发言标识', 512))
    if (!message) return workspaceError(404, '这张工单的负责会话中没有这条原话')
    if (!Number.isFinite(Date.parse(message.at))) return workspaceError(409, '原话缺少可核对的时间')
    source = { kind: 'session', sessionId: session.id, messageId: message.id, author: message.author, at: message.at }
    original = message.text
  }
  if (!original.includes(quote)) return workspaceError(409, '引文与该条发言不符，请从原话中选择')
  if (person && !original.includes(person)) return workspaceError(409, '请沿用这条原话里的人物称呼，也可以留空')
  const id = workspaceFingerprint([source.kind, source.sessionId, source.messageId, quote])
  return { id, kind, quote, ...(person && {person}), ...(dueAt && {dueAt}), source, recordedAt }
}

export class WorkspaceFollowup {
  private readonly runs = new Map<string, Promise<void>>()

  constructor(private readonly store: WorkspaceV2Store, private readonly read: Read, private readonly current: () => void,
    private readonly timeZone: string, private readonly now: () => Date = () => new Date(), private readonly allowedSources?: (order:V2Delegation)=>Set<string>) {}

  view(workspaceId: string, orderId: string, reportId?: string): FollowupView {
    this.current()
    const state = this.store.followupState(workspaceId, orderId)
    const at = this.now()
    const schedule = state.schedule
    return { scope: this.store.scope, workspaceId, orderId, timeZone: this.timeZone, currentWeek: localWeek(at, this.timeZone),
      commitments: state.commitments.map(row => present(row, at, this.timeZone)),
      schedule: schedule ? { enabled: schedule.enabled, weekday: schedule.weekday, time: schedule.time } : null,
      reports: [...state.reports].sort((a, b) => b.week.localeCompare(a.week)), ...(reportId && {reportId}) }
  }

  workspaceView(workspaceId: string, offset = 0, sessionId?: string) {
    this.current()
    if (!Number.isSafeInteger(offset) || offset < 0) return workspaceError(400, '请选择有效的约定列表位置')
    const at = this.now()
    const open = this.store.followupsIn(workspaceId, sessionId).flatMap(({order, commitments}) =>
      commitments.filter(row => !row.resolvedAt).map(row => ({ orderId: order.id, orderTitle: order.title,
        orderStatus: order.status, paused: !!order.paused, sessionId: order.sessionId, commitment: present(row, at, this.timeZone) })))
    const end = offset + 20
    return {scope: this.store.scope, workspaceId, timeZone: this.timeZone, items: open.slice(offset, end),
      total: open.length, ...(end < open.length && {nextOffset: end})}
  }

  async sources(workspaceId: string, orderId: string): Promise<V2Message[]> {
    this.current()
    const order = this.store.delegation(workspaceId, orderId)
    const session = this.store.session(workspaceId, order.sessionId)
    const transcript = await this.read(session)
    this.current()
    if (transcript.complete === false || transcript.issue && transcript.complete !== true) {
      return workspaceError(503, '工单会话暂时无法完整读取，请稍后重试。' + (transcript.issue ?? ''))
    }
    return transcript.messages.filter(message => messageWorkOrder(session, message) === order.id)
  }

  async apply(workspaceId: string, orderId: string, body: Body, owner?: FollowupOwnerEvidence): Promise<FollowupView> {
    this.current()
    const path = ['v2', 'workspaces', workspaceId, 'orders', orderId, 'followup']
    if (owner) path.push('liaison', owner.sessionId, owner.messageId)
    const mutation = mutationKey(path, body)
    const past = this.store.receipt(mutation)
    if (past?.kind === 'followup') return this.view(workspaceId, orderId, past.reportId)
    const order = this.store.delegation(workspaceId, orderId)
    if (body.expectedGeneration !== undefined && body.expectedGeneration !== order.generation) {
      return workspaceError(409, '工单指示已变更，请重新打开工单')
    }
    const disable = body.action === 'schedule' && body.enabled === false
    checkOrder(order, disable)
    const at = this.now()
    if (body.action === 'draft') {
      const reportId = await this.draft(order, mutation, at)
      return this.view(workspaceId, orderId, reportId)
    }

    let records: StoredCommitment[] = []
    if (body.action === 'record') {
      const entries = body.entries === undefined ? [body] : body.entries
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 30 || !entries.every(isBody)) {
        return workspaceError(400, '请一次提供一到三十项有出处的约定')
      }
      const session = this.store.session(workspaceId, order.sessionId)
      const messages = entries.some(entry => entry.messageId !== undefined || !owner)
        ? await this.sources(workspaceId, orderId) : []
      const byId = new Map(messages.map(message => [message.id, message]))
      records = entries.map(entry => scopedRecord(entry, byId, session, owner, at.toISOString()))
    }
    this.current()
    this.store.saveFollowup(workspaceId, orderId, order.generation, mutation, (state, currentOrder) => {
      checkOrder(currentOrder, disable)
      switch (body.action) {
        case 'record':
          for (const row of records) {
            const existing = state.commitments.find(saved => saved.id === row.id)
            if (!existing) state.commitments.push(row)
            else if (existing.kind !== row.kind || existing.person !== row.person || existing.dueAt !== row.dueAt) {
              return workspaceError(409, '这段原话已经登记过，请核对已有约定')
            }
          }
          break
        case 'resolve': {
          const id = requireText(body.id, '约定标识', 160)
          const row = state.commitments.find(saved => saved.id === id)
          if (!row) return workspaceError(404, '这张工单里没有这条约定')
          row.resolvedAt ??= at.toISOString()
          break
        }
        case 'schedule':
          state.schedule = weeklySchedule(body, state.schedule, at)
          break
        default:
          return workspaceError(400, '找不到这项工单跟进操作')
      }
      return undefined
    })
    return this.view(workspaceId, orderId)
  }

  private async draft(order: V2Delegation, mutation: Mutation, asOf: Date, scheduleRevision?: string) {
    const week = localWeek(asOf, this.timeZone)
    const previous = this.store.followupState(order.workspaceId, order.id).reports.find(row => row.week === week)
    const messages = previous ? [] : await this.sources(order.workspaceId, order.id)
    this.current()
    return this.store.saveFollowup(order.workspaceId, order.id, order.generation, mutation, (state, currentOrder) => {
      checkOrder(currentOrder)
      if (scheduleRevision && (!state.schedule?.enabled || state.schedule.revision !== scheduleRevision)) {
        return workspaceError(409, '周报交付时间已变更，将按新的安排处理')
      }
      const existing = state.reports.find(report => report.week === week)
      if (existing) return existing.id
      const allowed = currentOrder.staffId ? this.allowedSources?.(currentOrder) ?? new Set<string>() : undefined
      const currentMessages = allowed ? messages.filter(m=>allowed.has(m.id)) : messages
      const commitments = allowed ? state.commitments.filter(c=>c.source.kind==='liaison' || allowed.has(c.source.messageId)) : state.commitments
      const report = composeWeeklyReport(currentOrder, currentMessages, commitments, asOf, this.now(), this.timeZone, randomUUID())
      state.reports.push(report)
      return report.id
    }, !!scheduleRevision)
  }

  /** Independent responsibilities recheck their current generation and schedule at publication. */
  async tick() {
    this.current()
    const now = this.now()
    const jobs: Promise<void>[] = []
    for (const order of this.store.scheduledFollowups()) {
      const state = this.store.followupState(order.workspaceId, order.id)
      const plan = state.schedule!
      const [hour, minute] = plan.time.split(':').map(Number)
      const slot = latestSlot({ kind: 'daily', days: [plan.weekday], minute: hour! * 60 + minute! }, now, this.timeZone)
      if (!slot || slot.getTime() < Math.floor(Date.parse(plan.enabledAt) / 60_000) * 60_000) continue
      const week = localWeek(slot, this.timeZone)
      if (state.reports.some(report => report.week === week)) continue
      const key = workspaceFingerprint(['weekly', order.workspaceId, order.id, week, plan.revision, order.generation])
      let run = this.runs.get(key)
      if (!run) {
        const mutation = mutationKey(['weekly', order.workspaceId, order.id, week], {requestId: 'weekly-' + key})
        run = this.draft(order, mutation, slot, plan.revision).then(() => {}).finally(() => this.runs.delete(key))
        this.runs.set(key, run)
      }
      jobs.push(run)
    }
    const outcomes = await Promise.allSettled(jobs)
    const failed = outcomes.find(item => item.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}
