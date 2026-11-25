import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPERIENCE_EVIDENCE_LIMIT, type ExperienceEvidence } from '../src/core/workspace-experience.ts'
import type { Llm } from '../src/dsh/ports.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import { createExperienceLearning, type ExperienceSignal } from '../src/dsh/workspace-experience-learning.ts'
import { WorkspaceStaffStore } from '../src/dsh/workspace-staff-store.ts'

const dirs: string[] = []
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, {recursive: true, force: true}) })

type ModelInput = {
  text?: string
  kind?: string
  evidence: (ExperienceEvidence & {original?: boolean})[]
  existing: {id: string; version?: number; text: string; replacement?: string}[]
}
type Answer = (input: ModelInput) => unknown | Promise<unknown>

function setup(now?: () => Date) {
  const root = mkdtempSync(join(tmpdir(), 'chief-experience-learning-'))
  dirs.push(root)
  const requests: ModelInput[] = []
  const workspace = (id: string) => { if (id !== 'alpha' && id !== 'beta') throw new Error('unknown workspace') }
  const store = new WorkspaceStaffStore(root, 'brain', () => [], workspace, now)
  function open(answer: Answer, extra: Partial<Parameters<typeof createExperienceLearning>[0]> = {}) {
    const llm = {async *stream(request) {
      expect(request.tools).toEqual([])
      const input = JSON.parse(request.messages[0]!.content[0]!.text) as ModelInput
      requests.push(input)
      yield {type: 'text-delta', text: JSON.stringify(await answer(input))}
    }} satisfies Pick<Llm, 'stream'>
    return createExperienceLearning({root, scope: 'brain', staff: store, writable: workspace, now,
      workspaces: () => ['alpha', 'beta'], llm: () => llm, model: () => ({provider: 'fixture', model: 'fixture'}),
      verifyOriginal: item => item.quote ? {origin: workspaceFingerprint(item.quote), source: item.id} : undefined,
      ...extra})
  }
  const edit = (action: string, requestId: string, fields: Record<string, unknown>) =>
    store.apply('alpha', {action, requestId, audience: 'shared', ...fields})
  return {root, store, open, edit, requests}
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

function artifact(id: string, orderId: string, quote: string): ExperienceSignal {
  const sessionId = 'interviews', workspaceId = 'alpha'
  return {id, workspaceId, kind: 'delivery', sessionId, orderId, summary: '访谈引文与时间戳',
    evidence: [{kind: 'artifact', id, workspaceId, sessionId, orderId, messageId: 'message-' + id,
      fileId: 'file-' + id, resultId: 'result-' + id, version: 'version-' + id, quote}]}
}

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
    expect(first).toMatchObject({text: request.quote, status: 'active', audience: 'shared',
      maintenance: {actor: 'owner'}, evidence: [{id: 'owner-1'}]})
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
    const queuePath = join(f.root, 'ops', 'superhub-experience-learning', workspaceFingerprint('brain') + '.json')
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
    delete queue.pending[0].batch.policy
    writeFileSync(queuePath, JSON.stringify(queue))
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

  it('同一工单多次证明或异单转发现有原件只算一次，第二份独立原件让候选在下一单自动送达', async () => {
    const f = setup()
    const method = '访谈引文保留时间戳以便复核'
    const condition = '已获准录音的访谈引文'
    const performed = '摘录加注时间戳'
    const firstResult = '对照录音核对了第 1 条引文'
    const alternateResult = '同一访谈补核第 3 条引文'
    const secondResult = '对照录音核对了第 2 条引文'
    const firstQuote = [condition, performed, firstResult].join('。')
    const alternateQuote = [condition, performed, alternateResult].join('。')
    const secondQuote = [condition, performed, secondResult].join('。')
    const model: Answer = input => {
      const item = input.evidence[0]!
      const existing = input.existing.find(candidate => candidate.text === method)
      const result = [firstResult, alternateResult, secondResult].find(phrase => item.quote?.includes(phrase))
      return {changes: [{action: existing ? 'support' : 'learn', id: existing?.id, text: method, basis: [item.id],
        ...(item.original && {proofs: [{basis: item.id, method: performed, condition, result}]})}]}
    }
    const learning = f.open(model)
    const original = artifact('report-1', 'order-1', firstQuote)
    const selection = () => f.store.selectExperience({workspaceId: 'alpha', task: '访谈引文保留时间戳以便复核'})
    await learning.settle({...original, id: 'initial-summary', evidence: [{...original.evidence[0]!, kind: 'delivery'}]})
    expect(f.store.experienceMemories('alpha')[0]).toMatchObject({status: 'proposed'})
    await learning.settle(original)
    expect(f.store.experienceMemories('alpha')[0]).toMatchObject({status: 'proposed', situation: condition, supports: [{orderId: 'order-1'}]})
    await learning.settle(artifact('report-1-new', 'order-1', alternateQuote))
    await learning.settle(artifact('report-copied', 'order-copied', firstQuote))
    await learning.settle(artifact('report-alternate-copied', 'order-copied', alternateQuote))
    expect(f.store.view('alpha').sharedExperiences?.[0]?.supportCount).toBe(1)
    expect(selection().entries).toEqual([])
    const second = artifact('report-2', 'order-2', secondQuote)
    await learning.settle(second)
    const [adopted] = f.store.experienceMemories('alpha')
    expect(adopted).toMatchObject({status: 'active', maintenance: {actor: 'system', action: 'accept'},
      supports: [{orderId: 'order-1'}, {orderId: 'order-1'}, {orderId: 'order-2'}]})
    const sent = selection()
    expect(sent.entries).toEqual([expect.objectContaining({id: adopted!.id, version: adopted!.version})])
    f.store.recordExperienceDelivery(sent, {sessionId: 'interviews', turnId: 'turn-3', executorId: 'main', orderId: 'order-3'})
    expect(f.store.experienceDeliveries({workspaceId: 'alpha', turnId: 'turn-3'})[0]).toMatchObject({
      entries: [{id: adopted!.id, version: adopted!.version}],
    })
    await learning.settle(second)
    expect(f.store.experienceMemories('alpha')[0]?.version).toBe(adopted!.version)
  })

  it('保存自动更正、证据冲突和自动过期的来源及历史，人工恢复后同一次整理不会重开冲突', async () => {
    const f = setup()
    const old = '按行号引用'
    const revised = '按段号引用'
    const opposing = '按页码引用'
    const verification: Parameters<typeof createExperienceLearning>[0]['verifyOriginal'] = item => ({
      origin: workspaceFingerprint(item.quote),
      source: item.id,
      ...(item.id === 'new' && {replacementOf: 'old'}),
      ...(item.id === 'withdrawal' && {replacementOf: 'new'}),
    })
    const first = artifact('old', 'order-1', '访谈引文规则。' + old)
    const next = artifact('new', 'order-1', '访谈引文规则。' + revised)
    const conflict = artifact('contradictory', 'order-2', '访谈引文规则。' + opposing)
    const withdrawal = artifact('withdrawal', 'order-1', '访谈引文规则废止')
    const model: Answer = input => {
      const item = input.evidence[0]!
      const incumbent = input.existing[0]
      if (item.quote === first.evidence[0]!.quote) {
        return {changes: [{action: 'learn', text: old, exactEvidenceQuote: old, claim: 'observation',
          situation: '访谈引文规则', boundary: '只限这份模板', basis: [item.id], premise: item.id}]}
      }
      if (item.quote === next.evidence[0]!.quote) {
        expect(incumbent?.replacement).toBe(item.id)
        return {changes: [{action: 'revise', id: incumbent!.id, oldQuote: old, exactEvidenceQuote: revised, basis: [item.id]}]}
      }
      if (item.quote === conflict.evidence[0]!.quote) {
        return {changes: [{action: 'pause', id: incumbent!.id, oldQuote: revised, exactEvidenceQuote: opposing, basis: [item.id]}]}
      }
      return {changes: '没有可核实的新引用规则'}
    }
    const learning = f.open(model, {verifyOriginal: verification})
    await learning.settle({...first, summary: '访谈引文规则。' + old})
    const [before] = f.store.experienceMemories('alpha')
    expect(before).toMatchObject({status: 'active', text: old, maintenance: {action: 'accept', actor: 'system'}})
    await learning.settle({...next, summary: '访谈引文规则。' + revised})
    const [corrected] = f.store.experienceMemories('alpha')
    expect(corrected).toMatchObject({id: before!.id, version: before!.version + 1, status: 'active', text: revised,
      maintenance: {action: 'revise', actor: 'system'}, premise: {id: 'new'}})
    expect(f.store.experienceVersion('alpha', before!.id, before!.version)).toMatchObject({text: old})
    await learning.settle({...conflict, summary: '访谈引文规则。' + revised})
    const [paused] = f.store.experienceMemories('alpha')
    expect(paused).toMatchObject({status: 'retired', conflict: [{id: 'new'}, {id: 'contradictory'}],
      maintenance: {action: 'pause', actor: 'system'}})
    f.edit('restore', 'owner-adjudicates', {memoryId: paused!.id, version: paused!.version, restoreVersion: corrected!.version})
    await learning.settle({...conflict, summary: '访谈引文规则。' + revised})
    expect(f.store.experienceMemories('alpha')[0]).toMatchObject({status: 'active', text: revised,
      maintenance: {action: 'restore', actor: 'manual'}})
    await learning.settle(withdrawal)
    expect(f.store.experienceMemories('alpha')[0]).toMatchObject({status: 'retired',
      maintenance: {action: 'expire', actor: 'system'}, evidence: [{id: 'withdrawal'}]})
  })

  it('明确期限按工作区当日结束计算，不依赖每周整理', async () => {
    let now = new Date('2026-12-20T16:00:00Z')
    const f = setup(() => now)
    const learning = f.open(() => { throw new Error('unexpected model') }, {timeZone: 'Asia/Shanghai'})
    const source = {...askToRemember, text: '截至 2026-12-31，版本缓存按当前路径检查'}
    learning.correct({requestId: 'deadline', action: 'remember', source, quote: source.text, workspaceId: 'alpha'})
    const query = {workspaceId: 'alpha', task: '版本缓存路径检查'}
    const old = f.store.selectExperience(query)
    expect(old.entries).toHaveLength(1)
    expect(f.store.experienceMemories('alpha')[0]?.expiresAt).toBe('2026-12-31T16:00:00.000Z')
    now = new Date('2026-12-31T16:00:00Z')
    expect(() => f.store.assertExperienceCurrent(old)).toThrow('授权已经变化')
    expect(f.store.selectExperience(query).entries).toHaveLength(0)
    expect(f.store.experienceMemories('alpha')[0]).toMatchObject({maintenance: {action: 'expire', actor: 'system'}})
  })

  it('升级后重新复核已存的原件，但不会提交在旧规则下缓存且未执行的改动', async () => {
    const f = setup()
    const signal = artifact('history', 'history-order', '可核实的时间戳示例')
    const oldDelivery: ExperienceEvidence = {...signal.evidence[0]!, kind: 'delivery', id: 'historical-receipt'}
    f.edit('learn', 'legacy-candidate', {text: signal.evidence[0]!.quote, proposed: true,
      situation: '访谈引文', boundary: '只适用于原文', evidence: [oldDelivery]})
    const path = join(f.root, 'ops', 'superhub-staff', workspaceFingerprint('brain') + '.json')
    const legacy = JSON.parse(readFileSync(path, 'utf8'))
    delete legacy.memories[0].maintenance
    writeFileSync(path, JSON.stringify(legacy))
    const blocked = f.open(observe, {staff: {...f.store,
      experienceMemories: f.store.experienceMemories.bind(f.store),
      experienceDeliveries: f.store.experienceDeliveries.bind(f.store),
      view: f.store.view.bind(f.store),
      applyExperienceBatch() { throw new Error('not committed') },
    }})
    await expect(blocked.settle(result())).rejects.toThrow('not committed')
    blocked.dispose()
    const queuePath = join(f.root, 'ops', 'superhub-experience-learning', workspaceFingerprint('brain') + '.json')
    const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
    delete queue.pending[0].batch.policy
    writeFileSync(queuePath, JSON.stringify(queue))
    const recovered = f.open(input => {
      if (input.kind !== 'candidate-recheck') return {changes: []}
      const item = input.evidence[0]!
      const candidate = input.existing[0]!
      return {changes: [{action: 'accept', id: candidate.id, text: candidate.text, exactEvidenceQuote: item.quote,
        claim: 'observation', basis: [item.id]}]}
    }, {resolveOriginals: item => item.id === oldDelivery.id ? signal.evidence : []})
    expect(await recovered.flush('alpha')).toMatchObject({processed: 2, changes: 1, failed: 0, pending: 0})
    expect(f.store.experienceMemories('alpha')).toEqual([expect.objectContaining({text: signal.evidence[0]!.quote,
      status: 'active', maintenance: {action: 'accept', actor: 'system', at: expect.any(String), reason: expect.any(String)}})])
  })

  it('共同经验的整理计数与模型输入都不包含专属材料', async () => {
    const f = setup()
    const member = f.store.apply('alpha', {action: 'create', name: '雪松', brief: '测试', requestId: 'private-member'}).members[0]!
    const learning = f.open(observe)
    const privateResult = result('private')
    learning.observe({...privateResult, staffId: member.id,
      evidence: privateResult.evidence.map(item => ({...item, staffId: member.id}))})
    expect(await learning.flush('alpha', true)).toEqual({processed: 0, changes: 0, pending: 0, failed: 0})
    expect(f.requests).toHaveLength(0)
    expect(await learning.flush('alpha')).toMatchObject({processed: 1, changes: 1, pending: 0, failed: 0})
    expect(f.store.experienceMemories('alpha')).toEqual([expect.objectContaining({staffId: member.id, audience: 'staff'})])
  })

  it('在第二份证明到来后复核先前材料，无法回读的证明不能推动采纳', async () => {
    const f = setup()
    const topic = '访谈引文与时间戳'
    const performed = '为原话增加分钟位置'
    const condition = '访谈已获准录音'
    const first = artifact('revoked-paper', 'order-1', [performed, condition, '已复查甲稿'].join('。'))
    const second = artifact('available-paper', 'order-2', [performed, condition, '已复查乙稿'].join('。'))
    let revoked = false
    const learning = f.open(input => {
      const proof = input.evidence[0]!
      const previous = input.existing[0]
      const result = previous ? '已复查乙稿' : '已复查甲稿'
      if (previous) revoked = true
      return {changes: [{action: previous ? 'support' : 'learn', id: previous?.id, text: topic,
        basis: [proof.id], proofs: [{basis: proof.id, method: performed, condition, result}]}]}
    }, {verifyOriginal: item => item.id !== 'revoked-paper' || !revoked
      ? {origin: workspaceFingerprint(item.quote), source: item.id} : undefined})
    await learning.settle(first)
    expect(f.store.experienceMemories('alpha')[0]?.supports?.[0]?.orderId).toBe('order-1')
    await learning.settle(second)
    expect(f.store.experienceMemories('alpha')[0]).toMatchObject({status: 'proposed', supports: [{orderId: 'order-2'}]})
    expect(f.store.selectExperience({workspaceId: 'alpha', task: topic}).entries).toEqual([])
  })
})
