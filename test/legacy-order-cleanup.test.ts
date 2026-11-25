import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStore } from '../src/core/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { cleanupLegacyOrders } from '../src/dsh/legacy-order-cleanup.ts'
import { digestOf } from '../src/dsh/legacy-cleanup-transaction.ts'
import { acquireLock, LEGACY_CLEANUP_PENDING } from '../src/dsh/lock.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import { WorkspaceHistoryStore, visibleHistorySnapshot } from '../src/dsh/workspace-history-store.ts'
import { WorkspaceV2Store, mutationKey, workspaceBoardFile, workspaceScope } from '../src/dsh/workspace-v2-store.ts'
import { dialogueKey } from '../src/dsh/workspace-speaker-id.ts'

const at = '2026-11-23T08:00:00.000Z'
const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir,{recursive:true,force:true}) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(),'chief-legacy-cleanup-'))
  roots.push(root)
  const path = (...parts: string[]) => join(root,...parts)
  const write = (name: string, value: string | object) => {
    mkdirSync(dirname(path(name)),{recursive:true})
    writeFileSync(path(name),typeof value === 'string' ? value : JSON.stringify(value))
  }
  const read = (name: string) => readFileSync(path(name),'utf8')
  const json = <T>(name: string): T => JSON.parse(read(name)) as T
  const store = new FileStore(root)
  const scope = workspaceScope(root)
  function seedTicket(id: string, extra: Partial<Ticket> = {}) {
    const event = 'source-' + id
    store.appendEvent({id:event,dedupe:event,source:'inbox',at,text:'旧交办原话'})
    const ticket: Ticket = {id,title:'旧单 ' + id,staff:'analyst',priority:1,createdAt:at,
      mandate:{eventId:event,strength:'explicit',level:'think',scope:'旧范围',doneWhen:[],needsReview:false},
      events:[event],inputs:[],assignments:[],ended:{at,outcome:'done',note:'办完了'},...extra}
    store.saveTicket(ticket)
    store.setDisposition(event,{kind:'accepted',ticketId:id})
    return ticket
  }
  write('me.md','# 关于我\n\n## 偏好\n- 结论先行')
  return {root,path,write,read,json,store,scope,seedTicket}
}

function seeded() {
  const f = fixture()
  f.seedTicket('T-0001')
  // A complete pending write associated with the old ticket must never reopen it.
  f.store.appendEvent({id:'late-source',dedupe:'late-prior',source:'system',at,text:'旧消息待派发',ticketId:'T-0001'})
  f.store.appendEvent({id:'old-room-work',dedupe:'old-room-work',source:'inbox',at,text:'讨论里的旧交办',ticketId:'T-0001',
    meta:{room_id:'keep-room',room_source:'linked-source'}})
  f.store.appendEvent({id:'new-source',dedupe:'new-source',source:'inbox',at,text:'无关原话'})
  f.write('work/T-0001/legacy.txt','旧交付文件')
  f.write('ops/delivery-versions/T-0001/' + 'd'.repeat(64) + '.json',{content:'旧交付文件'})
  f.write('ops/ticket-sequence.json','1\n')
  f.write('ops/outbox.json',[
    {key:'need:T-0001:you/review:0',ticketId:'T-0001',text:'旧审批',at,push:'pending',attempts:0},
    {key:'other',text:'无关提醒',at,push:'local',attempts:0},
  ])
  const conversation = {id:'keep-room',tickets:['T-0001'],notes:[{text:'现有讨论'}],
    ownerActions:[{id:'old-action',kind:'execute',ticketId:'T-0001',text:'原执行请求'},
      {id:'source-action',kind:'execute',source:'linked-source',text:'原讨论请求'},
      {id:'independent',kind:'question',source:'question-source',text:'独立问题'}]}
  f.write('ops/room-index.json',[conversation])
  f.write('ops/rooms/keep-room.json',conversation)
  f.write('ops/worklines/source.json',{tickets:['T-0001'],decisions:[{text:'现有决定'}],deliveries:[{ticketId:'T-0001',path:'work/T-0001/legacy.txt'}]})
  f.write('ops/superhub-saa.json',{schema:1,requests:{},records:[{id:'retro',goals:[{id:'current',version:1}],
    tickets:['T-0001','unrelated'],references:[{ticketId:'T-0001',evidenceId:'old'},{ticketId:'unrelated',evidenceId:'independent'}],
    nextFocus:'继续本周研究',checkpoint:{resumeAt:'阅读访谈材料'}}]})

  const boardPath = workspaceBoardFile(f.scope)
  const scope = f.scope, workspaceId = 'space', sessionId = 'ordinary'
  const nativeSession = 'native-' + workspaceFingerprint([scope,'T-0042']).slice(0,32)
  const items = (id: string, sessionId: string, status: string, legacyTicketId?: string) =>
    ({id,workspaceId,sessionId,title:id,status,legacyTicketId,owner:'研究员',promise:'交回结论',
      boundary:'本区',createdAt:at,nextCheckAt:at,generation:1,remainingTurns:5})
  const sessions = [
    {id:sessionId,workspaceId,kind:'group',executor:'dsh',title:'两张现行工单',closed:false,createdAt:at,
      delegationIds:['T-0001','v2-open','v2-closed']},
    {id:nativeSession,workspaceId,kind:'group',executor:'dsh',title:'原生投影',closed:false,createdAt:at,delegationIds:['T-0042']},
  ]
  f.write(boardPath,{
    schema:2,workspaces:[{id:workspaceId,name:'研究',goal:'增长',owner:'我',createdAt:at,icon:'recorder'}],
    delegations:[items('T-0001',sessionId,'closed','T-0001'),items('T-0042',nativeSession,'closed','T-0042'),
      items('v2-open',sessionId,'waiting'),items('v2-closed',sessionId,'closed')],
    sessions, decisions:[
      {id:'removed',workspaceId,delegationId:'T-0001',text:'旧决定',version:1,at},
      {id:'keep',workspaceId,delegationId:'v2-open',text:'新决定',version:1,at},
    ],
    receipts:{'req-old':{kind:'mutation',hash:'old',result:{delegation:items('T-0001',sessionId,'closed','T-0001')}},
      'req-keep':{kind:'turn',hash:'keep',sessionId,reserved:[{id:'v2-open',generation:1}],state:'sent',at}},
  })
  const area = dialogueKey(scope,workspaceId)
  const journal = join('ops','superhub-v2-dialogues',area,dialogueKey(area,sessionId),'source.json')
  f.write(journal,{members:[],turns:[
    {id:'t-old',workOrderId:'T-0001'}, {id:'t-open',workOrderId:'v2-open'}, {id:'t-closed',workOrderId:'v2-closed'},
  ],messages:[
    {id:'m-old',workOrderId:'T-0001',text:'仅旧单可读',attachments:[{id:'only-old'},{id:'shared'}]},
    {id:'m-open',workOrderId:'v2-open',text:'在办单交付',replyTo:'m-old',attachments:[{id:'shared'}]},
    {id:'m-closed',workOrderId:'v2-closed',text:'已办结的交付'},
    {id:'m-discuss',text:'独立会话发言'},
  ],attachments:[{id:'only-old',content:'旧单专属附件'},{id:'shared',content:'共用附件'}]})

  const index = join('ops','superhub-history-' + workspaceFingerprint(scope),'index.json')
  const objectDirectory = join(dirname(index),'objects')
  const object = (data: string) => {
    const digest = digestOf(data)
    f.write(join(objectDirectory,digest),data)
    return digest
  }
  const oldDetail = object(JSON.stringify({body:'历史旧单',messages:[],attachments:[],links:[]}))
  const shared = object('共用文稿'), discarded = object('旧单独占快照')
  const room = object(JSON.stringify({body:'原讨论笔记',messages:[],attachments:[{id:'d1',label:'通用清单'}],links:[{id:'ticket:T-0042',label:'清理此链接'}]}))
  const attachment = (id: string, digest: string) => ({id, label:'文稿', format:'text', digest})
  f.write(index,{
    schema:1,scope,receipts:{'req-before':{total:2,added:2}},entries:{
      'ticket:T-0042':{detail:oldDetail,item:{id:'ticket:T-0042',kind:'ticket',sourceId:'T-0042',title:'仅剩快照'},files:[attachment('d0',discarded),attachment('d1',shared)]},
      'room:keep-room':{detail:room,item:{id:'room:keep-room',kind:'room',sourceId:'keep-room',title:'保留讨论'},files:[attachment('d1',shared)]},
    },
  })
  return {...f,boardPath,workspaceId,nativeSession,sessionId,journal,index,objectDirectory,oldDetail,shared,discarded}
}

describe('下线旧工单', () => {
  it('打开工作区即隐藏旧单，正常保存仍保有后续清理的来源', () => {
    const f = seeded()
    const before = f.read(f.boardPath)
    const board = new WorkspaceV2Store(f.root,f.scope)
    expect(board.view(f.workspaceId).orders.map(order => order.id)).toEqual(['v2-open','v2-closed'])
    expect(board.view(f.workspaceId).sessions.map(session => session.id)).toEqual([f.sessionId])
    expect(board.session(f.workspaceId,f.sessionId).delegationIds).toEqual(['v2-open','v2-closed'])
    expect(() => board.delegation(f.workspaceId,'T-0001')).toThrow('没有这张工单')
    expect(board.receipt({id:'old',key:'req-old',hash:'old'})).toBeUndefined()
    expect(f.read(f.boardPath)).toBe(before)
    board.setSessionClosed(mutationKey(['test','close'],{requestId:'close'}),f.workspaceId,f.sessionId,true)
    expect(new WorkspaceV2Store(f.root,f.scope).session(f.workspaceId,f.sessionId).closed).toBe(true)
    expect(cleanupLegacyOrders(f.root).ticketIds).toEqual(['T-0001','T-0042'])
  })

  it.each(['history','ticket'])('清理在 %s 写入后中断，排他恢复，保留共用数据和另一脑', (point) => {
    const f = seeded(), another = fixture()
    another.seedTicket('T-0001')
    const personal = f.read('me.md'), anotherTicket = another.read('ops/tickets/T-0001.json')
    const preview = cleanupLegacyOrders(f.root)
    expect(preview).toMatchObject({scope:f.scope,ticketIds:['T-0001','T-0042'],blockers:[]})
    expect(cleanupLegacyOrders(f.root)).toEqual(preview)
    expect(existsSync(f.path('ops','tickets','T-0001.json'))).toBe(true)
    expect(() => cleanupLegacyOrders(f.root, preview.id, path => {
      if (point === 'history' ? path === f.index : path === join('ops','tickets','T-0001.json')) throw new Error('模拟进程中断')
    })).toThrow('模拟进程中断')
    expect(existsSync(f.path('ops',LEGACY_CLEANUP_PENDING))).toBe(true)
    expect(() => acquireLock(f.root)).toThrow('尚未完成')
    const published = statSync(f.path(f.index),{bigint:true}).mtimeNs
    const result = cleanupLegacyOrders(f.root,preview.id)
    expect(existsSync(f.path('ops',LEGACY_CLEANUP_PENDING))).toBe(false)
    expect(statSync(f.path(f.index),{bigint:true}).mtimeNs).toBe(published)
    expect(result.backup).toBeTruthy()
    expect(readFileSync(join(result.backup!,'work','T-0001','legacy.txt'),'utf8')).toBe('旧交付文件')
    expect(cleanupLegacyOrders(f.root,preview.id)).toEqual(result)
    expect(cleanupLegacyOrders(f.root)).toMatchObject({ticketIds:[],deletedFiles:0,changedFiles:0})
    expect(new FileStore(f.root).nextTicketId()).toBe('T-0043')
    expect(new FileStore(f.root).pendingEvents().map(event => event.id)).toEqual(['new-source'])
    expect(new FileStore(f.root).isRetiredTicket('T-0001')).toBe(true)
    expect(new FileStore(f.root).isRetiredTicket('T-0003')).toBe(false)
    expect(existsSync(f.path('work','T-0001'))).toBe(false)
    expect(existsSync(f.path('ops','delivery-versions','T-0001'))).toBe(false)
    expect(f.read('me.md')).toBe(personal)
    expect(another.read('ops/tickets/T-0001.json')).toBe(anotherTicket)
    expect(JSON.parse(f.read('ops/outbox.json'))).toEqual([expect.objectContaining({key:'other'})])
    expect(JSON.parse(f.read('ops/room-index.json'))[0]).toMatchObject({tickets:[],notes:[{text:'现有讨论'}]})
    expect(f.json('ops/rooms/keep-room.json')).toEqual({id:'keep-room',tickets:[],notes:[{text:'现有讨论'}],
      ownerActions:[{id:'old-action',kind:'execute',text:'原执行请求',answered:true},
        {id:'source-action',kind:'execute',source:'linked-source',text:'原讨论请求',answered:true},
        {id:'independent',kind:'question',source:'question-source',text:'独立问题'}]})
    expect(f.json('ops/superhub-saa.json')).toMatchObject({records:[{id:'retro',goals:[{id:'current',version:1}],
      tickets:['unrelated'],references:[{ticketId:'unrelated',evidenceId:'independent'}],nextFocus:'继续本周研究',checkpoint:{resumeAt:'阅读访谈材料'}}]})
    const board = new WorkspaceV2Store(f.root,f.scope)
    expect(board.view(f.workspaceId).orders.map(order => [order.id,order.status])).toEqual([['v2-open','waiting'],['v2-closed','closed']])
    expect(() => board.session(f.workspaceId,f.nativeSession)).toThrow('没有这场会话')
    expect(board.view(f.workspaceId).decisions.map(row => row.id)).toEqual(['keep'])
    expect(board.receipt({id:'keep',key:'req-keep',hash:'keep'})).toBeTruthy()
    const journal = f.json<{messages:{text:string; replyTo?:string}[]; attachments:{id:string}[]}>(f.journal)
    expect(journal.messages.map(row=>row.text)).toEqual(['在办单交付','已办结的交付','独立会话发言'])
    expect(journal.messages[0]?.replyTo).toBeUndefined()
    expect(journal.attachments.map(file => file.id)).toEqual(['shared'])
    const history = new WorkspaceHistoryStore(f.root,f.scope), row = history.load().entries['room:keep-room']
    if (!visibleHistorySnapshot(row)) throw Error('应保留原讨论')
    expect(history.detail(row)).toMatchObject({body:'原讨论笔记',links:[]})
    expect(history.attachment(row,'d1')?.content).toBe('共用文稿')
    expect(existsSync(f.path(f.objectDirectory,f.discarded))).toBe(false)
    expect(existsSync(f.path(f.objectDirectory,f.oldDetail))).toBe(false)
  })

  it('禁止在运行实例上清理，版本变化或未结远程队列需重新核对', () => {
    const f = seeded()
    const first = cleanupLegacyOrders(f.root)
    const release = acquireLock(f.root)
    try { expect(() => cleanupLegacyOrders(f.root,first.id)).toThrow('占用') } finally { release() }
    f.write('work/T-0001/legacy.txt','主人更新了这份文件')
    expect(() => cleanupLegacyOrders(f.root,first.id)).toThrow('重新预览')
    f.write('ops/remote/taken/job-1234.json',{ticketId:'T-0001',assignmentId:'job-1234'})
    const next = cleanupLegacyOrders(f.root)
    expect(next.blockers).toEqual(['T-0001 工作电脑队列 taken 尚未结清'])
    expect(() => cleanupLegacyOrders(f.root,next.id)).toThrow('在途工作')
    expect(f.read('work/T-0001/legacy.txt')).toBe('主人更新了这份文件')
  })

  it('旧锁同时被运行实例和维护进程接管时只允许一个写入者', async () => {
    const f = fixture()
    const lockModule = new URL('../src/dsh/lock.ts',import.meta.url).href
    f.write('ops/.chief.lock',{pid:2_147_000_000,instance:'stale'})
    const script = [
      "import { existsSync } from 'node:fs'",
      "import { setTimeout } from 'node:timers/promises'",
      "import { join } from 'node:path'",
      `import { acquireLock } from ${JSON.stringify(lockModule)}`,
      "const [root, mode] = process.argv.slice(1)",
      "while (!existsSync(join(root,'begin'))) await setTimeout(2)",
      "try {",
      "  const release = acquireLock(root, mode === 'maintenance')",
      "  console.log('held')",
      "  while (!existsSync(join(root,'finish'))) await setTimeout(2)",
      "  release()",
      "} catch (error) { console.log(error.message) }",
    ].join('\n')
    const workers = ['runtime','maintenance'].map(mode => {
      const child = spawn(process.execPath,['--input-type=module','-e',script,f.root,mode],{stdio:['ignore','pipe','pipe']})
      const exited = once(child,'close')
      const text = Promise.race([
        once(child.stdout,'data').then(([data]) => String(data).trim()),
        exited.then(() => ''),
      ])
      return {child,exited,text}
    })
    try {
      f.write('begin','start')
      const observed = await Promise.all(workers.map(worker => worker.text))
      expect(observed.filter(line => line === 'held')).toHaveLength(1)
      expect(observed.find(line => line !== 'held')).toContain('占用')
      expect(f.json<{pid:number}>('ops/.chief.lock').pid).not.toBe(2_147_000_000)
    } finally {
      f.write('finish','exit')
      await Promise.all(workers.map(worker => worker.exited))
    }
    expect(existsSync(f.path('ops','.chief.lock'))).toBe(false)
  })

  it('已被独立资料引用的原交付按保留清单处理', () => {
    const f = seeded()
    const path = 'ops/discussions/independent.json'
    const discussion = {document:{ticketId:'T-0001',path:'work/T-0001/legacy.txt'},messages:[{text:'仍在用的讨论'}],followUp:'T-0042'}
    f.write(path,{...discussion,remoteTurns:[{state:'waiting'}]})
    const waiting = cleanupLegacyOrders(f.root)
    expect(waiting.blockers).toEqual(['T-0001 工作端交付讨论尚未结清'])
    expect(() => cleanupLegacyOrders(f.root,waiting.id)).toThrow('在途工作')
    f.write(path,discussion)
    const preview = cleanupLegacyOrders(f.root)
    expect(preview.preserved).toContain(join('work','T-0001'))
    expect(preview.preserved).toContain(join('ops','delivery-versions','T-0001'))
    cleanupLegacyOrders(f.root,preview.id)
    expect(existsSync(f.path('ops','tickets','T-0001.json'))).toBe(false)
    expect(f.read('work/T-0001/legacy.txt')).toBe('旧交付文件')
    expect(f.json(path)).toEqual({document:discussion.document,messages:discussion.messages})
  })

  it('清理旧工作目录时独立资料中的硬链接仍可读取', () => {
    const f = seeded()
    mkdirSync(f.path('notes'))
    linkSync(f.path('work','T-0001','legacy.txt'),f.path('notes','shared.txt'))
    cleanupLegacyOrders(f.root,cleanupLegacyOrders(f.root).id)
    expect(existsSync(f.path('work','T-0001','legacy.txt'))).toBe(false)
    expect(f.read('notes/shared.txt')).toBe('旧交付文件')
  })
})
