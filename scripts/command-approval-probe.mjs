/** Model fixture only. Shell, sandbox, audit and grants run in the DSH host. */
import { join } from 'node:path'

export const inject = ['agents', 'connection', 'llm', 'webServer']

export function apply(ctx) {
  const steps = new Map(), tickets = new Map(), events = []
  ctx.on('session/event', (session, event) => {
    const ticket = tickets.get(session.id)
    if (!ticket) return
    if (event.type === 'approval/asked') events.push({ ticket, kind: 'asked', id: event.data.id })
    if (event.type === 'approval/decided') events.push({ ticket, kind: 'decided', id: event.data.id, outcome: event.data.outcome })
    if (event.type === 'tool/result') {
      const value = JSON.stringify(event.data)
      events.push({ ticket, kind: 'tool', sandboxDenied: /file access denied under|Permission denied|Read-only file system/.test(value) })
    }
  })
  ctx.webServer.register({ kind: 'exact', path: '/chief-command-approval-probe', handler(req, res) {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection) { res.writeHead(rejection); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(events))
  } })
  ctx.on('llm/stream', (request, next) => {
    const agent = ctx.agents.get(request.sessionId)
    if (!agent) return next()
    const ticket = JSON.stringify(request.messages).match(/## 工单 (T-004[123])：/)?.[1]
    const step = steps.get(agent.id) ?? 0
    if (ticket) { tickets.set(agent.id, ticket); steps.set(agent.id, step + 1) }
    return (async function* () {
      const maxCalls = ticket === 'T-0041' ? 3 : 1
      if (ticket && step < maxCalls) {
        const path = join(process.env.CHIEF_APPROVAL_TEST_DIR, ticket + (step === 2 ? '-next' : '') + '.txt')
        const command = `printf 'sandbox-fixture\\n' > '${path.replaceAll("'", "'\\''")}'`
        const ask = ticket !== 'T-0041' || step === 1
        const args = { command, description: '验证隔离文件写入', ...(ask ? { sandbox_permissions: 'danger-full-access', justification: '验收命令只写入隔离目录中的一个标记文件。' } : {}) }
        const call = { type: 'tool-call', id: `bash-fixture-${step}`, name: 'bash', arguments: JSON.stringify(args) }
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
        yield { type: 'block-end', index: 0, block: call }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = '隔离命令审批场景结束。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })
}
