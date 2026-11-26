/**
 * 本插件用到的 DSH 服务的最小结构类型。
 *
 * 只声明实际调用的那一小部分，签名对照 dsh 0.2.2-rc.1 的 .d.ts 核对过。这样插件不在编译期
 * 绑定几十个 @deepseek-ai 包；DSH 升级时，需要检查的接口全在这一个文件里。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Readable, Writable } from 'node:stream'

export interface TextBlock { type: 'text'; text: string }
export type NativePromptPart = TextBlock | {type: 'file'; receiptId: string}
export type ContentBlock = TextBlock | { type: string; [key: string]: unknown }

/** 会话事件：只用到对话相关的两种。 */
export interface SessionEventLike { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }
/** A DSH step can admit host-provided context alongside claimed inbox input. */
export interface StepInput {
  readonly content?: unknown
  readonly source?: { readonly kind?: string; readonly rpcId?: string; readonly senderSessionId?: string }
}
export type StepDecision = {kind: 'reject'} | {kind: 'enter'; messages: StepInput[]; startsRequestSeries?: true}

/** 接口人收件箱里的一条待处理消息（只用到 id 和来源）。 */
export interface PendingInput { readonly id: string; readonly source?: { readonly kind?: string; readonly rpcId?: string } }

/** dsh-agent 的 Agent：用到 id、运行状态、会话事件快照、给这个 Agent 追加系统提示和限制工具，以及接口人用的模型、收件箱和取消。 */
export interface Agent {
  readonly id: string
  readonly status?: 'idle' | 'running'
  readonly session?: {
    snapshotEvents(): readonly SessionEventLike[]
    toolHistory?(): NonNullable<LlmToolRequest['toolHistory']>
    /** 追加一条会话日志事件（只用于 sandbox/mode 这种仅记日志的策略事件）。 */
    append?(type: string, data: unknown): unknown
  }
  readonly ctx?: {
    systemPrompt?: {
      section(section: { name: string; order: number; text: string | (() => string); interpolate?: boolean }): () => void
      context?(context: {name: string; order: number; text: () => string; interpolate?: boolean; required?: boolean}): () => void
    }
    tools?: {
      restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
      guard?: Tools['guard']
    }
  }
  /** 这个会话往后每一步用的模型；select 只影响这个会话，不改 profile 默认。 */
  /** dsh-agent ModelSelection：reasoningEffort 缺省时由适配器用模型默认档位。 */
  readonly model?: { current(): ModelSelection | undefined; select(selection: ModelSelection): void }
  readonly inbox?: {
    readonly nextStep: readonly PendingInput[]
    readonly nextTurn: readonly PendingInput[]
    remove(id: string): boolean
    prepend(target: 'next-turn' | 'next-step', message: never): void
  }
  cancel?(cause: { kind: 'hook'; reason: string }, options?: { keepInbox?: boolean }): void
  send?(message: never, target: 'next-turn' | 'next-step', wakeup: boolean): void
}

export interface SubagentResult {
  readonly output: readonly ContentBlock[]
  readonly structured?: unknown
  readonly diagnostic?: string
  /** completed / aborted / error / max-tokens / refusal */
  readonly stopReason: string
}

/** dsh-subagent：SubagentRuntime */
export interface Subagents {
  prompt?(request: { requestId: string; parentSessionId: string; childSessionId: string; mode: 'continuable'; delivery: 'queue' | 'steer'; content: readonly TextBlock[] }, signal: AbortSignal): Promise<{ messageId: string }>

  list(): string[]
  getProvider(name: string): { readonly capabilities: { readonly outputSchema: boolean; readonly agentOptions: boolean } } | undefined
  registerProvider?(provider: SubagentProvider): () => void
  startActivation(spec: {
    provider: string
    childId?: string
    label: string
    request: { prompt: ContentBlock[]; parent: Agent; cwd?: string; outputSchema?: object; agentOptions?: { provider?: string; model?: string; reasoningEffort?: string } }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<{ readonly childId: string; readonly result: Promise<SubagentResult>; dispose(): Promise<void> }>
}

export interface SubagentProvider {
  readonly name: string
  readonly capabilities: { readonly outputSchema: boolean; readonly agentOptions: boolean }
  readonly inheritsParentContext: boolean
  start(request: { cwd: string; signal: AbortSignal }): Promise<unknown>
}

export interface Subprocess {
  spawn(spec: { argv: string[]; cwd: string; stdio: Record<string, string>; graceMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }): {
    readonly stdin?: Writable
    readonly stdout?: Readable
    readonly stderr?: Readable
    readonly done: Promise<unknown>
  }
}

/** dsh-api-session-controller */
export interface SessionController {
  resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: { code: string; message?: string } }>
  /** DSH creates a new native session from a source prefix that includes atSeq. */
  fork?(request: { sessionId: string; atSeq: number }): Promise<{ sessionId: string }>
  /** `workspaceId` or `cwd`, not both (a group member's session is created on its group's directory). */
  create(request: { sessionId?: string; agentPreset?: string; title?: string } & ({ workspaceId: string; cwd?: never } | { cwd: string; workspaceId?: never })): Promise<unknown>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  /** 以用户消息的身份进入目标会话的收件箱（服务自己标注来源为用户；第二个参数是取消信号）。 */
  prompt(request: { requestId: string; sessionId: string; mode: 'queue' | 'steer'; content: readonly NativePromptPart[] }, signal: AbortSignal): Promise<unknown>
  /** 取消这个会话正在跑的回合（`agent.cancel({kind:'user'},{keepInbox:true})`）；会话不在线时抛错。 */
  cancel?(request: { sessionId: string }): unknown
}

/** dsh-workspace */
export interface WorkspaceRegistry {
  create(path: string, title?: string): Promise<{ readonly id: string }>
}

/** dsh-host-webserver */
export interface WebServer {
  readonly host: string
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

/** dsh-client-connection：Host/Origin 围栏 + 已登录 Peer 校验。返回 HTTP 状态码表示拒绝。 */
export interface Connection {
  requestRejection(request: IncomingMessage): number | undefined
  admit?(request: IncomingMessage): { rejection: number } | { peer: { principal: { kind: string }; interactions: string } }
}

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'unavailable' | 'cancelled'
export interface ApprovalRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}
/** dsh-tools PreToolDecision（只用到 allow / deny / cancel）。 */
export type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'cancel' } | { kind: 'ask'; reason: string; displayReason?: string }
export interface NativeToolCall {
  readonly name: string
  readonly callId: string
  readonly agent?: Agent
  readonly arguments: unknown
  readonly signal: AbortSignal
}

/** dsh-tools */
export interface ToolExecution { readonly signal: AbortSignal }
export interface Tools {
  /** 某个视角（不传是全局，传 Agent 是它限制之后的视角）下能看到的工具定义。 */
  get?(name: string, scope?: unknown): object | undefined
  /** 注册表中这个作用域可见的声明；不是最终模型请求，历史投影还可能补回旧声明。 */
  schemas?(scope?: unknown): readonly { readonly name: string; readonly parameters?: unknown }[]
  /** Host service invocation through the normal tool execution pipeline, outside an agent turn. */
  execute?(input: {signal: AbortSignal; calls: {type: 'tool-call'; id: string; name: string; arguments: string}[]}): Promise<{results: readonly {result: {isError: boolean; value?: unknown}}[]}>
  /** 执行前拦截：返回字符串表示拒绝这次调用（模型会看到这句话）。不管工具注册在哪个作用域都生效。 */
  guard?(guard: (execution: { readonly name: string; readonly callId?: string; readonly agent?: { readonly id: string }; readonly arguments?: unknown }) => string | undefined): () => void
  register(definition: {
    name: string
    description: string
    parameters: object
    output: {
      schema: object
      render: (args: unknown, value: unknown) => ContentBlock[]
      presentationMeta?: (args: unknown, value: unknown) => Record<string, unknown>
    }
    execute: (args: Record<string, unknown>, execution: ToolExecution) => Promise<unknown>
  }, options?: { when: (input: { readonly agent: Agent }) => boolean }): () => void
}

/** 最后一个公开模型请求瀑布入口，只读取工具名，不接触对话内容。适配器的历史投影在它之后。 */
export interface LlmToolRequest {
  readonly sessionId?: string
  readonly system?: string
  readonly messages?: readonly {readonly role: string; readonly source?: {readonly kind: string};
    readonly content: readonly {readonly type: string; readonly text?: string}[]}[]
  readonly tools?: readonly { readonly name: string }[]
  readonly toolHistory?: {
    readonly tools: readonly { readonly name: string }[]
    readonly updates: readonly { readonly additions: readonly { readonly name: string }[] }[]
  }
}

export interface Logger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** 新建 Agent 的作用域（创建时的 setup 回调里）：只用 agent-preset-registry 把它接到父会话的工具组合上。 */
export interface AgentScope {
  get(name: 'agentPresets'): { composeFrom(ctx: AgentScope, parent: unknown): string | undefined } | undefined
}

/** dsh-agent 的 Agent 注册表：查会话的父会话（工具调用方的祖先链），以及建工单桌（只读工单执行者的父会话）。 */
export interface Agents {
  list?(): Agent[]
  get(sessionId: string): { readonly session: { readonly header: { readonly parentSession?: string; readonly origin?: 'subagent'; readonly agentPreset?: string } } } | undefined
  /** AgentRegistry.create：返回的 dispose 停下这个 Agent 并移出在线会话。meta.cwd 是会话的工作区边界（文件沙箱的根）。 */
  create?(options: { sessionId: string; meta?: { cwd?: string; parentSession?: string; origin?: 'subagent'; delegationDepth?: number; agentPreset?: string }; agentOptions?: Partial<ModelSelection>; setup?(agentCtx: AgentScope): void | Promise<void> }): Promise<{ readonly agent: Agent; dispose(): Promise<void> }>
}

/** dsh-agent 的 ModelSelection：会话下一步用的 provider/model 和可选的思考深度。 */
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }

/** dsh-llm 的 LlmModelReasoningInfo：efforts 从浅到深；defaultEffort 是适配器在请求不带档位时用的。 */
export interface ModelReasoning { efforts: readonly { id: string; name: string; description?: string }[]; defaultEffort?: string }

/** dsh-llm：只读模型目录。 */
export interface Llm {
  listProviders(): { id: string; name: string }[]
  listModels(provider: string): Promise<{ id: string; name: string }[]>
  resolveModelInfo(provider: string, model: string): Promise<{ context?: { contextWindow: number }; reasoning?: ModelReasoning; inputModalities?: readonly string[] }>
  /** One-shot request to the selected provider (staff runs, command review). No agent, session replay, tools or workspace access. */
  stream?(options: ModelSelection & {system:string; tools:never[]; messages:{role:'user';content:TextBlock[]}[];signal:AbortSignal}): AsyncIterable<{type:string;text?:string;reason?:{kind:string;failure?:{message?:string}}}>
}

/** cordis Context 中本插件用到的部分。 */
export interface HostContext {
  readonly agents: Agents
  readonly subagents: Subagents
  readonly sessionController: SessionController
  readonly workspaceRegistry: WorkspaceRegistry
  readonly webServer: WebServer
  readonly tools: Tools
  readonly logger: Logger
  get(name: 'attachments'): NativeAttachmentStore | undefined
  get(name: 'fileUploads'): NativeFileUploads | undefined
  get(name: 'sessionQuery'): { observeSession(id: string, options?: { signal?: AbortSignal; projectionMode?: 'none' }): Promise<{
    events: readonly SessionEventLike[]
    header?: { readonly id: string; readonly origin?: 'subagent' }
    inheritedEventCount?: number
    [Symbol.dispose](): void
  }> } | undefined
  get(name: 'agentTeams'): NativeTeams | undefined
  get(name: 'connection'): Connection | undefined
  get(name: 'approval'): { config: { policy?: 'ask' | 'never' }; overrideOf(session: NonNullable<Agent['session']>): 'ask' | 'never' | undefined; setPolicy(agent: Agent, policy: 'ask' | 'never'): void } | undefined
  get(name: 'workingDirectory'): { get(session: NonNullable<Agent['session']>): string } | undefined
  /** dsh-sandbox-policy：按会话解析文件沙箱模式（会话覆盖 > 部署默认）。 */
  get(name: 'sandboxPolicy'): { resolve(request?: { session?: NonNullable<Agent['session']> }): { mode: 'read-only' | 'workspace-write' | 'danger-full-access' } } | undefined
  get(name: 'subprocess'): Subprocess | undefined
  get(name: 'llm'): Llm | undefined
  /** dsh-agent-default-model：profile 的默认模型（接口人不再指定模型时回到它）。 */
  get(name: 'agentDefaultModel'): { currentSelection(): ModelSelection } | undefined
  /** 会话事件（dsh-session 的 session/event）；返回取消订阅。 */
  on?(name: 'session/event', listener: (session: { readonly id: string }, event: SessionEventLike) => void): () => void
  on?(name: 'tools/change', listener: () => void): () => void
  on?(name: 'agent/created', listener: (event: { readonly agent: Agent }) => void): () => void
  on?(name: 'agent/pre-step', listener: (event: {readonly agent: Agent}, next: () => Promise<StepDecision>) => Promise<StepDecision>, options?: {prepend?: boolean}): () => void
  on?(name: 'llm/stream', listener: (options: LlmToolRequest, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>, options?: {prepend?: boolean}): () => void
  on?(name: 'tools/execute', listener: (call: NativeToolCall, next: () => Promise<unknown>) => Promise<unknown>): () => void
  /** 工具执行前的策略瀑布（dsh-tools pipeline）：可等待；`deny` 的理由给模型看，之后不再执行 guard 与工具体。 */
  on?(name: 'tools/pre-execute', listener: (call: NativeToolCall, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>): () => void
  on?(name: 'approval/request', listener: (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>, options?: { prepend?: boolean }): () => void
  effect(fn: () => (() => void | Promise<void>) | void): void
}

/** Structural subset of the DSH attachment and file-upload services. */
export type NativeImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
export interface NativeFileRef { attachmentId: string; bytes: number; name: string }
export interface NativeImageRef {
  attachmentId: string; mediaType: NativeImageType; bytes: number; name?: string; width: number; height: number
  originalDimensions?: {width: number; height: number}
}
type FileStreamInput = {data: AsyncIterable<Uint8Array>; name?: string; signal?: AbortSignal}
export interface NativeAttachmentStore {
  readonly imageLimits: {
    maxImageBytes: number; maxImagesPerMessage: number; maxMessageImageBytes: number
    mediaTypes: readonly NativeImageType[]
  }
  saveFileStream(input: FileStreamInput): Promise<NativeFileRef>
  saveImage(input: {name?: string; data: Uint8Array; mediaType: NativeImageType}): Promise<NativeImageRef>
  readFileStream(ref: NativeFileRef, signal?: AbortSignal): AsyncIterable<Uint8Array>
  readImage(ref: NativeImageRef, signal?: AbortSignal): Promise<{data: Uint8Array; ref: NativeImageRef}>
  fileHostPath(ref: NativeFileRef): string | undefined
  imageHostPath(ref: NativeImageRef): string | undefined
}
export interface NativeFileUploads {
  resolve(agent: Agent, receiptId: string): unknown
  uploadStream(input: FileStreamInput & {sessionId: string}): Promise<{receiptId: string; file: NativeFileRef}>
  uploadImageStream(input: FileStreamInput & {sessionId: string; mediaType: NativeImageType}): Promise<{receiptId: string; image: NativeImageRef}>
}

/** DSH 0.2.2-rc.1 native TeamService. The kernel owns roster, inboxes and task lifecycle. */
export interface NativeTeamMember { id: string; name: string; role: 'lead' | 'teammate'; status: 'running' | 'inactive' | 'provisioning' | 'failed'; diagnostics: string[] }
export interface NativeTeams {
  listMembers(agent: Agent): NativeTeamMember[]
  listTasks(agent: Agent): { id: string; subject: string; status: string; revision: number; ownerName?: string }[]
  tryMembership(agent: Agent): { root: Agent; id: string; role: string; name: string } | undefined
  interrupt(agent: Agent, name: string): { previousStatus: string }
}
