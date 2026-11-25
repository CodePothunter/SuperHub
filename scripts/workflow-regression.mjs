/** End-to-end domain journey plus durable transport and citation boundary regressions. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync, chmodSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Engine } from '../src/core/engine.ts'
import { FileStore } from '../src/core/store.ts'
import { FileRemoteQueue } from '../src/dsh/remote.ts'
import { Discussions, deliveryDocument } from '../src/dsh/discussions.ts'
import { Worklines } from '../src/dsh/worklines.ts'
import { Roster } from '../src/dsh/roster.ts'
import { runOnce } from '../bin/runner.mjs'
import { requestId } from '../src/client/request-id.ts'
import { runtimeRoutes } from '../src/dsh/http.ts'

const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r)) }
const result = structured => ({ text: '', structured, stopReason: 'completed' })
function fixture(t, override) {
  const root = mkdtempSync(join(tmpdir(), 'chief-workflow-'))
  const staff = ['chief', 'strategist', 'reviewer', 'researcher', 'external'].map(id => ({ id, name: id, executor: id === 'external' ? 'remote' : 'dsh', verifier: id === 'reviewer' ? 'none' : 'reviewer', brief: `原角色 ${id}` }))
  const brain = { root, staff: () => staff, constitution: () => '', workspaces: () => [], rules: () => [], commit() {}, workdir(id) { const dir = join(root, 'work', id); mkdirSync(dir, { recursive: true }); return dir }, saveRemoteReport(id, round, raw) { const path = `work/${id}/remote-report-${round}.md`; writeFileSync(join(brain.workdir(id), `remote-report-${round}.md`), raw); return path } }
  const store = new FileStore(root), remote = new FileRemoteQueue(root), calls = []
  let engine
  const executors = { available: () => true, supportsSchema: () => true, run: async request => { calls.push(request); return override?.(request, engine, brain) ?? result({ verdict: 'pass', critique: '证据与标准均满足' }) } }
  engine = new Engine(store, brain, executors, remote, { concurrency: 3, timeZone: 'UTC' })
  const roster = new Roster(root, brain, () => '2026-11-16')
  t.after(() => { engine.stop(); rmSync(root, { recursive: true, force: true }) })
  return { root, staff, brain, store, remote, engine, executors, calls, roster }
}
async function parent(f, text = '评测两个方案') {
  return f.engine.commission({ title: '评测并更新简报', text, staff: 'strategist', level: 'think', scope: text, doneWhen: ['交付评测结论与证据'], needsReview: true, lineId: '评测线', remoteBrief: '在工作电脑评测两个方案，仅回传结论、指标摘要与限制' })
}

test('旅程：横向线发起 → 真委派 → 工作端断线补传不重跑 → 核验 → 原谋士更新同一工单简报', async t => {
  let runs = 0, childId
  const f = fixture(t, async (r, engine, brain) => {
    if (r.staff.id === 'strategist') {
      runs++
      if (runs === 1) { childId = await engine.delegate(r.binding, { key: 'evaluate', staff: 'external', text: '模型故意夹带 PRIVATE_PERSONAL_CONTEXT', criterion: 0 }); assert.equal(await engine.delegate(r.binding, { key: 'changed-replay-key', staff: 'external', text: '改名重放', criterion: 0 }), childId); return result({ status: 'question', summary: '等待子任务', question: '等待评测结果' }) }
      assert.match(r.prompt, /关联子任务.*done/)
      assert.match(r.prompt, /原角色 strategist/)
      writeFileSync(join(brain.workdir(r.binding.ticketId), 'report.md'), '# 评测结论\n\n方案甲更适合当前负载。\n\n证据来自已核验的工作端汇报。')
      return result({ status: 'ready', summary: '简报已更新，方案甲更适合', outputs: [`work/${r.binding.ticketId}/report.md`] })
    }
    return result({ verdict: 'pass', critique: '核验通过' })
  })
  f.roster.upsertLine('评测线', { goal: '维护长期评测' })
  const work = new Worklines(f.engine, f.brain, f.roster)
  work.confirm('评测线', '先测两个方案，再决定切换')
  const id = await parent(f, '私人背景 PRIVATE_PERSONAL_CONTEXT；评测两个方案'); await settle()
  assert.equal(f.engine.views().find(v => v.ticket.id === id).stage, 'waiting')
  assert.equal(f.store.ticket(childId).mandate.needsReview, false)
  const task = JSON.parse(readFileSync(join(f.remote.dir, 'outbox', readdirSync(join(f.remote.dir, 'outbox'))[0]), 'utf8'))
  assert.doesNotMatch(task.prompt, /PRIVATE_PERSONAL_CONTEXT|AGENTS.md/)
  assert.match(task.prompt, /在工作电脑评测两个方案，仅回传结论/)
  let executions = 0, offline = true
  const workstation = join(f.root, 'workstation')
  const payload = { status: 'ready', summary: '方案甲通过；延迟 80ms，样本 1000 次，限制：仅测试负载；文件留在工作电脑 /local/eval.md' }
  const transport = { root: workstation, pull: async () => task, execute: async () => { executions++; return payload }, push: async (aid, report) => { if (offline) throw new Error('offline'); writeFileSync(join(f.remote.dir, 'inbox', `${aid}.json`), JSON.stringify({ ticketId: task.ticketId, assignmentId: aid, report })) } }
  await assert.rejects(runOnce(transport), /offline/)
  assert.equal(JSON.parse(readFileSync(join(workstation, '.chief-runner', `${task.assignmentId}.json`))).state, 'completed')
  offline = false; await runOnce({ ...transport, pull: async () => ({}) }); assert.equal(executions, 1)
  await f.remote.drain(async () => { throw new Error('temporary disk error') }, () => {})
  assert.equal(readdirSync(join(f.remote.dir, 'inbox')).length, 1); assert.equal(readdirSync(join(f.remote.dir, 'done')).length, 0)
  await f.remote.drain(r => f.engine.remoteReport(r.ticketId, r.assignmentId, r.report), () => {}); await settle()
  assert.equal(f.engine.views().find(v => v.ticket.id === id).stage, 'you/review')
  assert.equal(runs, 2); assert.equal(f.store.ticket(id).inputs.filter(i => i.key === `child:${childId}`).length, 1)
  assert.equal(await f.engine.remoteReport(task.ticketId, task.assignmentId, payload), true); await settle(); assert.equal(runs, 2)
  assert.equal(await f.engine.remoteReport(task.ticketId, task.assignmentId, { ...payload, summary: '伪造覆盖' }), false)
  await f.engine.recover(); await settle(); assert.equal(runs, 2)
  const view = work.view('评测线'); assert.equal(view.decisions.length, 1); assert.equal(view.tickets.length, 2); assert.equal(view.needsDecision[0].id, id); assert.equal(view.evidence.some(e => e.path.endsWith('report.md')), true)
})

test('引用讨论保留作者、版本、原文、跨天历史；回复和显式跟进并发不会丢写，也不重开原单', async t => {
  let release
  const f = fixture(t, async (r, _engine, brain) => {
    if (r.label.startsWith('讨论')) { assert.equal(r.staff.brief, '原角色 strategist'); assert.equal(r.readOnly, true); return new Promise(resolve => { release = () => resolve({ text: '依据原评测证据回答。', stopReason: 'completed' }) }) }
    if (r.staff.id === 'strategist') { writeFileSync(join(brain.workdir(r.binding.ticketId), 'report.md'), '# 报告\n\n方案甲更适合当前负载。'); return result({ status: 'ready', summary: '原版本摘要', outputs: [`work/${r.binding.ticketId}/report.md`] }) }
    return result({ verdict: 'pass', critique: '通过' })
  })
  const id = await parent(f); await settle(); await f.engine.accept(id)
  const d = deliveryDocument(f.engine, f.brain, id, `work/${id}/report.md`)
  f.staff.find(s => s.id === 'strategist').brief = '后来改的角色'
  const discussions = new Discussions(f.engine, f.brain, f.executors); t.after(() => discussions.dispose())
  const req = randomUUID(); const row = discussions.create({ ticketId: id, path: d.path, version: d.version, quote: '方案甲更适合当前负载。', text: '为什么？', requestId: req, author: '冒名者' })
  assert.equal(row.document.author.brief, '原角色 strategist')
  await settle(); const follow = await discussions.followUp(row.id, '比较成本'); release(); await settle()
  assert.equal(discussions.get(row.id).followUp, follow); assert.equal(discussions.get(row.id).messages.length, 2)
  assert.equal(f.store.ticket(id).ended.outcome, 'done'); assert.equal(f.store.ticket(id).assignments.length, 1)
  const restored = new Discussions(f.engine, f.brain, f.executors); t.after(() => restored.dispose())
  assert.equal(restored.list(id, d.path)[0].messages.length, 2)
  writeFileSync(join(f.root, d.path), '替换后的内容')
  assert.throws(() => restored.create({ ticketId: id, path: d.path, version: d.version, quote: '替换后的内容', text: '新问题', requestId: randomUUID() }), /文档已更新/)
  restored.say(row.id, randomUUID(), '第二天继续问'); await settle(); release(); await settle()
  assert.equal(restored.get(row.id).messages.length, 4); assert.equal(restored.get(row.id).quote, row.quote)
  assert.equal(await restored.followUp(row.id, '重放'), follow)
})

test('拒绝跨工单路径、符号链接、伪造引用；远程作者只由 hub 解读且不转发私人问答', async t => {
  const f = fixture(t, r => r.label.startsWith('讨论') ? { text: '这是 hub 资料解读，非原作者。', stopReason: 'completed' } : result({ verdict: 'pass', critique: '通过' }))
  const id = await f.engine.commission({ title: '远程报告', text: '评测', staff: 'external', level: 'think', scope: '只做评测', doneWhen: ['回传结论'], needsReview: false }); await settle()
  const a = f.store.ticket(id).assignments[0]; await f.engine.remoteReport(id, a.id, { status: 'ready', summary: '回传证据结论' }); await settle()
  const path = `work/${id}/remote-report-0.md`; const d = deliveryDocument(f.engine, f.brain, id, path)
  assert.throws(() => deliveryDocument(f.engine, f.brain, 'T-9999', path), /不属于/)
  mkdirSync(join(f.root, 'work', 'T-9999'), { recursive: true }); writeFileSync(join(f.root, 'work', 'T-9999', 'secret.md'), 'secret'); symlinkSync(join(f.root, 'work', 'T-9999', 'secret.md'), join(f.root, 'work', id, 'link.md'))
  assert.throws(() => deliveryDocument(f.engine, f.brain, id, `work/${id}/link.md`), /不属于/)
  const discussions = new Discussions(f.engine, f.brain, f.executors); t.after(() => discussions.dispose())
  assert.throws(() => discussions.create({ ticketId: id, path, version: d.version, quote: '根本没有', text: '问题', requestId: randomUUID() }), /原文/)
  const row = discussions.create({ ticketId: id, path, version: d.version, quote: '回传证据结论', text: 'PRIVATE_QUESTION', requestId: randomUUID() }); await settle()
  assert.equal(discussions.get(row.id).messages.at(-1).role, 'interpreter')
  assert.equal(f.calls.at(-1).staff.executor, 'dsh'); assert.equal(readdirSync(join(f.remote.dir, 'outbox')).length, 1)
})

test('旧工单不猜历史归属；显式关联/决定/承诺持久且保留旧资料', async t => {
  const f = fixture(t, () => result({ status: 'question', summary: '待回答', question: '补充条件' }))
  f.roster.upsertLine('评测线', { goal: '旧目标', background: '旧背景' }); f.roster.logLine('评测线', { text: '旧进展' })
  const id = await f.engine.commission({ title: '评测线同名旧工单', text: '旧工单', staff: 'researcher', level: 'think', scope: '旧范围', doneWhen: ['完成'], needsReview: true }); await settle()
  const work = new Worklines(f.engine, f.brain, f.roster)
  assert.equal(work.view('评测线').tickets.length, 0)
  work.link('评测线', id); work.confirm('评测线', '主人确认的决定')
  f.roster.addCommitment({ direction: 'theirs', who: '伙伴', what: '补证据', line: '评测线' })
  const restored = new Worklines(f.engine, f.brain, f.roster).view('评测线')
  assert.equal(restored.tickets.length, 1); assert.equal(restored.commitments.length, 1); assert.equal(restored.decisions.length, 1); assert.equal(restored.background, '旧背景'); assert.match(restored.log[0], /旧进展/)
})

test('子任务等待主人验收、不递归；取消父任务会取消远端，重启不双唤醒', async t => {
  let childId
  const f = fixture(t, async (r, engine) => {
    if (r.staff.id === 'strategist') { childId = await engine.delegate(r.binding, { key: 'read', staff: 'researcher', text: '整理部分证据', criterion: 0, needsReview: true }); return result({ status: 'ready', summary: '等待' }) }
    if (r.staff.id === 'researcher') { await assert.rejects(engine.delegate(r.binding, { key: 'recursive', staff: 'external', text: '绕过', criterion: 0 }), /递归/); return result({ status: 'ready', summary: '证据完成' }) }
    return result({ verdict: 'pass', critique: '通过' })
  })
  const id = await parent(f); await settle()
  assert.equal(f.engine.views().find(v => v.ticket.id === id).stage, 'waiting'); assert.equal(f.engine.views().find(v => v.ticket.id === childId).stage, 'you/review')
  await f.engine.stopTicket(id, '主人取消'); await settle()
  assert.equal(f.store.ticket(childId).ended.outcome, 'stopped'); assert.equal(f.store.ticket(id).ended.outcome, 'stopped')
  assert.equal(await f.engine.remoteReport(childId, '00000000-0000-0000-0000-000000000000', { status: 'ready', summary: '迟到' }), false)
})

test('不安全 HTTP 源没有 randomUUID 时仍生成合法唯一请求标识', () => {
  const ids = new Set(Array.from({ length: 50 }, () => requestId())); assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
})

const subprocess = (args, env, input) => new Promise(resolve => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = ''
  child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { err += d }); child.stdin.end(input)
  child.on('close', code => resolve({ code, out, err }))
})
test('bridge 并发相同回传幂等，不同回传只能接受第一份；重复补推不覆盖且可修复发布窗口', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chief-bridge-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const queue = new FileRemoteQueue(root), id = randomUUID(), task = { ticketId: 'T-0001', assignmentId: id, title: '任务', prompt: '最小任务' }
  writeFileSync(join(queue.dir, 'taken', `${id}.json`), JSON.stringify(task))
  const env = { CHIEF_BRAIN: root }, command = [resolve('bin/cli.mjs'), 'bridge', 'push', id]
  const payload = JSON.stringify({ status: 'ready', summary: '唯一回传' })
  const same = await Promise.all(Array.from({ length: 6 }, () => subprocess(command, env, payload)))
  assert.ok(same.every(r => r.code === 0), JSON.stringify(same)); assert.equal(readdirSync(join(queue.dir, 'inbox')).length, 1)
  const stored = readFileSync(join(queue.dir, 'inbox', `${id}.json`), 'utf8')
  const different = await subprocess(command, env, JSON.stringify({ status: 'ready', summary: '覆盖攻击' })); assert.equal(different.code, 2); assert.equal(readFileSync(join(queue.dir, 'inbox', `${id}.json`), 'utf8'), stored)
  // Receipt survived a crash before inbox publication: same push republishes it.
  rmSync(join(queue.dir, 'inbox', `${id}.json`)); assert.equal((await subprocess(command, env, payload)).code, 0); assert.equal(readFileSync(join(queue.dir, 'inbox', `${id}.json`), 'utf8'), stored)
  let received = 0; await queue.drain(async () => { received++; return true }, () => {}); assert.equal(received, 1)
  assert.equal((await subprocess(command, env, payload)).code, 0); assert.equal(readdirSync(join(queue.dir, 'inbox')).length, 0)
  // First writer wins even when two different payloads race on a new task.
  const otherId = randomUUID(); writeFileSync(join(queue.dir, 'taken', `${otherId}.json`), JSON.stringify({ ...task, assignmentId: otherId }))
  const race = await Promise.all(['甲', '乙'].map(summary => subprocess([resolve('bin/cli.mjs'), 'bridge', 'push', otherId], env, JSON.stringify({ status: 'ready', summary }))))
  assert.deepEqual(race.map(r => r.code).sort(), [0, 2]); assert.equal(readdirSync(join(queue.dir, 'inbox')).length, 1)
})

test('runner 直接脚本与 CLI 入口都领取并执行；本地 running 崩溃记录只回传失败不重跑', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chief-runner-entry-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin'); mkdirSync(bin)
  const ssh = join(bin, 'ssh'); writeFileSync(ssh, '#!/bin/sh\nprintf "called\\n" >> "$CHIEF_TEST_CALLS"\nprintf "{}\\n"\n'); chmodSync(ssh, 0o755)
  const calls = join(root, 'calls'); const env = { PATH: `${bin}:${process.env.PATH}`, CHIEF_WORKDIR: root, CHIEF_TEST_CALLS: calls }
  assert.equal((await subprocess([resolve('bin/runner.mjs')], env)).code, 0)
  assert.equal((await subprocess([resolve('bin/cli.mjs'), 'runner'], env)).code, 0)
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2)
  const id = randomUUID(); writeFileSync(join(root, '.chief-runner', `${id}.json`), JSON.stringify({ state: 'running', task: { ticketId: 'T-0001', assignmentId: id, prompt: '最小任务' } }))
  let executed = 0, pushed
  await runOnce({ root, pull: async () => ({}), execute: async () => { executed++; return '' }, push: async (_id, report) => { pushed = report } })
  assert.equal(executed, 0); assert.equal(pushed.status, 'failed'); assert.match(pushed.summary, /未自动重跑/)
})

test('远端作者追问只出口主人核对字段，复用原目录，经独立核验写回同一讨论，重启/重复不双答', async t => {
  let verifyReady = false
  const f = fixture(t, r => {
    if (r.label.startsWith('讨论')) return { text: '中心根据资料解读。', stopReason: 'completed' }
    if (r.label.startsWith('核验作者追问')) return verifyReady ? result({ verdict: 'pass', critique: '问题得到回答，已指出证据与限制' }) : { text: '', stopReason: 'error', diagnostic: 'temporary unavailable' }
    return result({ verdict: 'pass', critique: '原任务核验通过' })
  })
  const id = await f.engine.commission({ title: '原远程任务', text: '原始工作评测', staff: 'external', level: 'think', scope: '评测', doneWhen: ['回传结论'], needsReview: false }); await settle()
  const originalAssignment = f.store.ticket(id).assignments[0]
  await f.engine.remoteReport(id, originalAssignment.id, { status: 'ready', summary: 'PRIVATE_DELIVERY_QUOTE：原回传结论' }); await settle()
  const path = `work/${id}/remote-report-0.md`, document = deliveryDocument(f.engine, f.brain, id, path)
  const discussions = new Discussions(f.engine, f.brain, f.executors, f.remote); t.after(() => discussions.dispose())
  const row = discussions.create({ ticketId: id, path, version: document.version, quote: 'PRIVATE_DELIVERY_QUOTE', requestId: randomUUID(), text: 'PRIVATE_PERSONAL_QUESTION' }); await settle()
  const req = randomUUID(), confirmed = '请说明原评测采样数与限制，只回传结论。'
  discussions.askRemote(row.id, req, confirmed)
  assert.equal(discussions.askRemote(row.id, req, confirmed).remoteTurns.length, 1)
  const tasks = readdirSync(join(f.remote.dir, 'outbox')).map(n => JSON.parse(readFileSync(join(f.remote.dir, 'outbox', n), 'utf8')))
  const task = tasks.find(t => t.kind === 'discussion')
  assert.equal(task.ticketId, id); assert.match(task.prompt, new RegExp(originalAssignment.id)); assert.match(task.prompt, /请说明原评测采样数/)
  assert.doesNotMatch(task.prompt, /PRIVATE_|原角色|ops\/discussions|原回传结论/)
  const workstation = join(f.root, 'workstation'); mkdirSync(join(workstation, id), { recursive: true }); writeFileSync(join(workstation, id, 'TASK.md'), 'ORIGINAL_TASK')
  let execution = 0, payload
  await runOnce({
    root: workstation,
    pull: async () => task,
    execute: async (_task, cwd) => {
      execution++
      assert.equal(readFileSync(join(cwd, 'TASK.md'), 'utf8'), 'ORIGINAL_TASK')
      return { status: 'ready', summary: '原评测采样 1000 次，限制是仅单机；证据位置 local/eval.md。',
        outputs: ['UNAPPROVED_TEST_PATH'], document: 'UNAPPROVED_TEST_CONTENT' }
    },
    push: async (aid, report) => {
      payload = report
      writeFileSync(join(f.remote.dir, 'inbox', `${aid}.json`), JSON.stringify({ ticketId: id, assignmentId: aid, report }))
    },
  })
  await f.remote.drain(r => discussions.remoteReport(r.ticketId, r.assignmentId, r.report), () => {})
  assert.equal(existsSync(join(f.remote.dir, 'inbox', `${task.assignmentId}.json`)), true)
  assert.equal(discussions.get(row.id).remoteTurns[0].state, 'verifying')
  assert.doesNotMatch(JSON.stringify(discussions.get(row.id)), /UNAPPROVED_TEST_/)
  discussions.dispose(); verifyReady = true
  const restored = new Discussions(f.engine, f.brain, f.executors, f.remote); t.after(() => restored.dispose())
  await f.remote.drain(r => restored.remoteReport(r.ticketId, r.assignmentId, r.report), () => {})
  assert.equal(restored.get(row.id).messages.at(-1).role, 'author'); assert.equal(restored.get(row.id).messages.at(-1).via, 'remote')
  assert.equal(await restored.remoteReport(id, task.assignmentId, payload), true)
  assert.equal(restored.get(row.id).messages.filter(m => m.id === `${req}:answer`).length, 1); assert.equal(execution, 1)
  assert.equal(f.engine.views().length, 1); assert.equal(f.store.ticket(id).ended.outcome, 'done'); assert.equal(f.store.ticket(id).assignments.length, 1)
})

test('登记时记录交付摘要，后来改写/换链不能沿用旧作者身份；轻量投影不泄出正文与角色卡', async t => {
  const { snapshotOutputs } = await import('../src/dsh/deliveries.ts')
  const { discussionView, documentView } = await import('../src/dsh/discussions.ts')
  const f = fixture(t, (r, _engine, brain) => {
    if (r.staff.id === 'strategist') { writeFileSync(join(brain.workdir(r.binding.ticketId), 'report.md'), '注册的原文版本'); return result({ status: 'ready', summary: '结论摘要', outputs: [`work/${r.binding.ticketId}/report.md`] }) }
    return result({ verdict: 'pass', critique: '通过' })
  })
  f.brain.snapshotOutputs = (id, outputs) => snapshotOutputs(f.root, id, outputs)
  const id = await parent(f); await settle()
  const d = deliveryDocument(f.engine, f.brain, id, `work/${id}/report.md`)
  const projected = documentView(d); assert.equal(Object.hasOwn(projected, 'content'), false); assert.equal(Object.hasOwn(projected.author, 'brief'), false)
  assert.equal(Object.hasOwn(discussionView({ id: randomUUID(), document: d, quote: '注册', createdAt: '', messages: [] }).document, 'content'), false)
  writeFileSync(join(f.root, d.path), '被其他进程改写的版本')
  assert.throws(() => deliveryDocument(f.engine, f.brain, id, d.path), /当前版本的作者/)
})

test('旧证据按已登记版本打开真实存档，当前文件变化或删除仍不冒充旧正文', async t => {
  const { snapshotOutputs } = await import('../src/dsh/deliveries.ts')
  const f = fixture(t, (r, _engine, brain) => {
    if (r.staff.id === 'strategist') { writeFileSync(join(brain.workdir(r.binding.ticketId), 'report.md'), '# 原交付\n\n旧版本的证据。'); return result({ status: 'ready', summary: '旧版本摘要', outputs: [`work/${r.binding.ticketId}/report.md`] }) }
    if (r.label.startsWith('讨论')) return { text: '回答旧版本的问题', stopReason: 'completed' }
    return result({ verdict: 'pass', critique: '通过' })
  })
  f.brain.snapshotOutputs = (id, outputs) => snapshotOutputs(f.root, id, outputs)
  const id = await parent(f); await settle()
  const original = deliveryDocument(f.engine, f.brain, id, `work/${id}/report.md`)
  writeFileSync(join(f.root, original.path), '当前已改成新版正文')
  assert.equal(deliveryDocument(f.engine, f.brain, id, original.path, original.version).content, original.content)
  rmSync(join(f.root, original.path))
  assert.equal(deliveryDocument(f.engine, f.brain, id, original.path, original.version).summary, '旧版本摘要')
  const discussions = new Discussions(f.engine, f.brain, f.executors); t.after(() => discussions.dispose())
  const row = discussions.create({ ticketId: id, path: original.path, version: original.version, quote: '旧版本的证据。', text: '关于旧版提问', requestId: randomUUID() }); await settle()
  assert.equal(discussions.get(row.id).document.version, original.version)
})

test('bridge 领取响应丢失后按持久领取标识重放，其他领取者不能执行同一任务', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chief-pull-recovery-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const queue = new FileRemoteQueue(root), task = { ticketId: 'T-0001', assignmentId: randomUUID(), title: '任务', prompt: '最小任务' }
  queue.dispatch(task)
  const claim = randomUUID(), env = { CHIEF_BRAIN: root }
  const command = [resolve('bin/cli.mjs'), 'bridge', 'pull', claim]
  // The first response is deliberately discarded, as when SSH disconnects after hub claim.
  const first = await subprocess(command, env); assert.equal(first.code, 0)
  const replay = await subprocess(command, env); assert.equal(replay.code, 0)
  assert.equal(JSON.parse(replay.out).assignmentId, task.assignmentId)
  const other = await subprocess([resolve('bin/cli.mjs'), 'bridge', 'pull', randomUUID()], env)
  assert.equal(other.code, 0); assert.deepEqual(JSON.parse(other.out), {})
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => subprocess(command, env)))
  assert.ok(concurrent.every(r => r.code === 0 && JSON.parse(r.out).assignmentId === task.assignmentId))
  queue.cancel(task.assignmentId)
  const cancelled = await subprocess(command, env); assert.equal(cancelled.code, 0); assert.deepEqual(JSON.parse(cancelled.out), {})
  assert.equal(queue.counts().taken, 0)
})

test('runner 领取断线保留同一标识，实际 bridge 重放后只执行一次；同目录双进程被拒绝', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chief-runner-claim-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const queue = new FileRemoteQueue(root), task = { ticketId: 'T-0001', assignmentId: randomUUID(), title: '任务', prompt: '最小任务' }; queue.dispatch(task)
  const workstation = join(root, 'workstation'), claims = []; let disconnected = true, executions = 0
  const transport = { root: workstation, pull: async claim => {
    claims.push(claim)
    const r = await subprocess([resolve('bin/cli.mjs'), 'bridge', 'pull', claim], { CHIEF_BRAIN: root }); assert.equal(r.code, 0)
    if (disconnected) throw new Error('lost SSH response')
    return JSON.parse(r.out)
  }, push: async (id, report) => { const r = await subprocess([resolve('bin/cli.mjs'), 'bridge', 'push', id], { CHIEF_BRAIN: root }, JSON.stringify(report)); assert.equal(r.code, 0) }, execute: async () => { executions++; return { status: 'ready', summary: '完成' } } }
  await assert.rejects(runOnce(transport), /lost SSH response/)
  disconnected = false; await runOnce(transport)
  assert.equal(claims.length, 2); assert.equal(claims[0], claims[1]); assert.equal(executions, 1)
  assert.equal(JSON.parse(readFileSync(join(workstation, '.chief-runner', `${task.assignmentId}.json`))).state, 'sent')
  let release
  const blocked = runOnce({ ...transport, pull: async () => new Promise(r => { release = () => r({}) }) })
  await assert.rejects(runOnce(transport), /已有 runner 在运行/)
  release(); await blocked
})

test('并发首次领取同一标识只绑定一个任务，竞争标识不会重复领到它，保留先入队顺序', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chief-pull-race-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const queue = new FileRemoteQueue(root), ids = ['zzzzzzzz-oldest', 'aaaaaaaa-newest']
  ids.forEach((id, i) => { queue.dispatch({ ticketId: `T-000${i + 1}`, assignmentId: id, title: '任务', prompt: '最小任务' }); utimesSync(join(queue.dir, 'outbox', `${id}.json`), i + 1, i + 1) })
  const claim = randomUUID(), command = [resolve('bin/cli.mjs'), 'bridge', 'pull', claim], env = { CHIEF_BRAIN: root }
  const first = await Promise.all(Array.from({ length: 5 }, () => subprocess(command, env)))
  assert.ok(first.every(r => r.code === 0 && JSON.parse(r.out).assignmentId === ids[0]))
  const competing = await Promise.all(Array.from({ length: 5 }, () => subprocess([resolve('bin/cli.mjs'), 'bridge', 'pull', randomUUID()], env)))
  assert.ok(competing.every(r => r.code === 0))
  assert.deepEqual(competing.map(r => JSON.parse(r.out).assignmentId).filter(Boolean), [ids[1]])
  assert.deepEqual(queue.counts(), { waiting: 0, taken: 2 })
})

test('真实 runner 入口仅在明确旧协议拒绝时回退；网络错误与空白/截断响应保留原领取标识', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chief-runner-protocol-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin'); mkdirSync(bin)
  const ssh = join(bin, 'ssh'); writeFileSync(ssh, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(5)
appendFileSync(process.env.CHIEF_TEST_CALLS, JSON.stringify(args) + '\\n')
if (process.env.CHIEF_TEST_MODE === 'legacy' && args.length === 2) { process.stderr.write('dsh-chief: 只允许 pull 或 push <id>\\n'); process.exit(2) }
if (process.env.CHIEF_TEST_MODE === 'network') { process.stderr.write('Connection reset\\n'); process.exit(255) }
if (process.env.CHIEF_TEST_MODE === 'empty') process.exit(0)
if (process.env.CHIEF_TEST_MODE === 'truncated') { process.stdout.write('{"assignmentId":'); process.exit(0) }
process.stdout.write('{}\\n')
`); chmodSync(ssh, 0o755)
  for (const mode of ['legacy', 'network', 'empty', 'truncated']) {
    const work = join(root, mode), calls = join(root, `${mode}-calls`), env = { PATH: `${bin}:${process.env.PATH}`, CHIEF_WORKDIR: work, CHIEF_TEST_MODE: mode, CHIEF_TEST_CALLS: calls }
    const first = await subprocess([resolve('bin/runner.mjs')], env)
    const readCalls = () => readFileSync(calls, 'utf8').trim().split('\n').map(row => JSON.parse(row))
    if (mode === 'legacy') { assert.equal(first.code, 0); assert.equal(readCalls().length, 2); assert.equal(readCalls()[0].length, 2); assert.deepEqual(readCalls()[1], ['pull']); continue }
    assert.equal(first.code, 1); assert.equal(readCalls().length, 1); assert.equal(existsSync(join(work, '.chief-runner', 'pull')), true)
    assert.equal((await subprocess([resolve('bin/runner.mjs')], env)).code, 1)
    assert.deepEqual(readCalls()[0], readCalls()[1]); assert.equal(readCalls()[0].length, 2)
  }
})

test('远端派工保存后、发布前崩溃，仅重放本机暂存的原始任务且不包含后来私人输入', async t => {
  const f = fixture(t)
  const dispatch = f.remote.dispatch.bind(f.remote)
  f.remote.dispatch = () => { throw new Error('crash before queue publication') }
  const id = await f.engine.commission({ title: '原始任务', text: '评测', staff: 'external', level: 'think', scope: '原始范围', doneWhen: ['回传结论'], needsReview: false }); await settle()
  const assignment = f.store.ticket(id).assignments[0]
  await f.engine.reply(id, 'PRIVATE_INPUT_AFTER_DISPATCH')
  f.engine.stop(); f.remote.dispatch = dispatch
  const restoredStore = new FileStore(f.root), restored = new Engine(restoredStore, f.brain, f.executors, f.remote, { concurrency: 3, timeZone: 'UTC' }); t.after(() => restored.stop())
  await restored.recover(); await settle()
  const task = JSON.parse(readFileSync(join(f.remote.dir, 'outbox', `${assignment.id}.json`), 'utf8'))
  assert.equal(task.assignmentId, assignment.id); assert.match(task.prompt, /原始范围/); assert.doesNotMatch(task.prompt, /PRIVATE_INPUT_AFTER_DISPATCH/)
  assert.equal(restoredStore.ticket(id).assignments.length, 1)
  // An existing taken record is never republished, including on repeated recovery.
  const pulled = await subprocess([resolve('bin/cli.mjs'), 'bridge', 'pull'], { CHIEF_BRAIN: f.root }); assert.equal(pulled.code, 0)
  await restored.recover(); assert.equal(readdirSync(join(f.remote.dir, 'outbox')).length, 0)
})

test('暂存失败不消耗主人输入；工单未保存的孤立暂存与旧工单都不会自行变成远端任务', async t => {
  const f = fixture(t); f.engine.setPaused(true)
  const prepare = f.remote.prepare.bind(f.remote)
  f.remote.prepare = () => { throw new Error('temporary staging failure') }
  const id = await f.engine.commission({ title: '待派工', text: '评测', staff: 'external', level: 'think', scope: '评测', doneWhen: ['回传结论'], needsReview: false })
  await f.engine.reply(id, '尚未派出的主人补充'); f.engine.setPaused(false); await settle()
  assert.equal(f.store.ticket(id).assignments.length, 0); assert.equal(f.store.ticket(id).inputs[0].consumedBy, undefined)
  // A staged payload written before a missing ticket save never enters outbox.
  prepare({ ticketId: id, assignmentId: randomUUID(), title: '孤立任务', prompt: '不得执行' })
  f.engine.stop()
  const restoredStore = new FileStore(f.root), restored = new Engine(restoredStore, f.brain, f.executors, f.remote, { concurrency: 3, timeZone: 'UTC' }); t.after(() => restored.stop())
  restored.setPaused(true); await restored.recover()
  assert.equal(readdirSync(join(f.remote.dir, 'outbox')).length, 0)
  // A legacy assignment without a machine-local staged payload is not reconstructed.
  f.remote.prepare = undefined; f.remote.dispatch = () => { throw new Error('legacy publication missing') }
  restored.setPaused(false); await settle(); restored.stop()
  const legacy = new Engine(new FileStore(f.root), f.brain, f.executors, new FileRemoteQueue(f.root), { concurrency: 3, timeZone: 'UTC' }); t.after(() => legacy.stop())
  await legacy.recover(); await settle()
  assert.equal(legacy.views()[0].stage, 'remote'); assert.equal(readdirSync(join(f.remote.dir, 'outbox')).length, 0)
})

test('子任务核验通过已落盘、自动结单前崩溃，重启补结单并只唤醒父任务一次', async t => {
  let runs = 0, childId
  const f = fixture(t, async (r, engine) => {
    if (r.staff.id === 'strategist') {
      runs++
      if (runs === 1) { childId = await engine.delegate(r.binding, { key: 'evaluate', staff: 'external', text: '评测', criterion: 0 }); return result({ status: 'question', summary: '等待', question: '等待评测' }) }
      return result({ status: 'ready', summary: '整合已核验结论' })
    }
    return result({ verdict: 'pass', critique: '核验通过' })
  })
  const id = await parent(f); await settle()
  const save = f.store.saveTicket.bind(f.store)
  let crashed = false
  f.store.saveTicket = ticket => {
    save(ticket)
    if (!crashed && ticket.id === childId && ticket.assignments.at(-1)?.verification?.verdict === 'pass' && !ticket.ended) {
      crashed = true; f.engine.stop(); throw new Error('crash after durable verification')
    }
  }
  const child = f.store.ticket(childId), assignment = child.assignments[0]
  await f.engine.remoteReport(childId, assignment.id, { status: 'ready', summary: '完成且有证据' }); await settle()
  assert.equal(crashed, true)
  const store = new FileStore(f.root), restored = new Engine(store, f.brain, f.executors, f.remote, { concurrency: 3, timeZone: 'UTC' }); t.after(() => restored.stop())
  await restored.recover(); await settle()
  assert.equal(store.ticket(childId).ended?.outcome, 'done'); assert.equal(runs, 2)
  assert.equal(store.ticket(id).inputs.filter(i => i.key === `child:${childId}`).length, 1)
  await restored.recover(); await settle(); assert.equal(runs, 2)
})

test('横向线交办先规范负责人再校验，接口和引擎均拒绝把私人父任务直接交到工作端', async t => {
  const f = fixture(t); f.roster.upsertLine('评测线', { goal: '评测' })
  const route = runtimeRoutes({ ...f, worklines: new Worklines(f.engine, f.brain, f.roster) })
  await assert.rejects(route({ method: 'POST', path: '/lines/评测线/commission', seg: ['lines', '评测线', 'commission'], body: { staff: ' external ', text: 'PRIVATE_PARENT' } }, {}), /本地负责人/)
  await assert.rejects(f.engine.commission({ title: '私人背景', text: 'PRIVATE_PARENT', staff: ' external ', level: 'think', scope: 'PRIVATE_PARENT', doneWhen: ['结论'], needsReview: true, lineId: '评测线' }), /本地负责人/)
  await assert.rejects(f.engine.commission({ title: '讨论跟进', text: 'PRIVATE_QUOTE', staff: 'external', level: 'think', scope: 'PRIVATE_QUOTE', doneWhen: ['结论'], needsReview: true, related: { ticketId: 'T-0000', discussionId: randomUUID(), path: 'work/T-0000/a.md', version: 'v' } }), /本地负责人/)
  assert.equal(f.engine.views().length, 0); assert.deepEqual(f.remote.counts(), { waiting: 0, taken: 0 })
})

test('新旧横向线本地负责人改成工作端时持久显示受阻，不自动重派，改回本地后可重试', async t => {
  for (const legacy of [false, true]) {
    const f = fixture(t, r => r.staff.id === 'strategist' ? result({ status: 'ready', summary: '本地结论' }) : result({ verdict: 'pass', critique: '通过' }))
    f.engine.setPaused(true); const id = await parent(f, 'PRIVATE_PARENT')
    await f.engine.reply(id, 'PRIVATE_LATE_INPUT')
    if (legacy) { delete f.store.ticket(id).executionBoundary; f.store.saveTicket(f.store.ticket(id)) }
    f.staff.find(s => s.id === 'strategist').executor = 'remote'
    f.engine.setPaused(false); await settle()
    const ticket = f.store.ticket(id)
    assert.equal(f.engine.views()[0].stage, 'you/blocked'); assert.match(ticket.assignments[0].report.summary, /本地执行后重试/)
    assert.equal(ticket.inputs.every(i => i.consumedBy), true); assert.equal(readdirSync(join(f.remote.dir, 'staged')).length, 0)
    f.engine.kick(); await settle(); assert.equal(ticket.assignments.length, 1)
    assert.deepEqual(f.remote.counts(), { waiting: 0, taken: 0 }); assert.equal(f.calls.length, 0)
    f.staff.find(s => s.id === 'strategist').executor = 'dsh'; await f.engine.retry(id); await settle()
    assert.equal(f.engine.views()[0].stage, 'you/review'); assert.equal(ticket.assignments.length, 2)
  }
})

test('原本本地的委派改工作端不能发送模型私文；明确远端子任务重试仍使用主人说明', async t => {
  let localChild
  const f = fixture(t, async (r, engine) => {
    if (r.staff.id === 'strategist') { localChild = await engine.delegate(r.binding, { key: 'local-read', staff: 'researcher', text: 'PRIVATE_MODEL_CHILD', criterion: 0 }); engine.setPaused(true); return result({ status: 'question', summary: '等待', question: '等子任务' }) }
    return result({ verdict: 'pass', critique: '通过' })
  })
  await parent(f); await settle()
  assert.equal(f.store.ticket(localChild).executionBoundary, 'local')
  f.staff.find(s => s.id === 'researcher').executor = 'remote'; f.engine.setPaused(false); await settle()
  assert.equal(f.engine.views().find(v => v.ticket.id === localChild).stage, 'you/blocked'); assert.deepEqual(f.remote.counts(), { waiting: 0, taken: 0 })
  let remoteChild
  const g = fixture(t, async (r, engine) => {
    if (r.staff.id === 'strategist') { remoteChild = await engine.delegate(r.binding, { key: 'remote-read', staff: 'external', text: 'PRIVATE_MODEL_TEXT', criterion: 0 }); return result({ status: 'question', summary: '等待', question: '等子任务' }) }
    return result({ verdict: 'pass', critique: '通过' })
  })
  await parent(g); await settle()
  const child = g.store.ticket(remoteChild), first = child.assignments[0]
  assert.equal(child.executionBoundary, 'remote')
  await g.engine.remoteReport(child.id, first.id, { status: 'failed', summary: '暂时失败' }); await g.engine.retry(child.id); await settle()
  assert.equal(child.assignments.length, 2); assert.equal(g.engine.views().find(v => v.ticket.id === child.id).stage, 'remote')
  const outgoing = readdirSync(join(g.remote.dir, 'outbox')).map(name => readFileSync(join(g.remote.dir, 'outbox', name), 'utf8'))
  assert.equal(outgoing.length, 2); assert.ok(outgoing.every(raw => raw.includes('在工作电脑评测两个方案') && !raw.includes('PRIVATE_MODEL')))
  // Legacy pending remote work remains valid when its event, original remote assignment,
  // remote-only criterion and owner-approved brief establish the same provenance.
  delete child.executionBoundary; g.store.saveTicket(child); await g.engine.recover(); await settle()
  assert.equal(g.engine.views().find(v => v.ticket.id === child.id).stage, 'remote')
})

test('无横向线的旧版原作者讨论跟进在重启后仍限本地，不因作者配置改变而外发引用', async t => {
  const f = fixture(t, (r, _engine, brain) => {
    if (r.label.startsWith('讨论')) return { text: '阅读回答', stopReason: 'completed' }
    if (r.staff.id === 'strategist') { writeFileSync(join(brain.workdir(r.binding.ticketId), 'report.md'), 'PRIVATE_DELIVERY_QUOTE'); return result({ status: 'ready', summary: '原交付', outputs: [`work/${r.binding.ticketId}/report.md`] }) }
    return result({ verdict: 'pass', critique: '通过' })
  })
  const source = await f.engine.commission({ title: '本地原交付', text: '原任务', staff: 'strategist', level: 'think', scope: '原范围', doneWhen: ['结论'], needsReview: true }); await settle(); await f.engine.accept(source)
  const discussions = new Discussions(f.engine, f.brain, f.executors); t.after(() => discussions.dispose())
  const doc = deliveryDocument(f.engine, f.brain, source, `work/${source}/report.md`)
  const row = discussions.create({ ticketId: source, path: doc.path, version: doc.version, quote: 'PRIVATE_DELIVERY_QUOTE', requestId: randomUUID(), text: '阅读问题' }); await settle()
  f.engine.setPaused(true); const id = await discussions.followUp(row.id, 'PRIVATE_FOLLOWUP')
  delete f.store.ticket(id).executionBoundary; f.store.saveTicket(f.store.ticket(id)); f.engine.stop()
  f.staff.find(s => s.id === 'strategist').executor = 'remote'
  const restored = new Engine(new FileStore(f.root), f.brain, f.executors, f.remote, { concurrency: 3, timeZone: 'UTC' }); t.after(() => restored.stop())
  await restored.recover(); await settle()
  assert.equal(restored.views().find(v => v.ticket.id === id).stage, 'you/blocked'); assert.deepEqual(f.remote.counts(), { waiting: 0, taken: 0 })
  assert.equal(restored.views().find(v => v.ticket.id === source).stage, 'ended')
})

test('工单分组续跑跨重启保留已核验的分组，只重试失败分组', async t => {
  let runs = []
  const f = fixture(t, async r => {
    if (r.label.startsWith('审查')) return result({ verdict: 'pass', critique: '夹具核验通过' })
    runs.push(r.label)
    return result(r.label.includes('第二组') ? { status: 'failed', summary: '隔离夹具中断' } : { status: 'ready', summary: '隔离夹具完成' })
  })
  f.staff.find(s => s.id === 'strategist').executor = 'codex'
  const id = await parent(f)
  await settle()
  // Start from a reported incomplete attempt, as with a real executor interruption.
  const original = f.store.ticket(id)
  original.assignments.at(-1).report = { status: 'failed', summary: '原派工中断', structured: true }
  f.store.saveTicket(original)
  const target = { threadId: original.threadId, replyTo: original.assignments.at(-1).id, stage: 'you/blocked' }
  const second = { key: 'b', title: '第二组', scope: '只补第二组' }
  await f.engine.planExecution(id, [{ key: 'a', title: '第一组', scope: '验证已完成组保留' }, second], '已核对原工单的第一批证据', target)
  await settle()
  const groups = f.store.tickets().filter(ticket => ticket.parent?.ticketId === id)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].ended.outcome, 'done')
  assert.equal(groups[1].assignments.at(-1).report.status, 'failed')
  assert.equal(f.engine.views().find(v => v.ticket.id === id).stage, 'waiting')
  assert.equal(runs.length, 3)
  f.engine.stop()
  const store = new FileStore(f.root)
  const engine = new Engine(store, f.brain, { ...f.executors, async run(r) {
    if (r.label.startsWith('审查')) return result({ verdict: 'pass', critique: '隔离核验通过' })
    runs.push(r.label)
    if (r.binding.ticketId === id) {
      assert.match(r.prompt, /仅汇总已核验的分组产物/)
      assert.match(r.prompt, /第一批证据/)
    }
    return result({ status: 'ready', summary: '恢复后完成' })
  } }, f.remote, { concurrency: 2, timeZone: 'UTC' })
  t.after(() => engine.stop())
  await engine.recover(); await settle()
  assert.equal(runs.length, 3)
  await engine.retry(groups[1].id); await settle()
  assert.equal(runs.length, 5)
  assert.match(runs[3], /第二组/)
  assert.match(runs[4], new RegExp(id))
  assert.equal(store.tickets().filter(ticket => ticket.parent?.ticketId === id).length, 2)
  assert.equal(engine.views().find(v => v.ticket.id === id).stage, 'you/review')
})
