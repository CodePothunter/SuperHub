import { describe, expect, it } from 'vitest'
import { questionChoices, REPORT_PROTOCOL, REPORT_SCHEMA, reportFromStructured, reportFromText } from '../src/core/report.ts'

const question = { status: 'question', summary: '现有材料已整理，需要确定下一步。', question: '先做哪一步？' }
const block = (value: unknown) => `过程记录\n\`\`\`chief-report\n${JSON.stringify(value)}\n\`\`\``
const parsers = [
  { name: '结构化汇报', parse: reportFromStructured },
  { name: '文本协议汇报', parse: (value: unknown) => reportFromText(block(value)) },
]

describe.each(parsers)('$name 的可选快捷回复', ({ parse }) => {
  it('具体问题保留规范化选项，且不修改执行者原对象', () => {
    const original = { ...question, question: ' 先做哪一步？ ', choices: [' 先整理已有资料 ', '先补充缺失证据'], outputs: ['work/report.md'] }
    expect(parse(original)).toEqual({ ...question, choices: ['先整理已有资料', '先补充缺失证据'], outputs: ['work/report.md'], structured: true })
    expect(original.choices[0]).toBe(' 先整理已有资料 ')
  })

  it('允许边界数量、长度、中文和普通标点', () => {
    const choices = ['甲'.repeat(160), '先用 A/B 做比较', '检查 snake_case 文件', '优先保证 C++ 兼容', '限定为 10–20 个样本', '只做资料梳理（不执行）']
    expect(parse({ ...question, choices })?.choices).toEqual(choices)
  })

  it('不强制选择，旧版问题、其他状态和无具体问题均保持自由输入', () => {
    expect(parse(question)).toEqual({ ...question, structured: true })
    for (const status of ['ready', 'blocked', 'failed', 'dropped']) {
      expect(parse({ ...question, status, choices: ['先整理资料', '先补充证据'] })).not.toHaveProperty('choices')
    }
    for (const missing of [undefined, '', '  ', 123, null]) {
      expect(parse({ ...question, question: missing, choices: ['先整理资料', '先补充证据'] })).not.toHaveProperty('choices')
    }
    expect(parse({ status: 'question', summary: '旧版只有摘要的问题' })).toEqual({ status: 'question', summary: '旧版只有摘要的问题', structured: true })
  })

  it('格式、数量或长度不合法时只丢弃选项，不丢失原问题', () => {
    const invalid = [undefined, null, '先整理资料', 2, {}, [], ['先整理资料'], Array.from({ length: 7 }, (_, i) => `方案 ${i}`),
      ['先整理资料', 1], ['先整理资料', false], ['先整理资料', null], ['先整理资料', {}], ['先整理资料', ['先补充证据']],
      ['先整理资料', ''], ['先整理资料', '  '], ['先整理资料', '乙'.repeat(161)], ['先整理资料', '...']]
    for (const choices of invalid) {
      expect(parse({ ...question, choices }), JSON.stringify(choices)).toEqual({ ...question, structured: true })
    }
  })

  it('重复及视觉相同的规范等价选项整体回退自由输入', () => {
    for (const choices of [['方案甲', '方案甲'], ['方案甲', ' 方案甲 '], ['café', 'cafe\u0301']]) {
      expect(parse({ ...question, choices })).toEqual({ ...question, structured: true })
    }
  })

  it('不把多行、隐藏控制字符或富文本当作快捷回复', () => {
    const invalid = ['先整理\n资料', '先整理\r资料', '先整理\t资料', '先\u0000整理资料', '先\u007f整理资料', '先\u2028整理资料', '先\u2029整理资料', '先\u202e整理资料',
      '<button>整理资料</button>', '[整理资料](https://example.com)', '![整理资料](image.png)', '[整理资料][ref]', '`整理资料`', '*整理资料*', '_整理资料_', '**整理资料**', '__整理资料__', '~~整理资料~~', '# 整理资料', '> 整理资料', '- 整理资料', '1. 整理资料']
    for (const text of invalid) {
      expect(parse({ ...question, choices: [text, '先补充证据'] }), text).toEqual({ ...question, structured: true })
    }
  })

  it('保持现有摘要、产出路径和其他字段的解析兼容性', () => {
    expect(parse({ status: 'ready', summary: ' 完成 ', question: ' 兼容已有字段 ', outputs: ['a.md', 123, 'b.md'], unknown: 'ignored' }))
      .toEqual({ status: 'ready', summary: '完成', question: '兼容已有字段', outputs: ['a.md', 'b.md'], structured: true })
  })
})

describe('快捷回复协议与旧存档校验', () => {
  it('旧存档和报告解析使用相同的安全回退规则', () => {
    expect(questionChoices({ ...question, choices: ['整理资料', '补充证据'] })).toEqual(['整理资料', '补充证据'])
    expect(questionChoices({ ...question, choices: ['整理资料', '整理资料'] })).toBeUndefined()
    expect(questionChoices({ ...question, status: 'ready', choices: ['整理资料', '补充证据'] })).toBeUndefined()
    expect(questionChoices(null)).toBeUndefined()
  })

  it('最后一个报告块选项无效也保留该问题，不回退到上一份报告或猜测选项', () => {
    const text = `${block({ ...question, choices: ['整理资料', '补充证据'] })}\n${block({ ...question, question: '最后这个问题？', choices: ['唯一选项'] })}`
    expect(reportFromText(text)).toEqual({ ...question, question: '最后这个问题？', structured: true })
    expect(reportFromText('下一步先整理资料，或者先补充证据？')).toEqual({ status: 'ready', summary: '下一步先整理资料，或者先补充证据？', structured: false })
    expect(reportFromText('')).toMatchObject({ status: 'failed', structured: false })
    expect(reportFromStructured({ ...question, status: 'unknown', choices: ['整理资料', '补充证据'] })).toBeUndefined()
  })

  it('结构化与文本协议都约定可选项，并保持原报告必填字段不变', () => {
    expect(REPORT_SCHEMA.required).toEqual(['status', 'summary'])
    expect(REPORT_SCHEMA.properties.choices).toMatchObject({ type: 'array', items: { type: 'string' } })
    expect(REPORT_SCHEMA.properties.choices.description).toContain('2 到 6')
    expect(REPORT_PROTOCOL).toContain('question 默认由主人自由输入回答')
    expect(REPORT_PROTOCOL).toContain('不自动提交或批准')
  })
})
