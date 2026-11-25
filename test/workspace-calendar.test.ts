import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { serveApi } from '../src/dsh/http.ts'
import { workspaceCalendarRoutes } from '../src/dsh/workspace-calendar.ts'
import { WorkspaceV2Store, mutationKey } from '../src/dsh/workspace-v2-store.ts'
import { BUSY, DETAIL, overlapsDays, type AppResource, type CalendarConnections, type CalendarWeek } from '../src/core/workspace-calendar.ts'
import { fileAgenda, readCalendarFile } from '../src/dsh/calendar-ical.ts'
import type { Tools } from '../src/dsh/ports.ts'

const dirs:string[] = []
afterEach(() => {for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true})})
const props = (names:Record<string,string>) => ({type:'object',properties:Object.fromEntries(Object.entries(names).map(([name,type]) => [name,{type}]))})
const paging = {pageSize:'integer',pageToken:'string'}
const schemas = [
  {name:'mcp__office__list_calendars',parameters:props(paging)},
  {name:'mcp__office__list_events',parameters:props({...paging,calendarId:'string',startTime:'string',endTime:'string',timeZone:'string'})},
  {name:'mcp__wrong__list_calendars',parameters:props(paging)},
  {name:'mcp__wrong__list_events',parameters:props({query:'string'})},
  {name:'mcp__other__delete_event',parameters:props({})},
]
const shell = (...events:string[]) => ['BEGIN:VCALENDAR','VERSION:2.0',...events,'END:VCALENDAR'].join('\r\n')
const event = (...props:string[]) => ['BEGIN:VEVENT',...props,'END:VEVENT'].join('\r\n')
const allDay = event('UID:private-uid@example.test','DTSTART;VALUE=DATE:20261119','DTEND;VALUE=DATE:20261121','SUMMARY:私密标题','LOCATION:地点不可见','DESCRIPTION:原始不应存储')
const timed = event('UID:night','DTSTART:20261119T160000Z','DTEND:20261119T170000Z','SUMMARY:跨时区')
function fixture(mock?:(tool:string,args:Record<string,unknown>)=>Promise<object>) {
  const root = mkdtempSync(join(tmpdir(),'chief-calendar-'));dirs.push(root)
  const scope = 'calendar-scope', store = new WorkspaceV2Store(root,scope)
  const calls:{tool:string;args:Record<string,unknown>}[] = []
  const execute:Tools['execute'] = async ({calls:batch}) => {
    const call = batch[0]!, args = JSON.parse(call.arguments)
    calls.push({tool:call.name,args})
    const content = await mock?.(call.name,args)
    return {results:[{result:content ? {isError:false,value:{structuredContent:content,content:[]}} : {isError:true}}]}
  }
  const meetings = [{id:'m',title:'早会',at:'2026-11-20T09:00',with:['同事'],createdAt:'2026-11-01'}]
  function mount() {
    return workspaceCalendarRoutes({root,scope,timeZone:'Asia/Shanghai',roster:{meetings:() => meetings},workspaces:store,tools:{schemas:()=>schemas,execute}})
  }
  let route = mount()
  async function api<T = {error:string}>(path:string,body?:Record<string,unknown>,options:{scope?:string;owner?:boolean;marked?:boolean}={}) {
    const url = new URL('/chief/api/v2/' + path,'http://local')
    url.searchParams.set('scope',options.scope ?? scope)
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []),{
      url:url.pathname + url.search,method:body ? 'POST' : 'GET',headers:options.marked === false ? {} : {'x-chief-request':'1'},
    }) as unknown as IncomingMessage
    let status = 0, data:T
    const res = {writeHead(s:number){status=s},end(value:string){data=JSON.parse(value)}} as unknown as ServerResponse
    await serveApi(req,res,'public',[route],options.owner ?? true)
    return {status,data:data!}
  }
  return {root,store,calls,api,week:(day = '2026-11-20') => route.week(day),restart(){route.dispose();route=mount()}}
}
const input = {requestId:'file',app:'Outlook',account:'工作',name:'会议',content:shell(allDay,timed),visibility:'details'}

describe('personal calendar connections and week projection', () => {
  it('renders meetings and live workspace checkpoints in the configured zone, without any connector or workspace prerequisite', async () => {
    const {store,week,api} = fixture()
    expect((await week()).entries.map(e=>e.title)).toEqual(['早会'])
    store.createWorkspace(mutationKey(['s'],{requestId:'w'}),{name:'项目',goal:'成果'})
    const w = store.list()[0]!
    store.createDelegation(mutationKey(['d'],{requestId:'d'}),w,{title:'复盘',nextCheckAt:'2026-11-19T22:30:00Z'})
    const d = store.view(w.id).delegations[0]!
    // A stored follow-up time without a recurring schedule makes no calendar entry.
    expect((await week()).entries.map(e=>e.title)).toEqual(['早会'])
    store.saveFollowup(w.id,d.id,d.generation,mutationKey(['f'],{requestId:'f'}),state => {
      state.schedule = {enabled:true,weekday:5,time:'06:30',enabledAt:'2026-11-01T00:00:00Z',revision:'r1'}
      return undefined
    })
    expect((await week()).entries[0]).toMatchObject({title:'复盘',start:'2026-11-20T06:30',workspaceId:w.id,delegationId:d.id})
    // Weeks before the schedule was enabled have no run.
    expect((await week('2026-10-26')).entries.some(e=>e.id === 'checkpoint:' + d.id)).toBe(false)
    // A finished order keeps its schedule but runs nothing; reopening starts it again from then on.
    store.act(mutationKey(['action'],{requestId:'c'}),w.id,d.id,{action:'complete'})
    expect((await week()).entries.map(e=>e.title)).toEqual(['早会'])
    store.act(mutationKey(['action'],{requestId:'o'}),w.id,d.id,{action:'reopen'})
    expect((await week('2030-01-07')).entries.map(e=>e.title)).toEqual(['复盘'])
    store.act(mutationKey(['action'],{requestId:'p'}),w.id,d.id,{action:'pause'})
    expect((await week('2030-01-07')).entries).toEqual([])
    expect((await api('calendar?week=2026-02-30')).status).toBe(400)
    expect((await api('calendar',{},{owner:false})).status).toBe(403)
    expect((await api('calendar',undefined,{scope:'another-brain'})).status).toBe(409)
    expect((await api('connections/import',input,{marked:false})).status).toBe(403)
  })
  it('persists resources per account, replays requests, refreshes in place and permanently drops a removed file', async () => {
    const {api,week,restart,root} = fixture()
    const upload = async(body:Record<string,unknown>) => api<{resourceId:string}>('connections/import',body)
    const first = await upload(input), id = first.data.resourceId
    expect(first.status).toBe(200)
    expect(await upload(input)).toEqual(first)
    expect((await upload({...input,requestId:'same'})).data.resourceId).toBe(id)
    expect((await upload({...input,name:'另一份'})).status).toBe(409)
    const personal = await upload({...input,requestId:'other',account:'个人'})
    expect(personal.data.resourceId).not.toBe(id)
    restart()
    const ds = await week()
    expect(ds.entries.filter(row=>row.kind === 'external')).toHaveLength(4)
    const before = ds.entries.find(x=>x.sourceId===id && x.title==='私密标题')!
    expect(before).toMatchObject({start:'2026-11-19',end:'2026-11-21'})
    expect(overlapsDays(before,'2026-11-20','2026-11-21')).toBe(true)
    expect(overlapsDays(before,'2026-11-21','2026-11-22')).toBe(false)
    expect(ds.entries.find(x=>x.title==='跨时区')?.start).toBe('2026-11-20T00:00')
    await api('connections/remove/' + personal.data.resourceId,{requestId:'remove-other'})
    const busy = await upload({...input,requestId:'busy',replaceId:id,visibility:'busy'})
    expect(busy.data.resourceId).toBe(id)
    const redacted = await week()
    expect(redacted.entries.find(x=>x.id===before.id)).toMatchObject({title:'已占用'})
    const onDisk = readFileSync(join(root,'ops','superhub-v2',readdirSync(join(root,'ops','superhub-v2')).find(f=>f.endsWith('.resources.json'))!),'utf8')
    for (const word of ['私密标题','地点不可见','原始不应存储','private-uid@example.test']) expect(onDisk).not.toContain(word)
    expect((await upload({...input,requestId:'bad',replaceId:id,content:'bad'})).status).toBe(400)
    expect((await week()).sources).toHaveLength(1)
    await api('connections/remove/' + id,{requestId:'remove'})
    expect((await upload(input)).data.resourceId).toBe(id)
    expect((await week()).sources).toHaveLength(0)
  })
  it('lets the iCalendar parser expand rules, TZID, exceptions, cancelled overrides and all-day formats', () => {
    const repeat = event('UID:series','DTSTART;TZID=Europe/Paris:20261026T110000','DTEND;TZID=Europe/Paris:20261026T120000','RRULE:FREQ=WEEKLY;COUNT=8','EXDATE;TZID=Europe/Paris:20261123T110000','SUMMARY:每周同步')
    const moved = event('UID:series','RECURRENCE-ID;TZID=Europe/Paris:20261116T110000','DTSTART;TZID=Europe/Paris:20261118T120000','DTEND;TZID=Europe/Paris:20261118T130000','SUMMARY:改期')
    const cancelled = event('UID:series','RECURRENCE-ID;TZID=Europe/Paris:20261130T110000','STATUS:CANCELLED')
    const resource:AppResource = {id:'r',resourceId:'x',kind:'calendar',provider:'ical',name:'X',connectionId:'c',app:'A',account:'a',capabilities:[DETAIL,BUSY]}
    const content = readCalendarFile(shell(repeat,moved,cancelled),false).contents
    expect(fileAgenda(resource,content,'2026-11-16','2026-11-23','Asia/Shanghai')).toEqual([expect.objectContaining({start:'2026-11-18T19:00',title:'改期'})])
    expect(fileAgenda(resource,content,'2026-11-23','2026-12-07','Asia/Shanghai')).toEqual([])
  })
  it('uses only schema-matched MCP operations, follows pagination, enforces provider visibility, and reports a failed source', async () => {
    let failure = false
    const {api,week,calls} = fixture(async(name,args) => {
      if (name.endsWith('list_calendars')) return args.pageToken ? {calendars:[{id:'team',summary:'团队'}]} : {calendars:[],nextPageToken:'next'}
      if (failure) throw new Error('provider private body')
      return {accessRole:'freeBusyReader',events:[{id:'h',summary:'隐藏',location:'私密',start:{dateTime:'2026-11-19T22:00:00Z'},end:{dateTime:'2026-11-19T23:00:00Z'}},
        {id:'f',summary:'空闲',transparency:'transparent',start:{date:'2026-11-19'},end:{date:'2026-11-20'}}]}
    })
    expect((await api<CalendarConnections>('connections')).data.servers).toEqual(['office'])
    expect((await api('connections/calendars/wrong')).status).toBe(503)
    expect((await api('connections/bind',{requestId:'invalid',server:'office',resourceId:'missing',visibility:'details'})).status).toBe(404)
    await api('connections/bind',{requestId:'mcp',server:'office',resourceId:'team',visibility:'details'})
    const ds = await week()
    expect(ds.entries.filter(row=>row.kind === 'external')).toEqual([expect.objectContaining({title:'已占用',start:'2026-11-20T06:00'})])
    expect(JSON.stringify(ds)).not.toMatch(/隐藏|空闲|私密/)
    expect(calls.at(-1)).toMatchObject({tool:'mcp__office__list_events',args:{calendarId:'team',startTime:'2026-11-16T00:00:00',endTime:'2026-11-23T00:00:00',timeZone:'Asia/Shanghai'}})
    failure=true
    const failed = await api<CalendarWeek>('calendar?week=2026-11-20')
    expect(failed.data.issues).toHaveLength(1)
    expect(JSON.stringify(failed.data)).not.toContain('provider private body')
    expect(failed.data.entries.map(row=>row.title)).toEqual(['早会'])
  })
  it('expands a provider series in its original zone through DST and keeps the moved occurrence once', async () => {
    const {api} = fixture(async name => name.endsWith('list_calendars') ? {calendars:[{id:'team',summary:'A'}]} : {
      accessRole:'reader',timeZone:'America/New_York',events:[
        {id:'series',summary:'晨会',start:{dateTime:'2026-10-26T09:00:00-04:00',timeZone:'America/New_York'},
          end:{dateTime:'2026-10-26T10:00:00-04:00',timeZone:'America/New_York'},recurrence:['RRULE:FREQ=WEEKLY;COUNT=6']},
        {id:'later',recurringEventId:'series',originalStartTime:{dateTime:'2026-11-09T09:00:00-05:00'},summary:'顺延',
          start:{dateTime:'2026-11-11T11:00:00-05:00'},end:{dateTime:'2026-11-11T12:00:00-05:00'}},
      ]})
    await api('connections/bind',{requestId:'bind',server:'office',resourceId:'team',visibility:'details'})
    const october = await api<CalendarWeek>('calendar?week=2026-10-26')
    expect(october.data.entries).toEqual([expect.objectContaining({title:'晨会',start:'2026-10-26T21:00'})])
    const november = await api<CalendarWeek>('calendar?week=2026-11-02')
    expect(november.data.entries).toEqual([expect.objectContaining({title:'晨会',start:'2026-11-02T22:00'})])
    const moved = await api<CalendarWeek>('calendar?week=2026-11-09')
    expect(moved.data.entries).toEqual([expect.objectContaining({title:'顺延',start:'2026-11-12T00:00'})])
  })
  it.each([false,true])('a delayed bind cannot restore a revoked calendar (initially connected: %s)', async initiallyConnected => {
    let holdNext = false
    let started!: () => void, release!: () => void
    const pending = new Promise<void>(done => { started = done })
    const {api} = fixture(async () => {
      if (holdNext) {
        holdNext = false
        started()
        await new Promise<void>(done => { release = done })
      }
      return {calendars:[{id:'work',summary:'工作日历'}]}
    })
    const bind = (requestId:string,visibility:string) => api<{resourceId:string}>('connections/bind',{
      requestId,visibility,server:'office',resourceId:'work',
    })
    let saved = initiallyConnected ? await bind('first','busy') : undefined
    holdNext = true
    const stale = bind('old','details')
    await pending
    saved ??= await bind('new','busy')
    expect((await api('connections/remove/'+saved.data.resourceId,{requestId:'remove'})).status).toBe(200)
    release()
    expect((await stale).status).toBe(409)
    expect((await api<CalendarConnections>('connections')).data.resources).toEqual([])
  })
  it('drops an in-flight MCP response after disconnect', async () => {
    let release!:()=>void,started!:()=>void
    const waiting = new Promise<void>(done=>{started=done})
    const {api,week} = fixture(async name => {
      if (name.endsWith('list_calendars')) return {calendars:[{id:'a',summary:'A'}]}
      started()
      await new Promise<void>(done=>{release=done})
      return {accessRole:'owner',events:[{id:'x',summary:'removed private',start:{date:'2026-11-19'},end:{date:'2026-11-20'}}]}
    })
    const {data} = await api<{resourceId:string}>('connections/bind',{requestId:'bind',server:'office',resourceId:'a',visibility:'details'})
    const pending = week()
    await waiting
    await api('connections/remove/' + data.resourceId,{requestId:'remove'})
    release()
    const result = await pending
    expect(result.sources).toHaveLength(0)
    expect(JSON.stringify(result)).not.toContain('removed private')
  })
})

describe('archived workspaces in the calendar', () => {
  it('shows no checkpoint of an archived workspace, even one whose order still had a schedule', async () => {
    const {store,week} = fixture()
    store.createWorkspace(mutationKey(['s'],{requestId:'w'}),{name:'项目',goal:'成果'})
    const w = store.list()[0]!
    store.createDelegation(mutationKey(['d'],{requestId:'d'}),w,{title:'复盘'})
    const d = store.view(w.id).delegations[0]!
    store.saveFollowup(w.id,d.id,d.generation,mutationKey(['f'],{requestId:'f'}),state => {
      state.schedule = {enabled:true,weekday:5,time:'06:30',enabledAt:'2026-11-01T00:00:00Z',revision:'r1'}
      return undefined
    })
    expect((await week()).entries.map(e=>e.title)).toEqual(['复盘','早会'])
    // An older board edited by hand (or a race) can leave a scheduled order behind in an archived workspace.
    const root = mkdtempSync(join(tmpdir(),'chief-calendar-'));dirs.push(root)
    const archived = workspaceCalendarRoutes({root,scope:'calendar-scope',timeZone:'Asia/Shanghai',roster:{meetings:() => []},
      workspaces:{list:() => store.list().map(row => ({...row,archivedAt:'2026-11-24T08:00:00.000Z'})),view:id => store.view(id),activeSchedule:order => store.activeSchedule(order)},
      tools:{schemas:()=>[],execute:async () => ({results:[]})}})
    expect((await archived.week('2026-11-20')).entries).toEqual([])
    archived.dispose()
    expect(store.scheduledFollowups().map(order => order.id)).toEqual([d.id])
  })
})
