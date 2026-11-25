/** Dense SAA layout and evidence retention through the actual standalone mobile bundle. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { archiveWork, artifact, liaisonWork, lines, localMarker, teach } from './superhub-vertical-probe.mjs'

const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE
const evidenceFile = process.env.CHIEF_SAA_UI_EVIDENCE
const screenshotDir = process.env.CHIEF_SCREENSHOT_DIR
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { checkedAt: new Date().toISOString(), sample: 'isolated DSH, real standalone bundle, deterministic native execution', cases: [], layouts: [] }
const answers = {
  alignment: '已登记并核对两条交付记录，推进本次交付。', bottleneck: '等待主人确认当前交付。',
  coordination: '执行人等待主人验收。', drift: '界面细节留到随后统一处理。',
  nextFocus: '核对当前交付后确认是否验收。', firstStep: '打开已归档版本，核对两条记录。',
  checkpoint: { blockedOn: '当前交付待主人验收。', ruledOut: '已排除缺少第二条记录。', resumeAt: '打开复盘保存的当前交付版本。' },
}
const labels = {
  alignment: '这段时间实际推进了什么？', bottleneck: '最值得解决的卡点是什么？', coordination: '谁在等你提供什么？',
  drift: '有没有偏离原来的重点？', nextFocus: '下一段只专注哪件事？', firstStep: '前 15 分钟先做什么？',
  blockedOn: '具体卡点', ruledOut: '已排除的方向', resumeAt: '回来后第一步',
}
let host, browser, scope
let checkpoint = 'install'
const post = (path, body) => host.api(`/superhub/${path}`, { scope, requestId: randomUUID(), ...body })
const get = path => host.api(`/superhub/${path}?${new URLSearchParams({ scope })}`)
const overview = page => page.getByRole('main', { name: '工作总览', exact: true })
const button = (page, name) => overview(page).getByRole('button', { name, exact: typeof name === 'string' })
const passed = (name, fields = {}) => { result.cases.push({ name, ...fields }); console.log(`PASS ${name}`) }
async function screenshot(page, name) {
  if (!screenshotDir) return
  mkdirSync(screenshotDir, { recursive: true })
  await page.screenshot({ path: join(screenshotDir, `saa-${name}.png`) })
}

async function layout(page, name) {
  const bounds = await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const main = document.querySelector('.hub-scroll')
    const visible = element => element.getClientRects().length > 0
    const checks = [...main.querySelectorAll('input[type=checkbox]')].filter(visible).map(input => {
      const r = input.getBoundingClientRect(), label = input.parentElement, span = label.querySelector('span')
      return { width: r.width, height: r.height, labelWidth: label.clientWidth, labelScrollWidth: label.scrollWidth,
        textHeight: span?.getBoundingClientRect().height, lineHeight: span && parseFloat(getComputedStyle(span).lineHeight) }
    })
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      contentWidth: main.clientWidth, contentScrollWidth: main.scrollWidth, checks }
  })
  result.layouts.push({ name, ...bounds })
  assert.ok(bounds.documentWidth <= bounds.viewport && bounds.contentScrollWidth <= bounds.contentWidth + 1, `${name} horizontal overflow`)
  assert.ok(bounds.checks.length > 0)
  for (const check of bounds.checks) {
    assert.ok(check.width === 18 && check.height === 18, `${name} checkbox must retain its control size: ${JSON.stringify(check)}`)
    assert.ok(check.labelScrollWidth <= check.labelWidth + 1, `${name} checkbox label clips`)
    if (check.textHeight && Number.isFinite(check.lineHeight)) assert.ok(check.textHeight <= check.lineHeight + 2, `${name} checkbox text wraps vertically`)
  }
}

try {
  assert.ok(candidate && process.env.CHIEF_PLAYWRIGHT_PATH)
  result.candidateSha256 = hash(readFileSync(candidate))
  host = await acceptanceHost({ candidate, probe: 'superhub-vertical-probe.mjs', mobile: true })
  await host.start()
  scope = (await host.api('/state')).superhubScope
  const password = randomUUID()
  await host.api('/settings/password', { password })
  checkpoint = 'seed native execution'
  const said = `请检查左侧归档区 ${localMarker} 并在工单目录写入 ${artifact}。首轮写入 ${lines[0]}，审查返工后补齐 ${lines[1]}。两轮都回读并登记版本，不要部署。`
  await teach(host, said, [['chief_inbox', { ...archiveWork(), restrictions: ['不要部署'] }]])
  const receipt = await post('items', { text: said })
  const ticketId = (await liaisonWork(host, scope, receipt.id)).linked[0].items[0].ticketId
  assert.ok(ticketId)
  const mission = await until(async () => {
    const value = await get(`mission/${ticketId}`)
    return value.ticket.stage === 'you/review' && value.criteria.every(row => row.status === 'pass') ? value : undefined
  }, 'native execution and rework', 60_000)
  const current = mission.evidence.find(row => row.kind === 'delivery' && !row.historical)
  const original = mission.evidence.find(row => row.kind === 'native')
  assert.ok(current && original)
  const raw = await get('review')
  const nativeCount = raw.evidence.find(row => row.ticket.id === ticketId).evidence.filter(row => row.kind === 'native').length
  assert.ok(nativeCount >= 12, `Need a dense real native sample, received ${nativeCount}`)
  result.nativeRecords = nativeCount
  const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })
  result.browser = browser.version()
  const page = await browser.newPage({ viewport: { width: 687, height: 535 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(12_000)
  await page.goto(host.mobileBase)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '进入', exact: true }).click()
  await page.goto(`${host.mobileBase}/#superhub?${new URLSearchParams({ scope, page: 'review' })}`)
  await overview(page).getByRole('heading', { name: '新增证据与进展', exact: true }).waitFor()
  const article = overview(page).locator('.hub-review-ticket').filter({ hasText: ticketId })
  const details = article.locator('details.hub-review-observations')
  assert.equal(await details.getAttribute('open'), null)
  const nativeCheck = article.getByRole('checkbox', { name: new RegExp(original.version.slice(0, 12)) })
  const deliveryCheck = article.getByRole('checkbox', { name: new RegExp(current.version.slice(0, 12)) })
  await deliveryCheck.check()
  await details.locator('summary').click()
  await nativeCheck.check()
  for (const [width, height] of [[687, 535], [390, 844], [1259, 538], [1440, 900]]) {
    for (const theme of ['light', 'dark']) {
      checkpoint = `standalone ${width}x${height} ${theme}`
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: theme })
      await button(page, '02 看进展与阻塞').click()
      await screenshot(page, `${width}-${theme}-progress`)
      await layout(page, `${width}-${theme}-expanded`)
      // The original screenshot showed nothing but repeated rows; exercise that exact scroll position.
      await details.locator('.hub-review-evidence li').first().scrollIntoViewIfNeeded()
      await screenshot(page, `${width}-${theme}-records`)
      await details.locator('summary').click()
      await button(page, '01 确定范围').click()
      await page.locator('.hub-scroll').evaluate(node => { node.scrollTop = 0 })
      await screenshot(page, `${width}-${theme}-start`)
      await button(page, '03 填写并保存复盘').click()
      assert.equal(await overview(page).getByRole('textbox', { name: labels.bottleneck, exact: true }).evaluate(node => node === document.activeElement), true)
      assert.equal(await overview(page).locator('.hub-review-action:visible').getByRole('textbox').count(), 3)
      await screenshot(page, `${width}-${theme}-action`)
      await details.locator('summary').click()
      assert.equal(await nativeCheck.isChecked(), true)
    }
  }
  passed('dense standalone evidence, readable checkbox labels and keyboard shortcuts in eight layouts', { nativeRecords: nativeCount, viewports: [[687, 535], [390, 844], [1259, 538], [1440, 900]] })
  checkpoint = 'save real selected references'
  await page.setViewportSize({ width: 390, height: 844 })
  await details.locator('summary').click()
  await overview(page).getByText(/过程与原始记录.*已选 1 条/).waitFor()
  await button(page, '继续填写并保存复盘').click()
  assert.equal(await overview(page).locator('.hub-review-optional:visible').getAttribute('open'), null)
  await button(page, '保存校准与复工线索').click()
  await overview(page).locator('.hub-error[role="status"]').filter({ hasText: '还需填写 3 项' }).waitFor()
  assert.equal(await overview(page).getByRole('textbox', { name: labels.bottleneck, exact: true }).evaluate(node => node === document.activeElement), true)
  for (const key of ['bottleneck', 'nextFocus', 'firstStep']) await overview(page).getByRole('textbox', { name: labels[key], exact: true }).fill(answers[key])
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/chief/api/superhub/review' && response.request().method() === 'POST')
  await button(page, '保存校准与复工线索').click()
  const response = await saved
  assert.ok(response.ok())
  const { record } = await response.json()
  assert.equal(record.mode, 'compact')
  for (const key of ['alignment', 'coordination', 'drift']) assert.equal(record[key], '')
  assert.deepEqual(record.checkpoint, { blockedOn: answers.bottleneck, ruledOut: '', resumeAt: answers.firstStep })
  assert.deepEqual(record.references, [{ ticketId, evidenceId: current.id }, { ticketId, evidenceId: original.id }])
  assert.deepEqual(record.tickets, [ticketId])
  await page.reload()
  await overview(page).getByRole('heading', { name: '继续上次工作', exact: true }).waitFor()
  await overview(page).locator('.hub-checkpoint:visible').getByText('未记录', { exact: true }).waitFor()
  const savedLinks = button(page, `${ticketId} · 查看当时证据`)
  assert.equal(await savedLinks.count(), 2)
  await savedLinks.first().click()
  await overview(page).getByRole('article', { name: '交付正文' }).waitFor()
  await overview(page).locator('.hub-evidence-details:visible > summary').click()
  await overview(page).getByText(`证据版本 ${current.version}`, { exact: true }).waitFor()
  passed('collapsed observations retain exact references through save, reload and evidence navigation', { recordId: record.id, currentVersion: current.version, references: record.references })
  checkpoint = 'old draft checkpoint differences remain visible until explicitly migrated'
  const oldDraft = { ...answers, checkpoint: { blockedOn: '旧稿另记的主阻塞', ruledOut: '旧稿已排除的方向', resumeAt: '旧稿另记的复工动作' } }
  await page.evaluate(({ scope, oldDraft }) => { sessionStorage.setItem(`chief-superhub-review-draft:${scope}`, JSON.stringify(oldDraft)) }, { scope, oldDraft })
  await page.goto(`${host.mobileBase}/#superhub?${new URLSearchParams({ scope, page: 'review' })}`)
  await button(page, '03 填写并保存复盘').click()
  const migration = overview(page).getByRole('region', { name: '核对旧草稿', exact: true })
  await migration.getByText('旧线索 · 旧稿另记的主阻塞', { exact: true }).waitFor()
  await button(page, '保存校准与复工线索').click()
  await overview(page).locator('.hub-error[role="status"]').filter({ hasText: '请先核对下方旧草稿' }).waitFor()
  await migration.locator('.hub-card').filter({ hasText: '旧稿另记的主阻塞' }).getByRole('button', { name: '沿用这条旧线索', exact: true }).click()
  await migration.locator('.hub-card').filter({ hasText: '旧稿另记的复工动作' }).getByRole('button', { name: '保留当前填写', exact: true }).click()
  assert.equal(await overview(page).getByRole('textbox', { name: labels.bottleneck, exact: true }).inputValue(), oldDraft.checkpoint.blockedOn)
  const migrated = page.waitForResponse(response => new URL(response.url()).pathname === '/chief/api/superhub/review' && response.request().method() === 'POST')
  await button(page, '保存校准与复工线索').click()
  const migratedResponse = await migrated
  assert.ok(migratedResponse.ok())
  const migratedRecord = (await migratedResponse.json()).record
  assert.equal(migratedRecord.bottleneck, oldDraft.checkpoint.blockedOn)
  assert.equal(migratedRecord.checkpoint.resumeAt, oldDraft.firstStep)
  for (const key of ['alignment', 'coordination', 'drift']) assert.equal(migratedRecord[key], oldDraft[key])
  assert.equal(migratedRecord.checkpoint.ruledOut, oldDraft.checkpoint.ruledOut)
  assert.deepEqual(await page.evaluate(scope => JSON.parse(sessionStorage.getItem(`chief-superhub-review-draft:${scope}:before-compact`)), scope), oldDraft)
  await button(page, '开始新的校准').click()
  await button(page, '03 填写并保存复盘').click()
  const retainedDraft = overview(page).locator('.hub-review-optional:visible').filter({ has: page.locator('summary', { hasText: '查看迁移前的本机草稿' }) })
  await retainedDraft.locator('summary').click()
  await retainedDraft.getByText(oldDraft.checkpoint.resumeAt, { exact: true }).waitFor()
  passed('legacy draft migration requires a visible choice and retains the original local draft', { recordId: migratedRecord.id })
  assert.deepEqual(errors, [])
} catch (error) {
  result.failure = { checkpoint, message: error.message }
  console.error(`FAIL SAA dense layout at ${checkpoint}`, error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await host?.stop()
  if (evidenceFile) { mkdirSync(dirname(evidenceFile), { recursive: true }); writeFileSync(evidenceFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }) }
}
