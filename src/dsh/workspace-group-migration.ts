/**
 * 工作区群聊上线迁移（任务 11-24 D3 / R6 / AC7，design §8）：旧会话直接删。
 *
 * 旧会话 = 看板里没有新机制标记（`engine: 'roster'`）的会话：编程会话（`coding`）和临时 Lead 群（`group`）。
 * 一起删除的：它们的工单，看板上挂在这些会话/工单上的回执、验收、交付提醒、待开轮次、收单判断、决定、跟进、原话、头像、
 * 接口人交办语；发件箱里这些工单的提醒；对话记录目录 `ops/superhub-v2-dialogues/<工作区>/<会话>`（含命令日志）；
 * 旧群的 DSH 原生会话（临时 Lead 与 teammate）；编程会话用过的 Codex thread / Claude Code 会话。
 * 另外（D5）：看板 `retiredOrders` 里的退役原生工单（T-xxxx）连同工单文件、事件正文、处理结果、提醒、讨论室挂接、
 * 交付版本、`work/T-xxxx` 目录和它们的 DSH 工单桌会话一起删（见 `workspace-group-migration-tickets.ts`）。
 * 保留：`work/superhub-v2` 下的交付文件、工作区本身、新机制群、幕僚、资料（history）、档案导入。
 * 第二大脑是 git 仓库：这里只改工作树，删除会出现在它的下一次自动提交里（本工具不提交）。
 *
 * 三步：
 * - `readMigrationSnapshot` 只读地收集第二大脑与（可选的）DSH / Codex / Claude 目录里的相关记录；
 * - `planGroupChatMigration` 是纯函数：同一份快照永远得到同一份清单（清单标识只取决于要删的东西）；
 * - `applyGroupChatMigration` 执行清单：先持有本脑写锁（运行中的 dsh-web 持有它，所以服务在跑时拒绝）并过一遍
 *   `live` 检查；清单与「进行中」指针先落盘，再逐项执行，每项一行日志；每项都可重做，中途失败或崩溃后重跑会接着原清单做完。
 *   只删清单里的对话目录（必须是按会话标识推算出的 `ops/superhub-v2-dialogues` 子目录）和清单里列出标识的原生会话。
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { Notice } from './outbox.ts'
import { acquireLock, LEGACY_CLEANUP_PENDING } from './lock.ts'
import { CleanupFiles } from './legacy-cleanup-transaction.ts'
import { workspaceBoardFile, workspaceScope } from './workspace-v2-store.ts'
import { dialogueKey, groupLeadId } from './workspace-speaker-id.ts'
import { GROUP_MIGRATION_FOLDER } from './brain-private.ts'
import { editTicketReference, isTicketReference, parseTicket, remoteTicket, REMOTE_OPEN, REMOTE_SETTLED, TICKET_ID, ticketEvents, ticketReminder,
  ticketRunning, type TicketContext } from './workspace-group-migration-tickets.ts'

// ——— Persisted shapes (only the fields this migration reads; every other field is carried through unchanged) ———

type Row = Record<string, unknown>
interface BoardSession { id: string; workspaceId: string; title?: string; kind?: string; executor?: string; engine?: string; delegationIds?: string[]
  closed?: boolean; createdAt?: string; legacyMessageOrder?: {id: string} }
interface BoardOrder { id: string; workspaceId: string; sessionId: string; title?: string; status?: string; historySessionIds?: string[] }
interface BoardLike extends Row {
  workspaces: {id: string; name?: string}[]
  sessions: BoardSession[]
  delegations: BoardOrder[]
  decisions: {delegationId?: string}[]
  receipts: Record<string, Row>
  starts?: Row[]; signupStarts?: Row[]; groupStarts?: Row[]
  acceptances?: Record<string, Row>; resultNotices?: Record<string, Row>; commands?: Record<string, Row>
  followups?: Record<string, {reports?: {id: string}[]}>; originals?: Record<string, unknown>; portraits?: Record<string, unknown>
  liaisonTurns?: Record<string, unknown>
  retiredOrders?: {orders?: RetiredOrder[]; sessions?: {id: string}[]}
  migratedGroupChat?: {manifestId: string; at: string}
}
interface RetiredOrder { id: string; legacyTicketId?: string; sessionId?: string; title?: string; workspaceId?: string }
interface JournalLike {
  messages?: unknown[]; attachments?: unknown[]; members?: {id?: unknown; name?: unknown}[]
  turns?: {nativeSessionId?: unknown; resumed?: unknown}[]
  native?: Record<string, {tool?: unknown; sessionId?: unknown}>
}
interface DshIndex { global?: {workspaceIds?: string[]; archivedSessionIds?: string[]; pinnedSessionIds?: string[]}
  tables?: {workspaces?: Record<string, {path?: string; sessionIds?: string[]}>} }

const DIALOGUES = join('ops', 'superhub-v2-dialogues')
const WORK = join('work', 'superhub-v2')
const OUTBOX = join('ops', 'outbox.json')
/** Migration records: the saved manifest, its one-line-per-item log, the in-progress pointer and the done marker. */
export const MIGRATION_DIR = join('ops', GROUP_MIGRATION_FOLDER)
const PENDING = join(MIGRATION_DIR, 'pending')
const STATE = join(MIGRATION_DIR, 'state.json')
/** Files only a roster group (the new engine) writes: an old session's directory holding one is never removed. */
const ROSTER_FILES = ['ledger.jsonl', 'members.json', 'scheduler.json', 'seen.json']
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLLOUT = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const HEX64 = /^[a-f0-9]{64}$/

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const text = (value: unknown) => typeof value === 'string' ? value : undefined
const list = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : []
const sorted = <T>(rows: T[], key: (row: T) => string) => [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const unique = (values: string[]) => [...new Set(values)].sort()

const sessionKey = (scope: string, workspaceId: string, sessionId: string) => {
  const area = dialogueKey(scope, workspaceId)
  return [area, dialogueKey(area, sessionId)] as const
}
/** The records directory of a session (relative to the brain root), as the dialogue source and group host derive it. */
export const sessionRecordsDir = (scope: string, workspaceId: string, sessionId: string) => join(DIALOGUES, ...sessionKey(scope, workspaceId, sessionId))
/** The absolute working directory an old group's native DSH session ran in (its DSH workspace path). */
const groupWorkPath = (origin: string, scope: string, workspaceId: string, sessionId: string) => join(origin, WORK, ...sessionKey(scope, workspaceId, sessionId))
/** SuperHub's working directories of a session (its own, plus the siblings later orders and the discussion used). */
function sessionWorkDirs(scope: string, session: BoardSession, orderIds: string[]) {
  const area = dialogueKey(scope, session.workspaceId)
  return [dialogueKey(area, session.id), dialogueKey(area, session.id, 'discussion'), ...orderIds.map(id => dialogueKey(area, session.id, 'order', id))]
    .map(room => join(WORK, area, room))
}

// ——— Board and outbox edits (pure, idempotent) ———

export type BoardCollection = 'sessions' | 'delegations' | 'decisions' | 'receipts' | 'liaisonTurns' | 'acceptances' | 'resultNotices' | 'commands'
  | 'starts' | 'signupStarts' | 'groupStarts' | 'followups' | 'originals' | 'portraits' | 'retiredOrders' | 'retiredSessions'
interface Owner { sessionId?: string; orderId?: string }
/** `tickets`: retired native tickets whose `retiredOrders` rows (and their synthetic sessions) go too. */
export interface MigrationTarget { sessions: ReadonlySet<string>; orders: ReadonlySet<string>; tickets?: ReadonlySet<string> }

/**
 * Remove the target sessions and orders and everything on the board tied to them; detach them from what stays. Running
 * it again on its own result changes nothing. `record` learns each removed row and the session/order it belonged to.
 */
export function pruneBoard(board: BoardLike, target: MigrationTarget, record: (collection: BoardCollection, key: string, owner: Owner) => void = () => {}): boolean {
  let changed = false
  const retiredOrders = list<RetiredOrder>(board.retiredOrders?.orders), retiredSessions = list<{id: string}>(board.retiredOrders?.sessions)
  const goneRetired = retiredOrders.filter(row => target.tickets?.has(row.legacyTicketId ?? row.id))
  const goneIds = new Set(goneRetired.map(row => row.id))
  const stillUsed = new Set(retiredOrders.filter(row => !goneIds.has(row.id)).map(row => row.sessionId))
  const goneSessions = new Set(retiredSessions.filter(row => goneRetired.some(order => order.sessionId === row.id) && !stillUsed.has(row.id)).map(row => row.id))
  const sessions = new Set([...target.sessions, ...goneSessions]), orders = new Set([...target.orders, ...goneIds])
  const orderSession = new Map([...retiredOrders.map(row => [row.id, row.sessionId] as const), ...board.delegations.map(row => [row.id, row.sessionId] as const)])
  if (board.retiredOrders && (goneIds.size || goneSessions.size)) {
    for (const row of goneRetired) record('retiredOrders', row.id, {orderId: row.id, ...(row.sessionId && {sessionId: row.sessionId})})
    for (const id of goneSessions) record('retiredSessions', id, {sessionId: id})
    const restOrders = retiredOrders.filter(row => !goneIds.has(row.id)), restSessions = retiredSessions.filter(row => !goneSessions.has(row.id))
    if (restOrders.length || restSessions.length) board.retiredOrders = {...board.retiredOrders, orders: restOrders, sessions: restSessions}
    else delete board.retiredOrders
    changed = true
  }
  const owner = (sessionId: unknown, orderId: unknown): Owner => {
    const order = text(orderId)
    return {sessionId: text(sessionId) ?? (order ? orderSession.get(order) : undefined), ...(order && {orderId: order})}
  }
  const hit = (sessionId: unknown, orderId: unknown) => sessions.has(text(sessionId) ?? '') || orders.has(text(orderId) ?? '')
  const drop = (collection: BoardCollection, key: string, who: Owner) => { record(collection, key, who); changed = true }
  /** Request ids whose receipts and liaison hand-over words go with a removed row. */
  const stale = new Map<string, Owner>()
  const staleRequest = (id: unknown, who: Owner) => { if (typeof id === 'string' && id) stale.set(id, who) }

  board.sessions = board.sessions.filter(row => {
    if (!sessions.has(row.id)) return true
    drop('sessions', row.id, {sessionId: row.id})
    return false
  })
  for (const row of board.sessions) {
    const kept = list<string>(row.delegationIds).filter(id => !orders.has(id))
    if (kept.length !== list(row.delegationIds).length) { row.delegationIds = kept; changed = true }
    if (row.legacyMessageOrder && orders.has(row.legacyMessageOrder.id)) { delete row.legacyMessageOrder; changed = true }
  }
  const reports = new Map<string, Owner>()
  board.delegations = board.delegations.filter(row => {
    if (orders.has(row.id) || sessions.has(row.sessionId)) {
      drop('delegations', row.id, {sessionId: row.sessionId, orderId: row.id})
      return false
    }
    const history = list<string>(row.historySessionIds)
    if (history.some(id => sessions.has(id))) {
      const kept = history.filter(id => !sessions.has(id))
      if (kept.length) row.historySessionIds = kept
      else delete row.historySessionIds
      changed = true
    }
    return true
  })
  board.decisions = board.decisions.filter(row => {
    if (!orders.has(row.delegationId ?? '')) return true
    drop('decisions', row.delegationId!, owner(undefined, row.delegationId))
    return false
  })
  for (const key of ['followups', 'originals'] as const) {
    const rows = board[key]
    if (!rows) continue
    for (const id of Object.keys(rows)) {
      if (!orders.has(id)) continue
      if (key === 'followups') for (const report of list<{id: string}>(board.followups?.[id]?.reports)) reports.set(report.id, owner(undefined, id))
      delete rows[id]
      drop(key, id, owner(undefined, id))
    }
  }
  for (const id of Object.keys(board.portraits ?? {})) {
    if (!sessions.has(id)) continue
    delete board.portraits![id]
    drop('portraits', id, {sessionId: id})
  }
  for (const key of ['acceptances', 'resultNotices', 'commands'] as const) {
    const rows = board[key]
    if (!rows) continue
    for (const [id, row] of Object.entries(rows)) {
      if (!hit(row.sessionId, row.orderId)) continue
      const who = owner(row.sessionId, row.orderId)
      if (key !== 'resultNotices') staleRequest(id, who)
      if (key === 'acceptances') staleRequest(row.followUp, who)
      delete rows[id]
      drop(key, id, who)
    }
  }
  for (const key of ['starts', 'signupStarts', 'groupStarts'] as const) {
    const rows = board[key]
    if (!rows) continue
    board[key] = rows.filter(row => {
      const orderId = key === 'groupStarts' ? row.orderId : row.delegationId
      if (!hit(row.sessionId, orderId)) return true
      const who = owner(row.sessionId, orderId)
      staleRequest(row.requestId, who)
      for (const words of list<{id?: string}>(row.merged)) staleRequest(words.id, who)
      drop(key, text(row.requestId) ?? '', who)
      return false
    })
  }
  for (const [key, row] of Object.entries(board.receipts)) {
    const id = key.slice(4)
    let gone = stale.get(id)
    if (row.kind === 'mutation') {
      const result = (row.result ?? {}) as {session?: BoardSession; delegation?: BoardOrder}
      if (result.session && sessions.has(result.session.id)) gone ??= {sessionId: result.session.id}
      else if (result.delegation && hit(result.delegation.sessionId, result.delegation.id)) gone ??= owner(result.delegation.sessionId, result.delegation.id)
      else if (result.session && list<string>(result.session.delegationIds).some(order => orders.has(order))) {
        result.session.delegationIds = list<string>(result.session.delegationIds).filter(order => !orders.has(order))
        changed = true
      }
    } else if (row.kind === 'turn') {
      const reserved = list<{id: string}>(row.reserved)
      const kept = reserved.filter(hold => !orders.has(hold.id))
      if (sessions.has(text(row.sessionId) ?? '')) gone ??= {sessionId: text(row.sessionId)}
      else if (kept.length !== reserved.length) {
        if (kept.length) { row.reserved = kept; changed = true }
        else gone ??= owner(row.sessionId, reserved[0]?.id)
      }
    } else if (row.kind === 'interject') {
      if (hit(row.sessionId, row.workOrderId)) gone ??= owner(row.sessionId, row.workOrderId)
    } else if (row.kind === 'group-say') {
      if (sessions.has(text(row.sessionId) ?? '')) gone ??= {sessionId: text(row.sessionId)}
    } else if (row.kind === 'followup') {
      gone ??= reports.get(text(row.reportId) ?? '')
    }
    if (!gone) continue
    delete board.receipts[key]
    drop('receipts', key, gone)
    stale.set(id, gone)
  }
  for (const [id, who] of stale) {
    if (!board.liaisonTurns || !(id in board.liaisonTurns)) continue
    delete board.liaisonTurns[id]
    drop('liaisonTurns', id, who)
  }
  return changed
}

/** The order or session an outbox reminder of a workspace is about (`workspace-<kind>:<order or session>:<turn>`). */
const reminderTarget = (notice: Pick<Notice, 'key'>) => /^workspace-[a-z-]+:([^:]+):/.exec(notice.key)?.[1]
/** The reminders that stay: none about the target orders or sessions, nor (with `tickets`) about the retired tickets. */
export function pruneOutbox(rows: Notice[], {sessions, orders}: MigrationTarget, tickets?: Pick<TicketContext, 'tickets' | 'assignments' | 'events'>): {kept: Notice[]; removed: Notice[]} {
  const removed: Notice[] = []
  const kept = rows.filter(row => {
    const target = reminderTarget(row)
    const gone = orders.has(row.order?.orderId ?? '') || !!target && (orders.has(target) || sessions.has(target)) || !!tickets && ticketReminder(row, tickets)
    if (gone) removed.push(row)
    return !gone
  })
  return {kept, removed}
}

/**
 * DSH's workspace registry (`storages/workspace.json`): the removed sessions leave every workspace; a workspace that was
 * opened for one of the removed sessions' working directories and has no session left is removed too. Idempotent.
 */
export function pruneDshIndex(index: DshIndex, ids: ReadonlySet<string>, workPaths: ReadonlySet<string>) {
  let sessions = 0
  const workspaces: {id: string; path: string}[] = []
  const filter = (values: string[] | undefined) => values?.filter(id => !ids.has(id))
  for (const [id, row] of Object.entries(index.tables?.workspaces ?? {})) {
    const before = list<string>(row.sessionIds)
    const kept = before.filter(session => !ids.has(session))
    sessions += before.length - kept.length
    if (kept.length !== before.length) row.sessionIds = kept
    if (!kept.length && row.path && workPaths.has(row.path)) {
      delete index.tables!.workspaces![id]
      workspaces.push({id, path: row.path})
    }
  }
  if (index.global) {
    const gone = new Set(workspaces.map(row => row.id))
    if (index.global.workspaceIds) index.global.workspaceIds = index.global.workspaceIds.filter(id => !gone.has(id))
    if (index.global.archivedSessionIds) index.global.archivedSessionIds = filter(index.global.archivedSessionIds)
    if (index.global.pinnedSessionIds) index.global.pinnedSessionIds = filter(index.global.pinnedSessionIds)
  }
  return {sessions, workspaces}
}

// ——— Snapshot (read-only) ———

/** `link`: the entry is a symbolic link (never followed; an old session's link blocks the migration). */
export interface DialogueDirSnapshot { path: string; files: string[]; source?: string; commandLines: number; link?: true }
export interface DshSessionFound { id: string; dir: string; projcache?: string; siblings: string[] }
export interface CodexThreadFound { id: string; paths: string[] }
export interface ClaudeSessionFound { id: string; paths: string[] }
/** A DSH session that worked in a ticket's directory (its header's `cwd` is `<origin>/work/T-xxxx`). */
export interface DshTicketSession { id: string; dir: string; ticketId: string; parent?: string; projcache?: string }
/** A ticket directory (`work/T-xxxx`, `ops/delivery-versions/T-xxxx`); `link`: a symbolic link (never followed). */
export interface TicketDirSnapshot { path: string; files: number; link?: true }
export interface MigrationSnapshot {
  brain: string
  /** Where the brain normally lives (absolute paths in DSH's registry); the brain itself unless working on a copy. */
  origin: string
  scope: string
  boardPath: string
  boardText?: string
  /** Every board file in `ops/superhub-v2` (a missing board with others present usually means a wrong scope). */
  boardFiles: string[]
  outboxText?: string
  dialogueDirs: DialogueDirSnapshot[]
  workDirs: {path: string; files: number}[]
  legacyCleanupPending: boolean
  migrated?: {manifestId: string; at: string}
  /** Native ticket files `ops/tickets/T-xxxx.json` (name → text). */
  tickets: {name: string; text: string}[]
  /** Files that may refer to native tickets (see `isTicketReference`), relative `/` paths → text. */
  ticketReferences: {path: string; text: string}[]
  /** Task files of the remote queue (`ops/remote/<stage>/<name>.json`). */
  remote: {stage: string; name: string; path: string; text: string}[]
  ticketDirs: TicketDirSnapshot[]
  /** Absent: that home was not checked (natives are then listed as unchecked). */
  dsh?: {home: string; sessions: DshSessionFound[]; index?: string; ticketSessions: DshTicketSession[]; unreadable: string[]}
  codex?: {home: string; threads: CodexThreadFound[]}
  claude?: {dir: string; sessions: ClaudeSessionFound[]}
}
export interface SnapshotOptions {
  /** The brain's scope (32 hex), or the path of the original brain when `brain` is a copy. Default: the brain's own. */
  scope?: string
  dshHome?: string
  codexHome?: string
  claudeDir?: string
}

function entries(path: string) {
  const stat = lstatSync(path, {throwIfNoEntry: false})
  if (!stat?.isDirectory()) return []
  return readdirSync(path, {withFileTypes: true}).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}
function countFiles(path: string): number {
  let total = 0
  for (const entry of entries(path)) {
    if (entry.isDirectory()) total += countFiles(join(path, entry.name))
    else if (entry.isFile()) total++
  }
  return total
}

/** The scope and original location named by `--scope` (32 hex, or an existing brain path). */
export function resolveScope(root: string, value: string | undefined): {scope: string; origin: string} {
  if (value === undefined) return {scope: workspaceScope(root), origin: root}
  if (/^[a-f0-9]{32}$/.test(value)) return {scope: value, origin: root}
  if (!existsSync(value)) throw new Error('--scope 需要 32 位作用域，或原第二大脑的路径：' + value)
  const origin = realpathSync(value)
  return {scope: workspaceScope(origin), origin}
}

/** Collect what the plan needs, without changing anything. */
export function readMigrationSnapshot(brain: string, options: SnapshotOptions = {}): MigrationSnapshot {
  const root = realpathSync(brain)
  const files = new CleanupFiles(root)
  const {scope, origin} = resolveScope(root, options.scope)
  const boardPath = workspaceBoardFile(scope)
  const read = (path: string) => files.read(path)?.toString('utf8')
  const dialogueDirs: DialogueDirSnapshot[] = []
  for (const area of files.list(DIALOGUES)) {
    if (!area.isDirectory()) continue
    for (const room of files.list(join(DIALOGUES, area.name))) {
      const path = join(DIALOGUES, area.name, room.name)
      if (room.isSymbolicLink()) { dialogueDirs.push({path, files: [], commandLines: 0, link: true}); continue }
      if (!room.isDirectory()) continue
      const names = files.list(path).map(entry => entry.name)
      const commands = names.includes('commands.jsonl') ? read(join(path, 'commands.jsonl')) ?? '' : ''
      dialogueDirs.push({path, files: names, ...(names.includes('source.json') && {source: read(join(path, 'source.json'))}),
        commandLines: commands.split('\n').filter(line => line.trim()).length})
    }
  }
  const workDirs: MigrationSnapshot['workDirs'] = []
  for (const area of files.list(WORK)) {
    if (!area.isDirectory()) continue
    for (const room of files.list(join(WORK, area.name))) {
      if (room.isDirectory()) workDirs.push({path: join(WORK, area.name, room.name), files: countFiles(files.location(join(WORK, area.name, room.name)))})
    }
  }
  let migrated: MigrationSnapshot['migrated']
  try { migrated = JSON.parse(read(STATE) ?? 'null')?.migratedGroupChat ?? undefined } catch { migrated = undefined }
  const files_ = (dir: string, pattern: RegExp) => files.list(dir).filter(entry => entry.isFile() && pattern.test(entry.name)).map(entry => join(dir, entry.name))
  const tickets = files_(join('ops', 'tickets'), /^T-\d+\.json$/).map(path => ({name: path.split(sep).at(-1)!, text: read(path) ?? ''}))
  const references = [...files_(join('ops', 'events'), /\.jsonl$/), join('ops', 'dispositions.jsonl'), join('ops', 'room-index.json'), ...files_(join('ops', 'rooms'), /\.json$/),
    ...files_(join('ops', 'worklines'), /\.json$/), join('ops', 'superhub-saa.json'), ...files_(join('ops', 'discussions'), /\.json$/), join('ops', 'ticket-sequence.json')]
    .map(path => path.split(sep).join('/')).filter(isTicketReference)
  const remote = [...REMOTE_OPEN, ...REMOTE_SETTLED].flatMap(stage => files_(join('ops', 'remote', stage), /^[A-Za-z0-9_.-]+\.json$/)
    .map(path => ({stage, name: path.split(sep).at(-1)!, path: path.split(sep).join('/'), text: read(path) ?? ''})))
  const ticketDirs: TicketDirSnapshot[] = []
  for (const parent of ['work', join('ops', 'delivery-versions')]) {
    for (const entry of files.list(parent)) {
      if (!TICKET_ID.test(entry.name)) continue
      const path = join(parent, entry.name).split(sep).join('/')
      if (entry.isSymbolicLink()) ticketDirs.push({path, files: 0, link: true})
      else if (entry.isDirectory()) ticketDirs.push({path, files: countFiles(files.location(path))})
    }
  }
  const snapshot: MigrationSnapshot = {
    brain: root, origin, scope, boardPath, boardFiles: files.list(join('ops', 'superhub-v2')).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name),
    boardText: read(boardPath), outboxText: read(OUTBOX), dialogueDirs, workDirs,
    legacyCleanupPending: existsSync(join(root, 'ops', LEGACY_CLEANUP_PENDING)), ...(migrated && {migrated}),
    tickets, ticketReferences: references.flatMap(path => { const text = read(path); return text === undefined ? [] : [{path, text}] }), remote, ticketDirs,
  }
  // Natives are looked up by the ids the brain's records name, nothing else is read from those homes.
  const pre = planGroupChatMigration(snapshot)
  const wanted = pre.workspaces.flatMap(space => space.sessions)
  const dshIds = new Set(wanted.flatMap(row => row.dsh.map(item => item.id)))
  const codexIds = new Set(wanted.flatMap(row => row.codex.map(item => item.id)))
  const claudeIds = new Set(wanted.flatMap(row => row.claude.map(item => item.id)))
  if (options.dshHome) snapshot.dsh = scanDsh(options.dshHome, dshIds, origin, pre.tickets.ids)
  if (options.codexHome) snapshot.codex = {home: options.codexHome, threads: [...codexIds].map(id => ({id, paths: codexRollouts(options.codexHome!, id)}))}
  if (options.claudeDir) snapshot.claude = {dir: options.claudeDir, sessions: [...claudeIds].map(id => ({id, paths: claudeFiles(options.claudeDir!, id)}))}
  return snapshot
}

/** The header (first line) of a DSH session log: `{type: 'session', id, cwd, parentSession, …}`. */
function dshHeader(dir: string): {id?: string; cwd?: string; parentSession?: string} | undefined {
  const name = entries(dir).find(entry => entry.isFile() && /^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name))?.name
  if (!name) return
  try {
    const bytes = readFileSync(join(dir, name))
    const raw = name.endsWith('.zstd') ? zstdDecompressSync(bytes) : bytes
    const first = raw.subarray(0, Math.max(0, raw.indexOf(0x0a)) || raw.length).toString('utf8')
    const header = JSON.parse(first) as {type?: string; id?: string; cwd?: string; parentSession?: string}
    return header?.type === 'session' ? header : undefined
  } catch { return }
}
/**
 * DSH sessions of the tickets: in the session folder named after `work/T-xxxx`, every session whose own header says it
 * worked in exactly that directory (the ticket desk and the subagent sessions it started). Others there are not taken.
 */
function scanTicketSessions(home: string, origin: string, tickets: readonly string[]) {
  const sessions: DshTicketSession[] = [], unreadable: string[] = []
  for (const folder of entries(join(home, 'sessions'))) {
    if (!folder.isDirectory()) continue
    const ticket = tickets.find(id => folder.name.endsWith('-' + id + '--'))
    if (!ticket) continue
    for (const entry of entries(join(home, 'sessions', folder.name))) {
      if (!entry.isDirectory() || !NATIVE_ID.test(entry.name)) continue
      const dir = join(home, 'sessions', folder.name, entry.name)
      const header = dshHeader(dir)
      if (!header) { unreadable.push(dir); continue }
      if (header.id !== entry.name || header.cwd !== join(origin, 'work', ticket)) continue
      const projcache = join(home, 'storages', 'session_projcache', 'sessions', entry.name + '.json')
      sessions.push({id: entry.name, dir, ticketId: ticket, ...(header.parentSession && {parent: header.parentSession}),
        ...(lstatSync(projcache, {throwIfNoEntry: false})?.isFile() && {projcache})})
    }
  }
  return {sessions, unreadable}
}
function scanDsh(home: string, ids: ReadonlySet<string>, origin: string, tickets: readonly string[]): NonNullable<MigrationSnapshot['dsh']> {
  const sessions: DshSessionFound[] = []
  for (const id of [...ids].sort()) {
    for (const dir of dshSessionDirs(home, id)) {
      const siblings = entries(dirname(dir)).filter(entry => entry.isDirectory() && !ids.has(entry.name)).map(entry => entry.name)
      const projcache = join(home, 'storages', 'session_projcache', 'sessions', id + '.json')
      sessions.push({id, dir, ...(lstatSync(projcache, {throwIfNoEntry: false})?.isFile() && {projcache}), siblings})
    }
  }
  const indexFile = join(home, 'storages', 'workspace.json')
  const index = lstatSync(indexFile, {throwIfNoEntry: false})?.isFile() ? readFileSync(indexFile, 'utf8') : undefined
  const desks = scanTicketSessions(home, origin, tickets)
  return {home, sessions, ...(index !== undefined && {index}), ticketSessions: desks.sessions, unreadable: desks.unreadable}
}
/** DSH keeps a session in `<home>/sessions/<encoded working directory>/<session id>/`. */
function dshSessionDirs(home: string, id: string) {
  if (!NATIVE_ID.test(id)) return []
  const found: string[] = []
  for (const group of entries(join(home, 'sessions'))) {
    if (!group.isDirectory()) continue
    const dir = join(home, 'sessions', group.name, id)
    if (lstatSync(dir, {throwIfNoEntry: false})?.isDirectory()) found.push(dir)
  }
  return found
}
/** Codex rollout files of a thread inside `<codex-home>/sessions` or `archived_sessions` (symlinks are not followed). */
function codexRollouts(home: string, id: string) {
  if (!THREAD_ID.test(id)) return []
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    for (const entry of entries(dir)) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && depth < 6) walk(path, depth + 1)
      else if (entry.isFile() && ROLLOUT.exec(entry.name)?.[1]?.toLowerCase() === id.toLowerCase()) found.push(path)
    }
  }
  for (const part of ['sessions', 'archived_sessions']) walk(join(home, part), 0)
  return found
}
/** A Claude Code session: `<claude-dir>/projects/<project>/<id>.jsonl` and its `<id>/` side directory. */
function claudeFiles(dir: string, id: string) {
  if (!THREAD_ID.test(id)) return []
  const found: string[] = []
  for (const project of entries(join(dir, 'projects'))) {
    if (!project.isDirectory()) continue
    for (const name of [id + '.jsonl', id]) {
      const path = join(dir, 'projects', project.name, name)
      const stat = lstatSync(path, {throwIfNoEntry: false})
      if (stat?.isFile() || stat?.isDirectory()) found.push(path)
    }
  }
  return found
}

// ——— Manifest (pure) ———

export interface MigrationNative { id: string; label: string; found: boolean | null; paths: string[] }
export interface MigrationSession {
  id: string; workspaceId: string; title: string; kind: string; executor: string; createdAt?: string; closed: boolean
  orders: {id: string; title: string; status: string}[]
  dialogue: {path: string; exists: boolean; messages: number; turns: number; attachments: number; commandLines: number}
  /** Board rows removed with this session (by collection). */
  board: Partial<Record<BoardCollection, number>>
  outbox: string[]
  dsh: MigrationNative[]; codex: MigrationNative[]; claude: MigrationNative[]
  /** Kept: SuperHub's working directories of this session that exist. */
  workDirs: {path: string; files: number}[]
}
export type MigrationStep =
  | {kind: 'board'; path: string}
  | {kind: 'outbox'; path: string}
  | {kind: 'dsh-session'; id: string}
  | {kind: 'dsh-index'}
  | {kind: 'codex-thread'; id: string}
  | {kind: 'claude-session'; id: string}
  | {kind: 'dialogue-dir'; path: string; workspaceId: string; sessionId: string}
  /** A brain file whose references to the retired tickets are removed (see `isTicketReference`). */
  | {kind: 'ticket-refs'; path: string}
  | {kind: 'ticket-remote'; path: string}
  | {kind: 'ticket-file'; id: string}
  /** `work/T-xxxx` or `ops/delivery-versions/T-xxxx`. */
  | {kind: 'ticket-dir'; path: string}
/** A retired native ticket deleted with everything tied to it (D5). */
export interface MigrationTicket {
  id: string; title: string; staff: string; ended: boolean; createdAt?: string
  /** `ops/tickets/T-xxxx.json` when it exists. */
  file?: string
  dirs: {path: string; files: number}[]
  /** Event lines whose text is cleared (their identity stays, marked ignored). */
  events: number
  outbox: string[]
  /** Board rows (its `retiredOrders` row, its synthetic session, rows tied to them). */
  board: number
  remote: string[]
  dsh: MigrationNative[]
}
export interface GroupChatMigrationManifest {
  schema: 1
  /** Digest of what is deleted (scope, sessions, orders, steps): the same data always gives the same id. */
  id: string
  scope: string
  boardPath: string
  sessionIds: string[]
  orderIds: string[]
  workspaces: {id: string; name: string; sessions: MigrationSession[]; kept: {id: string; title: string}[]}[]
  totals: {sessions: number; orders: number; boardRows: number; outbox: number; dialogueDirs: number; dsh: number; codex: number; claude: number
    tickets: number; ticketBoardRows: number; ticketOutbox: number; ticketEvents: number; ticketDirs: number; ticketDirFiles: number; desks: number; references: number}
  kept: {
    workspaces: {id: string; name: string}[]
    rosterSessions: number
    workDirs: {path: string; files: number}[]
    retiredOrders: number
    /** Records directories no board session names (left as they are). */
    otherDialogueDirs: string[]
  }
  dshIndex?: {sessions: number; workspaces: {id: string; path: string}[]}
  tickets: {
    ids: string[]; retiredSessionIds: string[]
    /** What the reference edits need, fixed at planning so a resumed run does the same edits after the ticket files are gone. */
    events: [string, string][]; assignments: string[]; roomSources: [string, string[]][]
    rows: MigrationTicket[]
    /** Brain files whose references change. */
    references: string[]
  }
  steps: MigrationStep[]
  homes: {dsh?: string; codex?: string; claude?: string}
  migrated?: {manifestId: string; at: string}
  warnings: string[]
  /** Apply refuses while any is present. */
  blockers: string[]
}

const STATUS: Record<string, string> = {accepted: '已接手', active: '执行中', waiting: '等待', closed: '已关闭', done: '已完成'}
const ended = (status: string | undefined) => status === 'closed' || status === 'done'

export function manifestId(manifest: Pick<GroupChatMigrationManifest, 'scope' | 'boardPath' | 'sessionIds' | 'orderIds' | 'steps'> & {tickets: Pick<GroupChatMigrationManifest['tickets'], 'ids' | 'retiredSessionIds' | 'events' | 'assignments' | 'roomSources'>}) {
  const {ids, retiredSessionIds, events, assignments, roomSources} = manifest.tickets
  return sha256(JSON.stringify([manifest.scope, manifest.boardPath, manifest.sessionIds, manifest.orderIds, manifest.steps, [ids, retiredSessionIds, events, assignments, roomSources]]))
}
export const ticketContext = (tickets: GroupChatMigrationManifest['tickets']): TicketContext => ({
  tickets: new Set(tickets.ids), assignments: new Set(tickets.assignments), events: new Map(tickets.events),
  roomSources: new Map(tickets.roomSources.map(([room, sources]) => [room, new Set(sources)])),
})

/** The retired native tickets of the board and every brain record tied to them. */
function planTickets(snapshot: MigrationSnapshot, board: BoardLike | undefined, warnings: string[], blockers: string[]) {
  const retired = list<RetiredOrder>(board?.retiredOrders?.orders)
  const set = new Set(retired.flatMap(row => { const id = row.legacyTicketId ?? row.id; return TICKET_ID.test(id) ? [id] : [] }))
  const selected: NonNullable<ReturnType<typeof parseTicket>>[] = [], retained: typeof selected = []
  for (const file of snapshot.tickets) {
    const id = file.name.slice(0, -'.json'.length)
    const ticket = parseTicket(file.text, file.name)
    if (!ticket) {
      if (set.has(id)) blockers.push('无法读取退役工单 ops/tickets/' + file.name + '，请先核对')
      else warnings.push('无法读取工单文件 ops/tickets/' + file.name + '，不在本次范围，保留')
      continue
    }
    if (ticket.superhub?.brainScope && ticket.superhub.brainScope !== snapshot.scope) {
      if (set.has(id)) warnings.push('工单 ' + id + ' 属于另一份第二大脑，不删')
      set.delete(id)
      retained.push(ticket)
      continue
    }
    if (set.has(id)) selected.push(ticket)
    else retained.push(ticket)
  }
  const others = retained.filter(row => !row.superhub?.brainScope || row.superhub.brainScope === snapshot.scope).map(row => row.id)
  if (others.length) warnings.push('ops/tickets 里还有不在退役清单的原生工单 ' + others.join('、') + '，本次不删')
  for (const ticket of selected) if (ticketRunning(ticket)) blockers.push('退役工单 ' + ticket.id + ' 仍有执行中的派工')
  const references = new Map(snapshot.ticketReferences.map(row => [row.path, row.text]))
  const {events, roomSources} = ticketEvents(selected, retained, snapshot.ticketReferences.filter(row => row.path.startsWith('ops/events/')).map(row => row.text),
    references.get('ops/dispositions.jsonl'))
  const assignmentTicket = new Map(selected.flatMap(ticket => (ticket.assignments ?? []).map(row => [row.id, ticket.id] as const)))
  const context: TicketContext = {tickets: set, assignments: new Set(assignmentTicket.keys()), events, roomSources}
  const changed = set.size ? snapshot.ticketReferences.filter(row => editTicketReference(row.path, row.text, context) !== row.text).map(row => row.path) : []
  for (const row of snapshot.ticketReferences.filter(row => row.path.startsWith('ops/discussions/'))) {
    try {
      const discussion = JSON.parse(row.text) as {document?: {ticketId?: string}; remoteTurns?: {state?: string}[]}
      if (set.has(discussion.document?.ticketId ?? '') && discussion.remoteTurns?.some(turn => turn.state === 'waiting' || turn.state === 'verifying')) {
        blockers.push(discussion.document!.ticketId + ' 的工作端交付讨论尚未结清')
      }
    } catch { /* unreadable discussions are left as they are */ }
  }
  const remote: {path: string; ticket: string}[] = []
  for (const row of snapshot.remote) {
    const ticket = remoteTicket(row.stage, row.name, row.text, context, assignmentTicket)
    if (!ticket) continue
    if (REMOTE_OPEN.includes(row.stage)) blockers.push(ticket + ' 工作电脑队列 ' + row.stage + ' 尚未结清')
    else remote.push({path: row.path, ticket})
  }
  const dirs = snapshot.ticketDirs.filter(row => set.has(row.path.split('/').at(-1)!))
  for (const row of dirs) if (row.link) blockers.push(row.path + ' 是符号链接，无法确认归属，请先核对')
  const goneSessions = new Set(retired.filter(row => set.has(row.legacyTicketId ?? row.id)).flatMap(row => row.sessionId ? [row.sessionId] : []))
  for (const row of retired) if (!set.has(row.legacyTicketId ?? row.id) && row.sessionId) goneSessions.delete(row.sessionId)
  for (const session of list<{id: string; workspaceId?: string}>(board?.retiredOrders?.sessions)) {
    if (goneSessions.has(session.id) && session.workspaceId && snapshot.dialogueDirs.some(dir => dir.path === sessionRecordsDir(snapshot.scope, session.workspaceId!, session.id))) {
      warnings.push('退役会话 ' + session.id + ' 还有记录目录，本次不删，请另行核对')
    }
  }
  if (set.size && !snapshot.dsh) warnings.push('没有提供 DSH 目录（--dsh-home），退役工单的工单桌会话未列出、不会删除')
  for (const dir of snapshot.dsh?.unreadable ?? []) warnings.push('DSH 会话 ' + dir + ' 的会话头读不出，无法确认是否属于退役工单，保留')
  return {set, selected, context, assignmentTicket, changed, remote, dirs, retiredSessionIds: [...goneSessions].sort(),
    titles: new Map(retired.map(row => [row.legacyTicketId ?? row.id, row.title ?? '']))}
}

/** What the migration would do with this snapshot. No side effects; deterministic. */
export function planGroupChatMigration(snapshot: MigrationSnapshot): GroupChatMigrationManifest {
  const {scope, boardPath} = snapshot
  const warnings: string[] = [], blockers: string[] = []
  let board: BoardLike | undefined
  if (snapshot.boardText !== undefined) {
    try {
      const parsed = JSON.parse(snapshot.boardText) as BoardLike
      if (![parsed?.workspaces, parsed?.sessions, parsed?.delegations, parsed?.decisions].every(Array.isArray) || !parsed.receipts || typeof parsed.receipts !== 'object') throw new Error()
      board = parsed
    } catch { blockers.push('工作区看板 ' + boardPath + ' 无法读取，未做任何判断') }
  } else if (snapshot.boardFiles.length) {
    blockers.push('没有找到本作用域的看板 ' + boardPath + '，但 ops/superhub-v2 里有 ' + snapshot.boardFiles.join('、') + '。如果是在副本上运行，请用 --scope 指定原第二大脑的路径')
  }
  if (snapshot.legacyCleanupPending) blockers.push('旧工单清理（cleanup-legacy-orders）尚未完成，请先用原清单完成它')
  if (snapshot.migrated) warnings.push('这份第二大脑已在 ' + snapshot.migrated.at + ' 完成过群聊迁移（清单 ' + snapshot.migrated.manifestId.slice(0, 12) + '）')

  const old = sorted((board?.sessions ?? []).filter(row => row.engine !== 'roster'), row => row.workspaceId + '\0' + (row.createdAt ?? '') + '\0' + row.id)
  const sessionIds = new Set(old.map(row => row.id))
  const orders = (board?.delegations ?? []).filter(row => sessionIds.has(row.sessionId))
  const orderIds = new Set(orders.map(row => row.id))
  const tickets = planTickets(snapshot, board, warnings, blockers)
  const target = {sessions: sessionIds, orders: orderIds, tickets: tickets.set}
  const retiredTicket = new Map(list<RetiredOrder>(board?.retiredOrders?.orders).flatMap(row => [[row.id, row.legacyTicketId ?? row.id] as const,
    ...row.sessionId ? [[row.sessionId, row.legacyTicketId ?? row.id] as const] : []]))

  // Board rows, attributed to their session (or retired ticket).
  const boardRows = new Map<string, Partial<Record<BoardCollection, number>>>()
  const ticketRows = new Map<string, number>()
  let boardTotal = 0
  if (board) pruneBoard(structuredClone(board), target, (collection, _key, owner) => {
    boardTotal++
    const ticket = retiredTicket.get(owner.orderId ?? '') ?? retiredTicket.get(owner.sessionId ?? '')
    if (ticket && tickets.set.has(ticket)) { ticketRows.set(ticket, (ticketRows.get(ticket) ?? 0) + 1); return }
    const id = owner.sessionId ?? ''
    const counts = boardRows.get(id) ?? {}
    counts[collection] = (counts[collection] ?? 0) + 1
    boardRows.set(id, counts)
  })
  const orderSession = new Map(orders.map(row => [row.id, row.sessionId]))

  // Outbox reminders.
  let outbox: Notice[] = []
  if (snapshot.outboxText !== undefined) {
    try { outbox = list<Notice>(JSON.parse(snapshot.outboxText)) } catch { warnings.push('发件箱 ops/outbox.json 无法读取，执行时会跳过它') }
  }
  const {removed: allReminders} = pruneOutbox(outbox, target, tickets.context)
  const reminderTicket = (row: Notice) => {
    if (!ticketReminder(row, tickets.context)) return
    return [row.ticketId, row.key.split(':')[1], tickets.assignmentTicket.get(row.assignmentId ?? ''), tickets.context.events.get(row.key.slice('stuck:'.length))]
      .find(id => !!id && tickets.set.has(id))
  }
  const reminders = allReminders.filter(row => !reminderTicket(row))
  const reminderOwner = (row: Notice) => orderSession.get(row.order?.orderId ?? '') ?? orderSession.get(reminderTarget(row) ?? '') ?? reminderTarget(row) ?? ''

  const dirs = new Map(snapshot.dialogueDirs.map(dir => [dir.path, dir]))
  const work = new Map(snapshot.workDirs.map(dir => [dir.path, dir]))
  const dshFound = new Map<string, DshSessionFound[]>()
  for (const row of snapshot.dsh?.sessions ?? []) dshFound.set(row.id, [...dshFound.get(row.id) ?? [], row])
  const codexFound = new Map((snapshot.codex?.threads ?? []).map(row => [row.id, row.paths]))
  const claudeFound = new Map((snapshot.claude?.sessions ?? []).map(row => [row.id, row.paths]))
  const native = (id: string, label: string, home: unknown, found: string[] | undefined): MigrationNative =>
    ({id, label, found: home ? !!found?.length : null, paths: found ?? []})

  const sessions: MigrationSession[] = old.map(session => {
    const own = orders.filter(row => row.sessionId === session.id)
    const path = sessionRecordsDir(scope, session.workspaceId, session.id)
    const dir = dirs.get(path)
    let journal: JournalLike = {}
    if (dir?.source !== undefined) {
      try { journal = JSON.parse(dir.source) as JournalLike } catch { warnings.push('会话「' + (session.title ?? session.id) + '」的对话记录无法读取：原生会话标识可能不全') }
    }
    if (dir?.link) blockers.push('旧会话「' + (session.title ?? session.id) + '」的记录目录 ' + path + ' 是符号链接，无法确认归属，请先核对')
    const roster = dir?.files.filter(name => ROSTER_FILES.includes(name)) ?? []
    if (roster.length) blockers.push('旧会话「' + (session.title ?? session.id) + '」的记录目录里有新群机制的文件（' + roster.join('、') + '），未删除，请先核对')
    const dsh: MigrationNative[] = [], codex: MigrationNative[] = [], claude: MigrationNative[] = []
    if (session.kind === 'group') {
      const lead = groupLeadId(scope, session.workspaceId, session.id)
      const members = [{id: lead, name: '讨论接口人'}, ...list<{id?: unknown; name?: unknown}>(journal.members)
        .flatMap(row => typeof row.id === 'string' && row.id !== lead ? [{id: row.id, name: text(row.name) ?? 'teammate'}] : [])]
      for (const member of members) {
        if (!NATIVE_ID.test(member.id)) { warnings.push('跳过格式不对的 DSH 会话标识：' + member.id.slice(0, 80)); continue }
        if (dsh.some(row => row.id === member.id)) continue
        dsh.push(native(member.id, member.name, snapshot.dsh, dshFound.get(member.id)?.flatMap(row => [row.dir, ...row.projcache ? [row.projcache] : []])))
      }
    }
    const threads = new Map<string, string>()
    for (const row of Object.values(journal.native ?? {})) {
      if (typeof row?.sessionId === 'string') threads.set(row.sessionId, row.tool === 'claude-code' ? 'claude-code' : 'codex')
    }
    for (const turn of list<{nativeSessionId?: unknown; resumed?: unknown}>(journal.turns)) {
      for (const id of [turn.nativeSessionId, turn.resumed]) {
        if (typeof id === 'string' && id && !threads.has(id)) threads.set(id, session.executor === 'claude-code' ? 'claude-code' : 'codex')
      }
    }
    for (const [id, tool] of [...threads].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (!THREAD_ID.test(id)) { warnings.push('跳过格式不对的' + (tool === 'codex' ? ' Codex thread' : ' Claude Code 会话') + '标识：' + id.slice(0, 80)); continue }
      if (tool === 'codex') codex.push(native(id, 'Codex', snapshot.codex, codexFound.get(id)))
      else claude.push(native(id, 'Claude Code', snapshot.claude, claudeFound.get(id)))
    }
    for (const row of own) if (!ended(row.status)) warnings.push('工单「' + (row.title ?? row.id) + '」状态为' + (STATUS[row.status ?? ''] ?? row.status ?? '未知') + '，尚未结束，也会一起删除')
    const queued = list<Row>(board?.starts).filter(row => row.sessionId === session.id).length
    if (queued) warnings.push('会话「' + (session.title ?? session.id) + '」有 ' + queued + ' 个排队中的轮次，会一起丢弃')
    for (const row of Object.values(board?.acceptances ?? {})) {
      if (row.sessionId === session.id && row.state === 'pending') warnings.push('会话「' + (session.title ?? session.id) + '」有进行中的验收，会一起删除')
    }
    for (const row of dsh) {
      for (const found of dshFound.get(row.id) ?? []) {
        if (found.siblings.length) warnings.push('DSH 目录 ' + dirname(found.dir) + ' 下另有会话 ' + found.siblings.join('、') + '，不在清单内，保留')
      }
    }
    return {
      id: session.id, workspaceId: session.workspaceId, title: session.title ?? '', kind: session.kind ?? '', executor: session.executor ?? '',
      ...(session.createdAt && {createdAt: session.createdAt}), closed: !!session.closed,
      orders: own.map(row => ({id: row.id, title: row.title ?? '', status: row.status ?? ''})),
      dialogue: {path, exists: !!dir, messages: list(journal.messages).length, turns: list(journal.turns).length, attachments: list(journal.attachments).length, commandLines: dir?.commandLines ?? 0},
      board: boardRows.get(session.id) ?? {},
      outbox: reminders.filter(row => reminderOwner(row) === session.id).map(row => row.key).sort(),
      dsh, codex, claude,
      workDirs: sessionWorkDirs(scope, session, own.map(row => row.id)).flatMap(dir => work.get(dir) ? [work.get(dir)!] : []),
    }
  })
  const unattributed = boardRows.get('')
  if (unattributed) warnings.push('有 ' + Object.values(unattributed).reduce((a, b) => a + (b ?? 0), 0) + ' 条看板记录无法归到具体会话，也会按工单一起删除')

  // Retired tickets, one row each.
  const ticketRowsOut: MigrationTicket[] = [...tickets.set].sort().map(id => {
    const ticket = tickets.selected.find(row => row.id === id)
    const desks = (snapshot.dsh?.ticketSessions ?? []).filter(row => row.ticketId === id)
    return {
      id, title: ticket?.title ?? tickets.titles.get(id) ?? '', staff: ticket?.staff ?? '', ended: !!ticket?.ended, ...(ticket?.createdAt && {createdAt: ticket.createdAt}),
      ...(ticket && {file: 'ops/tickets/' + id + '.json'}),
      dirs: tickets.dirs.filter(row => row.path.split('/').at(-1) === id).map(row => ({path: row.path, files: row.files})),
      events: [...tickets.context.events.values()].filter(owner => owner === id).length,
      outbox: allReminders.filter(row => reminderTicket(row) === id).map(row => row.key).sort(),
      board: ticketRows.get(id) ?? 0,
      remote: tickets.remote.filter(row => row.ticket === id).map(row => row.path),
      dsh: sorted(desks, row => (row.id.startsWith('chief-desk-') ? '0' : '1') + row.id).map(row => ({id: row.id, label: row.id.startsWith('chief-desk-') ? '工单桌' : '执行子会话',
        found: true, paths: [row.dir, ...row.projcache ? [row.projcache] : []]})),
    }
  })
  for (const row of ticketRowsOut) if (!row.file) warnings.push('退役工单 ' + row.id + ' 的工单文件已不在，只清理看板和其余关联')

  // DSH registry preview.
  const deskIds = new Set(ticketRowsOut.flatMap(row => row.dsh.map(item => item.id)))
  const dshIds = new Set([...sessions.flatMap(row => row.dsh.map(item => item.id)), ...deskIds])
  const workPaths = new Set([...old.filter(row => row.kind === 'group').map(row => groupWorkPath(snapshot.origin, scope, row.workspaceId, row.id)),
    ...[...tickets.set].map(id => join(snapshot.origin, 'work', id))])
  let dshIndex: GroupChatMigrationManifest['dshIndex']
  if (snapshot.dsh?.index !== undefined && dshIds.size) {
    try { dshIndex = pruneDshIndex(JSON.parse(snapshot.dsh.index) as DshIndex, dshIds, workPaths) }
    catch { warnings.push('DSH 工作区登记 storages/workspace.json 无法读取，执行时会跳过它') }
  }
  if (!snapshot.dsh && dshIds.size) warnings.push('没有提供 DSH 目录（--dsh-home），旧群的原生会话是否还在未核对')
  if (!snapshot.codex && sessions.some(row => row.codex.length)) warnings.push('没有提供 Codex 目录，Codex thread 是否还在未核对')
  if (!snapshot.claude && sessions.some(row => row.claude.length)) warnings.push('没有提供 Claude 目录，Claude Code 会话是否还在未核对')
  for (const row of sessions) {
    for (const item of [...row.codex, ...row.claude]) {
      if (item.found === false) warnings.push(item.label + ' ' + item.id + ' 在本机记录里没找到（可能已删除）；执行时仍按标识请求删除，找不到就记为不存在')
    }
    for (const item of row.dsh) if (item.found === false) warnings.push('DSH 会话 ' + item.id + ' 在 DSH 目录里没找到（可能从未创建或已删除）')
  }

  const steps: MigrationStep[] = []
  if (board && (sessionIds.size || tickets.set.size)) {
    steps.push({kind: 'board', path: boardPath})
    steps.push({kind: 'outbox', path: OUTBOX})
    for (const path of tickets.changed) steps.push({kind: 'ticket-refs', path})
    for (const id of [...dshIds].sort()) steps.push({kind: 'dsh-session', id})
    if (dshIds.size) steps.push({kind: 'dsh-index'})
    for (const id of unique(sessions.flatMap(row => row.codex.map(item => item.id)))) steps.push({kind: 'codex-thread', id})
    for (const id of unique(sessions.flatMap(row => row.claude.map(item => item.id)))) steps.push({kind: 'claude-session', id})
    for (const row of sessions) if (row.dialogue.exists) steps.push({kind: 'dialogue-dir', path: row.dialogue.path, workspaceId: row.workspaceId, sessionId: row.id})
    for (const row of ticketRowsOut) for (const path of row.remote) steps.push({kind: 'ticket-remote', path})
    for (const row of ticketRowsOut) if (row.file) steps.push({kind: 'ticket-file', id: row.id})
    for (const row of ticketRowsOut) for (const dir of row.dirs) steps.push({kind: 'ticket-dir', path: dir.path})
  }

  const kept = (board?.sessions ?? []).filter(row => row.engine === 'roster')
  const known = new Set((board?.sessions ?? []).map(row => sessionRecordsDir(scope, row.workspaceId, row.id)))
  const names = new Map((board?.workspaces ?? []).map(row => [row.id, row.name ?? '']))
  const spaces = unique([...(board?.workspaces ?? []).map(row => row.id), ...old.map(row => row.workspaceId)])
  const ticketSection = {ids: [...tickets.set].sort(), retiredSessionIds: tickets.retiredSessionIds,
    events: sorted([...tickets.context.events], ([id]) => id), assignments: [...tickets.context.assignments].sort(),
    roomSources: sorted([...tickets.context.roomSources].map(([room, sources]) => [room, [...sources].sort()] as [string, string[]]), ([room]) => room)}
  const base = {schema: 1 as const, scope, boardPath, sessionIds: [...sessionIds].sort(), orderIds: [...orderIds].sort(), steps}
  return {
    ...base, id: manifestId({...base, tickets: ticketSection}),
    tickets: {...ticketSection, rows: ticketRowsOut, references: tickets.changed},
    workspaces: spaces.map(id => ({id, name: names.get(id) ?? '（看板里没有这个工作区）', sessions: sessions.filter(row => row.workspaceId === id),
      kept: kept.filter(row => row.workspaceId === id).map(row => ({id: row.id, title: row.title ?? ''}))}))
      .filter(space => space.sessions.length || space.kept.length || names.has(space.id)),
    totals: {sessions: sessions.length, orders: orderIds.size, boardRows: boardTotal - [...ticketRows.values()].reduce((a, b) => a + b, 0), outbox: reminders.length,
      dialogueDirs: sessions.filter(row => row.dialogue.exists).length, dsh: dshIds.size - deskIds.size,
      codex: unique(sessions.flatMap(row => row.codex.map(item => item.id))).length, claude: unique(sessions.flatMap(row => row.claude.map(item => item.id))).length,
      tickets: ticketRowsOut.length, ticketBoardRows: [...ticketRows.values()].reduce((a, b) => a + b, 0), ticketOutbox: allReminders.length - reminders.length,
      ticketEvents: tickets.context.events.size, ticketDirs: ticketRowsOut.reduce((sum, row) => sum + row.dirs.length, 0),
      ticketDirFiles: ticketRowsOut.reduce((sum, row) => sum + row.dirs.reduce((n, dir) => n + dir.files, 0), 0), desks: deskIds.size, references: tickets.changed.length},
    kept: {
      workspaces: (board?.workspaces ?? []).map(row => ({id: row.id, name: row.name ?? ''})),
      rosterSessions: kept.length,
      workDirs: snapshot.workDirs,
      retiredOrders: list<RetiredOrder>(board?.retiredOrders?.orders).filter(row => !tickets.set.has(row.legacyTicketId ?? row.id)).length,
      otherDialogueDirs: snapshot.dialogueDirs.filter(dir => !known.has(dir.path)).map(dir => dir.path),
    },
    ...(dshIndex && {dshIndex}),
    homes: {...(snapshot.dsh && {dsh: snapshot.dsh.home}), ...(snapshot.codex && {codex: snapshot.codex.home}), ...(snapshot.claude && {claude: snapshot.claude.dir})},
    ...(snapshot.migrated && {migrated: snapshot.migrated}),
    warnings: [...new Set(warnings)], blockers,
  }
}

// ——— Owner-readable manifest (Chinese) ———

const COLLECTION: Record<BoardCollection, string> = {
  sessions: '会话', delegations: '工单', decisions: '决定', receipts: '请求回执', liaisonTurns: '接口人交办语', acceptances: '验收记录',
  resultNotices: '交付提醒', commands: '收单判断', starts: '待开轮次', signupStarts: '待开轮次（旧）', groupStarts: '群待发交办',
  followups: '跟进记录', originals: '主人原话', portraits: '头像映射', retiredOrders: '退役工单', retiredSessions: '退役会话',
}
const short = (id: string) => id.length > 12 ? id.slice(0, 8) + '…' : id
const kindLabel = (row: MigrationSession) => row.kind === 'coding' ? '编程会话（' + (row.executor === 'claude-code' ? 'Claude Code' : 'Codex') + '）' : '群聊（旧机制：临时 Lead）'
const found = (row: MigrationNative) => row.found === null ? '未核对' : row.found ? '在' : '没找到'

export function formatMigrationManifest(manifest: GroupChatMigrationManifest, mode: 'preview' | 'apply' = 'preview'): string {
  const out: string[] = []
  const t = manifest.totals
  out.push('# 工作区群聊迁移清单（D3 / D5：旧会话与退役原生工单直接删）', '')
  out.push(mode === 'preview' ? '只预览，没有改动任何文件。确认无误后加 `--apply` 执行（服务需先停止）。' : '执行清单：')
  out.push('', '- 清单标识：`' + manifest.id + '`', '- 作用域：`' + manifest.scope + '`，看板：`' + manifest.boardPath + '`')
  if (manifest.homes.dsh || manifest.homes.codex || manifest.homes.claude) {
    out.push('- 核对过的原生目录：' + [manifest.homes.dsh && 'DSH ' + manifest.homes.dsh, manifest.homes.codex && 'Codex ' + manifest.homes.codex,
      manifest.homes.claude && 'Claude ' + manifest.homes.claude].filter(Boolean).join('；'))
  }
  out.push('', '## 汇总', '')
  out.push('- 删除旧会话 ' + t.sessions + ' 场、工单 ' + t.orders + ' 张、看板记录 ' + t.boardRows + ' 条、接口人提醒 ' + t.outbox + ' 条、对话记录目录 ' + t.dialogueDirs + ' 个')
  out.push('- 删除原生会话：DSH ' + t.dsh + ' 个、Codex thread ' + t.codex + ' 个、Claude Code 会话 ' + t.claude + ' 个')
  if (t.tickets) {
    out.push('- 删除退役原生工单 ' + t.tickets + ' 张：工单文件 ' + manifest.tickets.rows.filter(row => row.file).length + ' 个、交付目录（`work/T-xxxx` 与交付版本）' + t.ticketDirs
      + ' 个（共 ' + t.ticketDirFiles + ' 个文件）、工单桌等 DSH 会话 ' + t.desks + ' 个、看板退役记录 ' + t.ticketBoardRows + ' 条、提醒 ' + t.ticketOutbox + ' 条；'
      + '事件 ' + t.ticketEvents + ' 条清空正文（只留标识并记为已忽略），引用改动的文件 ' + t.references + ' 个')
  }
  if (manifest.dshIndex) out.push('- DSH 工作区登记：移除 ' + manifest.dshIndex.sessions + ' 个会话登记、' + manifest.dshIndex.workspaces.length + ' 个只为旧群建的 DSH 工作区（目录本身保留）')
  out.push('- 第二大脑是 git 仓库：本工具只改工作树、不提交；这些删除会出现在第二大脑的下一次自动提交里（删掉的内容仍可从 git 历史找回）')
  out.push('- 保留：工作区 ' + manifest.kept.workspaces.length + ' 个、新机制群 ' + manifest.kept.rosterSessions + ' 场、交付目录 ' + manifest.kept.workDirs.length
    + ' 个（共 ' + manifest.kept.workDirs.reduce((sum, row) => sum + row.files, 0) + ' 个文件）')
  out.push('', '## 将删除（按工作区 → 会话 → 工单）')
  for (const space of manifest.workspaces) {
    out.push('', '### 工作区「' + space.name + '」 `' + short(space.id) + '`', '')
    if (!space.sessions.length) out.push('- 没有旧会话')
    for (const row of space.sessions) {
      out.push('- **' + kindLabel(row) + '「' + row.title + '」** `' + row.id + '`' + (row.createdAt ? '，' + row.createdAt.slice(0, 16).replace('T', ' ') + ' 开' : '') + (row.closed ? '，已关闭' : ''))
      out.push('  - 工单：' + (row.orders.length ? row.orders.map(o => '「' + o.title + '」`' + short(o.id) + '`（' + (STATUS[o.status] ?? o.status) + '）').join('；') : '无'))
      out.push('  - 对话记录：' + (row.dialogue.exists ? '`' + row.dialogue.path + '`（' + row.dialogue.messages + ' 条发言、' + row.dialogue.turns + ' 轮、' + row.dialogue.attachments + ' 个附件快照'
        + (row.dialogue.commandLines ? '、命令日志 ' + row.dialogue.commandLines + ' 行' : '') + '）' : '无记录目录'))
      const counts = Object.entries(row.board).map(([key, n]) => COLLECTION[key as BoardCollection] + ' ' + n)
      out.push('  - 看板记录：' + (counts.length ? counts.join('、') : '无'))
      out.push('  - 接口人提醒：' + (row.outbox.length ? row.outbox.length + ' 条（' + row.outbox.map(key => '`' + key.slice(0, 60) + '`').join('、') + '）' : '无'))
      if (row.dsh.length) out.push('  - DSH 原生会话：' + row.dsh.map(n => '`' + n.id + '`（' + n.label + '，' + found(n) + '）').join('；'))
      if (row.codex.length) out.push('  - Codex thread：' + row.codex.map(n => '`' + n.id + '`（' + found(n) + '）').join('；'))
      if (row.claude.length) out.push('  - Claude Code 会话：' + row.claude.map(n => '`' + n.id + '`（' + found(n) + '）').join('；'))
      out.push('  - 交付目录（保留）：' + (row.workDirs.length ? row.workDirs.map(dir => '`' + dir.path + '`（' + dir.files + ' 个文件）').join('；') : '无'))
    }
    if (space.kept.length) out.push('- 保留的新机制群：' + space.kept.map(row => '「' + row.title + '」`' + short(row.id) + '`').join('、'))
  }
  if (manifest.tickets.rows.length) {
    out.push('', '## 将删除：退役原生工单（D5）', '')
    for (const row of manifest.tickets.rows) {
      out.push('- **' + row.id + '「' + row.title + '」**' + '（' + [row.staff, row.ended ? '已结束' : '未结束', row.createdAt && row.createdAt.slice(0, 10) + ' 开'].filter(Boolean).join('，') + '）')
      out.push('  - 工单文件：' + (row.file ? '`' + row.file + '`' : '已不在'))
      out.push('  - 交付目录：' + (row.dirs.length ? row.dirs.map(dir => '`' + dir.path + '`（' + dir.files + ' 个文件）').join('；') : '无'))
      out.push('  - DSH 会话：' + (row.dsh.length ? row.dsh.map(n => '`' + n.id + '`（' + n.label + '）').join('；') : '无'))
      out.push('  - 事件：' + row.events + ' 条清空正文；看板退役记录 ' + row.board + ' 条；提醒：' + (row.outbox.length ? row.outbox.map(key => '`' + key.slice(0, 60) + '`').join('、') : '无')
        + (row.remote.length ? '；工作电脑队列记录 ' + row.remote.length + ' 个' : ''))
    }
    if (manifest.tickets.references.length) out.push('- 去掉这些工单引用的文件：' + manifest.tickets.references.map(path => '`' + path + '`').join('、'))
  }
  out.push('', '## 保留（不动）', '')
  out.push('- 工作区：' + (manifest.kept.workspaces.map(row => '「' + row.name + '」').join('、') || '无'))
  out.push('- `work/superhub-v2/` 下全部交付目录 ' + manifest.kept.workDirs.length + ' 个（共 ' + manifest.kept.workDirs.reduce((sum, row) => sum + row.files, 0) + ' 个文件），以及 `work/` 下除上列 `work/T-xxxx` 以外的目录')
  out.push('- 幕僚（`ops/superhub-staff`，含本区职责与经验）、资料（`ops/superhub-history-*`）、档案导入、发件箱里与这些工单无关的提醒')
  if (manifest.kept.retiredOrders) out.push('- 看板里另有 ' + manifest.kept.retiredOrders + ' 张退役工单记录无法对应到原生工单编号，本迁移不碰')
  out.push('- 主人日记等正文里提到这些工单编号的文字不改')
  if (manifest.kept.otherDialogueDirs.length) out.push('- 看板里没有对应会话的记录目录 ' + manifest.kept.otherDialogueDirs.length + ' 个：' + manifest.kept.otherDialogueDirs.map(path => '`' + path + '`').join('、'))
  if (manifest.warnings.length) {
    out.push('', '## 请留意', '')
    for (const line of manifest.warnings) out.push('- ' + line)
  }
  if (manifest.blockers.length) {
    out.push('', '## 阻塞（不能执行）', '')
    for (const line of manifest.blockers) out.push('- ' + line)
  }
  if (!manifest.steps.length && !manifest.blockers.length) out.push('', '没有需要删除的旧会话或退役工单。')
  return out.join('\n') + '\n'
}

// ——— Apply ———

export type StepOutcome = 'done' | 'absent' | 'unchanged' | 'failed'
export interface StepResult { step: MigrationStep; outcome: StepOutcome; detail?: string }
export interface ApplyOptions extends SnapshotOptions {
  /** A manifest the owner reviewed; absent: planned now. Ignored while an earlier run is pending (that one is finished). */
  manifest?: GroupChatMigrationManifest
  /** The manifest id the owner confirmed: refuse when the run would use another one. */
  expect?: string
  /** Run again after a completed migration (only when new old-style sessions appeared). */
  again?: boolean
  /** Reasons to refuse (e.g. dsh-web is serving turns of these sessions). Any reason: nothing is changed. */
  live?: (manifest: GroupChatMigrationManifest) => string[] | Promise<string[]>
  /** Hold the brain's write lock while applying (default true; a host that already holds it passes false). */
  lock?: boolean
  /** Delete one Codex thread (the CLI goes through `codex app-server` `thread/delete`). Absent: Codex steps fail. */
  deleteCodexThread?: (id: string) => Promise<void>
  /** After each step (tests simulate a crash here). */
  checkpoint?: (result: StepResult) => void
  now?: () => Date
}
export interface ApplyReport { manifest: GroupChatMigrationManifest; resumed: boolean; results: StepResult[]; failures: StepResult[]; complete: boolean; already?: boolean; log: string }

/** Every step stays inside what the manifest names, and the manifest is exactly what its id says. */
export function checkManifest(manifest: GroupChatMigrationManifest, scope: string) {
  if (manifest?.schema !== 1 || manifest.scope !== scope) throw new Error('清单不属于这份第二大脑')
  if (manifestId(manifest) !== manifest.id) throw new Error('清单内容与标识不符，可能被改动过')
  if (manifest.boardPath !== workspaceBoardFile(scope)) throw new Error('清单里的看板路径不对')
  const sessions = new Set(manifest.sessionIds)
  const natives = (key: 'dsh' | 'codex' | 'claude') => new Set(manifest.workspaces.flatMap(space => space.sessions.flatMap(row => row[key].map(item => item.id))))
  const codex = natives('codex'), claude = natives('claude')
  const dsh = new Set([...natives('dsh'), ...manifest.tickets.rows.flatMap(row => row.dsh.map(item => item.id))])
  const listed = new Set(manifest.workspaces.flatMap(space => space.sessions.map(row => row.id)))
  for (const id of sessions) if (!listed.has(id)) throw new Error('清单里的会话 ' + id + ' 没有明细')
  const tickets = new Set(manifest.tickets.ids)
  if (manifest.tickets.ids.some(id => !TICKET_ID.test(id)) || manifest.tickets.rows.map(row => row.id).join() !== manifest.tickets.ids.join()) throw new Error('清单里的原生工单编号无效')
  for (const step of manifest.steps) {
    if (step.kind === 'board' && step.path !== manifest.boardPath) throw new Error('清单里的看板路径不对')
    if (step.kind === 'outbox' && step.path !== OUTBOX) throw new Error('清单里的发件箱路径不对')
    if (step.kind === 'dialogue-dir') {
      const parts = step.path.split(sep)
      if (!sessions.has(step.sessionId) || step.path !== sessionRecordsDir(scope, step.workspaceId, step.sessionId)
        || parts.length !== 4 || !parts.slice(2).every(part => HEX64.test(part))) throw new Error('清单里的目录不是旧会话在 ops/superhub-v2-dialogues 下的记录目录：' + step.path)
    }
    if (step.kind === 'dsh-session' && (!dsh.has(step.id) || !NATIVE_ID.test(step.id))) throw new Error('清单里的 DSH 会话标识无效：' + step.id)
    if (step.kind === 'codex-thread' && (!codex.has(step.id) || !THREAD_ID.test(step.id))) throw new Error('清单里的 Codex thread 标识无效：' + step.id)
    if (step.kind === 'claude-session' && (!claude.has(step.id) || !THREAD_ID.test(step.id))) throw new Error('清单里的 Claude Code 会话标识无效：' + step.id)
    if (step.kind === 'ticket-refs' && !isTicketReference(step.path)) throw new Error('清单里的工单引用文件不在允许范围：' + step.path)
    if (step.kind === 'ticket-remote' && !new RegExp('^ops/remote/(' + REMOTE_SETTLED.join('|') + ')/[A-Za-z0-9_-][A-Za-z0-9_.-]*\\.json$').test(step.path)) throw new Error('清单里的工作电脑队列记录不在允许范围：' + step.path)
    if (step.kind === 'ticket-file' && !tickets.has(step.id)) throw new Error('清单里的原生工单不在退役清单：' + step.id)
    if (step.kind === 'ticket-dir' && ![...tickets].some(id => step.path === 'work/' + id || step.path === 'ops/delivery-versions/' + id)) throw new Error('清单里的工单目录不是 work/T-xxxx 或交付版本目录：' + step.path)
  }
}

/** `path` strictly inside `parent` after resolving symlinks of `parent` (the entry itself is never followed). */
function inside(parent: string, path: string) {
  if (!existsSync(parent)) return false
  const base = realpathSync(parent)
  const real = realpathSync(dirname(path))
  return (real + sep).startsWith(base + sep) && !lstatSync(path).isSymbolicLink()
}
function writeJson(path: string, value: unknown, indent?: number) {
  const temporary = path + '.' + process.pid + '-' + Date.now() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(value, null, indent) + '\n', {flag: 'wx', mode: 0o600})
    renameSync(temporary, path)
  } finally { rmSync(temporary, {force: true}) }
}

/**
 * Execute the migration on `brain`. Refuses (changing nothing) while the brain's write lock is held by a running host,
 * a `live` reason is given, the manifest has blockers, or any step leaves what the manifest names. A run that stopped
 * part-way is resumed from its saved manifest.
 */
export async function applyGroupChatMigration(brain: string, options: ApplyOptions = {}): Promise<ApplyReport> {
  const root = realpathSync(brain)
  const files = new CleanupFiles(root)
  const {scope, origin} = resolveScope(root, options.scope)
  const now = options.now ?? (() => new Date())
  files.location(join('ops', '.chief.lock'))
  const unlock = options.lock === false ? () => {} : acquireLock(root, true)
  try {
    if (existsSync(join(root, 'ops', LEGACY_CLEANUP_PENDING))) throw new Error('旧工单清理（cleanup-legacy-orders）尚未完成，请先完成它')
    let migrated: MigrationSnapshot['migrated']
    try { migrated = JSON.parse(files.read(STATE)?.toString('utf8') ?? 'null')?.migratedGroupChat ?? undefined } catch { migrated = undefined }
    const pendingId = files.read(PENDING)?.toString('utf8').trim()
    let manifest: GroupChatMigrationManifest
    let resumed = false
    if (pendingId) {
      if (!/^[a-f0-9]{64}$/.test(pendingId)) throw new Error('迁移进度记录无效：' + PENDING)
      const saved = files.read(join(MIGRATION_DIR, pendingId + '.json'))
      if (!saved) throw new Error('迁移进度缺少对应清单：' + pendingId)
      manifest = JSON.parse(saved.toString('utf8')) as GroupChatMigrationManifest
      if (options.expect && options.expect !== manifest.id) throw new Error('上次的迁移（清单 ' + manifest.id + '）还没做完，请用这份清单继续')
      resumed = true
    } else {
      if (migrated && !options.again) {
        const done = options.manifest ?? planGroupChatMigration(readMigrationSnapshot(root, options))
        return {manifest: done, resumed: false, results: [], failures: [], complete: true, already: true, log: join(MIGRATION_DIR, migrated.manifestId + '.log')}
      }
      manifest = options.manifest ?? planGroupChatMigration(readMigrationSnapshot(root, options))
      if (options.expect && options.expect !== manifest.id) throw new Error('清单已变化（现在是 ' + manifest.id + '），请重新预览后再执行')
    }
    checkManifest(manifest, scope)
    if (manifest.blockers.length) throw new Error('清单有阻塞项，未执行：' + manifest.blockers.join('；'))
    const reasons = await options.live?.(manifest) ?? []
    if (reasons.length) throw new Error('现在不能执行：' + reasons.join('；'))
    const log = join(MIGRATION_DIR, manifest.id + '.log')
    if (!resumed) {
      files.write(join(MIGRATION_DIR, manifest.id + '.json'), Buffer.from(JSON.stringify(manifest, null, 1) + '\n'))
      files.write(PENDING, Buffer.from(manifest.id + '\n'))
    }
    const logLines: string[] = [files.read(log)?.toString('utf8') ?? '']
    const results: StepResult[] = []
    const context = ticketContext(manifest.tickets)
    const target = {sessions: new Set(manifest.sessionIds), orders: new Set(manifest.orderIds), tickets: context.tickets}
    const dshIds = new Set(manifest.steps.flatMap(step => step.kind === 'dsh-session' ? [step.id] : []))
    const workPaths = new Set([...manifest.workspaces.flatMap(space => space.sessions.filter(row => row.kind === 'group')
      .map(row => groupWorkPath(origin, scope, row.workspaceId, row.id))), ...manifest.tickets.ids.map(id => join(origin, 'work', id))])
    for (const step of manifest.steps) {
      let result: StepResult
      try { result = {step, ...await runStep(step)} }
      catch (error) { result = {step, outcome: 'failed', detail: (error as Error).message} }
      results.push(result)
      logLines.push(JSON.stringify({at: now().toISOString(), ...step, outcome: result.outcome, ...(result.detail && {detail: result.detail})}) + '\n')
      files.write(log, Buffer.from(logLines.join('')))
      options.checkpoint?.(result)
    }
    const failures = results.filter(row => row.outcome === 'failed')
    if (!failures.length) {
      files.write(STATE, Buffer.from(JSON.stringify({migratedGroupChat: {manifestId: manifest.id, at: now().toISOString(), sessions: manifest.sessionIds.length}}, null, 1) + '\n'))
      files.remove(PENDING)
    }
    return {manifest, resumed, results, failures, complete: !failures.length, log}

    async function runStep(step: MigrationStep): Promise<Omit<StepResult, 'step'>> {
      switch (step.kind) {
        case 'board': {
          const raw = files.read(step.path)
          if (!raw) return {outcome: 'absent'}
          const board = JSON.parse(raw.toString('utf8')) as BoardLike
          const changed = pruneBoard(board, target)
          if (!changed && board.migratedGroupChat?.manifestId === manifest.id) return {outcome: 'unchanged'}
          board.migratedGroupChat = {manifestId: manifest.id, at: now().toISOString()}
          // Same encoding as the store's own commit (one line, newline-terminated).
          files.write(step.path, Buffer.from(JSON.stringify(board) + '\n'))
          return {outcome: changed ? 'done' : 'unchanged'}
        }
        case 'outbox': {
          const raw = files.read(step.path)
          if (!raw) return {outcome: 'absent'}
          const {kept, removed} = pruneOutbox(list<Notice>(JSON.parse(raw.toString('utf8'))), target, context)
          if (!removed.length) return {outcome: 'unchanged'}
          files.write(step.path, Buffer.from(JSON.stringify(kept, null, 1) + '\n'))
          return {outcome: 'done', detail: removed.length + ' 条'}
        }
        case 'dialogue-dir': {
          const full = files.location(step.path)
          const stat = lstatSync(full, {throwIfNoEntry: false})
          if (!stat) return {outcome: 'absent'}
          if (!stat.isDirectory()) throw new Error('记录路径不是目录')
          const roster = readdirSync(full).filter(name => ROSTER_FILES.includes(name))
          if (roster.length) throw new Error('目录里有新群机制的文件（' + roster.join('、') + '），未删除')
          rmSync(full, {recursive: true})
          files.removeEmptyDirectory(dirname(step.path))
          return {outcome: 'done'}
        }
        case 'dsh-session': {
          if (!options.dshHome) throw new Error('没有提供 DSH 目录（--dsh-home）')
          const home = options.dshHome
          const dirs = dshSessionDirs(home, step.id)
          const projcache = join(home, 'storages', 'session_projcache', 'sessions', step.id + '.json')
          const cache = lstatSync(projcache, {throwIfNoEntry: false})?.isFile()
          if (!dirs.length && !cache) return {outcome: 'absent'}
          for (const dir of dirs) {
            if (!inside(join(home, 'sessions'), dir) || dirname(dirname(dir)) !== join(home, 'sessions')) throw new Error('DSH 会话目录不在 DSH 目录内：' + dir)
            rmSync(dir, {recursive: true})
            try { rmdirSync(dirname(dir)) } catch { /* other sessions still work in that directory */ }
          }
          if (cache && inside(join(home, 'storages', 'session_projcache', 'sessions'), projcache)) rmSync(projcache)
          return {outcome: 'done', detail: dirs.join('、')}
        }
        case 'ticket-refs': {
          const raw = files.read(step.path)?.toString('utf8')
          if (raw === undefined) return {outcome: 'absent'}
          const next = editTicketReference(step.path, raw, context)
          if (next === raw) return {outcome: 'unchanged'}
          files.write(step.path, Buffer.from(next))
          return {outcome: 'done'}
        }
        case 'ticket-remote':
        case 'ticket-file': {
          const path = step.kind === 'ticket-file' ? join('ops', 'tickets', step.id + '.json') : step.path
          const full = files.location(path)
          const stat = lstatSync(full, {throwIfNoEntry: false})
          if (!stat) return {outcome: 'absent'}
          if (!stat.isFile()) throw new Error('不是常规文件：' + path)
          files.remove(path)
          return {outcome: 'done'}
        }
        case 'ticket-dir': {
          const full = files.location(step.path)
          const stat = lstatSync(full, {throwIfNoEntry: false})
          if (!stat) return {outcome: 'absent'}
          if (!stat.isDirectory()) throw new Error('不是目录：' + step.path)
          rmSync(full, {recursive: true})
          return {outcome: 'done'}
        }
        case 'dsh-index': {
          if (!options.dshHome) throw new Error('没有提供 DSH 目录（--dsh-home）')
          const file = join(options.dshHome, 'storages', 'workspace.json')
          const stat = lstatSync(file, {throwIfNoEntry: false})
          if (!stat) return {outcome: 'absent'}
          if (!stat.isFile()) throw new Error('DSH 工作区登记不是常规文件')
          const raw = readFileSync(file, 'utf8')
          const index = JSON.parse(raw) as DshIndex
          const before = JSON.stringify(index)
          const result = pruneDshIndex(index, dshIds, workPaths)
          if (JSON.stringify(index) === before) return {outcome: 'unchanged'}
          writeJson(file, index, /^\{\n {2}"/.test(raw) ? 2 : undefined)
          return {outcome: 'done', detail: result.sessions + ' 个会话登记、' + result.workspaces.length + ' 个工作区'}
        }
        case 'codex-thread': {
          if (!options.codexHome) throw new Error('没有提供 Codex 目录（--codex-home）')
          const before = codexRollouts(options.codexHome, step.id)
          if (options.deleteCodexThread) {
            try { await options.deleteCodexThread(step.id) }
            catch (error) {
              if (before.length) throw error
              return {outcome: 'absent', detail: (error as Error).message}
            }
          } else if (before.length) throw new Error('需要 Codex 删除通道（codex app-server thread/delete）')
          else return {outcome: 'absent'}
          // thread/delete removes the rollout; what is left of it inside the Codex home goes too.
          for (const path of codexRollouts(options.codexHome, step.id)) {
            if (['sessions', 'archived_sessions'].some(part => inside(join(options.codexHome!, part), path))) rmSync(path)
          }
          return {outcome: 'done', ...(!before.length && {detail: '本机没有它的记录文件，已按标识请求删除'})}
        }
        case 'claude-session': {
          if (!options.claudeDir) throw new Error('没有提供 Claude 目录（--claude-dir）')
          const paths = claudeFiles(options.claudeDir, step.id)
          if (!paths.length) return {outcome: 'absent'}
          for (const path of paths) {
            if (!inside(join(options.claudeDir, 'projects'), path) || dirname(dirname(path)) !== join(options.claudeDir, 'projects')) throw new Error('Claude 会话文件不在 projects 目录内：' + path)
            rmSync(path, {recursive: true})
          }
          return {outcome: 'done', detail: paths.length + ' 项'}
        }
      }
    }
  } finally {
    unlock()
  }
}

const OUTCOME: Record<StepOutcome, string> = {done: '已删除', absent: '本来就不在', unchanged: '无需改动', failed: '失败'}
const STEP: Record<MigrationStep['kind'], string> = {board: '看板', outbox: '发件箱', 'dsh-session': 'DSH 会话', 'dsh-index': 'DSH 工作区登记',
  'ticket-refs': '工单引用', 'ticket-remote': '工作电脑队列记录', 'ticket-file': '原生工单', 'ticket-dir': '工单目录',
  'codex-thread': 'Codex thread', 'claude-session': 'Claude Code 会话', 'dialogue-dir': '对话记录目录'}
export function formatApplyReport(report: ApplyReport): string {
  if (report.already) return '这份第二大脑已完成群聊迁移，没有再执行（确有新的旧会话需要删时加 --again）。\n'
  const out = [(report.resumed ? '接着上次未完成的迁移执行' : '执行迁移') + '，清单 `' + report.manifest.id + '`：', '']
  for (const row of report.results) {
    const step = row.step
    const target = 'path' in step ? step.path : 'id' in step ? step.id : ''
    out.push('- ' + STEP[step.kind] + (target ? ' `' + target + '`' : '') + '：' + OUTCOME[row.outcome] + (row.detail ? '（' + row.detail + '）' : ''))
  }
  out.push('', report.complete ? '迁移完成。逐项日志：' + report.log : '有 ' + report.failures.length + ' 项没做完；修好后重跑同一命令会接着这份清单继续。逐项日志：' + report.log)
  return out.join('\n') + '\n'
}
