/** Browser acceptance for a packaged SuperHub candidate on a disposable real DSH host. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { archiveWork, artifact, liaisonWork, lines, localMarker, teach } from './superhub-vertical-probe.mjs'

const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE
const playwrightPath = process.env.CHIEF_PLAYWRIGHT_PATH
const chromiumPath = process.env.CHIEF_CHROMIUM_PATH ?? process.argv[2]
const evidenceFile = process.env.CHIEF_SUPERHUB_UI_EVIDENCE
const screenshotDir = process.env.CHIEF_SCREENSHOT_DIR
const source = `先记一下浏览器隔离验收的窗口尺寸；请检查左侧归档区 ${localMarker} 并在工单目录写入 ${artifact}。首轮写入 ${lines[0]}，审查返工后补齐 ${lines[1]}。两轮都回读并登记版本，不要部署。`
const ambiguous = '把左侧那个乱糟糟的地方改清爽一点。'
const wideChatLine = 'workroom_browser_report_'.repeat(10)
const hash = value => createHash('sha256').update(value).digest('hex')
const params = value => new URLSearchParams(value).toString()
const evidence = { checkedAt: new Date().toISOString(), node: process.version, sample: 'real isolated DSH, deterministic model fixture', cases: [], layouts: [] }
const layoutFailures = []

let browser, host
let checkpoint = 'host installation'
function passed(name, fields = {}) {
  evidence.cases.push({ name, ...fields })
  console.log(`PASS ${name}`)
}

const overview = page => page.getByRole('main', { name: '工作总览', exact: true })
const inOverview = (page, name) => overview(page).getByRole('button', { name, exact: true })
const readHash = page => new URLSearchParams(new URL(page.url()).hash.replace(/^#superhub\?/, ''))
const openPlace = (page, scope, place) => page.goto(`${host.base}/#superhub?${params({ scope, ...place })}`)
const api = (feature, scope, fields = {}) => host.api(`/superhub/${feature}?${params({ scope, ...fields })}`)
const eventRow = (page, id) => page.locator(`[data-event-id="${id}"]:visible`)

async function newPage(viewport) {
  const page = await browser.newPage({ viewport })
  await page.context().addCookies(host.cookie().split('; ').map(pair => {
    const split = pair.indexOf('=')
    return { name: pair.slice(0, split), value: pair.slice(split + 1), url: host.base }
  }))
  return page
}

async function openOverview(page, mobile) {
  const entry = mobile ? page.getByRole('button', { name: '工作总览', exact: true })
    : page.getByRole('navigation', { name: '会话导航' }).getByRole('button', { name: /^工作总览/ })
  await entry.waitFor()
  await entry.focus()
  await entry.press('Enter')
  await overview(page).getByRole('heading', { name: '等你决定' }).waitFor()
  assert.equal(await entry.getAttribute('aria-current'), 'page', 'Overview remains selected in the workspace navigation')
  assert.equal(await page.getByRole('dialog', { name: 'SuperHub' }).count(), 0)
  assert.equal(await page.title(), 'SuperHub')
}

async function screenshot(page, name) {
  if (!screenshotDir) return
  mkdirSync(screenshotDir, { recursive: true })
  await page.screenshot({ path: join(screenshotDir, `superhub-${name}.png`) })
}

async function sendChat(page, text) {
  const chat = page.getByRole('complementary', { name: '接口人' })
  await chat.getByRole('textbox', { name: '对接口人说' }).fill(text)
  const response = page.waitForResponse(row => new URL(row.url()).pathname === '/chief/api/chat' && row.request().method() === 'POST')
  await chat.getByRole('button', { name: '发送', exact: true }).click()
  const accepted = await response
  assert.ok(accepted.ok(), `Chat intake HTTP ${accepted.status()}`)
  const { receipt } = await accepted.json()
  assert.ok(receipt)
  return receipt
}

async function originalEntry(page, receipt, ticketId) {
  await openPlace(page, receipt.scope, { page: 'intake', id: receipt.id })
  await overview(page).getByRole('heading', { name: '主人原话' }).waitFor()
  await overview(page).getByText(receipt.source.text, { exact: true }).waitFor()
  await overview(page).getByRole('heading', { name: '接口人登记的工作' }).waitFor()
  await overview(page).getByText(/^接口人对话 · /).waitFor()
  assert.equal(readHash(page).get('scope'), receipt.scope)
  await inOverview(page, `打开工单 ${ticketId}`).click()
  await overview(page).getByRole('heading', { name: /验收标准/ }).waitFor()
  assert.equal(readHash(page).get('id'), ticketId)
}

async function showDelivery(page, version, expected, unexpected) {
  await overview(page).getByRole('heading', { name: '已归档交付版本' }).waitFor()
  const readable = overview(page).getByRole('article', { name: '交付正文' })
  await readable.waitFor()
  for (const marker of expected) assert.ok((await readable.textContent()).includes(marker), 'The default view must show the readable delivery')
  const metadata = overview(page).locator('.hub-evidence-details:visible')
  if (await metadata.getAttribute('open') === null) await metadata.locator('summary').click()
  await overview(page).getByText(`证据版本 ${version}`, { exact: true }).waitFor()
  const content = await overview(page).locator('.hub-evidence-source:visible').textContent()
  for (const marker of expected) assert.ok(content?.includes(marker), `Missing ${marker} in ${version}`)
  if (unexpected) assert.ok(!content?.includes(unexpected), 'A historical evidence link must open the exact earlier version')
}

async function checkWidth(page, view) {
  const result = await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const scroller = document.querySelector('.hub-scroll')
    const bounds = scroller?.getBoundingClientRect()
    const children = Array.from(scroller?.querySelectorAll('*') ?? []).flatMap(element => {
      const rect = element.getBoundingClientRect()
      return bounds && element.clientWidth > 0 && (rect.right > bounds.right + 1 || element.scrollWidth > element.clientWidth + 2)
        ? [{ tag: element.tagName, className: String(element.className), right: Math.round(rect.right), clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth, label: element.textContent?.trim().slice(0, 45) }]
        : []
    }).slice(0, 15)
    return { viewport: innerWidth, document: document.documentElement.scrollWidth,
      client: scroller?.clientWidth ?? 0, scroll: scroller?.scrollWidth ?? 0, children }
  })
  evidence.layouts.push({ view, viewport: result.viewport, documentWidth: result.document, contentWidth: result.client, contentScrollWidth: result.scroll })
  if (result.document > result.viewport || !result.client || result.scroll > result.client + 1) {
    layoutFailures.push({ view, ...result })
    console.log(`Narrow layout overflow in ${view}`, JSON.stringify(result))
    await screenshot(page, `mobile-overflow-${view}`)
  }
}

function seedLayoutChat({ home, brain }) {
  const directory = join(home, 'chief', 'liaison')
  mkdirSync(directory, { recursive: true })
  const session = `chief-liaison-${hash(brain).slice(0, 10)}`
  writeFileSync(join(directory, `${session}.history.json`), JSON.stringify([{
    seq: 1, time: Date.now() - 60_000, role: 'liaison',
    text: `归档时保留这条完整记录。\n\n\`\`\`text\n${wideChatLine}\n\`\`\``,
  }]))
}

async function workroomBounds(page) {
  const rendered = await page.waitForFunction(() => {
    const pane = document.querySelector('.chief-surface-view')
    const chat = pane?.querySelector('.wr-chat')
    const feed = chat?.querySelector('.wr-msgs')
    const code = feed?.querySelector('.md-code')
    const board = pane?.querySelector('.wr-board')
    if (!pane || !chat || !feed || !code || !board) return
    const size = element => {
      const { left, right, width } = element.getBoundingClientRect()
      return { left, right, width, client: element.clientWidth, scroll: element.scrollWidth }
    }
    return { viewport: innerWidth, pane: size(pane), chat: size(chat), feed: size(feed), board: size(board), code: size(code) }
  })
  return rendered.jsonValue()
}

async function checkWorkbenchLayout(page) {
  await page.setViewportSize({ width: 1260, height: 547 })
  await page.locator('.wr-msgs pre').getByText(wideChatLine, { exact: true }).waitFor()
  await page.evaluate(() => document.fonts.ready)
  const bounds = await workroomBounds(page)
  const { viewport, pane, chat, feed, board, code } = bounds
  evidence.workroom = bounds
  await screenshot(page, 'workroom-short-desktop')
  assert.ok(Math.abs(chat.left - pane.left) <= 1 && Math.abs(chat.right - board.left) <= 1
    && Math.abs(board.right - viewport) <= 1 && board.width >= pane.width * 0.4,
  `Both workroom panes must fit beside the sidebar: ${JSON.stringify(bounds)}`)
  assert.ok(code.scroll > code.client && [pane, feed, board].every(region => region.scroll <= region.client + 1),
    'Wide code must scroll inside its own block')

  await page.setViewportSize({ width: 900, height: 547 })
  const tabs = page.getByRole('navigation', { name: '区块', exact: true })
  const boardTab = tabs.getByRole('button', { name: /^今天/ })
  await boardTab.click()
  const narrow = await workroomBounds(page)
  assert.ok(narrow.chat.width === 0 && Math.abs(narrow.board.width - narrow.pane.width) <= 1,
    'The board tab must use the full narrow pane')
  await tabs.getByRole('button', { name: '接口人', exact: true }).click()
  const narrowChat = await workroomBounds(page)
  assert.ok(narrowChat.board.width === 0 && Math.abs(narrowChat.chat.width - narrowChat.pane.width) <= 1,
    'The chat tab must use the full narrow pane')
  evidence.workroomNarrow = narrow
  await page.setViewportSize({ width: 1259, height: 538 })
  const sidebar = page.getByRole('navigation', { name: '会话导航' })
  const fontSize = name => sidebar.getByRole('button', { name }).locator('small')
    .evaluate(subtitle => getComputedStyle(subtitle.parentElement).fontSize)
  assert.equal(await fontSize(/^工作总览/), await fontSize(/^接口人/), 'Sidebar entries must share the same title size')
  passed('short and narrow workroom with intrinsically wide chat history', { desktop: [1260, 547], narrow: [900, 547] })
}

async function hubContrast(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const paint = color => {
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
    }
    const luminance = () => {
      const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255)
      const [r, g, b] = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (selector, pseudo) => {
      const element = document.querySelector(selector)
      const layers = []
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        layers.push(getComputedStyle(ancestor).backgroundColor)
      }
      paint('#fff')
      layers.reverse().forEach(paint)
      const background = luminance()
      paint(getComputedStyle(element, pseudo).color)
      const foreground = luminance()
      return Math.round(1000 * (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)) / 1000
    }
    return {
      title: ratio('main[aria-label=工作总览] header h1'),
      section: ratio('.hub-section h3'),
      ticketStage: ratio('.hub-row .hub-state'),
      ticketDetail: ratio('.hub-row small'),
      input: ratio('.hub-shell input[type=search]'),
      placeholder: ratio('.hub-shell input[type=search]', '::placeholder'),
      activeTab: ratio('.hub-tabs [aria-current=page]'),
    }
  })
}

async function checkWorkbenchThemes(page) {
  evidence.contrast = {}
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme })
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, theme === 'dark')
    await openOverview(page, false)
    await overview(page).locator('.hub-row .hub-state').first().waitFor()
    const ratios = await hubContrast(page)
    evidence.contrast[theme] = ratios
    await screenshot(page, `workbench-short-${theme}`)
    await checkWidth(page, `workbench-short-${theme}`)
    const scroll = await overview(page).evaluate(main => {
      const content = main.querySelector('.hub-scroll')
      const tabs = main.querySelector('.hub-tabs')
      const top = tabs.getBoundingClientRect().top
      content.scrollTop = content.scrollHeight
      return { offset: content.scrollTop, tabsStayed: tabs.getBoundingClientRect().top === top }
    })
    assert.ok(scroll.offset > 0 && scroll.tabsStayed, 'Content must scroll with the workbench tabs still in place')
    await inOverview(page, '返回接口人').click()
    await overview(page).waitFor({ state: 'hidden' })
  }
  for (const [theme, ratios] of Object.entries(evidence.contrast)) {
    for (const [name, ratio] of Object.entries(ratios)) assert.ok(ratio >= 4.5, `${theme} ${name} contrast ${ratio}:1`)
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1440, height: 900 })
  passed('short SuperHub workbench is readable in both host themes', { viewport: [1259, 538], minimumContrast: 4.5 })
}

function seedParallelHistory(brain) {
  const directory = join(brain, 'ops', 'tickets')
  const at = new Date(Date.now() - 86_400_000).toISOString()
  const endedAt = new Date(Date.parse(at) + 20_000).toISOString()
  const ids = ['T-0091', 'T-0092', 'T-0093']
  const standards = ['核对目录结构', '核对归档摘要']
  mkdirSync(directory, { recursive: true })
  for (const [i, id] of ids.entries()) {
    const parent = i ? { ticketId: ids[0], assignmentId: 'parallel-parent-round', key: `parallel-${i}`, criterion: i - 1 } : undefined
    const title = i === 0 ? '历史并行样本' : `并行子任务 ${i}`
    const staff = i === 2 ? 'engineer' : 'researcher'
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({
      id, parent, title, staff, priority: 0, createdAt: at, inputs: [], events: [],
      mandate: { eventId: `parallel-${id}`, scope: title, doneWhen: i ? [standards[i - 1]] : standards, needsReview: false, level: 'think', strength: 'explicit' },
      assignments: [{ id: i ? `parallel-child-${i}` : 'parallel-parent-round', staff, executor: 'dsh', round: 0, state: 'reported', startedAt: at, endedAt,
        report: { status: 'ready', summary: standards[i - 1] ?? title, structured: true } }],
      ended: { at: endedAt, outcome: 'done', note: '历史验收状态' },
    }))
  }
  return ids[0]
}

async function checkStandaloneResults(scope, mission, legacyId) {
  const password = randomUUID()
  await host.api('/settings/password', { password })
  const delivery = mission.evidence.find(row => row.kind === 'delivery' && !row.historical)
  const nativeProof = mission.evidence.find(row => row.kind === 'native' && row.eventId)
  const role = mission.roles.find(row => row.instances.some(instance => instance.sessionId))
  assert.ok(delivery && nativeProof && role)
  const activity = await api(`roles/${role.id}`, scope)
  const listed = await api('overview', scope)
  const legacy = await api(`mission/${legacyId}`, scope)
  const missingSource = legacy.instances.find(instance => !instance.sessionId)
  assert.ok(missingSource)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    const navigate = place => page.goto(`${host.mobileBase}/#superhub?${params({ scope, ...place })}`)
    page.setDefaultTimeout(12_000)
    try {
      await page.goto(host.mobileBase)
      await page.getByLabel('密码').fill(password)
      await page.getByRole('button', { name: '进入', exact: true }).click()
      await navigate({ page: 'mission', id: mission.ticket.id })
      const preview = inOverview(page, `查看结果 · ${artifact}`)
      await preview.waitFor()
      assert.equal(await overview(page).locator('.hub-timeline:visible').getAttribute('open'), null)
      assert.equal(await overview(page).getByRole('textbox', { name: '事件类型' }).count(), 0)
      await screenshot(page, `standalone-${viewport.width}-result`)
      await checkWidth(page, `standalone-${viewport.width}-result`)
      await preview.click()
      await overview(page).getByRole('article', { name: '交付正文' }).waitFor()
      assert.equal(await overview(page).locator('.hub-evidence-details:visible').getAttribute('open'), null)
      assert.equal(await overview(page).locator('.hub-evidence-source:visible').count(), 0)
      await screenshot(page, `standalone-${viewport.width}-document`)
      await showDelivery(page, delivery.version, lines)
      await inOverview(page, '返回').click()
      assert.equal(await preview.evaluate(node => node === document.activeElement), true)

      await navigate({ page: 'overview' })
      const roles = overview(page).locator('.hub-role-list')
      await roles.getByRole('button', { name: new RegExp(role.name) }).waitFor()
      assert.equal(await roles.getByRole('button').count(), listed.roles.length, 'Every known role remains discoverable')
      await roles.getByRole('button', { name: new RegExp(role.name) }).click()
      await overview(page).getByRole('heading', { name: `${role.name}的活动` }).waitFor()
      await overview(page).locator('.hub-row:visible').first().click()
      assert.equal(readHash(page).get('instance'), activity.items[0].id)
      const timeline = overview(page).locator('.hub-timeline:visible')
      await timeline.locator('.hub-events').waitFor()
      assert.notEqual(await timeline.getAttribute('open'), null)
      await timeline.getByText('已定位真实原生会话的事件记录。对话与工具正文不在此展示。', { exact: true }).waitFor()
      assert.ok(await timeline.locator('.hub-events details[open]').count() > 0, 'A selected instance exposes a concrete recorded event')
      assert.equal(await timeline.locator('.hub-timeline-filters').getAttribute('open'), null)
      await checkWidth(page, `standalone-${viewport.width}-instance`)
      await screenshot(page, `standalone-${viewport.width}-instance`)
      await page.reload()
      await overview(page).locator('.hub-timeline:visible .hub-events details[open]').first().waitFor()
      assert.equal(readHash(page).get('instance'), activity.items[0].id)

      await navigate({ page: 'evidence', id: nativeProof.ticketId, evidence: nativeProof.id })
      await overview(page).getByText('这里保留了事件的时间、工具和处理状态。原始对话与工具内容已脱敏，没有可供阅读的正文。', { exact: true }).waitFor()
      await inOverview(page, '查看对应执行记录').click()
      assert.equal(readHash(page).get('event'), nativeProof.eventId)
      await eventRow(page, nativeProof.eventId).locator('details[open]').waitFor()
      await until(() => eventRow(page, nativeProof.eventId).locator('summary').evaluate(node => node === document.activeElement), '定位对应原生事件')
      await navigate({ page: 'mission', id: legacyId, instance: missingSource.id })
      await overview(page).locator('.hub-instance-context').getByText(missingSource.coverage.reason, { exact: true }).waitFor()
      assert.equal(await overview(page).getByRole('link', { name: /原生会话/ }).count(), 0)
      passed(`standalone ${viewport.width}px results, complete role discovery and usable execution records`, { actualMobilePort: true,
        ticketId: mission.ticket.id, selectedInstance: activity.items[0].id, nativeEvent: nativeProof.eventId, missingSource: missingSource.id })
    } finally { await page.close() }
  }
}

try {
  assert.ok(candidate, 'CHIEF_ACCEPTANCE_PACKAGE must point to a disposable candidate tarball')
  assert.ok(playwrightPath, 'CHIEF_PLAYWRIGHT_PATH must point to the installed Playwright module')
  evidence.candidateSha256 = hash(readFileSync(candidate))
  host = await acceptanceHost({ candidate, probe: 'superhub-vertical-probe.mjs', mobile: true })
  const parallelHistory = seedParallelHistory(host.brain)
  seedLayoutChat(host)
  await host.start()
  const scope = (await host.api('/state')).superhubScope
  assert.ok(scope)
  const { chromium } = await import(pathToFileURL(playwrightPath).href)
  browser = await chromium.launch({ headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) })
  evidence.browser = browser.version()
  const desktop = await newPage({ width: 1440, height: 900 })
  const pageErrors = []
  desktop.on('pageerror', error => pageErrors.push(error.message))

  checkpoint = 'reported short workroom and SuperHub color contrast'
  await desktop.goto(host.base)
  await checkWorkbenchLayout(desktop)
  await checkWorkbenchThemes(desktop)

  checkpoint = 'desktop navigation retains a chat draft'
  const chatDraft = desktop.getByRole('textbox', { name: '对接口人说' })
  await chatDraft.fill('只留在输入框里的验收草稿')
  await openOverview(desktop, false)
  assert.equal(await overview(desktop).getByRole('navigation', { name: '工作总览导航' }).getByRole('button', { name: '等你决定' }).getAttribute('aria-current'), 'page')
  await inOverview(desktop, '返回接口人').click()
  await overview(desktop).waitFor({ state: 'hidden' })
  assert.equal(await chatDraft.inputValue(), '只留在输入框里的验收草稿')
  passed('workspace overview retains a draft on return to the liaison')

  checkpoint = 'desktop chat reaches the liaison and its registered work is linked to the original'
  await teach(host, source, [['chief_inbox', { text: '浏览器隔离验收的窗口尺寸', intent: 'memo', operation: 'read' }],
    ['chief_inbox', { ...archiveWork(), restrictions: ['不要部署'] }]])
  const received = await sendChat(desktop, source)
  assert.equal(received.scope, scope)
  assert.equal(received.source.channel, 'chat')
  assert.equal(received.source.text, source)
  assert.deepEqual(received.items.map(row => [row.intent, row.state, row.ticketId]), [['conversation', 'conversation', undefined]])
  const linked = (await liaisonWork(host, scope, received.id, 2)).linked
  const memo = linked.find(row => row.items[0].intent === 'memo').items[0]
  const task = linked.find(row => row.items[0].intent === 'execute').items[0]
  assert.deepEqual({ intent: memo.intent, state: memo.state, ticket: memo.ticketId }, { intent: 'memo', state: 'recorded', ticket: undefined })
  assert.equal(task.state, 'dispatched')
  assert.deepEqual(task.restrictions, ['不要部署'])
  const ticketId = task.ticketId
  assert.ok(ticketId)
  passed('desktop scoped chat reaches the liaison; memo and read task are linked to the original receipt', { viewport: [1440, 900], receiptId: received.id, ticketId })

  checkpoint = 'native execution, first rejection, rework and independent verification'
  await originalEntry(desktop, received, ticketId)
  const detail = await until(async () => {
    const view = await host.api(`/tickets/${ticketId}`)
    const assignments = view.ticket.assignments
    const latest = assignments.at(-1)
    if (latest?.verification?.status === 'failed') throw Error(latest.verification.critique)
    return assignments.length === 2 && assignments[1].verification?.verdict === 'pass' ? view : undefined
  }, '两轮隔离执行及逐项核验', 60_000)
  const [first, second] = detail.ticket.assignments
  assert.equal(first.verification.verdict, 'revise')
  assert.equal(detail.stage, 'you/review')
  assert.equal(second.verification.criteria[0].status, 'pass')
  assert.notEqual(first.deliveries[0].version, second.deliveries[0].version)
  const mission = await api(`mission/${ticketId}`, scope, { limit: 100 })
  const firstReview = mission.timeline.items.find(event => event.type === 'assignment/verified' && event.assignmentId === first.id)
  assert.ok(firstReview)
  assert.equal(mission.mode, 'live')
  assert.equal(mission.contract.version, 1)
  assert.equal(mission.instances.length, 4)
  assert.equal(new Set(mission.instances.map(instance => instance.sessionId).filter(Boolean)).size, 4)
  assert.ok(mission.instances.every(instance => instance.actualProvider === 'spawn'))
  assert.equal(mission.criteria[0].status, 'pass')
  const result = mission.timeline.items.find(event => event.type === 'tool/result' && event.native?.pairing === 'confirmed' && event.causes.length)
  assert.ok(result)
  assert.ok(result.observedAt)
  assert.equal(result.native.redacted, true)
  assert.ok(!JSON.stringify(result.native).includes(artifact))
  await overview(desktop).getByRole('heading', { name: '观察覆盖' }).waitFor()
  await overview(desktop).getByRole('heading', { name: '角色与实例' }).waitFor()
  await overview(desktop).getByText('必要 · 通过', { exact: true }).waitFor()
  assert.equal(await overview(desktop).locator('.hub-timeline:visible').getAttribute('open'), null)
  await overview(desktop).locator('.hub-timeline:visible > summary').click()
  await overview(desktop).locator('.hub-timeline-filters:visible > summary').click()
  const filter = overview(desktop).getByRole('textbox', { name: '事件类型' })
  await filter.fill('tool/result')
  const filteredResponse = desktop.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === `/chief/api/superhub/mission/${ticketId}` && url.searchParams.get('type') === 'tool/result'
  })
  await inOverview(desktop, '应用筛选').click()
  const filtered = await (await filteredResponse).json()
  assert.ok(filtered.timeline.matched > 0)
  assert.ok(filtered.timeline.items.every(event => event.type === 'tool/result'))
  await eventRow(desktop, result.id).waitFor()
  assert.equal(await overview(desktop).locator('.hub-timeline-filters:visible').getAttribute('open'), '')
  assert.equal(await filter.inputValue(), 'tool/result')
  await inOverview(desktop, '暂停跟随').click()
  await inOverview(desktop, '恢复最新工单操作').waitFor()
  assert.equal(await inOverview(desktop, '请求补证').count(), 0)
  assert.equal(await overview(desktop).getByRole('heading', { name: '当前工单操作' }).count(), 0)
  await inOverview(desktop, '恢复最新工单操作').click()
  const actions = overview(desktop).locator('.hub-section').filter({ has: desktop.getByRole('heading', { name: '当前工单操作' }) })
  await actions.locator('.hub-action-more > summary').click()
  await inOverview(desktop, '请求补证').waitFor()
  await actions.getByRole('button', { name: '请求补证', exact: true }).click()
  await actions.getByLabel('希望补充的证据').fill('请补充这一版本的复查依据')
  const supplementUrl = new RegExp(`/chief/api/superhub/mission/${ticketId}$`)
  const sendStaleSupplement = route => {
    const request = route.request()
    if (request.method() !== 'POST' || request.postDataJSON()?.action !== 'requestEvidence') return route.continue()
    return route.continue({ postData: JSON.stringify({ ...request.postDataJSON(), assignmentId: first.id }) })
  }
  await desktop.route(supplementUrl, sendStaleSupplement)
  const rejectedSupplement = desktop.waitForResponse(response => supplementUrl.test(response.url())
    && response.request().method() === 'POST' && response.status() === 409)
  await actions.locator('form').getByRole('button', { name: '请求补证', exact: true }).click()
  const rejected = await rejectedSupplement
  const refusal = (await rejected.json()).error
  await actions.getByText(refusal, { exact: true }).waitFor()
  assert.equal(await actions.getByText('请求补证已受理', { exact: true }).count(), 0)
  assert.equal((await host.api(`/tickets/${ticketId}`)).ticket.assignments.length, 2)
  await desktop.unroute(supplementUrl, sendStaleSupplement)
  await actions.locator('.hub-action-more').getByRole('button', { name: '请求补证', exact: true }).click()
  passed('rejected supplement shows the real server reason without a success receipt', { status: 409 })
  await screenshot(desktop, 'desktop-mission')
  const proofButton = inOverview(desktop, '查看标准证据')
  await proofButton.scrollIntoViewIfNeeded()
  const scrollBefore = await desktop.locator('.hub-scroll').evaluate(node => node.scrollTop)
  await proofButton.click()
  await showDelivery(desktop, second.deliveries[0].version, lines)
  await inOverview(desktop, '返回').click()
  await overview(desktop).getByRole('heading', { name: /验收标准/ }).waitFor()
  assert.equal(await filter.inputValue(), 'tool/result')
  assert.ok(Math.abs(await desktop.locator('.hub-scroll').evaluate(node => node.scrollTop) - scrollBefore) <= 2)
  assert.equal(await proofButton.evaluate(node => document.activeElement === node), true)
  await openPlace(desktop, scope, { page: 'mission', id: ticketId, event: result.id })
  await eventRow(desktop, result.id).getByText('会话序号', { exact: false }).waitFor()
  await inOverview(desktop, '因果依据 1').click()
  await eventRow(desktop, result.causes[0]).getByText('工具调用', { exact: true }).waitFor()
  assert.equal(readHash(desktop).get('event'), result.causes[0])
  passed('real native attempts, contract criteria, current proof and causal deep link', {
    instances: mission.instances.map(instance => ({ id: instance.id, round: instance.round, kind: instance.kind, sessionId: instance.sessionId })),
    versions: [first.deliveries[0].version, second.deliveries[0].version],
  })
  checkpoint = 'standalone result reading and real instance navigation'
  await checkStandaloneResults(scope, mission, parallelHistory)

  checkpoint = 'historical proof on 390px viewport'
  const mobile = await newPage({ width: 390, height: 844 })
  mobile.on('pageerror', error => pageErrors.push(error.message))
  await mobile.goto(host.base)
  await openOverview(mobile, true)
  await checkWidth(mobile, 'overview')
  await openPlace(mobile, scope, { page: 'mission', id: ticketId, at: first.verifiedAt, event: firstReview.id })
  await inOverview(mobile, '切回当前工单').waitFor()
  assert.equal(await inOverview(mobile, '请求补证').count(), 0)
  assert.equal(await overview(mobile).getByRole('heading', { name: '当前工单操作' }).count(), 0)
  const replay = await api(`mission/${ticketId}`, scope, { at: first.verifiedAt, event: firstReview.id })
  assert.equal(replay.mode, 'replay')
  assert.equal(replay.currentTarget, undefined)
  assert.equal(replay.criteria[0].status, 'fail')
  await inOverview(mobile, '查看标准证据').click()
  await showDelivery(mobile, first.deliveries[0].version, [lines[0]], lines[1])
  await checkWidth(mobile, 'evidence')
  await screenshot(mobile, 'mobile-history')
  await inOverview(mobile, '返回').click()
  await inOverview(mobile, '切回当前工单').click()
  await inOverview(mobile, '确认验收').waitFor()
  await checkWidth(mobile, 'mission')
  await assert.rejects(host.api(`/superhub/mission/${ticketId}`, {
    ...mission.currentTarget, scope, requestId: randomUUID(), at: first.verifiedAt, action: 'accept',
  }), error => error.status === 409)
  const acceptedResponse = mobile.waitForResponse(response => new URL(response.url()).pathname === `/chief/api/superhub/mission/${ticketId}`
    && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'accept')
  await inOverview(mobile, '确认验收').click()
  assert.ok((await acceptedResponse).ok())
  await overview(mobile).getByText(/主人已确认验收/).waitFor()
  passed('mobile sidebar, read-only history and original delivery', { viewport: [390, 844], historicalAt: first.verifiedAt })
  await openPlace(mobile, scope, { page: 'mission', id: parallelHistory })
  await inOverview(mobile, /并行子任务 1/).waitFor()
  await inOverview(mobile, /并行子任务 2/).waitFor()
  await overview(mobile).getByText('原标准 · 核对目录结构', { exact: true }).waitFor()
  await overview(mobile).getByText('原标准 · 核对归档摘要', { exact: true }).waitFor()
  await checkWidth(mobile, 'parallel-history')
  await inOverview(mobile, /并行子任务 2/).click()
  await overview(mobile).getByRole('heading', { name: '并行子任务 2', exact: true }).waitFor()
  passed('mobile renders both parallel child tickets vertically with original conditions', { viewport: [390, 844], sample: 'persisted legacy parallel fixture' })
  await mobile.close()

  checkpoint = 'pinned timeline with a new recorded owner input'
  await host.api('/pause', { paused: true })
  const historyPage = await newPage({ width: 1440, height: 900 })
  try {
    const heldText = '请调研隔离材料归档规则。'
    await teach(host, heldText, [['chief_inbox', { text: '调研隔离材料归档规则，交付规则清单', staff: 'researcher', operation: 'read' }]])
    const held = await host.api('/superhub/items', { scope, requestId: randomUUID(), text: heldText })
    const heldId = (await liaisonWork(host, scope, held.id)).linked[0].items[0].ticketId
    assert.ok(heldId)
    await historyPage.bringToFront()
    await openPlace(historyPage, scope, { page: 'mission', id: heldId })
    assert.equal(await historyPage.evaluate(() => document.visibilityState), 'visible')
    await overview(historyPage).locator('.hub-timeline:visible > summary').click()
    await inOverview(historyPage, '暂停跟随').click()
    await overview(historyPage).getByText('阅读位置已固定', { exact: true }).waitFor()
    const originalRows = overview(historyPage).locator('.hub-events [data-event-id]')
    const originalIds = await originalRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-event-id')))
    assert.ok(originalIds.length)
    const anchor = originalRows.last()
    await anchor.scrollIntoViewIfNeeded()
    const beforeAnchor = (await anchor.boundingBox()).y
    const heldMission = await api(`mission/${heldId}`, scope)
    const didPoll = historyPage.waitForResponse(async response => {
      const url = new URL(response.url())
      if (url.pathname !== `/chief/api/superhub/mission/${heldId}` || response.request().method() !== 'GET' || !response.ok()) return false
      return (await response.json()).timeline.matched > heldMission.timeline.matched
    }, { timeout: 15_000 })
    await host.api(`/superhub/mission/${heldId}`, { scope, ...heldMission.currentTarget, action: 'reply',
      requestId: randomUUID(), text: '请保留原范围，补充一条读取中的主人说明。' })
    assert.ok((await api(`mission/${heldId}`, scope)).timeline.items.some(event => event.type === 'ticket/input'))
    const updated = await (await didPoll).json()
    const notice = overview(historyPage).getByText(/\d+ 条新增事件 · 阅读位置已固定/)
    try { await notice.waitFor({ timeout: 12_000 }) } catch (error) {
      evidence.pinnedDebug = { before: heldMission.timeline.matched, after: updated.timeline.matched,
        statuses: await overview(historyPage).getByRole('status').allTextContents(),
        following: await inOverview(historyPage, '暂停跟随').count(), location: readHash(historyPage).get('id') }
      throw error
    }
    assert.deepEqual(await originalRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-event-id'))), originalIds)
    assert.ok(Math.abs((await anchor.boundingBox()).y - beforeAnchor) <= 2)
    passed('a real owner input increments the pinned timeline count without moving the history anchor')
    await host.api(`/superhub/mission/${heldId}`, { scope, ...heldMission.currentTarget, action: 'stop', reason: '浏览器验收结束' })
  } finally { await historyPage.close(); await host.api('/pause', { paused: false }) }

  checkpoint = 'SuperHub intake reaches the liaison; a UI change waiting for clarification can be kept as a memo'
  // The liaison picks a catalog feature with its basis. This packaged host cannot change UI source, so the item waits for the owner.
  await teach(host, ambiguous, [['chief_ui', { action: 'source', request: '精简讨论列表的视觉层级', feature: 'discussion-navigation', feature_basis: '主人说左侧那个地方，当前页面是讨论列表' }]])
  await openPlace(desktop, scope, { page: 'intake' })
  await overview(desktop).getByRole('textbox', { name: '原始指令' }).fill(ambiguous)
  const posted = desktop.waitForResponse(row => new URL(row.url()).pathname === '/chief/api/superhub/items' && row.request().method() === 'POST')
  await inOverview(desktop, '提交并查看回执').click()
  const ambiguityResponse = await posted
  assert.ok(ambiguityResponse.ok())
  const intake = await ambiguityResponse.json()
  assert.equal(intake.source.channel, 'owner')
  const ambiguity = (await liaisonWork(host, scope, intake.id, 1, row => row.items[0].state === 'clarify')).linked[0]
  await overview(desktop).getByText('待澄清', { exact: true }).waitFor()
  const [ambiguousItem] = ambiguity.items
  assert.equal(ambiguousItem.ticketId, undefined)
  assert.deepEqual([ambiguousItem.feature.id, ambiguousItem.feature.basis], ['discussion-navigation', '主人说左侧那个地方，当前页面是讨论列表'])
  await overview(desktop).getByText(/接口人依据主人原话理解为：精简讨论列表的视觉层级/).waitFor()
  await inOverview(desktop, '仅保留备忘').click()
  await overview(desktop).getByText('已记录', { exact: true }).waitFor()
  const corrected = await api(`items/${ambiguity.id}`, scope)
  assert.ok(corrected.version > ambiguity.version)
  assert.equal(corrected.items[0].ticketId, undefined)
  assert.ok(corrected.history.some(row => row.item.state === 'clarify'))
  await assert.rejects(host.api(`/superhub/items/${ambiguity.id}`, { scope, itemId: ambiguousItem.id,
    requestId: randomUUID(), action: 'record', expectedVersion: ambiguity.version }), error => error.status === 409)
  passed('SuperHub intake reaches the liaison; the waiting UI change is kept as a memo and a stale receipt version is rejected')

  checkpoint = 'actual second-brain switch and stale browser write'
  const staleTarget = mission.currentTarget
  assert.ok(staleTarget)
  const otherBrain = join(host.work, 'second-brain')
  await host.api('/settings/brain', { dir: otherBrain })
  const otherScope = await until(async () => {
    const state = await host.api('/state')
    return state.superhubScope && state.superhubScope !== scope ? state.superhubScope : undefined
  }, '切换到另一个隔离第二大脑')
  await openPlace(desktop, scope, { page: 'mission', id: ticketId })
  await desktop.reload()
  await desktop.getByRole('alert').getByText('此链接属于另一个第二大脑。当前页面的写入已停用。', { exact: true }).waitFor()
  assert.equal(await inOverview(desktop, '请求补证').count(), 0)
  const oldWrite = await desktop.evaluate(async ({ ticketId, scope, staleTarget, requestId }) => {
    const response = await fetch(`/chief/api/superhub/mission/${ticketId}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-chief-request': '1' },
      body: JSON.stringify({ ...staleTarget, scope, requestId, action: 'requestEvidence', text: '旧作用域不得影响新空间' }),
    })
    return response.status
  }, { ticketId, scope, staleTarget, requestId: randomUUID() })
  assert.equal(oldWrite, 409)
  assert.equal((await api('overview', otherScope)).total, 0)
  assert.deepEqual(pageErrors, [])
  passed('previous brain deep link and stale browser write stay scoped', { staleStatus: oldWrite })
  checkpoint = '390px layout'
  assert.deepEqual(layoutFailures.map(row => row.view), [])
} catch (error) {
  evidence.failure = { checkpoint, message: error.message }
  console.error(`FAIL SuperHub browser acceptance at ${checkpoint}`, error)
  process.exitCode = 1
} finally {
  await browser?.close()
  await host?.stop()
  if (evidenceFile) {
    mkdirSync(dirname(evidenceFile), { recursive: true })
    evidence.layoutFailures = layoutFailures
    writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  }
}
