/**
 * 接口人：作战台左侧的对话。主人用大白话说，接口人负责记入花名册、调动幕僚团。
 * 背后是 DSH 里名为"接口人"的会话；在原生界面或手机上打开它，是同一段对话。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatMode, ChatStep, ChatView, DiscussionResult, LiveTurn } from './api.ts'
import { Avatar } from './avatar.tsx'
import { Markdown } from './markdown.tsx'
import type { useChat } from './api.ts'
import { ChatComposer, MessageInputAttachments, useChatAttachments } from './chat-attachments.tsx'

/**
 * 说话怎么进接口人：自动（忙时插进正在做的这一轮，闲时直接开始，默认）、
 * 插入（一定要插进当前这一轮）、排队（一定排在后面）。
 */
const MODES: readonly (readonly [ChatMode, string, string])[] = [['auto', '自动', '他在忙就插进去，不忙直接开始'], ['steer', '插入', '插进他正在做的事，马上看到'], ['queue', '排队', '等手头的事做完再看']]
const modeLabel = (m: ChatMode) => MODES.find(x => x[0] === m)?.[1] ?? '自动'

/** 一键开场：有的直接发出去，有的只是替主人起个头。 */
const CHIPS: readonly (readonly [string, string, boolean])[] = [
  ['今天有什么', '今天有什么要我处理的？', true],
  ['记一次互动', '今天和', false],
  ['记一条承诺', '我答应了', false],
  ['登记会议', '帮我登记一场会议：', false],
  ['新增横向线', '我还负责对接', false],
  ['改界面', '我想把 SuperHub 界面改成', false],
  ['加一位幕僚', '帮我加一位幕僚，负责', false],
]

/** 过程里的一步。 */
function Step({ step, last, live }: { step: ChatStep; last: boolean; live: boolean }) {
  const running = live && last && !step.done
  return <li className={`${step.failed ? 'failed' : step.done ? 'done' : running ? 'running' : ''} ${step.kind}`}>
    <span className="mark" aria-hidden />
    <span className="what">{step.label}</span>{step.detail && <span className="detail">{step.detail}</span>}
  </li>
}

export function Dispatches({ dispatches, openTicket, openDiscussion, ticketLabel = '执行与核验' }: { dispatches?: ChatMessage['dispatches']; openDiscussion?: (id: string) => void; openTicket: (id: string) => void; ticketLabel?: string }) {
  if (!dispatches?.length) return null
  const labels = { pending: '等待研判', observed: '已记录，等待放行', ignored: '无需开单', noted: '已归档', unavailable: '研判暂未完成，可到事件流重试', missing: '交办记录暂不可用', accepted: '工单记录暂不可用', attached: '工单记录暂不可用' }
  return <div className="did" aria-live="polite">{dispatches.map(dispatch =>
    dispatch.ticketId && (dispatch.state === 'accepted' || dispatch.state === 'attached')
      ? <span key={dispatch.eventId}>{openDiscussion && <button type="button" className="quiet" onClick={() => openDiscussion(dispatch.ticketId!)}>旁听讨论</button>}<button type="button" className="quiet" onClick={() => openTicket(dispatch.ticketId!)}>{ticketLabel} <small>{dispatch.ticketId}</small></button></span>
      : <span key={dispatch.eventId} title={dispatch.detail} role="status">{labels[dispatch.state]}</span>)}</div>
}

export function RoomReceipts({ discussions, open }: { discussions?: ChatMessage['discussions']; open?: (id: string) => void }) {
  if (!discussions?.length || !open) return null
  const rooms = new Map(discussions.map(room => [room.id, room]))
  return <div className="wr-room-receipts">{[...rooms.values()].map(room => <button key={room.id} onClick={() => open(room.id)}><span aria-hidden>↗</span><span><small>已衔接讨论</small>{room.title}</span><span aria-hidden>→</span></button>)}</div>
}

export function DiscussionReply({ result, open, className }: { result: DiscussionResult; open?: (id: string) => void; className: string }) {
  const labels = { partial: '部分结果', ready: '讨论回报', historical: '讨论中的答复' }
  return <>
    <p><strong>{labels[result.status]} · {result.title}</strong></p>
    <Markdown text={result.text} className={className}/>
    {open && <div className="wr-room-receipts"><button type="button" onClick={() => open(result.roomId)}>
      <span aria-hidden>↗</span><span>查看讨论过程</span><span aria-hidden>→</span>
    </button></div>}
  </>
}

/** 正在进行的一轮：每一步实时出现，最后一步在转。 */
function Live({ live, openTicket, openRoom }: { live: LiveTurn; openTicket: (id: string) => void; openRoom?: (id: string) => void }) {
  const seconds = Math.max(0, Math.round((Date.now() - live.since) / 1000))
  const tools = live.steps.filter(s => s.kind === 'tool')
  const now = live.steps.at(-1)
  const status = !now ? '读你的话' : now.kind === 'tool' && !now.done ? `正在${now.label}` : '想下一步'
  return <div className="wr-live" aria-live="polite">
    <div className="head"><span className="spin" aria-hidden />{status}<span className="sec">{seconds} 秒{tools.length ? `，${tools.length} 个动作` : ''}</span></div>
    {live.steps.length > 0 && <ol className="wr-steps">{live.steps.map((s, i) => <Step key={i} step={s} last={i === live.steps.length - 1} live />)}</ol>}
    {live.text && <Markdown className="partial chat" text={live.text} />}
    <RoomReceipts discussions={live.discussions} open={openRoom} /><Dispatches dispatches={live.dispatches} openTicket={openTicket} />
  </div>
}

/** 已完成的回复：过程默认收起。 */
function Process({ steps }: { steps: ChatStep[] }) {
  const [open, setOpen] = useState(false)
  const tools = steps.filter(s => s.kind === 'tool').length
  return <div className="wr-process">
    <button className="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '收起过程' : `看过程（${tools ? `${tools} 个动作` : `${steps.length} 步`}）`}</button>
    {open && <ol className="wr-steps">{steps.map((s, i) => <Step key={i} step={s} last={false} live={false} />)}</ol>}
  </div>
}

type ChatNotice = ChatView['notices'][number]
type OpenDelivery = (ticketId: string, path: string, version: string) => void

function NoticeCard({ notice, openTicket, openWork, openDelivery, openRoom }: {
  notice: ChatNotice; openTicket: (id: string) => void; openWork?: (id: string, at?: string) => void; openDelivery?: OpenDelivery; openRoom?: (id: string) => void
}) {
  const result = notice.kind === 'result'
  const summary = notice.text.length > 150 ? notice.text.slice(0, 149) + '…' : notice.text
  const action = result ? '查看结果' : notice.done ? '查看当时记录' : notice.key.includes(':you/answer:') ? '回复'
    : notice.key.includes(':you/review:') ? '查看并验收' : notice.key.includes(':you/approve:') ? '查看并决定' : '查看详情'
  return <article className={`wr-msg notice ${result ? 'result' : ''} ${notice.done ? 'done' : ''}`}>
    <small>接口人 · {result ? '工作结果' : '提醒'}{notice.status && <span className="state">{notice.status}</span>}</small>
    <p className="wr-notice-summary">{summary}</p>
    {summary !== notice.text && <details className="wr-notice-detail"><summary>完整说明</summary><p>{notice.text}</p></details>}
    {notice.deliveryUnavailable && <p className="wr-notice-unavailable">原交付暂不可读，可查看工作记录。</p>}
    <div className="wr-notice-actions">
      {notice.ticketId && notice.delivery && openDelivery && <button type="button" title={notice.delivery.title}
        onClick={() => openDelivery(notice.ticketId!, notice.delivery!.path, notice.delivery!.version)}>阅读交付</button>}
      {notice.ticketId && <button type="button" className={notice.delivery ? 'quiet' : undefined}
        onClick={() => openWork ? openWork(notice.ticketId!, result || notice.done ? notice.at : undefined) : openTicket(notice.ticketId!)}>{action}</button>}
      {notice.roomId && openRoom && <button type="button" onClick={() => openRoom(notice.roomId!)}>打开讨论待办</button>}
    </div>
  </article>
}

export function Chat({ scope, sessionId, messages, notices, workReplies = [], discussionResults = [], live, busy, error, say, draft, setDraft, inputRef, empty, openTicket, openWork, openDelivery, openImport, openDiscussion, openRoom }: {
  scope?: string; sessionId?: string; openRoom?: (id: string) => void; openDiscussion?: (id: string) => void; messages: ChatMessage[]; notices: ChatView['notices']; workReplies?: ChatView['workReplies']; live?: LiveTurn; openTicket: (id: string) => void; busy: boolean; error?: string; say: ReturnType<typeof useChat>['say']
  discussionResults?: ChatView['discussionResults']
  openDelivery?: OpenDelivery
  openWork?: (id: string, at?: string) => void
  draft: string; setDraft: (text: string) => void; inputRef: React.RefObject<HTMLTextAreaElement | null>; empty: boolean; openImport?: () => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const inputTarget = sessionId ? {sessionId} : undefined
  const files = useChatAttachments(scope, inputTarget)
  const [sending, setSending] = useState(false)
  const following = useRef(true)
  useEffect(() => { if (following.current) end.current?.scrollIntoView({ block: 'end' }) }, [messages.length, notices.length, workReplies.at(-1)?.id, discussionResults.length, discussionResults.at(-1)?.id, busy, live?.steps.length, live?.text])
  // 输入框随内容长高
  useLayoutEffect(() => {
    const el = inputRef.current
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px` }
  }, [draft, inputRef])
  // 接口人的主动提醒按时间插进对话里
  const newest = [...notices].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const visibleNotices = new Set([
    ...newest.filter(n => !n.done && n.kind !== 'result').slice(0, 3),
    ...newest.filter(n => n.kind === 'result').slice(0, 1),
  ].map(n => n.key))
  // History remains available without making every past state a fresh interruption.
  const olderNotices = notices.filter(n => !visibleNotices.has(n.key))
  const feed = [
    ...messages.map(m => ({ t: m.time, m })),
    ...notices.filter(n => visibleNotices.has(n.key)).map(n => ({ t: Date.parse(n.at), n })),
    ...workReplies.map(work => ({ t: Date.parse(work.at), work })),
    ...discussionResults.map(result => ({ t: Date.parse(result.at), result })),
  ].sort((a, b) => a.t - b.t)
  const [mode, setMode] = useState<ChatMode>(() => { try { return (localStorage.getItem('chief-chat-mode') as ChatMode) || 'auto' } catch { return 'auto' } })
  const send = async () => {
    const text = draft.trim()
    if (sending || !files.canSend(text)) return
    setSending(true)
    try {
      if (await say(text, mode, undefined, files.ready)) {
        const latest = inputRef.current?.value
        if (draft && latest?.startsWith(draft)) setDraft(latest.slice(draft.length).trimStart())
        files.sent()
      }
    } finally { setSending(false) }
  }
  return (
    <aside className="wr-chat" aria-label="接口人">
      <div className="wr-chat-head"><div className="wr-contact-pill"><Avatar who="lead" size={38} working={busy} /><div><h2>接口人</h2><span>{busy ? '正在处理你的交办' : '随时聊聊，帮你记住并推进'}</span></div><i className={busy ? 'working' : ''} aria-label={busy ? '正在处理' : '在线'} /></div></div>
      <div className="wr-msgs" onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
        {!feed.length && !olderNotices.length && <div className="wr-hello">
          <b>今天，从哪件事开始？</b>
          记下一个想法，跟进一条承诺，或把需要研究的事交给我。
          {empty && <div className="row">{openImport && <button className="go" onClick={openImport}>从 ChatGPT / Claude 导入</button>}<button onClick={() => say('花名册还是空的。你来问我，帮我把我对接的团队、关键的人和眼下最卡的事搭起来。')}>你来问我</button></div>}
        </div>}
        {feed.map(item => 'result' in item ? <article key={item.result.id} className="wr-msg liaison">
          <div className="wr-speaker"><Avatar who="lead" size={23} /><span>接口人</span></div>
          <DiscussionReply result={item.result} open={openRoom} className="chat"/>
        </article> : 'work' in item ? <article key={item.work.id} className="wr-msg wr-work-reply">
          <header><span>你 · 工单回复</span><time dateTime={item.work.at}>{new Date(item.work.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></header>
          <div className="wr-work-reply-text">{item.work.text}</div>
          <footer><button type="button" className="quiet" title={item.work.title} onClick={() => openTicket(item.work.ticketId)}>{item.work.ticketId} · 打开工单</button>
            {item.work.roomId && openRoom && <button type="button" className="quiet" onClick={() => openRoom(item.work.roomId!)}>打开讨论</button>}</footer>
        </article> : 'n' in item && item.n
          ? <NoticeCard key={item.n.key} notice={item.n} openTicket={openTicket} openWork={openWork} openDelivery={openDelivery} openRoom={openRoom} />
          : 'm' in item && item.m ? <div key={`${item.m.role}${item.m.seq}`} className={`wr-msg ${item.m.role}`}>
            {item.m.role !== 'you' && <div className="wr-speaker"><Avatar who="lead" size={23} /><span>接口人</span></div>}{item.m.role === 'you' ? item.m.text : <Markdown className="chat" text={item.m.text} />}
            <MessageInputAttachments scope={scope} target={inputTarget} attachments={item.m.inputAttachments}/>
            {item.m.did?.length ? <div className="did">{item.m.did.map(d => <span key={d}>{d}</span>)}</div> : null}
            <RoomReceipts discussions={item.m.discussions} open={openRoom} /><Dispatches dispatches={item.m.dispatches} openTicket={openTicket} openDiscussion={openDiscussion} />
            {item.m.steps?.length ? <Process steps={item.m.steps} /> : null}
          </div> : null)}
        {!!olderNotices.length && <details className="wr-notice-history"><summary>其余 {olderNotices.length} 条提醒与结果
          {olderNotices.some(n => !n.done && n.kind !== 'result') && <span> · {olderNotices.filter(n => !n.done && n.kind !== 'result').length} 条待处理</span>}</summary>
          {olderNotices.map(notice => <NoticeCard key={notice.key} notice={notice} openTicket={openTicket} openWork={openWork} openDelivery={openDelivery} openRoom={openRoom} />)}
        </details>}
        {live ? <Live live={live} openTicket={openTicket} openRoom={openRoom} /> : busy && <div className="wr-live"><div className="head"><span className="spin" aria-hidden />接口人收到了，马上开始</div></div>}
        {error && <div className="wr-err">{error}</div>}
        <div ref={end} />
      </div>
      <div className="wr-say">
        <div className="wr-chips">{openImport && <button onClick={openImport}>导入</button>}{CHIPS.slice(0, 3).map(([label, text, direct]) =>
          <button key={label} onClick={() => { if (direct) say(text); else { setDraft(text); inputRef.current?.focus() } }}>{label}</button>)}</div>
        <form onSubmit={event => { event.preventDefault(); void send() }}>
          <ChatComposer draft={files} text={draft} sending={sending} accessory={
            <button type="button" className="quiet wr-mode" title={`${MODES.find(x => x[0] === mode)?.[2] ?? ''}（点击换一种）`} onClick={() => { const next = MODES[(MODES.findIndex(x => x[0] === mode) + 1) % MODES.length]?.[0] ?? 'auto'; setMode(next); try { localStorage.setItem('chief-chat-mode', next) } catch { /* 无痕模式 */ } }}>{modeLabel(mode)}</button>
          }>
            <textarea ref={inputRef} rows={1} value={draft} onChange={e => setDraft(e.target.value)} aria-label="对接口人说" placeholder="说说你想推进的事…"
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }}/>
          </ChatComposer>
        </form>
      </div>
    </aside>
  )
}
