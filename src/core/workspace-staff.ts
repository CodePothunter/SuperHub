import type { SpeakerPortrait } from './workspace-avatars.ts'
import type { ExperienceMemory } from './workspace-experience.ts'
/** Owner-facing projections. Execution receives only StaffContext. */
export interface StaffMember {
  id: string
  name: string
  brief: string
  portrait?: SpeakerPortrait
  defaultPortrait?: SpeakerPortrait
  homeWorkspaceId?: string
  memberships: { workspaceId: string; duty: string }[]
  /** How a member without a global role card runs in group chats. Absent: DSH with the liaison's model. */
  executor?: StaffMemberExecutor
  /** provider/model for a DSH member, checked against the DSH catalog. */
  model?: string
  reasoningEffort?: string
}
export const STAFF_MEMBER_EXECUTORS = ['dsh', 'codex', 'claude-code'] as const
export type StaffMemberExecutor = typeof STAFF_MEMBER_EXECUTORS[number]
export const isStaffMemberExecutor = (value: unknown): value is StaffMemberExecutor =>
  STAFF_MEMBER_EXECUTORS.some(item => item === value)
export interface StaffMemory extends Omit<ExperienceMemory, 'audience' | 'staffId' | 'status'> {
  audience?: 'staff'
  staffId: string
  status: 'proposed' | 'active'
}
export interface StaffShare {
  id: string
  memoryId: string
  staffId?: string
  workspaceId: string
  targetWorkspaceId: string
  targetStaffId?: string
  sourceVersion?: number
  targetAudience?: 'shared' | 'staff'
  targetStaffName?: string
  text: string
  expiresAt?: string
  purpose?: string
}
export interface StaffView {
  timeZone?: string
  scope: string
  workspaceId?: string
  members: StaffMember[]
  available: { id: string; name: string }[]
  memories: StaffMemory[]
  shares: StaffShare[]
  received: { id: string; staffId: string; text: string; expiresAt?: string; purpose?: string }[]
  sharedExperiences?: ExperienceMemory[]
  retiredMemories?: ExperienceMemory[]
  sharedReceived?: { id: string; text: string; expiresAt?: string; purpose?: string }[]
}
export interface StaffImpact {
  token: string
  memories: number
  shares: number
  workspaceIds: string[]
}
export interface StaffContext {
  workspaceId: string
  staffId: string
  name: string
  brief: string
  duty: string
  memories: { id: string; text: string; purpose?: string; shared?: true }[]
  token: string
}
