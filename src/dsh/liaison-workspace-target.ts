import type { IntakeContext } from '../core/superhub-intake.ts'
import { workspaceArchived, type V2Workspace } from '../core/workspace-v2.ts'
import type { SessionEventLike } from './ports.ts'
import { nativeAttachmentOnlyTurn, nativeIntakeSource } from './superhub.ts'
import type { WorkspaceV2Store } from './workspace-v2-store.ts'

export type WorkspaceOwnerSource = NonNullable<ReturnType<typeof nativeIntakeSource>>
type Args = Record<string, unknown>

const RECEIPT_META = 'dsh-chief/workspace'
const CHOICES_META = 'dsh-chief/workspace-choices'
const ORIGIN_META = 'dsh-chief/workspace-origin'

export const workspaceTargetProperties = {
  workspace_id: { type: 'string', maxLength: 160, description: '同脑工具返回的工作区 ID。提交写操作时，同时使用主人原话中的目标线索、当前选区或一条可核对的上轮回执。' },
  target_quote: { type: 'string', maxLength: 240, description: '主人原话中逐字摘录的项目名、目标、负责人或已有回执的指代短语。用一段能区分候选的线索。' },
  target_source: { type: 'string', enum: ['current', 'previous', 'receipt', 'page'], description: '核对目标线索的位置。默认 current。previous 用紧邻上条主人原话，receipt 用上一轮工具回执并摘录本轮指代，page 用主人本轮实际打开的位置。' },
  target_choice: { type: 'integer', minimum: 1, description: '主人按次序选择项目时，使用工具上一轮展示的候选序号，并在 target_quote 摘录本轮的选择原话。' },
} as const

const wording = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
const normalized = (text: string) => text.normalize('NFC')
const folded = (text: string) => normalized(text).toLowerCase()
export const workspaceQuoted = (source: WorkspaceOwnerSource, quote: string) => normalized(source.text).includes(normalized(quote))
export const workspaceOwnerEvidence = ({requestId, messageId, text}: WorkspaceOwnerSource) => ({requestId, messageId, text})
const sameName = (left: string, right: string) => normalized(left) === normalized(right)

export function workspaceMatches(spaces: readonly V2Workspace[], query: string, namesOnly = false) {
  const exact = spaces.filter(space => space.id === query || sameName(space.name, query))
  if (namesOnly || exact.length) return exact
  const filter = folded(query)
  return spaces.filter(space => [space.name, space.owner, space.goal].some(value => folded(value).includes(filter)))
}

export const workspaceListRow = ({ id, name, goal, owner, projectDirectory, archivedAt }: V2Workspace) =>
  ({ id, name, goal, owner, ...(projectDirectory && {projectDirectory}), ...(archivedAt && {archived: true as const}) })

interface WorkspaceActionReceipt { id: string; sessionId?: string; traceId?: string }
interface WorkspaceChoices { ids: string[]; originalRequestId: string }
interface WorkspaceActionOrigin { originalRequestId: string; actionRequestId: string }

function resultMetadata(events: readonly SessionEventLike[]) {
  const calls = new Set<string>()
  const receipts: WorkspaceActionReceipt[] = []
  let origin: WorkspaceActionOrigin & {workspaceId: string} | undefined
  let choices: WorkspaceChoices | undefined
  for (const event of events) {
    if (event.type === 'tool/call') {
      const call = event.data as { name?: string; callId?: string } | undefined
      if (call?.callId && (call.name === 'chief_workspace' || call.name === 'chief_staff')) calls.add(call.callId)
    }
    if (event.type !== 'tool/result') continue
    const result = event.data as { message?: { toolCallId?: string; isError?: boolean }; meta?: Record<string, unknown> } | undefined
    const callId = result?.message?.toolCallId
    if (!callId || !calls.has(callId) || result?.message?.isError) continue
    const action = result?.meta?.[RECEIPT_META] as Partial<WorkspaceActionReceipt & {sessionTraceId: string}> | undefined
    if (typeof action?.id === 'string') {
      receipts.push({ id: action.id, ...(typeof action.sessionId === 'string' && {sessionId: action.sessionId}),
        ...(typeof action.sessionTraceId === 'string' && {traceId: action.sessionTraceId}) })
      const recorded = result?.meta?.[ORIGIN_META] as Partial<WorkspaceActionOrigin> | undefined
      if (typeof recorded?.originalRequestId === 'string' && typeof recorded.actionRequestId === 'string') {
        origin = {originalRequestId: recorded.originalRequestId, actionRequestId: recorded.actionRequestId, workspaceId: action.id}
      }
    }
    const candidate = result?.meta?.[CHOICES_META] as Partial<WorkspaceChoices> | undefined
    if (typeof candidate?.originalRequestId === 'string' && Array.isArray(candidate.ids)
      && candidate.ids.length > 1 && candidate.ids.every(id => typeof id === 'string')) {
      choices = { ids: candidate.ids, originalRequestId: candidate.originalRequestId }
    }
  }
  return { receipts, choices, origin }
}

function ownerInputs(event: SessionEventLike): (WorkspaceOwnerSource | null)[] {
  const textOrAttachment = (single: SessionEventLike) => {
    const source = nativeIntakeSource([single])
    return source ? [source] : nativeAttachmentOnlyTurn([single]) ? [null] : []
  }
  if (event.type !== 'agent/inbox/spliced') return textOrAttachment(event)
  const data = event.data as {target?: string; inserted?: unknown} | undefined
  if (!data || data.target === 'next-turn' || !Array.isArray(data.inserted)) return []
  // A single native splice can contain multiple individual owner messages. Keep their order and original fallback IDs.
  return data.inserted.flatMap((value: unknown, index: number) => {
    if (!value || typeof value !== 'object') return []
    const input = value as {id?: unknown}
    const id = typeof input.id === 'string' ? input.id : `${event.seq}:${index}`
    return textOrAttachment({...event, data: {target: data.target, inserted: [{...input, id}]}})
  })
}

/** Prefixes can contribute target evidence. The current owner source always comes from the active native segment. */
export function workspaceTargetHistory(events: readonly SessionEventLike[], source: WorkspaceOwnerSource,
  previousSegments: readonly SessionEventLike[] = []) {
  const current = events.findLastIndex(event => nativeIntakeSource([event])?.requestId === source.requestId)
  if (current < 0) return {previous: undefined, receipts: [], choices: undefined, pending: undefined, origin: undefined,
    actionRequestId: undefined, originWorkspaceId: undefined}
  const before = [...previousSegments, ...events.slice(0, current)]
  const earlier: WorkspaceOwnerSource[] = []
  const stash = (inputs: (WorkspaceOwnerSource | null)[]) => {
    for (const input of inputs.reverse()) {
      if (!input) return false
      if (input.requestId !== source.requestId) earlier.push(input)
    }
    return true
  }
  const inCurrent = ownerInputs(events[current]!)
  const currentInput = inCurrent.findLastIndex(input => input?.requestId === source.requestId)
  let scanning = stash(currentInput < 0 ? [] : inCurrent.slice(0, currentInput))
  let previousAt = earlier.length ? before.length : undefined
  for (let index = before.length - 1; scanning && index >= 0; index--) {
    scanning = stash(ownerInputs(before[index]!))
    if (earlier.length) previousAt ??= index
  }
  const { receipts, choices, origin } = resultMetadata(previousAt === undefined ? [] : before.slice(previousAt + 1))
  const actionIsCurrentHistory = origin && earlier.some(prior => prior.requestId === origin.actionRequestId)
  return {
    previous: earlier[0], receipts, choices,
    pending: choices && earlier.find(prior => prior.requestId === choices.originalRequestId),
    origin: actionIsCurrentHistory ? earlier.find(prior => prior.requestId === origin.originalRequestId) : undefined,
    actionRequestId: actionIsCurrentHistory ? origin.actionRequestId : undefined,
    originWorkspaceId: actionIsCurrentHistory ? origin.workspaceId : undefined,
  }
}

type WorkspaceHistory = ReturnType<typeof workspaceTargetHistory>

/** The prompt can present choices, and the next native receipt can verify the IDs the host returned. */
export class WorkspaceTargetChoices extends Error {
  constructor(private readonly matches: V2Workspace[], private readonly originalRequestId: string) {
    super('找到多个可能的工作区。请把候选名称和区别告诉主人，按目标、负责人或候选序号选择后继续。')
  }

  result() {
    return {
      candidates: this.matches.map((space, i) => ({
        number: i + 1, id: space.id, name: space.name, goal: space.goal.slice(0, 240), owner: space.owner,
        ...(workspaceArchived(space) && {archived: true}),
      })),
      workspaceChoices: { ids: this.matches.map(space => space.id), originalRequestId: this.originalRequestId },
      message: this.message,
    }
  }
}

export function workspaceSourceMeta(value: unknown) {
  const { workspaceChoices, workspaceActionOrigin } = value as {workspaceChoices?: WorkspaceChoices; workspaceActionOrigin?: WorkspaceActionOrigin}
  return {...workspaceChoices && {[CHOICES_META]: workspaceChoices},
    ...workspaceActionOrigin && {[ORIGIN_META]: workspaceActionOrigin}}
}

export function workspaceRequestSource(args: Args, source: WorkspaceOwnerSource, history: WorkspaceHistory) {
  if (args.request_source === undefined || args.request_source === 'current') return source
  const original = args.request_source === 'previous' ? history.previous : args.request_source === 'pending' ? history.pending
    : args.request_source === 'receipt' ? history.origin : undefined
  if (!original) throw new Error('找不到这项请求对应的有效主人原话。请核对要继续的事。')
  return original
}

export const hasWorkspaceTarget = (args: Args) =>
  ['workspace_id', 'name', 'target_quote', 'target_source', 'target_choice'].some(key => args[key] !== undefined && args[key] !== '')

export function workspaceTarget(store: WorkspaceV2Store, args: Args, turn: {
  source: WorkspaceOwnerSource
  original?: WorkspaceOwnerSource
  history: WorkspaceHistory
  context?: IntakeContext
  previousContext?: IntakeContext
  /** Legacy set_directory and chief_staff allowed the preceding owner message to name the workspace. */
  priorName?: boolean
}, required: boolean): V2Workspace | undefined {
  const { source, original = source, history, context, previousContext, priorName } = turn
  const name = wording(args.name)
  const quote = wording(args.target_quote)
  const id = wording(args.workspace_id)
  const mode = args.target_source
  const spaces = store.list()
  const selected = (origin?: IntakeContext) => origin?.surface === 'workspace' ? origin.selectedId : undefined
  const shown = selected(context)
  const finish = (matches: V2Workspace[], missing: string) => {
    if (matches.length > 1) throw new WorkspaceTargetChoices(matches, original.requestId)
    const match = matches[0]
    if (!match) throw new Error(missing)
    if (id && id !== match.id || name && !sameName(match.name, name)) {
      throw new Error('工作区标识和主人提供的线索指向不同目标，请重新核对。')
    }
    return match
  }
  const byId = (target: string | undefined, missing: string) => finish(spaces.filter(space => space.id === target), missing)

  if (args.target_choice !== undefined) {
    const number = args.target_choice
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || !quote || !workspaceQuoted(source, quote)) {
      throw new Error('请照录主人本轮的选择并使用上次列出的候选序号。')
    }
    return byId(history.choices?.ids[number - 1], '这个候选已不可用，请重新查找工作区。')
  }
  if (mode === 'receipt') {
    if (!quote || !workspaceQuoted(source, quote)) throw new Error('请照录主人本轮指代上一次结果的原话。')
    const received = new Set(history.receipts.map(receipt => receipt.id))
    const byReceipt = spaces.filter(space => received.has(space.id))
    const pointed = workspaceMatches(spaces, quote, true)
    const byQuote = pointed.length ? byReceipt.filter(space => pointed.some(target => target.id === space.id)) : byReceipt
    const named = name && workspaceQuoted(source, name) ? byQuote.filter(space => sameName(space.name, name)) : byQuote
    if ((pointed.length || name) && byReceipt.length && !named.length) {
      throw new Error('本轮原话和上次回执指向不同目标，请按主人这次指定的工作区查找。')
    }
    return finish(named, '上一次结果里没有可核对的工作区，请用 list 查找。')
  }
  if (mode === 'page') {
    if (name || quote) throw new Error('请使用当前选区，或按主人点名的目标重新查找。')
    return byId(shown, '主人本轮打开的工作区已不可用，请按名称查找。')
  }
  if (mode !== undefined && mode !== 'current' && mode !== 'previous') throw new Error('请选择可核对的工作区来源。')

  const previous = original !== source ? original : history.previous
  const clue = quote ?? name ?? id
  if (!clue && mode === 'previous') {
    return byId(selected(previousContext), '上轮没有工作区选区，请按上轮主人原话中的目标查找。')
  }
  if (!clue && original !== source) {
    const prior = args.request_source === 'receipt' ? history.originWorkspaceId : args.request_source === 'pending' ? undefined : selected(previousContext)
    return byId(prior, '这项上轮请求没有可沿用的工作区选区，请按原请求或本轮指明的目标查找。')
  }
  if (!clue && shown) return byId(shown, '主人本轮打开的工作区已不可用，请重新打开后操作。')
  if (!clue) {
    if (required || mode !== undefined) throw new Error('请先查找主人要操作的工作区，再按可核对的目标继续。')
    return
  }
  if (id === shown && !name && !quote && mode !== 'previous' && original === source) return byId(shown, '主人本轮打开的工作区已不可用。')

  const basis = mode === 'previous' ? previous : source
  const legacyPrevious = !mode && name && !quote && (priorName || original !== source) && previous
  if ((!basis || !workspaceQuoted(basis, clue)) && (!legacyPrevious || !workspaceQuoted(legacyPrevious, clue))) {
    throw new Error('主人原话里没有工作区「' + clue + '」，请按主人原话给出的线索或实际选区查找。')
  }
  const narrowed = mode !== 'previous' && history.choices && !name && quote
    ? spaces.filter(space => history.choices!.ids.includes(space.id)) : undefined
  let matches = workspaceMatches(spaces, clue, !!name && !quote)
  if (narrowed && !workspaceMatches(spaces, clue, true).length) {
    const withinChoices = workspaceMatches(narrowed, clue)
    if (withinChoices.length) matches = withinChoices
  }
  if (name && quote && name !== quote) matches = matches.filter(space => sameName(space.name, name))
  return finish(matches, '没有名为「' + clue + '」的工作区或符合该线索的结果，请用 list 核对。')
}

export function workspaceSessionTarget(store: WorkspaceV2Store, args: Args, workspaceId: string, turn: {
  source: WorkspaceOwnerSource
  original: WorkspaceOwnerSource
  history: WorkspaceHistory
  shownSessionId?: string
}) {
  const { source, original, history, shownSessionId } = turn
  const id = wording(args.session_id)
  const quote = wording(args.session_quote)
  const all = store.view(workspaceId).sessions
  if (!quote && shownSessionId && (!id || id === shownSessionId)) return store.session(workspaceId, shownSessionId)
  const clue = quote ?? id
  if (!clue || (!workspaceQuoted(source, clue) && !workspaceQuoted(original, clue))) {
    throw new Error('请从主人点名的会话或当前打开的会话选择，用 list_sessions 核对标题。')
  }
  let matches = all.filter(session => session.id === clue || sameName(session.title, clue))
  if (!matches.length) matches = all.filter(session => folded(session.title).includes(folded(clue)))
  if (!matches.length && args.target_source === 'receipt' && workspaceQuoted(source, clue)) {
    const received = new Set(history.receipts.filter(receipt => receipt.id === workspaceId).map(receipt => receipt.sessionId))
    matches = all.filter(session => received.has(session.id))
  }
  if (matches.length !== 1 || id && matches[0]!.id !== id) {
    throw new Error(matches.length > 1 ? '本区有多场匹配的会话，请按标题或 ID 向主人确认。' : '找不到主人指明的会话，请用 list_sessions 核对。')
  }
  return matches[0]!
}
