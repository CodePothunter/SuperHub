import { useRef, useState, type FormEvent } from 'react'
import {
  calendarDate, DETAIL, mondayOf, overlapsDays, shiftDate,
  type AgendaEntry, type AppResource, type CalendarConnections, type CalendarWeek, type RemoteCalendar,
} from '../core/workspace-calendar.ts'
import type { Scoped } from './superhub-api.ts'
import { useV2Read, useV2Write } from './workspace-v2-api.ts'
import { Issue, V2Dialog, V2Icon } from './workspace-v2-elements.tsx'

const record = (v:unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v:unknown):v is string => typeof v === 'string'
const strings = (v:unknown):v is string[] => Array.isArray(v) && v.every(text)
const source = (v:unknown):v is AppResource => record(v) && [v.id,v.kind,v.connectionId,v.name,v.provider,v.app,v.account,v.resourceId].every(text) && strings(v.capabilities)
const remote = (v:unknown):v is RemoteCalendar => record(v) && text(v.id) && text(v.name)
const timeSlot = (v:unknown):v is string => text(v) && calendarDate(v.slice(0,10)) && (v.length === 10 || /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d$/.test(v))
const entry = (v:unknown): v is AgendaEntry => record(v) && text(v.id) && text(v.title) && text(v.sourceId) && timeSlot(v.start)
  && (v.end === undefined || timeSlot(v.end)) && (v.detail === undefined || text(v.detail))
  && (v.kind === 'meeting' || v.kind === 'external' || v.kind === 'checkpoint' && text(v.workspaceId) && text(v.delegationId))
function validWeek(value:Scoped, path:string):value is CalendarWeek {
  if (!record(value) || !calendarDate(value.week) || !calendarDate(value.today) || !text(value.timeZone)
    || !Array.isArray(value.entries) || !value.entries.every(entry) || !Array.isArray(value.sources) || !value.sources.every(source)
    || !Array.isArray(value.issues) || !value.issues.every(v => record(v) && text(v.sourceId) && text(v.message))) return false
  const requested = new URLSearchParams(path.split('?')[1]).get('week')
  return value.week === mondayOf(requested ?? value.today)
}
const validConnections = (v:Scoped):v is CalendarConnections => record(v) && Array.isArray(v.resources) && v.resources.every(source) && strings(v.servers)
function remoteList(v:Scoped,path:string):v is Scoped & {server:string;calendars:RemoteCalendar[]} {
  return record(v) && text(v.server) && path.endsWith('/' + encodeURIComponent(v.server)) && Array.isArray(v.calendars) && v.calendars.every(remote)
}
const receipt = (v:Scoped) => record(v) && text(v.resourceId) && !!v.resourceId
const fmt = (day:string, opts:Intl.DateTimeFormatOptions) => new Date(day + 'T12:00:00Z').toLocaleDateString('zh-CN',{...opts,timeZone:'UTC'})
const kindName = {meeting:'本脑会议',checkpoint:'工单跟进',external:'外部日程'}
const sourceLabel = (s:AppResource) => [s.app,s.account,s.name].join(' · ')
const field = (data:FormData,name:string) => String(data.get(name) ?? '').trim()
const root = '/v2/connections'
const styles = `
.wv2 .v2-cal-controls,.wv2 .v2-cal-range,.wv2 .v2-cal-source,.wv2 .v2-cal-day-title {display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.wv2 .v2-cal-controls {margin:0 0 14px}.wv2 .v2-cal-range {justify-content:flex-start;gap:6px}
.wv2 .v2-cal-controls input {padding:5px 8px;border:1px solid var(--v-line);background:var(--v-surface);border-radius:6px;max-width:100%}
.wv2 .v2-cal-week {display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;padding:5px;background:var(--v-tint);border:1px solid var(--v-line);border-radius:12px}
.wv2 .v2-cal-week button {border-radius:7px;display:grid;justify-items:center;align-content:center;gap:1px;min-height:78px;color:var(--v-muted)}
.wv2 .v2-cal-week button[aria-pressed=true] {background:var(--v-green);color:var(--v-on)}.wv2 .v2-cal-week button:hover:not([aria-pressed=true]) {background:var(--v-surface)}
.wv2 .v2-cal-week b {font-size:22px;font-weight:600;line-height:1.2}.wv2 .v2-cal-week small {font-size:12px}
.wv2 .v2-cal-day-title {margin:22px 0 8px}.wv2 .v2-cal-day-title h2 {font-size:20px}.wv2 .v2-cal-day-title small,.wv2 .v2-cal-muted {color:var(--v-muted)}
.wv2 .v2-cal-row {display:grid;grid-template-columns:minmax(80px,125px) minmax(0,1fr) auto;align-items:start;gap:12px;padding:16px;border-bottom:1px solid var(--v-soft);overflow-wrap:anywhere}
.wv2 .v2-cal-row:last-child {border:0}.wv2 .v2-cal-row time {font-variant-numeric:tabular-nums;font-size:14px;color:var(--v-green)}
.wv2 .v2-cal-row strong,.wv2 .v2-cal-row small {display:block}.wv2 .v2-cal-row small,.wv2 .v2-cal-source small {color:var(--v-muted);font-size:12px}
.wv2 .v2-cal-empty {padding:26px 18px;color:var(--v-muted)}.wv2 .v2-cal-bottom {margin-top:14px;color:var(--v-muted);font-size:13px}
.wv2 .v2-cal-source {padding:8px 0;border-bottom:1px solid var(--v-line);overflow-wrap:anywhere}.wv2 .v2-cal-source div {min-width:0}.wv2 .v2-cal-source small {display:block}
.wv2 .v2-cal-connect h3 {margin:16px 0 4px}.wv2 .v2-cal-connect .v2-actions {margin-top:12px}.wv2 .v2-cal-connect p {margin:7px 0}
@container(max-width:600px){.wv2 .v2-cal-week {gap:1px;padding:3px}.wv2 .v2-cal-week button {min-height:66px}.wv2 .v2-cal-row {grid-template-columns:76px minmax(0,1fr);gap:7px;padding:12px 10px}.wv2 .v2-cal-row button {grid-column:2;justify-self:start}.wv2 .v2-cal-range {flex-wrap:wrap}.wv2 .v2-cal-controls {align-items:flex-start}}
`

function timeLabel(row:AgendaEntry,day:string) {
  if (row.start.length === 10) return '全天'
  const from = row.start.slice(0,10) < day ? '00:00' : row.start.slice(11)
  if (!row.end || row.end === row.start) return from
  return from + ' – ' + (row.end.slice(0,10) > day ? '24:00' : row.end.slice(11))
}
export function WorkspaceCalendar({openDelegation,selectedDate,selectDate}:{openDelegation:(workspaceId:string,delegationId:string)=>void; selectedDate?:string; selectDate?:(day:string)=>void}) {
  const [fallback,setFallback] = useState<string>()
  const [manage,setManage] = useState(false)
  const chosen = selectedDate ?? fallback
  const day = calendarDate(chosen) && chosen >= '1901-01-01' && chosen <= '9998-12-31' ? chosen : undefined
  const observation = useV2Read('/v2/calendar' + (day ? '?week=' + mondayOf(day) : ''),validWeek,60_000)
  const {data} = observation
  const selected = day ?? data?.today
  const choose = selectDate ?? setFallback
  const rows = data && selected ? data.entries.filter(row => overlapsDays(row,selected,shiftDate(selected,1))) : []
  return <section aria-label="个人日历"><style>{styles}</style>
    <div className="v2-cal-controls"><div className="v2-cal-range">
      <button type="button" className="v2-icon-btn" disabled={!selected} aria-label="上一周" onClick={() => selected && choose(shiftDate(selected,-7))}><V2Icon name="back"/></button>
      <button type="button" className="v2-button" disabled={!data} onClick={() => data && choose(data.today)}>今天</button>
      <button type="button" className="v2-icon-btn" disabled={!selected} aria-label="下一周" onClick={() => selected && choose(shiftDate(selected,7))}><V2Icon name="next"/></button>
      <input type="date" aria-label="跳转到日期" min="1901-01-01" max="9998-12-31" value={selected ?? ''} onChange={event => {if (calendarDate(event.target.value)) choose(event.target.value)}}/></div>
      <button type="button" className="v2-button" onClick={() => setManage(true)}>管理日历来源</button></div>
    <Issue text={observation.error} retry={observation.refresh}/>
    {!data && !observation.error && <p className="v2-quiet" role="status">正在读取日程…</p>}
    {data && selected && <>
      <div className="v2-cal-week" role="group" aria-label="本周日期">{Array.from({length:7},(_,i) => {
        const key = shiftDate(data.week,i)
        return <button key={key} type="button" aria-label={fmt(key,{month:'long',day:'numeric',weekday:'long'})}
          aria-current={key === data.today ? 'date' : undefined} aria-pressed={key === selected} onClick={() => choose(key)}>
          <small>{fmt(key,{weekday:'short'})}</small><b>{Number(key.slice(-2))}</b></button>
      })}</div>
      <div className="v2-cal-day-title"><h2>{fmt(selected,{month:'long',day:'numeric',weekday:'long'})}</h2><small>{data.timeZone}</small></div>
      {data.issues.map(issue => <Issue key={issue.sourceId} text={(data.sources.find(s => s.id === issue.sourceId)?.name ?? '日历来源') + ' · ' + issue.message} retry={observation.refresh}/>)}
      <div className="v2-card">{rows.length ? rows.map(row => {
        const origin = data.sources.find(s => s.id === row.sourceId)
        return <article className="v2-cal-row" key={row.id}><time>{timeLabel(row,selected)}</time>
          <div><strong>{row.title}</strong><small>{kindName[row.kind]}{origin && ' · ' + sourceLabel(origin)}</small>{row.detail && <small>{row.detail}</small>}</div>
          {row.kind === 'checkpoint' && row.workspaceId && row.delegationId && <button type="button" className="v2-link" onClick={() => openDelegation(row.workspaceId!,row.delegationId!)}>打开工单</button>}</article>
      }) : <p className="v2-cal-empty">{data.issues.length ? '可读取的来源在这一天没有日程。' : '这一天没有日程。'}</p>}</div>
      {!data.sources.length && <p className="v2-cal-bottom">尚未添加外部日历。可在「管理日历来源」连接账号或导入日历文件。</p>}</>}
    {manage && <CalendarSources close={() => setManage(false)} changed={observation.refresh}/>}
  </section>
}

function CalendarSources({close,changed}:{close:()=>void;changed:()=>Promise<void>}) {
  const list = useV2Read(root,validConnections)
  const action = useV2Write(receipt,false)
  const [mode,setMode] = useState<'file'|'mcp'>()
  const [replace,setReplace] = useState<AppResource>()
  const [server,setServer] = useState('')
  const [problem,setProblem] = useState('')
  const [notice,setNotice] = useState('')
  const sending = useRef(false)
  const choices = useV2Read(mode === 'mcp' && server ? root + '/calendars/' + encodeURIComponent(server) : undefined,remoteList)
  const abandon = () => {setMode(undefined);setReplace(undefined);setProblem('')}
  async function refresh(message:string) {
    abandon();setNotice(message)
    await Promise.all([list.refresh(),changed()])
  }
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current || action.busy) return
    const data = new FormData(event.currentTarget)
    setProblem('');setNotice('');sending.current = true
    try {
      const visibility = field(data,'visibility')
      if (mode === 'file') {
        const file = data.get('file')
        if (!(file instanceof File) || !file.size || file.size > 200000) {setProblem('请选择小于 200 KB 的 .ics 文件。');return}
        const result = await action.post(root + '/import',{app:field(data,'app'),account:field(data,'account'),name:field(data,'name'),visibility,content:await file.text(),
          ...(replace ? {replaceId:replace.id} : {})})
        if (result) await refresh('日历文件已导入。')
      } else if (mode === 'mcp') {
        const result = await action.post(root + '/bind',{server,resourceId:field(data,'calendar'),visibility})
        if (result) await refresh('已连接日历。')
      }
    } catch { setProblem('无法读取日历文件，请重新选择。') }
    finally { sending.current = false }
  }
  return <V2Dialog title="管理日历来源" close={close}><div className="v2-cal-connect">
    <Issue text={list.error} retry={list.refresh}/>{!list.data && !list.error && <p role="status">正在读取来源…</p>}
    {!mode && list.data && <>
      {list.data.resources.filter(r => r.kind === 'calendar').map(resource => <div className="v2-cal-source" key={resource.id}>
        <div><strong>{resource.name}</strong><small>{resource.app} · {resource.account} · {resource.capabilities.includes(DETAIL) ? '日程详情' : '仅忙闲'} · {resource.provider === 'ical' ? '文件导入' : '实时读取'}</small></div>
        <div className="v2-actions">{resource.provider === 'ical' && <button className="v2-link" onClick={() => {setReplace(resource);setNotice('');setMode('file')}}>更新文件</button>}
          <button type="button" className="v2-link" disabled={action.busy} onClick={async () => {if (await action.post(root + '/remove/' + encodeURIComponent(resource.id),{})) await refresh('已移除日历来源。')}}>移除</button></div></div>)}
      <div className="v2-cal-source"><h3>DSH 账号连接</h3><button type="button" className="v2-link" onClick={list.refresh}>重新读取来源</button></div>{list.data.servers.length ? <button type="button" className="v2-button" onClick={() => {setServer(list.data!.servers[0]!);setNotice('');setMode('mcp')}}>连接 MCP 日历</button> :
        <p className="v2-cal-muted">当前 DSH 没有可用的日历 MCP。已有账号可在 DSH 配置 Google 日历 MCP 后重新读取。</p>}
      <h3>日历文件</h3><p className="v2-cal-muted">从 Apple 日历、Outlook 或其他应用导出 .ics 文件。之后可用新文件更新日程。</p>
      <button type="button" className="v2-button" onClick={() => {setNotice('');setMode('file')}}>导入日历文件</button>
    </>}
    {mode && <form key={replace?.id ?? mode} onSubmit={submit}>{mode === 'file' ? <>
      <label>应用名称<input name="app" maxLength={160} required defaultValue={replace?.app} readOnly={!!replace} placeholder="例如，Apple 日历"/></label>
      <label>账号名称<input name="account" maxLength={160} required defaultValue={replace?.account} readOnly={!!replace} placeholder="例如，个人"/></label>
      <label>日历名称<input name="name" maxLength={160} required defaultValue={replace?.name} placeholder="例如，工作"/></label>
      <label>日历文件<input name="file" type="file" required accept=".ics,text/calendar"/></label>
    </> : <>
      <label>DSH 账号<select value={server} onChange={e => setServer(e.target.value)}>{list.data?.servers.map(s => <option key={s}>{s}</option>)}</select></label>
      <Issue text={choices.error} retry={choices.refresh}/>
      {choices.data ? choices.data.calendars.length ? <label>日历<select name="calendar" required>{choices.data.calendars.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id}</option>)}</select></label>
        : <p>该账号没有可以连接的日历。</p> : !choices.error && <p role="status">正在读取这个账号的日历…</p>}
    </>}
      <label>可见内容<select name="visibility" defaultValue={replace && !replace.capabilities.includes(DETAIL) ? 'busy' : 'details'}><option value="details">日程详情</option><option value="busy">仅忙闲</option></select></label>
      <div className="v2-actions"><button type="submit" className="v2-button primary" disabled={action.busy || mode === 'mcp' && !choices.data?.calendars.length}>
        {mode === 'file' ? '导入' : '连接'}</button><button className="v2-button" type="button" disabled={action.busy} onClick={abandon}>返回来源</button></div></form>}
    <Issue text={problem || action.error}/>{notice && <p className="v2-feedback" role="status">{notice}</p>}
  </div></V2Dialog>
}
