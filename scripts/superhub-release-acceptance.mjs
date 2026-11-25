/** Exercise phase-two navigation and SAA through the packaged app and two real browser entry points. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { archiveWork, artifact, liaisonWork, lines, localMarker, teach } from './superhub-vertical-probe.mjs'

const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE
const playwrightPath = process.env.CHIEF_PLAYWRIGHT_PATH
const chromiumPath = process.env.CHIEF_CHROMIUM_PATH
const evidenceFile = process.env.CHIEF_SUPERHUB_RELEASE_EVIDENCE
const screenshotDir = process.env.CHIEF_SCREENSHOT_DIR
const seedOnly = process.env.CHIEF_SUPERHUB_RELEASE_SEED_ONLY === '1'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const current = goal => goal.versions.at(-1)
const ref = (ticketId, evidenceId) => ({ ticketId, evidenceId })
const testRun = {
  checkedAt: new Date().toISOString(), node: process.version,
  sample: 'packaged Chief, real isolated DSH, deterministic model fixture',
  caseResults: [], layoutResults: [],
  timing: { automatedSamples: [], humanParticipants: 0, humanTiming: 'requires participant study' },
}
let browser, host, scope
let checkpoint = 'install candidate'
const statusIs = status => error => error.status === status
const post = (path, body) => host.api(`/superhub/${path}`, { requestId: randomUUID(), scope, ...body })
const get = (path, params = []) => host.api(`/superhub/${path}?${new URLSearchParams([['scope', scope], ...params])}`)
const overview = page => page.getByRole('main', { name: '工作总览', exact: true })
const button = (page, name) => overview(page).getByRole('button', { name, exact: typeof name === 'string' })
const title = (page, name) => overview(page).getByRole('heading', { name, exact: typeof name === 'string' })
const currentPlace = page => new URLSearchParams(new URL(page.url()).hash.replace(/^#superhub\?/, ''))
const place = (base, fields) => `${base}/#superhub?${new URLSearchParams({ scope, ...fields })}`
const selectTab = (page, name) => overview(page).getByRole('navigation', { name: '工作总览导航' }).getByRole('button', { name, exact: true }).click()
const escaped = value => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
const passed = (name, facts = {}) => {
  console.log(`PASS ${name}`)
  testRun.caseResults.push({ name, ...facts })
}

async function makeGoal(name, fields = {}) {
  const result = await post('goals', { expectedVersion: 0, name, horizon: '本工作段与下一工作段', owner: '主人',
    reason: '隔离验收场景', type: 'project', status: 'active', ...fields })
  assert.equal(result.scope, scope)
  return result.goal
}

function answers(label) {
  const result = {
    alignment: `${label} · 已拿到同时含两条登记记录的原生交付`,
    bottleneck: `${label} · 业务报送依赖仍未确认`,
    nextFocus: `${label} · 先完成业务报送的Owner确认`,
    firstStep: `${label} · 打开已核验版本并逐条核对报送标准，起草给负责人的一段确认说明`,
    coordination: `${label} · 工单在等主人验收，报送负责人等确认说明`,
    drift: `${label} · 页面微调只作为备忘留待稍后处理`,
    checkpoint: {
      blockedOn: `${label} · 业务报送缺少负责人确认`,
      ruledOut: `${label} · 交付文件漏行，已在返工后核对两条记录`,
      resumeAt: `${label} · 打开已归档交付并起草一个确认说明`,
    },
  }
  result.checkpoint.blockedOn = result.bottleneck
  result.checkpoint.resumeAt = result.firstStep
  return result
}

async function seedScenario(label) {
  checkpoint = `seed ${label} goals and previous review`
  const dependency = await makeGoal(`${label} · 业务报送依赖`)
  const main = await makeGoal(`${label} · 原目标名称`, {
    owner: `${label}业务负责人`,
    relations: [{ kind: 'requires', target: dependency.id }],
    criteria: [{ text: '交付中确有第一条登记记录' }, { text: '交付中确有第二条登记记录' }, { text: '业务负责人已确认报送' }],
  })
  const supporting = await makeGoal(`${label} · 支持目标`, { parent: main.id, relations: [{ kind: 'contributes', target: main.id }] })
  const extra = await makeGoal(`${label} · 第四个候选目标`)
  const before = new Date(Date.now() - 1000).toISOString()
  const prior = (await post('review', {
    ...answers(`${label}上次复盘`), from: new Date(Date.parse(before) - 2 * 3600_000).toISOString(), to: before,
    goalIds: [main.id], goalVersions: [{ id: main.id, version: current(main).version }], tickets: [], references: [],
  })).record

  checkpoint = `seed ${label} working evidence and memo through scoped intake`
  // Both owner inputs reach the liaison; its scripted understanding registers a memo and a read task under each original.
  const memoText = `记一下${label}的非阻塞杂事，稍后统一看看页面微调`
  await teach(host, memoText, [['chief_inbox', { text: `${label}的非阻塞杂事：稍后统一看看页面微调`, intent: 'memo', operation: 'read' }]])
  const memoIntake = await post('items', { text: memoText, goalIds: [main.id] })
  const memo = (await liaisonWork(host, scope, memoIntake.id)).linked[0]
  assert.ok(memo.items.every(row => row.intent === 'memo' && !row.ticketId))
  const original = `请检查左侧归档区 ${localMarker} ${label} 并在工单目录写入 ${artifact}。首轮写入 ${lines[0]}，审查返工后补齐 ${lines[1]}。两轮都回读并登记版本，不要部署。`
  await teach(host, original, [['chief_inbox', { ...archiveWork(label), restrictions: ['不要部署'] }]])
  const received = await post('items', { text: original, goalIds: [main.id, supporting.id] })
  const ticketId = (await liaisonWork(host, scope, received.id)).linked[0].items[0].ticketId
  assert.ok(ticketId)
  const mission = await until(async () => {
    const value = await get(`mission/${ticketId}`, [['limit', '100']])
    assert.notEqual(value.ticket.stage, 'you/blocked', 'The native fixture must expose independently verified work')
    return value.ticket.stage === 'you/review' && value.criteria.every(row => row.status === 'pass') ? value : undefined
  }, `${label} original and revised native assignment`, 45_000)
  const criterion = mission.criteria[0]
  assert.ok(mission.contractHistory.at(-1))
  assert.equal(mission.instances.filter(row => row.kind === 'verify').length, 2)
  const verified = mission.evidence.find(row => row.id === criterion.evidenceIds[0] && row.kind === 'delivery')
  const historical = mission.evidence.find(row => row.kind === 'delivery' && row.historical && row.version !== verified?.version)
  assert.ok(verified?.version && historical?.version)
  const bytes = await get(`evidence/${ticketId}/${verified.id}`)
  assert.equal(sha256(bytes.content), verified.version)
  assert.deepEqual(bytes.content.trim().split(/\r?\n/), lines)

  checkpoint = `verify ${label} shared ticket, stable rename, assessment and relationship conflicts`
  const name = `${label} · 已改名主目标`
  const goalAssessment = {
    result: 'blocked', note: '原生交付已核对，仍需业务负责人确认',
    findings: current(main).criteria.map((condition, index) => ({
      criterionId: condition.id, status: index < 2 ? 'met' : 'unmet', note: index < 2 ? `已核对 ${lines[index]}` : '等待负责人确认',
      evidence: index < 2 ? [ref(ticketId, verified.id)] : [],
    })),
  }
  await assert.rejects(post(`goals/${main.id}`, { name, reason: '拒绝缺项的达成结论', expectedVersion: current(main).version,
    assessment: { ...goalAssessment, result: 'met' } }), statusIs(400))
  const changed = await post(`goals/${main.id}`, { name, reason: '移动端和桌面共用稳定目标标识',
    expectedVersion: current(main).version, assessment: goalAssessment })
  assert.equal(changed.goal.id, main.id)
  assert.equal(changed.previous.name, current(main).name)
  assert.equal(changed.current.name, name)
  assert.deepEqual(changed.impact.tickets, [ticketId])
  await assert.rejects(post(`goals/${main.id}`, { name: `${label}旧草稿`, reason: '同时修改版本',
    expectedVersion: current(main).version }), statusIs(409))
  await assert.rejects(post(`goals/${dependency.id}`, { reason: '环形阻塞校验', expectedVersion: current(dependency).version,
    relations: [{ kind: 'requires', target: main.id }] }), error => error.status === 409 && error.message.includes('循环'))
  const [first, second] = await Promise.all([get(`goals/${main.id}`), get(`goals/${supporting.id}`)])
  assert.equal(first.goal.versions.length, 2)
  assert.equal(first.knownConditions, 2)
  assert.equal(first.requiredConditions, 3)
  assert.equal(current(first.goal).assessment.result, 'blocked')
  assert.deepEqual(first.tasks.map(row => row.id), [ticketId])
  assert.deepEqual(second.tasks.map(row => row.id), [ticketId])
  assert.ok(first.items.some(row => row.receiptId === memo.id && !row.ticketId))
  const review = await get('review', [['goal', main.id], ['goal', supporting.id], ['goal', dependency.id]])
  assert.equal(review.from, prior.to)
  assert.equal(review.latest.id, prior.id)
  assert.ok(review.evidence.some(row => row.ticket.id === ticketId && row.evidence.some(evidence => evidence.id === verified.id)))
  assert.ok(review.attention.some(row => row.id === ticketId && row.stage === 'you/review'))
  assert.ok(review.blockers.some(row => row.target === dependency.id))
  await assert.rejects(get('review', [main, supporting, dependency, extra].map(row => ['goal', row.id])), statusIs(400))
  const selected = [changed.goal, supporting, dependency]
  passed(`${label} fixture and scoped goals API`, { sharedTicket: ticketId, mainGoal: main.id, priorReview: prior.id,
    requiredConditions: [first.knownConditions, first.requiredConditions], pending: 'you/review', currentDelivery: verified.version,
    firstDelivery: historical.version })
  return { label, prior, main: changed.goal, originalName: current(main).name, name, supporting, dependency, extra, selected,
    ticketId, verified, historical, memoText }
}

async function checkLayout(page, sample, panel) {
  const actual = await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const pane = document.querySelector('.hub-scroll')
    return { viewport: innerWidth, document: document.documentElement.scrollWidth,
      panelWidth: pane?.clientWidth, panelScrollWidth: pane?.scrollWidth }
  })
  testRun.layoutResults.push({ sample: sample.label, panel, ...actual })
  assert.equal(actual.viewport, page.viewportSize().width)
  assert.ok(actual.document <= actual.viewport + 1, `${panel} document overflow: ${JSON.stringify(actual)}`)
  assert.ok(actual.panelWidth && actual.panelScrollWidth <= actual.panelWidth + 1, `${panel} panel overflow: ${JSON.stringify(actual)}`)
}

async function screenshot(page, name) {
  if (!screenshotDir) return
  mkdirSync(screenshotDir, { recursive: true })
  await page.screenshot({ path: join(screenshotDir, `superhub-release-${name}.png`) })
}

async function useOwnerCookie(page) {
  const cookies = host.cookie().split('; ').map(pair => {
    const split = pair.indexOf('=')
    return { name: pair.slice(0, split), value: pair.slice(split + 1), url: host.base }
  })
  await page.context().addCookies(cookies)
}

async function ownerPage(viewport, mobile, password) {
  const page = await browser.newPage({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
  page.setDefaultTimeout(12_000)
  const base = mobile ? host.mobileBase : host.base
  if (mobile) {
    await page.goto(base)
    await page.getByRole('heading', { name: 'SuperHub', exact: true }).waitFor()
    await page.getByLabel('密码').fill(password)
    await page.getByRole('button', { name: '进入', exact: true }).click()
  } else {
    await useOwnerCookie(page)
    await page.goto(base)
  }
  const entry = mobile ? page.getByRole('button', { name: '工作总览', exact: true })
    : page.getByRole('navigation', { name: '会话导航' }).getByRole('button', { name: /^工作总览/ })
  await entry.waitFor()
  if (mobile) await entry.click()
  else { await entry.focus(); await entry.press('Enter') }
  await title(page, '等你决定').waitFor()
  assert.equal(await entry.getAttribute('aria-current'), 'page')
  assert.equal(await page.title(), 'SuperHub')
  return { page, base }
}

function wasFocused(locator) { return locator.evaluate(node => node === document.activeElement) }
const scrollTop = page => page.locator('.hub-scroll').evaluate(node => node.scrollTop)
const assertRestoredFocus = (locator, name) => until(() => wasFocused(locator), `恢复${name}的焦点`, 3000)

async function readEvidence(page, version) {
  await title(page, '已归档交付版本').waitFor()
  const readable = overview(page).getByRole('article', { name: '交付正文' })
  await readable.waitFor()
  for (const line of lines) assert.ok((await readable.textContent()).includes(line))
  const metadata = overview(page).locator('.hub-evidence-details:visible')
  if (await metadata.getAttribute('open') === null) await metadata.locator('summary').click()
  await overview(page).getByText(`证据版本 ${version}`, { exact: true }).waitFor()
  const content = await overview(page).locator('.hub-evidence-source:visible').textContent()
  assert.equal(sha256(content), version)
  assert.deepEqual(content.trim().split(/\r?\n/), lines)
}

async function reviewFlow(page, sample, tag) {
  checkpoint = `${tag} goal → mission → exact evidence and return`
  await selectTab(page, '目标地图')
  const started = performance.now()
  const search = overview(page).getByRole('searchbox', { name: '搜索目标' })
  await search.fill(sample.name)
  const openMain = button(page, escaped(sample.name))
  await openMain.focus()
  await openMain.press('Enter')
  await title(page, sample.name).waitFor()
  await title(page, '成果与验收条件').waitFor()
  assert.equal(currentPlace(page).get('id'), sample.main.id)
  const goalProgress = overview(page).getByRole('region', { name: '目标进展', exact: true })
  const waiting = overview(page).getByRole('region', { name: '工单当前等待', exact: true })
  assert.equal(await overview(page).locator('.hub-goal-owner:visible strong').textContent(), current(sample.main).owner)
  await goalProgress.getByText('存在阻碍', { exact: true }).waitFor()
  await goalProgress.locator('.hub-goal-unmet').getByText('业务负责人已确认报送', { exact: true }).waitFor()
  await waiting.getByText('等你验收', { exact: true }).waitFor()
  assert.equal(await overview(page).locator('.hub-goal-manage:visible').getAttribute('open'), null)
  assert.equal(await overview(page).locator('.hub-goal-conditions:visible').getAttribute('open'), null)
  await screenshot(page, `${tag}-goal-facts`)
  await overview(page).locator('.hub-goal-manage:visible > summary').click()
  const versions = overview(page).getByLabel('查看目标版本')
  await versions.selectOption('1')
  await title(page, sample.originalName).waitFor()
  assert.equal(currentPlace(page).get('id'), sample.main.id)
  assert.equal(await button(page, '开始复盘').count(), 0)
  assert.equal(await waiting.count(), 0, 'Historical goals must not show current ticket waits')
  await goalProgress.getByText('当前版本尚未评估，请先核对成果条件。', { exact: true }).waitFor()
  await versions.selectOption('')
  await title(page, sample.name).waitFor()
  await overview(page).locator('.hub-goal-manage:visible > summary').click()
  await overview(page).getByText('2 / 3 项必要条件已确认', { exact: false }).waitFor()
  await checkLayout(page, sample, 'goal')
  const linked = waiting.getByRole('button', { name: escaped(sample.ticketId) })
  await linked.focus()
  const goalScroll = await scrollTop(page)
  await linked.press('Enter')
  await title(page, /验收标准/).waitFor()
  assert.equal(currentPlace(page).get('id'), sample.ticketId)
  await overview(page).locator('.hub-mission-result:visible').getByText(/执行角色/).waitFor()
  const criterionEvidence = button(page, '查看标准证据')
  await criterionEvidence.focus()
  const missionScroll = await scrollTop(page)
  await criterionEvidence.click()
  await readEvidence(page, sample.verified.version)
  assert.equal(currentPlace(page).get('evidence'), sample.verified.id)
  await checkLayout(page, sample, 'evidence')
  await button(page, '返回').click()
  await title(page, /验收标准/).waitFor()
  await assertRestoredFocus(criterionEvidence, '证据按钮')
  assert.ok(Math.abs(await scrollTop(page) - missionScroll) <= 2)
  await button(page, '返回').click()
  await title(page, sample.name).waitFor()
  await assertRestoredFocus(linked, '关联工单')
  assert.ok(Math.abs(await scrollTop(page) - goalScroll) <= 2)
  await button(page, '返回').click()
  assert.equal(await search.inputValue(), sample.name)
  await assertRestoredFocus(openMain, '目标地图')
  await screenshot(page, `${tag}-goal-map`)
  passed(`${tag} exact evidence and navigation restoration`, {
    meaningfulClicksFromGoal: 2, restoredGoalFilter: true, restoredFocus: true, restoredScroll: true, goalId: sample.main.id,
  })

  checkpoint = `${tag} verify SAA window and record decisions`
  await openMain.click()
  await title(page, sample.name).waitFor()
  const firstWindow = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/chief/api/superhub/review' && url.searchParams.getAll('goal').includes(sample.main.id)
  })
  await button(page, '开始复盘').click()
  const initialWindow = await firstWindow
  assert.ok(initialWindow.ok())
  assert.equal(currentPlace(page).get('scope'), scope)
  assert.equal(currentPlace(page).get('goal'), sample.main.id)
  assert.equal(currentPlace(page).get('id'), null)
  await overview(page).locator('.hub-review-goals:visible').getByRole('button', { name: sample.name, exact: true }).waitFor()
  const focus = overview(page).getByRole('combobox', { name: /本次关注目标/ })
  let activeWindow = await initialWindow.json()
  for (const goal of sample.selected.slice(1)) {
    await focus.selectOption(goal.id)
    const refreshed = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/chief/api/superhub/review' && url.searchParams.getAll('goal').includes(goal.id)
    })
    await button(page, '加入本次校准').click()
    const loaded = await refreshed
    assert.ok(loaded.ok())
    activeWindow = await loaded.json()
  }
  await focus.selectOption(sample.extra.id)
  assert.equal(await button(page, '加入本次校准').isDisabled(), true)
  const progress = title(page, '新增证据与进展').locator('..')
  const decisions = title(page, '当前阻塞与待决定').locator('..')
  await decisions.getByText('等你验收', { exact: false }).waitFor()
  await decisions.getByRole('button', { name: current(sample.dependency).name, exact: true }).waitFor()
  const row = progress.locator('article').filter({ hasText: localMarker })
  await row.waitFor()
  const version = escaped(sample.verified.version.slice(0, 8))
  const evidenceCheck = row.getByRole('checkbox', { name: version })
  await evidenceCheck.check()
  const startField = overview(page).getByLabel('工作段起点')
  const endField = overview(page).getByLabel('工作段终点')
  const window = [await startField.inputValue(), await endField.inputValue()]
  const proofLink = row.getByRole('button', { name: version })
  await proofLink.click()
  await readEvidence(page, sample.verified.version)
  await button(page, '返回').click()
  assert.equal(await evidenceCheck.isChecked(), true)
  assert.deepEqual([await startField.inputValue(), await endField.inputValue()], window)
  const fields = [
    ['alignment', '这段时间实际推进了什么？'], ['bottleneck', '最值得解决的卡点是什么？'],
    ['nextFocus', '下一段只专注哪件事？'], ['firstStep', '前 15 分钟先做什么？'],
    ['coordination', '谁在等你提供什么？'], ['drift', '有没有偏离原来的重点？'],
  ]
  const answer = answers(sample.label)
  await button(page, '继续填写并保存复盘').click()
  const firstField = overview(page).getByRole('textbox', { name: '最值得解决的卡点是什么？', exact: true })
  assert.equal(await wasFocused(firstField), true)
  assert.equal(await overview(page).locator('.hub-review-action:visible').getByRole('textbox').count(), 3)
  await overview(page).locator('.hub-review-optional:visible > summary').filter({ hasText: '补充复盘（可选）' }).click()
  for (const [key, label] of fields) await overview(page).getByRole('textbox', { name: label, exact: true }).fill(answer[key])
  await overview(page).getByRole('textbox', { name: '已排除的方向', exact: true }).fill(answer.checkpoint.ruledOut)
  await checkLayout(page, sample, 'review')
  const before = await get('overview')
  const beforeTicket = await host.api(`/tickets/${sample.ticketId}?scope=${scope}`)
  const save = page.waitForResponse(response => new URL(response.url()).pathname === '/chief/api/superhub/review'
    && response.request().method() === 'POST')
  await button(page, '保存校准与复工线索').click()
  const posted = await save
  assert.ok(posted.ok(), `SAA save failed (${posted.status()})`)
  const elapsedMs = Math.round(performance.now() - started)
  const body = posted.request().postDataJSON()
  const { record } = await posted.json()
  assert.equal(record.mode, 'compact')
  assert.deepEqual(record.goals, sample.selected.map(goal => ({ id: goal.id, version: current(goal).version })))
  assert.deepEqual(record.tickets, [sample.ticketId])
  assert.deepEqual(record.references, [ref(sample.ticketId, sample.verified.id)])
  assert.equal(record.from, sample.prior.to)
  assert.equal(record.to, activeWindow.to, 'Evidence drill-down must keep the exact working window')
  assert.deepEqual(record.checkpoint, answer.checkpoint)
  for (const [key] of fields) assert.equal(record[key], answer[key])
  assert.equal((await host.api('/superhub/review', body)).record.id, record.id)
  assert.equal((await get('overview')).total, before.total)
  assert.deepEqual((await host.api(`/tickets/${sample.ticketId}?scope=${scope}`)).ticket, beforeTicket.ticket)
  assert.equal((await get('review/history')).records.filter(value => value.id === record.id).length, 1)
  testRun.timing.automatedSamples.push({ viewport: page.viewportSize(), elapsedMs, input: 'Playwright fixture', withinFiveMinutes: elapsedMs <= 300_000 })
  assert.ok(elapsedMs <= 300_000)
  await title(page, '继续上次工作').waitFor()
  await screenshot(page, `${tag}-checkpoint`)
  passed(`${tag} SAA window, focused goals, checkpoint and read-only effects`, {
    recordId: record.id, previousBoundary: record.from, savedVersion: sample.verified.version, restoredWindowAndSelection: true, newTickets: 0,
  })

  checkpoint = `${tag} reload the saved review and return to exact evidence`
  const recordUrl = page.url()
  const renamed = `${sample.label} · 复盘后改名`
  const later = await post(`goals/${sample.main.id}`, { name: renamed, reason: '验证复工记录保持当时的目标版本',
    expectedVersion: current(sample.main).version })
  assert.equal(later.current.version, current(sample.main).version + 1)
  await page.reload()
  await title(page, '继续上次工作').waitFor()
  await overview(page).getByText(answer.checkpoint.resumeAt, { exact: true }).waitFor()
  assert.equal(currentPlace(page).get('scope'), scope)
  assert.equal(currentPlace(page).get('id'), record.id)
  const savedGoal = button(page, `${renamed} · v${current(sample.main).version}`)
  await savedGoal.click()
  await title(page, sample.name).waitFor()
  assert.equal(currentPlace(page).get('id'), sample.main.id)
  assert.equal(currentPlace(page).get('version'), String(current(sample.main).version))
  await button(page, '返回').click()
  await title(page, '继续上次工作').waitFor()
  const savedEvidence = button(page, `${sample.ticketId} · 查看当时证据`)
  await savedEvidence.focus()
  await savedEvidence.click()
  await readEvidence(page, sample.verified.version)
  await button(page, '返回').click()
  await title(page, '继续上次工作').waitFor()
  assert.equal(await wasFocused(savedEvidence), true)
  await checkLayout(page, sample, 'checkpoint')
  return { record, recordUrl, body, answer }
}

async function checkCachedMission(page, base, sample) {
  checkpoint = 'interrupted mission read keeps last visible snapshot and disables actions'
  const target = url => url.pathname === `/chief/api/superhub/mission/${sample.ticketId}`
  await page.goto(place(base, { page: 'mission', id: sample.ticketId }))
  await overview(page).locator('.hub-mission-result:visible').waitFor()
  await button(page, '确认验收').waitFor()
  await page.route(target, route => route.fulfill({ status: 503, json: { error: '隔离验收临时读取失败' } }))
  const stale = overview(page).getByRole('status').filter({ hasText: '隔离验收临时读取失败' })
  await stale.waitFor({ timeout: 10_000 })
  assert.match(await stale.textContent(), /· 保留 .* 读取的快照/)
  assert.equal(await title(page, /验收标准/).isVisible(), true)
  await button(page, '重新读取当前工单后操作').waitFor()
  assert.equal(await button(page, '确认验收').count(), 0)
  await page.unroute(target)
  await stale.getByRole('button', { name: '重试读取' }).click()
  await stale.waitFor({ state: 'hidden' })
  await button(page, '确认验收').waitFor()
  passed('interrupted mission read keeps a dated snapshot and restores owner actions after retry', { simulatedStatus: 503 })
}

try {
  assert.ok(candidate, 'CHIEF_ACCEPTANCE_PACKAGE must point to the packaged candidate')
  testRun.candidateSha256 = sha256(readFileSync(candidate))
  testRun.dsh = execFileSync('dsh', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim()
  host = await acceptanceHost({ candidate, probe: 'superhub-vertical-probe.mjs', mobile: !seedOnly })
  await host.start()
  scope = (await host.api('/state')).superhubScope
  assert.ok(scope)
  const desktopSample = await seedScenario('桌面验收')
  if (!seedOnly) {
    assert.ok(playwrightPath, 'CHIEF_PLAYWRIGHT_PATH must point to the Playwright module')
    const { chromium } = await import(pathToFileURL(playwrightPath).href)
    browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) })
    testRun.chromium = browser.version()
    const pageErrors = []
    const desktop = await ownerPage({ width: 1440, height: 900 }, false)
    desktop.page.on('pageerror', error => pageErrors.push(error.message))
    const desktopRecord = await reviewFlow(desktop.page, desktopSample, 'desktop')
    await checkCachedMission(desktop.page, desktop.base, desktopSample)

    const mobileSample = await seedScenario('手机验收')
    const password = randomUUID()
    await host.api('/settings/password', { password })
    const mobile = await ownerPage({ width: 390, height: 844 }, true, password)
    mobile.page.on('pageerror', error => pageErrors.push(error.message))
    const mobileRecord = await reviewFlow(mobile.page, mobileSample, 'mobile')

    checkpoint = 'persist both read-only reviews across the isolated host restart'
    await host.stop()
    await host.start()
    assert.equal((await host.api('/state')).superhubScope, scope)
    await useOwnerCookie(desktop.page)
    for (const recent of [desktopRecord, mobileRecord]) {
      assert.deepEqual((await get(`review/${recent.record.id}`)).record, recent.record)
    }
    passed('SAA history survives isolated host restart with unchanged scope')

    checkpoint = 'stale browser scope after an actual second-brain switch'
    const otherBrain = join(host.work, 'release-other-brain')
    await host.api('/settings/brain', { dir: otherBrain })
    const otherScope = await until(async () => {
      const found = (await host.api('/state')).superhubScope
      return found && found !== scope ? found : undefined
    }, '新的第二大脑')
    for (const [view, recent] of [[desktop, desktopRecord], [mobile, mobileRecord]]) {
      await view.page.goto(recent.recordUrl)
      await view.page.getByRole('alert').getByText('此链接属于另一个第二大脑。当前页面的写入已停用。', { exact: true }).waitFor()
      assert.equal(await view.page.getByText(recent.answer.checkpoint.resumeAt, { exact: true }).count(), 0)
      const stale = await view.page.evaluate(async body => {
        const response = await fetch('/chief/api/superhub/review', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-chief-request': '1' }, body: JSON.stringify(body),
        })
        return response.status
      }, recent.body)
      assert.equal(stale, 409)
    }
    assert.deepEqual((await host.api(`/superhub/review/history?scope=${otherScope}`)).records, [])
    assert.deepEqual(pageErrors, [])
    passed('owner reload retained same-scope records while stale writes after brain switch were rejected', { status: 409, mobilePort: true })
  }
  testRun.seedOnly = seedOnly
  testRun.completed = true
} catch (error) {
  testRun.failure = { checkpoint, message: error.message }
  console.error(`FAIL SuperHub release acceptance at ${checkpoint}`, error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await host?.stop()
  if (evidenceFile) {
    mkdirSync(dirname(evidenceFile), { recursive: true })
    writeFileSync(evidenceFile, JSON.stringify(testRun, null, 2) + '\n', { mode: 0o600 })
  }
}
