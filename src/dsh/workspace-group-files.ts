import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join, sep } from 'node:path'
import type { V2Attachment } from '../core/workspace-v2.ts'
import type { GroupAttachment } from './workspace-group-ledger.ts'
import { fileVersion } from './workspace-notices.ts'

export const GROUP_RESULTS_DIR = 'results'
export const GROUP_FILE_LIMIT = 512 * 1024
const formats: Record<string, V2Attachment['format']> = {'.md': 'markdown', '.txt': 'text', '.html': 'html', '.htm': 'html'}
type FileContent = Pick<V2Attachment, 'format' | 'content'>

/** Read within the working copy authorized for this member, without following a replaced final entry. */
export function readGroupFile(base: string, file: GroupAttachment): FileContent | undefined {
  let fd: number | undefined
  try {
    const path = realpathSync(file.path)
    const format = formats[extname(path).toLowerCase()]
    if (path !== file.path || !path.startsWith(base + sep) || !format) return
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > GROUP_FILE_LIMIT) return
    if (process.platform === 'linux' && realpathSync('/proc/self/fd/' + fd) !== path) return
    const bytes = Buffer.alloc(stat.size)
    let used = 0
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, used)
      if (!count) break
      used += count
    }
    const after = fstatSync(fd)
    if (used !== bytes.length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) return
    const content = bytes.toString('utf8')
    if (content.includes('\0') || !bytes.equals(Buffer.from(content))) return
    return {format, content}
  } catch { return undefined }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** The content digest also names the version kept beside the original group ledger. */
export function keepGroupFile(dir: string, content: FileContent): string {
  const version = fileVersion(content)
  const archive = join(dir, GROUP_RESULTS_DIR), path = join(archive, version + '.json')
  mkdirSync(archive, {recursive: true, mode: 0o700})
  if (realpathSync(archive) !== archive || !lstatSync(archive).isDirectory()) throw new Error('群交付记录目录的归属已改变')
  if (existsSync(path)) {
    if (readKeptGroupFile(dir, version)) return version
    throw new Error('群交付版本已经损坏')
  }
  const temporary = path + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temporary, JSON.stringify(content), {mode: 0o600, flag: 'wx'}); renameSync(temporary, path) }
  finally { rmSync(temporary, {force: true}) }
  return version
}

export function readKeptGroupFile(dir: string, version: string): FileContent | undefined {
  if (!/^[a-f0-9]{64}$/.test(version)) return
  const path = join(dir, GROUP_RESULTS_DIR, version + '.json')
  try {
    if (realpathSync(path) !== path || !lstatSync(path).isFile()) return
    const file = JSON.parse(readFileSync(path, 'utf8')) as Partial<FileContent>
    if (!file.format || !Object.values(formats).includes(file.format) || typeof file.content !== 'string') return
    const content = {format: file.format, content: file.content}
    if (fileVersion(content) === version) return content
  } catch { /* the version may have preceded archived bytes */ }
}
