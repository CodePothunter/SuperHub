import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2Delegation, V2DialogueSource, V2Message, V2Session, V2TurnInput, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import { serveApi } from '../src/dsh/http.ts'
import type { AcceptanceReviewer } from '../src/dsh/workspace-acceptance.ts'
import type { CommandJudge } from '../src/dsh/workspace-order-command.ts'
import { workspaceV2Routes } from '../src/dsh/workspace-v2.ts'
import { commandText, mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'
import { createV2DialogueSource } from '../src/dsh/workspace-v2-dialogue.ts'
import { cliHost } from './coding-cli-fake.ts'

const roots: string[] = []
const cleanup: (() => void)[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-order-completion-')); roots.push(p); return p }
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
  for (const p of roots.splice(0)) rmSync(p, {recursive: true, force: true})
})

type Judge = CommandJudge & {mock: {calls: unknown[][]}}
function fixture({judge = vi.fn<CommandJudge>(async () => 'complete'), review, turnLimit = 6}: {judge?: CommandJudge; review?: AcceptanceReviewer; turnLimit?: number} = {}) {
  const root = temp(), scope = 'brain-done'
  const sent: V2TurnInput[] = []
  const signals: AbortSignal[] = []
  const said: V2Message[] = []
  const replies = new Map<string, V2Message[]>()
  const gates: PromiseWithResolvers<void>[] = []
  const push = (message: V2Message) => { if (!said.some(row => row.id === message.id)) said.push(message) }
  const source: V2DialogueSource = {
    read: async () => ({messages: structuredClone(said)}),
    send: vi.fn(async (_session: V2Session, input: V2TurnInput, signal: AbortSignal) => {
      sent.push(structuredClone(input))
      signals.push(signal)
      push({id: 'u-' + input.id, role: 'user', author: '你', speakerId: 'owner', at: new Date().toISOString(), text: input.text, workOrderId: input.workOrderId})
      const gate = gates.shift()
      if (gate) await gate.promise
      replies.set(input.id, [{id: 'r-' + input.id, role: 'agent', author: 'Codex', at: new Date().toISOString(), text: '工单回报\n八题已全部作答。', workOrderId: input.workOrderId}])
      push(replies.get(input.id)![0]!)
    }),
    attachment: async () => undefined,
    savedResults: (_session, requestId) => replies.has(requestId) ? {messages: replies.get(requestId)!, attachments: []} : undefined,
    note: (_session, note) => {
      const id = 'l-' + note.id
      push({id, role: 'agent', author: '接口人', at: new Date().toISOString(), text: note.text, workOrderId: note.workOrderId})
      return id
    },
    hold: (_session, words) => {
      const id = 'u-' + words.id
      push({id, role: 'user', author: '你', speakerId: 'owner', at: words.at ?? new Date().toISOString(), text: words.text, workOrderId: words.workOrderId})
      return id
    },
  }
  let store = new WorkspaceV2Store(root, scope, turnLimit)
  let route = workspaceV2Routes({store, source, judge, review, timeZone: 'Asia/Shanghai'})
  cleanup.push(() => route.dispose())
  async function call<T = Record<string, unknown>>(path: string, body?: Record<string, unknown>) {
    const url = new URL('/chief/api/v2' + path, 'http://local')
    url.searchParams.set('scope', scope)
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method: body ? 'POST' : 'GET', url: url.pathname + url.search, headers: {'x-chief-request': '1'},
    }) as unknown as IncomingMessage
    let status = 0, data: T
    const res = {writeHead(code: number) { status = code }, end(value: string) { data = JSON.parse(value) }} as unknown as ServerResponse
    await serveApi(req, res, 'dsh', [route], true)
    return {status, data: data! as T & {error?: string}}
  }
  async function order(body: Record<string, unknown> = {executor: 'codex'}) {
    const space = (await call<{workspace: {id: string}}>('/workspaces', {requestId: 'w-' + said.length + '-' + Math.random().toString(36).slice(2), name: '方舟'})).data.workspace
    const made = await call<{order: V2Delegation}>('/workspaces/' + space.id + '/orders', {requestId: 'o-' + Math.random().toString(36).slice(2), title: '方舟八题', promise: '八题全部作答', ...body})
    expect(made.status).toBe(200)
    return made.data.order
  }
  const base = (job: V2Delegation) => '/workspaces/' + job.workspaceId
  const say = (job: V2Delegation, requestId: string, text: string, extra: Record<string, unknown> = {}) =>
    call<{command?: {outcome: string; resolved?: string}; delivery?: string}>(base(job) + '/sessions/' + job.sessionId + '/messages', {requestId, text, workOrderId: job.id, wait: false, ...extra})
  const transcript = async (job: V2Delegation) => (await call<{messages: V2Message[]}>(base(job) + '/sessions/' + job.sessionId)).data.messages
  const current = (job: V2Delegation) => store.delegation(job.workspaceId, job.id)
  const shown = async (job: V2Delegation) => (await call<V2WorkspaceView>(base(job))).data.orders.find(row => row.id === job.id)!
  const act = (job: V2Delegation, requestId: string, body: Record<string, unknown>) => call<{order: V2Delegation}>(base(job) + '/orders/' + job.id + '/action', {requestId, ...body})
  const forward = (job: V2Delegation, message: string, requestId: string) =>
    call<{forwarded?: boolean; delivery?: string}>(base(job) + '/sessions/' + job.sessionId + '/messages/' + message + '/forward', {requestId})
  const schedule = (job: V2Delegation) => store.saveFollowup(job.workspaceId, job.id, current(job).generation, mutationKey(['f'], {requestId: 'f-' + job.id.slice(0, 8)}), state => {
    state.schedule = {enabled: true, weekday: 1, time: '09:00', enabledAt: new Date(Date.now() - 86_400_000).toISOString(), revision: 'r1'}
    return undefined
  })
  const block = () => { const gate = Promise.withResolvers<void>(); gates.push(gate); return gate }
  return {source, sent, signals, said, call, order, say, transcript, current, shown, act, forward, schedule, block, judge: judge as Judge,
    store: () => store, route: () => route,
    restart() { route.dispose(); store = new WorkspaceV2Store(root, scope, turnLimit); route = workspaceV2Routes({store, source, judge, review, timeZone: 'Asia/Shanghai'}); route.recover() }}
}
const liaison = (messages: V2Message[]) => messages.filter(row => row.author === '接口人')

describe('owner words about the order itself', () => {
  it('completes the order on clear words without telling the executor or using budget, and the owner can undo it', async () => {
    const f = fixture()
    const job = await f.order()
    const reply = await f.say(job, 'done-1', '没问题了 可以收单')
    expect(reply).toMatchObject({status: 200, data: {command: {outcome: 'completed'}}})
    expect(f.sent).toEqual([])
    expect(f.current(job)).toMatchObject({status: 'done', completedBy: 'owner-words', completedFrom: 'done-1', remainingTurns: 6, generation: 2})
    expect(f.current(job).completedAt).toBeTruthy()
    expect(f.judge.mock.calls[0]![0]).toMatchObject({text: '没问题了 可以收单', title: '方舟八题', promise: '八题全部作答'})
    let messages = await f.transcript(job)
    expect(messages.map(row => [row.author, row.text, row.held])).toEqual([['你', '没问题了 可以收单', 'completed'], ['接口人', commandText.completed, undefined]])
    expect(commandText.completed).toBe('已按你的话收单。')
    const note = liaison(messages)[0]!
    expect(note.actions).toEqual([{kind: 'reopen', label: '撤销'}])
    // The same request answers the same way, without reading the words again.
    expect(await f.say(job, 'done-1', '没问题了 可以收单')).toMatchObject({status: 200, data: {command: {outcome: 'completed'}}})
    expect(f.judge.mock.calls).toHaveLength(1)
    expect((await f.say(job, 'done-1', '另一句话')).status).toBe(409)
    // Finished: no new turns and no budget.
    const blocked = await f.say(job, 'after-1', '把第三题改成表格')
    expect(blocked.status).toBe(409)
    expect(blocked.data.error).toContain('已完成')
    expect(f.sent).toEqual([])
    expect(f.current(job).remainingTurns).toBe(6)
    expect((await f.act(job, 'pause-1', {action: 'pause'})).status).toBe(409)
    await expect(f.route().follow('src-x', '再加一题', job.workspaceId, job.id)).rejects.toThrow('已完成')
    // Undo from the liaison's message: back to waiting, once.
    expect((await f.act(job, 'undo-1', {action: 'reopen', from: note.id})).data.order).toMatchObject({status: 'waiting', generation: 3})
    expect(f.current(job)).not.toHaveProperty('completedAt')
    messages = await f.transcript(job)
    expect(liaison(messages)[0]!.actions).toEqual([{kind: 'reopen', label: '撤销', done: {at: expect.any(String)}}])
    expect((await f.act(job, 'undo-2', {action: 'reopen', from: note.id})).status).toBe(409)
    expect((await f.say(job, 'after-2', '把第三题改成表格')).status).toBe(200)
    expect(f.sent.map(row => row.text)).toEqual(['把第三题改成表格'])
  })

  it('holds unclear words for the owner\'s choice and hands them to the executor exactly once with their own request', async () => {
    const judge = vi.fn<CommandJudge>(async () => 'ambiguous')
    const f = fixture({judge})
    const job = await f.order()
    expect(await f.say(job, 'check-1', '可以验收了')).toMatchObject({status: 200, data: {command: {outcome: 'held'}}})
    expect(f.sent).toEqual([])
    expect(f.current(job)).toMatchObject({status: 'accepted', remainingTurns: 6})
    let messages = await f.transcript(job)
    const owner = messages.find(row => row.role === 'user')!
    expect(owner).toMatchObject({text: '可以验收了', held: 'choosing'})
    const note = liaison(messages)[0]!
    expect(note.text).toBe(commandText.held('ambiguous', false))
    expect(note.actions).toEqual([{kind: 'complete', label: '确认收单'}, {kind: 'forward', label: '继续交给执行者', messageId: owner.id}])
    // Forward: the words go out once, as the owner's own turn, with the normal budget.
    expect(await f.forward(job, owner.id, 'fw-1')).toMatchObject({status: 200, data: {forwarded: true}})
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    expect(f.sent[0]).toMatchObject({id: 'check-1', text: '可以验收了', workOrderId: job.id})
    expect(f.sent[0]).not.toHaveProperty('liaison')
    await vi.waitFor(() => expect(f.current(job).remainingTurns).toBe(5))
    expect((await f.forward(job, owner.id, 'fw-1')).status).toBe(200)
    expect((await f.forward(job, owner.id, 'fw-2')).status).toBe(409)
    expect((await f.forward(job, 'check-1', 'fw-3')).status).toBe(409)
    expect(f.sent).toHaveLength(1)
    // The original request still answers as held words; it is never dispatched a second time.
    expect(await f.say(job, 'check-1', '可以验收了')).toMatchObject({status: 200, data: {command: {outcome: 'held', resolved: 'forward'}}})
    expect(f.sent).toHaveLength(1)
    messages = await f.transcript(job)
    expect(messages.filter(row => row.text === '可以验收了')).toHaveLength(1)
    expect(messages.find(row => row.id === owner.id)).not.toHaveProperty('held')
    expect(liaison(messages)[0]!.actions).toEqual([{kind: 'forward', label: '继续交给执行者', messageId: owner.id, done: {at: expect.any(String)}}])
    expect((await f.act(job, 'late-complete', {action: 'complete', from: note.id})).status).toBe(409)
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('completes from the held words\' message, and their choice is then taken', async () => {
    const f = fixture({judge: vi.fn<CommandJudge>(async () => 'ambiguous')})
    const job = await f.order()
    await f.say(job, 'looks-1', '看着可以')
    const note = liaison(await f.transcript(job))[0]!
    expect((await f.act(job, 'ok-1', {action: 'complete', from: note.id})).data.order).toMatchObject({status: 'done', completedBy: 'owner', completedFrom: 'looks-1'})
    const messages = await f.transcript(job)
    expect(messages.find(row => row.role === 'user')).toMatchObject({held: 'completed'})
    expect(liaison(messages)[0]!.actions).toEqual([{kind: 'complete', label: '确认收单', done: {at: expect.any(String)}}])
    expect((await f.forward(job, messages.find(row => row.role === 'user')!.id, 'fw-late')).status).toBe(409)
    expect(f.sent).toEqual([])
  })

  it('sends other words to the executor: no reading for ordinary instructions, and the model can say they are for the executor', async () => {
    const judge = vi.fn<CommandJudge>(async () => 'other')
    const f = fixture({judge})
    const job = await f.order()
    expect((await f.say(job, 'plain', '把第三题改成表格')).status).toBe(200)
    expect((await f.say(job, 'finish-then', '完成第三题后再检查')).status).toBe(200)
    expect(judge).not.toHaveBeenCalled()
    expect((await f.say(job, 'read-then-send', '验收标准里再加一条')).status).toBe(200)
    expect(judge).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(f.sent.map(row => row.id)).toEqual(['plain', 'finish-then', 'read-then-send']))
    expect(f.current(job).status).not.toBe('done')
    expect((await f.transcript(job)).some(row => row.held || row.actions)).toBe(false)
  })

  it('offers choices instead of losing the words when the model is unavailable', async () => {
    const f = fixture({judge: async () => { throw new Error('没有可用的接口人模型') }})
    const job = await f.order()
    expect(await f.say(job, 'no-model', '可以收单')).toMatchObject({status: 200, data: {command: {outcome: 'held'}}})
    const messages = await f.transcript(job)
    expect(messages.find(row => row.role === 'user')).toMatchObject({text: '可以收单', held: 'choosing'})
    expect(liaison(messages)[0]!.text).toContain('没能确认')
    expect(f.store().command(mutationKey(['v2', 'workspaces', job.workspaceId, 'sessions', job.sessionId, 'messages'],
      {requestId: 'no-model', text: '可以收单', workOrderId: job.id, wait: false}))).toMatchObject({judged: 'failed', reason: '没有可用的接口人模型'})
    expect(f.sent).toEqual([])
  })

  it('does not complete an order with a recurring schedule on words alone; the choice completes it and stops the schedule', async () => {
    const f = fixture()
    const job = await f.order()
    f.schedule(job)
    expect((await f.shown(job)).nextCheckAt).toBeTruthy()
    expect(await f.say(job, 'weekly-1', '可以收单')).toMatchObject({status: 200, data: {command: {outcome: 'held'}}})
    expect(f.current(job).status).toBe('accepted')
    const note = liaison(await f.transcript(job))[0]!
    expect(note.text).toContain('周期安排')
    expect(note.actions![0]).toEqual({kind: 'complete', label: '收单并停止周期安排', stopSchedule: true})
    expect((await f.act(job, 'weekly-done', {action: 'complete', from: note.id, stopSchedule: true})).data.order).toMatchObject({status: 'done'})
    expect(f.store().followupState(job.workspaceId, job.id).schedule).toMatchObject({enabled: false})
    expect(await f.shown(job)).not.toHaveProperty('nextCheckAt')
    expect((await f.act(job, 'bad-stop', {action: 'pause', stopSchedule: true})).status).toBe(400)
  })

  it('names the schedule in views while the order is paused, as the liaison\'s choice does', async () => {
    const f = fixture({judge: vi.fn<CommandJudge>(async () => 'ambiguous')})
    const job = await f.order()
    expect(await f.shown(job)).not.toHaveProperty('hasSchedule')
    f.schedule(job)
    await f.say(job, 'weekly-look', '看着可以')
    const paused = (await f.act(job, 'pause-weekly', {action: 'pause'})).data.order
    expect(paused).toMatchObject({paused: true, hasSchedule: true})
    expect(paused).not.toHaveProperty('nextCheckAt')
    expect(await f.shown(job)).toMatchObject({hasSchedule: true})
    expect(f.current(job)).not.toHaveProperty('hasSchedule')
    const note = liaison(await f.transcript(job))[0]!
    expect(note.actions![0]).toEqual({kind: 'complete', label: '收单并停止周期安排', stopSchedule: true})
    expect((await f.act(job, 'paused-done', {action: 'complete', from: note.id, stopSchedule: true})).data.order).toMatchObject({status: 'done'})
    expect(f.store().followupState(job.workspaceId, job.id).schedule).toMatchObject({enabled: false})
    expect(await f.shown(job)).not.toHaveProperty('hasSchedule')
    // Reopening does not turn a stopped schedule back on.
    expect((await f.act(job, 'paused-reopen', {action: 'reopen'})).data.order).not.toHaveProperty('hasSchedule')
    expect(f.store().followupState(job.workspaceId, job.id).schedule).toMatchObject({enabled: false})
  })

  it('keeps the choice open and hands the words over after a restart when a forward did not go out', async () => {
    const f = fixture({judge: vi.fn<CommandJudge>(async () => 'ambiguous')})
    const job = await f.order()
    await f.say(job, 'half', '可以验收了')
    const owner = (await f.transcript(job)).find(row => row.role === 'user')!
    // The choice was saved, then the process stopped before the words were dispatched.
    f.store().forwardCommand(mutationKey(['crash'], {requestId: 'fw-crash'}), job.workspaceId, job.sessionId, 'half')
    let messages = await f.transcript(job)
    expect(messages.find(row => row.id === owner.id)).toMatchObject({held: 'choosing'})
    expect(liaison(messages)[0]!.actions!.map(row => [row.kind, !!row.done])).toEqual([['complete', false], ['forward', false]])
    f.restart()
    await vi.waitFor(() => expect(f.sent.map(row => row.id)).toEqual(['half']))
    messages = await f.transcript(job)
    expect(messages.find(row => row.id === owner.id)).not.toHaveProperty('held')
    expect(liaison(messages)[0]!.actions).toEqual([{kind: 'forward', label: '继续交给执行者', messageId: owner.id, done: {at: expect.any(String)}}])
    // Exactly once: another restart and another choice send nothing more.
    f.restart()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await f.forward(job, owner.id, 'fw-again')).status).toBe(409)
    expect(f.sent).toHaveLength(1)
  })

  it('lets the owner choose again when a recorded forward has not gone out', async () => {
    const f = fixture({judge: vi.fn<CommandJudge>(async () => 'ambiguous')})
    const job = await f.order()
    await f.say(job, 'retry-fw', '可以验收了')
    const owner = (await f.transcript(job)).find(row => row.role === 'user')!
    f.store().forwardCommand(mutationKey(['crash'], {requestId: 'fw-lost'}), job.workspaceId, job.sessionId, 'retry-fw')
    expect((await f.forward(job, owner.id, 'fw-retry')).status).toBe(200)
    await vi.waitFor(() => expect(f.sent.map(row => row.id)).toEqual(['retry-fw']))
    expect((await f.forward(job, owner.id, 'fw-retry-2')).status).toBe(409)
    expect(f.sent).toHaveLength(1)
  })

  it('offers undo on the liaison\'s note only while that completion stands', async () => {
    const f = fixture()
    const job = await f.order()
    await f.say(job, 'words-done', '可以收单')
    expect(liaison(await f.transcript(job))[0]!.actions).toEqual([{kind: 'reopen', label: '撤销'}])
    await f.act(job, 'page-reopen', {action: 'reopen'})
    expect(liaison(await f.transcript(job))[0]).not.toHaveProperty('actions')
    await f.act(job, 'page-complete', {action: 'complete'})
    const note = liaison(await f.transcript(job))[0]!
    expect(note).not.toHaveProperty('actions')
    expect((await f.act(job, 'stale-undo', {action: 'reopen', from: note.id})).status).toBe(409)
  })

  it('reads words on team and staff orders too, but not words for the session discussion', async () => {
    const f = fixture()
    const team = await f.order({})
    expect(f.store().session(team.workspaceId, team.sessionId).kind).toBe('group')
    expect(await f.say(team, 'team-done', '这单结束')).toMatchObject({status: 200, data: {command: {outcome: 'completed'}}})
    const second = await f.call<{order: V2Delegation}>('/workspaces/' + team.workspaceId + '/orders', {requestId: 'second', title: '另一单', sessionId: team.sessionId})
    expect(second.status).toBe(200)
    const discussion = await f.call(('/workspaces/' + team.workspaceId + '/sessions/' + team.sessionId + '/messages'), {requestId: 'talk', text: '可以收单', wait: false})
    expect(discussion.status).toBe(200)
    expect(discussion.data).not.toHaveProperty('command')
    expect(f.judge.mock.calls).toHaveLength(1)
  })

  it('reads the same request once when it arrives twice at the same time', async () => {
    const reading = Promise.withResolvers<'complete'>()
    const judge = vi.fn<CommandJudge>(() => reading.promise)
    const f = fixture({judge})
    const job = await f.order()
    const first = f.say(job, 'twice', '收了吧'), second = f.say(job, 'twice', '收了吧')
    await vi.waitFor(() => expect(judge).toHaveBeenCalledTimes(1))
    reading.resolve('complete')
    expect((await first).data.command).toEqual({outcome: 'completed'})
    expect((await second).data.command).toEqual({outcome: 'completed'})
    expect(judge).toHaveBeenCalledTimes(1)
    expect(liaison(await f.transcript(job))).toHaveLength(1)
  })

  it('stops the running turn and queued words when words complete the order', async () => {
    const f = fixture()
    const job = await f.order()
    const gate = f.block()
    const running = f.say(job, 'work', '先答第一题')
    await vi.waitFor(() => expect(f.signals).toHaveLength(1))
    // Words said into the running turn are read first; completing stops the turn instead of steering into it.
    expect(await f.say(job, 'stop', 'OK 收单')).toMatchObject({status: 200, data: {command: {outcome: 'completed'}}})
    expect(f.signals[0]!.aborted).toBe(true)
    gate.resolve()
    await running
    expect(f.current(job)).toMatchObject({status: 'done', generation: 2})
    expect(f.sent.map(row => row.id)).toEqual(['work'])
  })

  it('posts the held words and the note after a restart when they did not reach the conversation', async () => {
    const f = fixture({judge: vi.fn<CommandJudge>(async () => 'ambiguous')})
    const job = await f.order()
    const note = f.source.note!
    f.source.note = () => { throw new Error('来源暂不可用') }
    await f.say(job, 'lost-note', '可以验收了')
    expect(liaison(await f.transcript(job))).toHaveLength(0)
    f.source.note = note
    f.restart()
    const messages = await f.transcript(job)
    expect(liaison(messages)[0]!.actions?.map(row => row.kind)).toEqual(['complete', 'forward'])
    expect(messages.filter(row => row.role === 'user')).toHaveLength(1)
  })

  it('posts held words that did not reach the conversation when it is read again, without a restart', async () => {
    const f = fixture({judge: vi.fn<CommandJudge>(async () => 'ambiguous')})
    const job = await f.order()
    const hold = f.source.hold!
    f.source.hold = () => { throw new Error('来源暂不可用') }
    await f.say(job, 'lost-words', '可以验收了')
    expect((await f.transcript(job)).filter(row => row.role === 'user')).toHaveLength(0)
    f.source.hold = hold
    const messages = await f.transcript(job)
    expect(messages.filter(row => row.role === 'user')).toEqual([expect.objectContaining({text: '可以验收了', held: 'choosing'})])
    expect(liaison(messages)).toHaveLength(1)
  })
})

describe('completing from the order and from the liaison\'s acceptance', () => {
  it('offers to complete under a passing acceptance verdict, and the order page can complete and reopen', async () => {
    const review = vi.fn<AcceptanceReviewer>(async () => ({verdict: 'pass', message: '八题都已作答。', gaps: []}))
    const f = fixture({review})
    const job = await f.order()
    expect((await f.say(job, 'answer', '请作答八题')).status).toBe(200)
    await vi.waitFor(async () => expect(liaison(await f.transcript(job))).toHaveLength(1))
    const verdict = liaison(await f.transcript(job))[0]!
    expect(verdict.text).toBe('已对照约定核对：八题都已作答。')
    expect(verdict.actions).toEqual([{kind: 'complete', label: '确认收单'}])
    expect((await f.act(job, 'accept-done', {action: 'complete', from: verdict.id})).data.order).toMatchObject({status: 'done', completedBy: 'owner'})
    expect(f.current(job)).not.toHaveProperty('completedFrom')
    expect(liaison(await f.transcript(job))[0]!.actions).toEqual([{kind: 'complete', label: '确认收单', done: {at: expect.any(String)}}])
    // The choice is taken; the order page reopens and completes again.
    expect((await f.act(job, 'reopen-page', {action: 'reopen'})).data.order).toMatchObject({status: 'waiting'})
    expect((await f.act(job, 'accept-again', {action: 'complete', from: verdict.id})).status).toBe(409)
    expect((await f.act(job, 'page-done', {action: 'complete'})).data.order).toMatchObject({status: 'done', completedBy: 'owner'})
    expect((await f.act(job, 'page-done-2', {action: 'complete'})).data.order).toMatchObject({status: 'done'})
    expect((await f.act(job, 'page-cancel', {action: 'cancel'})).status).toBe(409)
    expect((await f.act(job, 'unknown-from', {action: 'reopen', from: 'l-none'})).status).toBe(404)
    // Today lists the result with the order finished.
    const notices = await f.call<{items: {orderId: string; orderDone?: boolean}[]}>('/notices')
    expect(notices.data.items).toEqual([expect.objectContaining({orderId: job.id, orderDone: true})])
  })

  it('cancels a pending review and a waiting decision when the order completes', async () => {
    const review = vi.fn<AcceptanceReviewer>(() => new Promise(() => {}))
    const f = fixture({review})
    const job = await f.order()
    await f.say(job, 'answer', '请作答八题')
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1))
    await f.act(job, 'done-now', {action: 'complete'})
    expect(f.store().pendingAcceptances()[0]).toMatchObject({cancelled: true})
    expect((await f.call<{acceptances: unknown[]}>('/approvals')).data.acceptances).toEqual([])
  })
})

describe('next follow-up time', () => {
  it('shows only the next run of an enabled recurring schedule and never the stored default', async () => {
    const f = fixture()
    const job = await f.order({executor: 'codex', nextCheckAt: '2026-11-21T08:10:00Z'})
    expect(f.current(job).nextCheckAt).toBe('2026-11-21T08:10:00.000Z')
    expect(job).not.toHaveProperty('nextCheckAt')
    expect(await f.shown(job)).not.toHaveProperty('nextCheckAt')
    const fresh = await f.order()
    expect(f.current(fresh)).not.toHaveProperty('nextCheckAt')
    f.schedule(job)
    const next = (await f.shown(job)).nextCheckAt!
    expect(Date.parse(next)).toBeGreaterThan(Date.now())
    // Monday 09:00 in the brain's time zone.
    expect(new Date(next).toLocaleString('en-US', {timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false})).toMatch(/^Mon,? 09:00$/)
    expect((await f.call<{order: V2Delegation}>('/workspaces/' + job.workspaceId + '/orders/' + job.id)).data.order.nextCheckAt).toBe(next)
    await f.act(job, 'pause', {action: 'pause'})
    expect(await f.shown(job)).not.toHaveProperty('nextCheckAt')
  })
})

describe('分页不隐藏等主人选择的消息（日志会话）', () => {
  it('窗口之外仍待选择的接口人消息随分页响应附在 pinned 里', async () => {
    const f = fixture({judge: vi.fn<CommandJudge>(async () => 'ambiguous')})
    const job = await f.order()
    await f.say(job, 'pin-1', '可以验收了')
    const messages = await f.transcript(job)
    const owner = messages.find(row => row.role === 'user')!, note = liaison(messages)[0]!
    const path = '/workspaces/' + job.workspaceId + '/sessions/' + job.sessionId
    type Paged = {messages: V2Message[]; pinned?: V2Message[]}
    const around = (await f.call<Paged>(path + '?limit=1&around=' + owner.id)).data
    expect(around.messages.map(row => row.id)).toEqual([owner.id])
    expect(around.pinned).toEqual([expect.objectContaining({id: note.id, actions: note.actions})])
    expect((await f.call<Paged>(path + '?limit=1&around=' + note.id)).data.pinned).toBeUndefined()
    expect((await f.call<Paged>(path)).data.pinned).toBeUndefined()
  })
})

describe('held words in the real conversation source', () => {
  it('records held words where they were said and keeps that message when they are dispatched later', async () => {
    const root = temp()
    const h = cliHost((_spec, _prompt, {say}) => {
      say({type: 'item.completed', item: {id: 'm-1', type: 'agent_message', text: '收到'}})
      say({type: 'turn.completed'})
      return 0
    })
    const source = createV2DialogueSource({ctx: h.ctx, root, scope: 'brain', codex: {executable: process.execPath}})
    cleanup.push(() => source.dispose())
    const session: V2Session = {id: 's1', workspaceId: 'w1', title: '方舟', kind: 'coding', executor: 'codex', delegationIds: ['d1'], closed: false, createdAt: '2026-11-23'}
    const at = '2026-11-23T00:17:00.000Z'
    const id = source.hold!(session, {id: 'held-1', text: '可以验收了', workOrderId: 'd1', at})
    expect(source.hold!(session, {id: 'held-1', text: '可以验收了', workOrderId: 'd1', at})).toBe(id)
    const noteId = source.note!(session, {id: 'command-held-1', text: '请选择', workOrderId: 'd1'})
    expect(typeof noteId).toBe('string')
    await source.send(session, {id: 'held-1', text: '可以验收了', workOrderId: 'd1'}, new AbortController().signal)
    const messages = (await source.read(session)).messages
    expect(messages.filter(row => row.role === 'user')).toEqual([expect.objectContaining({id, text: '可以验收了', at, workOrderId: 'd1'})])
    expect(messages.map(row => row.id)).toEqual([id, noteId, expect.any(String)])
  })
})
