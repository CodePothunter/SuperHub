import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { messageWorkOrder, orderEnded, type V2Attachment, type V2AttachmentRef, type V2Delegation, type V2Delivery, type V2Held, type V2Message, type V2Session, type V2WorkspaceView } from '../core/workspace-v2.ts'
import { Markdown } from './markdown.tsx'
import type { Scoped } from './superhub-api.ts'
import { segment, useV2PagedRead, useV2Read, useV2Write, V2Client } from './workspace-v2-api.ts'
import { NewerEdge, OlderEdge, historyEdgeStyle } from './history-edge.tsx'
import { MESSAGE_ROW, scrollParent, useEdgeSentinel, usePrependAnchor } from './scroll-anchor.ts'
import { ARCHIVED_NOTE, executorName, Issue, readableTime, sessionKind, useArchived, V2Dialog, V2Icon } from './workspace-v2-elements.tsx'
import { isAttachmentView, isSessionView, type SessionLine, type SessionView } from './workspace-v2-response.ts'
import { ChatAvatar, chatAvatarStyle, usePortraitArrivals } from './workspace-chat-avatar.tsx'
import { SessionExecution } from './workspace-execution.tsx'
import { GroupDeliveries, GroupRoster, GroupStatus, MemberBadges, MentionMenu, mentionDecorator, useMentionMenu } from './workspace-group.tsx'
import { ChatComposer, MessageInputAttachments, useChatAttachments } from './chat-attachments.tsx'
import { OwnerActionReply, OwnerActions } from './workspace-owner-actions.tsx'
import type { OwnerAction } from '../core/workspace-engagement.ts'

interface BoardProps {
  base: string; view: V2WorkspaceView; selected?: string; origin?: string; sourceMessage?: string
  open: (id: string) => void; back: () => void; openDelegation: (id: string) => void; create: () => void; changed: () => Promise<void>
  target: (sessionId: string, orderId?: string) => void; newOrder: (sessionId: string) => void
  visible: (sessionId?: string) => void
}

export function ConversationBoard({ base, view, selected, origin, sourceMessage, open, back, openDelegation, target, newOrder, visible, create, changed }: BoardProps) {
  const board = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(true)
  const [defaultId, setDefaultId] = useState(view.sessions[0]?.id)
  const archived = useArchived()
  useLayoutEffect(() => {
    const el = board.current?.closest<HTMLElement>('.wv2') ?? board.current
    if (!el) return
    const measure = () => setCompact(el.clientWidth <= 740)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const desktopDefault = view.sessions.find(s => s.id === defaultId) ?? view.sessions[0]
  useEffect(() => { setDefaultId(desktopDefault?.id) }, [desktopDefault?.id])
  const session = selected ? view.sessions.find(s => s.id === selected) : compact ? undefined : desktopDefault
  useLayoutEffect(() => {
    visible(session?.id)
    return () => visible(undefined)
  },[session?.id,visible])
  return <div ref={board} className="v2-talk-board" data-compact={compact}>
    <nav hidden={compact && !!selected} className="v2-card v2-directory" aria-label="执行会话列表"><div className="v2-section-head"><h2>会话</h2>
      {!archived && <button className="v2-link" onClick={create}>新建会话</button>}</div>
      {view.sessions.length ? view.sessions.map(s =>
        <button key={s.id} data-focus={'session-' + s.id} className="v2-thread" aria-current={s.id === session?.id ? 'true' : undefined} onClick={() => open(s.id)}>
          <span className="v2-symbol"><V2Icon name={s.kind === 'group' ? 'group' : 'chat'}/></span>
          <span><strong>{s.title}</strong><small>{sessionKind(s)}{s.closed && ' · 已关闭'}</small></span>
        </button>) : <p className="v2-quiet">这个工作区还没有会话。</p>}
    </nav>
    {session ? <Transcript key={session.id + '/' + (origin ?? (session.delegationIds.length === 1 ? session.delegationIds[0] : ''))} base={base} session={session} view={view} origin={origin} compact={compact} back={back}
      target={target} newOrder={newOrder} openDelegation={openDelegation} changed={changed} sourceMessage={sourceMessage}/>
      : selected ? <div className="v2-empty">这场会话已不可用。 <button className="v2-link" onClick={back}>返回会话列表</button></div>
      : !compact && (archived ? <section className="v2-empty"><p>{ARCHIVED_NOTE}</p></section>
        : <section className="v2-empty"><strong>开一场群聊</strong><p>你、接口人和本工作区的幕僚在群里一起干活，写 @名字 叫人。</p></section>)}
  </div>
}

/** What happened to owner words sent while the executor worked. */
export const deliveryNote: Record<V2Delivery, string> = {
  steered: '已送进当前一轮', pending: '正在送达当前一轮', queued: '已排到下一轮', unsent: '未送达', unknown: '送达结果待核对',
}
/** Owner words the liaison held back from the executor. */
export const heldNote: Record<V2Held, string> = {
  choosing: '待你选择 · 还没有发给执行者', completed: '已按这句话收单 · 没有发给执行者', kept: '没有发给执行者',
}
const doneNote = { complete: '已收单', reopen: '已撤销，工单已重新打开', forward: '已交给执行者' }

/**
 * The choices on a liaison message: complete the order, undo a completion, or hand held words to the executor. A taken
 * choice stays as a note; a choice the order's current state does not allow is shown disabled.
 */
export function MessageChoices({ message, order, base, path, done }: {
  message: V2Message; order?: V2Delegation; base: string; path: string; done: () => Promise<void>
}) {
  const write = useV2Write()
  const archived = useArchived()
  const actions = message.actions ?? []
  const taken = actions.find(action => action.done)
  if (taken?.done) return <p className="v2-choice-done" role="status"><V2Icon name="next"/>{doneNote[taken.kind]} · {readableTime(taken.done.at)}</p>
  const allowed = (kind: string) => !!order && !archived && (kind === 'reopen' ? order.status === 'done' : !orderEnded(order) && (kind !== 'forward' || !order.paused))
  return <div className="v2-choices" role="group" aria-label="接口人给出的选项">
    {actions.map(action => <button key={action.kind} type="button" className={'v2-button' + (action.kind === 'complete' ? ' primary' : '')}
      disabled={write.busy || !allowed(action.kind)} onClick={async () => {
        if (!order) return
        const receipt = action.kind === 'forward'
          ? await write.post(path + '/messages/' + segment(action.messageId ?? '') + '/forward', {})
          : await write.post(base + '/orders/' + segment(order.id) + '/action', {action: action.kind, from: message.id, ...(action.stopSchedule && {stopSchedule: true})})
        if (receipt) await done()
      }}>{action.label}</button>)}
    {!actions.some(action => allowed(action.kind)) && <small className="v2-quiet">{archived ? '工作区已归档' : order?.status === 'done' ? '工单已完成' : order && orderEnded(order) ? '工单已关闭' : '当前状态下不可用'}</small>}
    <Issue text={write.error}/>
  </div>
}

export interface TranscriptProps {
  base: string; session: V2Session; view: V2WorkspaceView; origin?: string; sourceMessage?: string; compact: boolean; back: () => void
  openDelegation: (id: string) => void; changed: () => Promise<void>
  target: BoardProps['target']; newOrder: BoardProps['newOrder']
  /** Shown inside the work order's own page: the order's details live next to it, not in this conversation. */
  embedded?: boolean
}

export function Transcript({ base, session, view, origin, sourceMessage, compact, back, openDelegation, target, newOrder, changed, embedded }: TranscriptProps) {
  const { scope, revoke } = useContext(V2Client)
  const ownerActions = useContext(OwnerActions)
  const path = base + '/sessions/' + segment(session.id)
  // Paged: the newest page first (or the page around a linked message), older pages as the top comes near.
  const following = useRef(!sourceMessage)
  const paged = useV2PagedRead<SessionView, SessionLine>(path, isSessionView, {
    interval: 4000, anchor: sourceMessage, following: () => following.current,
    // Portraits come with the speakers of each page; keep those of the pages already shown.
    combine: (previous, next) => ({...next, ...(previous?.portraits || next.portraits) && {portraits: {...previous?.portraits, ...next.portraits}}}),
  })
  const transcript = { error: paged.error, refresh: paged.refresh }
  const result = paged.view?.session.id === session.id && paged.view.session.workspaceId === view.workspace.id ? {...paged.view, messages: paged.messages} : undefined
  const write = useV2Write(), sessionAction = useV2Write(), stopWait = useV2Write(), stopMembers = useV2Write()
  // Archived: the conversation reads as before, but nothing here writes (composer, choices, close, reopen, new order).
  const archived = useArchived()
  const prefix = useId()
  const jobs = view.orders.filter(j => j.sessionId === session.id)
  const hadOrigin = origin ? view.orders.find(j => j.id === origin) : undefined
  const job = origin ? jobs.find(j => j.id === origin) : jobs.length === 1 ? jobs[0] : undefined
  const readOnlySource = !!origin && !job
  const inputTarget = {workspaceId:session.workspaceId, sessionId:session.id}
  const files = useChatAttachments(scope, session.engine === 'roster' ? {...inputTarget, workOrderId:job?.id} : undefined, undefined, revoke)
  const sessionDraft = 'superhub-v2:draft:' + scope + ':' + session.workspaceId + ':' + session.id
  const draftKey = sessionDraft + ':' + (job?.id ?? 'discussion')
  const usesPreviousDraft = job?.id === session.legacyMessageOrder?.id
  const [draft, setDraft] = useState(() => {
    try { return sessionStorage.getItem(draftKey) ?? (usesPreviousDraft && sessionStorage.getItem(sessionDraft) || '') }
    catch { return '' }
  })
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const [attachment, setAttachment] = useState<{ message: string; ref: V2AttachmentRef }>()
  const [confirmClose, setConfirmClose] = useState(false)
  const edit = (value: string) => {
    setDraft(value)
    try {
      if (value) sessionStorage.setItem(draftKey,value)
      else sessionStorage.removeItem(draftKey)
      if (usesPreviousDraft) sessionStorage.removeItem(sessionDraft)
    } catch { /* Draft still lives in this view. */ }
  }
  const closed = session.closed || result?.session.closed
  const messages = result?.messages ?? []
  // A group on the group engine: members, their status, the @ menu and mention chips.
  const group = session.engine === 'roster' ? result?.group : undefined
  const mention = useMentionMenu(group && !closed && !readOnlySource && !archived ? group.members : undefined, draft, edit)
  const memberBySpeaker = new Map(group?.members.map(member => [member.speakerId, member]))
  const history = useRef<HTMLDivElement>(null)
  const scroller = useCallback(() => scrollParent(history.current), [])
  const top = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null)
  const capture = usePrependAnchor(scroller, history, messages[0]?.id)
  const loadOlder = () => void paged.loadOlder(capture)
  // A page appended below while catching up is read where it is, not followed to its end.
  const appending = useRef(false)
  const loadNewer = () => void paged.loadNewer(() => { appending.current = true })
  useEdgeSentinel(top, scroller, 'top', paged.hasOlder && paged.older === 'idle' && !paged.jumping, loadOlder, messages.length)
  useEdgeSentinel(bottom, scroller, 'bottom', paged.hasNewer && paged.newer === 'idle' && !paged.jumping, loadNewer, messages.length)
  /** Bring the newest message (and the composer under it) into view. */
  const showLatest = useCallback(() => {
    const list = history.current, rows = list?.querySelectorAll(MESSAGE_ROW)
    const last = rows?.[rows.length - 1]
    if (!list || !last) return
    const container = scrollParent(list)
    const target = list.parentElement?.querySelector('.v2-compose') ?? last
    const shift = target.getBoundingClientRect().bottom - (container ? container.getBoundingClientRect().bottom : window.innerHeight)
    if (shift <= 0) return
    if (container) container.scrollTop += shift
    else window.scrollBy(0, shift)
  }, [])
  // Following: the newest message is (nearly) in view. New messages then keep it in view; reading further up stays put.
  useEffect(() => {
    const container = scroller()
    const target: HTMLElement | Window = container ?? window
    const track = () => {
      const rows = history.current?.querySelectorAll(MESSAGE_ROW)
      const last = rows?.[rows.length - 1]
      if (!last) return
      following.current = last.getBoundingClientRect().bottom - (container ? container.getBoundingClientRect().bottom : window.innerHeight) < 60
    }
    target.addEventListener('scroll', track, {passive: true})
    return () => target.removeEventListener('scroll', track)
  }, [scroller, !!result])
  const lastId = messages.at(-1)?.id
  const positioned = useRef(false)
  useLayoutEffect(() => {
    if (!lastId) return
    const skip = appending.current || paged.hasNewer
    appending.current = false
    // On opening, the newest message shows (a linked message is centred by its own effect below).
    if (!positioned.current) { positioned.current = true; if (!sourceMessage) showLatest(); return }
    if (following.current && !skip) showLatest()
  }, [lastId])
  usePortraitArrivals(history, path + (closed ? '/closed' : '/open'), readOnlySource ? undefined : result?.messages, result?.observedAt)
  const byId = new Map(messages.map(m => [m.id, m]))
  const requested = sourceMessage ? byId.get(sourceMessage) : undefined
  const anchoredId = requested && (!origin || job && messageWorkOrder(session, requested) === job.id) ? requested.id : undefined
  const actionsByMessage = new Map<string, OwnerAction[]>()
  // What still waits for the owner is never hidden by paging: questions and choices anchored to a message outside the
  // loaded pages stand at the end of the conversation until their message is loaded, then only inline.
  const partial = paged.hasOlder || paged.hasNewer
  const elsewhere = new Map<string, {message?: V2Message; actions: OwnerAction[]}>()
  if (partial && !readOnlySource) for (const message of result?.pinned ?? []) if (!byId.has(message.id)) elsewhere.set(message.id, {message, actions: []})
  if (!closed && !readOnlySource && !archived) {
    for (const action of ownerActions.items) {
      if (action.workspaceId !== session.workspaceId || action.sessionId !== session.id) continue
      const message = byId.get(action.messageId)
      if (!message) {
        if (!partial) continue
        const row = elsewhere.get(action.messageId)
        if (row) row.actions.push(action)
        else elsewhere.set(action.messageId, {actions: [action]})
        continue
      }
      if (messageWorkOrder(session, message) !== action.orderId) continue
      const items = actionsByMessage.get(action.messageId)
      if (items) items.push(action)
      else actionsByMessage.set(action.messageId, [action])
    }
  }
  useEffect(() => {
    if (!anchoredId) return
    following.current = false
    const node = document.getElementById(prefix + anchoredId)
    node?.focus({ preventScroll:true })
    node?.scrollIntoView({ block:'center' })
  }, [anchoredId, prefix])
  // A quoted (or pending) message outside the loaded pages: load the page around it, then move to it.
  const [quoteTarget, setQuoteTarget] = useState<string>()
  const quoteLoaded = !!quoteTarget && byId.has(quoteTarget)
  useEffect(() => {
    if (!quoteTarget || paged.jumping) return
    if (quoteLoaded) { following.current = false; focusMessage(quoteTarget) }
    setQuoteTarget(undefined)
  }, [quoteTarget, quoteLoaded, paged.jumping])
  const locate = (id: string) => { setQuoteTarget(id); void paged.jumpTo(id) }
  const authors = [...new Set(messages.map(m => m.author))]
  // Words said into a running turn use no budget, so the last turn of an order can still take them.
  const blocked = job && (job.paused || orderEnded(job) || job.remainingTurns === 0 && !result?.working)
  const canReopen = closed && !readOnlySource && !archived && (job ? [job] : jobs).some(row =>
    !orderEnded(row) && !row.paused && row.remainingTurns > 0)
  const dayTime = (at: string) => new Date(at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
  const anchored = attachment && byId.get(attachment.message)?.attachments?.some(a => a.id === attachment.ref.id)
  useEffect(() => { if (attachment && !anchored && result) setAttachment(undefined) }, [attachment, anchored, result])
  function focusMessage(id: string) {
    const node = document.getElementById(prefix + id)
    node?.focus({ preventScroll: true }); node?.scrollIntoView({ block: 'center' })
  }
  async function dispatch() {
    if (!files.canSend(draft) || !result || closed || blocked || readOnlySource || archived) return
    const sent = draft
    following.current = true
    if (paged.hasNewer) void paged.toLatest()
    // The host answers once the words are with the executor (or queued), so the composer is free again right away.
    const receipt = await write.post<Scoped & { session: V2Session }>(path + '/messages', { text: sent, ...(job && { workOrderId:job.id }), wait: false,
      ...(files.ready.length > 0 && {inputAttachments:files.ready.map(row => row.id)}) })
    // Keep whatever the owner typed while the words were on their way.
    if (receipt?.session.id === session.id) {
      if (sent && latestDraft.current.startsWith(sent)) edit(latestDraft.current.slice(sent.length).trimStart())
      files.sent()
    }
    await Promise.all([transcript.refresh(), changed()])
  }
  const working = !!result?.working && !closed && !blocked && !group
  const waiting = !closed ? result?.waiting : undefined
  return <section className="v2-card v2-reader" aria-label={session.title}>
    <style>{chatAvatarStyle + historyEdgeStyle}</style>
    <header><div className="v2-chat-context">
      {compact && !embedded && <button className="v2-link" onClick={back}><V2Icon name="back"/>返回会话列表</button>}
      {hadOrigin && !embedded && <button className="v2-link" onClick={() => openDelegation(hadOrigin.id)}>返回工单</button>}
    </div><h2 data-conversation-title tabIndex={-1}>{session.title}</h2>
      <div className="v2-chat-meta">{sessionKind(session)}{group ? ' · 你和 ' + group.members.length + ' 位成员'
        : session.kind === 'group' && session.engine !== 'roster' && authors.length > 0 && ' · ' + authors.join('、')}{closed && ' · 已关闭'}</div>
      {job?.status === 'waiting' && job.reason && <p className="v2-order-wait-reason" role="status">{job.reason}</p>}
      {group && <GroupRoster members={group.members} portraits={result?.portraits}/>}</header>
    <div className="v2-chat-history" ref={history}>
      <Issue text={transcript.error} retry={transcript.refresh}/>
      {result?.issue && <div className="v2-source-status" role="status">{result.issue}</div>}
      {result && sourceMessage && !anchoredId && !paged.jumping && <p className="v2-source-status" role="status">{origin ? '这条工单原话当前不可读。' : '这条原话当前不可读。'}</p>}
      {!result && !transcript.error && <p role="status" className="v2-quiet">正在读取会话…</p>}
      {result && !messages.length && !result.issue && <div className="v2-empty"><strong>这场会话还没有可读的发言</strong><p>{closed ? '会话已关闭。' : archived ? ARCHIVED_NOTE : '在下方发出第一句话。'}</p></div>}
      {result && <OlderEdge edge={top} hasOlder={paged.hasOlder} loading={paged.older === 'loading'} error={paged.olderError} count={messages.length} load={loadOlder}/>}
      {messages.length > 0 && <ol className="v2-turns" aria-label="会话发言">{messages.map((m, i) => {
        const day = dayTime(m.at), quoted = m.replyTo && byId.get(m.replyTo)
        const orderId = messageWorkOrder(session, m)
        // A group tags every line said for an order (except on that order's own page, where all of them are).
        const messageOrder = orderId && (group ? !(embedded && jobs.length === 1) : jobs.length > 1) ? jobs.find(row => row.id === orderId) : undefined
        const clock = new Date(m.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false})
        const dateLine = (i === 0 || day !== dayTime(messages[i-1]!.at)) && <div className="v2-date">{day}</div>
        if (m.kind === 'event') return <li key={m.id} id={prefix + m.id} data-message-id={m.id} data-event={m.event} className="v2-group-event" tabIndex={-1}>
          {dateLine}<p><time dateTime={m.at}>{clock}</time><span>{m.text}</span></p>
          {messageOrder && <button className="v2-link v2-order-tag" onClick={() => openDelegation(messageOrder.id)}><V2Icon name="work"/>{messageOrder.title}</button>}</li>
        const member = m.speakerId ? memberBySpeaker.get(m.speakerId) : undefined
        const progress = m.kind === 'progress'
        return <li key={m.id} id={prefix + m.id} data-message-id={m.id} data-kind={m.kind} className={m.id === anchoredId ? 'v2-source-turn' : undefined} tabIndex={-1}>
          {dateLine}
          <div className={'v2-turn ' + (m.role === 'user' ? 'mine' : '') + (progress ? ' progress' : '')}><ChatAvatar portrait={m.speakerId ? result?.portraits?.[m.speakerId] : undefined}/>
            <div className="v2-message"><div className="v2-byline"><strong>{m.author}</strong>{member && <MemberBadges member={member}/>}
              {progress && <span className="v2-progress-tag">进行中</span>}<time dateTime={m.at}>{clock}</time></div>
              {messageOrder && <button className={group ? 'v2-link v2-order-tag' : 'v2-link'} onClick={() => openDelegation(messageOrder.id)}>{group && <V2Icon name="work"/>}{messageOrder.title}</button>}
              <div className="v2-bubble">
                {quoted ? <button className="v2-quote" onClick={() => focusMessage(quoted.id)}>回复{quoted.author} · {quoted.text}</button>
                  : m.replyTo && (paged.hasOlder ? <button className="v2-quote" onClick={() => locate(m.replyTo!)}>回复更早的一条发言 · 查看</button>
                    : <small className="v2-quote">被回复的原话当前不可读</small>)}
                {m.relayed && <small className="v2-relay-note">经接口人转交的原话</small>}
                <Markdown text={m.text} className="v2-markdown" decorate={group ? mentionDecorator(m.mentions, group.members, result?.portraits) : undefined}/>
                <MessageInputAttachments scope={scope} target={{...inputTarget, workOrderId:orderId}} attachments={m.inputAttachments}/>
                {m.quote && <details className="v2-relay-quote"><summary>{m.quote.label}</summary><div className="v2-relay-text">{m.quote.text}</div></details>}
                {m.attachments?.map(ref => <button key={ref.id} className="v2-link v2-attachment" onClick={() => setAttachment({message:m.id,ref})}><V2Icon name="box"/>{ref.label}</button>)}
              </div>
              {m.delivery && <small className="v2-delivery-note" data-delivery={m.delivery}>{deliveryNote[m.delivery]}</small>}
              {group && <GroupDeliveries deliveries={m.deliveries} members={group.members}/>}
              {m.held && <small className="v2-delivery-note v2-held-note" data-held={m.held}>{heldNote[m.held]}</small>}
              {m.actions?.length && !readOnlySource ? <MessageChoices message={m} order={jobs.find(row => row.id === orderId)} base={base} path={path}
                done={async () => { await Promise.all([transcript.refresh(), changed()]) }}/> : null}
              {actionsByMessage.get(m.id)?.map(item => <OwnerActionReply key={item.id} item={item} showQuestion={m.text.trim() !== item.question}
                changed={async () => { await Promise.all([ownerActions.refresh(), transcript.refresh(), changed()]) }}/>)}
            </div></div></li>
      })}</ol>}
      {elsewhere.size > 0 && <section className="v2-pending-elsewhere" aria-label="等你处理的事（原话不在已加载的消息里）">
        <h3>等你处理</h3>
        {[...elsewhere].map(([id, {message, actions}]) => <div key={id} className="v2-pending-item" data-pending-for={id}>
          {message && <p className="v2-pending-source"><strong>{message.author}</strong> · {message.text.replace(/\s+/g, ' ').slice(0, 120)}</p>}
          <button type="button" className="v2-link" disabled={!!paged.jumping} onClick={() => locate(id)}>定位到原话</button>
          {message?.actions?.length ? <MessageChoices message={message} order={jobs.find(row => row.id === messageWorkOrder(session, message))} base={base} path={path}
            done={async () => { await Promise.all([transcript.refresh(), changed()]) }}/> : null}
          {actions.map(item => <OwnerActionReply key={item.id} item={item} showQuestion
            changed={async () => { await Promise.all([ownerActions.refresh(), transcript.refresh(), changed()]) }}/>)}
        </div>)}
      </section>}
      <NewerEdge edge={bottom} hasNewer={paged.hasNewer} loading={paged.newer === 'loading'} error={paged.newerError} load={loadNewer}
        latest={() => { following.current = true; void paged.toLatest() }}/>
    </div>
    {archived && !readOnlySource && <p className="v2-quiet v2-archived-note">{ARCHIVED_NOTE}</p>}
    {!closed && !readOnlySource && !archived && <div className="v2-compose">{jobs.length > 1 && <label>发言对象<select value={job?.id ?? ''} onChange={event => target(session.id,event.target.value || undefined)}>
      <option value="">会话讨论</option>{jobs.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>}
    <form onSubmit={event => { event.preventDefault(); void dispatch() }}>
      {job && jobs.length === 1 && !embedded && <p className="v2-quiet">当前工单 · {job.title}</p>}
      {working && <p className="v2-working" role="status">对方正在工作，你的话会立即送达</p>}
      {group && result && <GroupStatus path={path} group={group} portraits={result.portraits} now={result.observedAt ?? Date.now()}
        stop={stopMembers} refresh={async () => { await Promise.all([transcript.refresh(), changed()]) }}/>}
      {waiting && <div className="v2-waiting" role="status"><span>等待『{waiting.title}』完成后开始下一轮（同一项目目录一次只运行一张工单）。现在说的话会一起排到下一轮，开始时一并送达。</span>
        <button type="button" className="v2-link" disabled={stopWait.busy} onClick={async () => {
          await stopWait.post<Scoped & { session: V2Session }>(path + '/stop-waiting', {})
          await Promise.all([transcript.refresh(), changed()])
        }}>叫停</button></div>}
      <Issue text={stopWait.error}/>
      <div className="v2-mention-field">
        {mention.open && <MentionMenu id={mention.listId} options={mention.options} active={mention.active} portraits={result?.portraits} pick={mention.pick}/>}
        <ChatComposer draft={files} text={draft} sending={write.busy} disabled={!result || !!blocked}
          status={blocked ? job.title + ' · ' + (job.status === 'done' ? '工单已完成，重新打开后可继续' : job.status === 'closed' ? '工单已关闭' : job.paused ? '工单已暂停' : '本次额度已用完') : undefined}>
          <textarea ref={mention.field} rows={1} aria-label="发言" placeholder={group ? '在群里说点什么，输入 @ 叫人…' : session.kind === 'group' ? '在群里说点什么…' : '对 ' + executorName[session.executor] + ' 说…'}
            value={draft} disabled={!result || !!blocked} maxLength={64000}
            {...group && {'aria-autocomplete': 'list' as const, 'aria-controls': mention.open ? mention.listId : undefined, 'aria-activedescendant': mention.activeId}}
            onChange={event => { edit(event.target.value); mention.track(event.currentTarget) }}
            onSelect={event => mention.track(event.currentTarget)} onBlur={mention.close}
            onKeyDown={event => {
              if (mention.keyDown(event)) return
              if (!event.nativeEvent.isComposing && event.key==='Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
            }}/>
        </ChatComposer>
      </div>
      <Issue text={write.error}/>
    </form></div>}
    {session.kind === 'coding' && !readOnlySource && !embedded && <SessionExecution key={session.id} base={base} session={session}/>}
    {/* A group's commands outside any order, per member; their approval cards already stand above the composer. */}
    {group && !readOnlySource && !embedded && <SessionExecution key={session.id} base={base} session={session} members={group.members}/>}
    {readOnlySource && <p className="v2-quiet">{hadOrigin?.historySessionIds?.includes(session.id) ? '这场历史会话仅供查看。' : '所选工单不属于这场会话。'}</p>}
    <footer className="v2-chat-foot">{jobs.filter(j => !embedded || j.id !== job?.id).map(j => <button key={j.id} className="v2-link" onClick={() => openDelegation(j.id)}><V2Icon name="work"/>打开工单「{j.title}」</button>)}
      {!closed && !readOnlySource && !archived && <button className="v2-link" onClick={() => newOrder(session.id)}>新建工单</button>}
      {canReopen && <button className="v2-button" disabled={sessionAction.busy} onClick={async () => {
        await sessionAction.post(path + '/reopen', {})
        await Promise.all([transcript.refresh(), changed()])
      }}>恢复会话</button>}
      {!closed && !readOnlySource && !archived && <button className="v2-link v2-close-chat" disabled={sessionAction.busy} onClick={() => setConfirmClose(true)}>关闭会话</button>}
    </footer>
    {canReopen && <Issue text={sessionAction.error}/>}
    {confirmClose && !archived && <V2Dialog title="关闭会话？" meta={session.title} close={() => setConfirmClose(false)}><p>关闭后仍可阅读发言和工单。</p><Issue text={sessionAction.error}/>
      <button className="v2-button primary" disabled={sessionAction.busy} onClick={async () => {
        const receipt = await sessionAction.post<Scoped & {session:V2Session}>(path + '/close', {})
        if (receipt) setConfirmClose(false)
        await Promise.all([transcript.refresh(),changed()])
      }}>确认关闭</button></V2Dialog>}
    {attachment && anchored && <V2AttachmentDialog path={path + '/attachments/' + segment(attachment.ref.id)} reference={attachment.ref} context={session.title} close={() => setAttachment(undefined)}/>}
  </section>
}

/** Render static HTML without giving the attachment a host origin, scripts, navigation or external resources. */
function staticPreview(content: string) {
  const template = document.createElement('template')
  template.innerHTML = content
  template.content.querySelectorAll('meta,base,script,noscript,template,iframe,frame,object,embed,link,svg,math').forEach(node => node.remove())
  template.content.querySelectorAll('[href],[action],[formaction]').forEach(node => {
    node.removeAttribute('href'); node.removeAttribute('action'); node.removeAttribute('formaction')
  })
  return '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' + template.innerHTML
}

export function V2AttachmentDialog({ path, reference, context, close }: { path: string; reference: V2AttachmentRef; context: string; close: () => void }) {
  const query = useV2Read(path, isAttachmentView)
  const item = query.data?.attachment.id === reference.id ? query.data.attachment : undefined
  return <V2Dialog title={reference.label} meta={context} close={close}><Issue text={query.error} retry={query.refresh}/>
    {!item && !query.error && <p role="status">正在打开附件…</p>}
    {item && <V2AttachmentContent item={item}/>}
  </V2Dialog>
}


export function V2AttachmentContent({item}: {item: V2Attachment}) {
  if (item.format === 'markdown') return <Markdown className="v2-markdown" text={item.content}/>
  if (item.format === 'text') return <pre className="v2-file">{item.content}</pre>
  return <iframe sandbox="" referrerPolicy="no-referrer" title={item.label} srcDoc={staticPreview(item.content)}/>
}
