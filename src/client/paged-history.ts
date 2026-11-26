/**
 * 对话历史分页的客户端状态：先读最近一页，向上按游标补更早的页，轮询只取最新一页并与已加载的部分合并。
 *
 * 两种模式：
 *   live      已加载的一段一直接到最新；轮询得到的最新一页并入末尾。
 *   anchored  （深链接到较早的消息，或两次轮询之间新增了超过一页）已加载的一段没有接到最新：`hasNewer` 为真，
 *             轮询不并入，向下按 `after` 逐页补齐；补到与最新一页重叠时回到 live。
 * 游标就是消息自己的稳定 id，见 core/paging.ts。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PageInfo } from '../core/paging.ts'

export const PAGE_SIZE = 40

export interface Paged<T> {
  items: T[]
  /** 已加载的最早一条之前还有消息。 */
  hasOlder: boolean
  /** 已加载的最新一条之后还有消息（anchored 模式）。 */
  hasNewer: boolean
}
export const emptyPaged = <T>(): Paged<T> => ({ items: [], hasOlder: false, hasNewer: false })

export type PageCursor = { before: string } | { after: string } | { around: string } | Record<string, never>
/** 分页查询串（不含 `?`）。 */
export function pageParams(cursor: PageCursor = {}, limit = PAGE_SIZE, traceId?: string): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (traceId) params.set('trace', traceId)
  for (const [key, value] of Object.entries(cursor)) params.set(key, value)
  return params.toString()
}

export const isPageInfo = (value: unknown): value is PageInfo =>
  !!value && typeof value === 'object' && typeof (value as PageInfo).older === 'boolean' && typeof (value as PageInfo).newer === 'boolean'

/**
 * 并入轮询得到的最新一页。和已加载的部分有重叠：重叠处以后以新数据为准，之前已加载的旧页保留。
 * 没有重叠：整段历史就在这一页里，或者停在底部（`follow`）时换成最新一页；正在往上翻时保留已加载的部分，标记还有更新的消息。
 * 服务端没有分页（旧主机）时整体替换。
 */
export function mergeTail<T>(state: Paged<T>, tail: readonly T[], page: PageInfo | undefined, id: (item: T) => string, follow: boolean): Paged<T> {
  if (!page) return { items: [...tail], hasOlder: false, hasNewer: false }
  if (!state.items.length) return { items: [...tail], hasOlder: page.older, hasNewer: false }
  const fresh = new Set(tail.map(id))
  const at = state.items.findIndex(item => fresh.has(id(item)))
  if (at < 0) {
    if (!page.older || !tail.length || (follow && !state.hasNewer)) return { items: [...tail], hasOlder: page.older, hasNewer: false }
    return { ...state, hasNewer: true }
  }
  return {
    items: [...state.items.slice(0, at).filter(item => !fresh.has(id(item))), ...tail],
    hasOlder: at === 0 ? page.older : state.hasOlder,
    hasNewer: false,
  }
}

/** 前插更早的一页（`before` 的结果）。 */
export function prependOlder<T>(state: Paged<T>, older: readonly T[], page: PageInfo, id: (item: T) => string): Paged<T> {
  const known = new Set(state.items.map(id))
  return { ...state, items: [...older.filter(item => !known.has(id(item))), ...state.items], hasOlder: page.older }
}

/** 追加更新的一页（`after` 的结果）；补到最新时回到 live。 */
export function appendNewer<T>(state: Paged<T>, newer: readonly T[], page: PageInfo, id: (item: T) => string): Paged<T> {
  const known = new Set(state.items.map(id))
  return { ...state, items: [...state.items, ...newer.filter(item => !known.has(id(item)))], hasNewer: page.newer }
}

/** 以某条消息为中心的一页（`around` 的结果）替换已加载的部分。 */
export const anchoredPage = <T>(items: readonly T[], page: PageInfo): Paged<T> => ({ items: [...items], hasOlder: page.older, hasNewer: page.newer })

export type EdgeState = 'idle' | 'loading' | 'error'
export interface PagedView<T> { messages: T[]; page?: PageInfo; traceId?: string }

interface Options<V extends PagedView<T>, T> {
  /** 换了对象（会话、第二大脑）时清空重读；undefined 时不读。 */
  key: string | undefined
  /** 按查询串读一页；抛错由 `failed` 决定怎么处理。 */
  read: (query: string) => Promise<V>
  id: (item: T) => string
  interval?: number
  /** 深链接：这条消息不在已加载范围时，以它为中心读一页。 */
  anchor?: string
  /** 现在是否停在底部（决定两次轮询之间新增超过一页时跳到最新还是保留）。 */
  following?: () => boolean
  /** 合并多次响应里的附带数据（例如头像只随这一页返回）。 */
  combine?: (previous: V | undefined, next: V) => V
  /** 读取失败时：`stop` 已由调用方处理（例如失去权限），`clear` 丢掉已读数据，`keep` 保留上次的数据并显示错误。 */
  failed?: (error: unknown) => 'stop' | 'clear' | 'keep'
  /** 错误的可读文字。 */
  message?: (error: unknown) => string
}

interface Snapshot<V, T> { key?: string; view?: V; paged: Paged<T>; error?: string; older: EdgeState; olderError?: string; newer: EdgeState; newerError?: string; jumping?: string; missing?: string }

const goneStatus = (error: unknown) => (error as { status?: unknown } | null)?.status === 410

/**
 * 分页读取一段对话：首屏最近一页（或深链接处的一页），`loadOlder` / `loadNewer` 往两头补，轮询只取最新一页。
 * `beforeApply` 在新的一页写入状态之前调用（用于记下当前第一条可见消息，提交后恢复位置）。
 */
export function usePagedHistory<V extends PagedView<T>, T>(options: Options<V, T>) {
  const { key, interval, anchor } = options
  const latest = useRef(options)
  latest.current = options
  const [snapshot, setSnapshot] = useState<Snapshot<V, T>>({ paged: emptyPaged<T>(), older: 'idle', newer: 'idle' })
  const state = useRef(snapshot)
  const liveKey = useRef(key)
  /** 每次整体替换已加载范围（跳到某处、跳到最新、换对象）加一；旧范围上发出的翻页结果作废。 */
  const epoch = useRef(0)
  const pollSeq = useRef(0)
  /** 下一次轮询的结果整体替换已加载的范围（回到最新）。 */
  const replaceNext = useRef(false)
  const applied = useRef(0)
  const update = useCallback((change: (previous: Snapshot<V, T>) => Snapshot<V, T>) => {
    state.current = change(state.current)
    setSnapshot(state.current)
  }, [])
  const current = useCallback((check: string | undefined, round: number) => check === liveKey.current && round === epoch.current, [])
  useLayoutEffect(() => {
    liveKey.current = key
    epoch.current++
    pollSeq.current++
    applied.current = pollSeq.current
    replaceNext.current = false
    state.current = { key, paged: emptyPaged<T>(), older: 'idle', newer: 'idle' }
    setSnapshot(state.current)
    return () => { liveKey.current = undefined; epoch.current++ }
  }, [key])

  const combine = (previous: V | undefined, next: V) => latest.current.combine ? latest.current.combine(previous, next) : next
  const fail = (error: unknown): 'stop' | 'clear' | 'keep' => latest.current.failed?.(error) ?? 'keep'
  const text = (error: unknown) => latest.current.message?.(error) ?? (error instanceof Error ? error.message : '读取对话时出现问题')

  /** 以 `target` 为中心读一页（不在已加载范围时）。 */
  const jumpTo = useCallback(async (target: string) => {
    const check = liveKey.current
    if (!check) return
    // A source URL resolves its trace on first read. Once a view is loaded,
    // quotes and cursors locate messages within that view.
    const traceId = state.current.view?.traceId
    const round = ++epoch.current
    update(previous => ({ ...previous, jumping: target, missing: undefined, older: 'idle', newer: 'idle', olderError: undefined, newerError: undefined }))
    try {
      const next = await latest.current.read(pageParams({ around: target }, PAGE_SIZE, traceId))
      if (!current(check, round)) return
      update(previous => ({ ...previous, key: check, view: combine(previous.view?.traceId === next.traceId ? previous.view : undefined, next), error: undefined, jumping: undefined,
        paged: next.page ? anchoredPage(next.messages, next.page) : mergeTail(previous.paged, next.messages, undefined, latest.current.id, true) }))
    } catch (error) {
      if (!current(check, round)) return
      if (goneStatus(error)) {
        // 这条消息已不可用：回到最新一页，页面照常说明原话当前不可读。
        update(previous => ({ ...previous, jumping: undefined, missing: target }))
        void toLatest()
        return
      }
      const how = fail(error)
      if (how === 'stop') return
      update(previous => ({ ...previous, jumping: undefined, error: text(error), ...(how === 'clear' && { view: undefined, paged: emptyPaged<T>() }) }))
    }
  }, [update, current])

  /** 读最新一页并并入。 */
  const refresh = useCallback(async () => {
    const check = liveKey.current
    if (!check) return
    const target = latest.current.anchor
    const have = state.current.key === check && (state.current.view || state.current.paged.items.length)
    // 第一次读到带深链接的会话：直接读那条消息所在的一页（之后的轮询仍取最新一页来更新状态）。
    if (!have && target && state.current.missing !== target && !state.current.jumping) return jumpTo(target)
    if (state.current.jumping) return
    const seq = ++pollSeq.current, round = epoch.current
    try {
      const next = await latest.current.read(pageParams())
      if (!current(check, round) || seq < applied.current) return
      applied.current = seq
      const follow = latest.current.following?.() ?? true
      const changedTrace = !!state.current.view && state.current.view.traceId !== next.traceId
      const replace = replaceNext.current || changedTrace
      replaceNext.current = false
      if (changedTrace) epoch.current++
      update(previous => ({ ...previous, key: check, view: combine(changedTrace ? undefined : previous.view, next), error: undefined,
        ...(changedTrace && {older: 'idle', newer: 'idle', olderError: undefined, newerError: undefined, missing: undefined}),
        paged: mergeTail(replace ? emptyPaged<T>() : previous.paged, next.messages, next.page, latest.current.id, follow) }))
    } catch (error) {
      if (!current(check, round) || seq < applied.current) return
      const how = fail(error)
      if (how === 'stop') return
      if (how === 'clear') epoch.current++
      update(previous => ({ ...previous, error: text(error), ...(how === 'clear' && { view: undefined, paged: emptyPaged<T>() }) }))
    }
  }, [update, jumpTo, current])

  const edge = useCallback(async (side: 'older' | 'newer', beforeApply?: () => void) => {
    const check = liveKey.current, round = epoch.current
    const { paged } = state.current
    const edgeItem = side === 'older' ? paged.items[0] : paged.items.at(-1)
    if (!check || !edgeItem || state.current[side] === 'loading' || state.current.jumping || (side === 'older' ? !paged.hasOlder : !paged.hasNewer)) return
    update(previous => ({ ...previous, [side]: 'loading', [side + 'Error']: undefined }))
    const cursor = latest.current.id(edgeItem)
    try {
      const traceId = state.current.view?.traceId
      const next = await latest.current.read(pageParams(side === 'older' ? { before: cursor } : { after: cursor }, PAGE_SIZE, traceId))
      if (!current(check, round)) return
      if (state.current.view?.traceId !== next.traceId) { void toLatest(); return }
      beforeApply?.()
      update(previous => ({ ...previous, view: combine(previous.view, next), [side]: 'idle',
        paged: !next.page ? previous.paged : side === 'older' ? prependOlder(previous.paged, next.messages, next.page, latest.current.id)
          : appendNewer(previous.paged, next.messages, next.page, latest.current.id) }))
    } catch (error) {
      if (!current(check, round)) return
      if (goneStatus(error)) {
        // 已加载的边上那条消息不在了：从最新一页重新开始。
        void toLatest()
        return
      }
      if (fail(error) === 'stop') return
      update(previous => ({ ...previous, [side]: 'error', [side + 'Error']: text(error) }))
    }
  }, [update, current, refresh])
  const loadOlder = useCallback((beforeApply?: () => void) => edge('older', beforeApply), [edge])
  const loadNewer = useCallback((beforeApply?: () => void) => edge('newer', beforeApply), [edge])

  /** 回到最新一页：下一次读到的最新一页替换已加载的范围（读到之前照旧显示，不闪空）。 */
  const toLatest = useCallback(async () => {
    epoch.current++
    replaceNext.current = true
    update(previous => ({ ...previous, older: 'idle', newer: 'idle', jumping: undefined }))
    await refresh()
  }, [update, refresh])

  useEffect(() => {
    if (!key) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll(first = false) {
      if (first || document.visibilityState === 'visible') await refresh()
      if (!stopped && interval) timer = setTimeout(poll, interval)
    }
    void poll(true)
    return () => { stopped = true; clearTimeout(timer) }
  }, [key, refresh, interval])

  // 深链接换到一条还没加载的消息。
  useEffect(() => {
    if (!anchor || !key || state.current.key !== key) return
    const { paged, jumping } = state.current
    if (jumping === anchor || paged.items.some(item => latest.current.id(item) === anchor)) return
    if (!paged.items.length && !state.current.view) return
    void jumpTo(anchor)
  }, [anchor, key, jumpTo])

  const own = snapshot.key === key
  return {
    view: own ? snapshot.view : undefined,
    messages: own ? snapshot.paged.items : [],
    hasOlder: own && snapshot.paged.hasOlder,
    hasNewer: own && snapshot.paged.hasNewer,
    older: own ? snapshot.older : 'idle' as EdgeState,
    olderError: own ? snapshot.olderError : undefined,
    newer: own ? snapshot.newer : 'idle' as EdgeState,
    newerError: own ? snapshot.newerError : undefined,
    error: own ? snapshot.error : undefined,
    /** 正在读取深链接处的一页。 */
    jumping: own ? snapshot.jumping : undefined,
    refresh, loadOlder, loadNewer, toLatest, jumpTo,
  }
}
