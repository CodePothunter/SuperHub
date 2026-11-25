import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Chat } from '../src/client/chat.tsx'
import { reconcilePending } from '../src/client/chat-state.ts'
import { Engine, type Executors } from '../src/core/engine.ts'
import type { Staff } from '../src/core/model.ts'
import { FileStore } from '../src/core/store.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { chatFromEvents, inboxDispatchState, LiaisonChat, type ChatDispatch, type ChatMessage, type LiaisonParts } from '../src/dsh/chat.ts'
import type { Agent, HostContext, SessionController, SessionEventLike, Tools } from '../src/dsh/ports.ts'
import { registerTools } from '../src/dsh/tools.ts'
import { NativeRooms } from '../src/dsh/rooms.ts'

type Definition = Parameters<Tools['register']>[0]
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)) }
const event = (seq: number, type: string, data: unknown): SessionEventLike => ({ seq, type, time: 100, data })

it('projects a workspace link only from a matched successful native workspace receipt, during and after its turn', () => {
  const space = { id:randomUUID(), name:'研发' }
  const call = event(2,'tool/call',{ name:'chief_workspace', callId:'create' })
  const result = (callId: string, isError: boolean) => event(3,'tool/result',{message:{toolCallId:callId,isError},meta:{'dsh-chief/workspace':space}})
  const turn = [event(1,'turn/start',{}),call,result('create',false)]
  expect(chatFromEvents(turn).live?.workspaces).toEqual([space])
  expect(chatFromEvents([...turn,event(4,'turn/end',{})]).messages.at(-1)?.workspaces).toEqual([space])
  for (const events of [[call,result('unrelated',false)],[call,result('create',true)],[event(1,'tool/call',{name:'chief_brief',callId:'create'}),result('create',false)]]) {
    expect(chatFromEvents(events).messages.flatMap(message=>message.workspaces ?? [])).toEqual([])
  }
})

it('opens a profile import only from a real native import receipt, including a reply with no prose', () => {
  const receipt = { importId: 'profile-' + 'a'.repeat(64) }
  const call = event(2, 'tool/call', {name:'chief_import',callId:'paste'})
  const result = (callId: string, importId: string, isError = false) => event(3, 'tool/result', {
    message:{toolCallId:callId,isError}, meta:{'dsh-chief/profile-import':{importId}},
  })
  const turn = [event(1,'turn/start',{}), call, result('paste',receipt.importId)]
  expect(chatFromEvents(turn).live?.profileImports).toEqual([receipt])
  expect(chatFromEvents([...turn,event(4,'turn/end',{})]).messages.at(-1)?.profileImports).toEqual([receipt])
  for (const invalid of [
    [call,result('other',receipt.importId)],
    [call,result('paste',receipt.importId,true)],
    [call,result('paste','T-0001')],
    [event(1,'assistant/message',{message:{content:[{type:'text',text:JSON.stringify(receipt)}]}})],
  ]) expect(chatFromEvents(invalid).messages.flatMap(message => message.profileImports ?? [])).toEqual([])
})

it('retains the exact owner words so a multiline handoff matches its pending message', () => {
  const text = '  帮我整理这段原文\n\n    保留缩进\n'
  const owner = event(7, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const { messages } = chatFromEvents([owner])
  expect(messages.map(row => row.text)).toEqual([text])
  expect(reconcilePending([{ id: 1, time: 99, afterSeq: 6, text }], messages)).toEqual([])
})

function fixture(withRooms = false) {
  const root = mkdtempSync(join(tmpdir(), 'chief-chat-dispatch-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const brain = new BrainRepo(root), store = new FileStore(root)
  const staff: Staff[] = ['chief', 'researcher'].map(id => ({ id, name: id, executor: 'dsh', verifier: 'none', brief: '本地处理' }))
  vi.spyOn(brain, 'staff').mockReturnValue(staff)
  vi.spyOn(brain, 'commit').mockImplementation(() => {})
  const executors: Executors = {
    available: () => true, supportsSchema: () => true,
    run: async request => ({ text: '', stopReason: 'completed', structured: request.staff.id === 'chief'
      ? { action: 'accept', reason: '明确交办', title: '相同标题', staff: 'researcher', level: 'think', scope: '整理资料', doneWhen: ['整理结论'], needsReview: false, priority: 1 }
      : { status: 'question', summary: '资料已整理，等待决定。', question: '接下来先做什么？' } }),
  }
  const engine = new Engine(store, brain, executors, { dispatch() {}, cancel() {} }, { concurrency: 2, timeZone: 'UTC' })
  engine.setPaused(true)
  cleanup.push(() => engine.stop())
  const registered = new Map<string, Definition>()
  const agents = new Map<string, Agent>()
  const ctx = { get: (name: string) => name === 'agentTeams' ? { tryMembership: () => undefined } : undefined, workspaceRegistry: { create: async () => ({ id: 'workspace' }) }, sessionController: { resolveAgent: async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }, create: async ({ sessionId }: { sessionId: string }) => { agents.set(sessionId, { id: sessionId }) } }, tools: { register: (definition: Definition) => { registered.set(definition.name, definition); return () => {} } } } as unknown as HostContext
  const rooms = withRooms ? new NativeRooms(ctx, root, () => []) : undefined
  registerTools(ctx, { engine, brain, rooms, isLiaison: (id: string) => id === 'hq', lookup: { info: () => ({ subagent: false }) } } as unknown as Parameters<typeof registerTools>[1])
  const inbox = registered.get('chief_inbox')!
  const send = async () => await inbox.execute({ text: '帮我整理同一个标题的资料' }, { signal: new AbortController().signal, agent: { id: 'hq' } } as never) as { eventId: string; message: string }
  const turn = (receipt: { eventId: string; message: string }, callId = randomUUID(), offset = 0) => [
    event(offset + 1, 'turn/start', {}),
    event(offset + 2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我整理资料' }] }),
    event(offset + 3, 'tool/call', { name: 'chief_inbox', callId, arguments: '{"text":"帮我整理资料"}' }),
    event(offset + 4, 'tool/result', { message: { toolCallId: callId, isError: false, content: inbox.output.render({}, receipt) }, meta: inbox.output.presentationMeta!({}, receipt) }),
    event(offset + 5, 'assistant/message', { message: { content: [{ type: 'text', text: '已经交办。' }] } }),
    event(offset + 6, 'turn/end', {}),
  ]
  const chat = (events: SessionEventLike[], parts: string | LiaisonParts = 'hq', from = store) => new LiaisonChat({} as SessionController, parts,
    async () => ({ id: 'hq', status: 'idle', session: { snapshotEvents: () => events } } as Agent), () => [], id => inboxDispatchState(from, id))
  return { root, store, engine, inbox, send, turn, chat, rooms, agents }
}

describe('接口人交办到工单对话的导航', () => {
  it('正式交办自动关联讨论，指定讨论继续沿用，回执不伪造额外模型执行', async () => {
    const f = fixture(true), execution = { signal: new AbortController().signal, agent: { id: 'hq' } } as never
    const first = await f.inbox.execute({ text: '整理资料', title: '持续研究' }, execution) as { eventId: string; message: string; room: { id: string; title: string } }
    expect(f.store.event(first.eventId)?.meta?.room_id).toBe(first.room.id)
    expect(f.agents.size).toBe(1)
    const next = await f.inbox.execute({ text: '追加范围', room: first.room.id }, execution) as typeof first
    expect(next.room.id).toBe(first.room.id); expect(f.rooms?.list()).toHaveLength(1)
    expect(f.store.event(next.eventId)?.meta?.room_id).toBe(first.room.id)
    expect(chatFromEvents(f.turn(next)).messages.at(-1)?.discussions?.[0]?.id).toBe(first.room.id)
    await expect(f.inbox.execute({ text: '不应错投', room: 'nonexistent' }, execution)).rejects.toThrow('没有这个讨论')
    expect(f.engine.recentEvents()).toHaveLength(2)
  })
  it('原生讨论回执来自真实工具元数据，文字宣称和失败工具不生成讨论入口', () => {
    const events = [event(1, 'tool/call', { callId: 'room-call', name: 'chief_room', arguments: '{"action":"discuss"}' }), event(2, 'tool/result', { message: { toolCallId: 'room-call', content: [] }, meta: { 'dsh-chief/room': { id: 'room-1', title: '接着讨论' } } })]
    expect(chatFromEvents(events).messages[0]?.discussions).toEqual([{ id: 'room-1', title: '接着讨论' }])
    expect(chatFromEvents([event(1, 'assistant/message', { message: { content: [{ type: 'text', text: '我已经建立 room-1 讨论' }] } })]).messages[0]?.discussions).toBeUndefined()
    expect(chatFromEvents([events[0]!, event(2, 'tool/result', { message: { toolCallId: 'room-call', isError: true }, meta: { 'dsh-chief/room': { id: 'room-1', title: '伪造' } } })]).messages).toHaveLength(0)
  })
  it('读取归档及当前成功回执中的精确投递标识，两次同屋委托不会合并到一起', async () => {
    const id = 'room-1'
    const first = { id, title: '幕僚自我介绍', requestId: 'liaison-' + 'a'.repeat(64) }
    const second = { ...first, requestId: 'liaison-' + 'b'.repeat(64) }
    const tool = (seq: number, callId: string, receipt: typeof first, isError = false) => [
      event(seq, 'tool/call', { callId, name: 'chief_room', arguments: '{"action":"discuss"}' }),
      event(seq + 1, 'tool/result', { message: { toolCallId: callId, isError }, meta: { 'dsh-chief/room': receipt } }),
    ]
    const archive = chatFromEvents(tool(1, 'first', first)).messages
    const viewResult = { id: 'result-2', roomId: id, title: first.title, at: new Date(200).toISOString(), status: 'ready' as const, text: '研究员负责查证资料。' }
    const reports = vi.fn(async () => [viewResult])
    const parts = { base: () => 'hq', current: () => 'hq-2', offset: () => 100, archived: () => archive, ready: async () => {} }
    const events = [event(1, 'turn/start', {}), ...tool(2, 'wrong', { ...first, requestId: 'liaison-' + 'c'.repeat(64) }, true), ...tool(4, 'second', second)]
    const chat = new LiaisonChat({} as SessionController, parts, async () => ({ id: 'hq-2', status: 'idle', session: { snapshotEvents: () => events } } as Agent),
      undefined, undefined, undefined, undefined, reports)
    expect(await chat.view()).toMatchObject({ messages: [{ discussions: [first] }], live: { discussions: [second] }, discussionResults: [viewResult] })
    expect(reports).toHaveBeenCalledWith([first, second])
    expect(chatFromEvents([...tool(1, 'first', first), ...tool(3, 'second', second)]).messages[0]?.discussions).toEqual([first, second])
  })
  it('相同原文和标题的两次真实交办按不同源事件绑定，研判前不猜工单', async () => {
    const f = fixture(), first = await f.send(), second = await f.send()
    expect(first.eventId).not.toBe(second.eventId)
    expect(f.store.event(first.eventId)).toMatchObject({ dedupe: `inbox:${first.eventId}`, meta: { channel: 'chat' } })
    expect(f.inbox.output.render({}, first)).toEqual([{ type: 'text', text: first.message }])
    const chat = f.chat([...f.turn(first), ...f.turn(second, undefined, 10)])
    const pending = (await chat.view()).messages.flatMap(m => m.dispatches ?? [])
    expect(pending).toEqual([{ eventId: first.eventId, state: 'pending' }, { eventId: second.eventId, state: 'pending' }])
    f.engine.setPaused(false)
    await settle()
    const tickets = f.engine.views().map(v => v.ticket)
    expect(tickets.map(t => t.title)).toEqual(['相同标题', '相同标题'])
    const dispatches = (await chat.view()).messages.flatMap(m => m.dispatches ?? [])
    expect(dispatches).toEqual([first, second].map(receipt => ({ eventId: receipt.eventId, state: 'accepted', ticketId: tickets.find(t => t.events.includes(receipt.eventId))!.id })))
    expect(new Set(dispatches.map(d => d.ticketId)).size).toBe(2)
  })

  it('已并入工单按持久去向打开；研判失败、归档或忽略均不生成工单链接', async () => {
    const f = fixture(), receipt = await f.send(), chat = f.chat(f.turn(receipt))
    for (const disposition of [{ kind: 'unavailable', reason: '研判执行者不可用' }, { kind: 'ignored', reason: '无需处理' }, { kind: 'noted', path: 'journal/note.md' }, { kind: 'observed' }] as const) {
      f.store.setDisposition(receipt.eventId, disposition)
      expect((await chat.view()).messages[1]?.dispatches?.[0]).toMatchObject({ eventId: receipt.eventId, state: disposition.kind })
      expect((await chat.view()).messages[1]?.dispatches?.[0]).not.toHaveProperty('ticketId')
    }
    f.store.setDisposition(receipt.eventId, { kind: 'pending' })
    f.engine.setPaused(false)
    await settle()
    const ticket = f.engine.views()[0]!.ticket
    f.store.setDisposition(receipt.eventId, { kind: 'attached', ticketId: ticket.id })
    expect((await chat.view()).messages[1]?.dispatches).toEqual([{ eventId: receipt.eventId, state: 'attached', ticketId: ticket.id }])
    f.store.setDisposition(receipt.eventId, { kind: 'accepted', ticketId: 'T-9999' })
    expect((await chat.view()).messages[1]?.dispatches).toEqual([{ eventId: receipt.eventId, state: 'missing' }])
  })

  it('回执在没有模型末尾说明时也可见，进行中不阻塞接口人继续处理', async () => {
    const f = fixture(), receipt = await f.send(), events = f.turn(receipt).slice(0, 4)
    const live = await f.chat(events).view()
    expect(live.live?.dispatches).toEqual([{ eventId: receipt.eventId, state: 'pending' }])
    expect(live.messages.map(m => m.role)).toEqual(['you'])
    const ended = chatFromEvents([...events, event(5, 'turn/end', {})])
    expect(ended.messages[1]).toMatchObject({ role: 'liaison', text: '', dispatches: [{ eventId: receipt.eventId, state: 'pending' }] })
  })

  it('刷新或换段后以原事件重新解析去向，同文同时间的交办不会合并或沿用旧链接', async () => {
    const f = fixture(), first = await f.send(), second = await f.send()
    const old = chatFromEvents([...f.turn(first), ...f.turn(second, undefined, 10)]).messages
    const archived: ChatMessage[] = JSON.parse(JSON.stringify(old))
    for (const message of archived) for (const dispatch of message.dispatches ?? []) dispatch.ticketId = 'T-9999'
    f.engine.setPaused(false)
    await settle()
    const fromDisk = new FileStore(f.root)
    const parts: LiaisonParts = { current: () => 'hq-p2', base: () => 'hq', offset: () => 1_000_000_000, archived: () => archived, ready: async () => {} }
    const restored = await f.chat([], parts, fromDisk).view()
    const dispatches = restored.messages.flatMap(m => m.dispatches ?? [])
    expect(restored.sessionId).toBe('hq')
    expect(dispatches.map(d => d.eventId)).toEqual([first.eventId, second.eventId])
    expect(dispatches.every(d => d.state === 'accepted' && d.ticketId !== 'T-9999')).toBe(true)
    const different = fixture()
    expect((await f.chat([], parts, different.store).view()).messages.flatMap(m => m.dispatches ?? []).every(d => d.state === 'missing' && !d.ticketId)).toBe(true)
  })

  it('模型文字、其他工具、错配调用、失败回执及不合法标识都不能伪造工单导航', () => {
    const id = randomUUID(), meta = { 'dsh-chief/inbox': { eventId: id } }
    const fake = JSON.stringify(meta)
    const cases = [
      [event(1, 'assistant/message', { message: { content: [{ type: 'text', text: `打开工单对话 T-9999 ${fake}` }] } })],
      [event(1, 'tool/call', { name: 'chief_lookup', callId: 'a', arguments: '{}' }), event(2, 'tool/result', { message: { toolCallId: 'a', content: [] }, meta })],
      [event(1, 'tool/call', { name: 'chief_inbox', callId: 'a', arguments: '{}' }), event(2, 'tool/result', { message: { toolCallId: 'b', content: [] }, meta })],
      [event(1, 'tool/call', { name: 'chief_inbox', callId: 'a', arguments: '{}' }), event(2, 'tool/result', { message: { toolCallId: 'a', isError: true, content: [] }, meta })],
      [event(1, 'tool/call', { name: 'chief_inbox', callId: 'a', arguments: '{}' }), event(2, 'tool/result', { message: { toolCallId: 'a', content: [{ type: 'text', text: fake }] } })],
      [event(1, 'tool/call', { name: 'chief_inbox', callId: 'a', arguments: '{}' }), event(2, 'tool/result', { message: { toolCallId: 'a', content: [] }, meta: { 'dsh-chief/inbox': { eventId: 'T-9999' } } })],
    ]
    for (const events of cases) expect(chatFromEvents(events).messages.flatMap(m => m.dispatches ?? [])).toEqual([])
  })

  it('投递失败不产生回执或源事件；其他来源和错配工单的去向不会冒充交办', async () => {
    const f = fixture()
    await expect(f.inbox.execute({ text: ' ' }, { signal: new AbortController().signal, agent: { id: 'hq' } } as never)).rejects.toThrow('不能为空')
    expect(f.engine.recentEvents()).toEqual([])
    const id = randomUUID()
    f.store.appendEvent({ id, at: new Date().toISOString(), source: 'clock', text: '同文', dedupe: id, meta: { channel: 'chat' } })
    f.store.setDisposition(id, { kind: 'accepted', ticketId: 'T-0001' })
    expect(inboxDispatchState(f.store, id)).toBeUndefined()
  })

  it('页面对真实回执显示明确入口，对等待或失败显示状态，渲染不会自动跳转', () => {
    const openTicket = vi.fn(), id = randomUUID()
    const render = (dispatches?: ChatDispatch[]) => renderToStaticMarkup(<Chat messages={[{ seq: 1, role: 'liaison', time: 1, text: '已经交办。', ...dispatches ? { dispatches } : {} }]} notices={[]} busy={false}
      openTicket={openTicket} say={async () => true} draft="" setDraft={() => {}} inputRef={{ current: null }} empty={false} openImport={() => {}} />)
    expect(render([{ eventId: id, state: 'accepted', ticketId: 'T-0001' }])).toContain('执行与核验')
    expect(render([{ eventId: id, state: 'accepted', ticketId: 'T-0001' }])).toContain('T-0001')
    expect(render([{ eventId: id, state: 'pending' }])).toContain('等待研判')
    expect(render([{ eventId: id, state: 'unavailable' }])).not.toContain('执行与核验')
    expect(render()).not.toContain('执行与核验')
    expect(openTicket).not.toHaveBeenCalled()
  })
})
