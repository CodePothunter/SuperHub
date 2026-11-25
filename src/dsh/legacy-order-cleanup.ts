import { realpathSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import type { ChiefEvent, Disposition, Ticket } from '../core/model.ts'
import { messageWorkOrder, type V2Message, type V2Session } from '../core/workspace-v2.ts'
import type { Notice } from './outbox.ts'
import type { RoomMeta } from './rooms.ts'
import type { SaaRecord } from './superhub-saa.ts'
import type { Discussion } from './discussions.ts'
import { acquireLock } from './lock.ts'
import { workspaceFingerprint } from './superhub-goals.ts'
import { visibleHistorySnapshot, WorkspaceHistoryStore, type HistorySnapshot, type Material } from './workspace-history-store.ts'
import { cleanupLegacyWorkspaceBoard, workspaceBoardFile, workspaceScope } from './workspace-v2-store.ts'
import { dialogueKey } from './workspace-speaker-id.ts'
import { CleanupFiles, cleanupReport, digestOf, finishCleanup, LegacyCleanupPlan, pendingCleanup, savedCleanup } from './legacy-cleanup-transaction.ts'

const ticketId = /^T-\d+$/
const json = (value: unknown) => JSON.stringify(value) + '\n'
const protectedEvent = (event: ChiefEvent, origin: string) => ({
  id:event.id, at:event.at, source:event.source, dedupe:event.dedupe, text:'',
  // Reserve request identity and suppress recovery, including when this event was pending.
  meta:{retired_ticket:origin},
})
interface Journal {
  messages: V2Message[]
  turns: {id: string; workOrderId?: string | null}[]
  attachments: {id: string; content: string}[]
  workRootOrder?: string | null
}
interface DispositionRow { eventId: string; disposition: Disposition }

function document<T>(files: CleanupFiles, path: string): T | undefined {
  const raw = files.read(path)
  return raw && JSON.parse(raw.toString('utf8')) as T
}

function revise<T>(plan: LegacyCleanupPlan, path: string, update: (rows: T) => T) {
  const value = document<T>(plan.files,path)
  if (value === undefined) return
  const original = json(value)
  const next = json(update(value))
  if (original !== next) plan.set(path,next)
}

/** Preserve malformed tails byte for byte, as FileStore does when opening the append-only log. */
function editLines<T>(plan: LegacyCleanupPlan, path: string, update: (row: T) => T | undefined) {
  const raw = plan.files.read(path)?.toString('utf8')
  if (raw === undefined) return
  const next = raw.split('\n').flatMap(line => {
    if (!line.trim()) return [line]
    let value: T
    try { value = JSON.parse(line) as T } catch { return [line] }
    const result = update(value)
    return result === undefined ? [] : [result === value ? line : JSON.stringify(result)]
  }).join('\n')
  if (next !== raw) plan.set(path,next)
}

function removeTree(plan: LegacyCleanupPlan, path: string) {
  for (const entry of plan.files.list(path)) {
    const child = join(path,entry.name)
    if (entry.isDirectory()) removeTree(plan,child)
    else if (entry.isFile()) plan.set(child)
    else plan.preserved.add(child)
  }
  plan.directories.add(path)
}

const sessionDirectory = (scope: string, session: V2Session) => {
  const workspace = dialogueKey(scope, session.workspaceId)
  return [workspace,dialogueKey(workspace,session.id)] as const
}
const dialogueFile = (scope: string, session: V2Session) => join('ops','superhub-v2-dialogues',...sessionDirectory(scope,session),'source.json')

function cleanJournal(plan: LegacyCleanupPlan, session:V2Session, retired:ReadonlySet<string>) {
  const storage = join('ops','superhub-v2-dialogues',...sessionDirectory(plan.scope,session))
  revise<Journal>(plan,join(storage,'source.json'),journal => {
    const removed = journal.messages.filter(message => retired.has(messageWorkOrder(session,message) ?? ''))
    const ids = new Set(removed.map(message => message.id))
    const droppedAttachments = new Set(removed.flatMap(message => message.attachments?.map(file => file.id) ?? []))
    journal.messages = journal.messages.filter(message => !ids.has(message.id))
    for (const message of journal.messages) if (message.replyTo && ids.has(message.replyTo)) delete message.replyTo
    for (const message of journal.messages) for (const file of message.attachments ?? []) droppedAttachments.delete(file.id)
    journal.attachments = journal.attachments.filter(file => !droppedAttachments.has(file.id))
    journal.turns = journal.turns.filter(turn => !retired.has(turn.workOrderId ?? ''))
    return journal
  })
  editLines<{workOrderId?:string}>(plan,join(storage,'commands.jsonl'),row => row?.workOrderId && retired.has(row.workOrderId) ? undefined : row)
}

function archiveHistory(plan: LegacyCleanupPlan) {
  const store = new WorkspaceHistoryStore(plan.files.root,plan.scope)
  const index = store.load(), directory = join('ops','superhub-history-' + workspaceFingerprint(plan.scope))
  const objects = join(directory,'objects')
  const retiredDigests = new Set<string>(), retainedDigests = new Set<string>(), hidden = new Set<string>()
  const remember = (target: Set<string>, row: Pick<HistorySnapshot,'detail'|'files'>) => {
    target.add(row.detail)
    for (const f of row.files) target.add(f.digest)
  }
  for (const [id,row] of Object.entries(index.entries)) {
    if (visibleHistorySnapshot(row)) continue
    // Only native ticket snapshots supply ticket identity. Old pasted text remains in inbox/.
    if (row.item.kind === 'ticket' && ticketId.test(row.item.sourceId) && row.item.id === 'ticket:' + row.item.sourceId)
      plan.ticketIds.add(row.item.sourceId)
    hidden.add(id)
    remember(retiredDigests,row)
    delete index.entries[id]
  }
  let changed = !!hidden.size
  for (const row of Object.values(index.entries).filter(visibleHistorySnapshot)) {
    const detail = store.detail(row)
    const links = detail.links.filter(link => !link.id.startsWith('ticket:') && !hidden.has(link.id))
    if (links.length !== detail.links.length) {
      changed = true
      retiredDigests.add(row.detail)
      const body = JSON.stringify({...detail,links} satisfies Material)
      row.detail = digestOf(body)
      plan.set(join(objects,row.detail),body)
    }
    remember(retainedDigests,row)
  }
  if (changed) {
    if (index.schema !== 2) index.receipts = {}
    index.schema = 2
    plan.set(join(directory,'index.json'),json(index))
  }
  return [...retiredDigests].filter(digest => !retainedDigests.has(digest)).map(digest => join(objects,digest))
}

function drainRemote(plan: LegacyCleanupPlan, retired: ReadonlySet<string>, assignmentIds: Map<string,string>) {
  const directory = join('ops','remote')
  const taskFiles: string[] = []
  for (const stage of ['staged','outbox','taken','inbox','done','rejected','receipts','claims','cancelled']) {
    const folder = join(directory,stage)
    for (const entry of plan.files.list(folder)) {
      if (!entry.isFile() || extname(entry.name) !== '.json') continue
      const path = join(folder,entry.name)
      const row = document<{ticketId?:string;assignmentId?:string}>(plan.files,path)
      const id = row?.ticketId ?? (stage === 'cancelled' ? assignmentIds.get(entry.name.slice(0,-5)) : undefined)
      if (!id || !retired.has(id)) continue
      if (['staged','outbox','taken','inbox'].includes(stage)) plan.blockers.add(`${id} 工作电脑队列 ${stage} 尚未结清`)
      else taskFiles.push(path)
    }
  }
  return taskFiles
}

function retireEvents(plan: LegacyCleanupPlan, tickets: Ticket[], retainedTickets: Ticket[]) {
  const protectedIds = new Set(retainedTickets.flatMap(ticket => [ticket.mandate.eventId, ...ticket.events]))
  const events = new Map(tickets.flatMap(ticket => [ticket.mandate.eventId,...ticket.events].map(id => [id,ticket.id] as const)))
  const roomSources = new Map<string,Set<string>>()
  const path = join('ops','dispositions.jsonl')
  // A disposition may be the only surviving proof of a native ticket's ownership of this event.
  editLines<DispositionRow>(plan,path,row => {
    if (row?.disposition?.kind === 'attached' || row?.disposition?.kind === 'accepted') {
      if (!plan.ticketIds.has(row.disposition.ticketId)) protectedIds.add(row.eventId)
      else events.set(row.eventId,row.disposition.ticketId)
    }
    return row
  })
  for (const id of protectedIds) events.delete(id)
  for (const entry of plan.files.list(join('ops','events'))) {
    if (!entry.isFile() || extname(entry.name) !== '.jsonl') continue
    editLines<ChiefEvent>(plan,join('ops','events',entry.name),event => {
      const id = event?.id
      if (!id || protectedIds.has(id)) return event
      const origin = events.get(id) ?? (event.ticketId && plan.ticketIds.has(event.ticketId) ? event.ticketId : undefined)
      if (!origin) return event
      events.set(id,origin)
      const room = event.meta?.room_id, source = event.meta?.room_source
      if (room && source) {
        const sources = roomSources.get(room) ?? new Set()
        sources.add(source)
        roomSources.set(room,sources)
      }
      return protectedEvent(event,origin)
    })
  }
  const raw = plan.files.read(path)?.toString('utf8') ?? ''
  const rows = raw.split('\n').filter(line => {
    try {
      const row = JSON.parse(line) as DispositionRow
      if (events.has(row.eventId)) return false
      if ((row.disposition.kind === 'accepted' || row.disposition.kind === 'attached') && plan.ticketIds.has(row.disposition.ticketId)) return false
    } catch { /* Preserve malformed tails and unrelated rows. */ }
    return true
  }).join('\n')
  if (events.size || rows !== raw) {
    const terminal = [...events].sort(([a],[b]) => a.localeCompare(b)).map(([eventId]) => json({
      eventId, disposition:{kind:'ignored',reason:'原工单已清理'},
    } satisfies DispositionRow)).join('')
    plan.set(path,rows + (rows && !rows.endsWith('\n') ? '\n' : '') + terminal)
  }
  return {events,roomSources}
}

function buildPlan(files: CleanupFiles, scope: string) {
  const plan = new LegacyCleanupPlan(files,scope)
  const boardPath = workspaceBoardFile(scope)
  const boardRaw = files.read(boardPath)?.toString('utf8')
  let liveBoard = boardRaw ?? ''
  if (boardRaw) {
    const original = cleanupLegacyWorkspaceBoard(boardRaw,scope,new Set())
    const retained = new Set<string>()
    const retiredOrderIds = new Set(original.retired.orders.map(row => row.id))
    for (const session of original.retired.sessions) {
      const journal = document<Journal>(files,dialogueFile(scope,session))
      if (journal?.messages.some(row => !retiredOrderIds.has(messageWorkOrder(session,row) ?? '')) ||
        journal?.turns.some(row => !retiredOrderIds.has(row.workOrderId ?? ''))) retained.add(session.id)
    }
    const board = retained.size ? cleanupLegacyWorkspaceBoard(boardRaw,scope,retained) : original
    for (const order of board.retired.orders) if (ticketId.test(order.legacyTicketId)) plan.ticketIds.add(order.legacyTicketId)
    if (board.text) {
      liveBoard = board.text
      const sessionSources = new Map(board.sources.map(session => [session.id,session]))
      for (const session of board.sessions) cleanJournal(plan,sessionSources.get(session.id) ?? session,retiredOrderIds)
      plan.set(boardPath,board.text)
      for (const session of board.retired.sessions) {
        const parts = sessionDirectory(scope,session)
        removeTree(plan,join('ops','superhub-v2-dialogues',...parts))
        removeTree(plan,join('work','superhub-v2',...parts))
      }
    }
  }
  const retiredObjects = archiveHistory(plan)
  const old: Ticket[] = [], other: Ticket[] = []
  const assignments = new Map<string,string>()
  for (const entry of files.list(join('ops','tickets'))) {
    if (!entry.isFile() || extname(entry.name) !== '.json' || !ticketId.test(entry.name.slice(0,-5))) continue
    const path = join('ops','tickets',entry.name)
    const ticket = document<Ticket>(files,path)
    if (!ticket || ticket.id + '.json' !== entry.name || !ticket.mandate?.eventId || !Array.isArray(ticket.events) || !Array.isArray(ticket.assignments)) {
      throw new Error(`无法确认原工单来源 ${entry.name}`)
    }
    if (ticket.superhub && ticket.superhub.brainScope !== scope) {
      plan.ticketIds.delete(ticket.id)
      other.push(ticket)
      plan.preserved.add(path)
      continue
    }
    old.push(ticket)
    plan.ticketIds.add(ticket.id)
    for (const assignment of ticket.assignments) {
      assignments.set(assignment.id,ticket.id)
      if (!ticket.ended && (assignment.state === 'running' || assignment.attempts?.some(attempt => attempt.status === 'running'))) {
        plan.blockers.add(`${ticket.id} 仍有执行中的派工`)
      }
    }
  }
  if (!plan.ticketIds.size) {
    for (const path of retiredObjects) plan.set(path)
    return plan
  }
  const retired = plan.ticketIds
  const {events:retiredEvents,roomSources} = retireEvents(plan,old,other)
  const sequenceFile = join('ops','ticket-sequence.json')
  const rawSequence = files.read(sequenceFile)?.toString('utf8').trim() ?? '0'
  if (!/^(0|[1-9]\d*)$/.test(rawSequence) || !Number.isSafeInteger(Number(rawSequence))) throw new Error('工单编号记录无效')
  const highest = Math.max(Number(rawSequence),...[...retired].map(id => Number(id.slice(2))))
  if (!Number.isSafeInteger(highest)) throw new Error('旧工单编号超出安全整数范围')
  if (highest > Number(rawSequence)) plan.set(sequenceFile,String(highest) + '\n')
  revise<Notice[]>(plan,join('ops','outbox.json'),rows => rows.filter(row =>
    !retired.has(row.ticketId ?? '') && !assignments.has(row.assignmentId ?? '')
    && !((row.key.startsWith('need:') || row.key.startsWith('result:')) && retired.has(row.key.split(':')[1] ?? ''))
    && !(row.key.startsWith('stuck:') && retiredEvents.has(row.key.slice('stuck:'.length)))))
  const detachRoom = (room: RoomMeta) => {
    if (room.tickets) room.tickets = room.tickets.filter(id => !retired.has(id))
    for (const action of room.ownerActions ?? []) {
      const removed = action.ticketId && retired.has(action.ticketId)
      if (removed) delete action.ticketId
      if (action.kind === 'execute' && (removed || action.source && roomSources.get(room.id)?.has(action.source))) action.answered = true
    }
    return room
  }
  revise<RoomMeta[]>(plan,join('ops','room-index.json'),rows => rows.map(detachRoom))
  for (const entry of files.list(join('ops','rooms'))) {
    if (entry.isFile() && /^[a-zA-Z0-9_-]{1,120}\.json$/.test(entry.name))
      revise<RoomMeta>(plan,join('ops','rooms',entry.name),detachRoom)
  }
  for (const entry of files.list(join('ops','worklines'))) {
    if (entry.isFile() && extname(entry.name) === '.json') {
      revise<{tickets:string[]; deliveries:{ticketId:string}[]}>(plan,join('ops','worklines',entry.name),row => ({
        ...row,tickets:row.tickets.filter(id => !retired.has(id)),deliveries:row.deliveries.filter(file => !retired.has(file.ticketId)),
      }))
    }
  }
  revise<{records:SaaRecord[]}>(plan,join('ops','superhub-saa.json'),value => {
    for (const record of value.records) {
      record.tickets = record.tickets.filter(id => !retired.has(id))
      record.references = record.references.filter(ref => !retired.has(ref.ticketId))
    }
    return value
  })
  const remoteFiles = drainRemote(plan,retired,assignments)
  const sourceReferences = [liveBoard, ...other.map(json), files.read('goals.superhub.json')?.toString('utf8') ?? '']
  // Delivery discussions are independent records. Their immutable document and any referenced file are retained.
  for (const entry of files.list(join('ops','discussions'))) {
    if (!entry.isFile() || extname(entry.name) !== '.json') continue
    const path = join('ops','discussions',entry.name)
    revise<Discussion>(plan,path,row => {
      if (retired.has(row.document?.ticketId ?? '') && row.remoteTurns?.some(turn => turn.state === 'waiting' || turn.state === 'verifying')) {
        plan.blockers.add(`${row.document.ticketId} 工作端交付讨论尚未结清`)
      }
      if (row.followUp && retired.has(row.followUp)) delete row.followUp
      sourceReferences.push(json(row))
      return row
    })
  }
  for (const ticket of old) plan.set(join('ops','tickets',ticket.id + '.json'))
  for (const id of retired) {
    const work = join('work',id), deliveries = join('ops','delivery-versions',id)
    const cited = sourceReferences.some(raw => raw.includes('work/' + id + '/') || raw.includes('work\\\\' + id + '\\\\') ||
      raw.includes('"ticketId":"' + id + '"') || raw.includes('"ticketId": "' + id + '"'))
    if (cited) {
      if (files.list(work).length) plan.preserved.add(work)
      if (files.list(deliveries).length) plan.preserved.add(deliveries)
    } else {
      removeTree(plan,work)
      removeTree(plan,deliveries)
    }
  }
  for (const path of [...retiredObjects,...remoteFiles]) plan.set(path)
  return plan
}

/** Run offline against one explicitly selected Second Brain. Preview and apply share the same manifest. */
export function cleanupLegacyOrders(brain: string, apply?: string, checkpoint?: (path: string) => void) {
  const root = realpathSync(brain), files = new CleanupFiles(root), scope = workspaceScope(root)
  // Reject redirected ops or lock paths before acquiring the runtime's lock.
  files.location(join('ops','.chief.lock'))
  const unlock = acquireLock(root,true)
  try {
    const pending = pendingCleanup(files)
    if (pending) {
      if (apply && apply !== pending) throw new Error('已有清理正在进行，请使用原清单重试。')
      const saved = savedCleanup(files,pending,scope)
      if (!saved) throw new Error('清理进度缺少对应备份。')
      return apply ? finishCleanup(files,pending,saved,checkpoint) : cleanupReport(saved.manifest,pending)
    }
    if (apply) {
      const prior = savedCleanup(files,apply,scope)
      if (prior?.complete) return finishCleanup(files,apply,prior)
    }
    const plan = buildPlan(files,scope)
    if (!apply) return cleanupReport(plan.manifest)
    plan.prepare(apply)
    return finishCleanup(files,apply,savedCleanup(files,apply,scope)!,checkpoint)
  } finally {
    unlock()
  }
}
