import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, type Annotate } from '../src/client/markdown.tsx'

const html = (text: string, annotate?: Annotate) => renderToStaticMarkup(<Markdown text={text} {...annotate ? { annotate } : {}} />)

describe('Markdown 渲染', () => {
  it('常用排版都渲染出来', () => {
    const out = html('# 标题\n\n一段**加粗**、*斜体*和`代码`\n\n- [x] 已完成\n- 普通项\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> 引用\n\n```\nx < y\n```')
    for (const tag of ['<h1>', '<strong>加粗</strong>', '<em>斜体</em>', '<code>代码</code>', 'md-check on', '<table>', '<blockquote>', 'x &lt; y']) expect(out).toContain(tag)
  })
  it('任务列表只画一个勾选框，不把 [ ] 当文字', () => {
    const out = html('- [ ] 画地图\n- [x] 跑通环境\n')
    expect(out).not.toContain('[ ]')
    expect(out).not.toContain('[x]')
    expect(out.match(/md-check/g)?.length).toBe(2)
    expect(out).toContain('md-check on')
  })

  it('原始 HTML 当文字显示，危险链接不可点', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[点我](javascript:alert(1)) [正常](https://example.com) ![图](https://x/y.png)')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('href="javascript')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('［图：图］')
  })
  it('每个段落和列表项都能批注，引用是该块的纯文本', () => {
    const seen: [string, string][] = []
    html('第一段**重点**\n\n- 甲\n- 乙\n\n第三段', { wrap: (key, quote, node) => { seen.push([key, quote]); return <div key={key}>{node}</div> } })
    expect(seen).toEqual([['0', '第一段重点'], ['2.0', '甲'], ['2.1', '乙'], ['4', '第三段']])
  })
})
