import { slotKey } from '../core/clock.ts'
import { mondayOf } from '../core/workspace-calendar.ts'
import { reportFromText } from '../core/report.ts'
import type { CommitmentSource, DueState, WeeklyReport } from '../core/workspace-followup.ts'
import type { V2Delegation, V2Message } from '../core/workspace-v2.ts'
import type { StoredCommitment } from './workspace-followup.ts'

export function localWeek(instant: Date, timeZone: string) {
  return mondayOf(slotKey(instant, timeZone).slice(0, 10))
}

export function dueState(row: StoredCommitment, now: Date, timeZone: string): DueState {
  if (row.resolvedAt && row.resolvedAt <= now.toISOString()) return 'resolved'
  if (!row.dueAt) return 'unscheduled'
  const today = slotKey(now, timeZone).slice(0, 10)
  const day = row.dueAt.length === 10 ? row.dueAt : slotKey(new Date(row.dueAt), timeZone).slice(0, 10)
  if (day < today || row.dueAt.length > 10 && Date.parse(row.dueAt) < now.getTime()) return 'overdue'
  return day === today ? 'today' : 'upcoming'
}

/** Keep prose and titles in their existing Markdown paragraphs, including user-authored punctuation. */
function inline(value: string, limit: number) {
  const plain = value.trim().replace(/\s+/g, ' ')
  return (plain.length > limit ? plain.slice(0, limit) + '…' : plain).replace(/[\\`*_{}\[\]<>#|]/g, '\\$&')
}

const direction = { mine: '我方承诺', theirs: '对方承诺', request: '待回应请求' }
const timeLabel = (at: string, timeZone: string) => slotKey(new Date(at), timeZone).replace('T', ' ')
const dueLabel = (dueAt: string, timeZone: string) => dueAt.length === 10 ? dueAt : timeLabel(dueAt, timeZone)

function deliveryExcerpt(text: string) {
  const report = text.includes('```chief-report') ? reportFromText(text) : undefined
  const words = (report?.structured ? report.summary : text)
    .replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1[ \t]*\r?$/gm, '')
    .replace(/\[([^\]\n]+)\]\((?:<[^>\n]+>|[^()\s]+)\)/g, '$1').replace(/\s+/g, ' ').trim()
  // The closing sentence often carries an outstanding item or a limit on the findings.
  return words.length > 220 ? words.slice(0,120) + '…' + words.slice(-99) : words
}

export function composeWeeklyReport(order: V2Delegation, messages: V2Message[], commitments: StoredCommitment[],
  asOf: Date, created: Date, timeZone: string, id: string): WeeklyReport {
  const week = localWeek(asOf, timeZone)
  const cutoff = asOf.toISOString()
  const inPeriod = (at: string) => {
    const date = new Date(at)
    return Number.isFinite(date.getTime()) && date <= asOf && localWeek(date, timeZone) === week
  }
  const title = order.title + ' · ' + week + ' 当周周报'
  const sources: CommitmentSource[] = []
  const cite = (source: CommitmentSource) => {
    const found = sources.findIndex(item => item.kind === source.kind && item.sessionId === source.sessionId && item.messageId === source.messageId)
    if (found !== -1) return '〔' + (found + 1) + '〕'
    sources.push(source)
    return '〔' + sources.length + '〕'
  }
  const fromSession = (message: V2Message): CommitmentSource => ({
    kind: 'session', sessionId: order.sessionId, messageId: message.id, author: message.author, at: message.at,
  })
  const rows = messages.filter(message => message.role === 'agent' && inPeriod(message.at))
  const parts = ['# ' + inline(title, 300), '', '本工单由' + inline(order.owner, 160) + '负责。', '', '## 本周交付', '']
  const delivered = rows.flatMap(message => {
    if (!message.attachments?.length) return []
    const files = message.attachments.map(file => inline(file.label, 160)).join('、')
    const words = deliveryExcerpt(message.text)
    return ['- ' + files + (words ? '。' + inline(message.author, 160) + '记录「' + inline(words, 220) + '」' : '') + ' ' + cite(fromSession(message))]
  })
  parts.push(...(delivered.length ? delivered : ['本周还没有登记交付文件。']))

  const updates = rows.filter(message => message.text.trim() && !message.attachments?.length).slice(-3)
  if (updates.length) {
    parts.push('', '## 会话进展', '')
    for (const message of updates) parts.push('- ' + inline(message.author, 160) + '记录「' +
      inline(message.text, 220) + '」' + cite(fromSession(message)))
  }
  const activeAtCutoff = commitments.filter(row => row.recordedAt <= cutoff && (!row.resolvedAt || row.resolvedAt > cutoff))
  const doneThisWeek = commitments.filter(row => row.resolvedAt && inPeriod(row.resolvedAt))
  if (doneThisWeek.length) {
    parts.push('', '## 已处理的约定', '')
    for (const row of doneThisWeek) parts.push('- ' + direction[row.kind] + '「' + inline(row.quote, 320) + '」' + cite(row.source))
  }
  parts.push('', '## 下一步', '')
  if (!activeAtCutoff.length) parts.push('本工单暂无待跟进的约定。')
  for (const row of activeAtCutoff) {
    const due = row.dueAt ? ' · ' + dueLabel(row.dueAt, timeZone) + '到期' : ''
    const overdue = dueState(row, asOf, timeZone) === 'overdue' ? '，已到复查时间' : ''
    parts.push('- ' + direction[row.kind] + (row.person ? '（' + inline(row.person, 160) + '）' : '') +
      '「' + inline(row.quote, 320) + '」' + due + overdue + ' ' + cite(row.source))
  }
  if (sources.length) {
    parts.push('', '## 依据', '')
    sources.forEach((source, index) => parts.push((index + 1) + '. ' + timeLabel(source.at, timeZone) + ' · ' +
      (source.kind === 'liaison' ? '接口人对话' : '工单会话') + ' · ' + inline(source.author, 160)))
  }
  return { id, week, title, markdown: parts.join('\n'), createdAt: created.toISOString(), sources }
}
