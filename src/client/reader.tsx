/**
 * 阅读器：看幕僚交来的文档，逐段批注，最后统一发送。
 *
 * 电脑：鼠标移到段落上，右侧出现"批注"。手机：点段落下方的"批注"，长按保留给原生选文。
 * 批注先存在本机（关掉也不丢），底部栏显示条数；
 * 发出时整理成一条带原文引用的意见交给负责的幕僚——待验收的工单就是"退回修改"。
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DeliveryDiscussion } from './discussions.tsx'
import { useLegacyRequest } from './legacy-scope.ts'
import { V2Client } from './workspace-v2-api.ts'
import { Markdown, type Annotate } from './markdown.tsx'
import { ownerTarget, type OwnerTargetDetail } from './ticket-target.ts'
import { STAGE_LABEL } from './ticket-labels.ts'

type Run = (key: string, path: string, body?: unknown) => Promise<string | undefined>

interface Note { key: string; quote: string; text: string }
interface Detail {
  staffNames?: Record<string,string>
  threadId?: string
  ticket: { id: string; title: string; staff: string; superhub?: OwnerTargetDetail['ticket']['superhub']; assignments: { id: string; deliveries?: { path: string; version: string }[]; report?: { outputs?: string[] } }[] }
  stage: string
  files: { path: string; size: number }[]
  proposal?: { exists: boolean; applyTicket?: string }
}

const noteStorage = (scope: string) => scope ? sessionStorage : localStorage
const loadNotes = (scope: string, key: string): Note[] => { try { return JSON.parse(noteStorage(scope).getItem(key) ?? '[]') as Note[] } catch { return [] } }
const excerpt = (s: string, n = 60) => s.length > n ? `${s.slice(0, n)}…` : s

/** 选默认打开的文件：幕僚汇报里点名的产出优先，其次最大的 Markdown。 */
function pickFile(d: Detail): string | undefined {
  const outputs = d.ticket.assignments.at(-1)?.report?.outputs ?? []
  const named = d.files.find(f => outputs.some(o => o.endsWith(f.path) || f.path.endsWith(o.replace(/^.*?work\//, 'work/'))))
  if (named) return named.path
  const md = d.files.filter(f => f.path.endsWith('.md')).sort((a, b) => b.size - a.size)
  return (md[0] ?? d.files[0])?.path
}

export function Reader({ ticketId, path: initialPath, version: initialVersion, run, staffName: fallbackName, close, openTicket }: { ticketId: string; path?: string; version?: string; run: Run; staffName: (id: string) => string; close: () => void; openTicket?: (id: string) => void }) {
  const { scope } = useContext(V2Client)
  const request = useLegacyRequest()
  const closeButton = useRef<HTMLButtonElement>(null)
  const selectedText = useRef<string | undefined>(undefined)
  const source = useRef<HTMLDivElement>(null)
  const [version, setVersion] = useState(initialVersion)
  const [askQuote, setAskQuote] = useState<{ path: string; quote: string }>()
  const [selectionError, setSelectionError] = useState<string>()
  const [detail, setDetail] = useState<Detail>()
  const staffName = (id: string) => detail?.staffNames?.[id] ?? fallbackName(id)
  const [path, setPath] = useState<string>()
  const [content, setContent] = useState<string>()
  const [error, setError] = useState<string>()
  const notePrefix = scope ? `superhub-v2:draft:${scope}:notes:${ticketId}` : `chief-notes:${ticketId}`
  const noteKey = path && `${notePrefix}:${path}${version ? `:${version}` : ''}`
  const [noteState, setNoteState] = useState<{ key?: string; notes: Note[] }>({ notes: [] })
  const notes = noteState.key === noteKey ? noteState.notes : []
  const setNotes = (next: Note[] | ((current: Note[]) => Note[])) => setNoteState(current => ({ key: noteKey, notes: typeof next === 'function' ? next(current.key === noteKey ? current.notes : []) : next }))
  const [active, setActive] = useState<string>()
  const [draft, setDraft] = useState('')
  const [overall, setOverall] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string>()
  const touch = useMemo(() => typeof matchMedia === 'function' && matchMedia('(hover: none)').matches, [])

  useLayoutEffect(() => {
    const previous = document.activeElement
    closeButton.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [])

  useEffect(() => {
    let current = true
    request<Detail>(`/tickets/${ticketId}`).then(d => { if (current) { setDetail(d); setPath(p => p && d.files.some(f => f.path === p) ? p : initialPath && (d.files.some(f => f.path === initialPath) || (version && d.ticket.assignments.some(a => a.deliveries?.some(f => f.path === initialPath && f.version === version)))) ? initialPath : pickFile(d)) } }, e => { if (current) setError((e as Error).message) })
    return () => { current = false }
  }, [ticketId,request])
  useEffect(() => {
    if (!path || !noteKey) return
    const q = new URLSearchParams({ ticket: ticketId, path, ...version ? { version } : {} })
    if (!scope) history.replaceState(history.state, '', `${location.pathname}${location.search}#delivery?${q}`)
    let current = true
    selectedText.current = undefined
    setContent(undefined); setActive(undefined); setDraft(''); setOverall(''); setError(undefined)
    setNoteState({ key: noteKey, notes: loadNotes(scope, noteKey) })
    request<{ content: string }>(`/tickets/${ticketId}/file?path=${encodeURIComponent(path)}${version ? `&version=${version}` : ''}`).then(r => { if (current) setContent(r.content) }, e => { if (current) setError((e as Error).message) })
    return () => { current = false }
  }, [ticketId, path, version, scope, noteKey, request])
  useEffect(() => {
    if (noteKey && noteState.key === noteKey) {
      try { noteStorage(scope).setItem(noteKey, JSON.stringify(noteState.notes)) } catch { /* 无痕或存储已满时仍能发送批注 */ }
    }
  }, [noteState, noteKey, scope])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (active) setActive(undefined); else close() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, close])

  // Touch toolbars can collapse the browser selection before click. Capture while the range is
  // still in the source, and preserve it through pointer/focus changes into the question composer.
  const captureSelection = useCallback(() => {
    const selection = window.getSelection(), text = selection?.toString().trim()
    if (text && selection?.anchorNode && selection.focusNode && source.current?.contains(selection.anchorNode) && source.current.contains(selection.focusNode) && content?.includes(text)) selectedText.current = text
    return selectedText.current
  }, [content])
  useEffect(() => {
    const capture = () => { captureSelection() }
    document.addEventListener('selectionchange', capture)
    return () => document.removeEventListener('selectionchange', capture)
  }, [captureSelection])

  // 批注框打开时滚到可见位置（手机上它可能落在底部栏后面）
  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => document.querySelector('.wr-reader .md-compose')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60)
    return () => clearTimeout(t)
  }, [active])
  const open = useCallback((key: string) => {
    setActive(key)
    setDraft(notes.find(n => n.key === key)?.text ?? '')
  }, [notes])
  const save = (key: string, quote: string) => {
    const text = draft.trim()
    setNotes(list => text ? [...list.filter(n => n.key !== key), { key, quote, text }] : list.filter(n => n.key !== key))
    setActive(undefined); setDraft('')
  }

  const annotate: Annotate = {
    wrap: (key, quote, node: ReactNode, inline, raw) => {
      const note = notes.find(n => n.key === key)
      const Tag = inline ? 'div' : 'section'
      return <Tag key={key} className={`md-blk ${note ? 'noted' : ''} ${active === key ? 'on' : ''}`}>
        {node}
        <button className="md-ask-btn" onClick={e => { e.stopPropagation(); setAskQuote({ path: path!, quote: (raw ?? quote).trim() }); setActive(undefined) }}>问作者</button>
        {active !== key && <button className={touch ? "md-ask-btn" : "md-note-btn"} onClick={e => { e.stopPropagation(); open(key) }} aria-label="批注这一段">{note ? '改批注' : '批注'}</button>}
        {note && active !== key && <div className="md-note" onClick={() => open(key)} role="button" tabIndex={0}><b>你的批注</b>{note.text}</div>}
        {active === key && <div className="md-compose" onClick={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}>
          <div className="quote">「{excerpt(quote, 80)}」</div>
          <textarea autoFocus rows={3} value={draft} onChange={e => setDraft(e.target.value)} placeholder="这一段要怎么改？"
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(key, quote) }} />
          <div className="row">
            {note && <button className="quiet stop" onClick={() => { setNotes(list => list.filter(n => n.key !== key)); setDraft(''); setActive(undefined) }}>删除</button>}
            <span className="wr-grow" />
            <button className="quiet" onClick={() => { setActive(undefined); setDraft('') }}>取消</button>
            <button className="go" onClick={() => save(key, quote)}>{draft.trim() ? '记下' : '关闭'}</button>
          </div>
        </div>}
      </Tag>
    },
  }

  const review = detail?.stage === 'you/review'
  const hasProposal = detail?.proposal?.exists ?? false
  const send = async (accept: boolean, apply = false) => {
    setSending(true); setError(undefined)
    let message: string | undefined
    if (accept) message = await run(`${ticketId}:accept`, `/tickets/${ticketId}/accept`, { ...apply ? { applyProposal: true } : {}, ...ownerTarget(detail) })
    else {
      const ordered = [...notes].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
      const lines = [`对 ${path}${version ? `（引用版本 ${version}）` : ''} 的批注（${ordered.length} 条）：`, ...ordered.map((n, i) => `${i + 1}. 原文：「${excerpt(n.quote, 70)}」\n   意见：${n.text}`)]
      if (overall.trim()) lines.push(`整体意见：${overall.trim()}`)
      message = await run(`${ticketId}:reply`, `/tickets/${ticketId}/reply`, { text: lines.join('\n'), ...ownerTarget(detail) })
    }
    setSending(false)
    if (message) { setError(message); return }
    if (noteKey) { try { noteStorage(scope).removeItem(noteKey) } catch { /* 不影响提交结果 */ } }
    setNotes([]); setOverall('')
    setSent(accept ? (apply ? '已验收，提案交去执行了，写进第二大脑后会提醒你。' : '已验收。') : `已把批注交给${detail ? staffName(detail.ticket.staff) : '幕僚'}，改好会再请你看。`)
  }

  const md = path?.endsWith('.md') ?? false
  return (
    <div className="wr-reader" role="dialog" aria-label="阅读器">
      <header>
        <button ref={closeButton} className="quiet" onClick={close} aria-label="关闭">关闭</button>
        <div className="title"><b>{detail?.ticket.title ?? ticketId}</b><span>{detail ? `${staffName(detail.ticket.staff)}，${STAGE_LABEL[detail.stage] ?? '进行中'}` : ''}</span></div>
      </header>
      {detail && detail.files.length > 1 && <nav className="files">{detail.files.map(f =>
        <button key={f.path} className={f.path === path ? 'on' : ''} disabled={sending} onClick={() => { setVersion(undefined); setPath(f.path) }}>{f.path.split('/').at(-1)}</button>)}</nav>}
      <div className="wr-reader-tools"><button onPointerDown={e => { captureSelection(); e.preventDefault() }} onMouseDown={e => { captureSelection(); e.preventDefault() }} onClick={() => { const text = captureSelection(); if (text && content?.includes(text)) { setAskQuote({ path: path!, quote: text }); setSelectionError(undefined) } else setSelectionError('请先选择一段连续原文，或点段落旁的“问作者”。') }}>引用提问</button>{selectionError && <span role="status">{selectionError}</span>}</div>
      <div className="body">
        <div className="page">
          {error && <div className="wr-err">{error}</div>}
          {sent ? <div className="done"><b>{sent}</b><button className="go" onClick={close}>关闭交付阅读</button></div>
            : content === undefined ? <div className="wr-empty">{path ? '正在打开…' : '这张工单还没有产出文件。'}</div>
            : md ? <>
              {version && <div className="wr-note">正在阅读存档版本 {version.slice(0, 12)}。批注与提问保留此版本的原引用。</div>}
              <div className="tip">{touch ? '长按选原文后点“引用提问”；段落下方可点“问作者”或“批注”' : '鼠标移到段落上，点"批注"'}，批注会先存着，最后一起发。</div>
              <div ref={source} className="wr-document-content"><Markdown text={content} annotate={annotate} /></div>
            </> : <div ref={source} className="wr-document-content"><pre className="wr-pre">{content}</pre></div>}
          {path && content !== undefined && <DeliveryDiscussion key={`${ticketId}:${path}`} ticketId={ticketId} path={path} version={version} quote={askQuote?.path === path ? askQuote.quote : undefined} clearQuote={() => setAskQuote(undefined)} openTicket={openTicket} />}
        </div>
      </div>
      {!sent && content !== undefined && <footer>
        {notes.length > 0 && <input value={overall} onChange={e => setOverall(e.target.value)} placeholder="整体意见（可不填）" aria-label="整体意见" />}
        <div className="bar">
          <span className="count">{notes.length ? `${notes.length} 条批注` : review ? (hasProposal ? '没问题就验收并执行，提案会写进第二大脑' : '看完没问题就验收') : '还没有批注'}</span>
          {notes.length > 0 && <button className="quiet" onClick={() => { if (confirm('清空这份文档上的全部批注？')) setNotes([]) }}>清空</button>}
          {review && notes.length === 0 && hasProposal && <button className="quiet" disabled={sending || !!active} onClick={() => send(true)}>只验收，不执行</button>}
          {review && notes.length === 0 && <button className="go" disabled={sending || !!active} onClick={() => send(true, hasProposal)}>{hasProposal ? '验收并执行' : '验收'}</button>}
          {active && <span className="count">请先记下或取消当前批注</span>}
           {notes.length > 0 && <button className="go" disabled={sending || !!active} onClick={() => send(false)}>{review ? `退回修改（${notes.length} 条批注）` : `发送 ${notes.length} 条批注`}</button>}
        </div>
      </footer>}
    </div>
  )
}
