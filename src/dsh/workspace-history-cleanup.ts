import { createHmac, randomBytes } from 'node:crypto'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import { historyDigest, historyDigestPattern, historyObjectReferences, visibleHistorySnapshot,
  type HistoryCleanupState, type HistoryIndex, type HistorySnapshot, type WorkspaceHistoryStore } from './workspace-history-store.ts'

interface DocumentSection {
  id: string
  startLine: number
  endLine: number
  heading: string
  nextHeading: string
}
interface CleanupRequest { people: string[]; document?: DocumentSection }

const headingPattern = /^(#{1,6})[ \t]+\S/
const keyPattern = /^[^\u0000-\u001f\u007f]{1,512}$/u
const signed = (key: string, value: string) => createHmac('sha256',Buffer.from(key,'hex')).update(value).digest('hex')

function parseCleanup(body: Record<string, unknown>): CleanupRequest {
  const { people, document } = body
  if (!Array.isArray(people) || people.length > 100 || new Set(people).size !== people.length || people.some(id =>
    typeof id !== 'string' || !id.startsWith('person:') || id.length <= 'person:'.length || !keyPattern.test(id)))
    return workspaceError(400,'请提供至多 100 个不同的人物快照标识')
  if (document === undefined && people.length) return { people:[...people].sort() as string[] }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return workspaceError(400,'请指定要清理的人物快照或文档章节')
  const { id, startLine, endLine, heading, nextHeading } = document as Record<string, unknown>
  if (typeof id !== 'string' || !id.startsWith('document:') || id.length <= 'document:'.length || !keyPattern.test(id)
    || typeof startLine !== 'number' || !Number.isSafeInteger(startLine) || startLine < 1
    || typeof endLine !== 'number' || !Number.isSafeInteger(endLine) || endLine <= startLine
    || typeof heading !== 'string' || !keyPattern.test(heading) || !headingPattern.test(heading)
    || typeof nextHeading !== 'string' || !keyPattern.test(nextHeading) || !headingPattern.test(nextHeading))
    return workspaceError(400,'请提供有效的文档标识、章节行号和标题')
  return { people:[...people].sort() as string[], document:{id,startLine,endLine,heading,nextHeading} }
}

function omitSection(body: string, doc: DocumentSection) {
  const lines = body.split(/(?<=\n)/)
  const start = doc.startLine - 1, end = doc.endLine - 1
  const depth = headingPattern.exec(doc.heading)![1]!.length
  if (lines[start]?.replace(/\r?\n$/,'') !== doc.heading || lines[end]?.replace(/\r?\n$/,'') !== doc.nextHeading
    || headingPattern.exec(doc.nextHeading)![1]!.length > depth)
    return workspaceError(409,'文档章节边界已变化，请重新核对')

  let fence: string | undefined
  for (let i = 0; i <= end; i++) {
    const line = lines[i]!.replace(/\r?\n$/,'')
    if ((i === start || i === end) && fence) return workspaceError(409,'指定标题位于代码围栏内，请核对章节边界')
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      const run = marker[1]!
      if (!fence) fence = run
      else if (run[0] === fence[0] && run.length >= fence.length && !marker[2]!.trim()) fence = undefined
    }
    const nested = !fence && i > start && i < end ? headingPattern.exec(line.trimStart()) : undefined
    if (nested && nested[1]!.length <= depth) return workspaceError(409,'指定范围内另有同级章节，请核对边界')
  }
  return lines.slice(0,start).join('') + lines.slice(end).join('')
}

function planCleanup(store: WorkspaceHistoryStore, index: HistoryIndex, request: CleanupRequest) {
  if (index.cleanup?.last.pendingObjects.length) return workspaceError(409,'上次清理对象尚未回收，请用原清单继续')
  const entries = { ...index.entries }
  const removed: HistorySnapshot[] = []
  for (const id of request.people) {
    const row = entries[id]
    if (!visibleHistorySnapshot(row) || row.item.kind !== 'person') return workspaceError(409,'人物快照已变化，请重新核对清理范围')
    removed.push(row)
    delete entries[id]
  }
  let replacement: { text: string; digest: string; sourceBody: string } | undefined
  if (request.document) {
    const row = entries[request.document.id]
    if (!visibleHistorySnapshot(row) || row.item.kind !== 'document' || index.cleanup?.documents[request.document.id])
      return workspaceError(409,'文档快照已变化或已经过清理，请重新核对')
    const detail = store.detail(row)
    if (typeof detail.body !== 'string') return workspaceError(409,'文档快照正文不可用，请重新核对')
    const text = JSON.stringify({ ...detail, body:omitSection(detail.body,request.document) })
    const digest = historyDigest(text)
    replacement = { text,digest,sourceBody:historyDigest(detail.body) }
    removed.push(row)
    entries[request.document.id] = { ...row, detail:digest }
  }
  const targets = historyObjectReferences(removed)
  const retained = historyObjectReferences(Object.values(entries))
  for (const document of Object.values(index.cleanup?.documents ?? {})) retained.add(document.detail)
  store.verifyObjects(targets)
  const pendingObjects = [...targets].filter(digest => !retained.has(digest))
  const previewId = workspaceFingerprint({ index,request })
  return { entries,replacement,pendingObjects,previewId }
}

export function historyPersonExcluded(index: HistoryIndex, id: string) {
  return id.startsWith('person:') && index.cleanup?.people.includes(signed(index.cleanup.key,id)) === true
}

export function cleanupHistory(store: WorkspaceHistoryStore, body: Record<string, unknown>, apply: boolean) {
  const request = parseCleanup(body)
  if (apply && (typeof body.previewId !== 'string' || !historyDigestPattern.test(body.previewId)))
    return workspaceError(400,'请提供清理预览标识')
  const index = store.load()
  const prior = index.cleanup
  const requestText = JSON.stringify(request)
  const report = (receipt: Omit<HistoryCleanupState['last'],'requestDigest'|'pendingObjects'>) => ({
    scope:index.scope, previewId:receipt.previewId, removedPeople:receipt.removedPeople,
    editedDocuments:receipt.editedDocuments, objectsToPurge:receipt.objectsToPurge,
  })
  if (apply && prior && prior.last.previewId === body.previewId) {
    if (prior.last.requestDigest !== signed(prior.key,requestText)) return workspaceError(409,'清理请求与原预览不一致，请重新核对')
    store.finishCleanup(index)
    return { ...report(prior.last), applied:true, purgedObjects:prior.last.objectsToPurge }
  }
  const plan = planCleanup(store,index,request)
  const summary = { previewId:plan.previewId, removedPeople:request.people.length,
    editedDocuments:Number(!!request.document), objectsToPurge:plan.pendingObjects.length }
  if (!apply) return report(summary)
  if (body.previewId !== plan.previewId) return workspaceError(409,'清理预览已变化，请重新预览')

  const key = prior?.key ?? randomBytes(32).toString('hex')
  const documents = { ...prior?.documents }
  if (request.document && plan.replacement) documents[request.document.id] = {
    sourceBody:plan.replacement.sourceBody, detail:plan.replacement.digest,
  }
  const cleanup: HistoryCleanupState = {
    key,
    people:[...new Set([...(prior?.people ?? []),...request.people.map(id => signed(key,id))])],
    documents,
    last:{ ...summary, requestDigest:signed(key,requestText), pendingObjects:plan.pendingObjects },
  }
  const next = { ...index, entries:plan.entries,cleanup }
  store.saveCleanup(next,plan.replacement)
  store.finishCleanup(next)
  return { ...report(summary), applied:true, purgedObjects:summary.objectsToPurge }
}
