import type { ChatInputAttachment } from '../core/chat-attachments.ts'

export const INITIAL_WORKSPACE_TRACE = 'initial'

export interface WorkspaceDialogueEdit {
  sessionId: string
  traceId: string
  requestId: string
  text: string
  workOrderId?: string
  inputAttachments?: ChatInputAttachment[]
  messageId?: string
  admitted?: true
}

export interface WorkspaceTrace {
  id: string
  parentId?: string
  /** The row selected for editing and the last visible seq in the original view at commit. */
  anchorId?: string
  beforeSeq?: number
  frozenThrough?: number
  edit?: WorkspaceDialogueEdit
}

export interface WorkspaceTraceState {
  active: string
  traces: WorkspaceTrace[]
}

export function initialTraceState(): WorkspaceTraceState {
  return {active: INITIAL_WORKSPACE_TRACE, traces: [{id: INITIAL_WORKSPACE_TRACE}]}
}
