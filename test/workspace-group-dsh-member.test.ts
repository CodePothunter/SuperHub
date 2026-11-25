import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2CodingPermission } from '../src/core/workspace-v2.ts'
import type { ChatInputAttachment } from '../src/core/chat-attachments.ts'
import type { ExperienceEntry } from '../src/core/workspace-experience.ts'
import type { ChatAttachments } from '../src/dsh/chat-attachments.ts'
import { commandApprovals, type PendingCommand } from '../src/dsh/approvals.ts'
import { CodingGate, type Reviewer } from '../src/dsh/coding-gate.ts'
import type { Agent, HostContext, ModelSelection, NativeToolCall, PreToolDecision, SessionEventLike } from '../src/dsh/ports.ts'
import { DshMemberRunner, MEMBER_DENY, memberSessionId, memberSessionPrefix } from '../src/dsh/workspace-group-dsh-member.ts'
import { GroupMemberSessions, type GroupContext, type MemberCall, type MemberCallSink, type MemberFinish } from '../src/dsh/workspace-group-members.ts'

const roots: string[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-group-dsh-')); roots.push(p); return p }
const cleanups: (() => void)[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const fn of cleanups.splice(0)) fn()
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

interface FakeAgent extends Agent {
  cwd: string
  events: SessionEventLike[]
  appended: { type: string; data: unknown }[]
  sections: { name: string; text: () => string }[]
  restricted: string[][]
  selected: ModelSelection[]
  cancels: number
  status: 'idle' | 'running'
  inboxItems: { id: string; source: { kind: string; rpcId: string } }[]
}

type Listener = (...args: any[]) => any
const KNOWN_TOOLS = ['bash', 'read', 'write', 'ask_user_question', 'plugin_manager', 'subagent', 'subagent_fork', 'schedule_create', 'schedule_list', 'subagent_codex']

function fakeHost() {
  const listeners: Record<string, Listener[]> = {}
  const guards: ((execution: { name: string; agent?: { id: string } }) => string | undefined)[] = []
  const agents = new Map<string, FakeAgent>()
  const prompts: { requestId: string; sessionId: string; mode: string; text: string }[] = []
  const created: Record<string, unknown>[] = []
  const controllerCancels: string[] = []
  let seq = 0
  const selectModel = vi.fn(() => { throw new Error('must not change the profile default') })
  const makeAgent = (id: string, cwd: string): FakeAgent => {
    const agent: FakeAgent = {
      id, cwd, events: [], appended: [], sections: [], restricted: [], selected: [], cancels: 0, status: 'idle', inboxItems: [],
      session: { snapshotEvents: () => agent.events, append: (type: string, data: unknown) => { agent.appended.push({ type, data }) } },
      ctx: {
        systemPrompt: { section: section => { agent.sections.push({ name: section.name, text: section.text as () => string }); return () => {} } },
        tools: { restrict: filter => { agent.restricted.push([...filter.deny ?? []]); return () => {} } },
      },
      model: { current: () => agent.selected.at(-1), select: selection => { agent.selected.push(selection) } },
      get inbox() {
        return { nextStep: [], nextTurn: agent.inboxItems, remove: (id: string) => { const before = agent.inboxItems.length; agent.inboxItems = agent.inboxItems.filter(item => item.id !== id); return agent.inboxItems.length < before }, prepend: () => {} }
      },
      cancel: () => { agent.cancels++ },
    } as FakeAgent
    return agent
  }
  const emit = (sessionId: string, type: string, data: unknown = {}) => {
    const event = { type, seq: ++seq, time: Date.now(), data }
    agents.get(sessionId)!.events.push(event)
    for (const listener of listeners['session/event'] ?? []) listener({ id: sessionId }, event)
    return event
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    on: (name: string, listener: Listener) => { (listeners[name] ??= []).push(listener); return () => { listeners[name] = listeners[name]!.filter(l => l !== listener) } },
    tools: {
      guard: (fn: (typeof guards)[number]) => { guards.push(fn); return () => {} },
      get: (name: string) => KNOWN_TOOLS.includes(name) ? {} : undefined,
      schemas: () => KNOWN_TOOLS.map(name => ({ name })),
      register: () => () => {},
    },
    agents: { get: (id: string) => agents.get(id) },
    sessionController: {
      resolveAgent: async (id: string) => agents.has(id) ? { agent: agents.get(id)! } : { error: { code: 'session/not-found' } },
      create: async (request: { sessionId: string; cwd: string; title?: string }) => { created.push(request); agents.set(request.sessionId, makeAgent(request.sessionId, request.cwd)); return { sessionId: request.sessionId } },
      rename: async () => ({}),
      prompt: async (request: { requestId: string; sessionId: string; mode: string; content: { text: string }[] }) => {
        prompts.push({ requestId: request.requestId, sessionId: request.sessionId, mode: request.mode, text: request.content.map(c => c.text).join('') })
        return { accepted: true }
      },
      cancel: ({ sessionId }: { sessionId: string }) => { controllerCancels.push(sessionId); agents.get(sessionId)!.cancels++ },
      selectModel,
    },
    get: (name: string) => {
      if (name === 'workingDirectory') return { get: (session: unknown) => [...agents.values()].find(agent => agent.session === session)!.cwd }
      if (name === 'sandboxPolicy') return { resolve: ({ session }: { session: unknown }) => {
        const agent = [...agents.values()].find(row => row.session === session)!
        const pinned = agent.appended.filter(row => row.type === 'sandbox/mode').at(-1)?.data as { mode?: string } | undefined
        return { mode: pinned?.mode ?? 'workspace-write' }
      } }
      return undefined
    },
  } as unknown as HostContext
  /** Run one native turn of the session that claims `request`. */
  let turns = 0
  const turn = (sessionId: string, request: string, steps: (emit: (type: string, data?: unknown) => void, turn: number) => void, end: string = 'completed') => {
    const n = ++turns
    emit(sessionId, 'turn/start', { turn: n })
    emit(sessionId, 'user/message', { source: { kind: 'user', rpcId: request }, content: [{ type: 'text', text: 'x' }] })
    steps((type, data) => emit(sessionId, type, data), n)
    if (end) emit(sessionId, 'turn/end', { turn: n, reason: { kind: end } })
  }
  const preExecute = (call: Partial<NativeToolCall> & { name: string }) => {
    const [listener] = listeners['tools/pre-execute']!
    const next = vi.fn(async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
    return { result: listener!({ callId: 'tc-1', arguments: {}, signal: new AbortController().signal, ...call }, next) as Promise<PreToolDecision>, next }
  }
  return { ctx, agents, prompts, created, controllerCancels, emit, turn, listeners, guards, preExecute, makeAgent, selectModel }
}

function sinkLog() {
  const log: [string, ...unknown[]][] = []
  const finished: MemberFinish[] = []
  const sink: MemberCallSink = {
    stepped: (id, text) => log.push(['stepped', id, text]),
    tool: (id, info) => log.push(['tool', id, info.name, info.team]),
    touched: () => {},
    approval: (id, waiting) => log.push(['approval', id, waiting]),
    finished: (id, result) => { log.push(['finished', id, result.status]); finished.push(result) },
  }
  return { sink, log, finished }
}

function setup(options: { tier?: V2CodingPermission; review?: Reviewer; timeoutMinutes?: number; gate?: boolean; inputAttachments?: Pick<ChatAttachments, 'promptParts' | 'allowRead'> } = {}) {
  const dir = temp()
  const host = fakeHost()
  const asked: PendingCommand[] = []
  const approvals = commandApprovals({ logger: { warn: () => {} } } as unknown as HostContext, () => undefined, { timeoutMinutes: options.timeoutMinutes ?? 30, onRequest: row => asked.push(row) })
  cleanups.push(() => approvals.dispose())
  const gate = new CodingGate({ scope: 'brain', socketDir: join(dir, 'run'), hookScript: join(dir, 'missing-hook.js'), approvals, review: options.review,
    order: () => ({ permission: options.tier, title: '查端点', promise: '列出开通的端点' }) })
  cleanups.push(() => gate.dispose())
  const runner = new DshMemberRunner(host.ctx, { scope: 'brain', inputAttachments: options.inputAttachments, ...options.gate !== false && { gate } })
  cleanups.push(() => runner.dispose())
  const sessions = new GroupMemberSessions(join(dir, 'group'))
  const group: GroupContext = { scope: 'brain', workspaceId: 'w1', groupId: 'g1', workspaceName: '方舟评测', title: '端点排查', workDir: dir, sessions, commandsPath: join(dir, 'group', 'commands.jsonl') }
  const call = (callId: string, extra: Partial<MemberCall> = {}): MemberCall => ({ callId, group, member: { id: 'res', name: '研究员', kind: 'dsh', model: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' } },
    identity: '〔群成员身份〕你是「研究员」', prompt: '群成员：…\n#1 主人：@研究员 查一下', workOrderId: 'd1', ...extra })
  const sessionId = memberSessionId('brain', 'w1', 'g1', 'res', dir)
  return { host, runner, gate, approvals, asked, group, call, sessionId, dir, sessions }
}

describe('群成员的原生材料输入', () => {
  const file: ChatInputAttachment = {id: 'file-a', name: '@所有人.docx', kind: 'file', bytes: 17}
  const image: ChatInputAttachment = {id: 'image-b', name: 'B.png', kind: 'image', bytes: 12, mediaType: 'image/png'}
  const material = () => ({
    promptParts: vi.fn(async (id: string, refs: readonly ChatInputAttachment[]) => refs.map(ref => ({type: 'file' as const, receiptId: id + '/' + ref.id}))),
    allowRead: vi.fn(),
  })

  it('复用旧纯文字会话，queue/被认领的 steer 使用本会话回执；换工单隔离，回到原工单续原生历史', async () => {
    const service = material(), t = setup({inputAttachments: service})
    const seen = vi.spyOn(t.host.ctx.sessionController, 'prompt'), {sink} = sinkLog()
    await t.runner.run(t.call('old'), sink)
    t.host.turn(t.sessionId, t.host.prompts[0]!.requestId, () => {})
    expect(service.promptParts).not.toHaveBeenCalled()
    await t.runner.run(t.call('material', {inputAttachments: [file, image]}), sink)
    const queued = seen.mock.calls.at(-1)![0]
    expect(queued).toMatchObject({sessionId: t.sessionId, mode: 'queue', content: [{type:'text'}, {type:'text', text: expect.stringContaining('chief_read_attachment')},
      {type:'file', receiptId: t.sessionId + '/file-a'}, {type:'file', receiptId: t.sessionId + '/image-b'}]})
    expect(service.allowRead).toHaveBeenCalledWith(t.sessionId, [file, image])
    const agent = t.host.agents.get(t.sessionId)!
    agent.status = 'running'
    t.host.turn(t.sessionId, queued.requestId, () => {}, '')
    const steer = t.runner.steer('material', {id:'new', text:'请看新版', inputAttachments:[image]})
    await vi.waitFor(() => expect(seen.mock.calls.at(-1)![0].mode).toBe('steer'))
    const extra = seen.mock.calls.at(-1)![0]
    expect(extra.content.at(-1)).toEqual({type:'file', receiptId: t.sessionId + '/image-b'})
    expect(service.allowRead).toHaveBeenCalledTimes(1)
    t.host.emit(t.sessionId, 'agent/inbox/spliced', {inserted:[{source:{kind:'user', rpcId:extra.requestId}}]})
    await expect(steer).resolves.toBe('steered')
    expect(service.allowRead).toHaveBeenLastCalledWith(t.sessionId, [image])
    t.host.emit(t.sessionId, 'turn/end', {turn:2, reason:{kind:'completed'}})
    await t.runner.run(t.call('other', {workOrderId:'d2'}), sink)
    const other = t.host.prompts.at(-1)!
    expect(other.sessionId).not.toBe(t.sessionId)
    expect(service.allowRead).not.toHaveBeenCalledWith(other.sessionId, expect.anything())
    t.host.turn(other.sessionId, other.requestId, () => {})
    await t.runner.run(t.call('back', {workOrderId:'d1'}), sink)
    expect(t.host.prompts.at(-1)!.sessionId).toBe(t.sessionId)
  })

  it('纯文本模型拒图不会授予读取权限；宿主超时但原生收件箱已收则照常授权', async () => {
    const service = material(), t = setup({inputAttachments: service}), {sink} = sinkLog()
    const send = vi.spyOn(t.host.ctx.sessionController, 'prompt').mockResolvedValueOnce({error:{code:'session/attachment-invalid',details:{reason:'MODEL_DOES_NOT_SUPPORT_IMAGES'}}})
    await expect(t.runner.run(t.call('rejected', {inputAttachments:[image]}), sink)).rejects.toThrow('不支持图片')
    expect(service.allowRead).not.toHaveBeenCalled()
    send.mockImplementationOnce(async request => {
      t.host.agents.get(request.sessionId)!.inboxItems.push({id:'known', source:{kind:'user', rpcId:request.requestId}})
      throw new Error('timeout')
    })
    await t.runner.run(t.call('uncertain', {inputAttachments:[file]}), sink)
    expect(service.allowRead).toHaveBeenCalledOnce()
  })

  it('上传只暂存本条消息，历史材料可按需读取；重启根据插话认领证据恢复授权', async () => {
    const service = material(), t = setup({inputAttachments: service}), {sink} = sinkLog()
    await t.runner.run(t.call('one', {inputAttachments:[image], readAttachments:[file]}), sink)
    expect(service.promptParts).toHaveBeenCalledWith(t.sessionId, [image], expect.any(AbortSignal))
    expect(service.allowRead).toHaveBeenCalledWith(t.sessionId, [image,file])
    t.host.agents.get(t.sessionId)!.status = 'running'
    t.host.turn(t.sessionId, t.host.prompts[0]!.requestId, () => {}, '')
    const extra = {...file,id:'revision'}
    void t.runner.steer('one', {id:'steer-4',text:'核对新版',inputAttachments:[extra]})
    await vi.waitFor(() => expect(t.host.prompts.at(-1)!.mode).toBe('steer'))
    const request = t.host.prompts.at(-1)!.requestId
    expect(t.sessions.live('one')?.inputSteers).toEqual([{id:'steer-4',request,refs:[extra]}])
    t.runner.dispose()
    t.host.emit(t.sessionId,'agent/inbox/spliced',{inserted:[{source:{kind:'user',rpcId:request}}]})
    const restored = material(), runner = new DshMemberRunner(t.host.ctx, {scope:'brain',inputAttachments:restored})
    cleanups.push(() => runner.dispose())
    const recoveredSteer = vi.fn()
    await expect(runner.reattach(t.call('one'), {...sink,recoveredSteer})).resolves.toBe(true)
    expect(restored.allowRead).toHaveBeenCalledWith(t.sessionId,[extra])
    expect(restored.promptParts).not.toHaveBeenCalled()
    expect(recoveredSteer).toHaveBeenCalledWith('res','steer-4','steered')
    expect(t.sessions.live('one')?.inputSteers).toEqual([])
  })
})

describe('DSH 成员会话的建立', () => {
  it('固定 id、群目录、完全访问沙箱、按会话选模型、身份段、收工具，用 queue 投递', async () => {
    const t = setup()
    const { sink } = sinkLog()
    await t.runner.run(t.call('c1'), sink)
    expect(t.sessionId.startsWith(memberSessionPrefix('brain'))).toBe(true)
    expect(t.host.created).toEqual([{ sessionId: t.sessionId, cwd: t.dir, title: '研究员 · 端点排查' }])
    const agent = t.host.agents.get(t.sessionId)!
    expect(agent.appended).toEqual([{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }])
    expect(agent.selected).toEqual([{ provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' }])
    expect(t.host.selectModel).not.toHaveBeenCalled()
    expect(agent.sections.map(s => [s.name, s.text()])).toEqual([['chief-group-member', '〔群成员身份〕你是「研究员」']])
    expect(agent.restricted).toHaveLength(1)
    expect(agent.restricted[0]).toEqual(expect.arrayContaining(['ask_user_question', 'plugin_manager', 'subagent', 'subagent_fork', 'schedule_create', 'schedule_list', 'subagent_codex']))
    expect(agent.restricted[0]).not.toContain('spawn_teammate') // not registered on this host
    expect(t.host.prompts).toEqual([{ requestId: expect.stringMatching(/^chief-grp-c1-1-/), sessionId: t.sessionId, mode: 'queue', text: '群成员：…\n#1 主人：@研究员 查一下' }])
    expect(t.sessions.member('res')).toMatchObject({ kind: 'dsh', cwd: t.dir, session: t.sessionId })
    expect(t.sessions.live('c1')).toMatchObject({ memberId: 'res', session: t.sessionId, request: t.host.prompts[0]!.requestId, push: 1 })
  })

  it('执行时硬拒绝成员不能用的工具，只拦成员会话', async () => {
    const t = setup()
    const [guard] = t.host.guards
    for (const name of [...MEMBER_DENY, 'schedule_create', 'subagent_codex']) expect(guard!({ name, agent: { id: t.sessionId } })).toMatch(/群成员不能用/)
    expect(guard!({ name: 'bash', agent: { id: t.sessionId } })).toBeUndefined()
    expect(guard!({ name: 'subagent', agent: { id: 'someone-else' } })).toBeUndefined()
  })

  it('agent 重建后重装身份段与工具遮蔽；模型与沙箱已就绪时不重复设置', async () => {
    const t = setup()
    const { sink } = sinkLog()
    await t.runner.run(t.call('c1'), sink)
    t.host.turn(t.sessionId, t.host.prompts[0]!.requestId, () => {})
    const rebuilt = t.host.makeAgent(t.sessionId, t.dir)
    t.host.agents.set(t.sessionId, rebuilt)
    for (const listener of t.host.listeners['agent/created']!) listener({ agent: rebuilt })
    expect(rebuilt.sections.map(s => s.text())).toEqual(['〔群成员身份〕你是「研究员」'])
    expect(rebuilt.restricted).toHaveLength(1)
    // An agent the runner does not know is left alone.
    const stranger = t.host.makeAgent('other', t.dir)
    for (const listener of t.host.listeners['agent/created']!) listener({ agent: stranger })
    expect(stranger.sections).toHaveLength(0)
    await t.runner.run(t.call('c2'), sink)
    expect(rebuilt.appended).toEqual([{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }])
    expect(rebuilt.selected).toHaveLength(1)
  })

  it('DSH 自己的审批请求对成员会话一律拒绝（SuperHub 看不到那张卡），别的会话照常', async () => {
    const t = setup()
    const [listener] = t.host.listeners['approval/request']!
    await expect(listener!({ agent: { id: t.sessionId }, toolName: 'bash' }, async () => 'allowed-once')).resolves.toBe('rejected')
    await expect(listener!({ agent: { id: 'liaison-session' }, toolName: 'bash' }, async () => 'allowed-once')).resolves.toBe('allowed-once')
  })
})

describe('经验撤回后换新会话', () => {
  it('队列认领不能代替实际 DSH 请求，收到模型响应后登记，撤权后的回报与旧回放不再提供', async () => {
    const t = setup()
    const {sink,finished} = sinkLog()
    const old = {id:'style',version:1,text:'这一版经验已撤回。'}
    let active: ExperienceEntry[] = [old]
    const recordExperienceDelivery = vi.fn()
    const query = {task:'研究',workspaceId:'w1',staffId:'res'}
    t.group.experience = {
      selectExperience: query => ({query,scope:'brain',authority:'v1',entries:active,authorized:active}),
      assertExperienceCurrent: selection => {
        if (selection.entries.some(ref => !active.some(entry => entry.id === ref.id && entry.version === ref.version))) throw new Error('revoked')
      },
      recordExperienceDelivery,
    }
    const extra = () => ({experience:t.group.experience!.selectExperience(query), recap:(clean?:boolean)=>clean ? '主人原话' : '旧助手回放'})
    await t.runner.run(t.call('c1', extra()), sink)
    const first = t.host.prompts[0]!
    expect(first.text).toContain(old.text)
    expect(recordExperienceDelivery).not.toHaveBeenCalled()
    t.host.turn(first.sessionId, first.requestId, emit => {
      expect(recordExperienceDelivery).not.toHaveBeenCalled()
      emit('assistant/message', {message:{content:[{type:'text',text:'先核查材料'}]}})
      expect(recordExperienceDelivery).toHaveBeenCalledWith(expect.anything(),
        {turnId:'c1.1',executorId:'res',sessionId:'g1',nativeSessionId:first.sessionId,orderId:'d1'})
      active = [{...old,version:2,text:'这一版经验可以使用。'}]
      emit('assistant/message', {message:{content:[{type:'text',text:'不该回报的内容'}]}})
    })
    expect(finished).toContainEqual(expect.objectContaining({text:'',status:'failed'}))
    await t.runner.run(t.call('c2', extra()), sink)
    const next = t.host.prompts[1]!
    expect(next.sessionId).not.toBe(first.sessionId)
    expect(next.text).toContain(active[0]!.text)
    expect(next.text).toContain('主人原话')
    expect(next.text).not.toContain('旧助手回放')
  })

  it('同一会话续用到有经验被撤回：之后开一场新会话，并给它最近几行；新增经验不换会话', async () => {
    const t = setup()
    const { sink } = sinkLog()
    const member = (memories: string[]) => ({ id: 'res', name: '研究员', kind: 'dsh' as const, memories })
    await t.runner.run(t.call('c1', { member: member(['访谈结束复述约定']) }), sink)
    t.host.turn(t.sessionId, t.host.prompts[0]!.requestId, emit => emit('assistant/message', { message: { content: [{ type: 'text', text: '好' }] } }))
    // A new experience: same session.
    await t.runner.run(t.call('c2', { member: member(['访谈结束复述约定', '乙的独立经验']) }), sink)
    expect(t.host.prompts[1]!.sessionId).toBe(t.sessionId)
    t.host.turn(t.sessionId, t.host.prompts[1]!.requestId, emit => emit('assistant/message', { message: { content: [{ type: 'text', text: '好' }] } }))
    // One is revoked: the old session's earlier system prompts still hold it, so a new session reads the recent lines.
    await t.runner.run(t.call('c3', { member: member(['乙的独立经验']), recap: () => '群里最近的消息：…' }), sink)
    const fresh = t.host.prompts[2]!
    expect(fresh.sessionId).not.toBe(t.sessionId)
    expect(fresh.sessionId.startsWith(t.sessionId + '-')).toBe(true)
    expect(fresh.text).toBe('群里最近的消息：…')
    expect(t.host.created.map(row => row.sessionId)).toEqual([t.sessionId, fresh.sessionId])
    expect(t.sessions.member('res')).toMatchObject({ session: fresh.sessionId, memories: [expect.any(String)] })
    t.host.turn(fresh.sessionId, fresh.requestId, emit => emit('assistant/message', { message: { content: [{ type: 'text', text: '好' }] } }))
    // It stays on the new session afterwards.
    await t.runner.run(t.call('c4', { member: member(['乙的独立经验']) }), sink)
    expect(t.host.prompts[3]!.sessionId).toBe(fresh.sessionId)
  })
})

describe('DSH 成员会话的事件', () => {
  it('中途的话、工具调用与最终回复按 callId 报回；只认自己投递的那一轮', async () => {
    const t = setup()
    const { sink, log, finished } = sinkLog()
    await t.runner.run(t.call('c1'), sink)
    const request = t.host.prompts[0]!.requestId
    // A turn that does not carry our request is not ours.
    t.host.turn(t.sessionId, 'someone-else', emit => emit('assistant/message', { message: { content: [{ type: 'text', text: '别的' }] } }))
    t.host.turn(t.sessionId, request, emit => {
      emit('assistant/message', { message: { content: [{ type: 'text', text: '我先看看 arkcli 的版本。' }] } })
      emit('tool/call', { callId: 'tc1', name: 'bash', arguments: '{"command":"arkcli --version"}' })
      emit('tool/result', { message: { content: [] } })
      emit('assistant/message', { message: { content: [{ type: 'text', text: '被打断的半句' }] }, interrupted: true })
      emit('assistant/message', { message: { content: [{ type: 'text', text: 'arkcli 1.0.50，可以列出端点。' }] } })
    })
    expect(log).toEqual([['stepped', 'c1', '我先看看 arkcli 的版本。'], ['tool', 'c1', 'bash', false], ['finished', 'c1', 'completed']])
    expect(finished).toEqual([{ text: 'arkcli 1.0.50，可以列出端点。', status: 'completed', toolCalls: 1 }])
    expect(t.sessions.live('c1')).toBeUndefined()
  })

  it('续推在同一会话再投一次；回合中断记为失败，叫停记为取消', async () => {
    const t = setup()
    const { sink, log, finished } = sinkLog()
    await t.runner.run(t.call('c1'), sink)
    t.host.turn(t.sessionId, t.host.prompts[0]!.requestId, emit => emit('assistant/message', { message: { content: [{ type: 'text', text: '收到，我去查。' }] } }))
    await t.runner.continue('c1', '你上一句说要开工……')
    expect(t.host.prompts[1]).toMatchObject({ sessionId: t.sessionId, mode: 'queue', text: '你上一句说要开工……', requestId: expect.stringMatching(/^chief-grp-c1-2-/) })
    t.host.turn(t.sessionId, t.host.prompts[1]!.requestId, emit => emit('tool/call', { callId: 'x', name: 'bash', arguments: '{}' }), 'aborted')
    expect(finished.map(row => [row.status, row.toolCalls, row.detail])).toEqual([['completed', 0, undefined], ['failed', 1, '回合被中断了']])
    await t.runner.run(t.call('c2'), sink)
    t.host.turn(t.sessionId, t.host.prompts[2]!.requestId, () => {}, '')
    t.runner.cancel('c2')
    expect(t.host.controllerCancels).toEqual([t.sessionId])
    t.host.emit(t.sessionId, 'turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(log.at(-1)).toEqual(['finished', 'c2', 'cancelled'])
  })

  it('还没被会话接下就叫停：从收件箱撤回，立即报取消', async () => {
    const t = setup()
    const { sink, log } = sinkLog()
    await t.runner.run(t.call('c1'), sink)
    const agent = t.host.agents.get(t.sessionId)!
    agent.inboxItems.push({ id: 'in-1', source: { kind: 'user', rpcId: t.host.prompts[0]!.requestId } })
    t.runner.cancel('c1')
    expect(agent.inboxItems).toEqual([])
    expect(log).toEqual([['finished', 'c1', 'cancelled']])
  })

  it('送达失败时撤回登记并拒绝', async () => {
    const t = setup()
    ;(t.host.ctx.sessionController as { prompt: unknown }).prompt = async () => ({ error: { code: 'session/busy', message: 'busy' } })
    const { sink, log } = sinkLog()
    await expect(t.runner.run(t.call('c1'), sink)).rejects.toThrow(/没有接下/)
    expect(t.sessions.live('c1')).toBeUndefined()
    expect(log).toEqual([])
  })
})

describe('DSH 成员会话重启后续上', () => {
  async function delivered() {
    const t = setup()
    const first = sinkLog()
    await t.runner.run(t.call('c1'), first.sink)
    const request = t.host.prompts[0]!.requestId
    t.host.emit(t.sessionId, 'turn/start', { turn: 9 })
    t.host.emit(t.sessionId, 'user/message', { source: { kind: 'user', rpcId: request } })
    t.host.emit(t.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: '先查版本' }] } })
    t.host.emit(t.sessionId, 'tool/call', { callId: 'a', name: 'bash', arguments: '{}' })
    // The plugin reloads: the old runner is gone, the native turn goes on.
    t.runner.dispose()
    const runner = new DshMemberRunner(t.host.ctx, { scope: 'brain', gate: t.gate })
    cleanups.push(() => runner.dispose())
    return { ...t, request, first, runner }
  }

  it('回合仍在跑：续上，只补报没报过的事件，之后的事件照常报', async () => {
    const t = await delivered()
    t.host.agents.get(t.sessionId)!.status = 'running'
    t.host.emit(t.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: '版本是 1.0.50' }] } })
    t.host.emit(t.sessionId, 'tool/call', { callId: 'b', name: 'bash', arguments: '{}' })
    const { sink, log, finished } = sinkLog()
    await expect(t.runner.reattach({ callId: 'c1', group: t.group, member: t.call('c1').member, identity: '身份' }, sink)).resolves.toBe(true)
    expect(log).toEqual([['stepped', 'c1', '版本是 1.0.50'], ['tool', 'c1', 'bash', false]])
    t.host.emit(t.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: '端点有 3 个。' }] } })
    t.host.emit(t.sessionId, 'turn/end', { turn: 9, reason: { kind: 'completed' } })
    expect(finished).toEqual([expect.objectContaining({ text: '端点有 3 个。', status: 'completed' })])
    expect(t.host.agents.get(t.sessionId)!.sections.at(-1)!.text()).toBe('身份')
  })

  it('不在时已经结束：续上并马上报结束', async () => {
    const t = await delivered()
    t.host.emit(t.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: '端点有 3 个。' }] } })
    t.host.emit(t.sessionId, 'turn/end', { turn: 9, reason: { kind: 'completed' } })
    const { sink, finished } = sinkLog()
    await expect(t.runner.reattach({ callId: 'c1', group: t.group, member: t.call('c1').member, identity: '身份' }, sink)).resolves.toBe(true)
    expect(finished).toEqual([expect.objectContaining({ text: '端点有 3 个。', status: 'completed' })])
  })

  it('不在时被宿主停机中断（turn/end aborted）：不续，清掉投递记录，由调度器记为重启中断而不是成员失败', async () => {
    const t = await delivered()
    // DSH aborts running turns when it shuts down; the restored session log carries that end.
    t.host.emit(t.sessionId, 'turn/end', { turn: 9, reason: { kind: 'aborted', reason: { kind: 'shutdown' } } })
    const { sink, log } = sinkLog()
    await expect(t.runner.reattach({ callId: 'c1', group: t.group, member: t.call('c1').member, identity: '身份' }, sink)).resolves.toBe(false)
    expect(log).toEqual([])
    expect(t.sessions.live('c1')).toBeUndefined()
  })

  it('同一运行器还跟着这一回合（引擎重建、宿主没重启）：改报给新的引擎', async () => {
    const t = setup()
    const old = sinkLog(), fresh = sinkLog()
    await t.runner.run(t.call('c1'), old.sink)
    await expect(t.runner.reattach({ callId: 'c1', group: t.group, member: t.call('c1').member, identity: '身份' }, fresh.sink)).resolves.toBe(true)
    t.host.turn(t.sessionId, t.host.prompts[0]!.requestId, emit => emit('assistant/message', { message: { content: [{ type: 'text', text: '好了' }] } }))
    expect(old.log).toEqual([])
    expect(fresh.log).toEqual([['finished', 'c1', 'completed']])
  })

  it('回合没了（会话不在跑也没结束），或从没送达：不续，清掉投递记录', async () => {
    const t = await delivered()
    const { sink } = sinkLog()
    await expect(t.runner.reattach({ callId: 'c1', group: t.group, member: t.call('c1').member, identity: '身份' }, sink)).resolves.toBe(false)
    expect(t.sessions.live('c1')).toBeUndefined()
    t.sessions.setLive('c9', { memberId: 'res', session: t.sessionId, request: 'never-sent', push: 1 })
    await expect(t.runner.reattach({ callId: 'c9', group: t.group, member: t.call('c9').member, identity: '身份' }, sink)).resolves.toBe(false)
  })
})

describe('DSH 成员的命令把关（tools/pre-execute）', () => {
  async function running(options: Parameters<typeof setup>[0] = {}) {
    const t = setup(options)
    const s = sinkLog()
    await t.runner.run(t.call('c1'), s.sink)
    t.host.turn(t.sessionId, t.host.prompts[0]!.requestId, () => {}, '')
    const bash = (command: string) => t.host.preExecute({ name: 'bash', agent: { id: t.sessionId } as Agent, arguments: { command } })
    const lines = () => readFileSync(t.group.commandsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    return { ...t, ...s, bash, lines }
  }

  it('普通命令三档都放行；完全访问档高危命令放行并留痕', async () => {
    const t = await running({ tier: 'full-access' })
    const ls = t.bash('ls')
    await expect(ls.result).resolves.toEqual({ kind: 'allow' })
    const rm = t.bash('rm -rf build')
    await expect(rm.result).resolves.toEqual({ kind: 'allow' })
    expect(rm.next).toHaveBeenCalledOnce()
    expect(t.lines().map(line => [line.command, line.risk, line.tier, line.decision, line.turnId, line.workOrderId, line.tool])).toEqual([
      ['ls', 'normal', 'full-access', 'auto', 'c1.1', 'd1', 'bash'], ['rm -rf build', 'high', 'full-access', 'auto', 'c1.1', 'd1', 'bash']])
    expect(t.asked).toHaveLength(0)
  })

  it('请求批准 → 主人批准：等审批卡（成员让出发言位），批准后放行', async () => {
    const t = await running({ tier: 'ask' })
    const rm = t.bash('rm -rf build')
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    expect(t.asked[0]).toMatchObject({ command: 'rm -rf build', staff: '研究员', staffId: 'res', title: '查端点', workdir: t.dir,
      workspace: { scope: 'brain', workspaceId: 'w1', sessionId: 'g1', orderId: 'd1', turnId: 'c1.1', tool: 'dsh', memberId: 'res' } })
    expect(t.gate.pending({ workspaceId: 'w1', sessionId: 'g1' })).toEqual([expect.objectContaining({ tool: 'dsh', memberId: 'res', command: 'rm -rf build' })])
    expect(t.log).toEqual([['approval', 'c1', true]])
    expect(rm.next).not.toHaveBeenCalled()
    t.approvals.decide(t.asked[0]!.id, true)
    await expect(rm.result).resolves.toEqual({ kind: 'allow' })
    expect(t.log).toEqual([['approval', 'c1', true], ['approval', 'c1', false]])
    expect(t.lines().at(-1)).toMatchObject({ decision: 'allowed', by: 'owner' })
  })

  it('请求批准 → 主人拒绝：拒绝，理由给模型看', async () => {
    const t = await running({ tier: 'ask' })
    const rm = t.bash('rm -rf build')
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    t.approvals.decide(t.asked[0]!.id, false)
    await expect(rm.result).resolves.toEqual({ kind: 'deny', reason: expect.stringContaining('主人拒绝了这条命令') })
    expect(rm.next).not.toHaveBeenCalled()
  })

  it('请求批准 → 没人处理：到期拒绝', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const t = await running({ tier: 'ask', timeoutMinutes: 1 })
    const rm = t.bash('rm -rf build')
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(60_001)
    await expect(rm.result).resolves.toEqual({ kind: 'deny', reason: expect.stringContaining('已过期') })
    expect(t.lines().at(-1)).toMatchObject({ decision: 'expired', by: 'gate' })
  })

  it('代为批准：交给审查决定', async () => {
    const t = await running({ tier: 'approve-for-me', review: async () => ({ decision: 'deny', reason: '越出工单目标' }) })
    await expect(t.bash('rm -rf build').result).resolves.toEqual({ kind: 'deny', reason: expect.stringContaining('越出工单目标') })
  })

  it('没有进行中的回合、或把关服务不可用：只放行普通命令；非成员会话与非命令工具不经把关', async () => {
    const t = setup({ gate: false })
    const idle = (command: string, id = t.sessionId) => t.host.preExecute({ name: 'bash', agent: { id } as Agent, arguments: { command } }).result
    await expect(idle('rm -rf build')).resolves.toMatchObject({ kind: 'deny', reason: expect.stringContaining('没有交给你的回合') })
    await expect(idle('ls')).resolves.toEqual({ kind: 'allow' })
    await t.runner.run(t.call('c1'), sinkLog().sink)
    await expect(idle('rm -rf build')).resolves.toMatchObject({ kind: 'deny', reason: expect.stringContaining('把关不可用') })
    await expect(idle('rm -rf build', 'liaison-main')).resolves.toEqual({ kind: 'allow' })
    await expect(t.host.preExecute({ name: 'write', agent: { id: t.sessionId } as Agent, arguments: { path: 'x' } }).result).resolves.toEqual({ kind: 'allow' })
  })

  it('回合结束后把关租约作废：迟到的命令拒绝', async () => {
    const t = await running({ tier: 'full-access' })
    const late = t.bash('ls')
    t.host.emit(t.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(late.result).resolves.toEqual({ kind: 'allow' })
    await expect(t.bash('rm -rf build').result).resolves.toMatchObject({ kind: 'deny' })
  })
})

describe('主人的话立即送进在干活的 DSH 成员', () => {
  it('在跑的那一轮用 steer 投递；会话认领即 steered；那一轮结束仍没认领的从收件箱撤回，为 rejected', async () => {
    const t = setup()
    const { sink, finished } = sinkLog()
    await t.runner.run(t.call('c1'), sink)
    const request = t.host.prompts[0]!.requestId
    const agent = t.host.agents.get(t.sessionId)!
    // Not taken yet / not running: nothing to steer into.
    await expect(t.runner.steer('c1', { id: 'steer-2', text: '#2 主人：先别动' })).resolves.toBe('rejected')
    t.host.emit(t.sessionId, 'turn/start', { turn: 1 })
    t.host.emit(t.sessionId, 'user/message', { source: { kind: 'user', rpcId: request }, content: [] })
    agent.status = 'running'
    const steered = t.runner.steer('c1', { id: 'steer-2', text: '#2 主人：先别动' })
    await vi.waitFor(() => expect(t.host.prompts).toHaveLength(2))
    expect(t.host.prompts[1]).toMatchObject({ sessionId: t.sessionId, mode: 'steer', text: '#2 主人：先别动' })
    t.host.emit(t.sessionId, 'agent/inbox/spliced', { inserted: [{ source: { kind: 'user', rpcId: t.host.prompts[1]!.requestId } }] })
    await expect(steered).resolves.toBe('steered')

    // A second word arrives as the turn ends: it leaves the inbox and is reported as not taken.
    const late = t.runner.steer('c1', { id: 'steer-3', text: '#3 主人：再加一项' })
    await vi.waitFor(() => expect(t.host.prompts).toHaveLength(3))
    agent.inboxItems.push({ id: 'i3', source: { kind: 'user', rpcId: t.host.prompts[2]!.requestId } })
    t.host.emit(t.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: '已停手。' }] } })
    t.host.emit(t.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(late).resolves.toBe('rejected')
    expect(agent.inboxItems).toEqual([])
    expect(finished).toEqual([expect.objectContaining({ status: 'completed', text: '已停手。' })])
    await expect(t.runner.steer('c1', { id: 'steer-4', text: '回合已结束' })).resolves.toBe('rejected')
  })
})
