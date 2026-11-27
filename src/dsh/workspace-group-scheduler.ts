/**
 * 工作区群聊的确定性调度器（任务 design §3）：谁来回答、一人一事、接力、后台干活、批次收回、[PASS]、
 * 续推、空转守卫、无动静超时、轮中主人发言、叫停。规则照搬 DS-Bot `ds-bot/src/host/groups.js` / `turns.js`，
 * 出处行号见任务 research/dsbot-group-chat.md。
 *
 * 纯逻辑：时钟由调用方注入，状态是一个可整存整取的 JSON 对象（`snapshot()`，重启后原样传回），
 * 唯一的外部写入是账本的 `say()`（GroupSay）。需要宿主去做的事以效果（`GroupEffect`）返回：
 * 开始一位成员的回合、同一会话续推一次、取消在跑的回合、唤醒派活者、转入后台、写了事件行。
 *
 * 与 DS-Bot 的结构差异：DS-Bot 一群同时跑「一轮」，轮内有 slot；这里没有轮，成员各自排队，
 * 主人的话任何时候都立即入账本并叫该叫的人（等同 DS-Bot 把用户消息并入进行中的轮，groups.js:1355-1377）。
 * 宿主上报成员回合里的事件时用 `start` 效果给出的 `callId`，被叫停或已结束的回合迟到的上报一律忽略。
 */
import { parseMentions, type Mentionable } from '../core/mentions.ts'
import type { GroupLine, GroupLineInput, GroupSay } from './workspace-group-ledger.ts'

/** 时限与上限，数值与 DS-Bot 一致。 */
export const GROUP_LIMITS = {
  /** 成员会话完全无事件这么久算超时（constants.js:38 `ROOM_REPLY_TIMEOUT_MS`；research §4「4 分钟超时」）。 */
  replyTimeoutMs: 240_000,
  /** 干活中途间隔小于这么久的几句合成一条（constants.js:39-40 `ROOM_STEP_GAP_MS`；research §4「@ 立即生效」）。 */
  stepGapMs: 30_000,
  /** 首次调用非团队工具后仍在干这么久，转入后台（constants.js:91-93 `ROOM_WORK_GRACE_MS`；research §4「15 秒放手」）。 */
  workGraceMs: 15_000,
  /** 成员之间连续这么多次 0 工具空转后暂停自动叫人（constants.js:94-96 `ROOM_IDLE_RELAY_LIMIT`；research §4「空转守卫」）。 */
  idleRelayLimit: 6,
  /** 空转判定只看这么短的话（groups.js:60 `IDLE_TEXT_MAX`）。 */
  idleTextMax: 45,
  /** 「收到/我去查」续推只看这么短的话（turns.js:299 `promisesWork` 的 240 字）。 */
  promiseTextMax: 240,
  /** 群成员上限（constants.js:59 `ROOM_MAX_MEMBERS`）。 */
  maxMembers: 12,
} as const
export type GroupLimits = { [K in keyof typeof GROUP_LIMITS]: number }

export const OWNER_ID = 'owner'
export const OWNER_NAME = '主人'
/** 宿主自己写的事件行与唤醒的发起者。 */
export const HOST_ID = 'host'
export const HOST_NAME = 'SuperHub'

/** 只承诺开工、没调工具就结束时，同一会话续推的话（turns.js:271 `RETRY_PROMISE_TEXT`）。 */
export const CONTINUE_TEXT = '你上一句说要开工，但这一轮没有调用任何工具就结束了，所以什么都没执行。现在调用需要的工具把活做完；如果上一句已经是完整回答，回 [PASS]，那句话会留在群里。'

// ---------------------------------------------------------------------------------------------
// 文字判定（纯函数）

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 模型常照着记录格式回「名字：……」，去掉自己名字的前缀（groups.js:130）。 */
export const stripOwnName = (name: string, text: string) =>
  text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()

/** 空回复或 `[PASS]` / `【pass】` / `(pass)` 开头，或整句就是 pass（groups.js:131）。 */
export const isPass = (text: string) => text === '' || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(text)

// turns.js:292-299：只承诺开工、不调工具也不 @ 人的回复；「过了/完了/完毕/好了」表示已做完，不算。
const PROMISED_WORK = /(?:^(?:收到|好的|明白|好|行|没问题|了解)[，,、。.!！：\s]*(?:我(?:现在|这就|先|马上|立刻|去|来)?(?:开始|着手|去|来|准备)?(?:排查|检查|调查|查看|看看|搜索|搜一下|分析|处理|执行|运行|跑一下|修改|修复|实现|编写|整理|验证|测试|读一下|翻一下)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了)|(?:现在|马上|立刻)?(?:开始|着手)(?:执行|处理|排查|检查|调查|干活|开工)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了)|开工(?:[。！!，,\s]|$))|^(?:开工(?:[。！!，,\s]|$)|我(?:现在|这就|先|马上|立刻)(?:开始|着手|去)(?:排查|检查|调查|查看|搜索|分析|处理|执行|运行|修改|修复|实现|编写|整理|验证|测试)(?!过了|过(?:[，,。.!！、；;\s]|$)|完了|完毕|好了))|\b(?:(?:i\s+will|i'll|let\s+me|going\s+to)\s+(?:start|begin|check|look\s+into|investigate|search|run|inspect|read|fix|implement|work\s+on)\b|(?:starting|beginning)\s+(?:the\s+)?(?:investigation|check|search|work|execution|analysis)\b|^on\s+it[,.\s!]+(?:i'll|i\s+will|let\s+me|starting|checking)\b))/i
export const promisesWork = (text: unknown) => typeof text === 'string' && text.trim().length <= GROUP_LIMITS.promiseTextMax && PROMISED_WORK.test(text.trim())

// groups.js:44-59：客套、收尾与「待命」类的话。
const IDLE_ACK_WORDS = "收到|好的|好|明白|明白了|了解|了解了|没问题|谢谢|多谢|感谢|辛苦了|辛苦|不客气|不用谢|完毕|完成|好嘞|行|ok|okay|got\\s+it|understood|noted|thanks|thank\\s+you|you\\s+are\\s+welcome|you're\\s+welcome|welcome|np|no\\s+problem|roger|ack|done|all\\s+good|sounds\\s+good"
const IDLE_STATUS_WORDS = [
  '(?:收口)?(?:当前|目前|今日|今天)*(?:暂无|没有|无)+(?:待办|任务|新进展|新内容|进展|动作|变化|安排)',
  '待命', '保持待命', '继续待命', '原地待命', '静候', '静候下一步', '静候指令', '等候指令',
  '等待指令', '等待指示', '等待下一步', '等待安排', '等待新任务', '无事可做', '空转',
  'standby', 'standing\\s+by', 'idle', 'nothing\\s+(?:pending|to\\s+do|new)',
  'no\\s+pending\\s+(?:tasks?|work)', 'no\\s+new\\s+(?:work|tasks?|progress|updates?)',
  'no\\s+changes?', 'no\\s+updates?', 'waiting\\s+for\\s+(?:instructions?|the\\s+next\\s+steps?)',
].join('|')
const IDLE_BODY = new RegExp(`^(?:(?:${IDLE_ACK_WORDS}|${IDLE_STATUS_WORDS})(?:[\\s，,、。.!！~～：:；;]+|$))+$`, 'i')

/** 去掉 `@` 与标点后的正文，用于比较是否重复（groups.js:61-68）。 */
export function normalizeRelayBody(text: string, everyone: readonly Mentionable[]) {
  let out = String(text ?? '')
  for (const member of everyone) {
    out = out.replace(new RegExp(`@${escapeRegExp(member.name)}\\b`, 'gi'), '')
    out = out.replaceAll(`@${member.name}`, '')
  }
  return out.replace(/@(?:all|everyone|所有人|全体)/gi, '').replace(/[\s，,、。.!！?？;；:：'"“”‘’()（）[\]【】~～-]+/g, ' ').trim().toLowerCase()
}

/** 空转：去掉 `@` 和标点后为空，或很短且全是客套/待命，或与该成员之前的发言重复、互相包含（groups.js:69-73）。 */
export function isIdleRelayText(text: string, everyone: readonly Mentionable[], priorBodies: readonly string[]) {
  const norm = normalizeRelayBody(text, everyone)
  if (norm === '' || (norm.length <= GROUP_LIMITS.idleTextMax && IDLE_BODY.test(norm))) return true
  return priorBodies.some(prev => prev !== '' && (prev === norm || (prev.length >= 8 && norm.length >= 8 && (prev.includes(norm) || norm.includes(prev)))))
}

// ---------------------------------------------------------------------------------------------
// 状态与效果

export interface GroupMember extends Mentionable {
  /** 管理员（接口人）：没 `@` 的主人消息先给它，它说的全员词才叫全员。 */
  admin?: boolean
}

/** `queued` 排队；`speaking` 正在答；`working` 15 秒后转入后台仍在干；`approval` 等主人批准；`missed` 无动静超时、会话仍在跑。 */
export type GroupCallStatus = 'queued' | 'speaking' | 'working' | 'approval' | 'missed'
export type GroupCallReason = 'owner' | 'mention' | 'all' | 'wake' | 'unpark'

export interface GroupCall {
  id: string
  /** Liaison relays sent to the conversation keep their no-order destination when calls queue or steer. */
  exactScope?: true
  memberId: string
  /** 谁叫的：`owner`、成员 id，或宿主唤醒/解除挂起的 `host`。 */
  by: string
  reason: GroupCallReason
  /** 给成员提示的一句话：谁叫了你、为什么。 */
  note: string
  /** 叫它的那一行。 */
  triggerSeq: number
  batchId?: string
  workOrderId?: string
  /** 唤醒派活者时：完成的人与结果行。 */
  done?: string[]
  results?: number[]
  /** 同一条消息里一起被叫、同时在答的人。 */
  coAnswering: string[]
  status: GroupCallStatus
  queuedAt: number
  startedAt?: number
  lastEventAt?: number
  firstWorkAt?: number
  /** 本回合调过的工具数（含团队工具）；`worked`：调过非团队工具，算真干活。 */
  toolCalls: number
  worked: boolean
  /** 已续推过一次。 */
  retried: boolean
  /** 本回合已叫过的成员（一回合每人只叫一次）。 */
  called: string[]
  /** 本回合写进账本的行（批次结果）。 */
  posted: number[]
  /** 暂存、尚未发出的中途发言。 */
  held: string[]
  lastFlushAt: number
  lastLine?: string
  lastPosted?: string
  engagement?: { generation?: number }
}

export interface GroupBatch {
  id: string
  /** 派活者：`owner` 或成员 id。主人直接叫的批次落地后不唤醒任何人。 */
  by: string
  pending: string[]
  done: string[]
  results: number[]
  /** 批次内有人真调过工具。 */
  worked: boolean
  /** 有人在结果里又 `@` 了人：接力已有人接，不再唤醒派活者。 */
  answered: boolean
  triggerSeq: number
  workOrderId?: string
  createdAt: number
}

export interface ParkedCall { memberId: string; by: string; reason: 'mention' | 'all'; note: string; triggerSeq: number; workOrderId?: string }

export interface GroupSchedulerState {
  /** Once the group uses input materials, native calls and batches stay within their order. */
  inputScoped?: true
  version: 1
  nextId: number
  calls: GroupCall[]
  batches: GroupBatch[]
  /** Dispatch receipts share the same durable write as their queued calls. */
  engagementDispatches?: Record<string, true>
  /** 空转守卫挂起的叫人，主人发言后才放行。 */
  parked: ParkedCall[]
  idle: {
    /** 群级连续空转次数，跨批次累计。 */
    streak: number
    /** `reason`：写进账本的那行原因（`seq`），界面原样显示；较早的状态没有这两项。 */
    paused?: { from: string; count: number; at: number; reason?: string; seq?: number }
    /** 每位成员自主人上次发言以来说过的话（去标点后），用于判断重复。 */
    bodies: Record<string, string[]>
  }
}

export type GroupEffect =
  | { type: 'start'; callId: string; memberId: string; by: string; reason: GroupCallReason; note: string; triggerSeq: number
    batchId?: string; workOrderId?: string; coordinated?: true; coAnswering: string[]; done?: string[]; results?: number[] }
  | { type: 'continue'; callId: string; memberId: string; text: string }
  | { type: 'cancel'; callId: string; memberId: string }
  /**
   * 批次落地、派活者该被唤醒了。`held`：工单批次的派活者是管理员且宿主要先验收（`holdOrderWakes`），这时调度器
   * 没有叫它，由宿主验收后发言，或调 `wakeNow` 照常唤醒。
   */
  | { type: 'wake'; memberId: string; batchId: string; done: string[]; results: number[]; workOrderId?: string; held?: true; triggerSeq: number }
  /** 主人的话要交给正在干活的成员：宿主把它送进那一回合；送不进时调 `steerFailed`，改为排队叫它。 */
  | { type: 'steer'; callId: string; memberId: string; seq: number; reason: GroupCallReason; note: string; workOrderId?: string }
  | { type: 'background'; callId: string; memberId: string }
  /** 写了一行事件；成员回合没做完（`failed` / `interrupted`）时带那一回合的成员与工单。 */
  | { type: 'event'; event: GroupEventReason; seq: number; text: string; memberId?: string; workOrderId?: string }

export type GroupEventReason = 'missed' | 'paused' | 'stopped' | 'admin-passed' | 'failed' | 'interrupted'

export type FinishStatus = 'completed' | 'failed' | 'cancelled'

export interface MemberActivity {
  memberId: string; status: GroupCallStatus | 'idle'; callId?: string; since?: number; queued: number
  /** 在跑的那一回合：谁叫的、为什么、为哪张工单。 */
  note?: string; by?: string; workOrderId?: string
}

export const emptyGroupSchedulerState = (): GroupSchedulerState => ({ version: 1, nextId: 1, calls: [], batches: [], parked: [], idle: { streak: 0, bodies: {} } })

const RUNNING: readonly GroupCallStatus[] = ['speaking', 'working', 'approval', 'missed']
const plainCaller = (by: string) => by === OWNER_ID || by === HOST_ID
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export interface GroupSchedulerOptions {
  inputScoped?: boolean
  idPrefix?: string
  members: readonly GroupMember[]
  say: GroupSay
  now?: () => number
  state?: GroupSchedulerState
  limits?: Partial<GroupLimits>
  /** 管理员派出的工单批次落地时先不叫它，由宿主验收（见 `wake` 效果的 `held`）。 */
  holdOrderWakes?: boolean
  engage?: (workOrderId: string | undefined, memberId?: string) => { generation?: number } | undefined
  checkOwnerQuestions?: boolean
  canPublish?: (call: GroupCall) => boolean
}

export class GroupScheduler {
  private state: GroupSchedulerState
  private retired = false
  private readonly idPrefix: string
  private members: GroupMember[] = []
  private readonly say: GroupSay
  private readonly now: () => number
  private readonly holdOrderWakes: boolean
  private readonly engage: GroupSchedulerOptions['engage']
  private readonly checkOwnerQuestions: boolean
  private readonly canPublish: GroupSchedulerOptions['canPublish']
  readonly limits: GroupLimits

  constructor(options: GroupSchedulerOptions) {
    this.idPrefix = options.idPrefix ?? ''
    this.say = options.say
    this.now = options.now ?? Date.now
    this.holdOrderWakes = options.holdOrderWakes === true
    this.engage = options.engage
    this.checkOwnerQuestions = options.checkOwnerQuestions === true
    this.canPublish = options.canPublish
    this.limits = { ...GROUP_LIMITS, ...options.limits }
    this.state = options.state ? clone(options.state) : emptyGroupSchedulerState()
    if (options.inputScoped) this.state.inputScoped = true
    if (this.state.version !== 1) throw new Error('群调度状态的版本不认识。')
    this.useMembers(options.members)
  }

  /** 可整存整取的状态（深拷贝）。 */
  snapshot(): GroupSchedulerState { return clone(this.state) }

  restore(snapshot: GroupSchedulerState) { this.state = snapshot }

  currentEngagement(call: GroupCall): boolean {
    return call.engagement?.generation === undefined ||
      call.engagement.generation === this.engage?.(call.workOrderId, call.memberId)?.generation
  }

  private pruneStaleEngagements() {
    const stale = this.state.calls.filter(call => !this.currentEngagement(call))
    if (!stale.length) return
    const batches = new Set(stale.map(call => call.batchId))
    for (const call of stale) this.removeCall(call)
    for (const batch of this.state.batches) {
      if (!batches.has(batch.id)) continue
      this.prune(batch)
      if (!batch.pending.length) this.dropBatch(batch)
    }
  }

  sameOrder(left: string | undefined, right: string | undefined): boolean {
    if (left === right) return true
    return !this.state.inputScoped && !(left && this.engage?.(left)) && !(right && this.engage?.(right))
  }

  // -------------------------------------------------------------------------------------------
  // 成员

  private useMembers(members: readonly GroupMember[]) {
    const ids = new Set<string>()
    for (const member of members) {
      if (!member.id || member.id === OWNER_ID || member.id === HOST_ID || ids.has(member.id)) throw new Error(`群成员 id 无效或重复：${member.id}`)
      ids.add(member.id)
    }
    if (members.filter(member => member.admin).length > 1) throw new Error('一个群只能有一位管理员。')
    this.members = members.map(member => ({ ...member }))
  }

  private member(id: string) { return this.members.find(member => member.id === id) }
  private nameOf(id: string) { return id === OWNER_ID ? OWNER_NAME : id === HOST_ID ? HOST_NAME : this.member(id)?.name ?? id }
  private get admin() { return this.members.find(member => member.admin) }
  private isMember(id: string) { return this.member(id) !== undefined }

  /** 成员变动（幕僚进出工作区）：离群的人在跑的回合取消，排队与挂起的叫人作废，离开所有批次。 */
  setMembers(members: readonly GroupMember[]): GroupEffect[] {
    this.useMembers(members)
    const effects: GroupEffect[] = []
    for (const call of [...this.state.calls]) {
      if (this.isMember(call.memberId)) continue
      if (RUNNING.includes(call.status)) effects.push({ type: 'cancel', callId: call.id, memberId: call.memberId })
      this.removeCall(call)
    }
    this.state.parked = this.state.parked.filter(entry => this.isMember(entry.memberId))
    for (const batch of [...this.state.batches]) {
      if (batch.by !== OWNER_ID && !this.isMember(batch.by)) { this.dropBatch(batch); continue }
      this.prune(batch)
      if (batch.pending.length === 0) this.settle(batch, effects)
    }
    this.pump(effects)
    return effects
  }

  // -------------------------------------------------------------------------------------------
  // 主人发言

  /**
   * 主人发言：立即入账本；有 `@` 只叫被点名的（并行），全员词叫全员（管理员在前、并行），没 `@` 只叫管理员。
   * 主人发言解除空转暂停并放行挂起的叫人（groups.js:1355-1377, :1314-1335；openingCall :2069-2091）。
   * `steer`：该叫的人正在干活时不排队，给出 `steer` 效果，让宿主把这句话立即送进它在跑的回合（主人的话要马上到）。
   */
  ownerSaid(input: { text: string; workOrderId?: string; attachments?: GroupLineInput['attachments']; inputAttachments?: GroupLine['inputAttachments']; requestId?: string; steer?: boolean }): { line: GroupLine; effects: GroupEffect[] } {
    const line = this.recordOwner(input)
    return { line, effects: this.ownerLine(line, { ...input.steer && { steer: true } }) }
  }

  recordOwner(input: {text: string; workOrderId?: string; attachments?: GroupLineInput['attachments']; inputAttachments?: GroupLineInput['inputAttachments']; requestId?: string}) {
    const { ids, all } = parseMentions(input.text, this.members)
    return this.say.say({
      kind: 'message', speakerId: OWNER_ID, author: OWNER_NAME, text: input.text, mentions: ids,
      ...all && { all: true as const },
      ...input.workOrderId !== undefined && { workOrderId: input.workOrderId },
      ...input.attachments !== undefined && { attachments: input.attachments },
      ...input.inputAttachments?.length && { inputAttachments: input.inputAttachments },
      ...input.requestId !== undefined && { requestId: input.requestId },
    })
  }

  /**
   * 按主人已经在账本里的一行叫人（`ownerSaid` 的后半；也用于主人选择把接口人留下的话交出去）。
   */
  ownerLine(line: Pick<GroupLine, 'seq' | 'text' | 'workOrderId' | 'inputAttachments'>, { steer = false }: { steer?: boolean } = {}): GroupEffect[] {
    if (line.inputAttachments?.length) this.state.inputScoped = true
    const effects: GroupEffect[] = []
    const { ids, all } = parseMentions(line.text, this.members)
    this.state.idle = { streak: 0, bodies: {} }
    const admin = this.admin
    let callees: string[]
    let reason: GroupCallReason
    if (all) {
      callees = [...(admin ? [admin.id] : []), ...this.members.filter(member => member !== admin).map(member => member.id)]
      reason = 'all'
    } else if (ids.length > 0) {
      callees = ids
      reason = 'mention'
    } else {
      callees = admin ? [admin.id] : this.members.map(member => member.id)
      reason = 'owner'
    }
    const note = reason === 'owner' ? '主人发了新消息' : reason === 'all' ? '主人叫了所有人' : '主人 @ 了你'
    const workOrderId = line.workOrderId
    if (steer) {
      for (const id of [...callees]) {
        const busy = this.state.calls.find(call => call.memberId === id &&
          (call.exactScope ? call.workOrderId === workOrderId : this.sameOrder(call.workOrderId, workOrderId)) && RUNNING.includes(call.status))
        if (!busy) continue
        callees = callees.filter(other => other !== id)
        effects.push({ type: 'steer', callId: busy.id, memberId: id, seq: line.seq, reason, note, ...workOrderId !== undefined && { workOrderId } })
      }
    }
    this.callIn(callees, { by: OWNER_ID, reason, note, triggerSeq: line.seq, ...workOrderId !== undefined && { workOrderId } })
    this.releaseParked()
    this.pump(effects)
    return effects
  }

  /** 主人的话没能送进成员在跑的回合（回合刚结束、协议拒绝）：照常排队叫它，主人的叫人排在最前。 */
  steerFailed(effect: Extract<GroupEffect, { type: 'steer' }>): GroupEffect[] {
    const effects: GroupEffect[] = []
    this.callIn([effect.memberId], { by: OWNER_ID, reason: effect.reason, note: effect.note, triggerSeq: effect.seq,
      ...effect.workOrderId !== undefined && { workOrderId: effect.workOrderId } })
    this.pump(effects)
    return effects
  }

  /**
   * 宿主以成员身份写一行（接口人的交办、补充、验收追问）：其中的 `@` 照常叫人，派活者是这位成员，落地后收回批次；
   * 管理员说全员词叫全员。`onBehalfOfOwner`：这是主人的交办，像主人发言一样解除空转暂停。同一 `ref` 只写一次。
   */
  memberSaid(memberId: string, input: { text: string; workOrderId?: string; quote?: GroupLine['quote']; inputAttachments?: GroupLine['inputAttachments'];
    ref?: string; onBehalfOfOwner?: boolean; experienceRefs?: GroupLine['experienceRefs'] }): { line: GroupLine; effects: GroupEffect[] } {
    if (input.inputAttachments?.length) this.state.inputScoped = true
    const member = this.member(memberId)
    if (!member) throw new Error(`群里没有这位成员：${memberId}`)
    const effects: GroupEffect[] = []
    const { ids: found, all } = parseMentions(input.text, this.members, { except: member.id })
    const line = this.say.say({
      kind: 'message', speakerId: member.id, author: member.name, text: input.text, mentions: found,
      ...all && { all: true as const },
      ...input.workOrderId !== undefined && { workOrderId: input.workOrderId },
      ...input.quote !== undefined && { quote: input.quote },
      ...input.inputAttachments?.length && { inputAttachments: input.inputAttachments },
      ...input.ref !== undefined && { ref: input.ref },
      ...input.experienceRefs && { experienceRefs:input.experienceRefs },
    })
    if (input.onBehalfOfOwner) {
      this.state.idle = { streak: 0, bodies: {} }
      this.releaseParked()
    }
    const others = this.members.filter(other => other.id !== member.id).map(other => other.id)
    const callees = member.admin && all ? [...found, ...others.filter(id => !found.includes(id))] : found
    if (callees.length) {
      const named = callees.filter(id => found.includes(id)), rest = callees.filter(id => !found.includes(id))
      const base = { by: member.id, triggerSeq: line.seq, coAnswering: callees, ...input.workOrderId !== undefined && { workOrderId: input.workOrderId } }
      if (named.length) this.callIn(named, { ...base, reason: 'mention', note: `${member.name} @ 了你` })
      if (rest.length) this.callIn(rest, { ...base, reason: 'all', note: `${member.name} 叫了所有人` })
    }
    this.pump(effects)
    return { line, effects }
  }

  /**
   * 叫一位成员来回应账本里的某一行（宿主替主人叫：例如一句话交办没点名幕僚时，叫接口人按分工派活）。
   * 叫人者记为主人，所以它落地后不唤醒任何人；它自己 `@` 出去的活照常按批次收回、唤醒它。
   */
  callFor(memberId: string, spec: { triggerSeq: number; note: string; workOrderId?: string }): GroupEffect[] {
    const effects: GroupEffect[] = []
    this.callIn([memberId], { by: OWNER_ID, reason: 'owner', note: spec.note, triggerSeq: spec.triggerSeq, ...spec.workOrderId !== undefined && { workOrderId: spec.workOrderId } })
    this.pump(effects)
    return effects
  }

  forwardEngagementOwner(request: string, line: GroupLine): GroupEffect[] {
    const receipts = this.state.engagementDispatches ??= {}
    if (Object.hasOwn(receipts, request)) return []
    const effects = this.ownerLine(line)
    receipts[request] = true
    return effects
  }

  forwardEngagementMember(request: string, line: GroupLine): GroupEffect[] {
    const receipts = this.state.engagementDispatches ??= {}
    if (Object.hasOwn(receipts, request) || !this.isMember(line.speakerId)) return []
    const effects: GroupEffect[] = []
    this.callFrom({memberId: line.speakerId, by: line.engagement?.by ?? HOST_ID, called: [], worked: false,
      workOrderId: line.workOrderId}, line.text, line.seq, effects)
    receipts[request] = true
    this.pump(effects)
    return effects
  }

  /** Queue one recorded liaison decision. A replay uses the same ledger line and receipt. */
  dispatchEngagement(request: string, memberIds: string[], spec: { triggerSeq: number; note: string; workOrderId?: string; exactScope?: true }): GroupEffect[] {
    const receipts = this.state.engagementDispatches ??= {}
    if (Object.hasOwn(receipts, request)) return []
    const effects: GroupEffect[] = []
    this.callIn(memberIds, { by: HOST_ID, reason: 'wake', ...spec })
    receipts[request] = true
    this.pump(effects)
    return effects
  }

  /** 宿主验收不了（或不需要）被扣下的唤醒：照常叫派活者一次（`wake` 效果原样传回）。 */
  wakeNow(effect: Extract<GroupEffect, { type: 'wake' }>): GroupEffect[] {
    const effects: GroupEffect[] = []
    if (!this.isMember(effect.memberId)) return effects
    const names = effect.done.map(id => this.nameOf(id)).join('、')
    this.callIn([effect.memberId], { by: HOST_ID, reason: 'wake', note: `${names} 做完了你交代的活`, triggerSeq: effect.results.at(-1) ?? effect.triggerSeq,
      ...effect.workOrderId !== undefined && { workOrderId: effect.workOrderId }, coAnswering: [], done: effect.done, results: effect.results })
    this.pump(effects)
    return effects
  }

  /**
   * 一张工单的指示变了（暂停、收窄、取消、收单）：为它在跑的回合取消，排队与挂起的叫人作废，它的批次不再唤醒谁，
   * 账本留一行。没有可停的不写行。
   */
  stopOrder(workOrderId: string, text = '这张工单的指示变了，为它进行的工作已叫停。'): GroupEffect[] {
    const effects: GroupEffect[] = []
    const calls = this.state.calls.filter(call => call.workOrderId === workOrderId)
    const parked = this.state.parked.filter(entry => entry.workOrderId === workOrderId)
    const batches = this.state.batches.filter(batch => batch.workOrderId === workOrderId)
    if (calls.length === 0 && parked.length === 0 && batches.length === 0) return effects
    for (const call of calls) {
      if (RUNNING.includes(call.status)) effects.push({ type: 'cancel', callId: call.id, memberId: call.memberId })
      this.removeCall(call)
    }
    this.state.parked = this.state.parked.filter(entry => entry.workOrderId !== workOrderId)
    for (const batch of batches) this.dropBatch(batch)
    if (calls.length) this.event('stopped', text, effects)
    this.pump(effects)
    return effects
  }

  // -------------------------------------------------------------------------------------------
  // 成员回合里的上报

  private running(callId: string) {
    const call = this.state.calls.find(item => item.id === callId)
    return call && RUNNING.includes(call.status) ? call : undefined
  }

  /** 成员会话的任何事件：重置无动静计时（groups.js:1185-1188 `touch`）。 */
  touched(callId: string): GroupEffect[] {
    const call = this.running(callId)
    if (call) call.lastEventAt = this.now()
    return []
  }

  /**
   * 成员调了一个工具。团队工具（`team`）只计数，不算开工；首次非团队工具起算 15 秒后转入后台，
   * 并清零空转计数、把批次记为有人干过活（groups.js:1245-1257, :1530-1535）。
   */
  tool(callId: string, { team = false }: { team?: boolean } = {}): GroupEffect[] {
    const call = this.running(callId)
    if (!call) return []
    call.lastEventAt = this.now()
    call.toolCalls += 1
    if (!team) this.markWorked(call)
    return []
  }

  private markWorked(call: GroupCall) {
    if (!call.worked) {
      call.worked = true
      call.firstWorkAt = this.now()
    }
    this.clearIdleStreak()
    const batch = this.batchOfCall(call)
    if (batch) batch.worked = true
  }

  /** 成员在等主人批准（让出发言位，不再计超时）；批准有了结果后传 `false`，回合继续在后台跑（approvals.js:92-96）。 */
  approval(callId: string, waiting: boolean): GroupEffect[] {
    const call = this.running(callId)
    if (!call) return []
    call.lastEventAt = this.now()
    if (waiting) call.status = 'approval'
    else if (call.status === 'approval') call.status = 'working'
    return []
  }

  /**
   * 成员干活中途说的一句话。第一句和带 `@` 的话立即进账本（带 `@` 的立即叫人），其余间隔不到 30 秒的
   * 先攒着，由 `tick()` 合成一条发出；同一句不重复（groups.js:2294-2314 `roomStepText`）。
   */
  stepped(callId: string, raw: string): GroupEffect[] {
    const call = this.running(callId)
    if (!call) return []
    const effects: GroupEffect[] = []
    call.lastEventAt = this.now()
    const member = this.member(call.memberId)!
    const text = stripOwnName(member.name, raw)
    if (isPass(text)) return effects
    const calls = this.callsSomeone(call, text)
    const line = text.trim()
    if (line === call.lastLine && !calls) return effects
    call.lastLine = line
    call.held.push(text)
    if (call.posted.length === 0 || calls || this.now() - call.lastFlushAt >= this.limits.stepGapMs) this.flush(call, effects)
    this.pump(effects)
    return effects
  }

  /** 发出攒着的中途发言，作为一条进度行，并按其中的 `@` 叫人。 */
  private flush(call: GroupCall, effects: GroupEffect[]) {
    if (call.held.length === 0) return
    const text = call.held.splice(0).join('\n\n')
    call.lastFlushAt = this.now()
    call.lastPosted = text
    this.post(call, 'progress', text, effects)
  }

  private callsSomeone(call: GroupCall, text: string) {
    const { ids, all } = parseMentions(text, this.members, { except: call.memberId })
    return ids.length > 0 || (all && this.member(call.memberId)?.admin === true)
  }

  /** 以成员身份写一行并处理其中的 `@`。 */
  private post(call: GroupCall, kind: 'message' | 'progress', text: string, effects: GroupEffect[],
    terminal?: {substantiveReply: boolean; ownerQuestionCheck: boolean; repeated?: true}) {
    if (this.canPublish && !this.canPublish(call)) return
    const member = this.member(call.memberId)!
    const { ids, all } = parseMentions(text, this.members, { except: member.id })
    const line = this.say.say({
      kind, speakerId: member.id, author: member.name, text, mentions: ids, memberCallId: call.id,
      ...all && { all: true as const },
      replyTo: call.triggerSeq,
      ...call.workOrderId !== undefined && { workOrderId: call.workOrderId },
      ...call.batchId !== undefined && { batchId: call.batchId },
      ...terminal?.substantiveReply && { memberCompleted: true as const },
      ...terminal?.ownerQuestionCheck && { ownerQuestionCheck: true as const },
      ...terminal && call.engagement && { engagement: { callId: call.id, triggerSeq: call.triggerSeq, memberId: call.memberId, by: call.by, ...call.engagement } },
    })
    call.posted.push(line.seq)
    if (!this.retired && !call.engagement && !terminal?.repeated) this.callFrom(call, text, line.seq, effects)
    return line
  }

  /**
   * 成员一行话叫的人：被 `@` 的（去掉自己）；管理员说全员词时叫全员。一回合每人只叫一次。
   * 空转计数：回答成员的 0 工具回合、内容是重复/客套/待命计 1 次，有工具或实质内容清零；
   * 到上限后这一步要叫的人全部挂起，群里留一行，只有主人发言才放行（groups.js:1378-1452 `countIdleStep`…`callFrom`）。
   */
  private callFrom(call: Pick<GroupCall, 'memberId' | 'by' | 'called' | 'worked' | 'workOrderId'>, text: string, seq: number, effects: GroupEffect[]) {
    const member = this.member(call.memberId)!
    const { ids: found, all } = parseMentions(text, this.members, { except: member.id })
    const others = this.members.filter(other => other.id !== member.id).map(other => other.id)
    const everyone = member.admin && all
    const callees = (everyone ? [...found, ...others.filter(id => !found.includes(id))] : found).filter(id => !call.called.includes(id))
    const byMember = !plainCaller(call.by)
    let idleStep = false
    if (call.worked) this.clearIdleStreak()
    else {
      const history = this.state.idle.bodies[member.id] ?? []
      const norm = normalizeRelayBody(text, this.members)
      if (norm !== '') this.state.idle.bodies[member.id] = [...history, norm]
      if (byMember) {
        idleStep = isIdleRelayText(text, this.members, history)
        if (idleStep) { if (!this.state.idle.paused) this.state.idle.streak += 1 } else this.clearIdleStreak()
      }
    }
    call.called.push(...callees)
    if (byMember && idleStep && this.holdIdleCalls(member, call, callees, { named: found, seq }, effects)) return
    if (callees.length === 0) return
    const note = (id: string) => found.includes(id) ? `${member.name} @ 了你` : `${member.name} 叫了所有人`
    const named = callees.filter(id => found.includes(id)), rest = callees.filter(id => !found.includes(id))
    const base = { by: member.id, triggerSeq: seq, ...call.workOrderId !== undefined && { workOrderId: call.workOrderId } }
    if (named.length) this.callIn(named, { ...base, reason: 'mention', note: note(named[0]!), coAnswering: callees })
    if (rest.length) this.callIn(rest, { ...base, reason: 'all', note: note(rest[0]!), coAnswering: callees })
  }

  private clearIdleStreak() {
    if (!this.state.idle.paused) this.state.idle.streak = 0
  }

  /** 暂停已生效或这一步到达上限：要叫的人挂起（不丢），群里只提示一次（groups.js:1400-1421 `holdIdleCalls`）。 */
  private holdIdleCalls(member: GroupMember, call: Pick<GroupCall, 'workOrderId'>, callees: string[], { named, seq }: { named: string[]; seq: number }, effects: GroupEffect[]) {
    const idle = this.state.idle
    if (!idle.paused && idle.streak < this.limits.idleRelayLimit) return false
    const announce = !idle.paused
    if (!idle.paused) idle.paused = { from: member.id, count: idle.streak, at: this.now() }
    for (const id of callees) {
      if (this.state.parked.some(entry => entry.memberId === id)) continue
      const reason = named.includes(id) ? 'mention' as const : 'all' as const
      this.state.parked.push({ memberId: id, by: member.id, reason, note: reason === 'mention' ? `${member.name} @ 了你` : `${member.name} 叫了所有人`, triggerSeq: seq,
        ...call.workOrderId !== undefined && { workOrderId: call.workOrderId } })
    }
    if (announce) {
      const names = callees.map(id => this.nameOf(id))
      const text = names.length
        ? `已暂停自动叫人：${member.name} 与成员之间连续 ${this.limits.idleRelayLimit} 次没调用工具、只是客套或重复。对 ${names.map(name => '@' + name).join('、')} 的叫人先挂起，主人发言后继续。`
        : `已暂停自动叫人：成员之间连续 ${this.limits.idleRelayLimit} 次只发了没有新进展的状态（没调用工具、也没叫人），最后一次来自 ${member.name}。主人发言后继续。`
      const seq = this.event('paused', text, effects)
      if (idle.paused) Object.assign(idle.paused, { reason: text, seq })
    }
    return true
  }

  /** 主人发言后放行挂起的叫人；已在排队的不重复叫（groups.js:1314-1335 `releaseParked`）。 */
  private releaseParked() {
    const parked = this.state.parked.splice(0)
    for (const entry of parked) {
      if (!this.isMember(entry.memberId) || this.state.calls.some(call => call.memberId === entry.memberId && call.status === 'queued')) continue
      const by = this.isMember(entry.by) ? entry.by : HOST_ID
      this.callIn([entry.memberId], { by, reason: 'unpark', note: entry.note, triggerSeq: entry.triggerSeq, ...entry.workOrderId !== undefined && { workOrderId: entry.workOrderId } })
    }
  }

  /**
   * 成员回合结束（`text` 是最终回复）。
   * - 只回「收到/我去查」且整回合 0 工具：这句作为进度入账本，同一会话续推一次（turns.js:1449-1466）；
   * - `[PASS]` 不发言；攒着的中途发言接在最终回复前面，重复的不再发（groups.js:2326-2338 `withRoomSteps`）；
   * - 结果入账本后按其中的 `@` 接力，再收回批次：全部落地、有人干过活、无人继续 `@` 时唤醒派活者一次
   *   （groups.js:1611-1635）；主人直接叫的批次不唤醒任何人。
   * `toolCalls` 给只在结束时报工具数的执行器用（多出的按非团队工具算）。
   */
  finished(callId: string, { text = '', status = 'completed', toolCalls, detail }: { text?: string; status?: FinishStatus; toolCalls?: number; detail?: string } = {}): GroupEffect[] {
    const call = this.running(callId)
    if (!call) return []
    const effects: GroupEffect[] = []
    const member = this.member(call.memberId)!
    call.lastEventAt = this.now()
    if (toolCalls !== undefined && toolCalls > call.toolCalls) {
      call.toolCalls = toolCalls
      this.markWorked(call)
    }
    if (status === 'cancelled') {
      this.endCall(call, false, effects)
      this.pump(effects)
      return effects
    }
    if (status === 'failed') {
      this.flush(call, effects)
      this.event('failed', `${member.name} 没能答完${detail ? `：${detail}` : ''}。这件事还没做完，可以让它接着做。`, effects, call)
      this.endCall(call, false, effects)
      this.pump(effects)
      return effects
    }
    const reply = stripOwnName(member.name, String(text ?? '').trim())
    if (!this.retired && call.toolCalls === 0 && !call.retried && promisesWork(reply) && !this.callsSomeone(call, reply)) {
      call.retried = true
      call.lastLine = reply
      call.held.push(reply)
      this.flush(call, effects)
      effects.push({ type: 'continue', callId: call.id, memberId: call.memberId, text: CONTINUE_TEXT })
      this.pump(effects)
      return effects
    }
    const held = call.held.splice(0).join('\n\n')
    const repeated = reply !== '' && (reply === call.lastLine || (held === '' && reply === call.lastPosted))
    const final = held === '' ? (repeated || isPass(reply) ? '' : reply) : (isPass(reply) || repeated ? held : `${held}\n\n${reply}`)
    const substantiveReply = !isPass(reply) && !promisesWork(reply) && !isIdleRelayText(reply, this.members, [])
    const ownerQuestionCheck = this.checkOwnerQuestions && substantiveReply && call.workOrderId === undefined && !call.engagement && !member.admin
    const terminal = {substantiveReply, ownerQuestionCheck}
    if (final !== '') this.post(call, 'message', final, effects, terminal)
    // A repeated progress line still needs a durable completion, with no second pass through the relay.
    else if (ownerQuestionCheck || call.engagement && !isPass(reply)) this.post(call, 'message', reply, effects, {...terminal, repeated: true})
    else if (call.engagement?.generation !== undefined) this.event('failed', member.name + ' 本轮没有交回可核实的结果。', effects, call)
    const posted = call.posted.length > 0
    const admin = this.admin
    if (!posted && call.by === OWNER_ID && call.reason === 'owner' && admin?.id === call.memberId) {
      this.event('admin-passed', `${admin.name} 没有回答也没有叫人；可以用 @名字 直接叫成员。`, effects)
    }
    this.endCall(call, posted, effects)
    this.pump(effects)
    return effects
  }

  // -------------------------------------------------------------------------------------------
  // 计时

  /** 到点的事：攒着的中途发言合成发出；15 秒后转入后台；240 秒无动静记超时（会话不停，结果之后作为迟到回复）。 */
  tick(): GroupEffect[] {
    const effects: GroupEffect[] = []
    const now = this.now()
    for (const call of [...this.state.calls]) {
      if (!RUNNING.includes(call.status)) continue
      if (call.held.length > 0 && now - call.lastFlushAt >= this.limits.stepGapMs) this.flush(call, effects)
      if (call.status !== 'speaking') continue
      if (call.firstWorkAt !== undefined && now - call.firstWorkAt >= this.limits.workGraceMs) {
        call.status = 'working'
        effects.push({ type: 'background', callId: call.id, memberId: call.memberId })
      } else if (now - (call.lastEventAt ?? call.startedAt ?? now) >= this.limits.replyTimeoutMs) {
        call.status = 'missed'
        const minutes = Math.round(this.limits.replyTimeoutMs / 60_000)
        this.event('missed', `${this.nameOf(call.memberId)} ${minutes} 分钟没有动静，先往下走；如果还在干，结果之后会作为迟到回复发出。`, effects)
      }
    }
    this.pump(effects)
    return effects
  }

  /** 下一次需要调 `tick()` 的时刻；没有则为 undefined。 */
  nextDeadline(): number | undefined {
    let next: number | undefined
    const at = (time: number) => { next = next === undefined ? time : Math.min(next, time) }
    for (const call of this.state.calls) {
      if (!RUNNING.includes(call.status)) continue
      if (call.held.length > 0) at(call.lastFlushAt + this.limits.stepGapMs)
      if (call.status !== 'speaking') continue
      if (call.firstWorkAt !== undefined) at(call.firstWorkAt + this.limits.workGraceMs)
      else at((call.lastEventAt ?? call.startedAt ?? this.now()) + this.limits.replyTimeoutMs)
    }
    return next
  }

  // -------------------------------------------------------------------------------------------
  // 叫停与重启

  /**
   * 叫停一位成员（`memberId`）或全部：取消在跑的回合，撤掉排队与挂起的叫人，离开批次（不唤醒派活者），
   * 账本留「已叫停」（groups.js:2350-2399 `stopMemberWork` / `stopRoomWork`）。没有可停的不写行。
   */
  stop(memberId?: string): GroupEffect[] {
    const effects: GroupEffect[] = []
    const hit = (id: string) => memberId === undefined || id === memberId
    const calls = this.state.calls.filter(call => hit(call.memberId))
    const parked = this.state.parked.filter(entry => hit(entry.memberId))
    if (calls.length === 0 && parked.length === 0) return effects
    for (const call of calls) {
      if (RUNNING.includes(call.status)) effects.push({ type: 'cancel', callId: call.id, memberId: call.memberId })
      this.removeCall(call)
    }
    this.state.parked = this.state.parked.filter(entry => !hit(entry.memberId))
    if (memberId === undefined) this.state.batches = []
    else for (const batch of [...this.state.batches]) {
      if (!batch.pending.includes(memberId)) continue
      batch.pending = batch.pending.filter(id => id !== memberId)
      this.prune(batch)
      if (batch.pending.length === 0) this.dropBatch(batch)
    }
    this.event('stopped', memberId === undefined ? '主人叫停了本群的全部工作。' : `主人叫停了 ${this.nameOf(memberId)} 在本群的工作。`, effects)
    this.pump(effects)
    return effects
  }

  /** A superseded trace keeps evidence from offered calls and ends its queued work. */
  retire() {
    this.retired = true
    this.state.calls = this.state.calls.filter(call => RUNNING.includes(call.status))
    this.state.batches = []
    this.state.parked = []
  }

  /**
   * 宿主重启后：`alive` 是仍在跑的回合（callId）。不在其中的回合作废并离开批次；批次因此落地且有结果的，
   * 唤醒派活者一次；排队的叫人照常开始（groups.js:1082-1114 `settleRoomBatches`）。
   */
  restart(alive: Iterable<string>, settled: ReadonlySet<string> = new Set()): GroupEffect[] {
    this.pruneStaleEngagements()
    const effects: GroupEffect[] = []
    const keep = new Set(alive)
    for (const call of [...this.state.calls]) {
      if (!RUNNING.includes(call.status)) continue
      if (keep.has(call.id)) { call.lastEventAt = this.now(); continue }
      if (settled.has(call.id)) { this.endCall(call, false, effects); continue }
      this.flush(call, effects)
      this.event('interrupted', `${this.nameOf(call.memberId)} 的工作因重启中断了；还需要的话可以让它接着做。`, effects, call)
      this.endCall(call, false, effects)
    }
    this.pump(effects)
    return effects
  }

  // -------------------------------------------------------------------------------------------
  // 状态

  /** 每位成员现在在做什么：空闲、在答、后台在干、等批准、超时仍在跑，以及排队数。 */
  activity(): MemberActivity[] {
    return this.members.map(member => {
      const mine = this.state.calls.filter(call => call.memberId === member.id)
      const current = mine.find(call => RUNNING.includes(call.status))
      return {
        memberId: member.id,
        status: current?.status ?? 'idle',
        ...current && { callId: current.id, since: current.startedAt, note: current.note, by: current.by },
        ...current?.workOrderId !== undefined && { workOrderId: current.workOrderId },
        queued: mine.filter(call => call.status === 'queued').length,
      }
    })
  }

  get paused(): boolean { return this.state.idle.paused !== undefined }
  /** 空转守卫的暂停：谁的那一步触发、何时、原因（账本里那一行）。 */
  get pause(): Readonly<NonNullable<GroupSchedulerState['idle']['paused']>> | undefined { return this.state.idle.paused }
  get parked(): readonly ParkedCall[] { return this.state.parked }
  get calls(): readonly GroupCall[] { return this.state.calls }
  get batches(): readonly GroupBatch[] { return this.state.batches }

  // -------------------------------------------------------------------------------------------
  // 叫人、排队与批次

  private id(prefix: string) { return `${this.idPrefix}${prefix}${this.state.nextId++}` }

  /**
   * 叫一组成员，同一次叫人共享一个批次（groups.js:1273-1298 `callIn`）。成员已有兼容的排队叫人（同一派活者，
   * 或任一方是主人/宿主）时只更新那一条，不重复叫；同一派活者再叫同一成员，并入其最新批次（groups.js:993-1026）。
   */
  private callIn(callees: string[], spec: { by: string; reason: GroupCallReason; note: string; triggerSeq: number; workOrderId?: string; exactScope?: true; coAnswering?: string[]; done?: string[]; results?: number[] }) {
    const list = [...new Set(callees)].filter(id => this.isMember(id) && id !== spec.by)
    if (list.length === 0) return
    const coAnswering = spec.coAnswering ?? list
    const fresh: { id: string; queued?: GroupCall }[] = []
    const merged: { call: GroupCall; joins: boolean }[] = []
    for (const id of list) {
      const queued = this.state.calls.find(call => call.memberId === id && call.status === 'queued' && this.currentEngagement(call)
        && (call.exactScope || spec.exactScope ? call.workOrderId === spec.workOrderId : this.sameOrder(call.workOrderId, spec.workOrderId))
        && (call.by === spec.by || plainCaller(call.by) || plainCaller(spec.by)))
      if (!queued) { fresh.push({ id }); continue }
      // 主人/宿主的叫人并入成员的排队叫人：保留原批次，回答的人改成主人的那一行（DS-Bot 删去 slot.by、保留 batchKey）。
      merged.push({ call: queued, joins: spec.by === queued.by || (plainCaller(queued.by) && !plainCaller(spec.by)) })
    }
    const batchMembers = [...fresh.map(item => item.id), ...merged.filter(item => item.joins).map(item => item.call.memberId)]
    const batch = spec.by === HOST_ID ? undefined : this.registerBatch(spec.by, batchMembers, spec)
    for (const { call, joins } of merged) {
      if (joins) {
        if (call.batchId && call.batchId !== batch?.id) this.leaveOwnerBatch(call)
        if (batch) call.batchId = batch.id
        call.by = spec.by
      } else call.by = spec.by === HOST_ID ? call.by : OWNER_ID
      call.reason = spec.reason
      call.note = spec.note
      call.triggerSeq = spec.triggerSeq
      call.coAnswering = coAnswering
      if (spec.exactScope) call.exactScope = true
      if (spec.workOrderId !== undefined) call.workOrderId = spec.workOrderId
      if (spec.results) {
        call.done = [...new Set([...(call.done ?? []), ...(spec.done ?? [])])]
        call.results = [...(call.results ?? []), ...spec.results]
      }
    }
    for (const { id } of fresh) {
      const engagement = this.engage?.(spec.workOrderId, id)
      this.state.calls.push({
        id: this.id('c'), memberId: id, ...engagement && {engagement}, by: spec.by, reason: spec.reason, note: spec.note, triggerSeq: spec.triggerSeq,
        ...batch && { batchId: batch.id },
        ...spec.workOrderId !== undefined && { workOrderId: spec.workOrderId },
        ...spec.exactScope && { exactScope: true },
        ...spec.results && { done: [...(spec.done ?? [])], results: [...spec.results] },
        coAnswering, status: 'queued', queuedAt: this.now(),
        toolCalls: 0, worked: false, retried: false, called: [], posted: [], held: [], lastFlushAt: 0,
      })
    }
  }

  /** 并入成员排队叫人时，它原先在主人批次里的位置作废（主人批次本就不唤醒谁）。 */
  private leaveOwnerBatch(call: GroupCall) {
    const old = this.state.batches.find(batch => batch.id === call.batchId)
    if (!old || old.by !== OWNER_ID) return
    old.pending = old.pending.filter(id => id !== call.memberId)
    if (old.pending.length === 0 && old.done.length === 0) this.dropBatch(old)
  }

  private registerBatch(by: string, callees: string[], spec: { triggerSeq: number; workOrderId?: string }): GroupBatch | undefined {
    if (callees.length === 0) return undefined
    const batch: GroupBatch = {
      id: this.id('b'), by, pending: [...callees], done: [], results: [], worked: false, answered: false,
      triggerSeq: spec.triggerSeq, ...spec.workOrderId !== undefined && { workOrderId: spec.workOrderId }, createdAt: this.now(),
    }
    for (const id of callees) {
      const previous = this.state.batches.findLast(other => other.by === by && this.sameOrder(other.workOrderId, spec.workOrderId) && other.pending.includes(id))
      if (!previous) continue
      previous.pending = previous.pending.filter(other => other !== id)
      if (previous.pending.length === 0) {
        batch.done.push(...previous.done.filter(other => !batch.done.includes(other)))
        batch.results.push(...previous.results)
        batch.worked ||= previous.worked
        batch.answered ||= previous.answered
        this.dropBatch(previous)
      }
    }
    this.state.batches.push(batch)
    return batch
  }

  /** 回合所属的批次：自己的；被同一派活者后来的叫人接走时，取它最新的那个（groups.js:1036 `batchOfSlot`）。 */
  private batchOfCall(call: GroupCall): GroupBatch | undefined {
    const own = this.state.batches.find(batch => batch.id === call.batchId && batch.pending.includes(call.memberId))
    if (own) return own
    const owner = call.batchId ? this.state.batches.find(batch => batch.id === call.batchId)?.by ?? call.by : call.by
    return this.state.batches.findLast(batch => batch.by === owner && this.sameOrder(batch.workOrderId, call.workOrderId) && batch.pending.includes(call.memberId))
  }

  /** 去掉不在群里、也没有任何叫人在身的待交成员（groups.js:1028-1032 `pruneBatchPending`）。 */
  private prune(batch: GroupBatch) {
    batch.pending = batch.pending.filter(id => this.isMember(id) && this.state.calls.some(call => call.memberId === id && this.sameOrder(call.workOrderId, batch.workOrderId)))
  }

  private dropBatch(batch: GroupBatch) {
    this.state.batches = this.state.batches.filter(other => other !== batch)
  }

  private removeCall(call: GroupCall) {
    this.state.calls = this.state.calls.filter(other => other !== call)
  }

  /** 回合结束：离开批次；落地的批次满足条件时唤醒派活者一次。 */
  private endCall(call: GroupCall, posted: boolean, effects: GroupEffect[]) {
    const batch = this.batchOfCall(call)
    this.removeCall(call)
    if (!batch) return
    if (posted) {
      if (!batch.done.includes(call.memberId)) batch.done.push(call.memberId)
      batch.results.push(...call.posted)
      if (call.called.length > 0) batch.answered = true
      if (call.worked) batch.worked = true
    }
    batch.pending = batch.pending.filter(id => id !== call.memberId)
    this.prune(batch)
    if (batch.pending.length === 0) this.settle(batch, effects)
  }

  /** 批次全部落地：有结果、有人干过活、无人继续 `@`、派活者是成员时唤醒它一次，然后删掉批次。 */
  private settle(batch: GroupBatch, effects: GroupEffect[]) {
    this.dropBatch(batch)
    if (batch.workOrderId && this.engage?.(batch.workOrderId, batch.by)) return
    if (batch.by === OWNER_ID || !this.isMember(batch.by) || batch.done.length === 0 || !batch.worked || batch.answered) return
    const names = batch.done.map(id => this.nameOf(id)).join('、')
    const held = this.holdOrderWakes && batch.workOrderId !== undefined && this.member(batch.by)?.admin === true
    effects.push({ type: 'wake', memberId: batch.by, batchId: batch.id, done: [...batch.done], results: [...batch.results], triggerSeq: batch.triggerSeq,
      ...batch.workOrderId !== undefined && { workOrderId: batch.workOrderId }, ...held && { held: true as const } })
    if (held) return
    this.callIn([batch.by], { by: HOST_ID, reason: 'wake', note: `${names} 做完了你交代的活`, triggerSeq: batch.results.at(-1) ?? batch.triggerSeq,
      ...batch.workOrderId !== undefined && { workOrderId: batch.workOrderId }, coAnswering: [], done: batch.done, results: batch.results })
  }

  /** 空闲成员开始其排队的叫人：主人的叫人先于别人的（轮中主人发言不排在后面），其余按先后。 */
  private pump(effects: GroupEffect[]) {
    if (this.retired) return
    this.pruneStaleEngagements()
    for (const member of this.members) {
      if (this.state.calls.some(call => call.memberId === member.id && RUNNING.includes(call.status))) continue
      const queued = this.state.calls.filter(call => call.memberId === member.id && call.status === 'queued')
      const next = queued.find(call => call.by === OWNER_ID) ?? queued[0]
      if (!next) continue
      const now = this.now()
      next.status = 'speaking'
      next.startedAt = now
      next.lastEventAt = now
      effects.push({
        type: 'start', callId: next.id, memberId: next.memberId, by: next.by, reason: next.reason, note: next.note, triggerSeq: next.triggerSeq,
        ...next.batchId !== undefined && { batchId: next.batchId },
        ...next.workOrderId !== undefined && { workOrderId: next.workOrderId },
        ...next.engagement && {coordinated: true},
        coAnswering: next.coAnswering.filter(id => id !== next.memberId),
        ...next.results && { done: [...(next.done ?? [])], results: [...next.results] },
      })
    }
  }

  private event(event: GroupEventReason, text: string, effects: GroupEffect[], call?: GroupCall): number {
    const line = this.say.say({ kind: 'event', speakerId: HOST_ID, author: HOST_NAME, text, event,
      ...call?.workOrderId !== undefined && { workOrderId: call.workOrderId },
      ...call?.engagement && (event === 'failed' || event === 'interrupted') && {
        engagement: { callId: call.id, triggerSeq: call.triggerSeq, memberId: call.memberId, by: call.by, ...call.engagement },
      },
    })
    effects.push({ type: 'event', event, seq: line.seq, text, ...call && { memberId: call.memberId }, ...call?.workOrderId !== undefined && { workOrderId: call.workOrderId } })
    return line.seq
  }
}
