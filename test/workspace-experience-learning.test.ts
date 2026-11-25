import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPERIENCE_EVIDENCE_LIMIT, type ExperienceEvidence } from '../src/core/workspace-experience.ts'
import type { Llm } from '../src/dsh/ports.ts'
import { createExperienceLearning, type ExperienceSignal } from '../src/dsh/workspace-experience-learning.ts'
import { WorkspaceStaffStore } from '../src/dsh/workspace-staff-store.ts'

const dirs: string[] = []
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, {recursive: true, force: true}) })

type ModelInput = {
  text?: string
  kind?: string
  evidence: ExperienceEvidence[]
  existing: {id: string; version?: number; text: string}[]
}
type Answer = (input: ModelInput) => unknown | Promise<unknown>

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'chief-experience-learning-'))
  dirs.push(root)
  const requests: ModelInput[] = []
  const workspace = (id: string) => { if (id !== 'alpha' && id !== 'beta') throw new Error('unknown workspace') }
  const store = new WorkspaceStaffStore(root, 'brain', () => [], workspace)
  function open(answer: Answer, extra: Partial<Parameters<typeof createExperienceLearning>[0]> = {}) {
    const llm = {async *stream(request) {
      expect(request.tools).toEqual([])
      const input = JSON.parse(request.messages[0]!.content[0]!.text) as ModelInput
      requests.push(input)
      yield {type: 'text-delta', text: JSON.stringify(await answer(input))}
    }} satisfies Pick<Llm, 'stream'>
    return createExperienceLearning({root, scope: 'brain', staff: store, writable: workspace,
      workspaces: () => ['alpha', 'beta'], llm: () => llm, model: () => ({provider: 'fixture', model: 'fixture'}), ...extra})
  }
  const edit = (action: string, requestId: string, fields: Record<string, unknown>) =>
    store.apply('alpha', {action, requestId, audience: 'shared', ...fields})
  return {store, open, edit, requests}
}

const resultText = 'pnpm test -- version cache: 3 tests passed'
function result(id = 'native-result-1', kind: ExperienceEvidence['kind'] = 'test'): ExperienceSignal {
  return {id, workspaceId: 'alpha', kind: 'delivery', sessionId: 'test-session', turnId: 'test-turn', summary: resultText,
    evidence: [{kind, id: 'test-proof', workspaceId: 'alpha', sessionId: 'test-session', quote: resultText}]}
}
const observe = ({evidence}: ModelInput) => ({
  changes: [{action: 'learn', text: resultText, claim: 'observation', exactEvidenceQuote: resultText,
    situation: '版本缓存已有测试', boundary: '只覆盖这三项缓存行为', basis: [evidence[0]!.id]}],
})
const askToRemember = {id: 'owner-1', workspaceId: 'alpha', sessionId: 'test-session',
  text: '以后修版本缓存要检查同类调用路径'}

describe('SuperHub 经验学习', () => {
  it('立即登记主人确切的本区原话，重复请求无需模型，修订证据保留送达的原版本', () => {
    const f = setup(), learning = f.open(() => { throw new Error('unexpected model') })
    const request = {requestId: 'remember', action: 'remember' as const, source: askToRemember,
      workspaceId: 'alpha', quote: askToRemember.text}
    expect(learning.correct(request)).toEqual({recorded: true})
    expect(learning.correct(request)).toEqual({recorded: false})
    expect(() => learning.correct({...request, requestId: 'other', workspaceId: 'beta'})).toThrow('当前范围')
    expect(() => learning.correct({...request, requestId: 'other', quote: '凭空捏造的主人原话'})).toThrow('连续原话')
    expect(f.store.experienceMemories('beta')).toEqual([])
    const [first] = f.store.experienceMemories('alpha')
    expect(first).toMatchObject({text: request.quote, status: 'active', audience: 'shared', evidence: [{id: 'owner-1'}]})
    const selection = f.store.selectExperience({workspaceId: 'alpha', task: '检查版本缓存调用路径'})
    expect(selection.entries).toHaveLength(1)
    f.store.recordExperienceDelivery(selection, {sessionId: 'test-session', turnId: 'test-turn', executorId: 'agent'})
    const revised = {id: 'owner-2', text: '以后也要检查所有缓存清理路径', workspaceId: 'alpha', sessionId: 'test-session'}
    expect(learning.correct({requestId: 'revise', action: 'revise', source: revised, workspaceId: 'alpha',
      quote: revised.text, memory: {id: first!.id, version: first!.version}})).toEqual({recorded: true})
    expect(f.store.experienceMemories('alpha')[0]).toMatchObject({text: revised.text, version: first!.version + 1,
      feedback: [{kind: 'owner-correction', memory: {id: first!.id, version: first!.version}, turnId: 'test-turn'}]})
    expect(f.requests).toHaveLength(0)
  })

  it('只把有精确结果的观察采纳，模型评议保留为候选，忽略不存在或他区依据', async () => {
    const f = setup()
    const learning = f.open(input => {
      const response = observe(input)
      return {changes: [...response.changes,
        {action: 'learn', text: '不要采用模型捏造的依据', basis: ['invented-id']},
        {action: 'learn', text: '所有缓存都应该永远绕过强制刷新', basis: [input.evidence[0]!.id], claim: 'inference'}]}
    })
    // Separate areas would not share any authorized source text. A mismatched reference never reaches the model.
    const other = result('cross-workspace-try')
    expect(learning.observe({...other, workspaceId: 'beta'})).toBeUndefined()
    await learning.settle(result())
    expect(f.store.experienceMemories('alpha').map(({text, status, source}) => [text, status, source])).toEqual([
      [resultText, 'active', 'observation'],
      ['所有缓存都应该永远绕过强制刷新', 'proposed', 'suggestion'],
    ])
    const review = result('review-only', 'model-review')
    await learning.settle({...review, kind: 'review', evidence: [{...review.evidence[0]!, quote: '看上去通过'}]})
    expect(f.store.experienceMemories('alpha').filter(memory => memory.status === 'active')).toHaveLength(1)

    const fresh = setup()
    await fresh.open(observe).settle(result('review-only', 'model-review'))
    expect(fresh.store.experienceMemories('alpha')[0]).toMatchObject({status: 'proposed', source: 'suggestion'})
  })

  it('主人临时指令不落库，明确的长期要求按原话入库且重启后保持幂等', async () => {
    const f = setup()
    const answer: Answer = input => input.text === askToRemember.text
      ? {action: 'remember', quote: input.text} : {action: 'none'}
    const learning = f.open(answer)
    await learning.interpretOwner({...askToRemember, id: 'one-off', text: '这次用表格'})
    expect(f.store.experienceMemories('alpha')).toHaveLength(0)
    await learning.interpretOwner(askToRemember)
    learning.dispose()
    await f.open(answer).interpretOwner(askToRemember)
    expect(f.requests).toHaveLength(2)
    expect(f.store.experienceMemories('alpha')).toHaveLength(1)
  })

  it('只把经验存储能接收的依据交给整理模型，全部引用仍能落盘', async () => {
    const f = setup()
    const learning = f.open(input => ({
      changes:[{action:'learn',text:'使用真实缓存检查结果',basis:input.evidence.map(evidence=>evidence.id)}],
    }))
    const signal = result()
    expect(await learning.settle({...signal,evidence:Array.from({length:EXPERIENCE_EVIDENCE_LIMIT + 2},(_,index)=>
      ({...signal.evidence[0]!,id:'proof-'+index}))})).toMatchObject({processed:1,changes:1,pending:0,failed:0})
    expect(f.store.experienceMemories('alpha')[0]?.evidence).toHaveLength(EXPERIENCE_EVIDENCE_LIMIT)
  })

  it('群聊点名的长期做法属于指定幕僚，旧候选按版本整理，即使没有新成果也不重读历史', async () => {
    const f = setup()
    const member = f.store.apply('alpha', {action: 'create', name: '雪松', brief: '测试', requestId: 'member'}).members[0]!
    f.edit('learn', 'old-active', {text: resultText})
    f.edit('learn', 'old-candidate', {text: resultText, proposed: true})
    const quote = '雪松，以后修版本缓存要检查同类调用路径'
    const learning = f.open(() => ({action: 'remember', quote, staffName: '雪松'}))
    await learning.interpretOwner({...askToRemember, text: quote})
    expect(f.store.experienceMemories('alpha').find(memory => memory.text === quote))
      .toMatchObject({staffId: member.id, audience: 'staff', status: 'active'})
    expect(await learning.flush('alpha')).toMatchObject({processed: 1, changes: 1, pending: 0, failed: 0})
    expect(f.store.experienceMemories('alpha').find(memory => memory.status === 'retired')?.text).toBe(resultText)
    expect(f.requests).toHaveLength(1)
  })

  it('变更提交后、处理位置写入前中断时，重启以同一变更集回放，周时钟和手动走同一队列', async () => {
    const f = setup()
    const staff: Parameters<typeof createExperienceLearning>[0]['staff'] = {
      experienceMemories: f.store.experienceMemories.bind(f.store),
      experienceDeliveries: f.store.experienceDeliveries.bind(f.store),
      view: f.store.view.bind(f.store),
      applyExperienceBatch(...input) {
        f.store.applyExperienceBatch(...input)
        throw new Error('simulated crash after commit')
      },
    }
    const cutoff = '2026-11-25T08:00:00.000Z'
    const first = f.open(observe, {staff, now: () => new Date(cutoff)})
    expect(first.startedAt).toBe(cutoff)
    await expect(first.settle(result())).rejects.toThrow('simulated crash')
    first.dispose()
    const recovered = f.open(() => { throw new Error('unexpected reanalysis') })
    expect(recovered.startedAt).toBe(cutoff)
    const [weekly, manual] = await Promise.all([recovered.scheduled('clock:weekly-dream:2026-11-29'), recovered.flush('alpha')])
    expect(weekly).toMatchObject({processed: 1, changes: 0, pending: 0, failed: 0})
    expect(manual).toMatchObject({processed: 0, changes: 0, pending: 0, failed: 0})
    expect(f.store.experienceMemories('alpha')).toHaveLength(1)
    expect(f.requests).toHaveLength(1)
    recovered.dispose()
    expect(await f.open(observe).scheduled('clock:weekly-dream:2026-11-29')).toBeUndefined()
  })

  it('主人在模型整理期间停用经验，旧变更等待重新分析并且不会复活已停用内容', async () => {
    const f = setup()
    f.edit('learn', 'version-one', {text: resultText})
    const [original] = f.store.experienceMemories('alpha')
    const signal = result()
    const mock: Answer = input => {
      if (f.requests.length === 1) f.edit('retire', 'retire-while-organizing', {memoryId: original!.id, version: original!.version})
      return {changes: [...observe(input).changes, {action: 'learn', text: '新的同区候选', basis: [input.evidence[0]!.id]}]}
    }
    const learning = f.open(mock)
    learning.observe(signal)
    expect(await learning.flush('alpha')).toMatchObject({pending: 1, failed: 1, changes: 0})
    expect(f.store.experienceMemories('alpha').map(memory => [memory.text, memory.status])).toEqual([[resultText, 'retired']])
    expect(await learning.flush('alpha')).toMatchObject({pending: 0, failed: 0, changes: 1})
    await learning.settle(signal)
    expect(f.requests).toHaveLength(2)
    expect(f.store.experienceMemories('alpha').map(memory => [memory.text, memory.status])).toEqual([
      [resultText, 'retired'], ['新的同区候选', 'proposed'],
    ])
  })

  it('借入经验或过期来源不能通过结果提炼被永久存进另一区', async () => {
    const f = setup()
    f.edit('learn', 'source', {text: '版本缓存甲区内部细节'})
    const [memory] = f.store.experienceMemories('alpha')
    f.edit('share', 'borrow-once', {memoryId: memory!.id, sourceVersion: memory!.version,
      targetAudience: 'shared', targetWorkspaceId: 'beta', text: '版本缓存乙区预览'})
    const selection = f.store.selectExperience({workspaceId: 'beta', task: '版本缓存'})
    expect(selection.entries[0]?.shareId).toBeDefined()
    f.store.recordExperienceDelivery(selection, {sessionId: 'test-session', turnId: 'test-turn', executorId: 'agent'})
    const signal = result()
    const learning = f.open(observe, {verifyEvidence: proof => proof.id !== 'removed'})
    expect(await learning.settle({...signal, workspaceId: 'beta',
      evidence: [{...signal.evidence[0]!, workspaceId: 'beta'}]})).toMatchObject({processed: 1, changes: 0})
    const {id, version} = selection.entries[0]!
    expect(await learning.settle({...signal, id: 'continuing-call', workspaceId: 'beta', sourceTurnIds: ['later-turn'],
      sourceExperienceRefs: [{id, version}], evidence: [{...signal.evidence[0]!, workspaceId: 'beta'}]}))
      .toMatchObject({processed: 1, changes: 0})
    expect(await learning.settle({...signal, id: 'removed', evidence: [{...signal.evidence[0]!, id: 'removed'}]}))
      .toMatchObject({processed: 1, changes: 0})
    expect(f.requests).toHaveLength(0)
    expect(f.store.experienceMemories('beta')).toHaveLength(0)
  })
})
