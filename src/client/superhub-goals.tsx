import { useMemo, useState, type ReactNode } from 'react'
import {
  currentGoal, GOAL_RELATIONS, GOAL_RESULTS, GOAL_STATES, GOAL_TYPES,
  type GoalAssessment, type GoalCandidate, type GoalFinding, type GoalReference, type GoalVersion, type SuperhubGoal,
} from '../core/superhub-goals.ts'
import { requestId } from './request-id.ts'
import {
  scopedPath, STAGE_LABEL, timeLabel, useHubAction, useHubQuery,
  type CurrentMission, type GoalSummary, type HubGoal, type HubGoals, type Scoped, type WorkspaceTicket,
} from './superhub-api.ts'
import { ReadIssue } from './superhub-common.tsx'
import type { HubNav } from './superhub.tsx'

const typeLabels: Record<GoalVersion['type'], string> = { direction: '方向型', project: '成果型', maintenance: '维持型' }
const stateLabels: Record<GoalVersion['status'], string> = { draft: '草稿', active: '有效', paused: '暂停', achieved: '已达成', archived: '归档' }
const relationLabels: Record<GoalVersion['relations'][number]['kind'], string> = { requires: '依赖', contributes: '贡献给', related: '背景关联' }
const resultLabels: Record<GoalAssessment['result'], string> = { none: '未评估', 'in-progress': '推进中', blocked: '存在阻碍', insufficient: '证据不足', met: '条件已满足' }
const findingLabels: Record<GoalFinding['status'], string> = { met: '已确认', unmet: '未满足', uncertain: '待核实' }
const itemLabels: Record<string, string> = {
  recorded: '已记录', clarify: '待澄清', ready: '等待派工', dispatching: '正在登记工单', dispatched: '工单已登记',
  stopped: '已提交停止', failed: '登记失败', conversation: '对话',
}
const maxRows = 40
const pageSize = 40
const wrap = { minWidth: 0, maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' } as const

type GoalDetailData = HubGoal
type EditorTarget = { goal: SuperhubGoal; version: GoalVersion } | { candidate?: GoalCandidate }
type CriterionDraft = { key: string; id?: string; text: string; required: boolean }
type GoalDraft = Pick<GoalVersion, 'name' | 'description' | 'type' | 'status' | 'owner' | 'horizon' | 'relations'> & {
  parent: string
  criteria: CriterionDraft[]
  reason: string
}
type ChangeReceipt = Scoped & {
  goal: SuperhubGoal
  previous?: GoalVersion
  current: GoalVersion
  impact: { tickets: string[]; items: number }
}

const nameOf = (goals: readonly GoalSummary[], id: string) => goals.find(goal => goal.id === id)?.name ?? id
const evidenceKey = ({ ticketId, evidenceId }: GoalReference) => `${ticketId}/${evidenceId}`

function GoalLink({ id, goals, go }: { id: string; goals: readonly GoalSummary[]; go: HubNav }) {
  return <button type="button" style={wrap} onClick={() => go({ page: 'goals', id })}>{nameOf(goals, id)}</button>
}

function EvidenceLink({ reference, go, children }: { reference: GoalReference; go: HubNav; children?: ReactNode }) {
  return <button type="button" onClick={() => go({ page: 'evidence', id: reference.ticketId, evidence: reference.evidenceId })}>{children ?? `打开 ${reference.ticketId} 的证据`}</button>
}

function orderedGoals(goals: readonly GoalSummary[]) {
  const byId = new Map(goals.map(goal => [goal.id, goal]))
  const byParent = new Map<string | undefined, GoalSummary[]>()
  for (const goal of goals) {
    const parent = goal.parent && byId.has(goal.parent) ? goal.parent : undefined
    const children = byParent.get(parent) ?? []
    children.push(goal)
    byParent.set(parent, children)
  }
  const collator = new Intl.Collator('zh-CN', { numeric: true })
  for (const [parent, rows] of byParent) rows.sort((a, b) =>
    (parent === undefined ? Number(!a.horizon) - Number(!b.horizon) || collator.compare(a.horizon ?? '', b.horizon ?? '') : 0)
    || collator.compare(a.name, b.name) || a.id.localeCompare(b.id))
  const visited = new Set<string>()
  const rows: { goal: GoalSummary; depth: number }[] = []
  function visit(roots: readonly GoalSummary[]) {
    const pending = roots.map(goal => ({ goal, depth: 0 })).reverse()
    while (pending.length) {
      const row = pending.pop()!
      if (visited.has(row.goal.id)) continue
      visited.add(row.goal.id)
      rows.push(row)
      const children = byParent.get(row.goal.id) ?? []
      for (let index = children.length - 1; index >= 0; index--) pending.push({ goal: children[index]!, depth: row.depth + 1 })
    }
  }
  visit(byParent.get(undefined) ?? [])
  visit(goals)
  return rows
}

function GoalCatalog({ catalog, go, edit }: { catalog?: HubGoals; go: HubNav; edit: (target: EditorTarget) => void }) {
  const [query, setQuery] = useState('')
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')
  const [horizon, setHorizon] = useState('')
  const [offset, setOffset] = useState(0)
  const [candidateOffset, setCandidateOffset] = useState(0)
  const goals = catalog?.goals
  const ordered = useMemo(() => orderedGoals(goals ?? []), [goals])
  const names = useMemo(() => new Map(goals?.map(goal => [goal.id, goal.name])), [goals])
  const horizons = [...new Set((goals ?? []).flatMap(goal => goal.horizon ? [goal.horizon] : []))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
  const selectedHorizon = horizons.includes(horizon) ? horizon : ''
  const search = query.trim().toLocaleLowerCase()
  const rows = ordered.filter(({ goal }) => {
    return (!status || goal.status === status) && (!type || goal.type === type) && (!selectedHorizon || goal.horizon === selectedHorizon)
      && (!search || [goal.name, goal.owner, goal.id, goal.horizon].some(text => text?.toLocaleLowerCase().includes(search)))
  })
  const start = Math.min(offset, Math.floor(Math.max(0, rows.length - 1) / pageSize) * pageSize)
  const candidates = catalog?.candidates ?? []
  const candidateStart = Math.min(candidateOffset, Math.floor(Math.max(0, candidates.length - 1) / pageSize) * pageSize)
  return <div className="hub-columns">
    <section className="hub-section" aria-label="目标地图">
      <div className="hub-item-title"><h3>目标地图</h3><button type="button" className="hub-primary" onClick={() => edit({})}>新建目标</button></div>
      <label>搜索目标<input type="search" placeholder="名称、目标负责人、时间跨度或目标标识" value={query} onChange={event => { setQuery(event.target.value); setOffset(0) }} /></label>
      <div className="hub-grid">
        <label>目标类型<select value={type} onChange={event => { setType(event.target.value); setOffset(0) }}>
          <option value="">全部类型</option>{GOAL_TYPES.map(value => <option key={value} value={value}>{typeLabels[value]}</option>)}</select></label>
        <label>目标状态<select value={status} onChange={event => { setStatus(event.target.value); setOffset(0) }}>
          <option value="">全部状态</option>{GOAL_STATES.map(value => <option key={value} value={value}>{stateLabels[value]}</option>)}</select></label>
        {horizons.length > 0 && <label>时间跨度<select value={selectedHorizon} onChange={event => { setHorizon(event.target.value); setOffset(0) }}>
          <option value="">全部时间跨度</option>{horizons.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      </div>
      {!catalog && <p role="status">正在读取目标地图…</p>}
      {catalog && !rows.length && <p className="hub-muted">{goals?.length ? '没有符合筛选条件的目标。' : '当前第二大脑还没有登记目标。'}</p>}
      {rows.length > 0 && <p className="hub-muted" role="status">显示 {start + 1}–{Math.min(start + pageSize, rows.length)} 项，共 {rows.length} 项</p>}
      <ul className="hub-list">{rows.slice(start, start + pageSize).map(({ goal, depth }) => <li key={goal.id} style={depth ? { marginInlineStart: Math.min(depth, 4) * 8 } : undefined}>
        <button type="button" className="hub-row" onClick={() => go({ page: 'goals', id: goal.id })}>
          <span><b>{goal.name}</b><small>目标负责人 · {goal.owner}{goal.horizon ? ` · ${goal.horizon}` : ''}</small>
            {goal.parent && <small>上级 · {names.get(goal.parent) ?? goal.parent}</small>}</span>
          <span className="hub-state">{stateLabels[goal.status]}</span>
        </button>
      </li>)}</ul>
      <div className="hub-actions">
        {start > 0 && <button type="button" onClick={() => setOffset(start - pageSize)}>上一页目标</button>}
        {start + pageSize < rows.length && <button type="button" onClick={() => setOffset(start + pageSize)}>下一页目标</button>}
      </div>
    </section>
    {candidates.length > 0 && <section className="hub-section"><h3>goals.md 导入候选</h3>
      <ul className="hub-list">{candidates.slice(candidateStart, candidateStart + pageSize).map(candidate => <li key={candidate.id}>
        <button type="button" className="hub-row" onClick={() => edit({ candidate })}>
          <span><b>{candidate.text}</b><small>{candidate.section}{candidate.state === 'done' ? ' · 原文已勾选' : ''}</small></span><span className="hub-state">核对导入</span>
        </button>
      </li>)}</ul>
      <div className="hub-actions">
        {candidateStart > 0 && <button type="button" onClick={() => setCandidateOffset(candidateStart - pageSize)}>上一页候选</button>}
        {candidateStart + pageSize < candidates.length && <button type="button" onClick={() => setCandidateOffset(candidateStart + pageSize)}>下一页候选</button>}
      </div>
    </section>}
  </div>
}

function draftFor(target: EditorTarget): GoalDraft {
  if ('goal' in target) {
    const { name, description, type, status, owner, horizon, parent, relations, criteria } = target.version
    return { name, description, type, status, owner, horizon, parent: parent ?? '', relations, reason: '', criteria: criteria.map(criterion => ({ ...criterion, key: criterion.id })) }
  }
  const text = target.candidate?.text ?? ''
  return {
    name: text.slice(0, 200), description: text.length > 200 ? text.slice(0, 6000) : '',
    type: 'project', status: target.candidate?.state === 'done' ? 'archived' : 'active', owner: '主人', horizon: '', parent: '', relations: [], criteria: [], reason: '',
  }
}

function goalFields(goal: GoalDraft, goals: readonly GoalSummary[]) {
  return [
    ['名称', goal.name.trim()], ['说明', goal.description.trim()], ['类型', typeLabels[goal.type]], ['状态', stateLabels[goal.status]],
    ['目标负责人', goal.owner.trim()], ['时间跨度', goal.horizon.trim()], ['上级目标', goal.parent ? nameOf(goals, goal.parent) : ''],
    ['跨目标关系', goal.relations.map(row => `${relationLabels[row.kind]} · ${nameOf(goals, row.target)}`).join('\n')],
    ['验收条件', goal.criteria.map(row => `${row.required ? '必要' : '可选'} · ${row.text.trim()}`).join('\n')],
  ] as const
}

function GoalEditor({ scope, target, goals, current, cancel, reload, save }: {
  scope: string; target: EditorTarget; goals: readonly GoalSummary[]; current?: GoalDetailData
  cancel: () => void; reload: () => Promise<GoalDetailData | undefined>; save: (result: ChangeReceipt) => void
}) {
  const [draft, setDraft] = useState(() => draftFor(target))
  const [review, setReview] = useState(false)
  const [candidateTarget, selectTarget] = useState('')
  const [relation, setRelation] = useState<GoalVersion['relations'][number]['kind']>('requires')
  const action = useHubAction(scope)
  const base = 'goal' in target ? target.version : undefined
  const id = 'goal' in target ? target.goal.id : undefined
  const candidate = 'candidate' in target ? target.candidate : undefined
  const changedOnServer = !!(current && base && currentGoal(current.goal).version !== base.version)
  const hasRelation = draft.relations.some(row => row.target === candidateTarget && row.kind === relation)
  const available = goals.filter(goal => goal.id !== id)
  const update = <K extends keyof GoalDraft>(field: K, value: GoalDraft[K]) => setDraft(row => ({ ...row, [field]: value }))
  const updated = goalFields(draft, goals)
  const original = 'goal' in target ? goalFields(draftFor(target), goals) : undefined
  const changed = updated.filter(([, value], index) => original ? original[index]?.[1] !== value : !!value)
  const valid = !!(draft.name.trim() && draft.owner.trim() && draft.reason.trim() && draft.criteria.every(row => row.text.trim()))
  const send = async () => {
    const result = await action.run<ChangeReceipt>(id ? `goals/${id}` : 'goals', {
      expectedVersion: base?.version ?? 0,
      ...(candidate ? { candidateId: candidate.id } : {}),
      name: draft.name.trim(), description: draft.description.trim(), owner: draft.owner.trim(), type: draft.type, status: draft.status,
      horizon: draft.horizon.trim(), parent: draft.parent || null, reason: draft.reason.trim(), relations: draft.relations,
      criteria: draft.criteria.map(({ id: criterionId, text, required }) => ({ ...(criterionId ? { id: criterionId } : {}), text: text.trim(), required })),
    })
    if (result) save(result)
    else if (id) await reload()
  }
  return <section className="hub-section">
    <h3>{base ? `修订目标 · 第 ${base.version} 版` : candidate ? '导入目标候选' : '新建目标'}</h3>
    {candidate && <blockquote>{candidate.text}<small>{candidate.section} · goals.md{candidate.state === 'done' ? ' · 原文已勾选' : ''}</small></blockquote>}
    {changedOnServer && <p className="hub-error" role="alert">服务器上的目标已更新到第 {currentGoal(current!.goal).version} 版。下方保留本次草稿，关闭后可查看当前版本。</p>}
    <ReadIssue error={action.error} />
    {review ? <div>
      <h4>核对目标变更</h4>
      <ul className="hub-list">{changed.map(([field, value]) => <li key={field}>
        <b>{field}</b>
        {original && <p className="hub-muted" style={{ whiteSpace: 'pre-wrap' }}>原值 · {original.find(row => row[0] === field)?.[1] || '未登记'}</p>}
        <p style={{ whiteSpace: 'pre-wrap' }}>拟写入 · {value || '清空'}</p>
      </li>)}</ul>
      <p>依据 · {draft.reason}</p>
      {current && <p>影响范围 · {current.items.length} 条关联事项，{current.tasks.length} 张关联工单。关联仍使用相同目标标识。</p>}
      {base?.assessment && changed.some(([field]) => ['验收条件', '说明', '时间跨度', '类型'].includes(field)) && <p className="hub-restrictions">这次修订涉及原评估依据。已存评估可以在历史版本中查看，新版需要复核成果条件。</p>}
      <div className="hub-actions">
        <button type="button" className="hub-primary" disabled={changedOnServer || action.busy} onClick={() => void send()}>{action.busy ? '正在保存…' : candidate ? '确认导入目标' : '确认写入目标'}</button>
        <button type="button" disabled={action.busy} onClick={() => setReview(false)}>继续编辑</button>
        <button type="button" disabled={action.busy} onClick={cancel}>关闭草稿</button>
      </div>
    </div> : <form onSubmit={event => { event.preventDefault(); if (valid && changed.length) setReview(true) }}>
      <label>目标名称<input required maxLength={200} value={draft.name} onChange={event => update('name', event.target.value)} /></label>
      <label>目标说明<textarea maxLength={6000} value={draft.description} onChange={event => update('description', event.target.value)} /></label>
      <div className="hub-grid">
        <label>目标类型<select value={draft.type} onChange={event => update('type', event.target.value as GoalVersion['type'])}>
          {GOAL_TYPES.map(value => <option key={value} value={value}>{typeLabels[value]}</option>)}</select></label>
        <label>目标状态<select value={draft.status} onChange={event => update('status', event.target.value as GoalVersion['status'])}>
          {GOAL_STATES.filter(value => value !== 'achieved' || base?.status === 'achieved' || base?.type === 'project' && base.assessment?.result === 'met')
            .map(value => <option key={value} value={value}>{stateLabels[value]}</option>)}</select></label>
        <label>目标负责人<input required maxLength={100} value={draft.owner} onChange={event => update('owner', event.target.value)} /></label>
        <label>时间跨度<input maxLength={200} placeholder="例如 2027 年第一季度" value={draft.horizon} onChange={event => update('horizon', event.target.value)} /></label>
      </div>
      <label>上级目标<select value={draft.parent} onChange={event => update('parent', event.target.value)}>
        <option value="">顶层目标</option>{available.map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
      </select></label>
      <h4>跨目标关系</h4>
      <ul className="hub-inline-list">{draft.relations.map(row => <li key={`${row.kind}:${row.target}`}>
        <span style={{ overflowWrap: 'anywhere' }}>{relationLabels[row.kind]} · {nameOf(goals, row.target)}</span>
        <button type="button" onClick={() => update('relations', draft.relations.filter(item => item !== row))}>移除关系</button>
      </li>)}</ul>
      {available.length > 0 && <div className="hub-actions">
        <select aria-label="关系类型" value={relation} onChange={event => setRelation(event.target.value as typeof relation)}>
          {GOAL_RELATIONS.map(value => <option key={value} value={value}>{relationLabels[value]}</option>)}</select>
        <select aria-label="关系目标" value={candidateTarget} onChange={event => selectTarget(event.target.value)}>
          <option value="">选择关联目标</option>{available.map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}</select>
        <button type="button" disabled={!candidateTarget || hasRelation || draft.relations.length >= maxRows} onClick={() => {
          update('relations', [...draft.relations, { target: candidateTarget, kind: relation }]); selectTarget('')
        }}>添加关系</button>
      </div>}
      <h4>验收条件</h4>
      {draft.criteria.map((row, index) => <div className="hub-card" key={row.key}>
        <label>验收条件 {index + 1}<input required maxLength={600} value={row.text} onChange={event => update('criteria', draft.criteria.map(item => item.key === row.key ? { ...item, text: event.target.value } : item))} /></label>
        <div className="hub-actions">
          <label className="hub-check"><input type="checkbox" checked={row.required} onChange={event => update('criteria', draft.criteria.map(item => item.key === row.key ? { ...item, required: event.target.checked } : item))} />必要条件</label>
          <button type="button" onClick={() => update('criteria', draft.criteria.filter(item => item.key !== row.key))}>移除条件</button>
        </div>
      </div>)}
      <button type="button" disabled={draft.criteria.length >= maxRows} onClick={() => update('criteria', [...draft.criteria, { key: requestId(), text: '', required: true }])}>添加验收条件</button>
      <label>变更依据<textarea required maxLength={1200} value={draft.reason} onChange={event => update('reason', event.target.value)} /></label>
      <div className="hub-actions"><button className="hub-primary" disabled={!valid || !changed.length}>核对变更</button><button type="button" onClick={cancel}>关闭草稿</button></div>
    </form>}
  </section>
}

function FindingEvidence({ scope, tasks, selected, choose, go, active }: {
  scope: string; tasks: readonly WorkspaceTicket[]; selected: GoalReference[]; choose: (references: GoalReference[]) => void; go: HubNav; active: boolean
}) {
  const [ticket, setTicket] = useState('')
  const [id, setId] = useState('')
  const query = useHubQuery<CurrentMission>(scope, ticket ? scopedPath(scope, `mission/${ticket}`, { limit: 1 }) : undefined, undefined, active)
  const choices = (query.data?.evidence ?? []).filter(row => row.ticketId === ticket && row.kind === 'delivery' && row.availability === 'available' && !row.historical && row.version)
  const evidence = choices.find(row => row.id === id)
  return <div>
    <ul className="hub-inline-list">{selected.map(ref => <li key={evidenceKey(ref)}>
      <EvidenceLink reference={ref} go={go} />
      <button type="button" onClick={() => choose(selected.filter(row => evidenceKey(row) !== evidenceKey(ref)))}>移除证据</button>
    </li>)}</ul>
    {tasks.length > 0 ? <>
      <label>证据所在工单<select value={ticket} onChange={event => { setTicket(event.target.value); setId('') }}>
        <option value="">选择关联工单</option>{tasks.map(task => <option key={task.id} value={task.id}>{task.id} · {task.title}</option>)}</select></label>
      <ReadIssue error={query.error} at={query.readAt} retry={() => { void query.refresh() }} />
      {ticket && !query.error && !query.data && <p role="status">正在读取工单交付…</p>}
      {query.data && !choices.length && <p className="hub-muted">这张工单没有可选的当前版本交付。</p>}
      {choices.length > 0 && <>
        <label>交付证据<select value={id} onChange={event => setId(event.target.value)}>
          <option value="">选择指定版本</option>{choices.map(row => <option key={row.id} value={row.id}>{row.title} · {row.version!.slice(0, 12)}</option>)}</select></label>
        {evidence && <div className="hub-actions">
          <EvidenceLink reference={{ ticketId: ticket, evidenceId: evidence.id }} go={go}>查看选中版本</EvidenceLink>
          <button type="button" disabled={!!query.error || selected.length >= maxRows || selected.some(ref => ref.ticketId === ticket && ref.evidenceId === evidence.id)} onClick={() => {
            choose([...selected, { ticketId: ticket, evidenceId: evidence.id }]); setId('')
          }}>引用该版本</button>
        </div>}
      </>}
    </> : <p className="hub-muted">关联工单登记交付后，可以选择证据版本。</p>}
  </div>
}

function AssessmentEditor({ scope, data, base, go, cancel, save, active }: {
  scope: string; data: GoalDetailData; base: GoalVersion; go: HubNav; cancel: () => void; save: (result: ChangeReceipt) => void; active: boolean
}) {
  const [findings, setFindings] = useState<GoalFinding[]>(base.assessment?.findings ?? [])
  const [result, setResult] = useState<GoalAssessment['result']>(base.assessment?.result ?? 'none')
  const [note, setNote] = useState(base.assessment?.note ?? '')
  const [status, setStatus] = useState(base.status)
  const action = useHubAction(scope)
  const currentVersion = currentGoal(data.goal).version
  const stale = currentVersion !== base.version
  const required = base.criteria.filter(row => row.required)
  const allMet = !!required.length && required.every(row => findings.some(finding => finding.criterionId === row.id && finding.status === 'met' && finding.evidence.length > 0))
  const valid = !stale && note.trim() && (result !== 'met' || allMet) && (status !== 'achieved' || result === 'met' && allMet)
    && findings.every(row => row.note.trim() && (row.status !== 'met' || row.evidence.length > 0))
  const update = (id: string, change: GoalFinding | undefined) => setFindings(rows => [...rows.filter(row => row.criterionId !== id), ...(change ? [change] : [])])
  return <section className="hub-section">
    <h3>复核目标成果 · 第 {base.version} 版</h3>
    {stale && <p className="hub-error" role="alert">目标已更新到第 {currentVersion} 版。当前草稿仍基于原验收条件。</p>}
    <form onSubmit={async event => {
      event.preventDefault()
      if (!valid) return
      const receipt = await action.run<ChangeReceipt>(`goals/${data.goal.id}`, {
        expectedVersion: base.version, reason: note.trim(), status, assessment: { result, note: note.trim(), findings },
      })
      if (receipt) save(receipt)
    }}>
      {base.criteria.map(criterion => {
        const finding = findings.find(row => row.criterionId === criterion.id)
        return <div className="hub-card" key={criterion.id}>
          <p><b>{criterion.text}</b> <span className="hub-muted">· {criterion.required ? '必要条件' : '可选条件'}</span></p>
          <label>条件判断<select value={finding?.status ?? ''} onChange={event => {
            const value = event.target.value as GoalFinding['status'] | ''
            update(criterion.id, value ? { criterionId: criterion.id, evidence: finding?.evidence ?? [], note: finding?.note ?? '', status: value } : undefined)
          }}>
            <option value="">本次暂不判断</option>{Object.entries(findingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
          {finding && <>
            <label>证据为何适用<textarea required maxLength={2000} value={finding.note} onChange={event => update(criterion.id, { ...finding, note: event.target.value })} /></label>
            <FindingEvidence scope={scope} tasks={data.tasks} selected={finding.evidence} choose={evidence => update(criterion.id, { ...finding, evidence })} go={go} active={active} />
          </>}
        </div>
      })}
      <label>评估结论<select value={result} onChange={event => {
        const value = event.target.value as GoalAssessment['result']
        setResult(value)
      }}>
        {GOAL_RESULTS.map(value => <option key={value} value={value}>{resultLabels[value]}</option>)}
      </select></label>
      {result === 'met' && !allMet && <p className="hub-restrictions">请为每项必要条件引用证据并确认判断。</p>}
      {base.type === 'project' && <label>目标状态<select value={status} onChange={event => setStatus(event.target.value as GoalVersion['status'])}>
        {GOAL_STATES.map(value => <option key={value} value={value} disabled={value === 'achieved' && !(allMet && result === 'met')}>{stateLabels[value]}</option>)}
      </select></label>}
      <label>评估依据<textarea required maxLength={1200} value={note} onChange={event => setNote(event.target.value)} /></label>
      <ReadIssue error={action.error} />
      <div className="hub-actions"><button className="hub-primary" disabled={!valid || action.busy}>{action.busy ? '正在保存…' : '保存复核'}</button><button type="button" disabled={action.busy} onClick={cancel}>取消复核</button></div>
    </form>
  </section>
}

function GoalConditions({ version, invalid, go, count, total }: {
  version: GoalVersion; invalid: GoalDetailData['invalidEvidence']; go: HubNav; count?: number; total?: number
}) {
  const assessment = version.assessment
  const failed = new Map(invalid?.map(ref => [evidenceKey(ref), ref.reason]))
  const stale = !!invalid?.length
  const unmet = version.criteria.filter(criterion => criterion.required && assessment?.findings.some(finding => finding.criterionId === criterion.id && finding.status === 'unmet'))
  return <section className="hub-section hub-goal-progress" aria-label="目标进展"><h3>目标进展</h3>
    <p className="hub-goal-result"><b>{assessment && stale ? '证据待重新核实' : resultLabels[assessment?.result ?? 'none']}</b></p>
    {stale ? <p>相关证据已变化，请重新核对成果条件。上次评估保留在详情中。</p>
      : assessment ? <>
        <p className="hub-goal-assessment-note">{assessment.note.length > 160 ? assessment.note.slice(0, 160) + '…' : assessment.note}</p>
        {unmet.length > 0 && <div className="hub-goal-unmet" aria-label="目标未满足的必要条件"><h4>目标尚未满足</h4>
          <ul>{unmet.slice(0, 2).map(criterion => <li key={criterion.id}>{criterion.text}</li>)}</ul>
          {unmet.length > 2 && <p className="hub-muted">另有 {unmet.length - 2} 项，请展开成果与验收条件查看。</p>}
        </div>}
      </> : <p className="hub-muted">当前版本尚未评估，请先核对成果条件。</p>}
    <details className="hub-disclosure hub-goal-conditions"><summary><h3>成果与验收条件</h3>
      {total !== undefined && <span className="hub-muted">{total > 0 ? `${count ?? 0} / ${total} 项必要条件已确认` : '尚未登记必要条件'}</span>}
    </summary>
    {assessment && <>
      <p className="hub-muted">{stale ? '上次评估' : '复核于'} {timeLabel(assessment.at)} · 适用第 {assessment.version} 版</p>
      {(stale || assessment.note.length > 160) && <p>{assessment.note}</p>}
    </>}
    <ul className="hub-list">{version.criteria.map(criterion => {
      const finding = assessment?.findings.find(row => row.criterionId === criterion.id)
      const needsReview = finding?.evidence.some(ref => failed.has(evidenceKey(ref)))
      return <li key={criterion.id}>
        <p><b>{criterion.text}</b> <span className="hub-muted">· {criterion.required ? '必要条件' : '可选条件'} · {needsReview ? '证据待重新核实' : finding ? findingLabels[finding.status] : '待评估'}</span></p>
        {finding?.note && <p>{finding.note}</p>}
        {finding?.evidence.map(ref => <div className="hub-actions" key={evidenceKey(ref)}>
          <EvidenceLink reference={ref} go={go} />
          {failed.has(evidenceKey(ref)) && <span className="hub-muted">{failed.get(evidenceKey(ref))}</span>}
        </div>)}
      </li>
    })}</ul></details>
  </section>
}

function GoalDetails({ detail, goals, go, edit, assess, canWrite, selectedVersion }: {
  detail: GoalDetailData; goals: readonly GoalSummary[]; go: HubNav; edit: (target: EditorTarget) => void; assess: (base: GoalVersion) => void
  canWrite: boolean; selectedVersion?: number
}) {
  const { goal, items, tasks } = detail
  const current = currentGoal(goal)
  const [historyVersion, selectHistory] = useState(selectedVersion)
  const historical = historyVersion !== undefined
  const version = historical ? goal.versions.find(row => row.version === historyVersion) : current
  if (!version) return <section className="hub-section">
    <h3>{current.name}</h3>
    <p role="status">找不到目标的第 {historyVersion} 版。</p>
    <button type="button" onClick={() => selectHistory(undefined)}>打开当前目标</button>
  </section>
  const children = goals.filter(row => row.parent === goal.id)
  const blockers = historical ? [] : version.relations.filter(row => row.kind === 'requires').filter(row => goals.some(target => target.id === row.target && target.status !== 'achieved'))
  const waiting = tasks.filter(task => !task.outcome && (task.stage.startsWith('you/') || task.waitingFor.length || task.stage === 'remote'))
  const visibleTasks = (waiting.length ? waiting : tasks).slice(0, 3)
  const otherTasks = tasks.filter(task => !visibleTasks.includes(task))
  const linkedTask = (task: WorkspaceTicket) => <li key={task.id}>
    <button type="button" className="hub-row" onClick={() => go({ page: 'mission', id: task.id })}>
      <span><b>{STAGE_LABEL[task.outcome ?? task.stage] ?? task.stage}</b><small className="hub-task-title" title={task.title}>{task.title}</small>
        <small>{task.id} · 执行角色 {task.roleName ?? task.staff}</small>
        {!!task.waitingFor.length && <small>等待子工单 {task.waitingFor.join('、')}</small>}
        {task.outcome === 'done' && (!version.assessment || !!task.endedAt && task.endedAt > version.assessment.at) && <small>成果待评估</small>}</span>
      <span className="hub-state">查看工单</span>
    </button>
    <details className="hub-goal-more"><summary>关联依据与执行方式</summary>
      <p className="hub-muted">{version.criteria.some(criterion => version.assessment?.findings.some(finding => finding.criterionId === criterion.id && finding.evidence.some(ref => ref.ticketId === task.id)))
        ? `关联验收条件 · ${version.criteria.filter(criterion => version.assessment?.findings.some(finding => finding.criterionId === criterion.id && finding.evidence.some(ref => ref.ticketId === task.id))).map(row => row.text).join('、')}`
        : '背景关联 · 尚未绑定成果条件'}</p>
      {task.executor && <p className="hub-muted">执行方式 · {task.executor}</p>}
    </details>
  </li>
  return <>
    <section className="hub-section hub-goal-heading">
      <div className="hub-item-title"><h3 style={wrap}>{version.name}</h3><span className="hub-state">
        {version.status === 'achieved' && !historical && detail.invalidEvidence?.length ? '已登记达成 · 待复核' : stateLabels[version.status]}
      </span></div>
      <p className="hub-goal-owner"><span>目标负责人</span><strong>{version.owner}</strong></p>
      {historical && <p className="hub-restrictions">历史目标 · 第 {version.version} 版 · {timeLabel(version.at)}</p>}
      <div className="hub-actions">{historical
        ? <button type="button" onClick={() => { selectHistory(undefined); if (selectedVersion !== undefined) go({ page: 'goals', id: goal.id }) }}>打开当前目标</button>
        : <button type="button" className="hub-primary" disabled={!canWrite} onClick={() => go({ page: 'review', goal: goal.id })}>开始复盘</button>}
      </div>
    </section>
    <div className="hub-columns hub-goal-facts">
        <GoalConditions version={version} invalid={historical ? undefined : detail.invalidEvidence} go={go}
          count={historical ? undefined : detail.knownConditions} total={historical ? undefined : detail.requiredConditions} />
        {!historical && <section className="hub-section" aria-label="工单当前等待"><h3>工单当前等待</h3>
          {detail.hasNewEvidence && <p className="hub-muted">有新的核验记录待评估。</p>}
          {!tasks.length && !items.length && <p className="hub-muted">当前没有关联工单或事项。</p>}
          {tasks.length > 0 && !waiting.length && <p className="hub-muted">目前没有已登记的等待事项。</p>}
          {visibleTasks.length > 0 && <ul className="hub-list">{visibleTasks.map(linkedTask)}</ul>}
          {otherTasks.length > 0 && <details className="hub-goal-more"><summary>其余 {otherTasks.length} 张关联工单{waiting.length > 3 ? ` · ${waiting.length - 3} 张有等待事项` : ''}</summary>
            <ul className="hub-list">{otherTasks.map(linkedTask)}</ul></details>}
          {items.length > 0 && <details className="hub-goal-more"><summary>{items.length} 条关联事项与备忘</summary><ul className="hub-list">{items.map(item => <li key={`${item.receiptId}:${item.itemId}`}>
            <button type="button" className="hub-row" onClick={() => go({ page: 'intake', id: item.receiptId })}><span><b>{item.title}</b><small>{item.disputed ? '归属待复核' : item.primary === undefined ? '关联事项' : item.primary ? '主目标' : '支持目标'} · {itemLabels[item.state] ?? item.state}</small></span></button>
          </li>)}</ul></details>}
        </section>}
    </div>
    <details className="hub-section hub-disclosure hub-goal-manage"><summary><h3>目标说明、版本与管理</h3></summary>
      <p className="hub-muted">{typeLabels[version.type]} · {version.horizon || '时间跨度未登记'} · 第 {version.version} 版</p>
      {version.description && <p style={{ whiteSpace: 'pre-wrap' }}>{version.description}</p>}
      <p className="hub-muted">目标标识 {goal.id}</p>
      {goal.source.kind === 'markdown' && <details><summary>来源 · goals.md · {goal.source.section}</summary><blockquote>{goal.source.text}</blockquote></details>}
      {goal.source.kind === 'owner' && <p className="hub-muted">来源 · 主人登记</p>}
      {historical && <p>修订依据 · {version.reason}</p>}
      <div className="hub-actions"><button type="button" onClick={() => go({ page: 'goals' })}>全部目标</button>
        {!historical && <>
          <button type="button" disabled={!canWrite} onClick={() => edit({ goal, version: current })}>修订目标</button>
          <button type="button" className="hub-primary" disabled={!canWrite} onClick={() => assess(current)}>复核成果</button>
        </>}
      </div>
      {(goal.versions.length > 1 || historical) && <label>查看目标版本<select value={historyVersion ?? ''} onChange={event => selectHistory(event.target.value ? Number(event.target.value) : undefined)}>
        <option value="">当前 · 第 {current.version} 版</option>
        {[...goal.versions].reverse().map(row => <option key={row.version} value={row.version}>第 {row.version} 版 · {row.name} · {timeLabel(row.at)}</option>)}
      </select></label>}
    </details>
    <details className="hub-section hub-disclosure"><summary><h3>层级与关系</h3>{blockers.length > 0 && <span className="hub-muted">{blockers.length} 个依赖目标尚未达成</span>}</summary>
        {version.parent ? <div className="hub-actions"><span>上级目标</span><GoalLink id={version.parent} goals={goals} go={go} /></div> : <p>顶层目标</p>}
        {!historical && children.length > 0 && <><h4>下级目标</h4>
          <ul className="hub-list">{children.map(child => <li key={child.id}><GoalLink id={child.id} goals={goals} go={go} /></li>)}</ul></>}
        {version.relations.length > 0 && <><h4>跨目标关系</h4>
          <ul className="hub-list">{version.relations.map(row => <li key={`${row.kind}:${row.target}`}><div className="hub-actions">
            <span>{relationLabels[row.kind]}</span><GoalLink id={row.target} goals={goals} go={go} />
            {blockers.includes(row) && <span className="hub-state">等待依赖目标达成</span>}
          </div></li>)}</ul></>}
    </details>
  </>
}

export function GoalMap({ scope, id, catalog, go, refreshCatalog, active = true, version }: {
  scope: string; id?: string; catalog?: HubGoals; go: HubNav; refreshCatalog: () => unknown; active?: boolean; version?: number
}) {
  const detail = useHubQuery<GoalDetailData>(scope, id ? scopedPath(scope, `goals/${encodeURIComponent(id)}`) : undefined, 12_000, active)
  const [edit, setEdit] = useState<EditorTarget>()
  const [assessment, setAssessment] = useState<GoalVersion>()
  const [receipt, setReceipt] = useState<ChangeReceipt>()
  const goals = catalog?.goals ?? []
  const save = (response: ChangeReceipt) => {
    setReceipt(response); setEdit(undefined); setAssessment(undefined); void refreshCatalog()
    if (response.goal.id === id) void detail.refresh()
    else go({ page: 'goals', id: response.goal.id })
  }
  return <>
    <ReadIssue error={detail.error} at={detail.readAt} retry={() => { void detail.refresh() }} />
    {receipt && <p role="status">已保存 {receipt.current.name} 第 {receipt.current.version} 版 · {receipt.impact.items} 条关联事项，{receipt.impact.tickets.length} 张关联工单</p>}
    {edit && <GoalEditor scope={scope} target={edit} goals={goals} current={detail.data} cancel={() => setEdit(undefined)} reload={detail.refresh} save={save} />}
    {assessment && detail.data && <AssessmentEditor scope={scope} data={detail.data} base={assessment} go={go} cancel={() => setAssessment(undefined)} save={save} active={active} />}
    {!edit && !assessment && (id
      ? detail.data
        ? <GoalDetails detail={detail.data} goals={goals} go={go} edit={setEdit} assess={setAssessment} selectedVersion={version}
          canWrite={!detail.error && (receipt?.current.version ?? 0) <= currentGoal(detail.data.goal).version} />
        : !detail.error && <p role="status">正在读取目标详情…</p>
      : <GoalCatalog catalog={catalog} go={go} edit={setEdit} />)}
  </>
}
