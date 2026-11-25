/** Packaged result receipt -> readable document / historical work view, on the real mobile gateway. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileStore } from '../src/core/store.ts'
import { snapshotOutputs } from '../src/dsh/deliveries.ts'
import { acceptanceHost, until } from './acceptance-host.mjs'

const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE
const evidenceFile = process.env.CHIEF_RESULT_UI_EVIDENCE
const screenshotDir = process.env.CHIEF_SCREENSHOT_DIR
const proof = { checkedAt: new Date().toISOString(), cases: [], sample: 'real packaged DSH, persisted work fixtures, standalone mobile gateway' }
const passed = (name, detail = {}) => { proof.cases.push({ name, ...detail }); console.log(`PASS ${name}`) }
let host, browser, checkpoint = 'create isolated host'
try {
  assert.ok(candidate && process.env.CHIEF_PLAYWRIGHT_PATH)
  proof.candidateSha256 = createHash('sha256').update(readFileSync(candidate)).digest('hex')
  host = await acceptanceHost({ candidate, mobile: true })
  const store = new FileStore(host.brain)
  const now = Date.now(), at = offset => new Date(now + offset).toISOString()
  const role = { id: 'engineer', name: '工程师', executor: 'dsh', verifier: 'none', brief: '本地执行' }
  const makeTicket = (id, title, age, file, review = false) => {
    const time = at(-age), assignmentId = randomUUID()
    if (file) {
      mkdirSync(join(host.brain, 'work', id), { recursive: true })
      writeFileSync(join(host.brain, 'work', id, file), '# 客户访谈结论\n\n三份记录的日期一致。\n\n- 本周结果已整理\n- 保留原始引用以便核对\n')
    }
    const path = file && `work/${id}/${file}`
    const deliveries = path ? snapshotOutputs(host.brain, id, [path]) : []
    const ticket = { id, title, staff: role.id, threadId: `thread-${id}`, createdAt: time, priority: 1, events: [id], inputs: [],
      mandate: { eventId: id, strength: 'explicit', level: 'think', scope: title, doneWhen: ['核对结果'], needsReview: review },
      assignments: [{ id: assignmentId, staff: role.id, executor: role.executor, role, round: 0, state: 'reported', startedAt: time, endedAt: time,
        report: { status: 'ready', structured: true, summary: file ? '三份记录的日期一致。' : '已核对，无需调整现有安排。', outputs: path ? [path] : [] }, deliveries,
        verification: { verdict: 'pass', critique: '旧工单按原配置跳过', status: 'skipped' }, verifiedAt: time }],
      ...review ? {} : { ended: { at: time, outcome: 'done', note: '本次工作办结' } } }
    store.appendEvent({ id, source: 'inbox', dedupe: id, at: time, text: title })
    store.setDisposition(id, { kind: 'accepted', ticketId: id })
    store.saveTicket(ticket)
    return ticket
  }
  const document = makeTicket('T-0001', '核对客户访谈结论', 60_000, 'research.md')
  const summary = makeTicket('T-0002', '确认本周安排', 120_000)
  const review = makeTicket('T-0003', '等待主人确认的方案', 180_000, 'proposal.md', true)
  makeTicket('T-0004', '很久以前的工作', 72 * 3600_000, 'old.md')
  await host.start()
  await host.api('/pause', { paused: true })
  checkpoint = 'read persisted notices'
  const notices = await until(async () => {
    const value = await host.api('/chat')
    return value.notices.some(row => row.ticketId === document.id && row.kind === 'result') ? value.notices : undefined
  }, '已完成结果进入接口人')
  const documentNotice = notices.find(row => row.ticketId === document.id)
  const reviewNotice = notices.find(row => row.ticketId === review.id)
  assert.ok(documentNotice.delivery?.version)
  assert.ok(reviewNotice?.delivery?.version)
  assert.ok(notices.find(row => row.ticketId === summary.id && row.kind === 'result' && !row.delivery))
  assert.ok(!notices.some(row => row.ticketId === 'T-0004'))
  const rawOutbox = JSON.parse(readFileSync(join(host.brain, 'ops/outbox.json'), 'utf8'))
  assert.ok(rawOutbox.filter(row => row.kind === 'result').every(row => row.push === 'local'))
  passed('recent document and fileless completions appear once; acceptance receipt has its document; old archive stays quiet')

  // A later attempt changes the current work, but an earlier receipt must keep its own result and bytes.
  await host.stop()
  const later = at(-15_000)
  writeFileSync(join(host.brain, documentNotice.delivery.path), '# 返工后的新版本\n\n新增日期尚待复核。\n')
  store.saveTicket({ ...document, ended: undefined, assignments: [...document.assignments, {
    id: randomUUID(), staff: role.id, executor: role.executor, role, round: 1, state: 'reported', startedAt: later, endedAt: later,
    report: { status: 'failed', structured: true, summary: '新增日期尚待复核。', outputs: [documentNotice.delivery.path] },
    deliveries: snapshotOutputs(host.brain, document.id, [documentNotice.delivery.path]),
  }] })
  await host.start()
  const changedNotice = (await host.api('/chat')).notices.find(row => row.key === documentNotice.key)
  assert.deepEqual(changedNotice.delivery, documentNotice.delivery)
  assert.ok(changedNotice.status.includes('当前'))

  const password = randomUUID()
  await host.api('/settings/password', { password })
  const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })
  proof.chromium = browser.version()
  for (const width of [1440, 390]) {
    checkpoint = `standalone ${width}`
    const page = await browser.newPage({ viewport: { width, height: 844 } })
    page.setDefaultTimeout(15_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.mobileBase)
    await page.getByLabel('密码').fill(password)
    await page.getByRole('button', { name: '进入' }).click()
    const card = page.locator('.wr-msg.notice.result').filter({ hasText: document.title })
    await card.waitFor()
    assert.ok(!(await card.innerText()).includes('work/'))
    const readDocument = card.getByRole('button', { name: '阅读交付', exact: true })
    await readDocument.click()
    const reader = page.getByRole('dialog', { name: '阅读器' })
    await reader.getByRole('heading', { name: '客户访谈结论', exact: true }).waitFor()
    const address = new URLSearchParams(new URL(page.url()).hash.split('?')[1])
    assert.equal(address.get('version'), documentNotice.delivery.version)
    assert.equal(address.get('path'), documentNotice.delivery.path)
    await reader.getByRole('button', { name: '关闭', exact: true }).click()
    await until(() => readDocument.evaluate(element => element === document.activeElement), '关闭阅读器后回到原交付按钮')
    const openResult = card.getByRole('button', { name: '查看结果', exact: true })
    await openResult.focus()
    const sourceScroll = await page.locator('.wr-msgs').evaluate(element => element.scrollTop)
    await openResult.press('Enter')
    const overview = page.getByRole('main', { name: '工作总览' })
    await overview.getByRole('heading', { name: document.title, exact: true }).waitFor()
    const workAddress = new URLSearchParams(new URL(page.url()).hash.split('?')[1])
    assert.equal(workAddress.get('page'), 'mission')
    assert.equal(workAddress.get('at'), documentNotice.at)
    const result = overview.locator('.hub-mission-result:visible')
    await result.getByText('三份记录的日期一致。', { exact: true }).waitFor()
    assert.equal(await result.getByText('新增日期尚待复核。', { exact: true }).count(), 0)
    assert.equal(await overview.locator('.hub-timeline:visible').getAttribute('open'), null)
    assert.equal(await overview.getByRole('heading', { name: '当前工单操作', exact: true }).count(), 0)
    assert.ok(await result.evaluate(element => {
      const bounds = element.getBoundingClientRect(), scroller = element.closest('.hub-scroll').getBoundingClientRect()
      return bounds.top >= scroller.top - 2 && bounds.top < scroller.bottom
    }), 'Historical result entry must stay at the result, not scroll down to diagnostics')
    await result.getByRole('button', { name: '查看结果 · research.md', exact: true }).click()
    await overview.getByRole('article', { name: '交付正文' }).getByRole('heading', { name: '客户访谈结论', exact: true }).waitFor()
    assert.equal(await overview.getByRole('heading', { name: '返工后的新版本', exact: true }).count(), 0)
    await overview.getByRole('button', { name: '返回', exact: true }).click()
    await overview.getByRole('button', { name: '返回接口人', exact: true }).click()
    await until(() => openResult.evaluate(element => element === document.activeElement), '返回接口人后焦点回到原结果按钮')
    assert.ok(Math.abs(await page.locator('.wr-msgs').evaluate(element => element.scrollTop) - sourceScroll) <= 2,
      'Returning from a result must retain the liaison reading position')
    const history = page.locator('.wr-notice-history')
    if (await history.count()) await history.locator(':scope > summary').click()
    const summaryCard = page.locator('.wr-msg.notice.result').filter({ hasText: summary.title })
    await summaryCard.getByRole('button', { name: '查看结果', exact: true }).click()
    await overview.getByRole('heading', { name: summary.title, exact: true }).waitFor()
    await overview.locator('.hub-mission-result:visible').getByText('已核对，无需调整现有安排。', { exact: true }).waitFor()
    assert.equal(await overview.locator('.hub-timeline:visible').getAttribute('open'), null)
    await overview.getByRole('button', { name: '返回接口人', exact: true }).click()
    const decision = page.locator('.wr-msg.notice').filter({ hasText: review.title })
    await decision.getByRole('button', { name: '查看并验收', exact: true }).click()
    await overview.getByRole('heading', { name: review.title, exact: true }).waitFor()
    assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).has('at'), false)
    await overview.getByRole('button', { name: '返回接口人', exact: true }).click()
    const workspaceNav = page.getByRole('navigation', { name: width < 761 ? '工作空间导航' : '会话导航', exact: true })
    await until(async () => await workspaceNav.getByRole('button', { name: /^接口人/ }).getAttribute('aria-current') === 'page'
      && new URL(page.url()).hash === '', '返回接口人后导航与主内容一致')
    assert.equal(await workspaceNav.getByRole('button', { name: /^工作总览/ }).getAttribute('aria-current'), null)
    await workspaceNav.evaluate(async element => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))
    })
    if (screenshotDir) { mkdirSync(screenshotDir, { recursive: true }); await page.screenshot({ path: join(screenshotDir, `result-receipts-${width}.png`) }) }
    assert.deepEqual(errors, [])
    passed(`${width}px standalone receipt opens exact document, fileless result and current decision`, { nativeErrors: 0 })
    await page.close()
  }
  checkpoint = 'restart idempotence'
  await host.stop()
  await host.start()
  const restarted = (await host.api('/chat')).notices
  assert.deepEqual(restarted.filter(row => row.key === documentNotice.key), [changedNotice])
  assert.equal(restarted.filter(row => row.ticketId === document.id && row.kind === 'result').length, 1)
  assert.equal(restarted.filter(row => row.ticketId === summary.id).length, 1)
  passed('same receipts and version targets survive host restart without repeated result announcements')
  proof.completed = true
} catch (error) {
  proof.failure = { checkpoint, message: error.message }
  console.error(`FAIL result receipt at ${checkpoint}`, error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await host?.stop()
  if (evidenceFile) { mkdirSync(dirname(evidenceFile), { recursive: true }); writeFileSync(evidenceFile, JSON.stringify(proof, null, 2) + '\n') }
}
