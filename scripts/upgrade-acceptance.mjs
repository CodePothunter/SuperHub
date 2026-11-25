/** T04/T21 with real old → current → old → current packages and isolated stored data. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileStore } from '../src/core/store.ts'
import { FileRemoteQueue } from '../src/dsh/remote.ts'
import { acceptanceHost, until } from './acceptance-host.mjs'

const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE, legacy = process.env.CHIEF_LEGACY_PACKAGE
assert.ok(candidate && legacy, '需要新旧两个候选包')
const host = await acceptanceHost({ candidate: legacy, probe: 'acceptance-surface-probe.mjs', extraEnv: { CHIEF_LIAISON_ROTATE_AT: '1' } })
console.log('Upgrade acceptance host', host.work)
const hash = data => createHash('sha256').update(data).digest('hex')
const now = '2026-11-17T04:00:00Z', title = '同名的历史工单'
const archived = '保存于旧日期的交付原文。\n'
const version = hash(archived)
const ticketId = 'T-0021', newTicket = 'T-0022', remoteId = 'T-0023', remoteAssignment = 'remote-old-fixture', path = 'work/T-0021/old.md'
const secondRemoteId = 'T-0024', secondAssignment = 'remote-scope-fixture'
const discussionId = 'c5d3a78a-f736-428c-ab7e-41be308d5423'
const dest = resolve(process.env.CHIEF_UPGRADE_EVIDENCE ?? 'artifacts/acceptance/upgrade-20261118.json')
const proof = { work: host.work, oldSha256: hash(readFileSync(legacy)), currentSha256: hash(readFileSync(candidate)), checks: [] }
const save = () => { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, JSON.stringify(proof, null, 2) + '\n') }
const snap = file => JSON.parse(readFileSync(file, 'utf8'))
async function check(id, name, fn) {
  try { proof.checks.push({ id, name, status: '通过', detail: await fn() }); console.log('PASS', id, name) }
  catch (error) { proof.checks.push({ id, name, status: '失败', error: String(error) }); console.log('FAIL', id, name, String(error)) }
  save()
}
function seed(brain) {
  const store = new FileStore(brain)
  const base = { title, createdAt: now, staff: 'engineer', priority: 0, inputs: [] }
  for (const id of [ticketId, newTicket]) {
    store.appendEvent({ id, at: now, source: 'inbox', dedupe: id, text: '旧交办事项' })
    store.setDisposition(id, { kind: 'accepted', ticketId: id })
    const closed = id === ticketId
    store.saveTicket({ ...base, id, events: [id], mandate: { eventId: id, level: closed ? 'think' : 'propose', strength: 'explicit',
      doneWhen: ['核对旧交付'], scope: '旧工单验收', needsReview: true },
      assignments: closed ? [{ id: 'historical', staff: 'engineer', executor: 'dsh', state: 'reported', round: 0, startedAt: now, endedAt: now,
        report: { status: 'ready', summary: '旧交付已核实', structured: true, outputs: [path] }, verification: { verdict: 'pass', critique: '历史通过' },
        deliveries: [{ path, version }] }] : [],
      ...(closed ? { ended: { outcome: 'done', at: now, note: '旧日已验收' } } : {}) })
  }
  for (const [id, assignment] of [[remoteId, remoteAssignment], [secondRemoteId, secondAssignment]]) {
    store.appendEvent({ id, at: now, source: 'inbox', dedupe: id, text: '显式远程测试交办' })
    store.setDisposition(id, { kind: 'accepted', ticketId: id })
    store.saveTicket({ ...base, id, staff: 'liaison', events: [id], mandate: {
      eventId: id, level: 'think', strength: 'explicit', doneWhen: ['仅返回允许的摘要'], scope: '只传固定核对字段', needsReview: true,
    }, assignments: [{ id: assignment, staff: 'liaison', executor: 'remote', state: 'running', round: 0, startedAt: new Date().toISOString() }] })
    new FileRemoteQueue(brain).dispatch({ ticketId: id, assignmentId: assignment, title: '隔离工作电脑任务', prompt: '只有显式核对的任务范围。' })
  }
  mkdirSync(join(brain, 'work/T-0021'), { recursive: true })
  writeFileSync(join(brain, path), '新版本的当前原文。\n')
  mkdirSync(join(brain, 'ops/delivery-versions', ticketId), { recursive: true })
  writeFileSync(join(brain, 'ops/delivery-versions', ticketId, version + '.json'), JSON.stringify({ content: archived }))
  mkdirSync(join(brain, 'ops/discussions'), { recursive: true })
  writeFileSync(join(brain, 'ops/discussions', discussionId + '.json'), JSON.stringify({
    id: discussionId, createdAt: now, quote: archived.trim(), document: { ticketId, path, version, content: archived, assignmentId: 'historical',
      author: { id: 'engineer', name: '工程师', executor: 'dsh', brief: '验收样本', verifier: 'reviewer' }, summary: '旧版摘要', remote: false },
    messages: [{ id: 'historical-question', at: now, role: 'owner', text: '这条旧批注应一直定位存档。' }],
  }))
}
const route = id => '/tickets/' + id + '/thread'
const meta = () => snap(join(host.brain, 'ops/room-index.json')).find(r => r.id === 'legacy-room')
const chat = () => host.api('/chat')
const settings = () => snap(host.settingsFile).liaison
const historicalFile = () => host.api(`/tickets/${ticketId}/file?` + new URLSearchParams({ path, version }))
const noteView = () => host.api('/discussions/' + discussionId)
const proofSnapshot = async () => ({
  room: (await host.api('/rooms/legacy-room')).messages.map(m => m.id), owner: (await chat()).messages.filter(m => m.role === 'you').map(m => [m.seq, m.text]),
  tickets: (await Promise.all([ticketId, newTicket].map(id => host.api(route(id))))).map(thread => ({
    id: thread.ticket_id, stage: thread.stage, thread: thread.thread_id, messages: thread.messages.map(m => m.id),
  })), archive: hash((await historicalFile()).content), quote: (await noteView()).quote,
  remote: (await host.api(route(remoteId))).stage, remotePayload: hash(readFileSync(join(host.brain, 'ops/remote/outbox', remoteAssignment + '.json'))),
})
let browser
async function page(width, height, hashValue) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.context().addCookies(host.cookie().split('; ').map(value => ({ name: value.split('=')[0], value: value.slice(value.indexOf('=') + 1), url: host.base })))
  await page.goto(host.base + '/chief/m/' + hashValue)
  return page
}

async function nativeControl(window, name, dismissed, action) {
  const entry = window.getByRole('button', { name: 'SuperHub', exact: true })
  const control = window.getByRole('button', { name, exact: true })
  const narrow = window.viewportSize().width <= 760
  const prompts = [['Preview Notice', 'Continue'], ['Get started', 'Close']]
  await until(async () => {
    for (const [name, action] of prompts) {
      const button = window.getByRole('dialog', { name, exact: true }).getByRole('button', { name: action, exact: true })
      if (!await button.isVisible()) continue
      if (await button.isEnabled()) await button.click({ timeout: 1000 }).then(() => dismissed.add(name), error => {
        if (error.name !== 'TimeoutError') throw error
      })
      return false
    }
    if (narrow && !await window.locator('[data-sidebar-drawer]:not([data-sidebar-collapsed])').isVisible()) {
      const sidebar = window.locator('[data-sidebar-opener]:visible').first()
      if (await sidebar.isVisible()) await sidebar.click({ timeout: 1000 }).catch(error => {
        if (error.name !== 'TimeoutError') throw error
      })
      return false
    }
    if (!await entry.isVisible() || !await control.isVisible()) return false
    assert.equal(await entry.count(), 1, '原生 DSH 只有一个全局 SuperHub 入口')
    assert.equal(await window.getByRole('button', { name: /进入作战[室台]|^作战[室台]$/ }).count(), 0)
    try {
      await control.click({ trial: action !== 'click', timeout: 1000 })
      if (action === 'keyboard') await control.press('Enter', { timeout: 1000 })
      return true
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error
      return false
    }
  }, `原生 DSH 的 ${name} 入口可操作`)
}

try {
  seed(host.brain)
  await host.start(); await host.api('/pause', { paused: true })
  const legacyRoom = await host.api('/rooms', { request_id: 'legacy-room', title: '旧入口保留' })
  await host.api('/rooms/legacy-room', { session: legacyRoom.session, request_id: 'old-room-speech', text: '旧房间先聊，再关联工单。' })
  await until(async () => (await host.api('/rooms/legacy-room')).messages.some(m => m.kind === 'status'), '旧讨论原生输出')
  await host.api('/rooms/legacy-room/link', { session: legacyRoom.session, ticket: ticketId })
  await host.api('/rooms/legacy-room/link', { session: legacyRoom.session, ticket: newTicket })
  const oldChat = await chat()
  const control = (action, fields = {}) => host.request('/chief-acceptance-surface', { action, session: oldChat.sessionId, ...fields })
  await control('arm')
  await host.api('/chat', { sessionId: oldChat.sessionId, text: '历史接口人第一段。' })
  await until(async () => (await control('flush')).gated, '老入口已在原生模型流')
  await host.api('/chat', { sessionId: oldChat.sessionId, mode: 'steer', text: '旧入口插话仍要保留。' })
  await control('release', { names: ['lead'] })
  await until(() => settings()?.parts?.length, '旧版换段')
  const binding = await host.api(route(newTicket))
  await host.api(route(newTicket), { thread_id: binding.thread_id, ticket_id: newTicket, reply_to: binding.reply_to, request_id: 'legacy-reply', text: '已提交的旧草稿。', execution_boundary: binding.execution_boundary })
  const oldProof = await proofSnapshot()
  assert.equal(oldProof.owner.filter(([, text]) => text === '旧入口插话仍要保留。').length, 1)
  assert.equal(oldProof.remote, 'remote')
  assert.equal((await noteView()).document.version, version)
  await host.stop()
  // Seed the missing-source note in the storage owned by the installed legacy package.
  const record = join(host.brain, 'ops', 'rooms', `${legacyRoom.id}.json`)
  const fixtureFile = existsSync(record) ? record : join(host.brain, 'ops', 'room-index.json')
  const saved = snap(fixtureFile)
  const beforeNote = Array.isArray(saved) ? saved.find(row => row.id === legacyRoom.id) : saved
  assert.equal(beforeNote?.id, legacyRoom.id)
  const missingNote = { id: 'missing', source: 'unavailable-old-source', text: '原始来源已缺失的历史笔记', category: 'verified', at: now, version: 1 }
  beforeNote.notes.push(missingNote)
  writeFileSync(fixtureFile, JSON.stringify(saved))
  const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })

  await check('T21', '旧包升级、回退旧包后再次升级，旧回复和来源标识只保留一份', async () => {
    const states = []
    for (const pkg of [candidate, legacy, candidate]) {
      host.install(pkg)
      await host.start(); await host.api('/pause', { paused: true })
      const snapshot = await proofSnapshot()
      assert.deepEqual(snapshot, oldProof)
      assert.equal(settings().base, oldChat.sessionId)
      assert.deepEqual(meta().notes, [missingNote])
      states.push({ version: pkg === legacy ? 'old' : 'new', ids: snapshot.room, ticketStages: snapshot.tickets.map(row => row.stage) })
      await host.stop()
    }
    host.install(candidate)
    await host.start(); await host.api('/pause', { paused: true })
    const replay = await host.api(route(newTicket), { thread_id: binding.thread_id, ticket_id: newTicket, reply_to: binding.reply_to,
      request_id: 'legacy-reply', text: '已提交的旧草稿。', execution_boundary: binding.execution_boundary })
    assert.equal(replay.messages.filter(m => m.request_id === 'legacy-reply').length, 1)
    return { states, oldDocRead: true, duplicateReply: 0, currentBootstrap: (await host.api('/chat')).sessionId === oldChat.sessionId }
  })

  await check('T04', '历史深链、两张同名工单状态、来源缺失与文档旧批注', async () => {
    const room = await host.api('/rooms/legacy-room')
    assert.deepEqual(room.tickets, [ticketId, newTicket])
    const result = await proofSnapshot()
    assert.deepEqual(result.tickets.map(t => t.stage), ['ended', 'you/approve'])
    assert.notEqual(result.tickets[0].thread, result.tickets[1].thread)
    assert.equal((await historicalFile()).content, archived)
    assert.equal((await noteView()).messages[0].text, '这条旧批注应一直定位存档。')
    assert.equal((await host.api('/rooms/from-ticket', { ticket: ticketId })).id, legacyRoom.id)
    const reader = await page(1440, 900, '#delivery?' + new URLSearchParams({ ticket: ticketId, path, version }))
    await reader.getByText(archived.trim(), { exact: true }).waitFor()
    await reader.close()
    const oldRoom = await page(1440, 900, '#room=legacy-room')
    const missing = oldRoom.locator('.room-note').filter({ hasText: missingNote.text })
    await missing.getByText('原话当前不可用', { exact: true }).waitFor()
    await missing.locator('xpath=..').getByRole('heading', { name: '已核实', exact: true }).waitFor()
    const shot = process.env.CHIEF_SCREENSHOT_DIR
    if (shot) await oldRoom.screenshot({ path: join(shot, 'acceptance-1118-legacy-desktop.png') })
    const hasDeadLink = await missing.getByRole('link', { name: '回看原话' }).count()
    await oldRoom.close()
    assert.equal(hasDeadLink, 0, '缺失来源的旧笔记不应显示「回看原话」链接')
  })

  await check('T21', '同一第二大脑单写者与跨脑同号草稿拒绝', async () => {
    const alternate = await acceptanceHost({ candidate })
    seed(alternate.brain)
    const original = snap(alternate.settingsFile)
    writeFileSync(alternate.settingsFile, JSON.stringify({ ...original, brain: host.brain }), { mode: 0o600 })
    try {
      await alternate.start()
      const state = await alternate.api('/state')
      assert.match(state.setup?.problem ?? '', /同一时间只能有一个|占用/)
      await alternate.stop()
      writeFileSync(alternate.settingsFile, JSON.stringify(original), { mode: 0o600 })
      await alternate.start(); await alternate.api('/pause', { paused: true })
      const room = await alternate.api('/rooms', { request_id: 'legacy-room', title: '旧入口保留' })
      assert.notEqual(room.session, legacyRoom.session)
      const oldDraft = await alternate.api('/rooms/legacy-room', { session: legacyRoom.session, request_id: 'old-draft', text: '来自另一个第二大脑' }, { raw: true })
      assert.equal(oldDraft.status, 409)
      assert.ok((await alternate.api('/rooms/legacy-room')).messages.every(m => !m.text.includes('另一个第二大脑')))
      return { conflict: state.setup.problem, staleBody: oldDraft.status, recordsRetained: equalsIds(oldProof.room, (await proofSnapshot()).room) }
    } finally { await alternate.stop() }
  })
  await check('T21', '两次切换原生入口，旧工单上批准且原话引用可回查', async () => {
    const room = await host.api('/rooms/legacy-room')
    const source = room.messages[0]
    await host.api('/rooms/legacy-room/notes', { session: room.session, id: 'can-read', source: source.id, text: '升级后能回读这一条旧原话', category: 'agreement' })
    await host.request('/chief-acceptance-surface', { action: 'complete-test-onboarding' })
    const dismissed = new Set()
    const verified = []
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const window = await browser.newPage({ viewport, locale: 'en-US' })
      const mobile = viewport.width < 760
      const room = window.getByRole('heading', { name: '旧入口保留' })
      const plugins = window.getByRole('button', { name: 'Plugins', exact: true })
      const toNative = async () => {
        if (mobile) await window.locator('.chief-mobile-bar').getByRole('button', { name: '讨论', exact: true }).click()
        const back = window.getByRole('button', { name: '返回 DSH', exact: true })
        assert.equal(await back.count(), 1)
        await back.click()
        await window.locator('.chief-surface').waitFor({ state: 'detached' })
      }
      try {
        await window.context().addCookies(host.cookie().split('; ').map(value => ({ name: value.split('=')[0], value: value.slice(value.indexOf('=') + 1), url: host.base })))
        await window.goto(host.base + '/#room=legacy-room')
        await room.waitFor()
        await window.getByRole('button', { name: /^工作总览/ }).click()
        const overview = window.getByRole('main', { name: '工作总览', exact: true })
        const returnToRoom = overview.getByRole('button', { name: '返回讨论', exact: true })
        await returnToRoom.waitFor()
        const overviewHash = new URL(window.url()).hash
        assert.match(overviewHash, /^#superhub\?/)
        await toNative()
        if (!mobile) {
          await nativeControl(window, 'Plugins', dismissed, 'click')
          await until(async () => await plugins.getAttribute('aria-current') === 'page', '显示原生插件页')
        }
        await nativeControl(window, 'SuperHub', dismissed)
        if (process.env.CHIEF_SCREENSHOT_DIR) await window.screenshot({ path: join(process.env.CHIEF_SCREENSHOT_DIR, `superhub-native-${viewport.width}.png`) })
        for (let i = 0; i < 2; i++) {
          await nativeControl(window, 'SuperHub', dismissed, mobile ? 'click' : 'keyboard')
          if (i === 0) {
            await returnToRoom.waitFor()
            assert.equal(new URL(window.url()).hash, overviewHash)
            await returnToRoom.click()
          }
          await room.waitFor()
          assert.equal(new URL(window.url()).hash, '#room=legacy-room')
          if (i === 0) {
            await toNative()
            if (!mobile) await until(async () => await plugins.getAttribute('aria-current') === 'page', '恢复原生插件页')
          }
        }
        await window.getByRole('button', { name: /^工作总览/ }).click()
        await returnToRoom.waitFor()
        await window.reload()
        await returnToRoom.click()
        await room.waitFor()
        assert.equal(new URL(window.url()).hash, '#room=legacy-room')
        if (!mobile) {
          await window.locator('.room-note').filter({ hasText: '升级后能回读' }).getByRole('link', { name: '回看原话' }).click()
          assert.equal(await window.evaluate(() => document.activeElement.id), 'source-' + source.id)
        }
        verified.push(viewport)
      } catch (error) {
        proof.nativeSurfaceFailure = {
          viewport,
          ...(await window.evaluate(() => ({ chiefMounted: !!document.querySelector('.chief-surface'),
            nativeMode: localStorage.getItem('chief-surface-mode') === 'native', roomDeepLink: location.hash === '#room=legacy-room' })).catch(() => ({}))),
          nativeEntryCount: await window.getByRole('button', { name: 'SuperHub', exact: true }).count().catch(() => 0),
          nativeDialogs: await window.getByRole('dialog').evaluateAll(rows => rows.map(node => node.getAttribute('aria-label') ?? node.querySelector('h2')?.textContent)).catch(() => []),
          dismissed: [...dismissed],
        }
        throw error
      } finally {
        await window.close()
      }
    }
    const thread = await host.api(route(newTicket))
    const payload = { thread_id: thread.thread_id, reply_to: thread.reply_to, stage: thread.stage }
    await host.api('/tickets/' + newTicket + '/approve', payload)
    assert.equal((await host.api(route(newTicket))).stage, 'queued')
    await assert.rejects(host.api('/tickets/' + newTicket + '/approve', payload), error => error.status === 409)
    return { approvedOnce: true, lookupSource: source.id, nativeEntryCount: 1, roundTripsPerViewport: 2,
      restoredRoomFromOverviewAfterReload: true, verified, nativeDialogsDismissed: [...dismissed] }
  })
  await check('T19', '升级保留已授权远程工作，停止后迟到回传仍被拒绝并记录', async () => {
    const before = await host.api(route(remoteId))
    assert.equal(before.stage, 'remote')
    await host.api('/tickets/' + remoteId + '/stop', { reason: '撤回远端测试工作', thread_id: before.thread_id, reply_to: before.reply_to, stage: before.stage })
    const queue = new FileRemoteQueue(host.brain)
    assert.ok(existsSync(join(queue.dir, 'cancelled', remoteAssignment + '.json')))
    assert.ok(!existsSync(join(queue.dir, 'outbox', remoteAssignment + '.json')))
    writeFileSync(join(queue.dir, 'inbox', remoteAssignment + '.json'), JSON.stringify({ ticketId: remoteId, assignmentId: remoteAssignment,
      report: { status: 'ready', summary: '测试迟到回传，无实际工作内容。' } }))
    await until(() => existsSync(join(queue.dir, 'rejected', remoteAssignment + '.json')), '迟到回传隔离')
    const after = await host.api(route(remoteId))
    assert.equal(after.stage, 'ended')
    assert.equal(after.executions.length, 1)
    assert.ok(after.messages.every(m => !m.text.includes('测试迟到回传')))
    return { cancellationRecorded: true, rejectedLate: true }
  })
  await check('T19', '已授权派工也必须拒绝未授权的额外回流材料', async () => {
    const EVIDENCE_PROBE = 'FIXTURE_UNAPPROVED_DOCUMENT_CONTENT'
    const queue = new FileRemoteQueue(host.brain)
    assert.equal((await host.api(route(secondRemoteId))).stage, 'remote')
    const bridge = (args, input) => execFileSync('node', ['bin/cli.mjs', 'bridge'], {
      env: { ...process.env, DSH_HOME: host.home, SSH_ORIGINAL_COMMAND: args }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    })
    const assigned = JSON.parse(bridge('pull acceptance-scope-claim'))
    assert.equal(assigned.assignmentId, secondAssignment)
    const reply = bridge('push ' + secondAssignment, JSON.stringify({ status: 'ready', summary: '固定字段已核对', fixtureAdditionalDocument: EVIDENCE_PROBE }))
    assert.equal(reply.trim(), 'ok')
    const receipt = await until(() => ['done', 'rejected'].find(directory => existsSync(join(queue.dir, directory, secondAssignment + '.json'))), '回流范围探针')
    const directory = join(host.brain, 'work', secondRemoteId)
    const files = (await host.api('/tickets/' + secondRemoteId)).files
    const originalReport = files.filter(file => file.path.includes('remote-report-')).some(file => readFileSync(join(host.brain, file.path), 'utf8').includes(EVIDENCE_PROBE))
    proof.remoteInbound = { bridge: reply.trim(), receipt, originalReport }
    assert.ok(!originalReport, '远程回传的额外字段未经过内容范围校验，被原样登记到工单交付文件')
    return { receipt, directory }
  })
  proof.completed = true
  save()
  if (proof.checks.some(row => row.status === '失败')) process.exitCode = 1
} catch (error) { proof.error = String(error); save(); throw error }
finally { await browser?.close(); await host.stop() }

function equalsIds(a, b) { assert.deepEqual(a, b); return true }
