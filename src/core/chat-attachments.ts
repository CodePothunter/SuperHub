/** A public handle for a message input. DSH storage paths and native receipts stay on the host. */
export interface ChatInputAttachment {
  id: string
  name: string
  kind: 'file' | 'image'
  bytes: number
  mediaType?: string
}

/** Without a workspace this identifies the owner's private liaison conversation. */
export interface ChatAttachmentTarget {
  sessionId: string
  workspaceId?: string
  workOrderId?: string
}

export function isChatInputAttachment(value: unknown): value is ChatInputAttachment {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<ChatInputAttachment>
  return typeof row.id === 'string' && !!row.id && typeof row.name === 'string' && !!row.name
    && (row.kind === 'file' || row.kind === 'image') && Number.isSafeInteger(row.bytes) && row.bytes! >= 0
    && (row.mediaType === undefined || typeof row.mediaType === 'string')
}
