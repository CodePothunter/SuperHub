/**
 * 幕僚实际生效的模型：幕僚卡没写模型时，各执行器按各自的默认走。chief_staff list 和讨论成员的身份都用这里，
 * 让「谁用什么模型」的回答来自配置事实，而不是模型自述。
 */
import type { Staff } from '../core/model.ts'
import type { ModelSelection } from './ports.ts'

export type ModelSource = '幕僚卡' | 'DSH 默认' | '跟随接口人' | 'Codex 配置' | 'Claude Code 配置' | '远程，未知' | '未知'

export interface ModelDefaults {
  /** 接口人当前的模型选择（设置里指定的，或 DSH 默认）。DSH 执行者没写模型时，工单桌把它作为子代理的模型。 */
  liaison?: ModelSelection
  /** 接口人的模型是设置里指定的（true），还是跟随 DSH 默认（false）。 */
  liaisonPinned: boolean
  /** SuperHub 配置里 Codex 审批适配器的模型（需要命令审批的正式工单）。 */
  codexModel?: string
}

export interface EffectiveModel {
  /** provider/model；执行器自己决定、这里读不到时省略。 */
  model?: string
  reasoningEffort?: string
  source: ModelSource
  note?: string
}

const ref = (selection: ModelSelection) => `${selection.provider}/${selection.model}`
const split = (value: string): ModelSelection | undefined => {
  const slash = value.indexOf('/')
  return slash > 0 ? { provider: value.slice(0, slash), model: value.slice(slash + 1) } : undefined
}

/** 一位幕僚执行工单时的生效模型与来源。 */
export function effectiveModel(staff: Pick<Staff, 'executor' | 'model' | 'reasoningEffort'>, defaults: ModelDefaults): EffectiveModel {
  if (staff.executor === 'remote') return { source: '远程，未知', note: '在工作电脑上执行，模型以那边的配置为准，这里读不到' }
  if (staff.model) return { model: staff.model, ...staff.reasoningEffort ? { reasoningEffort: staff.reasoningEffort } : {}, source: '幕僚卡' }
  if (staff.executor === 'codex') {
    return defaults.codexModel
      ? { model: defaults.codexModel, source: 'Codex 配置', note: '需要命令审批的正式工单用 SuperHub 配置的 Codex 模型；只读工单走 DSH 的 Codex 子代理，以它的配置为准' }
      : { source: 'Codex 配置', note: '没有在 SuperHub 配置 Codex 模型，以 Codex CLI 或 DSH Codex 子代理的配置为准' }
  }
  if (staff.executor === 'claude-code') return { source: 'Claude Code 配置', note: '以 Claude Code 自己的模型配置为准' }
  if (staff.executor !== 'dsh') return { source: '未知', note: `执行器 ${staff.executor} 的模型这里读不到` }
  if (!defaults.liaison) return { source: '未知', note: 'DSH 没有默认模型选择' }
  return { model: ref(defaults.liaison), ...defaults.liaison.reasoningEffort ? { reasoningEffort: defaults.liaison.reasoningEffort } : {},
    source: defaults.liaisonPinned ? '跟随接口人' : 'DSH 默认',
    ...defaults.liaisonPinned ? { note: '幕僚卡没写模型，工单沿用接口人的模型' } : {} }
}

/**
 * 讨论里以这位幕僚的 id 拉起的成员该用的模型。只有 DSH 执行者能在讨论里如实代表：Codex、Claude Code、远程的幕僚
 * 不由讨论成员冒充（讨论守卫拒绝拉起，见 runtime.ts）。幕僚卡没写厂商时选不了模型，返回 undefined。
 */
export function teammateSelection(staff: Pick<Staff, 'executor' | 'model' | 'reasoningEffort'>, defaults: ModelDefaults): ModelSelection | undefined {
  if (staff.executor !== 'dsh') return undefined
  const effective = effectiveModel(staff, defaults)
  const chosen = effective.model ? split(effective.model) : undefined
  return chosen && { ...chosen, ...effective.reasoningEffort ? { reasoningEffort: effective.reasoningEffort } : {} }
}

/** 只能经工单在自己的执行器上运行、不能由讨论成员代表的幕僚。 */
export const executorOnly = (staff: Pick<Staff, 'executor'>) => staff.executor !== 'dsh'

/** 讨论成员的名字对应哪位幕僚：按 id（spawn_teammate 要求小写短横线名），其次按中文称呼。 */
export function staffForMember<T extends Pick<Staff, 'id' | 'name'>>(roster: readonly T[], name: string): T | undefined {
  return roster.find(row => row.id === name) ?? roster.find(row => row.name === name)
}
