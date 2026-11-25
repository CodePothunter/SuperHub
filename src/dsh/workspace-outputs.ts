import { messageWorkOrder, type V2Session, type V2Transcript, type WorkOrderOutput } from '../core/workspace-v2.ts'

export function publishedOutputs(session: V2Session, transcript: V2Transcript, orderId: string): WorkOrderOutput[] {
  return transcript.messages.flatMap(message =>
    message.role === 'agent' && messageWorkOrder(session, message) === orderId
      ? (message.attachments ?? []).map(attachment => ({sessionId:session.id,messageId:message.id,attachment}))
      : [])
}
