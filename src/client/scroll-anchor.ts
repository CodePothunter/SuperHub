/**
 * 对话往上加载更早的消息时保持阅读位置：插入前记下第一条可见消息和它离滚动容器顶部的距离，
 * 提交后把同一条消息放回原处。不依赖浏览器的 `overflow-anchor`（Safari 不支持）。
 * 顶部 / 底部哨兵进入视口前（预留约一屏）触发加载。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

export const MESSAGE_ROW = '[data-message-id]'
/** 哨兵提前触发的距离（约一屏）。 */
export const EDGE_MARGIN = 600

export interface ScrollAnchor { id: string; offset: number }
export interface RowBox { id: string; top: number; bottom: number }

/** 第一条（部分）可见的消息：底边在视口顶部之下的第一行。 */
export function firstVisible(rows: readonly RowBox[], viewTop: number): ScrollAnchor | undefined {
  const row = rows.find(box => box.bottom > viewTop)
  return row && { id: row.id, offset: row.top - viewTop }
}

/** 恢复时还要滚动的距离：锚点现在离顶部的距离减去记下的距离。 */
export const anchorShift = (anchor: ScrollAnchor, top: number, viewTop: number) => (top - viewTop) - anchor.offset

/** 最近的可纵向滚动的祖先（含自身）；没有时为 null（整页滚动）。 */
export function scrollParent(node: Element | null): HTMLElement | null {
  for (let el = node instanceof HTMLElement ? node : null; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return el
  }
  return null
}

const viewTopOf = (container: HTMLElement | null) => container ? container.getBoundingClientRect().top : 0
const rowsOf = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>(MESSAGE_ROW))

export function captureAnchor(container: HTMLElement | null, rows: ParentNode): ScrollAnchor | undefined {
  const viewTop = viewTopOf(container)
  return firstVisible(rowsOf(rows).map(row => { const box = row.getBoundingClientRect(); return { id: row.dataset.messageId!, top: box.top, bottom: box.bottom } }), viewTop)
}

/** 把锚点消息放回原处；返回滚动的距离（找不到锚点时为 0）。 */
export function restoreAnchor(container: HTMLElement | null, rows: ParentNode, anchor: ScrollAnchor): number {
  const row = rowsOf(rows).find(el => el.dataset.messageId === anchor.id)
  if (!row) return 0
  const shift = anchorShift(anchor, row.getBoundingClientRect().top, viewTopOf(container))
  if (!shift) return 0
  if (container) container.scrollTop += shift
  else window.scrollBy(0, shift)
  return shift
}

/**
 * 前插时保持位置：`capture()` 在新的一页写入状态前调用；`firstId`（已加载的第一条）变化后的那次提交里恢复。
 */
export function usePrependAnchor(container: () => HTMLElement | null, rows: RefObject<HTMLElement | null>, firstId: string | undefined) {
  const pending = useRef<ScrollAnchor | undefined>(undefined)
  const capture = useCallback(() => {
    pending.current = rows.current ? captureAnchor(container(), rows.current) : undefined
  }, [container, rows])
  useLayoutEffect(() => {
    const anchor = pending.current
    pending.current = undefined
    if (anchor && rows.current) restoreAnchor(container(), rows.current, anchor)
  }, [firstId, container, rows])
  return capture
}

/**
 * 哨兵进入滚动容器（向 `side` 一侧预留 EDGE_MARGIN）时调用 `enter`。`revision` 变化（加载完一页）时重新观察：
 * 重新观察会立即报告当前是否仍在范围内，短的页面会接着加载，直到填满或到头。
 */
export function useEdgeSentinel(sentinel: RefObject<Element | null>, root: () => Element | null, side: 'top' | 'bottom', active: boolean, enter: () => void, revision: unknown) {
  const latest = useRef(enter)
  latest.current = enter
  useEffect(() => {
    const node = sentinel.current
    if (!active || !node || typeof IntersectionObserver === 'undefined') return
    const margin = side === 'top' ? EDGE_MARGIN + 'px 0px 0px 0px' : '0px 0px ' + EDGE_MARGIN + 'px 0px'
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) latest.current()
    }, { root: root(), rootMargin: margin })
    observer.observe(node)
    return () => observer.disconnect()
  }, [sentinel, root, side, active, revision])
}
