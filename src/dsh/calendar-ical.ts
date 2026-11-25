import ICAL from 'ical.js'
import { slotKey, zonedInstant } from '../core/clock.ts'
import { DETAIL, overlapsDays, shiftDate, type AgendaEntry, type AppResource } from '../core/workspace-calendar.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'

type Component = InstanceType<typeof ICAL.Component>
type IcalTime = InstanceType<typeof ICAL.Time>
type IcalEvent = InstanceType<typeof ICAL.Event>
export const ICAL_MAX_BYTES = 200_000

const temporal = ['dtstart','dtend','duration','recurrence-id','rrule','rdate','exdate','status','transp','sequence']
function pick(component: Component, names: string[]) {
  const copy = new ICAL.Component(component.name)
  for (const name of names) for (const prop of component.getAllProperties(name)) {
    const [key, params, type, ...values] = prop.toJSON()
    const keep = Object.fromEntries(Object.entries(params).filter(([field]) => ['tzid','range','value'].includes(field)))
    copy.addProperty(new ICAL.Property([key, keep, type, ...values]))
  }
  return copy
}

/** Keep only projection fields and recurrence definitions. Imports never store the original personal calendar. */
export function readCalendarFile(content: unknown, busy: boolean): {contents: string; externalId?: string} {
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > ICAL_MAX_BYTES) {
    return workspaceError(400, '请选择小于 200 KB 的 iCalendar 文件。')
  }
  try {
    const src = ICAL.Component.fromString(content.replace(/^\uFEFF/, ''))
    if (src.name !== 'vcalendar') throw new Error()
    const cleaned = new ICAL.Component('vcalendar')
    cleaned.addPropertyWithValue('version','2.0')
    const uid = src.getFirstPropertyValue('uid') ?? src.getFirstPropertyValue('x-wr-relcalid')
    for (const zone of src.getAllSubcomponents('vtimezone')) {
      const kept = pick(zone, ['tzid'])
      for (const child of zone.getAllSubcomponents()) if (['standard','daylight'].includes(child.name)) {
        kept.addSubcomponent(pick(child, ['dtstart','tzoffsetfrom','tzoffsetto','rrule','rdate']))
      }
      cleaned.addSubcomponent(kept)
    }
    const components = src.getAllSubcomponents('vevent')
    if (components.length > 2000) throw new Error()
    for (const component of components) {
      const event = new ICAL.Event(component, {exceptions:[]})
      if (!event.uid || !component.hasProperty('dtstart') && !component.hasProperty('recurrence-id')) throw new Error()
      if (!component.hasProperty('dtstart') && component.getFirstPropertyValue('status') !== 'CANCELLED') throw new Error()
      const child = pick(component, busy ? temporal : [...temporal, 'summary','location'])
      // Provider UIDs sometimes include an organizer's email. Only a stable opaque identity is needed.
      child.addPropertyWithValue('uid', workspaceFingerprint(event.uid))
      cleaned.addSubcomponent(child)
    }
    return {contents:cleaned.toString(), ...(typeof uid === 'string' && uid ? {externalId:workspaceFingerprint(uid)} : {})}
  } catch { return workspaceError(400, '日历文件无法完整解析。请从原应用重新导出 .ics 文件。') }
}

function wallTime(time: IcalTime, item: IcalEvent, property: 'dtstart'|'dtend', zone: string) {
  if (time.isDate) return time.toString()
  if (time.zone !== ICAL.Timezone.localTimezone) return slotKey(time.toJSDate(), zone)
  const tzid = (item.component.getFirstProperty(property) ?? item.component.getFirstProperty('dtstart'))?.getParameter('tzid')
  if (typeof tzid === 'string' && tzid && tzid !== zone) {
    return slotKey(zonedInstant(time.year,time.month,time.day,time.hour * 60 + time.minute,tzid),zone)
  }
  return time.toString().slice(0,16)
}

export function fileAgenda(source: AppResource, contents: string, first: string, after: string, timeZone: string): AgendaEntry[] {
  const calendar = ICAL.Component.fromString(contents)
  const groups = new Map<string, Map<string, IcalEvent>>()
  // Exports may contain multiple revisions for one UID. A recurrence override has its own identity.
  for (const component of calendar.getAllSubcomponents('vevent')) {
    const item = new ICAL.Event(component,{exceptions:[]})
    const objects = groups.get(item.uid) ?? new Map<string,IcalEvent>()
    const key = item.isRecurrenceException() ? item.recurrenceId.toString() : ''
    const previous = objects.get(key)
    if (!previous || item.sequence >= previous.sequence) objects.set(key,item)
    groups.set(item.uid,objects)
  }
  const rows = new Map<string,AgendaEntry>()
  let iterations = 0
  function add(item: IcalEvent, uid: string, occurrence: string, startTime: IcalTime, endTime: IcalTime) {
    if (item.component.getFirstPropertyValue('status') === 'CANCELLED') return
    const detail = source.capabilities.includes(DETAIL)
    if (!detail && item.component.getFirstPropertyValue('transp') === 'TRANSPARENT') return
    const start = wallTime(startTime,item,'dtstart',timeZone), end = wallTime(endTime,item,'dtend',timeZone)
    if (!overlapsDays({start,end}, first, after)) return
    const id = workspaceFingerprint([source.id, uid, occurrence])
    rows.set(id,{id,kind:'external',sourceId:source.id,start,end,
      title:detail ? String(item.summary || '未命名日程').slice(0,1000) : '已占用',
      ...(detail && item.location ? {detail:String(item.location).slice(0,2000)} : {})})
  }
  for (const [uid, group] of groups) {
    const master = group.get('')
    if (master?.component.getFirstPropertyValue('status') === 'CANCELLED') continue
    for (const [key, override] of group) if (key) {
      master?.relateException(override)
      // A moved instance may enter this week even if its original date is outside the query.
      if (override.component.getFirstPropertyValue('status') !== 'CANCELLED') add(override,uid,key,override.startDate,override.endDate)
    }
    if (!master) continue
    if (!master.isRecurring()) { add(master,uid,'',master.startDate,master.endDate); continue }
    const earliestStart = shiftDate(first, -Math.min(365_000, Math.ceil(Math.abs(master.duration.toSeconds()) / 86_400) + 3))
    const lastStart = shiftDate(after, 2)
    const recurrence = master.iterator()
    let time: IcalTime | null
    while ((time = recurrence.next())) {
      if (++iterations > 25000) throw new Error('这份文件的重复日程过于密集，请导出较短日期范围。')
      const occurrenceDay = time.toString().slice(0,10)
      if (occurrenceDay >= lastStart) break
      if (occurrenceDay < earliestStart && !master.rangeExceptions.length) continue
      if (group.has(time.toString())) continue
      const instance = master.getOccurrenceDetails(time)
      add(instance.item,uid,time.toString(),instance.startDate,instance.endDate)
    }
  }
  return [...rows.values()]
}
