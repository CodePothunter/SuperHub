import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDeviceTrace } from './superhub-human-clock.mjs'

test('device adapter preserves reversed source time, first observation and explicit causality', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'superhub-clock-preflight-'))
  const trace = createDeviceTrace('automated-skew-case', directory)
  try {
    // Deliberately synthetic negative clock difference; separate from physical-device captures.
    const now = Date.now()
    trace.receive('result', now - 120_000)
    await new Promise(resolve => setTimeout(resolve, 8))
    trace.receive('call', now)
    const result = await trace.result()
    assert.equal(result.sourceTimestampsPreserved, true)
    assert.equal(result.observedArrivalReversed, true)
    assert.equal(result.explicitCausePreserved, true)
    assert.equal(result.nativePairing, 'confirmed')
    assert.equal(result.negativeDurationOmitted, true)
    assert.equal(result.result.native.durationMs, undefined)
    assert.ok(Date.parse(result.result.observedAt) < Date.parse(result.call.observedAt))
    const persisted = readFileSync(join(directory, 'clock-automated-skew-case.jsonl'), 'utf8')
    assert.ok(persisted.includes(result.result.observedAt))
    assert.ok(persisted.includes(result.call.at))
  } finally { trace.close(); rmSync(directory, { recursive: true, force: true }) }
})
