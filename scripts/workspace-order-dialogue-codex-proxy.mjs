/**
 * Acceptance-only stdio proxy in front of the REAL Codex CLI (scripts/workspace-order-dialogue-acceptance.mjs puts a
 * `codex` shim that runs this file first on the isolated host's PATH). It never answers for Codex; it only
 * - records the app-server JSON-RPC traffic that matters for the acceptance (thread, turn, steer, interrupt, command
 *   items with their `source`, warnings, errors) to CHIEF_OD_PROXY_LOG,
 * - and, only for a working directory listed in the control file CHIEF_OD_PROXY_CONTROL, simulates faults:
 *     stripTrust: remove `config.bypass_hook_trust` from thread/start and thread/resume (Codex then never runs the hook),
 *     fakeTrust:  additionally emit the hook-trust warning Codex would have sent, so the turn starts without the hook,
 *     steerReject: send `turn/steer` with a wrong `expectedTurnId`, so the real Codex rejects it (-32600).
 * Product code has no switch for any of this.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const real = process.env.CHIEF_OD_PROXY_REAL
const control = process.env.CHIEF_OD_PROXY_CONTROL
const logFile = process.env.CHIEF_OD_PROXY_LOG
const args = process.argv.slice(2)
const log = row => { try { if (logFile) appendFileSync(logFile, JSON.stringify({at: new Date().toISOString(), pid: process.pid, ...row}) + '\n') } catch { /* never change the run */ } }
const flags = () => { try { return JSON.parse(readFileSync(control, 'utf8')) } catch { return {} } }
const listed = (name, cwd) => Array.isArray(flags()[name]) && flags()[name].includes(cwd)
const textOf = input => Array.isArray(input) ? input.map(part => part?.text ?? '').join('\n') : ''

const child = spawn(real, args, {stdio: ['pipe', 'pipe', 'inherit']})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal))
child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); process.stdout.end() })

if (!args.includes('app-server')) {
  process.stdin.pipe(child.stdin)
  child.stdout.pipe(process.stdout)
} else {
  log({event: 'spawn', args: args.filter(arg => !arg.startsWith('hooks.PreToolUse')).map(arg => arg.length > 200 ? arg.slice(0, 200) + '…' : arg)})
  let cwd, fakeFor
  const input = createInterface({input: process.stdin, crlfDelay: Infinity})
  input.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { child.stdin.write(line + '\n'); return }
    const params = message.params ?? {}
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      cwd = params.cwd
      const strip = listed('stripTrust', cwd)
      if (strip && params.config) { delete params.config.bypass_hook_trust; if (!Object.keys(params.config).length) delete params.config }
      if (strip && listed('fakeTrust', cwd)) fakeFor = message.id
      log({event: 'send', method: message.method, id: message.id, cwd, threadId: params.threadId, sandbox: params.sandbox, approvalPolicy: params.approvalPolicy,
        bypassHookTrust: params.config?.bypass_hook_trust === true, ...(strip && {simulated: listed('fakeTrust', cwd) ? 'strip+fake-trust' : 'strip-trust'})})
    } else if (message.method === 'turn/steer') {
      const reject = listed('steerReject', cwd)
      if (reject) params.expectedTurnId = 'acceptance-proxy-wrong-turn'
      log({event: 'send', method: message.method, id: message.id, cwd, expectedTurnId: params.expectedTurnId, clientUserMessageId: params.clientUserMessageId,
        text: textOf(params.input).slice(0, 4000), ...(reject && {simulated: 'steer-reject'})})
    } else if (message.method === 'turn/start') {
      log({event: 'send', method: message.method, id: message.id, cwd, threadId: params.threadId, text: textOf(params.input).slice(0, 6000)})
    } else if (message.method === 'turn/interrupt' || message.method === 'initialize') {
      log({event: 'send', method: message.method, id: message.id, cwd})
    }
    child.stdin.write(JSON.stringify(message) + '\n')
  })
  input.on('close', () => { log({event: 'stdin-closed', cwd}); child.stdin.end() })
  const output = createInterface({input: child.stdout, crlfDelay: Infinity})
  output.on('line', line => {
    process.stdout.write(line + '\n')
    let message
    try { message = JSON.parse(line) } catch { return }
    const params = message.params ?? {}
    const item = params.item
    if (message.method === undefined && message.error) log({event: 'error', id: message.id, cwd, code: message.error.code, message: String(message.error.message).slice(0, 300)})
    if (message.method === undefined && message.result?.thread?.id) log({event: 'thread', id: message.id, cwd, threadId: message.result.thread.id, model: message.result.model})
    if (message.method === undefined && message.result?.turn?.id) log({event: 'turn', id: message.id, cwd, turnId: message.result.turn.id})
    if (message.method === undefined && message.result?.turnId) log({event: 'steered', id: message.id, cwd, turnId: message.result.turnId})
    if (message.method === 'warning' || message.method === 'configWarning') log({event: message.method, cwd, threadId: params.threadId, message: String(params.message ?? params.summary ?? '').slice(0, 300)})
    if (message.method === 'turn/completed') log({event: 'turn/completed', cwd, turnId: params.turn?.id, status: params.turn?.status})
    if ((message.method === 'item/started' || message.method === 'item/completed') && item?.type === 'commandExecution') {
      log({event: message.method, cwd, itemId: item.id, source: item.source, command: String(item.command).slice(0, 300), status: item.status, exitCode: item.exitCode})
    }
    if (message.method === 'item/completed' && item?.type === 'userMessage') log({event: 'userMessage', cwd, clientId: item.clientId})
    if (message.method === 'hook/completed') log({event: 'hook/completed', cwd, status: params.run?.status ?? params.status})
    if (fakeFor !== undefined && message.id === fakeFor && message.result?.thread?.id) {
      fakeFor = undefined
      const fake = {method: 'warning', params: {threadId: message.result.thread.id,
        message: '--dangerously-bypass-hook-trust is enabled (acceptance proxy: simulated; bypass_hook_trust was removed, so no hook runs)'}}
      log({event: 'fake-warning', cwd, threadId: message.result.thread.id})
      process.stdout.write(JSON.stringify(fake) + '\n')
    }
  })
}
