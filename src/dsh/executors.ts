/**
 * 执行者适配：把幕僚角色卡里的 executor 映射到 DSH 官方子代理 provider。
 *
 *   dsh          → spawn（DSH 内置，支持结构化输出和模型覆盖）
 *   claude-code  → claude-code（官方 dsh-subagent-claude-code，需在插件页开启；没装时退回 spawn）
 *   codex        → codex（官方 dsh-subagent-codex，需在插件页开启）
 *
 * 一律 `delivery: 'caller'`：结果只交回插件，不打扰任何会话。
 * 父 Agent 按工作目录选：子代理的文件沙箱继承父会话的工作区，所以改别的仓库时，父会话必须是绑定那个仓库的会话；
 * 工作目录是工单目录时，父会话是只绑定这个目录的临时工单桌（ParentLease），执行结束后释放。
 */
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import type { Executors, RunRequest, RunResult } from '../core/engine.ts'
import type { ExecutionRef } from '../core/model.ts'
import type { Agent, HostContext } from './ports.ts'
import type { registerCodexApprovals, Trace } from './codex-approvals.ts'

const PROVIDERS: Record<string, string> = { dsh: 'spawn', 'claude-code': 'claude-code', codex: 'codex' }

/** 本次执行专用的父会话：执行（含失败）结束后调用 release。 */
export interface ParentLease { readonly agent: Agent; release(): Promise<void> }
export type ParentFor = (cwd: string) => Promise<Agent | ParentLease>
const leased = (value: Agent | ParentLease): value is ParentLease => 'release' in value && typeof value.release === 'function'

/**
 * 工单桌：工作目录是 work/<工单> 的执行（只读调查、提案，以及批准后在工单目录里执行的工单）用它作父会话。
 * DSH 子代理的会话 cwd 取自父会话，文件沙箱（write/edit 与 bash 沙箱）以会话 cwd 为可写根，和启动参数里的 cwd 无关。
 * 以接口人会话为父时，执行者能写整个第二大脑；以只绑定工单目录的桌为父，只能写本工单目录，读取不受影响，
 * 越界的命令只能走单次人工审批。每次执行建一张、结束即释放；不建工作区，会话记为接口人的子会话，
 * 工具调用的祖先链仍经过接口人（按幕僚身份受限）。
 */
export function ticketDesk(ctx: HostContext, workRoot: string, hq: () => Promise<Agent>) {
  return {
    owns: (cwd: string) => /^T-\d+$/.test(relative(workRoot, cwd)),
    async open(dir: string): Promise<ParentLease> {
      if (!ctx.agents.create) throw new Error('宿主不支持创建工单桌会话，无法把执行限制在工单目录内，暂不派工')
      const parent = await hq()
      // 子代理沿用父会话的工具组合（agentPreset 的 composeFrom）和模型路由（父会话最近请求或创建参数）。
      // 桌接上接口人当前的组合，并把接口人当前的模型作为创建参数（角色卡指定的模型仍优先）；
      // 否则子代理既没有 read/write/bash 等工具，也没有模型。
      const route = parent.model?.current() ?? ctx.get('agentDefaultModel')?.currentSelection()
      const preset = ctx.agents.get(parent.id)?.session.header.agentPreset
      const handle = await ctx.agents.create({ sessionId: `chief-desk-${randomUUID()}`,
        meta: { cwd: realpathSync(dir), parentSession: parent.id, origin: 'subagent', delegationDepth: 0, ...preset ? { agentPreset: preset } : {} },
        setup: scope => { if (parent.ctx) scope.get('agentPresets')?.composeFrom(scope, parent.ctx) },
        ...route ? { agentOptions: { provider: route.provider, model: route.model, ...route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {} } } : {} })
      try {
        // 子会话继承父会话的沙箱与审批覆盖：钉住工作区写入（部署默认全权限时也不放宽）；接口人会话只读或不许审批时保持一致。
        const policy = ctx.get('sandboxPolicy'), session = handle.agent.session
        if (policy && session?.append) session.append('sandbox/mode', { mode: parent.session && policy.resolve({ session: parent.session }).mode === 'read-only' ? 'read-only' : 'workspace-write' })
        const approval = ctx.get('approval')
        if (approval && parent.session && approval.overrideOf(parent.session) === 'never') approval.setPolicy(handle.agent, 'never')
      } catch (error) { await handle.dispose().catch(() => undefined); throw error }
      return { agent: handle.agent, release: () => handle.dispose() }
    },
  }
}

/**
 * Chief's known cause comes first. When chief knows why a Codex run ended, the provider's
 * fixed `category: unknown` line adds nothing; lines with an exit code or signal are kept.
 */
export function codexDiagnostic(trace: Trace, provider?: string): string | undefined {
  const known = !!(trace.failure || trace.stopped)
  const lines = (provider ?? '').split('\n').filter(line => line.trim() && !line.startsWith('Codex unattended decision (')
    && !(known && line.startsWith('Product subagent failure (') && line.includes('category: unknown') && !/exit code|signal/.test(line)))
  // An earlier refusal that Codex continued past is context, not the cause of this ending.
  const context = trace.approval && !trace.stopped ? `本轮另有${trace.approval}` : undefined
  return [trace.failure, ...lines, context].filter(Boolean).join('\n') || undefined
}

export class DshExecutors implements Executors {
  constructor(private readonly ctx: HostContext, private readonly parent: ParentFor, private readonly useCodexApprovals = false) {}

  codexApprovals?: Awaited<ReturnType<typeof registerCodexApprovals>>
  observeExecution?: (execution: ExecutionRef) => void

  private readonly readOnlyAgents = new Set<string>()
  readOnly(agentId: string) { return this.readOnlyAgents.has(agentId) }
  private readonly bindings = new Map<string, NonNullable<RunRequest['binding']> & { canAsk: boolean }>()
  binding(agentId: string) { return this.bindings.get(agentId) }

  private warned = new Set<string>()

  /**
   * claude-code / codex 没装时退回 DSH 内置的 spawn：全新安装通常没有这些 bundle，
   * 工程师的工单不该因此卡住。回退时记一次日志，装上之后自动用回原来的。
   */
  private provider(executor: string, exact = false) {
    const name = PROVIDERS[executor]
    if (!name) return undefined
    const provider = this.ctx.subagents.getProvider(name)
    if (provider || name === 'spawn') return { name, provider }
    if (exact) return undefined
    if (!this.warned.has(name)) { this.warned.add(name); this.ctx.logger.warn('执行者 %s 不可用（没装对应的 DSH 插件），先用 DSH 内置的子代理代替', name) }
    return { name: 'spawn', provider: this.ctx.subagents.getProvider('spawn') }
  }

  available(executor: string, exact = false): boolean {
    if (exact && executor === 'codex' && this.useCodexApprovals) return !!this.codexApprovals
    return this.provider(executor, exact)?.provider !== undefined
  }

  supportsSchema(executor: string): boolean {
    return this.provider(executor)?.provider?.capabilities.outputSchema === true
  }

  async run(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
    const found = this.provider(request.staff.executor, request.exactExecutor)
    const codexBinding = request.staff.executor === 'codex' && !request.readOnly ? request.binding : undefined
    const codex = codexBinding ? this.codexApprovals : undefined
    const providerName = codex?.providerName ?? found?.name
    const provider = codex ? this.ctx.subagents.getProvider(codex.providerName) : found?.provider
    if (this.useCodexApprovals && codexBinding && !codex) throw Error('正式工单的 Codex 审批适配器未就绪，请检查 DSH 运行配置')
    if (!providerName || !provider) throw new Error(`执行者 ${request.staff.executor} 不可用`)
    const caps = provider.capabilities
    // 模型写法：provider/model，例如 zhipu/glm-5.3
    const [modelProvider, model] = request.staff.model?.includes('/') ? request.staff.model.split('/', 2) as [string, string] : [undefined, request.staff.model]
    // 思考深度只跟着指定的模型走：保存时已按该模型的 reasoning.efforts 校验过
    const agentOptions = caps.agentOptions && model ? { ...modelProvider ? { provider: modelProvider } : {}, model, ...request.staff.reasoningEffort ? { reasoningEffort: request.staff.reasoningEffort } : {} } : undefined
    const lease = await this.parent(request.cwd)
    const parent = leased(lease) ? lease.agent : lease
    const releaseParent = () => leased(lease) ? lease.release().catch(error => this.ctx.logger.warn('工单桌没有释放：%s', String(error))) : Promise.resolve()
    const approval = providerName === 'spawn' && request.binding && !request.readOnly ? this.ctx.get('approval') : undefined
    const canAsk = approval !== undefined && approval.config.policy !== 'never'
      && parent.session !== undefined && approval.overrideOf(parent.session) !== 'never'
    // The native child must be identifiable before its first system prompt, including a fast local model.
    const childId = canAsk || (request.readOnly && providerName === 'spawn') ? randomUUID() : undefined
    const binding = request.binding && { ...request.binding, canAsk }
    if (childId && binding) this.bindings.set(childId, binding)
    let readOnlyAgent: Agent | undefined
    let unrestrict: (() => void) | undefined
    const restrict = (agent: Agent) => {
      // DSH registers structured_output inside the child scope. This allowlist filters inherited tools.
      unrestrict ??= agent.ctx?.tools?.restrict({
        allow: ['read', 'glob', 'grep', 'chief_lookup', 'chief_brief', 'chief_ticket'],
      })
      if (unrestrict) readOnlyAgent = agent
    }
    if (request.readOnly && childId) this.readOnlyAgents.add(childId)
    const offCreated = request.readOnly && childId ? this.ctx.on?.('agent/created', ({ agent }) => {
      if (agent.id === childId) restrict(agent)
    }) : undefined
    const releaseReadOnly = () => {
      offCreated?.()
      unrestrict?.()
      if (childId) this.readOnlyAgents.delete(childId)
    }
    const start = () => this.ctx.subagents.startActivation({
      provider: providerName,
      ...childId ? { childId } : {},
      label: request.label.slice(0, 60),
      request: {
        prompt: [{ type: 'text', text: request.prompt + (codex ? '\n\n本工单的 Codex 外部命令使用作战室单次人工审批。若工作范围内必需的命令因沙箱而受阻，用命令工具的 sandbox_permissions=require_escalated 参数提交同一条确切命令，并说明具体原因。保持各命令独立、最小化，命令和可见输出中不要放凭证。审批被拒绝后不要重新提交同一请求。若审批被拒绝或过期导致必需的工作无法完成，以 blocked 汇报，写明需要主人批准的命令和原因。' : '') }],
        parent,
        cwd: request.cwd,
        ...request.schema && caps.outputSchema ? { outputSchema: request.schema } : {},
        ...agentOptions ? { agentOptions } : {},
      },
      signal,
      delivery: 'caller',
    })
    const trace: Trace = {}
    // An ungranted command approval is an owner-side stop. The engine keeps the ticket waiting for the owner.
    const ownerStop = (error: unknown) => codex && trace.stopped && !signal.aborted
      ? Object.assign(new Error(trace.failure ?? trace.stopped, { cause: error }), { blocked: trace.stopped })
      : undefined
    const activation = await (codex && codexBinding ? codex.run(codexBinding, trace, start) : start()).catch(async error => {
      if (childId) this.bindings.delete(childId)
      releaseReadOnly()
      await releaseParent()
      throw ownerStop(error) ?? (trace.failure ? new Error(trace.failure, { cause: error }) : error)
    })
    const onAbort = () => { void activation.dispose().catch(() => undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal.aborted) { await activation.dispose(); throw new Error('已取消') }
      let sessionId: string | undefined
      if (request.readOnly) this.readOnlyAgents.add(activation.childId)
      if (binding) this.bindings.set(activation.childId, binding)
      if (request.readOnly || (request.onStarted && providerName === 'spawn')) {
        const announced = readOnlyAgent?.id === activation.childId ? readOnlyAgent : undefined
        const resolved = announced ? { agent: announced } : await this.ctx.sessionController.resolveAgent(activation.childId).catch(() => undefined)
        if (resolved && !('error' in resolved) && resolved.agent.id === activation.childId) {
          // 只有实际可读取的原生会话才记录 sessionId；外部工具的 childId 只是激活标识。
          if (providerName === 'spawn' && resolved.agent.session) sessionId = resolved.agent.id
          if (request.readOnly) restrict(resolved.agent)
        }
        if (request.readOnly && !unrestrict) { await activation.dispose(); throw new Error('宿主无法提供只读讨论环境，暂不能生成回答') }
      }
      if (request.onStarted) {
        const execution = { provider: codex ? 'codex' : providerName, activationId: activation.childId, ...sessionId ? { sessionId } : {} }
        await request.onStarted(execution)
        try { this.observeExecution?.(execution) } catch { this.ctx.logger.warn('SuperHub 原生执行观察未启动') }
      }
      if (signal.aborted) { await activation.dispose(); throw new Error('已取消') }
      const result = await activation.result
      const text = result.output.filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
      const diagnostic = codex ? codexDiagnostic(trace, result.diagnostic) : result.diagnostic
      const blocked = codex && result.stopReason !== 'completed' ? trace.stopped : undefined
      return { text, stopReason: result.stopReason, ...result.structured !== undefined ? { structured: result.structured } : {}, ...diagnostic ? { diagnostic } : {},
        ...trace.executed ? { retrySafe: false } : {}, ...blocked ? { blocked } : {} }
    } catch (error) {
      await activation.dispose().catch(() => undefined)
      throw ownerStop(error) ?? error
    } finally {
      releaseReadOnly()
      this.readOnlyAgents.delete(activation.childId)
      this.bindings.delete(activation.childId)
      signal.removeEventListener('abort', onAbort)
      await releaseParent()
    }
  }
}
