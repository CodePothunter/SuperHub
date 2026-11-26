import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FollowupView } from '../src/core/workspace-followup.ts'
import type { V2Delegation, V2DialogueSource, V2Message, V2Workspace } from '../src/core/workspace-v2.ts'
import { serveApi } from '../src/dsh/http.ts'
import { workspaceV2Routes } from '../src/dsh/workspace-v2.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'

const clean: (() => void)[] = []
afterEach(() => clean.splice(0).reverse().forEach(dispose => dispose()))
function fixture(timeZone = 'Asia/Shanghai') {
  const root = mkdtempSync(join(tmpdir(), 'chief-order-followup-'))
  clean.push(() => rmSync(root, { recursive: true, force: true }))
  const conversations = new Map<string, V2Message[]>()
  const read = vi.fn<V2DialogueSource['read']>(async session => ({ messages: conversations.get(session.id) ?? [] }))
  const source: V2DialogueSource = { read, send: async () => {}, attachment: async () => undefined }
  const scope = 'test-brain'
  let instant = new Date('2026-12-30T01:00:00Z')
  let store = new WorkspaceV2Store(root, scope)
  const mount = () => workspaceV2Routes({ store, source, timeZone, now: () => new Date(instant) })
  let routes = mount()
  const dispose = () => { routes.dispose(); store.dispose() }
  clean.push(dispose)
  let i = 0
  const key = (kind: string) => mutationKey([kind], {requestId:'fixture-' + ++i})
  const space = (name: string) => store.createWorkspace(key('workspace'), { name }).workspace
  const order = (workspace: V2Workspace, title: string, sessionId?: string) =>
    store.createDelegation(key('order'), workspace, { title, ...(sessionId && {sessionId}) }).delegation
  function say(job: V2Delegation, id: string, text: string, extra: Partial<V2Message> = {}) {
    const rows = conversations.get(job.sessionId) ?? []
    rows.push({ id, text, role: 'user', author: '我', at: instant.toISOString(), workOrderId: job.id, ...extra })
    conversations.set(job.sessionId, rows)
  }
  async function http(job: V2Delegation, body?: Record<string, unknown>, override: {owner?: boolean; marker?: boolean; scope?: string; workspaceId?:string} = {}) {
    const url = '/chief/api/v2/workspaces/' + (override.workspaceId ?? job.workspaceId) + '/orders/' + job.id + '/followup?scope=' + (override.scope ?? scope)
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method: body ? 'POST' : 'GET', url, headers: override.marker === false ? {} : { 'x-chief-request': '1' },
    }) as unknown as IncomingMessage
    let status = 0, data: FollowupView & {error?: string}
    const res = { writeHead(code: number) { status = code }, end(payload: string) { data = JSON.parse(payload) } } as unknown as ServerResponse
    await serveApi(req, res, 'dsh', [routes], override.owner ?? true)
    return { status, data: data! }
  }
  const act = (job: V2Delegation, action: string) => store.act(key('action'), job.workspaceId, job.id, { action }, instant)
  return { space, order, say, http, read, act, dispose, service: () => routes.followup, store: () => store,
    set: (when: string) => { instant = new Date(when) }, restart: () => { dispose(); store = new WorkspaceV2Store(root,scope); routes = mount() } }
}

const words = '我答应小陈周四演示。她答应周三给样本。她还请我看看预算，我没答应。'
const entries = [
  {kind:'mine', quote:'我答应小陈周四演示', person:'小陈', dueAt:'2026-12-31'},
  {kind:'theirs', quote:'她答应周三给样本', person:'小陈', dueAt:'2026-12-30'},
  {kind:'request', quote:'她还请我看看预算，我没答应'},
]

describe('本地工单的约定与周期交付', () => {
  it('quotes three distinct facts from one order, rejects sibling, cross-workspace and unauthenticated evidence and keeps retries idempotent', async () => {
    const f = fixture(), a = f.space('客户合作'), b = f.space('家庭')
    const order = f.order(a,'试点演示'), sibling = f.order(a,'采购',order.sessionId), other = f.order(b,'私人安排')
    f.say(order,'source',words)
    f.say(sibling,'sibling','采购项目的私有报价')
    f.say(other,'source','另一空间同名消息')
    f.say(order,'unbound','这是共同讨论，尚未分配', {workOrderId: undefined})
    const record = {action:'record',requestId:'record-promises',entries:entries.map(entry => ({...entry,messageId:'source'}))}
    const result = await f.http(order,record)
    expect(result.status).toBe(200)
    expect(result.data.commitments.map(row => [row.kind,row.dueState])).toEqual([['mine','upcoming'],['theirs','today'],['request','unscheduled']])
    expect(result.data.commitments.every(row => row.source.kind === 'session' && row.source.sessionId === order.sessionId && row.source.messageId === 'source')).toBe(true)
    expect((await f.http(order,record)).data.commitments).toEqual(result.data.commitments)
    expect((await f.http(order,{...record,requestId:'different-request'})).data.commitments).toEqual(result.data.commitments)
    expect((await f.http(order,{...record,entries:[]})).status).toBe(409)
    expect((await f.http(order,undefined,{workspaceId:b.id})).status).toBe(404)
    expect((await f.http(order,undefined,{scope:'switched'})).status).toBe(409)
    expect((await f.http(order,record,{owner:false})).status).toBe(403)
    expect((await f.http(order,record,{marker:false})).status).toBe(403)
    for (const [messageId,quote] of [['sibling','私有报价'],['unbound','共同讨论'],['source','另一空间同名消息']]) {
      const bad = await f.http(order,{requestId:'bad-' + messageId, action:'record',kind:'mine',messageId,quote})
      expect(bad.status).toBe(messageId === 'source' ? 409 : 404)
    }
    const resolve = {action:'resolve',requestId:'done-one',id:result.data.commitments[1]!.id}
    expect((await f.http(sibling,resolve)).status).toBe(404)
    expect((await f.http(order,resolve)).data.commitments[1]!.dueState).toBe('resolved')
    f.set('2027-01-01T03:00:00Z')
    f.restart()
    expect((await f.http(order)).data.commitments.map(row => row.dueState)).toEqual(['overdue','resolved','unscheduled'])
    expect(await f.service().sources(a.id,sibling.id)).toHaveLength(1)
  })

  it('accepts liaison evidence only through the current host turn, saves an atomic batch and binds Today to its assignment', async () => {
    const f = fixture(), job = f.store().assign('rpc-1',words)
    expect(f.store().assignedOrder('rpc-1')?.id).toBe(job.delegation.id)
    expect(f.store().assignedOrder('rpc-other')).toBeUndefined()
    const owner = {sessionId:'liaison-run',messageId:'input-1',text:words,at:'2026-12-30T00:59:00Z'}
    const record = {action:'record',requestId:'three',entries}
    expect((await f.http(job.delegation,{...record,ownerEvidence:owner})).status).toBe(400)
    const {id: w} = job.workspace, {id:d} = job.delegation
    await expect(f.service().apply(w,d,{...record,entries:[entries[0],{...entries[1],quote:'未曾出现'}]},owner)).rejects.toThrow('引文')
    expect(f.service().view(w,d).commitments).toHaveLength(0)
    const recorded = await f.service().apply(w,d,record,owner)
    expect(recorded.commitments.every(row => row.source.kind === 'liaison' && row.source.at === owner.at && row.source.messageId === 'input-1')).toBe(true)
    expect(f.read).toHaveBeenCalledTimes(1) // Only the HTTP attempt with no trusted owner evidence read the session.
    expect((await f.service().apply(w,d,record,owner)).commitments).toEqual(recorded.commitments)
    await expect(f.service().apply(w,d,record,{...owner,messageId:'another-turn'})).rejects.toThrow('另一项操作')
  })

  it('marks only the deleted workspace source while preserving commitments and frozen weekly report sources', async () => {
    const f = fixture(), space = f.space('协作'), order = f.order(space,'演示')
    f.say(order,'workspace-source','下周完成演示。',{traceId:'initial'})
    expect((await f.http(order,{action:'record',requestId:'workspace-evidence',kind:'mine',messageId:'workspace-source',quote:'下周完成演示'})).status).toBe(200)
    const detached = {sessionId:'liaison-run',messageId:'liaison-source',text:'先向接口人发样本。',traceId:'liaison-trace'}
    await f.service().apply(space.id,order.id,{action:'record',requestId:'liaison-evidence',kind:'mine',quote:'先向接口人发样本'},detached)
    expect((await f.http(order,{action:'draft',requestId:'frozen-week'})).status).toBe(200)
    const saved = structuredClone(f.store().followupState(space.id,order.id))
    const deleted = f.store().deleteTarget(mutationKey(['delete-session'],{requestId:'remove-session'}),space.id,'session',order.sessionId)
    const view = (await f.http(order)).data
    expect(view.sessionDeletedAt).toBe(deleted.deletedAt)
    expect(view.commitments.map(row => row.source)).toMatchObject([
      {kind:'session',messageId:'workspace-source',traceId:'initial',sessionDeletedAt:deleted.deletedAt},
      {kind:'liaison',messageId:'liaison-source'},
    ])
    expect(view.reports[0]!.sources[0]!.sessionDeletedAt).toBe(deleted.deletedAt)
    expect(view.reports[0]!.sources[1]).not.toHaveProperty('sessionDeletedAt')
    expect(f.store().followupState(space.id,order.id)).toEqual(saved)
    expect((await f.http(order,{action:'draft',requestId:'another-week'})).status).toBe(410)
  })

  it('answers who still owes what in one selected workspace, paginating across orders without reading raw conversations', async () => {
    const f = fixture(), a = f.space('客户'), b = f.space('家庭')
    const one = f.order(a,'客户演示'), two = f.order(a,'客户样本'), hidden = f.order(b,'家庭')
    const add = async (job: V2Delegation, prefix: string, count: number) => {
      const facts = Array.from({length:count}, (_,i) => ({kind:'mine',quote:prefix + String(i).padStart(2,'0')}))
      const owner = {sessionId:'liaison',messageId:prefix,text:facts.map(row=>row.quote).join('。')}
      return f.service().apply(job.workspaceId,job.id,{action:'record',requestId:'add-' + job.id,entries:facts},owner)
    }
    const first = await add(one,'演示',20)
    await add(two,'样本',2)
    await add(hidden,'家庭隐私',1)
    await f.http(one,{action:'resolve',id:first.commitments[0]!.id,requestId:'resolved-summary'})
    f.act(two,'pause')
    const page = f.service().workspaceView(a.id)
    expect(page.total).toBe(21)
    expect(page.items).toHaveLength(20)
    expect(page.items[0]!.commitment.quote).toBe('演示01')
    const last = f.service().workspaceView(a.id,page.nextOffset)
    expect(last.items).toHaveLength(1)
    expect(last.items[0]).toMatchObject({orderId:two.id,orderTitle:two.title,sessionId:two.sessionId,paused:true,commitment:{quote:'样本01'}})
    expect(JSON.stringify([page,last])).not.toContain('家庭隐私')
    expect(f.service().workspaceView(a.id,0,two.sessionId).total).toBe(2)
    expect(() => f.service().workspaceView(a.id,0,hidden.sessionId)).toThrow('没有这场会话')
    expect(() => f.service().workspaceView(a.id,-1)).toThrow('列表位置')
    expect(f.read).not.toHaveBeenCalled()
  })

  it('suppresses a stale scheduled read while disabled and retries once the revised schedule is actually due', async () => {
    const f = fixture(), job = f.order(f.space('交付'),'跟进')
    f.set('2026-11-18T00:00:00Z')
    await f.http(job,{action:'schedule',requestId:'enable',weekday:5,time:'10:00'})
    f.set('2026-11-20T02:10:00Z')
    const wait = Promise.withResolvers<{messages:V2Message[]}>()
    f.read.mockReturnValueOnce(wait.promise)
    const inFlight = f.service().tick()
    await f.http(job,{action:'schedule',requestId:'disable',enabled:false})
    await f.http(job,{action:'schedule',requestId:'enable-later',weekday:5,time:'14:00'})
    wait.resolve({messages:[]})
    await expect(inFlight).rejects.toThrow('周报交付时间已变更')
    expect((await f.http(job)).data.reports).toHaveLength(0)
    f.set('2026-11-20T06:04:01Z')
    f.read.mockResolvedValueOnce({messages:[],issue:'来源未完成同步。'})
    await expect(f.service().tick()).rejects.toThrow('暂时无法完整读取')
    f.restart()
    await f.service().tick()
    expect((await f.http(job)).data.reports.map(row=>row.week)).toEqual(['2026-11-16'])
  })

  it('renders the order’s genuine weekly files, source speech and pending requests, recovering one frozen report for retries across weeks', async () => {
    const f = fixture(), a = f.space('试点'), order = f.order(a,'演示'), sibling = f.order(a,'定价',order.sessionId)
    f.say(order,'promises',words)
    f.say(order,'report','```markdown title="演示稿.md"\n附件内的逐项原始数据\n```\n[演示稿](./delivery.md)已完成两个样例；第三项还缺匿名数据。',
      {role:'agent',author:'工程师',attachments:[{id:'file-1',label:'演示稿.md'}]})
    f.say(order,'update','匿名样本测试通过。',{role:'agent',author:'工程师'})
    f.say(sibling,'private','独立工单报价。',{role:'agent',attachments:[{id:'private',label:'私人标书'}]})
    f.say(order,'old','上周的文件。',{role:'agent',at:'2026-12-27T01:00:00Z',attachments:[{id:'old',label:'过期样本'}]})
    await f.http(order,{action:'record',requestId:'terms',entries:entries.map(e=>({...e,messageId:'promises'}))})
    const first = await f.http(order,{action:'draft',requestId:'first-draft'})
    expect(first.status).toBe(200)
    const report = first.data.reports[0]!
    expect(first.data.reportId).toBe(report.id)
    expect(report.week).toBe('2026-12-28')
    for (const term of ['演示稿.md','工程师','已完成两个样例','第三项还缺匿名数据','匿名样本测试通过','我方承诺','对方承诺','待回应请求','依据']) expect(report.markdown).toContain(term)
    for (const foreign of ['旧的','私人标书','独立工单报价','过期样本','附件内的逐项原始数据','./delivery.md']) expect(report.markdown).not.toContain(foreign)
    expect(report.sources.map(row=>row.messageId)).toEqual(['report','update','promises'])
    f.say(order,'late','同一期稍后交付',{role:'agent',attachments:[{id:'late',label:'另一个文件'}]})
    f.restart()
    expect((await f.http(order,{action:'draft',requestId:'same-week'})).data.reports).toEqual([report])
    f.set('2027-01-04T00:01:00Z')
    const replay = await f.http(order,{action:'draft',requestId:'first-draft'})
    expect(replay.data).toMatchObject({currentWeek:'2027-01-04',reportId:report.id,reports:[report]})
    const next = (await f.http(order,{action:'draft',requestId:'new-week'})).data
    expect(next.reports).toHaveLength(2)
    expect(next.reports[0]!.markdown).toContain('没有登记交付文件')
    expect(next.reports[0]!.markdown).toContain('已到复查时间')
  })

  it('runs each enabled local period once across a restart, reconfiguration, concurrent ticks and a paused order', async () => {
    const f = fixture('America/Los_Angeles'), order = f.order(f.space('研发'),'每周工作结果')
    f.set('2026-12-30T20:00:00Z')
    await f.http(order,{action:'schedule',requestId:'plan',weekday:5,time:'17:30'})
    f.set('2027-01-02T01:29:59Z') // Friday 17:29:59 Pacific
    await f.service().tick()
    expect((await f.http(order)).data.reports).toHaveLength(0)
    f.restart()
    f.set('2027-01-02T01:30:00Z')
    await Promise.all([f.service().tick(),f.service().tick()])
    const first = (await f.http(order)).data.reports
    expect(first.map(row=>row.week)).toEqual(['2026-12-28'])
    await f.http(order,{action:'schedule',requestId:'move',weekday:6,time:'11:00'})
    f.set('2027-01-02T19:01:00Z')
    f.restart()
    await f.service().tick()
    expect((await f.http(order)).data.reports).toEqual(first)
    f.act(order,'pause')
    f.set('2027-01-09T19:01:00Z')
    await f.service().tick()
    expect((await f.http(order)).data.reports).toEqual(first)
    expect((await f.http(order,{action:'schedule',requestId:'stop',enabled:false})).data.schedule?.enabled).toBe(false)
    f.act(order,'resume')
    await f.service().tick()
    expect((await f.http(order)).data.reports).toEqual(first)
  })

  it('retries an unavailable source and prevents in-flight drafts after revocation or a change of brain', async () => {
    const f = fixture(), order = f.order(f.space('演示'),'每周跟进')
    const draft = {action:'draft',requestId:'retry'}
    f.read.mockRejectedValueOnce(new Error('offline'))
    expect((await f.http(order,draft)).status).toBe(503)
    expect((await f.http(order)).data.reports).toEqual([])
    f.read.mockResolvedValueOnce({messages:[], issue:'本轮只有一条公开发言', complete:true})
    expect((await f.http(order,draft)).data.reports).toHaveLength(1)
    f.set('2027-01-04T02:00:00Z')
    const block = Promise.withResolvers<{messages:V2Message[]}>()
    f.read.mockReturnValueOnce(block.promise)
    const inFlight = f.service().apply(order.workspaceId,order.id,{action:'draft',requestId:'revoked'})
    f.act(order,'cancel')
    block.resolve({messages:[]})
    await expect(inFlight).rejects.toThrow('工单指示已变更')
    expect((await f.http(order)).data.reports).toHaveLength(1)
    const second = f.order(f.space('另一个项目'),'周工作')
    const switched = Promise.withResolvers<{messages:V2Message[]}>()
    f.read.mockReturnValueOnce(switched.promise)
    const stopped = f.service().apply(second.workspaceId,second.id,{...draft,requestId:'different'})
    f.restart()
    switched.resolve({messages:[]})
    await expect(stopped).rejects.toThrow('运行环境已切换')
    expect((await f.http(second)).data.reports).toEqual([])
  })

  it('resumes from the next local delivery time without publishing a period that was paused when due', async () => {
    const f = fixture(), order = f.order(f.space('日常'),'工作小结')
    f.set('2026-11-18T00:00:00Z')
    await f.http(order,{action:'schedule',requestId:'setup',weekday:5,time:'10:00'})
    f.act(order,'pause')
    f.set('2026-11-20T03:00:00Z')
    f.act(order,'resume')
    f.restart()
    await f.service().tick()
    expect((await f.http(order)).data.reports).toHaveLength(0)
    f.set('2026-11-27T03:00:00Z')
    await f.service().tick()
    expect((await f.http(order)).data.reports.map(row=>row.week)).toEqual(['2026-11-23'])
  })
})
