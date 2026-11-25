/** Exercise the packaged Chief and DSH native spawn in a disposable host. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acceptanceHost, until } from './acceptance-host.mjs'
import {
  artifact, localTask, probePath, remoteArtifact, remoteStaff, remoteSummary, remoteTask, requiredLines,
} from './superhub-native-probe.mjs'

const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE
const model = process.env.CHIEF_SUPERHUB_MODEL
const evidencePath = process.env.CHIEF_SUPERHUB_EVIDENCE
const hash = value => createHash('sha256').update(value).digest('hex')
const evidence = {
  checkedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    modelMode: model ? 'configured provider' : 'deterministic model fixture',
    scope: model ? 'local dispatch and restart' : 'local dispatch, remote bridge, and restart',
  },
}

let host
let checkpoint = 'candidate and isolated host startup'
const detail = id => host.api(`/tickets/${id}`)
const observe = sessions => host.request(probePath, { sessions })
const reportReady = row => row.ticket.assignments.at(-1)?.verification || row.stage === 'you/blocked'
const nativeSessionCandidate = execution => execution?.sessionId ?? execution?.activationId

function bridge(action, id, input) {
  const env = { ...process.env, DSH_HOME: host.home, CHIEF_BRAIN: host.brain }
  delete env.SSH_ORIGINAL_COMMAND
  const cli = join(host.home, 'profiles', 'web', 'node_modules', 'dsh-chief', 'bin', 'cli.mjs')
  return execFileSync(process.execPath, [cli, 'bridge', action, id], {
    env, cwd: host.work, input, encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function verifyNativeTrace(trace) {
  assert.ok(trace.live.some(row => row.type === 'turn/end'), 'The live hook must see a real turn completion.')
  assert.ok(trace.history.available, 'Native observation must read the completed session.')
  const historicEvents = new Map(trace.history.events.map(row => [row.seq, row]))
  assert.equal(historicEvents.size, trace.history.events.length, 'Native history must have one event per source sequence.')
  assert.equal(new Set(trace.live.map(row => row.seq)).size, trace.live.length, 'The live capture must have one event per source sequence.')
  for (const { observedAt, ...event } of trace.live) {
    assert.ok(Number.isFinite(observedAt) && Number.isFinite(event.time), 'Live events must retain source and observation times.')
    assert.deepEqual(historicEvents.get(event.seq), event, 'Live and historical observations must agree on the same native event.')
    if (event.type !== 'tool/result') continue
    assert.ok(event.callId && (!event.sourceCallId || event.sourceCallId === event.callId), 'The result must expose a consistent call ID.')
    const calls = trace.live.filter(row => row.type === 'tool/call' && row.callId === event.callId
      && row.turn === event.turn && row.step === event.step && row.seq < event.seq)
    assert.equal(calls.length, 1, 'Each native tool result must match one preceding call in the same turn and step.')
  }
  if (model) {
    assert.equal(`${trace.route?.provider}/${trace.route?.model}`, model, 'The observed live provider and model must match the requested route.')
  }
}

function traceCalls(trace, name, file) {
  return trace.live.filter(call => call.type === 'tool/call' && call.name === name && (!file || call.file === file))
    .map(call => ({
      call,
      result: trace.live.find(row => row.type === 'tool/result' && row.callId === call.callId && row.turn === call.turn && row.step === call.step),
    }))
}

async function readVersion(id, assignment, file) {
  const path = `work/${id}/${file}`
  const delivery = assignment.deliveries?.find(row => row.path === path)
  assert.ok(delivery?.version, 'The reported file needs a recorded delivery version.')
  const query = new URLSearchParams({ path, version: delivery.version })
  const { content } = await host.api(`/tickets/${id}/file?${query}`)
  assert.equal(hash(content), delivery.version, 'The versioned file read must match the delivery digest.')
  return { version: delivery.version, path, content }
}

function assignmentFact(assignment) {
  return {
    assignmentId: assignment.id,
    round: assignment.round,
    role: assignment.staff,
    requestedExecutor: assignment.executor,
    execution: assignment.execution,
    reviewRole: assignment.verifier,
    reviewExecution: assignment.reviewExecution,
    verdict: assignment.verification?.verdict,
    startedAt: assignment.startedAt,
    endedAt: assignment.endedAt,
    verifiedAt: assignment.verifiedAt,
  }
}

function recordFailure(failedCheckpoint, error) {
  evidence.completed = false
  const failure = { checkpoint: failedCheckpoint, reason: error.code === 'ERR_ASSERTION' ? error.message : error.name }
  if (Number.isInteger(error.status)) failure.status = error.status
  if (evidence.failure) evidence.cleanupFailure = failure
  else evidence.failure = failure
  console.error('FAIL SuperHub native acceptance', failure)
  process.exitCode = 1
}

async function verifyRemote() {
  checkpoint = 'remote bridge claim and summary-only return'
  evidence.remote = { source: 'simulated remote worker submitting through the real local bridge' }
  await host.api('/staff', { id: remoteStaff, name: '隔离工作电脑', executor: 'remote', verifier: 'reviewer', brief: '只接收隔离探针任务。' })
  await host.api(`/staff/${remoteStaff}/assign`, {
    text: `${remoteTask}。这是工作电脑隔离摘要验收。请开工单，完成标准只检查回传摘要包含 ${remoteSummary}。保持 think，核验通过后交由主人验收。`,
  })
  const claimId = randomUUID()
  const claimed = await until(() => {
    const value = JSON.parse(bridge('pull', claimId))
    return value.assignmentId ? value : undefined
  }, '领取隔离远程工单')
  Object.assign(evidence.remote, { ticketId: claimed.ticketId, claimId })
  const payload = JSON.stringify({ status: 'ready', summary: remoteSummary })
  assert.equal(bridge('push', claimed.assignmentId, payload).trim(), 'ok', 'The real bridge must accept the fixture return.')
  const remote = await until(async () => {
    const row = await detail(claimed.ticketId)
    return reportReady(row) ? row : undefined
  }, '读取摘要回传与本地审查')
  const remoteAssignment = remote.ticket.assignments.at(-1)
  assert.ok(remoteAssignment, 'The remote ticket must record an assignment.')
  evidence.remote.assignment = assignmentFact(remoteAssignment)
  assert.equal(remoteAssignment.id, claimed.assignmentId, 'The ticket must retain the claimed assignment ID.')
  assert.equal(remoteAssignment.executor, 'remote', 'The work must be assigned through the remote executor.')
  assert.equal(remoteAssignment.execution, undefined, 'The bridge cannot supply a native execution session for the remote worker.')
  evidence.remote.remoteToolCoverage = 'unavailable from this summary-only return'
  assert.equal(remoteAssignment.receipt, hash(payload), 'The observed receipt must bind to the returned payload.')
  evidence.remote.receipt = remoteAssignment.receipt
  assert.equal(remoteAssignment.report?.summary, remoteSummary, 'The business report must preserve the expected summary marker.')
  assert.equal(remoteAssignment.verification?.verdict, 'pass', 'The local review should be able to verify the returned summary marker.')
  const remoteReviewSession = nativeSessionCandidate(remoteAssignment.reviewExecution)
  assert.ok(remoteReviewSession, 'The local reviewer needs a recorded execution identity.')
  const returned = await readVersion(claimed.ticketId, remoteAssignment, remoteArtifact)
  assert.ok(returned.content.includes(remoteSummary), 'The hub should archive readable summary evidence.')
  evidence.remote.summaryEvidence = { path: returned.path, version: returned.version }
  const returnedEventCount = remote.ticket.events.length
  assert.equal(bridge('push', claimed.assignmentId, payload).trim(), 'ok', 'Retrying a completed return should acknowledge its existing receipt.')
  const afterRetry = await detail(claimed.ticketId)
  assert.equal(afterRetry.ticket.events.length, returnedEventCount, 'Retrying the remote return must not add another business fact.')
  evidence.remote.duplicateReturnStable = true
  const remoteTrace = await observe([remoteReviewSession])
  const [localReview] = remoteTrace.observed
  evidence.remote.localReview = localReview
  verifyNativeTrace(localReview)
  assert.ok(localReview.history.events.some(row => row.type === 'subagent/descriptor' && row.provider === 'spawn'),
    'The reported remote review identity must resolve to a native spawn session.')
  assert.ok(traceCalls(localReview, 'read', remoteArtifact).some(({ result }) => result && !result.error && result.markers.includes(remoteSummary)),
    'Only the local reviewer should expose a native read of the archived remote summary.')
  console.log('PASS remote bridge claim and return, no remote tool trace, separate local verification')
}

try {
  assert.ok(candidate, 'CHIEF_ACCEPTANCE_PACKAGE must point to a built candidate tarball.')
  evidence.candidateSha256 = hash(readFileSync(candidate))
  evidence.runtime.dsh = execFileSync('dsh', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
  host = await acceptanceHost({
    candidate: resolve(candidate), probe: 'superhub-native-probe.mjs', model,
    extraEnv: { CHIEF_SUPERHUB_REAL_MODEL: model ? '1' : '0' },
  })
  await host.start()
  evidence.capabilities = (await observe([])).capabilities
  assert.ok(evidence.capabilities.spawn?.outputSchema, 'The isolated host must provide native structured spawn.')
  const executor = evidence.capabilities.claudeCodeInstalled ? 'dsh' : 'claude-code'
  await host.api('/staff', { id: 'engineer', name: '隔离执行者', executor, verifier: 'reviewer', brief: '仅处理明确的隔离验收文本与文件。' })
  await host.api('/staff', { id: 'reviewer', name: '隔离审查官', executor: 'dsh', verifier: 'none',
    brief: '必须先通过 read 工具检查实际登记的文件，再根据每条完成标准返回 pass、revise 或 fail。缺项可补时返回 revise。' })

  checkpoint = 'formal local dispatch and automatic rework'
  const line = await host.api('/lines', { name: 'SuperHub 隔离探针' })
  const localRequest = {
    title: localTask, staff: 'engineer', requestId: randomUUID(),
    text: `这是隔离验收 ${localTask}。用原生 read 工具检查工单目录中的 ${artifact}，再用 write 创建文本。第一次只写 ${requiredLines[0]} 一行用于演示核验失败。收到审查官 revise 返工意见后，写入两行。每次读回文件再提交 ready，outputs 中列出 ${artifact}，留给独立审查官核验。操作仅限该文件。`,
    doneWhen: requiredLines.map(line => `登记的 ${artifact} 实际包含一行 ${line}`),
  }
  const endpoint = `/lines/${line.id}/commission`
  const { ticketId } = await host.api(endpoint, localRequest)
  assert.equal((await host.api(endpoint, localRequest)).ticketId, ticketId, 'Replaying formal dispatch should reuse the original ticket.')
  const local = await until(async () => {
    const row = await detail(ticketId)
    evidence.local = { ticketId, stage: row.stage, assignments: row.ticket.assignments.map(assignmentFact) }
    const settled = ['you/blocked', 'you/review', 'ended'].includes(row.stage)
    return settled || (row.ticket.assignments.length >= 2 && reportReady(row)) ? row : undefined
  }, '真实本地派工、审查与返工', model ? 180_000 : 30_000)
  const { ticket } = local
  assert.equal(ticket.assignments.length, 2, 'The case should perform exactly one rework.')
  const [first, second] = ticket.assignments
  assert.equal(first.verification?.verdict, 'revise', 'Independent review should request repair of the insufficient first delivery.')
  assert.equal(second.verification?.verdict, 'pass', 'Independent review should pass the repaired delivery.')
  assert.equal(local.stage, 'you/review', 'Passed verification should remain distinct from owner acceptance.')
  const rework = ticket.inputs.find(input => input.from === 'verifier' && input.replyTo === first.id)
  assert.equal(rework?.consumedBy, second.id, 'The later assignment should consume the earlier verification result.')
  const executions = ticket.assignments.flatMap(row => [row.execution, row.reviewExecution])
  const localSessionIds = executions.map(nativeSessionCandidate)
  assert.ok(localSessionIds.every(Boolean), 'Workers and reviewers need recorded execution identities.')
  assert.equal(new Set(localSessionIds).size, 4, 'Each execution and independent review must have a distinct identity.')
  for (const row of ticket.assignments) {
    assert.equal(row.executor, executor, 'The assignment must preserve the requested executor.')
    assert.equal(row.execution.provider, 'spawn', 'The assignment must expose its actual provider.')
    assert.equal(row.reviewExecution.provider, 'spawn', 'The review must use the native provider.')
  }
  const original = await readVersion(ticketId, first, artifact)
  const repaired = await readVersion(ticketId, second, artifact)
  assert.deepEqual(original.content.trim().split(/\r?\n/), requiredLines.slice(0, 1), 'The first registered version should lack the second line.')
  assert.deepEqual(repaired.content.trim().split(/\r?\n/), requiredLines, 'The repaired registered version should include both lines.')
  assert.notEqual(original.version, repaired.version, 'Rework must preserve two independently identifiable versions.')
  const localThread = await host.api(`/tickets/${ticketId}/thread`)
  const origin = localThread.messages.find(row => row.id === `event:${ticket.mandate.eventId}`)
  assert.equal(origin?.role, 'owner', 'Formal dispatch should carry a durable owner input.')
  Object.assign(evidence.local, {
    threadId: localThread.thread_id, ownerEventId: ticket.mandate.eventId, ownerMessageId: origin.id,
    rework: { sourceAssignmentId: rework.replyTo, consumedBy: rework.consumedBy, inputId: rework.key, at: rework.at },
    deliveries: [original, repaired].map(({ path, version, content }) => ({ path, version, markers: requiredLines.filter(marker => content.includes(marker)) })),
    ownerStageBeforeAcceptance: localThread.stage,
  })

  checkpoint = 'capture linked tool events and provenance'
  const native = await observe(localSessionIds)
  evidence.local.observed = native.observed
  evidence.local.sessionIdentity = executions.map((execution, index) => {
    const trace = native.observed[index]
    const descriptor = trace.history.events.find(row => row.type === 'subagent/descriptor' && row.provider === execution.provider)
    return { activationId: execution.activationId, recordedSessionId: execution.sessionId ?? null,
      observedSessionId: descriptor ? trace.sessionId : null, descriptorSeq: descriptor?.seq }
  })
  assert.ok(evidence.local.sessionIdentity.every(identity => identity.observedSessionId),
    'The native descriptor must confirm the execution identity for each observed session.')
  for (const [index, trace] of native.observed.entries()) {
    const reviewer = index % 2 === 1
    verifyNativeTrace(trace)
    const expectedMarkers = index < 2 ? requiredLines.slice(0, 1) : requiredLines
    const proof = traceCalls(trace, reviewer ? 'read' : 'write', artifact)
    assert.ok(proof.some(({ result }) => result && !result.error
      && (!reviewer || isDeepStrictEqual(result.markers, expectedMarkers))),
    'The native tool call must have a same-step result. The reviewer must read the expected version.')
    if (reviewer) {
      const verdict = index < 2 ? 'revise' : 'pass'
      assert.ok(traceCalls(trace, 'structured_output').some(({ call, result }) => call.verdict === verdict && result && !result.error),
        'The native reviewer must actually submit the observed verdict through structured_output.')
    }
  }
  const readAttempts = traceCalls(native.observed[0], 'read', artifact)
  evidence.local.readFailureThenSuccess = readAttempts.some(({ result }, index) =>
    result?.error === true && readAttempts.slice(index + 1).some(({ result: later }) => later?.error === false))
  if (!model) assert.ok(evidence.local.readFailureThenSuccess, 'Fixture should exercise and expose a real tool failure and recovered read.')
  evidence.local.activationUserInputsWithoutRpcId = native.observed.flatMap(trace =>
    trace.live.filter(row => row.type === 'user/message' && row.kind === 'user' && !row.rpcId)
      .map(row => ({ sessionId: trace.sessionId, seq: row.seq, messageId: row.messageId })))
  await host.api(`/tickets/${ticketId}/accept`, {
    thread_id: localThread.thread_id, reply_to: localThread.reply_to, stage: localThread.stage,
  })
  evidence.local.ownerOutcome = (await detail(ticketId)).ticket.ended?.outcome
  assert.equal(evidence.local.ownerOutcome, 'done', 'Owner acceptance should close the verified ticket.')
  console.log('PASS local native dispatch, actual file tools, independent review, rework, and owner acceptance')

  if (!model) await verifyRemote()

  checkpoint = 'read native history after host restart'
  await host.stop()
  await host.start()
  const reopened = await observe(localSessionIds)
  evidence.local.restart = reopened.observed.map(trace => {
    const initial = native.observed.find(row => row.sessionId === trace.sessionId).history.events
    const events = new Map(trace.history.events.map(event => [event.seq, event]))
    return { sessionId: trace.sessionId, available: trace.history.available, eventCount: events.size,
      retainedOriginalEvents: initial.length > 0 && events.size === trace.history.events.length
        && initial.every(event => isDeepStrictEqual(events.get(event.seq), event)) }
  })
  assert.ok(evidence.local.restart.every(trace => trace.available && trace.retainedOriginalEvents), 'Read-only observation must retain all original event keys after restart.')
  assert.equal((await detail(ticketId)).ticket.assignments.length, 2, 'Restart and historical reads must not dispatch another round.')
  console.log('PASS same native session IDs and event sequence after restart')
  evidence.completed = true
} catch (error) {
  recordFailure(checkpoint, error)
} finally {
  try { await host?.stop() } catch (error) { recordFailure('isolated host cleanup', error) }
  if (evidencePath) {
    mkdirSync(dirname(resolve(evidencePath)), { recursive: true })
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    console.log('Evidence:', resolve(evidencePath))
  }
}
