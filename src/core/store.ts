/**
 * 文件存储：状态就是 brain 仓库 ops/ 下的文件，人和模型都能直接读、grep、git 回滚。
 *
 *   ops/events/YYYY-MM.jsonl     事件，只追加
 *   ops/dispositions.jsonl       事件去向，只追加；同一事件以最后一条为准
 *   ops/tickets/T-0001.json      工单快照，原子替换
 *   ops/ticket-sequence.json    本脑已保留的最大工单编号，清空工单历史时保留
 *
 * 单写者：插件进程内所有写入都经由 Engine 的串行队列，因此这里用同步 IO 保证每次写入完整落盘。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChiefEvent, Disposition, Ticket } from './model.ts'

export interface Store {
  /** 写入事件；同一 dedupe 键已存在时返回 false。 */
  appendEvent(event: ChiefEvent): boolean
  hasDedupe(dedupe: string): boolean
  event(id: string): ChiefEvent | undefined
  /** 最近的事件，新的在前。 */
  recentEvents(limit: number): ChiefEvent[]
  setDisposition(eventId: string, disposition: Disposition): void
  disposition(eventId: string): Disposition | undefined
  /** 去向仍为 pending 的事件，按时间先后。 */
  pendingEvents(): ChiefEvent[]
  saveTicket(ticket: Ticket): void
  onTicketSaved?(listener: (ticket: Ticket) => void): () => void
  ticket(id: string): Ticket | undefined
  tickets(): Ticket[]
  isRetiredTicket?(id: string): boolean
  nextTicketId(): string
}

const month = (iso: string) => iso.slice(0, 7)
const ticketNumber = (id: string) => /^T-\d+$/.test(id) ? Number(id.slice(2)) : 0

export class FileStore implements Store {
  private readonly events = new Map<string, ChiefEvent>()
  private readonly dedupes = new Set<string>()
  private readonly dispositions = new Map<string, Disposition>()
  private readonly ticketMap = new Map<string, Ticket>()
  private readonly retiredTickets = new Set<string>()
  private readonly ticketListeners = new Set<(ticket: Ticket) => void>()
  private ticketCounter = 0

  constructor(private readonly root: string) {
    for (const dir of ['ops/events', 'ops/tickets']) mkdirSync(join(root, dir), { recursive: true })
    this.load()
  }

  private path(...parts: string[]) { return join(this.root, 'ops', ...parts) }

  private appendLine(file: string, value: unknown): void {
    const fd = openSync(file, 'a+')
    try {
      const size = fstatSync(fd).size
      const last = Buffer.alloc(1)
      if (size > 0) readSync(fd, last, 0, 1, size - 1)
      // A prior process may have stopped mid-row. Keep subsequent facts on a separate line.
      appendFileSync(fd, `${size > 0 && last[0] !== 10 ? '\n' : ''}${JSON.stringify(value)}\n`)
    } finally {
      closeSync(fd)
    }
  }

  /** 逐行读取 JSONL；损坏的行（例如断电写了一半）跳过，不让一行坏数据拖垮启动。 */
  private readLines<T>(file: string): T[] {
    if (!existsSync(file)) return []
    const out: T[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line) as T) } catch { /* 跳过损坏的行 */ }
    }
    return out
  }

  private load(): void {
    let highest = 0
    const files = readdirSync(this.path('events')).filter(name => name.endsWith('.jsonl')).sort()
    for (const file of files) {
      for (const event of this.readLines<ChiefEvent>(this.path('events', file))) {
        if (this.events.has(event.id) || this.dedupes.has(event.dedupe)) continue
        this.events.set(event.id, event)
        this.dedupes.add(event.dedupe)
        const retired = event.meta?.retired_ticket
        if (retired && /^T-\d+$/.test(retired)) this.retiredTickets.add(retired)
      }
    }
    for (const row of this.readLines<{ eventId: string; disposition: Disposition }>(this.path('dispositions.jsonl'))) {
      this.dispositions.set(row.eventId, row.disposition)
      if (row.disposition?.kind === 'accepted' || row.disposition?.kind === 'attached')
        highest = Math.max(highest, ticketNumber(row.disposition.ticketId))
    }
    for (const name of readdirSync(this.path('tickets'))) {
      if (!/^T-\d+\.json$/.test(name)) continue
      highest = Math.max(highest, ticketNumber(name.slice(0, -5)))
      try {
        const ticket = JSON.parse(readFileSync(this.path('tickets', name), 'utf8')) as Ticket
        this.ticketMap.set(ticket.id, ticket)
        highest = Math.max(highest, ticketNumber(ticket.id))
      } catch { /* 损坏的工单文件保持原样，等人工处理 */ }
    }
    this.reserveTicketNumber(highest)
  }

  private reserveTicketNumber(minimum?: number): number {
    const file = this.path('ticket-sequence.json')
    let stored = 0
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8').trim()
      stored = Number(raw)
      if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(stored))
        throw new Error('工单编号记录无效，请检查 ops/ticket-sequence.json')
    }
    const current = Math.max(stored, this.ticketCounter)
    const next = minimum === undefined ? current + 1 : Math.max(current, minimum)
    if (!Number.isSafeInteger(next)) throw new Error('工单编号超出安全整数范围')
    if (next > stored) {
      const tmp = file + '.' + randomUUID() + '.tmp'
      try {
        writeFileSync(tmp, String(next) + '\n', { flag: 'wx', mode: 0o600, flush: true })
        renameSync(tmp, file)
        // Persist the reservation before the number can appear in a link or a ticket snapshot.
        if (process.platform !== 'win32') {
          const dir = openSync(this.path(), 'r')
          try { fsyncSync(dir) } finally { closeSync(dir) }
        }
      } finally { rmSync(tmp, { force: true }) }
    }
    this.ticketCounter = next
    return next
  }

  appendEvent(event: ChiefEvent): boolean {
    if (this.events.has(event.id) || this.dedupes.has(event.dedupe)) return false
    this.appendLine(this.path('events', `${month(event.at)}.jsonl`), event)
    this.events.set(event.id, event)
    this.dedupes.add(event.dedupe)
    return true
  }

  hasDedupe(dedupe: string) { return this.dedupes.has(dedupe) }
  event(id: string) { return this.events.get(id) }

  recentEvents(limit: number): ChiefEvent[] {
    return [...this.events.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
  }

  setDisposition(eventId: string, disposition: Disposition): void {
    this.appendLine(this.path('dispositions.jsonl'), { eventId, disposition, at: new Date().toISOString() })
    this.dispositions.set(eventId, disposition)
  }

  disposition(eventId: string) { return this.dispositions.get(eventId) }

  pendingEvents(): ChiefEvent[] {
    return [...this.events.values()]
      .filter(event => (this.dispositions.get(event.id)?.kind ?? 'pending') === 'pending')
      .sort((a, b) => a.at.localeCompare(b.at))
  }

  saveTicket(ticket: Ticket): void {
    const number = ticketNumber(ticket.id)
    if (number > this.ticketCounter) this.reserveTicketNumber(number)
    const file = this.path('tickets', `${ticket.id}.json`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(ticket, null, 2)}\n`)
    renameSync(tmp, file)
    this.ticketMap.set(ticket.id, ticket)
    for (const notify of this.ticketListeners) {
      try { notify(ticket) } catch { /* An observer cannot roll back a saved ticket. */ }
    }
  }

  onTicketSaved(listener: (ticket: Ticket) => void): () => void {
    this.ticketListeners.add(listener)
    return () => { this.ticketListeners.delete(listener) }
  }

  ticket(id: string) { return this.ticketMap.get(id) }
  tickets() { return [...this.ticketMap.values()] }
  isRetiredTicket(id: string) { return this.retiredTickets.has(id) }

  nextTicketId(): string {
    return `T-${String(this.reserveTicketNumber()).padStart(4, '0')}`
  }
}
