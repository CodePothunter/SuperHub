import { realpathSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import type { V2Message } from '../core/workspace-v2.ts'
import type { Agent, HostContext, NativeTeamMember, NativeTeams, SessionEventLike } from './ports.ts'
import { beforeDispatch } from './workspace-v2-coding.ts'
import { dialogueKey, groupPrefix, groupLeadId, workspaceSpeakerId } from './workspace-speaker-id.ts'

export { dialogueKey } from './workspace-speaker-id.ts'
export const ownerMessageId = (session: string, requestId: string) => 'u-' + dialogueKey(session, requestId).slice(0, 32)
export interface GroupMember { id: string; name: string }
type Event = SessionEventLike
type Input = { id?: string; content?: unknown; source?: { kind?: string; rpcId?: string; senderSessionId?: string } }
type Source = { id: string; name: string; events: readonly Event[] }
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const speech = (v: unknown) => Array.isArray(v) ? v.map(obj).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : ''
const teamTools = ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent']

/** Match an owner RPC actually claimed by the loop to the end of that same native turn. */
export function groupOutcome(events: readonly Event[], request: string): 'done' | 'incomplete' | undefined {
  const claimed = events.findIndex(e => e.type === 'user/message' && obj(obj(e.data).source).kind === 'user' && obj(obj(e.data).source).rpcId === request)
  if (claimed < 0) return
  const start = events.slice(0, claimed).findLast(e => e.type === 'turn/start')
  if (!start || typeof obj(start.data).turn !== 'number') return
  const end = events.slice(claimed + 1).find(e => e.type === 'turn/end' || e.type === 'turn/start')
  if (end?.type !== 'turn/end' || obj(end.data).turn !== obj(start.data).turn) return
  return obj(obj(end.data).reason).kind === 'completed' ? 'done' : 'incomplete'
}

/** DSH inbox provenance identifies the speaker. A teammate's scratch transcript is private. */
export function groupSpeech(lead: string, sources: Source[], orders?: ReadonlyMap<string, string>, canonical = lead): V2Message[] {
  const names = new Map(sources.map(s => [s.id, s.name]))
  const rows: V2Message[] = [], ids = new Set<string>(), aliases = new Map<string, string>()
  const display = (id: string) => id === lead ? '讨论接口人' : names.get(id)!
  for (const source of sources) {
    let inTurn = false, claimed: string | null | undefined
    const add = (event: Event, suffix: string, text: string, sender: string, ownerId?: string, messageId?: string) => {
      if (!text.trim() || !Number.isFinite(event.time)) return
      const raw = source.id + ':' + event.seq + suffix
      const id = ownerId ? ownerMessageId(canonical, ownerId) : 'g-' + dialogueKey(lead, source.id, messageId || raw).slice(0, 32)
      aliases.set(raw, id)
      if (ids.has(id)) return
      ids.add(id)
      const request = ownerId ?? (sender === lead && source.id === lead && event.type === 'assistant/message' ? claimed : undefined)
      const workOrderId = request && orders?.get(request)
      rows.push({ id, role: ownerId ? 'user' : 'agent', author: ownerId ? '你' : display(sender), text, at: new Date(event.time).toISOString(),
        speakerId: ownerId ? 'owner' : workspaceSpeakerId(lead, 'native-member', sender),
        ...(workOrderId && {workOrderId}) })
    }
    const input = (event: Event, suffix: string, msg: Input) => {
      if (!msg || !msg.source) return
      const text = speech(msg.content), meta = msg.source
      if (meta.kind === 'user' && meta.rpcId && source.id === lead) add(event, suffix, text, lead, meta.rpcId)
      else if (meta.kind === 'agent-message' && meta.senderSessionId && names.has(meta.senderSessionId)) {
        const frame = 'Team message from ' + names.get(meta.senderSessionId) + ':\n'
        add(event, suffix, text.startsWith(frame) ? text.slice(frame.length) : text, meta.senderSessionId, undefined, msg.id)
      }
    }
    for (const event of source.events) {
      const data = obj(event.data)
      if (event.type === 'turn/start' || event.type === 'turn/end') { inTurn = event.type === 'turn/start'; claimed = undefined }
      if (inTurn && event.type === 'user/message' && obj(data.source).kind === 'user') {
        const rpc = obj(data.source).rpcId
        // Owner words steered into a turn belong to the same work order as the words that started it.
        const sameOrder = (a: string, b: string) => orders?.get(a) !== undefined && orders.get(a) === orders.get(b)
        if (typeof rpc === 'string') claimed = claimed === undefined || claimed === rpc ? rpc : claimed !== null && sameOrder(claimed, rpc) ? claimed : null
      }
      if (event.type === 'user/message') input(event, '', data)
      if (event.type === 'agent/inbox/spliced' && Array.isArray(data.inserted)) data.inserted.forEach((msg, i) => input(event, ':' + i, msg))
      if (event.type === 'assistant/message' && source.id === lead) add(event, '', speech(obj(data.message).content), lead)
    }
  }
  const owners = new Map(rows.filter(row => row.role === 'user').map(row => [row.id, row.workOrderId]))
  for (const row of rows) {
    if (row.role !== 'agent') continue
    const quoted = /^〔回复原话 "([^"\n]{1,240})"〕\n/.exec(row.text)
    if (!quoted) continue
    const ref = aliases.get(quoted[1]!) ?? quoted[1]!
    if (ids.has(ref) && ref !== row.id) {
      row.replyTo = ref
      row.text = row.text.slice(quoted[0].length)
      const order = owners.get(ref)
      if (!row.workOrderId && order) row.workOrderId = order
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at))
}

/** `allowed`: owner words steered into this turn (RPC id → text), admitted by the pre-step filter like the request. */
interface ExperienceTurn {
  canonical: string
  validate(): void
  confirmed(memberId: string): void
}
type LiveTurn = { request: string; text: string; instructions: string; limit: number; allowed: Map<string, string>; signal: AbortSignal;
  experience?: ExperienceTurn; projected: Set<string>; recorded: Set<string> }
/** Owner RPC ids the lead's session took: spliced into a step or claimed as a user message. */
function takenRequests(events: readonly Event[]): Set<string> {
  const taken = new Set<string>()
  const add = (msg: unknown) => {
    const source = obj(obj(msg).source)
    if (source.kind === 'user' && typeof source.rpcId === 'string') taken.add(source.rpcId)
  }
  for (const event of events) {
    const data = obj(event.data)
    if (event.type === 'user/message') add(data)
    if (event.type === 'agent/inbox/spliced' && Array.isArray(data.inserted)) data.inserted.forEach(add)
  }
  return taken
}
// A native agent may outlive its brain runtime. Its own Cordis scope keeps this mask and guard
// until the agent is disposed. A later runtime can bind the same live session to its current turn.
const pinned = new WeakMap<Agent, {current: () => LiveTurn | undefined}>()
export class WorkspaceGroups {
  private readonly active = new Map<string, LiveTurn>()
  private readonly attached = new WeakSet<Agent>()
  private readonly releases: (() => void)[] = []
  private readonly guarded: boolean
  private readonly prefix: string
  constructor(private readonly ctx: HostContext, private readonly scope: string) {
    this.prefix = groupPrefix(scope)
    const guard = ctx.tools?.guard?.(execution => {
      if (!execution.agent) return
      const root = this.rootOf(execution.agent.id)
      if (!root) return
      const turn = this.active.get(root), teams = ctx.get('agentTeams')
      if (!turn || !teams || !teamTools.includes(execution.name)) return '这场讨论只可在本群内协作。'
      try { turn.experience?.validate() } catch { return '这场讨论的经验授权已改变，请重新开始本轮。' }
      const actor = ctx.agents.get(execution.agent.id) as unknown as Agent | undefined
      if (!actor || teams.tryMembership(actor)?.root.id !== root) return '发言者还未加入本群。'
      if (turn.limit-- <= 0) return '本轮讨论已达到协作次数上限，请用现有消息回答。'
      if (execution.name === 'spawn_teammate') {
        const lead = ctx.agents.get(root) as unknown as Agent | undefined
        if (execution.agent.id !== root || !lead || teams.listMembers(lead).length >= 4) return '本群已有参与者，请由接口人协调现有成员。'
      }
    })
    if (guard) this.releases.push(guard)
    // The outer native waterfall runs after ordinary DSH hooks have proposed their input.
    // Admit the owner's bound RPC and this group's participants, including only their own
    // native settlement notices. Global project instructions and other inbox injections stay out.
    const preStep = ctx.on?.('agent/pre-step', async ({agent}, next) => {
      const root = this.rootOf(agent.id, agent)
      if (!root) return next()
      const turn = this.active.get(root)
      if (!turn) return {kind: 'reject'}
      const result = await next()
      if (result.kind === 'reject' || this.active.get(root) !== turn) return {kind: 'reject'}
      try { turn.experience?.validate() } catch { return {kind:'reject'} }
      const teams = ctx.get('agentTeams'), member = teams?.tryMembership(agent)
      if (!teams || member?.root.id !== root) return {kind: 'reject'}
      const ids = new Set(teams.listMembers(member.root).map(m => m.id))
      return {...result, messages: result.messages.filter(message => {
        const source = message.source
        if (source?.kind === 'user') return agent.id === root
          ? source.rpcId === turn.request && speech(message.content) === turn.text
            || !!source.rpcId && turn.allowed.has(source.rpcId) && turn.allowed.get(source.rpcId) === speech(message.content)
          : !source.rpcId
        return (source?.kind === 'agent-message' || source?.kind === 'subagent-settled') && !!source.senderSessionId && ids.has(source.senderSessionId)
      })}
    }, {prepend: true})
    if (preStep) this.releases.push(preStep)
    const created = ctx.on?.('agent/created', ({agent}) => { const root = this.rootOf(agent.id, agent); if (root) this.attach(agent, root) })
    if (created) this.releases.push(created)
    const reported = ctx.on?.('session/event', (session,event) => {
      if (event.type !== 'assistant/message' && event.type !== 'tool/call') return
      const root = this.rootOf(session.id)
      const turn = root && this.active.get(root)
      if (!turn || !turn.experience || !turn.projected.has(session.id) || turn.recorded.has(session.id)) return
      turn.recorded.add(session.id)
      turn.experience.confirmed(session.id)
    })
    if (reported) this.releases.push(reported)
    this.guarded = !!guard && !!created && !!preStep
    for (const agent of ctx.agents?.list?.() || []) {
      const root = this.rootOf(agent.id, agent)
      if (root) this.attach(agent, root)
    }
  }
  leadId(workspace: string, session: string) { return groupLeadId(this.scope,workspace,session) }
  available() { return this.guarded && !!this.ctx.get('agentTeams') && !!this.ctx.sessionController && !!this.ctx.workspaceRegistry && !!this.ctx.get('workingDirectory') }
  private rootOf(id: string, agent?: Agent): string | undefined {
    if (id.startsWith(this.prefix)) return id
    const live = agent || this.ctx.agents.get(id) as unknown as Agent | undefined
    const root = live && this.ctx.get('agentTeams')?.tryMembership(live)?.root.id
    if (root?.startsWith(this.prefix)) return root
    // The agent/created hook can run before team enrollment. Its persisted parent binds that interval.
    const parent = this.ctx.agents.get(id)?.session?.header?.parentSession
    if (parent?.startsWith(this.prefix)) return parent
  }
  private attach(agent: Agent, root: string) {
    if (this.attached.has(agent)) return
    const active = this.active
    const current = () => active.get(root)
    const existing = pinned.get(agent)
    if (existing) { existing.current = current; this.attached.add(agent); return }
    if (!agent.ctx?.tools?.guard || !agent.ctx.systemPrompt) return
    const binding = { current }
    // Native team tools are agent-scoped. DSH's allow filter accepts only global tool names.
    agent.ctx.tools.restrict({allow: []})
    agent.ctx.tools.guard(call => !binding.current() || !teamTools.includes(call.name) ? '这场讨论只可在获准回合内使用本群工具。' : undefined)
    agent.ctx.systemPrompt.section({name: 'superhub-v2-group', order: 80, interpolate: false, text: () => {
      const turn = binding.current()
      if (!turn) return '这场工作区讨论当前没有已派发的回合。'
      turn.experience?.validate()
      if (turn.experience) turn.projected.add(agent.id)
      return turn.instructions
    }})
    pinned.set(agent, binding)
    this.attached.add(agent)
  }
  async prepare(root: string, cwd: string, title: string, signal: AbortSignal, bound: boolean) {
    const teams = this.ctx.get('agentTeams')
    if (!this.available() || !teams) throw beforeDispatch('DSH 群聊来源暂不可用。')
    let result = await this.ctx.sessionController.resolveAgent(root)
    signal.throwIfAborted()
    if (!('error' in result) && !bound && result.agent.session?.snapshotEvents().some(e => e.type === 'turn/start' || e.type === 'user/message' || e.type === 'assistant/message')) {
      throw beforeDispatch('该原生群已有未绑定的对话。请新开一场群聊。')
    }
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await this.ctx.workspaceRegistry.create(cwd, title)
      signal.throwIfAborted()
      await this.ctx.sessionController.create({sessionId: root, workspaceId: workspace.id, title})
      signal.throwIfAborted()
      result = await this.ctx.sessionController.resolveAgent(root)
      signal.throwIfAborted()
    }
    if ('error' in result || result.agent.id !== root) throw beforeDispatch('当前群聊的原生会话不可用。')
    const actual = result.agent.session && this.ctx.get('workingDirectory')?.get(result.agent.session)
    if (!actual || realpathSync(actual) !== cwd) throw beforeDispatch('原生群聊的工作目录不属于本场会话。')
    this.attach(result.agent, root)
    if (!this.attached.has(result.agent)) throw beforeDispatch('DSH 宿主未提供本群的独立工具范围。')
    for (const m of teams.listMembers(result.agent)) {
      const agent = this.ctx.agents.get(m.id) as unknown as Agent | undefined
      if (agent && m.id !== root) this.attach(agent, root)
    }
    return {lead: result.agent, teams}
  }
  private async events(member: GroupMember, signal: AbortSignal): Promise<readonly Event[]> {
    const query = this.ctx.get('sessionQuery')
    if (query?.observeSession) {
      const view = await query.observeSession(member.id, {signal, projectionMode: 'none'})
      try {
        if (view.header?.id !== undefined && view.header.id !== member.id) throw new Error('群成员来源不匹配。')
        return view.events.slice(view.inheritedEventCount ?? 0)
      } finally { view[Symbol.dispose]() }
    }
    const agent = this.ctx.agents.get(member.id) as unknown as Agent | undefined
    if (agent?.id !== member.id || !agent.session) throw new Error('群成员的历史发言暂不可读。')
    return agent.session.snapshotEvents()
  }
  async observe(lead: string, members: GroupMember[], signal: AbortSignal, orders?: ReadonlyMap<string, string>, canonical = lead) {
    const sources = await Promise.all(members.map(async m => ({...m, events: await this.events(m, signal)})))
    return {messages: groupSpeech(lead, sources, orders, canonical), events: sources.find(s => s.id === lead)?.events ?? []}
  }
  idleMembers(root: string, cwd: string) {
    const lead = this.ctx.agents?.get(root) as unknown as Agent | undefined
    const teams = this.ctx.get('agentTeams')
    if (!lead?.session || !teams || teams.tryMembership(lead)?.root.id !== root) return
    const dir = this.ctx.get('workingDirectory')?.get(lead.session)
    if (!dir || realpathSync(dir) !== cwd) return
    const members = teams.listMembers(lead)
    if (!members.every(m => m.status === 'inactive' || m.status === 'failed')) return
    return members.map(({id,name}) => ({id,name}))
  }
  /**
   * Steer owner words into the lead's running turn of `request`. Only while that turn runs and the lead is working: an
   * idle DSH session would open a new native turn instead. `pending` until the turn ends (`run` settles it).
   */
  async steer(root: string, request: string, id: string, text: string): Promise<'pending' | 'rejected'> {
    const turn = this.active.get(root)
    const lead = this.ctx.agents.get(root) as unknown as Agent | undefined
    if (!turn || turn.request !== request || turn.signal.aborted || lead?.status !== 'running') return 'rejected'
    turn.allowed.set(id, text)
    try {
      await this.ctx.sessionController.prompt({requestId: id, sessionId: root, mode: 'steer', content: [{type: 'text', text}]}, turn.signal)
    } catch {
      turn.allowed.delete(id)
      return 'rejected'
    }
    return 'pending'
  }
  /**
   * Which steered words the lead took. Words not taken leave the inbox, so they can go to the next turn without being
   * filtered out or opening a native turn of their own later.
   */
  private async settle(lead: Agent, turn: LiveTurn, settled: Map<string, boolean>) {
    const ids = [...turn.allowed.keys()]
    if (!ids.length) return
    // From here on the pre-step drops them; a step already past the filter shows up in the session events.
    turn.allowed.clear()
    const taken = async () => {
      try { return takenRequests(await this.events({id: lead.id, name: 'lead'}, AbortSignal.timeout(2000))) }
      catch { return new Set<string>() }
    }
    let seen = await taken()
    const removed = new Set<string>()
    for (const item of [...(lead.inbox?.nextStep ?? []), ...(lead.inbox?.nextTurn ?? [])]) {
      const rpc = item.source?.rpcId
      if (rpc && ids.includes(rpc) && !seen.has(rpc) && lead.inbox?.remove(item.id)) removed.add(rpc)
    }
    if (ids.some(id => !seen.has(id) && !removed.has(id))) {
      await delay(400)
      seen = await taken()
    }
    for (const id of ids) settled.set(id, seen.has(id) && !removed.has(id))
  }
  async run(lead: Agent, teams: NativeTeams, request: string, text: string, instructions: string, signal: AbortSignal,
    update: (messages: V2Message[], members: GroupMember[]) => void, orders?: ReadonlyMap<string, string>, settled = new Map<string, boolean>(),
    experience?: ExperienceTurn) {
    const root = lead.id
    let stopped = false
    const cancel = () => {
      if (stopped) return
      stopped = true
      for (const m of teams.listMembers(lead)) {
        const agent = this.ctx.agents.get(m.id) as unknown as Agent | undefined
        const binding = agent && teams.tryMembership(agent)
        if (m.id !== root && binding && binding.root.id !== root) continue
        for (const item of [...(agent?.inbox?.nextStep ?? []), ...(agent?.inbox?.nextTurn ?? [])]) agent?.inbox?.remove(item.id)
        agent?.cancel?.({kind: 'hook', reason: '本轮工单已停止'}, {keepInbox: false})
      }
    }
    const live: LiveTurn = {request, text, instructions, limit: 32, allowed: new Map(), signal, experience, projected:new Set(), recorded:new Set()}
    this.active.set(root, live)
    signal.addEventListener('abort', cancel, {once: true})
    try {
      signal.throwIfAborted()
      experience?.validate()
      await this.ctx.sessionController.prompt({requestId: request, sessionId: root, mode: 'queue', content: [{type:'text', text}]}, signal)
      while (!signal.aborted) {
        const members: NativeTeamMember[] = teams.listMembers(lead)
        // The roster announces a teammate before its native session exists. Keep it in the
        // completion barrier, and start reading its history once provisioning has finished.
        const readable = members.filter(member => {
          if (member.status !== 'provisioning' || member.role !== 'teammate' || member.id === root) return true
          const agent = this.ctx.agents.get(member.id) as unknown as Agent | undefined
          const binding = agent && teams.tryMembership(agent)
          if (teams.tryMembership(lead)?.root.id !== root || binding && binding.root.id !== root) throw new Error('群成员的原生归属不匹配。')
          return false
        })
        const observed = await this.observe(root, readable, signal, orders, experience?.canonical)
        signal.throwIfAborted()
        experience?.validate()
        update(observed.messages, readable.map(({id, name}) => ({id, name})))
        // An enqueued (spliced) prompt may still belong to a future turn. Settle only its claimed input.
        const outcome = groupOutcome(observed.events, request)
        if (outcome && members.every(m => m.status === 'inactive' || m.status === 'failed')) {
          await this.settle(lead, live, settled)
          if (outcome !== 'done') throw new Error('讨论在回复完成前中断。')
          return
        }
        await delay(350, undefined, {signal})
      }
      signal.throwIfAborted()
    } catch (error) {
      cancel()
      // Words still waiting were removed with the inbox; anything the lead took stays taken.
      if (live.allowed.size) await this.settle(lead, live, settled).catch(() => {})
      throw error
    } finally { this.active.delete(root); signal.removeEventListener('abort', cancel) }
  }
  dispose() { this.active.clear(); for (const release of this.releases.splice(0).reverse()) release() }
}
