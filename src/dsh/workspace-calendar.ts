import { slotKey, zonedInstant } from '../core/clock.ts'
import { BUSY, DETAIL, mondayOf, overlapsDays, selectableCalendarDate, shiftDate, type AgendaEntry, type CalendarWeek } from '../core/workspace-calendar.ts'
import { workspaceArchived } from '../core/workspace-v2.ts'
import { AppResources } from './app-resources.ts'
import { CalendarMcp } from './calendar-mcp.ts'
import { fileAgenda, readCalendarFile } from './calendar-ical.ts'
import { json, type Route } from './http.ts'
import type { Tools } from './ports.ts'
import type { Roster } from './roster.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import type { WorkspaceV2Store } from './workspace-v2-store.ts'

interface Options { root:string; scope:string; timeZone:string; roster:Pick<Roster,'meetings'>; workspaces:Pick<WorkspaceV2Store,'list'|'view'|'activeSchedule'>; tools:Pick<Tools,'schemas'|'execute'> }
function name(value:unknown,label:string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) return workspaceError(400,'请填写有效的' + label + '。')
  return value.trim()
}
export function workspaceCalendarRoutes({root,scope,timeZone,roster,workspaces,tools}:Options) {
  const resources = new AppResources(root,scope)
  const mcp = new CalendarMcp(tools)
  const lifetime = new AbortController()
  const signal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
  const active = () => { if (lifetime.signal.aborted) workspaceError(409,'第二大脑已切换，请重新打开。') }
  async function week(day?:string):Promise<CalendarWeek> {
    active()
    const today = slotKey(new Date(),timeZone).slice(0,10)
    if (day !== undefined && !selectableCalendarDate(day)) return workspaceError(400,'请选择有效的日历日期。')
    const first = mondayOf(day ?? today), after = shiftDate(first,7)
    const entries:AgendaEntry[] = []
    for (const meeting of roster.meetings()) {
      if (!overlapsDays({start:meeting.at},first,after)) continue
      entries.push({id:'meeting:' + meeting.id,sourceId:'meetings',kind:'meeting',title:meeting.title,start:meeting.at,
        ...meeting.with.length ? {detail:'参与人 · ' + meeting.with.join('、')} : {}})
    }
    // Follow-ups come from enabled recurring schedules only (one run in this week); a stored default time is not shown.
    // An archived workspace has no checkpoints to keep (its orders are all finished or cancelled).
    for (const workspace of workspaces.list().filter(space => !workspaceArchived(space))) for (const job of workspaces.view(workspace.id).delegations) {
      const plan = workspaces.activeSchedule(job)
      if (!plan) continue
      const [y,mo,d] = shiftDate(first,(plan.weekday + 6) % 7).split('-').map(Number)
      const [hour,minute] = plan.time.split(':').map(Number)
      const slot = zonedInstant(y!,mo!,d!,hour! * 60 + minute!,timeZone)
      // Weeks before the schedule was set have no run.
      if (slot.getTime() < Math.floor(Date.parse(plan.enabledAt) / 60_000) * 60_000) continue
      const start = slotKey(slot,timeZone)
      if (!overlapsDays({start},first,after)) continue
      entries.push({id:'checkpoint:' + job.id,sourceId:'workspaces',kind:'checkpoint',title:job.title,start,detail:workspace.name,
        workspaceId:workspace.id,delegationId:job.id})
    }
    const bindings = resources.list('calendar')
    const reads = await Promise.allSettled(bindings.map(async ({resource,contents}) => resource.provider === 'ical'
      ? fileAgenda(resource,contents ?? '',first,after,timeZone)
      : mcp.events(resource,first + 'T00:00:00',after + 'T00:00:00',timeZone,signal())))
    active()
    const issues:CalendarWeek['issues'] = []
    for (const [index,outcome] of reads.entries()) {
      const binding = bindings[index]!
      // An in-flight read must lose its projection when the owner changes or removes this binding.
      if (resources.get(binding.resource.id) !== binding) continue
      if (outcome.status === 'fulfilled') entries.push(...outcome.value.filter(entry => overlapsDays(entry,first,after)))
      else issues.push({sourceId:binding.resource.id,message: binding.resource.provider === 'ical' ? '这份文件的日程未能完整读取。请从原应用重新导出较短范围。' : '日历提供方读取失败，请检查账号连接和授权。'})
    }
    return {scope,week:first,today,timeZone,entries:entries.sort((a,b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)),
      sources:resources.list('calendar').map(row => row.resource),issues}
  }

  const route:Route = async ({method,seg,url,body,owner},res) => {
    if (seg[0] !== 'v2' || !['calendar','connections'].includes(seg[1] ?? '')) return false
    active()
    if (owner !== true) return workspaceError(403,'需要主人权限才能读取本脑日历。')
    if (url.searchParams.get('scope') !== scope || body.scope !== undefined && body.scope !== scope) return workspaceError(409,'第二大脑已切换，请重新打开。')
    const ok = (data:object) => {active();json(res,200,{...data,scope});return true}
    if (method === 'GET' && seg.length === 2) {
      if (seg[1] === 'calendar') return ok(await week(url.searchParams.get('week') ?? undefined))
      return ok({resources:resources.list().map(row => row.resource),servers:mcp.servers()})
    }
    if (seg[1] !== 'connections') return false
    const [, ,action, id] = seg
    if (method === 'GET' && action === 'calendars' && id && seg.length === 4) {
      return ok({server:id,calendars:await mcp.calendars(id,signal())})
    }
    if (method !== 'POST' || !action) return false
    const mutation = resources.mutation(seg.slice(2).join('/'),body)
    const replay = resources.replay(mutation)
    if (replay) return ok({resourceId:replay})
    if (action === 'remove' && id && seg.length === 4) return ok({resourceId:resources.remove(mutation,id)})
    if (!['import','bind'].includes(action) || seg.length !== 3) return false
    if (body.visibility !== 'details' && body.visibility !== 'busy') return workspaceError(400,'请选择日程详情或仅忙闲。')
    const caps = body.visibility === 'busy' ? [BUSY] : [BUSY,DETAIL]
    if (action === 'import') {
      const app = name(body.app,'应用名称'), account = name(body.account,'账号名称'), label = name(body.name,'日历名称')
      const parsed = readCalendarFile(body.content,body.visibility === 'busy')
      // Without a provider UID, independently named resources remain distinct; exact file repeats can still converge.
      const connectionId = workspaceFingerprint(['ical',app,account])
      let resourceId = parsed.externalId || workspaceFingerprint([label,body.content])
      if (body.replaceId !== undefined) {
        const existing = typeof body.replaceId === 'string' && resources.get(body.replaceId)?.resource
        if (!existing || existing.provider !== 'ical' || existing.connectionId !== connectionId) return workspaceError(409,'日历来源已变更，请重新选择。')
        resourceId = existing.resourceId
      }
      return ok({resourceId:resources.put(mutation,{connectionId,provider:'ical',app,account,resourceId,name:label,kind:'calendar',capabilities:caps},parsed.contents)})
    }
    const server = name(body.server,'DSH 连接名称')
    if (typeof body.resourceId !== 'string' || !body.resourceId || body.resourceId.length > 1024) return workspaceError(400,'请选择要连接的日历。')
    const key = {connectionId:workspaceFingerprint(['mcp',server]),kind:'calendar',resourceId:body.resourceId}
    const revision = resources.revision(key)
    const calendars = await mcp.calendars(server,signal())
    active()
    const completed = resources.replay(mutation)
    if (completed) return ok({resourceId:completed})
    // A removal or narrower grant made while the provider was answering takes precedence.
    if (resources.revision(key) !== revision) return workspaceError(409,'日历来源已变更，请重新读取来源后再连接。')
    const selected = calendars.find(row => row.id === key.resourceId) ?? workspaceError(404,'该账号没有这份日历。')
    return ok({resourceId:resources.put(mutation,{...key,provider:'mcp',app:'Google 日历 MCP',account:server,
      name:selected.name,capabilities:caps})})
  }
  return Object.assign(route,{week,dispose(){lifetime.abort()}})
}
