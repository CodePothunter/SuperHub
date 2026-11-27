import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import type { IntakeContext } from '../core/superhub-intake.ts'
import type { ChatMessage } from './chat.ts'
import type { Agent, SessionEventLike } from './ports.ts'

export const INITIAL_LIAISON_TRACE = 'initial'

export interface LiaisonSegment {
  id: string
  offset: number
}

export interface LiaisonTraceBinding {
  segments: LiaisonSegment[]
  archived: ChatMessage[]
}

export interface LiaisonTraceSnapshot {
  segments: LiaisonSegment[]
  messages: ChatMessage[]
  observedAt: number
}

export interface LiaisonEditRequest {
  sessionId: string
  requestId: string
  expectedTraceId: string
  text: string
}

export interface LiaisonEdit {
  request: LiaisonEditRequest
  originalMessageId: string
  traceId: string
  /** Also serves as the stable native request ID for admitting the revised words. */
  messageId: string
  at: number
  phase: 'preparing' | 'ready' | 'sending' | 'accepted'
  nativeId?: string
  context?: IntakeContext
  readOnly?: true
  attachments: ChatInputAttachment[]
}

interface TraceFile {
  schema: 1
  sessionId: string
  activeTraceId: string
  binding?: LiaisonTraceBinding
  frozen: Record<string, LiaisonTraceSnapshot>
  edits: LiaisonEdit[]
}

/** The trace pointer, immutable old transcript and delivery receipt commit together. */
export class LiaisonTraces {
  private state: TraceFile
  private knownNativeIds?: Set<string>

  constructor(private readonly file: string, sessionId: string) {
    try {
      const state = JSON.parse(readFileSync(file, 'utf8')) as TraceFile
      if (state.schema !== 1 || !state.sessionId || !state.frozen || !Array.isArray(state.edits)
        || typeof state.activeTraceId !== 'string' || state.activeTraceId !== INITIAL_LIAISON_TRACE && !state.binding?.segments.length) {
        throw Error('接口人的续写记录与当前对话不匹配')
      }
      this.state = state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = { schema: 1, sessionId, activeTraceId: INITIAL_LIAISON_TRACE, frozen: {}, edits: [] }
    }
  }

  get activeTraceId() { return this.state.activeTraceId }
  get sessionId() { return this.state.sessionId }
  get binding() { return this.state.binding }
  edit(requestId: string) { return this.state.edits.find(row => row.request.requestId === requestId) }
  activeEdit() { return this.state.edits.find(row => row.traceId === this.state.activeTraceId) }
  snapshot(traceId: string) { return Object.hasOwn(this.state.frozen, traceId) ? this.state.frozen[traceId] : undefined }
  revision(requestId: string) { return this.state.edits.find(row => row.messageId === requestId && row.phase !== 'preparing')?.messageId }
  hasRequest(requestId: string) {
    return this.state.edits.some(edit => edit.phase !== 'preparing' && edit.messageId === requestId)
      || Object.values(this.state.frozen).some(trace => trace.messages.some(message => message.requestId === requestId))
  }
  snapshots() { return Object.entries(this.state.frozen) }
  nativeIds(): ReadonlySet<string> {
    return this.knownNativeIds ??= new Set([...this.state.binding?.segments.map(segment => segment.id) ?? [],
      ...Object.values(this.state.frozen).flatMap(trace => trace.segments.map(segment => segment.id)),
      ...this.state.edits.flatMap(edit => edit.nativeId ? [edit.nativeId] : [])])
  }

  private save(next: TraceFile) {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
    renameSync(tmp, this.file)
    this.state = next
    this.knownNativeIds = undefined
  }

  private editsWith(edit: LiaisonEdit) {
    const prior = this.edit(edit.request.requestId)
    return prior ? this.state.edits.map(row => row === prior ? edit : row) : [...this.state.edits, edit]
  }

  record(edit: LiaisonEdit, binding = this.state.binding) { this.save({ ...this.state, binding, edits: this.editsWith(edit) }) }

  publish(edit: LiaisonEdit, binding: LiaisonTraceBinding, snapshot: LiaisonTraceSnapshot) {
    const current = this.state.activeTraceId
    if (current !== edit.request.expectedTraceId) throw liaisonTraceConflict()
    this.save({ ...this.state, activeTraceId: edit.traceId, binding,
      frozen: { ...this.state.frozen, [current]: snapshot },
      edits: this.editsWith({ ...edit, phase: 'ready' }) })
  }

  rotate(binding: LiaisonTraceBinding) { this.save({ ...this.state, binding }) }
}

export const liaisonTraceConflict = () => liaisonEditError(409, '接口人对话已有新版本，请刷新后核对原话')
export const liaisonEditError = (status: number, message: string) => Object.assign(new Error(message), { status })

type NativeInput = { source?: { kind?: string; rpcId?: string }; content?: { type?: string; text?: string }[] }
const isRequest = (data: unknown, requestId: string) => {
  const source = (data as NativeInput | undefined)?.source
  return source?.kind === 'user' && source.rpcId === requestId
}
const inserted = (data: unknown): unknown[] => {
  const items = (data as { inserted?: unknown } | undefined)?.inserted
  return Array.isArray(items) ? items : []
}

/** A normal segment rotation can carry recent workspace references without copying model or connector context. */
export function workspaceCarryEvents(events: readonly SessionEventLike[]): SessionEventLike[] {
  const toolCalls = new Set<string>()
  const allowedMeta = ['dsh-chief/workspace', 'dsh-chief/workspace-origin', 'dsh-chief/workspace-choices']
  const retained: SessionEventLike[] = []
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'agent/inbox/spliced') {
      const data = event.data as ({id?: string; target?: string} & NativeInput) | undefined
      const inputs = event.type === 'user/message' ? [data] : data?.target !== 'next-turn' ? inserted(data) as (({id?: string} & NativeInput) | undefined)[] : []
      for (const [index, input] of inputs.entries()) {
        if (input?.source?.kind !== 'user' || !input.source.rpcId || !Array.isArray(input.content)) continue
        const content = input.content.flatMap((block): {type: string; text?: string}[] => {
          if (block.type === 'text' && typeof block.text === 'string') return [{type:'text',text:block.text}]
          return block.type === 'image' || block.type === 'file' ? [{type:block.type}] : []
        })
        const id = input.id ?? (event.type === 'user/message' ? String(event.seq) : `${event.seq}:${index}`)
        retained.push({type:'user/message',seq:event.seq,time:event.time,data:{id,source:{kind:'user',rpcId:input.source.rpcId},content}})
      }
    } else if (event.type === 'tool/call') {
      const data = event.data as {name?: string; callId?: string} | undefined
      if (data?.callId && (data.name === 'chief_workspace' || data.name === 'chief_staff')) {
        toolCalls.add(data.callId)
        retained.push({type:event.type,seq:event.seq,time:event.time,data:{name:data.name,callId:data.callId}})
      }
    } else if (event.type === 'tool/result') {
      const data = event.data as {message?: {toolCallId?: string; isError?: boolean}; meta?: Record<string, unknown>} | undefined
      const callId = data?.message?.toolCallId
      if (!callId || !toolCalls.has(callId) || data?.message?.isError) continue
      const meta = Object.fromEntries(allowedMeta.filter(key => data?.meta?.[key] !== undefined).map(key => [key,data?.meta?.[key]]))
      if (Object.keys(meta).length) retained.push({type:event.type,seq:event.seq,time:event.time,data:{message:{toolCallId:callId},meta}})
    }
  }
  let humanMessages = 0
  const start = retained.findLastIndex(event => event.type === 'user/message' && ++humanMessages === 8)
  return retained.slice(Math.max(0, start))
}

/** An inbox insertion remains a durable acknowledgement even if it was later claimed or cancelled. */
export function liaisonAccepted(agent: Agent, requestId: string, includeCancelled = false) {
  return agent.inbox?.nextStep.some(message => isRequest(message, requestId))
    || agent.inbox?.nextTurn.some(message => isRequest(message, requestId))
    || agent.session?.snapshotEvents().some(event => event.type === 'user/message' && isRequest(event.data, requestId)
      || includeCancelled && event.type === 'agent/inbox/spliced' && inserted(event.data).some(message => isRequest(message, requestId)))
}

/** Locate the input and cut before its model-visible context. Native fork includes atSeq. */
export function liaisonForkPrefix(events: readonly SessionEventLike[], nativeSeq: number, message: ChatMessage) {
  const index = events.findIndex(event => event.seq === nativeSeq && event.type === 'user/message')
  if (index < 0 || !message.requestId || !isRequest(events[index]!.data, message.requestId)) {
    throw liaisonEditError(409, '这条消息缺少可核对的原始输入')
  }
  const content = (events[index]!.data as NativeInput).content ?? []
  const text = content.filter(block => block.type === 'text').map(block => block.text ?? '')
  if (text.join('\n\n') !== message.text) throw liaisonEditError(409, '这条消息的原话与快照不一致')
  if (content.filter(block => block.type === 'file' || block.type === 'image').length !== (message.inputAttachments?.length ?? 0)) {
    throw liaisonEditError(409, '这条消息的原始附件不可核对')
  }
  let cut = index
  const step = events.findLastIndex((event, at) => at < index && ['step/start', 'turn/start', 'user/message'].includes(event.type)
    && (event.type !== 'user/message' || (event.data as NativeInput | undefined)?.source?.kind === 'user'))
  if (step >= 0 && events[step]?.type === 'step/start') cut = step
  const queue = events.findIndex((event, at) => at < cut && event.type === 'agent/inbox/spliced'
    && inserted(event.data).some(input => isRequest(input, message.requestId!)))
  // If this input was queued before earlier visible replies, retain those replies.
  if (queue >= 0 && !events.slice(queue, cut).some(event => event.type === 'assistant/message'
    || event.type === 'tool/result' || event.type === 'user/message' && (event.data as NativeInput | undefined)?.source?.kind === 'user')) cut = queue
  return { events: events.slice(0, cut), text: text.join('\n') }
}
