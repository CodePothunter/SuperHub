export const PROFILE_IMPORT_ROOT = '/v2/profile/imports'
export const profileImportId = /^profile-[a-f0-9]{64}$/
export const profileItemId = /^item-[a-f0-9]{32}$/

export const PROFILE_CATEGORIES = ['identity', 'stage', 'preferences', 'collaboration', 'principles', 'goal', 'person'] as const
export const PROFILE_IMPORT_STATUSES = ['organizing', 'review', 'processed', 'failed'] as const
const SOURCE_TYPES = ['memory', 'conversation', 'inference', 'unknown'] as const
const ITEM_STATUSES = ['pending', 'saved', 'skipped'] as const

export type ProfileImportCategory = typeof PROFILE_CATEGORIES[number]
export type ProfileImportStatus = typeof PROFILE_IMPORT_STATUSES[number]
export type ProfileSourceType = typeof SOURCE_TYPES[number]
export type ProfileItemStatus = typeof ITEM_STATUSES[number]
export type ProfileTargetVersion = string | 0

export interface ProfileImportSummary {
  id: string
  source: string
  at: string
  status: ProfileImportStatus
  pending: number
  total: number
  issue?: string
}

export interface ProfileImportTarget {
  id: string
  label: string
  version: ProfileTargetVersion
  current?: string
  /** This exact proposed text is already recorded at the destination. */
  match?: boolean
}

export interface ProfileSavedItem { targetId: string; label: string; text: string }

export interface ProfileImportItem {
  id: string
  version: number
  category: ProfileImportCategory
  text: string
  quote: string
  sourceType: ProfileSourceType
  confidential: boolean
  status: ProfileItemStatus
  subject?: string
  targets: ProfileImportTarget[]
  saved?: ProfileSavedItem
}

export interface ProfileImportList { scope: string; imports: ProfileImportSummary[] }
export interface ProfileImportDetail { scope: string; record: ProfileImportSummary & {text: string; items: ProfileImportItem[]} }
export interface ProfileImportReceipt { scope: string; importId: string; status: ProfileImportStatus }
export interface ProfileItemReceipt {
  scope: string
  importId: string
  itemId: string
  status: 'saved' | 'skipped'
  version: number
  saved?: ProfileSavedItem
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const scoped = (value: unknown): value is Record<string, unknown> & { scope: string } => record(value) && typeof value.scope === 'string'
const option = <T extends string>(options: readonly T[], value: unknown): value is T => typeof value === 'string' && (options as readonly string[]).includes(value)
const integer = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const identifier = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value)
const optionalText = (value: unknown) => value === undefined || typeof value === 'string'

export function isProfileImportCategory(value: unknown): value is ProfileImportCategory {
  return option(PROFILE_CATEGORIES, value)
}

export function isProfileTargetVersion(value: unknown): value is ProfileTargetVersion {
  return value === 0 || identifier(value, /^[a-f0-9]{64}$/)
}

function isSummary(value: unknown): value is ProfileImportSummary {
  return record(value) && identifier(value.id, profileImportId) && typeof value.source === 'string'
    && typeof value.at === 'string' && Number.isFinite(Date.parse(value.at)) && option(PROFILE_IMPORT_STATUSES, value.status)
    && integer(value.pending, 0) && integer(value.total, 0) && value.pending <= value.total && optionalText(value.issue)
}

function isTarget(value: unknown): value is ProfileImportTarget {
  return record(value) && typeof value.id === 'string' && typeof value.label === 'string' && isProfileTargetVersion(value.version)
    && optionalText(value.current) && (value.match === undefined || typeof value.match === 'boolean')
}

function isSaved(value: unknown): value is ProfileSavedItem {
  return record(value) && typeof value.targetId === 'string' && typeof value.label === 'string' && typeof value.text === 'string'
}

function isItem(value: unknown): value is ProfileImportItem {
  return record(value) && identifier(value.id, profileItemId) && integer(value.version, 1)
    && isProfileImportCategory(value.category) && typeof value.text === 'string' && typeof value.quote === 'string'
    && option(SOURCE_TYPES, value.sourceType) && typeof value.confidential === 'boolean' && optionalText(value.subject)
    && Array.isArray(value.targets) && value.targets.every(isTarget)
    && (value.status === 'saved' ? isSaved(value.saved) : option(ITEM_STATUSES, value.status) && value.saved === undefined)
}

export function isProfileImportList(value: unknown): value is ProfileImportList {
  return scoped(value) && Array.isArray(value.imports) && value.imports.every(isSummary)
}

export function isProfileImportDetail(value: unknown): value is ProfileImportDetail {
  if (!scoped(value) || !record(value.record)) return false
  const row = value.record
  return typeof row.text === 'string' && Array.isArray(row.items) && row.items.every(isItem) && isSummary(row)
}

export function isProfileImportReceipt(value: unknown): value is ProfileImportReceipt {
  return scoped(value) && identifier(value.importId, profileImportId) && option(PROFILE_IMPORT_STATUSES, value.status)
}

export function isProfileItemReceipt(value: unknown): value is ProfileItemReceipt {
  return scoped(value) && identifier(value.importId, profileImportId) && identifier(value.itemId, profileItemId)
    && integer(value.version, 1) && (value.status === 'saved' ? isSaved(value.saved) : value.status === 'skipped' && value.saved === undefined)
}
