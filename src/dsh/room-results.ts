import { createHash } from 'node:crypto'
import type { SessionEventLike } from './ports.ts'

export interface DiscussionReceipt { id: string; title: string; requestId?: string }
export type RoomResultStatus = 'partial' | 'ready'
export interface RoomResult { id: string; requestId: string; source: string; text: string; at: string; status: RoomResultStatus }
export interface DiscussionResult {
  id: string
  roomId: string
  title: string
  text: string
  at: string
  status: RoomResultStatus | 'historical'
}

export const liaisonRoomRequest = /^liaison-[a-f0-9]{64}$/
export const roomResultTextLimit = 8000
export const roomResultId = (session: string, requestId: string, status: DiscussionResult['status']) =>
  'room-result-' + createHash('sha256').update(JSON.stringify([session, requestId, status])).digest('hex').slice(0, 32)

interface NativeInput {
  id?: string
  source?: { kind?: string; rpcId?: string; senderSessionId?: string }
  content?: unknown
}

export const roomText = (content: unknown): string => Array.isArray(content)
  ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''

function* roomInputs(events: readonly SessionEventLike[]) {
  const seen = new Set<string>()
  for (const event of events) {
    const data = event.data as NativeInput & { inserted?: NativeInput[] } | undefined
    const inputs = event.type === 'user/message' ? [data] : event.type === 'agent/inbox/spliced' ? data?.inserted ?? [] : []
    for (const [index, input] of inputs.entries()) {
      if (!input?.source || input.id && seen.has(input.id)) continue
      if (input.id) seen.add(input.id)
      const suffix = event.type === 'agent/inbox/spliced' ? ':' + index : ''
      yield { event, input, suffix }
    }
  }
}

/** The IDs are the same ones returned by projectRoomMessages. Look at the native source, not the message body. */
export function roomOwnerInputs(session: string, events: readonly SessionEventLike[]) {
  return [...roomInputs(events)].flatMap(({ event, input, suffix }) => {
    if (input.source?.kind !== 'user' || typeof input.source.rpcId !== 'string' || !input.source.rpcId) return []
    return [{ source: `${session}:${event.seq}${suffix}`, requestId: input.source.rpcId, text: roomText(input.content) }]
  })
}

/** Before result receipts were available, only a newly created room has a provable request ID. */
export function historicalRoomResult(events: readonly SessionEventLike[], room: {id: string; title: string; session: string}, teammateIds: ReadonlySet<string>): DiscussionResult | undefined {
  let started = false
  let hasReport = false
  let reply: { text: string; time: number } | undefined
  let last: typeof reply
  for (const event of events) {
    if (event.type === 'user/message') {
      // Queued inbox entries are already visible in the room UI, but only consumed
      // messages can be evidence for what the lead answered in this turn.
      const input = event.data as NativeInput | undefined
      const source = input?.source
      if (source?.kind === 'user' && source.rpcId) {
        // The first native owner input must be this handoff. A new owner input ends its window.
        if (source.rpcId !== room.id) return started ? result() : undefined
        started = true
      }
      if (started && source?.kind === 'agent-message' && teammateIds.has(source.senderSessionId ?? '') && roomText(input?.content).trim()) {
        hasReport = true
        reply = undefined
      }
    }
    if (!started) continue
    if (event.type === 'assistant/message' && hasReport) {
      const data = event.data as { message?: { content?: { type: string }[] } } | undefined
      const content = data?.message?.content
      const text = roomText(content).trim()
      if (text && !content?.some(block => block.type === 'tool-call')) reply = { text, time: event.time }
    }
    if (event.type === 'tool/call') reply = undefined
    if (event.type === 'turn/end') {
      const data = event.data as { reason?: { kind?: string } } | undefined
      if (data?.reason?.kind === 'completed' && reply) last = reply
      hasReport = false
      reply = undefined
    }
  }
  return result()

  function result(): DiscussionResult | undefined {
    if (!last || !Number.isFinite(last.time)) return
    const { id, title, session } = room
    const text = last.text.length > roomResultTextLimit ? last.text.slice(0, roomResultTextLimit - 1) + '…' : last.text
    return { id: roomResultId(session, id, 'historical'), roomId: id, title, text, at: new Date(last.time).toISOString(), status: 'historical' }
  }
}
