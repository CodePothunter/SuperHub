/** 作战台接口客户端：同源请求，写操作带 x-chief-request 标记（见 src/dsh/http.ts）。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiaisonToolStatus } from '../dsh/liaison.ts'
import type { Custom } from '../core/custom.ts'
import type { IntakeContext } from '../core/superhub-intake.ts'
import { isChatInputAttachment, type ChatInputAttachment } from '../core/chat-attachments.ts'
import { reconcilePending, type PendingMessage } from './chat-state.ts'
import type { WarroomState } from '../dsh/view.ts'
import type { IntakeReceipt } from '../dsh/superhub.ts'
import { pendingIntent } from './request-id.ts'
import { speechCursor } from '../core/paging.ts'
import { appendNewer, emptyPaged, isPageInfo, mergeTail, pageParams, prependOlder, type EdgeState, type Paged, type PageCursor } from './paged-history.ts'

export type { TicketCard, WarroomState } from '../dsh/view.ts'
export type { CommitmentRow, LineRow, MeetingRow, PersonRow, PocState } from '../dsh/poc-view.ts'
export type { Line, Person } from '../core/poc.ts'

/** Respect a mounted DSH base URL; the standalone mobile page sits below chief/m/. */
export function chiefApiBase(base: string) {
  const url = new URL(base)
  if (/\/chief\/m\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/chief\/m\/?$/, '/chief/api')
  else url.pathname = new URL('chief/api', url).pathname
  url.search = ''; url.hash = ''
  return url.href.replace(/\/$/, '')
}
export class ApiError extends Error { constructor(message: string, readonly status: number) { super(message) } }

/** 设置（GET /settings，只在电脑上的 DSH 里能拿到；不含密码哈希）。 */
export interface SettingsView {
  brain?: string
  timeZone: string
  concurrency: number
  notifyUrl?: string
  notify?: string
  /** 接口人用的模型（provider/model），空串表示跟随 DSH 默认。 */
  liaisonModel?: string
  /** 接口人的思考深度（所选模型的档位 id），空串表示模型默认。 */
  liaisonReasoningEffort?: string
  liaisonTools?: LiaisonToolStatus
  dev: boolean
  git: boolean
  mobile: { enabled: boolean; port: number; host: string; hasPassword: boolean; running: boolean; problem?: string; addresses: string[] }
}
export type ReadyState = WarroomState & { custom: Custom; dev: boolean }
export interface SetupState { setup: { suggested: string; git: boolean; problem?: string } }
export type ChiefState = ReadyState | SetupState
export type ChatMode = 'auto' | 'queue' | 'steer'
export const isSetup = (s: ChiefState | undefined): s is SetupState => !!s && 'setup' in s

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response
  try { response = await fetch(`${chiefApiBase(document.baseURI)}${path}`, init) } catch { throw new Error('连接不上主机') }
  const text = await response.text()
  let value: unknown
  let parsed = true
  try { value = text ? JSON.parse(text) : {} } catch { value = {}; parsed = false }
  if (response.ok && !parsed) throw new ApiError('主机未返回 SuperHub 数据，请重新连接到正确的主机', 502)
  if (!response.ok) {
    const error = (value as { error?: unknown }).error
    throw new ApiError(response.status === 401 ? '登录连接已失效，请重新连接 DSH' : typeof error === 'string' ? error : response.status === 404 && !text ? 'SuperHub 没有运行' : `请求失败（${response.status}）`, response.status)
  }
  return value as T
}

export function api<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, body === undefined ? {credentials:'same-origin'} : {
    method:'POST', credentials:'same-origin', headers:{'content-type':'application/json', 'x-chief-request':'1'}, body:JSON.stringify(body),
  })
}

export function uploadChatFile<T>(path: string, file: File, contentType: string, signal: AbortSignal) {
  return request<T>(path, {method:'POST', credentials:'same-origin', headers:{'content-type':contentType, 'x-chief-request':'1'}, body:file, signal})
}

/** 轮询作战台状态：页面可见时每 5 秒一次，操作后立即刷新。 */
export function useWarroom() {
  const [state, setState] = useState<ChiefState>()
  const [error, setError] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const refresh = useCallback(async () => {
    clearTimeout(timer.current)
    try {
      const next = await api<ChiefState>('/state')
      if (!isSetup(next) && !['staff', 'you', 'active', 'queued', 'ended', 'stuck'].every(key => Array.isArray((next as unknown as Record<string, unknown>)?.[key]))) throw new Error('主机未返回完整的 SuperHub 状态，请重新连接')
      setState(next); setError(undefined)
      // 服务端换了新版本（界面修改已部署）：刷新页面拿新界面。每个版本只自动刷新一次，避免来回刷。
      if (!isSetup(next) && typeof __BUILD__ === 'string' && next.build && next.build !== 'dev' && next.build !== __BUILD__ && sessionStorage.getItem('chief-reloaded') !== next.build) {
        sessionStorage.setItem('chief-reloaded', next.build)
        location.reload()
      }
    } catch (e) { setError((e as Error).message) }
    if (document.visibilityState === 'visible') timer.current = setTimeout(() => { void refresh() }, 5000)
  }, [])
  useEffect(() => {
    void refresh()
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearTimeout(timer.current); document.removeEventListener('visibilitychange', onVisible) }
  }, [refresh])
  return { state, error, refresh }
}

/** 执行一个操作并刷新；返回错误文本（成功时为 undefined）。 */
export function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState<string>()
  const run = useCallback(async (key: string, path: string, body: unknown = {}): Promise<string | undefined> => {
    setBusy(key)
    try { await api(path, body); await refresh(); return undefined } catch (e) { return (e as Error).message } finally { setBusy(undefined) }
  }, [refresh])
  return { busy, run }
}

export type { ChatMessage, ChatStep, ChatView, LiveTurn } from '../dsh/chat.ts'
export type { DiscussionResult } from '../dsh/room-results.ts'
import type { ChatMessage, ChatView } from '../dsh/chat.ts'

/**
 * 和接口人的对话：处理中每 1.5 秒看一次，平时 6 秒。
 * 发出的话先乐观显示；接口人处理完（busy 由真变假）时调用 onSettled，让台面跟着刷新。
 * 历史分页：轮询只取最近一页并与已加载的部分合并，`loadOlder` 按游标补更早的一页（见 paged-history.ts）。
 * `following` 说明界面是否停在底部：两次轮询之间新增超过一页时，停在底部就换成最新一页，否则保留阅读位置。
 */
export function useChat(onSettled: () => void, scope?: string, onDenied?: (message: string) => void, following?: () => boolean) {
  const [view, setView] = useState<ChatView>({ messages: [], busy: false, notices: [] })
  const [paged, setPaged] = useState<Paged<ChatMessage>>(emptyPaged)
  const pagedRef = useRef(paged)
  const [edges, setEdges] = useState<{ older: EdgeState; olderError?: string; newer: EdgeState; newerError?: string }>({ older: 'idle', newer: 'idle' })
  const edgeBusy = useRef({ older: false, newer: false })
  /** 整体替换已加载范围时加一，旧范围上发出的翻页结果作废。 */
  const epoch = useRef(0)
  /** 下一次轮询的结果整体替换已加载的范围（回到最新；读到之前照旧显示，不闪空）。 */
  const replaceNext = useRef(false)
  const followRef = useRef(following)
  followRef.current = following
  const updatePaged = (next: Paged<ChatMessage>) => { pagedRef.current = next; setPaged(next) }
  const [tick, setTick] = useState(0)
  const [pending, setPending] = useState<PendingMessage[]>([])
  const pendingRef = useRef<PendingMessage[]>([])
  const [error, setError] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const wasBusy = useRef(false)
  const sequence = useRef(-1)
  const localId = useRef(0)
  const pollId = useRef(0)
  const loaded = useRef(false)
  const session = useRef<string | undefined>(undefined)
  const sendError = useRef<string | undefined>(undefined)
  const sendIds = useRef(new Map<string, string>())
  const mounted = useRef(false)
  const knownScope = useRef(scope)
  knownScope.current = scope
  const updatePending = (next: PendingMessage[]) => { pendingRef.current = next; setPending(next) }
  const read = useCallback(async (cursor?: PageCursor) => {
    const next = await api<ChatView>('/chat?' + new URLSearchParams([...scope ? [['scope', scope]] : [], ...new URLSearchParams(pageParams(cursor))]))
    if (!next || !Array.isArray(next.messages) || !Array.isArray(next.notices) || (scope && !next.sessionId) || (next.page !== undefined && !isPageInfo(next.page))
      || next.messages.some(row => !row || row.inputAttachments !== undefined && !(Array.isArray(row.inputAttachments) && row.inputAttachments.every(isChatInputAttachment)))) {
      throw new Error('主机未返回完整的接口人会话，请重新读取。')
    }
    return next
  }, [scope])
  const poll = useCallback(async () => {
    if (!mounted.current || scope !== knownScope.current) return
    clearTimeout(timer.current)
    const request = ++pollId.current
    let busy = wasBusy.current
    try {
      const next = await read()
      if (request !== pollId.current) return
      if (session.current && next.sessionId && session.current !== next.sessionId) {
        sequence.current = -1
        sendIds.current.clear()
        updatePending([])
        epoch.current++
        updatePaged(emptyPaged())
      }
      session.current = next.sessionId
      loaded.current = true
      sequence.current = next.messages.reduce((seq, m) => Math.max(seq, m.seq), sequence.current)
      const replace = replaceNext.current
      replaceNext.current = false
      const merged = mergeTail(replace ? emptyPaged<ChatMessage>() : pagedRef.current, next.messages, next.page, speechCursor, followRef.current?.() ?? true)
      const first = (items: ChatMessage[]) => items[0] && speechCursor(items[0])
      if (merged.items.length < pagedRef.current.items.length || first(merged.items) !== first(pagedRef.current.items)) epoch.current++
      updatePaged(merged)
      updatePending(reconcilePending(pendingRef.current, merged.items))
      busy = next.busy || pendingRef.current.length > 0
      setView(next); setError(sendError.current)
      if (wasBusy.current && !busy) onSettled()
      wasBusy.current = busy
    } catch (e) {
      if (request !== pollId.current) return
      if (onDenied && e instanceof ApiError && [401, 403, 409].includes(e.status)) {
        onDenied(e.message)
        return
      }
      setError((e as Error).message)
    }
    if (document.visibilityState === 'visible') timer.current = setTimeout(() => { void poll() }, busy ? 1000 : 6000)
  }, [onSettled, scope, onDenied, read])
  /** 往上补更早的一页，或在没接到最新时往下补一页。`beforeApply` 在写入前调用（记下阅读位置）。 */
  const edge = useCallback(async (side: 'older' | 'newer', beforeApply?: () => void) => {
    const state = pagedRef.current
    const item = side === 'older' ? state.items[0] : state.items.at(-1)
    if (!item || edgeBusy.current[side] || !mounted.current || (side === 'older' ? !state.hasOlder : !state.hasNewer)) return
    const round = epoch.current, owner = session.current
    edgeBusy.current[side] = true
    setEdges(previous => ({ ...previous, [side]: 'loading', [side + 'Error']: undefined }))
    let outcome: EdgeState = 'idle', message: string | undefined
    try {
      const cursor = speechCursor(item)
      const next = await read(side === 'older' ? { before: cursor } : { after: cursor })
      if (!mounted.current || round !== epoch.current || next.sessionId !== owner) return
      if (next.page) {
        beforeApply?.()
        const merged = side === 'older' ? prependOlder(pagedRef.current, next.messages, next.page, speechCursor) : appendNewer(pagedRef.current, next.messages, next.page, speechCursor)
        updatePaged(merged)
        updatePending(reconcilePending(pendingRef.current, merged.items))
      }
    } catch (e) {
      if (!mounted.current || round !== epoch.current) return
      if (e instanceof ApiError && e.status === 410) {
        // 边上那条消息已不可用：从最新一页重新开始。
        epoch.current++
        replaceNext.current = true
        void poll()
        return
      }
      if (onDenied && e instanceof ApiError && [401, 403, 409].includes(e.status)) { onDenied(e.message); return }
      outcome = 'error'; message = (e as Error).message
    } finally {
      edgeBusy.current[side] = false
      if (mounted.current) setEdges(previous => ({ ...previous, [side]: outcome, [side + 'Error']: message }))
    }
  }, [read, poll, onDenied])
  const loadOlder = useCallback((beforeApply?: () => void) => edge('older', beforeApply), [edge])
  const loadNewer = useCallback((beforeApply?: () => void) => edge('newer', beforeApply), [edge])
  /** 回到最新一页。 */
  const toLatest = useCallback(async () => {
    epoch.current++
    replaceNext.current = true
    await poll()
  }, [poll])
  useEffect(() => { if (!view.busy && !pending.length) return; const t = setInterval(() => setTick(n => n + 1), 1000); return () => clearInterval(t) }, [view.busy, pending.length])
  useEffect(() => {
    mounted.current = true
    void poll()
    const onVisible = () => { if (document.visibilityState === 'visible') void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { mounted.current = false; ++pollId.current; clearTimeout(timer.current); document.removeEventListener('visibilitychange', onVisible) }
  }, [poll])
  const say = useCallback(async (text: string, mode: ChatMode = 'auto', context?: IntakeContext, inputAttachments: ChatInputAttachment[] = []) => {
    // 第一次发言前先知道历史的序号和目标会话，旧的同文消息不能确认本次发送。
    if (!loaded.current) { await poll(); if (!loaded.current) return false }
    if (!mounted.current || scope !== knownScope.current || (scope && !session.current)) return false
    if (inputAttachments.length && !text.trim()) text = ''
    const payload = { text, mode, sessionId: session.current, ...context ? { context } : {},
      ...(inputAttachments.length && {inputAttachments:inputAttachments.map(row => row.id)}) }
    const intent = scope ? pendingIntent(scope, '/chat', payload, sendIds.current) : undefined
    const message: PendingMessage = { id: ++localId.current, text, time: Date.now(), afterSeq: sequence.current, requestId: intent?.id,
      ...(inputAttachments.length && {inputAttachments}) }
    updatePending([...pendingRef.current, message])
    wasBusy.current = true
    sendError.current = undefined
    try {
      const response = await api<{ receipt?: IntakeReceipt }>('/chat', { ...payload, ...intent ? { scope, request_id: intent.id } : {} })
      // 原话回执只记下原话；接口人理解后登记的工作在 SuperHub 的交办回执里，回复照常出现在对话中。
      const receipt = response?.receipt
      const received = receipt?.source?.inputAttachments ?? []
      if (scope && (receipt?.scope !== scope || receipt.source?.requestId !== intent?.id || receipt.source.text !== text
        || !Array.isArray(received) || received.length !== inputAttachments.length
        || !received.every((row, index) => isChatInputAttachment(row) && row.id === inputAttachments[index]?.id))) {
        throw new Error('接口人回执与这次发言不一致，请重试以核对结果。')
      }
      intent?.settle()
      if (!mounted.current || scope !== knownScope.current) return true
      setError(undefined)
    }
    catch (e) {
      if (e instanceof ApiError && [400, 401, 403, 404, 413].includes(e.status)) intent?.settle()
      if (!mounted.current || scope !== knownScope.current) return false
      if (onDenied && e instanceof ApiError && [401, 403].includes(e.status)) { onDenied(e.message); return false }
      sendError.current = (e as Error).message; setError(sendError.current)
      updatePending(pendingRef.current.filter(p => p.id !== message.id)); void poll(); return false
    }
    void poll(); return true
  }, [poll, scope, onDenied])
  const visiblePending = pending.length ? reconcilePending(pending, paged.items) : pending
  // 往上翻阅（没接到最新）时，还没确认的发言等回到最新时再显示在末尾。
  const messages: ChatMessage[] = [...paged.items, ...paged.hasNewer ? [] : visiblePending.map(p => ({ seq: Number.MAX_SAFE_INTEGER - p.id, role: 'you' as const, text: p.text, time: p.time,
    ...(p.inputAttachments && {inputAttachments:p.inputAttachments}) }))]
  return { sessionId: view.sessionId, messages, confirmedMessages: paged.items, observedAt: view.observedAt, notices: view.notices,
    workReplies: view.workReplies, ...(view.discussionResults && { discussionResults: view.discussionResults }),
    live: view.live, busy: view.busy || pending.length > 0, error, say, refresh: poll, tick,
    hasOlder: paged.hasOlder, hasNewer: paged.hasNewer, loadOlder, loadNewer, toLatest,
    loadingOlder: edges.older === 'loading', olderError: edges.olderError, loadingNewer: edges.newer === 'loading', newerError: edges.newerError }
}
