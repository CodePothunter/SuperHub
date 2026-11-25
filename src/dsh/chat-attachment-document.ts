import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import type { ContentBlock, NativeAttachmentStore, NativeFileRef, NativeImageRef } from './ports.ts'

export interface ChatDocumentArgs { id?: string; sheet?: string; page?: number; offset?: number; renderPage?: boolean }
export interface ChatDocumentRead {
  attachments?: ChatInputAttachment[]
  name?: string
  text?: string
  sheet?: string
  sheets?: string[]
  page?: number
  pageCount?: number
  offset?: number
  nextOffset?: number
  image?: NativeImageRef
}

interface Converter {
  convert(request: {inputPath: string; outputPath: string; sheet?: string}, signal: AbortSignal): Promise<unknown>
  renderImages(request: {inputPath: string; outputDir: string; pages?: number[]; maxPages: number; dpi?: number}, signal: AbortSignal): Promise<{
    images: readonly {path: string; sheet?: string}[]; pageCount: number
  }>
  dispose(): Promise<void>
}
type Kit = {createConverter(options: {fontMetadataCacheDirectory: false}): Promise<Converter>}

const CHUNK = 12_000
// LibreOffice Kit's public default; avoid copying inputs the converter will reject.
const MAX_OFFICE_BYTES = 64 * 1024 * 1024
const extract = promisify(execFile)
const word = new Set(['.docx', '.doc', '.odt'])
const sheet = new Set(['.xlsx', '.xls', '.ods'])

async function officeKit(profilePatch?: string): Promise<Kit> {
  // Resolve from the running DSH installation or its profile, including pnpm's strict transitive packages.
  const anchors: (URL | string)[] = []
  if (profilePatch && isAbsolute(profilePatch)) anchors.push(profilePatch)
  if (process.argv[1] && isAbsolute(process.argv[1])) {
    try { anchors.push(realpathSync(process.argv[1])) } catch { /* the calling script may already be unlinked */ }
  }
  anchors.push(new URL(import.meta.url))
  for (const anchor of anchors) {
    const local = createRequire(anchor)
    const loaders = [local]
    for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-office-to-pdf']) {
      try { loaders.push(createRequire(local.resolve(name + '/package.json'))) } catch { /* optional host package */ }
    }
    for (const loader of loaders) {
      let path: string
      try { path = loader.resolve('@deepseek-ai/libreoffice-kit') } catch { continue }
      try {
        const kit = await import(pathToFileURL(path).href) as Partial<Kit>
        if (typeof kit.createConverter === 'function') return kit as Kit
      } catch { /* an incomplete installation may have another valid profile anchor */ }
    }
  }
  throw Error('当前 DSH 找不到可用的 LibreOffice Kit，无法转换这份文档')
}

function position(value: unknown, first: number, label: string): number {
  if (value === undefined) return first
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < first) throw Error(label + '无效')
  return value
}

async function textWindow(source: AsyncIterable<Uint8Array>, offset: number, signal: AbortSignal): Promise<Pick<ChatDocumentRead, 'text' | 'offset' | 'nextOffset'>> {
  const decoder = new TextDecoder('utf-8', {fatal: true})
  let size = 0, text = ''
  function append(part: string) {
    if (part.includes('\0')) throw Error('附件不是可直接读取的 UTF-8 文本')
    const start = Math.max(offset - size, 0)
    if (text.length < CHUNK && start < part.length) text += part.slice(start, start + CHUNK - text.length)
    size += part.length
  }
  for await (const chunk of source) {
    signal.throwIfAborted()
    append(decoder.decode(chunk, {stream: true}))
  }
  append(decoder.decode())
  if (offset > size) throw Error('续读位置超出正文长度')
  if (offset + text.length < size && /[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
  return {text, offset, ...offset + text.length < size && {nextOffset: offset + text.length}}
}

async function readPageText(input: string, page: number, signal: AbortSignal): Promise<string | undefined> {
  try {
    // Optional Poppler text layer. Only the page number and our own private input path enter this fixed argv.
    const p = String(page)
    const {stdout} = await extract('pdftotext', ['-f', p, '-l', p, '-layout', '-enc', 'UTF-8', input, '-'],
      {encoding: 'utf8', cwd: dirname(input), signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024})
    return stdout.trim() || undefined
  } catch {
    signal.throwIfAborted()
    return undefined
  }
}

async function* utf8(text: string) { yield Buffer.from(text) }

export async function readAttachmentDocument(store: NativeAttachmentStore, file: NativeFileRef, args: ChatDocumentArgs,
  signal: AbortSignal, requireVision: () => Promise<void>, profilePatch?: string): Promise<ChatDocumentRead> {
  const extension = extname(file.name).toLowerCase(), name = file.name
  const offset = position(args.offset, 0, '续读位置'), page = position(args.page, 1, '页码')
  if (args.sheet !== undefined && (typeof args.sheet !== 'string' || !args.sheet)) throw Error('请提供确切的工作表名')
  if (args.sheet && !sheet.has(extension)) throw Error('只有工作簿可按工作表读取')
  if ((args.page !== undefined || args.renderPage) && extension !== '.pdf') throw Error('只有 PDF 可按页读取')
  if (!word.has(extension) && !sheet.has(extension) && extension !== '.pdf') {
    try { return {name, ...await textWindow(store.readFileStream(file, signal), offset, signal)} }
    catch (error) {
      if (error instanceof TypeError && (error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
        throw Error('「' + name + '」不是 UTF-8 文本，当前文档工具无法解读这种文件')
      }
      throw error
    }
  }
  if (file.bytes > MAX_OFFICE_BYTES) throw Error('「' + name + '」超过文档转换的 64 MiB 输入上限')
  signal.throwIfAborted()
  const dir = await mkdtemp(join(tmpdir(), 'chief-chat-input-'))
  const inputPath = join(dir, 'input' + extension), outputDir = join(dir, 'pages')
  let converter: Converter | undefined
  try {
    // Verify the original through DSH as it streams into a private regular file with a controlled suffix.
    await pipeline(store.readFileStream(file, signal), createWriteStream(inputPath, {flags: 'wx', mode: 0o600}), {signal})
    if (extension === '.pdf' && !args.renderPage) {
      const text = await readPageText(inputPath, page, signal)
      if (text) return {name, page, ...await textWindow(utf8(text), offset, signal)}
    }
    if (extension === '.pdf') await requireVision()
    const kit = await officeKit(profilePatch)
    converter = await kit.createConverter({fontMetadataCacheDirectory: false})
    signal.throwIfAborted()
    if (extension === '.pdf') {
      const result = await converter.renderImages({inputPath, outputDir, pages: [page], maxPages: 1}, signal)
      const rendered = result.images[0]
      if (!rendered || dirname(rendered.path) !== outputDir) throw Error('DSH 未返回这页的图像')
      const data = await readFile(rendered.path, {signal})
      const image = await store.saveImage({name: name + ' p' + page + '.png', mediaType: 'image/png', data})
      signal.throwIfAborted()
      return {name, page, pageCount: result.pageCount, image}
    }

    const workbook = sheet.has(extension), outputPath = join(dir, workbook ? 'output.csv' : 'output.txt')
    try {
      await converter.convert({inputPath, outputPath, ...args.sheet && {sheet: args.sheet}}, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (!workbook || args.sheet || !/multi-sheet|multiple (?:work)?sheets/i.test(String(error))) throw error
      // The Kit's public render manifest lists visible worksheets. Keep this discovery pass bounded.
      try {
        const pages = await converter.renderImages({inputPath, outputDir, maxPages: 48, dpi: 24}, signal)
        const sheets = [...new Set(pages.images.flatMap(image => image.sheet ? [image.sheet] : []))]
        if (sheets.length) return {name, sheets, text: '请用 sheet 指定要读取的工作表'}
      } catch { signal.throwIfAborted() }
      return {name, text: '此工作簿有多张表，请用 sheet 指定要读取的工作表名称'}
    }
    return {name, ...workbook && args.sheet && {sheet: args.sheet}, ...await textWindow(createReadStream(outputPath), offset, signal)}
  } catch (error) {
    signal.throwIfAborted()
    // The converter may mention its temporary paths. Only the public name belongs in a tool result.
    const detail = String(error instanceof Error ? error.message : error).replaceAll(dir, '[文档]').slice(0, 400)
    throw Error('读取「' + name + '」失败：' + detail)
  } finally {
    try { await converter?.dispose() } finally { await rm(dir, {recursive: true, force: true}) }
  }
}

/** The image block matches DSH read_image's model-facing projection. Its pixels remain in native storage. */
export function renderChatDocument(_args: unknown, value: unknown): ContentBlock[] {
  const {image, ...result} = value as ChatDocumentRead
  const blocks: ContentBlock[] = [{type: 'text', text: JSON.stringify(result)}]
  if (image) blocks.push({type: 'image', attachment: image})
  return blocks
}
