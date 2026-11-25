/** 工单抽屉主人操作携带的目标所需的已加载详情。 */
export interface OwnerTargetDetail {
  threadId?: string
  stage: string
  ticket: { assignments: readonly { id: string }[]; superhub?: { brainScope: string; contracts: readonly { version: number }[] } }
}

/**
 * 工单抽屉主人操作的过期校验目标。SuperHub 工单另附抽屉加载时的第二大脑作用域与最新契约版本；
 * 加载后契约修订或第二大脑切换，服务端仍按版本不符拒绝。普通工单的请求保持不变。
 */
export function ownerTarget(detail?: OwnerTargetDetail) {
  const superhub = detail?.ticket.superhub
  return {
    thread_id: detail?.threadId, reply_to: detail?.ticket.assignments.at(-1)?.id ?? null, stage: detail?.stage,
    ...superhub ? { brainScope: superhub.brainScope, contractVersion: superhub.contracts.at(-1)?.version } : {},
  }
}
