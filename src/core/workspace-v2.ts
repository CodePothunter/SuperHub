import type { EngagementReporting } from './workspace-engagement.ts'
import type { SpeakerPortraits } from './workspace-avatars.ts'
import type { ChatInputAttachment } from './chat-attachments.ts'
import type { SavedOrderResults } from './workspace-notices.ts'

/** Public SuperHub 2.0 objects. Native handles and filesystem paths stay with the source. */
export type V2Executor = 'codex' | 'claude-code' | 'dsh'
export type V2DelegationAction = 'pause' | 'resume' | 'narrow' | 'cancel' | 'complete' | 'reopen'

export const WORKSPACE_ICONS = ['prototype', 'recorder', 'report'] as const
export type WorkspaceIcon = typeof WORKSPACE_ICONS[number]

export interface V2Workspace {
  id: string
  name: string
  goal: string
  owner: string
  createdAt: string
  icon?: WorkspaceIcon
  /**
   * Absolute, resolved project directory where this workspace's Codex and Claude Code orders run by default. Absent: the
   * SuperHub working directory of each session (older workspaces included). A change applies from the next turn.
   */
  projectDirectory?: string
  projectDirectoryChangedAt?: string
  /** Set while the workspace is archived: read-only, out of the everyday views, restorable. Absent (older data): active. */
  archivedAt?: string
}

/** An archived workspace keeps everything but takes no new work until the owner restores it. */
export const workspaceArchived = (workspace: Pick<V2Workspace, 'archivedAt'>) => !!workspace.archivedAt
/** The one refusal every write to an archived workspace returns (409). */
export const WORKSPACE_ARCHIVED = '工作区已归档，请先恢复'

/** Where a coding turn runs: the order's own directory, the workspace default, or SuperHub's working directory. */
export type V2DirectorySource = 'order' | 'workspace' | 'superhub'
export const DIRECTORY_SOURCE_LABEL: Record<V2DirectorySource, string> = { order: '本单指定', workspace: '工作区默认', superhub: 'SuperHub 工作目录' }
/** The directory a coding order's next turn uses. `path` can be absent for SuperHub's directory before it is known. */
export interface V2WorkDirectory { source: V2DirectorySource; path?: string }
/** A directory offered while the owner types a project directory; one that cannot be bound can still be opened. */
export interface V2DirectorySuggestion { path: string; name: string; bindable: boolean; reason?: string }
/**
 * `GET …/:w/directory?path=`: `parent` is the directory listed (empty when the input is no path), `home` what `~` stands
 * for, `more` that entries were cut off, `issue` why nothing could be listed (the input stays editable).
 */
export interface V2DirectorySuggestions { parent: string; home: string; entries: V2DirectorySuggestion[]; more: boolean; issue?: string }
/** A coding turn waits for another turn using the same project directory (`title` names that order or conversation). */
export interface V2DirectoryWait { workOrderId?: string; sessionId: string; title: string }

/** Choose once when the workspace is created or an older board is opened. */
export function defaultWorkspaceIcon(id: string, name: string): WorkspaceIcon {
  switch (name.trim()) {
    case '产品研发': return 'prototype'
    case '客户访谈': return 'recorder'
    case '研究周报': return 'report'
  }
  let hash = 0
  for (const character of id) hash = (Math.imul(31, hash) + character.codePointAt(0)!) >>> 0
  return WORKSPACE_ICONS[hash % WORKSPACE_ICONS.length]!
}

export interface V2Delegation {
  /** Stable identity of a staff member entrusted with this order. */
  staffId?: string
  id: string
  workspaceId: string
  /** The only conversation allowed to advance this work order. */
  sessionId: string
  /** Liaison conversation that opened the order. Lets the owner's next words there refer to it without naming it; never sent to clients. */
  conversationId?: string
  /** Earlier conversations from boards that supported multiple links remain readable. */
  historySessionIds?: string[]
  title: string
  owner: string
  promise: string
  /** When a coordinated order publishes results to its owner. */
  reporting?: EngagementReporting
  /** The authenticated order detail may load the owner's original wording on demand. */
  hasOriginal?: boolean
  /** Older boards can carry a preview hint. New work orders are defined by their promise. */
  deliveryKind?: 'mobile-signup'
  /**
   * Stored: an old default (24 hours after creation) or a time the owner gave; kept but never shown. Views carry the
   * next run of the order's enabled recurring schedule instead, and nothing when there is none.
   */
  nextCheckAt?: string
  /**
   * View only: the order has an enabled recurring schedule (also while paused), so completing it offers to stop the
   * schedule too. Never stored.
   */
  hasSchedule?: true
  /** `done`: the owner said the work is finished (or confirmed it); `closed`: the owner cancelled it. Both end the work. */
  status: 'accepted' | 'active' | 'waiting' | 'closed' | 'done'
  /** Set while `done`: when, whether by a button (`owner`) or the owner's words in the conversation, and those words' request. */
  completedAt?: string
  completedBy?: 'owner' | 'owner-words'
  completedFrom?: string
  /** Set by an explicit owner pause. A running responsibility may otherwise be waiting for follow-up. */
  paused?: boolean
  reason?: string
  boundary: string
  generation: number
  remainingTurns: number
  createdAt: string
  /** Project directory of this order only (absolute, resolved); overrides the workspace default. Coding orders only. */
  directory?: string
  /** Command tier of a coding work order. Absent means full access (older orders included). */
  permission?: V2CodingPermission
  permissionChangedAt?: string
  /** Follow-ups the liaison sent on its own after an acceptance review (at most one until the owner changes the terms). */
  autoFollowUps?: number
  /** Last liaison acceptance review of a turn's results. */
  acceptance?: V2Acceptance
}

/**
 * The liaison checked a turn's results against the order's promise: `pass`, `gap` (missing items in `gaps`), or `failed`
 * (no review: model unavailable, timeout, unreadable answer; `reason` says why). `awaitingOwner`: still short after the
 * one automatic follow-up, the owner decides.
 */
export interface V2Acceptance {
  verdict: 'pass' | 'gap' | 'failed'
  at: string
  turnId: string
  reason?: string
  gaps?: string[]
  awaitingOwner?: true
}
/** A finished (`done`) or cancelled (`closed`) order: no new turns, no budget, no queued work. */
export const orderEnded = (order: Pick<V2Delegation, 'status'>) => order.status === 'closed' || order.status === 'done'

/** Display name of the liaison in an order's conversation. */
export const LIAISON_AUTHOR = '接口人'

export interface V2Decision {
  id: string
  workspaceId: string
  delegationId: string
  text: string
  version: number
  at: string
}

export interface V2Session {
  id: string
  workspaceId: string
  title: string
  kind: 'coding' | 'group'
  executor: V2Executor
  /**
   * `roster`: a group chat on the group engine (members = the liaison as admin + the workspace's staff, a shared ledger,
   * @-mentions). Absent: an older session on its old path (a temporary-lead group or a coding session), read as before.
   */
  engine?: 'roster'
  /**
   * Roster groups opened for an order with its own project directory (absolute, resolved): the members work there.
   * Absent: the workspace's project directory, else the group's SuperHub working directory.
   */
  directory?: string
  delegationIds: string[]
  /** Some pre-migration messages were shared by multiple work orders. */
  sharedHistory?: boolean
  /** Original single-order binding and the end of the unlabelled historical data. */
  legacyMessageOrder?: { id: string; through: string }
  closed: boolean
  createdAt: string
}

export interface V2AttachmentRef { id: string; label: string }
export interface V2OrderOriginal { text: string; complete: boolean }
export interface WorkOrderOutput { sessionId: string; messageId: string; attachment: V2AttachmentRef }
/**
 * One delivered file across a workspace's orders (`GET …/:w/outputs`), listed once however many orders or lines linked it.
 * `key` is stable and never the file path. `sessionId`, `messageId` and `attachment` are its latest reference (what opens
 * when the owner reads it); `orders` are the orders that delivered it, latest first; `deliveredBy` the speakers who linked it.
 */
export interface WorkspaceOutput extends WorkOrderOutput {
  key: string
  label: string
  at: string
  orders: { id: string; title: string }[]
  deliveredBy: { id: string; name: string }[]
}
export interface V2Attachment extends V2AttachmentRef { format: 'markdown' | 'text' | 'html'; content: string }
export interface V2Message {
  id: string
  role: 'user' | 'agent'
  author: string
  /** Absent for historical messages that carry only a display name. */
  speakerId?: string
  at: string
  text: string
  workOrderId?: string
  replyTo?: string
  attachments?: V2AttachmentRef[]
  /** Materials the owner supplied with this message or the liaison relayed to this order. */
  inputAttachments?: ChatInputAttachment[]
  /**
   * Owner words sent while the executor was working: taken into that running turn (`steered`), still waiting for the
   * executor to take them (`pending`), moved to the next turn (`queued`), not delivered (`unsent`), or left uncertain by
   * a restart (`unknown`). Absent for ordinary turns.
   */
  delivery?: V2Delivery
  /** Words the liaison relays with its own message, shown collapsed (the owner's original wording). */
  quote?: { label: string; text: string }
  /** Owner words an older liaison hand-over put into the conversation as they were (before the liaison spoke itself). */
  relayed?: true
  /**
   * Owner words the liaison read as being about the order itself and held back from the executor: waiting for the
   * owner's choice (`choosing`), taken as completing the order (`completed`), or left unsent (`kept`).
   */
  held?: V2Held
  /** Choices on a liaison message (complete the order, reopen it, or hand held words to the executor). */
  actions?: V2MessageAction[]
}
export type V2Held = 'choosing' | 'completed' | 'kept'
export const V2_HELD: readonly V2Held[] = ['choosing', 'completed', 'kept']
/**
 * One choice on a liaison message. `complete`: finish the order (`stopSchedule`: also stop its recurring schedule);
 * `reopen`: undo a completion; `forward`: send the held owner words `messageId` to the executor. `done` once taken.
 */
export interface V2MessageAction {
  kind: 'complete' | 'reopen' | 'forward'
  label: string
  messageId?: string
  stopSchedule?: true
  done?: { at: string }
}
export type V2Delivery = 'steered' | 'pending' | 'queued' | 'unsent' | 'unknown'
export const V2_DELIVERIES: readonly V2Delivery[] = ['steered', 'pending', 'queued', 'unsent', 'unknown']

/** Only a single binding recorded before migration can own an unlabelled historical message. */
export function messageWorkOrder(session: V2Session, message: V2Message): string | undefined {
  if (message.workOrderId) return message.workOrderId
  const legacy = session.legacyMessageOrder
  if (legacy && Date.parse(message.at) < Date.parse(legacy.through)) return legacy.id
}

export interface V2Transcript {
  messages: V2Message[]
  issue?: string
  /** An informational notice (e.g. a native turn with one reply) can accompany a complete public transcript. */
  complete?: boolean
  /** The executor is working on a turn of this session; owner words go straight into it. */
  working?: boolean
  /** The next turn of this session waits for another turn in the same project directory; owner words join it. */
  waiting?: V2DirectoryWait
}
export interface V2WorkspaceView {
  scope: string
  workspace: V2Workspace
  delegations: V2Delegation[]
  orders: V2Delegation[]
  sessions: V2Session[]
  decisions: V2Decision[]
  /** Directory the next turn of each coding work order uses, by order id. */
  directories?: Record<string, V2WorkDirectory>
}
export interface V2SessionView extends V2Transcript { scope: string; session: V2Session; portraits?: SpeakerPortraits; observedAt?: number }

/** Tier for commands of one work order: ask the owner, let a reviewer decide, or run everything (default). */
export type V2CodingPermission = 'ask' | 'approve-for-me' | 'full-access'
export const CODING_PERMISSIONS: readonly V2CodingPermission[] = ['ask', 'approve-for-me', 'full-access']
export const codingPermission = (order: Pick<V2Delegation, 'permission'> | undefined): V2CodingPermission => order?.permission ?? 'full-access'
export type V2CommandDecision = 'auto' | 'allowed' | 'rejected' | 'expired' | 'reviewer-allowed' | 'reviewer-denied' | 'gate-unavailable'

/** One tool use of a coding session as reported by the tool itself. Text is redacted before it is stored. */
export interface V2CommandRecord {
  id: string
  turnId: string
  workOrderId: string | null
  at: string
  /** Tool name inside the coding tool, e.g. `shell` (Codex) or `Bash` / `Edit` (Claude Code). */
  tool: string
  command: string
  cwd: string
  exitCode?: number | null
  /** The tool reported a failed or declined use, also for tools without an exit code. */
  failed?: boolean
  /** At most 2 KB, redacted. */
  outputTail?: string
  endedAt?: string
  /** The turn ended before the tool reported this command's end. */
  unfinished?: true
  /** The command hook was running this turn, but no ask matched this run's text (shown for review). */
  unmatched?: true
  /** The member of a roster group that ran it (id and the name it had then). */
  memberId?: string
  memberName?: string
  /** Command gate decision; absent when the gate was not asked (older records, tools without hooks). */
  risk?: 'high' | 'normal'
  tier?: V2CodingPermission
  decision?: V2CommandDecision
  by?: string
  reason?: string
}
/** Exit of the coding tool process for one turn. `stderrTail` is at most 4 KB, redacted. */
export interface V2TurnProcess { exitCode: number | null; signal?: string; stderrTail: string }
export interface V2RunRecord {
  turnId: string
  workOrderId: string | null
  tool: 'codex' | 'claude-code'
  startedAt?: string
  endedAt?: string
  /** The turn continued this native session (Codex thread or Claude Code session). */
  resumed?: boolean
  nativeSessionId?: string
  /** Model the tool reported for this turn (Claude Code init, Codex session record). */
  model?: string
  /** Directory the tool ran in (absent in older records). */
  cwd?: string
  state: 'sent' | 'done' | 'unknown' | 'unsent'
  process: V2TurnProcess
}
/** The owner changed the tier of a work order; takes effect from the next command. */
export interface V2PermissionChange { at: string; from: V2CodingPermission; to: V2CodingPermission }
/** A high-risk command waiting for the owner, shown as an approval card. */
export interface V2PendingApproval {
  id: string
  workspaceId: string
  sessionId: string
  workOrderId: string | null
  turnId: string
  /** `dsh`: a DSH group member. */
  tool: 'codex' | 'claude-code' | 'dsh'
  /** Group member that asked (stable member id); absent for a coding session. */
  memberId?: string
  /** Full command text and the absolute working directory, as the tool asked. */
  command: string
  cwd: string
  reason: string
  requestedAt: string
  expiresAt: string
}
/** Execution record of one work order (or the session discussion) in its coding session, most recent last. */
export interface V2ExecutionView {
  commands: V2CommandRecord[]; runs: V2RunRecord[]; permissions?: V2PermissionChange[]; pending?: V2PendingApproval[]
  /** Directory the next coding turn uses. */
  directory?: V2WorkDirectory
}

export interface V2TurnInput {
  id: string
  text: string
  workOrderId?: string
  /** An already entrusted original owner turn may start after its conversation is closed. */
  acceptedStart?: true
  /**
   * The liaison speaks this turn. With `handoff`, `text` is the owner's original wording it relays after its own
   * hand-over; without, `text` is the liaison's own words (a follow-up after its acceptance review).
   */
  liaison?: { handoff?: string }
  context?: { workspace: V2Workspace; delegations: V2Delegation[]; decisions: V2Decision[] }
  /**
   * Coding turns: the project directory the host chose (and holds) for this turn. Absent: SuperHub's own working
   * directory. The source checks it again before the tool starts.
   */
  directory?: string
  /** Owner words said while this turn waited for its directory; they are part of this turn. */
  merged?: { id: string; text: string }[]
}

/** Owner words for the turn that is running in the same session. */
export interface V2Interjection { id: string; text: string; workOrderId?: string }
/**
 * `steered`: the running turn took the words. `pending`: the words are with the executor; whether this turn takes them is
 * known when it ends (`interjections`). `rejected`: nothing was delivered, the words can go to the next turn.
 */
export type V2SteerOutcome = 'steered' | 'pending' | 'rejected'
export interface V2TurnEvents {
  /** The owner's words are durably recorded with the source and dispatch has begun; the caller may stop waiting. */
  dispatched?(): void
}

export interface V2DialogueSource {
  /** Public messages eligible for automatic reuse under this current staff authorization. */
  staffSources?(session:V2Session,orderId:string,token:string):Set<string>
  /** Locally saved first turn and published text, used to restore old automatically named orders. */
  briefEvidence?(session: V2Session, turnId: string, orderId: string): {text?:string; report?:{label?:string;text:string}}
  /** Locally archived final speech for this bound turn, without fetching native history or waking an agent. */
  savedResults?(session: V2Session, requestId: string): SavedOrderResults | undefined
  /** Experience versions and staff scope carried by a locally completed turn. */
  experienceSource?(session: V2Session, turnId: string): {refs: readonly {id: string; version: number}[]; staffId?: string} | undefined
  /** Opaque identity of the published file's location, when the host archived an explicit output link. */
  resultFileIdentity?(session: V2Session, fileId: string): string | undefined
  /** SuperHub's own working directory for the order (or the discussion) of a coding session; nothing is created. */
  workDirectory?(session: V2Session, workOrderId?: string): string | undefined
  read(session: V2Session): Promise<V2Transcript>
  send(session: V2Session, input: V2TurnInput, signal: AbortSignal, events?: V2TurnEvents): Promise<void>
  /** Deliver owner words into the running turn `turnId` of this session. Never delivers twice; `rejected` delivered nothing. */
  interject?(session: V2Session, turnId: string, input: V2Interjection): Promise<V2SteerOutcome>
  /** Final outcome of each interjection of an ended turn: `delivered` when the turn took the words. */
  interjections?(session: V2Session, turnId: string): {id: string; delivered: boolean}[]
  /** Note in the transcript that an interjection moved to the next turn or was not delivered. */
  markInterjection?(session: V2Session, words: V2Interjection, state: 'queued' | 'unsent'): void
  /** Positive acknowledgment of this exact turn from the durable, bound source. */
  confirmed?(session: V2Session, requestId: string): Promise<boolean>
  attachment(session: V2Session, id: string): Promise<V2Attachment | undefined>
  /** Commands and tool process exits recorded for one work order (or the general discussion when absent). */
  execution?(session: V2Session, workOrderId?: string): V2ExecutionView
  /** Append the owner's tier change to the order's execution record. */
  recordPermission?(session: V2Session, workOrderId: string, change: V2PermissionChange): void
  /** Post a liaison message (an acceptance verdict) to the conversation. Idempotent by `id`; returns the message id. */
  note?(session: V2Session, note: { id: string; text: string; workOrderId?: string }): string | void
  /**
   * Record owner words that were not sent to the executor (the liaison held them back), at the time they were said.
   * Idempotent by the words' request id; returns the message id, which a later dispatch of the same request keeps.
   */
  hold?(session: V2Session, words: V2Interjection & { at?: string }): string | void
}
