/**
 * 第 4 阶段：工作区群聊接到路由与工单上（新会话都是群、接口人交办进群、主人的话立即送到在干活的成员、验收、叫停、档位、审批）。
 * 成员运行器全是替身，不起真实的 DSH 会话或 Codex。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_ARCHIVED, workspaceArchived, type V2Delegation, type V2DialogueSource, type V2PendingApproval, type V2Session, type V2Workspace, type WorkOrderOutput, type WorkspaceOutput } from '../src/core/workspace-v2.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import type { ChatInputAttachment } from '../src/core/chat-attachments.ts'
import type { StaffView } from '../src/core/workspace-staff.ts'
import type { ChatAttachments } from '../src/dsh/chat-attachments.ts'
import { serveApi } from '../src/dsh/http.ts'
import type { AcceptanceVerdict } from '../src/dsh/workspace-acceptance.ts'
import { DirectoryLocks } from '../src/dsh/directory-locks.ts'
import { GroupDirectoryLocks, WorkspaceGroupHost } from '../src/dsh/workspace-group-host.ts'
import { groupRoster, GroupMemberSessions, type GroupContext, type MemberCall, type MemberCallSink, type MemberReattach, type MemberRunner } from '../src/dsh/workspace-group-members.ts'
import type { CommandIntent } from '../src/dsh/workspace-order-command.ts'
import { WorkspaceStaffStore } from '../src/dsh/workspace-staff-store.ts'
import { workspaceV2Routes, type GroupMessage, type GroupMemberState, type GroupPauseState, type WorkspaceApprovals } from '../src/dsh/workspace-v2.ts'
import { appendCommandLog } from '../src/dsh/workspace-command-log.ts'
import { WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'
import type { OrderResultNotice, ResultNoticeList } from '../src/core/workspace-notices.ts'
import type { EngagementCoordinator, EngagementDecision, OwnerAction } from '../src/core/workspace-engagement.ts'
import type { ExperienceEvidence } from '../src/core/workspace-experience.ts'
import { createExperienceLearning, type ExperienceLearning } from '../src/dsh/workspace-experience-learning.ts'
import type { Llm } from '../src/dsh/ports.ts'

const scope = 'brain-g'
const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })

class FakeRunner implements MemberRunner {
  calls: MemberCall[] = []
  sinks = new Map<string, MemberCallSink>()
  cancelled: string[] = []
  steered: { callId: string; id: string; text: string }[] = []
  alive = new Set<string>()
  reattached: string[] = []
  steerAnswer?: 'steered' | 'pending' | 'rejected'
  run(call: MemberCall, sink: MemberCallSink) {
    this.calls.push(call)
    this.sinks.set(call.callId, sink)
    call.group.sessions.setMember(call.member.id, { kind: call.member.kind, cwd: call.group.workDir, session: 'native-' + call.member.id })
    return Promise.resolve()
  }
  continue() { return Promise.resolve() }
  cancel(callId: string) { this.cancelled.push(callId) }
  async reattach(call: MemberReattach, sink: MemberCallSink) {
    this.reattached.push(call.callId)
    if (!this.alive.has(call.callId)) return false
    this.sinks.set(call.callId, sink)
    return true
  }
  steer(callId: string, words: { id: string; text: string }) {
    if (!this.steerAnswer) return Promise.resolve('rejected' as const)
    this.steered.push({ callId, ...words })
    return Promise.resolve(this.steerAnswer)
  }
  dispose() {}
  last(memberId: string) {
    const call = this.calls.findLast(row => row.member.id === memberId)
    if (!call) throw new Error(`${memberId} was never called`)
    return { call, sink: this.sinks.get(call.callId)! }
  }
  count(memberId: string) { return this.calls.filter(row => row.member.id === memberId).length }
  /** The member answers its last call: uses a tool when `work`, then replies. */
  answer(memberId: string, text: string, work = true) {
    const { call, sink } = this.last(memberId)
    if (work) sink.tool(call.callId, { name: 'bash', team: false })
    sink.finished(call.callId, { text, status: 'completed', toolCalls: work ? 1 : 0 })
  }
}

const NATIVE = [
  { id: 'engineer', name: '工程师', brief: '写代码、跑命令', executor: 'codex' as const },
  { id: 'researcher', name: '研究员', brief: '查资料', executor: 'dsh' as const },
]

function fixture(options: { turnLimit?: number; review?: AcceptanceVerdict[] | 'fail'; judge?: CommandIntent; root?: string; inputAttachments?: Pick<ChatAttachments, 'resolve' | 'grant'>; coordinate?: EngagementCoordinator; llm?: Pick<Llm, 'stream'> } = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'chief-group-routes-'))
  if (!options.root) cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const dsh = new FakeRunner(), codex = new FakeRunner()
  const reminders: { key: string; text: string; localOnly?: boolean }[] = []
  const pending: V2PendingApproval[] = []
  const answered: { id: string; allow: boolean; where: unknown }[] = []
  const approvals: WorkspaceApprovals = {
    pending: filter => pending.filter(row => (!filter?.workspaceId || row.workspaceId === filter.workspaceId) && (!filter?.sessionId || row.sessionId === filter.sessionId)
      && (filter?.orderId === undefined || row.workOrderId === filter.orderId)),
    answer: (id, allow, where) => { answered.push({ id, allow, where }); const row = approvals.pending(where).find(item => item.id === id); return !!row },
  }
  const verdicts = Array.isArray(options.review) ? [...options.review] : []
  const review = vi.fn(async () => {
    if (options.review === 'fail') throw new Error('没有可用的验收模型')
    const next = verdicts.shift()
    if (!next) throw new Error('no verdict scripted')
    return next
  })
  const source: V2DialogueSource = { read: vi.fn(async () => ({ messages: [] })), send: vi.fn(async () => {}), attachment: vi.fn(async () => undefined) }
  let store!: WorkspaceV2Store, staff!: WorkspaceStaffStore, host!: WorkspaceGroupHost
  let route!: ReturnType<typeof workspaceV2Routes>
  let learning: ExperienceLearning | undefined
  const mount = () => {
    store = new WorkspaceV2Store(root, scope, options.turnLimit ?? 10, { rosterGroups: true })
    staff = new WorkspaceStaffStore(root, scope, () => NATIVE, id => store.workspace(id))
    host = new WorkspaceGroupHost({ root, scope, store, approvals,
      roster: workspaceId => groupRoster({ workspaceId, staff: staff.view(workspaceId).members, native: NATIVE, defaults: { liaisonPinned: false },
        context: id => staff.context(workspaceId, id), liaisonName: '接口人' }),
      runners: { dsh, codex } })
    learning = options.llm && createExperienceLearning({root, scope, staff, writable: id => store.writable(id),
      llm: () => options.llm, model: () => ({provider: 'fixture', model: 'fixture'})})
    route = workspaceV2Routes({ staff, store, source, approvals, groups: host, learning, inputAttachments: options.inputAttachments, coordinate: options.coordinate, ...options.review && { review }, ...options.judge && { judge: async () => options.judge! },
      remind: (key, text, _order, extra) => reminders.push({ key, text, ...extra?.localOnly && { localOnly: true } }) })
    route.recover()
  }
  mount()
  const dispose = () => { route.dispose(); host.dispose(); learning?.dispose() }
  cleanup.push(dispose)
  const restart = () => { dispose(); mount() }
  async function call<T = { error: string }>(path: string, body?: Record<string, unknown>, outsideWorkspace = false) {
    const url = new URL('/chief/api/v2' + (outsideWorkspace ? '' : '/workspaces') + path, 'http://local')
    url.searchParams.set('scope', scope)
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method: body ? 'POST' : 'GET', url: url.pathname + url.search, headers: { 'x-chief-request': '1' },
    }) as unknown as IncomingMessage
    let status = 0, data: T
    const res = { writeHead(code: number) { status = code }, end(value: string) { data = JSON.parse(value) } } as unknown as ServerResponse
    await serveApi(req, res, 'dsh', [route], true)
    return { status, data: data! }
  }
  let serial = 0
  const id = () => 'req-' + ++serial
  const workspace = async () => {
    const r = await call<{ workspace: V2Workspace }>('', { requestId: id(), name: '方舟评测', goal: '评测方舟模型服务' })
    const ws = r.data.workspace
    staff.apply(ws.id, { action: 'join', staffId: 'engineer', duty: '效果评测', requestId: id() })
    staff.apply(ws.id, { action: 'join', staffId: 'researcher', duty: '调研', requestId: id() })
    return ws
  }
  const group = async (ws: V2Workspace) => (await call<{ session: V2Session }>('/' + ws.id + '/sessions', { requestId: id(), title: '端点排查', kind: 'coding', executor: 'codex' })).data.session
  const say = (session: V2Session, text: string, extra: Record<string, unknown> = {}) =>
    call<{ messageId: string; deliveries: { memberId: string; outcome: string }[]; command?: { outcome: string } }>('/' + session.workspaceId + '/sessions/' + session.id + '/messages', { requestId: id(), text, ...extra })
  const view = (session: V2Session) => call<{ messages: GroupMessage[]; group: { members: GroupMemberState[]; paused?: GroupPauseState; approvals: V2PendingApproval[] }; working?: true; portraits: Record<string, unknown> }>('/' + session.workspaceId + '/sessions/' + session.id)
  const order = (ws: V2Workspace, orderId: string) => store.delegation(ws.id, orderId)
  return { root, call, id, workspace, group, say, view, order, dsh, codex, reminders, pending, answered, review, source, restart,
    store: () => store, staff: () => staff, host: () => host, route: () => route }
}

describe('群成员的成长记录', () => {
  const model = (lesson: string, texts: string[], groupLesson?: string) => ({async *stream(request) {
    const input = JSON.parse(request.messages[0]!.content[0]!.text) as {summary?: string; evidence?: ExperienceEvidence[]}
    const proof = input.evidence?.[0]
    const text = proof?.kind === 'group' ? lesson : proof?.kind === 'delivery' ? groupLesson : undefined
    const answer = input.evidence ? {changes: text && proof ? [{action: 'learn', text, basis: [proof.id]}] : []} : {action: 'none'}
    if (input.summary) texts.push(input.summary)
    yield {type: 'text-delta', text: JSON.stringify(answer)}
  }} satisfies Pick<Llm, 'stream'>)

  it.each([false, true])('从宿主持久化的成员成果生成本区个人候选（协调器 %s）', async coordinate => {
    const lesson = '排查端点超时时先用只读命令核对区域配置，再检查重试日志。'
    const texts: string[] = []
    const f = fixture({
      coordinate: coordinate ? async () => ({kind: 'none'}) : undefined,
      llm: model(lesson, texts),
    })
    const ws = await f.workspace(), other = await f.workspace(), session = await f.group(ws)
    await f.say(session, '@工程师 排查端点超时')
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    const {call, sink} = f.codex.last('engineer')
    sink.stepped(call.callId, '正在查看日志。')
    expect(texts).toEqual([])
    const result = '核实超时端点用了另一个区域。根据只读配置输出与重试日志定位了错误。'
    f.codex.answer('engineer', result)
    const source = (await f.view(session)).data.messages.find(message => message.text === result)!
    const local = () => f.call<StaffView>('/' + ws.id + '/staff')
    const memory = expect.objectContaining({audience: 'staff', staffId: 'engineer', discoveredBy: 'engineer',
      workspaceId: ws.id, status: 'proposed', text: lesson, evidence: [expect.objectContaining({kind: 'group',
        workspaceId: ws.id, sessionId: session.id, messageId: source.id, quote: result})]})
    await vi.waitFor(async () => expect((await local()).data.memories).toEqual([memory]))
    expect((await local()).data.sharedExperiences).toBeUndefined()
    expect((await f.call<StaffView>('/staff', undefined, true)).data.memories).toEqual([memory])
    expect((await f.call<StaffView>('/' + other.id + '/staff')).data.memories).toEqual([])

    await f.say(session, '@研究员 看一下结论')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    f.dsh.answer('researcher', '收到，谢谢。', false)
    await f.say(session, '@研究员 再核对一次')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(2))
    const retry = f.dsh.last('researcher')
    retry.sink.stepped(retry.call.callId, '还在核对配置。')
    retry.sink.finished(retry.call.callId, {status: 'failed', text: '', toolCalls: 0, detail: '没有取到日志'})
    f.restart()
    const organized = await f.call<StaffView>('/' + ws.id + '/staff', {action: 'organize', requestId: f.id()})
    expect(organized.data.memories).toEqual([memory])
    expect(texts).toEqual([result])
  })

  it('正式阶段回报可作为候选依据，普通过程发言和空结束没有新条目', async () => {
    const texts: string[] = []
    const lesson = '核对现行端点价格时将活动折扣和标准单价分列。'
    const groupLesson = '价格表的标准单价与活动折扣各附原始价目表。'
    const f = fixture({llm: model(lesson, texts, groupLesson)})
    const ws = await f.workspace()
    const job = f.route().assign('owner-growth', '让研究员核实端点价格', undefined, ws.id, undefined,
      {title: '端点价格', promise: '可核对的端点价格表'}, 'researcher')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    const {call, sink} = f.dsh.last('researcher')
    const report = '阶段回报\n已核对标准单价和活动折扣。两类价格分别采自不同的价目表。'
    sink.stepped(call.callId, report)
    const read = (await f.view(job.session)).data
    const source = read.messages.find(message => message.text === report)!
    const local = () => f.call<StaffView>('/' + ws.id + '/staff')
    const memory = expect.objectContaining({audience: 'staff', staffId: 'researcher', status: 'proposed', text: lesson,
      orderId: job.delegation.id, evidence: [expect.objectContaining({messageId: source.id, orderId: job.delegation.id, quote: report})]})
    await vi.waitFor(async () => expect((await local()).data.memories).toEqual([memory]))
    f.dsh.answer('researcher', '[PASS]', false)
    f.restart()
    const organized = await f.call<StaffView>('/' + ws.id + '/staff', {action: 'organize', requestId: f.id()})
    expect(organized.data.memories).toEqual([memory])
    expect(organized.data.sharedExperiences).toEqual([expect.objectContaining({audience: 'shared', text: groupLesson,
      workspaceId: ws.id, status: 'proposed', evidence: [expect.objectContaining({kind: 'delivery', messageId: source.id})]})])
    expect(texts.filter(text => text === report)).toHaveLength(1)
  })
})

describe('工作交接', () => {
  const waitFor = (check: () => void | Promise<void>) => vi.waitFor(check, {timeout: 3000, interval: 15})

  it('无工单问题跨页面、跨重启保留，关联到有效答复之后解除', async () => {
    const question = '请确认本次调查采用哪个数据版本？'
    const f = fixture({coordinate: async input => {
      if (input.turn === 'liaison' && input.source.text === question) return {kind: 'ask', text: question, sourceSeq: input.source.seq}
      if (input.turn === 'owner' && input.source.text === '采用上周五的校对版') {
        return {kind: 'none', resolved: input.pending.slice(0, 1).map(row => row.id)}
      }
      return {kind: 'none'}
    }})
    const ws = await f.workspace(), session = await f.group(ws)
    const pending = async () => (await f.call<{items: OwnerAction[]}>('/owner-actions', undefined, true)).data.items
    await f.say(session, '请汇总这次调查')
    f.dsh.answer('liaison', question, false)
    await waitFor(async () => expect(await pending()).toHaveLength(1))
    const [action] = await pending()
    expect(action).toMatchObject({workspaceId: ws.id, sessionId: session.id, question})
    expect((await f.view(session)).data.messages).toContainEqual(expect.objectContaining({id: action!.messageId, text: question}))
    await f.say(session, '先等等，我去找资料')
    expect(await pending()).toEqual([action])
    f.restart()
    expect(await pending()).toEqual([action])
    const body = {requestId: 'answer-data-version', text: '采用上周五的校对版'}
    const path = '/owner-actions/' + action!.id + '/reply'
    expect((await f.call(path, body, true)).status).toBe(200)
    await waitFor(async () => expect(await pending()).toEqual([]))
    expect((await f.call(path, body, true)).status).toBe(200)
    expect((await f.view(session)).data.messages.filter(row => row.text === body.text)).toHaveLength(1)
  })

  it.each([['final', 8], ['each', 8], ['final', 21]] as const)('无工具工作按 %s 约定发布，累计 %s 项', async (reporting, expected) => {
    let retainedFirst = false
    const f = fixture({turnLimit: 40, coordinate: async input => {
      if (input.turn !== 'member') return {kind: 'none'}
      const round = Number(input.source.text.match(/回报 (\d+)/)?.[1])
      if (round === expected) {
        retainedFirst = input.messages.some(row => row.text === '工单回报\n\n回报 1')
        return {kind: 'deliver', text: '全部项目已核对。', final: true}
      }
      return {kind: 'continue', text: '请继续完成第 ' + (round + 1) + ' 项', memberIds: ['engineer'],
        ...(reporting === 'each' && {checkpoint: 'item-' + round, report: '已核对第 ' + round + ' 项'})}
    }})
    const ws = await f.workspace(), session = await f.group(ws)
    f.route().assign('assign-sequential', '请逐项完成 ' + expected + ' 项核查。', undefined, ws.id, session.id,
      {title: '逐项核查', promise: '按约交回各项结果和证据'}, 'engineer', undefined, '先完成第 1 项', undefined, undefined, reporting)
    const notices = async () => (await f.call<ResultNoticeList>('/notices', undefined, true)).data.items
    for (let round = 1; round <= expected; round++) {
      await waitFor(() => expect(f.codex.count('engineer')).toBe(round))
      expect(f.codex.last('engineer').call.prompt).toContain('第 ' + round + ' 项')
      f.codex.answer('engineer', '工单回报\n\n回报 ' + round, false)
      if (round < expected) {
        await waitFor(() => expect(f.codex.count('engineer')).toBe(round + 1))
        expect(await notices()).toHaveLength(reporting === 'final' ? 0 : round)
      }
    }
    await waitFor(async () => expect(await notices()).toHaveLength(reporting === 'final' ? 1 : expected))
    expect(retainedFirst).toBe(true)
    f.restart()
    expect(await notices()).toHaveLength(reporting === 'final' ? 1 : expected)
    expect(f.codex.count('engineer')).toBe(expected)
  })

  it('并行工作中的一个分支等待主人时，另一分支继续并保留其交付证据', async () => {
    const question = '设计需要你选定采用哪个版本。'
    const f = fixture({turnLimit: 20, coordinate: async input => {
      const {turn, source, pending} = input
      if (turn === 'liaison' && source.text === '可以并行复核内容和版式') {
        return {kind: 'continue', text: '分别复核内容和版式', memberIds: ['engineer', 'researcher']}
      }
      if (turn === 'member' && source.text === '版式版本未定') return {kind: 'ask', text: question}
      if (turn === 'member' && source.text === '内容已经核对') {
        return {kind: 'continue', text: '继续核实出处', memberIds: ['researcher']}
      }
      if (turn === 'owner' && pending.length && source.text === '采用第二版') {
        return {kind: 'continue', text: '按主人确认的第二版定稿', memberIds: ['engineer'], resolved: [pending[0]!.id]}
      }
      if (turn === 'member' && source.text === '版式已经定稿') {
        return {kind: 'deliver', text: '内容、出处和版式均已核对。', final: true}
      }
      return {kind: 'none'}
    }})
    const ws = await f.workspace(), session = await f.group(ws)
    const {delegation} = f.route().assign('assign-parallel', '请核对内容和版式后一起汇报。', undefined, ws.id, session.id,
      {title: '会签文稿', promise: '按核对后的内容和版式定稿并汇报'})
    await waitFor(() => expect(f.dsh.count('liaison')).toBe(1))
    f.dsh.answer('liaison', '可以并行复核内容和版式', false)
    await waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    f.codex.answer('engineer', '版式版本未定', false)
    const pending = async () => (await f.call<{items: OwnerAction[]}>('/owner-actions', undefined, true)).data.items
    await waitFor(async () => expect(await pending()).toHaveLength(1))
    const [action] = await pending()
    expect(action).toMatchObject({orderId: delegation.id, question})
    f.dsh.answer('researcher', '内容已经核对', false)
    await waitFor(() => expect(f.dsh.count('researcher')).toBe(2))
    f.dsh.answer('researcher', '出处已经核实', false)
    expect(await pending()).toEqual([action])
    expect((await f.call<ResultNoticeList>('/notices', undefined, true)).data.items).toEqual([])
    const reply = await f.call('/owner-actions/' + action!.id + '/reply', {requestId: 'apply-second-version', text: '采用第二版'}, true)
    expect(reply.status).toBe(200)
    await waitFor(() => expect(f.codex.count('engineer')).toBe(2))
    f.codex.answer('engineer', '版式已经定稿', false)
    await waitFor(async () => expect((await f.call<ResultNoticeList>('/notices', undefined, true)).data.items).toHaveLength(1))
    expect(await pending()).toEqual([])
  })

  it('默认团队工单自行开始，计时复核后继续未知步数的调查', async () => {
    let checked = 0
    const f = fixture({coordinate: async ({source, turn}) => {
      if (turn === 'liaison' && source.text === '先检查记录是否完整') {
        return {kind: 'continue', text: '核对现有材料', memberIds: ['researcher']}
      }
      if (turn === 'member' && source.text === '还在等每日公开数据') {
        checked += 1
        if (checked === 1) return {kind: 'wait', reason: '研究员等待每日公开数据，到点复核',
          reviewAt: new Date(Date.now() + 250).toISOString()}
        return {kind: 'continue', text: '复核公开数据和已留材料', memberIds: ['researcher']}
      }
      if (turn === 'member' && source.text === '公开材料支持最终结论') return {kind: 'deliver', final: true, text: source.text}
      return {kind: 'none'}
    }})
    const ws = await f.workspace(), session = await f.group(ws)
    const created = await f.call<{delegation: V2Delegation}>('/' + ws.id + '/orders', {
      requestId: 'form-default-team', sessionId: session.id, title: '追查周报差异', promise: '核实差异原因并汇报',
    })
    expect(created.status).toBe(200)
    await waitFor(() => expect(f.dsh.count('liaison')).toBe(1))
    f.dsh.answer('liaison', '先检查记录是否完整', false)
    await waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    f.dsh.answer('researcher', '还在等每日公开数据', false)
    await waitFor(() => expect(f.order(ws, created.data.delegation.id).reason).toContain('等待每日公开数据'))
    f.restart()
    await waitFor(() => expect(f.dsh.count('researcher')).toBe(2))
    expect(f.dsh.last('researcher').call.prompt).toContain('复核公开数据和已留材料')
    f.dsh.answer('researcher', '公开材料支持最终结论', false)
    await waitFor(async () => expect((await f.call<ResultNoticeList>('/notices', undefined, true)).data.items).toHaveLength(1))
    expect((await f.call<{items: OwnerAction[]}>('/owner-actions', undefined, true)).data.items).toEqual([])
  })

  it('主人修改汇报约定后，旧判断无法发布，草案和定稿各发一次', async () => {
    const oldReview = Promise.withResolvers<EngagementDecision>()
    const started = Promise.withResolvers<void>()
    const f = fixture({coordinate: async ({source, turn}) => {
      if (turn !== 'member') return {kind: 'none'}
      if (source.text === '旧范围已经交回') { started.resolve(); return oldReview.promise }
      if (source.text === '新范围草案交回') {
        return {kind: 'continue', memberIds: ['engineer'], text: '按草案完成定稿', checkpoint: 'draft', report: '草案已核对'}
      }
      return {kind: 'deliver', text: '定稿已核对', final: true}
    }})
    const ws = await f.workspace(), session = await f.group(ws)
    const {delegation} = f.route().assign('assign-milestone', '只需交回最终文稿。', undefined, ws.id, session.id,
      {title: '整理工作简报', promise: '提交定稿'}, 'engineer', undefined, '开始整理')
    await waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    f.codex.answer('engineer', '旧范围已经交回', false)
    await started.promise
    await f.route().follow('change-milestone', '调整范围，草案和定稿各发一次。', ws.id, delegation.id, '按新范围先交草案', undefined, 'milestone')
    oldReview.resolve({kind: 'deliver', text: '旧结果', final: true})
    await waitFor(() => expect(f.codex.count('engineer')).toBe(2))
    expect((await f.call<ResultNoticeList>('/notices', undefined, true)).data.items).toEqual([])
    f.codex.answer('engineer', '新范围草案交回', false)
    await waitFor(() => expect(f.codex.count('engineer')).toBe(3))
    expect((await f.call<ResultNoticeList>('/notices', undefined, true)).data.items).toMatchObject([{kind: 'partial'}])
    f.codex.answer('engineer', '新范围定稿交回', false)
    await waitFor(async () => expect((await f.call<ResultNoticeList>('/notices', undefined, true)).data.items.map(row => row.kind).sort()).toEqual(['partial', 'report']))
    f.restart()
    expect((await f.call<ResultNoticeList>('/notices', undefined, true)).data.items).toHaveLength(2)
  })
})

describe('主人聊天材料', () => {
  const a: ChatInputAttachment = {id: 'a', name: '@所有人 收单.txt', kind: 'file', bytes: 6}
  const b: ChatInputAttachment = {id: 'b', name: a.name, kind: 'file', bytes: 8}

  it('仅附件消息持久回显；同号同序只调用一次，改序冲突；文件名不点人、不进入成果', async () => {
    const resolve = vi.fn((_target: unknown, ids: unknown) => (ids as string[]).map(id => id === 'a' ? a : b))
    const grant = vi.fn()
    const f = fixture({inputAttachments: {resolve, grant}, judge: 'complete'})
    const ws = await f.workspace(), session = await f.group(ws)
    const body = {inputAttachments: [a.id, b.id], requestId: 'files-only'}
    const sent = await f.say(session, '', body)
    expect(sent.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith({workspaceId: ws.id, sessionId: session.id, workOrderId: undefined}, body.inputAttachments)
    expect(f.dsh.last('liaison').call.inputAttachments).toEqual([a, b])
    expect(f.codex.calls).toHaveLength(0)
    expect((await f.say(session, '', body)).data.messageId).toBe(sent.data.messageId)
    expect((await f.say(session, '', {...body, inputAttachments: [b.id, a.id]})).status).toBe(409)
    expect(f.dsh.calls).toHaveLength(1)
    f.restart()
    const owner = (await f.view(session)).data.messages.find(row => row.id === sent.data.messageId)
    expect(owner).toMatchObject({text: '', inputAttachments: [a, b]})
    expect(owner).not.toHaveProperty('attachments')
    expect(owner).not.toHaveProperty('mentions')
    expect((await f.say(session, '', body)).data.messageId).toBe(sent.data.messageId)
    expect((await f.say(session, '', {inputAttachments: []})).status).toBe(400)
    const plain = await f.say(session, '谢谢', {requestId: 'legacy-plain'})
    expect((await f.say(session, '谢谢', {requestId: 'legacy-plain', inputAttachments: []})).data.messageId).toBe(plain.data.messageId)
  })

  it('私聊交办和补充在群尚未启动时保存，重启后分别转授同名的两版原件', async () => {
    const grant = vi.fn()
    const f = fixture({inputAttachments: {resolve: () => [], grant}})
    const ws = await f.workspace()
    const original = '让研究员比较报价'
    const args = ['src-a', original, undefined, ws.id, undefined, {title: '比较', promise: '列出差额'}, {id:'researcher', name:'研究员', token:'token'}, undefined, '请核对报价。', undefined] as const
    const job = f.store().assign(...args, [a])
    expect(f.store().assign(...args, [a]).delegation.id).toBe(job.delegation.id)
    expect(() => f.store().assign(...args, [b])).toThrow()
    f.store().groupFollow('src-b', '比较新版', ws.id, job.delegation.id, '请比较两版', [b])
    expect(f.store().pendingGroupStarts().map(row => row.inputAttachments)).toEqual([[a], [b]])
    expect(grant).not.toHaveBeenCalled()
    f.restart()
    await vi.waitFor(() => expect(f.store().pendingGroupStarts()).toEqual([]))
    const destination = {workspaceId: ws.id, sessionId: job.session.id, workOrderId: job.delegation.id}
    expect(grant.mock.calls).toEqual([[destination, [a]], [destination, [b]]])
    const lines = (await f.view(job.session)).data.messages.filter(row => row.inputAttachments)
    expect(lines.map(row => [row.quote?.text, row.inputAttachments, row.attachments])).toEqual([[original, [a], undefined], ['比较新版', [b], undefined]])
    expect(f.dsh.last('researcher').call.inputAttachments).toEqual([a])
    expect((await f.route().follow('src-b', '比较新版', ws.id, job.delegation.id, '请比较两版', [b])).state).toBe('sent')
    await expect(f.route().follow('src-b', '比较新版', ws.id, job.delegation.id, '请比较两版', [a])).rejects.toThrow()
    const outputs = await f.call<{outputs: unknown[]}>('/' + ws.id + '/orders/' + job.delegation.id + '/outputs')
    expect(outputs.data.outputs).toEqual([])
  })

  it('仅有一张工单时，待判断指令按原群范围验附件，重启补发前授予工单权限，再按主人选择转给成员', async () => {
    let offline = true
    const grant = vi.fn(() => { if (offline) throw new Error('暂时无法登记授权') })
    const resolve = vi.fn(() => [a])
    const f = fixture({judge:'ambiguous', inputAttachments:{resolve,grant}})
    const ws = await f.workspace()
    const job = f.route().assign('held-setup','研究员检查报价',undefined,ws.id,undefined,undefined,'researcher')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    const input = {inputAttachments:[a.id], requestId:'held-input'}
    expect((await f.say(job.session,'可以验收了',input)).status).toBeGreaterThanOrEqual(400)
    expect(resolve).toHaveBeenCalledWith({workspaceId:ws.id,sessionId:job.session.id,workOrderId:undefined}, [a.id])
    expect(f.store().unpostedCommands()).toMatchObject([{inputAttachments:[a],orderId:job.delegation.id}])
    offline = false
    grant.mockClear()
    f.restart()
    await vi.waitFor(() => expect(f.store().unpostedCommands()).toHaveLength(0))
    expect(grant).toHaveBeenCalledWith({workspaceId:ws.id,sessionId:job.session.id,workOrderId:job.delegation.id}, [a])
    const owner = (await f.view(job.session)).data.messages.find(row => row.inputAttachments?.length)!
    expect(owner).toMatchObject({held:'choosing',inputAttachments:[a]})
    const forwarded = await f.call('/' + ws.id + '/sessions/' + job.session.id + '/messages/' + owner.id + '/forward', {requestId:f.id()})
    expect(forwarded.status).toBe(200)
    expect(f.dsh.last('liaison').call.inputAttachments).toEqual([a])
  })
})

describe('新会话都是群（engine: roster），执行者不再可选', () => {
  it('建会话时传来的类型与执行者被接受但忽略；旧看板（不开群聊）照旧', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    expect(session).toMatchObject({ kind: 'group', executor: 'dsh', engine: 'roster', title: '端点排查', delegationIds: [] })
    const legacyRoot = mkdtempSync(join(tmpdir(), 'chief-group-legacy-'))
    cleanup.push(() => rmSync(legacyRoot, { recursive: true, force: true }))
    expect(new WorkspaceV2Store(legacyRoot, 'x', 4).rosterGroups).toBe(false)
  })
})

describe('主人在群里发言', () => {
  it('没 @ 先给接口人；读取返回账本投影（提及分段、成员状态、在干活）', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    const said = await f.say(session, '看一下 arkcli 能不能拿到当前开通的端点')
    expect(said.status).toBe(200)
    expect(said.data).toMatchObject({ messageId: 'g-1', deliveries: [{ memberId: 'liaison', outcome: 'started' }] })
    await vi.waitFor(() => expect(f.dsh.count('liaison')).toBe(1))
    let read = (await f.view(session)).data
    expect(read.messages[0]).toMatchObject({ id: 'g-1', seq: 1, kind: 'message', role: 'user', author: '你', speakerId: 'owner', text: '看一下 arkcli 能不能拿到当前开通的端点' })
    expect(read.working).toBe(true)
    expect(read.group.members.map(m => [m.id, m.name, m.kind, m.admin, m.status])).toEqual([
      ['liaison', '接口人', 'dsh', true, 'speaking'], ['engineer', '工程师', 'codex', false, 'idle'], ['researcher', '研究员', 'dsh', false, 'idle']])
    f.dsh.answer('liaison', '@工程师 请在项目目录用 arkcli 列出当前开通的端点。', false)
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    read = (await f.view(session)).data
    expect(read.messages[1]).toMatchObject({ id: 'g-2', author: '接口人', replyTo: 'g-1', mentions: [{ memberId: 'engineer', label: '工程师' }, { text: ' 请在项目目录用 arkcli 列出当前开通的端点。' }] })
    expect(read.group.members.find(m => m.id === 'engineer')).toMatchObject({ status: 'speaking', note: '接口人 @ 了你' })
    expect(Object.keys(read.portraits)).toEqual(expect.arrayContaining([read.messages[1]!.speakerId]))
    // Each member carries its duty here, so the @ menu needs no staff read; the owner's line says where it went.
    expect(read.group.members.map(m => [m.id, m.duty])).toEqual([['liaison', undefined], ['engineer', '效果评测'], ['researcher', '调研']])
    expect(read.messages[0]!.deliveries).toEqual([{ memberId: 'liaison', outcome: 'started' }])
    expect(read.group.paused).toBeUndefined()
    // What the engineer does now: its latest command (secrets hidden) and its latest words.
    const engineer = f.codex.last('engineer')
    engineer.sink.tool(engineer.call.callId, { name: 'shell', team: false, detail: 'arkcli endpoint list --token=abc123secret' })
    engineer.sink.stepped(engineer.call.callId, '我先列一下开通的端点。')
    read = (await f.view(session)).data
    expect(read.group.members.find(m => m.id === 'engineer')).toMatchObject({
      tool: { name: 'shell', detail: 'arkcli endpoint list --token=‹已隐去›', at: expect.any(String) }, progress: { text: '我先列一下开通的端点。', at: expect.any(String) } })
  })

  it('SuperHub 自己写的事件行不带发言人（没有头像）；暂停时视图里明确给出原因、起始时间与挂起数', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    await f.say(session, '@工程师 @研究员 各自查一下')
    await vi.waitFor(() => expect(f.codex.count('engineer') + f.dsh.count('researcher')).toBe(2))
    await f.call('/' + ws.id + '/sessions/' + session.id + '/stop', { requestId: f.id() })
    const read = (await f.view(session)).data
    const event = read.messages.find(m => m.kind === 'event')!
    expect(event).toMatchObject({ event: 'stopped', author: 'SuperHub', role: 'agent' })
    expect('speakerId' in event).toBe(false)
    expect(Object.keys(read.portraits)).not.toContain('host')
    // Two members trade pleasantries until the idle guard pauses automatic calls.
    await f.say(session, '@研究员 跟工程师打个招呼')
    let speaker: 'researcher' | 'engineer' = 'researcher'
    for (let i = 0; i < 12 && !(await f.view(session)).data.group.paused; i++) {
      await vi.waitFor(() => expect(speaker === 'researcher' ? f.dsh.last('researcher') : f.codex.last('engineer')).toBeTruthy())
      const runner = speaker === 'researcher' ? f.dsh : f.codex
      runner.answer(speaker, '@' + (speaker === 'researcher' ? '工程师' : '研究员') + ' 好的，收到', false)
      speaker = speaker === 'researcher' ? 'engineer' : 'researcher'
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const paused = (await f.view(session)).data
    const line = paused.messages.findLast(m => m.event === 'paused')!
    expect(paused.group.paused).toEqual({ reason: line.text, since: expect.any(String), parked: 1, messageId: line.id })
  })

  it('对方在干活时，主人的话立即送进它在跑的回合（不另开一次）；送不进才排队', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    await f.say(session, '@工程师 跑一遍评测')
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    f.codex.steerAnswer = 'steered'
    const steered = await f.say(session, '@工程师 先别删 build 目录')
    expect(steered.data.deliveries).toEqual([{ memberId: 'engineer', outcome: 'steered' }])
    expect(f.codex.steered).toEqual([{ callId: f.codex.last('engineer').call.callId, id: 'steer-2', text: expect.stringContaining('#2 主人：@工程师 先别删 build 目录') }])
    f.codex.steerAnswer = undefined
    const queued = await f.say(session, '@工程师 再加一项：看配额')
    expect(queued.data.deliveries).toEqual([{ memberId: 'engineer', outcome: 'queued' }])
    f.codex.answer('engineer', '评测跑完了')
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(2))
    expect(f.codex.last('engineer').call.prompt).toContain('#3 主人：@工程师 再加一项：看配额')
    expect(f.codex.last('engineer').call.prompt).not.toContain('#2 主人')
  })

  it('同一请求号重试不会说两遍；请求号换内容 409；会话关闭后 409', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    const path = '/' + ws.id + '/sessions/' + session.id
    expect((await f.call(path + '/messages', { requestId: 'same', text: '你好' })).status).toBe(200)
    expect((await f.call(path + '/messages', { requestId: 'same', text: '你好' })).data).toMatchObject({ messageId: 'g-1', deliveries: [] })
    expect((await f.call(path + '/messages', { requestId: 'same', text: '换了' })).status).toBe(409)
    await f.call(path + '/close', { requestId: f.id() })
    expect((await f.say(session, '还在吗')).status).toBe(409)
    expect((await f.view(session)).data.messages).toHaveLength(1)
  })
})

describe('接口人交办进群（assign / follow_order）', () => {
  it('主人点名幕僚：接口人发交办说明 @ 他并附主人原话；执行者参数被忽略；每次成员被叫扣一轮额度', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const job = f.route().assign('owner-1', '让研究员查一下方舟的计费规则', 'codex', ws.id, undefined, { title: '方舟计费', promise: '列出计费规则' }, 'researcher', undefined, '请整理方舟当前的计费规则，给出表格。')
    expect(job.session).toMatchObject({ engine: 'roster', kind: 'group' })
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    const read = (await f.view(job.session)).data
    expect(read.messages[0]).toMatchObject({ author: '接口人', role: 'agent', workOrderId: job.delegation.id, text: '@研究员 请整理方舟当前的计费规则，给出表格。',
      quote: { label: '主人原话', text: '让研究员查一下方舟的计费规则' } })
    expect(f.dsh.last('researcher').call.workOrderId).toBe(job.delegation.id)
    expect(f.order(ws, job.delegation.id)).toMatchObject({ remainingTurns: 9, status: 'active', staffId: 'researcher' })
    expect(f.store().pendingGroupStarts()).toEqual([])
    // Replays keep the same order and do not post twice.
    expect(f.route().assign('owner-1', '让研究员查一下方舟的计费规则', 'dsh', ws.id, undefined, { title: '方舟计费', promise: '列出计费规则' }, 'researcher', undefined, '请整理方舟当前的计费规则，给出表格。').delegation.id).toBe(job.delegation.id)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((await f.view(job.session)).data.messages.filter(m => m.author === '接口人')).toHaveLength(1)
    f.dsh.answer('researcher', '计费按 token。')
    // No reviewer here: the liaison is woken on the order as usual (another call on its budget), then the order waits.
    await vi.waitFor(() => expect(f.dsh.count('liaison')).toBe(1))
    expect(f.order(ws, job.delegation.id).remainingTurns).toBe(8)
    f.dsh.answer('liaison', '研究员查到：计费按 token。', false)
    await vi.waitFor(() => expect(f.order(ws, job.delegation.id).status).toBe('waiting'))
  })

  it('没点名：接口人自己被叫来按分工派活；从打开的群交办沿用该群；带目录的单开新群在那个目录', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const first = f.route().assign('owner-2', '看一下 arkcli 能不能拿到当前开通的端点', undefined, ws.id, undefined, { title: '查端点', promise: '列出开通的端点' }, undefined, undefined, '请查清当前开通的端点。')
    await vi.waitFor(() => expect(f.dsh.count('liaison')).toBe(1))
    expect(f.dsh.last('liaison').call.prompt).toContain('#1 接口人：请查清当前开通的端点。\n主人原话：\n> 看一下 arkcli 能不能拿到当前开通的端点')
    expect(f.dsh.last('liaison').call.prompt).toContain('这次：主人在「一句话交办」交给你这张工单')
    const second = f.route().assign('owner-3', '顺便看下配额', undefined, ws.id, first.session.id, { title: '查配额', promise: '列出配额' })
    expect(second.session.id).toBe(first.session.id)
    expect(f.store().session(ws.id, first.session.id).delegationIds).toEqual([first.delegation.id, second.delegation.id])
    const project = mkdtempSync(join(tmpdir(), 'chief-group-project-'))
    cleanup.push(() => rmSync(project, { recursive: true, force: true }))
    const third = f.route().assign('owner-4', '在 ' + project + ' 里检查 README', undefined, ws.id, first.session.id, { title: '查 README', promise: '列出过时的命令' }, undefined, undefined, undefined, project)
    expect(third.session.id).not.toBe(first.session.id)
    expect(f.store().session(ws.id, third.session.id)).toMatchObject({ engine: 'roster', directory: project })
    await vi.waitFor(() => expect(f.dsh.count('liaison')).toBe(2))
    expect(f.dsh.last('liaison').call.group.workDir).toBe(project)
    const overview = (await f.call<{ directories: Record<string, { source: string; path?: string }> }>('/' + ws.id)).data
    expect(overview.directories[third.delegation.id]).toEqual({ source: 'order', path: project })
    expect(overview.directories[first.delegation.id]).toMatchObject({ source: 'superhub' })
  })

  it('follow_order：补充以接口人的话进同一个群并附原话，点过名的幕僚被 @', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const job = f.route().assign('owner-5', '让研究员查计费', undefined, ws.id, undefined, { title: '查计费', promise: '计费规则' }, 'researcher')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    f.dsh.answer('researcher', '计费按 token')
    const followed = await f.route().follow('owner-6', '再补充包月价格', ws.id, job.delegation.id, '请补上包月价格。')
    expect(followed.state).toBe('queued')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(2))
    const lines = (await f.view(job.session)).data.messages
    expect(lines.at(-1)).toMatchObject({ author: '接口人', text: '@研究员 请补上包月价格。', quote: { label: '主人原话', text: '再补充包月价格' } })
  })
})

describe('验收：工单批次落地后接口人按约定核对', () => {
  async function dispatched(f: ReturnType<typeof fixture>) {
    const ws = await f.workspace()
    const job = f.route().assign('owner-a', '看 arkcli 能不能列端点', undefined, ws.id, undefined, { title: '查端点', promise: '列出开通的端点' }, undefined, undefined, '请查清开通的端点。')
    await vi.waitFor(() => expect(f.dsh.count('liaison')).toBe(1))
    f.dsh.answer('liaison', '@工程师 用 arkcli 列一下端点', false)
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    return { ws, job }
  }

  it('通过：接口人在群里发核对结论，附「确认收单」，并在「一句话交办」汇报一次（只在站内）', async () => {
    const f = fixture({ review: [{ verdict: 'pass', message: '三个端点都列出来了。', gaps: [] }] })
    const { ws, job } = await dispatched(f)
    f.codex.answer('engineer', '当前开通 3 个端点：ep-1、ep-2、ep-3。')
    await vi.waitFor(() => expect(f.order(ws, job.delegation.id).acceptance?.verdict).toBe('pass'))
    expect(f.review).toHaveBeenCalledWith(expect.objectContaining({ title: '查端点', promise: '列出开通的端点', original: '看 arkcli 能不能列端点',
      results: expect.stringContaining('工程师：当前开通 3 个端点') }), expect.anything())
    const read = await vi.waitFor(async () => {
      const data = (await f.view(job.session)).data
      expect(data.messages.at(-1)?.text).toBe('已对照约定核对：三个端点都列出来了。')
      return data
    })
    expect(read.messages.at(-1)).toMatchObject({ author: '接口人', workOrderId: job.delegation.id, actions: [{ kind: 'complete', label: '确认收单' }] })
    // The verdict is the liaison's answer: it is not woken again on top of it.
    expect(f.dsh.count('liaison')).toBe(1)
    expect(f.reminders).toEqual([expect.objectContaining({ key: expect.stringMatching(new RegExp('^workspace-done:' + job.delegation.id + ':grp-')), localOnly: true })])
    const done = await f.call<{ order: V2Delegation }>('/' + ws.id + '/orders/' + job.delegation.id + '/action', { requestId: f.id(), action: 'complete', from: read.messages.at(-1)!.id })
    expect(done.data.order.status).toBe('done')
  })

  it('缺口：先 @ 原来的人追问一次；再不足转主人决定并提醒', async () => {
    const f = fixture({ review: [{ verdict: 'gap', message: '只列了名字。', gaps: ['每个端点的模型'] }, { verdict: 'gap', message: '还是没有模型。', gaps: ['每个端点的模型'] }] })
    const { ws, job } = await dispatched(f)
    f.codex.answer('engineer', '端点：ep-1、ep-2')
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(2))
    const follow = (await f.view(job.session)).data.messages.at(-1)!
    expect(follow).toMatchObject({ author: '接口人', mentions: [{ memberId: 'engineer', label: '工程师' }, expect.anything()] })
    expect(follow.text).toMatch(/^@工程师 只列了名字。\n\n还缺：\n1\. 每个端点的模型/)
    expect(f.order(ws, job.delegation.id).autoFollowUps).toBe(1)
    f.codex.answer('engineer', '端点：ep-1、ep-2（模型未知）')
    await vi.waitFor(() => expect(f.order(ws, job.delegation.id).acceptance?.awaitingOwner).toBe(true))
    await vi.waitFor(() => expect(f.reminders.map(row => row.key)).toEqual([expect.stringMatching(/^workspace-acceptance:/)]))
    const last = (await f.view(job.session)).data.messages.at(-1)!
    expect(last.text).toMatch(/^追问后仍有缺口，转给主人决定。/)
    expect(f.codex.count('engineer')).toBe(2)
    const decisions = (await f.call<{ acceptances: { orderId: string }[] }>('/../approvals')).data
    expect(decisions.acceptances?.map(row => row.orderId) ?? []).toEqual([job.delegation.id])
  })

  it('验收没做成：记 failed，提醒主人「中断」，并照常唤醒接口人去汇总', async () => {
    const f = fixture({ review: 'fail' })
    const { ws, job } = await dispatched(f)
    f.codex.answer('engineer', '3 个端点')
    await vi.waitFor(() => expect(f.order(ws, job.delegation.id).acceptance?.verdict).toBe('failed'))
    await vi.waitFor(() => expect(f.dsh.count('liaison')).toBe(2))
    expect(f.dsh.last('liaison').call.prompt).toContain('工程师 做完了你交代的活')
    expect(f.reminders.map(row => row.key)).toEqual([expect.stringMatching(/^workspace-stalled:/)])
  })

  it('主人用短话收单（judge）在群里照样管用：主人原话与接口人的说明进群，不叫成员', async () => {
    const f = fixture({ judge: 'complete' })
    const { ws, job } = await dispatched(f)
    const r = await f.say(job.session, '可以收单了', { workOrderId: job.delegation.id })
    expect(r.data.command).toMatchObject({ outcome: 'completed' })
    expect(f.order(ws, job.delegation.id).status).toBe('done')
    await vi.waitFor(async () => {
      const lines = (await f.view(job.session)).data.messages
      expect(lines.slice(-3).map(m => [m.author, m.text, m.held ?? null])).toEqual([
        ['SuperHub', '这张工单已收单，为它进行的工作已叫停。', null], ['你', '可以收单了', 'completed'], ['接口人', '已按你的话收单。', null]])
    })
    expect(f.codex.cancelled).toEqual([f.codex.last('engineer').call.callId])
  })
})

describe('工单交付提醒：成员在群里交出成果', () => {
  const notices = (f: ReturnType<typeof fixture>) => f.call<ResultNoticeList>('/../notices')
  async function assigned(f: ReturnType<typeof fixture>) {
    const ws = await f.workspace()
    const job = f.route().assign('owner-n', '让研究员整理方舟的计费规则', undefined, ws.id, undefined, { title: '方舟计费', promise: '一份计费表' }, 'researcher')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    return { ws, job, dir: f.host().workDir(job.session) }
  }

  it('链接文件的发言登记一条提醒：绑定工单、群、原话行与附件版本；已读两端共用，重启后不重不丢', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chief-group-notices-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const f = fixture({ root })
    const { job, dir } = await assigned(f)
    writeFileSync(join(dir, '计费表.md'), '# 计费表\n\n按 token 计费。\n')
    f.dsh.answer('researcher', '整理好了：[计费表](计费表.md)')
    const listed = await vi.waitFor(async () => {
      const data = (await notices(f)).data
      expect(data.items).toHaveLength(1)
      return data
    })
    const line = (await f.view(job.session)).data.messages.find(m => m.author === '研究员')!
    const notice = listed.items[0]!
    expect(notice).toMatchObject({ orderId: job.delegation.id, sessionId: job.session.id, workspaceId: job.workspace.id, messageId: line.id, title: '计费表',
      orderTitle: '方舟计费', kind: 'report', read: false, attachments: [{ id: line.attachments![0]!.id, label: '计费表', version: expect.stringMatching(/^[a-f0-9]{64}$/) }] })
    expect(line.id).toMatch(/^g-\d+$/)
    expect(listed.unread).toBe(1)
    const detail = (await f.call<{ notice: OrderResultNotice; text: string }>('/../notices/' + notice.id)).data
    expect(detail.text).toBe('整理好了：[计费表](计费表.md)')
    const file = () => f.call<{ attachment: { format: string; content: string } }>('/../notices/' + notice.id + '/attachments/' + notice.attachments[0]!.id)
    expect((await file()).data.attachment).toMatchObject({ format: 'markdown', content: expect.stringContaining('按 token 计费') })
    // The member edits the file later: the notice still opens the version it announced.
    writeFileSync(join(dir, '计费表.md'), '# 计费表\n\n改过了。\n')
    expect((await file()).data.attachment.content).toContain('按 token 计费')
    expect((await f.call<{ notice: OrderResultNotice }>('/../notices/' + notice.id + '/read', { requestId: f.id() })).data.notice.read).toBe(true)
    f.restart()
    await f.route().notices.collect()
    const after = (await notices(f)).data
    expect(after.items.map(row => [row.id, row.read])).toEqual([[notice.id, true]])
    expect(after.unread).toBe(0)
    expect((await file()).data.attachment.content).toContain('按 token 计费')
    // The kept copy gone and the file changed: the notice says the original is not readable any more.
    rmSync(join(f.host().paths(job.session).dir, 'results'), { recursive: true, force: true })
    expect((await file()).status).toBe(404)
  })

  it('明确的工单回报 / 阶段回报登记提醒，普通过程发言不登记；同一版文件再链接不算新交付；收单后标明工单已完成', async () => {
    const f = fixture()
    const { ws, job, dir } = await assigned(f)
    f.dsh.answer('researcher', '我先看一下官网的价目表。')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((await notices(f)).data.items).toEqual([])
    await f.say(job.session, '@研究员 先交一部分', { workOrderId: job.delegation.id })
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(2))
    f.dsh.answer('researcher', '阶段回报\n按量计费已经核实，包月还没查到。')
    await vi.waitFor(async () => expect((await notices(f)).data.items.map(row => row.kind)).toEqual(['partial']))
    writeFileSync(join(dir, '计费表.md'), '# 计费表\n')
    await f.say(job.session, '@研究员 交表', { workOrderId: job.delegation.id })
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(3))
    f.dsh.answer('researcher', '[计费表](计费表.md)')
    await vi.waitFor(async () => expect((await notices(f)).data.items).toHaveLength(2))
    await f.say(job.session, '@研究员 再发一次链接', { workOrderId: job.delegation.id })
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(4))
    f.dsh.answer('researcher', '还是这份：[计费表](计费表.md)')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((await notices(f)).data.items).toHaveLength(2)
    // The order's delivered files list that file once, at its latest link.
    const again = (await f.view(job.session)).data.messages.filter(m => m.author === '研究员' && m.attachments?.length).at(-1)!
    const outputs = (await f.call<{ outputs: WorkOrderOutput[] }>('/' + ws.id + '/orders/' + job.delegation.id + '/outputs')).data.outputs
    expect(outputs.map(row => [row.messageId, row.attachment.label])).toEqual([[again.id, '计费表']])
    // Lines of the general discussion (no order) and the owner's own words never become notices.
    await f.say(job.session, '工单回报\n这是我自己写的')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((await notices(f)).data.items).toHaveLength(2)
    await f.call('/' + ws.id + '/orders/' + job.delegation.id + '/action', { requestId: f.id(), action: 'complete' })
    expect((await notices(f)).data.items.every(row => row.orderDone)).toBe(true)
  })

  it('接口人派出的批次落地：成果提醒与待验收在同一次写入里登记', async () => {
    const f = fixture({ review: [{ verdict: 'pass', message: '表格齐了。', gaps: [] }] })
    const ws = await f.workspace()
    const job = f.route().assign('owner-v', '让大家整理计费表', undefined, ws.id, undefined, { title: '计费表', promise: '一份计费表' })
    await vi.waitFor(() => expect(f.dsh.count('liaison')).toBe(1))
    f.dsh.answer('liaison', '@工程师 整理一份计费表', false)
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    writeFileSync(join(f.host().workDir(job.session), '计费表.md'), '# 计费表\n')
    const writes = vi.spyOn(f.store(), 'publishGroupResults')
    f.codex.answer('engineer', '[计费表](计费表.md)')
    await vi.waitFor(() => expect(f.order(ws, job.delegation.id).acceptance?.verdict).toBe('pass'))
    const together = writes.mock.calls.findIndex(args => args[3].length === 1 && args[4]?.orderId === job.delegation.id)
    expect(together).toBeGreaterThanOrEqual(0)
    expect(writes.mock.results[together]!.value).toMatchObject({ state: 'pending', orderId: job.delegation.id })
    expect((await notices(f)).data.items).toMatchObject([{ orderId: job.delegation.id, title: '计费表' }])
  })
})

describe('工作区产物：各工单交付成果按文件合在一处', () => {
  const pause = () => new Promise(resolve => setTimeout(resolve, 5))
  const list = (f: ReturnType<typeof fixture>, ws: V2Workspace) => f.call<{ workspaceId: string; outputs: WorkspaceOutput[]; issue?: string }>('/' + ws.id + '/outputs')

  it('同一文件只列一次、带各工单标签、时间取最近；群里讨论与主人附件不算；不返回路径', async () => {
    const upload: ChatInputAttachment = {id: 'up', name: '主人的草稿.md', kind: 'file', bytes: 4}
    const f = fixture({turnLimit: 20, inputAttachments: {resolve: () => [upload], grant: vi.fn()}})
    const ws = await f.workspace()
    expect((await list(f, ws)).data).toMatchObject({workspaceId: ws.id, outputs: []})
    const first = f.route().assign('owner-o1', '让研究员整理方舟的计费规则', undefined, ws.id, undefined, { title: '方舟计费', promise: '一份计费表' }, 'researcher')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    const dir = f.host().workDir(first.session)
    for (const name of ['计费表', '价目', '杂记', '汇总']) writeFileSync(join(dir, name + '.md'), '# ' + name + '\n')
    f.dsh.answer('researcher', '整理好了：[计费表](计费表.md)')
    await pause()
    // The same order links the file again: still one output.
    await f.say(first.session, '@研究员 再发一次链接', { workOrderId: first.delegation.id })
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(2))
    f.dsh.answer('researcher', '还是这份：[计费表](计费表.md)')
    await pause()
    // A second order in the same group delivers that file again and one more.
    const second = f.route().assign('owner-o2', '顺便核对价目', undefined, ws.id, first.session.id, { title: '核对价目', promise: '价目与计费表' }, 'researcher')
    expect(second.session.id).toBe(first.session.id)
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(3))
    f.dsh.answer('researcher', '[计费表](计费表.md) 和 [价目](价目.md)')
    await pause()
    // The group's general discussion (no order) delivers nothing.
    await f.say(first.session, '@研究员 随手记一下')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(4))
    f.dsh.answer('researcher', '[杂记](杂记.md)')
    await pause()
    await f.say(first.session, '@工程师 出个汇总', { workOrderId: first.delegation.id })
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    f.codex.answer('engineer', '[汇总](汇总.md)')
    await pause()
    // Neither do the owner's own uploads.
    expect((await f.say(first.session, '材料给你', { workOrderId: first.delegation.id, inputAttachments: [upload.id] })).status).toBe(200)
    const data = await vi.waitFor(async () => {
      const read = (await list(f, ws)).data
      expect(read.outputs.map(row => row.label)).toEqual(['汇总', '计费表', '价目'])
      return read
    })
    const lines = (await f.view(first.session)).data.messages
    const researcher = lines.filter(m => m.author === '研究员' && m.attachments?.length)
    const engineer = lines.find(m => m.author === '工程师' && m.attachments?.length)!
    const [summary, sheet, prices] = data.outputs
    expect(sheet).toMatchObject({ sessionId: first.session.id, messageId: researcher[2]!.id, at: researcher[2]!.at, attachment: researcher[2]!.attachments![0],
      orders: [{ id: second.delegation.id, title: '核对价目' }, { id: first.delegation.id, title: '方舟计费' }],
      deliveredBy: [{ id: researcher[0]!.speakerId, name: '研究员' }] })
    expect(prices).toMatchObject({ messageId: researcher[2]!.id, orders: [{ id: second.delegation.id, title: '核对价目' }] })
    expect(summary).toMatchObject({ messageId: engineer.id, at: engineer.at, orders: [{ id: first.delegation.id, title: '方舟计费' }],
      deliveredBy: [{ id: engineer.speakerId, name: '工程师' }] })
    expect(data.outputs.every(row => /^[a-f0-9]{24}$/.test(row.key))).toBe(true)
    expect(new Set(data.outputs.map(row => row.key)).size).toBe(3)
    expect(data.issue).toBeUndefined()
    const body = JSON.stringify(data)
    expect(body).not.toContain(dir)
    expect(body).not.toMatch(/\.md|杂记|主人的草稿/)
    // The latest reference opens the same file as the order's 「交付成果」.
    const opened = await f.call<{ attachment: { content: string } }>('/' + ws.id + '/sessions/' + sheet!.sessionId + '/attachments/' + sheet!.attachment.id)
    expect(opened.data.attachment.content).toContain('# 计费表')
    const orderOutputs = (await f.call<{ outputs: WorkOrderOutput[] }>('/' + ws.id + '/orders/' + second.delegation.id + '/outputs')).data.outputs
    expect(orderOutputs.map(row => [row.messageId, row.attachment.id])).toContainEqual([sheet!.messageId, sheet!.attachment.id])
  })

  it('一场会话读不到时，其余产物照常列出并说明不全', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const job = f.route().assign('owner-o3', '让研究员整理方舟的计费规则', undefined, ws.id, undefined, { title: '方舟计费', promise: '一份计费表' }, 'researcher')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    writeFileSync(join(f.host().workDir(job.session), '计费表.md'), '# 计费表\n')
    f.dsh.answer('researcher', '[计费表](计费表.md)')
    const other = await f.group(ws)
    f.route().assign('owner-o4', '另一件事', undefined, ws.id, other.id, { title: '另一件事', promise: '说明' }, 'researcher')
    await vi.waitFor(async () => expect((await list(f, ws)).data.outputs.map(row => row.label)).toEqual(['计费表']))
    const engine = f.host().engine.bind(f.host())
    vi.spyOn(f.host(), 'engine').mockImplementation(session => session.id === other.id ? Promise.reject(new Error('账本损坏')) : engine(session))
    const read = (await list(f, ws)).data
    expect(read.outputs.map(row => row.label)).toEqual(['计费表'])
    expect(read.issue).toContain('暂时读不到')
  })

  it('已归档的工作区照常列出产物，群只读打开', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const job = f.route().assign('owner-o5', '让研究员整理方舟的计费规则', undefined, ws.id, undefined, { title: '方舟计费', promise: '一份计费表' }, 'researcher')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    writeFileSync(join(f.host().workDir(job.session), '计费表.md'), '# 计费表\n')
    f.dsh.answer('researcher', '[计费表](计费表.md)')
    await vi.waitFor(async () => expect((await list(f, ws)).data.outputs.map(row => row.label)).toEqual(['计费表']))
    const file = join(f.root, 'ops', 'superhub-v2', workspaceFingerprint(scope) + '.json')
    const board = JSON.parse(readFileSync(file, 'utf8'))
    board.workspaces.find((row: V2Workspace) => row.id === ws.id).archivedAt = '2026-11-24T08:00:00.000Z'
    writeFileSync(file, JSON.stringify(board))
    f.restart()
    const read = await list(f, ws)
    expect(read).toMatchObject({ status: 200, data: { outputs: [{ label: '计费表', orders: [{ id: job.delegation.id }] }] } })
    expect(read.data.issue).toBeUndefined()
    expect((await f.host().engine(job.session)).readOnly).toBe(true)
  })
})

describe('额度、暂停、叫停、档位与审批', () => {
  it('额度用完：这一次不叫，群里记没能答完，并提醒主人', async () => {
    const f = fixture({ turnLimit: 1 })
    const ws = await f.workspace()
    const job = f.route().assign('owner-b', '让研究员查计费', undefined, ws.id, undefined, { title: '查计费', promise: '计费规则' }, 'researcher')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    expect(f.order(ws, job.delegation.id).remainingTurns).toBe(0)
    f.dsh.answer('researcher', '我去问问工程师 @工程师 看下控制台', false)
    await vi.waitFor(async () => expect((await f.view(job.session)).data.messages.at(-1)?.text).toMatch(/工程师 没能答完：这张工单的对话额度已用完/))
    expect(f.codex.count('engineer')).toBe(0)
    expect(f.reminders.map(row => row.key)).toEqual([expect.stringMatching(new RegExp('^workspace-stalled:' + job.delegation.id))])
  })

  it('暂停工单：为它在跑的成员回合叫停，群里留一行；别的工作照常', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const job = f.route().assign('owner-c', '让研究员查计费', undefined, ws.id, undefined, { title: '查计费', promise: '计费规则' }, 'researcher')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    const other = f.route().assign('owner-c2', '让工程师跑评测', undefined, ws.id, job.session.id, { title: '跑评测', promise: '评测结果' }, 'engineer')
    expect(other.session.id).toBe(job.session.id)
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    const paused = await f.call<{ order: V2Delegation }>('/' + ws.id + '/orders/' + job.delegation.id + '/action', { requestId: f.id(), action: 'pause' })
    expect(paused.data.order.paused).toBe(true)
    expect(f.dsh.cancelled).toEqual([f.dsh.last('researcher').call.callId])
    expect(f.codex.cancelled).toEqual([])
    expect((await f.view(job.session)).data.messages.at(-1)).toMatchObject({ kind: 'event', event: 'stopped', text: '这张工单已暂停，为它进行的工作已叫停。' })
  })

  it('叫停一位成员或全部（POST …/stop）', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    await f.say(session, '@工程师 @研究员 各自查一下')
    await vi.waitFor(() => expect(f.codex.count('engineer') + f.dsh.count('researcher')).toBe(2))
    const path = '/' + ws.id + '/sessions/' + session.id + '/stop'
    expect((await f.call(path, { requestId: f.id(), memberId: 'nobody' })).status).toBe(400)
    const one = await f.call<{ stopped: boolean; group: { members: GroupMemberState[] } }>(path, { requestId: f.id(), memberId: 'engineer' })
    expect(one.data.stopped).toBe(true)
    expect(f.codex.cancelled).toHaveLength(1)
    expect(one.data.group.members.find(m => m.id === 'researcher')!.status).toBe('speaking')
    const all = await f.call<{ stopped: boolean }>(path, { requestId: f.id() })
    expect(all.data.stopped).toBe(true)
    expect(f.dsh.cancelled).toHaveLength(1)
    expect((await f.call<{ stopped: boolean }>(path, { requestId: f.id() })).data.stopped).toBe(false)
  })

  it('群聊的工单可以设命令档位；本群审批卡（含 DSH 成员）出现在会话视图、执行记录与「等你决定」，可按群答复', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const job = f.route().assign('owner-d', '让研究员清理临时文件', undefined, ws.id, undefined, { title: '清理', promise: '删掉临时文件' }, 'researcher')
    const tier = await f.call<{ permission: string }>('/' + ws.id + '/orders/' + job.delegation.id + '/permission', { requestId: f.id(), permission: 'ask' })
    expect(tier.status).toBe(200)
    expect(tier.data.permission).toBe('ask')
    f.pending.push({ id: 'a-1', workspaceId: ws.id, sessionId: job.session.id, workOrderId: job.delegation.id, turnId: 'c1.1', tool: 'dsh', memberId: 'researcher',
      command: 'rm -rf tmp', cwd: '/tmp', reason: '删除文件', requestedAt: '2026-11-24T00:00:00.000Z', expiresAt: '2026-11-24T00:30:00.000Z' })
    expect((await f.view(job.session)).data.group.approvals.map(row => [row.id, row.tool, row.memberId])).toEqual([['a-1', 'dsh', 'researcher']])
    const execution = (await f.call<{ pending: V2PendingApproval[]; permissions: unknown[] }>('/' + ws.id + '/orders/' + job.delegation.id + '/execution')).data
    expect(execution.pending.map(row => row.id)).toEqual(['a-1'])
    expect(execution.permissions).toEqual([expect.objectContaining({ from: 'full-access', to: 'ask' })])
    const all = (await f.call<{ approvals: (V2PendingApproval & { memberName?: string })[] }>('/../approvals')).data
    expect(all.approvals).toEqual([expect.objectContaining({ id: 'a-1', memberName: '研究员', sessionTitle: job.session.title, orderTitle: '清理' })])
    const decided = await f.call('/' + ws.id + '/sessions/' + job.session.id + '/approvals/a-1', { requestId: f.id(), allow: true })
    expect(decided.status).toBe(200)
    expect(f.answered.at(-1)).toMatchObject({ id: 'a-1', allow: true, where: { workspaceId: ws.id, sessionId: job.session.id } })
  })

  it('群里不属于工单的命令按成员记在会话的执行记录里', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    const commands = join(f.host().paths(session).dir, 'commands.jsonl')
    appendCommandLog(commands, { kind: 'gate', id: 'g-1', turnId: 'c1.1', workOrderId: null, at: '2026-11-24T00:00:00.000Z', tool: 'bash', command: 'arkcli --version', cwd: '/tmp',
      risk: 'normal', tier: 'full-access', decision: 'auto', by: 'policy', reason: '普通命令', memberId: 'researcher', memberName: '研究员' })
    appendCommandLog(commands, { kind: 'command', id: 'x-1', itemId: 'i1', turnId: 'c2.1', workOrderId: null, at: '2026-11-24T00:01:00.000Z', tool: 'shell', command: 'ls', cwd: '/tmp',
      endedAt: '2026-11-24T00:01:01.000Z', exitCode: 0, memberId: 'engineer', memberName: '工程师' })
    const record = (await f.call<{ commands: { memberId?: string; memberName?: string; command: string }[]; sessionId: string }>('/' + ws.id + '/sessions/' + session.id + '/execution')).data
    expect(record.sessionId).toBe(session.id)
    expect(record.commands.map(row => [row.command, row.memberId, row.memberName])).toEqual([['arkcli --version', 'researcher', '研究员'], ['ls', 'engineer', '工程师']])
  })
})

describe('重启', () => {
  it('有成员在跑的群在宿主启动时就续上；没发出去的交办补发一次', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chief-group-restart-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const f = fixture({ root })
    const ws = await f.workspace()
    const session = await f.group(ws)
    await f.say(session, '@研究员 查计费')
    await vi.waitFor(() => expect(f.dsh.count('researcher')).toBe(1))
    const running = f.dsh.last('researcher').call.callId
    f.restart()
    // The new host booted the group by itself and asked the runner about the running call.
    await vi.waitFor(() => expect(f.dsh.reattached).toEqual([running]))
    expect(f.host().loaded(session.id)).toBeDefined()
  })
})

describe('群聊占着项目目录（与编程回合同一把锁）', () => {
  const group = (workDir: string, groupId = 'g1'): GroupContext => ({ scope: 's', workspaceId: 'w', groupId, workspaceName: 'w', title: '群' + groupId, workDir,
    sessions: new GroupMemberSessions(mkdtempSync(join(tmpdir(), 'chief-group-lock-'))), commandsPath: '/dev/null' })
  const callOf = (callId: string, g: GroupContext): MemberCall => ({ callId, group: g, member: { id: 'm', name: 'm', kind: 'dsh' }, identity: '', prompt: '' })
  const sink = (log: string[]): MemberCallSink => ({ stepped() {}, tool() {}, touched() {}, approval() {}, finished: id => log.push('finished ' + id) })

  it('成员之间不互相排队；编程回合等群里最后一个成员做完；群等编程回合', async () => {
    const locks = new DirectoryLocks()
    const placed = new GroupDirectoryLocks(locks, g => g.workDir === '/superhub' ? undefined : 'dir:' + g.workDir)
    const inner = new FakeRunner()
    const runner = placed.wrap(inner)
    const g = group('/repo')
    const log: string[] = []
    await runner.run(callOf('c1', g), sink(log))
    await runner.run(callOf('c2', g), sink(log))
    expect(inner.calls).toHaveLength(2)
    expect(locks.holder('dir:/repo')).toMatchObject({ sessionId: 'g1', title: '群聊「群g1」' })
    expect(locks.take('dir:/repo/sub', { sessionId: 'coding', requestId: 't1', title: '编程' })).toBe(false)
    inner.sinks.get('c1')!.finished('c1', { text: '', status: 'completed', toolCalls: 0 })
    expect(locks.busy('dir:/repo')).toBe(true)
    inner.sinks.get('c2')!.finished('c2', { text: '', status: 'completed', toolCalls: 0 })
    expect(locks.busy('dir:/repo')).toBe(false)
    expect(log).toEqual(['finished c1', 'finished c2'])

    expect(locks.take('dir:/repo', { sessionId: 'coding', requestId: 't2', title: '编程' })).toBe(true)
    const waiting = runner.run(callOf('c3', g), sink(log))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(inner.calls).toHaveLength(2)
    locks.release('dir:/repo', 't2')
    await waiting
    expect(inner.calls).toHaveLength(3)
    // SuperHub's own directory is the group's alone: no lock.
    await runner.run(callOf('c4', group('/superhub', 'g2')), sink(log))
    expect(locks.holder('dir:/superhub')).toBeUndefined()
    // A cancelled waiter stops waiting.
    expect(locks.take('dir:/other', { sessionId: 'coding', requestId: 't3', title: '编程' })).toBe(true)
    const stuck = runner.run(callOf('c5', group('/other', 'g3')), sink(log))
    runner.cancel('c5')
    await expect(stuck).rejects.toThrow('已叫停')
    placed.dispose()
    expect(locks.busy('dir:/repo')).toBe(false)
  })
})

describe('续上的成员回合也占着目录', () => {
  it('补读时就结束的回合不会一直占着锁；没续上的立即放开', async () => {
    const locks = new DirectoryLocks()
    const placed = new GroupDirectoryLocks(locks, g => 'dir:' + g.workDir)
    const sessions = new GroupMemberSessions(mkdtempSync(join(tmpdir(), 'chief-group-lock-')))
    const g: GroupContext = { scope: 's', workspaceId: 'w', groupId: 'g', workspaceName: 'w', title: 't', workDir: '/repo', sessions, commandsPath: '/dev/null' }
    const sink: MemberCallSink = { stepped() {}, tool() {}, touched() {}, approval() {}, finished() {} }
    const ended = placed.wrap({ ...new FakeRunner(), run: async () => {}, continue: async () => {}, cancel() {}, dispose() {},
      reattach: async (_call, s) => { s.finished('c1', { text: 'done', status: 'completed', toolCalls: 1 }); return true } })
    await expect(ended.reattach({ callId: 'c1', group: g, member: { id: 'm', name: 'm', kind: 'dsh' }, identity: '' }, sink)).resolves.toBe(true)
    expect(locks.busy('dir:/repo')).toBe(false)
    const gone = placed.wrap(new FakeRunner())
    await expect(gone.reattach({ callId: 'c2', group: g, member: { id: 'm', name: 'm', kind: 'dsh' }, identity: '' }, sink)).resolves.toBe(false)
    expect(locks.busy('dir:/repo')).toBe(false)
    placed.dispose()
  })
})

describe('工作区共同经验入口', () => {
  it('列表、写入回执和历史只返回共同经验，幕僚专属仍可在幕僚入口查看', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const path = '/' + ws.id + '/staff'
    const shared = path + '?experience=shared'
    const privateText = '只交给工程师的核对方法'
    const commonText = '工作区共同核对方法'
    const personal = await f.call<StaffView>(path, {requestId:f.id(), action:'learn', staffId:'engineer', text:privateText})
    const privateId = personal.data.memories[0]!.id
    await f.call(path, {requestId:f.id(), action:'revise', staffId:'engineer', memoryId:privateId, text:'他的新版'})
    const common = await f.call<StaffView>(shared, {requestId:f.id(), action:'learn', audience:'shared', text:commonText})
    expect(common).toMatchObject({status:200, data:{members:[], available:[], memories:[], received:[],
      sharedExperiences:[{text:commonText, audience:'shared'}]}})
    const commonId = common.data.sharedExperiences![0]!.id
    const listed = await f.call<StaffView>(shared)
    expect(listed.data).toEqual(common.data)
    expect(JSON.stringify(listed.data)).not.toContain(privateId)
    const history = (id: string) => `&memory=${id}&version=1`
    expect(await f.call(shared + history(privateId))).toMatchObject({status:404})
    expect(await f.call(path + '?' + history(privateId).slice(1))).toMatchObject({status:200, data:{memory:{text:privateText}}})
    expect(await f.call(shared + history(commonId))).toMatchObject({status:200, data:{memory:{text:commonText}}})
    expect(await f.call(shared, {requestId:f.id(), action:'retire', staffId:'engineer', memoryId:privateId})).toMatchObject({status:400})
    expect(await f.call<StaffView>(path)).toMatchObject({status:200, data:{memories:[{id:privateId, text:'他的新版', status:'active'}]}})
  })
})

describe('归档的工作区：群不再干活', () => {
  const archive = (f: ReturnType<typeof fixture>, ws: V2Workspace) => f.call<{ workspace: V2Workspace; error: string }>('/' + ws.id + '/archive', { requestId: f.id() })

  it('有成员在干活时拒绝归档；叫停后可归档，之后群停掉、幕僚改动与成员被叫都被拒绝', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    await f.say(session, '@工程师 查一下端点')
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    expect(await archive(f, ws)).toMatchObject({ status: 409, data: { error: '有回合正在运行，请等它结束或叫停后再归档' } })
    expect((await f.call('/' + ws.id + '/sessions/' + session.id + '/stop', { requestId: f.id() })).status).toBe(200)
    await vi.waitFor(async () => expect((await f.view(session)).data.group.members.every(m => m.status === 'idle')).toBe(true))
    expect((await archive(f, ws)).status).toBe(200)
    expect(f.host().loaded(session.id)).toBeUndefined()
    // Staff of an archived workspace take no changes, through the route and the store.
    expect(await f.call('/' + ws.id + '/staff', { requestId: f.id(), action: 'leave', staffId: 'researcher' })).toMatchObject({ status: 409, data: { error: WORKSPACE_ARCHIVED } })
    const guarded = new WorkspaceStaffStore(f.root, scope, () => NATIVE, id => f.store().workspace(id), undefined, id => workspaceArchived(f.store().workspace(id)))
    expect(() => guarded.apply(ws.id, { action: 'join', staffId: 'engineer', duty: '再加一份职责', requestId: f.id() })).toThrow(WORKSPACE_ARCHIVED)
    expect(guarded.view(ws.id).members.map(m => m.id)).toEqual(['engineer', 'researcher'])
    // Reading the group opens its engine read-only: nothing it holds is changed, and nobody can be called through it.
    expect((await f.view(session)).status).toBe(200)
    const engine = await f.host().engine(session)
    expect(engine.readOnly).toBe(true)
    const lines = engine.ledger.lastSeq
    expect(() => engine.say('@工程师 再查一遍')).toThrow(WORKSPACE_ARCHIVED)
    expect(() => engine.note({ speaker: 'liaison', text: '记一笔' })).toThrow(WORKSPACE_ARCHIVED)
    expect(engine.ledger.lastSeq).toBe(lines)
    expect(f.codex.count('engineer')).toBe(1)
  })

  it('打开已归档工作区的群只读：不续跑、不存盘、不记失败；恢复后照常开工', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    await f.say(session, '@工程师 查一下端点')
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    f.codex.answer('engineer', '查完了')
    await vi.waitFor(async () => expect((await f.view(session)).data.group.members.every(m => m.status === 'idle')).toBe(true))
    expect((await archive(f, ws)).status).toBe(200)
    f.restart()
    const dir = f.host().paths(session).dir
    const board = join(f.root, 'ops', 'superhub-v2', workspaceFingerprint(scope) + '.json')
    const snapshot = () => [readFileSync(board, 'utf8'), ...readdirSync(dir).sort().map(name => name + ':' + statSync(join(dir, name)).mtimeMs + ':' + readFileSync(join(dir, name), 'utf8'))]
    const before = snapshot()
    const read = await f.view(session)
    expect(read).toMatchObject({ status: 200, data: { messages: [{ text: '@工程师 查一下端点' }, { text: '查完了' }] } })
    expect(read.data.group.members.map(m => m.status)).toEqual(['idle', 'idle', 'idle'])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(snapshot()).toEqual(before)
    // Restored: the next use starts the group as usual (no restart line, no failure), and the owner's words call the member.
    expect((await f.call('/' + ws.id + '/restore', { requestId: f.id() })).status).toBe(200)
    expect((await f.say(session, '@工程师 再查一遍')).status).toBe(200)
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(2))
    expect((await f.host().engine(session)).readOnly).toBe(false)
    expect((await f.view(session)).data.messages.filter(m => m.kind === 'event')).toEqual([])
  })

  it('重启后已归档工作区的群不被唤醒、不续跑；恢复后照常', async () => {
    const f = fixture()
    const ws = await f.workspace()
    const session = await f.group(ws)
    await f.say(session, '@工程师 查一下端点')
    await vi.waitFor(() => expect(f.codex.count('engineer')).toBe(1))
    f.codex.alive.add(f.codex.last('engineer').call.callId)
    // Archived while the call was in flight (written straight to the board): boot leaves the group alone.
    const file = join(f.root, 'ops', 'superhub-v2', workspaceFingerprint(scope) + '.json')
    const board = JSON.parse(readFileSync(file, 'utf8'))
    board.workspaces.find((row: V2Workspace) => row.id === ws.id).archivedAt = '2026-11-24T08:00:00.000Z'
    writeFileSync(file, JSON.stringify(board))
    f.restart()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.codex.reattached).toEqual([])
    expect(f.host().loaded(session.id)).toBeUndefined()
    expect((await f.call('/' + ws.id + '/restore', { requestId: f.id() })).status).toBe(200)
    f.restart()
    await vi.waitFor(() => expect(f.codex.reattached).toHaveLength(1))
  })
})
