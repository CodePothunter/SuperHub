import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { FeatureAnchor, FeatureRef } from '../core/superhub-intake.ts'
import type { IntakeItem, IntakeReceiptView, LiaisonAuthorization, OwnerChoices } from '../dsh/superhub.ts'
import { INSTANCE_LABEL, Mission, ScopedEvidence } from './superhub-mission.tsx'
import { GoalMap } from './superhub-goals.tsx'
import { SituationReview } from './superhub-saa.tsx'
import { ReadIssue } from './superhub-common.tsx'
import { CommandDecisionRow } from './approvals.tsx'
import { DECISIONS_NAME, NO_DECISIONS, OVERVIEW_NAME, WORKSPACE_NAME } from './workspace-brand.tsx'
import { STAGE_LABEL, scopedPath, timeLabel, useHubAction, useHubQuery, type HubGoals, type HubOverview, type HubRoleActivity, type IntakeReceipt, type Scoped, type WorkspaceTicket } from './superhub-api.ts'

export { ReadIssue } from './superhub-common.tsx'

export type HubPlace =
  | { page: 'intake' | 'overview'; id?: string }
  | { page: 'review'; id?: string; goal?: string }
  | { page: 'goals'; id?: string; version?: number }
  | { page: 'role'; id: string }
  | { page: 'mission'; id: string; instance?: string; event?: string; at?: string }
  | { page: 'evidence'; id: string; evidence: string }

export function hubHash(scope: string, place: HubPlace): string {
  const params = new URLSearchParams({ scope, page: place.page })
  Object.entries(place).forEach(([key, value]) => { if (key !== 'page' && value) params.set(key, String(value)) })
  return `#superhub?${params}`
}
export function hubPlace(params: URLSearchParams): HubPlace | undefined {
  const page = params.get('page'), id = params.get('id') || undefined
  if (page === 'overview' || page === 'intake') return { page, id }
  if (page === 'review') {
    const goal = params.get('goal')
    return { page, id, ...goal && /^G-[a-f0-9-]{36}$/.test(goal) ? { goal } : {} }
  }
  if (page === 'goals') {
    const version = Number(params.get('version'))
    return { page, id, ...Number.isSafeInteger(version) && version > 0 ? { version } : {} }
  }
  if (page === 'role' && id && id.length <= 120) return { page, id }
  if (id && /^T-\d+$/.test(id)) {
    if (page === 'mission') return { page, id, instance: params.get('instance') || undefined, event: params.get('event') || undefined, at: params.get('at') || undefined }
    const evidence = params.get('evidence')
    if (page === 'evidence' && evidence) return { page, id, evidence }
  }
}
export type HubNav = (place: HubPlace) => void
const titles = { overview: DECISIONS_NAME, intake: '交办回执', goals: '目标地图', review: '局势校准', mission: '执行指挥塔', evidence: '证据' }
const channel: Record<string, string> = { chat: '接口人对话', owner: `${WORKSPACE_NAME}交办`, discussion: '讨论原话', native: 'DSH 原生会话', hub: WORKSPACE_NAME }
const itemStatus: Record<string, string> = {
  recorded: '已记录', clarify: '待澄清', ready: '等待派工', dispatching: '正在登记工单', dispatched: '工单已登记',
  stopped: '已提交停止', failed: '登记失败', conversation: '对话',
}
const intentLabel = { memo: '备忘', execute: '执行请求', conversation: '对话' }
const goalLabels: Record<string, string> = { unassigned: '暂未归属', independent: '无需归属', disputed: '归属待复核', associated: '已关联' }
const operationLabel = (value?: string) => value === 'write' ? '写入，需主人批准' : value === 'read' ? '只读调查' : undefined
const choicesLabel = (choices: OwnerChoices, staff: { id: string; name: string }[], features: FeatureAnchor[]) => [
  operationLabel(choices.operation), choices.staff && `负责人 ${staff.find(row => row.id === choices.staff)?.name ?? choices.staff}`,
  choices.feature && `功能 ${features.find(row => row.id === choices.feature!.id)?.title ?? choices.feature.id} v${choices.feature.version}`,
].filter(Boolean).join('，')
/** 接口人依据主人原话的理解：意图、读写方式、负责人、功能与主人的限制。 */
function understanding(row: LiaisonAuthorization): string {
  const parts = (row.intent === 'memo' ? ['只记下，不派工'] : [operationLabel(row.operation), row.staff && `交给 ${row.staff}`,
    row.feature && `修改 ${row.feature.title}（依据：${row.feature.basis}）`]).filter((part): part is string => !!part)
  if (row.ownerChoices) parts.push('读写方式、负责人或功能按主人在交办页的指定')
  return `${row.brief}${parts.length || row.restrictions?.length ? `（${parts.join('，')}${row.restrictions?.length ? `；主人限制：${row.restrictions.map(rule => `「${rule}」`).join('')}` : ''}）` : ''}`
}

export function TicketRows({ rows, go }: { rows: WorkspaceTicket[]; go: HubNav }) {
  return <ul className="hub-list">{rows.map(ticket => <li key={ticket.id}>
    <button className="hub-row" onClick={() => go({ page: 'mission', id: ticket.id })}>
      <span><b className="hub-task-title">{ticket.title}</b><small>{ticket.id}{ticket.roleName ? ` · ${ticket.roleName}` : ''}</small>
        {(ticket.question || ticket.summary) && <small className="hub-task-summary">{ticket.question ?? ticket.summary}</small>}</span>
      <span className="hub-state">{STAGE_LABEL[ticket.outcome ?? ticket.stage] ?? ticket.stage}</span>
    </button>
  </li>)}</ul>
}

function Overview({ scope, go, openRoom, refreshBoard, active }: { scope: string; go: HubNav; openRoom: (id: string) => void; refreshBoard: () => void; active: boolean }) {
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [offset, setOffset] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const { data, error, readAt, refresh } = useHubQuery<HubOverview>(scope, scopedPath(scope, 'overview', { q: search, offset }), 6000, active)
  const action = useHubAction(scope)
  const tickets = data?.tickets.filter(ticket => search || !data.decisions.some(decision => decision.id === ticket.id)) ?? []
  return <div className="hub-columns">
    <div>
      <section className="hub-section"><h3>{DECISIONS_NAME}</h3>
        <ReadIssue error={error} at={readAt} retry={() => void refresh()} />
        {data && !data.decisions.length && !data.roomActions.length && !data.stuck.length && !data.commands?.length && <p className="hub-muted">{NO_DECISIONS}</p>}
        {!data && !error && <p role="status">正在读取决定和工单…</p>}
        {data?.commands?.map(row => <CommandDecisionRow key={row.id} row={row} variant="hub" settled={() => void refresh()} />)}
        <TicketRows rows={data?.decisions ?? []} go={go} />
        {data?.roomActions.map(action => <div className="hub-card" key={action.id}><b>{action.roomTitle}</b><p>{action.text}</p><button onClick={() => openRoom(action.roomId)}>打开讨论</button></div>)}
        {data?.stuck.map(row => <div className="hub-card" key={row.id}><b>{row.text}</b><p className="hub-muted">{row.reason}</p>
          <button disabled={action.busy} onClick={async () => {
            const result = await action.run(`overview/${encodeURIComponent(row.id)}`, { action: 'retriage' })
            if (result) { await refresh(); refreshBoard() }
          }}>请求重新研判</button></div>)}
        <ReadIssue error={action.error} />
      </section>
      <section className="hub-section"><h3>工单</h3>
        <form className="hub-actions" onSubmit={e => { e.preventDefault(); setSearch(query); setOffset(0); setShowAll(false) }}>
          <input type="search" aria-label="搜索工单" placeholder="标题或工单号" value={query} onChange={e => setQuery(e.target.value)} />
          <button>搜索</button>
        </form>
        <TicketRows rows={search || showAll ? tickets : tickets.slice(0, 6)} go={go} />
        {data && !tickets.length && <p className="hub-muted">{data.tickets.length ? '需要你处理的工单已列在上方。' : '这个查询没有工单。'}</p>}
        {!search && tickets.length > 6 && <button className="hub-list-more" onClick={() => setShowAll(value => !value)}>{showAll ? '收起较早工单' : `显示本页其余 ${tickets.length - 6} 张工单`}</button>}
        <div className="hub-actions">{offset > 0 && <button onClick={() => { setOffset(Math.max(0, offset - 40)); setShowAll(false) }}>上一页</button>}
          {data?.nextOffset !== undefined && <button onClick={() => { setOffset(data.nextOffset!); setShowAll(false) }}>下一页</button>}</div>
      </section>
    </div>
    <section className="hub-section"><h3>角色活动</h3>
      <ul className="hub-list hub-role-list">{data?.roles.map(role => <li key={role.id}>
        <button className="hub-row" onClick={() => go({ page: 'role', id: role.id })}><span><b>{role.name}</b>
          <small>{role.status === 'not-started' ? '暂无活动' : role.status === 'active' ? '有工作进行中' : role.status === 'historical' ? `${role.instanceCount} 次已登记活动` : '活动尚未证实'}</small></span>
          <span className="hub-muted" aria-hidden="true">›</span>
        </button>
      </li>)}</ul>
    </section>
  </div>
}

function RoleHistory({ scope, id, go, active }: { scope: string; id: string; go: HubNav; active: boolean }) {
  const [pages, setPages] = useState<(string | undefined)[]>([undefined])
  const path = scopedPath(scope, `roles/${encodeURIComponent(id)}`, { cursor: pages.at(-1) })
  const query = useHubQuery<HubRoleActivity>(scope, path, undefined, active)
  const row = query.data
  return <section className="hub-section">
    <ReadIssue error={query.error} at={query.readAt} retry={() => void query.refresh()} />
    {!row && !query.error && <p role="status">正在读取角色活动…</p>}
    {row && <>
      <h3>{row.role.name}的活动</h3>
      <p className="hub-muted">已登记 {row.total} 次活动。选择一项查看对应执行记录。</p>
      {!row.items.length && <p>当前没有已登记的实例。</p>}
      <ul className="hub-list">{row.items.map(instance => <li key={instance.id}>
        <button className="hub-row" onClick={() => go({ page: 'mission', id: instance.ticketId, instance: instance.id })}><span>
          <b>{instance.ticketId} · 第 {instance.round + 1} 轮{instance.kind === 'verify' ? '核验' : '执行'} · 尝试 {instance.attempt}</b>
          <small>{timeLabel(instance.startedAt)} · {instance.sessionId ? '可查看原生执行记录' : '查看已登记过程与来源说明'}</small>
        </span><span className="hub-state">{INSTANCE_LABEL[instance.status] ?? instance.status}</span></button>
      </li>)}</ul>
      <div className="hub-actions">
        {pages.length > 1 && <button onClick={() => setPages(previous => previous.slice(0, -1))}>上一页</button>}
        {row.nextCursor && <button onClick={() => setPages(previous => [...previous, row.nextCursor])}>更早活动</button>}
      </div>
    </>}
  </section>
}

function GoalPicker({ catalog, ids, change, name }: { catalog: HubGoals['goals']; ids: string[]; change: (ids: string[]) => void; name: string }) {
  const [selected, setSelected] = useState('')
  return <div className="hub-goal-picker">
    {ids.length > 0 && <ul className="hub-inline-list">{ids.map((id, index) => <li key={id}><span>{index === 0 ? '主目标' : '支持'} · {catalog.find(row => row.id === id)?.name ?? id}</span>
      <button aria-label={`移除 ${catalog.find(row => row.id === id)?.name ?? id}`} onClick={() => change(ids.filter(item => item !== id))} type="button">移除</button></li>)}</ul>}
    {catalog.length > 0 && <div className="hub-actions"><select aria-label={name} value={selected} onChange={e => setSelected(e.target.value)}><option value="">选择目标</option>
      {catalog.filter(goal => !ids.includes(goal.id) && goal.status !== 'archived').map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}</select>
      <button type="button" disabled={!selected || ids.includes(selected) || ids.length >= 8} onClick={() => { change([...ids, selected]); setSelected('') }}>添加</button></div>}
  </div>
}

function ReceiptItem({ scope, receipt, item, catalog, features, staff, go, update }: { scope: string; receipt: IntakeReceipt; item: IntakeItem; catalog: HubGoals['goals']; features: FeatureAnchor[]; staff: { id: string; name: string; executor?: string }[]; go: HubNav; update: (row: IntakeReceipt) => void }) {
  const operation = useHubAction(scope)
  const [goalIds, setGoals] = useState(item.goalIds)
  const [feature, setFeature] = useState(''), [correction, setCorrection] = useState(''), [staffId, setStaff] = useState('')
  const chosen = features.find(row => row.id === feature)
  const act = async (action: string, fields: Record<string, unknown> = {}) => {
    const result = await operation.run<IntakeReceipt>(`items/${encodeURIComponent(receipt.id)}`, {
      action, expectedVersion: receipt.version, itemId: item.id, ...fields,
    })
    if (result) update(result)
  }
  const fix = (value?: FeatureRef) => void act('clarify', { ...value ? { feature: { id: value.id, version: value.version } } : {}, ...(correction.trim() ? { text: correction } : {}) })
  return <div className="hub-card">
    <div className="hub-item-title"><b>{item.title}</b><span className="hub-state">{itemStatus[item.state] ?? item.state}</span></div>
    <p className="hub-muted">{intentLabel[item.intent]} · {goalLabels[item.goalDisposition] ?? item.goalDisposition}</p>
    <p>{item.reason}</p>
    {item.feature && <p>定位到 {item.feature.title} · v{item.feature.version} <small>{item.feature.basis}</small></p>}
    {!!item.restrictions.length && <p className="hub-restrictions">限定范围 · {item.restrictions.join('；')}</p>}
    {item.question && <div className="hub-clarify">
      <b>{item.question}</b>
      <div className="hub-actions">{item.candidates?.map(row => <button type="button" disabled={operation.busy} key={row.id} onClick={() => fix(row)}>{row.title}</button>)}</div>
      {!!features.length && <label>功能<select value={feature} onChange={e => setFeature(e.target.value)}><option value="">选择适用功能</option>{features.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>}
      <label>补充原话<textarea maxLength={4000} value={correction} placeholder="补充的话会交给接口人重新理解" onChange={e => setCorrection(e.target.value)} /></label>
      <button disabled={operation.busy || (!chosen && !correction.trim())} onClick={() => fix(chosen)}>确认澄清</button>
    </div>}
    <details><summary>目标归属</summary>
      <GoalPicker name="为事项选择目标" catalog={catalog} ids={goalIds} change={setGoals} />
      <div className="hub-actions">
        <button disabled={operation.busy} onClick={() => void act('associate', { goalIds })}>保存归属</button>
        <button disabled={operation.busy || !goalIds.length} onClick={() => void act('associate', { goalIds, goalDisposition: 'disputed' })}>标记归属待复核</button>
        <button disabled={operation.busy} onClick={() => void act('associate', { goalIds: [], goalDisposition: 'independent' })}>设为无需归属</button>
      </div>
    </details>
    <div className="hub-actions">
      {item.ticketId && <button className="hub-primary" onClick={() => go({ page: 'mission', id: item.ticketId! })}>打开工单 {item.ticketId}</button>}
      {(item.state === 'ready' || item.state === 'failed') && <button className="hub-primary" disabled={operation.busy} onClick={() => void act('dispatch')}>按当前范围派工</button>}
      {item.state === 'dispatching' && <button className="hub-primary" disabled={operation.busy} onClick={() => void act('dispatch')}>重试登记工单</button>}
      {item.intent === 'execute' && <button disabled={operation.busy} onClick={() => void act('record')}>{item.ticketId ? '停止原交办并转为备忘' : '仅保留备忘'}</button>}
      {(item.state === 'dispatched' || item.state === 'dispatching') && <button disabled={operation.busy} onClick={() => void act('stop')}>停止原交办</button>}
    </div>
    {item.state === 'dispatched' && item.operation === 'read' && item.ticketId && <details><summary>改派只读事项</summary>
      <div className="hub-actions"><select aria-label="选择新的本地幕僚" value={staffId} onChange={e => setStaff(e.target.value)}><option value="">选择本地幕僚</option>
        {staff.filter(row => row.executor !== 'remote').map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
        <button disabled={!staffId || operation.busy} onClick={() => void act('reassign', { staff: staffId })}>请求停止原工单并改派</button></div>
    </details>}
    {item.stop && <p className="hub-muted">{item.stop.ticketId} · {item.stop.state === 'pending' ? '正在登记停止请求'
      : item.stop.state === 'finished' ? '工单已结束，原执行结果保留' : '已登记停止，请看工单中的实例终止情况'}</p>}
    {!!item.priorTicketIds?.length && <div className="hub-actions">{item.priorTicketIds.map(id => <button key={id} onClick={() => go({ page: 'mission', id })}>前次派工 {id}</button>)}</div>}
    <ReadIssue error={operation.error} />
  </div>
}

function Intake({ scope, id, catalog, staff, go, refreshBoard, active }: { scope: string; id?: string; catalog: HubGoals['goals']; staff: { id: string; name: string; executor?: string }[]; go: HubNav; refreshBoard: () => void; active: boolean }) {
  const [cursor, setCursor] = useState<string>()
  const draftKey = `chief-superhub-intake:${scope}`
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey) ?? ''), [goalIds, setGoalIds] = useState<string[]>([])
  const [chosenOperation, setOperation] = useState(''), [chosenStaff, setChosenStaff] = useState(''), [chosenFeature, setChosenFeature] = useState('')
  // 原话刚交给接口人、还没有登记的工作时，详情页短时轮询，接口人登记后即可看到。
  const [waiting, setWaiting] = useState(false)
  const result = useHubQuery<Scoped & { receipts: IntakeReceipt[]; nextCursor?: string }>(scope, !id ? scopedPath(scope, 'items', { cursor }) : undefined, 6000, active)
  const detail = useHubQuery<IntakeReceiptView>(scope, id ? scopedPath(scope, `items/${encodeURIComponent(id)}`) : undefined, waiting ? 3000 : undefined, active)
  const anchors = useHubQuery<Scoped & { features: FeatureAnchor[] }>(scope, scopedPath(scope, 'features'), undefined, active)
  const operation = useHubAction(scope)
  const [edited, setEdited] = useState<IntakeReceiptView>()
  const receipt = edited?.id === id && edited && edited.version >= (detail.data?.version ?? 0) ? edited : detail.data
  const update = (row: IntakeReceipt) => { setEdited(row); refreshBoard(); void detail.refresh(); void result.refresh() }
  const origin = !!receipt && !receipt.authorization && receipt.items.every(item => item.intent === 'conversation')
  const recent = !!receipt && Date.now() - Date.parse(receipt.updatedAt) < 3 * 60_000
  useLayoutEffect(() => { setWaiting(origin && !receipt?.linked?.length && recent) }, [origin, receipt?.linked?.length, recent])
  const features = anchors.data?.features ?? []
  return <div className="hub-columns">
    <div>
      {id ? <section className="hub-section">
        <ReadIssue error={detail.error} at={detail.readAt} retry={() => void detail.refresh()} />
        {receipt ? <>
          <h3>主人原话</h3>
          <p className="hub-muted">{channel[receipt.source.channel] ?? receipt.source.channel} · {timeLabel(receipt.source.receivedAt)} · 回执版本 {receipt.version}</p>
          <blockquote>{receipt.source.text}</blockquote>
          {receipt.ownerChoices && <p className="hub-muted">主人指定：{choicesLabel(receipt.ownerChoices, staff, features)}</p>}
          {receipt.authorization && <p className="hub-muted">接口人依据主人原话理解为：{understanding(receipt.authorization)}</p>}
          {receipt.authorization?.chatReceiptId && <div className="hub-actions"><button onClick={() => go({ page: 'intake', id: receipt.authorization!.chatReceiptId })}>查看主人原话回执</button></div>}
          {receipt.items.map(item => <ReceiptItem key={`${item.id}:${receipt.version}`} scope={scope} receipt={receipt} item={item} catalog={catalog} features={features} staff={staff} go={go} update={update} />)}
          {(origin || !!receipt.linked?.length) && <section aria-label="接口人登记的工作">
            <h3>接口人登记的工作</h3>
            {receipt.linked?.length ? receipt.linked.map(row => <div key={row.id}>
              {row.authorization && <p className="hub-muted">接口人依据主人原话理解为：{understanding(row.authorization)}</p>}
              {row.items.map(item => <ReceiptItem key={`${item.id}:${row.version}`} scope={scope} receipt={row} item={item} catalog={catalog} features={features} staff={staff} go={go} update={update} />)}
            </div>) : <p className="hub-muted" role="status">{waiting ? '接口人正在理解这句话…' : '接口人没有为这句话登记交办或备忘，这句话只作为对话。'}</p>}
          </section>}
          {receipt.history.length > 0 && <details><summary>解释与授权修订</summary><ul className="hub-list">{[...receipt.history].reverse().map((row, i) => <li key={`${row.version}:${i}`}>
            v{row.version} · {timeLabel(row.at)} · {intentLabel[row.item.intent]} · {itemStatus[row.item.state]}<p>{row.item.title}</p></li>)}</ul></details>}
        </> : !detail.error && <p role="status">正在读取交办回执…</p>}
      </section> : <section className="hub-section">
        <h3>交办或记录</h3>
        <form onSubmit={async e => {
          e.preventDefault()
          const anchor = features.find(row => row.id === chosenFeature)
          const row = await operation.run<IntakeReceipt>('items', { text, goalIds, ...chosenOperation ? { operation: chosenOperation } : {},
            ...chosenStaff ? { staff: chosenStaff } : {}, ...anchor ? { feature: { id: anchor.id, version: anchor.version } } : {} })
          if (row) { setText(''); sessionStorage.removeItem(draftKey); setGoalIds([]); setOperation(''); setChosenStaff(''); setChosenFeature(''); update(row); go({ page: 'intake', id: row.id }) }
        }}>
          <label>原始指令<textarea value={text} maxLength={40_000} disabled={operation.busy} placeholder="写下要办的事、边界或一条备忘" onChange={e => { setText(e.target.value); sessionStorage.setItem(draftKey, e.target.value) }} /></label>
          <p className="hub-muted">原话会交给接口人理解后交办、记下或回答。下面的选项可不填；填了就按你的指定登记。</p>
          <div className="hub-actions">
            <label>读写方式<select value={chosenOperation} onChange={e => setOperation(e.target.value)}><option value="">由接口人判断</option><option value="read">只读调查</option><option value="write">写入（需批准）</option></select></label>
            <label>负责人<select value={chosenStaff} onChange={e => setChosenStaff(e.target.value)}><option value="">由接口人选择</option>
              {staff.filter(row => row.executor !== 'remote').map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
            {!!features.length && <label>界面功能<select value={chosenFeature} onChange={e => setChosenFeature(e.target.value)}><option value="">不指定</option>
              {features.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>}
          </div>
          <GoalPicker name="为新事项选择目标" catalog={catalog} ids={goalIds} change={setGoalIds} />
          <button className="hub-primary" disabled={!text.trim() || operation.busy}>提交并查看回执</button>
          <ReadIssue error={operation.error} />
        </form>
      </section>}
    </div>
    <section className="hub-section">
      <h3>回执</h3>
      {id && <button onClick={() => go({ page: 'intake' })}>全部回执与新交办</button>}
      <ReadIssue error={result.error} at={result.readAt} retry={() => void result.refresh()} />
      {result.data?.receipts.length === 0 && <p className="hub-muted">这里会保留交办、备忘和原话。</p>}
      <ul className="hub-list">{result.data?.receipts.map(row => <li key={row.id}>
        <button className="hub-row" onClick={() => go({ page: 'intake', id: row.id })}><span><b>{row.source.text.slice(0, 105)}</b>
          <small>{timeLabel(row.source.receivedAt)} · {row.items.map(item => itemStatus[item.state] ?? item.state).join(' / ')}{row.liaisonReceipts?.length ? ` · 接口人登记 ${row.liaisonReceipts.length} 项` : ''}</small></span></button></li>)}</ul>
      <div className="hub-actions">{cursor && <button onClick={() => setCursor(undefined)}>回到最新</button>}
        {result.data?.nextCursor && <button onClick={() => setCursor(result.data?.nextCursor)}>更早回执</button>}</div>
    </section>
  </div>
}

export function SuperHub({ scope, currentScope, initial, returnLabel, close, style, staff, openRoom, legacyTicket, refreshBoard }: {
  scope: string; currentScope?: string; initial: HubPlace; returnLabel: string; close: () => void; style?: CSSProperties
  staff: { id: string; name: string; executor?: string }[]; openRoom: (id: string) => void; legacyTicket: (id: string) => void; refreshBoard: () => void
}) {
  const [stack, setStack] = useState<HubPlace[]>([initial])
  const place = stack.at(-1)!
  const current = useRef(place)
  current.current = place
  const heading = useRef<HTMLHeadingElement>(null)
  const region = useRef<HTMLDivElement>(null)
  const positions = useRef(new WeakMap<HubPlace, { scroll: number; focus?: HTMLElement }>())
  const live = currentScope === scope
  const pageKey = hubHash(scope, place)
  const catalog = useHubQuery<HubGoals>(scope, live ? scopedPath(scope, 'goals') : undefined, 15_000)
  const checkpoint = () => {
    const focused = document.activeElement
    positions.current.set(place, { scroll: region.current?.scrollTop ?? 0,
      ...(focused instanceof HTMLElement && region.current?.contains(focused) ? { focus: focused } : {}) })
  }
  const go = (next: HubPlace) => {
    if (hubHash(scope, next) === pageKey) return
    checkpoint()
    setStack(rows => [...rows, next])
  }
  const back = () => {
    checkpoint()
    setStack(rows => rows.length > 1 ? rows.slice(0, -1) : [{ page: 'overview' }])
  }
  useLayoutEffect(() => {
    const previous = positions.current.get(place)
    if (region.current) region.current.scrollTop = previous?.scroll ?? 0
    if (previous?.focus?.isConnected) previous.focus.focus({ preventScroll: true })
    else if (place === initial) heading.current?.focus({ preventScroll: true })
    else region.current?.focus({ preventScroll: true })
    history.replaceState(history.state, '', `${location.pathname}${location.search}${pageKey}`)
  }, [pageKey, place, initial])
  const goals = catalog.data?.goals ?? []
  const contentFor = (entry: HubPlace): ReactNode => {
    const active = entry === place
    const navigate: HubNav = next => { if (current.current === entry) go(next) }
    switch (entry.page) {
      case 'overview': return <Overview scope={scope} go={navigate} openRoom={openRoom} refreshBoard={refreshBoard} active={active} />
      case 'intake': return <Intake scope={scope} id={entry.id} catalog={goals} staff={staff} go={navigate} refreshBoard={refreshBoard} active={active} />
      case 'mission': return <Mission scope={scope} place={entry} go={navigate} legacyTicket={legacyTicket} refreshBoard={refreshBoard} active={active} />
      case 'evidence': return <ScopedEvidence scope={scope} ticket={entry.id} id={entry.evidence} active={active} go={navigate} />
      case 'goals': return <GoalMap scope={scope} id={entry.id} version={entry.version} catalog={catalog.data} go={navigate}
        refreshCatalog={() => { void catalog.refresh(); refreshBoard() }} active={active} />
      case 'role': return <RoleHistory scope={scope} id={entry.id} go={navigate} active={active} />
      case 'review': return <SituationReview scope={scope} id={entry.id} initialGoal={entry.goal} goals={goals} go={navigate} openRoom={openRoom} active={active} />
    }
  }
  return <main className="wr hub-shell" aria-label={OVERVIEW_NAME} style={style}>
    <style>{HUB_CSS}</style>
    <header className="hub-head">
      <div className="hub-title-bar">
        <h1 className="wr-headline" tabIndex={-1} ref={heading}>{OVERVIEW_NAME}</h1>
        <button className="hub-exit" type="button" onClick={close}>{returnLabel}</button>
      </div>
      <nav className="hub-tabs" aria-label={`${OVERVIEW_NAME}导航`}>
        {(['overview', 'intake', 'goals', 'review'] as const).map(page => <button key={page} type="button" aria-current={place.page === page ? 'page' : undefined} onClick={() => go({ page })}>{titles[page]}</button>)}
      </nav>
    </header>
    <div className="hub-scroll" tabIndex={-1} ref={region}>
      <div className="hub-content">
        {(stack.length > 1 || place.page === 'mission' || place.page === 'evidence' || !!place.id) && <button className="hub-back" type="button" onClick={back}><span aria-hidden="true">←</span> 返回</button>}
        {live && <ReadIssue error={catalog.error} at={catalog.readAt} retry={() => void catalog.refresh()} />}
        {live ? stack.map((entry, index) => <div hidden={entry !== place} key={`${index}:${hubHash(scope, entry)}`}>{contentFor(entry)}</div>)
          : <div className="hub-section"><p role="alert">此链接属于另一个第二大脑。当前页面的写入已停用。</p><button onClick={close}>返回当前第二大脑</button></div>}
      </div>
    </div>
  </main>
}

const HUB_CSS = `
.hub-shell{
  --hub-card:var(--chief-card,var(--bg));
  --hub-muted:var(--dsw-alias-label-secondary,light-dark(#61666b,#cfd3d6));
  --hub-accent:var(--chief-action);
  --hub-on-accent:var(--chief-on-action);
  --hub-error:light-dark(#8b2e27,#ffb4aa);
  flex-direction:column;min-width:0;min-height:0;overflow:hidden;container:hub-workspace / inline-size;
}
.hub-head{flex:none;border-bottom:1px solid var(--rule)}
.hub-title-bar,.hub-tabs,.hub-content{width:100%;max-width:1180px;margin-inline:auto;padding-inline:28px}
.hub-title-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-block:18px 12px}
.hub-title-bar h1{margin:0}
.hub-shell .hub-exit{color:var(--hub-muted);background:transparent}
.hub-tabs{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:12px}
.hub-shell .hub-tabs button{border-radius:999px;background:transparent;color:var(--hub-muted)}
.hub-shell .hub-tabs button[aria-current=page]{background:color-mix(in srgb,var(--hub-accent) 10%,var(--bg));border-color:transparent;color:var(--hub-accent);font-weight:600}
.hub-shell button.hub-primary{background:var(--hub-accent);border-color:var(--hub-accent);color:var(--hub-on-accent)}
.hub-shell button.hub-primary:hover:not(:disabled){background:color-mix(in srgb,var(--hub-accent) 92%,var(--hub-on-accent))}
.hub-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.hub-content{padding-block:18px calc(36px + env(safe-area-inset-bottom,0px))}
.hub-shell h3{font-size:16px;margin:0 0 12px;color:inherit}
.hub-shell h4{font-size:14px;margin:15px 0 8px}
.hub-shell .hub-columns{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(220px,1fr);gap:18px;align-items:start}
.hub-section{padding:15px;border:1px solid var(--rule);border-radius:var(--r-m);margin-bottom:14px;background:var(--hub-card);min-width:0}
.hub-shell p,.hub-shell blockquote,.hub-shell small{overflow-wrap:anywhere}
.hub-shell p{margin:7px 0 10px}.hub-shell blockquote{margin:9px 0 14px;padding:9px 12px;border-left:2px solid var(--hub-accent);white-space:pre-wrap}
.hub-error{background:color-mix(in srgb,var(--hub-error) 9%,var(--hub-card));color:var(--hub-error);padding:8px 11px;border-radius:7px}
.hub-muted,.hub-shell small{color:var(--hub-muted);font-size:.92em}
.hub-list{list-style:none;padding:0;margin:8px 0 0}
.hub-list>li{padding:5px 0;border-bottom:1px solid var(--hair,#e3e6e7)}
.hub-list>li:last-child{border:0}
.hub-shell .hub-row{display:flex;width:100%;gap:8px;text-align:left;justify-content:space-between;align-items:start;padding:9px 10px;min-width:0;line-height:1.45}
.hub-row>span:first-child{flex:1;min-width:0;white-space:normal;overflow-wrap:anywhere}.hub-row b,.hub-row small{display:block}.hub-row small{margin-top:4px}
.hub-state{font-size:12px;white-space:nowrap;color:var(--hub-accent)}
.hub-actions{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:8px 0}
.hub-section button{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.hub-checkpoint{margin:12px 0}.hub-checkpoint div{border-top:1px solid var(--hair,#e3e6e7);padding:8px 0}
.hub-checkpoint dt{font-weight:600}.hub-checkpoint dd{margin:2px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.hub-shell label{display:flex;flex-direction:column;gap:4px;margin:8px 0;font-size:13px;font-weight:550;min-width:0}
.hub-shell label.hub-check{flex-direction:row;align-items:center;gap:8px;min-height:32px;font-weight:400}
.hub-shell input[type=checkbox]{appearance:auto;flex:0 0 18px;width:18px;height:18px;min-width:18px;max-width:18px;min-height:18px;max-height:18px;margin:0;padding:0;accent-color:var(--hub-accent)}
.hub-shell input:not([type=checkbox]),.hub-shell select,.hub-shell textarea{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--rule);border-radius:var(--r-s);padding:7px 8px;min-width:0;max-width:100%}
.hub-shell :is(input,textarea)::placeholder{color:var(--hub-muted);opacity:1}
.hub-shell .hub-actions input:not([type=checkbox]),.hub-shell .hub-actions select{width:auto;flex:1 1 170px}
.hub-shell textarea{min-height:68px;resize:vertical}.hub-shell summary{cursor:pointer}
.hub-shell button:focus-visible,.hub-shell input:focus-visible,.hub-shell select:focus-visible,.hub-shell textarea:focus-visible,.hub-shell summary:focus-visible{outline:2px solid var(--hub-accent);outline-offset:2px}
.hub-shell :disabled{opacity:.6}
.hub-card{border:1px solid var(--hair);border-radius:var(--r-s);padding:10px 11px;margin:8px 0}
.hub-item-title{display:flex;justify-content:space-between;gap:8px;align-items:start}
.hub-restrictions,.hub-clarify{padding:8px 10px;border-radius:7px;background:var(--board,#f4f6f6)}
.hub-inline-list{margin:7px 0;padding:0;list-style:none}.hub-inline-list li{display:flex;gap:6px;align-items:center;padding:2px 0}
.hub-back{margin:0 0 12px}
.hub-text{max-height:55dvh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--board,#f4f6f6);border-radius:7px;padding:10px}
.hub-shell .hub-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.hub-row b.hub-task-title,.hub-row small.hub-task-summary{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.hub-list-more{margin-top:10px}.hub-role-list .hub-row{border-color:transparent;background:transparent;padding-block:12px}
.hub-disclosure>summary{line-height:1.7}.hub-disclosure>summary>h3{display:inline;margin:0;font-size:15px}
.hub-disclosure>summary>.hub-muted{display:inline-block;margin-left:8px;font-size:12px}
.hub-disclosure[open]>summary{padding-bottom:12px;margin-bottom:8px;border-bottom:1px solid var(--hair)}
.hub-goal-heading .hub-item-title h3{margin-bottom:8px}.hub-goal-heading .hub-state{flex:none}
.hub-shell .hub-goal-owner{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;margin:0}.hub-goal-owner>span{color:var(--hub-muted);font-size:13px}.hub-goal-owner>strong{font-size:16px}
.hub-shell .hub-goal-facts{grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.hub-goal-facts .hub-section{margin-bottom:14px}
.hub-goal-result{font-size:15px}.hub-goal-assessment-note{line-height:1.65}.hub-goal-unmet{border-left:2px solid var(--hub-accent);padding-left:11px;margin:12px 0}.hub-goal-unmet h4{margin:0 0 6px;font-size:13px}.hub-goal-unmet ul{margin:0;padding-left:18px}
.hub-goal-conditions{margin-top:14px;padding-top:10px;border-top:1px solid var(--hair)}.hub-goal-conditions>summary>h3{font-size:13px}.hub-goal-conditions>summary>.hub-muted{display:block;margin:4px 0 0}
.hub-goal-more{margin-top:10px}.hub-goal-more>summary{font-size:12px;color:var(--hub-muted)}.hub-goal-facts small.hub-task-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.hub-mission-result>.hub-item-title>h3{min-width:0;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.hub-mission-result>.hub-item-title>.hub-state{flex:none;padding:3px 9px;background:var(--board);border-radius:6px}
.hub-result-report{max-width:82ch;line-height:1.75}.hub-result-report h4{color:var(--hub-muted);font-size:12px;font-weight:500}
.hub-result-report .md{font-size:14px}.hub-result-report details>summary,.hub-mission-full-title>summary{font-size:12px;color:var(--hub-muted)}
.hub-delivery-list{display:flex;flex-wrap:wrap;gap:10px;list-style:none;padding:0;margin:16px 0 8px}
.hub-delivery-list>li{display:flex;flex-wrap:wrap;align-items:center;gap:7px;min-width:0}
.hub-delivery-list button{min-height:40px;text-align:left;line-height:1.5;padding-block:6px}
.hub-action-more>summary{font-size:12px;color:var(--hub-muted);padding-block:5px}
.hub-action-more[open]{margin-top:9px;padding-top:8px;border-top:1px solid var(--hair)}
.hub-timeline-filters{border:1px solid var(--hair);padding:9px 11px;border-radius:7px;margin:12px 0}
.hub-timeline-filters>summary,.hub-instance-source>summary{color:var(--hub-muted);font-size:12px}
.hub-instance-context{padding:11px 12px;background:var(--board);border-radius:7px;margin:12px 0}
.hub-instance-source{margin-top:12px}.hub-timeline h3{scroll-margin-top:15px}
.hub-evidence-reader{padding:24px;max-width:900px;margin-inline:auto}
.hub-evidence-document{margin-block:24px 30px;min-width:0;max-width:78ch}
.hub-evidence-document .md{font-size:15px;line-height:1.85}
.hub-evidence-details{border-top:1px solid var(--hair);padding-top:14px;margin-top:18px}
.hub-evidence-details>summary{font-size:12px;color:var(--hub-muted)}
.hub-evidence-empty{padding:16px;background:var(--board);border-radius:8px;line-height:1.7;margin:20px 0}
.hub-review-intro{display:flex;align-items:start;justify-content:space-between;gap:16px;margin:4px 0 18px}
.hub-review-intro h2{font-size:21px;line-height:1.35;margin:0 0 6px;letter-spacing:-.3px}
.hub-review-intro p{margin:0;line-height:1.6}.hub-review-intro>button{flex:none}
.hub-review-steps{display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:8px;margin-bottom:20px;padding-block:8px;position:sticky;top:0;z-index:1;background:var(--bg)}
.hub-shell .hub-review-steps button{display:flex;align-items:center;gap:8px;min-height:38px;min-width:0;line-height:1.5;border-color:transparent;background:var(--board);padding-inline:12px}
.hub-review-steps button span{flex:none}
.hub-review-steps button span{color:var(--hub-accent);font-size:11px;font-weight:650;font-variant-numeric:tabular-nums}
.hub-review .hub-section{padding:20px;border-radius:12px;margin-bottom:18px}
.hub-review h3[tabindex]{scroll-margin-top:20px}
.hub-review-scope .hub-item-title{align-items:center}
.hub-review-scope .hub-item-title h3{margin-bottom:0}
.hub-review-focus{display:flex;align-items:end;gap:10px;margin-top:12px}
.hub-review-focus>label{flex:1;margin:0}.hub-review-focus>button{flex:none;min-height:36px}
.hub-review .hub-review-goals{display:flex;gap:7px;flex-wrap:wrap;margin-block:12px}
.hub-review-goals li{max-width:100%;background:var(--board);border-radius:7px;padding:3px}
.hub-review-goals li>button:first-child{min-width:0;border-color:transparent;background:transparent;text-align:left;color:var(--hub-accent)}
.hub-review-goals li>button:last-child{flex:none;border-color:transparent;background:transparent;color:var(--hub-muted);padding-inline:8px}
.hub-review-window{border-top:1px solid var(--hair);margin-top:16px;padding-top:12px}
.hub-review-window>summary{font-size:12px;line-height:1.9}.hub-review-window>summary>span{display:inline-block;margin-left:8px;color:var(--hub-muted)}
.hub-review-window>summary>.hub-review-adjust{color:var(--hub-accent)}
.hub-review-scope .hub-grid{padding-top:8px;gap:2px 14px}
.hub-review-scope .hub-grid>.hub-actions{grid-column:1 / -1;margin-top:2px}
.hub-shell .hub-review-columns{grid-template-columns:minmax(0,1.15fr) minmax(310px,1fr);gap:20px}
.hub-review-count{float:right;font-size:12px;color:var(--hub-muted);background:var(--board);border-radius:6px;padding:3px 8px;margin-left:8px}
.hub-review-ticket{margin-top:18px;padding-top:18px;border-top:1px solid var(--hair);min-width:0}
.hub-review-ticket-meta{display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--hub-muted);font-size:12px;margin-bottom:7px}
.hub-shell button.hub-review-link{display:block;min-width:0;min-height:28px;padding:2px 0;border:0;border-radius:3px;background:transparent;text-align:left;color:var(--hub-accent);line-height:1.55;white-space:normal;overflow-wrap:anywhere}
.hub-shell button.hub-review-link:hover:not(:disabled){background:transparent;text-decoration:underline;text-underline-offset:3px}
.hub-shell button.hub-review-ticket-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--paper);font-size:14px;font-weight:600}
.hub-review-summary{margin:6px 0}.hub-review-summary>summary{font-size:12px;color:var(--hub-muted);padding-block:5px}
.hub-review-ticket-footer{display:flex;align-items:center;flex-wrap:wrap;gap:2px 14px;margin:6px 0}
.hub-review-ticket-footer>.hub-check{margin:0}
.hub-review-evidence{list-style:none;padding:0;margin:10px 0}
.hub-review-evidence>li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;align-items:center;padding:12px 10px;border-top:1px solid var(--hair);min-width:0}
.hub-review-evidence>li:first-child{border-top:0}.hub-review-evidence>li.is-selected{background:color-mix(in srgb,var(--hub-accent) 5%,var(--hub-card));border-radius:7px}
.hub-review-evidence-main{min-width:0}.hub-review-evidence-meta{display:flex;flex-wrap:wrap;gap:3px 10px;color:var(--hub-muted);font-size:11px;line-height:1.7;overflow-wrap:anywhere}
.hub-shell label.hub-review-keep{margin:0;white-space:nowrap;min-height:36px;gap:7px;font-size:12px;cursor:pointer;align-self:center}
.hub-review-observations{margin-top:12px;border:1px solid var(--hair);border-radius:8px;background:var(--board)}
.hub-review-observations>summary{padding:11px 12px;font-size:12px;font-weight:550;line-height:1.7}
.hub-review-observations>summary>span{margin-left:5px;color:var(--hub-muted);font-weight:400}
.hub-review-observations[open]>summary{border-bottom:1px solid var(--hair)}
.hub-review-observations>.hub-review-evidence{margin:0;padding:0 6px;background:var(--hub-card);border-radius:0 0 8px 8px}
.hub-review-no-delivery{font-size:12px;margin-block:10px}
.hub-review-action>h3{margin-bottom:6px}.hub-review-selection{font-size:12px;color:var(--hub-muted);padding:9px 11px;border-radius:7px;background:var(--board)}
.hub-review-fieldset{border:0;padding:0;margin:24px 0 0;min-width:0}
.hub-review-fieldset>legend{display:block;width:100%;padding:0 0 10px;border-bottom:1px solid var(--hair);font-size:13px;font-weight:650}
.hub-review-fieldset label{margin:14px 0;font-size:12px;font-weight:500;gap:7px;line-height:1.5}
.hub-review-fieldset textarea{font-size:13px;line-height:1.65;padding:9px 10px}
.hub-review-required>label,.hub-review-optional>label{margin:16px 0;line-height:1.5}.hub-review-required textarea{min-height:62px;line-height:1.6}
.hub-review-optional{border-top:1px solid var(--hair);margin-top:18px;padding-top:12px}.hub-review-optional>summary{color:var(--hub-muted);font-size:13px}
.hub-review-legacy{border:1px solid var(--rule);border-radius:8px;padding:10px 12px;margin-top:16px}.hub-review-legacy>h4{margin-top:0}
.hub-review-submit{margin-top:20px;padding-top:14px;border-top:1px solid var(--hair)}
.hub-review-submit>button{min-height:38px}
.hub-review-continue{display:flex;justify-content:flex-end;margin:4px 0 18px}.hub-review-continue>button{min-height:42px}
@container hub-workspace (max-width:980px){
  .hub-shell .hub-review-columns{grid-template-columns:minmax(0,1fr)}
}
@container hub-workspace (max-width:700px){
  .hub-title-bar,.hub-tabs,.hub-content{padding-inline:14px}
  .hub-title-bar{padding-block:12px 8px}.hub-title-bar h1{font-size:19px}
  .hub-tabs{padding-bottom:8px;gap:4px}.hub-tabs button{font-size:12px;min-height:36px;padding-inline:8px}
  .hub-content{padding-top:12px}.hub-shell .hub-columns,.hub-shell .hub-grid{grid-template-columns:minmax(0,1fr)}
  .hub-section{padding:12px}.hub-shell button{min-height:34px}.hub-text{max-height:70dvh}
  .hub-evidence-reader{padding:16px}.hub-evidence-document{margin-block:18px 22px}
  .hub-review .hub-section{padding:16px}.hub-review-intro h2{font-size:19px}
  .hub-review-intro{gap:10px;margin-bottom:14px}.hub-review-intro p{font-size:12px}
  .hub-review-steps{gap:6px;margin-bottom:16px}.hub-shell .hub-review-steps button{font-size:12px;padding-inline:9px;gap:5px}
  .hub-review-evidence>li{gap:6px 12px;padding:10px 6px}
  .hub-review-scope .hub-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@container hub-workspace (max-width:460px){
  .hub-review .hub-section{padding:14px}.hub-review-focus{flex-wrap:wrap;align-items:start}
  .hub-review-focus>label{flex-basis:100%}.hub-review-focus>button{width:100%}
  .hub-review-evidence>li{grid-template-columns:minmax(0,1fr)}
  .hub-shell label.hub-review-keep{justify-self:start;min-height:40px}
  .hub-review-evidence-meta{font-size:12px}.hub-review-scope .hub-grid{grid-template-columns:minmax(0,1fr)}
  .hub-review .hub-item-title{flex-wrap:wrap}.hub-review-submit>button:first-child{width:100%}
}
@media(max-width:700px){
  .hub-shell input:not([type=checkbox]),.hub-shell select,.hub-shell textarea{font-size:16px}
}
`
