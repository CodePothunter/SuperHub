/**
 * 工单阶段：由工单数据推导，不单独存储（DESIGN.md 第 3 节）。
 * 自上而下匹配，第一条命中的规则生效。
 */
import type { Assignment, Ticket } from './model.ts'

export type Stage =
  | 'you/approve'
  | 'you/answer'
  | 'you/review'
  | 'you/blocked'
  | 'queued'
  | 'working'
  | 'verifying'
  | 'remote'
  | 'waiting'
  | 'ended'

/** 返工轮数上限：超过后交给主人。 */
export const MAX_REVISIONS = 2

export const latestAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.at(-1)

/**
 * 主人是否有尚未被派工带走的输入。每次派工都会带走当时全部输入，所以未被带走的输入
 * 必然晚于最近一次派工——按顺序判断，不依赖时间戳（同一毫秒内的回复也不会漏掉）。
 */
export const ownerHasPendingInput = (ticket: Ticket): boolean =>
  ticket.inputs.some(input => input.from === 'owner' && input.consumedBy === undefined)

/** 进程内的实时活动：某次派工正在执行还是正在被核验。重启后为空。 */
export type Activity = ReadonlyMap<string, 'executing' | 'verifying'>

export function stageOf(ticket: Ticket, activity: Activity = new Map()): Stage {
  if (ticket.ended) return 'ended'
  const contract = ticket.superhub?.contracts.at(-1)
  if (ticket.superhub && !contract) return 'you/blocked'
  if ((ticket.mandate.level === 'propose' || ticket.superhub?.approvalRequired) && !ticket.approvedAt) return 'you/approve'
  const last = latestAssignment(ticket)
  const live = last ? activity.get(last.id) : undefined
  if (live === 'verifying') return 'verifying'
  if (live === 'executing') return 'working'
  if (ticket.waitingFor?.length) return 'waiting'
  if (last?.state === 'running') return last.executor === 'remote' ? 'remote' : 'working'
  const report = last?.report
  if (!last || !report) return 'queued'
  // 主人在最近一次汇报之后说过话：无论汇报是什么，都按他的话继续干。
  if (ownerHasPendingInput(ticket) || ticket.inputs.some(i => i.key?.startsWith('child:') && !i.consumedBy)) return 'queued'
  if (contract && last.contractVersion !== contract.version) return 'you/blocked'
  switch (report.status) {
    case 'question': return 'you/answer'
    case 'blocked':
    case 'failed': return 'you/blocked'
    case 'dropped': return 'ended'
    case 'ready': {
      const verdict = last.verification?.verdict
      if (verdict === undefined) return 'verifying'
      if (verdict === 'fail') return 'you/blocked'
      if (verdict === 'revise') return last.handedToOwner || last.round >= MAX_REVISIONS ? 'you/review' : 'queued'
      return 'you/review'
    }
  }
}

/** 作战台分栏。 */
export type Column = 'you' | 'active' | 'queued' | 'ended'

export function columnOf(stage: Stage): Column {
  if (stage.startsWith('you/')) return 'you'
  if (stage === 'queued') return 'queued'
  if (stage === 'ended') return 'ended'
  return 'active'
}

/**
 * "等你决定"一栏的排序分数，越大越靠前。
 *
 * 这是主人注意力分配的策略：上手期最怕什么，就让什么冒到最上面。
 * 默认规则：
 *   1. 卡住的工作（answer / blocked）优先于验收（review），因为它们阻塞后续执行；
 *   2. 批准类（approve）排在最后：不批准也不会造成损失；
 *   3. 同类里，主人明确投递的工单优先于时钟规则触发的，再按工单优先级和等待时长。
 * 主人可以直接改这个函数来表达自己的偏好。
 */
export function attentionScore(ticket: Ticket, stage: Stage, now: Date): number {
  const base: Partial<Record<Stage, number>> = { 'you/answer': 400, 'you/blocked': 300, 'you/review': 200, 'you/approve': 100 }
  const waitingHours = (now.getTime() - Date.parse(latestAssignment(ticket)?.endedAt ?? ticket.createdAt)) / 3_600_000
  return (base[stage] ?? 0)
    + (ticket.mandate.strength === 'explicit' ? 50 : 0)
    + ticket.priority * 10
    + Math.min(waitingHours, 48)
}
