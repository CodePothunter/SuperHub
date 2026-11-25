import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { isChatInputAttachment, type ChatAttachmentTarget, type ChatInputAttachment } from '../core/chat-attachments.ts'
import { CHAT_INPUT_FOLDER } from './brain-private.ts'
import { readAttachmentDocument, type ChatDocumentArgs, type ChatDocumentRead } from './chat-attachment-document.ts'
import { json, type Route } from './http.ts'
import type { HostContext, NativeFileRef, NativeImageRef } from './ports.ts'
import { writeProfileFile } from './profile-import-files.ts'

export { renderChatDocument, type ChatDocumentRead } from './chat-attachment-document.ts'

type StoredObject = {file: NativeFileRef} | {image: NativeImageRef}
interface StoredInput {
  scope: string
  attachment: ChatInputAttachment
  object: StoredObject
  targets: ChatAttachmentTarget[]
  readers: string[]
  staged?: {sessionId: string; receiptId: string}
}
interface Options {
  root: string
  scope: string
  ctx: HostContext
  /** Private upload may resolve a logical liaison target to the current, trusted DSH session. */
  validateTarget(target: ChatAttachmentTarget, action: 'upload' | 'read'): string | void | Promise<string | void>
  profilePatch?: string
}

const handle = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), {status}) }
const missing = (): never => fail(404, '这条对话里没有这份附件')
const sameTarget = (a: ChatAttachmentTarget, b: ChatAttachmentTarget) =>
  a.sessionId === b.sessionId && a.workspaceId === b.workspaceId && a.workOrderId === b.workOrderId

const errorMessages: Record<string, string> = {
  MODEL_DOES_NOT_SUPPORT_IMAGES: '当前模型不支持图片输入。请选择支持图片的模型后重发。',
  TOO_MANY_IMAGES: '本条消息的图片数量超过 DSH 上限',
  IMAGES_TOO_LARGE: '本条消息的图片总大小超过 DSH 上限',
  IMAGE_TOO_LARGE: '图片大小超过 DSH 上传上限',
  IMAGE_TOO_MANY_PIXELS: '图片像素数超过 DSH 上限',
  IMAGE_DIMENSION_TOO_LARGE: '图片尺寸超过 DSH 上限',
  UNSUPPORTED_IMAGE_TYPE: 'DSH 当前配置不支持这种图片格式',
  IMAGE_TYPE_MISMATCH: '图片格式和实际内容不符',
  INVALID_IMAGE: 'DSH 无法解码这张图片，请检查原图',
  FILE_NOT_STAGED: '目标会话的暂存附件已失效，请重试',
  ATTACHMENT_CORRUPT: '原件完整性校验失败，请重新上传',
  ATTACHMENT_NOT_FOUND: 'DSH 找不到这份原件，请重新上传',
  ATTACHMENT_FILES_UNSUPPORTED: '当前 DSH 附件服务不支持文件流',
  ENOSPC: '宿主磁盘空间不足，无法保存这份附件',
  ENOENT: '宿主找不到这份附件或它的本地记录',
  EACCES: '宿主没有访问附件记录的权限',
  EPERM: '宿主没有访问附件记录的权限',
  EROFS: '宿主的附件记录目录只读',
}
const attachmentStatus: Record<string, number> = {
  TOO_MANY_IMAGES: 413, IMAGE_TOO_LARGE: 413, IMAGES_TOO_LARGE: 413, IMAGE_TOO_MANY_PIXELS: 413, IMAGE_DIMENSION_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE_TYPE: 415, ATTACHMENT_NOT_FOUND: 404, ATTACHMENT_FILES_UNSUPPORTED: 503, ATTACHMENT_WRITE_FAILED: 503,
  ENOSPC: 507, ENOENT: 404, EACCES: 503, EPERM: 503, EROFS: 503,
}
export function chatAttachmentError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? 'DSH 附件操作失败')
  const e = error as {code?: string; message?: string; details?: {reason?: string}; error?: unknown}
  if (e.error) return chatAttachmentError(e.error)
  return errorMessages[e.details?.reason ?? e.code ?? ''] ?? e.message ?? 'DSH 附件操作失败'
}

function targetFrom(query: URLSearchParams): ChatAttachmentTarget {
  const sessionId = query.get('sessionId'), workspaceId = query.get('workspaceId'), workOrderId = query.get('workOrderId')
  if (!sessionId?.trim() || workspaceId === '' || workOrderId === '' || (workOrderId && !workspaceId)) return fail(400, '附件缺少有效的会话或工单范围')
  return {sessionId, ...workspaceId && {workspaceId}, ...workOrderId && {workOrderId}}
}

function privateDirectory(path: string, create: boolean): boolean {
  let entry = lstatSync(path, {throwIfNoEntry: false})
  if (!entry && create) {
    mkdirSync(path, {mode: 0o700})
    entry = lstatSync(path)
  }
  if (!entry) return false
  if (!entry.isDirectory() || realpathSync(path) !== path) fail(503, '当前脑的附件记录目录不可用')
  return true
}

/** Only verified native objects enter this registry. The browser sees random per-upload handles. */
export class ChatAttachments {
  private readonly ops: string
  private readers?: Map<string, Set<string>>

  constructor(private readonly options: Options) { this.ops = join(realpathSync(options.root), 'ops') }

  private directory(create = false): string | undefined {
    const dir = join(this.ops, CHAT_INPUT_FOLDER)
    return privateDirectory(this.ops, create) && privateDirectory(dir, create) ? dir : undefined
  }

  private row(id: unknown): StoredInput {
    if (typeof id !== 'string' || !handle.test(id)) return missing()
    const dir = this.directory()
    if (!dir) return missing()
    const path = join(dir, id + '.json')
    if (!lstatSync(path, {throwIfNoEntry: false})?.isFile()) return missing()
    let row: StoredInput
    try { row = JSON.parse(readFileSync(path, 'utf8')) as StoredInput } catch { return fail(503, '这份附件的授权记录损坏，请重新上传') }
    if (row?.scope !== this.options.scope) return missing()
    if (!isChatInputAttachment(row.attachment) || row.attachment.id !== id || !Array.isArray(row.targets) || !Array.isArray(row.readers)) {
      return fail(503, '这份附件的授权记录损坏，请重新上传')
    }
    return row
  }

  private save(row: StoredInput): void {
    writeProfileFile(join(this.directory(true)!, row.attachment.id + '.json'), JSON.stringify(row))
  }

  private store() { return this.options.ctx.get('attachments') ?? fail(503, '当前 DSH 没有启用附件存储') }
  private uploads() { return this.options.ctx.get('fileUploads') ?? fail(503, '当前 DSH 没有启用会话附件投递') }

  private admitted(refs: ChatInputAttachment[]): ChatInputAttachment[] {
    const images = refs.filter(ref => ref.kind === 'image')
    if (images.length) {
      const limits = this.store().imageLimits
      if (images.length > limits.maxImagesPerMessage) fail(413, errorMessages.TOO_MANY_IMAGES!)
      if (images.some(ref => ref.bytes > limits.maxImageBytes)) fail(413, errorMessages.IMAGE_TOO_LARGE!)
      if (images.reduce((n, ref) => n + ref.bytes, 0) > limits.maxMessageImageBytes) fail(413, errorMessages.IMAGES_TOO_LARGE!)
    }
    return refs
  }

  resolve(target: ChatAttachmentTarget, rawIds: unknown): ChatInputAttachment[] {
    if (rawIds === undefined) return []
    if (!Array.isArray(rawIds) || rawIds.some(id => typeof id !== 'string')) return fail(400, '附件应为有序的附件标识列表')
    return this.admitted(rawIds.map(id => {
      const row = this.row(id)
      return row.targets.some(t => sameTarget(t, target)) ? row.attachment : missing()
    }))
  }

  /** Called only with refs from a verified owner message when Chief grants a derived order/group access. */
  grant(target: ChatAttachmentTarget, refs: readonly ChatInputAttachment[]): void {
    for (const ref of refs) {
      const row = this.row(ref.id)
      if (row.targets.some(t => sameTarget(t, target))) continue
      row.targets.push(target)
      this.save(row)
    }
  }

  private readerIndex(): Map<string, Set<string>> {
    if (this.readers) return this.readers
    const index = new Map<string, Set<string>>()
    const dir = this.directory()
    for (const file of dir ? readdirSync(dir) : []) {
      if (!file.endsWith('.json') || !handle.test(file.slice(0, -5))) continue
      let row: StoredInput
      try { row = this.row(file.slice(0, -5)) } catch (error) {
        // Copied brains can contain metadata bound to their old scope. A bad record grants no access.
        if ((error as {status?: number}).status !== 404) this.options.ctx.logger.warn('跳过损坏的聊天附件记录 %s', file)
        continue
      }
      for (const reader of row.readers) {
        const set = index.get(reader) ?? new Set<string>()
        set.add(row.attachment.id)
        index.set(reader, set)
      }
    }
    return this.readers = index
  }

  hasReadable(nativeSessionId: string): boolean { return !!this.readerIndex().get(nativeSessionId)?.size }

  /** Native tool grants are independent of web target grants, and only follow confirmed delivery. */
  allowRead(nativeSessionId: string, refs: readonly ChatInputAttachment[]): void {
    if (!nativeSessionId) return fail(400, '附件读取缺少接收会话')
    for (const ref of refs) {
      const row = this.row(ref.id)
      if (row.readers.includes(nativeSessionId)) continue
      row.readers.push(nativeSessionId)
      this.save(row)
      if (this.readers) {
        const set = this.readers.get(nativeSessionId) ?? new Set<string>()
        set.add(ref.id)
        this.readers.set(nativeSessionId, set)
      }
    }
  }

  async promptParts(nativeSessionId: string, refs: readonly ChatInputAttachment[], signal: AbortSignal): Promise<{type: 'file'; receiptId: string}[]> {
    const rows = refs.map(ref => this.row(ref.id))
    this.admitted(rows.map(row => row.attachment))
    const parts: {type: 'file'; receiptId: string}[] = []
    for (const {attachment} of rows) {
      signal.throwIfAborted()
      const uploads = this.uploads()
      // Claim the draft receipt synchronously. Concurrent sends of the same material get independent receipts.
      const row = this.row(attachment.id), staged = row.staged
      if (staged?.sessionId === nativeSessionId) {
        delete row.staged
        this.save(row)
        const result = await this.options.ctx.sessionController.resolveAgent(nativeSessionId)
        if ('agent' in result && uploads.resolve(result.agent, staged.receiptId)) {
          parts.push({type: 'file', receiptId: staged.receiptId})
          continue
        }
      }
      const store = this.store(), {object} = row
      const request = {sessionId: nativeSessionId, name: attachment.name, signal}
      const uploaded = 'image' in object
        ? await uploads.uploadImageStream({...request, mediaType: object.image.mediaType, data: oneChunk((await store.readImage(object.image, signal)).data)})
        : await uploads.uploadStream({...request, data: store.readFileStream(object.file, signal)})
      parts.push({type: 'file', receiptId: uploaded.receiptId})
    }
    return parts
  }

  async cliInputs(refs: readonly ChatInputAttachment[], signal: AbortSignal): Promise<(ChatInputAttachment & {path: string})[]> {
    const rows = refs.map(ref => this.row(ref.id))
    this.admitted(rows.map(row => row.attachment))
    const inputs: (ChatInputAttachment & {path: string})[] = []
    for (const {attachment, object} of rows) {
      signal.throwIfAborted()
      const store = this.store()
      let path: string | undefined
      if ('image' in object) {
        await store.readImage(object.image, signal)
        path = store.imageHostPath(object.image)
      } else {
        // readFileStream verifies both the digest and size, including when a host path is available.
        for await (const _chunk of store.readFileStream(object.file, signal)) signal.throwIfAborted()
        path = store.fileHostPath(object.file)
      }
      const file = path && resolve(path) === path ? lstatSync(path, {throwIfNoEntry: false}) : undefined
      if (!path || !file?.isFile() || (file.mode & 0o222)) return fail(503, '当前 DSH 附件存储没有可提供给编程成员的只读路径')
      inputs.push({...attachment, path})
    }
    return inputs
  }

  async readDocument(nativeSessionId: string, args: ChatDocumentArgs, signal: AbortSignal): Promise<ChatDocumentRead> {
    signal.throwIfAborted()
    if (args.id === undefined) {
      const offset = args.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) return fail(400, '附件列表续读位置无效')
      const ids = Array.from(this.readerIndex().get(nativeSessionId) ?? []).sort()
      const page = ids.slice(offset, offset + 50)
      return {attachments: page.map(id => this.row(id).attachment), ...offset + page.length < ids.length && {nextOffset: offset + page.length}}
    }
    const {attachment, object, readers} = this.row(args.id)
    if (!readers.includes(nativeSessionId)) return missing()
    const vision = async () => {
      const resolved = await this.options.ctx.sessionController.resolveAgent(nativeSessionId)
      const model = 'agent' in resolved && resolved.agent.model?.current()
      if (!model) return
      const info = await this.options.ctx.get('llm')?.resolveModelInfo(model.provider, model.model)
      if (info?.inputModalities && !info.inputModalities.includes('image')) fail(422, '当前模型只支持文字，无法阅读这张页图。请切换到支持图片的模型。')
    }
    if ('image' in object) {
      await vision()
      const {ref} = await this.store().readImage(object.image, signal)
      return {name: attachment.name, image: ref}
    }
    return readAttachmentDocument(this.store(), object.file, args, signal, vision, this.options.profilePatch)
  }

  private async upload(target: ChatAttachmentTarget, query: URLSearchParams, request: IncomingMessage, signal: AbortSignal): Promise<ChatInputAttachment> {
    const nativeId = await this.options.validateTarget(target, 'upload')
    const kind = query.get('kind')
    const name = (query.get('name') ?? '').split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f\x7f]/g, '').trim()
    if (!name || (kind !== 'image' && kind !== 'file')) return fail(400, '请提供附件文件名和类型')
    const mime = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    const store = this.store()
    let bytes = 0
    async function* counted() {
      for await (const chunk of request.iterator({destroyOnReturn: false}) as AsyncIterable<Buffer>) {
        signal.throwIfAborted()
        bytes += chunk.byteLength
        yield chunk
      }
    }
    const input = {name, data: counted(), signal}
    let object: StoredObject, staged: StoredInput['staged']
    if (kind === 'image') {
      const limits = store.imageLimits, mediaType = limits.mediaTypes.find(type => type === mime)
      if (!mediaType) return fail(415, errorMessages.UNSUPPORTED_IMAGE_TYPE!)
      if (nativeId && !target.workspaceId) {
        const saved = await this.uploads().uploadImageStream({...input, sessionId: nativeId, mediaType})
        object = {image: saved.image}
        staged = {sessionId: nativeId, receiptId: saved.receiptId}
      } else {
        const chunks: Uint8Array[] = []
        for await (const chunk of input.data) {
          if (bytes > Math.min(limits.maxImageBytes, limits.maxMessageImageBytes)) return fail(413, errorMessages.IMAGE_TOO_LARGE!)
          chunks.push(chunk)
        }
        signal.throwIfAborted()
        object = {image: await store.saveImage({name, data: Buffer.concat(chunks, bytes), mediaType})}
      }
    } else if (nativeId && !target.workspaceId) {
      const saved = await this.uploads().uploadStream({...input, sessionId: nativeId})
      object = {file: saved.file}
      staged = {sessionId: nativeId, receiptId: saved.receiptId}
    } else object = {file: await store.saveFileStream(input)}
    await this.options.validateTarget(target, 'upload')
    signal.throwIfAborted()
    const verified = 'image' in object ? object.image : object.file
    const mediaType = 'image' in object ? object.image.mediaType : mime
    const attachment: ChatInputAttachment = {id: randomUUID(), name: verified.name ?? name, kind, bytes, ...mediaType && {mediaType}}
    this.save({scope: this.options.scope, attachment, object, targets: [target], readers: [], staged})
    return attachment
  }

  private async download(target: ChatAttachmentTarget, id: string, res: ServerResponse, signal: AbortSignal): Promise<void> {
    await this.options.validateTarget(target, 'read')
    const {object, attachment, targets} = this.row(id)
    if (!targets.some(t => sameTarget(t, target))) return missing()
    const store = this.store(), image = 'image' in object ? await store.readImage(object.image, signal) : undefined
    const source = 'file' in object ? store.readFileStream(object.file, signal) : oneChunk(image!.data)
    const filename = encodeURIComponent(attachment.name.toWellFormed()).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))
    res.setHeader('content-type', image?.ref.mediaType ?? 'application/octet-stream')
    res.setHeader('content-disposition', (image ? 'inline' : 'attachment') + "; filename*=UTF-8''" + filename)
    res.setHeader('cache-control', 'private, no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    for await (const chunk of source) {
      if (!res.write(chunk)) await once(res, 'drain', {signal})
    }
    res.end()
  }

  readonly route: Route = async (call, res) => {
    const {seg, method, request, url} = call
    if (seg[0] !== 'input-attachments') return false
    if (!call.owner) return fail(403, '需要主人身份才能访问聊天附件')
    if (url.searchParams.get('scope') !== this.options.scope) return fail(409, '第二大脑已切换，请刷新后再访问附件')
    const target = targetFrom(url.searchParams)
    const lifetime = new AbortController(), signal = lifetime.signal
    const abort = () => lifetime.abort()
    res.once('close', abort)
    request?.once('aborted', abort)
    try {
      if (method === 'POST' && call.path === '/input-attachments' && request) {
        const attachment = await this.upload(target, url.searchParams, request, signal)
        json(res, 201, {scope: this.options.scope, attachment})
      } else if (method === 'GET' && seg.length === 2) {
        await this.download(target, seg[1]!, res, signal)
      } else return fail(404, '未知附件接口')
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true }
      // Any JSON error must not retain the download disposition.
      res.removeHeader('content-disposition')
      const failure = error as {status?: number; code?: string; details?: {reason?: string}}
      throw Object.assign(new Error(chatAttachmentError(error)), {status: failure?.status ?? attachmentStatus[failure?.details?.reason ?? failure?.code ?? ''] ?? 400})
    } finally {
      res.off('close', abort)
      request?.off('aborted', abort)
    }
    return true
  }
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes }
