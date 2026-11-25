/**
 * 幕僚团与事件流。
 *
 * 幕僚团：每个角色一张卡——职责、用什么执行、现在在办什么。点开可以改职责、点名交办。
 * 事件流：系统是事件驱动的。这里能看到有哪些来源、每条事件被怎么处置、理由是什么；
 * 来源可以调成"只记录"，先看它会触发什么，放心了再改成自动。
 */
import { Avatar } from './avatar.tsx'
import { useState } from 'react'
import type { TicketCard, WarroomState } from './api.ts'
import { Seg, Shell } from './drawers.tsx'
import { ModelPicker } from './model-select.tsx'
import { STAGE_LABEL } from './ticket-labels.ts'

type Run = (key: string, path: string, body?: unknown) => Promise<string | undefined>
type StaffRow = WarroomState['staff'][number]

export const EXECUTOR: Record<string, string> = { dsh: 'DSH 子代理', 'claude-code': 'Claude Code', codex: 'Codex', remote: '工作电脑' }
const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
const tap = (fn: () => void) => ({ role: 'button', tabIndex: 0, onClick: fn, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') fn() } })

export function StaffView({ state, openStaff, openTicket }: { state: WarroomState; openStaff: (id: string | 'new') => void; openTicket: (id: string) => void }) {
  return (
    <section className="wr-sec">
      <h2>幕僚团<span className="n">{state.staff.length}</span><button onClick={() => openStaff('new')}>跟接口人说，加一位</button></h2>
      <div className="wr-staff">
        {state.staff.map(s => <div key={s.id} className={`wr-card ${s.doing.length ? 'busy' : ''}`} {...tap(() => openStaff(s.id))}>
          <div className="who"><Avatar who={s.id} size={44} working={!!s.doing.length} /><div><b>{s.name}</b><small>默认：{EXECUTOR[s.executor] ?? s.executor}{s.model ? `，${s.model}${s.reasoningEffort ? `（思考深度 ${s.reasoningEffort}）` : ''}` : ''}{s.available ? '' : '，还没就绪'}</small></div></div>
          <p>{s.brief.split('\n').find(line => line.trim()) ?? '还没有写职责'}</p>
          <div className="now">
            {s.doing.length ? s.doing.slice(0, 2).map(t => <span key={t.id} className="wr-tag need" {...tap(() => openTicket(t.id))} onClickCapture={e => e.stopPropagation()}>{STAGE_LABEL[t.stage] ?? t.stage}：{t.title}{(() => { const task = [...state.active, ...state.you, ...state.queued, ...state.ended].find(row => row.id === t.id); return task?.latest ? ` · 本轮委派：${EXECUTOR[task.latest.executor] ?? task.latest.executor}` : '' })()}</span>)
              : <span className="idle">空闲{s.done ? `，办结过 ${s.done} 件` : ''}</span>}
          </div>
        </div>)}
      </div>
    </section>
  )
}

export function StaffDrawer({ id, state, run, ask, close, openTicket }: { id: string | 'new'; state: WarroomState; run: Run; ask: (text: string) => void; close: () => void; openTicket: (id: string) => void }) {
  const found = state.staff.find(s => s.id === id)
  const [f, setF] = useState<Partial<StaffRow>>(found ?? { executor: 'dsh', verifier: 'reviewer', brief: '' })
  const [task, setTask] = useState('')
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [manual, setManual] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [assigned, setAssigned] = useState(false)
  const tickets: TicketCard[] = [...state.you, ...state.active, ...state.queued, ...state.ended].filter(t => t.staff === id)
  const save = async () => {
    const message = await run('staff', '/staff', { id: f.id ?? '', name: f.name ?? '', executor: f.executor ?? 'dsh', verifier: f.verifier ?? 'reviewer', model: f.model ?? '', reasoningEffort: f.reasoningEffort ?? '', brief: f.brief ?? '' })
    setError(message); setSaved(!message)
    if (!message && !found) close()
  }
  const assign = async () => {
    if (assigning || !task.trim()) return
    setAssigning(true); setAssigned(false)
    try {
      const message = await run('assign', `/staff/${id}/assign`, { text: task })
      setError(message)
      if (!message) { setTask(''); setAssigned(true) }
    } finally { setAssigning(false) }
  }
  return (
    <Shell title={found ? found.name : '添一位幕僚'} close={close} meta={found ? `默认执行器：${EXECUTOR[found.executor] ?? found.executor}，办结过 ${found.done} 件${found.doing.length ? `，手上有 ${found.doing.length} 件` : ''}` : '幕僚是一个有固定职责的子代理。研判官分派任务时会按职责挑人。'}>
      {error && <div className="wr-err">{error}</div>}
      {found && <div className="wr-form">
        <label>点名交给{found.name}<textarea rows={3} value={task} onChange={e => setTask(e.target.value)} placeholder="要办什么事，办到什么程度算完成" /></label>
        <div className="line"><button className="go" disabled={assigning || !task.trim()} onClick={assign}>{assigning ? '正在提交…' : '交办'}</button></div>
      </div>}
      {assigned && <div className="wr-note" role="status">已提交给{found?.name}，正在形成工单。分派结果可在事件流查看，执行进度会出现在台面上。</div>}
      <h3>角色</h3>
      {found && <div className="head" style={{ marginBottom: 8 }}>
        <button className="go" onClick={() => ask(`把「${found.name}」改一下：`)}>让接口人改</button>
        <button className="quiet" onClick={() => setManual(!manual)}>{manual ? '收起' : '自己改'}</button>
      </div>}
      {found && !manual && <pre className="wr-pre">{found.brief}</pre>}
      {(manual || !found) && <div className="wr-form">
        {!found && <div className="line">
          <label>代号（小写字母，例如 analyst）<input value={f.id ?? ''} onChange={e => setF({ ...f, id: e.target.value })} /></label>
          <label>称呼<input value={f.name ?? ''} onChange={e => setF({ ...f, name: e.target.value })} placeholder="例如：数据分析师" /></label>
        </div>}
        <label>职责和做事方式<textarea rows={9} value={f.brief ?? ''} onChange={e => { setF({ ...f, brief: e.target.value }); setSaved(false) }} placeholder="第一行写一句话职责，后面写做事方式。研判官按这里的描述决定把事交给谁。" /></label>
        <div className="line">
          <label>由谁执行<select value={f.executor ?? 'dsh'} onChange={e => { setF({ ...f, executor: e.target.value }); setSaved(false) }}>{Object.entries(EXECUTOR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>谁来核验<select value={f.verifier ?? 'reviewer'} onChange={e => { setF({ ...f, verifier: e.target.value }); setSaved(false) }}>
            {state.staff.filter(s => s.id !== id).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}<option value="none">不核验</option></select></label>
        </div>
        <div className="line">
          <ModelPicker key={`${found?.model ?? ''}|${found?.reasoningEffort ?? ''}`} layout="form" label="模型" value={{ model: f.model ?? '', effort: f.reasoningEffort ?? '' }} onChange={next => { setF({ ...f, model: next.model, reasoningEffort: next.effort }); setSaved(false) }} />
        </div>
        <div className="line"><button className="go" onClick={save}>{found ? '保存角色' : '添进幕僚团'}</button>{saved && <span className="wr-empty">已保存，下一张工单起生效。</span>}</div>
      </div>}
      {found && <><h3>办过的事</h3><p className="meta">角色卡显示默认配置；每轮实际执行器见工作记录，历史不会随配置变化改写。</p>
        {tickets.length ? <ul className="wr-list">{tickets.map(t => <li key={t.id} {...tap(() => openTicket(t.id))} style={{ cursor: 'pointer' }}><time>{t.id}</time>{t.title}<span style={{ color: 'var(--faint)' }}>　{STAGE_LABEL[t.ended?.outcome ?? t.stage] ?? ''}</span></li>)}</ul>
          : <div className="wr-empty">还没有办过事。</div>}</>}
    </Shell>
  )
}

const MODES = [['auto', '自动'], ['observe', '只记录'], ['off', '关闭']] as const
const TONE: Record<string, string> = { accepted: 'tide', attached: 'tide', observed: 'need', unavailable: 'bad', pending: 'need' }

export function EventsView({ state, run, busy, openTicket }: { state: WarroomState; run: Run; busy?: string; openTicket: (id: string) => void }) {
  const [error, setError] = useState<string>()
  const sourceName = (id: string) => state.sources.find(s => s.id === id)?.name ?? ({ system: '系统' } as Record<string, string>)[id] ?? id
  return <>
    <section className="wr-sec">
      <h2>来源<span className="n">{state.sources.length}</span></h2>
      <div className="wr-rows">{state.sources.map(s => <div key={s.id} className="wr-row">
        <span className="lead" />
        <div className="main"><b>{s.name}</b><div className="note">{s.what}</div></div>
        <span className="tail">{s.fixed ? <span>始终开启</span>
          : <Seg value={s.mode} options={MODES} onChange={async v => setError(await run(`src${s.id}`, `/sources/${s.id}`, { mode: v || 'off' }))} />}</span>
      </div>)}</div>
      {error && <div className="wr-err">{error}</div>}
      <div className="wr-empty" style={{ marginTop: 8 }}>"只记录"的来源照常产生事件，但不会动用幕僚团。你可以在下面逐条放行，觉得靠谱了再改成自动。</div>
    </section>
    <section className="wr-sec">
      <h2>定好的跟进<span className="n">{state.timers.length}</span></h2>
      {state.timers.length ? <div className="wr-rows">{state.timers.map(t => <div key={t.id} className="wr-row">
        <span className="lead">{t.at.slice(5).replace('-', '/')}</span>
        <div className="main">{t.text}<div className="note">{t.by}定的</div></div>
        <span className="tail"><button disabled={busy === `tm${t.id}`} onClick={() => run(`tm${t.id}`, `/timers/${t.id}/cancel`)}>取消</button></span>
      </div>)}</div> : <div className="wr-empty">接口人和幕僚会给自己定"到时候回头看一眼"，到点自动触发。现在没有。</div>}
      <div className="wr-empty" style={{ marginTop: 8 }}>{state.push ? '有事等你决定时会推送到你配置的地址，晚上 10 点半到早上 8 点不打扰。' : '还没有配置推送：提醒只会出现在接口人的对话里。在 ~/workspace/dsh/.env 里设置 CHIEF_NOTIFY_URL 后重启即可。'}</div>
    </section>
    <section className="wr-sec">
      <h2>事件<span className="n">{state.events.length}</span></h2>
      {state.events.length ? <div className="wr-rows">{state.events.map(e => <div key={e.id} className="wr-row">
        <span className="lead">{hm(e.at)}</span>
        <div className="main"><span className="src">{sourceName(e.source)}</span><div className="note">{e.text}</div>{e.reason && <div className="why">{e.reason}</div>}</div>
        <span className="tail">
          {e.ticketId ? <button onClick={() => openTicket(e.ticketId!)}>{e.disposition}</button> : <span className={`wr-tag ${TONE[e.kind] ?? ''}`}>{e.disposition}</span>}
          {(e.kind === 'observed' || e.kind === 'unavailable') && <button className="go" disabled={busy === `ev${e.id}`} onClick={() => run(`ev${e.id}`, `/events/${e.id}/evaluate`)}>{e.kind === 'observed' ? '处理这件事' : '再试一次'}</button>}
        </span>
      </div>)}</div> : <div className="wr-empty">还没有事件。</div>}
    </section>
  </>
}
