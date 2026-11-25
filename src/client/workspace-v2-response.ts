import type { V2Acceptance, V2Attachment, V2AttachmentRef, V2CommandRecord, V2Decision, V2Delegation, V2ExecutionView, V2Message, V2PendingApproval, V2PermissionChange, V2RunRecord, V2Session, V2SessionView, V2Workspace, V2WorkspaceView, WorkOrderOutput } from '../core/workspace-v2.ts'
import type { MentionSegment } from '../core/mentions.ts'
import { isChatInputAttachment } from '../core/chat-attachments.ts'
import type { GroupDeliveryState, GroupMemberState, GroupMessage, GroupPauseState } from '../dsh/workspace-v2.ts'
import type { Scoped } from './superhub-api.ts'
import type { FollowupView } from '../core/workspace-followup.ts'
import type { V2OrderOriginal } from '../core/workspace-v2.ts'
import { isSpeakerId, isSpeakerPortraits } from '../core/workspace-avatars.ts'
import { CODING_PERMISSIONS, DIRECTORY_SOURCE_LABEL, V2_DELIVERIES, V2_HELD, WORKSPACE_ICONS, type V2DirectorySuggestions, type V2MessageAction, type V2WorkDirectory } from '../core/workspace-v2.ts'

type Row = Record<string, unknown>
/** `personalWorkspaceId`: 「我的交办」, the liaison's default workspace (it cannot be archived); an older host leaves it out. */
type Index = Scoped & { workspaces: V2Workspace[]; personalWorkspaceId?: string }
type FileView = Scoped & { attachment: V2Attachment }
const record = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = (row: Row, ...keys: string[]) => keys.every(key => typeof row[key] === 'string')
const optionalText = (value: unknown) => value === undefined || typeof value === 'string'

function workspace(value: unknown): value is V2Workspace {
  return record(value) && strings(value, 'id', 'name', 'goal', 'owner', 'createdAt')
    && (value.icon === undefined || WORKSPACE_ICONS.some(icon => icon === value.icon))
    && optionalText(value.projectDirectory) && optionalText(value.projectDirectoryChangedAt) && optionalText(value.archivedAt)
}
export function workDirectory(value: unknown): value is V2WorkDirectory {
  return record(value) && Object.hasOwn(DIRECTORY_SOURCE_LABEL, String(value.source)) && optionalText(value.path)
}
function delegation(value: unknown): value is V2Delegation {
  return record(value) && strings(value, 'id', 'workspaceId', 'title', 'owner', 'promise', 'boundary', 'createdAt') && optionalText(value.nextCheckAt)
    && typeof value.status === 'string' && ['accepted', 'active', 'waiting', 'closed', 'done'].includes(value.status)
    && optionalText(value.completedAt) && optionalText(value.completedFrom)
    && (value.completedBy === undefined || value.completedBy === 'owner' || value.completedBy === 'owner-words')
    && (value.hasSchedule === undefined || value.hasSchedule === true)
    && Number.isSafeInteger(value.generation) && Number.isSafeInteger(value.remainingTurns)
    && optionalText(value.reason) && (value.paused === undefined || typeof value.paused === 'boolean')
    && typeof value.sessionId === 'string' && !!value.sessionId
    && (value.historySessionIds === undefined || Array.isArray(value.historySessionIds) && value.historySessionIds.every(id => typeof id === 'string'))
    && optionalText(value.staffId)
    && (value.permission === undefined || tier(value.permission)) && optionalText(value.permissionChangedAt) && optionalText(value.directory)
    && (value.autoFollowUps === undefined || Number.isSafeInteger(value.autoFollowUps)) && (value.acceptance === undefined || acceptance(value.acceptance))
}
function acceptance(value: unknown): value is V2Acceptance {
  return record(value) && ['pass', 'gap', 'failed'].includes(String(value.verdict)) && strings(value, 'at', 'turnId') && optionalText(value.reason)
    && (value.gaps === undefined || Array.isArray(value.gaps) && value.gaps.every(gap => typeof gap === 'string'))
    && (value.awaitingOwner === undefined || value.awaitingOwner === true)
}
const tier = (value: unknown) => CODING_PERMISSIONS.some(item => item === value)
function session(value: unknown): value is V2Session {
  return record(value) && strings(value, 'id', 'workspaceId', 'title', 'createdAt') && typeof value.closed === 'boolean'
    && (value.kind === 'coding' && (value.executor === 'codex' || value.executor === 'claude-code') || value.kind === 'group' && value.executor === 'dsh')
    && Array.isArray(value.delegationIds) && value.delegationIds.every(id => typeof id === 'string')
    && (value.engine === undefined || value.engine === 'roster' && value.kind === 'group') && optionalText(value.directory)
    && (value.legacyMessageOrder === undefined || record(value.legacyMessageOrder) && strings(value.legacyMessageOrder, 'id', 'through'))
}
function decision(value: unknown): value is V2Decision {
  return record(value) && strings(value, 'id', 'workspaceId', 'delegationId', 'text', 'at') && Number.isSafeInteger(value.version)
}
function fileRef(value: unknown): value is V2AttachmentRef {
  return record(value) && strings(value, 'id', 'label')
}
const GROUP_LINE_KINDS = ['message', 'progress', 'event']
const GROUP_MEMBER_KINDS = ['dsh', 'codex', 'claude-code']
const GROUP_STATUSES = ['idle', 'queued', 'speaking', 'working', 'approval', 'missed']
export const GROUP_DELIVERY_OUTCOMES: readonly GroupDeliveryState['outcome'][] = ['started', 'queued', 'steered', 'pending', 'failed']
function groupDelivery(value: unknown): value is GroupDeliveryState {
  return record(value) && typeof value.memberId === 'string' && GROUP_DELIVERY_OUTCOMES.some(outcome => outcome === value.outcome) && optionalText(value.detail)
}
function mentionSegment(value: unknown): value is MentionSegment {
  if (!record(value)) return false
  if (typeof value.text === 'string') return value.memberId === undefined && value.all === undefined
  return typeof value.label === 'string' && (typeof value.memberId === 'string' ? value.all === undefined : value.all === true)
}
/** The extra fields of a roster group's ledger line; an older conversation's messages carry none of them. */
function groupLine(value: Row) {
  return (value.seq === undefined || Number.isSafeInteger(value.seq)) && (value.kind === undefined || GROUP_LINE_KINDS.includes(String(value.kind)))
    && optionalText(value.event) && (value.mentions === undefined || Array.isArray(value.mentions) && value.mentions.every(mentionSegment))
    && (value.deliveries === undefined || (value.role === 'user' || Array.isArray(value.inputAttachments) && value.inputAttachments.length > 0)
      && Array.isArray(value.deliveries) && value.deliveries.every(groupDelivery))
}
function message(value: unknown): value is V2Message {
  return record(value) && strings(value, 'id', 'author', 'at', 'text') && (value.role === 'user' || value.role === 'agent')
    // SuperHub's own lines in a roster group (its faint events) have no speaker at all.
    && optionalText(value.replyTo) && optionalText(value.workOrderId) && (value.speakerId === undefined || isSpeakerId(value.speakerId))
    && groupLine(value)
    && (value.inputAttachments === undefined || Array.isArray(value.inputAttachments) && value.inputAttachments.every(isChatInputAttachment))
    && (value.attachments === undefined || Array.isArray(value.attachments) && value.attachments.every(fileRef))
    && (value.delivery === undefined || V2_DELIVERIES.some(state => state === value.delivery))
    && (value.quote === undefined || record(value.quote) && strings(value.quote, 'label', 'text')) && (value.relayed === undefined || value.relayed === true)
    && (value.held === undefined || V2_HELD.some(state => state === value.held))
    && (value.actions === undefined || Array.isArray(value.actions) && value.actions.every(messageAction))
}
function messageAction(value: unknown): value is V2MessageAction {
  return record(value) && ['complete', 'reopen', 'forward'].includes(String(value.kind)) && typeof value.label === 'string'
    && optionalText(value.messageId) && (value.stopSchedule === undefined || value.stopSchedule === true)
    && (value.done === undefined || record(value.done) && typeof value.done.at === 'string')
}

/** Validate what the UI displays, including the resource identity used to authorize the read. */
export function isWorkspaceIndex(value: Scoped): value is Index {
  return record(value) && Array.isArray(value.workspaces) && value.workspaces.every(workspace) && optionalText(value.personalWorkspaceId)
}
export function isWorkspaceView(value: Scoped, resource: string): value is V2WorkspaceView & { personalWorkspaceId?: string } {
  if (!record(value) || !workspace(value.workspace) || !optionalText(value.personalWorkspaceId)) return false
  const id = value.workspace.id
  return resource.endsWith('/' + encodeURIComponent(id))
    && Array.isArray(value.orders) && value.orders.every(row => delegation(row) && row.workspaceId === id)
    && Array.isArray(value.sessions) && value.sessions.every(row => session(row) && row.workspaceId === id)
    && Array.isArray(value.decisions) && value.decisions.every(row => decision(row) && row.workspaceId === id)
    && (value.directories === undefined || record(value.directories) && Object.values(value.directories).every(workDirectory))
}
/** A roster group's members and what they do, the idle guard's pause (absent when calls flow), and its pending approval cards. */
export interface GroupState { members: GroupMemberState[]; paused?: GroupPauseState; approvals: V2PendingApproval[] }
export type SessionLine = V2Message & Partial<Pick<GroupMessage, 'seq' | 'kind' | 'event' | 'mentions' | 'deliveries'>>
export type SessionView = Omit<V2SessionView, 'messages'> & { messages: SessionLine[]; group?: GroupState }
function groupMember(value: unknown): value is GroupMemberState {
  return record(value) && strings(value, 'id', 'speakerId', 'name') && typeof value.admin === 'boolean'
    && GROUP_MEMBER_KINDS.includes(String(value.kind)) && GROUP_STATUSES.includes(String(value.status)) && Number.isSafeInteger(value.queued)
    && optionalText(value.since) && optionalText(value.note) && optionalText(value.workOrderId) && optionalText(value.duty)
    && (value.tool === undefined || record(value.tool) && strings(value.tool, 'name', 'at') && optionalText(value.tool.detail))
    && (value.progress === undefined || record(value.progress) && strings(value.progress, 'text', 'at'))
}
function groupPause(value: unknown): value is GroupPauseState {
  return record(value) && strings(value, 'reason', 'since') && Number.isSafeInteger(value.parked) && optionalText(value.messageId)
}
function groupState(value: unknown, workspace: string, sessionId: string): value is GroupState {
  return record(value) && Array.isArray(value.members) && value.members.every(groupMember) && (value.paused === undefined || groupPause(value.paused))
    && Array.isArray(value.approvals) && value.approvals.every(row => pendingApproval(row, workspace) && row.sessionId === sessionId)
}
export function isSessionView(value: Scoped, resource: string): value is SessionView {
  return record(value) && session(value.session)
    && (value.group === undefined || groupState(value.group, value.session.workspaceId, value.session.id))
    && resource.endsWith('/' + encodeURIComponent(value.session.workspaceId) + '/sessions/' + encodeURIComponent(value.session.id))
    && Array.isArray(value.messages) && value.messages.every(message) && optionalText(value.issue)
    && (value.observedAt === undefined || Number.isSafeInteger(value.observedAt))
    && (value.portraits === undefined || isSpeakerPortraits(value.portraits))
    && (value.working === undefined || typeof value.working === 'boolean')
    && (value.waiting === undefined || record(value.waiting) && strings(value.waiting, 'sessionId', 'title') && optionalText(value.waiting.workOrderId))
}
export function isAttachmentView(value: Scoped, resource: string): value is FileView {
  if (!record(value) || !record(value.attachment) || !fileRef(value.attachment)) return false
  const file = value.attachment
  return resource.endsWith('/attachments/' + encodeURIComponent(file.id))
    && (file.format === 'html' || file.format === 'markdown' || file.format === 'text') && typeof file.content === 'string'
}

function sameOrderPath(resource: string, workspace: string, order: string, suffix: string) {
  const root = '/v2/workspaces/' + encodeURIComponent(workspace)
  const end = '/' + encodeURIComponent(order) + suffix
  return resource === root + '/orders' + end || resource === root + '/delegations' + end
}

const optionalCode = (value: unknown) => value === undefined || value === null || Number.isSafeInteger(value)
const DECISIONS = ['auto', 'allowed', 'rejected', 'expired', 'reviewer-allowed', 'reviewer-denied', 'gate-unavailable']
function commandRecord(value: unknown, order: string | null): value is V2CommandRecord {
  return record(value) && strings(value, 'id', 'turnId', 'at', 'tool', 'command', 'cwd') && value.workOrderId === order
    && optionalCode(value.exitCode) && optionalText(value.outputTail) && optionalText(value.endedAt)
    && (value.failed === undefined || typeof value.failed === 'boolean') && (value.unfinished === undefined || value.unfinished === true)
    && (value.decision === undefined || DECISIONS.includes(value.decision as string)) && optionalText(value.reason) && optionalText(value.by)
    && (value.tier === undefined || tier(value.tier)) && (value.risk === undefined || value.risk === 'high' || value.risk === 'normal')
    && optionalText(value.memberId) && optionalText(value.memberName)
}
function permissionChange(value: unknown): value is V2PermissionChange {
  return record(value) && typeof value.at === 'string' && tier(value.from) && tier(value.to)
}
export function pendingApproval(value: unknown, workspace?: string, order?: string | null): value is V2PendingApproval {
  return record(value) && strings(value, 'id', 'workspaceId', 'sessionId', 'turnId', 'command', 'cwd', 'reason', 'requestedAt', 'expiresAt')
    // `dsh`: a DSH member of a roster group asked (`memberId` names it).
    && (value.tool === 'codex' || value.tool === 'claude-code' || value.tool === 'dsh') && optionalText(value.memberId)
    && (value.workOrderId === null || typeof value.workOrderId === 'string')
    && (workspace === undefined || value.workspaceId === workspace) && (order === undefined || value.workOrderId === order)
}
function runRecord(value: unknown, order: string | null): value is V2RunRecord {
  return record(value) && typeof value.turnId === 'string' && value.workOrderId === order
    && (value.tool === 'codex' || value.tool === 'claude-code') && typeof value.state === 'string'
    && record(value.process) && optionalCode(value.process.exitCode) && value.process.exitCode !== undefined
    && typeof value.process.stderrTail === 'string' && optionalText(value.process.signal)
    && optionalText(value.startedAt) && optionalText(value.endedAt) && optionalText(value.nativeSessionId) && optionalText(value.cwd)
}
export type ExecutionResponse = Scoped & V2ExecutionView & {workspaceId:string;delegationId?:string;sessionId?:string}
/** An order's record (`…/orders/:d/execution`) or the session discussion's (`…/sessions/:s/execution`). */
export function isExecutionView(value: unknown, resource: string): value is ExecutionResponse {
  if (!record(value) || typeof value.scope !== 'string' || typeof value.workspaceId !== 'string') return false
  const space = value.workspaceId
  let order: string | null
  if (typeof value.delegationId === 'string') {
    order = value.delegationId
    if (!sameOrderPath(resource, space, order, '/execution')) return false
  } else if (typeof value.sessionId === 'string') {
    order = null
    if (resource !== '/v2/workspaces/' + encodeURIComponent(space) + '/sessions/' + encodeURIComponent(value.sessionId) + '/execution') return false
  } else return false
  return Array.isArray(value.commands) && value.commands.every(row => commandRecord(row, order))
    && Array.isArray(value.runs) && value.runs.every(row => runRecord(row, order))
    && (value.permissions === undefined || Array.isArray(value.permissions) && value.permissions.every(permissionChange))
    && (value.pending === undefined || Array.isArray(value.pending) && value.pending.every(row => pendingApproval(row, space, order)))
    && (value.directory === undefined || workDirectory(value.directory))
}
export interface ApprovalListItem extends V2PendingApproval { workspaceName: string; sessionTitle: string; orderTitle?: string; memberName?: string }
/** An order still short after the liaison's one follow-up: the owner decides what happens next. */
export interface AcceptanceDecision { workspaceId: string; workspaceName: string; orderId: string; orderTitle: string; at: string; gaps: string[] }
export function isApprovalList(value: Scoped): value is Scoped & {approvals: ApprovalListItem[]; acceptances?: AcceptanceDecision[]} {
  return record(value) && Array.isArray(value.approvals) && value.approvals.every(row => pendingApproval(row) && record(row)
    && strings(row, 'workspaceName', 'sessionTitle') && optionalText(row.orderTitle) && optionalText(row.memberName))
    && (value.acceptances === undefined || Array.isArray(value.acceptances) && value.acceptances.every(row => record(row)
      && strings(row, 'workspaceId', 'workspaceName', 'orderId', 'orderTitle', 'at') && Array.isArray(row.gaps) && row.gaps.every(gap => typeof gap === 'string')))
}

export function isOrderOriginal(value: unknown, resource: string): value is Scoped & {workspaceId:string;orderId:string;original:V2OrderOriginal} {
  return record(value) && typeof value.scope === 'string' && typeof value.workspaceId === 'string' && typeof value.orderId === 'string'
    && sameOrderPath(resource,value.workspaceId,value.orderId,'/original') && record(value.original)
    && typeof value.original.text === 'string' && typeof value.original.complete === 'boolean'
}

export function isFollowupView(value: unknown, resource: string): value is FollowupView {
  if (!record(value) || typeof value.scope !== 'string' || typeof value.workspaceId !== 'string' || typeof value.orderId !== 'string'
    || !sameOrderPath(resource, value.workspaceId, value.orderId, '/followup')
    || typeof value.timeZone !== 'string' || !value.timeZone || typeof value.currentWeek !== 'string') return false
  const source = (row: unknown) => record(row) && (row.kind === 'session' || row.kind === 'liaison') && strings(row, 'sessionId', 'messageId', 'author', 'at')
  const { commitments, reports, schedule } = value
  return Array.isArray(commitments) && commitments.every(row => record(row) && strings(row, 'id', 'kind', 'quote', 'dueState')
    && ['mine', 'theirs', 'request'].includes(String(row.kind))
    && ['unscheduled', 'upcoming', 'today', 'overdue', 'resolved'].includes(String(row.dueState))
    && typeof row.resolved === 'boolean' && optionalText(row.person) && optionalText(row.dueAt)
    && source(row.source))
    && (schedule === null || record(schedule) && typeof schedule.enabled === 'boolean'
      && typeof schedule.weekday === 'number' && Number.isInteger(schedule.weekday) && schedule.weekday >= 0 && schedule.weekday <= 6
      && typeof schedule.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))
    && Array.isArray(reports) && reports.every(row => record(row) && strings(row, 'id', 'week', 'title', 'markdown', 'createdAt')
      && Array.isArray(row.sources) && row.sources.every(source))
    && (value.reportId === undefined || reports.some(row => row.id === value.reportId))
}

export function isOrderOutputs(value: unknown, resource: string): value is Scoped & {workspaceId: string; delegationId: string; outputs: WorkOrderOutput[]} {
  return record(value) && typeof value.scope === 'string' && typeof value.workspaceId === 'string' && typeof value.delegationId === 'string'
    && sameOrderPath(resource, value.workspaceId, value.delegationId, '/outputs') && Array.isArray(value.outputs)
    && value.outputs.every(row => record(row) && strings(row, 'sessionId', 'messageId') && !!row.sessionId && !!row.messageId
      && fileRef(row.attachment) && !!row.attachment.id && !!row.attachment.label.trim())
}

/** `GET …/:w/directory?path=`: directories to offer while the owner types a project directory. */
export function isDirectorySuggestions(value: unknown): value is Scoped & V2DirectorySuggestions {
  return record(value) && strings(value, 'scope', 'parent', 'home') && typeof value.more === 'boolean' && optionalText(value.issue)
    && Array.isArray(value.entries) && value.entries.every(row => record(row) && strings(row, 'path', 'name') && typeof row.bindable === 'boolean'
      && optionalText(row.reason))
}

export function hasMutationObject(value: Scoped, resource: string) {
  if (!record(value)) return false
  const [, , , workspaceId, collection, objectId] = resource.split('/')
  if (!workspaceId) return workspace(value.workspace)
  // Archive and restore answer with the workspace itself, like a directory change.
  if (collection === 'directory' || collection === 'archive' || collection === 'restore') return workspace(value.workspace) && encodeURIComponent(value.workspace.id) === workspaceId
  const object = collection === 'orders' && delegation(value.order) ? value.order
    : collection === 'delegations' && delegation(value.delegation) ? value.delegation
    : collection === 'sessions' && session(value.session) ? value.session : undefined
  return !!object && encodeURIComponent(object.workspaceId) === workspaceId && (!objectId || encodeURIComponent(object.id) === objectId)
}
