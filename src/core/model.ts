/**
 * 领域模型。概念与 docs/DESIGN.md 第 2 节一一对应，这里不引入额外概念。
 * 所有类型都是可 JSON 序列化的普通数据：状态落在 brain 仓库的文件里，任何模型和人都能直接读。
 */
import type { SpeakerPortrait } from './workspace-avatars.ts'

/** 事件来源。`inbox` 是主人的投递，`clock` 是时钟规则与花名册来源，`timer` 是 agent 自己定的跟进，`remote` 是工作电脑回传，`system` 是插件自身。 */
export type SourceKind = 'inbox' | 'clock' | 'timer' | 'remote' | 'system'

/** 一条不可变事件。`dedupe` 相同的事件只入库一次。 */
export interface ChiefEvent {
  readonly id: string
  readonly at: string
  readonly source: SourceKind
  /** 幂等键，例如 `clock:morning-brief:2026-11-15T08:30`。 */
  readonly dedupe: string
  /** 事件正文，给研判看。 */
  readonly text: string
  /** 来源附带的结构化信息，例如时钟规则名、投递渠道、工单 id。 */
  readonly meta?: Record<string, string>
  /** 指向已有工单时（例如主人在工单上回复），直接并入该工单，不再研判。 */
  readonly ticketId?: string
  readonly superhubCommission?: SuperhubCommissionIntent
}

/** 研判结果的去向。 */
export type Disposition =
  | { readonly kind: 'pending' }
  /** 只记录：来源处于观察模式，事件留痕但不研判；主人可以手动放行。 */
  | { readonly kind: 'observed' }
  | { readonly kind: 'ignored'; readonly reason: string }
  | { readonly kind: 'noted'; readonly path: string; readonly reason?: string }
  | { readonly kind: 'attached'; readonly ticketId: string; readonly reason?: string }
  | { readonly kind: 'accepted'; readonly ticketId: string; readonly reason?: string }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** 授权强度：主人明确要求，或时钟规则授权。 */
export type Strength = 'explicit' | 'rule'

/** 动作级别：决定执行前要不要问主人（DESIGN.md 第 3 节）。 */
export type Level = 'think' | 'write' | 'propose'

/** 接单时写下的不可变授权。扩大范围必须开新工单。 */
export interface Mandate {
  readonly strength: Strength
  readonly level: Level
  /** 工作范围，一两句话。 */
  readonly scope: string
  /** 可核验的完成标准；执行者和审查官都以它为准。 */
  readonly doneWhen: readonly string[]
  /** 核验通过后是否仍需主人验收。 */
  readonly needsReview: boolean
  /** 触发接单的事件。 */
  readonly eventId: string
}

export type CriterionMethod = 'delivery' | 'native'

export interface AcceptanceCriterionInput {
  readonly id?: string
  readonly text: string
  readonly required?: boolean
  readonly method?: CriterionMethod
}

export interface AcceptanceCriterion {
  readonly id: string
  readonly text: string
  readonly required: boolean
  readonly method: CriterionMethod
}

export interface AcceptanceContract {
  readonly version: number
  readonly createdAt: string
  readonly scope: string
  readonly allowed: readonly string[]
  readonly denied: readonly string[]
  readonly needsReview: boolean
  readonly staff: string
  readonly verifier?: string
  readonly criteria: readonly AcceptanceCriterion[]
  readonly reason?: string
  readonly approvedBy?: { readonly assignmentId: string | null; readonly threadId: string }
}

export interface SuperhubCommission {
  readonly brainScope: string
  readonly sourceId: string
  readonly commandId: string
  readonly criteria?: readonly AcceptanceCriterionInput[]
  readonly allowed?: readonly string[]
  readonly denied?: readonly string[]
  /** 非 propose 级别（例如界面师在插件源码工作区的 write）也要主人先批准才执行。旧交办没有此字段。 */
  readonly approvalRequired?: boolean
}

/** The trigger event keeps the authorized request so the ticket can be recovered after a partial write. */
export interface SuperhubCommissionIntent {
  readonly brainScope: string
  readonly sourceId: string
  readonly commandId: string
  readonly requestKey?: string
  readonly title: string
  readonly staff: string
  readonly level: Level
  readonly priority: number
  readonly workspace?: string
  readonly lineId?: string
  readonly related?: Ticket['related']
  readonly contract: Omit<AcceptanceContract, 'createdAt' | 'version'>
  /** 只在为 true 时出现，旧交办的意图哈希不变。 */
  readonly approvalRequired?: true
}

export interface SuperhubTicket {
  readonly brainScope: string
  readonly sourceId: string
  readonly commandId: string
  /** 开单时登记：批准前零执行（stageOf 返回 you/approve），与 propose 级别相同。 */
  readonly approvalRequired?: true
  readonly contracts: AcceptanceContract[]
  ownerAcceptance?: {
    readonly at: string
    readonly assignmentId: string
    readonly contractVersion: number
    readonly kind: 'accepted' | 'deviation'
    readonly reason?: string
  }
}

export interface DeliveryVersion { readonly path: string; readonly version: string }

/** Emitted by the host, never read from model output. */
export interface NativeEvidence {
  readonly id: string
  readonly version: string
  readonly method: string
  readonly at: string
}

export type CriterionEvidence =
  | (DeliveryVersion & { readonly kind: 'delivery' })
  | (NativeEvidence & { readonly kind: 'native' })

export interface CriterionResult {
  readonly criterionId: string
  readonly status: 'pass' | 'fail' | 'unverified' | 'not_applicable' | 'disputed'
  readonly evidence: readonly CriterionEvidence[]
  readonly comment?: string
}

export type ReportStatus = 'ready' | 'question' | 'blocked' | 'failed' | 'dropped'

/** 执行者结束时的结构化汇报。 */
export interface Report {
  readonly status: ReportStatus
  readonly summary: string
  /** `question` 时给主人的一个具体问题。 */
  readonly question?: string
  /** 具体问题的可选快捷回复；仅填写可编辑草稿，不代表提交或批准。 */
  readonly choices?: string[]
  /** 产出文件路径（相对 brain 根目录或绝对路径）。 */
  readonly outputs?: readonly string[]
  /** 汇报是否来自约定的 chief-report 块；为 false 时说明是从自由文本推断的。 */
  readonly structured: boolean
}

export type Verdict = 'pass' | 'revise' | 'fail'

/** 审查官在独立上下文中的判定。 */
export interface Verification {
  readonly verdict: Verdict
  /** 逐条对照完成标准的意见；`revise` 时作为返工输入。 */
  readonly critique: string
  readonly status?: 'completed' | 'skipped' | 'failed' | 'unverified' | 'invalidated'
  readonly criteria?: readonly CriterionResult[]
  readonly contractVersion?: number
  readonly reviewer?: ExecutionRef
}

export type AssignmentState = 'running' | 'reported' | 'interrupted' | 'cancelled'

/** 宿主实际返回的执行标识。外部执行者的激活不冒充可聊天的 DSH 会话。 */
export interface ExecutionRef {
  readonly provider: string
  readonly activationId: string
  readonly sessionId?: string
}

export interface ExecutionAttempt {
  readonly kind: 'execute' | 'verify'
  readonly number: number
  readonly startedAt: string
  endedAt?: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  execution?: ExecutionRef
}

export interface StaleResult {
  readonly id: string
  readonly at: string
  readonly kind: 'execution' | 'review' | 'remote'
  readonly contractVersion: number
  readonly stopReason?: string
  readonly note?: string
}

/** 工单与一次执行的绑定。每次派工都是全新上下文。 */
export interface Assignment {
  readonly id: string
  readonly staff: string
  readonly executor: string
  /** 第几轮：0 是首次执行，之后每次返工加一。 */
  readonly round: number
  readonly startedAt: string
  readonly role?: Staff
  readonly contractVersion?: number
  state: AssignmentState
  endedAt?: string
  report?: Report
  verification?: Verification
  verifiedAt?: string
  verifier?: string
  execution?: ExecutionRef
  reviewExecution?: ExecutionRef
  attempts?: ExecutionAttempt[]
  nativeEvidence?: readonly NativeEvidence[]
  staleResults?: StaleResult[]
  verificationInvalidated?: { readonly at: string; readonly reason: string }
  commandApprovals?: CommandApprovalEvent[]
  /** 审查环节本身出问题（审查官不可用或失败）时，不再返工，直接交给主人验收。 */
  deliveries?: readonly DeliveryVersion[]
  receipt?: string
  handedToOwner?: boolean
  /** 执行者原始输出的末尾片段，便于读轨迹。 */
  tail?: string
}

export type CommandApprovalStatus = 'requested' | 'allowed-once' | 'rejected' | 'expired' | 'cancelled' | 'out-of-scope' | 'unsupported'
/** Owner-visible context recorded with a request: a one-line command summary and the configured expiry window. */
export interface CommandApprovalDetail { command?: string; timeoutMinutes?: number }
export interface CommandApprovalEvent extends CommandApprovalDetail { id: string; at: string; status: CommandApprovalStatus }

export interface ExecutionGroup { key: string; title: string; scope: string }

/** 投递到工单的输入：主人的回复、返工意见、批准等。 */
export interface Input {
  /** 系统输入的持久幂等键。 */
  readonly key?: string
  readonly at: string
  readonly from: 'owner' | 'verifier' | 'system'
  readonly text: string
  /** 主人明确回复的是哪次派工；null 表示尚未派工。用于持久去重与过期校验。 */
  readonly replyTo?: string | null
  readonly contractVersion?: number
  /** 已被某次派工带走。 */
  consumedBy?: string
}

export type TicketOutcome = 'done' | 'dropped' | 'stopped' | 'failed'

export interface Ticket {
  /** 工单讨论的稳定身份，与一次执行或接口人会话无关。旧工单按不可变开单事件兼容。 */
  readonly threadId?: string
  readonly superhub?: SuperhubTicket
  /** 只经显式关联写入，旧工单不推断归属。 */
  related?: { ticketId: string; discussionId: string; path: string; version: string }
  remoteBrief?: string
  /** 关联委派与仅限中心处理的工单，保存开单时的执行边界，角色改配置不扩张授权。 */
  executionBoundary?: 'local' | 'remote'
  /** 讨论移交时核对的执行器，派工前再次检查。 */
  requestedExecutor?: string
  lineId?: string
  /** 委派关系写在子工单内，重启可重建父工单等待与唤醒。 */
  parent?: { ticketId: string; assignmentId: string; key: string; criterion: number; criterionId?: string; criterionText?: string; contractVersion?: number }
  waitingFor?: string[]
  executionPlan?: { assignmentId: string; groups: ExecutionGroup[]; checkpoint: string }
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly mandate: Mandate
  /** 负责的幕僚。 */
  staff: string
  /** `propose` 级别工单是否已获主人批准。 */
  approvedAt?: string
  assignments: Assignment[]
  inputs: Input[]
  /** 关联的事件 id（接单事件和后续并入的事件）。 */
  events: string[]
  ended?: { readonly at: string; readonly outcome: TicketOutcome; readonly note: string }
  /** 排队优先级，越大越先执行。 */
  priority: number
  /** level=write 时允许修改的工作区。 */
  workspace?: string
}

export const threadIdOf = (ticket: Ticket): string => ticket.threadId ?? `ticket:${ticket.mandate.eventId}:${ticket.id}`
export const threadBoundaryOf = (ticket: Ticket, executor?: string): 'local' | 'remote' =>
  ticket.executionBoundary ?? ((ticket.assignments[0]?.executor ?? executor) === 'remote' ? 'remote' : 'local')

/** 研判的结构化输出。 */
export type Decision =
  | { readonly action: 'ignore'; readonly reason: string }
  | { readonly action: 'note'; readonly path: string; readonly content: string; readonly reason?: string }
  | { readonly action: 'attach'; readonly ticketId: string; readonly text: string }
  | {
      readonly action: 'accept'
      readonly reason?: string
      readonly title: string
      readonly staff: string
      readonly level: Level
      readonly scope: string
      readonly doneWhen: readonly string[]
      readonly needsReview: boolean
      readonly priority: number
      readonly workspace?: string
    }

/** 幕僚角色卡（brain/staff/*.md）。 */
export interface Staff {
  readonly id: string
  readonly name: string
  /** 执行者：`dsh`、`claude-code`、`codex`、`remote`。 */
  readonly executor: string
  /** 可选模型覆盖，例如 `zhipu/glm-5.3`。 */
  readonly model?: string
  /** 可选思考深度（所选模型 reasoning.efforts 里的 id）；只在指定了模型时有效，缺省为模型默认。 */
  readonly reasoningEffort?: string
  /** 核验由哪位幕僚负责；缺省为 `reviewer`。为 `none` 时跳过核验。 */
  readonly verifier: string
  /** 角色卡正文：职责、做事方式。 */
  readonly brief: string
  /** 新建时确定的头像，可在 SuperHub 用手选头像覆盖。 */
  readonly defaultPortrait?: SpeakerPortrait
}
