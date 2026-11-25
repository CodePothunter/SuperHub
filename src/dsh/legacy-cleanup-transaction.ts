import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { LEGACY_CLEANUP_PENDING } from './lock.ts'

type FileChange = { path: string; before: string | null; after: string | null }
interface Manifest {
  schema: 1
  root: string
  scope: string
  ticketIds: string[]
  blockers: string[]
  preserved: string[]
  changes: FileChange[]
  directories: string[]
}
export const digestOf = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
export const cleanupId = /^[a-f0-9]{64}$/
const backupRoot = join('ops', 'legacy-order-cleanup')
const pending = join('ops', LEGACY_CLEANUP_PENDING)
const json = (data: unknown) => Buffer.from(JSON.stringify(data) + '\n')

/** Check every ancestor before reading or changing a local relative path. */
export class CleanupFiles {
  constructor(readonly root: string) {}

  location(path: string) {
    const parts = path.split(sep)
    if (!path || isAbsolute(path) || parts.some(part => !part || part === '..' || part === '.'))
      throw new Error('清理清单中的路径越过当前第二大脑')
    let full = this.root
    for (const [index, part] of parts.entries()) {
      full = join(full, part)
      const stat = lstatSync(full, {throwIfNoEntry:false})
      if (stat?.isSymbolicLink() || stat && index < parts.length - 1 && !stat.isDirectory())
        throw new Error(`无法确认清理路径归属 ${path}`)
    }
    return full
  }

  read(path: string): Buffer | undefined {
    const full = this.location(path)
    const stat = lstatSync(full, {throwIfNoEntry:false})
    if (!stat) return
    if (!stat.isFile()) throw new Error(`清理路径不是常规文件 ${path}`)
    return readFileSync(full)
  }

  list(path: string) {
    const full = this.location(path)
    const stat = lstatSync(full, {throwIfNoEntry:false})
    if (!stat) return []
    if (!stat.isDirectory()) throw new Error(`清理路径不是目录 ${path}`)
    return readdirSync(full, {withFileTypes:true}).sort((a, b) => a.name.localeCompare(b.name))
  }

  write(path: string, bytes: Buffer) {
    const full = this.location(path)
    mkdirSync(dirname(full), {recursive:true, mode:0o700})
    const temporary = full + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temporary, bytes, {flag:'wx', mode:0o600, flush:true})
      renameSync(temporary, full)
    } finally {
      rmSync(temporary, {force:true})
    }
  }

  remove(path: string) { unlinkSync(this.location(path)) }

  removeEmptyDirectory(path: string) {
    try { rmdirSync(this.location(path)) }
    catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
}

export class LegacyCleanupPlan {
  readonly changes = new Map<string, FileChange>()
  readonly outputs = new Map<string, Buffer>()
  readonly directories = new Set<string>()
  readonly ticketIds = new Set<string>()
  readonly blockers = new Set<string>()
  readonly preserved = new Set<string>()

  constructor(readonly files: CleanupFiles, readonly scope: string) {}

  set(path: string, text?: string | Buffer) {
    const current = this.files.read(path)
    const output = text === undefined ? undefined : Buffer.isBuffer(text) ? text : Buffer.from(text)
    const before = current ? digestOf(current) : null
    const after = output ? digestOf(output) : null
    if (before === after) return
    this.changes.set(path,{path,before,after})
    if (output) this.outputs.set(path,output)
  }

  get manifest(): Manifest {
    return {
      schema:1, root:this.files.root, scope:this.scope,
      ticketIds:[...this.ticketIds].sort(), blockers:[...this.blockers].sort(), preserved:[...this.preserved].sort(),
      changes:[...this.changes.values()], directories:[...this.directories],
    }
  }

  prepare(id: string) {
    const plan = this.manifest
    if (digestOf(json(plan)) !== id) throw new Error('清理清单已变化，请重新预览。')
    if (plan.blockers.length) throw new Error(`先核对在途工作后再清理：${plan.blockers.join('、')}`)
    const directory = join(backupRoot,id)
    for (const change of plan.changes) {
      const bytes = this.files.read(change.path)
      if ((bytes ? digestOf(bytes) : null) !== change.before) throw new Error(`文件已更新，请重新预览 ${change.path}`)
      if (bytes) this.files.write(join(directory,'before',change.path),bytes)
      const output = this.outputs.get(change.path)
      if (output) this.files.write(join(directory,'after',change.path),output)
    }
    this.files.write(join(directory,'manifest.json'),json(plan))
    this.files.write(pending,Buffer.from(id + '\n'))
    return plan
  }
}

export function pendingCleanup(files: CleanupFiles) {
  const id = files.read(pending)?.toString('utf8').trim()
  if (id && !cleanupId.test(id)) throw new Error('清理进度文件不可读，请先核对备份。')
  return id
}

export function savedCleanup(files: CleanupFiles, id: string, scope: string) {
  if (!cleanupId.test(id)) throw new Error('请使用预览给出的清理清单标识。')
  const directory = join(backupRoot,id)
  const raw = files.read(join(directory,'manifest.json'))
  if (!raw) return
  const manifest = JSON.parse(raw.toString('utf8')) as Manifest
  if (digestOf(raw) !== id || manifest.schema !== 1 || manifest.root !== files.root || manifest.scope !== scope)
    throw new Error('清理备份与当前第二大脑不匹配。')
  return {manifest, directory, complete:!!files.read(join(directory,'complete'))}
}

export function cleanupReport(manifest: Manifest, id = digestOf(json(manifest)), backup?: string) {
  return {
    scope:manifest.scope, id, ticketIds:manifest.ticketIds,
    changedFiles:manifest.changes.filter(row => row.after !== null).length,
    deletedFiles:manifest.changes.filter(row => row.after === null).length,
    blockers:manifest.blockers, preserved:manifest.preserved, ...(backup && {backup}),
  }
}

/** Read-back hashes let an interrupted apply resume without overwriting new changes. */
export function finishCleanup(files: CleanupFiles, id: string, saved: NonNullable<ReturnType<typeof savedCleanup>>, checkpoint?: (path: string) => void) {
  const {manifest, directory, complete} = saved
  if (!complete) {
    for (const change of manifest.changes) {
      const current = files.read(change.path)
      const digest = current ? digestOf(current) : null
      if (digest !== change.before && digest !== change.after) throw new Error(`清理暂停，文件已改动 ${change.path}`)
      if (change.before !== null) {
        const copy = files.read(join(directory,'before',change.path))
        if (!copy || digestOf(copy) !== change.before) throw new Error(`清理备份暂不可读 ${change.path}`)
      }
      if (change.after !== null) {
        const copy = files.read(join(directory,'after',change.path))
        if (!copy || digestOf(copy) !== change.after) throw new Error(`清理候选暂不可读 ${change.path}`)
      }
    }
    for (const change of manifest.changes) {
      const current = files.read(change.path)
      const digest = current ? digestOf(current) : null
      if (digest === change.after) continue
      if (digest !== change.before) throw new Error(`清理暂停，文件已改动 ${change.path}`)
      if (change.after === null) files.remove(change.path)
      else files.write(change.path,files.read(join(directory,'after',change.path))!)
      checkpoint?.(change.path)
    }
    for (const path of manifest.directories) files.removeEmptyDirectory(path)
    files.write(join(directory,'complete'),Buffer.from(id + '\n'))
  }
  if (pendingCleanup(files) === id) files.remove(pending)
  return cleanupReport(manifest,id,join(files.root,directory,'before'))
}
