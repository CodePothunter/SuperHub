/** Test-only observation and native session access. All model streams pass through unchanged. */
import { randomUUID } from 'node:crypto'
export const inject = ['agents', 'agentTeams', 'connection', 'llm', 'sessionController', 'sessions', 'tools', 'webServer', 'workspaceRegistry']

export function apply(ctx) {
  const watches = new Map()
  ctx.tools.guard(execution => {
    const watch = watches.get(execution.agent?.id)
    if (!watch) return undefined
    const action = execution.arguments?.action
    if (watch.allowed.includes(execution.name) && ['list', 'read', 'source', 'work', 'delivery'].includes(action)) return undefined
    watch.denied.push(execution.name)
    return '本次对照只允许使用这一组已指定的只读资料。'
  })
  ctx.on('llm/stream', (request, next) => {
    const measure = watches.get(request.sessionId)?.steps
    const input = JSON.stringify(request.messages)
    if (!measure || !input.includes('T13 验收评分约定')) return next()
    const entry = { tools: request.tools?.map(tool => tool.name) ?? [], secretHit: /T13-NONPUBLIC-[A-D]/.test(input), elapsedMs: 0, usage: null }
    measure.push(entry)
    return (async function* () {
      const start = Date.now()
      try {
        for await (const chunk of next()) { if (chunk.type === 'usage') entry.usage = chunk.usage; yield chunk }
      } finally { entry.elapsedMs = Date.now() - start }
    })()
  })
  ctx.webServer.register({ kind: 'exact', path: '/chief-memory-acceptance', async handler(req, res) {
    const reject = ctx.connection.requestRejection(req)
    if (reject || req.method !== 'POST' || req.headers['x-chief-request'] !== '1') { res.writeHead(reject || 403); res.end(); return }
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      let raw = ''
      for await (const chunk of req) { raw += chunk; if (raw.length > 300000) throw Error('acceptance request exceeds limit') }
      const body = JSON.parse(raw)
      if (body.action === 'create') {
        const workspace = await ctx.workspaceRegistry.create(body.brain, '验收用第二大脑')
        await ctx.sessionController.create({ sessionId: body.session, workspaceId: workspace.id, title: body.session })
      }
      const resolved = await ctx.sessionController.resolveAgent(body.session)
      if ('error' in resolved) throw Error('native session unavailable')
      const { agent } = resolved
      if (body.action === 'seed') {
        agent.send({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: body.text }], source: { kind: 'user', rpcId: randomUUID() } }, 'next-turn', false)
        await ctx.sessions.flush(agent.session)
      }
      if (body.action === 'begin') {
        watches.set(agent.id, { steps: [], allowed: body.tools, denied: [] })
        agent.ctx.systemPrompt.section({ name: 'chief-memory-acceptance', order: 9905, interpolate: false, text: body.instructions })
        agent.ctx.tools.restrict({ allow: body.tools })
        await ctx.sessionController.prompt({ requestId: randomUUID(), sessionId: agent.id, mode: 'queue', content: [{ type: 'text', text: body.question }] }, AbortSignal.timeout(10000))
      }
      const events = agent.session.snapshotEvents()
      const answer = events.filter(e => e.type === 'assistant/message').map(e => e.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('')).filter(Boolean).at(-1)
      const indexResults = events.filter(e => e.type === 'tool/result').flatMap(e => e.data.message.content.filter(b => b.type === 'text').flatMap(b => {
        try { const value = JSON.parse(b.text); return typeof value.usedBytes === 'number' ? [value.usedBytes] : [] } catch { return [] }
      }))
      json(200, { id: agent.id, status: agent.status, answer, end: events.findLast(e => e.type === 'turn/end')?.data.reason?.kind,
        requests: watches.get(agent.id)?.steps, denied: watches.get(agent.id)?.denied, indexResults })
    } catch (error) { json(400, { error: String(error) }) }
  } })
}
