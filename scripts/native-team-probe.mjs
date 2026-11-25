/** Test-only host plugin, installed only in the disposable smoke-test DSH_HOME. */
export const name = 'chief-native-team-probe'
export const inject = ['agentTeams', 'sessionController', 'webServer', 'connection', 'agents', 'sessionQuery', 'llm', 'subagents']
export function apply(ctx) {
  // Keep only fixture-native turns alive long enough to inspect transport, without a model account.
  ctx.on('llm/stream', (request, next) => {
    const candidate = ctx.agents.get(request.sessionId)
    if (!candidate || !ctx.agentTeams.tryMembership(candidate)?.root.id.startsWith('chief-room-')) return next()
    return (async function* () {
      await new Promise(resolve => setTimeout(resolve, 5000))
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })
  ctx.webServer.register({ kind: 'exact', path: '/chief-native-team-probe', handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection || req.method !== 'POST' || req.headers['x-chief-request'] !== '1') { res.writeHead(rejection || 403); res.end(); return }
    try {
      let raw = ''; for await (const part of req) { raw += part; if (raw.length > 4096) throw new Error('body too large') }
      const { session } = JSON.parse(raw)
      const resolved = await ctx.sessionController.resolveAgent(session)
      if ('error' in resolved) throw new Error('lead unavailable')
      const lead = resolved.agent
      const signal = new AbortController().signal
      for (const name of ['researcher', 'engineer']) {
        if (!ctx.agentTeams.listMembers(lead).some(m => m.name === name)) await ctx.agentTeams.spawnTeammate(lead, { name, description: 'Native transport acceptance fixture', prompt: [{ type: 'text', text: 'Transport fixture. No external operations.' }], context: 'fresh', provider: 'spawn', signal })
      }
      const members = ctx.agentTeams.listMembers(lead)
      const researcher = { agent: ctx.agents.get(members.find(m => m.name === 'researcher').id) }
      const engineerId = members.find(m => m.name === 'engineer').id
      if (!researcher.agent) throw new Error('native child unavailable: ' + JSON.stringify(members))
      const humanRequest = { requestId: 'native-human-request', parentSessionId: lead.id, childSessionId: engineerId, mode: 'continuable', delivery: 'steer', content: [{ type: 'text', text: 'native-human-acceptance-message' }] }
      const human = await ctx.subagents.prompt(humanRequest, signal)
      const receipt = await ctx.agentTeams.sendMessage(researcher.agent, { target: 'engineer', content: [{ type: 'text', text: 'native-a2a-acceptance-message' }], signal })
      const observation = await ctx.sessionQuery.observeSession(engineerId, { projectionMode: 'none' })
      const events = observation.events
      observation[Symbol.dispose]()
      const inputs = events.flatMap(e => e.type === 'agent/inbox/spliced' ? e.data.inserted : e.type === 'user/message' ? [e.data] : [])
      const received = inputs.some(m => m.source?.kind === 'agent-message' && m.source.senderSessionId === researcher.agent.id)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ members: members.map(m => ({ id: m.id, name: m.name })), receipt: receipt.messageId, received, humanAccepted: !!human.messageId, humanCount: new Set(inputs.filter(m => m.source?.kind === 'user' && m.source.rpcId === 'native-human-request').map(m => m.id)).size }))
    } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })) }
  } })
}
