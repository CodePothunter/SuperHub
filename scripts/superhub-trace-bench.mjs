/** Run with node --experimental-transform-types scripts/superhub-trace-bench.mjs. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { cpus, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Engine } from '../src/core/engine.ts'
import { FileStore } from '../src/core/store.ts'
import { SUPERHUB_GOALS_FILE, currentGoal } from '../src/core/superhub-goals.ts'
import { SuperhubGoals } from '../src/dsh/superhub-goals.ts'
import { createSuperhubTrace } from '../src/dsh/superhub-trace.ts'
import { serveApi } from '../src/dsh/http.ts'
import { SuperhubSaa } from '../src/dsh/superhub-saa.ts'
import { superhubWorkspaceRoutes } from '../src/dsh/superhub-workspace.ts'

const root = mkdtempSync(join(tmpdir(), 'superhub-trace-profile-'))
const storage = join(root, 'observations.jsonl')
const scope = 'benchmark-scope'
const seededAt = new Date('2026-01-01T00:00:00Z').toISOString()
const epochMs = Date.parse(seededAt)
const observedAt = new Date(epochMs + 1_000).toISOString()
const ticketId = n => `T-${String(n + 1).padStart(4, '0')}`
const sessionId = n => `benchmark-session-${n}`
const goalId = n => `G-00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`
const staff = [{ id: 'worker', name: 'Execution', executor: 'dsh', verifier: 'reviewer', brief: '' }]
const sha = value => createHash('sha256').update(value).digest('hex')
const result = values => {
  const ordered = [...values].sort((a, b) => a - b)
  const p = value => +ordered[Math.ceil(value * ordered.length) - 1].toFixed(3)
  return { samples: values.length, p50Ms: p(.5), p95Ms: p(.95), maxMs: p(1) }
}

function observedRow(n, seq, size) {
  const coordinate = { at: new Date(epochMs + seq).toISOString(), seq, observedAt, channel: 'history' }
  if (seq === 0) return { ...coordinate, type: 'subagent/descriptor', provider: 'spawn', descriptorVersion: 3 }
  if (seq === 1) return { ...coordinate, type: 'turn/start', turn: 1 }
  if (seq === 2) return { ...coordinate, type: 'model/selection', provider: 'fixture', model: 'fixture-route' }
  if (seq === size - 1) return { ...coordinate, type: 'turn/end', turn: 1, reason: 'completed' }
  const step = Math.floor((seq - 3) / 2), callKey = sha(`${n}/${step}`)
  return seq % 2
    ? { ...coordinate, type: 'tool/call', turn: 1, step, callKey, tool: 'read' }
    : { ...coordinate, type: 'tool/result', turn: 1, step, callKey, sourceCallKey: callKey, failed: false }
}

function seed() {
  const store = new FileStore(root)
  const goals = Array.from({ length: 1000 }, (_, i) => ({
    id: goalId(i), source: { kind: 'owner', requestId: `goal-request-${i}` },
    versions: [{ version: 1, at: seededAt, reason: 'fixture', name: `Goal ${i + 1}`, description: 'benchmark',
      type: 'project', status: 'active', owner: 'owner', horizon: '2026', relations: [], criteria: [] }],
  }))
  writeFileSync(join(root, SUPERHUB_GOALS_FILE), JSON.stringify({ schema: 1, goals, requests: {} }))
  const buffer = []
  let eventCount = 0
  for (let i = 0; i < 5000; i++) {
    const id = ticketId(i), eventId = `intent-${i}`
    store.appendEvent({ id: eventId, at: seededAt, source: 'inbox', text: `Task fixture ${i}`, dedupe: eventId })
    store.setDisposition(eventId, { kind: 'accepted', ticketId: id })
    store.saveTicket({
      id, title: `Task ${i + 1}`, staff: 'worker', priority: 50, assignments: [{
        id: `assignment-${i}`, staff: 'worker', executor: 'dsh', role: staff[0], startedAt: seededAt, round: 0, state: 'reported',
        endedAt: observedAt, execution: { provider: 'spawn', activationId: sessionId(i) },
        report: { status: 'ready', summary: 'fixture', structured: true },
      }],
      mandate: { eventId, strength: 'explicit', level: 'think', scope: 'benchmark', doneWhen: [], needsReview: false },
      createdAt: seededAt, inputs: [], events: [eventId], ended: { at: observedAt, outcome: 'done', note: 'fixture' },
    })
    const size = i < 100 ? 510 : 10
    for (let seq = 0; seq < size; seq++) buffer.push(JSON.stringify({ scope, sessionId: sessionId(i), row: observedRow(i, seq, size) }))
    buffer.push(JSON.stringify({ scope, sessionId: sessionId(i), checkedAt: observedAt }))
    eventCount += size
    if ((i + 1) % 50 === 0) appendFileSync(storage, buffer.splice(0).join('\n') + '\n', { mode: 0o600 })
  }
  assert.equal(eventCount, 100000)
}

let trace
let server
try {
  seed()
  let listener
  const ctx = { get: () => undefined, on: (_name, fn) => { listener = fn; return () => { listener = undefined } } }
  const start = performance.now()
  const store = new FileStore(root)
  const engine = new Engine(store, {}, {}, {}, {})
  trace = createSuperhubTrace(ctx, engine, scope, { storage, staff: () => staff })
  const coldBuildMs = +(performance.now() - start).toFixed(3)
  const goals = new SuperhubGoals(root, () => {})
  const coldRoleAt = performance.now()
  assert.equal(trace.roles().find(role => role.id === 'worker').instanceCount, 5000)
  const coldRoleMs = +(performance.now() - coldRoleAt).toFixed(3)
  const missionTimes = [], roleTimes = [], goalTimes = [], visibilityTimes = []
  for (let i = 0; i < 200; i++) {
    const n = (i * 37) % 100
    const started = performance.now()
    const mission = await trace.mission(ticketId(n), { limit: 50 })
    missionTimes.push(performance.now() - started)
    assert.equal(mission.timeline.items.length, 50)
    assert.ok(mission.timeline.nextCursor)
    const roleAt = performance.now()
    assert.equal(trace.roles().find(role => role.id === 'worker').instances.length, 20)
    roleTimes.push(performance.now() - roleAt)
    const goalsAt = performance.now()
    assert.equal(goals.list().map(currentGoal).filter(goal => goal.status === 'active').length, 1000)
    goalTimes.push(performance.now() - goalsAt)
  }
  for (let i = 0; i < 50; i++) {
    const seq = 510 + i
    const at = Date.now()
    const elapsed = performance.now()
    listener({ id: sessionId(i) }, { seq, time: at, type: 'tool/call',
      data: { turn: 2, step: 1, callId: `visible-${i}`, name: 'read' } })
    const mission = await trace.mission(ticketId(i), { type: 'tool/call', from: new Date(at).toISOString(), limit: 1 })
    assert.equal(mission.timeline.items[0]?.native?.seq, seq)
    visibilityTimes.push(performance.now() - elapsed)
  }
  let http
  if (process.argv.includes('--http')) {
    const routes = [superhubWorkspaceRoutes({ scope, engine, trace, goals,
      brain: { staff: () => staff }, rooms: { ownerActions: () => [] },
      superhub: { receiptsForGoal: () => [], receiptIdForSource: () => undefined },
      saa: new SuperhubSaa(root, () => {}),
    })]
    server = createServer((req, res) => { void serveApi(req, res, 'public', routes) })
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/chief/api/superhub`
    const get = async (path, params, samples) => {
      const started = performance.now()
      const response = await fetch(`${base}/${path}?${new URLSearchParams({ scope, ...params })}`)
      assert.ok(response.ok)
      const data = await response.json()
      assert.equal(data.scope, scope)
      samples?.push(performance.now() - started)
      return data
    }
    await get('overview')
    await get('goals')
    await get(`mission/${ticketId(0)}`, { limit: '50' })
    const summaries = [], goalCatalog = [], tracePages = [], visible = []
    for (let i = 0; i < 200; i++) {
      assert.equal((await get('overview', {}, summaries)).total, 5000)
      assert.equal((await get('goals', {}, goalCatalog)).goals.length, 1000)
      assert.equal((await get(`mission/${ticketId((i * 37) % 100)}`, { limit: '50' }, tracePages)).timeline.items.length, 50)
    }
    for (let i = 0; i < 50; i++) {
      const seq = 700 + i, at = Date.now(), started = performance.now()
      listener({ id: sessionId(i) }, { seq, time: at, type: 'tool/call',
        data: { turn: 3, step: 1, callId: `http-visible-${i}`, name: 'read' } })
      const reply = await get(`mission/${ticketId(i)}`, { type: 'tool/call', from: new Date(at).toISOString(), limit: '1' })
      assert.equal(reply.timeline.items[0]?.native?.seq, seq)
      visible.push(performance.now() - started)
    }
    http = { method: 'Loopback against application routes with a synthetic dataset. Includes response serialization and parsing. Excludes browser polling, host authentication, model time and provider I/O.',
      targetSummary: result(goalCatalog), ticketSummary: result(summaries), tracePage50: result(tracePages), callbackToHttpQuery: result(visible) }
  }
  console.log(JSON.stringify({
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryMiB: Math.round(totalmem() / 2 ** 20) },
    fixture: { goals: 1000, tickets: 5000, nativeEvents: 100000, eventsPerQueriedTicket: 510 },
    method: 'In-process. FileStore and sanitized persisted native rows reopened once. Operating-system cache may be warm. Local fixture emits native event callbacks. Browser, HTTP, native observation I/O and model time are excluded.',
    coldBuildMs, coldRoleMs,
    missionFirstPage50: result(missionTimes), hotRoleOverview: result(roleTimes), goalRows: result(goalTimes),
    liveCallbackToQuery: result(visibilityTimes), http,
  }, null, 2))
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  trace?.dispose()
  rmSync(root, { recursive: true, force: true })
}
