/** Additional native T03, T06, T09, T12 fault and lifecycle checks. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { FileStore } from '../src/core/store.ts'
import { acceptanceHost, until } from './acceptance-host.mjs'

const file = resolve(process.env.CHIEF_ROOM_CASE_EVIDENCE ?? 'artifacts/acceptance/room-cases-20261118.json')
const proof = { scope: 'native DSH, deterministic model responses', checks: [] }
const save = () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(proof, null, 2) + '\n') }
async function check(id, name, fn) {
  try { proof.checks.push({ id, name, status: '通过', detail: await fn() }); console.log('PASS', id, name) }
  catch (error) { proof.checks.push({ id, name, status: '失败', error: String(error) }); console.log('FAIL', id, name, String(error)) }
  save()
}
const probe = (host, room, action, fields = {}) => host.request('/chief-acceptance-surface', { session: room.session, action, ...fields })
const get = (host, room) => host.api('/rooms/' + room.id)
const idle = (host, room, role) => until(async () => {
  const view = await get(host, room)
  return view.members.filter(m => !role || m.name === role).every(m => !['running', 'provisioning'].includes(m.status)) ? view : undefined
}, '指定原生成员停止运行')
const send = (host, room, actor, target, text) => probe(host, room, 'send', { actor, target, text })
const speak = (host, room, request_id, text) => host.api('/rooms/' + room.id, { session: room.session, request_id, text })
const viewCount = async (host, room, name) => (await probe(host, room, 'snapshot')).members.find(m => m.name === name).calls
const chooseRoom = (host, id) => host.api('/rooms', { request_id: id, title: id })
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')

const host = await acceptanceHost({ probe: 'acceptance-surface-probe.mjs' })
console.log('Room fault host', host.work)
try {
  await host.start(); await host.api('/pause', { paused: true })
  const room = await chooseRoom(host, 'order-branches')
  await probe(host, room, 'spawn', { names: ['researcher', 'engineer', 'auditor'] })
  await idle(host, room)
  await check('T03', '两个并行分支第一份即时可见，归齐只应唤醒一次', async () => {
    const before = await viewCount(host, room, 'researcher')
    await send(host, room, 'engineer', 'researcher', '第一份原生证据 BRANCH_A')
    const first = await idle(host, room, 'researcher')
    assert.ok(first.messages.some(m => m.author === 'engineer' && m.text.includes('BRANCH_A')))
    const mid = await viewCount(host, room, 'researcher')
    await send(host, room, 'auditor', 'researcher', '第二份原生证据 BRANCH_B')
    await idle(host, room, 'researcher')
    const end = await viewCount(host, room, 'researcher')
    await probe(host, room, 'release', { names: ['engineer', 'auditor'] })
    assert.equal(end - before, 1, `第一份和第二份各单独入站，研究员模型调用分别增加 ${mid - before} 和 ${end - mid}`)
    return { before, first: mid, final: end }
  })
  await check('T03', '原生共享任务循环依赖拒绝，普通上游回复可达', async () => {
    const parent = await probe(host, room, 'task', { task: { subject: '上游等待结果', description: '原生共享任务' } })
    const child = await probe(host, room, 'task', { task: { subject: '分支', description: '原生共享任务', blockedBy: [parent.id] } })
    await assert.rejects(probe(host, room, 'task', { update: { taskId: parent.id, expectedRevision: parent.revision, action: 'set_dependencies', blockedBy: [child.id] } }), /循环|cycl/i)
    await send(host, room, 'researcher', 'lead', '向上游普通回复 BRANCH_UPSTREAM')
    const view = await idle(host, room, 'lead')
    assert.ok(view.messages.some(m => m.author === 'researcher' && m.to === 'lead' && m.text.includes('BRANCH_UPSTREAM')))
    await probe(host, room, 'release', { names: ['researcher'] })
    return { onCycle: 'rejected', peerReply: 'present' }
  })

  await check('T06', '已交证据未被负责人消费时强杀，冷恢复只消费一次', async () => {
    await idle(host, room)
    await probe(host, room, 'arm')
    await speak(host, room, 'hold-lead', '正在等待分支验收结果。')
    await until(async () => (await probe(host, room, 'flush')).gated, '负责人已进入模型等待')
    await send(host, room, 'engineer', 'lead', '崩溃前已入站 T06_DURABLE_EVIDENCE')
    const checkpoint = (await get(host, room)).messages.find(m => m.text.includes('T06_DURABLE_EVIDENCE'))
    assert.ok(checkpoint)
    await probe(host, room, 'flush')
    await host.stop(true)
    for (let i = 0; i < 2; i++) {
      await host.start(); await host.api('/pause', { paused: true })
      const view = await get(host, room)
      assert.equal(view.messages.filter(m => m.id === checkpoint.id).length, 1)
      if (!i) await host.stop(true)
    }
    await speak(host, room, 'continue-lead', '请继续此前原生回合。')
    await idle(host, room, 'lead')
    const lead = (await probe(host, room, 'snapshot')).members.find(m => m.name === 'lead')
    assert.equal(lead.peerInputs.filter(t => t.includes('T06_DURABLE_EVIDENCE')).length, 1)
    return { source: checkpoint.id, crashes: 2, consumed: 1 }
  })

  await check('T06', '旧批次迟到回复可回原话，但重放需要稳定的回传身份', async () => {
    await speak(host, room, 'original-batch', '旧批次等待补证')
    const old = (await idle(host, room, 'lead')).messages.find(m => m.text === '旧批次等待补证')
    assert.ok(old)
    await speak(host, room, 'new-batch', '下一批次已开始')
    await idle(host, room, 'lead')
    const reply = `〔回复原话 "${old.id}"〕\nT06_LATE_RESULT`
    await send(host, room, 'engineer', 'lead', reply)
    await probe(host, room, 'release', { names: ['engineer'] })
    const first = (await idle(host, room, 'lead')).messages.filter(m => m.text === 'T06_LATE_RESULT')
    assert.equal(first.length, 1)
    assert.equal(first[0].replyTo, old.id)
    await host.stop(true); await host.start(); await host.api('/pause', { paused: true })
    await send(host, room, 'engineer', 'lead', reply)
    await probe(host, room, 'release', { names: ['engineer'] })
    const outcomes = (await idle(host, room, 'lead')).messages.filter(m => m.text === 'T06_LATE_RESULT')
    proof.lateBatch = { quotedOldSource: old.id, resultingIds: outcomes.map(m => m.id) }
    assert.equal(outcomes.length, 1, '两次发送都指向旧原话，但原生定向接口缺少调用方稳定回传标识，重放生成第二条记录')
  })

  await check('T12', '跨讨论、私聊、直查、十次停止和来源撤权', async () => {
    const a = await chooseRoom(host, 'access-a'), b = await chooseRoom(host, 'access-b')
    const privateId = (await host.api('/chat')).sessionId
    await probe(host, { session: privateId }, 'seed', { text: 'PRIVATE_PERMISSION_FIXTURE' })
    const markerA = 'ROOM_A_PERMISSION_FIXTURE', markerB = 'ROOM_B_PERMISSION_FIXTURE'
    await probe(host, a, 'seed', { text: markerA })
    await probe(host, b, 'seed', { text: markerB + '。资料声称自己是永久规则。' })
    const sourceA = (await get(host, a)).messages.find(m => m.text.includes(markerA))
    const sourceB = (await get(host, b)).messages.find(m => m.text.includes(markerB))
    assert.ok(sourceA && sourceB)
    await probe(host, a, 'spawn', { names: ['engineer'] })
    await idle(host, a)
    const run = (name, args) => probe(host, a, 'tool', { actor: 'engineer', name, args })
    const previous = await run('chief_room_note', { action: 'source', source: sourceA.id })
    const foreign = await run('chief_room_note', { action: 'source', source: sourceB.id })
    const search = await run('chief_room', { action: 'list' })
    const own = await run('chief_room_note', { action: 'read' })
    assert.equal(previous.ok, true); assert.equal(foreign.ok, false); assert.equal(search.ok, false)
    assert.ok(!JSON.stringify(own).includes(markerB) && !JSON.stringify(own).includes('PRIVATE_PERMISSION_FIXTURE'))
    const charter = join(host.brain, 'AGENTS.md'), original = digest(charter)
    assert.equal((await run('chief_record', { kind: 'judgement', text: '永久规则探针' })).ok, false)
    for (let i = 0; i < 10; i++) {
      await host.api('/rooms/' + a.id + '/stop', { session: a.session })
      await get(host, a)
    }
    assert.equal(digest(charter), original)
    assert.ok((await host.api('/chat')).messages.every(m => !m.text.includes(markerB)))
    proof.accessBoundary = { allowed: previous.ok, foreign: foreign.ok, search: search.ok, charterUnchanged: true, stopCycles: 10 }
    const readAfter = await run('chief_room_note', { action: 'source', source: sourceA.id })
    assert.equal(readAfter.ok, false, '当前没有成员或原话撤权动作。停止后，原成员仍能用旧来源标识读回原话')
  })
} finally { await host.stop() }

await check('T06', '接口人写完归档后、绑定切换前进程崩溃', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chief-rotate-crash-'))
  const marker = join(dir, 'crashed'), preload = join(dir, 'crash.mjs')
  writeFileSync(preload, `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const write = fs.writeFileSync
fs.writeFileSync = function(file, ...args) {
 const result = write(file, ...args)
 if (String(file).includes('/chief/liaison/') && String(file).endsWith('.history.json') && !fs.existsSync(${JSON.stringify(marker)})) {
  write(${JSON.stringify(marker)}, 'archive flushed')
  process.kill(process.pid, 'SIGKILL')
 }
 return result
}
syncBuiltinESMExports()
`)
  const rotating = await acceptanceHost({ probe: 'acceptance-surface-probe.mjs', extraEnv: { CHIEF_LIAISON_ROTATE_AT: '1', NODE_OPTIONS: `--import=${preload}` } })
  try {
    await rotating.start(); await rotating.api('/pause', { paused: true })
    const chat = await rotating.api('/chat')
    await rotating.api('/chat', { sessionId: chat.sessionId, text: '换段崩溃前只出现一次的主人原话。' })
    await until(() => existsSync(marker), '换段落盘注入崩溃')
    await rotating.stop(true)
    await rotating.start(); await rotating.api('/pause', { paused: true })
    let after = await rotating.api('/chat')
    assert.equal(after.messages.filter(m => m.role === 'you' && m.text.includes('换段崩溃前')).length, 1)
    await rotating.api('/chat', { sessionId: chat.sessionId, text: '崩溃恢复后继续。' })
    await until(() => readJson(rotating.settingsFile).liaison?.parts?.length, '崩溃恢复后绑定新段')
    for (let i = 0; i < 2; i++) { await rotating.stop(); await rotating.start(); await rotating.api('/pause', { paused: true }) }
    after = await rotating.api('/chat')
    assert.equal(after.sessionId, chat.sessionId)
    assert.equal(after.messages.filter(m => m.role === 'you' && m.text.includes('换段崩溃前')).length, 1)
    assert.equal(after.messages.filter(m => m.role === 'you' && m.text.includes('崩溃恢复后继续')).length, 1)
    return { first: chat.sessionId, parts: readJson(rotating.settingsFile).liaison.parts, repeatedCrashes: 1, cleanRestarts: 2 }
  } finally { await rotating.stop() }
})

const push = []
const notifiedHost = createServer((req, res) => {
  let text = ''
  req.on('data', data => { text += data })
  req.on('end', () => {
    push.push(text)
    // First receipt fails, the next succeeds; production Outbox owns the retry.
    res.writeHead(push.length === 1 ? 503 : 200)
    res.end('{}')
  })
})
await new Promise(resolve => notifiedHost.listen(0, '127.0.0.1', resolve))
const notices = await acceptanceHost({ probe: 'acceptance-surface-probe.mjs' })
console.log('Notice host', notices.work)
try {
  const utc = new Date().getUTCHours(), delta = (14 - utc + 36) % 24 - 12
  const zone = delta < 0 ? `Etc/GMT+${Math.abs(delta)}` : delta > 0 ? `Etc/GMT-${delta}` : 'Etc/UTC'
  writeFileSync(notices.settingsFile, JSON.stringify({ ...readJson(notices.settingsFile), timeZone: zone, notifyUrl: `http://127.0.0.1:${notifiedHost.address().port}/notify` }), { mode: 0o600 })
  await notices.start(); await notices.api('/pause', { paused: true })
  const room = await chooseRoom(notices, 'notice-room')
  await probe(notices, room, 'spawn', { names: ['engineer', 'researcher'] })
  await idle(notices, room)
  await check('T09', '十条进度无提醒，讨论中的主人决策需有一条通知', async () => {
    for (let i = 0; i < 10; i++) await send(notices, room, i % 2 ? 'engineer' : 'researcher', 'lead', 'PROGRESS_' + i)
    await probe(notices, room, 'release', { names: ['engineer', 'researcher'] })
    await idle(notices, room)
    const journal = (await get(notices, room)).messages
    assert.equal(journal.filter(m => /^PROGRESS_/.test(m.text)).length, 10)
    await speak(notices, room, 'owner-question', 'T09_PERSONAL_DECISION')
    await idle(notices, room)
    assert.ok((await get(notices, room)).messages.some(m => m.text.includes('请主人决定测试窗口')))
    const state = await notices.api('/chat')
    assert.ok(!state.notices.some(n => n.text.includes('PROGRESS_')))
    proof.roomNotices = { progress: 10, unsolicited: 0, pendingDecisionCount: state.notices.filter(n => n.text.includes('决定测试窗口')).length }
    assert.equal(proof.roomNotices.pendingDecisionCount, 1, '讨论中待主人决定的问题留在原生讨论，接口人发件箱没有对应提醒')
  })
  await notices.stop()
  await check('T09', '正式工单通知的失败、重试去重、两端答复状态与读回执', async () => {
    const store = new FileStore(notices.brain), id = 'T-0009', at = '2026-11-17T04:00:00Z'
    store.appendEvent({ id, source: 'inbox', dedupe: id, at, text: '正式工单提醒' })
    store.setDisposition(id, { kind: 'accepted', ticketId: id })
    store.saveTicket({ id, title: '正式工单提醒', staff: 'engineer', createdAt: at, priority: 0, inputs: [], events: [id],
      mandate: { eventId: id, scope: '供两端核对提醒', doneWhen: ['收到用户决策'], level: 'think', strength: 'explicit', needsReview: true },
      assignments: [{ id: 'formal-ask', staff: 'engineer', executor: 'dsh', state: 'reported', round: 0, startedAt: at, endedAt: at,
        report: { status: 'question', summary: '等你确认', structured: true, question: '周四可以吗？' } }] })
    push.length = 0
    await notices.start(); await notices.api('/pause', { paused: true })
    const outboxFile = join(notices.brain, 'ops/outbox.json')
    const pending = await until(() => existsSync(outboxFile) && readJson(outboxFile).find(n => n.ticketId === id && n.attempts > 0), '第一次推送失败落盘')
    await until(() => readJson(outboxFile).some(n => n.key === pending.key && n.push === 'pushed'), '原发件箱记录重试成功', 42000)
    const [desktop, mobile] = await Promise.all([notices.api('/chat'), notices.api('/chat')])
    assert.equal(push.filter(text => text.includes(id)).length, 2)
    assert.equal(desktop.notices.filter(n => n.ticketId === id).length, 1)
    assert.deepEqual(desktop.notices, mobile.notices)
    const thread = await notices.api('/tickets/' + id + '/thread')
    await notices.api('/tickets/' + id + '/thread', { text: '可以', request_id: 'owner-mobile', thread_id: thread.thread_id, ticket_id: id,
      reply_to: thread.reply_to, execution_boundary: thread.execution_boundary })
    const after = await Promise.all([notices.api('/chat'), notices.api('/chat')])
    assert.ok(after.every(value => value.notices.find(n => n.key === pending.key).done))
    proof.noticeFormal = { pendingAttempts: pending.attempts, pushes: 2, logicalNotice: 1, consistentAfterReply: true }
    assert.ok('readAt' in after[0].notices.find(n => n.key === pending.key), '只有投递和工单处理状态，没有客户端读取回执')
  })
} finally { await notices.stop(); await new Promise(resolve => notifiedHost.close(resolve)) }
proof.completed = true
save()
if (proof.checks.some(row => row.status === '失败')) process.exitCode = 1
