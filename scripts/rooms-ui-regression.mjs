/** Browser acceptance uses real API routes and native-session projection with deterministic host fixtures. */
import assert from 'node:assert/strict'
import { recordAsset } from './record-reader-ui.mjs'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { NativeRooms } from '../src/dsh/rooms.ts'
import { Connectors } from '../src/dsh/connectors.ts'
import { runtimeRoutes, serveApi, json } from '../src/dsh/http.ts'
import { FIXTURE, CHAT } from '../preview/fixture.ts'

const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const root = mkdtempSync(join(tmpdir(), 'chief-rooms-ui-'))
const events = new Map(), agents = new Map(); let sends = 0
const roles = [{ id: 'researcher', name: '研究员', brief: '查来源' }, { id: 'engineer', name: '工程师', brief: '核对实现' }]
const members = [{ id: 'lead', name: 'lead', role: 'lead', status: 'inactive', diagnostics: [] }, { id: 'researcher', name: 'researcher', role: 'teammate', status: 'inactive', diagnostics: [] }, { id: 'engineer', name: 'engineer', role: 'teammate', status: 'inactive', diagnostics: [] },
  // 生产讨论 ticket-T-0020 的成员以幕僚 id 命名：显示时一律按花名册换成中文名（R8-6）。
  ...['chief', 'liaison', 'scribe', 'ui-smith'].map(id => ({ id, name: id, role: 'teammate', status: 'inactive', diagnostics: [] }))]
const STATE = { ...FIXTURE, staff: [...FIXTURE.staff, { id: 'ui-smith', name: '界面师', executor: 'dsh', verifier: 'reviewer', available: true, done: 0, doing: [], brief: '改作战台界面。' }] }
const RAW_IDS = /\b(?:chief|liaison|scribe|ui-smith)\b/
async function rosterNames(page) {
  const header = await page.locator('.room-participants').innerText()
  for (const name of ['接口人', '研究员', '工程师', '研判官', '外务', '书记官', '界面师']) assert.ok(header.includes(name), `成员列表缺少 ${name}：${header}`)
  assert.doesNotMatch(header, RAW_IDS, `成员列表出现原始幕僚 id：${header}`)
}
const append = (session, source, text, time = Date.now()) => { const rows = events.get(session) ?? []; rows.push({ seq: rows.length + 1, time, type: 'user/message', data: { id: `message-${rows.length}`, source, content: [{ type: 'text', text }] } }); events.set(session, rows) }
const ctx = { agents: { get: id => agents.get(id) }, subagents: { prompt: async input => { sends++; append(input.childSessionId, { kind: 'user', rpcId: input.requestId }, input.content[0].text); return { messageId: 'native-child' } } }, get: service => service === 'sessionQuery' ? { observeSession: async id => ({ events: events.get(id) ?? [], [Symbol.dispose]() {} }) } : ({ listMembers: lead => [{ ...members[0], id: lead.id }, ...members.slice(1)], listTasks: () => [{ id: 'task-1', subject: '核对重启后的结果回传', status: 'in_progress', revision: 1, ownerName: 'engineer' }] }), workspaceRegistry: { create: async () => ({ id: 'workspace' }) }, sessionController: {
  resolveAgent: async id => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
  create: async ({ sessionId }) => { members[0].id = sessionId; agents.set(sessionId, { id: sessionId, session: { snapshotEvents: () => events.get(sessionId) ?? [] } }) },
  prompt: async input => { sends++; append(input.sessionId, { kind: 'user', rpcId: input.requestId }, input.content[0].text); return { messageId: 'host-accepted' } },
} }
for (const id of ['researcher','engineer']) agents.set(id, { id, session: { snapshotEvents: () => events.get(id) ?? [] } })
let rooms = new NativeRooms(ctx, root, () => roles)
const connectors = new Connectors(join(root, 'private'))
await rooms.create('discussion-1', 'DS-Bot 的派工与唤醒')
const base = Date.parse('2026-11-17T10:02:00+08:00')
append(members[0].id, { kind: 'user' }, '帮我研究 DS-Bot，先查清楚派工后，结果怎么交回接口人。', base)
append('researcher', { kind: 'agent-message', senderSessionId: members[0].id }, '先看交接设计，再请工程师复现重启后的唤醒。拿到结果后一起核对。', base + 1000)
append('engineer', { kind: 'agent-message', senderSessionId: 'researcher' }, '我找到了交接设计。你能核对一下，重启后结果是否还会回到原派工人？', base + 60000)
append('researcher', { kind: 'agent-message', senderSessionId: 'engineer' }, '可以。我先核对原生团队的消息记录；如果要读取私有验证仓库，会单独申请。', base + 120000)
await rooms.note('discussion-1', { id: 'note-1', source: `${members[0].id}:1`, text: '先讲派工与唤醒，再看版本变化。', category: 'agreement' })
await rooms.note('discussion-1', { id: 'note-2', source: 'engineer:1', text: '重启后回传是否保持原发送关系，等待复现证据。', category: 'pending' })
let routes = runtimeRoutes({ rooms, connectors, engine: {}, brain: {}, roster: {} })
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/chief/api/state')) return json(res, 200, STATE)
  if (req.url.startsWith('/chief/api/chat')) return json(res, 200, { ...CHAT, messages:[...CHAT.messages,{seq:5,role:'liaison',time:base,text:'已衔接到这个讨论。',discussions:[{id:'discussion-1',title:'DS-Bot 的派工与唤醒'}]}], notices: [] })
  if (req.url.startsWith('/chief/api/')) return serveApi(req, res, 'dsh', [routes])
  const name = req.url === '/' ? 'index.html' : req.url.slice(1).split('?')[0]
  if (!['index.html', 'app.js', 'page.css', 'icon.svg', 'manifest.webmanifest'].includes(name)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }); res.end(readFileSync(recordAsset(name)))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.locator('.wr-room-receipts button').click()
  await page.getByRole('heading', { name: 'DS-Bot 的派工与唤醒' }).waitFor({timeout: 8000}).catch(async e => { console.log(errors, await page.locator('body').innerText()); throw e })
  await page.getByText('我找到了交接设计。你能核对一下，重启后结果是否还会回到原派工人？', { exact: true }).waitFor()
  assert.equal(sends, 0)
  await rosterNames(page)
  mkdirSync('screenshots', { recursive: true })
  await page.screenshot({ path: 'screenshots/rooms-desktop.png', fullPage: true })
  await page.locator('[id="source-researcher:2"]').getByRole('button', { name: '回复此人', exact: true }).click()
  await page.getByRole('combobox').first().selectOption('engineer')
  await page.getByLabel('在讨论中发言').fill('请把重启的验证步骤也交回来。')
  await page.getByLabel('在讨论中发言').press('Control+Enter')
  const posted = page.getByRole('log', { name: '幕僚讨论原话' }).getByText('请把重启的验证步骤也交回来。', { exact: true })
  await posted.waitFor()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="在讨论中发言"]')?.value === '')
  assert.equal(sends, 1); assert.equal(events.get('engineer').at(-1).data.source.kind, 'user')
  const quoted = (await rooms.view('discussion-1')).messages.find(m => m.text === '请把重启的验证步骤也交回来。')
  assert.equal(quoted.replyTo, 'researcher:2')
  assert.ok(events.get('engineer').at(-1).data.content[0].text.includes('researcher:2'))
  await page.reload(); await posted.waitFor(); assert.equal(sends, 1)
  await page.screenshot({ path: 'screenshots/rooms-quoted-desktop.png', fullPage: true })
  const beforeCitation = await page.locator('.room-log').evaluate(el => el.scrollTop)
  await page.getByRole('button', { name: /回看引用原话/ }).focus()
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'source-researcher:2')
  await page.getByRole('button', { name: '返回刚才阅读的位置' }).focus(); await page.keyboard.press('Enter')
  assert.equal(await page.locator('.room-log').evaluate(el => el.scrollTop), beforeCitation)
  assert.match(await page.evaluate(() => document.activeElement?.textContent), /回看引用原话/)
  await page.locator('.room-note').first().getByRole('button', { name: '修订', exact: true }).click()
  await page.getByLabel('笔记正文').fill('本次需同时验证派工和唤醒，结论仍待核实。')
  await page.getByLabel('修订原因').fill('主人补充了本次范围，修正过早的摘要。')
  await page.getByRole('button', { name: '保存并引用原话', exact: true }).click()
  await page.getByText('修订原因：主人补充了本次范围，修正过早的摘要。', { exact: true }).waitFor()
  assert.equal(rooms.meta('discussion-1').notes.filter(n=>n.id==='note-1').length,2)
  const staleRestore = await page.evaluate(async session => (await fetch('/chief/api/rooms/discussion-1/restore-note', {method:'POST',headers:{'content-type':'application/json','x-chief-request':'1'},body:JSON.stringify({session,id:'note-1',version:1,target_version:1})})).status, rooms.meta('discussion-1').session)
  assert.equal(staleRestore,400)
  await page.getByRole('button', { name: '连接器', exact: true }).click()
  await page.getByRole('heading', { name: 'GitHub', exact: false }).waitFor()
  await page.screenshot({ path: 'screenshots/rooms-connectors.png', fullPage: true })
  await page.getByRole('button', { name: '讨论笔记', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '返回讨论', exact: true }).click()
  await page.screenshot({ path: 'screenshots/rooms-mobile.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await rosterNames(page)
  await page.getByRole('button', { name: '讨论笔记', exact: true }).click()
  await page.screenshot({ path: 'screenshots/rooms-mobile-notes.png', fullPage: true })
  await page.getByRole('link', { name: '回看原话', exact: true }).first().focus(); await page.keyboard.press('Enter')
  assert.ok((await page.evaluate(() => document.activeElement?.id))?.startsWith('source-'))
  await page.getByRole('button', { name: '返回刚才阅读的位置' }).click()
  await page.getByRole('button', { name: '返回讨论', exact: true }).click()
  await page.getByLabel('在讨论中发言').waitFor({ state: 'visible' })
  // Empty mobile discussions retain a usable topic creator and switcher.
  const workspaceNav = page.getByRole('navigation', { name: '工作空间导航' })
  const conversationNav = page.getByRole('navigation', { name: '会话导航' })
  const openConversations = async () => { await workspaceNav.getByRole('button', { name: '讨论', exact: true }).click(); await conversationNav.waitFor() }
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 360 ? 800 : 844 })
    await openConversations()
    await conversationNav.getByRole('button', { name: '发起新讨论', exact: true }).click()
    await page.getByLabel('新讨论标题').fill(`手机新话题 ${width}`)
    if (width === 360) {
      let lost = false
      await page.route('**/chief/api/rooms', async route => {
        if (!lost && route.request().method() === 'POST') {
          lost = true; const accepted = await route.fetch(); assert.equal(accepted.status(), 200)
          await route.fulfill({ status: 503, json: { error: '模拟回执丢失，重试原请求' } })
        } else await route.continue()
      })
      await page.getByRole('button', { name: '＋ 新讨论', exact: true }).click()
      await page.getByRole('alert').filter({hasText:'模拟回执丢失'}).waitFor()
      assert.equal(await page.getByLabel('新讨论标题').inputValue(), `手机新话题 ${width}`)
    }
    await page.getByRole('button', { name: '＋ 新讨论', exact: true }).click()
    await page.getByRole('heading', { name: `手机新话题 ${width}` }).waitFor()
    assert.equal(rooms.list().filter(r => r.title === `手机新话题 ${width}`).length, 1)
    if (width === 360) await page.unroute('**/chief/api/rooms')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await openConversations()
    await conversationNav.getByRole('button', { name: 'DS-Bot 的派工与唤醒', exact: true }).click()
    await page.getByRole('heading', { name: 'DS-Bot 的派工与唤醒' }).waitFor()
    await workspaceNav.getByRole('button', { name: '接口人', exact: true }).click()
    await page.locator('.wr-room-receipts button').click()
    await page.getByRole('heading', { name: 'DS-Bot 的派工与唤醒' }).waitFor()
    if(width===390)assert.equal(await page.getByLabel('在讨论中发言').inputValue(),'尚未发送的本机草稿')
    await page.getByLabel('在讨论中发言').fill('尚未发送的本机草稿')
    await page.locator('[id="source-researcher:2"]').getByRole('button', { name: '回复此人', exact: true }).click()
    assert.equal(await page.getByLabel('在讨论中发言').inputValue(), '尚未发送的本机草稿')
    assert.equal(await page.locator('.room-compose select').inputValue(), 'engineer')
    await page.reload()
    await page.getByLabel('在讨论中发言').waitFor()
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="在讨论中发言"]')?.value === '尚未发送的本机草稿')
    assert.equal(await page.locator('.room-compose select').inputValue(), 'engineer')
    await page.locator('.room-reply-preview').getByRole('button', { name: /引用 工程师/ }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: `screenshots/rooms-mobile-${width}.png`, fullPage: true })
    await page.locator('.room-reply-preview').getByRole('button', { name: /引用 工程师/ }).focus(); await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'source-researcher:2')
    await page.getByRole('button', { name: '返回刚才阅读的位置' }).click()
    await page.getByRole('button', { name: '取消引用' }).click()
  }
  // A full long native message survives refresh; new messages do not steal the reading position.
  const leadId = rooms.meta('discussion-1').session
  append(leadId, { kind: 'user' }, '长消息首标记' + '这是可定位的长原话。'.repeat(2200) + '长消息尾标记')
  await page.reload()
  await page.getByText(/长消息尾标记/).waitFor()
  await page.locator('.room-log').evaluate(el => { el.scrollTop = 140; el.dispatchEvent(new Event('scroll')) })
  const position = await page.locator('.room-log').evaluate(el => el.scrollTop)
  append(leadId, { kind: 'user' }, '新到消息不抢阅读位置')
  await page.getByText('新到消息不抢阅读位置', { exact: true }).waitFor()
  assert.equal(await page.locator('.room-log').evaluate(el => el.scrollTop), position)
  await page.reload()
  await page.getByText('新到消息不抢阅读位置', { exact: true }).waitFor()
  assert.equal(await page.locator('.room-log').evaluate(el => el.scrollTop), position)
  // T05: independent desktop/mobile clients reconnect by native sequence cursor.
  const second = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await second.goto(`http://127.0.0.1:${server.address().port}/#room=discussion-1`)
  await second.getByText(/长消息尾标记/).waitFor()
  const deltas = []
  for (const client of [page, second]) client.on('response', async response => {
    if (response.url().includes('/rooms/discussion-1?after=') && response.ok()) {
      const body = await response.json().catch(() => undefined)
      if (body?.incremental) deltas.push({ count: body.messages.length, cursor: body.cursor })
    }
  })
  let lostSend = false
  await page.route('**/chief/api/rooms/discussion-1**', async route => {
    if (route.request().method() === 'GET') return route.abort('internetdisconnected')
    if (!lostSend && !route.request().url().includes('/notes')) {
      lostSend = true; const accepted = await route.fetch(); assert.equal(accepted.status(), 200)
      return route.fulfill({ status: 503, json: { error: '模拟发送回执丢失' } })
    }
    await route.continue()
  })
  await second.route('**/chief/api/rooms/discussion-1**', route => route.abort('internetdisconnected'))
  await page.getByLabel('在讨论中发言').fill('双端最后请求：只接收一次')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '模拟发送回执丢失' }).waitFor()
  const acceptedSends = sends
  for (let n = 1; n <= 3; n++) append(leadId, { kind: 'user', rpcId: `offline-${n}` }, `断网期间原话 ${n}`)
  const beforeCrash = await rooms.view('discussion-1')
  writeFileSync(join(root, 'ops/room-index.json'), '{unfinished')
  writeFileSync(join(root, 'ops/room-index.json.tmp'), 'unfinished index')
  rooms.dispose(); rooms = new NativeRooms(ctx, root, () => roles)
  routes = runtimeRoutes({ rooms, connectors, engine: {}, brain: {}, roster: {} })
  assert.deepEqual((await rooms.view('discussion-1')).messages, beforeCrash.messages)
  await page.unroute('**/chief/api/rooms/discussion-1**'); await second.unroute('**/chief/api/rooms/discussion-1**')
  for (const client of [page, second]) await client.getByText('断网期间原话 3', { exact: true }).waitFor()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="在讨论中发言"]')?.value === '')
  assert.equal(sends, acceptedSends, 'retry preserves the accepted request id')
  const actual = await rooms.view('discussion-1')
  assert.equal(actual.messages.filter(m => m.text === '双端最后请求：只接收一次').length, 1)
  const snapshots = []
  for (const client of [page, second]) {
    const rows = await client.locator('.room-message').evaluateAll(nodes => nodes.map(node => ({ id: node.id.slice(7), text: node.querySelector('.md')?.textContent })))
    assert.deepEqual(rows.map(m => m.id), actual.messages.map(m => m.id))
    assert.deepEqual(rows.map(m => m.text), actual.messages.map(m => m.text))
    assert.equal(new Set(rows.map(m => m.id)).size, rows.length)
    snapshots.push(rows.map(m => ({ id: m.id, characters: m.text.length, sha256: createHash('sha256').update(m.text).digest('hex') })))
  }
  assert.ok(deltas.some(delta => delta.count > 0 && delta.count < actual.messages.length), 'actual incremental catch-up response')
  const longSource = actual.messages.find(m => m.text.startsWith('长消息首标记'))
  await rooms.note('discussion-1', { id: 'long-note', source: longSource.id, text: '长原话定位验收', category: 'pending', by: 'you' })
  await page.getByRole('button', { name: '讨论笔记', exact: true }).click()
  const longNote = page.locator('.room-note').filter({ hasText: '长原话定位验收' })
  await longNote.getByRole('link', { name: '回看原话', exact: true }).click()
  assert.equal(await page.evaluate(() => document.activeElement?.id), `source-${longSource.id}`)
  await page.getByRole('button', { name: '返回刚才阅读的位置' }).click()
  await page.getByRole('button', { name: '返回讨论', exact: true }).click()
  await page.screenshot({ path: 'screenshots/signoff-sync-mobile.png' }); await second.screenshot({ path: 'screenshots/signoff-sync-desktop.png' })
  mkdirSync('artifacts/acceptance', { recursive: true })
  writeFileSync('artifacts/acceptance/rooms-sync.json', JSON.stringify({ case: 'T05', result: '通过', host: 'deterministic host fixture with real HTTP routes and the historical record component', appSha256: createHash('sha256').update(readFileSync(recordAsset('app.js'))).digest('hex'), viewports: [[390,844],[1440,900]], replaySends: sends - acceptedSends, metadataRebuilt: true, deltas, snapshots, longSource: longSource.id }, null, 2))
  await second.close()
  // Server rejects a stale page after switching brains, even when room IDs match.
  const other = new NativeRooms(ctx, join(root, 'other-brain'), () => roles)
  await other.create('discussion-1', '另一大脑的同号讨论')
  routes = runtimeRoutes({ rooms: other, connectors, engine: {}, brain: {}, roster: {} })
  const rejected = await page.evaluate(async session => {
    const response = await fetch('/chief/api/rooms/discussion-1', { method: 'POST', headers: { 'content-type': 'application/json', 'x-chief-request': '1' }, body: JSON.stringify({ session, request_id: 'stale-request', text: '不允许串脑', to: 'lead' }) })
    return response.status
  }, leadId)
  assert.equal(rejected, 409)
  await page.reload()
  await page.getByRole('heading', { name: '另一大脑的同号讨论' }).waitFor()
  assert.equal(await page.getByLabel('在讨论中发言').inputValue(), '')
  other.dispose()
  assert.deepEqual(errors, [])
  console.log('PASS native-session projection, read-only polling, directed prompt, refresh persistence, desktop/mobile screenshots')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); rooms.dispose(); rmSync(root, { recursive: true, force: true }) }
