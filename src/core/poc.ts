/**
 * POC（负责人）视角的四类记录：人物、横向线、承诺、会议。
 *
 * 写入规则（混合）：事实与互动由幕僚直接记录；判断（关系温度、影响力、立场、画像、横向线健康度）
 * 只有主人能改，幕僚要改必须走提案。类型上把两类字段分开，写入接口据此设限。
 */

export type Influence = 'high' | 'mid' | 'low'
export type Warmth = 'warm' | 'neutral' | 'cold'
export type Health = 'green' | 'yellow' | 'red'

/** 事实：谁都可以记。 */
export interface PersonFacts {
  role?: string
  team?: string
  /** 主归属：组织；与 groups 的跨组织关系标签分开，空值表示未分组。 */
  organization?: string
  /** 汇报对象的人物 id。 */
  reportsTo?: string
  /**
   * 组：主人自己怎么给人分类（本组、上游、下游、老板线、前同事……），可以属于多个组。
   * 和 team（组织架构上所在的团队）不是一回事。是分类不是评价，所以算事实，谁都可以记。
   */
  groups?: string[]
}

/** 组名：一行、不含分隔符、最长 20 字。 */
export function cleanGroups(list: readonly unknown[]): string[] {
  return [...new Set(list.filter((x): x is string => typeof x === 'string')
    .flatMap(x => x.split(/[,，、;；]/)).map(x => x.replace(/\s+/g, ' ').trim().slice(0, 20)).filter(Boolean))].slice(0, 10)
}

/** 判断：只有主人能改。 */
export interface PersonJudgement {
  influence?: Influence
  warmth?: Warmth
  /** 对我负责的事的立场，自由文本，例如"支持""观望""有顾虑"。 */
  stance?: string
  /** 画像：他关心什么、怎么沟通有效。 */
  profile?: string
}

export interface Person extends PersonFacts, PersonJudgement {
  id: string
  name: string
  /** 最近一次互动的日期 YYYY-MM-DD。 */
  lastContact?: string
  facts: string[]
  /** 互动记录，新的在前；每条形如 `2026-11-15 [1:1] 摘要`。 */
  log: string[]
}

export interface Line {
  id: string
  name: string
  goal?: string
  health?: Health
  /** 合作方人物 id。 */
  partners: string[]
  /** 当前阻塞；空表示没有。 */
  blocker?: string
  /** 下次对齐日期 YYYY-MM-DD。 */
  nextSync?: string
  background?: string
  /** 进展记录，新的在前。 */
  log: string[]
}

export interface Commitment {
  id: string
  /** mine：我答应别人的；theirs：别人答应我的。 */
  direction: 'mine' | 'theirs'
  /** 对方：人物 id 或名字。 */
  who: string
  what: string
  due?: string
  status: 'open' | 'done' | 'dropped'
  line?: string
  createdAt: string
  closedAt?: string
}

export interface Meeting {
  id: string
  title: string
  /** 本地时间 YYYY-MM-DDTHH:MM。 */
  at: string
  with: string[]
  line?: string
  notes?: string
  createdAt: string
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'none'

const DATE = /^\d{4}-\d{2}-\d{2}$/
export const isDate = (value: unknown): value is string => typeof value === 'string' && DATE.test(value) && !Number.isNaN(Date.parse(value))
export const isDateTime = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))

/** 两个日期相差的天数（b - a）。 */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

export function dueState(due: string | undefined, today: string): DueState {
  if (!due) return 'none'
  const days = daysBetween(today, due)
  return days < 0 ? 'overdue' : days === 0 ? 'today' : days <= 3 ? 'soon' : 'later'
}

/**
 * 人物和横向线的 id 同时是文件名，所以这里是写入边界：
 * 不允许路径分隔符、控制字符、以点开头，长度 1 到 40。
 */
export function validId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const id = value.trim()
  // eslint-disable-next-line no-control-regex
  return id === value && id.length >= 1 && id.length <= 40 && !/[\/\\\u0000-\u001f\u007f:*?"<>|]/.test(id) && !id.startsWith('.')
}

export function assertId(value: unknown, what: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!validId(id)) throw new Error(`${what}名称不合法：不能为空、不能含 / \\ 等符号、不超过 40 个字`)
  return id
}
