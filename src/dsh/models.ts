/**
 * 模型名解析：主人说的"deepseek-v4.1-flash""zhipu/glm-5.3"换成 DSH 的 provider + model。
 *
 * 只读 DSH 的模型目录，不调用 sessionController.selectModel——那个接口会顺带把整个 profile 的
 * 默认模型改掉（dsh-api-session-controller 的 selectModel 会后台 saveSelection），
 * 而接口人的模型只该影响接口人自己。
 */
import type { Llm, ModelReasoning, ModelSelection } from './ports.ts'

export interface ModelChoice { provider: string; model: string }

export const modelRef = (c: ModelChoice) => `${c.provider}/${c.model}`

const norm = (s: string) => s.trim().toLowerCase()

/**
 * 在目录里找主人说的模型。写法：provider/model，或者只写 model（id 或显示名，不区分大小写）。
 * 只写 model 且多个厂商都有时，要求写上 provider。找不到时列出可选的，方便接口人照着改。
 */
export async function findModel(llm: Llm, wanted: string): Promise<ModelChoice> {
  const text = wanted.trim()
  if (!text) throw new Error('模型名不能为空')
  const providers = llm.listProviders()
  const slash = text.indexOf('/')
  const provider = slash > 0 ? text.slice(0, slash) : undefined
  const model = slash > 0 ? text.slice(slash + 1) : text
  const scope = provider ? providers.filter(p => norm(p.id) === norm(provider) || norm(p.name) === norm(provider)) : providers
  if (provider && !scope.length) throw new Error(`没有叫 ${provider} 的模型厂商。可选：${providers.map(p => p.id).join('、') || '（没有）'}`)
  const catalog = (await Promise.all(scope.map(p => llm.listModels(p.id).then(ms => ms.map(m => ({ ...m, provider: p.id })), () => [])))).flat()
  const hits = catalog.filter(m => norm(m.id) === norm(model) || norm(m.name) === norm(model))
  const exact = new Map(hits.map(m => [`${m.provider}/${m.id}`, m]))
  if (exact.size === 1) { const [m] = exact.values(); return { provider: m!.provider, model: m!.id } }
  if (exact.size > 1) throw new Error(`好几个厂商都有 ${model}：${[...exact.keys()].join('、')}，请写成 厂商/模型`)
  // 目录不完整的厂商（只声明了路由）：写全了 provider/model 就照用，由 DSH 在下一步校验
  if (provider && scope.length === 1 && !catalog.length) return { provider: scope[0]!.id, model }
  const sample = catalog.slice(0, 12).map(m => `${m.provider}/${m.id}`)
  throw new Error(`找不到模型 ${text}。${sample.length ? `可选的有：${sample.join('、')}${catalog.length > sample.length ? ' 等' : ''}` : '现在没有可用的模型目录'}`)
}

/**
 * 接口人下一步该用的模型选择：设置里指定了模型就用它（档位只在指定时带上，否则由适配器用模型默认）；
 * 没指定时整个跟随 DSH 的默认选择（含默认档位）。
 */
export function liaisonSelection(s: { liaisonModel?: string; liaisonReasoningEffort?: string }, fallback?: ModelSelection): ModelSelection | undefined {
  const want = s.liaisonModel ? split(s.liaisonModel) : fallback
  if (!want?.provider || !want.model) return undefined
  const effort = s.liaisonModel ? s.liaisonReasoningEffort : fallback?.reasoningEffort
  return { provider: want.provider, model: want.model, ...effort ? { reasoningEffort: effort } : {} }
}

/** 会话当前的选择和想要的不一样时才 select（含思考深度）；返回是否换了。 */
export function applySelection(model: { current(): ModelSelection | undefined; select(selection: ModelSelection): void }, want: ModelSelection | undefined): boolean {
  if (!want) return false
  const current = model.current()
  if (current?.provider === want.provider && current.model === want.model && (current.reasoningEffort ?? '') === (want.reasoningEffort ?? '')) return false
  model.select(want)
  return true
}

/** 模型声明的上下文窗口；查不到时返回 undefined。 */
export async function contextWindow(llm: Llm | undefined, choice: ModelChoice | undefined): Promise<number | undefined> {
  if (!llm || !choice) return undefined
  try { return (await llm.resolveModelInfo(choice.provider, choice.model)).context?.contextWindow } catch { return undefined }
}

/**
 * 保存一项模型设置：空串表示跟随 DSH 默认；和已存的值一样就原样保留（旧值可能已不在目录里，
 * 改别的字段时不能因此保存失败或被换掉）；其余经目录校验，存成规范的 provider/model。
 */
export async function canonicalModel(llm: Llm | undefined, wanted: string, saved?: string): Promise<string> {
  const text = wanted.trim()
  if (!text) return ''
  if (saved && text === saved.trim()) return saved
  if (!llm) throw new Error('这个版本的 DSH 没有模型目录，没法校验模型')
  return modelRef(await findModel(llm, text))
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300) || '原因不明'

const split = (ref: string): ModelChoice | undefined => {
  const slash = ref.indexOf('/')
  return slash > 0 ? { provider: ref.slice(0, slash), model: ref.slice(slash + 1) } : undefined
}

/** 一个模型可选的思考深度（DSH 的 LlmReasoningEffortInfo），从浅到深。 */
export interface EffortOption { id: string; name: string; description?: string }

const effortsOf = (reasoning: ModelReasoning | undefined): EffortOption[] =>
  (reasoning?.efforts ?? []).flatMap(e => typeof e?.id === 'string' && e.id ? [{ id: e.id, name: e.name || e.id, ...e.description ? { description: e.description } : {} }] : [])

/**
 * 校验思考深度：空串表示模型默认（请求里不带档位）。模型跟随 DSH 默认时档位也必须跟随默认。
 * 和已存的模型、档位都一样时原样保留（旧模型可能已读不到档位，改别的字段时不能因此失败）。
 * 其余必须是该模型 reasoning.efforts 里的一项（按 id，也接受不区分大小写的 id 或显示名），存 id。
 */
export async function canonicalEffort(llm: Llm | undefined, model: string, wanted: string, saved: { model?: string; effort?: string } = {}): Promise<string> {
  const text = wanted.trim()
  if (!text) return ''
  if (!model) throw new Error('模型跟随 DSH 默认时，思考深度也跟随默认，不能单独指定')
  if (model === saved.model && text === saved.effort) return text
  if (!llm) throw new Error('这个版本的 DSH 没有模型目录，没法校验思考深度')
  const choice = split(model)
  if (!choice) throw new Error(`模型 ${model} 没有写明厂商，没法查它的思考深度`)
  let efforts: EffortOption[]
  try { efforts = effortsOf((await llm.resolveModelInfo(choice.provider, choice.model)).reasoning) }
  catch (error) { throw new Error(`读不到 ${model} 的思考深度：${reason(error)}`) }
  if (!efforts.length) throw new Error(`${model} 不支持调节思考深度，请选“模型默认”`)
  const hit = efforts.find(e => e.id === text) ?? efforts.find(e => norm(e.id) === norm(text) || norm(e.name) === norm(text))
  if (hit) return hit.id
  throw new Error(`${model} 没有思考深度 ${text}。可选：${efforts.map(e => e.name === e.id ? e.id : `${e.name}（${e.id}）`).join('、')}，或者模型默认`)
}

/**
 * 模型和思考深度一起保存。wanted 里没给的字段：模型沿用已存的；档位在模型没变时沿用，
 * 换了模型就回到模型默认（旧档位不一定适用于新模型）。
 */
export async function canonicalSelection(llm: Llm | undefined, wanted: { model?: string; effort?: string }, saved: { model?: string; effort?: string } = {}): Promise<{ model: string; effort: string }> {
  const model = wanted.model === undefined ? saved.model ?? '' : await canonicalModel(llm, wanted.model, saved.model)
  const effort = wanted.effort ?? (model === (saved.model ?? '') ? saved.effort ?? '' : '')
  return { model, effort: await canonicalEffort(llm, model, effort, saved) }
}

/** 下拉框里的一个模型：ref 是保存用的 provider/model；efforts 为空表示不支持调节思考深度。 */
export interface ModelEntry {
  ref: string; provider: string; providerName: string; id: string; name: string
  efforts: EffortOption[]
  /** 适配器在不指定档位时用的档位（只用于说明“模型默认”是哪一档）。 */
  defaultEffort?: string
  /** 读不到这个模型的思考深度时的原因；此时 efforts 为空，但不能说成“不支持”。 */
  effortProblem?: string
}
/** GET /chief/api/models：DSH 当前的模型目录。读不到的厂商列在 unavailable 里，不影响其他厂商。 */
export interface ModelCatalog {
  models: ModelEntry[]
  unavailable: { provider: string; providerName: string; error: string }[]
  /**
   * 列出了厂商但没有模型列表：没配凭据时 DSH 返回空列表，或者厂商只声明了路由。
   * 这些厂商在下拉里选不了；接口人工具仍接受写全的 厂商/模型（见 findModel）。
   */
  empty: { provider: string; providerName: string }[]
  /** 整个目录读不到（DSH 没有模型服务、厂商列表出错）时的原因。 */
  problem?: string
}

/** 单个模型的思考深度读取上限：一个适配器卡住不能拖住整个下拉框。 */
const REASONING_TIMEOUT = 5000

async function reasoningOf(llm: Llm, provider: string, model: string): Promise<Pick<ModelEntry, 'efforts' | 'defaultEffort' | 'effortProblem'>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const info = await Promise.race([
      llm.resolveModelInfo(provider, model),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('读取超时')), REASONING_TIMEOUT) }),
    ])
    const efforts = effortsOf(info.reasoning)
    const fallback = info.reasoning?.defaultEffort
    return { efforts, ...efforts.length && fallback ? { defaultEffort: fallback } : {} }
  } catch (error) { return { efforts: [], effortProblem: reason(error) } } finally { clearTimeout(timer) }
}

/**
 * 读出整个模型目录，按 DSH 给的厂商顺序排列。和 DSH 自己的模型选择器一样，每个模型的思考深度一并读出：
 * 前端换模型时要立刻知道旧档位还能不能用，不能等第二次请求。
 */
export async function modelCatalog(llm: Llm | undefined): Promise<ModelCatalog> {
  if (!llm) return { models: [], unavailable: [], empty: [], problem: '这个版本的 DSH 没有模型目录' }
  let providers: { id: string; name: string }[]
  try { providers = llm.listProviders() } catch (error) { return { models: [], unavailable: [], empty: [], problem: `读不到模型厂商列表：${reason(error)}` } }
  const unavailable: ModelCatalog['unavailable'] = []
  const seen = new Set<string>()
  const lists = await Promise.all(providers.map(async p => {
    try { return { p, models: await llm.listModels(p.id) } }
    catch (error) { unavailable.push({ provider: p.id, providerName: p.name || p.id, error: reason(error) }); return { p, models: [] } }
  }))
  const entries = lists.flatMap(({ p, models }) => models.flatMap(m => {
    const ref = modelRef({ provider: p.id, model: m.id })
    if (!m.id || seen.has(ref)) return []
    seen.add(ref)
    return [{ ref, provider: p.id, providerName: p.name || p.id, id: m.id, name: m.name || m.id }]
  }))
  const models = await Promise.all(entries.map(async m => ({ ...m, ...await reasoningOf(llm, m.provider, m.id) })))
  const failed = new Set(unavailable.map(u => u.provider))
  const empty = providers.filter(p => !failed.has(p.id) && !models.some(m => m.provider === p.id)).map(p => ({ provider: p.id, providerName: p.name || p.id }))
  return { models, unavailable: providers.flatMap(p => unavailable.filter(u => u.provider === p.id)), empty }
}
