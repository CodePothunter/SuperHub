/** Actual HTTP projections and built UI; execution records are isolated fixtures. */
import assert from 'node:assert/strict'
import { recordAsset } from './record-reader-ui.mjs'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { NativeRooms } from '../src/dsh/rooms.ts'
import { recentTicketReplies } from '../src/dsh/room-work.ts'
import { runtimeRoutes, serveApi, json } from '../src/dsh/http.ts'
import { FIXTURE, CHAT } from '../preview/fixture.ts'

const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const root = mkdtempSync(join(tmpdir(), 'chief-handoff-ui-')), agents = new Map()
const messages = []
let calls = 0, stage = 'working'
const ctx = {
  agents: { get: id => agents.get(id) },
  workspaceRegistry: { create: async () => ({ id: 'workspace' }) },
  sessionController: { resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }, create: async ({ sessionId }) => { agents.set(sessionId, { id: sessionId }) }, prompt: async () => { calls++ } },
  get: service => service === 'sessionQuery' ? { observeSession: async () => ({ events: messages, [Symbol.dispose]() {} }) } : { listMembers: agent => [{ id: agent.id, name: 'lead', role: 'lead', status: 'inactive', diagnostics: [] }], listTasks: () => [] },
}
const rooms = new NativeRooms(ctx, root, () => [])
await rooms.create('handoff-fixture', '准备独立验证环境'); rooms.link('handoff-fixture', 'T-0011')
const assignment = { id: 'fixture-assignment', staff: 'engineer', executor: 'claude-code', startedAt: '2026-11-17T10:00:00Z', state: 'running', round: 0, role: { id: 'engineer', name: '工程师', executor: 'claude-code' }, execution: { provider: 'claude-code', activationId: 'fixture-external-activation' } }
const event = { id: 'fixture-event', at: '2026-11-17T09:59:00Z', source: 'inbox', text: '准备隔离的验证环境，确认安装来源与版本。登录留给主人完成。' }
const ticket = { id: 'T-0011', title: '准备独立验证环境', staff: 'engineer', createdAt: event.at, inputs: [], events: [event.id], mandate: { eventId: event.id, scope: event.text, doneWhen: ['环境可复现'], level: 'think', strength: 'explicit' }, assignments: [assignment] }
const formalReplies = new Map()
const engine = { views: () => [{ ticket, stage }], initialEvent: () => event, reply: async (id, text, binding) => {
  assert.equal(id, ticket.id); assert.equal(binding.ticketId, ticket.id)
  assert.equal(binding.replyTo, assignment.id); assert.equal(binding.executionBoundary, 'local')
  if (formalReplies.has(binding.requestId)) { assert.deepEqual(formalReplies.get(binding.requestId), { text, binding }); return }
  formalReplies.set(binding.requestId, { text, binding }); ticket.inputs.push({ from: 'owner', at: new Date(Date.parse('2026-11-17T10:03:00Z') + ticket.inputs.length * 60_000).toISOString(), text, key: 'reply:' + binding.requestId, replyTo: assignment.id })
} }
const routes = runtimeRoutes({ rooms, engine, brain: { root, staff: () => [assignment.role] }, roster: {} })
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local')
  if (url.pathname === '/chief/api/state') return json(res, 200, FIXTURE)
  if (url.pathname === '/chief/api/chat') return json(res, 200, { ...CHAT, notices: [], workReplies: recentTicketReplies([ticket], rooms.list()) })
  if (url.pathname === '/chief/api/rooms/handoff-fixture') {
    const { cursor, incremental, ...legacy } = await rooms.view('handoff-fixture')
    return json(res, 200, legacy) // Production's pre-cursor API: the hotfix must work here too.
  }
  if (url.pathname.startsWith('/chief/api/')) return serveApi(req, res, 'dsh', [routes])
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  if (!['index.html', 'app.js', 'page.css', 'icon.svg', 'manifest.webmanifest'].includes(file)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(readFileSync(recordAsset(file)))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })
try {
  const checks = []
  for (const [name, width, height] of [['desktop',1440,900], ['mobile',390,844]]) {
    ticket.inputs = []; messages.length = 0; const repliesBefore = formalReplies.size
    stage = 'working'; assignment.state = 'running'; delete assignment.report; delete assignment.endedAt
    const page = await browser.newPage({ viewport: { width, height } }), errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${server.address().port}/#room=handoff-fixture`)
    await page.getByText(event.text, { exact: true }).waitFor()
    await page.getByText(/Claude Code 正在处理/).waitFor()
    assert.equal(await page.locator('.room-main .room-empty').count(), 0)
    assert.equal(await page.locator('.room-message').count(), 0, 'do not invent native chat for an external activation')
    assert.equal(await page.locator('.room-work-entry').count(), 2)
    await page.getByText('实际：Claude Code', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.getByRole('button', { name: '成员 2', exact: true }).click()
    await page.getByRole('heading', { name: '讨论成员', exact: true }).waitFor()
    await page.locator('.room-panel').getByText('工程师', { exact: true }).waitFor()
    await page.getByRole('button', { name: '给这项工作追加说明', exact: true }).click()
    assert.equal(await page.locator('.room-compose select').inputValue(), 'work:T-0011')
    await page.reload(); await page.getByRole('button', { name: '成员 2', exact: true }).waitFor(); await page.waitForFunction(() => document.querySelector('.room-compose select')?.value === 'work:T-0011')
    mkdirSync('screenshots', { recursive: true }); await page.screenshot({ path: `screenshots/handoff-${name}.png` })
    let lost = false
    await page.route('**/chief/api/tickets/T-0011/thread', async route => {
      if (route.request().method() === 'POST' && !lost) { lost = true; const accepted = await route.fetch(); assert.equal(accepted.status(), 200); await route.fulfill({ status: 503, json: { error: '执行补充回执丢失' } }) } else await route.continue()
    })
    await page.getByLabel('在讨论中发言').fill('请解释这项工作的当前限制，不扩大执行范围。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '执行补充回执丢失' }).waitFor()
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="在讨论中发言"]')?.value === '')
    assert.equal(formalReplies.size - repliesBefore, 1)
    await page.unroute('**/chief/api/tickets/T-0011/thread')
    stage = 'you/review'; assignment.state = 'reported'; assignment.endedAt = '2026-11-17T10:05:00Z'
    assignment.report = { status: 'ready', summary: '环境已准备，等待主人完成登录。', outputs: [], structured: true }
    await page.getByText(assignment.report.summary, { exact: true }).waitFor()
    await page.getByText('工程师 · 结果回传', { exact: true }).waitFor()
    assert.equal(await page.locator('.room-message').count(), 0)
    assert.equal(await page.locator('.room-work-entry').count(), 4)
    assert.equal(calls, 0); assert.deepEqual(errors, [])
    await page.screenshot({ path: `screenshots/handoff-${name}-reported.png` })
    stage = 'you/blocked'; assignment.report = { status: 'blocked', summary: '执行权限不足，等待补充授权。', outputs: [], structured: true }
    await page.getByText('执行受阻', { exact: true }).waitFor()
    await page.getByText(assignment.report.summary, { exact: true }).waitFor()

    const nativeText = '验证环境准备好以后，按当前工单交接。'
    const replyText = '先保留现有版本，登录留给我完成。'
    messages.push({ seq: 1, time: Date.parse('2026-11-17T10:03:30Z'), type: 'assistant/message', data: { message: { content: [{ type: 'text', text: nativeText }] } } })
    await page.locator('.room-work-feed').getByRole('button', { name: '查看执行与核验' }).click()
    await page.getByLabel('追加给本工单的执行说明').fill(replyText)
    await page.getByRole('button', { name: '发送并推进执行' }).click()
    await page.locator('.wr-ticket-conversation').getByText(replyText, { exact: true }).waitFor()
    await page.getByRole('button', { name: '打开关联讨论' }).click()
    const roomReply = page.locator('.room-work-entry').filter({ hasText: replyText })
    await roomReply.waitFor()
    assert.equal(await roomReply.count(), 1)
    assert.ok(await page.locator('.room-log article').evaluateAll((rows, [from, to]) =>
      rows.findIndex(row => row.textContent.includes(from)) < rows.findIndex(row => row.textContent.includes(to)), [nativeText, replyText]))
    if (name === 'mobile') await page.getByRole('navigation', { name: '工作空间导航' }).getByRole('button', { name: '接口人', exact: true }).click()
    else await page.locator('.chief-home').click()
    const receipt = page.locator('.wr-work-reply').filter({ hasText: replyText })
    await receipt.waitFor()
    assert.equal(await receipt.count(), 1)
    if (process.env.CHIEF_SCREENSHOTS) await page.screenshot({ path: `${process.env.CHIEF_SCREENSHOTS}/live-ticket-context-${name}.png` })
    await receipt.getByRole('button', { name: '打开讨论' }).click()
    await roomReply.waitFor()
    assert.equal(calls, 0)
    assert.deepEqual(errors, [])
    checks.push({ membersVisible: 2, directedFormalReply: true, duplicateReplies: 0, blockedVisible: true, name, width, height, originalVisible: true, statusVisible: true, resultUpdated: true, replyInRoomAndChat: true, modelCalls: calls })
    await page.close()
  }
  mkdirSync('artifacts/acceptance', { recursive: true }); writeFileSync('artifacts/acceptance/handoff-ui.json', JSON.stringify({ appSha256: createHash('sha256').update(readFileSync(recordAsset('app.js'))).digest('hex'), host: 'HTTP routes and historical record component with deterministic execution', checks }, null, 2))
  console.log('PASS empty handoff room shows actual commission, running external executor and final result; no extra execution')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rooms.dispose(); rmSync(root, { recursive: true, force: true }) }
