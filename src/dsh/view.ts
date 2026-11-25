/**
 * 作战台的数据视图：网页面板（HTTP）与简报工具（dsh-go 工具卡）共用。
 * 原则：先列出等主人决定的事；健康状态不占地方，只有问题才显示。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Engine, TicketView } from '../core/engine.ts'
import { threadBoundaryOf, threadIdOf, type Ticket } from '../core/model.ts'
import { questionChoices } from '../core/report.ts'
import { latestAssignment } from '../core/stage.ts'
import type { BrainRepo } from './brain.ts'
import { privateBrainData } from './brain-private.ts'
import { pocState, situationText, type PocState } from './poc-view.ts'
import type { FileRemoteQueue } from './remote.ts'
import type { Roster } from './roster.ts'
import type { NativeRooms } from './rooms.ts'
import { commandSummary, type PendingCommand } from './approvals.ts'

export interface TicketCard {
  id: string
  title: string
  stage: string
  attention: number
  staff: string
  scoped?: boolean
  requestedExecutor?: string
  level: string
  strength: string
  scope: string
  doneWhen: readonly string[]
  createdAt: string
  priority: number
  rounds: number
  hasProposal: boolean
  /** 工作目录里有产出文件（可以在阅读器里看）。 */
  hasFiles: boolean
  latest?: {
    executor: string
    status?: string
    summary?: string
    question?: string
    outputs?: readonly string[]
    verdict?: string
    critique?: string
    at: string
  }
  ended?: Ticket['ended']
}

/** 幕僚团里的一个角色：职责、用什么执行、现在在办什么。 */
export interface StaffRow {
  id: string; name: string; executor: string; verifier: string; model?: string; reasoningEffort?: string; brief: string; available: boolean
  doing: { id: string; title: string; stage: string }[]
  /** 办结的工单数。 */
  done: number
}

/** 事件流里的一条：来自哪个来源、研判怎么处置、理由是什么。 */
export interface EventRow {
  id: string; at: string; source: string; text: string
  kind: string
  disposition: string
  reason?: string
  ticketId?: string
}

/**
 * 一条等主人决定的执行器命令审批：哪张工单、哪位幕僚、要运行什么、什么时候过期。
 * 只给已登录的主人（电脑端宿主连接）；手机网关和工具简报不带命令原文。
 */
export interface CommandDecision {
  id: string
  ticket: string
  title: string
  staff: string
  staffId: string
  /** 单行命令摘要；完整命令在 command。 */
  summary: string
  command: string
  workdir: string
  mode: PendingCommand['mode']
  reason: string
  executor?: 'codex'
  requestedAt?: string
  expiresAt?: string
}

/** 待审批命令投影成「等你决定」的条目：只列当前第二大脑可见的工单，最早过期的在前。 */
export function commandDecisions(rows: readonly PendingCommand[], visible: (ticketId: string) => boolean): CommandDecision[] {
  return rows.filter(row => !row.workspace && visible(row.ticket))
    .map(row => ({
      id: row.id, ticket: row.ticket, title: row.title, staff: row.staff, staffId: row.staffId, summary: commandSummary(row.command),
      command: row.command, workdir: row.workdir, mode: row.mode, reason: row.reason,
      ...row.executor ? { executor: row.executor } : {}, ...row.requestedAt ? { requestedAt: row.requestedAt } : {}, ...row.expiresAt ? { expiresAt: row.expiresAt } : {},
    }))
    .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? ''))
}

/** 一个事件来源和它的档位。fixed 的来源不能调档。 */
export interface SourceRow { id: string; name: string; what: string; mode: 'auto' | 'observe' | 'off'; fixed: boolean }

export interface WarroomState {
  superhubScope?: string
  now: string
  paused: boolean
  problems: { at: string; text: string }[]
  /** 研判失败的事件：主人的投递不能被静默丢弃。 */
  stuck: { id: string; at: string; source: string; text: string; reason: string }[]
  roomActions?: ReturnType<NativeRooms['ownerActions']>
  /** 等主人单次允许或拒绝的执行器命令（只在主人自己的视图里出现）。 */
  commands?: CommandDecision[]
  you: TicketCard[]
  active: TicketCard[]
  queued: TicketCard[]
  ended: TicketCard[]
  events: EventRow[]
  staff: StaffRow[]
  sources: SourceRow[]
  /** 接口人和幕僚自己定的跟进，按触发时间排。 */
  timers: { id: string; at: string; text: string; by: string }[]
  /** 是否配置了推送渠道。 */
  push: boolean
  /** 服务端插件的构建编号；和页面自己的编号不同，说明有新版本。 */
  build: string
  goals: string
  remote: { waiting: number; taken: number }
  rules: { id: string; when: string }[]
  poc: PocState
}

function card(view: TicketView, brain: BrainRepo): TicketCard {
  const { ticket } = view
  const last = latestAssignment(ticket)
  const dir = join(brain.root, 'work', ticket.id)
  return {
    id: ticket.id, title: ticket.title, stage: view.stage, attention: Math.round(view.attention), staff: ticket.staff,
    ...(ticket.superhub ? { scoped: true } : {}),
    level: ticket.mandate.level, strength: ticket.mandate.strength, scope: ticket.mandate.scope, doneWhen: ticket.mandate.doneWhen,
    ...(ticket.requestedExecutor ? { requestedExecutor: ticket.requestedExecutor } : {}),
    createdAt: ticket.createdAt, priority: ticket.priority, rounds: ticket.assignments.length,
    hasProposal: existsSync(join(dir, 'proposal.md')),
    hasFiles: existsSync(dir) && readdirSync(dir).some(n => !n.startsWith('.')),
    ...last ? {
      latest: {
        executor: last.executor, at: last.endedAt ?? last.startedAt,
        ...last.report ? { status: last.report.status, summary: last.report.summary, ...last.report.question ? { question: last.report.question } : {}, ...last.report.outputs ? { outputs: last.report.outputs } : {} } : {},
        ...last.verification ? { verdict: last.verification.verdict, critique: last.verification.critique } : {},
      },
    } : {},
    ...ticket.ended ? { ended: ticket.ended } : {},
  }
}

const DISPOSITION: Record<string, string> = { pending: '等待研判', observed: '只记录，没有处理', ignored: '忽略', noted: '记了一笔', attached: '并入', accepted: '开单', unavailable: '研判失败' }

export interface StateDeps {
  engine: Engine; brain: BrainRepo; brainScope?: string; remote: FileRemoteQueue; roster: Roster; rooms?: NativeRooms; available: (executor: string) => boolean
  clock: () => { today: string; now: string }; sources: () => SourceRow[]; timers: () => WarroomState['timers']; push: () => boolean
  /** 待审批的执行器命令。只在主人的作战台视图里提供。 */
  commands?: () => readonly PendingCommand[]
}

export function warroomState({ engine, brain, brainScope, remote, roster, rooms, available, clock, sources, timers, push, commands: pending }: StateDeps): WarroomState {
  const views = engine.views().filter(({ ticket }) => !ticket.superhub || ticket.superhub.brainScope === brainScope)
  const visibleTickets = new Set(views.map(({ ticket }) => ticket.id))
  const by = (column: string) => views.filter(v => v.column === column)
  const roomActions = rooms?.ownerActions().filter(action => !action.answered && !action.ticketId) ?? []
  const commands = pending && commandDecisions(pending(), id => visibleTickets.has(id))
  return {
    now: new Date().toISOString(),
    paused: engine.isPaused(),
    problems: engine.problems.slice(0, 5),
    stuck: engine.stuckEvents().map(({ event, reason }) => ({ id: event.id, at: event.at, source: event.source, text: event.text.slice(0, 300), reason })),
    roomActions,
    ...commands ? { commands } : {},
    you: by('you').sort((a, b) => b.attention - a.attention).map(v => card(v, brain)),
    active: by('active').sort((a, b) => a.ticket.createdAt.localeCompare(b.ticket.createdAt)).map(v => card(v, brain)),
    queued: by('queued').sort((a, b) => b.ticket.priority - a.ticket.priority).map(v => card(v, brain)),
    ended: by('ended').sort((a, b) => (b.ticket.ended?.at ?? '').localeCompare(a.ticket.ended?.at ?? '')).slice(0, 15).map(v => card(v, brain)),
    events: engine.recentEvents(40).filter(({ event, disposition }) =>
      (!event.superhubCommission || event.superhubCommission.brainScope === brainScope)
      && (!disposition || !('ticketId' in disposition) || typeof disposition.ticketId !== 'string' || visibleTickets.has(disposition.ticketId))).map(({ event, disposition }) => {
      const kind = disposition?.kind ?? 'pending'
      const ticketId = disposition && 'ticketId' in disposition ? disposition.ticketId : undefined
      const reason = disposition && 'reason' in disposition ? disposition.reason : undefined
      return { id: event.id, at: event.at, source: event.meta?.rule ?? event.source, text: event.text.slice(0, 240), kind,
        disposition: `${DISPOSITION[kind] ?? kind}${ticketId ? ` ${ticketId}` : ''}`, ...reason ? { reason: reason.slice(0, 200) } : {}, ...ticketId ? { ticketId } : {} }
    }),
    staff: brain.staff().map(s => ({
      id: s.id, name: s.name, executor: s.executor, verifier: s.verifier, brief: s.brief, ...s.model ? { model: s.model } : {}, ...s.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {},
      available: s.executor === 'remote' || available(s.executor),
      doing: views.filter(v => !v.ticket.ended && (v.ticket.staff === s.id || (v.stage === 'verifying' && s.id === (brain.staff().find(x => x.id === v.ticket.staff)?.verifier ?? 'reviewer'))))
        .filter(v => v.stage !== 'ended').map(v => ({ id: v.ticket.id, title: v.ticket.title, stage: v.stage })),
      done: views.filter(v => v.ticket.ended && v.ticket.staff === s.id).length,
    })),
    sources: sources(),
    timers: timers(),
    push: push(),
    build: typeof __BUILD__ === 'string' ? __BUILD__ : 'dev',
    goals: brain.goals().slice(0, 4000),
    remote: remote.counts(),
    rules: brain.rules().map(r => ({ id: r.id, when: r.when })),
    poc: pocState(roster, engine, clock(), by('you').length + engine.stuckEvents().length + roomActions.length + (commands?.length ?? 0)),
  }
}

/** 工单详情：完整工单 + 工作目录文件列表。 */
export function ticketDetail(engine: Engine, brain: BrainRepo, id: string) {
  const view = engine.views().find(v => v.ticket.id === id)
  if (!view) return undefined
  const dir = join(brain.root, 'work', id)
  const files: { path: string; size: number }[] = []
  const walk = (d: string, depth: number) => {
    if (!existsSync(d) || depth > 3) return
    for (const name of readdirSync(d)) {
      if (name.startsWith('.')) continue
      const full = join(d, name), st = lstatSync(full)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(full, depth + 1)
      else if (st.isFile() && files.length < 100) files.push({ path: relative(brain.root, full), size: st.size })
    }
  }
  walk(dir, 0)
  const applied = engine.views().find(v => v.ticket.title === `执行提案 ${id}`)
  const proposal = { exists: existsSync(join(dir, 'proposal.md')), ...applied ? { applyTicket: applied.ticket.id } : {} }
  const groups = view.ticket.executionPlan ? engine.views().filter(v => v.ticket.parent?.ticketId === id)
    .map(v => ({ id: v.ticket.id, title: v.ticket.title, stage: v.stage, outcome: v.ticket.ended?.outcome })) : undefined
  return { ticket: view.ticket, threadId: threadIdOf(view.ticket), stage: view.stage, files, proposal, ...groups ? { groups } : {} }
}

export interface ThreadMessage {
  id: string
  at: string
  role: 'owner' | 'staff' | 'verifier' | 'system'
  text: string
  assignment_id?: string
  staff_id?: string
  request_id?: string
  reply_to?: string | null
  status?: string
  question?: string
  choices?: string[]
}

/** 工单输入、执行汇报与独立核验组成工作讨论；不读取接口人或任何其他会话。 */
export function ticketThread(engine: Engine, brain: Pick<BrainRepo, 'staff'>, id: string) {
  const view = engine.views().find(v => v.ticket.id === id)
  if (!view) return undefined
  const { ticket } = view
  const messages: ThreadMessage[] = []
  const assignmentOrder = new Map(ticket.assignments.map((assignment, index) => [assignment.id, index]))
  const order = new Map<string, number>()
  const event = engine.initialEvent(id)
  messages.push({ id: `event:${ticket.mandate.eventId}`, at: event?.at ?? ticket.createdAt, role: event?.source === 'inbox' ? 'owner' : 'system', text: event?.text ?? ticket.mandate.scope })
  ticket.inputs.forEach((input, index) => {
    // 新核验输入明确绑定产生它的派工；其完整意见已在对应核验消息展示。
    if (input.from === 'verifier' && input.key?.startsWith('verification:')) {
      const source = ticket.assignments.find(assignment => input.key === `verification:${assignment.id}`)
      if (source?.verification?.critique === input.text) return
    }
    const id = `input:${input.key ?? index}`
    const consumed = input.consumedBy ? assignmentOrder.get(input.consumedBy) : undefined
    const replied = input.replyTo ? assignmentOrder.get(input.replyTo) : undefined
    order.set(id, (consumed ?? (replied !== undefined ? replied + 1 : ticket.assignments.length)) * 4 - 1)
    messages.push({ id, at: input.at, role: input.from === 'owner' ? 'owner' : input.from === 'verifier' ? 'verifier' : 'system', text: input.text,
      ...input.consumedBy ? { assignment_id: input.consumedBy } : {},
      ...input.key?.startsWith('reply:') ? { request_id: input.key.slice(6), reply_to: input.replyTo ?? null } : {},
    })
  })
  for (const assignment of ticket.assignments) {
    const rank = assignmentOrder.get(assignment.id)! * 4
    order.set(`${assignment.id}:start`, rank)
    order.set(`${assignment.id}:report`, rank + 1)
    order.set(`${assignment.id}:verification`, rank + 2)
    messages.push({ id: `${assignment.id}:start`, at: assignment.startedAt, role: 'system', text: `派给 ${assignment.role?.name ?? assignment.staff}（${assignment.executor === 'remote' ? '工作电脑' : '本地'}）`, assignment_id: assignment.id, staff_id: assignment.staff, status: assignment.state })
    if (assignment.report) {
      const report = assignment.report
      const choices = questionChoices(report)
      messages.push({ id: `${assignment.id}:report`, at: assignment.endedAt ?? assignment.startedAt, role: 'staff', staff_id: assignment.staff, assignment_id: assignment.id, status: report.status, text: report.summary,
        ...report.question ? { question: report.question } : {}, ...choices ? { choices } : {},
      })
    }
    if (assignment.verification) messages.push({ id: `${assignment.id}:verification`, at: assignment.verifiedAt ?? assignment.endedAt ?? assignment.startedAt, role: 'verifier', staff_id: assignment.verifier ?? assignment.role?.verifier ?? 'reviewer', assignment_id: assignment.id, status: assignment.verification.verdict, text: assignment.verification.critique })
  }
  if (ticket.ended) messages.push({ id: `${ticket.id}:ended`, at: ticket.ended.at, role: 'system', text: ticket.ended.note, status: ticket.ended.outcome })
  order.set(`event:${ticket.mandate.eventId}`, -2)
  order.set(`${ticket.id}:ended`, ticket.assignments.length * 4 + 1)
  // 同毫秒的记录按消耗输入／派工／汇报的因果关系排序，旧数据无需迁移。
  messages.sort((a, b) => a.at.localeCompare(b.at) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const executions = ticket.assignments.map(assignment => ({ assignment_id: assignment.id, executor: assignment.executor, state: assignment.state, started_at: assignment.startedAt,
    ...assignment.endedAt ? { ended_at: assignment.endedAt } : {},
    ...assignment.commandApprovals?.length ? { approvals: assignment.commandApprovals } : {},
    ...assignment.execution ? { provider: assignment.execution.provider, activation_id: assignment.execution.activationId, ...assignment.execution.sessionId ? { session_id: assignment.execution.sessionId } : {} } : {},
    ...assignment.reviewExecution ? { review: { provider: assignment.reviewExecution.provider, activation_id: assignment.reviewExecution.activationId, ...assignment.reviewExecution.sessionId ? { session_id: assignment.reviewExecution.sessionId } : {} } } : {},
  }))
  return { thread_id: threadIdOf(ticket), ticket_id: ticket.id, title: ticket.title, stage: view.stage, read_only: !!ticket.ended, reply_to: latestAssignment(ticket)?.id ?? null,
    execution_boundary: threadBoundaryOf(ticket, brain.staff().find(s => s.id === ticket.staff)?.executor), messages, executions }
}

/** 读取 brain 内的文本文件（作战台查看产出用），拒绝越界路径和大文件。 */
export function readBrainFile(brain: BrainRepo, path: string): string | undefined {
  if (!path || !existsSync(join(brain.root, path))) return undefined
  // 解析符号链接后再判断边界：幕僚可以在工作目录里建链接指向别处。
  const root = realpathSync(brain.root)
  const full = realpathSync(join(brain.root, path))
  const rel = relative(root, full)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const parts = rel.split(sep)
  if (parts[0] === '.git' || (parts[0] === 'ops' && parts[1] === 'remote') || privateBrainData(parts)) return undefined
  const st = statSync(full)
  if (!st.isFile() || st.size > 512 * 1024) return undefined
  return readFileSync(full, 'utf8')
}

const STAGE_LABEL: Record<string, string> = {
  'you/approve': '待批准', 'you/answer': '待回答', 'you/review': '待验收', 'you/blocked': '受阻',
  queued: '排队', working: '执行中', verifying: '审查中', remote: '工作电脑', waiting: '等关联子任务', ended: '已结束',
}
export const stageLabel = (stage: string) => STAGE_LABEL[stage] ?? stage

/** 简报的模型可读文本。 */
const OUTCOME: Record<string, string> = { done: '已办结', dropped: '已放弃', stopped: '已停止', failed: '失败' }

export function briefText(s: WarroomState): string {
  const lines = [`作战简报（${s.paused ? '已暂停' : '运行中'}）`, situationText(s.poc.situation)]
  for (const c of s.poc.ledger.filter(c => c.dueState === 'overdue' || c.dueState === 'today').slice(0, 8))
    lines.push(`- 承诺 ${c.id}（${c.direction === 'mine' ? '我欠' : '欠我'}${c.who}）${c.what}，${c.dueState === 'overdue' ? `逾期 ${-(c.dueIn ?? 0)} 天` : '今天到期'}`)
  for (const l of s.poc.lines.filter(l => l.blocker)) lines.push(`- 横向线「${l.name}」受阻：${l.blocker}`)
  for (const m of s.poc.meetings.filter(m => m.today && !m.past)) lines.push(`- 今天 ${m.at.slice(11)} ${m.title}${m.prepTicket ? `（准备材料见 ${m.prepTicket}）` : ''}`)
  if (s.problems.length) lines.push(`系统问题：${s.problems.map(p => p.text).join('；')}`)
  lines.push(`等你决定 ${s.poc.situation.decide} 项：`)
  for (const c of s.you.slice(0, 8)) lines.push(`- ${c.id}「${c.title}」${stageLabel(c.stage)}：${c.latest?.question ?? c.latest?.summary?.split('\n')[0] ?? c.scope}`)
  for (const action of (s.roomActions ?? []).slice(0, 8)) lines.push(`- 讨论 ${action.roomId}「${action.roomTitle}」${action.kind === 'question' ? '待回答' : '待提交工单'}：${action.text}`)
  lines.push(`进行中 ${s.active.length} 项，排队 ${s.queued.length} 项。`)
  for (const c of s.active) lines.push(`- ${c.id}「${c.title}」${stageLabel(c.stage)}（${c.staff}）`)
  // 「自己看历史」「为什么某位幕僚老失败」：列出最近结束的工单，详情用 chief_ticket view 按工单号查，不用逐个猜编号。
  if (s.ended.length) {
    lines.push(`最近结束 ${Math.min(s.ended.length, 8)} 项（详情和各轮执行记录用 chief_ticket（action=view）按工单号查看）：`)
    for (const c of s.ended.slice(0, 8)) {
      const why = c.ended?.note?.split('\n')[0]?.slice(0, 120) || c.latest?.summary?.split('\n')[0]?.slice(0, 120)
      lines.push(`- ${c.id}「${c.title}」${OUTCOME[c.ended?.outcome ?? ''] ?? '已结束'}（${c.staff}）${why ? `：${why}` : ''}`)
    }
  }
  return lines.join('\n')
}

/** dsh-go 工具卡视图（≤ 8 KiB；超出时 toolCard 返回空对象，不影响工具调用）。 */
export function briefCard(s: WarroomState) {
  const children: unknown[] = []
  const decide = s.poc.situation.decide
  if (s.problems.length) children.push({ type: 'callout', tone: 'bad', text: s.problems.slice(0, 2).map(p => p.text).join('\n') })
  children.push({ type: 'text', text: situationText(s.poc.situation) })
  const due = s.poc.ledger.filter(c => c.dueState === 'overdue' || c.dueState === 'today').slice(0, 5)
  if (due.length) children.push({ type: 'list', items: due.map(c => ({ title: c.what.slice(0, 40), subtitle: `${c.direction === 'mine' ? '我答应' : '答应我的是'} ${c.who}`, trailing: c.dueState === 'overdue' ? `逾期 ${-(c.dueIn ?? 0)} 天` : '今天', tone: c.dueState === 'overdue' ? 'bad' : 'warn' })) })
  children.push({ type: 'row', children: [
    { type: 'metric', label: '等你决定', value: decide, tone: decide ? 'warn' : 'good' },
    { type: 'metric', label: '进行中', value: s.active.length, tone: 'info' },
    { type: 'metric', label: '排队', value: s.queued.length },
  ] })
  if (s.roomActions?.length) children.push({ type: 'list', items: s.roomActions.slice(0, 5).map(action => ({ title: action.roomTitle, subtitle: action.text.slice(0, 80), trailing: action.kind === 'question' ? '待回答' : '待提交工单' })) })
  if (s.you.length) children.push({ type: 'list', items: s.you.slice(0, 6).map(c => ({
    title: `${c.id} ${c.title}`, subtitle: (c.latest?.question ?? c.latest?.summary ?? c.scope).split('\n')[0]!.slice(0, 80),
    trailing: stageLabel(c.stage), tone: c.stage === 'you/blocked' ? 'bad' : 'warn',
  })) })
  if (s.active.length) children.push({ type: 'list', items: s.active.slice(0, 6).map(c => ({ title: `${c.id} ${c.title}`, subtitle: c.staff, trailing: stageLabel(c.stage) })) })
  if (!decide && !s.active.length && !s.queued.length) children.push({ type: 'text', tone: 'muted', text: '一切就绪，没有需要你处理的事。' })
  return { type: 'stack', v: 1, title: `作战简报 · 等你决定 ${decide} 项`, children }
}

export function toolCard(build: () => unknown, maxBytes = 8 * 1024): Record<string, unknown> {
  try {
    const text = JSON.stringify(build())
    if (text === undefined || Buffer.byteLength(text, 'utf8') > maxBytes) return {}
    return { 'dsh-go/view': JSON.parse(text) }
  } catch { return {} }
}
