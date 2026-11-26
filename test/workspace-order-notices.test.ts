import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrderResultNotice, ResultNoticeList, SavedOrderResults } from '../src/core/workspace-notices.ts'
import type { V2Attachment, V2DialogueSource } from '../src/core/workspace-v2.ts'
import { serveApi } from '../src/dsh/http.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import { workspaceV2Routes } from '../src/dsh/workspace-v2.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'

const cleanup: (()=>void)[] = []
afterEach(() => cleanup.splice(0).reverse().forEach(cb=>cb()))
function fixture() {
  const scope='daily-fixture', root=mkdtempSync(join(tmpdir(),'chief-notices-'))
  cleanup.push(()=>rmSync(root,{recursive:true,force:true}))
  const clock = new Date()
  const evidence = new Map<string,SavedOrderResults>()
  const source: V2DialogueSource = {send:vi.fn(async()=>{}),read:vi.fn(async()=>({messages:[]})),attachment:vi.fn(async()=>undefined),
    savedResults:vi.fn((session,id) => evidence.get(session.id + ':' + id))}
  let store = new WorkspaceV2Store(root,scope)
  const mount = ()=>workspaceV2Routes({store,source,timeZone:'UTC',now:()=>new Date(clock)})
  let routes=mount(), n=0
  const dispose=()=>{routes.dispose();store.dispose()}
  cleanup.push(dispose)
  const restart=()=>{dispose();store=new WorkspaceV2Store(root,scope);routes=mount()}
  const makeOrder=(name:string)=>{
    const space=store.createWorkspace(mutationKey(['space'],{requestId:'space-' + ++n}),{name}).workspace
    return store.createDelegation(mutationKey(['order'],{requestId:'order-' + ++n}),space,{title:'调查结果'}).delegation
  }
  async function call<T>(resource:string,body?:Record<string,unknown>,options:{scope?:string;owner?:boolean;marker?:boolean}={}) {
    const url='/chief/api/v2/' + resource + '?scope=' + (options.scope ?? scope)
    const req=Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []),{method:body?'POST':'GET',url,
      headers:options.marker === false ? {} : {'x-chief-request':'1'}}) as unknown as IncomingMessage
    let status=0,data:T
    const res={writeHead(code:number){status=code},end(text:string){data=JSON.parse(text)}} as unknown as ServerResponse
    await serveApi(req,res,'dsh',[routes],options.owner??true)
    return {status,data:data!}
  }
  const file=(id:string,label='方舟作业逐题答案、计时与执行记录') : V2Attachment =>
    ({id,label,format:'markdown',content:'# 核验经过\n第 3 项受运行环境限制；其他项目的结论见表。'})
  const at=()=>clock.toISOString()
  const collect=()=>routes.notices.collect()
  const publish=async(job:ReturnType<typeof makeOrder>,turnId:string,records:SavedOrderResults)=>{
    evidence.set(job.sessionId+':'+turnId,records)
    return call('workspaces/'+job.workspaceId+'/sessions/'+job.sessionId+'/messages',{requestId:turnId,workOrderId:job.id,text:'请交调查报告。'})
  }
  const downgrade=(tooOld: string[] = [], interrupted?: string)=>{
    const dataPath=join(root,'ops','superhub-v2',workspaceFingerprint(scope)+'.json')
    const board=JSON.parse(readFileSync(dataPath,'utf8'))
    delete board.resultNotices
    delete board.resultNoticesBackfilled
    for(const [key,entry] of Object.entries(board.receipts) as [string,{kind:string;state:string;resultCheck?:string;at:string}][]){
      if(entry.kind!=='turn') continue
      delete entry.resultCheck
      if (key === 'req-' + interrupted) entry.state = 'pending'
      if(tooOld.includes(key.slice(4))) entry.at=new Date(clock.getTime()-2*86_400_000).toISOString()
    }
    writeFileSync(dataPath,JSON.stringify(board))
    restart()
  }
  return {makeOrder,call,publish,collect,restart,downgrade,at,file,source,evidence,
    see:()=>routes.notices.list(0),record:(id:string)=>store.resultNotice(id),service:()=>routes.followup,clock,scope}
}

describe('SuperHub 工作区站内交付回执',()=>{
  it('surfaces the actual final file once, opens the original version and remembers read state across restarts',async()=>{
    const f=fixture(),job=f.makeOrder('研究'),other=f.makeOrder('私事'), doc=f.file('f1')
    const actual={author:'Codex',role:'agent' as const,at:f.at(),workOrderId:job.id}
    const evidence={attachments:[doc],messages:[
      {...actual,id:'plan',text:'我会先整理运行方案。'}, {...actual,id:'update',text:'正在检查前四项。'},
      {...actual,id:'report',text:'已提交核验记录，其中有未完成项。', attachments:[{id:doc.id,label:doc.label}]},
      {...actual,id:'sibling',workOrderId:other.id,text:'阶段回报\n其他项目的私有计划。'},
    ]}
    expect((await f.publish(job,'run',evidence)).status).toBe(200)
    const index=(await f.call<ResultNoticeList>('notices')).data
    expect(index.unread).toBe(1)
    const row=index.items[0]!
    expect(row).toMatchObject({workspaceId:job.workspaceId,orderId:job.id,sessionId:job.sessionId,messageId:'report',title:doc.label,kind:'report'})
    expect(row).not.toHaveProperty('text')
    expect(row).not.toHaveProperty('requestId')
    expect(JSON.stringify(index)).not.toContain('其他项目')
    const base='notices/'+row.id
    expect((await f.call<{text:string}>(base)).data.text).toBe('已提交核验记录，其中有未完成项。')
    expect((await f.call<{attachment:V2Attachment}>(base+'/attachments/'+doc.id)).data.attachment.content).toBe(doc.content)
    expect((await f.call(base,undefined,{scope:'other-brain'})).status).toBe(409)
    expect((await f.call(base,undefined,{owner:false})).status).toBe(403)
    expect((await f.call(base+'/read',{requestId:'see'},{marker:false})).status).toBe(403)
    expect((await f.call<{notice:OrderResultNotice}>(base+'/read',{requestId:'see'})).data.notice.read).toBe(true)
    f.restart();f.collect()
    expect(f.see()).toMatchObject({unread:0,total:1,items:[{id:row.id,read:true}]})
    evidence.attachments[0]={...doc,content:'被换掉的内容'}
    expect((await f.call(base+'/attachments/'+doc.id)).status).toBe(404)
    expect((await f.call<{text:string}>(base)).data.text).toContain('未完成项')
    expect((await f.call<{order:{status:string}}>('workspaces/'+job.workspaceId+'/orders/'+job.id)).data.order.status).toBe('waiting')
  })

  it('marks each deleted link on read and keeps the original delivery and version readable', async () => {
    const f = fixture(), job = f.makeOrder('删工单项目'), other = f.makeOrder('保留项目'), file = f.file('archived')
    const readResult = (id: string, orderId: string): SavedOrderResults => ({attachments:[file],messages:[{
      id,role:'agent',author:'执行者',at:f.at(),workOrderId:orderId,text:'工单回报\n交付留存',attachments:[{id:file.id,label:file.label}],
    }]})
    expect((await f.publish(job,'delete-a',readResult('source-a',job.id))).status).toBe(200)
    expect((await f.publish(other,'keep-b',readResult('source-b',other.id))).status).toBe(200)
    const old = f.see().items.find(row => row.orderId === job.id)!
    const original = structuredClone(f.record(old.id))
    const order = await f.call<{deletedAt:string}>('workspaces/' + job.workspaceId + '/orders/' + job.id + '/delete',{requestId:'delete-order'})
    expect(order.status).toBe(200)
    expect(f.see().items.find(row => row.id === old.id)).toMatchObject({orderDeletedAt:order.data.deletedAt,read:false})
    expect(f.see().items.find(row => row.id === old.id)).not.toHaveProperty('sessionDeletedAt')
    const session = await f.call<{deletedAt:string}>('workspaces/' + job.workspaceId + '/sessions/' + job.sessionId + '/delete',{requestId:'delete-session'})
    expect(session.status).toBe(200)
    const path = 'notices/' + old.id
    const detail = await f.call<{notice:OrderResultNotice;text:string}>(path)
    expect(detail.data).toMatchObject({notice:{orderDeletedAt:order.data.deletedAt,sessionDeletedAt:session.data.deletedAt},text:'交付留存'})
    expect(f.record(old.id)).toEqual(original)
    expect((await f.call<{notice:OrderResultNotice}>(path + '/read',{requestId:'read-deleted'})).data.notice.read).toBe(true)
    expect((await f.call<{attachment:V2Attachment}>(path + '/attachments/' + file.id)).data.attachment).toEqual({...file,version:old.attachments[0]!.version})
    f.restart()
    f.collect()
    const current = f.see()
    expect(current).toMatchObject({total:2,unread:1})
    const active = current.items.find(row => row.orderId === other.id)!
    expect(active).not.toHaveProperty('orderDeletedAt')
    expect(active).not.toHaveProperty('sessionDeletedAt')
    expect(active.read).toBe(false)
  })

  it('reconstructs a recent delivery from the prior release with no re-execution, selects no old or unverified work and deduplicates on another boot',async()=>{
    const f=fixture(),job=f.makeOrder('新报告'),old=f.makeOrder('过去的报告')
    const e=(id:string,orderId:string,text:string,attached:boolean):SavedOrderResults=>{
      const doc=f.file(id)
      return {messages:[{id,role:'agent',author:'Codex',at:f.at(),text,workOrderId:orderId,
        attachments:attached?[{id,label:doc.label}]:undefined}],attachments:attached?[doc]:[]}
    }
    await f.publish(old,'past',e('old-message',old.id,'旧报告',true))
    await f.publish(job,'ask',e('q',job.id,'是否需要周五交稿？',false))
    await f.publish(job,'actual',e('new-message',job.id,'部分题受限，详见报告。',true))
    const count=vi.mocked(f.source.send).mock.calls.length
    f.downgrade(['past'])
    f.collect();f.collect()
    expect(f.see().items.map(row=>row.messageId)).toEqual(['new-message'])
    expect(f.source.send).toHaveBeenCalledTimes(count)
    expect(f.source.read).not.toHaveBeenCalled()
    expect(f.source.attachment).not.toHaveBeenCalled()
    f.restart();f.collect()
    expect(f.see().total).toBe(1)
  })

  it('accepts explicit natural language and structured result reports without claiming full completion or notifying for a question',async()=>{
    const f=fixture(),job=f.makeOrder('文字交付')
    const answers=['我马上开始。','工单回报\n样本 A 已验证。','阶段回报\n另两项缺少样本，结论待定。',
      '```chief-report\n{"status":"question","summary":"还需要确认","question":"哪个样本？"}\n```']
    const messages=answers.map((text,i)=>({id:'m'+i,at:f.at(),author:'工程师',role:'agent' as const,workOrderId:job.id,text}))
    await f.publish(job,'words',{attachments:[],messages})
    expect(f.see().items.map(row=>[row.messageId,row.kind]).sort()).toEqual([['m1','report'],['m2','partial']])
    const partial=f.see().items.find(row=>row.kind==='partial')!
    expect((await f.call<{text:string}>('notices/'+partial.id)).data.text).toBe('另两项缺少样本，结论待定。')
  })

  it('checks older pending deliveries even when a full batch of newer native sessions remains unavailable',async()=>{
    const f=fixture(), job=f.makeOrder('延迟到达的报告')
    const endpoint='workspaces/'+job.workspaceId+'/sessions/'+job.sessionId+'/messages'
    const ids=['z-recovered',...Array.from({length:16},(_,i)=>'missing-'+i)]
    for(const requestId of ids) {
      expect((await f.call(endpoint,{requestId,workOrderId:job.id,text:'请交回本轮的报告。'})).status).toBe(200)
    }
    f.evidence.set(job.sessionId+':z-recovered',{messages:[{id:'saved',author:'工程师',role:'agent',workOrderId:job.id,
      at:f.at(),text:'工单回报\n已核对这份迟到的报告。'}],attachments:[]})
    f.restart()
    const read=vi.mocked(f.source.savedResults!)
    read.mockClear()
    f.collect()
    expect(read).toHaveBeenCalledTimes(15)
    expect(f.see().total).toBe(0)
    f.collect()
    expect(read).toHaveBeenCalledTimes(30)
    expect(f.see()).toMatchObject({total:1,unread:1,items:[{orderId:job.id,messageId:'saved'}]})
  })

  it('uses the saved native completion if the host stopped before persisting the turn receipt',async()=>{
    const f=fixture(),job=f.makeOrder('重启核对')
    await f.publish(job,'crashed',{messages:[{id:'final',author:'工程师',role:'agent',workOrderId:job.id,at:f.at(),text:'工单回报\n原会话已核对样本。'}],attachments:[]})
    f.downgrade([],'crashed')
    expect(f.see().total).toBe(0)
    f.collect();f.restart();f.collect()
    expect(f.see()).toMatchObject({total:1,unread:1,items:[{messageId:'final'}]})
    expect(f.source.send).toHaveBeenCalledTimes(1)
  })

  it('links an automatic weekly delivery to the same frozen period without forwarding or announcing manual rereads',async()=>{
    const f=fixture(),job=f.makeOrder('工作产出')
    f.clock.setTime(Date.parse('2026-12-29T12:00:00Z'))
    await f.service().apply(job.workspaceId,job.id,{action:'schedule',requestId:'weekly-plan',weekday:5,time:'17:00'})
    f.clock.setTime(Date.parse('2027-01-01T17:01:00Z'))
    await f.service().tick();await f.service().tick()
    const report=f.service().view(job.workspaceId,job.id).reports[0]!
    expect(f.see()).toMatchObject({unread:1,total:1,items:[{kind:'weekly',orderId:job.id,reportId:report.id}]})
    await f.service().apply(job.workspaceId,job.id,{action:'draft',requestId:'same-report'})
    f.restart();f.collect()
    expect(f.see().total).toBe(1)
  })
})
