import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { orderEnded, workspaceArchived, type V2Acceptance, type V2Delegation, type V2Session, type V2Workspace, type V2WorkspaceView } from '../core/workspace-v2.ts'
import { historyItemId } from '../core/workspace-history.ts'
import { SUPERHUB_SURFACES, type SuperhubSurface } from '../core/workspace-product.ts'
import type { Scoped } from './superhub-api.ts'
import { WorkspaceMark } from './workspace-brand.tsx'
import { WorkspaceIcon } from './workspace-icon.tsx'
import hubEmblem from './artwork/hub-fold.webp'
import { clearV2PrivateCache, segment, useV2Read, useV2Write, V2Client, V2_ROOT } from './workspace-v2-api.ts'
import { ArchivedWorkspace, delegationState, Issue, readableTime, sessionKind, useArchived, V2Dialog, V2Icon } from './workspace-v2-elements.tsx'
import { isOrderOriginal, isWorkspaceIndex, isWorkspaceView } from './workspace-v2-response.ts'
import { ConversationBoard, Transcript } from './workspace-v2-talk.tsx'
import { HistoryHome, HistoryPanel, TransferDialog } from './workspace-history.tsx'
import { WorkspaceLiaison } from './workspace-liaison.tsx'
import { UnreadBadge, unreadLabel, useLiaisonUnread } from './workspace-liaison-unread.tsx'
import { WorkspaceProfileImports } from './workspace-profile-import.tsx'
import { WorkspacePeople } from './workspace-people.tsx'
import { WorkspaceCalendar } from './workspace-calendar.tsx'
import { OrderOutputs } from './workspace-coding-delivery.tsx'
import { OutputsBoard, RecentOutputs } from './workspace-outputs.tsx'
import { OrderFollowup } from './workspace-followup.tsx'
import { OrderExecution, OrderPermission, PendingCommandApprovals, usePendingApprovals } from './workspace-execution.tsx'
import { DirectoryDialog, directoryText, ProjectDirectory } from './workspace-directory.tsx'
import { OrderResultInbox } from './workspace-notices.tsx'
import { OwnerActions, useOwnerActions } from './workspace-owner-actions.tsx'
import type { OwnerAction } from '../core/workspace-engagement.ts'
import { unreadBadge } from '../core/liaison-unread.ts'
import type { StaffMember } from '../core/workspace-staff.ts'
import { StaffBoard } from './workspace-staff.tsx'
import { isStaffView, staffPath } from './workspace-staff-response.ts'
import { WorkspaceSettings } from './workspace-settings.tsx'
import { WORKSPACE_V2_STYLE } from './workspace-v2-style.ts'

interface Props { scope: string; native?: () => void; configure: boolean; reloadBrain: () => Promise<void> }
type Place = { view: SuperhubSurface | 'profile'; workspace?: string; panel?: 'execution' | 'outputs' | 'staff' | 'experience'; delegation?: string; session?: string; message?: string; item?: string; date?: string }
type Popup = 'new-space' | 'switch-space' | 'delegate' | 'new-session' | 'narrow' | 'cancel' | 'liaison' | 'import' | 'export'

export function readPlace(scope: string): Place {
  if (!location.hash.startsWith('#v2?')) return { view: 'today' }
  const params = new URLSearchParams(location.hash.slice(4))
  if (params.get('scope') !== scope) return { view: 'today' }
  const id = (key: string) => params.get(key) || undefined
  const view = params.get('view')
  const staffPanel = params.get('panel') === 'staff' ? 'staff' : undefined
  if (view === 'settings') return {view,panel:staffPanel,item:staffPanel ? id('item') : id('item') === 'schedules' ? 'schedules' : undefined}
  if (view === 'calendar') return {view,date:id('date')}
  if (view === 'people' || view === 'history' || view === 'profile') return {view,item:id('item')}
  const panel = params.get('panel')
  const workPanel = panel === 'execution' || panel === 'outputs' || panel === 'experience' ? panel : staffPanel
  if (view === 'workspace' && workPanel === 'experience') return {view,workspace:id('workspace'),panel:workPanel}
  if (view === 'workspace') return {view,workspace:id('workspace'),panel:workPanel,item:staffPanel && id('item'),
    delegation:id('order') ?? id('delegation'),session:id('session'),message:id('message')}
  return {view:'today',workspace:id('workspace')}
}

export function WorkspaceV2(props: Props) { return <BrainWorkspace key={props.scope} {...props}/> }

function BrainWorkspace(props: Props) {
  const [denied, setDenied] = useState('')
  const client = useMemo(() => ({ scope: props.scope, revoke(message: string) {
    clearV2PrivateCache(props.scope)
    setDenied(message)
  } }), [props.scope])
  return <div className="wv2"><style>{WORKSPACE_V2_STYLE}</style><V2Client.Provider value={client}>
    {denied ? <main className="v2-bound v2-offline"><h1>工作区暂不可读</h1><p role="alert">{denied}</p>
      <button className="v2-button primary" onClick={() => setDenied('')}>重新连接</button>
      {props.native && <button className="v2-button" onClick={props.native}>返回 DSH</button>}</main> : <Home {...props}/>}
  </V2Client.Provider></div>
}

function Home({ scope, native, configure, reloadBrain }: Props) {
  const [place, setPlace] = useState<Place>(() => readPlace(scope))
  const [opening, setOpening] = useState<Place>()
  const [popup, setPopup] = useState<Popup>()
  const [orderStaff,setOrderStaff] = useState<StaffMember>()
  const [orderSession, setOrderSession] = useState<string>()
  const [visibleSession, setVisibleSession] = useState<string>()
  const [notice, setNotice] = useState('')
  const page = useRef<HTMLElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const liaisonButton = useRef<HTMLButtonElement>(null)
  const currentView = useRef(place.view)
  useLayoutEffect(() => { currentView.current = place.view },[place.view])
  const returnFocus = useRef<string | undefined>(undefined)
  const profileParent = useRef<{place:Place; scrollTop:number; fromLiaison:boolean}>(undefined)
  const profileListScroll = useRef(0)
  const returnScroll = useRef<number>(undefined)
  const showSpaces = place.view === 'today' || place.view === 'workspace' || place.panel === 'staff'
  const index = useV2Read(showSpaces ? V2_ROOT : undefined, isWorkspaceIndex, 15000)
  const spaces = index.data?.workspaces ?? []
  // An archived workspace opens only when asked for by id (「切换工作区 → 已归档」, a link); the default skips it.
  const activeSpaces = spaces.filter(space => !workspaceArchived(space))
  const chosenId = place.workspace || activeSpaces[0]?.id
  const workspace = spaces.find(row => row.id === chosenId)
  const base = workspace && V2_ROOT + '/' + segment(workspace.id)
  const current = useV2Read(place.view === 'workspace' ? base : undefined, isWorkspaceView, 8000)
  const view = current.data?.workspace.id === workspace?.id ? current.data : undefined
  // The one place that decides whether this workspace takes changes; everything below reads `ArchivedWorkspace`.
  const shown = view?.workspace ?? workspace
  const archived = place.view === 'workspace' && !!shown && workspaceArchived(shown)
  const personalId = index.data?.personalWorkspaceId ?? view?.personalWorkspaceId
  const delegation = view?.orders.find(row => row.id === place.delegation)
  const panel = place.panel === 'execution'
  const entering = place === opening
  const navigate = useCallback((next: Place) => {
    const search = new URLSearchParams({ scope, view: next.view })
    if (next.workspace) search.set('workspace', next.workspace)
    if (next.panel) search.set('panel', next.panel)
    if (next.session) search.set('session', next.session)
    if (next.message) search.set('message', next.message)
    if (next.delegation) search.set('order', next.delegation)
    if (next.item) search.set('item', next.item)
    if (next.date) search.set('date', next.date)
    const hash = '#v2?' + search
    if (location.hash !== hash) history.pushState({...history.state, chiefSettingsParent:next.view === 'settings' ? scope : undefined}, '', hash)
    setPlace(next); setPopup(undefined); setNotice('')
  }, [scope])
  useEffect(() => {
    const follow = () => {
      const next = readPlace(scope)
      if (currentView.current === 'settings' && next.view !== 'settings') returnFocus.current = 'settings-button'
      setPlace(next); setPopup(undefined); setNotice('')
    }
    window.addEventListener('popstate', follow); window.addEventListener('hashchange', follow)
    return () => { window.removeEventListener('popstate', follow); window.removeEventListener('hashchange', follow) }
  }, [scope])
  useLayoutEffect(() => {
    if (page.current) page.current.scrollTop = returnScroll.current ?? 0
    returnScroll.current = undefined
    if (entering) return
    const key = returnFocus.current
    if (key === 'settings-button') {
      settingsButton.current?.focus({preventScroll:true})
      returnFocus.current = undefined
      return
    }
    if (key === 'liaison-button') {
      liaisonButton.current?.focus({preventScroll:true})
      returnFocus.current = undefined
      return
    }
    const target = key && Array.from(page.current?.querySelectorAll<HTMLButtonElement>('[data-focus]') ?? []).find(el => el.dataset.focus === key)
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); returnFocus.current = undefined }
    else if (key === '') {
      const heading = place.session ? page.current?.querySelector<HTMLElement>('[data-conversation-title]') : page.current?.querySelector<HTMLElement>('[data-page-title]')
      if (heading) { heading.focus({ preventScroll: true }); returnFocus.current = undefined }
    }
  }, [place, view?.workspace.id, entering])
  function go(next: Place, focus = '') { returnFocus.current = focus; navigate(next) }
  async function enterCreated(next: Place, refresh: () => Promise<void>) {
    setOpening(next)
    go(next)
    await refresh()
    setOpening(current => current === next ? undefined : current)
  }
  const openWorkspace = (id?: string) => go({ view: 'workspace', workspace: id })
  const openDelegation = (id: string) => go({ view: 'workspace', workspace: chosenId, delegation: id })
  const openSession = (id: string, from?: string, message?: string) => go({ view: 'workspace', workspace: chosenId, panel: 'execution', session: id, delegation: from, message })
  const openHistory = (item?: string) => go({ view: 'history', item })
  /** 「设置 → 定时安排」：从接口人的定时提醒或「经验」面板进入，落在这一节。 */
  const openSchedules = () => go({ view: 'settings', item: 'schedules' })
  const openProfile = (item?: string) => {
    const scrollTop = page.current?.scrollTop ?? 0
    if (place.view !== 'profile') profileParent.current = {place,scrollTop,fromLiaison:popup === 'liaison'}
    else if (!place.item) profileListScroll.current = scrollTop
    go({view:'profile',item})
  }
  const backFromProfile = () => {
    if (place.item) {
      returnScroll.current = profileListScroll.current
      go({view:'profile'}, 'profile-' + place.item)
      return
    }
    const parent = profileParent.current
    returnScroll.current = parent?.scrollTop
    go(parent?.place ?? {view:'today'}, parent?.fromLiaison ? 'liaison-button' : 'transfer-import')
  }
  function newOrder(sessionId?: string, staff?: StaffMember) { setOrderStaff(staff); setOrderSession(sessionId); setPopup('delegate') }
  const staffPanel = place.panel === 'staff'
  const experiencePanel = place.panel === 'experience'
  const outputsPanel = place.panel === 'outputs'
  const openOutputs = () => go({view:'workspace',workspace:chosenId,panel:'outputs'})
  // Outputs are re-read while an order can still deliver, and whenever the orders change (a turn spent, a new order).
  const outputsFeed = {live: !archived && !!view?.orders.some(order => !orderEnded(order) && !order.paused),
    revision: view?.orders.reduce((sum, order) => sum + order.remainingTurns + 1, 0)}
  const selecting = place.view === 'workspace' && !!workspace
  const reading = selecting && panel && !!place.session
  const liaisonSession = selecting && view?.sessions.find(s => s.id === (panel ? visibleSession : delegation?.sessionId))
  const liaisonOrder = liaisonSession && (delegation?.sessionId === liaisonSession.id ? delegation.id
    : !place.delegation && liaisonSession.delegationIds.length === 1 ? liaisonSession.delegationIds[0] : undefined)
  const lostWorkspace = place.workspace && index.data && !workspace
  // Re-read the count as the conversation opens and closes (closing it marked its newest message as seen).
  const unread = useLiaisonUnread(popup === 'liaison', popup === 'liaison' ? 1 : 0)
  const ownerActions = useOwnerActions()
  const pending = ownerActions.data?.items ?? []
  const approvals = usePendingApprovals()
  const pendingDecisions = approvals.data ?? { approvals: [], acceptances: [] }
  const pendingCount = pending.length + new Set(pendingDecisions.approvals.map(row => row.id)).size
    + new Set(pendingDecisions.acceptances?.map(row => row.orderId)).size
  const pendingBadge = unreadBadge(pendingCount)
  const liaisonLabel = unreadLabel('一句话交办', unread)
    + (pendingBadge ? '，' + (pendingCount > 99 ? '超过 99' : pendingCount) + ' 件待回应' : '')
  const openOwnerAction = (row: OwnerAction) => go({view:'workspace', workspace:row.workspaceId, panel:'execution',
    session:row.sessionId, delegation:row.orderId, message:row.messageId})
  const pendingList = (today: boolean) => <PendingCommandApprovals today={today} goToday={() => go({view:'today'})}
    list={pendingDecisions} ownerActions={pending} openOwnerAction={openOwnerAction} ownerActionError={ownerActions.error} retryOwnerActions={ownerActions.refresh}
    open={row => go(row.workOrderId ? {view:'workspace',workspace:row.workspaceId,delegation:row.workOrderId}
      : {view:'workspace',workspace:row.workspaceId,panel:'execution',session:row.sessionId})}
    openOrder={row => go({view:'workspace',workspace:row.workspaceId,delegation:row.orderId})}/>
  const lostOrder = place.delegation && (index.data && !workspace || view && !delegation)
  async function reread() { await Promise.all([index.refresh(), current.refresh()]) }
  return <ArchivedWorkspace.Provider value={archived}><OwnerActions.Provider value={{ items:pending, refresh:ownerActions.refresh }}>
    <header className="v2-mast"><div className="v2-bound">
      <V2Brand home={() => go({ view: 'today' })}/>
      <nav aria-label="日常入口" className="v2-primary-nav">
        <button aria-current={place.view === 'today' || place.view === 'history' || place.view === 'profile' ? 'page' : undefined} onClick={() => go({ view: 'today', workspace: place.workspace })}><V2Icon name="today"/>{SUPERHUB_SURFACES.today.label}</button>
        <button aria-current={place.view === 'workspace' ? 'page' : undefined} onClick={() => openWorkspace(place.workspace)}><V2Icon name="work"/>{SUPERHUB_SURFACES.workspace.label}</button>
        <button aria-current={place.view === 'people' ? 'page' : undefined} onClick={() => go({ view:'people' })}><V2Icon name="group"/>{SUPERHUB_SURFACES.people.label}</button>
        <button aria-current={place.view === 'calendar' ? 'page' : undefined} onClick={() => go({ view:'calendar' })}><V2Icon name="calendar"/>{SUPERHUB_SURFACES.calendar.label}</button>
      </nav>
      <div className="v2-mast-actions">
        {native && <button className="v2-link" onClick={native} aria-label="返回 DSH"><V2Icon name="back"/><span className="v2-wide">DSH</span></button>}
        <button ref={settingsButton} className="v2-link" aria-current={place.view === 'settings' ? 'page' : undefined}
          onClick={() => { if (place.view !== 'settings') go({view:'settings'}) }} aria-label="设置">设置</button>
        <button ref={liaisonButton} className="v2-button primary v2-liaison-button" aria-label={liaisonLabel}
          onClick={() => setPopup('liaison')}><V2Icon name="chat"/>一句话交办
          {pendingBadge && <span className="v2-owner-action-count" aria-hidden="true">待回应 {pendingBadge}</span>}
          <UnreadBadge count={unread}/></button>
      </div>
    </div></header>
    <main ref={page} className={'v2-page' + (reading ? ' reading' : '')} tabIndex={-1}><div className={'v2-bound' + (place.view === 'today' ? ' v2-home' : '')}>
      <div className={'v2-hero' + (place.view === 'workspace' ? ' v2-work-hero' : '')}><div>{place.view === 'today' && <div className="v2-eyebrow">
        {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</div>}
        {place.view === 'history' && <button className="v2-link" onClick={() => go({ view: 'today' })}><V2Icon name="back"/>返回今天</button>}
        {place.view === 'profile' && <button className="v2-link" onClick={backFromProfile}><V2Icon name="back"/>{place.item ? '返回导入记录' : '返回'}</button>}
        {place.view === 'settings' && <button className="v2-link" onClick={() => {
          if (history.state?.chiefSettingsParent === scope) history.back()
          else if (staffPanel) go({view:'settings'})
          else go({view:'today'},'settings-button')
        }}><V2Icon name="back"/>返回</button>}
        {selecting && (panel || delegation) && <div className="v2-eyebrow">{workspace.name}</div>}
        <h1 data-page-title tabIndex={-1}>{place.view === 'workspace' ? (panel ? '执行对话' : delegation?.title ?? workspace?.name ?? '工作区')
          : place.view === 'settings' && staffPanel ? '我的幕僚' : place.view === 'history' ? '资料'
          : place.view === 'profile' ? place.item ? '核对资料' : '从别的助手导入' : SUPERHUB_SURFACES[place.view].label}</h1>
        {selecting && !panel && !place.delegation && workspace.goal && <p>{workspace.goal}</p>}
      </div>{place.view === 'workspace' && spaces.length > 0 && <button className="v2-button" onClick={() => setPopup('switch-space')}>切换工作区<V2Icon name="down"/></button>}
        {(place.view === 'today' || place.view === 'history') && <div className="v2-actions v2-transfer" aria-label="资料交换">
          <button className="v2-link" data-focus="transfer-import" onClick={() => setPopup('import')}>导入</button>
          <button className="v2-link" onClick={() => setPopup('export')}>导出</button>
        </div>}
        {place.view === 'profile' && <button className="v2-link" onClick={() => setPopup('export')}>导出</button>}
      </div>
      {pendingList(place.view === 'today')}
      <OrderResultInbox today={place.view === 'today'} goToday={() => go({view:'today'})}
        openOrder={row => go({view:'workspace',workspace:row.workspaceId,delegation:row.orderId})}
        openSource={row => go({view:'workspace',workspace:row.workspaceId,delegation:row.orderId,panel:'execution',session:row.sessionId,message:row.messageId})}/>
      {selecting && <nav className="v2-subnav" aria-label="工作区版面">
        <button aria-current={!place.panel ? 'page' : undefined} onClick={() => openWorkspace(chosenId)}><V2Icon name="work"/>概览</button>
        <button aria-current={panel ? 'page' : undefined} onClick={() => go({ view: 'workspace', workspace: chosenId, panel: 'execution' })}><V2Icon name="chat"/>执行</button>
        <button aria-current={outputsPanel ? 'page' : undefined} onClick={openOutputs}><V2Icon name="box"/>产物</button>
        <button aria-current={staffPanel ? 'page' : undefined} onClick={() => go({view:'workspace',workspace:chosenId,panel:'staff'})}><V2Icon name="group"/>幕僚</button>
        <button aria-current={experiencePanel ? 'page' : undefined} onClick={() => go({view:'workspace',workspace:chosenId,panel:'experience'})}><V2Icon name="book"/>经验</button>
      </nav>}
      {selecting && archived && shown && <ArchivedBanner workspace={shown} restored={async () => { await reread(); setNotice('已恢复「' + shown.name + '」。') }}/>}
      {place.view === 'history' && <HistoryPanel itemId={place.item} openItem={openHistory} back={() => openHistory()}/>}
      {place.view === 'profile' && <WorkspaceProfileImports selected={place.item} open={openProfile}/>}
      {place.view === 'settings' && !staffPanel && <WorkspaceSettings key={place.item ?? 'settings'} configure={configure} reloadBrain={reloadBrain}
        focusSchedules={place.item === 'schedules'}
        openStaff={() => go({view:'settings',panel:'staff'})}/>}
      {place.view === 'settings' && staffPanel && <StaffBoard key={place.item ?? 'list'} spaces={spaces} selected={place.item}
        select={item => go({view:'settings',panel:'staff',item})} openOrder={(workspace,delegation) => go({view:'workspace',workspace,delegation})}
        openEvidence={source => source.workspaceId && go({view:'workspace',workspace:source.workspaceId,delegation:source.orderId,
          ...source.sessionId && source.messageId && source.kind !== 'owner' ? {panel:'execution',session:source.sessionId,message:source.messageId} : {}})}
        openMembership={(workspace,item) => go({view:'workspace',workspace,panel:'staff',item})}/>}
      {place.view === 'people' && <WorkspacePeople selected={place.item} open={item => go({view:'people',item})}
        back={() => go({view:'people'},place.item)}/>}
      {place.view === 'calendar' && <WorkspaceCalendar selectedDate={place.date} selectDate={date => navigate({view:'calendar',date})}
        openDelegation={(workspace, delegation) => go({view:'workspace',workspace,delegation})}/>}
      {place.view === 'today' && <>
        <img className="v2-home-emblem" src={hubEmblem} width={420} height={420} alt="" aria-hidden="true"/>
        <section className="v2-liaison-card">
          <div><h2>接口人</h2><p>把想办的事交给我，或接着上次的对话。</p></div>
          <button className="v2-button primary" onClick={() => setPopup('liaison')}>打开对话<V2Icon name="next"/></button></section>
        <HistoryHome openLibrary={() => openHistory()} openItem={openHistory}/>
        <section className="v2-today" aria-label="我的工作区"><div className="v2-section-head"><h2>我的工作区</h2>
          <button className="v2-link" onClick={() => setPopup('new-space')}><V2Icon name="plus"/>创建工作区</button></div>
          <Issue text={index.error} retry={index.refresh}/>
          {index.data ? <TodaySpaces spaces={spaces} open={openWorkspace} showArchived={() => setPopup('switch-space')}/>
            : !index.error && <p role="status" className="v2-quiet">正在读取工作区…</p>}
        </section>
      </>}
      {place.view === 'workspace' && <Issue text={index.error} retry={index.refresh}/>}
      {place.view === 'workspace' && !index.data && !index.error && <p role="status" className="v2-quiet">正在读取工作区…</p>}
      {index.data && place.view === 'workspace' && (entering ? <p role="status" className="v2-quiet">正在打开…</p>
        : lostOrder ? <div className="v2-empty">这张工单已不可用。 <button className="v2-link" onClick={() => openWorkspace(workspace?.id)}>返回工作区</button></div>
        : !spaces.length || !place.workspace && !activeSpaces.length ? <section className="v2-welcome"><V2Icon name="work"/><h2>按项目整理会话和工单</h2>
          {spaces.length > 0 && <p>工作区都已归档，可在「切换工作区 → 已归档」查看或恢复。</p>}
          <button className="v2-button" onClick={() => setPopup('new-space')}><V2Icon name="plus"/>创建工作区</button></section>
        : lostWorkspace ? <div className="v2-empty">这份工作区已不可用。 <button className="v2-link" onClick={() => setPopup('switch-space')}>选择工作区</button></div>
        : <><Issue text={current.error} retry={current.refresh}/>
          {!view && !current.error && <p role="status" className="v2-quiet">正在读取会话和工单…</p>}
          {view && base && (panel ? <ConversationBoard key={view.workspace.id} base={base} view={view} selected={place.session} origin={place.delegation} sourceMessage={place.message}
            visible={setVisibleSession}
            open={id => openSession(id, delegation?.sessionId === id ? delegation.id : undefined)}
            target={(id,orderId) => openSession(id,orderId)} newOrder={newOrder}
            back={() => go({ view: 'workspace', workspace: chosenId, panel: 'execution' }, 'session-' + place.session)}
            openDelegation={openDelegation} create={() => setPopup('new-session')} changed={current.refresh}/>
            : outputsPanel ? <OutputsBoard key={view.workspace.id} base={base} feed={outputsFeed}/>
            : staffPanel || experiencePanel ? <StaffBoard key={view.workspace.id+'/'+place.panel+'/'+(place.item ?? 'list')}
              workspace={view} spaces={spaces} selected={place.item} experience={experiencePanel}
              select={item => go({view:'workspace',workspace:chosenId,panel:'staff',item})}
              openOrder={(workspace,delegation) => go({view:'workspace',workspace,delegation})}
              openEvidence={source => source.workspaceId && go({view:'workspace',workspace:source.workspaceId,delegation:source.orderId,
                ...source.sessionId && source.messageId && (source.kind !== 'owner' || view.sessions.some(session=>session.id === source.sessionId))
                  ? {panel:'execution',session:source.sessionId,message:source.messageId} : {}})}
              openMembership={(workspace,item) => go({view:'workspace',workspace,panel:'staff',item})}
              openGlobal={item=>go({view:'settings',panel:'staff',item})} openSchedules={openSchedules}
              assign={staff => newOrder(undefined,staff)}/>
            : place.delegation ? delegation ? <WorkOrderPage key={delegation.id} job={delegation} view={view} base={base} message={place.message}
              back={() => go({ view: 'workspace', workspace: chosenId }, 'job-' + delegation.id)}
              open={(id,message) => id === delegation.sessionId ? go({view:'workspace',workspace:chosenId,delegation:delegation.id,message}) : openSession(id, delegation.id, message)}
              openOrder={openDelegation} target={(id,orderId) => orderId ? openDelegation(orderId) : openSession(id)} newOrder={newOrder}
              popup={setPopup} changed={current.refresh}/>
              : null
            : <><ProjectDirectory key={view.workspace.id} workspace={view.workspace} changed={current.refresh}/>
              <RecentOutputs key={'outputs-' + view.workspace.id} base={base} feed={outputsFeed} showAll={openOutputs} openOrder={openDelegation}/>
              <Overview view={view} openJob={openDelegation} openSession={openSession} delegate={() => newOrder()} create={() => setPopup('new-session')}/>
              <ArchiveWorkspace key={view.workspace.id} workspace={view.workspace} personalId={personalId} done={async () => {
                const name = view.workspace.name
                go({view:'today'})
                setNotice('已归档「' + name + '」，可在「切换工作区 → 已归档」恢复。')
                await reread()
              }}/></>)}
        </>)}
      {notice && <p className="v2-feedback" role="status">{notice}</p>}
    </div></main>
    {popup === 'liaison' && <WorkspaceLiaison scope={scope} surface={place.view === 'profile' ? 'history' : place.view} workspace={selecting ? workspace : undefined}
      sessionId={liaisonSession ? liaisonSession.id : undefined} workOrderId={liaisonOrder || undefined}
      selectedId={place.view === 'people' ? place.item : place.view === 'calendar' ? place.date : selecting ? workspace.id : undefined} close={() => setPopup(undefined)} openProfileImport={openProfile}
      pending={(pendingCount > 0 || ownerActions.error) ? pendingList(true) : undefined}
      changed={index.refresh} openWorkspace={id => { void enterCreated({view:'workspace',workspace:id},index.refresh) }}
      openDelegation={(workspace, delegation) => { void enterCreated({view:'workspace',workspace,delegation}, async () => {
        await Promise.all([index.refresh(), workspace === chosenId && current.refresh()])
      }) }}
      openRoom={id => openHistory(historyItemId('room', id))} openSchedules={openSchedules}/>}
    {(popup === 'import' || popup === 'export') && <TransferDialog key={popup} mode={popup} close={() => setPopup(undefined)}
      openProfile={() => openProfile()} openLibrary={() => openHistory()}/>}
    {popup === 'switch-space' && <V2Dialog title="切换工作区" close={() => setPopup(undefined)}>
      <WorkspaceSwitcher spaces={spaces} current={selecting ? workspace.id : undefined} open={openWorkspace} create={() => setPopup('new-space')}/></V2Dialog>}
    {popup === 'new-space' && <CreateSpace close={() => setPopup(undefined)} done={id => enterCreated({ view: 'workspace', workspace: id }, index.refresh)}/>}
    {popup === 'delegate' && view && !archived && <CreateWorkOrder view={view} inSession={orderSession} staff={orderStaff} close={() => setPopup(undefined)}
      done={job => enterCreated(orderSession ? {view:'workspace',workspace:view.workspace.id,panel:'execution',session:orderSession,delegation:job.id}
        : {view:'workspace',workspace:view.workspace.id,delegation:job.id}, current.refresh)}/>}
    {popup === 'new-session' && view && base && !archived && <CreateSession base={base} view={view} close={() => setPopup(undefined)}
      done={id => enterCreated({ view: 'workspace', workspace: chosenId, panel: 'execution', session: id }, current.refresh)}/>}
    {(popup === 'narrow' || popup === 'cancel') && delegation && base && !archived && <ChangeDelegation action={popup} job={delegation} base={base} close={() => setPopup(undefined)}
      done={async () => { setPopup(undefined); setNotice(popup === 'narrow' ? '已记录新的执行范围。' : '工单已取消。'); await current.refresh() }}/>}
  </OwnerActions.Provider></ArchivedWorkspace.Provider>
}

/** The SuperHub mark in the header: a button back to the plain 「今天」 home (Enter and Space work as on any button). */
export function V2Brand({home}: {home: () => void}) {
  return <button type="button" className="v2-brand" aria-label="SuperHub 首页" onClick={home}><WorkspaceMark size={29}/>SuperHub</button>
}

function WorkspaceRow({space, open}: {space: V2Workspace; open: (id: string) => void}) {
  return <button type="button" className="v2-space-card" data-workspace-id={space.id} onClick={() => open(space.id)}>
    <WorkspaceIcon workspace={space}/>
    <span className="v2-space-description"><strong>{space.name}</strong>{space.goal && <small>{space.goal}</small>}
      {space.archivedAt && <small>已归档 · {archivedTime(space.archivedAt)}</small>}</span>
    <span className="v2-open">进入工作区<V2Icon name="next"/></span>
  </button>
}

/** When a workspace was archived, in the reader's own time zone (with the year: an archive can be old). */
const archivedTime = (at: string) => new Date(at).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

/** 「今天」's 「我的工作区」: the active workspaces. Archived ones wait under 「切换工作区 → 已归档」. */
export function TodaySpaces({ spaces, open, showArchived }: { spaces: V2Workspace[]; open: (id: string) => void; showArchived: () => void }) {
  const active = spaces.filter(space => !workspaceArchived(space))
  const archived = spaces.length - active.length
  if (active.length) return <div className="v2-space-grid">{active.map(space => <WorkspaceRow key={space.id} space={space} open={open}/>)}</div>
  return <p className="v2-empty">{archived ? '没有进行中的工作区。' : '还没有工作区。'}
    {archived > 0 && <> <button type="button" className="v2-link" onClick={showArchived}>查看已归档（{archived}）</button></>}</p>
}

/** 「切换工作区」: the active workspaces, then the archived ones folded under 「已归档（N）」 (open when the current one is archived). */
export function WorkspaceSwitcher({ spaces, current, open, create }: {
  spaces: V2Workspace[]; current?: string; open: (id: string) => void; create: () => void
}) {
  const active = spaces.filter(space => !workspaceArchived(space))
  const archived = spaces.filter(space => workspaceArchived(space))
  return <>
    {active.length ? <div className="v2-space-grid v2-rows">{active.map(space => <WorkspaceRow key={space.id} space={space} open={open}/>)}</div>
      : <p className="v2-quiet">没有进行中的工作区。</p>}
    {archived.length > 0 && <details className="v2-archived-spaces" open={archived.some(space => space.id === current) || undefined}>
      <summary>已归档（{archived.length}）</summary>
      <div className="v2-space-grid v2-rows">{archived.map(space => <WorkspaceRow key={space.id} space={space} open={open}/>)}</div>
    </details>}
    <button className="v2-button" onClick={create}><V2Icon name="plus"/>创建工作区</button>
  </>
}

/** Atop an archived workspace: since when, that it is read-only, and 「恢复」. */
export function ArchivedBanner({ workspace, restored }: { workspace: V2Workspace; restored: () => Promise<void> }) {
  const write = useV2Write()
  return <section className="v2-archived-banner" aria-label="工作区已归档">
    <div><strong>已归档{workspace.archivedAt && ' · ' + archivedTime(workspace.archivedAt)}</strong>
      <small>只读：工单、对话和交付照常可看；恢复后才能发言、开单或修改。</small></div>
    <button type="button" className="v2-button" disabled={write.busy} onClick={async () => {
      if (await write.post<Scoped & { workspace: V2Workspace }>(V2_ROOT + '/' + segment(workspace.id) + '/restore', {})) await restored()
    }}>{write.busy ? '正在恢复…' : '恢复'}</button>
    <Issue text={write.error}/>
  </section>
}

/**
 * 「归档工作区」 at the foot of the overview, with a confirmation; not offered for 「我的交办」 (`personalId`) or an
 * archived workspace. A refusal (unfinished orders, something running) is the host's own words, shown in the dialog.
 */
export function ArchiveWorkspace({ workspace, personalId, done }: { workspace: V2Workspace; personalId?: string; done: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const write = useV2Write()
  const archived = useArchived()
  if (archived || workspace.id === personalId) return null
  return <section className="v2-archive-workspace" aria-label="归档">
    <button type="button" className="v2-link" onClick={() => setConfirming(true)}>归档工作区</button>
    {confirming && <V2Dialog title="归档这个工作区？" meta={workspace.name} close={() => setConfirming(false)}>
      <p>归档后工作区只读，从「今天」收起，可随时在「切换工作区 → 已归档」恢复。</p>
      <p className="v2-quiet">工单、对话、交付、项目目录和幕僚都会原样保留。还有没完成、没取消的工单（含已暂停的）或正在运行的回合时不能归档。</p>
      <Issue text={write.error}/>
      <div className="v2-actions">
        <button type="button" className="v2-button primary" disabled={write.busy} onClick={async () => {
          const receipt = await write.post<Scoped & { workspace: V2Workspace }>(V2_ROOT + '/' + segment(workspace.id) + '/archive', {})
          if (receipt) { setConfirming(false); await done() }
        }}>{write.busy ? '正在归档…' : '确认归档'}</button>
        <button type="button" className="v2-link" onClick={() => setConfirming(false)}>取消</button>
      </div>
    </V2Dialog>}
  </section>
}

export function Overview({ view, openJob, openSession, delegate, create }: {
  view: V2WorkspaceView; openJob: (id: string) => void; openSession: (id: string) => void; delegate: () => void; create: () => void
}) {
  const archived = useArchived()
  return <section className="v2-work-orders" aria-label="会话与工单">
    <div className="v2-section-head"><h2><V2Icon name="chat"/>会话与工单</h2>
      {!archived && <div className="v2-actions"><button className="v2-link" onClick={create}>新建会话</button><button className="v2-button" onClick={delegate}>新建工单</button></div>}</div>
    {view.sessions.length ? <div className="v2-order-groups">{view.sessions.map(session => {
      const orders = view.orders.filter(order => order.sessionId === session.id)
      return <section key={session.id} className="v2-card" aria-label={session.title}>
        <button className="v2-row v2-order-session" data-focus={'session-' + session.id} onClick={() => openSession(session.id)}>
          <span className="v2-row-title"><strong>{session.title}</strong><V2Icon name="next"/></span>
          <small>{sessionKind(session)}{session.closed && ' · 已关闭'} · {orders.length} 张工单</small></button>
        {orders.map(order => <button data-focus={'job-' + order.id} className="v2-row v2-order-row" key={order.id} onClick={() => openJob(order.id)}>
          <span className="v2-row-title"><strong>{order.title}</strong><span className="v2-status">{delegationState(order)}</span></span>
          <small>{order.owner}{order.promise !== order.title && ' · ' + order.promise}</small>
          {order.status === 'done' ? <span className="v2-next" data-state="done">已完成{order.completedAt && ' · ' + readableTime(order.completedAt)}</span>
            : order.status === 'closed' ? order.reason && <span className="v2-next">{order.reason}</span>
            : order.nextCheckAt && <span className="v2-next">下次跟进 · {readableTime(order.nextCheckAt)}</span>}</button>)}
      </section>
    })}</div> : <div className="v2-empty">还没有会话或工单。</div>}
  </section>
}

/** The liaison's last acceptance review, as the order page states it. */
export function acceptanceState(row: V2Acceptance) {
  if (row.verdict === 'failed') return '未完成验收' + (row.reason ? '：' + row.reason : '')
  if (row.verdict === 'pass') return '已对照约定核对，达标 · ' + readableTime(row.at)
  const gaps = row.gaps?.length ? '：' + row.gaps.join('；') : ''
  return (row.awaitingOwner ? '追问后仍有缺口，等你决定' : row.reason ? '有缺口（' + row.reason + '）' : '有缺口，已追问执行者') + gaps
}

/** Wide enough for the conversation and the order's details side by side. */
export const ORDER_SIDE_PANEL_MIN = 960

/**
 * A work order opens as its conversation: the executor's dialogue is the main area. The order's terms, tier, results,
 * controls and records sit in a side panel on a wide workspace, and in a collapsible 「工单信息」 above the conversation
 * otherwise. Approval cards stay outside the fold so a waiting command is always visible.
 */
export function WorkOrderPage({ job, view, base, message, back, open, openOrder, target, newOrder, popup, changed, initialWide = false }: {
  job: V2Delegation; view: V2WorkspaceView; base: string; message?: string; back: () => void; open: (id: string, message?: string) => void
  openOrder: (id: string) => void; target: (sessionId: string, orderId?: string) => void; newOrder: (sessionId: string) => void
  popup: (value: Popup) => void; changed: () => Promise<void>
  /** Layout before the workspace width is measured. */
  initialWide?: boolean
}) {
  const page = useRef<HTMLElement>(null)
  const [wide, setWide] = useState(initialWide)
  useLayoutEffect(() => {
    const el = page.current?.closest<HTMLElement>('.wv2') ?? page.current
    if (!el) return
    const measure = () => setWide(el.clientWidth >= ORDER_SIDE_PANEL_MIN)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const session = view.sessions.find(s => s.id === job.sessionId)
  // A roster group's approval cards stand above its composer; the order keeps its command record here.
  const execution = session && (session.kind === 'coding' || session.engine === 'roster')
    && <OrderExecution key={job.id} base={base} job={job} session={session} cards={session.kind === 'coding'}/>
  const info = <OrderInfo job={job} view={view} base={base} open={open} popup={popup} changed={changed}/>
  return <section ref={page} className="v2-job v2-order-page" data-wide={wide}>
    <button className="v2-link" onClick={back}><V2Icon name="back"/>返回概览</button>
    {!wide && <details className="v2-order-fold"><summary>工单信息<small>{delegationState(job)}</small></summary>{info}</details>}
    {!wide && execution}
    <div className="v2-order-layout">
      <div className="v2-order-chat">{session ? <Transcript key={session.id + '/' + job.id} embedded base={base} session={session} view={view} origin={job.id}
        sourceMessage={message} compact={!wide} back={back} openDelegation={openOrder} target={target} newOrder={newOrder} changed={changed}/>
        : <div className="v2-empty">这张工单的会话暂不可用。</div>}</div>
      {wide && <aside className="v2-order-info" aria-label="工单信息"><h2>工单信息</h2>{execution}{info}</aside>}
    </div>
  </section>
}

function OrderInfo({ job, view, base, open, popup, changed }: {
  job: V2Delegation; view: V2WorkspaceView; base: string; open: (id: string, message?: string) => void;
  popup: (value: Popup) => void; changed: () => Promise<void>
}) {
  const action = useV2Write()
  const archived = useArchived()
  const decisions = view.decisions.filter(d => d.delegationId === job.id)
  const session = view.sessions.find(s => s.id === job.sessionId)
  const history = view.sessions.filter(s => s.id !== job.sessionId && job.historySessionIds?.includes(s.id))
  const paused = job.paused === true
  const [binding, setBinding] = useState(false)
  const gated = session?.kind === 'coding' || session?.engine === 'roster'
  const directory = gated ? view.directories?.[job.id] : undefined
  return <div className="v2-order-details">
    <section aria-label="工单约定"><h3>工单约定</h3>
      <dl className="v2-card v2-ledger">{[['负责人', job.owner], ['承诺结果', job.promise], ['状态', delegationState(job)],
        ...(job.status === 'closed' ? [['关闭原因', job.reason]] : job.status === 'done' ? [['完成时间', (job.completedAt ? readableTime(job.completedAt) : '')
          + (job.completedBy === 'owner-words' ? ' · 按你在对话中的话收单' : job.completedBy === 'owner' ? ' · 你已确认收单' : '')]]
          : job.nextCheckAt ? [['下次跟进',readableTime(job.nextCheckAt) + ' · 按周期安排']] : []),
        ...(!orderEnded(job) && job.reason ? [['当前情况', job.reason]] : []),
        ...(job.acceptance ? [['接口人验收', acceptanceState(job.acceptance)]] : []), ['执行范围', job.boundary],
        ...(gated ? [['运行目录', directoryText(directory)]] : []),
        ...(session ? [['所属会话', session.title + ' · ' + sessionKind(session) + (session.closed ? ' · 已关闭' : '')]] : [])].map(([label, value]) =>
          <div key={label}><dt>{label}</dt><dd>{value || '尚未登记'}</dd></div>)}</dl>
      {directory?.source === 'superhub' && !archived && <div className="v2-actions"><button className="v2-link" onClick={() => setBinding(true)}>绑定项目目录</button></div>}
      {binding && !archived && <DirectoryDialog workspace={view.workspace} close={() => setBinding(false)} changed={changed}/>}
      {job.status === 'done' && !archived && <div className="v2-actions">
          <button className="v2-button" disabled={action.busy} onClick={async () => { await action.post(base + '/orders/' + segment(job.id) + '/action', { action: 'reopen', expectedGeneration: job.generation }); await changed() }}>重新打开</button></div>}
      {!orderEnded(job) && !archived && <div className="v2-actions">
          <button className="v2-button primary" disabled={action.busy} onClick={async () => { await action.post(base + '/orders/' + segment(job.id) + '/action', { action: 'complete', expectedGeneration: job.generation, ...(job.hasSchedule && {stopSchedule: true}) }); await changed() }}>{job.hasSchedule ? '标为完成并停止周期安排' : '标为完成'}</button>
          <button className="v2-button" disabled={action.busy} onClick={async () => { await action.post(base + '/orders/' + segment(job.id) + '/action', { action: paused ? 'resume' : 'pause', expectedGeneration: job.generation }); await changed() }}>{paused ? '恢复工单' : '暂停工单'}</button>
          <button className="v2-button" onClick={() => popup('narrow')}>收窄范围</button><button className="v2-link" onClick={() => popup('cancel')}>取消工单</button></div>}
      <Issue text={action.error}/>
    </section>
    {gated && <OrderPermission key={job.id} base={base} job={job} changed={changed} archived={archived}/>}
    {session && <OrderOutputs job={job} base={base} sessions={[session,...history]}/>}
    {job.hasOriginal && <OrderOriginal key={job.id} path={base + '/orders/' + segment(job.id) + '/original'}/>}
    {decisions.length > 0 && <section className="v2-decisions"><h3>决定记录</h3>{decisions.map(d => <div className="v2-decision" key={d.id + '/' + d.version}><small>{readableTime(d.at)}</small><p>{d.text}</p></div>)}</section>}
    {session && <OrderFollowup base={base} job={job} session={session} openSource={open}/>}
    {history.length > 0 && <details className="v2-delivery-log"><summary>历史会话（{history.length}）</summary>
      {history.map(s => <button className="v2-row" key={s.id} onClick={() => open(s.id)}>{s.title}</button>)}</details>}
  </div>
}

function OrderOriginal({path}:{path:string}) {
  const [opened,setOpened] = useState(false)
  const query = useV2Read(opened ? path : undefined, isOrderOriginal)
  return <details className="v2-original v2-order-original" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>原始交办</summary><Issue text={query.error} retry={query.refresh}/>
    {query.data ? <>{!query.data.original.complete && <small>原单留存的片段</small>}<p>{query.data.original.text}</p></>
      : opened && !query.error && <p role="status">正在读取原话…</p>}</details>
}

function values(event: FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget) }
const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim()

function CreateSpace({ close, done }: { close: () => void; done: (id: string) => Promise<void> }) {
  const write = useV2Write()
  return <V2Dialog title="创建工作区" close={close}><form onSubmit={async event => {
    const data = values(event)
    const result = await write.post<Scoped & { workspace: V2Workspace }>(V2_ROOT, { name: field(data,'name'), goal: field(data,'goal'), owner: field(data,'owner') })
    if (result) await done(result.workspace.id)
  }}><label>工作区名称<input name="name" required maxLength={160} placeholder="例如，产品研发"/></label>
    <label>当前目标（选填）<textarea name="goal" maxLength={4000} placeholder="你希望团队达成什么结果？"/></label>
    <label>负责人<input name="owner" required maxLength={160} defaultValue="我"/></label><Issue text={write.error}/>
    <button className="v2-button primary" disabled={write.busy}>{write.busy ? '正在创建…' : '创建并进入'}</button></form></V2Dialog>
}

function CreateWorkOrder({ view, inSession, staff, close, done }: {
  view: V2WorkspaceView; inSession?: string; staff?: StaffMember; close: () => void; done: (order: V2Delegation) => Promise<void>
}) {
  const write = useV2Write()
  const [pickingStaff,setPickingStaff] = useState(false)
  const [pickedId,setPickedId] = useState('')
  const roster = useV2Read(pickingStaff ? staffPath(view.workspace.id) : undefined,isStaffView)
  const assigned = staff ?? roster.data?.members.find(m => m.id === pickedId)
  const available = view.sessions.filter(s => !s.closed && (!assigned || s.executor === 'dsh'))
  const existing = available.find(s => s.id === inSession)
  return <V2Dialog title="新建工单" meta={existing?.title ?? view.workspace.name} close={close}><form onSubmit={async event => {
    const data = values(event)
    const title = field(data,'title')
    const sessionId = inSession || field(data,'session')
    const result = await write.post<Scoped & { order: V2Delegation }>(V2_ROOT + '/' + segment(view.workspace.id) + '/orders', {
      title, promise: field(data,'promise') || title, owner: assigned?.name ?? (field(data,'owner') || '接口人'), ...(assigned && {staffId:assigned.id}),
      ...(sessionId && {sessionId}),
    })
    if (result) await done(result.order)
  }}>
    <label>你想交办什么？<textarea name="title" required maxLength={500} placeholder="写下希望团队完成的事"/></label>
    <label>承诺结果<input name="promise" maxLength={8000} placeholder="可补充怎样才算完成"/></label>
    {!staff && !inSession && available.length > 0 && <label>所属会话<select name="session" defaultValue=""><option value="">新建会话</option>
      {available.map(s => <option value={s.id} key={s.id}>{s.title}</option>)}</select></label>}
    <label>负责人<input key={assigned?.id ?? 'free'} name="owner" defaultValue={assigned?.name} readOnly={!!assigned} maxLength={160} placeholder="接口人"/></label>
    {!staff && (!existing || existing.executor === 'dsh') && <details className="v2-settings-fold" onToggle={e=>{if (e.currentTarget.open) setPickingStaff(true)}}>
      <summary>从本区幕僚中选择</summary><Issue text={roster.error} retry={roster.refresh}/>
      {roster.data && (roster.data.members.length ? <label>指派幕僚<select value={pickedId} onChange={e=>setPickedId(e.target.value)}>
        <option value="">自行填写负责人</option>{roster.data.members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        : <p>可在工作区的「幕僚」页邀请一位幕僚。</p>)}</details>}
    <Issue text={write.error}/>
    <button className="v2-button primary" disabled={write.busy || !!inSession && !existing || !!pickedId && !assigned}>{write.busy ? '正在交办…' : '交给团队'}</button></form></V2Dialog>
}

/** Every new conversation is a group of the owner, the liaison and the workspace's staff: there is no executor to choose. */
export function CreateSession({ base, view, close, done }: { base: string; view: V2WorkspaceView; close: () => void; done: (id: string) => Promise<void> }) {
  const write = useV2Write()
  return <V2Dialog title="新建会话" meta={view.workspace.name} close={close}><form onSubmit={async event => {
    const data = values(event)
    // `kind` keeps an older host on its group path; the group engine ignores it.
    const result = await write.post<Scoped & { session: V2Session }>(base + '/sessions', { title: field(data,'title'), kind: 'group', executor: 'dsh' })
    if (result) await done(result.session.id)
  }}><label>会话名称<input name="title" required maxLength={300} placeholder="这场会话要聊什么？"/></label>
    <p className="v2-quiet">新会话是一场群聊：你、接口人和本工作区的幕僚都在里面。没有 @ 人的话先交给接口人；写 @名字 直接叫那位成员。</p>
    <Issue text={write.error}/><button className="v2-button primary" disabled={write.busy}>{write.busy ? '正在创建…' : '创建会话'}</button></form></V2Dialog>
}

function ChangeDelegation({ action, job, base, close, done }: { action: 'narrow'|'cancel'; job: V2Delegation; base: string; close: () => void; done: () => Promise<void> }) {
  const write = useV2Write()
  const [generation] = useState(job.generation)
  const narrow = action === 'narrow'
  return <V2Dialog title={narrow ? '收窄执行范围' : '取消这张工单？'} meta={job.title} close={close}><form onSubmit={async event => {
    const data = values(event)
    const result = await write.post(base + '/orders/' + segment(job.id) + '/action', { action, expectedGeneration: generation,
      ...(narrow ? { boundary: field(data,'detail') } : { reason: field(data,'detail') || '由你取消' }) })
    if (result) await done()
  }}>{!narrow && <p>后续执行会停止，已经发生的工作仍可查看。</p>}
    <label>{narrow ? '新的执行范围' : '取消原因（选填）'}<textarea name="detail" required={narrow} maxLength={narrow ? 4000 : 2000}/></label>
    <Issue text={write.error}/><button className="v2-button primary" disabled={write.busy}>{narrow ? '保存范围' : '确认取消工单'}</button></form></V2Dialog>
}
