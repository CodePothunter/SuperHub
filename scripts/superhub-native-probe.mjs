/** Disposable DSH plugin. In fixture mode only model responses are scripted. */
import { basename } from 'node:path'

export const inject = ['connection', 'llm', 'sessionQuery', 'subagents', 'webServer']
export const probePath = '/chief-superhub-native-probe'
export const localTask = 'SUPERHUB_PHASE_ZERO_LOCAL'
export const remoteTask = 'SUPERHUB_PHASE_ZERO_REMOTE'
export const remoteStaff = 'superhub-remote-probe'
export const artifact = 'phase-zero.md'
export const remoteArtifact = 'remote-report-1.md'
export const requiredLines = ['PHASE_ZERO_ALPHA', 'PHASE_ZERO_BETA']
export const remoteSummary = 'PHASE_ZERO_REMOTE_SUMMARY'

const knownTools = new Set(['read', 'write', 'edit', 'structured_output'])
const evidenceFiles = new Set([artifact, remoteArtifact])
const knownMarkers = [...requiredLines, remoteSummary]
const messageText = message => message.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''

function inputSource(message) {
  return { messageId: message.id, kind: message.source?.kind, rpcId: message.source?.rpcId, senderSessionId: message.source?.senderSessionId }
}

function toolArguments(name, raw) {
  let args
  try { args = JSON.parse(raw) } catch { return {} }
  if (!args || typeof args !== 'object') return {}
  if (name === 'structured_output') {
    if (['revise', 'pass', 'fail'].includes(args.verdict)) return { verdict: args.verdict }
    if (['ready', 'failed'].includes(args.status)) return { status: args.status }
    return {}
  }
  return typeof args.file_path === 'string' && evidenceFiles.has(basename(args.file_path))
    ? { file: basename(args.file_path) }
    : {}
}

function projectEvent(event) {
  const row = { seq: event.seq, time: event.time, type: event.type }
  const data = event.data
  switch (event.type) {
    case 'turn/start': return { ...row, turn: data.turn }
    case 'turn/end': return { ...row, turn: data.turn, reason: data.reason?.kind }
    case 'subagent/descriptor': return { ...row, version: data.version, mode: data.mode, provider: data.provider }
    case 'model/selection': return { ...row, provider: data.provider, model: data.model }
    case 'user/message': return { ...row, ...inputSource(data) }
    case 'agent/inbox/spliced': return { ...row, target: data.target, inserted: data.inserted.map(inputSource) }
    case 'tool/call': return {
      ...row, turn: data.turn, step: data.step, callId: data.callId,
      name: knownTools.has(data.name) ? data.name : 'other', ...toolArguments(data.name, data.arguments),
    }
    case 'tool/result': return {
      ...row, turn: data.turn, step: data.step, callId: data.message.toolCallId,
      sourceCallId: data.message.source?.callId,
      error: data.message.isError === true,
      markers: knownMarkers.filter(marker => messageText(data.message).includes(marker)),
    }
    default: return undefined
  }
}

function fixtureTool(messages) {
  const prompt = messages.filter(message => message.role === 'user').map(messageText).join('\n')
  const toolResult = id => messages.find(message => message.role === 'tool' && message.toolCallId === id)
  const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
  const finish = args => call('fixture-finish', 'structured_output', args)

  if (prompt.includes('负责研判一条新事件')) {
    const event = prompt.split('## 新事件').at(-1)?.split('## 判断规则')[0]
    if (event?.includes(remoteTask)) return finish({
      action: 'accept', reason: '隔离的显式点名交办', title: remoteTask, staff: remoteStaff, level: 'think',
      scope: `仅回传隔离摘要 ${remoteTask}`, doneWhen: [`回传摘要包含 ${remoteSummary}`], needsReview: true,
    })
    return finish({ action: 'ignore', reason: '本次夹具只执行显式隔离工单' })
  }

  if (prompt.includes('你是独立的审查官。') && (prompt.includes(localTask) || prompt.includes(remoteTask))) {
    const remote = prompt.includes(remoteTask)
    const inspected = toolResult('fixture-review-read')
    if (!inspected) return call('fixture-review-read', 'read', { file_path: remote ? remoteArtifact : artifact })
    const text = messageText(inspected)
    if (inspected.isError || !text.includes(remote ? remoteSummary : requiredLines[0])) {
      return finish({ verdict: 'fail', critique: '无法读取并确认隔离交付的基本内容。' })
    }
    if (!remote && !text.includes(requiredLines[1])) {
      return finish({ verdict: 'revise', critique: `读取实际交付后发现缺少 ${requiredLines[1]}，请补齐。` })
    }
    return finish({ verdict: 'pass', critique: remote ? '已核验收到的摘要标记。' : '实际文件包含两条完成标准。' })
  }

  if (prompt.includes('## 工单 T-') && prompt.includes(localTask)) {
    if (!toolResult('fixture-initial-read')) return call('fixture-initial-read', 'read', { file_path: artifact })
    const revised = prompt.includes('审查：revise')
    const content = (revised ? requiredLines : requiredLines.slice(0, 1)).join('\n') + '\n'
    if (!toolResult('fixture-write')) return call('fixture-write', 'write', { file_path: artifact, content })
    const checked = toolResult('fixture-read-back')
    if (!checked) return call('fixture-read-back', 'read', { file_path: artifact })
    if (checked.isError || !messageText(checked).includes(requiredLines[0])) {
      return finish({ status: 'failed', summary: '隔离产物写入或回读失败。' })
    }
    return finish({ status: 'ready', summary: '已交付隔离文本，请按标准读取核验。', outputs: [artifact] })
  }

  return { type: 'text', text: '隔离验收夹具已收到。' }
}

async function* modelResponse(block) {
  yield { type: 'block-start', index: 0, blockType: block.type }
  if (block.type === 'tool-call') {
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
  } else {
    yield { type: 'text-delta', index: 0, text: block.text }
  }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
}

export function apply(ctx) {
  const live = new Map()
  const routes = new Map()
  ctx.on('session/event', (session, event) => {
    const fact = projectEvent(event)
    if (!fact) return
    const rows = live.get(session.id) ?? []
    rows.push({ ...fact, observedAt: Date.now() })
    live.set(session.id, rows)
  })
  ctx.on('llm/stream', (request, next) => {
    if (request.sessionId) routes.set(request.sessionId, { provider: request.provider, model: request.model })
    return process.env.CHIEF_SUPERHUB_REAL_MODEL === '1' ? next() : modelResponse(fixtureTool(request.messages))
  })

  ctx.webServer.register({ kind: 'exact', path: probePath, async handler(req, res) {
    const reject = ctx.connection.requestRejection(req)
    if (reject || req.method !== 'POST' || req.headers['x-chief-request'] !== '1') {
      res.writeHead(reject || 403)
      res.end()
      return
    }
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    try {
      let input = ''
      for await (const chunk of req) {
        input += chunk
        if (input.length > 4096) return json(400, { error: 'probe request exceeds limit' })
      }
      const { sessions } = JSON.parse(input)
      if (!Array.isArray(sessions) || sessions.length > 12 || !sessions.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id))) {
        return json(400, { error: 'invalid probe session IDs' })
      }
      const observed = []
      for (const sessionId of sessions) {
        let history
        try {
          const result = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none', signal: AbortSignal.timeout(8_000) })
          try { history = { available: true, events: result.events.map(projectEvent).filter(Boolean) } }
          finally { result[Symbol.dispose]() }
        } catch {
          history = { available: false, events: [] }
        }
        observed.push({ sessionId, live: live.get(sessionId) ?? [], history, route: routes.get(sessionId) })
      }
      const spawn = ctx.subagents.getProvider('spawn')
      return json(200, { observed, capabilities: {
        spawn: spawn ? { outputSchema: spawn.capabilities.outputSchema, agentOptions: spawn.capabilities.agentOptions } : null,
        claudeCodeInstalled: !!ctx.subagents.getProvider('claude-code'),
      } })
    } catch {
      return json(400, { error: 'could not read probe request' })
    }
  } })
}
