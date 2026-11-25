import { workspaceError } from './superhub-goals.ts'

export interface OrderBrief { title: string; promise: string; sessionTitle?: string }
export const BRIEF_GUIDE = '根据主人整段交办，提炼简短的任务标题 title（主题和动作，建议 6–18 字，最多 48 字）和一句结果约定 promise（交付什么、怎样算完成，最多 160 字）。新开会话可填自然的会话短名（最多 48 字）。用普通文字，长说明、操作步骤、命令、表格和完整原话留给执行记录。保留明确的只读或交付边界。'

function line(value: unknown, max: number) {
  if (typeof value !== 'string') return
  const text = value.trim()
  if (!text || Array.from(text).length > max || /[\n\r\u0000-\u001f]|^`{3}|^#{1,6}\s|^[-*|>]\s|^\d+[.)、]\s/.test(text)) return
  return text
}

export function checkedOrderBrief(raw: string, value: {title?:unknown;promise?:unknown;sessionTitle?:unknown}): OrderBrief {
  const title = line(value.title,48), promise = line(value.promise,160)
  const sessionTitle = value.sessionTitle === undefined ? undefined : line(value.sessionTitle,48)
  if (!title || !promise || value.sessionTitle !== undefined && !sessionTitle ||
    raw.length > 160 && [title,promise,sessionTitle].some(label => label && label.length >= 32 && raw.trimStart().startsWith(label) && !raw.trimStart().startsWith(label+'\n'))) {
    return workspaceError(400, '请重新概括这项工作再调用 assign。' + BRIEF_GUIDE)
  }
  return {title,promise,...(sessionTitle && {sessionTitle})}
}

/** Historical wording stays local. Only the owner's instructions can supply the promise. */
export function interimOrderBrief(raw: string, report?: {label?:string;text:string}): OrderBrief {
  const short = line(raw,48)
  if (short) return {title:short,promise:short}
  const lines = raw.split(/\r?\n/).map(row => row.trim()).filter(Boolean)
  const plain = (row:string) => row.replace(/^#{1,6}\s+/, '').replace(/\*\*/g,'').trim()
  const named = /^(?:任务名称|任务标题|项目名称|标题|主题)[：:]\s*(.+)/
  const headings = lines.filter(row => /^#\s+/.test(row)).map(plain)
  const labels = lines.map(row => plain(row).match(named)?.[1]).filter((row):row is string => !!row)
  const section = lines.findIndex(row => /^#{2,6}\s/.test(row))
  const intro = lines.slice(0,section < 0 ? lines.length : section)
    .filter(row => !/^#/.test(row)).map(plain).join(' ')
  const sentences = (value:string) => value.split(/[。！？；]/u).map(row => row.trim()).filter(Boolean)
  const opening = sentences(intro)
  const reportHeading = report?.text.split(/\r?\n/).find(row => /^#\s+/.test(row.trim()))
  const reportTitle = reportHeading ? plain(reportHeading) : report?.label?.replace(/\.[a-zA-Z0-9]+$/,'')
  const title = [...labels,...headings,...opening,reportTitle].map(text => line(text,48))
    .find(text => text && !/^(?:任务|作业|执行稿|说明|报告|结果|readme|report|output|开始前|输出要求)$/i.test(text)) ?? '工单交办'

  const resultLabel = /^(?:结果约定|交付目标|交付要求|预期结果|交付内容|提交内容|输出要求)[：:]\s*/
  const promised = lines.map(plain).filter(row => resultLabel.test(row)).map(row => row.replace(resultLabel,''))
  const delivery = [...promised,...opening.filter(row => /交付|交回|提交|整理成|写成|给出/.test(row))]
    .find(row => line(row,135) && !/[：:]$/.test(row))
  const goal = opening.find(row => row !== delivery && line(row,60) && /核查|完成|整理|撰写|验证|实现|分析/.test(row))
  const boundary = opening.find(row => row !== delivery && row !== goal && line(row,60) && /只读|仅(?:限|需|涉及)|不得|禁止/.test(row))
  let promise = delivery
  if (delivery) {
    if (goal && line(goal+'。'+delivery+'。',160)) promise = goal+'。'+delivery
    if (boundary && line(promise+'。'+boundary+'。',160)) promise += '。'+boundary
  } else promise = goal
  return {title,promise:promise ? promise.replace(/[。 ]+$/,'')+'。' : '交付要求详见原始交办。'}
}
