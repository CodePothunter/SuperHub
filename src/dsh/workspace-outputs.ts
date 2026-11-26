import { createHash } from 'node:crypto'
import { messageWorkOrder, type V2AttachmentRef, type V2Message, type V2Session, type V2Transcript, type WorkOrderOutput, type WorkspaceOutput } from '../core/workspace-v2.ts'

/** The order an agent line delivered for; the owner's words and lines outside an order deliver nothing. */
function deliveredFor(session: V2Session, message: V2Message) {
  return message.role === 'agent' ? messageWorkOrder(session, message) : undefined
}

function location(session: V2Session, transcript: V2Transcript, message: V2Message, attachment: V2AttachmentRef, orderId: string): WorkOrderOutput {
  const traceId = message.traceId ?? transcript.traceId
  return {
    sessionId: session.id, messageId: message.id, attachment,
    ...(traceId && {traceId}),
    ...((traceId || attachment.version) && {orderId, at:message.at}),
    ...(session.deletedAt && {sessionDeletedAt:session.deletedAt}),
  }
}

function deliveryKey(file: string, row: WorkOrderOutput) {
  return JSON.stringify([file, row.traceId && row.sessionId, row.traceId, row.attachment.version, row.orderId])
}

/**
 * Repeat links to the same version on one trace use the latest reference.
 * Snapshots can include inherited rows, which retain their original trace identity.
 */
export function publishedOutputs(session: V2Session, transcript: V2Transcript | readonly V2Transcript[], orderId: string,
  fileOf?: (attachmentId: string, traceId?: string) => string | undefined): WorkOrderOutput[] {
  const traces = 'messages' in transcript ? [transcript] : transcript
  const rows = traces.flatMap(trace => trace.messages.flatMap(message =>
    deliveredFor(session, message) === orderId
      ? (message.attachments ?? []).map(attachment => location(session, trace, message, attachment, orderId))
      : []))
  if (!fileOf && !rows.some(row => row.traceId)) return rows
  const latest = new Map<string, WorkOrderOutput>()
  for (const row of rows) {
    const key = deliveryKey(fileOf?.(row.attachment.id, row.traceId) ?? row.attachment.id, row)
    if (time(row.at) >= time(latest.get(key)?.at)) {
      latest.delete(key)
      latest.set(key, row)
    }
  }
  return [...latest.values()].sort((a, b) => time(a.at) - time(b.at))
}

/** One readable conversation of a workspace with the orders it is responsible for. */
export interface OutputSource {
  session: V2Session
  transcript: V2Transcript
  orders: WorkspaceOutput['orders']
  /** The file behind an attachment (group chats link files by path); absent: every attachment is its own output. */
  fileOf?: (attachmentId: string) => string | undefined
}

const time = (at?: string) => at ? Date.parse(at) || 0 : 0

/**
 * A workspace's delivered files: every order's 「交付成果」 together (the same lines `publishedOutputs` takes), one
 * row per file (by path where the conversation knows it), at its latest delivery and tagged with each order that
 * delivered it. Newest first. The key is a digest of the path, so the answer never carries the path itself.
 */
export function workspaceOutputs(sources: OutputSource[]): WorkspaceOutput[] {
  type Delivery = NonNullable<WorkspaceOutput['versions']>[number]
  type Merged = WorkspaceOutput & { orderAt: Map<string, number>; speakers: Map<string, {name: string; at: number}>; deliveries: Map<string, Delivery> }
  const merged = new Map<string, Merged>()
  for (const {session, transcript, orders, fileOf} of sources) {
    const byOrder = new Map(orders.map(order => [order.id, order]))
    for (const message of transcript.messages) {
      const orderId = deliveredFor(session, message)
      const order = orderId === undefined ? undefined : byOrder.get(orderId)
      if (!order || orderId === undefined) continue
      const at = time(message.at)
      const speaker = message.speakerId ?? message.author
      for (const attachment of message.attachments ?? []) {
        const file = fileOf?.(attachment.id)
        const key = file ? createHash('sha256').update(file).digest('hex').slice(0, 24) : session.id + '/' + attachment.id
        const ref = location(session, transcript, message, attachment, orderId)
        let row = merged.get(key)
        // A later line takes over the reference: the latest link is the one that opens.
        if (!row || at >= time(row.at)) {
          row = {...ref, orders:row?.orders ?? [], deliveredBy:[], orderAt:row?.orderAt ?? new Map(),
            speakers:row?.speakers ?? new Map(), deliveries:row?.deliveries ?? new Map(), key, label:attachment.label, at:message.at}
          merged.set(key, row)
        }
        if (ref.traceId || attachment.version) {
          const id = deliveryKey(key, ref)
          if (at >= time(row.deliveries.get(id)?.at)) row.deliveries.set(id, {...ref, at:message.at, orderId})
        }
        row.orderAt.set(orderId, Math.max(at, row.orderAt.get(orderId) ?? -Infinity))
        if (!row.orders.some(tag => tag.id === orderId)) row.orders.push(order)
        const known = row.speakers.get(speaker)
        if (!known || at >= known.at) row.speakers.set(speaker, {name: message.author, at})
      }
    }
  }
  return [...merged.values()].sort((a, b) => time(b.at) - time(a.at)).map(({orderAt, speakers, orders, deliveries, deliveredBy: _, ...row}) => ({
    ...row,
    orders: [...orders].sort((a, b) => orderAt.get(b.id)! - orderAt.get(a.id)!),
    deliveredBy: [...speakers].sort(([, a], [, b]) => b.at - a.at).map(([id, {name}]) => ({id, name})),
    ...(deliveries.size > 1 && {versions:[...deliveries.values()].sort((a, b) => time(b.at) - time(a.at))}),
  }))
}
