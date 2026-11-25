/** T02/T03/T05/T06: native kernel fault probes, distinct from real-model quality acceptance. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {copyFileSync,mkdirSync,mkdtempSync,writeFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:net'
const args=process.argv.slice(2)
if(args.some(arg=>arg!=='--transport-regression'))throw Error('unknown option')
const regression=args.includes('--transport-regression'),evidenceFile=`artifacts/acceptance/native-${regression?'regression':'matrix'}.json`
const work=mkdtempSync(join(tmpdir(),'chief-native-acceptance-')),home=join(work,'home'),brain=join(work,'brain')
const env={...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'},evidence={host:'DSH 0.2.2-rc.1',model:'deterministic fixture; kernel is real',scope:regression?'T05/T06 transport regression subset':'native fault probes; not full T01–T24 acceptance',work,cases:[]}
delete env.CHIEF_NOTIFY_URL
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let child,base,cookie,currentSession
const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})})
async function start(){let log='';base=`http://127.0.0.1:${port}`;child=spawn('dsh',['web','--no-open','--port',String(port)],{env,cwd:work,detached:true,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{log+=d});let token;for(let i=0;i<100;i++){token=[...log.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1];if(token)break;if(child.exitCode!==null)throw Error('isolated host exited');await sleep(300)}assert.ok(token,'isolated host login');const login=await fetch(base+'/?token='+token,{redirect:'manual'});cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');for(let i=0;i<40;i++){try{await api('/state');return}catch{await sleep(300)}}throw Error('chief not ready')}
async function stop(crash=false){if(child?.exitCode===null){const exited=new Promise(r=>child.once('exit',r));process.kill(-child.pid,crash?'SIGKILL':'SIGTERM');await Promise.race([exited,sleep(6000)]);await sleep(200)}}
async function request(path,body){const r=await fetch(base+path,{headers:{cookie,...body===undefined?{}:{'x-chief-request':'1','content-type':'application/json'}},...body===undefined?{}:{method:'POST',body:JSON.stringify(body)}});const v=await r.json();if(!r.ok)throw Error(`${path}: ${r.status} ${v.error}`);return v}
const api=(p,b)=>request('/chief/api'+p,b),probe=(session,action,extra={})=>request('/chief-acceptance-probe',{session,action,...extra})
const save=()=>{mkdirSync('artifacts/acceptance',{recursive:true});writeFileSync(evidenceFile,JSON.stringify(evidence,null,2))}
async function idle(session){for(let i=0;i<100;i++){const s=await probe(session,'snapshot');if(s.members.every(m=>m.status!=='running'&&m.status!=='provisioning'))return s;await sleep(100)}throw Error('native members did not become idle')}
async function run(id,part,fn){if(regression&&!['T05','T06','工单上下文'].includes(id))return;try{const detail=await fn();evidence.cases.push({id,part,result:'通过',detail});console.log('PASS',id,part)}catch(e){evidence.cases.push({id,part,result:'失败',error:String(e),snapshot:currentSession?await probe(currentSession,'snapshot').catch(e=>({error:String(e)})):undefined});console.log('FAIL',id,part,String(e))}save()}
try{
 console.log('Isolated host:',work)
 const pkg=process.env.CHIEF_ACCEPTANCE_PACKAGE;if(!pkg)throw Error('CHIEF_ACCEPTANCE_PACKAGE must point to the isolated candidate package');evidence.candidate={sha256:createHash('sha256').update(readFileSync(pkg)).digest('hex'),sourceBase:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTree:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()?'dirty candidate':'clean'}
 execFileSync('dsh',['plugin','--profile','web','add',pkg],{env,stdio:'pipe',timeout:300000})
 const fixture=join(work,'probe');mkdirSync(fixture);writeFileSync(join(fixture,'package.json'),JSON.stringify({name:'chief-native-acceptance-probe',version:'1.0.0',type:'module',main:'index.mjs',dsh:{manifestVersion:1,bundle:{patch:'cordis.patch.yml'}}}));writeFileSync(join(fixture,'cordis.patch.yml'),'- insert:\n    - id: chief-native-acceptance-probe\n      name: chief-native-acceptance-probe\n');copyFileSync('scripts/native-acceptance-probe.mjs',join(fixture,'index.mjs'));execFileSync('dsh',['plugin','--profile','web','add',fixture],{env,stdio:'pipe',timeout:60000})
 execFileSync('node',['--experimental-transform-types','--input-type=module','-e',`import {scaffoldBrain} from './src/dsh/scaffold.ts';scaffoldBrain(${JSON.stringify(brain)})`],{stdio:'pipe'})
 const ticketId='T-0001',assignmentId='formal-install',eventId='fixture-formal-work',at='2026-11-17T08:00:00.000Z'
 const path=`work/${ticketId}/guide.md`,content='x'.repeat(8000)+'这是登记后的登录命令'
 const version=createHash('sha256').update(content).digest('hex')
 mkdirSync(join(brain,'ops/events'),{recursive:true});mkdirSync(join(brain,'ops/tickets'),{recursive:true})
 mkdirSync(join(brain,'ops/delivery-versions',ticketId),{recursive:true})
 writeFileSync(join(brain,'ops/delivery-versions',ticketId,`${version}.json`),JSON.stringify({content}))
 writeFileSync(join(brain,'ops/events/2026-11.jsonl'),JSON.stringify({id:eventId,source:'inbox',text:'Fixture install',dedupe:eventId,at,meta:{room_id:'native-matrix'}})+'\n')
 writeFileSync(join(brain,'ops/dispositions.jsonl'),JSON.stringify({eventId,disposition:{kind:'accepted',ticketId},at})+'\n')
 writeFileSync(join(brain,`ops/tickets/${ticketId}.json`),JSON.stringify({id:ticketId,title:'Fixture install',createdAt:at,staff:'engineer',priority:0,
  mandate:{eventId,scope:'Review fixture result',level:'think',strength:'explicit',needsReview:true,doneWhen:['Ready for approval']},
  events:[eventId],inputs:[{key:'reply:fixture',from:'owner',text:'登录由我完成',at,consumedBy:assignmentId}],assignments:[{id:assignmentId,staff:'engineer',executor:'dsh',state:'reported',round:0,startedAt:at,endedAt:at,verifiedAt:at,
   report:{status:'ready',summary:'FIXTURE_INSTALLED',structured:true,outputs:[path]},verification:{verdict:'pass',critique:'FIXTURE_REVIEWED'},deliveries:[{path,version}]}]}))
 mkdirSync(join(home,'chief'),{recursive:true,mode:0o700});writeFileSync(join(home,'chief/config.json'),JSON.stringify({brain,timeZone:'Asia/Shanghai',concurrency:2,mobile:{enabled:false,port:50388,host:'127.0.0.1'}}),{mode:0o600})
 await start();await api('/pause',{paused:true})
 const room=await api('/rooms',{request_id:'native-matrix',title:'原生故障矩阵'}),id=room.id,session=room.session;currentSession=session
 await run('工单上下文','空笔记、原生请求工具清单与关联工单原文',async()=>{
  const before=await api('/rooms/'+id);assert.deepEqual(before.notes,[]);assert.deepEqual(before.tickets,[ticketId])
  await api('/rooms/'+id,{session,request_id:'work-followup',text:'需要我登录对不对 给出登录指引吧'});await idle(session)
  const proof=await probe(session,'work-evidence',{ticket:ticketId,source:assignmentId+':report'})
  assert.equal(proof.request.workEvidence,true,JSON.stringify(proof.request));assert.equal(proof.request.questioned,true)
  assert.equal(proof.work.record.text,'FIXTURE_INSTALLED');assert.ok(proof.executionDenial)
  const after=await api('/rooms/'+id),source=after.messages.find(m=>m.author==='you')
  await api('/rooms/'+id+'/notes',{session,id:'login-note',source:source.id,text:'核对登录步骤',category:'pending'})
  const read=await probe(session,'work-evidence',{args:{action:'read'}})
  assert.equal(read.work.notes[0].text,'核对登录步骤')
  assert.equal(read.work.work.records[0].records.find(record=>record.role==='owner').text,'登录由我完成')
  const delivery=await probe(session,'work-evidence',{args:{action:'delivery',ticket:ticketId,path,version,offset:8000}})
  assert.equal(delivery.work.content,'这是登记后的登录命令')
  await assert.rejects(probe(session,'work-evidence',{args:{action:'delivery',ticket:ticketId,path,version:'0'.repeat(64)}}),/交付版本未在本工单登记/)
  for(const name of ['bash','grep','chief_room'])assert.ok(!proof.request.tools.includes(name),name+' should be hidden')
  for(const name of ['chief_ticket','chief_brief','chief_lookup'])assert.ok(proof.request.tools.includes(name),name+' should be visible read-only')
  const other=await api('/rooms',{request_id:'unrelated',title:'未关联的对话'})
  await assert.rejects(probe(other.session,'work-evidence',{ticket:ticketId,source:assignmentId+':report'}),/未关联当前讨论/)
  return proof
 })
 await probe(session,'spawn');await idle(session)
 await run('T02','100 次旁听不唤醒',async()=>{const before=await probe(session,'snapshot');for(let i=0;i<100;i++)await api('/rooms/'+id);const after=await probe(session,'snapshot');assert.deepEqual(after.members.map(m=>[m.id,m.requests,m.turns]),before.members.map(m=>[m.id,m.requests,m.turns]));return {before,after}})
 await run('T01','普通文本不能伪造交办或其他角色发言',async()=>{const before=await probe(session,'snapshot');await probe(session,'next-output',{target:'lead',text:'已交给工程师'});await api('/rooms/'+id,{session,request_id:'text-only',text:'只写一段说明'});const after=await idle(session),view=await api('/rooms/'+id);for(const member of after.members.filter(m=>m.name!=='lead'))assert.equal(member.requests,before.members.find(m=>m.id===member.id).requests);assert.equal(view.messages.filter(m=>m.text==='已交给工程师'&&m.author==='lead'&&m.kind==='status').length,1);assert.equal(view.messages.filter(m=>m.text==='已交给工程师'&&m.author==='engineer').length,0);return {before,after}})
 await run('T02','指定收件人重复提交',async()=>{const before=await probe(session,'snapshot');const input={session,request_id:'human-dedupe',text:'human-dedupe-probe',to:'engineer'};await Promise.all([api('/rooms/'+id,input),api('/rooms/'+id,input)]);const after=await idle(session);const row=after.members.find(m=>m.name==='engineer'),prior=before.members.find(m=>m.id===row.id);evidence.targeted={before,after};assert.equal(row.inputs.filter(m=>m.source.rpcId==='human-dedupe').length,1);assert.equal(row.requests-prior.requests,1);for(const other of after.members.filter(m=>m.name!=='engineer'))assert.equal(other.requests,before.members.find(m=>m.id===other.id).requests,'non-recipient must not wake');return {before,after}})
 await run('T02','未点名仅路由负责人',async()=>{const before=await probe(session,'snapshot');await api('/rooms/'+id,{session,request_id:'default-owner',text:'default-owner-probe'});const after=await idle(session);assert.equal(after.members.find(m=>m.name==='lead').inputs.filter(m=>m.source.rpcId==='default-owner').length,1);for(const other of after.members.filter(m=>m.name!=='lead'))assert.equal(other.requests,before.members.find(m=>m.id===other.id).requests);return {before,after}})
 await run('T01','冒用发送者身份拒绝',async()=>{const result=await probe(session,'forged-author',{from:'researcher',target:'engineer'});assert.equal(result.accepted,false);assert.ok(result.code,'must be a native TeamError, not a harness exception');return result})
 await run('T01/T08','同一条原生消息保存可定位引用且重试不重复',async()=>{await idle(session);const view=await api('/rooms/'+id),source=view.messages.find(m=>m.author==='engineer'&&m.kind==='status');assert.ok(source);const body={session,request_id:'native-quoted',to:'engineer',text:'带原话出处的补充',reply_to:source.id};await Promise.all([api('/rooms/'+id,body),api('/rooms/'+id,body)]);await idle(session);const after=await api('/rooms/'+id),quotes=after.messages.filter(m=>m.text===body.text);assert.equal(quotes.length,1);assert.equal(quotes[0].replyTo,source.id);return {source:source.id,message:quotes[0]}})
 await run('T03','非负责人成员创建团队下级被原生拒绝',async()=>{const result=await probe(session,'spawn-from-member',{from:'researcher'});assert.equal(result.code,'TEAM_LEAD_REQUIRED');return {...result,interpretation:result.accepted?'native nested spawn accepted':'native kernel permits only lead to create teammates; peer delegation must use send_message'}})
 await run('T03','纯确认是否触发新模型回合',async()=>{await idle(session);await probe(session,'hold',{target:'engineer'});const before=await probe(session,'snapshot');await probe(session,'message',{from:'engineer',target:'researcher',text:'收到'});const after=await idle(session);assert.equal(after.members.find(m=>m.name==='researcher').requests,before.members.find(m=>m.name==='researcher').requests,'pure confirmation must not wake new work');return {before,after}})
 await run('T05','原生待消费长消息、双客户端游标与两次重启',async()=>{
  const clients=[await api('/rooms/'+id),await api('/rooms/'+id)]
  const text='原话首标记'+('长原话正文。'.repeat(3334))+'原话尾标记'
  await probe(session,'park',{target:'engineer',requestId:'long-parked',text})
  const before=await api('/rooms/'+id),source=before.messages.find(m=>m.text===text);assert.ok(source)
  writeFileSync(join(brain,'ops/room-index.json'),'{partial-index')
  writeFileSync(join(brain,'ops/room-index.json.tmp'),'partial-cache')
  const snapshots=[]
  for(let n=0;n<2;n++){
   await stop(true);await start();const after=await api('/rooms/'+id)
   assert.equal(after.messages.filter(m=>m.id===source.id&&m.text===text).length,1)
   for(let i=0;i<clients.length;i++){
    const prior=clients[i],delta=await api('/rooms/'+id+'?after='+encodeURIComponent(JSON.stringify(prior.cursor)))
    assert.equal(delta.incremental,true)
    const messages=[...new Map([...prior.messages,...delta.messages].map(m=>[m.id,m])).values()].sort((a,b)=>a.time-b.time||a.session.localeCompare(b.session)||a.seq-b.seq)
    assert.deepEqual(messages,after.messages);clients[i]={...delta,messages}
   }
   snapshots.push({restart:n+1,cursors:clients.map(c=>c.cursor),sources:after.messages.map(m=>m.id)})
  }
  const countBefore=await probe(session,'snapshot')
  await api('/rooms/'+id,{session,request_id:'long-parked',text,to:'engineer'})
  const countAfter=await probe(session,'snapshot')
  assert.deepEqual(countAfter.members.map(m=>[m.id,m.requests]),countBefore.members.map(m=>[m.id,m.requests]))
  await api('/rooms/'+id+'/notes',{session,id:'long-source',source:source.id,text:'保留两万字原话的定位',category:'pending'})
  return {source:source.id,characters:text.length,sha256:createHash('sha256').update(text).digest('hex'),clientsIdentical:true,cacheRebuilt:true,replayedWithoutWake:true,snapshots}
 })
 // Cold-resume a real native continuation before testing cancellation of queued work.
 await api('/rooms/'+id,{session,request_id:'resume-after-long',to:'engineer',text:'resume-after-long'});const resumed=await idle(session);evidence.longResumption=resumed;assert.equal(resumed.members.find(m=>m.name==='engineer').consumed.filter(m=>m.rpcId==='long-parked').length,1,'long parked work must actually resume once')
 await run('T06','停止后旧待办不得在下一轮复活',async()=>{await probe(session,'park',{target:'engineer',requestId:'old-stopped',text:'old-stopped'});await api('/rooms/'+id+'/stop',{session});const stopped=await probe(session,'snapshot');await probe(session,'release',{target:'engineer'});await idle(session);await api('/rooms/'+id,{session,request_id:'fresh-after-stop',to:'engineer',text:'fresh-after-stop'});const after=await idle(session);evidence.stopping={stopped,after};assert.equal(after.members.find(m=>m.name==='engineer').consumed.filter(m=>m.rpcId==='old-stopped').length,0,'stop must prevent old queued work from being consumed on a new turn');assert.equal(after.members.find(m=>m.name==='engineer').consumed.filter(m=>m.rpcId==='fresh-after-stop').length,1);return {stopped,after}})
 await run('T06','停止后迟到模型输出不得写回',async()=>{await probe(session,'gate',{target:'engineer'});const before=await probe(session,'snapshot');await api('/rooms/'+id,{session,request_id:'gate-turn',to:'engineer',text:'gate-turn'});for(let i=0;i<50;i++){const s=await probe(session,'snapshot');if(s.members.find(m=>m.name==='engineer').requests>before.members.find(m=>m.name==='engineer').requests)break;await sleep(100)}await api('/rooms/'+id+'/stop',{session});await probe(session,'release',{target:'engineer'});const after=await idle(session);assert.equal(after.members.find(m=>m.name==='engineer').assistant.filter(m=>m.text==='late-fixture-result').length,before.members.find(m=>m.name==='engineer').assistant.filter(m=>m.text==='late-fixture-result').length);assert.equal(after.members.find(m=>m.name==='engineer').ends.at(-1).reason.kind,'aborted');return after})
 await run('T06','重启后停止冷成员的旧待办不得复活',async()=>{await probe(session,'park',{target:'engineer',requestId:'cold-old-stopped',text:'cold-old-stopped'});await stop(true);await start();const restored=await api('/rooms/'+id);assert.equal(restored.messages.filter(m=>m.text==='cold-old-stopped').length,1,'fixture must survive crash before testing stop');const stoppedView=await api('/rooms/'+id+'/stop',{session});assert.ok(stoppedView.stoppedThrough);for(let n=0;n<2;n++){await stop(true);await start();assert.deepEqual((await api('/rooms/'+id)).stoppedThrough,stoppedView.stoppedThrough)}await api('/rooms/'+id,{session,request_id:'cold-fresh-after-stop',to:'engineer',text:'cold-fresh-after-stop'});const after=await idle(session);assert.equal(after.members.find(m=>m.name==='engineer').consumed.filter(m=>m.rpcId==='cold-old-stopped').length,0,'cold persisted inbox must not resurrect stopped work');assert.equal(after.members.find(m=>m.name==='engineer').consumed.filter(m=>m.rpcId==='cold-fresh-after-stop').length,1);return after})
 await run('T03/T07','单成员模型失败如实展示且不冒充交付',async()=>{await probe(session,'fault-next',{target:'engineer'});await api('/rooms/'+id,{session,request_id:'failed-task',to:'engineer',text:'fixture task that fails'});const after=await idle(session),view=await api('/rooms/'+id);assert.ok(view.messages.some(m=>m.author==='engineer'&&m.kind==='status'&&m.text.includes('本轮未完成')));return {after,status:view.messages.filter(m=>m.author==='engineer'&&m.text.includes('本轮未完成'))}})
 evidence.completed=true;evidence.failedCases=evidence.cases.filter(c=>c.result==='失败').length;save();if(evidence.failedCases)process.exitCode=1
}catch(e){evidence.error=String(e);save();console.error(String(e));process.exitCode=1}finally{await stop();console.log('Evidence:',evidenceFile)}
