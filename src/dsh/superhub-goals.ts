import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentGoal, GOAL_RELATIONS, GOAL_RESULTS, GOAL_STATES, GOAL_TYPES, SUPERHUB_GOALS_FILE, type GoalAssessment, type GoalCandidate, type GoalReference, type GoalVersion, type SuperhubGoal } from '../core/superhub-goals.ts'

interface GoalRequest { hash: string; goalId: string; version: number }
interface GoalFile { schema: 1; goals: SuperhubGoal[]; requests: Record<string, GoalRequest> }
export interface GoalChange { goal: SuperhubGoal; previous?: GoalVersion; current: GoalVersion }

export function workspaceError(status: number, message: string): never { throw Object.assign(new Error(message), { status }) }

function field(value: unknown, label: string, max: number, required = true): string {
  if (!required && value === undefined) return ''
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`请填写有效的${label}（最多 ${max} 字）`)
  return value.trim()
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  const found = choices.find(item => item === value)
  if (!found) throw new Error(`${label}无效`)
  return found
}
function rows(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 40 || value.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error(`${label}格式无效或超过 40 条`)
  return value as Record<string, unknown>[]
}

const goalKey = /^G-[a-f0-9-]{36}$/
const requestKey = /^[a-zA-Z0-9_-]{1,100}$/
const criterionKey = /^[a-zA-Z0-9_-]{1,80}$/
const hash = (input: string) => createHash('sha256').update(input).digest('hex')

export function workspaceFingerprint(value: unknown): string {
  return hash(JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item))
}

export function goalCandidates(markdown: string): GoalCandidate[] {
  const found = new Map<string, GoalCandidate>()
  let section = '目标'
  let fenced: string | undefined
  for (const line of markdown.split(/\r?\n/)) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (!fenced) fenced = fence
      else if (fence[0] === fenced[0] && fence.length >= fenced.length) fenced = undefined
      continue
    }
    if (fenced) continue
    const heading = /^#{2,6}\s+(\S.*)/.exec(line)
    if (heading) { section = heading[1]!.trim(); continue }
    const match = /^\s*[-*+]\s+\[([ xX])\]\s+(\S.*)/.exec(line)
    if (!match) continue
    const text = match[2]!.trim()
    if (/（(?:例[：:]|待定|每周)/.test(text)) continue
    const id = hash(JSON.stringify([section, text])).slice(0, 32)
    found.set(id, { id, section, text, state: match[1] === ' ' ? 'open' : 'done' })
  }
  return [...found.values()]
}

/** Directed edges retain their declared meaning. A background link never blocks work. */
function cycle(goals: Map<string, GoalVersion>, changedId: string, edges: (version: GoalVersion) => string[]): string[] | undefined {
  const checked = new Set<string>()
  const path = [changedId]
  const seek = (id: string): string[] | undefined => {
    path.push(id)
    if (id === changedId) return [...path]
    if (!checked.has(id)) {
      checked.add(id)
      for (const next of edges(goals.get(id)!)) {
        const found = seek(next)
        if (found) return found
      }
    }
    path.pop()
  }
  for (const id of edges(goals.get(changedId)!)) {
    const found = seek(id)
    if (found) return found
  }
}

export class SuperhubGoals {
  private readonly file: string
  private cache?: { stamp: string; data: GoalFile }
  constructor(private readonly root: string, private readonly committed: (message: string, paths: string[]) => void, private readonly now = () => new Date().toISOString()) {
    this.file = join(root, SUPERHUB_GOALS_FILE)
  }

  private load(): GoalFile {
    const exists = existsSync(this.file)
    const st = exists ? statSync(this.file) : undefined
    const stamp = st ? `${st.ino}:${st.mtimeMs}:${st.size}` : ''
    if (this.cache?.stamp === stamp) return this.cache.data
    const data: GoalFile = exists ? JSON.parse(readFileSync(this.file, 'utf8')) as GoalFile : { schema: 1, goals: [], requests: {} }
    if (data.schema !== 1 || !Array.isArray(data.goals) || !data.requests) throw new Error('结构化目标文件格式未知')
    this.cache = { stamp, data }
    return data
  }
  list(): SuperhubGoal[] { return this.load().goals }
  get(id: string): SuperhubGoal | undefined { return this.list().find(goal => goal.id === id) }
  candidates(): GoalCandidate[] {
    const file = join(this.root, 'goals.md')
    if (!existsSync(file)) return []
    const accepted = new Set(this.list().flatMap(goal => goal.source.kind === 'markdown' ? [goal.source.candidateId] : []))
    return goalCandidates(readFileSync(file, 'utf8')).filter(candidate => !accepted.has(candidate.id))
  }

  change(id: string | undefined, body: Record<string, unknown>, canCite: (reference: GoalReference) => boolean): GoalChange {
    const data = this.load()
    const requestId = body.requestId
    if (typeof requestId !== 'string' || !requestKey.test(requestId)) throw new Error('请求缺少稳定标识')
    const key = hash(requestId)
    const request = [id ?? null, body]
    const fingerprint = workspaceFingerprint(request)
    const saved = data.requests[key]
    if (saved) {
      if (saved.hash !== fingerprint && saved.hash !== hash(JSON.stringify(request))) workspaceError(409, '此次请求标识已用于另一项修改')
      const goal = data.goals.find(row => row.id === saved.goalId)!
      return { goal, previous: goal.versions[saved.version - 2], current: goal.versions[saved.version - 1]! }
    }

    const prior = id ? this.get(id) : undefined
    if (id && !prior) workspaceError(404, '找不到这项目标')
    const previous = prior && currentGoal(prior)
    if (body.expectedVersion !== (previous?.version ?? 0)) workspaceError(409, '目标已更新，请重新打开并核对修改')
    if (prior && body.candidateId !== undefined) throw new Error('已有目标保留原始来源')
    const candidate = body.candidateId === undefined ? undefined : this.candidates().find(row => row.id === body.candidateId)
    if (body.candidateId !== undefined && !candidate) workspaceError(409, '原始目标已变更或已导入，请核对来源')
    const reason = field(body.reason, '修改依据', 1200)
    const at = this.now()
    const goalId = prior?.id ?? `G-${randomUUID()}`
    const version = (previous?.version ?? 0) + 1
    const name = field(body.name ?? previous?.name ?? candidate?.text, '目标名称', 200)
    if (/[\r\n]/.test(name)) throw new Error('目标名称请使用一行文字')
    const status = choice(body.status ?? previous?.status ?? (candidate?.state === 'done' ? 'archived' : 'active'), GOAL_STATES, '目标状态')
    const criteria = body.criteria === undefined ? previous?.criteria ?? [] : rows(body.criteria, '目标条件').map(row => {
      if (row.id !== undefined && (typeof row.id !== 'string' || !criterionKey.test(row.id) || !previous?.criteria.some(criterion => criterion.id === row.id))) throw new Error('目标条件标识无效')
      if (row.required !== undefined && typeof row.required !== 'boolean') throw new Error('请明确条件是否必要')
      return { id: (row.id as string | undefined) ?? `C-${randomUUID()}`, text: field(row.text, '目标条件', 600), required: row.required !== false }
    })
    if (new Set(criteria.map(row => row.id)).size !== criteria.length) throw new Error('目标条件不能重复')
    const parent = body.parent === null ? undefined : body.parent === undefined ? previous?.parent : field(body.parent, '上级目标', 70)
    const relations = body.relations === undefined ? previous?.relations ?? [] : rows(body.relations, '目标关系').map(row => ({
      target: field(row.target, '关联目标', 70), kind: choice(row.kind, GOAL_RELATIONS, '关系类型'),
    }))
    if (new Set(relations.map(row => `${row.kind}:${row.target}`)).size !== relations.length) throw new Error('目标关系不能重复')
    const current: GoalVersion = {
      version, at, reason, name, status, parent, relations, criteria,
      description: field(body.description ?? previous?.description, '目标说明', 6000, false),
      type: choice(body.type ?? previous?.type ?? 'project', GOAL_TYPES, '目标类型'),
      owner: field(body.owner ?? previous?.owner ?? '主人', '目标所有者', 100),
      horizon: field(body.horizon ?? previous?.horizon, '时间跨度', 200, false),
    }
    const lookup = new Map(data.goals.map(goal => [goal.id, currentGoal(goal)]))
    lookup.set(goalId, current)
    for (const ref of [...parent ? [parent] : [], ...relations.map(rel => rel.target)]) {
      if (!goalKey.test(ref) || !lookup.has(ref)) throw new Error(`找不到关联目标 ${ref}`)
    }
    for (const edges of [(row: GoalVersion) => row.parent ? [row.parent] : [], (row: GoalVersion) => row.relations.filter(rel => rel.kind === 'requires').map(rel => rel.target)]) {
      const found = cycle(lookup, goalId, edges)
      if (found) workspaceError(409, `关系形成循环：${found.map(ref => lookup.get(ref)!.name).join(' → ')}`)
    }
    if (body.assessment !== undefined) {
      if (!body.assessment || typeof body.assessment !== 'object' || Array.isArray(body.assessment)) throw new Error('目标评估格式无效')
      const assessment = body.assessment as Record<string, unknown>
      current.assessment = this.assessment(current, assessment, canCite)
    } else if (previous?.assessment && previous.criteria.length === criteria.length && previous.description === current.description
      && previous.type === current.type && previous.horizon === current.horizon
      && previous.criteria.every(prior => criteria.some(candidate => candidate.id === prior.id && candidate.text === prior.text && candidate.required === prior.required))) {
      current.assessment = previous.assessment
    }
    if (status === 'achieved' && (current.type !== 'project' || current.assessment?.result !== 'met')) throw new Error('请先依据这项目标的有效必要条件完成复核。方向型和维持型目标可记录达标时点。')
    const goal: SuperhubGoal = {
      id: goalId,
      source: prior?.source ?? (candidate ? { kind: 'markdown', candidateId: candidate.id, section: candidate.section, text: candidate.text } : { kind: 'owner', requestId }),
      versions: [...prior?.versions ?? [], current],
    }
    const next: GoalFile = { schema: 1, goals: prior ? data.goals.map(row => row.id === goalId ? goal : row) : [...data.goals, goal],
      requests: { ...data.requests, [key]: { hash: fingerprint, goalId, version } } }
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.file)
    this.cache = undefined
    this.committed(`目标 ${goalId} 第 ${version} 版`, [SUPERHUB_GOALS_FILE])
    return { goal, previous, current }
  }

  private assessment(current: GoalVersion, body: Record<string, unknown>, canCite: (reference: GoalReference) => boolean): GoalAssessment {
    const result = choice(body.result, GOAL_RESULTS, '评估结论')
    const findings = rows(body.findings ?? [], '条件判断').map(row => {
      const criterionId = field(row.criterionId, '条件标识', 80)
      if (!current.criteria.some(criterion => criterion.id === criterionId)) throw new Error('请引用本版目标的条件')
      const evidence = rows(row.evidence ?? [], '成果证据').map(ref => ({
        ticketId: field(ref.ticketId, '工单标识', 60), evidenceId: field(ref.evidenceId, '证据标识', 260),
      }))
      if (evidence.some(ref => !canCite(ref))) throw new Error('成果证据未登记、版本已变更或不属于当前目标')
      const status = choice(row.status, ['met', 'unmet', 'uncertain'] as const, '条件判断')
      if (status === 'met' && !evidence.length) throw new Error('已满足的条件需要成果证据')
      return { criterionId, status, evidence, note: field(row.note, '证据为何适用', 2000) }
    })
    if (new Set(findings.map(row => row.criterionId)).size !== findings.length) throw new Error('每个条件只保留一个当前判断')
    const required = current.criteria.filter(criterion => criterion.required)
    if (result === 'met' && (!required.length || required.some(criterion => !findings.some(row => row.criterionId === criterion.id && row.status === 'met')))) throw new Error('请逐项复核所有必要条件后确认目标成果')
    return { at: current.at, version: current.version, result, note: field(body.note, '评估依据', 2000), findings }
  }
}
