import { useEffect, useRef, useState } from 'react'
import { BY_LABEL } from '../core/schedules.ts'
import type { NoticeSchedule } from '../dsh/outbox.ts'
import { useV2Read, useV2Write } from './workspace-v2-api.ts'
import { Issue, readableTime } from './workspace-v2-elements.tsx'
import { isScheduleList, isScheduleReceipt, type ScheduleListView } from './workspace-v2-response.ts'

const SCHEDULES = '/v2/schedules'
type Row = ScheduleListView['schedules'][number]

export const SCHEDULE_STYLE = `
.wv2 #schedules h2 { scroll-margin-top:88px; }
.wv2 .v2-schedules { list-style:none; padding:0; margin:0; display:grid; gap:0; }
.wv2 .v2-schedules>li { display:grid; gap:6px; padding:12px 0; border-top:1px solid var(--v-soft); min-width:0; }
.wv2 .v2-schedules>li:first-child { border-top:0; padding-top:2px; }
.wv2 .v2-schedule-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 10px; min-width:0; }
.wv2 .v2-schedule-head strong { font-size:16px; overflow-wrap:anywhere; }
.wv2 .v2-schedule-head .v2-schedule-state { color:var(--v-muted); font-size:13px; }
.wv2 .v2-schedule-head .v2-schedule-state.on { color:var(--hub-brand-text); }
.wv2 .v2-schedules dl { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:2px 12px; margin:0; font-size:14px; }
.wv2 .v2-schedules dt { color:var(--v-muted); font-size:13px; }
.wv2 .v2-schedules dd { margin:0; overflow-wrap:anywhere; }
.wv2 .v2-schedules dd.failed { color:var(--v-alert); }
.wv2 .v2-schedules dd.missed { color:var(--v-amber); }
.wv2 .v2-schedules .v2-actions { display:flex; flex-wrap:wrap; gap:4px 14px; }
.wv2 .v2-schedules .v2-actions button { min-height:36px; }
.wv2 .v2-notice-actions { display:flex; flex-wrap:wrap; gap:2px 14px; margin-top:6px; }
.wv2 .v2-notice-actions .v2-link { min-height:34px; }
@media (max-width:700px) { .wv2 .v2-schedules .v2-actions button,.wv2 .v2-notice-actions .v2-link { min-height:44px; } }
`

function lastRun(row: Row): { text: string; tone?: 'failed' | 'missed' } {
  const run = row.lastRun
  if (!run) return { text: '还没有触发过' }
  const time = run.at ? readableTime(run.at) : run.slot.replace('T', ' ')
  if (run.status === 'failed' && row.retryLabel) return { text: `失败，第 ${run.attempts ?? 1} 次，将在 ${row.retryLabel} 重试：${run.detail ?? '原因未知'}`, tone: 'failed' }
  if (run.status === 'failed') return { text: `失败（${time}${run.attempts && run.attempts > 1 ? `，已试 ${run.attempts} 次` : ''}）：${run.detail ?? '原因未知'}`, tone: 'failed' }
  if (run.status === 'missed') return { text: `已错过：${run.detail ?? run.slot.replace('T', ' ')}`, tone: 'missed' }
  return { text: `已送达 · ${time}${run.detail ? `（${run.detail}）` : ''}` }
}

/** 「设置 → 定时安排」：全部安排，可开关、删除（删除需确认）；修改经接口人。 */
export function ScheduleSettings({ focus }: { focus?: boolean }) {
  const query = useV2Read(SCHEDULES, isScheduleList, 30_000)
  const write = useV2Write(isScheduleReceipt, false)
  const [message, setMessage] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const page = query.data
  const focused = useRef(false)
  useEffect(() => {
    if (!focus || !page || focused.current) return
    focused.current = true
    heading.current?.scrollIntoView({ block: 'start' })
    heading.current?.focus({ preventScroll: true })
  }, [focus, page])
  async function act(row: Row, action: 'enable' | 'disable' | 'remove') {
    if (action === 'remove' && !window.confirm(`删除定时安排「${row.title}」？删除后不会再提醒，需要时跟接口人说一句重新建立。`)) return
    setMessage('')
    const done = await write.post(SCHEDULES + '/' + encodeURIComponent(row.id), { action })
    if (!done) return
    await query.refresh()
    setMessage(action === 'remove' ? `已删除「${row.title}」。` : action === 'enable' ? `已开启「${row.title}」。` : `已停用「${row.title}」。`)
  }
  return <section aria-labelledby="v2-schedules-title" className="v2-settings-section" id="schedules">
    <h2 id="v2-schedules-title" ref={heading} tabIndex={-1}>定时安排</h2>
    <div>
      <Issue text={query.error} retry={query.refresh}/>
      {!page && !query.error && <p className="v2-quiet" role="status">正在读取定时安排…</p>}
      {page && <>
        <p><small>到点在接口人对话里提醒你{page.push ? '，同时推送到手机' : '；配置推送地址后也会推送到手机'}。时间按 {page.timeZone}。要新建或修改，跟接口人说一句，比如“工作日 9 点提醒我未关闭的工单”。</small></p>
        {!page.schedules.length && <p className="v2-quiet">还没有定时安排。跟接口人说一句，比如“工作日 9 点提醒我未关闭的工单”。</p>}
        {page.schedules.length > 0 && <ul className="v2-schedules" aria-label="定时安排">{page.schedules.map(row => {
          const last = lastRun(row)
          return <li key={row.id} data-schedule-id={row.id}>
            <div className="v2-schedule-head"><strong>{row.title}</strong>
              <span className={'v2-schedule-state' + (row.enabled ? ' on' : '')}>{row.enabled ? '已开启' : '已停用'}</span></div>
            <dl>
              <dt>时间</dt><dd>{row.whenLabel}</dd>
              <dt>下一次</dt><dd>{row.enabled ? row.nextLabel ?? '近期没有' : '停用中'}</dd>
              <dt>上一次</dt><dd className={last.tone}>{last.text}</dd>
              <dt>建立者</dt><dd>{BY_LABEL[row.by]}</dd>
            </dl>
            <div className="v2-actions">
              <button type="button" className="v2-link" disabled={write.busy} aria-label={(row.enabled ? '停用' : '开启') + '「' + row.title + '」'}
                onClick={() => { void act(row, row.enabled ? 'disable' : 'enable') }}>{row.enabled ? '停用' : '开启'}</button>
              {row.removable && <button type="button" className="v2-link" disabled={write.busy} aria-label={'删除「' + row.title + '」'}
                onClick={() => { void act(row, 'remove') }}>删除</button>}
            </div>
          </li>
        })}</ul>}
        <Issue text={write.error}/>
        {message && <p role="status">{message}</p>}
      </>}
    </div>
  </section>
}

/** 接口人对话里定时提醒下面的两个操作：停用这条安排、到设置里查看。 */
export function NoticeScheduleActions({ schedule, status, openSchedules }: { schedule: NoticeSchedule; status?: string; openSchedules?: () => void }) {
  const write = useV2Write(isScheduleReceipt, false)
  const [stopped, setStopped] = useState(false)
  const gone = !!status || stopped
  return <div className="v2-notice-actions">
    {gone ? stopped && !status && <small className="v2-notice-status" role="status">已停用</small>
      : <button type="button" className="v2-link" disabled={write.busy} onClick={async () => {
        if (await write.post(SCHEDULES + '/' + encodeURIComponent(schedule.id), { action: 'disable' })) setStopped(true)
      }}>停用这条安排</button>}
    {openSchedules && <button type="button" className="v2-link" onClick={openSchedules}>在设置中查看</button>}
    <Issue text={write.error}/>
  </div>
}

/** 「经验」面板：每周经验整理的定时安排（在设置里管理）。 */
export function DreamScheduleNote({ openSchedules }: { openSchedules?: () => void }) {
  const query = useV2Read(SCHEDULES, isScheduleList, 60_000)
  const dream = query.data?.schedules.find(row => row.content === 'dream')
  if (!dream) return null
  return <p className="v2-quiet v2-dream-schedule"><small>{dream.enabled ? `${dream.whenLabel} 自动整理` : '每周整理已停用'}
    {dream.enabled && dream.nextLabel ? ` · 下一次 ${dream.nextLabel}` : ''}</small>
    {openSchedules && <> · <button type="button" className="v2-link" onClick={openSchedules}>在设置中管理</button></>}</p>
}
