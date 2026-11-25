import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatInputAttachment } from '../src/core/chat-attachments.ts'
import { Engine, type Brain } from '../src/core/engine.ts'
import { threadIdOf, type Staff } from '../src/core/model.ts'
import { FileStore } from '../src/core/store.ts'
import { LiaisonChat } from '../src/dsh/chat.ts'
import { Discussions } from '../src/dsh/discussions.ts'
import { runtimeRoutes, serveApi, type Route } from '../src/dsh/http.ts'
import { cleanupLegacyOrders } from '../src/dsh/legacy-order-cleanup.ts'
import type { HostContext, SessionEventLike, Tools } from '../src/dsh/ports.ts'
import { nativeAttachmentOnlyTurn, nativeIntakeSource, SuperhubIntake, type LiaisonRequest } from '../src/dsh/superhub.ts'
import { workspaceScope } from '../src/dsh/workspace-v2-store.ts'
import { ownerTarget, type OwnerTargetDetail } from '../src/client/ticket-target.ts'
import { registerTools } from '../src/dsh/tools.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

const role = (id: string): Staff => ({ id, name: id, executor: 'dsh', verifier: 'none', brief: '本地执行' })
const staff = ['researcher', 'strategist', 'ui-smith'].map(role)
const scope = 'brain-one'
const navigation = { id: 'discussion-navigation', version: 1 }

function fixture(installation?: string, brainScope = scope, brainName = brainScope) {
  const directory = installation ?? mkdtempSync(join(tmpdir(), 'chief-superhub-intake-'))
  if (!installation) cleanup.push(() => rmSync(directory, { force: true, recursive: true }))
  const root = join(directory, brainName)
  const chiefHome = join(directory, 'installation')
  const workspace = join(directory, 'source-checkout')
  const store = new FileStore(root)
  const run = vi.fn(async () => ({ text: '', stopReason: 'completed' as const }))
  let intake: SuperhubIntake
  const brain: Brain = {
    root, constitution: () => '', staff: () => staff, workspaces: () => [workspace], rules: () => [],
    workdir: id => join(root, 'work', id), appendNote: path => path, commit: () => {},
  }
  const engine = new Engine(store, brain, { available: () => true, supportsSchema: () => true, run }, { dispatch() {}, cancel() {} }, {
    concurrency: 1, timeZone: 'UTC', brainScope, canStartSuperhub: authorization => intake.allowsCommand(authorization),
  })
  engine.setPaused(true)
  cleanup.push(() => engine.stop())
  intake = new SuperhubIntake({ root, chiefHome, brainScope, engine, staff: () => staff,
    hasGoal: id => ['goal-one', 'goal-two'].includes(id), uiWorkspace: workspace })
  return { intake, engine, store, run, directory, root, chiefHome }
}

const input = (requestId: string, text: string) => ({ scope, requestId, text })
const userEvent = (text: string, rpcId?: string): SessionEventLike => ({ type: 'user/message', seq: 2, time: 1,
  data: { id: 'native-message', source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] } })

async function request(route: Route, method: 'GET' | 'POST', path: string, body?: object, owner = true) {
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method, url: `/chief/api${path}`, headers: { 'x-chief-request': '1' },
  }) as unknown as IncomingMessage
  let code = 0
  let result: unknown
  const res = {
    writeHead: (status: number) => { code = status },
    end: (value: string) => { result = JSON.parse(value) },
  } as unknown as ServerResponse
  await serveApi(req, res, 'dsh', [route], owner)
  return { code, result }
}

describe('SuperHub structured intake', () => {
  // A deterministic stand-in for the liaison: the structured understanding a model would submit.
  const understood = (requestId: string, text: string, fields: Partial<LiaisonRequest> = {}): LiaisonRequest =>
    ({ source: { requestId, messageId: `message-${requestId}`, text }, sessionId: 'hq', brief: text, operation: 'read', ...fields })

  it('records the complete original without interpreting it and links what the liaison registered', async () => {
    const f = fixture()
    const text = '  记一下今天聊到的目标地图，另外让研究员分别比较一下两种协作机制；不要改代码  '
    const original = { ...input('source-one', text), goalIds: ['goal-two', 'goal-one'] }
    const receipt = await f.intake.submit(original)
    expect(receipt.source).toMatchObject({ text, channel: 'owner' })
    expect(receipt.items).toEqual([expect.objectContaining({ intent: 'conversation', state: 'conversation', restrictions: [], goalIds: ['goal-two', 'goal-one'],
      span: { start: 0, end: text.length }, reason: expect.stringContaining('还没交给接口人') })])
    expect(f.store.tickets()).toEqual([])
    expect(readdirSync(f.root)).toEqual(['ops'])
    expect(readFileSync(join(f.chiefHome, 'superhub', readdirSync(join(f.chiefHome, 'superhub'))[0]!, 'intake.json'), 'utf8')).toContain(JSON.stringify(text))
    // The liaison understood two things: a memo and a read task with the owner's own limit. 「分别」 never becomes a prohibition.
    const memo = await f.intake.fromLiaison(understood('source-one', text, { brief: '今天聊到的目标地图', intent: 'memo' }))
    const work = await f.intake.fromLiaison(understood('source-one', text, { brief: '比较两种协作机制，交付对比结论', staff: 'researcher', restrictions: ['不要改代码'] }))
    expect(memo.items[0]).toMatchObject({ intent: 'memo', state: 'recorded', goalIds: ['goal-two', 'goal-one'] })
    expect(memo.items[0]).not.toHaveProperty('ticketId')
    expect(work.items[0]).toMatchObject({ intent: 'execute', state: 'dispatched', ticketId: 'T-0001', restrictions: ['不要改代码'], goalDisposition: 'associated' })
    expect(work.authorization).toMatchObject({ chatReceiptId: receipt.id, ownerText: text, operation: 'read', restrictions: ['不要改代码'] })
    expect(f.store.tickets()[0]?.superhub?.contracts[0]?.denied).toEqual(['不要改代码', '修改配置、代码或数据', '部署或对外发送'])
    const view = f.intake.view(receipt.id)
    expect(view.liaisonReceipts).toEqual([memo.id, work.id])
    expect(view.linked?.map(row => row.id)).toEqual([memo.id, work.id])
    expect(view.version).toBe(3)
    // Goal links count the registered items, not the shadowed original conversation.
    expect(f.intake.receiptsForGoal('goal-two').map(row => row.id)).toEqual([memo.id, work.id])
    const restarted = fixture(f.directory)
    expect(await restarted.intake.submit(original)).toEqual(f.intake.get(receipt.id))
    expect(await restarted.intake.fromLiaison(understood('source-one', text, { brief: '比较两种协作机制，交付对比结论', staff: 'researcher', restrictions: ['不要改代码'] }))).toMatchObject({ id: work.id })
    expect(restarted.intake.get(receipt.id).liaisonReceipts).toEqual([memo.id, work.id])
    await expect(restarted.intake.submit({ ...original, text: `${text} changed` })).rejects.toMatchObject({ status: 409 })
    expect(restarted.store.tickets()).toHaveLength(1)
  })

  it('keeps the owner explicit SuperHub choices authoritative over the liaison understanding', async () => {
    const f = fixture()
    const receipt = await f.intake.submit({ ...input('chosen', '整理一下归档目录'), operation: 'read', staff: 'strategist' })
    expect(receipt.ownerChoices).toEqual({ operation: 'read', staff: 'strategist' })
    const work = await f.intake.fromLiaison(understood('chosen', '整理一下归档目录', { brief: '整理归档目录并提交修改', operation: 'write', staff: 'researcher' }))
    expect(work.items[0]).toMatchObject({ state: 'dispatched', operation: 'read' })
    expect(work.history[0]?.item.reason).toContain('按主人在 SuperHub 的指定：只读、负责人 strategist')
    expect(work.authorization).toMatchObject({ operation: 'read', staff: 'strategist', ownerChoices: { operation: 'read', staff: 'strategist' } })
    expect(f.store.tickets()[0]).toMatchObject({ staff: 'strategist', mandate: { level: 'think' } })
    await expect(f.intake.submit({ ...input('bad-choice', '整理'), operation: 'delete' })).rejects.toMatchObject({ status: 400 })
    await expect(f.intake.submit({ ...input('bad-staff', '整理'), staff: 'nobody' })).rejects.toMatchObject({ status: 409 })
    await expect(f.intake.submit({ ...input('stale-feature', '整理'), feature: { ...navigation, version: 9 } })).rejects.toMatchObject({ status: 409 })
    // An owner-chosen read-only operation cannot be turned into a UI source change by the liaison.
    await f.intake.submit({ ...input('chosen-read-ui', '看看讨论列表为什么乱'), operation: 'read' })
    const before = f.intake.receipts().length
    await expect(f.intake.fromLiaison(understood('chosen-read-ui', '看看讨论列表为什么乱', { ui: { feature: { id: navigation.id }, basis: '主人说讨论列表' } })))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('只读') })
    expect(f.intake.receipts()).toHaveLength(before)
    expect(f.store.tickets()).toHaveLength(1)
  })

  it('accepts a model-selected catalog feature for a UI change and validates only the identity and version', async () => {
    const f = fixture()
    const said = '把讨论列表那块改清爽一点'
    await expect(f.intake.fromLiaison(understood('ui-unknown', said, { ui: { feature: { id: 'sidebar-left' }, basis: '主人说讨论列表' } }))).rejects.toMatchObject({ status: 400 })
    await expect(f.intake.fromLiaison(understood('ui-stale', said, { ui: { feature: { ...navigation, version: 2 }, basis: '主人说讨论列表' } }))).rejects.toMatchObject({ status: 409 })
    await expect(f.intake.fromLiaison(understood('ui-basis', said, { ui: { feature: navigation, basis: ' ' } }))).rejects.toMatchObject({ status: 400 })
    expect(f.intake.receipts()).toEqual([])
    const created = await f.intake.fromLiaison(understood('ui-change', said, { brief: '精简讨论列表的视觉层级', operation: undefined, ui: { feature: { id: navigation.id }, basis: '主人原话「讨论列表那块」' } }))
    expect(created.items[0]).toMatchObject({ state: 'dispatched', ticketId: 'T-0001', operation: 'write', staffHint: 'ui-smith',
      feature: { ...navigation, title: '讨论列表', basis: '主人原话「讨论列表那块」' } })
    expect(created.authorization?.feature).toMatchObject({ id: navigation.id, version: 1 })
    expect(f.store.tickets()[0]).toMatchObject({ staff: 'ui-smith', mandate: { level: 'write', needsReview: true, scope: expect.stringContaining(`主人原话：「${said}」`) },
      superhub: { approvalRequired: true } })
    expect(f.store.recentEvents(1)[0]?.text).toBe(said)
  })

  it('keeps a liaison UI source change in owner approval with zero execution until the owner approves it', async () => {
    const f = fixture()
    const said = '把讨论列表那块改清爽一点'
    await f.intake.fromLiaison(understood('ui-approve', said, { brief: '精简讨论列表的视觉层级', operation: undefined, ui: { feature: { id: navigation.id }, basis: '主人原话「讨论列表那块」' } }))
    expect(f.engine.views()[0]).toMatchObject({ stage: 'you/approve', ticket: { staff: 'ui-smith', mandate: { level: 'write' }, superhub: { approvalRequired: true } } })
    // The engine runs freely, but nothing starts before approval: the plugin source workspace stays untouched.
    f.engine.setPaused(false)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(f.run).not.toHaveBeenCalled()
    expect(f.engine.views()[0]!.stage).toBe('you/approve')
    // Approval binds the current scope and contract version (the owner's ticket view); a bare approve is refused.
    await expect(f.engine.approve('T-0001')).rejects.toMatchObject({ status: 409 })
    expect(f.run).not.toHaveBeenCalled()
    const ticket = f.store.ticket('T-0001')!
    await f.engine.approve('T-0001', { threadId: threadIdOf(ticket), replyTo: null, stage: 'you/approve', brainScope: scope, contractVersion: 1 })
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1))
    expect(f.store.ticket('T-0001')!.approvedAt).toBeTruthy()
    // A revised contract needs a renewed approval, as for proposal tickets.
    await vi.waitFor(() => expect(f.engine.views()[0]!.stage).toBe('you/blocked'))
    const blocked = f.engine.views()[0]!.ticket
    await f.engine.reviseContract('T-0001', blocked.superhub!.contracts[0]!.criteria.map((row, index) => index ? row : { ...row, text: `${row.text}（只调整讨论列表的间距）` }), '主人缩小范围', {
      threadId: threadIdOf(blocked), replyTo: blocked.assignments.at(-1)!.id, stage: 'you/blocked', brainScope: scope, contractVersion: 1 })
    expect(f.engine.views()[0]!.stage).toBe('you/approve')
  })

  it('does not treat the owner SuperHub choice of write and feature as approval of a UI source change', async () => {
    const f = fixture()
    const receipt = await f.intake.submit({ ...input('chosen-ui', '把讨论列表改清爽'), operation: 'write', staff: 'ui-smith', feature: navigation })
    expect(receipt.ownerChoices).toEqual({ operation: 'write', staff: 'ui-smith', feature: navigation })
    const work = await f.intake.fromLiaison(understood('chosen-ui', '把讨论列表改清爽', { brief: '精简讨论列表', ui: { feature: { id: 'ticket-detail' }, basis: '主人说列表' } }))
    expect(work.items[0]).toMatchObject({ state: 'dispatched', feature: { id: navigation.id } })
    expect(f.engine.views()[0]).toMatchObject({ stage: 'you/approve', ticket: { staff: 'ui-smith', superhub: { approvalRequired: true } } })
  })

  it('lets the owner confirm a feature for an item that waits for clarification', async () => {
    const f = fixture()
    // The owner picked a non-UI staff member for a UI change: the item waits for the owner instead of guessing.
    await f.intake.submit({ ...input('ui-owner', '调整工单详情的排版'), staff: 'researcher' })
    const receipt = await f.intake.fromLiaison(understood('ui-owner', '调整工单详情的排版', { ui: { feature: { id: 'ticket-detail' }, basis: '主人说工单详情' } }))
    const item = receipt.items[0]!
    expect(item).toMatchObject({ state: 'clarify', question: expect.stringContaining('界面师') })
    const stale = await f.intake.edit(receipt.id, {
      scope, requestId: 'old-anchor', expectedVersion: receipt.version, itemId: item.id, action: 'clarify', feature: { ...navigation, version: 99 },
    })
    expect(stale.items[0]).toMatchObject({ state: 'clarify', candidates: [navigation] })
    const clarification = {
      scope, requestId: 'clarified-anchor', expectedVersion: stale.version, itemId: item.id, action: 'clarify', feature: navigation, staff: 'ui-smith',
    }
    const created = await f.intake.edit(receipt.id, clarification)
    expect(created.items[0]).toMatchObject({ state: 'dispatched', ticketId: 'T-0001', feature: { ...navigation, basis: '主人确认的功能版本' } })
    expect(f.store.tickets()[0]).toMatchObject({ staff: 'ui-smith', mandate: { level: 'write', needsReview: true }, superhub: { approvalRequired: true } })
    // Choosing the feature and the UI smith in SuperHub registers the work; it does not approve it.
    expect(f.engine.views()[0]!.stage).toBe('you/approve')
    expect(await f.intake.edit(receipt.id, clarification)).toEqual(created)
    await expect(f.intake.edit(receipt.id, { ...clarification, requestId: 'stale-version' })).rejects.toMatchObject({ status: 409 })
    expect(created.history.some(row => row.item.candidates?.length === 1)).toBe(true)
  })

  it('hands supplementary owner words to the liaison instead of interpreting them', async () => {
    const f = fixture()
    const liaison = vi.fn(async (_text: string, _requestId: string) => {})
    const intake = new SuperhubIntake({ root: f.root, chiefHome: f.chiefHome, brainScope: scope, engine: f.engine, staff: () => staff, liaison })
    await intake.submit({ ...input('ui-wait', '调整工单详情'), staff: 'researcher' })
    const receipt = await intake.fromLiaison(understood('ui-wait', '调整工单详情', { ui: { feature: { id: 'ticket-detail' }, basis: '主人说工单详情' } }))
    const item = receipt.items[0]!
    expect(item.state).toBe('clarify')
    const answered = await request(intake.route, 'POST', `/superhub/items/${receipt.id}`, {
      scope, requestId: 'supplement', expectedVersion: receipt.version, itemId: item.id, action: 'clarify', text: '只改字号，别动布局' })
    expect(answered.code).toBe(200)
    expect(answered.result).toMatchObject({ items: [{ state: 'conversation', correction: { text: '只改字号，别动布局' }, reason: expect.stringContaining('交给接口人重新理解') }] })
    expect(liaison).toHaveBeenCalledWith(`补充交办「${item.title}」：只改字号，别动布局`, 'supplement')
    expect(f.store.tickets()).toEqual([])
    // The liaison's understanding of the supplement links back to the same receipt.
    const followed = await intake.fromLiaison(understood('supplement', `补充交办「${item.title}」：只改字号，别动布局`, { brief: '只调整工单详情的字号', restrictions: ['别动布局'] }))
    expect(followed.authorization?.chatReceiptId).toBe(receipt.id)
    expect(intake.view(receipt.id).linked?.map(row => row.id)).toEqual([followed.id])
  })

  it('freezes the old command before stopping work and preserves goal association', async () => {
    const f = fixture()
    await f.intake.submit({ ...input('research', '请研究把周报归档的方式'), goalIds: ['goal-one'] })
    const created = await f.intake.fromLiaison(understood('research', '请研究把周报归档的方式'))
    const [item] = created.items
    const prior = f.store.tickets()[0]!
    let frozen = false
    const stop = f.engine.stopTicket.bind(f.engine)
    vi.spyOn(f.engine, 'stopTicket').mockImplementation((...args) => {
      frozen = !f.intake.allowsCommand(prior.superhub!)
      return stop(...args)
    })
    const stopped = await f.intake.edit(created.id, {
      scope, requestId: 'correct', expectedVersion: created.version, itemId: item!.id, action: 'record',
    })
    expect(frozen).toBe(true)
    expect(stopped.items[0]).toMatchObject({ intent: 'memo', state: 'recorded', goalIds: ['goal-one'], stop: { state: 'confirmed', ticketId: prior.id } })
    expect(f.store.tickets()[0]?.ended?.outcome).toBe('stopped')
    expect(f.run).not.toHaveBeenCalled()
  })

  it('records old and new tickets when reassignment is requested', async () => {
    const f = fixture()
    const created = await f.intake.fromLiaison(understood('original-assignment', '研究资料归档方式'))
    const prior = f.store.tickets()[0]!
    const revised = await f.intake.edit(created.id, {
      scope, requestId: 'reassign-one', expectedVersion: created.version, itemId: created.items[0]!.id, action: 'reassign', staff: 'strategist',
    })
    const current = f.store.tickets()[1]!
    expect(current.staff).toBe('strategist')
    expect(f.intake.allowsCommand(prior.superhub!)).toBe(false)
    expect(f.intake.allowsCommand(current.superhub!)).toBe(true)
    expect(revised.items[0]).toMatchObject({ priorTicketIds: [prior.id], ticketId: current.id, stop: { ticketId: prior.id, state: 'confirmed' } })
  })

  it('recovers an engine submission whose response was lost without duplicating the ticket', async () => {
    const f = fixture()
    const original = f.engine.commission.bind(f.engine)
    vi.spyOn(f.engine, 'commission').mockImplementationOnce(async spec => {
      await original(spec)
      throw Error('injected lost receipt')
    })
    const body = understood('retry-source', '请比较两种协作机制')
    const uncertain = await f.intake.fromLiaison(body)
    expect(uncertain.items[0]).toMatchObject({ state: 'dispatching', reason: expect.stringContaining('injected lost receipt') })
    expect(f.store.tickets()).toHaveLength(1)
    const restarted = fixture(f.directory)
    const report = vi.fn()
    await restarted.intake.resume(report)
    expect(report).not.toHaveBeenCalled()
    const replay = await restarted.intake.fromLiaison(body)
    expect(replay).toMatchObject({ id: uncertain.id, items: [{ state: 'dispatched', ticketId: 'T-0001' }] })
    expect(restarted.store.tickets()).toHaveLength(1)
  })

  it('hides retired receipt actions and retains owner access to related independent material', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'chief-retired-intake-'))
    cleanup.push(() => rmSync(directory, {force: true, recursive: true}))
    const root = join(directory, 'brain')
    mkdirSync(root)
    const brainScope = workspaceScope(root)
    const f = fixture(directory, brainScope, 'brain')
    const text = '请保留这句备忘，并研究归档流程。'
    const originalInput = {...input('old-origin', text), scope: brainScope, goalIds: ['goal-one']}
    const original = await f.intake.submit(originalInput)
    const memo = await f.intake.fromLiaison(understood('old-origin', text, {intent: 'memo', brief: '保留这句备忘'}))
    const work = understood('old-origin', text, {brief: '研究归档流程'})
    const retired = await f.intake.fromLiaison(work)
    expect(retired.items[0]?.ticketId).toBe('T-0001')
    const output = 'work/T-0001/shared.md'
    const discussion = 'ad74c311-b676-4ddf-823a-eb63b26e00ac'
    const shared = '另有讨论引用的旧交付'
    mkdirSync(join(root, 'work', 'T-0001'), {recursive: true})
    mkdirSync(join(root, 'ops', 'discussions'))
    writeFileSync(join(root, output), shared)
    writeFileSync(join(root, 'ops', 'discussions', discussion + '.json'), JSON.stringify({
      id: discussion, document: {ticketId: 'T-0001', path: output, content: shared, author: staff[0]},
      quote: shared, messages: [], createdAt: '2026-11-23T08:00:00.000Z',
    }))

    const commission = f.engine.commission.bind(f.engine)
    vi.spyOn(f.engine, 'commission').mockImplementationOnce(async spec => {
      await commission(spec)
      throw Error('injected lost receipt')
    })
    const pending = understood('old-pending', '请比较两种方案')
    const unfinished = await f.intake.fromLiaison(pending)
    expect(unfinished.items[0]?.state).toBe('dispatching')
    f.engine.stop()
    const preview = cleanupLegacyOrders(root)
    expect(preview.ticketIds).toEqual(['T-0001', 'T-0002'])
    cleanupLegacyOrders(root, preview.id)

    const reopened = fixture(directory, brainScope, 'brain')
    const resumed = vi.spyOn(reopened.engine, 'commission')
    const unexpected = vi.fn()
    await reopened.intake.resume(unexpected)
    expect(resumed).not.toHaveBeenCalled()
    expect(unexpected).not.toHaveBeenCalled()
    const view = await request(reopened.intake.route, 'GET', `/superhub/items/${original.id}?scope=${brainScope}`)
    expect(view).toMatchObject({code: 200, result: {source: {text}, liaisonReceipts: [memo.id], linked: [{id: memo.id}]}})
    expect(await request(reopened.intake.route, 'GET', `/superhub/items/${retired.id}?scope=${brainScope}`))
      .toMatchObject({code: 200, result: {source: {text}, items: [], history: []}})
    const list = await request(reopened.intake.route, 'GET', `/superhub/items?scope=${brainScope}`)
    expect(JSON.stringify(list.result)).not.toMatch(/T-000[12]/)
    expect(reopened.intake.receiptsForGoal('goal-one').map(row => row.id)).toEqual([memo.id])
    const liaison = vi.fn(async () => {})
    const replayer = new SuperhubIntake({root, chiefHome: reopened.chiefHome, brainScope, engine: reopened.engine, liaison})
    expect(await request(replayer.route, 'POST', '/superhub/items', originalInput)).toMatchObject({code: 200})
    expect(liaison).not.toHaveBeenCalled()
    await expect(reopened.intake.fromLiaison(work)).rejects.toMatchObject({status: 404})
    await expect(reopened.intake.fromLiaison(pending)).rejects.toMatchObject({status: 404})
    expect(await request(reopened.intake.route, 'POST', `/superhub/items/${retired.id}`, {
      scope: brainScope, requestId: 'reassign-retired', expectedVersion: retired.version,
      itemId: retired.items[0]!.id, action: 'reassign', staff: 'strategist',
    })).toMatchObject({code: 404})
    expect(resumed).not.toHaveBeenCalled()
    expect(reopened.store.tickets()).toEqual([])

    const brain = {root} as never
    const discussions = new Discussions(reopened.engine, brain, {} as never)
    const routes = runtimeRoutes({engine: reopened.engine, brain, discussions, superhub: reopened.intake} as never)
    expect(await request(routes, 'GET', `/tickets/T-0001/file?path=${encodeURIComponent(output)}`)).toMatchObject({code: 404})
    expect(await request(routes, 'GET', `/file?path=${encodeURIComponent(output)}`)).toEqual({code: 200, result: {content: shared}})
    expect(await request(routes, 'GET', `/file?path=${encodeURIComponent(output)}`, undefined, false)).toMatchObject({code: 403})
    expect(await request(routes, 'GET', `/discussions/${discussion}`)).toMatchObject({code: 200, result: {quote: shared}})
    expect(await request(routes, 'GET', `/discussions/${discussion}`, undefined, false)).toMatchObject({code: 403})
    const question = {requestId: '731bff47-8af5-49ac-b191-41ec47f5bf57', text: '还需要核对什么？'}
    for (const action of ['', '/remote', '/followup']) {
      expect(await request(routes, 'POST', `/discussions/${discussion}${action}`, question)).toMatchObject({code: 404})
    }
    expect(await request(routes, 'POST', '/discussions', {...question, ticketId: 'T-0001', path: output, version: 'a'.repeat(64)}))
      .toMatchObject({code: 404})
    expect(discussions.get(discussion)?.messages).toEqual([])
    expect(resumed).not.toHaveBeenCalled()
    discussions.dispose()

    const current = await reopened.intake.fromLiaison(understood('new-source', '概括这份新材料'))
    expect(current.items[0]?.ticketId).toBe('T-0003')
    expect(reopened.intake.get(current.id)).toEqual(current)
  })

  it('reads the latest owner input of the active turn, including input spliced into the running turn', () => {
    const spliced: SessionEventLike = { type: 'agent/inbox/spliced', seq: 4, time: 3, data: { inserted: [
      { id: 'steered', source: { kind: 'user', rpcId: 'owner-steer' }, content: [{ type: 'text', text: '改成只读调查' }] }] } }
    expect(nativeIntakeSource([userEvent('先调研 A', 'owner-first'), spliced])).toEqual({ requestId: 'owner-steer', messageId: 'steered', text: '改成只读调查', at:new Date(spliced.time).toISOString() })
    expect(nativeIntakeSource([userEvent('先调研 A', 'owner-first'), { type: 'turn/end', seq: 5, time: 4, data: {} }])).toBeUndefined()
  })

  it('lets the legacy ticket drawer approve a discussion write ticket only with the contract version it loaded', async () => {
    const f = fixture()
    const plain = { threadId: 'thread-plain', stage: 'you/approve', ticket: { assignments: [{ id: 'A-1' }] } }
    expect(ownerTarget(plain)).toEqual({ thread_id: 'thread-plain', reply_to: 'A-1', stage: 'you/approve' })
    await f.intake.fromLiaison({ source: { requestId: 'room-message', messageId: 'room-message', text: '请调研文件归档流程' }, roomId: 'room-a',
      brief: '核对内部资料', title: '归档流程调研', staff: 'researcher', operation: 'write', doneWhen: ['交付一份可复查的归档清单'] })
    const route = runtimeRoutes({ engine: f.engine, brain: { root: f.root, staff: () => staff }, superhub: f.intake } as never)
    const load = async () => (await request(route, 'GET', '/tickets/T-0001')).result as OwnerTargetDetail
    const loaded = ownerTarget(await load())
    expect(loaded).toMatchObject({ reply_to: null, stage: 'you/approve', brainScope: scope, contractVersion: 1 })
    const { brainScope: _scope, contractVersion: _version, ...unscoped } = loaded
    expect(await request(route, 'POST', '/tickets/T-0001/approve', unscoped)).toMatchObject({ code: 409 })
    await f.engine.reviseContract('T-0001', [{ id: 'C-01', text: '交付一份可复查的归档清单及来源' }], '补充来源要求', {
      threadId: loaded.thread_id!, replyTo: loaded.reply_to, stage: loaded.stage, brainScope: loaded.brainScope, contractVersion: loaded.contractVersion })
    expect(await request(route, 'POST', '/tickets/T-0001/approve', loaded)).toMatchObject({ code: 409 })
    expect(f.engine.views()[0]!.stage).toBe('you/approve')
    const current = ownerTarget(await load())
    expect(current).toMatchObject({ brainScope: scope, contractVersion: 2 })
    expect(await request(route, 'POST', '/tickets/T-0001/approve', current)).toMatchObject({ code: 200 })
    expect(f.engine.views()[0]!.ticket.approvedAt).toBeTruthy()
  })

  it('keeps owner scope checks and chat replay on the normal HTTP entry point', async () => {
    const f = fixture()
    const prompt = vi.fn(async (_input: unknown, _signal: AbortSignal) => ({}))
    const chat = new LiaisonChat({ prompt } as never, 'hq', async () => ({ id: 'hq', status: 'idle' }))
    const route = runtimeRoutes({ engine: f.engine, chat, superhub: f.intake } as never)
    const memo = { scope, request_id: 'chat-memo', sessionId: 'hq', text: '只记一下发布想法' }
    expect(await request(route, 'POST', '/chat', memo, false)).toMatchObject({ code: 403 })
    expect(await request(route, 'POST', '/chat', { ...memo, scope: 'other' })).toMatchObject({ code: 409 })
    expect(await request(route, 'POST', '/chat', { ...memo, sessionId: 'previous' })).toMatchObject({ code: 409 })
    // Every scoped chat message reaches the liaison; the receipt only records the original words.
    expect(prompt).not.toHaveBeenCalled()
    expect(await request(route, 'POST', '/chat', memo)).toMatchObject({ code: 200, result: { receipt: { source: { text: memo.text, channel: 'chat' },
      items: [{ intent: 'conversation', state: 'conversation', restrictions: [] }] } } })
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls.at(0)).toMatchObject([{ requestId: 'chat-memo', content: [{ type: 'text', text: memo.text }] }, expect.anything()])
    // Only a confirmed hand-off says the words reached the liaison.
    expect(f.intake.receipts().at(-1)?.items[0]?.reason).toMatch(/^原话已交给接口人/)
    expect(await request(route, 'GET', '/chat?scope=other')).toMatchObject({ code: 409 })
    expect(f.intake.receipts().find(row => row.source.requestId === memo.request_id)?.source.context).toBeUndefined()
    const conversation = { ...memo, request_id: 'chat-conversation', text: '让研究员分别汇报一下三家云厂商的对象存储价格',
      context: { surface: 'workspace', selectedId: 'this-project' } }
    await Promise.all([request(route, 'POST', '/chat', conversation), request(route, 'POST', '/chat', conversation)])
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(prompt.mock.calls.at(1)).toMatchObject([{ requestId: 'chat-conversation', content: [{ type: 'text', text: conversation.text }] }, expect.anything()])
    const reopened = fixture(f.directory)
    const restored = reopened.intake.receipts().find(row => row.source.requestId === conversation.request_id)
    expect(restored?.source.context).toEqual(conversation.context)
    const restartedChat = new LiaisonChat({ prompt } as never, 'hq', async () => ({ id: 'hq', status: 'idle' }))
    const restartedRoute = runtimeRoutes({ engine: reopened.engine, chat: restartedChat, superhub: reopened.intake } as never)
    expect(await request(restartedRoute, 'POST', '/chat', conversation)).toMatchObject({code: 200})
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(await request(route, 'POST', '/chat', { ...conversation, context: { ...conversation.context, selectedId: 'elsewhere' } })).toMatchObject({ code: 409 })
    expect(f.store.tickets()).toEqual([])
    // SuperHub direct intake without a liaison session keeps the words and explains why nothing happened yet.
    const held = await request(f.intake.route, 'POST', '/superhub/items', { scope, requestId: 'no-liaison', text: '请调研归档' })
    expect(held).toMatchObject({ code: 503 })
    expect(f.intake.receipts().at(-1)).toMatchObject({ source: { text: '请调研归档' }, items: [{ state: 'conversation', reason: expect.stringContaining('还没交给接口人') }] })
    expect(await request(route, 'GET', '/superhub/items', undefined, false)).toMatchObject({ code: 403 })
    expect(await request(route, 'GET', '/superhub/items?scope=other')).toMatchObject({ code: 409 })
    const work = await f.intake.fromLiaison({ source: { requestId: 'legacy-file-protection', messageId: 'm', text: '请核对产物' }, sessionId: 'hq', brief: '核对产物', operation: 'read' })
    const ticket = work.items[0]!.ticketId!
    for (const path of [`/tickets/${ticket}`, `/tickets/${ticket}/thread`,
      `/tickets/${ticket}/file?path=work/${ticket}/proof.md`, `/tickets/${ticket}/document?path=work/${ticket}/proof.md`,
      `/file?path=ops/tickets/${ticket}.json`]) {
      expect(await request(runtimeRoutes({ brain: { root: f.root }, engine: f.engine, chat, superhub: f.intake } as never),
        'GET', path, undefined, false)).toMatchObject({ code: 403 })
    }
    const other = fixture(f.directory, 'other')
    expect(await request(other.intake.route, 'GET', `/superhub/items/${f.intake.receipts()[0]!.id}?scope=other`)).toMatchObject({ code: 404 })
  })

  it('binds ordered liaison materials to the owner request, native history and retries', async () => {
    const f = fixture()
    const image: ChatInputAttachment = { id: 'image', kind: 'image', name: 'image.png', bytes: 12, mediaType: 'image/png' }
    const file: ChatInputAttachment = { id: 'file', kind: 'file', name: 'data.txt', bytes: 7 }
    const refs = new Map([image, file].map(ref => [ref.id, ref]))
    const events: SessionEventLike[] = []
    const allowRead = vi.fn()
    const resolve = vi.fn((_target, ids: string[]) => ids.map(id => refs.get(id)!))
    const promptParts = vi.fn(async (_sessionId, attachments: ChatInputAttachment[]) => attachments.map(ref => ({ type: 'file', receiptId: ref.id })))
    const inputAttachments = { allowRead, resolve, promptParts }
    const prompt = vi.fn(async (next: { requestId: string; content: {type: string; receiptId?: string}[] }, _signal: AbortSignal) => {
      events.push({ type: 'user/message', seq: events.length + 1, time: Date.now(), data: {
        source: { kind: 'user', rpcId: next.requestId },
        content: next.content.map(part => part.receiptId ? { type: refs.get(part.receiptId)?.kind } : part),
      } })
      return { accepted: true }
    })
    const build = (intake: SuperhubIntake) => {
      const chat = new LiaisonChat({ prompt } as never, 'hq', async () => ({ id: 'hq', status: 'idle', session: { snapshotEvents: () => events } }),
        undefined, undefined, undefined, undefined, undefined, { service: inputAttachments as never, forRequest: source => intake.ownerTurnOrigin(source)?.inputAttachments })
      return runtimeRoutes({ engine: f.engine, chat, superhub: intake, inputAttachments } as never)
    }
    const route = build(f.intake)
    const body = { scope, requestId: 'only-material', sessionId: 'hq', inputAttachments: [image.id, file.id] }
    expect(await request(route, 'POST', '/chat', body, false)).toMatchObject({ code: 403 })
    expect(await request(route, 'POST', '/chat', { ...body, sessionId: undefined })).toMatchObject({ code: 409 })
    expect(await request(route, 'POST', '/chat', { ...body, sessionId: 'previous' })).toMatchObject({ code: 409 })
    expect(resolve).not.toHaveBeenCalled()
    const rejection = Object.assign(new Error('Model does not support image input'), {
      code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
    })
    prompt.mockRejectedValueOnce(rejection)
    expect(await request(route, 'POST', '/chat', body)).toMatchObject({ code: 422, result: { error: expect.stringMatching(/图片/) } })
    expect(allowRead).not.toHaveBeenCalled()
    expect((await request(route, 'GET', '/chat')).result).toMatchObject({ messages: [] })
    expect(await request(route, 'POST', '/chat', body)).toMatchObject({ code: 200, result: { receipt: { source: { text: '', inputAttachments: [image, file] } } } })
    expect(prompt.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: body.requestId, content: [{ type: 'file', receiptId: image.id }, { type: 'file', receiptId: file.id }] })
    expect(resolve).toHaveBeenCalledWith({ sessionId: 'hq' }, body.inputAttachments)
    expect(allowRead).toHaveBeenCalledExactlyOnceWith('hq', [image, file])
    expect((await request(route, 'GET', '/chat')).result).toMatchObject({ messages: [{ role: 'you', text: '', requestId: body.requestId, inputAttachments: [image, file] }] })
    expect(nativeAttachmentOnlyTurn(events)).toBe(true)
    expect(nativeIntakeSource([userEvent('之前同意开工', 'earlier'), ...events])).toBeUndefined()
    expect(await request(route, 'POST', '/chat', { ...body, inputAttachments: [file.id, image.id] })).toMatchObject({ code: 409 })
    const restarted = build(fixture(f.directory).intake)
    expect(await request(restarted, 'POST', '/chat', { ...body, text: '' })).toMatchObject({ code: 200 })
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('uses the liaison brief as the work and only the current native human RPC message as authorization', async () => {
    const f = fixture()
    type Tool = Parameters<Tools['register']>[0]
    const registered = new Map<string, Tool>()
    const ctx = { tools: { register: (tool: Tool) => { registered.set(tool.name, tool); return () => {} } } } as unknown as HostContext
    registerTools(ctx, { engine: f.engine, superhub: f.intake, isLiaison: (id: string) => id === 'hq',
      lookup: { info: () => ({ subagent: false }) }, ui: { custom: {} },
    } as unknown as Parameters<typeof registerTools>[1])
    const call = (tool: string, args: Record<string, unknown>, events: SessionEventLike[]) => registered.get(tool)!.execute(args, {
      agent: { id: 'hq', session: { snapshotEvents: () => events } }, signal: new AbortController().signal,
    } as never)
    await expect(call('chief_inbox', { text: '研究权限', operation: 'read' }, [userEvent('只记一下思路')])).rejects.toThrow('经宿主确认')
    const memo = [userEvent('只记一下思路', 'owner-memo')]
    // 备忘由接口人声明（intent=memo），系统不再从原话里猜
    expect(await call('chief_inbox', { text: '研究权限', operation: 'read', intent: 'memo' }, memo)).toMatchObject({ dispatched: false, message: expect.stringMatching(/^已记下原话，未派工：接口人判断主人只要求记下/) })
    await expect(call('chief_ui', { action: 'source', request: '修改工单详情' }, memo)).rejects.toThrow('feature 必填')
    expect(f.store.tickets()).toEqual([])
    const actual = [userEvent('请调研如何归档发版资料', 'owner-work')]
    expect(await call('chief_inbox', { text: '调研发版资料的归档方式，交付一份清单', operation: 'read' }, actual)).toMatchObject({ ticketId: 'T-0001' })
    expect(f.store.recentEvents(1)[0]?.text).toBe('请调研如何归档发版资料')
    expect(f.store.ticket('T-0001')!.mandate.scope).toContain('接口人理解的任务：调研发版资料的归档方式，交付一份清单')
    expect(f.intake.receipts().at(-1)?.authorization).toMatchObject({ ownerText: '请调研如何归档发版资料', requestId: 'owner-work', sessionId: 'hq' })
    await expect(call('chief_inbox', { text: '重复执行', operation: 'read' }, [...actual, { type: 'turn/end', seq: 3, time: 2, data: {} }])).rejects.toThrow('经宿主确认')
    // The liaison picks the feature from the catalog with its basis; the system checks only the identity and version.
    const ui = [userEvent('把左边那个讨论列表改清爽一点', 'owner-ui')]
    await expect(call('chief_ui', { action: 'source', request: '精简讨论列表', feature: 'left-panel', feature_basis: '左边' }, ui)).rejects.toThrow('不在功能目录里')
    expect(await call('chief_ui', { action: 'source', request: '精简讨论列表的视觉层级', feature: 'discussion-navigation', feature_basis: '主人原话「讨论列表」' }, ui)).toMatchObject({ ticketId: 'T-0002', dispatched: true, message: expect.stringContaining('等主人在「等你决定」里批准后才执行') })
    expect(f.store.ticket('T-0002')).toMatchObject({ staff: 'ui-smith', mandate: { level: 'write' }, superhub: { approvalRequired: true } })
    expect(f.engine.views().find(view => view.ticket.id === 'T-0002')?.stage).toBe('you/approve')
    expect(f.intake.receipts().at(-1)?.items[0]?.state).toBe('dispatched')
  })
})
