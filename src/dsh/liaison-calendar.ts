import { calendarDate, overlapsDays, shiftDate, type CalendarWeek } from '../core/workspace-calendar.ts'

/** Use the owner's calendar projection so the liaison sees the same grants, redactions and source failures as the page. */
export async function readLiaisonCalendar(
  readWeek: (day?: string) => Promise<CalendarWeek>,
  args: Record<string, unknown>,
) {
  const { date, range = 'day', offset = 0 } = args
  if (date !== undefined && !calendarDate(date)) throw new Error('请使用有效的当地日期，格式为 YYYY-MM-DD。')
  if (range !== 'day' && range !== 'week') throw new Error('可查询一天或一周的日程。')
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('日程分页位置无效。')
  const view = await readWeek(date)
  const from = range === 'week' ? view.week : date ?? view.today
  const until = shiftDate(from, range === 'week' ? 7 : 1)
  const entries = view.entries.filter(entry => overlapsDays(entry,from,until))
  const sources = new Map(view.sources.map(source => [source.id, [source.app,source.account,source.name].filter(Boolean).join(' · ')]))
  const localSources: Record<string,string> = { meeting:'本脑会议', checkpoint:'工单检查点' }
  const end = Math.min(entries.length, offset + 40)
  return {
    timeZone: view.timeZone, from, through: shiftDate(until,-1),
    sources: [...sources.values()], issues: view.issues.map(issue => ({ source:sources.get(issue.sourceId), message:issue.message })),
    entries: entries.slice(offset,end).map(entry => ({
      title:entry.title, start:entry.start, end:entry.end, kind:entry.kind, source:sources.get(entry.sourceId) ?? localSources[entry.kind],
    })),
    total: entries.length, ...(end < entries.length ? { nextOffset:end } : {}),
  }
}
