import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { LIAISON_AUTHOR, messageWorkOrder, type V2Attachment, type V2DialogueSource, type V2ExecutionView, type V2Interjection, type V2Message, type V2Session,
  type V2SteerOutcome, type V2Transcript, type V2TurnEvents, type V2TurnInput, type V2TurnProcess } from '../core/workspace-v2.ts'
import type { GateLease, GateTurn } from './coding-gate.ts'
import { appendCommandLog, EXECUTION_LIMIT, readCommandLog, type CommandLine, type GateLine } from './workspace-command-log.ts'
import { prepareStaffRun, type StaffRunOptions } from './workspace-staff-run.ts'
import type { HostContext } from './ports.ts'
import { beforeDispatch, CodingTurnError, codingTurn, executable, processSummary, type CodingSteer, type CodingTool, type CodingTurnResult } from './workspace-v2-coding.ts'
import { dialogueKey, groupOutcome, ownerMessageId, WorkspaceGroups, type GroupMember } from './workspace-v2-group.ts'
import { liaisonSpeakerId, workspaceSpeakerId } from './workspace-speaker-id.ts'
import { checkProjectDirectory } from './project-directory.ts'
import type { ExperienceRef, ExperienceSelection, WorkspaceExperiencePort } from '../core/workspace-experience.ts'
import { experienceDelta, experienceHistory, experiencePrompt, experienceRevoked } from './workspace-group-members.ts'

export interface CodingExperienceResult {
  workspaceId: string
  sessionId: string
  orderId?: string
  turnId: string
  messages: {id: string; text: string}[]
  commands: {itemId: string; command: string; exitCode: number; outputTail?: string}[]
  recovered: boolean
}

interface Options {
  ctx: HostContext
  root: string
  scope: string
  codex?: { executable: string; model?: string }
  claudeExecutable?: string
  staff?: StaffRunOptions
  experience?: WorkspaceExperiencePort
  onCodingResult?: (result: CodingExperienceResult) => void
  /** Command gate: installs the PreToolUse hook for each coding turn. Absent: tools run without hooks. */
  gate?: { open(turn: GateTurn, write: (line: GateLine) => void): GateLease }
  /** How long Codex has to confirm hook trust for a gated thread (default 5 s). */
  codexTrustWaitMs?: number
  /** Private storage outside the brain that is never a project directory (e.g. the plugin home). */
  internalDirectories?: string[]
}
interface Turn {
  staffToken?: string
  experience?: ExperienceRef[]
  experienceStaffId?: string
  experienceTask?: string
  id: string; text: string; state: 'sent' | 'done' | 'unknown' | 'unsent'; workOrderId?: string | null; silent?: boolean; single?: boolean; deliveryIssue?: string; replyIds?: string[]
  /** Coding tool process of this turn; absent for group turns and older journals. */
  process?: V2TurnProcess
  startedAt?: string
  endedAt?: string
  /** Native session continued by this turn, and the one the tool reported. */
  resumed?: string
  nativeSessionId?: string
  /** Model the tool reported for this turn. */
  model?: string
  /** Directory the coding tool ran in. */
  cwd?: string
  /** A continuation that failed before the model saw the prompt; the turn then started a new native session. */
  resumeFailure?: string
  /** One-line, redacted reason shown while the turn is unconfirmed. */
  failure?: string
  /**
   * Owner words sent while this turn ran. `pending` until the executor took them (`steered`) or the turn ended without
   * them (`missed`); the host then moves missed words to the next turn (`queued`) or reports them as not delivered.
   */
  interjections?: Interjection[]
  /** The liaison spoke this turn (see `V2TurnInput.liaison`). Absent on owner turns and on older journals. */
  liaison?: { handoff?: string }
}
interface Interjection { id: string; text: string; at: string; state: 'pending' | 'steered' | 'missed' | 'queued' | 'unsent' }
/** Every executor input names its speaker: the liaison hands over and follows up, the owner speaks directly. */
export const LIAISON_LABEL = '〔接口人〕'
export const OWNER_LABEL = '〔主人〕'
export const ORIGINAL_LABEL = '主人原话'
const SPEAKER_GUIDE = '发言以〔接口人〕开头的是接口人的交办、补充或追问，以〔主人〕开头的是主人本人直接对你说的话；两者都要采纳，冲突时以主人的话为准。'
const quoteBlock = (text: string) => text.split('\n').map(line => '> ' + line).join('\n')
/** What the executor receives for one turn: the speaker's label, and the owner's original wording after a liaison hand-over. */
export function turnWords(input: Pick<V2TurnInput, 'text' | 'liaison'>): string {
  if (!input.liaison) return OWNER_LABEL + input.text
  if (input.liaison.handoff === undefined) return LIAISON_LABEL + input.text
  return LIAISON_LABEL + input.liaison.handoff + '\n\n' + ORIGINAL_LABEL + '：\n' + quoteBlock(input.text)
}
/** A message as earlier history for a model: a relayed original stays with the liaison's words. */
const spoken = ({author, text, quote}: V2Message) => ({author, text: quote ? text + '\n\n' + quote.label + '：\n' + quote.text : text})
interface NativeSession { tool: CodingTool; sessionId: string; at: string; experience?: ExperienceRef[]; experienceSeen?: ExperienceRef[] }
/** The title of a coding session in the owner's Codex / Claude Code history: 〈工作区名〉 · 〈会话名〉. */
export function nativeSessionName(workspace: string | undefined, session: string): string {
  // One line in the tool's history: control characters and line breaks become spaces.
  const clean = (text: string) => text.replace(/[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
  const name = [workspace && clean(workspace), clean(session)].filter(Boolean).join(' · ')
  // Cut by code point, so an emoji is never split.
  const points = Array.from(name)
  return points.length > 80 ? points.slice(0, 79).join('') + '…' : name
}
interface ArchivedAttachment extends V2Attachment { locationId?: string }

interface Journal {
  messages: V2Message[]
  attachments: ArchivedAttachment[]
  turns: Turn[]
  members: GroupMember[]
  groupLead?: string
  groupExperience?: ExperienceRef[]
  groupExperienceTask?: string
  /** The first order may keep using the original working copy. Later orders have sibling directories. */
  workRootOrder?: string | null
  /**
   * Native coding session per working directory, continued by the next turn: SuperHub's directories relative to the
   * brain root, project directories by absolute path. Another directory never continues this one's session.
   */
  native?: Record<string, NativeSession>
}
interface SessionFiles { journal: string; work: string; commands: string }
const empty = (): Journal => ({ messages: [], attachments: [], turns: [], members: [] })
/** One turn may run for hours (long commands, waiting for an owner decision). The owner can stop it at any time. */
export const CODING_TURN_LIMIT_MS = 4 * 60 * 60_000
const formats: Record<string, V2Attachment['format']> = { '.md': 'markdown', '.txt': 'text', '.html': 'html', '.htm': 'html' }

export function scopedDirectory(root: string, parts: string[]): string {
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if (!existsSync(current)) mkdirSync(current, {mode: 0o700})
    if (realpathSync(current) !== current || !lstatSync(current).isDirectory()) throw new Error('会话目录已改变，无法核对来源。')
  }
  return current
}
function load(path: string): Journal {
  if (!existsSync(path)) return empty()
  if (realpathSync(path) !== path || !lstatSync(path).isFile()) throw new Error('会话存储的归属已改变。')
  return JSON.parse(readFileSync(path, 'utf8')) as Journal
}
function save(path: string, journal: Journal) {
  const tmp = path + '.' + randomUUID() + '.tmp'
  writeFileSync(tmp, JSON.stringify(journal), {flag: 'wx', mode: 0o600})
  renameSync(tmp, path)
}

/** Older journals still bind accepted RPCs and CLI item IDs to this session. A stored name alone carries no identity. */
function readSpeakers(session: V2Session, lead: string, journal: Journal): V2Message[] {
  if (journal.messages.every(m => m.speakerId)) return journal.messages
  const turns = new Map(journal.turns.map(turn => [ownerMessageId(lead, turn.id), turn]))
  return journal.messages.map(message => {
    if (message.speakerId) return message
    const turn = turns.get(message.id)
    if (turn?.text === message.text && message.role === 'user') return {...message, speakerId: 'owner'}
    if (turn?.id.startsWith('repair-') && message.role === 'agent' && turn.text === message.text) {
      return {...message, speakerId: workspaceSpeakerId(lead, 'host', 'delivery-review')}
    }
    if (journal.turns.length && session.kind === 'coding' && message.role === 'agent' && /^m-[a-f0-9]{32}$/.test(message.id)) {
      return {...message, speakerId: workspaceSpeakerId(lead, 'executor', session.executor)}
    }
    return message
  })
}

/** Snapshot only explicit output links resolving inside the public agent message's bound directory. */
function linkedFiles(text: string, messageId: string, work: string): ArchivedAttachment[] {
  const result: ArchivedAttachment[] = []
  for (const link of text.matchAll(/\[([^\]\n]{1,160})\]\((?:<([^>\n]+)>|([^()\s]+))\)/g)) {
    if (result.length >= 12) break
    let path: string
    try { path = decodeURIComponent(link[2] ?? link[3]!) } catch { continue }
    if (path.length > 4096 || /[:?#\\\x00-\x1f]/.test(path) || path.split('/').includes('..')) continue
    const format = formats[extname(path).toLowerCase()]
    if (!format) continue
    let fd: number | undefined
    try {
      const full = resolve(work, path), rel = relative(work, full)
      if (!rel || isAbsolute(rel) || rel.split(sep).some(part => part.startsWith('.')) || realpathSync(full) !== full) continue
      fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) continue
      if (process.platform === 'linux' && realpathSync('/proc/self/fd/' + fd) !== full) continue
      const data = Buffer.alloc(stat.size)
      let used = 0
      while (used < data.length) {
        const n = readSync(fd, data, used, data.length - used, used)
        if (!n) break
        used += n
      }
      const after = fstatSync(fd)
      if (used !== data.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) continue
      const content = data.toString('utf8')
      if (!data.equals(Buffer.from(content)) || content.includes('\0')) continue
      const id = 'a-' + dialogueKey(messageId, rel, content).slice(0, 36)
      if (!result.some(a => a.id === id)) result.push({id, label: link[1]!, format, content, locationId: dialogueKey(work, rel)})
    } catch { /* Missing or out-of-scope references stay in the author's original text. */ }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  return result
}

/** A named fenced document is published by its actual group author, inline in their message. */
function groupDocuments(message: V2Message): V2Attachment[] {
  const docs: V2Attachment[] = []
  const fence = /^(`{3,})(markdown|text|html)\s+title="([^"\n]{1,160})"\s*\r?\n([\s\S]*?)^\1[ \t]*\r?$/gm
  for (const match of message.text.matchAll(fence)) {
    if (docs.length === 12) break
    const content = match[4]!, label = match[3]!
    if (Buffer.byteLength(content) > 512 * 1024 || content.includes('\0')) continue
    docs.push({ id: 'a-' + dialogueKey(message.id, match.index + '', content).slice(0, 36), label, format: match[2] as V2Attachment['format'], content })
  }
  return docs
}

function contextText(input: V2TurnInput, orderId: string | undefined) {
  const ctx = input.context
  if (!ctx) return ''
  return '本工作区和当前工单的有效约定\n' + JSON.stringify({
    workspace: {name: ctx.workspace.name, goal: ctx.workspace.goal},
    delegations: ctx.delegations.filter(d => d.id === orderId).map(d => ({title: d.title, promise: d.promise, owner: d.owner, boundary: d.boundary})),
    decisions: ctx.decisions.filter(d => !d.delegationId || d.delegationId === orderId).map(d => ({text: d.text, version: d.version}))
  })
}

const groupOrders = (journal: Journal) => new Map(journal.turns.flatMap(t => t.workOrderId
  ? [[t.id, t.workOrderId] as const, ...(t.interjections ?? []).map(row => [row.id, t.workOrderId!] as const)] : []))
/** Messages a later turn of the same staff authorization may read: the owner's words, steered words and the replies. */
const staffMessages = (lead: string, t: Turn) => [ownerMessageId(lead, t.id), ...(t.interjections ?? []).filter(row => row.state === 'steered')
  .map(row => ownerMessageId(lead, row.id)), ...t.replyIds ?? []]
const selectedOrder = (session: V2Session, input: V2TurnInput) => input.workOrderId ?? (session.delegationIds.length === 1 ? session.delegationIds[0] : undefined)

export function createV2DialogueSource(options: Options): V2DialogueSource & {dispose(): void} {
  const {ctx, scope} = options
  const root = realpathSync(options.root)
  const groups = new WorkspaceGroups(ctx, scope)
  const shutdown = new AbortController()
  interface Live { id: string; text: string; orderId?: string; task?: Promise<void>; journal?: Journal; steer?: (input: V2Interjection) => Promise<V2SteerOutcome> }
  const pending = new Map<string, Live>()
  /** Which order owns SuperHub's session directory, per journal file and its last change (see `workDirectory`). */
  const ownership = new Map<string, {stamp: string; journal: Journal}>()
  /** Commands that started in a running turn but have not ended; only their end is written to the log. */
  const running = new Map<string, Map<string, CommandLine>>()

  function selectedBinary(session: V2Session) {
    if (session.kind !== 'coding') return
    if (session.executor === 'codex') return executable(options.codex?.executable || 'codex')
    if (session.executor === 'claude-code') return executable(options.claudeExecutable || 'claude')
  }

  /** SuperHub's working copy of an order: the first order keeps the session's directory, later ones have siblings. */
  function superhubRoot(journal: Journal, session: V2Session, orderId: string | undefined) {
    const owner = journal.workRootOrder !== undefined ? journal.workRootOrder : journal.turns.length ? session.legacyMessageOrder?.id ?? null : orderId ?? null
    if (owner === (orderId ?? null)) return
    const area = dialogueKey(scope, session.workspaceId)
    return [area, orderId ? dialogueKey(area, session.id, 'order', orderId) : dialogueKey(area, session.id, 'discussion')]
  }
  function files(session: V2Session): SessionFiles {
    const workspace = dialogueKey(scope, session.workspaceId), room = dialogueKey(workspace, session.id)
    const records = scopedDirectory(root, ['ops', 'superhub-v2-dialogues', workspace, room])
    const work = scopedDirectory(root, ['work', 'superhub-v2', workspace, room])
    // DSH discovers project instructions from cwd up to the nearest .git marker.
    if (session.kind === 'group') scopedDirectory(work, ['.git'])
    return {journal: join(records, 'source.json'), work, commands: join(records, 'commands.jsonl')}
  }
  /** `relay`: host-authored liaison words; links in them are never snapshotted as the liaison's deliverables. */
  function publish(journal: Journal, messages: V2Message[], work: string, group = false, relay = false) {
    let changed = false
    for (const msg of messages) {
      const at = journal.messages.findIndex(m => m.id === msg.id)
      const previous = journal.messages[at]
      if (group && msg.role === 'user' && (previous?.role !== 'user' || previous.text !== msg.text)) continue
      if (previous && previous.text === msg.text && previous.replyTo === msg.replyTo && previous.author === msg.author
        && (!msg.speakerId || previous.speakerId === msg.speakerId) && (!msg.workOrderId || previous.workOrderId === msg.workOrderId)
        && (!group || previous.at === msg.at)) continue
      const attachments = msg.role !== 'agent' || relay ? [] : group ? groupDocuments(msg) : linkedFiles(msg.text, msg.id, work)
      const visible = attachments.length ? {...msg, attachments: attachments.map(({id, label}) => ({id, label}))} : msg
      for (const a of attachments) if (!journal.attachments.some(stored => stored.id === a.id)) journal.attachments.push(a)
      if (at === -1) journal.messages.push(visible)
      else journal.messages[at] = {...previous, ...visible, at: group ? msg.at : previous!.at}
      changed = true
    }
    if (changed) journal.messages.sort((a, b) => a.at.localeCompare(b.at))
    return changed
  }
  /** Change the journal of a session; a running turn holds the current copy and saves it itself. */
  function amend(location: SessionFiles, change: (journal: Journal) => boolean) {
    const live = pending.get(location.journal)?.journal
    const journal = live ?? load(location.journal)
    if (change(journal)) save(location.journal, journal)
  }
  async function submit(session: V2Session, input: V2TurnInput, outer: AbortSignal, location: SessionFiles, entry: Live, events?: V2TurnEvents) {
    const journal = load(location.journal)
    const orderId = selectedOrder(session, input)
    if (orderId && !session.delegationIds.includes(orderId)) throw beforeDispatch('这张工单不属于本场会话。')
    const old = journal.turns.find(t => t.id === input.id)
    if (old) {
      if (old.text !== input.text || old.workOrderId !== undefined && old.workOrderId !== (orderId ?? null)) {
        throw Object.assign(new Error('这个请求标识已用于另一条发言。'), {status: 409, dispatched: false})
      }
      if (old.state === 'done') return
      if (old.state !== 'unsent') throw new Error('这条发言的派发结果仍待核对。')
    }
    if (session.closed && !input.acceptedStart || shutdown.signal.aborted || outer.aborted) throw beforeDispatch('会话或本次派发已经停止。')
    const control = new AbortController()
    const signal = AbortSignal.any([outer, shutdown.signal, control.signal, AbortSignal.timeout(CODING_TURN_LIMIT_MS)])
    const lead = groups.leadId(session.workspaceId, session.id)
    let group: Awaited<ReturnType<WorkspaceGroups['prepare']>> | undefined
    let groupSelection: ExperienceSelection | undefined
    let groupReopened = false
    let binary: string | undefined
    const job = input.context?.delegations.find(row => row.id === orderId && row.workspaceId === session.workspaceId && row.sessionId === session.id)
    const staff = job?.staffId ? prepareStaffRun(ctx,options.staff,session.workspaceId,job.staffId) : undefined
    let workDir = location.work
    let project: string | undefined
    let lease: GateLease | undefined
    const subprocess = ctx.get('subprocess')
    try {
      if (staff) options.staff!.current(staff.member)
      else if (session.kind === 'group' && session.executor === 'dsh') {
        const task = [job?.title, job?.promise, input.text].filter(Boolean).join('\n')
        const purposeTask = input.liaison && input.liaison.handoff === undefined ? '' : input.text
        groupSelection = options.experience?.selectExperience({workspaceId:session.workspaceId,task,purposeTask})
        if (groupSelection && experienceRevoked(groupSelection, journal.groupExperience)) {
          groupReopened = true
          journal.groupLead = lead + '-' + randomUUID().slice(0,8)
          journal.members = []
          journal.groupExperience = []
        }
        const groupLead = journal.groupLead ?? lead
        group = await groups.prepare(groupLead, location.work, session.title, signal, journal.members.some(m => m.id === groupLead))
        if (groupSelection) {
          journal.groupExperience = experienceHistory(journal.groupExperience, groupSelection.entries)
          journal.groupExperienceTask = purposeTask
        }
      }
      else {
        if (session.kind !== 'coding' || session.executor === 'dsh') throw beforeDispatch('本场会话的来源类型不匹配。')
        binary = selectedBinary(session)
        if (!subprocess || !binary) throw beforeDispatch('当前宿主没有可用的' + (session.executor === 'codex' ? ' Codex' : ' Claude Code') + '。')
        if (journal.workRootOrder === undefined) {
          // An existing working copy follows its original owner, including the session's general discussion.
          journal.workRootOrder = journal.turns.length ? session.legacyMessageOrder?.id ?? null : orderId ?? null
        }
        const sibling = superhubRoot(journal, session, orderId)
        if (sibling) workDir = scopedDirectory(root, ['work','superhub-v2',...sibling])
        if (input.directory) {
          // The owner's own project: checked again now, never created, and nothing of SuperHub's is written into it.
          try { project = checkProjectDirectory(input.directory, {brainRoot: root, internal: options.internalDirectories ?? []}) }
          catch (error) { throw beforeDispatch('项目目录不可用：' + (error instanceof Error ? error.message : input.directory) + '。请在工作区或工单里重新绑定目录后再发起。') }
          workDir = project
        }
        if (options.gate) {
          try {
            lease = options.gate.open({workspaceId: session.workspaceId, sessionId: session.id, ...(orderId && {orderId}), turnId: input.id,
              tool: session.executor === 'codex' ? 'codex' : 'claude-code', cwd: workDir}, line => appendCommandLog(location.commands, line))
          } catch (error) { throw beforeDispatch(error instanceof Error ? error.message : 'SuperHub 命令把关不可用，未启动编程工具。') }
        }
      }
      if (signal.aborted) throw beforeDispatch('本次派发已经停止。')
    } catch (error) {
      lease?.close()
      if (error instanceof Error && 'dispatched' in error) throw error
      throw beforeDispatch('当前会话的来源未就绪。')
    }
    const liaison = input.liaison
    const turn: Turn = {...(staff && {staffToken:staff.member.token}),id: input.id, text: input.text, state: 'sent', workOrderId: orderId ?? null,
      ...(liaison && {liaison: liaison.handoff === undefined ? {} : {handoff: liaison.handoff}})}
    // Owner words said while the turn waited for its directory are part of this turn.
    const merged = input.merged ?? []
    const words = [turnWords(input), ...merged.map(row => OWNER_LABEL + row.text)].join('\n\n')
    const userId = ownerMessageId(lead, input.id)
    const existingReplies = new Set(journal.messages.filter(m => m.role === 'agent').map(m => m.id))
    // Words queued from a busy turn are already in the transcript; they are this turn's words, not earlier history.
    const own = new Set([userId, ...merged.map(row => ownerMessageId(lead, row.id))])
    const earlier = journal.messages.filter(m => !own.has(m.id) && messageWorkOrder(session, m) === orderId)
    if (old) journal.turns[journal.turns.indexOf(old)] = turn
    else journal.turns.push(turn)
    if (group && !journal.members.length) journal.members.push({id: group.lead.id, name: 'lead'})
    const live = new Map<string, CommandLine>()
    let codingResult: CodingExperienceResult | undefined
    running.set(location.journal, live)
    try {
    const opening: V2Message = liaison ? {id: userId, role: 'agent', author: LIAISON_AUTHOR, speakerId: liaisonSpeakerId(lead), text: liaison.handoff ?? input.text,
        ...(liaison.handoff !== undefined && {quote: {label: ORIGINAL_LABEL, text: input.text}}), at: new Date().toISOString()}
      : {id: userId, role: 'user', author: '你', speakerId: 'owner', text: input.text, at: new Date().toISOString()}
    publish(journal, [{...opening, ...(orderId && {workOrderId:orderId})}], location.work, false, !!liaison)
    save(location.journal, journal)
    entry.journal = journal
    events?.dispatched?.()
    /** Record owner words for this turn before handing them over, so a restart cannot lose or repeat them. */
    const admit = (words: V2Interjection, state: 'pending' | 'steered') => {
      const row: Interjection = {id: words.id, text: words.text, at: new Date().toISOString(), state}
      turn.interjections = [...(turn.interjections ?? []), row]
      publish(journal, [{id: ownerMessageId(lead, words.id), role: 'user', author: '你', speakerId: 'owner', text: words.text, at: row.at,
        ...(orderId && {workOrderId: orderId}), delivery: state}], location.work)
      save(location.journal, journal)
      return row
    }
    const resolve = (id: string, state: 'steered' | 'missed') => {
      const row = turn.interjections?.find(item => item.id === id)
      if (!row || row.state !== 'pending') return
      row.state = state
      const message = journal.messages.find(item => item.id === ownerMessageId(lead, id))
      if (message && state === 'steered') message.delivery = 'steered'
    }
    /** Hand owner words to the executor while this turn runs; `deliver` says whether it took them. */
    const steerWith = (deliver: (words: V2Interjection) => Promise<V2SteerOutcome>) => {
      entry.steer = async words => {
        if (signal.aborted || turn.state !== 'sent' || turn.interjections?.some(row => row.id === words.id)) return 'rejected'
        if (words.workOrderId !== undefined && words.workOrderId !== orderId) return 'rejected'
        admit(words, 'pending')
        let outcome: V2SteerOutcome
        try { outcome = await deliver(words) } catch { outcome = 'rejected' }
        if (outcome !== 'pending') resolve(words.id, outcome === 'steered' ? 'steered' : 'missed')
        if (!shutdown.signal.aborted) save(location.journal, journal)
        return outcome
      }
    }
    try {
      const reportGuide = '实际提交纯文字工单结果时，第一行写「工单回报」或「阶段回报」，随后说明结果和仍未完成的事项。提问、计划和过程更新直接说。'
      const context = [contextText(input, orderId), orderId && reportGuide].filter(Boolean).join('\n')
      const experience = options.experience
      const ownerTask = merged.at(-1)?.text ?? (input.liaison && input.liaison.handoff === undefined ? '' : input.text)
      const select = (task: string, staffId?: string, purposeTask = ownerTask): ExperienceSelection | undefined => experience?.selectExperience({
        workspaceId: session.workspaceId, staffId,
        task: [job?.title, job?.promise, task].filter(Boolean).join('\n'), purposeTask,
        ...session.kind === 'coding' && !staffId && {domains: ['软件工程']},
      })
      const assertCurrent = (selection: ExperienceSelection | undefined, prior?: readonly ExperienceRef[]) => {
        if (!selection || !experience) return
        experience.assertExperienceCurrent(selection)
        if (prior?.length && experienceRevoked(experience.selectExperience(selection.query), prior)) {
          throw new Error('本轮使用的经验授权已变化。请从当前范围重新发起。')
        }
      }
      const acceptsSupplement = (selection: ExperienceSelection | undefined, prior: readonly ExperienceRef[] | undefined, text: string) => {
        if (!selection || !experience) return true
        try {
          const current = experience.selectExperience({...selection.query,purposeTask:text})
          return !experienceRevoked(current,[...selection.entries,...prior ?? []])
        } catch { return false }
      }
      if (staff && job && options.staff) {
        // One staff turn is one model call. Owner words stop the call and the same turn runs again with them. They count
        // as taken only once that answer is published; a failed rerun leaves them for the next turn.
        const added: V2Interjection[] = []
        let attempt = new AbortController(), answered = false
        steerWith(async words => {
          if (answered) return 'rejected'
          added.push(words)
          attempt.abort()
          return 'pending'
        })
        let answer: Awaited<ReturnType<typeof staff.answer>> | undefined
        let picked: ExperienceSelection | undefined, retained: ExperienceRef[] = []
        while (!answer) {
          const used = added.length
          const said = [words, ...added.map(row => OWNER_LABEL + row.text)].join('\n\n')
          const selection = select(said, staff.member.staffId, added.at(-1)?.text ?? ownerTask)
          const historical = journal.turns.filter(t => t.workOrderId === job.id && t.state === 'done' && t.staffToken === staff.member.token
            && (!selection || t.experience && !experienceRevoked(selection, t.experience)))
          const priorRefs = historical.reduce((all, row) => experienceHistory(all, row.experience), [] as ExperienceRef[])
          const authorized = new Set(historical.flatMap(t=>staffMessages(lead,t)))
          const prior = journal.messages.filter(m=>authorized.has(m.id)).map(spoken)
          try {
            assertCurrent(selection, priorRefs)
            const result = await staff.answer(context,prior,said,AbortSignal.any([signal, attempt.signal]), selection, () => {
              if (selection?.entries.length && experience) {
                try { experience.recordExperienceDelivery(selection, {
                  turnId: input.id, executorId: staff.member.staffId, sessionId: session.id, orderId: job.id,
                }) } catch (error) { ctx.logger?.warn('具名幕僚的经验回执没记下：%s', String(error)) }
              }
              assertCurrent(selection, priorRefs)
            })
            if (added.length === used) { answer = result; picked = selection; retained = priorRefs }
          } catch (error) {
            if (signal.aborted || !attempt.signal.aborted) throw error
          }
          if (attempt.signal.aborted) attempt = new AbortController()
        }
        answered = true
        const {reply,proposal} = answer
        signal.throwIfAborted()
        options.staff.current(staff.member)
        assertCurrent(picked, retained)
        if (picked) {
          turn.experience = experienceHistory(retained, picked.entries)
          turn.experienceStaffId = staff.member.staffId
          turn.experienceTask = picked.query.purposeTask ?? ownerTask
        }
        else options.staff.used(staff.member,job.id)
        const borrowed = new Set(staff.member.memories.filter(memory=>memory.shared).map(memory=>memory.id))
        const derived = proposal && (picked
          ? picked.entries.some(memory=>memory.shareId) || retained.some(memory=>borrowed.has(memory.id))
          : borrowed.size > 0)
        if (proposal && !derived) options.staff.propose(staff.member,job.id,input.id,proposal,picked)
        const output = derived ? reply + '\n\n本轮引用了可撤回的共享资料，经验建议仅保存在原工单。' : reply
        publish(journal,[{id:'m-'+dialogueKey(lead,input.id,staff.member.staffId).slice(0,32),role:'agent',author:staff.member.name,
          speakerId:workspaceSpeakerId(lead,'staff',staff.member.staffId),workOrderId:job.id,at:new Date().toISOString(),text:output}],location.work,true)
        for (const row of added) resolve(row.id, 'steered')
      } else if (group) {
        const instruction = '你在本工作区的具名讨论群中。需要协作者时使用本群原生团队工具，并让实际参与者自己发言。向群成员发送的文字会出现在群记录中。需要交付文件时，将全文放在 Markdown 围栏代码块里，首行写三个反引号、markdown、text 或 html，再写 title="文件名"。要引用本轮发言，可在消息开头单独写〔回复原话 "' + userId + '"〕。' + SPEAKER_GUIDE + '\n' + context
        const selection = groupSelection
        const behavior = selection && experiencePrompt(selection)
        const recap = groupReopened && earlier.filter(message => message.speakerId === 'owner').slice(-12).map(spoken)
        const ownerContext = recap && recap.length ? '同一工单此前的主人原话：\n' + JSON.stringify(recap) : ''
        const settled = new Map<string, boolean>()
        const root = group.lead.id
        // Read while the turn runs: the lead's answers after steered words belong to this turn's order as well.
        const orders = groupOrders(journal)
        steerWith(words => {
          if (!acceptsSupplement(selection,journal.groupExperience,words.text)) return Promise.resolve('rejected')
          if (orderId) orders.set(words.id, orderId)
          return groups.steer(root, input.id, words.id, OWNER_LABEL + words.text)
        })
        try {
          await groups.run(group.lead, group.teams, input.id, words, [instruction,behavior,ownerContext].filter(Boolean).join('\n\n'), signal, (rows, members) => {
            const changed = publish(journal, rows, location.work, true)
            if (changed || JSON.stringify(members) !== JSON.stringify(journal.members)) {
              journal.members = members
              save(location.journal, journal)
            }
          }, orders, settled, selection && {
            canonical:lead,
            validate: () => assertCurrent(selection,journal.groupExperience),
            confirmed: nativeSessionId => {
              if (!selection.entries.length || !experience) return
              try { experience.recordExperienceDelivery(selection, {
                turnId:input.id, executorId:nativeSessionId === root ? 'liaison' : nativeSessionId, sessionId:session.id, nativeSessionId, orderId,
              }) } catch (error) { ctx.logger?.warn('原生讨论的经验回执没记下：%s', String(error)) }
            },
          })
        } finally {
          for (const [id, taken] of settled) resolve(id, taken ? 'steered' : 'missed')
        }
      } else {
        const tool: CodingTool = session.executor === 'codex' ? 'codex' : 'claude-code'
        const selection = select(words)
        // A thread continued with another directory would silently move there; each directory keeps its own session.
        const nativeKey = project ?? (relative(root, workDir) || '.')
        const known = journal.native?.[nativeKey]
        const revoked = !!selection && experienceRevoked(selection, known?.experience)
        const resumable = known?.tool === tool && !revoked ? known.sessionId : undefined
        const invalidReplies = new Set(selection ? journal.turns.filter(row => experienceRevoked(selection,row.experience))
          .flatMap(row => row.replyIds ?? []) : [])
        const replayable = earlier.filter(message => message.speakerId === 'owner' || !revoked && !invalidReplies.has(message.id)).map(spoken)
        // A continued native session already holds the earlier conversation; only this turn is sent.
        const prompt = (replay: boolean) => [project
          ? '你在主人的项目目录中工作（就是当前工作目录），按项目自己的约定行事，不要在项目里另建 SuperHub 的文件。需要把文本、Markdown 或 HTML 文件交给主人查看时，用相对路径的 Markdown 链接附在回复中。' + SPEAKER_GUIDE
          : '你在独立的工作区会话中直接回复。交付本会话生成的文本、Markdown 或 HTML 文件时，用相对路径的 Markdown 链接附在回复中。' + SPEAKER_GUIDE,
          context, replay && replayable.length ? '本场会话已公开的发言（按顺序，保留上下文）\n' + JSON.stringify(replayable) : '',
          '本轮发言\n' + words].filter(Boolean).join('\n\n')
        turn.startedAt = new Date().toISOString()
        turn.cwd = workDir
        let steer: CodingSteer | undefined
        steerWith(async said => {
          const previous = turn.resumed ? known?.experience : undefined
          if (!acceptsSupplement(selection,previous,said.text)) return 'rejected'
          assertCurrent(selection, previous)
          return steer ? steer(said.id, OWNER_LABEL + said.text) : 'rejected'
        })
        const settle = (result: CodingTurnResult | undefined) => {
          for (const row of result?.interjections ?? []) resolve(row.id, row.delivered ? 'steered' : 'missed')
          steer = undefined
        }
        const results: CodingExperienceResult['commands'] = []
        let revokedDuringRun = false
        const run = (resume?: string) => {
          const history = resume ? known?.experience : undefined
          if (selection) turn.experience = experienceHistory(history, selection.entries)
          const seen = resume ? known?.experienceSeen : undefined
          const sent = selection ? experienceDelta(selection, seen) : []
          const current = () => {
            try { assertCurrent(selection, history) }
            catch { revokedDuringRun = true; throw new Error('编程工具使用的经验授权已变化，请在当前范围重新发起。') }
          }
          let nativeSession: string | undefined, submitting = false
          const saveBinding = (sessionId: string, taken = false) => {
            if (signal.aborted) return
            turn.nativeSessionId = sessionId
            journal.native = {...journal.native, [nativeKey]: {tool, sessionId, at: new Date().toISOString(),
              ...selection && {experience: experienceHistory(history, submitting ? sent : []),
                experienceSeen: experienceHistory(seen, taken ? sent : [])}}}
            save(location.journal, journal)
          }
          const body = prompt(!resume)
          return codingTurn(subprocess!, tool, binary!, workDir, selection ? experiencePrompt(selection, sent) + '\n\n' + body : body, signal, {
            launch: {model: tool === 'codex' ? options.codex?.model : undefined, ...(resume && {resume}), ...(lease && {extraArgs: lease.args}),
              name: nativeSessionName(input.context?.workspace.name, session.title)},
            ...(lease && {env: lease.env}),
            ...(lease && tool === 'codex' && {gate: lease, ...(options.codexTrustWaitMs !== undefined && {trustWaitMs: options.codexTrustWaitMs})}),
            onSteerable: handle => { steer = handle },
            beforeInput: () => {
              current()
              submitting = true
              if (nativeSession && selection) saveBinding(nativeSession)
            },
            onInputAccepted: nativeSessionId => {
              if (selection) saveBinding(nativeSessionId, true)
              if (selection?.entries.length && experience) {
                try {
                  experience.recordExperienceDelivery(selection, {turnId: input.id, executorId:tool, sessionId:session.id, nativeSessionId, orderId})
                } catch (error) { ctx.logger.warn('编程工具的经验回执没记下：%s', String(error)) }
              }
              current()
            },
            publish: (item, text) => {
              signal.throwIfAborted()
              current()
              const row: V2Message = {id: 'm-' + dialogueKey(lead, input.id, item).slice(0, 32), role: 'agent', author: tool === 'codex' ? 'Codex' : 'Claude Code',
                speakerId: workspaceSpeakerId(lead, 'executor', tool),
                at: new Date().toISOString(), text, ...(orderId && {workOrderId:orderId})}
              if (publish(journal, [row], workDir)) {
                if (selection) (turn.replyIds ??= []).push(row.id)
                save(location.journal, journal)
              }
            },
            onSession: sessionId => {
              nativeSession = sessionId
              saveBinding(sessionId)
            },
            onCommand: event => {
              current()
              const id = 'c-' + dialogueKey(lead, input.id, event.itemId).slice(0, 32)
              const at = new Date().toISOString()
              const row: CommandLine = live.get(id) ?? {kind: 'command', id, itemId: event.itemId, turnId: input.id, workOrderId: orderId ?? null, at,
                tool: event.tool, command: event.command, cwd: workDir}
              if (event.phase === 'start') { live.set(id, row); return }
              live.delete(id)
              appendCommandLog(location.commands, {...row, endedAt: at, ...(event.exitCode !== undefined && {exitCode: event.exitCode}),
                ...(event.failed && {failed: true}), ...(event.outputTail && {outputTail: event.outputTail}), ...(event.unmatched && {unmatched: true})})
              if (event.command && typeof event.exitCode === 'number' && !event.unmatched) {
                results.push({itemId:row.id, command:event.command, exitCode:event.exitCode, outputTail:event.outputTail})
              }
            },
          }).then(result => { current(); return result })
        }
        let result: CodingTurnResult
        if (resumable) turn.resumed = resumable
        try { result = await run(resumable) }
        catch (error) {
          settle(error instanceof CodingTurnError ? error.result : undefined)
          // Only a continuation that never reached the model is retried, as a new session with the public history.
          if (!resumable || revokedDuringRun || !(error instanceof CodingTurnError) || error.result.started || signal.aborted) throw error
          turn.resumeFailure = processSummary(error.result.process)
          delete turn.resumed
          if (journal.native?.[nativeKey]?.sessionId === resumable) delete journal.native[nativeKey]
          save(location.journal, journal)
          try { result = await run() }
          catch (retry) { settle(retry instanceof CodingTurnError ? retry.result : undefined); throw retry }
        }
        settle(result)
        turn.process = result.process
        if (result.model) turn.model = result.model
        turn.endedAt = new Date().toISOString()
        const earlierFailure = journal.turns.slice(0, journal.turns.indexOf(turn)).findLast(row => row.workOrderId === turn.workOrderId)
        codingResult = {workspaceId:session.workspaceId, sessionId:session.id, orderId, turnId:input.id,
          messages:[], commands:results, recovered:earlierFailure?.state === 'unknown'}
      }
      signal.throwIfAborted()
      turn.state = 'done'
      // Liaison notes posted meanwhile (acceptance verdicts) are not the executor's answer.
      const replies = journal.messages.filter(m => m.role === 'agent' && m.id !== userId && !existingReplies.has(m.id) && m.speakerId !== liaisonSpeakerId(lead))
      turn.replyIds = replies.map(message => message.id)
      if (codingResult) codingResult.messages = replies.map(({id,text}) => ({id,text}))
      turn.silent = replies.length === 0
      turn.single = !staff && !group && replies.length === 1
    } catch (error) {
      // Words the executor never took can still go to the next turn.
      for (const row of turn.interjections ?? []) if (row.state === 'pending' || staff && row.state === 'steered') {
        row.state = 'missed'
        const message = journal.messages.find(item => item.id === ownerMessageId(lead, row.id))
        if (message) message.delivery = 'pending'
      }
      if (staff) {
        turn.state = 'unsent'
        turn.deliveryIssue = '幕僚未提交本轮成果。' + (error instanceof Error && error.message.startsWith('幕僚') ? error.message : '请核对当前模型与资料范围后继续。')
        throw beforeDispatch(turn.deliveryIssue)
      }
      if (error instanceof CodingTurnError) {
        turn.process = error.result.process
        if (error.result.model) turn.model = error.result.model
        turn.endedAt = new Date().toISOString()
      }
      // A tool that refused before the model saw anything (account refusal, unconfirmed hook trust) has not dispatched.
      if (error instanceof Error && 'dispatched' in error && error.dispatched === false) {
        turn.state = 'unsent'
        turn.deliveryIssue = error.message
        throw error
      }
      const detail = !signal.aborted && error instanceof Error && error.message.startsWith('编程工具') ? error.message : undefined
      control.abort()
      turn.state = 'unknown'
      if (detail) turn.failure = detail
      throw new Error(detail || '本轮来源未确认完成，已收到的原话仍可查阅。')
    } finally {
      for (const row of turn.interjections ?? []) if (row.state === 'pending') row.state = 'missed'
      entry.steer = undefined
      if (!shutdown.signal.aborted) save(location.journal, journal)
    }
    if (turn.state === 'done' && codingResult && !shutdown.signal.aborted) {
      try { options.onCodingResult?.(codingResult) }
      catch (error) { ctx.logger.warn('编程回合的经验材料没记下：%s', String(error)) }
    }
    } finally {
      entry.steer = undefined
      lease?.close()
      running.delete(location.journal)
      // The tool never reported an end for these; the turn's end closes them in the record.
      for (const row of live.values()) {
        try { appendCommandLog(location.commands, {...row, unfinished: true}) } catch { /* the turn's process record remains */ }
      }
    }
  }
  async function refreshGroup(session: V2Session, location: SessionFiles) {
    const stored = load(location.journal)
    if (!stored.members.length || pending.has(location.journal) || !ctx.get('sessionQuery')) return
    const canonical = groups.leadId(session.workspaceId, session.id)
    const lead = stored.groupLead ?? canonical
    const authorized = () => !stored.groupExperience?.length || !options.experience || !experienceRevoked(options.experience.selectExperience({
      workspaceId:session.workspaceId, task:stored.groupExperienceTask ?? '',
    }), stored.groupExperience)
    if (!authorized()) return
    const idle = groups.idleMembers(lead, location.work)
    const members = idle || stored.members
    const {messages,events} = await groups.observe(lead, members, AbortSignal.any([shutdown.signal, AbortSignal.timeout(2000)]), groupOrders(stored), canonical)
    shutdown.signal.throwIfAborted()
    if (pending.has(location.journal) || !authorized()) return
    const current = load(location.journal)
    if (stored.groupLead !== current.groupLead) return
    let changed = publish(current, messages, location.work, true)
    if (idle && JSON.stringify(idle) === JSON.stringify(groups.idleMembers(lead, location.work))) {
      if (JSON.stringify(current.members) !== JSON.stringify(idle)) { current.members = idle; changed = true }
      for (const turn of current.turns) {
        if (turn.state !== 'done' && groupOutcome(events, turn.id) === 'done') { turn.state = 'done'; changed = true }
      }
    }
    if (changed) save(location.journal, current)
  }
  return {
    experienceSource(session, turnId) {
      const turn = load(files(session).journal).turns.find(row => row.id === turnId && row.state === 'done')
      if (turn) return {refs: turn.experience ?? [], staffId: turn.experienceStaffId}
    },
    resultFileIdentity(session, fileId) {
      return load(files(session).journal).attachments.find(file => file.id === fileId)?.locationId
    },
    staffSources(session,orderId,token) {
      const journal = load(files(session).journal)
      const lead = groups.leadId(session.workspaceId,session.id)
      const current = (turn: Turn) => {
        if (!options.experience || !turn.experience?.length) return true
        try {
          return !experienceRevoked(options.experience.selectExperience({workspaceId:session.workspaceId,
            task:turn.experienceTask ?? turn.text, staffId:turn.experienceStaffId}), turn.experience)
        } catch { return false }
      }
      return new Set(journal.turns.filter(t=>t.state === 'done' && t.workOrderId===orderId && t.staffToken===token && current(t))
        .flatMap(t=>staffMessages(lead,t)))
    },
    workDirectory(session, workOrderId) {
      if (session.kind !== 'coding') return
      // Read-only: the directories are created when a turn first runs there. Pages poll this, so the journal's
      // ownership facts are cached until the journal changes.
      const workspace = dialogueKey(scope, session.workspaceId), room = dialogueKey(workspace, session.id)
      const path = join(root, 'ops', 'superhub-v2-dialogues', workspace, room, 'source.json')
      let stamp = 'missing'
      try { const stat = lstatSync(path); stamp = stat.mtimeMs + ':' + stat.size } catch { /* no turn yet */ }
      let facts = ownership.get(path)
      if (facts?.stamp !== stamp) {
        const journal = load(path)
        facts = {stamp, journal: {...empty(), turns: journal.turns.length ? [journal.turns[0]!] : [], ...(journal.workRootOrder !== undefined && {workRootOrder: journal.workRootOrder})}}
        ownership.set(path, facts)
      }
      const sibling = superhubRoot(facts.journal, session, workOrderId)
      return join(root, 'work', 'superhub-v2', ...sibling ?? [workspace, room])
    },
    savedResults(session, requestId) {
      const workspace = dialogueKey(scope, session.workspaceId), room = dialogueKey(workspace, session.id)
      const journal = load(join(root, 'ops', 'superhub-v2-dialogues', workspace, room, 'source.json'))
      const index = journal.turns.findIndex(turn => turn.id === requestId)
      const turn = journal.turns[index]
      if (!turn || turn.state !== 'done') return
      const lead = groups.leadId(session.workspaceId, session.id)
      const ownerId = ownerMessageId(lead, requestId)
      const start = journal.messages.findIndex(message => message.id === ownerId)
      if (start === -1) return
      const orderId = turn.workOrderId === undefined ? messageWorkOrder(session, journal.messages[start]!) : turn.workOrderId
      const next = journal.turns[index + 1]
      const end = next ? journal.messages.findIndex(message => message.id === ownerMessageId(lead, next.id)) : journal.messages.length
      const submitted = turn.replyIds ? new Set(turn.replyIds) : undefined
      const messages = (submitted ? journal.messages : journal.messages.slice(start + 1, end < 0 ? start + 1 : end))
        .filter(message => message.role === 'agent' && (!submitted || submitted.has(message.id)) &&
          messageWorkOrder(session, message) === orderId)
      const refs = new Set(messages.flatMap(message => (message.attachments ?? []).map(file => file.id)))
      return { messages, attachments: journal.attachments.filter(file => refs.has(file.id))
        .map(({locationId: _locationId, ...file}) => file) }
    },
    briefEvidence(session, turnId, orderId) {
      const journal = load(files(session).journal)
      const turn = journal.turns.find(row => row.id === turnId && (!row.workOrderId || row.workOrderId === orderId))
      const replies = journal.messages.filter(msg => msg.role === 'agent' && messageWorkOrder(session,msg) === orderId)
      for (const reply of [...replies].reverse()) {
        for (const ref of reply.attachments ?? []) {
          const document = journal.attachments.find(file => file.id === ref.id && file.format === 'markdown')
          if (document) return {text:turn?.text,report:{label:document.label,text:document.content}}
        }
        if (/^#\s+\S/m.test(reply.text)) return {text:turn?.text,report:{text:reply.text}}
      }
      return {text:turn?.text}
    },
    async read(session): Promise<V2Transcript> {
      const location = files(session)
      let issue: string | undefined
      let complete = true
      if (session.kind === 'group') {
        try { await refreshGroup(session, location) }
        catch { complete = false; issue = '群聊来源暂不可用，显示上次已经读到的发言。' }
      }
      const journal = load(location.journal)
      const open = journal.turns.filter(t => t.state === 'sent' || t.state === 'unknown')
      if (open.length) issue ||= pending.has(location.journal) ? '正在等候本轮回复。' : open.at(-1)!.failure || '本轮来源尚未确认完成。'
      issue ||= journal.turns.at(-1)?.deliveryIssue
      if (!issue && journal.turns.at(-1)?.silent) issue = '本轮已结束，来源没有返回可展示的发言。'
      if (!issue && journal.turns.at(-1)?.single) issue = '本轮已结束，来源只提供了一条公开答复。'
      if (!issue && !journal.turns.length && !session.closed) {
        if (session.kind === 'group' && !groups.available()) issue = 'DSH 群聊来源暂不可用。'
        if (session.kind === 'coding' && (!selectedBinary(session) || !ctx.get('subprocess'))) issue = '本机没有可用的' + (session.executor === 'codex' ? ' Codex' : ' Claude Code') + '。'
      }
      // Words that were with the executor when the host stopped have an unknown outcome.
      const live = pending.has(location.journal)
      const lead = groups.leadId(session.workspaceId, session.id)
      // Before the liaison spoke itself, a hand-over or supplement put the owner's words into the conversation as they were.
      const relayed = new Set(journal.turns.filter(turn => /^(start|follow)-/.test(turn.id) && !turn.liaison).map(turn => ownerMessageId(lead, turn.id)))
      const messages = readSpeakers(session, lead, journal)
        .map(message => message.delivery === 'pending' && !live ? {...message, delivery: 'unknown' as const} : message)
        .map(message => message.role === 'user' && relayed.has(message.id) ? {...message, relayed: true as const} : message)
      return {messages, ...(issue ? {issue, complete} : {})}
    },
    async confirmed(session, requestId) {
      const location = files(session)
      const result = () => load(location.journal).turns.find(t => t.id === requestId)?.state
      const state = result()
      if (state === 'done') return true
      if (session.kind !== 'group' || !state) return false
      await refreshGroup(session, location)
      return result() === 'done'
    },
    async send(session, input, signal, events) {
      const location = files(session)
      const running = pending.get(location.journal)
      const orderId = selectedOrder(session, input)
      if (running) {
        if (running.id === input.id && running.text === input.text && running.orderId === orderId) return running.task
        // The host serializes turns and sends later words through `interject`; two turns never run side by side.
        throw beforeDispatch('本场会话正在进行另一轮，这句话会排到下一轮。')
      }
      const entry: Live = {id: input.id, text: input.text, orderId}
      pending.set(location.journal, entry)
      const task = submit(session, input, signal, location, entry, events)
      entry.task = task
      try { await task } finally { if (pending.get(location.journal) === entry) pending.delete(location.journal) }
    },
    async interject(session, turnId, words) {
      const live = pending.get(files(session).journal)
      if (!live || live.id !== turnId || !live.steer) return 'rejected'
      return live.steer(words)
    },
    interjections(session, turnId) {
      const turn = load(files(session).journal).turns.find(row => row.id === turnId)
      return (turn?.interjections ?? []).filter(row => row.state === 'steered' || row.state === 'missed')
        .map(row => ({id: row.id, delivered: row.state === 'steered'}))
    },
    markInterjection(session, words, state) {
      const location = files(session)
      const lead = groups.leadId(session.workspaceId, session.id)
      const id = ownerMessageId(lead, words.id)
      amend(location, journal => {
        for (const turn of journal.turns) for (const row of turn.interjections ?? []) if (row.id === words.id) row.state = state
        const message = journal.messages.find(item => item.id === id)
        if (message) {
          if (message.delivery === state) return false
          message.delivery = state
          return true
        }
        // Words queued without reaching a running turn appear where they were said.
        journal.messages.push({id, role: 'user', author: '你', speakerId: 'owner', text: words.text, at: new Date().toISOString(),
          ...(words.workOrderId && {workOrderId: words.workOrderId}), delivery: state})
        journal.messages.sort((a, b) => a.at.localeCompare(b.at))
        return true
      })
    },
    execution(session, workOrderId): V2ExecutionView {
      const location = files(session)
      const journal = load(location.journal)
      const order = workOrderId ?? null
      const tool = session.executor === 'codex' ? 'codex' : 'claude-code'
      const log = readCommandLog(location.commands, order, [...running.get(location.journal)?.values() ?? []])
      return {
        commands: log.commands,
        permissions: log.permissions,
        runs: journal.turns.filter(turn => turn.process && (turn.workOrderId ?? null) === order).slice(-EXECUTION_LIMIT).map(turn => ({
          turnId: turn.id, workOrderId: order, tool, state: turn.state, process: turn.process!,
          ...(turn.startedAt && {startedAt: turn.startedAt}), ...(turn.endedAt && {endedAt: turn.endedAt}),
          ...(turn.resumed && {resumed: true}), ...(turn.nativeSessionId && {nativeSessionId: turn.nativeSessionId}), ...(turn.model && {model: turn.model}),
          ...(turn.cwd && {cwd: turn.cwd}),
        })),
      }
    },
    note(session, note) {
      const location = files(session)
      const lead = groups.leadId(session.workspaceId, session.id)
      const id = 'l-' + dialogueKey(lead, note.id).slice(0, 32)
      amend(location, journal => publish(journal, [{id, role: 'agent', author: LIAISON_AUTHOR,
        speakerId: liaisonSpeakerId(lead), text: note.text, at: new Date().toISOString(), ...(note.workOrderId && {workOrderId: note.workOrderId})}], location.work, false, true))
      return id
    },
    hold(session, words) {
      const location = files(session)
      const id = ownerMessageId(groups.leadId(session.workspaceId, session.id), words.id)
      // The same id as a later dispatch of these words, which then keeps this message where it was said.
      amend(location, journal => {
        if (journal.messages.some(item => item.id === id)) return false
        journal.messages.push({id, role: 'user', author: '你', speakerId: 'owner', text: words.text, at: words.at ?? new Date().toISOString(),
          ...(words.workOrderId && {workOrderId: words.workOrderId})})
        journal.messages.sort((a, b) => a.at.localeCompare(b.at))
        return true
      })
      return id
    },
    recordPermission(session, workOrderId, change) {
      appendCommandLog(files(session).commands, {kind: 'permission', id: 'p-' + randomUUID(), workOrderId, at: change.at, from: change.from, to: change.to, by: 'owner'})
    },
    async attachment(session, id) {
      const journal = load(files(session).journal)
      if (journal.messages.some(m => m.attachments?.some(ref => ref.id === id))) {
        const file = journal.attachments.find(a => a.id === id)
        if (file) {
          const {locationId: _locationId, ...attachment} = file
          return attachment
        }
      }
    },
    dispose() { shutdown.abort(); groups.dispose() }
  }
}
