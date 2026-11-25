import { useContext, useEffect, useRef, useState } from 'react'
import { V2Client } from './workspace-v2-api.ts'
import { useLegacyRequest } from './legacy-scope.ts'
import { Markdown } from './markdown.tsx'
import { requestId } from './request-id.ts'
import type { ticketThread } from '../dsh/view.ts'

export type TicketThreadView = NonNullable<ReturnType<typeof ticketThread>>
interface Draft { text: string; replyTo: string | null; executionBoundary?: 'local' | 'remote'; requestId?: string; error?: string }
const key = (scope: string, id: string) => scope ? `superhub-v2:draft:${scope}:ticket:${id}` : `chief-ticket-draft:${location.pathname}:${id}`
function restore(scope: string, id: string): Draft {
  try { const d = JSON.parse(sessionStorage.getItem(key(scope,id)) ?? 'null'); if (typeof d?.text === 'string' && (typeof d.replyTo === 'string' || d.replyTo === null)) return d } catch { /* 私密浏览 */ }
  return { text: '', replyTo: null }
}
function save(scope: string, id: string, draft: Draft) {
  try { if (draft.text || draft.error) sessionStorage.setItem(key(scope,id), JSON.stringify(draft)); else sessionStorage.removeItem(key(scope,id)) } catch { /* 保留当前页面中的草稿 */ }
}
const time = (at: string) => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const ROLE = { owner: '你', staff: '幕僚', verifier: '审查官', system: '系统' }
const EXECUTION: Record<string, string> = { running: '执行中', reported: '已汇报', completed: '已完成', interrupted: '已中断', failed: '失败', stopped: '已停止', dsh: '本机幕僚', remote: '工作电脑', 'claude-code': 'Claude Code', codex: 'Codex' }
const APPROVAL: Record<string, string> = { requested: '申请权限', 'allowed-once': '单次批准', rejected: '主人拒绝', expired: '审批过期', cancelled: '申请撤回', 'out-of-scope': '会话或执行范围未授权', unsupported: '申请无法按单条命令审批' }

/** 每张工单自己的记录与执行入口；草稿和请求标识按工单隔离。 */
export function TicketConversation({ id, expectedThreadId, bound, staffName, assignmentStaff, refreshed }: { id: string; expectedThreadId?: string; bound: (threadId: string) => void; staffName: (id: string) => string; assignmentStaff: (id: string) => string | undefined; refreshed: () => void }) {
  const { scope } = useContext(V2Client)
  const request = useLegacyRequest()
  const [view, setView] = useState<TicketThreadView>()
  const [draft, setDraft] = useState<Draft>({ text: '', replyTo: null })
  const [loadError, setLoadError] = useState<string>()
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [allowRemote, setAllowRemote] = useState(false)
  const [reload, setReload] = useState(0)
  const revision = useRef(0)
  const loadedThread = useRef<string | undefined>(undefined)
  const expectedThread = useRef(expectedThreadId)
  expectedThread.current = expectedThreadId
  const alive = useRef(true)
  const end = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const update = (next: Draft) => { if (view) save(scope,view.thread_id, next); setDraft(next); setSent(false) }
  const active = (threadId: string) => alive.current && loadedThread.current === threadId && (!expectedThread.current || expectedThread.current === threadId)
  useEffect(() => {
    alive.current = true
    let current = true, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const readVersion = ++revision.current
      try {
        const next = await request<TicketThreadView>(`/tickets/${id}/thread`)
        if (!current || readVersion !== revision.current) return
        if (expectedThreadId && expectedThreadId !== next.thread_id) {
          loadedThread.current = undefined
          setView(undefined); setLoadError('这条链接属于其他工单记录。请返回全部执行记录重新选择。')
          timer = setTimeout(() => { void poll() }, 3000)
          return
        }
        const restored = loadedThread.current !== next.thread_id ? restore(scope,next.thread_id) : undefined
        loadedThread.current = next.thread_id
        setDraft(previous => {
          const saved = restored ?? previous
          if (saved.requestId && next.messages.some(m => m.request_id === saved.requestId && m.text.trim() === saved.text.trim())) {
            const cleared = { text: '', replyTo: next.reply_to }
            save(scope,next.thread_id, cleared)
            return cleared
          }
          return saved
        })
        setView(next); setLoadError(undefined)
        if (!expectedThreadId) bound(next.thread_id)
      } catch (e) { if (current && readVersion === revision.current) setLoadError((e as Error).message) }
      if (current) timer = setTimeout(() => { void poll() }, 1500)
    }
    void poll()
    return () => { current = false; alive.current = false; clearTimeout(timer) }
  }, [id, reload, expectedThreadId, scope, request])
  useEffect(() => { if (following) end.current?.scrollIntoView({ block: 'nearest' }) }, [view?.messages.length, following])
  const compose = (text: string) => { setAllowRemote(false); update({ text, replyTo: draft.text ? draft.replyTo : view?.reply_to ?? null, executionBoundary: draft.text ? draft.executionBoundary : view?.execution_boundary }) }
  const stale = !!view && !!draft.text && (draft.replyTo !== view.reply_to || draft.executionBoundary !== view.execution_boundary)
  const send = async () => {
    if (!view || !draft.text.trim() || sending || (stale && !draft.requestId) || (draft.executionBoundary === 'remote' && !allowRemote)) return
    const pending = { ...draft, requestId: draft.requestId ?? requestId(), error: undefined }
    update(pending); setSending(true)
    // A slow poll cannot replace the response to this mutation.
    ++revision.current
    try {
      const next = await request<TicketThreadView>(`/tickets/${id}/thread`, { thread_id: view.thread_id, ticket_id: id, reply_to: pending.replyTo, execution_boundary: pending.executionBoundary, allow_remote: allowRemote, request_id: pending.requestId, text: pending.text })
      ++revision.current
      // Reopening this ticket while a request is in flight may produce a newer draft.
      if (restore(scope,view.thread_id).requestId === pending.requestId) save(scope,view.thread_id, { text: '', replyTo: next.reply_to })
      if (active(view.thread_id)) { setDraft({ text: '', replyTo: next.reply_to }); setView(next); setSent(true); setFollowing(true); setAllowRemote(false) }
      refreshed()
    } catch (e) {
      const failed = { ...pending, error: (e as Error).message }
      if (restore(scope,view.thread_id).requestId === pending.requestId) save(scope,view.thread_id, failed)
      if (active(view.thread_id)) setDraft(failed)
    } finally { if (active(view.thread_id)) { setSending(false); setReload(n => n + 1) } }
  }
  return <section className="wr-ticket-conversation" aria-label={`执行记录 ${id}`}>
    <h3>执行记录 <span className="meta">只推进 {id}</span></h3>
    {loadError && <div className="wr-err" role="status">记录暂时未更新：{loadError}<button onClick={() => setReload(n => n + 1)}>重新连接</button></div>}
    {!view && !loadError && <p className="meta">正在读取对话…</p>}
    {view && <>
      <div className="wr-ticket-messages" role="log" aria-label={`${id} 消息记录`} onScroll={e => { const el = e.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 80) }}>
        {view.messages.map(m => {
          const participant = m.role === 'staff' || m.role === 'verifier' ? m.staff_id ?? (m.assignment_id ? assignmentStaff(m.assignment_id) : undefined) : undefined
          return <article key={m.id} className={`wr-ticket-message ${m.role}`} data-message-id={m.id}>
            <div className="by"><b>{participant ? staffName(participant) : ROLE[m.role]}</b><time dateTime={m.at}>{time(m.at)}</time>{m.assignment_id && <span title={m.assignment_id}>派工 {m.assignment_id.slice(0, 8)}</span>}</div>
            <Markdown text={m.text} className="chat" />
            {m.question && m.question !== m.text && <div className="wr-ticket-question"><Markdown text={m.question} className="chat" /></div>}
            {m.choices?.length && m.status === 'question' && m.assignment_id === view.reply_to && view.stage === 'you/answer' && !view.read_only ? <div className="wr-chipset" aria-label="回答建议">{m.choices.map(choice => <button key={choice} disabled={sending} onClick={() => compose(choice)}>{choice}</button>)}</div> : null}
          </article>
        })}
        {!view.messages.length && <p className="wr-empty">后续交办、汇报和核验都会留在这里。</p>}
        <div ref={end} />
      </div>
      {!following && <button className="quiet" onClick={() => { setFollowing(true); end.current?.scrollIntoView({ block: 'nearest' }) }}>查看最新消息</button>}
      <details className="wr-fold"><summary>执行记录（{view.executions.length} 次派工）</summary><ul className="wr-list">{view.executions.map(e => <li key={e.assignment_id}><time>{time(e.started_at)}</time>{EXECUTION[e.executor] ?? e.executor} · {EXECUTION[e.state] ?? e.state} · {e.assignment_id.slice(0, 8)}{e.session_id && <span className="meta"> · 会话 {e.session_id}</span>}
        {e.approvals?.length ? <ul className="wr-list" aria-label="命令审批记录">{e.approvals.map(a => <li key={`${a.id}:${a.status}`}><time>{time(a.at)}</time>{APPROVAL[a.status]} · {a.id.slice(0, 8)}</li>)}</ul> : null}
      </li>)}</ul></details>
      {view.read_only ? <><p className="wr-note">这张工单已结束，对话保留供查阅。</p>{draft.text && <div className="wr-ticket-compose"><label htmlFor={`unsent-${id}`}>保留的未发送草稿</label><textarea id={`unsent-${id}`} readOnly value={draft.text} rows={3} />{draft.error && <div className="wr-err">{draft.error}</div>}</div>}</> : <div className="wr-ticket-compose">
        <label htmlFor={`reply-${id}`}>追加给本工单的执行说明</label>
        <p className="meta">发送目的地：{view.execution_boundary === 'remote' ? '工作电脑' : '本机幕僚'}。{view.reply_to ? `当前派工 ${view.reply_to.slice(0, 8)}` : '等待首次派工'}；批准与验收请使用下方专门按钮。</p>
        <textarea id={`reply-${id}`} rows={3} value={draft.text} disabled={sending} onChange={e => compose(e.target.value)} placeholder="回答问题、补充条件，或说明需要修改什么" />
        {stale && <div className="wr-note">派工或执行目的地已更新，草稿仍保留原来的对象。<button disabled={sending} onClick={() => { setAllowRemote(false); update({ text: draft.text, replyTo: view.reply_to, executionBoundary: view.execution_boundary }) }}>改为当前派工</button></div>}
        {draft.executionBoundary === 'remote' && <label className="wr-remote-consent"><input type="checkbox" checked={allowRemote} disabled={sending} onChange={e => setAllowRemote(e.target.checked)} />我已核对要发给工作电脑的内容</label>}
        {draft.error && <div className="wr-err" role="alert">{draft.error}；草稿已保留。</div>}
        <div className="row"><span className="meta">{sent ? '已交给本工单执行。' : sending ? '正在发送…' : draft.text ? '草稿已保留' : ''}</span><button className="go" disabled={sending || !draft.text.trim() || (stale && !draft.requestId) || (draft.executionBoundary === 'remote' && !allowRemote)} onClick={() => { void send() }}>{draft.requestId ? '重试发送执行说明' : '发送并推进执行'}</button></div>
      </div>}
    </>}
  </section>
}
