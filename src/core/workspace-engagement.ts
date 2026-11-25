import type { ExperienceRef } from './workspace-experience.ts'

/** One pending request for the owner, linked to its original group message. */
export interface OwnerAction {
  id: string
  workspaceId: string
  sessionId: string
  orderId?: string
  messageId: string
  question: string
  at: string
  workspaceName: string
  sessionTitle: string
}

export const ENGAGEMENT_REPORTING = ['final', 'milestone', 'each'] as const
export type EngagementReporting = typeof ENGAGEMENT_REPORTING[number]

export function isEngagementReporting(value: unknown): value is EngagementReporting {
  return ENGAGEMENT_REPORTING.some(mode => mode === value)
}

export interface EngagementMessage {
  seq: number
  speakerId: string
  author: string
  text: string
  replyTo?: number
  workOrderId?: string
  ownerActionId?: string
  attachments?: readonly {label: string; excerpt?: string}[]
}

export interface EngagementInput {
  turn: 'liaison' | 'member' | 'owner'
  source: EngagementMessage
  messages: readonly EngagementMessage[]
  order?: {
    id: string
    title: string
    promise: string
    original: string
    generation?: number
    remainingTurns?: number
    reporting?: EngagementReporting
  }
  pending: readonly {id: string; question: string; messageId: string; answerMessageId?: string}[]
  members: readonly {id: string; name: string}[]
  activeMembers?: readonly {id: string; workOrderId?: string}[]
  deliveredCheckpoints?: readonly string[]
  triggerSeq?: number
  now?: string
}

export interface EngagementDecision {
  kind: 'none' | 'continue' | 'ask' | 'deliver' | 'wait'
  text?: string
  memberIds?: string[]
  resolved?: string[]
  checkpoint?: string
  reviewAt?: string
  waitForMember?: string
  reporting?: EngagementReporting
  final?: boolean
  reason?: string
  title?: string
  promise?: string
  report?: string
  sourceSeq?: number
  evidenceSeqs?: number[]
  /** The host stamps versions that informed a durable handoff. */
  experienceRefs?: ExperienceRef[]
}

export type EngagementCoordinator = (input: EngagementInput, signal: AbortSignal) => Promise<EngagementDecision>
