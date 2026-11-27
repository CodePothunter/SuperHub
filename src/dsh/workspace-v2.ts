import type { EngagementCoordinator, EngagementDecision, EngagementMessage, EngagementReporting } from '../core/workspace-engagement.ts'
import type { SavedOrderResults } from '../core/workspace-notices.ts'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import type { ChatAttachments } from './chat-attachments.ts'
import type { V2Attachment } from '../core/workspace-v2.ts'
import { LIAISON_AUTHOR, WORKSPACE_ARCHIVED, awaitingChoice, messageWorkOrder, pinnedOutside, orderEnded, workspaceArchived, type V2CodingPermission, type V2Delegation, type V2Delivery, type V2DialogueSource, type V2DirectoryWait, type V2Executor, type V2Interjection, type V2Message, type V2PendingApproval, type V2PermissionChange, type V2Session, type V2SteerOutcome, type V2Transcript, type V2WorkDirectory, type V2Workspace } from '../core/workspace-v2.ts'
import { json, type Route } from './http.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import { INTERJECTION_UNKNOWN, UNKNOWN_TURN, WorkspaceV2Store, commandText, mutationKey, assignmentTurn, isRosterGroup, type AcceptanceOutcome, type AssignmentStart, type EngagementJob, type GroupStart, type LiaisonDialogueCancellation, type LiaisonDialogueRecord, type LiaisonDialogueRequest, type LiaisonOrderContext, type Mutation, type OwnerCommand, type WorkspaceTarget } from './workspace-v2-store.ts'
import { mentionSegments, type MentionSegment } from '../core/mentions.ts'
import { LIAISON_MEMBER_ID } from './workspace-group-members.ts'
import { GROUP_COMMANDS_FILE, liaisonGapReason, type GroupEngine, type GroupDeliveryOutcome } from './workspace-group-engine.ts'
import type { WorkspaceGroupHost } from './workspace-group-host.ts'
import { memberCompletionEvidenceId, type GroupAttachment, type GroupLine } from './workspace-group-ledger.ts'
import { GROUP_RESULTS_DIR, keepGroupFile, readGroupFile, readKeptGroupFile } from './workspace-group-files.ts'
import { INITIAL_WORKSPACE_TRACE, type WorkspaceDialogueEdit } from './workspace-dialogue-trace.ts'
import { HOST_ID, OWNER_ID, type GroupEffect } from './workspace-group-scheduler.ts'
import { dialogueKey, groupLeadId, liaisonSpeakerId, workspaceSpeakerId } from './workspace-speaker-id.ts'
import { appendCommandLog, readCommandLog } from './workspace-command-log.ts'
import { ORIGINAL_LABEL } from './workspace-v2-dialogue.ts'
import { existsSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { slotKey, zonedInstant } from '../core/clock.ts'
import { completionCandidate, judgeCommand, type CommandJudge } from './workspace-order-command.ts'
import { ACCEPTANCE_TIMEOUT_MS, ORIGINAL_LIMIT, RESULTS_LIMIT, type AcceptanceReviewer } from './workspace-acceptance.ts'
import { publishedOutputs, workspaceOutputs, type OutputSource } from './workspace-outputs.ts'
import type { OrderBrief } from './workspace-order-brief.ts'
import type { WorkspaceStaffStore } from './workspace-staff-store.ts'
import type { ExperienceEvidence, ExperienceMemory } from '../core/workspace-experience.ts'
import type { ExperienceLearning, VerifiedExperienceOriginal } from './workspace-experience-learning.ts'
import { WorkspaceFollowup } from './workspace-followup.ts'
import { fileVersion, groupResults, WorkspaceResultNotices, type GroupResultLine, type StoredResult } from './workspace-notices.ts'
import { directoryLocks, type DirectoryHolder, type DirectoryLocks } from './directory-locks.ts'
import { directoryKey } from './project-directory.ts'
import { commandExperienceEvidence, verifyCommandExperience } from './workspace-experience-evidence.ts'
import { pageQuery, pageWindow, type PageQuery } from '../core/paging.ts'

/** Owner approvals of the command gate (pending cards and decisions). */
export interface WorkspaceApprovals {
  pending(filter?: {workspaceId?: string; sessionId?: string; orderId?: string | null}): V2PendingApproval[]
  answer(id: string, allow: boolean, where: {workspaceId: string; sessionId?: string; orderId?: string | null}): boolean
}

interface LiaisonDialogueResult {
  workspace: V2Workspace
  session: V2Session
  requestId: string
  traceId: string
  sourceMessageId?: string
  state: 'created' | 'pending' | 'sent' | 'replied' | 'failed' | 'cancelled'
  reason?: string
}

interface Options {
  inputAttachments?: Pick<ChatAttachments, 'resolve' | 'grant'>
  learning?: ExperienceLearning
  learningProblem?: (error: unknown) => void
  liaisonTrace?: () => string
  staff?:WorkspaceStaffStore; store: WorkspaceV2Store; source: V2DialogueSource; timeZone?: string; now?: () => Date; approvals?: WorkspaceApprovals
  /** The liaison's acceptance review of new results. Absent: results are not reviewed. */
  review?: AcceptanceReviewer
  coordinate?: EngagementCoordinator
  /**
   * A staff member's model and reasoning effort checked against the DSH catalog (as for global role cards): a field
   * left out keeps the saved value, an empty string means the default. Absent: only the store's format check applies.
   */
  canonicalModel?: (wanted: {model?: string; effort?: string}, saved: {model?: string; effort?: string}) => Promise<{model: string; effort: string}>
  /**
   * Reminder for the owner in 「一句话交办」 (and push unless `localOnly`), once per key: an order completed, waits for the
   * owner, or stopped short. `order` lets the reminder open the work order.
   */
  remind?: (key: string, text: string, order?: {workspaceId: string; orderId: string}, options?: {localOnly?: boolean}) => void
  /** One coding turn per project directory (default: shared by this process). */
  locks?: DirectoryLocks
  /**
   * The liaison reads short owner words with completion wording on an order before they go anywhere (complete the
   * order, or hold them for the owner's choice). Absent: owner words always go to the executor.
   */
  judge?: CommandJudge
  /**
   * Group chats on the group engine (`engine: 'roster'` sessions): owner words, the liaison's hand-overs and supplements,
   * acceptance of each order batch, stop, and the group view. Absent: roster sessions answer 503.
   */
  groups?: WorkspaceGroupHost
}

/**
 * A line of a roster group as the client reads it (a message, a member's progress, or a faint host event). SuperHub's own
 * lines (events) carry no `speakerId`: they have no avatar.
 */
export interface GroupMessage extends V2Message {
  seq: number
  kind: GroupLine['kind']
  /** Event lines: why (`missed`, `paused`, `stopped`, `failed`…). */
  event?: string
  /** The text cut into plain parts and @-mentions (members by id, or the all-word), present when the line calls someone. */
  mentions?: MentionSegment[]
  /** Owner lines: where the words went for each member they called (see `GroupDeliveryOutcome`). */
  deliveries?: GroupDeliveryState[]
}
/**
 * Owner words for one member: `started` (a new call answers them), `queued` (after its current work), `steered` (taken
 * into its running call), `pending` (written into its running call, not confirmed yet).
 */
export interface GroupDeliveryState { memberId: string; outcome: GroupDeliveryOutcome; detail?: string }
/** A member of a roster group and what it is doing now. */
export interface GroupMemberState {
  id: string; speakerId: string; name: string; admin: boolean; kind: 'dsh' | 'codex' | 'claude-code'
  status: 'idle' | 'queued' | 'speaking' | 'working' | 'approval' | 'missed'
  since?: string; queued: number; note?: string; workOrderId?: string
  /** Its duty in this workspace (shortened). */
  duty?: string
  /** The tool its running call used last: name, what on (command, path, query; secrets hidden, one short line), since when. */
  tool?: { name: string; detail?: string; at: string }
  /** The latest words its running call said while working. */
  progress?: { text: string; at: string }
}
/** The idle guard stopped automatic calls: why (its line in the group), since when, and how many calls wait for the owner. */
export interface GroupPauseState { reason: string; since: string; parked: number; messageId?: string }
/** How long the owner's answer waits for words being steered into a running member call before saying `pending`. */
export const STEER_REPLY_WAIT_MS = 2_000
export { GROUP_RESULTS_DIR }
/** Lines of a group never checked for results count from this long ago (as the first backfill of other conversations). */
const GROUP_RESULTS_SINCE_MS = 86_400_000
interface InFlight {
  key: string
  /** Request id of the running turn; owner words sent meanwhile are steered into it. */
  requestId: string
  session: V2Session
  workOrderId?: string
  controller: AbortController
  result: Promise<void>
  /** The turn waits for its project directory: nothing is reserved or started yet, owner words join it. */
  waiting?: V2DirectoryWait
  /** Lock key of the directory a waiting turn waits for. */
  place?: string
}
/** Extra input of one turn: the project directory it holds and owner words said while it waited. */
interface TurnExtra { directory?: string; merged?: { id: string; text: string }[] }
interface SendMode { owner?: boolean; wait?: boolean; discussion?: boolean; revision?: boolean; merged?: { id: string; text: string }[] }

/** The executor's answers of a turn and what its files hold, as the liaison reads them for its review. */
export function resultSummary(evidence: SavedOrderResults, limit = RESULTS_LIMIT) {
  let text = evidence.messages.map(message => message.text.trim()).filter(Boolean).join('\n\n')
  for (const file of evidence.attachments) {
    const room = limit - text.length - file.label.length - 12
    if (room <= 0) break
    text += '\n\n【文件：' + file.label + '】\n' + file.content.slice(0, room)
  }
  return text.slice(0, limit)
}

/**
 * What the owner said on an order after handing it over: supplements the liaison relayed and the owner's own words in the
 * conversation (undelivered words aside), newest kept within `limit`.
 */
export function laterOwnerWords(messages: V2Message[], session: V2Session, orderId: string, original: string, limit = ORIGINAL_LIMIT) {
  const first = original.trim()
  const said = messages.filter(message => messageWorkOrder(session, message) === orderId && message.delivery !== 'unsent')
    .flatMap(message => message.role === 'user' && message.speakerId === 'owner' ? [message.text] : message.quote ? [message.quote.text] : [])
    .map(text => text.trim()).filter(text => text && text !== first)
  const text = said.join('\n---\n')
  return text.length > limit ? text.slice(-limit) : text
}

/**
 * What earlier turns of an order handed back: their registered results (report text and file names), oldest first,
 * newest kept within `limit`. Results of `turnId` itself and of turns registered after it are left out.
 */
export function earlierResults(notices: StoredResult[], orderId: string, turnId: string, limit = ORIGINAL_LIMIT) {
  const own = notices.filter(row => row.orderId === orderId && row.requestId === turnId)
  const before = own.length ? own.map(row => row.at).sort()[0]! : undefined
  const rows = notices.filter(row => row.orderId === orderId && row.requestId !== turnId && row.kind !== 'weekly' && (!before || row.at < before))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(row => row.text.trim().slice(0, 600) + (row.attachments.length ? '\n附件：' + row.attachments.map(file => file.label).join('、') : ''))
  const text = rows.join('\n---\n')
  return text.length > limit ? text.slice(-limit) : text
}

/** Mounted behind serveApi's authenticated desktop/mobile gateways, under the active brain lock. */
export function workspaceV2Routes({ staff, store, source, timeZone = 'Asia/Shanghai', now, approvals, review, coordinate, canonicalModel, remind, locks = directoryLocks, judge, groups, inputAttachments, learning, learningProblem, liaisonTrace }: Options) {
  const scope = store.scope
  const flights = new Map<string, InFlight>()
  let disposed = false
  const current = () => { if (disposed) workspaceError(409, '工作区运行环境已切换，请重新打开') }
  const followup = new WorkspaceFollowup(store, read, current, timeZone, now, order => {
    const token = activeMember(order.workspaceId,order.staffId).token
    return source.staffSources?.(store.traceBinding(store.session(order.workspaceId,order.sessionId)),order.id,token) ?? new Set<string>()
  })
  const notices = new WorkspaceResultNotices(store, source, current, now, () => runAcceptances(),
    groups && {collect: () => collectGroupResults(), attachment: (notice, fileId) => groupResultFile(notice, fileId)},
    result => learnResult(result))
  const reviews = new AbortController()
  const reviewing = new Set<string>()
  function submitLearning(signal: Parameters<ExperienceLearning['settle']>[0], deferred: boolean) {
    if (!learning) return
    if (deferred) {
      try { learning.observe(signal) } catch (error) { learningProblem?.(error) }
    } else void learning.settle(signal).catch(error => learningProblem?.(error))
  }

  function learnResult(result: StoredResult, deferred = false) {
    if (!learning || result.at < learning.startedAt || !result.text.trim() || result.kind === 'weekly' ||
      store.deletedReason(result.workspaceId, result.sessionId, result.orderId)) return
    const evidence: ExperienceEvidence = {kind: 'delivery', id: result.id, workspaceId: result.workspaceId,
      sessionId: result.sessionId, traceId: result.traceId, orderId: result.orderId, messageId: result.messageId, version: result.version}
    const signal = {id: 'delivery:' + result.id, workspaceId: result.workspaceId, sessionId: result.sessionId,
      orderId: result.orderId, kind: 'delivery' as const, summary: result.text, evidence: [evidence]}
    submitLearning(signal, deferred)
    if (!result.attachments.length) return
    try {
      const session = store.traceBinding(store.session(result.workspaceId, result.sessionId), result.traceId ?? INITIAL_WORKSPACE_TRACE)
      const original = !roster(session) && result.requestId ? source.experienceSource?.(session, result.requestId) : undefined
      learnArtifacts(result, deferred, original?.staffId)
    } catch (error) { learningProblem?.(error) }
  }

  function learnArtifacts(result: StoredResult, deferred: boolean, staffId?: string) {
    const proofs = result.attachments.slice(0, 8).flatMap(file => {
      const evidence = artifactEvidence(result, file, staffId)
      const verified = evidence && verifyLearningOriginal(evidence, {staffId})
      return evidence && verified ? [{evidence, verified}] : []
    })
    if (!proofs.length) return
    const replaced = new Set(proofs.flatMap(proof => proof.verified.replacementOf ?? []))
    if (replaced.size && staff) staff.holdReplacedExperience(result.workspaceId, staffId,
      staff.experienceMemories(result.workspaceId).filter(memory => memory.staffId === staffId && memory.premise
        && replaced.has(artifactSource(memory.premise))))
    const session = store.traceBinding(store.session(result.workspaceId, result.sessionId), result.traceId ?? INITIAL_WORKSPACE_TRACE)
    const evidence = proofs.map(proof => proof.evidence)
    const lines = roster(session) ? learningGroupLines(session).filter(line => evidence.some(proof => proof.messageId === lineId(line.seq))
      || result.messageId === lineId(line.seq)) : []
    const turnIds = lines.flatMap(line => line.memberCallId ?? line.engagement?.callId ?? [])
    const nativeTurn = !roster(session) && result.requestId ? source.experienceSource?.(session, result.requestId) : undefined
    submitLearning({workspaceId: result.workspaceId, sessionId: result.sessionId, orderId: result.orderId, staffId,
      ...(nativeTurn && {turnId: result.requestId}),
      sourceTurnIds: turnIds,
      sourceExperienceRefs: nativeTurn?.refs ?? lines.flatMap(line => line.experienceRefs ?? []),
      id: 'artifact:' + workspaceFingerprint([result.id, result.version, staffId, evidence.map(proof => proof.id)]),
      kind: 'delivery', summary: result.text, evidence}, deferred)
  }

  function expirationDate(value: unknown) {
    if (value === null) return null
    const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (!match) return workspaceError(400, '请选择有效的经验截止日期')
    const [year, month, day] = match.slice(1).map(Number) as [number, number, number]
    const midday = zonedInstant(year, month, day, 12 * 60, timeZone)
    if (slotKey(midday, timeZone).slice(0, 10) !== value) return workspaceError(400, '请选择有效的经验截止日期')
    const next = new Date(Date.UTC(year, month - 1, day + 1))
    return zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, timeZone).toISOString()
  }
  function learnOwnerWords(session: V2Session, line: GroupLine) {
    if (!learning || line.at < learning.startedAt || !line.text.trim()) return
    void learning.interpretOwner({id: 'group:' + session.id + ':' + line.seq, text: line.text, workspaceId: session.workspaceId,
      sessionId: session.id, traceId: line.traceId, orderId: line.workOrderId, messageId: lineId(line.seq)}).catch(error => learningProblem?.(error))
  }
  function learnReview(row: {workspaceId: string; sessionId: string; orderId: string; turnId: string; traceId?: string}, outcome: AcceptanceOutcome) {
    if (!learning || outcome.kind !== 'verdict' || store.deletedReason(row.workspaceId, row.sessionId, row.orderId)) return
    const {workspaceId, sessionId, orderId, turnId} = row
    const evidence: ExperienceEvidence = {kind:'model-review', id:turnId, workspaceId, sessionId, orderId, traceId:row.traceId}
    try {
      learning.observe({id:'model-review:' + turnId, kind:'review', workspaceId, sessionId, orderId,
        summary:outcome.verdict === 'pass' ? '模型评议认为交付满足本轮约定。' : '模型评议发现尚未满足的交付要求。', evidence:[evidence]})
    } catch (error) { learningProblem?.(error) }
  }
  /** Owner words being read by the liaison, by request: a retry of the same words waits for the same reading. */
  const judging = new Map<string, Promise<Awaited<ReturnType<typeof judgeCommand>>>>()
  const shown = (order: V2Delegation) => store.present(order, timeZone, now?.())
  /** One reminder per order and turn; a failing outbox never blocks the order's own record. */
  function tell(kind: 'done' | 'stalled', order: Pick<V2Delegation, 'id' | 'workspaceId'>, turnId: string, text: string) {
    try { remind?.('workspace-' + kind + ':' + order.id + ':' + turnId, text, {workspaceId: order.workspaceId, orderId: order.id}, kind === 'done' ? {localOnly: true} : undefined) }
    catch { /* the order page still shows it */ }
  }
  const clipped = (text: string, limit = 160) => { const flat = text.replace(/\s+/g, ' ').trim().replace(/。+$/, ''); return flat.length > limit ? flat.slice(0, limit) + '…' : flat }
  /** A turn of an order that stopped short (failed, interrupted or never started): tell the owner once. */
  function stalled(workspaceId: string, orderId: string, turnId: string, what: string) {
    let order: V2Delegation
    try { order = store.delegation(workspaceId, orderId) } catch { return }
    if (orderEnded(order) || store.deletedReason(workspaceId, order.sessionId)) return
    tell('stalled', order, turnId, '「' + order.title + '」' + what)
  }

  const archived = (workspaceId: string) => store.list().some(space => space.id === workspaceId && workspaceArchived(space))
  function currentApproval(row: V2PendingApproval) {
    if (archived(row.workspaceId) || store.deletedReason(row.workspaceId, row.sessionId, row.workOrderId ?? undefined)) return false
    try { store.assertActiveTrace({workspaceId: row.workspaceId, id: row.sessionId}, row.traceId ?? INITIAL_WORKSPACE_TRACE) }
    catch { return false }
    return true
  }
  /** Work in flight in a workspace: a coding turn (running or waiting for its directory) or a group member not idle. */
  function busy(workspaceId: string) {
    for (const flight of flights.values()) if (flight.session.workspaceId === workspaceId) return true
    if (!groups) return false
    return store.rosterSessions().some(session => {
      const engine = session.workspaceId === workspaceId ? groups.loaded(session.id) : undefined
      if (!engine?.started) return false
      try { return engine.view().members.some(member => member.status !== 'idle') } catch { return false }
    })
  }
  /** Archive: refused while work runs; the commands still waiting for the owner's approval there are refused with it. */
  function archive(mutation: Mutation, workspaceId: string) {
    const result = store.archive(mutation, workspaceId, () => busy(workspaceId), now?.())
    // A replayed request answers from its receipt: a workspace restored since then keeps its approvals and groups.
    if (!archived(workspaceId)) return result
    for (const row of approvals?.pending({workspaceId}) ?? []) {
      try { approvals!.answer(row.id, false, {workspaceId, sessionId: row.sessionId, orderId: row.workOrderId}) } catch { /* already answered or expired */ }
    }
    groups?.stopWorkspace(workspaceId)
    return result
  }

  function remove(mutation: Mutation, workspaceId: string, target: WorkspaceTarget, id: string) {
    const sessionId = target === 'session' ? id : store.reference(workspaceId, 'order', id)?.sessionId
    const pending = target === 'order' && sessionId ? store.pendingStarts(sessionId).filter(row => row.workspaceId === workspaceId && row.delegationId === id) : []
    const result = store.deleteTarget(mutation, workspaceId, target, id, now?.())
    for (const row of approvals?.pending({workspaceId, ...(target === 'session' ? {sessionId: id} : {orderId: id})}) ?? []) {
      try { approvals!.answer(row.id, false, {workspaceId, sessionId: row.sessionId, orderId: row.workOrderId}) } catch { /* a completed command has no pending reply */ }
    }
    for (const flight of flights.values()) {
      if (flight.session.workspaceId === workspaceId && (target === 'session' ? flight.session.id === id : flight.workOrderId === id)) flight.controller.abort()
    }
    if (target === 'session') {
      groups?.stopSession(id)
    } else if (sessionId) {
      groups?.stopOrder(sessionId, id, '这张工单已删除，为它进行的工作已叫停。')
      for (const start of pending) {
        const words = [...start.kind === 'interject' ? [{id: start.requestId, text: start.text}] : [], ...start.merged ?? []]
        for (const row of words) {
          try { source.markInterjection?.(store.traceBinding(store.session(workspaceId, sessionId)), {...row, workOrderId: id}, 'unsent') }
          catch { /* The stopped receipt remains the record. */ }
        }
      }
    }
    return result
  }

  function experienceReferences<T extends Pick<ExperienceMemory, 'workspaceId' | 'orderId' | 'lastUsed' | 'evidence' | 'conflict' | 'premise' | 'feedback'>>(memory: T): T {
    const orderDeletion = (workspaceId?: string, orderId?: string) => workspaceId && orderId ? store.reference(workspaceId, 'order', orderId)?.deletedAt : undefined
    const evidence = (source: ExperienceEvidence): ExperienceEvidence => {
      const workspaceId = source.workspaceId ?? memory.workspaceId
      const orderDeletedAt = orderDeletion(workspaceId, source.orderId)
      const sessionDeletedAt = workspaceId && source.sessionId ? store.reference(workspaceId, 'session', source.sessionId)?.deletedAt : undefined
      return {...source, ...(orderDeletedAt && {orderDeletedAt}), ...(sessionDeletedAt && {sessionDeletedAt})}
    }
    const orderDeletedAt = orderDeletion(memory.workspaceId, memory.orderId)
    const lastUsedDeletedAt = orderDeletion(memory.lastUsed?.workspaceId, memory.lastUsed?.orderId)
    return {...memory, ...(orderDeletedAt && {orderDeletedAt}),
      ...(memory.lastUsed && lastUsedDeletedAt && {lastUsed: {...memory.lastUsed, orderDeletedAt: lastUsedDeletedAt}}),
      ...(memory.evidence && {evidence: memory.evidence.map(evidence)}), ...(memory.conflict && {conflict: memory.conflict.map(evidence)}),
      ...(memory.premise && {premise: evidence(memory.premise)}),
      ...(memory.feedback && {feedback: memory.feedback.map(row => ({...row, evidence: evidence(row.evidence)}))})}
  }

  function staffReferences(view: ReturnType<WorkspaceStaffStore['view']>) {
    return {...view, memories: view.memories.map(experienceReferences),
      ...(view.retiredMemories && {retiredMemories: view.retiredMemories.map(experienceReferences)}),
      ...(view.sharedExperiences && {sharedExperiences: view.sharedExperiences.map(experienceReferences)})}
  }

  function activeMember(workspaceId:string,staffId:unknown) {
    if (typeof staffId !== 'string' || !staffId || !staff) return workspaceError(400,'请选择本区可接单的幕僚')
    const {name,token} = staff.context(workspaceId,staffId)
    return {id:staffId,name,token}
  }

  // ---------------------------------------------------------------------------------------------
  // Roster groups (the group engine): the liaison is the admin member, the workspace's staff are members.

  const roster = (session: V2Session) => isRosterGroup(session)
  async function groupEngine(session: V2Session): Promise<GroupEngine> {
    if (!groups) return workspaceError(503, '群聊暂不可用，请稍后重试')
    try { return await groups.engine(session) }
    catch (error) {
      if (error && typeof error === 'object' && 'status' in error) throw error
      return workspaceError(503, '群聊暂不可用：' + (error instanceof Error ? error.message : String(error)).slice(0, 160))
    }
    finally { current() }
  }
  /** The acceptance record of one order batch of a group. */
  const groupTurnId = (session: V2Session, batchId: string) => 'grp-' + dialogueKey(session.id, batchId).slice(0, 40)
  const lineId = (seq: number) => 'g-' + seq
  const lineSeq = (id: string | undefined) => { const match = /^g-(\d+)$/.exec(id ?? ''); return match ? Number(match[1]) : undefined }
  /** Public speaker ids, as the other conversations give them (portraits follow staff and the liaison). */
  function groupSpeaker(session: V2Session, memberId: string) {
    const lead = groupLeadId(scope, session.workspaceId, session.id)
    if (memberId === OWNER_ID) return 'owner'
    if (memberId === LIAISON_MEMBER_ID) return liaisonSpeakerId(lead)
    return workspaceSpeakerId(lead, 'staff', memberId)
  }
  function groupMessages(session: V2Session, engine: GroupEngine, lines: readonly GroupLine[] = engine.ledger.all(), editable = false): GroupMessage[] {
    const members = engine.members().map(({id, name}) => ({id, name}))
    let oldVersions: Map<string, string> | undefined
    const versionOf = (file: GroupAttachment, id: string) => file.version ?? (oldVersions ??= groupVersions(session)).get(id)
    return store.messageReferences(session, lines.map(line => {
      const mentions = line.kind !== 'event' && (line.mentions.length || line.all) ? mentionSegments(line.text, members) : undefined
      const deliveries = line.speakerId === OWNER_ID || line.inputAttachments?.length ? engine.deliveryOf(line.seq) : undefined
      return {
        id: lineId(line.seq), traceId: line.traceId ?? INITIAL_WORKSPACE_TRACE, seq: line.seq, kind: line.kind, role: line.speakerId === OWNER_ID ? 'user' as const : 'agent' as const,
        author: line.speakerId === OWNER_ID ? '你' : line.author, ...line.speakerId !== HOST_ID && {speakerId: groupSpeaker(session, line.speakerId)}, at: line.at, text: line.text,
        ...deliveries?.length && {deliveries: deliveries.map(row => ({...row}))},
        ...line.workOrderId !== undefined && {workOrderId: line.workOrderId}, ...line.replyTo !== undefined && {replyTo: lineId(line.replyTo)},
        ...line.attachments?.length && {attachments: line.attachments.map((file, index) => {
          const id = lineId(line.seq) + '-' + index, version = versionOf(file, id)
          return {id, label: file.name, ...version && {version}}
        })},
        ...line.inputAttachments?.length && {inputAttachments: line.inputAttachments.map(file => ({...file}))},
        ...line.quote && {quote: {...line.quote}}, ...line.event !== undefined && {event: line.event},
        ...mentions?.some(part => 'memberId' in part || 'all' in part) && {mentions},
        ...editable && editableGroupLine(session, line) && {canEdit: true},
      }
    }))
  }
  const groupFileOf = (lines: readonly GroupLine[]) => (id: string) => {
    const [, seq, index] = /^g-(\d+)-(\d+)$/.exec(id) ?? []
    return seq ? lines.find(line => line.seq === Number(seq))?.attachments?.[Number(index)]?.path : undefined
  }
  function groupVersions(session: V2Session) {
    return new Map([...store.groupEvidence(), ...store.resultNotices()].filter(result => result.workspaceId === session.workspaceId && result.sessionId === session.id)
      .flatMap(result => result.attachments.map(file => [file.id, file.version] as const)))
  }
  function editableGroupLine(session: V2Session, line: GroupLine) {
    return line.kind === 'message' && line.speakerId === OWNER_ID && !!line.requestId && !line.ref
      && !store.deletedReason(session.workspaceId, session.id, line.workOrderId)
  }
  /** The group's transcript with the board's held words and choices, like the other conversations. */
  async function groupTranscript(session: V2Session, paging?: PageQuery, traceId?: string, includeLate = false): Promise<{transcript: V2Transcript & {messages: GroupMessage[]}; engine: GroupEngine}> {
    if (!groups) return workspaceError(503, '群聊暂不可用，请稍后重试')
    const state = store.traceState(session)
    if (traceId === undefined && paging?.around && state.traces.length > 1) {
      const anchor = lineSeq(paging.around)
      if (anchor !== undefined) {
        for (const trace of state.traces.toReversed()) {
          const line = groups.lines(session, trace.id).find(line => line.seq === anchor)
          if (line) { traceId = line.traceId ?? INITIAL_WORKSPACE_TRACE; break }
        }
      }
    }
    const selected = store.traceBinding(session, traceId).traceId!
    const historical = selected !== state.active || !!session.deletedAt
    const engine = historical ? await groups.historical(session, selected) : await groupEngine(session)
    if (!historical && selected !== store.assertActiveTrace(session)) return groupTranscript(session, paging, traceId, includeLate)
    // A group opened read-only (archived workspace) gets nothing new; what was not posted goes in once it is restored.
    if (!historical && !engine.readOnly) for (const row of store.unpostedCommands()) if (row.workspaceId === session.workspaceId && row.sessionId === session.id) postGroupCommand(session, engine, row.requestId)
    // A paged read projects only the lines of its window (the ledger is already in memory).
    const all = historical ? groups.lines(session, selected) : engine.ledger.all()
    const frozenThrough = state.traces.find(trace => trace.id === selected)?.frozenThrough
    const cursor = lineSeq(paging?.around ?? paging?.before ?? paging?.after)
    const lines = historical && !includeLate && frozenThrough !== undefined && (cursor === undefined || cursor <= frozenThrough)
      ? all.filter(line => line.seq <= frozenThrough) : all
    const window = paging && pageWindow(lines, line => lineId(line.seq), paging)
    const choices = historical ? {held: {}, actions: {}} as ReturnType<typeof store.conversationChoices> : store.conversationChoices(session)
    const chosen = (messages: GroupMessage[]) => Object.keys(choices.held).length || Object.keys(choices.actions).length ? messages.map(message => {
      const held = choices.held[message.id], actions = message.role === 'agent' ? choices.actions[message.id] : undefined
      return held || actions ? {...message, ...(held && {held}), ...(actions && {actions})} : message
    }) : messages
    const messages = chosen(groupMessages(session, engine, window?.items ?? lines, !historical && !engine.readOnly && !session.closed))
    // Choices still waiting for the owner on lines outside the window come along, so paging never hides them.
    const shown = new Set(messages.map(message => message.id))
    const waiting = window ? Object.entries(choices.actions).flatMap(([id, actions]) => {
      const line = !shown.has(id) && awaitingChoice(actions) ? engine.ledger.get(Number(/^g-(\d+)$/.exec(id)?.[1])) : undefined
      return line ? [line] : []
    }) : []
    const pinned = waiting.length ? chosen(groupMessages(session, engine, waiting)).filter(message => awaitingChoice(message.actions)) : []
    return {transcript: {messages, traceId: selected, activeTraceId: state.active, ...(window && {page: window.page}), ...(pinned.length && {pinned})}, engine}
  }
  function groupView(session: V2Session, engine: GroupEngine) {
    const view = engine.view()
    const iso = (at: number) => new Date(at).toISOString()
    const members: GroupMemberState[] = view.members.map(row => ({id: row.memberId, speakerId: groupSpeaker(session, row.memberId), name: row.name, admin: row.admin, kind: row.kind,
      status: row.status, queued: row.queued, ...row.since !== undefined && {since: iso(row.since)}, ...row.note && {note: row.note},
      ...row.workOrderId && {workOrderId: row.workOrderId}, ...row.duty && {duty: row.duty},
      ...row.tool && {tool: {name: row.tool.name, ...row.tool.detail && {detail: row.tool.detail}, at: iso(row.tool.at)}},
      ...row.progress && {progress: {text: row.progress.text, at: iso(row.progress.at)}}}))
    const paused: GroupPauseState | undefined = view.paused && {reason: view.paused.reason, since: iso(view.paused.since), parked: view.paused.parked,
      ...view.paused.seq !== undefined && {messageId: lineId(view.paused.seq)}}
    return {members, ...paused && {paused}, approvals: view.approvals.filter(currentApproval)}
  }
  /** Owner words in a group: one line (once per request), steered into the members already working on them. */
  function grantGroupFiles(session: V2Session, workOrderId: string | undefined, refs?: ChatInputAttachment[]) {
    if (!refs?.length) return
    if (!inputAttachments) return workspaceError(503, '群聊附件服务暂不可用')
    inputAttachments.grant({sessionId: session.id, workspaceId: session.workspaceId, workOrderId}, refs)
  }
  async function groupSay(session: V2Session, mutation: Mutation, text: unknown, workOrderId: string | undefined, refs?: ChatInputAttachment[], answerTo?: string) {
    if (typeof text !== 'string' || (!text.trim() && !refs?.length) || text.length > 64_000) return workspaceError(400, '请填写有效的发言或选择附件，正文最多 64000 字')
    const expected = store.assertActiveTrace(session, session.traceId)
    const engine = await groupEngine(session)
    store.assertActiveTrace(session, expected)
    const replay = !!store.receipt(mutation)
    store.recordGroupSay(mutation, {...session, traceId: expected}, workOrderId)
    grantGroupFiles(session, workOrderId, refs)
    // The owner's words come first: a review in flight does not follow up, a waiting decision is answered.
    if (!replay) store.ownerSpoke(session.id, workOrderId)
    engine.refreshMembers()
    if (coordinate && (answerTo || store.ownerActions(session.id, workOrderId).length)) {
      const latest = engine.ledger.byRequest(mutation.id)
      if (latest) return {session: store.session(session.workspaceId, session.id), messageId: lineId(latest.seq), deliveries: []}
      const generation = workOrderId ? store.delegation(session.workspaceId, workOrderId).generation : undefined
      const line = engine.note({speaker: 'owner', text, workOrderId, requestId: mutation.id, inputAttachments: refs,
        engagement: {callId: mutation.id, triggerSeq: engine.ledger.lastSeq + 1, generation, answerTo}})
      learnOwnerWords(session, line)
      return {session: store.session(session.workspaceId, session.id), messageId: lineId(line.seq), deliveries: []}
    }
    const {line, deliveries} = engine.say(text, {requestId: mutation.id, ...(workOrderId && {workOrderId}), inputAttachments: refs})
    if (!replay) learnOwnerWords(session, line)
    const wait = new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), STEER_REPLY_WAIT_MS).unref?.())
    const rows = await Promise.all(deliveries.map(async row => ({memberId: row.memberId, outcome: await Promise.race([row.outcome, wait]) as GroupDeliveryOutcome})))
    current()
    const delivered = engine.deliveryOf(line.seq)
    return {session: store.session(session.workspaceId, session.id), messageId: lineId(line.seq), deliveries: rows.map(row =>
      delivered?.find(saved => saved.memberId === row.memberId && saved.outcome === 'failed') ?? row)}
  }

  const liaisonPosts = new Map<string, Promise<void>>()

  async function postLiaisonDialogue(record: LiaisonDialogueRecord) {
    const { workspaceId, sessionId, traceId, question, original, ref } = record
    const requestId = record.actionRequestId ?? original.requestId
    if (!question) return
    const activeSource = () => {
      if (!record.liaisonTraceId || !liaisonTrace || liaisonTrace() === record.liaisonTraceId) return true
      let posted: GroupLine | undefined
      if (record.progress.state === 'pending' && record.progress.posting) {
        try { posted = groups?.lines({id:sessionId,workspaceId}, traceId).find(line => line.ref === ref) } catch { /* The version is unreadable. */ }
      }
      store.saveLiaisonDialogue(requestId, {state:'cancelled',reason:'接口人对话已续写，宿主已停止补发原请求', ...(posted && {seq:posted.seq})})
      return false
    }
    if (!activeSource()) return
    let mayHavePosted = record.progress.state === 'pending' && record.progress.posting === true
    try {
      store.writable(workspaceId)
      const session = store.session(workspaceId, sessionId)
      if (session.closed) return workspaceError(409, '这场会话已关闭')
      store.assertActiveTrace(session, traceId)
      const engine = await groupEngine(session)
      const row = store.liaisonDialogue(requestId)
      if (!row || row.progress.state !== 'pending' && row.progress.state !== 'failed' || !activeSource()) return
      mayHavePosted = !!engine.ledger.byRef(ref)
      if (store.session(workspaceId, sessionId).closed) return workspaceError(409, '这场会话已关闭')
      store.writable(workspaceId)
      store.assertActiveTrace(session, traceId)
      groups?.workDir(session)
      engine.refreshMembers()
      const member = engine.members().find(row => row.id === (record.staffId ?? LIAISON_MEMBER_ID))
      if (!member) return workspaceError(409, '接话的幕僚已不在这个工作区')
      grantGroupFiles(session, undefined, record.inputAttachments)
      const prompt = record.handoff ?? '请用本工作区可用的资料回答主人转来的问题。需要主人补充时，说明缺少哪项。'
      // The scheduler writes its dispatch receipt with the queued call. A retry after the ledger write reuses the line.
      store.saveLiaisonDialogue(requestId, {state:'pending', posting:true})
      mayHavePosted = true
      const line = engine.dispatchEngagement(ref, [member.id], record.staffId ? '@' + member.name + ' ' + prompt : prompt,
        undefined, {original:question, inputAttachments:record.inputAttachments, exactScope:true})
      store.saveLiaisonDialogue(requestId, {state:'sent', seq:line.seq})
    } catch (error) {
      current()
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 240)
      store.saveLiaisonDialogue(requestId, mayHavePosted ? {state:'pending', posting:true, reason} : {state:'failed', reason})
    }
  }

  function dispatchLiaisonDialogue(record: LiaisonDialogueRecord): Promise<void> {
    const pending = liaisonPosts.get(record.ref)
    if (pending) return pending
    const post = Promise.resolve().then(() => postLiaisonDialogue(record)).finally(() => liaisonPosts.delete(record.ref))
    liaisonPosts.set(record.ref, post)
    return post
  }

  function liaisonDialogueStatus(originalRequestId: string): LiaisonDialogueResult | undefined {
    current()
    const row = store.liaisonDialogue(originalRequestId)
    if (!row || row.progress.state === 'replaced') return
    const {workspaceId, sessionId, traceId, progress} = row
    const workspace = store.workspace(workspaceId)
    const session = store.session(workspaceId, sessionId)
    const target = {workspace, session, traceId, requestId:originalRequestId}
    if (progress.state === 'sent') {
      const rows = groups?.lines(session, traceId) ?? []
      const replied = rows.some(line => line.replyTo === progress.seq && line.memberCompleted)
      const failure = !replied && rows.findLast(line => line.engagement?.triggerSeq === progress.seq && line.kind === 'event'
        && (line.event === 'failed' || line.event === 'interrupted'))
      return {...target, sourceMessageId:lineId(progress.seq), state:replied ? 'replied' : 'sent',
        ...(failure && {reason:failure.text}) }
    }
    return {...target, state:progress.state, ...'reason' in progress && progress.reason && {reason:progress.reason},
      ...progress.state === 'cancelled' && progress.seq && {sourceMessageId:lineId(progress.seq)}}
  }

  async function liaisonDialogue(input: LiaisonDialogueRequest) {
    current()
    if (input.staffId) activeMember(input.workspaceId, input.staffId)
    const record = store.beginLiaisonDialogue({...input,liaisonTraceId:liaisonTrace?.()})
    if (record.progress.state === 'pending' || record.progress.state === 'failed') await dispatchLiaisonDialogue(record)
    return liaisonDialogueStatus(input.actionRequestId ?? input.original.requestId) ?? workspaceError(409, '这项请求已交给工单，请打开原工单')
  }

  function liaisonDialogueCancel(input: LiaisonDialogueCancellation) {
    current()
    if (store.cancelLiaisonDialogue(input)) return liaisonDialogueStatus(input.originalRequestId)
  }

  /**
   * Before each member call: a staff member must still be in the workspace with the identity the call is built from
   * (its `StaffContext` token), and a call on an order uses one turn of the order's budget (refused when it is used up,
   * or the order is finished, cancelled or paused).
   */
  function admitCall(session: V2Session, call: {member: {id: string; name: string; token?: string}; workOrderId?: string}): string | undefined {
    if (disposed) return '工作区运行环境已切换'
    const deleted = store.deletedReason(session.workspaceId, session.id, call.workOrderId)
    if (deleted) return deleted
    // An archived workspace takes no new work, also from calls that belong to no order.
    if (archived(session.workspaceId)) return WORKSPACE_ARCHIVED
    if (call.member.id !== LIAISON_MEMBER_ID && staff) {
      let context
      try { context = staff.context(session.workspaceId, call.member.id) } catch { return call.member.name + ' 已不在本工作区' }
      try { staff.assertCurrent({...context, token: call.member.token ?? context.token}) } catch { return call.member.name + ' 可见的资料刚刚变了，这一次没有叫它，请再叫一次' }
    }
    if (call.workOrderId) return store.chargeGroupCall(session.workspaceId, session.id, call.workOrderId)
  }
  /** What a group's scheduler did: hold the liaison's order batches for review; tell the owner about calls that stopped short. */
  function groupEffects(session: V2Session, effects: readonly GroupEffect[], engine: GroupEngine) {
    if (disposed || store.deletedReason(session.workspaceId, session.id)) return
    for (const effect of effects) {
      if (effect.type === 'wake' && effect.held) {
        if (store.deletedReason(session.workspaceId, session.id, effect.workOrderId)) continue
        let record
        try {
          // The batch's result notices and its review are registered in one write.
          record = publishGroup(session, engine.ledger.all(), review && effect.workOrderId ? {turnId: groupTurnId(session, effect.batchId),
            orderId: effect.workOrderId, batchId: effect.batchId, done: effect.done, results: effect.results} : undefined)
        } catch { record = undefined }
        // Nothing to review (no reviewer, the order changed): the liaison is woken as usual to sum up.
        if (!record) queueMicrotask(() => {
          if (disposed || store.deletedReason(session.workspaceId, session.id, effect.workOrderId)) return
          try { engine.wakeNow(effect) } catch { /* the group moved on */ }
        })
        else queueMicrotask(() => runAcceptances())
      }
      if (effect.type === 'event' && (effect.event === 'failed' || effect.event === 'interrupted') && effect.workOrderId) {
        let order: V2Delegation | undefined
        try { order = store.delegation(session.workspaceId, effect.workOrderId) } catch { order = undefined }
        if (!order || order.paused || order.reporting) continue
        stalled(session.workspaceId, effect.workOrderId, groupTurnId(session, 'event-' + effect.seq), effect.event === 'interrupted'
          ? '在群里的工作因服务重启中断了，打开工单让成员汇报或继续。' : '在群里的一次工作没能完成：' + clipped(effect.text, 120) + '。打开工单查看并决定下一步。')
      }
    }
  }
  /** Orders whose members all handed back are waiting again (shown on the order). */
  function groupChanged(session: V2Session, engine: GroupEngine) {
    if (disposed || store.deletedReason(session.workspaceId, session.id)) return
    try { store.settleGroupOrders(session.workspaceId, session.id, engine.busyOrders()) } catch { /* shown again after the next change */ }
    try { publishGroup(session, engine.ledger.all()) } catch { /* published on the next change or collect */ }
    if (coordinate && !session.closed) {
      try { queueEngagement(session, engine.ledger.all()) } catch { /* retried on the next change or recover */ }
      runEngagement()
    }
  }

  /** Lines of each group already checked for results in this process (the board keeps the last one that published). */
  const groupScanned = new Map<string, number>()
  const memberLearningScanned = new Map<string, number>()
  const memberLearningRetry = new Set<string>()
  let groupsCollected = false

  function learnGroupMembers(session: V2Session, lines: readonly GroupLine[], deferred = false, delivered: readonly StoredResult[] = []) {
    if (!learning || !staff) return
    const {id: sessionId, workspaceId} = session
    const from = memberLearningScanned.get(sessionId) ?? 0
    const last = lines.at(-1)?.seq ?? from
    if (last <= from && !delivered.length) return
    const formal = new Map(delivered.map(result => [result.messageId, result]))
    const outcomes = lines.flatMap(line => {
      const delivery = formal.get(lineId(line.seq))
      const isDelivery = !!delivery && delivery.workspaceId === workspaceId && delivery.sessionId === sessionId && delivery.orderId === line.workOrderId
      if (line.at < learning.startedAt || !line.memberCallId || !line.memberCompleted && !isDelivery
        || line.seq <= from && !isDelivery || [LIAISON_MEMBER_ID, OWNER_ID, HOST_ID].includes(line.speakerId)) return []
      const id = memberCompletionEvidenceId(sessionId, line, isDelivery)
      return id ? [{line, id, callId: line.memberCallId}] : []
    })
    if (outcomes.length) {
      if (archived(workspaceId)) return
      const members = new Set(staff.view(workspaceId).members.map(member => member.id))
      const orders = new Set(store.view(workspaceId).orders.filter(order => order.sessionId === sessionId).map(order => order.id))
      for (const {line, id, callId} of outcomes) {
        if (!members.has(line.speakerId) || line.workOrderId && !orders.has(line.workOrderId)) continue
        const evidence: ExperienceEvidence = {kind: 'group', id, workspaceId, sessionId, orderId: line.workOrderId,
          traceId: line.traceId, messageId: lineId(line.seq), quote: line.text.slice(0, 3000)}
        const signal = {id, kind: 'delivery' as const, workspaceId, sessionId, orderId: line.workOrderId, staffId: line.speakerId,
          summary: line.text, sourceTurnIds: [callId], sourceExperienceRefs: line.experienceRefs, evidence: [evidence]}
        // Advance the scan only after the source has a durable learning receipt or a pending record.
        learning.observe(signal)
        if (!deferred) void learning.settle(signal).catch(error => learningProblem?.(error))
        const result = formal.get(lineId(line.seq))
        if (result?.attachments.length) {
          try { learnArtifacts(result, deferred, line.speakerId) } catch (error) { learningProblem?.(error) }
        }
        if (groups && line.memberCompleted) {
          const commands = readCommandLog(join(groups.paths(session, line.traceId).dir, GROUP_COMMANDS_FILE), line.workOrderId ?? null).commands
          const proofs = commands.flatMap(command => command.memberId === line.speakerId && command.turnId.startsWith(callId + '.')
            && command.endedAt && !command.unmatched && !command.unfinished && typeof command.exitCode === 'number'
            ? [commandExperienceEvidence({workspaceId, sessionId, traceId: line.traceId, orderId: line.workOrderId,
              turnId: command.turnId, staffId: line.speakerId}, command.id, {...command, exitCode: command.exitCode})] : []).slice(-8)
          if (proofs.length) submitLearning({...signal, id: 'group-command:' + id, evidence: proofs}, deferred)
        }
      }
    }
    memberLearningScanned.set(sessionId, last)
  }

  function groupMemberLearning(session: V2Session, lines: readonly GroupLine[], deferred = false, delivered?: readonly StoredResult[]) {
    try {
      if (memberLearningRetry.has(session.id)) {
        delivered = [...store.groupEvidence(), ...store.resultNotices()].filter(result => result.sessionId === session.id)
      }
      learnGroupMembers(session, lines, deferred, delivered)
      memberLearningRetry.delete(session.id)
    } catch (error) {
      memberLearningRetry.add(session.id)
      learningProblem?.(error)
    }
  }
  /** Publish results of every group's new lines: all groups the first time (from their ledgers), then the running ones. */
  function collectGroupResults() {
    if (disposed || !groups) return
    const failures: unknown[] = []
    for (const session of store.rosterSessions()) {
      const engine = groups.loaded(session.id)
      if (!engine?.started && groupsCollected) continue
      try {
        const lines = engine?.started ? engine.ledger.all() : groups.lines(session)
        publishGroup(session, lines)
      } catch (error) { failures.push(error) }
    }
    groupsCollected = true
    if (failures.length) throw failures[0]
  }
  function publishedGroupFile(session: V2Session, file: GroupAttachment, version?: string, base?: string) {
    if (version) {
      const kept = readKeptGroupFile(groups!.paths(session).dir, version)
      if (kept) return kept
    }
    const current = base && readGroupFile(base, file)
    return current && (!version || fileVersion(current) === version) ? current : undefined
  }
  /**
   * The results of a group's member lines not checked yet (each line once), and the review of an order batch that landed,
   * in one write. The delivered files are kept by version beside the ledger, so a notice opens the version it announced.
   */
  function publishGroup(session: V2Session, lines: readonly GroupLine[], acceptance?: Parameters<WorkspaceV2Store['publishGroupResults']>[4]) {
    const saved = store.groupResultsChecked(session.id)
    const scanned = groupScanned.get(session.id)
    const from = Math.max(saved ?? 0, scanned ?? 0)
    const last = lines.at(-1)?.seq ?? from
    if (last <= from && !acceptance) {
      groupMemberLearning(session, lines)
      return
    }
    const since = saved === undefined && scanned === undefined ? (now?.() ?? new Date()).getTime() - GROUP_RESULTS_SINCE_MS : undefined
    const orders = new Set(store.view(session.workspaceId).orders.filter(order => order.sessionId === session.id).map(order => order.id))
    let oldVersions: Map<string, string> | undefined
    let base: string | undefined
    try { base = realpathSync(groups!.workDir(session)) } catch { base = undefined }
    const rows: GroupResultLine[] = lines.flatMap(line => line.seq > from && (since === undefined || Date.parse(line.at) >= since)
      && (line.kind === 'message' || line.kind === 'progress') && line.ref === undefined && line.speakerId !== OWNER_ID && line.speakerId !== HOST_ID
      && line.workOrderId !== undefined && orders.has(line.workOrderId) ? [{seq: line.seq, at: line.at, text: line.text, orderId: line.workOrderId, traceId: line.traceId,
        files: (line.attachments ?? []).flatMap((file, index) => {
          const id = lineId(line.seq) + '-' + index
          const version = file.version ?? (oldVersions ??= groupVersions(session)).get(id)
          const content = version && publishedGroupFile(session, file, version, base)
          return content ? [{id, label: file.name, ...content}] : []
        })}] : [])
    const seen = new Set([...store.resultNotices(), ...store.groupEvidence()].flatMap(row => row.attachments.map(file => row.orderId + ':' + file.version)))
    const results = groupResults(scope, store.workspace(session.workspaceId), session, rows, seen)
    if (results.length) {
      const files = new Map(rows.flatMap(row => row.files.map(file => [fileVersion(file), file] as const)))
      const dir = groups!.paths(session).dir
      for (const ref of results.flatMap(row => row.attachments)) {
        const file = files.get(ref.version)
        if (file) keepGroupFile(dir, file)
      }
    }
    // Only lines that could deliver (files or reports) move the board's mark; plain talk is just remembered here.
    const delivering = rows.some(row => row.files.length) || results.length > 0
    const record = store.publishGroupResults(session.workspaceId, session.id, delivering ? last : saved ?? 0, results, acceptance)
    groupScanned.set(session.id, last)
    groupMemberLearning(session, lines, false, results)
    const published = new Set(store.resultNotices().map(row => row.id))
    for (const result of results) if (published.has(result.id)) learnResult(result)
    return record
  }
  /** A group result's file as it was delivered: its kept copy, or the line's file while it still has that version. */
  function groupResultFile(notice: StoredResult, fileId: string): V2Attachment | undefined {
    const ref = notice.attachments.find(file => file.id === fileId)
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.version) || !groups) return
    const session = store.resultSource(notice)?.session
    if (!session || !roster(session)) return
    const {dir} = groups.paths(session)
    const kept = readKeptGroupFile(dir, ref.version)
    if (kept) return {id: ref.id, label: ref.label, version: ref.version, ...kept}
    const [, seq, index] = /^g-(\d+)-(\d+)$/.exec(fileId) ?? []
    if (!seq || notice.messageId !== lineId(Number(seq))) return
    let line: GroupLine | undefined
    try { line = groups.lines(session, notice.traceId ?? INITIAL_WORKSPACE_TRACE).find(row => row.seq === Number(seq)) } catch { return }
    const file = line?.attachments?.[Number(index)]
    let base: string
    try { base = realpathSync(groups.workDir(session)) } catch { return }
    const read = file && readGroupFile(base, file)
    return read && fileVersion(read) === ref.version ? {id: ref.id, label: ref.label, version: ref.version, ...read} : undefined
  }

  function learningGroupLines(session: V2Session) {
    if (!groups) return []
    const ids = new Map(store.traceState(session).traces.flatMap(trace => groups.lines(session, trace.id)).map(line => [line.seq, line]))
    return [...ids.values()].sort((a, b) => a.seq - b.seq)
  }

  function learningRefsAllowed(workspaceId: string, refs: readonly {id: string; version: number}[] | undefined, staffId?: string, replacementOf?: string) {
    if (!refs?.length) return true
    if (!staff) return false
    const local = [...staff.experienceMemories(workspaceId), ...staff.experienceMemories()]
    const authorized = staff.selectExperience({workspaceId, staffId, task: ''}).authorized
    return refs.every(ref => {
      const memory = local.find(item => item.id === ref.id && (!item.staffId || item.staffId === staffId))
      if (!memory) return false
      if (authorized.some(entry => entry.id === ref.id && entry.version === ref.version)) return true
      if (!replacementOf || memory.workspaceId !== workspaceId) return false
      // Only a file that is itself the replacement can still reference the version it supersedes.
      if (memory.version === ref.version) {
        return memory.status === 'active' && !!memory.premise && replacementOf === artifactSource(memory.premise)
      }
      if (memory.maintenance?.actor !== 'system' || !['revise','expire'].includes(memory.maintenance.action)) return false
      try {
        const prior = staff.experienceVersion(workspaceId, ref.id, ref.version)
        return prior.status === 'active' && !!prior.premise && replacementOf === artifactSource(prior.premise)
      } catch { return false }
    })
  }

  function fileFromResult(result: StoredResult, fileId: string) {
    const ref = result.attachments.find(item => item.id === fileId)
    if (!ref) return
    if (result.messageId?.startsWith('g-')) return groupResultFile(result, fileId)
    try { return notices.attachment(result.id, fileId) } catch { return }
  }

  function artifactEvidence(result: StoredResult, ref: StoredResult['attachments'][number], staffId?: string, file = fileFromResult(result, ref.id)): ExperienceEvidence | undefined {
    if (!file || fileVersion(file) !== ref.version) return
    const quote = file.content.slice(0, 3000).trim()
    if (!quote) return
    const messageId = /^g-\d+-\d+$/.test(ref.id) ? ref.id.slice(0, ref.id.lastIndexOf('-')) : result.messageId
    let traceId = result.traceId
    if (groups && messageId && messageId !== result.messageId) {
      const session = store.resultSource(result)?.session
      if (session && roster(session)) {
        const line = groups.lines(session, traceId ?? INITIAL_WORKSPACE_TRACE).find(row => row.seq === lineSeq(messageId))
        if (line) traceId = line.traceId ?? INITIAL_WORKSPACE_TRACE
      }
    }
    return {kind: 'artifact', id: workspaceFingerprint([result.id, ref.id, ref.version]), resultId: result.id,
      fileId: ref.id, version: ref.version, workspaceId: result.workspaceId, sessionId: result.sessionId,
      orderId: result.orderId, messageId, staffId, traceId, quote}
  }

  function artifactLine(lines: readonly GroupLine[], result: StoredResult, fileId: string) {
    const match = /^g-(\d+)-(\d+)$/.exec(fileId)
    if (!match) return
    const line = lines.find(item => item.seq === Number(match[1]) && item.workOrderId === result.orderId)
    const path = line?.attachments?.[Number(match[2])]?.path
    if (line && path && line.speakerId !== OWNER_ID && line.speakerId !== HOST_ID) return {line, path}
  }

  function artifactSource(evidence: Pick<ExperienceEvidence, 'workspaceId' | 'sessionId' | 'orderId' | 'fileId' | 'version'>) {
    const {workspaceId, sessionId, orderId, fileId, version} = evidence
    return workspaceFingerprint(['artifact-source', workspaceId, sessionId, orderId, fileId, version])
  }

  function resolveLearningOriginals(evidence: ExperienceEvidence, audience: {staffId?: string}): ExperienceEvidence[] {
    const {workspaceId, sessionId, orderId, messageId, staffId, traceId} = evidence
    if (!workspaceId || !sessionId || !orderId || !messageId || staffId && staffId !== audience.staffId) return []
    const groupMember = audience.staffId && evidence.kind === 'group'
      && evidence.id === 'group-member:' + sessionId + ':' + lineSeq(messageId) + ':' + audience.staffId
    if (!groupMember && (evidence.kind !== 'delivery' || !evidence.version)) return []
    const published = store.resultNotices()
    const rows = groupMember ? [...store.groupEvidence(orderId), ...published] : published
    const record = rows.find(row => row.workspaceId === workspaceId && row.sessionId === sessionId && row.orderId === orderId
      && (row.traceId ?? INITIAL_WORKSPACE_TRACE) === (traceId ?? INITIAL_WORKSPACE_TRACE)
      && row.messageId === messageId && (groupMember || (row.id === evidence.id && row.version === evidence.version)))
    if (!record) return []
    return record.attachments.slice(0, 8).flatMap(file => artifactEvidence(record, file, audience.staffId) ?? [])
  }

  // Only the owning workspace can certify an archived source. Identical file versions count once even when forwarded.
  function verifyLearningOriginal(evidence: ExperienceEvidence, audience: {staffId?: string}): VerifiedExperienceOriginal | undefined {
    const {workspaceId, sessionId, orderId, staffId, fileId, traceId} = evidence
    if (!workspaceId || !sessionId || staffId !== audience.staffId || archived(workspaceId) || store.deletedReason(workspaceId, sessionId, orderId)) return
    const session = store.traceBinding(store.session(workspaceId, sessionId), traceId ?? INITIAL_WORKSPACE_TRACE)
    if (orderId && store.delegation(workspaceId, orderId).sessionId !== sessionId) return
    if (evidence.kind === 'tool' || evidence.kind === 'test') {
      if (!roster(session)) {
        const commands = source.execution?.(session, orderId).commands ?? []
        const turnId = evidence.turnId ?? commands.find(row => row.id === evidence.id)?.turnId
        const original = turnId && source.experienceSource?.(session, turnId)
        if (!original || original.staffId !== staffId || !learningRefsAllowed(workspaceId, original.refs, staffId)) return
        return verifyCommandExperience(evidence, commands, staffId)
      }
      if (!groups || !staffId || !evidence.turnId) return
      const line = learningGroupLines(session).find(item => item.speakerId === staffId && item.workOrderId === orderId
        && (item.traceId ?? INITIAL_WORKSPACE_TRACE) === session.traceId
        && item.memberCallId && evidence.turnId!.startsWith(item.memberCallId + '.') && item.memberCompleted)
      if (!line || !learningRefsAllowed(workspaceId, line.experienceRefs, staffId)) return
      return verifyCommandExperience(evidence, readCommandLog(join(groups.paths(session, session.traceId).dir,GROUP_COMMANDS_FILE), orderId ?? null).commands, staffId)
    }
    if (evidence.kind !== 'artifact' || !orderId || !fileId) return
    const published = store.resultNotices().filter(entry => entry.orderId === orderId && entry.sessionId === sessionId && entry.workspaceId === workspaceId)
    const eligible = staffId ? [...published, ...store.groupEvidence(orderId)] : published
    const result = eligible.find(entry => entry.id === evidence.resultId && entry.orderId === orderId
      && entry.sessionId === sessionId && entry.workspaceId === workspaceId)
    const ref = result?.attachments.find(file => file.id === fileId && file.version === evidence.version)
    if (!result || !ref) return
    const file = fileFromResult(result, fileId)
    if (!file) return
    const verified = artifactEvidence(result, ref, staffId, file)
    if (!verified || evidence.id !== verified.id || evidence.quote !== verified.quote || evidence.messageId !== verified.messageId ||
      (traceId ?? INITIAL_WORKSPACE_TRACE) !== (verified.traceId ?? INITIAL_WORKSPACE_TRACE)) return
    const origin = workspaceFingerprint(['artifact', file.content.replace(/\r\n/g, '\n').trim()])
    if (!roster(session)) {
      const original = result.requestId && source.experienceSource?.(store.turnTrace(session, result.requestId), result.requestId)
      if (!original || original.staffId !== staffId) return
      const location = source.resultFileIdentity?.(session, fileId)
      const authoritative = result.kind === 'report' && !!location
      const prior = authoritative && published.filter(entry => entry.id !== result.id && entry.kind === 'report' && entry.at < result.at)
        .sort((a,b) => b.at.localeCompare(a.at))
        .flatMap(entry => entry.attachments.filter(candidate => source.resultFileIdentity?.(session, candidate.id) === location))[0]
      const replacementOf = prior && prior.version !== ref.version
        ? artifactSource({...verified, fileId: prior.id, version: prior.version}) : undefined
      if (!learningRefsAllowed(workspaceId, original.refs, staffId, replacementOf)) return
      return {origin, source: artifactSource(verified), replacementOf, authoritative}
    }
    const lines = learningGroupLines(session)
    const attached = artifactLine(lines, result, fileId)
    if (!attached || (staffId && attached.line.speakerId !== staffId)) return
    const publishedLine = lines.find(line => line.seq === lineSeq(result.messageId))
    if (!publishedLine) return
    const final = (entry: StoredResult, line: GroupLine | undefined) => entry.kind === 'report'
      && !!(line?.memberCompleted || /^checkpoint:\d+:final$/.test(entry.requestId ?? ''))
    const authoritative = final(result, publishedLine) && published.some(entry => entry.id === result.id)
    // A completed publication of a new version at the same path supersedes the previous publication.
    const prior = authoritative && published.filter(entry => entry.at <= result.at && final(entry, lines.find(line => line.seq === lineSeq(entry.messageId))))
      .flatMap(entry => entry.attachments.flatMap(file => {
        const previous = artifactLine(lines, entry, file.id)
        return previous && previous.line.seq < attached.line.seq && previous.path === attached.path
          && previous.line.speakerId === attached.line.speakerId ? [{seq: previous.line.seq, file}] : []
      })).sort((a,b) => b.seq - a.seq)[0]
    const replacementOf = prior && prior.file.version !== ref.version
      ? artifactSource({...verified, fileId: prior.file.id, version: prior.file.version}) : undefined
    if (!learningRefsAllowed(workspaceId, attached.line.experienceRefs, staffId, replacementOf)
      || !learningRefsAllowed(workspaceId, publishedLine.experienceRefs, staffId, replacementOf)) return
    return {origin, source: artifactSource(verified), replacementOf, authoritative}
  }
  groups?.attach({
    holdOrderWakes: !!review,
    ...(coordinate && {engage: (session: V2Session, orderId: string | undefined, memberId?: string) => {
      if (!orderId) return memberId === LIAISON_MEMBER_ID ? {} : undefined
      try {
        const order = store.delegation(session.workspaceId, orderId)
        return order.reporting && !orderEnded(order) && !order.paused ? {generation: order.generation} : undefined
      } catch { return undefined }
    }}),
    admit: (session, call) => admitCall(session, call),
    onEffects: (session, effects, engine) => groupEffects(session, effects, engine),
    onChange: (session, engine) => groupChanged(session, engine),
  })

  /** Post the liaison's hand-overs and supplements that are not in their group yet (once each, by request id). */
  const posting = new Set<string>()
  async function postGroupStarts(sessionId?: string) {
    for (const start of store.pendingGroupStarts(sessionId)) {
      if (posting.has(start.requestId)) continue
      posting.add(start.requestId)
      try { await postGroupStart(start) } catch { /* posted again on the next start */ } finally { posting.delete(start.requestId) }
    }
  }
  async function postGroupStart(start: GroupStart) {
    const session = store.session(start.workspaceId, start.sessionId)
    const engine = await groupEngine(session)
    store.session(start.workspaceId, start.sessionId)
    if (engine.traceId !== store.assertActiveTrace(session) || !store.pendingGroupStarts(session.id).some(row => row.requestId === start.requestId)) return
    const order = store.delegation(start.workspaceId, start.orderId)
    const coordinated = !!coordinate && !!order.reporting
    if ((coordinated || !engine.ledger.byRef(start.requestId)) && !orderEnded(order) && !order.paused &&
      (start.generation === undefined || start.generation === order.generation)) {
      grantGroupFiles(session, order.id, start.inputAttachments)
      engine.refreshMembers()
      const named = start.staffId ? engine.members().find(member => member.id === start.staffId)?.name : undefined
      // Preserve the named owner recipient and original input with the same durable dispatch path as later handoffs.
      if (coordinated) {
        const members = named && start.staffId ? [start.staffId] : [LIAISON_MEMBER_ID]
        const text = (named ? '@' + named + ' ' : '') + start.handoff
        engine.dispatchEngagement(start.requestId, members, text, order.id, {original: start.original, inputAttachments: start.inputAttachments})
      } else engine.liaisonSay((named ? '@' + named + ' ' : '') + start.handoff, {workOrderId: order.id, ref: start.requestId, onBehalfOfOwner: true, inputAttachments: start.inputAttachments,
        ...start.original !== undefined && {quote: {label: ORIGINAL_LABEL, text: start.original}},
        ...!named && {callAdmin: start.kind === 'follow' ? '主人在「一句话交办」补充了这张工单的要求：转给在做的人，或按分工 @ 对应的成员'
          : '主人在「一句话交办」交给你这张工单：能直接答就答，需要动手的按成员分工 @ 对应的人派活'}})
    }
    store.groupStartPosted(start.requestId)
  }
  /** Held owner words and the liaison's note of a command, into the group once each. */
  function postGroupCommand(session: V2Session, engine: GroupEngine, requestId: string) {
    const row = store.unpostedCommands().find(item => item.requestId === requestId)
    if (!row) return
    try {
      grantGroupFiles(session, row.orderId, row.inputAttachments)
      if (!row.ownerMessageId) {
        const line = engine.note({speaker: 'owner', text: row.text, workOrderId: row.orderId, requestId, inputAttachments: row.inputAttachments})
        store.commandPosted(requestId, {ownerMessageId: lineId(line.seq)})
      }
      if (!row.noteMessageId) {
        const line = engine.note({speaker: 'liaison', ref: 'command-' + requestId, workOrderId: row.orderId,
          text: row.outcome === 'completed' ? commandText.completed : commandText.held(row.judged, !!row.scheduled)})
        store.commandPosted(requestId, {noteMessageId: lineId(line.seq)})
      }
    } catch { /* posted again on the next read or start */ }
  }
  // The ledger is the durable return receipt. The board keeps the decision and its pending side effect.
  const engagementScanned = new Map<string, number>()
  const engaging = new Set<string>()
  let engagementTimer: ReturnType<typeof setTimeout> | undefined

  function queueEngagement(session: V2Session, lines: readonly GroupLine[]) {
    const from = engagementScanned.get(session.id) ?? 0
    const last = lines.at(-1)?.seq ?? from
    if (last <= from) return
    const active = store.traceState(session).active
    const jobs = lines.flatMap((line): EngagementJob[] => {
      if (line.seq <= from || !line.engagement || (line.traceId ?? INITIAL_WORKSPACE_TRACE) !== active) return []
      const source = line.engagement
      return [{id: 'handoff-' + workspaceFingerprint([session.id,line.seq]).slice(0, 40), workspaceId: session.workspaceId,
        sessionId: session.id, traceId: active, seq: line.seq, orderId: line.workOrderId, generation: source.generation,
        triggerSeq: source.triggerSeq, turn: line.speakerId === OWNER_ID ? 'owner' : line.speakerId === LIAISON_MEMBER_ID ? 'liaison' : 'member',
        answerTo: source.answerTo, memberId: source.memberId}]
    })
    store.queueEngagement(jobs)
    engagementScanned.set(session.id, last)
  }

  function runEngagement() {
    if (!coordinate || disposed) return
    clearTimeout(engagementTimer)
    engagementTimer = undefined
    const at = now?.() ?? new Date()
    let deadline: number | undefined
    for (const job of store.pendingEngagement()) {
      if (engaging.has(job.sessionId) || archived(job.workspaceId)) continue
      const due = job.until && Date.parse(job.until)
      if (typeof due === 'number' && due > +at) { deadline = Math.min(deadline ?? Infinity, due); continue }
      engaging.add(job.sessionId)
      void processEngagement(job).then(() => armEngagement(25), () => armEngagement(1000)).finally(() => engaging.delete(job.sessionId))
    }
    if (deadline !== undefined) armEngagement(Math.max(25, deadline - +at))
  }

  function armEngagement(delay: number) {
    if (disposed) return
    clearTimeout(engagementTimer)
    engagementTimer = setTimeout(runEngagement, Math.min(2_147_483_647, delay))
    engagementTimer.unref?.()
  }

  function engagementMessage(session: V2Session, line: GroupLine, evidence: ReadonlyMap<string, StoredResult>, full = true): EngagementMessage {
    const saved = evidence.get(lineId(line.seq))
    const files = full ? (saved ? saved.attachments.flatMap(ref => groupResultFile(saved, ref.id) ?? []) :
      line.attachments?.length ? groupFiles(session, [line]) : []).map(file => ({label: file.label, excerpt: file.content.slice(0, 600)})) :
      saved?.attachments.map(file => ({label: file.label})) ?? []
    return {seq: line.seq, speakerId: line.speakerId, author: line.author, text: line.text,
      ...(line.quote && {text: line.text + '\n〔主人原话〕' + line.quote.text}),
      replyTo: line.replyTo, workOrderId: line.workOrderId, ownerActionId: line.engagement?.answerTo,
      ...files.length && {attachments: files}}
  }

  async function processEngagement(job: EngagementJob) {
    if (!store.engagementActive(job.id)) { store.closeEngagement(job.id); return }
    const session = store.session(job.workspaceId, job.sessionId)
    const engine = await groupEngine(session)
    if (!store.engagementActive(job.id)) { store.closeEngagement(job.id); return }
    const line = engine.ledger.get(job.seq)
    if (!line) { store.closeEngagement(job.id); return }
    const triggerSeq = job.triggerSeq ?? job.seq
    let routed = job
    if (!job.decision) {
      const order = job.orderId && store.delegation(session.workspaceId, job.orderId)
      const original = order && (order.hasOriginal ? store.orderOriginal(session.workspaceId, order.id).text : order.promise)
      // Members' results built on their own staff experience are readable; what stays unreadable becomes a host note.
      const {lines: history, gaps} = engine.projectLiaisonGaps(engine.ledger.all().filter(row => row.kind !== 'progress' &&
        (row.workOrderId === job.orderId || row.seq === job.triggerSeq)), triggerSeq, job.orderId)
      const visibleLine = history.find(row => row.seq === line.seq)
      const source = visibleLine ?? {...line, text: '（宿主说明）这条发言依据的经验已停用、已更新或无法核对，接口人不能读取原文。这不是主人能在群里授权解除的限制。',
        attachments: undefined, inputAttachments: undefined, quote: undefined}
      // Re-checked after the model call; the liaison's own lines carry only the versions it may use itself.
      const readableRefs = [...new Map(history.flatMap(row => row.experienceRefs ?? [])
        .map(ref=>[JSON.stringify(ref),ref] as const)).values()]
      const experienceRefs = engine.liaisonExperienceRefs(history, triggerSeq, job.orderId)
      const gapSeqs = new Set(gaps.map(gap => lineId(gap.seq)))
      const evidence = new Map((order ? store.groupEvidence(order.id) : []).filter(row => !gapSeqs.has(row.messageId!)).map(row => [row.messageId!, row]))
      const sourceLine = engagementMessage(session, source, visibleLine ? evidence : new Map())
      const recent = history.slice(-16)
      const earlier = history.slice(0, -16).filter(row => row.seq === job.triggerSeq || order &&
        (row.engagement || row.speakerId === OWNER_ID || row.quote || evidence.has(lineId(row.seq)))).slice(-64)
      const pending = store.ownerActions(session.id, job.orderId)
      // The owner chose this item to answer: the reply settles it, the model only picks the next step.
      const answered = job.turn === 'owner' && job.answerTo ? pending.find(row => row.id === job.answerTo) : undefined
      const activeMembers = engine.workInFlight()
      const latestOwnerSeq = () => engine.ledger.all().findLast(row => row.speakerId === OWNER_ID && row.workOrderId === job.orderId)?.seq
      const ownerSeen = latestOwnerSeq()
      let decision: EngagementDecision
      try {
        const signal = AbortSignal.any([reviews.signal, AbortSignal.timeout(ACCEPTANCE_TIMEOUT_MS)])
        decision = await coordinate!({turn: job.turn, source: sourceLine,
          messages: [...earlier.map(row => engagementMessage(session, row, evidence, false)), ...recent.map(row => engagementMessage(session, row, evidence))],
          ...(order && {order: {id: order.id, title: order.title, promise: order.promise, original: original || order.promise, reporting: order.reporting,
            generation: order.generation, remainingTurns: order.remainingTurns}}),
          pending, activeMembers, ...(order && {deliveredCheckpoints: store.engagementCheckpoints(order.id, order.generation, job.traceId)}),
          members: engine.members().map(({id,name}) => ({id,name})), triggerSeq: job.triggerSeq, now: (now?.() ?? new Date()).toISOString()}, signal)
      } catch {
        if (disposed || !store.engagementActive(job.id)) return
        if (answered) decision = {kind: 'none'}
        else if ((job.attempts ?? 0) < 2) { store.closeEngagement(job.id, undefined, new Date(+(now?.() ?? new Date()) + 10_000).toISOString()); return }
        else decision = {kind: 'wait', reason: '接口人暂时无法核实本轮结果，请在原会话重试或调整交办。'}
      }
      if (disposed || !store.engagementActive(job.id) || (job.turn !== 'owner' && ownerSeen !== latestOwnerSeq())) return
      if (!engine.canUseLiaisonExperience(readableRefs, triggerSeq, job.orderId)) return
      // Only the liaison's own question can repeat an unreadable-result obstacle; the host's quota and loop questions stand.
      const modelAsk = decision.kind === 'ask' ? decision : undefined
      const selected = new Set(engine.members().map(member => member.id))
      const busy = engine.workInFlight().filter(member => member.workOrderId === job.orderId)
      const memberIds = [...new Set(decision.memberIds ?? [])].filter(id => selected.has(id) && !busy.some(member => member.id === id))
      if (decision.kind === 'continue') {
        if (!memberIds.length && busy.length) decision = {kind: 'wait', reason: '等待仍在处理的成员交回结果。', resolved: decision.resolved}
        else if (order && order.remainingTurns < memberIds.length) decision = {kind: 'ask', text: '本单剩余执行轮数不足，是否收窄范围，或先查看已经核实的结果？', resolved: decision.resolved}
        else if (!memberIds.length) decision = {kind: 'wait', reason: '当前没有可接手的成员，请检查工作区成员或重新安排。'}
        else decision = {...decision, memberIds}
      }
      // A reply to an item that has since closed is ordinary owner speech: it settles nothing else.
      const eligible = job.turn === 'owner' ? pending.filter(row => !job.answerTo || row.id === job.answerTo) : []
      decision.resolved = [...new Set(decision.resolved ?? [])].filter(id => eligible.some(row => row.id === id))
      if (decision.resolved.length > 1) decision.resolved = []
      if (answered) {
        decision.resolved = [answered.id]
        // Nothing to wait for on the owner's side once answered: the liaison takes the reply.
        if (decision.kind === 'wait') decision = {kind: 'none', resolved: [answered.id]}
      }
      const answer = eligible.find(row => row.id === decision.resolved?.[0])
      if (job.turn === 'owner' && !answer) decision = {kind: 'none'}
      if (answer?.orderId && decision.kind === 'none' && !store.delegation(session.workspaceId, answer.orderId).remainingTurns) {
        decision = {kind: 'ask', text: '已收到这项答复，本单的执行额度已用完。是否先查看已有成果，或安排新的交办？', resolved: [answer.id]}
      }
      const trigger = job.triggerSeq && engine.ledger.get(job.triggerSeq)
      const proposed = decision.sourceSeq ? engine.ledger.get(decision.sourceSeq) : undefined
      const ownerSource = trigger && trigger.speakerId === OWNER_ID && trigger.requestId ? trigger :
        proposed && proposed.seq === job.triggerSeq && proposed.speakerId === OWNER_ID && proposed.requestId ? proposed : undefined
      const intake = !job.orderId && ownerSource && job.turn === 'liaison' && decision.kind === 'continue' &&
        decision.title && decision.promise ? {source: ownerSource.seq, text: ownerSource.text, title: decision.title.slice(0, 500),
          promise: decision.promise.slice(0, 8000), reporting: decision.reporting ?? 'final' as const} : undefined
      if (decision.kind === 'continue' && !order && !intake && !answer) decision = {kind: 'none'}
      if (decision.kind === 'continue' && order && decision.text &&
        store.repeatedEngagement(order.id, order.generation, decision, line.text, seq => engine.ledger.get(seq)?.text, job.traceId)) {
        decision = {kind: 'ask', text: '已按同一步骤复核两次，仍缺少新的依据。是否调整交付范围，或先查看现有结果？', resolved: decision.resolved}
      }
      if (decision.kind === 'deliver' && decision.final !== false && order && (busy.length || pending.some(row => row.id !== answer?.id))) {
        decision = {kind: 'wait', reason: '等待仍在处理的成员或待回应事项完成。', resolved: decision.resolved}
      }
      if (decision.kind === 'none' && order && job.turn !== 'owner' && !busy.length &&
        !store.engagementCheckpoints(order.id, order.generation, job.traceId).includes('final') && !pending.length) {
        decision = {kind: 'wait', reason: '本轮已有记录，接口人尚未确定下一执行步骤或验收条件。请在原会话补充要求或继续。'}
      }
      // The same unreadable results after the owner already answered: no owner reply can lift them, so the host says so once.
      let gapNote: string | undefined
      if (decision.kind === 'ask' && decision === modelAsk && gaps.length && order) {
        const previousAnswer = store.lastOwnerAnswerSeq(order.id, order.generation, seq => engine.ledger.get(seq)?.speakerId === OWNER_ID)
        const answeredSeq = Math.max(previousAnswer ?? -1, answer ? line.seq : -1)
        const fresh = history.some(row => row.seq > answeredSeq && row.kind === 'message' && !gapSeqs.has(lineId(row.seq)) &&
          ![OWNER_ID, HOST_ID, LIAISON_MEMBER_ID].includes(row.speakerId))
        if (answeredSeq >= 0 && !fresh) {
          gapNote = '（宿主说明）以下成员交回的结果接口人读不到原文，主人在群里答复或授权都无法解除：\n' +
            gaps.map(gap => '- ' + gap.author + '（群消息 #' + gap.seq + '）：' + liaisonGapReason(gap)).join('\n') +
            '\n可以请这些成员不依赖这条经验重新交回，或先汇总可读部分并注明缺失。'
          // An answered item still hands the reply to the liaison, which now reads the host notes in place of the results.
          decision = answer ? {kind: 'none', resolved: [answer.id]} :
            {kind: 'wait', reason: '部分成员成果接口人读不到原文，等待成员重新交回或先汇总可读部分。', resolved: decision.resolved}
        }
      }
      if (gapNote) engine.note({speaker: 'liaison', text: gapNote, workOrderId: job.orderId, ref: job.id + '-gap', experienceRefs: []})
      // The item just answered is settled: asking it again opens a new item.
      const existingQuestion = pending.find(row => row.id !== answer?.id && (row.question === decision.text || lineSeq(row.messageId) === decision.sourceSeq))
      const sameMessage = line.speakerId === LIAISON_MEMBER_ID && decision.text && line.text.includes(decision.text)
      const question = decision.kind === 'ask' && decision.text && !existingQuestion ? sameMessage ? line :
        engine.note({speaker: 'liaison', text: decision.text, workOrderId: job.orderId, ref: job.id + '-question', experienceRefs}) : undefined
      const revised = order && ownerSource && job.turn === 'liaison' ? {reporting: decision.reporting, promise: decision.promise} : undefined
      const recorded = store.recordEngagement(job, {...decision, experienceRefs}, question, intake, answer, revised)
      if (!recorded) return
      if (recorded.generation !== job.generation && job.orderId) engine.stopOrder(job.orderId, '主人更新了交办范围，按新约定继续。')
      routed = recorded
    }
    if (disposed || !store.engagementActive(job.id)) return
    const decision = routed.decision!
    if (!engine.canUseLiaisonExperience(decision.experienceRefs ?? [], triggerSeq, routed.orderId)) {
      store.closeEngagement(job.id)
      return
    }
    const order = routed.orderId && store.delegation(session.workspaceId, routed.orderId)
    const report = decision.kind === 'deliver' ? decision.text : decision.report
    const final = decision.kind === 'deliver' && decision.final !== false
    const checkpoint = final ? 'final' : decision.checkpoint
    const publication = order && report && checkpoint && (final || order.reporting !== 'final')
    let result: StoredResult | undefined
    if (publication) {
      const traceId = engine.traceId ?? INITIAL_WORKSPACE_TRACE
      const id = workspaceFingerprint([scope, session.id, order.id, order.generation, checkpoint, ...traceId === INITIAL_WORKSPACE_TRACE ? [] : [traceId]])
      const cited = new Set(decision.evidenceSeqs ?? [])
      const visible = engine.projectLiaisonHistory(engine.ledger.all(), triggerSeq, order.id)
      const refs = visible.filter(item => item.workOrderId === order.id && item.kind === 'message' && !item.ref &&
        item.speakerId !== OWNER_ID && item.speakerId !== HOST_ID && (cited.size ? cited.has(item.seq) : final && !!item.engagement))
      const index = refs.slice(-30).map(item => '- 群消息 #' + item.seq + ' · ' + item.author)
      const text = index.length ? report + '\n\n**核对记录**\n' + index.join('\n') : report
      const delivered = engine.note({speaker: 'liaison', text, workOrderId: order.id, ref: 'delivery-' + id, experienceRefs:decision.experienceRefs})
      const allowed = new Set(visible.map(item=>lineId(item.seq)))
      const attachments = [...new Map(store.groupEvidence(order.id).filter(row => row.messageId && allowed.has(row.messageId) &&
        (!cited.size || cited.has(lineSeq(row.messageId) ?? 0))).flatMap(row => row.attachments).map(file => [file.version,file])).values()]
      result = {id, workspaceId: session.workspaceId, sessionId: session.id, traceId, orderId: order.id, messageId: lineId(delivered.seq),
        title: final ? '工单回报' : '阶段回报', at: delivered.at, read: false, kind: final ? 'report' : 'partial',
        requestId: 'checkpoint:' + order.generation + ':' + checkpoint, version: workspaceFingerprint([text,attachments]), text, attachments}
    }
    if (decision.kind === 'continue' && decision.text && decision.memberIds?.length) {
      if (store.engagementActive(job.id)) {
        const original = routed.intakeSeq ? engine.ledger.get(routed.intakeSeq) : undefined
        if (original && original.speakerId === OWNER_ID) grantGroupFiles(session, routed.orderId, original.inputAttachments)
        engine.dispatchEngagement(job.id, decision.memberIds, decision.text, routed.orderId, {
          experienceRefs: decision.experienceRefs,
          ...(original?.speakerId === OWNER_ID && {original: original.text, inputAttachments: original.inputAttachments}),
        })
      }
    } else if (job.turn === 'owner' && decision.resolved?.length && decision.kind === 'none') {
      if (!order || order.remainingTurns) engine.dispatchEngagement(job.id, [LIAISON_MEMBER_ID], '主人已答复待回应事项：' + line.text, routed.orderId, {replyTo: line.seq})
    } else if (job.turn === 'owner' && !decision.resolved?.length && decision.kind === 'none') {
      engine.forwardEngagementOwner(job.id, line)
    } else if (!routed.orderId && job.turn !== 'owner' && decision.kind === 'none' && (line.mentions.length || line.all)) {
      engine.forwardEngagementMember(job.id, line)
    }
    const waitUntil = decision.kind === 'wait' && decision.reviewAt && Date.parse(decision.reviewAt) > +(now?.() ?? new Date()) ? decision.reviewAt : undefined
    if (decision.kind === 'wait' && !order && (!waitUntil || (job.attempts ?? 0) >= 2)) {
      engine.note({speaker: 'liaison', text: decision.reason ?? decision.text ?? '等待依赖更新后继续。', ref: job.id + '-wait', experienceRefs:decision.experienceRefs})
    }
    store.closeEngagement(job.id, result, waitUntil, decision.waitForMember)
    if (result && store.resultNotices().some(row => row.id === result.id)) learnResult(result)
  }

  function recoverGroupLedger() {
    if ((!coordinate && !learning) || !groups || disposed) return
    if (coordinate) store.settleAnsweredReplies()
    const delivered = learning ? [...store.groupEvidence(), ...store.resultNotices()] : []
    for (const session of store.rosterSessions()) {
      if (archived(session.workspaceId)) continue
      try {
        const loaded = groups.loaded(session.id)
        const lines = loaded?.started ? loaded.ledger.all() : groups.lines(session)
        groupMemberLearning(session, lines, true, delivered.filter(result => result.sessionId === session.id))
        if (coordinate && !session.closed) queueEngagement(session, lines)
      } catch { /* the ledger remains available to inspect and retry */ }
    }
    if (coordinate) runEngagement()
  }

  /** Files a group line links (inside the group's working directory), as the liaison reads them for its review. */
  function groupFiles(session: V2Session, lines: readonly GroupLine[]) {
    let base: string | undefined
    try { base = realpathSync(groups!.workDir(session)) } catch { /* archived file versions can still be read */ }
    return lines.flatMap(line => (line.attachments ?? []).flatMap(file => {
      const contents = publishedGroupFile(session, file, file.version, base)
      return contents ? [{id: file.name, label: file.name, ...contents}] : []
    }))
  }
  /** The liaison reviews one order batch of a group: the members' lines of that batch (and their files) against the order. */
  async function groupAccept(row: ReturnType<WorkspaceV2Store['pendingAcceptances']>[number]) {
    let outcome: AcceptanceOutcome
    let engine: GroupEngine | undefined
    try {
      const order = store.delegation(row.workspaceId, row.orderId)
      const session = store.session(row.workspaceId, row.sessionId)
      engine = await groupEngine(session)
      const batch = (row.group?.results ?? []).flatMap(seq => engine!.ledger.get(seq) ?? []).filter(line => line.kind !== 'event' && (line.workOrderId ?? row.orderId) === row.orderId)
      const trigger = batch[0]?.replyTo ?? batch[0]?.seq ?? 0
      const results = engine.projectLiaisonHistory(batch, trigger, row.orderId)
      if (orderEnded(order) || order.paused || order.generation !== row.generation) outcome = {kind: 'skipped', reason: '工单已变更'}
      else if (!results.length || results.length < batch.length) outcome = {kind: 'failed', reason: '本批成果部分来源需要主人核对，未能自动验收'}
      else {
        let original = order.promise
        try { if (order.hasOriginal) original = store.orderOriginal(order.workspaceId, order.id).text } catch { /* the promise stands in */ }
        const messages = groupMessages(session, engine)
        const later = laterOwnerWords(messages, session, order.id, original)
        // What members of this order handed back before this batch (newest kept): already delivered, so not a gap.
        const first = Math.min(...results.map(line => line.seq))
        const history = engine.projectLiaisonHistory(engine.ledger.all().filter(line => line.seq < first && line.kind === 'message' && line.workOrderId === order.id
          && line.speakerId !== OWNER_ID && line.speakerId !== LIAISON_MEMBER_ID && line.speakerId !== HOST_ID), trigger, row.orderId)
        const before = history.map(line => line.author + '：' + line.text.trim().slice(0, 600)).join('\n---\n')
        const earlier = before.length > ORIGINAL_LIMIT ? before.slice(-ORIGINAL_LIMIT) : before
        const evidence = {messages: results.map(line => ({id: lineId(line.seq), role: 'agent' as const, author: line.author, at: line.at, text: line.author + '：' + line.text})),
          attachments: groupFiles(session, results)}
        if (disposed) return
        const verdict = await review!({title: order.title, promise: order.promise, original: original.slice(0, ORIGINAL_LIMIT), ...(later && {later}), ...(earlier && {earlier}),
          results: resultSummary(evidence)}, AbortSignal.any([reviews.signal, AbortSignal.timeout(ACCEPTANCE_TIMEOUT_MS)]))
        const refs = [...history,...results].flatMap(line=>line.experienceRefs ?? [])
        outcome = engine.canUseLiaisonExperience(refs,trigger,row.orderId) ?
          {kind: 'verdict', ...verdict} : {kind:'skipped',reason:'本批成果的经验授权已变更'}
      }
    } catch (error) {
      if (disposed) return
      const timeout = error instanceof Error && error.name === 'TimeoutError'
      outcome = {kind: 'failed', reason: timeout ? '验收超时（' + ACCEPTANCE_TIMEOUT_MS / 1000 + ' 秒）' : error instanceof Error && error.message ? error.message.slice(0, 200) : '验收未完成'}
    }
    if (disposed) return
    const {note} = store.finishAcceptance(row.turnId, outcome)
    learnReview(row, outcome)
    if (outcome.kind === 'failed') {
      try {
        const order = store.delegation(row.workspaceId, row.orderId)
        if (order.acceptance?.turnId === row.turnId && order.acceptance.verdict === 'failed') {
          stalled(row.workspaceId, row.orderId, row.turnId, '的接口人验收没有完成：' + clipped(outcome.reason) + '。打开工单查看成果并决定下一步。')
        }
      } catch { /* the order is gone */ }
      // No verdict to post: the liaison is woken as usual to sum the batch up for the owner.
      if (engine && row.group && !store.deletedReason(row.workspaceId, row.sessionId, row.orderId)) {
        const group = row.group
        try { engine.wakeNow({type: 'wake', memberId: LIAISON_MEMBER_ID, batchId: group.batchId, done: group.done, results: group.results, workOrderId: row.orderId, triggerSeq: group.results.at(-1) ?? 0}) }
        catch { /* the group moved on */ }
      }
    }
    if (note) post(row.turnId)
  }
  /** The verdict of a group batch as the liaison's line: a follow-up @-mentions the members who handed back. */
  async function postGroup(turnId: string) {
    const row = store.acceptance(turnId)
    if (!row?.note || row.posted) return
    const order = store.delegation(row.workspaceId, row.orderId)
    const session = store.session(row.workspaceId, row.sessionId)
    const engine = await groupEngine(session)
    if (store.deletedReason(row.workspaceId, row.sessionId, row.orderId) || store.acceptance(turnId)?.posted || engine.traceId !== store.assertActiveTrace(session)) return
    if (order.acceptance?.awaitingOwner && order.acceptance.turnId === turnId) {
      try { remind?.('workspace-acceptance:' + order.id + ':' + turnId, '接口人验收待你决定：「' + order.title + '」仍有缺口。请在 SuperHub 打开这张工单决定下一步。',
        {workspaceId: order.workspaceId, orderId: order.id}) }
      catch { /* the order page and 「今天」 still show it */ }
    }
    if (row.pass) tell('done', order, turnId, '「' + order.title + '」已完成，接口人验收通过。打开工单查看成果。')
    const originalRows = engine.ledger.all().filter(line => line.workOrderId === row.orderId && line.seq <= Math.max(...row.group?.results ?? []))
    const trigger = originalRows.find(line => line.seq === row.group?.results[0])?.replyTo ?? row.group?.results[0] ?? 0
    const experienceRefs = engine.liaisonExperienceRefs(engine.projectLiaisonHistory(originalRows, trigger, row.orderId), trigger, row.orderId)
    let line: GroupLine
    if (row.followUp === 'group') {
      engine.refreshMembers()
      const names = (row.group?.done ?? []).flatMap(id => engine.members().find(member => member.id === id)?.name ?? [])
      line = engine.liaisonSay((names.length ? names.map(name => '@' + name).join(' ') + ' ' : '') + row.note, {workOrderId: row.orderId, ref: 'acceptance-' + turnId, experienceRefs})
    } else line = engine.note({speaker: 'liaison', text: row.note, workOrderId: row.orderId, ref: 'acceptance-' + turnId, experienceRefs})
    store.acceptancePosted(turnId, lineId(line.seq))
  }
  /** Held words the owner hands on in a group: the line already in the group calls whom it addresses (once, by request). */
  async function forwardGroup(session: V2Session, requestId: string, command: OwnerCommand) {
    const engine = await groupEngine(session)
    store.assertActiveTrace(session, command.traceId ?? INITIAL_WORKSPACE_TRACE)
    const seq = lineSeq(command.ownerMessageId)
    if (seq === undefined) return workspaceError(409, '这句话还没进群，请稍后再试')
    if (store.receipt({id: requestId, key: 'req-' + requestId, hash: command.hash})) return
    store.recordGroupSay({id: requestId, key: 'req-' + requestId, hash: command.hash}, session, command.orderId)
    engine.callOwnerLine(seq)
  }
  /** Execution record of a group (or one of its orders): the gate's decisions and commands of its members. */
  function groupExecution(session: V2Session, orderId?: string) {
    let commands: ReturnType<typeof readCommandLog> = {commands: [], permissions: []}
    try {
      for (const trace of store.traceState(session).traces) {
        const path = join(groups!.paths(session, trace.id).dir, GROUP_COMMANDS_FILE)
        if (!existsSync(path)) continue
        const part = readCommandLog(path, orderId ?? null)
        commands.commands.push(...part.commands)
        commands.permissions.push(...part.permissions)
      }
    } catch { return workspaceError(503, '暂时无法读取执行记录，请稍后重试') }
    const pending = approvals?.pending({workspaceId: session.workspaceId, sessionId: session.id, ...(orderId !== undefined && {orderId})}).filter(currentApproval) ?? []
    return {...commands, runs: [], pending, directory: groupDirectory(session)}
  }
  /** The owner changed the tier of a group's order: one line in the group's execution record. */
  function appendGroupPermission(session: V2Session, orderId: string, change: V2PermissionChange) {
    appendCommandLog(join(groups!.paths(session, store.assertActiveTrace(session)).dir, GROUP_COMMANDS_FILE), {kind: 'permission', id: 'p-' + dialogueKey(orderId, change.at).slice(0, 24), workOrderId: orderId,
      at: change.at, from: change.from, to: change.to, by: 'owner'})
  }
  /** Where a group's members work: the group's own directory, the workspace's, or SuperHub's. */
  function groupDirectory(session: V2Session): V2WorkDirectory {
    if (session.directory) return {source: 'order', path: session.directory}
    const bound = store.workspace(session.workspaceId).projectDirectory
    if (bound) return {source: 'workspace', path: bound}
    let path: string | undefined
    try { path = groups?.paths(session).work } catch { /* shown without a path */ }
    return {source: 'superhub', ...(path && {path})}
  }

  async function dispatch(session: V2Session, mutation: Mutation, text: string, workOrderId: string | undefined, signal: AbortSignal, acceptedStart: boolean, staffToken?:string, dispatched?: () => void, extra: TurnExtra = {}) {
    let failure: unknown
    let outcome: 'sent' | 'unsent' | 'unknown' = 'unsent'
    if (!signal.aborted) {
      try {
        const canStart = () => {
          try { store.assertActiveTrace(session, session.traceId); return !store.deletedReason(session.workspaceId, session.id, workOrderId) }
          catch { return false }
        }
        if (!canStart()) throw Object.assign(new Error('对话版本已更新'), {dispatched: false})
        const context = store.context(session, workOrderId)
        if (staffToken) {
          let valid = false
          try { valid = !!workOrderId && activeMember(session.workspaceId,store.delegation(session.workspaceId,workOrderId).staffId).token === staffToken }
          catch { /* Membership can also have been withdrawn while this order waited. */ }
          if (!valid) throw Object.assign(new Error('幕僚的可见资料已变更，原排队要求已停止，请重新交办。'),{dispatched:false})
        }
        const liaison = store.liaisonTurn(mutation.id)
        await source.send(structuredClone(session), { id: mutation.id, text, context: structuredClone(context), ...(liaison && {liaison}),
          ...(workOrderId ? {workOrderId} : {}), ...(extra.directory && {directory: extra.directory}), ...(extra.merged?.length && {merged: structuredClone(extra.merged)}),
          ...(acceptedStart ? {acceptedStart:true} : {}) }, signal, {dispatched, canStart})
        outcome = 'sent'
      } catch (error) {
        failure = error
        // A transport interruption may have delivered the message. Only the source
        // knows whether dispatch definitely had not begun (e.g. provider unavailable).
        if (outcome !== 'sent') outcome = error && typeof error === 'object' && 'dispatched' in error && error.dispatched === false ? 'unsent' : 'unknown'
      }
    }
    current()
    store.finishTurn(mutation, outcome, outcome === 'unsent' && failure instanceof Error ? failure.message.slice(0, 240) : undefined)
    const deleted = store.deletedReason(session.workspaceId, session.id, workOrderId)
    if (deleted) return workspaceError(410, deleted)
    // The owner waiting on a direct message reads the failure in the reply; work that started on its own is reported here.
    if (workOrderId && !signal.aborted && session.traceId === store.assertActiveTrace(session) && (outcome === 'unknown' || outcome === 'unsent' && acceptedStart)) {
      const detail = failure instanceof Error && failure.message ? clipped(failure.message) : ''
      stalled(session.workspaceId, workOrderId, mutation.id, outcome === 'unknown'
        ? '这一轮执行中断了' + (detail ? '：' + detail : '') + '。打开工单让执行者汇报或继续。'
        : '这一轮没能开始' + (detail ? '：' + detail : '') + '。打开工单重新发起或调整。')
    }
    if (outcome === 'sent') {
      // The dispatch receipt is already durable. The clock retries a failed local notice index separately.
      try { notices.collect(mutation.id) } catch { /* The pending result check stays on this turn. */ }
      return
    }
    if (outcome === 'unknown') return workspaceError(409, UNKNOWN_TURN)
    if (signal.aborted) return workspaceError(409, '工单已变更，这条发言尚未派发')
    return workspaceError(503, failure instanceof Error && failure.message ? failure.message.slice(0, 240) : '会话来源暂不可用，发言尚未派发')
  }

  async function confirmed(session: V2Session, requestId: string) {
    if (!source.confirmed) return false
    const completed = await source.confirmed(structuredClone(session), requestId).catch(() => false)
    current()
    if (completed) store.confirmTurn(session, requestId)
    return completed
  }

  /** Owner words in a busy session: steer them into the running turn, otherwise queue them as the next turn. */
  async function interject(session: V2Session, mutation: Mutation, text: string, requested: unknown, active?: InFlight): Promise<V2Delivery> {
    const workOrderId = store.target(session, requested)
    const staffId = workOrderId && store.delegation(session.workspaceId, workOrderId).staffId
    const staffToken = staffId ? activeMember(session.workspaceId, staffId).token : undefined
    // A turn waiting for its directory has not started: words for the same order join its input, no budget of their own.
    if (active?.waiting && active.workOrderId === workOrderId && store.mergeWaiting(mutation, session, workOrderId, text, active.requestId, staffToken)) {
      try { source.markInterjection?.(structuredClone(session), {id: mutation.id, text, ...(workOrderId && {workOrderId})}, 'queued') }
      catch { /* The receipt and the waiting turn are the record. */ }
      return 'queued'
    }
    // Only the running turn of the same order (or the same general discussion) can take the words.
    const parent = active && !active.waiting && active.workOrderId === workOrderId ? active.requestId : undefined
    store.interject(mutation, session, workOrderId, parent, text, staffToken)
    store.ownerSpoke(session.id, workOrderId)
    const words: V2Interjection = {id: mutation.id, text, ...(workOrderId && {workOrderId})}
    let outcome: V2SteerOutcome = 'rejected'
    if (parent && source.interject) {
      try { outcome = await source.interject(structuredClone(session), parent, words) } catch { outcome = 'rejected' }
      current()
      store.assertActiveTrace(session, session.traceId)
    }
    if (outcome === 'steered') store.steered(mutation.id)
    if (outcome === 'rejected') {
      const queued = queueWords(session, words)
      if (queued.state !== 'queued') return workspaceError(409, queued.reason)
    }
    // A turn that ended meanwhile has already settled `pending` words.
    return deliveryOf(store.interjection(mutation.id)?.state)
  }
  const deliveryOf = (state?: string): V2Delivery => state === 'steered' ? 'steered' : state === 'queued' ? 'queued' : state === 'steering' ? 'pending' : state === 'unknown' ? 'unknown' : 'unsent'
  function queueWords(session: V2Session, words: V2Interjection) {
    const queued = store.queueInterjection(words.id)
    try { source.markInterjection?.(structuredClone(session), words, queued.state === 'queued' ? 'queued' : 'unsent') }
    catch { /* The receipt and the board are the record; the transcript note is best effort. */ }
    if (queued.state === 'queued' && !flights.has(session.id)) {
      const next = store.pendingStarts(session.id)[0]
      if (next) startWork(next)
    }
    return queued
  }
  /** After a turn: words it took are delivered; the rest go to the next turn. */
  function settleWords(session: V2Session, requestId: string) {
    const waiting = store.steering(session.id, requestId)
    if (!waiting.length) return
    let outcomes: {id: string; delivered: boolean}[] = []
    try { outcomes = source.interjections?.(structuredClone(session), requestId) ?? [] } catch { /* treated as not taken */ }
    for (const words of waiting) {
      try {
        if (outcomes.some(row => row.id === words.id && row.delivered)) store.steered(words.id)
        else queueWords(session, words)
      } catch { /* A board write failure leaves the words in `steering`; a restart marks them for review. */ }
    }
  }

  /** Where a coding turn runs and the key of its directory lock. Other sessions never wait for a directory. */
  function placeOf(session: V2Session, workOrderId?: string): {key: string; directory?: string} | undefined {
    if (session.kind !== 'coding') return
    const chosen = store.directoryOf(session.workspaceId, workOrderId)
    // SuperHub's working directories belong to one session, whose turns already run one at a time.
    return chosen?.path ? {key: 'dir:' + directoryKey(chosen.path), directory: chosen.path} : {key: 'superhub:' + scope + ':' + session.id}
  }
  /** What a waiting turn waits for now: the turn that holds the directory (the one recorded when it began to wait otherwise). */
  function waitingView(flight: InFlight): V2DirectoryWait | undefined {
    const ahead = flight.place ? locks.holder(flight.place) : undefined
    if (!ahead || ahead.sessionId === flight.session.id) return flight.waiting
    return {sessionId: ahead.sessionId, ...(ahead.workOrderId && {workOrderId: ahead.workOrderId}), title: ahead.title}
  }
  const titleOf = (session: V2Session, workOrderId?: string) => (workOrderId && store.orderLabel(session.workspaceId, workOrderId)) || session.title
  /** The directory a coding order's next turn uses, as the order page shows it. */
  function directoryView(session: V2Session, orderId?: string): V2WorkDirectory {
    const chosen = store.directoryOf(session.workspaceId, orderId)
    if (chosen) return chosen
    let path: string | undefined
    try { path = source.workDirectory?.(structuredClone(session), orderId) } catch { /* shown without a path */ }
    return {source: 'superhub', ...(path && {path})}
  }

  /**
   * Another turn uses this turn's project directory: nothing is reserved or started. Accepted work keeps its start row
   * (marked waiting, so a restart queues it again in order); new owner words become such a row. The directory is
   * handed over first come, first served; the owner can stop the wait, and pausing or changing the order stops it too.
   */
  function waitForDirectory(session: V2Session, mutation: Mutation, value: string, requested: unknown, workOrderId: string | undefined,
    startGeneration: number | undefined, staffToken: string | undefined, mode: SendMode, spot: {key: string}, holder: DirectoryHolder, fresh: boolean): V2Delivery | undefined {
    const ahead = locks.holder(spot.key)
    const waitingFor: V2DirectoryWait = ahead ? {sessionId: ahead.sessionId, ...(ahead.workOrderId && {workOrderId: ahead.workOrderId}), title: ahead.title}
      : {sessionId: session.id, title: holder.title}
    let resume: () => unknown
    let delivery: V2Delivery | undefined
    const queued = () => {
      const next = store.pendingStarts(session.id)[0]
      return next && startWork(next)
    }
    if (startGeneration !== undefined && store.markWaiting(session.id, mutation.id, waitingFor)) resume = queued
    else if (mode.owner && fresh) {
      store.queueWaiting(mutation, session, workOrderId, value, staffToken, waitingFor)
      store.ownerSpoke(session.id, workOrderId)
      try { source.markInterjection?.(structuredClone(session), {id: mutation.id, text: value, ...(workOrderId && {workOrderId})}, 'queued') }
      catch { /* The receipt and the waiting row are the record. */ }
      resume = queued
      delivery = 'queued'
    } else {
      // Repairs and retries are derived again after a restart; they wait in memory only.
      resume = () => mode.revision ? resumeActiveEdit(session) : send(session, mutation, value, requested, startGeneration, staffToken, mode)
    }
    const controller = new AbortController()
    const settled = Promise.withResolvers<void>()
    const entry: InFlight = {key: mutation.key, requestId: mutation.id, session, ...(workOrderId && {workOrderId}), controller, result: settled.promise,
      waiting: waitingFor, place: spot.key}
    flights.set(session.id, entry)
    const cancel = locks.wait(spot.key, holder, () => {
      if (flights.get(session.id) !== entry || controller.signal.aborted) return
      flights.delete(session.id)
      settled.resolve()
      if (disposed) return
      // The turn takes the directory while it starts (synchronously) or not at all: it may run elsewhere now (the
      // directory changed while it waited) or not run. Returning before it ends lets the lock pass an untaken
      // hand-over on at once instead of keeping this directory for the whole turn.
      void Promise.resolve(resume()).catch(() => {})
    })
    controller.signal.addEventListener('abort', () => {
      cancel()
      if (flights.get(session.id) !== entry) return
      flights.delete(session.id)
      settled.resolve()
      // Other accepted work of the session (an earlier stop removed this turn's row) goes on.
      if (!disposed) queueMicrotask(() => {
        if (disposed || flights.has(session.id)) return
        const next = store.pendingStarts(session.id)[0]
        if (next) startWork(next)
      })
    }, {once: true})
    return delivery
  }

  /**
   * The order's instructions changed (a new generation): its running or waiting turn stops, and owner words queued for
   * the old instructions are noted as not delivered. `starts` are the order's start rows before the change.
   */
  function stopOrderWork(workspaceId: string, orderId: string, starts: AssignmentStart[]) {
    for (const flight of flights.values()) {
      if (flight.session.workspaceId === workspaceId && flight.workOrderId === orderId) flight.controller.abort()
    }
    const order = store.delegation(workspaceId, orderId)
    if (store.deletedReason(workspaceId, order.sessionId)) return
    if (roster(store.session(workspaceId, order.sessionId))) {
      // The group's members stop what they do for this order; its other work goes on.
      const text = order.status === 'done' ? '这张工单已收单，为它进行的工作已叫停。' : order.paused ? '这张工单已暂停，为它进行的工作已叫停。' : '这张工单的指示变了，为它进行的工作已叫停。'
      try { groups?.loaded(order.sessionId)?.stopOrder(orderId, text) } catch { /* nothing was running */ }
      return
    }
    // Queued owner words for the old instructions stop with them.
    const words = [...starts.filter(row => row.kind === 'interject').map(row => ({id: row.requestId, text: row.text})), ...starts.flatMap(row => row.merged ?? [])]
    for (const row of words) {
      try { source.markInterjection?.(store.session(workspaceId, order.sessionId), {...row, workOrderId: orderId}, 'unsent') }
      catch { /* The stopped receipt remains the record. */ }
    }
  }

  /**
   * Owner words on an order are read by the liaison first when they are short and use completion wording. A clear
   * completion finishes the order; unclear words (or no reading) wait for the owner's choice. Neither goes to the
   * executor. Undefined: the words take the usual path (other words, the session discussion, or already dispatched).
   */
  async function ownerCommand(session: V2Session, mutation: Mutation, text: unknown, requested: unknown, refs?: ChatInputAttachment[]) {
    if (!judge || typeof text !== 'string') return
    const past = store.command(mutation)
    if (past) {
      store.delegation(past.workspaceId, past.orderId)
      return {outcome: past.outcome, ...(past.resolved && {resolved: past.resolved.kind})}
    }
    if (store.receipt(mutation) || session.closed || !completionCandidate(text)) return
    let orderId: string | undefined
    try { orderId = store.target(session, requested) } catch { return }
    if (!orderId) return
    const order = store.delegation(session.workspaceId, orderId)
    if (orderEnded(order)) return
    let reading = judging.get(mutation.key)
    if (!reading) {
      let latest: string | undefined
      try { latest = store.resultNotices().filter(row => row.orderId === order.id && row.kind !== 'weekly').sort((a, b) => b.at.localeCompare(a.at))[0]?.text.trim().slice(0, 600) }
      catch { /* read without the latest results */ }
      reading = judgeCommand(judge, {text: text.trim(), title: order.title, promise: order.promise, ...(latest && {latest})}, reviews.signal)
        .finally(() => judging.delete(mutation.key))
      judging.set(mutation.key, reading)
    }
    const {judged, reason} = await reading
    current()
    store.assertActiveTrace(session, session.traceId)
    if (judged === 'other') return
    const starts = store.pendingStarts(session.id).filter(row => row.delegationId === orderId)
    const saved = store.recordCommand(mutation, store.traceBinding(store.session(session.workspaceId, session.id), session.traceId), orderId, text, judged, reason, now?.(), refs)
    if (!saved) return
    if (saved.completed) stopOrderWork(session.workspaceId, orderId, starts)
    postCommand(saved.requestId)
    const command = saved.command
    if (learning && saved.completed) {
      const evidence: ExperienceEvidence = {kind: 'owner-acceptance', id: saved.requestId, workspaceId: session.workspaceId,
        sessionId: session.id, orderId, messageId: command.ownerMessageId, quote: text.slice(0, 1000)}
      try { learning.observe({id: 'owner-acceptance:' + saved.requestId, workspaceId: session.workspaceId, sessionId: session.id,
        orderId, kind: 'owner-accepted', summary: '主人确认结束工单。' + text, evidence: [evidence]}) } catch (error) { learningProblem?.(error) }
    }
    return {outcome: command.outcome, ...(command.resolved && {resolved: command.resolved.kind})}
  }
  /**
   * Held words the owner chose to hand to the executor go out as the owner's own words with their original request:
   * once, since the dispatch is idempotent by that request (a crash before it is retried by `recover`).
   */
  function forwardHeld(requestId: string, command: OwnerCommand) {
    const target = store.session(command.workspaceId, command.sessionId)
    store.assertActiveTrace(target, command.traceId ?? INITIAL_WORKSPACE_TRACE)
    if (roster(target)) return forwardGroup(target, requestId, command).then(() => undefined)
    const original: Mutation = {id: requestId, key: 'req-' + requestId, hash: command.hash}
    return send(store.traceBinding(target, command.traceId ?? INITIAL_WORKSPACE_TRACE), original, command.text, command.orderId, undefined, undefined, {owner: true, wait: false})
  }
  /** The owner's held words, then the liaison's note, into the conversation once each (again after a restart). */
  function postCommand(requestId: string) {
    const row = store.unpostedCommands().find(item => item.requestId === requestId)
    if (!row) return
    let session: V2Session
    try { session = store.traceBinding(store.session(row.workspaceId, row.sessionId), row.traceId ?? INITIAL_WORKSPACE_TRACE) } catch { return }
    if (roster(session)) {
      void groupEngine(session).then(engine => postGroupCommand(session, engine, requestId), () => { /* posted on the next read or start */ })
      return
    }
    try {
      if (!row.ownerMessageId) {
        const ownerMessageId = source.hold?.(session, {id: requestId, text: row.text, workOrderId: row.orderId, at: row.at})
        if (ownerMessageId) store.commandPosted(requestId, {ownerMessageId})
      }
      if (!row.noteMessageId) {
        const noteMessageId = source.note?.(session, {id: 'command-' + requestId, workOrderId: row.orderId,
          text: row.outcome === 'completed' ? commandText.completed : commandText.held(row.judged, !!row.scheduled)})
        if (noteMessageId) store.commandPosted(requestId, {noteMessageId})
      }
    } catch { /* posted again on the next start */ }
  }

  async function send(session: V2Session, mutation: Mutation, value: unknown, requested?: unknown, startGeneration?: number, staffToken?:string,
    mode: SendMode = {}): Promise<V2Delivery | undefined> {
    if (typeof value !== 'string' || !value.trim() || value.length > 64_000) return workspaceError(400, '请填写有效的发言，最多 64000 字')
    if (roster(session)) return workspaceError(409, '群聊的发言不走单人回合，请在群里发言')
    session = {...session, traceId: store.assertActiveTrace(session, session.traceId)}
    const saved = store.receipt(mutation)
    if (saved?.kind === 'turn' && (saved.traceId ?? INITIAL_WORKSPACE_TRACE) !== session.traceId) return workspaceError(409, '这条发言已保存在原对话版本')
    const orderId = typeof requested === 'string' ? requested : saved?.kind === 'turn' ? saved.reserved[0]?.id : saved?.kind === 'interject' ? saved.workOrderId ?? undefined : undefined
    const deleted = store.deletedReason(session.workspaceId, session.id, orderId)
    if (deleted) return workspaceError(410, deleted)
    const active = flights.get(session.id)
    if (saved?.kind === 'follow' && saved.state === 'stopped') return workspaceError(409,'工单授权已变更，这条排队的补充已停止')
    // Queued words are reserved as their own turn when their start row comes up.
    if (saved?.kind === 'interject' && !(startGeneration !== undefined && saved.state === 'queued')) {
      if (saved.state === 'unknown') return workspaceError(409, INTERJECTION_UNKNOWN)
      if (saved.state === 'unsent' || saved.state === 'stopped') return workspaceError(409, saved.reason ?? '这句话没有送达')
      return deliveryOf(saved.state)
    }
    if (saved?.kind === 'turn') {
      if (saved.state === 'sent') return
      if (saved.state === 'unknown' && await confirmed(session, mutation.id)) return
      if (saved.state === 'pending' && active?.key === mutation.key) {
        if (mode.wait !== false) await active.result
        return
      }
      if (saved.state !== 'unsent') return workspaceError(409, UNKNOWN_TURN)
    }
    // The owner is never turned away by a busy conversation: the words join the running turn or wait for the next.
    if (active && session.traceId !== active.session.traceId) return workspaceError(409, '正在结束编辑前的执行，请稍后继续')
    if (mode.owner && !saved && (active || store.pendingStarts(session.id).length)) return interject(session, mutation, value, requested, active)
    if (active) return workspaceError(409, '上一条发言正在处理，请稍候')
    const resumed = saved?.kind === 'turn' && saved.state === 'unsent' && requested === undefined
    const workOrderId = mode.discussion ? undefined : resumed && !saved.reserved.length ? undefined : store.target(session, resumed ? saved.reserved[0]?.id : requested)
    const staffId = workOrderId && store.delegation(session.workspaceId,workOrderId).staffId
    const authorization = staffToken ?? (staffId ? activeMember(session.workspaceId,staffId).token : undefined)
    // One coding turn per project directory: a later turn waits without using budget or starting the tool.
    const spot = placeOf(session, workOrderId)
    const holder: DirectoryHolder = {sessionId: session.id, requestId: mutation.id, ...(workOrderId && {workOrderId}), title: titleOf(session, workOrderId)}
    if (spot && !locks.take(spot.key, holder)) {
      return waitForDirectory(session, mutation, value, requested, workOrderId, startGeneration, authorization, mode, spot, holder, !saved)
    }
    try {
      store.reserve(mutation, session, workOrderId, startGeneration, authorization, !!review)
      if (mode.owner) store.ownerSpoke(session.id, workOrderId)
    } catch (error) {
      if (spot) locks.release(spot.key, mutation.id)
      throw error
    }
    const controller = new AbortController()
    const accepted = Promise.withResolvers<void>()
    const extra: TurnExtra = {...(spot?.directory && {directory: spot.directory}), ...(mode.merged?.length && {merged: mode.merged})}
    // Register the controller before crossing the native dispatch boundary.
    const result = Promise.resolve()
      .then(() => dispatch(session, mutation, value, workOrderId, controller.signal, startGeneration !== undefined, authorization, accepted.resolve, extra))
      .finally(() => {
        flights.delete(session.id)
        if (spot) locks.release(spot.key, mutation.id)
        const currentTrace = !disposed && store.traceState(session).active === session.traceId
        if (currentTrace) settleWords(session, mutation.id)
        if (!disposed) queueMicrotask(() => {
          if (disposed || flights.has(session.id)) return
          if (!currentTrace) { void resumeActiveEdit(session).catch(() => {}); return }
          const next = store.pendingStarts(session.id)[0]
          if (next) startWork(next)
        })
      })
    // A caller that stopped waiting must not leave the turn's outcome unobserved.
    result.catch(() => {})
    flights.set(session.id, { key: mutation.key, requestId: mutation.id, session, workOrderId, controller, result })
    if (mode.wait === false) {
      await Promise.race([accepted.promise, result])
      return
    }
    await result
  }

  /** Review each turn's new results once; a restart picks up reviews that had not answered. */
  function runAcceptances() {
    if (disposed || !review) return
    for (const row of store.pendingAcceptances()) {
      // An archived workspace's reviews wait until it is restored.
      if (reviewing.has(row.turnId) || archived(row.workspaceId)) continue
      reviewing.add(row.turnId)
      void accept(row).catch(() => {}).finally(() => reviewing.delete(row.turnId))
    }
  }
  async function accept(row: ReturnType<WorkspaceV2Store['pendingAcceptances']>[number]) {
    if (row.group) return groupAccept(row)
    let outcome: AcceptanceOutcome
    try {
      const order = store.delegation(row.workspaceId, row.orderId)
      const session = store.session(row.workspaceId, row.sessionId)
      const evidence = source.savedResults?.(store.turnTrace(session, row.turnId), row.turnId)
      if (orderEnded(order) || order.paused || order.generation !== row.generation) outcome = {kind: 'skipped', reason: '工单已变更'}
      else if (!evidence) outcome = {kind: 'failed', reason: '本轮成果暂不可读，未能验收'}
      else {
        let original = order.promise
        try { if (order.hasOriginal) original = store.orderOriginal(order.workspaceId, order.id).text } catch { /* the promise stands in */ }
        // Supplements and the owner's own words since the hand-over can change the terms; they win over the promise.
        let later = ''
        try { later = laterOwnerWords((await source.read(structuredClone(session))).messages, session, order.id, original) } catch { /* reviewed on the terms alone */ }
        if (disposed) return
        let earlier = ''
        try { earlier = earlierResults(store.resultNotices(), order.id, row.turnId) } catch { /* reviewed on this turn alone */ }
        const verdict = await review!({title: order.title, promise: order.promise, original: original.slice(0, ORIGINAL_LIMIT), ...(later && {later}), ...(earlier && {earlier}),
          results: resultSummary(evidence)},
          AbortSignal.any([reviews.signal, AbortSignal.timeout(ACCEPTANCE_TIMEOUT_MS)]))
        outcome = {kind: 'verdict', ...verdict}
      }
    } catch (error) {
      if (disposed) return
      const timeout = error instanceof Error && error.name === 'TimeoutError'
      outcome = {kind: 'failed', reason: timeout ? '验收超时（' + ACCEPTANCE_TIMEOUT_MS / 1000 + ' 秒）' : error instanceof Error && error.message ? error.message.slice(0, 200) : '验收未完成'}
    }
    if (disposed) return
    const {note, followUp} = store.finishAcceptance(row.turnId, outcome)
    learnReview(row, outcome)
    if (outcome.kind === 'failed') {
      // Only a failure the order now shows (not one a newer verdict superseded) is the owner's to know.
      try {
        const order = store.delegation(row.workspaceId, row.orderId)
        if (order.acceptance?.turnId === row.turnId && order.acceptance.verdict === 'failed') {
          stalled(row.workspaceId, row.orderId, row.turnId, '的接口人验收没有完成：' + clipped(outcome.reason) + '。打开工单查看成果并决定下一步。')
        }
      } catch { /* the order is gone */ }
    }
    if (note) post(row.turnId)
    if (followUp && !flights.has(followUp.sessionId)) {
      const next = store.pendingStarts(followUp.sessionId)[0]
      if (next) startWork(next)
    }
  }
  /** Post the liaison's verdict to the conversation once; an order left for the owner also reminds the owner once. */
  function post(turnId: string) {
    const row = store.acceptance(turnId)
    if (!row?.note || row.posted || store.deletedReason(row.workspaceId, row.sessionId, row.orderId)) return
    if (row.group) { void postGroup(turnId).catch(() => { /* posted again on the next start */ }); return }
    if (!source.note) return
    try {
      const order = store.delegation(row.workspaceId, row.orderId)
      if (order.acceptance?.awaitingOwner && order.acceptance.turnId === turnId) {
        try { remind?.('workspace-acceptance:' + order.id + ':' + turnId, '接口人验收待你决定：「' + order.title + '」仍有缺口。请在 SuperHub 打开这张工单决定下一步。',
          {workspaceId: order.workspaceId, orderId: order.id}) }
        catch { /* the order page and 「今天」 still show it */ }
      }
      if (row.pass) tell('done', order, turnId, '「' + order.title + '」已完成，接口人验收通过。打开工单查看成果。')
      const messageId = source.note(store.turnTrace(store.session(row.workspaceId, row.sessionId), turnId), {id: 'acceptance-' + turnId, text: row.note, workOrderId: row.orderId})
      store.acceptancePosted(turnId, messageId || undefined)
    } catch { /* retried on the next start */ }
  }

  async function read(session: V2Session, traceId?: string, includeLate = false): Promise<V2Transcript> {
    if (roster(session)) {
      try { return (await groupTranscript(session, undefined, traceId, includeLate)).transcript }
      catch { return { messages: [], issue: '暂时无法读取这场群聊的发言，请稍后重试' } }
    }
    const selected = store.traceBinding(session, traceId)
    const activeTraceId = store.traceState(session).active
    const historical = selected.traceId !== activeTraceId || !!session.deletedAt
    const project = (transcript: V2Transcript) => ({...transcript, traceId: selected.traceId, activeTraceId,
      messages: store.messageReferences(session, transcript.messages.map(message => {
        const {canEdit, actions, held, ...row} = message
        return {...row, traceId: message.traceId ?? selected.traceId,
          ...!historical && {actions, held, ...canEdit && !session.closed && !archived(session.workspaceId)
            && !store.deletedReason(session.workspaceId, session.id, messageWorkOrder(session, row)) && {canEdit: true}}}
      }))})
    if (historical) {
      try { return project(source.readSnapshot?.(selected, includeLate) ?? await source.read(selected)) }
      catch { return project({messages: [], issue: '暂时无法读取这场会话的历史版本'}) }
    }
    // Held words or a liaison note that did not reach the conversation are posted again before it is read.
    for (const row of store.unpostedCommands()) if (row.workspaceId === session.workspaceId && row.sessionId === session.id) postCommand(row.requestId)
    let transcript: V2Transcript
    try { transcript = await source.read(selected) }
    catch { transcript = { messages: [], issue: '暂时无法读取这场会话的发言，请稍后重试' } }
    current()
    // Owner words the liaison held back and the choices on its messages are the board's record.
    const choices = store.conversationChoices(session)
    if (Object.keys(choices.held).length || Object.keys(choices.actions).length) transcript = {...transcript, messages: transcript.messages.map(message => {
      const held = choices.held[message.id], actions = message.role === 'agent' ? choices.actions[message.id] : undefined
      return held || actions ? {...message, ...(held && {held}), ...(actions && {actions})} : message
    })}
    const retired = new Set(transcript.messages.filter(message => store.isRetiredOrder(messageWorkOrder(session,message))).map(message => message.id))
    if (retired.size) transcript = {...transcript,messages:transcript.messages.flatMap(message => {
      if (retired.has(message.id)) return []
      return [message.replyTo && retired.has(message.replyTo) ? {...message,replyTo:undefined} : message]
    })}
    if (selected.traceId !== store.assertActiveTrace(session)) return read(session, traceId, includeLate)
    const unknown = store.unknownTurns(session.id, selected.traceId)
    if (!unknown.length || (await Promise.all(unknown.map(id => confirmed(selected,id)))).every(Boolean)) return project(transcript)
    return project({ messages: transcript.messages, issue: [transcript.issue, UNKNOWN_TURN].filter(Boolean).map(text => text!.replace(/。+$/, '')).join('。'), complete: false })
  }

  const revising = new Map<string, Promise<string | undefined>>()

  /** The cursor and edited words were saved together. On retry, dispatch only from that durable revision. */
  function resumeActiveEdit(session: V2Session) {
    const state = store.traceState(session)
    const edit = state.traces.find(trace => trace.id === state.active)?.edit
    if (!edit || edit.admitted) return Promise.resolve(edit?.messageId)
    const pending = revising.get(state.active)
    if (pending) return pending
    const resumed = dispatchEdit(session, edit).finally(() => revising.delete(state.active))
    revising.set(state.active, resumed)
    return resumed
  }

  async function dispatchEdit(session: V2Session, edit: WorkspaceDialogueEdit): Promise<string | undefined> {
    current()
    store.assertActiveTrace(session, edit.traceId)
    if (store.session(session.workspaceId, session.id).closed) return
    if (roster(session)) {
      const engine = await groupEngine(session)
      store.assertActiveTrace(session, edit.traceId)
      if (store.session(session.workspaceId, session.id).closed) return
      if (edit.workOrderId) store.delegation(session.workspaceId, edit.workOrderId)
      grantGroupFiles(session, edit.workOrderId, edit.inputAttachments)
      const old = engine.ledger.byRequest(edit.traceId)
      const line = engine.revision(edit.text, edit.traceId, edit.workOrderId, edit.inputAttachments)
      store.finishDialogueEdit(session, edit.traceId, lineId(line.seq))
      if (!old) learnOwnerWords(session, line)
      return lineId(line.seq)
    }
    const target = store.traceBinding(session, edit.traceId)
    const messageId = edit.messageId ?? source.hold?.(target, {id: edit.traceId, text: edit.text, workOrderId: edit.workOrderId})
    if (!messageId) return workspaceError(503, '这场会话没有保存改稿的来源')
    if (!edit.messageId) store.finishDialogueEdit(session, edit.traceId, messageId, false)
    if (flights.has(session.id)) return messageId
    const mutation = assignmentTurn(session.workspaceId, session.id, edit.traceId, edit.text, edit.workOrderId)
    const receipt = store.receipt(mutation)
    if (receipt?.kind === 'turn' && (receipt.state === 'unknown' || receipt.state === 'sent')) {
      store.finishDialogueEdit(session, edit.traceId, messageId)
      return messageId
    }
    await send(target, mutation, edit.text, edit.workOrderId, undefined, undefined, {discussion: !edit.workOrderId, wait: false, revision: true})
    // A wait for the project directory is held in memory. Keep the edit pending until its normal turn receipt exists.
    if (store.receipt(mutation)?.kind === 'turn') store.finishDialogueEdit(session, edit.traceId, messageId)
    return messageId
  }

  async function editDialogue(session: V2Session, mutation: Mutation, anchorId: string, body: Record<string, unknown>) {
    if (body.sessionId !== undefined && body.sessionId !== session.id || typeof body.expectedTraceId !== 'string' || !body.expectedTraceId
      || typeof body.text !== 'string' || body.text.length > 64_000) return workspaceError(400, '请填写有效的修改内容并刷新对话版本')
    const replay = async (prior: WorkspaceDialogueEdit) => {
      const messageId = prior.admitted || prior.traceId !== store.traceState(session).active ? prior.messageId : await resumeActiveEdit(session)
      if (!messageId) return workspaceError(409, '这次编辑已记录，请刷新对话版本')
      return {sessionId: session.id, traceId: prior.traceId, messageId}
    }
    const prior = store.dialogueEditReceipt(session, mutation)
    if (prior) return replay(prior)
    if (session.closed) return workspaceError(409, '这场会话已关闭，重新打开后才可编辑')
    const expected = store.assertActiveTrace(session, body.expectedTraceId)
    const traceId = 'trace-' + randomUUID()
    const edit: WorkspaceDialogueEdit = {sessionId: session.id, traceId, requestId: mutation.id, text: body.text}
    if (roster(session)) {
      const engine = await groupEngine(session)
      const duplicate = store.dialogueEditReceipt(session, mutation)
      if (duplicate) return replay(duplicate)
      store.assertActiveTrace(session, expected)
      const seq = lineSeq(anchorId)
      const line = seq === undefined ? undefined : engine.ledger.get(seq)
      if (!line) return workspaceError(404, '当前对话里没有这条消息')
      if (!editableGroupLine(session, line)) return workspaceError(409, '这条消息缺少可还原的本人发言记录')
      if (!edit.text.trim() && !line.inputAttachments?.length) return workspaceError(400, '发言正文和材料至少保留一项')
      edit.workOrderId = line.workOrderId
      if (line.inputAttachments?.length) {
        if (!inputAttachments) return workspaceError(503, '群聊附件服务暂不可用')
        edit.inputAttachments = inputAttachments.resolve({workspaceId: session.workspaceId, sessionId: session.id, workOrderId: line.workOrderId}, line.inputAttachments.map(file => file.id))
      }
      // Catch up original deliveries before the active view changes. Existing file versions are kept independently.
      publishGroup(session, engine.ledger.all())
      store.startDialogueEdit(session, mutation, expected, anchorId, edit, {beforeSeq: line.seq, frozenThrough: engine.ledger.lastSeq})
      groups?.retire(session.id)
    } else {
      if (!edit.text.trim()) return workspaceError(400, '修改后的发言不能为空')
      if (!source.prepareEdit || !source.canEdit || !source.hold) return workspaceError(409, '这个会话来源暂时无法还原历史发言')
      const transcript = await read(session, expected)
      const duplicate = store.dialogueEditReceipt(session, mutation)
      if (duplicate) return replay(duplicate)
      store.assertActiveTrace(session, expected)
      const index = transcript.messages.findIndex(message => message.id === anchorId)
      const anchor = transcript.messages[index]
      const parent = store.traceBinding(session, expected)
      if (!anchor) return workspaceError(404, '当前对话里没有这条消息')
      if (!source.canEdit(parent, anchor)) return workspaceError(409, '这条消息缺少可还原的本人发言记录')
      edit.workOrderId = messageWorkOrder(session, anchor)
      if (edit.workOrderId) store.delegation(session.workspaceId, edit.workOrderId)
      source.prepareEdit(parent, {...session, traceId}, transcript.messages, index)
      store.startDialogueEdit(session, mutation, expected, anchorId, edit)
      const waiting = flights.get(session.id)
      if (waiting?.waiting) waiting.controller.abort()
    }
    for (const row of approvals?.pending({workspaceId: session.workspaceId, sessionId: session.id}) ?? []) {
      if ((row.traceId ?? INITIAL_WORKSPACE_TRACE) === traceId) continue
      try { approvals!.answer(row.id, false, {workspaceId: session.workspaceId, sessionId: session.id, orderId: row.workOrderId}) }
      catch { /* it ended while the edit was being saved */ }
    }
    const messageId = await resumeActiveEdit(session)
    if (!messageId) return workspaceError(409, '编辑已记录，改稿仍在等待送达')
    return {sessionId: session.id, traceId, messageId}
  }

  async function allOutputSources(base: Omit<OutputSource, 'transcript' | 'fileOf'>): Promise<OutputSource[]> {
    const {session} = base
    return Promise.all(store.traceState(session).traces.map(async trace => {
      if (roster(session)) {
        try {
          const {transcript, engine} = await groupTranscript(session, undefined, trace.id, true)
          const lines = transcript.traceId === transcript.activeTraceId && !session.deletedAt ? engine.ledger.all() : groups!.lines(session, trace.id)
          return {...base, transcript, fileOf: groupFileOf(lines)}
        } catch { return {...base, transcript: {traceId: trace.id, messages: [], issue: '暂时无法读取这场会话的交付来源'}} }
      }
      const transcript = await read(session, trace.id, true)
      const binding = store.traceBinding(session, trace.id)
      return {...base, transcript, fileOf: source.resultFileIdentity ? (id: string) => source.resultFileIdentity!(binding, id) : undefined}
    }))
  }

  async function sessionAttachment(session: V2Session, attachmentId: string, params: URLSearchParams, orderId?: string) {
    const traceId = params.get('trace') ?? undefined, requestedVersion = params.get('version') ?? undefined
    const messageId = params.get('message') ?? undefined
    const state = store.traceState(session)
    let target = traceId ?? state.active
    store.traceBinding(session, target)
    if (requestedVersion !== undefined && !/^[a-f0-9]{64}$/.test(requestedVersion)) return workspaceError(400, '请选择有效的文件版本')
    if (orderId && (!traceId || !messageId || !requestedVersion)) return workspaceError(400, '请提供原交付的消息和文件版本')
    if (roster(session)) {
      if (!groups) return workspaceError(503, '群聊暂不可用，请稍后重试')
      const [, seq, index] = /^g-(\d+)-(\d+)$/.exec(attachmentId) ?? []
      const findLine = (id: string) => groups.lines(session, id).find(row => row.seq === Number(seq))
      let line = seq ? findLine(target) : undefined
      if (!traceId && !line && seq) {
        for (const revision of state.traces.toReversed()) {
          line = findLine(revision.id)
          if (line) { target = line.traceId ?? revision.id; break }
        }
      }
      const file = line?.attachments?.[Number(index)]
      if (!line || !file || messageId && messageId !== lineId(line.seq) || orderId && messageWorkOrder(session, {workOrderId: line.workOrderId, at: line.at}) !== orderId) {
        return workspaceError(404, '会话中没有这份可读的附件')
      }
      const version = file.version ?? groupVersions(session).get(attachmentId)
      if (requestedVersion && requestedVersion !== version || !version && (target !== state.active || traceId !== undefined || session.deletedAt)) {
        return workspaceError(404, '原版本不可用，可查看交付时的原话')
      }
      let base: string | undefined
      try { base = realpathSync(groups.workDir(session)) } catch { /* the archived version is independent of the working copy */ }
      const content = publishedGroupFile(session, file, version, base)
      if (!content) return workspaceError(404, '原版本不可用，可查看交付时的原话')
      return {traceId: target, attachment: {id: attachmentId, label: file.name, ...content, ...version && {version}}}
    }
    const findMessage = async (id: string) => (await read(session, id, true)).messages.find(row => (!messageId || row.id === messageId)
      && (!orderId || messageWorkOrder(session,row) === orderId) && row.attachments?.some(ref => ref.id === attachmentId))
    let allowed = await findMessage(target)
    if (!allowed && !traceId) {
      for (const revision of state.traces.toReversed()) {
        if (revision.id === target) continue
        allowed = await findMessage(revision.id)
        if (allowed) { target = allowed.traceId ?? revision.id; break }
      }
    }
    if (!allowed) return workspaceError(404, '会话中没有这份可读的附件')
    const attachment = await source.attachment(store.traceBinding(session, target), attachmentId).catch(() => workspaceError(503, '暂时无法读取这份会话附件，请稍后重试'))
    current()
    if (!attachment || attachment.id !== attachmentId) return workspaceError(404, '原版本不可用，可查看交付时的原话')
    const version = fileVersion(attachment)
    if (requestedVersion && version !== requestedVersion) return workspaceError(404, '原版本不可用，可查看交付时的原话')
    return {traceId: target, attachment: {...attachment, version}}
  }

  const route: Route = async ({ method, seg: requestPath, url, body, owner }, res) => {
    const seg = requestPath[3] === 'orders' ? requestPath.with(3,'delegations') : requestPath
    if (seg[0] !== 'v2' || seg[1] !== 'workspaces' && seg[1] !== 'notices' && seg[1] !== 'approvals' && seg[1] !== 'staff' && seg[1] !== 'owner-actions') return false
    if (owner !== true) return workspaceError(403, '需要主人权限才能打开工作区')
    current()
    const [, , workspaceId, child, childId, action, attachmentId] = seg
    const queryScope = url.searchParams.get('scope')
    const listing = seg[1] === 'workspaces' && method === 'GET' && seg.length === 2
    const execution = (session: V2Session, orderId?: string) => {
      if (roster(session)) return groupExecution(session, orderId)
      const view = {commands: [] as ReturnType<NonNullable<V2DialogueSource['execution']>>['commands'],
        runs: [] as ReturnType<NonNullable<V2DialogueSource['execution']>>['runs'], permissions: [] as V2PermissionChange[]}
      try {
        if (session.kind === 'coding' && source.execution) for (const trace of store.traceState(session).traces) {
          const part = source.execution(store.traceBinding(session, trace.id), orderId)
          view.commands.push(...part.commands)
          view.runs.push(...part.runs)
          view.permissions.push(...part.permissions ?? [])
        }
      }
      catch { return workspaceError(503, '暂时无法读取执行记录，请稍后重试') }
      const pending = session.kind === 'coding' ? approvals?.pending({workspaceId:session.workspaceId,sessionId:session.id,orderId:orderId ?? null}).filter(currentApproval) ?? [] : []
      return {...view, pending, ...(session.kind === 'coding' && {directory: directoryView(session, orderId)})}
    }
    const decide = (id: string, allow: unknown, where: {workspaceId: string; sessionId?: string; orderId?: string | null}) => {
      if (typeof allow !== 'boolean') return workspaceError(400, '请选择批准或拒绝这条命令')
      const pending = approvals?.pending(where).find(row => row.id === id)
      const expected = body.expectedTraceId
      if (expected !== undefined && typeof expected !== 'string') return workspaceError(400, '请选择有效的对话版本')
      if (pending && expected !== undefined && expected !== (pending.traceId ?? INITIAL_WORKSPACE_TRACE)) return workspaceError(409, '对话版本已更新，请刷新审批')
      const deleted = pending && store.deletedReason(pending.workspaceId, pending.sessionId, pending.workOrderId ?? undefined)
      if (deleted) return workspaceError(410, deleted)
      if (pending && !currentApproval(pending)) return workspaceError(409, '这条命令来自先前的对话记录，请刷新后继续')
      if (!approvals?.answer(id, allow, where)) return workspaceError(409, '这条命令已处理或已过期，请刷新执行记录')
    }
    if ((!listing || queryScope !== null) && queryScope !== scope || body.scope !== undefined && body.scope !== scope) {
      return workspaceError(409, '第二大脑已切换，请重新打开工作区')
    }
    const ok = (data: object) => { json(res, 200, { scope, ...data }); return true }
    if (seg[1] === 'owner-actions') {
      if (method === 'GET' && seg.length === 2) return ok({items: store.ownerActions()})
      if (method === 'POST' && workspaceId && child === 'reply' && seg.length === 4) {
        const action = store.ownerAction(workspaceId, true)
        if (!action) return workspaceError(404, '找不到待回应事项')
        const mutation = mutationKey(seg, body)
        const existing = store.receipt(mutation)
        if (!existing && !store.ownerAction(workspaceId)) return workspaceError(409, '这项待回应已处理，请刷新')
        const session = store.session(action.workspaceId, action.sessionId)
        await groupSay(session, mutation, body.text, action.orderId, undefined, action.id)
        return ok({ok: true})
      }
      return workspaceError(404, '找不到这个待回应操作')
    }
    if (seg[1] === 'staff' || seg[1] === 'workspaces' && child === 'staff') {
      if (!staff || seg.length !== (seg[1] === 'staff' ? 2 : 4)) return workspaceError(404,'找不到幕僚操作')
      const local = seg[1] === 'staff' ? undefined : workspaceId
      const sharedOnly = url.searchParams.get('experience') === 'shared'
      const impact = url.searchParams.get('impact')
      const recipients = url.searchParams.get('recipients') === '1'
      if (sharedOnly && (impact || recipients)) return workspaceError(400,'请选择共同经验操作')
      if (local && method === 'GET' && recipients) {
        return ok({workspaceId:local,members:staff.view(local).members.map(({id,name})=>({id,name}))})
      }
      if (method === 'GET') {
        const memoryId = url.searchParams.get('memory')
        if (memoryId) {
          const version = Number(url.searchParams.get('version'))
          if (!Number.isSafeInteger(version) || version < 1) return workspaceError(400, '请选择有效的经验版本')
          return ok({memory: experienceReferences(staff.experienceVersion(local, memoryId, version, sharedOnly)), timeZone})
        }
        return ok(impact ? {impact:staff.impact(impact,local)} : {...staffReferences(staff.view(local,sharedOnly)), timeZone})
      }
      if (local) store.writable(local)
      if (body.action === 'organize') {
        if (!learning) return workspaceError(503, '经验整理服务暂不可用')
        mutationKey(seg, body)
        const organized = await learning.flush(local, sharedOnly)
        current()
        groups?.refresh(local)
        return ok({...staffReferences(staff.view(local,sharedOnly)), organized, timeZone})
      }
      if (sharedOnly && body.audience !== 'shared') return workspaceError(400,'请从幕僚页面管理专属经验')
      if (['proposed','witnessedToken','evidence','observed','source','discoveredBy','dependencies','actor',
        'supports','supportsComplete','premise','maintenance','conflict','supportCount','experienceExpiresAt'].some(key => body[key] !== undefined)) {
        return workspaceError(400, '从经验页面手动保存时，来源为本人操作；请从原会话登记其他证据')
      }
      if (body.orderId !== undefined) {
        if (!local || typeof body.orderId !== 'string') return workspaceError(400,'请选择本区原工单')
        const order = store.delegation(local,body.orderId)
        if (body.audience !== 'shared' && order.staffId !== body.staffId) return workspaceError(409,'这张工单由其他人负责')
      }
      const {expiresOn, ...operation} = body
      if (canonicalModel && (operation.action === 'create' || operation.action === 'edit') && (operation.model !== undefined || operation.reasoningEffort !== undefined)) {
        const saved = operation.action === 'edit' ? staff.view(local).members.find(member => member.id === operation.staffId) : undefined
        const text = (value: unknown) => value === null ? '' : typeof value === 'string' ? value : workspaceError(400,'请选择有效的模型')
        const {model, effort} = await canonicalModel({...operation.model !== undefined && {model: text(operation.model)},
          ...operation.reasoningEffort !== undefined && {effort: text(operation.reasoningEffort)}}, {model: saved?.model, effort: saved?.reasoningEffort})
          .catch(error => workspaceError(400, error instanceof Error ? error.message : '请选择有效的模型'))
        operation.model = model
        operation.reasoningEffort = effort
      }
      if (expiresOn !== undefined) {
        if (operation.action !== 'learn' && operation.action !== 'revise' && operation.action !== 'restore') {
          return workspaceError(400, '请在编辑或恢复经验时设置有效期')
        }
        operation.experienceExpiresAt = expirationDate(expiresOn)
      }
      const applied = staff.apply(local,operation,sharedOnly)
      // Joining, leaving or a new duty or experience changes who is in the workspace's groups and what they know.
      groups?.refresh(local)
      return ok({...staffReferences(applied), timeZone})
    }
    if (seg[1] === 'notices') {
      const [, , id, command, fileId] = seg
      if (!id && method === 'GET') return ok(notices.list(Number(url.searchParams.get('offset') ?? 0)))
      if (id && seg.length === 3 && method === 'GET') return ok(notices.detail(id))
      if (id && command === 'read' && seg.length === 4 && method === 'POST') return ok({notice:notices.read(id,body)})
      if (id && command === 'attachments' && fileId && seg.length === 5 && method === 'GET') return ok({attachment:notices.attachment(id,fileId)})
      return workspaceError(404,'找不到这项交付提醒操作')
    }
    if (listing) {
      const personalWorkspaceId = store.personalWorkspaceId()
      return ok({ workspaces: store.list(), ...(personalWorkspaceId && {personalWorkspaceId}) })
    }
    if (seg[1] === 'approvals') {
      if (method !== 'GET' || seg.length !== 2) return workspaceError(404,'找不到这项审批操作')
      const spaces = new Map(store.list().map(space => [space.id, space]))
      const rows = (approvals?.pending() ?? []).flatMap(row => {
        const space = spaces.get(row.workspaceId)
        if (!space || !currentApproval(row)) return []
        let order, session
        try { session = store.session(row.workspaceId,row.sessionId); order = row.workOrderId ? store.delegation(row.workspaceId,row.workOrderId) : undefined } catch { return [] }
        let memberName: string | undefined
        if (row.memberId) {
          if (row.memberId === LIAISON_MEMBER_ID) memberName = LIAISON_AUTHOR
          else try { memberName = staff?.context(row.workspaceId, row.memberId).name } catch { memberName = undefined }
        }
        return [{...row, workspaceName:space.name, sessionTitle:session.title, ...(order && {orderTitle:order.title}), ...(memberName && {memberName})}]
      })
      const acceptances = store.awaitingAcceptance().flatMap(order => {
        const space = spaces.get(order.workspaceId)
        return space && order.acceptance ? [{workspaceId:order.workspaceId, workspaceName:space.name, orderId:order.id, orderTitle:order.title,
          at:order.acceptance.at, gaps:order.acceptance.gaps ?? []}] : []
      })
      return ok({approvals:rows, acceptances})
    }

    if (workspaceId && child === 'followup' && seg.length === 4 && method === 'GET') {
      return ok(followup.workspaceView(workspaceId, Number(url.searchParams.get('offset') ?? 0), url.searchParams.get('session') ?? undefined))
    }
    if (workspaceId && child === 'delegations' && childId && action === 'followup' && seg.length === 6) {
      if (method === 'GET') return ok(followup.view(workspaceId, childId))
      if (method === 'POST') {
        store.writable(workspaceId)
        return ok(await followup.apply(workspaceId, childId, body))
      }
    }

    if (method === 'POST') {
      const mutation = mutationKey(seg, body)
      if (!workspaceId) return ok(store.createWorkspace(mutation, body))
      const workspace = store.workspace(workspaceId)
      if (child === 'archive' && seg.length === 4) return ok(archive(mutation, workspaceId))
      if (child === 'restore' && seg.length === 4) {
        const restored = store.restore(mutation, workspaceId, now?.())
        groups?.refresh(workspaceId)
        // What waited while it was archived (reviews, verdicts and held words not posted yet) goes on now; each is once.
        if (!archived(workspaceId)) {
          for (const row of store.unpostedAcceptances()) if (row.workspaceId === workspaceId) post(row.turnId)
          for (const row of store.unpostedCommands()) if (row.workspaceId === workspaceId) postCommand(row.requestId)
          runAcceptances()
          recoverGroupLedger()
        }
        return ok(restored)
      }
      // Read-only until restored: every other write here is refused, whatever it would change.
      if (workspaceArchived(workspace)) return workspaceError(409, WORKSPACE_ARCHIVED)
      if ((child === 'sessions' || child === 'delegations') && childId && action === 'delete' && seg.length === 6) {
        return ok(remove(mutation, workspaceId, child === 'sessions' ? 'session' : 'order', childId))
      }
      if (child === 'delegations' && seg.length === 4) {
        const member = body.staffId !== undefined ? activeMember(workspaceId,body.staffId) : undefined
        const {delegation: created} = store.createDelegation(mutation, workspace, !coordinate ? body : {...body, reporting: body.reporting ?? 'final'}, member)
        if (roster(store.session(workspaceId, created.sessionId))) void postGroupStarts(created.sessionId)
        else if (member) {
          const next = store.pendingStarts(created.sessionId)[0]
          if (next && !flights.has(created.sessionId)) startWork(next)
        }
        const delegation = shown(created)
        return ok({order:delegation, delegation})
      }
      if (child === 'delegations' && childId && action === 'permission' && seg.length === 6) {
        const before = store.delegation(workspaceId, childId)
        const session = store.session(workspaceId, before.sessionId)
        if (session.kind !== 'coding' && !roster(session)) return workspaceError(409, '只有编程会话或群聊的工单可以设置命令档位')
        const {delegation: changed, change} = store.setPermission(mutation, workspaceId, childId, body, now?.())
        const delegation = shown(changed)
        if (change && roster(session)) {
          try { appendGroupPermission(session, childId, change) } catch { /* the order keeps permissionChangedAt */ }
        } else if (change && source.recordPermission) {
          // The tier itself is saved; a failed log line only loses the history entry.
          try { source.recordPermission(store.traceBinding(session), childId, change) } catch { /* the order keeps permissionChangedAt */ }
        }
        return ok({order:delegation, delegation, permission:(delegation.permission ?? 'full-access') satisfies V2CodingPermission})
      }
      if (child === 'delegations' && childId && action === 'approvals' && attachmentId && seg.length === 7) {
        const order = store.delegation(workspaceId, childId)
        store.session(workspaceId, order.sessionId)
        decide(attachmentId, body.allow, {workspaceId, sessionId:order.sessionId, orderId:order.id})
        return ok({order:shown(order), delegation:shown(order), decided:true})
      }
      if (child === 'delegations' && childId && action === 'action' && seg.length === 6) {
        const order = store.delegation(workspaceId, childId), before = order.generation
        const starts = store.pendingStarts(order.sessionId).filter(row => row.delegationId === childId)
        const result = store.act(mutation, workspaceId, childId, body, now?.())
        const current = store.delegation(workspaceId, childId)
        if (current.generation !== before) stopOrderWork(workspaceId, childId, starts)
        const delegation = shown(result.delegation)
        return ok({order:delegation, ...result, delegation})
      }
      if (child === 'directory' && seg.length === 4) return ok(store.setDirectory(mutation, workspaceId, body))
      if (child === 'sessions' && seg.length === 4) return ok(store.createSession(mutation, workspaceId, body))
      if (child === 'sessions' && childId && action === 'messages' && attachmentId && seg[7] === 'edit' && seg.length === 8) {
        return ok(await editDialogue(store.session(workspaceId, childId), mutation, attachmentId, body))
      }
      if (child === 'sessions' && childId && action === 'approvals' && attachmentId && seg.length === 7) {
        const session = store.session(workspaceId, childId)
        // A group's cards belong to the members working there, whichever order they work on.
        decide(attachmentId, body.allow, roster(session) ? {workspaceId, sessionId:session.id} : {workspaceId, sessionId:session.id, orderId:null})
        return ok({session, decided:true})
      }
      if (child === 'sessions' && childId && action === 'messages' && attachmentId && seg[7] === 'forward' && seg.length === 8) {
        // The owner hands held words to the executor: once, with the words' own request (and its budget rules).
        const session = store.session(workspaceId, childId)
        const {requestId, command} = store.heldCommand(workspaceId, session.id, attachmentId)
        store.forwardCommand(mutation, workspaceId, session.id, requestId, now?.())
        const delivery = await forwardHeld(requestId, command)
        current()
        return ok({session: store.session(workspaceId, childId), forwarded: true, ...(delivery && {delivery})})
      }
      if (child === 'sessions' && childId && seg.length === 6) {
        const session = store.session(workspaceId, childId)
        if (action === 'close' || action === 'reopen') {
          const closed = action === 'close'
          const result = store.setSessionClosed(mutation, workspaceId, session.id, closed)
          if (coordinate && roster(session) && session.closed !== closed) {
            if (closed) {
              groups?.loaded(session.id)?.stop()
              store.stopEngagement(session.id)
            } else recoverGroupLedger()
          }
          return ok(result)
        }
        if (action === 'stop') {
          if (!roster(session)) return workspaceError(409, '只有群聊可以叫停成员，编程会话请用工单操作')
          const engine = await groupEngine(session)
          const memberId = body.memberId
          if (memberId !== undefined && (typeof memberId !== 'string' || !engine.members().some(member => member.id === memberId))) return workspaceError(400, '请选择本群的成员')
          const before = engine.ledger.lastSeq
          engine.stop(memberId as string | undefined)
          const stopped = store.stopEngagement(session.id, memberId as string | undefined)
          return ok({session: store.session(workspaceId, childId), stopped: stopped || engine.ledger.lastSeq > before, group: groupView(session, engine)})
        }
        if (action === 'stop-waiting') {
          const flight = flights.get(session.id)
          const replay = store.receipt(mutation)?.kind === 'mutation'
          const pendingRow = flight?.waiting ? store.pendingStarts(session.id).find(row => row.requestId === flight.requestId) : undefined
          const result = store.stopWaiting(mutation, workspaceId, session.id, flight?.waiting ? flight.requestId : undefined)
          if (!replay && flight?.waiting) {
            flight.controller.abort()
            // Words that waited with this turn are not delivered.
            const words = [...pendingRow?.kind === 'interject' ? [{id: pendingRow.requestId, text: pendingRow.text}] : [], ...pendingRow?.merged ?? []]
            for (const row of words) {
              try { source.markInterjection?.(structuredClone(session), {...row, ...(pendingRow?.delegationId && {workOrderId: pendingRow.delegationId})}, 'unsent') }
              catch { /* The stopped receipt remains the record. */ }
            }
          }
          return ok({session: result.session, stopped: !replay && !!flight?.waiting})
        }
        if (action === 'messages') {
          if (body.wait !== undefined && body.wait !== false) return workspaceError(400, '请求格式无效')
          if (body.expectedTraceId !== undefined && typeof body.expectedTraceId !== 'string') return workspaceError(400, '请选择有效的对话版本')
          const traceId = store.assertActiveTrace(session, body.expectedTraceId)
          if (body.expectedTraceId === undefined && traceId !== INITIAL_WORKSPACE_TRACE) return workspaceError(409, '对话版本已更新，请刷新后继续')
          const bound = {...session, traceId}
          if (store.traceState(session).traces.some(trace => trace.id === traceId && trace.edit && !trace.edit.admitted)) {
            await resumeActiveEdit(session)
            store.assertActiveTrace(session, traceId)
            if (store.traceState(session).traces.some(trace => trace.id === traceId && trace.edit && !trace.edit.admitted)) {
              return workspaceError(409, '改稿正在等待送达，请稍后继续')
            }
          }
          if (roster(session)) {
            const orderId = store.target(session, body.workOrderId)
            const {inputAttachments: ids, ...original} = body
            let refs: ChatInputAttachment[] = []
            if (ids !== undefined && !(Array.isArray(ids) && ids.length === 0)) {
              if (!inputAttachments) return workspaceError(503, '群聊附件服务暂不可用')
              refs = inputAttachments.resolve({workspaceId, sessionId: session.id, workOrderId: body.workOrderId as string | undefined}, ids)
            }
            const text = refs.length && body.text === undefined ? '' : body.text
            const request = ids === undefined ? mutation : mutationKey(seg, {...original, ...refs.length && {text, inputAttachments: refs.map(({id, name}) => [id, name])}})
            const command = await ownerCommand(bound, request, text, orderId, refs)
            if (command) {
              grantGroupFiles(session, orderId, refs)
              return ok({session: store.session(workspaceId, childId), command})
            }
            return ok(await groupSay(bound, request, text, orderId, refs))
          }
          if (body.inputAttachments !== undefined && !(Array.isArray(body.inputAttachments) && body.inputAttachments.length === 0)) return workspaceError(400, '请在工作区群聊发送附件')
          // The liaison reads words about the order itself first; they never also go to the executor.
          const command = await ownerCommand(bound, mutation, body.text, body.workOrderId)
          if (command) return ok({session: store.session(workspaceId, childId), command})
          // `wait: false`: answer once the words are with the executor (or queued), not when the turn ends.
          const delivery = await send(bound, mutation, body.text, body.workOrderId, undefined, undefined, {owner: true, wait: body.wait !== false})
          current()
          return ok({ session: store.session(workspaceId, childId), ...(delivery && {delivery}) })
        }
      }
    } else if (method === 'GET' && workspaceId) {
      store.workspace(workspaceId)
      // Read-only listing while the owner types; binding stays the POST above.
      if (child === 'directory' && seg.length === 4) return ok(store.suggestDirectories(url.searchParams.get('path') ?? ''))
      // Every order's delivered files together; a conversation that cannot be read is left out and said so.
      if (child === 'outputs' && seg.length === 4) {
        let unavailable = false
        const sources = (await Promise.all(store.outputSources(workspaceId).map(base => allOutputSources(base).catch(() => { unavailable = true; return [] })))).flat()
        unavailable ||= sources.some(row => !!row.transcript.issue && !row.transcript.messages.length)
        current()
        return ok({workspaceId, outputs: workspaceOutputs(sources), ...unavailable && {issue: '有的会话暂时读不到，产物可能不全，请稍后重试'}})
      }
      if (seg.length === 3) {
        const stored = store.view(workspaceId)
        const orders = stored.orders.map(shown)
        const view = {...stored, orders, delegations: orders}
        const sessions = new Map(view.sessions.map(row => [row.id, row]))
        const directories = Object.fromEntries(view.orders.flatMap(order => {
          const session = sessions.get(order.sessionId)
          if (session && roster(session)) return [[order.id, groupDirectory(session)]]
          return session?.kind === 'coding' ? [[order.id, directoryView(session, order.id)]] : []
        }))
        const personalWorkspaceId = store.personalWorkspaceId()
        return ok({...view, directories, ...(personalWorkspaceId && {personalWorkspaceId})})
      }
      if (child === 'delegations' && childId && action === 'original' && seg.length === 6) {
        return ok({workspaceId,orderId:childId,original:store.orderOriginal(workspaceId,childId)})
      }
      if (child === 'delegations' && childId && action === 'outputs' && seg.length === 6) {
        const order = store.delegation(workspaceId,childId)
        const base = store.outputSources(workspaceId, order.id)[0]
        const sources = base ? await allOutputSources(base).catch(() => []) : []
        const outputs = base ? publishedOutputs(base.session, sources.map(row => row.transcript), order.id, (id, trace) =>
          sources.find(row => row.transcript.traceId === trace)?.fileOf?.(id)) : []
        current()
        return ok({workspaceId,delegationId:childId,outputs})
      }
      if (child === 'delegations' && childId && action === 'outputs' && attachmentId && seg.length === 7) {
        const base = store.outputSources(workspaceId, childId)[0]
        if (!base) return workspaceError(404, '没有这张工单的交付记录')
        return ok(await sessionAttachment(base.session, attachmentId, url.searchParams, childId))
      }
      if (child === 'delegations' && childId && action === 'execution' && seg.length === 6) {
        const order = store.delegation(workspaceId,childId)
        const view = execution(store.session(workspaceId,order.sessionId), order.id)
        current()
        return ok({workspaceId,delegationId:childId,...view})
      }
      if (child === 'delegations' && seg.length === 4) return ok({orders:store.view(workspaceId).orders.map(shown)})
      if (child === 'delegations' && childId && seg.length === 5) {
        const order = shown(store.delegation(workspaceId,childId))
        return ok({order,delegation:order})
      }
      if (child === 'sessions' && childId) {
        const session = store.session(workspaceId, childId)
        const trace = url.searchParams.get('trace') ?? undefined
        // Paging (`limit`, `before`, `after`, `around`): one window of the ordered messages; without them, the whole transcript.
        const paging = seg.length === 5 ? pageQuery(url.searchParams) : undefined
        if (seg.length === 5 && roster(session)) {
          const observedAt = Date.now()
          const {transcript, engine} = await groupTranscript(session, paging, trace)
          const portraits = store.speakerPortraits(workspaceId, childId, [...new Set([...[...transcript.messages, ...transcript.pinned ?? []].flatMap(m => m.speakerId ? [m.speakerId] : []),
            ...engine.members().map(member => groupSpeaker(session, member.id))])], staff)
          const group = transcript.traceId === transcript.activeTraceId ? groupView(session, engine) : undefined
          return ok({ ...transcript, session: store.session(workspaceId, childId), portraits, observedAt, ...group && {group},
            ...group?.members.some(member => member.status !== 'idle' && member.status !== 'queued') && {working: true} })
        }
        if (seg.length === 5) {
          const observedAt = Date.now()
          let transcript = await read(session, trace)
          const anchor = paging?.around
          if (trace && transcript.traceId !== transcript.activeTraceId && paging) {
            const cursor = paging.around ?? paging.before ?? paging.after
            if (cursor && !transcript.messages.some(message => message.id === cursor)) transcript = await read(session, trace, true)
          }
          const origin = anchor && transcript.messages.find(message => message.id === anchor)?.traceId
          if (!trace && origin && origin !== transcript.traceId) transcript = await read(session, origin)
          if (!trace && anchor && !transcript.messages.some(message => message.id === anchor)) {
            for (const previous of store.traceState(session).traces.toReversed()) {
              if (previous.id === transcript.traceId) continue
              const historical = await read(session, previous.id, true)
              const source = historical.messages.find(message => message.id === anchor)
              if (source) { transcript = source.traceId && source.traceId !== previous.id ? await read(session, source.traceId, true) : historical; break }
            }
          }
          const window = paging && pageWindow(transcript.messages, message => message.id, paging)
          const messages = window ? window.items : transcript.messages
          const pinned = window ? pinnedOutside(transcript.messages, messages) : []
          const portraits = store.speakerPortraits(workspaceId, childId, [...messages, ...pinned].flatMap(m => m.speakerId ? [m.speakerId] : []),staff)
          const running = flights.get(childId)
          const flight = transcript.traceId === transcript.activeTraceId && running?.session.traceId === transcript.traceId ? running : undefined
          return ok({ ...transcript, messages, ...(window && {page: window.page}), ...(pinned.length && {pinned}), session: store.session(workspaceId, childId), portraits, observedAt, ...(flight && !flight.waiting && {working: true}),
            ...(flight?.waiting && {waiting: waitingView(flight)}) })
        }
        if (seg.length === 6 && action === 'execution') {
          const view = execution(session)
          current()
          return ok({workspaceId,sessionId:session.id,...view})
        }
        if (seg.length === 7 && action === 'attachments' && attachmentId) {
          return ok(await sessionAttachment(session, attachmentId, url.searchParams))
        }
      }
    }
    return workspaceError(404, '找不到这个工作区操作')
  }
  /**
   * The liaison hands the owner's words over. On roster groups there is no executor to choose (`executor` is ignored):
   * the order goes to the focused group or a new one, and the liaison's hand-over is posted there, @-mentioning the staff
   * member the owner named, or calling the liaison member to decide whom to @.
   */
  function assign(sourceId: string, text: string, executor?: V2Executor, selected?: string, selectedSession?: string, brief?:Partial<OrderBrief>, staffId?:string, permission?: V2CodingPermission, handoff?: string, directory?: string, refs?: ChatInputAttachment[], reporting?: EngagementReporting, ownerContext?: LiaisonOrderContext) {
    current()
    const dialogue = ownerContext && store.liaisonDialogue(ownerContext.actionRequestId ?? ownerContext.original.requestId)
    if (dialogue?.liaisonTraceId && liaisonTrace && liaisonTrace() !== dialogue.liaisonTraceId) {
      return workspaceError(409, '接口人对话已续写，请在当前对话重新提出这项交办')
    }
    if (dialogue && liaisonPosts.has(dialogue.ref)) return workspaceError(409, '原问题正在送往会话，请核对送达状态后再继续')
    const grouped = store.rosterGroups
    if (staffId && (!selected || (!grouped && executor && executor !== 'dsh'))) return workspaceError(400,'请从幕僚加入的工作区交办，具名幕僚使用 DSH 受限会话')
    const member = staffId && selected ? activeMember(selected,staffId) : undefined
    const { firstRequestId, ...job } = store.assign(sourceId,text,member && !grouped ? 'dsh' : executor,selected,selectedSession,brief,member,permission,handoff,directory,refs,grouped ? reporting ?? (coordinate ? 'final' : undefined) : undefined,ownerContext)
    if (roster(job.session)) {
      void postGroupStarts(job.session.id)
      return job
    }
    void startWork({workspaceId:job.workspace.id,sessionId:job.session.id,requestId:firstRequestId,text,staffToken:member?.token,delegationId:job.delegation.id,generation:job.delegation.generation})
    return job
  }
  function startWork({workspaceId,sessionId,requestId,text,delegationId:workOrderId,generation,kind,staffToken,hash,merged}:AssignmentStart): Promise<unknown> {
    if (store.deletedReason(workspaceId, sessionId, workOrderId)) return Promise.resolve()
    // Queued owner words keep their own request; liaison work uses its assignment turn.
    const turn = kind === 'interject' && hash ? {id: requestId, key: 'req-' + requestId, hash}
      : assignmentTurn(workspaceId, sessionId, requestId, text, kind === 'follow' ? workOrderId : undefined)
    // The owner can leave the chat immediately. Reservation and dispatch use the
    // same durable turn as the usual session route, including its recovery rules.
    return send(store.session(workspaceId, sessionId), turn, text, workOrderId, generation, staffToken, {discussion: !workOrderId, ...(merged?.length && {merged})}).catch(() => {
      // The session's issue and the delegation's stored reason are the user-facing failure record.
    })
  }
  async function follow(sourceId:string, text:string, workspaceId:string, workOrderId:string, handoff?: string, refs?: ChatInputAttachment[], reporting?: EngagementReporting) {
    current()
    const delegation = store.delegation(workspaceId,workOrderId)
    const session = store.session(workspaceId,delegation.sessionId)
    if (roster(session)) {
      const nextReporting = reporting ?? (coordinate && !delegation.reporting ? 'each' : undefined)
      const state = store.groupFollow(sourceId, text, workspaceId, workOrderId, handoff, refs, nextReporting)
      if (store.delegation(workspaceId, workOrderId).generation !== delegation.generation) groups?.loaded(session.id)?.stopOrder(workOrderId, '主人更新了工单约定，按新约定继续。')
      void postGroupStarts(session.id)
      return {workspace:store.workspace(workspaceId), delegation, session, state}
    }
    if (refs?.length) return workspaceError(409, '请在工作区群聊补充这些材料')
    const state = store.queueFollow(sourceId,text,workspaceId,workOrderId,delegation.staffId ? activeMember(workspaceId,delegation.staffId).token : undefined,handoff)
    if (state === 'queued' && !flights.has(session.id)) {
      const next = store.pendingStarts(session.id)[0]
      if (next) startWork(next)
    }
    return {workspace:store.workspace(workspaceId), delegation, session, state}
  }
  return Object.assign(route, { assign, liaisonDialogue, liaisonDialogueStatus, liaisonDialogueCancel, follow, followup, notices, resolveLearningOriginals, verifyLearningOriginal, recover() {
    if (disposed) return
    if (learning) for (const result of store.resultNotices()) {
      if (!archived(result.workspaceId)) learnResult(result, true)
    }
    // Turns a restart cut off: the owner hears it once, then the board forgets the mark.
    const interrupted = store.interruptedTurns()
    for (const row of interrupted) for (const orderId of row.orderIds) {
      stalled(row.workspaceId, orderId, row.turnId, '的执行在服务重启时中断了，打开工单让执行者汇报或继续。')
    }
    if (interrupted.length) try { store.clearInterrupted(interrupted.map(row => row.turnId)) } catch { /* reminded again (deduplicated) next start */ }
    // Turns that waited for a project directory queue again in their original order, ahead of work that never waited.
    const starts = store.pendingStarts().filter(row => !archived(row.workspaceId))
    const waited = starts.filter(row => row.waitingSince).sort((a, b) => a.waitingSince!.localeCompare(b.waitingSince!))
    for (const start of [...waited, ...starts.filter(row => !row.waitingSince)]) if (!flights.has(start.sessionId)) void startWork(start)
    // An archived workspace takes nothing new: verdicts and held words not posted yet wait until it is restored.
    for (const row of store.unpostedAcceptances()) if (!archived(row.workspaceId)) post(row.turnId)
    for (const row of store.unpostedCommands()) if (!archived(row.workspaceId)) postCommand(row.requestId)
    // The owner chose to hand these words to the executor, but they had not gone out before the restart.
    for (const row of store.unforwardedCommands().filter(row => !archived(row.workspaceId))) void Promise.resolve().then(() => forwardHeld(row.requestId, row)).catch(() => { /* the choice stays open in the conversation */ })
    // Groups with members mid-call (or queued work) start now, so those members are gated and resumed; hand-overs not
    // yet in their group are posted.
    if (groups) void groups.boot().then(async () => {
      if (disposed) return
      await Promise.all([
        postGroupStarts(),
        ...store.pendingLiaisonDialogues().filter(row => !archived(row.workspaceId) && !store.deletedReason(row.workspaceId, row.sessionId))
          .map(dispatchLiaisonDialogue),
      ])
    }).catch(() => { /* retried on the next start */ })
    for (const session of store.pendingDialogueEdits()) void resumeActiveEdit(session).catch(() => { /* the stored edit keeps its request */ })
    runAcceptances()
    recoverGroupLedger()
  }, dispose() {
    disposed = true
    reviews.abort()
    clearTimeout(engagementTimer)
    for (const flight of flights.values()) flight.controller.abort()
  } })
}
