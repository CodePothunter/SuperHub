/**
 * Codex / Claude Code 成员（工程师）的运行器：复用编程会话的驱动（`workspace-v2-coding.ts` 的 `codingTurn`），
 * 以主人身份、在群的工作目录里运行。每成员每群一个持久的原生会话（Codex thread / Claude Code 会话），每次被叫续接它，
 * 只送引擎拼好的增量；第一次（或续接失败重开时）在前面放上身份与群规则。任务 design §2。
 *
 * - 命令把关走现有 PreToolUse 钩子 + `CodingGate`；一次把关租约 = 群 + 成员 + 这次被叫（callId）的一次推送，
 *   档位按这次被叫所属的工单读，没有工单按完全访问（与编程会话的一般讨论相同）。
 * - 工具公开的每条发言：后面又调了工具（或又说了一句）的是中途发言，回合结束时最后一条是最终回复。
 * - 主人在成员干活中途说话：立即送进在跑的回合（Codex `turn/steer` 带 `expectedTurnId`，被拒（-32600 等）即改排队；
 *   Claude Code 追加一条 stream-json 用户消息，回合在它被读到之前不收尾）。
 * - 进程不跨宿主重启存活：重启后这一回合按中断处理（`reattach` 为 false），thread 仍在 members.json 里，下次续接。
 */
import { randomUUID } from 'node:crypto'
import type { ChatAttachments } from './chat-attachments.ts'
import type { CodingGate, GateLease } from './coding-gate.ts'
import type { Logger, Subprocess } from './ports.ts'
import { appendCommandLog, type CommandLine } from './workspace-command-log.ts'
import { codingTurn, CodingTurnError, processSummary, type CodingInput, type CodingSteer, type CodingTool } from './workspace-v2-coding.ts'
import { memberInputs, memoriesRevoked, seenMemories, type MemberCall, type MemberCallSink, type MemberInputs, type MemberReattach, type MemberRunner, type MemberSteer, type MemberWords } from './workspace-group-members.ts'

/** 一次被叫最长跑多久（与编程会话的单轮上限相同）。 */
export const MEMBER_TURN_LIMIT_MS = 4 * 60 * 60_000

export interface CodingMemberRunnerOptions {
  inputAttachments?: Pick<ChatAttachments, 'cliInputs'>
  tool: CodingTool
  subprocess: () => Subprocess | undefined
  /** 工具的可执行文件（找不到时为 undefined）。 */
  executable: () => string | undefined
  /** 宿主配置的模型（Codex）；缺省由工具自己的配置决定。 */
  model?: string
  gate?: Pick<CodingGate, 'open'>
  /** Codex 确认钩子信任的等待时间（测试用）。 */
  trustWaitMs?: number
  logger?: Logger
}

interface Run {
  call: MemberCall
  sink: MemberCallSink
  push: number
  controller: AbortController
  cancelled: boolean
  toolCalls: number
  pending?: string
  active: boolean
  /** A Claude user message can be written before system/init reports its session id. */
  scoped?: true
  extraInputs?: MemberWords[]
  /** 在跑的回合接受主人插话的入口（回合开始后才有）。 */
  steer?: CodingSteer
}

const label = (tool: CodingTool) => tool === 'codex' ? 'Codex' : 'Claude Code'

export class CodingMemberRunner implements MemberRunner {
  private readonly runs = new Map<string, Run>()
  private disposed = false

  constructor(private readonly options: CodingMemberRunnerOptions) {}

  run(call: MemberCall, sink: MemberCallSink): Promise<void> {
    if (this.runs.get(call.callId)?.active) return Promise.reject(new Error('这一回合已经在跑了。'))
    const run: Run = { call, sink, push: 0, controller: new AbortController(), cancelled: false, toolCalls: 0, active: false }
    this.runs.set(call.callId, run)
    return this.push(run, call.prompt, true)
  }

  continue(callId: string, text: string): Promise<void> {
    const run = this.runs.get(callId)
    if (!run || run.active || run.cancelled) return Promise.reject(new Error('这一回合已经不在了，没法续推。'))
    return this.push(run, text, false)
  }

  /** 主人的话送进在跑的回合：Codex `turn/steer`（被拒即 `rejected`），Claude Code 追加用户消息（`pending`）。 */
  async steer(callId: string, words: MemberWords): Promise<MemberSteer> {
    const run = this.runs.get(callId)
    if (!run?.active || run.cancelled || !run.steer) return 'rejected'
    try {
      const steer = run.steer
      const files = await this.inputs(words, run.controller.signal)
      if (!run.active || run.steer !== steer || run.cancelled) return 'rejected'
      const {group, member, workOrderId} = run.call
      const native = group.sessions.member(member.id)?.session
      if (files?.length) run.scoped = true
      if (files?.length && native) group.sessions.scopeInputs(member.id, workOrderId, native)
      const outcome = await steer(words.id, words.text, files)
      if (outcome !== 'rejected' && run.active) {
        if (files?.length) (run.extraInputs ??= []).push(words)
        run.sink.touched(callId)
      }
      return outcome
    } catch { return 'rejected' }
  }

  cancel(callId: string) {
    const run = this.runs.get(callId)
    if (!run) return
    run.cancelled = true
    run.controller.abort()
    if (!run.active) this.runs.delete(callId)
  }

  /** 进程活不过宿主重启：按中断处理。同一运行器里还在跑的（引擎重建、宿主没重启）改报给新的引擎。 */
  async reattach(call: MemberReattach, sink: MemberCallSink): Promise<boolean> {
    const run = this.runs.get(call.callId)
    if (run?.active && !run.cancelled) { run.sink = sink; return true }
    call.group.sessions.clearLive(call.callId)
    return false
  }

  dispose() {
    this.disposed = true
    for (const run of this.runs.values()) { run.cancelled = true; run.controller.abort() }
    this.runs.clear()
  }

  private async inputs(materials: MemberInputs | undefined, signal: AbortSignal): Promise<CodingInput[] | undefined> {
    if (!materials || !memberInputs(materials).length) return
    const service = this.options.inputAttachments
    if (!service) throw new Error('当前宿主无法向编程成员投递附件')
    const inputs: CodingInput[] = materials.inputAttachments?.length ? await service.cliInputs(materials.inputAttachments, signal) : []
    for (const ref of materials.readAttachments ?? []) {
      const prior = await service.cliInputs([ref], signal)
      inputs.push(...prior.map(file => ({...file, readOnDemand: true as const})))
    }
    return inputs
  }

  /**
   * 跑一次推送。兑现于工具接下这句话（Codex `turn/start` 成功、Claude Code 写入首条消息）；之前失败就拒绝，
   * 不报 `finished`。之后的结局都经 `finished` 报回。
   */
  private push(run: Run, text: string, first: boolean): Promise<void> {
    const delivered = Promise.withResolvers<void>()
    let accepted = false
    const accept = () => { if (!accepted) { accepted = true; delivered.resolve() } }
    run.push += 1
    run.active = true
    run.pending = undefined
    run.steer = undefined
    void this.turn(run, text, first, accept).then(outcome => {
      run.active = false
      run.steer = undefined
      if (!accepted) {
        this.runs.delete(run.call.callId)
        delivered.reject(new Error(outcome.status === 'completed' ? `${label(this.options.tool)} 没有接下这句话。` : outcome.detail ?? `${label(this.options.tool)} 没有接下这句话。`))
        return
      }
      if (run.cancelled) { this.runs.delete(run.call.callId); outcome = { ...outcome, status: 'cancelled', text: '' } }
      if (this.disposed) return
      run.sink.finished(run.call.callId, { text: outcome.text, status: outcome.status, toolCalls: run.toolCalls, ...outcome.detail && { detail: outcome.detail } })
      if (!run.active) this.trim()
    })
    return delivered.promise
  }

  /** 已结束的回合留着等可能的一次续推；太多时丢掉最早的。 */
  private trim() {
    const idle = [...this.runs.entries()].filter(([, run]) => !run.active)
    for (const [id] of idle.slice(0, Math.max(0, idle.length - 64))) this.runs.delete(id)
  }

  private async turn(run: Run, text: string, first: boolean, accept: () => void): Promise<{ status: 'completed' | 'failed' | 'cancelled'; text: string; detail?: string }> {
    const { call, sink } = run
    const { tool } = this.options
    const subprocess = this.options.subprocess(), binary = this.options.executable()
    if (!subprocess || !binary) return { status: 'failed', text: '', detail: `当前宿主没有可用的 ${label(tool)}` }
    const known = call.group.sessions.native(call.member.id, call.workOrderId)
    // A revoked experience is still in the thread's opening words: start a new thread (with the recent lines) instead.
    const resumable = known?.kind === tool && known.cwd === call.group.workDir && !memoriesRevoked(known, call.member) ? known.session : undefined
    const opening = (body: string) => [call.identity, body].filter(Boolean).join('\n\n')
    const commands = new Map<string, CommandLine>()
    const turnId = `${call.callId}.${run.push}`
    const who = { memberId: call.member.id, memberName: call.member.name }
    const attempt = async (resume: string | undefined, prompt: string, materials?: MemberInputs) => {
      let lease: GateLease | undefined
      try {
        lease = this.options.gate?.open({ workspaceId: call.group.workspaceId, sessionId: call.group.groupId, ...call.workOrderId && { orderId: call.workOrderId },
          turnId, tool, cwd: call.group.workDir, member: { id: call.member.id, name: call.member.name }, title: call.group.title },
        line => this.log(call, line), { approval: waiting => { if (run.active) sink.approval(call.callId, waiting) } })
      } catch (error) {
        throw new Error('SuperHub 命令把关不可用，没有启动' + label(tool) + '：' + (error instanceof Error ? error.message : String(error)))
      }
      if (!lease && tool === 'codex') this.options.logger?.warn('群成员 %s 在没有命令把关的情况下运行', call.member.name)
      try {
        const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(MEMBER_TURN_LIMIT_MS)])
        const inputs = await this.inputs(materials, signal)
        return await codingTurn(subprocess, tool, binary, call.group.workDir, prompt, signal, {
          inputAttachments: inputs,
          launch: { ...tool === 'codex' && this.options.model && { model: this.options.model }, ...resume && { resume }, ...lease && { extraArgs: lease.args },
            name: [call.group.workspaceName, call.group.title, call.member.name].filter(Boolean).join(' · ') },
          ...lease && { env: lease.env },
          ...lease && tool === 'codex' && { gate: lease, ...this.options.trustWaitMs !== undefined && { trustWaitMs: this.options.trustWaitMs } },
          onSteerable: steer => { run.steer = steer; accept() },
          onSession: session => {
            if (run.controller.signal.aborted) return
            try { call.group.sessions.setMember(call.member.id, { kind: tool, cwd: call.group.workDir, session, workOrderId: call.workOrderId,
              ...((inputs?.length || run.scoped) && {inputScoped: true}), memories: seenMemories(known, call.member, session !== resumable) }) }
            catch (error) { this.options.logger?.warn('群成员 %s 的原生会话没记下：%s', call.member.name, String(error)) }
          },
          publish: (_item, said) => {
            if (!run.active) return
            sink.touched(call.callId)
            if (run.pending !== undefined) sink.stepped(call.callId, run.pending)
            run.pending = said
          },
          onCommand: event => {
            if (!run.active) return
            sink.touched(call.callId)
            const id = 'c-' + randomUUID()
            if (event.phase === 'start') {
              if (run.pending !== undefined) { sink.stepped(call.callId, run.pending); run.pending = undefined }
              run.toolCalls += 1
              sink.tool(call.callId, { name: event.tool, team: false, ...event.command && { detail: event.command } })
              commands.set(event.itemId, { kind: 'command', id, itemId: event.itemId, turnId, workOrderId: call.workOrderId ?? null, ...who, at: new Date().toISOString(),
                tool: event.tool, command: event.command, cwd: call.group.workDir })
              return
            }
            const row = commands.get(event.itemId) ?? { kind: 'command' as const, id, itemId: event.itemId, turnId, workOrderId: call.workOrderId ?? null, ...who,
              at: new Date().toISOString(), tool: event.tool, command: event.command, cwd: call.group.workDir }
            commands.delete(event.itemId)
            this.log(call, { ...row, endedAt: new Date().toISOString(), ...event.exitCode !== undefined && { exitCode: event.exitCode },
              ...event.failed && { failed: true }, ...event.outputTail && { outputTail: event.outputTail }, ...event.unmatched && { unmatched: true } })
          },
        })
      } finally {
        lease?.close()
        for (const row of commands.values()) this.log(call, { ...row, unfinished: true })
        commands.clear()
      }
    }
    try {
      try {
        const recap = !resumable && first
        await attempt(resumable, resumable ? text : opening(recap ? call.recap?.() ?? text : text),
          recap ? call.recapInputs ?? call : first ? call : undefined)
      } catch (error) {
        // Only a continuation that never reached the model starts over, as a new session with the recent lines.
        if (!resumable || !(error instanceof CodingTurnError) || error.result.started || run.controller.signal.aborted) throw error
        this.options.logger?.warn('群成员 %s 的 %s 会话续接失败，改开新会话：%s', call.member.name, label(tool), processSummary(error.result.process))
        run.pending = undefined
        const history = [call.recap?.() ?? text, ...(run.extraInputs ?? []).map(words => words.text)].join('\n\n')
        const recap = call.recapInputs ?? call, extra = run.extraInputs ?? []
        const refs = new Map([...memberInputs(recap), ...extra.flatMap(memberInputs)].map(ref => [ref.id, ref]))
        const current = (extra.at(-1) ?? recap).inputAttachments
        for (const ref of current ?? []) refs.delete(ref.id)
        await attempt(undefined, opening(history), {inputAttachments: current, readAttachments: [...refs.values()]})
      }
      return { status: 'completed', text: run.pending ?? '' }
    } catch (error) {
      if (run.cancelled) return { status: 'cancelled', text: '' }
      if (run.pending !== undefined) { sink.stepped(call.callId, run.pending); run.pending = undefined }
      const detail = error instanceof Error ? error.message : String(error)
      return { status: 'failed', text: '', detail: detail.slice(0, 300) }
    }
  }

  private log(call: MemberCall, line: Parameters<typeof appendCommandLog>[1]) {
    try { appendCommandLog(call.group.commandsPath, line) } catch (error) { this.options.logger?.warn('群命令记录写入失败：%s', String(error)) }
  }
}
