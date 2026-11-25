/** Exercise real packaged order, conversation and report storage through the desktop and password-protected mobile UI. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost } from './acceptance-host.mjs'
import { button, backToOrder, CODEX_STAFF, codexStaff, createOrder, createSession, joinStaff, newSpace, openOrderInfo, openOrderSession, openWorkspace, providerBinaries, say, signIn } from './workspace-browser-fixture.mjs'

const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const host = await acceptanceHost({ candidate:process.env.CHIEF_ACCEPTANCE_PACKAGE, probe:'workspace-v2-probe.mjs', mobile:true,
  extraEnv:{ PATH:providerBinaries() + delimiter + process.env.PATH } })
const original = '我答应小陈周四演示，她答应周三给样本，还请我看看预算，我没答应。'
const siblingText = '同场另一单的花店进货清单。'
const primary = '准备小陈的演示'
const sibling = '花店补货'
const checks = []
const errors = []
let browser
let activePage
function passed(test) { checks.push(test); console.log('PASS ' + test) }
function monitor(page) {
  activePage = page
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => errors.push(error.message))
}
async function layout(page,name) {
  const bounds = await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]')
    const pane = dialog || document.querySelector('.v2-page')
    return { document:document.documentElement.scrollWidth, viewport:innerWidth, pane:pane.scrollWidth, visible:pane.clientWidth }
  })
  assert.ok(bounds.document <= bounds.viewport + 1 && bounds.pane <= bounds.visible + 1, name + ' 应保持单向滚动')
  const directory = process.env.CHIEF_SCREENSHOT_DIR
  if (directory) {
    mkdirSync(directory,{recursive:true})
    await page.screenshot({path:join(directory, name + '.png')})
  }
}
async function record(page, entry) {
  await button(page,'从会话记录').click()
  const dialog = page.getByRole('dialog',{name:'从会话记录约定'})
  const choices = dialog.getByLabel('选择原发言')
  const actual = choices.getByRole('option').filter({hasText:original})
  await actual.waitFor({state:'attached'})
  assert.equal(await choices.getByRole('option').filter({hasText:siblingText}).count(),0)
  await choices.selectOption(await actual.getAttribute('value'))
  const quote = dialog.getByLabel('引用的原话')
  assert.equal(await quote.inputValue(),original)
  await quote.fill('未出现在本单发言里的承诺')
  assert.equal(await button(dialog,'保存约定').isDisabled(),true)
  await quote.fill(entry.quote)
  await dialog.getByLabel('这句话记作').selectOption(entry.kind)
  await dialog.getByLabel('相关人').fill('小陈')
  if (entry.dueAt) await dialog.getByLabel('到期日期').fill(entry.dueAt)
  await button(dialog,'保存约定').click()
  await dialog.waitFor({state:'hidden'})
  await page.getByRole('region',{name:'跟进约定'}).getByText(entry.quote,{exact:true}).waitFor()
}

try {
  codexStaff(host.brain)
  await host.start()
  const password = randomUUID()
  await host.api('/settings/password',{password})
  const {scope} = await host.api('/v2/bootstrap')
  browser = await chromium.launch({headless:true,...process.env.CHIEF_CHROMIUM_PATH && {executablePath:process.env.CHIEF_CHROMIUM_PATH}})
  const desktop = await browser.newPage({viewport:{width:1440,height:900}, locale:'zh-CN', timezoneId:'Asia/Shanghai'})
  monitor(desktop)
  await signIn(desktop,host)
  await desktop.goto(host.base)
  await newSpace(desktop,'客户演示跟进','为客户准备本周演示')
  // The session is a group; Codex answers as a staff member of this workspace when the owner @-mentions it.
  await joinStaff(host,scope,openWorkspace(desktop),[[CODEX_STAFF.id,'写交接文稿']])
  await createSession(desktop,'本周工作')
  await createOrder(desktop,primary,'向小陈演示本周成果','接口人')
  const orderHash = new URL(desktop.url()).hash
  const identity = new URLSearchParams(orderHash.slice(4))
  const base = '/v2/workspaces/' + identity.get('workspace') + '/orders/'
  const read = id => host.api(base + id + '/followup?scope=' + encodeURIComponent(scope))
  await openOrderSession(desktop)
  await say(desktop,'@' + CODEX_STAFF.name + ' 请把交接要点写成一份 Markdown 清单。')
  await desktop.getByRole('list',{name:'会话发言'}).getByRole('button',{name:'交接清单'}).waitFor({timeout:60_000})
  await say(desktop,original)
  await createOrder(desktop,sibling,'核对花材','接口人')
  const other = new URLSearchParams(new URL(desktop.url()).hash.slice(4)).get('order')
  await openOrderSession(desktop)
  await say(desktop,siblingText)
  await button(desktop,'打开工单「' + primary + '」').click()
  const entries = [
    {kind:'mine',quote:'我答应小陈周四演示',dueAt:'2000-01-02'},
    {kind:'theirs',quote:'她答应周三给样本'},
    {kind:'request',quote:'还请我看看预算，我没答应'},
  ]
  for (const entry of entries) await record(desktop,entry)
  const orderId = identity.get('order')
  const first = await read(orderId)
  assert.equal(first.commitments.length,3)
  assert.equal(first.commitments.find(row => row.kind === 'mine').dueState,'overdue')
  assert.deepEqual(new Set(first.commitments.map(row => row.kind)),new Set(entries.map(row => row.kind)))
  assert.deepEqual((await read(other)).commitments,[])
  passed('同一场实际会话的两张工单按原话区分本方承诺、对方承诺和待回应请求')

  const pending = desktop.getByRole('region',{name:'跟进约定'}).getByRole('listitem').filter({hasText:entries[2].quote})
  await button(pending,'定位原话').click()
  await desktop.locator('li.v2-source-turn:focus').getByText(original,{exact:true}).waitFor()
  assert.equal(new URLSearchParams(new URL(desktop.url()).hash.slice(4)).get('message'),first.commitments[2].source.messageId)
  await backToOrder(desktop)
  await button(pending,'标记已处理').click()
  await pending.getByText('已处理',{exact:true}).waitFor()
  await button(desktop,'设置周期').click()
  const schedule = desktop.getByRole('dialog',{name:'每周出稿时间'})
  await schedule.getByRole('combobox',{name:/每周/}).selectOption('5')
  await schedule.getByLabel('时间（Asia/Shanghai）').fill('16:30')
  await button(schedule,'保存周期').click()
  await desktop.getByText('每周五 16:30 · Asia/Shanghai',{exact:true}).waitFor()
  passed('桌面可定位原发言、处理约定，并按工作区时区启用每周出稿')

  const weekly = desktop.getByRole('region',{name:'周报'})
  await weekly.getByRole('button',{name:/生成本周周报|打开本周周报/}).click()
  const report = desktop.getByRole('dialog')
  await report.getByRole('button',{name:'复制全文'}).waitFor()
  const saved = (await read(orderId)).reports[0]
  assert.ok(saved.markdown.includes(entries[0].quote) && saved.markdown.includes(entries[1].quote) && saved.markdown.includes(entries[2].quote))
  assert.ok(saved.markdown.includes('交接清单') && !saved.markdown.includes(siblingText))
  await desktop.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:host.base})
  await button(report,'复制全文').click()
  await report.getByText('已复制',{exact:true}).waitFor()
  assert.equal(await desktop.evaluate(() => navigator.clipboard.readText()),saved.markdown)
  await layout(desktop,'followup-desktop-report')
  await button(report,'关闭详情').click()
  await desktop.getByRole('heading',{name:'跟进约定'}).scrollIntoViewIfNeeded()
  await layout(desktop,'followup-desktop-order')
  passed('周报正文含本单实际交接清单和双方约定，可复制，用同场其他单检验来源范围')

  await host.stop()
  await host.start()
  const after = await read(orderId)
  assert.deepEqual(after.reports,[saved])
  assert.equal(after.commitments.length,3)
  assert.deepEqual((await read(other)).reports,[])
  for (const width of [390,320]) {
    const mobile = await browser.newPage({viewport:{width,height:790},isMobile:true,hasTouch:true,locale:'zh-CN',
      timezoneId:'America/Los_Angeles',colorScheme:width === 390 ? 'dark' : 'light'})
    monitor(mobile)
    try {
      await mobile.addInitScript(() => Object.defineProperty(navigator,'clipboard',{value:undefined, configurable:true}))
      await mobile.goto(host.mobileBase)
      await mobile.getByLabel('密码').fill(password)
      await button(mobile,'进入').click()
      await mobile.getByRole('heading',{name:'今天',exact:true}).waitFor()
      await mobile.goto(host.mobileBase + '/' + orderHash)
      await openOrderInfo(mobile)
      const card = mobile.getByRole('region',{name:'跟进约定'})
      await card.getByText(entries[2].quote,{exact:true}).waitFor()
      await card.scrollIntoViewIfNeeded()
      await layout(mobile,'followup-mobile-order-' + width)
      await button(mobile,'从会话记录').click()
      const dialog = mobile.getByRole('dialog',{name:'从会话记录约定'})
      const select = dialog.getByLabel('选择原发言')
      const option = select.getByRole('option').filter({hasText:original})
      await option.waitFor({state:'attached'})
      await select.selectOption(await option.getAttribute('value'))
      assert.equal(await dialog.getByLabel('引用的原话').inputValue(),original)
      await layout(mobile,'followup-mobile-form-' + width)
      await button(dialog,'关闭详情').click()
      await button(mobile,'打开本周周报').click()
      const opened = mobile.getByRole('dialog',{name:saved.title})
      await button(opened,'复制全文').click()
      const plain = opened.getByLabel('原稿已选中，可以复制')
      assert.equal(await plain.inputValue(),saved.markdown)
      assert.equal(await plain.evaluate(field => field.selectionEnd - field.selectionStart),saved.markdown.length)
      await button(opened,'关闭详情').click()
      if (width === 320) {
        await button(mobile,'设置周期').click()
        await button(mobile.getByRole('dialog'),'停用周期').click()
        await mobile.getByRole('dialog').waitFor({state:'hidden'})
        assert.equal((await read(orderId)).schedule.enabled,false)
      }
    } finally { await mobile.close() }
    passed(width + ' 像素独立手机入口跨时区读回同一份周报，原话选择框可用，无剪贴板权限时可复制完整原稿')
  }
  assert.deepEqual(errors,[])
  if (process.env.CHIEF_FOLLOWUP_UI_EVIDENCE) writeFileSync(process.env.CHIEF_FOLLOWUP_UI_EVIDENCE, JSON.stringify({checks,reportId:saved.id,week:saved.week},null,2))
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    const dialog = activePage.getByRole('dialog').last()
    const region = await dialog.count() ? dialog : activePage.locator('.v2-page')
    console.error((await region.ariaSnapshot().catch(() => '')).slice(-2500))
  }
  throw error
} finally {
  await browser?.close()
  await host.stop()
}
