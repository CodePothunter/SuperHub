import { useEffect, useRef, useState } from 'react'
import type { PendingCommand } from '../dsh/approvals.ts'
import type { CommandDecision } from '../dsh/view.ts'
import { api } from './api.ts'
import { Avatar } from './avatar.tsx'

const endpoint = '/settings/approvals'
/** 任一处处理了命令审批后通知其他列表立即刷新（顶部审批栏、等你决定、SuperHub 总览）。 */
export const APPROVALS_CHANGED = 'chief-command-approvals-changed'
const announce = () => window.dispatchEvent(new Event(APPROVALS_CHANGED))
const visible = (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)

export function CommandApprovals() {
  const [rows, setRows] = useState<PendingCommand[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const seenCodex = useRef(new Set<string>())

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const current = await api<PendingCommand[]>(endpoint)
        if (!active) return
        for (const row of current) {
          if (row.executor !== 'codex' || seenCodex.current.has(row.id)) continue
          seenCodex.current.add(row.id)
          setOpen(true)
        }
        setRows(current)
      } catch { /* 页面与旧版本宿主并用时也能继续工作 */ }
    }
    void load()
    const timer = setInterval(load, 2500)
    window.addEventListener(APPROVALS_CHANGED, load)
    return () => { active = false; clearInterval(timer); window.removeEventListener(APPROVALS_CHANGED, load) }
  }, [])

  const decide = async (id: string, allow: boolean) => {
    setBusy(id)
    setError(undefined)
    try {
      await api(endpoint, { id, allow })
      setRows(current => current.filter(row => row.id !== id))
    } catch (failure) { setError((failure as Error).message) }
    finally { setBusy(undefined); announce() }
  }

  if (!rows.length && !error) return null
  return <section className="chief-command-approvals" aria-label="命令权限审批">
    <style>{CSS}</style>
    <button className="chief-command-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M12 22C6 19 4 16 4 11V5l8-3 8 3v6c0 5-2 8-8 11Z"/><path d="M12 7v5m0 3v2"/></svg>
      {rows.length ? `${rows.length} 条命令正在等待权限审批` : '命令权限审批'}<span>{open ? '收起' : '查看'}</span>
    </button>
    {open && <div className="chief-command-list">
      {error && <p role="alert">{error} <button onClick={() => setError(undefined)}>关闭提示</button></p>}
      {rows.map(row => <article key={row.id} aria-label={'命令审批 ' + row.ticket}>
        <div className="chief-command-meta"><Avatar who={row.staffId} size={28} /><div><b>{row.staff}{row.executor === 'codex' && ' · Codex'}</b><span>{row.ticket} · {row.title}</span></div></div>
        {expiry(row.expiresAt) && <time dateTime={row.expiresAt}>{expiry(row.expiresAt)} 前过期</time>}
        <p>{row.reason}</p>
        <p className="chief-command-dir">工作目录 <code dir="ltr">{visible(row.workdir)}</code></p>
        <pre dir="ltr"><code>{visible(row.command)}</code></pre>
        <p>{row.executor === 'codex' ? '批准后，仅这条命令会解除 Codex 沙箱限制，并可以访问当前系统用户有权访问的文件和网络。' : row.mode === 'workspace-write' ? '本次命令可写入 DSH 工作区允许的目录。' : '本次命令解除 DSH 文件沙箱限制，可访问当前系统用户有权限的文件和目录。'}</p>
        <div className="chief-command-actions"><button disabled={busy !== undefined} onClick={() => void decide(row.id, false)}>拒绝</button><button disabled={busy !== undefined} onClick={() => void decide(row.id, true)}>仅允许本次命令</button></div>
      </article>)}
    </div>}
  </section>
}

const expiry = (iso?: string) => {
  const at = iso ? new Date(iso) : undefined
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : undefined
}

/**
 * 「等你决定」里的一条命令审批：哪位幕僚、哪张工单、要运行什么、几点过期，以及单次允许或拒绝。
 * board 用作战台的行样式，hub 用 SuperHub 总览的卡片样式；两处调用同一个审批接口。
 * 处理后广播 APPROVALS_CHANGED，作战台与顶部审批栏据此刷新；settled 只刷新调用方自己的数据。
 */
export function CommandDecisionRow({ row, settled, variant = 'board' }: { row: CommandDecision; settled?: () => void; variant?: 'board' | 'hub' }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const decide = async (allow: boolean) => {
    setBusy(true)
    setError(undefined)
    try { await api(endpoint, { id: row.id, allow }) } catch (failure) { setError((failure as Error).message) } finally { setBusy(false); settled?.(); announce() }
  }
  const until = expiry(row.expiresAt)
  const who = `${row.staff}${row.executor === 'codex' ? '（Codex）' : ''}申请运行命令`
  const where = `${row.ticket} · ${row.title}`
  const full = row.summary !== row.command || row.reason ? <details className="chief-command-more"><summary>完整命令与原因</summary>
    <pre dir="ltr"><code>{visible(row.command)}</code></pre><p>{row.reason}</p><p>工作目录 <code dir="ltr">{visible(row.workdir)}</code></p></details> : null
  const actions = <>
    <button disabled={busy} onClick={() => void decide(false)}>拒绝</button>
    <button className="go" disabled={busy} onClick={() => void decide(true)}>仅允许本次命令</button>
  </>
  const label = `命令审批 ${row.ticket}`
  if (variant === 'hub') return <div className="hub-card chief-command-decision" role="group" aria-label={label}>
    <style>{DECISION_CSS}</style>
    <b>{who}</b>
    <p><code dir="ltr">{visible(row.summary)}</code></p>
    <p className="hub-muted">{where}{until ? ` · ${until} 前未处理将过期，工单转为受阻` : ''}</p>
    {full}
    <div className="hub-actions">{actions}</div>
    {error && <p role="alert">{error}</p>}
  </div>
  return <div className="wr-row need chief-command-decision" role="group" aria-label={label}>
    <style>{DECISION_CSS}</style>
    <span className="lead">命令</span>
    <div className="main"><b>{who}</b><div className="note"><code dir="ltr">{visible(row.summary)}</code></div><div className="src">{where}</div>{full}</div>
    <span className="tail">{until ? `${until} 前过期` : '等待审批'}</span>
    <div className="acts">{actions}</div>
    {error && <div className="wr-err" role="alert" style={{ gridColumn: '2 / -1' }}>{error}</div>}
  </div>
}

const DECISION_CSS = `
.chief-command-decision code{overflow-wrap:anywhere;word-break:break-all}
.chief-command-more{margin-top:4px;font-size:12px}.chief-command-more summary{cursor:pointer;color:var(--surface-dim,inherit)}
.chief-command-more pre{margin:6px 0;padding:8px;border-radius:6px;background:var(--surface-hover,rgba(0,0,0,.04));white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
.chief-command-more p{margin:4px 0;overflow-wrap:anywhere}
`

const CSS = `
.chief-command-approvals{background:var(--dsw-alias-bg-module-platform,#f7f8fa);border-bottom:1px solid var(--surface-rule);color:inherit}
.chief-command-toggle{display:flex;align-items:center;gap:8px;width:100%;border:0;padding:10px 16px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.chief-command-toggle>svg{color:#926127;flex:none}.chief-command-toggle>span{margin-left:auto;color:var(--surface-dim);font-size:12px}
.chief-command-list{display:grid;gap:8px;max-height:50dvh;overflow:auto;padding:0 12px 12px}
.chief-command-list article{padding:12px;border:1px solid var(--surface-rule);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);width:min(100%,900px)}
.chief-command-meta{display:flex;align-items:center;gap:8px}.chief-command-meta>div{display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 9px}.chief-command-meta>div>span,.chief-command-dir{color:var(--surface-dim);font-size:12px;overflow-wrap:anywhere}
.chief-command-list p{margin:8px 0}.chief-command-list pre{margin:8px 0;padding:10px;border-radius:6px;background:var(--surface-hover);white-space:pre-wrap;overflow-wrap:anywhere}
.chief-command-actions{display:flex;justify-content:flex-end;gap:8px}.chief-command-list button{border:1px solid var(--surface-rule);border-radius:6px;padding:5px 10px;font:inherit;color:inherit;background:transparent;cursor:pointer}
.chief-command-actions button:last-child{color:white;background:#3458ce;border-color:#3458ce}.chief-command-list button:disabled{opacity:.6;cursor:wait}
`
