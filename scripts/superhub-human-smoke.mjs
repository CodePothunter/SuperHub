/** Automated preflight only; every browser is recorded as automation, never as a human participant. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const base = process.env.CHIEF_STUDY_URL ?? 'http://127.0.0.1:50390'
const code = readFileSync(process.env.CHIEF_STUDY_ACCESS_FILE, 'utf8').trim()
const reportPath = process.env.CHIEF_STUDY_REPORT
const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHIEF_CHROMIUM_PATH })
const contexts = []
const results = []
const screenshots = []
const pass = name => { results.push(name); console.log('PASS ' + name) }
const report = () => JSON.parse(readFileSync(reportPath, 'utf8'))
const latest = () => report().runs.at(-1)
const activeFrame = page => page.frameLocator('#frame')
const captureNarrow = async (page, name, position) => {
  const viewport = page.viewportSize()
  try {
    await page.setViewportSize({ width: 390, height: 844 })
    if (position) await position()
    const path = join(dirname(reportPath), name)
    await page.screenshot({ path })
    screenshots.push(path)
    console.log('SCREENSHOT automated 390px preview ' + path)
  } finally { await page.setViewportSize(viewport) }
}
const post = (page, path, data) => page.evaluate(async ({ path, data }) => {
  const response = await fetch('/study/' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-study-request': '1' }, body: JSON.stringify(data) })
  return { status: response.status, data: await response.json() }
}, { path, data })

try {
  assert.equal((await fetch(base + '/chief/api/state')).status, 401)
  const create = async (device, viewport) => {
    const context = await browser.newContext({ viewport })
    contexts.push(context)
    const page = await context.newPage()
    await page.goto(base)
    await page.getByLabel('主持人提供的访问口令').fill(code)
    await page.getByRole('button', { name: '进入', exact: true }).click()
    await page.getByLabel('参与者代号', { exact: true }).fill('automated-preflight')
    await page.getByLabel('这是什么设备？').selectOption(device)
    await page.getByLabel('用过 SuperHub 吗？').selectOption('new')
    await page.getByLabel('这是一台实际设备，不是浏览器的手机模拟').check()
    await page.getByRole('button', { name: '准备好了', exact: true }).click()
    await page.getByRole('button', { name: '快速定位', exact: true }).waitFor()
    assert.equal(report().participants.at(-1).automation, true)
    const cookies = await context.cookies()
    assert.equal(cookies.length, 1)
    assert.equal(cookies[0].name, 'chief_human_acceptance')
    return page
  }
  const desktop = await create('desktop', { width: 1440, height: 1000 })
  assert.equal((await desktop.evaluate(async () => (await fetch('/study/prepare', { method: 'POST', body: '{}' })).status)), 403)
  assert.equal((await desktop.evaluate(async () => (await fetch('/chief/api/settings')).status)), 403)
  assert.equal((await desktop.evaluate(async () => (await fetch('/chief/api/%73ettings')).status)), 403)
  assert.equal((await desktop.evaluate(async () => (await fetch('/chief/api/tickets/T-0001/execution-plan')).status)), 403)
  pass('independent authentication, request marker and blocked settings')
  await desktop.getByRole('button', { name: '快速定位', exact: true }).click()
  await desktop.getByRole('button', { name: '开始练习', exact: true }).waitFor({ timeout: 90_000 })
  assert.equal(await desktop.locator('#frame').getAttribute('src'), null)
  const task = latest()
  assert.equal(task.scenario.fixtureVersion, 'customer-records-v1')
  assert.ok(!await desktop.locator('#home').textContent().then(text => text.includes(task.scenario.expected.owner)))
  await desktop.getByRole('button', { name: '开始练习', exact: true }).click()
  await desktop.waitForFunction(() => document.querySelector('#timer').textContent === '0:00')
  await activeFrame(desktop).getByRole('heading', { name: task.scenario.goalName, exact: true }).waitFor()
  await desktop.getByRole('button', { name: '填写答案', exact: true }).click()
  await desktop.getByLabel('目标的负责人是谁？').fill('自动化预检回答')
  await desktop.getByLabel('目标还被哪项条件卡住？').fill('自动化预检回答')
  await desktop.getByLabel('关联工单在等谁做什么？').fill('自动化预检回答')
  await desktop.getByRole('button', { name: '提交本次记录', exact: true }).click()
  await desktop.getByRole('heading', { name: '本次操作已记录' }).waitFor()
  assert.equal(latest().status, 'completed')
  assert.equal(latest().manualReviewRequired, true)
  pass('hidden scenario, click start and honest manual-review timing record')

  await desktop.getByRole('button', { name: '回到练习选择', exact: true }).click()
  await desktop.getByRole('button', { name: '五分钟局势校准', exact: true }).click()
  await desktop.getByRole('button', { name: '开始练习', exact: true }).waitFor({ timeout: 90_000 })
  const reviewTask = latest()
  await desktop.getByRole('button', { name: '开始练习', exact: true }).click()
  await desktop.waitForFunction(() => document.querySelector('#timer').textContent === '0:00')
  const app = activeFrame(desktop)
  await app.getByRole('heading', { name: reviewTask.scenario.goalName, exact: true }).waitFor()
  await captureNarrow(desktop, 'automated-goal-390.png')
  await app.getByRole('button', { name: '开始复盘', exact: true }).click()
  await app.locator('.hub-review-goals').getByRole('button', { name: reviewTask.scenario.goalName, exact: true }).waitFor()
  const reviewHash = await app.locator('main[aria-label="工作总览"]').evaluate(() => location.hash)
  const reviewParams = new URLSearchParams(reviewHash.split('?')[1])
  assert.equal(reviewParams.get('page'), 'review')
  assert.equal(reviewParams.get('goal'), reviewTask.scenario.goalId)
  assert.equal(reviewParams.get('scope'), reviewTask.scenario.scope)
  const ev = app.getByRole('button', { name: new RegExp('已归档交付版本.*当前版本 ' + reviewTask.scenario.evidenceVersion.slice(0, 12)) })
  await ev.click()
  await app.getByRole('article', { name: '交付正文' }).getByText('晨光商贸：交付范围已核对，客户登记完整。', { exact: true }).waitFor()
  await app.getByRole('article', { name: '交付正文' }).getByText('远航科技：交付范围已核对，客户登记完整。', { exact: true }).waitFor()
  await app.getByRole('button', { name: '返回', exact: true }).click()
  await app.getByRole('checkbox', { name: new RegExp('保留证据 已归档交付版本 当前版本 ' + reviewTask.scenario.evidenceVersion.slice(0, 12)) }).check()
  await app.getByRole('button', { name: '继续填写并保存复盘', exact: true }).click()
  assert.equal(await app.getByLabel('最值得解决的卡点是什么？', { exact: true }).evaluate(node => node === document.activeElement), true)
  await captureNarrow(desktop, 'automated-compact-review-390.png', () => app.getByRole('button', { name: '继续填写并保存复盘', exact: true }).click())
  const answers = {
    bottleneck: '自动化预检卡点：仅验证原样保存，不作为真人正确理解的证据。',
    nextFocus: '自动化预检重点：核对这一条独立输入的保存与重开。',
    firstStep: '自动化预检第一步：核对这段文字被复用于复工第一步。',
    alignment: '自动化预检进展：保留可选成果说明的完整原文。',
    coordination: '自动化预检协同：保留可选等待方说明的完整原文。',
    drift: '自动化预检偏离：保留可选偏航判断的完整原文。',
    ruledOut: '自动化预检排除方向：保留第三条复工线索的完整原文。',
  }
  for (const [field, label] of [['bottleneck', '最值得解决的卡点是什么？'], ['nextFocus', '下一段只专注哪件事？'], ['firstStep', '前 15 分钟先做什么？']]) {
    await app.getByLabel(label, { exact: true }).fill(answers[field])
  }
  const optional = app.locator('details').filter({ has: app.locator('summary').filter({ hasText: /^补充复盘（可选）$/ }) })
  assert.equal(await optional.getAttribute('open'), null)
  await optional.locator('summary').click()
  for (const [field, label] of [['alignment', '这段时间实际推进了什么？'], ['coordination', '谁在等你提供什么？'], ['drift', '有没有偏离原来的重点？'], ['ruledOut', '已排除的方向']]) {
    assert.equal(await optional.getByLabel(label, { exact: true }).inputValue(), '')
    await optional.getByLabel(label, { exact: true }).fill(answers[field])
  }
  await app.getByRole('button', { name: '保存校准与复工线索', exact: true }).click()
  await desktop.getByRole('heading', { name: '本次操作已记录' }).waitFor()
  assert.equal(latest().status, 'completed')
  assert.equal(latest().structure.exactEvidence, true)
  assert.equal(latest().structure.openedExactEvidence, true)
  assert.equal(latest().structure.selectedGoal, true)
  assert.equal(latest().structure.checkpointPresent, true)
  assert.ok(latest().savedRecord.id)
  const saved = latest().savedRecord
  assert.equal(saved.mode, 'compact')
  assert.deepEqual(saved.goals, [{ id: reviewTask.scenario.goalId, version: reviewTask.scenario.goalVersion }])
  for (const field of ['alignment', 'bottleneck', 'nextFocus', 'firstStep', 'coordination', 'drift']) assert.equal(saved[field], answers[field])
  assert.deepEqual(saved.checkpoint, { blockedOn: answers.bottleneck, ruledOut: answers.ruledOut, resumeAt: answers.firstStep })
  pass('goal entry, real compact SAA save, exact evidence, original answers and elapsed-time capture')

  await desktop.getByRole('button', { name: '开始复工练习', exact: true }).click()
  await desktop.getByRole('button', { name: '开始练习', exact: true }).click()
  await desktop.waitForFunction(() => document.querySelector('#timer').textContent === '0:00')
  await app.getByRole('heading', { name: '继续上次工作', exact: true }).waitFor()
  const restored = app.locator('section').filter({ has: app.getByRole('heading', { name: '继续上次工作', exact: true }) })
  for (const [label, value] of [['具体卡点', answers.bottleneck], ['已排除的方向', answers.ruledOut], ['回来后第一步', answers.firstStep]]) {
    assert.equal(await restored.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }).locator('..').locator('dd').textContent(), value)
  }
  await restored.getByRole('button', { name: `${reviewTask.scenario.goalName} · v${reviewTask.scenario.goalVersion}`, exact: true }).waitFor()
  await restored.locator('summary').filter({ hasText: /^完整复盘$/ }).click()
  for (const [field, label] of [['alignment', '这段时间实际推进了什么？'], ['bottleneck', '最值得解决的卡点是什么？'], ['coordination', '谁在等你提供什么？'], ['drift', '有没有偏离原来的重点？']]) {
    assert.equal(await restored.locator('dt').filter({ hasText: label }).locator('..').locator('dd').textContent(), answers[field])
  }
  await app.getByRole('button', { name: reviewTask.scenario.ticketId + ' · 查看当时证据', exact: true }).click()
  await desktop.getByRole('button', { name: '记录第一步', exact: true }).click()
  await desktop.getByLabel('回来后你会从哪一步继续？').fill('自动化预检复工回答')
  await desktop.getByRole('button', { name: '提交本次记录', exact: true }).click()
  await desktop.getByRole('heading', { name: '本次操作已记录' }).waitFor()
  assert.equal(latest().kind, 'resume')
  assert.equal(latest().structure.openedExactEvidence, true)
  assert.equal(latest().answers.resumeAt, '自动化预检复工回答')
  pass('saved review and exact evidence can be reopened with a separate resume timer')

  await desktop.getByRole('button', { name: '回到练习选择', exact: true }).click()
  await desktop.getByRole('button', { name: '两台设备同步', exact: true }).click()
  await desktop.getByRole('button', { name: '采集本机时间', exact: true }).click()
  await desktop.getByText(/已采集 5 次/).waitFor()
  await desktop.getByRole('button', { name: '在此设备生成同步码', exact: true }).click()
  await desktop.locator('#clockCode').filter({ hasText: /[A-F0-9]{6}/ }).waitFor()
  const pairCode = await desktop.locator('#clockCode').textContent()
  const phone = await create('phone', { width: 390, height: 844 })
  await phone.getByRole('button', { name: '两台设备同步', exact: true }).click()
  await phone.getByRole('button', { name: '采集本机时间', exact: true }).click()
  await phone.getByText(/已采集 5 次/).waitFor()
  await phone.getByLabel('另一台设备上的同步码').fill(pairCode)
  await phone.getByRole('button', { name: '回应另一台设备', exact: true }).click()
  await desktop.getByText(/两台设备的回传已记录/).waitFor()
  const pair = report().clockPairs.at(-1)
  assert.equal(pair.status, 'completed')
  assert.equal(pair.projection.sourceTimestampsPreserved, true)
  assert.equal(pair.projection.observedArrivalReversed, true)
  assert.equal(pair.projection.explicitCausePreserved, true)
  assert.ok(pair.call.receivedWallMs > pair.result.receivedWallMs)
  assert.equal(report().clockSamples.length, 2)
  assert.equal(report().humanPasses, 0)
  assert.ok(report().participants.every(row => row.automation))
  pass('two automated contexts, measured clocks and reversed transport enter actual projector without human claims')

  await desktop.getByRole('button', { name: '回到练习选择', exact: true }).click()
  await desktop.getByRole('button', { name: '快速定位', exact: true }).click()
  await desktop.getByRole('button', { name: '开始练习', exact: true }).waitFor({ timeout: 90_000 })
  const interrupted = latest()
  await desktop.getByRole('button', { name: '开始练习', exact: true }).click()
  await desktop.waitForFunction(() => document.querySelector('#timer').textContent === '0:00')
  await desktop.reload()
  await desktop.getByLabel('参与者代号', { exact: true }).fill('automated-preflight')
  await desktop.getByLabel('这是什么设备？').selectOption('desktop')
  await desktop.getByLabel('用过 SuperHub 吗？').selectOption('new')
  await desktop.getByLabel('这是一台实际设备，不是浏览器的手机模拟').check()
  await desktop.getByRole('button', { name: '准备好了', exact: true }).click()
  await desktop.getByRole('button', { name: '快速定位', exact: true }).waitFor()
  const kept = report().runs.find(row => row.id === interrupted.id)
  assert.equal(kept.status, 'interrupted')
  assert.ok(kept.startedAt)
  assert.equal(kept.finishedAt, undefined)
  assert.equal(kept.elapsedMs, undefined)
  assert.equal(report().humanPasses, 0)
  pass('reloaded timed attempt remains interrupted without a fabricated completion or elapsed time')
  console.log(JSON.stringify({ automatedPreflight: true, results, screenshots, evidence: reportPath }))
} finally {
  for (const context of contexts) await context.close()
  await browser.close()
}
