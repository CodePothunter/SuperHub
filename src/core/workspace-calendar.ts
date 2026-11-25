/** Sources are shared across application views. Capability and resource identifiers are open to other adapters. */
export interface AppResource {
  id: string
  connectionId: string
  provider: string
  app: string
  account: string
  resourceId: string
  name: string
  kind: string
  capabilities: string[]
}
export const DETAIL = 'calendar.events.read'
export const BUSY = 'calendar.busy.read'

/** Wall-clock timestamps use the response's time zone. Date-only bounds are exclusive at the end. */
export interface AgendaEntry {
  id: string
  sourceId: string
  kind: 'meeting' | 'checkpoint' | 'external'
  title: string
  start: string
  end?: string
  detail?: string
  workspaceId?: string
  delegationId?: string
}
export interface CalendarWeek {
  scope: string
  week: string
  today: string
  timeZone: string
  entries: AgendaEntry[]
  sources: AppResource[]
  issues: {sourceId: string; message: string}[]
}
export interface CalendarConnections { scope: string; resources: AppResource[]; servers: string[] }
export interface RemoteCalendar { id: string; name: string }
export function calendarDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
export function selectableCalendarDate(value: unknown): value is string {
  return calendarDate(value) && value >= '1901-01-01' && value <= '9998-12-31'
}
export function shiftDate(day: string, offset: number): string {
  const date = new Date(day + 'T12:00:00Z')
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}
export function mondayOf(day: string): string {
  return shiftDate(day, -((new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7))
}
export function overlapsDays(row: Pick<AgendaEntry, 'start' | 'end'>, first: string, after: string) {
  const startsBefore = row.start < after
  // A midnight end excludes that date for both timed and all-day events.
  if (row.end && row.end > row.start) return startsBefore && row.end > (row.end.length === 10 ? first : first + 'T00:00')
  return startsBefore && row.start >= first
}
