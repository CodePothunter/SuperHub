import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { CommandApprovalDetail, CommandApprovalStatus } from '../core/model.ts'
import type { Agent, ApprovalOutcome, HostContext, NativeToolCall } from './ports.ts'

export interface PendingCommand {
  id: string
  ticket: string
  title: string
  staff: string
  staffId: string
  command: string
  workdir: string
  mode: 'workspace-write' | 'danger-full-access'
  reason: string
  executor?: 'codex'
  assignmentId?: string
  requestedAt?: string
  /** The request settles as unavailable at this time unless the owner decides first. */
  expiresAt?: string
  /**
   * A command of a SuperHub 2.0 coding session, asked through the command gate rather than a native ticket.
   * `ticket` then holds the work order (or session) id, which never matches a native ticket, so native
   * ticket views and notices leave these rows alone.
   */
  workspace?: WorkspaceApprovalBinding
}

export interface WorkspaceApprovalBinding {
  scope: string
  workspaceId: string
  sessionId: string
  traceId?: string
  orderId?: string
  turnId: string
  /** `dsh`: a DSH group member's command, asked in-process from `tools/pre-execute`. */
  tool: 'codex' | 'claude-code' | 'dsh'
  /** The group member that asked (stable member id); absent for a coding session. */
  memberId?: string
}

export interface AssignmentTarget { ticket: string; assignmentId: string; title: string; staff: string; staffId: string; consolidation?: boolean }
interface Command extends Omit<PendingCommand, 'id' | 'workdir' | 'requestedAt' | 'expiresAt'> { assignmentId: string; workdir?: string; background: boolean; signal: AbortSignal }
type Binding = { ticketId: string; assignmentId: string }

/** Owners need enough time to notice a push or reminder; the old five-minute window expired unattended work. */
export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 30
export const approvalTimeoutMinutes = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 24 * 60 ? value : DEFAULT_APPROVAL_TIMEOUT_MINUTES

/** A single readable line for notices and ticket records. Full command text stays in the live approval card. */
export function commandSummary(command: string, max = 160): string {
  const line = command.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const minuteOf = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`

/** Owner-facing reason for a run that could not continue after an approval was not granted. */
export function approvalEnding(status: 'expired' | 'rejected', command: string, requestedAt: string, timeoutMinutes: number): string {
  return status === 'expired'
    ? `命令审批未在 ${timeoutMinutes} 分钟内处理已过期：${commandSummary(command)}（${minuteOf(requestedAt)} 申请）`
    : `命令审批被主人拒绝：${commandSummary(command)}（${minuteOf(requestedAt)} 申请）`
}

/** Reminder for the liaison chat and push. `until` is the owner's local expiry time (HH:MM). */
export function approvalNotice(row: PendingCommand, until?: string): { key: string; text: string } {
  return {
    key: `approval:${row.ticket}:${row.id}`,
    text: `命令待审批：${row.staff}在「${row.title}」（${row.ticket}）申请运行 ${commandSummary(row.command, 120)}。`
      + `${until ? `${until} 前` : ''}未处理会过期，工单将转为受阻，可重试。`,
  }
}

export interface CommandApprovalOptions {
  /** Defaults to DEFAULT_APPROVAL_TIMEOUT_MINUTES. */
  timeoutMinutes?: number
  /** Called once when an owner decision is requested, for reminders and push. Failures stay with the caller. */
  onRequest?(view: PendingCommand): void
  /** Durable ticket record for native DSH commands. The Codex adapter records its own requests. */
  audit?(binding: Binding, id: string, status: CommandApprovalStatus, detail?: CommandApprovalDetail): void
}

/** Show DSH's live decision in the workroom. The native tool owns the grant and audit. */
export function commandApprovals(ctx: HostContext, target: (agentId: string) => AssignmentTarget | undefined, options: CommandApprovalOptions = {}) {
  const timeoutMinutes = approvalTimeoutMinutes(options.timeoutMinutes)
  const executing = new Map<string, Command>()
  const managed = new WeakSet<Agent>()
  const pending = new Map<string, { view: PendingCommand; finish(outcome: ApprovalOutcome): boolean }>()
  const key = (agentId: string, callId: string) => JSON.stringify([agentId, callId])
  let disposed = false

  /** `timeoutMs` shortens the window for one request (the command gate answers within its own deadline). */
  function request(view: Omit<PendingCommand, 'id' | 'requestedAt' | 'expiresAt'>, signal: AbortSignal, isLive: () => boolean, requestId?: string, timeoutMs?: number): Promise<ApprovalOutcome> {
    if (disposed || signal.aborted || !isLive()) return Promise.resolve('cancelled')
    const { promise, resolve: settle } = Promise.withResolvers<ApprovalOutcome>()
    const id = requestId && !pending.has(requestId) ? requestId : randomUUID()
    const requested = new Date()
    const abort = () => finish('cancelled')
    function finish(outcome: ApprovalOutcome) {
      if (!pending.delete(id)) return false
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      let live = false
      try { live = !disposed && !signal.aborted && isLive() } catch { /* the scoped session no longer exists */ }
      settle(live ? outcome : 'cancelled')
      return live
    }
    const windowMs = timeoutMs !== undefined && Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, timeoutMinutes * 60_000)) : timeoutMinutes * 60_000
    const timeout = setTimeout(() => finish('unavailable'), windowMs).unref()
    const row: PendingCommand = { ...view, id, requestedAt: requested.toISOString(), expiresAt: new Date(requested.getTime() + windowMs).toISOString() }
    pending.set(id, { view: row, finish })
    signal.addEventListener('abort', abort, { once: true })
    try { options.onRequest?.(structuredClone(row)) } catch (error) { ctx.logger.warn('命令审批提醒没有登记：%s', String(error)) }
    return promise
  }

  function commandOf(call: NativeToolCall): Command | undefined {
    if (call.name !== 'bash' || !call.agent || !call.arguments || typeof call.arguments !== 'object') return
    const assignment = target(call.agent.id)
    const args = call.arguments as Record<string, unknown>
    if (!assignment || typeof args.command !== 'string' || typeof args.justification !== 'string') return
    const mode = args.sandbox_permissions
    if (mode !== 'workspace-write' && mode !== 'danger-full-access') return
    return {
      ...assignment, mode, command: args.command, reason: args.justification,
      workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
      background: args.run_in_background === true, signal: call.signal,
    }
  }

  const observe = ctx.on?.('tools/execute', async (call, next) => {
    const command = commandOf(call)
    if (!command || !call.agent) return next()
    const id = key(call.agent.id, call.callId)
    executing.set(id, command)
    try { return await next() } finally { executing.delete(id) }
  })
  const answer = ctx.on?.('approval/request', async (native, next) => {
    if (!managed.has(native.agent)) return next()
    if (native.toolName !== 'bash' || !native.reason?.startsWith('escalate sandbox to ')) return 'rejected'
    const agentId = native.agent.id
    const assignment = target(agentId)
    if (!assignment) return 'cancelled'
    const call = native.callId ? executing.get(key(agentId, native.callId)) : undefined
    // A pending command must be the same immutable native call the owner sees.
    if (!call || assignment.assignmentId !== call.assignmentId || native.reason !== `escalate sandbox to ${call.mode}: ${call.reason}` || call.background) return 'rejected'
    if (!native.signal) return 'unavailable'
    const directory = ctx.get('workingDirectory'), session = native.agent.session
    if (!directory || !session) return 'unavailable'
    const cwd = () => directory.get(session)
    const base = cwd()
    const workdir = resolve(base, call.workdir ?? '')
    const { assignmentId } = call
    const signal = AbortSignal.any([call.signal, native.signal])
    const { ticket, title, staff, staffId, command, mode, reason } = call
    const binding = { ticketId: ticket, assignmentId }, auditId = randomUUID()
    options.audit?.(binding, auditId, 'requested', { command: commandSummary(command), timeoutMinutes })
    const outcome = await request({ ticket, title, staff, staffId, command, workdir, mode, reason, assignmentId }, signal,
      () => target(agentId)?.assignmentId === assignmentId && cwd() === base, auditId)
    options.audit?.(binding, auditId, outcome === 'unavailable' ? 'expired' : outcome)
    return outcome
  }, { prepend: true })
  const initialize = observe && answer && ctx.on?.('agent/created', ({ agent }) => {
    if (!target(agent.id)) return
    const approval = ctx.get('approval')
    if (!approval || approval.config.policy === 'never') return
    // DSH seeds delegated sessions with policy 'never'. Only bound ticket executors ask
    // through this answerer, which denies every approval that is not a matching command.
    managed.add(agent)
    approval.setPolicy(agent, 'ask')
  })

  return {
    request,
    timeoutMinutes,
    list: () => [...pending.values()].map(({ view }) => view),
    decide(id: string, allow: boolean) {
      const row = pending.get(id)
      return row?.finish(allow ? 'allowed-once' : 'rejected') ?? false
    },
    dispose() {
      disposed = true
      initialize?.()
      observe?.()
      for (const row of pending.values()) row.finish('cancelled')
      answer?.()
    },
  }
}
