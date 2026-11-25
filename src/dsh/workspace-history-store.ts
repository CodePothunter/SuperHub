import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HistoryDetail, HistoryImport, HistoryItem } from '../core/workspace-history.ts'
import type { V2Attachment } from '../core/workspace-v2.ts'
import { IMPORT_SOURCES } from '../core/onboarding.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import type { HistorySource } from './workspace-history-sources.ts'

export type Material = Omit<HistoryDetail, 'scope' | 'item'>
interface SavedAttachment { id: string; label: string; format: V2Attachment['format']; digest: string }
export interface HistorySnapshot { item: HistoryItem; detail: string; files: SavedAttachment[] }
type PersistedSnapshot = Omit<HistorySnapshot, 'item'> & { item: HistoryItem | (Omit<HistoryItem, 'kind'> & { kind: 'ticket' }) }
export interface HistoryCleanupState {
  key: string
  people: string[]
  documents: Record<string, { sourceBody: string; detail: string }>
  last: {
    previewId: string
    requestDigest: string
    removedPeople: number
    editedDocuments: number
    objectsToPurge: number
    pendingObjects: string[]
  }
}
export interface HistoryIndex {
  schema: 1 | 2
  scope: string
  entries: Record<string, PersistedSnapshot>
  receipts: Record<string, HistoryImport>
  importedAt?: string
  cleanup?: HistoryCleanupState
}

export const historyDigest = (text: string) => createHash('sha256').update(text).digest('hex')
export const historyDigestPattern = /^[a-f0-9]{64}$/
const plainRecord = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
export const materialize = (value: Partial<Material>): Material => ({ messages:[], attachments:[], links:[], ...value })

export function historyObjectReferences(rows: Iterable<Pick<PersistedSnapshot, 'detail' | 'files'>>) {
  const references = new Set<string>()
  for (const row of rows) {
    references.add(row.detail)
    for (const file of row.files) references.add(file.digest)
  }
  return references
}

function validCleanup(state: HistoryCleanupState) {
  const digest = (value: unknown) => typeof value === 'string' && historyDigestPattern.test(value)
  const digests = (value: unknown) => Array.isArray(value) && value.every(digest)
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0
  return plainRecord(state) && digest(state.key) && digests(state.people) && plainRecord(state.documents)
    && Object.entries(state.documents).every(([id, doc]) => id.startsWith('document:') && digest(doc?.sourceBody) && digest(doc?.detail))
    && plainRecord(state.last) && digest(state.last.previewId) && digest(state.last.requestDigest)
    && count(state.last.removedPeople) && count(state.last.editedDocuments) && count(state.last.objectsToPurge)
    && digests(state.last.pendingObjects) && state.last.pendingObjects.length <= state.last.objectsToPurge
}

export function isLegacyAssistantImport(path: string, title: string): boolean {
  return /^inbox\/import-[a-f0-9]{64}\.md$/.test(path.replaceAll('\\', '/'))
    && IMPORT_SOURCES.some(source => title === `从 ${source} 导入的"对主人的了解"`)
}

export function visibleHistorySnapshot(row: PersistedSnapshot | undefined): row is HistorySnapshot {
  return !!row?.item && row.item.kind !== 'ticket'
    && !(row.item.kind === 'document' && isLegacyAssistantImport(row.item.sourceId,row.item.title))
}

/** Immutable content is written first. One atomic index replacement publishes the material and the request receipt together. */
export class WorkspaceHistoryStore {
  private readonly ops: string
  private readonly dir: string
  private readonly objects: string
  private readonly indexFile: string

  constructor(root: string, private readonly scope: string) {
    this.ops = join(realpathSync(root),'ops')
    this.dir = join(this.ops,'superhub-history-' + workspaceFingerprint(scope))
    this.objects = join(this.dir,'objects')
    this.indexFile = join(this.dir,'index.json')
  }

  private checkDir(path: string, create: boolean) {
    if (!lstatSync(path,{throwIfNoEntry:false}) && create) mkdirSync(path,{mode:0o700})
    if (realpathSync(path) !== path || !lstatSync(path).isDirectory()) throw new Error('历史资料目录不可用')
  }

  load(): HistoryIndex {
    try {
      this.checkDir(this.ops,false)
      const empty: HistoryIndex = { schema:2, scope:this.scope, entries:{}, receipts:{} }
      if (!lstatSync(this.dir,{throwIfNoEntry:false})) return empty
      this.checkDir(this.dir,false)
      const st = lstatSync(this.indexFile,{throwIfNoEntry:false})
      if (!st) return empty
      if (!st.isFile()) throw new Error()
      const doc: HistoryIndex = JSON.parse(readFileSync(this.indexFile,'utf8'))
      if (doc?.scope !== this.scope || (doc.schema !== 1 && doc.schema !== 2) || !plainRecord(doc.entries) || !plainRecord(doc.receipts)
        || doc.cleanup !== undefined && !validCleanup(doc.cleanup)) throw new Error()
      for (const [id,row] of Object.entries(doc.entries)) {
        if (row?.item?.id !== id || !historyDigestPattern.test(row.detail) || !Array.isArray(row.files)
          || row.files.some(file => !historyDigestPattern.test(file.digest))) throw new Error()
      }
      return doc
    } catch { return workspaceError(503, '历史资料索引暂时不可读，请核对第二大脑存储后重试') }
  }

  prepare() {
    try {
      this.checkDir(this.ops,false)
      this.checkDir(this.dir,true)
      this.checkDir(this.objects,true)
    } catch { workspaceError(503,'无法打开历史资料存储，请检查后重试') }
  }

  private write(path: string, content: string) {
    const tmp = path + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(tmp, content, { flag:'wx', mode:0o600, flush:true })
      renameSync(tmp, path)
    } catch {
      if (existsSync(tmp)) unlinkSync(tmp)
      workspaceError(503,'历史资料尚未保存，请检查存储后重试')
    }
  }

  private readObject(digest: string): string {
    if (!historyDigestPattern.test(digest)) return workspaceError(503,'资料版本不可读')
    const file = join(this.objects,digest)
    try {
      if (realpathSync(file) !== file || !lstatSync(file).isFile()) throw new Error()
      const value = readFileSync(file,'utf8')
      if (historyDigest(value) !== digest) throw new Error()
      return value
    } catch { return workspaceError(503,'已导入的资料版本暂不可读，请检查存储后重试') }
  }

  private put(value: string) {
    this.checkDir(this.objects,false)
    const digest = historyDigest(value), path = join(this.objects,digest)
    if (lstatSync(path,{throwIfNoEntry:false})) this.readObject(digest)
    else this.write(path,value)
    return digest
  }

  save(index: HistoryIndex) {
    this.checkDir(this.dir,false)
    this.write(this.indexFile,JSON.stringify(index) + '\n')
  }

  verifyObjects(digests: Iterable<string>) {
    for (const digest of digests) this.readObject(digest)
  }

  saveCleanup(index: HistoryIndex, replacement?: { text: string; digest: string }) {
    const created = replacement && !lstatSync(join(this.objects,replacement.digest),{throwIfNoEntry:false})
    if (replacement) this.put(replacement.text)
    try { this.save(index) }
    catch (error) {
      if (created && replacement) this.removeObjects([replacement.digest])
      throw error
    }
  }

  finishCleanup(index: HistoryIndex) {
    const pending = index.cleanup?.last.pendingObjects
    if (!pending?.length) return
    const retained = historyObjectReferences(Object.values(index.entries))
    for (const doc of Object.values(index.cleanup!.documents)) retained.add(doc.detail)
    this.removeObjects(pending.filter(digest => !retained.has(digest)))
    index.cleanup!.last.pendingObjects = []
    this.save(index)
  }

  private removeObjects(digests: Iterable<string>) {
    try {
      this.checkDir(this.dir,false)
      this.checkDir(this.objects,false)
      for (const digest of digests) {
        if (!historyDigestPattern.test(digest)) throw new Error()
        const path = join(this.objects,digest)
        if (!lstatSync(path,{throwIfNoEntry:false})) continue
        this.readObject(digest)
        unlinkSync(path)
      }
    } catch { workspaceError(503,'旧资料对象回收尚未完成，请检查存储后用原清单重试') }
  }

  detail(row: HistorySnapshot): Material { return JSON.parse(this.readObject(row.detail)) as Material }

  attachment(row: HistorySnapshot, id: string): V2Attachment | undefined {
    const found = row.files.find(f => f.id === id)
    if (found) return { id, label:found.label, format:found.format, content:this.readObject(found.digest) }
  }

  async capture(source: HistorySource, previous: HistorySnapshot | undefined, current: () => void) {
    let material: Material
    try { material = materialize(await source.detail()) }
    catch { material = materialize({issue:'原资料暂时不可读，请稍后重新导入。'}) }
    current()
    if (material.issue && previous) return { row:previous, incomplete:true }
    let item = source.item
    if (previous) {
      const prior = this.detail(previous)
      if (!material.body && prior.body) {
        material.body = prior.body
        if (item.kind === 'project') item = { ...item, title:previous.item.title }
      }
      const messages = new Map(prior.messages.map(message => [message.id,message]))
      for (const message of material.messages) {
        const priorId = messages.get(message.id)?.speakerId
        messages.set(message.id, priorId && !message.speakerId ? {...message,speakerId:priorId} : message)
      }
      material.messages = [...messages.values()].sort((a,b) => a.at && b.at ? a.at.localeCompare(b.at) : 0)
    }
    const files = new Map(previous?.files.map(f => [f.id,f]))
    let inaccessible = 0, unavailable = 0
    for (const ref of material.attachments) {
      let attachment: V2Attachment | undefined
      try { attachment = source.attachment?.(ref.id) } catch { /* keep a previously captured version */ }
      if (attachment) {
        files.set(ref.id,{ id:ref.id,label:attachment.label,format:attachment.format,digest:this.put(attachment.content) })
      } else {
        inaccessible++
        if (!files.has(ref.id)) unavailable++
      }
    }
    const saved = [...files.values()]
    material.attachments = saved.map(({id,label}) => ({id,label}))
    if (unavailable) material.issue = [material.issue,'部分原交付暂时不可读，可稍后重试导入。'].filter(Boolean).join(' ')
    const row: HistorySnapshot = { item, detail:this.put(JSON.stringify(material)), files:saved }
    return { row, incomplete:!!material.issue || inaccessible > 0 }
  }
}
