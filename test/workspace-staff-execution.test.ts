import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostContext, Llm } from '../src/dsh/ports.ts'
import type { StaffContext } from '../src/core/workspace-staff.ts'
import { WorkspaceFollowup } from '../src/dsh/workspace-followup.ts'
import { createV2DialogueSource } from '../src/dsh/workspace-v2-dialogue.ts'
import { WorkspaceStaffStore } from '../src/dsh/workspace-staff-store.ts'
import { workspaceV2Routes } from '../src/dsh/workspace-v2.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'

const roots:string[] = []
afterEach(()=>{ for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}) })
function fixture(stream:NonNullable<Llm['stream']>) {
  const root = mkdtempSync(join(tmpdir(),'chief-staff-run-'))
  roots.push(root)
  const scope = 'test-brain'
  const board = new WorkspaceV2Store(root,scope)
  const key = () => mutationKey(['test'],{requestId:randomUUID()})
  const {workspace} = board.createWorkspace(key(),{name:'试点'})
  const staff = new WorkspaceStaffStore(root,scope,()=>[],id=>board.workspace(id))
  const write = (body:Record<string,unknown>)=>staff.apply(workspace.id,{requestId:randomUUID(),...body})
  const person = write({action:'create',name:'会务组',brief:'归纳会场意见'}).members[0]!
  const entry = write({action:'learn',staffId:person.id,text:'甲的蓝纸鹤'}).memories[0]!
  const info = () => staff.context(workspace.id,person.id)
  const revoke = () => write({action:'reset',staffId:person.id,confirmation:staff.impact(person.id,workspace.id).token})
  const job = board.createDelegation(key(),workspace,{title:'本次交付'},{id:person.id,name:person.name,token:info().token}).delegation
  const session = board.session(workspace.id,job.sessionId)
  const ctx = {get:(n:string)=>n==='llm' ? {stream} : undefined} as unknown as HostContext
  const propose = vi.fn()
  const source = createV2DialogueSource({ctx,scope,root,staff:{context:info,current:c=>staff.assertCurrent(c),
    used:(c:StaffContext,id)=>staff.markUsed(c,id),propose,model:()=>({provider:'fixture',model:'brief'})}})
  const send = (text:string) => source.send(session,{id:randomUUID(),text,workOrderId:job.id,context:board.context(session,job.id)},new AbortController().signal)
  return {staff,board,workspace,person,session,job,source,info,send,propose,revoke,entry}
}

it('only replays same-order speech from the active staff context, retains the owner archive, and rejects stale in-flight results',async()=>{
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const prompts:string[] = []
  const f = fixture(async function*(request){
    prompts.push(JSON.stringify(request.messages))
    expect(request.tools).toEqual([])
    expect(request).not.toHaveProperty('sessionId')
    const n = prompts.length
    if (n===2) { started.resolve(); await release.promise }
    yield {type:'text-delta',text:n===1 ? '工单回报\n蓝纸鹤交付成功' : n===2 ? '应丢弃的结果' : '工单回报\n新的无关结果'}
    yield {type:'finish',reason:{kind:'stop'}}
  })
  await f.send('首次')
  expect(prompts[0]).toContain('甲的蓝纸鹤')
  expect(f.staff.view(f.workspace.id).memories[0]?.lastUsed?.orderId).toBe(f.job.id)
  const pending = f.send('继续')
  await started.promise
  expect(prompts[1]).toContain('蓝纸鹤交付成功')
  f.revoke()
  release.resolve()
  await expect(pending).rejects.toThrow('幕僚未提交本轮成果')
  await f.send('重置后继续')
  expect(prompts[2]).not.toContain('蓝纸鹤')
  const spoken = (await f.source.read(f.session)).messages.filter(m=>m.role==='agent')
  expect(spoken.map(m=>m.text)).toEqual(['工单回报\n蓝纸鹤交付成功','工单回报\n新的无关结果'])
  expect(spoken.every(m=>m.author===f.person.name && m.workOrderId===f.job.id)).toBe(true)
  const permitted = f.source.staffSources!(f.session,f.job.id,f.info().token)
  expect(permitted.has(spoken[0]!.id)).toBe(false)
  expect(permitted.has(spoken[1]!.id)).toBe(true)
  f.source.dispose()
})

it('revalidates the source of a report and its quotes if the owner resets the staff while its weekly compilation is reading', async()=>{
  const f = fixture(async function*(){
    yield {type:'text-delta',text:'工单回报\n甲答应带蓝纸鹤。'}
    yield {type:'finish',reason:{kind:'stop'}}
  })
  await f.send('核对')
  const transcript = await f.source.read(f.session)
  const agent = transcript.messages.find(m=>m.role==='agent')!
  const pendingRead = Promise.withResolvers<void>()
  let pause = false
  const follow = new WorkspaceFollowup(f.board,async()=>{if (pause) await pendingRead.promise; return transcript},
    ()=>{},'Asia/Shanghai',()=>new Date(),()=>f.source.staffSources!(f.session,f.job.id,f.info().token))
  await follow.apply(f.workspace.id,f.job.id,{action:'record',kind:'theirs',quote:'甲答应带蓝纸鹤',messageId:agent.id,requestId:randomUUID()})
  pause = true
  const draft = follow.apply(f.workspace.id,f.job.id,{action:'draft',requestId:randomUUID()})
  f.revoke()
  pendingRead.resolve()
  const result = await draft
  expect(result.reports).toHaveLength(1)
  expect(result.reports[0]!.markdown).not.toContain('蓝纸鹤')
  expect(result.reports[0]!.sources.map(s=>s.messageId)).not.toContain(agent.id)
  expect(result.commitments[0]!.quote).toBe('甲答应带蓝纸鹤')
  f.source.dispose()
})

it('stops a queued order on recovery after its staff access changed and preserves it for the owner', async()=>{
  const model = vi.fn(async function*(){ yield {type:'finish',reason:{kind:'stop'}} })
  const f = fixture(model)
  expect(f.board.pendingStarts()).toHaveLength(1)
  f.revoke()
  const routes = workspaceV2Routes({staff:f.staff,store:f.board,source:f.source})
  try {
    routes.recover()
    await vi.waitFor(()=>expect(f.board.delegation(f.workspace.id,f.job.id).reason).toContain('排队要求已停止'))
    expect(f.board.pendingStarts()).toHaveLength(0)
    expect(model).not.toHaveBeenCalled()
    expect(f.board.delegation(f.workspace.id,f.job.id).sessionId).toBe(f.session.id)
    expect((await f.source.read(f.session)).messages).toHaveLength(0)
  } finally { routes.dispose(); f.source.dispose() }
})

it('reruns the same staff turn with words the owner adds while it answers, discarding the partial answer and using no new turn', async () => {
  const requests: string[] = []
  const first = Promise.withResolvers<void>()
  const f = fixture(async function*(request) {
    requests.push(JSON.stringify(request.messages))
    if (requests.length === 1) {
      yield {type:'text-delta', text:'部分答复，'}
      first.resolve()
      await new Promise<void>((_, reject) => request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once:true}))
    }
    yield {type:'text-delta', text:'工单回报\n已按表格整理'}
    yield {type:'finish', reason:{kind:'stop'}}
  })
  const id = randomUUID()
  const sent = f.source.send(f.session, {id, text:'整理会场意见', workOrderId:f.job.id, context:f.board.context(f.session, f.job.id)}, new AbortController().signal)
  await first.promise
  // Taken once the rerun's answer is published.
  expect(await f.source.interject!(f.session, id, {id:'added', text:'改用表格输出', workOrderId:f.job.id})).toBe('pending')
  await sent
  expect(requests).toHaveLength(2)
  expect(requests[1]).toContain('整理会场意见')
  expect(requests[1]).toContain('改用表格输出')
  const messages = (await f.source.read(f.session)).messages
  expect(messages.map(m => [m.role, m.text, m.delivery])).toEqual([['user', '整理会场意见', undefined], ['user', '改用表格输出', 'steered'],
    ['agent', '工单回报\n已按表格整理', undefined]])
  expect(f.source.interjections!(f.session, id)).toEqual([{id:'added', delivered:true}])
  // The added words are part of what the next turn of this staff member may read.
  expect(f.source.staffSources!(f.session, f.job.id, f.info().token).has(messages[1]!.id)).toBe(true)
  // An answer that has finished cannot take more words; the host queues them.
  expect(await f.source.interject!(f.session, id, {id:'late', text:'再补一句', workOrderId:f.job.id})).toBe('rejected')
  f.source.dispose()
})

it('leaves words added to a staff turn for the next turn when the rerun fails', async () => {
  let calls = 0
  const first = Promise.withResolvers<void>()
  const f = fixture(async function*(request) {
    calls++
    if (calls === 1) {
      first.resolve()
      await new Promise<void>((_, reject) => request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {once:true}))
    }
    throw new Error('provider down')
  })
  const id = randomUUID()
  const sent = f.source.send(f.session, {id, text:'整理会场意见', workOrderId:f.job.id, context:f.board.context(f.session, f.job.id)}, new AbortController().signal)
  await first.promise
  expect(await f.source.interject!(f.session, id, {id:'added', text:'改用表格输出', workOrderId:f.job.id})).toBe('pending')
  await expect(sent).rejects.toMatchObject({dispatched:false})
  expect(calls).toBe(2)
  expect(f.source.interjections!(f.session, id)).toEqual([{id:'added', delivered:false}])
  f.source.dispose()
})

it('names the speaker of each staff turn: the liaison hands over with the owner\'s original, owner words stay the owner\'s',async()=>{
  const prompts:string[] = []
  const f = fixture(async function*(request){
    prompts.push(JSON.stringify(request.messages) + request.system)
    yield {type:'text-delta',text:'工单回报\n已整理'}
    yield {type:'finish',reason:{kind:'stop'}}
  })
  await f.source.send(f.session,{id:'start-'+randomUUID(),text:'帮我把会场意见归纳成三条',workOrderId:f.job.id,context:f.board.context(f.session,f.job.id),
    liaison:{handoff:'请把会场意见归纳成三条，每条一句话。'}},new AbortController().signal)
  await f.send('再加一条结论')
  expect(prompts[0]).toContain('〔接口人〕请把会场意见归纳成三条，每条一句话。')
  expect(prompts[0]).toContain('主人原话：')
  expect(prompts[0]).toContain('以〔主人〕开头的是主人本人')
  expect(prompts[1]).toContain('〔主人〕再加一条结论')
  // The earlier hand-over reaches the next turn with the owner's original kept alongside.
  expect(prompts[1]).toContain('帮我把会场意见归纳成三条')
  const [handover] = (await f.source.read(f.session)).messages
  expect(handover).toMatchObject({author:'接口人',role:'agent',quote:{label:'主人原话',text:'帮我把会场意见归纳成三条'}})
  f.source.dispose()
})
