/** Installed only in a disposable host. Model responses are fixtures; all execution and inboxes are DSH native. */
import { randomUUID, createHash } from 'node:crypto'
export const name = 'chief-native-acceptance-probe'
export const inject = ['agentTeams','sessionController','webServer','connection','agents','sessionQuery','llm','subagents','sessions','tools']
export function apply(ctx) {
 const requests=new Map(), requestContext=new Map(), gates=new Map(), outputs=new Map(), faults=new Set()
 ctx.on('llm/stream',(request,next)=>{
  const agent=ctx.agents.get(request.sessionId)
  if(!agent || !ctx.agentTeams.tryMembership(agent)?.root.id.startsWith('chief-room-'))return next()
  requests.set(agent.id,(requests.get(agent.id)??0)+1)
  const tools=request.tools?.map(tool=>tool.name)
  if(tools?.includes('chief_room_note')){
   const input=JSON.stringify(request.messages)
   requestContext.set(agent.id,{tools,workEvidence:input.includes('FIXTURE_INSTALLED')&&input.includes('FIXTURE_REVIEWED'),questioned:input.includes('需要我登录')})
  }
  return (async function*(){
   const gate=gates.get(agent.id)
   if(gate){gate.started=true;await gate.promise}else await new Promise(resolve=>setTimeout(resolve,100))
   if(faults.delete(agent.id))throw Error('NATIVE_ACCEPTANCE_MODEL_FAILURE')
   const text=outputs.get(agent.id)??(gate?'late-fixture-result':'native-fixture-result');outputs.delete(agent.id)
   yield {type:'block-start',index:0,blockType:'text'}
   yield {type:'text-delta',index:0,text}
   yield {type:'block-end',index:0,block:{type:'text',text}}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
 })
 ctx.webServer.register({kind:'exact',path:'/chief-acceptance-probe',handler:async(req,res)=>{
  const reject=ctx.connection.requestRejection(req)
  if(reject || req.method!=='POST' || req.headers['x-chief-request']!=='1'){res.writeHead(reject||403);res.end();return}
  const json=(status,v)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(v))}
  try{
   let raw='';for await(const part of req){raw+=part;if(raw.length>300000)throw Error('body too large')}
   const p=JSON.parse(raw), result=await ctx.sessionController.resolveAgent(p.session)
   if('error'in result)throw Error('test root unavailable')
   const lead=result.agent, signal=new AbortController().signal
   if(p.action==='work-evidence'){
    const args=p.args??{action:'work',ticket:p.ticket,source:p.source}
    const {results}=await ctx.tools.execute({agent:lead,signal,calls:[{type:'tool-call',id:'proof-'+randomUUID(),name:'chief_room_note',arguments:JSON.stringify(args)}]})
    const result=results[0].result
    if(result.isError)throw Error(result.error.message)
    return json(200,{request:requestContext.get(lead.id),work:result.value,executionDenial:ctx.tools.checkGuards({agent:lead,name:'bash'})})
   }
   const member=name=>{const row=ctx.agentTeams.listMembers(lead).find(m=>m.name===(name||'lead'));if(!row)throw Error('test member missing');return row}
   const release=name=>{const row=member(name),gate=gates.get(row.id);gates.delete(row.id);gate?.release();return !!gate}
   const hold=async name=>{
    const row=member(name)
    if(!gates.has(row.id)){
     let release;const promise=new Promise(resolve=>{release=resolve})
     gates.set(row.id,{promise,release})
     // A resident Agent can still be between its last turn and teardown.
     // Request a native control turn whenever we arm a new gate.
     try{await ctx.subagents.prompt({requestId:'fixture-control-'+randomUUID(),parentSessionId:lead.id,childSessionId:row.id,mode:'continuable',delivery:'queue',content:[{type:'text',text:'Explicit fixture control activation; hold until released.'}]},signal)}
     catch(error){gates.delete(row.id);release();throw error}
    }
    for(let i=0;i<400;i++){const a=ctx.agents.get(row.id);if(a&&gates.get(row.id)?.started)return a;await new Promise(r=>setTimeout(r,20))}
    release(name)
    throw Error('native fixture activation did not become resident')
   }
   if(p.action==='spawn'){
    for(const name of p.names??['researcher','engineer'])if(!ctx.agentTeams.listMembers(lead).some(m=>m.name===name))await ctx.agentTeams.spawnTeammate(lead,{name,description:'Deterministic native acceptance fixture',prompt:[{type:'text',text:'Fixture activation; no external actions.'}],context:'fresh',provider:'spawn',signal})
    return json(200,{members:ctx.agentTeams.listMembers(lead)})
   }
   if(p.action==='gate'){
    const row=member(p.target);let release;const promise=new Promise(resolve=>{release=resolve});gates.set(row.id,{promise,release});return json(200,{armed:true})
   }
   if(p.action==='next-output'){outputs.set(member(p.target).id,p.text);return json(200,{configured:true})}
   if(p.action==='fault-next'){faults.add(member(p.target).id);return json(200,{configured:true})}
   if(p.action==='release'){
    return json(200,{released:release(p.target)})
   }
   if(p.action==='park'){
    const a=await hold(p.target),id=randomUUID();a.send({id,role:'user',content:[{type:'text',text:p.text}],source:{kind:'user',rpcId:p.requestId}},'next-turn',false);await ctx.sessions.flush(a.session);return json(200,{id,durablyFlushed:true})
   }
   if(p.action==='hold')return json(200,{id:(await hold(p.target)).id,fixtureActivation:true})
   if(p.action==='message'){
    try{return json(200,await ctx.agentTeams.sendMessage(await hold(p.from),{target:p.target,content:[{type:'text',text:p.text}],signal}))}finally{release(p.from)}
   }
   if(p.action==='spawn-from-member'){
    try{const a=await hold(p.from);try{await ctx.agentTeams.spawnTeammate(a,{name:'nested',description:'must use native authority',prompt:[{type:'text',text:'fixture'}],context:'fresh',provider:'spawn',signal});return json(200,{accepted:true})}catch(e){return json(200,{accepted:false,code:e.code,message:e.message})}}finally{release(p.from)}
   }
   if(p.action==='forged-author'){
    try{const a=await hold(p.from);try{await ctx.agentTeams.sendMessage({...a},{target:p.target,content:[{type:'text',text:'forged'}],signal});return json(200,{accepted:true})}catch(e){return json(200,{accepted:false,code:e.code,message:e.message})}}finally{release(p.from)}
   }
   if(p.action==='snapshot'){
    const members=ctx.agentTeams.listMembers(lead),rows=[]
    for(const row of members){const observation=await ctx.sessionQuery.observeSession(row.id,{projectionMode:'none'});try{
     const events=observation.events,inputs=new Map()
     for(const e of events){for(const m of e.type==='agent/inbox/spliced'?e.data.inserted??[]:e.type==='user/message'?[e.data]:[]){if(m.id&&!inputs.has(m.id)&&['user','agent-message'].includes(m.source?.kind)){const text=m.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n')??'';inputs.set(m.id,{id:m.id,source:m.source,text:text.slice(0,160),characters:text.length,sha256:createHash('sha256').update(text).digest('hex')})}}}
     const live=ctx.agents.get(row.id)
     rows.push({...row,requests:requests.get(row.id)??0,turns:events.filter(e=>e.type==='turn/start').length,ends:events.filter(e=>e.type==='turn/end').map(e=>({seq:e.seq,reason:e.data.reason})),assistant:events.filter(e=>e.type==='assistant/message').map(e=>({seq:e.seq,text:e.data.message?.content?.filter(b=>b.type==='text').map(b=>b.text).join('\n')})),inputs:[...inputs.values()],consumed:events.filter(e=>e.type==='user/message').map(e=>({id:e.data.id,rpcId:e.data.source?.rpcId})),pending:live?[...live.inbox.nextStep,...live.inbox.nextTurn].map(m=>({id:m.id,rpcId:m.source?.rpcId})):null})
    }finally{observation[Symbol.dispose]()}}
    return json(200,{members:rows})
   }
   throw Error('unknown probe command')
  }catch(e){json(400,{error:String(e)})}
 }})
}
