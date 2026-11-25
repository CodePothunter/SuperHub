import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2Session, V2TurnInput } from '../src/core/workspace-v2.ts'
import type { ExperienceEntry, WorkspaceExperiencePort } from '../src/core/workspace-experience.ts'
import type { Agent, HostContext, NativeTeamMember, SessionEventLike, StepDecision } from '../src/dsh/ports.ts'
import { turnWords, createV2DialogueSource } from '../src/dsh/workspace-v2-dialogue.ts'
import { dialogueKey, groupSpeech, ownerMessageId } from '../src/dsh/workspace-v2-group.ts'
import { cliHost, type FakeOptions, type Spec } from './coding-cli-fake.ts'

const roots: string[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-v2-dialogue-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, {recursive: true, force: true}) })
const session: V2Session = {id:'new-session', workspaceId:'work-a', title:'交付修改', kind:'coding', executor:'codex', delegationIds:['d1'], closed:false, createdAt:'2026-11-20'}
const turn: V2TurnInput = { id:'one', text:'按刚确认的边界改上一版。\n保留原话。', context:{
  workspace:{id:'work-a', name:'发布', goal:'给出草案', owner:'用户', createdAt:'2026-11-20'},
  delegations:[{id:'d1', workspaceId:'work-a', sessionId:'new-session', title:'起草', owner:'接口人', promise:'给出文本', nextCheckAt:'2026-11-21', status:'active', boundary:'只能修订摘要', generation:2, remainingTurns:2, createdAt:'2026-11-20'}],
  decisions:[{id:'decision',workspaceId:'work-a',delegationId:'d1',text:'只保留两段',version:2,at:'2026-11-20'}]
}}
const signal = () => new AbortController().signal
type HostScript = (spec: Spec, prompt: string, say: (frame: object) => void) => Promise<number> | number
const codingHost = (perform: HostScript, fake?: FakeOptions) => cliHost((spec, prompt, io) => perform(spec, prompt, io.say), fake)
const codexSays = (id: string, text: string) => ({type:'item.completed',item:{type:'agent_message',id,text}})
const codexDone = {type:'turn.completed',usage:{input_tokens:12,output_tokens:8}}
const options = (ctx: HostContext, root: string) => ({ctx,root,scope:'brain-a',codex:{executable:process.execPath,model:'configured-model'},claudeExecutable:process.execPath})

function nativeHost(blocked = false, joining?: 'delayed' | 'broken' | 'foreign') {
  const members = new Map<string, {agent: Agent; name:string; log:SessionEventLike[]; inherited:number; parentSession?: string}>()
  const listeners = new Set<(event:{agent: Agent})=>void>()
  const sessionEvents = new Set<(session:{id:string},event:SessionEventLike)=>void>()
  type Guard = (call:{name:string;agent:Agent}) => string | undefined
  const guards = new Set<Guard>(), local = new Map<string,Guard>()
  const sections = new Map<string,()=>string>()
  let cwd = '', leadId = '', clock = Date.now(), calls = 0, narrow = '', denied: unknown, wrongDirectory = false
  let joiningPolls = 0, provisioning = false, memberReads = 0, steerMode: 'splice' | 'inbox' = 'splice'
  const inbox = {nextStep: [] as {id:string;source?:{kind?:string;rpcId?:string}}[], nextTurn: [] as {id:string}[],
    remove(id: string) { const at = inbox.nextStep.findIndex(item => item.id === id); if (at === -1) return false; inbox.nextStep.splice(at, 1); return true }}
  type PreStep = (payload:{agent:Agent},next:()=>Promise<StepDecision>)=>Promise<StepDecision>
  let step: PreStep | undefined, accepted:StepDecision | undefined
  const cancel = vi.fn()
  const add = (id:string,name:string,parentSession?:string) => {
    const log:SessionEventLike[] = []
    const agent:Agent = {id,cancel,...(!parentSession && {status:'running' as const, inbox: inbox as unknown as Agent['inbox']}),session:{snapshotEvents:()=>log, ...{header:{parentSession}}},ctx:{
      systemPrompt:{section: s=>{sections.set(id,s.text as ()=>string); return ()=>{} }},
      tools:{restrict:(({allow}:{allow:string[]})=>{
        if(allow.length) throw Error('unknown global tools')
        return ()=>{}
      }) as NonNullable<NonNullable<Agent['ctx']>['tools']>['restrict'],guard:fn=>{local.set(id,fn);return ()=>{}}}
    }}
    members.set(id,{agent,name,log,inherited:0,parentSession})
    for(const notify of listeners) notify({agent})
    return agent
  }
  const teams = {
    tryMembership: (a:Agent) => members.has(a.id) ? {root:joining === 'foreign' && a.id !== leadId ? {id:'other-team'} : members.get(leadId)?.agent,
      id:leadId,role:a.id===leadId?'lead':'teammate',name:members.get(a.id)!.name} : undefined,
    listMembers: () => {
      provisioning = (joining === 'delayed' || joining === 'foreign') && members.has('native-teammate') && joiningPolls++ === 0
      return Array.from(members.values()).filter(({agent,parentSession}) => agent.id === leadId || parentSession === leadId)
        .map(({agent,name}):NativeTeamMember=>({id:agent.id,name,role:agent.id===leadId?'lead':'teammate',
        status:agent.id !== leadId && provisioning ? 'provisioning' : 'inactive',diagnostics:[]}))
    }
  }
  const text = (value:string)=>({type:'text',text:value})
  const append = (id:string,type:string,data:unknown) => {
    const {log}=members.get(id)!
    clock = Math.max(Date.now(), clock + 1)
    const event = {seq:log.length+1,type,data,time:clock}
    log.push(event)
    for (const listener of sessionEvents) listener({id},event)
  }
  const ctx = {
    get:(name:string) => {
      if (name === 'agentTeams') return teams
      if (name === 'workingDirectory') return {get:()=>wrongDirectory?tmpdir():cwd}
      if (name === 'sessionQuery') return {observeSession:async(id:string)=>{
        if (id === 'native-teammate') {
          memberReads++
          if (provisioning || joining === 'broken') throw Error('native session is not readable')
        }
        const member = members.get(id)!
        return {events:member.log.slice(),header:{id},inheritedEventCount:member.inherited,[Symbol.dispose]:()=>{}}
      }}
    },
    agents:{get:(id:string)=>members.get(id)?.agent,list:()=>Array.from(members.values(),m=>m.agent)},
    tools:{guard:(fn:Guard)=>{guards.add(fn);return ()=>guards.delete(fn)}},
    on:(event:string,fn:(event:{agent:Agent})=>void)=>{
      if (event === 'agent/pre-step') { step = fn as unknown as PreStep; return ()=>{step=undefined} }
      if (event === 'session/event') {
        const listener = fn as unknown as (session:{id:string},event:SessionEventLike)=>void
        sessionEvents.add(listener)
        return ()=>sessionEvents.delete(listener)
      }
      listeners.add(fn)
      return ()=>listeners.delete(fn)
    },
    workspaceRegistry:{create:async(path:string)=>{cwd=path; return {id:'native-workspace'}}},
    sessionController:{
      resolveAgent:async(id:string)=>members.has(id)?{agent:members.get(id)!.agent}:{error:{code:'session/not-found'}},
      create:async({sessionId}:{sessionId:string})=>{leadId=sessionId;add(leadId,'lead');return {sessionId}},
      prompt:async(req:{requestId:string;sessionId:string;mode:'queue'|'steer';content:{type:'text';text:string}[]})=>{
        if (req.mode === 'steer') {
          const lead = members.get(leadId)!.agent
          const msg = {id:'native-'+req.requestId,source:{kind:'user',rpcId:req.requestId},content:req.content}
          if (steerMode === 'inbox') { inbox.nextStep.push(msg); return {accepted:true} }
          const decision = await step!({agent:lead},async()=>({kind:'enter',messages:[msg]}))
          const inserted = decision.kind === 'enter' ? decision.messages : []
          append(leadId,'agent/inbox/spliced',{inserted})
          if (inserted.length) append(leadId,'user/message',msg)
          return {accepted:true}
        }
        calls++
        const lead = members.get(leadId)!.agent
        narrow = sections.get(leadId)!()
        denied = Array.from(guards,g=>g({agent:lead,name:'chief_lookup'})).find(Boolean)
        const owner = {id:'native-'+req.requestId,source:{kind:'user',rpcId:req.requestId},content:req.content}
        accepted = await step!({agent:lead},async()=>({kind:'enter',messages:[
          owner,{source:{kind:'agent-instructions'},content:[text('private global instruction')]},
          {source:{kind:'user',rpcId:'different-rpc'},content:[text('unbound input')]},
          {source:{kind:'agent-message',senderSessionId:'unrelated'},content:[text('outside')]},
        ]}))
        append(leadId,'agent/inbox/spliced',{inserted:[owner]})
        append(leadId,'turn/start',{turn:1})
        append(leadId,'user/message',owner)
        if (blocked) return {accepted:true}
        const worker = add('native-teammate','researcher',leadId)
        sections.get(worker.id)?.()
        append(worker.id,'user/message',{id:'inherited',source:{kind:'agent-message',senderSessionId:leadId},content:[text('inherited private')]})
        members.get(worker.id)!.inherited=1
        const reply = {id:'native-relay',source:{kind:'agent-message',form:'relay',senderSessionId:worker.id},content:[text('Team message from researcher:'),text('我已核对原文。')]}
        append(leadId,'agent/inbox/spliced',{inserted:[reply]})
        append(leadId,'user/message',reply)
        append(leadId,'user/message',{id:'not-a-member',source:{kind:'agent-message',senderSessionId:'out-of-room'},content:[text('outsider')]})
        append(worker.id,'assistant/message',{message:{content:[text('private teammate draft')]}})
        append(leadId,'assistant/message',{message:{content:[{type:'thinking',text:'private reasoning'},{type:'tool_use',text:'private tool'}]}})
        const fence = String.fromCharCode(96).repeat(3)
        const report = '〔回复原话 "' +ownerMessageId(leadId,req.requestId)+ '"〕\n已收到。[附件说明]\n'+fence+'markdown title="讨论纪要.md"\n# 纪要\n'+fence
        append(leadId,'assistant/message',{message:{content:[text(report)]}})
        append(leadId,'turn/end',{turn:1,reason:{kind:'completed'}})
        return {accepted:true}
      }
    }
  } as unknown as HostContext
  return {ctx,cancel,local,guards,members,inbox,append:(type:string,data:unknown)=>append(leadId,type,data),steerInto(mode:'splice'|'inbox'){steerMode=mode},
    get facts(){return {cwd,leadId,calls,narrow,denied,accepted,joiningPolls,memberReads}},wrongDirectory(){wrongDirectory=true}}
}

describe('workspace-bound native dialogue sources', () => {
  it('legacy workgroup rotates the native discussion while preserving the canonical owner-message identities', async () => {
    const root = temp(), host = nativeHost()
    const group: V2Session = {...session,kind:'group',executor:'dsh'}
    let active: ExperienceEntry[] = [{id:'notes',version:1,text:'先做旧版笔记'}]
    const recordExperienceDelivery = vi.fn()
    const experience: WorkspaceExperiencePort = {
      selectExperience:query=>({query,scope:'brain-a',authority:'v1',entries:active,authorized:active}),
      assertExperienceCurrent:()=>{},
      recordExperienceDelivery,
    }
    const source = createV2DialogueSource({...options(host.ctx,root),experience})
    await source.send(group,turn,signal())
    const first = host.facts
    expect(first.narrow).toContain(active[0]!.text)
    expect(recordExperienceDelivery).toHaveBeenCalledTimes(2)
    active = [{id:'notes',version:2,text:'采用新版笔记'}]
    const next = {...turn,id:'two',text:'这次仍要整理纪要'}
    await source.send(group,next,signal())
    expect(host.facts.leadId).not.toBe(first.leadId)
    expect(host.facts.narrow).toContain(active[0]!.text)
    expect(host.facts.narrow).not.toContain('旧版笔记')
    const messages = (await source.read(group)).messages.filter(m=>m.role==='user')
    expect(messages.map(m=>[m.id,m.text])).toEqual([
      [ownerMessageId(first.leadId,turn.id),turn.text],
      [ownerMessageId(first.leadId,next.id),next.text],
    ])
    source.dispose()
  })

  it('publishes only explicit coding speech and immutable scoped files, retaining both sides and narrowed context across restart', async () => {
    const root = temp(), outside = join(root,'other.md')
    writeFileSync(outside, 'other-workspace')
    const output = '初稿已写好。[初稿](draft.md) [隐藏](.hidden.md) [路径](../other.md) [软链](linked.md) [硬链](hard.md) [网页](https://example.test/test.md)'
    const host = codingHost((spec, _prompt, say) => {
      if (host.calls.length === 1) {
        writeFileSync(join(spec.cwd,'draft.md'), '# 初稿\n')
        writeFileSync(join(spec.cwd,'.hidden.md'), 'hidden')
        writeFileSync(join(spec.cwd,'unmentioned.md'), 'not linked')
        symlinkSync(outside,join(spec.cwd,'linked.md'))
        linkSync(outside,join(spec.cwd,'hard.md'))
        say({type:'item.completed',item:{type:'reasoning',id:'hidden',text:'PRIVATE'}})
        say({type:'item.completed',item:{type:'command_execution',id:'tool',aggregated_output:'SECRET'}})
        say(codexSays('progress','我先核对摘要。'))
        say(codexSays('result',output))
      } else say(codexSays('result','已经改好。'))
      say(codexDone)
      return 0
    // The continuation is unavailable, so the next turn starts a new thread with the public history.
    }, {refuseResume: () => 'no rollout found'})
    const source = createV2DialogueSource(options(host.ctx,root))
    await source.send(session,turn,signal())
    const first = await source.read(session)
    expect(first.messages.map(m => [m.author,m.text])).toEqual([['你',turn.text],['Codex','我先核对摘要。'],['Codex',output]])
    expect(host.calls[0]!.thread).toMatchObject({model:'configured-model', sandbox:'danger-full-access', approvalPolicy:'never'})
    expect(host.calls[0]!.spec.argv).not.toContain('--ignore-user-config')
    expect(host.calls[0]!.prompt).toContain('只能修订摘要')
    expect(host.calls[0]!.prompt).toContain('只保留两段')
    const refs = first.messages.at(-1)!.attachments!
    expect(refs.map(r=>r.label)).toEqual(['初稿'])
    const nativeReceipt = source.savedResults!(session,turn.id)!
    expect(nativeReceipt.messages.map(row => row.text)).toEqual(['我先核对摘要。',output])
    expect(nativeReceipt.attachments.map(file => file.label)).toEqual(['初稿'])
    const area = dialogueKey('brain-a',session.workspaceId)
    const savedPath = join(root,'ops','superhub-v2-dialogues',area,dialogueKey(area,session.id),'source.json')
    const archived = JSON.parse(readFileSync(savedPath,'utf8'))
    for (const oldTurn of archived.turns) delete oldTurn.replyIds
    writeFileSync(savedPath,JSON.stringify(archived))
    expect(source.savedResults!(session,turn.id)).toEqual(nativeReceipt)
    for (const oldTurn of archived.turns) delete oldTurn.workOrderId
    writeFileSync(savedPath,JSON.stringify(archived))
    expect(source.savedResults!(session,turn.id)).toEqual(nativeReceipt)
    expect(source.savedResults!({...session,workspaceId:'work-b'},turn.id)).toBeUndefined()
    const id = refs[0]!.id
    writeFileSync(join(host.calls[0]!.spec.cwd,'draft.md'), 'replaced later')
    source.dispose()
    const next = createV2DialogueSource(options(host.ctx,root))
    expect(await next.read(session)).toEqual(first)
    expect(await next.confirmed!(session,turn.id)).toBe(true)
    expect(await next.confirmed!({...session,workspaceId:'work-b'},turn.id)).toBe(false)
    expect(await next.attachment(session,id)).toMatchObject({id,format:'markdown',content:'# 初稿\n'})
    expect(await next.attachment({...session,workspaceId:'work-b'},id)).toBeUndefined()
    const elsewhere = createV2DialogueSource({...options(host.ctx,root),scope:'brain-b'})
    expect((await elsewhere.read(session)).messages).toEqual([])
    expect(await elsewhere.attachment(session,id)).toBeUndefined()
    await next.send(session,turn,signal())
    expect(host.calls).toHaveLength(1)
    await expect(next.send(session,{...turn,text:'换一种内容'},signal())).rejects.toThrow('标识')
    await next.send(session,{id:'two',text:'上面第一段怎么改？'},signal())
    expect(host.calls.at(-1)!.prompt).toContain('我先核对摘要。')
    expect(host.calls.at(-1)!.prompt).toContain('保留原话。')
    expect(host.calls.at(-1)!.spec.cwd).toEqual(host.calls[0]!.spec.cwd)
    next.dispose()
    elsewhere.dispose()
  })

  it.each([false,true])('opens previous coding files and messages only for their recorded historical owner (initially bound: %s)', async bound => {
    const root = temp(), initial: V2Session = {...session, delegationIds:bound ? ['d1'] : []}
    const host = codingHost((_spec, _prompt, say) => {
      say(codexSays('result', '已处理。'))
      say(codexDone)
      return 0
    })
    const first = createV2DialogueSource(options(host.ctx,root))
    await first.send(initial,{id:'old',text:'上一版专用背景'},signal())
    first.dispose()
    const originalDir = host.calls[0]!.spec.cwd
    writeFileSync(join(originalDir,'original.md'),'上一版专用文件')
    const area = dialogueKey('brain-a',initial.workspaceId)
    const journal = join(root,'ops','superhub-v2-dialogues',area,dialogueKey(area,initial.id),'source.json')
    const old = JSON.parse(readFileSync(journal,'utf8'))
    delete old.workRootOrder
    // A journal from before native sessions were recorded.
    delete old.native
    for (const turn of old.turns) delete turn.workOrderId
    for (const message of old.messages) { delete message.workOrderId; message.at = '2020-01-01T00:00:00Z' }
    writeFileSync(journal,JSON.stringify(old))

    const room: V2Session = bound
      ? {...initial,delegationIds:['d1','d2'],legacyMessageOrder:{id:'d1',through:'2020-02-01T00:00:00Z'}}
      : {...initial,delegationIds:['d2']}
    const next = createV2DialogueSource(options(host.ctx,root))
    await next.send(room,{id:'second',text:'开始新单',workOrderId:'d2'},signal())
    expect(host.calls[1]!.prompt).not.toContain('上一版专用背景')
    expect(existsSync(join(host.calls[1]!.spec.cwd,'original.md'))).toBe(false)
    if (bound) {
      await next.send(room,{id:'third',text:'接着做',workOrderId:'d1'},signal())
      expect(host.calls[2]!.prompt).toContain('上一版专用背景')
      expect(host.calls[2]!.spec.cwd).toBe(originalDir)
    }
    next.dispose()
  })

  it('uses Claude Code exclusively, keeps separate public blocks sharing an API message id, and skips SDK internals', async () => {
    const root = temp()
    const host = codingHost((_spec,_prompt,say) => {
      say({type:'system',subtype:'init',tools:['hidden tool']})
      say({type:'assistant',uuid:'block-1',parent_tool_use_id:null,message:{id:'shared',content:[{type:'thinking',thinking:'secret'},{type:'text',text:'我看到两处改动。'}]}})
      say({type:'assistant',uuid:'child',parent_tool_use_id:'hidden-tool',message:{id:'child',content:[{type:'text',text:'private child'}]}})
      say({type:'user',message:{content:[{type:'tool_result',content:'secret'}]}})
      say({type:'assistant',uuid:'block-2',message:{id:'shared',content:[{type:'text',text:'已处理。'}]}})
      say({type:'result',subtype:'success',result:'已处理。',is_error:false})
      return 0
    })
    const source = createV2DialogueSource(options(host.ctx,root))
    const claude = {...session, executor:'claude-code' as const}
    await source.send(claude,turn,signal())
    expect(host.calls[0]!.spec.argv).toContain('bypassPermissions')
    expect(host.calls[0]!.spec.argv).not.toContain('--restricted')
    expect(host.calls[0]!.spec.argv).not.toContain('--strict-mcp-config')
    expect(host.calls[0]!.spec.argv).not.toContain('configured-model')
    expect((await source.read(claude)).messages.map(m=>[m.author,m.text])).toEqual([['你',turn.text],['Claude Code','我看到两处改动。'],['Claude Code','已处理。']])
    source.dispose()
  })

  it('records ordinary deliverables against the selected order in one conversation, each order in its own working copy', async () => {
    const root = temp(), first = turn.context!.delegations[0]!
    const second = {...first, id:'d2', title:'活动页面', promise:'交付页面'}
    const room = {...session, delegationIds:[first.id, second.id]}
    const page = '<form action="/registrations" method="post"><input name="name"><button>提交</button></form>'
    const host = codingHost((spec,prompt,say) => {
      // No SuperHub preview guide or capability server any more: the tool just works in its directory.
      expect(existsSync(join(spec.cwd,'.superhub'))).toBe(false)
      expect(prompt).not.toMatch(/preview_capabilities|试填/)
      expect(spec.argv.join(' ')).not.toContain('mcp_servers.superhub')
      let answer = '收到。'
      switch (host.calls.length) {
        case 1:
          writeFileSync(join(spec.cwd,'notes.md'), '第一项工单专有文稿')
          answer = '内容如下。[文稿](notes.md)'
          break
        case 2:
          expect(existsSync(join(spec.cwd,'notes.md'))).toBe(false)
          expect(prompt).not.toContain('第一项工单专有')
          writeFileSync(join(spec.cwd,'index.html'), page)
          answer = '[活动页](index.html)'
      }
      say(codexSays('response',answer)); say(codexDone); return 0
    })
    const source = createV2DialogueSource(options(host.ctx,root))
    const send = (id:string, workOrderId:string, text:string) => source.send(room,{id, workOrderId, text,
      context:{...turn.context!,delegations:[first,second]}},signal())
    await send('one',first.id,'第一项工单专有要求，整理文稿。')
    await send('two',second.id,'交付活动页面。')
    expect(existsSync(join(root,'ops','superhub-v2-candidates'))).toBe(false)
    const publicRows = (await source.read(room)).messages.filter(m => m.role === 'agent')
    expect(publicRows.map(row => row.workOrderId)).toEqual([first.id,second.id])
    expect(publicRows[0]!.attachments?.map(a => a.label)).toEqual(['文稿'])
    expect(publicRows[1]!.attachments?.map(a => a.label)).toEqual(['活动页'])
    expect((await source.attachment(room,publicRows[0]!.attachments![0]!.id))?.content).toContain('第一项工单专有文稿')
    // A page with a form is an ordinary HTML attachment.
    expect((await source.attachment(room,publicRows[1]!.attachments![0]!.id))).toMatchObject({format:'html',content:page})
    source.dispose()
  })

  it('recognizes a native Claude authentication refusal and retries the same owner words once after credentials are available', async () => {
    const root = temp()
    const host = codingHost((_spec,_prompt,say) => {
      if (host.calls.length === 1) {
        say({type:'assistant',error:'authentication_failed',isApiErrorMessage:true,message:{content:[]}})
        say({type:'result',subtype:'success',is_error:true,result:'provider diagnostic'})
        return 1
      }
      say({type:'result',subtype:'success',is_error:false,result:'已接着处理。'})
      return 0
    })
    const claude = {...session,executor:'claude-code' as const}
    const source = createV2DialogueSource(options(host.ctx,root))
    await expect(source.send(claude,turn,signal())).rejects.toMatchObject({dispatched:false,message:expect.stringContaining('账号认证')})
    expect((await source.read(claude)).issue).toContain('账号认证')
    source.dispose()
    const resumed = createV2DialogueSource(options(host.ctx,root))
    await resumed.send(claude,turn,signal())
    expect((await resumed.read(claude)).messages.map(row => row.text)).toEqual([turn.text,'已接着处理。'])
    expect(await resumed.confirmed!(claude,turn.id)).toBe(true)
    resumed.dispose()
  })

  it('retains partial speech without replay after an uncertain exit and labels a silent terminal accurately', async () => {
    const root = temp()
    const host = codingHost((_spec,_prompt,say) => {
      if (host.calls.length === 1) { say(codexSays('first','我已收到。')); return 1 }
      say(codexDone)
      return 0
    })
    const source = createV2DialogueSource(options(host.ctx,root))
    await expect(source.send(session,turn,signal())).rejects.toThrow('未确认')
    expect((await source.read(session)).messages.map(m=>m.text)).toEqual([turn.text,'我已收到。'])
    source.dispose()
    const next = createV2DialogueSource(options(host.ctx,root))
    await expect(next.send(session,turn,signal())).rejects.toThrow('派发结果')
    expect(host.calls.length).toBe(1)
    const other = {...session, id:'another-session'}
    await next.send(other,turn,signal())
    expect((await next.read(other)).issue).toContain('没有返回可展示')
    const absent = createV2DialogueSource({...options(host.ctx,root),codex:{executable: join(root,'not-installed')}})
    await expect(absent.send({...session,id:'unavailable'},turn,signal())).rejects.toMatchObject({dispatched:false})
    expect((await absent.read({...session,id:'unavailable'})).messages).toHaveLength(0)
    absent.dispose()
    next.dispose()
  })

  it('coalesces the same live request and a late disposed provider cannot replace a new runtime transcript', async () => {
    const root = temp()
    let release!: () => void
    const wait = new Promise<void>(ok => { release = ok })
    const host = codingHost(async (_spec,prompt,say) => {
      if (prompt.endsWith(turn.text)) await wait
      else say(codexSays('new','新的答复。'))
      say(codexDone)
      return 0
    })
    const original = createV2DialogueSource(options(host.ctx,root))
    const sent = original.send(session,turn,signal()), duplicate = original.send(session,turn,signal())
    await vi.waitFor(()=>expect(host.calls).toHaveLength(1))
    original.dispose()
    const restored = createV2DialogueSource(options(host.ctx,root))
    await restored.send(session,{id:'second',text:'新一轮'},signal())
    const rejection = Promise.allSettled([sent,duplicate])
    release()
    expect((await rejection).every(p=>p.status==='rejected')).toBe(true)
    expect((await restored.read(session)).messages.map(m=>m.text)).toEqual([turn.text,'新一轮','新的答复。'])
    expect(host.calls).toHaveLength(2)
    restored.dispose()
  })

  it('opens an isolated native group and retains only real owner, enrolled relay and public lead speech, replies and authored documents', async () => {
    const root = temp(), host = nativeHost()
    const source = createV2DialogueSource(options(host.ctx,root))
    const group:V2Session = {...session,kind:'group',executor:'dsh'}
    await source.send(group,turn,signal())
    const {messages,issue} = await source.read(group)
    expect(issue).toBeUndefined()
    expect(host.facts.leadId).toMatch(/^chief-v2-group-/)
    expect(host.facts.cwd.startsWith(join(root,'work','superhub-v2'))).toBe(true)
    expect(host.facts.narrow).toContain('只能修订摘要')
    expect(host.facts.narrow).toContain('只保留两段')
    expect(host.facts.denied).toBeTruthy()
    expect(host.facts.accepted).toMatchObject({kind:'enter',messages:[{source:{kind:'user',rpcId:turn.id}}]})
    expect(messages.map(m=>m.author)).toEqual(['你','researcher','讨论接口人'])
    expect(messages.map(m=>m.workOrderId)).toEqual(['d1',undefined,'d1'])
    expect(messages[0]!.text).toBe(turn.text)
    expect(messages[1]!.text).toBe('我已核对原文。')
    expect(messages[2]!.replyTo).toBe(messages[0]!.id)
    expect(messages[2]!.text).toMatch(/^已收到/)
    const ref = messages[2]!.attachments![0]!
    expect(await source.attachment(group,ref.id)).toMatchObject({label:'讨论纪要.md',format:'markdown',content:'# 纪要\n'})
    expect(await source.attachment({...group,workspaceId:'different'},ref.id)).toBeUndefined()
    source.dispose()
    const agent = host.members.get(host.facts.leadId)!.agent
    expect(host.local.get(agent.id)!({agent,name:'spawn_teammate'})).toBeTruthy()
    const revived = createV2DialogueSource(options(host.ctx,root))
    expect((await revived.read(group)).messages).toEqual(messages)
    host.wrongDirectory()
    await expect(revived.send(group,{id:'wrong-dir',text:'test'},signal())).rejects.toMatchObject({dispatched:false})
    expect(host.facts.calls).toBe(1)
    revived.dispose()
  })

  it('hands a group order over as the liaison, with the owner\'s original quoted, and the lead admits exactly that input', async () => {
    const root = temp(), host = nativeHost()
    const source = createV2DialogueSource(options(host.ctx,root))
    const group:V2Session = {...session,kind:'group',executor:'dsh'}
    const handed = {...turn, id:'start-handed', liaison:{handoff:'请按新边界修订上一版，保留原话。'}}
    await source.send(group,handed,signal())
    expect(host.facts.accepted).toMatchObject({kind:'enter',messages:[{source:{kind:'user',rpcId:handed.id},content:[{type:'text',text:turnWords(handed)}]}]})
    const {messages} = await source.read(group)
    expect(messages.map(m=>m.author)).toEqual(['接口人','researcher','讨论接口人'])
    expect(messages[0]).toMatchObject({role:'agent',text:'请按新边界修订上一版，保留原话。',quote:{label:'主人原话',text:turn.text},workOrderId:'d1'})
    expect(messages[0]).not.toHaveProperty('relayed')
    // The lead's reply still points at the hand-over it answers.
    expect(messages[2]!.replyTo).toBe(messages[0]!.id)
    source.dispose()
  })

  it('rebuilds order provenance from claimed group RPCs after restart without assigning queued or late speech to the current order', () => {
    const lead = 'lead', orders = new Map([['first','work-a'],['second','work-b']])
    const events: SessionEventLike[] = []
    const event = (type:string,data:unknown) => events.push({seq:events.length+1,type,time:1000+events.length,data})
    const say = (text:string) => event('assistant/message',{message:{content:[{type:'text',text}]}})
    const owner = (rpcId:string) => ({source:{kind:'user',rpcId},content:[{type:'text',text:rpcId}]})
    const relay = (text:string) => event('user/message',{source:{kind:'agent-message',senderSessionId:'research'},content:[{type:'text',text}]})
    event('turn/start',{turn:1})
    event('user/message',owner('first'))
    event('agent/inbox/spliced',{inserted:[owner('second')]})
    say('初稿 A')
    event('turn/end',{turn:1})
    relay('组员的迟到发言')
    event('turn/start',{turn:2})
    event('user/message',owner('second'))
    relay('〔回复原话 "'+ownerMessageId(lead,'first')+'"〕\n第一单的补充')
    say('初稿 B')
    event('turn/end',{turn:2})
    const sources = [{id:lead,name:lead,events},{id:'research',name:'研究员',events:[]}]
    const rows = groupSpeech(lead,sources,orders)
    expect(rows.filter(row => row.role==='agent').map(row => [row.text,row.workOrderId])).toEqual([
      ['初稿 A','work-a'],['组员的迟到发言',undefined],['第一单的补充','work-a'],['初稿 B','work-b']])
    expect(groupSpeech(lead,sources,new Map()).every(row => row.workOrderId === undefined)).toBe(true)
  })

  it('waits for a provisioning teammate before observing its session, then recovers its public reply', async () => {
    const host = nativeHost(false,'delayed'), group:V2Session = {...session,kind:'group',executor:'dsh'}
    const source = createV2DialogueSource(options(host.ctx,temp()))
    await source.send(group,turn,signal())
    expect(host.facts.joiningPolls).toBeGreaterThanOrEqual(2)
    expect(host.facts.memberReads).toBe(1)
    expect(host.cancel).not.toHaveBeenCalled()
    expect((await source.read(group)).messages.map(row => row.author)).toEqual(['你','researcher','讨论接口人'])
    source.dispose()
  })

  it.each(['broken','foreign'] as const)('retains genuine native member read and membership failures (%s)', async joining => {
    const host = nativeHost(false,joining), group:V2Session = {...session,kind:'group',executor:'dsh'}
    const source = createV2DialogueSource(options(host.ctx,temp()))
    await expect(source.send(group,turn,signal())).rejects.toThrow('未确认')
    expect(host.cancel).toHaveBeenCalled()
    if (joining === 'foreign') expect(host.cancel).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('does not treat DSH enqueue as completion and prevents new group operations after an owner stop', async () => {
    const root = temp(), host = nativeHost(true)
    const group:V2Session = {...session,kind:'group',executor:'dsh'}
    const source = createV2DialogueSource(options(host.ctx,root)), control = new AbortController()
    const result = source.send(group,turn,control.signal)
    await vi.waitFor(()=>expect(host.facts.calls).toBe(1))
    expect((await source.read(group)).issue).toContain('等候')
    control.abort()
    await expect(result).rejects.toThrow('未确认')
    expect(host.cancel).toHaveBeenCalledTimes(1)
    await expect(source.send(group,turn,signal())).rejects.toThrow('派发结果')
    expect(host.facts.calls).toBe(1)
    expect((await source.read(group)).messages.map(m=>m.text)).toEqual([turn.text])
    source.dispose()
  })

  it('recovers a known group request only after its own claimed turn has a native completed receipt', async () => {
    const root = temp(), host = nativeHost(true)
    const group:V2Session = {...session,kind:'group',executor:'dsh'}
    const source = createV2DialogueSource(options(host.ctx,root))
    const control = new AbortController()
    const sent = source.send(group,turn,control.signal)
    await vi.waitFor(()=>expect(host.facts.calls).toBe(1))
    const outcome = Promise.allSettled([sent])
    source.dispose()
    await outcome
    const revived = createV2DialogueSource(options(host.ctx,root))
    const member = host.members.get(host.facts.leadId)!
    expect(await revived.confirmed!(group,turn.id)).toBe(false)
    member.log.push({seq:4,type:'turn/end',time:Date.now(),data:{turn:2,reason:{kind:'completed'}}})
    expect(await revived.confirmed!(group,turn.id)).toBe(false)
    member.log[3] = {seq:4,type:'turn/end',time:Date.now(),data:{turn:1,reason:{kind:'completed'}}}
    expect(await revived.confirmed!(group,turn.id)).toBe(true)
    expect(await revived.confirmed!(group,'never-posted')).toBe(false)
    await revived.send(group,turn,signal())
    expect(host.facts.calls).toBe(1)
    revived.dispose()
  })

  it.each(['splice','inbox'] as const)('steers owner words into the running group turn and settles them against the lead\'s own events (%s)', async mode => {
    const root = temp(), host = nativeHost(true)
    host.steerInto(mode)
    const group:V2Session = {...session,kind:'group',executor:'dsh'}
    const source = createV2DialogueSource(options(host.ctx,root))
    const sent = source.send(group,turn,signal())
    await vi.waitFor(()=>expect(host.facts.calls).toBe(1))
    expect(await source.interject!(group,turn.id,{id:'w1',text:'改用表格输出',workOrderId:'d1'})).toBe('pending')
    if (mode === 'splice') expect(host.inbox.nextStep).toHaveLength(0)
    else expect(host.inbox.nextStep).toHaveLength(1)
    host.append('assistant/message',{message:{content:[{type:'text',text:'好的，改成表格。'}]}})
    if (mode === 'splice') {
      // Already while the turn runs, the lead's answer after the steered words is filed under the order.
      const area = dialogueKey('brain-a',group.workspaceId)
      const journal = join(root,'ops','superhub-v2-dialogues',area,dialogueKey(area,group.id),'source.json')
      await vi.waitFor(() => expect(JSON.parse(readFileSync(journal,'utf8')).messages
        .find((m:{text:string}) => m.text === '好的，改成表格。')).toMatchObject({workOrderId:'d1'}))
    }
    host.append('turn/end',{turn:1,reason:{kind:'completed'}})
    await sent
    expect(source.interjections!(group,turn.id)).toEqual([{id:'w1',delivered:mode === 'splice'}])
    // Untaken words leave the inbox so they cannot be filtered out or open a native turn later.
    expect(host.inbox.nextStep).toHaveLength(0)
    const rows = (await source.read(group)).messages
    // Taken words carry the native time; untaken words keep the time they were said (the fixture clock differs).
    expect(rows.map(m=>[m.author,m.text])).toHaveLength(3)
    expect(rows.map(m=>[m.author,m.text])).toEqual(expect.arrayContaining([['你',turn.text],['你','改用表格输出'],['讨论接口人','好的，改成表格。']]))
    // Steered words belong to the same order as the turn they joined, and so does the lead's answer after them.
    expect(rows.map(m=>m.workOrderId)).toEqual(['d1','d1','d1'])
    // Until the host queues untaken words, a reader cannot tell more than that their delivery is open.
    expect(rows.find(m=>m.text==='改用表格输出')!.delivery).toBe(mode === 'splice' ? 'steered' : 'unknown')
    source.dispose()
  })

  it('does not steer a group whose lead is idle, and does not admit forged or altered words', async () => {
    const root = temp(), host = nativeHost(true)
    const group:V2Session = {...session,kind:'group',executor:'dsh'}
    const source = createV2DialogueSource(options(host.ctx,root))
    const sent = source.send(group,turn,signal())
    await vi.waitFor(()=>expect(host.facts.calls).toBe(1))
    const lead = host.members.get(host.facts.leadId)!.agent as {status?: string}
    lead.status = 'idle'
    expect(await source.interject!(group,turn.id,{id:'w1',text:'改用表格输出',workOrderId:'d1'})).toBe('rejected')
    lead.status = 'running'
    expect(await source.interject!(group,turn.id,{id:'w2',text:'改用表格输出',workOrderId:'d2'})).toBe('rejected')
    host.append('turn/end',{turn:1,reason:{kind:'completed'}})
    await sent
    expect(source.interjections!(group,turn.id)).toEqual([{id:'w1',delivered:false}])
    source.dispose()
  })
})
