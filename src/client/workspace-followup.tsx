import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { CommitmentKind, FollowupView, OrderCommitment, WeeklyReport, WeeklySchedule } from '../core/workspace-followup.ts'
import { messageWorkOrder, orderEnded, type V2Delegation, type V2Session } from '../core/workspace-v2.ts'
import { Markdown } from './markdown.tsx'
import { segment, useV2Read, useV2Write } from './workspace-v2-api.ts'
import { Issue, readableTime, useArchived, V2Dialog } from './workspace-v2-elements.tsx'
import { isFollowupView, isSessionView } from './workspace-v2-response.ts'

const kinds = { mine: '我方承诺', theirs: '对方承诺', request: '待回应请求' } satisfies Record<CommitmentKind, string>
const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const dueLabels = { unscheduled:'', upcoming:'到期', today:'今天到期', overdue:'已逾期', resolved:'已处理' }
type Post = (body: Record<string, unknown>) => Promise<FollowupView | undefined>

function dueLabel(entry: OrderCommitment, timeZone: string) {
  if (!entry.dueAt) return dueLabels[entry.dueState]
  const date = /^\d{4}-\d{2}-\d{2}$/.test(entry.dueAt) ? entry.dueAt : new Date(entry.dueAt).toLocaleString('zh-CN', {
    timeZone, month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false,
  })
  return date + ' · ' + dueLabels[entry.dueState]
}

export function OrderFollowup({ base, job, session, openSource }: {
  base: string; job: V2Delegation; session: V2Session; openSource: (sessionId: string, messageId?: string) => void
}) {
  const path = base + '/orders/' + segment(job.id) + '/followup'
  const query = useV2Read(path, isFollowupView, 15000)
  const write = useV2Write(isFollowupView)
  const [dialog, setDialog] = useState<'record' | 'schedule' | { reportId: string }>()
  const view = query.data
  const archived = useArchived()
  const mutable = !job.paused && !orderEnded(job) && !archived
  const current = view?.reports.find(report => report.week === view.currentWeek)
  const selected = dialog && typeof dialog === 'object' && view?.reports.find(report => report.id === dialog.reportId)
  const schedule = view?.schedule
  const close = () => setDialog(undefined)
  const post: Post = async body => {
    const receipt = await write.post<FollowupView>(path, { ...body, expectedGeneration: job.generation })
    if (receipt) await query.refresh()
    return receipt
  }
  async function openCurrent() {
    if (current) return setDialog({ reportId: current.id })
    const receipt = await post({ action:'draft' })
    const id = receipt?.reportId
    if (id) setDialog({ reportId:id })
  }

  return <div className="v2-followup">
    <Issue text={query.error} retry={query.refresh}/>
    {!view && !query.error && <p className="v2-quiet" role="status">正在读取约定与周报…</p>}
    {view && <div className="v2-columns">
      <section aria-label="跟进约定">
        <div className="v2-section-head"><h2>跟进约定</h2>{mutable &&
          <button type="button" className="v2-link" onClick={() => setDialog('record')}>从会话记录</button>}</div>
        {view.commitments.length ? <ul className="v2-followup-list">{view.commitments.map(entry => <li key={entry.id}>
          <div className="v2-followup-meta"><strong>{kinds[entry.kind]}</strong>{entry.person && <span>{entry.person}</span>}
            <span className={entry.dueState === 'overdue' || entry.dueState === 'today' ? 'v2-followup-due' : undefined}>{dueLabel(entry, view.timeZone)}</span></div>
          <p className="v2-followup-quote">{entry.quote}</p>
          <small>{entry.source.kind === 'liaison' ? '接口人对话' : session.title} · {entry.source.author} · <time dateTime={entry.source.at}>{readableTime(entry.source.at)}</time></small>
          <div className="v2-actions">
            {entry.source.kind === 'session' && entry.source.sessionId === session.id &&
              <button type="button" className="v2-link" onClick={() => openSource(session.id,entry.source.messageId)}>定位原话</button>}
            {mutable && !entry.resolved && <button type="button" className="v2-link" disabled={write.busy}
              onClick={() => { void post({ action:'resolve', id:entry.id }) }}>标记已处理</button>}
          </div>
        </li>)}</ul> : <p className="v2-quiet">本单还没有记录约定。</p>}
      </section>
      <section aria-label="周报">
        <div className="v2-section-head"><h2>周报</h2>{mutable &&
          <button type="button" className="v2-link" onClick={() => setDialog('schedule')}>设置周期</button>}</div>
        {schedule?.enabled && <p className="v2-period">每{weekdays[schedule.weekday]} {schedule.time} · {view.timeZone}{!mutable && ' · 已暂停出稿'}</p>}
        {schedule?.enabled && !mutable && !archived && <button type="button" className="v2-link" disabled={write.busy}
          onClick={() => { void post({ action:'schedule', enabled:false }) }}>停用周期</button>}
        {(current || mutable) && <button type="button" className="v2-button" disabled={write.busy} onClick={() => { void openCurrent() }}>
          {current ? '打开本周周报' : '生成本周周报'}</button>}
        {!current && !mutable && !view.reports.length && <p className="v2-quiet">本单还没有周报。</p>}
        {view.reports.some(report => report.id !== current?.id) && <details className="v2-followup-archive"><summary>往期周报</summary>
          {view.reports.filter(report => report.id !== current?.id).map(report =>
            <button type="button" className="v2-row" key={report.id} onClick={() => setDialog({reportId:report.id})}>{report.title}</button>)}</details>}
      </section>
    </div>}
    {!dialog && <Issue text={write.error}/>}
    {dialog === 'record' && mutable && view && <RecordDialog job={job} path={base + '/sessions/' + segment(session.id)} session={session}
      timeZone={view.timeZone} post={post} busy={write.busy} error={write.error} close={close} openSession={() => openSource(session.id)}/>}
    {dialog === 'schedule' && mutable && view && <ScheduleDialog schedule={view.schedule} timeZone={view.timeZone} jobTitle={job.title}
      post={post} busy={write.busy} error={write.error} close={close}/>}
    {selected && <ReportDialog report={selected} session={session} openSource={openSource} close={close}/>}
    {dialog && typeof dialog === 'object' && !selected && <V2Dialog title="打开周报" close={close}>
      <Issue text={query.error || '正在核对这份周报。'} retry={query.refresh}/></V2Dialog>}
  </div>
}

function RecordDialog({ job, path, session, timeZone, post, busy, error, close, openSession }: {
  job: V2Delegation; path: string; session: V2Session; timeZone: string; post: Post; busy: boolean; error: string; close: () => void; openSession: () => void
}) {
  const transcript = useV2Read(path, isSessionView)
  const view = transcript.data
  const messages = view?.messages.filter(message => message.text.trim() && messageWorkOrder(view.session, message) === job.id) ?? []
  const [messageId, setMessageId] = useState('')
  const [quote, setQuote] = useState('')
  const [person, setPerson] = useState('')
  const source = messages.find(message => message.id === messageId)
  const matches = !!source && !!quote.trim() && quote.trim().length <= 4000 && source.text.includes(quote.trim())
  const knownPerson = !person.trim() || !!source?.text.includes(person.trim())
  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!source || !matches || !knownPerson) return
    const fields = new FormData(event.currentTarget)
    const dueAt = String(fields.get('dueAt') || '')
    if (await post({ action:'record', kind:fields.get('kind'), messageId:source.id, quote:quote.trim(),
      ...(person.trim() && { person:person.trim() }), ...(dueAt && { dueAt }) })) close()
  }
  return <V2Dialog title="从会话记录约定" meta={session.title} close={close}>
    <Issue text={transcript.error || view?.issue} retry={transcript.refresh}/>
    {!view && !transcript.error && <p role="status">正在读取本单发言…</p>}
    {view && !messages.length && <div><p>本单暂时没有可以引用的发言。</p>
      <button type="button" className="v2-link" onClick={openSession}>进入负责会话</button></div>}
    {messages.length > 0 && <form onSubmit={record}>
      <label>选择原发言<select value={messageId} required onChange={event => {
        const id = event.target.value
        const message = messages.find(row => row.id === id)
        setMessageId(id)
        setPerson('')
        setQuote(message && message.text.length <= 4000 ? message.text : '')
      }}><option value="">选择一句原话</option>{[...messages].reverse().map(message =>
        <option key={message.id} value={message.id}>{message.author} · {readableTime(message.at)} · {message.text.slice(0,80)}</option>)}</select></label>
      {source && <><label>引用的原话<textarea required value={quote} rows={3} maxLength={4000} onChange={event => setQuote(event.target.value)}/></label>
        {quote !== source.text && <details className="v2-original" open={source.text.length > 4000 || undefined}><summary>对照原发言</summary><p>{source.text}</p></details>}
        {!matches && quote.trim() && <p className="v2-followup-due" role="status">请保留原发言中连续的一段文字。</p>}</>}
      <label>这句话记作<select name="kind" defaultValue="" required><option value="" disabled>选择约定或请求</option>
        {Object.entries(kinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
      <label>原话中的相关人（选填）<input name="person" maxLength={160} value={person} onChange={event => setPerson(event.target.value)}/></label>
      {!knownPerson && <p className="v2-followup-due" role="status">请沿用原发言中的称呼，也可以留空。</p>}
      <label>到期日期（选填）<input type="date" name="dueAt"/><small>按 {timeZone} 计算</small></label>
      <Issue text={error}/><button className="v2-button primary" disabled={busy || !matches || !knownPerson}>保存约定</button>
    </form>}
  </V2Dialog>
}

function ScheduleDialog({ schedule, timeZone, jobTitle, post, busy, error, close }: {
  schedule: WeeklySchedule | null; timeZone: string; jobTitle: string; post: Post; busy: boolean; error: string; close: () => void
}) {
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    if (await post({ action:'schedule', enabled:true, weekday:Number(fields.get('weekday')), time:fields.get('time') })) close()
  }
  return <V2Dialog title="每周出稿时间" meta={jobTitle} close={close}>
    <form onSubmit={save}><label>每周<select name="weekday" defaultValue={schedule?.weekday ?? 5}>
      {[1,2,3,4,5,6,0].map(day => <option key={day} value={day}>{weekdays[day]}</option>)}</select></label>
      <label>时间（{timeZone}）<input name="time" type="time" required defaultValue={schedule?.time ?? '17:00'}/></label>
      <Issue text={error}/><div className="v2-actions"><button className="v2-button primary" disabled={busy}>保存周期</button>
        {schedule?.enabled && <button type="button" className="v2-link" disabled={busy} onClick={async () => {
          if (await post({ action:'schedule', enabled:false })) close()
        }}>停用周期</button>}</div>
    </form></V2Dialog>
}

function ReportDialog({ report, session, openSource, close }: {
  report: WeeklyReport; session: V2Session; openSource: (sessionId: string, messageId?: string) => void; close: () => void
}) {
  const [copy, setCopy] = useState<'done' | 'manual'>()
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    if (copy === 'manual') { field.current?.focus(); field.current?.select() }
  }, [copy])
  const heading = '# ' + report.title + '\n'
  const body = report.markdown.startsWith(heading) ? report.markdown.slice(heading.length) : report.markdown
  const localSources = report.sources.filter(source => source.kind === 'session' && source.sessionId === session.id)
  return <V2Dialog title={report.title} close={close}>
    <div className="v2-report-body"><Markdown className="v2-markdown" text={body}/></div>
    {localSources.length > 0 && <details className="v2-followup-archive"><summary>回到会话核对</summary>
      {localSources.map(source => <button type="button" className="v2-row" key={source.messageId}
        onClick={() => openSource(session.id,source.messageId)}>{source.author} · {readableTime(source.at)}</button>)}</details>}
    <div className="v2-actions"><button type="button" className="v2-button" onClick={async () => {
      try { await navigator.clipboard.writeText(report.markdown); setCopy('done') }
      catch { setCopy('manual'); field.current?.select() }
    }}>复制全文</button>{copy === 'done' && <span role="status">已复制</span>}</div>
    {copy === 'manual' && <label>原稿已选中，可以复制<textarea ref={field} rows={5} readOnly value={report.markdown}/></label>}
  </V2Dialog>
}
