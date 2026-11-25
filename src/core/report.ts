/**
 * 执行者汇报的解析。
 *
 * DSH 内置子代理支持结构化输出，直接给出 Report；Claude Code / Codex 不支持，
 * 因此派工提示要求它们在回复末尾附一个 ```chief-report 代码块。这里统一解析两种形式，
 * 解析不出时退化为"从自由文本推断"，并把 structured 标记为 false，交给核验把关。
 */
import type { Report, ReportStatus } from './model.ts'

const STATUSES: readonly ReportStatus[] = ['ready', 'question', 'blocked', 'failed', 'dropped']

/** 交给支持结构化输出的执行者的 JSON Schema。 */
export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: [...STATUSES] },
    summary: { type: 'string', description: '给主人看的结论，3 到 6 行' },
    question: { type: 'string', description: 'status 为 question 时，给主人的一个具体问题' },
    choices: { type: 'array', items: { type: 'string' }, description: '可选：仅 status 为 question 且有具体 question 时提供 2 到 6 个清晰不同的纯文本选项，每项 1 到 160 字、单行、无标记；默认允许自由输入，点击选项只填写可编辑草稿，不提交或批准' },
    outputs: { type: 'array', items: { type: 'string' }, description: '产出文件路径' },
  },
} as const

/** 写进派工提示里的汇报约定（给不支持结构化输出的执行者）。 */
export const REPORT_PROTOCOL = [
  '结束时，在回复的最后附上一个汇报代码块，格式严格如下：',
  '```chief-report',
  '{"status": "ready", "summary": "给主人看的结论，3 到 6 行", "outputs": ["产出文件路径"]}',
  '```',
  'status 只能是 ready（完成）、question（需要主人回答一个问题，同时填写 question 字段）、',
  'blocked（缺少条件无法继续）、failed（尝试后失败）、dropped（发现无需处理）。',
  'question 默认由主人自由输入回答；只有确有清晰不同的备选答案时，才可添加可选 choices 字段，例如 "choices": ["先整理现有资料", "先补充缺失证据"]。',
  'choices 仅用于具体的 question，须为 2 到 6 个不同的单行纯文本选项，每项 1 到 160 字，不含 Markdown、HTML 或控制字符。点击只填写可编辑草稿，不自动提交或批准；不要为了凑数编造选项。',
].join('\n')

/** 旧存档和执行者回传共用校验；无效选项整体退回自由输入，不改变原问题。 */
export function questionChoices(report: unknown): string[] | undefined {
  if (!report || typeof report !== 'object') return undefined
  const v = report as Record<string, unknown>
  if (v.status !== 'question' || typeof v.question !== 'string' || !v.question.trim()) return undefined
  if (!Array.isArray(v.choices) || v.choices.length < 2 || v.choices.length > 6) return undefined
  const choices: string[] = [], seen = new Set<string>()
  for (const raw of v.choices) {
    if (typeof raw !== 'string') return undefined
    const text = raw.trim()
    if (!text || text.length > 160 || !/[\p{L}\p{N}]/u.test(text) || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) return undefined
    // Options are labels, not rich text. Keep code names and ordinary punctuation,
    // while refusing HTML, links, code spans and other Markdown formatting.
    if (/<\/?[A-Za-z][^>]*>|!?\[[^\]]*\](?:\(|\[)|`|\*[^*]+\*|(?:^|\s)_{1,2}[^_]+_{1,2}(?=$|\s|[.,!?，。！？])|~~[^~]+~~|^#{1,6}\s|^>\s|^[-*+]\s|^\d+[.)]\s/.test(text)) return undefined
    const key = text.normalize('NFC')
    if (seen.has(key)) return undefined
    seen.add(key); choices.push(text)
  }
  return choices
}

function coerce(value: unknown, structured: boolean): Report | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.status !== 'string' || !STATUSES.includes(v.status as ReportStatus)) return undefined
  if (typeof v.summary !== 'string' || !v.summary.trim()) return undefined
  const outputs = Array.isArray(v.outputs) ? v.outputs.filter((x): x is string => typeof x === 'string') : undefined
  const choices = questionChoices(v)
  return {
    status: v.status as ReportStatus,
    summary: v.summary.trim(),
    ...typeof v.question === 'string' && v.question.trim() ? { question: v.question.trim() } : {},
    ...choices ? { choices } : {},
    ...outputs?.length ? { outputs } : {},
    structured,
  }
}

/** 从结构化输出解析汇报。 */
export const reportFromStructured = (value: unknown): Report | undefined => coerce(value, true)

function lastReportBlock(text: string): string | undefined {
  return [...text.matchAll(/```chief-report\s*\n([\s\S]*?)```/g)].at(-1)?.[1]
}

function parseReportJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

/** 从执行者的文本输出解析汇报：取最后一个 chief-report 代码块。 */
export function reportFromText(text: string): Report {
  const last = lastReportBlock(text)
  if (last !== undefined) {
    const parsed = coerce(parseReportJson(last), true)
    if (parsed) return parsed
  }
  return plainTextReport(text)
}

function plainTextReport(text: string): Report {
  const trimmed = text.trim()
  if (!trimmed) return { status: 'failed', summary: '执行者没有任何输出。', structured: false }
  // 没有汇报块：把输出当作完成的产物交给核验；摘要取末尾，避免长输出淹没作战台。
  const summary = trimmed.length > 600 ? `…${trimmed.slice(-600)}` : trimmed
  return { status: 'ready', summary, structured: false }
}

/** Project workstation returns into the accepted report fields. */
export function reportFromRemote(payload: unknown): Report {
  let report: Report | undefined
  if (typeof payload === 'string') {
    const text = payload.trim()
    const block = lastReportBlock(text)
    if (block !== undefined) report = coerce(parseReportJson(block), false)
    else if (/^[{\[]/.test(text)) report = coerce(parseReportJson(text), false)
    else if (!text.includes('```chief-report')) report = plainTextReport(text)
  } else report = coerce(payload, false)

  if (!report) return { status: 'failed', summary: '工作电脑未返回有效汇报，请核对格式后重试。', structured: false }
  const { status, summary, question, choices } = report
  return { status, summary, structured: false,
    ...status === 'question' && question ? { question, ...(choices ? { choices } : {}) } : {} }
}
