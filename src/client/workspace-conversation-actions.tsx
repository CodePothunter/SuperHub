import { useState } from 'react'
import type { Scoped } from './superhub-api.ts'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import { segment, useV2Write } from './workspace-v2-api.ts'
import { Issue, useArchived, V2Dialog } from './workspace-v2-elements.tsx'

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

export function MessageEditor({ base, sessionId, edit, close, saved, maxLength }: {
  base: string; sessionId: string; edit: MessageEdit; close: () => void; saved: (receipt: EditReceipt) => void; maxLength: number
}) {
  const write = useV2Write(isEditReceipt)
  const [draft, setDraft] = useState(edit.text)
  const [issue, setIssue] = useState('')
  const cancel = () => { if (!write.busy) close() }
  const attachments = edit.attachments ?? []
  const canSave = draft !== edit.text && (!!draft.trim() || attachments.length > 0)
  return <V2Dialog title="编辑历史消息" close={cancel}>
    <form onSubmit={async event => {
      event.preventDefault()
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
      <label>消息正文<textarea value={draft} onChange={event => setDraft(event.target.value)} rows={6} maxLength={maxLength} required={!attachments.length}/></label>
      {attachments.length > 0 && <p className="v2-quiet">保留的附件 · {attachments.map(file => file.name).join('、')}</p>}
      <Issue text={write.error || issue}/>
      <div className="v2-actions">
        <button type="submit" className="v2-button primary" disabled={write.busy || !canSave}>{write.busy ? '正在保存…' : '保存并重新续写'}</button>
        <button type="button" className="v2-link" onClick={cancel} disabled={write.busy}>取消</button>
      </div>
    </form>
  </V2Dialog>
}
