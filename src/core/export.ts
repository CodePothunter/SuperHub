/**
 * 反哺：把第二大脑里主人确认过的内容，整理成别的系统能用的形式。
 *
 * 只取主人确认过的：me.md（关于我的事实）、AGENTS.md 的"我希望幕僚团怎样帮我""原则"、goals.md 里没完成的目标。
 * 花名册（人和对人的判断）、工单产出、日志都不导出。模板里的占位行和说明、标了 [机密] 的行自动去掉。
 *
 * 目标：
 *   chatgpt    ChatGPT 的个性化设置：两段（关于我 / 希望怎样回答），手动粘贴
 *   claude     Claude 的个人偏好或项目说明：一段，手动粘贴
 *   agents-md  Claude Code 的 CLAUDE.md、Codex 的 AGENTS.md：一个带标记的区块，可以自动写入并保持同步
 *   session    开会话时注入的一段背景（Claude Code 的 SessionStart 钩子直接用它）
 */
import { existsSync, readFileSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import { currentGoal, SUPERHUB_GOALS_FILE, type SuperhubGoal } from './superhub-goals.ts'

export { SUPERHUB_GOALS_FILE }

/** Keep legacy prose readable and expose only the current, approved goal versions to consumers. */
export function readGoalsDocument(root: string): string {
  const legacy = pathJoin(root, 'goals.md')
  const structured = pathJoin(root, SUPERHUB_GOALS_FILE)
  const original = existsSync(legacy) ? readFileSync(legacy, 'utf8') : ''
  if (!existsSync(structured)) return original
  const data = JSON.parse(readFileSync(structured, 'utf8')) as { schema: number; goals: SuperhubGoal[] }
  if (data.schema !== 1 || !Array.isArray(data.goals)) throw new Error('结构化目标文件格式未知')
  const adopted = new Set(data.goals.flatMap(goal => goal.source.kind === 'markdown' ? [JSON.stringify([goal.source.section, goal.source.text])] : []))
  let section = '目标'
  const remaining = original.split(/\r?\n/).filter(line => {
    const heading = /^#{2,6}\s+(\S.*)/.exec(line)
    if (heading) section = heading[1]!.trim()
    const item = /^\s*[-*+]\s+\[[ xX]\]\s+(\S.*)/.exec(line)
    return !item || !adopted.has(JSON.stringify([section, item[1]!.trim()]))
  }).join('\n')
  const active = data.goals.map(currentGoal).filter(goal => goal.status === 'active')
  const rows = active.map(goal => {
    // A confidential name hides the entire row. Description lines use the ordinary export filter.
    if (SECRET.test(goal.name)) return ''
    const context = [goal.name, ...goal.description.split(/\r?\n/).filter(line => !SECRET.test(line))]
      .map(line => line.trim()).filter(Boolean).join(' · ')
    return `- [ ] ${context}`
  }).filter(Boolean)
  return rows.length ? `${remaining.trimEnd()}\n\n## 当前已确认目标\n\n${rows.join('\n')}\n` : remaining
}

export const EXPORT_TARGETS = ['chatgpt', 'claude', 'agents-md', 'session'] as const
export type ExportTarget = typeof EXPORT_TARGETS[number]

export interface BrainDocs { me?: string; agents?: string; goals?: string }

export interface ExportPart { label: string; text: string; /** 建议的长度上限（字），超了会截断并说明。 */ limit?: number }
export interface ExportResult { target: ExportTarget; empty: boolean; parts: ExportPart[] }

export const BLOCK_BEGIN = '<!-- dsh-chief:begin（由第二大脑自动生成，改动会被覆盖） -->'
export const BLOCK_END = '<!-- dsh-chief:end -->'

/** 标了机密的行不出第二大脑。 */
export const SECRET = /\[机密\]|【机密】/

/** 去掉模板的说明（引用块）、占位行（含"（例"）、空列表项、标了 [机密] 的行。 */
function clean(md: string): string {
  return md.split('\n')
    .filter(line => !/^\s*>/.test(line) && !/（例[：:]/.test(line) && !/^\s*[-*]\s*(\[ \]\s*)?$/.test(line) && !SECRET.test(line))
    .join('\n')
}

/** 按二级标题切节。 */
function sections(md: string): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = []
  let current: { title: string; lines: string[] } | undefined
  for (const line of clean(md).split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) { if (current) out.push({ title: current.title, body: current.lines.join('\n').trim() }); current = { title: h[1]!, lines: [] }; continue }
    if (/^#\s/.test(line)) continue
    current?.lines.push(line)
  }
  if (current) out.push({ title: current.title, body: current.lines.join('\n').trim() })
  return out.filter(s => s.body)
}

const pick = (md: string | undefined, titles: readonly string[]) => sections(md ?? '').filter(s => titles.some(t => s.title.includes(t)))

/** goals.md 里没完成的目标，带所在的节。 */
function openGoals(md: string | undefined): string {
  return sections(md ?? '').map(s => {
    const items = s.body.split('\n').filter(l => /^\s*[-*]\s*\[ \]\s*\S/.test(l) && !/（待定|（每周/.test(l)).map(l => l.replace(/\[ \]\s*/, ''))
    return items.length ? `${s.title}：\n${items.join('\n')}` : ''
  }).filter(Boolean).join('\n')
}

const join = (parts: { title: string; body: string }[]) => parts.map(p => `${p.title}：\n${p.body}`).join('\n\n')

/** Model context shared with delegated executors contains only work preferences and agreements. */
export function confirmedWorkBehavior(docs: BrainDocs): string {
  const preferences = pick(docs.me, ['偏好'])
  const agreements = pick(docs.agents, ['我希望幕僚团怎样帮我', '协作约定', '原则'])
  const text = join([...preferences, ...agreements])
  return text ? '主人已确认的协作约定和工作偏好（本轮要求优先）：\n' + clip(text, 1600) : ''
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 20).replace(/\n[^\n]*$/, '')}\n（太长，已截断）`
}

export function buildExport(target: ExportTarget, docs: BrainDocs, today: string): ExportResult {
  const facts = join(sections(docs.me ?? ''))
  const goals = openGoals(docs.goals)
  const how = join(pick(docs.agents, ['我希望幕僚团怎样帮我', '原则']))
  const about = [facts, goals ? `目标：\n${goals}` : ''].filter(Boolean).join('\n\n')
  // 只有原则（模板自带的通用写法）不算：要有关于主人本人的事实或目标才导出
  const empty = !facts && !goals
  const parts: ExportPart[] = []
  if (empty) return { target, empty, parts }
  if (target === 'chatgpt') {
    if (about) parts.push({ label: '关于我（填到"想让 ChatGPT 了解你的什么"一栏）', text: clip(about, 1500), limit: 1500 })
    if (how) parts.push({ label: '希望怎样回答（填到"希望 ChatGPT 怎样回应"一栏）', text: clip(how, 1500), limit: 1500 })
  } else if (target === 'claude') {
    parts.push({ label: '个人偏好（Claude 设置里的个人偏好，或某个项目的说明）', text: [about && `关于我：\n${about}`, how && `希望你怎样帮我：\n${how}`].filter(Boolean).join('\n\n') })
  } else if (target === 'agents-md') {
    const body = [about && `### 关于我\n${about}`, how && `### 希望你怎样帮我\n${how}`].filter(Boolean).join('\n\n')
    parts.push({ label: 'CLAUDE.md / AGENTS.md 区块', text: `${BLOCK_BEGIN}\n## 关于用户（来自第二大脑，${today}）\n\n${body}\n${BLOCK_END}` })
  } else {
    parts.push({ label: '会话开头的背景', text: `以下是关于我的背景，来自我的第二大脑（${today} 更新），请在这次对话里参考，不必复述：\n\n${[about, how && `希望你怎样帮我：\n${how}`].filter(Boolean).join('\n\n')}` })
  }
  return { target, empty, parts }
}

/** 把区块写进一个已有的文件：替换标记之间的内容，没有标记就追加到末尾。 */
export function upsertBlock(existing: string, block: string): string {
  const begin = existing.indexOf(BLOCK_BEGIN.slice(0, 24)), end = existing.indexOf(BLOCK_END)
  if (begin >= 0 && end > begin) return `${existing.slice(0, begin)}${block}${existing.slice(end + BLOCK_END.length)}`
  return `${existing.replace(/\s*$/, '')}${existing.trim() ? '\n\n' : ''}${block}\n`
}
