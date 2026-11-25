/**
 * 定时安排：时间规则、存储与迁移、到点执行与投递（src/core/schedules.ts、src/dsh/schedules.ts）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeWhen, dueSlot, formatLocal, nextRun, validateSchedule } from '../src/core/schedules.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { Outbox } from '../src/dsh/outbox.ts'
import { openOrdersText, scheduleProducer, scheduleRoutes, scheduleRow, ScheduleRunner, ScheduleStore, SCHEDULES_FILE } from '../src/dsh/schedules.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'
import { liaisonUnread } from '../src/core/liaison-unread.ts'

const TZ = 'Asia/Shanghai'
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chief-schedules-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** 上海时间 → 时间点。 */
const local = (text: string) => new Date(text + ':00+08:00')

describe('时间规则', () => {
  it('when 与 at 二选一，拒绝 every，reminder 必须有 text，一次性须在将来且 180 天内', () => {
    const base = { title: '提醒', content: 'open-orders' as const }
    expect(() => validateSchedule({ ...base })).toThrow('要写且只写一个')
    expect(() => validateSchedule({ ...base, when: 'daily 09:00', at: '2026-12-01T09:00' })).toThrow('要写且只写一个')
    expect(() => validateSchedule({ ...base, when: 'every 30m' })).toThrow('不支持按间隔重复')
    expect(() => validateSchedule({ ...base, when: 'sometimes' })).toThrow('写法不对')
    expect(() => validateSchedule({ title: '提醒', content: 'reminder', when: 'daily 09:00' })).toThrow('reminder 需要 text')
    expect(() => validateSchedule({ ...base, title: '', when: 'daily 09:00' })).toThrow('title')
    expect(() => validateSchedule({ ...base, content: 'nope' as never, when: 'daily 09:00' })).toThrow('content')
    const now = local('2026-11-25T10:00')
    expect(() => validateSchedule({ ...base, at: '2026-11-25T09:00' }, { now, timeZone: TZ })).toThrow('已经过了')
    expect(() => validateSchedule({ ...base, at: '2027-06-01T09:00' }, { now, timeZone: TZ })).toThrow('180 天')
    expect(() => validateSchedule({ ...base, at: '2026-02-30T09:00' }, { now, timeZone: TZ })).toThrow('不存在')
    expect(validateSchedule({ ...base, when: ' Weekdays   09:00 ' })).toEqual({ ...base, when: 'weekdays 09:00' })
  })

  it('给人看的写法与下一次触发', () => {
    expect(describeWhen({ when: 'weekdays 09:00' })).toBe('工作日 09:00')
    expect(describeWhen({ when: 'weekly mon,tue,wed,thu,fri 09:00' })).toBe('工作日 09:00')
    expect(describeWhen({ when: 'daily 08:30' })).toBe('每天 08:30')
    expect(describeWhen({ when: 'weekly sun 20:00' })).toBe('每周日 20:00')
    expect(describeWhen({ when: 'weekly thu,mon 09:00' })).toBe('每周一、四 09:00')
    expect(describeWhen({ at: '2026-11-27T09:00' })).toBe('2026-11-27 09:00 一次')
    const friday = local('2026-11-27T10:00')
    expect(formatLocal(nextRun({ when: 'weekdays 09:00' }, friday, TZ)!, TZ)).toBe('2026-11-30 周一 09:00')
    expect(nextRun({ at: '2026-11-27T09:00', lastRun: { slot: '2026-11-27T09:00', at: '', status: 'delivered' } }, friday, TZ)).toBeUndefined()
    expect(dueSlot({ when: 'weekdays 09:00' }, local('2026-11-29T12:00'), TZ)?.key).toBe('2026-11-27T09:00')
    expect(dueSlot({ at: '2026-11-27T09:00' }, local('2026-11-27T08:59'), TZ)).toBeUndefined()
    expect(dueSlot({ at: '2026-11-27T09:00' }, local('2026-11-27T09:00'), TZ)?.key).toBe('2026-11-27T09:00')
  })
})

describe('存储与迁移', () => {
  it('没有旧数据时只补系统默认项：每周经验整理开启，早报晚报关闭', () => {
    const root = tmp()
    const store = new ScheduleStore(root, { timeZone: TZ })
    expect(store.migrated).toBe(true)
    expect(store.list().map(({ id, title, when, content, enabled, by }) => ({ id, title, when, content, enabled, by }))).toEqual([
      { id: 'weekly-dream', title: '每周经验整理', when: 'weekly sun 20:00', content: 'dream', enabled: true, by: 'system' },
      { id: 'morning-brief', title: '早报', when: 'weekdays 08:30', content: 'brief', enabled: false, by: 'system' },
      { id: 'evening-review', title: '晚报', when: 'weekdays 21:30', content: 'review', enabled: false, by: 'system' },
    ])
    expect(JSON.parse(readFileSync(join(root, 'ops', SCHEDULES_FILE), 'utf8')).version).toBe(1)
  })

  it('rules.yaml 的规则迁入一次：早晚报一律关闭、经验整理保留、其他转为停用提醒；rules 键删除，工作区与来源保留', () => {
    const root = tmp()
    mkdirSync(join(root, 'ops'), { recursive: true })
    writeFileSync(join(root, 'rules.yaml'), [
      '# 允许修改的工作区',
      'workspaces: [../code]',
      'sources:',
      '  stale-contact: off',
      'rules:',
      '  - { id: morning-brief, when: weekdays 08:30, text: 早报 }',
      '  - { id: evening-review, when: weekdays 21:30, text: 晚报, enabled: false }',
      '  - { id: weekly-dream, when: weekly sat 19:00, text: 整理 }',
      '  - { id: open-orders-reminder, when: weekdays 09:00, text: 提醒我未关闭的工单, enabled: false }',
      '  - { id: poll, when: every 30m, text: 太频繁 }',
      '',
    ].join('\n'))
    const now = local('2026-11-25T10:00')
    writeFileSync(join(root, 'ops', 'timers.json'), JSON.stringify([
      { id: 'a1b2c3d4', at: local('2026-11-27T09:00').toISOString(), text: '看周岚给没给评审意见', by: '接口人', createdAt: '2026-11-20T01:00:00.000Z' },
      { id: 'old', at: local('2026-11-24T09:00').toISOString(), text: '已经过去', by: '接口人', createdAt: '2026-11-20T01:00:00.000Z' },
    ]))
    const brain = new BrainRepo(root)
    const commit = vi.spyOn(brain, 'commit').mockImplementation(() => {})
    const warn = vi.fn()
    const store = new ScheduleStore(root, { timeZone: TZ, now: () => now, takeLegacyRules: save => brain.takeLegacyRules(save), warn })
    const rows = Object.fromEntries(store.list().map(row => [row.id, row]))
    expect(rows['morning-brief']).toMatchObject({ content: 'brief', when: 'weekdays 08:30', enabled: false, by: 'system', title: '早报' })
    expect(rows['evening-review']).toMatchObject({ content: 'review', enabled: false, by: 'system', title: '晚报' })
    expect(rows['weekly-dream']).toMatchObject({ content: 'dream', when: 'weekly sat 19:00', enabled: true, by: 'system' })
    expect(rows['open-orders-reminder']).toMatchObject({ content: 'reminder', text: '提醒我未关闭的工单', enabled: false, by: 'owner', title: 'open-orders-reminder' })
    expect(rows['followup-a1b2c3d4']).toMatchObject({ content: 'reminder', at: '2026-11-27T09:00', text: '看周岚给没给评审意见', by: 'liaison', enabled: true })
    expect(Object.keys(rows)).toHaveLength(5)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('poll'))
    expect(existsSync(join(root, 'ops', 'timers.json'))).toBe(false)
    const yaml = readFileSync(join(root, 'rules.yaml'), 'utf8')
    expect(yaml).not.toMatch(/rules:/)
    expect(yaml).toContain('# 允许修改的工作区')
    expect(brain.workspaces()).toEqual([join(root, '..', 'code')])
    expect(brain.sourceMode('stale-contact', 'observe')).toBe('off')
    expect(commit).toHaveBeenCalledWith(expect.stringContaining('定时规则迁到 SuperHub 定时安排'), { paths: ['rules.yaml'] })

    // 只迁一次：rules 键又出现也不再读取，只提示。
    writeFileSync(join(root, 'rules.yaml'), 'rules:\n  - { id: again, when: daily 09:00, text: 又写了 }\n')
    const reopened = new ScheduleStore(root, { timeZone: TZ, takeLegacyRules: save => brain.takeLegacyRules(save) })
    expect(reopened.migrated).toBe(false)
    expect(reopened.get('again')).toBeUndefined()
    expect(brain.hasLegacyRules()).toBe(true)
    expect(readFileSync(join(root, 'rules.yaml'), 'utf8')).toContain('again')
  })

  it('非映射的 rules.yaml 原样保留', () => {
    const root = tmp()
    writeFileSync(join(root, 'rules.yaml'), '[]\n')
    const brain = new BrainRepo(root)
    const commit = vi.spyOn(brain, 'commit').mockImplementation(() => {})
    const store = new ScheduleStore(root, { timeZone: TZ, takeLegacyRules: save => brain.takeLegacyRules(save) })
    expect(store.list()).toHaveLength(3)
    expect(readFileSync(join(root, 'rules.yaml'), 'utf8')).toBe('[]\n')
    expect(commit).not.toHaveBeenCalled()
  })

  it('删除后清单与运行数据里都没有；系统项只能停用；完成满 7 天的一次性安排被清理', () => {
    const root = tmp()
    let now = local('2026-11-25T10:00')
    const store = new ScheduleStore(root, { timeZone: TZ, now: () => now })
    const { schedule } = store.upsert({ title: '未关闭工单提醒', when: 'weekdays 09:00', content: 'open-orders' }, 'owner')
    store.remove(schedule.id)
    expect(store.get(schedule.id)).toBeUndefined()
    expect(readFileSync(store.file, 'utf8')).not.toContain(schedule.id)
    expect(() => store.remove('weekly-dream')).toThrow('不能删除')
    expect(() => store.remove('missing')).toThrow('没有这条')
    const once = store.upsert({ title: '跟进', at: '2026-11-26T09:00', content: 'reminder', text: '看看' }, 'liaison').schedule
    store.recordRun(once.id, { slot: '2026-11-26T09:00', at: local('2026-11-26T09:00').toISOString(), status: 'delivered' })
    now = local('2026-12-02T10:00')
    store.prune(now)
    expect(store.get(once.id)).toBeDefined()
    now = local('2026-12-03T10:00')
    store.prune(now)
    expect(store.get(once.id)).toBeUndefined()
  })
})

function runnerFixture(options: { produce?: ScheduleRunnerProduce; start?: string } = {}) {
  const root = tmp()
  let now = local(options.start ?? '2026-11-25T10:00')
  const clock = { set: (text: string) => { now = local(text) }, now: () => now }
  const store = new ScheduleStore(root, { timeZone: TZ, now: clock.now })
  const outbox = new Outbox(join(root, 'ops', 'outbox.json'))
  const produce = vi.fn(options.produce ?? (async () => '各工作区目前没有未关闭的工单。'))
  const runner = () => new ScheduleRunner({ store, outbox, timeZone: TZ, now: clock.now, produce })
  return { root, store, outbox, produce, runner, clock }
}
type ScheduleRunnerProduce = ConstructorParameters<typeof ScheduleRunner>[0]['produce']

describe('到点执行与投递', () => {
  it('同一时段只投一次：重启后不重复；带来源标记；计入接口人未读', async () => {
    const f = runnerFixture()
    const { schedule } = f.store.upsert({ title: '未关闭工单提醒', when: 'weekdays 09:00', content: 'open-orders' }, 'owner')
    await f.runner().tick()
    expect(f.produce).not.toHaveBeenCalled()  // 今天 09:00 早于建立时间：既不补投也不记错过
    expect(f.store.get(schedule.id)?.lastRun).toBeUndefined()
    f.clock.set('2026-11-26T09:00')
    const first = f.runner()
    await Promise.all([first.tick(), first.tick()])
    await first.tick()
    await f.runner().tick()  // 重启后的新执行器
    expect(f.produce).toHaveBeenCalledTimes(1)
    const notices = f.outbox.recent(10)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ key: `schedule:${schedule.id}:2026-11-26T09:00`, push: 'pending',
      schedule: { id: schedule.id, title: '未关闭工单提醒', when: '工作日 09:00' } })
    expect(notices[0]!.text).toBe('各工作区目前没有未关闭的工单。\n— 来自定时安排「未关闭工单提醒」· 工作日 09:00')
    expect(f.store.get(schedule.id)?.lastRun).toMatchObject({ slot: '2026-11-26T09:00', status: 'delivered' })
    expect(liaisonUnread({ messages: [], notices }, local('2026-11-26T08:00').getTime()).unread).toBe(1)
    // 重启时 lastRun 没来得及写：发件箱的键挡住重复，补记为已送达。
    const lost = new Outbox(join(f.root, 'ops', 'outbox.json'))
    f.store.recordRun(schedule.id, { slot: '2026-11-25T09:00', at: '', status: 'delivered' })
    await new ScheduleRunner({ store: f.store, outbox: lost, timeZone: TZ, now: f.clock.now, produce: f.produce }).tick()
    expect(f.produce).toHaveBeenCalledTimes(1)
    expect(f.store.get(schedule.id)?.lastRun?.slot).toBe('2026-11-26T09:00')
  })

  it('停用后不投；错过超出宽限记为已错过；宽限内补投一次', async () => {
    const f = runnerFixture()
    const { schedule } = f.store.upsert({ title: '提醒', when: 'daily 09:00', content: 'reminder', text: '喝水' }, 'owner')
    f.store.setEnabled(schedule.id, false)
    f.clock.set('2026-11-26T09:00')
    await f.runner().tick()
    expect(f.produce).not.toHaveBeenCalled()
    f.store.setEnabled(schedule.id, true)  // 重新打开：停用期间的时段不补
    await f.runner().tick()
    expect(f.produce).not.toHaveBeenCalled()
    f.clock.set('2026-11-27T16:00')  // 09:00 过了 7 小时
    await f.runner().tick()
    expect(f.store.get(schedule.id)?.lastRun).toMatchObject({ slot: '2026-11-27T09:00', status: 'missed', detail: expect.stringContaining('2026-11-27 周五 09:00') })
    f.clock.set('2026-11-28T14:00')  // 5 小时内补投
    await f.runner().tick()
    expect(f.produce).toHaveBeenCalledTimes(1)
    expect(f.store.get(schedule.id)?.lastRun).toMatchObject({ slot: '2026-11-28T09:00', status: 'delivered' })
  })

  it('失败后隔 10 分钟重试：重试成功只投一次正文，不投失败说明；清单显示第几次、何时重试', async () => {
    const f = runnerFixture()
    f.produce.mockRejectedValueOnce(new Error('接口人的模型暂不可用')).mockResolvedValueOnce('早报正文')
    const { schedule } = f.store.upsert({ title: '早报 2', when: 'daily 09:00', content: 'brief' }, 'owner')
    f.clock.set('2026-11-26T09:01')
    await f.runner().tick()
    expect(f.outbox.recent(5)).toEqual([])
    expect(f.store.get(schedule.id)?.lastRun).toMatchObject({ slot: '2026-11-26T09:00', status: 'failed', attempts: 1, detail: '接口人的模型暂不可用',
      retryAt: local('2026-11-26T09:11').toISOString() })
    expect(scheduleRow(f.store.get(schedule.id)!, f.clock.now(), TZ).retryLabel).toBe('09:11')
    f.clock.set('2026-11-26T09:10')
    await f.runner().tick()  // 还没到重试时间
    expect(f.produce).toHaveBeenCalledTimes(1)
    f.clock.set('2026-11-26T09:11')
    await f.runner().tick()  // 重启后的执行器照样按记录重试
    await f.runner().tick()
    expect(f.produce).toHaveBeenCalledTimes(2)
    expect(f.outbox.recent(5).map(row => row.text)).toEqual(['早报正文\n— 来自定时安排「早报 2」· 每天 09:00'])
    expect(f.store.get(schedule.id)?.lastRun).toMatchObject({ status: 'delivered' })
    expect(scheduleRow(f.store.get(schedule.id)!, f.clock.now(), TZ)).not.toHaveProperty('retryLabel')
  })

  it('连续三次失败：只在第三次后投一条失败说明，之后不再试', async () => {
    const f = runnerFixture({ produce: async () => { throw new Error('接口人的模型暂不可用') } })
    const { schedule } = f.store.upsert({ title: '早报 2', when: 'daily 09:00', content: 'brief' }, 'owner')
    for (const time of ['09:01', '09:11', '09:21', '09:31', '10:30']) {
      f.clock.set('2026-11-26T' + time)
      await f.runner().tick()
    }
    expect(f.produce).toHaveBeenCalledTimes(3)
    expect(f.outbox.recent(5).map(row => row.text)).toEqual(['定时安排「早报 2」这次没能完成（已试 3 次）：接口人的模型暂不可用。\n— 来自定时安排「早报 2」· 每天 09:00'])
    expect(f.store.get(schedule.id)?.lastRun).toEqual({ slot: '2026-11-26T09:00', at: local('2026-11-26T09:21').toISOString(), status: 'failed',
      detail: '接口人的模型暂不可用', attempts: 3 })
  })

  it('重试会超出宽限时不再试，直接说明失败；宿主停到宽限之后也只说明一次', async () => {
    const f = runnerFixture({ produce: async () => { throw new Error('读不到工作区') } })
    const { schedule } = f.store.upsert({ title: '提醒', when: 'daily 09:00', content: 'open-orders' }, 'owner')
    f.clock.set('2026-11-26T14:55')  // 宽限 6 小时：下一次 15:05 已超出
    await f.runner().tick()
    expect(f.produce).toHaveBeenCalledTimes(1)
    expect(f.outbox.recent(5)).toHaveLength(1)
    expect(f.store.get(schedule.id)?.lastRun).toMatchObject({ status: 'failed', attempts: 1 })
    expect(f.store.get(schedule.id)?.lastRun).not.toHaveProperty('retryAt')

    const g = runnerFixture({ produce: async () => { throw new Error('读不到工作区') } })
    const other = g.store.upsert({ title: '提醒', when: 'daily 09:00', content: 'open-orders' }, 'owner').schedule
    g.clock.set('2026-11-26T09:01')
    await g.runner().tick()
    g.clock.set('2026-11-26T16:00')  // 宿主停了，回来时已超出宽限
    await g.runner().tick()
    await g.runner().tick()
    expect(g.produce).toHaveBeenCalledTimes(1)
    expect(g.outbox.recent(5).map(row => row.text)).toEqual(['定时安排「提醒」这次没能完成：读不到工作区。\n— 来自定时安排「提醒」· 每天 09:00'])
    expect(g.store.get(other.id)?.lastRun).toMatchObject({ status: 'failed', attempts: 1 })
  })

  it('执行中被删除不投递', async () => {
    const g = runnerFixture()
    const removed = g.store.upsert({ title: '会被删', when: 'daily 09:00', content: 'open-orders' }, 'owner').schedule
    g.produce.mockImplementation(async () => { g.store.remove(removed.id); return '内容' })
    g.clock.set('2026-11-26T09:01')
    await g.runner().tick()
    expect(g.outbox.recent(5)).toEqual([])
  })

  it('一次性跟进到点投递，之后不再触发', async () => {
    const f = runnerFixture({ produce: scheduleProducer({ timeZone: TZ, workspaces: { list: () => [], view: () => { throw new Error('no') } } }) })
    f.store.upsert({ title: '跟进：看评审', at: '2026-11-27T09:00', content: 'reminder', text: '看周岚给没给评审意见' }, 'liaison')
    f.clock.set('2026-11-27T09:00')
    await f.runner().tick()
    f.clock.set('2026-11-28T09:00')
    await f.runner().tick()
    expect(f.outbox.recent(5).map(row => row.text)).toEqual(['接口人跟进：看周岚给没给评审意见\n— 来自定时安排「跟进：看评审」· 2026-11-27 09:00 一次'])
  })

  it('经验整理调用每周整理：本时段做过就不投递，失败给出原因', async () => {
    const scheduled = vi.fn().mockResolvedValueOnce({ processed: 2, changes: 1, pending: 0, failed: 0 }).mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ processed: 1, changes: 0, pending: 1, failed: 1 })
    const produce = scheduleProducer({ timeZone: TZ, workspaces: { list: () => [], view: () => { throw new Error('no') } }, learning: { scheduled } })
    const dream = { id: 'weekly-dream', title: '每周经验整理', when: 'weekly sun 20:00', content: 'dream' as const, enabled: true, by: 'system' as const, createdAt: '' }
    expect(await produce(dream, '2026-11-29T20:00', new Date())).toBe('本周经验整理已完成，新整理的候选在各工作区「经验」里等你核对。')
    expect(scheduled).toHaveBeenCalledWith('2026-11-29T20:00')
    expect(await produce(dream, '2026-11-29T20:00', new Date())).toBeUndefined()
    await expect(produce(dream, '2026-12-06T20:00', new Date())).rejects.toThrow('有 1 项经验没能整理')
  })
})

describe('早报与晚报', () => {
  it('由接口人的模型依据快照撰写；模型不可用时给出失败原因', async () => {
    const requests: { system: string; input: Record<string, unknown> }[] = []
    const llm = { stream: async function* (options: { system: string; messages: { content: { text: string }[] }[] }) {
      requests.push({ system: options.system, input: JSON.parse(options.messages[0]!.content[0]!.text) })
      yield { type: 'text-delta', text: '今天最该处理的是首页。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const view = { orders: [{ id: 'a', title: '首页', status: 'active', acceptance: { awaitingOwner: true } }, { id: 'b', title: '已交付', status: 'done', completedAt: local('2026-11-26T07:00').toISOString() }] }
    const workspaces = { list: () => [{ id: 'w', name: '字节 Landing' }], view: () => view } as never
    const calendarWeek = vi.fn(async () => ({ entries: [{ id: 'm', sourceId: 's', kind: 'meeting', title: '评审会', start: '2026-11-26T15:00' }, { id: 'n', sourceId: 's', kind: 'meeting', title: '明天的', start: '2026-11-27T10:00' }], issues: [] }) as never)
    const produce = scheduleProducer({ timeZone: TZ, workspaces, llm: () => llm as never, model: () => ({ provider: 'p', model: 'm' }), calendarWeek })
    const brief = { id: 'morning-brief', title: '早报', when: 'weekdays 08:30', content: 'brief' as const, text: '先说风险', enabled: true, by: 'system' as const, createdAt: '' }
    expect(await produce(brief, '2026-11-26T08:30', local('2026-11-26T08:30'))).toBe('今天最该处理的是首页。')
    expect(requests[0]!.system).toContain('早报')
    expect(requests[0]!.system).toContain('不编造')
    expect(requests[0]!.input).toMatchObject({ today: '2026-11-26', ownerRequest: '先说风险',
      openOrders: [{ workspace: '字节 Landing', title: '首页', state: '等你验收' }], waitingForOwner: [{ title: '首页' }],
      completedToday: [{ title: '已交付' }], agenda: [{ title: '评审会' }] })
    expect(calendarWeek).toHaveBeenCalledWith('2026-11-26')
    const offline = scheduleProducer({ timeZone: TZ, workspaces, llm: () => undefined, model: () => undefined })
    await expect(offline({ ...brief, content: 'review' }, '', new Date())).rejects.toThrow('接口人的模型暂不可用')
  })
})

describe('未关闭工单汇总', () => {
  it('与各工作区实际未关闭的工单一致：已完成、已取消、已归档的不算，最多列 5 张，标出等你验收和已暂停', async () => {
    const root = tmp()
    const store = new WorkspaceV2Store(root, 'brain-schedules')
    cleanup.push(() => store.dispose())
    let seq = 0
    const space = (name: string) => {
      const body = { requestId: 'w-' + ++seq, name }
      store.createWorkspace(mutationKey(['v2', 'workspaces'], body), body)
      return store.list().find(row => row.name === name)!
    }
    const order = (w: ReturnType<typeof space>, title: string) => {
      const body = { requestId: 'o-' + ++seq, title }
      return store.createDelegation(mutationKey(['v2', 'workspaces', w.id, 'orders'], body), w, body).delegation
    }
    const produce = scheduleProducer({ timeZone: TZ, workspaces: store })
    const run = () => produce({ id: 'x', title: 'x', when: 'daily 09:00', content: 'open-orders', enabled: true, by: 'owner', createdAt: '' }, '', new Date())
    {
      expect(await run()).toBe('各工作区目前没有未关闭的工单。')
      const landing = space('字节 Landing'), research = space('访谈'), old = space('旧项目')
      const titles = ['首页', '报名页', '价格页', '文案', '埋点', '部署', '复盘']
      const orders = titles.map(title => order(landing, title))
      const done = order(research, '已交付'), cancelled = order(research, '已取消'), paused = order(research, '整理访谈')
      order(old, '归档里的')
      store.act(mutationKey(['act'], { requestId: 'done' }), research.id, done.id, { action: 'complete' })
      store.act(mutationKey(['act'], { requestId: 'cancel' }), research.id, cancelled.id, { action: 'cancel' })
      store.act(mutationKey(['act'], { requestId: 'pause' }), research.id, paused.id, { action: 'pause' })
      store.act(mutationKey(['act'], { requestId: 'close-old' }), old.id, store.view(old.id).orders[0]!.id, { action: 'cancel' })
      store.archive(mutationKey(['archive'], { requestId: 'archive' }), old.id)
      expect(orders).toHaveLength(7)
      expect(await run()).toBe([
        '各工作区共有 8 张未关闭的工单：',
        '「字节 Landing」7 张', '· 首页（已接手）', '· 报名页（已接手）', '· 价格页（已接手）', '· 文案（已接手）', '· 埋点（已接手）', '· 另有 2 张',
        '「访谈」1 张', '· 整理访谈（已暂停）',
      ].join('\n'))
    }
  })

  it('等你验收的单在结尾单列', () => {
    const order = (title: string, extra = {}) => ({ id: title, title, status: 'active', ...extra }) as never
    expect(openOrdersText([{ workspace: '甲', orders: [order('首页', { acceptance: { awaitingOwner: true } }), order('文案')] }]))
      .toBe('各工作区共有 2 张未关闭的工单：\n「甲」2 张\n· 首页（等你验收）\n· 文案（执行中）\n需要你处理：「首页」等你验收。')
  })
})

describe('HTTP', () => {
  it('列出、开关、删除；需要主人与当前 scope；拨钟入口只在给出时存在', async () => {
    const root = tmp()
    const now = local('2026-11-25T10:00')
    const store = new ScheduleStore(root, { timeZone: TZ, now: () => now })
    const { schedule } = store.upsert({ title: '未关闭工单提醒', when: 'weekdays 09:00', content: 'open-orders' }, 'owner')
    const route = scheduleRoutes({ scope: 's1', timeZone: TZ, store, push: () => true, now: () => now })
    const replies: { status: number; body: Record<string, unknown> }[] = []
    const res = { writeHead: (status: number) => { replies.push({ status, body: {} }) }, end: (text: string) => { replies.at(-1)!.body = JSON.parse(text) } } as never
    const call = (method: string, path: string, body: Record<string, unknown> = {}, owner = true) => {
      const url = new URL('http://x/chief/api' + path)
      return route({ method, path, url, seg: url.pathname.split('/').slice(3).filter(Boolean), via: 'dsh', body, owner }, res)
    }
    expect(await call('GET', '/v2/schedules?scope=s1')).toBe(true)
    const list = replies.at(-1)!.body as { push: boolean; schedules: { id: string; nextLabel?: string; removable: boolean; whenLabel: string }[] }
    expect(list.push).toBe(true)
    expect(list.schedules.find(row => row.id === schedule.id)).toMatchObject({ whenLabel: '工作日 09:00', nextLabel: '2026-11-26 周四 09:00', removable: true })
    expect(list.schedules.find(row => row.id === 'morning-brief')).toMatchObject({ removable: false })
    expect(list.schedules.find(row => row.id === 'morning-brief')).not.toHaveProperty('next')
    await expect(call('GET', '/v2/schedules?scope=s2')).rejects.toMatchObject({ status: 409 })
    await expect(call('GET', '/v2/schedules?scope=s1', {}, false)).rejects.toMatchObject({ status: 403 })
    await call('POST', `/v2/schedules/${schedule.id}?scope=s1`, { action: 'disable' })
    expect(store.get(schedule.id)?.enabled).toBe(false)
    await expect(call('POST', '/v2/schedules/weekly-dream?scope=s1', { action: 'remove' })).rejects.toMatchObject({ status: 409 })
    await call('POST', `/v2/schedules/${schedule.id}?scope=s1`, { action: 'remove' })
    expect(store.get(schedule.id)).toBeUndefined()
    await expect(call('POST', `/v2/schedules/${schedule.id}?scope=s1`, { action: 'enable' })).rejects.toMatchObject({ status: 404 })
    expect(await call('POST', '/v2/schedules/debug/tick?scope=s1', { now: now.toISOString() })).toBe(false)
    const ticks: Date[] = []
    const debug = scheduleRoutes({ scope: 's1', timeZone: TZ, store, push: () => false, debugTick: async at => { ticks.push(at) } })
    const url = new URL('http://x/chief/api/v2/schedules/debug/tick?scope=s1')
    expect(await debug({ method: 'POST', path: url.pathname, url, seg: ['v2', 'schedules', 'debug', 'tick'], via: 'dsh', body: { now: now.toISOString() }, owner: true }, res)).toBe(true)
    expect(ticks).toEqual([now])
  })
})
