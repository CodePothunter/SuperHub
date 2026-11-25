/**
 * 群聊里的 `@名字`：谁被叫由同一条规则决定，宿主据此调度，网页按它高亮，所以看到被叫的就是真被叫的。
 * 纯函数，宿主与客户端共用，不引第三方依赖。
 *
 * 规则移植自 DS-Bot `ds-bot/src/shared/mentions.js`（见任务 research/dsbot-group-chat.md §2）：
 * - 只认 `@名字`；名字不分大小写，长名字优先（「@新 Bot 2」不会读成「@新 Bot」），名字可含空格；
 * - `@` 前是字母、数字、`_`、`.`、`/` 的是地址（`a@b`、`medium.com/@x`），不算；
 * - 名字后紧跟字母、数字、`_`、`-`、`/`、`\`，或 `.` 后接单词字符，是更长的词或路径（`@Kate`、`@docs/a.md`），不算；
 * - 代码块、行内代码、Markdown 链接里的不算；DSH 引用会话的 `@标签`（每个标签第一次出现）不算；
 * - 全员词 `all / everyone / 所有人 / 全体` 叫全员，不能作名字；先匹配成员名，匹配不到才看全员词。
 * 本项目补充（DS-Bot 没有）：裸网址里的 `@`（`https://x.dev/?u=@K`）与 Markdown 引用行（`> …`）里的 `@` 也不算，
 * 主人转述别人的话或贴链接时不会误叫人。
 */

export const ALL_WORDS = ['all', 'everyone', '所有人', '全体'] as const
/** 会话记录里代表主人的称呼，成员不能叫这些名字（DS-Bot `USER_NAMES`），以免读成主人在说话。 */
export const USER_NAMES = ['user', 'you'] as const

export interface Mentionable { id: string; name: string }
export interface MentionSpan { start: number; end: number; member?: Mentionable; all?: true }
export type MentionSegment = { text: string } | { memberId: string; label: string } | { all: true; label: string }

// mentions.js:16-17
const NAME_GOES_ON = /^(?:[a-z0-9_\-/\\]|\.[a-z0-9_-])/i
const ADDRESS_BEFORE = /[a-z0-9_./]/i
// mentions.js:19：代码与 Markdown 链接（可带标题）原样是文字。
const LITERAL = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g
// 补充：裸网址（只取 ASCII 网址字符，中文标点处截止）与 Markdown 引用行。
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi
const URL_TAIL = /[.,:;!?'")\]*_~]+@?$/
const QUOTE_LINE = /^[ \t]{0,3}>[^\n]*/gm

const fitsAt = (text: string, at: number, word: string) => text.slice(at, at + word.length).toLowerCase() === word.toLowerCase()
  && !NAME_GOES_ON.test(text.slice(at + word.length))
const overlaps = (spans: readonly { start: number; end: number }[], start: number, end: number) =>
  spans.some(span => start < span.end && span.start < end)

/** 成员名能否被 `@` 无歧义地叫到；有问题时返回原因（mentions.js:26-33）。 */
export function nameProblem(name: unknown): string | undefined {
  const text = String(name ?? '').trim()
  if (text === '') return '成员需要名字'
  if (/[@`\r\n]/.test(text)) return '成员名不能含 @、` 或换行'
  if ((ALL_WORDS as readonly string[]).includes(text.toLowerCase())) return `「${text}」会叫到群里所有人，不能作成员名`
  if ((USER_NAMES as readonly string[]).includes(text.toLowerCase())) return `「${text}」在对话里代表主人，不能作成员名`
  return undefined
}

/** 引用会话的 `@标签`：每个标签第一次出现是引用、不是叫人；长标签优先（mentions.js:38-50）。 */
export function referenceSpans(text: string, labels: readonly string[] = []): { start: number; end: number; label: string }[] {
  const spans: { start: number; end: number; label: string }[] = []
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    const mention = `@${label}`
    for (let at = text.indexOf(mention); at !== -1; at = text.indexOf(mention, at + 1)) {
      const end = at + mention.length
      if ((at > 0 && ADDRESS_BEFORE.test(text[at - 1]!)) || NAME_GOES_ON.test(text.slice(end)) || overlaps(spans, at, end)) continue
      spans.push({ start: at, end, label })
      break
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

function literalSpans(value: string) {
  const spans: { start: number; end: number }[] = []
  for (const match of value.matchAll(LITERAL)) spans.push({ start: match.index, end: match.index + match[0].length })
  for (const match of value.matchAll(URL)) {
    const kept = match[0].replace(URL_TAIL, '')
    if (kept.length > 0) spans.push({ start: match.index, end: match.index + kept.length })
  }
  for (const match of value.matchAll(QUOTE_LINE)) spans.push({ start: match.index, end: match.index + match[0].length })
  return spans
}

/** 代码、链接、网址、引用行与引用标签之外的每个 `@名字` 与全员词，按出现顺序（mentions.js:54-72）。 */
export function mentionSpans(text: unknown, members: readonly Mentionable[], { references = [] }: { references?: readonly string[] } = {}): MentionSpan[] {
  const value = String(text ?? '')
  const skip = [...literalSpans(value), ...referenceSpans(value, references)]
  const byLength = members.filter(member => member?.name).sort((a, b) => b.name.length - a.name.length)
  const spans: MentionSpan[] = []
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if ((at > 0 && ADDRESS_BEFORE.test(value[at - 1]!)) || overlaps(skip, at, at + 1)) continue
    const member = byLength.find(candidate => fitsAt(value, at + 1, candidate.name))
    const all = member ? undefined : ALL_WORDS.find(word => fitsAt(value, at + 1, word))
    if (!member && !all) continue
    const end = at + 1 + (member ? member.name.length : all!.length)
    spans.push(member ? { start: at, end, member } : { start: at, end, all: true })
    at = end - 1
  }
  return spans
}

/**
 * 一段话叫了谁：成员 id 按出现顺序、每人一次，`all` 表示用了全员词。
 * 调用方应传入全部成员（含发言人自己），以免「@新 Bot 2」被读成「@新 Bot」；`except` 再去掉发言人（groups.js:133-146）。
 */
export function parseMentions(text: unknown, members: readonly Mentionable[], { references = [], except }: { references?: readonly string[]; except?: string } = {}): { ids: string[]; all: boolean } {
  const ids: string[] = []
  let all = false
  for (const span of mentionSpans(text, members, { references })) {
    if (span.all) all = true
    else if (span.member && span.member.id !== except && !ids.includes(span.member.id)) ids.push(span.member.id)
  }
  return { ids, all }
}

/** 气泡渲染用的分段：普通文字、被叫的成员（`label` 为原文里 `@` 之后的那段）与全员词（user-message.js:95-106）。 */
export function mentionSegments(text: unknown, members: readonly Mentionable[], { references = [] }: { references?: readonly string[] } = {}): MentionSegment[] {
  const value = String(text ?? '')
  const parts: MentionSegment[] = []
  let cursor = 0
  for (const span of mentionSpans(value, members, { references })) {
    if (span.start > cursor) parts.push({ text: value.slice(cursor, span.start) })
    const label = value.slice(span.start + 1, span.end)
    parts.push(span.member ? { memberId: span.member.id, label } : { all: true, label })
    cursor = span.end
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor) })
  return parts
}
