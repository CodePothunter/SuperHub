/** Run the packaged SuperHub through a disposable real DSH host. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { archiveWork, artifact, liaisonWork, lines, localMarker, nativeMemoMarker, remoteMarker, remoteStaff, remoteSummary, teach } from './superhub-vertical-probe.mjs'

const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE
const model = process.env.CHIEF_SUPERHUB_MODEL
const reportFile = process.env.CHIEF_SUPERHUB_VERTICAL_EVIDENCE
const hash = value => createHash('sha256').update(value).digest('hex')
const proof = {
  checkedAt: new Date().toISOString(),
  hostMode: model ? 'configured model provider on isolated DSH host' : 'scripted model responses on isolated DSH host',
}

let host
let scope
let checkpoint = 'isolated host startup'
const get = (path, params = {}) => host.api(`/superhub/${path}?${new URLSearchParams({ scope, ...params })}`)
const post = (path, body) => host.api(`/superhub/${path}`, { scope, ...body })
const detail = id => host.api(`/tickets/${id}`)
const mission = (id, params = {}) => get(`mission/${id}`, { limit: '100', ...params })
const readProof = (ticketId, id) => get(`evidence/${ticketId}/${encodeURIComponent(id)}`)
const conflict = promise => assert.rejects(promise, { status: 409 })

function bridge(action, id, input) {
  const env = { ...process.env, DSH_HOME: host.home, CHIEF_BRAIN: host.brain }
  delete env.SSH_ORIGINAL_COMMAND
  const cli = join(host.home, 'profiles', 'web', 'node_modules', 'dsh-chief', 'bin', 'cli.mjs')
  return execFileSync(process.execPath, [cli, 'bridge', action, id], {
    env, cwd: host.work, input, encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function verifyRemote() {
  checkpoint = 'remote claim and summary-only return through packaged bridge'
  await host.api('/staff', { id: remoteStaff, name: '隔离远程角色', executor: 'remote', verifier: 'reviewer', brief: '只处理隔离验收摘要。' })
  await host.api(`/staff/${remoteStaff}/assign`, { text: `${remoteMarker}。在指定工作电脑核对隔离标记并返回摘要 ${remoteSummary}。` })
  const claimId = randomUUID()
  const claim = await until(() => {
    const candidate = JSON.parse(bridge('pull', claimId))
    return candidate.assignmentId ? candidate : undefined
  }, 'real bridge remote claim', 30_000)
  const payload = JSON.stringify({ status: 'ready', summary: remoteSummary })
  assert.equal(bridge('push', claim.assignmentId, payload).trim(), 'ok')
  const remote = await until(async () => {
    const value = await detail(claim.ticketId)
    return value.ticket.assignments.at(-1)?.verification || value.stage === 'you/blocked' ? value : undefined
  }, 'remote summary verification', 30_000)
  const assignment = remote.ticket.assignments.at(-1)
  assert.equal(assignment.id, claim.assignmentId)
  assert.equal(assignment.executor, 'remote')
  assert.equal(assignment.execution, undefined)
  assert.equal(assignment.receipt, hash(payload))
  assert.equal(assignment.verification?.verdict, 'pass')
  assert.equal(bridge('push', claim.assignmentId, payload).trim(), 'ok')
  assert.deepEqual((await detail(claim.ticketId)).ticket.events, remote.ticket.events)
  const view = await mission(claim.ticketId)
  const instance = view.instances.find(row => row.assignmentId === claim.assignmentId && row.kind === 'execute')
  assert.equal(instance?.sessionId, undefined)
  assert.equal(instance?.coverage.state, 'unsupported')
  const summary = view.evidence.find(row => row.kind === 'delivery' && row.path?.endsWith('remote-report-1.md'))
  assert.ok(summary)
  assert.ok((await readProof(claim.ticketId, summary.id)).content.includes(remoteSummary))
  proof.remote = { ticketId: claim.ticketId, assignmentId: claim.assignmentId, receipt: assignment.receipt,
    duplicateReturnStable: true, summaryEvidence: summary.id, executionCoverage: instance.coverage.state,
    localReview: assignment.reviewExecution?.provider, returnMode: 'simulated worker through real bridge' }
  console.log('PASS remote claim, versioned summary, duplicate return, and limited native coverage')
}

try {
  assert.ok(candidate, 'Set CHIEF_ACCEPTANCE_PACKAGE to the packaged candidate.')
  proof.candidateSha256 = hash(readFileSync(candidate))
  proof.dsh = execFileSync('dsh', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
  host = await acceptanceHost({ candidate: resolve(candidate), probe: 'superhub-vertical-probe.mjs', model,
    extraEnv: { CHIEF_SUPERHUB_REAL_MODEL: model ? '1' : '0' } })
  await host.start()
  scope = (await host.api('/state')).superhubScope
  assert.ok(scope, 'The installed app must expose its current SuperHub scope.')
  const unauthenticated = { login: '', raw: true }
  assert.ok([401, 403].includes((await host.api(`/superhub/items?scope=${scope}`, undefined, unauthenticated)).status))
  assert.ok([401, 403].includes((await host.api('/chat', { scope, requestId: randomUUID(), text: '只记匿名测试' }, unauthenticated)).status))
  await conflict(host.api('/chat?scope=another-brain'))
  proof.ownerAdmission = { authenticatedScopedRoutes: true, anonymousReadsAndWritesDenied: true, staleOwnerChatScopeRejected: true }
  await host.api('/staff', { id: 'researcher', name: '隔离研究员', executor: 'dsh', verifier: 'reviewer', brief: '仅执行明确的隔离验收任务。' })
  await host.api('/staff', { id: 'reviewer', name: '隔离审查官', executor: 'dsh', verifier: 'none', brief: '读实际交付文件，用准确的登记路径与摘要逐项核对标准。' })

  checkpoint = 'owner chat reaches the liaison, which registers a memo and a read task'
  const goal = (await post('goals', { requestId: randomUUID(), expectedVersion: 0, name: '隔离验收目标',
    reason: '检查工单结果与已确认目标的关联', criteria: [{ text: '有可复查的隔离文件' }] })).goal
  const original = {
    scope, request_id: randomUUID(), sessionId: (await host.api('/chat')).sessionId, goalIds: [goal.id],
    text: `记一下隔离验收的目标背景；请检查左侧归档区 ${localMarker} 并在工单目录用原生工具写入 ${artifact}。首轮写入 ${lines[0]} 以检查缺项流程，收到独立审查返工后补齐 ${lines[1]}。两轮都回读实际内容并在 outputs 登记文件，完成条件是文件实际包含两行。`,
  }
  // The model's structured understanding of this exact phrase (scripted unless CHIEF_SUPERHUB_MODEL selects a real provider).
  if (!model) await teach(host, original.text, [['chief_inbox', { text: '隔离验收的目标背景', intent: 'memo', operation: 'read' }], ['chief_inbox', archiveWork()]])
  const { receipt } = await host.api('/chat', original)
  assert.equal(receipt.source.text, original.text)
  assert.equal(receipt.source.channel, 'chat')
  assert.deepEqual(receipt.items.map(row => [row.intent, row.state]), [['conversation', 'conversation']])
  assert.equal((await host.api('/chat', original)).receipt.id, receipt.id)
  await conflict(host.api('/chat', { ...original, text: original.text + ' 改变原话' }))
  const understood = await liaisonWork(host, scope, receipt.id, 2, row => row.items.every(item => item.state !== 'dispatching'), model ? 180_000 : 30_000)
  const memoReceipt = understood.linked.find(row => row.items[0].intent === 'memo')
  const workReceipt = understood.linked.find(row => row.items[0].intent === 'execute')
  assert.equal(memoReceipt?.items[0].state, 'recorded')
  assert.equal(memoReceipt.items[0].ticketId, undefined)
  const item = workReceipt?.items[0]
  const ticketId = item?.ticketId
  assert.ok(ticketId, `The liaison should register the read task: ${JSON.stringify(workReceipt?.items[0])}`)
  assert.equal(workReceipt.authorization.chatReceiptId, receipt.id)
  assert.equal(workReceipt.authorization.ownerText, original.text)
  assert.equal(workReceipt.authorization.operation, 'read')
  assert.deepEqual(item.goalIds, [goal.id])
  assert.equal((await get('overview')).tickets.filter(row => row.id === ticketId).length, 1)
  await conflict(host.api(`/superhub/items/${receipt.id}?scope=another-brain`))
  await conflict(host.api(`/tickets/${ticketId}/thread?scope=another-brain`))

  checkpoint = 'real native execution, independent review, and rework'
  const settled = await until(async () => {
    const row = await detail(ticketId)
    proof.local = { receiptId: receipt.id, ticketId, stage: row.stage, progress: row.ticket.assignments.map(attempt => ({
      id: attempt.id, state: attempt.state, report: attempt.report?.status, verdict: attempt.verification?.verdict,
      criterion: attempt.verification?.criteria?.[0]?.status, summary: attempt.report?.summary,
      critique: attempt.verification?.critique,
    })) }
    return ['you/review', 'you/blocked', 'ended'].includes(row.stage) ? row : undefined
  }, 'local execution and independent verification', model ? 180_000 : 40_000)
  assert.equal(settled.stage, 'you/review')
  assert.equal(settled.ticket.assignments.length, 2)
  const [initial, repaired] = settled.ticket.assignments
  assert.equal(initial.verification.criteria[0].status, 'fail')
  assert.equal(repaired.verification.criteria[0].status, 'pass')
  assert.equal(initial.contractVersion, repaired.contractVersion)
  const native = [initial.execution, initial.reviewExecution, repaired.execution, repaired.reviewExecution]
  assert.ok(native.every(row => row?.provider === 'spawn'))
  assert.equal(new Set(native.map(row => row.activationId)).size, 4)

  checkpoint = 'mission criteria, causality, and versioned evidence'
  const live = await mission(ticketId)
  assert.equal(live.mode, 'live')
  assert.equal(live.currentTarget.assignmentId, repaired.id)
  assert.equal(live.ticket.sourceId, workReceipt.source.id)
  assert.equal(live.contractHistory.length, 1)
  assert.equal(live.criteria[0].status, 'pass')
  assert.ok(live.roles.some(row => row.id === repaired.staff))
  assert.ok(live.roles.some(row => row.id === repaired.verifier))
  assert.ok(live.timeline.items.some(row => row.type === 'tool/call'))
  const calls = new Set(live.timeline.items.filter(row => row.type === 'tool/call').map(row => row.id))
  assert.ok(live.timeline.items.some(row => row.type === 'tool/result' && row.causes.some(cause => calls.has(cause))))
  assert.equal(live.outputsChanged, false)
  const currentEvidence = live.evidence.find(row => row.id === live.criteria[0].evidenceIds[0] && row.kind === 'delivery')
  const firstEvidence = live.evidence.find(row => row.assignmentId === initial.id && row.kind === 'delivery')
  assert.ok(currentEvidence && firstEvidence)
  assert.equal(firstEvidence.historical, true)
  assert.equal(currentEvidence.historical, false)
  const oldContent = (await readProof(ticketId, firstEvidence.id)).content
  const newContent = (await readProof(ticketId, currentEvidence.id)).content
  assert.deepEqual(oldContent.trim().split(/\r?\n/), lines.slice(0, 1))
  assert.deepEqual(newContent.trim().split(/\r?\n/), lines)
  assert.equal(hash(oldContent), firstEvidence.version)
  assert.equal(hash(newContent), currentEvidence.version)
  const history = await mission(ticketId, { at: initial.verifiedAt, round: '0' })
  assert.equal(history.mode, 'replay')
  assert.equal(history.currentTarget, undefined)
  assert.ok(history.timeline.items.every(row => !row.at || row.at <= initial.verifiedAt))
  assert.ok(history.evidence.some(row => row.id === firstEvidence.id))
  assert.ok(!history.evidence.some(row => row.id === currentEvidence.id))
  await conflict(post(`mission/${ticketId}`, { action: 'accept', at: initial.verifiedAt, ...live.currentTarget }))
  await conflict(post(`mission/${ticketId}`, { action: 'accept', ...live.currentTarget, assignmentId: initial.id }))

  checkpoint = 'reject changed current evidence before owner acceptance'
  const path = join(host.brain, currentEvidence.path)
  writeFileSync(path, 'VERTICAL_CHANGED_AFTER_VERIFICATION\n')
  assert.equal((await mission(ticketId)).outputsChanged, true)
  await conflict(post(`mission/${ticketId}`, { action: 'accept', ...live.currentTarget }))
  assert.equal((await readProof(ticketId, currentEvidence.id)).content, newContent)
  writeFileSync(path, newContent)
  assert.equal((await mission(ticketId)).outputsChanged, false)
  await conflict(post(`mission/${ticketId}`, { action: 'accept', ...live.currentTarget }))
  checkpoint = 'request new evidence and accept only after it is reverified'
  await post(`mission/${ticketId}`, { action: 'requestEvidence', ...live.currentTarget, requestId: randomUUID(),
    text: '请重新回读和登记完整文件，不需要改变内容。请独立核对两行完整，复用原文件也需登记本轮证据。' })
  const reverified = await until(async () => {
    const value = await detail(ticketId)
    return value.ticket.assignments.length >= 3 && ['you/review', 'you/blocked', 'ended'].includes(value.stage) ? value : undefined
  }, 'fresh verification after evidence change', model ? 180_000 : 40_000)
  assert.equal(reverified.stage, 'you/review')
  assert.equal(reverified.ticket.assignments.at(-1).verification?.criteria?.[0]?.status, 'pass')
  const confirmed = await mission(ticketId)
  const acceptedEvidence = confirmed.evidence.find(row => row.id === confirmed.criteria[0].evidenceIds[0])
  assert.ok(acceptedEvidence)
  assert.equal((await readProof(ticketId, acceptedEvidence.id)).content, newContent)
  await post(`mission/${ticketId}`, { action: 'accept', ...confirmed.currentTarget })
  assert.equal((await mission(ticketId)).ticket.outcome, 'done')
  const goalDetail = await get(`goals/${goal.id}`)
  assert.deepEqual(goalDetail.tasks.map(row => row.id), [ticketId])
  assert.equal(goalDetail.knownConditions, 0)
  Object.assign(proof.local, { stages: ['liaison memo and read task', 'dispatched', 'first criterion fail', 'rework', 'criterion pass', 'evidence changed', 'fresh verification', 'owner accepted'],
    contractVersion: live.currentTarget.contractVersion, distinctNativeActivations: native.length, linkedToolEvents: calls.size,
    historicalEvidence: firstEvidence.id, currentEvidence: acceptedEvidence.id,
    changedCurrentOutputRejected: true, staleAssignmentRejected: true, historicalMutationRejected: true, goalAssociation: goal.id })
  console.log('PASS scoped chat through the liaison, native work and review, rework, evidence read, and stale action rejection')

  checkpoint = 'owner correction freezes a real queued assignment'
  await host.api('/pause', { paused: true })
  const queuedText = '请调研隔离资料的目录命名。'
  if (!model) await teach(host, queuedText, [['chief_inbox', { text: '调研隔离资料的目录命名，交付命名建议', staff: 'researcher', operation: 'read' }]])
  const intake = await post('items', { requestId: randomUUID(), text: queuedText })
  assert.equal(intake.source.channel, 'owner')
  const queued = (await liaisonWork(host, scope, intake.id, 1, undefined, model ? 180_000 : 30_000)).linked[0]
  const queuedItem = queued.items[0]
  assert.ok(queuedItem.ticketId)
  const correction = await post(`items/${queued.id}`, { requestId: randomUUID(), expectedVersion: queued.version,
    itemId: queuedItem.id, action: 'record' })
  assert.equal(correction.source.text, queued.source.text)
  assert.equal(correction.items[0].state, 'recorded')
  assert.equal(correction.items[0].stop.state, 'confirmed')
  assert.ok(correction.history.some(row => row.item.state === 'dispatched' && row.item.ticketId === queuedItem.ticketId))
  assert.equal((await mission(queuedItem.ticketId)).ticket.outcome, 'stopped')
  assert.equal((await detail(queuedItem.ticketId)).ticket.assignments.length, 0)
  await host.api('/pause', { paused: false })
  proof.correction = { receiptId: correction.id, ticketId: queuedItem.ticketId, historyCount: correction.history.length, stop: 'engine-confirmed before execution' }
  console.log('PASS versioned owner correction stopped a queued command and preserved source history')

  if (!model) {
    checkpoint = 'a liaison memo creates no work and a UI change without a catalog feature is refused'
    const memoText = `只记一下 ${nativeMemoMarker}`
    await teach(host, memoText, [['chief_inbox', { text: `备忘 ${nativeMemoMarker}`, intent: 'memo', operation: 'read' }],
      ['chief_ui', { action: 'source', request: '请调整工单详情' }]])
    const before = (await get('overview')).total
    await host.api('/chat', { text: memoText, sessionId: original.sessionId })
    const nativeMemo = await until(async () => (await get('items')).receipts.find(row => row.authorization?.ownerText === memoText),
      'native room-facing owner RPC provenance', 30_000)
    assert.equal(nativeMemo.source.channel, 'native')
    assert.equal(nativeMemo.items[0].state, 'recorded')
    assert.equal(nativeMemo.items[0].ticketId, undefined)
    await until(async () => (await host.api('/chat')).messages.some(row => row.role === 'liaison' && row.text.includes('feature 必填')), 'chief_ui source refusal', 30_000)
    assert.equal((await get('overview')).total, before)
    proof.nativeMemo = { receiptId: nativeMemo.id, state: 'recorded', source: 'human RPC; the liaison declared intent=memo; chief_ui source without a catalog feature refused' }
    await verifyRemote()
  } else proof.remote = { coverage: 'not exercised with a configured model provider' }

  checkpoint = 'restore scoped identity and settled proof after a host restart'
  await host.stop()
  await host.start()
  assert.equal((await host.api('/state')).superhubScope, scope)
  const restored = await get(`items/${receipt.id}`)
  assert.equal(restored.linked.find(row => row.id === workReceipt.id).items[0].ticketId, ticketId)
  assert.equal((await mission(ticketId)).ticket.outcome, 'done')
  assert.equal((await readProof(ticketId, acceptedEvidence.id)).content, newContent)
  const finalCorrection = await get(`items/${correction.id}`)
  assert.equal(finalCorrection.items[0].stop.state, 'confirmed')
  assert.equal(finalCorrection.history.length, correction.history.length)
  proof.restarted = true
  proof.completed = true
  console.log('PASS restart preserves scoped receipt, ticket, and archived evidence')
} catch (error) {
  proof.completed = false
  proof.failure = { checkpoint, message: error.message, status: error.status }
  process.exitCode = 1
  console.error('FAIL SuperHub vertical acceptance', proof.failure)
  if (process.env.CHIEF_SUPERHUB_DEBUG === '1') console.error(host?.logs())
} finally {
  await host?.stop()
  if (reportFile) {
    const path = resolve(reportFile)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(proof, null, 2) + '\n')
  }
}
