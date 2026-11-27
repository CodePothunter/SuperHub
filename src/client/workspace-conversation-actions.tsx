import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Scoped } from './superhub-api.ts'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import { MESSAGE_ROW } from './scroll-anchor.ts'
import { segment, useV2Write } from './workspace-v2-api.ts'
import { Issue, useArchived, V2Dialog, V2Icon } from './workspace-v2-elements.tsx'

interface DeleteReceipt extends Scoped { id: string; deletedAt: string }
function isDeleteReceipt(value: Scoped, resource: string): value is DeleteReceipt {
  const row = value as Partial<DeleteReceipt>
  return typeof row.id === 'string' && resource.endsWith('/' + segment(row.id) + '/delete')
    && typeof row.deletedAt === 'string' && Number.isFinite(Date.parse(row.deletedAt))
}

export function DeleteWorkspaceTarget({ path, kind, title, done }: {
  path: string; kind: '会话' | '工单'; title: string; done: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const archived = useArchived()
  const write = useV2Write(isDeleteReceipt)
  if (archived) return null
  const close = () => { if (!write.busy) setConfirming(false) }
  return <>
    <button type="button" className="v2-link v2-delete-target" onClick={() => setConfirming(true)}>删除{kind}</button>
    {confirming && <V2Dialog title={'删除' + kind + '？'} meta={title} close={close}>
      <p>{kind === '会话' ? '这场会话将从列表移除，所属工单仍可查看。' : '这张工单将从列表移除，会话里的原有发言仍可查看。'}</p>
      <Issue text={write.error}/>
      <div className="v2-actions">
        <button type="button" className="v2-button primary" disabled={write.busy} onClick={async () => {
          const receipt = await write.post<DeleteReceipt>(path + '/delete', {})
          if (receipt) { setConfirming(false); done() }
        }}>{write.busy ? '正在删除…' : '确认删除'}</button>
        <button type="button" className="v2-link" disabled={write.busy} onClick={close}>取消</button>
      </div>
    </V2Dialog>}
  </>
}

interface EditReceipt extends Scoped { sessionId: string; traceId: string; messageId: string }
function isEditReceipt(value: Scoped): value is EditReceipt {
  const row = value as Partial<EditReceipt>
  return [row.sessionId, row.traceId, row.messageId].every(field => typeof field === 'string' && field.length > 0)
}

/** Capture the version at the moment the editor opens. A conflict leaves the draft in the open form. */
export interface MessageEdit { id: string; text: string; traceId: string; attachments?: readonly ChatInputAttachment[] }

export function MessageByline({ children, edit, disabled }: { children: ReactNode; edit?: () => void; disabled?: boolean }) {
  const byline = <div className="v2-byline">{children}</div>
  return edit ? <div className="v2-editable-byline">
    <button type="button" className="v2-edit-message" aria-label="编辑历史消息" title="编辑历史消息" onClick={edit} disabled={disabled}>
      <V2Icon name="pencil"/>
    </button>
    {byline}
  </div> : byline
}

export function MessageEditor({ base, sessionId, edit, close, saved, maxLength }: {
  base: string; sessionId: string; edit: MessageEdit; close: () => void; saved: (receipt: EditReceipt) => void; maxLength: number
}) {
  const write = useV2Write(isEditReceipt)
  const [draft, setDraft] = useState(edit.text)
  const [issue, setIssue] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  const attachments = edit.attachments ?? []
  const canSave = draft !== edit.text && (!!draft.trim() || attachments.length > 0)
  useLayoutEffect(() => {
    const field = input.current
    if (!field) return
    field.focus({preventScroll:true})
    field.setSelectionRange(field.value.length, field.value.length)
    field.scrollIntoView({block:'nearest'})
  }, [])
  function cancel() {
    if (write.busy) return
    const row = input.current?.closest<HTMLElement>(MESSAGE_ROW)
    close()
    requestAnimationFrame(() => {
      if (row?.isConnected) (row.querySelector<HTMLButtonElement>('.v2-edit-message') ?? row).focus({preventScroll:true})
    })
  }
  return <form className="v2-message-editor" aria-label="编辑历史消息" aria-busy={write.busy} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target === input.current) {
      event.preventDefault()
      if (canSave && !write.busy) event.currentTarget.requestSubmit()
    }
  }} onSubmit={async event => {
    event.preventDefault()
    if (!canSave || write.busy) return
    setIssue('')
    const receipt = await write.post<EditReceipt>(base + '/messages/' + segment(edit.id) + '/edit',
      {text: draft, sessionId, expectedTraceId: edit.traceId})
    if (!receipt) return
    if (receipt.sessionId !== sessionId || receipt.traceId === edit.traceId) {
      setIssue('回执与正在编辑的会话版本不一致，请重新读取。')
      return
    }
    saved(receipt)
  }}>
    <textarea ref={input} aria-label="消息正文" value={draft} onChange={event => setDraft(event.target.value)}
      rows={3} maxLength={maxLength} required={!attachments.length} readOnly={write.busy}/>
    {attachments.length > 0 && <p className="v2-editor-attachments">保留附件 · {attachments.map(file => file.name).join('、')}</p>}
    <Issue text={write.error || issue}/>
    <div className="v2-editor-actions">
      <button type="button" className="v2-button" onClick={cancel} disabled={write.busy}>取消</button>
      <button type="submit" className="v2-button primary" disabled={write.busy || !canSave}>{write.busy ? '正在保存…' : '保存并续写'}</button>
    </div>
  </form>
}
