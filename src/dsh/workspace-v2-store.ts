import { isEngagementReporting, type EngagementDecision, type EngagementReporting, type OwnerAction } from '../core/workspace-engagement.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { V2Acceptance, V2CodingPermission, V2Decision, V2Delegation, V2DialogueSource, V2DirectorySuggestions, V2DirectoryWait, V2Executor, V2Held, V2MessageAction, V2OrderOriginal, V2PermissionChange, V2Session, V2WorkDirectory, V2Workspace, V2WorkspaceView } from '../core/workspace-v2.ts'
import { CODING_PERMISSIONS, WORKSPACE_ARCHIVED, codingPermission, defaultWorkspaceIcon, orderEnded, workspaceArchived } from '../core/workspace-v2.ts'
import { nextSlot } from '../core/clock.ts'
import type { IntakeContext } from '../core/superhub-intake.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import { liaisonPortrait, registerSpeakers, type SpeakerPortraits } from '../core/workspace-avatars.ts'
import { groupLeadId, liaisonSpeakerId } from './workspace-speaker-id.ts'
import type { WorkspaceStaffStore } from './workspace-staff-store.ts'
import type { OrderFollowupState } from './workspace-followup.ts'
import { checkedOrderBrief, interimOrderBrief, type OrderBrief } from './workspace-order-brief.ts'
import { weeklyResult, type StoredResult } from './workspace-notices.ts'
import { checkProjectDirectory, suggestDirectories, type DirectoryRules } from './project-directory.ts'

type MutationResult = { workspace: V2Workspace; outcome?: 'created' | 'existing' } | { delegation: V2Delegation } | { session: V2Session; stopped?: string }
interface SavedMutation { kind: 'mutation'; hash: string; result: MutationResult }
interface Turn {
  staffToken?:string
  kind: 'turn'
  hash: string
  sessionId: string
  state: 'pending' | 'sent' | 'unknown' | 'unsent'
  reserved: { id: string; generation: number }[]
  at: string
  resultCheck?: 'pending' | 'done'
  /** New results of this turn get one liaison acceptance review (turns reserved before reviews existed have none). */
  review?: true
  /** A restart cut this turn off (it was `pending`); kept until the owner has been reminded (`clearInterrupted`). */
  interrupted?: string
}
interface QueuedFollow { kind: 'follow'; hash: string; state: 'queued' | 'stopped' }
/**
 * Owner words sent while a turn of the session ran (`parent`). `steering` while the running turn may still take them;
 * `steered` when it did (no budget used); `queued` as the next turn (a start row, then a `turn` receipt with budget);
 * `unsent`/`stopped` when they could not be queued; `unknown` when a restart interrupted the hand-over.
 */
interface Interjected {
  kind: 'interject'; hash: string; sessionId: string; parent?: string; workOrderId: string | null; generation?: number; text: string
  staffToken?: string; at: string; state: 'steering' | 'steered' | 'queued' | 'unsent' | 'stopped' | 'unknown'; reason?: string
  /** Said while the turn `mergedInto` waited for its project directory: part of that turn's input, no budget of its own. */
  mergedInto?: string
}
interface FollowupReceipt { kind: 'followup'; hash: string; reportId?: string }
/** Owner words said in a roster group (one ledger line, found again by its request id), or held words handed to it. */
interface GroupSaid { kind: 'group-say'; hash: string; sessionId: string; at: string }
type Receipt = SavedMutation | Turn | QueuedFollow | Interjected | FollowupReceipt | GroupSaid | {kind: 'notice-read'; hash: string}
/**
 * Work the liaison hands to a roster group (an assignment, a supplement, a staff order from the order form), saved in
 * the same write as the order; the group line is posted once (by `requestId`) and the row is removed after it.
 */
export interface GroupStart {
  kind: 'assign' | 'follow' | 'order'
  requestId: string; workspaceId: string; sessionId: string; orderId: string; generation?: number
  /** The liaison's words; `original` is the owner's wording it relays (absent for an order from the form). */
  handoff: string; original?: string
  inputAttachments?: ChatInputAttachment[]
  /** The staff member the owner named: the line @-mentions them. Absent: the liaison member decides whom to @. */
  staffId?: string
}
/**
 * A turn accepted before its conversation was free. `interject` rows are owner words moved to the next turn; they keep
 * the owner's own request (`hash`) and have no `delegationId` when they belong to the session discussion.
 */
export interface AssignmentStart {
  staffToken?:string; kind?: 'follow' | 'interject'; workspaceId: string; sessionId: string; delegationId?: string; generation: number; requestId: string; text: string; hash?: string
  /** The turn waits for another turn using the same project directory; `waitingSince` keeps the queue order across restarts. */
  waitingFor?: V2DirectoryWait
  waitingSince?: string
  /** Owner words said while this turn waited; they go with it. */
  merged?: { id: string; text: string }[]
}
export type InterjectionState = Interjected['state']
/** The liaison's hand-over for a turn it speaks (`handoff` absent: the turn text is the liaison's own words). */
export interface LiaisonTurn { handoff?: string }
/**
 * One acceptance review per turn with new results, keyed by the turn's request id. `pending` until the review answers;
 * `cancelled` when the owner spoke meanwhile (no automatic follow-up then). `note` is the liaison message to post and
 * `posted` records that it reached the conversation, so a restart posts it once.
 */
export interface AcceptanceRecord {
  workspaceId: string; sessionId: string; orderId: string; generation: number; at: string
  state: 'pending' | 'done' | 'failed' | 'skipped'; cancelled?: true; note?: string; posted?: true; followUp?: string
  /** The note is a passing verdict: it offers the owner to complete the order. */
  pass?: true
  /** The conversation message of the posted note, and when the owner completed the order from it. */
  messageId?: string
  completedAt?: string
  /**
   * A roster group's batch for this order landed (`results`: its ledger lines; `done`: the members who handed back). A
   * gap is followed up by the liaison @-mentioning `done` again in the group (`followUp: 'group'`).
   */
  group?: { batchId: string; done: string[]; results: number[] }
}
/**
 * Owner words on an order the liaison read as being about the order itself (completing it), keyed by their request id.
 * They are never dispatched on their own: `completed` finished the order at once; `held` waits for the owner's choice
 * (`resolved`: `complete` or `forward`, the only way the words reach the executor, with their own request id). A
 * completion by words can be undone once from its message (`resolved: reopen`). The owner's words and the liaison's
 * note are posted after the decision is saved (`ownerMessageId`, `noteMessageId` once they are in the conversation).
 */
export interface OwnerCommand {
  inputAttachments?: ChatInputAttachment[]
  workspaceId: string; sessionId: string; orderId: string; generation: number; text: string; hash: string; at: string
  /** The liaison's reading (`failed`: no reading, treated as ambiguous; `reason` says why). */
  judged: 'complete' | 'ambiguous' | 'failed'
  reason?: string
  /** The order had an enabled recurring schedule when the words were read. */
  scheduled?: true
  outcome: 'completed' | 'held'
  resolved?: { kind: 'complete' | 'forward' | 'reopen'; at: string }
  ownerMessageId?: string
  noteMessageId?: string
}
/** Liaison wording when it acts on (or asks about) the owner's words about the order itself. */
export const commandText = {
  completed: '已按你的话收单。',
  held: (judged: OwnerCommand['judged'], scheduled: boolean) => (scheduled
    ? '这张工单有启用中的周期安排，我没有直接收单。'
    : judged === 'failed' ? '我没能确认这句话是不是要收单。' : '这句话像是在确认收单，但不够明确。')
    + '这句话还没有发给执行者，请选择' + (scheduled ? '收单并停止周期安排' : '确认收单') + '，或继续交给执行者。',
}
export type AcceptanceOutcome = {kind: 'failed' | 'skipped'; reason: string} | {kind: 'verdict'; verdict: 'pass' | 'gap'; message: string; gaps: string[]}
/** The longest hand-over the liaison writes in its own words. */
export const HANDOFF_LIMIT = 600
const trimEnd = (text: string) => text.trim().replace(/[。.！!；;，,\s]+$/u, '')
export const assignHandoff = (title: string, promise: string) => '我把这件事交给你：' + trimEnd(title) + '。完成标准：' + trimEnd(promise) + '。主人原话如下。'
export const followHandoff = (title: string) => '主人对「' + trimEnd(title) + '」有新的补充，请按补充继续。主人原话如下。'
export function handoffOf(value: unknown): string | undefined {
  if (value === undefined) return
  if (typeof value !== 'string' || !value.trim() || value.trim().length > HANDOFF_LIMIT) return workspaceError(400, '交办说明需要 1 到 ' + HANDOFF_LIMIT + ' 字')
  return value.trim()
}
/** Liaison wording for the outcome of its acceptance review. */
export const acceptanceText = {
  pass: (message: string) => message.startsWith('已对照约定') ? message : '已对照约定核对：' + message,
  followUp: (message: string, gaps: string[]) => message + '\n\n还缺：\n' + gaps.map((gap, i) => (i + 1) + '. ' + gap).join('\n') + '\n\n请补齐以上各项后重新交付。',
  decide: (message: string, gaps: string[], followed: boolean) => (followed ? '追问后仍有缺口，转给主人决定。' : '仍有缺口，本单额度不足以自动追问，转给主人决定。')
    + (message ? '\n\n' + message : '') + (gaps.length ? '\n\n' + gaps.map(gap => '- ' + gap).join('\n') : ''),
}
/**
 * The owner's words come first on `orderId` (absent: the session discussion, every order of the session): reviews still
 * running record their verdict only, a queued automatic follow-up is dropped (its receipt `stopped`), and a waiting
 * acceptance decision counts as answered. `apply: false` only tells whether anything would change.
 */
function ownerFirst(board: Board, sessionId: string, orderId: string | undefined, apply: boolean) {
  const matches = (row: {sessionId: string; orderId?: string; delegationId?: string}) => row.sessionId === sessionId && (!orderId || (row.orderId ?? row.delegationId) === orderId)
  const reviews = Object.values(board.acceptances ?? {}).filter(row => row.state === 'pending' && !row.cancelled && matches(row))
  const queued = (board.starts ?? []).filter(row => row.requestId.startsWith(AUTO_FOLLOW_UP) && matches(row))
  const waiting = board.delegations.filter(row => row.acceptance?.awaitingOwner && matches({sessionId: row.sessionId, orderId: row.id}))
  if (!apply) return reviews.length + queued.length + waiting.length > 0
  for (const row of reviews) row.cancelled = true
  if (queued.length) board.starts = board.starts!.filter(row => {
    if (!queued.includes(row)) return true
    const receipt = board.receipts['req-' + row.requestId]
    if (receipt?.kind === 'follow') receipt.state = 'stopped'
    return false
  })
  for (const row of waiting) delete row.acceptance!.awaitingOwner
  return true
}
/** A start row that will not run: its queued receipt and the owner words merged into it stop with it. */
function dropStart(board: Board, start: AssignmentStart) {
  const queued = board.receipts['req-' + start.requestId]
  if (queued?.kind === 'follow' || queued?.kind === 'interject') queued.state = 'stopped'
  for (const words of start.merged ?? []) {
    const merged = board.receipts['req-' + words.id]
    if (merged?.kind === 'interject') merged.state = 'stopped'
  }
}
/** Owner words for a busy session, checked like a turn of the order (`parent`: the turn they were said into). */
function recordInterjection(board: Board, mutation: Mutation, session: V2Session, workOrderId: string | undefined, parent: string | undefined, text: string, staffToken?: string) {
  if (board.receipts[mutation.key]) return workspaceError(409, '这条请求已用于另一项操作，请重新确认')
  writable(board, session.workspaceId)
  if (findSession(board, session.workspaceId, session.id).closed) return workspaceError(409, '这场会话已关闭，重新打开原会话即可继续补充')
  let generation: number | undefined
  if (workOrderId) {
    const d = findDelegation(board, session.workspaceId, workOrderId)
    if (d.sessionId !== session.id) return workspaceError(409, '这张工单属于另一场会话')
    if (orderEnded(d) || d.paused) return workspaceError(409, stoppedReason(d))
    generation = d.generation
  }
  const receipt: Interjected = {kind: 'interject', hash: mutation.hash, sessionId: session.id, ...(parent && {parent}), workOrderId: workOrderId ?? null,
    ...(generation !== undefined && {generation}), text, ...(staffToken && {staffToken}), at: now(), state: 'steering'}
  board.receipts[mutation.key] = receipt
  return receipt
}
/** Move recorded words to the next turn of the same order (a start row), with budget left for everything queued. */
function queueRow(board: Board, id: string): {state: 'queued'} | {state: 'unsent' | 'stopped'; reason: string} {
  const receipt = board.receipts['req-' + id]
  if (receipt?.kind !== 'interject') return workspaceError(409, '这条请求已用于另一项操作，请重新确认')
  if (receipt.state === 'queued') return {state: 'queued' as const}
  if (receipt.state !== 'steering') return {state: receipt.state === 'stopped' ? 'stopped' as const : 'unsent' as const, reason: receipt.reason ?? '这句话没有送达'}
  const starts = board.starts ??= []
  const session = findSession(board, board.sessions.find(row => row.id === receipt.sessionId)!.workspaceId, receipt.sessionId)
  let order: V2Delegation | undefined
  if (receipt.workOrderId) {
    order = findDelegation(board, session.workspaceId, receipt.workOrderId)
    const stopped = order.generation !== receipt.generation || orderEnded(order) || order.paused || order.sessionId !== session.id
    const waiting = starts.filter(row => row.delegationId === order!.id && row.generation === order!.generation).length
    if (stopped || order.remainingTurns <= waiting) {
      receipt.state = stopped ? 'stopped' : 'unsent'
      receipt.reason = stopped ? '工单已变更，这句话没有送达' : '这张工单的对话额度已用完，这句话没有送达'
      return {state: receipt.state, reason: receipt.reason}
    }
  }
  starts.push({kind: 'interject', ...(receipt.staffToken && {staffToken: receipt.staffToken}), workspaceId: session.workspaceId, sessionId: session.id,
    ...(order && {delegationId: order.id}), generation: order?.generation ?? 0, requestId: id, text: receipt.text, hash: receipt.hash})
  receipt.state = 'queued'
  // The words run next: a review of the turn they missed must not send its own follow-up ahead of or after them.
  ownerFirst(board, session.id, order?.id, true)
  return {state: 'queued' as const}
}
/**
 * The owner's choice on held words is taken. A forward counts once the words have their own delivery receipt: a
 * crash or a refusal between recording the choice and dispatching leaves the choice open (and `recover` retries it).
 */
function choiceTaken(board: Board, requestId: string, row: OwnerCommand) {
  return !!row.resolved && (row.resolved.kind !== 'forward' || !!board.receipts['req-' + requestId])
}
/** The owner finished the order: no new turns; reviews, queued work and waiting decisions of this order stop with it. */
function finishOrder(board: Board, order: V2Delegation, at: Date, by: 'owner' | 'owner-words', from?: string) {
  order.status = 'done'
  order.completedAt = at.toISOString()
  order.completedBy = by
  if (from) order.completedFrom = from
  else delete order.completedFrom
  delete order.paused
  order.reason = by === 'owner-words' ? '你已在对话中说明可以收单' : '你已确认收单'
  ownerFirst(board, order.sessionId, order.id, true)
}
/** A new generation of the order's instructions: work accepted for the old one stops. */
function advance(board: Board, order: V2Delegation) {
  order.generation++
  if (board.starts?.length) board.starts = board.starts.filter(start => {
    if (start.delegationId !== order.id) return true
    dropStart(board, start)
    return false
  })
}
/**
 * The liaison message a choice was taken on (`from`), checked against the order and the choice: completing from held
 * owner words or a passing acceptance verdict, or undoing a completion by the owner's words. Each is taken once.
 */
function messageOrigin(board: Board, order: V2Delegation, from: unknown, action: unknown) {
  if (typeof from !== 'string' || !from) return workspaceError(400, '请选择有效的消息')
  const stale = () => workspaceError(409, '这个选项已经处理过或已失效，请刷新对话')
  const command = Object.entries(board.commands ?? {}).find(([, row]) => row.noteMessageId === from && row.orderId === order.id && row.workspaceId === order.workspaceId)
  if (command) {
    const [requestId, row] = command
    if (choiceTaken(board, requestId, row)) return stale()
    if (action === 'complete' && row.outcome === 'held' && order.status !== 'done') return {kind: 'command' as const, requestId, row}
    if (action === 'reopen' && row.outcome === 'completed' && order.status === 'done' && order.completedFrom === requestId) return {kind: 'command' as const, requestId, row}
    return stale()
  }
  const review = Object.values(board.acceptances ?? {}).find(row => row.messageId === from && row.orderId === order.id && row.workspaceId === order.workspaceId)
  if (review) {
    if (action !== 'complete' || !review.pass || review.completedAt || order.status === 'done') return stale()
    return {kind: 'acceptance' as const, row: review}
  }
  return workspaceError(404, '这张工单的对话里没有这条消息')
}
/** The choices of the liaison messages of a session with their current state. */
const ACTION_LABEL = {complete: '确认收单', completeSchedule: '收单并停止周期安排', reopen: '撤销', forward: '继续交给执行者'}
/** Why a finished, cancelled or paused order takes no more turns. */
export const stoppedReason = (order: V2Delegation) => order.status === 'done' ? '这张工单已完成，重新打开后才能继续' : '关联工单已取消或暂停，请先查看工单'
/** Request ids of the liaison's automatic follow-ups after its acceptance review. */
const AUTO_FOLLOW_UP = 'accept-'
export const INTERJECTION_UNKNOWN = '这句话的送达结果待核对，请先查看原会话'
type LegacyDelegation = V2Delegation & { legacyTicketId: string }
interface RetiredOrders {
  orders: LegacyDelegation[]
  sessions: V2Session[]
}
export interface EngagementJob {
  id: string
  workspaceId: string
  sessionId: string
  seq: number
  orderId?: string
  generation?: number
  triggerSeq?: number
  intakeSeq?: number
  turn: 'liaison' | 'member' | 'owner'
  memberId?: string
  answerTo?: string
  decision?: EngagementDecision
  until?: string
  waitForMember?: string
  attempts?: number
  done?: true
}
interface StoredOwnerAction extends Omit<OwnerAction, 'workspaceName' | 'sessionTitle'> {
  generation?: number
  answerMessageId?: string
  resolved?: true
}

interface Board {
  schema: 1 | 2
  portraits?: Record<string, SpeakerPortraits>
  personalWorkspaceId?: string
  /** Committed with the assignment, removed in the same write as the first turn reservation. */
  starts?: AssignmentStart[]
  signupStarts?: AssignmentStart[]
  workspaces: V2Workspace[]
  delegations: V2Delegation[]
  sessions: V2Session[]
  decisions: V2Decision[]
  followups?: Record<string, OrderFollowupState>
  originals?: Record<string,V2OrderOriginal>
  resultNotices?: Record<string, StoredResult>
  resultNoticesBackfilled?: boolean
  /** Roster groups: the last ledger line whose results were published (lines after it are checked next). */
  groupResultsChecked?: Record<string, number>
  engagementJobs?: Record<string, EngagementJob>
  ownerActions?: Record<string, StoredOwnerAction>
  groupEvidence?: Record<string, StoredResult>
  liaisonTurns?: Record<string, LiaisonTurn>
  acceptances?: Record<string, AcceptanceRecord>
  /** Owner words about the order itself (completing it), by request id. */
  commands?: Record<string, OwnerCommand>
  /** Liaison work for roster groups whose group line is not posted yet. */
  groupStarts?: GroupStart[]
  /** Bound, changed and removed project directories of workspaces, oldest first. */
  directoryChanges?: { workspaceId: string; at: string; from?: string; to?: string }[]
  /** Workspaces archived and restored, oldest first. */
  archiveChanges?: { workspaceId: string; at: string; action: 'archive' | 'restore' }[]
  receipts: Record<string, Receipt>
  /** Older boards can be opened before the owner runs the offline cleanup. */
  retiredOrders?: RetiredOrders
}
type Body = Record<string, unknown>
export interface Mutation { id: string; key: string; hash: string }

export const workspaceScope = (root: string) => createHash('sha256').update('dsh-chief:superhub:').update(realpathSync(root)).digest('hex').slice(0, 32)
export const workspaceBoardFile = (scope: string) => join('ops','superhub-v2',workspaceFingerprint(scope) + '.json')

const BUDGET_USED = '这张工单的对话额度已用完'
export const UNKNOWN_TURN = '上次发言的派发结果待核对，请先查看原会话'
const now = () => new Date().toISOString()

export function mutationKey(path: string[], body: Body): Mutation {
  const id = body.requestId
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return workspaceError(400, '请提供有效的请求标识')
  // Prefixing also keeps caller-chosen object keys away from Object.prototype.
  return { id, key: 'req-' + id, hash: workspaceFingerprint([path, body]) }
}
export function assignmentTurn(workspaceId: string, sessionId: string, requestId: string, text: string, workOrderId?: string, inputAttachments?: ChatInputAttachment[]) {
  return mutationKey(['v2', 'workspaces', workspaceId, 'sessions', sessionId, 'messages'], { requestId, text, ...(workOrderId && {workOrderId}),
    ...inputAttachments?.length && {inputAttachments: inputAttachments.map(({id, name}) => [id, name])} })
}
function field(value: unknown, label: string, max: number, fallback?: string) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !value.trim() || value.length > max) return workspaceError(400, '请填写有效的' + label)
  return value.trim()
}
/** A follow-up time the owner gave is kept (never shown); a new order gets no default. */
function nextCheck(value: unknown) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    return workspaceError(400, '复查时间需要包含日期、时间和时区')
  }
  return new Date(value).toISOString()
}
/** The liaison's words when the owner's request lands on an archived workspace (assign, follow, directory, staff, same name). */
export const archivedRefusal = (name: string) => '「' + name + '」已归档，请先在工作区页恢复'
/** The personal workspace (「我的交办」) stays the liaison's default and cannot be archived. */
export const PERSONAL_NOT_ARCHIVABLE = '「我的交办」不能归档'
/** Shown on 「归档」 while work is in flight (a coding turn, a turn waiting for its directory, a busy group member). */
export const ARCHIVE_RUNNING = '有回合正在运行，请等它结束或叫停后再归档'
/** Every write to a workspace's content checks this first: an archived workspace takes nothing new until it is restored. */
function writable(board: Board, workspaceId: string | undefined) {
  if (board.workspaces.some(row => row.id === workspaceId && workspaceArchived(row))) workspaceError(409, WORKSPACE_ARCHIVED)
}
function findDelegation(board: Board, workspaceId: string, id: string): V2Delegation {
  return board.delegations.find(d => d.workspaceId === workspaceId && d.id === id) ?? workspaceError(404, '这个工作区没有这张工单')
}
function findSession(board: Board, workspaceId: string, id: string): V2Session {
  return board.sessions.find(s => s.workspaceId === workspaceId && s.id === id) ?? workspaceError(404, '这个工作区没有这场会话')
}
function newBoard(): Board {
  return { schema: 2, workspaces: [], delegations: [], sessions: [], decisions: [], receipts: {} }
}

function parseBoard(raw: string): Board {
  const board = JSON.parse(raw) as Board
  if ((board?.schema !== 1 && board?.schema !== 2) || ![board.workspaces, board.delegations, board.sessions, board.decisions].every(Array.isArray)
    || !board.receipts || typeof board.receipts !== 'object' || Array.isArray(board.receipts)
    || board.retiredOrders && (!Array.isArray(board.retiredOrders.orders) || !board.retiredOrders.orders.every(isLegacyOrder)
      || !Array.isArray(board.retiredOrders.sessions))) throw new Error('工作区数据格式无效')
  return board
}

function isLegacyOrder(order: V2Delegation): order is LegacyDelegation {
  return 'legacyTicketId' in order && typeof order.legacyTicketId === 'string' && /^T-\d+$/.test(order.legacyTicketId)
}

/** Source records remain available to the explicit cleanup if this brain is opened first. */
function retireLegacyOrders(board: Board, scope: string, activeSessionIds: ReadonlySet<string> = new Set()): RetiredOrders {
  const prior = board.retiredOrders ?? {orders:[],sessions:[]}
  const orders = [...prior.orders, ...board.delegations.filter(isLegacyOrder)]
  if (!orders.length) return prior
  const orderIds = new Set(orders.map(order => order.id))
  board.delegations = board.delegations.filter(order => !orderIds.has(order.id))
  const sessionIds = new Set(prior.sessions.map(session => session.id))
  const sharedSessions = new Set(activeSessionIds)
  for (const row of board.delegations) {
    sharedSessions.add(row.sessionId)
    for (const id of row.historySessionIds ?? []) sharedSessions.add(id)
  }
  for (const row of Object.values(board.receipts)) {
    if (row.kind === 'interject' && !orderIds.has(row.workOrderId ?? '') ||
      row.kind === 'turn' && (!row.reserved.length || row.reserved.some(hold => !orderIds.has(hold.id)))) sharedSessions.add(row.sessionId)
  }
  const synthetic = new Set(orders.map(order => 'native-' + workspaceFingerprint([scope,order.legacyTicketId]).slice(0,32)))
  const sessions = [...prior.sessions]
  board.sessions = board.sessions.filter(session => {
    if (!synthetic.has(session.id) || sharedSessions.has(session.id) || session.delegationIds.some(id => !orderIds.has(id))) return true
    sessions.push(session)
    sessionIds.add(session.id)
    return false
  })
  const detach = (session: V2Session) => { session.delegationIds = session.delegationIds.filter(id => !orderIds.has(id)) }
  for (const session of board.sessions) detach(session)
  board.decisions = board.decisions.filter(row => !orderIds.has(row.delegationId))
  const reports = new Set<string>()
  for (const id of orderIds) {
    for (const report of board.followups?.[id]?.reports ?? []) reports.add(report.id)
    delete board.followups?.[id]
    delete board.originals?.[id]
  }
  for (const id of sessionIds) { delete board.portraits?.[id]; delete board.groupResultsChecked?.[id] }
  for (const [key, row] of Object.entries(board.resultNotices ?? {})) {
    if (orderIds.has(row.orderId) || sessionIds.has(row.sessionId)) delete board.resultNotices![key]
  }
  const staleRequests = new Set<string>()
  for (const [key, row] of Object.entries(board.acceptances ?? {})) {
    if (!orderIds.has(row.orderId) && !sessionIds.has(row.sessionId)) continue
    staleRequests.add(key)
    if (row.followUp) staleRequests.add(row.followUp)
    delete board.acceptances![key]
  }
  const activeStart = (start: AssignmentStart) => {
    if (!sessionIds.has(start.sessionId) && !orderIds.has(start.delegationId ?? '')) return true
    staleRequests.add(start.requestId)
    return false
  }
  if (board.starts) board.starts = board.starts.filter(activeStart)
  if (board.signupStarts) board.signupStarts = board.signupStarts.filter(activeStart)
  for (const [key, row] of Object.entries(board.receipts)) {
    let retired = staleRequests.has(key.slice(4))
    if (row.kind === 'mutation') {
      const value = row.result
      retired ||= 'delegation' in value && orderIds.has(value.delegation.id) || 'session' in value && sessionIds.has(value.session.id)
      if (!retired && 'session' in value) detach(value.session)
    } else if (row.kind === 'turn') {
      const retained = row.reserved.filter(hold => !orderIds.has(hold.id))
      retired ||= sessionIds.has(row.sessionId) || row.reserved.length > 0 && !retained.length
      row.reserved = retained
    } else if (row.kind === 'interject') {
      retired ||= sessionIds.has(row.sessionId) || orderIds.has(row.workOrderId ?? '')
    } else if (row.kind === 'followup') {
      retired ||= reports.has(row.reportId ?? '')
    }
    if (retired) {
      delete board.receipts[key]
      delete board.liaisonTurns?.[key.slice(4)]
    }
  }
  board.retiredOrders = {orders,sessions}
  return board.retiredOrders
}

export function cleanupLegacyWorkspaceBoard(raw: string, scope: string, activeSessionIds: ReadonlySet<string>) {
  const board = parseBoard(raw)
  const sources = structuredClone([...board.sessions,...(board.retiredOrders?.sessions ?? [])])
  if (board.retiredOrders && activeSessionIds.size) {
    const restore = board.retiredOrders.sessions.filter(session => activeSessionIds.has(session.id))
    board.sessions.push(...restore)
    board.retiredOrders.sessions = board.retiredOrders.sessions.filter(session => !activeSessionIds.has(session.id))
  }
  const retired = retireLegacyOrders(board,scope,activeSessionIds)
  if (!retired.orders.length) return {retired, sources, sessions:board.sessions}
  delete board.retiredOrders
  const orderIds = new Set(retired.orders.map(row => row.id))
  for (const session of board.sessions) {
    if (session.legacyMessageOrder && orderIds.has(session.legacyMessageOrder.id)) delete session.legacyMessageOrder
  }
  return {retired, sources, sessions:board.sessions, text:JSON.stringify(board) + '\n'}
}

function assignmentId(action: 'assign' | 'signup' | 'staff', sourceId: string) {
  return createHash('sha256').update(action + ':' + sourceId).digest('hex')
}

function newWorkspace(name: string, goal: string, owner: string, projectDirectory?: string): V2Workspace {
  const id = randomUUID(), at = now()
  return { id, name, goal, owner, createdAt: at, icon: defaultWorkspaceIcon(id, name), ...(projectDirectory && {projectDirectory, projectDirectoryChangedAt: at}) }
}
const CODING_ONLY = '项目目录只用于 Codex 或 Claude Code 的编程工单'
const GROUP_DIRECTORY = '本单的项目目录只能在开新群时指定：群里的成员共用一个目录，请新开一张工单（不选现有会话）'
const directoryInput = (value: unknown) => value === undefined || value === null || value === '' ? undefined : value

function executorOf(value: unknown): V2Executor {
  if (value === undefined) return 'dsh'
  if (value === 'dsh' || value === 'codex' || value === 'claude-code') return value
  return workspaceError(400, '请选择工作区团队、Codex 或 Claude Code')
}

function newSession(workspaceId: string, title: string, executor: V2Executor): V2Session {
  return { id: randomUUID(), workspaceId, title, kind: executor === 'dsh' ? 'group' : 'coding', executor,
    delegationIds: [], closed: false, createdAt: now() }
}
/** A group chat on the group engine: the liaison and the workspace's staff; `directory` when opened for an order's own. */
function rosterSession(workspaceId: string, title: string, directory?: string): V2Session {
  return { id: randomUUID(), workspaceId, title, kind: 'group', executor: 'dsh', engine: 'roster', ...(directory && {directory}),
    delegationIds: [], closed: false, createdAt: now() }
}
export const isRosterGroup = (session: Pick<V2Session, 'engine'>) => session.engine === 'roster'

export function permissionOf(value: unknown): V2CodingPermission | undefined {
  if (value === undefined) return
  if (typeof value === 'string' && (CODING_PERMISSIONS as readonly string[]).includes(value)) return value as V2CodingPermission
  return workspaceError(400, '请选择请求批准、代为批准或完全访问')
}

function makeDelegation(workspace: V2Workspace, sessionId: string, body: Body, turns: number, directory?: string): V2Delegation {
  const title = field(body.title, '工单名称', 500)
  const permission = permissionOf(body.permission)
  return {
    ...(permission && {permission}), ...(directory && {directory}),
    id: randomUUID(), workspaceId: workspace.id, sessionId, title, owner: field(body.owner, '负责人', 160, workspace.owner),
    promise: field(body.promise, '结果约定', 8000, title), boundary: field(body.boundary, '操作范围', 4000, '在本工作区内准备，外部操作另行授权。'),
    ...(isEngagementReporting(body.reporting) && {reporting: body.reporting}),
    status: 'accepted', ...(body.nextCheckAt !== undefined && {nextCheckAt: nextCheck(body.nextCheckAt)}), generation: 1, remainingTurns: turns, createdAt: now(),
  }
}

/** Preserve every prior source while assigning each existing order one conversation. */
function migrateBoard(board: Board) {
  board.starts = board.signupStarts ?? board.starts ?? []
  delete board.signupStarts
  const receipts = Object.values(board.receipts)
  const migratedAt = now()
  for (const session of board.sessions) {
    const original = [...new Set(session.delegationIds)]
    if (original.length > 1) session.sharedHistory = true
    else if (original.length === 1 && board.delegations.some(d => d.id === original[0] && d.workspaceId === session.workspaceId)) {
      session.legacyMessageOrder = {id: original[0]!, through: migratedAt}
    }
  }
  for (const job of board.delegations) {
    const links = board.sessions.filter(s => s.workspaceId === job.workspaceId && s.delegationIds.includes(job.id))
    const start = board.starts.find(row => row.delegationId === job.id)
    const assigned = receipts.find(r => r.kind === 'mutation' && 'delegation' in r.result && r.result.delegation.id === job.id && 'session' in r.result)
    const latest = receipts.findLast(r => r.kind === 'turn' && r.reserved.some(hold => hold.id === job.id))
    const known = [start?.sessionId, assigned?.kind === 'mutation' && 'session' in assigned.result && assigned.result.session.id,
      latest?.kind === 'turn' && latest.sessionId]
    let owner = known.map(id => links.find(s => s.id === id)).find(s => !!s) ?? links[0]
    if (!owner) {
      owner = newSession(job.workspaceId, job.title, 'dsh')
      owner.createdAt = job.createdAt
      owner.delegationIds.push(job.id)
      board.sessions.push(owner)
    }
    job.sessionId = owner.id
    const history = links.filter(s => s.id !== owner.id)
    if (history.length) job.historySessionIds = history.map(s => s.id)
    for (const session of history) session.delegationIds = session.delegationIds.filter(id => id !== job.id)
  }
  // Published request identities and their historical result stay valid across the schema change.
  for (const receipt of receipts) if (receipt.kind === 'mutation') {
    const result = receipt.result
    if ('delegation' in result) {
      const order = findDelegation(board, result.delegation.workspaceId, result.delegation.id)
      result.delegation.sessionId = order.sessionId
      if (order.historySessionIds) result.delegation.historySessionIds = [...order.historySessionIds]
    }
    if ('session' in result) {
      const original = findSession(board,result.session.workspaceId,result.session.id)
      result.session.delegationIds = [...original.delegationIds]
    }
  }
  board.schema = 2
}

/** The owning runtime already holds the brain lock. A synchronous rename commits the
 * mutation and its receipt together before another request can reserve the same work. */
export class WorkspaceV2Store {
  private readonly file: string
  private readonly retiredOrderIds: ReadonlySet<string>
  private board: Board
  private disposed = false
  private checkedOldResults = false
  private lastResultCheck?: string

  private readonly rules: DirectoryRules
  /** New sessions (from the form, the liaison or an order) are roster groups; older sessions keep their old path. */
  readonly rosterGroups: boolean

  /**
   * `internal`: private storage outside the brain that is never a project directory (e.g. the plugin home).
   * `rosterGroups`: every new session is a group on the group engine (the host wires the engine).
   */
  constructor(root: string, readonly scope: string, private readonly turnLimit = 40, options: { internal?: string[]; directoryRules?: Partial<DirectoryRules>; rosterGroups?: boolean } = {}) {
    if (!Number.isSafeInteger(turnLimit) || turnLimit < 1) throw new Error('执行额度必须是正整数')
    this.rosterGroups = options.rosterGroups === true
    this.rules = {brainRoot: root, internal: options.internal ?? [], ...options.directoryRules}
    this.file = join(root, workspaceBoardFile(scope))
    this.board = existsSync(this.file) ? parseBoard(readFileSync(this.file, 'utf8')) : newBoard()
    const retired = retireLegacyOrders(this.board,scope)
    this.retiredOrderIds = new Set(retired.orders.map(order => order.id))
    const unfinished = Object.values(this.board.receipts).some(r => r.kind === 'turn' && r.state === 'pending' || r.kind === 'interject' && r.state === 'steering')
    if (unfinished || this.board.schema === 1 || this.board.workspaces.some(space => !space.icon)) this.commit(board => {
      if (board.schema === 1) migrateBoard(board)
      for (const space of board.workspaces) space.icon ??= defaultWorkspaceIcon(space.id, space.name)
      for (const receipt of Object.values(board.receipts)) {
        if (receipt.kind === 'turn' && receipt.state === 'pending') {
          this.settle(board, receipt, 'unknown')
          receipt.interrupted = now()
        }
        // The running turn may or may not have taken these words; they are never sent again on a guess.
        if (receipt.kind === 'interject' && receipt.state === 'steering') receipt.state = 'unknown'
      }
    })
  }

  dispose() { this.disposed = true }
  private current() {
    if (this.disposed) workspaceError(409, '第二大脑已切换，请重新打开工作区')
  }

  private commit<T>(change: (next: Board) => T): T {
    this.current()
    const next = structuredClone(this.board)
    const result = change(next)
    const temporary = this.file + '.' + randomUUID() + '.tmp'
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.file)
    } catch {
      if (existsSync(temporary)) unlinkSync(temporary)
      return workspaceError(503, '暂时无法保存工作区，请检查本地存储')
    }
    this.board = next
    return result
  }

  receipt(mutation: Mutation) {
    this.current()
    const receipt = this.board.receipts[mutation.key]
    if (receipt && receipt.hash !== mutation.hash) return workspaceError(409, '这条请求已用于另一项操作，请重新确认')
    return receipt
  }

  private write<T extends MutationResult>(mutation: Mutation, change: (board: Board) => T): T {
    const past = this.receipt(mutation)
    // receipt() matched the operation path and exact body, so the persisted result has this command's shape.
    if (past?.kind === 'mutation') return past.result as T
    return this.commit(board => {
      const result = change(board)
      board.receipts[mutation.key] = { kind: 'mutation', hash: mutation.hash, result: structuredClone(result) }
      return result
    })
  }

  /** Every workspace, archived ones included (`workspace(id)` reads through it). */
  list() { this.current(); return this.board.workspaces }
  /** The liaison's default workspace 「我的交办」, once it exists. */
  personalWorkspaceId(): string | undefined { this.current(); return this.board.personalWorkspaceId }
  /** The workspace page the owner speaks from. An archived workspace is no target (`archived`: read it anyway). */
  focus(context?: IntakeContext, archived = false) {
    this.current()
    if (context?.surface !== 'workspace' || !context.selectedId) return
    const workspace = this.board.workspaces.find(row => row.id === context.selectedId)
    if (!workspace || !archived && workspaceArchived(workspace)) return
    const session = context.sessionId && this.board.sessions.find(s => s.id === context.sessionId && s.workspaceId === workspace.id)
    const order = session && context.workOrderId && this.board.delegations.find(o => o.id === context.workOrderId && o.workspaceId === workspace.id && o.sessionId === session.id)
    return {workspace, session:session || undefined, order:order || undefined}
  }
  isRetiredOrder(id: string | undefined): boolean {
    return !!id && this.retiredOrderIds.has(id)
  }
  speakerPortraits(workspaceId: string, sessionId: string, ids: string[], staff?:Pick<WorkspaceStaffStore,'speakerPortraits'>): SpeakerPortraits {
    this.current()
    this.session(workspaceId, sessionId)
    const known = staff?.speakerPortraits(ids,[{conversation:groupLeadId(this.scope,workspaceId,sessionId),kind:'staff'}])
    const previous = this.board.portraits?.[sessionId] ?? {}
    const liaison = liaisonSpeakerId(groupLeadId(this.scope,workspaceId,sessionId))
    const fixed = {...known, ...(ids.includes(liaison) && {[liaison]: liaisonPortrait})}
    const seeded = Object.keys(fixed).length ? {...previous,...fixed} : previous
    // The liaison's look is reserved before it first speaks (an acceptance verdict can come after the members), so
    // no member of this conversation is given the same portrait.
    const reserved = !Object.hasOwn(seeded, liaison)
    const pool = reserved ? {...seeded, [liaison]: liaisonPortrait} : seeded
    const allocated = registerSpeakers(pool, ids)
    if (allocated === pool) return seeded
    this.commit(board => {
      const generic = Object.entries(allocated).filter(([id])=>!Object.hasOwn(pool,id))
      board.portraits ??= {}
      board.portraits[sessionId] = {...previous,...Object.fromEntries(generic)}
    })
    if (!reserved) return allocated
    const {[liaison]: _liaison, ...portraits} = allocated
    return portraits
  }
  workspace(id: string) { return this.list().find(w => w.id === id) ?? workspaceError(404, '找不到这个工作区') }
  /** Only an existing assignment receipt may bind a new liaison action to this owner turn. */
  assignedOrder(sourceId: string): V2Delegation | undefined {
    this.current()
    const receipt = this.board.receipts['req-' + assignmentId('signup', sourceId)] ??
      this.board.receipts['req-' + assignmentId('assign', sourceId)]
    if (receipt?.kind === 'mutation' && 'delegation' in receipt.result) {
      const original = receipt.result.delegation
      return this.delegation(original.workspaceId, original.id)
    }
  }

  orderOriginal(workspaceId:string, orderId:string) {
    this.current()
    this.delegation(workspaceId,orderId)
    return this.board.originals?.[orderId] ?? workspaceError(404, '这张工单没有已留存的原始交办。')
  }

  orderLabel(workspaceId:string, orderId:string) {
    this.current()
    return this.board.delegations.find(order => order.workspaceId === workspaceId && order.id === orderId)?.title
  }

  /** Old liaison assignments can be identified by their joint workspace/order/session receipt and unchanged auto-generated labels. */
  restoreAssignmentBriefs(ownerSources:() => {requestId:string;text:string}[], evidence?:V2DialogueSource['briefEvidence']) {
    type Assignment = {workspace:V2Workspace;delegation:V2Delegation;session:V2Session}
    const candidates:{key:string;receipt:Assignment}[] = []
    const explicitSessions = new Set<string>()
    for (const [key,saved] of Object.entries(this.board.receipts)) {
      if (saved.kind !== 'mutation') continue
      const captured = saved.result
      if ('session' in captured && !('delegation' in captured)) explicitSessions.add(captured.session.id)
      if (!('workspace' in captured && 'session' in captured && 'delegation' in captured)) continue
      const receipt = captured as Assignment
      if (this.board.originals?.[receipt.delegation.id]?.complete) continue
      if (!receipt.delegation.hasOriginal && receipt.delegation.title !== receipt.delegation.promise.trim().slice(0,200)) continue
      candidates.push({key,receipt})
    }
    if (!candidates.length) return
    const owners = new Map<string,string>()
    for (const source of ownerSources()) {
      owners.set('req-'+assignmentId('assign',source.requestId),source.text)
      owners.set('req-'+assignmentId('signup',source.requestId),source.text)
    }
    for (const {key,receipt} of candidates) {
      const before = receipt.delegation
      const order = this.board.delegations.find(row => row.id === before.id && row.workspaceId === receipt.workspace.id)
      if (!order) continue
      const session = this.session(order.workspaceId,order.sessionId), turnId = 'start-'+key.slice('req-'.length)
      const journal = evidence?.(session,turnId,order.id)
      const previous = this.board.originals?.[order.id]
      const stored = previous?.text ?? before.promise
      const original = [owners.get(key),this.board.starts?.find(row => row.requestId === turnId && row.delegationId === order.id)?.text,journal?.text]
        .find(text => typeof text === 'string' && text.trim().startsWith(stored.trim()))
      if (previous && !original) continue
      const text = original ?? stored
      const brief = interimOrderBrief(text,journal?.report)
      this.commit(board => {
        const current = findDelegation(board,order.workspaceId,order.id)
        const room = findSession(board,order.workspaceId,order.sessionId)
        if (room.id === receipt.session.id && !explicitSessions.has(room.id) && receipt.session.delegationIds[0] === order.id &&
          room.title === before.title && receipt.session.title === before.title) room.title = brief.sessionTitle ?? brief.title
        if (current.title === before.title) current.title = brief.title
        if (current.promise === before.promise) current.promise = brief.promise
        current.hasOriginal = true
        const originals = board.originals ??= {}
        originals[order.id] = {text,complete:original !== undefined}
      })
    }
  }

  followupState(workspaceId: string, orderId: string): OrderFollowupState {
    this.current()
    this.delegation(workspaceId, orderId)
    return this.board.followups?.[orderId] ?? { commitments: [], reports: [] }
  }

  scheduledFollowups() {
    this.current()
    const archived = new Set(this.board.workspaces.filter(workspaceArchived).map(row => row.id))
    return this.board.delegations.filter(order => !order.paused && !orderEnded(order) && !archived.has(order.workspaceId) &&
      this.board.followups?.[order.id]?.schedule?.enabled)
  }

  followupsIn(workspaceId: string, sessionId?: string) {
    this.workspace(workspaceId)
    if (sessionId) this.session(workspaceId, sessionId)
    return this.board.delegations.flatMap(order => {
      if (order.workspaceId !== workspaceId || sessionId && sessionId !== order.sessionId) return []
      const commitments = this.board.followups?.[order.id]?.commitments
      return commitments?.length ? [{order, commitments}] : []
    })
  }

  saveFollowup(workspaceId: string, orderId: string, generation: number, mutation: Mutation,
    change: (state: OrderFollowupState, order: V2Delegation) => string | undefined, notifyWeekly = false) {
    const past = this.receipt(mutation)
    if (past?.kind === 'followup') return past.reportId
    return this.commit(board => {
      writable(board, workspaceId)
      const order = findDelegation(board, workspaceId, orderId)
      if (order.generation !== generation) return workspaceError(409, '工单指示已变更，请重新打开工单')
      const records = board.followups ??= {}
      const state = records[orderId] ??= { commitments: [], reports: [] }
      const reportId = change(state, order)
      if (reportId && notifyWeekly) {
        const report = state.reports.find(row => row.id === reportId)!
        const notice = weeklyResult(this.scope, this.workspace(workspaceId), order, report)
        const notices = board.resultNotices ??= {}
        notices[notice.id] ??= notice
      }
      board.receipts[mutation.key] = { kind: 'followup', hash: mutation.hash, ...(reportId && {reportId}) }
      return reportId
    })
  }

  startResultBackfill(since: number) {
    this.current()
    if (this.checkedOldResults || this.board.resultNoticesBackfilled) return
    const old = Object.entries(this.board.receipts).flatMap(([key,turn]) =>
      turn.kind === 'turn' && (turn.state === 'sent' || turn.state === 'unknown') && !turn.resultCheck && turn.reserved.length === 1 && Date.parse(turn.at) >= since
        ? [{key,at:turn.at}] : []).sort((a,b) => b.at.localeCompare(a.at)).slice(0,15)
    if (old.length) this.commit(board => {
      for (const {key} of old) (board.receipts[key] as Turn).resultCheck = 'pending'
      board.resultNoticesBackfilled = true
    })
    this.checkedOldResults = true
  }

  uncheckedResults(requestId?: string) {
    this.current()
    const rows = []
    for (const [key, turn] of Object.entries(this.board.receipts)) {
      if (turn.kind !== 'turn' || turn.state !== 'sent' && turn.state !== 'unknown' || turn.resultCheck !== 'pending' || turn.reserved.length !== 1 ||
        requestId && key !== 'req-' + requestId) continue
      const order = this.board.delegations.find(row => row.id === turn.reserved[0]!.id && row.sessionId === turn.sessionId)
      if (order) rows.push({requestId: key.slice(4), order, at: turn.at, state:turn.state})
    }
    rows.sort((a,b) => b.at.localeCompare(a.at) || a.requestId.localeCompare(b.requestId))
    if (rows.length <= 15) return rows
    // A missing native journal stays retryable without blocking deliveries behind it.
    const start = (rows.findIndex(row => row.requestId === this.lastResultCheck) + 1) % rows.length
    const batch = rows.slice(start, start + 15)
    if (batch.length < 15) batch.push(...rows.slice(0,15 - batch.length))
    this.lastResultCheck = batch.at(-1)!.requestId
    return batch
  }

  publishResults(requestId: string, notices: StoredResult[]) {
    const key = 'req-' + requestId
    const turn = this.board.receipts[key]
    if (turn?.kind !== 'turn' || turn.state !== 'sent' || turn.resultCheck === 'done') return
    this.commit(board => {
      const receipt = board.receipts[key] as Turn
      let fresh = 0
      for (const notice of notices) {
        const order = findDelegation(board, notice.workspaceId, notice.orderId)
        if (order.sessionId !== notice.sessionId || receipt.sessionId !== order.sessionId || !receipt.reserved.some(r => r.id === order.id)) {
          return workspaceError(409, '这份报告的负责工单已经变更')
        }
        const saved = board.resultNotices ??= {}
        if (!saved[notice.id]) fresh++
        saved[notice.id] ??= notice
      }
      receipt.resultCheck = 'done'
      // New results are reviewed once against the order's promise, in the same write that publishes them.
      const hold = receipt.reserved[0]
      const order = hold && board.delegations.find(row => row.id === hold.id && row.sessionId === receipt.sessionId)
      if (fresh && receipt.review && order) {
        const records = board.acceptances ??= {}
        // Owner words for this order queued while this turn ran (a steer that did not land, a liaison supplement) come
        // first: they run next, so this result gets no automatic follow-up.
        const ownerWaiting = (board.starts ?? []).some(row => row.sessionId === order.sessionId && row.delegationId === order.id
          && (row.kind === 'interject' || row.kind === 'follow') && !row.requestId.startsWith(AUTO_FOLLOW_UP))
        records[requestId] ??= {workspaceId: order.workspaceId, sessionId: order.sessionId, orderId: order.id, generation: hold.generation, at: now(), state: 'pending',
          ...(ownerWaiting && {cancelled: true as const})}
      }
    })
  }

  resultNotices(): StoredResult[] { this.current(); return Object.values(this.board.resultNotices ?? {}) }
  resultNotice(id: string): StoredResult {
    this.current()
    return (/^[a-f0-9]{64}$/.test(id) && this.board.resultNotices?.[id]) || workspaceError(404, '本脑没有这条交付提醒')
  }
  readResult(id: string, mutation: Mutation) {
    this.resultNotice(id)
    const previous = this.receipt(mutation)
    if (!previous) this.commit(board => {
      board.resultNotices![id]!.read = true
      board.receipts[mutation.key] = {kind:'notice-read',hash:mutation.hash}
    })
    return this.resultNotice(id)
  }
  /** The liaison's words for a turn it speaks; absent for owner turns. */
  liaisonTurn(requestId: string): LiaisonTurn | undefined {
    this.current()
    const turn = this.board.liaisonTurns?.[requestId]
    return turn && structuredClone(turn)
  }

  queueEngagement(jobs: EngagementJob[]) {
    this.current()
    const fresh = jobs.filter(row => !this.board.engagementJobs?.[row.id])
    if (!fresh.length) return
    this.commit(board => {
      const jobs = board.engagementJobs ??= {}
      for (const row of fresh) {
        for (const waiting of Object.values(jobs)) {
          if (waiting.until && waiting.waitForMember && !waiting.done && waiting.seq < row.seq &&
            waiting.sessionId === row.sessionId && waiting.orderId === row.orderId && waiting.generation === row.generation &&
            row.turn === 'member' && row.memberId === waiting.waitForMember) waiting.done = true
        }
        jobs[row.id] = row
      }
    })
  }

  repeatedEngagement(orderId: string, generation: number, decision: EngagementDecision, evidence: string,
    evidenceAt: (seq: number) => string | undefined): boolean {
    const same = (left: string | undefined, right: string | undefined) => left?.trim().replace(/\s+/g, ' ') === right?.trim().replace(/\s+/g, ' ')
    const recipients = [...decision.memberIds ?? []].sort().join(',')
    return Object.values(this.board.engagementJobs ?? {}).filter(row => row.done && row.orderId === orderId && row.generation === generation &&
      row.decision?.kind === 'continue' && same(row.decision.text, decision.text) &&
      [...row.decision.memberIds ?? []].sort().join(',') === recipients && same(evidenceAt(row.seq), evidence)).length >= 2
  }

  /**
   * Older hosts let the model overrule a reply the owner addressed to an item, which left the item pending after its
   * reply job had closed. Each such reply counts as the answer, once, from its own message.
   */
  settleAnsweredReplies() {
    this.current()
    const actions = this.board.ownerActions ?? {}
    const replies = Object.values(this.board.engagementJobs ?? {}).filter(row => row.done && row.turn === 'owner' && row.answerTo &&
      actions[row.answerTo] && !actions[row.answerTo]!.resolved && actions[row.answerTo]!.sessionId === row.sessionId)
      .sort((left, right) => left.seq - right.seq)
    if (!replies.length) return 0
    return this.commit(board => {
      let settled = 0
      for (const row of replies) {
        const action = board.ownerActions![row.answerTo!]!
        if (action.resolved) continue
        action.resolved = true
        action.answerMessageId = 'g-' + row.seq
        settled += 1
      }
      return settled
    })
  }

  pendingEngagement(): EngagementJob[] {
    this.current()
    return structuredClone(Object.values(this.board.engagementJobs ?? {}).filter(row => !row.done))
  }

  activeEngagement(job: EngagementJob) {
    const workspace = this.board.workspaces.find(item => item.id === job.workspaceId)
    const session = this.board.sessions.find(item => item.id === job.sessionId && item.workspaceId === job.workspaceId)
    if (!workspace || workspaceArchived(workspace) || !session || session.closed) return false
    if (!job.orderId) return true
    const order = this.board.delegations.find(item => item.id === job.orderId && item.sessionId === job.sessionId && item.workspaceId === job.workspaceId)
    return !!order && !orderEnded(order) && !order.paused && order.generation === job.generation
  }

  /** Persist the next action before dispatch. Replayed receipts stay visible only within their original generation. */
  recordEngagement(job: EngagementJob, decision: EngagementDecision, question?: {seq: number; at: string},
    intake?: {source: number; text: string; title: string; promise: string; reporting: EngagementReporting}, answer?: OwnerAction, revised?: {reporting?: EngagementReporting; promise?: string}) {
    return this.commit(board => {
      const row = board.engagementJobs?.[job.id]
      if (!row || row.done || !this.activeEngagement(row)) return
      if (row.decision) return structuredClone(row)
      if (intake && !row.orderId) {
        const workspace = board.workspaces.find(item => item.id === row.workspaceId)!
        const session = findSession(board, row.workspaceId, row.sessionId)
        const id = 'group-' + workspaceFingerprint([session.id, intake.source]).slice(0, 32)
        const existing = board.delegations.find(item => item.id === id)
        const order = existing ?? makeDelegation(workspace, session.id, {...intake, owner: '接口人', permission: 'ask'}, this.turnLimit, session.directory)
        if (!existing) {
          order.id = id
          order.hasOriginal = true
          ;(board.originals ??= {})[id] = {text: intake.text, complete: true}
          session.delegationIds.push(id)
          board.delegations.push(order)
        }
        row.orderId = id
        row.intakeSeq = intake.source
        row.generation = order.generation
      }
      if (answer?.orderId && !job.orderId) {
        row.orderId = answer.orderId
        row.generation = findDelegation(board, row.workspaceId, answer.orderId).generation
      }
      row.decision = structuredClone(decision)
      delete row.until
      const actions = board.ownerActions ??= {}
      if (row.turn === 'owner') {
        for (const id of decision.resolved ?? []) {
          const wanted = actions[id]
          if (wanted?.sessionId === row.sessionId && wanted.workspaceId === row.workspaceId && (!row.orderId || wanted.orderId === row.orderId) &&
            (!row.answerTo || id === row.answerTo) && this.actionActive(wanted)) {
            wanted.resolved = true
            wanted.answerMessageId = 'g-' + row.seq
          }
        }
      }
      const order = row.orderId && board.delegations.find(item => item.id === row.orderId)
      if (order) {
        if (revised?.reporting) order.reporting = revised.reporting
        const promise = revised?.promise?.trim()
        if (promise && promise !== order.promise) {
          advance(board, order)
          row.generation = order.generation
          order.promise = promise.slice(0, 8000)
          for (const action of Object.values(actions)) {
            if (action.orderId === order.id && !action.resolved && action.generation !== order.generation) action.resolved = true
          }
        }
        if (decision.kind === 'ask') order.reason = '等待主人回应'
        if (decision.kind === 'wait') order.reason = decision.reason ?? decision.text ?? '等待后续材料'
        if (decision.kind === 'deliver' && decision.final !== false) order.reason = '接口人已核对并交付成果'
        if (decision.kind === 'continue') order.reason = '接口人已安排下一步'
      }
      if (decision.kind === 'ask' && decision.text && question) {
        const id = 'action-' + workspaceFingerprint([row.sessionId, row.orderId, row.generation, question.seq]).slice(0, 40)
        actions[id] ??= {id, workspaceId: row.workspaceId, sessionId: row.sessionId, orderId: row.orderId,
          generation: row.generation, messageId: 'g-' + question.seq, question: decision.text, at: question.at}
      }
      return structuredClone(row)
    })
  }

  closeEngagement(id: string, result?: StoredResult, waitUntil?: string, waitForMember?: string) {
    this.current()
    const saved = this.board.engagementJobs?.[id]
    if (!saved || saved.done) return
    this.commit(board => {
      const row = board.engagementJobs![id]!
      if (result) (board.resultNotices ??= {})[result.id] ??= result
      if (waitUntil && (row.attempts ?? 0) < 2) {
        delete row.decision
        row.until = waitUntil
        row.waitForMember = waitForMember
        row.attempts = (row.attempts ?? 0) + 1
      } else {
        row.done = true
        if (waitUntil && row.orderId) findDelegation(board, row.workspaceId, row.orderId).reason =
          '已完成约定的复核次数，等待新的依赖信息或主人的后续安排'
      }
    })
  }

  stopEngagement(sessionId: string, memberId?: string) {
    const jobs = this.pendingEngagement().filter(row => row.sessionId === sessionId && (!memberId || row.memberId === memberId || row.decision?.memberIds?.includes(memberId)))
    const actions = memberId ? [] : Object.values(this.board.ownerActions ?? {}).filter(row => row.sessionId === sessionId && !row.resolved)
    if (!jobs.length && !actions.length) return false
    this.commit(board => {
      for (const row of jobs) board.engagementJobs![row.id]!.done = true
      for (const row of actions) board.ownerActions![row.id]!.resolved = true
    })
    return true
  }

  engagementActive(id: string) {
    const row = this.board.engagementJobs?.[id]
    if (!row || row.done || !this.activeEngagement(row)) return false
    return row.turn !== 'member' || !row.orderId || !Object.values(this.board.resultNotices ?? {}).some(result =>
      result.orderId === row.orderId && result.requestId === 'checkpoint:' + row.generation + ':final')
  }

  private actionActive(row: StoredOwnerAction): boolean {
    return !row.resolved && this.activeEngagement({...row, id: row.id, seq: 0, turn: 'owner'})
  }

  ownerAction(id: string, historical = false): OwnerAction | undefined {
    this.current()
    const row = this.board.ownerActions?.[id]
    if (!row || (!historical && !this.actionActive(row))) return
    const workspace = this.workspace(row.workspaceId)
    const session = this.session(row.workspaceId, row.sessionId)
    const {generation, resolved, answerMessageId, ...action} = row
    return {...action, workspaceName: workspace.name, sessionTitle: session.title}
  }

  ownerActions(sessionId?: string, orderId?: string): OwnerAction[] {
    this.current()
    return Object.values(this.board.ownerActions ?? {}).flatMap(row => {
      if ((sessionId && row.sessionId !== sessionId) || (orderId && row.orderId !== orderId)) return []
      return this.ownerAction(row.id) ?? []
    })
  }

  engagementCheckpoints(orderId: string, generation: number) {
    this.current()
    const prefix = 'checkpoint:' + generation + ':'
    return Object.values(this.board.resultNotices ?? {}).flatMap(row =>
      row.orderId === orderId && row.requestId?.startsWith(prefix) ? [row.requestId.slice(prefix.length)] : [])
  }

  groupEvidence(orderId?: string): StoredResult[] {
    this.current()
    return structuredClone(Object.values(this.board.groupEvidence ?? {}).filter(row => !orderId || row.orderId === orderId))
  }

  /** Reviews still to run, and verdict notes still to post. */
  pendingAcceptances() {
    this.current()
    return Object.entries(this.board.acceptances ?? {}).flatMap(([turnId, row]) => row.state === 'pending' ? [{turnId, ...structuredClone(row)}] : [])
  }
  unpostedAcceptances() {
    this.current()
    return Object.entries(this.board.acceptances ?? {}).flatMap(([turnId, row]) => row.note && !row.posted ? [{turnId, ...structuredClone(row)}] : [])
  }
  acceptance(turnId: string): AcceptanceRecord | undefined {
    this.current()
    const row = this.board.acceptances?.[turnId]
    return row && structuredClone(row)
  }
  /** The verdict note reached the conversation as message `messageId` (absent when the source does not say). */
  acceptancePosted(turnId: string, messageId?: string) {
    const saved = this.board.acceptances?.[turnId]
    if (saved?.posted && (!messageId || saved.messageId === messageId)) return
    this.commit(board => {
      const row = board.acceptances?.[turnId]
      if (!row) return
      row.posted = true
      if (messageId) row.messageId = messageId
    })
  }

  /**
   * Record the liaison's review of `turnId` on its order. A gap the liaison has not followed up yet becomes one
   * follow-up turn in the liaison's words (queued like a supplement, using one turn when it is reserved); a gap after
   * that, or without budget for it, waits for the owner. The owner's words since the review began win: no follow-up.
   */
  finishAcceptance(turnId: string, outcome: AcceptanceOutcome): {note?: string; followUp?: AssignmentStart} {
    this.current()
    if (this.board.acceptances?.[turnId]?.state !== 'pending') return {}
    return this.commit(board => {
      const record = board.acceptances![turnId]!
      const order = findDelegation(board, record.workspaceId, record.orderId)
      const at = now()
      // A later turn's result was reviewed first: the order keeps showing that newer verdict, and this one is only recorded.
      const shown = order.acceptance && order.acceptance.turnId !== turnId ? board.acceptances![order.acceptance.turnId] : undefined
      const superseded = !!shown && shown.at > record.at
      if (outcome.kind !== 'verdict') {
        record.state = outcome.kind
        if (outcome.kind === 'failed' && !superseded) order.acceptance = {verdict: 'failed', at, turnId, reason: outcome.reason}
        return {}
      }
      record.state = 'done'
      const gaps = outcome.gaps
      const acceptance: V2Acceptance = {verdict: outcome.verdict, at, turnId, ...(gaps.length ? {gaps} : {})}
      const changed = orderEnded(order) || order.paused || order.generation !== record.generation || order.sessionId !== record.sessionId
      if (superseded) return {}
      if (changed || record.cancelled) {
        order.acceptance = {...acceptance, reason: changed ? '工单已变更，验收意见未发出' : '主人已有新的指示，未自动追问'}
        return {}
      }
      if (outcome.verdict === 'pass') {
        order.acceptance = acceptance
        record.note = acceptanceText.pass(outcome.message)
        record.pass = true
        return {note: record.note}
      }
      const followed = (order.autoFollowUps ?? 0) >= 1
      const starts = board.starts ??= []
      const waiting = starts.filter(row => row.delegationId === order.id && row.generation === order.generation).length
      if (followed || order.remainingTurns <= waiting) {
        order.acceptance = {...acceptance, awaitingOwner: true, ...(!followed && {reason: '额度不足，未自动追问'})}
        record.note = acceptanceText.decide(outcome.message, gaps, followed)
        return {note: record.note}
      }
      if (record.group) {
        // In a group the follow-up is the liaison's own line @-mentioning the members who handed back (posted by the host).
        order.autoFollowUps = (order.autoFollowUps ?? 0) + 1
        order.acceptance = acceptance
        record.note = acceptanceText.followUp(outcome.message, gaps)
        record.followUp = 'group'
        return {note: record.note}
      }
      const requestId = AUTO_FOLLOW_UP + workspaceFingerprint(turnId)
      const text = acceptanceText.followUp(outcome.message, gaps)
      const mutation = assignmentTurn(order.workspaceId, order.sessionId, requestId, text, order.id)
      const start: AssignmentStart = {kind: 'follow', workspaceId: order.workspaceId, sessionId: order.sessionId, delegationId: order.id,
        generation: order.generation, requestId, text}
      starts.push(start)
      board.receipts[mutation.key] = {kind: 'follow', hash: mutation.hash, state: 'queued'}
      const liaisonTurns = board.liaisonTurns ??= {}
      liaisonTurns[requestId] = {}
      order.autoFollowUps = (order.autoFollowUps ?? 0) + 1
      order.acceptance = acceptance
      record.followUp = requestId
      return {followUp: structuredClone(start)}
    })
  }

  /**
   * The owner spoke to an order (or the session discussion): the owner's words come first. Pending reviews will not
   * follow up, an automatic follow-up still waiting to start is dropped, and a waiting acceptance decision is answered.
   */
  ownerSpoke(sessionId: string, orderId?: string) {
    this.current()
    if (!ownerFirst(this.board, sessionId, orderId, false)) return
    this.commit(board => { ownerFirst(board, sessionId, orderId, true) })
  }

  /** Orders whose results are still short after the liaison's follow-up: 「等你决定」. */
  awaitingAcceptance() {
    this.current()
    return this.board.delegations.filter(row => row.acceptance?.awaitingOwner && !orderEnded(row))
  }

  /** Owner words about the order itself, by their request (409 when the request id was used for other words). */
  command(mutation: Mutation): OwnerCommand | undefined {
    this.current()
    const row = this.board.commands?.[mutation.id]
    if (row && row.hash !== mutation.hash) return workspaceError(409, '这条请求已用于另一项操作，请重新确认')
    return row && structuredClone(row)
  }

  /**
   * Save the liaison's reading of owner words on `orderId`: a clear completion finishes the order at once (unless it has
   * an enabled recurring schedule); anything else holds the words for the owner's choice. Undefined when the words are
   * already on their way to the executor or the order cannot take them any more (the usual path then answers).
   */
  recordCommand(mutation: Mutation, session: V2Session, orderId: string, text: string, judged: OwnerCommand['judged'], reason?: string, at = new Date(), inputAttachments?: ChatInputAttachment[]):
    {command: OwnerCommand; requestId: string; completed: boolean} | undefined {
    const past = this.command(mutation)
    if (past) return {command: past, requestId: mutation.id, completed: false}
    if (this.board.receipts[mutation.key]) return
    writable(this.board, session.workspaceId)
    const order = this.delegation(session.workspaceId, orderId)
    if (order.sessionId !== session.id || orderEnded(order) || findSession(this.board, session.workspaceId, session.id).closed) return
    return this.commit(board => {
      const job = findDelegation(board, session.workspaceId, orderId)
      const scheduled = !!board.followups?.[job.id]?.schedule?.enabled
      const complete = judged === 'complete' && !scheduled
      const command: OwnerCommand = {workspaceId: session.workspaceId, sessionId: session.id, orderId, generation: job.generation, text, hash: mutation.hash,
        at: at.toISOString(), judged, ...(reason && {reason}), ...(scheduled && {scheduled: true as const}), outcome: complete ? 'completed' : 'held',
        ...inputAttachments?.length && {inputAttachments: structuredClone(inputAttachments)}}
      ;(board.commands ??= {})[mutation.id] = command
      if (complete) {
        finishOrder(board, job, at, 'owner-words', mutation.id)
        advance(board, job)
      }
      return {command: structuredClone(command), requestId: mutation.id, completed: complete}
    })
  }

  /** The owner's words and the liaison's note of a command reached the conversation. */
  commandPosted(requestId: string, posted: {ownerMessageId?: string; noteMessageId?: string}) {
    const row = this.board.commands?.[requestId]
    if (!row || (!posted.ownerMessageId || row.ownerMessageId === posted.ownerMessageId) && (!posted.noteMessageId || row.noteMessageId === posted.noteMessageId)) return
    this.commit(board => {
      const saved = board.commands![requestId]!
      if (posted.ownerMessageId) saved.ownerMessageId = posted.ownerMessageId
      if (posted.noteMessageId) saved.noteMessageId = posted.noteMessageId
    })
  }
  /** Held words the owner chose to hand to the executor that have no delivery receipt yet (dispatched again on start). */
  unforwardedCommands() {
    this.current()
    return Object.entries(this.board.commands ?? {}).flatMap(([requestId, row]) =>
      row.resolved?.kind === 'forward' && !choiceTaken(this.board, requestId, row) ? [{requestId, ...structuredClone(row)}] : [])
  }
  /** Commands whose words or note are not in the conversation yet (posted again after a restart). */
  unpostedCommands() {
    this.current()
    return Object.entries(this.board.commands ?? {}).flatMap(([requestId, row]) => !row.ownerMessageId || !row.noteMessageId ? [{requestId, ...structuredClone(row)}] : [])
  }
  /** Held owner words of a session, by their message id (or their request id). */
  heldCommand(workspaceId: string, sessionId: string, id: string): {requestId: string; command: OwnerCommand} {
    this.current()
    const found = Object.entries(this.board.commands ?? {}).find(([requestId, row]) => row.workspaceId === workspaceId && row.sessionId === sessionId
      && (row.ownerMessageId === id || requestId === id))
    if (!found) return workspaceError(404, '这场会话里没有待你选择的这句话')
    return {requestId: found[0], command: structuredClone(found[1])}
  }

  /**
   * The owner chose to hand held words to the executor: recorded once, before they are dispatched with their own
   * request id (the dispatch itself is idempotent by that request). A replay of `mutation` returns the same session.
   */
  forwardCommand(mutation: Mutation, workspaceId: string, sessionId: string, requestId: string, at = new Date()) {
    return this.write(mutation, board => {
      writable(board, workspaceId)
      const session = findSession(board, workspaceId, sessionId)
      const row = board.commands?.[requestId]
      if (!row || row.workspaceId !== workspaceId || row.sessionId !== sessionId) return workspaceError(404, '这场会话里没有待你选择的这句话')
      if (row.outcome !== 'held') return workspaceError(409, '这句话已按你的话收单，没有可交给执行者的选择')
      if (choiceTaken(board, requestId, row)) return workspaceError(409, row.resolved!.kind === 'forward' ? '这句话已经交给执行者' : '你已为这句话选择收单')
      const order = findDelegation(board, workspaceId, row.orderId)
      if (orderEnded(order) || order.paused) return workspaceError(409, order.paused ? '工单已暂停，恢复后再交给执行者' : stoppedReason(order))
      if (session.closed) return workspaceError(409, '这场会话已关闭，重新打开原会话即可继续')
      const queued = (board.starts ?? []).filter(row => row.delegationId === order.id && row.generation === order.generation).length
      if (order.remainingTurns <= queued) return workspaceError(409, BUDGET_USED)
      row.resolved = {kind: 'forward', at: at.toISOString()}
      return {session}
    })
  }

  /** The order's enabled recurring schedule while the order can run (not finished, cancelled or paused). */
  activeSchedule(order: Pick<V2Delegation, 'id' | 'status' | 'paused'>) {
    this.current()
    if (orderEnded(order) || order.paused) return
    const schedule = this.board.followups?.[order.id]?.schedule
    return schedule?.enabled ? structuredClone(schedule) : undefined
  }
  /** The next run of the order's enabled recurring schedule; nothing without one. */
  nextCheck(order: Pick<V2Delegation, 'id' | 'status' | 'paused'>, timeZone: string, now = new Date()): string | undefined {
    const plan = this.activeSchedule(order)
    if (!plan) return
    const [hour, minute] = plan.time.split(':').map(Number)
    return nextSlot({kind: 'daily', days: [plan.weekday], minute: hour! * 60 + minute!}, now, timeZone)?.toISOString()
  }
  /** An order as views show it: the stored follow-up time is replaced by the schedule's next run (or left out). */
  present(order: V2Delegation, timeZone: string, now = new Date()): V2Delegation {
    const {nextCheckAt: _stored, hasSchedule: _flag, conversationId: _conversation, ...shown} = order
    const next = this.nextCheck(order, timeZone, now)
    return {...shown, ...(next && {nextCheckAt: next}), ...(this.hasSchedule(order) && {hasSchedule: true as const})}
  }
  /** Remember which liaison conversation opened an order, so the owner's next words there ("先别改") can refer to it. */
  markConversation(workspaceId: string, orderId: string, conversationId: string) {
    this.commit(board => {
      const order = findDelegation(board, workspaceId, orderId)
      if (!order.conversationId) order.conversationId = conversationId
    })
  }
  /** The orders this liaison conversation opened most recently (newest first), kept only while they can still take words. */
  recentConversationOrders(conversationId: string, limit = 3): V2Delegation[] {
    this.current()
    return this.board.delegations.filter(order => order.conversationId === conversationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
      .filter(order => !orderEnded(order) && !order.paused)
  }
  /** The order has an enabled recurring schedule, whether or not it can run now (a paused order keeps it). */
  hasSchedule(order: Pick<V2Delegation, 'id'>) {
    this.current()
    return !!this.board.followups?.[order.id]?.schedule?.enabled
  }

  /**
   * What the conversation of `session` shows beyond the messages themselves: owner words held back from the executor
   * (by message id) and the choices on liaison messages, with whether they were taken.
   */
  conversationChoices(session: V2Session): {held: Record<string, V2Held>; actions: Record<string, V2MessageAction[]>} {
    this.current()
    const held: Record<string, V2Held> = {}, actions: Record<string, V2MessageAction[]> = {}
    const orderOf = (row: {workspaceId: string; orderId: string}) => this.board.delegations.find(order => order.id === row.orderId && order.workspaceId === row.workspaceId)
    // The same rule as the order page's 「标为完成」: an enabled schedule, paused or not, is stopped with the order.
    const completeAction = (order: V2Delegation): V2MessageAction => !orderEnded(order) && this.hasSchedule(order)
      ? {kind: 'complete', label: ACTION_LABEL.completeSchedule, stopSchedule: true} : {kind: 'complete', label: ACTION_LABEL.complete}
    for (const [requestId, row] of Object.entries(this.board.commands ?? {})) {
      const order = orderOf(row)
      if (row.sessionId !== session.id || row.workspaceId !== session.workspaceId || !order) continue
      const resolved = choiceTaken(this.board, requestId, row) ? row.resolved : undefined
      const done = resolved && {done: {at: resolved.at}}
      if (row.ownerMessageId && resolved?.kind !== 'forward') {
        held[row.ownerMessageId] = row.outcome === 'completed' || resolved?.kind === 'complete' ? 'completed' : orderEnded(order) ? 'kept' : 'choosing'
      }
      if (!row.noteMessageId) continue
      if (row.outcome === 'completed') {
        // Undo stays offered while this completion stands; reopened (or completed again) elsewhere, the note has no button.
        if (resolved || order.status === 'done' && order.completedFrom === requestId) actions[row.noteMessageId] = [{kind: 'reopen', label: ACTION_LABEL.reopen, ...done}]
      } else if (resolved?.kind === 'complete') actions[row.noteMessageId] = [{...completeAction(order), ...done}]
      else if (resolved?.kind === 'forward') actions[row.noteMessageId] = [{kind: 'forward', label: ACTION_LABEL.forward, messageId: row.ownerMessageId ?? requestId, ...done}]
      else actions[row.noteMessageId] = [completeAction(order), {kind: 'forward', label: ACTION_LABEL.forward, messageId: row.ownerMessageId ?? requestId}]
    }
    for (const row of Object.values(this.board.acceptances ?? {})) {
      const order = orderOf(row)
      if (row.sessionId !== session.id || row.workspaceId !== session.workspaceId || !row.pass || !row.messageId || !order) continue
      actions[row.messageId] = [{...completeAction(order), ...(row.completedAt && {done: {at: row.completedAt}})}]
    }
    return {held, actions}
  }

  /** Validate a project directory the owner named (400 with the reason); returns the resolved path. */
  checkDirectory(value: unknown): string { return checkProjectDirectory(value, this.rules) }
  /** Directories to offer while the owner types a project directory (read-only; same rules as binding). */
  suggestDirectories(path: string): V2DirectorySuggestions { return suggestDirectories(path, this.rules) }

  /** Bind, change (`directory`) or remove (empty) the workspace's project directory; it applies from the next turn. */
  setDirectory(mutation: Mutation, workspaceId: string, body: Body) {
    return this.write(mutation, board => {
      const workspace = board.workspaces.find(row => row.id === workspaceId) ?? workspaceError(404, '找不到这个工作区')
      writable(board, workspaceId)
      if (!Object.hasOwn(body, 'directory')) return workspaceError(400, '请填写项目目录，或留空以解除绑定')
      const requested = directoryInput(body.directory)
      const to = requested === undefined ? undefined : this.checkDirectory(requested)
      const from = workspace.projectDirectory
      if (from === to) return { workspace }
      const at = now()
      if (to) workspace.projectDirectory = to
      else delete workspace.projectDirectory
      workspace.projectDirectoryChangedAt = at
      ;(board.directoryChanges ??= []).push({workspaceId, at, ...(from && {from}), ...(to && {to})})
      return { workspace }
    })
  }

  /**
   * Archive a workspace: it keeps everything (directory, sessions, orders, staff) but takes no new work. Refused for
   * 「我的交办」, while an order is not finished or cancelled (paused counts as open), and while `busy` (work still
   * running, which only the routes know about). Archiving again is a no-op.
   */
  archive(mutation: Mutation, workspaceId: string, busy: () => boolean = () => false, at = new Date()) {
    return this.write(mutation, board => {
      const workspace = board.workspaces.find(row => row.id === workspaceId) ?? workspaceError(404, '找不到这个工作区')
      if (workspace.id === board.personalWorkspaceId) return workspaceError(409, PERSONAL_NOT_ARCHIVABLE)
      if (workspaceArchived(workspace)) return { workspace }
      const open = board.delegations.filter(order => order.workspaceId === workspaceId && !orderEnded(order))
      if (open.length) {
        const titles = open.slice(0, 5).map(order => '「' + order.title + '」').join('、') + (open.length > 5 ? '等' : '')
        return workspaceError(409, '还有 ' + open.length + ' 张工单未结束：' + titles + '。请先完成或取消再归档')
      }
      if (busy()) return workspaceError(409, ARCHIVE_RUNNING)
      workspace.archivedAt = at.toISOString()
      ;(board.archiveChanges ??= []).push({workspaceId, at: workspace.archivedAt, action: 'archive'})
      return { workspace }
    })
  }

  /** Restore an archived workspace exactly as it was; restoring an active workspace is a no-op. */
  restore(mutation: Mutation, workspaceId: string, at = new Date()) {
    return this.write(mutation, board => {
      const workspace = board.workspaces.find(row => row.id === workspaceId) ?? workspaceError(404, '找不到这个工作区')
      if (!workspaceArchived(workspace)) return { workspace }
      delete workspace.archivedAt
      ;(board.archiveChanges ??= []).push({workspaceId, at: at.toISOString(), action: 'restore'})
      return { workspace }
    })
  }

  /** 409 when the workspace is archived (writes that do not go through the board check this first). */
  writable(workspaceId: string) {
    this.current()
    writable(this.board, workspaceId)
  }

  /** The project directory a coding turn of this order (or the session discussion) uses; absent: SuperHub's own. */
  directoryOf(workspaceId: string, orderId?: string): V2WorkDirectory | undefined {
    const order = orderId ? this.delegation(workspaceId, orderId) : undefined
    if (order?.directory) return {source: 'order', path: order.directory}
    const workspace = this.workspace(workspaceId)
    if (workspace.projectDirectory) return {source: 'workspace', path: workspace.projectDirectory}
  }

  delegation(workspace: string, id: string) { return findDelegation(this.board, workspace, id) }
  session(workspace: string, id: string) { return findSession(this.board, workspace, id) }
  view(id: string): V2WorkspaceView {
    const workspace = this.workspace(id)
    const latest = new Map<string, string>()
    for (const r of Object.values(this.board.receipts)) {
      if (r.kind === 'turn' && r.state !== 'unsent' && r.at > (latest.get(r.sessionId) ?? '')) latest.set(r.sessionId, r.at)
    }
    const activity = (s: V2Session) => latest.get(s.id) ?? s.createdAt
    const orders = this.board.delegations.filter(d => d.workspaceId === id)
    return {
      scope: this.scope, workspace,
      sessions: this.board.sessions.filter(s => s.workspaceId === id).sort((a, b) => activity(b).localeCompare(activity(a))),
      orders, delegations: orders,
      decisions: this.board.decisions.filter(d => d.workspaceId === id),
    }
  }

  createWorkspace(mutation: Mutation, body: Body, reuseName = false) {
    return this.write(mutation, board => {
      const name = field(body.name, '工作区名称', 160)
      if (reuseName) {
        const matches = board.workspaces.filter(space => space.name.normalize('NFC') === name.normalize('NFC'))
        if (matches.length > 1) return workspaceError(409, '已有多份同名工作区，请先列出工作区，请主人按目标或负责人选择。')
        if (matches[0] && workspaceArchived(matches[0])) return workspaceError(409, archivedRefusal(matches[0].name))
        if (matches[0]) return { workspace: matches[0], outcome: 'existing' }
      }
      const goal = body.goal === '' || body.goal === undefined ? '' : field(body.goal, '工作区目标', 4000)
      const requested = directoryInput(body.directory)
      const workspace = newWorkspace(name, goal, field(body.owner, '负责人', 160, '工作区负责人'), requested === undefined ? undefined : this.checkDirectory(requested))
      if (workspace.projectDirectory) (board.directoryChanges ??= []).push({workspaceId: workspace.id, at: workspace.createdAt, to: workspace.projectDirectory})
      board.workspaces.push(workspace)
      return reuseName ? { workspace, outcome: 'created' } : { workspace }
    })
  }

  createDelegation(mutation: Mutation, workspace: V2Workspace, body: Body, staff?: {id:string;name:string;token:string}) {
    return this.write(mutation, board => {
      writable(board, workspace.id)
      let session: V2Session
      const requested = directoryInput(body.directory)
      if (body.sessionId !== undefined) {
        session = findSession(board, workspace.id, field(body.sessionId, '会话', 160))
        if (session.closed) return workspaceError(409, '这场会话已关闭，请选择可继续执行的会话')
        if (!isRosterGroup(session) && body.executor !== undefined && session.executor !== body.executor) return workspaceError(409, '指定的执行者与所选会话不同')
      } else {
        const title = field(body.title, '工单名称', 500)
        session = this.rosterGroups ? rosterSession(workspace.id, title.slice(0,200), requested === undefined ? undefined : this.checkDirectory(requested))
          : newSession(workspace.id, title.slice(0,200), executorOf(body.executor))
        board.sessions.push(session)
      }
      if (isRosterGroup(session)) {
        // The members of a group share one directory: an order's own directory opens its group there.
        if (requested !== undefined && this.checkDirectory(requested) !== session.directory) return workspaceError(400, GROUP_DIRECTORY)
        const delegation = makeDelegation(workspace, session.id, staff ? {...body,owner:staff.name} : body, this.turnLimit, session.directory)
        if (staff) delegation.staffId = staff.id
        if (staff || delegation.reporting) {
          ;(board.groupStarts ??= []).push({kind: 'order', requestId: 'staff-' + assignmentId('staff', mutation.id), workspaceId: workspace.id, sessionId: session.id,
            orderId: delegation.id, generation: delegation.reporting ? delegation.generation : undefined, staffId: staff?.id, handoff: assignHandoff(delegation.title, delegation.promise).replace(/。主人原话如下。$/, '。')})
        }
        session.delegationIds.push(delegation.id)
        board.delegations.push(delegation)
        return { delegation }
      }
      if (requested !== undefined && session.kind !== 'coding') return workspaceError(400, CODING_ONLY)
      const delegation = makeDelegation(workspace, session.id, {...body, reporting: undefined, ...(staff && {owner:staff.name})}, this.turnLimit,
        requested === undefined ? undefined : this.checkDirectory(requested))
      if (staff) {
        if (session.executor !== 'dsh') return workspaceError(409,'具名幕僚使用本区的 DSH 会话')
        delegation.staffId = staff.id
        const starts = board.starts ??= []
        starts.push({workspaceId:workspace.id,sessionId:session.id,delegationId:delegation.id,
          staffToken:staff.token,requestId:'staff-'+assignmentId('staff',mutation.id),generation:delegation.generation,text:delegation.promise})
      }
      session.delegationIds.push(delegation.id)
      board.delegations.push(delegation)
      return { delegation }
    })
  }

  /** Bind the owner's original words to one work order and the selected native executor. */
  assign(sourceId: string, text: string, requested?: V2Executor, selected?: string, selectedSession?: string, briefInput?:Partial<OrderBrief>, staff?:{id:string;name:string;token:string}, permission?: V2CodingPermission, handoffInput?: string, directoryInputValue?: string, inputAttachments?: ChatInputAttachment[], reporting?: EngagementReporting) {
    this.current()
    permissionOf(permission)
    const handoff = handoffOf(handoffInput)
    const previousId = assignmentId('signup', sourceId)
    const previous = !!this.board.receipts['req-' + previousId]
    const requestId = previous ? previousId : assignmentId('assign', sourceId)
    const bound = selected && selectedSession ? this.session(selected, selectedSession) : undefined
    // A roster group has no executor to choose: the liaison picks people by @ in the group (the parameter is ignored).
    const roster = this.rosterGroups && !previous
    const executor = roster ? 'roster' : requested ?? bound?.executor ?? (previous ? 'codex' : 'dsh')
    // Tiers gate coding tools and every member of a roster group; an older workspace team order has no command hook.
    if (executor === 'dsh') permission = undefined
    const requestedDirectory = directoryInput(directoryInputValue)
    const mutation = mutationKey(['liaison',previous ? 'signup' : 'assign'], {requestId,text,executor,selected:selected ?? null,
      ...(staff && {staffId:staff.id}), ...(!previous && bound && {sessionId:bound.id}), ...(permission && {permission}),
      ...(requestedDirectory !== undefined && {directory:requestedDirectory}), ...inputAttachments?.length && {inputAttachments: inputAttachments.map(({id, name}) => [id, name])}})
    const result = this.write(mutation, board => {
      if (typeof text !== 'string' || !text.trim() || text.length > 64_000) return workspaceError(400, '请填写有效的交办原话，最多 64000 字')
      writable(board, selected ?? board.personalWorkspaceId)
      if (requestedDirectory !== undefined && executor === 'dsh') return workspaceError(400, CODING_ONLY + '，请选择 codex 或 claude-code')
      const directory = requestedDirectory === undefined ? undefined : this.checkDirectory(requestedDirectory)
      if (roster) return this.assignGroup(board, mutation, text, selected, bound, briefInput, staff, permission, handoff, directory, inputAttachments, reporting)
      if (inputAttachments?.length) return workspaceError(409, '请在工作区群聊交办这些材料')
      let workspace = board.workspaces.find(w => w.id === (selected ?? board.personalWorkspaceId))
      if (!workspace) {
        if (selected || board.personalWorkspaceId) return workspaceError(404, '找不到这项交办所在的工作区')
        workspace = newWorkspace('我的交办', '', '我')
        board.workspaces.push(workspace)
        board.personalWorkspaceId = workspace.id
      }
      const brief = briefInput ? checkedOrderBrief(text,briefInput) : interimOrderBrief(text)
      let session: V2Session
      if (bound && bound.executor === executor) {
        session = findSession(board,workspace.id,bound.id)
        if (session.closed) return workspaceError(409, '这场会话已关闭，请从工作区另开会话')
      } else {
        session = newSession(workspace.id,brief.sessionTitle ?? brief.title,executor as V2Executor)
        board.sessions.push(session)
      }
      const delegation = makeDelegation(workspace, session.id, { title:brief.title, owner:staff?.name ?? '接口人', promise:brief.promise, ...(permission && {permission}) }, this.turnLimit, directory)
      if (staff) delegation.staffId = staff.id
      delegation.hasOriginal = true
      const originals = board.originals ??= {}
      originals[delegation.id] = {text,complete:true}
      session.delegationIds.push(delegation.id)
      board.delegations.push(delegation)
      const starts = board.starts ??= []
      starts.push({workspaceId: workspace.id, sessionId: session.id, delegationId: delegation.id,
        generation: delegation.generation, ...(staff && {staffToken:staff.token}), requestId: 'start-' + mutation.id, text})
      // The liaison speaks the first turn in its own words; the first hand-over of this owner turn is kept on a retry.
      const liaisonTurns = board.liaisonTurns ??= {}
      liaisonTurns['start-' + mutation.id] = {handoff: handoff ?? assignHandoff(delegation.title, delegation.promise)}
      return { workspace, delegation, session }
    })
    const current = this.delegation(result.workspace.id,result.delegation.id)
    return { ...result, delegation:{...result.delegation,title:current.title,promise:current.promise,hasOriginal:current.hasOriginal},
      session:{...result.session,title:this.session(result.workspace.id,result.session.id).title},firstRequestId:'start-' + requestId }
  }

  /**
   * An assignment on a roster group: the focused group when it can take it (same workspace, open, a roster group, the
   * same directory), otherwise a new group. No executor, no start row: the liaison's hand-over (with the owner's wording
   * quoted) is posted to the group once (`groupStarts`), @-mentioning the staff member the owner named.
   */
  private assignGroup(board: Board, mutation: Mutation, text: string, selected: string | undefined, bound: V2Session | undefined, briefInput: Partial<OrderBrief> | undefined,
    staff: {id:string;name:string;token:string} | undefined, permission: V2CodingPermission | undefined, handoff: string | undefined, directory: string | undefined, inputAttachments?: ChatInputAttachment[], reporting?: EngagementReporting) {
    let workspace = board.workspaces.find(w => w.id === (selected ?? board.personalWorkspaceId))
    if (!workspace) {
      if (selected || board.personalWorkspaceId) return workspaceError(404, '找不到这项交办所在的工作区')
      workspace = newWorkspace('我的交办', '', '我')
      board.workspaces.push(workspace)
      board.personalWorkspaceId = workspace.id
    }
    const brief = briefInput ? checkedOrderBrief(text,briefInput) : interimOrderBrief(text)
    const focused = bound && findSession(board, workspace.id, bound.id)
    let session: V2Session
    if (focused && isRosterGroup(focused) && !focused.closed && (directory === undefined || focused.directory === directory)) session = focused
    else {
      session = rosterSession(workspace.id, brief.sessionTitle ?? brief.title, directory)
      board.sessions.push(session)
    }
    const delegation = makeDelegation(workspace, session.id, { title:brief.title, owner:staff?.name ?? '接口人', promise:brief.promise, reporting, ...(permission && {permission}) }, this.turnLimit, directory)
    if (staff) delegation.staffId = staff.id
    delegation.hasOriginal = true
    const originals = board.originals ??= {}
    originals[delegation.id] = {text,complete:true}
    session.delegationIds.push(delegation.id)
    board.delegations.push(delegation)
    const said = handoff ?? assignHandoff(delegation.title, delegation.promise)
    ;(board.liaisonTurns ??= {})['start-' + mutation.id] = {handoff: said}
    ;(board.groupStarts ??= []).push({kind: 'assign', requestId: 'start-' + mutation.id, workspaceId: workspace.id, sessionId: session.id, orderId: delegation.id, generation: delegation.reporting ? delegation.generation : undefined,
      handoff: said, original: text, ...(staff && {staffId: staff.id}), ...inputAttachments?.length && {inputAttachments: structuredClone(inputAttachments)}})
    return { workspace, delegation, session }
  }

  /** Roster groups' liaison work whose line is not in the group yet. */
  pendingGroupStarts(sessionId?: string): GroupStart[] {
    this.current()
    return structuredClone((this.board.groupStarts ?? []).filter(row => !sessionId || row.sessionId === sessionId))
  }
  /** The group line of this liaison work is posted. */
  groupStartPosted(requestId: string) {
    if (!(this.board.groupStarts ?? []).some(row => row.requestId === requestId)) return
    this.commit(board => { board.groupStarts = (board.groupStarts ?? []).filter(row => row.requestId !== requestId) })
  }

  /**
   * The owner's supplement on an order of a roster group, relayed by the liaison into the group (no start row: the
   * group line is the delivery). The owner's words come first: a review in flight will not follow up; new terms allow a
   * new follow-up. Replays return the saved state.
   */
  groupFollow(sourceId: string, text: string, workspaceId: string, workOrderId: string, handoffInput?: string, inputAttachments?: ChatInputAttachment[], reporting?: EngagementReporting): 'queued' | 'sent' {
    this.current()
    const handoff = handoffOf(handoffInput)
    const job = this.delegation(workspaceId, workOrderId)
    const session = this.session(workspaceId, job.sessionId)
    const requestId = 'follow-' + workspaceFingerprint(sourceId)
    const mutation = assignmentTurn(workspaceId, session.id, requestId, text, workOrderId, inputAttachments)
    const saved = this.receipt(mutation)
    if (saved?.kind === 'follow') return (this.board.groupStarts ?? []).some(row => row.requestId === requestId) ? 'queued' : 'sent'
    writable(this.board, workspaceId)
    if (typeof text !== 'string' || !text.trim() || text.length > 64_000) return workspaceError(400,'请填写有效的发言，最多 64000 字')
    if (session.closed) return workspaceError(409,'这场会话已关闭，重新打开原会话即可继续补充')
    if (job.paused || orderEnded(job)) return workspaceError(409, job.status === 'done' ? '这张工单已完成，重新打开后才能补充' : '这张工单已暂停或关闭，请查看工单')
    if (!job.remainingTurns) return workspaceError(409, BUDGET_USED)
    return this.commit(board => {
      ownerFirst(board, session.id, job.id, true)
      board.receipts[mutation.key] = {kind: 'follow', hash: mutation.hash, state: 'queued'}
      const said = handoff ?? followHandoff(job.title)
      ;(board.liaisonTurns ??= {})[requestId] = {handoff: said}
      const order = findDelegation(board, workspaceId, job.id)
      delete order.autoFollowUps
      if (reporting) order.reporting = reporting
      if (order.reporting) advance(board, order)
      ;(board.groupStarts ??= []).push({kind: 'follow', requestId, workspaceId, sessionId: session.id, orderId: job.id, generation: order.reporting ? order.generation : undefined, handoff: said, original: text,
        ...(job.staffId && {staffId: job.staffId}), ...inputAttachments?.length && {inputAttachments: structuredClone(inputAttachments)}})

      return 'queued' as const
    })
  }

  /**
   * Owner words in a roster group (`mutation` is the owner's request): recorded before the line is written, so a retry
   * finds the same line instead of saying it twice. Checked like a turn: the session is open, the order can take words.
   */
  recordGroupSay(mutation: Mutation, session: V2Session, workOrderId?: string) {
    const saved = this.receipt(mutation)
    if (saved) {
      if (saved.kind !== 'group-say' || saved.sessionId !== session.id) return workspaceError(409, '这条请求已用于另一项操作，请重新确认')
      return
    }
    this.commit(board => {
      writable(board, session.workspaceId)
      if (findSession(board, session.workspaceId, session.id).closed) return workspaceError(409, '这场会话已关闭，重新打开原会话即可继续')
      if (workOrderId) {
        const order = findDelegation(board, session.workspaceId, workOrderId)
        if (order.sessionId !== session.id) return workspaceError(409, '这张工单属于另一场会话')
        if (orderEnded(order) || order.paused) return workspaceError(409, stoppedReason(order))
      }
      board.receipts[mutation.key] = {kind: 'group-say', hash: mutation.hash, sessionId: session.id, at: now()}
    })
  }

  /**
   * One member call of a roster group on an order uses one turn of its budget. The refusal reason when the order cannot
   * take a call (finished, cancelled, paused, out of budget, or not this group's).
   */
  chargeGroupCall(workspaceId: string, sessionId: string, orderId: string): string | undefined {
    this.current()
    const order = this.board.delegations.find(row => row.id === orderId && row.workspaceId === workspaceId)
    if (!order || order.sessionId !== sessionId) return '这张工单不属于本群'
    if (this.board.workspaces.some(row => row.id === workspaceId && workspaceArchived(row))) return WORKSPACE_ARCHIVED
    if (orderEnded(order) || order.paused) return stoppedReason(order)
    if (!order.remainingTurns) return BUDGET_USED
    this.commit(board => {
      const job = findDelegation(board, workspaceId, orderId)
      job.remainingTurns--
      job.status = 'active'
      delete job.reason
    })
  }
  /** Orders of a roster group that were working and now have no member call: waiting for the next follow-up. */
  settleGroupOrders(workspaceId: string, sessionId: string, busy: ReadonlySet<string>) {
    this.current()
    const idle = this.board.delegations.filter(row => row.workspaceId === workspaceId && row.sessionId === sessionId && row.status === 'active' && !busy.has(row.id))
    if (!idle.length) return
    this.commit(board => {
      for (const row of idle) {
        const job = findDelegation(board, workspaceId, row.id)
        job.status = 'waiting'
        job.reason = job.remainingTurns ? job.reporting && job.reason || '群里这一轮已交回，等待下一次跟进' : BUDGET_USED
      }
    })
  }
  /** Roster groups (to start their engines). */
  rosterSessions() {
    this.current()
    return this.board.sessions.filter(isRosterGroup)
  }

  /** The last line of a roster group whose results were published (undefined: never). */
  groupResultsChecked(sessionId: string): number | undefined {
    this.current()
    return this.board.groupResultsChecked?.[sessionId]
  }

  /**
   * Results of a roster group's lines up to `checkedTo` (the result notices, deduplicated by id), and, when one of its
   * order batches landed (`acceptance`), that batch's acceptance review: all in one write, so a batch under review always
   * has its notices. The review is skipped when the order cannot be reviewed now (finished, paused, another group's) or
   * was already registered; the registered record is returned.
   */
  publishGroupResults(workspaceId: string, sessionId: string, checkedTo: number, notices: StoredResult[],
    acceptance?: {turnId: string; orderId: string; batchId: string; done: string[]; results: number[]}): AcceptanceRecord | undefined {
    this.current()
    const order = acceptance && this.board.delegations.find(item => item.id === acceptance.orderId && item.workspaceId === workspaceId)
    const review = !!acceptance && !this.board.acceptances?.[acceptance.turnId] && !!order && order.sessionId === sessionId && !orderEnded(order) && !order.paused
    const fresh = notices.filter(notice => !this.board.resultNotices?.[notice.id] && !this.board.groupEvidence?.[notice.id])
    if (!review && !fresh.length && (this.board.groupResultsChecked?.[sessionId] ?? 0) >= checkedTo) return
    return this.commit(board => {
      const session = findSession(board, workspaceId, sessionId)
      for (const notice of fresh) {
        const job = findDelegation(board, notice.workspaceId, notice.orderId)
        if (job.sessionId !== session.id || notice.sessionId !== session.id) return workspaceError(409, '这份报告的负责工单已经变更')
        if (job.reporting) (board.groupEvidence ??= {})[notice.id] ??= notice
        else (board.resultNotices ??= {})[notice.id] ??= notice
      }
      const checked = board.groupResultsChecked ??= {}
      checked[sessionId] = Math.max(checked[sessionId] ?? 0, checkedTo)
      if (!review) return undefined
      const record: AcceptanceRecord = {workspaceId, sessionId, orderId: order.id, generation: order.generation, at: now(), state: 'pending',
        group: {batchId: acceptance.batchId, done: [...acceptance.done], results: [...acceptance.results]}}
      ;(board.acceptances ??= {})[acceptance.turnId] = record
      return structuredClone(record)
    })
  }

  act(mutation: Mutation, workspaceId: string, id: string, body: Body, at = new Date()) {
    return this.write(mutation, board => {
      writable(board, workspaceId)
      const delegation = findDelegation(board, workspaceId, id)
      if (body.expectedGeneration !== undefined && body.expectedGeneration !== delegation.generation) {
        return workspaceError(409, '工单已变更，请重新打开后确认')
      }
      const action = body.action
      if (delegation.status === 'closed') {
        if (action === 'cancel') return { delegation }
        return workspaceError(409, '这张工单已经关闭')
      }
      if (body.stopSchedule !== undefined && (action !== 'complete' || body.stopSchedule !== true)) return workspaceError(400, '只有收单可以同时停止周期安排')
      // A choice taken on a liaison message of this order (`from`: that message).
      const origin = body.from === undefined ? undefined : messageOrigin(board, delegation, body.from, action)
      if (delegation.status === 'done') {
        if (action === 'complete') return { delegation }
        if (action !== 'reopen') return workspaceError(409, '这张工单已经完成，重新打开后才能继续')
      } else if (action === 'reopen') return { delegation }
      switch (action) {
        case 'pause':
          if (delegation.paused) return { delegation }
          delegation.paused = true
          delegation.status = 'waiting'
          delegation.reason = '你已暂停，等待恢复'
          break
        case 'resume':
          if (!delegation.remainingTurns) return workspaceError(409, BUDGET_USED)
          if (!delegation.paused && delegation.status !== 'waiting') return { delegation }
          if (delegation.paused) {
            const schedule = board.followups?.[id]?.schedule
            if (schedule?.enabled) {
              schedule.enabledAt = at.toISOString()
              schedule.revision = randomUUID()
            }
          }
          delete delegation.paused
          delegation.status = 'accepted'
          delete delegation.reason
          break
        case 'cancel':
          delegation.status = 'closed'
          delegation.reason = field(body.reason, '取消理由', 2000, '你已取消这张工单')
          delete delegation.paused
          break
        case 'complete': {
          finishOrder(board, delegation, at, 'owner', origin?.kind === 'command' ? origin.requestId : undefined)
          const schedule = board.followups?.[id]?.schedule
          if (body.stopSchedule === true && schedule?.enabled) {
            schedule.enabled = false
            schedule.revision = randomUUID()
          }
          if (origin?.kind === 'command') origin.row.resolved = {kind: 'complete', at: at.toISOString()}
          if (origin?.kind === 'acceptance') origin.row.completedAt = at.toISOString()
          break
        }
        case 'reopen': {
          delegation.status = 'waiting'
          delegation.reason = '你已重新打开这张工单，可以在对话里继续'
          delete delegation.completedAt
          delete delegation.completedBy
          delete delegation.completedFrom
          // A schedule kept while the order was finished starts again from now; missed weeks are not made up.
          const schedule = board.followups?.[id]?.schedule
          if (schedule?.enabled) {
            schedule.enabledAt = at.toISOString()
            schedule.revision = randomUUID()
          }
          if (origin?.kind === 'command') origin.row.resolved = {kind: 'reopen', at: at.toISOString()}
          break
        }
        case 'narrow': {
          const boundary = field(body.boundary, '新的操作范围', 4000)
          if (boundary === delegation.boundary) return { delegation }
          const prior = board.decisions.findLast(d => d.delegationId === id)
          board.decisions.push({ id: prior?.id ?? randomUUID(), workspaceId, delegationId: id, text: boundary, version: (prior?.version ?? 0) + 1, at: now() })
          delegation.boundary = boundary
          if (delegation.status === 'active') {
            delegation.status = 'waiting'
            delegation.reason = '操作范围已变更，等待按新范围继续'
          }
          break
        }
        default: return workspaceError(400, '未知工单操作')
      }
      // The owner acted on the order: a pending acceptance decision is settled, and new terms allow a new follow-up.
      if (delegation.acceptance?.awaitingOwner) delete delegation.acceptance.awaitingOwner
      if (action === 'narrow') delete delegation.autoFollowUps
      advance(board, delegation)
      return { delegation }
    })
  }

  /**
   * The owner's command tier for a coding work order. It takes effect from the next command, so it neither bumps
   * the generation nor stops the running turn. `change` is absent when nothing changed (or on a replay).
   */
  setPermission(mutation: Mutation, workspaceId: string, id: string, body: Body, at = new Date()): {delegation: V2Delegation; change?: V2PermissionChange} {
    const replay = this.receipt(mutation)?.kind === 'mutation'
    const result = this.write(mutation, board => {
      writable(board, workspaceId)
      const delegation = findDelegation(board, workspaceId, id)
      if (orderEnded(delegation)) return workspaceError(409, delegation.status === 'done' ? '这张工单已经完成' : '这张工单已经关闭')
      const to = permissionOf(body.permission) ?? workspaceError(400, '请选择请求批准、代为批准或完全访问')
      const from = codingPermission(delegation)
      if (from === to) return { delegation }
      delegation.permission = to
      delegation.permissionChangedAt = at.toISOString()
      return { delegation, change: {at: delegation.permissionChangedAt, from, to} }
    })
    return replay ? {delegation: result.delegation} : result
  }

  createSession(mutation: Mutation, workspaceId: string, body: Body) {
    return this.write(mutation, board => {
      writable(board, workspaceId)
      if (this.rosterGroups) {
        // Every new conversation is a group: the kind and executor an older client sends are accepted and ignored.
        const ids: unknown = body.delegationIds ?? []
        if (!Array.isArray(ids) || ids.length) return workspaceError(409, '每张工单已有负责会话，请从工单打开原会话')
        this.workspace(workspaceId)
        const session = rosterSession(workspaceId, field(body.title, '会话名称', 300))
        board.sessions.push(session)
        return { session }
      }
      const kind = body.kind
      if (kind !== 'coding' && kind !== 'group') return workspaceError(400, '请选择编程会话或群聊')
      const executor = body.executor ?? (kind === 'group' ? 'dsh' : undefined)
      if (executor !== 'codex' && executor !== 'claude-code' && executor !== 'dsh'
        || (kind === 'group') !== (executor === 'dsh')) return workspaceError(400, '会话类型与执行者不匹配')
      const ids: unknown = body.delegationIds ?? []
      if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id): id is string => typeof id === 'string')) return workspaceError(400, '关联工单列表无效')
      const delegationIds: string[] = [...new Set(ids)]
      for (const id of delegationIds) findDelegation(board, workspaceId, id)
      if (delegationIds.length) return workspaceError(409, '每张工单已有负责会话，请从工单打开原会话')
      const session: V2Session = { id: randomUUID(), workspaceId, title: field(body.title, '会话名称', 300), kind,
        executor, delegationIds, closed: false, createdAt: now() }
      board.sessions.push(session)
      return { session }
    })
  }

  setSessionClosed(mutation: Mutation, workspaceId: string, id: string, closed: boolean) {
    return this.write(mutation, board => {
      writable(board, workspaceId)
      const session = findSession(board, workspaceId, id)
      session.closed = closed
      return { session }
    })
  }

  target(session: V2Session, requested: unknown): string | undefined {
    const id = requested === undefined && session.delegationIds.length === 1 ? session.delegationIds[0] : requested
    if (id === undefined) return
    if (typeof id !== 'string' || !id) return workspaceError(400, '请选择有效的工单')
    if (this.delegation(session.workspaceId, id).sessionId !== session.id) return workspaceError(409, '这张工单属于另一场会话，请打开它的负责会话')
    return id
  }

  context(session: V2Session, workOrderId?: string) {
    const workspace = this.workspace(session.workspaceId)
    const delegations = workOrderId ? [this.delegation(workspace.id,workOrderId)] : []
    const decisions = this.board.decisions.filter(d => d.workspaceId === workspace.id && d.delegationId === workOrderId)
    const current = new Map(decisions.map(decision => [decision.id, decision]))
    return { workspace, delegations, decisions: [...current.values()] }
  }

  pendingStarts(sessionId?: string) {
    this.current()
    return structuredClone((this.board.starts ?? []).filter(row => !sessionId || row.sessionId === sessionId))
  }

  /** Accept the owner's supplement before the native conversation is free. Reservation consumes the row. */
  queueFollow(sourceId: string, text: string, workspaceId: string, workOrderId: string, staffToken?:string, handoffInput?: string) {
    this.current()
    const handoff = handoffOf(handoffInput)
    const job = this.delegation(workspaceId,workOrderId)
    const session = this.session(workspaceId,job.sessionId)
    const requestId = 'follow-' + workspaceFingerprint(sourceId)
    const mutation = assignmentTurn(workspaceId,session.id,requestId,text,workOrderId)
    const saved = this.receipt(mutation)
    if (saved?.kind === 'follow' || saved?.kind === 'turn') return saved.state
    writable(this.board, workspaceId)
    if (typeof text !== 'string' || !text.trim() || text.length > 64_000) return workspaceError(400,'请填写有效的发言，最多 64000 字')
    if (session.closed) return workspaceError(409,'这场会话已关闭，重新打开原会话即可继续补充')
    if (job.paused || orderEnded(job)) return workspaceError(409, job.status === 'done' ? '这张工单已完成，重新打开后才能补充' : '这张工单已暂停或关闭，请查看工单')
    return this.commit(board => {
      // The owner's supplement comes before the liaison's own: a review in flight will not follow up on the old result.
      ownerFirst(board, session.id, job.id, true)
      const starts = board.starts ??= []
      const waiting = starts.filter(row => row.delegationId === job.id && row.generation === job.generation)
      if (job.remainingTurns <= waiting.length) return workspaceError(409,'可用对话额度已全部使用或留给先前接收的要求')
      starts.push({kind:'follow',...(staffToken && {staffToken}),workspaceId,sessionId:session.id,delegationId:job.id,generation:job.generation,requestId,text})
      board.receipts[mutation.key] = {kind:'follow',hash:mutation.hash,state:'queued'}
      const liaisonTurns = board.liaisonTurns ??= {}
      liaisonTurns[requestId] = {handoff: handoff ?? followHandoff(job.title)}
      // A supplement changes the terms: the liaison may follow up once more.
      delete findDelegation(board, workspaceId, job.id).autoFollowUps
      return 'queued' as const
    })
  }

  /**
   * Record owner words for the running turn `parent` (absent: no turn can take them, they go to the next one). Checked
   * like a turn of the order, but no budget is used unless they are queued.
   */
  interject(mutation: Mutation, session: V2Session, workOrderId: string | undefined, parent: string | undefined, text: string, staffToken?: string) {
    this.commit(board => { recordInterjection(board, mutation, session, workOrderId, parent, text, staffToken) })
  }

  /** Words still waiting for the outcome of the turn they were sent into. */
  steering(sessionId: string, parent: string) {
    this.current()
    return Object.entries(this.board.receipts).flatMap(([key, r]) => r.kind === 'interject' && r.sessionId === sessionId && r.parent === parent && r.state === 'steering'
      ? [{id: key.slice('req-'.length), text: r.text, workOrderId: r.workOrderId ?? undefined}] : [])
  }

  interjection(id: string): Interjected | undefined {
    this.current()
    const receipt = this.board.receipts['req-' + id]
    return receipt?.kind === 'interject' ? structuredClone(receipt) : undefined
  }

  /** The running turn took the words. */
  steered(id: string) {
    this.commit(board => {
      const receipt = board.receipts['req-' + id]
      if (receipt?.kind === 'interject' && receipt.state === 'steering') receipt.state = 'steered'
    })
  }

  /**
   * Move words the running turn did not take to the next turn of the same order, which uses one turn of its budget
   * when it is reserved. The order must still be the one they were said to, with budget left for everything queued.
   */
  queueInterjection(id: string): {state: 'queued'} | {state: 'unsent' | 'stopped'; reason: string} {
    return this.commit(board => queueRow(board, id))
  }

  /**
   * Owner words for an idle session whose project directory another turn uses: they become the next turn of the order
   * (a start row, no budget until it is reserved) and wait for the directory. Nothing is saved when they cannot queue.
   */
  queueWaiting(mutation: Mutation, session: V2Session, workOrderId: string | undefined, text: string, staffToken: string | undefined, waitingFor: V2DirectoryWait) {
    this.commit(board => {
      recordInterjection(board, mutation, session, workOrderId, undefined, text, staffToken)
      const queued = queueRow(board, mutation.id)
      if (queued.state !== 'queued') return workspaceError(409, queued.reason)
      const start = board.starts!.find(row => row.sessionId === session.id && row.requestId === mutation.id)!
      start.waitingFor = waitingFor
      start.waitingSince = now()
    })
  }

  /** The start row `requestId` waits for its project directory behind `waitingFor`. False when no such row is queued. */
  markWaiting(sessionId: string, requestId: string, waitingFor: V2DirectoryWait): boolean {
    this.current()
    const start = this.board.starts?.find(row => row.sessionId === sessionId && row.requestId === requestId)
    if (!start) return false
    if (start.waitingSince && JSON.stringify(start.waitingFor) === JSON.stringify(waitingFor)) return true
    this.commit(board => {
      const row = board.starts!.find(item => item.sessionId === sessionId && item.requestId === requestId)!
      row.waitingFor = waitingFor
      row.waitingSince ??= now()
    })
    return true
  }

  /**
   * Owner words for the same order (or discussion) as the turn `into` that waits for its directory: they join that turn's
   * input instead of becoming a turn of their own. False when that turn is not a queued start row of the same target.
   */
  mergeWaiting(mutation: Mutation, session: V2Session, workOrderId: string | undefined, text: string, into: string, staffToken?: string): boolean {
    this.current()
    const start = this.board.starts?.find(row => row.sessionId === session.id && row.requestId === into)
    if (!start || start.delegationId !== workOrderId) return false
    this.commit(board => {
      const receipt = recordInterjection(board, mutation, session, workOrderId, into, text, staffToken)
      receipt.state = 'queued'
      receipt.mergedInto = into
      const row = board.starts!.find(item => item.sessionId === session.id && item.requestId === into)!
      row.merged = [...row.merged ?? [], {id: mutation.id, text}]
      ownerFirst(board, session.id, workOrderId, true)
    })
    return true
  }

  /** The owner stops the turn `requestId` that waits for its directory: it never starts, and words merged into it stop too. */
  stopWaiting(mutation: Mutation, workspaceId: string, sessionId: string, requestId?: string) {
    return this.write(mutation, board => {
      writable(board, workspaceId)
      const session = findSession(board, workspaceId, sessionId)
      const start = requestId ? board.starts?.find(row => row.sessionId === sessionId && row.requestId === requestId) : undefined
      if (!start) return {session}
      board.starts = board.starts!.filter(row => row !== start)
      dropStart(board, start)
      const order = start.delegationId ? board.delegations.find(row => row.id === start.delegationId && row.sessionId === sessionId) : undefined
      if (order && !orderEnded(order) && order.status !== 'active') {
        order.status = 'waiting'
        order.reason = '你已叫停等待项目目录的这一轮，可以在对话里重新发起'
      }
      return {session, stopped: start.requestId}
    })
  }

  reserve(mutation: Mutation, session: V2Session, workOrderId?: string, startGeneration?: number, staffToken?:string, review = false) {
    this.commit(board => {
      writable(board, session.workspaceId)
      const priorTurn = board.receipts[mutation.key]
      if (priorTurn?.kind === 'turn' && priorTurn.staffToken && priorTurn.staffToken !== staffToken) {
        return workspaceError(409,'原发言所用的幕僚资料已变更，请提出新的要求')
      }
      const start = board.starts?.find(row => row.sessionId === session.id)
      if (start && startGeneration === undefined) return workspaceError(409, '这场会话还有已接收的要求正在排队，请稍后继续')
      if (startGeneration !== undefined) {
        const prior = board.receipts[mutation.key]
        const startHash = start && (start.hash ?? assignmentTurn(start.workspaceId, start.sessionId, start.requestId, start.text, start.kind === 'follow' ? start.delegationId : undefined).hash)
        const initial = start && start.delegationId === workOrderId && start.generation === startGeneration && startHash === mutation.hash
        const retry = prior?.kind === 'turn' && prior.state === 'unsent' && prior.hash === mutation.hash
          && !start && !!workOrderId
          && Object.values(board.receipts).findLast(r => r.kind === 'turn' && r.sessionId === session.id && r.reserved.some(h => h.id === workOrderId)) === prior
        const job = workOrderId ? findDelegation(board, session.workspaceId, workOrderId) : undefined
        if ((!initial && !retry) || job && job.generation !== startGeneration) return workspaceError(409, '这项交办已有新的指示，请按当前工单继续')
      }
      if (session.closed && startGeneration === undefined) return workspaceError(409, '这场会话已关闭，重新打开原会话即可继续补充')
      const reserved: Turn['reserved'] = []
      if (workOrderId) {
        const d = findDelegation(board, session.workspaceId, workOrderId)
        if (d.sessionId !== session.id) return workspaceError(409, '这张工单属于另一场会话')
        if (orderEnded(d) || d.paused) return workspaceError(409, stoppedReason(d))
        if (!d.remainingTurns) return workspaceError(409, BUDGET_USED)
        d.remainingTurns--
        d.status = 'active'
        delete d.reason
        reserved.push({id:d.id, generation:d.generation})
      }
      board.receipts[mutation.key] = { kind: 'turn', state: 'pending', hash: mutation.hash, sessionId: session.id, reserved, at: now(), ...(staffToken && {staffToken}),
        ...(review && reserved.length === 1 && {review: true as const}) }
      if (start) board.starts = board.starts!.filter(row => row !== start)
    })
  }

  private settle(board: Board, receipt: Turn, state: 'sent' | 'unknown' | 'unsent', detail?: string) {
    receipt.state = state
    if ((state === 'sent' || state === 'unknown') && receipt.reserved.length === 1) receipt.resultCheck = 'pending'
    const pending = Object.values(board.receipts).filter(r => r.kind === 'turn' && r.state === 'pending')
    for (const hold of receipt.reserved) {
      const delegation = board.delegations.find(d => d.id === hold.id)!
      if (state === 'unsent') delegation.remainingTurns++
      if (delegation.sessionId !== receipt.sessionId || delegation.generation !== hold.generation ||
        pending.some(r => r.kind === 'turn' && r.reserved.some(p => p.id === hold.id && p.generation === hold.generation))) continue
      delegation.status = 'waiting'
      delegation.reason = state === 'unknown' ? UNKNOWN_TURN
        : !delegation.remainingTurns ? BUDGET_USED : state === 'unsent' ? (detail || '消息尚未派发，等待继续') : '本轮对话已返回，等待下一次跟进'
    }
  }

  finishTurn(mutation: Mutation, state: 'sent' | 'unknown' | 'unsent', detail?: string) {
    this.commit(board => {
      const receipt = board.receipts[mutation.key]
      if (receipt?.kind !== 'turn' || receipt.state !== 'pending') return workspaceError(409, '这次发言已结束')
      this.settle(board, receipt, state, detail)
    })
  }

  /** Turns a restart cut off whose owner has not been reminded yet, with the orders they held. */
  interruptedTurns() {
    this.current()
    return Object.entries(this.board.receipts).flatMap(([key, r]) => {
      if (r.kind !== 'turn' || !r.interrupted) return []
      const orders = r.reserved.flatMap(hold => this.board.delegations.filter(d => d.id === hold.id && d.generation === hold.generation && d.sessionId === r.sessionId))
      const session = this.board.sessions.find(row => row.id === r.sessionId)
      // A session no longer on the board has nobody to remind; the mark is still returned so it gets cleared.
      return [{turnId: key.slice('req-'.length), sessionId: r.sessionId, workspaceId: session?.workspaceId ?? '', at: r.interrupted,
        orderIds: session ? orders.map(order => order.id) : []}]
    })
  }
  clearInterrupted(turnIds: readonly string[]) {
    const keys = turnIds.map(id => 'req-' + id).filter(key => { const r = this.board.receipts[key]; return r?.kind === 'turn' && !!r.interrupted })
    if (!keys.length) return
    this.commit(board => { for (const key of keys) delete (board.receipts[key] as Turn).interrupted })
  }

  unknownTurns(sessionId: string) {
    return Object.entries(this.board.receipts)
      .filter(([, r]) => r.kind === 'turn' && r.sessionId === sessionId && r.state === 'unknown')
      .map(([key]) => key.slice('req-'.length))
  }

  confirmTurn(session: V2Session, id: string) {
    const key = 'req-' + id
    const receipt = this.board.receipts[key]
    if (receipt?.kind !== 'turn' || receipt.sessionId !== session.id || receipt.state !== 'unknown') return
    this.commit(board => {
      const turn = board.receipts[key] as Turn
      turn.state = 'sent'
      if (turn.reserved.length === 1) turn.resultCheck = 'pending'
      for (const hold of turn.reserved) {
        const job = findDelegation(board, session.workspaceId, hold.id)
        if (job.sessionId !== session.id || job.generation !== hold.generation || job.reason !== UNKNOWN_TURN || job.status !== 'waiting') continue
        const unresolved = Object.values(board.receipts).some(r => r.kind === 'turn' && r.state === 'unknown'
          && r.reserved.some(h => h.id === job.id && h.generation === job.generation))
        if (!unresolved) job.reason = job.remainingTurns ? '本轮对话已返回，等待下一次跟进' : BUDGET_USED
      }
    })
  }
}
