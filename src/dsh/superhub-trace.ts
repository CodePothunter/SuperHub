import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Engine, TicketView } from '../core/engine.ts'
import { threadIdOf, type AcceptanceContract, type Assignment, type ChiefEvent, type ExecutionRef, type Staff, type Ticket } from '../core/model.ts'
import { columnOf, latestAssignment, stageOf, type Stage } from '../core/stage.ts'
import type { HostContext } from './ports.ts'
import { archivedOutput } from './deliveries.ts'
import { ASSIGNMENT_ID } from './remote.ts'
import { nativeCandidate, SuperhubNative, type NativeFact } from './superhub-native.ts'

export type SuperhubCoverageState = 'complete' | 'partial' | 'collecting' | 'not-started' | 'unsupported'
  | 'unconfirmed' | 'unreadable' | 'cached' | 'redacted' | 'unavailable' | 'expired' | 'forbidden'

type Dimension = { state: SuperhubCoverageState; reason?: string; count?: number; lastObservedAt?: string }
export interface SuperhubWaiting { kind: string; target: string; label: string; until: string; since?: string; eventIds: string[] }

export interface SuperhubEvent {
  id: string
  ticketId: string
  type: string
  title: string
  source: 'business' | 'native'
  sourceId?: string
  at?: string
  observedAt?: string
  roleId?: string
  instanceId?: string
  assignmentId?: string
  round?: number
  contractVersion?: number
  state?: string
  causes: string[]
  evidenceIds: string[]
  criterionIds?: string[]
  handoff?: { sent: 'confirmed' | 'unknown'; delivered: 'confirmed' | 'unknown'; processed: 'confirmed' | 'unknown' }
  native?: {
    sessionId: string; seq: number; channel: 'live' | 'history'; turn?: number; step?: number; tool?: string
    status?: string; durationMs?: number; sourceKind?: string; ownerAttribution?: 'unconfirmed'; inserted?: number
    pairing?: 'confirmed' | 'unconfirmed'; redacted: boolean
  }
}

export interface SuperhubEvidence {
  id: string
  kind: 'delivery' | 'native' | 'receipt'
  ticketId: string
  assignmentId?: string
  at?: string
  observedAt?: string
  roleId?: string
  title: string
  criterionIds: string[]
  availability: 'available' | 'redacted' | 'unavailable' | 'unreadable' | 'unconfirmed' | 'expired' | 'forbidden'
  path?: string
  version?: string
  method?: string
  eventId?: string
  historical?: boolean
}

export interface SuperhubInstance {
  id: string
  ticketId: string
  assignmentId: string
  round: number
  attempt: number
  roleId: string
  kind: 'execute' | 'verify'
  status: string
  historical: boolean
  startedAt?: string
  endedAt?: string
  configuredExecutor?: string
  configuredModel?: string
  configurationId?: string
  actualProvider?: string
  activationId?: string
  sessionId?: string
  model?: string
  contractVersion?: number
  lastEventId?: string
  verdict?: string
  termination?: 'confirmed' | 'unconfirmed'
  waiting?: SuperhubWaiting[]
  coverage: {
    session: SuperhubCoverageState
    tools: SuperhubCoverageState
    state: SuperhubCoverageState
    reason?: string
    lastObservedAt?: string
    lastReadAt?: string
    sourceSequence?: number
    baseline?: string
  }
}

export interface SuperhubRole {
  id: string
  name: string
  kinds: string[]
  status: 'active' | 'historical' | 'not-started' | 'unconfirmed'
  defaultExecutor?: string
  instanceCount: number
  instances: SuperhubInstance[]
}

export interface SuperhubRoleActivity {
  scope: string
  role: Omit<SuperhubRole, 'instances'>
  items: SuperhubInstance[]
  total: number
  asOf: string
  nextCursor?: string
}

export interface SuperhubTraceQuery {
  cursor?: string
  limit?: number
  at?: string
  event?: string
  instance?: string
  role?: string
  round?: number
  type?: string
  status?: string
  criterion?: string
  from?: string
  to?: string
  windowTime?: 'either'
  q?: string
}

export interface SuperhubMission {
  scope: string
  mode: 'live' | 'replay'
  ticket: {
    id: string; threadId: string; title: string; stage: Stage; outcome?: string; staff: string
    createdAt: string; sourceId?: string; commandId?: string
  }
  assignmentId?: string
  contract?: AcceptanceContract
  contracts: readonly AcceptanceContract[]
  criteria: {
    id: string; text: string; method: string; required: boolean; status: string; evidenceIds: string[]
  }[]
  verification?: { verdict: string; status: string; contractVersion?: number; at?: string; historical: boolean }
  roles: SuperhubRole[]
  instances: SuperhubInstance[]
  waiting: SuperhubWaiting[]
  relatedTickets: {
    id: string; title: string; stage: Stage; outcome?: string; criterion?: number
    criterionId?: string; criterionText?: string; criterionVersion?: number
  }[]
  coverage: {
    epoch: string; checkedAt: string; state: SuperhubCoverageState; lastObservedAt?: string
    dimensions: Record<string, Dimension>
  }
  timeline: { items: SuperhubEvent[]; nextCursor?: string; total: number; matched: number; asOf: string }
  evidence: SuperhubEvidence[]
}

type OptionalEvent = Omit<SuperhubEvent, 'id' | 'source' | 'ticketId' | 'causes' | 'evidenceIds'> & Partial<Pick<SuperhubEvent, 'source' | 'causes' | 'evidenceIds'>>
type Seed = Omit<SuperhubInstance, 'coverage'> & { ref?: ExecutionRef; orderAt: string }

export interface SuperhubTraceOptions {
  storage?: string
  brainRoot?: string
  staff?: () => readonly Staff[]
  log?: (message: string) => void
  now?: () => Date
}

const stable = (...ids: readonly (string | number)[]) => createHash('sha256').update(JSON.stringify(ids)).digest('hex').slice(0, 32)
const eventKey = (scope: string, ticket: string, kind: string, id: string | number = '') => stable(scope, ticket, 'event', kind, id)
const instanceKey = (scope: string, ticket: string, assignment: string, kind: string, n: number) => stable(scope, ticket, assignment, kind, n)
const nativeEventKey = (scope: string, session: string, seq: number) => stable(scope, 'native-event', session, seq)
const deliveryKey = (scope: string, ticket: string, assignment: string, path: string, version: string) =>
  stable(scope, ticket, assignment, 'delivery', path, version)
const isDigest = (version: unknown): version is string => typeof version === 'string' && /^[a-f0-9]{64}$/.test(version)
const normalizeDate = (s?: string) => s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : undefined
const lastDate = (values: readonly (string | undefined)[]) => values.reduce<string | undefined>((last, at) => at && (!last || at > last) ? at : last, undefined)
const presentAt = (time: string | undefined, at: string | undefined) => !at || !!time && Date.parse(time) <= Date.parse(at)
const withinWindow = (time: string | undefined, from: string | undefined, to: string | undefined) =>
  (!from && !to) || !!time && (!from || time >= from) && (!to || time <= to)
const byTime = (a: SuperhubEvent, b: SuperhubEvent) => (b.at ?? '').localeCompare(a.at ?? '') || b.id.localeCompare(a.id)

function verificationStatus(assignment: Assignment) {
  const result = assignment.verification
  if (!result || result.status) return result?.status
  if (assignment.reviewExecution) return 'completed'
  return !assignment.verifier && assignment.role?.verifier === 'none' && result.verdict === 'pass' ? 'skipped' : 'unverified'
}

function allSeeds(scope: string, ticket: Ticket) {
  const latest = latestAssignment(ticket)
  return ticket.assignments.flatMap(assignment => {
    const seeds: Seed[] = []
    for (const kind of ['execute', 'verify'] as const) {
      const roleId = kind === 'execute' ? assignment.staff : assignment.verifier ?? assignment.role?.verifier ?? 'reviewer'
      const configuredExecutor = kind === 'execute' ? assignment.executor : undefined
      const attempts = assignment.attempts?.filter(attempt => attempt.kind === kind) ?? []
      const ref = kind === 'execute' ? assignment.execution : assignment.reviewExecution
      const verdict = kind === 'verify' ? assignment.verification?.verdict : undefined
      const statusAtStop = (status: string) => status === 'running' && latest === assignment && ticket.ended?.outcome === 'stopped' ? 'stop-requested' : status
      const make = (attempt: number, status: string, startedAt?: string, endedAt?: string, execution?: ExecutionRef): Seed => ({
        id: instanceKey(scope, ticket.id, assignment.id, kind, attempt),
        ticketId: ticket.id, assignmentId: assignment.id, kind, roleId, round: assignment.round, attempt, status: statusAtStop(status),
        historical: latest !== assignment || assignment.contractVersion !== ticket.superhub?.contracts.at(-1)?.version
          || (attempts.length > 0 && attempt !== attempts.at(-1)?.number),
        orderAt: normalizeDate(startedAt) ?? normalizeDate(assignment.startedAt) ?? '',
        startedAt, endedAt, configuredExecutor, actualProvider: execution?.provider,
        activationId: execution?.activationId, ref: execution, contractVersion: assignment.contractVersion, verdict,
        configuredModel: kind === 'execute' ? assignment.role?.model : undefined,
        configurationId: kind === 'execute' && assignment.role ? stable(scope, assignment.role.id, assignment.role.executor,
          assignment.role.model ?? '', assignment.role.verifier, assignment.role.brief) : undefined,
      })
      if (attempts.length) {
        for (const attempt of attempts) seeds.push(make(attempt.number, attempt.status, attempt.startedAt, attempt.endedAt, attempt.execution))
      } else if (kind === 'execute') {
        seeds.push(make(1, assignment.state, assignment.startedAt, assignment.endedAt, ref))
      } else if (ref || assignment.verifier) {
        // Old records omit the review start. The report timestamp cannot substitute for it.
        seeds.push(make(1, verificationStatus(assignment) ?? 'running', undefined, assignment.verifiedAt, ref))
      }
    }
    return seeds
  })
}

function historicalView(view: TicketView, at?: string, through?: Assignment): TicketView {
  if (!at) return view
  const ticket = view.ticket
  const records = through ? ticket.assignments.slice(0, ticket.assignments.indexOf(through) + 1) : ticket.assignments
  const postVerification = (time: string | undefined) => !!through && time === at
  const assignments = records.filter(item => presentAt(item.startedAt, at)).map(item => {
    const ended = presentAt(item.endedAt, at), verified = presentAt(item.verifiedAt, at)
    const attempts = item.attempts?.filter(attempt => presentAt(attempt.startedAt, at)).map(attempt =>
      presentAt(attempt.endedAt, at) ? attempt : { ...attempt, status: 'running' as const, endedAt: undefined })
    return {
      ...item, attempts, state: ended ? item.state : 'running' as const,
      endedAt: ended ? item.endedAt : undefined, report: ended ? item.report : undefined,
      receipt: ended ? item.receipt : undefined, deliveries: ended ? item.deliveries : undefined,
      verifiedAt: verified ? item.verifiedAt : undefined, verification: verified ? item.verification : undefined,
      reviewExecution: verified || attempts?.some(attempt => attempt.kind === 'verify') ? item.reviewExecution : undefined,
      verifier: verified || attempts?.some(attempt => attempt.kind === 'verify') ? item.verifier : undefined,
      commandApprovals: item.commandApprovals?.filter(approval => presentAt(approval.at, at)),
      staleResults: item.staleResults?.filter(result => presentAt(result.at, at)),
      verificationInvalidated: presentAt(item.verificationInvalidated?.at, at) && !(item === through && postVerification(item.verificationInvalidated?.at))
        ? item.verificationInvalidated : undefined,
    }
  })
  const ids = new Set(assignments.map(item => item.id))
  const past: Ticket = {
    ...ticket, assignments, approvedAt: presentAt(ticket.approvedAt, at) ? ticket.approvedAt : undefined,
    ended: presentAt(ticket.ended?.at, at) && !postVerification(ticket.ended?.at) ? ticket.ended : undefined, waitingFor: undefined,
    inputs: ticket.inputs.filter(input => presentAt(input.at, at) && !(postVerification(input.at) && input.key === `verification:${through?.id}`)).map(input =>
      input.consumedBy && !ids.has(input.consumedBy) ? { ...input, consumedBy: undefined } : input),
    superhub: ticket.superhub && {
      ...ticket.superhub, contracts: ticket.superhub.contracts.filter(contract => presentAt(contract.createdAt, at)
        && (through?.contractVersion === undefined || contract.version <= through.contractVersion)),
      ownerAcceptance: presentAt(ticket.superhub.ownerAcceptance?.at, at) && !postVerification(ticket.superhub.ownerAcceptance?.at)
        ? ticket.superhub.ownerAcceptance : undefined,
    },
  }
  return { ...view, ticket: past, stage: stageOf(past) }
}

function remoteFile(root: string | undefined, ticket: Ticket, assignment: Assignment, folder: string) {
  if (!root || !ASSIGNMENT_ID.test(assignment.id)) return undefined
  try {
    const row = JSON.parse(readFileSync(join(root, 'ops', 'remote', folder, assignment.id + '.json'), 'utf8')) as Record<string, unknown>
    return row?.ticketId === ticket.id && row.assignmentId === assignment.id ? row : undefined
  } catch { return undefined }
}

function deliveryAvailability(root: string | undefined, ticket: Ticket, version: string): SuperhubEvidence['availability'] {
  if (!root) return 'unconfirmed'
  if (!/^T-\d+$/.test(ticket.id) || !isDigest(version)) return 'unavailable'
  if (archivedOutput(root, ticket.id, version) !== undefined) return 'available'
  try {
    const info = statSync(join(root, 'ops', 'delivery-versions', ticket.id, version + '.json'))
    return (info.mode & 0o444) === 0 ? 'forbidden' : 'unreadable'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'expired'
    return code === 'EACCES' || code === 'EPERM' ? 'forbidden' : 'unreadable'
  }
}

const legacyCriterionId = (ticket: string, text: string) => `legacy-${stable(ticket, 'mandate-criterion', text)}`

function criterionBinding(parent: Ticket, child: Ticket) {
  const binding = child.parent!
  const version = parent.superhub?.contracts.find(row => row.version === binding.contractVersion)
  const criterion = version?.criteria.find(row => row.id === binding.criterionId)
  const grouped = parent.executionPlan?.assignmentId === binding.assignmentId && parent.executionPlan.groups.some(row => `plan-${row.key}` === binding.key)
  const legacy = !version && !grouped && child.executionBoundary !== 'remote' && child.mandate.doneWhen.length === 1 ? child.mandate.doneWhen[0] : undefined
  const text = binding.criterionText ?? criterion?.text ?? legacy
  return { criterion: binding.criterion, criterionId: binding.criterionId ?? (text ? legacyCriterionId(parent.id, text) : undefined),
    criterionText: text, criterionVersion: binding.contractVersion ?? (text ? 0 : undefined) }
}

interface Projection {
  events: SuperhubEvent[]
  evidence: SuperhubEvidence[]
  instances: SuperhubInstance[]
  waiting: SuperhubWaiting[]
}

function instanceProjection(scope: string, native: SuperhubNative, seed: Seed, unique: boolean, at?: string) {
  const { ref, orderAt: _orderAt, ...instance } = seed
  const candidate = nativeCandidate(ref)
  const sample = unique && candidate ? native.read(candidate) : undefined
  const facts = sample?.facts.filter(row => presentAt(row.at, at)) ?? []
  const sessionId = candidate && facts.some(row => row.type === 'subagent/descriptor') ? candidate : undefined
  const events: SuperhubEvent[] = []
  const calls = new Map<string, NativeFact[]>(), starts = new Map<number, NativeFact[]>(), results = new Set<number>()
  const callScope = (row: NativeFact, key?: string) =>
    row.turn !== undefined && row.step !== undefined && key ? `${row.turn}/${row.step}/${key}` : undefined
  const index = <K, V>(table: Map<K, V[]>, key: K, value: V) => table.set(key, [...(table.get(key) ?? []), value])
  let unpaired = false
  let model: string | undefined
  if (sessionId) for (const row of facts) {
    const id = nativeEventKey(scope, sessionId, row.seq)
    const detail: NonNullable<SuperhubEvent['native']> = {
      sessionId, seq: row.seq, channel: row.channel, turn: row.turn, step: row.step, redacted: false,
    }
    let title: string
    let status: string | undefined
    let cause: NativeFact | undefined
    switch (row.type) {
      case 'subagent/descriptor': title = '确认原生执行会话'; break
      case 'model/selection':
        title = '宿主选择模型'
        if (row.model) model = row.provider ? `${row.provider}/${row.model}` : row.model
        break
      case 'turn/start':
        title = '原生回合开始'
        if (row.turn !== undefined) index(starts, row.turn, row)
        break
      case 'turn/end': {
        title = '原生回合结束'
        status = row.reason
        const candidates = row.turn === undefined ? undefined : starts.get(row.turn)
        cause = candidates?.length === 1 ? candidates[0] : undefined
        break
      }
      case 'user/message':
        title = '原生输入已记录'
        detail.sourceKind = row.inputKind
        detail.ownerAttribution = 'unconfirmed'
        detail.redacted = true
        break
      case 'agent/inbox/spliced':
        title = '原生收件箱合并输入'
        detail.inserted = row.inserted
        detail.redacted = true
        break
      case 'tool/call': {
        title = '工具调用'
        const key = callScope(row, row.callKey)
        if (key) index(calls, key, row)
        detail.tool = row.tool
        detail.redacted = true
        status = 'called'
        break
      }
      case 'tool/result': {
        title = '工具返回'
        const conflicting = row.callKey && row.sourceCallKey && row.callKey !== row.sourceCallKey
        const key = conflicting ? undefined : callScope(row, row.callKey ?? row.sourceCallKey)
        const candidates = key ? calls.get(key) : undefined
        cause = candidates?.length === 1 ? candidates[0] : undefined
        status = row.failed === undefined ? 'unknown' : row.failed ? 'failed' : 'succeeded'
        detail.pairing = cause ? 'confirmed' : 'unconfirmed'
        detail.tool = cause?.tool
        detail.redacted = true
        if (cause) {
          results.add(cause.seq)
          const elapsed = Date.parse(row.at) - Date.parse(cause.at)
          if (elapsed >= 0) detail.durationMs = elapsed
        } else unpaired = true
        break
      }
    }
    detail.status = status
    events.push({
      id, ticketId: seed.ticketId, type: row.type, title, source: 'native', at: row.at, observedAt: row.observedAt, state: status,
      roleId: seed.roleId, assignmentId: seed.assignmentId, instanceId: seed.id, round: seed.round, native: detail,
      contractVersion: seed.contractVersion, causes: cause ? [nativeEventKey(scope, sessionId, cause.seq)] : [], evidenceIds: [],
    })
  }
  for (const event of events) if (event.type === 'tool/call') {
    const confirmed = results.has(event.native!.seq)
    event.native!.pairing = confirmed ? 'confirmed' : 'unconfirmed'
    if (!confirmed) unpaired = true
  }

  const lastTurn = facts.findLast(row => row.type === 'turn/start' || row.type === 'turn/end')
  const completeTurn = lastTurn?.type === 'turn/end'
  const remote = seed.configuredExecutor === 'remote'
  const baseline = candidate ? 'DSH 0.2.2-rc.1 spawn' : undefined
  let coverage: SuperhubInstance['coverage']
  if (!unique) coverage = { state: 'unconfirmed', session: 'unconfirmed', tools: 'unconfirmed', reason: '原生会话有多个可能的业务实例' }
  else if (sessionId) {
    const degraded = sample?.readState !== 'available' && !!(sample?.lastReadAt || sample?.readState)
    const tools = unpaired || !completeTurn ? seed.status === 'running' && !at ? 'collecting' : 'partial' : 'complete'
    coverage = {
      state: degraded ? 'cached' : !sample?.lastReadAt ? 'collecting' : tools,
      session: degraded ? 'cached' : 'complete',
      tools: degraded ? 'cached' : tools,
      reason: degraded ? '当前历史不可读取，已保留上次观察' : unpaired ? '部分工具调用或返回未建立匹配'
        : !completeTurn ? '尚未观察到原生回合结束' : undefined,
      sourceSequence: facts.at(-1)?.seq, lastReadAt: sample?.lastReadAt,
      lastObservedAt: at ? lastDate(facts.map(row => row.observedAt)) : sample?.lastObservedAt,
      baseline,
    }
  } else if (remote || (ref && !candidate)) coverage = {
    state: 'unsupported', session: 'unsupported', tools: 'unsupported',
    reason: remote ? '桥接提供领取或回传回执，工作端内部工具不可见' : '当前原生观察仅验证了 spawn',
  }
  else {
    const observed = sample?.readState
    const state = observed && observed !== 'available' ? observed : seed.status === 'running' && !at ? 'collecting' : 'unconfirmed'
    coverage = { state, session: state, tools: state, baseline,
      reason: observed === 'unsupported' ? '宿主未提供历史读取服务' : observed === 'unreadable' ? '宿主历史读取失败'
        : observed === 'unconfirmed' ? '会话描述未通过身份验证' : '缺少可验证的原生会话身份' }
  }
  const stopped = instance.status === 'cancelled' || instance.status === 'interrupted' || instance.status === 'stop-requested'
  const termination = stopped ? lastTurn?.reason === 'aborted' ? 'confirmed' : 'unconfirmed' : undefined
  return { instance: { ...instance, sessionId, model, coverage, termination } satisfies SuperhubInstance, events }
}

function projectTicket(
  scope: string,
  view: TicketView,
  initial: ChiefEvent | undefined,
  native: SuperhubNative,
  bindings: ReadonlyMap<string, number>,
  related: readonly TicketView[],
  options: SuperhubTraceOptions,
  at?: string,
): Projection {
  const { ticket } = view
  const events: SuperhubEvent[] = [], evidence: SuperhubEvidence[] = []
  const instances = allSeeds(scope, ticket).map(seed => {
    const candidate = nativeCandidate(seed.ref)
    const result = instanceProjection(scope, native, seed, !candidate || bindings.get(candidate) === 1, at)
    events.push(...result.events)
    return result.instance
  })
  const key = (kind: string, id?: string | number) => eventKey(scope, ticket.id, kind, id)
  const add = (type: string, id: string | number | undefined, fields: Omit<OptionalEvent, 'type'>) => {
    const row: SuperhubEvent = { id: key(type, id), ticketId: ticket.id, type, source: 'business', causes: [], evidenceIds: [], ...fields }
    events.push(row)
    return row.id
  }
  const opened = key('ticket/opened')
  const last = latestAssignment(ticket)
  const contract = ticket.superhub?.contracts.at(-1)
  const inputKey = (input: Ticket['inputs'][number], index: number) => key('ticket/input', input.key ?? index)
  if (initial) add('ticket/source', initial.id, { title: initial.source === 'inbox' ? '主人来源已记录' : '交办来源已记录',
    roleId: initial.source === 'inbox' ? 'owner' : 'system', sourceId: initial.id, at: initial.at, state: initial.source })
  add('ticket/opened', undefined, {
    title: '工单登记', at: ticket.createdAt, roleId: 'system', contractVersion: ticket.superhub?.contracts[0]?.version,
    causes: [
      ...initial ? [key('ticket/source', initial.id)] : [],
      ...ticket.parent ? [eventKey(scope, ticket.parent.ticketId, 'assignment/dispatched', ticket.parent.assignmentId)] : [],
    ],
  })
  if (ticket.approvedAt) add('ticket/approved', undefined, { title: '主人批准执行', roleId: 'owner', at: ticket.approvedAt, causes: [opened] })
  for (const item of ticket.superhub?.contracts ?? []) {
    add('ticket/contract', item.version, {
      title: '验收契约已记录', roleId: 'owner', at: item.createdAt, contractVersion: item.version,
      criterionIds: item.criteria.map(criterion => criterion.id),
      causes: item.version === 1 ? [opened] : [key('ticket/contract', item.version - 1)],
    })
  }
  for (const [index, input] of ticket.inputs.entries()) {
    const verificationId = input.key?.startsWith('verification:') ? input.key.slice('verification:'.length) : undefined
    const childId = input.key?.startsWith('child:') ? input.key.slice('child:'.length) : undefined
    const child = childId ? related.find(row => row.ticket.id === childId)?.ticket : undefined
    add('ticket/input', input.key ?? index, {
      title: input.from === 'owner' ? '主人补充输入' : input.from === 'verifier' ? '审查意见进入待处理输入' : '系统输入已记录',
      roleId: input.from === 'owner' ? 'owner' : input.from === 'verifier'
        ? ticket.assignments.find(item => item.id === input.replyTo)?.verifier ?? 'reviewer' : 'system',
      at: input.at, assignmentId: input.replyTo ?? undefined, state: input.consumedBy ? 'included-in-dispatch' : 'recorded',
      handoff: { sent: 'confirmed', delivered: 'unknown', processed: 'unknown' },
      causes: [
        ...input.replyTo ? [key('assignment/dispatched', input.replyTo)] : [],
        ...verificationId ? [key('assignment/verified', verificationId)] : [],
        ...child?.ended ? [eventKey(scope, child.id, 'ticket/ended', child.ended.outcome)] : [],
      ],
    })
  }
  for (const assignment of ticket.assignments) {
    const dispatch = key('assignment/dispatched', assignment.id)
    const reported = key('assignment/reported', assignment.id)
    const verified = key('assignment/verified', assignment.id)
    const assignmentFields = { assignmentId: assignment.id, round: assignment.round, contractVersion: assignment.contractVersion }
    const common = { ...assignmentFields, roleId: assignment.staff }
    const reviewer = assignment.verifier ?? assignment.role?.verifier ?? 'reviewer'
    const ownInstances = instances.filter(instance => instance.assignmentId === assignment.id)
    const executed = [...ownInstances].reverse().find(instance => instance.kind === 'execute' && instance.endedAt)
    const reviewed = [...ownInstances].reverse().find(instance => instance.kind === 'verify' && instance.endedAt)
    const deliverables = assignment.deliveries ?? []
    const consumed = ticket.inputs.flatMap((input, index) => input.consumedBy === assignment.id ? [inputKey(input, index)] : [])
    add('assignment/dispatched', assignment.id, {
      ...common, at: assignment.startedAt, title: '派工已登记', state: 'dispatched',
      causes: [opened, ...assignment.contractVersion ? [key('ticket/contract', assignment.contractVersion)] : [], ...consumed],
    })
    for (const instance of ownInstances) {
      const info = { ...assignmentFields, instanceId: instance.id, roleId: instance.roleId }
      const begin = key('attempt/started', instance.id)
      add('attempt/started', instance.id, {
        ...info, at: instance.startedAt, title: instance.kind === 'verify' ? '核验尝试' : '执行尝试', state: 'started',
        causes: [instance.kind === 'verify' ? reported : dispatch],
      })
      if (instance.endedAt) add('attempt/ended', instance.id, {
        ...info, at: instance.endedAt, title: '尝试有业务结束记录', state: instance.status, causes: [begin],
      })
    }
    if (assignment.report) add('assignment/reported', assignment.id, {
      ...common, at: assignment.endedAt, title: '执行者提交汇报', state: assignment.report.status,
      causes: [executed ? key('attempt/ended', executed.id) : dispatch],
      evidenceIds: deliverables.map(item => deliveryKey(scope, ticket.id, assignment.id, item.path, item.version)),
    })
    const refs = new Set<string>()
    for (const item of deliverables) {
      const id = deliveryKey(scope, ticket.id, assignment.id, item.path, item.version)
      const criteria = assignment.verification?.criteria?.filter(result => result.evidence.some(ref =>
        ref.kind === 'delivery' && ref.path === item.path && ref.version === item.version)).map(result => result.criterionId) ?? []
      if (criteria.length) refs.add(id)
      evidence.push({
        ...common, id, kind: 'delivery', ticketId: ticket.id, at: assignment.endedAt, title: '已归档交付版本', criterionIds: criteria,
        path: item.path, version: item.version, eventId: assignment.report ? reported : dispatch,
        historical: last !== assignment || assignment.contractVersion !== contract?.version || !!assignment.verificationInvalidated,
        availability: deliveryAvailability(options.brainRoot, ticket, item.version),
      })
    }
    for (const result of assignment.verification?.criteria ?? []) for (const item of result.evidence) if (item.kind === 'native') {
      const id = stable(scope, ticket.id, assignment.id, 'verification-evidence', item.id, item.version)
      refs.add(id)
      const existing = evidence.find(row => row.id === id)
      if (existing) { if (!existing.criterionIds.includes(result.criterionId)) existing.criterionIds.push(result.criterionId); continue }
      evidence.push({
        ...assignmentFields, id, kind: 'native', ticketId: ticket.id, roleId: reviewer, at: item.at,
        title: '审查所引用的宿主证据', criterionIds: [result.criterionId], version: item.version, method: item.method, eventId: verified,
        availability: 'redacted', historical: last !== assignment || assignment.contractVersion !== contract?.version || !!assignment.verificationInvalidated,
      })
    }
    if (assignment.verification) add('assignment/verified', assignment.id, {
      ...assignmentFields, roleId: reviewer, at: assignment.verifiedAt, title: '核验结论已记录',
      causes: reviewed ? [key('attempt/ended', reviewed.id)] : assignment.report ? [reported] : [],
      state: verificationStatus(assignment),
      criterionIds: assignment.verification.criteria?.map(item => item.criterionId), evidenceIds: [...refs],
    })
    if (assignment.verificationInvalidated) add('assignment/verification-invalidated', assignment.id, {
      ...assignmentFields, roleId: 'system', at: assignment.verificationInvalidated.at, title: '原核验结论失效', state: 'invalidated', causes: [verified],
    })
    for (const approval of assignment.commandApprovals ?? []) add('assignment/command-approval', `${approval.id}/${approval.status}`, {
      ...assignmentFields, roleId: approval.status === 'allowed-once' || approval.status === 'rejected' ? 'owner' : 'system',
      at: approval.at, title: '命令授权状态变化', state: approval.status,
      causes: [approval.status === 'requested' ? dispatch : key('assignment/command-approval', `${approval.id}/requested`)],
    })
    for (const stale of assignment.staleResults ?? []) add('assignment/stale-result', stale.id, {
      ...assignmentFields, roleId: stale.kind === 'review' ? reviewer : assignment.staff, at: stale.at, title: '陈旧结果已保留',
      state: 'stale', causes: [dispatch], contractVersion: stale.contractVersion,
    })
    if (assignment.executor === 'remote') {
      const receipt = remoteFile(options.brainRoot, ticket, assignment, 'receipts')
      const hash = isDigest(receipt?.hash) ? receipt.hash : assignment.receipt
      const receivedAt = normalizeDate(typeof receipt?.at === 'string' ? receipt.at : assignment.endedAt)
      if (isDigest(hash) && presentAt(receivedAt, at)) {
        const accepted = assignment.receipt === hash
        const id = stable(scope, ticket.id, assignment.id, 'remote-receipt', hash)
        const eventId = add('remote/receipt', assignment.id, {
          ...common, at: receivedAt, title: accepted ? '桥接回传已记入工单' : '桥接已收到回传', state: accepted ? 'accepted'
            : ticket.ended || last !== assignment ? 'stale' : 'received',
          causes: [dispatch], evidenceIds: [id],
          handoff: { sent: 'confirmed', delivered: 'confirmed', processed: accepted ? 'confirmed' : 'unknown' },
        })
        evidence.push({
          ...common, id, ticketId: ticket.id, at: receivedAt, kind: 'receipt', title: '工作端回传回执', criterionIds: [],
          availability: 'available', method: 'bridge', version: hash, eventId, historical: !accepted || last !== assignment,
        })
      }
    }
  }
  if (ticket.superhub?.ownerAcceptance) {
    const { assignmentId, at, contractVersion, kind } = ticket.superhub.ownerAcceptance
    add('ticket/owner-acceptance', assignmentId, { assignmentId, at, contractVersion, roleId: 'owner', state: kind,
      title: kind === 'deviation' ? '主人接受核验偏差' : '主人验收通过', causes: [key('assignment/verified', assignmentId)] })
  }
  if (ticket.ended) add('ticket/ended', ticket.ended.outcome, {
    title: ticket.ended.outcome === 'stopped' ? '工单已接受停止' : '工单记录结案', at: ticket.ended.at, roleId: 'system', state: ticket.ended.outcome,
    causes: ticket.superhub?.ownerAcceptance ? [key('ticket/owner-acceptance', ticket.superhub.ownerAcceptance.assignmentId)] : [],
  })

  for (const event of events) if (event.native?.redacted) {
    const id = stable(scope, 'native-evidence', event.id)
    event.evidenceIds.push(id)
    evidence.push({
      id, eventId: event.id, ticketId: ticket.id, assignmentId: event.assignmentId, roleId: event.roleId,
      at: event.at, observedAt: event.observedAt, kind: 'native', title: event.title, criterionIds: [], availability: 'redacted',
      method: 'dsh-session-event', version: event.id,
    })
  }
  const waiting = waitingTargets(scope, view, related, options.brainRoot, at)
  for (const instance of instances) {
    instance.lastEventId = events.filter(row => row.instanceId === instance.id).sort(byTime)[0]?.id
    if (last?.id === instance.assignmentId && !instance.historical) instance.waiting = waiting
  }
  return { events, evidence, instances, waiting }
}

function waitingTargets(scope: string, view: TicketView, related: readonly TicketView[], root: string | undefined, at?: string): SuperhubWaiting[] {
  const { ticket, stage } = view
  const last = latestAssignment(ticket)
  const opened = eventKey(scope, ticket.id, 'ticket/opened')
  const report = last?.report ? eventKey(scope, ticket.id, 'assignment/reported', last.id) : opened
  const since = last?.endedAt ?? ticket.createdAt
  const owner = (kind: string, label: string, until: string, eventId = report, entered = since): SuperhubWaiting[] =>
    [{ kind, target: 'owner', label, until, since: entered, eventIds: [eventId] }]
  if (stage === 'ended') return []
  const children = at ? related.filter(row => row.ticket.parent?.ticketId === ticket.id && !row.ticket.ended).map(row => row.ticket.id)
    : ticket.waitingFor ?? []
  if (children.length) return children.map(id => {
    const child = related.find(row => row.ticket.id === id)?.ticket
    return { kind: 'child', target: id, label: child?.title ?? id, until: '等待子任务解决当前依赖',
      since: child?.createdAt, eventIds: child ? [eventKey(scope, id, 'ticket/opened')] : [] }
  })
  switch (stage) {
    case 'you/approve': {
      const contract = ticket.superhub?.contracts.at(-1)
      return owner('approval', '等待主人批准', '当前授权版本已批准',
        contract ? eventKey(scope, ticket.id, 'ticket/contract', contract.version) : opened, contract?.createdAt ?? ticket.createdAt)
    }
    case 'you/answer': return owner('answer', '等待主人回答', '收到能够继续执行的答复')
    case 'you/review': return owner('acceptance', '等待主人验收', '记录主人验收、修订或明确接受偏差',
      last?.verification ? eventKey(scope, ticket.id, 'assignment/verified', last.id) : report, last?.verifiedAt ?? since)
    case 'you/blocked': return owner('resource', '等待处理阻碍', '收到补充信息、重新派工或停止', report)
    case 'verifying': {
      const target = last?.verifier ?? last?.role?.verifier ?? 'reviewer'
      return [{ kind: 'review', target, label: '等待核验结果', since: last?.endedAt, until: '收到当前轮次的核验结论', eventIds: [report] }]
    }
    case 'remote': {
      const claimed = !at && last && remoteFile(root, ticket, last, 'taken')
      const queued = !at && last && remoteFile(root, ticket, last, 'outbox')
      const entered = queued && typeof queued.queuedAt === 'string' ? normalizeDate(queued.queuedAt) : last?.startedAt
      return [{ kind: 'remote', target: last?.staff ?? ticket.staff, since: entered,
        label: claimed ? '工作端已领取，等待回传' : queued ? '工作端待领取' : '等待工作端回传，领取状态未知',
        until: '收到当前派工的有效回传', eventIds: last ? [eventKey(scope, ticket.id, 'assignment/dispatched', last.id)] : [] }]
    }
    case 'queued': return [{ kind: 'queue', target: ticket.staff, label: '等待派工', until: '调度器登记新的派工',
      eventIds: [report] }]
    default: return []
  }
}

function roleProjection(
  staff: readonly Staff[], views: readonly TicketView[], instances: readonly SuperhubInstance[],
  ownerSource = false, allStaff = false, orderAt?: ReadonlyMap<string, string>,
): SuperhubRole[] {
  const known = new Map(staff.map(card => [card.id, card]))
  const roles = new Map<string, SuperhubRole>()
  const add = (id: string, kind: string, fallback: string, system = false) => {
    let row = roles.get(id)
    if (!row) {
      row = { id, name: system ? fallback : known.get(id)?.name ?? fallback, defaultExecutor: system ? undefined : known.get(id)?.executor,
        kinds: [], instanceCount: 0, instances: [], status: 'not-started' }
      roles.set(id, row)
    }
    if (!row.kinds.includes(kind)) row.kinds.push(kind)
    return row
  }
  const owner = add('owner', 'owner', '主人')
  // 接口人是系统会话，不是幕僚：花名册里恰好有 id 为 liaison 的幕僚（默认模板里是外务）时，系统角色换一个不冲突的 id。
  add(known.has('liaison') ? 'liaison-session' : 'liaison', 'liaison', '接口人', true).status = 'unconfirmed'
  add('chief', 'triage', '研判官').status = 'unconfirmed'
  add('system', 'system', '调度系统').status = views.length ? 'historical' : 'not-started'
  if (allStaff) for (const card of staff) add(card.id, 'staff', card.id)
  for (const { ticket } of views) {
    const assignment = latestAssignment(ticket)
    const worker = add(ticket.staff, 'executor', ticket.staff)
    if (!assignment && known.get(ticket.staff)?.executor === 'remote') worker.status = 'unconfirmed'
    const verifier = assignment?.verifier ?? assignment?.role?.verifier ?? known.get(ticket.staff)?.verifier ?? 'reviewer'
    if (verifier !== 'none') add(verifier, 'reviewer', verifier === 'reviewer' ? '审查官' : verifier)
    if (ticket.superhub?.ownerAcceptance || ticket.approvedAt || ticket.inputs.some(input => input.from === 'owner')) owner.status = 'historical'
  }
  if (ownerSource) owner.status = 'historical'
  for (const instance of instances) {
    const role = add(instance.roleId, instance.kind === 'verify' ? 'reviewer' : 'executor', instance.roleId)
    role.instances.push(instance)
    role.instanceCount++
    if (!instance.historical && instance.status === 'running') role.status = 'active'
    else if (role.status !== 'active') role.status = 'historical'
  }
  const sortTime = (instance: SuperhubInstance) => orderAt?.get(instance.id) ?? instance.startedAt ?? instance.endedAt ?? ''
  for (const row of roles.values()) row.instances.sort((a, b) => sortTime(b).localeCompare(sortTime(a)) || a.id.localeCompare(b.id))
  return [...roles.values()]
}

function coverageOf(
  epoch: string, checkedAt: string, native: SuperhubNative, instances: readonly SuperhubInstance[],
  rows: readonly SuperhubEvent[], evidence: readonly SuperhubEvidence[], replay: boolean,
) {
  const aggregate = (values: readonly SuperhubCoverageState[]): SuperhubCoverageState => {
    if (!values.length) return 'not-started'
    const uniq = new Set(values)
    return uniq.size === 1 ? values[0]! : 'partial'
  }
  const availability = evidence.filter(row => row.kind === 'delivery').map(row => row.availability === 'available' ? 'complete' : row.availability)
  const lastObservedAt = lastDate(rows.map(row => row.observedAt))
  const sessions = aggregate(instances.map(row => row.coverage.session))
  const tools = aggregate(instances.map(row => row.coverage.tools))
  const handoffs = rows.filter(row => row.handoff)
  const remote = instances.filter(row => row.configuredExecutor === 'remote')
  const receipts = evidence.filter(row => row.kind === 'receipt')
  return {
    epoch, checkedAt, lastObservedAt,
    state: aggregate(instances.map(row => row.coverage.state)),
    dimensions: {
      business: { state: replay || !rows.some(row => row.type === 'ticket/source') ? 'partial' : 'complete',
        reason: replay ? '历史视图由保留的业务事实重建，未记录的中间状态不可确认' : undefined, count: rows.filter(row => row.source === 'business').length },
      participants: { state: 'partial', reason: '包括已知业务参与者和已关联实例。宿主其他成员及外部工作端成员的枚举范围未确认' },
      sessions: { state: sessions, count: instances.filter(row => row.sessionId).length, lastObservedAt },
      tools: { state: tools, count: rows.filter(row => row.type === 'tool/call' || row.type === 'tool/result').length, lastObservedAt },
      toolPayloads: { state: tools === 'not-started' ? 'not-started' : 'redacted', reason: '原生工具参数、正文和潜在敏感字段只保留选定元数据' },
      handoffs: { state: aggregate(handoffs.map(row => row.handoff?.processed === 'confirmed' ? 'complete' : 'partial')),
        reason: handoffs.some(row => row.handoff?.delivered === 'unknown') ? '业务记录可确认发出，原生送达或处理仍未确认' : undefined,
        count: handoffs.length },
      deliveries: { state: aggregate(availability), count: availability.length },
      remote: { state: remote.length ? 'partial' : 'not-started', count: receipts.length,
        reason: remote.length ? '范围限于桥接队列、回传确认及已登记的交付版本' : undefined },
      storage: { state: native.status(), reason: native.status() === 'unreadable' ? '部分原生观察无法从磁盘恢复或写盘' : undefined },
    } satisfies Record<string, Dimension>,
  }
}

interface Cursor { key: string; snapshot: string; time: string; id: string }

function readCursor(value: string | undefined, key: string, error: string): Cursor | undefined {
  if (!value) return
  try {
    if (value.length > 512) throw Error()
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor
    if (cursor.key !== key || normalizeDate(cursor.snapshot) !== cursor.snapshot
      || !(cursor.time === '' || normalizeDate(cursor.time) === cursor.time) || !/^[a-f0-9]{32}$/.test(cursor.id)) throw Error()
    return cursor
  } catch { throw Error(error) }
}

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url')

function page(scope: string, ticket: string, rows: SuperhubEvent[], query: SuperhubTraceQuery, now: string, at?: string) {
  const from = normalizeDate(query.from), to = normalizeDate(query.to)
  if ((query.at && !at) || (query.from && !from) || (query.to && !to)) throw Error('时间筛选不合法')
  const search = query.q?.trim().slice(0, 256).toLowerCase()
  const key = stable(scope, ticket, at ?? '', query.event ?? '', query.role ?? '', query.instance ?? '', query.round ?? '',
    query.type ?? '', query.status ?? '', query.criterion ?? '', from ?? '', to ?? '', search ?? '',
    ...query.windowTime === 'either' ? ['either'] : [])
  const cursor = readCursor(query.cursor, key, '轨迹游标已失效，请刷新原工单')
  // First observation is the stable ingestion fence for paging through a live or historical read.
  const snapshot = cursor?.snapshot ?? now
  const available = rows.filter(row => presentAt(row.observedAt ?? row.at ?? snapshot, snapshot))
  const matching = available.filter(row =>
    (!query.event || row.id === query.event) && (!query.role || row.roleId === query.role) && (!query.instance || row.instanceId === query.instance)
    && (query.round === undefined || row.round === query.round) && (!query.type || row.type === query.type)
    && (!query.status || row.state === query.status) && (!query.criterion || row.criterionIds?.includes(query.criterion))
    && (withinWindow(row.at, from, to) || (query.windowTime === 'either' && withinWindow(row.observedAt, from, to)))
    && (!search || [row.title, row.type, row.state, row.roleId, row.sourceId, row.native?.tool].join(' ').toLowerCase().includes(search)),
  ).sort(byTime)
  const remaining = cursor ? matching.filter(row => (row.at ?? '') < cursor!.time || ((row.at ?? '') === cursor!.time && row.id < cursor!.id)) : matching
  const limit = Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 250) : 80
  const items = remaining.slice(0, limit)
  const last = items.at(-1)
  const nextCursor = remaining.length > items.length && last
    ? encodeCursor({ key, snapshot, time: last.at ?? '', id: last.id }) : undefined
  return { items, nextCursor, total: available.length, matched: matching.length, asOf: at ?? snapshot }
}

type TraceEngine = Pick<Engine, 'views' | 'initialEvent'> & Partial<Pick<Engine, 'ticketView' | 'onTicketSaved'>>

/** Rebuild from the persisted tickets on startup and adjust only the changed bindings on save. */
class TicketTraceIndex {
  readonly bindings = new Map<string, number>()
  private readonly bindingTickets = new Map<string, Set<string>>()
  private readonly children = new Map<string, Set<string>>()
  private readonly rows = new Map<string, { ticket: Ticket; seeds: Seed[]; version: number; parent?: string; view?: TicketView }>()
  private readonly off?: () => void
  version = 0

  constructor(private readonly engine: TraceEngine, private readonly scope: string, private readonly native: SuperhubNative) {
    this.rebuild()
    this.off = engine.onTicketSaved?.(ticket => this.update(ticket))
  }

  ensure() {
    // Adapters without a durable change subscription still receive a consistent uncached view.
    if (!this.off) this.rebuild()
  }

  view(id: string): TicketView | undefined {
    const row = this.rows.get(id)
    if (!row) return
    if (this.engine.ticketView) return this.engine.ticketView(id)
    if (row.view) return row.view
    const stage = stageOf(row.ticket)
    return { ticket: row.ticket, stage, column: columnOf(stage), attention: 0 }
  }

  related(id: string): TicketView[] {
    return [...this.children.get(id) ?? []].flatMap(id => this.view(id) ?? [])
  }

  overview() {
    return [...this.rows.values()].map(row => ({ view: this.view(row.ticket.id)!, seeds: row.seeds, version: row.version }))
  }

  ticketForSession(id: string): string | undefined {
    if (this.bindings.get(id) === 1) return this.bindingTickets.get(id)?.values().next().value
  }

  dispose() { this.off?.() }

  private rebuild() {
    for (const id of this.bindings.keys()) this.native.forget(id)
    this.bindings.clear()
    this.bindingTickets.clear()
    this.rows.clear()
    this.children.clear()
    this.version++
    for (const view of this.engine.views()) this.update(view.ticket, view)
  }

  private update(ticket: Ticket, view?: TicketView) {
    this.version++
    const previous = this.rows.get(ticket.id)
    const changed = new Set<string>()
    const bind = (seeds: readonly Seed[], delta: number) => {
      for (const seed of seeds) {
        const id = nativeCandidate(seed.ref)
        if (!id) continue
        const count = (this.bindings.get(id) ?? 0) + delta
        if (count) this.bindings.set(id, count)
        else this.bindings.delete(id)
        if (delta > 0) {
          const owners = this.bindingTickets.get(id) ?? new Set<string>()
          owners.add(ticket.id)
          this.bindingTickets.set(id, owners)
        } else {
          const owners = this.bindingTickets.get(id)
          owners?.delete(ticket.id)
          if (!owners?.size) this.bindingTickets.delete(id)
        }
        changed.add(id)
      }
    }
    if (previous) {
      if (previous.parent) this.children.get(previous.parent)?.delete(ticket.id)
      this.rows.delete(ticket.id)
      bind(previous.seeds, -1)
    }
    if (!ticket.superhub || ticket.superhub.brainScope === this.scope) {
      const seeds = allSeeds(this.scope, ticket)
      this.rows.set(ticket.id, { ticket, seeds, version: this.version, parent: ticket.parent?.ticketId, view })
      bind(seeds, 1)
      if (ticket.parent) {
        const ids = this.children.get(ticket.parent.ticketId) ?? new Set<string>()
        ids.add(ticket.id)
        this.children.set(ticket.parent.ticketId, ids)
      }
    }
    for (const id of changed) {
      if (this.bindings.get(id) === 1) this.native.watch([id])
      else this.native.forget(id)
    }
  }
}

/** All identity resolution begins with this runtime's current brain and authoritative ticket views. */
export function createSuperhubTrace(
  ctx: Pick<HostContext, 'get' | 'on'>,
  engine: TraceEngine,
  scope: string,
  options: SuperhubTraceOptions = {},
) {
  const native = new SuperhubNative(ctx, scope, options)
  const index = new TicketTraceIndex(engine, scope, native)
  const epoch = randomUUID()
  const now = options.now ?? (() => new Date())
  const project = (view: TicketView, children: readonly TicketView[], at?: string) =>
    projectTicket(scope, view, engine.initialEvent(view.ticket.id), native, index.bindings, children, options, at)
  const observeExecution = (ref: ExecutionRef) => {
    const candidate = nativeCandidate(ref)
    if (!candidate) return
    index.ensure()
    if (index.bindings.get(candidate) === 1) void native.refresh([candidate])
    else native.forget(candidate)
  }

  async function mission(ticketId: string, query: SuperhubTraceQuery = {}): Promise<SuperhubMission | undefined> {
    index.ensure()
    const at = normalizeDate(query.at)
    if (query.at && !at) throw Error('历史回放时间不合法')
    const selected = index.view(ticketId)
    if (!selected || !presentAt(selected.ticket.createdAt, at)) return
    const copy = (row: TicketView) => historicalView({ ...row, ticket: structuredClone(row.ticket) }, at)
    const snapshot = structuredClone(selected.ticket)
    // A verification event is an exact business boundary even if rework shares its timestamp.
    const through = at && query.event ? snapshot.assignments.find(item => normalizeDate(item.verifiedAt) === at
      && eventKey(scope, ticketId, 'assignment/verified', item.id) === query.event) : undefined
    const view = historicalView({ ...selected, ticket: snapshot }, at, through)
    const assignmentIds = new Set(view.ticket.assignments.map(item => item.id))
    const children = index.related(ticketId).filter(row => presentAt(row.ticket.createdAt, at)
      && (!through || assignmentIds.has(row.ticket.parent!.assignmentId))).map(copy)
    if (at) {
      // Preserve explicit child links when evaluating the historical business stage.
      const waitingFor = children.filter(child => !child.ticket.ended).map(child => child.ticket.id)
      view.ticket.waitingFor = waitingFor
    }
    const rows = [view, ...children]
    const candidates = rows.flatMap(({ ticket }) => allSeeds(scope, ticket)).map(seed => nativeCandidate(seed.ref))
      .filter((id): id is string => !!id && index.bindings.get(id) === 1)
    await native.refreshForQuery([...new Set(candidates)])
    const results = rows.map(row => project(row, row === view ? children : [], at))
    const events = results.flatMap(row => row.events).filter(event => presentAt(event.at, at) || !event.at && !!at)
    const instances = results.flatMap(row => row.instances)
    const evidence = results.flatMap(row => row.evidence)
    const checkedAt = now().toISOString()
    const { ticket } = view, last = latestAssignment(ticket)
    const contracts = ticket.superhub?.contracts ?? []
    const contract = contracts.at(-1)
    const previous = last?.verification
    const current = last?.contractVersion === contract?.version && !last?.verificationInvalidated
    const legacyCounts = new Map<string, number>()
    const criteria = (contract?.criteria ?? ticket.mandate.doneWhen.map(text => {
      const id = legacyCriterionId(ticket.id, text)
      const ordinal = legacyCounts.get(id) ?? 0
      legacyCounts.set(id, ordinal + 1)
      return { id: ordinal ? `${id}-${ordinal + 1}` : id, text, required: true, method: 'delivery' }
    })).map(criterion => ({
      ...criterion,
      status: current ? previous?.criteria?.find(item => item.criterionId === criterion.id)?.status ?? 'unverified' : 'unverified',
      evidenceIds: current ? evidence.filter(item => item.assignmentId === last?.id && item.criterionIds.includes(criterion.id)).map(item => item.id) : [],
    }))
    return {
      scope, mode: at ? 'replay' : 'live',
      ticket: { id: ticket.id, threadId: threadIdOf(ticket), title: ticket.title, stage: at ? stageOf(ticket) : view.stage,
        outcome: ticket.ended?.outcome, staff: ticket.staff, createdAt: ticket.createdAt, sourceId: ticket.superhub?.sourceId,
        commandId: ticket.superhub?.commandId },
      assignmentId: last?.id, contract, contracts, criteria,
      verification: previous && { verdict: previous.verdict, status: verificationStatus(last!) ?? 'unverified',
        contractVersion: previous.contractVersion, at: last?.verifiedAt, historical: !current },
      relatedTickets: children.map(({ ticket: child, stage }) => ({ id: child.id, title: child.title, stage, outcome: child.ended?.outcome, ...criterionBinding(ticket, child) })),
      roles: roleProjection(options.staff?.() ?? [], rows, instances, events.some(row => row.roleId === 'owner')), instances, waiting: results[0]!.waiting,
      coverage: coverageOf(epoch, checkedAt, native, instances, events, evidence, !!at),
      timeline: page(scope, ticketId, events, query, checkedAt, at), evidence,
    }
  }

  let roleCache: { key: string; rows: SuperhubRole[]; orderAt: Map<string, string> } | undefined
  let roleOverview: { key: string; rows: SuperhubRole[] } | undefined
  const roleInstances = new Map<string, { key: string; instance: SuperhubInstance }>()
  function roleCatalog() {
    index.ensure()
    const staff = options.staff?.() ?? []
    const key = JSON.stringify([index.version, native.version, staff.map(({ id, name, executor, verifier }) => [id, name, executor, verifier])])
    if (roleCache?.key !== key) {
      const all = index.overview()
      const orderAt = new Map<string, string>()
      const instances = all.flatMap(({ view, seeds, version }) => seeds.map(seed => {
        orderAt.set(seed.id, seed.orderAt)
        const candidate = nativeCandidate(seed.ref)
        const binding = candidate ? index.bindings.get(candidate) ?? 0 : 1
        const instanceKey = `${version}/${native.revision(candidate)}/${binding}/${view.stage}`
        const cached = roleInstances.get(seed.id)
        if (cached?.key === instanceKey) return cached.instance
        const { instance, events } = instanceProjection(scope, native, seed, binding === 1)
        instance.lastEventId = events.sort(byTime)[0]?.id ?? (instance.endedAt
          ? eventKey(scope, instance.ticketId, 'attempt/ended', instance.id)
          : eventKey(scope, instance.ticketId, 'attempt/started', instance.id))
        if (!instance.historical && instance.assignmentId === latestAssignment(view.ticket)?.id) {
          instance.waiting = waitingTargets(scope, view, index.related(view.ticket.id), options.brainRoot)
        }
        roleInstances.set(seed.id, { key: instanceKey, instance })
        return instance
      }))
      const rows = roleProjection(staff, all.map(row => row.view), instances, false, true, orderAt)
      roleCache = { key, rows, orderAt }
    }
    return roleCache
  }

  function roles(limit = 20, roleId?: string) {
    const catalog = roleCatalog()
    const cap = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : 20, 250)
    const key = JSON.stringify([catalog.key, cap])
    if (roleOverview?.key !== key) {
      roleOverview = { key, rows: catalog.rows.map(role => ({ ...role, instances: role.instances.slice(0, cap) })) }
    }
    return roleId ? roleOverview.rows.filter(role => role.id === roleId) : roleOverview.rows
  }

  function roleActivity(roleId: string, { cursor: value, limit = 40 }: { cursor?: string; limit?: number } = {}): SuperhubRoleActivity | undefined {
    const catalog = roleCatalog()
    const known = catalog.rows.find(row => row.id === roleId)
    if (!known) return
    const key = stable(scope, 'role-activity', roleId)
    const cursor = readCursor(value, key, '角色活动游标已失效，请刷新列表')
    const asOf = cursor?.snapshot ?? now().toISOString()
    const orderAt = (instance: SuperhubInstance) => catalog.orderAt.get(instance.id) ?? ''
    const { instances, ...role } = known
    const available = instances.filter(instance => orderAt(instance) <= asOf)
    const start = cursor ? available.findIndex(instance => {
      const time = orderAt(instance)
      return time < cursor.time || (time === cursor.time && instance.id > cursor.id)
    }) : 0
    const cap = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : 40, 250)
    const items = start < 0 ? [] : available.slice(start, start + cap)
    const last = items.at(-1)
    const nextCursor = last && start + items.length < available.length
      ? encodeCursor({ key, snapshot: asOf, time: orderAt(last), id: last.id }) : undefined
    return { scope, role: { ...role, instanceCount: available.length }, items, total: available.length, asOf, nextCursor }
  }

  function recentlyObservedTicketIds(from: string, to: string): string[] {
    const begin = normalizeDate(from), end = normalizeDate(to)
    if (!begin || !end || begin > end) throw Error('观察时间区间不合法')
    index.ensure()
    const tickets = new Set<string>()
    for (const id of native.observedSessions(begin, end)) {
      const ticketId = index.ticketForSession(id)
      if (ticketId) tickets.add(ticketId)
    }
    return [...tickets].sort()
  }

  async function evidence(ticketId: string, evidenceId: string) {
    if (!/^[a-f0-9]{32}$/.test(evidenceId)) return
    return (await mission(ticketId))?.evidence.find(row => row.id === evidenceId)
  }

  return { mission, roles, roleActivity, recentlyObservedTicketIds, evidence, observeExecution, dispose: () => { index.dispose(); native.dispose() } }
}
