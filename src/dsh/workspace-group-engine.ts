/**
 * 一场工作区群聊的引擎：把账本（唯一写入口 `say`）、调度器（谁来回答，状态存 `scheduler.json`）和成员运行器接起来。
 * 任务 design §1–§3；调度规则全在 `workspace-group-scheduler.ts`，这里只执行它给出的效果：
 *
 * - `start`：按 design §3 给被叫的成员拼话（成员表与 @ 规则、群公告、自上次读后的新行、谁叫的 / 还有谁同时在答、
 *   谁还在干活），交给对应的运行器；送达后记下这位成员读到了哪一行。
 * - `continue` / `cancel`：同一会话续推一次 / 停掉在跑的回合。
 * - `wake` / `background` / `event`：调度器已处理好（唤醒本身会带来一个 `start`），转给 `onEffects`（第 4 阶段接验收与提醒）。
 * - 计时：按 `nextDeadline()` 定一个计时器调 `tick()`。
 * - 重启：`start()` 读回调度状态，逐个问运行器哪些回合还在跑，再 `restart(还在跑的)`。
 * - 只读：`open()` 只读回调度状态与名册供查看（已归档工作区的群），不续跑、不叫人、不存盘、不定时，任何改动都被拒绝。
 *
 * 目录（`dir`）里：`ledger.jsonl`、`seen.json`、`scheduler.json`、`members.json`、`commands.jsonl`。单写，由持有本脑锁的运行时创建。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { redactSecrets } from '../core/redact.ts'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import type { ExperienceRef, ExperienceSelection } from '../core/workspace-experience.ts'
import { WORKSPACE_ARCHIVED, type V2PendingApproval } from '../core/workspace-v2.ts'
import type { Logger } from './ports.ts'
import { GroupLedger, LEDGER_FIRST_LOOK, type GroupAttachment, type GroupLedgerTrace, type GroupLine, type GroupLineInput, type GroupSay } from './workspace-group-ledger.ts'
import { experienceHistory, GroupMemberSessions, LIAISON_MEMBER_ID, MemberInputError, type ExperienceAccess, type GroupContext, type GroupMemberKind, type GroupRosterMember, type MemberCall, type MemberCallSink, type MemberInputs, type MemberRunner, type MemberSteer } from './workspace-group-members.ts'
import {
  GroupScheduler, HOST_ID, HOST_NAME, OWNER_ID, OWNER_NAME, type GroupCall, type GroupCallReason, type GroupCallStatus, type GroupEffect, type GroupLimits, type GroupMember, type GroupSchedulerOptions, type GroupSchedulerState, type MemberActivity,
} from './workspace-group-scheduler.ts'

export const GROUP_SCHEDULER_FILE = 'scheduler.json'
export const GROUP_COMMANDS_FILE = 'commands.jsonl'
/** 提示里每行最多读这么多字（DS-Bot constants.js:28-29 `GROUP_LINE_READ`）。 */
export const GROUP_LINE_READ = 20_000

/** 群聊的 `@` 说明（DS-Bot groups.js:171 `ROOM_CALLS`）。 */
export const GROUP_CALLS = '写 `@名字` 就会叫到这位成员，一发出就生效；同一句里一起被叫的人同时回答，在对方发言前看不到彼此；需要接力时先叫一个人，等他做完再叫下一个；只想提到某人而不叫他，就不要写 @。'
/** 怎么回（DS-Bot groups.js:170 `ROOM_REPLY`）。 */
export const GROUP_REPLY = '直接写正文，不要加自己的名字前缀。讨论时一两句就够；被要求执行操作时直接开始，只需分析时可以直接给出依据和结论。群不会等你：边干边说，结尾给结果，不给承诺。没有新内容、或这条消息是给别人的，回 [PASS]。'
/**
 * 怎么交付成果：链接的文件登记为这一行的附件，文件或明确的回报登记为主人「今天」里的「工单交付」提醒（工作区规范「工作区群聊」）。
 */
export const GROUP_DELIVERY = '交付文件时在回复里写成 `[名字](相对路径)` 链接（相对于你干活的目录；.md、.txt、.html，单个不超过 512 KB），主人能直接打开。亲手为工单交出最终的纯文字结果时第一行写「工单回报」，只交了一部分、还有事没做完时写「阶段回报」；汇总或转述别人交回的结果不用这两个开头。'
/** 管理员（接口人）的说明（DS-Bot groups.js:186-191 `adminNote`）。 */
export const GROUP_ADMIN_NOTE = '你是本群管理员。主人没有 @ 人的话先交给你：能直接回答就答，需要动手的按成员在本工作区的分工 @ 对应成员派活（主人点了名的照点名）；@所有人 会叫起全员。你派出的活全部交回后，SuperHub 会再叫你一次，那时核对结果、替主人汇总；结果不够就 @ 原来的人追问。主人在群里要求给本工作区加幕僚，或改幕僚的执行方式（DSH、Codex、Claude Code）、模型时，直接用 chief_staff 的 create 或 update，workspace 可不填，不用请主人去私聊。'

export interface GroupInfo { workspaceName: string; goal: string; title: string }

export interface GroupEngineOptions {
  scope: string
  workspaceId: string
  groupId: string
  /** 群的记录目录（`ops/superhub-v2-dialogues/<ws>/<group>`）。 */
  dir: string
  trace?: GroupLedgerTrace
  /** End of the inherited prefix when a parent used unversioned experience. */
  inheritedLegacyThrough?: number
  idPrefix?: string
  canStart?: () => boolean
  archiveFiles?: (files: GroupAttachment[], workDir: string) => GroupAttachment[]
  /** 成员干活的目录：工作区绑定的项目目录，未绑定时 SuperHub 工作目录（每次被叫时现读）。 */
  workDir: () => string
  info: () => GroupInfo
  /** 现在的名册（接口人 + 本区幕僚，`groupRoster`）；每次被叫时现读，身份与模型跟着变。 */
  roster: () => GroupRosterMember[]
  runners: Partial<Record<GroupMemberKind, MemberRunner>>
  experience?: ExperienceAccess
  orderTask?: (orderId: string) => {task: string; original?: string}
  /** 本群待主人批准的命令（`CodingGate.pending`）。 */
  approvals?: { pending(filter: { workspaceId?: string; sessionId?: string }): V2PendingApproval[] }
  /** 调度器给出的效果（执行之后），给验收、提醒与界面刷新用。 */
  onEffects?: (effects: readonly GroupEffect[]) => void
  /** 每次调度状态变动之后（工单状态、界面刷新用）。 */
  onChange?: () => void
  /**
   * 成员这一次被叫之前的最后核对（工单额度、工单是否还在办、幕僚资料令牌）：返回原因即不叫，账本记「没能答完」。
   * `member` 是现读的名册里的这位成员。
   */
  admit?: (call: { callId: string; member: GroupRosterMember; workOrderId?: string; by: string; reason: GroupCallReason }) => string | undefined
  /** Check persisted calls before restoring running, queued or parked work. */
  recoveryRefusal?: (workOrderId?: string) => string | undefined
  /** 管理员派出的工单批次落地时先交宿主验收（`wake` 效果带 `held`，宿主之后发言或 `wakeNow`）。 */
  holdOrderWakes?: boolean
  engage?: GroupSchedulerOptions['engage']
  checkOwnerQuestions?: boolean
  now?: () => number
  limits?: Partial<GroupLimits>
  logger?: Logger
}

/** 成员在跑的回合里最近调的工具：名字与在做什么（隐去密钥、截短的一行），何时开始。 */
export interface GroupMemberTool { name: string; detail?: string; at: number }
export interface GroupMemberView extends MemberActivity {
  name: string; admin: boolean; kind: GroupMemberKind
  /** 在本工作区的分工。 */
  duty?: string
  /** 在跑的回合里最近调的工具。 */
  tool?: GroupMemberTool
  /** 在跑的回合里最近说的一句中途发言。 */
  progress?: { text: string; at: number }
}
/** 主人一句话对每位该叫的人的去向：送进了它在跑的回合（`steered` / `pending`），或开始 / 排队一次新的回合。 */
export type GroupDeliveryOutcome = Exclude<MemberSteer, 'rejected'> | 'started' | 'queued' | 'failed'
export interface GroupDelivery { memberId: string; outcome: GroupDeliveryOutcome; detail?: string }
/** 每位该叫的人的去向；送进在跑回合的要等运行器答复（DSH 会话要等它认领），所以是 Promise。 */
export interface PendingDelivery { memberId: string; outcome: Promise<GroupDeliveryOutcome> }

/** 空转守卫暂停了自动叫人（主人发言后恢复）：原因（账本里那一行）、何时起、被挂起等主人发言才放行的叫人数。 */
export interface GroupPause { reason: string; since: number; parked: number; seq?: number }

/**
 * 接口人读得到哪些经验标记：自己有资格使用的版本（`own`），加上名册里每位成员本人在本区有效的专属版本（`members`，
 * 按发言人核对）。成员之间仍按各自的选择互相隔离。
 */
interface LiaisonScope { own: readonly ExperienceRef[]; members: ReadonlyMap<string, readonly ExperienceRef[]>
  /** 本轮入选的版本：接口人往自己发言上盖的标记只取这些，被派活成员按同一口径读历史，不会因此看不到任务。 */
  stamp: readonly ExperienceRef[] }
/** 接口人读不到原文的一条成员成果：他区共享或临时转交（`shared`）、经验已停用或已更新（`retired`）、成员已不在本群（`absent`）。 */
export interface LiaisonGap { seq: number; speakerId: string; author: string; reason: 'shared' | 'retired' | 'absent' }

const sameExperience = (left: ExperienceRef, right: ExperienceRef) => left.id === right.id && left.version === right.version
const LIAISON_GAP_REASON: Record<LiaisonGap['reason'], string> = {
  shared: '它依据的是他区共享或临时转交的经验',
  retired: '它依据的经验已停用或已更新',
  absent: '这位成员已不在本群',
}
/** 一条缺口的原因（给宿主说明列举用）。 */
export const liaisonGapReason = (gap: LiaisonGap) => LIAISON_GAP_REASON[gap.reason]
/** 缺口在接口人历史里的替身：宿主说明，不含原文、附件、原话和经验标记。 */
export function liaisonGapText(gap: LiaisonGap): string {
  const next = gap.reason === 'absent' ? '可以请其他成员重做这部分' : `可以请${gap.author}不依赖这条经验重新交回`
  return `（宿主说明）${gap.author}在这里交回了结果，但${LIAISON_GAP_REASON[gap.reason]}，接口人不能读取原文。` +
    `这不是主人能在群里授权解除的限制：不要向主人索要授权；${next}，或在汇总中注明这部分缺失。`
}

export interface GroupView {
  lines: readonly GroupLine[]
  members: GroupMemberView[]
  paused?: GroupPause
  approvals: V2PendingApproval[]
}

export const GROUP_DELIVERIES_FILE = 'deliveries.json'
/** 主人每句话对每位该叫的人的去向，按行序号存（只留最近这么多句）。 */
const DELIVERY_KEEP = 500
const GROUP_DELIVERY_OUTCOMES: readonly GroupDeliveryOutcome[] = ['started', 'queued', 'steered', 'pending', 'failed']
/** 状态里给界面看的一行字最多这么长。 */
const ACTIVITY_TEXT_MAX = 160
/** 界面上的一行：合成一行、隐去密钥、截短。 */
export function activityText(text: string, max = ACTIVITY_TEXT_MAX): string {
  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

const START = 'start'
type StartEffect = Extract<GroupEffect, { type: typeof START }>

const STATUS_TEXT: Record<GroupCallStatus | 'idle', string> = { idle: '空闲', queued: '排队', speaking: '正在答', working: '在干活', approval: '等主人批准', missed: '很久没动静' }
const KIND_TEXT: Record<GroupMemberKind, string> = { dsh: '', codex: 'Codex', 'claude-code': 'Claude Code' }
const minutesSince = (now: number, since?: number) => since === undefined ? undefined : Math.max(0, Math.round((now - since) / 60_000))
const cut = (text: string, max = GROUP_LINE_READ) => text.length > max ? text.slice(0, max) + `…（后面还有 ${text.length - max} 字）` : text

/** 成员发言里可以作为附件的文件：文稿与网页，单个不超过 512 KB，最多 12 个。 */
export const GROUP_FILE_TYPES = ['.md', '.txt', '.html', '.htm'] as const
const GROUP_FILE_MAX = 512 * 1024

/**
 * 成员发言里明确链接的文件（`[名字](相对路径)`，与编程会话的交付链接同一写法）：在工作目录之内、真实存在的普通文件，
 * 不经符号链接、不进隐藏目录。附件只记名字与路径，读取时再按当时的工作目录核对一次。
 */
export function linkedGroupFiles(text: string, workDir: string): GroupAttachment[] {
  const files: GroupAttachment[] = []
  let base: string
  try { base = realpathSync(workDir) } catch { return files }
  for (const link of text.matchAll(/\[([^\]\n]{1,160})\]\((?:<([^>\n]+)>|([^()\s]+))\)/g)) {
    if (files.length >= 12) break
    let path: string
    try { path = decodeURIComponent(link[2] ?? link[3]!) } catch { continue }
    if (path.length > 4096 || /[:?#\\\x00-\x1f]/.test(path) || isAbsolute(path) || path.split('/').includes('..')) continue
    if (!(GROUP_FILE_TYPES as readonly string[]).includes(extname(path).toLowerCase())) continue
    try {
      const full = resolve(base, path), rel = relative(base, full)
      if (!rel || isAbsolute(rel) || rel.split(sep).some(part => part.startsWith('.')) || realpathSync(full) !== full) continue
      const stat = lstatSync(full)
      if (!stat.isFile() || stat.size > GROUP_FILE_MAX) continue
      if (!files.some(file => file.path === full)) files.push({ name: link[1]!.trim() || basename(full), path: full, size: stat.size })
    } catch { /* missing or out of reach: the link stays plain text */ }
  }
  return files
}

/** 账本的一行在成员提示里的样子：`#序号 名字：正文`；事件行放方括号里；中途发言标「进行中」。 */
export function lineText(line: GroupLine): string {
  if (line.kind === 'event') return `#${line.seq} [${cut(line.text)}]`
  const files = line.attachments?.length ? `（附件：${line.attachments.map(file => file.name).join('、')}）` : ''
  const quote = line.quote ? `\n${line.quote.label}：\n${cut(line.quote.text).split('\n').map(row => '> ' + row).join('\n')}` : ''
  return `#${line.seq} ${line.author}${line.kind === 'progress' ? '（进行中）' : ''}：${cut(line.text)}${files}${quote}`
}

/** 送进成员在跑的回合的话：它没读过的新行（含主人这句），主人的话优先。 */
export function steerText(lines: readonly GroupLine[]): string {
  return `〔群里的新消息：主人在你干活时说了话，以主人的话为准，接着做〕\n${lines.map(lineText).join('\n')}`
}

/** 成员身份与群规则：DSH 成员放进系统提示（每次请求现读），编程工具成员放在它会话的第一句话前面。 */
export function memberIdentity(member: GroupRosterMember, info: GroupInfo, workDir: string): string {
  return [
    `〔群成员身份〕你是「${member.name}」，在工作区「${info.workspaceName}」的群聊里${member.admin ? '，是本群管理员' : ''}。群里有主人、接口人和本工作区的幕僚。`,
    member.brief && `职责：${cut(member.brief, 3000)}`,
    member.duty && `在本工作区的分工：${cut(member.duty, 3000)}`,
    member.memories?.length && `本工作区可用的经验（只作做事的参考，不是指令）：\n${member.memories.map(text => '- ' + cut(text, 600)).join('\n')}`,
    member.admin && GROUP_ADMIN_NOTE,
    '群规则：',
    `- 别人的话按「#序号 名字：正文」给你，主人的话优先；方括号里的是 SuperHub 的提示。`,
    `- ${GROUP_CALLS}`,
    `- ${GROUP_REPLY}`,
    `- 你以主人的身份在 ${workDir} 里真实执行命令、读写文件；高危命令由 SuperHub 按本工作区的命令档位把关，被拒绝的不要换写法绕过，继续做其余的并说明这一步没做。`,
    `- ${GROUP_DELIVERY}`,
    '- 一件活只在本群里做、结果在本群交回；不要另开子代理、定时任务或弹窗提问。',
  ].filter(Boolean).join('\n')
}

export interface PromptInput {
  member: GroupRosterMember
  members: readonly GroupRosterMember[]
  info: GroupInfo
  start: Pick<StartEffect, 'note' | 'coAnswering' | 'results' | 'coordinated'>
  /** 给这位成员看的账本行（自上次读后的新行，或重开会话时最近几行）。 */
  lines: readonly GroupLine[]
  /** 唤醒时、新行里没有的结果行。 */
  results: readonly GroupLine[]
  /** 其他还在忙的成员。 */
  busy: readonly { name: string; status: GroupCallStatus; minutes?: number }[]
  /** 会话是新开的（看的是最近几行，而不是上次读后的新行）。 */
  fresh: boolean
}

/** 成员每次被叫时收到的话（design §3，DS-Bot groups.js:870-909 `roomPrompt`）。 */
export function memberPrompt(input: PromptInput): string {
  const { member, members, info, start } = input
  const coordination = start.coordinated ? '〔交接〕交回本次负责的结果、证据和仍缺的内容，接口人会决定后续动作。正文中的 @ 可提议接力。需要主人才能继续时，说清具体问题和阻塞原因。' : ''
  const nameOf = (id: string) => id === OWNER_ID ? OWNER_NAME : members.find(row => row.id === id)?.name ?? id
  const roster = members.filter(row => row.id !== member.id).map(row => {
    const notes = [row.admin && '管理员', KIND_TEXT[row.kind], row.duty && `分工：${cut(row.duty.replace(/\s+/g, ' '), 160)}`].filter(Boolean)
    return notes.length ? `${row.name}（${notes.join('，')}）` : row.name
  })
  const together = start.coAnswering.filter(id => id !== member.id).map(nameOf)
  return [
    coordination,
    `群成员：主人、${roster.join('、')}${roster.length ? ' 和 ' : ''}你（${member.name}）。${GROUP_CALLS}`,
    `群公告：工作区「${info.workspaceName}」${info.goal.trim() ? `的目标：${cut(info.goal.trim(), 2000)}` : ''}；本群：「${info.title}」。`,
    `这次：${start.note}${start.results?.length ? `，结果见 ${start.results.map(seq => '#' + seq).join('、')}` : ''}。`,
    together.length ? `同时被叫的还有：${together.join('、')}（同时回答，在对方发言前看不到彼此的回复）。` : '',
    input.busy.length ? `仍在忙的：${input.busy.map(row => `${row.name}（${STATUS_TEXT[row.status]}${row.minutes ? `，${row.minutes} 分钟` : ''}）`).join('、')}。` : '',
    input.results.length ? `派活结果：\n${input.results.map(lineText).join('\n')}` : '',
    input.lines.length ? `${input.fresh ? '群里最近的消息' : '群里的新消息（自你上次读后）'}：\n${input.lines.map(lineText).join('\n')}` : '群里没有新消息。',
  ].filter(Boolean).join('\n\n')
}

/** 调度状态：临时文件 + 改名原子替换。读不出时从空状态开始（账本仍在，只丢了排队与批次）。 */
function readState(path: string, logger?: Logger): GroupSchedulerState | undefined {
  try {
    if (!existsSync(path)) return undefined
    if (!lstatSync(path).isFile()) throw new Error('调度状态文件的归属已改变。')
    const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; state?: GroupSchedulerState }
    if (value?.version !== 1 || !value.state || value.state.version !== 1) throw new Error('调度状态的版本不认识。')
    return value.state
  } catch (error) {
    logger?.warn('群调度状态读不出，从空状态开始：%s', String(error))
    return undefined
  }
}
function writeState(path: string, state: GroupSchedulerState) {
  const temporary = path + '.tmp'
  try {
    if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('调度状态文件的归属已改变。')
    writeFileSync(temporary, JSON.stringify({ version: 1, state }) + '\n', { mode: 0o600 })
    renameSync(temporary, path)
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* nothing left to clean */ }
    throw error
  }
}

const RUNNING: readonly GroupCallStatus[] = ['speaking', 'working', 'approval', 'missed']
const asMember = (row: GroupRosterMember): GroupMember => ({ id: row.id, name: row.name, ...row.admin && { admin: true } })

export class GroupEngine {
  readonly ledger: GroupLedger
  readonly sessions: GroupMemberSessions
  private readonly statePath: string
  private readonly now: () => number
  private scheduler: GroupScheduler | undefined
  private roster: GroupRosterMember[] = []
  /** 每位出现过的成员的执行方式（离群的成员也留着，好停掉它还在跑的回合）。 */
  private readonly kinds = new Map<string, GroupMemberKind>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private saved = ''
  private ready = false
  private disposed = false
  private retired = false
  private closing = false
  /** Opened with `open()`: shown as it is, never changed. */
  private viewOnly = false
  /** 重启补读时（就绪之前）运行器报来的事，就绪后按顺序处理。 */
  private early: (() => void)[] = []
  /** 正在送进成员回合的主人的话（`callId:seq`）。 */
  private readonly steering = new Map<string, Promise<GroupDelivery>>()
  /** 在跑的回合最近调的工具与中途发言（只在内存里；重启后从账本补中途发言）。 */
  private readonly doing = new Map<string, { tool?: GroupMemberTool; progress?: { text: string; at: number } }>()
  private readonly callExperience = new Map<string, ExperienceSelection>()
  private readonly deliveriesPath: string
  private delivered: Record<string, GroupDelivery[]> | undefined
  private readonly sink: MemberCallSink

  constructor(private readonly options: GroupEngineOptions) {
    this.now = options.now ?? Date.now
    mkdirSync(options.dir, { recursive: true })
    this.ledger = new GroupLedger(options.dir, this.now, options.trace)
    this.sessions = new GroupMemberSessions(options.dir, this.now)
    this.statePath = join(options.dir, GROUP_SCHEDULER_FILE)
    this.deliveriesPath = join(options.dir, GROUP_DELIVERIES_FILE)
    const report = (fn: (scheduler: GroupScheduler) => GroupEffect[], save = true) => {
      if (this.disposed) return
      const run = () => this.handle(fn, save)
      if (this.ready) run()
      else this.early.push(run)
    }
    const note = (callId: string, patch: { tool?: GroupMemberTool; progress?: { text: string; at: number } }) => {
      if (!this.disposed) this.doing.set(callId, { ...this.doing.get(callId), ...patch })
    }
    this.sink = {
      recoveredSteer: (memberId, id, outcome) => report(s => {
        const match = /^steer-(\d+)$/.exec(id)
        const line = match && this.ledger.get(Number(match[1]))
        if (!line || !this.deliveryOf(line.seq)?.some(row => row.memberId === memberId && row.outcome === 'pending')) return []
        this.setDelivery(line.seq, memberId, outcome === 'steered' ? 'steered' : 'queued', ['pending'])
        if (outcome === 'steered') { this.ledger.markSeen(memberId, line.seq); return [] }
        return s.steerFailed({type: 'steer', callId: '', memberId, seq: line.seq, workOrderId: line.workOrderId, reason: 'owner', note: '主人补充了材料'})
      }),
      stepped: (callId, text) => {
        const said = activityText(text, 200)
        if (said) note(callId, { progress: { text: said, at: this.now() } })
        report(s => this.experienceCurrent(s, callId) ? s.stepped(callId, text) : [])
      },
      tool: (callId, { name, team, detail }) => {
        const shown = detail === undefined ? '' : activityText(detail)
        note(callId, { tool: { name, at: this.now(), ...shown && { detail: shown } } })
        report(s => s.tool(callId, { team }))
      },
      touched: callId => report(s => s.touched(callId), false),
      approval: (callId, waiting) => report(s => s.approval(callId, waiting)),
      finished: (callId, result) => {
        this.doing.delete(callId)
        report(s => {
          if (!this.experienceCurrent(s, callId)) {
            const detail = '本轮经验授权已变化，请重新叫这位成员。'
            this.failedDelivery(s, callId, detail)
            return s.finished(callId, {status:'failed', detail})
          }
          if (result.status === 'failed') this.failedDelivery(s, callId, result.detail ?? '成员没有接下材料')
          return s.finished(callId, result)
        })
      },
    }
  }

  private get schedule(): GroupScheduler {
    if (!this.scheduler || !this.ready) throw new Error('群聊还没就绪。')
    return this.scheduler
  }

  /** 读回调度状态与名册；问运行器哪些回合还在跑，其余按重启中断处理；排队的叫人照常开始。 */
  async start(): Promise<void> {
    if (this.scheduler) return
    this.useRoster(this.options.roster())
    const state = readState(this.statePath, this.options.logger)
    const blocked = this.options.recoveryRefusal
    if (state && blocked) {
      state.calls = state.calls.filter(call => !blocked(call.workOrderId))
      state.parked = state.parked.filter(call => !blocked(call.workOrderId))
      state.batches = state.batches.filter(batch => !blocked(batch.workOrderId))
    }
    // Members' lines link their files (`[名字](相对路径)`): those inside the group's working directory become attachments.
    const say: GroupSay = { say: input => this.ledger.say(this.withFiles(input)) }
    const scheduler = new GroupScheduler({ members: this.roster.map(asMember), say, now: this.now, inputScoped: this.ledger.hasInputs, engage: this.options.engage,
      checkOwnerQuestions: this.options.checkOwnerQuestions, idPrefix: this.options.idPrefix, ...state && { state }, ...this.options.limits && { limits: this.options.limits },
      ...this.options.holdOrderWakes && { holdOrderWakes: true },
      ...this.options.experience && {canPublish:call=>this.canPublishExperience(call)} })
    this.scheduler = scheduler
    if (this.retired) scheduler.retire()
    const alive: string[] = []
    const settled = new Set(this.ledger.all().flatMap(line => {
      const callId = line.engagement?.callId ?? (line.ownerQuestionCheck ? line.memberCallId : undefined)
      return callId ? [callId] : []
    }))
    const group = this.context()
    for (const call of scheduler.calls) {
      if (!RUNNING.includes(call.status) || !scheduler.currentEngagement(call) || settled.has(call.id) || blocked?.(call.workOrderId)) continue
      const member = this.roster.find(row => row.id === call.memberId)
      const runner = member && this.options.runners[member.kind]
      if (!member || !runner) continue
      try {
        const experience = this.selectExperience(member, call.triggerSeq, call.workOrderId)
        if (experience) this.callExperience.set(call.id, experience)
        const identity = memberIdentity(experience ? {...member, memories: undefined} : member, this.options.info(), group.workDir)
        if (await runner.reattach({ callId: call.id, group, member, identity, experience, ...call.workOrderId && { workOrderId: call.workOrderId } }, this.sink)) {
          if (this.closing || blocked?.(call.workOrderId)) runner.cancel(call.id)
          else alive.push(call.id)
        }
      } catch (error) { this.options.logger?.warn('群成员 %s 的回合没能续上：%s', member.name, String(error)) }
    }
    for (const callId of Object.keys(this.sessions.lives())) if (!alive.includes(callId)) this.sessions.clearLive(callId)
    if (this.disposed) return
    this.ready = true
    this.handle(s => s.restart(alive, settled))
    for (const run of this.early.splice(0)) run()
    this.refreshMembers()
  }

  /**
   * 只读打开（已归档工作区的群）：读回调度状态与名册，界面照常显示账本与成员；不问运行器、不按重启处理、不叫排队的人、
   * 不存盘、不定计时器。之后改动群的调用（发言、叫人、叫停、记一行）都抛出「工作区已归档」。
   */
  async open(): Promise<void> {
    if (this.scheduler) return
    this.useRoster(this.options.roster())
    const state = readState(this.statePath, this.options.logger)
    this.scheduler = new GroupScheduler({ members: this.roster.map(asMember), say: { say: () => { throw new Error(WORKSPACE_ARCHIVED) } }, now: this.now,
      ...state && { state }, ...this.options.limits && { limits: this.options.limits } })
    this.viewOnly = true
    this.ready = true
  }

  get started(): boolean { return this.ready }
  /** Opened read-only (`open()`). */
  get readOnly(): boolean { return this.viewOnly }
  get workspaceId(): string { return this.options.workspaceId }
  get groupId(): string { return this.options.groupId }
  get traceId(): string | undefined { return this.options.trace?.id }
  get superseded(): boolean { return this.retired }

  /** Orders some member call (running or queued) or open batch is still for. */
  busyOrders(): Set<string> {
    const scheduler = this.scheduler
    if (!scheduler) return new Set()
    return new Set([...scheduler.calls.map(call => call.workOrderId), ...scheduler.batches.map(batch => batch.workOrderId)].filter((id): id is string => !!id))
  }

  /** 主人在群里说话：立即入账本，按「谁来回答」叫人。 */
  ownerSay(text: string, options: { workOrderId?: string; attachments?: GroupAttachment[]; inputAttachments?: ChatInputAttachment[]; requestId?: string } = {}): GroupLine {
    return this.say(text, options).line
  }

  /**
   * 主人在群里说话：立即入账本，按「谁来回答」叫人；该叫的人正在干活时，把这句话（连同它还没读过的新行）立即送进它
   * 在跑的回合，并记下它已读到这一行，不再另开一次；送不进时才排队（主人的叫人排在最前）。同一请求号只说一次。
   * `deliveries` 是每位该叫的人的去向（送进在跑回合的，送进去或改为排队后兑现）；重试的请求号没有新的去向。
   */
  say(text: string, options: { workOrderId?: string; attachments?: GroupAttachment[]; inputAttachments?: ChatInputAttachment[]; requestId?: string } = {}): { line: GroupLine; deliveries: PendingDelivery[] } {
    const past = options.requestId ? this.ledger.byRequest(options.requestId) : undefined
    if (past) return { line: past, deliveries: [] }
    let line: GroupLine | undefined
    let effects: GroupEffect[] = []
    this.handle(s => {
      const said = s.ownerSaid({ text, steer: true, ...options.workOrderId !== undefined && { workOrderId: options.workOrderId },
        ...options.attachments && { attachments: options.attachments }, ...options.inputAttachments?.length && { inputAttachments: options.inputAttachments },
        ...options.requestId !== undefined && { requestId: options.requestId } })
      line = said.line
      effects = said.effects
      return said.effects
    })
    return { line: line!, deliveries: this.record(line!, this.deliveries(line!, effects)) }
  }

  /** Store the edited words before committing the queued calls. Reopening either write can be retried independently. */
  revision(text: string, requestId: string, workOrderId?: string, inputAttachments?: ChatInputAttachment[]) {
    if (this.retired || this.options.canStart?.() === false) throw new Error('对话版本已更新，请刷新')
    const line = this.ledger.byRequest(requestId) ?? this.schedule.recordOwner({text, requestId, workOrderId, inputAttachments})
    this.forwardEngagementOwner('edit-' + requestId, line)
    return line
  }

  /** 主人选择把接口人留下的那句话交出去：按账本里那一行叫人（同样可以送进在跑的回合）。 */
  callOwnerLine(seq: number): PendingDelivery[] {
    const line = this.ledger.get(seq)
    if (!line || line.speakerId !== OWNER_ID) throw new Error('群里没有这句主人的话。')
    let effects: GroupEffect[] = []
    this.handle(s => (effects = s.ownerLine(line, { steer: true })))
    return this.record(line, this.deliveries(line, effects))
  }

  /** 主人这句话对每位该叫的人的去向（读取时给界面）；送进在跑回合的先记 `pending`，有了结果再改。 */
  deliveryOf(seq: number): readonly GroupDelivery[] | undefined { return this.deliveryBook()[String(seq)] }

  private record(line: GroupLine, rows: PendingDelivery[]): PendingDelivery[] {
    if (!rows.length) return rows
    const key = String(line.seq)
    this.saveDeliveries({ ...this.deliveryBook(), [key]: rows.map(row => ({ memberId: row.memberId, outcome: 'pending' as const })) })
    for (const row of rows) {
      row.outcome.then(outcome => this.setDelivery(line.seq, row.memberId, outcome, ['pending']), () => { /* stays pending */ })
    }
    return rows
  }

  /** 改一位成员的去向，只从 `from` 里的状态改（送达的结果只结算 `pending`；开始回答只覆盖排队或还没结算的）。 */
  private setDelivery(seq: number, memberId: string, outcome: GroupDeliveryOutcome, from: readonly GroupDeliveryOutcome[], detail?: string) {
    if (this.disposed) return
    const book = this.deliveryBook(), key = String(seq)
    const rows = book[key]
    const changes = (row: GroupDelivery) => row.memberId === memberId && row.outcome !== outcome && from.includes(row.outcome)
    if (!rows?.some(changes)) return
    this.saveDeliveries({ ...book, [key]: rows.map(row => changes(row) ? { memberId, outcome, ...detail && {detail: activityText(detail, 240)} } : row) })
    try { this.options.onChange?.() } catch (error) { this.options.logger?.warn('群聊变动的后续处理出错：%s', String(error)) }
  }

  /** A member starts a call: owner words queued for it (and those that called it now, still settling) are being answered. */
  private answering(memberId: string, triggerSeq: number, workOrderId?: string) {
    const book = this.deliveryBook()
    const changes = (key: string, row: GroupDelivery) => row.memberId === memberId && this.schedule.sameOrder(this.ledger.get(Number(key))?.workOrderId, workOrderId)
      && (row.outcome === 'queued' || row.outcome === 'pending' && key === String(triggerSeq))
    const touched = Object.entries(book).filter(([key, rows]) => rows.some(row => changes(key, row)))
    if (!touched.length) return
    this.saveDeliveries({ ...book, ...Object.fromEntries(touched.map(([key, rows]) => [key, rows.map(row => changes(key, row) ? { memberId, outcome: 'started' as const } : row)])) })
  }

  private deliveryBook(): Record<string, GroupDelivery[]> {
    if (this.delivered) return this.delivered
    let book: Record<string, GroupDelivery[]> = {}
    try {
      if (existsSync(this.deliveriesPath)) {
        if (!lstatSync(this.deliveriesPath).isFile()) throw new Error('送达记录文件的归属已改变。')
        const value = JSON.parse(readFileSync(this.deliveriesPath, 'utf8')) as { version?: unknown; lines?: unknown }
        if (value?.version === 1 && value.lines && typeof value.lines === 'object' && !Array.isArray(value.lines)) {
          book = Object.fromEntries(Object.entries(value.lines as Record<string, unknown>).flatMap(([key, rows]) => /^\d+$/.test(key) && Array.isArray(rows)
            && rows.every(row => row && typeof row === 'object' && typeof row.memberId === 'string' && GROUP_DELIVERY_OUTCOMES.includes(row.outcome)) ? [[key, rows as GroupDelivery[]]] : []))
        }
      }
    } catch (error) { this.options.logger?.warn('群的送达记录读不出：%s', String(error)) }
    return this.delivered = book
  }

  private saveDeliveries(book: Record<string, GroupDelivery[]>) {
    const keys = Object.keys(book).sort((a, b) => Number(a) - Number(b))
    const kept = keys.length > DELIVERY_KEEP ? Object.fromEntries(keys.slice(-DELIVERY_KEEP).map(key => [key, book[key]!])) : book
    this.delivered = kept
    const temporary = this.deliveriesPath + '.tmp'
    try {
      if (existsSync(this.deliveriesPath) && !lstatSync(this.deliveriesPath).isFile()) throw new Error('送达记录文件的归属已改变。')
      writeFileSync(temporary, JSON.stringify({ version: 1, lines: kept }) + '\n', { mode: 0o600 })
      renameSync(temporary, this.deliveriesPath)
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* nothing left to clean */ }
      this.options.logger?.warn('群的送达记录没存上：%s', String(error))
    }
  }

  private deliveries(line: GroupLine, effects: readonly GroupEffect[]): PendingDelivery[] {
    const rows: PendingDelivery[] = []
    for (const effect of effects) {
      if (effect.type === 'start' && effect.triggerSeq === line.seq) rows.push({ memberId: effect.memberId, outcome: Promise.resolve('started') })
      if (effect.type === 'steer' && effect.seq === line.seq) {
        const steering = this.steering.get(effect.callId + ':' + effect.seq)
        rows.push({ memberId: effect.memberId, outcome: steering ? steering.then(row => row.outcome) : Promise.resolve('queued') })
      }
    }
    for (const call of this.scheduler?.calls ?? []) {
      if (call.status === 'queued' && call.triggerSeq === line.seq && !rows.some(row => row.memberId === call.memberId)) rows.push({ memberId: call.memberId, outcome: Promise.resolve('queued') })
    }
    return rows
  }

  /**
   * 以管理员（接口人）身份在群里说一句（交办、补充、验收结论）：其中的 `@` 照常叫人，落地后收回批次。
   * 同一 `ref` 只写一次（重启后补发不会重复）。`callAdmin`：这一行没叫到谁时，替主人叫接口人自己来回应它（附这句说明）。
   */
  liaisonSay(text: string, options: { workOrderId?: string; quote?: GroupLine['quote']; inputAttachments?: ChatInputAttachment[]; ref?: string;
    onBehalfOfOwner?: boolean; callAdmin?: string; experienceRefs?: GroupLine['experienceRefs'] } = {}): GroupLine {
    const past = options.ref ? this.ledger.byRef(options.ref) : undefined
    if (past) return past
    const admin = this.roster.find(row => row.admin)
    if (!admin) throw new Error('群里没有管理员。')
    let line: GroupLine | undefined
    let effects: GroupEffect[] = []
    this.handle(s => {
      const said = s.memberSaid(admin.id, { text, ...options.workOrderId !== undefined && { workOrderId: options.workOrderId },
        ...options.inputAttachments?.length && { inputAttachments: options.inputAttachments }, ...options.quote && { quote: options.quote },
        ...options.ref !== undefined && { ref: options.ref }, ...options.onBehalfOfOwner && { onBehalfOfOwner: true },
        experienceRefs:options.experienceRefs })
      line = said.line
      effects = said.effects
      if (options.callAdmin !== undefined && !said.line.mentions.length && !said.line.all) {
        effects.push(...s.callFor(admin.id, { triggerSeq: said.line.seq, note: options.callAdmin, ...options.workOrderId !== undefined && { workOrderId: options.workOrderId } }))
      }
      return effects
    })
    if (line?.inputAttachments?.length) this.record(line, this.deliveries(line, effects))
    return line!
  }

  /**
   * 只记一行、不叫任何人：接口人留下没交出去的主人原话（`speaker: 'owner'`，带请求号），或接口人不需要谁回应的说明。
   * 同一 `ref` / 请求号只写一次。
   */
  note(input: { speaker: 'owner' | 'liaison'; text: string; workOrderId?: string; inputAttachments?: ChatInputAttachment[]; ref?: string; requestId?: string;
    quote?: GroupLine['quote']; engagement?: GroupLine['engagement']; experienceRefs?: GroupLine['experienceRefs']; replyTo?: number }): GroupLine {
    const past = (input.ref ? this.ledger.byRef(input.ref) : undefined) ?? (input.requestId ? this.ledger.byRequest(input.requestId) : undefined)
    if (past) return past
    if (this.viewOnly) throw new Error(WORKSPACE_ARCHIVED)
    const admin = this.roster.find(row => row.admin)
    const speaker = input.speaker === 'owner' ? { speakerId: OWNER_ID, author: OWNER_NAME } : admin ? { speakerId: admin.id, author: admin.name } : { speakerId: HOST_ID, author: HOST_NAME }
    const line = this.ledger.say({ kind: 'message', ...speaker, text: input.text, mentions: [],
      ...input.workOrderId !== undefined && { workOrderId: input.workOrderId }, ...input.ref !== undefined && { ref: input.ref },
      ...input.replyTo !== undefined && { replyTo: input.replyTo },
      ...input.requestId !== undefined && { requestId: input.requestId }, ...input.quote && { quote: input.quote }, inputAttachments: input.inputAttachments,
      engagement: input.engagement, experienceRefs: input.experienceRefs })
    try { this.options.onChange?.() } catch (error) { this.options.logger?.warn('群聊变动的后续处理出错：%s', String(error)) }
    return line
  }

  /** 替主人叫一位成员来回应账本里的某一行（一句话交办没点名幕僚时叫接口人派活）。 */
  callFor(memberId: string, spec: { triggerSeq: number; note: string; workOrderId?: string }) { this.handle(s => s.callFor(memberId, spec)) }

  forwardEngagementOwner(request: string, line: GroupLine) {
    let effects: GroupEffect[] = []
    this.handle(s => (effects = s.forwardEngagementOwner(request, line)), true, true)
    this.record(line, this.deliveries(line, effects))
  }

  forwardEngagementMember(request: string, line: GroupLine) {
    this.handle(s => s.forwardEngagementMember(request, line), true, true)
  }

  dispatchEngagement(request: string, members: string[], text: string, workOrderId?: string,
    handoff?: {original?: string; inputAttachments?: ChatInputAttachment[]; experienceRefs?: GroupLine['experienceRefs']; replyTo?: number; exactScope?: true}) {
    if (this.viewOnly) throw new Error(WORKSPACE_ARCHIVED)
    const line = this.note({speaker: 'liaison', text, workOrderId, ref: request, inputAttachments: handoff?.inputAttachments, experienceRefs:handoff?.experienceRefs,
      ...(handoff?.replyTo !== undefined && {replyTo: handoff.replyTo}),
      ...(handoff?.original && {quote: {label: '主人原话', text: handoff.original}})})
    this.handle(s => s.dispatchEngagement(request, members, {triggerSeq: line.seq, note: '接口人请你继续处理这一项', workOrderId, exactScope:handoff?.exactScope}), true, true)
    return line
  }

  /** 被扣下等验收的唤醒（`wake.held`）验收不了：照常叫派活者。 */
  wakeNow(effect: Extract<GroupEffect, { type: 'wake' }>) { this.handle(s => s.wakeNow(effect)) }

  /** 工单的指示变了：为它进行的工作叫停。 */
  stopOrder(workOrderId: string, text?: string) { this.handle(s => s.stopOrder(workOrderId, text)) }

  /**
   * The owner's words a running liaison call acts on, as the host recorded them: the owner line that called it, or the
   * owner line the host handed over to it (its hand-over line replies to it). Member, wake-up and review calls have none.
   */
  ownerSourceOf(callId: string): GroupLine | undefined {
    const call = this.schedule.calls.find(row => row.id === callId)
    if (!call || call.memberId !== LIAISON_MEMBER_ID || !['speaking', 'working', 'approval'].includes(call.status)) return
    const owner = (line?: GroupLine) => line?.speakerId === OWNER_ID && line.kind === 'message' && line.requestId ? line : undefined
    const trigger = this.ledger.get(call.triggerSeq)
    return call.by === OWNER_ID ? owner(trigger)
      : call.by === HOST_ID && trigger?.speakerId === LIAISON_MEMBER_ID && trigger.replyTo !== undefined ? owner(this.ledger.get(trigger.replyTo)) : undefined
  }

  workInFlight() {
    return this.schedule.calls.filter(call => this.schedule.currentEngagement(call))
      .map(({memberId, workOrderId, triggerSeq}) => ({id: memberId, workOrderId, triggerSeq}))
  }

  /** 现在的名册（与调度器一致）。 */
  members(): readonly GroupRosterMember[] { return this.roster }

  /** 叫停一位成员或全部。 */
  stop(memberId?: string) { this.handle(s => s.stop(memberId)) }

  retire() {
    this.retired = true
    this.scheduler?.retire()
    if (this.ready) this.persist(true)
  }

  /** Deletion ends active and superseded calls, including an engine still reattaching on startup. */
  shutdown() {
    this.closing = true
    try { if (this.ready && !this.viewOnly) this.stop() }
    catch (error) {
      for (const call of this.scheduler?.calls ?? []) this.runnerOf(call.memberId)?.cancel(call.id)
      this.options.logger?.warn('群聊停止未能写入记录：%s', String(error))
    } finally { this.dispose() }
  }

  /** 到点的事（计时器会自己调；测试和宿主也可以直接调）。 */
  tick() { this.handle(s => s.tick()) }

  /** 名册变了（幕僚进出工作区、改名）：离群的人停下，调度器换成新名单。 */
  refreshMembers() {
    const next = this.options.roster()
    const same = JSON.stringify(next.map(asMember)) === JSON.stringify(this.roster.map(asMember))
    this.useRoster(next)
    if (!same && this.ready && !this.viewOnly) this.handle(s => s.setMembers(next.map(asMember)))
  }

  view(): GroupView {
    const scheduler = this.schedule
    const activity = new Map(scheduler.activity().map(row => [row.memberId, row]))
    const lines = this.ledger.all()
    const pause = scheduler.pause
    const members = this.roster.map((row): GroupMemberView => {
      const now = activity.get(row.id) ?? { memberId: row.id, status: 'idle' as const, queued: 0 }
      const running = now.callId !== undefined && RUNNING.includes(now.status as GroupCallStatus)
      const doing = running ? this.doing.get(now.callId!) : undefined
      // After a restart the latest progress words of the running call come from the ledger.
      const said = doing?.progress ?? (running && now.since !== undefined ? lines.findLast(line => line.kind === 'progress' && line.speakerId === row.id && Date.parse(line.at) >= now.since!) : undefined)
      const progress = said && ('seq' in said ? { text: activityText(said.text, 200), at: Date.parse(said.at) } : said)
      const duty = row.duty?.trim() ? activityText(row.duty, 300) : undefined
      return { ...now, name: row.name, admin: row.admin === true, kind: row.kind, ...duty && { duty }, ...doing?.tool && { tool: doing.tool },
        ...progress && progress.text && { progress } }
    })
    return {
      lines,
      members,
      ...pause && { paused: {
        reason: pause.reason ?? lines.findLast(line => line.kind === 'event' && line.event === 'paused')?.text ?? '成员之间连续多次没有新进展，自动叫人已暂停，主人发言后继续。',
        since: pause.at, parked: scheduler.parked.length, ...pause.seq !== undefined && { seq: pause.seq } } },
      approvals: this.options.approvals?.pending({ workspaceId: this.options.workspaceId, sessionId: this.options.groupId }) ?? [],
    }
  }

  /** 停掉计时器、不再处理运行器的上报；DSH 会话里的回合不停（重启后 `start()` 续上），编程工具进程由运行器自己收。 */
  dispose() {
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
    this.early = []
    this.doing.clear()
  }

  // -------------------------------------------------------------------------------------------

  /** A member's message or progress line: the files it links inside the working directory, as its attachments. */
  private withFiles(input: GroupLineInput): GroupLineInput {
    if (this.options.experience && input.memberCallId) {
      const selected = this.callExperience.get(input.memberCallId)?.entries
      const captured = this.sessions.native(input.speakerId, input.workOrderId)?.experience
      input = {...input, experienceRefs: experienceHistory(selected, captured)}
    }
    // Host-written lines (hand-overs, verdicts: they carry a `ref`) never publish files as the member's own.
    if (input.kind === 'event' || input.ref !== undefined || input.attachments?.length || !this.kinds.has(input.speakerId)) return input
    let workDir: string
    try { workDir = this.options.workDir() } catch { return input }
    const links = linkedGroupFiles(input.text, workDir)
    const attachments = this.options.archiveFiles?.(links, workDir) ?? links
    return attachments.length ? { ...input, attachments } : input
  }

  private useRoster(next: GroupRosterMember[]) {
    this.roster = next
    for (const member of next) this.kinds.set(member.id, member.kind)
  }

  private context(): GroupContext {
    const info = this.options.info()
    return { scope: this.options.scope, workspaceId: this.options.workspaceId, groupId: this.options.groupId, workspaceName: info.workspaceName,
      title: info.title, workDir: this.options.workDir(), sessions: this.sessions, commandsPath: join(this.options.dir, GROUP_COMMANDS_FILE),
      experience: this.options.experience, traceId: this.traceId, canStart: this.options.canStart }
  }

  private selectExperience(member: GroupRosterMember, triggerSeq: number, workOrderId?: string) {
    const access = this.options.experience
    if (!access) return
    const trigger = this.ledger.get(triggerSeq)
    const source = this.ledger.all().findLast(line => line.seq <= triggerSeq && line.workOrderId === workOrderId
      && (line.speakerId === OWNER_ID || line.speakerId === LIAISON_MEMBER_ID && !!line.ref && !!line.quote))
    const order = workOrderId ? this.options.orderTask?.(workOrderId) : undefined
    const owningSource = source?.speakerId === OWNER_ID ? source.text : source?.quote?.text
    const browserAssignment = this.ledger.all().some(line => line.seq <= triggerSeq && line.workOrderId === workOrderId &&
      line.speakerId === LIAISON_MEMBER_ID && line.ref?.startsWith('staff-'))
    const purposeTask = owningSource ?? order?.original ?? (browserAssignment ? order?.task : '') ?? ''
    const task = [order?.task, purposeTask, trigger?.speakerId === OWNER_ID ? trigger.text : undefined].filter(Boolean).join('\n')
    return access.selectExperience({ workspaceId: this.options.workspaceId,
      staffId: member.id === LIAISON_MEMBER_ID ? undefined : member.id, task, purposeTask,
      ...member.kind !== 'dsh' && {domains: ['软件工程']} })
  }

  private experienceCurrent(scheduler: GroupScheduler, callId: string) {
    const call = scheduler.calls.find(row => row.id === callId)
    return !call || this.canPublishExperience(call)
  }

  private canPublishExperience(call: GroupCall) {
    const access = this.options.experience
    if (!access) return true
    try {
      const binding = this.sessions.native(call.memberId, call.workOrderId)
      if (binding?.memories?.length) return false
      const selection = this.callExperience.get(call.id)
      if (selection) access.assertExperienceCurrent(selection)
      if (!binding?.experience?.length) return true
      const member = this.roster.find(row => row.id === call.memberId)
      const current = selection ? access.selectExperience(selection.query) : member && this.selectExperience(member,call.triggerSeq,call.workOrderId)
      return binding.experience.every(ref => current?.authorized.some(entry => ref.id === entry.id && ref.version === entry.version))
    } catch { return false }
  }

  private untrackedReplayAllowed(line: GroupLine, omitUntracked: boolean) {
    return !omitUntracked && line.seq > (this.options.inheritedLegacyThrough ?? 0) && !this.sessions.hasLegacyExperience()
  }

  /** The receiving member must also receive the versions used by any replayed member line. */
  private replayAllowed(line: GroupLine, experience: ExperienceSelection | undefined, omitUntracked = false) {
    if (!experience || line.speakerId === OWNER_ID) return true
    if (line.experienceRefs) return line.experienceRefs.every(ref =>
      experience.entries.some(entry => ref.id === entry.id && ref.version === entry.version))
    if (line.speakerId === HOST_ID || line.quote && line.ref) return true
    return this.untrackedReplayAllowed(line, omitUntracked)
  }

  /** 没有经验存储时 `undefined`（都可读）；群里没有接口人时两份都为空。 */
  private liaisonScope(triggerSeq: number, workOrderId?: string): LiaisonScope | undefined {
    const access = this.options.experience
    if (!access) return
    const liaison = this.roster.find(member => member.id === LIAISON_MEMBER_ID)
    if (!liaison) return {own: [], members: new Map(), stamp: []}
    const selection = this.selectExperience(liaison,triggerSeq,workOrderId)
    const own = selection?.authorized ?? [], stamp = selection?.entries ?? []
    return {own, stamp, members: new Map(this.roster.filter(member => member.id !== LIAISON_MEMBER_ID)
      .map(member => [member.id, access.staffOwnExperience?.(this.options.workspaceId, member.id) ?? []]))}
  }

  /** 接口人能否读这一行：每个标记都在接口人自己的范围里，或属于这行发言人本人在本区有效的专属版本。 */
  private liaisonReadable(line: GroupLine, scope: LiaisonScope | undefined, omitUntracked = false) {
    if (!scope || line.speakerId === OWNER_ID) return true
    if (line.experienceRefs) {
      const mine = scope.members.get(line.speakerId) ?? []
      return line.experienceRefs.every(ref => scope.own.some(entry => sameExperience(ref, entry)) || mine.some(entry => sameExperience(ref, entry)))
    }
    if (line.speakerId === HOST_ID || line.quote && line.ref) return true
    return this.untrackedReplayAllowed(line, omitUntracked)
  }

  /** 读不到的成员成果为什么读不到：该成员自己有资格用、但不是本人专属的，是他区共享或转交；否则已停用或已更新。 */
  private liaisonGap(line: GroupLine, scope: LiaisonScope, triggerSeq: number, workOrderId?: string): LiaisonGap {
    const member = this.roster.find(row => row.id === line.speakerId)
    const gap = {seq: line.seq, speakerId: line.speakerId, author: line.author}
    if (!member) return {...gap, reason: 'absent'}
    const readable = [...scope.own, ...scope.members.get(member.id) ?? []]
    const missing = (line.experienceRefs ?? []).filter(ref => !readable.some(entry => sameExperience(ref, entry)))
    let authorized: readonly ExperienceRef[] = []
    try { authorized = this.selectExperience(member,triggerSeq,workOrderId)?.authorized ?? [] } catch { /* counted as no longer valid */ }
    return {...gap, reason: missing.length && missing.every(ref => authorized.some(entry => sameExperience(ref, entry))) ? 'shared' : 'retired'}
  }

  /** 接口人看到的这一行：可读的原样；读不到的成员发言换成宿主说明（`gaps` 收下缺口）；其余读不到的不显示。 */
  private liaisonLine(line: GroupLine, scope: LiaisonScope | undefined, triggerSeq: number, workOrderId: string | undefined,
    gaps?: LiaisonGap[], omitUntracked = false): GroupLine | undefined {
    if (this.liaisonReadable(line, scope, omitUntracked)) return line
    if (!scope || line.kind !== 'message' || !line.experienceRefs?.length || [OWNER_ID, HOST_ID, LIAISON_MEMBER_ID].includes(line.speakerId)) return
    const gap = this.liaisonGap(line, scope, triggerSeq, workOrderId)
    gaps?.push(gap)
    return {seq: line.seq, at: line.at, kind: line.kind, speakerId: line.speakerId, author: line.author, text: liaisonGapText(gap), mentions: [],
      ...line.replyTo !== undefined && {replyTo: line.replyTo}, ...line.workOrderId !== undefined && {workOrderId: line.workOrderId},
      ...line.batchId !== undefined && {batchId: line.batchId}, ...line.engagement && {engagement: line.engagement}}
  }

  /** 接口人可读的历史（只过滤）：批次验收、回报发布及其附件用它。 */
  projectLiaisonHistory(lines: readonly GroupLine[], triggerSeq: number, workOrderId?: string) {
    const liaison = this.roster.find(member => member.id === LIAISON_MEMBER_ID)
    if (!liaison && this.options.experience) return lines.filter(line => !line.experienceRefs?.length)
    const scope = this.liaisonScope(triggerSeq,workOrderId)
    return lines.filter(line => this.liaisonReadable(line,scope))
  }

  /** 接口人可读的历史，读不到原文的成员成果换成宿主说明行：交接协调用它。 */
  projectLiaisonGaps(lines: readonly GroupLine[], triggerSeq: number, workOrderId?: string): {lines: GroupLine[]; gaps: LiaisonGap[]} {
    const liaison = this.roster.find(member => member.id === LIAISON_MEMBER_ID)
    if (!liaison) return {lines: this.projectLiaisonHistory(lines,triggerSeq,workOrderId), gaps: []}
    const scope = this.liaisonScope(triggerSeq,workOrderId)
    const gaps: LiaisonGap[] = []
    return {lines: lines.flatMap(line => this.liaisonLine(line,scope,triggerSeq,workOrderId,gaps) ?? []), gaps}
  }

  /** 接口人读这些标记所依据的版本是否都还有效（自己的范围或发言成员本人的专属）。 */
  canUseLiaisonExperience(refs: readonly ExperienceRef[], triggerSeq: number, workOrderId?: string) {
    if (!refs.length) return true
    const scope = this.liaisonScope(triggerSeq,workOrderId)
    if (!scope) return true
    const readable = [...scope.own, ...[...scope.members.values()].flat()]
    return refs.every(ref => readable.some(entry => sameExperience(ref, entry)))
  }

  /** 接口人往自己的发言上盖的标记：只取它本轮入选的版本，不继承成员的专属标记。 */
  liaisonExperienceRefs(lines: readonly GroupLine[], triggerSeq: number, workOrderId?: string): ExperienceRef[] {
    const refs = [...new Map(lines.flatMap(line => line.experienceRefs ?? []).map(ref => [ref.id + '@' + ref.version, ref] as const)).values()]
    const scope = this.liaisonScope(triggerSeq,workOrderId)
    return scope ? refs.filter(ref => scope.stamp.some(entry => sameExperience(ref, entry))) : refs
  }

  /** 改调度器、执行效果、存盘、重定计时器。 */
  private handle(fn: (scheduler: GroupScheduler) => GroupEffect[], save = true, strict = false) {
    if (this.disposed) return
    if (this.viewOnly) throw new Error(WORKSPACE_ARCHIVED)
    const scheduler = this.schedule
    const before = strict ? scheduler.snapshot() : undefined
    let effects: GroupEffect[]
    try {
      effects = fn(scheduler)
      const remaining = new Set(scheduler.calls.map(call => call.id))
      for (const callId of this.callExperience.keys()) if (!remaining.has(callId)) this.callExperience.delete(callId)
      this.persist(save || effects.length > 0, strict)
    } catch (error) {
      if (before) scheduler.restore(before)
      throw error
    }
    this.apply(effects)
    this.arm()
    try { this.options.onChange?.() } catch (error) { this.options.logger?.warn('群聊变动的后续处理出错：%s', String(error)) }
  }

  private persist(force: boolean, strict = false) {
    if (!force || !this.scheduler) return
    const state = this.scheduler.snapshot()
    const text = JSON.stringify(state)
    if (text === this.saved) return
    try { writeState(this.statePath, state); this.saved = text }
    catch (error) {
      if (strict) throw error
      this.options.logger?.warn('群调度状态没存上：%s', String(error))
    }
  }

  private arm() {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed || !this.scheduler) return
    const deadline = this.scheduler.nextDeadline()
    if (deadline === undefined) return
    this.timer = setTimeout(() => { this.timer = undefined; this.tick() }, Math.max(0, deadline - this.now()))
    this.timer.unref?.()
  }

  private apply(effects: readonly GroupEffect[]) {
    for (const effect of effects) {
      switch (effect.type) {
        case 'start':
          // The owner's words that waited for this member are read now: the new call sees every line it has not read.
          this.answering(effect.memberId, effect.triggerSeq, effect.workOrderId)
          this.begin(effect)
          break
        case 'continue': {
          const runner = this.runnerOf(effect.memberId)
          if (!runner) { this.fail(effect.callId, '这位成员现在没法运行'); break }
          runner.continue(effect.callId, effect.text).catch((error: unknown) => this.fail(effect.callId, error instanceof Error ? error.message : String(error)))
          break
        }
        case 'cancel': this.doing.delete(effect.callId); this.runnerOf(effect.memberId)?.cancel(effect.callId); break
        case 'steer': this.steer(effect); break
        default: break
      }
    }
    if (effects.length) {
      try { this.options.onEffects?.(effects) } catch (error) { this.options.logger?.warn('群聊效果的后续处理出错：%s', String(error)) }
    }
  }

  private runnerOf(memberId: string) {
    const kind = this.kinds.get(memberId)
    return kind && this.options.runners[kind]
  }

  private fail(callId: string, detail: string) {
    // Reported on a later turn so the effect loop that asked for the work finishes first.
    queueMicrotask(() => {
      if (!this.ready) return
      this.failedDelivery(this.schedule, callId, detail)
      this.handle(s => s.finished(callId, { status: 'failed', detail: detail.slice(0, 300) }))
    })
  }

  private failedDelivery(scheduler: GroupScheduler, callId: string, detail: string) {
    const call = scheduler.calls.find(row => row.id === callId)
    if (call && this.ledger.get(call.triggerSeq)?.inputAttachments?.length) this.setDelivery(call.triggerSeq, call.memberId, 'failed', ['started', 'pending', 'queued'], detail)
  }

  /** A delegation carries the owner's material along its reply chain. Other orders and other addressees have no handles here. */
  private inputsFor(memberId: string, workOrderId: string | undefined, triggerSeq: number, lines: readonly GroupLine[]): {materials: MemberInputs; note: string} {
    if (!this.ledger.hasInputs) return {materials: {}, note: ''}
    const sequences = new Set<number>()
    let primary: ChatInputAttachment[] | undefined
    const include = (seq: number | undefined, trigger = false) => {
      while (seq !== undefined && !sequences.has(seq)) {
        const line = this.ledger.get(seq)
        if (!line || line.workOrderId !== workOrderId) break
        sequences.add(seq)
        if (trigger && !primary && line.inputAttachments?.length) primary = line.inputAttachments
        seq = line.replyTo
      }
    }
    include(triggerSeq, true)
    for (const line of lines) {
      if (line.speakerId === memberId && line.replyTo !== undefined || line.mentions.includes(memberId) || this.deliveryOf(line.seq)?.some(row => row.memberId === memberId)) include(line.seq)
    }
    const inputs = new Map<string, ChatInputAttachment>()
    const sources: string[] = []
    for (const seq of [...sequences].sort((a, b) => a - b)) {
      const files = this.ledger.get(seq)?.inputAttachments
      if (!files?.length) continue
      sources.push(`#${seq} ${files === primary ? '本次材料' : '相关历史材料'} ${JSON.stringify(files.map(({id, name}) => ({id, name})))}`)
      for (const file of files) inputs.set(file.id, file)
    }
    for (const ref of primary ?? []) inputs.delete(ref.id)
    return {materials: {...primary?.length && {inputAttachments: primary}, ...inputs.size && {readAttachments: [...inputs.values()]}},
      note: sources.length ? '\n\n〔按来源消息列出的只读材料〕\n' + sources.join('\n') : ''}
  }

  /**
   * 把主人的话送进成员在跑的回合：连同它还没读过、在这一行之前的新行一起，主人的话优先。送进去了就记下它已读到这一行
   * （之后不会再作为新的一次叫它）；送不进就排队叫它（`steerFailed`，在下一个微任务里，好让这一轮效果先处理完）。
   */
  private steer(effect: Extract<GroupEffect, { type: 'steer' }>) {
    const key = effect.callId + ':' + effect.seq
    const runner = this.runnerOf(effect.memberId)
    const fallback = (): GroupDelivery => {
      queueMicrotask(() => { if (this.ready && !this.disposed) this.handle(s => s.steerFailed(effect)) })
      return { memberId: effect.memberId, outcome: 'queued' }
    }
    if (!runner?.steer) { this.steering.set(key, Promise.resolve(fallback())); return }
    let lines = this.ledger.unseen(effect.memberId).filter(line => line.seq <= effect.seq && (!line.workOrderId || this.schedule.sameOrder(line.workOrderId, effect.workOrderId)))
    const experience = this.callExperience.get(effect.callId)
    const participant = this.roster.find(row => row.id === effect.memberId)
    if (experience && participant) {
      let current: ExperienceSelection | undefined, liaisonScope: LiaisonScope | undefined
      try {
        current = this.selectExperience(participant,effect.seq,effect.workOrderId)
        if (participant.id === LIAISON_MEMBER_ID) liaisonScope = this.liaisonScope(effect.seq,effect.workOrderId)
      }
      catch { this.steering.set(key, Promise.resolve(fallback())); return }
      const entries = experience.entries.filter(entry => current?.authorized.some(ref => ref.id === entry.id && ref.version === entry.version))
      const exposed = this.sessions.native(effect.memberId,effect.workOrderId)?.experience ?? []
      if (experience.entries.some(entry => entry.purpose && !entries.includes(entry))
        || exposed.some(ref => !current?.authorized.some(entry => ref.id === entry.id && ref.version === entry.version))) {
        this.steering.set(key, Promise.resolve(fallback()))
        return
      }
      if (liaisonScope) lines = lines.flatMap(line => this.liaisonLine(line, liaisonScope, effect.seq, effect.workOrderId) ?? [])
      else for (let index = lines.length - 1; index >= 0; index--) if (!this.replayAllowed(lines[index]!, {...experience, entries})) lines.splice(index, 1)
    }
    if (!lines.some(line => line.seq === effect.seq)) { const own = this.ledger.get(effect.seq); if (own) lines.push(own) }
    let sent: Promise<MemberSteer>
    const refs = this.inputsFor(effect.memberId, effect.workOrderId, effect.seq, lines)
    try { sent = runner.steer(effect.callId, { id: `steer-${effect.seq}`, text: steerText(lines) + refs.note, ...refs.materials }) }
    catch (error) { sent = Promise.reject(error) }
    const done = sent.then(outcome => {
      if (outcome === 'rejected' || this.disposed) return fallback()
      try { this.ledger.markSeen(effect.memberId, effect.seq) } catch (error) { this.options.logger?.warn('群成员 %s 的已读没记下：%s', effect.memberId, String(error)) }
      return { memberId: effect.memberId, outcome }
    }, (error: unknown) => {
      if (!(error instanceof MemberInputError)) return fallback()
      this.setDelivery(effect.seq, effect.memberId, 'failed', ['pending'], error.message)
      return {memberId: effect.memberId, outcome: 'failed' as const, detail: error.message}
    }).finally(() => this.steering.delete(key))
    this.steering.set(key, done)
  }

  /** 给被叫的成员拼话并交给运行器；送达后记下已读。名册、身份与工单额度都在这一刻现读、现核对。 */
  private begin(effect: StartEffect) {
    if (this.retired || this.options.canStart?.() === false) { this.fail(effect.callId, '对话版本已更新'); return }
    let fresh: GroupRosterMember | undefined
    try { fresh = this.options.roster().find(row => row.id === effect.memberId) } catch (error) { this.options.logger?.warn('群名册读不出：%s', String(error)) }
    const member = fresh ?? this.roster.find(row => row.id === effect.memberId)
    const runner = member && this.options.runners[member.kind]
    if (!fresh || !member || !runner) {
      this.fail(effect.callId, fresh ? '这位成员现在没法运行' : '这位成员已不在本群')
      // After the failure line: the group takes the new roster (who left is no longer called).
      if (!fresh) queueMicrotask(() => { if (this.ready && !this.disposed) this.refreshMembers() })
      return
    }
    let refused: string | undefined
    try { refused = this.options.admit?.({ callId: effect.callId, member, by: effect.by, reason: effect.reason, ...effect.workOrderId !== undefined && { workOrderId: effect.workOrderId } }) }
    catch (error) { refused = error instanceof Error ? error.message : String(error) }
    if (refused) { this.fail(effect.callId, refused); return }
    let group: GroupContext, experience: MemberCall['experience'], liaisonScope: LiaisonScope | undefined
    try {
      group = this.context(); experience = this.selectExperience(member, effect.triggerSeq, effect.workOrderId)
      // The liaison reads members' results built on their own staff experience; members stay isolated from each other.
      if (experience && member.id === LIAISON_MEMBER_ID) liaisonScope = this.liaisonScope(effect.triggerSeq, effect.workOrderId)
    }
    catch (error) { this.fail(effect.callId, error instanceof Error ? error.message : String(error)); return }
    if (experience) this.callExperience.set(effect.callId,experience)
    const info = this.options.info()
    const binding = this.sessions.member(member.id)
    const isFresh = !binding || binding.kind !== member.kind || binding.cwd !== group.workDir || binding.inputScoped && binding.workOrderId !== effect.workOrderId || this.ledger.seen(member.id) === undefined
    const upTo = this.ledger.lastSeq
    const scheduler = this.schedule
    const now = this.now()
    const busy = scheduler.activity().filter(row => row.memberId !== member.id && row.status !== 'idle' && row.status !== 'queued').flatMap(row => {
      const other = this.roster.find(item => item.id === row.memberId)
      return other ? [{ name: other.name, status: row.status as GroupCallStatus, ...minutesSince(now, row.since) !== undefined && { minutes: minutesSince(now, row.since) } }] : []
    })
    const promptFor = (asFresh: boolean, authorizedOnly = false) => {
      const visible = (line: GroupLine) => liaisonScope
        ? this.liaisonLine(line, liaisonScope, effect.triggerSeq, effect.workOrderId, undefined, authorizedOnly)
        : this.replayAllowed(line,experience,authorizedOnly) ? line : undefined
      const lines = (asFresh ? this.ledger.all() : this.ledger.unseen(member.id)).flatMap(line =>
        (!line.workOrderId || scheduler.sameOrder(line.workOrderId, effect.workOrderId)) && visible(line) || [])
      if (asFresh && !this.options.trace?.prefix.length && lines.length > LEDGER_FIRST_LOOK) lines.splice(0, lines.length - LEDGER_FIRST_LOOK)
      // The line that called it is always shown, also when it carries its own name (a hand-over the host wrote for it).
      const raw = this.ledger.get(effect.triggerSeq)
      const trigger = raw && visible(raw)
      if (trigger && !lines.some(line => line.seq === trigger.seq) &&
          (asFresh || trigger.inputAttachments?.length || (this.ledger.seen(member.id) ?? 0) < trigger.seq)) {
        lines.push(trigger)
        lines.sort((a, b) => a.seq - b.seq)
      }
      const shown = new Set(lines.map(line => line.seq))
      const results = (effect.results ?? []).filter(seq => !shown.has(seq)).flatMap(seq => this.ledger.get(seq) ?? [])
        .flatMap(line => line.workOrderId === effect.workOrderId && visible(line) || [])
      const {materials, note} = this.inputsFor(member.id, effect.workOrderId, effect.triggerSeq, [...lines, ...results])
      return {text: memberPrompt({ member, members: this.roster, info, start: effect, lines, results, busy, fresh: asFresh }) + note, inputs: materials}
    }
    const initial = promptFor(isFresh)
    const recap = isFresh ? initial : promptFor(true)
    const ownerRecap = experience && promptFor(true, true)
    const identity = memberIdentity(experience ? {...member, memories: undefined} : member, info, group.workDir)
    const call: MemberCall = { callId: effect.callId, group, member, identity, prompt: initial.text, recap: authorizedOnly => authorizedOnly && ownerRecap ? ownerRecap.text : recap.text,
      ...initial.inputs, recapInputs: recap.inputs, ownerRecapInputs: ownerRecap?.inputs, experience,
      ...effect.workOrderId !== undefined && { workOrderId: effect.workOrderId } }
    let delivered: Promise<void>
    try { delivered = runner.run(call, this.sink) }
    catch (error) { delivered = Promise.reject(error) }
    delivered.then(() => {
      try { this.ledger.markSeen(member.id, upTo) } catch (error) { this.options.logger?.warn('群成员 %s 的已读没记下：%s', member.name, String(error)) }
    }, (error: unknown) => this.fail(effect.callId, `${member.name} 没收到：${error instanceof Error ? error.message : String(error)}`))
  }
}
