export interface ExperienceRef {
  id: string
  version: number
}

export interface ExperienceEvidence {
  kind: 'owner' | 'group' | 'delivery' | 'artifact' | 'tool' | 'test' | 'model-review' | 'owner-acceptance' | 'order'
  id: string
  workspaceId?: string
  sessionId?: string
  orderId?: string
  messageId?: string
  turnId?: string
  fileId?: string
  staffId?: string
  resultId?: string
  version?: string
  quote?: string
}

export interface ExperienceSupport {
  orderId: string
  origin: string
  evidence: ExperienceEvidence[]
}

export interface ExperienceMaintenance {
  action: 'learn' | 'accept' | 'revise' | 'retire' | 'expire' | 'pause' | 'restore'
  actor: 'manual' | 'owner' | 'system'
  at: string
  reason?: string
}

export interface ExperienceMemory extends ExperienceRef {
  audience: 'shared' | 'staff'
  staffId?: string
  workspaceId?: string
  text: string
  status: 'proposed' | 'active' | 'retired'
  at: string
  recordedAt?: string
  adoptedAt?: string
  source?: 'owner' | 'suggestion' | 'observation'
  orderId?: string
  lastUsed?: { workspaceId: string; orderId: string; at: string }
  lastDeliveredAt?: string
  situation?: string
  boundary?: string
  domains?: string[]
  taskTypes?: string[]
  evidence?: ExperienceEvidence[]
  discoveredBy?: string
  reason?: string
  feedback?: ExperienceFeedback[]
  previousVersions?: number[]
  expiresAt?: string
  maintenance?: ExperienceMaintenance
  conflict?: ExperienceEvidence[]
  premise?: ExperienceEvidence
  /** Internal source records. Owner-facing projections show the count and the evidence of decisions. */
  supports?: ExperienceSupport[]
  supportCount?: number
  reviewSuggested?: boolean
  replacementPending?: boolean
}

export interface ExperienceQuery {
  workspaceId?: string
  staffId?: string
  task: string
  /** When task also includes generated hand-offs, the host supplies its verified owner wording here. */
  purposeTask?: string
  domains?: readonly string[]
  taskTypes?: readonly string[]
  /** Only the host can attest that these exact versions were explicitly delegated to this recipient for this task. */
  delegated?: readonly (ExperienceRef & { purpose?: string; expiresAt?: string })[]
}

export interface ExperienceEntry extends ExperienceRef {
  text: string
  workspaceId?: string
  staffId?: string
  situation?: string
  boundary?: string
  purpose?: string
  shareId?: string
  evidence?: ExperienceEvidence[]
  domains?: readonly string[]
  taskTypes?: readonly string[]
}

export interface ExperienceSelection {
  query: ExperienceQuery
  entries: ExperienceEntry[]
  authorized: ExperienceRef[]
  scope: string
  authority: string
  behavior?: string
}

export interface ExperienceDeliveryTarget {
  turnId: string
  executorId: string
  sessionId: string
  nativeSessionId?: string
  orderId?: string
}

export interface ExperienceDelivery extends ExperienceDeliveryTarget {
  workspaceId?: string
  entries: (ExperienceRef & { shareId?: string })[]
  at: string
}

export interface ExperienceFeedback {
  id: string
  memory: ExperienceRef
  kind: 'owner-correction' | 'supported' | 'not-applicable' | 'contradicted' | 'owner-acceptance' | 'model-review'
  evidence: ExperienceEvidence
  sessionId?: string
  turnId?: string
}

export interface WorkspaceExperiencePort {
  selectExperience(query: ExperienceQuery): ExperienceSelection
  assertExperienceCurrent(selection: ExperienceSelection): void
  recordExperienceDelivery(selection: ExperienceSelection, target: ExperienceDeliveryTarget, entries?: readonly ExperienceEntry[]): void
}

export const EXPERIENCE_EVIDENCE_LIMIT = 8

const words = new Intl.Segmenter('zh', { granularity: 'word' })
const generic = new Set(['任务','工作','相关','项目','进行','检查','使用','内容','当前','以后','需要',
  '结果','方法','完成','要求','提供','应该','流程','处理','执行','建议','情况','可以','一类','用于','仅供','本区','本轮',
  'task','project','work','current','use','using','check','result','complete','run','need','require','this','that','from','with','for','the','and'])

function terms(text: string): Set<string> {
  const result = new Set<string>()
  let previousHan = ''
  for (const {segment,isWordLike} of words.segment(text.normalize('NFKC').toLowerCase())) {
    if (isWordLike && /^\p{Script=Han}$/u.test(segment)) {
      const pair = previousHan + segment
      if (previousHan && !generic.has(pair)) result.add(pair)
      previousHan = segment
    } else {
      previousHan = ''
      if (isWordLike && segment.length > 1 && !generic.has(segment)) result.add(segment)
    }
  }
  return result
}

const overlap = (left: Set<string>, right: Set<string>) => [...left].filter(term => right.has(term)).length
const tagMatch = (values: readonly string[] | undefined, query: readonly string[] | undefined) => values?.some(value =>
  query?.some(tag => tag.normalize('NFKC').toLowerCase() === value.normalize('NFKC').toLowerCase())) ?? false

/** An authorization marked with a specific purpose applies only to a matching task. */
export function matchesExperiencePurpose(purpose: string | undefined, query: ExperienceQuery): boolean {
  if (!purpose) return true
  const task = query.purposeTask ?? query.task
  const purposeTerms = terms(purpose)
  return task.normalize('NFKC').toLowerCase().includes(purpose.normalize('NFKC').toLowerCase())
    || purposeTerms.size > 0 && overlap(purposeTerms,terms(task)) === purposeTerms.size
}

const experienceLine = (entry: ExperienceEntry) => JSON.stringify({
  id: entry.id,
  version: entry.version,
  workspaceId: entry.workspaceId ?? null,
  audience: entry.staffId ? 'staff' : 'shared',
  text: entry.text,
  situation: entry.situation,
  boundary: entry.boundary,
  purpose: entry.purpose,
  evidence: entry.evidence?.map(({ quote: _quote, ...pointer }) => pointer),
})
const contextHeading = '本轮可参考的经验。遵循主人最新指示和当前任务约定，按条目的适用条件与用途使用。'

/** Conservative character-based budget for mixed Chinese and English text. */
function estimatedTokens(text: string): number {
  let count = 0
  for (const char of text) count += char.codePointAt(0)! < 128 ? 0.4 : 2
  return Math.ceil(count)
}

/** Call only with records the host has already authorized. */
export function relevantExperience(entries: readonly ExperienceEntry[], query: ExperienceQuery): ExperienceEntry[] {
  const taskText = [query.task, ...query.domains ?? [], ...query.taskTypes ?? []].join(' ')
  const task = terms(taskText)
  const normalizedText = taskText.normalize('NFKC').toLowerCase()
  const scored = entries.map(entry => {
    const mentionsTag = (tags: readonly string[] | undefined) => tags?.some(tag => normalizedText.includes(tag.normalize('NFKC').toLowerCase()))
    const taskTypeMatch = tagMatch(entry.taskTypes, query.taskTypes) || mentionsTag(entry.taskTypes)
    const domainMatch = tagMatch(entry.domains, query.domains) || mentionsTag(entry.domains)
    const contentMatch = overlap(task, terms([entry.text, entry.situation ?? '', entry.purpose ?? ''].join(' ')))
    const outsideDeclaredType = entry.taskTypes?.length && !taskTypeMatch && (query.taskTypes?.length || !contentMatch)
    const score = outsideDeclaredType ? 0 : contentMatch + (taskTypeMatch ? 8 : 0) + (domainMatch ? 3 : 0)
    return {entry, score}
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(!!b.entry.workspaceId) - Number(!!a.entry.workspaceId)
      || a.entry.id.localeCompare(b.entry.id))
  const selected: ExperienceEntry[] = []
  const unique = new Set<string>()
  let remaining = 1200 - estimatedTokens(contextHeading)
  for (const {entry} of scored) {
    if (selected.length === 5) break
    const content = JSON.stringify([entry.text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' '), entry.situation, entry.boundary, entry.purpose])
    const cost = estimatedTokens(experienceLine(entry)) + 1
    if (unique.has(content) || cost > remaining) continue
    unique.add(content)
    remaining -= cost
    selected.push(entry)
  }
  return selected
}

export function renderExperience(selection: ExperienceSelection, entries: readonly ExperienceEntry[] = selection.entries): string {
  const experience = entries.length ? [contextHeading, ...entries.map(experienceLine)].join('\n') : ''
  return [selection.behavior,experience].filter(Boolean).join('\n\n')
}
