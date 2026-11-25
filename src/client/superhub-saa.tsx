import { useEffect, useRef, useState } from 'react'
import type { GoalReference } from '../core/superhub-goals.ts'
import type { SaaRecord } from '../dsh/superhub-saa.ts'
import type { HubNav } from './superhub.tsx'
import { COVERAGE_LABEL, STAGE_LABEL, localInput, scopedPath, timeLabel, useHubAction, useHubQuery, type GoalSummary, type HubReview, type Scoped, type SuperhubEvidence } from './superhub-api.ts'
import { ReadIssue } from './superhub-common.tsx'

const fields = [
  ['alignment', '这段时间实际推进了什么？', '写下成果，以及它和选定主线的关系'],
  ['bottleneck', '最值得解决的卡点是什么？', '指出解除后能推动后续工作的一个阻塞'],
  ['nextFocus', '下一段只专注哪件事？', '写一个明确的工作重点'],
  ['firstStep', '前 15 分钟先做什么？', '写一个可以直接上手的动作'],
  ['coordination', '谁在等你提供什么？', '写下交接内容，没有可以填“无”'],
  ['drift', '有没有偏离原来的重点？', '写下需要停做或放入备忘的事项'],
] as const

const checkpoints = [
  ['blockedOn', '具体卡点'],
  ['ruledOut', '已排除的方向'],
  ['resumeAt', '回来后第一步'],
] as const

type Form = Record<typeof fields[number][0], string> & { checkpoint: Record<typeof checkpoints[number][0], string> }
const blank: Form = { alignment: '', bottleneck: '', nextFocus: '', firstStep: '', coordination: '', drift: '',
  checkpoint: { blockedOn: '', ruledOut: '', resumeAt: '' } }
const requiredFields = ['bottleneck', 'nextFocus', 'firstStep'] as const
const shortTime = (value: string) => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

function loadForm(key: string, fallback?: string): Form {
  try {
    const value = sessionStorage.getItem(key) ?? (fallback ? sessionStorage.getItem(fallback) : null)
    const saved = value ? JSON.parse(value) : {}
    return { ...blank, ...saved, checkpoint: { ...blank.checkpoint, ...saved.checkpoint } } as Form
  } catch { return blank }
}

function RecordCard({ record, goals, go }: { record: SaaRecord; goals: GoalSummary[]; go: HubNav }) {
  return <section className="hub-section">
    <h3>继续上次工作</h3>
    <p className="hub-muted">{timeLabel(record.from)} 至 {timeLabel(record.to)}</p>
    <p><b>下一段重点</b> · {record.nextFocus}</p>
    <p><b>前 15 分钟</b> · {record.firstStep}</p>
    <dl className="hub-checkpoint">{checkpoints.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{record.checkpoint[key] || '未记录'}</dd></div>)}</dl>
    <details><summary>完整复盘</summary>
      <dl className="hub-checkpoint">{fields.filter(([key]) => key !== 'nextFocus' && key !== 'firstStep').map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{record[key] || '未记录'}</dd></div>)}</dl>
    </details>
    <div className="hub-actions">
      {record.goals.map(goal => <button key={goal.id} onClick={() => go({ page: 'goals', id: goal.id, version: goal.version })}>{goals.find(row => row.id === goal.id)?.name ?? goal.id} · v{goal.version}</button>)}
      {record.tickets.map(id => <button key={id} onClick={() => go({ page: 'mission', id })}>{id} · 查看工单</button>)}
      {record.references.map(ref => <button key={`${ref.ticketId}:${ref.evidenceId}`} onClick={() => go({ page: 'evidence', id: ref.ticketId, evidence: ref.evidenceId })}>{ref.ticketId} · 查看当时证据</button>)}
    </div>
    <p className="hub-muted">保存于 {timeLabel(record.savedAt)}</p>
  </section>
}

function SavedReviews({ scope, id, goals, go, active }: { scope: string; id: string; goals: GoalSummary[]; go: HubNav; active: boolean }) {
  const history = id === 'history'
  const query = useHubQuery<Scoped & { record?: SaaRecord; records?: SaaRecord[] }>(scope, scopedPath(scope, `review/${encodeURIComponent(id)}`), undefined, active)
  return <>
    <section className="hub-section"><div className="hub-item-title"><h3>{history ? '历次局势校准' : '局势校准记录'}</h3>
      <button onClick={() => go({ page: 'review' })}>开始新的校准</button></div>
      <ReadIssue error={query.error} at={query.readAt} retry={() => void query.refresh()} />
      {query.data?.records?.length === 0 && <p className="hub-muted">完成一次校准后，复工线索会保存在这里。</p>}
      {query.data?.records && <ul className="hub-list">{query.data.records.map(record => <li key={record.id}><button className="hub-row" onClick={() => go({ page: 'review', id: record.id })}>
        <span><b>{record.nextFocus}</b><small>{timeLabel(record.savedAt)}</small></span></button></li>)}</ul>}
      {!query.data && !query.error && <p role="status">正在读取复盘记录…</p>}
    </section>
    {query.data?.record && <RecordCard record={query.data.record} goals={goals} go={go} />}
  </>
}

function ReviewEvidence({ evidence, references, toggle, go }: {
  evidence: SuperhubEvidence[]; references: GoalReference[]; toggle: (ref: GoalReference) => void; go: HubNav
}) {
  const selected = (ref: SuperhubEvidence) => references.some(row => row.ticketId === ref.ticketId && row.evidenceId === ref.id)
  const deliveries = evidence.filter(ref => ref.kind !== 'native')
  const observations = evidence.filter(ref => ref.kind === 'native')
  const observationCount = observations.filter(selected).length
  const rows = (items: SuperhubEvidence[]) => <ul className="hub-review-evidence">{items.map(ref => {
    const version = ref.version ? `${ref.historical ? '历史' : '当前'}版本 ${ref.version.slice(0, 12)}` : ''
    return <li key={ref.id} className={selected(ref) ? 'is-selected' : undefined}>
      <div className="hub-review-evidence-main">
        <button type="button" className="hub-review-link" aria-label={`${ref.title}${version ? ` · ${version}` : ''}`}
          onClick={() => go({ page: 'evidence', id: ref.ticketId, evidence: ref.id })}>{ref.title}</button>
        <div className="hub-review-evidence-meta">{version && <span>{version}</span>}
          <span>{timeLabel(ref.at)}</span><span>{COVERAGE_LABEL[ref.availability] ?? ref.availability}</span></div>
      </div>
      <label className="hub-check hub-review-keep"><input type="checkbox" aria-label={`保留证据 ${ref.title}${version ? ` ${version}` : ''}`}
        checked={selected(ref)} onChange={() => toggle({ ticketId: ref.ticketId, evidenceId: ref.id })} /><span>保存引用</span></label>
    </li>
  })}</ul>
  return <>
    {!!deliveries.length && rows(deliveries)}
    {!deliveries.length && !!observations.length && <p className="hub-muted hub-review-no-delivery">本段未登记交付文件，可展开过程记录核对进展。</p>}
    {!!observations.length && <details className="hub-review-observations"><summary>过程与原始记录 <span>{observations.length} 条{observationCount ? ` · 已选 ${observationCount} 条` : ''}</span></summary>
      {rows(observations)}
    </details>}
  </>
}

function ReviewForm({ scope, initialGoal, goals, go, openRoom }: { scope: string; initialGoal?: string; goals: GoalSummary[]; go: HubNav; openRoom: (id: string) => void }) {
  const oldKey = `chief-superhub-review-draft:${scope}`
  const key = `${oldKey}${initialGoal ? ':' + initialGoal : ''}`
  const [restoredGlobal] = useState(() => {
    try { return initialGoal && !sessionStorage.getItem(key) ? sessionStorage.getItem(oldKey) : null } catch { return null }
  })
  const [form, setForm] = useState(() => loadForm(key, initialGoal ? oldKey : undefined))
  const legacyKey = `${key}:before-compact`
  const [legacy, setLegacy] = useState<Form | undefined>(() => {
    try { return sessionStorage.getItem(legacyKey) ? loadForm(legacyKey) : undefined } catch { return undefined }
  })
  const [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [working, setWorking] = useState<{ from?: string; to?: string; goalIds: string[] }>({ goalIds: initialGoal ? [initialGoal] : [] })
  const [goalChoice, chooseGoal] = useState('')
  const [tickets, setTickets] = useState<string[]>([])
  const [references, setReferences] = useState<GoalReference[]>([])
  const [formError, setFormError] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  const scopeHeading = useRef<HTMLHeadingElement>(null), progressHeading = useRef<HTMLHeadingElement>(null), actionHeading = useRef<HTMLHeadingElement>(null)
  const steps = useRef<HTMLElement>(null), answerForm = useRef<HTMLFormElement>(null)
  const jumpTo = (target: HTMLElement | null) => {
    target?.scrollIntoView({ block: 'start' })
    const pane = target?.closest('.hub-scroll')
    if (pane) pane.scrollTop -= (steps.current?.getBoundingClientRect().height ?? 0) + 12
    target?.focus({ preventScroll: true })
  }
  const startWriting = () => jumpTo(answerForm.current?.querySelector<HTMLElement>('textarea, input') ?? actionHeading.current)
  // Drill-down keeps this observed window and its references stable until an explicit refresh.
  const path = scopedPath(scope, 'review', { from: working.from, to: working.to }, working.goalIds.map(id => ['goal', id]))
  const query = useHubQuery<HubReview>(scope, path)
  const operation = useHubAction(scope)
  const data = query.data
  const windowDirty = !!data && (from !== localInput(data.from) || to !== localInput(data.to))
  useEffect(() => {
    if (!data) return
    setFrom(localInput(data.from)); setTo(localInput(data.to))
  }, [data])
  const write = (value: Form) => { setForm(value); try { sessionStorage.setItem(key, JSON.stringify(value)) } catch {} }
  const conflicts = ([['blockedOn', 'bottleneck', '具体卡点'], ['resumeAt', 'firstStep', '回来后第一步']] as const)
    .filter(([checkpoint, field]) => form.checkpoint[checkpoint].trim() && form.checkpoint[checkpoint].trim() !== form[field].trim())
  const migrate = (checkpoint: 'blockedOn' | 'resumeAt', field: 'bottleneck' | 'firstStep', useOld: boolean) => {
    if (!legacy) { setLegacy(form); try { sessionStorage.setItem(legacyKey, JSON.stringify(form)) } catch {} }
    write({ ...form, ...(useOld ? { [field]: form.checkpoint[checkpoint] } : {}), checkpoint: { ...form.checkpoint, [checkpoint]: '' } })
    setSaveError(undefined)
  }
  const missing = requiredFields.filter(field => !form[field].trim())
  const chooseWindow = (changes: { from?: string; to?: string; goalIds?: string[] }) => {
    const next = { ...working, ...changes }
    const nextPath = scopedPath(scope, 'review', { from: next.from, to: next.to }, next.goalIds.map(id => ['goal', id]))
    setWorking(next)
    if (nextPath === path) void query.refresh()
    setTickets([]); setReferences([]); setFormError(undefined)
  }
  const chooseFocus = (goalIds: string[]) => chooseWindow({ from: data?.from ?? working.from, to: data?.to ?? working.to, goalIds })
  const toggleTicket = (id: string) => {
    if (tickets.includes(id)) { setTickets(rows => rows.filter(row => row !== id)); setReferences(rows => rows.filter(row => row.ticketId !== id)); return }
    if (tickets.length >= 30) { setFormError('每份校准最多保存 30 张工单'); return }
    setTickets(rows => [...rows, id]); setFormError(undefined)
  }
  const toggleEvidence = (ref: GoalReference) => {
    const selected = references.some(row => row.ticketId === ref.ticketId && row.evidenceId === ref.evidenceId)
    if (selected) { setReferences(rows => rows.filter(row => row.ticketId !== ref.ticketId || row.evidenceId !== ref.evidenceId)); return }
    if (references.length >= 30 || !tickets.includes(ref.ticketId) && tickets.length >= 30) { setFormError('每份校准最多保存 30 张工单及 30 条证据'); return }
    if (!tickets.includes(ref.ticketId)) setTickets(rows => [...rows, ref.ticketId])
    setReferences(rows => [...rows, ref]); setFormError(undefined)
  }
  const fieldInput = (field: typeof fields[number][0]) => {
    const [, label, placeholder] = fields.find(row => row[0] === field)!
    return <label key={field}>{label}<textarea name={field} rows={2} required={requiredFields.some(key => key === field)} value={form[field]}
      maxLength={field === 'nextFocus' ? 300 : field === 'firstStep' ? 500 : field === 'bottleneck' ? 600 : 1000}
      placeholder={placeholder} onChange={e => write({ ...form, [field]: e.target.value })} /></label>
  }
  return <div className="hub-review">
    <div className="hub-review-intro">
      <div><h2>局势校准</h2><p className="hub-muted">回看进展和阻塞，选定下一步，再留下复工线索。</p></div>
      <button type="button" onClick={() => go({ page: 'review', id: 'history' })}>复盘历史</button>
    </div>
    <nav className="hub-review-steps" ref={steps} aria-label="局势校准步骤">
      <button type="button" onClick={() => jumpTo(scopeHeading.current)}><span>01</span> 确定范围</button>
      <button type="button" disabled={!data} onClick={() => jumpTo(progressHeading.current)}><span>02</span> 看进展与阻塞</button>
      <button type="button" disabled={!data} onClick={startWriting}><span>03</span> 填写并保存复盘</button>
    </nav>
    <section className="hub-section hub-review-scope">
      <div className="hub-item-title"><h3 ref={scopeHeading} tabIndex={-1}>本次关注</h3><span className="hub-muted">最多三个主线目标</span></div>
      <div className="hub-review-focus"><label>本次关注目标<select value={goalChoice} onChange={e => chooseGoal(e.target.value)}>
        <option value="">选择至多三个主线目标</option>
        {goals.filter(goal => !working.goalIds.includes(goal.id) && goal.status === 'active').map(goal => <option value={goal.id} key={goal.id}>{goal.name}</option>)}
      </select></label>
      <button disabled={!goalChoice || working.goalIds.length >= 3 || windowDirty} onClick={() => {
        chooseFocus([...working.goalIds, goalChoice]); chooseGoal('')
      }}>加入本次校准</button></div>
      {!!working.goalIds.length && <ul className="hub-inline-list hub-review-goals">{working.goalIds.map(id => <li key={id}>
        <button onClick={() => go({ page: 'goals', id })}>{goals.find(goal => goal.id === id)?.name ?? id}</button>
        <button disabled={windowDirty} aria-label={`移除 ${goals.find(goal => goal.id === id)?.name ?? id}`} onClick={() => chooseFocus(working.goalIds.filter(row => row !== id))}>移除</button>
      </li>)}</ul>}
      {!working.goalIds.length && <p className="hub-muted">暂未限定目标，先查看这段时间的全部工作。</p>}
      <details className="hub-review-window"><summary>工作段{data && <span>{shortTime(data.from)} — {shortTime(data.to)}</span>}<span className="hub-review-adjust">调整时间</span></summary>
      <form className="hub-grid" onSubmit={e => {
        e.preventDefault()
        const a = new Date(data && from === localInput(data.from) ? data.from : from)
        const b = new Date(data && to === localInput(data.to) ? data.to : to)
        if (!Number.isFinite(a.valueOf()) || !Number.isFinite(b.valueOf()) || a >= b || b.valueOf() > Date.now()) { setFormError('请选择有效的工作段'); return }
        chooseWindow({ from: a.toISOString(), to: b.toISOString() })
      }}>
        <label>工作段起点<input type="datetime-local" value={from} required onChange={e => setFrom(e.target.value)} /></label>
        <label>工作段终点<input type="datetime-local" value={to} required onChange={e => setTo(e.target.value)} /></label>
        <div className="hub-actions"><button>读取这段工作</button><button type="button" onClick={() => chooseWindow({ from: undefined, to: undefined })}>回到最近工作段</button></div>
      </form>
      </details>
      {windowDirty && <p className="hub-muted" role="status">工作段已修改。读取这段工作后可保存校准。</p>}
      {data?.latest && <div className="hub-actions"><button onClick={() => go({ page: 'review', id: data.latest!.id })}>打开上次复工线索</button>
        {data.latest.goals.some(goal => goals.some(row => row.id === goal.id)) && <button disabled={windowDirty} onClick={() => chooseFocus(
          data.latest!.goals.filter(goal => goals.some(row => row.id === goal.id)).map(goal => goal.id),
        )}>沿用上次主线</button>}</div>}
      <ReadIssue error={query.error} at={query.readAt} retry={() => void query.refresh()} />
      <ReadIssue error={formError} />
    </section>
    {!data && !query.error && <p role="status">正在核对这段工作的证据与等待…</p>}
    {data && <div className="hub-columns hub-review-columns">
      <div>
        <section className="hub-section hub-review-progress">
          <span className="hub-review-count">{data.evidence.length} 张工单</span><h3 ref={progressHeading} tabIndex={-1}>新增证据与进展</h3>
          <p className="hub-muted">{timeLabel(data.from)} 至 {timeLabel(data.to)}</p>
          {data.sampled < data.candidates && <p className="hub-muted">当前核对了 {data.sampled} 张近期有变更的工单，共 {data.candidates} 张。可缩短工作段或选择主线目标。</p>}
          {!data.evidence.length && <p className="hub-muted">当前工作段没有读到工单进展或登记证据。</p>}
          {data.evidence.map(({ ticket, evidence, coverage, observed, late }) => <article className="hub-review-ticket" key={ticket.id}>
            <div className="hub-review-ticket-meta"><span>{ticket.id}</span><span>{STAGE_LABEL[ticket.outcome ?? ticket.stage] ?? ticket.stage}</span>
              {coverage && <span>{COVERAGE_LABEL[coverage] ?? coverage}</span>}</div>
            <button className="hub-review-link hub-review-ticket-title" onClick={() => go({ page: 'mission', id: ticket.id })}>{ticket.title}</button>
            {(ticket.summary || ticket.title.length > 100) && <details className="hub-review-summary"><summary>查看工单摘要</summary>
              {ticket.title.length > 100 && <p>{ticket.title}</p>}{ticket.summary && <p>{ticket.summary}</p>}
            </details>}
            {!!late?.length && <details><summary>{late.length} 条延迟到达的观察</summary><ul className="hub-list">{late.map(row => <li key={row.id}>
              <button onClick={() => go({ page: 'mission', id: row.ticketId, event: row.id })}>{row.title}</button>
              <p className="hub-muted">发生 {timeLabel(row.at)} · 观察 {timeLabel(row.observedAt)}</p>
            </li>)}</ul></details>}
            <div className="hub-review-ticket-footer"><label className="hub-check"><input type="checkbox" checked={tickets.includes(ticket.id)} onChange={() => toggleTicket(ticket.id)} /><span>复盘保留这张工单</span></label>
              <span className="hub-muted">{observed} 条观察记录</span></div>
            <ReviewEvidence evidence={evidence} references={references} toggle={toggleEvidence} go={go} />
          </article>)}
        </section>
        <section className="hub-section">
          <h3>当前阻塞与待决定</h3>
          {!data.attention.length && !data.roomActions.length && !data.blockers.length && <p className="hub-muted">当前没有已登记的阻塞或待主人决定。</p>}
          {data.blockers.map(row => <div className="hub-card" key={`${row.goalId}:${row.target}`}>目标依赖 <button onClick={() => go({ page: 'goals', id: row.target })}>{row.name}</button></div>)}
          {data.attention.map(ticket => <div className="hub-card" key={ticket.id}>
            <button onClick={() => go({ page: 'mission', id: ticket.id })}>{ticket.title}</button>
            <p>{STAGE_LABEL[ticket.stage] ?? ticket.stage}{ticket.question ? ` · ${ticket.question}` : ''}{ticket.waitingFor.length ? ` · 等待 ${ticket.waitingFor.join('、')}` : ''}</p>
            <label className="hub-check"><input type="checkbox" checked={tickets.includes(ticket.id)} onChange={() => toggleTicket(ticket.id)} />复盘保留这张工单</label>
          </div>)}
          {data.roomActions.map(row => <div className="hub-card" key={row.id}>
            <p>{row.roomTitle} · {row.text}</p><button onClick={() => openRoom(row.roomId)}>打开讨论待办</button>
          </div>)}
        </section>
        <div className="hub-review-continue"><button type="button" className="hub-primary" onClick={startWriting}>继续填写并保存复盘</button></div>
      </div>
      <section className="hub-section hub-review-action"><h3 ref={actionHeading} tabIndex={-1}>填写并保存复盘</h3>
        <p className="hub-muted">只需填写下面三项，其他内容可选。</p>
        <p className="hub-review-selection" role="status">本次保留 {tickets.length} 张工单、{references.length} 条证据引用</p>
        <form ref={answerForm} noValidate onSubmit={async e => {
          e.preventDefault()
          if (query.error || windowDirty) return
          if (missing.length) {
            setSaveError(`还需填写 ${missing.length} 项：${missing.map(field => fields.find(row => row[0] === field)![1]).join('、')}`)
            jumpTo(answerForm.current?.querySelector<HTMLElement>(`[name="${missing[0]}"]`) ?? null)
            return
          }
          if (conflicts.length) { setSaveError('请先核对下方旧草稿中的复工线索，再保存。'); return }
          setSaveError(undefined)
          const record = await operation.run<Scoped & { record: SaaRecord }>('review', {
            ...form, mode: 'compact', checkpoint: { ruledOut: form.checkpoint.ruledOut },
            from: data.from, to: data.to, goalIds: data.focus.map(row => row.id),
            goalVersions: data.focus.map(row => ({ id: row.id, version: row.version })), tickets, references,
          })
          if (record) {
            write(blank)
            try {
              sessionStorage.removeItem(key)
              if (restoredGlobal && sessionStorage.getItem(oldKey) === restoredGlobal) sessionStorage.removeItem(oldKey)
            } catch {}
            go({ page: 'review', id: record.record.id })
          }
        }}>
          {restoredGlobal && <p className="hub-muted">已恢复未保存的草稿，请核对本次关注的目标。</p>}
          <div className="hub-review-required">{requiredFields.map(fieldInput)}</div>
          <p className="hub-muted">卡点和第一步会一并保存为复工线索。</p>
          {conflicts.length > 0 && <section className="hub-review-legacy" aria-label="核对旧草稿"><h4>核对旧草稿</h4>
            <p>原草稿另有复工线索。请选择本次采用的内容，原稿会保留在本机供查看。</p>
            {conflicts.map(([checkpoint, field, label]) => <div key={checkpoint} className="hub-card">
              <b>{label}</b><p>旧线索 · {form.checkpoint[checkpoint]}</p><p>当前填写 · {form[field] || '尚未填写'}</p>
              <div className="hub-actions"><button type="button" onClick={() => migrate(checkpoint, field, true)}>沿用这条旧线索</button>
                <button type="button" onClick={() => migrate(checkpoint, field, false)}>保留当前填写</button></div>
            </div>)}
          </section>}
          <details className="hub-review-optional"><summary>补充复盘（可选）</summary>
            {fieldInput('alignment')}{fieldInput('coordination')}{fieldInput('drift')}
            <label>已排除的方向<input name="ruledOut" maxLength={600} value={form.checkpoint.ruledOut} onChange={e => write({ ...form, checkpoint: { ...form.checkpoint, ruledOut: e.target.value } })} /></label>
          </details>
          {legacy && <details className="hub-review-optional"><summary>查看迁移前的本机草稿</summary>
            <dl className="hub-checkpoint">{fields.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{legacy[field] || '未记录'}</dd></div>)}</dl>
            <dl className="hub-checkpoint">{checkpoints.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{legacy.checkpoint[field] || '未记录'}</dd></div>)}</dl>
          </details>}
          <div className="hub-actions hub-review-submit"><button className="hub-primary" disabled={operation.busy || !!query.error || windowDirty}>保存校准与复工线索</button>
            <button type="button" onClick={() => go({ page: 'intake' })}>记一条备忘</button></div>
          {missing.length > 0 && <p className="hub-muted" role="status">还需填写 {missing.length} 项</p>}
          <ReadIssue error={saveError} />
          <ReadIssue error={operation.error} />
        </form>
      </section>
    </div>}
  </div>
}

export function SituationReview({ scope, id, initialGoal, goals, go, openRoom, active = true }: { scope: string; id?: string; initialGoal?: string; goals: GoalSummary[]; go: HubNav; openRoom: (id: string) => void; active?: boolean }) {
  return id ? <SavedReviews scope={scope} id={id} goals={goals} go={go} active={active} /> : <ReviewForm scope={scope} initialGoal={initialGoal} goals={goals} go={go} openRoom={openRoom} />
}
