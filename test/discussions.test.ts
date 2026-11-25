import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Engine, Executors, RemoteQueue, RemoteTask, RunRequest, RunResult } from '../src/core/engine.ts'
import type { Staff, Ticket } from '../src/core/model.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { Discussions, deliveryDocument, type Discussion } from '../src/dsh/discussions.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

function fixture(remoteAuthor = false) {
  const root = mkdtempSync(join(tmpdir(), 'chief-discussion-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const author: Staff = { id: 'writer', name: '原作者', executor: remoteAuthor ? 'remote' : 'dsh', verifier: 'none', brief: '原交付角色' }
  const path = 'work/T-0001/report.md', content = '# 报告\n\nPRIVATE_QUOTE 原版证据。'
  mkdirSync(join(root, 'work', 'T-0001'), { recursive: true })
  writeFileSync(join(root, path), content)
  const ticket: Ticket = {
    id: 'T-0001', title: '报告', createdAt: '', staff: author.id, inputs: [], events: [], priority: 1,
    mandate: { strength: 'explicit', level: 'think', scope: '原任务范围', doneWhen: ['交付报告'], needsReview: false, eventId: 'event' },
    assignments: [{ id: randomUUID(), staff: author.id, executor: author.executor, round: 0, startedAt: '', state: 'reported', role: author, report: { status: 'ready', summary: 'PRIVATE_SUMMARY', outputs: [path], structured: true } }],
    ended: { at: '', outcome: 'done', note: '已交付' },
  }
  const engine = { views: () => [{ ticket, stage: 'ended' }], isRetiredTicket: () => false } as unknown as Engine
  const brain = new BrainRepo(root)
  const commit = vi.spyOn(brain, 'commit').mockImplementation(() => {})
  const calls: RunRequest[] = [], tasks: RemoteTask[] = [], replies: RunResult[] = []
  const executors: Executors = { available: () => true, supportsSchema: () => true, run: async request => { calls.push(request); return replies.shift() ?? { text: '依据原版证据作答。', stopReason: 'completed' } } }
  const remote: RemoteQueue = { dispatch: task => { tasks.push(task) }, cancel() {} }
  const document = deliveryDocument(engine, brain, ticket.id, path)
  const spec = { ticketId: ticket.id, path, version: document.version, quote: 'PRIVATE_QUOTE 原版证据。', requestId: randomUUID(), text: '为什么？' }
  const service = () => { const discussions = new Discussions(engine, brain, executors, remote); cleanup.push(() => discussions.dispose()); return discussions }
  const disk = (id = spec.requestId) => JSON.parse(readFileSync(join(root, 'ops', 'discussions', `${id}.json`), 'utf8')) as Discussion
  const legacyEmpty = () => {
    mkdirSync(join(root, 'ops', 'discussions'), { recursive: true })
    writeFileSync(join(root, 'ops', 'discussions', `${spec.requestId}.json`), JSON.stringify({ id: spec.requestId, document, quote: spec.quote, createdAt: '2026-11-16T00:00:00Z', messages: [] } satisfies Discussion))
  }
  return { root, document, spec, commit, calls, tasks, replies, service, disk, legacyEmpty }
}

describe('交付讨论的首次保存与重试', () => {
  it('第一次持久化中断也保留本地问题，重启后同一创建请求可恢复且不改写来源', async () => {
    const f = fixture(), discussions = f.service()
    f.commit.mockImplementationOnce(() => { throw new Error('模拟持久化后的进程中断') })
    expect(() => discussions.create(f.spec)).toThrow('进程中断')
    expect(f.disk()).toMatchObject({ pending: f.spec.requestId, messages: [{ id: f.spec.requestId, role: 'owner', text: f.spec.text }] })
    expect(f.calls).toHaveLength(0)
    discussions.dispose()
    writeFileSync(join(f.root, f.spec.path), '后来修改的交付')
    const restored = f.service()
    expect(restored.get(f.spec.requestId)?.error).toContain('中断')
    restored.create(f.spec)
    await settle()
    const row = f.disk()
    expect(row.document).toEqual(f.document)
    expect(row.messages.map(m => m.role)).toEqual(['owner', 'author'])
    expect(row.pending).toBeUndefined()
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]).toMatchObject({ staff: f.document.author, readOnly: true })
    expect(f.calls[0]!.prompt).toContain(f.document.assignmentId)
    expect(f.calls[0]!.prompt).toContain(f.document.content)
    restored.create({ ...f.spec, text: ` ${f.spec.text} `, quote: ` ${f.spec.quote} ` })
    await settle()
    expect(f.calls).toHaveLength(1)
    expect(f.tasks).toHaveLength(0)
  })

  it('远程首问和派工一起持久化，重启与重试复用原派工及已核对的问题', () => {
    const f = fixture(true), discussions = f.service(), spec = { ...f.spec, remote: true }
    f.commit.mockImplementationOnce(() => { throw new Error('模拟持久化后的进程中断') })
    expect(() => discussions.create(spec)).toThrow('进程中断')
    const row = f.disk(), turn = row.remoteTurns?.[0]
    expect(row.messages).toEqual([{ id: spec.requestId, at: expect.any(String), role: 'owner', text: spec.text, via: 'remote' }])
    expect(turn).toMatchObject({ requestId: spec.requestId, question: spec.text, state: 'waiting' })
    expect(row.pending).toBe(spec.requestId)
    expect(f.tasks).toHaveLength(0)
    discussions.dispose()
    const restored = f.service()
    restored.create(spec)
    expect(f.tasks).toHaveLength(2)
    expect(new Set(f.tasks.map(t => t.assignmentId))).toEqual(new Set([turn!.assignmentId]))
    expect(f.disk().messages).toHaveLength(1)
    expect(f.disk().remoteTurns).toHaveLength(1)
    expect(f.calls).toHaveLength(0)
    expect(f.tasks[0]!.prompt).toContain(spec.text)
    expect(f.tasks[0]!.prompt).not.toMatch(/PRIVATE_QUOTE|PRIVATE_SUMMARY|原交付角色/)
  })

  it.each([false, true])('旧版空讨论可由当前显式请求补全首问（远程发送：%s）', async remote => {
    const f = fixture(true)
    f.legacyEmpty()
    const discussions = f.service()
    expect(() => discussions.create({ ...f.spec, version: 'f'.repeat(64), remote })).toThrow('引用')
    expect(f.disk().messages).toHaveLength(0)
    discussions.create({ ...f.spec, remote })
    await settle()
    expect(f.disk()).toMatchObject({ createdAt: '2026-11-16T00:00:00Z', document: f.document })
    expect(f.disk().messages[0]).toMatchObject({ id: f.spec.requestId, role: 'owner', text: f.spec.text })
    if (remote) {
      expect(f.disk().messages[0]!.via).toBe('remote')
      expect(f.tasks).toHaveLength(1)
      expect(f.calls).toHaveLength(0)
    } else {
      expect(f.disk().messages.at(-1)?.role).toBe('interpreter')
      expect(f.calls[0]?.staff.id).toBe('delivery-interpreter')
      expect(f.tasks).toHaveLength(0)
    }
  })

  it.each([false, true])('重试校验原版本、引用、问题和模式（首次远程发送：%s）', async remote => {
    const f = fixture(true), discussions = f.service(), spec = { ...f.spec, remote }
    discussions.create(spec)
    await settle()
    discussions.dispose()
    const restored = f.service(), before = f.disk(), calls = f.calls.length, tasks = f.tasks.length
    for (const patch of [{ ticketId: 'T-0002' }, { path: 'work/T-0001/other.md' }, { version: createHash('sha256').update('另一个版本').digest('hex') }, { quote: '另一段引用' }, { text: '另一个问题' }, { remote: !remote }, { text: '' }]) {
      expect(() => restored.create({ ...spec, ...patch })).toThrow()
    }
    expect(f.disk()).toEqual(before)
    expect(f.calls).toHaveLength(calls)
    expect(f.tasks).toHaveLength(tasks)
  })

  it('同一请求标识不能把本地解读变成远程发送，也不能把远程问题冒充为本地问题', async () => {
    const f = fixture(true), discussions = f.service()
    discussions.create(f.spec)
    await settle()
    expect(() => discussions.askRemote(f.spec.requestId, f.spec.requestId, f.spec.text)).toThrow('方式')
    expect(f.tasks).toHaveLength(0)
    const remoteRequest = randomUUID()
    discussions.askRemote(f.spec.requestId, remoteRequest, '明确核对过的工作端问题')
    expect(discussions.create(f.spec).pending).toBe(remoteRequest)
    expect(() => discussions.say(f.spec.requestId, remoteRequest, '明确核对过的工作端问题')).toThrow('方式')
    expect(f.tasks).toHaveLength(1)
    expect(f.calls).toHaveLength(1)
    expect(f.disk().messages.filter(m => m.id === remoteRequest)).toHaveLength(1)
  })

  it('创建重试可恢复失败的首问，历史问题被新问题取代后则只返回原讨论', async () => {
    const f = fixture(), discussions = f.service()
    f.replies.push({ text: '', stopReason: 'failed', diagnostic: '临时失败' })
    discussions.create(f.spec)
    await settle()
    expect(f.disk().error).toBe('临时失败')
    discussions.create(f.spec)
    await settle()
    expect(f.disk().messages.map(m => m.role)).toEqual(['owner', 'author'])
    expect(f.calls).toHaveLength(2)

    const failed = randomUUID(), latest = randomUUID()
    f.replies.push({ text: '', stopReason: 'failed', diagnostic: '旧问题失败' })
    discussions.say(f.spec.requestId, failed, '较早但未完成的问题')
    await settle()
    discussions.say(f.spec.requestId, latest, '后来提出的新问题')
    await settle()
    const before = f.disk()
    discussions.say(f.spec.requestId, failed, '较早但未完成的问题')
    discussions.create(f.spec)
    await settle()
    expect(f.disk()).toEqual(before)
    expect(f.calls).toHaveLength(4)
    expect(f.disk().messages.some(m => m.id === `${failed}:answer`)).toBe(false)
  })

  it('失败首问之后另起问题，重放创建请求不会回答后来的问题', async () => {
    const f = fixture(), discussions = f.service()
    f.replies.push({ text: '', stopReason: 'failed', diagnostic: '首问失败' })
    discussions.create(f.spec)
    await settle()
    const latest = randomUUID()
    discussions.say(f.spec.requestId, latest, '后来提出的新问题')
    const pending = f.disk()
    expect(discussions.create(f.spec)).toEqual(pending)
    await settle()
    const before = f.disk()
    discussions.create(f.spec)
    await settle()
    expect(f.disk()).toEqual(before)
    expect(f.calls).toHaveLength(2)
    expect(before.messages.map(m => m.id)).toEqual([f.spec.requestId, latest, `${latest}:answer`])
  })

  it('在本地交付上请求远程作者时不会留下空讨论', () => {
    const f = fixture(), discussions = f.service()
    expect(() => discussions.create({ ...f.spec, remote: true })).toThrow('工作端交付')
    expect(discussions.get(f.spec.requestId)).toBeUndefined()
    expect(discussions.list(f.spec.ticketId, f.spec.path)).toEqual([])
    expect(f.tasks).toHaveLength(0)
  })
})
