/**
 * 「一句话交办」的未读红点：主人上次看过接口人对话之后，接口人的新回复和新提醒（服务端已读点，网页与手机同步）。
 */
import { useCallback, useContext, useEffect, useRef } from 'react'
import { unreadBadge } from '../core/liaison-unread.ts'
import { api } from './api.ts'
import type { Scoped } from './superhub-api.ts'
import { scopedResource, useV2Read, V2Client } from './workspace-v2-api.ts'

export interface LiaisonUnreadView extends Scoped { unread: number; latestAt?: string }
export const LIAISON_UNREAD_POLL_MS = 6000
const isUnread = (value: Scoped): value is LiaisonUnreadView => {
  const unread = (value as { unread?: unknown }).unread
  return typeof unread === 'number' && Number.isSafeInteger(unread) && unread >= 0
}

const TITLE_PREFIX = /^\(\d+\+?\) /
/** 页面标题前加 `(N) `；数为 0 或卸载时去掉，宿主自己改过的标题保持原样。 */
export function useTitleCount(count: number) {
  useEffect(() => {
    const plain = document.title.replace(TITLE_PREFIX, '')
    const badge = unreadBadge(count)
    const next = badge ? '(' + badge + ') ' + plain : plain
    if (document.title !== next) document.title = next
  }, [count])
  useEffect(() => () => { document.title = document.title.replace(TITLE_PREFIX, '') }, [])
}

/** 未读数（对话打开时视为 0）；`revision` 变化时立刻重读，例如关闭对话之后。 */
export function useLiaisonUnread(open: boolean, revision = 0) {
  const read = useV2Read('/chat/unread', isUnread, LIAISON_UNREAD_POLL_MS, revision)
  const count = open ? 0 : read.data?.unread ?? 0
  useTitleCount(count)
  return count
}

/**
 * 对话里看到的最新内容记为已读：打开时一次，之后每当显示的最新一条变化再记一次。
 * `at` 是服务端生成这份对话视图的时间，服务端只前进不后退。
 */
export function useMarkLiaisonSeen(observedAt: number | undefined, signature: string) {
  const { scope } = useContext(V2Client)
  const last = useRef<string>(undefined)
  const mark = useCallback((at: number) => {
    void api(scopedResource(scope, '/chat/seen'), { at }).catch(() => { /* the next change marks it again */ })
  }, [scope])
  useEffect(() => {
    if (observedAt === undefined || last.current === signature) return
    last.current = signature
    mark(observedAt)
  }, [observedAt, signature, mark])
}

export function UnreadBadge({ count }: { count: number }) {
  const text = unreadBadge(count)
  return text ? <span className="v2-badge" aria-hidden="true">{text}</span> : null
}

export const unreadLabel = (label: string, count: number) => count > 0 ? label + '，' + (count > 99 ? '超过 99' : count) + ' 条未读' : label
