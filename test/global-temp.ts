import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One private temporary root per test run. Every `tmpdir()` in the tests (and their workers, which are
 * started after this runs and inherit the environment) lands under it, and the whole root is removed when the
 * run ends, fails or is interrupted. The server's disk is small; test runs must not leave `/tmp` behind.
 */
export default function setup() {
  const root = mkdtempSync(join(tmpdir(), 'chief-vitest-'))
  const previous = process.env.TMPDIR
  process.env.TMPDIR = root
  let removed = false
  const cleanup = () => {
    if (removed) return
    removed = true
    try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort on the way out */ }
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  const handlers = signals.map(signal => {
    const handler = () => {
      cleanup()
      // Re-raise only when nobody else (e.g. vitest itself) handles the signal, so the default exit still happens.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    }
    process.once(signal, handler)
    return [signal, handler] as const
  })
  process.once('exit', cleanup)
  return () => {
    cleanup()
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
    process.removeListener('exit', cleanup)
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
}
