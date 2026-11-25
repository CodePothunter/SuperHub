import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {createRequire} from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachmentTarget, ChatInputAttachment } from '../src/core/chat-attachments.ts'
import { privateBrainData } from '../src/dsh/brain-private.ts'
import { ChatAttachments, chatAttachmentError, renderChatDocument } from '../src/dsh/chat-attachments.ts'
import { serveApi } from '../src/dsh/http.ts'
import type { Agent, HostContext, NativeAttachmentStore, NativeFileRef, NativeFileUploads } from '../src/dsh/ports.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}) })
const owner: ChatAttachmentTarget = {sessionId: 'liaison'}
const group: ChatAttachmentTarget = {sessionId: 'room', workspaceId: 'work'}
const order: ChatAttachmentTarget = {...group, workOrderId: 'order'}
const signal = new AbortController().signal
const candidate = (name: string) => readFileSync(new URL('./fixtures/chat-input/' + name, import.meta.url))

/** A content-addressed store with the same stream and session-specific receipt contracts as DSH. */
function fixture(profilePatch?: string) {
  const root = mkdtempSync(join(tmpdir(), 'chief-input-'))
  dirs.push(root)
  const scope = 'brain-A'
  let nativeSession = 'native-segment-1', sequence = 0, vision = true
  const staged = new Map<string, string>()
  const data = new Map<string, Buffer>()
  const receivedChunks: number[] = []
  function persist(bytes: Buffer, name: string): NativeFileRef {
    const id = createHash('sha256').update(bytes).digest('hex')
    data.set(id, bytes)
    if (readdirSync(root).includes(id)) return {attachmentId: id, name, bytes: bytes.length}
    writeFileSync(join(root, id), bytes, {mode: 0o400})
    return {attachmentId: id, name, bytes: bytes.length}
  }
  const store: NativeAttachmentStore = {
    imageLimits: {mediaTypes: ['image/png'], maxImageBytes: 8 * 1024 * 1024, maxImagesPerMessage: 2, maxMessageImageBytes: 10 * 1024 * 1024},
    saveFileStream: async input => {
      const chunks: Buffer[] = []
      for await (const part of input.data) { receivedChunks.push(part.byteLength); chunks.push(Buffer.from(part)) }
      return persist(Buffer.concat(chunks), input.name ?? 'file')
    },
    saveImage: async input => {
      if (!Buffer.from(input.data).subarray(0, 4).equals(Buffer.from('89504e47', 'hex'))) throw Object.assign(Error(), {code: 'INVALID_IMAGE'})
      return {...persist(Buffer.from(input.data), input.name ?? 'image.png'), mediaType: input.mediaType, width: 1, height: 1}
    },
    async *readFileStream(ref) {
      const value = data.get(ref.attachmentId)
      if (!value) throw Object.assign(Error(), {code: 'ATTACHMENT_NOT_FOUND'})
      for (let i = 0; i < value.length; i += 4096) yield value.subarray(i, i + 4096)
    },
    readImage: async ref => ({ref, data: data.get(ref.attachmentId)!}),
    fileHostPath: ref => join(root, ref.attachmentId),
    imageHostPath: ref => join(root, ref.attachmentId),
  }
  const receipt = (sessionId: string) => {
    const id = 'receipt-' + ++sequence
    staged.set(id, sessionId)
    return id
  }
  const uploads: NativeFileUploads = {
    resolve: (agent, id) => agent.id === staged.get(id) || undefined,
    uploadStream: async input => ({receiptId: receipt(input.sessionId), file: await store.saveFileStream(input)}),
    uploadImageStream: async input => {
      const chunks: Uint8Array[] = []
      for await (const part of input.data) chunks.push(part)
      const image = await store.saveImage({data: Buffer.concat(chunks), name: input.name, mediaType: input.mediaType})
      return {receiptId: receipt(input.sessionId), image}
    },
  }
  const services: Record<string, unknown> = {attachments: store, fileUploads: uploads, llm: {resolveModelInfo: async () => ({inputModalities: vision ? ['text','image'] : ['text']})}}
  const ctx = {get: (name: string) => services[name], sessionController: {resolveAgent: async (id: string) => ({agent: {id, model: {current: () => ({provider: 'fixture', model: 'm'})}}})}} as unknown as HostContext
  const validateTarget = vi.fn((target: ChatAttachmentTarget, _action: 'upload' | 'read'): void | string => {
    if (target.sessionId === owner.sessionId && !target.workspaceId) return nativeSession
    if (target.sessionId === group.sessionId && target.workspaceId === group.workspaceId) return
    throw Object.assign(Error('目标不存在'), {status: 404})
  })
  const options = {root, scope, ctx, profilePatch, validateTarget}
  let service = new ChatAttachments(options)
  async function call(path: string, body?: Buffer[], options: {owner?: boolean; marker?: boolean; mime?: string; public?: boolean} = {}) {
    const request = Object.assign(Readable.from(body ?? []), {method: body ? 'POST' : 'GET', url: '/chief/api' + path,
      headers: {...options.marker === false ? {} : {'x-chief-request': '1'}, 'content-type': options.mime ?? 'application/octet-stream'}}) as unknown as IncomingMessage
    const headers: Record<string, string> = {}
    let status = 200
    const chunks: Buffer[] = []
    const response = Object.assign(new EventEmitter(), {
      headersSent: false,
      writeHead(s: number, values: Record<string, string>) { status = s; Object.assign(headers, values) },
      end(value?: string) { if (value) chunks.push(Buffer.from(value)) },
      write(value: Uint8Array) { this.headersSent = true; chunks.push(Buffer.from(value)); return true },
      setHeader(k: string, v: string) { headers[k] = v },
      removeHeader(k: string) { delete headers[k] },
    }) as unknown as ServerResponse
    await serveApi(request, response, options.public ? 'public' : 'dsh', [service.route], options.owner ?? true)
    const bytes = Buffer.concat(chunks)
    return {status, headers, bytes, json: () => JSON.parse(bytes.toString())}
  }
  const params = (target: ChatAttachmentTarget) => new URLSearchParams({scope, ...target})
  const endpoint = (target: ChatAttachmentTarget, id?: string) => '/input-attachments' + (id ? '/' + id : '') + '?' + params(target)
  async function upload(target: ChatAttachmentTarget, name: string, material: Buffer | Buffer[], image = false) {
    const response = await call(endpoint(target) + '&' + new URLSearchParams({name, kind: image ? 'image' : 'file'}), Array.isArray(material) ? material : [material], {mime: image ? 'image/png' : 'application/octet-stream'})
    expect(response.status, response.bytes.toString()).toBe(201)
    return response.json().attachment as ChatInputAttachment
  }
  return {root, scope, ctx, get service() {return service}, restart: () => {service = new ChatAttachments(options)}, store, services, staged, receivedChunks,
    call, upload, endpoint, validateTarget, rotate: () => {nativeSession = 'native-segment-2'}, textOnly: () => {vision = false}}
}

describe('DSH chat input attachments', () => {
  it('streams ordinary files beyond the JSON limit, authenticates both transports and scopes every read', async () => {
    const f = fixture(), chunks = Array.from({length: 12}, () => Buffer.alloc(32 * 1024, 17))
    const a = await f.upload(group, '../给我;".dat', chunks)
    expect(a).toMatchObject({name: '给我;".dat', bytes: 384 * 1024, kind: 'file'})
    expect(f.receivedChunks).toEqual(chunks.map(c => c.length))
    expect(f.staged.size).toBe(0)
    const get = f.endpoint(group, a.id)
    const result = await f.call(get, undefined, {public: true})
    expect(result.bytes).toEqual(Buffer.concat(chunks))
    expect(result.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''%/)
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect((await f.call(get, undefined, {owner: false})).status).toBe(403)
    expect((await f.call(get.replace('brain-A', 'brain-B'))).status).toBe(409)
    expect((await f.call(f.endpoint(owner, a.id))).status).toBe(404)
    expect((await f.call(f.endpoint(order, a.id))).status).toBe(404)
    expect((await f.call(f.endpoint(group), chunks, {owner: false})).status).toBe(403)
    expect((await f.call(f.endpoint(group), chunks, {marker: false})).status).toBe(403)
    expect((await f.call('/chat', chunks)).status).toBe(413)
    expect(() => f.service.resolve(group, [a, {id: a.id}])).toThrow('列表')
    expect(() => f.service.resolve(group, ['../../private'])).toThrow('没有')
    expect(f.service.resolve(group, undefined)).toEqual([])
    expect(f.service.resolve(group, [])).toEqual([])
    expect(privateBrainData(['ops','chat-input-attachments',a.id + '.json'])).toBe(true)
  })

  it('issues separate handles for identical bytes and re-stages real native objects per receiver', async () => {
    const f = fixture()
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const a = await f.upload(owner, 'a.txt', Buffer.from('材料里才有 TOKEN-WREN'))
    const b = await f.upload(group, 'a.txt', Buffer.from('材料里才有 TOKEN-WREN'))
    const image = await f.upload(group, 'b.png', png, true)
    expect(a.id).not.toBe(b.id)
    expect(() => f.service.resolve(group, [a.id])).toThrow('没有')
    const [one,two] = await Promise.all([f.service.promptParts('native-segment-1', [a], signal), f.service.promptParts('native-segment-1', [a], signal)])
    expect(new Set([one[0]!.receiptId, two[0]!.receiptId])).toEqual(new Set(['receipt-1','receipt-2']))
    f.service.grant(order, [a, image])
    expect(f.service.resolve(order, [image.id, a.id])).toEqual([image, a])
    const forwarded = await f.service.promptParts('researcher', [image, a], signal)
    expect(forwarded.map(p => [p.type, f.staged.get(p.receiptId)])).toEqual([['file','researcher'], ['file','researcher']])
    expect(f.service.hasReadable('researcher')).toBe(false)
    await expect(f.service.readDocument('researcher', {id: a.id}, signal)).rejects.toThrow('没有')
    f.service.allowRead('researcher', [a, image])
    f.rotate()
    f.restart()
    expect(f.service.hasReadable('researcher')).toBe(true)
    expect(f.service.resolve(order, [a.id])).toEqual([a])
    expect((await f.call(f.endpoint(owner, a.id))).bytes.toString()).toContain('TOKEN-WREN')
    expect(await f.service.readDocument('researcher', {id: a.id}, signal)).toMatchObject({name: 'a.txt', text: '材料里才有 TOKEN-WREN'})
    expect((await f.service.readDocument('researcher', {}, signal)).attachments).toEqual(expect.arrayContaining([a,image]))
    const pixels = await f.service.readDocument('researcher', {id: image.id}, signal)
    expect(renderChatDocument({}, pixels)[1]).toMatchObject({type:'image', attachment:{mediaType:'image/png'}})
    expect((await f.call(f.endpoint(group, image.id))).headers['content-disposition']).toMatch(/^inline/)
    f.textOnly()
    await expect(f.service.readDocument('researcher', {id: image.id}, signal)).rejects.toThrow('只支持文字')
    expect((await f.service.cliInputs([a, image], signal)).map(item => readFileSync(item.path))).toEqual([Buffer.from('材料里才有 TOKEN-WREN'),png])
    const [file] = await f.service.cliInputs([a], signal)
    chmodSync(file!.path, 0o600)
    await expect(f.service.cliInputs([a], signal)).rejects.toThrow('只读')
  })

  it('revalidates a draft destination after I/O, and reports model/size or missing service errors', async () => {
    const f = fixture(), png = Buffer.from('89504e470d0a1a0a', 'hex')
    const image = await f.upload(group, 'a.png', png, true)
    const url = f.endpoint(group) + '&kind=image&name=f.png'
    expect((await f.call(url, [png], {mime:'image/svg+xml'})).status).toBe(415)
    expect((await f.call(url, [Buffer.from('invalid')], {mime:'image/png'})).json().error).toContain('解码')
    f.store.imageLimits.maxImageBytes = png.length + 1
    f.store.imageLimits.maxMessageImageBytes = png.length * 2 - 1
    expect((await f.call(url, [png,png], {mime:'image/png'})).status).toBe(413)
    expect(() => f.service.resolve(group, [image.id, image.id])).toThrow('总大小')
    expect(() => f.service.resolve(group, [image.id, image.id, image.id])).toThrow('数量')
    f.validateTarget.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {throw Object.assign(Error('工单已关闭'),{status:409})})
    expect((await f.call(f.endpoint(group) + '&kind=file&name=x', [png])).status).toBe(409)
    expect(readdirSync(join(f.root, 'ops','chat-input-attachments')).length).toBe(1)
    f.services.fileUploads = undefined
    expect(await f.service.promptParts('native', [], signal)).toEqual([])
    await expect(f.service.promptParts('native', [image], signal)).rejects.toThrow('投递')
    expect(chatAttachmentError({error:{details:{reason:'MODEL_DOES_NOT_SUPPORT_IMAGES'}}})).toContain('不支持图片')
  })

  it('recovers a draft after DSH loses its receipts and keeps copied-brain grants out of the active scope', async () => {
    const f = fixture()
    const a = await f.upload(owner, 'a.txt', Buffer.from('ORCHID'))
    f.staged.clear()
    f.restart()
    const [fresh] = await f.service.promptParts('native-segment-1', [a], signal)
    expect(f.staged.get(fresh!.receiptId)).toBe('native-segment-1')
    expect(fresh!.receiptId).not.toBe('receipt-1')
    f.service.allowRead('native-segment-1', [a])
    const copied = new ChatAttachments({ctx: f.ctx, root: f.root, scope: 'other-brain', validateTarget: () => undefined})
    expect(copied.hasReadable('native-segment-1')).toBe(false)
    expect(() => copied.resolve(owner, [a.id])).toThrow('没有')
    await expect(copied.readDocument('native-segment-1', {id:a.id}, signal)).rejects.toThrow('没有')
  })

  it('reads paginated UTF-8 only after delivery without splitting a surrogate pair', async () => {
    const f = fixture(), material = 'a'.repeat(11_999) + '🌲' + '续读'
    const a = await f.upload(owner, 'a.txt', Buffer.from(material))
    f.service.allowRead('s', [a])
    const first = await f.service.readDocument('s', {id: a.id}, signal)
    expect(first.nextOffset).toBe(11999)
    expect((await f.service.readDocument('s', {id: a.id, offset: first.nextOffset}, signal)).text).toBe('🌲续读')
    await expect(f.service.readDocument('s', {id: a.id, offset: -1}, signal)).rejects.toThrow('续读位置')
    const bin = await f.upload(owner, 'b.bin', Buffer.from([0xff, 0x8a]))
    f.service.allowRead('s', [bin])
    await expect(f.service.readDocument('s', {id: bin.id}, signal)).rejects.toThrow('UTF-8')
  })

  it.runIf(process.env.CHIEF_TEST_DSH_PACKAGE)('uses the installed DSH LibreOffice Kit to read DOCX, a non-first worksheet and real PDF page pixels', async () => {
    const f = fixture(process.env.CHIEF_TEST_DSH_PACKAGE)
    const read = async (name: string, args = {}) => {
      const a = await f.upload(owner, name, candidate(name))
      f.service.allowRead('s', [a])
      return f.service.readDocument('s', {id: a.id,...args}, signal)
    }
    expect((await read('a.docx')).text).toContain('WREN-4817')
    const damaged = await f.upload(owner, 'damaged.docx', candidate('a.docx').subarray(0, 32))
    f.service.allowRead('s', [damaged])
    await expect(f.service.readDocument('s', {id: damaged.id}, signal)).rejects.toThrow(/读取「damaged\.docx」失败/)
    expect((await read('b.xlsx')).sheets).toEqual(['Overview','Detail'])
    expect(await read('b.xlsx',{sheet:'Detail'})).toMatchObject({sheet:'Detail',text:expect.stringContaining('Line-A,17,283,4811')})
    const page = await read('c.pdf', {page:1})
    if (spawnSync('pdftotext', ['-v'], {stdio:'ignore'}).status === 0) expect(page.text).toContain('TEXT-LARCH-3892')
    else expect(page.image?.mediaType).toBe('image/png')
    const scan = await read('d.pdf', {page:1})
    expect(scan).toMatchObject({page:1,pageCount:1,image:{mediaType:'image/png'}})
    const bytes = (await f.store.readImage(scan.image!)).data
    expect(Buffer.from(bytes).subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a')
    const sharp = createRequire(process.env.CHIEF_TEST_DSH_PACKAGE!)('sharp')
    const raster = await sharp(bytes).removeAlpha().raw().toBuffer({resolveWithObject:true})
    const pixel = (x: number, y: number) => [...raster.data.subarray((raster.info.width*y+x)*3, (raster.info.width*y+x)*3+3)]
    expect(pixel(100,145)).toEqual([15,71,210])
    expect(pixel(352,145)).toEqual([218,69,13])
    f.textOnly()
    await expect(read('d.pdf',{page:1})).rejects.toThrow('只支持文字')
  }, 120_000)

  it.runIf(process.env.CHIEF_TEST_DSH_PACKAGE)('stores and re-stages the uploaded bytes with the installed DSH LocalAttachmentStore and FileUploads', async () => {
    const require = createRequire(process.env.CHIEF_TEST_DSH_PACKAGE!)
    const [local, native] = await Promise.all(['dsh-attachment-local', 'dsh-client-file-upload'].map(name => import(require.resolve('@deepseek-ai/' + name))))
    const f = fixture(), agent = (id: string) => ({id, session: {header: {id, origin: 'user'}, snapshotEvents: () => []}})
    const agents = new Map(['native-segment-1','member'].map(id => [id, agent(id)] as const))
    const ctx = {
      reflect: {provide: (name: string, service: unknown) => Object.assign(ctx, {[name]: service})},
      effect: (start: () => unknown) => start(), on: () => {}, commands: {registerFileReceiptResolver: () => () => {}},
      connection: {fetch: {register: () => () => {}}}, agents,
    }
    const store: NativeAttachmentStore = new local!.LocalAttachmentStore(ctx, {dshHome: f.root})
    const uploads: NativeFileUploads = new native!.FileUploads(ctx)
    Object.assign(f.services, {attachments: store, fileUploads: uploads})
    f.ctx.sessionController.resolveAgent = async id => ({agent: agents.get(id)!})
    const rgba = await require('sharp')({create: {width: 19, height: 11, channels: 3, background: '#185d6c'}}).png().toBuffer()
    const a = await f.upload(owner, 'a.txt', Buffer.from('native-frost-84'))
    const img = await f.upload(group, 'b.png', rgba, true)
    const [original] = await f.service.promptParts('native-segment-1', [a], signal)
    expect(uploads.resolve(agents.get('native-segment-1')!, original!.receiptId)).toMatchObject({type:'file', attachment:{name:'a.txt'}})
    expect(uploads.resolve(agents.get('member')!, original!.receiptId)).toBeUndefined()
    f.service.grant(order, [a,img])
    f.restart()
    const relay = await f.service.promptParts('member', f.service.resolve(order, [img.id,a.id]), signal)
    const admitted = relay.map(part => uploads.resolve(agents.get('member') as Agent, part.receiptId))
    expect(admitted).toMatchObject([{type:'image',attachment:{width:19,height:11}},{type:'file',attachment:{bytes:15}}])
    const paths = await f.service.cliInputs([a,img], signal)
    expect(readFileSync(paths[0]!.path, 'utf8')).toBe('native-frost-84')
    const preview = await f.call(f.endpoint(order, img.id))
    expect(preview.headers['content-type']).toBe('image/png')
    expect(preview.bytes).toEqual(readFileSync(paths[1]!.path))
    f.service.allowRead('member', [a])
    expect(await f.service.readDocument('member', {id:a.id}, signal)).toMatchObject({text:'native-frost-84'})
  })
})
