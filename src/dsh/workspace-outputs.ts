import { createHash } from 'node:crypto'
import { messageWorkOrder, type V2Message, type V2Session, type V2Transcript, type WorkOrderOutput, type WorkspaceOutput } from '../core/workspace-v2.ts'

/** The order an agent line delivered for; the owner's words and lines outside an order deliver nothing. */
function deliveredFor(session: V2Session, message: V2Message) {
  return message.role === 'agent' ? messageWorkOrder(session, message) : undefined
}

/**
 * The files an order's agent lines delivered. When `fileOf` names the file behind an attachment, the same file
 * linked again (say, to answer "where is it?") is one output, listed at its latest reference.
 */
export function publishedOutputs(session: V2Session, transcript: V2Transcript, orderId: string,
  fileOf?: (attachmentId: string) => string | undefined): WorkOrderOutput[] {
  const rows = transcript.messages.flatMap(message =>
    deliveredFor(session, message) === orderId
      ? (message.attachments ?? []).map(attachment => ({sessionId:session.id,messageId:message.id,attachment}))
      : [])
  if (!fileOf) return rows
  const key = (row: WorkOrderOutput) => fileOf(row.attachment.id) ?? row.attachment.id
  const latest = new Map(rows.map((row, index) => [key(row), index]))
  return rows.filter((row, index) => latest.get(key(row)) === index)
}

/** One readable conversation of a workspace with the orders it is responsible for. */
export interface OutputSource {
  session: V2Session
  transcript: V2Transcript
  orders: { id: string; title: string }[]
  /** The file behind an attachment (group chats link files by path); absent: every attachment is its own output. */
  fileOf?: (attachmentId: string) => string | undefined
}

const time = (at: string) => Date.parse(at) || 0

/**
 * A workspace's delivered files: every order's 「交付成果」 together (the same lines `publishedOutputs` takes), one
 * row per file (by path where the conversation knows it), at its latest delivery and tagged with each order that
 * delivered it. Newest first. The key is a digest of the path, so the answer never carries the path itself.
 */
export function workspaceOutputs(sources: OutputSource[]): WorkspaceOutput[] {
  type Merged = WorkspaceOutput & { orderAt: Map<string, number>; speakers: Map<string, {name: string; at: number}> }
  const merged = new Map<string, Merged>()
  for (const {session, transcript, orders, fileOf} of sources) {
    const titles = new Map(orders.map(order => [order.id, order.title]))
    for (const message of transcript.messages) {
      const orderId = deliveredFor(session, message)
      const title = orderId === undefined ? undefined : titles.get(orderId)
      if (orderId === undefined || title === undefined) continue
      const at = time(message.at)
      const speaker = message.speakerId ?? message.author
      for (const attachment of message.attachments ?? []) {
        const file = fileOf?.(attachment.id)
        const key = file ? createHash('sha256').update(file).digest('hex').slice(0, 24) : session.id + '/' + attachment.id
        let row = merged.get(key)
        // A later line takes over the reference: the latest link is the one that opens.
        if (!row || at >= time(row.at)) {
          row = {...row ?? {orders: [], deliveredBy: [], orderAt: new Map(), speakers: new Map()},
            key, label: attachment.label, at: message.at, sessionId: session.id, messageId: message.id, attachment}
          merged.set(key, row)
        }
        row.orderAt.set(orderId, Math.max(at, row.orderAt.get(orderId) ?? -Infinity))
        if (!row.orders.some(order => order.id === orderId)) row.orders.push({id: orderId, title})
        const known = row.speakers.get(speaker)
        if (!known || at >= known.at) row.speakers.set(speaker, {name: message.author, at})
      }
    }
  }
  return [...merged.values()].sort((a, b) => time(b.at) - time(a.at)).map(({orderAt, speakers, orders, deliveredBy: _, ...row}) => ({
    ...row,
    orders: [...orders].sort((a, b) => orderAt.get(b.id)! - orderAt.get(a.id)!),
    deliveredBy: [...speakers].sort(([, a], [, b]) => b.at - a.at).map(([id, {name}]) => ({id, name})),
  }))
}
