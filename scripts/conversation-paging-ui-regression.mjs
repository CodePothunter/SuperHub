/**
 * Conversation history paging on the packaged host: the liaison dialog, a workspace group and a work order page open
 * with only the newest page, load older pages as the top comes near while the first visible message stays put, say
 * 「已经到最早的消息」 at the start, follow new messages only at the bottom, keep loaded pages across polls, and open a
 * deep link to an early message centred and highlighted with paging both ways. Desktop 1440 and phone 390.
 * A 320-message liaison archive and a 320-line group ledger are written before the host starts.
 * CHIEF_ACCEPTANCE_PACKAGE=<tgz> CHIEF_PLAYWRIGHT_PATH=<playwright/index.mjs> [CHIEF_CHROMIUM_PATH=<binary>]
 * node scripts/conversation-paging-ui-regression.mjs
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, delay, until } from './acceptance-host.mjs'
import { button, signIn } from './workspace-browser-fixture.mjs'

const area = mkdtempSync(join(tmpdir(), 'chief-conversation-paging-ui-'))
const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const HISTORY = 320
const PAGE = 40
/** Varied heights so a page is not a fixed block. */
const body = n => n % 7 === 0 ? `第 ${n} 条较长的记录：` + '这一段说明会换行，用来让消息高度各不相同。'.repeat(1 + n % 3) : n % 5 === 0 ? `第 ${n} 条\n\n- 要点一\n- 要点二` : `第 ${n} 条`

/** Walk up from the list to its scroll container and measure the first visible message. */
const MEASURE = `(${function measure([list, action]) {
  const root = document.querySelector(list)
  if (!root) return undefined
  let scroller = root
  for (; scroller; scroller = scroller.parentElement) { const o = getComputedStyle(scroller).overflowY; if (o === 'auto' || o === 'scroll') break }
  scroller ??= document.scrollingElement
  if (action === 'top') scroller.scrollTop = 0
  if (action === 'bottom') scroller.scrollTop = scroller.scrollHeight
  if (action === 'middle') scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) / 2)
  const box = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect()
  const rows = [...root.querySelectorAll('[data-message-id]')]
  const first = rows.find(row => row.getBoundingClientRect().bottom > box.top)
  const last = rows.at(-1)
  const ids = rows.map(row => row.dataset.messageId)
  return { count: rows.length, unique: new Set(ids).size, ids, first: first?.dataset.messageId, offset: first ? first.getBoundingClientRect().top - box.top : 0,
    lastVisible: !!last && last.getBoundingClientRect().bottom <= box.bottom + 2 && last.getBoundingClientRect().bottom > box.top,
    bottomGap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight, scrollTop: scroller.scrollTop,
    edge: root.querySelector('[data-history-edge="older"]')?.textContent ?? '' }
}})`
const measure = (page, list, action) => page.evaluate(`${MEASURE}(${JSON.stringify([list, action])})`)
const offsetOf = (page, list, id) => page.evaluate(([list, id]) => {
  const root = document.querySelector(list)
  let scroller = root
  for (; scroller; scroller = scroller.parentElement) { const o = getComputedStyle(scroller).overflowY; if (o === 'auto' || o === 'scroll') break }
  scroller ??= document.scrollingElement
  const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top
  const row = [...root.querySelectorAll('[data-message-id]')].find(node => node.dataset.messageId === id)
  return row ? row.getBoundingClientRect().top - top : undefined
}, [list, id])

/** Scroll to the top, wait for the older page, and check the first visible message did not move. */
async function loadOlderKeepingPlace(page, list, label) {
  const before = await measure(page, list, 'top')
  await until(async () => (await measure(page, list)).count > before.count, `${label} 自动加载更早的一页`)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const after = await offsetOf(page, list, before.first)
  const drift = Math.abs(after - before.offset)
  assert.ok(drift <= 2, `${label} 第一条可见消息 ${before.first} 偏移 ${drift}px（之前 ${before.offset}，之后 ${after}）`)
  return drift
}

/** Keep scrolling to the top until the start; returns the largest anchor drift seen. */
async function loadAll(page, list, total, label) {
  let drift = 0
  for (let guard = 0; guard < 20; guard++) {
    const now = await measure(page, list)
    if (now.edge.includes('已经到最早的消息')) break
    drift = Math.max(drift, await loadOlderKeepingPlace(page, list, label))
  }
  const end = await measure(page, list, 'top')
  assert.ok(end.edge.includes('已经到最早的消息'), `${label} 到顶提示：${end.edge}`)
  assert.equal(end.unique, end.count, `${label} 没有重复的消息`)
  assert.ok(end.count >= total, `${label} 翻到最早后应有全部 ${total} 条：${end.count}`)
  return { drift, end }
}

const firstResponse = (page, match) => page.waitForResponse(response => response.request().method() === 'GET' && match(new URL(response.url())))
  .then(async response => ({ url: new URL(response.url()), text: await response.text() }))

let browser, host
try {
  host = await acceptanceHost({ directory: area, mobile: true, probe: 'workspace-v2-probe.mjs' })
  // The liaison continues in its second part: the first part's 320 messages are in the archive.
  const base = `chief-liaison-${createHash('sha256').update(host.brain).digest('hex').slice(0, 10)}`
  const settings = JSON.parse(readFileSync(host.settingsFile, 'utf8'))
  writeFileSync(host.settingsFile, JSON.stringify({ ...settings, liaison: { session: base + '-p2', brain: host.brain, base, parts: [base] } }), { mode: 0o600 })
  const started = Date.now() - 3 * 86_400_000
  const archive = Array.from({ length: HISTORY }, (_, i) => i % 2
    ? { seq: i + 1, firstSeq: i + 1, role: 'liaison', text: '接口人' + body(i + 1), time: started + i * 300_000 }
    : { seq: i + 1, role: 'you', text: '我说' + body(i + 1), time: started + i * 300_000 })
  mkdirSync(join(host.home, 'chief', 'liaison'), { recursive: true, mode: 0o700 })
  writeFileSync(join(host.home, 'chief', 'liaison', base + '.history.json'), JSON.stringify(archive))

  await host.start()
  await host.api('/pause', { paused: true })
  const scope = (await host.api('/v2/bootstrap')).scope
  const q = '?scope=' + encodeURIComponent(scope)
  const post = (path, payload) => host.api(path + q, { ...payload, requestId: randomUUID() })
  const { workspace } = await post('/v2/workspaces', { name: '分页验收' })
  const root = '/v2/workspaces/' + encodeURIComponent(workspace.id)
  const { session: group } = await post(root + '/sessions', { title: '长群聊' })
  const { order } = await post(root + '/orders', { title: '长工单', promise: '核对长对话', sessionId: group.id })
  await host.api(root + '/sessions/' + group.id + q)
  await host.stop()
  // 320 lines from the owner and the liaison, all for the order (the order page shows them, the board tags them).
  const dialogues = join(host.brain, 'ops', 'superhub-v2-dialogues')
  const dirs = readdirSync(dialogues).flatMap(area => readdirSync(join(dialogues, area)).map(room => join(dialogues, area, room)))
  assert.equal(dirs.length, 1, '只有一场群聊')
  const lines = Array.from({ length: HISTORY }, (_, i) => JSON.stringify({ seq: i + 1, at: new Date(started + i * 300_000).toISOString(), kind: 'message',
    ...(i % 2 ? { speakerId: 'liaison', author: '接口人', text: '群里接口人' + body(i + 1) } : { speakerId: 'owner', author: '你', text: '群里我说' + body(i + 1) }),
    mentions: [], workOrderId: order.id }))
  writeFileSync(join(dirs[0], 'ledger.jsonl'), lines.join('\n') + '\n')
  await host.start()

  const legacyChat = await host.api('/chat' + q)
  assert.equal(legacyChat.messages.length, 80, '旧客户端（无分页参数）仍拿最近 80 条')
  assert.equal(legacyChat.page, undefined)
  const fullGroup = await host.api(root + '/sessions/' + group.id + q)
  const groupTotal = fullGroup.messages.length
  assert.ok(groupTotal >= HISTORY, `群聊全量 ${groupTotal} 条`)
  const password = randomUUID()
  await host.api('/settings/password', { password })
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH && { executablePath: process.env.CHIEF_CHROMIUM_PATH }) })

  const viewports = [
    { label: 'desktop 1440', viewport: { width: 1440, height: 900 }, phone: false },
    { label: 'phone 390', viewport: { width: 390, height: 844 }, phone: true },
  ]
  let liaisonSent = 0
  for (const { label, viewport, phone } of viewports) {
    const page = await browser.newPage({ viewport, locale: 'zh-CN', ...(phone && { isMobile: true, hasTouch: true }) })
    page.setDefaultTimeout(20_000)
    const origin = phone ? host.mobileBase : host.base
    if (phone) {
      await page.goto(host.mobileBase)
      await page.getByLabel('密码').fill(password)
      await button(page, '进入').click()
      await page.getByRole('heading', { name: '今天', exact: true }).waitFor()
    } else await signIn(page, host)
    // A fresh load each time, so the deep link is the page's first read.
    const go = async route => { await page.goto('about:blank'); await page.goto(origin + '/#v2?' + new URLSearchParams({ scope, ...route })) }

    // ── Liaison dialog ──
    await go({ view: 'today' })
    await page.getByRole('heading', { name: '我的工作区', exact: true }).or(page.getByRole('heading', { name: '今天', exact: true })).first().waitFor()
    const firstChat = firstResponse(page, url => /\/chat$/.test(url.pathname))
    await page.getByRole('button', { name: /^一句话交办(，|$)/ }).first().click()
    const chat = await firstChat
    const chatView = JSON.parse(chat.text)
    assert.equal(chat.url.searchParams.get('limit'), String(PAGE))
    assert.equal(chatView.messages.length, PAGE, '接口人首个响应只含最近一页')
    assert.deepEqual(chatView.page, { older: true, newer: false })
    const liaisonList = '.v2-liaison-history'
    await until(async () => (await measure(page, liaisonList))?.count >= PAGE, '接口人最近一页')
    const opened = await measure(page, liaisonList)
    assert.ok(opened.bottomGap < 80 && opened.lastVisible, `接口人打开时停在最新：${JSON.stringify({ gap: opened.bottomGap })}`)
    const liaison = await loadAll(page, liaisonList, HISTORY + liaisonSent, `${label} 接口人`)
    console.log(`PASS ${label} liaison first response ${chatView.messages.length} messages (${chat.text.length} bytes of ${HISTORY + liaisonSent}), loaded ${liaison.end.count}, max anchor drift ${liaison.drift.toFixed(2)}px`)

    // Reading further up: a new message does not pull the view back.
    const reading = await measure(page, liaisonList, 'middle')
    await host.api('/chat', { text: `翻阅时来的新消息 ${label}` })
    liaisonSent += 2
    await until(async () => (await page.locator(liaisonList).innerText()).includes(`翻阅时来的新消息 ${label}`), '翻阅时新消息到达', 30_000)
    const stayed = await offsetOf(page, liaisonList, reading.first)
    assert.ok(Math.abs(stayed - reading.offset) <= 2, `翻阅时新消息不拉回底部：${reading.offset} → ${stayed}`)
    // At the bottom: the next message is followed.
    await measure(page, liaisonList, 'bottom')
    await host.api('/chat', { text: `停在底部时的新消息 ${label}` })
    liaisonSent += 2
    await until(async () => (await page.locator(liaisonList).innerText()).includes(`停在底部时的新消息 ${label}`), '底部新消息到达', 30_000)
    await until(async () => { const now = await measure(page, liaisonList); return now.bottomGap < 80 && now.lastVisible }, '停在底部时跟随新消息')
    // Two idle polls later the older pages are still there, once each.
    const kept = await measure(page, liaisonList)
    await delay(13_000)
    const polled = await measure(page, liaisonList)
    assert.ok(polled.count >= kept.count && polled.unique === polled.count, `轮询后旧页不丢不重：${kept.count} → ${polled.count}/${polled.unique}`)
    assert.ok(polled.ids.slice(0, 5).every((id, i) => id === kept.ids[i]), '最早的几条仍在')
    console.log(`PASS ${label} liaison follows at the bottom, stays while reading, keeps ${polled.count} rows across polls`)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '接口人' }).waitFor({ state: 'detached' })

    // ── Group conversation ──
    const history = '.v2-chat-history'
    const isSession = url => url.pathname.endsWith('/sessions/' + group.id)
    let firstRead = firstResponse(page, isSession)
    await go({ view: 'workspace', workspace: workspace.id, panel: 'execution', session: group.id })
    let read = await firstRead
    let readView = JSON.parse(read.text)
    assert.equal(read.url.searchParams.get('limit'), String(PAGE))
    assert.equal(readView.messages.length, PAGE, '群聊首个响应只含最近一页')
    assert.equal(readView.page.older, true)
    await until(async () => (await measure(page, history))?.count >= PAGE, '群聊最近一页')
    await until(async () => (await measure(page, history)).lastVisible, '群聊打开时最新一条可见')
    const groupAll = await loadAll(page, history, groupTotal, `${label} 群聊`)
    console.log(`PASS ${label} group first response ${readView.messages.length} messages (${read.text.length} bytes of ${groupTotal}), loaded ${groupAll.end.count}, max anchor drift ${groupAll.drift.toFixed(2)}px`)
    // Polls keep the loaded pages; a new line while reading leaves the view; at the bottom it is followed.
    const groupReading = await measure(page, history, 'middle')
    await post(root + '/sessions/' + group.id + '/messages', { text: `群里翻阅时的新话 ${label}`, wait: false })
    await until(async () => (await page.locator(history).innerText()).includes(`群里翻阅时的新话 ${label}`), '群里新话到达')
    const groupStayed = await offsetOf(page, history, groupReading.first)
    assert.ok(Math.abs(groupStayed - groupReading.offset) <= 2, `群聊翻阅时不被拉回：${groupReading.offset} → ${groupStayed}`)
    const afterPolls = await measure(page, history)
    assert.ok(afterPolls.count >= groupAll.end.count && afterPolls.unique === afterPolls.count, '群聊轮询后旧页不丢不重')
    await page.evaluate(() => { const rows = document.querySelectorAll('.v2-chat-history [data-message-id]'); rows[rows.length - 1].scrollIntoView({ block: 'end' }) })
    await post(root + '/sessions/' + group.id + '/messages', { text: `群里停在底部的新话 ${label}`, wait: false })
    await until(async () => (await page.locator(history).innerText()).includes(`群里停在底部的新话 ${label}`), '群里底部新话到达')
    await until(async () => (await measure(page, history)).lastVisible, '群聊停在底部时跟随新消息')
    console.log(`PASS ${label} group follows at the bottom, stays while reading, keeps ${afterPolls.count} rows across polls`)

    // Deep link to the 10th line: centred and highlighted, then older is the start and newer pages load downwards.
    firstRead = firstResponse(page, isSession)
    await go({ view: 'workspace', workspace: workspace.id, panel: 'execution', session: group.id, message: 'g-10' })
    read = await firstRead
    assert.equal(read.url.searchParams.get('around'), 'g-10', '深链接首个响应以该消息为中心')
    const target = page.locator('li.v2-source-turn[data-message-id="g-10"]')
    await target.waitFor()
    await until(async () => target.evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight }), '深链接消息在视口内')
    const linked = await measure(page, history)
    assert.ok(linked.edge.includes('已经到最早的消息') || linked.ids[0] === 'g-1', '第 10 条所在的一页从第一条开始')
    await measure(page, history, 'bottom')
    await until(async () => (await measure(page, history)).count > linked.count, '深链接后向下加载更新的一页')
    console.log(`PASS ${label} deep link g-10 highlighted; newer pages load downwards (${linked.count} → ${(await measure(page, history)).count})`)
    // A deep link in the middle pages both ways.
    firstRead = firstResponse(page, isSession)
    await go({ view: 'workspace', workspace: workspace.id, panel: 'execution', session: group.id, message: 'g-150' })
    assert.equal((await firstRead).url.searchParams.get('around'), 'g-150')
    await page.locator('li.v2-source-turn[data-message-id="g-150"]').waitFor()
    const middleDrift = await loadOlderKeepingPlace(page, history, `${label} 深链接向上`)
    const middle = await measure(page, history, 'bottom')
    await until(async () => (await measure(page, history)).count > middle.count, '深链接中段向下加载')
    await button(page, '跳到最新').click()
    await until(async () => { const now = await measure(page, history); return now.lastVisible && now.ids.includes(`g-${HISTORY}`) }, '跳到最新')
    console.log(`PASS ${label} deep link g-150 loads older (drift ${middleDrift.toFixed(2)}px) and newer, 跳到最新 returns to the newest`)

    // ── Work order page (the order's own conversation) ──
    const orderRead = firstResponse(page, isSession)
    await go({ view: 'workspace', workspace: workspace.id, order: order.id })
    const orderView = await orderRead
    assert.equal(JSON.parse(orderView.text).messages.length, PAGE, '工单对话首个响应只含最近一页')
    await until(async () => (await measure(page, history))?.count >= PAGE, '工单对话最近一页')
    await until(async () => (await measure(page, history)).lastVisible, '工单对话打开时最新一条可见')
    const orderDrift = await loadOlderKeepingPlace(page, history, `${label} 工单对话`)
    const orderLink = firstResponse(page, isSession)
    await go({ view: 'workspace', workspace: workspace.id, order: order.id, message: 'g-10' })
    assert.equal((await orderLink).url.searchParams.get('around'), 'g-10')
    await page.locator('li.v2-source-turn[data-message-id="g-10"]').waitFor()
    console.log(`PASS ${label} order page first response ${PAGE} messages, anchor drift ${orderDrift.toFixed(2)}px, deep link g-10 highlighted`)
    await page.close()
  }

  // ── A choice still waiting for the owner, further up than the loaded page ──
  // 「可以验收了」 on an order is read by the liaison (the fixture model gives no reading, so it is held for the owner's
  // choice); later lines push the liaison's note with its choices out of the newest page.
  const { session: held } = await post(root + '/sessions', { title: '待选择的群聊' })
  const { order: heldOrder } = await post(root + '/orders', { title: '待选择的工单', promise: '核对选择', sessionId: held.id })
  const heldPath = root + '/sessions/' + held.id
  await post(heldPath + '/messages', { text: '可以验收了', workOrderId: heldOrder.id, wait: false })
  const note = await until(async () => (await host.api(heldPath + q)).messages.find(row => row.actions?.some(action => !action.done)), '接口人给出收单选项')
  for (let i = 1; i <= 45; i++) await post(heldPath + '/messages', { text: `后来的一句话 ${i}`, wait: false })
  await until(async () => { const view = await host.api(heldPath + q + '&limit=40'); return !view.messages.some(row => row.id === note.id) && view.pinned?.some(row => row.id === note.id) }, '选项所在的消息不在最新一页')
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  page.setDefaultTimeout(20_000)
  await signIn(page, host)
  await page.goto(host.base + '/#v2?' + new URLSearchParams({ scope, view: 'workspace', workspace: workspace.id, panel: 'execution', session: held.id }))
  const block = page.locator('section.v2-pending-elsewhere')
  await block.locator(`[data-pending-for="${note.id}"]`).waitFor()
  assert.equal(await page.locator(`.v2-chat-history li[data-message-id="${note.id}"]`).count(), 0, '原话不在已加载的消息里')
  assert.equal(await page.getByRole('button', { name: '继续交给执行者', exact: true }).count(), 1, '选项只出现一次（在末尾的「等你处理」里）')
  const blockBox = await block.boundingBox(), composeBox = await page.locator('.v2-reader .v2-compose').boundingBox()
  assert.ok(blockBox && composeBox && blockBox.y + blockBox.height <= composeBox.y + 1, '「等你处理」在对话末尾、输入区上方')
  await button(block, '定位到原话').click()
  const row = page.locator(`.v2-chat-history li[data-message-id="${note.id}"]`)
  await row.waitFor()
  await until(async () => row.evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight }), '定位后原话在视口内')
  await until(async () => await block.count() === 0, '原话加载后「等你处理」不再重复显示')
  assert.equal(await page.getByRole('button', { name: '继续交给执行者', exact: true }).count(), 1, '选项回到原话下，只出现一次')
  assert.equal(await row.getByRole('button', { name: '继续交给执行者', exact: true }).count(), 1)
  console.log(`PASS pending choice on ${note.id} outside the newest page stands above the composer, 定位到原话 loads it and moves the choice inline`)
  await page.close()
  console.log('PASS conversation paging regression')
} finally {
  await browser?.close()
  await host?.dispose()
  rmSync(area, { recursive: true, force: true })
}
