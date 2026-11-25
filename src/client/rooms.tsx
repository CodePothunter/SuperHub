import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { requestId } from './request-id.ts'
import { Avatar } from './avatar.tsx'
import { RoomWorkEntry, RoomWorkLinks, useRoomWork } from './room-work-feed.tsx'
import { roomParticipants } from './room-members.ts'
import { staffName } from './staff-names.ts'
import { Markdown } from './markdown.tsx'
import type { NativeRooms, RoomMessage } from '../dsh/rooms.ts'
import type { Connectors } from '../dsh/connectors.ts'
import type { StaffRow } from '../dsh/view.ts'

type RoomView = Awaited<ReturnType<NativeRooms['view']>>
type List = ReturnType<NativeRooms['list']>
type ConnectionView = ReturnType<Connectors['view']>
const category = { agreement: '本次约定', verified: '已核实', pending: '待核实' }

export function RoomWorkspace({ close, selectedId, embedded = false, openTicket, staff = [] }: { openTicket?: (id: string) => void; close: () => void; selectedId?: string; embedded?: boolean; staff?: StaffRow[] }) {
  const [list, setList] = useState<List>([])
  const [selected, setSelected] = useState<string>(() => selectedId ?? new URLSearchParams(location.hash.slice(1)).get('room') ?? '')
  const [room, setRoom] = useState<RoomView>()
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<string>()
  const [returnPoint, setReturnPoint] = useState<{ position: number; focus?: HTMLElement; panel: boolean }>()
  const [target, setTarget] = useState('lead')
  const { rows: work, error: workError } = useRoomWork(room?.id === selected ? room?.session : undefined, room?.id === selected ? room?.tickets ?? [] : [])
  const timeline = [
    ...(room?.messages ?? []).map(message => ({ time: message.time, message })),
    ...work.flatMap(row => row.messages.map(record => ({ time: Date.parse(record.at), record, row }))),
  ].sort((a, b) => a.time - b.time)
  const name = (id: string) => staffName(id, staff)
  const participants = roomParticipants(room?.members ?? [], work, staff)
  const recipient = participants.find(p => p.key === target)
  const [navOpen, setNavOpen] = useState(false)
  const [sendError, setSendError] = useState('')
  const loadedSession = useRef('')
  const restoredPosition = useRef(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panel, setPanel] = useState<'notes' | 'connectors' | 'members'>('notes')
  const [connections, setConnections] = useState<ConnectionView>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [source, setSource] = useState<RoomMessage>()
  const [executionSource, setExecutionSource] = useState<string>()
  const [note, setNote] = useState('')
  const [noteReason, setNoteReason] = useState('')
  const [editing, setEditing] = useState<{ id: string; version: number }>()
  const [kind, setKind] = useState<'agreement' | 'verified' | 'pending'>('pending')
  const pending = useRef<{ text: string; target: string; id: string; replyTo?: string; work?: { thread_id: string; ticket_id: string; reply_to: string | null; execution_boundary: string } } | undefined>(undefined)
  const log = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const active = useRef(selected)
  active.current = selected
  useEffect(() => {
    let stopped = false
    const refresh = async () => {
      try { const value = await api<List>('/rooms'); if (!stopped) { setList(value); setError('') } }
      catch (e) { if (!stopped) setError((e as Error).message) }
    }
    void refresh(); const interval = setInterval(() => { void refresh() }, 2500)
    return () => { stopped = true; clearInterval(interval) }
  }, [])
  useEffect(() => {
    if (!selected) return
    let stopped = false, fetching = false, current: RoomView | undefined
    let cursor: RoomView['cursor'] | undefined
    setRoom(undefined); setSource(undefined); setTarget('lead'); pending.current = undefined
    setDraft(''); setReplyTo(undefined); setReturnPoint(undefined); loadedSession.current = ''; restoredPosition.current = false; stick.current = true
    setExecutionSource(undefined)
    if (!embedded) history.replaceState(history.state, '', `${location.pathname}${location.search}#room=${encodeURIComponent(selected)}`)
    const refresh = async () => {
      if (fetching) return
      fetching = true
      try {
        const data = await api<RoomView>(`/rooms/${encodeURIComponent(selected)}${cursor ? `?after=${encodeURIComponent(JSON.stringify(cursor))}` : ''}`)
        if (!stopped) {
          if (loadedSession.current !== data.session) {
            if (loadedSession.current) setSendError('第二大脑已切换，请确认当前讨论后再发言')
            loadedSession.current = data.session; restoredPosition.current = false
            setDraft(sessionStorage.getItem(`chief-room-draft:${data.session}`) ?? '')
            const savedReply = sessionStorage.getItem(`chief-room-reply:${data.session}`)
            setReplyTo(savedReply && data.messages.some(m => m.id === savedReply) ? savedReply : undefined)
            const savedTarget = sessionStorage.getItem(`chief-room-target:${data.session}`)
            setTarget(savedTarget && (savedTarget.startsWith('work:') && data.tickets?.includes(savedTarget.slice(5)) || data.members.some(m => m.name === savedTarget && m.status !== 'failed')) ? savedTarget : 'lead')
            pending.current = undefined
          }
          current = data.incremental && current?.session === data.session
            ? { ...data, messages: [...new Map([...current.messages, ...data.messages].map(message => [message.id, message])).values()].sort((a, b) => a.time - b.time || a.session.localeCompare(b.session) || a.seq - b.seq) }
            : data
          cursor = data.cursor
          setRoom(current); setError('')
        }
      } catch (e) { if (!stopped) setError((e as Error).message) }
      finally { fetching = false }
    }
    void refresh(); const interval = setInterval(() => { void refresh() }, 1500)
    return () => { stopped = true; clearInterval(interval) }
  }, [embedded, selected])
  useEffect(() => {
    const el = log.current
    if (!room || !el) return
    if (!restoredPosition.current) {
      const position = sessionStorage.getItem(`chief-room-position:${room.session}`)
      if (position !== null) { el.scrollTop = Number(position); stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
      else el.scrollTop = el.scrollHeight
      restoredPosition.current = true
    } else if (stick.current) el.scrollTop = el.scrollHeight
  }, [room?.session, timeline.length])
  const action = async (work: () => Promise<void>) => { setBusy(true); setSendError(''); try { await work() } catch (e) { setSendError((e as Error).message) } finally { setBusy(false) } }
  const choose = (id: string) => { if (room) sessionStorage.setItem(`chief-room-draft:${room.session}`, draft); setSelected(id); setNavOpen(false); setSendError('') }
  const send = () => action(async () => {
    const id = selected, text = draft.trim()
    if (!text || !room || room.id !== id) return
    if (pending.current?.text !== text || pending.current.target !== target || pending.current.replyTo !== replyTo) pending.current = { text, target, replyTo, id: requestId() }
    if (target.startsWith('work:')) {
      if (!recipient?.available || !recipient.work) throw new Error('这位执行者暂不可接收补充，请查看成员状态')
      if (replyTo) throw new Error('给执行者的补充请先取消讨论引用，只发送你明确填写的说明')
      pending.current.work ??= { thread_id: recipient.work.thread_id, ticket_id: recipient.work.ticket_id, reply_to: recipient.work.reply_to, execution_boundary: recipient.work.execution_boundary }
      await api(`/tickets/${encodeURIComponent(pending.current.work.ticket_id)}/thread`, { ...pending.current.work, request_id: pending.current.id, text })
    } else await api(`/rooms/${encodeURIComponent(id)}`, { session: room.session, text, to: target, reply_to: replyTo, request_id: pending.current.id })
    if (active.current === id) { setDraft(''); sessionStorage.removeItem(`chief-room-draft:${room.session}`); sessionStorage.removeItem(`chief-room-reply:${room.session}`); setReplyTo(undefined); pending.current = undefined }
  })
  const reveal = (source: string) => {
    const article = document.getElementById(`source-${source}`)
    if (!article || !log.current) return
    if (!returnPoint) setReturnPoint({ position: log.current.scrollTop, panel: panelOpen, focus: document.activeElement instanceof HTMLElement ? document.activeElement : undefined })
    setPanelOpen(false); article.focus({ preventScroll: true }); article.scrollIntoView({ block: 'center' })
  }
  const quote = (message: RoomMessage) => {
    const recipient = room?.members.some(member => member.name === message.author && member.status !== 'failed') ? message.author : 'lead'
    setTarget(recipient)
    setReplyTo(message.id)
    if (room) { sessionStorage.setItem(`chief-room-reply:${room.session}`, message.id); sessionStorage.setItem(`chief-room-target:${room.session}`, recipient) }
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.room-compose textarea')?.focus())
  }
  const fetchConnections = () => action(async () => { setPanel('connectors'); setPanelOpen(true); setConnections(await api<ConnectionView>('/settings/connectors')) })
  const connectionAction = (verb: string, body: unknown) => action(async () => { setConnections(await api<ConnectionView>(`/settings/connectors/${verb}`, body)) })
  const pendingActions = room?.ownerActions?.filter(item => !item.answered && !item.ticketId) ?? []
  const noteSources = new Set(room?.messages.map(message => message.id))
  const ownerMessages = room?.messages.filter(message => message.author === 'you') ?? []
  const roles = staff.filter(role => role.executor !== 'remote')
  return <div className={`chief-rooms ${panelOpen ? 'panel-visible' : ''} ${navOpen ? 'nav-visible' : ''}`} role={embedded ? 'region' : 'dialog'} aria-label="讨论" aria-modal={embedded ? undefined : true}>
    <style>{ROOM_CSS}</style>
    {!embedded && <aside className="room-nav">
      <div className="room-brand"><span>◈</span> 幕僚室</div>
      <button onClick={() => { if (room) sessionStorage.setItem(`chief-room-draft:${room.session}`, draft); close() }}>← 接口人私聊</button>
      <button className="room-nav-toggle" aria-expanded={navOpen} onClick={() => setNavOpen(!navOpen)}>话题与新讨论</button><small>最近讨论</small>
      {list.map(r => <button className={selected === r.id ? 'selected' : ''} key={r.id} onClick={() => choose(r.id)}>{r.title}</button>)}
      <form onSubmit={e => { e.preventDefault(); void action(async () => { const r = await api<{ id: string }>('/rooms', { request_id: requestId(), title }); setList(await api<List>('/rooms')); choose(r.id); setTitle('') }) }}>
        <input aria-label="新讨论标题" placeholder="开启一个话题" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} /><button disabled={!title.trim() || busy}>＋ 新讨论</button>
      </form>
      <button onClick={() => { void fetchConnections() }}>连接器</button>
    </aside>}
    <main className="room-main">
      <header><div><h1>{room?.title ?? '与幕僚一起讨论'}</h1><p className="room-participants">{room ? participants.map(m => <span key={m.key} title={m.detail}><Avatar who={m.staff} size={21} /><span>{m.label}</span></span>) : '先聊清问题，再一起推进'}</p></div><button onClick={() => { setPanel('members'); setPanelOpen(true) }}>成员 {participants.length}</button><button onClick={() => { setPanel('notes'); setPanelOpen(true) }}>讨论笔记</button><button onClick={() => { void fetchConnections() }}>连接器</button>{room && (room.messages.length > 0 || room.members.some(m => m.status === 'running')) && <button onClick={() => { void action(async () => { await api(`/rooms/${selected}/stop`, { session: room.session }) }) }}>停止本轮</button>}</header>
      {(sendError || error) && <p role="alert" className="room-error">{sendError || error}</p>}
      {room && (pendingActions.length > 0 || executionSource) && <section className="room-owner-actions" aria-label="讨论待办">
        {pendingActions.map(item => item.kind === 'execute' ? <div key={item.id} className="room-owner-action">
          <span>{item.text}</span>
          {!!roles.length && !!ownerMessages.length && <button onClick={() => setExecutionSource(item.source ?? ownerMessages.at(-1)?.id)}>提交执行审批</button>}
        </div> : <form key={item.id} className="room-owner-action" onSubmit={event => {
          event.preventDefault()
          const answer = String(new FormData(event.currentTarget).get('answer') ?? '')
          void action(async () => {
            await api(`/rooms/${room.id}/answer-action`, { session: room.session, id: item.id, text: answer })
            setRoom(await api<RoomView>(`/rooms/${room.id}`))
          })
        }}><label>{item.text}<input name="answer" placeholder="填写回答" required /></label><button disabled={busy}>回答</button></form>)}
        {executionSource && <form key={executionSource} className="room-execution-form" onSubmit={event => {
          event.preventDefault()
          const fields = new FormData(event.currentTarget)
          void action(async () => {
            const result = await api<{ ticketId: string }>(`/rooms/${room.id}/submit-work`, { session: room.session, source: executionSource, title: fields.get('title'), staff: fields.get('staff') })
            setExecutionSource(undefined)
            setRoom(await api<RoomView>(`/rooms/${room.id}`))
            openTicket?.(result.ticketId)
          })
        }}>
          <label>工单标题<input name="title" defaultValue={room.title} maxLength={200} required /></label>
          <label>负责角色<select name="staff" defaultValue={roles.find(role => role.id === 'engineer')?.id} required>{roles.map(role => <option key={role.id} value={role.id}>{role.name} · {role.executor}</option>)}</select></label>
          <button type="button" onClick={() => reveal(executionSource)}>查看来源</button><button type="button" onClick={() => setExecutionSource(undefined)}>取消</button><button disabled={busy}>创建待批准工单</button>
        </form>}
      </section>}
      <div className="room-log" role="log" aria-label="幕僚讨论原话" ref={log} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (room) sessionStorage.setItem(`chief-room-position:${room.session}`, String(el.scrollTop)) }}>
        {!selected && <div className="room-empty"><h2>选一个话题，接着聊。</h2><p>你可以旁听幕僚怎样分工、向谁请教，也可以直接回复其中一位。</p></div>}
        {selected && !room && <p>正在读取原生会话…</p>}
        {room && !!room.tickets?.length && <RoomWorkLinks rows={work} error={workError} openTicket={openTicket} />}
        {room && !room.messages.length && !room.tickets?.length && <p className="room-empty">讨论已建立。说说你想一起研究什么。</p>}
        {room && timeline.map(entry => {
          if ('record' in entry) return <RoomWorkEntry key={`${entry.row.thread_id}:${entry.record.id}`} row={entry.row} message={entry.record} roster={staff} />
          const m = entry.message
          return <article data-author={m.author} key={m.id} id={`source-${m.id}`} tabIndex={-1} className={`room-message ${m.kind}`}><Avatar who={m.author} size={36} working={room.members.some(member => member.name === m.author && member.status === 'running')} /><div><div className="room-by"><b>{name(m.author)}</b><span>{m.to === '当前会话' ? '在自己的会话中回复' : `→ ${name(m.to)}`}</span><time>{new Date(m.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><>{m.replyTo && <button className="room-citation" onClick={() => reveal(m.replyTo!)}>回复 {name(room.messages.find(source => source.id === m.replyTo)?.author ?? '原话')} · 回看引用原话</button>}<Markdown text={m.text} /></><div className="room-message-actions"><button onClick={() => quote(m)}>回复此人</button>{m.author === 'you' && !!roles.length && <button onClick={() => setExecutionSource(m.id)}>用此原话申请执行</button>}<button onClick={() => { setSource(m); setEditing(undefined); setNote(''); setNoteReason(''); setPanel('notes'); setPanelOpen(true) }}>记入讨论笔记</button><details className="room-provenance"><summary>来源</summary><small title={m.session}>原生会话 · {m.seq}</small></details></div></div></article>
        })}
      </div>
      {returnPoint && <button className="room-return-position" onClick={() => { if (log.current) log.current.scrollTop = returnPoint.position; setPanelOpen(returnPoint.panel); if (returnPoint.panel) requestAnimationFrame(() => returnPoint.focus?.focus({ preventScroll: true })); else returnPoint.focus?.focus({ preventScroll: true }); setReturnPoint(undefined) }}>返回刚才阅读的位置</button>}
      {room?.id === selected && <form className="room-compose" onSubmit={e => { e.preventDefault(); void send() }}>{replyTo && <div className="room-reply-preview"><button type="button" onClick={() => reveal(replyTo)}>引用 {name(room.messages.find(m => m.id === replyTo)?.author ?? '原话')}：{room.messages.find(m => m.id === replyTo)?.text.slice(0, 70)}</button><button type="button" aria-label="取消引用" onClick={() => { setReplyTo(undefined); sessionStorage.removeItem(`chief-room-reply:${room.session}`) }}>×</button></div>}<label>对 <select value={target} onChange={e => { setTarget(e.target.value); sessionStorage.setItem(`chief-room-target:${room.session}`, e.target.value) }}>{participants.map(m => <option key={m.key} value={m.key} disabled={!m.available}>{m.label}{m.work ? ' · 追加说明' : ''}</option>)}</select> 说</label>{recipient?.work && <small style={{ width: '100%' }}>补充会交给这项工作的{recipient.label}，沿用原任务的授权与核验。</small>}<textarea aria-label="在讨论中发言" placeholder="补充想法，或指定一位幕僚继续" value={draft} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing && !busy) { e.preventDefault(); void send() } }} onChange={e => { setDraft(e.target.value); sessionStorage.setItem(`chief-room-draft:${room.session}`, e.target.value) }} /><button className="room-primary" disabled={busy || !draft.trim() || !recipient?.available}>发送</button></form>}
    </main>
    <aside className="room-panel"><button className="room-panel-close" onClick={() => setPanelOpen(false)}>返回讨论</button>
      {panel === 'members' ? <><h2>讨论成员</h2>{participants.map(member => <section key={member.key}><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><Avatar who={member.staff} size={36} /><div><b>{member.label}</b><small style={{ display: 'block' }}>{member.detail}</small></div></div>{member.available ? <button onClick={() => { setTarget(member.key); if (room) sessionStorage.setItem(`chief-room-target:${room.session}`, member.key); setPanelOpen(false) }}>{member.work ? '给这项工作追加说明' : '对这位成员说'}</button> : member.work && <button onClick={() => openTicket?.(member.work!.ticket_id)}>查看执行与核验</button>}</section>)}</> : panel === 'notes' ? <><h2>讨论笔记</h2><p className="room-muted">仅用于本次讨论</p>{Object.entries(category).map(([key, label]) => <section key={key}><h3>{label}</h3>{[...new Map(room?.notes.map(n => [n.id, n]) ?? []).values()].filter(n => n.category === key).map(n => <div className="room-note" key={n.id}><p>{n.text}</p>{noteSources.has(n.source) ? <a href={`#source-${n.source}`} onClick={e => { e.preventDefault(); reveal(n.source) }}>回看原话</a> : <span className="room-muted">原话当前不可用</span>}<small> · 修订 {n.version} · {name(n.by ?? '历史记录')}</small>{n.reason && <p className="room-muted">修订原因：{n.reason}</p>}{n.version > 1 && <details><summary>修订历史</summary>{room?.notes.filter(old => old.id === n.id && old.version < n.version).map(old => <div key={old.version}><p>{old.text}</p><small>{name(old.by ?? '历史记录')} · {new Date(old.at).toLocaleString('zh-CN')}{old.reason && ` · ${old.reason}`}</small><button onClick={() => { void action(async () => { await api(`/rooms/${selected}/restore-note`, { session: room?.session, id: n.id, version: n.version, target_version: old.version }); setRoom(await api<RoomView>(`/rooms/${selected}`)) }) }}>恢复修订 {old.version}</button></div>)}</details>}<button onClick={() => { const message = room?.messages.find(m => m.id === n.source); if (message) { setSource(message); setNote(n.text); setKind(n.category); setNoteReason(''); setEditing({ id: n.id, version: n.version }) } }}>修订</button></div>)}</section>)}{source && <form onSubmit={e => { e.preventDefault(); void action(async () => { await api(`/rooms/${selected}/notes`, { session: room?.session, source: source.id, text: note, reason: noteReason || undefined, category: kind, ...editing }); setRoom(await api<RoomView>(`/rooms/${selected}`)); setSource(undefined) }) }}><blockquote>{source.text.slice(0, 160)}</blockquote><select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>{Object.entries(category).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><textarea aria-label="笔记正文" value={note} onChange={e => setNote(e.target.value)} />{editing && <input aria-label="修订原因" placeholder="为什么修订这条笔记？" maxLength={1000} value={noteReason} onChange={e => setNoteReason(e.target.value)} />}<button disabled={busy || !note.trim() || !!editing && !noteReason.trim()}>保存并引用原话</button></form>}<section><h3>执行与核验</h3>{room?.tickets?.length ? room.tickets.map(id => <button key={id} onClick={() => openTicket?.(id)}>查看工作记录 · {id}</button>) : <p className="room-muted">需要正式执行的事项，会连同授权和核验记录留在这里。</p>}</section><section><h3>成员的共享任务</h3>{room?.tasks.map(t => <p key={t.id}>{t.subject}<small> · {({ pending: '待领取', in_progress: '进行中', completed: '已交回', deleted: '已删除' } as Record<string, string>)[t.status] ?? t.status} {t.ownerName && name(t.ownerName)}</small></p>)}</section></> : <><h2>连接器</h2><p className="room-muted">账号与访问申请 · 仅主人可操作</p>{!connections && <p>请在受保护的 DSH 页面管理连接和授权。</p>}{connections && <><CredentialForm service="github" connected={connections.github} run={connectionAction} /><CredentialForm service="feishu" connected={connections.feishu} run={connectionAction} />{connections.requests.filter(r => !r.revoked && (r.state === 'pending' || !r.notified)).map(r => <section key={r.id}><h3>{name(r.staff)}申请读取</h3><b>{r.repository}</b><p>{r.path} · {r.ref}</p><p>{r.purpose}</p><small>只允许一次文件读取 · 30 分钟内有效</small><div><button onClick={() => { void connectionAction('decide', { id: r.id, allow: true }) }}>允许本次</button><button onClick={() => { void connectionAction('decide', { id: r.id, allow: false }) }}>拒绝</button></div></section>)}<FeishuDraft busy={busy} create={connectionAction} />{connections.drafts.map(d => <section key={d.id}><h3>飞书草稿</h3><small>{d.chat} · {d.state === 'unknown' ? '待核对，请检查接收端' : d.state}</small><p>{d.text}</p>{['draft', 'approved'].includes(d.state) && <EditDraft draft={d} run={connectionAction} />}{d.state === 'draft' && <button onClick={() => { void connectionAction('approve', { id: d.id, version: d.version }) }}>批准这版正文与收件人</button>}{d.state === 'approved' && <button onClick={() => { void connectionAction('send', { id: d.id, version: d.version }) }}>发送已批准的草稿</button>}{d.state === 'unknown' && <Reconcile id={d.id} version={d.version} run={connectionAction} />}{d.receipt && <small>回执 {d.receipt}</small>}</section>)}</>}</>}
    </aside>
  </div>
}
function EditDraft({ draft, run }: { draft: ConnectionView['drafts'][number]; run: (verb: string, body: unknown) => Promise<void> }) {
  const [text, setText] = useState(draft.text), [chat, setChat] = useState(draft.chat)
  return <details><summary>编辑草稿</summary><form onSubmit={e => { e.preventDefault(); void run('edit-draft', { id: draft.id, version: draft.version, text, chat }) }}><input aria-label="修改飞书收件会话" value={chat} onChange={e => setChat(e.target.value)} /><textarea aria-label="修改飞书正文" value={text} onChange={e => setText(e.target.value)} /><button disabled={!text.trim() || !chat.trim()}>保存修改并重新批准</button></form></details>
}
function Reconcile({ id, version, run }: { id: string; version: string; run: (verb: string, body: unknown) => Promise<void> }) {
  const [receipt, setReceipt] = useState('')
  return <form onSubmit={e => { e.preventDefault(); void run('reconcile', { id, version, receipt }) }}><input aria-label="接收端消息标识" placeholder="核实已收到后，填消息标识" value={receipt} onChange={e => setReceipt(e.target.value)} /><button disabled={!receipt.trim()}>登记核对结果</button></form>
}
function CredentialForm({ service, connected, run }: { service: string; connected: boolean; run: (verb: string, body: unknown) => Promise<void> }) {
  const [token, setToken] = useState('')
  return <form onSubmit={e => { e.preventDefault(); const value = token; setToken(''); void run('configure', { service, token: value }) }}><h3>{service === 'github' ? 'GitHub' : '飞书'}<small> · {connected ? '已连接' : '未连接'}</small></h3><input type="password" autoComplete="off" value={token} aria-label={`${service} 访问令牌`} placeholder="访问令牌，仅在本机保存" onChange={e => setToken(e.target.value)} /><button disabled={!token.trim()}>连接</button>{connected && <button type="button" onClick={() => { void run('configure', { service, token: '' }) }}>断开</button>}</form>
}
function FeishuDraft({ busy, create }: { busy: boolean; create: (verb: string, body: unknown) => Promise<void> }) {
  const [chat, setChat] = useState(''), [text, setText] = useState('')
  return <form onSubmit={e => { e.preventDefault(); void create('draft', { chat, text }) }}><h3>起草飞书消息</h3><input value={chat} aria-label="飞书收件会话" placeholder="收件会话标识" onChange={e => setChat(e.target.value)} /><textarea value={text} aria-label="飞书正文" placeholder="编辑正文，创建后单独批准" onChange={e => setText(e.target.value)} /><button disabled={busy || !text || !chat}>创建草稿</button></form>
}
const ROOM_CSS = `
.room-owner-actions{flex:none;max-height:42dvh;overflow:auto;padding:8px 20px;background:var(--card,#f7f7f7);border-bottom:1px solid var(--rule,#e5e7eb)}.room-owner-action,.room-execution-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0}.room-owner-action>span,.room-owner-action>label{flex:1 1 180px}.room-owner-actions label{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.room-owner-actions input,.room-owner-actions select{border:1px solid var(--rule,#dce0e7);padding:6px 8px;border-radius:7px;max-width:100%;font:inherit;color:inherit;background:var(--bg,#fff)}.room-owner-actions button{padding:5px 9px;border:1px solid var(--rule,#dce0e7);border-radius:7px;font:inherit;cursor:pointer;color:inherit;background:var(--bg,#fff)}
.chief-surface-content .chief-rooms { z-index: 0; }
.chief-rooms{height:100dvh;position:fixed;inset:0;z-index:1100;background:var(--bg,#fff);color:var(--paper,#18202a);display:grid;grid-template-columns:220px minmax(340px,1fr) 310px;font:15px/1.65 system-ui,"Noto Sans CJK SC",sans-serif}.chief-rooms *{box-sizing:border-box}.chief-rooms button,.chief-rooms input,.chief-rooms textarea,.chief-rooms select{font:inherit;color:inherit}.chief-rooms button{cursor:pointer;border:1px solid var(--rule,#e6e8eb);background:transparent;border-radius:7px;padding:7px 12px}.chief-rooms button:hover{background:var(--raise,#f0f2f4)}.chief-rooms button:disabled{opacity:.45;cursor:default}.chief-rooms input,.chief-rooms textarea{border:1px solid var(--rule,#e6e8eb);border-radius:7px;padding:9px;width:100%;background:var(--bg,#fff)}.chief-rooms h1{font-size:26px;line-height:1.4;margin:0}.chief-rooms h2{font-size:20px;margin:0 0 10px}.chief-rooms h3{font-size:14px;margin:0 0 9px}.chief-rooms p{margin:7px 0}.chief-rooms small,.room-muted{color:var(--dim,#737b85);font-size:12px}.room-nav{padding:28px 18px;background:var(--board,#f6f7f8);border-right:1px solid var(--rule,#e6e8eb);overflow:auto}.room-brand{font-size:23px;font-weight:700;margin-bottom:26px}.room-brand span{color:var(--paper,#18202a)}.room-nav>button{display:block;width:100%;text-align:left;border:0;margin-bottom:5px}.room-nav>small{display:block;margin:25px 12px 12px}.room-nav .selected{background:var(--raise,#e9ecef);font-weight:650}.room-nav form{margin:24px 0}.room-main{min-height:0;min-width:0;display:flex;flex-direction:column}.room-main>header{padding:26px 32px 20px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--rule,#e6e8eb);flex-wrap:wrap}.room-main>header>div{flex:1}.room-main>header p{font-size:12px;color:var(--dim,#737b85)}.room-log{overflow:auto;flex:1;padding:26px 32px}.room-message{display:grid;grid-template-columns:40px minmax(0,1fr);gap:15px;margin-bottom:30px;overflow-wrap:anywhere;scroll-margin:25px}.room-avatar{width:40px;height:40px;display:grid;place-items:center;background:var(--board,#f0f2f4);border-radius:13px;font-family:inherit;font-size:16px;font-weight:600;color:var(--dim,#737b85)}.a-1{background:var(--board,#f0f2f4);color:var(--dim,#737b85)}.a-2{background:var(--board,#f0f2f4);color:var(--dim,#737b85)}.room-by{display:flex;gap:12px;align-items:center;font-size:13px;margin-bottom:8px}.room-by span{color:#75877c}.room-by time{margin-left:auto;font-size:11px;color:#97a198}.room-message-actions{display:flex;gap:10px;align-items:center;margin-top:10px}.room-message-actions button{font-size:11px;border:0;padding:0;color:#58806b}.room-message-actions small{font-size:10px}.room-compose{margin:0 26px 25px;border:1px solid var(--rule,#e6e8eb);border-radius:12px;background:var(--bg,#fff);padding:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.room-compose label{font-size:12px;width:100%;color:#708176}.room-compose select{border:0;background:transparent}.room-compose textarea{flex:1;min-width:0;border:0;min-height:55px;resize:vertical}.chief-rooms .room-primary{background:var(--ink,#18202a);color:var(--on-ink,#fff);border:0}.room-nav-toggle{display:none!important}.room-panel-close{display:none}.room-panel{padding:30px 24px;border-left:1px solid var(--rule,#e6e8eb);background:var(--bg,#fff);overflow:auto}.room-panel section{padding:22px 0;border-top:1px solid var(--rule,#e6e8eb);margin-top:22px}.room-panel form{margin:22px 0}.room-panel button{margin:8px 5px 0 0;font-size:12px}.room-note{font-size:13px;margin:12px 0}.room-note a{color:#2b725f;font-size:12px}.room-error{padding:12px 28px;color:#9b3a36;background:var(--amber-bg,#fff2ed)}.room-empty{color:#819086;padding:35px 0}.room-panel blockquote{font-size:12px;color:#6b7d71;border-left:2px solid #ccd8cd;padding-left:12px;margin:20px 0}.room-panel textarea{margin-top:10px;min-height:90px}
@media(max-width:1100px){.chief-rooms{grid-template-columns:190px minmax(300px,1fr) 260px}.room-main>header,.room-log{padding:20px}.room-panel-close{display:none}.room-panel{padding:24px 18px}}
@media(max-width:760px){.chief-rooms{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);overflow:auto}.room-nav{min-width:0;max-width:100vw;padding:10px 14px;display:flex;gap:7px;align-items:center;overflow-x:auto;border-bottom:1px solid var(--rule,#e6e8eb)}.room-nav>button{width:auto;white-space:nowrap;font-size:12px;margin:0}.room-brand{font-size:15px;white-space:nowrap;margin:0}.room-nav>small,.room-nav form{display:none}.room-nav-toggle{display:block!important}.nav-visible .room-nav{display:block;max-height:45dvh;overflow:auto}.nav-visible .room-nav>button{display:block;width:100%;margin:4px 0}.nav-visible .room-nav form{display:block;margin:12px 0}.nav-visible .room-nav .selected{display:block}.room-nav .selected{display:none}.room-main{min-height:0;height:100%}.room-compose{padding-bottom:max(12px,env(safe-area-inset-bottom))}.room-main>header{padding:18px 16px;gap:8px}.room-main h1{font-size:21px}.room-main>header>button{font-size:11px;padding:5px 8px}.room-log{padding:20px 16px}.room-message{gap:10px;grid-template-columns:32px minmax(0,1fr);margin-bottom:24px}.room-avatar{width:32px;height:32px;font-size:17px}.room-by{flex-wrap:wrap;gap:5px;font-size:12px}.room-by time{font-size:10px}.room-compose{margin:0 12px 15px}.room-panel{display:none;border-top:1px solid var(--rule,#e6e8eb);padding:24px 20px}.panel-visible .room-panel{display:block;position:absolute;inset:0;z-index:2}.room-panel-close{display:block;margin-bottom:20px}.room-panel h2{font-size:18px}.room-message-actions{flex-wrap:wrap}.room-main>header p{font-size:11px}}
`
