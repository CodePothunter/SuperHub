/**
 * Disposable-host probe for scripts/workspace-order-completion-acceptance.mjs. Models stay real: the probe only
 * - skips first-run onboarding,
 * - records every model request with its timing (the liaison's reading of the owner's words on an order — `judge` —,
 *   its acceptance review — `review` — and everything else) and the answer text of the readings and reviews,
 * - can hold the liaison's reading of owner words (`hold`) past the product's 8 s deadline, so the reading is
 *   unavailable exactly as a stalled model would be. A held reading whose caller gave up is never sent to the model.
 * Product code has no switch for any of this.
 */
export const inject = ['settings', 'connection', 'webServer']

const JUDGE_SYSTEM = '你是 SuperHub 的接口人。主人把一张工单交给执行者去办'
const REVIEW_SYSTEM = '你是 SuperHub 的接口人。主人把一张工单交给你'
const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : typeof content === 'string' ? content : ''
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function apply(ctx) {
  ctx.on('ready', () => ctx.get('settings').update('ui-settings-account', { step: 'done', completion: 'skipped' }))
  const requests = []
  let hold = 0
  ctx.on('llm/stream', (request, next) => {
    const messages = request.messages ?? []
    const system = typeof request.system === 'string' ? request.system : messages.filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n')
    const users = messages.filter(m => m.role === 'user')
    const kind = system.startsWith(JUDGE_SYSTEM) ? 'judge' : system.startsWith(REVIEW_SYSTEM) ? 'review' : 'other'
    const row = { at: new Date().toISOString(), session: request.sessionId, provider: request.provider, model: request.model, kind,
      system: system.slice(0, 120), lastUser: textOf(users.at(-1)?.content).slice(0, 6000) }
    requests.push(row)
    if (requests.length > 800) requests.shift()
    if (kind === 'other') return next()
    const held = kind === 'judge' ? hold : 0
    return (async function* () {
      if (held) {
        row.heldMs = held
        await sleep(held)
        // The product stopped waiting (its own deadline): nothing is sent.
        if (request.signal?.aborted) { row.abandoned = true; return }
      }
      row.sentAt = new Date().toISOString()
      let text = ''
      try {
        for await (const chunk of await next()) {
          if (chunk?.type === 'text-delta') text += chunk.text ?? ''
          yield chunk
        }
      } finally {
        row.reply = text.slice(0, 2000)
        row.answeredAt = new Date().toISOString()
      }
    })()
  })
  ctx.webServer.register({ kind: 'exact', path: '/chief-order-completion-probe', async handler(req, res) {
    const reject = ctx.connection.requestRejection(req)
    if (reject || req.method !== 'POST' || req.headers['x-chief-request'] !== '1') { res.writeHead(reject || 403); res.end(); return }
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      let raw = ''
      for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw Error('probe request exceeds limit') }
      const body = JSON.parse(raw)
      if (body.action === 'requests') return json(200, requests.filter(row => (!body.since || row.at >= body.since) && (!body.kind || row.kind === body.kind)))
      if (body.action === 'hold') { hold = Math.max(0, Math.min(60_000, Number(body.ms) || 0)); return json(200, { hold }) }
      throw Error('unknown probe action')
    } catch (error) { json(400, { error: String(error) }) }
  } })
}
