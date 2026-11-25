import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine } from '../src/core/engine.ts'
import type { Ticket } from '../src/core/model.ts'
import { FileStore } from '../src/core/store.ts'
import { historyItemId, type HistoryDetail, type HistoryImport, type HistoryList, type PeopleList } from '../src/core/workspace-history.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { serveApi } from '../src/dsh/http.ts'
import type { Agent, HostContext, SessionEventLike } from '../src/dsh/ports.ts'
import { NativeRooms, roomSessionId } from '../src/dsh/rooms.ts'
import { Roster } from '../src/dsh/roster.ts'
import { SuperhubGoals, workspaceError, workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import { workspaceHistoryRoutes } from '../src/dsh/workspace-history.ts'
import { WorkspaceHistoryStore, type HistoryIndex } from '../src/dsh/workspace-history-store.ts'

const clean: (() => void)[] = []
afterEach(() => { for (const dispose of clean.splice(0).reverse()) dispose() })
const at = '2026-11-20T03:00:00.000Z'
function fixture() {
  const directory = mkdtempSync(join(tmpdir(),'chief-import-history-')), root = join(directory,'brain')
  clean.push(() => rmSync(directory,{recursive:true,force:true}))
  const file = (p: string, content: string) => { mkdirSync(dirname(join(root,p)),{recursive:true}); writeFileSync(join(root,p),content) }
  const scope = 'active-brain'
  const store = new FileStore(root), brain = new BrainRepo(root)
  const dispatch = vi.fn(), run = vi.fn(async () => { throw new Error('历史资料不会运行工单') })
  const engine = new Engine(store,brain,{ available:() => true,supportsSchema:() => true,run },{ dispatch,cancel:vi.fn() },{ concurrency:1,timeZone:'UTC',brainScope:scope })
  const roster = new Roster(root,{commit:vi.fn()},() => at.slice(0,10))
  const goals = new SuperhubGoals(root,vi.fn())
  const events: SessionEventLike[] = []
  const head = { id:roomSessionId(root,'weekly'), session:{snapshotEvents:() => events} } as Agent
  const member = { id:'member',session:{snapshotEvents:() => [
    {seq:1,time:Date.parse(at),type:'assistant/message',data:{message:{content:[{type:'text',text:'没有发给群成员的内部草稿'}]}}},
  ]} } as Agent
  const host = { agents:{get:(id:string) => id === head.id ? head : member},get:(name:string) => name === 'agentTeams' ? {
    listMembers:() => [{id:head.id,name:'lead'},{id:member.id,name:'researcher'}],listTasks:() => [],
  } : undefined,sessionController:{resolveAgent:async (id: string) => ({agent:id === head.id ? head : member})} } as unknown as HostContext
  file('ops/room-index.json',JSON.stringify([{id:'weekly',session:head.id,title:'周会群',notes:[],tickets:['T-0001']}]))
  const rooms = new NativeRooms(host,root,() => [])
  clean.push(() => { rooms.dispose(); engine.stop() })
  const deps = { scope,engine,brain,rooms,roster,goals }
  let routes = workspaceHistoryRoutes(deps)
  clean.push(() => routes.dispose())
  function restart() { routes.dispose(); routes = workspaceHistoryRoutes(deps) }
  async function call<T = {error:string}>(path = '', body?: Record<string,unknown>, options: {scope?:string;owner?:boolean;marker?:boolean;resource?:'history'|'people'} = {}) {
    const url = new URL('/chief/api/v2/' + (options.resource ?? 'history') + path,'http://local')
    url.searchParams.set('scope',options.scope ?? scope)
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []),{
      method:body ? 'POST' : 'GET',url:url.pathname + url.search,headers:options.marker === false ? {} : {'x-chief-request':'1'},
    }) as unknown as IncomingMessage
    let code = 0, result: T
    const res = {writeHead(n:number) { code = n },end(value:string) { result = JSON.parse(value) } } as unknown as ServerResponse
    await serveApi(req,res,'dsh',[routes],options.owner ?? true)
    return {code,result:result!}
  }
  function ticket(id: string, extra: Partial<Ticket> = {}) {
    file('staff/researcher.md','---\nid: researcher\nname: 调研员\n---\n负责调研。')
    const source = 'source-' + id
    store.appendEvent({id:source,dedupe:source,source:'inbox',at,text:'请整理需求。'})
    const t: Ticket = {id,title:'准备材料 ' + id,createdAt:at,staff:'researcher',priority:10,
      mandate:{eventId:source,strength:'explicit',level:'think',scope:'核对原始资料。',doneWhen:['一份说明'],needsReview:true},
      events:[source],inputs:[],assignments:[],...extra}
    store.saveTicket(t)
    return t
  }
  const detail = (kind: Parameters<typeof historyItemId>[0],sourceId: string) => '/' + encodeURIComponent(historyItemId(kind,sourceId))
  const importWith = (requestId: string) => call<HistoryImport>('/import',{requestId})
  return {directory,root,scope,file,store,brain,events,rooms,roster,call,detail,ticket,importWith,restart,run,dispatch,routes,deps}
}

type CleanupReceipt = { previewId: string; removedPeople: number; editedDocuments: number; objectsToPurge: number; applied?: true; purgedObjects?: number }

function cleanupFixture() {
  const t = fixture()
  const documentPath = 'inbox/已有资料.md'
  const prefix = '# 备忘\r\n\r\n刘老师已确认教育计划。\r\n\r\n'
  const section = '## 常打交道的人\r\n\r\n- 刘老师的独立人物资料\r\n\r\n'
  const suffix = '## 正在推进的事\r\n\r\n与顾经理协调项目。\r\n'
  const original = prefix + section + suffix
  const retained = prefix + suffix
  const input = {
    people:['person:刘老师','person:顾经理'],
    document:{id:historyItemId('document',documentPath),startLine:5,endLine:9,
      heading:'## 常打交道的人',nextHeading:'## 正在推进的事'},
  }
  t.file(documentPath,original)
  t.file('goals.md','# 近期目标\n\n仍需与刘老师对齐。\n')
  t.roster.recordPersonFacts('刘老师',{organization:'教研'})
  for (const name of ['顾经理','陈经理']) t.roster.recordPersonFacts(name,{organization:'项目组',role:'联络人'})
  t.file('ledger/C-0001.json', JSON.stringify({id:'C-0001',direction:'mine',what:'提交项目计划',who:'陈经理',status:'open',createdAt:at}))

  const base = join(t.root,'ops','superhub-history-' + workspaceFingerprint(t.scope))
  const indexBytes = () => readFileSync(join(base,'index.json'),'utf8')
  const index = () => JSON.parse(indexBytes()) as HistoryIndex
  const object = (digest: string) => join(base,'objects',digest)
  const objects = () => readdirSync(join(base,'objects')).sort()
  const preview = () => t.call<CleanupReceipt>('/cleanup/preview',input)
  const apply = (previewId: string) => t.call<CleanupReceipt>('/cleanup/apply',{...input,previewId})
  return { ...t, documentPath, original, retained, input, indexBytes, index, object, objects, preview, apply }
}

describe('历史资料导入与跨端读取', () => {
  it('旧工单快照和外部助手原文不进入资料目录，旧回执也不能恢复它们', async () => {
    const t = fixture()
    const ticket = t.ticket('T-0018')
    const history = 'ops/superhub-history-' + workspaceFingerprint(t.scope)
    const doc = (title: string) => JSON.stringify({body:title,messages:[],attachments:[],links:[]})
    const object = (content: string) => {
      const digest = createHash('sha256').update(content).digest('hex')
      t.file(history + '/objects/' + digest,content)
      return digest
    }
    const key = 'ticket:' + ticket.id
    const path = 'inbox/import-' + 'f'.repeat(64) + '.md'
    const title = '从 ChatGPT 导入的"对主人的了解"'
    t.file(path, `# ${title}\n\n待核对的原句`)
    const raw = 'document:' + path
    t.file(history + '/index.json', JSON.stringify({schema:1,scope:t.scope,entries:{
      [key]:{item:{id:key,kind:'ticket',sourceId:ticket.id,title:'旧工单'},detail:object(doc('旧原话')),files:[]},
      [raw]:{item:{id:raw,kind:'document',sourceId:path,title},detail:object(doc('不可普查的助手原文')),files:[]},
    },receipts:{'req-archive':{scope:t.scope,total:2,added:2,updated:0,unchanged:0,importedAt:at}}}))
    expect((await t.call<HistoryList>()).result).toMatchObject({total:0,available:1})
    expect((await t.call('/' + encodeURIComponent(key))).code).toBe(404)
    expect((await t.call('/' + encodeURIComponent(key) + '/attachments/file')).code).toBe(404)
    expect((await t.call('/' + encodeURIComponent(raw))).code).toBe(404)
    expect((await t.importWith('archive')).result).toMatchObject({added:1,total:1})
    t.restart()
    expect((await t.importWith('archive')).result).toMatchObject({added:1,total:1})
    expect((await t.importWith('next')).result).toMatchObject({unchanged:1,total:1})
    expect(readFileSync(join(t.root,path),'utf8')).toContain('待核对的原句')
    expect(t.run).not.toHaveBeenCalled()
    expect(t.dispatch).not.toHaveBeenCalled()
  })
  it('人物主入口读实时花名册、按原身份合并快照，保留已移动的档案', async () => {
    const t = fixture()
    const options = {resource:'people'} as const
    const directory = () => t.call<PeopleList>('',undefined,options)
    const person = (name: string) => t.call<HistoryDetail>(t.detail('person',name),undefined,options)
    t.roster.recordPersonFacts('刘老师',{team:'研发',groups:['试点']})
    t.roster.recordPersonFacts('顾经理',{organization:'合作方',role:'对接人'})
    t.file('staff/researcher.md','---\nname: 研究员\n---\n')
    expect((await directory()).result.items.map(item => item.title)).toEqual(['顾经理','刘老师'])
    expect(t.routes.personName('person:刘老师')).toBe('刘老师')
    expect(t.routes.personName('person:未建档人')).toBeUndefined()
    expect(t.routes.personName('room:weekly')).toBeUndefined()
    expect((await person('刘老师')).result).toMatchObject({scope:t.scope,origin:'roster'})
    await t.importWith('prior')
    renameSync(join(t.root,'people','顾经理.md'),join(t.directory,'原档案.md'))
    t.roster.recordPersonFacts('刘老师',{organization:'合作方',addGroups:['验收'],reportsTo:'顾经理',fact:'已确定验收日'})
    t.roster.setPersonJudgement('刘老师',{influence:'high'})
    const live = (await directory()).result.items
    expect(live.map(item => item.title)).toEqual(['刘老师','顾经理'])
    expect(live[0]?.person).toMatchObject({organization:'合作方',influence:'high',groups:['试点','验收']})
    const changed = (await person('刘老师')).result
    expect(await t.routes.personDetail('person:刘老师')).toEqual(changed)
    expect(changed.body).toContain('已确定验收日')
    expect(changed.links).toEqual([{id:'person:顾经理',label:'汇报给 顾经理'}])
    const archived = (await person('顾经理')).result
    expect(archived).toMatchObject({origin:'import',item:{sourceId:'顾经理'}})
    expect(await t.routes.personDetail('person:顾经理')).toEqual(archived)
    expect(t.routes.personName('person:顾经理')).toBe('顾经理')
    t.roster.recordPersonFacts('刘老师',{reportsTo:'尚未建档的负责人'})
    const unlinked = (await person('刘老师')).result
    expect(unlinked.links).toEqual([])
    expect(unlinked.body).toContain('汇报给 尚未建档的负责人')
    expect((await t.call<HistoryDetail>(t.detail('person','刘老师'))).result.body).not.toContain('已确定验收日')
    expect((await t.call('',undefined,{...options,owner:false})).code).toBe(403)
    expect((await t.call(t.detail('person','刘老师'),undefined,{...options,scope:'other'})).code).toBe(409)
    expect((await person('研究员')).code).toBe(404)
    expect((await t.call(t.detail('room','weekly'),undefined,options)).code).toBe(404)
    t.routes.dispose()
    expect(t.routes.personName('person:顾经理')).toBeUndefined()
    await expect(t.routes.personDetail('person:顾经理')).rejects.toMatchObject({status:409})
  })

  it('读回公开群聊及快照，重复和并发导入不重复派工', async () => {
    const t = fixture()
    t.ticket('T-0001')
    t.events.push({seq:1,time:Date.parse(at),type:'user/message',data:{id:'one',source:{kind:'user',rpcId:'human'},content:[{type:'text',text:'几点交付？'}]}},
      {seq:2,time:Date.parse(at)+1,type:'assistant/message',data:{message:{content:[{type:'thinking',text:'PRIVATE-TRACE'},{type:'text',text:'今天下午交付。'}]}}})
    const room = t.detail('room','weekly')
    expect((await t.call<HistoryList>()).result).toMatchObject({available:1,total:0,items:[]})
    const first = await Promise.all([t.importWith('one'),t.importWith('one'),t.importWith('two')])
    expect(first[0]!.result).toMatchObject({added:1,updated:0,unchanged:0})
    expect(first[1]).toEqual(first[0])
    expect(first[2]!.result).toMatchObject({added:0,updated:0,unchanged:1})
    const chat = (await t.call<HistoryDetail>(room)).result
    expect(chat.links).toEqual([])
    expect(chat.messages.map(m => [m.author,m.text])).toEqual([['我','几点交付？'],['接口人','今天下午交付。']])
    expect(JSON.stringify(chat)).not.toContain('PRIVATE-TRACE')
    const leadId = chat.messages[1]!.speakerId!
    expect(chat.messages[0]!.speakerId).toBe('owner')
    expect(chat.portraits?.owner).toEqual({shape:'plane',color:'blue'})
    expect(leadId).toMatch(/^s-[a-f0-9]{24}$/)
    expect(chat.portraits?.[leadId]?.shape).not.toBe('plane')
    t.events.shift()
    t.events.push({seq:3,time:Date.parse(at)+2,type:'assistant/message',data:{message:{content:[{type:'text',text:'文件已经发出。'}]}}})
    expect((await t.importWith('partial-room')).result.updated).toBe(1)
    const reread = (await t.call<HistoryDetail>(room)).result
    expect(reread.portraits).toEqual(chat.portraits)
    const continued = reread.messages
    expect(continued.map(m => m.text)).toEqual(['几点交付？','今天下午交付。','文件已经发出。'])
    const missingIdentity = await t.rooms.view('weekly')
    for (const message of missingIdentity.messages) delete message.speakerId
    vi.spyOn(t.rooms,'view').mockResolvedValueOnce(missingIdentity)
    await t.importWith('earlier-receipt')
    expect((await t.call<HistoryDetail>(room)).result.messages).toEqual(continued)
    vi.spyOn(t.rooms,'view').mockRejectedValue(new Error('原生服务下线'))
    const refresh = (await t.importWith('refresh')).result
    expect(refresh.incomplete).toBe(1)
    t.restart()
    vi.spyOn(t.rooms,'list').mockImplementation(() => { throw new Error('原来源下线') })
    const off = (await t.call<HistoryList>()).result
    expect(off).toMatchObject({total:1,available:0,counts:{room:1}})
    expect(off.sourceIssue).toBeTruthy()
    expect((await t.call<HistoryDetail>(room)).result.messages).toEqual(continued)
    expect(t.run).not.toHaveBeenCalled(); expect(t.dispatch).not.toHaveBeenCalled()
  })

  it('只收公开资料、区分人物和组织、按组织和重要性分页并保留已移走的原文', async () => {
    const t = fixture()
    t.file('people/甲.md','---\nname: 甲\norganization: 甲单位\ninfluence: low\n---\n## 事实\n- 原来的事实')
    t.file('people/乙.md','---\nname: 乙\norganization: 甲单位\ninfluence: high\ngroups: 沟通组\n---\n## 事实\n- 项目联络人')
    t.file('people/丙.md','---\nname: 丙\nteam: 单列团队\ninfluence: high\n---\n## 事实\n- 团队成员')
    t.file('staff/lead.md','---\nid: lead\nname: 接口人\n---\n内部职责')
    t.file('projects/样例/README.md','# 样例项目\n项目说明')
    t.file('projects/样例/docs/移交.md','可用的项目文档')
    t.file('projects/样例/docs/vendor/示例.md','来自依赖的文档')
    t.file('projects/样例/node_modules/依赖/README.md','第三方代码')
    t.file('journal/记录.md','# 周记\n历史周记')
    t.file('ledger/C-0001.json',JSON.stringify({id:'C-0001',direction:'mine',what:'提供报价',who:'甲',status:'open',createdAt:at}))
    t.file('lines/进度.md','---\nname: 进度\npartners: 乙\n---\n## 背景\n目前进度')
    t.file('meetings/M-0001.json',JSON.stringify({id:'M-0001',title:'回顾',at,with:['乙'],createdAt:at,notes:'双方确认需求'}))
    writeFileSync(join(t.directory,'私人.md'),'必须留在当前脑之外')
    symlinkSync(join(t.directory,'私人.md'),join(t.root,'journal','泄露.md'))
    symlinkSync(join(t.directory,'私人.md'),join(t.root,'people','冒名.md'))
    const initial = (await t.importWith('import')).result
    expect(initial.added).toBe(9)
    const list = (await t.call<HistoryList>('?kind=person&limit=1')).result
    expect(list).toMatchObject({counts:{person:3,project:1,document:1,commitment:1,line:1,meeting:1,room:1},nextOffset:1})
    expect(list.items[0]).toMatchObject({sourceId:'乙',person:{organization:'甲单位',influence:'high',groups:['沟通组']}})
    expect((await t.call<HistoryList>('?kind=person&offset=2')).result.items[0]).toMatchObject({sourceId:'丙',person:{team:'单列团队'}})
    const project = (await t.call<HistoryDetail>(t.detail('project','样例'))).result
    expect(project.attachments.map(a => a.label)).toEqual(['README.md','docs/移交.md'])
    renameSync(join(t.root,'projects/样例/README.md'),join(t.directory,'removed-readme.md'))
    await t.importWith('project-readme-unavailable')
    const retained = (await t.call<HistoryDetail>(t.detail('project','样例'))).result
    expect(retained.item.title).toBe('样例项目')
    expect(retained.body).toBe(project.body)
    expect(retained.attachments).toEqual(project.attachments)
    expect((await t.call(t.detail('document','journal/泄露.md'))).code).toBe(404)
    const changed = t.detail('document','journal/记录.md')
    t.file('journal/记录.md','# 周记\n周记更新')
    expect((await t.importWith('update')).result.updated).toBe(1)
    renameSync(join(t.root,'journal','记录.md'),join(t.directory,'removed.md'))
    const missing = (await t.importWith('missing')).result
    expect(missing).toMatchObject({retained:1,total:9,added:0})
    t.restart()
    expect((await t.call<HistoryDetail>(changed)).result.body).toContain('周记更新')
    expect((await t.call<HistoryDetail>(t.detail('commitment','C-0001'))).result.links[0]?.id).toBe(historyItemId('person','甲'))
    expect((await t.call<HistoryDetail>(t.detail('meeting','M-0001'))).result.body).toContain('双方确认需求')
  })

  it('只清理指定人物快照和独立章节，保留共享对象与正式资料，重启后重新导入不会恢复', async () => {
    const t = cleanupFixture()
    expect((await t.importWith('before-cleanup')).code).toBe(200)
    const indexBefore = t.index()
    const oldIndexBytes = t.indexBytes()
    const oldObjects = t.objects()
    const oldPerson = indexBefore.entries['person:刘老师']!.detail
    const sharedPerson = indexBefore.entries['person:顾经理']!.detail
    const oldDocument = indexBefore.entries[t.input.document.id]!.detail
    expect(indexBefore.entries['person:陈经理']!.detail).toBe(sharedPerson)
    const explicitPreservedPaths = [t.documentPath,'goals.md','people/刘老师.md','people/顾经理.md','people/陈经理.md','ledger/C-0001.json']
    const protectedFiles = () => explicitPreservedPaths.map(path => readFileSync(join(t.root,path)))
    const beforeFiles = protectedFiles()

    const preview = await t.preview()
    expect(preview.code).toBe(200)
    expect(preview.result).toMatchObject({removedPeople:2,editedDocuments:1,objectsToPurge:2})
    expect(t.indexBytes()).toBe(oldIndexBytes)
    expect(t.objects()).toEqual(oldObjects)

    const applied = await t.apply(preview.result.previewId)
    expect(applied.code).toBe(200)
    expect(applied.result).toMatchObject({applied:true,removedPeople:2,editedDocuments:1,purgedObjects:2})
    expect(protectedFiles()).toEqual(beforeFiles)
    expect(t.objects()).toHaveLength(oldObjects.length - 1)
    expect(existsSync(t.object(oldPerson))).toBe(false)
    expect(existsSync(t.object(oldDocument))).toBe(false)
    expect(existsSync(t.object(sharedPerson))).toBe(true)
    expect(t.index().entries['document:goals.md']).toEqual(indexBefore.entries['document:goals.md'])
    expect(t.index().entries['commitment:C-0001']).toEqual(indexBefore.entries['commitment:C-0001'])

    const checkHistory = async () => {
      const history = (await t.call<HistoryList>()).result
      expect(history.counts).toMatchObject({person:1,document:2,commitment:1})
      for (const name of ['刘老师','顾经理']) {
        const path = t.detail('person',name)
        expect((await t.call(path)).code).toBe(404)
        expect((await t.call<HistoryDetail>(path,undefined,{resource:'people'})).result.origin).toBe('roster')
      }
      expect((await t.call<HistoryDetail>(t.detail('document',t.documentPath))).result.body).toBe(t.retained)
    }
    await checkHistory()
    t.restart()
    expect((await t.apply(preview.result.previewId)).result).toEqual(applied.result)
    const imports = await Promise.all([t.importWith('after-cleanup'), t.importWith('after-cleanup-parallel')])
    expect(imports.map(row => row.code)).toEqual([200,200])
    await checkHistory()
    expect(existsSync(t.object(oldPerson))).toBe(false)
    expect(existsSync(t.object(oldDocument))).toBe(false)
    expect(protectedFiles()).toEqual(beforeFiles)
    t.file(t.documentPath,t.original + '\r\n后来编辑的原件。\r\n')
    expect((await t.importWith('changed-source')).result.incomplete).toBe(1)
    await checkHistory()
  })

  it('清理预览和执行校验主人、脑范围、请求标记与已预览的版本', async () => {
    const t = cleanupFixture()
    await t.importWith('before-preview')
    const oldIndexBytes = t.indexBytes()
    const oldObjects = t.objects()
    expect((await t.call('/cleanup/preview',t.input,{owner:false})).code).toBe(403)
    expect((await t.call('/cleanup/preview',t.input,{scope:'other'})).code).toBe(409)
    expect((await t.call('/cleanup/preview',t.input,{marker:false})).code).toBe(403)
    expect((await t.call('/cleanup/preview',{...t.input,people:['document:goals.md']})).code).toBe(400)
    const wrongSection = {...t.input,document:{...t.input.document,nextHeading:'## 计划中的其他工作'}}
    expect((await t.call('/cleanup/preview',wrongSection)).code).toBe(409)
    const preview = await t.preview()
    expect(preview.code).toBe(200)
    const request = {...t.input,previewId:preview.result.previewId}
    expect((await t.call('/cleanup/apply',request,{owner:false})).code).toBe(403)
    expect((await t.call('/cleanup/apply',request,{scope:'other'})).code).toBe(409)
    expect((await t.call('/cleanup/apply',request,{marker:false})).code).toBe(403)
    expect((await t.call('/cleanup/apply',{...request,people:['person:刘老师']})).code).toBe(409)
    expect(t.indexBytes()).toBe(oldIndexBytes)
    expect(t.objects()).toEqual(oldObjects)

    t.file('goals.md','# 近期目标\n\n更新原来的里程碑。\n')
    await t.importWith('after-preview')
    const newIndexBytes = t.indexBytes()
    const newObjects = t.objects()
    expect((await t.apply(preview.result.previewId)).code).toBe(409)
    expect(t.indexBytes()).toBe(newIndexBytes)
    expect(t.objects()).toEqual(newObjects)
  })

  it('发布清理索引后中断，可以按原清单在重启后继续回收对象', async () => {
    const t = cleanupFixture()
    await t.importWith('before-cleanup')
    const preview = (await t.preview()).result
    const oldIndex = t.index()
    const pendingPurge = [oldIndex.entries['person:刘老师']!.detail,oldIndex.entries[t.input.document.id]!.detail]
    const interrupt = vi.spyOn(WorkspaceHistoryStore.prototype,'finishCleanup')
      .mockImplementationOnce(() => workspaceError(503,'模拟发布后中断'))
    try { expect((await t.apply(preview.previewId)).code).toBe(503) }
    finally { interrupt.mockRestore() }

    expect(t.index().entries['person:刘老师']).toBeUndefined()
    expect((await t.call<HistoryDetail>(t.detail('document',t.documentPath))).result.body).toBe(t.retained)
    expect(pendingPurge.every(digest => existsSync(t.object(digest)))).toBe(true)
    t.restart()
    const recovered = await t.apply(preview.previewId)
    expect(recovered.code).toBe(200)
    expect(recovered.result).toMatchObject({applied:true,purgedObjects:2})
    expect(pendingPurge.every(digest => !existsSync(t.object(digest)))).toBe(true)
  })

  it('校验主人、scope、请求标识与来源，原生工单链接始终不可用', async () => {
    const t = fixture()
    expect((await t.call('',undefined,{owner:false})).code).toBe(403)
    expect((await t.call('/import',{requestId:'ok'},{marker:false})).code).toBe(403)
    expect((await t.call('/import',{requestId:'ok'},{scope:'other'})).code).toBe(409)
    expect((await t.call('/import',{requestId:'ok',scope:'other'})).code).toBe(409)
    expect((await t.importWith('../escape')).code).toBe(400)
    await t.importWith('initial')
    const ticket = t.ticket('T-0009')
    expect((await t.call('/ticket:' + ticket.id)).code).toBe(404)
    expect((await t.call<HistoryList>()).result.counts).not.toHaveProperty('ticket')
    expect((await t.call('/' + encodeURIComponent('ticket:../../journal/a'))).code).toBe(404)
    expect((await t.call('?kind=staff')).code).toBe(400)
    const indexDir = readdirSync(join(t.root,'ops')).find(x => x.startsWith('superhub-history-'))!
    const index = readFileSync(join(t.root,'ops',indexDir,'index.json'),'utf8')
    expect(index).not.toContain('原始资料')
  })
})
