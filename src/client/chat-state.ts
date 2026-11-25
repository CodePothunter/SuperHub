import type { ChatMessage } from '../dsh/chat.ts'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'

export interface PendingMessage { id: number; text: string; time: number; afterSeq: number; requestId?: string; inputAttachments?: ChatInputAttachment[] }

/** 每个新用户事件只确认一条乐观消息；同文历史、连续重复发送都不会提前消失。 */
export function reconcilePending(pending: readonly PendingMessage[], messages: readonly ChatMessage[]): PendingMessage[] {
  const users = messages.filter(m => m.role === 'you').sort((a, b) => a.seq - b.seq)
  const used = new Set<number>()
  const latest = users.reduce((seq, m) => Math.max(seq, m.seq), -1)
  return pending.flatMap(p => {
    const found = users.find(m => {
      if (used.has(m.seq)) return false
      if (p.requestId) return p.requestId === m.requestId
      const refs = p.inputAttachments ?? [], received = m.inputAttachments ?? []
      return m.seq > p.afterSeq && m.text === p.text && refs.length === received.length && refs.every((ref, i) => ref.id === received[i]?.id)
    })
    if (found) { used.add(found.seq); return [] }
    return [{ ...p, afterSeq: Math.max(p.afterSeq, latest) }]
  })
}
