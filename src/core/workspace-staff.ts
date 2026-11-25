import type { SpeakerPortrait } from './workspace-avatars.ts'
/** Owner-facing projections. Execution receives only StaffContext. */
export interface StaffMember {
  id: string
  name: string
  brief: string
  portrait?: SpeakerPortrait
  defaultPortrait?: SpeakerPortrait
  homeWorkspaceId?: string
  memberships: { workspaceId: string; duty: string }[]
}
export interface StaffMemory {
  id: string
  staffId: string
  workspaceId?: string
  text: string
  status: 'proposed' | 'active'
  version: number
  at: string
  recordedAt?: string
  adoptedAt?: string
  source?: 'owner' | 'suggestion'
  orderId?: string
  lastUsed?: { workspaceId: string; orderId: string; at: string }
}
export interface StaffShare {
  id: string
  memoryId: string
  staffId: string
  workspaceId: string
  targetWorkspaceId: string
  targetStaffId: string
  targetStaffName?: string
  text: string
  expiresAt?: string
  purpose?: string
}
export interface StaffView {
  scope: string
  workspaceId?: string
  members: StaffMember[]
  available: { id: string; name: string }[]
  memories: StaffMemory[]
  shares: StaffShare[]
  received: { id: string; staffId: string; text: string; expiresAt?: string; purpose?: string }[]
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
