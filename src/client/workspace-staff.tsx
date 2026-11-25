import { useState, type FormEvent } from 'react'
import type { StaffMember, StaffView } from '../core/workspace-staff.ts'
import type { ExperienceEvidence, ExperienceMemory } from '../core/workspace-experience.ts'
import { workspaceArchived, type V2Workspace, type V2WorkspaceView } from '../core/workspace-v2.ts'
import { ARCHIVED_NOTE, Issue, readableTime, useArchived, V2Dialog, V2Icon } from './workspace-v2-elements.tsx'
import { useV2Read, useV2Write } from './workspace-v2-api.ts'
import { defaultStaffPortrait } from '../core/workspace-avatars.ts'
import { ChatAvatar } from './workspace-chat-avatar.tsx'
import { StaffPortraitPicker } from './workspace-staff-portrait.tsx'
import { isExperienceVersion, isSharedExperienceVersion, isStaffImpact, isStaffRecipients, isStaffView, staffPath } from './workspace-staff-response.ts'

interface Props {
  workspace?: V2WorkspaceView
  spaces: V2Workspace[]
  selected?: string
  experience?: boolean
  select:(id?:string)=>void
  openMembership:(workspace:string,staffId:string)=>void
  openOrder:(workspace:string,order:string)=>void
  openEvidence?:(source:ExperienceEvidence)=>void
  openGlobal?:(id?:string)=>void
  assign?:(member:StaffMember)=>void
}
type Action = 'create' | 'invite' | 'join' | 'duty' | 'edit' | 'leave' | 'learn' | 'revise' | 'share' | 'reset'
type Operation = {action:Action; memory?:ExperienceMemory; shared?:boolean}
type Save = (body:Record<string,unknown>,message:string,path?:string)=>Promise<boolean>

function formData(event:FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget) }
const field = (data:FormData,key:string) => String(data.get(key) ?? '').trim()

export function StaffBoard(props:Props) {
  const {workspace,spaces,selected,experience,select,openMembership,openOrder,openGlobal,openEvidence,assign} = props
  const workspaceId = workspace?.workspace.id
  const path = staffPath(workspaceId,experience)
  const query = useV2Read(path,isStaffView,10000)
  const write = useV2Write(isStaffView,false)
  const [operation,setOperation] = useState<Operation | 'portrait'>()
  const [message,setMessage] = useState('')
  const [showError,setShowError] = useState(false)
  // In an archived workspace the panel only reads: no invite, create, duty, experience, share, portrait or reset.
  const readOnly = useArchived() && !!workspace
  // Joining or sharing goes only to workspaces that take changes.
  const activeSpaces = spaces.filter(space => !workspaceArchived(space))
  // A revoked or reset entry must not reappear from the previous observation after a failed refresh.
  const view = query.error ? undefined : query.data
  const member = view?.members.find(m=>m.id === selected)
  const memberships = member?.memberships ?? []
  const belongsOnCard = (memory: {staffId?:string;workspaceId?:string}) => memory.staffId === selected && (!workspaceId || memory.workspaceId === workspaceId)
  const memories: ExperienceMemory[] = [
    ...(view?.memories.filter(belongsOnCard).map(m=>({...m,audience:'staff' as const})) ?? []),
    ...(view?.retiredMemories?.filter(belongsOnCard) ?? []),
  ]
  const received = view?.received.filter(s=>s.staffId === selected) ?? []
  const label = (id:string) => spaces.find(w=>w.id === id)?.name ?? '工作区'
  const open = (action:Action,memory?:ExperienceMemory,shared=false) => { setShowError(false); setMessage(''); setOperation({action,memory,shared}) }
  const save:Save = async (body,success,destination=path) => {
    setShowError(true)
    const result = await write.post<StaffView & {organized?: {changes:number; pending:number; failed:number}}>(destination,body)
    if (!result) return false
    await query.refresh()
    const organized = result.organized
    setOperation(undefined)
    setMessage(organized?.failed ? `已整理 ${organized.changes} 项，${organized.pending} 项待重试。`
      : organized ? organized.changes ? `已整理 ${organized.changes} 项经验。` : '本次整理没有需要更新的经验。' : success)
    if (body.action === 'leave' && workspaceId) select()
    return true
  }
  function choose(id?:string) { setOperation(undefined); setMessage(''); setShowError(false); select(id) }
  const scopeTitle = experience ? '工作区经验' : workspace ? '工作区幕僚' : '我的幕僚'
  const showMemory = (memory: ExperienceMemory) => {
    const editable = workspaceId === memory.workspaceId && !readOnly
    const shared = memory.audience === 'shared'
    const identity = shared ? {audience:'shared'} : {staffId:memory.staffId}
    const command = (action: string, text: string, extra?: Record<string,unknown>) =>
      void save({action,...identity,memoryId:memory.id,version:memory.version,...extra},text)
    const state = memory.status === 'proposed' ? '待采纳' : memory.status === 'retired' ? '已停用' : '已采纳'
    const shares = view?.shares.filter(s=>s.memoryId === memory.id) ?? []
    return <article key={memory.id} className="v2-card v2-staff-memory">
      <small>{state} · {memory.workspaceId ? label(memory.workspaceId) : '全局'} · {readableTime(memory.at)}</small>
      <p>{memory.text}</p>
      <ExperienceDetails memory={memory} openEvidence={openEvidence}/>
      <div className="v2-actions">{memory.orderId && memory.workspaceId && <button className="v2-link" onClick={()=>openOrder(memory.workspaceId!,memory.orderId!)}>查看来源工单</button>}
        {memory.lastUsed && <button className="v2-link" onClick={()=>openOrder(memory.lastUsed!.workspaceId,memory.lastUsed!.orderId)}>最近提供给工单 · {readableTime(memory.lastUsed.at)}</button>}</div>
      {editable && memory.status !== 'retired' && <div className="v2-actions">
        {memory.status === 'proposed' && <button className="v2-button" disabled={write.busy} onClick={()=>command('accept','已采纳经验。')}>采纳</button>}
        {workspaceId && memory.status === 'active' && <button className="v2-link" onClick={()=>open('share',memory,shared)}>共享经验</button>}
        <button className="v2-link" onClick={()=>open('revise',memory,shared)}>更正</button>
        <button className="v2-link" disabled={write.busy} onClick={()=>command('retire','这条经验已停用。')}>停用</button>
      </div>}
      {!shared && !editable && memory.workspaceId && memory.workspaceId !== workspaceId && memory.staffId &&
        <button className="v2-link" onClick={()=>openMembership(memory.workspaceId!,memory.staffId!)}>到来源工作区管理</button>}
      {!!memory.previousVersions?.length && <ExperienceVersions memory={memory} editable={editable && !write.busy}
        openEvidence={openEvidence} sharedOnly={experience} restore={version=>command('restore','已恢复所选经验版本。',{restoreVersion:version})}/>}
      {shares.map(s=><div className="v2-staff-share" key={s.id}>
        <strong>已共享给{label(s.targetWorkspaceId)}{s.targetStaffName ? ' · '+s.targetStaffName : s.targetAudience === 'shared' ? ' · 本区成员' : ''}</strong><p>{s.text}</p>
        {s.purpose && <small>用途 · {s.purpose}</small>}{s.expiresAt && <small>有效期至 {readableTime(s.expiresAt)}</small>}
        {editable && <button className="v2-link" disabled={write.busy} onClick={()=>command('revoke','已撤回共享。',{shareId:s.id})}>撤回共享</button>}
      </div>)}
    </article>
  }
  const showShared = (shared: ExperienceMemory[], heading = '共同经验') =>
    <section className="v2-staff-section" aria-label={heading}><div className="v2-section-head"><h3>{heading}</h3>
      {!readOnly && <div className="v2-actions">
        <button className="v2-link" onClick={()=>open('learn',undefined,true)}>添加共同经验</button>
        {!experience && <button className="v2-link" disabled={write.busy} onClick={organize}>现在整理</button>}
      </div>}</div>
      {!shared.length && <p className="v2-quiet">尚未登记共同经验。</p>}
      {shared.map(showMemory)}
    </section>
  function organize() { void save({action:'organize',...(experience && {audience:'shared'})},'已完成经验整理。') }

  const sharedMemories = view?.sharedExperiences ?? []
  const inheritedShared = sharedMemories.filter(m=>!m.workspaceId)
  return <section className="v2-staff" aria-label={scopeTitle}>
    <Issue text={query.error} retry={query.refresh}/>
    {!view && !query.error && <p role="status">{experience ? '正在读取经验…' : '正在读取幕僚…'}</p>}
    {view && (experience ? <>
      <header className="v2-section-head"><h2>工作区经验</h2>
        {!readOnly && <button className="v2-button" disabled={write.busy} onClick={organize}>{write.busy ? '处理中…' : '现在整理'}</button>}
      </header>
      {showShared(sharedMemories.filter(m=>m.workspaceId === workspaceId),'本区共同经验')}
      {inheritedShared.length > 0 && <section className="v2-staff-section" aria-label="全局共同经验">
        <div className="v2-section-head"><h3>全局共同经验</h3>
          {openGlobal && <button className="v2-link" onClick={()=>openGlobal()}>到「我的幕僚」管理</button>}
        </div>
        {inheritedShared.map(showMemory)}
      </section>}
      {!!view.sharedReceived?.length && <section className="v2-staff-section" aria-label="本区获准借入的共同经验">
        <h3>本区获准借入的共同经验</h3>{view.sharedReceived.map(showBorrowed)}
      </section>}
    </> : selected ? <>
      <button className="v2-link" onClick={()=>choose()}><V2Icon name="back"/>返回名册</button>
      {member ? <>
        <header className="v2-section-head"><div className="v2-staff-identity"><ChatAvatar portrait={member.portrait ?? defaultStaffPortrait(member.id)}/><div><small>{member.homeWorkspaceId ? label(member.homeWorkspaceId)+'专属' : '全局幕僚'}</small><h2>{member.name}</h2></div></div>
          {assign && !readOnly && <button className="v2-button primary" onClick={()=>assign(member)}>交给这位幕僚</button>}</header>
        <p className="v2-staff-brief">{member.brief}</p>
        {workspaceId === member.homeWorkspaceId ? !readOnly && <div className="v2-actions">
          <button className="v2-link" onClick={()=>{setShowError(false);setMessage('');setOperation('portrait')}}>更换头像</button>
          <button className="v2-link" onClick={()=>open('edit')}>编辑职责</button></div>
          : member.homeWorkspaceId ? <button className="v2-link" onClick={()=>openMembership(member.homeWorkspaceId!,member.id)}>打开专属幕僚卡</button>
          : openGlobal && <button className="v2-link" onClick={()=>openGlobal(member.id)}>打开全局幕僚卡</button>}
        {workspace ? <section className="v2-staff-section"><h3>本区职责</h3>
          <p>{memberships.find(m=>m.workspaceId === workspaceId)?.duty || member.brief || '沿用通用职责'}</p>
          {!readOnly && <div className="v2-actions"><button className="v2-link" onClick={()=>open('duty')}>调整本区职责</button>
            {!member.homeWorkspaceId && <button className="v2-link" onClick={()=>open('leave')}>移出本区</button>}</div>}
          <h3>负责工单</h3>
          <div className="v2-card">{workspace.orders.filter(o=>o.staffId === member.id).length
            ? workspace.orders.filter(o=>o.staffId === member.id).map(o=><button key={o.id} className="v2-row" onClick={()=>openOrder(workspace.workspace.id,o.id)}>{o.title}</button>)
            : <p className="v2-quiet">还没有负责的工单。</p>}</div>
        </section> : <section className="v2-staff-section"><h3>参与的工作区</h3>
          <div className="v2-actions">{memberships.map(m=><button key={m.workspaceId} className="v2-button" onClick={()=>openMembership(m.workspaceId,member.id)}>{label(m.workspaceId)}</button>)}
            {!member.homeWorkspaceId && activeSpaces.some(w=>!memberships.some(m=>m.workspaceId === w.id)) && <button className="v2-link" onClick={()=>open('join')}>加入工作区</button>}</div>
          {!memberships.length && <p className="v2-quiet">尚未加入工作区。</p>}
        </section>}
        <section className="v2-staff-section"><div className="v2-section-head"><h3>成长记录</h3>
          {(workspaceId || !member.homeWorkspaceId) && !readOnly && <button className="v2-button" onClick={()=>open('learn')}>添加经验</button>}</div>
          {!memories.length && <p className="v2-quiet">尚未登记经验。</p>}
          {memories.map(showMemory)}
          {received.length > 0 && <><h3>本区获准使用</h3>{received.map(showBorrowed)}</>}
        </section>
        {!readOnly && <button className="v2-link" onClick={()=>open('reset')}>{workspaceId ? '重置本区记忆' : '重置全部记忆'}</button>}
      </> : <p className="v2-empty">这位幕僚已不在当前名册中。</p>}
    </> : <>
      <div className="v2-section-head">{workspace && <h2>工作区幕僚</h2>}{!readOnly && <div className="v2-actions">
        {workspace && view.available.length > 0 && <button className="v2-link" onClick={()=>open('invite')}>邀请幕僚</button>}
        <button className="v2-button" onClick={()=>open('create')}><V2Icon name="plus"/>{workspace ? '创建专属幕僚' : '创建全局幕僚'}</button></div>}</div>
      {readOnly && <p className="v2-quiet">{ARCHIVED_NOTE}</p>}
      <div className="v2-card">{view.members.map(m=><button key={m.id} className="v2-row" aria-label={m.name} onClick={()=>choose(m.id)}>
        <span className="v2-row-title"><span className="v2-staff-identity"><ChatAvatar portrait={m.portrait ?? defaultStaffPortrait(m.id)}/><strong>{m.name}</strong></span><V2Icon name="next"/></span>
        <small>{m.homeWorkspaceId ? label(m.homeWorkspaceId)+'专属' : '全局幕僚'}{m.brief && ' · '+m.brief.split('\n')[0]}</small></button>)}
        {!view.members.length && <p className="v2-quiet">{workspace ? '这个工作区还没有幕僚。' : '尚未建立幕僚名册。'}</p>}</div>
      {!workspace && showShared(sharedMemories)}
    </>)}
    {message && <p role="status">{message}</p>}
    {!operation && showError && <Issue text={write.error}/>}
    {operation === 'portrait' && !readOnly && member && workspaceId === member.homeWorkspaceId && <StaffPortraitPicker member={member}
      busy={write.busy} error={showError ? write.error : undefined} close={()=>setOperation(undefined)}
      save={portrait=>void save({action:'portrait',staffId:member.id,portrait},'已保存头像。')}/>}
    {operation && operation !== 'portrait' && !readOnly && view && <StaffForm key={operation.action+'/'+(operation.memory?.id ?? '')} operation={operation} member={member} view={view}
      spaces={spaces} workspace={workspace} path={path} busy={write.busy} error={showError ? write.error : undefined}
      close={()=>setOperation(undefined)} save={save}/>}
  </section>
}

function showBorrowed(share: NonNullable<StaffView['sharedReceived']>[number]) {
  return <article className="v2-card v2-staff-memory" key={share.id}>
    <small>获准借入 · 只读</small><p>{share.text}</p>
    {share.purpose && <p>用途 · {share.purpose}</p>}
    {share.expiresAt && <small>有效期至 {readableTime(share.expiresAt)}</small>}
  </article>
}

const evidenceLabels: Record<ExperienceEvidence['kind'], string> = {
  owner:'主人原话', group:'群消息', delivery:'交付', tool:'工具结果', test:'测试结果',
  'model-review':'模型评议', 'owner-acceptance':'主人验收', order:'来源工单',
}
function ExperienceDetails({memory, openEvidence}: {memory:ExperienceMemory; openEvidence?:Props['openEvidence']}) {
  return <>
    <small>{memory.source === 'suggestion' ? '幕僚建议' : memory.source === 'observation' ? '结果观察' : '本人指示'} · 版本 {memory.version}
      {memory.recordedAt ? ' · 登记于 '+readableTime(memory.recordedAt) : ''}
      {memory.adoptedAt && memory.adoptedAt !== memory.recordedAt ? ' · 采纳于 '+readableTime(memory.adoptedAt) : ''}</small>
    {memory.situation && <p>适用情境 · {memory.situation}</p>}
    {memory.boundary && <p>适用边界 · {memory.boundary}</p>}
    {!!memory.domains?.length && <p>领域 · {memory.domains.join('、')}</p>}
    {!!memory.taskTypes?.length && <p>任务类型 · {memory.taskTypes.join('、')}</p>}
    {memory.reason && <p>{memory.reason}</p>}
    <details>
      <summary>查看依据</summary>
      <small>经验编号 · {memory.id}</small>
      {!memory.evidence?.length && <p>暂无可定位的原始记录。</p>}
      {memory.evidence?.map(source=><div key={source.kind + ':' + source.id}>
        <strong>{evidenceLabels[source.kind]}</strong>
        <div><small>来源编号 · {source.id}{source.version && ' · 来源版本 '+source.version}</small></div>
        {source.quote && <p>{source.quote}</p>}
        {openEvidence && source.workspaceId && (source.messageId && source.sessionId || source.orderId)
          && <button className="v2-link" onClick={()=>openEvidence(source)}>打开来源</button>}
      </div>)}
      {memory.feedback?.map(feedback=><p key={feedback.id}>版本 {feedback.memory.version} · {evidenceLabels[feedback.evidence.kind]}
        {feedback.evidence.quote && ' · '+feedback.evidence.quote}</p>)}
    </details>
  </>
}

function ExperienceVersions({memory,editable,sharedOnly,restore,openEvidence}: {
  memory:ExperienceMemory; editable:boolean; sharedOnly?:boolean; restore:(version:number)=>void; openEvidence?:Props['openEvidence']
}) {
  const [version,setVersion] = useState<number>()
  const path = version === undefined ? undefined : staffPath(memory.workspaceId) + '?' +
    new URLSearchParams({memory:memory.id,version:String(version),...(sharedOnly && {experience:'shared'})})
  const query = useV2Read(path,sharedOnly ? isSharedExperienceVersion : isExperienceVersion)
  const previous = !query.error && query.data?.memory.version === version && query.data?.memory.id === memory.id ? query.data?.memory : undefined
  return <details><summary>历史版本</summary>
    <div className="v2-actions">{[...(memory.previousVersions ?? [])].reverse().map(number=><button type="button" key={number}
      aria-pressed={version === number} className="v2-link" onClick={()=>setVersion(number)}>版本 {number}</button>)}</div>
    <Issue text={query.error} retry={query.refresh}/>
    {previous && <><p>{previous.text}</p><ExperienceDetails memory={previous} openEvidence={openEvidence}/>
      {editable && previous.status !== 'retired' && <button className="v2-link" onClick={()=>restore(previous.version)}>恢复这个版本</button>}</>}
  </details>
}

interface FormProps {
  operation:Operation
  member?:StaffMember
  view:StaffView
  spaces:V2Workspace[]
  workspace?:V2WorkspaceView
  path:string
  busy:boolean
  error?:string
  close:()=>void
  save:Save
}
const formTitles = {create:'创建幕僚',invite:'邀请幕僚',join:'加入工作区',duty:'调整本区职责',edit:'编辑职责',leave:'移出本区',learn:'添加经验',revise:'更正经验',share:'共享经验',reset:'重置记忆'}

function StaffForm(props:FormProps) {
  const {operation:{action,memory,shared},workspace,member,spaces,view,path,save,busy,error,close} = props
  const workspaceId = workspace?.workspace.id
  const sourceOrders = workspace?.orders.filter(order=>shared || order.staffId === member?.id) ?? []
  const [destination,setDestination] = useState('')
  const [recipient,setRecipient] = useState('')
  const [shareDraft,setShareDraft] = useState<{text:string;purpose:string;expiresAt?:string}>()
  const shareWithWorkspace = recipient === 'workspace'
  const recipients = useV2Read(action === 'share' && destination ? staffPath(destination) + '?recipients=1' : undefined,isStaffRecipients)
  const reset = useV2Read(action === 'reset' && member ? path + '?impact=' + encodeURIComponent(member.id) : undefined,isStaffImpact)
  const impact = reset.data?.impact
  // Only a workspace that takes changes can receive a member or a share.
  const candidates = spaces.filter(space=>!workspaceArchived(space) && (action === 'join' ? !member?.memberships.some(m=>m.workspaceId === space.id) : space.id !== workspaceId))
  const targetMembers = recipients.data?.members ?? []
  const target = targetMembers.find(m=>m.id === (recipient || member?.id))
  const targetName = spaces.find(w=>w.id === destination)?.name
  const resetScope = workspace ? workspace.workspace.name : '所有工作区和通用经验'
  const submit = (event:FormEvent<HTMLFormElement>) => {
    const data = formData(event)
    const identity = shared ? {audience:'shared'} : {staffId:member?.id}
    if (action === 'create' || action === 'edit') {
      void save({action,...(action === 'edit' && identity),name:field(data,'name'),brief:field(data,'brief')},action === 'edit' ? '已更新职责。' : '已创建幕僚。')
    } else if (action === 'join' || action === 'duty' || action === 'invite') {
      const id = action === 'invite' ? field(data,'member') : member?.id
      void save({action:'join',staffId:id,duty:field(data,'duty')},action === 'duty' ? '已保存本区职责。' : '幕僚已加入工作区。',action === 'join' ? staffPath(field(data,'workspace')) : path)
    } else if (action === 'learn' || action === 'revise') {
      const orderId = field(data,'order')
      const tags = (key:string) => field(data,key).split(/[,，]/).map(tag=>tag.trim()).filter(Boolean)
      void save({action,...identity,text:field(data,'text'),situation:field(data,'situation'),boundary:field(data,'boundary'),
        domains:tags('domains'),taskTypes:tags('taskTypes'),...(orderId && {orderId}),
        ...(memory && {memoryId:memory.id,version:memory.version})},'已保存经验。')
    } else if (action === 'leave') {
      void save({action,...identity},'已移出工作区。')
    } else if (action === 'reset' && impact) {
      void save({action,...identity,confirmation:impact.token},'记忆已重置。')
    } else if (action === 'share' && (target || shareWithWorkspace)) {
      if (shareDraft) void save({action,...identity,memoryId:memory?.id,sourceVersion:memory?.version,targetWorkspaceId:destination,
        ...(shareWithWorkspace ? {targetAudience:'shared'} : {targetStaffId:target?.id}),...shareDraft},'已共享所选内容。')
      else {
        const date = field(data,'expires')
        setShareDraft({text:field(data,'text'),purpose:field(data,'purpose'),...(date && {expiresAt:new Date(date).toISOString()})})
      }
    }
  }
  const shareReady = !!destination && (!!target || shareWithWorkspace)
  const submitLabel = {create:'创建',edit:'保存职责',invite:'确认邀请',join:'确认加入',duty:'保存本区职责',leave:'确认移出',learn:'保存经验',revise:'保存更正',share:shareDraft ? '确认共享' : '预览共享',reset:'确认重置'}[action]
  return <V2Dialog title={formTitles[action]} meta={member?.name ?? workspace?.workspace.name} close={close}>
    <form onSubmit={submit}>
      {(action === 'create' || action === 'edit') && <>
        <label>名称<input name="name" required maxLength={80} defaultValue={action === 'edit' ? member?.name : ''}/></label>
        <label>职责<textarea name="brief" required maxLength={3000} defaultValue={action === 'edit' ? member?.brief : ''}/></label></>}
      {action === 'invite' && <label>选择幕僚<select required name="member" defaultValue=""><option value="" disabled>选择全局幕僚</option>
        {view.available.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
      {action === 'join' && <label>选择工作区<select name="workspace" required defaultValue=""><option value="" disabled>选择工作区</option>
        {candidates.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
      {['join','invite','duty'].includes(action) && <label>本区职责<textarea name="duty" maxLength={3000} placeholder="留空时沿用通用职责"
        defaultValue={action === 'duty' ? member?.memberships.find(m=>m.workspaceId === workspaceId)?.duty : ''}/></label>}
      {action === 'leave' && <p>将{member?.name}移出「{workspace?.workspace.name}」？</p>}
      {(action === 'learn' || action === 'revise') && <><label>经验内容<textarea name="text" maxLength={3000} required defaultValue={memory?.text}/></label>
        <label>适用情境（选填）<input name="situation" maxLength={500} defaultValue={memory?.situation}/></label>
        <label>适用边界（选填）<input name="boundary" maxLength={500} defaultValue={memory?.boundary}/></label>
        <label>领域（用逗号分隔）<input name="domains" maxLength={500} defaultValue={memory?.domains?.join('，')}/></label>
        <label>任务类型（用逗号分隔）<input name="taskTypes" maxLength={500} defaultValue={memory?.taskTypes?.join('，')}/></label>
        {action === 'learn' && sourceOrders.length > 0 && <label>经验来源<select name="order" defaultValue=""><option value="">本人指示</option>
          {sourceOrders.map(o=><option key={o.id} value={o.id}>{o.title}</option>)}</select></label>}
        {action === 'learn' && !workspace && <p>{shared ? '本脑各工作区的相关任务可使用这条共同经验。' : '通用做法会随这位幕僚用于它参与的工作区。'}</p>}
        {action === 'revise' && <p>更正后，需重新选择要共享的文字。</p>}</>}
      {action === 'share' && <>
        <div hidden={!!shareDraft}>
          <label>接收工作区<select required value={destination} onChange={e=>{setDestination(e.target.value); setRecipient('')}}>
            <option value="" disabled>选择工作区</option>{candidates.map(w=><option value={w.id} key={w.id}>{w.name}</option>)}</select></label>
          {destination && <><Issue text={recipients.error} retry={recipients.refresh}/>
            <label>接收幕僚<select required value={shareWithWorkspace ? 'workspace' : target?.id ?? ''} onChange={e=>setRecipient(e.target.value)}>
              <option value="" disabled>选择接收人</option>{shared && <option value="workspace">本区成员</option>}
              {targetMembers.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></label>
            {!shared && recipients.data && !targetMembers.length && <p>请先在接收区邀请一位幕僚。</p>}</>}
          <label>共享内容<textarea name="text" defaultValue={memory?.text} required maxLength={3000}/></label>
          <label>用途（选填）<input name="purpose" maxLength={500}/></label>
          <label>有效期至（选填）<input name="expires" type="datetime-local"/></label>
        </div>
        {shareDraft && <section className="v2-staff-memory" aria-label="共享预览"><h3>{targetName} · {shareWithWorkspace ? '本区成员' : target?.name}</h3>
          <p>{shareDraft.text}</p>{shareDraft.purpose && <p>用途 · {shareDraft.purpose}</p>}
          <small>{shareDraft.expiresAt ? '有效期至 '+readableTime(shareDraft.expiresAt) : '有效期至撤回'}</small>
          <button className="v2-link" type="button" onClick={()=>setShareDraft(undefined)}>修改共享内容</button></section>}
      </>}
      {action === 'reset' && <><Issue text={reset.error} retry={reset.refresh}/>
        {impact ? <><p>将重置{member?.name}在「{resetScope}」的记忆。</p>
          <p>{impact.memories} 条经验，{impact.shares} 条关联共享。</p>
          {impact.workspaceIds.length > 0 && <p>影响的工作区 · {impact.workspaceIds.map(id=>spaces.find(w=>w.id === id)?.name ?? '工作区').join('、')}</p>}
          <p>重置后，原始工单、你的个人资料和人物档案仍可查看。</p></> : !reset.error && <p role="status">正在核对影响范围…</p>}</>}
      <Issue text={error}/>
      {action === 'reset' && error && <button type="button" className="v2-link" onClick={()=>void reset.refresh()}>重新核对影响范围</button>}
      <button className="v2-button primary" disabled={busy || (action === 'reset' && !impact) || (action === 'share' && !shareReady)}>{submitLabel}</button>
    </form>
  </V2Dialog>
}
