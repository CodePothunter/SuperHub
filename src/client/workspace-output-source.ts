import type { WorkOrderOutput } from '../core/workspace-v2.ts'
import { resourceQuery, segment } from './workspace-v2-api.ts'

export function outputSourceKey(row: WorkOrderOutput) {
  return JSON.stringify([row.sessionId, row.traceId, row.messageId, row.attachment.id, row.attachment.version, row.orderId])
}

export function attachmentResource(base: string, row: WorkOrderOutput) {
  const path = row.sessionDeletedAt && row.orderId && row.attachment.version
    ? base + '/orders/' + segment(row.orderId) + '/outputs/' + segment(row.attachment.id)
    : base + '/sessions/' + segment(row.sessionId) + '/attachments/' + segment(row.attachment.id)
  if (!row.traceId && !row.attachment.version) return path
  const query = new URLSearchParams({message: row.messageId})
  if (row.traceId) query.set('trace', row.traceId)
  if (row.attachment.version) query.set('version', row.attachment.version)
  return resourceQuery(path, query)
}
