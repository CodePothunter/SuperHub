import type { V2Attachment, V2AttachmentRef } from './workspace-v2.ts'
import type { SpeakerPortraits } from './workspace-avatars.ts'
import type { Person } from './poc.ts'

export const HISTORY_KINDS = ['room', 'person', 'commitment', 'line', 'meeting', 'project', 'goal', 'document'] as const
export type HistoryKind = typeof HISTORY_KINDS[number]

/** A source key is only a lookup in the active brain's catalog. */
export const historyItemId = (kind: HistoryKind, sourceId: string) => kind + ':' + sourceId

export interface HistoryItem {
  id: string
  kind: HistoryKind
  sourceId: string
  title: string
  subtitle?: string
  at?: string
  person?: Pick<Person, 'organization' | 'team' | 'role' | 'influence' | 'groups'>
}

export interface HistoryList {
  scope: string
  available: number
  total: number
  counts: Record<HistoryKind, number>
  items: HistoryItem[]
  nextOffset?: number
  importedAt?: string
  sourceIssue?: string
}

/** The personal directory reads the current roster and preserves imported-only people. */
export interface PeopleList { scope: string; items: HistoryItem[]; issue?: string }

export interface HistoryImport {
  scope: string
  added: number
  updated: number
  unchanged: number
  total: number
  importedAt: string
  retained?: number
  incomplete?: number
}

export interface HistoryMessage { id: string; author: string; text: string; at?: string; replyTo?: string; speakerId?: string }
export interface HistoryDetail {
  portraits?: SpeakerPortraits
  scope: string
  item: HistoryItem
  body?: string
  messages: HistoryMessage[]
  attachments: V2AttachmentRef[]
  links: { id: string; label: string }[]
  issue?: string
  origin?: 'roster' | 'import'
}
export interface HistoryAttachment { scope: string; attachment: V2Attachment }
