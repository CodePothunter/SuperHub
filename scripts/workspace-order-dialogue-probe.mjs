/**
 * Disposable-host probe for scripts/workspace-order-dialogue-acceptance.mjs. Models stay real: the probe only
 * - skips first-run onboarding,
 * - records every model request (session, system prompt head, last user text) and the tool calls the liaison made,
 * - can hold the liaison's acceptance review for a while (`hold`), so the owner can speak while a review is pending.
 * The hold delays the review request before it reaches the model; product code has no switch for it.
 */
export const inject = ['settings', 'connection', 'webServer']

const REVIEW_SYSTEM = '你是 SuperHub 的接口人。主人把一张工单交给你'
const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : typeof content === 'string' ? content : ''
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function apply(ctx) {
  ctx.on('ready', () => ctx.get('settings').update('ui-settings-account', { step: 'done', completion: 'skipped' }))
  const requests = []
  const calls = new Map()
  let hold = 0
  function observe(sessionId, messages) {
    let owner
    for (const message of messages) {
      if (message.role === 'user' && message.source?.kind === 'user') owner = textOf(message.content).trim()
      if (message.role === 'assistant') for (const block of message.content ?? []) {
        if (block.type !== 'tool-call') continue
        const id = sessionId + '\u0000' + block.id
        if (!calls.has(id)) calls.set(id, { order: calls.size, session: sessionId, callId: block.id, owner, name: block.name, arguments: block.arguments })
      }
      if (message.role === 'tool') {
        const row = calls.get(sessionId + '\u0000' + message.toolCallId)
        if (row && row.text === undefined) Object.assign(row, { isError: message.isError === true, text: textOf(message.content).slice(0, 4000) })
      }
    }
  }
  ctx.on('llm/stream', (request, next) => {
    const messages = request.messages ?? []
    const system = typeof request.system === 'string' ? request.system : messages.filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n')
    const users = messages.filter(m => m.role === 'user')
    const row = { at: new Date().toISOString(), session: request.sessionId, provider: request.provider, model: request.model,
      review: system.startsWith(REVIEW_SYSTEM), system: system.slice(0, 160), lastUser: textOf(users.at(-1)?.content).slice(0, 6000),
      users: users.length, userTexts: users.map(m => textOf(m.content)).join('\n---\n').slice(-30_000) }
    try { observe(request.sessionId, messages) } catch { /* recording never changes the run */ }
    requests.push(row)
    if (requests.length > 600) requests.shift()
    if (!row.review) return next()
    const held = hold
    return (async function* () {
      if (held) { row.heldMs = held; await sleep(held) }
      row.sentAt = new Date().toISOString()
      let text = ''
      for await (const chunk of await next()) {
        if (chunk?.type === 'text-delta') text += chunk.text ?? ''
        yield chunk
      }
      row.reply = text.slice(0, 4000)
      row.answeredAt = new Date().toISOString()
    })()
  })
  ctx.webServer.register({ kind: 'exact', path: '/chief-order-dialogue-probe', async handler(req, res) {
    const reject = ctx.connection.requestRejection(req)
    if (reject || req.method !== 'POST' || req.headers['x-chief-request'] !== '1') { res.writeHead(reject || 403); res.end(); return }
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      let raw = ''
      for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw Error('probe request exceeds limit') }
      const body = JSON.parse(raw)
      if (body.action === 'requests') return json(200, requests.filter(row => !body.since || row.at >= body.since))
      if (body.action === 'calls') return json(200, [...calls.values()].sort((a, b) => a.order - b.order))
      if (body.action === 'hold') { hold = Math.max(0, Math.min(120_000, Number(body.ms) || 0)); return json(200, { hold }) }
      throw Error('unknown probe action')
    } catch (error) { json(400, { error: String(error) }) }
  } })
}
