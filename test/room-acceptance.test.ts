/** Deterministic route/storage acceptance. Native-kernel evidence is collected by native-acceptance.mjs. */
import {describe,it,expect} from 'vitest'
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:http'
import {createHash,randomUUID} from 'node:crypto'
import {NativeRooms} from '../src/dsh/rooms.ts'
import type {RoomWork,WorkThread} from '../src/dsh/room-work.ts'
import {runtimeRoutes,serveApi} from '../src/dsh/http.ts'
import type {Agent,HostContext,SessionEventLike} from '../src/dsh/ports.ts'
function fixture(work?:RoomWork){
 const root=mkdtempSync(join(tmpdir(),'chief-room-acceptance-')),events=new Map<string,SessionEventLike[]>(),agents=new Map<string,Agent>(),prompts:string[]=[]
 const sections=new Map<string,()=>string>();let creates=0
 const add=(session:string,text:string,rpcId:string=randomUUID())=>{const rows=events.get(session)??[],id=randomUUID(),data={id,source:{kind:'user',rpcId},content:[{type:'text',text}]};rows.push({seq:rows.length+1,time:Date.now(),type:'agent/inbox/spliced',data:{inserted:[data]}});rows.push({seq:rows.length+1,time:Date.now(),type:'user/message',data});events.set(session,rows);return `${session}:${rows.length-1}:0`}
 const makeAgent=(id:string):Agent=>({id,session:{snapshotEvents:()=>events.get(id)??[]},ctx:{systemPrompt:{section:section=>{sections.set(id,typeof section.text==='function'?section.text:()=>section.text as string);return()=>{sections.delete(id)}}}}})
 const ctx={agents:{get:(id:string)=>agents.get(id)},workspaceRegistry:{create:async()=>({id:'workspace'})},get:(service:string)=>service==='sessionQuery'?{observeSession:async(id:string)=>({events:events.get(id)??[],[Symbol.dispose](){}})}:{listMembers:(lead:Agent)=>[{id:lead.id,name:'lead',role:'lead',status:'inactive',diagnostics:[]}],listTasks:()=>[],tryMembership:(agent:Agent)=>({root:agent,id:agent.id,name:'lead',role:'lead'})},sessionController:{resolveAgent:async(id:string)=>agents.has(id)?{agent:agents.get(id)}:{error:{code:'session/not-found'}},create:async({sessionId}:{sessionId:string})=>{creates++;agents.set(sessionId,makeAgent(sessionId))},prompt:async(input:{sessionId:string;requestId:string;content:{text:string}[]})=>{prompts.push(input.sessionId);add(input.sessionId,input.content[0]!.text,input.requestId);return{messageId:input.requestId}}}} as unknown as HostContext
 const rooms=new NativeRooms(ctx,root,()=>[],undefined,work)
 return{root,ctx,rooms,events,prompts,sections,add,creates:()=>creates,close:()=>{rooms.dispose();rmSync(root,{recursive:true,force:true})}}
}
describe('T04/T05/T08/T11 讨论完整性验收',()=>{
 it('空笔记的原生讨论读取本工单的最新实际回报、核验和回复；重启后仍按关联隔离',async()=>{
  const at='2026-11-17T07:24:00Z'
  const ticket:WorkThread={thread_id:'thread',ticket_id:'T-0011',title:'安装 arkcli',stage:'you/review',read_only:false,reply_to:'next',execution_boundary:'local',executions:[],messages:[
   {id:'report',role:'staff',at,text:'已安装 1.0.50，使用项目内 CLI 登录',status:'ready'},
   {id:'review',role:'verifier',at,text:'已核验版本，审查要求补证',status:'revise'},
  ]}
  const work:RoomWork={links:()=>new Map([['ark',['T-0011']]]),thread:id=>id===ticket.ticket_id?ticket:undefined}
  const f=fixture(work)
  try{
   const room=await f.rooms.create('ark','安装 arkcli')
   const other=await f.rooms.create('other','无关联')
   const section=f.sections.get(room.session)!
   expect(f.rooms.meta(room.id).notes).toEqual([])
   expect(f.rooms.meta(room.id).tickets).toEqual(['T-0011'])
   expect(section()).toContain(ticket.messages[0]!.text)
   expect(section()).toContain(ticket.messages[1]!.text)
   expect(section()).toContain('待验收')
   expect(f.sections.get(other.session)!()).not.toContain('T-0011')
   expect(()=>f.rooms.workThread(other.id,'T-0011')).toThrow('未关联当前讨论')
   ticket.messages.push({id:'input:reply:latest',role:'owner',at,text:'先保留现有版本，登录由我完成'})
   expect(section()).toContain(ticket.messages.at(-1)!.text)
   expect(f.prompts).toHaveLength(0)
   const restored=new NativeRooms(f.ctx,f.root,()=>[],undefined,work)
   try{
    restored.attachContext(await restored.agent(room.id))
    expect(f.sections.get(room.session)!()).toContain(ticket.messages.at(-1)!.text)
   }finally{restored.dispose()}
  }finally{f.close()}
 })
 it('T05：原生序号游标补齐不重复，旧引用仍可定位，越过末尾或跨脑游标回退完整快照',async()=>{
  const f=fixture()
  try{
   const room=await f.rooms.create('cursor','游标恢复'),source=f.add(room.session,'游标之前的原话')
   const initial=await f.rooms.view(room.id)
   await f.rooms.say(room.id,'cursor-reply','重连后补齐的引用','lead',source)
   const delta=await f.rooms.view(room.id,initial.cursor)
   expect(delta.incremental).toBe(true);expect(delta.messages).toHaveLength(1);expect(delta.messages[0]?.replyTo).toBe(source)
   expect((await f.rooms.view(room.id,delta.cursor)).messages).toEqual([])
   expect((await f.rooms.view(room.id,initial.cursor)).messages).toEqual(delta.messages)
   for(const cursor of [{session:'another-brain',positions:initial.cursor.positions},{session:room.session,positions:{[room.session]:Number.MAX_SAFE_INTEGER}}]){
    const reset=await f.rooms.view(room.id,cursor);expect(reset.incremental).toBe(false);expect(reset.messages).toHaveLength(2)
   }
  }finally{f.close()}
 })
 it('原生新成员建立日志前能读群主历史与名册，建立后按同一游标补齐并继续核对请求归属',async()=>{
  const f=fixture()
  try{
   const room=await f.rooms.create('joining','初次讨论'), peer='new-reviewer'
   const hostGet=f.ctx.get.bind(f.ctx) as (service:string)=>unknown
   const native=f.ctx.get('agentTeams')!, query=f.ctx.get('sessionQuery')!
   let status:'provisioning'|'running'='provisioning', corrupt=false, missingLead=false, foreign=false, useQuery=true
   const missing=()=>Object.assign(new Error('原生会话尚不存在'),{code:'SESSION_QUERY_SESSION_NOT_FOUND'})
   Object.assign(f.ctx,{get:(service:string)=>{
    if(service==='agentTeams')return {...native,
     tryMembership:(agent:Agent)=>foreign ? {root:{id:'another-room'}} : native.tryMembership(agent),
     listMembers:(lead:Agent)=>[...native.listMembers(lead),{id:peer,name:'reviewer',role:'teammate',status,diagnostics:[]}]}
    if(service==='sessionQuery')return useQuery ? {observeSession:async(id:string)=>{
     if(id===room.session && missingLead)throw missing()
     if(id===peer && corrupt)throw Object.assign(new Error('日志读盘出错'),{code:'SESSION_QUERY_STORAGE_ERROR'})
     if(id===peer && !f.events.has(peer))throw missing()
     return query.observeSession(id)
    }} : undefined
    return hostGet(service)
   }})
   f.add(room.session,'群主原话','first')
   const first=await f.rooms.view(room.id)
   expect(first.messages.map(m=>m.text)).toEqual(['群主原话'])
   expect(first.members.find(m=>m.id===peer)?.status).toBe('provisioning')
   expect(first.cursor.positions[peer]).toBe(0)
   useQuery=false
   expect((await f.rooms.view(room.id)).messages).toEqual(first.messages)
   useQuery=true
   await f.rooms.say(room.id,'lead-followup','继续处理')
   await f.rooms.say(room.id,'lead-followup','继续处理')
   expect(f.prompts).toEqual([room.session])
   await expect(f.rooms.say(room.id,'premature','新指示','reviewer')).rejects.toThrow('暂不可接收')
   const during=await f.rooms.view(room.id,first.cursor)
   expect(during.incremental).toBe(true)
   expect(during.messages.map(m=>m.text)).toEqual(['继续处理'])
   // The log can exist before the roster flips to running. Check it before accepting a duplicate at another recipient.
   f.add(peer,'刚收到的任务','peer-rpc')
   await expect(f.rooms.say(room.id,'peer-rpc','刚收到的任务')).rejects.toThrow('已用于另一条原话')
   status='running'
   const joined=await f.rooms.view(room.id,during.cursor)
   expect(joined.incremental).toBe(true)
   expect(joined.messages.map(m=>m.text)).toEqual(['刚收到的任务'])
   expect((await f.rooms.view(room.id,during.cursor)).messages).toEqual(joined.messages)
   expect((await f.rooms.view(room.id,joined.cursor)).messages).toEqual([])
   f.events.delete(peer)
   await expect(f.rooms.view(room.id)).rejects.toThrow('原生会话尚不存在')
   await expect(f.rooms.say(room.id,'missing-member','继续')).rejects.toThrow('原生会话尚不存在')
   status='provisioning'
   await expect(f.rooms.stop(room.id)).rejects.toThrow('原生会话尚不存在')
   expect(f.rooms.meta(room.id).stoppedThrough).toBeUndefined()
   corrupt=true
   await expect(f.rooms.view(room.id)).rejects.toThrow('日志读盘出错')
   await expect(f.rooms.say(room.id,'storage-error','继续')).rejects.toThrow('日志读盘出错')
   corrupt=false;foreign=true
   await expect(f.rooms.view(room.id)).rejects.toThrow('归属不匹配')
   foreign=false;missingLead=true
   await expect(f.rooms.view(room.id)).rejects.toThrow('原生会话尚不存在')
   expect(f.prompts).toEqual([room.session])
  }finally{f.close()}
 })
 it('T04：零工单、两张同名工作、旧入口重复关联及跨脑同号拒绝',async()=>{
  const f=fixture(),other=fixture();const tickets=[{ticket:{id:'T-0001',title:'同名工作',ended:{outcome:'done'}}},{ticket:{id:'T-0002',title:'同名工作'}}]
  let rooms=f.rooms
  const route=()=>runtimeRoutes({rooms,engine:{views:()=>tickets},brain:{},roster:{}} as unknown as Parameters<typeof runtimeRoutes>[0])
  const server=createServer((req,res)=>void serveApi(req,res,'dsh',[route()]))
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/chief/api`
  const post=async(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:{'x-chief-request':'1','content-type':'application/json'},body:JSON.stringify(body)})
  try{
   const room=await rooms.create('topic','同名讨论');await rooms.say(room.id,'initial-chat','先聊天，不建工作')
   expect(rooms.meta(room.id).tickets).toBeUndefined()
   for(const ticket of tickets)expect((await post('/rooms/topic/link',{session:room.session,ticket:ticket.ticket.id})).status).toBe(200)
   expect(rooms.meta(room.id).tickets).toEqual(['T-0001','T-0002'])
   for(let n=0;n<2;n++)for(const ticket of tickets){const response=await post('/rooms/from-ticket',{ticket:ticket.ticket.id});expect(response.status).toBe(200);expect((await response.json()).id).toBe('topic')}
   expect(rooms.list()).toHaveLength(1);expect(f.prompts).toHaveLength(1)
   expect(tickets[0]!.ticket.ended?.outcome).toBe('done')
   rooms=other.rooms;const second=await rooms.create('topic','同名讨论');expect(second.session).not.toBe(room.session)
   expect((await post('/rooms/topic',{session:room.session,request_id:'stale',text:'不得串脑'})).status).toBe(409)
   expect(other.prompts).toHaveLength(0)
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();other.close()}
 })
 it('T04/T05：旧目录迁移两次，损坏及未完成的索引可从主记录重建，消息不复制',async()=>{
  const f=fixture()
  try{
   const room=await f.rooms.create('legacy','旧话题'),source=f.add(room.session,'旧原话保留')
   await f.rooms.note(room.id,{id:'old-note',source,text:'旧版带来源笔记',category:'pending',by:'you'})
   f.rooms.link(room.id,'T-0001')
   const legacy=readFileSync(join(f.root,'ops/room-index.json'),'utf8')
   rmSync(join(f.root,'ops/rooms'),{recursive:true,force:true});writeFileSync(join(f.root,'ops/room-index.json'),legacy)
   let rooms=new NativeRooms(f.ctx,f.root,()=>[])
   expect(existsSync(join(f.root,'ops/rooms/legacy.json'))).toBe(true)
   const first=await rooms.view(room.id);rooms.dispose()
   rooms=new NativeRooms(f.ctx,f.root,()=>[]);expect(await rooms.view(room.id)).toEqual(first);rooms.dispose()
   writeFileSync(join(f.root,'ops/room-index.json'),'{incomplete');writeFileSync(join(f.root,'ops/room-index.json.tmp'),'partial')
   rooms=new NativeRooms(f.ctx,f.root,()=>[]);const rebuilt=await rooms.view(room.id)
   expect(rebuilt).toEqual(first);expect(f.creates()).toBe(1);expect(f.prompts).toHaveLength(0)
   expect(JSON.parse(readFileSync(join(f.root,'ops/room-index.json'),'utf8'))).toHaveLength(1);rooms.dispose()
  }finally{f.close()}
 })
 it('T05/T08：两万字原话、双消费日志去重、引用、原请求重放与两次重建',async()=>{
  const f=fixture()
  try{
   const room=await f.rooms.create('long','长消息'),text='首标记'+('原话与附件正文。'.repeat(2500))+'尾标记',source=f.add(room.session,text,'long-message')
   expect(text.length).toBeGreaterThanOrEqual(20000)
   await Promise.all([f.rooms.say(room.id,'reply','引用后的补充','lead',source),f.rooms.say(room.id,'reply','引用后的补充','lead',source)])
   const first=await f.rooms.view(room.id);expect(first.messages).toHaveLength(2);expect(first.messages[0]?.text).toBe(text);expect(first.messages[1]?.replyTo).toBe(source)
   await f.rooms.say(room.id,'reply','引用后的补充','lead',source);expect(f.prompts).toHaveLength(1)
   await expect(f.rooms.say(room.id,'wrong','越权引用','lead','other-session:1')).rejects.toThrow('不属于')
   for(const broken of ['broken','{}','null']){writeFileSync(join(f.root,'ops/room-index.json'),broken);const restored=new NativeRooms(f.ctx,f.root,()=>[]);expect((await restored.view(room.id)).messages).toEqual(first.messages);restored.dispose()}
  }finally{f.close()}
 })
 it('T11：纠错立即进入下一次原生提示，旧撤销冲突，合法恢复留新版本且不写长期偏好',async()=>{
  const f=fixture()
  try{
   writeFileSync(join(f.root,'AGENTS.md'),'主人确认过的长期原则，测试不得改动')
   const room=await f.rooms.create('notes','本次范围'),source=f.add(room.session,'本次只看派工')
   await f.rooms.say(room.id,'attach','只连接原生提示区块')
   const before=createHash('sha256').update(readFileSync(join(f.root,'AGENTS.md'))).digest('hex')
   await f.rooms.note(room.id,{id:'scope',source,text:'本次只看派工',category:'agreement',by:'you'})
   expect(f.sections.get(room.session)?.()).toContain('本次只看派工')
   await f.rooms.note(room.id,{id:'scope',version:1,source,reason:'本轮范围已扩大，修正过早的摘要',text:'主人纠正：本次还需验证唤醒；不得扩成长期偏好',category:'agreement',by:'you'})
   expect(f.sections.get(room.session)?.()).toContain('主人纠正：本次还需验证唤醒')
   expect(f.sections.get(room.session)?.()).not.toContain('"text":"本次只看派工"')
   await expect(f.rooms.restoreNote(room.id,'scope',1,1)).rejects.toThrow('已更新')
   await f.rooms.restoreNote(room.id,'scope',2,1)
   expect(f.rooms.meta(room.id).notes[1]?.reason).toBe('本轮范围已扩大，修正过早的摘要')
   expect(f.rooms.meta(room.id).notes[2]?.reason).toBe('恢复修订 1')
   expect(f.rooms.meta(room.id).notes.map(n=>[n.version,n.by])).toEqual([[1,'you'],[2,'you'],[3,'you']])
   expect(createHash('sha256').update(readFileSync(join(f.root,'AGENTS.md'))).digest('hex')).toBe(before)
   const restored=new NativeRooms(f.ctx,f.root,()=>[]);expect(restored.meta(room.id).notes).toEqual(f.rooms.meta(room.id).notes);restored.dispose()
  }finally{f.close()}
 })
})
