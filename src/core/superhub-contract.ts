import { createHash } from 'node:crypto'
import type { AcceptanceContract, AcceptanceCriterion, AcceptanceCriterionInput, Assignment, CriterionEvidence, CriterionResult, DeliveryVersion, NativeEvidence, Ticket, Verification } from './model.ts'

export const activeContract = (ticket: Ticket): AcceptanceContract | undefined => ticket.superhub?.contracts.at(-1)

export const requestHash = (values: unknown) => createHash('sha256').update(JSON.stringify(values)).digest('hex')

export function conflict(message: string): never {
  throw Object.assign(new Error(message), { status: 409 })
}

export function ownerText(value: string, field: string, max = 6000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${field}不能为空，且不能超过 ${max} 字`)
  return value.trim()
}

export function actionList(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > 30) throw Error('授权动作最多 30 项')
  return [...new Set(values.map(value => ownerText(value, '授权动作', 500)))]
}

export function contractCriteria(inputs: readonly AcceptanceCriterionInput[], previous?: AcceptanceContract): readonly AcceptanceCriterion[] {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 30) throw Error('完成标准须有 1 到 30 项')
  const ids = new Set<string>()
  const criteria = inputs.map((input, index): AcceptanceCriterion => {
    if (!input || typeof input !== 'object') throw Error('完成标准必须包含描述')
    const text = ownerText(input.text, '完成标准', 2000)
    const prior = input.id === undefined
      ? previous?.criteria.find(row => row.text === text)
      : previous?.criteria.find(row => row.id === input.id)
    if (previous && !prior) throw Error('修改标准时须保留原编号；新增授权请另开工单')
    const id = prior?.id ?? input.id ?? `C-${String(index + 1).padStart(2, '0')}`
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(id) || ids.has(id)) throw Error('标准编号无效或重复')
    ids.add(id)
    const method = input.method ?? prior?.method ?? 'delivery'
    if (method !== 'delivery' && method !== 'native') throw Error('未知核验方法')
    if (input.required !== undefined && typeof input.required !== 'boolean') throw Error('必要性须为布尔值')
    return { id, text, required: input.required ?? prior?.required ?? true, method }
  })
  if (!criteria.some(row => row.required)) throw Error('至少一项标准须为必要')
  if (previous && criteria.length !== previous.criteria.length) throw Error('修改契约时须保留原标准编号；请明确记录标准改动')
  return criteria
}

export function unverifiedContract(
  contract: AcceptanceContract,
  critique: string,
  status: NonNullable<Verification['status']> = 'unverified',
  assignment?: Assignment,
): Verification {
  return {
    verdict: 'revise', critique, status, contractVersion: contract.version,
    criteria: contract.criteria.map(row => ({ criterionId: row.id, status: 'unverified', evidence: [] })),
    ...assignment?.reviewExecution ? { reviewer: assignment.reviewExecution } : {},
  }
}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export function parseContractVerification(
  value: unknown,
  contract: AcceptanceContract,
  assignment: Assignment,
  deliveries: readonly DeliveryVersion[],
  native: readonly NativeEvidence[],
): Verification {
  const reviewer = assignment.reviewExecution
  const executor = assignment.execution
  if (!reviewer || !assignment.verifier || assignment.staff === assignment.verifier
    || (!executor && assignment.executor !== 'remote')
    || (executor && (executor.activationId === reviewer.activationId || (!!executor.sessionId && executor.sessionId === reviewer.sessionId)))) {
    return unverifiedContract(contract, '没有独立审查执行的可核对记录。', 'unverified', assignment)
  }
  const payload = asObject(value)
  if (!payload || typeof payload.critique !== 'string' || !payload.critique.trim() || !Array.isArray(payload.criteria)) {
    return unverifiedContract(contract, '审查未返回可核对的逐项判定。', 'failed', assignment)
  }
  const allowed = new Set(contract.criteria.map(row => row.id))
  const byId = new Map<string, Record<string, unknown>>()
  for (const candidate of payload.criteria) {
    const row = asObject(candidate)
    if (!row || typeof row.criterionId !== 'string' || !allowed.has(row.criterionId) || byId.has(row.criterionId)) {
      return unverifiedContract(contract, '审查标准编号未知或重复，请重新核验。', 'failed', assignment)
    }
    byId.set(row.criterionId, row)
  }
  const criteria = contract.criteria.map((criterion): CriterionResult => {
    const row = byId.get(criterion.id)
    const references = Array.isArray(row?.evidence) ? row.evidence : []
    const evidence: CriterionEvidence[] = []
    for (const reference of references) {
      const ref = asObject(reference)
      const delivery = criterion.method === 'delivery' && deliveries.find(item => item.path === ref?.path && item.version === ref.version)
      const record = criterion.method === 'native' && native.find(item => item.id === ref?.id && item.version === ref.version)
      const match = delivery ? { kind: 'delivery' as const, ...delivery } : record ? { kind: 'native' as const, ...record } : undefined
      if (match && !evidence.some(item => JSON.stringify(item) === JSON.stringify(match))) evidence.push(match)
    }
    const reported = row?.status
    const status = (reported === 'not_applicable' && !criterion.required) || reported === 'disputed'
      || ((reported === 'pass' || reported === 'fail') && evidence.length > 0 && evidence.length === references.length)
      ? reported : 'unverified'
    const comment = typeof row?.comment === 'string' ? row.comment.trim().slice(0, 3000) : ''
    return { criterionId: criterion.id, status, evidence, ...comment ? { comment } : {} }
  })
  const passed = contract.criteria.every((criterion, index) => !criterion.required || criteria[index]!.status === 'pass')
  return { verdict: passed ? 'pass' : 'revise', critique: payload.critique.trim().slice(0, 6000), status: 'completed', contractVersion: contract.version, criteria, reviewer }
}
