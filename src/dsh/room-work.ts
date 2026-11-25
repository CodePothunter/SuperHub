import type { RoomMeta } from './rooms.ts'
import { stageLabel, type ThreadMessage, type ticketThread } from './view.ts'

export type WorkThread = NonNullable<ReturnType<typeof ticketThread>>
export interface RoomWork {
  links(): ReadonlyMap<string, readonly string[]>
  thread(id: string): WorkThread | undefined
  executionTicket?(roomId: string, source: string): string | undefined
}

const excerpt = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit)}…`

/**
 * Prefer the latest actual report and independent review even when a newer
 * assignment is queued or hasn't reported. Each record retains its own source.
 */
export function workBrief(thread: WorkThread) {
  const recent = (role: ThreadMessage['role'], filter: (m: ThreadMessage) => boolean = () => true) =>
    thread.messages.findLast(m => m.role === role && filter(m))
  const records = [
    recent('staff'), recent('verifier'),
    recent('owner', m => m.id.startsWith('input:')),
  ].flatMap(m => {
    if (!m) return []
    const execution = thread.executions.find(e => e.assignment_id === m.assignment_id)
    return [{
      source: m.id, role: m.role, at: m.at,
      ...m.status ? { status: m.status } : {},
      ...m.staff_id ? { staff: m.staff_id } : {},
      ...m.assignment_id ? { assignment: m.assignment_id } : {},
      ...m.role === 'staff' && execution ? { executionLocation: execution.executor === 'remote' ? '工作电脑' : 'DSH 宿主本机' } : {},
      text: excerpt(m.text, m.role === 'staff' ? 1600 : 620),
      ...m.question ? { question: excerpt(m.question, 350) } : {},
    }]
  })
  return {
    ticket: thread.ticket_id, title: excerpt(thread.title, 200), stage: stageLabel(thread.stage),
    currentAssignment: thread.reply_to, records,
  }
}

export function roomWorkBrief(tickets: readonly string[], work: RoomWork | undefined) {
  const entries = tickets.flatMap(id => {
    const thread = work?.thread(id)
    return thread ? [workBrief(thread)] : []
  }).sort((a, b) => (b.records[0]?.at ?? '').localeCompare(a.records[0]?.at ?? ''))
  const records: typeof entries = []
  let remaining = 12_000
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1
    if (size <= remaining) { records.push(entry); remaining -= size }
  }
  return { tickets, records }
}

export interface TicketReplyReceipt {
  id: string
  ticketId: string
  title: string
  at: string
  text: string
  roomId?: string
}

export function recentTicketReplies(tickets: readonly { id: string; title: string; inputs: readonly { key?: string; at: string; from: string; text: string }[] }[],
  rooms: readonly Pick<RoomMeta, 'id' | 'tickets'>[], limit = 30): TicketReplyReceipt[] {
  const roomByTicket = new Map<string, string>()
  for (const room of rooms) for (const id of room.tickets ?? []) if (!roomByTicket.has(id)) roomByTicket.set(id, room.id)
  return tickets.flatMap(ticket => ticket.inputs.flatMap((input, index) => input.from === 'owner' ? [{
    id: `${ticket.id}:input:${input.key ?? index}`, ticketId: ticket.id, title: ticket.title,
    at: input.at, text: input.text, roomId: roomByTicket.get(ticket.id),
  }] : [])).sort((a, b) => a.at.localeCompare(b.at)).slice(-limit)
}
