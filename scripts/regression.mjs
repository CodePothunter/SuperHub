/** Focused regressions runnable on Node 24 without installing dependencies.
 * node --experimental-transform-types --test scripts/regression.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Roster, parseDoc } from '../src/dsh/roster.ts'
import { Engine } from '../src/core/engine.ts'
import { FileStore } from '../src/core/store.ts'
import { LiaisonChat, chatFromEvents } from '../src/dsh/chat.ts'
import { groupPeople } from '../src/client/people.ts'
import { layout } from '../src/client/map-layout.ts'
import { reconcilePending } from '../src/client/chat-state.ts'

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)) }
const event = (seq, type, data) => ({ seq, type, data, time: seq })
const user = (seq, text) => event(seq, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
const reply = (seq, text) => event(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } })

test('CRLF/BOM 人物卡读取、改组织、重新加载、清空均保留旧资料和关系标签', t => {
  const root = mkdtempSync(join(tmpdir(), 'chief-regression-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const create = () => new Roster(root, { commit() {} }, () => '2026-11-16')
  const roster = create()
  const file = join(root, 'people', '杨强.md')
  writeFileSync(file, '\uFEFF---\r\nname: 杨强\r\nteam: 数据平台\r\nrole: 负责人\r\ngroups: 前同事、上游\r\nwarmth: warm\r\n---\r\n\r\n## 画像\r\n先给结论\r\n\r\n## 事实\r\n- 负责调度\r\n\r\n## 互动\r\n- 2026-11-10 对齐接口\r\n')
  assert.equal(roster.person('杨强').organization, undefined)
  assert.deepEqual(roster.person('杨强').groups, ['前同事', '上游'])
  roster.recordPersonFacts('杨强', { organization: '  平台事业部  ' })
  assert.equal(create().person('杨强').organization, '平台事业部')
  roster.recordPersonFacts('杨强', { organization: '产品事业部' })
  assert.equal(create().person('杨强').organization, '产品事业部')
  roster.recordPersonFacts('杨强', { organization: '' })
  const saved = create().person('杨强')
  assert.equal(saved.organization, undefined)
  assert.deepEqual(saved.groups, ['前同事', '上游'])
  assert.equal(saved.team, '数据平台')
  assert.equal(saved.role, '负责人')
  assert.equal(saved.warmth, 'warm')
  assert.equal(saved.profile, '先给结论')
  assert.deepEqual(saved.facts, ['负责调度'])
  assert.deepEqual(saved.log, ['2026-11-10 对齐接口'])
  assert.equal(parseDoc(readFileSync(file, 'utf8')).meta.organization, undefined)
})

test('按组织聚集，旧团队/关系标签不推断组织，名为未分组的组织与空值不冲突', () => {
  const people = [{ id: 'a', organization: '甲部' }, { id: 'b', groups: ['前同事'], team: '甲部' }, { id: 'c', organization: '乙部' }, { id: 'd', organization: '甲部' }, { id: 'e', organization: '未分组' }]
  const sections = groupPeople(people)
  assert.deepEqual(sections.find(s => s.key === 'organization:甲部').people.map(p => p.id), ['a', 'd'])
  assert.deepEqual(sections.at(-1).people.map(p => p.id), ['b'])
  assert.equal(sections.find(s => s.key === 'organization:未分组').people[0].id, 'e')
  assert.equal(new Set(sections.flatMap(s => s.people.map(p => p.id))).size, people.length)
})

test('只有横向线时态势图不崩溃，各节点坐标有效；人物按组织相邻', () => {
  const lines = [{ id: 'x', name: '协作线' }, { id: 'y', name: '评审线' }]
  const alone = layout([], lines)
  assert.ok(alone.placedLines.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)))
  assert.notEqual(alone.placedLines[0].angle, alone.placedLines[1].angle)
  const people = [{ id: 'a', organization: '甲部', lines: ['x'] }, { id: 'b', organization: '乙部', lines: ['x'] }, { id: 'c', organization: '甲部', lines: ['x'] }, { id: 'd', lines: [] }]
  const placed = layout(people, lines)
  assert.deepEqual(placed.placedPeople.map(p => p.item.id), ['a', 'c', 'b', 'd'])
  assert.equal(placed.placedLabels.at(-1).label, '未分组')
  assert.equal(layout([], []).placedLines.length, 0)
})

test('主人插话前后的回复、工具记录按顺序分开', () => {
  const events = [event(1, 'turn/start', {}), user(2, '准备评审'),
    event(3, 'tool/call', { callId: 'a', name: 'chief_lookup', arguments: '{}' }),
    event(4, 'tool/result', { message: { toolCallId: 'a', content: [] } }), reply(5, '先看了评审资料。'),
    user(6, '另记一件事'), reply(7, '另记好了。'), event(8, 'turn/end', {})]
  const parsed = chatFromEvents(events)
  assert.deepEqual(parsed.messages.map(m => m.text), ['准备评审', '先看了评审资料。', '另记一件事', '另记好了。'])
  assert.deepEqual(parsed.messages[1].did, ['查了花名册'])
  assert.equal(parsed.messages[3].did, undefined)
})

test('旧窗口不能发送到另一第二大脑；共享窗口始终使用绑定的会话和其历史', async () => {
  const calls = []
  const controller = { prompt: async request => { calls.push(request); return {} } }
  const chat = new LiaisonChat(controller, 'brain-a', async () => ({ id: 'brain-a', status: 'idle', session: { snapshotEvents: () => [user(1, 'A 的历史')] } }))
  assert.equal((await chat.view()).sessionId, 'brain-a')
  assert.equal((await chat.view()).messages[0].text, 'A 的历史')
  await assert.rejects(chat.say('新的话', 'auto', 'brain-b'), /第二大脑已切换/)
  assert.equal(calls.length, 0)
  await chat.say('新的话', 'auto', 'brain-a')
  assert.equal(calls[0].sessionId, 'brain-a')
  assert.equal(calls[0].mode, 'queue')
})

test('接口人换段后：旧窗口按第一段的 id 仍能发送，消息进当前段；历史接上且序号递增', async () => {
  const calls = []
  const controller = { prompt: async request => { calls.push(request); return {} } }
  const parts = {
    current: () => 'hq-p2', base: () => 'hq', offset: () => 1_000_000_000,
    archived: () => [{ seq: 5, role: 'you', text: '第一段的话', time: 1 }], ready: async () => {},
  }
  const chat = new LiaisonChat(controller, parts, async () => ({ id: 'hq-p2', status: 'idle', session: { snapshotEvents: () => [user(1, '第二段的话')] } }))
  const view = await chat.view()
  assert.equal(view.sessionId, 'hq')
  assert.deepEqual(view.messages.map(m => m.text), ['第一段的话', '第二段的话'])
  assert.ok(view.messages[1].seq > view.messages[0].seq)
  await chat.say('接着说', 'auto', 'hq')
  assert.equal(calls[0].sessionId, 'hq-p2')
  await assert.rejects(chat.say('接着说', 'auto', 'hq-p2'), /第二大脑已切换/)
})

test('相同文字历史不提前确认新消息，每个新事件只确认一次连续重复发送', () => {
  const history = [{ seq: 1, role: 'you', text: '好的', time: 1 }]
  const pending = [1, 2].map(id => ({ id, text: '好的', time: id, afterSeq: 1 }))
  assert.equal(reconcilePending(pending, history).length, 2)
  const first = reconcilePending(pending, [...history, { seq: 2, role: 'you', text: '好的', time: 2 }])
  assert.equal(first.length, 1)
  assert.equal(reconcilePending(first, [...history, { seq: 2, role: 'you', text: '好的', time: 2 }]).length, 1)
  assert.equal(reconcilePending(first, [...history, { seq: 2, role: 'you', text: '好的', time: 2 }, { seq: 3, role: 'you', text: '好的', time: 3 }]).length, 0)
})

function engineFixture(t, decide) {
  const root = mkdtempSync(join(tmpdir(), 'chief-engine-regression-'))
  const staff = ['chief', 'researcher', 'reviewer'].map(id => ({ id, name: id, executor: 'dsh', verifier: 'none', brief: id }))
  const brain = { root, constitution: () => '', staff: () => staff, workspaces: () => [], rules: () => [], workdir: id => join(root, 'work', id), appendNote: path => path, commit() {} }
  const store = new FileStore(root)
  const calls = []
  const executors = { available: () => true, supportsSchema: () => true, run: async request => {
    calls.push(request)
    return request.staff.id === 'chief' ? decide(request) : { text: '', stopReason: 'completed', structured: { status: 'question', summary: '等答复', question: '需要补什么？' } }
  } }
  const engine = new Engine(store, brain, executors, { dispatch() {}, cancel() {} }, { concurrency: 2, timeZone: 'UTC' })
  t.after(() => { engine.stop(); rmSync(root, { recursive: true, force: true }) })
  return { engine, store, staff, calls }
}
const accept = staff => ({ text: '', stopReason: 'completed', structured: { action: 'accept', title: '整理资料', staff, level: 'think', scope: '整理资料', doneWhen: ['产出整理结果'], needsReview: true, priority: 1 } })

test('点名交办负责人是硬约束，即使研判返回其他负责人也不串单', async t => {
  const f = engineFixture(t, () => accept('reviewer'))
  await f.engine.receive({ source: 'inbox', dedupe: 'named', text: '请研究员整理', meta: { staff: 'researcher' } })
  await settle()
  assert.equal(f.engine.views()[0].ticket.staff, 'researcher')
  assert.deepEqual(f.calls.map(c => c.staff.id), ['chief', 'researcher'])
})

test('不能把点名交办并入另一人的工单，也不能悄悄换掉已退休的负责人', async t => {
  let first = true
  const f = engineFixture(t, () => { if (first) { first = false; return accept('reviewer') } return { text: '', stopReason: 'completed', structured: { action: 'attach', ticketId: 'T-0001', reason: '相似' } } })
  await f.engine.receive({ source: 'inbox', dedupe: 'one', text: '旧任务' }); await settle()
  await f.engine.receive({ source: 'inbox', dedupe: 'two', text: '独立任务', meta: { staff: 'researcher' } }); await settle()
  const old = f.engine.views().find(v => v.ticket.id === 'T-0001').ticket
  assert.equal(old.events.length, 1)
  assert.equal(old.inputs.length, 0)
  assert.equal(f.calls.filter(c => c.staff.id === 'chief').at(-1).prompt.includes('T-0001'), false)
})

test('目标在研判前已退休会明确标记不可用，不阻塞后续普通交办', async t => {
  const f = engineFixture(t, () => accept('researcher'))
  await f.engine.receive({ source: 'inbox', dedupe: 'retired', text: '交给离职角色', meta: { staff: 'gone' } })
  await f.engine.receive({ source: 'inbox', dedupe: 'next', text: '正常任务' }); await settle()
  const row = f.engine.recentEvents(20).find(r => r.event.dedupe === 'retired')
  assert.equal(row.disposition.kind, 'unavailable')
  assert.equal(f.engine.views().length, 1)
})
