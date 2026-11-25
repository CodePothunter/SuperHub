import { threadBoundaryOf, threadIdOf, type AcceptanceCriterionInput, type DeliveryVersion, type Ticket } from '../core/model.ts'
import { currentGoal, type GoalReference } from '../core/superhub-goals.ts'
import type { Engine } from '../core/engine.ts'
import { latestAssignment } from '../core/stage.ts'
import type { BrainRepo } from './brain.ts'
import { deliveryDocument, documentView } from './discussions.ts'
import { json, type ApiCall, type Route } from './http.ts'
import type { NativeRooms } from './rooms.ts'
import { workspaceError, type SuperhubGoals } from './superhub-goals.ts'
import { timestamp, uniqueIds, type SuperhubSaa } from './superhub-saa.ts'
import type { createSuperhubTrace } from './superhub-trace.ts'
import type { SuperhubIntake } from './superhub.ts'
import type { PendingCommand } from './approvals.ts'
import { commandDecisions } from './view.ts'

type Trace = ReturnType<typeof createSuperhubTrace>
type View = ReturnType<Engine['views']>[number]
interface WorkspaceDeps {
  scope: string
  engine: Engine
  brain: BrainRepo
  rooms: NativeRooms
  superhub: SuperhubIntake
  trace: Trace
  goals: SuperhubGoals
  saa: SuperhubSaa
  /** 待审批的执行器命令；总览只在电脑上的 DSH 里给主人本人列出（同 /settings/approvals）。 */
  commands?: () => readonly PendingCommand[]
}

const ticketKey = /^T-\d{1,14}$/
const goalKey = /^G-[a-f0-9-]{36}$/
const shortId = /^[^\u0000-\u001f\u007f]{1,260}$/
const referenceKey = ({ ticketId, evidenceId }: GoalReference) => JSON.stringify([ticketId, evidenceId])
const strings = (params: URLSearchParams, key: string) => params.get(key) || undefined
const FOCUS_LIMIT = 3
const ticketInfo = ({ ticket, stage }: View, ownerNames?: ReadonlyMap<string, string>) => ({
  id: ticket.id, title: ticket.title, stage, threadId: threadIdOf(ticket), staff: ticket.staff, roleName: ownerNames?.get(ticket.staff),
  executor: latestAssignment(ticket)?.executor ?? ticket.requestedExecutor,
  outcome: ticket.ended?.outcome, endedAt: ticket.ended?.at, createdAt: ticket.createdAt, scoped: !!ticket.superhub,
  note: ticket.ended?.note, summary: latestAssignment(ticket)?.report?.summary?.slice(0, 500),
  question: latestAssignment(ticket)?.report?.question?.slice(0, 500), waitingFor: ticket.waitingFor ?? [],
})
export type WorkspaceTicket = ReturnType<typeof ticketInfo>
const newest = (ticket: Ticket) => {
  const last = latestAssignment(ticket)
  return [ticket.ended?.at, last?.verifiedAt, last?.endedAt, last?.startedAt, ticket.inputs.at(-1)?.at, ticket.createdAt]
    .filter((value): value is string => !!value).sort().at(-1)!
}

function asInteger(raw: unknown, min: number, max: number, fallback?: number): number {
  const value = raw === undefined ? fallback : typeof raw === 'number' || typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined
  if (value === undefined || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('数字参数超出范围')
  return value
}

function note(raw: unknown, label: string, max: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) throw new Error(`请填写${label}（最多 ${max} 字）`)
  return raw.trim()
}

function evidenceId(raw: unknown): string {
  if (typeof raw !== 'string' || !shortId.test(raw)) throw new Error('证据标识无效')
  return raw
}

function missionQuery(params: URLSearchParams) {
  const limit = strings(params, 'limit'), round = strings(params, 'round')
  return {
    cursor: strings(params, 'cursor'), limit: asInteger(limit, 1, 100, 40),
    at: params.has('at') ? timestamp(params.get('at'), '回放时间') : undefined,
    from: params.has('from') ? timestamp(params.get('from'), '开始时间') : undefined,
    to: params.has('to') ? timestamp(params.get('to'), '结束时间') : undefined,
    instance: strings(params, 'instance'), role: strings(params, 'role'), round: round === undefined ? undefined : asInteger(round, 0, 100_000),
    event: strings(params, 'event'),
    type: strings(params, 'type'), status: strings(params, 'status'), criterion: strings(params, 'criterion'),
    q: strings(params, 'q')?.slice(0, 200),
  }
}

async function ownerAction(call: ApiCall, view: View, engine: Engine, brain: BrainRepo, scope: string) {
  const { ticket, stage } = view, { body } = call
  if (!ticket.superhub || ticket.superhub.brainScope !== scope) workspaceError(409, '此工单使用原执行记录，请在原工单中处理')
  if (body.at !== undefined) workspaceError(409, '请切回当前工单及有效版本后再操作')
  if (typeof body.threadId !== 'string' || !(body.assignmentId === null || typeof body.assignmentId === 'string') || typeof body.stage !== 'string') throw new Error('请先打开并核对当前工单')
  const target = { brainScope: scope, threadId: body.threadId, replyTo: body.assignmentId, stage: body.stage,
    contractVersion: asInteger(body.contractVersion, 1, 100_000) }
  const id = ticket.id
  switch (body.action) {
    case 'approve': {
      const boundary = threadBoundaryOf(ticket, brain.staff().find(staff => staff.id === ticket.staff)?.executor)
      if (body.executionBoundary !== boundary || boundary === 'remote' && body.allowRemote !== true) workspaceError(409, '请核对并授权实际的执行位置')
      return engine.approve(id, target)
    }
    case 'accept': return engine.accept(id, false, target)
    case 'acceptDeviation': return engine.accept(id, false, { ...target, deviationReason: note(body.reason, '偏差及接受理由', 2000) })
    case 'stop': return engine.stopTicket(id, note(body.reason, '停止理由', 2000), target)
    case 'retry': return engine.retry(id, target)
    case 'reply':
    case 'requestEvidence': {
      const text = note(body.text, '发往当前工单的说明', 8000)
      const boundary = threadBoundaryOf(ticket, brain.staff().find(staff => staff.id === ticket.staff)?.executor)
      if (body.executionBoundary !== boundary || boundary === 'remote' && body.allowRemote !== true) workspaceError(409, '请核对并授权实际的执行位置')
      return engine.reply(id, text, { ...target, ticketId: id, requestId: note(body.requestId, '请求标识', 100),
        executionBoundary: boundary, allowRemote: body.allowRemote === true })
    }
    case 'reviseContract':
      if (!Array.isArray(body.criteria) || !body.criteria.length || body.criteria.length > 20) throw new Error('请提供 1 到 20 项验收标准')
      return engine.reviseContract(id, body.criteria as AcceptanceCriterionInput[], note(body.reason, '契约变更理由', 2000), target)
    default: throw new Error(`当前不能处理这项操作（${stage}）`)
  }
}

export function superhubWorkspaceRoutes({ scope, engine, brain, rooms, superhub, trace, goals, saa, commands }: WorkspaceDeps): Route {
  const assertScope = (value: unknown) => {
    if (value !== scope) workspaceError(409, '第二大脑已切换或链接缺少作用域，请回到原处核对')
  }
  const findTicket = (id: string) => {
    const view = ticketKey.test(id) ? engine.ticketView(id) : undefined
    if (!view || view.ticket.superhub && view.ticket.superhub.brainScope !== scope) workspaceError(404, '当前第二大脑没有这张工单')
    return view
  }
  const scopedViews = () => engine.views().filter(({ ticket }) => !ticket.superhub || ticket.superhub.brainScope === scope)
  const linksFor = (goal: string) => {
    const entries = superhub.receiptsForGoal(goal).flatMap(receipt => receipt.items.filter(item => item.goalIds.includes(goal)).map(item => ({ receipt, item })))
    return {
      items: entries.map(({ receipt, item }) => ({ receiptId: receipt.id, itemId: item.id, title: item.title, state: item.state,
        ticketId: item.ticketId, primary: item.goalIds[0] === goal, disputed: item.goalDisposition === 'disputed' })),
      tickets: new Set(entries.flatMap(({ item }) => item.goalDisposition !== 'disputed' ? [...item.priorTicketIds ?? [], ...item.ticketId ? [item.ticketId] : []] : [])),
    }
  }
  const getDelivery = async (ref: GoalReference): Promise<DeliveryVersion | undefined> => {
    const evidence = await trace.evidence(ref.ticketId, evidenceId(ref.evidenceId))
    if (evidence?.kind === 'delivery' && !evidence.historical && evidence.availability === 'available' && evidence.path && evidence.version) return { path: evidence.path, version: evidence.version }
  }
  const goalDetail = async (id: string, views = scopedViews()) => {
    const goal = goals.get(id)
    if (!goal) workspaceError(404, '当前第二大脑没有这项目标')
    const { items, tickets } = linksFor(id)
    const version = currentGoal(goal)
    const pending = version.criteria.filter(criterion => criterion.required)
    const findings = version.assessment?.findings ?? []
    const references = new Map(findings.flatMap(finding => finding.evidence.map(ref => [referenceKey(ref), ref] as const)))
    const invalid = new Map<string, string>()
    await Promise.all([...references].map(async ([key, ref]) => {
      if (!tickets.has(ref.ticketId)) { invalid.set(key, '工单的当前目标关联待复核'); return }
      const delivery = await getDelivery(ref)
      if (!delivery) invalid.set(key, '该证据已由后续派工替代，或当前版本不可读')
      else if (brain.deliveryEvidence(ref.ticketId, delivery) === undefined) invalid.set(key, '产物当前版本已变化')
    }))
    const linkedWork = views.filter(view => tickets.has(view.ticket.id))
    const hasNewEvidence = linkedWork.some(({ ticket }) => {
      const assigned = latestAssignment(ticket)
      return !!assigned?.verifiedAt && assigned.verification?.verdict === 'pass' && assigned.verifiedAt > (version.assessment?.at ?? '')
    })
    return { scope, goal, items, tasks: linkedWork.map(view => ticketInfo(view)),
      knownConditions: pending.filter(criterion => findings.some(finding => finding.criterionId === criterion.id && finding.status === 'met'
        && finding.evidence.length && finding.evidence.every(ref => !invalid.has(referenceKey(ref))))).length,
      requiredConditions: pending.length, hasNewEvidence,
      invalidEvidence: [...references].flatMap(([key, ref]) => invalid.has(key) ? [{ ...ref, reason: invalid.get(key)! }] : []),
    }
  }

  function windowContext(params: { from?: unknown; to?: unknown; goalIds: unknown }, now = new Date().toISOString()) {
    const latest = saa.latest()
    const to = params.to === undefined ? now : timestamp(params.to, '局势校准终点')
    const from = params.from === undefined ? (latest && latest.to < to ? latest.to : new Date(Date.parse(to) - 2 * 3600_000).toISOString()) : timestamp(params.from, '局势校准起点')
    if (from >= to || to > now || Date.parse(to) - Date.parse(from) > 31 * 86400_000) throw new Error('请选择已发生的工作段（最多 31 天）')
    const goalIds = uniqueIds(params.goalIds, FOCUS_LIMIT, goalKey, '关注目标')
    const effectiveGoals = new Map(goals.list().map(goal => [goal.id, currentGoal(goal)]))
    const focus = goalIds.map(id => {
      const goal = effectiveGoals.get(id)
      if (!goal) workspaceError(404, '当前第二大脑没有这项目标')
      return { id, version: goal.version, name: goal.name }
    })
    const blockers = focus.flatMap(row => effectiveGoals.get(row.id)!.relations
      .filter(rel => rel.kind === 'requires' && effectiveGoals.get(rel.target)?.status !== 'achieved')
      .map(rel => ({ goalId: row.id, target: rel.target, name: effectiveGoals.get(rel.target)?.name ?? rel.target,
        status: effectiveGoals.get(rel.target)?.status ?? 'unknown' })))
    const tickets = new Set(goalIds.flatMap(id => [...linksFor(id).tickets]))
    const views = scopedViews().filter(({ ticket }) => !goalIds.length || tickets.has(ticket.id) || !!ticket.parent && tickets.has(ticket.parent.ticketId))
    const attention = views.filter(view => !view.ticket.ended && (view.stage.startsWith('you/') || view.ticket.waitingFor?.length))
      .sort((a, b) => b.attention - a.attention).map(view => ticketInfo(view))
    const newlyObserved = new Set(trace.recentlyObservedTicketIds(from, to))
    const changed = views.filter(view => view.ticket.createdAt <= to && (!view.ticket.ended || newest(view.ticket) >= from || newlyObserved.has(view.ticket.id)))
      .sort((a, b) => Number(newlyObserved.has(b.ticket.id)) - Number(newlyObserved.has(a.ticket.id)) || newest(b.ticket).localeCompare(newest(a.ticket)))
    return { from, to, latest, focus, attention, changed, blockers }
  }

  return async (call, res) => {
    const [group, feature, id, subId] = call.seg
    if (group !== 'superhub' || !['overview', 'roles', 'mission', 'evidence', 'goals', 'review'].includes(feature ?? '')) return false
    if (call.via === 'dsh' && !call.owner) workspaceError(403, '此操作需要 DSH 主人权限')
    const { body, method, url } = call
    const p = url.searchParams
    assertScope(method === 'GET' ? p.get('scope') : body.scope)
    const send = (data: unknown) => { json(res, 200, data); return true }

    if (feature === 'roles' && method === 'GET' && id && !subId) {
      const role = trace.roleActivity(id, { cursor: strings(p, 'cursor'), limit: asInteger(strings(p, 'limit'), 1, 100, 20) })
      if (!role) workspaceError(404, '当前第二大脑没有这个角色')
      return send(role)
    }

    if (feature === 'overview' && method === 'POST' && id && !subId && body.action === 'retriage') {
      if (!engine.stuckEvents().some(row => row.event.id === id)) workspaceError(404, '当前第二大脑没有这项研判待办')
      await engine.retriage(id)
      return send({ scope, ok: true })
    }
    if (feature === 'overview' && method === 'GET' && !id) {
      const offset = asInteger(strings(p, 'offset'), 0, 1_000_000, 0)
      const query = strings(p, 'q')?.trim().toLowerCase()
      const names = new Map(brain.staff().map(staff => [staff.id, staff.name]))
      const views = scopedViews()
      const found = views.filter(view => !query || `${view.ticket.id} ${view.ticket.title}`.toLowerCase().includes(query))
        .sort((a, b) => newest(b.ticket).localeCompare(newest(a.ticket)) || b.ticket.id.localeCompare(a.ticket.id))
      return send({ scope, asOf: new Date().toISOString(), total: found.length, nextOffset: offset + 40 < found.length ? offset + 40 : undefined,
        tickets: found.slice(offset, offset + 40).map(view => ticketInfo(view, names)),
        decisions: views.filter(view => view.stage.startsWith('you/')).sort((a, b) => b.attention - a.attention).slice(0, 40).map(view => ticketInfo(view, names)),
        roomActions: rooms.ownerActions().filter(action => !action.answered && !action.ticketId),
        ...call.owner && call.via === 'dsh' && commands ? { commands: commandDecisions(commands(), ticketId => views.some(view => view.ticket.id === ticketId)) } : {},
        stuck: engine.stuckEvents().slice(0, 40).map(row => ({ id: row.event.id, text: row.event.text, reason: row.reason, at: row.event.at })),
        roles: trace.roles().map(role => ({ id: role.id, name: role.name, status: role.status, defaultExecutor: role.defaultExecutor, kinds: role.kinds,
          instances: role.instances.slice(0, 8), instanceCount: role.instanceCount })),
      })
    }

    if (feature === 'mission' && id && !subId) {
      const view = findTicket(id)
      if (method === 'POST') {
        await ownerAction(call, view, engine, brain, scope)
        return send({ scope, ok: true })
      }
      const query = missionQuery(p)
      const mission = await trace.mission(id, query)
      if (!mission) workspaceError(404, '当前第二大脑没有这张工单')
      const { ticket, stage } = findTicket(id), last = latestAssignment(ticket)
      const contract = ticket.superhub?.contracts.at(-1)
      const matching = mission.mode === 'live' && mission.ticket.stage === stage && last?.id === mission.assignmentId
        && contract?.version === mission.contract?.version && last?.verifiedAt === mission.verification?.at
      const checked = ticket.assignments.find(assignment => assignment.id === mission.assignmentId)
      const outputsChanged = !query.at && !!checked?.verification?.criteria?.some(row => row.evidence.some(ref => ref.kind === 'delivery' && brain.deliveryEvidence(id, ref) === undefined))
      return send({ ...mission, sourceReceiptId: ticket.superhub ? superhub.receiptIdForSource(ticket.superhub.sourceId) : undefined,
      currentTarget: matching ? {
        threadId: threadIdOf(ticket), assignmentId: last?.id ?? null, stage, contractVersion: contract?.version,
        executionBoundary: threadBoundaryOf(ticket, brain.staff().find(staff => staff.id === ticket.staff)?.executor),
      } : undefined, contractHistory: mission.contracts,
      verificationDetail: checked?.verifiedAt === mission.verification?.at && mission.verification ? checked?.verification : undefined,
      report: checked?.endedAt && checked.endedAt <= mission.timeline.asOf ? checked?.report : undefined,
      outputsChanged: query.at ? undefined : outputsChanged,
      ownerAcceptance: ticket.superhub?.ownerAcceptance && (!query.at || ticket.superhub.ownerAcceptance.at <= query.at) ? ticket.superhub.ownerAcceptance : undefined })
    }

    if (feature === 'evidence' && id && subId && method === 'GET') {
      findTicket(id)
      const evidence = await trace.evidence(id, evidenceId(subId))
      if (!evidence) workspaceError(404, '找不到已登记的证据')
      if (evidence.kind === 'delivery' && evidence.path && evidence.version && evidence.availability === 'available') {
        const doc = deliveryDocument(engine, brain, evidence.ticketId, evidence.path, evidence.version)
        if (doc.version !== evidence.version) workspaceError(409, '证据版本已变更')
        return send({ scope, evidence, document: documentView(doc), content: doc.content })
      }
      return send({ scope, evidence })
    }

    if (feature === 'goals' && !subId) {
      if (method === 'GET') {
        if (id) return send(await goalDetail(id))
        return send({ scope, asOf: new Date().toISOString(), goals: goals.list().map(goal => {
          const version = currentGoal(goal)
          return { id: goal.id, version: version.version, name: version.name, owner: version.owner, parent: version.parent,
            status: version.status, type: version.type, horizon: version.horizon, relations: version.relations }
        }), candidates: goals.candidates() })
      }
      // Each finding must cite a current, registered result from the goal's linked work.
      const visible = id ? linksFor(id).tickets : new Set<string>()
      const candidates = new Map<string, DeliveryVersion>()
      const assessment = body.assessment as { findings?: { evidence?: GoalReference[] }[] } | undefined
      if (Array.isArray(assessment?.findings) && assessment.findings.length <= 40) {
        const refs = assessment.findings.flatMap(row => Array.isArray(row?.evidence) && row.evidence.length <= 40 ? row.evidence : []).slice(0, 100)
        for (const ref of refs) {
          if (!ref || typeof ref.evidenceId !== 'string' || !visible.has(ref.ticketId)) continue
          const delivery = await getDelivery(ref)
          if (delivery) candidates.set(referenceKey(ref), delivery)
        }
      }
      const currentLinks = id ? linksFor(id).tickets : new Set<string>()
      const change = goals.change(id, body, ref => {
        const delivery = candidates.get(referenceKey(ref))
        return !!delivery && currentLinks.has(ref.ticketId) && brain.deliveryEvidence(ref.ticketId, delivery) !== undefined
      })
      const impact = linksFor(change.goal.id)
      return send({ scope, ...change, impact: { tickets: [...impact.tickets], items: impact.items.length } })
    }

    if (feature === 'review' && !subId) {
      if (method === 'GET' && id === 'history') return send({ scope, records: saa.list() })
      if (method === 'GET' && id) {
        const record = saa.get(id)
        if (!record) workspaceError(404, '找不到本脑的复工记录')
        return send({ scope, record })
      }
      if (method === 'GET') {
        const input = { from: strings(p, 'from'), to: strings(p, 'to'), goalIds: p.getAll('goal') }
        const context = windowContext(input)
        const recent = context.changed.slice(0, 32)
        const evidence = (await Promise.all(recent.map(async view => {
          const mission = await trace.mission(view.ticket.id, { from: context.from, to: context.to, limit: 20, windowTime: 'either' })
          return { ticket: ticketInfo(view), evidence: mission?.evidence.filter(ref => [ref.at, ref.observedAt]
            .some(at => at && at >= context.from && at <= context.to)).slice(0, 20) ?? [],
            coverage: mission?.coverage.state, observed: mission?.timeline.matched ?? 0,
            late: mission?.timeline.items.filter(row => row.at && row.at < context.from && row.observedAt && row.observedAt >= context.from && row.observedAt <= context.to)
              .map(({ id, title, ticketId, at, observedAt }) => ({ id, title, ticketId, at, observedAt })) ?? [],
          }
        }))).filter(entry => entry.observed || entry.evidence.length)
        return send({ scope, from: context.from, to: context.to, latest: context.latest, focus: context.focus,
          attention: context.attention, evidence, sampled: recent.length, candidates: context.changed.length,
          roomActions: rooms.ownerActions().filter(action => !action.answered && !action.ticketId),
          blockers: context.blockers })
      }
      if (!id) {
        const replay = saa.existing(body)
        if (replay) return send({ scope, record: replay })
        const context = windowContext({ from: body.from, to: body.to, goalIds: body.goalIds })
        const revisions = body.goalVersions
        if (!Array.isArray(revisions) || revisions.length !== context.focus.length || context.focus.some(row => !revisions.some(pair => pair?.id === row.id && pair.version === row.version))) workspaceError(409, '主线目标已更新，请重新读取工作段')
        const tickets = uniqueIds(body.tickets ?? [], 30, ticketKey, '复盘工单')
        const visible = new Set([...context.attention.map(row => row.id), ...context.changed.map(row => row.ticket.id)])
        if (tickets.some(ticket => !visible.has(ticket))) workspaceError(409, '复盘工单已离开当前工作段，请重新核对')
        if (!Array.isArray(body.references) || body.references.length > 30) throw new Error('复盘证据最多 30 条')
        const references: GoalReference[] = []
        for (const ref of body.references) {
          if (!ref || !tickets.includes(ref.ticketId)) throw new Error('复工记录只能引用已选工单的证据')
          const found = await trace.evidence(ref.ticketId, evidenceId(ref.evidenceId))
          if (!found || ![found.at, found.observedAt].some(at => at && at >= context.from && at <= context.to)) workspaceError(409, '复盘证据已更新，请重选当前工作段的证据')
          references.push({ ticketId: ref.ticketId, evidenceId: found.id })
        }
        const rechecked = windowContext({ from: context.from, to: context.to, goalIds: body.goalIds })
        if (rechecked.focus.some((item, index) => item.version !== context.focus[index]?.version)) workspaceError(409, '主线目标已更新，请重新读取工作段')
        const currentTickets = new Set([...rechecked.attention.map(row => row.id), ...rechecked.changed.map(row => row.ticket.id)])
        if (tickets.some(ticket => !currentTickets.has(ticket))) workspaceError(409, '复盘工单已离开当前工作段，请重新核对')
        if (new Set(references.map(referenceKey)).size !== references.length) throw new Error('复盘证据不能重复')
        const record = saa.save(body, { tickets, references, goals: context.focus.map(({ id, version }) => ({ id, version })) })
        return send({ scope, record })
      }
    }
    return false
  }
}
