import ICAL from 'ical.js'
import { randomUUID } from 'node:crypto'
import { slotKey } from '../core/clock.ts'
import { calendarDate, type AgendaEntry, type AppResource, type RemoteCalendar, DETAIL } from '../core/workspace-calendar.ts'
import type { Tools } from './ports.ts'
import { fileAgenda } from './calendar-ical.ts'
import { workspaceError } from './superhub-goals.ts'

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function supports(parameters: unknown, fields: Record<string, string>) {
  if (!record(parameters) || parameters.type !== 'object' || !record(parameters.properties)) return false
  const props = parameters.properties
  return Object.entries(fields).every(([name, type]) => record(props[name]) && props[name].type === type)
    && (!Array.isArray(parameters.required) || parameters.required.every(name => typeof name === 'string' && Object.hasOwn(fields,name)))
}

type EventComponent = InstanceType<typeof ICAL.Component>
function putTime(component:EventComponent, key:string, value:unknown, fallbackZone?:string) {
  if (!record(value)) return workspaceError(503,'日程时间缺失。')
  if (calendarDate(value.date)) { component.addPropertyWithValue(key,ICAL.Time.fromDateString(value.date)); return }
  const raw = value.dateTime
  if (typeof raw !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(raw) || !Number.isFinite(Date.parse(raw))) {
    return workspaceError(503,'日程时间缺少可识别的时区。')
  }
  const instant = new Date(raw), zone = typeof value.timeZone === 'string' ? value.timeZone : fallbackZone
  if (!zone) { component.addPropertyWithValue(key,ICAL.Time.fromJSDate(instant,true)); return }
  // Preserve the series' local hour across future DST changes. ical.js expands its rule in that wall clock.
  const local = slotKey(instant,zone) + ':' + String(instant.getUTCSeconds()).padStart(2,'0')
  component.addPropertyWithValue(key,ICAL.Time.fromDateTimeString(local)).setParameter('tzid',zone)
}

function readProviderEvent(event:Record<string,unknown>, role:unknown, source:AppResource, pageZone?:string):EventComponent | undefined {
  if (typeof event.id !== 'string' || !event.id) return workspaceError(503,'日历提供方返回了缺少标识的日程。')
  const recurringId = typeof event.recurringEventId === 'string' ? event.recurringEventId : undefined
  const component = new ICAL.Component('vevent')
  component.addPropertyWithValue('uid',recurringId || event.id)
  if (recurringId) putTime(component,'recurrence-id',event.originalStartTime,pageZone)
  if (event.status === 'cancelled') {
    component.addPropertyWithValue('status','CANCELLED')
    return component
  }
  const allowed = source.capabilities.includes(DETAIL) && ['owner','writer','writerWithoutPrivateAccess','reader'].includes(String(role))
  const details = allowed && !(event.visibility === 'private' && ['reader','writerWithoutPrivateAccess'].includes(String(role)))
  if (!details && (event.transparency === 'transparent' || event.availability === 'FREE')) {
    // A transparent override still cancels the original busy instance for this projection.
    if (!recurringId) return undefined
    component.addPropertyWithValue('status','CANCELLED')
    return component
  }
  const rules = event.recurrence
  if (rules !== undefined && (!Array.isArray(rules) || rules.length > 100)) return workspaceError(503,'重复日程的格式无效。')
  if (Array.isArray(rules)) for (const raw of rules) {
    if (typeof raw !== 'string' || raw.length > 8192 || /[\r\n]/.test(raw) || !/^(?:RRULE|RDATE|EXDATE)(?:;|:)/i.test(raw)) {
      return workspaceError(503,'无法完整读取重复日程。')
    }
    component.addProperty(ICAL.Property.fromString(raw))
  }
  // Providers may return either dated instances or their recurring series with overrides.
  const zone = rules || recurringId ? pageZone : undefined
  putTime(component,'dtstart',event.start,zone)
  putTime(component,'dtend',event.end,zone)
  component.addPropertyWithValue('summary',details && typeof event.summary === 'string' && event.summary ? event.summary.slice(0,1000) : details ? '未命名日程' : '已占用')
  if (details && typeof event.location === 'string' && event.location) component.addPropertyWithValue('location',event.location.slice(0,2000))
  return component
}

/** This adapter accepts the documented Google Calendar MCP read contracts. Other MCP tools stay outside it. */
export class CalendarMcp {
  constructor(private tools: Pick<Tools,'schemas'|'execute'>) {}
  servers() {
    if (!this.tools.execute) return []
    const schemas = this.tools.schemas?.() ?? []
    return schemas.flatMap(schema => {
      const server = /^mcp__([a-zA-Z0-9_-]{1,32})__list_calendars$/.exec(schema.name)?.[1]
      if (!server || !supports(schema.parameters, { pageSize:'integer', pageToken:'string' })) return []
      const events = schemas.find(row => row.name === 'mcp__' + server + '__list_events')
      return supports(events?.parameters, { calendarId:'string', startTime:'string', endTime:'string', pageSize:'integer', pageToken:'string', timeZone:'string' }) ? [server] : []
    }).sort()
  }
  private async pages(server: string, operation: 'list_calendars'|'list_events', params: object, signal: AbortSignal) {
    if (!this.servers().includes(server) || !this.tools.execute) return workspaceError(503, '日历 MCP 未连接，请在 DSH 恢复这个账号的连接。')
    const field = operation === 'list_calendars' ? 'calendars' : 'events'
    const pages: Record<string, unknown>[] = []
    const tokens = new Set<string>()
    let pageToken = ''
    do {
      if (signal.aborted) return workspaceError(503,'日历读取已中断，请重试。')
      const name = 'mcp__' + server + '__' + operation
      const response = await this.tools.execute({signal, calls:[{type:'tool-call', id:randomUUID(), name,
        arguments:JSON.stringify({...params, pageSize:250, ...(pageToken ? {pageToken} : {})})}]})
        .catch(() => workspaceError(503,'日历提供方读取失败，请检查账号授权后重试。'))
      if (signal.aborted || !this.servers().includes(server)) return workspaceError(503,'日历连接已改变，请重新读取。')
      const tool = response.results[0]?.result
      if (!tool || tool.isError || !record(tool.value)) return workspaceError(503, '日历提供方读取失败，请检查账号授权后重试。')
      const result = tool.value
      let page: unknown = result.structuredContent
      if (!page && Array.isArray(result.content)) {
        const text = result.content.find(block => record(block) && block.type === 'text')?.text
        try { page = typeof text === 'string' ? JSON.parse(text) : undefined } catch { /* handled below */ }
      }
      if (!record(page) || !Array.isArray(page[field]) || !page[field].every(record)) return workspaceError(503, '日历提供方返回的内容不完整。')
      pages.push(page)
      if (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string') return workspaceError(503, '日历分页信息无效。')
      pageToken = String(page.nextPageToken ?? '')
      if (pageToken && (tokens.has(pageToken) || pages.length >= 20)) return workspaceError(503, '日历分页未能完整读取。')
      tokens.add(pageToken)
    } while (pageToken)
    return pages
  }
  async calendars(server: string, signal: AbortSignal): Promise<RemoteCalendar[]> {
    const rows = new Map<string, RemoteCalendar>()
    for (const page of await this.pages(server, 'list_calendars', {}, signal)) {
      for (const row of page.calendars as Record<string, unknown>[]) {
        if (typeof row.id !== 'string' || !row.id || row.id.length > 1024) return workspaceError(503,'日历来源缺少有效标识。')
        rows.set(row.id, {id:row.id, name:typeof row.summary === 'string' && row.summary ? row.summary.slice(0,300) : row.id})
      }
    }
    return [...rows.values()]
  }
  async events(source: AppResource, startTime: string, endTime: string, timeZone: string, signal: AbortSignal): Promise<AgendaEntry[]> {
    const pages = await this.pages(source.account, 'list_events', {calendarId:source.resourceId,startTime,endTime,timeZone}, signal)
    const calendar = new ICAL.Component('vcalendar')
    for (const page of pages) {
      if (page.accessRole === 'none') return workspaceError(503, '此账号已失去日历读取权限。')
      for (const event of page.events as Record<string, unknown>[]) {
        const component = readProviderEvent(event,page.accessRole,source,typeof page.timeZone === 'string' ? page.timeZone : undefined)
        if (component) calendar.addSubcomponent(component)
      }
    }
    return fileAgenda(source,calendar.toString(),startTime.slice(0,10),endTime.slice(0,10),timeZone)
  }
}
