import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Engine, type Brain, type Executors, type RemoteTask, type RunRequest, type RunResult } from '../src/core/engine.ts'
import { threadIdOf, type Staff } from '../src/core/model.ts'
import { FileStore } from '../src/core/store.ts'
import { DshExecutors } from '../src/dsh/executors.ts'
import { runtimeRoutes, serveApi } from '../src/dsh/http.ts'
import { ticketThread } from '../src/dsh/view.ts'

const dispose: (() => void)[] = []
afterEach(() => { for (const fn of dispose.splice(0).reverse()) fn() })
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise(resolve => setImmediate(resolve)) }
const result = (structured: object): RunResult => ({ text: '', stopReason: 'completed', structured })

function fixture(script?: (request: RunRequest) => RunResult | Promise<RunResult>) {
  const root = mkdtempSync(join(tmpdir(), 'chief-thread-'))
  dispose.push(() => rmSync(root, { recursive: true, force: true }))
  const staff: Staff[] = [
    { id: 'writer', name: '研究员', executor: 'dsh', verifier: 'reviewer', brief: '原任务角色' },
    { id: 'reviewer', name: '审查官', executor: 'dsh', verifier: 'none', brief: '独立核验' },
  ]
  const commits: string[] = []
  const brain: Brain = { root, staff: () => staff, constitution: () => 'PRIVATE_LIAISON_CONTEXT', workspaces: () => [], rules: () => [], workdir: id => join(root, 'work', id), appendNote: p => p, commit: message => { commits.push(message) } }
  const store = new FileStore(root), calls: RunRequest[] = [], tasks: RemoteTask[] = []
  const executors: Executors = { available: () => true, supportsSchema: () => true, run: async request => {
    calls.push(request)
    await request.onStarted?.({ provider: 'spawn', activationId: `activation-${calls.length}`, sessionId: `session-${calls.length}` })
    return script?.(request) ?? result(request.staff.id === 'reviewer' ? { verdict: 'pass', critique: '证据满足原标准' } : { status: 'question', summary: '需要主人选择', question: '选哪种方案？', choices: ['方案甲', '方案乙'] })
  } }
  const remote = { dispatch: (task: RemoteTask) => { tasks.push(task) }, cancel() {} }
  const create = (s = store) => {
    const engine = new Engine(s, brain, executors, remote, { concurrency: 2, timeZone: 'UTC' })
    engine.setPaused(true)
    dispose.push(() => engine.stop())
    return engine
  }
  const engine = create()
  const routes = (e = engine) => [runtimeRoutes({ engine: e, brain, roster: {} } as never)]
  const api = async (method: 'GET' | 'POST', id: string, body?: object, e = engine, via: 'dsh' | 'public' = 'dsh', verb = 'thread') => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
    const req = Object.assign((async function* () { yield* chunks })(), { method, url: `/chief/api/tickets/${id}/${verb}`, headers: { 'x-chief-request': '1' } }) as unknown as IncomingMessage
    let status = 0, output = ''
    const res = { headersSent: false, writeHead(code: number) { status = code }, end(value: string) { output = value } } as unknown as ServerResponse
    await serveApi(req, res, via, routes(e))
    return { status, body: JSON.parse(output) }
  }
  const open = () => engine.commission({ text: '只处理本工单的明确交办', title: '隔离任务', staff: 'writer', level: 'think', scope: '原任务范围', doneWhen: ['交付原任务证据'], needsReview: true })
  const payload = (thread: NonNullable<ReturnType<typeof ticketThread>>, text = '按方案甲继续原任务') => ({ thread_id: thread.thread_id, ticket_id: thread.ticket_id, reply_to: thread.reply_to, execution_boundary: thread.execution_boundary, request_id: randomUUID(), text })
  const action = (verb: string, id: string, body: object) => api('POST', id, body, engine, 'dsh', verb)
  return { root, engine, store, brain, staff, calls, tasks, commits, api, action, open, payload, create }
}

describe('工单工作讨论', () => {
  it('只投影当前工单的持久输入、执行与独立核验，读取不启动任何会话', async () => {
    let writes = 0
    const f = fixture(request => request.staff.id === 'reviewer' ? result({ verdict: 'pass', critique: '独立检查了证据' }) : result(++writes === 1
      ? { status: 'question', summary: '先确定方案', question: '选哪种方案？', choices: ['方案甲', '方案乙'] }
      : { status: 'ready', summary: '已按方案甲补全证据' }))
    const id = await f.open(), another = await f.engine.commission({ text: 'OTHER_TICKET_PRIVATE', title: '别的任务', staff: 'writer', level: 'think', scope: '另一范围', doneWhen: ['另一交付'], needsReview: true })
    const before = readFileSync(join(f.root, 'ops', 'tickets', `${id}.json`), 'utf8')
    const read = await f.api('GET', id, undefined, f.engine, 'public')
    expect(read.status).toBe(200)
    expect(read.body.reply_to).toBeNull()
    expect(f.calls).toHaveLength(0)
    expect(readFileSync(join(f.root, 'ops', 'tickets', `${id}.json`), 'utf8')).toBe(before)
    expect(JSON.stringify(read.body)).not.toMatch(/PRIVATE_LIAISON_CONTEXT|OTHER_TICKET_PRIVATE/)
    await f.engine.stopTicket(another, '不执行其他任务')
    f.engine.setPaused(false); await settle()
    const question = (await f.api('GET', id)).body
    expect(question.messages.find((m: { role: string }) => m.role === 'staff')).toMatchObject({ staff_id: 'writer', question: '选哪种方案？', choices: ['方案甲', '方案乙'] })
    const original = f.payload(question)
    expect((await f.api('POST', id, original)).status).toBe(200)
    await settle()
    const thread = (await f.api('GET', id)).body
    expect(thread.stage).toBe('you/review')
    expect(thread.thread_id).toBe(question.thread_id)
    expect(thread.reply_to).not.toBe(question.reply_to)
    expect(thread.messages.some((m: { role: string; text: string }) => m.role === 'verifier' && m.text === '独立检查了证据')).toBe(true)
    expect(thread.executions[0]).toMatchObject({ activation_id: 'activation-1', session_id: 'session-1' })
    expect(f.calls.find(c => c.staff.id === 'writer' && c.prompt.includes(original.text))?.binding).toMatchObject({ ticketId: id })
    // 确认丢失后仍用原请求与原派工重试：当前派工已经变化，也只能确认原输入。
    const commitsBeforeRetry = f.commits.length
    expect((await f.api('POST', id, original)).status).toBe(200)
    expect(f.commits).toHaveLength(commitsBeforeRetry)
    expect(f.store.ticket(id)?.inputs.filter(i => i.key === `reply:${original.request_id}`)).toHaveLength(1)
    expect(writes).toBe(2)
    expect((await f.api('POST', id, { ...original, request_id: randomUUID() })).status).toBe(409)
    expect((await f.api('POST', id, { ...original, text: '篡改同一请求' })).status).toBe(409)
    await f.engine.accept(id)
    expect((await f.api('GET', id)).body.read_only).toBe(true)
    expect((await f.api('POST', id, f.payload(thread))).status).toBe(409)
    expect((await f.api('POST', id, original)).status).toBe(200)
    expect(f.store.ticket(id)?.ended?.outcome).toBe('done')
    f.engine.stop()
    const restored = f.create(new FileStore(f.root))
    await restored.recover()
    expect((await f.api('GET', id, undefined, restored)).body).toEqual((await f.api('GET', id)).body)
    expect((await f.api('POST', id, original, restored)).status).toBe(200)
    expect(writes).toBe(2)
  })

  it('同号工单也按讨论身份隔离；原始派工和幂等键不可改写', async () => {
    const a = fixture(), b = fixture()
    const first = await a.open(), second = await b.open()
    expect(first).toBe(second)
    const ta = (await a.api('GET', first)).body, tb = (await b.api('GET', second)).body
    expect(ta.thread_id).not.toBe(tb.thread_id)
    expect((await b.api('POST', second, a.payload(ta))).status).toBe(409)
    expect((await a.api('POST', first, { ...a.payload(ta), ticket_id: 'T-9999' })).status).toBe(409)
    expect((await a.api('POST', first, { text: '没有目标的回复' })).status).toBe(400)
    expect(a.store.ticket(first)?.inputs).toHaveLength(0)
    // 旧快照无需改写即可获得持久且跨大脑隔离的身份。
    const legacyA = { ...a.store.ticket(first)!, threadId: undefined }, legacyB = { ...b.store.ticket(second)!, threadId: undefined }
    expect(threadIdOf(legacyA)).not.toBe(threadIdOf(legacyB))
    a.store.saveTicket(legacyA)
    expect((await a.api('GET', first)).body.thread_id).toBe(threadIdOf(legacyA))
  })

  it('批准验收停止等决策在串行写入时校验讨论、当前派工和阶段，旧显式重开仍可用', async () => {
    const f = fixture(request => result(request.staff.id === 'reviewer' ? { verdict: 'pass', critique: '合格' } : { status: 'ready', summary: '可验收交付' }))
    const id = await f.open()
    f.engine.setPaused(false); await settle()
    const previous = (await f.api('GET', id)).body
    const fence = (thread: typeof previous) => ({ thread_id: thread.thread_id, reply_to: thread.reply_to, stage: thread.stage })
    await f.engine.reply(id, '补全原标准的证据'); await settle()
    const current = (await f.api('GET', id)).body
    expect(current.stage).toBe('you/review')
    expect(current.reply_to).not.toBe(previous.reply_to)
    for (const verb of ['accept', 'stop']) {
      expect((await f.action(verb, id, fence(previous))).status).toBe(409)
      expect((await f.action(verb, id, { ...fence(current), thread_id: 'another-brain-thread' })).status).toBe(409)
      expect((await f.action(verb, id, { ...fence(current), stage: 'working' })).status).toBe(409)
    }
    expect(f.store.ticket(id)?.ended).toBeUndefined()
    expect((await f.action('accept', id, fence(current))).status).toBe(200)
    expect(f.store.ticket(id)?.ended?.outcome).toBe('done')
    // 原来显式回复后重开的工作流保持兼容，新讨论入口则始终只读已结束工单。
    await f.engine.reply(id, '主人明确提出继续原工作'); await settle()
    expect(f.store.ticket(id)?.ended).toBeUndefined()
    expect((await f.api('GET', id)).body.stage).toBe('you/review')
  })

  it('显式来源事件标识保持不可变，同一来源重复仍返回 false', async () => {
    const f = fixture(), id = randomUUID()
    expect(await f.engine.receive({ id, source: 'inbox', dedupe: 'source:first', text: '第一条明确交办', observe: true })).toBe(true)
    expect(await f.engine.receive({ id, source: 'inbox', dedupe: 'source:first', text: '重试文本不替换原事件', observe: true })).toBe(false)
    await expect(f.engine.receive({ id, source: 'inbox', dedupe: 'source:forged', text: '冒用事件标识', observe: true })).rejects.toThrow('事件标识已存在')
    expect(f.store.event(id)?.text).toBe('第一条明确交办')
  })

  it('主人明确执行仍保留批准与验收，执行中输入不会被完成汇报吞掉', async () => {
    let release: ((result: RunResult) => void) | undefined, runs = 0
    const f = fixture(request => request.staff.id === 'reviewer' ? result({ verdict: 'pass', critique: '合格' }) : ++runs === 1
      ? new Promise<RunResult>(resolve => { release = resolve }) : result({ status: 'ready', summary: '已按主人新回复完成' }))
    const id = await f.engine.commission({ text: '需要批准的范围', title: '批准', staff: 'writer', level: 'propose', scope: '原授权', doneWhen: ['可核验交付'], needsReview: true })
    const queued = (await f.api('GET', id)).body
    expect((await f.api('POST', id, f.payload(queued, '先准备原授权内的内容'))).status).toBe(200)
    f.engine.setPaused(false); await settle()
    expect(f.calls).toHaveLength(0)
    expect((await f.api('GET', id)).body.stage).toBe('you/approve')
    await f.engine.approve(id); await settle()
    const running = (await f.api('GET', id)).body
    expect((await f.api('POST', id, f.payload(running, '补全原标准的证据'))).status).toBe(200)
    release!(result({ status: 'ready', summary: '第一版' })); await settle()
    expect(runs).toBe(2)
    expect((await f.api('GET', id)).body.stage).toBe('you/review')
    expect(f.store.ticket(id)?.ended).toBeUndefined()
  })

  it('自动返工的核验意见在讨论中只出现一次，相同的主人回复仍保留', async () => {
    let reviews = 0
    const f = fixture(request => result(request.staff.id === 'reviewer'
      ? ++reviews === 1 ? { verdict: 'revise', critique: '补全证据' } : { verdict: 'pass', critique: '合格' }
      : { status: 'ready', summary: '交付证据' }))
    const id = await f.open()
    f.engine.setPaused(false); await settle()
    expect(f.store.ticket(id)?.inputs.some(input => input.key?.startsWith('verification:'))).toBe(true)
    expect((await f.api('GET', id)).body.messages.filter((m: { text: string }) => m.text === '补全证据')).toHaveLength(1)
    await f.engine.reply(id, '补全证据'); await settle()
    const messages = (await f.api('GET', id)).body.messages.filter((m: { text: string }) => m.text === '补全证据')
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['verifier', 'owner'])
  })

  it('不会把私人回复随角色配置变化发到工作电脑；远程回复要求单独核对', async () => {
    const f = fixture(), id = await f.open()
    const local = (await f.api('GET', id)).body
    f.staff[0] = { ...f.staff[0]!, executor: 'remote' }
    expect((await f.api('POST', id, f.payload(local, 'PRIVATE_THREAD_INPUT'))).status).toBe(409)
    expect(f.store.ticket(id)?.inputs).toHaveLength(0)
    f.staff[0] = { ...f.staff[0]!, executor: 'dsh' }
    expect((await f.api('POST', id, f.payload(local, 'PRIVATE_THREAD_INPUT'))).status).toBe(200)
    f.staff[0] = { ...f.staff[0]!, executor: 'remote' }
    f.engine.setPaused(false); await settle()
    expect(f.tasks).toHaveLength(0)
    expect(f.store.ticket(id)?.assignments[0]?.report?.status).toBe('blocked')
    const g = fixture()
    g.staff[0] = { ...g.staff[0]!, executor: 'remote' }
    const remoteId = await g.open(), remote = (await g.api('GET', remoteId)).body, body = g.payload(remote, '已核对的工作端说明')
    expect(remote.execution_boundary).toBe('remote')
    expect((await g.api('POST', remoteId, body)).status).toBe(400)
    expect((await g.api('POST', remoteId, { ...body, allow_remote: true })).status).toBe(200)
    g.engine.setPaused(false); await settle()
    expect(g.tasks).toHaveLength(1)
    expect(g.tasks[0]?.prompt).toContain(body.text)
    expect(g.tasks[0]?.prompt).not.toContain('PRIVATE_LIAISON_CONTEXT')
    const h = fixture()
    h.staff[0] = { ...h.staff[0]!, executor: 'remote' }
    const driftId = await h.open(), drift = (await h.api('GET', driftId)).body
    expect((await h.api('POST', driftId, { ...h.payload(drift, '只在工作端执行'), allow_remote: true })).status).toBe(200)
    h.staff[0] = { ...h.staff[0]!, executor: 'dsh' }
    h.engine.setPaused(false); await settle()
    expect(h.calls).toHaveLength(0)
    expect(h.tasks).toHaveLength(0)
    expect(h.store.ticket(driftId)?.assignments[0]?.report).toMatchObject({ status: 'blocked', summary: expect.stringContaining('工作电脑') })
  })

  it('停止之后旧执行的 dropped 汇报不能覆写结束结果', async () => {
    let release: ((result: RunResult) => void) | undefined
    const f = fixture(() => new Promise<RunResult>(resolve => { release = resolve }))
    const id = await f.open()
    f.engine.setPaused(false); await settle()
    await f.engine.stopTicket(id, '主人明确停止')
    release!(result({ status: 'dropped', summary: '旧执行的迟到汇报' })); await settle()
    expect(f.store.ticket(id)?.ended).toMatchObject({ outcome: 'stopped', note: '主人明确停止' })
    expect(f.store.ticket(id)?.assignments[0]?.report).toBeUndefined()
  })
})

describe('执行身份', () => {
  it.each(['spawn', 'codex', 'claude-code'])('只给实际原生会话记录 session_id，%s 激活原样保留', async provider => {
    const references: object[] = []
    const context = {
      subagents: {
        getProvider: () => ({ capabilities: { outputSchema: true, agentOptions: true } }),
        startActivation: async () => ({ childId: 'actual-child', result: Promise.resolve({ output: [{ type: 'text', text: '汇报' }], stopReason: 'completed' }), dispose: async () => {} }),
      },
      sessionController: { resolveAgent: async () => ({ agent: { id: 'actual-child', session: { snapshotEvents: () => [] } } }) },
      logger: { warn() {} },
    }
    const executor = new DshExecutors(context as never, async () => ({ id: 'parent' }))
    await executor.run({ staff: { id: 'writer', name: '研究员', executor: provider === 'spawn' ? 'dsh' : provider, verifier: 'none', brief: '' }, label: '一次执行', prompt: '当前工单', cwd: '/tmp', onStarted: async reference => { references.push(reference) } }, new AbortController().signal)
    expect(references).toEqual([{ provider, activationId: 'actual-child', ...provider === 'spawn' ? { sessionId: 'actual-child' } : {} }])
  })
})
