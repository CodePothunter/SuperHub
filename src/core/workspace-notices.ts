import type { V2Attachment, V2AttachmentRef, V2Message } from './workspace-v2.ts'

export interface OrderResultNotice {
  id: string
  workspaceId: string
  orderId: string
  sessionId: string
  workspaceName: string
  orderTitle: string
  title: string
  at: string
  read: boolean
  kind: 'report' | 'partial' | 'weekly'
  version: string
  messageId?: string
  reportId?: string
  /** The order has been completed since (shown with the result). */
  orderDone?: true
  attachments: (V2AttachmentRef & {version: string})[]
}
export interface ResultNoticeList {
  scope: string
  unread: number
  items: OrderResultNotice[]
  total: number
  nextOffset?: number
}
export interface SavedOrderResults { messages: V2Message[]; attachments: V2Attachment[] }
