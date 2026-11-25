import { useEffect, useState } from 'react'
import { api } from './api.ts'
import { Avatar } from './avatar.tsx'
import { Markdown } from './markdown.tsx'
import type { TicketThreadView } from './ticket-thread.tsx'
import { STAGE_LABEL } from './ticket-labels.ts'
import { staffName, type RosterName } from './staff-names.ts'

const executors: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', dsh: 'DSH 子代理', spawn: 'DSH 子代理', remote: '工作电脑' }

/** Poll the same records the ticket drawer uses, scoped to the current room. */
export function useRoomWork(session: string | undefined, tickets: string[]) {
  const [result, setResult] = useState<{ session: string; rows: TicketThreadView[]; error: string }>()
  const key = tickets.join('|')
  useEffect(() => {
    if (!session || !tickets.length) return
    let stopped = false, fetching = false
    const refresh = async () => {
      if (fetching) return
      fetching = true
      try {
        const next = await Promise.allSettled(tickets.map(id => api<TicketThreadView>(`/tickets/${encodeURIComponent(id)}/thread`)))
        if (stopped) return
        const failed = next.find(row => row.status === 'rejected')
        setResult(previous => ({ session, error: failed ? String(failed.reason) : '', rows: next.flatMap((row, index) =>
          row.status === 'fulfilled' ? [row.value] : previous?.session === session ? previous.rows.filter(old => old.ticket_id === tickets[index]) : []) }))
      }
      finally { fetching = false }
    }
    void refresh(); const interval = setInterval(() => { void refresh() }, 2000)
    return () => { stopped = true; clearInterval(interval) }
  }, [session, key])
  return result?.session === session && result ? { rows: result.rows.filter(row => tickets.includes(row.ticket_id)), error: result.error } : { rows: [], error: '' }
}

export function RoomWorkLinks({ rows, error, openTicket }: { rows: TicketThreadView[]; error: string; openTicket?: (id: string) => void }) {
  return <section className="room-work-feed" aria-label="关联执行记录">
    <style>{CSS}</style>
    {error && <p role="alert">执行记录暂时未能读取：{error}</p>}
    {!rows.length && !error && <p role="status">正在读取交办与执行记录…</p>}
    {rows.map(row => <div key={row.thread_id} data-work-ticket={row.ticket_id}>
      <header><span className="room-work-dot" /><b>{STAGE_LABEL[row.stage] ?? row.stage}</b><span>{row.title}</span>{openTicket && <button onClick={() => openTicket(row.ticket_id)}>查看执行与核验</button>}</header>
      {row.executions.some(execution => !execution.session_id && execution.state === 'running') && <p className="room-work-capability">{executors[row.executions.at(-1)?.executor ?? ''] ?? row.executions.at(-1)?.executor} 正在处理。这次执行提供结果回传，交回后会显示在这里。</p>}
    </div>)}
  </section>
}

export function RoomWorkEntry({ row, message, roster }: { row: TicketThreadView; message: TicketThreadView['messages'][number]; roster?: readonly RosterName[] }) {
  const initial = message.id.startsWith('event:')
  const execution = row.executions.find(e => e.assignment_id === message.assignment_id)
  const actual = message.role === 'verifier' ? execution?.review?.provider : execution?.provider ?? execution?.executor
  const activation = message.role === 'verifier' ? execution?.review?.activation_id : execution?.activation_id
  const actor = message.role === 'staff' || message.role === 'verifier' ? message.staff_id ?? 'reviewer' : message.role === 'owner' && !initial ? 'you' : 'lead'
  const label = initial ? '交办记录' : message.role === 'system' ? '执行状态' : message.role === 'owner' ? '你 · 工单回复' : message.role === 'verifier' ? `${staffName(actor, roster)} · 独立核验` : `${staffName(actor, roster)} · 结果回传`
  return <article className="room-work-entry" data-work-ticket-id={row.ticket_id} data-work-source={message.id}>
    <Avatar who={actor} size={34} /><div><div className="room-work-by"><b>{label}</b><small>{row.ticket_id}</small>{actual && actor !== 'you' && <small>实际：{executors[actual] ?? actual}</small>}<time>{new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
      {message.role === 'owner' && !initial ? <div className="room-work-text">{message.text}</div> : <Markdown text={message.text} />}{message.question && <p>{message.question}</p>}
      <details><summary>记录来源</summary><small>{row.ticket_id} · {message.assignment_id ?? message.id}{activation && ` · ${activation}`}</small></details>
    </div>
  </article>
}
const CSS = `
.room-work-feed{margin-bottom:24px}.room-work-feed>div>header{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:0 0 12px;color:var(--chief-muted,#777);font-size:11px}.room-work-feed>div>header>b{color:var(--chief-text,#222)}.room-work-feed>div>header>span:nth-last-child(2){flex:1;min-width:80px}.room-work-feed>div>header>button{font-size:10px;border-radius:999px;padding:4px 8px}.room-work-dot{width:5px;height:5px;background:var(--chief-accent,#4d6bfe);border-radius:50%;flex:none}.room-work-capability{font-size:12px;color:var(--chief-muted,#777);padding:8px 12px;border:1px solid var(--chief-line,#eee);border-radius:10px;margin-bottom:18px!important}.room-work-entry{display:grid;grid-template-columns:34px minmax(0,1fr);gap:12px;margin-bottom:20px;overflow-wrap:anywhere}.room-work-by{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:6px;font-size:12px}.room-work-by>time{margin-left:auto;font-size:10px;color:var(--chief-muted,#777)}.room-work-entry .md,.room-work-text{background:var(--chief-bubble,#eee);border-radius:6px 16px 16px 16px;padding:9px 13px;display:inline-block;max-width:100%;font-size:14px;line-height:1.75}.room-work-text{white-space:pre-wrap}.room-work-entry .md>p:first-child{margin-top:0}.room-work-entry .md>p:last-child{margin-bottom:0}.room-work-entry details{margin-top:7px;font-size:10px;color:var(--chief-muted,#777)}.room-work-entry details>small{display:block;overflow-wrap:anywhere}
`
