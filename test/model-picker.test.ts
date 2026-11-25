import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { effortAfterModelChange, effortChoices, modelOptions } from '../src/client/model-select.tsx'
import { runtimeRoutes, serveApi } from '../src/dsh/http.ts'
import { DshExecutors } from '../src/dsh/executors.ts'
import { applySelection, canonicalEffort, canonicalModel, canonicalSelection, liaisonSelection, modelCatalog, type ModelCatalog, type ModelEntry } from '../src/dsh/models.ts'
import type { Llm, ModelSelection } from '../src/dsh/ports.ts'
import { SettingsStore, publicSettings } from '../src/dsh/settings.ts'

const EFFORTS = [
  { id: 'off', name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High', description: 'The default balance for most tasks.' },
  { id: 'max', name: 'Max' },
]

const llm = (broken: string[] = []): Llm => ({
  listProviders: () => [{ id: 'zhipu', name: '智谱' }, { id: 'deepseek', name: 'DeepSeek' }, { id: 'down', name: '离线厂商' }],
  listModels: async provider => {
    if (broken.includes(provider)) throw new Error(`${provider} 目录超时`)
    if (provider === 'zhipu') return [{ id: 'glm-5.3', name: 'GLM 5.3' }, { id: 'glm-air', name: 'glm-air' }]
    if (provider === 'deepseek') return [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]
    return []
  },
  resolveModelInfo: async (provider, model) => {
    if (model === 'glm-air') throw new Error('适配器没响应')
    if (provider === 'deepseek') return { reasoning: { efforts: EFFORTS, defaultEffort: 'high' } }
    return {}
  },
})

type Card = { id: string; name: string; executor: string; verifier: string; brief: string; model?: string; reasoningEffort?: string }

function fixture(host: Llm | undefined, saved: Partial<Card> = {}) {
  const cards: Card[] = [{ id: 'analyst', name: '分析师', executor: 'dsh', verifier: 'reviewer', brief: '分析数据', ...saved }]
  const brain = { staff: () => cards, saveStaff: (card: Card) => { cards.splice(0, cards.length, card) } }
  const routes = [runtimeRoutes({ engine: {}, brain, roster: {}, llm: () => host } as never)]
  const call = async (method: 'GET' | 'POST', path: string, body?: object, owner = true) => {
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
    const req = Object.assign((async function* () { yield* chunks })(), { method, url: `/chief/api${path}`, headers: { 'x-chief-request': '1' } }) as unknown as IncomingMessage
    let status = 0, output = ''
    const res = { headersSent: false, writeHead(code: number) { status = code }, end(value: string) { output = value } } as unknown as ServerResponse
    await serveApi(req, res, 'dsh', routes, owner)
    return { status, body: JSON.parse(output) }
  }
  const save = (model: string, extra: { brief?: string; reasoningEffort?: string } = {}) =>
    call('POST', '/staff', { id: 'analyst', name: '分析师', executor: 'dsh', verifier: 'reviewer', brief: extra.brief ?? '分析数据', model, ...extra.reasoningEffort !== undefined ? { reasoningEffort: extra.reasoningEffort } : {} })
  return { cards, call, save }
}

const entry = (m: Partial<ModelEntry> & Pick<ModelEntry, 'ref' | 'provider' | 'providerName' | 'id' | 'name'>): ModelEntry => ({ efforts: [], ...m })

describe('模型目录接口', () => {
  it('按厂商返回 provider/model 引用、显示名和每个模型的思考深度，只给主人', async () => {
    const f = fixture(llm())
    const { status, body } = await f.call('GET', '/models')
    expect(status).toBe(200)
    expect(body.problem).toBeUndefined()
    expect(body.unavailable).toEqual([])
    expect(body.empty).toEqual([{ provider: 'down', providerName: '离线厂商' }])
    expect(body.models).toEqual([
      { ref: 'zhipu/glm-5.3', provider: 'zhipu', providerName: '智谱', id: 'glm-5.3', name: 'GLM 5.3', efforts: [] },
      { ref: 'zhipu/glm-air', provider: 'zhipu', providerName: '智谱', id: 'glm-air', name: 'glm-air', efforts: [], effortProblem: '适配器没响应' },
      { ref: 'deepseek/deepseek-v4.1-flash', provider: 'deepseek', providerName: 'DeepSeek', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', efforts: EFFORTS, defaultEffort: 'high' },
    ])
    expect((await f.call('GET', '/models', undefined, false)).status).toBe(403)
  })

  it('某个厂商读取失败只把它列为不可用，其余照常；没有模型服务或厂商列表出错时说明原因', async () => {
    const partial = await modelCatalog(llm(['zhipu']))
    expect(partial.models.map(m => m.ref)).toEqual(['deepseek/deepseek-v4.1-flash'])
    expect(partial.unavailable).toEqual([{ provider: 'zhipu', providerName: '智谱', error: 'zhipu 目录超时' }])
    expect(partial.empty).toEqual([{ provider: 'down', providerName: '离线厂商' }])
    expect(await modelCatalog(undefined)).toMatchObject({ models: [], problem: expect.stringContaining('没有模型目录') })
    const listing = await modelCatalog({ ...llm(), listProviders: () => { throw new Error('路由配置损坏') } })
    expect(listing).toMatchObject({ models: [], problem: expect.stringContaining('路由配置损坏') })
  })
})

describe('思考深度校验', () => {
  it('档位必须是所选模型支持的，接受显示名并存 id；模型跟随默认时不能单独指定', async () => {
    expect(await canonicalEffort(llm(), 'deepseek/deepseek-v4.1-flash', 'max')).toBe('max')
    expect(await canonicalEffort(llm(), 'deepseek/deepseek-v4.1-flash', 'High')).toBe('high')
    expect(await canonicalEffort(llm(), 'deepseek/deepseek-v4.1-flash', '')).toBe('')
    await expect(canonicalEffort(llm(), 'deepseek/deepseek-v4.1-flash', 'ultra')).rejects.toThrow('可选：Off（off）、Low（low）、High（high）、Max（max）')
    await expect(canonicalEffort(llm(), 'zhipu/glm-5.3', 'high')).rejects.toThrow('不支持调节思考深度')
    await expect(canonicalEffort(llm(), 'zhipu/glm-air', 'high')).rejects.toThrow('读不到 zhipu/glm-air 的思考深度')
    await expect(canonicalEffort(llm(), '', 'high')).rejects.toThrow('模型跟随 DSH 默认时，思考深度也跟随默认')
    // 已存的模型和档位原样保留，即使现在读不到
    expect(await canonicalEffort(undefined, 'retired/old', 'deep', { model: 'retired/old', effort: 'deep' })).toBe('deep')
  })

  it('换了模型没给档位时回到模型默认，模型没变时沿用', async () => {
    const saved = { model: 'deepseek/deepseek-v4.1-flash', effort: 'max' }
    expect(await canonicalSelection(llm(), { model: 'glm-5.3' }, saved)).toEqual({ model: 'zhipu/glm-5.3', effort: '' })
    expect(await canonicalSelection(llm(), { model: 'deepseek/deepseek-v4.1-flash' }, saved)).toEqual(saved)
    expect(await canonicalSelection(llm(), { effort: 'low' }, saved)).toEqual({ ...saved, effort: 'low' })
    expect(await canonicalSelection(llm(), { model: '' }, saved)).toEqual({ model: '', effort: '' })
  })
})

describe('幕僚模型保存', () => {
  it('合法模型存成规范的 provider/model', async () => {
    const f = fixture(llm())
    expect((await f.save('GLM 5.3')).status).toBe(200)
    expect(f.cards[0]!.model).toBe('zhipu/glm-5.3')
    expect((await f.save('deepseek/DeepSeek-V4.1-Flash', { reasoningEffort: 'max' })).status).toBe(200)
    expect(f.cards[0]).toMatchObject({ model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'max' })
  })

  it('未知模型或不支持的档位返回 400 和可读原因，原设置不变', async () => {
    const f = fixture(llm(), { model: 'zhipu/glm-5.3' })
    const unknown = await f.save('gpt-404')
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toContain('找不到模型 gpt-404')
    const effort = await f.save('deepseek/deepseek-v4.1-flash', { reasoningEffort: 'ultra' })
    expect(effort.status).toBe(400)
    expect(effort.body.error).toContain('没有思考深度 ultra。可选：')
    const unsupported = await f.save('zhipu/glm-5.3', { reasoningEffort: 'high' })
    expect(unsupported.status).toBe(400)
    expect(unsupported.body.error).toContain('不支持调节思考深度')
    const orphan = await f.save('', { reasoningEffort: 'high' })
    expect(orphan.status).toBe(400)
    expect(orphan.body.error).toContain('模型跟随 DSH 默认时')
    expect(f.cards[0]!.model).toBe('zhipu/glm-5.3')
    expect(f.cards[0]!.reasoningEffort).toBeUndefined()
  })

  it('空值表示用默认，档位一并清掉', async () => {
    const f = fixture(llm(), { model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'max' })
    expect((await f.save('', { reasoningEffort: '' })).status).toBe(200)
    expect(f.cards[0]!.model).toBeUndefined()
    expect(f.cards[0]!.reasoningEffort).toBeUndefined()
  })

  it('目录里已没有的旧值（含档位）在改其他字段时原样保留', async () => {
    const f = fixture(llm(), { model: 'retired/old-model', reasoningEffort: 'deep' })
    expect((await f.save('retired/old-model', { brief: '分析数据，并写结论', reasoningEffort: 'deep' })).status).toBe(200)
    expect(f.cards[0]).toMatchObject({ model: 'retired/old-model', reasoningEffort: 'deep', brief: '分析数据，并写结论' })
    // 没有模型服务时也一样，只有真正换模型才需要目录
    expect(await canonicalModel(undefined, 'retired/old-model', 'retired/old-model')).toBe('retired/old-model')
    await expect(canonicalModel(undefined, 'zhipu/glm-5.3', 'retired/old-model')).rejects.toThrow('没有模型目录')
  })
})

describe('接口人的模型与思考深度', () => {
  it('设置只在指定了模型时保存档位，清空模型时档位一起清掉', () => {
    const store = new SettingsStore(mkdtempSync(join(tmpdir(), 'chief-model-')))
    store.update({ liaisonModel: 'deepseek/deepseek-v4.1-flash', liaisonReasoningEffort: 'max' })
    expect(publicSettings(store.get())).toMatchObject({ liaisonModel: 'deepseek/deepseek-v4.1-flash', liaisonReasoningEffort: 'max' })
    expect(new SettingsStore(store.dir).get().liaisonReasoningEffort).toBe('max')
    store.update({ liaisonReasoningEffort: '' })
    expect(store.get().liaisonReasoningEffort).toBeUndefined()
    store.update({ liaisonReasoningEffort: 'low' })
    store.update({ liaisonModel: '' })
    expect(store.get()).not.toHaveProperty('liaisonReasoningEffort')
    expect(publicSettings(store.get())).toMatchObject({ liaisonModel: '', liaisonReasoningEffort: '' })
  })

  it('applyModel 把档位传给 agent.model.select，档位变了也重新选择', () => {
    const selected: ModelSelection[] = []
    let current: ModelSelection | undefined = { provider: 'deepseek', model: 'deepseek-v4.1-flash' }
    const model = { current: () => current, select: (s: ModelSelection) => { selected.push(s); current = s } }
    const fallback = { provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'high' }
    expect(applySelection(model, liaisonSelection({ liaisonModel: 'deepseek/deepseek-v4.1-flash', liaisonReasoningEffort: 'max' }, fallback))).toBe(true)
    expect(applySelection(model, liaisonSelection({ liaisonModel: 'deepseek/deepseek-v4.1-flash', liaisonReasoningEffort: 'max' }, fallback))).toBe(false)
    expect(applySelection(model, liaisonSelection({ liaisonModel: 'deepseek/deepseek-v4.1-flash' }, fallback))).toBe(true)
    expect(applySelection(model, liaisonSelection({}, fallback))).toBe(true)
    expect(selected).toEqual([
      { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
      { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
      { provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'high' },
    ])
    // 模型跟随默认时不用设置里残留的档位
    expect(liaisonSelection({ liaisonReasoningEffort: 'max' }, { provider: 'zhipu', model: 'glm-5.3' })).toEqual({ provider: 'zhipu', model: 'glm-5.3' })
  })
})

describe('幕僚执行时的思考深度', () => {
  it('指定了模型和档位时 agentOptions 带上 reasoningEffort，没指定模型时不带', async () => {
    const specs: { request: { agentOptions?: object } }[] = []
    const context = {
      subagents: {
        getProvider: () => ({ capabilities: { outputSchema: true, agentOptions: true } }),
        startActivation: async (spec: { request: { agentOptions?: object } }) => { specs.push(spec); return { childId: 'child', result: Promise.resolve({ output: [{ type: 'text', text: '汇报' }], stopReason: 'completed' }), dispose: async () => {} } },
      },
      sessionController: { resolveAgent: async () => ({ agent: { id: 'child', session: { snapshotEvents: () => [] } } }) },
      logger: { warn() {} },
    }
    const executor = new DshExecutors(context as never, async () => ({ id: 'parent' }))
    const run = (staff: Partial<Card>) => executor.run({ staff: { id: 'analyst', name: '分析师', executor: 'dsh', verifier: 'none', brief: '', ...staff }, label: '一次执行', prompt: '当前工单', cwd: '/tmp' }, new AbortController().signal)
    await run({ model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'max' })
    await run({ model: 'deepseek/deepseek-v4.1-flash' })
    await run({})
    expect(specs.map(s => s.request.agentOptions)).toEqual([
      { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' },
      { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
      undefined,
    ])
  })
})

describe('模型下拉选项', () => {
  const catalog: ModelCatalog = {
    models: [
      entry({ ref: 'zhipu/glm-5.3', provider: 'zhipu', providerName: '智谱', id: 'glm-5.3', name: 'GLM 5.3' }),
      entry({ ref: 'zhipu/glm-air', provider: 'zhipu', providerName: '智谱', id: 'glm-air', name: 'glm-air', effortProblem: '适配器没响应' }),
      entry({ ref: 'deepseek/v4', provider: 'deepseek', providerName: 'DeepSeek', id: 'v4', name: 'v4', efforts: EFFORTS, defaultEffort: 'high' }),
    ],
    unavailable: [],
    empty: [],
  }

  it('按厂商分组，显示名与 id 不同时附上 id', () => {
    const options = modelOptions('zhipu/glm-5.3', catalog)
    expect(options.kept).toEqual([])
    expect(options.note).toBeUndefined()
    expect(options.warn).toBe(false)
    expect(options.groups).toEqual([
      { provider: 'zhipu', label: '智谱', options: [{ value: 'zhipu/glm-5.3', label: 'GLM 5.3（glm-5.3）' }, { value: 'zhipu/glm-air', label: 'glm-air' }] },
      { provider: 'deepseek', label: 'DeepSeek', options: [{ value: 'deepseek/v4', label: 'v4' }] },
    ])
  })

  it('目录中没有的旧值保留为当前项并标注，换走后仍能选回', () => {
    const options = modelOptions('retired/old-model', catalog)
    expect(options.kept).toEqual([{ value: 'retired/old-model', label: 'retired/old-model（目录中未找到）' }])
    expect(options.note).toContain('原样保留')
    expect(options.warn).toBe(false)
    expect(modelOptions('', catalog).kept).toEqual([])
    expect(modelOptions('zhipu/glm-5.3', catalog, undefined, 'retired/old-model').kept).toEqual([{ value: 'retired/old-model', label: 'retired/old-model（目录中未找到）' }])
  })

  it('目录接口失败（含旧服务端 404）、为空或部分失败时保留当前值并醒目说明', () => {
    const failed = modelOptions('zhipu/glm-5.3', undefined, '正在运行的 SuperHub 服务端还没有模型目录接口，重启 DSH 加载新版本后再打开')
    expect(failed.kept).toEqual([{ value: 'zhipu/glm-5.3', label: 'zhipu/glm-5.3' }])
    expect(failed.groups).toEqual([])
    expect(failed.warn).toBe(true)
    expect(failed.note).toContain('没能读取 DSH 模型目录：正在运行的 SuperHub 服务端还没有模型目录接口')
    // 只有默认项时也必须有说明，不能只剩一个“跟随 DSH 默认”
    const bare = modelOptions('', undefined, '未知接口')
    expect(bare).toMatchObject({ kept: [], groups: [], warn: true })
    expect(bare.note).toContain('没能读取 DSH 模型目录：未知接口')
    expect(modelOptions('x/y', { models: [], unavailable: [], empty: [], problem: '这个版本的 DSH 没有模型目录' })).toMatchObject({ warn: true, note: expect.stringContaining('没有模型目录') })
    const empty = modelOptions('', { models: [], unavailable: [{ provider: 'zhipu', providerName: '智谱', error: '超时' }], empty: [{ provider: 'kimi', providerName: 'Kimi' }] })
    expect(empty).toMatchObject({ warn: true, note: expect.stringContaining('没有可选的模型（智谱 读取失败）（Kimi 没有列出模型') })
    expect(modelOptions('zhipu/glm-5.3', { ...catalog, unavailable: [{ provider: 'kimi', providerName: 'Kimi', error: '超时' }] })).toMatchObject({ warn: true, note: expect.stringContaining('Kimi 的模型没有读到') })
    expect(modelOptions('zhipu/glm-5.3')).toMatchObject({ warn: false, note: expect.stringContaining('正在读取') })
  })
})

describe('思考深度下拉', () => {
  const catalog: ModelCatalog = {
    models: [
      entry({ ref: 'zhipu/glm-5.3', provider: 'zhipu', providerName: '智谱', id: 'glm-5.3', name: 'GLM 5.3' }),
      entry({ ref: 'zhipu/glm-air', provider: 'zhipu', providerName: '智谱', id: 'glm-air', name: 'glm-air', effortProblem: '适配器没响应' }),
      entry({ ref: 'deepseek/v4', provider: 'deepseek', providerName: 'DeepSeek', id: 'v4', name: 'DeepSeek V4', efforts: EFFORTS, defaultEffort: 'high' }),
      entry({ ref: 'deepseek/lite', provider: 'deepseek', providerName: 'DeepSeek', id: 'lite', name: 'lite', efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }] }),
    ],
    unavailable: [],
    empty: [],
  }

  it('选项来自所选模型的 efforts，第一项是模型默认，描述作为提示', () => {
    const choices = effortChoices('deepseek/v4', 'off', catalog)
    expect(choices.disabled).toBe(false)
    expect(choices.options).toEqual([
      { value: '', label: '模型默认（High）' },
      { value: 'off', label: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High', description: 'The default balance for most tasks.' },
      { value: 'max', label: 'Max' },
    ])
    expect(choices.note).toBe('Use for simple tasks that do not need reasoning.')
    expect(effortChoices('deepseek/lite', '', catalog).options.map(o => o.label)).toEqual(['模型默认', 'Off', 'Low'])
  })

  it('模型跟随 DSH 默认或不支持调节时禁用并说明', () => {
    expect(effortChoices('', '', catalog)).toMatchObject({ disabled: true, options: [{ value: '', label: '跟随 DSH 默认' }], note: expect.stringContaining('思考深度也跟随 DSH 默认') })
    expect(effortChoices('zhipu/glm-5.3', '', catalog)).toMatchObject({ disabled: true, options: [{ value: '', label: '此模型不支持调节' }], note: '此模型不支持调节思考深度。' })
    expect(effortChoices('zhipu/glm-air', '', catalog)).toMatchObject({ disabled: true, warn: true, note: expect.stringContaining('读不到这个模型的思考深度：适配器没响应') })
    expect(effortChoices('deepseek/v4', '', undefined, '未知接口')).toMatchObject({ disabled: true, warn: true })
    expect(effortChoices('deepseek/v4', '', undefined)).toMatchObject({ disabled: true, note: '正在读取思考深度…' })
  })

  it('读不到档位的旧值保留为当前项，可以改回模型默认', () => {
    const kept = effortChoices('retired/old', 'deep', catalog)
    expect(kept.disabled).toBe(false)
    expect(kept.options).toEqual([{ value: '', label: '模型默认' }, { value: 'deep', label: 'deep（无法确认）' }])
    expect(kept.note).toContain('已保存的“deep”会原样保留')
  })

  it('换模型后原档位不被支持时回到模型默认并给出说明', () => {
    expect(effortAfterModelChange('deepseek/lite', 'low', catalog)).toEqual({ effort: 'low' })
    expect(effortAfterModelChange('deepseek/lite', 'max', catalog)).toEqual({ effort: '', notice: 'lite 不支持思考深度“max”，已改回模型默认。' })
    expect(effortAfterModelChange('zhipu/glm-5.3', 'max', catalog)).toEqual({ effort: '', notice: 'GLM 5.3 不支持思考深度“max”，已改回模型默认。' })
    expect(effortAfterModelChange('zhipu/glm-air', 'max', catalog).notice).toContain('读不到 glm-air 的思考深度')
    expect(effortAfterModelChange('', 'max', catalog)).toEqual({ effort: '', notice: expect.stringContaining('思考深度也随之跟随默认') })
    expect(effortAfterModelChange('deepseek/v4', '', catalog)).toEqual({ effort: '' })
  })
})
