/**
 * 工作区群聊的成员：谁在群里（名册）、每位成员怎么跑（成员运行器的接口），以及成员在本群的长期会话映射
 * （群目录下的 `members.json`，重启后续用）。任务 design §1–§2。
 *
 * - 名册 = 接口人（管理员，id `liaison`）+ 本工作区的幕僚（幕僚 id）。执行方式按幕僚卡：`codex` / `claude-code`
 *   是编程工具成员，`dsh` 或没有原生卡的专属幕僚是 DSH 模型成员；远程幕僚不进群（只能经工作电脑工单）。
 * - 运行器只做「把引擎拼好的话交给成员的会话、把会话里发生的事按 callId 报回来」，调度规则全在调度器里。
 * - `members.json` 记两样：每位成员在本群用的原生会话（DSH 会话 id / Codex thread / Claude Code 会话，及其工作目录），
 *   和正在跑的回合投递了哪条请求（重启后据此判断那一回合还在不在跑）。临时文件 + 改名原子替换，单写。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import { nameProblem } from '../core/mentions.ts'
import type { Staff } from '../core/model.ts'
import { LIAISON_AUTHOR } from '../core/workspace-v2.ts'
import type { StaffContext, StaffMember } from '../core/workspace-staff.ts'
import { renderExperience, type ExperienceEntry, type ExperienceRef, type ExperienceSelection, type WorkspaceExperiencePort } from '../core/workspace-experience.ts'
import type { ModelSelection } from './ports.ts'
import { teammateSelection, type ModelDefaults } from './staff-models.ts'
import { dialogueKey } from './workspace-speaker-id.ts'
import { GROUP_LIMITS, type FinishStatus, type GroupMember } from './workspace-group-scheduler.ts'

export const GROUP_MEMBERS_FILE = 'members.json'
/** 接口人在每个群里的成员 id（幕僚用自己的幕僚 id）。 */
export const LIAISON_MEMBER_ID = 'liaison'

export type GroupMemberKind = 'dsh' | 'codex' | 'claude-code'
export type ExperienceAccess = WorkspaceExperiencePort

/** Resume only while every version the executor might have seen is still authorized for the task. */
export function experienceRevoked(selection: ExperienceSelection, history: readonly ExperienceRef[] | undefined): boolean {
  return (history ?? []).some(old => !selection.authorized.some(current => current.id === old.id && current.version === old.version))
}

export function experienceHistory(history: readonly ExperienceRef[] = [], entries: readonly ExperienceRef[] = []): ExperienceRef[] {
  const versions = new Map(history.map(ref => [ref.id, ref.version]))
  for (const {id, version} of entries) versions.set(id, version)
  return [...versions].map(([id, version]) => ({id, version}))
}

export function experienceDelta(selection: ExperienceSelection, history: readonly ExperienceRef[] = []): ExperienceEntry[] {
  return selection.entries.filter(entry => !history.some(ref => ref.id === entry.id && ref.version === entry.version))
}

export function experiencePrompt(selection: ExperienceSelection, entries = selection.entries): string {
  const refs = experienceHistory([], selection.entries)
  return [
    '〔本轮参考经验〕仅按本轮列出的编号和版本参考历史经验。主人本轮的话及工单约定优先。',
    JSON.stringify(refs),
    renderExperience(selection, entries),
  ].filter(Boolean).join('\n')
}

/** 名册里的一位成员：调度用的 id / 名字 / 管理员，加上运行与身份所需的资料。 */
export interface GroupRosterMember extends GroupMember {
  kind: GroupMemberKind
  /** 职责（幕僚卡或专属幕僚的 brief）。 */
  brief?: string
  /** 在本工作区的分工。 */
  duty?: string
  /** 已生效的本区经验与获准的共享文字。 */
  memories?: string[]
  /** DSH 模型成员的模型（只改它自己的会话）；编程工具成员由工具自己的配置决定。 */
  model?: ModelSelection
  /** 幕僚在本区可见资料的令牌（`StaffContext.token`）：每次被叫前核对，变了就按新资料重读身份。 */
  token?: string
}

/** 一场群在运行器眼里的样子。 */
export interface GroupContext {
  scope: string
  workspaceId: string
  /** 群 = 工作区里的一场会话的 id。 */
  groupId: string
  workspaceName: string
  title: string
  /** 成员干活的目录：工作区绑定的项目目录，未绑定时 SuperHub 工作目录。 */
  workDir: string
  sessions: GroupMemberSessions
  /** 命令把关与命令结束的留痕（`commands.jsonl`）。 */
  commandsPath: string
  experience?: ExperienceAccess
}

/** 一次被叫。`prompt` 是引擎按 design §3 拼好的话；`identity` 是成员身份与群规则（DSH 进系统提示，编程工具首轮放在开头）。 */
export interface MemberInputs {
  /** The material on the message that called this member, delivered as one native user input. */
  inputAttachments?: ChatInputAttachment[]
  /** Other relevant, authorized messages. Their originals remain readable on demand. */
  readAttachments?: ChatInputAttachment[]
}
export const memberInputs = (input: MemberInputs): ChatInputAttachment[] => [...input.inputAttachments ?? [], ...input.readAttachments ?? []]

export interface MemberCall extends MemberInputs {
  callId: string
  group: GroupContext
  member: GroupRosterMember
  identity: string
  prompt: string
  recapInputs?: MemberInputs
  /** 成员的原生会话不得不重开时（续接失败），换用「最近 12 行」版本的话。 */
  recap?: (authorizedOnly?: boolean) => string
  /** For a new native session after revocation, replay only direct owner inputs. */
  ownerRecapInputs?: MemberInputs
  experience?: ExperienceSelection
  workOrderId?: string
}
export type MemberReattach = Omit<MemberCall, 'prompt' | 'recap' | 'recapInputs' | 'ownerRecapInputs' | keyof MemberInputs>
export interface MemberWords extends MemberInputs { id: string; text: string }
/** Staging or native attachment admission failed for this receiver. Queuing the same delivery cannot fix it. */
export class MemberInputError extends Error {}

export interface MemberFinish { text: string; status: FinishStatus; toolCalls: number; detail?: string }

/** 成员回合里发生的事，按 `callId` 报给引擎（引擎转给调度器）。 */
export interface MemberCallSink {
  /** An in-flight native steer reconciled against the inbox and session events after a restart. */
  recoveredSteer?(memberId: string, id: string, outcome: 'steered' | 'rejected'): void
  /** 干活中途说的话（之后还调了工具，或还有下一句）。 */
  stepped(callId: string, text: string): void
  /**
   * 调了一个工具；`team` 是团队协作类工具（不算开工）。`detail` 是它在做什么（命令全文、文件路径、搜索词……，原样，
   * 由引擎隐去密钥并截短后给界面看）。
   */
  tool(callId: string, info: { name: string; team: boolean; detail?: string }): void
  /** 会话里的任何动静（重置 240 秒无动静计时）。 */
  touched(callId: string): void
  /** 等主人批准（`true`）或批准有了结果（`false`）。 */
  approval(callId: string, waiting: boolean): void
  /** 回合结束；`text` 是最终回复。续推（`continue`）之后同一 callId 还会再结束一次。 */
  finished(callId: string, result: MemberFinish): void
}

/** 主人的话送进成员在跑的回合的结果：`steered` 已接下；`pending` 已写给它、会在本回合读到；`rejected` 没送进去。 */
export type MemberSteer = 'steered' | 'pending' | 'rejected'

export interface MemberRunner {
  /**
   * 把主人的话立即送进这一回合（DSH 会话 `prompt({mode:'steer'})`、Codex `turn/steer`、Claude Code 追加 stream-json）。
   * 没有在跑的回合、协议拒绝时为 `rejected`，宿主改为排队叫它。没有这个方法的运行器一律排队。
   */
  steer?(callId: string, words: MemberWords): Promise<MemberSteer>
  /**
   * 把这次被叫交给成员的会话。成员的会话接下这句话后兑现（之后引擎记下已读）；没送达就拒绝，且不会再报 `finished`。
   */
  run(call: MemberCall, sink: MemberCallSink): Promise<void>
  /** 同一会话再推一次（调度器的续推）；送达后兑现。 */
  continue(callId: string, text: string): Promise<void>
  /** 停掉在跑的回合；之后迟到的上报由调度器忽略。 */
  cancel(callId: string): void
  /** 宿主重启后：这一回合是否还在跑；在跑就接着把事件报给 `sink`（已结束的会马上报 `finished`）。 */
  reattach(call: MemberReattach, sink: MemberCallSink): Promise<boolean>
  dispose(): void
}

/** 一次工具调用在做什么：命令、文件路径、搜索词或网址（取参数里第一个有的）；参数读不出或没有这些时为 undefined。 */
export function toolDetail(input: unknown): string | undefined {
  let args = input
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return undefined } }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const row = args as Record<string, unknown>
  for (const key of ['command', 'cmd', 'file_path', 'path', 'query', 'url', 'pattern']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value
    if (Array.isArray(value) && value.length && value.every(item => typeof item === 'string')) return value.join(' ')
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// 名册

/**
 * 成员按哪张卡运行：有全局角色卡的以角色卡为准；没有的（SuperHub 里建的幕僚）用自己存的执行器与模型，都没写时为 DSH 默认。
 */
export function memberRunCard(member: Pick<StaffMember, 'executor' | 'model' | 'reasoningEffort'>,
  native?: Pick<Staff, 'executor' | 'model' | 'reasoningEffort'>): Pick<Staff, 'executor' | 'model' | 'reasoningEffort'> {
  return native ?? { executor: member.executor ?? 'dsh', ...member.model && { model: member.model },
    ...member.model && member.reasoningEffort && { reasoningEffort: member.reasoningEffort } }
}

/**
 * 本工作区群聊的名册：接口人当管理员排第一，其后是本区幕僚（按幕僚资料里的顺序）。名字叫不到（含 `@`、是全员词……）
 * 或与前面的人同名（不分大小写）的跳过，远程幕僚跳过，总数不超过 12。
 */
export function groupRoster(input: {
  workspaceId: string
  /** 幕僚资料里本工作区的成员（`WorkspaceStaffStore.view(workspaceId).members`）。 */
  staff: readonly StaffMember[]
  /** 原生幕僚卡（`brain.staff()`）：执行方式与模型。 */
  native: readonly Pick<Staff, 'id' | 'executor' | 'model' | 'reasoningEffort'>[]
  defaults: ModelDefaults
  /** 幕僚在本区的执行资料（分工、经验）；读不到时只用名册里的分工。 */
  context?: (staffId: string) => StaffContext | undefined
  liaisonName?: string
}): GroupRosterMember[] {
  const liaison: GroupRosterMember = { id: LIAISON_MEMBER_ID, name: input.liaisonName ?? LIAISON_AUTHOR, admin: true, kind: 'dsh',
    ...input.defaults.liaison && { model: input.defaults.liaison } }
  const roster: GroupRosterMember[] = [liaison]
  const taken = new Set([liaison.name.toLowerCase()])
  for (const member of input.staff) {
    if (roster.length >= GROUP_LIMITS.maxMembers) break
    const membership = member.memberships.find(row => row.workspaceId === input.workspaceId)
    if (!membership || member.id === LIAISON_MEMBER_ID) continue
    const name = member.name.trim()
    if (nameProblem(name) || taken.has(name.toLowerCase())) continue
    const card = memberRunCard(member, input.native.find(row => row.id === member.id))
    if (card.executor === 'remote') continue
    const kind: GroupMemberKind = card.executor === 'codex' ? 'codex' : card.executor === 'claude-code' ? 'claude-code' : 'dsh'
    let context: StaffContext | undefined
    try { context = input.context?.(member.id) } catch { context = undefined }
    const model = kind === 'dsh' ? teammateSelection({ ...card, executor: 'dsh' }, input.defaults) ?? input.defaults.liaison : undefined
    const duty = context?.duty ?? membership.duty
    roster.push({ id: member.id, name, kind, brief: context?.brief ?? member.brief, ...duty && { duty },
      ...context?.memories.length && { memories: context.memories.map(row => row.text) }, ...model && { model }, ...context && { token: context.token } })
    taken.add(name.toLowerCase())
  }
  return roster
}

// ---------------------------------------------------------------------------------------------
// members.json

/**
 * 成员在本群的原生会话：DSH 会话 id，或编程工具的 thread / 会话 id；`cwd` 不同就是另一场会话。`memories` 是开这场会话以来
 * 给过它的本区经验（每条的指纹）：有经验被撤回（重置、收回共享）时，旧会话里的系统提示 / 开场白还留着它，所以换一场新会话。
 */
export interface MemberSessionBinding {
  kind: GroupMemberKind
  cwd: string
  session?: string
  at: string
  memories?: string[]
  /** Versions possibly exposed, including uncertain transport outcomes. Actual receipts live in the experience store. */
  experience?: ExperienceRef[]
  /** Versions confirmed as taken, used to prevent duplicate payloads on a safe continuation. */
  experienceSeen?: ExperienceRef[]
  /** Once a binding lost access, new sessions must continue to filter historical replies. */
  ownerReplayOnly?: true
  workOrderId?: string
  inputScoped?: true
}

/** 经验的指纹（只存指纹，不在映射里再存一份原文）。 */
export const memoryMarks = (memories: readonly string[] | undefined) => [...new Set((memories ?? []).map(text => dialogueKey('member-memory', text).slice(0, 16)))]
/** 这场会话见过、现在已不再给这位成员的经验：有就不能再续用这场会话。 */
export function memoriesRevoked(binding: Pick<MemberSessionBinding, 'memories'> | undefined, member: Pick<GroupRosterMember, 'memories'>): boolean {
  if (!binding?.memories?.length) return false
  const now = new Set(memoryMarks(member.memories))
  return binding.memories.some(mark => !now.has(mark))
}
/** 续用同一场会话时累积见过的经验；换新会话时只记现在的。 */
export const seenMemories = (binding: Pick<MemberSessionBinding, 'memories'> | undefined, member: Pick<GroupRosterMember, 'memories'>, fresh: boolean) =>
  [...new Set([...fresh ? [] : binding?.memories ?? [], ...memoryMarks(member.memories)])]
/** 正在跑的一回合投递了什么：DSH 会话里那条请求的 id，第几次推送，以及已经转给调度器的最后一个会话事件序号。 */
export interface LiveInputSteer { request: string; id: string; refs: ChatInputAttachment[] }
export interface LiveCallBinding { memberId: string; session: string; request: string; push: number; eventSeq?: number; at: string; inputAttachments?: ChatInputAttachment[]; inputSteers?: LiveInputSteer[]; experience?: ExperienceRef[] }
interface MembersFile { version: 1; members: Record<string, MemberSessionBinding>; live: Record<string, LiveCallBinding>; orders?: Record<string, MemberSessionBinding> }

const emptyMembers = (): MembersFile => ({ version: 1, members: {}, live: {} })
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const orderBinding = (memberId: string, workOrderId?: string) => JSON.stringify([memberId, workOrderId ?? null])

export class GroupMemberSessions {
  readonly path: string
  private data: MembersFile | undefined

  constructor(readonly dir: string, private readonly now: () => number = Date.now) {
    this.path = join(dir, GROUP_MEMBERS_FILE)
  }

  private read(): MembersFile {
    if (this.data) return this.data
    let value: unknown
    try {
      if (existsSync(this.path)) {
        if (!lstatSync(this.path).isFile()) throw new Error('成员会话映射的归属已改变。')
        value = JSON.parse(readFileSync(this.path, 'utf8'))
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('归属')) throw error
      value = undefined
    }
    const data = emptyMembers()
    if (isRecord(value) && value.version === 1) {
      if (isRecord(value.members)) for (const [id, row] of Object.entries(value.members)) {
        if (isRecord(row) && typeof row.kind === 'string' && typeof row.cwd === 'string') data.members[id] = row as unknown as MemberSessionBinding
      }
      if (isRecord(value.orders)) for (const [key, row] of Object.entries(value.orders)) {
        if (isRecord(row) && row.inputScoped === true && typeof row.kind === 'string' && typeof row.cwd === 'string') (data.orders ??= {})[key] = row as unknown as MemberSessionBinding
      }
      if (isRecord(value.live)) for (const [id, row] of Object.entries(value.live)) {
        if (isRecord(row) && typeof row.memberId === 'string' && typeof row.session === 'string' && typeof row.request === 'string') data.live[id] = row as unknown as LiveCallBinding
      }
    }
    return this.data = data
  }

  private write(next: MembersFile) {
    const temporary = this.path + '.tmp'
    try {
      mkdirSync(this.dir, { recursive: true })
      if (existsSync(this.path) && !lstatSync(this.path).isFile()) throw new Error('成员会话映射的归属已改变。')
      writeFileSync(temporary, JSON.stringify(next) + '\n', { mode: 0o600 })
      renameSync(temporary, this.path)
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* nothing left to clean */ }
      throw error
    }
    this.data = next
  }

  member(memberId: string): MemberSessionBinding | undefined { return this.read().members[memberId] }

  hasLegacyExperience() {
    const {members, orders} = this.read()
    return [...Object.values(members), ...Object.values(orders ?? {})]
      .some(binding => !!binding.memories?.length || binding.ownerReplayOnly === true)
  }

  /** Keep the original text-only thread until the first material arrives. Thereafter native history belongs to its order. */
  native(memberId: string, workOrderId?: string): MemberSessionBinding | undefined {
    const latest = this.member(memberId)
    return latest?.inputScoped && latest.workOrderId !== workOrderId ? this.read().orders?.[orderBinding(memberId, workOrderId)] : latest
  }

  scopeInputs(memberId: string, workOrderId: string | undefined, session: string) {
    const current = this.member(memberId)
    if (current?.session === session && !current.inputScoped) this.setMember(memberId, {...current, inputScoped: true, workOrderId})
  }

  /** 记下成员在本群的原生会话（换目录或换执行方式即覆盖）。 */
  setMember(memberId: string, binding: Omit<MemberSessionBinding, 'at'>) {
    const data = this.read()
    const previous = data.members[memberId]
    if (previous?.inputScoped) binding = {...binding, inputScoped: true}
    if (previous && previous.kind === binding.kind && previous.cwd === binding.cwd && previous.session === binding.session
      && previous.workOrderId === binding.workOrderId && previous.inputScoped === binding.inputScoped
      && previous.ownerReplayOnly === binding.ownerReplayOnly
      && JSON.stringify(previous.experience) === JSON.stringify(binding.experience)
      && JSON.stringify(previous.experienceSeen) === JSON.stringify(binding.experienceSeen)
      && JSON.stringify(previous.memories ?? []) === JSON.stringify(binding.memories ?? [])) return
    const next = {...binding, at: new Date(this.now()).toISOString()}
    this.write({ ...data, members: { ...data.members, [memberId]: next }, ...next.inputScoped && {orders: {...data.orders, [orderBinding(memberId, binding.workOrderId)]: next}} })
  }

  live(callId: string): LiveCallBinding | undefined { return this.read().live[callId] }
  lives(): Readonly<Record<string, LiveCallBinding>> { return this.read().live }

  setLive(callId: string, binding: Omit<LiveCallBinding, 'at'>) {
    const data = this.read()
    this.write({ ...data, live: { ...data.live, [callId]: { ...binding, at: new Date(this.now()).toISOString() } } })
  }

  inputSteer(callId: string, request: string, input?: LiveInputSteer) {
    const row = this.live(callId)
    if (!row) return
    const pending = (row.inputSteers ?? []).filter(steer => steer.request !== request)
    if (input) pending.push(input)
    this.setLive(callId, {...row, inputSteers: pending})
  }

  /** 已转给调度器的最后一个会话事件；只前进。 */
  advanceLive(callId: string, eventSeq: number) {
    const data = this.read()
    const row = data.live[callId]
    if (!row || (row.eventSeq ?? 0) >= eventSeq) return
    this.write({ ...data, live: { ...data.live, [callId]: { ...row, eventSeq } } })
  }

  clearLive(callId: string) {
    const data = this.read()
    if (!data.live[callId]) return
    const live = { ...data.live }
    delete live[callId]
    this.write({ ...data, live })
  }
}
