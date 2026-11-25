import { useState, type FormEvent } from 'react'
import type { StaffMember, StaffMemory, StaffView } from '../core/workspace-staff.ts'
import { workspaceArchived, type V2Workspace, type V2WorkspaceView } from '../core/workspace-v2.ts'
import { ARCHIVED_NOTE, Issue, readableTime, useArchived, V2Dialog, V2Icon } from './workspace-v2-elements.tsx'
import { useV2Read, useV2Write } from './workspace-v2-api.ts'
import { defaultStaffPortrait } from '../core/workspace-avatars.ts'
import { ChatAvatar } from './workspace-chat-avatar.tsx'
import { StaffPortraitPicker } from './workspace-staff-portrait.tsx'
import { isStaffImpact, isStaffRecipients, isStaffView, staffPath } from './workspace-staff-response.ts'

interface Props {
  workspace?: V2WorkspaceView
  spaces: V2Workspace[]
  selected?: string
  select:(id?:string)=>void
  openMembership:(workspace:string,staffId:string)=>void
  openOrder:(workspace:string,order:string)=>void
  openGlobal?:(id:string)=>void
  assign?:(member:StaffMember)=>void
}
type Action = 'create' | 'invite' | 'join' | 'duty' | 'edit' | 'leave' | 'learn' | 'revise' | 'share' | 'reset'
type Operation = {action:Action; memory?:StaffMemory}
type Save = (body:Record<string,unknown>,message:string,path?:string)=>Promise<boolean>

function formData(event:FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget) }
const field = (data:FormData,key:string) => String(data.get(key) ?? '').trim()

export function StaffBoard(props:Props) {
  const {workspace,spaces,selected,select,openMembership,openOrder,openGlobal,assign} = props
  const workspaceId = workspace?.workspace.id
  const path = staffPath(workspaceId)
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
  const memories = view?.memories.filter(m=>m.staffId === selected) ?? []
  const received = view?.received.filter(s=>s.staffId === selected) ?? []
  const label = (id:string) => spaces.find(w=>w.id === id)?.name ?? '工作区'
  const open = (action:Action,memory?:StaffMemory) => { setShowError(false); setMessage(''); setOperation({action,memory}) }
  const save:Save = async (body,success,destination=path) => {
    setShowError(true)
    const result = await write.post<StaffView>(destination,body)
    if (!result) return false
    await query.refresh()
    setOperation(undefined); setMessage(success)
    if (body.action === 'leave' && workspaceId) select()
    return true
  }
  function choose(id?:string) { setOperation(undefined); setMessage(''); setShowError(false); select(id) }
  const scopeTitle = workspace ? '工作区幕僚' : '我的幕僚'
  return <section className="v2-staff" aria-label={scopeTitle}>
    <Issue text={query.error} retry={query.refresh}/>
    {!view && !query.error && <p role="status">正在读取幕僚…</p>}
    {view && (selected ? <>
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
          {memories.map(memory=>{
            const editable = workspaceId === memory.workspaceId && !readOnly
            const shares = view.shares.filter(s=>s.memoryId === memory.id)
            return <article key={memory.id} className="v2-card v2-staff-memory">
              <small>{memory.status === 'proposed' ? '待采纳' : '已采纳'} · {memory.workspaceId ? label(memory.workspaceId) : '通用做法'} · {readableTime(memory.at)}</small>
              <p>{memory.text}</p>
              <small>{memory.source === 'suggestion' ? '幕僚建议' : '本人指示'}{memory.recordedAt ? ' · 登记于 '+readableTime(memory.recordedAt) : ''}
                {memory.adoptedAt && memory.adoptedAt !== memory.recordedAt ? ' · 采纳于 '+readableTime(memory.adoptedAt) : ''}</small>
              <div className="v2-actions">{memory.orderId && memory.workspaceId && <button className="v2-link" onClick={()=>openOrder(memory.workspaceId!,memory.orderId!)}>查看来源工单</button>}
                {memory.lastUsed && <button className="v2-link" onClick={()=>openOrder(memory.lastUsed!.workspaceId,memory.lastUsed!.orderId)}>最近提供给工单 · {readableTime(memory.lastUsed.at)}</button>}</div>
              {editable ? <div className="v2-actions">
                {memory.status === 'proposed' && <button className="v2-button" disabled={write.busy} onClick={()=>void save({action:'accept',staffId:selected,memoryId:memory.id},'已采纳经验。')}>采纳</button>}
                {workspaceId && memory.status === 'active' && <button className="v2-link" onClick={()=>open('share',memory)}>共享经验</button>}
                <button className="v2-link" onClick={()=>open('revise',memory)}>更正</button>
                <button className="v2-link" disabled={write.busy} onClick={()=>void save({action:'retire',staffId:selected,memoryId:memory.id},'这条经验已停用。')}>停用</button>
              </div> : memory.workspaceId && memory.workspaceId !== workspaceId && <button className="v2-link" onClick={()=>openMembership(memory.workspaceId!,member.id)}>到来源工作区管理</button>}
              {shares.map(s=><div className="v2-staff-share" key={s.id}>
                <strong>已共享给{label(s.targetWorkspaceId)}{s.targetStaffName && ' · '+s.targetStaffName}</strong><p>{s.text}</p>
                {s.purpose && <small>用途 · {s.purpose}</small>}{s.expiresAt && <small>有效期至 {readableTime(s.expiresAt)}</small>}
                {editable && <button className="v2-link" disabled={write.busy} onClick={()=>void save({action:'revoke',staffId:selected,shareId:s.id},'已撤回共享。')}>撤回共享</button>}
              </div>)}
            </article>
          })}
          {received.length > 0 && <><h3>本区获准使用</h3>{received.map(s=><article key={s.id} className="v2-card v2-staff-memory"><p>{s.text}</p>
            {s.purpose && <small>{s.purpose}</small>}{s.expiresAt && <small>有效期至 {readableTime(s.expiresAt)}</small>}</article>)}</>}
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
  const {operation:{action,memory},workspace,member,spaces,view,path,save,busy,error,close} = props
  const workspaceId = workspace?.workspace.id
  const sourceOrders = workspace?.orders.filter(order=>order.staffId === member?.id) ?? []
  const [destination,setDestination] = useState('')
  const [recipient,setRecipient] = useState('')
  const [shareDraft,setShareDraft] = useState<{text:string;purpose:string;expiresAt?:string}>()
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
    const identity = {staffId:member?.id}
    if (action === 'create' || action === 'edit') {
      void save({action,...(action === 'edit' && identity),name:field(data,'name'),brief:field(data,'brief')},action === 'edit' ? '已更新职责。' : '已创建幕僚。')
    } else if (action === 'join' || action === 'duty' || action === 'invite') {
      const id = action === 'invite' ? field(data,'member') : member?.id
      void save({action:'join',staffId:id,duty:field(data,'duty')},action === 'duty' ? '已保存本区职责。' : '幕僚已加入工作区。',action === 'join' ? staffPath(field(data,'workspace')) : path)
    } else if (action === 'learn' || action === 'revise') {
      const orderId = field(data,'order')
      void save({action,...identity,text:field(data,'text'),...(orderId && {orderId}),...(memory && {memoryId:memory.id})},'已保存经验。')
    } else if (action === 'leave') {
      void save({action,...identity},'已移出工作区。')
    } else if (action === 'reset' && impact) {
      void save({action,...identity,confirmation:impact.token},'记忆已重置。')
    } else if (action === 'share' && target) {
      if (shareDraft) void save({action,...identity,memoryId:memory?.id,sourceVersion:memory?.version,targetWorkspaceId:destination,targetStaffId:target.id,...shareDraft},'已共享所选内容。')
      else {
        const date = field(data,'expires')
        setShareDraft({text:field(data,'text'),purpose:field(data,'purpose'),...(date && {expiresAt:new Date(date).toISOString()})})
      }
    }
  }
  const shareReady = !!destination && !!target
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
        {action === 'learn' && sourceOrders.length > 0 && <label>经验来源<select name="order" defaultValue=""><option value="">本人指示</option>
          {sourceOrders.map(o=><option key={o.id} value={o.id}>{o.title}</option>)}</select></label>}
        {action === 'learn' && !workspace && <p>通用做法会随这位幕僚用于它参与的工作区。</p>}
        {action === 'revise' && <p>更正后，需重新选择要共享的文字。</p>}</>}
      {action === 'share' && <>
        <div hidden={!!shareDraft}>
          <label>接收工作区<select required value={destination} onChange={e=>{setDestination(e.target.value); setRecipient('')}}>
            <option value="" disabled>选择工作区</option>{candidates.map(w=><option value={w.id} key={w.id}>{w.name}</option>)}</select></label>
          {destination && <><Issue text={recipients.error} retry={recipients.refresh}/>
            <label>接收幕僚<select required value={target?.id ?? ''} onChange={e=>setRecipient(e.target.value)}>
              <option value="" disabled>选择接收人</option>{targetMembers.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></label>
            {recipients.data && !targetMembers.length && <p>请先在接收区邀请一位幕僚。</p>}</>}
          <label>共享内容<textarea name="text" defaultValue={memory?.text} required maxLength={3000}/></label>
          <label>用途（选填）<input name="purpose" maxLength={500}/></label>
          <label>有效期至（选填）<input name="expires" type="datetime-local"/></label>
        </div>
        {shareDraft && <section className="v2-staff-memory" aria-label="共享预览"><h3>{targetName} · {target?.name}</h3>
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
