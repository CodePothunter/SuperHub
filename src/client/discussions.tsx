import { useEffect, useRef, useState } from 'react'
import type { DocumentView, DiscussionView } from '../dsh/discussions.ts'
import { useLegacyRequest } from './legacy-scope.ts'
import { Markdown } from './markdown.tsx'
import { requestId } from './request-id.ts'

export function DeliveryDiscussion({ ticketId, path, version, quote, clearQuote, openTicket }: { ticketId: string; path: string; version?: string; quote?: string; clearQuote: () => void; openTicket?: (id: string) => void }) {
  const request = useLegacyRequest()
  const [document, setDocument] = useState<DocumentView>()
  const [threads, setThreads] = useState<DiscussionView[]>([])
  const [selected, setSelected] = useState<string>()
  const [draft, setDraft] = useState('')
  const [remoteDraft, setRemoteDraft] = useState('')
  const remoteRequest = useRef<{ id: string; text: string; target?: string }>(undefined)
  const [follow, setFollow] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const pending = useRef<{ id: string; text: string; target?: string; quote?: string }>(undefined)
  const panel = useRef<HTMLElement>(null)
  const load = async () => setThreads(await request<DiscussionView[]>(`/discussions?ticket=${encodeURIComponent(ticketId)}&path=${encodeURIComponent(path)}`))
  useEffect(() => {
    let current = true, timer: ReturnType<typeof setTimeout>
    request<DocumentView>(`/tickets/${ticketId}/document?path=${encodeURIComponent(path)}${version ? `&version=${version}` : ''}`).then(d => { if (current) setDocument(d) }, e => { if (current) setError(e.message) })
    const poll = async () => {
      try { const rows = await request<DiscussionView[]>(`/discussions?ticket=${encodeURIComponent(ticketId)}&path=${encodeURIComponent(path)}`); if (!current) return; setThreads(rows); if (globalThis.document.visibilityState === 'visible') timer = setTimeout(() => { void poll() }, rows.some(r => r.pending) ? 1600 : 8000); return } catch (e) { if (current) setError((e as Error).message) }
      if (current && globalThis.document.visibilityState === 'visible') timer = setTimeout(() => { void poll() }, 8000)
    }
    const visible = () => { clearTimeout(timer); if (globalThis.document.visibilityState === 'visible') void poll() }; globalThis.document.addEventListener('visibilitychange', visible)
    void poll(); return () => { current = false; clearTimeout(timer); globalThis.document.removeEventListener('visibilitychange', visible) }
  }, [ticketId, path, version, request])
  useEffect(() => { if (quote) { setSelected(undefined); setDraft(''); pending.current = undefined; panel.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } }, [quote])
  const thread = threads.find(t => t.id === selected)
  const send = async () => {
    if (busy || !draft.trim() || (!thread && !quote)) return
    setBusy(true); setError(undefined)
    const target = thread?.id
    if (!pending.current || pending.current.text !== draft.trim() || pending.current.target !== target || pending.current.quote !== quote) pending.current = { id: requestId(), text: draft.trim(), target, quote }
    const req = pending.current
    try {
      const row = await request<DiscussionView>(target ? `/discussions/${target}` : '/discussions', target ? { requestId: req.id, text: req.text } : { ticketId, path, version: document?.version, quote, requestId: req.id, text: req.text })
      clearQuote(); setSelected(row.id); setDraft(''); pending.current = undefined; await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const sendRemote = async () => {
    if (busy || !remoteDraft.trim() || (!thread && (!quote || !document))) return
    setBusy(true); setError(undefined)
    const target = thread?.id
    if (!remoteRequest.current || remoteRequest.current.text !== remoteDraft.trim() || remoteRequest.current.target !== target) remoteRequest.current = { id: requestId(), text: remoteDraft.trim(), target }
    const req = remoteRequest.current
    try {
      const row = await request<DiscussionView>(target ? `/discussions/${target}/remote` : '/discussions', target ? { requestId: req.id, text: req.text } : { ticketId, path, version: document?.version, quote, requestId: req.id, text: req.text, mode: 'remote' })
      clearQuote(); setSelected(row.id); setRemoteDraft(''); remoteRequest.current = undefined; await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const retry = async () => {
    const last = thread?.messages.filter(m => m.role === 'owner').at(-1)
    if (!last || !thread) return
    setBusy(true)
    try { await request(`/discussions/${thread.id}`, { requestId: last.id, text: last.text }); await load(); setError(undefined) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const convert = async () => {
    if (!thread || !follow.trim()) return
    setBusy(true)
    try { const result = await request<{ ticketId: string }>(`/discussions/${thread.id}/followup`, { text: follow.trim() }); await load(); openTicket?.(result.ticketId) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="wr-discussion" ref={panel} aria-label="交付讨论">
    <h3>交付讨论</h3>
    {document && <p className="meta">{document.remote ? '原作者在工作电脑；默认由中心解读。问工作端作者时，只发你单独核对的问题。' : `与${document.author.name}按原角色讨论`}<br />{document.path} · 版本 {document.version.slice(0, 12)} · {document.assignmentId.slice(0, 8)}</p>}
    {error && <div className="wr-err">{error}</div>}
    <div className="wr-thread-list">{threads.map(t => <button key={t.id} className={selected === t.id ? 'on' : ''} onClick={() => { clearQuote(); setSelected(t.id); setDraft(''); setFollow(''); pending.current = undefined }}>「{t.quote.slice(0, 45)}」 · {t.messages.length} 条{t.pending ? ' · 正在回答' : ''}</button>)}</div>
    {thread && <>
      <blockquote className="wr-pre">{thread.quote}</blockquote><p className="meta">引用版本 {thread.document.version.slice(0, 12)}{thread.document.version !== document?.version ? '（历史版本，保留原引用）' : ''} · {thread.document.author.name}</p>
      {thread.messages.map(m => <div className={`wr-disc-message ${m.role}`} key={m.id}><b>{m.role === 'owner' ? '你' : m.role === 'interpreter' ? '资料解读（非原作者）' : `${thread.document.author.name}${m.via === 'remote' ? '（工作端作者）' : ''}`}</b><Markdown text={m.text} /></div>)}
      {thread.pending && <p role="status">正在回答，关闭页面后仍会保留。</p>}
      {thread.error && <div className="wr-err">{thread.error}{thread.messages.filter(m => m.role === 'owner').at(-1)?.via !== 'remote' && <button disabled={busy} onClick={retry}>重试原问题</button>}</div>}
    </>}
    {(quote || thread) && <div className="wr-form">
      {quote && <blockquote className="wr-pre">{quote}</blockquote>}
      <label>{thread ? '继续追问' : '引用提问'}<textarea rows={3} value={draft} onChange={e => setDraft(e.target.value)} placeholder="想了解依据、取舍或某一处结论？" /></label>
      <div className="row"><button className="go" disabled={busy || !!thread?.pending || (!thread && !document) || !draft.trim()} onClick={send}>发送问题</button><span className="meta">讨论保存在服务端，原工单保持当前状态。</span></div>
      {document?.remote && <div className="wr-form"><label>发给工作端作者的问题（发送前核对）<textarea rows={3} value={remoteDraft} onChange={e => setRemoteDraft(e.target.value)} placeholder="只填写允许发到工作端的问题。引用、讨论历史、私人背景都不会自动发送。" /></label><button disabled={busy || !!thread?.pending || !remoteDraft.trim()} onClick={sendRemote}>把核对后的问题发给工作端作者</button><span className="meta">原任务与派工标识用于找回工作目录；回传核验后保存在这一条讨论。</span></div>}
      {thread && <><label>需要另行推进的工作<textarea rows={2} value={follow} onChange={e => setFollow(e.target.value)} placeholder="写明要推进什么，再显式转成关联跟进工单" /></label><button disabled={busy || !follow.trim()} onClick={convert}>转为关联跟进工单</button>{thread.followUp && <button onClick={() => openTicket?.(thread.followUp!)}>打开跟进 {thread.followUp}</button>}</>}
    </div>}
    {!quote && !thread && <p className="meta">选择原文后点“引用提问”，或点段落旁的“问作者”。历史讨论可随时打开继续。</p>}
  </section>
}
