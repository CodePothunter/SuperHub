/**
 * 引擎：事件 → 研判 → 工单 → 派工 → 核验 → 收尾。
 *
 * - 所有状态变更都在 `serial()` 队列里执行（单写者），长时间的执行在队列外异步进行，完成后再排队写回。
 * - 先落盘再执行：派工记录在调用执行者之前写入工单文件；重启时 `recover()` 把未完成的派工标记为中断并重新排队。
 * - 引擎不依赖 DSH：执行者、远程队列、第二大脑都通过下面的端口注入，便于测试和替换。
 */
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { threadBoundaryOf, threadIdOf, type AcceptanceCriterionInput, type Assignment, type ChiefEvent, type CommandApprovalDetail, type CommandApprovalStatus, type Decision, type DeliveryVersion, type ExecutionAttempt, type ExecutionGroup, type ExecutionRef, type Level, type NativeEvidence, type Report, type Staff, type StaleResult, type SuperhubCommission, type SuperhubCommissionIntent, type Ticket, type TicketOutcome, type Verification } from './model.ts'
import { assignmentPrompt, CONTRACT_VERDICT_SCHEMA, DECISION_SCHEMA, triagePrompt, VERDICT_SCHEMA, verifyContractPrompt, verifyPrompt } from './prompts.ts'
import { REPORT_SCHEMA, reportFromRemote, reportFromStructured, reportFromText } from './report.ts'
import { attentionScore, columnOf, latestAssignment, MAX_REVISIONS, ownerHasPendingInput, stageOf, type Stage } from './stage.ts'
import type { Store } from './store.ts'
import { actionList, activeContract, conflict, contractCriteria, ownerText, parseContractVerification, requestHash, unverifiedContract } from './superhub-contract.ts'

// ───────────────────────────── 端口 ─────────────────────────────

export interface RunRequest {
  readonly staff: Staff
  readonly exactExecutor?: boolean
  readonly readOnly?: boolean
  readonly binding?: { ticketId: string; assignmentId: string }
  readonly label: string
  readonly prompt: string
  readonly cwd: string
  /** 只有支持结构化输出的执行者才会收到。 */
  readonly schema?: object
  /** 实际激活后先记录宿主给出的标识，不能把外部工具激活伪装成原生会话。 */
  readonly onStarted?: (execution: ExecutionRef) => Promise<void>
}

/** 新工单讨论入口的显式执行请求。身份、原回复目标与幂等键一起落盘。 */
export interface ThreadReply {
  readonly threadId: string
  readonly ticketId: string
  readonly replyTo: string | null
  readonly requestId: string
  readonly executionBoundary: 'local' | 'remote'
  readonly allowRemote?: boolean
  readonly brainScope?: string
  readonly contractVersion?: number
}

export interface OwnerTarget {
  readonly threadId: string
  readonly replyTo: string | null
  readonly stage?: string
  readonly brainScope?: string
  readonly contractVersion?: number
  readonly deviationReason?: string
}

export interface CommissionSpec {
  readonly text: string
  readonly title: string
  readonly staff: string
  readonly level: Level
  readonly scope: string
  readonly doneWhen: readonly string[]
  readonly needsReview: boolean
  readonly priority?: number
  readonly workspace?: string
  readonly lineId?: string
  readonly remoteBrief?: string
  readonly related?: Ticket['related']
  readonly requestKey?: string
  readonly room?: { readonly id: string; readonly source: string }
  readonly superhub?: SuperhubCommission
}

export interface RunResult {
  readonly text: string
  readonly structured?: unknown
  readonly stopReason: string
  readonly diagnostic?: string
  readonly retrySafe?: boolean
  readonly evidence?: readonly NativeEvidence[]
  /**
   * The executor knows the run stopped for an owner-side reason (for example an expired
   * command approval). The assignment waits for the owner instead of reporting an executor fault.
   */
  readonly blocked?: string
}

export interface Executors {
  /** 该执行者当前是否可用（例如 Claude Code 子代理是否已安装）。 */
  available(executor: string, exact?: boolean): boolean
  supportsSchema(executor: string): boolean
  run(request: RunRequest, signal: AbortSignal): Promise<RunResult>
}

export interface RemoteTask {
  readonly ticketId: string
  readonly assignmentId: string
  readonly title: string
  readonly kind?: 'discussion'
  readonly prompt: string
}

export interface RemoteQueue {
  /** 本机暂存原始任务；工单落盘前不得让工作端领取。 */
  prepare?(task: RemoteTask): void
  /** 仅恢复本机已有的暂存任务，不从工单现状重新拼接跨域内容。 */
  resume?(ticketId: string, assignmentId: string): void
  dispatch(task: RemoteTask): void
  cancel(assignmentId: string): void
}

export interface Brain {
  readonly root: string
  /** AGENTS.md 与 goals.md 的节选，供研判使用。 */
  constitution(): string
  staff(): Staff[]
  workspaces(): string[]
  /** 工单的工作目录（brain/work/T-xxxx），不存在则创建。 */
  workdir(ticketId: string): string
  /** 向 journal/ 下的文件追加内容，返回相对路径；路径不在 journal/ 下则抛错。 */
  appendNote(path: string, content: string): string
  /** 提交 brain 仓库的改动（异步、合并）。缺省只提交幕僚可写的目录；`all` 时提交全部（执行已批准的提案）。 */
  commit(message: string, options?: { all?: boolean }): void
  /** 把工作电脑的回传原样存进工单目录，返回相对路径。 */
  snapshotOutputs?(ticketId: string, outputs: readonly string[]): DeliveryVersion[]
  /** Verify the registered archive and current artifact version. Return the exact reviewed bytes as text. */
  deliveryEvidence?(ticketId: string, delivery: DeliveryVersion): string | undefined
  saveRemoteReport?(ticketId: string, round: number, content: string): string
  /** 受保护文件（宪法、目标、角色卡、规则、长期知识）中尚未提交的改动。 */
  protectedChanges?(): Promise<string[]>
}

export interface EngineOptions {
  readonly concurrency: number
  readonly timeZone: string
  readonly brainScope?: string
  readonly canStartSuperhub?: (authorization: Pick<SuperhubCommission, 'brainScope' | 'sourceId' | 'commandId'>) => boolean
  /** Recheck scope-specific input versions at the owner acceptance boundary. */
  readonly checkSuperhubAcceptance?: (ticket: Ticket, assignment: Assignment) => string | undefined
  /** 单次研判 / 执行 / 核验 / 工作电脑任务的超时（毫秒），缺省 10 分钟 / 60 分钟 / 20 分钟 / 24 小时。 */
  readonly timeouts?: { triage?: number; execute?: number; verify?: number; remote?: number }
  readonly now?: () => Date
  readonly log?: (message: string) => void
  /** 工单结束后调用（在状态写盘之后）。用于部署界面修改等后续动作；不能抛错。 */
  readonly onEnded?: (ticket: Ticket) => void
}

// ───────────────────────────── 视图 ─────────────────────────────

export interface TicketView {
  readonly ticket: Ticket
  readonly stage: Stage
  readonly column: ReturnType<typeof columnOf>
  readonly attention: number
}

export interface Problem { readonly at: string; readonly text: string }

interface AttemptContext { readonly ticket: Ticket; readonly assignment: Assignment; readonly kind: ExecutionAttempt['kind'] }

// ───────────────────────────── 引擎 ─────────────────────────────

/** An owner-side stop: the known cause first, then what the owner can do, then native details for diagnosis. */
function blockedSummary(cause: string, diagnostic?: string): string {
  const detail = diagnostic?.trim() ? `\n执行器记录：${diagnostic.trim().slice(0, 1200)}` : ''
  return `${cause.replace(/[。.]$/, '')}。工作未完成，需要你处理后重试本工单。${detail}`
}

const TRANSIENT = /\b(408|429|5\d\d)\b|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|rate.?limit|overloaded/i
const TRIAGE_STAFF = 'chief'
const DEFAULT_VERIFIER = 'reviewer'
const MAX_TRIAGE_FAILURES = 3
const REMOTE_CHILD_STANDARD = '回传汇报明确回答本任务，并列明证据、限制及工作产物位置'
const localLead = (ticket: Pick<Ticket, 'lineId' | 'parent' | 'related'>) => !!ticket.related?.discussionId || (!!ticket.lineId && !ticket.parent)

export class Engine {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly activity = new Map<string, 'executing' | 'verifying'>()
  private readonly controllers = new Map<string, AbortController>()
  private triaging: string | undefined
  private readonly triageFailures = new Map<string, number>()
  /** 研判失败后的冷却截止时间，避免对同一事件空转。 */
  private triageHoldUntil = 0
  private passScheduled = false
  private stopped = false
  private paused = false
  readonly problems: Problem[] = []

  constructor(
    private readonly store: Store,
    private readonly brain: Brain,
    private readonly executors: Executors,
    private readonly remote: RemoteQueue,
    private readonly options: EngineOptions,
  ) {}

  private now() { return (this.options.now ?? (() => new Date()))() }
  private iso() { return this.now().toISOString() }
  private log(message: string) { this.options.log?.(message) }

  /** 引擎以外的部分（例如接口人的工具限制）报一个需要主人看到的问题，显示在作战台顶部。 */
  report(text: string) { if (!this.problems.some(p => p.text === text)) this.problem(text) }

  private problem(text: string) {
    this.problems.unshift({ at: this.iso(), text })
    this.problems.length = Math.min(this.problems.length, 20)
    this.log(text)
  }

  /** 串行执行一段状态变更。 */
  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  // ─────────── 生命周期 ───────────

  /** 启动：把重启前仍在执行的本地派工标记为中断，重新排队。 */
  recover(): Promise<void> {
    return this.serial(() => {
      // 开单后、写去向前崩溃：事件已在某张工单里，补写去向，避免重复开单。
      const owned = new Map(this.store.tickets().flatMap(t => t.events.map(id => [id, t.id] as const)))
      for (const event of this.store.pendingEvents()) {
        const ticketId = owned.get(event.id)
        if (ticketId) this.store.setDisposition(event.id, { kind: 'accepted', ticketId })
        else if (event.superhubCommission?.brainScope === this.options.brainScope && event.superhubCommission) this.openSuperhubTicket(event, event.superhubCommission)
      }
      for (const ticket of this.store.tickets()) {
        if (!ticket.ended && ticket.parent && this.store.ticket(ticket.parent.ticketId)?.ended?.outcome === 'stopped') {
          this.cancelTicket(ticket, `父工单 ${ticket.parent.ticketId} 已停止`)
          continue
        }
        const last = latestAssignment(ticket)
        if (ticket.ended || !last || this.activity.has(last.id)) continue
        const interrupted = last.attempts?.filter(attempt => attempt.status === 'running') ?? []
        for (const attempt of interrupted) { attempt.status = 'interrupted'; attempt.endedAt = this.iso() }
        if (interrupted.length) this.store.saveTicket(ticket)
        if (last.state === 'running' && last.executor !== 'remote') {
          last.state = 'interrupted'
          last.endedAt = this.iso()
          ticket.inputs.push({ at: this.iso(), from: 'system', text: '上一次执行因宿主重启被中断。先检查工作目录里已有的产出，再继续，不要重复已完成的外部动作。' })
          this.store.saveTicket(ticket)
        } else if (last.state === 'running' && last.executor === 'remote') {
          if (this.requiresLocalExecution(ticket)) { this.remote.cancel(last.id); this.blockRemoteAssignment(ticket, last) }
          else this.remote.resume?.(ticket.id, last.id)
        } else if (last.state === 'reported' && last.report?.status === 'ready' && !last.verification) {
          // 重启时正在核验：重新核验。
          if (this.canStartScoped(ticket)) this.afterReport(ticket, last)
        } else if (last.state === 'reported' && last.verification?.verdict === 'pass') {
          // 核验已落盘、自动结单前崩溃：补完收尾，才能可靠唤醒父工单。
          this.completeVerified(ticket, last)
        }
      }
      this.reconcileChildren()
      this.kick()
    })
  }

  stop(): void {
    this.stopped = true
    for (const controller of this.controllers.values()) controller.abort()
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (!paused) this.kick()
  }

  isPaused() { return this.paused }

  // ─────────── 来源入口 ───────────

  /** 接收一条事件。返回 false 表示重复（同一 dedupe 键已存在）。 */
  receive(input: Omit<ChiefEvent, 'id' | 'at' | 'superhubCommission'> & { id?: string; at?: string; observe?: boolean }): Promise<boolean> {
    return this.serial(() => {
      const { observe, ...rest } = input
      const event: ChiefEvent = { ...rest, id: rest.id ?? randomUUID(), at: rest.at ?? this.iso(), superhubCommission: undefined }
      const ticket = event.ticketId ? this.store.ticket(event.ticketId) : undefined
      if (ticket?.superhub) conflict('请在原工单中核对派工和契约版本后补充输入')
      const prior = this.store.event(event.id)
      if (prior && prior.dedupe !== event.dedupe) throw new Error('事件标识已存在，不能替换原始事件')
      if (!this.store.appendEvent(event)) return false
      if (ticket) {
        this.attachEvent(ticket, event, event.source === 'inbox' ? 'owner' : 'system')
        this.store.setDisposition(event.id, { kind: 'attached', ticketId: ticket.id })
      } else {
        // 观察模式的来源：只留痕，不研判，等主人放行。
        this.store.setDisposition(event.id, { kind: observe ? 'observed' : 'pending' })
      }
      this.kick()
      return true
    })
  }

  /** 远程执行者回传汇报。 */
  remoteReport(ticketId: string, assignmentId: string, payload: unknown): Promise<boolean> {
    return this.serial(() => {
      const ticket = this.store.ticket(ticketId)
      const assignment = ticket?.assignments.find(a => a.id === assignmentId)
      if (!ticket || !assignment || assignment.executor !== 'remote') return false
      const receipt = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      if (assignment.receipt) {
        if (assignment.receipt !== receipt) return false
        this.store.saveTicket(ticket)
        if (!ticket.ended && assignment.report?.status === 'ready' && !assignment.verification && !this.activity.has(assignment.id)) this.afterReport(ticket, assignment)
        return true
      }
      if (!this.currentAssignment(ticket, assignment) || assignment.state !== 'running') {
        this.recordStale(ticket, assignment, 'remote', receipt)
        return false
      }
      const report = reportFromRemote(payload)
      // The original payload identifies the transport receipt. Only the report projection enters the work record.
      const archive = JSON.stringify(report, null, 2)
      const file = this.brain.saveRemoteReport?.(ticket.id, assignment.round, archive)
      assignment.receipt = receipt
      this.finishAssignment(ticket, assignment, { ...report, ...(file ? { outputs: [file] } : {}) }, archive)
      const event: ChiefEvent = { id: randomUUID(), at: this.iso(), source: 'remote', dedupe: `remote:${assignmentId}`, text: report.summary, ticketId }
      if (this.store.appendEvent(event)) {
        ticket.events.push(event.id)
        this.store.setDisposition(event.id, { kind: 'attached', ticketId })
        this.store.saveTicket(ticket)
      }
      this.afterReport(ticket, assignment)
      return true
    })
  }

  // ─────────── 主人的动作 ───────────

  approve(ticketId: string, target?: OwnerTarget): Promise<void> {
    return this.ownerAction(ticketId, ticket => {
      if (stageOf(ticket, this.activity) !== 'you/approve') throw new Error('这张工单不在等待批准')
      if (!this.canStartScoped(ticket)) conflict('原交办已暂停或更正，请刷新交办回执')
      if (ticket.requestedExecutor && !target) throw Error('请在作战室打开工单核对原话与执行器后批准')
      const problem = this.requestedExecutorProblem(ticket)
      if (problem) throw Error(problem)
      ticket.approvedAt = this.iso()
    }, target)
  }

  /** 回答问题、补充信息或要求返工：都是一条主人输入。 */
  reply(ticketId: string, text: string, target?: ThreadReply | OwnerTarget): Promise<void> {
    return this.ownerAction(ticketId, ticket => {
      if (!text.trim()) throw new Error('回复不能为空')
      if (target && 'requestId' in target) {
        const conflict = (message: string): never => { throw Object.assign(new Error(message), { status: 409 }) }
        if (target.ticketId !== ticket.id || target.threadId !== threadIdOf(ticket)) conflict('工单讨论已切换，请回到原工单核对后再执行')
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(target.requestId)) throw new Error('缺少稳定的请求标识')
        const key = `reply:${target.requestId}`
        const prior = ticket.inputs.find(input => input.key === key)
        // HTTP 确认丢失时，派工可能已经推进甚至结单；原请求只能确认一次，不能再次执行。
        if (prior) {
          if (prior.from !== 'owner' || prior.text !== text.trim() || prior.replyTo !== target.replyTo
            || (ticket.superhub && (target.brainScope !== ticket.superhub.brainScope || target.brainScope !== this.options.brainScope
              || prior.contractVersion !== target.contractVersion))) conflict('同一个请求标识不能替换回复内容或派工目标')
          return false
        }
        this.checkContractTarget(ticket, target)
        if (!this.canStartScoped(ticket)) conflict('原交办已暂停或更正，请刷新交办回执')
        if (ticket.ended) conflict('这张工单已结束，讨论仅供查看；新工作请另行明确交办')
        if (target.replyTo !== (latestAssignment(ticket)?.id ?? null)) conflict('派工已更新，请核对当前派工后重新确认执行')
        const staff = this.findStaff(ticket.staff)
        const boundary = threadBoundaryOf(ticket, staff?.executor)
        if (target.executionBoundary !== boundary || (staff && (staff.executor === 'remote' ? 'remote' : 'local') !== boundary)) conflict('执行位置已变更，请核对负责人及本地／工作电脑授权后重新交办')
        if (boundary === 'remote' && !target.allowRemote) throw new Error('请先核对并明确同意将这段回复发给工作电脑')
        // 只在新讨论入口锁定主人看到的位置，不改变旧直接交办流程的行为。
        ticket.executionBoundary = boundary
        ticket.inputs.push({ key, at: this.iso(), from: 'owner', text: text.trim(), replyTo: target.replyTo, ...ticket.superhub ? { contractVersion: target.contractVersion } : {} })
        this.invalidateVerification(ticket, '主人补充了需要处理的输入')
        return
      }
      if (ticket.superhub && (ticket.ended || !this.canStartScoped(ticket))) conflict('此工单已结束或交办已更正，请另行明确交办')
      ticket.inputs.push({ at: this.iso(), from: 'owner', text: text.trim(), ...ticket.superhub ? { replyTo: target?.replyTo, contractVersion: target?.contractVersion } : {} })
      this.invalidateVerification(ticket, '主人补充了需要处理的输入')
      if (ticket.ended) delete ticket.ended
    }, target, !!target && 'requestId' in target)
  }

  /** 验收通过。`applyProposal` 时为提案开一张执行工单（DESIGN.md 第 5 节：记忆只经提案进入）。 */
  accept(ticketId: string, applyProposal = false, target?: OwnerTarget): Promise<void> {
    return this.ownerAction(ticketId, ticket => {
      if (stageOf(ticket, this.activity) !== 'you/review') throw new Error('这张工单不在等待验收')
      const contract = activeContract(ticket)
      if (ticket.superhub && contract) {
        if (!this.canStartScoped(ticket)) conflict('原交办已暂停或更正，请核对当前授权')
        const assignment = latestAssignment(ticket)
        if (!assignment || assignment.report?.status !== 'ready' || assignment.contractVersion !== contract.version
          || ownerHasPendingInput(ticket) || ticket.waitingFor?.length || this.unresolvedScopedChild(ticket)) conflict('当前工单仍有待处理的输入、派工或依赖')
        const reason = target?.deviationReason === undefined ? undefined : ownerText(target.deviationReason, '偏差原因', 2000)
        if (!reason) {
          if (!this.scopedVerificationValid(ticket, assignment)) conflict('仍有必要标准未核实或证据已变化，须返工、补证或明确接受偏差')
          const failure = this.options.checkSuperhubAcceptance?.(ticket, assignment)
          if (failure) {
            this.invalidateVerification(ticket, failure)
            this.store.saveTicket(ticket)
            conflict(failure)
          }
        }
        if (applyProposal && reason) conflict('接受偏差后需另行明确交办提案的执行')
        if (applyProposal && !this.scopedProposalVerified(ticket, assignment)) conflict('仅可执行已核验且版本仍有效的正式提案')
        ticket.superhub.ownerAcceptance = { at: this.iso(), assignmentId: assignment.id, contractVersion: contract.version, kind: reason ? 'deviation' : 'accepted', ...reason ? { reason } : {} }
      }
      this.end(ticket, 'done', ticket.superhub?.ownerAcceptance?.kind === 'deviation' ? '主人明确接受验收偏差' : '主人验收通过')
      if (applyProposal) this.openApplyTicket(ticket)
    }, target)
  }

  /** 已经验收结案、但当时没有执行提案的工单：补执行。同一份提案只执行一次。 */
  applyProposal(ticketId: string, target?: OwnerTarget): Promise<void> {
    return this.ownerAction(ticketId, ticket => {
      if (ticket.ended?.outcome !== 'done' || this.isApplyTicket(ticket)) throw new Error('只有已经验收的工单才能执行它的提案')
      const last = latestAssignment(ticket)
      if (ticket.superhub && (!last || ticket.superhub.ownerAcceptance?.kind !== 'accepted' || !this.canStartScoped(ticket)
        || !this.scopedVerificationValid(ticket, last) || !this.scopedProposalVerified(ticket, last))) conflict('须有当前授权版本的主人验收和仍有效的提案证据')
      if (!this.openApplyTicket(ticket)) throw new Error('这份提案已经交去执行过了')
    }, target)
  }

  stopTicket(ticketId: string, reason: string, target?: OwnerTarget): Promise<void> {
    return this.ownerAction(ticketId, ticket => {
      if (ticket.superhub && ticket.ended) {
        if (ticket.ended.outcome === 'stopped') return false
        conflict('工单已结束，停止新派工需要另行交办')
      }
      this.cancelTicket(ticket, reason || '主人停止')
      for (const child of this.store.tickets().filter(t => t.parent?.ticketId === ticket.id && !t.ended)) {
        this.cancelTicket(child, `父工单 ${ticket.id} 已停止`)
      }
    }, target)
  }

  private cancelTicket(ticket: Ticket, reason: string): void {
    const last = latestAssignment(ticket)
    if (last) this.controllers.get(last.id)?.abort()
    if (last?.state === 'running') {
      if (last.executor === 'remote') this.remote.cancel(last.id)
      last.state = 'cancelled'
      last.endedAt = this.iso()
    }
    this.end(ticket, 'stopped', reason)
  }

  /** 重试：在 blocked / failed 状态下重新派工。 */
  retry(ticketId: string, target?: OwnerTarget): Promise<void> {
    return this.ownerAction(ticketId, ticket => {
      if (stageOf(ticket, this.activity) !== 'you/blocked') throw new Error('只有受阻的工单可以重试')
      if (!this.canStartScoped(ticket)) conflict('原交办已暂停或更正，请刷新交办回执')
      this.invalidateVerification(ticket, '主人请求重试')
      ticket.inputs.push({ at: this.iso(), from: 'owner', text: '请重试。' })
    }, target)
  }

  reviseContract(ticketId: string, criteria: readonly AcceptanceCriterionInput[], reason: string, target: OwnerTarget): Promise<void> {
    return this.ownerAction(ticketId, ticket => {
      const current = activeContract(ticket)
      if (!ticket.superhub || !current) throw Error('此工单没有版本化验收契约')
      if (ticket.ended || !this.canStartScoped(ticket)) conflict('当前工单已结束或交办已更正')
      const stage = stageOf(ticket, this.activity), last = latestAssignment(ticket)
      if (stage === 'working' || stage === 'remote' || stage === 'verifying' || stage === 'waiting') conflict('请等当前执行、核验和依赖结束后修改标准')
      const revised = contractCriteria(criteria, current)
      const explained = ownerText(reason, '契约修改原因', 2000)
      if (requestHash(revised) === requestHash(current.criteria)) return false
      const version = current.version + 1
      this.invalidateVerification(ticket, '验收契约已更新')
      ticket.superhub.contracts.push({
        ...current, version, criteria: revised, reason: explained, createdAt: this.iso(),
        approvedBy: { threadId: target.threadId, assignmentId: last?.id ?? null },
      })
      // Old proposal approval is for the earlier contract. Preserve the prior scope, request renewed approval.
      if (ticket.mandate.level === 'propose' || ticket.superhub.approvalRequired) delete ticket.approvedAt
      ticket.inputs.push({ key: `contract:${version}`, from: 'owner', at: this.iso(), replyTo: last?.id ?? null, contractVersion: version, text: `主人已将验收契约更新为 v${version}。原因：${explained}` })
    }, target)
  }

  planExecution(ticketId: string, groups: ExecutionGroup[], checkpoint: string, target: OwnerTarget): Promise<void> {
    return this.ownerAction(ticketId, ticket => {
      const assignment = latestAssignment(ticket)
      if (!this.canStartScoped(ticket)) conflict('原交办已暂停或更正，请刷新交办回执')
      if (ticket.executionPlan) {
        if (JSON.stringify(ticket.executionPlan.groups) === JSON.stringify(groups) && ticket.executionPlan.checkpoint === checkpoint) return false
        throw Error('这张工单已经保存分组计划，请从对应分组工单继续')
      }
      if (ticket.parent || this.store.tickets().some(child => child.parent?.ticketId === ticket.id) || !assignment
        || stageOf(ticket, this.activity) !== 'you/blocked' || !['think', 'propose'].includes(ticket.mandate.level)
        || assignment.executor !== 'codex' || this.findStaff(ticket.staff)?.executor !== 'codex' || !this.executors.available('codex', true)) {
        throw Error('只有本机受阻且执行器可用的 Codex 工作工单可以分组续跑')
      }
      if (!Array.isArray(groups) || groups.length < 1 || groups.length > 12 || !checkpoint.trim() || checkpoint.length > 6000
        || groups.some(g => !/^[A-Za-z0-9_-]{1,24}$/.test(g.key) || !g.title.trim() || g.title.length > 100 || !g.scope.trim() || g.scope.length > 9000)
        || new Set(groups.map(g => g.key)).size !== groups.length) throw Error('分组须有唯一标识、标题、执行范围和已有进度')
      ticket.executionPlan = { assignmentId: assignment.id, groups, checkpoint }
      ticket.inputs.push({ key: `execution-plan:${assignment.id}`, at: this.iso(), from: 'owner', text: `分组续跑已确认。已有进度：${checkpoint}\n本工单在分组通过核验后只汇总结果。按原交付要求整合产物、补齐时序和证据索引，沿用已保存的结果，不重新执行查询或派工。` })
    }, target)
  }

  recordCommandApproval(binding: { ticketId: string; assignmentId: string }, id: string, status: CommandApprovalStatus, detail: CommandApprovalDetail = {}): Promise<void> {
    return this.serial(() => {
      const ticket = this.store.ticket(binding.ticketId)
      const assignment = ticket && latestAssignment(ticket)
      if (!ticket || !assignment || assignment.id !== binding.assignmentId) return
      const records = assignment.commandApprovals ??= []
      if (records.some(row => row.id === id && row.status === status)) return
      const command = typeof detail.command === 'string' && detail.command.trim() ? detail.command.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined
      const minutes = Number.isSafeInteger(detail.timeoutMinutes) && detail.timeoutMinutes! > 0 ? detail.timeoutMinutes : undefined
      records.push({ id, at: this.iso(), status, ...command ? { command } : {}, ...minutes ? { timeoutMinutes: minutes } : {} })
      this.store.saveTicket(ticket)
    })
  }

  /** 把一条事件交给研判：研判失败的重试，或者放行一条只记录的事件。 */
  retriage(eventId: string): Promise<void> {
    return this.serial(() => {
      const kind = this.store.disposition(eventId)?.kind
      if (kind !== 'unavailable' && kind !== 'observed') throw new Error('这条事件不需要研判')
      this.triageFailures.delete(eventId)
      this.store.setDisposition(eventId, { kind: 'pending' })
      this.kick()
    })
  }

  /**
   * 主人直接交办：不经研判，按给定的幕僚、授权和完成标准开单。接口人在主人明确要求时使用。
   * 仍然留下一条事件和去向，事件流里看得到。
   */
  commission(spec: CommissionSpec): Promise<string> {
    return this.serial(() => {
      if (spec.superhub) return this.commissionSuperhub(spec, spec.superhub)
      const reason = spec.room ? '讨论移交，等待主人批准' : '主人直接交办'
      if (spec.requestKey) {
        const prior = this.store.tickets().find(t => this.store.event(t.mandate.eventId)?.dedupe === spec.requestKey)
        if (prior) {
          const eventId = prior.mandate.eventId
          const state = this.store.disposition(eventId)
          if (!state || state.kind === 'pending') {
            this.store.setDisposition(eventId, { kind: 'accepted', ticketId: prior.id, reason })
            this.kick()
          }
          return prior.id
        }
      }
      const staffId = spec.staff.trim(), staff = this.findStaff(staffId)
      if (!staff) throw new Error(`没有这位幕僚：${staffId}`)
      if (spec.room && (spec.level !== 'propose' || staff.executor === 'remote')) throw Error('讨论移交需要本地执行者和主人审批')
      if (localLead(spec) && staff.executor === 'remote') throw new Error('请选择本地负责人，关联横向线与阅读讨论的跟进仅在中心处理；工作端任务须单独明确交办')
      if (!spec.doneWhen.length) throw new Error('需要至少一条完成标准')
      const workspace = spec.level === 'write' ? spec.workspace : undefined
      if (spec.level === 'write' && (!workspace || !this.brain.workspaces().includes(workspace))) throw new Error('改文件的工单需要指定一个允许的工作区（rules.yaml 的 workspaces）')
      // A process may have saved the keyed commission event before saving its ticket.
      const pending = spec.requestKey && this.store.hasDedupe(spec.requestKey) ? this.store.pendingEvents().find(event =>
        event.dedupe === spec.requestKey && event.source === 'inbox' && event.meta?.staff === staffId && event.text === spec.text) : undefined
      const id = pending?.id ?? (spec.room && spec.requestKey ? `room-${createHash('sha256').update(spec.requestKey).digest('hex')}` : randomUUID())
      if (this.store.event(id)?.meta?.retired_ticket) conflict('这张工单已不可用。')
      const event: ChiefEvent = { id, at: this.iso(), source: 'inbox', dedupe: spec.requestKey ?? `commission:${id}`, text: spec.text, meta: { channel: spec.room ? 'room-review' : 'liaison', staff: staffId, ...(spec.room ? { room_id: spec.room.id, room_source: spec.room.source } : {}) } }
      if (!this.store.event(id) && !this.store.appendEvent(event)) throw Error('该交办标识已使用，请查看已有记录')
      const ticket = this.openTicket({
        title: spec.title, staff: staffId, priority: spec.priority ?? 2, workspace, lineId: spec.lineId, related: spec.related, remoteBrief: spec.remoteBrief?.trim().slice(0, 6000),
        ...(spec.room ? { requestedExecutor: staff.executor, executionBoundary: 'local' as const } : {}),
        mandate: { strength: 'explicit', level: spec.level, scope: spec.scope, doneWhen: spec.doneWhen, needsReview: spec.needsReview, eventId: id },
      }, id)
      this.store.setDisposition(id, { kind: 'accepted', ticketId: ticket.id, reason })
      this.kick()
      return ticket.id
    })
  }

  private commissionSuperhub(spec: CommissionSpec, auth: SuperhubCommission): string {
    const brainScope = ownerText(auth.brainScope, '第二大脑标识', 256)
    if (brainScope !== this.options.brainScope) conflict('第二大脑已切换，请回到原空间核对交办')
    const sourceId = ownerText(auth.sourceId, '来源标识', 256)
    const commandId = ownerText(auth.commandId, '交办标识', 256)
    const requestKey = spec.requestKey === undefined ? undefined : ownerText(spec.requestKey, '请求标识', 512)
    const id = `superhub-${requestHash([brainScope, commandId])}`
    ownerText(spec.text, '交办原文', 40000)
    const text = spec.text
    const staffId = ownerText(spec.staff, '负责人', 100)
    const title = ownerText(spec.title, '工单标题', 500)
    const scope = ownerText(spec.scope, '执行范围', 9000)
    if (spec.level !== 'think' && spec.level !== 'write' && spec.level !== 'propose') throw Error('未知授权级别')
    if (spec.remoteBrief) throw Error('此交办仅限本地执行；工作电脑任务须另行明确交办')
    const workspace = spec.level === 'write' ? spec.workspace : undefined
    const allowed = actionList(auth.allowed), denied = actionList(auth.denied)
    if (allowed.some(action => denied.includes(action))) throw Error('同一动作不能同时允许和禁止')
    const criteria = contractCriteria(auth.criteria ?? spec.doneWhen.map(text => ({ text })))
    const related = spec.related && {
      ticketId: spec.related.ticketId, discussionId: spec.related.discussionId, path: spec.related.path, version: spec.related.version,
    }
    const intent: SuperhubCommissionIntent = {
      brainScope, sourceId, commandId, requestKey, title, staff: staffId, level: spec.level,
      workspace, lineId: spec.lineId, related,
      priority: spec.priority === undefined ? 2 : Math.min(3, Math.max(0, Math.round(spec.priority))),
      contract: { staff: staffId, scope, criteria, allowed, denied, needsReview: spec.needsReview === true },
      ...auth.approvalRequired === true ? { approvalRequired: true as const } : {},
    }
    if (!Number.isFinite(intent.priority)) throw Error('优先级无效')
    const prior = this.store.event(id)
    if (prior) {
      const room = prior.meta?.room_id
      if (!prior.superhubCommission || prior.text !== text || requestHash(prior.superhubCommission) !== requestHash(intent) || room !== spec.room?.id
        || prior.meta?.room_source !== spec.room?.source) conflict('同一交办标识已用于不同来源、授权或完成标准')
      return this.openSuperhubTicket(prior, intent)
    }
    const staff = this.findStaff(staffId)
    if (!staff) throw Error(`没有这位幕僚：${staffId}`)
    if (staff.executor === 'remote') throw Error('此交办仅限本地执行；工作电脑任务须另行明确交办')
    if (spec.room && intent.level !== 'propose') throw Error('讨论移交需要主人审批')
    if (intent.level === 'write' && (!workspace || !this.brain.workspaces().includes(workspace))) throw Error('改文件的工单需要指定已允许的工作区')
    const event: ChiefEvent = {
      id, at: this.iso(), source: 'inbox', dedupe: `superhub:${requestHash([brainScope, requestKey ?? commandId])}`, text,
      meta: { channel: spec.room ? 'room-review' : 'superhub', staff: staffId, executor: staff.executor, verifier: staff.verifier,
        ...spec.room ? { room_id: spec.room.id, room_source: spec.room.source } : {} },
      superhubCommission: intent,
    }
    if (!this.store.appendEvent(event)) conflict('该交办请求标识已使用，请查看已有记录')
    return this.openSuperhubTicket(event, intent)
  }

  private openSuperhubTicket(event: ChiefEvent, intent: SuperhubCommissionIntent): string {
    const { brainScope, sourceId, commandId, contract } = intent
    const prior = this.store.tickets().find(ticket => ticket.mandate.eventId === event.id)
    const ticket = prior ?? this.openTicket({
      title: intent.title, staff: intent.staff, priority: intent.priority, workspace: intent.workspace, lineId: intent.lineId, related: intent.related,
      executionBoundary: 'local', requestedExecutor: event.meta?.executor,
      superhub: { brainScope, sourceId, commandId, ...intent.approvalRequired ? { approvalRequired: true as const } : {}, contracts: [{ ...contract, verifier: event.meta?.verifier, version: 1, createdAt: event.at }] },
      mandate: {
        strength: 'explicit', level: intent.level, scope: contract.scope, doneWhen: contract.criteria.map(row => row.text), needsReview: contract.needsReview, eventId: event.id,
      },
    }, event.id)
    if (this.store.disposition(event.id)?.kind !== 'accepted') {
      this.store.setDisposition(event.id, { kind: 'accepted', ticketId: ticket.id, reason: event.meta?.room_id ? '讨论移交，等待主人批准' : '主人直接交办' })
    }
    this.kick()
    return ticket.id
  }

  setRemoteBrief(ticketId: string, text: string, target?: OwnerTarget): Promise<void> {
    return this.ownerAction(ticketId, ticket => {
      if (ticket.superhub) conflict('此交办已锁定为本地执行。工作端任务须另行明确交办')
      ticket.remoteBrief = text.trim().slice(0, 6000)
    }, target)
  }

  /** 只有适配器绑定的在执行实例可调用；模型不能自报父工单或授权。 */
  delegate(binding: { ticketId: string; assignmentId: string }, spec: { key: string; staff: string; text: string; criterion: number; needsReview?: boolean }): Promise<string> {
    return this.serial(() => {
      const parent = this.store.ticket(binding.ticketId)
      const assignment = parent && latestAssignment(parent)
      if (!parent || !assignment || !this.currentAssignment(parent, assignment) || assignment.id !== binding.assignmentId || assignment.state !== 'running' || assignment.executor === 'remote') throw new Error('委派能力已经过期')
      if (parent.parent) throw new Error('子任务不能再递归委派')
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.key)) throw new Error('需要稳定的委派 key')
      const contract = activeContract(parent)
      if (contract && (!contract.allowed.includes('delegate') || contract.denied.includes('delegate'))) conflict('此工单没有委派授权')
      const children = this.store.tickets().filter(t => t.parent?.ticketId === parent.id)
      const existing = children.find(t => t.parent?.key === spec.key)
      if (!contract) {
        const prior = existing ?? children.find(t => t.staff === spec.staff && t.parent?.criterion === spec.criterion)
        if (prior) return prior.id
      }
      const criterion = contract?.criteria[spec.criterion]
      const standard = contract ? criterion?.text : parent.mandate.doneWhen[spec.criterion]
      if (!Number.isInteger(spec.criterion) || !standard) throw new Error('必须关联原工单的一条完成标准')
      const staff = this.findStaff(spec.staff)
      if (!staff || staff.id === parent.staff || staff.id === TRIAGE_STAFF) throw new Error('请选择其他执行幕僚')
      if (contract && staff.executor === 'remote') conflict('此工单的授权仅限本地执行')
      const text = (staff.executor === 'remote' ? parent.remoteBrief ?? '' : spec.text).trim().slice(0, 6000)
      if (!text) throw new Error('子任务内容不能为空')
      const childScope = contract ? `在父工单授权范围「${contract.scope}」内：${text}` : text
      if (existing) {
        if (contract && (existing.parent?.contractVersion !== contract.version || existing.parent.criterionId !== criterion?.id
          || existing.staff !== staff.id || existing.mandate.scope !== childScope)) conflict('同一委派标识已用于其他内容或契约版本')
        return existing.id
      }
      const sameCriterion = contract && children.find(t => t.staff === staff.id
        && t.parent?.criterionId === criterion?.id && t.parent?.contractVersion === contract.version)
      if (sameCriterion) return sameCriterion.id
      // 跨域请求只能使用主人在原交办里明确列出的工作端任务，不把私人上下文交给模型自由摘录转发。
      if (staff.executor === 'remote' && !parent.remoteBrief) throw new Error('主人尚未填写给工作端的任务说明，请在原工单中填写后继续；不得摘录私人上下文')
      const eventId = randomUUID()
      const superhub = contract && criterion ? this.childContract(parent, staff, childScope, [criterion], spec.needsReview === true) : undefined
      const child = this.openTicket({
        title: `${parent.id}：${text.slice(0, 32)}`, staff: staff.id, priority: parent.priority, workspace: undefined, lineId: parent.lineId,
        executionBoundary: staff.executor === 'remote' ? 'remote' : 'local',
        ...superhub ? { superhub, requestedExecutor: staff.executor } : {},
        parent: { ticketId: parent.id, assignmentId: assignment.id, key: spec.key, criterion: spec.criterion, criterionText: standard,
          ...criterion && contract ? { criterionId: criterion.id, contractVersion: contract.version } : {} },
        mandate: { ...parent.mandate, level: 'think', scope: childScope, doneWhen: [staff.executor === 'remote' ? REMOTE_CHILD_STANDARD : standard], needsReview: spec.needsReview === true, eventId },
      }, eventId)
      parent.waitingFor = [...new Set([...(parent.waitingFor ?? []), child.id])]
      this.store.saveTicket(parent)
      const event: ChiefEvent = { id: eventId, at: this.iso(), source: 'system', dedupe: `delegate:${parent.id}:${spec.key}`, text, meta: { parent: parent.id } }
      this.store.appendEvent(event)
      this.store.setDisposition(eventId, { kind: 'accepted', ticketId: child.id })
      this.kick()
      return child.id
    })
  }

  private childContract(parent: Ticket, staff: Staff, scope: string, criteria: readonly AcceptanceCriterionInput[], needsReview: boolean): Ticket['superhub'] {
    const contract = activeContract(parent)
    if (!parent.superhub || !contract) return undefined
    const { brainScope, sourceId, commandId } = parent.superhub
    return { brainScope, sourceId, commandId, contracts: [{
      version: 1, createdAt: this.iso(), scope, staff: staff.id, verifier: staff.verifier, needsReview,
      criteria: contractCriteria(criteria.map(row => ({ ...row, required: true }))),
      allowed: contract.allowed.filter(action => action !== 'delegate'), denied: contract.denied,
    }] }
  }

  /** 子任务结果先写父输入再确认已唤醒，故重启/重复回传不会双重推进。 */
  private reconcileChildren(): void {
    const all = this.store.tickets()
    const groups = new Map<string, Ticket[]>()
    for (const child of all) if (child.parent) groups.set(child.parent.ticketId, [...(groups.get(child.parent.ticketId) ?? []), child])
    for (const parent of all) {
      if (parent.ended || !parent.executionPlan || !this.canStartScoped(parent)) continue
      const children = groups.get(parent.id) ?? []
      const contract = activeContract(parent), staff = this.findStaff(parent.staff)
      for (const [criterion, group] of parent.executionPlan.groups.entries()) {
        const key = `plan-${group.key}`
        if (children.some(child => child.parent?.key === key)) continue
        const id = `plan-${createHash('sha256').update(`${parent.id}:${parent.executionPlan.assignmentId}:${key}`).digest('hex')}`
        const event: ChiefEvent = { id, at: this.iso(), source: 'system', dedupe: id, text: group.scope, meta: { parent: parent.id, group: group.key } }
        const standard = '仅完成本分组，保存答案、执行计时和核验依据到本工单工作目录，标明未完成项。'
        const scope = contract ? `在父工单授权范围「${contract.scope}」内：${group.scope}` : group.scope
        const superhub = contract && staff ? this.childContract(parent, staff, scope, [{ text: standard }], false) : undefined
        if (contract && !superhub) continue
        this.store.appendEvent(event)
        children.push(this.openTicket({
          title: `${parent.id} · ${group.title}`, staff: parent.staff, priority: parent.priority, workspace: undefined,
          executionBoundary: 'local', requestedExecutor: 'codex', lineId: parent.lineId,
          superhub,
          parent: { ticketId: parent.id, assignmentId: parent.executionPlan.assignmentId, key, criterion, ...contract ? { contractVersion: contract.version } : {} },
          mandate: { ...parent.mandate, level: 'think', scope, doneWhen: [standard], eventId: id, needsReview: false },
        }, id))
      }
      for (const child of children) {
        if (this.store.disposition(child.mandate.eventId)?.kind !== 'accepted') this.store.setDisposition(child.mandate.eventId, { kind: 'accepted', ticketId: child.id })
      }
      groups.set(parent.id, children)
    }
    for (const parent of all.filter(t => !t.ended && groups.has(t.id))) {
      const children = groups.get(parent.id)!
      const waiting: string[] = []
      let changed = false
      for (const child of children) {
        const key = `child:${child.id}`
        if (parent.inputs.some(i => i.key === key)) continue
        const last = latestAssignment(child)
        // Questions, failed attempts and pending owner acceptance remain visible on the child.
        // Only a final outcome wakes the original parent, once for the lifetime of that child.
        if (!child.ended) { waiting.push(child.id); continue }
        parent.inputs.push({ key, at: this.iso(), from: 'system', text: `关联子任务 ${child.id}（${child.staff}）${child.ended.outcome}。${child.ended.note}\n核验：${last?.verification?.verdict ?? '未通过核验'} ${last?.verification?.critique ?? ''}\n交付：${last?.report?.outputs?.join('、') ?? '见子工单'}。沿用原授权继续同一父任务；失败/取消不算完成，不能换 key 重派相同工作。` })
        changed = true
      }
      if (JSON.stringify(parent.waitingFor ?? []) !== JSON.stringify(waiting)) { parent.waitingFor = waiting; changed = true }
      if (changed) this.store.saveTicket(parent)
    }
  }

  /** 研判失败、等主人处理的事件（主人的投递不能被静默丢弃）。 */
  stuckEvents() {
    return this.store.recentEvents(200).filter(e => this.store.disposition(e.id)?.kind === 'unavailable')
      .map(event => ({ event, reason: (this.store.disposition(event.id) as { reason?: string }).reason ?? '' }))
  }

  private checkContractTarget(ticket: Ticket, target?: OwnerTarget): void {
    const current = activeContract(ticket)
    if (ticket.superhub && (!current || target?.brainScope !== ticket.superhub.brainScope || target.brainScope !== this.options.brainScope
      || target.contractVersion !== current.version)) conflict('第二大脑或验收契约已更新，请核对当前版本后重新确认操作')
    if (!ticket.superhub && target?.brainScope !== undefined) conflict('此工单没有对应作用域的验收契约')
  }

  private canStartScoped(ticket: Ticket): boolean {
    const auth = ticket.superhub
    return !auth || (auth.brainScope === this.options.brainScope && (this.options.canStartSuperhub?.(auth) ?? true))
  }

  private ownerAction(ticketId: string, fn: (ticket: Ticket) => void | false, target?: OwnerTarget, threadReply = false): Promise<void> {
    return this.serial(() => {
      const ticket = this.store.ticket(ticketId)
      if (!ticket) throw new Error(`找不到工单 ${ticketId}`)
      if (!threadReply) this.checkContractTarget(ticket, target)
      if (!threadReply && target && (target.threadId !== threadIdOf(ticket) || target.replyTo !== (latestAssignment(ticket)?.id ?? null)
        || (target.stage !== undefined && target.stage !== stageOf(ticket, this.activity)))) throw Object.assign(new Error('工单讨论、派工或阶段已更新，请核对当前工单后重新确认操作'), { status: 409 })
      if (fn(ticket) === false) return
      this.store.saveTicket(ticket)
      this.brain.commit(`${ticket.id}: 主人操作`)
      this.kick()
    })
  }

  // ─────────── 视图 ───────────

  views(): TicketView[] {
    const now = this.now()
    return this.store.tickets().map(ticket => this.viewOf(ticket, now))
  }

  ticketView(id: string): TicketView | undefined {
    const ticket = this.store.ticket(id)
    return ticket && this.viewOf(ticket, this.now())
  }

  isRetiredTicket(id: string): boolean { return this.store.isRetiredTicket?.(id) === true }
  isRetiredSuperhubCommand(commandId: string): boolean {
    const scope = this.options.brainScope
    return !!scope && !!this.store.event('superhub-' + requestHash([scope,commandId]))?.meta?.retired_ticket
  }

  onTicketSaved(listener: (ticket: Ticket) => void): (() => void) | undefined {
    return this.store.onTicketSaved?.(listener)
  }

  private viewOf(ticket: Ticket, now: Date): TicketView {
    const stage = stageOf(ticket, this.activity)
    return { ticket, stage, column: columnOf(stage), attention: attentionScore(ticket, stage, now) }
  }

  recentEvents(limit = 30) {
    return this.store.recentEvents(limit).map(event => ({ event, disposition: this.store.disposition(event.id) }))
  }

  initialEvent(ticketId: string): ChiefEvent | undefined {
    const ticket = this.store.ticket(ticketId)
    return ticket ? this.store.event(ticket.mandate.eventId) : undefined
  }

  // ─────────── 调度 ───────────

  /** 请求一次调度（合并多次请求）。 */
  kick(): void {
    if (this.passScheduled || this.stopped) return
    this.passScheduled = true
    setImmediate(() => {
      this.passScheduled = false
      void this.serial(() => this.pass()).catch(error => this.problem(`调度出错：${(error as Error).message}`))
    })
  }

  private pass(): void {
    if (this.stopped || this.paused) return
    this.reconcileChildren()
    // 1. 研判：一次一条，按时间先后。
    if (!this.triaging && this.now().getTime() >= this.triageHoldUntil) {
      const next = this.store.pendingEvents().find(event => event.meta?.channel !== 'room-review' && !event.superhubCommission)
      if (next) this.startTriage(next)
    }
    // 2. 派工：填满执行名额，按优先级。
    const running = [...this.activity.values()].length
    let free = this.options.concurrency - running
    const queued = this.views().filter(v => v.stage === 'queued' && !this.activity.has(latestAssignment(v.ticket)?.id ?? ''))
      .sort((a, b) => b.ticket.priority - a.ticket.priority || a.ticket.createdAt.localeCompare(b.ticket.createdAt))
    for (const view of queued) {
      if (free <= 0) break
      try {
        if (this.startAssignment(view.ticket)) free -= 1
      } catch (error) {
        this.problem(`${view.ticket.id} 派工失败：${(error as Error).message}`)
      }
    }
  }

  // ─────────── 研判 ───────────

  private startTriage(event: ChiefEvent): void {
    const staff = this.findStaff(TRIAGE_STAFF)
    if (!staff) { this.problem('缺少参谋长角色卡 staff/chief.md，无法研判'); return }
    const target = event.source === 'inbox' ? event.meta?.staff : undefined
    if (target && !this.findStaff(target)) {
      this.store.setDisposition(event.id, { kind: 'unavailable', reason: `点名的幕僚 ${target} 已不可用，请重新选择` })
      this.kick()
      return
    }
    this.triaging = event.id
    const open = this.views().filter(v => !v.ticket.superhub && v.stage !== 'ended' && (!target || v.ticket.staff === target)).map(({ ticket, stage }) => ({ ticket, stage }))
    const prompt = triagePrompt(event, {
      brainRoot: this.brain.root, constitution: this.brain.constitution(), staff: this.brain.staff(),
      open, workspaces: this.brain.workspaces(), now: this.iso(),
    })
    const key = `triage:${event.id}`
    const controller = new AbortController()
    this.controllers.set(key, controller)
    void this.runWithRetry({ staff, label: `研判：${event.text.slice(0, 20)}`, prompt, cwd: this.brain.root, schema: DECISION_SCHEMA },
      this.withTimeout(controller.signal, this.options.timeouts?.triage ?? 10 * 60_000))
      .then(result => this.serial(() => { if (!this.stopped) this.applyTriage(event, result) }))
      .catch(error => this.serial(() => { if (!this.stopped) this.triageFailed(event, (error as Error).message) }))
      .finally(() => { this.controllers.delete(key); this.triaging = undefined; this.kick() })
  }

  private triageFailed(event: ChiefEvent, reason: string): void {
    const count = (this.triageFailures.get(event.id) ?? 0) + 1
    this.triageFailures.set(event.id, count)
    this.problem(`研判失败（第 ${count} 次）：${reason}`)
    if (count >= MAX_TRIAGE_FAILURES) {
      this.store.setDisposition(event.id, { kind: 'unavailable', reason })
      return
    }
    const hold = 30_000 * count
    this.triageHoldUntil = this.now().getTime() + hold
    setTimeout(() => this.kick(), hold).unref?.()
  }

  private applyTriage(event: ChiefEvent, result: RunResult): void {
    const decision = parseDecision(result.structured)
    if (!decision) { this.triageFailed(event, `研判没有给出有效决定（${result.stopReason}${result.diagnostic ? `：${result.diagnostic}` : ''}）`); return }
    const target = event.source === 'inbox' ? event.meta?.staff : undefined
    if (target && !this.findStaff(target)) {
      this.store.setDisposition(event.id, { kind: 'unavailable', reason: `点名的幕僚 ${target} 已不可用，请重新选择` })
      return
    }
    if (target && decision.action !== 'accept' && decision.action !== 'attach') {
      this.triageFailed(event, '点名交办必须开单或并入指定幕僚的工单')
      return
    }
    switch (decision.action) {
      case 'ignore':
        this.store.setDisposition(event.id, { kind: 'ignored', reason: decision.reason })
        return
      case 'note': {
        const path = this.brain.appendNote(decision.path, decision.content)
        this.store.setDisposition(event.id, { kind: 'noted', path, ...decision.reason ? { reason: decision.reason } : {} })
        this.brain.commit(`记录：${path}`)
        return
      }
      case 'attach': {
        const ticket = this.store.ticket(decision.ticketId)
        if (!ticket || ticket.ended || ticket.superhub) { this.triageFailed(event, `工单 ${decision.ticketId} 无法接收未核对版本的输入`); return }
        if (target && ticket.staff !== target) { this.triageFailed(event, `点名交给 ${target} 的任务不能并入 ${ticket.staff} 的工单`); return }
        this.attachEvent(ticket, event, event.source === 'inbox' ? 'owner' : 'system', decision.text)
        this.store.setDisposition(event.id, { kind: 'attached', ticketId: ticket.id, ...decision.text ? { reason: decision.text } : {} })
        return
      }
      case 'accept': {
        const staff = target ?? (this.findStaff(decision.staff) ? decision.staff : this.fallbackStaff())
        const workspace = decision.level === 'write' && decision.workspace && this.brain.workspaces().includes(decision.workspace)
          ? decision.workspace : undefined
        const level: Level = decision.level === 'write' && !workspace ? 'think' : decision.level
        const ticket = this.openTicket({
          title: decision.title, staff, priority: decision.priority, workspace,
          mandate: {
            strength: event.source === 'inbox' ? 'explicit' : 'rule', level, scope: decision.scope,
            doneWhen: decision.doneWhen, needsReview: decision.needsReview, eventId: event.id,
          },
        }, event.id)
        this.store.setDisposition(event.id, { kind: 'accepted', ticketId: ticket.id, ...decision.reason ? { reason: decision.reason } : {} })
        return
      }
    }
  }

  private openTicket(spec: { title: string; staff: string; priority: number; workspace: string | undefined; mandate: Ticket['mandate']; parent?: Ticket['parent']; executionBoundary?: Ticket['executionBoundary']; requestedExecutor?: string; lineId?: string; remoteBrief?: string; related?: Ticket['related']; superhub?: Ticket['superhub'] }, eventId: string): Ticket {
    const ticket: Ticket = {
      id: this.store.nextTicketId(), threadId: randomUUID(), title: spec.title, createdAt: this.iso(), mandate: spec.mandate, staff: spec.staff,
      assignments: [], inputs: [], events: [eventId], priority: spec.priority,
      ...spec.workspace ? { workspace: spec.workspace } : {},
      ...spec.requestedExecutor ? { requestedExecutor: spec.requestedExecutor } : {},
      ...spec.superhub ? { superhub: spec.superhub } : {},
      ...spec.related ? { related: spec.related } : {}, ...spec.parent ? { parent: spec.parent } : {}, ...spec.lineId ? { lineId: spec.lineId } : {}, ...spec.remoteBrief ? { remoteBrief: spec.remoteBrief } : {},
      ...(spec.executionBoundary || localLead(spec)) ? { executionBoundary: spec.executionBoundary ?? 'local' } : {},
    }
    this.store.saveTicket(ticket)
    this.brain.commit(`${ticket.id}: 开单「${ticket.title}」`)
    return ticket
  }

  private openApplyTicket(source: Ticket): boolean {
    const proposal = `${this.brain.workdir(source.id)}/proposal.md`
    const id = randomUUID()
    const event: ChiefEvent = { id, at: this.iso(), source: 'system', dedupe: `apply:${source.id}`, text: `主人批准了 ${source.id} 的提案：${proposal}`, meta: { from: source.id } }
    if (!this.store.appendEvent(event)) return false
    const ticket = this.openTicket({
      title: `执行提案 ${source.id}`, staff: source.staff, priority: source.priority, workspace: this.brain.root,
      mandate: {
        strength: 'explicit', level: 'write', scope: `按 ${proposal} 逐条修改 brain 仓库，不做提案之外的任何修改。花名册（people/、lines/、ledger/、meetings/）里的人物、横向线、承诺、会议一律用 chief_record 记，不要直接写这几个目录下的文件（格式由系统维护）；其余文件直接改。条目里带的 [机密] 等标记原样保留。`,
        doneWhen: ['提案中的每一条修改都已落实到对应文件', '没有修改提案未提及的文件'], needsReview: false, eventId: id,
      },
    }, id)
    this.store.setDisposition(id, { kind: 'accepted', ticketId: ticket.id })
    return true
  }

  private attachEvent(ticket: Ticket, event: ChiefEvent, from: 'owner' | 'system', text = event.text): void {
    ticket.inputs.push({ at: event.at, from, text })
    ticket.events.push(event.id)
    if (ticket.ended && from === 'owner') delete ticket.ended
    this.store.saveTicket(ticket)
  }

  // ─────────── 派工 ───────────

  private workdirOf(ticket: Ticket): string {
    return ticket.mandate.level === 'write' && ticket.workspace ? ticket.workspace : this.brain.workdir(ticket.id)
  }

  private recordExecution(ticket: Ticket, assignment: Assignment, execution: ExecutionRef, review = false, attempt?: ExecutionAttempt): Promise<void> {
    return this.serial(() => {
      if (this.stopped) return
      if (attempt) attempt.execution = execution
      if (!this.currentAssignment(ticket, assignment) || assignment.state === 'cancelled') {
        if (attempt) this.store.saveTicket(ticket)
        return
      }
      if (review) assignment.reviewExecution = execution
      else assignment.execution = execution
      this.store.saveTicket(ticket)
    })
  }

  private currentAssignment(ticket: Ticket, assignment: Assignment): boolean {
    return !this.stopped && !ticket.ended && latestAssignment(ticket) === assignment
      && (!ticket.superhub || (this.canStartScoped(ticket) && assignment.contractVersion === activeContract(ticket)?.version))
  }

  private recordStale(ticket: Ticket, assignment: Assignment, kind: StaleResult['kind'], payload: unknown, stopReason?: string, note?: string): void {
    if (this.stopped || assignment.contractVersion === undefined) return
    const id = requestHash([kind, payload])
    const results = assignment.staleResults ??= []
    if (results.some(result => result.id === id)) return
    results.push({ id, at: this.iso(), kind, contractVersion: assignment.contractVersion, ...stopReason ? { stopReason } : {}, ...note ? { note: note.slice(0, 2000) } : {} })
    this.store.saveTicket(ticket)
  }

  private invalidateVerification(ticket: Ticket, reason: string): void {
    const last = latestAssignment(ticket)
    if (ticket.superhub && last?.verification && !last.verificationInvalidated) {
      last.verificationInvalidated = { at: this.iso(), reason }
    }
  }

  private requiresLocalExecution(ticket: Ticket): boolean {
    if (localLead(ticket) || ticket.executionBoundary === 'local') return true
    if (!ticket.parent || ticket.executionBoundary === 'remote') return false
    // Older remote children have no boundary field. Preserve only an existing remote
    // assignment whose delegate event, remote-only standard and owner brief all agree.
    const event = this.store.event(ticket.mandate.eventId), parent = this.store.ticket(ticket.parent.ticketId)
    return !(ticket.assignments[0]?.executor === 'remote'
      && ticket.mandate.doneWhen.length === 1 && ticket.mandate.doneWhen[0] === REMOTE_CHILD_STANDARD
      && event?.source === 'system' && event.meta?.parent === ticket.parent.ticketId
      && event.dedupe === `delegate:${ticket.parent.ticketId}:${ticket.parent.key}`
      && event.text === ticket.mandate.scope && parent?.remoteBrief === ticket.mandate.scope)
  }

  private blockRemoteAssignment(ticket: Ticket, assignment: Assignment): void {
    ticket.executionBoundary = 'local'
    for (const input of ticket.inputs) if (input.consumedBy === undefined) input.consumedBy = assignment.id
    this.finishAssignment(ticket, assignment, { status: 'blocked', structured: false, summary: '此工单仅限中心处理，或旧委派没有足够的工作端授权记录；当前负责人配置为工作电脑。请将负责人恢复为本地执行后重试；如需工作端参与，请停止本单并另行明确交办允许发出的任务说明。' }, undefined)
    this.brain.commit(`${ticket.id}: 工作端授权边界受阻`)
  }

  private requestedExecutorProblem(ticket: Ticket): string | undefined {
    const required = ticket.requestedExecutor
    if (!required) return
    if (this.findStaff(ticket.staff)?.executor !== required) return `负责人已切换执行器。此工单要求 ${required}，请恢复该执行器后重试。`
    if (!this.executors.available(required, true)) return `此工单要求 ${required}，当前 DSH 没有挂载该执行器。`
  }

  /** 先落盘再执行。返回是否占用了一个执行名额。 */
  private startAssignment(ticket: Ticket): boolean {
    if (!this.canStartScoped(ticket)) return false
    const contract = activeContract(ticket)
    if (ticket.superhub && !contract) { this.problem(`${ticket.id} 缺少可用验收契约`); return false }
    const staff = this.findStaff(ticket.staff)
    if (!staff) { this.problem(`${ticket.id} 的负责人 ${ticket.staff} 没有角色卡`); return false }
    if (!ticket.requestedExecutor && staff.executor !== 'remote' && !this.executors.available(staff.executor)) {
      this.problem(`${ticket.id} 需要的执行者 ${staff.executor} 未安装或不可用`)
      return false
    }
    const round = ticket.assignments.filter(a => a.contractVersion === contract?.version && a.verification?.verdict === 'revise').length
    const assignment: Assignment = {
      id: randomUUID(), staff: staff.id, executor: staff.executor, round, startedAt: this.iso(), state: 'running', role: { ...staff },
      ...contract ? { contractVersion: contract.version } : {},
    }
    const executorProblem = this.requestedExecutorProblem(ticket)
    if (executorProblem) {
      ticket.assignments.push(assignment)
      for (const input of ticket.inputs) if (input.consumedBy === undefined) input.consumedBy = assignment.id
      this.finishAssignment(ticket, assignment, { status: 'blocked', structured: false, summary: executorProblem }, undefined)
      return false
    }
    // 主人可能已确认回复、但尚未派工时角色配置发生变化。只锁定使用过新讨论入口的工单，
    // 两个方向都不能把已核对的输入悄悄换到另一台设备；旧直接交办保持原有行为。
    if (ticket.executionBoundary && ticket.inputs.some(input => input.key?.startsWith('reply:'))
      && ticket.executionBoundary !== (staff.executor === 'remote' ? 'remote' : 'local')) {
      ticket.assignments.push(assignment)
      for (const input of ticket.inputs) if (input.consumedBy === undefined) input.consumedBy = assignment.id
      this.finishAssignment(ticket, assignment, { status: 'blocked', structured: false, summary: `工单讨论已确认在${ticket.executionBoundary === 'remote' ? '工作电脑' : '本地'}执行，但负责人配置已改变。请恢复原执行位置后重试；如需更换设备，请另行明确交办。` }, undefined)
      this.brain.commit(`${ticket.id}: 讨论执行位置已变更`)
      return false
    }
    if (staff.executor === 'remote' && this.requiresLocalExecution(ticket)) {
      ticket.assignments.push(assignment)
      this.blockRemoteAssignment(ticket, assignment)
      return false
    }
    const cwd = this.workdirOf(ticket)
    if (contract && ticket.mandate.level === 'write') this.brain.workdir(ticket.id)
    const event = this.store.event(ticket.mandate.eventId)
    const remote = staff.executor === 'remote'
    const prompt = assignmentPrompt(ticket, staff, {
      assignmentId: assignment.id, brainRoot: this.brain.root, cwd, remote, structuredReport: !remote && this.executors.supportsSchema(staff.executor), ...event ? { event } : {},
    })
    const remoteTask = remote ? { ticketId: ticket.id, assignmentId: assignment.id, title: ticket.title, prompt } : undefined
    if (remoteTask) this.remote.prepare?.(remoteTask)
    for (const input of ticket.inputs) if (input.consumedBy === undefined) input.consumedBy = assignment.id
    ticket.assignments.push(assignment)
    this.store.saveTicket(ticket)

    if (staff.executor === 'remote') {
      this.remote.dispatch(remoteTask!)
      return false
    }
    const controller = new AbortController()
    this.controllers.set(assignment.id, controller)
    this.activity.set(assignment.id, 'executing')
    const schema = this.executors.supportsSchema(staff.executor) ? REPORT_SCHEMA : undefined
    void this.runWithRetry({ staff, ...ticket.requestedExecutor ? { exactExecutor: true } : {}, binding: { ticketId: ticket.id, assignmentId: assignment.id }, label: `${ticket.id} ${ticket.title}`, prompt, cwd, onStarted: execution => this.recordExecution(ticket, assignment, execution), ...schema ? { schema } : {} },
      this.withTimeout(controller.signal, this.options.timeouts?.execute ?? 60 * 60_000), contract ? { ticket, assignment, kind: 'execute' } : undefined)
      .then(result => this.serial(() => {
        const report = reportFromStructured(result.structured) ?? reportFromText(result.text)
        if (!this.currentAssignment(ticket, assignment) || assignment.state !== 'running') {
          this.recordStale(ticket, assignment, 'execution', result, result.stopReason, report.summary)
          return
        }
        if (contract && assignment.execution && result.stopReason === 'completed' && result.evidence?.length) assignment.nativeEvidence = result.evidence
        const failed: Report | undefined = result.stopReason !== 'completed' && (contract || !reportFromStructured(result.structured))
          ? result.blocked
            ? { status: 'blocked', summary: blockedSummary(result.blocked, result.diagnostic), structured: false }
            : { status: 'failed', summary: `执行者异常结束（${result.stopReason}）${result.diagnostic ? `：${result.diagnostic}` : ''}`, structured: false }
          : undefined
        const missing = ticket.executionPlan && this.store.tickets().filter(child => child.parent?.ticketId === ticket.id && child.parent.key.startsWith('plan-') && child.ended?.outcome !== 'done')
        const incomplete: Report | undefined = missing && missing.length > 0
          ? { status: 'blocked', summary: `分组尚未通过核验：${missing.map(child => child.title).join('、')}。`, structured: false }
          : undefined
        this.finishAssignment(ticket, assignment, incomplete ?? failed ?? report, result.text)
        this.afterReport(ticket, assignment)
      }))
      .catch(error => this.serial(() => {
        if (!this.currentAssignment(ticket, assignment) || assignment.state !== 'running') return
        const timedOut = (error as Error).name === 'TimeoutError'
        const blocked = (error as { blocked?: unknown }).blocked
        if (typeof blocked === 'string' && blocked) {
          this.finishAssignment(ticket, assignment, { status: 'blocked', summary: blockedSummary(blocked, (error as Error).message === blocked ? undefined : (error as Error).message), structured: false }, undefined)
          this.brain.commit(`${ticket.id}: blocked`)
          return
        }
        this.finishAssignment(ticket, assignment, { status: 'failed', summary: timedOut ? '执行超时。' : `执行失败：${(error as Error).message}`, structured: false }, undefined)
        this.brain.commit(`${ticket.id}: failed`)
      }))
      .finally(() => {
        if (this.controllers.get(assignment.id) === controller) this.controllers.delete(assignment.id)
        if (this.activity.get(assignment.id) === 'executing') this.activity.delete(assignment.id)
        this.kick()
      })
    return true
  }

  private finishAssignment(ticket: Ticket, assignment: Assignment, report: Report, text: string | undefined): void {
    if (!this.currentAssignment(ticket, assignment) || assignment.state !== 'running') return
    this.checkProtected(ticket)
    assignment.state = 'reported'
    assignment.endedAt = this.iso()
    assignment.report = report
    assignment.deliveries = this.brain.snapshotOutputs?.(ticket.id, report.outputs ?? [])
    if (text) assignment.tail = text.slice(-2000)
    this.store.saveTicket(ticket)
  }

  /** 汇报之后：dropped 直接结束；ready 进入核验；其他留给主人。 */
  private afterReport(ticket: Ticket, assignment: Assignment): void {
    if (!this.currentAssignment(ticket, assignment) || assignment.state !== 'reported') return
    const report = assignment.report
    if (!report) return
    const contract = activeContract(ticket)
    if (contract && ownerHasPendingInput(ticket)) { this.kick(); return }
    if (ticket.waitingFor?.length || ticket.inputs.some(i => i.key?.startsWith('child:') && !i.consumedBy)) { this.brain.commit(`${ticket.id}: 等关联子任务`); this.kick(); return }
    if (report.status === 'dropped') { this.end(ticket, 'dropped', report.summary); return }
    if (report.status !== 'ready') { this.brain.commit(`${ticket.id}: ${report.status}`); return }
    const configured = contract?.verifier ?? (contract ? assignment.role?.verifier : this.findStaff(ticket.staff)?.verifier) ?? DEFAULT_VERIFIER
    const verifierId = assignment.executor === 'remote' && configured === 'none' ? DEFAULT_VERIFIER : configured
    if (verifierId === 'none') {
      this.recordVerification(ticket, assignment, contract
        ? unverifiedContract(contract, '负责人配置跳过核验。必要标准仍需核验或由主人明确接受偏差。', 'skipped')
        : { verdict: 'pass', critique: '该幕僚不需要核验。' }, !!contract)
      return
    }
    const verifier = this.findStaff(verifierId)
    if (!verifier || !this.executors.available(verifier.executor) || verifier.executor === 'remote' || (contract && verifier.id === assignment.staff)) {
      this.problem(`${ticket.id} 的审查官 ${verifierId} 不可用，交给主人验收`)
      const critique = `独立审查官 ${verifierId} 不可用，请主人决定补证、返工或接受偏差。`
      this.recordVerification(ticket, assignment, contract ? unverifiedContract(contract, critique, 'failed') : { verdict: 'revise', critique: `审查官 ${verifierId} 不可用，请主人直接验收。` }, true)
      return
    }
    this.startVerification(ticket, assignment, verifier)
  }

  private startVerification(ticket: Ticket, assignment: Assignment, verifier: Staff): void {
    const contract = activeContract(ticket)
    const deliveries = contract ? this.reviewDeliveries(ticket, assignment) : []
    const native = assignment.nativeEvidence ?? []
    assignment.verifier = verifier.id
    this.store.saveTicket(ticket)
    const report = assignment.report!
    const structured = this.executors.supportsSchema(verifier.executor)
    const cwd = this.workdirOf(ticket)
    const prompt = contract
      ? verifyContractPrompt(ticket, contract, report.summary, deliveries, native, structured)
      : verifyPrompt(ticket, report.summary, report.outputs ?? [], cwd, structured, assignment.executor === 'remote')
    const controller = new AbortController()
    this.controllers.set(assignment.id, controller)
    this.activity.set(assignment.id, 'verifying')
    void this.runWithRetry({ staff: verifier, label: `审查 ${ticket.id}`, prompt, cwd, onStarted: execution => this.recordExecution(ticket, assignment, execution, true), ...structured ? { schema: contract ? CONTRACT_VERDICT_SCHEMA : VERDICT_SCHEMA } : {}, ...contract ? { readOnly: true } : {} },
      this.withTimeout(controller.signal, this.options.timeouts?.verify ?? 20 * 60_000), contract ? { ticket, assignment, kind: 'verify' } : undefined)
      .then(result => this.serial(() => {
        if (this.stopped) return // 重启后 recover() 会重新核验
        if (contract) {
          if (!this.currentAssignment(ticket, assignment) || ownerHasPendingInput(ticket) || assignment.verification) {
            this.recordStale(ticket, assignment, 'review', result, result.stopReason)
            return
          }
          const stillValid = deliveries.filter(item => this.brain.deliveryEvidence?.(ticket.id, item) !== undefined)
            .map(({ path, version }) => ({ path, version }))
          const verification = result.stopReason === 'completed'
            ? parseContractVerification(result.structured ?? contractVerdictText(result.text), contract, assignment, stillValid, [...native, ...(result.evidence ?? [])])
            : unverifiedContract(contract, `独立审查异常结束（${result.stopReason}），请主人决定下一步。`, 'failed', assignment)
          this.recordVerification(ticket, assignment, verification, verification.status !== 'completed')
          return
        }
        const verification = parseVerdict(result.structured) ?? parseVerdictText(result.text)
          ?? { verdict: 'revise' as const, critique: `审查官没有给出有效判定（${result.stopReason}），请主人验收。` }
        this.recordVerification(ticket, assignment, verification)
      }))
      .catch(error => this.serial(() => {
        if (this.stopped) return
        const critique = `审查失败：${(error as Error).message}。请主人决定下一步。`
        this.recordVerification(ticket, assignment, contract ? unverifiedContract(contract, critique, 'failed', assignment) : { verdict: 'revise', critique }, true)
      }))
      .finally(() => {
        if (this.controllers.get(assignment.id) === controller) this.controllers.delete(assignment.id)
        this.activity.delete(assignment.id)
        this.kick()
      })
  }

  private reviewDeliveries(ticket: Ticket, assignment: Assignment): (DeliveryVersion & { content: string })[] {
    const deliveries: (DeliveryVersion & { content: string })[] = []
    let remaining = 16000
    for (const delivery of assignment.deliveries ?? []) {
      const content = this.brain.deliveryEvidence?.(ticket.id, delivery)
      if (content === undefined || content.length > remaining) continue
      remaining -= content.length
      deliveries.push({ ...delivery, content })
    }
    return deliveries
  }

  /** `toOwner`：审查本身出问题（审查官不可用或失败）时，不再返工，直接交给主人验收。 */
  private recordVerification(ticket: Ticket, assignment: Assignment, verification: Verification, toOwner = false): void {
    // 过期结果：工单已结束、已被停止后重新派工、或这次派工已核验过。
    if (!this.currentAssignment(ticket, assignment) || assignment.verification || (ticket.superhub && ownerHasPendingInput(ticket))) {
      this.recordStale(ticket, assignment, 'review', verification, undefined, verification.critique)
      return
    }
    assignment.verification = verification
    assignment.verifiedAt = this.iso()
    if (toOwner) assignment.handedToOwner = true
    else if (verification.verdict === 'revise' && assignment.round < MAX_REVISIONS)
      ticket.inputs.push({ key: `verification:${assignment.id}`, at: this.iso(), from: 'verifier', text: verification.critique, replyTo: assignment.id, ...assignment.contractVersion === undefined ? {} : { contractVersion: assignment.contractVersion } })
    this.store.saveTicket(ticket)
    // 执行期间主人又提了要求：不结单，按主人的话继续（阶段回到排队）。
    if (this.completeVerified(ticket, assignment)) return
    this.brain.commit(`${ticket.id}: 审查 ${verification.verdict}`)
  }

  private completeVerified(ticket: Ticket, assignment: Assignment): boolean {
    if (assignment.report?.status !== 'ready' || assignment.verification?.verdict !== 'pass' || ticket.mandate.needsReview || ownerHasPendingInput(ticket) || ticket.waitingFor?.length || ticket.inputs.some(i => i.key?.startsWith('child:') && !i.consumedBy)) return false
    if (ticket.superhub && (!this.currentAssignment(ticket, assignment) || !this.scopedVerificationValid(ticket, assignment) || this.unresolvedScopedChild(ticket))) return false
    this.end(ticket, 'done', assignment.report.summary)
    return true
  }

  private scopedVerificationValid(ticket: Ticket, assignment: Assignment): boolean {
    const contract = activeContract(ticket), verification = assignment.verification
    if (!contract || assignment.contractVersion !== contract.version || assignment.verificationInvalidated
      || verification?.status !== 'completed' || verification.verdict !== 'pass' || verification.contractVersion !== contract.version || !verification.reviewer) return false
    for (const criterion of contract.criteria.filter(row => row.required)) {
      const result = verification.criteria?.find(row => row.criterionId === criterion.id)
      if (result?.status !== 'pass' || !result.evidence.length) return false
      if (result.evidence.some(evidence => evidence.kind === 'delivery' && this.brain.deliveryEvidence?.(ticket.id, evidence) === undefined)) {
        this.invalidateVerification(ticket, '登记的产物版本已改变，需重新核验')
        this.store.saveTicket(ticket)
        return false
      }
    }
    return true
  }

  private unresolvedScopedChild(ticket: Ticket): boolean {
    const version = activeContract(ticket)?.version
    return this.store.tickets().some(child => child.parent?.ticketId === ticket.id
      && (child.parent.contractVersion === undefined || child.parent.contractVersion === version)
      && (child.ended?.outcome !== 'done' || child.superhub?.ownerAcceptance?.kind === 'deviation'))
  }

  private scopedProposalVerified(ticket: Ticket, assignment: Assignment): boolean {
    if (ticket.mandate.level !== 'propose') return false
    const path = `work/${ticket.id}/proposal.md`
    return assignment.verification?.criteria?.some(row => row.status === 'pass' && row.evidence.some(evidence =>
      evidence.kind === 'delivery' && evidence.path === path && this.brain.deliveryEvidence?.(ticket.id, evidence) !== undefined)) ?? false
  }

  private end(ticket: Ticket, outcome: TicketOutcome, note: string): void {
    ticket.ended = { at: this.iso(), outcome, note }
    this.store.saveTicket(ticket)
    this.reconcileChildren()
    this.kick()
    // 执行已批准提案的工单会修改受保护文件，完成时一并提交；其余工单只提交幕僚可写的目录。
    this.brain.commit(`${ticket.id}: ${outcome}「${ticket.title}」`, { all: outcome === 'done' && this.isApplyTicket(ticket) })
    try { this.options.onEnded?.(ticket) } catch (error) { this.problem(`${ticket.id} 结束后的后续动作出错：${(error as Error).message}`) }
  }

  private isApplyTicket(ticket: Ticket): boolean {
    return ticket.mandate.level === 'write' && ticket.workspace === this.brain.root
  }

  /** 非提案执行工单结束时，检查受保护文件有没有被改动；有就报给主人，不自动提交。 */
  private checkProtected(ticket: Ticket): void {
    if (this.isApplyTicket(ticket) || !this.brain.protectedChanges) return
    void this.brain.protectedChanges().then(files => {
      if (files.length) this.problem(`${ticket.id} 执行期间受保护文件出现未提交的改动：${files.join('、')}。请检查后自行提交或用 git checkout 撤销。`)
    }).catch(() => undefined)
  }

  /** 工作电脑任务超时：标记失败，交给主人。由时钟检查顺带调用。 */
  sweepRemote(): Promise<void> {
    return this.serial(() => {
      if (this.stopped) return
      const limit = this.options.timeouts?.remote ?? 24 * 3_600_000
      for (const ticket of this.store.tickets()) {
        const last = latestAssignment(ticket)
        if (ticket.ended || !last || last.executor !== 'remote' || last.state !== 'running') continue
        if (this.now().getTime() - Date.parse(last.startedAt) < limit) continue
        this.remote.cancel(last.id)
        this.finishAssignment(ticket, last, { status: 'failed', summary: '工作电脑超时未回传。检查工作电脑上的 chief-runner 是否在运行。', structured: false }, undefined)
        this.brain.commit(`${ticket.id}: 工作电脑超时`)
      }
    })
  }

  private withTimeout(signal: AbortSignal, ms: number): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(ms)])
  }

  // ─────────── 工具 ───────────

  private findStaff(id: string): Staff | undefined {
    return this.brain.staff().find(staff => staff.id === id)
  }

  private fallbackStaff(): string {
    return this.brain.staff().find(staff => staff.id !== TRIAGE_STAFF && staff.executor === 'dsh')?.id ?? TRIAGE_STAFF
  }

  /** 瞬时错误（限流、超时、5xx）重试 3 次，退避 2s / 8s / 32s。 */
  private async runWithRetry(request: RunRequest, signal: AbortSignal, context?: AttemptContext): Promise<RunResult> {
    let last: RunResult | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal.aborted) throw new Error('已取消')
      last = context ? await this.runScopedAttempt(request, signal, context) : await this.executors.run(request, signal)
      const effectsKnown = !context || context.kind === 'verify' || last.retrySafe === true || !context.assignment.execution
      const transient = effectsKnown && !last.blocked && last.retrySafe !== false && last.stopReason === 'error' && TRANSIENT.test(last.diagnostic ?? '')
      if (!transient || attempt === 3) return last
      this.log(`${request.label} 遇到瞬时错误，${2 * 4 ** attempt} 秒后重试：${last.diagnostic}`)
      await delay(2000 * 4 ** attempt, undefined, { signal })
    }
    return last!
  }

  private async runScopedAttempt(request: RunRequest, signal: AbortSignal, { ticket, assignment, kind }: AttemptContext): Promise<RunResult> {
    const attempt = await this.serial(() => {
      if (signal.aborted || !this.currentAssignment(ticket, assignment)) throw Error('派工已停止或被替换')
      const attempts = assignment.attempts ??= []
      const attempt: ExecutionAttempt = { kind, number: attempts.filter(row => row.kind === kind).length + 1, startedAt: this.iso(), status: 'running' }
      attempts.push(attempt)
      // A provider that never activates on a retry cannot inherit the previous attempt's identity.
      if (kind === 'verify') delete assignment.reviewExecution
      else delete assignment.execution
      this.store.saveTicket(ticket)
      return attempt
    })
    let status: ExecutionAttempt['status'] = 'failed'
    try {
      if (signal.aborted || !this.currentAssignment(ticket, assignment)) {
        status = 'interrupted'
        throw Error('派工已停止或被替换')
      }
      const result = await this.executors.run({ ...request, onStarted: execution => this.recordExecution(ticket, assignment, execution, kind === 'verify', attempt) }, signal)
      if (result.stopReason === 'completed') status = 'completed'
      return result
    } finally {
      await this.serial(() => {
        if (this.stopped) return
        attempt.status = signal.aborted && status !== 'completed' ? 'interrupted' : status
        attempt.endedAt = this.iso()
        this.store.saveTicket(ticket)
      })
    }
  }
}

// ───────────────────────────── 解析 ─────────────────────────────

const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined

function contractVerdictText(text: string): unknown {
  const payload = [...text.matchAll(/```chief-contract-verdict\s*\n([\s\S]*?)```/g)].at(-1)?.[1]
  if (!payload) return undefined
  try { return JSON.parse(payload) as unknown } catch { return undefined }
}

export function parseDecision(value: unknown): Decision | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const reason = str(v.reason) ?? ''
  switch (v.action) {
    case 'ignore': return { action: 'ignore', reason }
    case 'note': {
      const path = str(v.notePath), content = str(v.noteContent)
      return path && content ? { action: 'note', path, content, ...reason ? { reason } : {} } : undefined
    }
    case 'attach': {
      const ticketId = str(v.ticketId)
      return ticketId ? { action: 'attach', ticketId, text: reason } : undefined
    }
    case 'accept': {
      const title = str(v.title), staff = str(v.staff), scope = str(v.scope)
      const doneWhen = Array.isArray(v.doneWhen) ? v.doneWhen.map(str).filter((x): x is string => !!x) : []
      const level = v.level === 'write' || v.level === 'propose' ? v.level : 'think'
      if (!title || !staff || !scope || !doneWhen.length) return undefined
      const priority = typeof v.priority === 'number' ? Math.max(0, Math.min(3, Math.round(v.priority))) : 1
      const workspace = str(v.workspace)
      return { action: 'accept', title, staff, level, scope, doneWhen, needsReview: v.needsReview === true, priority, ...workspace ? { workspace } : {}, ...reason ? { reason } : {} }
    }
    default: return undefined
  }
}

export function parseVerdict(value: unknown): Verification | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const critique = str(v.critique)
  if ((v.verdict === 'pass' || v.verdict === 'revise' || v.verdict === 'fail') && critique) return { verdict: v.verdict, critique }
  return undefined
}

export function parseVerdictText(text: string): Verification | undefined {
  const block = [...text.matchAll(/```chief-verdict\s*\n([\s\S]*?)```/g)].at(-1)?.[1]
  if (!block) return undefined
  try { return parseVerdict(JSON.parse(block)) } catch { return undefined }
}
