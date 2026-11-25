/**
 * 「一句话交办」的未读：主人上次看过接口人对话之后，接口人新说的话和新到的提醒。
 * 服务端计数与弹窗显示共用同一套口径（纯函数，网页和手机的客户端也直接引用）。
 */

/** 接口人对话里一条看得见的发言：有正文，或带讨论、工作区、资料导入回执。 */
export interface LiaisonSpeechLike {
  text?: string
  discussions?: readonly unknown[]
  workspaces?: readonly unknown[]
  profileImports?: readonly unknown[]
  inputAttachments?: readonly unknown[]
}
export const hasPublicReply = (reply: LiaisonSpeechLike) =>
  !!(reply.text || reply.inputAttachments?.length || reply.discussions?.length || reply.workspaces?.length || reply.profileImports?.length)

/** 显示在接口人对话里的提醒：旧版工单的提醒（带 ticketId）不在这里。 */
export const liaisonNotice = (notice: { ticketId?: string }) => !notice.ticketId

export interface UnreadSource {
  messages: readonly (LiaisonSpeechLike & { role: 'you' | 'liaison'; time: number; lastTime?: number })[]
  notices: readonly { at: string; ticketId?: string; done?: boolean }[]
  discussionResults?: readonly { at: string }[]
}

/**
 * 未读数 = seenAt 之后接口人落定的公开回复（进行中的一轮不算，落定后按最后一次更新的时间算）
 * + 讨论回报 + 仍待处理的提醒。
 */
export function liaisonUnread(view: UnreadSource, seenAt: number): { unread: number; latestAt?: string } {
  const times: number[] = []
  for (const message of view.messages) {
    if (message.role !== 'liaison' || !hasPublicReply(message)) continue
    const at = Math.max(message.time, message.lastTime ?? message.time)
    if (at > seenAt) times.push(at)
  }
  for (const result of view.discussionResults ?? []) {
    const at = Date.parse(result.at)
    if (at > seenAt) times.push(at)
  }
  for (const notice of view.notices) {
    const at = Date.parse(notice.at)
    if (liaisonNotice(notice) && !notice.done && at > seenAt) times.push(at)
  }
  const latest = times.length ? Math.max(...times) : undefined
  return { unread: times.length, ...latest !== undefined && { latestAt: new Date(latest).toISOString() } }
}

/** 徽标上的数字：超过 99 显示 99+，0 不显示。 */
export const unreadBadge = (count: number): string | undefined => count > 0 ? count > 99 ? '99+' : String(count) : undefined
