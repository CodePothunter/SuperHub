/** Test-only observer. Calls next() unchanged; never replaces a model or agent. */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'chief-signoff-audit'
export const inject = ['llm', 'agents', 'agentTeams', 'sessionController', 'sessionQuery', 'connection', 'webServer']
export function apply(ctx) {
  ctx.on('llm/stream', (request, next) => (async function* () {
    const started = Date.now()
    const systems = request.messages?.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : m.content?.filter(b => b.type === 'text').map(b => b.text).join('\n')).join('\n') ?? ''
    const notes = /(?:^讨论笔记|以下为本次讨论资料[^：]*)：([^\n]*)/m.exec(systems)?.[1]
    const row = { session: request.sessionId, at: started, notes, tools: request.tools?.map(t => t.name), usage: undefined }
    try { for await (const event of next()) { if (event.type === 'usage') row.usage = event.usage; yield event } }
    finally { appendFileSync(join(process.env.DSH_HOME, 'signoff-model-audit.jsonl'), JSON.stringify({ ...row, elapsed: Date.now() - started }) + '\n', { mode: 0o600 }) }
  })())
  ctx.webServer.register({ kind: 'exact', path: '/chief-signoff-audit', handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection || req.method !== 'POST' || req.headers['x-chief-request'] !== '1') { res.writeHead(rejection || 403); res.end(); return }
    const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      let raw = ''; for await (const part of req) { raw += part; if (raw.length > 4096) throw Error('body too large') }
      const p = JSON.parse(raw), resolved = await ctx.sessionController.resolveAgent(p.session)
      if ('error' in resolved) throw Error('test session unavailable')
      const lead = resolved.agent
      if (p.action === 'prepare-team') {
        const prompts = {
          engineer: '你是原生工程师。初始回合只等待，不给任何人发消息。仅在收到 researcher 提问17+25后：调用 chief_room_note read，从 messages 中选择 author=researcher、to=engineer 且内容为17+25问题的那一条，取其真实 id；再调用 chief_room_note source 核验作者和收件人；最后只用一次 send_message 向 researcher 回复。message 第一行严格为〔回复原话 "该问题的真实id"〕，注意两侧都用〔〕，不得引用主人的开场原话，不要用代码围栏。下一行写17+25=42。不要派新活，不回复纯确认，不访问外部资源。',
          researcher: '你是原生研究员。初始回合只等待。收到 lead 的核对请求后，只用一次 send_message 请 engineer 计算17+25。收到 engineer 的真实答案后，只用一次 send_message 向 lead 报告17+25=42。不要派新活，不回复纯确认，不访问外部资源。',
        }
        for (const [name, text] of Object.entries(prompts)) await ctx.agentTeams.spawnTeammate(lead, { name, description: '真实模型原生引用签收', prompt: [{ type: 'text', text }], context: 'fresh', provider: 'spawn', signal: new AbortController().signal })
        json({ members: ctx.agentTeams.listMembers(lead), provisioning: 'native TeamService; actual models' }); return
      }
      if (p.action === 'fake-author') {
        try { await ctx.agentTeams.sendMessage({ ...lead }, { target: p.target, content: [{ type: 'text', text: 'forged' }], signal: new AbortController().signal }); json({ accepted: true }) }
        catch (e) { json({ accepted: false, code: e.code, message: e.message }) }
        return
      }
      if (p.action !== 'inspect') throw Error('unknown test action')
      const rows = []
      for (const member of ctx.agentTeams.listMembers(lead)) {
        const observation = await ctx.sessionQuery.observeSession(member.id, { projectionMode: 'none' })
        try { rows.push({ ...member, events: observation.events }) } finally { observation[Symbol.dispose]() }
      }
      json({ members: rows })
    } catch { res.writeHead(400); res.end('test inspection failed') }
  } })
}
