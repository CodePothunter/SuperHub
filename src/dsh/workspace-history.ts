import { HISTORY_KINDS, type HistoryDetail, type HistoryImport, type HistoryItem, type HistoryKind, type HistoryList } from '../core/workspace-history.ts'
import { json, type Route } from './http.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import { currentPeopleSources, historySources, type HistoryDependencies, type HistorySource } from './workspace-history-sources.ts'
import { historyDigest, materialize, visibleHistorySnapshot, WorkspaceHistoryStore, type HistoryIndex, type HistorySnapshot } from './workspace-history-store.ts'
import { cleanupHistory, historyPersonExcluded } from './workspace-history-cleanup.ts'
import { registerSpeakers } from '../core/workspace-avatars.ts'

function numberOption(params: URLSearchParams, name: string, fallback: number, min: number, max: number) {
  const raw = params.get(name)
  if (raw === null) return fallback
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) workspaceError(400, '资料分页参数无效')
  return n
}

function personOrder(a: HistoryItem, b: HistoryItem) {
  const left = a.person?.organization, right = b.person?.organization
  if (!!left !== !!right) return left ? -1 : 1
  const rank = { high:0, mid:1, low:2 }
  const importance = (row: HistoryItem) => row.person?.influence ? rank[row.person.influence] : 3
  return (left ?? '').localeCompare(right ?? '','zh-CN') || importance(a) - importance(b)
}

export function workspaceHistoryRoutes(deps: HistoryDependencies): Route & { personName(id:string):string|undefined; personDetail(id:string):Promise<HistoryDetail>; dispose(): void } {
  const { scope } = deps
  const store = new WorkspaceHistoryStore(deps.brain.root,scope)
  let disposed = false
  let updating: Promise<void> = Promise.resolve()
  const current = () => { if (disposed) workspaceError(409,'第二大脑已切换，请重新打开资料') }

  function update<T>(run: () => T | Promise<T>) {
    const next = updating.then(() => { current(); return run() })
    updating = next.then(() => {}, () => {})
    return next
  }

  function importableSources(index: HistoryIndex) {
    const sources = historySources(deps)
    for (const sourceId of sources.keys()) if (historyPersonExcluded(index,sourceId)) sources.delete(sourceId)
    return sources
  }

  async function capture(id: string) {
    const index = store.load(), key = 'req-' + id
    store.finishCleanup(index)
    // Receipts produced with the old catalog counted a different set of sources.
    if (index.schema === 1) {
      index.schema = 2
      index.receipts = {}
    }
    if (index.receipts[key]) return index.receipts[key]!
    const sources = importableSources(index)
    store.prepare()
    const receipt: HistoryImport = { scope,added:0,updated:0,unchanged:0,total:0,importedAt:new Date().toISOString() }
    for (const [sourceId, source] of sources) {
      const previous = index.entries[sourceId]
      const protectedDocument = index.cleanup?.documents[sourceId]
      if (protectedDocument) {
        if (!visibleHistorySnapshot(previous) || previous.detail !== protectedDocument.detail)
          return workspaceError(503,'清理后的文档版本不匹配，请核对资料库索引')
        const candidate = await Promise.resolve().then(() => source.detail()).catch(() => undefined)
        current()
        if (typeof candidate?.body !== 'string' || historyDigest(candidate.body) !== protectedDocument.sourceBody)
          receipt.incomplete = (receipt.incomplete ?? 0) + 1
        receipt.unchanged++
        continue
      }
      const { row, incomplete } = await store.capture(source,visibleHistorySnapshot(previous) ? previous : undefined,current)
      if (incomplete) receipt.incomplete = (receipt.incomplete ?? 0) + 1
      if (!previous) receipt.added++
      else if (workspaceFingerprint(previous) !== workspaceFingerprint(row)) receipt.updated++
      else receipt.unchanged++
      index.entries[sourceId] = row
    }
    current()
    receipt.total = Object.values(index.entries).filter(visibleHistorySnapshot).length
    if (receipt.total > sources.size) receipt.retained = receipt.total - sources.size
    index.importedAt = receipt.importedAt
    index.receipts[key] = receipt
    store.save(index)
    return receipt
  }
  function importHistory(id: unknown) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return workspaceError(400,'请提供有效的导入请求标识')
    return update(() => capture(id))
  }
  function list(index: HistoryIndex, params: URLSearchParams): HistoryList {
    const kind = params.get('kind')
    if (kind !== null && !HISTORY_KINDS.includes(kind as HistoryKind)) workspaceError(400,'资料类型无效')
    const offset = numberOption(params,'offset',0,0,Number.MAX_SAFE_INTEGER)
    const limit = numberOption(params,'limit',50,1,100)
    const counts: Record<HistoryKind,number> = { room:0,person:0,commitment:0,line:0,meeting:0,project:0,goal:0,document:0 }
    const items = Object.values(index.entries).filter(visibleHistorySnapshot).map(row => row.item)
    for (const row of items) counts[row.kind]++
    const matches = items.filter(row => !kind || row.kind === kind)
      .sort((a,b) => (kind === 'person' ? personOrder(a,b) : (b.at ?? '').localeCompare(a.at ?? ''))
        || a.title.localeCompare(b.title,'zh-CN') || a.id.localeCompare(b.id))
    let available = 0, sourceIssue: string | undefined
    try { available = importableSources(index).size } catch { sourceIssue = '暂时无法核对原资料。已导入的内容仍可打开。' }
    return { scope,available,total:items.length,counts,items:matches.slice(offset,offset+limit),importedAt:index.importedAt,sourceIssue,
      ...offset+limit < matches.length ? { nextOffset:offset+limit } : {} }
  }
  function personEntries(onlyId?: string) {
    // The same person keeps the original identity after an import, edit or move.
    const entries = new Map<string, { item: HistoryItem; live: HistorySource } | { item: HistoryItem; snapshot: HistorySnapshot }>()
    const issues: string[] = []
    try {
      const imported = store.load().entries
      for (const snapshot of onlyId ? [imported[onlyId]] : Object.values(imported)) {
        if (visibleHistorySnapshot(snapshot) && snapshot.item.kind === 'person') entries.set(snapshot.item.id,{ item:snapshot.item, snapshot })
      }
    } catch { issues.push('暂时无法读取已导入的人物。') }
    try {
      for (const live of currentPeopleSources(deps,undefined,onlyId)) entries.set(live.item.id,{ item:live.item, live })
    } catch { issues.push('暂时无法核对当前花名册。') }
    return {entries,issues}
  }
  function personName(id:string) {
    if (disposed || !id.startsWith('person:')) return undefined
    return personEntries(id).entries.get(id)?.item.title
  }
  function people() {
    const {entries,issues} = personEntries()
    const issue = issues.join('')
    if (issues.length === 2) return workspaceError(503,issue)
    const items = Array.from(entries.values(),row => row.item).sort((a,b) =>
      personOrder(a,b) || a.title.localeCompare(b.title,'zh-CN') || a.id.localeCompare(b.id))
    return { scope, items, issue:issue || undefined }
  }
  async function personDetail(id: string): Promise<HistoryDetail> {
    current()
    if (!id.startsWith('person:')) return workspaceError(404,'当前人物名册没有这份档案')
    const {entries,issues} = personEntries(id)
    const issue = issues.join('')
    const row = entries.get(id)
    if (!row) return workspaceError(issue ? 503 : 404,issue || '当前人物名册没有这份档案')
    const detail = 'live' in row ? materialize(await row.live.detail()) : store.detail(row.snapshot)
    current()
    const links = detail.links.filter(link => personEntries(link.id).entries.has(link.id))
    const unlinkedRelations = detail.links.filter(link => link.id.startsWith('person:') && !links.includes(link)).map(link => link.label)
    return { scope, item:row.item, ...detail, body:[detail.body,...unlinkedRelations].filter(Boolean).join('\n\n'),
      origin:'live' in row ? 'roster' : 'import',
      issue:[detail.issue,issue].filter(Boolean).join(' ') || undefined, links }
  }
  const route: Route = async ({method,seg,url,owner,body}, res) => {
    if (seg[0] !== 'v2' || (seg[1] !== 'history' && seg[1] !== 'people')) return false
    if (owner !== true) workspaceError(403,'需要主人权限才能读取历史资料')
    current()
    if (url.searchParams.get('scope') !== scope || body.scope !== undefined && body.scope !== scope) workspaceError(409,'第二大脑已切换，请重新打开资料')
    const send = (result: object) => { current(); json(res,200,result); return true }
    if (seg[1] === 'people') {
      if (method !== 'GET' || seg.length > 3) return workspaceError(404,'没有这个人物操作')
      return send(seg[2] ? await personDetail(seg[2]) : people())
    }
    if (method === 'POST' && seg.length === 3 && seg[2] === 'import') return send(await importHistory(body.requestId))
    if (method === 'POST' && seg.length === 4 && seg[2] === 'cleanup' && (seg[3] === 'preview' || seg[3] === 'apply'))
      return send(await update(() => cleanupHistory(store,body,seg[3] === 'apply')))
    if (method !== 'GET') return workspaceError(404,'没有这个历史资料操作')
    const index = store.load()
    if (seg.length === 2) return send(list(index,url.searchParams))
    const id = seg[2]!
    if (id.startsWith('ticket:')) return workspaceError(404,'这张工单已不可用。')
    const saved = Object.hasOwn(index.entries,id) ? index.entries[id] : undefined
    const archived = visibleHistorySnapshot(saved) ? saved : undefined
    // New liaison discussion receipts can open before a snapshot has been taken.
    const live = !archived && id.startsWith('room:') ? historySources(deps).get(id) : undefined
    const item = archived?.item ?? live?.item
    if (!item) return workspaceError(404,'当前资料库没有这条记录')
    if (seg.length === 3) {
      const detail = archived ? store.detail(archived) : materialize(await live!.detail())
      const speakers = detail.messages.flatMap(m=>m.speakerId ? [m.speakerId] : [])
      const portraits = item.kind === 'room' ? {...registerSpeakers(detail.portraits ?? {},speakers),...deps.rooms.knownPortraits?.(speakers)} : undefined
      return send({ scope,item,...detail,...portraits && {portraits},links:detail.links.filter(link =>
        visibleHistorySnapshot(index.entries[link.id]) || link.id.startsWith('room:')) })
    }
    if (seg.length === 5 && seg[3] === 'attachments') {
      const attachment = archived ? store.attachment(archived,seg[4]!) : live!.attachment?.(seg[4]!)
      if (!attachment) return workspaceError(404,'原记录中找不到这份可读的交付')
      return send({ scope,attachment })
    }
    return workspaceError(404,'没有这个历史资料操作')
  }
  return Object.assign(route,{ personName,personDetail,dispose() { disposed = true } })
}
