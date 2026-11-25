/**
 * POC 态势：把花名册（人物、横向线、承诺、会议）汇成作战台和简报用的一份视图。
 */
import type { Engine } from '../core/engine.ts'
import { daysBetween, dueState, type Commitment, type DueState, type Line, type Meeting, type Person } from '../core/poc.ts'
import type { Roster } from './roster.ts'

export interface PersonRow extends Omit<Person, 'facts' | 'log' | 'profile'> {
  /** 距最近一次互动的天数；从未互动为 undefined。 */
  daysSince?: number
  lines: string[]
  /** 未结承诺：我欠他的、他欠我的；以及其中已到期的数量。 */
  owe: number
  owed: number
  due: number
}

export interface LineRow extends Omit<Line, 'log' | 'background'> {
  lastProgress?: string
  open: number
  /** 距下次对齐的天数（负数表示已过）。 */
  syncIn?: number
}

export interface CommitmentRow extends Commitment { dueState: DueState; dueIn?: number }
export interface MeetingRow extends Meeting { past: boolean; today: boolean; prepTicket?: string; needsNotes: boolean }

export interface PocState {
  today: string
  people: PersonRow[]
  lines: LineRow[]
  ledger: CommitmentRow[]
  closed: CommitmentRow[]
  meetings: MeetingRow[]
  situation: { decide: number; overdue: number; dueToday: number; blocked: number; meetingsToday: number; stale: number }
}

/** 多久没联系算"该联系了"：影响力高的 14 天，其余 30 天。 */
const staleAfter = (p: Person) => p.influence === 'high' ? 14 : 30
const DUE_ORDER: Record<DueState, number> = { overdue: 0, today: 1, soon: 2, later: 3, none: 4 }

export function pocState(roster: Roster, engine: Engine, clock: { today: string; now: string }, decide: number): PocState {
  const { today, now } = clock
  const lines = roster.lines()
  const open = roster.ledger().filter(c => c.status === 'open')
  const row = (c: Commitment): CommitmentRow => ({ ...c, dueState: dueState(c.due, today), ...c.due ? { dueIn: daysBetween(today, c.due) } : {} })
  const ledger = open.map(row).sort((a, b) => DUE_ORDER[a.dueState] - DUE_ORDER[b.dueState] || (a.due ?? '9').localeCompare(b.due ?? '9'))
  const isDue = (c: CommitmentRow) => c.dueState === 'overdue' || c.dueState === 'today'

  const people: PersonRow[] = roster.people().map(p => {
    const { facts: _f, log: _l, profile: _p, ...rest } = p
    const mine = ledger.filter(c => c.who === p.id || c.who === p.name)
    return {
      ...rest,
      ...p.lastContact ? { daysSince: daysBetween(p.lastContact, today) } : {},
      lines: lines.filter(l => l.partners.includes(p.id)).map(l => l.id),
      owe: mine.filter(c => c.direction === 'mine').length, owed: mine.filter(c => c.direction === 'theirs').length,
      due: mine.filter(isDue).length,
    }
  })
  const stale = roster.people().filter(p => !p.lastContact || daysBetween(p.lastContact, today) > staleAfter(p)).length

  const prep = new Map<string, string>()
  for (const { event, disposition } of engine.recentEvents(400)) {
    const meeting = event.meta?.meeting
    if (meeting && event.meta?.purpose === 'prep' && disposition && 'ticketId' in disposition && !prep.has(meeting)) prep.set(meeting, disposition.ticketId)
  }
  const meetings: MeetingRow[] = roster.meetings().map(m => {
    const past = m.at < now
    return { ...m, past, today: m.at.slice(0, 10) === today, needsNotes: past && !m.notes, ...prep.get(m.id) ? { prepTicket: prep.get(m.id)! } : {} }
  }).filter(m => !m.past || daysBetween(m.at.slice(0, 10), today) <= 7)
    .sort((a, b) => a.at.localeCompare(b.at))

  return {
    today, people,
    lines: lines.map(l => {
      const { log, background: _b, ...rest } = l
      return { ...rest, ...log[0] ? { lastProgress: log[0] } : {}, open: ledger.filter(c => c.line === l.id).length, ...l.nextSync ? { syncIn: daysBetween(today, l.nextSync) } : {} }
    }),
    ledger,
    closed: roster.ledger().filter(c => c.status !== 'open').sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '')).slice(0, 8).map(row),
    meetings,
    situation: {
      decide, overdue: ledger.filter(c => c.dueState === 'overdue').length, dueToday: ledger.filter(c => c.dueState === 'today').length,
      blocked: lines.filter(l => l.blocker || l.health === 'red').length, meetingsToday: meetings.filter(m => m.today && !m.past).length, stale,
    },
  }
}

/** 给模型和简报用的一句话态势。 */
export function situationText(s: PocState['situation']): string {
  const parts = [
    s.decide ? `${s.decide} 件事等你决定` : '', s.overdue ? `${s.overdue} 个承诺已逾期` : '', s.dueToday ? `${s.dueToday} 个承诺今天到期` : '',
    s.blocked ? `${s.blocked} 条横向线受阻` : '', s.meetingsToday ? `今天还有 ${s.meetingsToday} 场会` : '', s.stale ? `${s.stale} 位干系人该联系了` : '',
  ].filter(Boolean)
  return parts.length ? `${parts.join('，')}。` : '今天没有需要你处理的事。'
}
