/**
 * Disposable-host probe for scripts/liaison-core-regression.mjs. Only the model is scripted:
 * the liaison and discussion lead "decide" to call chief tools with the arguments the real
 * liaison used on 2026-11-19. DSH runs every call through its own tool pipeline (argument
 * validation, guards, lossless JSON snapshot), exactly as it did for the owner.
 *
 * CHIEF_ACCEPTANCE_REAL_MODEL=1 disables the script; the probe then only records which tools
 * a real model called and what each call returned.
 */
import { randomUUID } from 'node:crypto'

export const inject = ['agents', 'connection', 'sessionController', 'tools', 'webServer']

/** The liaison's brief from production ticket T-0020 (2026-11-19 20:58). Its 「分别」 once became 「禁止：别汇报…」. */
export const T0020_BRIEF = '请每位幕僚分别汇报当前实际使用的模型供应商、模型名称和执行器；无法获知时明确标注，不要猜测。汇总包括研判官、工程师、外务、研究员、审查官、书记官、谋士和界面师。'
/** The staff the discussion lead spawned in production room ticket-T-0020 (21:07), plus the researcher. */
export const ROOM_MEMBERS = ['chief', 'engineer', 'liaison', 'reviewer', 'scribe', 'strategist', 'researcher']
export const SELF_REPORT = '〔模型自述〕'
export const INTRO_REQUEST = '让他们自我介绍一下'
export const INTRO_TITLE = '幕僚团自我介绍'
export const INTRO_ANSWERS = {
  chief: '研判官负责把问题拆清楚，判断优先级。',
  researcher: '研究员负责查证资料，交回出处和结论。',
  reviewer: '审查官负责核验结果，标出风险和证据缺口。',
  scribe: '书记官负责把事实、互动和约定整理成记录。',
  strategist: '谋士负责比较方案，帮助你准备下一步。',
  'ui-smith': '界面师负责把日常操作做得好找、好用。',
}
export const INTRO_LIMIT = '工程师与外务未在讨论中自述，两位需要通过各自的工单执行器答复。'
const INTRO_MARK = '〔幕僚自我介绍〕'
const INTRO_READY = '已汇总这次自我介绍。'

/**
 * Owner phrases and the liaison's tool calls. 11-19 failures are kept as phrases; the calls follow the R8 routing:
 * every staff member answering → chief_room discuss only; one staff member doing one thing → chief_inbox with a declared operation.
 */
export const liaisonScript = {
  '我现在有几个幕僚？': [
    [['chief_staff', { action: 'list' }]],
  ],
  [INTRO_REQUEST]: [
    [['chief_room', { action: 'list' }]],
    [['chief_room', { action: 'discuss', title: INTRO_TITLE, text: '请 chief、researcher、reviewer、scribe、strategist、ui-smith 各自简要介绍职责与工作方式。汇总后告知主人。' }]],
  ],
  '现在你和所有幕僚用的是什么模型？': [
    [['chief_settings', { action: 'show' }], ['chief_staff', { action: 'list' }]],
  ],
  '你让他们自述一下': [
    [['chief_room', { action: 'list' }]],
    [['chief_room', { action: 'discuss', request_id: 'staff-self-report-model-20261119', title: '幕僚自述当前模型',
      text: '主人问：你让他们自述一下。请各位幕僚分别自述当前会话实际可见的模型供应商和准确模型名，并区分模型与执行器；看不到就说看不到，不要猜测。仅讨论查询，不执行命令、不修改设置、不创建工单。' }]],
  ],
  '让每个人汇报一下自己用的模型': [
    [['chief_room', { action: 'list' }]],
    [['chief_room', { action: 'discuss', request_id: 'staff-model-self-report-20261119', title: '幕僚模型自述', text: `${T0020_BRIEF}请 ${ROOM_MEMBERS.join('、')} 各自回答。` }]],
  ],
  '记一下：周五和张三对一下季度报告的交接安排': [
    [['chief_inbox', { text: '周五和张三对一下季度报告的交接安排', operation: 'read', intent: 'memo' }]],
  ],
  '让研究员沙箱核对一下第二大脑的目录结构': [
    [['chief_inbox', { text: '沙箱核对：只读核对第二大脑的目录结构，交付一份结论报告。', title: '沙箱核对', staff: 'researcher', operation: 'read' }]],
  ],
  '让研究员汇总一下每位幕僚的模型配置': [
    [['chief_inbox', { text: T0020_BRIEF, title: '各幕僚自述当前模型', staff: 'researcher', operation: 'read' }]],
  ],
  // Typed in the SuperHub intake page: it reaches the liaison like a chat message. 「分别」 must not turn into a prohibition.
  '让研究员分别汇报一下三家云厂商对象存储的价格': [
    [['chief_inbox', { text: '分别调研三家主流云厂商对象存储的公开价格（存储、请求、流出流量），交付对比表并注明来源与日期。', title: '对象存储价格对比', staff: 'researcher', operation: 'read' }]],
  ],
  '构建老是超时，你安排工程师修改构建脚本的超时配置，先别部署': [
    [['chief_inbox', { text: '修改构建脚本的超时配置：把构建超时从 10 分钟调到 30 分钟，改完运行一次构建确认不再超时。', title: '调大构建脚本超时', staff: 'engineer', operation: 'write', restrictions: ['先别部署'] }]],
  ],
}

/** The discussion lead's calls. `ticket` and `source` are resolved from earlier tool results. A key also matches the owner's words quoted by the liaison. */
export const leadScript = {
  '让每个人汇报一下自己用的模型': [
    ROOM_MEMBERS.map(name => ['spawn_teammate', { name, description: `${name} 汇报模型`, prompt: `${SELF_REPORT}${name} 请用 send_message 告诉 lead 你本次实际运行的模型。` }]),
  ],
  '为什么工程师老失败？': [
    [['chief_room_note', { action: 'read' }]],
    [['chief_brief', {}]],
    [['chief_ticket', { action: 'view', id: '$ticket' }]],
  ],
  '自己看历史': [
    [['chief_room_note', { action: 'read' }]],
    [['chief_room_note', { action: 'request_execution', source: '$source', title: '排查工程师历史任务反复失败的原因', staff: 'engineer', operation: 'read',
      scope: '只读查看可访问的历史工单、执行记录和相关错误日志；不修改配置、代码或数据。',
      done_when: ['列出可查到的工程师失败案例、工单号、发生时间、失败步骤及原始错误或记录来源，并说明查阅范围与缺失。',
        '区分已证实原因与推测，归纳重复出现的故障模式；证据不足时明确说明，不推断根因。',
        '提出可验证的排查或修复建议，说明哪些操作需要另行批准。'] }]],
  ],
}

/**
 * A read ticket's executor (title 沙箱核对) tries to change the owner's second brain outside its own
 * ticket directory with the native write tool and with bash, writes inside its directory, and tries an
 * owner-only ticket action.
 * Paths come from the real assignment prompt.
 */
export const SANDBOX_MARK = '沙箱核对'
export const sandboxCalls = (brain, work) => [
  ['write', { file_path: `${brain}/goals.md`, content: '# 被执行者改写\n' }],
  ['write', { file_path: `${brain}/people/sandbox-probe.md`, content: '越界写入\n' }],
  ['bash', { description: 'Append to goals outside ticket dir', command: `printf 'bash 越界\\n' >> '${brain}/goals.md'` }],
  ['write', { file_path: `${work}/report.md`, content: '# 沙箱核对\n只读核对完成。\n' }],
  ['bash', { description: 'Write a file in the ticket dir', command: "printf 'bash 工单目录\\n' > bash-report.md" }],
  // Under the desk the executor is still staff: it cannot act as the owner.
  ['chief_ticket', { id: 'T-0001', action: 'stop', text: '执行者越权停止' }],
]

const textOf = content => Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : ''
const key = text => [...text].reduce((hash, char) => (hash * 31 + char.codePointAt(0)) >>> 0, 7).toString(36)

export function apply(ctx) {
  const live = process.env.CHIEF_ACCEPTANCE_REAL_MODEL === '1'
  const records = new Map()
  /** Per session: the model route of each request and the agent's current selection (teammate identity checks). */
  const routes = new Map()
  function route(request) {
    try {
      const current = ctx.agents.get(request.sessionId)?.model?.current?.()
      const text = JSON.stringify(request)
      const currentPrompt = (request.messages ?? []).filter(message => message.role === 'system').map(message => textOf(message.content)).filter(Boolean).at(-1) ?? ''
      const row = { session: request.sessionId, provider: request.provider, model: request.model, ...request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {},
        currentWorkspace: currentPrompt.includes('本轮主人从「工作区」发言。当前项目数据'),
        calendarDate: /本轮主人从「日历」发言。当前选中日期为 (\d{4}-\d{2}-\d{2})。/.exec(currentPrompt)?.[1],
        productGuide: currentPrompt.includes('你是 SuperHub 的接口人'),
        workspaceTool: (request.tools ?? []).some(tool => tool.name === 'chief_workspace'),
        ...(process.env.CHIEF_ACCEPTANCE_MEDIA === '1' && { media: (request.messages ?? []).flatMap(message => {
          const kinds = Array.isArray(message.content) ? message.content.flatMap(block => block.type === 'file' || block.type === 'image' ? [block.type] : []) : []
          return kinds?.length ? [{role: message.role, kinds}] : []
        }) }),
        ...current ? { current } : {}, identity: /〔幕僚身份〕你在本讨论中代表幕僚「[^」]+」（([a-z0-9-]+)）/.exec(text)?.[1] }
      routes.set(request.sessionId, [...routes.get(request.sessionId) ?? [], row])
    } catch { /* recording must never change the run */ }
  }
  /** Each model request carries the whole visible history: record every call and its result once. */
  function observe(sessionId, messages) {
    let owner
    for (const message of messages) {
      if (message.role === 'user' && message.source?.kind === 'user') owner = textOf(message.content).trim()
      if (message.role === 'assistant') for (const block of message.content ?? []) {
        if (block.type !== 'tool-call') continue
        const id = `${sessionId}\u0000${block.id}`
        if (!records.has(id)) records.set(id, { order: records.size, session: sessionId, callId: block.id, owner, name: block.name, arguments: block.arguments })
      }
      if (message.role === 'tool') {
        const row = records.get(`${sessionId}\u0000${message.toolCallId}`)
        if (row && row.text === undefined) Object.assign(row, { isError: message.isError === true, text: textOf(message.content) })
      }
    }
  }

  function executorPlan(messages) {
    const prompt = messages.filter(message => message.role === 'user').map(message => textOf(message.content)).join('\n')
    if (!prompt.includes(SANDBOX_MARK) || !prompt.includes('你的产出只能写入')) return undefined
    const brain = /主人的第二大脑在 (\S+?)，/.exec(prompt)?.[1], work = /你的产出只能写入 (\S+?)。/.exec(prompt)?.[1]
    if (!brain || !work) return { text: `夹具没有在派工说明里找到目录：${prompt.slice(0, 200)}` }
    const answered = id => messages.some(message => message.role === 'tool' && message.toolCallId === id)
    if (answered('sandbox-report')) return { text: '沙箱核对完成：结论见 report.md。' }
    if (answered('sandbox-0')) return { calls: [{ type: 'tool-call', id: 'sandbox-report', name: 'structured_output',
      arguments: JSON.stringify({ status: 'ready', summary: '只读核对完成，结论见 report.md。', outputs: ['report.md'] }) }] }
    return { calls: sandboxCalls(brain, work).map(([name, args], index) => ({ type: 'tool-call', id: `sandbox-${index}`, name, arguments: JSON.stringify(args) })) }
  }

  /** A teammate spawned for a self report tells the lead which model this very request runs on. */
  function teammatePlan(request, messages) {
    const prompt = messages.filter(message => message.role === 'user').map(message => textOf(message.content)).join('\n')
    const intro = new RegExp(`${INTRO_MARK}([a-z-]+)`).exec(prompt)?.[1]
    if (intro && Object.hasOwn(INTRO_ANSWERS, intro)) {
      const id = 'intro-' + intro
      return messages.some(message => message.role === 'tool' && message.toolCallId === id)
        ? { text: '已介绍。' }
        : { calls: [{ type: 'tool-call', id, name: 'send_message',
          arguments: JSON.stringify({ target: 'lead', message: INTRO_MARK + INTRO_ANSWERS[intro] }) }] }
    }
    const name = new RegExp(`${SELF_REPORT}([a-z0-9-]+)`).exec(prompt)?.[1]
    if (!name) return undefined
    if (messages.some(message => message.role === 'tool' && message.toolCallId === `self-report-${name}`)) return { text: '已汇报。' }
    return { calls: [{ type: 'tool-call', id: `self-report-${name}`, name: 'send_message',
      arguments: JSON.stringify({ target: 'lead', message: `${SELF_REPORT}${name}：本次实际运行 ${request.provider}/${request.model}` }) }] }
  }

  function introductionPlan(messages) {
    const results = new Map(messages.filter(message => message.role === 'tool').map(message => [message.toolCallId, textOf(message.content)]))
    const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
    if (!results.has('intro-room-source')) return { calls: [call('intro-room-source', 'chief_room_note', { action: 'read' })] }
    const intros = Object.entries(INTRO_ANSWERS)
    if (!results.has('intro-spawn-chief')) return { calls: intros.map(([name]) => call('intro-spawn-' + name,
      'spawn_teammate', { name, description: '介绍本人的职责与工作方式', prompt: INTRO_MARK + name + '，请用 send_message 回复 lead。' })) }
    const replies = messages.filter(message => message.role === 'user' && message.source?.kind === 'agent-message')
      .map(message => textOf(message.content).split(INTRO_MARK)[1]?.trim())
    const answers = intros.map(([, answer]) => replies.find(reply => reply === answer))
    if (!answers.every(Boolean)) return { text: '正在收集幕僚介绍。' }
    const text = [INTRO_READY, ...answers, INTRO_LIMIT].join('\n\n')
    if (results.has('intro-room-result')) return { text }
    const read = JSON.parse(results.get('intro-room-source'))
    const source = read.messages.find(row => row.author === 'you')?.id
    return { calls: [call('intro-room-result', 'chief_room_note', { action: 'report_result', source, status: 'partial', text })] }
  }

  function plan(sessionId, messages, request) {
    if (!sessionId.startsWith('chief-room-') && !sessionId.startsWith('chief-liaison')) return teammatePlan(request, messages) ?? executorPlan(messages)
    const owners = messages.filter(message => message.role === 'user' && message.source?.kind === 'user')
    const said = textOf(owners.at(-1)?.content).trim()
    const room = sessionId.startsWith('chief-room-')
    if (room && said.endsWith(`主人原话：「${INTRO_REQUEST}」`)) return introductionPlan(messages)
    const script = room ? leadScript : liaisonScript
    const steps = script[said] ?? (room ? script[/主人原话：「([^」]+)」$/.exec(said)?.[1] ?? ''] : undefined)
    if (!steps) return undefined
    // Calls in this turn only: the owner's latest message starts it.
    const start = messages.lastIndexOf(owners.at(-1))
    const results = new Map(messages.slice(start).filter(message => message.role === 'tool').map(message => [message.toolCallId, textOf(message.content)]))
    const prefix = `core-${key(said)}-${messages.slice(0, start).filter(message => message.role === 'user' && message.source?.kind === 'user').length}`
    const index = steps.findIndex((_, step) => !results.has(`${prefix}-${step}-0`))
    if (index < 0) return { text: said === '我现在有几个幕僚？' ? '你现在有 8 位幕僚。'
      : said === INTRO_REQUEST ? `已发起「${INTRO_TITLE}」讨论，汇总后我会在这里告诉你。`
      : `夹具回合完成：${[...results.values()].map(value => value.slice(0, 200)).join(' | ')}` }
    const earlier = [...results.values()].join('\n')
    const resolve = value => {
      if (value === '$ticket') return /T-\d{4}/.exec(earlier.split('等你决定')[1] ?? earlier)?.[0] ?? 'T-0001'
      if (value === '$source') {
        try {
          const read = [...results.values()].map(row => { try { return JSON.parse(row) } catch { return undefined } }).find(row => row?.messages)
          return read.messages.filter(row => row.author === 'you' && row.excerpt.includes(said)).at(-1).id
        } catch { return 'missing-source' }
      }
      return value
    }
    return { calls: steps[index].map(([name, args], call) => ({ type: 'tool-call', id: `${prefix}-${index}-${call}`, name,
      arguments: JSON.stringify(Object.fromEntries(Object.entries(args).map(([field, value]) => [field, resolve(value)]))) })) }
  }

  ctx.on('llm/stream', (request, next) => {
    try { observe(request.sessionId, request.messages ?? []) } catch { /* recording must never change the run */ }
    route(request)
    if (live) return next()
    const agent = ctx.agents.get(request.sessionId)
    if (!agent) return next()
    const decision = plan(request.sessionId, request.messages ?? [], request) ?? { text: '夹具回合完成。' }
    return (async function* () {
      if (decision.calls) {
        for (const [index, call] of decision.calls.entries()) {
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
          yield { type: 'block-end', index, block: call }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: decision.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: decision.text } }
      yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 12, totalTokens: 1212 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })

  ctx.webServer.register({ kind: 'exact', path: '/chief-liaison-core-probe', async handler(req, res) {
    const reject = ctx.connection.requestRejection(req)
    if (reject || req.method !== 'POST' || req.headers['x-chief-request'] !== '1') { res.writeHead(reject || 403); res.end(); return }
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      let raw = ''
      for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw Error('probe request exceeds limit') }
      const body = JSON.parse(raw)
      if (body.action === 'records') return json(200, [...records.values()].sort((a, b) => a.order - b.order))
      if (body.action === 'routes') return json(200, Object.fromEntries(routes))
      if (body.action === 'tool') {
        // A call that no owner message started, for example after the liaison's turn has ended.
        const resolved = await ctx.sessionController.resolveAgent(body.session)
        if ('error' in resolved) throw Error('liaison session unavailable')
        const { results } = await ctx.tools.execute({ agent: resolved.agent, signal: AbortSignal.timeout(16_000),
          calls: [{ type: 'tool-call', id: 'outside-turn-' + randomUUID(), name: body.name, arguments: JSON.stringify(body.args ?? {}) }] })
        const result = results[0].result
        return json(200, result.isError ? { ok: false, message: result.error.message, code: result.error.code } : { ok: true, value: result.value })
      }
      throw Error('unknown probe action')
    } catch (error) { json(400, { error: String(error) }) }
  } })
}
