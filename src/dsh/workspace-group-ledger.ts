/**
 * 一场工作区群聊的账本：群目录下只追加的 `ledger.jsonl`，一行一条，序号 `seq` 从 1 单调递增，旧行永不改写。
 * 唯一写入口是 `say()`；界面、成员提示、验收都从这里读（任务 design §1，参照 DS-Bot `host/ledger.js` 与
 * `groups.js:571-588` 的 `say(room, line)`）。
 *
 * - 追加：每行一次 `O_APPEND` 写入；上次崩溃留下的半行先补一个换行再写，之后的行仍可读。
 * - 读取：整本读入内存（首次打开时），读不出或序号不前进的行跳过，所以撕裂的最后一行不影响其余。
 * - 已读点：每位成员读到的序号存在同目录 `seen.json`（临时文件 + 改名原子替换），只前进不后退。
 * 由持有本脑锁的运行时单写；不引第三方依赖。
 */
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync, constants } from 'node:fs'
import { join } from 'node:path'
import { isChatInputAttachment, type ChatInputAttachment } from '../core/chat-attachments.ts'
import type { ExperienceRef } from '../core/workspace-experience.ts'

export const GROUP_LEDGER_FILE = 'ledger.jsonl'
export const GROUP_SEEN_FILE = 'seen.json'
/** 第一次被叫时看最近几行；之后只看上次读到之后别人的行，最多几行（DS-Bot groups.js:39-40 `ROOM_FIRST_LOOK` / `ROOM_DELTA_MAX`）。 */
export const LEDGER_FIRST_LOOK = 12
export const LEDGER_DELTA_MAX = 24

export type GroupLineKind = 'message' | 'progress' | 'event'
export const GROUP_LINE_KINDS: readonly GroupLineKind[] = ['message', 'progress', 'event']

export interface GroupAttachment {
  name: string; path: string; mime?: string; size?: number
  /** Digest of the published bytes (missing on messages written before versioning). */
  version?: string
}

export interface GroupLine {
  seq: number
  traceId?: string
  /** ISO 时间。 */
  at: string
  /** `message` 发言；`progress` 成员干活中途的话；`event` 宿主写的事件行（超时、暂停、叫停……，界面淡色）。 */
  kind: GroupLineKind
  /** `owner`、成员 id，或事件行的 `host`。 */
  speakerId: string
  author: string
  text: string
  /** 这行叫到的成员 id（按出现顺序，不含发言人）。 */
  mentions: string[]
  /** 用了全员词（`@所有人` 等）；是否真的叫全员由调度器按发言人判定。 */
  all?: true
  /** 这行回应的那一行的序号。 */
  replyTo?: number
  workOrderId?: string
  batchId?: string
  attachments?: GroupAttachment[]
  inputAttachments?: ChatInputAttachment[]
  /** 事件行的原因代码（`missed`、`paused`、`stopped`……）。 */
  event?: string
  /** 随这行一起给出的原话（接口人交办时附的主人原话），界面折叠显示，成员提示里照录。 */
  quote?: { label: string; text: string }
  /** 宿主代写的行的稳定标识（交办、验收结论……）：同一标识只写一次。 */
  ref?: string
  /** 主人发言的请求号：同一请求重试不会再写一行。 */
  requestId?: string
  /** A completed member turn the liaison must account for, replayable from the ledger. */
  engagement?: { callId: string; triggerSeq: number; generation?: number; answerTo?: string; memberId?: string; by?: string }
  /** Host attribution for posted member replies, including in groups without a coordinator. */
  memberCallId?: string
  /** The reply is the substantive result of a normally completed call. */
  memberCompleted?: true
  /** A plain group reply to check for a question the owner needs to answer. */
  ownerQuestionCheck?: true
  /** Versions whose content may have influenced this line. An empty array is a checked, unrestricted line. */
  experienceRefs?: ExperienceRef[]
}
export type GroupLineInput = Omit<GroupLine, 'seq' | 'at' | 'mentions'> & { mentions?: string[] }

export function memberCompletionEvidenceId(sessionId: string, line: GroupLine, formalDelivery = false) {
  const completed = line.memberCallId ? line.memberCompleted : line.engagement?.memberId === line.speakerId && !!line.engagement.callId
  if (line.ref === undefined && line.text.trim() && (line.kind === 'message' && completed || formalDelivery && line.kind !== 'event')) {
    return `group-member:${sessionId}:${line.seq}:${line.speakerId}`
  }
}

/** 调度器只依赖这一个写入口。 */
export interface GroupSay { say(line: GroupLineInput): GroupLine }

/** 文件本身不能是符号链接或别的东西（只看最后一级，上级目录是否经链接不影响）。 */
function ownedFile(path: string) {
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) } catch { return }
  if (!stat.isFile()) throw new Error('群账本文件的归属已改变。')
}

const optionalString = (value: unknown) => value === undefined || typeof value === 'string'
const optionalSeq = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && (value as number) > 0)

function validEngagement(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.callId === 'string' && row.triggerSeq !== undefined && optionalSeq(row.triggerSeq) && optionalSeq(row.generation) && optionalString(row.answerTo) && optionalString(row.memberId) && optionalString(row.by)
}

function validExperienceRefs(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.every(item => item && typeof item.id === 'string'
    && Number.isSafeInteger(item.version) && item.version > 0)
}

/** 账本里的一行是否完整可用；读不出的行（撕裂的半行、被手改坏的行）一律跳过。 */
function validLine(value: unknown): value is GroupLine {
  if (!value || typeof value !== 'object') return false
  const line = value as Record<string, unknown>
  return Number.isSafeInteger(line.seq) && (line.seq as number) > 0
    && typeof line.at === 'string' && GROUP_LINE_KINDS.includes(line.kind as GroupLineKind)
    && typeof line.speakerId === 'string' && line.speakerId !== '' && typeof line.author === 'string' && typeof line.text === 'string'
    && Array.isArray(line.mentions) && line.mentions.every(id => typeof id === 'string')
    && optionalSeq(line.replyTo) && optionalString(line.workOrderId) && optionalString(line.batchId) && optionalString(line.event) && validEngagement(line.engagement)
    && optionalString(line.traceId)
    && optionalString(line.memberCallId)
    && (line.memberCompleted === undefined || line.memberCompleted === true && line.kind === 'message' && !!line.memberCallId)
    && (line.ownerQuestionCheck === undefined || line.ownerQuestionCheck === true && line.memberCompleted === true &&
      line.replyTo !== undefined && line.workOrderId === undefined && line.engagement === undefined && line.ref === undefined)
    && validExperienceRefs(line.experienceRefs)
    && (line.all === undefined || line.all === true) && optionalString(line.ref) && optionalString(line.requestId)
    && (line.inputAttachments === undefined || Array.isArray(line.inputAttachments) && line.inputAttachments.every(isChatInputAttachment))
    && (line.quote === undefined || (!!line.quote && typeof line.quote === 'object' && typeof (line.quote as {label?: unknown}).label === 'string'
      && typeof (line.quote as {text?: unknown}).text === 'string'))
    && (line.attachments === undefined || (Array.isArray(line.attachments) && line.attachments.every(item => item && typeof item === 'object'
      && typeof (item as GroupAttachment).name === 'string' && typeof (item as GroupAttachment).path === 'string'
      && ((item as GroupAttachment).version === undefined || /^[a-f0-9]{64}$/.test((item as GroupAttachment).version!)))))
}

/** 读出整本账本：跳过空行、读不出的行和序号不前进的行（重复或乱序的写入）。 */
export function readGroupLedger(path: string): GroupLine[] {
  ownedFile(path)
  if (!existsSync(path)) return []
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let content: string
  try { content = readFileSync(fd, 'utf8') } finally { closeSync(fd) }
  const lines: GroupLine[] = []
  let last = 0
  for (const raw of content.split('\n')) {
    if (raw.trim() === '') continue
    let value: unknown
    try { value = JSON.parse(raw) } catch { continue }
    if (!validLine(value) || value.seq <= last) continue
    lines.push(value)
    last = value.seq
  }
  return lines
}

/** 追加一行；文件末尾若是崩溃留下的半行，先补换行。 */
function appendLine(path: string, line: GroupLine) {
  ownedFile(path)
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const size = fstatSync(fd).size
    let prefix = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      if (last[0] !== 0x0a) prefix = '\n'
    }
    const bytes = Buffer.from(prefix + JSON.stringify(line) + '\n', 'utf8')
    for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written)
  } finally { closeSync(fd) }
}

export interface GroupLedgerTrace {
  id: string
  prefix: readonly GroupLine[]
  nextSeq: (minimum: number) => number
}

export class GroupLedger implements GroupSay {
  readonly path: string
  readonly seenPath: string
  private lines: GroupLine[] | undefined
  private hasMaterials?: boolean
  private seenBy: Record<string, number> | undefined

  constructor(readonly dir: string, private readonly now: () => number = Date.now, private readonly trace?: GroupLedgerTrace) {
    this.path = join(dir, GROUP_LEDGER_FILE)
    this.seenPath = join(dir, GROUP_SEEN_FILE)
  }

  private book(): GroupLine[] {
    return this.lines ??= [...this.trace?.prefix ?? [], ...readGroupLedger(this.path)]
  }

  get lastSeq(): number { return this.book().at(-1)?.seq ?? 0 }
  get hasInputs(): boolean { return this.hasMaterials ??= this.book().some(line => !!line.inputAttachments?.length) }

  /** 唯一写入口：分配下一个序号，先落盘再进内存，返回写下的那一行。 */
  say(input: GroupLineInput): GroupLine {
    if (!GROUP_LINE_KINDS.includes(input.kind)) throw new Error(`群账本不认识的行类型：${String(input.kind)}`)
    if (typeof input.speakerId !== 'string' || input.speakerId === '') throw new Error('群账本的行需要发言人。')
    if (typeof input.author !== 'string' || typeof input.text !== 'string') throw new Error('群账本的行需要作者与正文。')
    const book = this.book()
    const minimum = this.lastSeq + 1
    const seq = this.trace?.nextSeq(minimum) ?? minimum
    const line: GroupLine = {
      seq,
      ...this.trace && {traceId: this.trace.id},
      at: new Date(this.now()).toISOString(),
      kind: input.kind,
      speakerId: input.speakerId,
      author: input.author,
      text: input.text,
      mentions: [...new Set(input.mentions ?? [])],
      ...input.all === true && { all: true as const },
      ...input.replyTo !== undefined && { replyTo: input.replyTo },
      ...input.workOrderId !== undefined && { workOrderId: input.workOrderId },
      ...input.batchId !== undefined && { batchId: input.batchId },
      ...input.attachments !== undefined && input.attachments.length > 0 && { attachments: input.attachments.map(item => ({ ...item })) },
      ...input.inputAttachments?.length && { inputAttachments: input.inputAttachments.map(item => ({ ...item })) },
      ...input.event !== undefined && { event: input.event },
      ...input.quote !== undefined && { quote: { label: input.quote.label, text: input.quote.text } },
      ...input.ref !== undefined && { ref: input.ref },
      ...input.requestId !== undefined && { requestId: input.requestId },
      ...input.engagement && { engagement: { ...input.engagement,
        ...(input.speakerId === 'owner' && input.engagement.triggerSeq === minimum && {triggerSeq: seq}) } },
      ...input.memberCallId && { memberCallId: input.memberCallId },
      ...input.memberCompleted && { memberCompleted: input.memberCompleted },
      ...input.ownerQuestionCheck && { ownerQuestionCheck: input.ownerQuestionCheck },
      ...input.experienceRefs && { experienceRefs: input.experienceRefs.map(ref => ({...ref})) },
    }
    if (!validLine(line)) throw new Error('群账本的行格式不对。')
    mkdirSync(this.dir, { recursive: true })
    appendLine(this.path, line)
    book.push(line)
    if (line.inputAttachments?.length) this.hasMaterials = true
    return line
  }

  /** 全部行，旧在前。 */
  all(): readonly GroupLine[] { return this.book() }

  get(seq: number): GroupLine | undefined { return this.book().find(line => line.seq === seq) }

  /** 宿主代写、带这个标识的那一行。 */
  byRef(ref: string): GroupLine | undefined { return this.book().find(line => line.ref === ref) }

  /** 主人用这个请求号说的那一行。 */
  byRequest(requestId: string): GroupLine | undefined { return this.book().find(line => line.requestId === requestId) }

  /** 序号大于 `seq` 的行，旧在前；给了 `limit` 只留最后几行。 */
  since(seq: number, { limit }: { limit?: number } = {}): GroupLine[] {
    const lines = this.book().filter(line => line.seq > seq)
    return limit === undefined ? lines : lines.slice(-Math.max(0, limit))
  }

  private seenMap(): Record<string, number> {
    if (this.seenBy) return this.seenBy
    let saved: Record<string, number> = {}
    try {
      if (existsSync(this.seenPath)) {
        ownedFile(this.seenPath)
        const value = JSON.parse(readFileSync(this.seenPath, 'utf8')) as unknown
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          saved = Object.fromEntries(Object.entries(value).filter(([, seq]) => Number.isSafeInteger(seq) && (seq as number) >= 0)) as Record<string, number>
        }
      }
    } catch { /* 读不出：当作谁都还没读过 */ }
    return this.seenBy = saved
  }

  /** 成员读到的序号；从没被叫过时为 undefined。 */
  seen(memberId: string): number | undefined { return this.seenMap()[memberId] }

  /** 记下成员读到了 `seq`（投递成功后再调）；不超过账本末尾，不倒退。 */
  markSeen(memberId: string, seq: number): number {
    const map = this.seenMap()
    const next = Math.min(Math.max(0, Math.floor(seq)), this.lastSeq)
    const previous = map[memberId]
    if (previous !== undefined && next <= previous) return previous
    const updated = { ...map, [memberId]: next }
    const temporary = this.seenPath + '.tmp'
    try {
      mkdirSync(this.dir, { recursive: true })
      ownedFile(this.seenPath)
      writeFileSync(temporary, JSON.stringify(updated) + '\n', { mode: 0o600 })
      renameSync(temporary, this.seenPath)
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* nothing left to clean */ }
      throw error
    }
    this.seenBy = updated
    return next
  }

  /**
   * 成员这次被叫时的新内容（DS-Bot groups.js:80-84 `unseenLines`）：第一次看最近 `first` 行；
   * 之后只看上次读到之后、别人说的行（自己的话已在自己的会话里），最多 `max` 行。
   */
  unseen(memberId: string, { first = LEDGER_FIRST_LOOK, max = LEDGER_DELTA_MAX }: { first?: number; max?: number } = {}): GroupLine[] {
    const since = this.seen(memberId)
    if (since === undefined) return this.book().slice(-Math.max(0, first))
    return this.book().filter(line => line.seq > since && line.speakerId !== memberId).slice(-Math.max(0, max))
  }
}
