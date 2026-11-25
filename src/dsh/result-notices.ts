/** Result receipts are persisted work facts, not a second model-generated conversation. */
import type { Assignment, Ticket } from '../core/model.ts'
import { latestAssignment } from '../core/stage.ts'
import { archivedOutput, currentOutputEvidence } from './deliveries.ts'
import type { Notice, Outbox } from './outbox.ts'

export type NoticeDelivery = NonNullable<Notice['delivery']>

const inTicket = (ticket: Ticket, path: string) => path.startsWith(`work/${ticket.id}/`)
  && !path.includes('\\') && path.split('/').every(part => part && part !== '.' && part !== '..')
const compact = (value: string, max: number) => {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** Prefer an actual readable document; a reported filename alone is not a preview. */
export function resultDelivery(root: string, ticket: Ticket, assignment = latestAssignment(ticket)): NoticeDelivery | undefined {
  if (assignment?.report?.status !== 'ready') return
  const deliveries = [...(assignment.deliveries ?? [])].sort((a, b) => Number(/\.md$/i.test(b.path)) - Number(/\.md$/i.test(a.path)))
  for (const delivery of deliveries) {
    if (!inTicket(ticket, delivery.path)) continue
    const content = currentOutputEvidence(root, ticket.id, delivery)
    if (content === undefined) continue
    const heading = /^#{1,2}\s+(.+)$/m.exec(content)?.[1]
    const title = compact(heading ?? delivery.path.split('/').at(-1)!, 80)
    return { ...delivery, title }
  }
}

/** Reopen the immutable version from the original assignment, even after rework. */
export function noticeDelivery(root: string, ticket: Ticket, notice: Notice): NoticeDelivery | undefined {
  if (!notice.delivery || !inTicket(ticket, notice.delivery.path)) return
  const assignment = ticket.assignments.find(row => row.id === notice.assignmentId)
  if (!assignment?.deliveries?.some(row => row.path === notice.delivery!.path && row.version === notice.delivery!.version)) return
  if (archivedOutput(root, ticket.id, notice.delivery.version) === undefined) return
  return notice.delivery
}

export function resultNoticeKey(ticket: Ticket, assignment: Assignment): string { return `result:${ticket.id}:${assignment.id}` }

/** No-review completion is otherwise absent from the owner's decision queue. Never push this new category externally. */
export function enqueueResultNotice(outbox: Outbox, root: string, scope: string, ticket: Ticket, now = new Date()): boolean {
  if (ticket.superhub && ticket.superhub.brainScope !== scope) return false
  const last = latestAssignment(ticket)
  if (ticket.ended?.outcome !== 'done' || last?.report?.status !== 'ready') return false
  // If an owner already received this delivery for acceptance, keep that original receipt.
  if (outbox.has(`need:${ticket.id}:you/review:${ticket.assignments.length}`)) return false
  const key = resultNoticeKey(ticket, last)
  if (outbox.has(key)) return false
  const delivery = resultDelivery(root, ticket, last)
  const summary = compact(last.report.summary, 140)
  const text = `${compact(ticket.title, 70)}已办结。${summary}`
  const finished = new Date(ticket.ended.at)
  return outbox.enqueue(key, text, Number.isFinite(finished.valueOf()) ? finished : now, ticket.id,
    { kind: 'result', assignmentId: last.id, ...delivery ? { delivery } : {}, localOnly: true })
}
