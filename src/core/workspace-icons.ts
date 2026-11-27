/** Artwork categories. Their order gives subject-specific cues priority over general activities. */
const catalogue = {
  landing: { label: '网页与设计', cues: ['落地页', '报名页', '网站', '网页', '官网', '前端', '界面设计', 'landing', 'landingpage', 'website', 'web design', 'frontend', 'ui design'] },
  inbox: { label: '交办与待办', cues: ['我的交办', '待办', '交办', '收件箱', '个人事务', '任务清单', 'inbox', 'todo', 'to do', 'task list'] },
  health: { label: '健康与运动', cues: ['健康', '健身', '运动', '睡眠', '体检', '饮食', '营养', '心率', 'health', 'fitness', 'workout', 'sleep', 'nutrition'] },
  orbit: { label: '命理与人生', cues: ['命运', '命理', '占卜', '六爻', '星象', '人生规划', '人生方向', 'destiny', 'astrology', 'life planning'] },
  people: { label: '团队与招聘', cues: ['招聘', '招募', '候选人', '入职', '团队协作', 'hiring', 'recruiting', 'onboarding', 'team building'] },
  recorder: { label: '访谈与调研', cues: ['访谈', '用户调研', '客户调研', '用户研究', '问卷', 'interview', 'interviews', 'user research', 'user feedback', 'customer discovery', 'survey'] },
  travel: { label: '旅行与行程', cues: ['旅行', '旅游', '行程', '差旅', '出差', '订票', 'travel', 'trip', 'itinerary', 'vacation'] },
  finance: { label: '预算与财务', cues: ['预算', '财务', '记账', '账单', '报销', '发票', '现金流', 'budget', 'finance', 'accounting', 'invoice', 'expense', 'bookkeeping'] },
  content: { label: '写作与传播', cues: ['写作', '文稿', '内容创作', '内容运营', '营销', '选题', '播客', 'writing', 'editorial', 'content', 'marketing', 'newsletter', 'podcast'] },
  prototype: { label: '研发与工程', cues: ['产品研发', '研发', '开发', '工程', '代码', '编程', 'development', 'engineering', 'software', 'coding', 'prototype'] },
  report: { label: '报告与复盘', cues: ['研究周报', '周报', '月报', '报告', '评测', '复盘', '数据分析', 'report', 'analytics', 'benchmark', 'retrospective'] },
  learning: { label: '学习与阅读', cues: ['读书', '阅读', '学习', '课程', '笔记', '知识库', 'study', 'learning', 'reading', 'education', 'course', 'book club'] },
  project: { label: '通用项目', cues: [] },
}

export type WorkspaceIcon = keyof typeof catalogue
export const WORKSPACE_ICONS = Object.keys(catalogue) as WorkspaceIcon[]
export const workspaceIconLabel = (icon: WorkspaceIcon) => catalogue[icon].label
export const isWorkspaceIcon = (value: unknown): value is WorkspaceIcon => typeof value === 'string' && Object.hasOwn(catalogue, value)

function matchWorkspaceIcon(value: unknown): WorkspaceIcon | undefined {
  if (typeof value !== 'string' || !value.trim()) return
  const normalized = value.normalize('NFKC').trim()
  const text = normalized.toLowerCase()
  // Latin cues match words, including the Latin portion of mixed titles such as 品牌Landing.
  const words = ' ' + normalized.replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z\d]+/g, ' ').trim() + ' '
  const exact = WORKSPACE_ICONS.find(icon => catalogue[icon].cues.some(cue => cue === text))
  return exact ?? WORKSPACE_ICONS.find(icon => catalogue[icon].cues.some(cue =>
    /^[a-z]/.test(cue) ? words.includes(' ' + cue + ' ') : text.includes(cue)))
}

/** A local artwork suggestion for the form and store, based on the workspace's stated purpose. */
export function recommendWorkspaceIcon(name: string, goal: string): WorkspaceIcon {
  return matchWorkspaceIcon(name) ?? matchWorkspaceIcon(goal) ?? 'project'
}
