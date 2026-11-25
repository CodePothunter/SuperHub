import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Engine, type Brain, type CommissionSpec, type EngineOptions, type RunRequest, type RunResult } from '../src/core/engine.ts'
import { threadIdOf, type Staff, type Ticket } from '../src/core/model.ts'
import { FileStore } from '../src/core/store.ts'

const scope = 'test-brain'
const delivery = { path: 'work/T-0001/proof.md', version: 'original-hash' }
const staff: Staff[] = [
  { id: 'researcher', name: '研究员', executor: 'dsh', verifier: 'reviewer', brief: '调研' },
  { id: 'reviewer', name: '审查官', executor: 'dsh', verifier: 'none', brief: '核验' },
]
const commission: CommissionSpec = {
  text: '整理发现并保存原始依据', title: '整理发现', staff: 'researcher', level: 'think',
  scope: '按已有资料整理发现', doneWhen: ['保存可核对的依据'], needsReview: true, requestKey: 'request-1',
  superhub: { brainScope: scope, sourceId: 'source-1', commandId: 'command-1', allowed: ['read', 'deliver'], denied: ['publish'] },
}
const ready: RunResult = { text: '', stopReason: 'completed', structured: { status: 'ready', summary: '已整理', outputs: [delivery.path] } }
const verification = (criteria: unknown[]): RunResult =>
  ({ text: '', stopReason: 'completed', structured: { critique: '独立核验', criteria } })
const passing = { criterionId: 'C-01', status: 'pass', evidence: [delivery], comment: '原始依据可核对' }

function harness(
  run: (req: RunRequest, signal: AbortSignal) => RunResult | Promise<RunResult> = req => req.staff.id === 'reviewer' ? verification([passing]) : ready,
  options?: Pick<EngineOptions, 'canStartSuperhub' | 'checkSuperhubAcceptance' | 'timeouts'>,
  original?: string,
) {
  const root = original ?? mkdtempSync(join(tmpdir(), 'chief-contract-'))
  const store = new FileStore(root)
  const calls: RunRequest[] = []
  const roles = [...staff]
  const proofs = new Map([[delivery.path, { ...delivery, content: 'Captured, hash-checked test evidence' }]])
  const brain: Brain = {
    root, constitution: () => '', staff: () => roles, workspaces: () => [],
    workdir: id => join(root, 'work', id), appendNote: path => path, commit: () => {},
    snapshotOutputs: (_id, outputs) => [...proofs.values()].filter(proof => outputs.includes(proof.path))
      .map(({ path, version }) => ({ path, version })),
    deliveryEvidence: (_id, ref) => {
      const proof = proofs.get(ref.path)
      return proof?.version === ref.version ? proof.content : undefined
    },
  }
  const engine = new Engine(store, brain, {
    available: () => true, supportsSchema: () => true,
    run: async (request, signal) => {
      calls.push(request)
      await request.onStarted?.({ provider: 'spawn', activationId: `activation-${calls.length}`, sessionId: `session-${calls.length}` })
      return run(request, signal)
    },
  }, { dispatch: () => { throw Error('unexpected remote dispatch') }, cancel: () => {} },
  { concurrency: 2, timeZone: 'Asia/Shanghai', brainScope: scope, ...options })
  const ticket = () => store.tickets()[0]!
  const settle = async () => { for (let i = 0; i < 45; i++) await new Promise(resolve => setImmediate(resolve)) }
  return { engine, store, calls, roles, ticket, settle, root, proofs, removeProof: () => { proofs.delete(delivery.path) } }
}

const target = (ticket: Ticket) => ({
  brainScope: scope, threadId: threadIdOf(ticket), replyTo: ticket.assignments.at(-1)?.id ?? null,
  contractVersion: ticket.superhub?.contracts.at(-1)?.version,
})

describe('per-brain ticket numbers', () => {
  it('migrates legacy snapshot IDs, including damaged snapshots, before clearing all history', async () => {
    const original = harness()
    original.engine.setPaused(true)
    const first = await original.engine.commission(commission)
    const ops = join(original.root, 'ops')
    const sequence = join(ops, 'ticket-sequence.json')
    original.store.saveTicket({ ...original.ticket(), id: 'T-0089' })
    expect(readFileSync(sequence, 'utf8')).toBe('89\n')
    original.engine.stop()

    rmSync(sequence)
    writeFileSync(join(ops, 'tickets', 'T-0090.json'), '{"id":')
    const receipt = readFileSync(join(ops, 'dispositions.jsonl'), 'utf8')
    const migrated = new FileStore(original.root)
    expect(migrated.tickets().map(t => t.id).sort()).toEqual([first, 'T-0089'])
    expect(readFileSync(join(ops, 'dispositions.jsonl'), 'utf8')).toBe(receipt)
    expect(readFileSync(sequence, 'utf8')).toBe('90\n')

    for (const path of ['events', 'dispositions.jsonl', 'tickets']) rmSync(join(ops, path), { recursive: true })
    const cleared = new FileStore(original.root)
    expect(cleared.ticket(first)).toBeUndefined()
    expect(cleared.nextTicketId()).toBe('T-0091')
    expect(cleared.tickets()).toEqual([])
    expect(cleared.recentEvents(10)).toEqual([])
    expect(existsSync(join(ops, 'dispositions.jsonl'))).toBe(false)
    expect(new FileStore(original.root).nextTicketId()).toBe('T-0092')
  })

  it('reserves a number in a legacy receipt even if its disposition later changed', () => {
    const root = mkdtempSync(join(tmpdir(), 'chief-ticket-receipt-'))
    const original = new FileStore(root)
    original.setDisposition('old-event', { kind: 'accepted', ticketId: 'T-0416' })
    original.setDisposition('old-event', { kind: 'ignored', reason: 'closed' })
    const reopened = new FileStore(root)
    expect(reopened.disposition('old-event')).toEqual({ kind: 'ignored', reason: 'closed' })
    expect(reopened.tickets()).toEqual([])
    expect(reopened.nextTicketId()).toBe('T-0417')
  })

  it('honors an offline seed and never issues a number from a damaged or exhausted sequence', () => {
    const root = mkdtempSync(join(tmpdir(), 'chief-ticket-seed-'))
    const store = new FileStore(root)
    const sequence = join(root, 'ops', 'ticket-sequence.json')
    writeFileSync(sequence, '12345\n')
    expect(store.nextTicketId()).toBe('T-12346')
    const reopened = new FileStore(root)
    expect(reopened.nextTicketId()).toBe('T-12347')
    expect(store.nextTicketId()).toBe('T-12348')
    writeFileSync(sequence, 'missing')
    expect(() => new FileStore(root)).toThrow('工单编号记录无效')
    expect(() => store.nextTicketId()).toThrow('工单编号记录无效')
    writeFileSync(sequence, String(Number.MAX_SAFE_INTEGER))
    expect(() => store.nextTicketId()).toThrow('工单编号超出安全整数范围')
    expect(store.tickets()).toEqual([])
  })
})

describe('SuperHub commission and contract', () => {
  it('restores an event written before the ticket and replays the same command exactly once', async () => {
    const original = harness()
    original.store.saveTicket = () => { throw Error('simulated interruption before the ticket write') }
    await expect(original.engine.commission(commission)).rejects.toThrow('simulated interruption')
    original.engine.stop()
    const reopened = harness(undefined, undefined, original.root)
    reopened.engine.setPaused(true)
    await reopened.engine.recover()
    const id = reopened.ticket().id
    await expect(reopened.engine.commission(commission)).resolves.toBe(id)
    await expect(reopened.engine.commission({ ...commission, scope: '扩大范围' })).rejects.toMatchObject({ status: 409 })
    await expect(reopened.engine.commission({ ...commission, superhub: { ...commission.superhub!, sourceId: 'different' } })).rejects.toMatchObject({ status: 409 })
    await expect(reopened.engine.commission({ ...commission, superhub: { ...commission.superhub!, commandId: 'different' } })).rejects.toMatchObject({ status: 409 })
    await expect(reopened.engine.commission({ ...commission, superhub: { ...commission.superhub!, brainScope: 'different' } })).rejects.toMatchObject({ status: 409 })
    expect(reopened.store.tickets()).toHaveLength(1)
    expect(reopened.store.pendingEvents()).toEqual([])
    expect(reopened.ticket().superhub).toMatchObject({
      brainScope: scope, sourceId: 'source-1', commandId: 'command-1',
      contracts: [{ version: 1, criteria: [{ id: 'C-01', text: '保存可核对的依据', required: true, method: 'delivery' }] }],
    })
  })

  it('recovers after a partial JSONL row without losing the next commission event', async () => {
    const original = harness()
    await original.engine.commission(commission)
    original.engine.stop()
    const month = original.store.recentEvents(1)[0]!.at.slice(0, 7)
    appendFileSync(join(original.root, 'ops', 'events', `${month}.jsonl`), '{"id":"partial')
    const reopened = harness(undefined, undefined, original.root)
    reopened.engine.setPaused(true)
    const next = { ...commission, requestKey: 'request-2', superhub: { ...commission.superhub!, commandId: 'command-2' } }
    const id = await reopened.engine.commission(next)
    const restarted = harness(undefined, undefined, original.root)
    restarted.engine.setPaused(true)
    await expect(restarted.engine.commission(next)).resolves.toBe(id)
    expect(restarted.store.recentEvents(10)).toHaveLength(2)
  })

  it('binds exact evidence and a distinct reviewer activation before scoped acceptance', async () => {
    const t = harness()
    const id = await t.engine.commission(commission)
    await t.settle()
    const assignment = t.ticket().assignments[0]!
    expect(t.calls[0]!.prompt).toContain('验收契约 v1')
    expect(t.calls[1]).toMatchObject({ readOnly: true })
    expect(t.calls[1]!.prompt).toContain('Captured, hash-checked test evidence')
    expect(assignment.verification).toMatchObject({
      status: 'completed', verdict: 'pass', contractVersion: 1,
      reviewer: { activationId: 'activation-2' },
      criteria: [{ criterionId: 'C-01', status: 'pass', evidence: [{ kind: 'delivery', ...delivery }] }],
    })
    expect(assignment.attempts).toMatchObject([
      { kind: 'execute', number: 1, status: 'completed', execution: { activationId: 'activation-1' } },
      { kind: 'verify', number: 1, status: 'completed', execution: { activationId: 'activation-2' } },
    ])
    expect(t.engine.views()[0]!.stage).toBe('you/review')
    await expect(t.engine.accept(id)).rejects.toMatchObject({ status: 409 })
    await expect(t.engine.accept(id, false, { ...target(t.ticket()), brainScope: 'wrong-brain' })).rejects.toMatchObject({ status: 409 })
    await t.engine.accept(id, false, target(t.ticket()))
    expect(t.ticket().superhub?.ownerAcceptance).toMatchObject({ kind: 'accepted', contractVersion: 1, assignmentId: assignment.id })
  })

  it('expands omitted criteria and preserves an explicit deviation without claiming a pass', async () => {
    const t = harness(req => req.staff.id === 'reviewer'
      ? verification([{ ...passing, evidence: [{ ...delivery, version: 'fabricated' }] }]) : ready)
    const id = await t.engine.commission({ ...commission, doneWhen: ['保存证据', '报告当前限制'] })
    await t.settle()
    const assignment = t.ticket().assignments.at(-1)!
    expect(t.ticket().assignments).toHaveLength(3)
    expect(assignment.verification).toMatchObject({ verdict: 'revise', criteria: [
      { criterionId: 'C-01', status: 'unverified', evidence: [] }, { criterionId: 'C-02', status: 'unverified', evidence: [] },
    ] })
    await expect(t.engine.accept(id, false, target(t.ticket()))).rejects.toMatchObject({ status: 409 })
    await t.engine.accept(id, false, { ...target(t.ticket()), deviationReason: '暂以记录供参考，待另行补证' })
    expect(t.ticket().ended?.outcome).toBe('done')
    expect(t.ticket().superhub?.ownerAcceptance).toMatchObject({ kind: 'deviation', reason: '暂以记录供参考，待另行补证' })
    expect(assignment.verification?.verdict).toBe('revise')
  })

  it.each([[passing, passing], [{ ...passing, criterionId: 'unknown' }]])('rejects duplicate or foreign criterion IDs: %j', async (...criteria) => {
    const t = harness(req => req.staff.id === 'reviewer' ? verification(criteria) : ready)
    await t.engine.commission({ ...commission, needsReview: false })
    await t.settle()
    expect(t.ticket().assignments).toHaveLength(1)
    expect(t.ticket().assignments[0]!.verification).toMatchObject({
      status: 'failed', verdict: 'revise', criteria: [{ criterionId: 'C-01', status: 'unverified' }],
    })
    expect(t.ticket().ended).toBeUndefined()
  })

  it('records trusted native receipt evidence and does not use model-supplied receipts', async () => {
    const record = { id: 'native-check', version: 'result-v1', method: 'host-check', at: new Date().toISOString() }
    const t = harness(req => req.staff.id === 'reviewer'
      ? verification([{ ...passing, evidence: [record] }]) : { ...ready, evidence: [record] })
    await t.engine.commission({ ...commission, needsReview: false, superhub: { ...commission.superhub!, criteria: [{ text: '检查原生结果', method: 'native' }] } })
    await t.settle()
    expect(t.ticket().ended?.outcome).toBe('done')
    expect(t.ticket().assignments[0]!.verification?.criteria?.[0]?.evidence).toEqual([{ kind: 'native', ...record }])
    const untrusted = harness(req => req.staff.id === 'reviewer' ? verification([{ ...passing, evidence: [record] }]) : ready)
    await untrusted.engine.commission({ ...commission, needsReview: false, superhub: { ...commission.superhub!, criteria: [{ text: '检查原生结果', method: 'native' }] } })
    await untrusted.settle()
    expect(untrusted.ticket().ended).toBeUndefined()
  })

  it('records an evidence-backed failure and rechecks the next assignment on the same contract', async () => {
    let reviews = 0
    const t = harness(req => req.staff.id === 'reviewer'
      ? verification([++reviews === 1 ? { ...passing, status: 'fail' } : passing]) : ready)
    await t.engine.commission({ ...commission, needsReview: false })
    await t.settle()
    const [first, second] = t.ticket().assignments
    expect(first).toMatchObject({ contractVersion: 1, round: 0, verification: {
      verdict: 'revise', criteria: [{ status: 'fail', evidence: [{ kind: 'delivery', ...delivery }] }],
    } })
    expect(second).toMatchObject({ contractVersion: 1, round: 1, verification: { verdict: 'pass' } })
    expect(t.ticket().inputs).toMatchObject([{ from: 'verifier', replyTo: first!.id, consumedBy: second!.id }])
    expect(t.ticket().ended?.outcome).toBe('done')
  })

  it('keeps a passing type check separate from a failing mobile scene in the acceptance contract', async () => {
    const typeCheck = { path: 'work/T-0001/typecheck.txt', version: 'typecheck-v1' }
    const mobile = { path: 'work/T-0001/mobile.txt', version: 'mobile-v1' }
    const t = harness(req => req.staff.id === 'reviewer'
      ? verification([
        { criterionId: 'C-01', status: 'pass', evidence: [typeCheck], comment: '类型检查成功' },
        { criterionId: 'C-02', status: 'fail', evidence: [mobile], comment: '390px 视口出现横向滚动' },
      ])
      : { ...ready, structured: { status: 'ready', summary: '已提供两项检查的记录', outputs: [typeCheck.path, mobile.path] } })
    t.proofs.set(typeCheck.path, { ...typeCheck, content: 'tsc --noEmit: exit 0' })
    t.proofs.set(mobile.path, { ...mobile, content: 'viewportWidth=390 scrollWidth=480' })
    const id = await t.engine.commission({ ...commission, doneWhen: ['类型检查通过', '390px 视口无横向溢出'], needsReview: false })
    await t.settle()
    const review = t.ticket().assignments.at(-1)?.verification
    expect(t.calls.find(call => call.staff.id === 'reviewer')?.prompt).toContain('viewportWidth=390 scrollWidth=480')
    expect(review).toMatchObject({ status: 'completed', verdict: 'revise', criteria: [
      { criterionId: 'C-01', status: 'pass', evidence: [{ kind: 'delivery', ...typeCheck }] },
      { criterionId: 'C-02', status: 'fail', evidence: [{ kind: 'delivery', ...mobile }] },
    ] })
    await expect(t.engine.accept(id, false, target(t.ticket()))).rejects.toMatchObject({ status: 409 })
    expect(t.ticket().ended).toBeUndefined()
    expect(t.ticket().superhub?.ownerAcceptance).toBeUndefined()
  })

  it.each(['throw', 'timeout'] as const)('hands review service %s to the owner with an unverified criterion', async failure => {
    const t = harness((req, signal) => {
      if (req.staff.id !== 'reviewer') return ready
      if (failure === 'throw') throw Error('review service connection lost')
      return new Promise<RunResult>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }, failure === 'timeout' ? { timeouts: { verify: 100 } } : undefined)
    const id = await t.engine.commission({ ...commission, needsReview: false })
    await expect.poll(() => t.engine.views()[0]!.stage, { timeout: 2_000 }).toBe('you/review')
    expect(t.ticket().assignments).toHaveLength(1)
    expect(t.ticket().assignments[0]).toMatchObject({
      report: { status: 'ready' },
      handedToOwner: true,
      verification: { status: 'failed', verdict: 'revise', criteria: [{ criterionId: 'C-01', status: 'unverified', evidence: [] }] },
      attempts: [{ kind: 'execute', status: 'completed' }, { kind: 'verify', status: failure === 'timeout' ? 'interrupted' : 'failed' }],
    })
    expect(t.ticket().inputs).toEqual([])
    expect(t.ticket().ended).toBeUndefined()
    await expect(t.engine.accept(id, false, target(t.ticket()))).rejects.toMatchObject({ status: 409 })
  })

  it('waits for a scoped owner reply received during verification to be consumed before completion', async () => {
    let finishFirstReview!: (result: RunResult) => void
    let reviews = 0
    const t = harness(req => {
      if (req.staff.id !== 'reviewer') return ready
      if (++reviews > 1) return verification([passing])
      return new Promise<RunResult>(resolve => { finishFirstReview = resolve })
    })
    const id = await t.engine.commission({ ...commission, needsReview: false })
    await t.settle()
    expect(t.engine.views()[0]!.stage).toBe('verifying')
    const first = t.ticket().assignments[0]!
    const text = '请把刚收到的第二份资料并入依据'
    t.engine.setPaused(true)
    await t.engine.reply(id, text, {
      ...target(t.ticket()), ticketId: id, requestId: 'owner-followup', executionBoundary: 'local',
    })
    finishFirstReview(verification([passing]))
    await t.settle()
    expect(t.ticket().assignments).toHaveLength(1)
    expect(first.verification).toBeUndefined()
    expect(first.staleResults).toMatchObject([{ kind: 'review', contractVersion: 1, stopReason: 'completed' }])
    expect(t.ticket().inputs[0]).toMatchObject({ from: 'owner', text, replyTo: first.id, contractVersion: 1 })
    expect(t.ticket().inputs[0]?.consumedBy).toBeUndefined()
    expect(t.ticket().ended).toBeUndefined()
    expect(t.engine.views()[0]!.stage).toBe('queued')
    await expect(t.engine.accept(id, false, { ...target(t.ticket()), stage: 'you/review' })).rejects.toMatchObject({ status: 409 })

    t.engine.setPaused(false)
    await t.settle()
    const second = t.ticket().assignments[1]!
    expect(t.ticket().inputs[0]?.consumedBy).toBe(second.id)
    expect(t.calls.filter(call => call.staff.id === 'researcher')[1]?.prompt).toContain(text)
    expect(second.verification).toMatchObject({ status: 'completed', verdict: 'pass' })
    expect(t.ticket().ended?.outcome).toBe('done')
  })

  it('keeps a scoped dependency linked to the criterion ID and blocks its parent from completion', async () => {
    let delegated: string | undefined
    const t = harness(async req => {
      if (req.staff.id === 'reviewer') return verification([passing])
      if (req.staff.id === 'helper') return { text: '', stopReason: 'completed', structured: { status: 'blocked', summary: '证据不可读' } }
      if (!delegated) delegated = await t.engine.delegate(req.binding!, { staff: 'helper', key: 'dependency', criterion: 0, text: '核对来源' })
      return ready
    })
    t.roles.push({ ...staff[0]!, id: 'helper', name: '助手' })
    await t.engine.commission({ ...commission, needsReview: false, superhub: { ...commission.superhub!, allowed: ['read', 'deliver', 'delegate'] } })
    await t.settle()
    const child = t.store.ticket(delegated!)!
    expect(child.parent).toMatchObject({ criterionId: 'C-01', contractVersion: 1 })
    expect(t.engine.views()[0]!.stage).toBe('waiting')
    await t.engine.stopTicket(child.id, '停止受阻子任务', target(child))
    await t.settle()
    expect(t.ticket().assignments.at(-1)?.verification?.verdict).toBe('pass')
    expect(t.ticket().ended).toBeUndefined()
  })

  it('requires an owner to retry an activated attempt when its side effects are unknown', async () => {
    const t = harness(() => ({ text: '', stopReason: 'error', diagnostic: 'service returned 429' }))
    await t.engine.commission(commission)
    await t.settle()
    expect(t.calls).toHaveLength(1)
    expect(t.ticket().assignments[0]).toMatchObject({ report: { status: 'failed' }, attempts: [{ number: 1, status: 'failed' }] })
    expect(t.engine.views()[0]!.stage).toBe('you/blocked')
  })

  it('invalidates a changed artifact and preserves the original contract and assignment', async () => {
    const t = harness()
    const id = await t.engine.commission(commission)
    await t.settle()
    const first = t.ticket().assignments[0]!
    const old = target(t.ticket())
    t.removeProof()
    await expect(t.engine.accept(id, false, old)).rejects.toMatchObject({ status: 409 })
    expect(first.verificationInvalidated?.reason).toContain('产物版本')
    t.engine.setPaused(true)
    await t.engine.reviseContract(id, [{ id: 'C-01', text: '保存可核对的依据及来源' }], '说明来源要求', old)
    await expect(t.engine.stopTicket(id, '旧请求', old)).rejects.toMatchObject({ status: 409 })
    expect(t.ticket().superhub?.contracts).toMatchObject([
      { version: 1, criteria: [{ text: '保存可核对的依据' }] },
      { version: 2, reason: '说明来源要求', criteria: [{ id: 'C-01', text: '保存可核对的依据及来源' }] },
    ])
    expect(first).toMatchObject({ contractVersion: 1, verification: { verdict: 'pass', contractVersion: 1 } })
    t.engine.setPaused(false)
    await t.settle()
    expect(t.ticket().assignments.at(-1)?.contractVersion).toBe(2)
  })

  it('requires a current scope-specific proof for normal owner acceptance', async () => {
    const t = harness(undefined, { checkSuperhubAcceptance: () => '构建输入已改变' })
    const id = await t.engine.commission(commission)
    await t.settle()
    const ownerTarget = target(t.ticket())
    await expect(t.engine.accept(id, false, ownerTarget)).rejects.toThrow('构建输入已改变')
    expect(t.ticket().ended).toBeUndefined()
    expect(t.ticket().assignments[0]!.verificationInvalidated?.reason).toBe('构建输入已改变')
    await t.engine.accept(id, false, { ...ownerTarget, deviationReason: '仅确认已查看交付' })
    expect(t.ticket().superhub?.ownerAcceptance?.kind).toBe('deviation')
  })

  it('retains a late result after stop without accepting it for the stopped assignment', async () => {
    let finish!: (result: RunResult) => void
    let reviewerSignal: AbortSignal | undefined
    const t = harness((req, signal) => {
      if (req.staff.id !== 'reviewer') return ready
      reviewerSignal = signal
      return new Promise(resolve => { finish = resolve })
    })
    const id = await t.engine.commission(commission)
    await t.settle()
    expect(t.engine.views()[0]!.stage).toBe('verifying')
    await t.engine.stopTicket(id, '撤销授权', target(t.ticket()))
    expect(reviewerSignal?.aborted).toBe(true)
    finish(verification([passing]))
    await t.settle()
    expect(t.ticket().ended?.outcome).toBe('stopped')
    expect(t.ticket().assignments).toHaveLength(1)
    expect(t.ticket().assignments[0]!.verification).toBeUndefined()
    expect(t.ticket().assignments[0]!.staleResults).toMatchObject([{ kind: 'review', contractVersion: 1 }])
  })

  it('freezes a withdrawn command before execution and leaves legacy skip verdicts readable', async () => {
    const frozen = harness(undefined, { canStartSuperhub: () => false })
    const id = await frozen.engine.commission(commission)
    await frozen.settle()
    expect(frozen.calls).toEqual([])
    await frozen.engine.stopTicket(id, '撤销授权', target(frozen.ticket()))
    const legacy = harness()
    legacy.roles[0] = { ...staff[0]!, verifier: 'none' }
    await legacy.engine.commission({ ...commission, superhub: undefined, needsReview: false })
    await legacy.settle()
    expect(legacy.ticket().ended?.outcome).toBe('done')
    expect(legacy.ticket().assignments[0]!.verification).toEqual({ verdict: 'pass', critique: '该幕僚不需要核验。' })
    const scoped = harness()
    scoped.roles[0] = { ...staff[0]!, verifier: 'none' }
    await scoped.engine.commission({ ...commission, needsReview: false })
    await scoped.settle()
    expect(scoped.ticket().ended).toBeUndefined()
    expect(scoped.ticket().assignments[0]!.verification).toMatchObject({ status: 'skipped', verdict: 'revise' })
  })
})
