import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Executors } from '../src/core/engine.ts'
import type { Assignment, Ticket } from '../src/core/model.ts'
import { FileStore } from '../src/core/store.ts'
import type { GoalReference, GoalVersion } from '../src/core/superhub-goals.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { serveApi } from '../src/dsh/http.ts'
import type { HostContext } from '../src/dsh/ports.ts'
import { NativeRooms } from '../src/dsh/rooms.ts'
import { SuperhubIntake, type IntakeReceipt, type IntakeReceiptView, type LiaisonRequest } from '../src/dsh/superhub.ts'
import { SuperhubGoals, type GoalChange } from '../src/dsh/superhub-goals.ts'
import { SuperhubSaa, type SaaRecord } from '../src/dsh/superhub-saa.ts'
import { createSuperhubTrace, type SuperhubEvidence, type SuperhubMission } from '../src/dsh/superhub-trace.ts'
import { superhubWorkspaceRoutes, type WorkspaceTicket } from '../src/dsh/superhub-workspace.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

type GoalView = {
  goal: GoalChange['goal']
  items: { receiptId: string; itemId: string; ticketId?: string; state: string; primary?: boolean; disputed?: boolean }[]
  tasks: WorkspaceTicket[]
  knownConditions: number
  requiredConditions: number
  invalidEvidence?: unknown[]
}

function fixture(scope = 'workspace-a', installation?: string, base = Date.now() - 10 * 60_000) {
  const directory = installation ?? mkdtempSync(join(tmpdir(), 'chief-superhub-workspace-'))
  if (!installation) cleanup.push(() => rmSync(directory, { force: true, recursive: true }))
  const root = join(directory, scope)
  const at = (minutes = 0) => new Date(base + minutes * 60_000).toISOString()
  const store = new FileStore(root)
  mkdirSync(join(root, 'staff'), { recursive: true })
  const researcher = join(root, 'staff', 'researcher.md')
  if (!existsSync(researcher)) writeFileSync(researcher, '---\nid: researcher\nname: 研究员\nexecutor: dsh\nverifier: reviewer\n---\n检查资料。\n')
  const brain = new BrainRepo(root)
  const commit = vi.fn(), dispatch = vi.fn()
  const run = vi.fn<Executors['run']>(async () => { throw new Error('fixture work should stay paused') })
  const goals = new SuperhubGoals(root, commit)
  const saa = new SuperhubSaa(root, commit)
  const host = { get: () => undefined } as unknown as HostContext
  const rooms = new NativeRooms(host, root, () => brain.staff())
  let superhub: SuperhubIntake
  const engine = new Engine(store, brain, { available: () => true, supportsSchema: () => true, run },
    { dispatch, cancel: vi.fn() }, { concurrency: 1, timeZone: 'UTC', brainScope: scope,
      now: () => new Date(base), canStartSuperhub: authorization => superhub.allowsCommand(authorization) })
  engine.setPaused(true)
  // A deterministic stand-in for the liaison model: the structured understanding it would register for each owner request.
  const understood = new Map<string, Partial<LiaisonRequest>>()
  superhub = new SuperhubIntake({ root, chiefHome: join(directory, 'app'), brainScope: scope, engine,
    now: () => new Date(base), staff: () => brain.staff(), hasGoal: id => !!goals.get(id),
    liaison: async (text, requestId) => { await superhub.fromLiaison({ source: { requestId, messageId: `message-${requestId}`, text }, sessionId: 'hq', brief: text,
      operation: 'read', ...understood.get(requestId) }) } })
  const trace = createSuperhubTrace(host, engine, scope, { brainRoot: root, staff: () => brain.staff() })
  const workspace = superhubWorkspaceRoutes({ scope, brain, engine, trace, rooms, goals, saa, superhub })
  cleanup.push(() => { engine.stop(); trace.dispose(); rooms.dispose() })

  async function request<T = unknown>(path: string, body?: Record<string, unknown>, owner = true, requestedScope = scope) {
    const url = new URL('/chief/api/superhub/' + path, 'http://local')
    if (body === undefined) url.searchParams.set('scope', requestedScope)
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify({ scope: requestedScope, ...body }))] : []), {
      method: body === undefined ? 'GET' : 'POST', url: url.pathname + url.search, headers: { 'x-chief-request': '1' },
    }) as unknown as IncomingMessage
    let code = 0, result: T
    const res = {
      writeHead(status: number) { code = status },
      end(value: string) { result = JSON.parse(value) as T },
    } as unknown as ServerResponse
    await serveApi(req, res, 'dsh', [workspace, superhub.route], owner)
    return { code, result: result! }
  }
  const create = async (requestId: string, name: string, criteria: string[] = []) => {
    const response = await request<GoalChange>('goals', { requestId, name, expectedVersion: 0,
      reason: '主人确认目标', criteria: criteria.map(text => ({ text })) })
    expect(response.code).toBe(200)
    return response.result
  }
  /** Owner input in the SuperHub intake; returns the receipt the liaison registered from it. */
  const intake = async (requestId: string, text: string, goalIds: string[] = [], understanding: Partial<LiaisonRequest> = {}) => {
    understood.set(requestId, understanding)
    const response = await request<IntakeReceiptView>('items', { requestId, text, goalIds })
    expect(response.code).toBe(200)
    expect(response.result.linked).toHaveLength(1)
    return response.result.linked![0]!
  }
  const facts = () => ({ tickets: store.tickets(), events: store.recentEvents(100), queued: store.pendingEvents() })

  function report(ticketId: string, status: 'question' | 'ready', name = 'checklist.md') {
    const ticket = store.ticket(ticketId)!
    const version = ticket.superhub!.contracts.at(-1)!
    const result: Assignment = {
      id: 'assignment-' + ticketId, staff: ticket.staff, executor: 'dsh', role: brain.staff()[0],
      round: 0, contractVersion: version.version, startedAt: at(0.25), endedAt: at(0.5), state: 'reported',
      report: { status, summary: '已核对材料', structured: true },
    }
    const content = '已核对：入口可访问，归档文件可按日期找回。\n'
    const path = 'work/' + ticketId + '/' + name
    if (status === 'ready') {
      writeFileSync(join(brain.workdir(ticketId), name), content)
      const deliveries = brain.snapshotOutputs(ticketId, [name])
      expect(deliveries).toHaveLength(1)
      result.deliveries = deliveries
      result.report = { ...result.report!, outputs: [path] }
      result.verifiedAt = at(0.75)
      result.verification = {
        status: 'completed', verdict: 'pass', critique: '交付中包含实际出处', contractVersion: version.version,
        criteria: version.criteria.map(criterion => ({ criterionId: criterion.id, status: 'pass',
          evidence: deliveries.map(delivery => ({ ...delivery, kind: 'delivery' })) })),
      }
    } else {
      result.report = { ...result.report!, question: '请确认发布范围。' }
    }
    store.saveTicket({ ...ticket, assignments: [result], ...(status === 'ready'
      ? { ended: { at: at(1), outcome: 'done' as const, note: '主人已验收' } } : {}) })
    return { path, content }
  }
  async function delivery(ticketId: string) {
    const { code, result } = await request<SuperhubMission>('mission/' + ticketId)
    expect(code).toBe(200)
    const evidence = result.evidence.find(row => row.kind === 'delivery')
    expect(evidence).toBeDefined()
    return { ticketId, evidenceId: evidence!.id }
  }
  return { directory, root, scope, base, at, goals, saa, store, trace, run, dispatch, commit, request, create, intake, facts, report, delivery }
}

const target = (receipt: IntakeReceipt) => receipt.items[0]!
const reason = '主人复查目标关系'
const finding = (criterion: GoalVersion['criteria'][number], reference: GoalReference) => ({
  criterionId: criterion.id, status: 'met', note: '交付版本中直接核对', evidence: [reference],
})

function pauseEvidenceLookup(trace: ReturnType<typeof createSuperhubTrace>) {
  const evidence = trace.evidence.bind(trace)
  const reading = Promise.withResolvers<void>(), releasing = Promise.withResolvers<void>()
  vi.spyOn(trace, 'evidence').mockImplementationOnce(async (ticket, id) => {
    reading.resolve()
    await releasing.promise
    return evidence(ticket, id)
  })
  return { reading: reading.promise, resume: () => releasing.resolve() }
}

describe('SuperHub goal and review endpoints', () => {
  it('keeps associated memos and independent items and rebuilds both goal links to one durable work record', async () => {
    const f = fixture()
    const primary = await f.create('primary', '可追溯的归档', ['检查索引']), secondary = await f.create('secondary', '清晰的交接')
    const goalIds = [primary.goal.id, secondary.goal.id]
    const memo = await f.intake('linked-memo', '只记一下档案目录的想法', goalIds, { intent: 'memo' })
    const work = await f.intake('linked-work', '请研究归档目录流程并输出清单', goalIds)
    const temporary = await f.intake('temporary-work', '请研究交接索引的排序规则')
    const independent = await f.request<IntakeReceipt>('items/' + temporary.id, {
      requestId: 'independent', action: 'associate', itemId: target(temporary).id, expectedVersion: temporary.version,
      goalDisposition: 'independent', goalIds: [],
    })
    expect(target(memo)).toMatchObject({ state: 'recorded', intent: 'memo', goalIds })
    expect(target(work)).toMatchObject({ state: 'dispatched', goalDisposition: 'associated', goalIds })
    expect(target(temporary)).toMatchObject({ state: 'dispatched', goalDisposition: 'unassigned', goalIds: [] })
    expect(independent.code).toBe(200)
    expect(target(independent.result)).toMatchObject({ state: 'dispatched', goalDisposition: 'independent', goalIds: [], ticketId: target(temporary).ticketId })
    const workId = target(work).ticketId!
    const disputed = await f.request<IntakeReceipt>('items/' + work.id, {
      requestId: 'disputed', action: 'associate', itemId: target(work).id, expectedVersion: work.version,
      goalDisposition: 'disputed', goalIds,
    })
    expect(disputed.code).toBe(200)
    expect(target(disputed.result)).toMatchObject({ goalDisposition: 'disputed', ticketId: workId, goalIds })
    expect((await f.request<GoalView>('goals/' + primary.goal.id)).result).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ receiptId: work.id, disputed: true })]), tasks: [],
    })
    expect(await f.request('items/' + work.id, { requestId: 'reconfirm-goals', action: 'associate',
      itemId: target(work).id, expectedVersion: disputed.result.version, goalIds })).toMatchObject({ code: 200 })
    f.report(workId, 'ready')
    const initialEvidence = await f.delivery(workId)
    const revision = await f.request('goals/' + primary.goal.id, { requestId: 'revise-primary', expectedVersion: 1, reason,
      name: '归档索引验证', criteria: [{ ...primary.current.criteria[0], text: '检查索引和回查权限' }] })
    expect(revision).toMatchObject({ code: 200, result: {
      goal: { id: primary.goal.id }, previous: primary.current,
      current: { version: 2, criteria: [{ id: primary.current.criteria[0]!.id, text: '检查索引和回查权限' }] },
      impact: { tickets: [workId], items: 2 },
    } })
    const facts = f.facts()
    expect(facts.tickets).toHaveLength(2)
    expect(facts.events).toHaveLength(2)

    const restarted = fixture(f.scope, f.directory, f.base)
    for (const id of goalIds) {
      const { code, result } = await restarted.request<GoalView>('goals/' + id)
      expect(code).toBe(200)
      expect(result.items.map(row => row.receiptId).sort()).toEqual([memo.id, work.id].sort())
      expect(result.items.find(row => row.receiptId === work.id)).toMatchObject({ primary: id === primary.goal.id, disputed: false })
      expect(result.tasks.map(row => row.id)).toEqual([workId])
    }
    expect(await restarted.delivery(workId)).toEqual(initialEvidence)
    expect(restarted.facts()).toEqual(facts)
    expect(f.run).not.toHaveBeenCalled()
    expect(restarted.run).not.toHaveBeenCalled()
    expect(restarted.dispatch).not.toHaveBeenCalled()
  })

  it('retains the original legacy child standard across reorder and index rebuild', async () => {
    const f = fixture()
    const mandate = { eventId: 'legacy-source', strength: 'explicit', level: 'think', scope: '既有授权',
      doneWhen: ['原标准甲', '原标准乙'], needsReview: true } as const
    const parent: Ticket = { id: 'T-0042', title: '旧父工单', createdAt: f.at(), mandate, staff: 'researcher',
      assignments: [], inputs: [], events: [], priority: 1 }
    const child: Ticket = {
      ...parent, id: 'T-0043', title: '旧子工单', mandate: { ...mandate, eventId: 'legacy-child-source', doneWhen: ['原标准甲'] },
      parent: { ticketId: parent.id, assignmentId: 'legacy-assignment', key: 'handoff', criterion: 0 },
    }
    f.store.saveTicket(parent)
    f.store.saveTicket(child)
    const link = (view: SuperhubMission) => view.relatedTickets.find(ticket => ticket.id === child.id)
    const baseline = (await f.request<SuperhubMission>('mission/' + parent.id)).result
    const original = link(baseline)
    expect(original).toMatchObject({ criterion: 0, criterionId: baseline.criteria[0]!.id, criterionText: '原标准甲', criterionVersion: 0 })

    f.store.saveTicket({ ...parent, mandate: { ...mandate, doneWhen: [...mandate.doneWhen].reverse() } })
    const restarted = fixture(f.scope, f.directory, f.base)
    const reloaded = await restarted.request<SuperhubMission>('mission/' + parent.id)
    expect(reloaded.result.criteria.map(({ id, text }) => ({ id, text }))).toEqual(
      [...baseline.criteria].reverse().map(({ id, text }) => ({ id, text })))
    expect(link(reloaded.result)).toEqual(original)
    expect(restarted.store.ticket(child.id)).toEqual(child)
    expect(restarted.store.tickets()).toEqual(f.store.tickets())
    expect(restarted.run).not.toHaveBeenCalled()
  })

  it('allows one concurrent relationship update and enforces owner and brain scope before mutation', async () => {
    const f = fixture()
    const other = fixture('workspace-b', f.directory)
    const goal = await f.create('same-request', '归档索引')
    const top = await f.create('higher', '交付总目标')
    const neighboring = await f.create('adjacent', '证据汇总')
    const update = { expectedVersion: 1, reason, parent: top.goal.id }
    const path = 'goals/' + goal.goal.id
    expect(await other.request(path, { ...update, requestId: 'stale-draft' }, true, f.scope)).toMatchObject({ code: 409 })
    expect(await other.request(path)).toMatchObject({ code: 404 })
    expect(await f.request(path, { ...update, requestId: 'other-user' }, false)).toMatchObject({ code: 403 })
    expect(await f.request(path, undefined, false)).toMatchObject({ code: 403 })
    expect(other.goals.list()).toEqual([])

    const attempts = [{ ...update, requestId: 'first-change' }, { ...update, requestId: 'second-change', parent: neighboring.goal.id }]
    const results = await Promise.all(attempts.map(body => f.request<GoalChange>(path, body)))
    expect(results.map(row => row.code).sort()).toEqual([200, 409])
    const winner = results.findIndex(row => row.code === 200)
    const saved = results[winner]!, accepted = attempts[winner]!
    expect(saved.result.current).toMatchObject({ parent: accepted.parent, version: 2 })
    expect(results.find(row => row.code === 409)?.result).toMatchObject({ error: expect.stringContaining('目标已更新') })
    expect((await f.request<GoalView>(path)).result.goal.versions).toEqual([goal.current, saved.result.current])
    expect(await f.request(path, accepted)).toEqual(saved)
  })

  it('keeps goal outcomes distinct from ticket completion and binds findings to linked exact evidence', async () => {
    const f = fixture()
    const goal = await f.create('goal', '三项成果', ['确认访问路径', '回查归档来源', '复测发布状态'])
    const linked = await f.intake('linked', '请研究验收材料', [goal.goal.id])
    const unlinked = await f.intake('unlinked', '请研究名单审核流程')
    const linkedId = target(linked).ticketId!, unlinkedId = target(unlinked).ticketId!
    const { path, content } = f.report(linkedId, 'ready')
    f.report(unlinkedId, 'ready')
    const proof = await f.delivery(linkedId)
    const foreign = await f.delivery(unlinkedId)
    const url = 'goals/' + goal.goal.id
    expect((await f.request<GoalView>(url)).result).toMatchObject({
      knownConditions: 0, requiredConditions: 3, hasNewEvidence: true, tasks: [{ id: linkedId, outcome: 'done' }],
      goal: { versions: [{ status: 'active' }] },
    })

    const first = finding(goal.current.criteria[0]!, proof), second = finding(goal.current.criteria[1]!, proof)
    const assessment = { result: 'in-progress', note: '两个必要条件通过，发布状态待确认', findings: [first, second] }
    const update = { expectedVersion: 1, reason, assessment }
    expect(await f.request(url, { ...update, requestId: 'unlinked-reference',
      assessment: { ...assessment, findings: [finding(goal.current.criteria[0]!, foreign)] } }))
      .toMatchObject({ code: 400, result: { error: expect.stringContaining('不属于当前目标') } })
    expect(await f.request(url, { ...update, requestId: 'premature-achieved', status: 'achieved', assessment: { ...assessment, result: 'met' } }))
      .toMatchObject({ code: 400, result: { error: expect.stringContaining('所有必要条件') } })

    const pending = pauseEvidenceLookup(f.trace)
    const staleLink = f.request(url, { ...update, requestId: 'stale-link' })
    await pending.reading
    const edited = await f.request<IntakeReceipt>('items/' + linked.id, {
      requestId: 'unlink-during-read', action: 'associate', itemId: target(linked).id, expectedVersion: linked.version,
      goalDisposition: 'independent', goalIds: [],
    })
    pending.resume()
    expect(edited.code).toBe(200)
    expect(await staleLink).toMatchObject({ code: 400, result: { error: expect.stringContaining('不属于当前目标') } })
    expect(await f.request('items/' + linked.id, { requestId: 'restore-link', action: 'associate',
      itemId: target(linked).id, expectedVersion: edited.result.version, goalIds: [goal.goal.id] })).toMatchObject({ code: 200 })
    expect(await f.request(url, { ...update, requestId: 'assess-partial' })).toMatchObject({ code: 200 })
    expect((await f.request<GoalView>(url)).result).toMatchObject({
      knownConditions: 2, requiredConditions: 3, hasNewEvidence: false,
      goal: { versions: [goal.current, { version: 2, status: 'active', assessment: { result: 'in-progress', version: 2, findings: [first, second] } }] },
    })

    writeFileSync(join(f.root, path), '这已经是不同版本。\n')
    expect((await f.request<GoalView>(url)).result).toMatchObject({ knownConditions: 0, requiredConditions: 3,
      invalidEvidence: expect.arrayContaining([expect.objectContaining(proof)]) })
    expect(await f.request(url, { ...update, expectedVersion: 2, requestId: 'outdated-delivery' }))
      .toMatchObject({ code: 400, result: { error: expect.stringContaining('版本已变更') } })
    const exact = await f.request<{ evidence: SuperhubEvidence; content: string }>('evidence/' + linkedId + '/' + proof.evidenceId)
    expect(exact.result.content).toBe(content)
    expect(exact.result.evidence.version).toBe(f.store.ticket(linkedId)!.assignments[0]!.deliveries![0]!.version)
    expect(f.goals.get(goal.goal.id)?.versions).toHaveLength(2)
  })

  it('validates work windows and saves a scoped checkpoint without changing work, including after restart', async () => {
    const f = fixture()
    const focus = await f.create('focus', '归档交付'), blocker = await f.create('blocker', '发布授权')
    const planned = await f.request<GoalChange>('goals/' + focus.goal.id, { requestId: 'require-approval',
      expectedVersion: 1, reason, relations: [{ target: blocker.goal.id, kind: 'requires' }] })
    expect(planned.code).toBe(200)
    const verified = await f.intake('review-proof', '请研究档案索引', [focus.goal.id])
    const awaiting = await f.intake('review-awaiting', '请研究交接发布范围', [focus.goal.id])
    const completedId = target(verified).ticketId!, waitingId = target(awaiting).ticketId!
    f.report(completedId, 'ready')
    f.report(waitingId, 'question')
    const reference = await f.delivery(completedId)
    const from = f.at(-1), to = f.at(3)
    const params = new URLSearchParams({ from, to, goal: focus.goal.id })
    expect(await f.request('review?' + params)).toMatchObject({ code: 200, result: {
      from, to, focus: [{ id: focus.goal.id, version: 2 }],
      blockers: [{ goalId: focus.goal.id, target: blocker.goal.id, name: '发布授权' }],
      attention: [{ id: waitingId, stage: 'you/answer', question: '请确认发布范围。' }],
      evidence: expect.arrayContaining([expect.objectContaining({ ticket: expect.objectContaining({ id: completedId }),
        evidence: expect.arrayContaining([expect.objectContaining({ id: reference.evidenceId })]) })]),
    } })
    const draft = {
      requestId: 'save-review', from, to, goalIds: [focus.goal.id], goalVersions: [{ id: focus.goal.id, version: 2 }],
      tickets: [completedId, waitingId], references: [reference], alignment: '索引证据已核对，符合本段目标。',
      bottleneck: '环节还需要主人确认发布范围。', nextFocus: '确认交接范围', firstStep: '打开范围问题核对人员名单。',
      coordination: '待主人给出范围。', drift: '当前工作仍围绕归档交付。',
      checkpoint: { blockedOn: '授权人尚未确认', ruledOut: '索引入口故障', resumeAt: '打开发布范围问题' },
    }
    const stale = { ...draft, goalVersions: [{ id: focus.goal.id, version: 1 }] }
    expect(await f.request('review', stale)).toMatchObject({ code: 409, result: { error: expect.stringContaining('主线目标已更新') } })
    expect(await f.request('review', { ...draft, from: to })).toMatchObject({ code: 400 })
    expect(await f.request('review', { ...draft, tickets: [waitingId] })).toMatchObject({ code: 400 })
    expect(await f.request('review', draft, true, 'previous-workspace')).toMatchObject({ code: 409 })
    expect(f.saa.list()).toEqual([])

    const pending = pauseEvidenceLookup(f.trace)
    const concurrent = f.request('review', draft)
    await pending.reading
    const updated = await f.request<GoalChange>('goals/' + focus.goal.id,
      { requestId: 'rename-during-read', expectedVersion: 2, reason, name: '交付与追踪' })
    pending.resume()
    expect(updated.code).toBe(200)
    expect(await concurrent).toMatchObject({ code: 409, result: { error: expect.stringContaining('主线目标已更新') } })
    expect(f.saa.list()).toEqual([])
    draft.goalVersions[0]!.version = updated.result.current.version

    const facts = JSON.stringify(f.facts())
    const saved = await f.request<{ scope: string; record: SaaRecord }>('review', draft)
    expect(saved).toMatchObject({ code: 200, result: { record: { from, to, goals: draft.goalVersions, tickets: draft.tickets,
      references: [reference], checkpoint: draft.checkpoint, firstStep: draft.firstStep } } })
    expect(JSON.stringify(f.facts())).toBe(facts)
    expect(f.run).not.toHaveBeenCalled()
    const persisted = readFileSync(join(f.root, 'ops', 'superhub-saa.json'), 'utf8')

    const restarted = fixture(f.scope, f.directory, f.base)
    expect(await restarted.request('review', draft)).toEqual(saved)
    expect(await restarted.request('review', { ...draft, nextFocus: '换一个重点' })).toMatchObject({ code: 409 })
    expect(await restarted.request('review/' + saved.result.record.id)).toEqual(saved)
    expect(await restarted.request('review/history')).toMatchObject({ code: 200, result: { records: [saved.result.record] } })
    expect(await restarted.request('review')).toMatchObject({ code: 200, result: { from: to } })
    expect(readFileSync(join(f.root, 'ops', 'superhub-saa.json'), 'utf8')).toBe(persisted)
    expect(JSON.stringify(restarted.facts())).toBe(facts)
    expect(restarted.run).not.toHaveBeenCalled()
    expect(restarted.dispatch).not.toHaveBeenCalled()
  })
})
