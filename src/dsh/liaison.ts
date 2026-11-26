/**
 * 接口人会话的守护：工具限制、插话即时生效、长对话换段。
 *
 * 接口人是一个长期存在的 DSH 会话，这里补上 DSH 原生会话没有、但常驻接口人需要的三件事：
 *   1. 工具按真实注册表逐名限制；沙箱自己的注册不受 restrict 影响，执行时仍由 guard 拦截。
 *      只读诊断分别记录注册表和最终模型请求入口，不能把前者误当成模型已经看不到。
 *   2. 主人插话立刻生效（做法取自 DS-Bot 的 steer.js）：模型正在生成时，取消这次调用，
 *      把插话放到下一轮最前面；不用等这一步做完。
 *   3. 对话太长时换一段新会话（思路取自 DS-Bot 的 parts.js，做了简化）：事实都在第二大脑里，
 *      交接只需要最近的原话和"去哪里查"，不再让模型另写交接笔记。
 */
import type { ChatMessage } from './chat.ts'
import type { Agent, LlmToolRequest, PendingInput, SessionEventLike, Tools } from './ports.ts'

// ───────────── 1. 工具限制 ─────────────

/**
 * 接口人不能用的工具：
 *   - 只在 DSH 原生界面里显示的交互（弹窗提问、展示页）：作战台和手机上看不到，会让对话卡住；
 *   - 绕过工单的派活方式（临时子代理、团队、目标、内置定时）：幕僚团的活一律走 chief_inbox，才能被追踪和核验；
 *   - 直接写文件、跑命令、管插件：花名册只经 chief_record 写入，机器上的事交给工程师幕僚，插件由主人自己管。
 *     手机能经公网端口跟接口人说话，接口人手里不能有 shell。
 */
export const LIAISON_DENY = [
  'ask_user_question', 'present', 'plugin_manager',
  'subagent', 'subagent_fork', 'subagent_claude_code', 'subagent_codex', 'spawn_teammate', 'send_message', 'wait_agent', 'interrupt_agent', 'list_agents',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'workflow',
  'create_goal', 'update_goal', 'get_goal', 'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
  'write', 'edit', 'bash', 'pwsh', 'job_output', 'job_kill',
] as const

/** 远程操作、后台命令与直接派活的整类工具；新挂载的执行器也适用。 */
export const DENY_PREFIXES = ['remote_', 'job_', 'subagent_', 'mcp__'] as const

const deniedNames = new Set<string>(LIAISON_DENY)
export function deniedLiaisonTool(name: string): boolean {
  return deniedNames.has(name) || DENY_PREFIXES.some(prefix => name.startsWith(prefix))
}

/** Adapters can restore an old MCP schema from the baseline or an in-history addition. */
export function hasRawConnectorHistory(history?: LlmToolRequest['toolHistory']): boolean {
  return !!history && (history.tools.some(tool => tool.name.startsWith('mcp__'))
    || history.updates.some(update => update.additions.some(tool => tool.name.startsWith('mcp__'))))
}

/** 这几样一旦漏掉，接口人就能绕过花名册直接改文件或跑命令：限制没生效时必须报警。 */
export const MUST_DENY = ['write', 'edit', 'bash', 'pwsh'] as const

/**
 * 只保留本机真实注册了的工具名。DSH 的 restrict() 对不认识的名字会整体抛错，
 * 而不同版本、不同 profile 注册的工具不一样（例如没装 Claude Code 就没有 subagent_claude_code）。
 */
export function knownDeny(exists: (name: string) => boolean, deny: readonly string[] = LIAISON_DENY): string[] {
  return deny.filter(name => { try { return exists(name) } catch { return false } })
}

/**
 * 执行时的拦截（DSH 的 tools.guard）：真正的安全边界。
 * restrict() 只能遮住全局工具；workspace-write 沙箱会在会话自己的作用域里注册沙箱版的 bash / write / edit，
 * restrict() 碰不到它们（DS-Bot 的 tools.js 也是这样处理的）。拦截不管工具注册在哪，每次调用都会过一遍。
 * 只拦接口人自己（各段会话）；接口人派出的幕僚照常有自己的工具。
 */
export function liaisonGuard(isLiaison: (id: string) => boolean, deny: readonly string[] = LIAISON_DENY,
  inactive?: (id: string) => boolean) {
  const blocked = new Set(deny)
  return (execution: { readonly name: string; readonly agent?: { readonly id: string } }): string | undefined => {
    const id = execution.agent?.id
    if (!id || !isLiaison(id)) return undefined
    if (inactive?.(id)) return '这次工具调用来自编辑前的对话，请在当前对话继续。'
    // DSH 远程模块的工具能在别的机器上开会话、发指令、传文件：工作电脑上的事一律走外务的派工和核验
    if (execution.name.startsWith('remote_'))
      return `接口人不能用 ${execution.name} 直接操作别的机器：工作电脑上的事用 chief_inbox 交给外务，经派工和核验回传。`
    if (execution.name.startsWith('mcp__')) return '接口人只能经 SuperHub 已授权的资源使用外部应用。查看日程请用 chief_calendar。'
    if (!blocked.has(execution.name) && !DENY_PREFIXES.some(prefix => execution.name.startsWith(prefix))) return undefined
    if (['bash', 'pwsh', 'write', 'edit'].includes(execution.name) || execution.name.startsWith('job_'))
      return `接口人不能用 ${execution.name}。花名册用 chief_record 改；机器上的事用 chief_inbox 交给工程师，写清要做什么、做到什么程度算完成。`
    if (execution.name === 'ask_user_question') return '接口人不能弹窗提问（作战台和手机上看不到）：直接在回复里用一句话问。'
    return `接口人不能用 ${execution.name}：一件事交给一位幕僚用 chief_inbox 交办；要多位或每位幕僚各自回答、一起讨论用 chief_room discuss。这样才能被追踪和核验。`
  }
}

/** 限制之后仍然看得见的危险工具；空数组表示限制生效。 */
export function leakedTools(visible: (name: string) => boolean, must: readonly string[] = MUST_DENY): string[] {
  return must.filter(name => { try { return visible(name) } catch { return true } })
}

export interface LiaisonToolStatus {
  guardInstalled: boolean
  requestAudit: 'available' | 'unavailable'
  /** 此处之后，适配器可能从 toolHistory 中重新投影声明；不宣称是供应商最终请求。 */
  boundary: 'llm/stream-before-adapter'
  sessions: {
    sessionId: string
    maskedGlobal: string[]
    maskFailed: string[]
    /** null 表示宿主没有提供可核验的注册表读取接口。 */
    registeredDenied: string[] | null
    /** 最近一次最终瀑布入口的活跃声明与历史声明；未观察到请求时不提供。 */
    requestDenied?: string[]
    historyDenied?: string[]
  }[]
}

/**
 * 只用 DSH 公开注册表与逐名 restrict。会话自己注册的工具仍由执行守卫约束。
 * 限制不改工具定义、执行器、模型或日志；子代理与父会话的 session 关系不是工具作用域继承。
 */
export class LiaisonToolVisibility {
  private held = new Map<string, { agent: Agent; masked: Map<string, () => void>; failed: Set<string> }>()
  private requests = new Map<string, { requestDenied: string[]; historyDenied: string[] }>()
  private refreshing = false
  private closed = false

  constructor(private readonly tools: Tools, private readonly isScoped: (id: string) => boolean,
    private readonly denied = deniedLiaisonTool, private readonly inherited = false) {}

  attach(agent: Agent): void {
    if (this.closed || !this.isScoped(agent.id)) return
    const old = this.held.get(agent.id)
    if (old?.agent === agent) return this.refresh()
    if (old) for (const lift of old.masked.values()) { try { lift() } catch { /* 已随会话释放 */ } }
    this.held.set(agent.id, { agent, masked: new Map(), failed: new Set() })
    this.refresh()
  }

  refresh(): void {
    // restrict 自己也触发 tools/change，防止重入；一次刷新同时处理所有接口人段。
    if (this.closed || this.refreshing) return
    this.refreshing = true
    try {
      let names: string[]
      try { names = this.tools.schemas ? this.tools.schemas().map(tool => tool.name) : knownDeny(name => this.tools.get?.(name) !== undefined) }
      catch { names = knownDeny(name => this.tools.get?.(name) !== undefined) }
      for (const held of this.held.values()) {
        const inherited = this.tools.schemas?.(held.agent).map(tool => tool.name).filter(name => this.inherited || name.startsWith('mcp__')) ?? []
        for (const name of [...new Set([...names, ...inherited].filter(this.denied))].sort()) {
          if (held.masked.has(name) || held.failed.has(name)) continue
          try {
            const lift = held.agent.ctx?.tools?.restrict({ deny: [name] })
            if (typeof lift === 'function') held.masked.set(name, lift)
            else held.failed.add(name)
          } catch { held.failed.add(name) }
        }
      }
    } finally { this.refreshing = false }
  }

  /** llm/stream 只读观察；绝不重入 stream 或改写冻结请求。只保留工具名。 */
  observe(request: LlmToolRequest): void {
    const id = request.sessionId
    if (this.closed || !id || !this.isScoped(id)) return
    const names = (tools: readonly { readonly name: string }[] = []) => [...new Set(tools.map(tool => tool.name).filter(this.denied))].sort()
    this.requests.set(id, {
      requestDenied: names(request.tools),
      historyDenied: names([...(request.toolHistory?.tools ?? []), ...(request.toolHistory?.updates.flatMap(update => update.additions) ?? [])]),
    })
  }

  status(guardInstalled: boolean, requestAudit: LiaisonToolStatus['requestAudit']): LiaisonToolStatus {
    const ids = new Set([...this.held.keys(), ...this.requests.keys()])
    return {
      guardInstalled, requestAudit, boundary: 'llm/stream-before-adapter',
      sessions: [...ids].filter(id => this.isScoped(id)).sort().map(sessionId => {
        const held = this.held.get(sessionId)
        let registeredDenied: string[] | null = null
        try { if (held && this.tools.schemas) registeredDenied = [...new Set(this.tools.schemas(held.agent).map(tool => tool.name).filter(this.denied))].sort() } catch { /* 无法核验 */ }
        const observed = this.requests.get(sessionId)
        return { sessionId, maskedGlobal: [...(held?.masked.keys() ?? [])].sort(), maskFailed: [...(held?.failed ?? [])].sort(), registeredDenied,
          ...observed ? { requestDenied: [...observed.requestDenied], historyDenied: [...observed.historyDenied] } : {} }
      }),
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const held of this.held.values()) for (const lift of held.masked.values()) { try { lift() } catch { /* 已释放 */ } }
    this.held.clear()
    this.requests.clear()
  }
}

// ───────────── 2. 插话即时生效 ─────────────

export const STEER_CUT = 'chief-liaison-steer'

/**
 * 跟踪接口人这一轮走到哪了。只有"模型正在生成、还没调用工具"时才打断：
 * 工具做到一半取消，可能留下记了一半的花名册；工具都很快，等它做完这一步就好。
 */
export class SteerCutter {
  private phase: 'boundary' | 'model' | 'tools' = 'boundary'
  private cutting = false
  /** 打断过的次数（给测试和日志用）。 */
  cuts = 0

  constructor(private readonly agent: () => Agent | undefined, private readonly defer: (fn: () => void) => void = queueMicrotask) {}

  /** 接口人会话的每个事件都过一遍这里。 */
  observe(event: Pick<SessionEventLike, 'type' | 'data'>): void {
    switch (event.type) {
      case 'step/start':
        this.phase = 'model'
        if (this.userWaiting()) this.defer(() => this.cut())
        return
      case 'assistant/message':
        this.phase = 'tools'
        return
      case 'step/end': case 'turn/start': case 'turn/end':
        this.phase = 'boundary'
        this.cutting = false
        return
      case 'agent/inbox/spliced': {
        const d = event.data as { target?: string; inserted?: readonly PendingInput[] } | undefined
        if (d?.target === 'next-step' && (d.inserted ?? []).some(m => m?.source?.kind === 'user')) this.defer(() => this.cut())
      }
    }
  }

  private userWaiting(): boolean {
    return (this.agent()?.inbox?.nextStep ?? []).some(m => m?.source?.kind === 'user')
  }

  /** 取消正在进行的模型调用，把主人的插话移到下一轮最前面。条件不满足时什么都不做。 */
  cut(): boolean {
    const agent = this.agent()
    if (!agent?.inbox || !agent.cancel || !agent.send) return false
    if (this.phase !== 'model' || this.cutting || agent.status !== 'running') return false
    const last = [...agent.inbox.nextStep].reverse().find(m => m?.source?.kind === 'user')
    if (!last) return false
    this.cutting = true
    this.cuts++
    agent.inbox.remove(last.id)
    agent.cancel({ kind: 'hook', reason: STEER_CUT }, { keepInbox: true })
    agent.send(last as never, 'next-turn', true)
    if (agent.inbox.nextTurn[0]?.id !== last.id) {
      agent.inbox.remove(last.id)
      agent.inbox.prepend('next-turn', last as never)
    }
    return true
  }
}

// ───────────── 3. 长对话换段 ─────────────

/** 没有声明上下文窗口的模型按这个算。 */
export const DEFAULT_WINDOW = 128_000
/** 超过窗口的这个比例就换段；再大也不超过绝对上限（前缀缓存在几十万 token 之后帮不上忙）。 */
export const ROTATE_SHARE = 0.6
export const ROTATE_CAP = 160_000

export function rotateLine(window: number | undefined): number {
  const w = Number.isInteger(window) && window! > 0 ? window! : DEFAULT_WINDOW
  return Math.min(Math.floor(w * ROTATE_SHARE), ROTATE_CAP)
}

/** 最近一次模型请求用掉的上下文（输入 + 缓存 + 输出）。 */
export function contextTokens(events: readonly Pick<SessionEventLike, 'type' | 'data'>[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type !== 'assistant/message') continue
    const total = (e.data as { usage?: { totalTokens?: unknown } } | undefined)?.usage?.totalTokens
    if (typeof total === 'number' && total > 0) return total
  }
  return undefined
}

/** 下一段的会话 id：基础 id 加 -p2、-p3…… */
export function nextPartId(current: string): string {
  const m = /^(.*)-p(\d+)$/.exec(current)
  return m ? `${m[1]}-p${Number(m[2]) + 1}` : `${current}-p2`
}

/** 交接里保留的最近原话条数。 */
export const HANDOFF_MESSAGES = 12

/**
 * 交接内容：追加在新一段的系统提示末尾。只放最近的原话和查找方法——
 * 人物、承诺、横向线、工单都在第二大脑里，新一段用工具查就行，不需要靠记忆。
 */
export function handoffText(previous: string, messages: readonly ChatMessage[], at: string): string {
  const recent = messages.slice(-HANDOFF_MESSAGES).map(m =>
    `${m.role === 'you' ? '主人' : '你'}：${m.text.replace(/\s+/g, ' ').slice(0, 600)}${m.inputAttachments?.length ? ` [附 ${m.inputAttachments.length} 份材料，可用 chief_read_attachment 查看]` : ''}`)
  return [
    '## 接着上一段对话',
    `这是和主人的同一段长期对话，上一段太长（会话 ${previous}），在 ${at} 换成了新的一段。主人看到的是连续的对话，不要向他提换段这件事，也不要重新自我介绍。`,
    '人物、承诺、横向线、会议和工单都在第二大脑里：拿不准时先用 chief_brief 和 chief_lookup 查，不要凭印象。',
    ...recent.length ? ['上一段最后几句（原话）：', ...recent] : [],
  ].join('\n')
}

/** 合并归档的历史和当前这一段：按时间排序，去掉重复，最多 limit 条。 */
export function mergeHistory(archived: readonly ChatMessage[], current: readonly ChatMessage[], limit = 80): ChatMessage[] {
  const seen = new Set<string>()
  const all = [...archived, ...current].filter(message => {
    const dispatches = message.dispatches?.map(dispatch => dispatch.eventId).sort()
    const discussions = message.discussions?.map(room => room.requestId ?? room.id).sort()
    const key = JSON.stringify([message.time, message.role, message.text.slice(0, 40), dispatches ?? [], discussions ?? [], message.requestId,
      ...(message.inputAttachments?.length ? [message.requestId, message.inputAttachments.map(({id}) => id)] : [])])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return all.sort((a, b) => a.time - b.time).slice(-limit)
}
