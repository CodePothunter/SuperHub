import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { isChatInputAttachment, type ChatAttachmentTarget, type ChatInputAttachment } from '../core/chat-attachments.ts'
import { ApiError, chiefApiBase, uploadChatFile } from './api.ts'
import { V2Icon } from './workspace-v2-elements.tsx'

function targetQuery(scope: string, target: ChatAttachmentTarget) {
  const query = new URLSearchParams({scope, sessionId:target.sessionId})
  if (target.workspaceId) query.set('workspaceId', target.workspaceId)
  if (target.workOrderId) query.set('workOrderId', target.workOrderId)
  return query
}

function imageType(file: File) {
  if (file.type && file.type !== 'application/octet-stream') return /^image\/(jpeg|png|webp|gif)$/i.test(file.type) ? file.type.toLowerCase() : undefined
  const suffix = /\.(jpe?g|png|webp|gif)$/i.exec(file.name)?.[1]?.toLowerCase()
  return suffix ? 'image/' + (suffix === 'jpg' ? 'jpeg' : suffix) : undefined
}

function pastedImages(clipboard: DataTransfer) {
  const files = clipboard.files.length ? Array.from(clipboard.files)
    : Array.from(clipboard.items, item => item.kind === 'file' ? item.getAsFile() : null)
  return files.flatMap(file => {
    if (!file) return []
    const type = imageType(file)
    if (!type) return []
    if (file.name.trim()) return [file]
    return [new File([file], '剪贴板图片.' + type.slice('image/'.length), {type, lastModified:file.lastModified})]
  })
}

interface SelectedFile {
  key: number
  file: File
  preview?: string
  error?: string
  attachment?: ChatInputAttachment
}
export function useChatAttachments(scope: string | undefined, target?: ChatAttachmentTarget, context?: string, onDenied?: (message: string) => void) {
  const query = scope && target ? targetQuery(scope, target).toString() : undefined
  const [items, setItems] = useState<SelectedFile[]>([])
  const current = useRef<SelectedFile[]>([])
  const uploads = useRef(new Map<number, AbortController>())
  const nextKey = useRef(0)
  function update(next: SelectedFile[]) { current.current = next; setItems(next) }
  function dispose(row: SelectedFile) {
    uploads.current.get(row.key)?.abort()
    uploads.current.delete(row.key)
    if (row.preview) URL.revokeObjectURL(row.preview)
  }
  useLayoutEffect(() => {
    setItems([])
    return () => {
      current.current.forEach(dispose)
      current.current = []
    }
  }, [query, context])
  function remove(keys: number[]) {
    const discarded = new Set(keys)
    for (const item of current.current) if (discarded.has(item.key)) dispose(item)
    update(current.current.filter(row => !discarded.has(row.key)))
  }
  async function upload(row: SelectedFile) {
    if (!query || uploads.current.has(row.key)) return
    const controller = new AbortController()
    uploads.current.set(row.key, controller)
    function patch(values: Partial<SelectedFile>) {
      update(current.current.map(item => item.key === row.key ? {...item, ...values} : item))
    }
    const params = new URLSearchParams(query)
    params.set('name', row.file.name)
    const image = imageType(row.file)
    params.set('kind', image ? 'image' : 'file')
    if (row.error) patch({error:undefined})
    try {
      const result = await uploadChatFile<{scope: string; attachment: ChatInputAttachment}>('/input-attachments?' + params,
        row.file, image ?? (row.file.type || 'application/octet-stream'), controller.signal)
      if (controller.signal.aborted) return
      if (result?.scope !== scope || !isChatInputAttachment(result.attachment)) throw new Error('上传回执无效，请重新上传。')
      patch({attachment:result.attachment})
    } catch (error) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : '上传失败'
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) onDenied?.(message)
      patch({error:message})
    } finally {
      uploads.current.delete(row.key)
    }
  }
  function add(files: File[]) {
    if (!query || !files.length) return
    const added = files.map(file => ({
      key: ++nextKey.current, file, preview: imageType(file) ? URL.createObjectURL(file) : undefined,
    }))
    update([...current.current, ...added])
    for (const row of added) void upload(row)
  }
  const ready = items.flatMap(row => row.attachment ? [row.attachment] : [])
  return { items, ready, enabled: !!query, add, remove, retry: upload,
    canSend: (text: string) => ready.length === items.length && (!!text.trim() || ready.length > 0),
    // The caller holds this render's snapshot while a send is in flight.
    sent: () => remove(items.map(row => row.key)) }
}

type AttachmentDraft = ReturnType<typeof useChatAttachments>

function PickChatAttachments({ draft, disabled }: { draft: AttachmentDraft; disabled?: boolean }) {
  const field = useRef<HTMLInputElement>(null)
  return <>
    <button type="button" className="chat-attachment-picker" aria-label="添加文件或图片" title="添加文件或图片" disabled={disabled}
      onClick={() => field.current?.click()}><V2Icon name="plus"/></button>
    <input ref={field} type="file" multiple hidden aria-label="选择文件或图片" onChange={event => {
      draft.add(Array.from(event.currentTarget.files ?? []))
      event.currentTarget.value = ''
    }}/>
  </>
}

function fileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.ceil(bytes / 1024) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function SelectedChatAttachments({ draft, sending }: { draft: AttachmentDraft; sending?: boolean }) {
  if (!draft.items.length) return null
  return <ul className="chat-selected-files" aria-label="待发送附件" aria-live="polite">
    {draft.items.map(row => {
      const thumbnail = row.preview && !row.error ? row.preview : undefined
      return <li key={row.key} data-thumbnail={thumbnail ? '' : undefined} data-failed={row.error ? '' : undefined}>
        {thumbnail ? <>
          <img src={thumbnail} alt={row.file.name} title={row.file.name}/>
          {!row.attachment && <small className="chat-thumbnail-status">正在上传…</small>}
        </> : <>
          <span className="chat-file-icon"><V2Icon name="file"/></span>
          <span className="chat-file-detail"><strong title={row.file.name}>{row.file.name}</strong>
            <small>{row.error ? '上传失败 · ' + row.error : row.attachment ? fileSize(row.file.size) : '正在上传…'}</small></span>
        </>}
        {row.error && <button type="button" className="chat-file-retry" aria-label={'重新上传 ' + row.file.name} onClick={() => void draft.retry(row)}>重试</button>}
        <button type="button" className="chat-file-remove" aria-label={'移除 ' + row.file.name} disabled={sending} onClick={() => draft.remove([row.key])}><V2Icon name="close"/></button>
      </li>
    })}
  </ul>
}

export function ChatComposer({ draft, text, disabled, sending, status, accessory, children }: {
  draft: AttachmentDraft; text: string; disabled?: boolean; sending?: boolean; status?: string; accessory?: ReactNode; children: ReactNode
}) {
  return <div className="chat-composer" onPaste={event => {
    const {target, clipboardData} = event
    if (!clipboardData || disabled || !draft.enabled || event.defaultPrevented ||
      !(target instanceof HTMLTextAreaElement) || target.disabled || target.readOnly) return
    const images = pastedImages(clipboardData)
    if (!images.length) return
    if (!clipboardData.getData('text/plain')) event.preventDefault()
    draft.add(images)
  }}>
    <SelectedChatAttachments draft={draft} sending={sending}/>
    {children}
    <div className="v2-send-footer">
      {draft.enabled && <PickChatAttachments draft={draft} disabled={disabled}/>}
      {accessory}
      <span className="chat-composer-status" role="status">{sending ? '正在发送…' : status}</span>
      <button type="submit" className="chat-composer-send" aria-label="发送" title="发送" disabled={disabled || sending || !draft.canSend(text)}>
        {sending ? <span className="chat-composer-spinner" aria-hidden="true"/> : <V2Icon name="send"/>}
      </button>
    </div>
  </div>
}

export function MessageInputAttachments({ scope, target, attachments }: {
  scope?: string; target?: ChatAttachmentTarget; attachments?: ChatInputAttachment[]
}) {
  if (!scope || !target || !attachments?.length) return null
  const base = typeof document === 'undefined' ? '/chief/api' : chiefApiBase(document.baseURI)
  const query = targetQuery(scope, target)
  return <ul className="chat-input-files" aria-label="消息附件">{attachments.map((row, i) => {
    const url = base + '/input-attachments/' + encodeURIComponent(row.id) + '?' + query
    const image = row.kind === 'image'
    return <li key={row.id + '-' + i} data-image={image ? '' : undefined}>{image
      ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={'查看图片 ' + row.name} title={row.name}><img src={url} loading="lazy" alt={row.name}/></a>
      : <a href={url} download={row.name} aria-label={'下载 ' + row.name}><V2Icon name="file"/><span>{row.name}</span><small>{fileSize(row.bytes)}</small></a>}</li>
  })}</ul>
}
