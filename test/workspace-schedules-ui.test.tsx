import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import * as api from '../src/client/api.ts'
import * as client from '../src/client/workspace-v2-api.ts'
import { isScheduleList } from '../src/client/workspace-v2-response.ts'
import { DreamScheduleNote, ScheduleSettings } from '../src/client/workspace-schedules.tsx'
import { WorkspaceLiaison } from '../src/client/workspace-liaison.tsx'

afterEach(() => vi.restoreAllMocks())

const row = (extra: Record<string, unknown>) => ({ id: 'open-orders-1a2b', title: '未关闭工单提醒', when: 'weekdays 09:00', content: 'open-orders', enabled: true,
  by: 'owner', createdAt: '2026-11-25T02:00:00.000Z', whenLabel: '工作日 09:00', removable: true, ...extra })
const list = { scope: 'brain', timeZone: 'Asia/Shanghai', push: false, schedules: [
  row({ next: '2026-11-26T01:00:00.000Z', nextLabel: '2026-11-26 周四 09:00' }),
  row({ id: 'weekly-dream', title: '每周经验整理', when: 'weekly sun 20:00', content: 'dream', by: 'system', whenLabel: '每周日 20:00', removable: false,
    nextLabel: '2026-11-29 周日 20:00', lastRun: { slot: '2026-11-22T20:00', at: '2026-11-22T12:00:30.000Z', status: 'failed', detail: '有 1 项经验没能整理', attempts: 3 } }),
  row({ id: 'morning-brief', title: '早报', content: 'brief', by: 'system', enabled: false, whenLabel: '工作日 08:30', removable: false }),
] }

function read(value: unknown) {
  vi.spyOn(client, 'useV2Read').mockImplementation((path, valid) => ({ data: path && valid(value as never, path) ? value as never : undefined, error: undefined, refresh: async () => {} }))
}

it('校验清单：缺字段或未知类别不被当作定时安排', () => {
  expect(isScheduleList(list)).toBe(true)
  expect(isScheduleList({ ...list, push: undefined })).toBe(false)
  expect(isScheduleList({ ...list, schedules: [row({ content: 'clock' })] })).toBe(false)
  expect(isScheduleList({ ...list, schedules: [row({ lastRun: { slot: 'x', at: 'y', status: 'maybe' } })] })).toBe(false)
})

it('「设置 → 定时安排」列出时间规则、下一次、上一次结果和建立者；系统项不能删除；说明投递位置', () => {
  read(list)
  const html = renderToStaticMarkup(<ScheduleSettings/>)
  expect(html).toContain('id="schedules"')
  expect(html).toMatch(/未关闭工单提醒.*已开启.*工作日 09:00.*2026-11-26 周四 09:00.*还没有触发过.*主人经接口人/s)
  expect(html).toContain('aria-label="删除「未关闭工单提醒」"')
  expect(html).not.toContain('删除「每周经验整理」')
  expect(html).toMatch(/失败（[^）]+，已试 3 次）：有 1 项经验没能整理/)
  read({ ...list, schedules: [row({ lastRun: { slot: '2026-11-26T09:00', at: '2026-11-26T01:01:00.000Z', status: 'failed', detail: '模型暂不可用', attempts: 1,
    retryAt: '2026-11-26T01:11:00.000Z' }, retryLabel: '09:11' })] })
  expect(renderToStaticMarkup(<ScheduleSettings/>)).toContain('失败，第 1 次，将在 09:11 重试：模型暂不可用')
  expect(html).toMatch(/早报.*已停用.*停用中.*系统内置/s)
  expect(html).toContain('aria-label="开启「早报」"')
  expect(html).toContain('到点在接口人对话里提醒你；配置推送地址后也会推送到手机')
  read({ ...list, push: true, schedules: [] })
  const empty = renderToStaticMarkup(<ScheduleSettings/>)
  expect(empty).toContain('，同时推送到手机')
  expect(empty).toContain('还没有定时安排。跟接口人说一句')
})

it('「经验」面板说明每周整理的时间并指向设置', () => {
  read(list)
  expect(renderToStaticMarkup(<DreamScheduleNote openSchedules={() => {}}/>)).toMatch(/每周日 20:00 自动整理 · 下一次 2026-11-29 周日 20:00.*在设置中管理/s)
  read({ ...list, schedules: [{ ...list.schedules[1], enabled: false }] })
  expect(renderToStaticMarkup(<DreamScheduleNote/>)).toContain('每周整理已停用')
})

it('接口人对话里的定时提醒带来源标记与「停用这条安排」「在设置中查看」；已停用的不再给停用按钮', () => {
  const notice = (status?: string) => ({ key: 'schedule:open-orders-1a2b:2026-11-26T09:00', at: '2026-11-26T01:00:00.000Z',
    text: '各工作区目前没有未关闭的工单。\n— 来自定时安排「未关闭工单提醒」· 工作日 09:00', schedule: { id: 'open-orders-1a2b', title: '未关闭工单提醒', when: '工作日 09:00' }, ...status && { status } })
  const chat = (notices: unknown[]) => vi.spyOn(api, 'useChat').mockReturnValue({ sessionId: 'hq', confirmedMessages: [], observedAt: 0, messages: [],
    live: undefined, notices, workReplies: [], busy: false, error: undefined, say: vi.fn(), refresh: vi.fn(), tick: 0 } as never)
  chat([notice()])
  const html = renderToStaticMarkup(<WorkspaceLiaison scope="brain" surface="today" changed={vi.fn()} close={vi.fn()} openProfileImport={vi.fn()}
    openWorkspace={vi.fn()} openSchedules={vi.fn()}/>)
  expect(html).toContain('— 来自定时安排「未关闭工单提醒」· 工作日 09:00')
  expect(html).toContain('停用这条安排')
  expect(html).toContain('在设置中查看')
  vi.restoreAllMocks()
  chat([notice('已停用')])
  const stopped = renderToStaticMarkup(<WorkspaceLiaison scope="brain" surface="today" changed={vi.fn()} close={vi.fn()} openProfileImport={vi.fn()}
    openWorkspace={vi.fn()} openSchedules={vi.fn()}/>)
  expect(stopped).toContain('已停用')
  expect(stopped).not.toContain('停用这条安排')
})
