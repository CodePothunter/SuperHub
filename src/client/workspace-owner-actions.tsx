import { createContext, useLayoutEffect, useRef, useState } from 'react'
import type { OwnerAction } from '../core/workspace-engagement.ts'
import type { Scoped } from './superhub-api.ts'
import { segment, useV2Read, useV2Write } from './workspace-v2-api.ts'
import { Issue, readableTime, V2Icon } from './workspace-v2-elements.tsx'

const path = '/v2/owner-actions'
interface OwnerActionList extends Scoped { items: OwnerAction[] }

export function isOwnerActionList(value: unknown): value is OwnerActionList {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const {scope, items} = value as Partial<OwnerActionList>
  if (typeof scope !== 'string') return false
  if (!Array.isArray(items)) return false
  const ids = new Set<string>()
  return items.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || ![row.id, row.workspaceId, row.sessionId, row.messageId, row.question, row.workspaceName, row.sessionTitle]
        .every(field => typeof field === 'string' && field.trim().length > 0)
      || (row.orderId !== undefined && (typeof row.orderId !== 'string' || !row.orderId.trim()))
      || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))
      || ids.has(row.id)) return false
    ids.add(row.id)
    return true
  })
}

export function useOwnerActions() {
  return useV2Read(path, isOwnerActionList, 4000)
}

export const OwnerActions = createContext<{ items: readonly OwnerAction[]; refresh: () => Promise<void> }>({
  items: [], refresh: async () => {},
})

export function OwnerActionRows({ items, open }: { items: readonly OwnerAction[]; open: (row: OwnerAction) => void }) {
  return <div className="v2-card">
    {items.map(row => <button key={row.id} type="button" className="v2-row v2-owner-action-row" data-owner-action-id={row.id} onClick={() => open(row)}>
      <span className="v2-row-title"><strong>{row.question}</strong><V2Icon name="next"/></span>
      <small>{row.workspaceName} · {row.sessionTitle} · <time dateTime={row.at}>{readableTime(row.at)}</time></small>
    </button>)}
  </div>
}

const acceptedReply = (value: Scoped) => (value as { ok?: unknown }).ok === true
const replyLimit = 40_000

/** Send an answer with the question's identity, independent of the conversation composer and its draft. */
export function OwnerActionReply({ item, changed, showQuestion }: { item: OwnerAction; changed: () => Promise<void>; showQuestion: boolean }) {
  const write = useV2Write(acceptedReply)
  const [draft, setDraft] = useState('')
  const [replying, setReplying] = useState(false)
  const [sent, setSent] = useState(false)
  const replyButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  useLayoutEffect(() => {
    if (!replying && restoreFocus.current) {
      restoreFocus.current = false
      replyButton.current?.focus({preventScroll:true})
    }
  }, [replying])
  function finishEditing() {
    restoreFocus.current = true
    setReplying(false)
  }
  async function reply() {
    if (!draft.trim()) return
    const receipt = await write.post(path + '/' + segment(item.id) + '/reply', { text: draft.trim() })
    if (receipt) {
      setSent(true)
      setDraft('')
      finishEditing()
      await changed()
    }
  }
  return <div className="v2-owner-action-reply">
    <strong>待你回应</strong>
    {showQuestion && <p>{item.question}</p>}
    {sent && <small role="status">已发送，等待接口人确认。</small>}
    {replying ? <form className="v2-compose" onSubmit={event => { event.preventDefault(); void reply() }}>
      <label>答复这件事<textarea autoFocus rows={2} value={draft} maxLength={replyLimit} disabled={write.busy}
        onChange={event => setDraft(event.target.value)}/></label>
      <div className="v2-actions">
        <button type="submit" className="v2-button primary" disabled={!draft.trim() || write.busy}>{write.busy ? '正在发送…' : '发送答复'}</button>
        <button type="button" className="v2-link" disabled={write.busy} onClick={finishEditing}>取消</button>
      </div>
      <Issue text={write.error}/>
    </form> : <button ref={replyButton} type="button" className="v2-link" onClick={() => setReplying(true)}>{sent ? '补充答复' : '答复'}</button>}
  </div>
}
