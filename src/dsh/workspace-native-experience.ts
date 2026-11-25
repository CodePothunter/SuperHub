import { renderExperience, type ExperienceDeliveryTarget, type ExperienceQuery, type ExperienceSelection,
  type WorkspaceExperiencePort } from '../core/workspace-experience.ts'
import type { LlmToolRequest, SessionEventLike, StepDecision } from './ports.ts'
import { nativeIntakeSource } from './superhub.ts'

const BINDING = '〔SuperHub 经验版本〕'

/** Associate the prompt rendered by the native host with the request that actually carries it. */
export class NativeExperience {
  private readonly pending = new Map<string, {selection: ExperienceSelection; target: ExperienceDeliveryTarget; text: string; stale: boolean}>()
  private readonly input = new Map<string, NonNullable<ReturnType<typeof nativeIntakeSource>>>()

  constructor(private readonly port: WorkspaceExperiencePort, private readonly problem: (error: unknown) => void) {}

  prompt(sessionId: string, query: ExperienceQuery, target: ExperienceDeliveryTarget, events: readonly SessionEventLike[] = []): string {
    this.pending.delete(sessionId)
    const selection = this.port.selectExperience(query)
    const binding = BINDING + JSON.stringify(selection.entries.map(({id,version}) => [id, version]))
    const context = renderExperience(selection)
    const text = selection.entries.length ? binding + '\n' + context : context
    const stale = this.needsFreshHistory(events,query,selection)
    this.pending.set(sessionId, {selection, target, text, stale})
    return stale ? '' : text
  }

  clear(sessionId: string) { this.pending.delete(sessionId) }
  ownedInput(sessionId: string) { return this.input.get(sessionId) }
  finishTurn(sessionId: string) { this.pending.delete(sessionId); this.input.delete(sessionId) }

  needsFreshHistory(events: readonly SessionEventLike[], query: ExperienceQuery, selection?: ExperienceSelection): boolean {
    type Message = {content?: readonly {type: string; text?: string}[]; source?: {kind?: string}}
    const prior = events.flatMap(event => {
      const data = event.data as (Message & {message?: Message}) | undefined
      const message = event.type === 'system/message' ? data?.message : event.type === 'user/message' && data?.source?.kind === 'runtime-context' ? data : undefined
      return message?.content?.flatMap(block => block.type === 'text' && block.text ? block.text.split('\n') : []) ?? []
    }).filter(line => line.startsWith(BINDING))
    if (!prior.length) return false
    return this.containsRevoked(prior, selection ?? this.port.selectExperience(query))
  }

  private containsRevoked(bindings: readonly string[], selection: ExperienceSelection) {
    const allowed = new Set(selection.authorized.map(({id,version})=>JSON.stringify([id,version])))
    return bindings.some(line => {
      try { return (JSON.parse(line.slice(BINDING.length)) as unknown[]).some(ref => !allowed.has(JSON.stringify(ref))) }
      catch { return true }
    })
  }

  step(sessionId: string, decision: StepDecision, replaceSystemPrompt = false): StepDecision {
    if (decision.kind === 'reject') return decision
    const source = nativeIntakeSource(decision.messages.map((data, seq) => ({type:'user/message',time:Date.now(),seq,data})))
    if (source) this.input.set(sessionId,source)
    return replaceSystemPrompt ? {...decision, startsRequestSeries:true} : decision
  }

  request(options: LlmToolRequest, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> {
    if (!options.sessionId) return next()
    const pending = this.pending.get(options.sessionId)
    if (pending?.stale) throw Error('原生会话中留有当前范围不可用的经验，请为本次任务打开新会话。')
    const system = options.messages?.filter(message => message.role === 'system' || message.role === 'user' && message.source?.kind === 'runtime-context')
      .flatMap(message => message.content)
      .flatMap(block => block.type === 'text' && block.text ? [block.text] : []).join('\n') ?? options.system ?? ''
    const bindings = system.split('\n').filter(line => line.startsWith(BINDING))
    if (bindings.length && (!pending || this.containsRevoked(bindings,pending.selection))) throw Error('原生会话仍含已变化的经验，请重新开始本次任务。')
    if (!pending?.selection.entries.length || !system.includes(pending.text)) return next()
    const {selection, target} = pending
    this.port.assertExperienceCurrent(selection)
    const receipt = () => {
      try { this.port.recordExperienceDelivery(selection, target) } catch (error) { this.problem(error) }
    }
    return (async function* () {
      let taken = false
      for await (const chunk of next()) {
        const frame = chunk as {type?: string; reason?: {kind?: string}} | null
        if (!taken && (frame?.type === 'block-start' || frame?.type === 'text-delta' || frame?.type === 'tool-call-delta' ||
          frame?.type === 'finish' && frame.reason?.kind && !['error', 'aborted'].includes(frame.reason.kind))) {
          taken = true
          receipt()
        }
        yield chunk
      }
    })()
  }
}
