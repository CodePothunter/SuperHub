import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import type { Engine } from '../core/engine.ts'
import { threadIdOf, type Staff } from '../core/model.ts'
import { currentFeature, featureAnchors, selectFeature, type FeatureEvidence, type FeatureRef, type IntakeContext, type IntakeInterpretation } from '../core/superhub-intake.ts'
import type { SessionEventLike } from './ports.ts'
import { json, type Route } from './http.ts'

type IntakeChannel = 'chat' | 'discussion' | 'owner' | 'native'
type IntakeState = 'recorded' | 'clarify' | 'ready' | 'dispatching' | 'dispatched' | 'stopped' | 'failed' | 'conversation'
type GoalDisposition = 'unassigned' | 'associated' | 'independent' | 'disputed'

export interface IntakeSource {
  id: string
  requestId: string
  channel: IntakeChannel
  text: string
  inputAttachments?: ChatInputAttachment[]
  receivedAt: string
  roomId?: string
  messageId?: string
  /** The owner's location when the original words were submitted. It grants no execution authority. */
  context?: IntakeContext
}

export interface IntakeItem extends IntakeInterpretation {
  id: string
  title: string
  state: IntakeState
  goalIds: string[]
  goalDisposition: GoalDisposition
  ticketId?: string
  priorTicketIds?: string[]
  correction?: { text: string; work: string; at: string }
  stop?: { ticketId: string; state: 'pending' | 'confirmed' | 'finished'; at: string }
}

/**
 * 接口人转述的交办：主人本轮原话是授权来源，接口人提交的结构化理解是工作内容。
 * 两者都原样保存，回执里能看出「接口人依据主人原话 X 理解为 Y（读写方式、限制、负责人）」。
 */
export interface LiaisonAuthorization {
  by: 'liaison'
  ownerText: string
  brief: string
  requestId: string
  messageId: string
  /** 接口人判断的意图：execute 交给幕僚去做；memo 主人只要求记下。旧回执没有这些字段。 */
  intent?: 'execute' | 'memo'
  operation?: 'read' | 'write'
  /** 主人原话里明确提出的限制（逐条摘自原话，写进契约的禁止项）。 */
  restrictions?: string[]
  staff?: string
  sessionId?: string
  roomId?: string
  /** 这句主人原话经网页对话或 SuperHub 交办进来时的原话回执（只记原话、转给接口人的那一份）。 */
  chatReceiptId?: string
  /** 主人在 SuperHub 里亲自指定的项（读写方式、负责人、功能），覆盖接口人的理解。 */
  ownerChoices?: OwnerChoices
  /** 界面修改：接口人从功能目录选定的功能及依据。 */
  feature?: FeatureEvidence
}

/** 主人在 SuperHub 交办时亲自选的项。系统不解读原话，这些显式选择优先于接口人的理解。 */
export interface OwnerChoices {
  operation?: 'read' | 'write'
  staff?: string
  feature?: FeatureRef
}

export interface IntakeReceipt {
  id: string
  scope: string
  source: IntakeSource
  version: number
  updatedAt: string
  items: IntakeItem[]
  history: { version: number; at: string; item: IntakeItem }[]
  authorization?: LiaisonAuthorization
  /** 原话回执：主人在 SuperHub 亲自指定的项。 */
  ownerChoices?: OwnerChoices
  /** 原话回执：接口人依据这句原话登记的回执（交办、备忘、界面修改），按登记顺序。 */
  liaisonReceipts?: string[]
}

/** 回执详情：原话回执附上接口人依据它登记的回执。 */
export type IntakeReceiptView = IntakeReceipt & { linked?: IntakeReceipt[] }

/** 接口人提交的交办：source 必须是宿主确认的主人本轮原话（私聊）或讨论里主人的原话。 */
export interface LiaisonRequest {
  source: { requestId: string; messageId: string; text: string }
  sessionId?: string
  roomId?: string
  /** 接口人理解后的完整任务说明。 */
  brief: string
  title?: string
  staff?: string
  /** execute（缺省）：交给幕僚去做；memo：主人只要求记下，记入回执，不派工。 */
  intent?: 'execute' | 'memo'
  /** intent=execute 时必填。read：只读调查，直接派工；write：要改文件、执行命令或对外写入，建单后等主人批准。 */
  operation?: 'read' | 'write'
  /** 主人本轮原话里明确提出的限制，每条必须是原话中的片段；写进契约的禁止项。 */
  restrictions?: readonly string[]
  doneWhen?: readonly string[]
  /** 授权来源已不在主人本轮之内：只返回同样参数已登记的回执，否则以 409 拒绝，不新建。 */
  existingOnly?: boolean
  /** 界面源码修改（chief_ui source）：接口人从功能目录选定的功能与依据。交给界面师，按界面修改的边界执行。 */
  ui?: { feature: { id: string; version?: number }; basis: string }
}

const compact = (text: string) => text.replace(/\s+/g, '')
/**
 * 接口人摘录的主人限制：每条必须原样出自主人原话（忽略空白差异），最多 12 条、每条 200 字内。
 * 系统不解读限制的含义，只保证契约里的禁止项都是主人说过的话。
 */
export function liaisonRestrictions(value: unknown, ownerText: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 12) return bad('restrictions 是主人原话里限制的列表（最多 12 条），未建单')
  const rows = [...new Set(value.map(row => typeof row === 'string' ? row.trim() : ''))]
  const said = compact(ownerText)
  for (const row of rows) {
    if (!row || row.length > 200) return bad('restrictions 每条须为 1 到 200 字，未建单')
    if (!said.includes(compact(row))) {
      return bad(`限制「${row.slice(0, 60)}」不是主人本轮原话里的片段，未建单。restrictions 只原样摘录主人明确说出的限制（例如「先别改」「不要部署」）；你自己的理解和工作边界写进任务说明。`)
    }
  }
  return rows
}

interface LiaisonPlan {
  brief: string
  operation: 'read' | 'write'
  staff?: string
  doneWhen?: string[]
  roomId?: string
  messageId: string
}

/** 旧版讨论移交（按讨论原话派工）留下的记录：只为已保存的回执与待登记的派工能继续恢复。新的讨论派工走 fromLiaison。 */
interface RoomHandoff {
  roomId: string
  messageId: string
  text: string
  title: string
  staff: string
  scopeText: string
  doneWhen: readonly string[]
}

interface SourceContext {
  channel: 'chat' | 'owner'
  sessionId?: string
  chatMode?: 'auto' | 'queue' | 'steer'
  inputAttachments?: ChatInputAttachment[]
}

interface Dispatch {
  id: string
  itemId: string
  staff: string
  level: 'think' | 'propose' | 'write'
  workspace?: string
  goal: string
  doneWhen: string[]
  allowed: string[]
  denied: string[]
  room?: { id: string; source: string }
  /** 界面源码修改（level write，插件源码工作区）：建单后等主人批准才执行。旧派工记录没有此字段，按原样重放。 */
  approval?: true
}

interface Entry {
  receipt: IntakeReceipt
  commands: Dispatch[]
  pending: { dispatch: Dispatch; afterStop?: string }[]
  cancelled: string[]
  handoff?: RoomHandoff
  liaison?: LiaisonPlan
}

interface State {
  schema: 1
  scope: string
  entries: Entry[]
  requests: Record<string, { fingerprint: string; receiptId: string }>
}

interface IntakeOptions {
  root: string
  chiefHome: string
  brainScope: string
  engine: Pick<Engine, 'commission' | 'views' | 'stopTicket' | 'isRetiredTicket' | 'isRetiredSuperhubCommand'>
  hasGoal?: (id: string) => boolean
  staff?: () => readonly Staff[]
  uiWorkspace?: string
  uiCanBegin?: () => void
  /** 把主人的原话交给接口人（SuperHub 交办与补充原话走这里）。requestId 作为宿主的人类请求标识，接口人据此取得授权来源。 */
  liaison?: (text: string, requestId: string, inputAttachments?: readonly ChatInputAttachment[]) => Promise<void>
  now?: () => Date
}

const FORWARDED = '原话已交给接口人：由接口人理解后决定交办、记下或直接回答。接口人登记的工作会列在这张回执里；没有列出时，这句话只作为对话。'
const CLARIFIED = '主人补充的原话已交给接口人重新理解；接口人登记的工作会列在这张回执里。'
const UNDELIVERED = '原话已保存，还没交给接口人'
/** 原话已保存、正在转交：转交确认后才改成 FORWARDED / CLARIFIED，转交前进程中断时回执不会误称已交给接口人。 */
const PENDING = `${UNDELIVERED}（正在转交）。`
const hash = (parts: unknown) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const bad = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }) }
const requestKey = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) return bad('请提供有效的请求标识')
  return value
}
const nonempty = (value: unknown, max: number, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return bad(`${label}须为 1 到 ${max} 字`)
  return value
}

function featureRef(value: unknown): FeatureRef | undefined {
  if (value === undefined) return undefined
  const ref = value as Partial<FeatureRef> | null
  if (!ref || typeof ref.id !== 'string' || !ref.id || ref.id.length > 100 || !Number.isSafeInteger(ref.version) || ref.version! < 1) return bad('请提供功能标识和有效版本')
  return { id: ref.id, version: ref.version! }
}

function contextOf(value: unknown): IntakeContext | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('界面上下文无效')
  const { surface, device, selectedId, sessionId, workOrderId } = value as Record<string, unknown>
  if ((surface !== undefined && (typeof surface !== 'string' || surface.length > 60))
    || (device !== undefined && device !== 'desktop' && device !== 'mobile')
    || [selectedId,sessionId,workOrderId].some(id => id !== undefined && (typeof id !== 'string' || id.length > 160))) return bad('界面上下文无效')
  return { surface, device, selectedId, ...(surface === 'workspace' && selectedId && sessionId
    ? {sessionId, ...(workOrderId ? {workOrderId} : {})} : {}) } as IntakeContext
}

/**
 * Native tool authorization only uses a human RPC input observed in the active turn: the latest
 * owner message that started the turn (`user/message`) or was spliced into it while it ran.
 */
function nativeOwnerInput(events: readonly SessionEventLike[]) {
  type Input = { id?: unknown; source?: { kind?: unknown; rpcId?: unknown }; content?: unknown }
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.type === 'turn/end') return undefined
    const splice = event.type === 'agent/inbox/spliced' ? event.data as { target?: string; inserted?: Input[] } | undefined : undefined
    const inputs: { input: Input | undefined; fallback: string }[] = event.type === 'user/message' ? [{ input: event.data as Input | undefined, fallback: String(event.seq) }]
      : splice && splice.target !== 'next-turn' ? (splice.inserted ?? []).map((input, at) => ({ input, fallback: `${event.seq}:${at}` }))
      : []
    for (const { input: data, fallback } of inputs.reverse()) {
      if (data?.source?.kind !== 'user') continue
      if (typeof data.source.rpcId !== 'string' || !data.source.rpcId || !Array.isArray(data.content)) return undefined
      const blocks = data.content as { type?: string; text?: unknown }[]
      const text = blocks.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
      const at = new Date(event.time).toJSON()
      if (text.trimStart().startsWith('〔系统〕')) return undefined
      return {
        source: { requestId: data.source.rpcId, messageId: typeof data.id === 'string' ? data.id : fallback, text, ...(at && {at}) },
        hasAttachment: blocks.some(block => block.type === 'file' || block.type === 'image'),
      }
    }
  }
}

export function nativeIntakeSource(events: readonly SessionEventLike[]) {
  const input = nativeOwnerInput(events)
  return input?.source.text.trim() ? input.source : undefined
}

export function nativeAttachmentOnlyTurn(events: readonly SessionEventLike[]): boolean {
  const input = nativeOwnerInput(events)
  return !!input?.hasAttachment && !input.source.text.trim()
}

/**
 * Brain-local owner input journal. The raw source and intent history live outside
 * the brain's automatic Git commit path. A command is persisted before engine
 * submission, and the engine uses the same command identity on each retry.
 */
export class SuperhubIntake {
  readonly scope: string
  private readonly directory: string
  private readonly file: string
  private state: State
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: IntakeOptions) {
    this.scope = options.brainScope
    const local = join(options.chiefHome, 'superhub', hash(this.scope))
    const withinBrain = relative(options.root, local)
    this.directory = isAbsolute(withinBrain) || withinBrain.startsWith('../') ? local : join(dirname(options.root), '.dsh-chief-superhub', hash(this.scope))
    this.file = join(this.directory, 'intake.json')
    try {
      const state = JSON.parse(readFileSync(this.file, 'utf8')) as State
      if (state.schema !== 1 || state.scope !== this.scope || !Array.isArray(state.entries) || !state.requests) throw Error('SuperHub 回执存储与当前第二大脑不匹配')
      this.state = state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.state = { schema: 1, scope: this.scope, entries: [], requests: {} }
    }
  }

  private iso() { return (this.options.now?.() ?? new Date()).toISOString() }

  checkScope(value: unknown) {
    if (value !== this.scope) bad('第二大脑已切换，请在当前界面确认后重试', 409)
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.catch(() => {})
    return result
  }

  private save(next: State) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(next), { mode: 0o600 })
      renameSync(temp, this.file)
    } finally { rmSync(temp, { force: true }) }
    this.state = next
  }

  private update(entry: Entry, ...marks: { key: string; fingerprint: string }[]) {
    const index = this.state.entries.findIndex(row => row.receipt.id === entry.receipt.id)
    const entries = [...this.state.entries]
    if (index < 0) entries.push(entry)
    else entries[index] = entry
    const requests = { ...this.state.requests, ...Object.fromEntries(marks.map(mark => [mark.key, { fingerprint: mark.fingerprint, receiptId: entry.receipt.id }])) }
    this.save({ ...this.state, entries, requests })
  }

  private record(key: string, fingerprint: string): Entry | undefined {
    const mark = this.state.requests[key]
    if (!mark) return undefined
    if (mark.fingerprint !== fingerprint) return bad('此请求标识已用于不同的内容，请重新确认', 409)
    return this.entry(mark.receiptId)
  }

  private entry(id: string): Entry {
    return this.state.entries.find(row => row.receipt.id === id) ?? bad('没有这条交办回执', 404)
  }

  private retiredTicket(id: string | undefined): boolean {
    return !!id && this.options.engine.isRetiredTicket(id)
  }

  private retiredWork(entry: Entry, item: IntakeItem): boolean {
    return this.retiredTicket(item.ticketId) || entry.pending.some(({dispatch, afterStop}) =>
      dispatch.itemId === item.id && (this.retiredTicket(afterStop) || this.options.engine.isRetiredSuperhubCommand(dispatch.id)))
  }

  private present(entry: Entry): IntakeReceipt {
    const receipt = structuredClone(entry.receipt)
    const retired = (item: IntakeItem) => item.intent === 'execute' && this.retiredWork(entry, item)
    const ids = new Set(receipt.items.filter(retired).map(item => item.id))
    const detach = (item: IntakeItem) => {
      if (this.retiredTicket(item.ticketId)) delete item.ticketId
      if (this.retiredTicket(item.stop?.ticketId)) delete item.stop
      if (item.priorTicketIds) item.priorTicketIds = item.priorTicketIds.filter(id => !this.retiredTicket(id))
      return item
    }
    receipt.items = receipt.items.filter(item => !ids.has(item.id)).map(detach)
    receipt.history = receipt.history.filter(({item}) => !ids.has(item.id) && !retired(item))
      .map(row => ({...row, item: detach(row.item)}))
    if (receipt.liaisonReceipts) receipt.liaisonReceipts = receipt.liaisonReceipts.filter(id => {
      const linked = this.state.entries.find(row => row.receipt.id === id)
      return linked?.receipt.items.some(item => item.intent !== 'execute' || !this.retiredWork(linked, item))
    })
    if (!receipt.items.length) delete receipt.authorization
    const context = receipt.source.context
    if (context && this.retiredTicket(context.workOrderId)) delete context.workOrderId
    return receipt
  }

  private goalIds(value: unknown): string[] {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== 'string' || !id || id.length > 120)) return bad('目标标识无效')
    return [...new Set<string>(value)]
  }

  private checkGoals(ids: readonly string[]) {
    const hasGoal = this.options.hasGoal
    if (hasGoal && ids.some(id => !hasGoal(id))) bad('目标不存在或已失效，请刷新后重新选择', 409)
  }

  private hasPermission(item: IntakeItem) {
    return item.intent === 'execute' && item.operation && !item.question
  }

  /** 选一位本地幕僚；指定的不存在时说明可选的人。 */
  private localStaff(choice: string | undefined, write: boolean): string {
    const everyone = this.options.staff?.()
    const roster = everyone?.filter(role => role.executor !== 'remote')
    if (!roster) return choice ?? (write ? 'engineer' : 'researcher')
    if (choice) {
      const remote = everyone!.find(role => role.id === choice && role.executor === 'remote')
      if (remote) {
        bad(`「${remote.name}（${remote.id}）」是远程幕僚，在工作电脑上执行：远程幕僚需经工作电脑工单交办，这里不能直接建单交给他。`
          + `请主人在作战台他的幕僚卡上「点名交给${remote.name}」，或改选本地幕僚（${roster.map(role => `${role.name}（${role.id}）`).join('、')}）。未建单。`, 409)
      }
      if (!roster.some(role => role.id === choice)) bad(`没有可用的本地幕僚「${choice}」，未建单。可选：${roster.map(role => `${role.name}（${role.id}）`).join('、')}`, 409)
      return choice
    }
    const preferred = (write ? ['engineer', 'strategist'] : ['researcher', 'strategist']).find(id => roster.some(role => role.id === id))
    return preferred ?? roster.find(role => role.executor === 'dsh' && role.id !== 'chief' && role.id !== 'reviewer')?.id
      ?? bad('当前没有可用的本地幕僚，未建单。请先在作战台添加幕僚。', 409)
  }

  private liaisonCommand(item: IntakeItem, plan: LiaisonPlan, ownerText: string, staffChoice?: string): Dispatch {
    const write = item.operation === 'write'
    const selected = this.localStaff(staffChoice ?? plan.staff ?? item.staffHint, write)
    const denied = [...new Set([...item.restrictions, ...(write ? ['部署或对外发送'] : ['修改配置、代码或数据', '部署或对外发送'])])]
    const bounds = write
      ? '本工单需主人批准后才执行。批准后命令逐条按单次审批执行，只写入完成任务所需的位置。'
      : '只读调查：可以读取资料、工单与执行记录，产物只写入交付工作目录，不修改配置、代码或数据。'
    return {
      id: randomUUID(), itemId: item.id, staff: selected, level: write ? 'propose' : 'think',
      goal: [`主人原话：「${ownerText.slice(0, 1500)}」`, `接口人理解的任务：${plan.brief}`, bounds, `禁止：${denied.join('；')}。`].join('\n'),
      doneWhen: plan.doneWhen?.length ? [...plan.doneWhen] : ['交付结论和可复核证据，覆盖主人指定的范围并标注限制'],
      allowed: write ? ['read', 'research', 'execute-after-owner-approval', 'deliver'] : ['read', 'research', 'deliver'],
      denied, ...(write && plan.roomId ? { room: { id: plan.roomId, source: plan.messageId } } : {}),
    }
  }

  private command(item: IntakeItem, entry: Entry, staffChoice?: string): Dispatch {
    if (entry.liaison) return this.liaisonCommand(item, entry.liaison, entry.receipt.source.text, staffChoice)
    const handoff = entry.handoff
    const ui = item.operation === 'write' && !handoff
    const preferred = item.operation === 'read' ? 'researcher' : 'strategist'
    const staff = this.options.staff?.().filter(role => role.executor !== 'remote')
    const selected = staffChoice ?? handoff?.staff ?? (ui ? 'ui-smith' : item.staffHint ?? staff?.find(role => role.id === preferred)?.id ?? staff?.find(role => role.executor === 'dsh')?.id ?? preferred)
    if (staff && !staff.some(role => role.id === selected)) return bad('请选择当前可用的本地幕僚', 409)
    const target = item.feature ? `功能：${item.feature.title}（${item.feature.id} v${item.feature.version}）。` : ''
    const work = item.correction?.work ?? item.text
    const allowed = ui ? ['read', 'edit-ui', 'test', 'deliver'] : ['read', 'research', 'deliver']
    const denied = [...new Set([...item.restrictions, ...(ui ? ['修改引擎、服务端或其他非界面源码', '对外发送或部署'] : ['修改受保护源码、部署或对外发送'])])]
    const bounds = ui ? '主人批准后才开始修改。只允许修改 src/client/、src/mobile/ 下与此功能有关的界面文件。交付后等待主人验收。' : '只在交付工作目录内写产物。'
    return {
      id: randomUUID(), itemId: item.id, staff: selected, level: handoff ? 'propose' : ui ? 'write' : 'think',
      ...(ui ? { workspace: this.options.uiWorkspace } : {}),
      goal: [entry.receipt.authorization ? `主人原话：「${entry.receipt.source.text.slice(0, 1500)}」` : '', target, entry.receipt.authorization ? `接口人理解的界面修改：${work}` : work,
        handoff ? `讨论建议范围（以主人原话为限）：${handoff.scopeText}` : '', bounds, `禁止：${denied.join('；')}。`].filter(Boolean).join('\n'),
      doneWhen: handoff ? [...handoff.doneWhen] : ui ? [
        '已实现主人指定的界面变化，改动仅涉及相应的界面文件',
        '以登记的 ui-source-proof.json 交付版本核对实际改动的界面输入路径与内容摘要，并核对同一份输入的类型检查、测试及路径范围检查',
        '交付受影响的界面、变更范围和可复核证据',
      ] : ['交付结论和可复核证据，覆盖主人指定的范围并标注限制'],
      allowed, denied, ...(handoff ? { room: { id: handoff.roomId, source: handoff.messageId } } : {}),
      // 方案 A：改文件的工作都要主人批准。界面源码修改直接在插件开发目录里改，批准前零执行（含主人在 SuperHub 亲自选了写入与功能：选择不等于批准）。
      ...(ui ? { approval: true as const } : {}),
    }
  }

  private stage(entry: Entry, item: IntakeItem, staff?: string, afterStop?: string) {
    if (!entry.liaison) this.checkOwnerStage(entry, item, staff)
    if (item.state === 'clarify') return
    const dispatch = this.command(item, entry, staff)
    item.state = 'dispatching'
    entry.commands.push(dispatch)
    entry.pending.push({ dispatch, afterStop })
  }

  /** 主人直接输入的交办：功能定位与界面源码修改的边界。 */
  private checkOwnerStage(entry: Entry, item: IntakeItem, staff?: string) {
    if (item.feature && !currentFeature(item.feature)) {
      item.state = 'clarify'
      item.question = '功能版本已更新，请重新确认当前定位。'
      return
    }
    if (item.operation === 'write' && !entry.handoff) {
      if (!this.options.uiWorkspace || (staff ?? item.staffHint ?? 'ui-smith') !== 'ui-smith') {
        item.state = 'clarify'
        item.question = this.options.uiWorkspace ? '源码修改需确认由界面师在指定界面范围内处理。' : '当前实例未启用界面源码修改。请确认是否只需要调研或方案。'
        return
      }
      if (entry.pending.some(row => row.dispatch.level === 'write') || this.state.entries.some(row => row.pending.some(command => command.dispatch.level === 'write'))) {
        bad('有一项界面修改正在登记工单，请待回执确认后再试', 409)
      }
      this.options.uiCanBegin?.()
    }
  }

  allowsCommand(scope: { brainScope: string; sourceId: string; commandId: string }): boolean {
    if (scope.brainScope !== this.scope) return false
    const entry = this.state.entries.find(row => row.receipt.source.id === scope.sourceId)
    if (!entry || entry.cancelled.includes(scope.commandId)) return false
    const command = entry.commands.find(row => row.id === scope.commandId)
    const item = command && entry.receipt.items.find(row => row.id === command.itemId)
    return !!item && item.intent === 'execute' && !this.retiredWork(entry, item) && (!item.feature || currentFeature(item.feature))
      && (item.state === 'dispatching' || item.state === 'dispatched')
  }

  private change(entry: Entry, item: IntakeItem) {
    entry.receipt.history.push({ version: entry.receipt.version, at: entry.receipt.updatedAt, item: structuredClone(item) })
    entry.receipt.version++
    entry.receipt.updatedAt = this.iso()
  }

  private async stop(ticketId: string) {
    const ticket = this.options.engine.views().find(row => row.ticket.id === ticketId)?.ticket
    if (!ticket?.superhub || ticket.superhub.brainScope !== this.scope) return bad('原工单与当前第二大脑不匹配', 409)
    if (ticket.ended) return ticket.ended.outcome === 'stopped' ? 'confirmed' : 'finished'
    await this.options.engine.stopTicket(ticketId, '主人在交办回执中撤销旧授权', {
      threadId: threadIdOf(ticket), replyTo: ticket.assignments.at(-1)?.id ?? null, brainScope: this.scope,
      contractVersion: ticket.superhub.contracts.at(-1)?.version,
    })
    return 'confirmed'
  }

  private async advance(id: string): Promise<IntakeReceipt> {
    const entry = structuredClone(this.entry(id))
    for (const item of entry.receipt.items) {
      if (item.stop?.state !== 'pending' || this.retiredTicket(item.stop.ticketId)) continue
      const state = await this.stop(item.stop.ticketId)
      this.change(entry, item)
      item.stop = { ...item.stop, state, at: this.iso() }
      this.update(structuredClone(entry))
    }
    for (const pending of [...entry.pending]) {
      const { dispatch } = pending
      const item = entry.receipt.items.find(row => row.id === dispatch.itemId)!
      if (this.retiredWork(entry, item)) continue
      if (!this.allowsCommand({ brainScope: this.scope, sourceId: entry.receipt.source.id, commandId: dispatch.id })) {
        if (item.feature && !currentFeature(item.feature)) {
          this.change(entry, item)
          item.state = 'clarify'
          item.question = '功能版本已更新，请重新确认当前定位。'
          entry.pending = entry.pending.filter(row => row.dispatch.id !== dispatch.id)
          entry.cancelled.push(dispatch.id)
          this.update(structuredClone(entry))
        }
        continue
      }
      if (pending.afterStop && (item.stop?.ticketId !== pending.afterStop || item.stop.state === 'pending')) continue
      let ticketId: string
      try {
        ticketId = await this.options.engine.commission({
          text: entry.receipt.authorization ? entry.receipt.source.text : item.text, title: item.title, staff: dispatch.staff, level: dispatch.level, scope: dispatch.goal,
          workspace: dispatch.workspace, doneWhen: dispatch.doneWhen, needsReview: true, room: dispatch.room,
          requestKey: `superhub:${this.scope}:${dispatch.id}`,
          superhub: { brainScope: this.scope, sourceId: entry.receipt.source.id, commandId: dispatch.id, allowed: dispatch.allowed, denied: dispatch.denied,
            ...dispatch.approval ? { approvalRequired: true } : {} },
        })
      } catch (error) {
        const reason = `派工回执未确认，可重试同一请求：${(error as Error).message}`.slice(0, 300)
        if (item.reason !== reason) {
          this.change(entry, item)
          item.reason = reason
          this.update(structuredClone(entry))
        }
        continue
      }
      this.change(entry, item)
      item.state = 'dispatched'
      item.ticketId = ticketId
      item.reason = '引擎已登记正式工单'
      entry.pending = entry.pending.filter(row => row.dispatch.id !== dispatch.id)
      this.update(structuredClone(entry))
    }
    return this.present(entry)
  }

  private async replay(id: string): Promise<IntakeReceipt> {
    const receipt = await this.advance(id)
    return receipt.items.length ? receipt : bad('这张工单已不可用。', 404)
  }

  /** Resume durable commands after the runtime has finished initializing. */
  resume(report: (error: unknown) => void): Promise<void> {
    return this.serial(async () => {
      for (const { receipt, pending } of this.state.entries) {
        if (!pending.length && !receipt.items.some(item => item.stop?.state === 'pending')) continue
        try { await this.advance(receipt.id) } catch (error) { report(error) }
      }
    })
  }

  /** 原话回执的请求键：网页对话（chat）与 SuperHub 交办（owner）。接口人登记时按宿主请求标识找回它。 */
  private originKey(channel: 'chat' | 'owner', requestId: string) { return hash(['submit', channel, '', requestId]) }

  private ownerChoices(input: Record<string, unknown>, feature?: FeatureRef): OwnerChoices | undefined {
    const { operation, staff } = input
    if (operation !== undefined && operation !== 'read' && operation !== 'write') return bad('读写方式只能是 read（只读）或 write（写入，需批准）')
    if (staff !== undefined) this.localStaff(nonempty(staff, 60, '幕僚标识'), operation === 'write')
    if (feature && !currentFeature(feature)) return bad('功能版本已更新，请刷新后重新选择', 409)
    const choices: OwnerChoices = { ...operation ? { operation } : {}, ...typeof staff === 'string' ? { staff } : {}, ...feature ? { feature } : {} }
    return Object.keys(choices).length ? choices : undefined
  }

  /**
   * 记下主人的原话（网页对话 chat、SuperHub 交办 owner），系统不解读它。调用方随后用 deliver 把原话交给接口人；
   * 接口人理解后经 fromLiaison 登记的回执挂在这张原话回执下（liaisonReceipts）。
   * 主人在 SuperHub 亲自选的读写方式、负责人和功能存为 ownerChoices，接口人登记时以它们为准。
   */
  submit(input: Record<string, unknown>, origin: SourceContext = { channel: 'owner' }): Promise<IntakeReceipt> {
    return this.serial(async () => {
      this.checkScope(input.scope)
      const request = requestKey(input.requestId)
      const attachments = origin.channel === 'chat' && origin.inputAttachments?.length ? origin.inputAttachments : undefined
      const text = attachments && (input.text === undefined || typeof input.text === 'string' && !input.text.trim() && input.text.length <= 40_000)
        ? '' : nonempty(input.text, 40_000, '原话')
      const feature = featureRef(input.feature)
      const context = contextOf(input.context)
      const goalIds = this.goalIds(input.goalIds)
      const choices = origin.channel === 'owner' ? this.ownerChoices(input, feature) : undefined
      const key = this.originKey(origin.channel, request)
      const fingerprint = hash([text, feature, context, goalIds, origin.sessionId, undefined, origin.chatMode,
        ...choices?.operation || choices?.staff ? [choices.operation ?? null, choices.staff ?? null] : [],
        ...attachments ? [attachments.map(({ id, name }) => [id, name])] : []])
      const previous = this.record(key, fingerprint)
      if (previous) return this.replay(previous.receipt.id)
      this.checkGoals(goalIds)
      const at = this.iso()
      const receipt: IntakeReceipt = {
        id: randomUUID(), scope: this.scope, version: 1, updatedAt: at, history: [],
        source: { id: randomUUID(), requestId: request, channel: origin.channel, text, receivedAt: at, ...context ? { context } : {},
          ...attachments && { inputAttachments: structuredClone(attachments) } },
        items: [{ id: randomUUID(), title: text ? text.replace(/\s+/g, ' ').trim().slice(0, 100) : '聊天附件', text, span: { start: 0, end: text.length },
          intent: 'conversation', state: 'conversation', restrictions: [], reason: PENDING, goalIds, goalDisposition: goalIds.length ? 'associated' : 'unassigned' }],
        ...choices ? { ownerChoices: choices } : {},
      }
      this.update({ receipt, commands: [], pending: [], cancelled: [] }, { key, fingerprint })
      return structuredClone(receipt)
    })
  }

  /**
   * 把原话交给接口人。失败时在回执里写明原因并抛出（同一请求重试即可，接口人那边按请求标识去重）。
   * 只有尚未派工的原话回执会转交：旧版按原话预解读并已派工、记下的回执重放时不再转交。
   */
  async deliver(receiptId: string, itemId: string, text: string, requestId: string, send = this.options.liaison, done = FORWARDED): Promise<void> {
    const mark = (reason: string) => this.serial(async () => {
      const entry = structuredClone(this.entry(receiptId))
      const item = entry.receipt.items.find(row => row.id === itemId)
      if (!item || item.reason === reason || (reason === done && !item.reason.startsWith(UNDELIVERED))) return
      item.reason = reason
      this.update(entry)
    })
    const receipt = this.entry(receiptId).receipt
    if (receipt.items.some(item => item.id === itemId && item.reason === done)) return
    // A linked retired dispatch proves these exact words already reached the liaison,
    // even if the send acknowledgement was lost before the source receipt was updated.
    if (receipt.liaisonReceipts?.some(id => {
      const linked = this.state.entries.find(row => row.receipt.id === id && row.receipt.source.requestId === requestId)
      return linked?.receipt.items.some(item => this.retiredWork(linked, item))
    })) {
      await mark(done)
      return
    }
    try {
      if (!send) return bad('当前没有接口人会话，原话已保存', 503)
      const attachments = requestId === receipt.source.requestId ? receipt.source.inputAttachments : undefined
      if (attachments?.length) await send(text, requestId, attachments)
      else await send(text, requestId)
    } catch (error) {
      const failure = error as Error & { status?: number }
      await mark(`${UNDELIVERED}（${failure.message.slice(0, 200)}）。用同一请求重试即可，不会重复。`)
      throw Object.assign(failure, { status: failure.status ?? 503 })
    }
    await mark(done)
  }

  /** 接口人登记时找回这句原话的原话回执（网页对话或 SuperHub 交办、补充原话）。 */
  private originOf(requestId: string): Entry | undefined {
    const mark = this.state.requests[this.originKey('chat', requestId)] ?? this.state.requests[this.originKey('owner', requestId)]
    return mark ? this.state.entries.find(row => row.receipt.id === mark.receiptId) : undefined
  }

  /** A native human RPC may reference an entry from this brain only when the original words match. */
  ownerTurnOrigin(source: { requestId: string; text: string }) {
    const receipt = this.originOf(source.requestId)?.receipt
    if (receipt?.scope === this.options.brainScope && receipt.source.text === source.text) {
      return { context: receipt.source.context, operation: receipt.ownerChoices?.operation, inputAttachments: receipt.source.inputAttachments }
    }
  }

  private linkOrigin(originId: string, receiptId: string) {
    const origin = structuredClone(this.entry(originId))
    if (origin.receipt.liaisonReceipts?.includes(receiptId)) return
    origin.receipt.liaisonReceipts = [...origin.receipt.liaisonReceipts ?? [], receiptId]
    origin.receipt.version++
    origin.receipt.updatedAt = this.iso()
    this.update(origin)
  }

  /**
   * 方案 A：接口人理解主人意图后交办。理解由模型完成，以结构化参数提交：intent（execute / memo）、
   * operation（read / write）、restrictions（主人原话里的限制片段）、staff 与任务说明；界面修改另给 ui（功能目录里的功能与依据）。
   * 系统不解读任何一方的文字，只核对授权来源（主人本轮原话）、restrictions 确实摘自原话、功能标识与版本存在于目录。
   * 主人在 SuperHub 交办时亲自选的读写方式、负责人、功能优先于接口人的理解。安全靠执行层：只读工单在工单桌里只能写本工单目录，
   * 写入工单建单后等主人批准，越出沙箱的命令逐条单次审批。同一句原话、同一份任务说明重复提交返回同一张回执。
   */
  fromLiaison(request: LiaisonRequest): Promise<IntakeReceipt> {
    return this.serial(async () => {
      const source = request.source
      if (!source || typeof source.text !== 'string' || !source.text.trim() || typeof source.requestId !== 'string' || !source.requestId
        || typeof source.messageId !== 'string' || !source.messageId) return bad('交办需要主人本轮的原话作为授权来源，未建单', 403)
      if (source.text.length > 40_000) return bad('主人原话超过 40000 字，请分几条说明后再交办')
      const brief = typeof request.brief === 'string' ? request.brief.trim() : ''
      if (!brief || brief.length > 4000) return bad('任务说明须为 1 到 4000 字：写清做什么、范围和交付物，未建单')
      const title = (request.title?.trim() || brief.split('\n')[0]!).replace(/\s+/g, ' ').slice(0, 100)
      const doneWhen = request.doneWhen?.map(row => typeof row === 'string' ? row.trim() : '')
      if (doneWhen && (doneWhen.length > 20 || doneWhen.some(row => !row || row.length > 600))) return bad('完成标准最多 20 条，每条 1 到 600 字，未建单')
      const intent = request.intent ?? 'execute'
      if (intent !== 'execute' && intent !== 'memo') return bad('intent 只能是 execute（交给幕僚去做）或 memo（主人只要求记下，不派工）')
      const memo = intent === 'memo'
      const origin = request.roomId ? undefined : this.originOf(source.requestId)
      const choices = memo ? undefined : origin?.receipt.ownerChoices
      const chosenFeature = choices?.feature
      const feature = memo || !request.ui ? undefined
        : chosenFeature ? selectFeature(chosenFeature.id, chosenFeature.version, '主人在 SuperHub 指定的功能')
        : selectFeature(request.ui.feature?.id, request.ui.feature?.version, request.ui.basis)
      // 主人在 SuperHub 亲自指定了只读：接口人不能再把这句话交给界面师改源码（主人的显式选择优先）。
      if (feature && choices?.operation === 'read') {
        return bad('主人在 SuperHub 交办时指定了只读调查，不能交给界面师修改界面源码，未建单。可用 chief_inbox（operation=read）做只读调查，或请主人另发一条要求修改的原话。', 409)
      }
      const operation = feature ? 'write' : choices?.operation ?? request.operation
      if (!memo && operation !== 'read' && operation !== 'write') {
        return bad('operation 必填：read 表示只读的查询、调研、汇总（直接派工）；write 表示要改文件、执行命令或对外写入（建单后等主人批准）。未建单')
      }
      const restrictions = liaisonRestrictions(request.restrictions, source.text)
      const staff = feature ? choices?.staff ?? 'ui-smith' : memo ? request.staff?.trim() || undefined : choices?.staff ?? (request.staff?.trim() || undefined)
      if (staff && !memo && !feature) this.localStaff(staff, operation === 'write')
      const key = hash(['liaison', request.roomId ?? request.sessionId ?? '', source.requestId, source.messageId, brief, ...request.ui ? ['ui'] : []])
      const fingerprint = hash([source.text, title, request.staff?.trim() || '', doneWhen ?? [], intent, intent === 'execute' ? request.operation : '', restrictions,
        ...request.ui ? [request.ui.feature?.id ?? null, request.ui.feature?.version ?? null, request.ui.basis ?? null] : []])
      const mark = this.state.requests[key]
      if (mark && mark.fingerprint !== fingerprint) {
        return bad(`这份任务说明已按主人这句话登记过（回执 ${mark.receiptId}），但标题、负责人、读写方式、限制或完成标准不同。沿用原登记请用相同参数；另一项工作请写成不同的任务说明。`, 409)
      }
      if (mark) {
        const result = await this.replay(mark.receiptId)
        if (origin) this.linkOrigin(origin.receipt.id, mark.receiptId)
        return result
      }
      if (request.existingOnly) throw Object.assign(new Error('授权来源不在主人本轮之内，未建单'), { status: 409 })

      const at = this.iso()
      const goalIds = origin ? [...origin.receipt.items].reverse().find(item => item.state === 'conversation')?.goalIds ?? [] : []
      const understood = { intent, ...memo ? {} : { operation: operation! }, restrictions, ...staff ? { staff } : {} }
      const chosen = choices && [choices.operation && `${choices.operation === 'write' ? '写入' : '只读'}`, choices.staff && `负责人 ${choices.staff}`, chosenFeature && feature && `功能 ${feature.title}`].filter(Boolean).join('、')
      const reason = memo ? '接口人判断主人只要求记下（intent=memo），未派工'
        : `${feature ? '接口人依据主人原话交给界面师修改界面' : '接口人依据主人原话理解交办'}${chosen ? `；按主人在 SuperHub 的指定：${chosen}` : ''}`
      const receipt: IntakeReceipt = {
        id: randomUUID(), scope: this.scope, version: 1, updatedAt: at, history: [],
        source: { id: randomUUID(), requestId: source.requestId, channel: request.roomId ? 'discussion' : 'native', text: source.text, receivedAt: at,
          ...request.roomId ? { roomId: request.roomId } : {}, messageId: source.messageId },
        items: [{
          id: randomUUID(), title, text: brief, span: { start: 0, end: source.text.length }, restrictions, reason, state: memo ? 'recorded' : 'ready',
          intent: memo ? 'memo' : 'execute', ...memo ? {} : { operation }, ...staff ? { staffHint: staff } : {}, ...feature ? { feature } : {},
          goalIds, goalDisposition: goalIds.length ? 'associated' : 'unassigned',
        }],
        authorization: { by: 'liaison', ownerText: source.text, brief, requestId: source.requestId, messageId: source.messageId, ...understood,
          ...request.sessionId ? { sessionId: request.sessionId } : {}, ...request.roomId ? { roomId: request.roomId } : {},
          ...origin ? { chatReceiptId: origin.receipt.id } : {}, ...choices ? { ownerChoices: choices } : {}, ...feature ? { feature } : {} },
      }
      const entry: Entry = { receipt, commands: [], pending: [], cancelled: [],
        ...memo || feature ? {} : { liaison: { brief, operation: operation!, messageId: source.messageId, ...staff ? { staff } : {}, ...doneWhen ? { doneWhen } : {}, ...request.roomId ? { roomId: request.roomId } : {} } } }
      const item = receipt.items[0]!
      if (item.state === 'ready') {
        try { this.stage(entry, item) }
        catch (error) { item.state = 'failed'; item.reason = (error as Error).message }
      }
      this.update(entry, { key, fingerprint })
      if (origin) this.linkOrigin(origin.receipt.id, receipt.id)
      return this.advance(receipt.id)
    })
  }

  edit(id: string, input: Record<string, unknown>): Promise<IntakeReceipt> {
    return this.serial(async () => {
      this.checkScope(input.scope)
      const request = requestKey(input.requestId)
      const itemId = nonempty(input.itemId, 120, '事项标识')
      const { action, expectedVersion } = input
      if (!['clarify', 'dispatch', 'record', 'associate', 'reassign', 'stop'].includes(String(action))) return bad('事项动作无效')
      if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return bad('请提供事项回执版本')
      const feature = featureRef(input.feature)
      const answer = input.text === undefined ? undefined : nonempty(input.text, 4000, '澄清原话')
      const staff = input.staff === undefined ? undefined : nonempty(input.staff, 60, '幕僚标识')
      const key = hash(['edit', request])
      const goalIds = this.goalIds(input.goalIds)
      const goalDisposition = input.goalDisposition
      const fingerprint = hash([id, itemId, action, expectedVersion, feature, answer, staff, goalIds, goalDisposition])
      const previous = this.record(key, fingerprint)
      if (previous) return this.replay(previous.receipt.id)
      this.checkGoals(goalIds)
      const entry = structuredClone(this.entry(id))
      const item = entry.receipt.items.find(row => row.id === itemId) ?? bad('没有这个事项', 404)
      if (item.intent === 'execute' && this.retiredWork(entry, item)) return bad('这张工单已不可用。', 404)
      if (entry.receipt.version !== expectedVersion) return bad('这条回执已变更，请刷新后重新确认', 409)
      const marks = [{ key, fingerprint }]
      if (action === 'clarify') {
        if (!feature && !answer) return bad('请选择当前功能或补充原话')
        if (item.ticketId || item.state === 'dispatching' || item.intent === 'memo') return bad('请先停止旧交办或提交新的原话', 409)
        if (answer && !this.options.liaison) return bad('当前没有接口人会话，补充的原话暂时无法交给接口人，请稍后重试', 503)
        if (!answer && item.intent !== 'execute') return bad('这一项没有待执行的工作；要做什么请直接告诉接口人', 409)
      }
      this.change(entry, item)
      if (action === 'associate') {
        if (goalDisposition !== undefined && goalDisposition !== 'independent' && goalDisposition !== 'associated' && goalDisposition !== 'unassigned' && goalDisposition !== 'disputed') return bad('目标归属方式无效')
        if (goalDisposition && (goalDisposition === 'associated' || goalDisposition === 'disputed') !== (goalIds.length > 0)) return bad('目标与归属方式不一致')
        item.goalDisposition = goalDisposition ?? (goalIds.length ? 'associated' : 'unassigned')
        item.goalIds = goalIds
      } else if (action === 'clarify' && answer) {
        // 补充的原话交给接口人重新理解（路由在保存后转交），系统不解读它；接口人登记的工作挂在这张回执下。
        item.correction = { text: answer, work: item.text, at: this.iso() }
        item.question = undefined
        item.candidates = undefined
        item.state = 'conversation'
        item.reason = PENDING
        const commands = entry.commands.filter(row => row.itemId === item.id)
        entry.cancelled = [...new Set([...entry.cancelled, ...commands.map(row => row.id)])]
        entry.pending = entry.pending.filter(row => row.dispatch.itemId !== item.id)
        marks.push({ key: this.originKey('owner', request), fingerprint })
      } else if (action === 'clarify') {
        // 主人亲自选定的功能为准；目录里已有新版本时请主人按当前版本确认。
        const current = featureAnchors().find(row => row.id === feature!.id)
        if (!current || current.version !== feature!.version) {
          item.state = 'clarify'
          item.question = '这个功能定位已失效，请确认当前功能与版本。'
          item.candidates = current ? [{ id: current.id, version: current.version, title: current.title, basis: '当前目录版本' }] : undefined
        } else {
          item.feature = { id: current.id, version: current.version, title: current.title, basis: '主人确认的功能版本' }
          item.question = undefined
          item.candidates = undefined
          item.reason = '主人确认了修改对象'
          item.state = 'ready'
          try { this.stage(entry, item, staff) }
          catch (error) { item.state = 'failed'; item.reason = (error as Error).message }
        }
      } else if (action === 'dispatch') {
        const pending = item.state === 'dispatching' && entry.pending.some(row => row.dispatch.itemId === item.id)
        if (!this.hasPermission(item) || (!pending && item.state !== 'ready' && item.state !== 'failed')) return bad('这个事项尚未获授权，或已经交办', 409)
        if (pending && staff) return bad('当前正在核对原工单回执，改派需在工单确认后提出', 409)
        if (!pending) this.stage(entry, item, staff)
      } else {
        if (action === 'reassign' && (!staff || !this.hasPermission(item) || item.state !== 'dispatched' || item.operation === 'write')) return bad('请从已派工的只读事项选择本地幕僚改派', 409)
        if (action === 'stop' && item.state !== 'dispatched' && item.state !== 'dispatching') return bad('这个事项当前没有活跃派工', 409)
        const commands = entry.commands.filter(row => row.itemId === item.id)
        entry.cancelled = [...new Set([...entry.cancelled, ...commands.map(row => row.id)])]
        const bound = item.ticketId ?? this.options.engine.views().find(({ ticket }) => commands.some(command => ticket.superhub?.commandId === command.id)
          && ticket.superhub?.brainScope === this.scope && ticket.superhub?.sourceId === entry.receipt.source.id)?.ticket.id
        entry.pending = entry.pending.filter(row => row.dispatch.itemId !== item.id)
        if (bound) item.stop = { ticketId: bound, state: 'pending', at: this.iso() }
        if (action === 'record') {
          item.intent = 'memo'; item.state = 'recorded'; item.reason = '主人纠正为只记录'; item.question = undefined
        } else if (action === 'stop') {
          item.state = 'stopped'; item.reason = '主人停止了旧授权'
        } else {
          item.priorTicketIds = [...new Set([...(item.priorTicketIds ?? []), ...(bound ? [bound] : [])])]
          item.ticketId = undefined
          this.stage(entry, item, staff, bound)
        }
      }
      this.update(entry, ...marks)
      return this.advance(id)
    })
  }

  get(id: string): IntakeReceipt { return this.present(this.entry(id)) }

  /** 回执详情：原话回执附上接口人依据它登记的回执。 */
  view(id: string): IntakeReceiptView {
    const receipt = this.get(id)
    const linked = (receipt.liaisonReceipts ?? []).flatMap(row => {
      const entry = this.state.entries.find(item => item.receipt.id === row)
      return entry ? [this.present(entry)] : []
    })
    return linked.length ? { ...receipt, linked } : receipt
  }

  receiptIdForSource(id: string): string | undefined { return this.state.entries.find(row => row.receipt.source.id === id)?.receipt.id }

  receipts(): IntakeReceipt[] { return this.state.entries.map(row => this.present(row)) }

  /**
   * 关联到目标的回执。原话回执的目标随原话带到接口人登记的回执上；接口人已登记工作后，原话那一项由登记的事项代表，不重复计入。
   * 返回的回执只含关联到这个目标的事项。
   */
  receiptsForGoal(id: string): IntakeReceipt[] {
    return this.receipts().flatMap(receipt => {
      const items = receipt.items.filter(item => item.goalIds.includes(id) && !(item.state === 'conversation' && receipt.liaisonReceipts?.length))
      return items.length ? [{ ...receipt, items }] : []
    })
  }

  readonly route: Route = async ({ method, seg, url, body, owner }, res) => {
    if (seg[0] !== 'superhub' || (seg[1] !== 'items' && seg[1] !== 'features') || seg.length > 3) return false
    if (!owner) return json(res, 403, { error: '需要主人身份才能访问交办回执' }), true
    const scope = url.searchParams.get('scope')
    if (scope !== null) this.checkScope(scope)
    if (method === 'POST') {
      if (seg[1] !== 'items') return false
      if (seg[2]) {
        const value = await this.edit(seg[2], body)
        const item = value.items.find(row => row.id === body.itemId)
        // 补充的原话交给接口人重新理解；同一请求重试时接口人那边按请求标识去重。
        if (body.action === 'clarify' && typeof body.text === 'string' && item?.correction) {
          await this.deliver(value.id, item.id, `补充交办「${item.title}」：${item.correction.text}`, String(body.requestId), undefined, CLARIFIED)
        }
        json(res, 200, this.view(value.id))
      } else {
        // SuperHub 交办：原话记入回执后交给接口人理解，系统不解读。
        const receipt = await this.submit(body)
        if (receipt.items.every(item => item.state === 'conversation')) await this.deliver(receipt.id, receipt.items[0]!.id, receipt.source.text, receipt.source.requestId)
        json(res, 200, this.view(receipt.id))
      }
    } else if (seg[1] === 'features') {
      if (seg[2]) return false
      json(res, 200, { scope: this.scope, features: featureAnchors() })
    } else if (seg[2]) {
      json(res, 200, this.view(seg[2]))
    } else {
      const cursor = url.searchParams.get('cursor')
      const entries = this.state.entries
      const end = cursor ? entries.findIndex(row => row.receipt.id === cursor) : entries.length
      if (end < 0) return bad('回执游标无效', 409)
      const start = Math.max(0, end - 30)
      const receipts = entries.slice(start, end).reverse().map(row => this.present(row))
      json(res, 200, { scope: this.scope, receipts, ...(start > 0 ? { nextCursor: receipts.at(-1)?.id } : {}) })
    }
    return true
  }
}
