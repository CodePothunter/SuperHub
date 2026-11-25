/** Installed only in a disposable host. Team calls, tool dispatch and inboxes are native. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
export const inject = ['agents', 'agentTeams', 'connection', 'llm', 'sessionController', 'sessionQuery', 'sessions', 'subagents', 'tools', 'webServer', 'workspaceRegistry']

export function apply(ctx) {
  const active = new Map(), calls = new Map(), batches = new Map()
  const credentialProbe = process.env.CHIEF_PROBE_FILE ? readFileSync(process.env.CHIEF_PROBE_FILE, 'utf8') : undefined
  const noop = name => ctx.tools.register({
    name, description: '验收用无副作用探针', parameters: { type: 'object' }, output: { schema: { type: 'object' }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async () => { batches.set(name, (batches.get(name) ?? 0) + 1); return { ran: true } },
  })
  for (const name of ['fixture_write', 'fixture_read_named_write', 'remote_fixture_forward']) noop(name)
  if (process.env.CHIEF_ACCEPTANCE_REAL_MODEL !== '1') ctx.on('llm/stream', (request, next) => {
    const agent = ctx.agents.get(request.sessionId)
    if (!agent) return next()
    calls.set(agent.id, (calls.get(agent.id) ?? 0) + 1)
    return (async function* () {
      const gate = active.get(agent.id)
      if (gate) { gate.started = true; await gate.promise }
      let text = '原生验收回合完成'
      const input = JSON.stringify(request.messages)
      if (input.includes('T10_READONLY_LOOKUP')) text = 'fixture reply'
      if (input.includes('T09_PERSONAL_DECISION')) text = '请主人决定测试窗口是否为周四。'
      if (input.includes('已拒绝，请说明依据缺口')) text = '仓库未获授权，现阶段只保留可见公共依据。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 2100, outputTokens: 16, totalTokens: 2116 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })

  ctx.webServer.register({ kind: 'exact', path: '/chief-acceptance-surface', async handler(req, res) {
    const reject = ctx.connection.requestRejection(req)
    if (reject || req.method !== 'POST' || req.headers['x-chief-request'] !== '1') { res.writeHead(reject || 403); res.end(); return }
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      let raw = ''
      for await (const chunk of req) { raw += chunk; if (raw.length > 200000) throw Error('acceptance request exceeds limit') }
      const body = JSON.parse(raw), signal = AbortSignal.timeout(16000)
      if (body.action === 'complete-test-onboarding') {
        await ctx.get('settings').update('ui-settings-account', { step: 'done', completion: 'skipped' })
        return json(200, { complete: true })
      }
      if (body.action === 'observe') {
        const observation = await ctx.sessionQuery.observeSession(body.session, { projectionMode: 'none', signal })
        try {
          return json(200, { messageHits: Object.fromEntries(body.markers.map(marker => [marker, observation.events.some(event =>
            ['user/message', 'system/message'].includes(event.type) && JSON.stringify(event.data).includes(marker))])),
          toolCalls: observation.events.filter(event => event.type === 'tool/call').map(event => event.data.name) })
        } finally { observation[Symbol.dispose]() }
      }
      if (body.action === 'create-root') {
        const workspace = await ctx.workspaceRegistry.create(body.brain, '验收用第二大脑')
        await ctx.sessionController.create({ sessionId: body.session, workspaceId: workspace.id, title: body.session })
      }
      const resolved = await ctx.sessionController.resolveAgent(body.session)
      if ('error' in resolved) throw Error('native session unavailable')
      const lead = resolved.agent
      if (body.action === 'create-root') return json(200, { session: lead.id })
      if (body.action === 'policy') return json(200, {
        visible: !!ctx.tools.get(body.name, lead), guard: ctx.tools.checkGuards({ agent: lead, name: body.name }),
      })
      const member = name => {
        const found = ctx.agentTeams.listMembers(lead).find(m => m.name === name)
        if (!found) throw Error('native test member unavailable')
        return found
      }
      async function hold(name) {
        if (!name || name === 'lead') return lead
        const row = member(name)
        if (!ctx.agents.get(row.id)) {
          if (!active.has(row.id)) {
            let release
            const promise = new Promise(resolve => { release = resolve })
            active.set(row.id, { release, promise })
            await ctx.subagents.prompt({ requestId: 'fixture-' + randomUUID(), parentSessionId: lead.id, childSessionId: row.id,
              mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: '验收控制回合' }] }, signal)
          }
          for (let i = 0; i < 150 && !active.get(row.id)?.started; i++) await new Promise(resolve => setTimeout(resolve, 25))
        }
        const agent = ctx.agents.get(row.id)
        if (!agent) throw Error('native test member did not hydrate')
        return agent
      }
      if (body.action === 'arm') {
        let release
        const promise = new Promise(resolve => { release = resolve })
        active.set(member(body.actor ?? 'lead').id, { release, promise })
        return json(200, { armed: true })
      }
      if (body.action === 'flush') {
        await ctx.sessions.flush(lead.session)
        return json(200, { flushed: true, gated: !!active.get(lead.id)?.started })
      }
      if (body.action === 'task') {
        const agent = await hold(body.actor)
        const result = body.update ? await ctx.agentTeams.updateTask(agent, body.update) : await ctx.agentTeams.createTask(agent, body.task)
        return json(200, result)
      }
      if (body.action === 'spawn') {
        for (const name of body.names) await ctx.agentTeams.spawnTeammate(lead, { name, description: '隔离验收成员',
          prompt: [{ type: 'text', text: '验收用启动，保持原生会话。' }], context: 'fresh', provider: 'spawn', signal })
        return json(200, { members: ctx.agentTeams.listMembers(lead) })
      }
      if (body.action === 'release') {
        for (const name of body.names) {
          const id = member(name).id
          active.get(id)?.release(); active.delete(id)
        }
        return json(200, { released: true })
      }
      if (body.action === 'send') {
        const sender = await hold(body.actor)
        await ctx.agentTeams.sendMessage(sender, { target: body.target, content: [{ type: 'text', text: body.text }], signal })
        return json(200, { from: sender.id })
      }
      if (body.action === 'seed') {
        const agent = await hold(body.actor)
        agent.send({ id: randomUUID(), role: 'user', source: { kind: 'user', rpcId: body.rpcId ?? randomUUID() },
          content: [{ type: 'text', text: body.text }] }, 'next-turn', false)
        await ctx.sessions.flush(agent.session)
        return json(200, { agent: agent.id })
      }
      if (body.action === 'tool') {
        const agent = await hold(body.actor)
        const { results } = await ctx.tools.execute({ agent, signal, calls: [{ type: 'tool-call', id: 'acceptance-' + randomUUID(), name: body.name, arguments: JSON.stringify(body.args ?? {}) }] })
        const result = results[0].result
        const serialized = JSON.stringify(result)
        if (credentialProbe && serialized.includes(credentialProbe)) return json(200, { ok: !result.isError, credentialHit: true })
        return json(200, result.isError ? { ok: false, message: result.error.message, code: result.error.code } : { ok: true, value: result.value })
      }
      if (body.action === 'snapshot') {
        const rows = []
        for (const member of ctx.agentTeams.listMembers(lead)) {
          const observation = await ctx.sessionQuery.observeSession(member.id, { projectionMode: 'none', signal })
          try {
            const snapshot = observation.events
            rows.push({ name: member.name, id: member.id, status: member.status, calls: calls.get(member.id) ?? 0,
              credentialHit: !!credentialProbe && JSON.stringify(snapshot).includes(credentialProbe),
              inputIds: snapshot.filter(e => e.type === 'user/message').flatMap(e => e.data.source?.rpcId ? [e.data.source.rpcId] : []),
              peerInputs: snapshot.filter(e => e.type === 'user/message' && e.data.source?.kind === 'agent-message').flatMap(e =>
                e.data.content.filter(block => block.type === 'text').map(block => block.text)) })
          } finally { observation[Symbol.dispose]() }
        }
        return json(200, { members: rows, noops: Object.fromEntries(batches) })
      }
      throw Error('unknown acceptance action')
    } catch (error) { json(400, { error: String(error) }) }
  } })
}
