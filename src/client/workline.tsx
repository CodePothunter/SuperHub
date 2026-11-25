import { useEffect, useRef, useState } from 'react'
import type { WorklineView } from '../dsh/worklines.ts'
import { api } from './api.ts'
import { requestId } from './request-id.ts'
import { STAGE_LABEL } from './ticket-labels.ts'
export function Workline({ id, staff, openTicket, read }: { id: string; staff: { id: string; name: string; executor?: string }[]; openTicket: (id: string) => void; read: (ticketId: string, path: string, version?: string) => void }) {
  const [view, setView] = useState<WorklineView>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [task, setTask] = useState(''), [remoteBrief, setRemoteBrief] = useState(''), [standards, setStandards] = useState('')
  const [who, setWho] = useState(staff.find(s => s.id === 'strategist')?.id ?? staff.find(s => s.executor !== 'remote')?.id ?? '')
  const [ticket, setTicket] = useState(''), [path, setPath] = useState(''), [decision, setDecision] = useState('')
  const pending = useRef<string>(undefined)
  const load = async () => setView(await api<WorklineView>(`/lines/${encodeURIComponent(id)}/work`))
  useEffect(() => { let current = true; const poll = async () => { try { const v = await api<WorklineView>(`/lines/${encodeURIComponent(id)}/work`); if (current) setView(v) } catch (e) { if (current) setError((e as Error).message) } }; void poll(); const t = setInterval(() => { void poll() }, 3000); return () => { current = false; clearInterval(t) } }, [id])
  const act = async (verb: string, body: unknown) => { setBusy(true); setError(undefined); try { const result = await api<{ ticketId?: string }>(`/lines/${encodeURIComponent(id)}/${verb}`, body); await load(); return result } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  return <section className="wr-workline" aria-label="长期事项工作面">
    <h3>长期事项工作面</h3>
    {error && <div className="wr-err">{error}</div>}
    <h4>上次定了什么</h4>{view?.decisions.length ? view.decisions.slice().reverse().map(d => <p className="wr-note" key={d.id}><time>{d.confirmedAt.slice(0, 10)}</time> {d.text}</p>) : <p className="meta">还没有主人确认的决定。</p>}
    <div className="wr-form"><label>确认一项决定<textarea value={decision} onChange={e => setDecision(e.target.value)} rows={2} /></label><button disabled={busy || !decision.trim()} onClick={async () => { if (await act('decision', { text: decision })) setDecision('') }}>记为已确认决定</button></div>
    <h4>现在等谁</h4>{view?.waiting.length ? view.waiting.map(t => <button className="wr-file" key={t.id} onClick={() => openTicket(t.id)}>{t.id} · {staff.find(s => s.id === t.staff)?.name ?? t.staff} · {STAGE_LABEL[t.stage] ?? t.stage} · {t.title}</button>) : <p className="meta">没有关联的在办工单。</p>}
    <h4>等你决定</h4>{view?.needsDecision.length ? view.needsDecision.map(t => <button className="wr-file" key={t.id} onClick={() => openTicket(t.id)}>{t.id} · {STAGE_LABEL[t.stage]} · {t.summary ?? t.title}</button>) : <p className="meta">目前没有待决定事项。</p>}
    <h4>最新证据与交付</h4>{view?.evidence.length ? view.evidence.map(e => <button className="wr-file" key={`${e.path}:${e.version}`} onClick={() => read(e.ticketId, e.path, e.version)}>{e.path.split('/').at(-1)} · {e.ticketId} · {e.version.slice(0, 10)}<span className="meta"> {e.summary}</span></button>) : <p className="meta">关联工单交付后，证据会显示在这里。</p>}
    <h4>关联的新旧工单</h4>{view?.tickets.map(t => <button className="wr-file" key={t.id} onClick={() => openTicket(t.id)}>{t.id} · {t.title} · {STAGE_LABEL[t.stage] ?? t.stage}{t.parent ? ` · 来自 ${t.parent}` : ''}</button>)}
    <div className="wr-form"><label>关联已有工单<input value={ticket} onChange={e => setTicket(e.target.value)} placeholder="T-0001" /></label><label>同时关联交付路径（可选）<input value={path} onChange={e => setPath(e.target.value)} placeholder="work/T-0001/report.md" /></label><button disabled={busy || !ticket.trim()} onClick={async () => { if (await act('link', { ticketId: ticket.trim(), path: path.trim() })) { setTicket(''); setPath('') } }}>显式关联</button></div>
    <h4>从这条线发起工作</h4><div className="wr-form">
      <label>本地负责人<select value={who} onChange={e => { setWho(e.target.value); pending.current = undefined }}>{staff.filter(s => s.executor !== 'remote' && !['chief', 'liaison', 'reviewer'].includes(s.id)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>要推进什么<textarea rows={3} value={task} onChange={e => { setTask(e.target.value); pending.current = undefined }} /></label>
      <label>完成标准（每行一条）<textarea rows={2} value={standards} onChange={e => { setStandards(e.target.value); pending.current = undefined }} placeholder="交付可核验结论与证据，指出限制和下一步" /></label>
      <label>给工作端的任务说明（仅需工作电脑参与时填写）<textarea rows={3} value={remoteBrief} onChange={e => { setRemoteBrief(e.target.value); pending.current = undefined }} placeholder="这段文字将原样发给工作端，请只填写可跨域的目标与允许回传的结论；私人背景留在上方。" /></label>
      <button className="go" disabled={busy || !task.trim() || !who} onClick={async () => { pending.current ??= requestId(); const r = await act('commission', { text: task, staff: who, remoteBrief, doneWhen: standards.trim() ? standards.split('\n').map(s => s.trim()).filter(Boolean) : undefined, requestId: pending.current }); if (r?.ticketId) { setTask(''); setStandards(''); setRemoteBrief(''); pending.current = undefined; openTicket(r.ticketId) } }}>发起并关联工单</button>
    </div>
  </section>
}
