import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { latestSlot, parseClock, slotKey } from '../src/core/clock.ts'
import { Engine, parseDecision, type Brain, type Executors, type RemoteQueue, type RemoteTask, type RunRequest, type RunResult } from '../src/core/engine.ts'
import type { Staff } from '../src/core/model.ts'
import { reportFromRemote, reportFromText } from '../src/core/report.ts'
import { FileStore } from '../src/core/store.ts'

const TZ = 'Asia/Shanghai'

describe('clock', () => {
  it('取最近一个到期时刻，并按本地时区出键', () => {
    const spec = parseClock('daily 08:30')
    const now = new Date('2026-11-15T01:00:00Z') // 上海 09:00
    const slot = latestSlot(spec, now, TZ)!
    expect(slotKey(slot, TZ)).toBe('2026-11-15T08:30')
    const early = latestSlot(spec, new Date('2026-11-14T23:00:00Z'), TZ)! // 上海 07:00 → 前一天
    expect(slotKey(early, TZ)).toBe('2026-11-14T08:30')
  })
  it('工作日跳过周末', () => {
    // 2026-11-15 是周日
    const slot = latestSlot(parseClock('weekdays 21:30'), new Date('2026-11-15T12:00:00Z'), TZ)!
    expect(slotKey(slot, TZ)).toBe('2026-11-13T21:30')
  })
  it('every 对齐到间隔', () => {
    const slot = latestSlot(parseClock('every 30m'), new Date('2026-11-15T01:47:00Z'), TZ)!
    expect(slotKey(slot, TZ)).toBe('2026-11-15T09:30')
  })
  it('拒绝无效写法', () => {
    expect(() => parseClock('daily 25:00')).toThrow()
    expect(() => parseClock('every 1m')).toThrow()
    expect(() => parseClock('weekly funday 10:00')).toThrow()
  })
})

describe('report', () => {
  it('取最后一个汇报块', () => {
    const text = '过程...\n```chief-report\n{"status":"question","summary":"做了一半","question":"用 A 还是 B？"}\n```'
    expect(reportFromText(text)).toMatchObject({ status: 'question', question: '用 A 还是 B？', structured: true })
  })
  it('没有汇报块时退化为待核验的 ready', () => {
    expect(reportFromText('写好了 work/T-0001/plan.md')).toMatchObject({ status: 'ready', structured: false })
    expect(reportFromText('')).toMatchObject({ status: 'failed' })
  })
  it('工作电脑的文本汇报仅从约定字段导入，兼容旧执行器的纯文本摘要', () => {
    const report = { status: 'question', summary: '等待资料', question: '选择哪个公开来源？', choices: ['来源甲', '来源乙'] }
    const body = JSON.stringify({ ...report, outputs: ['work/T-0001/local.txt'], document: 'unapproved fixture' })
    const framed = ['工具输出 unapproved fixture', '```chief-report', body, '```'].join('\n')
    expect(reportFromRemote(framed)).toEqual({ ...report, structured: false })
    expect(reportFromRemote(body)).toEqual({ ...report, structured: false })
    expect(reportFromRemote('旧运行器的简短结论')).toEqual({ status: 'ready', summary: '旧运行器的简短结论', structured: false })
    for (const invalid of [{ document: 'unapproved fixture' }, '{"document":"unapproved fixture"}', '```chief-report\n{"document":"unapproved fixture"}', '[{"document":"unapproved fixture"}]']) {
      const projection = reportFromRemote(invalid)
      expect(projection.status).toBe('failed')
      expect(JSON.stringify(projection)).not.toContain('unapproved fixture')
    }
  })
  it('研判决定缺字段时视为无效', () => {
    expect(parseDecision({ action: 'accept', title: 'x', staff: 'r', scope: 's', doneWhen: [] })).toBeUndefined()
    expect(parseDecision({ action: 'accept', title: 'x', staff: 'r', scope: 's', doneWhen: ['a'], level: 'write', priority: 9 }))
      .toMatchObject({ level: 'write', priority: 3 })
  })
})

// ───────── 引擎集成测试：假执行者 + 临时目录 ─────────

const STAFF: Staff[] = [
  { id: 'chief', name: '参谋长', executor: 'dsh', verifier: 'none', brief: '研判' },
  { id: 'researcher', name: '研究员', executor: 'dsh', verifier: 'reviewer', brief: '调研' },
  { id: 'liaison', name: '外务', executor: 'remote', verifier: 'reviewer', brief: '工作电脑' },
  { id: 'reviewer', name: '审查官', executor: 'dsh', verifier: 'none', brief: '审查' },
]

function setup(script: (request: RunRequest) => RunResult) {
  const root = mkdtempSync(join(tmpdir(), 'chief-'))
  const store = new FileStore(root)
  const commits: string[] = []
  const saved: string[] = []
  const archived: string[] = []
  const brain: Brain = {
    root, constitution: () => '主人刚入职', staff: () => STAFF, workspaces: () => [],
    workdir: id => join(root, 'work', id), appendNote: path => path, commit: message => { commits.push(message) },
    saveRemoteReport: (id, round, content) => {
      saved.push(`${id}#${round}`)
      archived.push(content)
      return `work/${id}/remote-report-${round + 1}.md`
    },
  }
  const calls: RunRequest[] = []
  const executors: Executors = {
    available: () => true, supportsSchema: () => true,
    run: async request => { calls.push(request); return script(request) },
  }
  const dispatched: RemoteTask[] = []
  const remote: RemoteQueue = { dispatch: task => { dispatched.push(task) }, cancel: () => {} }
  let clock = new Date('2026-11-15T01:00:00Z')
  const engine = new Engine(store, brain, executors, remote, { concurrency: 2, timeZone: TZ, now: () => clock })
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)) }
  return { root, store, engine, calls, commits, dispatched, saved, archived, settle, advance: (ms: number) => { clock = new Date(clock.getTime() + ms) } }
}

const accept = (staff = 'researcher', needsReview = false) => ({
  text: '', stopReason: 'completed',
  structured: { action: 'accept', reason: '值得做', title: '摸清团队', staff, level: 'think', scope: '整理团队结构', doneWhen: ['产出 team.md'], needsReview, priority: 2 },
})

describe('engine', () => {
  it('导入原文留下事件后写工单失败，重试可从原事件恢复同一张工单', async () => {
    const t = setup(() => accept())
    t.engine.setPaused(true)
    const spec = { text:'整理先前助手的资料', title:'整理资料', staff:'researcher', level:'think' as const,
      scope:'把原文整理成待确认的提案', doneWhen:['产出一份有出处的提案'], needsReview:true, requestKey:'assistant-import:retry' }
    vi.spyOn(t.store, 'saveTicket').mockImplementationOnce(() => { throw Error('模拟写盘中断') })
    await expect(t.engine.commission(spec)).rejects.toThrow('模拟写盘中断')
    const event = t.store.pendingEvents()[0]!
    expect(event.dedupe).toBe(spec.requestKey)
    vi.spyOn(t.store, 'setDisposition').mockImplementationOnce(() => { throw Error('模拟回执中断') })
    await expect(t.engine.commission(spec)).rejects.toThrow('模拟回执中断')
    const [first, repeated] = await Promise.all([t.engine.commission(spec),t.engine.commission(spec)])
    expect(first).toBe(repeated)
    expect(t.store.tickets()).toHaveLength(1)
    expect(t.store.ticket(first)?.mandate.eventId).toBe(event.id)
    expect(t.store.pendingEvents()).toEqual([])
  })

  it('事件 → 研判接单 → 执行 → 核验通过 → 完成', async () => {
    const t = setup(request => {
      if (request.staff.id === 'chief') return accept()
      if (request.staff.id === 'researcher') return { text: '', stopReason: 'completed', structured: { status: 'ready', summary: '写好了', outputs: ['team.md'] } }
      return { text: '', stopReason: 'completed', structured: { verdict: 'pass', critique: '满足' } }
    })
    expect(await t.engine.receive({ source: 'inbox', dedupe: 'inbox:1', text: '帮我摸清团队' })).toBe(true)
    expect(await t.engine.receive({ source: 'inbox', dedupe: 'inbox:1', text: '重复' })).toBe(false)
    await t.settle()
    const [view] = t.engine.views()
    expect(view?.stage).toBe('ended')
    expect(view?.ticket.ended?.outcome).toBe('done')
    expect(view?.ticket.mandate.strength).toBe('explicit')
    expect(t.calls.map(c => c.staff.id)).toEqual(['chief', 'researcher', 'reviewer'])
    // 审查官看不到执行过程，只拿到汇报摘要
    expect(t.calls[2]?.prompt).toContain('写好了')
    // 状态落盘
    expect(JSON.parse(readFileSync(join(t.root, 'ops/tickets/T-0001.json'), 'utf8')).ended.outcome).toBe('done')
  })

  it('只验收没执行的提案可以补执行，只执行一次；没验收的不能执行', async () => {
    const t = setup(request => {
      if (request.staff.id === 'chief') return accept('researcher', true)
      if (request.staff.id === 'researcher') return { text: '', stopReason: 'completed', structured: { status: 'ready', summary: '提案写好了' } }
      return { text: '', stopReason: 'completed', structured: { verdict: 'pass', critique: '满足' } }
    })
    await t.engine.receive({ source: 'inbox', dedupe: 'p', text: '整理一份提案' })
    await t.settle()
    const id = t.engine.views()[0]!.ticket.id
    await expect(t.engine.applyProposal(id)).rejects.toThrow('已经验收')
    await t.engine.accept(id) // 只验收
    expect(t.engine.views().some(v => v.ticket.title === `执行提案 ${id}`)).toBe(false)
    await t.engine.applyProposal(id)
    expect(t.engine.views().some(v => v.ticket.title === `执行提案 ${id}`)).toBe(true)
    await expect(t.engine.applyProposal(id)).rejects.toThrow('执行过')
  })

  it('审查要求返工：带着批评重新执行，轮数用尽后交给主人', async () => {
    let rounds = 0
    const t = setup(request => {
      if (request.staff.id === 'chief') return accept()
      if (request.staff.id === 'researcher') { rounds++; return { text: '', stopReason: 'completed', structured: { status: 'ready', summary: `第 ${rounds} 版` } } }
      return { text: '', stopReason: 'completed', structured: { verdict: 'revise', critique: '缺少汇报线' } }
    })
    await t.engine.receive({ source: 'inbox', dedupe: 'i', text: '摸清团队' })
    await t.settle()
    const [view] = t.engine.views()
    expect(rounds).toBe(3) // 首次 + 2 次返工
    expect(view?.stage).toBe('you/review')
    expect(t.calls.find(c => c.staff.id === 'researcher' && c.prompt.includes('缺少汇报线'))).toBeDefined()
    // 主人补充要求 → 回到排队并继续执行
    await t.engine.reply(view!.ticket.id, '汇报线问一下 HR')
    await t.settle()
    expect(rounds).toBe(4)
  })

  it('问题交给主人，回答后继续', async () => {
    let asked = false
    const t = setup(request => {
      if (request.staff.id === 'chief') return accept()
      if (request.staff.id === 'researcher') {
        if (!asked) { asked = true; return { text: '', stopReason: 'completed', structured: { status: 'question', summary: '需要确认', question: '看哪个部门？' } } }
        return { text: '', stopReason: 'completed', structured: { status: 'ready', summary: '好了' } }
      }
      return { text: '', stopReason: 'completed', structured: { verdict: 'pass', critique: 'ok' } }
    })
    await t.engine.receive({ source: 'inbox', dedupe: 'i', text: 'x' })
    await t.settle()
    const id = t.engine.views()[0]!.ticket.id
    expect(t.engine.views()[0]?.stage).toBe('you/answer')
    await t.engine.reply(id, '看 AI 平台部')
    await t.settle()
    expect(t.engine.views()[0]?.stage).toBe('ended')
  })

  it('propose 级别先等批准', async () => {
    const t = setup(request => request.staff.id === 'chief'
      ? { ...accept(), structured: { ...accept().structured, level: 'propose' } }
      : { text: '', stopReason: 'completed', structured: { status: 'ready', summary: 'ok' } })
    await t.engine.receive({ source: 'inbox', dedupe: 'i', text: 'x' })
    await t.settle()
    expect(t.engine.views()[0]?.stage).toBe('you/approve')
    expect(t.calls.length).toBe(1)
    await t.engine.approve(t.engine.views()[0]!.ticket.id)
    await t.settle()
    expect(t.calls.some(c => c.staff.id === 'researcher')).toBe(true)
  })

  it('重启恢复：执行中的派工被中断并重新执行', async () => {
    let hang = true
    const t = setup(request => {
      if (request.staff.id === 'chief') return accept()
      if (request.staff.id === 'researcher' && hang) return new Promise<RunResult>(() => {}) as unknown as RunResult
      return { text: '', stopReason: 'completed', structured: request.staff.id === 'researcher' ? { status: 'ready', summary: 'ok' } : { verdict: 'pass', critique: 'ok' } }
    })
    await t.engine.receive({ source: 'inbox', dedupe: 'i', text: 'x' })
    await t.settle()
    expect(t.engine.views()[0]?.stage).toBe('working')
    // 模拟进程重启：新引擎读同一份文件
    t.engine.stop()
    hang = false
    const store2 = new FileStore(t.root)
    const engine2 = new Engine(store2, {
      root: t.root, constitution: () => '', staff: () => STAFF, workspaces: () => [],
      workdir: id => join(t.root, 'work', id), appendNote: p => p, commit: () => {},
    }, { available: () => true, supportsSchema: () => true, run: async () => ({ text: '', stopReason: 'completed', structured: { status: 'ready', summary: 'ok', verdict: 'pass', critique: 'ok' } }) },
    { dispatch: () => {}, cancel: () => {} }, { concurrency: 2, timeZone: TZ })
    await engine2.recover()
    await t.settle()
    const ticket = engine2.views()[0]!.ticket
    expect(ticket.assignments[0]?.state).toBe('interrupted')
    expect(ticket.inputs.some(i => i.from === 'system' && i.text.includes('中断'))).toBe(true)
    expect(engine2.views()[0]?.stage).toBe('ended')
  })

  it('远程派工：写入队列，回传后核验；回传事件不再被研判', async () => {
    const t = setup(request => request.staff.id === 'chief' ? accept('liaison')
      : { text: '', stopReason: 'completed', structured: { verdict: 'pass', critique: 'ok' } })
    await t.engine.receive({ source: 'inbox', dedupe: 'i', text: '在工作电脑上整理周报' })
    await t.settle()
    expect(t.engine.views()[0]?.stage).toBe('remote')
    const task = t.dispatched[0]!
    // 发往工作电脑的提示不含第二大脑的路径与内容
    expect(task.prompt).not.toContain(t.root)
    expect(task.prompt).not.toContain('AGENTS.md')
    expect(task.prompt).toContain('chief-report')
    const report = { status: 'ready', summary: '周报已写好' }
    const payload = { ...report, question: 'unapproved fixture', outputs: ['work/T-0001/private.txt'], document: 'unapproved fixture' }
    expect(await t.engine.remoteReport(task.ticketId, task.assignmentId, payload)).toBe(true)
    expect(await t.engine.remoteReport(task.ticketId, task.assignmentId, payload)).toBe(true)
    expect(await t.engine.remoteReport(task.ticketId, task.assignmentId, { ...payload, document: 'another fixture' })).toBe(false)
    await t.settle()
    expect(t.engine.views()[0]?.stage).toBe('ended')
    expect(t.store.pendingEvents()).toHaveLength(0)
    expect(t.saved).toEqual(['T-0001#0'])
    expect(t.archived.map(content => JSON.parse(content))).toEqual([{ ...report, structured: false }])
    const ticket = t.store.ticket(task.ticketId)!
    expect(ticket.assignments[0]?.receipt).toBe(createHash('sha256').update(JSON.stringify(payload)).digest('hex'))
    expect(ticket.assignments[0]?.report?.outputs).toEqual(['work/T-0001/remote-report-1.md'])
    expect(JSON.stringify(ticket)).not.toContain('unapproved fixture')
    expect(ticket.events).toHaveLength(2)
    expect(t.calls.find(c => c.staff.id === 'reviewer')?.prompt).toContain('工作电脑')
    expect(t.calls.filter(c => c.staff.id === 'chief')).toHaveLength(1)
  })

  it('执行期间主人追加要求：核验通过也不结单，按主人的话继续', async () => {
    let release: () => void = () => {}
    let runs = 0
    const t = setup(request => {
      if (request.staff.id === 'chief') return accept()
      if (request.staff.id === 'researcher') {
        runs++
        if (runs === 1) return new Promise<RunResult>(resolve => { release = () => resolve({ text: '', stopReason: 'completed', structured: { status: 'ready', summary: 'v1' } }) }) as unknown as RunResult
        return { text: '', stopReason: 'completed', structured: { status: 'ready', summary: 'v2' } }
      }
      return { text: '', stopReason: 'completed', structured: { verdict: 'pass', critique: 'ok' } }
    })
    await t.engine.receive({ source: 'inbox', dedupe: 'i', text: 'x' })
    await t.settle()
    await t.engine.reply(t.engine.views()[0]!.ticket.id, '顺便把上下游也画上')
    release()
    await t.settle()
    expect(runs).toBe(2)
    expect(t.calls.find(c => c.staff.id === 'researcher' && c.prompt.includes('上下游'))).toBeDefined()
    expect(t.engine.views()[0]?.stage).toBe('ended')
  })

  it('停止后再回复：旧的核验结果不能结掉重新派出的工单', async () => {
    let releaseVerify: () => void = () => {}
    let verifies = 0
    const t = setup(request => {
      if (request.staff.id === 'chief') return accept()
      if (request.staff.id === 'researcher') return { text: '', stopReason: 'completed', structured: { status: 'ready', summary: 'ok' } }
      verifies++
      if (verifies === 1) return new Promise<RunResult>(resolve => { releaseVerify = () => resolve({ text: '', stopReason: 'completed', structured: { verdict: 'pass', critique: '旧的' } }) }) as unknown as RunResult
      return new Promise<RunResult>(() => {}) as unknown as RunResult // 第二次核验挂起
    })
    await t.engine.receive({ source: 'inbox', dedupe: 'i', text: 'x' })
    await t.settle()
    const id = t.engine.views()[0]!.ticket.id
    expect(t.engine.views()[0]?.stage).toBe('verifying')
    await t.engine.stopTicket(id, '先停')
    await t.engine.reply(id, '换个方向重做')
    await t.settle()
    releaseVerify()
    await t.settle()
    const view = t.engine.views()[0]!
    expect(view.ticket.ended).toBeUndefined()
    expect(view.ticket.assignments.at(-1)?.verification).toBeUndefined()
  })

  it('关闭时不把在途任务标为失败，重启后正常恢复', async () => {
    const t = setup(request => {
      if (request.staff.id === 'chief') return accept()
      return new Promise<RunResult>((_resolve, reject) => setTimeout(() => reject(new Error('aborted')), 5)) as unknown as RunResult
    })
    await t.engine.receive({ source: 'inbox', dedupe: 'i', text: 'x' })
    await t.settle()
    t.engine.stop()
    await new Promise(resolve => setTimeout(resolve, 20))
    await t.settle()
    const ticket = JSON.parse(readFileSync(join(t.root, 'ops/tickets/T-0001.json'), 'utf8'))
    expect(ticket.assignments[0].state).toBe('running')
  })

  it('研判失败的事件可以重新研判', async () => {
    let ok = false
    const t = setup(() => ok ? { text: '', stopReason: 'completed', structured: { action: 'ignore', reason: '好了' } } : { text: '', stopReason: 'completed', structured: { action: 'bogus' } })
    await t.engine.receive({ source: 'inbox', dedupe: 'a', text: 'a' })
    for (let i = 0; i < 3; i++) { await t.settle(); t.advance(120_000); t.engine.kick() }
    await t.settle()
    const [stuck] = t.engine.stuckEvents()
    expect(stuck?.event.text).toBe('a')
    ok = true
    await t.engine.retriage(stuck!.event.id)
    await t.settle()
    expect(t.engine.stuckEvents()).toHaveLength(0)
    expect(t.engine.recentEvents()[0]?.disposition?.kind).toBe('ignored')
  })

  it('工作电脑超时未回传：标为失败交给主人', async () => {
    const t = setup(request => request.staff.id === 'chief' ? accept('liaison') : { text: '', stopReason: 'completed' })
    await t.engine.receive({ source: 'inbox', dedupe: 'i', text: 'x' })
    await t.settle()
    t.advance(25 * 3_600_000)
    await t.engine.sweepRemote()
    expect(t.engine.views()[0]?.stage).toBe('you/blocked')
  })

  it('研判连续失败三次后标记为未完成，不阻塞后续事件', async () => {
    const t = setup(() => ({ text: '', stopReason: 'completed', structured: { action: 'bogus' } }))
    await t.engine.receive({ source: 'inbox', dedupe: 'a', text: 'a' })
    for (let i = 0; i < 3; i++) { await t.settle(); t.advance(120_000); t.engine.kick() }
    await t.settle()
    expect(t.engine.recentEvents()[0]?.disposition?.kind).toBe('unavailable')
  })
})

// DSH 结构化输出只接受 JSON Schema 子集（dsh-subagent 的 assertObjectJsonSchema）。
import { DECISION_SCHEMA, VERDICT_SCHEMA } from '../src/core/prompts.ts'
import { REPORT_SCHEMA } from '../src/core/report.ts'
const ALLOWED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title'])
function offending(schema: unknown, path = 'schema'): string[] {
  if (!schema || typeof schema !== 'object') return []
  const out: string[] = []
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED.has(key)) out.push(`${path}.${key}`)
    if (key === 'properties') for (const [k, v] of Object.entries(value as object)) out.push(...offending(v, `${path}.properties.${k}`))
    if (key === 'items' || key === 'additionalProperties') out.push(...offending(value, `${path}.${key}`))
    if (key === 'oneOf') (value as unknown[]).forEach((v, i) => out.push(...offending(v, `${path}.oneOf[${i}]`)))
  }
  return out
}
describe('结构化输出 Schema', () => {
  it('只使用 DSH 支持的关键字', () => {
    expect([DECISION_SCHEMA, VERDICT_SCHEMA, REPORT_SCHEMA].flatMap(s => offending(s))).toEqual([])
  })
})
