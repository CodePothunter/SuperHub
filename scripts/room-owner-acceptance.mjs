/** Exercise the historical room component against a real, disposable DSH host. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { recordAsset } from './record-reader-ui.mjs'

const host = await acceptanceHost({ probe: 'acceptance-surface-probe.mjs' })
console.log('Room owner acceptance host', host.work)
const title = '方舟接入验证（隔离样例）'
let browser
try {
  await host.start()
  await host.api('/pause', { paused: true })
  await host.api('/staff', { id: 'engineer', name: '工程师', executor: 'codex', brief: '处理隔离验收任务。' })
  const room = await host.api('/rooms', { request_id: 'room-owner', title })
  const path = `/rooms/${room.id}`
  const probe = (action, fields = {}) => host.request('/chief-acceptance-surface', { action, session: room.session, ...fields })
  const ownerText = '请按原话核对隔离样例，确认准备步骤，并记录本地结果。'
  const input = await host.api(path, { session: room.session, request_id: 'fixture-owner-request', text: ownerText })
  const origin = input.messages.find(message => message.author === 'you' && message.text === ownerText)
  assert.ok(origin, '存在真实用户原话')
  const notices = async () => (await host.api('/chat')).notices.filter(row => row.roomId === room.id)
  const pending = async () => (await host.api('/state')).roomActions.filter(row => row.roomId === room.id)
  assert.deepEqual(await pending(), [], '普通讨论消息不产生待办')
  assert.deepEqual(await notices(), [])
  const command = { name: 'bash', args: { command: 'printf isolated-room-execution', description: '隔离验证' } }
  for (let i = 0; i < 3; i++) {
    const attempt = await probe('tool', command)
    assert.equal(attempt.ok, false)
    assert.match(attempt.message, /登记待办/)
  }
  const [review] = await pending()
  assert.ok(review)
  assert.equal(review.source, origin.id)
  assert.deepEqual((await pending()).map(row => row.kind), ['execute'])
  assert.equal((await notices()).length, 1)
  assert.deepEqual(await host.api('/settings/approvals'), [], '讨论命令在正式授权前不进入审批工具')
  await host.stop()
  await host.start()
  assert.deepEqual((await pending()).map(row => row.id), [review.id])
  assert.equal((await notices()).length, 1)
  await probe('tool', command)
  assert.equal((await pending()).length, 1, '重启之后再次拦截也不能重复')

  const question = '隔离验证是否只需要核对准备步骤？'
  for (let i = 0; i < 2; i++) {
    const result = await probe('tool', { name: 'chief_room_note', args: { action: 'ask_owner', source: origin.id, text: question } })
    assert.equal(result.ok, true, result.message)
  }
  assert.equal((await notices()).length, 2, '一条执行待办和一条问题')
  assert.equal((await pending()).length, 2)
  const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.context().addCookies(host.cookie().split('; ').map(item => ({ name: item.split('=')[0], value: item.slice(item.indexOf('=') + 1), url: host.base })))
  await page.route('**/chief/m/app.js', route => route.fulfill({path:recordAsset('app.js'), contentType:'text/javascript'}))
  await page.goto(host.base + '/chief/m/')
  const decisions = page.getByRole('heading', { level: 2, name: /等你决定/ })
  await decisions.waitFor()
  const desk = page.getByRole('main').locator('.wr-sec').filter({ has: decisions })
  await desk.getByText(question, { exact: true }).waitFor()
  const dm = page.getByRole('complementary', { name: '接口人' })
  await dm.getByText(question, { exact: false }).waitFor()
  const screenshots = process.env.CHIEF_SCREENSHOT_DIR
  if (screenshots) { mkdirSync(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'room-owner-reminders.png') }) }
  await dm.getByRole('button', { name: '打开讨论待办' }).first().click()
  const actions = page.getByRole('region', { name: '讨论待办' })
  await actions.getByPlaceholder('填写回答').fill('是，只做隔离验收。')
  await actions.getByRole('button', { name: '回答', exact: true }).click()
  await actions.getByPlaceholder('填写回答').waitFor({ state: 'hidden' })
  await actions.getByRole('button', { name: '提交执行审批' }).click()
  await actions.getByLabel('工单标题').fill('隔离执行四步验证')
  await actions.getByLabel('负责角色').selectOption('engineer')
  await actions.getByRole('button', { name: '创建待批准工单' }).click()
  await page.getByRole('button', { name: '批准', exact: true }).waitFor()
  const [ticket] = (await host.api('/state')).you
  assert.equal(ticket.stage, 'you/approve')
  assert.equal(ticket.requestedExecutor, 'codex')
  assert.deepEqual(await pending(), [])
  assert.ok((await host.api(path)).tickets.includes(ticket.id))
  const duplicate = await probe('tool', { name: 'chief_room_note', args: { action: 'request_execution', source: origin.id, title: '隔离执行四步验证', staff: 'engineer', operation: 'write' } })
  assert.equal(duplicate.value.ticketId, ticket.id)
  assert.equal((await host.api('/state')).you.length, 1)
  assert.equal((await host.api('/chat')).notices.filter(row => row.ticketId === ticket.id).length, 1)
  assert.equal((await host.api('/chat')).notices.find(row => row.roomId === room.id)?.done, true)
  const actual = await host.api(`/tickets/${ticket.id}`)
  assert.equal(actual.ticket.assignments.length, 0)
  const other = await host.api('/rooms', { request_id: 'other-owner', title: '另一讨论' })
  await assert.rejects(host.api(`/rooms/${other.id}/submit-work`, { session: other.session, source: origin.id, title: '越界', staff: 'engineer' }), /当前讨论中的主人原话/)
  await page.getByRole('button', { name: '批准', exact: true }).click()
  await page.getByText(/当前 DSH 没有挂载该执行器/).waitFor()
  assert.equal((await host.api(`/tickets/${ticket.id}`)).stage, 'you/approve', 'Codex 缺失时不得换 DSH 执行')
  await until(async () => (await host.api(path)).messages.some(row => row.replyTo === origin.id && row.text.includes('只做隔离验收')), '回答回到原生讨论')
  console.log('PASS 原生拦截必有待办、跨重启去重、私聊和台面一致、回答与正式工单回到同一讨论、批准前零执行')
} finally {
  await browser?.close()
  await host.stop()
}
