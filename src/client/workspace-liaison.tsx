import { useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { type ChatMessage, type DiscussionResult, useChat } from './api.ts'
import type { SuperhubSurface } from '../core/workspace-product.ts'
import { DiscussionReply, RoomReceipts } from './chat.tsx'
import { Markdown } from './markdown.tsx'
import { V2Client } from './workspace-v2-api.ts'
import { Issue, readableTime, V2Dialog } from './workspace-v2-elements.tsx'
import { ChatAvatar, chatAvatarStyle, usePortraitArrivals } from './workspace-chat-avatar.tsx'
import { liaisonPortrait, ownerPortrait } from '../core/workspace-avatars.ts'
import { hasPublicReply, liaisonNotice } from '../core/liaison-unread.ts'
import type { ChatView } from '../dsh/chat.ts'
import { useMarkLiaisonSeen } from './workspace-liaison-unread.tsx'
import { ChatComposer, MessageInputAttachments, useChatAttachments } from './chat-attachments.tsx'
import { NoticeScheduleActions, SCHEDULE_STYLE } from './workspace-schedules.tsx'
import { NewerEdge, OlderEdge, historyEdgeStyle } from './history-edge.tsx'
import { useEdgeSentinel, usePrependAnchor } from './scroll-anchor.ts'
import { speechCursor } from '../core/paging.ts'
import { MessageEditButton, MessageEditor, type MessageEdit } from './workspace-conversation-actions.tsx'

interface Links {
  openProfileImport: (id: string) => void
  openRoom?: (id: string) => void
  openWorkspace: (id: string) => void
  openDelegation?: (workspaceId: string, delegationId: string) => void
  /** 「设置 → 定时安排」：定时提醒下的「在设置中查看」。 */
  openSchedules?: () => void
}
interface Props extends Links {
  scope: string; surface: SuperhubSurface; selectedId?: string; sessionId?: string; workOrderId?: string; changed: () => void; close: () => void
  workspace?: { id: string; name: string }
  pending?: ReactNode
  trace?: string
  sourceMessage?: string
  sourceSession?: string
  currentTrace?: () => void
}

const style = `
.wv2 .v2-liaison { flex:1; display:flex; flex-direction:column; min-height:0; }
.wv2 .v2-liaison-actions { flex:none; }
.wv2 .v2-liaison-history { flex:1; min-height:120px; overflow:auto; overscroll-behavior:contain; overflow-anchor:none; padding:2px; scrollbar-gutter:stable; }
.wv2 .v2-liaison .v2-turns { margin:3px 0 10px; }
.wv2 .v2-liaison .v2-compose { flex:none; margin:13px 0 0; }
.wv2 .v2-liaison .wr-room-receipts { display:flex; flex-wrap:wrap; gap:3px 10px; }
.wv2 .v2-liaison .wr-room-receipts button { color:var(--v-green); font-weight:650; text-align:left; min-height:34px; }
.wv2 .v2-liaison .wr-room-receipts button { display:flex; align-items:center; gap:5px; }
.wv2 .v2-liaison .wr-room-receipts small { margin-inline-end:4px; }
.wv2 .v2-liaison .v2-notice-text { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.wv2 .v2-liaison .v2-notice-status { display:block; color:var(--v-muted); font-size:13px; margin-top:4px; }
.wv2 .v2-liaison .v2-turn.settled .v2-notice-text { color:var(--v-muted); }
`

const speechId = (m: Pick<ChatMessage, 'role' | 'seq' | 'firstSeq' | 'messageId'>) => m.role + '-' + speechCursor(m)
type LiaisonSpeech = Pick<ChatMessage, 'role' | 'time' | 'text' | 'discussions' | 'workspaces' | 'profileImports' | 'inputAttachments'>
type ChatNotice = ChatView['notices'][number]

/** A reminder the liaison sends on its own (an order completed, waits for the owner, or stopped short), as one of its turns. */
function NoticeBody({ notice, openRoom, openDelegation, openSchedules }: Pick<Links, 'openRoom' | 'openDelegation' | 'openSchedules'> & { notice: ChatNotice }) {
  return <>
    <p className="v2-notice-text">{notice.text}</p>
    {notice.status && <small className="v2-notice-status">{notice.status}</small>}
    {notice.order?.orderDeletedAt ? <small className="v2-notice-status">工单已删除</small>
      : notice.order && openDelegation && <button type="button" className="v2-link" onClick={() => openDelegation(notice.order!.workspaceId, notice.order!.orderId)}>打开工单</button>}
    {notice.roomId && openRoom && <button type="button" className="v2-link" onClick={() => openRoom(notice.roomId!)}>打开讨论</button>}
    {notice.schedule && <NoticeScheduleActions schedule={notice.schedule} status={notice.status} openSchedules={openSchedules}/>}
  </>
}

function LiaisonTurn({ message, result, notice, id, scope, sessionId, editMessage, editor, openProfileImport, openRoom, openWorkspace, openDelegation, openSchedules }: Links & {
  id?: string; scope: string; sessionId?: string; message: LiaisonSpeech; result?: DiscussionResult; notice?: ChatNotice; editMessage?: () => void; editor?: ReactNode
}) {
  const mine = message.role === 'you'
  const at = new Date(message.time).toISOString()
  return <li data-message-id={id} className={'v2-turn' + (mine ? ' mine' : '') + (notice?.done ? ' settled' : '')} tabIndex={-1}>
    <ChatAvatar portrait={mine ? ownerPortrait : liaisonPortrait}/>
    <div className="v2-message"><div className="v2-byline">
      {editMessage && <MessageEditButton open={editMessage}/>}
      <strong>{mine ? '我' : '接口人'}</strong><time dateTime={at}>{readableTime(at)}</time></div>
      {editor ?? <div className="v2-bubble">
        {notice && <NoticeBody notice={notice} openRoom={openRoom} openDelegation={openDelegation} openSchedules={openSchedules}/>}
        {result && <DiscussionReply result={result} open={openRoom} className="v2-markdown"/>}
        {message.text && <Markdown text={message.text} className="v2-markdown"/>}
        <MessageInputAttachments scope={scope} target={sessionId ? {sessionId} : undefined} attachments={message.inputAttachments}/>
        <RoomReceipts discussions={message.discussions} open={openRoom}/>
        {message.workspaces?.map(({id, name, delegationId, delegationTitle, workOrderDeletedAt}) =>
          workOrderDeletedAt ? <small key={id + '/' + delegationId} className="v2-notice-status">{delegationTitle && delegationTitle + ' · '}工单已删除</small>
          : delegationId && openDelegation ? <button key={id + '/' + delegationId} className="v2-link" onClick={() => openDelegation(id, delegationId)}>
            {delegationTitle ? '打开工单「' + delegationTitle + '」' : '打开工单'}</button>
            : <button key={id} className="v2-link" onClick={() => openWorkspace(id)}>打开工作区「{name}」</button>)}
        {message.profileImports?.map(({importId}) => <button type="button" key={importId} className="v2-link" onClick={() => openProfileImport(importId)}>核对资料</button>)}
      </div>}
    </div>
  </li>
}

export function WorkspaceLiaison({ scope, close, openProfileImport, openRoom, openWorkspace, openDelegation, openSchedules, workspace, surface, selectedId, sessionId, workOrderId, changed, pending, trace, sourceMessage, sourceSession, currentTrace }: Props) {
  const { revoke } = useContext(V2Client)
  const following = useRef(!sourceMessage)
  const chat = useChat(changed, scope, revoke, () => following.current, {trace, message:sourceMessage, sessionId:sourceSession})
  const { activeTraceId, sessionId: chatSessionId } = chat
  const historical = !!chat.traceId && !!activeTraceId && chat.traceId !== activeTraceId
  const [revision, setRevision] = useState<{rowId: string; message: LiaisonSpeech; sessionId: string; edit: MessageEdit}>()
  const activeEdit = revision?.sessionId === chatSessionId ? revision : undefined
  const [savedMessage, setSavedMessage] = useState<string>()
  const key = 'superhub-v2:draft:' + scope + ':liaison:' + (['people','calendar'].includes(surface) ? surface + ':' + (selectedId ?? '') : workspace?.id ?? '')
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(key) ?? '' } catch { return '' } })
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const destination = JSON.stringify([key, sessionId, workOrderId, chat.sessionId])
  const files = useChatAttachments(scope, chat.sessionId ? {sessionId:chat.sessionId} : undefined, destination, revoke)
  const openDestination = useRef<string | undefined>(destination)
  useLayoutEffect(() => {
    openDestination.current = destination
    return () => { openDestination.current = undefined }
  }, [destination])
  const [sending, setSending] = useState(false)
  const [delivered, setDelivered] = useState(false)
  const active = useRef(false)
  const history = useRef<HTMLDivElement>(null)
  const messages = chat.messages.filter(hasPublicReply)
  const live = chat.live
  const livePublic = live && hasPublicReply(live)
  const liveId = live?.firstSeq !== undefined ? 'liaison-' + live.firstSeq : undefined
  // Reminders and discussion results interleave by time: only those inside the loaded range show, the rest come with their page.
  const loaded = chat.confirmedMessages
  const inRange = (at: number) => (!chat.hasOlder || !loaded.length || at >= loaded[0]!.time) && (!chat.hasNewer || !loaded.length || at <= loaded.at(-1)!.time)
  const results = (chat.discussionResults ?? []).filter(result => inRange(Date.parse(result.at)))
  const notices = chat.notices.filter(notice => liaisonNotice(notice) && inRange(Date.parse(notice.at)))
  const feed: { id: string | undefined; message: LiaisonSpeech; editableId?: string; result?: DiscussionResult; notice?: ChatNotice }[] = messages.map(message => ({
    id: speechId(message), message, ...(message.role === 'you' && message.canEdit && {editableId:speechCursor(message)}),
  }))
  for (const result of results) feed.push({ id: result.id, result, message: { role: 'liaison', text: '', time: Date.parse(result.at) } })
  for (const notice of notices) feed.push({ id: 'notice-' + notice.key, notice, message: { role: 'liaison', text: '', time: Date.parse(notice.at) } })
  if (live && livePublic && !chat.hasNewer) feed.push({ id: liveId, message: { ...live, role: 'liaison', time: live.firstSpokenAt ?? live.since } })
  if (activeEdit && !feed.some(row => row.id === activeEdit.rowId)) feed.push({id:activeEdit.rowId, message:activeEdit.message})
  feed.sort((a, b) => a.message.time - b.message.time)
  const timeline = chat.confirmedMessages.filter(hasPublicReply)
    .map(m => ({id:speechId(m), at:m.time}))
  for (const result of results) timeline.push({ id: result.id, at: Date.parse(result.at) })
  for (const notice of notices) timeline.push({ id: 'notice-' + notice.key, at: Date.parse(notice.at) })
  if (liveId && livePublic) timeline.push({id:liveId, at:live!.firstSpokenAt ?? live!.since})
  usePortraitArrivals(history, JSON.stringify([chat.sessionId, chat.traceId]), historical ? undefined : timeline, chat.observedAt)
  // Older pages load as the top comes near; the first visible message stays where it was.
  const scroller = useCallback(() => history.current, [])
  const top = useRef<HTMLDivElement>(null), bottom = useRef<HTMLDivElement>(null)
  const capture = usePrependAnchor(scroller, history, loaded[0] && speechId(loaded[0]))
  const loadOlder = () => void chat.loadOlder(capture)
  // A page appended below while catching up is read where it is, not followed to its end.
  const appending = useRef(false)
  const loadNewer = () => void chat.loadNewer(() => { appending.current = true })
  useEdgeSentinel(top, scroller, 'top', chat.hasOlder && !chat.loadingOlder && !chat.olderError, loadOlder, loaded.length)
  useEdgeSentinel(bottom, scroller, 'bottom', chat.hasNewer && !chat.loadingNewer && !chat.newerError, loadNewer, loaded.length)
  useLayoutEffect(() => {
    const element = history.current
    const skip = appending.current || chat.hasNewer
    appending.current = false
    if (element && following.current && !activeEdit && !skip) element.scrollTop = element.scrollHeight
  }, [chat.traceId, messages.length, messages.at(-1)?.seq, results.length, results.at(-1)?.id, notices.length, notices.at(-1)?.key, live?.text, live?.discussions?.length, live?.workspaces?.length, live?.profileImports?.length])
  const source = savedMessage ?? sourceMessage
  const sourceRow = source && messages.find(message => speechCursor(message) === source)
  const anchored = sourceRow ? speechId(sourceRow) : undefined
  useLayoutEffect(() => {
    if (!anchored) return
    const node = Array.from(history.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(el => el.dataset.messageId === anchored)
    node?.focus({preventScroll:true})
    node?.scrollIntoView({block:'center'})
  }, [anchored])
  // What the owner sees here is read: on opening, and whenever the newest message (or a reminder) changes.
  // A reply still being written is not counted as unread, so it is marked when it lands.
  useMarkLiaisonSeen(historical ? undefined : chat.observedAt, feed.filter(row => !live || row.id !== liveId).map(row => row.id + (row.notice?.done ? '!' : '')).join('|'))

  function edit(value: string) {
    setDraft(value)
    setDelivered(false)
    try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key) } catch { /* The draft remains in this window. */ }
  }
  async function send() {
    if (active.current || activeEdit || historical || !chatSessionId || !files.canSend(draft)) return
    active.current = true
    setSending(true)
    setDelivered(false)
    following.current = true
    if (chat.hasNewer) void chat.toLatest()
    try {
      if (await chat.say(draft, 'auto', {surface, ...(selectedId && {selectedId}),
        ...(surface === 'workspace' && sessionId && {sessionId, ...(workOrderId && {workOrderId})})}, files.ready, chat.traceId)) {
        if (openDestination.current !== destination) {
          try { if (sessionStorage.getItem(key) === draft) sessionStorage.removeItem(key) } catch { /* Optional in embedded hosts. */ }
          return
        }
        if (draft && latestDraft.current.startsWith(draft)) edit(latestDraft.current.slice(draft.length).trimStart())
        files.sent()
        setDelivered(true)
      }
    } finally {
      active.current = false
      setSending(false)
    }
  }

  return <V2Dialog title="接口人" meta={workspace?.name} close={close} size="wide">
    <style>{style + chatAvatarStyle + SCHEDULE_STYLE + historyEdgeStyle}</style><div className="v2-liaison">
      {pending && !historical && <div className="v2-liaison-actions">{pending}</div>}
      {historical && <div className="v2-source-status">编辑前的对话 {currentTrace && <button type="button" className="v2-link" onClick={currentTrace}>返回当前对话</button>}</div>}
      <div className="v2-liaison-history" ref={history} onScroll={event => {
        const el = event.currentTarget
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}>
        <OlderEdge edge={top} hasOlder={chat.hasOlder} loading={chat.loadingOlder} error={chat.olderError} count={loaded.length} load={loadOlder}/>
        {feed.length > 0 && <ol className="v2-turns" aria-label="接口人对话">
          {feed.map(({ id, message, editableId, result, notice }) => {
            const editing = activeEdit?.rowId === id ? activeEdit : undefined
            return <LiaisonTurn key={id ?? 'liaison-live'} id={id} scope={scope} sessionId={chatSessionId} message={message} result={result} notice={notice}
              editMessage={!activeEdit && !historical && !sending && editableId && id && activeTraceId && chatSessionId ? () => {
                following.current = false
                setRevision({rowId:id, message, sessionId:chatSessionId,
                  edit:{id:editableId, text:message.text, traceId:activeTraceId, attachments:message.inputAttachments}})
              } : undefined}
              editor={editing && <MessageEditor base="/chat" sessionId={editing.sessionId} edit={editing.edit}
                maxLength={40_000} close={() => setRevision(undefined)} saved={receipt => {
                  setRevision(undefined)
                  if ((trace || sourceMessage) && currentTrace) currentTrace()
                  else { following.current = true; setSavedMessage(receipt.messageId); void chat.toLatest() }
                }}/>}
              openProfileImport={openProfileImport} openRoom={openRoom} openWorkspace={openWorkspace} openDelegation={openDelegation} openSchedules={openSchedules}/>
          })}
        </ol>}
        <NewerEdge edge={bottom} hasNewer={chat.hasNewer} loading={chat.loadingNewer} error={chat.newerError} load={loadNewer}
          latest={() => { following.current = true; void chat.toLatest() }}/>
      </div>
      {historical && <Issue text={chat.error} retry={chat.refresh}/>}
      {!historical && <form className="v2-compose" onSubmit={event => { event.preventDefault(); void send() }}>
        <ChatComposer draft={files} text={draft} sending={sending} disabled={!chatSessionId || !!activeEdit}
          status={chat.busy ? '正在等待接口人回复…' : delivered && !draft && !files.items.length ? '已送达接口人' : !chat.sessionId && !chat.error ? '正在连接接口人…' : ''}>
          <textarea rows={1} aria-label="对接口人说" maxLength={40_000} value={draft} disabled={!!activeEdit} placeholder="你想交办什么事？" onChange={event => edit(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }}/>
        </ChatComposer>
        <Issue text={chat.error} retry={chat.refresh}/>
      </form>}
    </div>
  </V2Dialog>
}
