import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { chatCursor, LiaisonChat, type LiaisonEditing } from '../src/dsh/chat.ts'
import { LiaisonTraces, liaisonForkPrefix, workspaceCarryEvents } from '../src/dsh/liaison-traces.ts'
import type { Agent, PendingInput, SessionController, SessionEventLike } from '../src/dsh/ports.ts'

const owner = (id: string, text: string) => ({ id: 'native-' + id, source: { kind: 'user', rpcId: id }, content: [{ type: 'text', text }] })
const event = (rows: SessionEventLike[], type: string, data: unknown = {}) => {
  rows.push({ type, data, seq: rows.length, time: 150_000 + rows.length })
}
function turn(rows: SessionEventLike[], id: string, text: string) {
  const words = owner(id, text)
  event(rows, 'agent/inbox/spliced', { target: 'next-turn', inserted: [words] })
  event(rows, 'turn/start')
  event(rows, 'agent/inbox/spliced', { target: 'next-turn', inserted: [], removedCount: 1 })
  event(rows, 'step/start')
  event(rows, 'user/message', words)
  event(rows, 'assistant/message', { message: { content: [{ type: 'text', text: '收到 ' + text }] } })
  event(rows, 'step/end')
  event(rows, 'turn/end')
}

it('normal segment carry keeps only owner inputs and scoped workspace receipt fields', () => {
  const rows: SessionEventLike[] = []
  for (let index = 1; index < 10; index++) turn(rows, 'old-' + index, '之前的消息 ' + index)
  const question = owner('carry','在研发组开场对话问交接日期。')
  event(rows, 'agent/inbox/spliced', {target:'next-step',inserted:[question]})
  event(rows, 'tool/call', {callId:'directory',name:'chief_workspace',arguments:'tool request payload'})
  event(rows, 'tool/result', {message:{toolCallId:'directory',content:[{type:'text',text:'tool response payload'}]},
    meta:{'dsh-chief/workspace':{id:'workspace-a',name:'研发组'},'example/other':'private connector metadata'}})
  event(rows, 'agent/inbox/spliced', {target:'next-turn',inserted:[owner('unadmitted','暂存但未进入回合')]})
  const retained = workspaceCarryEvents(rows)
  expect(retained.filter(row => row.type === 'user/message')).toHaveLength(8)
  expect(retained.slice(-3).map(row => row.data)).toEqual([question,
    {callId:'directory',name:'chief_workspace'},{message:{toolCallId:'directory'},meta:{'dsh-chief/workspace':{id:'workspace-a',name:'研发组'}}}])
  expect(JSON.stringify(retained)).not.toMatch(/payload|private connector metadata|unadmitted|old-1/)
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chief-liaison-edit-')), file = join(dir, 'traces.json')
  const original: SessionEventLike[] = []
  turn(original, 'a', '保留我')
  turn(original, 'b', '重复原话')
  turn(original, 'c', '重复原话')
  const native = new Map([['hq', original]])
  const queued = new Map<string, PendingInput[]>()
  const resolve = (id: string): Agent => {
    const rows = native.get(id)!
    const inbox = queued.get(id) ?? []
    queued.set(id, inbox)
    return {
      id, status: 'idle', session: { snapshotEvents: () => rows },
      inbox: { nextStep: [], nextTurn: inbox, remove(key) {
        const index = inbox.findIndex(message => message.id === key)
        if (index === -1) return false
        inbox.splice(index, 1)
        return true
      }, prepend: () => {} },
    }
  }
  const prompt = vi.fn<SessionController['prompt']>(async request => {
    const rows = native.get(request.sessionId)!
    const text = request.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
    expect(resolve(request.sessionId).inbox?.nextTurn).toEqual([])
    turn(rows, request.requestId, text)
    return { accepted: true }
  })
  let childCount = 0
  const fork = vi.fn<NonNullable<SessionController['fork']>>(async target => {
    const id = 'child-' + ++childCount
    const rows = native.get(target.sessionId)!.filter(row => row.seq <= target.atSeq)
    if (rows.findLast(row => row.type === 'turn/start')?.seq! > rows.findLast(row => row.type === 'turn/end')?.seq!) event(rows, 'turn/end')
    native.set(id, rows)
    queued.set(id, [{ id: 'old-pending', source: {kind:'user', rpcId:'not-accepted'} }])
    return { sessionId: id }
  })
  const controller: SessionController = { fork, prompt, resolveAgent: async id => ({agent:resolve(id)}),
    create: async ({sessionId}) => { if (sessionId) native.set(sessionId, []) }, rename: async () => {} }
  const reopen = () => {
    const traces = new LiaisonTraces(file, 'hq')
    const binding = () => traces.binding ?? { segments: [{ id:'hq', offset:0 }], archived: [] }
    const current = () => binding().segments.at(-1)!.id
    const editing: LiaisonEditing = { traces, binding, waitRotation: async () => {}, events: async id => native.get(id)!,
      origin: () => undefined, checkPrefix: () => {}, create: async id => { native.set(id, []) },
      prepare: async id => resolve(id), deliver: async (_edit, send) => send(), assertCurrent: () => {} }
    const parts = { base: () => traces.sessionId, current, offset: () => binding().segments.at(-1)!.offset,
      archived: () => binding().archived, ready: async () => {} }
    const chat = new LiaisonChat(controller, parts, async () => resolve(current()),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, editing)
    return { chat, traces }
  }
  return { ...reopen(), reopen, original, file, native, fork, prompt, resolve }
}
const edit = { sessionId: 'hq', requestId: 'edit-one', expectedTraceId: 'initial', text: '修订后' }
const words = async (chat: LiaisonChat, trace?: string) => (await chat.view(undefined, trace)).messages.filter(message => message.role === 'you').map(message => message.text)

describe('接口人编辑历史消息', () => {
  it('按精确光标 fork 重复原话，冻结旧消息、清空旧输入并让同请求只派发一次', async () => {
    const f = fixture()
    const initial = (await f.chat.view()).messages
    const anchor = chatCursor(initial.find(message => message.requestId === 'b')!)
    const original = f.resolve('hq')
    const queued = original.inbox!.nextTurn as PendingInput[]
    queued.push({id:'queued-on-original',source:{kind:'user',rpcId:'queued'}})
    const [revised, replay] = await Promise.all([f.chat.edit(anchor, edit), f.chat.edit(anchor, edit)])
    expect(replay).toEqual(revised)
    expect(revised.sessionId).toBe('hq')
    expect(f.fork).toHaveBeenCalledExactlyOnceWith({ sessionId: 'hq', atSeq: 7 })
    expect(f.prompt).toHaveBeenCalledTimes(1)
    expect(original.inbox?.nextTurn).toEqual([])
    expect(await words(f.chat)).toEqual(['保留我', '修订后'])
    expect(await words(f.chat, 'initial')).toEqual(['保留我', '重复原话', '重复原话'])
    expect((await f.chat.view({ limit:10, around: revised.messageId })).messages.some(row => row.messageId === revised.messageId)).toBe(true)
    expect((await f.chat.view(undefined, 'initial')).messages.every(row => !row.canEdit)).toBe(true)
    await expect(f.chat.source('hq','native-b')).resolves.toEqual({sessionId:'hq',traceId:'initial',messageId:anchor})
    await expect(f.chat.source('outside','native-b')).rejects.toMatchObject({status:404})
    await expect(f.chat.say('另一窗口', 'queue', 'hq', 'stale', [], 'initial')).rejects.toMatchObject({status:409})
    await expect(f.chat.edit(anchor, { ...edit, text:'不同正文' })).rejects.toMatchObject({status:409})
    await expect(f.chat.edit(anchor, { ...edit, requestId:'other-tab' })).rejects.toMatchObject({status:409})
    event(f.original, 'assistant/message', { message:{ content:[{type:'text',text:'旧回合迟到'}] } })
    const loaded = f.reopen().chat
    expect(await loaded.edit(anchor, edit)).toEqual(revised)
    expect((await loaded.view(undefined, 'initial')).messages.some(row => row.text.includes('迟到'))).toBe(false)
    const again = await loaded.edit(revised.messageId, {...edit, requestId:'edit-two', expectedTraceId:revised.traceId, text:'再编辑'})
    expect(again.sessionId).toBe('hq')
    expect(await words(loaded)).toEqual(['保留我', '再编辑'])
    expect(await words(loaded, revised.traceId)).toEqual(['保留我', '修订后'])
    expect(f.prompt).toHaveBeenCalledTimes(2)
  })

  it('换段后使用原生旧段坐标，并按原会话 ID 打开包含所有旧段的快照', async () => {
    const f = fixture()
    const old = (await f.chat.view()).messages
    const current: SessionEventLike[] = []
    turn(current,'after-rotation','换段以后的话')
    f.native.set('hq-p2', current.map(row=>({...row, time:row.time+5_000})))
    f.traces.rotate({ segments: [{id:'hq',offset:0}, {id:'hq-p2',offset:1_000_000_000}], archived:old })
    const anchor = chatCursor(old.find(message => message.requestId === 'b')!)
    expect((await f.chat.view()).messages.find(message => message.requestId === 'after-rotation')?.seq).toBe(1_000_000_004)
    const revised = await f.chat.edit(anchor, edit)
    expect(revised.sessionId).toBe('hq')
    expect(f.fork).toHaveBeenCalledExactlyOnceWith({sessionId:'hq',atSeq:7})
    expect(await words(f.chat, 'initial')).toEqual(['保留我','重复原话','重复原话','换段以后的话'])
    expect(await words(f.chat)).toEqual(['保留我','修订后'])
  })

  it('快照准备失败保留源对话和收件箱', async () => {
    const f = fixture(), anchor = chatCursor((await f.chat.view()).messages[2]!)
    mkdirSync(f.file + '.' + process.pid + '.tmp')
    await expect(f.chat.edit(anchor, edit)).rejects.toMatchObject({ code:'EISDIR' })
    expect(await words(f.chat)).toEqual(['保留我', '重复原话', '重复原话'])
    expect(f.chat.activeTrace()).toBe('initial')
    expect(f.fork).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
  })

  it('投递结果未知时恢复先看原生收据，不重复发出改稿', async () => {
    const f = fixture(), anchor = chatCursor((await f.chat.view()).messages[2]!)
    f.prompt.mockRejectedValueOnce(Error('connection lost'))
    await expect(f.chat.edit(anchor, edit)).rejects.toThrow('connection lost')
    const loaded = f.reopen()
    await expect(loaded.chat.recoverEdit()).rejects.toMatchObject({status:503})
    expect(f.prompt).toHaveBeenCalledTimes(1)
    const pending = loaded.traces.activeEdit()!
    const rows = f.native.get(pending.nativeId!)!
    event(rows, 'agent/inbox/spliced', { target:'next-turn', inserted:[owner(pending.messageId, edit.text)] })
    event(rows, 'agent/inbox/spliced', { target:'next-turn', inserted:[], removedCount:1 })
    await loaded.chat.recoverEdit()
    expect(await loaded.chat.edit(anchor, edit)).toMatchObject({ traceId: pending.traceId, messageId: pending.messageId })
    expect(f.prompt).toHaveBeenCalledTimes(1)
  })

  it('保留排队期间已经公开的前缀，以及同一步先被接纳的主人消息', () => {
    const rows: SessionEventLike[] = []
    const before = owner('previous','此前原话'), target = owner('target','准备修改'), other = owner('other','并行已接纳')
    event(rows, 'agent/inbox/spliced',{ inserted:[before,target,other] })
    event(rows, 'turn/start')
    event(rows, 'step/start')
    event(rows, 'user/message',before)
    event(rows, 'assistant/message',{message:{content:[{type:'text',text:'已经回了'}]}})
    event(rows, 'step/end')
    event(rows, 'step/start')
    event(rows, 'user/message',other)
    event(rows, 'user/message',target)
    const prefix = liaisonForkPrefix(rows, 8, { role:'you', requestId:'target', seq:8, text:'准备修改', time:0 })
    expect(prefix.events.at(-1)).toBe(rows[7])
    expect(prefix.text).toBe('准备修改')
  })
})
