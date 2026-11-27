import { describe, expect, it, vi } from 'vitest'
import type { EngagementInput } from '../src/core/workspace-engagement.ts'
import type { Llm } from '../src/dsh/ports.ts'
import { llmEngagementCoordinator, parseEngagement } from '../src/dsh/workspace-engagement.ts'

const source = {seq: 7, speakerId: 'member', author: '编辑', text: '草案已写好'}
const input: EngagementInput = {
  turn: 'member', source, messages: [source], members: [{id: 'reviewer', name: '审稿人'}],
  pending: [{id: 'question-2', question: '用哪个版本？', messageId: 'g-5'}],
}
const parse = (value: object) => parseEngagement(JSON.stringify(value), input)

describe('workspace engagement decisions', () => {
  it('accepts verified member IDs and a named delivery checkpoint', () => {
    expect(parse({kind: 'continue', memberIds: ['reviewer', 'reviewer'], text: '校对全文',
      checkpoint: 'draft', report: '草案已完成，见第 7 条发言。'})).toEqual({
      kind: 'continue', memberIds: ['reviewer'], text: '校对全文', checkpoint: 'draft', report: '草案已完成，见第 7 条发言。',
    })
    expect(parse({kind: 'continue', memberIds: ['other-workspace'], text: '工作'})).toBeUndefined()
    expect(parse({kind: 'continue', memberIds: ['reviewer'], text: '工作', report: '结果'})).toBeUndefined()
  })

  it('rejects decisions tied to unknown questions or missing evidence', () => {
    expect(parse({kind: 'none', resolved: ['other-question']})).toBeUndefined()
    expect(parse({kind: 'none', resolved: ['question-2']})).toBeUndefined()
    expect(parse({kind: 'ask', text: '原话在哪里', sourceSeq: 99})).toBeUndefined()
    expect(parse({kind: 'deliver', text: '更新', final: false})).toBeUndefined()
    expect(parse({kind: 'deliver', text: '更新', final: false, checkpoint: 'final'})).toBeUndefined()
    expect(parse({kind: 'deliver', text: '更新', evidenceSeqs: [22]})).toBeUndefined()
    expect(parse({kind: 'wait', reason: '等材料', reviewAt: 'soon'})).toBeUndefined()
    expect(parse({kind: 'wait', reason: '等材料', reviewAt: '0'})).toBeUndefined()
    expect(parse({kind: 'wait', reason: '等材料', reviewAt: '2026-11-26T12:00:00+08:00', waitForMember: 'other-workspace'})).toBeUndefined()
    expect(parse({kind: 'wait', reason: '等材料', reviewAt: '2026-11-26T12:00:00+08:00'}))
      .toMatchObject({kind: 'wait', reason: '等材料'})
  })

  it('accepts only owner questions or no action for an ordinary group completion', () => {
    const check = (value: object) => parseEngagement(JSON.stringify(value), {...input, ownerQuestionCheck: true})
    expect(check({kind: 'ask', text: '用哪个版本？', sourceSeq: 5})).toMatchObject({kind: 'ask', sourceSeq: 5})
    expect(check({kind: 'none'})).toEqual({kind: 'none'})
    expect(check({kind: 'continue', memberIds: ['reviewer'], text: '校对全文'})).toBeUndefined()
    expect(check({kind: 'deliver', text: '汇报草案'})).toBeUndefined()
  })

  it('gives the liaison model only scoped evidence and accepts chunked decisions', async () => {
    const stream = vi.fn<Llm['stream'] & {}>(async function* () {
      yield {type: 'text-delta', text: '{"kind":"continue",'}
      yield {type: 'text-delta', text: '"memberIds":["reviewer"],"text":"核对主张"}'}
    })
    const port: Llm = {listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), stream}
    const decide = llmEngagementCoordinator(() => port, () => ({provider: 'fixture', model: 'liaison'}))
    expect(await decide(input, new AbortController().signal)).toMatchObject({kind: 'continue', text: '核对主张'})
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({provider: 'fixture', model: 'liaison', tools: []}))
    const request = stream.mock.calls[0]![0]
    expect(JSON.parse(request.messages[0]!.content[0]!.text).source).toEqual(source)
  })
})
