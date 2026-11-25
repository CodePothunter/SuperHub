/** Verify actual DSH sandbox effects and the workroom's approvals on a disposable host. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileStore } from '../src/core/store.ts'
import { acceptanceHost, until } from './acceptance-host.mjs'

const area = mkdtempSync(join(homedir(), '.chief-sandbox-fixture-'))
const endpoint = '/settings/approvals'
let host, browser
try {
  host = await acceptanceHost({ probe: 'command-approval-probe.mjs', mobile: true, extraEnv: { CHIEF_APPROVAL_TEST_DIR: area } })
  console.log('Command approval host', host.work)
  await host.start()
  await host.api('/staff', { id: 'engineer', name: '工程师', executor: 'dsh', brief: '运行本工单中的隔离验证。' })
  const password = 'sandbox-fixture-' + randomUUID()
  await host.api('/settings/password', { password })
  await host.stop()
  const store = new FileStore(host.brain)
  for (const [index, title] of ['验证维护命令能否更新本地状态', '拒绝超出工作区的写入', '停止待审批工单'].entries()) {
    const id = 'T-004' + (index + 1), at = '2026-11-17T04:00:00Z'
    store.appendEvent({ id, at, source: 'inbox', dedupe: id, text: title })
    store.setDisposition(id, { kind: 'accepted', ticketId: id })
    store.saveTicket({ id, title, staff: 'engineer', createdAt: at, priority: 3 - index, events: [id], inputs: [], assignments: [],
      mandate: { eventId: id, scope: '仅操作隔离夹具中的标记文件', level: 'think', strength: 'explicit', needsReview: true, doneWhen: ['验证权限审批'] } })
  }
  await host.start()
  const pending = id => until(async () => (await host.api(endpoint)).find(row => row.ticket === id), `${id} DSH 原生命令申请`)
  const audit = () => host.request('/chief-command-approval-probe')
  const allowed = await pending('T-0041')
  const rejected = await pending('T-0042')
  assert.ok((await audit()).some(event => event.ticket === allowed.ticket && event.kind === 'tool' && event.sandboxDenied))
  assert.equal(existsSync(join(area, allowed.ticket + '.txt')), false, '审批前不应写入工作区之外')
  assert.match(allowed.command, /T-0041\.txt/)
  assert.equal(allowed.workdir, join(host.brain, 'work', allowed.ticket))
  assert.equal(allowed.mode, 'danger-full-access')
  // The owner is reminded when DSH asks; the request carries the default 30-minute window.
  assert.equal(Date.parse(allowed.expiresAt) - Date.parse(allowed.requestedAt), 30 * 60_000)
  const reminder = key => until(async () => (await host.api('/chat')).notices.find(row => row.key === key), `${key} 审批提醒`)
  const asked = await reminder(`approval:${allowed.ticket}:${allowed.id}`)
  assert.equal(asked.ticketId, allowed.ticket)
  assert.match(asked.text, /^命令待审批：工程师在「验证维护命令能否更新本地状态」（T-0041）申请运行 /)
  assert.equal((await host.api(endpoint, undefined, { login: '', raw: true })).status, 401)
  assert.equal((await host.api(endpoint, { id: allowed.id, allow: true }, { marked: false, raw: true })).status, 403)
  const phoneLogin = await fetch(host.mobileBase + '/login', { method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual' })
  const phoneCookie = phoneLogin.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')
  assert.ok(phoneCookie)
  const phone = { baseUrl: host.mobileBase, login: phoneCookie, raw: true }
  assert.equal((await host.api(endpoint, undefined, phone)).status, 403)
  assert.equal((await host.api(endpoint, { id: allowed.id, allow: true }, phone)).status, 403)

  const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.context().addCookies(host.cookie().split('; ').map(item => ({ name: item.split('=')[0], value: item.slice(item.indexOf('=') + 1), url: host.base })))
  await page.goto(host.base)
  const panel = page.getByRole('region', { name: '命令权限审批' })
  await panel.getByRole('button', { name: /等待权限审批/ }).click()
  const card = id => panel.locator('article').filter({ hasText: id })
  assert.equal(await card(allowed.ticket).locator('pre').textContent(), allowed.command)
  await card(allowed.ticket).getByText(/解除 DSH 文件沙箱限制/).waitFor()
  await card(rejected.ticket).getByRole('button', { name: '拒绝', exact: true }).click()
  await card(rejected.ticket).waitFor({ state: 'hidden' })
  const cancelled = await pending('T-0043')
  const thread = await host.api('/tickets/T-0043/thread')
  await host.api('/tickets/T-0043/stop', { reason: '隔离权限测试', thread_id: thread.thread_id, reply_to: thread.reply_to, stage: thread.stage })
  await until(async () => !(await host.api(endpoint)).some(row => row.id === cancelled.id), '停止后撤下待批命令')
  assert.equal((await host.api(endpoint, { id: cancelled.id, allow: true }, { raw: true })).status, 409)
  await panel.getByRole('button', { name: /1 条命令正在等待权限审批/ }).waitFor()
  const screenshotDir = process.env.CHIEF_SCREENSHOT_DIR
  if (screenshotDir) {
    mkdirSync(screenshotDir, { recursive: true })
    await page.screenshot({ path: join(screenshotDir, 'command-approval-desktop.png') })
  }
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'command-approval-mobile.png') })
  await card(allowed.ticket).getByRole('button', { name: '仅允许本次命令' }).click()
  await until(() => existsSync(join(area, allowed.ticket + '.txt')), '原生命令写入隔离标记')
  assert.equal(readFileSync(join(area, allowed.ticket + '.txt'), 'utf8'), 'sandbox-fixture\n')
  assert.equal((await host.api(endpoint, { id: allowed.id, allow: true }, { raw: true })).status, 409)
  const events = await until(async () => {
    const rows = await audit()
    return rows.filter(event => event.ticket === allowed.ticket && event.kind === 'tool').length >= 3 ? rows : undefined
  }, '批准后再次执行普通命令仍受沙箱限制')
  assert.deepEqual(events.filter(event => event.ticket === allowed.ticket && event.kind === 'tool').map(event => event.sandboxDenied), [true, false, true])
  for (const [request, outcome] of [[allowed, 'allowed-once'], [rejected, 'rejected'], [cancelled, 'cancelled']]) {
    const asked = events.find(event => event.ticket === request.ticket && event.kind === 'asked')
    assert.ok(asked)
    assert.ok(events.some(event => event.id === asked.id && event.kind === 'decided' && event.outcome === outcome), `${request.ticket} 应有原生 ${outcome} 审计`)
  }
  for (const file of [rejected.ticket, cancelled.ticket, allowed.ticket + '-next']) assert.equal(existsSync(join(area, file + '.txt')), false)
  // Native DSH approvals are also recorded on the ticket and the reminder shows the outcome.
  for (const [request, outcome, label] of [[allowed, 'allowed-once', '已允许本次'], [rejected, 'rejected', '已拒绝']]) {
    const records = await until(async () => {
      const rows = (await host.api(`/tickets/${request.ticket}/thread`)).executions.flatMap(row => row.approvals ?? []).filter(row => row.id === request.id)
      return rows.some(row => row.status === outcome) ? rows : undefined
    }, `${request.ticket} 工单审批记录`)
    assert.deepEqual(records.map(row => row.status), ['requested', outcome])
    assert.equal(records[0].timeoutMinutes, 30)
    assert.deepEqual(await reminder(`approval:${request.ticket}:${request.id}`).then(row => [row.status, row.done]), [label, true])
  }
  console.log('PASS DSH 文件沙箱、单次允许、拒绝、停止取消、原生审计、公开端和过期重放')
} finally {
  await browser?.close()
  await host?.stop()
  rmSync(area, { recursive: true, force: true })
}
