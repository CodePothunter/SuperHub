/**
 * 界面定制层：主人用一句话改作战台的样子，不改源码、不打包、不刷新。
 *
 * 存在第二大脑的 ui/custom.json，由接口人经 chief_ui 修改，随 /state 下发给页面。
 * 只开放有限的几个键，值逐个校验（颜色、枚举、范围），不接受任意 CSS 或脚本——这是"普通用户也安全"的前提。
 * 做不到的要求走开发模式（改源码）。
 */

export const TAB_IDS = ['chat', 'today', 'people', 'staff', 'events'] as const
export type TabId = typeof TAB_IDS[number]
export const TAB_NAMES: Record<TabId, string> = { chat: '接口人', today: '今天', people: '人与线', staff: '幕僚团', events: '事件流' }

/** 台面上的区块：键是所在页签，值按默认顺序排列。 */
export const SECTION_IDS = {
  today: ['decide', 'ledger', 'meetings', 'doing'],
  people: ['map', 'lines', 'people'],
} as const
export type BoardTab = keyof typeof SECTION_IDS
export type SectionId = typeof SECTION_IDS[BoardTab][number]
export const SECTION_NAMES: Record<SectionId, string> = {
  decide: '等你决定', ledger: '承诺', meetings: '会议', doing: '幕僚团在办',
  map: '态势图', lines: '横向线', people: '人物',
}

export const RECORD_KINDS = ['people', 'lines', 'ledger', 'meetings', 'tickets'] as const
export type RecordKind = typeof RECORD_KINDS[number]
/** records 面板可以按哪些字段做等值筛选。只做等值，不做查询语言。 */
export const RECORD_FIELDS: Record<RecordKind, readonly string[]> = {
  people: ['group', 'team', 'role', 'influence', 'warmth'],
  lines: ['health', 'blocked'],
  ledger: ['direction', 'status', 'who', 'line', 'dueState'],
  meetings: ['line', 'past'],
  tickets: ['staff', 'stage'],
}

export interface Theme {
  /** 主色：按钮、选中态。 */
  accent?: string
  /** 提醒色：需要主人处理的东西。 */
  warn?: string
  radius?: 'square' | 'normal' | 'round'
  density?: 'compact' | 'normal' | 'roomy'
  /** 整体缩放，0.85 到 1.3。 */
  scale?: number
}

export interface Layout {
  /** 页签顺序（窄屏底栏）；没写到的按默认顺序排在后面。 */
  tabs?: TabId[]
  /** 隐藏的页签、区块或面板 id。接口人页签不能隐藏。 */
  hidden?: string[]
  /** 窄屏打开时先看哪个页签。 */
  defaultTab?: TabId
  /** 各页签里区块的顺序（面板 id 也可以排进来）。 */
  sections?: Partial<Record<BoardTab, string[]>>
}

export type Panel =
  | { id: string; title: string; kind: 'markdown'; path: string; tab: BoardTab }
  | { id: string; title: string; kind: 'records'; of: RecordKind; where: Record<string, string | boolean>; limit: number; tab: BoardTab }

export interface Custom {
  version: 1
  /** 每次修改加一，页面据此判断是否要重新应用。 */
  rev: number
  theme: Theme
  layout: Layout
  panels: Panel[]
}

export const EMPTY_CUSTOM: Custom = { version: 1, rev: 0, theme: {}, layout: {}, panels: [] }

const HEX = /^#[0-9a-fA-F]{6}$/
const ID = /^[a-z][a-z0-9-]{0,31}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v)
const builtinIds = (): Set<string> => new Set<string>([...TAB_IDS, ...SECTION_IDS.today, ...SECTION_IDS.people])

/** 面板里引用的文件：第二大脑里的相对路径，Markdown，不许往上跳。 */
export function validPanelPath(path: string): boolean {
  return /^[^/\\].*\.md$/i.test(path) && !path.split(/[\\/]/).some(p => p === '..' || p === '') && path.length <= 200
}

/**
 * 校验并规整一份定制。不认识或不合法的部分丢掉，并在 dropped 里说明——
 * 接口人据此告诉主人哪些没生效，而不是让坏值进到页面里。
 */
export function normalizeCustom(raw: unknown): { custom: Custom; dropped: string[] } {
  const dropped: string[] = []
  const r = isObj(raw) ? raw : {}
  const theme: Theme = {}
  const t = isObj(r.theme) ? r.theme : {}
  for (const [k, v] of Object.entries(t)) {
    if (v === undefined || v === null) continue
    if ((k === 'accent' || k === 'warn') && typeof v === 'string' && HEX.test(v)) theme[k] = v.toLowerCase()
    else if (k === 'radius' && oneOf(v, ['square', 'normal', 'round'] as const)) theme.radius = v
    else if (k === 'density' && oneOf(v, ['compact', 'normal', 'roomy'] as const)) theme.density = v
    else if (k === 'scale' && typeof v === 'number' && v >= 0.85 && v <= 1.3) theme.scale = Math.round(v * 100) / 100
    else dropped.push(`主题 ${k}=${JSON.stringify(v)}（${k === 'accent' || k === 'warn' ? '颜色要写成 #rrggbb' : k === 'scale' ? '缩放在 0.85 到 1.3 之间' : k === 'radius' ? '圆角只有 square / normal / round' : k === 'density' ? '密度只有 compact / normal / roomy' : '不支持这个主题项'}）`)
  }

  const panels: Panel[] = []
  const seen = new Set<string>()
  for (const p of Array.isArray(r.panels) ? r.panels : []) {
    if (!isObj(p)) { dropped.push('一个面板不是对象'); continue }
    const id = typeof p.id === 'string' ? p.id : ''
    const title = typeof p.title === 'string' ? p.title.trim().slice(0, 24) : ''
    const tab: BoardTab = p.tab === 'people' ? 'people' : 'today'
    if (!ID.test(id) || builtinIds().has(id) || seen.has(id)) { dropped.push(`面板 id「${id}」（要用小写字母开头的英文短名，不能和已有区块重名）`); continue }
    if (!title) { dropped.push(`面板 ${id} 没有标题`); continue }
    if (p.kind === 'markdown') {
      const path = typeof p.path === 'string' ? p.path.trim() : ''
      if (!validPanelPath(path)) { dropped.push(`面板 ${id} 的文件路径「${path}」（要是第二大脑里的 .md 文件，相对路径）`); continue }
      panels.push({ id, title, kind: 'markdown', path, tab })
    } else if (p.kind === 'records' && oneOf(p.of, RECORD_KINDS)) {
      const where: Record<string, string | boolean> = {}
      for (const [k, v] of Object.entries(isObj(p.where) ? p.where : {})) {
        if (RECORD_FIELDS[p.of].includes(k) && (typeof v === 'string' || typeof v === 'boolean')) where[k] = v
        else dropped.push(`面板 ${id} 的筛选条件 ${k}（${p.of} 只能按 ${RECORD_FIELDS[p.of].join('、')} 筛选）`)
      }
      const limit = typeof p.limit === 'number' && p.limit >= 1 && p.limit <= 50 ? Math.floor(p.limit) : 10
      panels.push({ id, title, kind: 'records', of: p.of, where, limit, tab })
    } else { dropped.push(`面板 ${id} 的类型（只有 markdown 和 records）`); continue }
    seen.add(id)
  }

  const known = new Set<string>([...builtinIds(), ...seen])
  const layout: Layout = {}
  const l = isObj(r.layout) ? r.layout : {}
  if (Array.isArray(l.tabs)) {
    const tabs = l.tabs.filter((x): x is TabId => oneOf(x, TAB_IDS))
    if (tabs.length !== l.tabs.length) dropped.push(`页签顺序里不认识的项（页签只有 ${TAB_IDS.join('、')}）`)
    if (tabs.length) layout.tabs = [...new Set(tabs)]
  }
  if (Array.isArray(l.hidden)) {
    const hidden = l.hidden.filter((x): x is string => typeof x === 'string' && known.has(x) && x !== 'chat')
    if (hidden.length !== l.hidden.length) dropped.push('隐藏列表里不认识的项（接口人页签不能隐藏）')
    if (hidden.length) layout.hidden = [...new Set(hidden)]
  }
  if (l.defaultTab !== undefined) {
    if (oneOf(l.defaultTab, TAB_IDS)) layout.defaultTab = l.defaultTab
    else dropped.push(`默认页签 ${JSON.stringify(l.defaultTab)}`)
  }
  if (isObj(l.sections)) {
    const sections: Partial<Record<BoardTab, string[]>> = {}
    for (const [tab, order] of Object.entries(l.sections)) {
      if (!oneOf(tab, ['today', 'people'] as const) || !Array.isArray(order)) { dropped.push(`区块顺序 ${tab}`); continue }
      const ok = order.filter((x): x is string => typeof x === 'string' && ((SECTION_IDS[tab] as readonly string[]).includes(x) || panels.some(p => p.id === x && p.tab === tab)))
      if (ok.length !== order.length) dropped.push(`「${TAB_NAMES[tab]}」的区块顺序里有不属于这个页签的项`)
      if (ok.length) sections[tab] = [...new Set(ok)]
    }
    if (Object.keys(sections).length) layout.sections = sections
  }
  for (const k of Object.keys(l)) if (!['tabs', 'hidden', 'defaultTab', 'sections'].includes(k)) dropped.push(`版式 ${k}（不支持）`)

  const rev = typeof r.rev === 'number' && Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0
  return { custom: { version: 1, rev, theme, layout, panels }, dropped }
}

export interface CustomPatch {
  theme?: Partial<Record<keyof Theme, unknown>>
  layout?: Partial<Record<keyof Layout, unknown>>
  /** 新增或替换（按 id）。 */
  panels?: unknown[]
  /** 删掉这些面板。 */
  removePanels?: string[]
}

/**
 * 在现有定制上做局部修改：主题和版式按键合并（值为 null 表示恢复默认），面板按 id 增改删。
 * 结果再整体校验一遍。
 */
export function applyPatch(current: Custom, patch: CustomPatch): { custom: Custom; dropped: string[] } {
  const theme: Record<string, unknown> = { ...current.theme }
  for (const [k, v] of Object.entries(patch.theme ?? {})) { if (v === null) delete theme[k]; else theme[k] = v }
  const layout: Record<string, unknown> = { ...current.layout }
  for (const [k, v] of Object.entries(patch.layout ?? {})) { if (v === null) delete layout[k]; else layout[k] = v }
  const remove = new Set(patch.removePanels ?? [])
  const incoming = (patch.panels ?? []).filter(isObj)
  const panels: unknown[] = current.panels.filter(p => !remove.has(p.id) && !incoming.some(n => n.id === p.id))
  panels.push(...incoming)
  // 删掉的面板也从隐藏和顺序里拿掉
  if (remove.size) {
    if (Array.isArray(layout.hidden)) layout.hidden = (layout.hidden as unknown[]).filter(x => !remove.has(x as string))
    if (isObj(layout.sections)) layout.sections = Object.fromEntries(Object.entries(layout.sections).map(([k, v]) => [k, Array.isArray(v) ? v.filter(x => !remove.has(x as string)) : v]))
  }
  return normalizeCustom({ rev: current.rev + 1, theme, layout, panels })
}

/** 一句话描述当前定制，给接口人回报用。 */
export function describeCustom(c: Custom): string {
  const parts: string[] = []
  const t = c.theme
  if (t.accent) parts.push(`主色 ${t.accent}`)
  if (t.warn) parts.push(`提醒色 ${t.warn}`)
  if (t.radius) parts.push(`圆角 ${t.radius}`)
  if (t.density) parts.push(`密度 ${t.density}`)
  if (t.scale) parts.push(`缩放 ${t.scale}`)
  const nameOf = (id: string) => (TAB_NAMES as Record<string, string>)[id] ?? (SECTION_NAMES as Record<string, string>)[id] ?? c.panels.find(p => p.id === id)?.title ?? id
  if (c.layout.hidden?.length) parts.push(`隐藏了 ${c.layout.hidden.map(nameOf).join('、')}`)
  if (c.layout.tabs?.length) parts.push(`页签顺序 ${c.layout.tabs.map(nameOf).join(' → ')}`)
  if (c.layout.defaultTab) parts.push(`默认打开 ${nameOf(c.layout.defaultTab)}`)
  for (const [tab, order] of Object.entries(c.layout.sections ?? {})) parts.push(`「${TAB_NAMES[tab as BoardTab]}」区块顺序 ${order.map(nameOf).join(' → ')}`)
  for (const p of c.panels) parts.push(`面板「${p.title}」（${p.kind === 'markdown' ? `显示 ${p.path}` : `${p.of} 列表`}）`)
  return parts.length ? parts.join('；') : '没有定制，都是默认样子'
}
