/**
 * 群聊迁移的第二部分（任务 11-24 D5）：退役原生工单（看板 `retiredOrders` 里的 T-xxxx）连同关联数据一起删。
 *
 * 原生工单的持久化（`src/core/store.ts` 的 FileStore 与各子系统）：
 * - `ops/tickets/T-xxxx.json` 工单本身；`ops/ticket-sequence.json` 编号（只升不降，删后不复用编号）；
 * - `ops/events/<月>.jsonl` 交办原话等事件、`ops/dispositions.jsonl` 事件处理结果（只追加的日志）；
 * - `ops/outbox.json` 里 `ticketId` / `assignmentId` / `need:` `result:` `approval:` `stuck:` 提醒；
 * - `ops/room-index.json`、`ops/rooms/*.json` 讨论室里挂的工单与主人待办；`ops/worklines/*.json`、`ops/superhub-saa.json`；
 * - `ops/discussions/*.json` 交付讨论的后续工单；`ops/remote/<阶段>/*.json` 工作电脑队列；
 * - `ops/delivery-versions/T-xxxx/`、`work/T-xxxx/` 交付；DSH 里工作目录为 `work/T-xxxx` 的工单桌（`chief-desk-*`）与其子会话。
 *
 * 事件日志的处理沿用 `legacy-order-cleanup.ts`：事件行不删，正文清空、只留标识（id/时间/来源/去重键），并补一条
 * 「已忽略」的处理结果，这样同一原话不会被当成新的交办再次收进来；其余引用直接去掉。这里只有纯函数：输入原文、输出新原文，
 * 对已处理过的原文再处理一次结果不变（迁移可重跑）。
 */
import type { Notice } from './outbox.ts'

export const TICKET_ID = /^T-\d+$/
interface TicketLike {
  id: string; title?: string; staff?: string; createdAt?: string; ended?: unknown; mandate?: {eventId?: string}; events?: string[]
  assignments?: {id: string; state?: string; attempts?: {status?: string}[]}[]; superhub?: {brainScope?: string}
}
interface EventLike { id?: string; at?: string; source?: string; dedupe?: string; ticketId?: string; meta?: Record<string, unknown> }
interface DispositionRow { eventId: string; disposition: {kind?: string; ticketId?: string} }

/** What a ticket edit needs: the tickets, their assignments, their events (event id → ticket) and room sources. */
export interface TicketContext {
  tickets: ReadonlySet<string>
  assignments: ReadonlySet<string>
  events: ReadonlyMap<string, string>
  roomSources: ReadonlyMap<string, ReadonlySet<string>>
}

export function parseTicket(raw: string, name: string): TicketLike | undefined {
  try {
    const ticket = JSON.parse(raw) as TicketLike
    if (!ticket || ticket.id + '.json' !== name || !ticket.mandate?.eventId || !Array.isArray(ticket.events) || !Array.isArray(ticket.assignments)) return
    return ticket
  } catch { return }
}

/** A running assignment of an open ticket is work in flight. */
export const ticketRunning = (ticket: TicketLike) => !ticket.ended && (ticket.assignments ?? [])
  .some(row => row.state === 'running' || row.attempts?.some(attempt => attempt.status === 'running'))

const lines = (raw: string) => raw.split('\n').flatMap(line => {
  if (!line.trim()) return []
  try { return [JSON.parse(line) as unknown] } catch { return [] }
})

/**
 * The events the tickets own (as `legacy-order-cleanup` decides): their source and attached events, events naming them,
 * and events a disposition attached to them, except events another kept ticket also owns. Also the room sources those
 * events came from (their room's owner actions are answered).
 */
export function ticketEvents(selected: TicketLike[], retained: TicketLike[], eventFiles: string[], dispositions: string | undefined) {
  const tickets = new Set(selected.map(row => row.id))
  const kept = new Set(retained.flatMap(row => [row.mandate?.eventId ?? '', ...row.events ?? []]))
  const events = new Map(selected.flatMap(row => [row.mandate?.eventId ?? '', ...row.events ?? []].filter(Boolean).map(id => [id, row.id] as const)))
  for (const row of lines(dispositions ?? '') as DispositionRow[]) {
    const kind = row?.disposition?.kind
    if (kind !== 'attached' && kind !== 'accepted') continue
    if (!tickets.has(row.disposition.ticketId ?? '')) kept.add(row.eventId)
    else events.set(row.eventId, row.disposition.ticketId!)
  }
  for (const id of kept) events.delete(id)
  const roomSources = new Map<string, Set<string>>()
  for (const raw of eventFiles) {
    for (const event of lines(raw) as EventLike[]) {
      const id = event?.id
      if (!id || kept.has(id)) continue
      const origin = events.get(id) ?? (event.ticketId && tickets.has(event.ticketId) ? event.ticketId : undefined)
      if (!origin) continue
      events.set(id, origin)
      const room = event.meta?.room_id, source = event.meta?.room_source
      if (typeof room === 'string' && typeof source === 'string') roomSources.set(room, new Set([...roomSources.get(room) ?? [], source]))
    }
  }
  return {events, roomSources}
}

/** Malformed lines are kept byte for byte, as FileStore keeps them when opening the log. */
function editLines<T>(raw: string, update: (row: T) => T | undefined) {
  return raw.split('\n').flatMap(line => {
    if (!line.trim()) return [line]
    let value: T
    try { value = JSON.parse(line) as T } catch { return [line] }
    const result = update(value)
    return result === undefined ? [] : [result === value ? line : JSON.stringify(result)]
  }).join('\n')
}
const document = (raw: string, update: (value: any) => unknown) => {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return raw }
  const before = JSON.stringify(value)
  const next = update(value)
  return JSON.stringify(next) === before ? raw : JSON.stringify(next) + '\n'
}

/** A protected event keeps only its identity: it is never ingested or recovered again. */
const protectedEvent = (event: EventLike, origin: string) => ({id: event.id, at: event.at, source: event.source, dedupe: event.dedupe, text: '', meta: {retired_ticket: origin}})

function detachRoom(room: {id?: string; tickets?: string[]; ownerActions?: {kind?: string; ticketId?: string; source?: string; answered?: boolean}[]}, context: TicketContext) {
  if (!room || typeof room !== 'object') return room
  if (room.tickets) room.tickets = room.tickets.filter(id => !context.tickets.has(id))
  for (const action of room.ownerActions ?? []) {
    const removed = !!action.ticketId && context.tickets.has(action.ticketId)
    if (removed) delete action.ticketId
    if (action.kind === 'execute' && (removed || action.source && context.roomSources.get(room.id ?? '')?.has(action.source))) action.answered = true
  }
  return room
}

/** Brain files (relative, `/`-separated) that may hold references to native tickets. */
export const TICKET_REFERENCE = [
  /^ops\/events\/[A-Za-z0-9_.-]+\.jsonl$/, /^ops\/dispositions\.jsonl$/, /^ops\/room-index\.json$/, /^ops\/rooms\/[a-zA-Z0-9_-]{1,120}\.json$/,
  /^ops\/worklines\/[A-Za-z0-9_.-]+\.json$/, /^ops\/superhub-saa\.json$/, /^ops\/discussions\/[A-Za-z0-9_.-]+\.json$/, /^ops\/ticket-sequence\.json$/,
]
export const isTicketReference = (path: string) => TICKET_REFERENCE.some(pattern => pattern.test(path))

/** The new text of one reference file without the tickets (the same text when nothing refers to them). */
export function editTicketReference(path: string, raw: string, context: TicketContext): string {
  const {tickets, events} = context
  if (path.startsWith('ops/events/')) {
    return editLines<EventLike>(raw, event => {
      const origin = event?.id ? events.get(event.id) : undefined
      return origin ? protectedEvent(event, origin) : event
    })
  }
  if (path === 'ops/dispositions.jsonl') {
    const rows = raw.split('\n').filter(line => {
      try {
        const row = JSON.parse(line) as DispositionRow
        if (events.has(row.eventId)) return false
        if ((row.disposition.kind === 'accepted' || row.disposition.kind === 'attached') && tickets.has(row.disposition.ticketId ?? '')) return false
      } catch { /* malformed tails and unrelated rows stay */ }
      return true
    }).join('\n')
    if (!events.size) return rows
    const terminal = [...events.keys()].sort().map(eventId => JSON.stringify({eventId, disposition: {kind: 'ignored', reason: '原工单已清理'}}) + '\n').join('')
    return rows + (rows && !rows.endsWith('\n') ? '\n' : '') + terminal
  }
  if (path === 'ops/room-index.json') return document(raw, rows => Array.isArray(rows) ? rows.map(room => detachRoom(room, context)) : rows)
  if (path.startsWith('ops/rooms/')) return document(raw, room => detachRoom(room, context))
  if (path.startsWith('ops/worklines/')) {
    return document(raw, row => row && typeof row === 'object' ? {...row, ...Array.isArray(row.tickets) && {tickets: row.tickets.filter((id: string) => !tickets.has(id))},
      ...Array.isArray(row.deliveries) && {deliveries: row.deliveries.filter((file: {ticketId?: string}) => !tickets.has(file?.ticketId ?? ''))}} : row)
  }
  if (path === 'ops/superhub-saa.json') {
    return document(raw, value => {
      for (const record of Array.isArray(value?.records) ? value.records : []) {
        if (Array.isArray(record.tickets)) record.tickets = record.tickets.filter((id: string) => !tickets.has(id))
        if (Array.isArray(record.references)) record.references = record.references.filter((ref: {ticketId?: string}) => !tickets.has(ref?.ticketId ?? ''))
      }
      return value
    })
  }
  if (path.startsWith('ops/discussions/')) {
    return document(raw, row => {
      if (row?.followUp && tickets.has(row.followUp)) delete row.followUp
      return row
    })
  }
  if (path === 'ops/ticket-sequence.json') {
    // Numbers of deleted tickets are never given out again.
    const current = raw.trim()
    if (!/^(0|[1-9]\d*)$/.test(current)) return raw
    const highest = Math.max(Number(current), ...[...tickets].map(id => Number(id.slice(2))))
    return highest > Number(current) ? String(highest) + '\n' : raw
  }
  return raw
}

/** A ticket's remote work still in the queue (not settled) blocks; settled task files go with the ticket. */
export const REMOTE_SETTLED = ['done', 'rejected', 'receipts', 'claims', 'cancelled']
export const REMOTE_OPEN = ['staged', 'outbox', 'taken', 'inbox']
export function remoteTicket(stage: string, name: string, raw: string, context: Pick<TicketContext, 'tickets' | 'assignments'>, assignmentTicket: ReadonlyMap<string, string>) {
  let row: {ticketId?: string} | undefined
  try { row = JSON.parse(raw) as typeof row } catch { return }
  const id = row?.ticketId ?? (stage === 'cancelled' ? assignmentTicket.get(name.replace(/\.json$/, '')) : undefined)
  return id && context.tickets.has(id) ? id : undefined
}

/** Reminders about the tickets (by ticket, assignment, `need:`/`result:`/`approval:` key, or a stuck event). */
export function ticketReminder(row: Notice, context: Pick<TicketContext, 'tickets' | 'assignments' | 'events'>) {
  const {tickets, assignments, events} = context
  if (tickets.has(row.ticketId ?? '') || assignments.has(row.assignmentId ?? '')) return true
  if (/^(need|result|approval):/.test(row.key) && tickets.has(row.key.split(':')[1] ?? '')) return true
  return row.key.startsWith('stuck:') && events.has(row.key.slice('stuck:'.length))
}
