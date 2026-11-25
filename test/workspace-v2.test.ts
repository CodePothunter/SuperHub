import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_ARCHIVED } from '../src/core/workspace-v2.ts'
import type { V2CodingPermission, V2Delegation, V2DialogueSource, V2PendingApproval, V2Message, V2Session, V2SessionView, V2Workspace, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import { serveApi, type Via } from '../src/dsh/http.ts'
import { workspaceV2Routes, type WorkspaceApprovals } from '../src/dsh/workspace-v2.ts'
import { commandApprovals } from '../src/dsh/approvals.ts'
import { CodingGate, GATE_TOKEN_ENV } from '../src/dsh/coding-gate.ts'
import type { HostContext } from '../src/dsh/ports.ts'
import { mutationKey, assignmentTurn, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'

const scope = 'brain-a'
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

function fixture(turnLimit = 4, approvals?: WorkspaceApprovals) {
  const root = mkdtempSync(join(tmpdir(), 'superhub-v2-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const messages = new Map<string, V2Message[]>()
  const source = {
    read: vi.fn<V2DialogueSource['read']>(async s => ({ messages: messages.get(s.id) ?? [] })),
    send: vi.fn<V2DialogueSource['send']>(async () => {}),
    confirmed: vi.fn<NonNullable<V2DialogueSource['confirmed']>>(async () => false),
    attachment: vi.fn<V2DialogueSource['attachment']>(async () => undefined),
  }
  let store: WorkspaceV2Store
  const mount = () => {
    store = new WorkspaceV2Store(root, scope, turnLimit)
    return workspaceV2Routes({ store, source, approvals })
  }
  let route = mount()
  const restart = () => { route.dispose(); route = mount(); route.recover() }
  cleanup.push(() => { route.dispose() })
  type Options = { scope?: string | null; owner?: boolean; via?: Via; marker?: boolean; prefix?: string }
  async function call<T = { error: string }>(path: string, body?: Record<string, unknown>, options: Options = {}) {
    const url = new URL((options.prefix ?? '/chief/api/v2/workspaces') + path, 'http://local')
    if (options.scope !== null) url.searchParams.set('scope', options.scope ?? scope)
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method: body ? 'POST' : 'GET', url: url.pathname + url.search,
      headers: options.marker === false ? {} : { 'x-chief-request': '1' },
    }) as unknown as IncomingMessage
    let status = 0, data: T
    const res = { writeHead(code: number) { status = code }, end(value: string) { data = JSON.parse(value) } } as unknown as ServerResponse
    await serveApi(req, res, options.via ?? 'dsh', [route], options.owner ?? true)
    return { status, data: data! }
  }
  let serial = 0
  const id = () => 'test-' + ++serial
  const workspace = async (name = '产品研发') => {
    const r = await call<{ workspace: V2Workspace }>('', { requestId: id(), name, goal: '交付手机报名页' })
    expect(r.status).toBe(200)
    return r.data.workspace
  }
  const job = async (w: V2Workspace, title = '文案初稿', session?:V2Session) => {
    const r = await call<{ order: V2Delegation }>('/' + w.id + '/orders', { requestId: id(), title,
      ...(session ? { sessionId:session.id } : {executor:'claude-code'}) })
    expect(r.status).toBe(200)
    return r.data.order
  }
  const session = async (w: V2Workspace, kind: 'coding' | 'group' = 'coding') => {
    const r = await call<{ session: V2Session }>('/' + w.id + '/sessions', {
      requestId: id(), title: kind === 'coding' ? '移动端实现' : '验收群', kind,
      executor: kind === 'coding' ? 'claude-code' : 'dsh',
    })
    expect(r.status).toBe(200)
    return r.data.session
  }
  const path = (s: V2Session) => '/' + s.workspaceId + '/sessions/' + s.id
  const view = async (w: V2Workspace) => (await call<V2WorkspaceView>('/' + w.id)).data
  const send = (s: V2Session, text: string, requestId = id(), workOrderId?:string) => call(path(s) + '/messages', { requestId, text, workOrderId })
  const act = (d: V2Delegation, action: string, extra: Record<string, unknown> = {}) =>
    call<{ delegation: V2Delegation }>('/' + d.workspaceId + '/delegations/' + d.id + '/action', { requestId: id(), action, ...extra })
  return { call, source, messages, restart, workspace, job, session, path, view, send, act, root,
    forOrder:(d:V2Delegation) => store.session(d.workspaceId,d.sessionId), accept:() => route.assign, follow:() => route.follow,
    store: () => store, assign: (id:string,text:string, selected?:string) => route.assign(id,text,'codex',selected) }
}

describe('SuperHub 2.0 workspace routes', () => {
  it('entrusts the original result to the appropriate native conversation with no product mode', async () => {
    const f = fixture()
    const text = '整理一份周五活动清单'
    const job = f.accept()('weekend',text)
    expect(job.session).toMatchObject({kind:'group',executor:'dsh',title:text,delegationIds:[job.delegation.id]})
    expect(job.delegation).toMatchObject({sessionId:job.session.id,title:text,promise:text,owner:'接口人'})
    expect(job.delegation).not.toHaveProperty('deliveryKind')
    await vi.waitFor(() => expect(f.source.send).toHaveBeenCalledTimes(1))
    expect(f.source.send.mock.calls[0]![1]).toMatchObject({text,workOrderId:job.delegation.id})
    const path = '/'+job.workspace.id+'/orders'
    // The retired delivery check has no route any more.
    expect((await f.call(path+'/'+job.delegation.id+'/delivery')).status).toBe(404)
    const restored = await f.call<{order:V2Delegation}>(path,{requestId:'older-client',title:'画一张地图',deliveryKind:'mobile-signup'})
    expect(restored.data.order).not.toHaveProperty('deliveryKind')
    expect(restored.data.order.promise).toBe('画一张地图')
    expect(f.forOrder(restored.data.order)).toMatchObject({kind:'group',executor:'dsh'})
    expect(f.accept()('named','让 Claude Code 实现表格导出','claude-code').session).toMatchObject({kind:'coding',executor:'claude-code'})
    expect(() => f.accept()('weekend','换个目标')).toThrow('另一项操作')
  })

  it('migrates old many-to-many and unbound orders with the original first brief and receipt preserved exactly once', async () => {
    const f=fixture(), source='old-owner-turn', text='做一个报名页'
    const original = f.store().assign(source,text,'codex')
    const extra = await f.session(original.workspace), orphan = await f.job(original.workspace,'旧的独立工单')
    const path=join(f.root,'ops','superhub-v2',workspaceFingerprint(scope)+'.json')
    const board=JSON.parse(readFileSync(path,'utf8'))
    board.schema=1
    for (const order of board.delegations) delete order.sessionId
    board.delegations[0].deliveryKind='mobile-signup'
    board.sessions.find((s:V2Session) => s.id===extra.id).delegationIds=[original.delegation.id,orphan.id]
    board.sessions.find((s:V2Session) => s.id===orphan.sessionId).delegationIds=[]
    const bare = {...board.delegations[1],id:'unbound-old'}
    board.delegations.push(bare)
    const oldKey=createHash('sha256').update('signup:'+source).digest('hex')
    const currentId=original.firstRequestId.slice('start-'.length)
    const entry=board.receipts['req-'+currentId]
    delete entry.result.delegation.sessionId
    entry.hash=mutationKey(['liaison','signup'],{requestId:oldKey,text,executor:'codex',selected:null}).hash
    delete board.receipts['req-'+currentId]
    board.receipts['req-'+oldKey]=entry
    board.signupStarts=board.starts.map((s:{requestId:string})=>({...s,requestId:'start-'+oldKey}))
    delete board.starts
    writeFileSync(path,JSON.stringify(board))
    f.restart()
    const replay=f.accept()(source,text,undefined,undefined)
    expect(replay.session.id).toBe(original.session.id)
    expect(replay.delegation.sessionId).toBe(original.session.id)
    await vi.waitFor(() => expect(f.source.send).toHaveBeenCalledTimes(1))
    expect(f.source.send.mock.calls[0]![1]).toMatchObject({id:'start-'+oldKey,workOrderId:original.delegation.id,text})
    const migrated=await f.view(original.workspace)
    expect(migrated.orders.find(o=>o.id===original.delegation.id)).toMatchObject({sessionId:original.session.id,historySessionIds:[extra.id],remainingTurns:3})
    expect(migrated.sessions.find(s=>s.id===extra.id)).toMatchObject({sharedHistory:true,delegationIds:[orphan.id]})
    const created=migrated.orders.find(o=>o.id===bare.id)!.sessionId
    expect(migrated.sessions.find(s=>s.id===created)).toMatchObject({kind:'group',delegationIds:[bare.id]})
    expect((await f.send(extra,'旧场不能再推进原工单',undefined,original.delegation.id)).status).toBe(409)
    f.restart()
    expect((await f.view(original.workspace)).orders).toEqual(migrated.orders)
    expect(f.accept()(source,text).delegation.id).toBe(original.delegation.id)
    expect(f.source.send).toHaveBeenCalledTimes(1)
  })

  it('accepts two separate orders inside the selected native conversation and queues the original words of both', async () => {
    const f=fixture(), w=await f.workspace(), s=await f.session(w,'group')
    const started=Promise.withResolvers<void>(), release=Promise.withResolvers<void>()
    f.source.send.mockImplementationOnce(async () => {started.resolve(); await release.promise})
    const one=f.accept()('first-note','整理三条要点',undefined,w.id,s.id)
    await started.promise
    const two=f.accept()('second-note','列一份核对清单',undefined,w.id,s.id)
    expect(one.session.id).toBe(s.id)
    expect(two.session.id).toBe(s.id)
    expect(f.store().pendingStarts().map(p=>p.text)).toEqual(['列一份核对清单'])
    expect(f.store().focus({surface:'workspace',selectedId:w.id,sessionId:s.id,workOrderId:two.delegation.id})?.order?.id).toBe(two.delegation.id)
    expect(f.store().focus({surface:'calendar',selectedId:w.id,sessionId:s.id,workOrderId:two.delegation.id})).toBeUndefined()
    const foreign=await f.workspace('外部项目')
    expect(f.store().focus({surface:'workspace',selectedId:foreign.id,sessionId:s.id,workOrderId:two.delegation.id})?.session).toBeUndefined()
    release.resolve()
    await vi.waitFor(() => expect(f.source.send).toHaveBeenCalledTimes(2))
    expect(f.source.send.mock.calls.map(([,t])=>[t.text,t.workOrderId])).toEqual([['整理三条要点',one.delegation.id],['列一份核对清单',two.delegation.id]])
    expect(f.store().pendingStarts()).toEqual([])
    await f.follow()('follow-up','把第二条写短些',w.id,one.delegation.id)
    await f.follow()('follow-up','把第二条写短些',w.id,one.delegation.id)
    expect(f.source.send).toHaveBeenCalledTimes(3)
    expect((await f.view(w)).orders.map(o=>o.remainingTurns)).toEqual([2,3])
    await expect(f.follow()('follow-up','把第二条写短些',w.id,two.delegation.id)).rejects.toThrow('另一项操作')
  })

  it('accepts supplements while busy and dispatches them once in FIFO order alongside newly assigned work', async () => {
    const f=fixture(3), w=await f.workspace(), s=await f.session(w,'group')
    const started=Promise.withResolvers<void>(), release=Promise.withResolvers<void>()
    f.source.send.mockImplementationOnce(async () => {started.resolve(); await release.promise})
    const a=f.accept()('first','拟好议程',undefined,w.id,s.id)
    await started.promise
    const b=f.accept()('second','拟好出席清单',undefined,w.id,s.id)
    const addition=()=>f.follow()('add-agenda','议程加一个问答环节',w.id,a.delegation.id)
    expect((await addition()).state).toBe('queued')
    expect((await f.follow()('add-list','清单留一列备注',w.id,b.delegation.id)).state).toBe('queued')
    expect((await addition()).state).toBe('queued')
    expect(f.store().pendingStarts(s.id).map(x=>x.delegationId)).toEqual([b.delegation.id,a.delegation.id,b.delegation.id])
    expect((await f.view(w)).orders.map(o=>o.remainingTurns)).toEqual([2,3])
    await expect(f.follow()('add-agenda','议程加一个问答环节',w.id,b.delegation.id)).rejects.toThrow('另一项操作')
    release.resolve()
    await vi.waitFor(()=>expect(f.store().pendingStarts()).toHaveLength(0))
    expect(f.source.send.mock.calls.map(([,turn])=>[turn.workOrderId,turn.text])).toEqual([
      [a.delegation.id,'拟好议程'],[b.delegation.id,'拟好出席清单'],[a.delegation.id,'议程加一个问答环节'],[b.delegation.id,'清单留一列备注']])
    expect((await addition()).state).toBe('sent')
    expect((await f.view(w)).orders.map(o=>o.remainingTurns)).toEqual([1,1])
  })

  it('recovers queued supplements after restart, never replays an uncertain native turn, and retires canceled supplements', async () => {
    const f=fixture(2),w=await f.workspace(),s=await f.session(w,'group')
    const a=await f.job(w,'原文',s),b=await f.job(w,'清单',s)
    const started=Promise.withResolvers<void>(), release=Promise.withResolvers<void>()
    f.source.send.mockImplementationOnce(async () => {started.resolve(); await release.promise})
    const prior=f.follow()('in-progress','正在执行的补充',w.id,a.id)
    await started.promise
    expect((await prior).state).toBe('queued')
    await f.follow()('known-unsent','仍在排队的原话',w.id,a.id)
    await expect(f.follow()('over-budget','额度之外的补充',w.id,a.id)).rejects.toThrow('额度')
    await f.follow()('withdrawn','准备改期的清单',w.id,b.id)
    await f.act(b,'pause')
    await f.act(b,'resume')
    expect((await f.follow()('withdrawn','准备改期的清单',w.id,b.id)).state).toBe('stopped')
    await f.call(f.path(s)+'/close',{requestId:'close-during-queue'})
    await expect(f.follow()('while-closed','新的补充',w.id,a.id)).rejects.toThrow('重新打开')
    f.restart()
    await vi.waitFor(()=>expect(f.source.send).toHaveBeenCalledTimes(2))
    expect(f.source.send.mock.calls.map(([,turn])=>turn.text)).toEqual(['正在执行的补充','仍在排队的原话'])
    expect((await f.follow()('in-progress','正在执行的补充',w.id,a.id)).state).toBe('unknown')
    expect((await f.follow()('known-unsent','仍在排队的原话',w.id,a.id)).state).toBe('sent')
    release.resolve()
    f.restart()
    expect(f.store().pendingStarts()).toEqual([])
    expect((await f.view(w)).orders.map(o=>o.remainingTurns)).toEqual([0,2])
    expect(f.source.send).toHaveBeenCalledTimes(2)
  })

  it('restores a committed first brief exactly once, including the original words after the conversation was closed', async () => {
    const f = fixture(4), text = '手机报名页，' + '保留项目的原有配色。'.repeat(30), requestId = 'durable-start'
    // Crash boundary between accepting the liaison assignment and reserving its native turn.
    const accepted = f.store().assign(requestId, text, 'codex')
    expect(accepted.delegation.title.length).toBeLessThan(text.length)
    expect(f.store().pendingStarts()).toMatchObject([{sessionId:accepted.session.id,text,generation:1}])
    await f.call(f.path(accepted.session)+'/close',{requestId:'closed'})
    f.restart()
    await vi.waitFor(() => expect(f.source.send).toHaveBeenCalledTimes(1))
    expect(f.source.send.mock.calls[0]![1]).toMatchObject({id:accepted.firstRequestId,text,acceptedStart:true,workOrderId:accepted.delegation.id})
    expect(f.store().pendingStarts()).toEqual([])
    expect((await f.view(accepted.workspace)).delegations[0]?.remainingTurns).toBe(3)
    f.restart()
    expect(f.assign(requestId,text).session.id).toBe(accepted.session.id)
    await Promise.resolve()
    expect(f.source.send).toHaveBeenCalledTimes(1)
  })

  it('does not replay an already reserved uncertain start or a first brief whose authorization has changed', async () => {
    const f = fixture(3), enqueue = (id:string) => {
      const text = '请做可试填报名页'
      return {text,...f.store().assign(id,text,'codex')}
    }
    const reserved = enqueue('reserved'), changed = enqueue('changed')
    f.store().reserve(assignmentTurn(reserved.workspace.id,reserved.session.id,reserved.firstRequestId,reserved.text),reserved.session,reserved.delegation.id,1)
    await f.act(changed.delegation,'pause',{expectedGeneration:1})
    await f.act(changed.delegation,'resume',{expectedGeneration:2})
    f.restart()
    f.assign('reserved',reserved.text)
    f.assign('changed',changed.text)
    await vi.waitFor(() => expect(f.source.confirmed).toHaveBeenCalled())
    expect(f.source.send).not.toHaveBeenCalled()
    const view = await f.view(reserved.workspace)
    expect(view.delegations.find(job=>job.id===reserved.delegation.id)).toMatchObject({remainingTurns:2,reason:expect.stringContaining('待核对')})
    expect(view.delegations.find(job=>job.id===changed.delegation.id)).toMatchObject({remainingTurns:3,generation:3})
  })

  it('requires authenticated owner, POST marker, current scope, and stable request identities', async () => {
    const { call } = fixture()
    const body = { requestId: 'fresh', name: '工作', goal: '独立的业务目标' }
    expect((await call('', undefined, { scope: null })).data).toEqual({ scope, workspaces: [] })
    expect((await call('', undefined, { owner: false })).status).toBe(403)
    expect((await call('', body, { marker: false })).status).toBe(403)
    expect((await call('', body, { scope: null })).status).toBe(409)
    expect((await call('', body, { scope: 'other' })).status).toBe(409)
    expect((await call('', { ...body, scope: 'mismatch' })).status).toBe(409)
    const first = await call<{ workspace: V2Workspace }>('', body, { via: 'public' })
    expect(first.status).toBe(200)
    expect(await call('', { goal: body.goal, name: body.name, requestId: body.requestId })).toEqual(first)
    expect((await call('', { ...body, goal: '换了个目标' })).status).toBe(409)
    expect((await call('', { requestId: 'bad/id', name: 'X', goal: 'Y' })).status).toBe(400)
    expect((await call('', { requestId: 'bad', name: '   ', goal: 'Z' })).status).toBe(400)
    expect((await call('', undefined, { scope: null })).data).toEqual({ scope, workspaces: [first.data.workspace] })
  })

  it('binds each work order to one conversation and preserves its history when that conversation closes', async () => {
    const f = fixture(), a = await f.workspace(), b = await f.workspace('客户')
    const group = await f.session(a,'group'), single = await f.session(a)
    const j = await f.job(a,'初稿',group), k = await f.job(a,'清单',group), foreign = await f.job(b)
    const create = {requestId:'cross-space', title:'试图抢单', delegationIds:[foreign.id], kind:'coding', executor:'codex'}
    expect((await f.call('/'+a.id+'/sessions',create)).status).toBe(404)
    expect((await f.call('/'+a.id+'/sessions',{...create,delegationIds:[j.id]})).status).toBe(409)
    expect((await f.call('/'+a.id+'/orders',{requestId:'bad-session',title:'跨区',sessionId:foreign.sessionId})).status).toBe(404)
    expect((await f.call('/'+b.id+'/sessions/'+group.id)).status).toBe(404)
    expect((await f.send(single,'试图推进别的会话工单',undefined,j.id)).status).toBe(409)
    expect(f.source.send).not.toHaveBeenCalled()
    await f.act(j,'narrow',{boundary:'限内部试用。',expectedGeneration:1})
    expect((await f.act(j,'cancel',{expectedGeneration:1})).status).toBe(409)
    await f.act(j,'narrow',{boundary:'只用匿名样本。',expectedGeneration:2})
    await f.send(group,'交第一份草稿',undefined,j.id)
    const first = f.source.send.mock.calls[0]![1]
    expect(first.workOrderId).toBe(j.id)
    expect(first.context?.delegations.map(d=>d.id)).toEqual([j.id])
    expect(first.context?.decisions.map(d=>d.text)).toEqual(['只用匿名样本。'])
    await f.send(group,'聊聊怎么分工')
    expect(f.source.send.mock.calls[1]![1].context?.delegations).toEqual([])
    expect(f.source.send.mock.calls[1]![1].workOrderId).toBeUndefined()
    await f.call(f.path(group)+'/close',{requestId:'close-shared'})
    f.restart()
    const detail = await f.view(a)
    expect(detail.orders).toEqual(detail.delegations)
    expect(detail.orders.map(order=>order.sessionId)).toEqual([group.id,group.id])
    expect(detail.sessions.find(s=>s.id===group.id)).toMatchObject({closed:true,delegationIds:[j.id,k.id]})
    expect(detail.orders.find(order=>order.id===k.id)?.remainingTurns).toBe(4)
    expect((await f.call('/'+a.id+'/orders/'+j.id)).data).toMatchObject({order:{sessionId:group.id}})
    expect((await f.send(group,'关闭后继续')).status).toBe(409)
    expect((await f.view(b)).orders.map(o=>o.id)).toEqual([foreign.id])
  })

  it('coalesces concurrent retries and charges only the selected work order in a shared session',async () => {
    const f = fixture(2), w = await f.workspace(), s = await f.session(w), j = await f.job(w,'第一份文稿',s), k = await f.job(w,'第二份文稿',s)
    const started = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>()
    f.source.send.mockImplementationOnce(async (_s,_turn,signal) => {started.resolve(signal); await release.promise})
    const first = f.send(s,' 原文\n保留 ','same',j.id)
    const signal = await started.promise
    const duplicate = f.send(s,' 原文\n保留 ','same',j.id)
    // Words for the other order cannot join this order's turn; they wait for the next one, and pausing that order stops them.
    const other = await f.send(s,'另一条消息',undefined,k.id)
    expect(other).toMatchObject({status:200,data:{delivery:'queued'}})
    expect((await f.send(s,'其他内容','same',j.id)).status).toBe(409)
    await f.act(k,'pause')
    expect(signal.aborted).toBe(false)
    expect((await f.view(w)).orders.map(o=>o.remainingTurns)).toEqual([1,2])
    release.resolve()
    expect((await Promise.all([first,duplicate])).map(r=>r.status)).toEqual([200,200])
    f.restart()
    expect((await f.send(s,' 原文\n保留 ','same',j.id)).status).toBe(200)
    expect((await f.send(s,'再核对一次',undefined,j.id)).status).toBe(200)
    expect((await f.send(s,'超额',undefined,j.id)).status).toBe(409)
    expect((await f.send(s,'继续另一张暂停工单',undefined,k.id)).status).toBe(409)
    expect(f.source.send).toHaveBeenCalledTimes(2)
    expect((await f.view(w)).orders.map(o=>o.remainingTurns)).toEqual([0,2])
    expect((await f.act(j,'resume')).status).toBe(409)
  })

  it('revokes only work bound to the changed authority, and late completion never reopens a canceled delegation', async () => {
    const f = fixture(), w = await f.workspace(), j = await f.job(w)
    const s = f.forOrder(j)
    const started = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>()
    f.source.send.mockImplementationOnce(async (_s, _input, signal) => { started.resolve(signal); await release.promise })
    const running = f.send(s, '检查')
    const signal = await started.promise
    const paused = await f.act(j, 'pause', { requestId: 'pause-1' })
    expect(signal.aborted).toBe(true)
    expect(paused.data.delegation).toMatchObject({ paused: true, remainingTurns: 3 })
    expect((await f.send(s, '暂停后继续')).status).toBe(409)
    const resumed = await f.act(j, 'resume')
    expect(resumed.data.delegation).toMatchObject({ status: 'accepted', remainingTurns: 3 })
    expect(resumed.data.delegation.paused).not.toBe(true)
    await f.act(j, 'cancel', { reason: '本周取消试用' })
    release.resolve()
    await running
    expect((await f.view(w)).delegations[0]).toMatchObject({ status: 'closed', reason: '本周取消试用', generation: 4 })
    expect((await f.act(j, 'pause', { requestId: 'pause-1' })).data).toEqual(paused.data)
    expect((await f.view(w)).delegations[0]?.status).toBe('closed')
    expect((await f.send(s, '取消后继续')).status).toBe(409)
    expect(f.source.send).toHaveBeenCalledTimes(1)
  })

  it('preserves uncertain sends on restart and refunds only definite pre-dispatch failures', async () => {
    const f = fixture(3), w = await f.workspace(), j = await f.job(w), s = f.forOrder(j)
    f.source.send.mockRejectedValueOnce(Object.assign(Error('Codex 暂不可用'), { dispatched: false }))
    expect((await f.send(s, '正文', 'before-send')).status).toBe(503)
    expect((await f.view(w)).delegations[0]?.remainingTurns).toBe(3)
    expect((await f.send(s, '正文', 'before-send')).status).toBe(200)
    const replied = (await f.view(w)).delegations[0]
    expect(replied?.status).toBe('waiting')
    expect(replied?.paused).not.toBe(true)
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    f.source.send.mockImplementationOnce(async () => { started.resolve(); await release.promise })
    const running = f.send(s, '结果待核对', 'unknown-request')
    await started.promise
    f.restart()
    expect((await f.send(s, '结果待核对', 'unknown-request')).status).toBe(409)
    const uncertain = (await f.call<V2SessionView>(f.path(s))).data
    expect(uncertain.messages).toEqual([])
    expect(uncertain.issue).toContain('待核对')
    expect((await f.view(w)).delegations[0]).toMatchObject({ status: 'waiting', remainingTurns: 1 })
    release.resolve()
    expect((await running).status).toBe(409)
    f.source.send.mockRejectedValueOnce(Error('unexpected native data'))
    expect((await f.send(s, '下一件事', 'dropped')).status).toBe(409)
    expect((await f.send(s, '下一件事', 'dropped')).status).toBe(409)
    expect(f.source.send).toHaveBeenCalledTimes(4)
    expect((await f.view(w)).delegations[0]?.remainingTurns).toBe(0)
  })

  it('retains an explicit pause across a restart and closing a conversation preserves the already accepted turn', async () => {
    const f = fixture(), w = await f.workspace(), j = await f.job(w), s = f.forOrder(j)
    await f.act(j, 'pause')
    f.restart()
    expect((await f.view(w)).delegations[0]?.paused).toBe(true)
    expect((await f.send(s, '继续')).status).toBe(409)
    await f.act(j, 'resume')
    const started = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>()
    f.source.send.mockImplementationOnce(async (_s, _input, signal) => { started.resolve(signal); await release.promise })
    const running = f.send(s, '这条已授权的工作仍可返回')
    const signal = await started.promise
    expect((await f.call(f.path(s) + '/close', { requestId: 'close' })).status).toBe(200)
    expect(signal.aborted).toBe(false)
    release.resolve()
    expect((await running).status).toBe(200)
    const view = await f.view(w)
    expect(view.delegations[0]).toMatchObject({ status: 'waiting', remainingTurns: 3 })
    // No recurring schedule: no follow-up time is shown (a stored one is kept but not displayed).
    expect(view.delegations[0]).not.toHaveProperty('nextCheckAt')
    expect(view.delegations[0]?.paused).not.toBe(true)
    expect((await f.send(s, '另一条消息')).status).toBe(409)
  })

  it('reopens the same conversation without renewing any of its work orders or resetting their budgets', async () => {
    const f=fixture(2),w=await f.workspace(),s=await f.session(w)
    const open=await f.job(w,'继续研判',s),paused=await f.job(w,'等答复',s),closed=await f.job(w,'已取消',s)
    await f.send(s,'第一次研判',undefined,open.id)
    await f.act(paused,'pause')
    await f.act(closed,'cancel')
    const before=(await f.view(w)).orders
    await f.call(f.path(s)+'/close',{requestId:'close-before-reopen'})
    f.restart()
    const reopened=await f.call<{session:V2Session}>(f.path(s)+'/reopen',{requestId:'reopen'})
    expect(reopened.data.session).toMatchObject({id:s.id,closed:false,delegationIds:[open.id,paused.id,closed.id]})
    expect(await f.call(f.path(s)+'/reopen',{requestId:'reopen'})).toEqual(reopened)
    expect((await f.view(w)).orders).toEqual(before)
    expect((await f.send(s,'继续研判',undefined,open.id)).status).toBe(200)
    expect((await f.send(s,'暂停仍有效',undefined,paused.id)).status).toBe(409)
    expect((await f.send(s,'取消仍有效',undefined,closed.id)).status).toBe(409)
    expect((await f.view(w)).orders[0]?.remainingTurns).toBe(0)
  })

  it('reconciles only a positively acknowledged turn after restart without charging again or reviving canceled work', async () => {
    const f = fixture(), w = await f.workspace(), j = await f.job(w), s = f.forOrder(j)
    f.source.send.mockRejectedValue(new Error('receipt unavailable'))
    const first = 'lost-ack', second = 'another-lost-ack'
    expect((await f.send(s, '检查姓名', first)).status).toBe(409)
    expect((await f.send(s, '检查邮箱', second)).status).toBe(409)
    f.restart()
    f.source.confirmed.mockImplementation(async (session, id) => session.id === s.id && id === first)
    expect((await f.send(s, '检查姓名', first)).status).toBe(200)
    expect((await f.call<V2SessionView>(f.path(s))).data.issue).toContain('待核对')
    expect((await f.view(w)).delegations[0]).toMatchObject({ remainingTurns: 2, status: 'waiting' })
    await f.act(j,'cancel', {reason:'改为人工核对'})
    f.source.confirmed.mockResolvedValue(true)
    expect((await f.call<V2SessionView>(f.path(s))).data.issue).toBeUndefined()
    expect((await f.send(s,'检查邮箱',second)).status).toBe(200)
    expect(f.source.send).toHaveBeenCalledTimes(2)
    expect((await f.view(w)).delegations[0]).toMatchObject({ remainingTurns:2, status:'closed', reason:'改为人工核对' })
  })

  it('reads source-authored turns and replies and grants attachments only through a currently visible message', async () => {
    const f = fixture(), a = await f.workspace(), b = await f.workspace('客户')
    const s = await f.session(a, 'group'), other = await f.session(b)
    const at = '2026-11-19T06:00:00Z'
    const turns: V2Message[] = [
      { id: 'u', at, role: 'user', author: '你', text: '我能试了吗？' },
      { id: 'a', at, role: 'agent', author: '验收', text: '这里能看预览。', replyTo: 'u', attachments: [{ id: 'artifact', label: '预览' }] },
    ]
    f.messages.set(s.id, turns)
    f.source.attachment.mockResolvedValue({ id: 'artifact', label: '预览', format: 'markdown', content: '本轮交付' })
    expect((await f.call<V2SessionView>(f.path(s))).data.messages).toEqual(turns)
    const suffix = '/attachments/artifact'
    expect((await f.call(f.path(other) + suffix)).status).toBe(404)
    expect((await f.call('/' + b.id + '/sessions/' + s.id + suffix)).status).toBe(404)
    expect(f.source.attachment).not.toHaveBeenCalled()
    expect((await f.call(f.path(s) + suffix)).status).toBe(200)
    f.source.attachment.mockRejectedValueOnce(Error('private native file path'))
    const unreadable = await f.call(f.path(s) + suffix)
    expect(unreadable.status).toBe(503)
    expect(unreadable.data.error).not.toContain('private')
    await f.call(f.path(s) + '/close', { requestId: 'close-s' })
    expect((await f.call<V2SessionView>(f.path(s))).data.messages).toEqual(turns)
    f.messages.set(s.id, [])
    expect((await f.call(f.path(s) + suffix)).status).toBe(404)
    f.source.read.mockRejectedValueOnce(Error('sensitive source internals'))
    const unavailable = (await f.call<V2SessionView>(f.path(s))).data
    expect(unavailable.messages).toEqual([])
    expect(unavailable.issue).toMatch(/暂时无法读取/)
    expect(JSON.stringify(unavailable)).not.toContain('sensitive')
  })

  it('does not claim a previous discussion document for a newly created first order, or lose a proven historical document after adding a sibling', async () => {
    const f = fixture(), w = await f.workspace(), session = await f.session(w)
    const attachment = (label:string,at:string,workOrderId?:string): V2Message => ({
      id:label,role:'agent',author:'Codex',text:label,at,workOrderId,attachments:[{id:label,label}],
    })
    const at = '2020-01-01T00:00:00.000Z'
    f.messages.set(session.id,[attachment('ordinary',at)])
    const job = await f.job(w,'新交接清单',session)
    const outputs = async (id:string) => (await f.call<{outputs:{messageId:string}[]}>('/'+w.id+'/orders/'+id+'/outputs')).data.outputs.map(o=>o.messageId)
    expect(await outputs(job.id)).toEqual([])
    f.messages.get(session.id)!.push(attachment('explicit',at,job.id))
    expect(await outputs(job.id)).toEqual(['explicit'])

    // Schema 1 sessions were born with an immutable list of linked responsibilities.
    const original = await f.session(w), originalOrder = await f.job(w,'原工单',original)
    const path = join(f.root,'ops','superhub-v2',workspaceFingerprint(scope)+'.json')
    const board = JSON.parse(readFileSync(path,'utf8'))
    board.schema = 1
    writeFileSync(path,JSON.stringify(board))
    f.restart()
    const sibling = await f.job(w,'新同场工单',original)
    f.messages.set(original.id,[attachment('old',at),attachment('shared','2100-01-01T00:00:00.000Z'),attachment('sibling',at,sibling.id)])
    expect(await outputs(originalOrder.id)).toEqual(['old'])
    expect(await outputs(sibling.id)).toEqual(['sibling'])
    f.restart()
    expect(await outputs(originalOrder.id)).toEqual(['old'])
  })

  it('discards delayed source reads when the runtime serving the request has been retired', async () => {
    const f = fixture(), w = await f.workspace(), s = await f.session(w)
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    f.source.read.mockImplementationOnce(async () => { started.resolve(); await release.promise; return { messages: [{
      id: 'private', role: 'user', author: '你', at: '2026-11-19T08:00:00Z', text: '旧空间的内容',
    }] } })
    const loading = f.call(f.path(s))
    await started.promise
    f.restart()
    release.resolve()
    const stale = await loading
    expect(stale.status).toBe(409)
    expect(JSON.stringify(stale.data)).not.toContain('旧空间的内容')
  })
  it('serves the execution record of a coding work order only, and an empty record for a group conversation', async () => {
    const f = fixture(), w = await f.workspace(), coding = await f.session(w), job = await f.job(w,'跑命令',coding)
    const commands = [{id:'c1',turnId:'t1',workOrderId:job.id,at:'2026-11-20T08:00:00Z',tool:'shell',command:'ls',cwd:'/work',exitCode:0,endedAt:'2026-11-20T08:00:01Z'}]
    const execution = vi.fn<NonNullable<V2DialogueSource['execution']>>(() => ({commands,runs:[]}))
    Object.assign(f.source,{execution})
    const read = await f.call<{workspaceId:string;delegationId:string;commands:unknown[];runs:unknown[]}>('/'+w.id+'/orders/'+job.id+'/execution')
    expect(read.status).toBe(200)
    expect(read.data).toMatchObject({scope,workspaceId:w.id,delegationId:job.id,commands,runs:[]})
    expect(execution.mock.calls[0]![0].id).toBe(coding.id)
    expect(execution.mock.calls[0]![1]).toBe(job.id)
    expect((await f.call('/'+w.id+'/orders/missing/execution')).status).toBe(404)
    const group = await f.session(w,'group'), discussion = await f.job(w,'讨论',group)
    expect((await f.call<{commands:unknown[]}>('/'+w.id+'/orders/'+discussion.id+'/execution')).data.commands).toEqual([])
    expect(execution).toHaveBeenCalledTimes(1)
    execution.mockImplementationOnce(() => { throw Error('private journal path') })
    const broken = await f.call('/'+w.id+'/orders/'+job.id+'/execution')
    expect(broken.status).toBe(503)
    expect(JSON.stringify(broken.data)).not.toContain('private')
  })

  it('lets only the owner of this brain change a coding order\'s tier, logs each change and keeps the generation', async () => {
    const f = fixture(), w = await f.workspace(), coding = await f.session(w), job = await f.job(w,'清理探针',coding)
    const recordPermission = vi.fn<NonNullable<V2DialogueSource['recordPermission']>>()
    Object.assign(f.source,{recordPermission})
    const set = (permission: unknown, requestId = 'tier-' + String(permission), options = {}) =>
      f.call<{order:V2Delegation;permission:V2CodingPermission}>('/'+w.id+'/orders/'+job.id+'/permission',{requestId,permission},options)
    expect(job).not.toHaveProperty('permission')
    expect((await set('ask','tier-owner',{owner:false})).status).toBe(403)
    expect((await set('ask','tier-scope',{scope:'brain-b'})).status).toBe(409)
    expect((await set('ask','tier-marker',{marker:false})).status).toBe(403)
    expect((await set('sandbox')).status).toBe(400)
    expect((await set(undefined)).status).toBe(400)
    expect(recordPermission).not.toHaveBeenCalled()
    const changed = await set('ask')
    expect(changed.status).toBe(200)
    expect(changed.data).toMatchObject({permission:'ask', order:{id:job.id, permission:'ask', generation:job.generation, status:job.status}})
    expect(changed.data.order.permissionChangedAt).toEqual(expect.any(String))
    expect(recordPermission).toHaveBeenCalledTimes(1)
    expect(recordPermission.mock.calls[0]!.slice(1)).toEqual([job.id,{at:changed.data.order.permissionChangedAt,from:'full-access',to:'ask'}])
    // A replay of the same request and a no-op change leave the record alone.
    expect((await set('ask')).data.order.permission).toBe('ask')
    expect((await set('ask','tier-again')).status).toBe(200)
    expect(recordPermission).toHaveBeenCalledTimes(1)
    expect((await set('full-access')).data.permission).toBe('full-access')
    expect(recordPermission.mock.calls[1]![2]).toMatchObject({from:'ask',to:'full-access'})
    expect((await f.view(w)).orders.find(o => o.id === job.id)).toMatchObject({permission:'full-access', generation:job.generation})
    const group = await f.session(w,'group'), team = await f.job(w,'讨论',group)
    expect((await f.call('/'+w.id+'/orders/'+team.id+'/permission',{requestId:'tier-team',permission:'ask'})).status).toBe(409)
    expect((await f.call('/'+w.id+'/orders/missing/permission',{requestId:'tier-missing',permission:'ask'})).status).toBe(404)
  })

  it('lists pending command approvals of this brain and decides them only through their own order or discussion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'superhub-gate-'))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'hook.js'), '')
    const tier: V2CodingPermission = 'ask'
    const approvals = commandApprovals({ logger: { warn: () => {} } } as unknown as HostContext, () => undefined)
    const gate = new CodingGate({ scope, socketDir: join(dir, 'run'), hookScript: join(dir, 'hook.js'), approvals,
      order: () => ({ permission: tier, title: '清理探针', promise: '删除 probe.txt' }) })
    cleanup.push(() => gate.dispose())
    const f = fixture(4, gate), w = await f.workspace(), coding = await f.session(w), job = await f.job(w,'清理探针',coding)
    const other = await f.job(w,'另一张',coding)
    const lease = gate.open({ workspaceId: w.id, sessionId: coding.id, orderId: job.id, turnId: 't1', tool: 'claude-code', cwd: '/work' }, () => {})
    const decision = gate.decide({ token: lease.env[GATE_TOKEN_ENV], tool_name: 'Bash', tool_input: { command: 'rm -rf /work/probe.txt' }, cwd: '/work/sub' })
    await vi.waitFor(() => expect(gate.pending()).toHaveLength(1))
    const list = await f.call<{approvals:(V2PendingApproval & {workspaceName:string;orderTitle?:string;sessionTitle:string})[]}>('', undefined, { prefix: '/chief/api/v2/approvals' })
    expect(list.status).toBe(200)
    expect(list.data.approvals).toEqual([expect.objectContaining({ workspaceId: w.id, sessionId: coding.id, workOrderId: job.id, tool: 'claude-code',
      command: 'rm -rf /work/probe.txt', cwd: '/work/sub', reason: '删除文件：rm', workspaceName: w.name, orderTitle: '清理探针', sessionTitle: coding.title })])
    expect((await f.call('', undefined, { prefix: '/chief/api/v2/approvals', owner: false })).status).toBe(403)
    expect((await f.call('', undefined, { prefix: '/chief/api/v2/approvals', scope: 'brain-b' })).status).toBe(409)
    const id = list.data.approvals[0]!.id
    const execution = await f.call<{pending:V2PendingApproval[]}>('/'+w.id+'/orders/'+job.id+'/execution')
    expect(execution.data.pending.map(row => row.id)).toEqual([id])
    expect((await f.call<{pending:V2PendingApproval[]}>('/'+w.id+'/orders/'+other.id+'/execution')).data.pending).toEqual([])
    let serial = 0
    const decide = (path: string, body: Record<string, unknown>, options = {}) => f.call(path + '/approvals/' + id, { requestId: 'decide-' + ++serial, ...body }, options)
    expect((await decide('/'+w.id+'/orders/'+job.id, { allow: 'yes' })).status).toBe(400)
    expect((await decide('/'+w.id+'/orders/'+other.id, { allow: true })).status).toBe(409)
    expect((await decide('/'+w.id+'/sessions/'+coding.id, { allow: true })).status).toBe(409)
    expect((await decide('/'+w.id+'/orders/'+job.id, { allow: true }, { owner: false })).status).toBe(403)
    expect((await decide('/'+w.id+'/orders/'+job.id, { allow: true }, { scope: 'brain-b' })).status).toBe(409)
    expect(gate.pending()).toHaveLength(1)
    const ok = await decide('/'+w.id+'/orders/'+job.id, { allow: false })
    expect(ok).toMatchObject({ status: 200, data: { decided: true, order: { id: job.id } } })
    await expect(decision).resolves.toMatchObject({ decision: 'deny' })
    expect((await decide('/'+w.id+'/orders/'+job.id, { allow: true })).status).toBe(409)
    lease.close()
  })
})

describe('owner words while the executor works', () => {
  function busy(turns = 3) {
    const f = fixture(turns)
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    f.source.send.mockImplementationOnce(async (_s, _input, _signal, events) => { events?.dispatched?.(); started.resolve(); await release.promise })
    const interject = vi.fn<NonNullable<V2DialogueSource['interject']>>(async () => 'steered')
    const interjections = vi.fn<NonNullable<V2DialogueSource['interjections']>>(() => [])
    const markInterjection = vi.fn<NonNullable<V2DialogueSource['markInterjection']>>()
    Object.assign(f.source, {interject, interjections, markInterjection})
    const say = (s: V2Session, requestId: string, text: string, workOrderId?: string) =>
      f.call<{delivery?: string; error?: string}>(f.path(s) + '/messages', {requestId, text, wait:false, ...(workOrderId && {workOrderId})})
    const working = async (s: V2Session) => (await f.call<V2SessionView>(f.path(s))).data.working === true
    return {...f, started, release, interject, interjections, markInterjection, say, working}
  }

  it('answers once the words are dispatched and steers later words into the running turn without new budget', async () => {
    const f = busy(), w = await f.workspace(), j = await f.job(w), s = f.forOrder(j)
    // The request returns while the turn is still running.
    expect((await f.say(s, 'first', '写一份周报', j.id)).status).toBe(200)
    await f.started.promise
    expect(await f.working(s)).toBe(true)
    const steered = await f.say(s, 'second', '改用表格输出', j.id)
    expect(steered).toMatchObject({status:200, data:{delivery:'steered'}})
    expect(f.interject).toHaveBeenCalledWith(expect.objectContaining({id:s.id}), 'first', {id:'second', text:'改用表格输出', workOrderId:j.id})
    expect((await f.view(w)).orders[0]!.remainingTurns).toBe(2)
    // A retry returns the same receipt and does not hand the words over again.
    expect((await f.say(s, 'second', '改用表格输出', j.id)).data).toMatchObject({delivery:'steered'})
    expect(f.interject).toHaveBeenCalledTimes(1)
    f.release.resolve()
    await vi.waitFor(async () => expect(await f.working(s)).toBe(false))
    expect(f.source.send).toHaveBeenCalledTimes(1)
    expect((await f.view(w)).orders[0]!.remainingTurns).toBe(2)
  })

  it('moves words the running turn cannot take to the next turn exactly once, using one turn of budget', async () => {
    const f = busy(), w = await f.workspace(), j = await f.job(w), s = f.forOrder(j)
    f.interject.mockResolvedValueOnce('rejected')
    await f.say(s, 'first', '写一份周报', j.id)
    await f.started.promise
    expect((await f.say(s, 'second', '改用表格输出', j.id)).data).toMatchObject({delivery:'queued'})
    expect(f.markInterjection).toHaveBeenCalledWith(expect.objectContaining({id:s.id}), {id:'second', text:'改用表格输出', workOrderId:j.id}, 'queued')
    expect((await f.view(w)).orders[0]!.remainingTurns).toBe(2)
    f.release.resolve()
    await vi.waitFor(() => expect(f.source.send).toHaveBeenCalledTimes(2))
    expect(f.source.send.mock.calls[1]![1]).toMatchObject({id:'second', text:'改用表格输出', workOrderId:j.id})
    await vi.waitFor(async () => expect(await f.working(s)).toBe(false))
    expect((await f.view(w)).orders[0]!.remainingTurns).toBe(1)
    expect((await f.say(s, 'second', '改用表格输出', j.id)).status).toBe(200)
    f.restart()
    await Promise.resolve()
    expect(f.source.send).toHaveBeenCalledTimes(2)
  })

  it('settles words the executor held until the turn ended: taken words stay, untaken words go to the next turn', async () => {
    const f = busy(4), w = await f.workspace(), j = await f.job(w), s = f.forOrder(j)
    f.interject.mockResolvedValue('pending')
    f.interjections.mockReturnValue([{id:'taken', delivered:true}, {id:'late', delivered:false}])
    await f.say(s, 'first', '写一份周报', j.id)
    await f.started.promise
    expect((await f.say(s, 'taken', '改用表格输出', j.id)).data).toMatchObject({delivery:'pending'})
    expect((await f.say(s, 'late', '最后加一段总结', j.id)).data).toMatchObject({delivery:'pending'})
    f.release.resolve()
    await vi.waitFor(() => expect(f.source.send).toHaveBeenCalledTimes(2))
    expect(f.interjections).toHaveBeenCalledWith(expect.objectContaining({id:s.id}), 'first')
    expect(f.source.send.mock.calls.map(([,turn]) => turn.id)).toEqual(['first', 'late'])
    expect((await f.say(s, 'taken', '改用表格输出', j.id)).data).toMatchObject({delivery:'steered'})
    expect(f.markInterjection.mock.calls.map(([,words,state]) => [words.id, state])).toEqual([['late', 'queued']])
    await vi.waitFor(async () => expect(await f.working(s)).toBe(false))
    expect((await f.view(w)).orders[0]!.remainingTurns).toBe(2)
  })

  it('never sends words again when a restart interrupted their hand-over', async () => {
    const f = busy(), w = await f.workspace(), j = await f.job(w), s = f.forOrder(j)
    f.interject.mockResolvedValueOnce('pending')
    await f.say(s, 'first', '写一份周报', j.id)
    await f.started.promise
    expect((await f.say(s, 'second', '改用表格输出', j.id)).data).toMatchObject({delivery:'pending'})
    f.restart()
    const retry = await f.say(s, 'second', '改用表格输出', j.id)
    expect(retry.status).toBe(409)
    expect(retry.data.error).toContain('待核对')
    f.release.resolve()
    await Promise.resolve()
    expect(f.source.send.mock.calls.map(([,turn]) => turn.id)).toEqual(['first'])
  })

  it('queues words for another order of the session directly, and reports words that no budget is left for', async () => {
    const f = busy(1), w = await f.workspace(), s = await f.session(w), j = await f.job(w,'第一份',s), k = await f.job(w,'第二份',s)
    await f.say(s, 'first', '写第一份', j.id)
    await f.started.promise
    expect((await f.say(s, 'other', '写第二份', k.id)).data).toMatchObject({delivery:'queued'})
    expect(f.interject).not.toHaveBeenCalled()
    f.interject.mockResolvedValueOnce('rejected')
    const over = await f.say(s, 'more', '第一份再加一页', j.id)
    expect(over.status).toBe(409)
    expect(over.data.error).toContain('额度')
    expect(f.markInterjection).toHaveBeenLastCalledWith(expect.objectContaining({id:s.id}), {id:'more', text:'第一份再加一页', workOrderId:j.id}, 'unsent')
    f.release.resolve()
    await vi.waitFor(() => expect(f.source.send).toHaveBeenCalledTimes(2))
    expect(f.source.send.mock.calls[1]![1]).toMatchObject({id:'other', workOrderId:k.id})
  })
})


describe('archiving a workspace', () => {
  const archive = (f: ReturnType<typeof fixture>, workspaceId: string, requestId = 'archive-' + workspaceId) =>
    f.call<{workspace: V2Workspace; error: string; scope: string}>('/' + workspaceId + '/archive', {requestId})
  const restore = (f: ReturnType<typeof fixture>, workspaceId: string, requestId = 'restore-' + workspaceId) =>
    f.call<{workspace: V2Workspace; error: string}>('/' + workspaceId + '/restore', {requestId})

  it('refuses 「我的交办」 and open orders (paused included), and archives once every order is finished or cancelled', async () => {
    const f = fixture()
    const mine = f.accept()('mine', '整理一份周五活动清单')
    await vi.waitFor(() => expect(f.source.send).toHaveBeenCalledTimes(1))
    expect(await archive(f, mine.workspace.id)).toMatchObject({status: 409, data: {error: '「我的交办」不能归档'}})
    const w = await f.workspace()
    const one = await f.job(w, '文案初稿'), two = await f.job(w, '配图')
    expect((await f.act(two, 'pause')).status).toBe(200)
    // A refusal saves nothing: the client retries the same request once the orders are done.
    expect(await archive(f, w.id, 'archive-retry')).toMatchObject({status: 409, data: {error: '还有 2 张工单未结束：「文案初稿」、「配图」。请先完成或取消再归档'}})
    expect(f.store().workspace(w.id).archivedAt).toBeUndefined()
    expect((await f.act(one, 'complete')).status).toBe(200)
    expect((await f.act(two, 'cancel')).status).toBe(200)
    const done = await archive(f, w.id, 'archive-retry')
    expect(done).toMatchObject({status: 200, data: {scope, workspace: {id: w.id, archivedAt: expect.any(String)}}})
    expect((await archive(f, w.id, 'archive-retry')).data.workspace).toEqual(done.data.workspace)
    expect((await archive(f, w.id, 'archive-again')).data.workspace.archivedAt).toBe(done.data.workspace.archivedAt)

    const many = await f.workspace('多单项目')
    for (const title of ['一', '二', '三', '四', '五', '六']) await f.job(many, title)
    expect((await archive(f, many.id)).data.error).toBe('还有 6 张工单未结束：「一」、「二」、「三」、「四」、「五」等。请先完成或取消再归档')
  })

  it('makes the workspace read-only on every write route and to the liaison, keeps it readable and listed, and restores it as it was', async () => {
    const f = fixture()
    const mine = f.accept()('mine', '整理一份周五活动清单')
    await vi.waitFor(() => expect(f.source.send).toHaveBeenCalledTimes(1))
    const w = await f.workspace(), s = await f.session(w), d = await f.job(w, '文案初稿', s)
    expect((await f.act(d, 'complete')).status).toBe(200)
    expect((await archive(f, w.id)).status).toBe(200)

    const writes: [string, Record<string, unknown>][] = [
      ['/orders', {title: '新工单', executor: 'codex'}],
      ['/orders/' + d.id + '/action', {action: 'reopen'}],
      ['/orders/' + d.id + '/permission', {permission: 'ask'}],
      ['/orders/' + d.id + '/approvals/card-1', {allow: false}],
      ['/orders/' + d.id + '/followup', {action: 'schedule', weekday: 1, time: '17:00'}],
      ['/directory', {directory: ''}],
      ['/sessions', {title: '新会话', kind: 'coding', executor: 'codex'}],
      ['/sessions/' + s.id + '/approvals/card-1', {allow: false}],
      ['/sessions/' + s.id + '/messages/m-1/forward', {}],
      ['/sessions/' + s.id + '/close', {}],
      ['/sessions/' + s.id + '/reopen', {}],
      ['/sessions/' + s.id + '/stop', {}],
      ['/sessions/' + s.id + '/stop-waiting', {}],
      ['/sessions/' + s.id + '/messages', {text: '继续'}],
    ]
    let serial = 0
    for (const [path, body] of writes) {
      expect([path, await f.call('/' + w.id + path, {requestId: 'write-' + ++serial, ...body})]).toEqual([path, {status: 409, data: {error: WORKSPACE_ARCHIVED}}])
    }
    expect(f.store().workspace(w.id).projectDirectory).toBeUndefined()
    expect(f.store().view(w.id).sessions).toHaveLength(1)
    // The liaison's paths are refused by the board too; the same name is not reused or created again.
    expect(() => f.accept()('archived-assign', '再写一版', undefined, w.id)).toThrow(WORKSPACE_ARCHIVED)
    await expect(f.follow()('archived-follow', '补充一句', w.id, d.id)).rejects.toThrow(WORKSPACE_ARCHIVED)
    const same = {requestId: 'same-name', name: w.name}
    expect(() => f.store().createWorkspace(mutationKey(['liaison', 'workspace'], same), same, true)).toThrow('「产品研发」已归档，请先在工作区页恢复')
    expect(f.store().list().filter(row => row.name === w.name)).toHaveLength(1)
    expect(f.store().focus({surface: 'workspace', selectedId: w.id})).toBeUndefined()
    expect(f.store().focus({surface: 'workspace', selectedId: w.id}, true)?.workspace.id).toBe(w.id)

    // Still listed (with the personal workspace named) and readable.
    const listed = await f.call<{workspaces: V2Workspace[]; personalWorkspaceId: string}>('')
    expect(listed.data.personalWorkspaceId).toBe(mine.workspace.id)
    expect(listed.data.workspaces.find(row => row.id === w.id)?.archivedAt).toEqual(expect.any(String))
    const read = await f.call<V2WorkspaceView & {personalWorkspaceId: string}>('/' + w.id)
    expect(read).toMatchObject({status: 200, data: {personalWorkspaceId: mine.workspace.id, workspace: {archivedAt: expect.any(String)}, orders: [{id: d.id}]}})
    expect((await f.call('/' + w.id + '/sessions/' + s.id)).status).toBe(200)
    f.restart()
    expect(f.store().workspace(w.id).archivedAt).toEqual(expect.any(String))

    const back = await restore(f, w.id)
    expect(back.status).toBe(200)
    expect(back.data.workspace).not.toHaveProperty('archivedAt')
    expect((await restore(f, w.id)).data.workspace).toEqual(back.data.workspace)
    expect((await f.call('/' + w.id + '/sessions', {requestId: 'after-restore', title: '新会话', kind: 'coding', executor: 'codex'})).status).toBe(200)
    expect((await f.act(d, 'reopen')).status).toBe(200)
    const board = JSON.parse(readFileSync(join(f.root, 'ops', 'superhub-v2', workspaceFingerprint(scope) + '.json'), 'utf8'))
    expect(board.archiveChanges.map((row: {workspaceId: string; action: string}) => [row.workspaceId, row.action])).toEqual([[w.id, 'archive'], [w.id, 'restore']])
  })

  it('refuses while a turn runs there and refuses the commands still waiting for approval when it archives', async () => {
    const pending = [{id: 'card-here', workspaceId: '', sessionId: 'room', workOrderId: null}, {id: 'card-elsewhere', workspaceId: 'other', sessionId: 'room', workOrderId: 'o'}]
    const approvals = {
      pending: vi.fn((filter?: {workspaceId?: string}) => pending.filter(row => !filter?.workspaceId || row.workspaceId === filter.workspaceId) as unknown as V2PendingApproval[]),
      answer: vi.fn(() => true),
    }
    const f = fixture(4, approvals), w = await f.workspace(), s = await f.session(w)
    pending[0]!.workspaceId = w.id
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    f.source.send.mockImplementationOnce(async () => { started.resolve(); await release.promise })
    const said = f.send(s, '先讨论一下方案')
    await started.promise
    expect(await archive(f, w.id)).toMatchObject({status: 409, data: {error: '有回合正在运行，请等它结束或叫停后再归档'}})
    release.resolve()
    expect((await said).status).toBe(200)
    expect((await archive(f, w.id)).status).toBe(200)
    expect(approvals.answer.mock.calls).toEqual([['card-here', false, {workspaceId: w.id, sessionId: 'room', orderId: null}]])
    // Restored, then the old archive request replayed: answered from its receipt, the workspace and its approvals stay as they are.
    expect((await restore(f, w.id)).status).toBe(200)
    expect((await archive(f, w.id)).status).toBe(200)
    expect(f.store().workspace(w.id).archivedAt).toBeUndefined()
    expect(approvals.answer).toHaveBeenCalledTimes(1)
  })

  it('reads older boards without archive fields as active workspaces, and restoring an active one changes nothing', async () => {
    const f = fixture(), w = await f.workspace()
    const file = join(f.root, 'ops', 'superhub-v2', workspaceFingerprint(scope) + '.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.workspaces[0]).not.toHaveProperty('archivedAt')
    expect(saved).not.toHaveProperty('archiveChanges')
    f.restart()
    expect((await restore(f, w.id)).data.workspace).toEqual(f.store().workspace(w.id))
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('archiveChanges')
    expect((await f.job(w)).workspaceId).toBe(w.id)
    expect(f.store().focus({surface: 'workspace', selectedId: w.id})?.workspace.id).toBe(w.id)
  })
})
