/**
 * Deterministic model responses for disposable DSH acceptance sessions.
 *
 * The liaison is scripted per exact owner phrase: a test first declares (`teach`) which tools the liaison
 * calls for that phrase and with what structured understanding, then sends the phrase through the real
 * owner entry point (scoped web chat or SuperHub intake). The system never interprets the words itself.
 */
export const inject = ['llm', 'connection', 'webServer']
// This preset is enabled only in the disposable human-study host. Automated
// regression defaults remain unchanged; both use the same real tool/review flow.
export const humanScenario = {
  id: 'customer-records-v1', marker: '客户交付报告', artifact: '客户交付报告.md',
  lines: ['- 晨光商贸：交付范围已核对，客户登记完整。', '- 远航科技：交付范围已核对，客户登记完整。'],
}
const human = process.env.CHIEF_ACCEPTANCE_HUMAN === '1'
export const localMarker = human ? humanScenario.marker : 'SUPERHUB_VERTICAL_LOCAL'
export const artifact = human ? humanScenario.artifact : 'vertical-proof.md'
export const lines = human ? humanScenario.lines : ['VERTICAL_ALPHA', 'VERTICAL_BETA']
export const remoteMarker = 'SUPERHUB_VERTICAL_REMOTE'
export const remoteStaff = 'vertical-remote'
export const remoteSummary = 'VERTICAL_REMOTE_SUMMARY'
export const nativeMemoMarker = 'SUPERHUB_VERTICAL_NATIVE_MEMO'

const messageText = row => row?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
const PROBE = '/chief-superhub-probe'

/** Declare the liaison's tool calls for one exact owner phrase. `calls` is a list of [toolName, args]. */
export const teach = (host, said, calls) => host.request(PROBE, { action: 'teach', said, calls })

/** Wait until the liaison has registered `count` receipts under the owner's original receipt. */
export async function liaisonWork(host, scope, receiptId, count = 1, ready = row => row.items.every(item => item.state !== 'dispatching'), timeout = 30_000) {
  const { until } = await import('./acceptance-host.mjs')
  return until(async () => {
    const view = await host.api(`/superhub/items/${receiptId}?${new URLSearchParams({ scope })}`)
    return view.linked?.length >= count && view.linked.every(ready) ? view : undefined
  }, `接口人为回执 ${receiptId} 登记 ${count} 项`, timeout)
}

/** The read task the acceptance scripts hand to the researcher through the liaison. */
export const archiveWork = (label = '') => ({ text: `检查归档区 ${localMarker}${label ? ` ${label}` : ''}：在工单目录用原生工具写入 ${artifact}，首轮写入 ${lines[0]}，收到独立审查返工后补齐 ${lines[1]}；两轮都回读实际内容并在 outputs 登记文件。`,
  title: `核对归档区 ${localMarker}${label ? ` ${label}` : ''}`, staff: 'researcher', operation: 'read' })

const plans = new Map()
/** The liaison turn: the latest owner message selects the declared calls; each call runs once per owner message. */
function liaison(messages) {
  const owners = messages.filter(row => row.role === 'user' && row.source?.kind === 'user')
  const last = owners.at(-1)
  const said = messageText(last).trim()
  const steps = plans.get(said)
  if (!steps) return { type: 'text', text: '隔离验收接口人收到。' }
  const start = messages.lastIndexOf(last)
  const answered = new Map(messages.slice(start).filter(row => row.role === 'tool').map(row => [row.toolCallId, messageText(row)]))
  const prefix = `liaison-${owners.length}`
  const index = steps.findIndex((_, step) => !answered.has(`${prefix}-${step}`))
  if (index < 0) return { type: 'text', text: `已按主人原话处理：${[...answered.values()].map(value => value.slice(0, 120)).join(' | ')}` }
  const [name, args] = steps[index]
  return call(`${prefix}-${index}`, name, args)
}
const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const finish = args => call('fixture-finish', 'structured_output', args)

function fixture(messages, sessionId = '') {
  if (sessionId.startsWith('chief-liaison')) return liaison(messages)
  const prompt = messages.filter(row => row.role === 'user').map(messageText).join('\n')
  const result = id => messages.find(row => row.role === 'tool' && row.toolCallId === id)
  if (prompt.includes('负责研判一条新事件')) {
    const origin = prompt.split('## 新事件').at(-1)?.split('## 判断规则')[0]
    if (!origin?.includes(remoteMarker)) return finish({ action: 'ignore', reason: '本次只处理显式的隔离远程样本' })
    return finish({ action: 'accept', reason: '对指定工作电脑的独立交办', title: remoteMarker, staff: remoteStaff,
      level: 'think', scope: `仅通过工作电脑回传摘要 ${remoteSummary}`, doneWhen: [`回传摘要包括 ${remoteSummary}`], needsReview: true })
  }
  if (prompt.includes('你是独立审查官。') && prompt.includes(localMarker)) {
    const registered = /已验证版本及内容[^\n]*\n([^\n]+)/.exec(prompt)?.[1]
    const delivery = registered ? JSON.parse(registered).find(row => row.path.endsWith('/' + artifact)) : undefined
    const criterionId = /(?:^|\n)- ([A-Za-z0-9_-]+)（必要，登记的产物版本）/.exec(prompt)?.[1] ?? 'C-01'
    if (!result('fixture-review-read')) return call('fixture-review-read', 'read', { file_path: artifact })
    const proof = messageText(result('fixture-review-read'))
    const references = delivery && proof.includes(lines[0]) ? [{ path: delivery.path, version: delivery.version }] : []
    const status = !references.length ? 'unverified' : lines.every(line => proof.includes(line)) ? 'pass' : 'fail'
    return finish({ critique: status === 'pass' ? '核对当前登记内容，要求的两条记录均存在。' : '实际文件缺少所需记录，请补齐后重交。',
      criteria: [{ criterionId, status, evidence: references, comment: '使用原生 read 回读登记的交付文件。' }] })
  }
  if (prompt.includes('你是独立的审查官。') && prompt.includes(remoteMarker)) {
    if (!result('fixture-remote-read')) return call('fixture-remote-read', 'read', { file_path: 'remote-report-1.md' })
    const found = messageText(result('fixture-remote-read')).includes(remoteSummary)
    return finish({ verdict: found ? 'pass' : 'fail', critique: found ? '已核对收到的隔离摘要。' : '缺少隔离摘要。' })
  }
  if (prompt.includes('## 工单 T-') && prompt.includes(localMarker)) {
    if (!result('fixture-before-read')) return call('fixture-before-read', 'read', { file_path: artifact })
    const repaired = /审查：revise/.test(prompt)
    if (repaired && lines.every(line => messageText(result('fixture-before-read')).includes(line))) {
      return finish({ status: 'ready', summary: human ? '两条客户登记已补齐并回读核对，报告可供验收。' : '已再次回读现存交付并登记这一轮版本。', outputs: [artifact] })
    }
    const content = (repaired ? lines : lines.slice(0, 1)).join('\n') + '\n'
    if (!result('fixture-deliver')) {
      return repaired && !result('fixture-before-read')?.isError
        ? call('fixture-deliver', 'edit', { file_path: artifact, old_string: lines[0] + '\n', new_string: content })
        : call('fixture-deliver', 'write', { file_path: artifact, content })
    }
    if (!result('fixture-after-read')) return call('fixture-after-read', 'read', { file_path: artifact })
    if (result('fixture-deliver').isError || !messageText(result('fixture-after-read')).includes(lines[0])) {
      return finish({ status: 'failed', summary: '隔离产物写入或回读失败。' })
    }
    return finish({ status: 'ready', summary: human
      ? repaired ? '两条客户登记已补齐并回读核对，报告可供验收。' : '已写入晨光商贸登记，正在核对客户登记是否齐全。'
      : '已回读隔离产物并提交版本。', outputs: [artifact] })
  }
  return { type: 'text', text: '隔离验收模型收到消息。' }
}

async function* stream(block) {
  yield { type: 'block-start', index: 0, blockType: block.type }
  if (block.type === 'tool-call') {
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
  } else yield { type: 'text-delta', index: 0, text: block.text }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
}

export function apply(ctx) {
  ctx.on('llm/stream', (request, next) => process.env.CHIEF_SUPERHUB_REAL_MODEL === '1' ? next() : stream(fixture(request.messages, request.sessionId)))
  ctx.webServer.register({ kind: 'exact', path: PROBE, async handler(req, res) {
    const reject = ctx.connection.requestRejection(req)
    if (reject || req.method !== 'POST' || req.headers['x-chief-request'] !== '1') { res.writeHead(reject || 403); res.end(); return }
    try {
      let raw = ''
      for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw Error('probe request exceeds limit') }
      const body = JSON.parse(raw)
      if (body.action !== 'teach' || typeof body.said !== 'string' || !Array.isArray(body.calls)) throw Error('unknown probe action')
      plans.set(body.said.trim(), body.calls)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
    } catch (error) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })) }
  } })
}
