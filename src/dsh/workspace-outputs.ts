import { messageWorkOrder, type V2Session, type V2Transcript, type WorkOrderOutput } from '../core/workspace-v2.ts'

/**
 * The files an order's agent lines delivered. When `fileOf` names the file behind an attachment, the same file
 * linked again (say, to answer "where is it?") is one output, listed at its latest reference.
 */
export function publishedOutputs(session: V2Session, transcript: V2Transcript, orderId: string,
  fileOf?: (attachmentId: string) => string | undefined): WorkOrderOutput[] {
  const rows = transcript.messages.flatMap(message =>
    message.role === 'agent' && messageWorkOrder(session, message) === orderId
      ? (message.attachments ?? []).map(attachment => ({sessionId:session.id,messageId:message.id,attachment}))
      : [])
  if (!fileOf) return rows
  const key = (row: WorkOrderOutput) => fileOf(row.attachment.id) ?? row.attachment.id
  const latest = new Map(rows.map((row, index) => [key(row), index]))
  return rows.filter((row, index) => latest.get(key(row)) === index)
}
