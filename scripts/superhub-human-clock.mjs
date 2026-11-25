/** Device envelopes enter the actual product projector through this test-only adapter. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createSuperhubTrace } from '../src/dsh/superhub-trace.ts'

export function createDeviceTrace(pairId, directory) {
  const scope = `human-clock-${pairId}`
  const sessionId = `device-${pairId}`
  const createdAt = new Date().toISOString()
  const ticket = { id: 'T-0001', title: '两台设备的延迟回传实测', threadId: `thread-${pairId}`, createdAt,
    staff: 'device-probe', priority: 50, mandate: { strength: 'explicit', level: 'think', scope: '仅验收设备时间与因果',
      doneWhen: ['保留两个设备的来源时间、收到时间及明确关联'], needsReview: true, eventId: pairId }, inputs: [], events: [pairId],
    assignments: [{ id: 'device-assignment', staff: 'device-probe', executor: 'dsh', round: 0,
      startedAt: createdAt, state: 'running', execution: { provider: 'spawn', activationId: sessionId } }],
    superhub: { brainScope: scope, sourceId: pairId, commandId: pairId, contracts: [] } }
  const view = { ticket, stage: 'working', column: 'doing', attention: 0 }
  const events = [], listeners = new Set(), received = []
  const ctx = { get: () => ({ observeSession: async () => ({ events, [Symbol.dispose]() {} }) }),
    on: (_name, listener) => { listeners.add(listener); return () => listeners.delete(listener) } }
  const engine = { views: () => [view], ticketView: id => id === ticket.id ? view : undefined,
    initialEvent: () => ({ id: pairId, at: createdAt, source: 'inbox', text: '设备实测', dedupe: pairId }),
    onTicketSaved: () => () => {} }
  const trace = createSuperhubTrace(ctx, engine, scope, { storage: join(directory, `clock-${pairId}.jsonl`) })
  const emit = event => { events.push(event); for (const listener of listeners) listener({ id: sessionId }, event) }
  emit({ seq: 0, type: 'subagent/descriptor', time: Date.now(), data: { version: 3, mode: 'continuable', provider: 'spawn' } })
  emit({ seq: 1, type: 'turn/start', time: Date.now(), data: { turn: 1 } })
  return {
    receive(kind, wallMs) {
      assert.ok(Number.isFinite(wallMs), '来源时间无效')
      received.push({ kind, sequence: received.length + 1, monotonicMs: performance.now() })
      emit(kind === 'call'
        ? { seq: 2, type: 'tool/call', time: wallMs, data: { turn: 1, step: 1, callId: pairId, name: 'read', arguments: '{}' } }
        : { seq: 3, type: 'tool/result', time: wallMs, data: { turn: 1, step: 1,
          message: { toolCallId: pairId, source: { callId: pairId }, isError: false, content: [] } } })
    },
    async result() {
      const mission = await trace.mission(ticket.id)
      const call = mission.timeline.items.find(row => row.native?.seq === 2)
      const result = mission.timeline.items.find(row => row.native?.seq === 3)
      assert.ok(call && result)
      return { adapter: 'test-only device envelopes mapped to native call/result records', call, result, received,
        sourceTimestampsPreserved: call.at === new Date(events.find(row => row.seq === 2).time).toISOString()
          && result.at === new Date(events.find(row => row.seq === 3).time).toISOString(),
        observedArrivalReversed: received.find(row => row.kind === 'result').sequence < received.find(row => row.kind === 'call').sequence
          && received.find(row => row.kind === 'result').monotonicMs < received.find(row => row.kind === 'call').monotonicMs,
        explicitCausePreserved: result.causes.length === 1 && result.causes[0] === call.id,
        nativePairing: result.native.pairing,
        negativeDurationOmitted: Date.parse(result.at) >= Date.parse(call.at) || result.native.durationMs === undefined }
    },
    close() { trace.dispose() },
  }
}
