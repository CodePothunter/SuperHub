/**
 * Markdown 渲染：用 marked 只做解析，再逐个元素渲染成 React。
 *
 * 不把 HTML 字符串塞进页面——文档由幕僚写，内容可能来自网页：
 *   - 原始 HTML 当普通文字显示；
 *   - 链接只放行 http(s) 和 mailto，图片只显示为链接（不加载外部图片）。
 *
 * 可批注：传入 `annotate` 时，每个顶层段落、列表的每一项、表格、代码块、引用都包一层可批注的块，
 * 块的 key 是它在文档里的位置（例如 `4`、`7.2`），批注据此对应回原文。
 *
 * 可装饰：传入 `decorate` 时，正文里的普通文字交给它换成节点（群聊里的 `@名字` 高亮）；链接、代码与引用里的文字原样显示。
 */
import { lexer, type Token, type Tokens } from 'marked'
import { Fragment, type ReactNode } from 'react'

const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined

/** Replaces a run of plain body text (already unescaped) with nodes. */
export type Decorate = (text: string, key: string) => ReactNode

function inline(tokens: readonly Token[] | undefined, key = '', d?: Decorate): ReactNode[] {
  const plain = (text: string, k: string) => d ? <Fragment key={k}>{d(text, k)}</Fragment> : <Fragment key={k}>{text}</Fragment>
  return (tokens ?? []).map((t, i) => {
    const k = `${key}${i}`
    switch (t.type) {
      case 'strong': return <strong key={k}>{inline((t as Tokens.Strong).tokens, `${k}.`, d)}</strong>
      case 'em': return <em key={k}>{inline((t as Tokens.Em).tokens, `${k}.`, d)}</em>
      case 'del': return <del key={k}>{inline((t as Tokens.Del).tokens, `${k}.`, d)}</del>
      case 'codespan': return <code key={k}>{(t as Tokens.Codespan).text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")}</code>
      case 'br': return <br key={k} />
      case 'link': {
        const href = safeHref((t as Tokens.Link).href)
        const children = inline((t as Tokens.Link).tokens, `${k}.`)
        return href ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span key={k}>{children}</span>
      }
      case 'image': {
        const href = safeHref((t as Tokens.Image).href)
        const label = `［图：${(t as Tokens.Image).text || '无说明'}］`
        return href ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <span key={k}>{label}</span>
      }
      case 'text': {
        const tt = t as Tokens.Text
        return tt.tokens?.length ? <Fragment key={k}>{inline(tt.tokens, `${k}.`, d)}</Fragment> : plain(unescape(tt.text), k)
      }
      case 'escape': return <Fragment key={k}>{(t as Tokens.Escape).text}</Fragment>
      case 'checkbox': return null
      default: return <Fragment key={k}>{unescape((t as { raw?: string }).raw ?? '')}</Fragment>
    }
  })
}

/** marked 会把 & < > 转义成实体，我们以文本方式渲染，需要还原。 */
const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** 一个块的纯文本，用作批注引用。 */
export function plainOf(token: Token): string {
  type Node = { type?: string; tokens?: Node[]; items?: Node[]; header?: Node[]; rows?: Node[][]; text?: unknown; raw?: unknown }
  const walk = (t: Node): string => {
    if (Array.isArray(t.tokens) && t.tokens.length) return t.tokens.map(walk).join('')
    if (t.type === 'list') return (t.items ?? []).map(walk).join(' ')
    if (t.type === 'table') return [t.header ?? [], ...(t.rows ?? [])].map(r => r.map(walk).join(' | ')).join(' / ')
    if (t.type === 'space' || t.type === 'hr' || t.type === 'checkbox') return ''
    return unescape(String(t.text ?? t.raw ?? ''))
  }
  return walk(token as unknown as Node).replace(/\s+/g, ' ').trim()
}

export interface Annotate {
  /** 包住一个可批注的块。 */
  wrap(key: string, quote: string, node: ReactNode, inline?: boolean, raw?: string): ReactNode
}

function block(t: Token, key: string, a?: Annotate, d?: Decorate): ReactNode {
  const wrap = (node: ReactNode, quote = plainOf(t)) => a ? a.wrap(key, quote, node, false, t.raw) : <Fragment key={key}>{node}</Fragment>
  switch (t.type) {
    case 'space': return null
    case 'checkbox': return null // 任务列表的勾选框由列表项自己画（marked 18 把它作为单独的块）
    case 'heading': {
      const h = t as Tokens.Heading
      const Tag = (`h${Math.min(6, Math.max(1, h.depth))}`) as 'h1'
      return wrap(<Tag>{inline(h.tokens, '', d)}</Tag>)
    }
    case 'paragraph': return wrap(<p>{inline((t as Tokens.Paragraph).tokens, '', d)}</p>)
    case 'text': {
      const tt = t as Tokens.Text
      return wrap(<p>{tt.tokens?.length ? inline(tt.tokens, '', d) : d ? d(unescape(tt.text), key) : unescape(tt.text)}</p>)
    }
    case 'hr': return <hr key={key} />
    case 'code': return wrap(<pre className="md-code"><code>{(t as Tokens.Code).text}</code></pre>)
    case 'html': return wrap(<p className="md-raw">{(t as Tokens.HTML).text}</p>)
    case 'blockquote': return wrap(<blockquote>{blocks((t as Tokens.Blockquote).tokens)}</blockquote>)
    case 'table': {
      const tb = t as Tokens.Table
      const align = (i: number) => tb.align[i] ?? undefined
      return wrap(<div className="md-table"><table>
        <thead><tr>{tb.header.map((c, i) => <th key={i} style={align(i) ? { textAlign: align(i)! } : undefined}>{inline(c.tokens, '', d)}</th>)}</tr></thead>
        <tbody>{tb.rows.map((r, j) => <tr key={j}>{r.map((c, i) => <td key={i} style={align(i) ? { textAlign: align(i)! } : undefined}>{inline(c.tokens, '', d)}</td>)}</tr>)}</tbody>
      </table></div>)
    }
    case 'list': {
      const l = t as Tokens.List
      const items = l.items.map((item, i) => {
        const body = <>
          {item.task && <span className={`md-check ${item.checked ? 'on' : ''}`} aria-label={item.checked ? '已完成' : '未完成'} />}
          {item.tokens.map((x, j) => x.type === 'text' ? <Fragment key={j}>{inline((x as Tokens.Text).tokens ?? [], `${j}.`, d)}</Fragment> : block(x, `${key}.${i}.${j}`, undefined, d))}
        </>
        const li = <li key={i} className={item.task ? 'task' : undefined}>{a ? a.wrap(`${key}.${i}`, plainOf(item as unknown as Token), body, true, item.raw) : body}</li>
        return li
      })
      return l.ordered ? <ol key={key} start={typeof l.start === 'number' ? l.start : undefined}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    default: return wrap(<p>{unescape((t as { raw?: string }).raw ?? '')}</p>)
  }
}

function blocks(tokens: readonly Token[], a?: Annotate, prefix = '', d?: Decorate): ReactNode[] {
  return tokens.map((t, i) => block(t, `${prefix}${i}`, a, d))
}

export function Markdown({ text, annotate, decorate, className }: { text: string; annotate?: Annotate; decorate?: Decorate; className?: string }) {
  let tokens: Token[]
  try { tokens = lexer(text) } catch { return <pre className={`md ${className ?? ''}`}>{text}</pre> }
  return <div className={`md ${className ?? ''}`}>{blocks(tokens, annotate, '', decorate)}</div>
}
