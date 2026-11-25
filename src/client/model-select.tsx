/**
 * 模型和思考深度的下拉框：选项来自 DSH 的模型目录（GET /models），模型按厂商分组，第一项是“跟随 DSH 默认”。
 * 不提供手工输入。已保存但目录里没有的旧值照样作为当前项保留，保存其他字段时不会被换掉。
 * 思考深度的选项来自所选模型的 reasoning.efforts；换模型后旧档位不适用时回到“模型默认”并说明。
 * 设置页（接口人）和幕僚卡共用这里的 ModelPicker。
 */
import { useEffect, useId, useState } from 'react'
import type { EffortOption, ModelCatalog, ModelEntry } from '../dsh/models.ts'
import { api, ApiError } from './api.ts'

export type { ModelCatalog }

export interface ModelGroup { provider: string; label: string; options: { value: string; label: string }[] }
export interface ModelOptions {
  /** 当前值和打开时已保存的值不在目录里时单独列出（目录还在读时不下“未找到”的结论）。 */
  kept: { value: string; label: string }[]
  groups: ModelGroup[]
  /** 给主人看的说明：目录读不到、为空、部分厂商失败、旧值不在目录里。 */
  note?: string
  /** 说明里有需要主人注意的问题（读取失败、目录为空、部分厂商失败）。 */
  warn: boolean
}

const names = (rows: { providerName: string }[]) => rows.map(r => r.providerName).join('、')

/**
 * 目录 + 当前值 → 下拉框的选项。catalog 为 undefined 且没有 error 表示还在读；error 表示整个目录读取失败。
 * saved 是打开时已保存的值：主人在下拉里换走后仍能换回来。
 */
export function modelOptions(value: string, catalog?: ModelCatalog, error?: string, saved = value): ModelOptions {
  const groups: ModelGroup[] = []
  for (const m of catalog?.models ?? []) {
    let group = groups.find(g => g.provider === m.provider)
    if (!group) groups.push(group = { provider: m.provider, label: m.providerName, options: [] })
    group.options.push({ value: m.ref, label: m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id })
  }
  const known = new Set(groups.flatMap(g => g.options.map(o => o.value)))
  const failed = error ?? catalog?.problem
  const checked = !!catalog && !failed
  const missing = [...new Set([saved, value])].filter(v => v && !known.has(v))
  const kept = missing.map(v => ({ value: v, label: checked ? `${v}（目录中未找到）` : v }))
  const down = names(catalog?.unavailable ?? [])
  const empty = names(catalog?.empty ?? [])
  const notes: string[] = []
  if (failed) notes.push(`没能读取 DSH 模型目录：${failed}。下拉里只有“跟随 DSH 默认”${kept.length ? '和当前设置' : ''}，暂时不能换成其他模型。`)
  else if (!catalog) notes.push('正在读取 DSH 的模型目录…')
  else if (!groups.length) notes.push(`DSH 模型目录里没有可选的模型${down ? `（${down} 读取失败）` : ''}${empty ? `（${empty} 没有列出模型，通常是还没配置凭据）` : ''}，请先在 DSH 的模型设置里配置厂商和凭据。下拉里只有“跟随 DSH 默认”${kept.length ? '和当前设置' : ''}。`)
  else if (down) notes.push(`${down} 的模型没有读到，暂时不能选。`)
  if (checked && missing.length) notes.push(`${missing.map(v => `“${v}”`).join('、')} 不在 DSH 的模型目录里，保存其他设置时会原样保留；要换请在下拉中重新选择。`)
  return { kept, groups, ...notes.length ? { note: notes.join(' ') } : {}, warn: !!failed || (!!catalog && (!groups.length || !!down)) }
}

export interface EffortChoices {
  options: { value: string; label: string; description?: string }[]
  /** 只有一项可选时禁用：模型跟随默认、模型不支持调节、目录还没读到。 */
  disabled: boolean
  note?: string
  warn: boolean
}

const entryOf = (catalog: ModelCatalog | undefined, model: string): ModelEntry | undefined => catalog?.models.find(m => m.ref === model)
const effortLabel = (e: EffortOption) => e.name && e.name !== e.id ? e.name : e.id

/**
 * 所选模型 + 当前档位 → 思考深度下拉的选项。第一项永远是空值（模型跟随默认时是“跟随 DSH 默认”，否则“模型默认”）。
 * 当前档位读不到（旧模型不在目录里、目录读取失败）时作为当前项保留，可以改回模型默认。
 */
export function effortChoices(model: string, effort: string, catalog?: ModelCatalog, error?: string): EffortChoices {
  if (!model) return { options: [{ value: '', label: '跟随 DSH 默认' }], disabled: true, note: '模型跟随 DSH 默认时，思考深度也跟随 DSH 默认。', warn: false }
  const entry = entryOf(catalog, model)
  const efforts = entry?.efforts ?? []
  const fallback = efforts.find(e => e.id === entry?.defaultEffort)
  const options: EffortChoices['options'] = [{ value: '', label: fallback ? `模型默认（${effortLabel(fallback)}）` : '模型默认' }]
  options.push(...efforts.map(e => ({ value: e.id, label: effortLabel(e), ...e.description ? { description: e.description } : {} })))
  const known = !effort || efforts.some(e => e.id === effort)
  if (!known) options.push({ value: effort, label: `${effort}（无法确认）` })
  let note: string | undefined
  let warn = false
  if (error || catalog?.problem) { note = '读不到模型目录，暂时不能调节思考深度。'; warn = true }
  else if (!catalog) note = '正在读取思考深度…'
  else if (!entry) note = '这个模型不在 DSH 的模型目录里，读不到它的思考深度档位。'
  else if (entry.effortProblem) { note = `读不到这个模型的思考深度：${entry.effortProblem}`; warn = true }
  else if (!efforts.length) { options[0] = { value: '', label: '此模型不支持调节' }; note = '此模型不支持调节思考深度。' }
  if (!known && note) note += `已保存的“${effort}”会原样保留，也可以改回模型默认。`
  else if (!known) note = `“${effort}”不在这个模型的思考深度里，请重新选择。`
  if (!note) note = options.find(o => o.value === effort)?.description
  return { options, disabled: options.length < 2, ...note ? { note } : {}, warn }
}

/**
 * 换模型时的思考深度：新模型支持原档位就保留，否则回到模型默认，并给出要显示的说明。
 * 不能把新模型不支持的档位带进保存请求。
 */
export function effortAfterModelChange(model: string, effort: string, catalog?: ModelCatalog): { effort: string; notice?: string } {
  if (!effort) return { effort: '' }
  if (!model) return { effort: '', notice: `模型改为跟随 DSH 默认，思考深度也随之跟随默认（原来是“${effort}”）。` }
  const entry = entryOf(catalog, model)
  const kept = entry?.efforts.find(e => e.id === effort)
  if (kept) return { effort }
  const name = entry ? entry.name || entry.id : model
  return { effort: '', notice: entry && !entry.effortProblem
    ? `${name} 不支持思考深度“${effort}”，已改回模型默认。`
    : `读不到 ${name} 的思考深度，没法确认“${effort}”是否可用，已改回模型默认。` }
}

/** 打开时读一次目录：设置页和幕僚卡各自打开时取最新的。 */
export function useModelCatalog() {
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let live = true
    api<ModelCatalog>('/models').then(c => {
      if (!live) return
      if (c && Array.isArray(c.models) && Array.isArray(c.unavailable)) setCatalog({ ...c, empty: Array.isArray(c.empty) ? c.empty : [], models: c.models.map(m => ({ ...m, efforts: Array.isArray(m.efforts) ? m.efforts : [] })) })
      else setError('主机返回的不是模型目录')
    }, (e: Error) => {
      // 旧版服务端没有这个接口：前端已更新而 DSH 还没重新加载插件时会这样
      if (live) setError(e instanceof ApiError && e.status === 404 ? '正在运行的 SuperHub 服务端还没有模型目录接口，重启 DSH 加载新版本后再打开' : e.message)
    })
    return () => { live = false }
  }, [])
  return { catalog, error }
}

export interface ModelValue { model: string; effort: string }

/**
 * 模型 + 思考深度两个下拉。layout=field 对应设置页的 .wr-field（标签一列、控件一列），
 * layout=form 对应幕僚卡 .wr-form 里纵向的 label。两个下拉各自有可访问名称，说明经 aria-describedby 关联。
 */
export function ModelPicker({ value, onChange, label, effortLabel: effortName = '思考深度', hint, layout, disabled }: {
  value: ModelValue; onChange: (next: ModelValue) => void; label: string; effortLabel?: string; hint?: React.ReactNode; layout: 'field' | 'form'; disabled?: boolean
}) {
  const { catalog, error } = useModelCatalog()
  const [saved] = useState(value)
  const [notice, setNotice] = useState<string>()
  const models = modelOptions(value.model, catalog, error, saved.model)
  const efforts = effortChoices(value.model, value.effort, catalog, error)
  const modelNote = useId(), effortNote = useId(), noticeId = useId(), hintId = useId()
  const pickModel = (model: string) => {
    const next = model === saved.model && !value.effort && saved.effort ? { effort: saved.effort } : effortAfterModelChange(model, value.effort, catalog)
    setNotice(next.notice)
    onChange({ model, effort: next.effort })
  }
  const pickEffort = (effort: string) => { setNotice(undefined); onChange({ model: value.model, effort }) }
  const describe = (...ids: (string | false | undefined)[]) => { const list = ids.filter(Boolean).join(' '); return list ? { 'aria-describedby': list } : {} }
  const modelSelect = <select className="wr-model-select" aria-label={label} value={value.model} disabled={disabled} onChange={e => pickModel(e.target.value)} {...describe(models.note && modelNote, hint !== undefined && layout === 'field' && hintId)}>
    <option value="">跟随 DSH 默认</option>
    {models.kept.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    {models.groups.map(g => <optgroup key={g.provider} label={g.label}>
      {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </optgroup>)}
  </select>
  const effortSelect = <select className="wr-model-select" aria-label={effortName} value={value.effort} disabled={disabled || efforts.disabled} onChange={e => pickEffort(e.target.value)} {...describe(efforts.note && effortNote, notice && noticeId)}>
    {efforts.options.map(o => <option key={o.value} value={o.value} {...o.description ? { title: o.description } : {}}>{o.label}</option>)}
  </select>
  const modelHint = models.note && <span id={modelNote} className={`hint wr-model-note${models.warn ? ' warn' : ''}`} role="status">{models.note}</span>
  const effortHint = <>
    {notice && <span id={noticeId} className="hint wr-model-note warn" role="status">{notice}</span>}
    {efforts.note && <span id={effortNote} className={`hint wr-model-note${efforts.warn ? ' warn' : ''}`}>{efforts.note}</span>}
  </>
  if (layout === 'field') return <>
    <label className="wr-field"><span className="label">{label}</span>{modelSelect}{hint !== undefined && <span id={hintId} className="hint">{hint}</span>}{modelHint}</label>
    <label className="wr-field"><span className="label">{effortName}</span>{effortSelect}{effortHint}</label>
  </>
  return <>
    <label className="wr-model-cell">{label}{modelSelect}{modelHint}</label>
    <label className="wr-model-cell">{effortName}{effortSelect}{effortHint}</label>
  </>
}
