import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { TicketView } from '../src/core/engine.ts'
import type { AcceptanceContract, Assignment, Staff, Ticket } from '../src/core/model.ts'
import { columnOf, stageOf } from '../src/core/stage.ts'
import { DshExecutors } from '../src/dsh/executors.ts'
import type { Agent, HostContext, SessionEventLike } from '../src/dsh/ports.ts'
import { createSuperhubTrace } from '../src/dsh/superhub-trace.ts'

const base = Date.parse('2026-11-18T00:00:00Z')
const t = (n: number) => new Date(base + n).toISOString()
const scope = 'brain-boundary'
const staff: Staff = { id: 'engineer', name: '工程师', executor: 'claude-code', verifier: 'reviewer', model: 'configured/route', brief: '私密角色提示' }
const idle: Staff = { id: 'analyst', name: '分析师', executor: 'dsh', verifier: 'none', brief: '' }
const contract: AcceptanceContract = {
  version: 1, createdAt: t(1), scope: '测试范围', allowed: ['think'], denied: ['write'],
  needsReview: true, staff: staff.id, criteria: [{ id: 'result', text: '交付验证文件', required: true, method: 'delivery' }],
}
const artifact = 'registered deliverable'
const version = createHash('sha256').update(artifact).digest('hex')
const native = (id: string) => ({ provider: 'spawn', activationId: id })

function assignment(id: string, session: string, patch: Partial<Assignment> = {}): Assignment {
  return { id, staff: staff.id, executor: staff.executor, role: staff, round: 0, startedAt: t(10), endedAt: t(400),
    state: 'reported', contractVersion: 1, execution: native(session), ...patch }
}

function ticket(id: string, assignments: Assignment[] = [], overrides: Partial<Ticket> = {}): Ticket {
  return {
    id, title: `工单 ${id}`, threadId: `thread-${id}`, createdAt: t(1), staff: staff.id, priority: 50,
    mandate: { strength: 'explicit', level: 'think', scope: '测试', doneWhen: ['测试'], needsReview: true, eventId: `source-${id}` },
    inputs: [], events: [`source-${id}`], assignments,
    superhub: { brainScope: scope, sourceId: `intent-${id}`, commandId: `command-${id}`, contracts: [contract] }, ...overrides,
  }
}

function harness(...initial: Ticket[]) {
  const tickets = new Map(initial.map(row => [row.id, row]))
  const ticketView = (id: string): TicketView | undefined => {
    const ticket = tickets.get(id)
    if (!ticket) return
    const stage = stageOf(ticket)
    return { ticket, stage, column: columnOf(stage), attention: 0 }
  }
  const listeners = new Set<(ticket: Ticket) => void>()
  const engine = {
    views: vi.fn(() => [...tickets.keys()].map(id => ticketView(id)!)), ticketView, onTicketSaved(listener: (ticket: Ticket) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    initialEvent(id: string) { return { id: `source-${id}`, at: t(1), text: '主人原话不进轨迹', source: 'inbox' as const, dedupe: id } },
  }
  const snapshots = new Map<string, SessionEventLike[]>()
  const closed = vi.fn()
  const observeSession = vi.fn(async (id: string) => {
    if (!snapshots.has(id)) throw Error('native observation unavailable')
    return { events: snapshots.get(id)!, [Symbol.dispose]: closed }
  })
  const subscriptions = new Set<(session: { id: string }, event: SessionEventLike) => void>()
  const ctx = { get: () => ({ observeSession }), on(_name: string, listener: (session: { id: string }, event: SessionEventLike) => void) {
    subscriptions.add(listener)
    return () => subscriptions.delete(listener)
  } } as unknown as Pick<HostContext, 'get' | 'on'>
  let now = base + 5_000
  return {
    engine, ctx, observeSession, closed, snapshots, now: () => new Date(now), move: (ms: number) => { now += ms },
    save(row: Ticket) { tickets.set(row.id, row); for (const listener of listeners) listener(row) },
    emit(id: string, event: SessionEventLike) { for (const listener of subscriptions) listener({ id }, event) },
  }
}

function event(type: string, seq: number, time: number, data: unknown): SessionEventLike {
  return { type, seq, time: base + time, data }
}
const descriptor = event('subagent/descriptor', 0, 20, { version: 3, mode: 'continuable', provider: 'spawn' })
const start = event('turn/start', 1, 30, { turn: 1 })
const end = event('turn/end', 9, 390, { turn: 1, reason: { kind: 'completed' } })
const call = (seq: number, ms: number, step = 1) => event('tool/call', seq, ms,
  { turn: 1, step, callId: 'fixture-key', name: 'read', arguments: '{"file_path":"/private/secret.txt","token":"sensitive-arg"}' })
const result = (seq: number, ms: number, options: { step?: number; wrong?: boolean; failed?: boolean } = {}) =>
  event('tool/result', seq, ms, { turn: 1, step: options.step ?? 1,
    message: { toolCallId: 'fixture-key', source: { callId: options.wrong ? 'different-key' : 'fixture-key' }, isError: options.failed,
      content: [{ type: 'text', text: 'sensitive-result' }] } })

describe('SuperHub trace', () => {
  test('binds only proven native history, deduplicates overlapping sources and preserves first observation and explicit causality', async () => {
    const local = ticket('T-0001', [assignment('assignment-main', 'native-main')], {
      inputs: [{ key: 'owner-input', at: t(350), from: 'owner', text: 'sensitive-business-input' }],
    })
    const f = harness(local)
    const dir = mkdtempSync(join(tmpdir(), 'superhub-trace-'))
    const storage = join(dir, 'observations.jsonl')
    try {
      const trace = createSuperhubTrace(f.ctx, f.engine, scope, { storage, now: f.now })
      const input = event('user/message', 2, 40, { source: { kind: 'user' }, content: [{ text: 'sensitive-prompt' }] })
      const model = event('model/selection', 3, 45, { provider: 'host', model: 'chosen' })
      f.emit('native-unrelated', descriptor)
      f.emit('native-unrelated', call(4, 150))
      f.emit('native-main', input)
      f.move(10)
      f.snapshots.set('native-main', [descriptor, start, input, model, call(4, 150), result(5, 145, { failed: true }),
        call(6, 175, 2), result(7, 180, { step: 2, wrong: true }), end])
      const mission = (await trace.mission(local.id))!
      expect(f.closed).toHaveBeenCalledOnce()
      expect(f.observeSession).toHaveBeenCalledWith('native-main', expect.objectContaining({ projectionMode: 'none', signal: expect.any(AbortSignal) }))
      expect(mission.instances[0]).toMatchObject({ actualProvider: 'spawn', configuredExecutor: 'claude-code',
        sessionId: 'native-main', activationId: 'native-main', model: 'host/chosen', coverage: { session: 'complete', tools: 'partial' } })
      const toolCall = mission.timeline.items.find(row => row.native?.seq === 4)!
      expect(mission.timeline.items.find(row => row.native?.seq === 5)).toMatchObject({
        at: t(145), observedAt: t(5_010), state: 'failed', causes: [toolCall.id], native: { pairing: 'confirmed' },
      })
      expect(mission.timeline.items.find(row => row.native?.seq === 5)?.native?.durationMs).toBeUndefined()
      expect(mission.timeline.items.find(row => row.native?.seq === 7)).toMatchObject({ causes: [], native: { pairing: 'unconfirmed' } })
      expect(mission.timeline.items.find(row => row.type === 'user/message')).toMatchObject({
        observedAt: t(5_000), native: { channel: 'live', sourceKind: 'user', ownerAttribution: 'unconfirmed', redacted: true },
      })
      expect(mission.timeline.items.find(row => row.type === 'ticket/input')?.handoff).toEqual({ sent: 'confirmed', delivered: 'unknown', processed: 'unknown' })
      const existingKeys = mission.timeline.items.map(row => row.id).sort()
      f.emit('native-main', result(5, 145, { failed: true }))
      expect((await trace.mission(local.id))?.timeline.items.map(row => row.id).sort()).toEqual(existingKeys)
      trace.dispose()
      const stored = readFileSync(storage, 'utf8')
      expect(stored).not.toMatch(/sensitive|secret\.txt|fixture-key|native-unrelated/)
      const otherScope = createSuperhubTrace(f.ctx, f.engine, 'another-brain', { storage, now: f.now })
      expect(await otherScope.mission(local.id)).toBeUndefined()
      otherScope.dispose()
      f.snapshots.clear()
      const resumed = createSuperhubTrace(f.ctx, f.engine, scope, { storage, now: f.now })
      expect(resumed.recentlyObservedTicketIds(t(5_000), t(5_010))).toEqual([local.id])
      const reloaded = (await resumed.mission(local.id))!
      expect(reloaded.coverage.epoch).not.toEqual(mission.coverage.epoch)
      expect(reloaded.instances[0]?.coverage).toMatchObject({ state: 'cached', lastReadAt: t(5_010) })
      expect(reloaded.timeline.items.map(row => row.id).sort()).toEqual(existingKeys)
      resumed.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('separates verification and delivery validity from observation delays, and replays only past business facts', async () => {
    const file = { path: 'work/T-0001/result.md', version }
    const completed = assignment('assignment-main', 'native-worker', {
      report: { status: 'ready', structured: true, summary: 'internal report' }, deliveries: [file], verifier: 'reviewer',
      verifiedAt: t(500), reviewExecution: native('native-reviewer'),
      verification: { verdict: 'pass', critique: '不公开原分析', status: 'completed', contractVersion: 1,
        criteria: [{ criterionId: 'result', status: 'pass', evidence: [{ kind: 'delivery', ...file }] }] },
    })
    const local = ticket('T-0001', [completed], { ended: { at: t(600), outcome: 'done', note: '完成' } })
    const f = harness(local)
    const dir = mkdtempSync(join(tmpdir(), 'superhub-delivery-'))
    const archives = join(dir, 'ops', 'delivery-versions', local.id)
    mkdirSync(archives, { recursive: true })
    const archive = join(archives, version + '.json')
    writeFileSync(archive, JSON.stringify({ content: artifact }))
    try {
      f.snapshots.set('native-worker', [descriptor, start, end])
      f.snapshots.set('native-reviewer', [call(4, 150)]) // A provider history without the expected descriptor is unconfirmed.
      const trace = createSuperhubTrace(f.ctx, f.engine, scope, { brainRoot: dir, now: f.now })
      const mission = (await trace.mission(local.id, { criterion: 'result' }))!
      expect(mission.verification).toMatchObject({ status: 'completed', verdict: 'pass', historical: false })
      expect(mission.instances.find(row => row.kind === 'verify')?.coverage.state).toBe('unconfirmed')
      expect(mission.timeline.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'assignment/verified' })]))
      const evidenceId = mission.criteria[0]?.evidenceIds[0]!
      expect(await trace.evidence(local.id, evidenceId)).toMatchObject({ availability: 'available', version, path: file.path })
      writeFileSync(archive, JSON.stringify({ content: 'changed' }))
      expect((await trace.evidence(local.id, evidenceId))?.availability).toBe('unreadable')
      rmSync(archive)
      expect((await trace.evidence(local.id, evidenceId))?.availability).toBe('expired')
      const replay = (await trace.mission(local.id, { at: t(200) }))!
      expect(replay).toMatchObject({ mode: 'replay', ticket: { stage: 'working' }, criteria: [{ status: 'unverified', evidenceIds: [] }] })
      expect(replay.verification).toBeUndefined()
      expect(replay.timeline.items.every(row => !row.at || row.at <= t(200))).toBe(true)
      trace.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('keeps a historical configured skip distinct from an unproven review claim (AT-17 and AT-18)', async () => {
    const legacyPass = { verdict: 'pass', critique: '历史记录通过' } as const
    const legacyClaim = { ...legacyPass, independentContext: true }
    const outcome: Ticket['ended'] = { at: t(600), outcome: 'done', note: '历史工单已办结' }
    const skipped = ticket('T-0001', [assignment('legacy-skipped', 'native-skipped', {
      role: { ...staff, verifier: 'none' }, contractVersion: undefined, verifiedAt: t(500), verification: legacyPass,
    })], { superhub: undefined, ended: outcome })
    const unproven = ticket('T-0002', [assignment('legacy-unproven', 'native-unproven', {
      verifier: 'reviewer', contractVersion: undefined, verifiedAt: t(500), verification: legacyClaim,
    })], { superhub: undefined, ended: outcome })
    const f = harness(skipped, unproven)
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { staff: () => [staff], now: f.now })
    try {
      const skippedMission = (await trace.mission(skipped.id))!
      expect(skippedMission).toMatchObject({ ticket: { outcome: 'done' }, verification: { verdict: 'pass', status: 'skipped' },
        criteria: [{ status: 'unverified', evidenceIds: [] }] })
      expect(skippedMission.instances.map(row => row.kind)).toEqual(['execute'])
      expect(skippedMission.timeline.items.find(row => row.type === 'assignment/verified')?.state).toBe('skipped')

      const claimedMission = (await trace.mission(unproven.id))!
      expect(claimedMission).toMatchObject({ ticket: { outcome: 'done' }, verification: { verdict: 'pass', status: 'unverified' },
        criteria: [{ status: 'unverified', evidenceIds: [] }] })
      const review = claimedMission.instances.find(row => row.kind === 'verify')
      expect(review).toMatchObject({ roleId: 'reviewer', status: 'unverified', coverage: { session: 'unconfirmed' } })
      expect(review?.activationId).toBeUndefined()
      expect(review?.sessionId).toBeUndefined()
      expect(claimedMission.timeline.items.find(row => row.type === 'assignment/verified')?.state).toBe('unverified')
    } finally { trace.dispose() }
  })

  test.skipIf(!process.getuid || process.getuid() === 0)('keeps permission-denied, expired, and redacted evidence distinct (AT-39)', async () => {
    const file = { path: 'work/T-0001/result.md', version }
    const local = ticket('T-0001', [assignment('assignment-proof', 'native-proof', { deliveries: [file] })])
    const f = harness(local)
    const dir = mkdtempSync(join(tmpdir(), 'superhub-delivery-permission-'))
    const archives = join(dir, 'ops', 'delivery-versions', local.id)
    mkdirSync(archives, { recursive: true })
    const archive = join(archives, version + '.json')
    writeFileSync(archive, JSON.stringify({ content: artifact }), { mode: 0o600 })
    f.snapshots.set('native-proof', [descriptor, start, call(4, 150), result(5, 200), end])
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { brainRoot: dir, now: f.now })
    try {
      const original = (await trace.mission(local.id))!
      const delivery = original.evidence.find(row => row.kind === 'delivery')!
      const redacted = original.evidence.find(row => row.kind === 'native')!
      expect(delivery).toMatchObject({ availability: 'available', version, path: file.path })
      expect(redacted).toMatchObject({ availability: 'redacted', method: 'dsh-session-event' })
      expect(JSON.stringify(redacted)).not.toMatch(/sensitive|secret\.txt/)

      chmodSync(archive, 0o000)
      expect(() => readFileSync(archive)).toThrow(/EACCES/)
      expect(await trace.evidence(local.id, delivery.id)).toMatchObject({ availability: 'forbidden', version, path: file.path })
      expect((await trace.mission(local.id))?.coverage.dimensions.deliveries).toMatchObject({ state: 'forbidden', count: 1 })

      rmSync(archive)
      expect(await trace.evidence(local.id, delivery.id)).toMatchObject({ availability: 'expired', version, path: file.path })
      expect(await trace.evidence(local.id, redacted.id)).toEqual(redacted)
    } finally {
      trace.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('keeps paged events and same-role concurrent instances isolated when another ticket changes', async () => {
    const first = ticket('T-0001', [assignment('assignment-first', 'native-first', { state: 'running', endedAt: undefined })])
    const second = ticket('T-0002', [assignment('assignment-second', 'native-second', { state: 'running', endedAt: undefined })])
    const f = harness(first, second)
    f.snapshots.set('native-first', [descriptor, start, call(4, 150), result(5, 200)])
    f.snapshots.set('native-second', [descriptor, start, call(4, 200), result(5, 250)])
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { staff: () => [staff, idle], now: f.now })
    const all = trace.roles()
    expect(all.find(row => row.id === staff.id)?.instances.map(row => row.ticketId).sort()).toEqual([first.id, second.id])
    expect(all.find(row => row.id === idle.id)).toMatchObject({ status: 'not-started', instances: [] })
    expect(trace.roles()).toBe(all)

    const full = (await trace.mission(first.id))!
    const event = full.timeline.items[0]!
    expect((await trace.mission(first.id, { event: event.id }))?.timeline.items).toEqual([event])
    const firstPage = (await trace.mission(first.id, { limit: 1 }))!
    expect(firstPage.timeline.items[0]?.id).toBe(full.timeline.items[0]?.id)
    f.move(50)
    f.emit('native-first', call(7, 180, 2))
    const later = (await trace.mission(first.id, { cursor: firstPage.timeline.nextCursor, limit: 100 }))!
    expect(later.timeline.total).toBe(full.timeline.total)
    expect(later.timeline.items.map(row => row.id)).toEqual(full.timeline.items.slice(1).map(row => row.id))
    await expect(trace.mission(second.id, { cursor: firstPage.timeline.nextCursor })).rejects.toThrow('游标')
    const next = ticket('T-0003', [assignment('assignment-third', 'native-third')])
    f.save(next)
    expect(trace.roles().find(row => row.id === staff.id)?.instanceCount).toBe(3)
    expect(f.engine.views).toHaveBeenCalledOnce()
    trace.dispose()
  })

  test('keeps a configured role discoverable before its first dispatch (AT-35)', async () => {
    const queued = ticket('T-0001', [], { staff: idle.id })
    const f = harness(queued)
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { staff: () => [staff, idle], now: f.now })
    const configured = { id: idle.id, name: idle.name, defaultExecutor: idle.executor, status: 'not-started', instanceCount: 0 }
    try {
      expect(trace.roles().find(row => row.id === idle.id)).toMatchObject({ ...configured, instances: [] })
      expect(trace.roleActivity(idle.id)).toMatchObject({ role: configured, items: [], total: 0 })
      const mission = (await trace.mission(queued.id))!
      expect(mission.roles.find(row => row.id === idle.id)).toMatchObject({ ...configured, instances: [] })
      expect(mission.waiting).toMatchObject([{ kind: 'queue', target: idle.id }])
      expect(mission.timeline.items.every(row => row.source === 'business')).toBe(true)
      expect(f.observeSession).not.toHaveBeenCalled()
    } finally { trace.dispose() }
  })

  test('a staff card with id liaison (外务) or chief (研判官) stays a staff role, not the liaison session', () => {
    const outside: Staff = { id: 'liaison', name: '外务', executor: 'remote', verifier: 'reviewer', brief: '工作电脑上的事' }
    const triage: Staff = { id: 'chief', name: '研判官', executor: 'dsh', verifier: 'none', brief: '研判事件' }
    const f = harness(ticket('T-0001', [], { staff: outside.id }))
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { staff: () => [outside, triage, idle], now: f.now })
    try {
      const roles = trace.roles()
      expect(roles.find(row => row.id === 'liaison')).toMatchObject({ name: '外务', defaultExecutor: 'remote' })
      expect(roles.find(row => row.id === 'liaison')!.kinds).not.toContain('liaison')
      expect(roles.find(row => row.id === 'liaison-session')).toMatchObject({ name: '接口人', kinds: ['liaison'] })
      expect(roles.find(row => row.id === 'liaison-session')).not.toHaveProperty('defaultExecutor', 'remote')
      expect(roles.find(row => row.id === 'chief')).toMatchObject({ name: '研判官', kinds: expect.arrayContaining(['triage']) })
    } finally { trace.dispose() }
    // 花名册里没有 id 为 liaison 的幕僚时保持原来的系统角色 id
    const plain = createSuperhubTrace(harness().ctx, harness().engine, scope, { staff: () => [idle], now: f.now })
    try { expect(plain.roles().find(row => row.id === 'liaison')).toMatchObject({ name: '接口人', kinds: ['liaison'] }) } finally { plain.dispose() }
  })

  test('changing role defaults keeps the actual dispatch and original configuration identifiable (AT-48)', async () => {
    const original = assignment('first-assignment', 'native-first', { state: 'running', endedAt: undefined })
    const local = ticket('T-0001', [original])
    const f = harness(local)
    f.snapshots.set('native-first', [descriptor, start, event('model/selection', 2, 40, { provider: 'host', model: 'chosen' })])
    let currentStaff = staff
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { staff: () => [currentStaff], now: f.now })
    try {
      const firstMission = (await trace.mission(local.id))!
      const originalInstance = firstMission.instances[0]!
      expect(originalInstance).toMatchObject({ assignmentId: original.id, contractVersion: contract.version,
        configuredExecutor: staff.executor, configuredModel: staff.model, actualProvider: 'spawn', model: 'host/chosen',
        sessionId: 'native-first', configurationId: expect.any(String) })
      expect(trace.roleActivity(staff.id)).toMatchObject({ role: { defaultExecutor: staff.executor }, total: 1 })

      currentStaff = { ...staff, executor: 'dsh', model: 'configured/replacement' }
      expect(trace.roleActivity(staff.id)).toMatchObject({ role: { defaultExecutor: 'dsh' }, total: 1, items: [
        { id: originalInstance.id, configuredExecutor: staff.executor, actualProvider: 'spawn', configurationId: originalInstance.configurationId },
      ] })
      expect((await trace.mission(local.id))?.instances).toEqual([originalInstance])

      const next = assignment('next-assignment', 'native-next', {
        round: 1, startedAt: t(450), state: 'running', endedAt: undefined, executor: currentStaff.executor,
        role: currentStaff, contractVersion: 2,
      })
      f.save({ ...local, assignments: [{ ...original, state: 'reported', endedAt: t(400) }, next],
        superhub: { ...local.superhub!, contracts: [contract, { ...contract, version: 2, createdAt: t(440) }] } })
      const later = (await trace.mission(local.id))!
      expect(later.instances).toMatchObject([
        { id: originalInstance.id, historical: true, contractVersion: contract.version, configuredExecutor: staff.executor,
          configuredModel: staff.model, actualProvider: 'spawn', model: 'host/chosen', configurationId: originalInstance.configurationId },
        { assignmentId: next.id, historical: false, contractVersion: 2, configuredExecutor: 'dsh', configuredModel: currentStaff.model },
      ])
      expect(later.instances[1]?.configurationId).not.toBe(originalInstance.configurationId)
      expect(later.instances[1]?.id).not.toBe(originalInstance.id)
    } finally { trace.dispose() }
  })

  test('pages activity beyond the role overview and keeps a role cursor scoped to its original window', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ticket(`T-${i + 1}`, [
      assignment(`assignment-${i}`, `session-${i}`, { startedAt: t(15 + Math.min(i, 6)) }),
    ]))
    const f = harness(...rows)
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { staff: () => [staff, idle], now: f.now })
    const expected = trace.roles().find(row => row.id === staff.id)!.instances.map(row => row.id)
    expect(trace.roles(8).find(row => row.id === staff.id)).toMatchObject({ instanceCount: 12, instances: Array(8).fill(expect.any(Object)) })
    expect(trace.roleActivity('missing')).toBeUndefined()
    expect(trace.roleActivity(idle.id)).toMatchObject({ total: 0, items: [] })
    const first = trace.roleActivity(staff.id, { limit: 8 })!
    expect(first).toMatchObject({ scope, asOf: t(5_000), total: 12 })
    expect(first.items.map(row => row.id)).toEqual(expected.slice(0, 8))
    expect(first.nextCursor).toBeDefined()
    expect(() => trace.roleActivity(idle.id, { cursor: first.nextCursor })).toThrow('游标')
    const other = createSuperhubTrace(f.ctx, f.engine, 'other-brain', { staff: () => [staff], now: f.now })
    expect(() => other.roleActivity(staff.id, { cursor: first.nextCursor })).toThrow('游标')
    other.dispose()
    f.move(1_000)
    f.save(ticket('T-13', [assignment('assignment-fresh', 'session-fresh', { startedAt: t(5_500) })]))
    const next = trace.roleActivity(staff.id, { cursor: first.nextCursor, limit: 8 })!
    expect(next).toMatchObject({ asOf: first.asOf, total: 12, nextCursor: undefined })
    expect(next.items.map(row => row.id)).toEqual(expected.slice(8))
    expect(trace.roleActivity(staff.id, { limit: 1 })?.items[0]?.ticketId).toBe('T-13')
    expect(f.engine.views).toHaveBeenCalledTimes(2) // One catalog rebuild per trace scope.
    trace.dispose()
  })

  test('uses actual first observation for the review window while retaining source time and proven scope', async () => {
    const local = ticket('T-1', [assignment('assignment-local', 'native-local')])
    const unconfirmed = ticket('T-2', [assignment('assignment-unconfirmed', 'native-unconfirmed')])
    const foreign = ticket('T-3', [assignment('assignment-foreign', 'native-foreign')], {
      superhub: { brainScope: 'other-brain', sourceId: 'foreign-source', commandId: 'foreign-command', contracts: [contract] },
    })
    const f = harness(local, unconfirmed, foreign)
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { now: f.now })
    f.emit('native-local', descriptor)
    f.emit('native-local', call(4, 170))
    f.emit('native-unconfirmed', call(4, 170))
    f.emit('native-foreign', descriptor)
    f.emit('native-foreign', call(4, 170))
    f.move(500)
    f.emit('native-local', call(5, 180, 2))
    const window = { from: t(4_950), to: t(5_050) }
    expect(trace.recentlyObservedTicketIds(window.from, window.to)).toEqual([local.id])
    expect(() => trace.recentlyObservedTicketIds(window.to, window.from)).toThrow('时间区间')
    expect((await trace.mission(local.id, window))?.timeline.items).toEqual([])
    const observed = (await trace.mission(local.id, { ...window, windowTime: 'either', limit: 1 }))!
    expect(observed.timeline).toMatchObject({
      matched: 2, items: [{ type: 'tool/call', at: t(170), observedAt: t(5_000) }],
    })
    const proof = observed.evidence.find(row => row.id === observed.timeline.items[0]?.evidenceIds[0])
    expect(proof).toMatchObject({ at: t(170), observedAt: t(5_000) })
    expect(observed.timeline.nextCursor).toBeDefined()
    await expect(trace.mission(local.id, { ...window, cursor: observed.timeline.nextCursor })).rejects.toThrow('游标')
    expect((await trace.mission(local.id, { ...window, windowTime: 'either', cursor: observed.timeline.nextCursor }))?.timeline.items[0]?.type)
      .toBe('subagent/descriptor')
    f.save(ticket('T-4', [assignment('assignment-conflict', 'native-local')]))
    expect(trace.recentlyObservedTicketIds(window.from, window.to)).toEqual([])
    trace.dispose()
  })

  test('an exact verification event bounds replay when rework starts in the same millisecond', async () => {
    const file = { path: 'work/T-0001/result.md', version }
    const first = assignment('first-assignment', 'native-first', {
      report: { status: 'ready', structured: true, summary: 'first report' }, deliveries: [file], verifier: 'reviewer',
      verifiedAt: t(500), reviewExecution: native('first-reviewer'),
      verification: { verdict: 'revise', critique: 'first review', status: 'completed', contractVersion: 1,
        criteria: [{ criterionId: 'result', status: 'fail', evidence: [{ kind: 'delivery', ...file }] }] },
    })
    const next = assignment('second-assignment', 'native-next', { round: 1, startedAt: t(500), state: 'running', endedAt: undefined })
    const row = ticket('T-0001', [first, next], {
      inputs: [{ key: `verification:${first.id}`, at: t(500), text: 'first review', from: 'verifier', replyTo: first.id, consumedBy: next.id }],
    })
    const f = harness(row)
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { now: f.now })
    const live = (await trace.mission(row.id, { type: 'assignment/verified' }))!
    const event = live.timeline.items[0]!
    const inclusive = (await trace.mission(row.id, { at: first.verifiedAt }))!
    expect(inclusive.assignmentId).toBe(next.id)
    expect(inclusive.criteria[0]?.status).toBe('unverified')
    const exact = (await trace.mission(row.id, { at: first.verifiedAt, event: event.id }))!
    expect(exact).toMatchObject({ mode: 'replay', assignmentId: first.id, criteria: [{ status: 'fail' }] })
    expect(exact.instances.every(instance => instance.assignmentId === first.id)).toBe(true)
    expect(exact.timeline.items.map(row => row.id)).toEqual([event.id])
    trace.dispose()
  })

  test('preserves bridge receipt and child waiting facts with remote tool coverage unavailable', async () => {
    const task = assignment('remote-assignment', 'unused-remote', { staff: 'field', executor: 'remote', execution: undefined, state: 'running', endedAt: undefined })
    const parent = ticket('T-0001', [task], { waitingFor: ['T-0002'] })
    const child = ticket('T-0002', [], { parent: { ticketId: parent.id, assignmentId: task.id, key: 'child', criterion: 0 } })
    const f = harness(parent, child)
    const dir = mkdtempSync(join(tmpdir(), 'superhub-bridge-'))
    const receipts = join(dir, 'ops', 'remote', 'receipts')
    mkdirSync(receipts, { recursive: true })
    const hash = 'a'.repeat(64)
    writeFileSync(join(receipts, task.id + '.json'), JSON.stringify({
      ticketId: parent.id, assignmentId: task.id, at: t(450), hash, report: 'sensitive-bridge-report',
    }))
    try {
      const trace = createSuperhubTrace(f.ctx, f.engine, scope, { brainRoot: dir, now: f.now })
      const mission = (await trace.mission(parent.id))!
      expect(mission.waiting).toMatchObject([{ kind: 'child', target: child.id, since: child.createdAt }])
      const opened = mission.timeline.items.find(row => row.ticketId === child.id && row.type === 'ticket/opened')
      const dispatch = mission.timeline.items.find(row => row.ticketId === parent.id && row.type === 'assignment/dispatched')
      expect(opened?.causes).toContain(dispatch?.id)
      expect(mission.instances[0]?.coverage).toMatchObject({ session: 'unsupported', tools: 'unsupported' })
      expect(mission.timeline.items.find(row => row.type === 'remote/receipt')).toMatchObject({ state: 'received', handoff: { delivered: 'confirmed', processed: 'unknown' } })
      expect(mission.evidence).toEqual([expect.objectContaining({ kind: 'receipt', version: hash })])
      expect(JSON.stringify(mission)).not.toContain('sensitive-bridge-report')
      expect(f.observeSession).not.toHaveBeenCalled()
      trace.dispose()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('preserves per-instance termination facts for a stopped parent and its children (AT-31)', async () => {
    const stopped: Ticket['ended'] = { at: t(600), outcome: 'stopped', note: '主人请求停止' }
    const parentRun = assignment('parent-assignment', 'native-parent', { state: 'cancelled', endedAt: t(600) })
    const parent = ticket('T-0001', [parentRun], { ended: stopped, waitingFor: ['T-0002', 'T-0003'] })
    const local = ticket('T-0002', [assignment('local-assignment', 'native-local', {
      state: 'cancelled', endedAt: t(600),
      attempts: [
        { kind: 'execute', number: 1, status: 'interrupted', startedAt: t(10), endedAt: t(300), execution: native('native-local') },
        { kind: 'execute', number: 2, status: 'running', startedAt: t(420), execution: native('native-local-late') },
      ],
    })], { ended: stopped, parent: { ticketId: parent.id, assignmentId: parentRun.id, key: 'local', criterion: 0 } })
    const remote = ticket('T-0003', [assignment('remote-assignment', 'unused-remote', {
      state: 'cancelled', endedAt: t(600), staff: 'field', executor: 'remote', role: undefined, execution: undefined,
    })], { ended: stopped, parent: { ticketId: parent.id, assignmentId: parentRun.id, key: 'remote', criterion: 0 } })
    const f = harness(parent, local, remote)
    const aborted = (at: number) => event('turn/end', 9, at, { turn: 1, reason: { kind: 'aborted' } })
    f.snapshots.set('native-parent', [descriptor, start, aborted(605)])
    f.snapshots.set('native-local', [descriptor, start, aborted(290)])
    f.snapshots.set('native-local-late', [{ ...descriptor, time: base + 425 }, { ...start, time: base + 430 }])
    const trace = createSuperhubTrace(f.ctx, f.engine, scope, { now: f.now })
    try {
      const mission = (await trace.mission(parent.id))!
      expect(mission).toMatchObject({ ticket: { outcome: 'stopped' }, waiting: [], relatedTickets: [
        { id: local.id, outcome: 'stopped' }, { id: remote.id, outcome: 'stopped' },
      ] })
      expect(mission.instances.map(({ ticketId, attempt, termination, coverage }) => ({ ticketId, attempt, termination, session: coverage.session }))).toEqual([
        { ticketId: parent.id, attempt: 1, termination: 'confirmed', session: 'complete' },
        { ticketId: local.id, attempt: 1, termination: 'confirmed', session: 'complete' },
        { ticketId: local.id, attempt: 2, termination: 'unconfirmed', session: 'complete' },
        { ticketId: remote.id, attempt: 1, termination: 'unconfirmed', session: 'unsupported' },
      ])
      expect(mission.timeline.items.filter(row => row.type === 'turn/end' && row.state === 'aborted').map(row => row.ticketId).sort())
        .toEqual([parent.id, local.id])

      const ongoing = mission.instances.find(row => row.ticketId === local.id && row.attempt === 2)!
      expect(ongoing).toMatchObject({ status: 'stop-requested', termination: 'unconfirmed', sessionId: 'native-local-late' })
      f.move(50)
      f.emit('native-local-late', aborted(615))
      const after = (await trace.mission(parent.id))!
      expect(after.ticket.outcome).toBe('stopped')
      expect(after.instances.find(row => row.id === ongoing.id)).toMatchObject({ status: 'stop-requested', termination: 'confirmed' })
      expect(after.instances.find(row => row.ticketId === remote.id)?.termination).toBe('unconfirmed')
    } finally { trace.dispose() }
  })
})

test('installs scoped review restrictions before spawn resumes work and keeps structured output', async () => {
  const restrict = vi.fn(() => vi.fn())
  let created: (event: { agent: Agent }) => void
  let executors: DshExecutors
  const ctx = {
    get: () => undefined, logger: { warn: vi.fn() }, on: (_event: string, listener: typeof created) => { created = listener; return vi.fn() },
    sessionController: { resolveAgent: vi.fn(async () => ({ error: { code: 'missing' } })) },
    subagents: {
      getProvider: () => ({ capabilities: { outputSchema: true, agentOptions: true } }),
      startActivation: async (spec: { childId?: string }) => {
        const childId = spec.childId!
        expect(executors.readOnly(childId)).toBe(true)
        created({ agent: { id: childId, session: { snapshotEvents: () => [] }, ctx: { tools: { restrict } } } })
        expect(restrict).toHaveBeenCalledWith({ allow: ['read', 'glob', 'grep', 'chief_lookup', 'chief_brief', 'chief_ticket'] })
        return { childId, result: Promise.resolve({ output: [], structured: { verdict: 'pass' }, stopReason: 'completed' }), dispose: async () => {} }
      },
    },
  } as unknown as HostContext
  const onStarted = vi.fn(async () => {})
  executors = new DshExecutors(ctx, async () => ({ id: 'parent' }))
  const observation = executors.observeExecution = vi.fn()
  const outcome = await executors.run({ staff: { ...staff, executor: 'dsh' }, label: '核验', cwd: '/tmp', prompt: 'independent input',
    schema: { type: 'object' }, readOnly: true, onStarted }, new AbortController().signal)
  expect(outcome.structured).toEqual({ verdict: 'pass' })
  expect(onStarted).toHaveBeenCalledOnce()
  expect(observation).toHaveBeenCalledWith(expect.objectContaining({ provider: 'spawn', sessionId: expect.any(String) }))
  expect(ctx.sessionController.resolveAgent).not.toHaveBeenCalled()
})
