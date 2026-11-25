import { useEffect, useRef, useState } from 'react'
import type { SuperhubEvent } from '../dsh/superhub-trace.ts'
import type { HubNav, HubPlace } from './superhub.tsx'
import { ReadIssue } from './superhub-common.tsx'
import { Markdown } from './markdown.tsx'
import { COVERAGE_LABEL, CRITERION_LABEL, STAGE_LABEL, hubRead, localInput, scopedPath, timeLabel, useHubAction, useHubQuery, type CurrentMission, type EvidenceResult } from './superhub-api.ts'

const VERIFY_LABEL: Record<string, string> = {
  completed: '具名核验已返回', skipped: '按配置跳过独立核验', failed: '核验调用失败',
  unverified: '独立核验尚未证实', invalidated: '原核验结论已失效',
}
const DIMENSION_LABEL: Record<string, string> = {
  business: '工单状态', participants: '已知参与者', sessions: '原生会话', tools: '工具事件', toolPayloads: '工具内容',
  handoffs: '消息交接', remote: '工作端', deliveries: '交付证据', storage: '观察记录',
}
export const INSTANCE_LABEL: Record<string, string> = {
  running: '运行中', reported: '已汇报', completed: '已返回', failed: '失败', cancelled: '已请求停止',
  interrupted: '中断', 'stop-requested': '已请求停止，仍待确认',
}
const ACTION_LABEL: Record<string, string> = {
  reply: '发送补充', requestEvidence: '请求补证', approve: '批准当前契约',
  accept: '确认验收', acceptDeviation: '明确接受偏差', reviseContract: '保存新版契约', stop: '停止工单', retry: '重试',
}

export function ScopedEvidence({ scope, ticket, id, active, go }: { scope: string; ticket: string; id: string; active: boolean; go: HubNav }) {
  const result = useHubQuery<EvidenceResult>(scope, scopedPath(scope, `evidence/${encodeURIComponent(ticket)}/${encodeURIComponent(id)}`), undefined, active)
  const proof = result.data?.evidence
  return <section className="hub-section hub-evidence-reader">
    <ReadIssue error={result.error} at={result.readAt} retry={() => void result.refresh()} />
    {proof ? <><h3>{proof.title}</h3>
      <p className="hub-muted">{proof.path?.split(/[\\/]/).at(-1) ?? ticket} · {COVERAGE_LABEL[proof.availability] ?? proof.availability}{proof.historical ? ' · 历史版本' : ''}</p>
      {result.data?.content !== undefined ? <article className="hub-evidence-document" aria-label="交付正文"><Markdown text={result.data.content} /></article>
        : <div className="hub-evidence-empty"><p>{proof.kind === 'native'
          ? '这里保留了事件的时间、工具和处理状态。原始对话与工具内容已脱敏，没有可供阅读的正文。'
          : proof.kind === 'receipt' ? '这是一条工作端回传回执，可在执行记录中核对接收与处理情况。'
          : `这份交付目前${COVERAGE_LABEL[proof.availability] ?? '无法读取'}。可以返回工单查看汇报和其他版本。`}</p>
          <button onClick={() => go({ page: 'mission', id: ticket, ...(proof.eventId ? { event: proof.eventId } : {}) })}>{proof.eventId ? '查看对应执行记录' : '返回工单结果'}</button>
        </div>}
      <details className="hub-evidence-details"><summary>原文与版本信息</summary>
        <p className="hub-muted">{ticket} · {timeLabel(proof.at)}</p>
        {proof.path && <p>{proof.path}</p>}
        {proof.version && <p className="hub-muted">证据版本 {proof.version}</p>}
        {proof.method && <p>来源 {proof.method}</p>}
        {proof.historical && <p>这是历史派工的证据。</p>}
        {result.data?.content !== undefined && <pre className="hub-text hub-evidence-source" tabIndex={0}>{result.data.content}</pre>}
      </details>
    </> : !result.error && <p role="status">正在读取登记的证据版本…</p>}
  </section>
}

function MissionActions({ scope, data, refresh, legacy, retryRead, connected }: { scope: string; data: CurrentMission; refresh: () => Promise<unknown>; legacy: () => void; retryRead: () => void; connected: boolean }) {
  const state = useHubAction(scope)
  const [form, setForm] = useState('')
  const [text, setText] = useState(''), [accepted, setAccepted] = useState(false), [success, setSuccess] = useState('')
  const contractVersion = data.currentTarget?.contractVersion
  const [criteria, setCriteria] = useState(data.contract?.criteria.map(row => ({ id: row.id, text: row.text, required: row.required })) ?? [])
  const target = data.currentTarget
  if (!target) return <p className="hub-muted">{data.mode === 'replay' ? '当前是历史回放。切回当前状态后可操作。'
    : <>读取期间工单发生变更。<button onClick={retryRead}>刷新工单</button></>}</p>
  if (!contractVersion) return <div className="hub-actions"><button onClick={legacy}>在原工单查看或处理</button></div>
  if (data.ticket.stage === 'ended') return null
  if (!connected) return <div className="hub-actions"><button onClick={retryRead}>重新读取当前工单后操作</button></div>
  const remote = target.executionBoundary === 'remote'
  const inputAction = form === 'reply' || form === 'requestEvidence' || form === 'reviseContract' || form === 'acceptDeviation' || form === 'stop'
  const run = async (action: string) => {
    setSuccess('')
    const result = await state.run(`mission/${data.ticket.id}`, {
      ...target, action, allowRemote: accepted,
      ...action === 'reply' || action === 'requestEvidence' ? { text: action === 'requestEvidence' ? `请补充可核验的证据。具体需要：${text.trim()}` : text } : {},
      ...action === 'reviseContract' ? { criteria: criteria.map(({ id, ...criterion }) => ({ ...id ? { id } : {}, ...criterion })) } : {},
      ...['stop', 'acceptDeviation', 'reviseContract'].includes(action) ? { reason: text } : {},
    })
    if (result) { setForm(''); setText(''); setAccepted(false); setSuccess(`${ACTION_LABEL[action]}已受理`); await refresh() }
  }
  const choose = (action: string) => { setForm(form === action ? '' : action); setText(''); setSuccess('') }
  const canRevise = !['working', 'remote', 'verifying', 'waiting'].includes(data.ticket.stage)
  const acceptanceReady = !data.outputsChanged && data.criteria.filter(row => row.required).every(row => row.status === 'pass') && data.verification?.status === 'completed'
  return <section className="hub-section">
    <h3>当前工单操作</h3>
    {remote && <label className="hub-check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />同意向工作电脑发送本次授权或补充</label>}
    <div className="hub-actions">
      {data.ticket.stage === 'you/approve' && <button className="hub-primary" disabled={state.busy || (remote && !accepted)} onClick={() => void run('approve')}>批准当前契约</button>}
      {data.ticket.stage === 'you/review' && <button className="hub-primary" disabled={state.busy || !acceptanceReady} onClick={() => void run('accept')}>确认验收</button>}
      {data.ticket.stage === 'you/blocked' && <button disabled={state.busy} onClick={() => void run('retry')}>重试</button>}
      <button disabled={state.busy} onClick={() => choose('reply')}>{data.ticket.stage === 'you/answer' ? '回答问题' : '补充或返工'}</button>
    </div>
    <details className="hub-action-more"><summary>更多处理方式</summary><div className="hub-actions">
      <button disabled={state.busy} onClick={() => choose('requestEvidence')}>请求补证</button>
      {data.ticket.stage === 'you/review' && <button disabled={state.busy} onClick={() => choose('acceptDeviation')}>明确接受偏差</button>}
      {canRevise && <button disabled={state.busy} onClick={() => choose('reviseContract')}>修订验收标准</button>}
      <button disabled={state.busy} onClick={() => choose('stop')}>停止</button>
    </div></details>
    {inputAction && <form onSubmit={e => { e.preventDefault(); void run(form) }}>
      {form === 'reviseContract' && <div>
        {criteria.map((row, index) => <div className="hub-card" key={row.id || index}>
          <label>标准 {index + 1}<input value={row.text} maxLength={600} onChange={e => setCriteria(items => items.map((item, i) => i === index ? { ...item, text: e.target.value } : item))} /></label>
          <label className="hub-check"><input type="checkbox" checked={row.required} onChange={e => setCriteria(items => items.map((item, i) => i === index ? { ...item, required: e.target.checked } : item))} />必要条件</label>
        </div>)}
      </div>}
      <label>{form === 'reply' ? '说明或回答' : form === 'requestEvidence' ? '希望补充的证据' : '理由'}
        <textarea value={text} maxLength={form === 'reply' || form === 'requestEvidence' ? 7800 : 2000} onChange={e => setText(e.target.value)} /></label>
      <button className="hub-primary" disabled={!text.trim() || state.busy || ((form === 'reply' || form === 'requestEvidence') && remote && !accepted) || (form === 'reviseContract' && (!criteria.length || criteria.some(row => !row.text.trim())))}>{ACTION_LABEL[form]}</button>
    </form>}
    {success && <p role="status">{success}</p>}
    <ReadIssue error={state.error} />
  </section>
}

function Timeline({ data, items, more, go, at, expandedEvent }: { data: CurrentMission; items: SuperhubEvent[]; more?: () => void; go: HubNav; at?: string; expandedEvent?: string }) {
  const [expanded, expand] = useState(() => new Set(expandedEvent ? [expandedEvent] : []))
  return <>
    {!items.length && <p className="hub-muted">当前筛选没有可读取的轨迹。</p>}
    <ol className="hub-list hub-events">{items.map(event => <li key={event.id} data-event-id={event.id}><details open={expanded.has(event.id)} onToggle={e => {
      const open = e.currentTarget.open
      if (open !== expanded.has(event.id)) expand(rows => { const next = new Set(rows); if (open) next.add(event.id); else next.delete(event.id); return next })
    }}>
      <summary><b>{event.title}</b> <span className="hub-muted">· {data.roles.find(role => role.id === event.roleId)?.name ?? (event.roleId === 'owner' ? '你' : event.roleId === 'system' ? '系统' : event.roleId ?? '未归属')} · {timeLabel(event.at)}</span></summary>
      <div className="hub-card"><p>{event.type}{event.state ? ` · ${event.state}` : ''}{event.round !== undefined ? ` · 第 ${event.round + 1} 轮` : ''}{event.contractVersion ? ` · 契约 v${event.contractVersion}` : ''}</p>
        {event.observedAt && <p>观察时点 {timeLabel(event.observedAt)}</p>}
        {event.native && <p>会话序号 {event.native.seq}{event.native.turn !== undefined ? ` · 回合 ${event.native.turn}` : ''}{event.native.tool ? ` · 工具 ${event.native.tool}` : ''}{event.native.redacted ? ' · 已脱敏' : ''}{event.native.ownerAttribution ? ' · 主人来源未证实' : ''}</p>}
        {event.handoff && <p>发送 {event.handoff.sent === 'confirmed' ? '已证实' : '未知'} · 收到 {event.handoff.delivered === 'confirmed' ? '已证实' : '未知'} · 处理 {event.handoff.processed === 'confirmed' ? '已证实' : '未知'}</p>}
        <div className="hub-actions">{event.causes.map((id, i) => <button key={id} onClick={() => go({ page: 'mission', id: data.ticket.id, event: id, at })}>因果依据 {i + 1}</button>)}
          {event.evidenceIds.map(id => <button key={id} onClick={() => go({ page: 'evidence', id: data.evidence.find(ref => ref.id === id)?.ticketId ?? event.ticketId, evidence: id })}>查看证据版本</button>)}</div>
      </div>
    </details></li>)}</ol>
    {more && <button type="button" onClick={more}>读取更早轨迹</button>}
  </>
}

export function Mission({ scope, place, go, legacyTicket, refreshBoard, active }: { scope: string; place: Extract<HubPlace, { page: 'mission' }>; go: HubNav; legacyTicket: (id: string) => void; refreshBoard: () => void; active: boolean }) {
  const [draft, setDraft] = useState({ role: '', round: '', q: '', type: '', status: '', criterion: '', from: '', to: '' })
  const [filters, setFilters] = useState<Record<string, string | undefined>>({})
  const [replay, setReplay] = useState(place.at ? localInput(place.at) : localInput(new Date().toISOString()))
  const [following, setFollowing] = useState(!place.at && !place.event)
  const [pinned, setPinned] = useState<CurrentMission>()
  const [older, setOlder] = useState<SuperhubEvent[]>([])
  const [next, setNext] = useState<string>()
  const [pagesStarted, setPagesStarted] = useState(false)
  const [pageError, setPageError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [timelineOpen, setTimelineOpen] = useState(!!(place.event || place.instance))
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [criteriaOpen, setCriteriaOpen] = useState<boolean>()
  const timelineSection = useRef<HTMLDetailsElement>(null), timelineHeading = useRef<HTMLHeadingElement>(null)
  const positioned = useRef(false)
  const address = scopedPath(scope, `mission/${place.id}`, { ...filters, at: place.at, instance: place.instance, event: place.event })
  const current = useHubQuery<CurrentMission>(scope, address, place.at || place.event ? undefined : 4500, active)
  const liveCount = useHubQuery<CurrentMission>(scope, scopedPath(scope, `mission/${place.id}`, { limit: 1 }), 4500, active && !!place.at)
  const pageGeneration = useRef(0)
  useEffect(() => {
    if (following || !current.data) return
    setPinned(previous => previous ?? current.data)
  }, [current.data, following])
  const data = following ? current.data : pinned ?? current.data
  useEffect(() => {
    if (!active || !data || positioned.current || !(place.event || place.instance)) return
    const frame = requestAnimationFrame(() => {
      const event = place.event && [...(timelineSection.current?.querySelectorAll<HTMLElement>('[data-event-id]') ?? [])].find(row => row.dataset.eventId === place.event)
      const target = event ? event.querySelector<HTMLElement>('summary') : timelineHeading.current
      if (!target) return
      target.scrollIntoView({ block: 'start' }); target.focus({ preventScroll: true }); positioned.current = true
    })
    return () => cancelAnimationFrame(frame)
  }, [active, data, place.at, place.event, place.instance])
  const newerThanReplay = place.at && data && liveCount.data ? Math.max(0, liveCount.data.timeline.total - data.timeline.total) : 0
  const newEvents = pinned && current.data ? Math.max(0, current.data.timeline.matched - pinned.timeline.matched) : 0
  const canLoad = pagesStarted ? next : data?.timeline.nextCursor
  const criteriaRef = useRef<HTMLHeadingElement>(null)
  const setField = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }))
  const reset = () => {
    ++pageGeneration.current
    setPinned(undefined); setOlder([]); setNext(undefined); setPagesStarted(false); setPageError(undefined); setLoading(false)
  }
  const followLatest = () => { reset(); setFollowing(true); void current.refresh() }
  const loadOlder = async () => {
    if (!canLoad || loading || !data) return
    const generation = ++pageGeneration.current
    setLoading(true); setPageError(undefined); setFollowing(false); setPinned(data)
    try {
      const value = await hubRead<CurrentMission>(scope, `${address}&cursor=${encodeURIComponent(canLoad)}`)
      if (generation !== pageGeneration.current) return
      setOlder(rows => [...rows, ...value.timeline.items.filter(row => !rows.some(item => item.id === row.id))])
      setNext(value.timeline.nextCursor); setPagesStarted(true)
    } catch (error) {
      if (generation === pageGeneration.current) setPageError((error as Error).message)
    } finally {
      if (generation === pageGeneration.current) setLoading(false)
    }
  }
  if (!data) return <section className="hub-section"><ReadIssue error={current.error} at={current.readAt} retry={() => void current.refresh()} />{!current.error && <p role="status">正在读取执行轨迹…</p>}</section>
  const refresh = async () => { await current.refresh(); refreshBoard() }
  const rows = [...data.timeline.items, ...older]
  const stopping = data.instances.filter(instance => !!instance.termination && (!instance.historical || instance.status === 'stop-requested'))
  const awaitingStop = stopping.filter(instance => instance.termination === 'unconfirmed').length
  const selectedInstance = place.instance ? data.instances.find(row => row.id === place.instance) : undefined
  const deliveries = data.evidence.filter(ref => ref.ticketId === place.id && ref.kind === 'delivery' && ref.assignmentId === data.assignmentId)
  const openInstance = (instance: CurrentMission['instances'][number]) => {
    if (place.instance !== instance.id) { go({ page: 'mission', id: instance.ticketId, instance: instance.id, at: place.at }); return }
    setTimelineOpen(true)
    requestAnimationFrame(() => { timelineHeading.current?.scrollIntoView({ block: 'start' }); timelineHeading.current?.focus({ preventScroll: true }) })
  }
  return <div className="hub-mission">
    <section className="hub-section hub-mission-result">
      <div className="hub-item-title"><h3>{data.ticket.title}</h3><span className="hub-state">{STAGE_LABEL[data.ticket.outcome ?? data.ticket.stage] ?? data.ticket.stage}</span></div>
      {data.ticket.title.length > 120 && <details className="hub-mission-full-title"><summary>完整交办标题</summary><p>{data.ticket.title}</p></details>}
      <p className="hub-muted">{data.ticket.id} · 执行角色 {data.roles.find(role => role.id === data.ticket.staff)?.name ?? data.ticket.staff}
        {place.at && <> · 回放至 {timeLabel(place.at)}</>}</p>
      <ReadIssue error={current.error} at={current.readAt} retry={() => void current.refresh()} />
      {data.report && <div className="hub-result-report"><h4>工作结果</h4>
        {data.report.summary.length > 240 ? <><p>{data.report.summary.slice(0, 240)}…</p><details><summary>查看完整汇报</summary><Markdown text={data.report.summary} /></details></>
          : <Markdown text={data.report.summary} />}</div>}
      {!!deliveries.length && <ul className="hub-delivery-list">{deliveries.map(ref => <li key={ref.id}>
        <button className={ref.availability === 'available' ? 'hub-primary' : undefined} onClick={() => go({ page: 'evidence', id: ref.ticketId, evidence: ref.id })}>
          {ref.availability === 'available' ? '查看结果' : '查看交付状态'} · {ref.path?.split(/[\\/]/).at(-1) ?? ref.title}
        </button>{(place.at || ref.historical) && <span className="hub-muted">历史版本</span>}
        {ref.availability !== 'available' && <span className="hub-muted">{COVERAGE_LABEL[ref.availability] ?? ref.availability}</span>}
      </li>)}</ul>}
      {!data.report && !deliveries.length && <p className="hub-muted">{data.ticket.stage === 'ended' ? '这张工单未登记可读取的结果。执行记录中保留了已知过程。' : '尚未收到本轮结果。新的汇报和已登记交付会显示在这里。'}</p>}
      {data.outputsChanged && <p className="hub-error" role="status">相关产物已变化，需重新核验。历史版本仍可读取。</p>}
      {data.report?.question && <p><b>等主人回答</b> · {data.report.question}</p>}
      {data.ownerAcceptance && <p>{data.ownerAcceptance.kind === 'deviation' ? `主人接受偏差 · ${data.ownerAcceptance.reason}` : '主人已确认验收'} · {timeLabel(data.ownerAcceptance.at)}</p>}
      {data.ticket.outcome === 'stopped' && stopping.length > 0 && <p className="hub-muted">已登记停止 · {stopping.length - awaitingStop} 个实例确认终止，{awaitingStop} 个实例终止待确认</p>}
      {data.waiting.map(row => <div className="hub-card" key={`${row.kind}:${row.target}`}><b>{row.kind === 'child' ? '等待 ' : ''}{row.label}</b><p>{row.until}</p></div>)}
      {!!data.relatedTickets.length && <ul className="hub-list">{data.relatedTickets.map(ticket => <li key={ticket.id}>
        <button onClick={() => go({ page: 'mission', id: ticket.id, at: place.at })}>{ticket.title} · {STAGE_LABEL[ticket.outcome ?? ticket.stage] ?? ticket.stage}</button>
        {ticket.criterionText ? <p className="hub-muted">原标准 · {ticket.criterionText}{ticket.criterionVersion ? ` · 契约 v${ticket.criterionVersion}` : ''}</p>
          : ticket.criterion !== undefined && <p className="hub-muted">登记了原序号 {ticket.criterion + 1}，原标准文字未证实。</p>}
      </li>)}</ul>}
      <div className="hub-actions">
        <button onClick={() => { setCriteriaOpen(true); requestAnimationFrame(() => { criteriaRef.current?.scrollIntoView({ block: 'start' }); criteriaRef.current?.focus({ preventScroll: true }) }) }}>跳到验收标准</button>
        {data.sourceReceiptId && <button onClick={() => go({ page: 'intake', id: data.sourceReceiptId })}>查看主人原话与交办回执</button>}
        {(place.at || place.event || place.instance) && <button onClick={() => go({ page: 'mission', id: place.id })}>查看当前工单</button>}
      </div>
    </section>
    {place.at || place.event ? <p className="hub-muted">历史记录 · <button onClick={() => go({ page: 'mission', id: place.id })}>切回当前工单</button></p>
      : !following ? <p className="hub-muted">阅读位置已固定。<button onClick={followLatest}>恢复最新工单操作</button></p>
      : <MissionActions key={`${data.ticket.id}:${data.currentTarget?.contractVersion ?? ''}:${data.currentTarget?.assignmentId ?? ''}`} scope={scope} data={data} refresh={refresh} legacy={() => legacyTicket(place.id)} retryRead={() => void current.refresh()} connected={!current.error} />}
    <div className="hub-columns">
      <div>
        <details className="hub-section hub-disclosure" open={criteriaOpen ?? (!!place.at || ['you/review', 'you/approve', 'you/blocked'].includes(data.ticket.stage))} onToggle={e => setCriteriaOpen(e.currentTarget.open)}>
          <summary><h3 ref={criteriaRef} tabIndex={-1}>验收标准{data.contract ? ` · 契约 v${data.contract.version}` : ''}</h3><span className="hub-muted">{data.criteria.filter(row => row.required && row.status === 'pass').length} / {data.criteria.filter(row => row.required).length} 项必要条件通过</span></summary>
          {data.contract && <><p>{data.contract.scope}</p>
            {!!data.contract.allowed.length && <p>已授权 · {data.contract.allowed.join('；')}</p>}
            {!!data.contract.denied.length && <p>禁止 · {data.contract.denied.join('；')}</p>}</>}
          {data.verification && <p>{VERIFY_LABEL[data.verification.status] ?? data.verification.status}{data.verification.status === 'completed' ? ` · ${data.verification.verdict}` : ''}{data.verification.historical ? ' · 历史依据' : ''}</p>}
          {data.verificationDetail?.critique && <p>{data.verificationDetail.critique}</p>}
          <ul className="hub-list">{data.criteria.map(criterion => <li key={criterion.id}><b>{criterion.text}</b>
            <p className="hub-muted">{criterion.required ? '必要' : '可选'} · {CRITERION_LABEL[criterion.status] ?? criterion.status}{data.outputsChanged && criterion.status === 'pass' ? ' · 请核对证据版本' : ''}</p>
            <div className="hub-actions">{criterion.evidenceIds.map(id => <button key={id} onClick={() => go({ page: 'evidence', id: data.evidence.find(row => row.id === id)?.ticketId ?? place.id, evidence: id })}>查看标准证据</button>)}</div>
          </li>)}</ul>
          {data.contractHistory.length > 1 && <details><summary>历版契约与修改依据</summary>
            {[...data.contractHistory].reverse().map(row => <div key={row.version} className="hub-card"><b>v{row.version} · {timeLabel(row.createdAt)}</b><p>{row.reason ?? row.scope}</p>
              <ul>{row.criteria.map(c => <li key={c.id}>{c.text}</li>)}</ul></div>)}</details>}
        </details>
        <details className="hub-section hub-disclosure hub-timeline" ref={timelineSection} open={timelineOpen} onToggle={e => setTimelineOpen(e.currentTarget.open)}>
          <summary><h3 ref={timelineHeading} tabIndex={-1}>执行记录</h3><span className="hub-muted">{data.timeline.matched} 条{place.instance ? ' · 当前实例' : ''}</span></summary>
          {selectedInstance && <div className="hub-instance-context"><b>{data.roles.find(role => role.id === selectedInstance.roleId)?.name ?? selectedInstance.roleId} · 第 {selectedInstance.round + 1} 轮{selectedInstance.kind === 'verify' ? '核验' : '执行'}</b>
            <p className="hub-muted">{selectedInstance.sessionId ? '已定位真实原生会话的事件记录。对话与工具正文不在此展示。' : selectedInstance.coverage.reason ?? '缺少可验证的原生会话身份，目前只能查看已登记的工单事件。'}</p>
          </div>}
          {place.instance && !selectedInstance && <p className="hub-error">找不到该实例。可返回当前工单重新选择已登记的角色活动。</p>}
          <details className="hub-timeline-filters" open={filtersOpen} onToggle={e => setFiltersOpen(e.currentTarget.open)}><summary>筛选与历史回放</summary>
          <form className="hub-grid" onSubmit={e => {
            e.preventDefault(); reset(); setFilters({ ...draft, round: draft.round ? String(Number(draft.round) - 1) : undefined,
              from: draft.from ? new Date(draft.from).toISOString() : undefined, to: draft.to ? new Date(draft.to).toISOString() : undefined })
          }}>
            <label>搜索事件<input value={draft.q} onChange={e => setField('q', e.target.value)} placeholder="标题、类型或工具" /></label>
            <label>角色<select value={draft.role} onChange={e => setField('role', e.target.value)}><option value="">全部角色</option>{data.roles.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
            <label>轮次<input type="number" min="1" value={draft.round} onChange={e => setField('round', e.target.value)} /></label>
            <label>事件类型<input value={draft.type} onChange={e => setField('type', e.target.value)} placeholder="例如 tool/call" /></label>
            <label>状态<input value={draft.status} onChange={e => setField('status', e.target.value)} placeholder="例如 running" /></label>
            <label>标准<select value={draft.criterion} onChange={e => setField('criterion', e.target.value)}><option value="">全部标准</option>{data.criteria.map(row => <option key={row.id} value={row.id}>{row.text}</option>)}</select></label>
            <label>开始时间<input type="datetime-local" value={draft.from} onChange={e => setField('from', e.target.value)} /></label>
            <label>结束时间<input type="datetime-local" value={draft.to} onChange={e => setField('to', e.target.value)} /></label>
            <button>应用筛选</button>
          </form>
          <div className="hub-actions">
            <label>按时点回放<input type="datetime-local" value={replay} onChange={e => setReplay(e.target.value)} /></label>
            <button disabled={!replay} onClick={() => go({ page: 'mission', id: place.id, at: new Date(replay).toISOString() })}>打开历史</button>
          </div>
          </details>
          <div className="hub-actions">{!place.at && !place.event && <button type="button" onClick={() => { if (following) { setPinned(data); setFollowing(false) } else followLatest() }}>{following ? '暂停跟随' : '跟随最新'}</button>}</div>
          {place.at ? <p className="hub-muted" role="status">{newerThanReplay > 0 ? `实时轨迹比此处多 ${newerThanReplay} 条记录` : '正在阅读指定时点的轨迹'}</p>
            : !following && !place.event && <p className="hub-muted" role="status">{newEvents > 0 ? `${newEvents} 条新增事件 · 阅读位置已固定` : '阅读位置已固定'}</p>}
          <p className="hub-muted">当前筛选命中 {data.timeline.matched} 条 · 已采集 {data.timeline.total} 条</p>
          <Timeline data={data} items={rows} more={canLoad && !loading ? () => void loadOlder() : undefined} go={go} at={place.at} expandedEvent={place.event ?? (place.instance ? rows[0]?.id : undefined)} />
          {!canLoad && rows.length > 0 && <p className="hub-muted">已显示当前窗口的 {rows.length} 条记录。</p>}
          {loading && <p role="status">正在读取更早轨迹…</p>}
          <ReadIssue error={pageError} retry={() => void loadOlder()} />
        </details>
      </div>
      <div>
        <details className="hub-section hub-disclosure"><summary><h3>观察覆盖</h3><span className="hub-muted">{COVERAGE_LABEL[data.coverage.state] ?? data.coverage.state}</span></summary>
          <p>{COVERAGE_LABEL[data.coverage.state] ?? data.coverage.state} · 最近检查 {timeLabel(data.coverage.checkedAt)}</p>
          <ul className="hub-list">{Object.entries(data.coverage.dimensions).map(([dimension, value]) => <li key={dimension}>
            <b>{DIMENSION_LABEL[dimension] ?? dimension}</b> · {COVERAGE_LABEL[value.state] ?? value.state}{value.count !== undefined ? ` · ${value.count} 条` : ''}
            {value.reason && <p className="hub-muted">{value.reason}</p>}</li>)}</ul>
        </details>
        <section className="hub-section"><h3>角色与实例</h3>
          {data.roles.map(role => <details key={role.id} className="hub-card" open={role.instances.some(row => row.id === place.instance) || undefined}>
            <summary><b>{role.name}</b> <span className="hub-muted">· {role.instances.length ? `${role.instances.length} 次活动` : '暂无活动'}</span></summary>
            {role.instances.map(instance => <div className="hub-card" key={instance.id}>
              <p>{instance.ticketId} · {instance.kind === 'verify' ? '核验' : '执行'} · 第 {instance.round + 1} 轮 · 尝试 {instance.attempt} · {INSTANCE_LABEL[instance.status] ?? instance.status}</p>
              {instance.termination && <p className="hub-muted">{instance.termination === 'confirmed' ? '原生终止已确认' : '终止待确认'}</p>}
              <p className="hub-muted">{instance.sessionId ? '有可追踪的原生执行记录' : instance.coverage.reason ?? '缺少可验证的原生会话身份'}</p>
              {instance.waiting?.map(row => <p key={`${row.kind}:${row.target}`}>{row.kind === 'child' ? '等待 ' : ''}{row.label} · {row.until}</p>)}
              <button onClick={() => openInstance(instance)}>查看执行记录</button>
              <details className="hub-instance-source"><summary>执行来源</summary>
                <p className="hub-muted">配置 {instance.configuredExecutor ?? '未记录'} · 实际 {instance.actualProvider ?? '未观测'}{instance.model ? ` · ${instance.model}` : ''}</p>
                <p className="hub-muted">{COVERAGE_LABEL[instance.coverage.tools] ?? instance.coverage.tools}{instance.coverage.reason ? ` · ${instance.coverage.reason}` : ''}</p>
                {instance.sessionId ? <p className="hub-muted">会话 {instance.sessionId}</p> : instance.activationId && <p className="hub-muted">只有执行激活标识，不能据此打开原生会话。</p>}
              </details>
            </div>)}
          </details>)}
        </section>
        <details className="hub-section hub-disclosure"><summary><h3>已登记证据</h3><span className="hub-muted">{data.evidence.length} 条</span></summary>
          {!data.evidence.length && <p className="hub-muted">当前没有已登记的证据。</p>}
          <ul className="hub-list">{data.evidence.map(ref => <li key={ref.id}><button className="hub-row" onClick={() => go({ page: 'evidence', id: ref.ticketId, evidence: ref.id })}>
            <span><b>{ref.path?.split(/[\\/]/).at(-1) ?? ref.title}</b><small>{ref.historical ? '历史版本' : '当前版本'} · {COVERAGE_LABEL[ref.availability] ?? ref.availability}</small></span></button></li>)}</ul>
        </details>
      </div>
    </div>
  </div>
}
