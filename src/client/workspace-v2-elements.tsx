import { createContext, useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { V2Delegation, V2Session } from '../core/workspace-v2.ts'

const glyphs = {
  file: <><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v6h5M8 13h8m-8 4h5"/></>,
  today: <><circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></>,
  work: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>,
  pencil: <path d="m14 5 5 5M4 20l4.5-1L20 7a2.1 2.1 0 0 0-3-3z"/>,
  chat: <path d="M21 12a8 8 0 0 1-8 8H8l-5 2 1-6a8 8 0 1 1 17-4z"/>,
  group: <><circle cx="9" cy="8" r="3"/><path d="M2 20v-2c0-3 3-5 7-5s7 2 7 5v2m0-15a3 3 0 0 1 0 6m2 3c3 1 4 3 4 5"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-13 5h2m4 0h2"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  next: <path d="m9 5 7 7-7 7"/>, back: <path d="m10 5-7 7 7 7M3 12h17"/>,
  down: <path d="m6 9 6 6 6-6"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
  plus: <path d="M12 5v14M5 12h14"/>, send: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  book: <path d="M3 5c4-1 6 0 9 2 3-2 5-3 9-2v13c-4-1-6 0-9 2-3-2-5-3-9-2zm9 2v13"/>,
  list: <path d="M9 6h12M9 12h12M9 18h12M3 6h1m-1 6h1m-1 6h1"/>, box: <path d="m3 7 9-4 9 4-9 5zm0 0v10l9 4 9-4V7m-9 5v9"/>,
}
export function V2Icon({ name }: { name: keyof typeof glyphs }) {
  return <svg className="v2-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{glyphs[name]}</svg>
}
/**
 * True inside an archived workspace: the workspace page sets it once (from the workspace it shows) and every write entry
 * below reads it, so no component decides on its own whether the workspace takes changes.
 */
export const ArchivedWorkspace = createContext(false)
export const useArchived = () => useContext(ArchivedWorkspace)
/** Said where a write entry would be. */
export const ARCHIVED_NOTE = '工作区已归档，恢复后可继续。'

export const executorName = { codex: 'Codex', 'claude-code': 'Claude Code', dsh: 'DSH' }
export const sessionKind = (session: V2Session) => session.kind === 'group' ? '群聊' : '编程会话 · ' + executorName[session.executor]
const stageName = { accepted: '已接手', active: '执行中', waiting: '等待', closed: '已关闭', done: '已完成' }
export const delegationState = (job: V2Delegation) => job.paused && job.status !== 'done' ? '已暂停' : stageName[job.status]
export const readableTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

export function Issue({ text, retry }: { text?: string; retry?: () => void }) {
  return text ? <div className="v2-issue" role="alert"><span>{text}</span>{retry && <button type="button" className="v2-link" onClick={retry}>重新读取</button>}</div> : null
}

/**
 * The native dialog handles Tab and Escape. Its body is also focusable for keyboard scrolling.
 * `size="wide"` is the working window of the liaison only: wide, fixed height, full screen on phones.
 */
export function V2Dialog({ title, meta, close, fallbackFocus, size, children }: {
  title: string; meta?: string; close: () => void; fallbackFocus?: RefObject<HTMLElement | null>; size?: 'wide'; children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    const node = dialog.current!
    const previous = document.activeElement
    node.showModal()
    titleRef.current?.focus({ preventScroll: true })
    return () => {
      node.close()
      if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) {
        previous.focus({ preventScroll: true })
        if (document.activeElement === previous) return
      }
      if (fallbackFocus?.current?.isConnected) fallbackFocus.current.focus({ preventScroll: true })
    }
  }, [])
  return <dialog ref={dialog} className={size ? 'v2-dialog ' + size : 'v2-dialog'} aria-label={title} onCancel={event => { event.preventDefault(); close() }}>
    <header><div>{meta && <div className="v2-eyebrow">{meta}</div>}<h2 ref={titleRef} tabIndex={-1}>{title}</h2></div>
      <button className="v2-icon-btn" type="button" aria-label="关闭详情" onClick={close}><V2Icon name="close"/></button></header>
    <div className="v2-dialog-body" role="group" aria-label="详情内容" tabIndex={0}>{children}</div>
  </dialog>
}
