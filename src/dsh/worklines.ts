/** Explicit, additive associations on existing cross-functional lines. No historical inference. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Engine } from '../core/engine.ts'
import { assertId } from '../core/poc.ts'
import type { BrainRepo } from './brain.ts'
import { deliveryDocument } from './discussions.ts'
import type { Roster } from './roster.ts'

interface LineLinks { tickets: string[]; decisions: { id: string; text: string; confirmedAt: string }[]; deliveries: { ticketId: string; path: string; version: string; summary: string; linkedAt: string }[] }
export class Worklines {
  private readonly dir: string
  constructor(private readonly engine: Engine, private readonly brain: BrainRepo, private readonly roster: Roster) { this.dir = join(brain.root, 'ops', 'worklines'); mkdirSync(this.dir, { recursive: true }) }
  private read(id: string): LineLinks {
    assertId(id, '横向线')
    if (!this.roster.line(id)) throw new Error('没有这条横向线')
    const path = join(this.dir, `${id}.json`)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as LineLinks : { tickets: [], decisions: [], deliveries: [] }
  }
  private save(id: string, data: LineLinks) { const file = join(this.dir, `${id}.json`); writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2)); renameSync(`${file}.tmp`, file); this.brain.commit(`横向线 ${id}: 显式关联与确认`) }
  link(id: string, ticketId: string, path?: string) {
    const data = this.read(id)
    if (!this.engine.views().some(v => v.ticket.id === ticketId)) throw new Error('没有这张工单')
    if (!data.tickets.includes(ticketId)) data.tickets.push(ticketId)
    if (path) {
      const d = deliveryDocument(this.engine, this.brain, ticketId, path)
      if (!data.deliveries.some(x => x.ticketId === ticketId && x.path === path && x.version === d.version)) data.deliveries.push({ ticketId, path, version: d.version, summary: d.summary, linkedAt: new Date().toISOString() })
    }
    this.save(id, data)
  }
  confirm(id: string, text: string) {
    if (!text.trim()) throw new Error('决定不能为空')
    const data = this.read(id)
    data.decisions.push({ id: randomUUID(), text: text.trim().slice(0, 4000), confirmedAt: new Date().toISOString() }); this.save(id, data)
  }
  view(id: string) {
    const data = this.read(id)
    const tickets = this.engine.views().filter(v => v.ticket.lineId === id || data.tickets.includes(v.ticket.id)).map(v => ({ id: v.ticket.id, title: v.ticket.title, staff: v.ticket.staff, stage: v.stage, parent: v.ticket.parent?.ticketId, summary: v.ticket.assignments.at(-1)?.report?.summary, outputs: v.ticket.assignments.at(-1)?.report?.outputs ?? [], ended: v.ticket.ended }))
    const evidence = [...data.deliveries]
    for (const t of tickets) for (const path of t.outputs) {
      try { const d = deliveryDocument(this.engine, this.brain, t.id, path); if (!evidence.some(e => e.path === d.path && e.version === d.version)) evidence.push({ ticketId: t.id, path: d.path, version: d.version, summary: d.summary, linkedAt: this.engine.views().find(v => v.ticket.id === t.id)!.ticket.assignments.at(-1)!.endedAt ?? '' }) } catch { /* Unregistered/outside-workspace artifacts stay in the source ticket. */ }
    }
    return { ...this.roster.line(id)!, decisions: data.decisions, tickets, evidence: evidence.sort((a, b) => b.linkedAt.localeCompare(a.linkedAt)), commitments: this.roster.ledger().filter(c => c.line === id), waiting: tickets.filter(t => !t.ended), needsDecision: tickets.filter(t => t.stage.startsWith('you/')) }
  }
}
export type WorklineView = ReturnType<Worklines['view']>
