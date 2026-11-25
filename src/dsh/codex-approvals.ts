import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute } from 'node:path'
import { Transform } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import { approvalEnding, commandSummary, type AssignmentTarget, type commandApprovals } from './approvals.ts'
import type { CommandApprovalDetail, CommandApprovalStatus } from '../core/model.ts'
import type { HostContext, SubagentProvider, Subprocess } from './ports.ts'

export interface CodexApprovalConfig { executable: string; model?: string }
interface Binding { ticketId: string; assignmentId: string }
interface WireMessage { id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }
type Approvals = Pick<ReturnType<typeof commandApprovals>, 'request' | 'timeoutMinutes'>
type Child = ReturnType<Subprocess['spawn']>
type ApprovalDecision = Exclude<CommandApprovalStatus, 'requested'>
/**
 * Owner-facing facts about one Codex run. `approval` names the last command the owner did not
 * grant. `stopped` is set when the turn then ended without a native error of its own, so the
 * ungranted approval is the known cause of the ending.
 */
export interface Trace { failure?: string; executed?: boolean; approval?: string; stopped?: string }
type RecordApproval = (id: string, status: CommandApprovalStatus, detail?: CommandApprovalDetail) => void
type Approve = (command: string, cwd: string, reason: string, signal: AbortSignal, id: string) => Promise<ApprovalDecision>
type Describe = (status: 'expired' | 'rejected', command: string, requestedAt: string) => string
const commandRequest = 'item/commandExecution/requestApproval'
const providerName = 'chief-codex'
const maxFrame = 16 * 1024 * 1024

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Codex 0.170 offers `accept`, an execpolicy amendment and `cancel` for an escalated
 * command, but no `decline`; `cancel` interrupts the whole turn. A loopback probe of
 * `codex app-server --stdio` 0.170.0 showed that an explicit `decline` is still accepted:
 * the model receives the denial and the turn runs to completion. Never answer `cancel`,
 * so a rejected or expired approval cannot end the owner's work by itself.
 */
export const DENY_DECISION = 'decline'

/**
 * `features.multi_agent*=false` do not remove Codex 0.170's v2 `collaboration`
 * namespace (`spawn_agent`, `followup_task`, `wait_agent`) for catalog models that select
 * multi-agent v2. `features.multi_agent_v2.disable_native_tools=true` removes it from the
 * model request while command execution and `require_escalated` stay available. A spawned
 * thread's approvals cannot belong to the formal ticket's turn, so spawning is disabled.
 */
export function codexAppServerArgv(executable: string): string[] {
  return [executable, '-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false', '-c', 'features.multi_agent_v2.disable_native_tools=true',
    'app-server', '--stdio']
}

/** Category plus Codex's own message, bounded to one line without control characters. */
function nativeError(error: unknown): string | undefined {
  const value = object(error)
  const info = value?.codexErrorInfo
  const raw = typeof info === 'string' ? info : Object.keys(object(info) ?? {})[0]
  const category = raw && /^[\w-]{1,60}$/.test(raw) ? raw : undefined
  const text = typeof value?.message === 'string' ? value.message.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : ''
  const message = text.length > 300 ? `${text.slice(0, 299)}…` : text
  if (!category && !message) return undefined
  return `${category ? `（${category}）` : ''}${message ? `：${message}` : ''}`
}

function jsonLines(handle: (value: WireMessage, line: string) => string | undefined) {
  const decoder = new StringDecoder('utf8')
  let buffered = ''
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    buffered += decoder.write(chunk)
    try {
      let newline: number
      while ((newline = buffered.indexOf('\n')) !== -1) {
        if (newline > maxFrame) throw Error('Codex 协议消息超出大小限制')
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        if (!line.trim()) continue
        const value = JSON.parse(line) as WireMessage
        const output = handle(value, line)
        if (output !== undefined) this.push(output + '\n')
      }
      if (buffered.length > maxFrame) throw Error('Codex 协议消息超出大小限制')
      callback()
    } catch (error) { callback(error as Error) }
  } })
}

/** The official provider still runs the turn and owns the DSH process. This only answers approval requests. */
export function approvalWire(child: Child, signal: AbortSignal, stopped: AbortController, trace: Trace,
  record: RecordApproval, approve: Approve, describe: Describe): Child {
  const input = child.stdin, output = child.stdout
  if (!input || !output) throw Error('Codex 缺少 App Server 协议通道')
  const stop = () => stopped.abort()
  const lifetime = AbortSignal.any([signal, stopped.signal])
  const received = new Set<string | number>()
  const pending = new Map<string | number, AbortController>()
  let threadRequest: WireMessage['id'], turnRequest: WireMessage['id']
  let threadId: string | undefined, turnId: string | undefined
  let finished = false
  void child.done.then(outcome => {
    if (!finished && !signal.aborted) {
      const exit = object(outcome)
      const cause = typeof exit?.exitCode === 'number' ? `退出码 ${exit.exitCode}`
        : typeof exit?.signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(exit.signal) ? exit.signal : '退出状态未知'
      trace.failure = `Codex 进程在工单回合完成前退出（${cause}）`
    }
    stop()
  }, () => { trace.failure ??= '无法获取 Codex 进程的退出状态'; stop() })

  const outbound = jsonLines((message, line) => {
    if (message.method === 'thread/start') {
      threadRequest = message.id
      return JSON.stringify({ ...message, params: { ...message.params, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' } })
    }
    if (message.method === 'turn/start') {
      if (!threadId || message.params?.threadId !== threadId) throw Error('Codex 会话的初始权限未通过校验')
      turnRequest = message.id
    }
    return line
  })

  const inbound = jsonLines((message, line) => {
    const params = message.params ?? {}
    if (message.id !== undefined && message.result && message.id === threadRequest) {
      const sandbox = object(message.result.sandbox)
      const thread = object(message.result.thread)
      if (sandbox?.type !== 'workspaceWrite' || sandbox.networkAccess !== false || !Array.isArray(sandbox.writableRoots)
        || sandbox.writableRoots.length !== 0 || message.result.approvalPolicy !== 'on-request' || typeof thread?.id !== 'string') {
        throw Error('Codex 未启用预期的工作区沙箱与人工审批')
      }
      threadId = thread.id
    }
    if (turnRequest !== undefined && (message.id === turnRequest && message.result || message.method === 'turn/started' && params?.threadId === threadId)) {
      const id = object(message.result?.turn ?? params?.turn)?.id
      if (typeof id === 'string') turnId ??= id
    }
    if (turnId && params.threadId === threadId && params.turnId === turnId) {
      const item = object(params.item)
      if (message.method === 'item/completed' && item?.type === 'commandExecution' && item.status === 'completed') trace.executed = true
      if (message.method === 'error' && params.willRetry === false) {
        const detail = nativeError(params.error)
        trace.failure = detail ? `Codex 回合错误${detail}` : 'Codex 回合报告不可重试的错误'
      }
    }
    if (message.method === 'turn/completed' && turnId && params?.threadId === threadId && object(params.turn)?.id === turnId) {
      finished = true
      const turn = object(params.turn)
      const status = turn?.status
      if (status === 'failed' || status === 'interrupted') {
        const detail = nativeError(turn?.error)
        if (detail || !trace.failure) trace.failure = `Codex 回合${status === 'failed' ? '失败' : '中断'}${detail ?? ''}`
        if (status === 'interrupted' && !detail && trace.approval) trace.stopped = trace.approval
      }
      for (const request of pending.values()) request.abort()
    }
    if (message.method === 'serverRequest/resolved' && params?.threadId === threadId && params.requestId !== undefined) {
      pending.get(params.requestId as string | number)?.abort()
    }
    if (message.method !== commandRequest || message.id === undefined) return line
    const id = message.id
    if (received.has(id)) return undefined
    received.add(id)

    const offered = Array.isArray(params?.availableDecisions) ? params.availableDecisions : undefined
    const decline = DENY_DECISION
    const auditId = randomUUID()
    const send = (decision: string) => {
      if (!lifetime.aborted && !input.destroyed) input.write(JSON.stringify({ id, result: { decision } }) + '\n', error => { if (error) stop() })
    }
    const command = params?.command, cwd = params?.cwd
    if (lifetime.aborted || finished || !turnId || params.threadId !== threadId || params.turnId !== turnId) {
      record(auditId, 'out-of-scope')
      send(decline)
      return undefined
    }
    if ((params.kind !== undefined && params.kind !== 'command')
      || params.networkApprovalContext || (offered && !offered.includes('accept'))
      || typeof command !== 'string' || !command.trim() || command.length > 16000
      || typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > 4096) {
      record(auditId, 'unsupported')
      send(decline)
      return undefined
    }
    const request = new AbortController()
    pending.set(id, request)
    const requestedAt = new Date().toISOString()
    record(auditId, 'requested', { command: commandSummary(command) })
    const reason = typeof params.reason === 'string' ? params.reason.slice(0, 1000) : 'Codex 申请在沙箱范围之外运行这条命令。'
    void approve(command, cwd, reason, AbortSignal.any([request.signal, lifetime]), auditId).then(
      outcome => {
        record(auditId, outcome)
        // Keep the owner-side cause before answering, so an ending turn is never summarized as unknown.
        if (outcome === 'expired' || outcome === 'rejected') trace.approval = describe(outcome, command, requestedAt)
        else if (outcome === 'allowed-once') delete trace.approval
        if (!request.signal.aborted && outcome === 'allowed-once') trace.executed = true
        if (!request.signal.aborted) send(outcome === 'allowed-once' ? 'accept' : decline)
      },
      () => { record(auditId, 'cancelled'); if (!request.signal.aborted) send(decline) },
    ).finally(() => pending.delete(id)).catch(stop)
    return undefined
  })
  const protocolFailure = () => { trace.failure ??= 'Codex 审批协议通道异常'; stop() }
  outbound.on('error', protocolFailure)
  inbound.on('error', protocolFailure)
  input.on('error', protocolFailure)
  output.on('error', error => { protocolFailure(); inbound.destroy(error) })
  output.on('close', stop)
  output.on('end', () => { if (!finished && !lifetime.aborted) trace.failure ??= 'Codex 协议流在工单回合完成前关闭' })
  output.pipe(inbound)
  outbound.pipe(input)
  return new Proxy(child, { get(target, field) {
    if (field === 'stdin') return outbound
    if (field === 'stdout') return inbound
    const value = Reflect.get(target, field, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

export async function registerCodexApprovals(ctx: HostContext, config: CodexApprovalConfig, profilePatch: string,
  target: (binding: Binding) => AssignmentTarget | undefined, approvals: Approvals,
  audit: (binding: Binding, id: string, status: CommandApprovalStatus, detail?: CommandApprovalDetail) => Promise<void>) {
  const subprocess = ctx.get('subprocess')
  if (!subprocess || !ctx.subagents.registerProvider) throw Error('当前 DSH 没有原生子代理或子进程服务')
  if (typeof config.executable !== 'string' || !isAbsolute(config.executable)) throw Error('Codex 审批需要配置 CLI 的绝对路径')
  const executable = realpathSync(config.executable)
  accessSync(executable, constants.X_OK)
  const requireFromProfile = createRequire(dirname(profilePatch) + '/package.json')
  const packageName = '@deepseek-ai/dsh-subagent-codex'
  const manifest = JSON.parse(readFileSync(requireFromProfile.resolve(packageName + '/package.json'), 'utf8')) as { version: string }
  if (!/^0\.2\.2-rc\.[1-4]$/.test(manifest.version)) throw Error(`请先核对 Codex 官方适配器 ${manifest.version} 的审批协议兼容性`)
  const official = await import(pathToFileURL(requireFromProfile.resolve(packageName)).href) as {
    apply(ctx: { logger: HostContext['logger']; subagents: { registerProvider(provider: SubagentProvider): void }; subprocess: Subprocess }, config: object): void
  }
  const bindingScope = new AsyncLocalStorage<{ binding: Binding; trace: Trace }>()
  const launchScope = new AsyncLocalStorage<{ binding: Binding; trace: Trace; signal: AbortSignal }>()
  let dispose: (() => void) | undefined
  official.apply({ logger: ctx.logger, subagents: { registerProvider(provider) {
    dispose = ctx.subagents.registerProvider!({ name: provider.name, capabilities: provider.capabilities, inheritsParentContext: provider.inheritsParentContext,
      async start(request) {
        const scope = bindingScope.getStore()
        if (!scope || !target(scope.binding)) throw Error('Codex 审批只允许绑定到正在执行的正式工单')
        return launchScope.run({ ...scope, signal: request.signal }, () => provider.start(request))
      },
    })
  } }, subprocess: { spawn(spec) {
    const scope = launchScope.getStore()
    if (!scope || spec.argv.slice(-2).join(' ') !== 'app-server --stdio') throw Error('Codex App Server 启动缺少工单绑定')
    const transport = new AbortController()
    const signal = AbortSignal.any([scope.signal, transport.signal])
    const child = subprocess.spawn({ ...spec, signal, argv: codexAppServerArgv(executable) })
    const record: RecordApproval = (id, status, detail) => {
      void audit(scope.binding, id, status, detail && { ...detail, timeoutMinutes: approvals.timeoutMinutes })
        .catch(() => ctx.logger.warn('工单 %s 的 Codex 审批记录写入失败', scope.binding.ticketId))
    }
    return approvalWire(child, scope.signal, transport, scope.trace, record, async (command, workdir, reason, signal, id) => {
      const assignment = target(scope.binding)
      if (!assignment) return 'cancelled'
      if (assignment.consolidation) return 'out-of-scope'
      const outcome = await approvals.request({ ticket: assignment.ticket, title: assignment.title, staff: assignment.staff, staffId: assignment.staffId,
        command, workdir, reason, mode: 'danger-full-access', executor: 'codex', assignmentId: assignment.assignmentId }, signal, () => !!target(scope.binding), id)
      ctx.logger.info('Codex 单次命令审批 工单 %s 结果 %s', assignment.ticket, outcome)
      return outcome === 'unavailable' ? 'expired' : outcome
    }, (status, command, requestedAt) => approvalEnding(status, command, requestedAt, approvals.timeoutMinutes))
  } } }, { providerName, permissionMode: 'never', model: config.model, env: {}, disposeGraceMs: 3000 })
  if (!dispose) throw Error('无法注册 DSH 官方 Codex 适配器的审批实例')
  return { providerName, run: <T>(binding: Binding, trace: Trace, start: () => Promise<T>) => bindingScope.run({ binding, trace }, start), dispose }
}
