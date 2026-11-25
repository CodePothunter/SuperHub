/**
 * 接口人工具策略对真实 DSH 0.2.2-rc.1 服务的回归；不启动 DSH、不调用模型、不改配置。
 *
 * node --experimental-transform-types scripts/liaison-host-regression.mjs /path/to/dsh/node_modules
 * 路径内需有 rc.1 的 llm、tools、system-prompt、scope、tool-executor-native、tool-executor-ptc。
 * 使用真实组装器和 LlmRuntime，捕获适配器收到的最终参数（包括工具历史投影之后）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LiaisonToolVisibility, liaisonGuard } from '../src/dsh/liaison.ts'

const modules = process.argv[2]
if (!modules) throw new Error('请提供已安装 DSH 0.2.2-rc.1 的 node_modules 路径')
const hostRequire = createRequire(join(resolve(modules), '__chief_host_regression__.cjs'))
const load = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const [cordis, scopeApi, promptApi, toolsApi, nativeApi, ptcApi, runtimeApi, llmApi] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-system-prompt'),
  load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-tool-executor-native'),
  load('@deepseek-ai/dsh-tool-executor-ptc'), load('@deepseek-ai/dsh-ptc-runtime'), load('@deepseek-ai/dsh-llm'),
])
for (const name of ['dsh-llm', 'dsh-tools', 'dsh-system-prompt', 'dsh-scope', 'dsh-tool-executor-native', 'dsh-tool-executor-ptc']) {
  const file = hostRequire.resolve(`@deepseek-ai/${name}/package.json`)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, '0.2.2-rc.1', `${name} 必须来自实际 rc.1`)
}

const ctx = new cordis.Context()
await ctx.plugin(promptApi.default, {})
await ctx.plugin(toolsApi.default)
await ctx.plugin(nativeApi)
await ctx.plugin(llmApi.default)
// 只用运行时的语言契约渲染真实 PTC 执行器；本回归不会执行程序或启动进程。
class PresentationRuntime extends runtimeApi.PtcRuntime {
  language = 'typescript'
  isolation = 'process'
  resolve() { throw new Error('presentation-only fixture must not execute programs') }
  run() { throw new Error('presentation-only fixture must not execute programs') }
}
await ctx.plugin(PresentationRuntime)
const captures = []
let resolutions = 0
class CaptureAdapter extends llmApi.LlmAdapter {
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted()
    resolutions++
    return { provider, id: model, name: model, ...model === 'history' ? { toolUpdate: 'in-history' } : {} }
  }
  async *stream(request) {
    request.signal?.throwIfAborted()
    captures.push(request)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const isLiaison = id => id === 'hq' || id === 'hq-p2'
const policy = new LiaisonToolVisibility(ctx.tools, isLiaison)
const scopes = []
const tool = name => ({ name, description: `definition ${name}`, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async () => 'fixture result' })
const schema = definition => ({ name: definition.name, description: definition.description, parameters: definition.parameters })
let host
await ctx.plugin(Object.assign(inner => {
  host = inner
  inner.llm.registerAdapter(['fixture'], new CaptureAdapter())
  for (const name of ['read', 'chief_brief', 'ask_user_question', 'subagent', 'remote_create_session', 'job_list']) inner.tools.register(tool(name))
}, { inject: ['tools', 'systemPrompt', 'llm'] }))
async function agent(id, parentSession) {
  const key = { id, session: { id, header: { parentSession } } }
  await ctx.plugin(Object.assign(inner => {
    const scope = scopeApi.createScope(inner, key)
    scopes.push(scope)
    key.ctx = scope.ctx
    for (const name of ['bash', 'write', 'edit']) key.ctx.tools.register(tool(name))
  }, { inject: ['tools', 'systemPrompt', 'llm', 'ptcRuntime'] }))
  return key
}
const hq = await agent('hq')
const p2 = await agent('hq-p2')
const worker = await agent('worker', 'hq')
const outsider = await agent('ordinary')
const beforeWorker = ctx.tools.schemas(worker)
const beforeOrdinary = ctx.tools.schemas(outsider)
const beforeInjected = ctx.tools.schemas(hq)

const offGuard = host.tools.guard(liaisonGuard(isLiaison))
let audits = 0
const offAudit = host.on('llm/stream', (request, next) => { audits++; policy.observe(request); return next() })
const offChange = host.on('tools/change', () => policy.refresh())
policy.attach(hq)
policy.attach(p2)
policy.attach(worker) // 明确证明 session 父子关系不使 worker 被当成接口人。
assert.deepEqual(ctx.tools.schemas(worker), beforeWorker)
assert.deepEqual(ctx.tools.schemas(outsider), beforeOrdinary)
host.tools.register(tool('remote_copy_file'))
host.tools.register(tool('job_output'))
host.tools.register(tool('subagent_codex'))
assert.ok(!ctx.tools.schemas(hq).some(tool => tool.name.startsWith('remote_') || tool.name.startsWith('job_')))
assert.ok(!ctx.tools.schemas(p2).some(tool => tool.name.startsWith('remote_') || tool.name.startsWith('job_')))
assert.ok(ctx.tools.schemas(worker).some(tool => tool.name === 'remote_copy_file'))
assert.ok(ctx.tools.checkGuards({ name: 'bash', agent: hq }))
assert.ok(ctx.tools.checkGuards({ name: 'remote_create_session', agent: p2 }))
for (const liaison of [hq, p2]) {
  assert.ok(!ctx.tools.schemas(liaison).some(tool => tool.name === 'subagent_codex'))
  assert.ok(ctx.tools.checkGuards({ name: 'subagent_codex', agent: liaison }))
}
assert.equal(ctx.tools.checkGuards({ name: 'bash', agent: worker }), undefined)

async function assemble(agent) {
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'fixture', model: 'plain' }, signal })
  try { return await ctx.systemPrompt.assemble({ scope: agent, agent, signal, toolSet }) }
  finally { toolSet.dispose() }
}
async function send(agent, tools, model = 'plain', extras = {}) {
  const signal = extras.signal ?? new AbortController().signal
  const prepared = await ctx.llm.prepareCall({ provider: 'fixture', model, temperature: 0.2, maxTokens: 31, stop: ['END'] }, signal)
  const request = llmApi.markAgentLoopRequest(Object.freeze({ ...prepared.config, sessionId: agent.id,
    messages: Object.freeze([]), tools: Object.freeze(tools), signal, ...extras }))
  const before = JSON.stringify(request)
  const resolutionsBefore = resolutions
  const chunks = []
  for await (const chunk of prepared.stream(request)) chunks.push(chunk)
  assert.equal(resolutions, resolutionsBefore, '只读审计不能重新 prepareCall 或重新选择模型')
  assert.equal(JSON.stringify(request), before, '不改冻结的请求、消息、历史或配置')
  return { request, chunks, payload: captures.at(-1) }
}

// 真实组装器忽略 assembly.tools：不能用旧版 assembly 过滤冒充模型已看不到。
const offAssembly = hq.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({ ...await next(), tools: [] }))
const assembled = await assemble(hq)
assert.ok(assembled.tools.some(tool => tool.name === 'bash'))
offAssembly()
const plain = await send(hq, assembled.tools)
assert.deepEqual(plain.payload.tools.map(tool => tool.name).sort(), ['bash', 'chief_brief', 'edit', 'read', 'write'])
assert.deepEqual(plain.payload.tools, assembled.tools, '保留工具的原始名称、说明和参数定义')
assert.equal(plain.payload.signal, plain.request.signal)
assert.equal(plain.payload.temperature, 0.2)
assert.equal(plain.payload.maxTokens, 31)
assert.deepEqual(plain.payload.stop, ['END'])
assert.ok(llmApi.isAgentLoopRequest(plain.payload), '只读审计保留官方请求身份')

// 早已收集/注入的工具定义不会被 restrict 追溯改写；诊断必须实报，不能报告遮蔽完全成功。
const injected = await send(hq, beforeInjected)
assert.ok(injected.payload.tools.some(tool => tool.name === 'remote_create_session'))
assert.ok(policy.status(true, 'available').sessions.find(row => row.sessionId === 'hq').requestDenied.includes('remote_create_session'))

// 适配器历史投影会把旧声明补回：即使活跃列表已遮蔽，历史也必须单独核验。
const old = schema(tool('remote_create_session'))
const history = Object.freeze({ tools: Object.freeze([old, schema(tool('read'))]), updates: Object.freeze([]) })
const historical = await send(hq, ctx.tools.schemas(hq), 'history', { toolHistory: history })
assert.ok(historical.payload.tools.some(tool => tool.name === 'remote_create_session'))
assert.ok(policy.status(true, 'available').sessions.find(row => row.sessionId === 'hq').historyDenied.includes('remote_create_session'))

const workerSent = await send(worker, ctx.tools.schemas(worker))
assert.ok(workerSent.payload.tools.some(tool => tool.name === 'remote_create_session'))
assert.ok(workerSent.payload.tools.some(tool => tool.name === 'bash'))
assert.ok(!policy.status(true, 'available').sessions.some(row => row.sessionId === 'worker'))

// 不替换现有执行器：同一接口人段选择程序工具调用时仍由原执行器提供 run_code 和工具 SDK。
await ctx.plugin(Object.assign(inner => {
  const scope = scopeApi.createScope(inner, p2)
  scopes.push(scope)
  scope.ctx.tools.setExecutor(new ptcApi.PtcExecutor(scope.ctx))
}, { inject: ['tools', 'systemPrompt', 'llm', 'ptcRuntime'] }))
const ptcAssembly = await assemble(p2)
assert.deepEqual(ptcAssembly.tools.map(tool => tool.name), ['run_code'])
const ptc = await send(p2, ptcAssembly.tools)
assert.deepEqual(ptc.payload.tools.map(tool => tool.name), ['run_code'])
assert.ok(promptApi.renderPrompt(ptcAssembly).includes('bash'), '沙箱自己的 SDK 声明仍存在，不能宣称已完全隐藏')

// 取消通过原信号进入原适配器，无吞掉、重入或修改；本测试不启动定时器/外部网络。
const controller = new AbortController()
const prepared = await ctx.llm.prepareCall({ provider: 'fixture', model: 'plain' }, controller.signal)
controller.abort()
const cancelled = []
for await (const chunk of prepared.stream({ ...prepared.config, messages: [], tools: [], sessionId: hq.id, signal: controller.signal })) cancelled.push(chunk)
assert.equal(cancelled.at(-1).reason.kind, 'aborted')

offAudit()
const auditsBeforeUnload = audits
offChange()
policy.dispose()
offGuard()
assert.ok(ctx.tools.schemas(hq).some(tool => tool.name === 'remote_create_session'), '卸载撤销本插件限制')
await send(hq, ctx.tools.schemas(hq))
assert.equal(audits, auditsBeforeUnload, '卸载后最终请求监听器确实不再运行')
assert.deepEqual(policy.status(false, 'unavailable').sessions, [], '取消监听且释放后不再采集请求')
assert.equal(ctx.tools.checkGuards({ name: 'bash', agent: hq }), undefined)
for (const scope of scopes.reverse()) await scope.dispose()
await ctx.fiber.dispose()
console.log('✓ rc.1 真实服务回归通过：全局逐名遮蔽、换段与幕僚隔离、最终适配器参数、历史回灌、原执行器与取消信号、卸载释放。')
console.log('  能力边界已核验：接口人沙箱 bash/write/edit、已注入声明及旧历史仍可能向模型可见；执行拦截继续生效。')
