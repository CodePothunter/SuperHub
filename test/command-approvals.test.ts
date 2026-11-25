import { mkdtempSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Brain, type Executors, type RunRequest, type RunResult } from '../src/core/engine.ts'
import type { Staff, Ticket } from '../src/core/model.ts'
import { FileStore } from '../src/core/store.ts'
import { approvalEnding, approvalNotice, commandApprovals, DEFAULT_APPROVAL_TIMEOUT_MINUTES, type PendingCommand } from '../src/dsh/approvals.ts'
import { approvalWire, codexAppServerArgv, DENY_DECISION, type Trace } from '../src/dsh/codex-approvals.ts'
import { codexDiagnostic } from '../src/dsh/executors.ts'
import { runtimeRoutes, serveApi } from '../src/dsh/http.ts'
import { Outbox } from '../src/dsh/outbox.ts'
import type { HostContext } from '../src/dsh/ports.ts'

const host = { logger: { warn: () => {}, info: () => {} } } as unknown as HostContext
const view = { ticket: 'T-0018', title: '分组探路', staff: '工程师', staffId: 'engineer', command: 'arkcli query --project demo', workdir: '/tmp/work', mode: 'danger-full-access' as const, reason: '需要联网', executor: 'codex' as const, assignmentId: 'a-1' }

afterEach(() => { vi.useRealTimers() })

describe('command approval window', () => {
  it('defaults to 30 minutes, notifies at request time, and expires as unavailable', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-19T09:13:11Z') })
    const asked: PendingCommand[] = []
    const approvals = commandApprovals(host, () => undefined, { onRequest: row => asked.push(row) })
    expect(approvals.timeoutMinutes).toBe(DEFAULT_APPROVAL_TIMEOUT_MINUTES)
    expect(DEFAULT_APPROVAL_TIMEOUT_MINUTES).toBeGreaterThanOrEqual(30)
    const outcome = approvals.request(view, new AbortController().signal, () => true, 'audit-1')
    // The owner is told immediately, with the same id the ticket record and decision API use.
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ id: 'audit-1', ticket: 'T-0018', assignmentId: 'a-1', requestedAt: '2026-11-19T09:13:11.000Z', expiresAt: '2026-11-19T09:43:11.000Z' })
    expect(approvals.list().map(row => row.id)).toEqual(['audit-1'])
    vi.advanceTimersByTime(5 * 60_000)
    expect(approvals.list()).toHaveLength(1) // the old five-minute expiry no longer applies
    vi.advanceTimersByTime(25 * 60_000)
    await expect(outcome).resolves.toBe('unavailable')
    expect(approvals.list()).toHaveLength(0)
  })

  it('accepts a configured window and rejects invalid values', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-19T09:00:00Z') })
    expect(commandApprovals(host, () => undefined, { timeoutMinutes: 0 }).timeoutMinutes).toBe(30)
    expect(commandApprovals(host, () => undefined, { timeoutMinutes: 2.5 }).timeoutMinutes).toBe(30)
    const approvals = commandApprovals(host, () => undefined, { timeoutMinutes: 90 })
    const outcome = approvals.request(view, new AbortController().signal, () => true)
    expect(approvals.list()[0]!.expiresAt).toBe('2026-11-19T10:30:00.000Z')
    vi.advanceTimersByTime(89 * 60_000)
    expect(approvals.list()).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    await expect(outcome).resolves.toBe('unavailable')
  })

  it('a failing reminder does not block the owner decision', async () => {
    const approvals = commandApprovals(host, () => undefined, { onRequest: () => { throw Error('outbox unavailable') } })
    const outcome = approvals.request(view, new AbortController().signal, () => true)
    expect(approvals.decide(approvals.list()[0]!.id, true)).toBe(true)
    await expect(outcome).resolves.toBe('allowed-once')
  })

  it('the reminder enters the outbox once with the ticket and assignment', () => {
    const outbox = new Outbox(join(mkdtempSync(join(tmpdir(), 'chief-approval-')), 'outbox.json'))
    const row: PendingCommand = { ...view, id: 'audit-1', expiresAt: '2026-11-19T09:43:11.000Z' }
    const notice = approvalNotice(row, '17:43')
    expect(notice.key).toBe('approval:T-0018:audit-1')
    expect(notice.text).toBe('命令待审批：工程师在「分组探路」（T-0018）申请运行 arkcli query --project demo。17:43 前未处理会过期，工单将转为受阻，可重试。')
    expect(outbox.enqueue(notice.key, notice.text, new Date(), row.ticket, { assignmentId: 'a-1' })).toBe(true)
    expect(outbox.enqueue(notice.key, notice.text, new Date(), row.ticket, { assignmentId: 'a-1' })).toBe(false)
    // A decision request is pushed like the other owner decisions; it is not a local-only result card.
    expect(outbox.recent(5)).toEqual([expect.objectContaining({ key: 'approval:T-0018:audit-1', ticketId: 'T-0018', assignmentId: 'a-1', push: 'pending' })])
  })
})

describe('workspace coding-session binding', () => {
  const binding = { scope: 'brain', workspaceId: 'w1', sessionId: 's1', orderId: 'd1', turnId: 't1', tool: 'codex' as const }
  const workspaceView = { ticket: 'd1', title: '清理探针', staff: 'Codex', staffId: 'codex', command: 'rm probe.txt', workdir: '/work/s1', mode: 'danger-full-access' as const, reason: '删除文件：rm', workspace: binding }

  it('keeps the binding, may shorten the window for one request but never extend it', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-20T08:00:00Z') })
    const asked: PendingCommand[] = []
    const approvals = commandApprovals(host, () => undefined, { timeoutMinutes: 30, onRequest: row => asked.push(row) })
    const short = approvals.request(workspaceView, new AbortController().signal, () => true, 'a-1', 90_000)
    const long = approvals.request(workspaceView, new AbortController().signal, () => true, 'a-2', 5 * 60 * 60_000)
    expect(asked.map(row => [row.id, row.workspace, row.expiresAt])).toEqual([
      ['a-1', binding, '2026-11-20T08:01:30.000Z'], ['a-2', binding, '2026-11-20T08:30:00.000Z']])
    await vi.advanceTimersByTimeAsync(90_000)
    await expect(short).resolves.toBe('unavailable')
    expect(approvals.decide('a-2', true)).toBe(true)
    await expect(long).resolves.toBe('allowed-once')
  })

  it('native ticket rows are unchanged, and the native approval route neither lists nor decides workspace rows', async () => {
    const approvals = commandApprovals(host, () => undefined)
    const native = approvals.request(view, new AbortController().signal, () => true, 'native-1')
    void approvals.request(workspaceView, new AbortController().signal, () => true, 'workspace-1')
    expect(approvals.list().find(row => row.id === 'native-1')).not.toHaveProperty('workspace')
    const route = runtimeRoutes({ engine: {}, brain: {}, roster: {}, approvals } as never)
    const call = async (method: 'GET' | 'POST', body?: object) => {
      const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
      const req = Object.assign((async function* () { yield* chunks })(), { method, url: '/chief/api/settings/approvals', headers: { 'x-chief-request': '1' } }) as unknown as IncomingMessage
      let status = 0, output = ''
      const res = { headersSent: false, writeHead(code: number) { status = code }, end(value: string) { output = value } } as unknown as ServerResponse
      await serveApi(req, res, 'dsh', [route], true)
      return { status, body: JSON.parse(output) as unknown }
    }
    expect((await call('GET')).body).toEqual([expect.objectContaining({ id: 'native-1', ticket: 'T-0018' })])
    expect(await call('POST', { id: 'workspace-1', allow: true })).toMatchObject({ status: 409 })
    expect(approvals.list().map(row => row.id)).toEqual(['native-1', 'workspace-1'])
    expect(await call('POST', { id: 'native-1', allow: false })).toMatchObject({ status: 200 })
    await expect(native).resolves.toBe('rejected')
    approvals.dispose()
  })
})

describe('Codex App Server start', () => {
  it('disables the v2 collaboration tools together with the legacy multi-agent flags', () => {
    const argv = codexAppServerArgv('/opt/codex')
    expect(argv[0]).toBe('/opt/codex')
    expect(argv.slice(-2)).toEqual(['app-server', '--stdio'])
    const flags = argv.slice(1, -2).filter((_, index) => index % 2 === 1)
    expect(argv.slice(1, -2).filter((_, index) => index % 2 === 0).every(flag => flag === '-c')).toBe(true)
    expect(flags).toEqual(expect.arrayContaining([
      'sandbox_workspace_write.network_access=false', 'features.multi_agent=false', 'features.multi_agent_v2=false',
      'features.multi_agent_v2.disable_native_tools=true',
    ]))
  })
})

/** A scripted Codex App Server over in-memory pipes. */
function wire(approve: (command: string) => Promise<'allowed-once' | 'rejected' | 'expired'>) {
  const stdin = new PassThrough(), stdout = new PassThrough()
  let exit!: (value: unknown) => void
  const child = { stdin, stdout, done: new Promise(resolve => { exit = resolve }) }
  const trace: Trace = {}
  const records: [string, string, unknown][] = []
  const proxy = approvalWire(child, new AbortController().signal, new AbortController(), trace,
    (id, status, detail) => records.push([id, status, detail]), (command) => approve(command),
    (status, command, at) => approvalEnding(status, command, at, 30))
  const answers: unknown[] = []
  let buffer = ''
  stdin.on('data', chunk => {
    buffer += chunk
    for (let i; (i = buffer.indexOf('\n')) >= 0;) { answers.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1) }
  })
  const fromServer = (value: unknown) => stdout.write(JSON.stringify(value) + '\n')
  const toServer = (value: unknown) => proxy.stdin!.write(JSON.stringify(value) + '\n')
  proxy.stdout!.on('data', () => {})
  const tick = () => new Promise(resolve => setTimeout(resolve, 5))
  const start = async () => {
    toServer({ id: 1, method: 'thread/start', params: {} })
    fromServer({ id: 1, result: { thread: { id: 'th' }, sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] }, approvalPolicy: 'on-request' } })
    await tick()
    toServer({ id: 2, method: 'turn/start', params: { threadId: 'th' } })
    fromServer({ id: 2, result: { turn: { id: 'tu' } } })
    await tick()
  }
  return { trace, records, answers, fromServer, start, tick, exit }
}

describe('Codex command approval wire', () => {
  it('an expired approval is declined, never cancelled, and the precise cause is kept before the turn ends', async () => {
    const codex = wire(async () => 'expired')
    await codex.start()
    // Codex 0.170 offers only accept / amendment / cancel for an escalated command.
    codex.fromServer({ id: 'ask', method: 'item/commandExecution/requestApproval', params: { threadId: 'th', turnId: 'tu', itemId: 'c1', command: 'arkcli query --project demo', cwd: '/tmp/work', reason: '需要联网',
      availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['arkcli'] } }, 'cancel'] } })
    await codex.tick()
    expect(codex.answers.filter(row => (row as { id?: string }).id === 'ask')).toEqual([{ id: 'ask', result: { decision: DENY_DECISION } }])
    expect(DENY_DECISION).toBe('decline')
    expect(codex.records.map(([, status]) => status)).toEqual(['requested', 'expired'])
    expect(codex.records[0]![2]).toEqual({ command: 'arkcli query --project demo' })
    expect(codex.trace.approval).toMatch(/^命令审批未在 30 分钟内处理已过期：arkcli query --project demo（\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC 申请）$/)
    // A Codex build that still ends the turn: chief already knows why.
    codex.fromServer({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 'tu', status: 'interrupted', error: null } } })
    await codex.tick()
    expect(codex.trace.failure).toBe('Codex 回合中断')
    expect(codex.trace.stopped).toBe(codex.trace.approval)
    const diagnostic = codexDiagnostic(codex.trace, 'Product subagent failure (product: Codex; stage: turn; category: unknown)')
    expect(diagnostic).toBe('Codex 回合中断')
    expect(diagnostic).not.toMatch(/unknown/)
  })

  it('a later native failure stays the cause; the earlier refusal is kept as context', async () => {
    const codex = wire(async () => 'rejected')
    await codex.start()
    codex.fromServer({ id: 'ask', method: 'item/commandExecution/requestApproval', params: { threadId: 'th', turnId: 'tu', itemId: 'c1', command: 'curl https://example.invalid', cwd: '/tmp/work' } })
    await codex.tick()
    codex.fromServer({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 'tu', status: 'failed', error: { codexErrorInfo: 'streamDisconnected', message: 'fixture transport error' } } } })
    await codex.tick()
    expect(codex.trace.stopped).toBeUndefined()
    expect(codexDiagnostic(codex.trace, 'Product subagent failure (product: Codex; stage: turn; category: unknown)')).toMatch(
      /^Codex 回合失败（streamDisconnected）：fixture transport error\n本轮另有命令审批被主人拒绝：curl https:\/\/example\.invalid（.+ 申请）$/)
  })

  it('keeps the Codex native error message and process exit details', async () => {
    const codex = wire(async () => 'allowed-once')
    await codex.start()
    codex.fromServer({ method: 'turn/completed', params: { threadId: 'th', turn: { id: 'tu', status: 'failed', error: { codexErrorInfo: 'streamDisconnected', message: 'stream closed\nbefore response.completed' } } } })
    await codex.tick()
    expect(codex.trace.failure).toBe('Codex 回合失败（streamDisconnected）：stream closed before response.completed')
    expect(codexDiagnostic({ failure: 'Codex 进程在工单回合完成前退出（退出码 137）' }, 'Product subagent failure (product: Codex; stage: process; category: process; exit code: 137)'))
      .toBe('Codex 进程在工单回合完成前退出（退出码 137）\nProduct subagent failure (product: Codex; stage: process; category: process; exit code: 137)')
    // Without a cause known to chief the provider's line is the only evidence and stays.
    expect(codexDiagnostic({}, 'Product subagent failure (product: Codex; stage: turn; category: unknown)')).toMatch(/category: unknown/)
  })

  it('an approval granted after an earlier refusal clears the stale cause', async () => {
    const outcomes: ('rejected' | 'allowed-once')[] = ['rejected', 'allowed-once']
    const codex = wire(async () => outcomes.shift()!)
    await codex.start()
    for (const id of ['one', 'two']) {
      codex.fromServer({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'th', turnId: 'tu', itemId: id, command: `echo ${id}`, cwd: '/tmp/work' } })
      await codex.tick()
    }
    expect(codex.answers.filter(row => ['one', 'two'].includes(String((row as { id?: string }).id))).map(row => (row as { result: { decision: string } }).result.decision)).toEqual(['decline', 'accept'])
    expect(codex.trace.approval).toBeUndefined()
    expect(codex.trace.executed).toBe(true)
  })
})

const STAFF: Staff[] = [
  { id: 'chief', name: '参谋长', executor: 'dsh', verifier: 'none', brief: '研判' },
  { id: 'engineer', name: '工程师', executor: 'codex', verifier: 'none', brief: '执行' },
]

function engineWith(run: (request: RunRequest) => Promise<RunResult>) {
  const root = mkdtempSync(join(tmpdir(), 'chief-approval-'))
  const store = new FileStore(root)
  const brain: Brain = { root, constitution: () => '', staff: () => STAFF, workspaces: () => [], workdir: id => join(root, 'work', id), appendNote: path => path, commit: () => {} }
  const calls: RunRequest[] = []
  const executors: Executors = { available: () => true, supportsSchema: () => false, run: request => { calls.push(request); return run(request) } }
  const engine = new Engine(store, brain, executors, { dispatch: () => {}, cancel: () => {} }, { concurrency: 1, timeZone: 'Asia/Shanghai' })
  const at = '2026-11-19T09:00:00Z'
  store.appendEvent({ id: 'T-0018', at, source: 'inbox', dedupe: 'T-0018', text: '分组探路' })
  store.setDisposition('T-0018', { kind: 'accepted', ticketId: 'T-0018' })
  store.saveTicket({ id: 'T-0018', title: '分组探路', staff: 'engineer', createdAt: at, priority: 1, events: ['T-0018'], inputs: [], assignments: [],
    mandate: { eventId: 'T-0018', scope: '分组执行查询', level: 'think', strength: 'explicit', needsReview: false, doneWhen: ['交付结果'] } } as Ticket)
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)) }
  return { engine, store, calls, settle }
}

describe('engine: owner-side stop after an ungranted approval', () => {
  const cause = approvalEnding('expired', 'arkcli query --project demo', '2026-11-19T09:13:11.118Z', 30)

  it('an ended run with a known approval expiry waits for the owner with the cause and a retry hint', async () => {
    const t = engineWith(async () => ({ text: '', stopReason: 'error', blocked: cause,
      diagnostic: 'Codex 回合中断' }))
    await t.engine.recover()
    await t.settle()
    const view = t.engine.views().find(row => row.ticket.id === 'T-0018')!
    expect(view.stage).toBe('you/blocked')
    const report = view.ticket.assignments.at(-1)!.report!
    expect(report.status).toBe('blocked')
    expect(report.summary).toBe('命令审批未在 30 分钟内处理已过期：arkcli query --project demo（2026-11-19 09:13 UTC 申请）。工作未完成，需要你处理后重试本工单。\n执行器记录：Codex 回合中断')
    expect(report.summary).not.toMatch(/执行者异常|unknown/)
    expect(t.calls).toHaveLength(1) // not retried as a transient error
    await t.engine.retry('T-0018')
    await t.settle()
    expect(t.calls).toHaveLength(2)
  })

  it('a rejected run raised by the executor is also an owner-side stop', async () => {
    const t = engineWith(async () => { throw Object.assign(Error('Codex 回合中断'), { blocked: cause }) })
    await t.engine.recover()
    await t.settle()
    const view = t.engine.views().find(row => row.ticket.id === 'T-0018')!
    expect(view.stage).toBe('you/blocked')
    expect(view.ticket.assignments.at(-1)!.report).toMatchObject({ status: 'blocked', summary: expect.stringContaining('执行器记录：Codex 回合中断') })
  })

  it('an unrelated executor fault still reports the native diagnostic', async () => {
    const t = engineWith(async () => ({ text: '', stopReason: 'error', diagnostic: 'Codex 回合失败（streamDisconnected）：stream closed' }))
    await t.engine.recover()
    await t.settle()
    const report = t.engine.views().find(row => row.ticket.id === 'T-0018')!.ticket.assignments.at(-1)!.report!
    expect(report).toMatchObject({ status: 'failed', summary: '执行者异常结束（error）：Codex 回合失败（streamDisconnected）：stream closed' })
  })

  it('records the command summary and window with the approval request', async () => {
    let release!: () => void
    const t = engineWith(() => new Promise(resolve => { release = () => resolve({ text: '', stopReason: 'error', blocked: cause }) }))
    await t.engine.recover()
    await t.settle()
    const assignment = t.engine.views()[0]!.ticket.assignments.at(-1)!
    const binding = { ticketId: 'T-0018', assignmentId: assignment.id }
    await t.engine.recordCommandApproval(binding, 'audit-1', 'requested', { command: 'arkcli   query\n--project demo', timeoutMinutes: 30 })
    await t.engine.recordCommandApproval(binding, 'audit-1', 'expired')
    expect(t.store.ticket('T-0018')!.assignments.at(-1)!.commandApprovals).toEqual([
      { id: 'audit-1', at: expect.any(String), status: 'requested', command: 'arkcli query --project demo', timeoutMinutes: 30 },
      { id: 'audit-1', at: expect.any(String), status: 'expired' },
    ])
    release()
    await t.settle()
  })
})
