export interface FeatureRef { id: string; version: number }
export interface FeatureAnchor extends FeatureRef {
  title: string
  aliases: string[]
  surfaces: string[]
  actions: ('inspect' | 'change')[]
  implementation: string
}

const catalog: readonly FeatureAnchor[] = [
  { id: 'liaison-chat', version: 1, title: '接口人对话', aliases: ['接口人对话', '接口人聊天', '聊天窗', 'liaison chat'], surfaces: ['chat', 'today'], actions: ['inspect', 'change'], implementation: 'client/chat' },
  { id: 'discussion-navigation', version: 1, title: '讨论列表', aliases: ['幕僚室导航', '讨论导航', '左侧讨论列表', '讨论列表', '会话导航', 'discussion navigation'], surfaces: ['rooms'], actions: ['inspect', 'change'], implementation: 'client/rooms' },
  { id: 'discussion-space', version: 1, title: '讨论空间', aliases: ['讨论空间', '幕僚室正文', '讨论正文', 'discussion space'], surfaces: ['rooms'], actions: ['inspect', 'change'], implementation: 'client/rooms' },
  { id: 'ticket-detail', version: 1, title: '工单详情', aliases: ['工单详情', '工单对话', '工单抽屉', 'ticket detail'], surfaces: ['tickets'], actions: ['inspect', 'change'], implementation: 'client/ticket-thread' },
  { id: 'execution-history', version: 1, title: '执行记录', aliases: ['执行记录', '派工轮次', '执行日志', 'execution history'], surfaces: ['tickets', 'mission'], actions: ['inspect', 'change'], implementation: 'client/ticket-thread' },
  { id: 'delivery-reader', version: 1, title: '交付阅读与引用', aliases: ['交付阅读', '交付阅读器', '交付引用', 'delivery reader'], surfaces: ['reader', 'tickets'], actions: ['inspect', 'change'], implementation: 'client/reader' },
  { id: 'staff-settings', version: 1, title: '角色配置', aliases: ['角色配置', '幕僚设置', 'staff settings'], surfaces: ['staff', 'settings'], actions: ['inspect', 'change'], implementation: 'client/settings' },
  { id: 'brain-settings', version: 1, title: '第二大脑设置', aliases: ['第二大脑设置', '数据目录设置', 'brain settings'], surfaces: ['settings'], actions: ['inspect', 'change'], implementation: 'client/settings' },
  { id: 'goal-map', version: 1, title: '目标地图', aliases: ['目标地图', 'goal map'], surfaces: ['goals'], actions: ['inspect', 'change'], implementation: 'client/goals' },
  { id: 'mission-control', version: 1, title: '执行指挥塔', aliases: ['执行指挥塔', '指挥塔', 'mission control'], surfaces: ['mission'], actions: ['inspect', 'change'], implementation: 'client/superhub' },
]

export const featureAnchors = (): FeatureAnchor[] => structuredClone([...catalog])
export const currentFeature = (ref: FeatureRef): boolean => catalog.some(row => row.id === ref.id && row.version === ref.version)

export interface FeatureEvidence extends FeatureRef { title: string; basis: string }
export interface IntakeContext {
  surface?: string
  device?: 'desktop' | 'mobile'
  selectedId?: string
  sessionId?: string
  sessionTraceId?: string
  workOrderId?: string
}
export interface SourceSpan { start: number; end: number }
export interface IntakeInterpretation {
  text: string
  span: SourceSpan
  intent: 'memo' | 'execute' | 'conversation'
  operation?: 'read' | 'write'
  staffHint?: string
  restrictions: string[]
  reason: string
  question?: string
  feature?: FeatureEvidence
  candidates?: FeatureEvidence[]
}

/**
 * 主人的原话不由系统解读：接口人（模型）理解后以结构化参数登记工作。这里只保留功能目录本身，
 * 由模型在目录里选一项并说明依据，系统核对标识存在、版本是当前版本。
 */
export function selectFeature(id: unknown, version: unknown, basis: unknown): FeatureEvidence {
  const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }) }
  const entry = typeof id === 'string' ? catalog.find(row => row.id === id) : undefined
  if (!entry) return fail(`功能「${String(id ?? '')}」不在功能目录里，未建单。可选：${catalog.map(row => `${row.id}（${row.title}）`).join('、')}`, 400)
  if (version !== undefined && version !== entry.version) return fail(`功能「${entry.title}」已更新到第 ${entry.version} 版，请按当前版本重新确认修改对象，未建单`, 409)
  if (typeof basis !== 'string' || !basis.trim() || basis.length > 300) return fail('请用 1 到 300 字说明为什么是这个功能（依据主人原话或当前对话），未建单', 400)
  return { id: entry.id, version: entry.version, title: entry.title, basis: basis.trim() }
}

/** 给模型看的功能目录：标识、名称、常见叫法与所在页面。 */
export const featureMenu = (): string => catalog.map(row => `${row.id}（${row.title}；也叫${row.aliases.join('、')}；页面 ${row.surfaces.join('/')}）`).join('；')
