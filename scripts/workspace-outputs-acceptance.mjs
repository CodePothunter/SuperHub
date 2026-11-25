/**
 * The workspace's 「产物」 on an isolated DSH with the exact candidate (code authors are protocol fixtures). Two orders in
 * one group each get a file from the Codex member; the signup page is fixed once (same file). The overview's 「最近产物」
 * lists both with their order tags, 「查看全部」 opens the 「产物」 board (its own address), whose filters narrow by order,
 * by deliverer and by clicking a tag, and whose reader opens what the order's 「交付成果」 opens.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { button, backToOrder, CODEX_STAFF, codexStaff, createOrder, createSession, joinStaff, openOrderSession, openWorkspace, newSpace, providerBinaries, say, signIn } from './workspace-browser-fixture.mjs'

const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const host = await acceptanceHost({probe:'workspace-v2-probe.mjs',extraEnv:{PATH:providerBinaries() + delimiter + process.env.PATH}})
const passed = text => console.log('PASS ' + text)
const errors = []
let browser

async function picture(page, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' 不应横向溢出')
  if (!process.env.CHIEF_SCREENSHOT_DIR) return
  mkdirSync(process.env.CHIEF_SCREENSHOT_DIR, {recursive:true})
  await page.screenshot({path:join(process.env.CHIEF_SCREENSHOT_DIR, name + '.png'), fullPage:true})
}
const place = page => new URLSearchParams(new URL(page.url()).hash.slice(4))

try {
  codexStaff(host.brain)
  await host.start()
  await host.api('/settings/password', {password:randomUUID()})
  const {scope} = await host.api('/v2/bootstrap')
  const get = route => host.api(route + '?scope=' + encodeURIComponent(scope))
  browser = await chromium.launch({headless:true,...(process.env.CHIEF_CHROMIUM_PATH && {executablePath:process.env.CHIEF_CHROMIUM_PATH})})
  const desktop = await browser.newPage({viewport:{width:1440,height:900}, locale:'zh-CN'})
  desktop.on('pageerror', error => errors.push(error.message))
  desktop.setDefaultTimeout(20_000)
  await signIn(desktop,host)
  await desktop.goto(host.base)

  await newSpace(desktop,'试点研发','交给团队制作并验证报名页')
  const workspace = openWorkspace(desktop)
  const base = '/v2/workspaces/' + workspace
  await joinStaff(host,scope,workspace,[[CODEX_STAFF.id,'制作报名页与交接文稿']])
  // No order has delivered anything yet: the overview has no 「最近产物」 and the board says so.
  await desktop.getByRole('region',{name:'会话与工单'}).waitFor()
  assert.equal(await desktop.getByRole('region',{name:'最近产物'}).count(),0)
  assert.deepEqual((await get(base + '/outputs')).outputs,[])

  await createSession(desktop,'报名页实现')
  await createOrder(desktop,'整理交接清单')
  const checklistId = place(desktop).get('order')
  await openOrderSession(desktop)
  await say(desktop,'@' + CODEX_STAFF.name + ' 请把交接要点写成一份 Markdown 清单。')
  const said = desktop.getByRole('list',{name:'会话发言'})
  await said.getByRole('button',{name:'交接清单',exact:true}).waitFor({timeout:60_000})
  await backToOrder(desktop)
  await openOrderSession(desktop)
  await createOrder(desktop,'给周五试点做一个手机报名页')
  const pageId = place(desktop).get('order')
  await openOrderSession(desktop)
  await say(desktop,'@' + CODEX_STAFF.name + ' 请做好「周五试点」的手机报名页，让我能填写姓名并提交。',90_000)
  await said.getByRole('button',{name:'查看报名页源码',exact:true}).waitFor({timeout:60_000})
  await say(desktop,'@' + CODEX_STAFF.name + ' 修复按钮，让试点报名可以重新提交。',90_000)
  await until(async () => (await said.getByRole('button',{name:'查看报名页源码',exact:true}).count()) === 2,'修正版报名页的回复',60_000)
  passed('同一群里的两张工单各由 Codex 成员交出文件，报名页修正一次（同一个文件）')

  const project = await get(base)
  const sessionId = project.orders.find(order => order.id === pageId).sessionId
  assert.equal(project.orders.find(order => order.id === checklistId).sessionId,sessionId)
  const pageLines = (await get(base + '/sessions/' + sessionId)).messages.filter(m => m.attachments?.some(file => file.label === '查看报名页源码'))
  assert.equal(pageLines.length,2)
  const outputs = await get(base + '/outputs')
  assert.deepEqual(outputs.outputs.map(row => [row.label,row.orders.map(order => order.id),row.deliveredBy.map(person => person.name)]),
    [['查看报名页源码',[pageId],[CODEX_STAFF.name]],['交接清单',[checklistId],[CODEX_STAFF.name]]])
  assert.equal(outputs.outputs[0].messageId,pageLines.at(-1).id)
  assert.doesNotMatch(JSON.stringify(outputs),/index\.html|交接清单\.md/)
  assert.deepEqual((await get(base + '/orders/' + pageId + '/outputs')).outputs.map(row => row.messageId),[pageLines.at(-1).id])
  passed('工作区产物接口：两张工单的文件各一条、带工单与交付人，修正后的报名页只列一次且指向最新那次，不带文件路径；与工单交付一致')

  await desktop.goto(host.base + '/#v2?' + new URLSearchParams({scope,view:'workspace',workspace}))
  const recent = desktop.getByRole('region',{name:'最近产物'})
  await recent.getByRole('button',{name:/^查看报名页源码/}).waitFor()
  assert.equal(await recent.locator('.v2-output-row').count(),2)
  assert.match(await recent.textContent(),/给周五试点做一个手机报名页[\s\S]*整理交接清单/)
  const sections = await desktop.locator('[aria-label="项目目录"], [aria-label="最近产物"], [aria-label="会话与工单"]').evaluateAll(list => list.map(el => el.getAttribute('aria-label')))
  assert.deepEqual(sections,['项目目录','最近产物','会话与工单'])
  await picture(desktop,'outputs-overview-desktop')
  // On the overview a tag opens the order it names.
  await button(recent,'打开工单「整理交接清单」').click()
  await desktop.getByRole('heading',{name:'整理交接清单',exact:true,level:1}).waitFor()
  assert.equal(place(desktop).get('order'),checklistId)
  await desktop.goBack()
  await recent.getByRole('button',{name:/^查看全部（2）/}).click()
  assert.equal(place(desktop).get('panel'),'outputs')
  const nav = desktop.getByRole('navigation',{name:'工作区版面'})
  assert.deepEqual(await nav.getByRole('button').allTextContents(),['概览','执行','产物','幕僚'])
  assert.equal(await nav.getByRole('button',{name:'产物'}).getAttribute('aria-current'),'page')
  passed('概览在项目目录与会话之间列出最近产物（带工单名，点标签打开该工单），「查看全部（2）」进入子导航里的「产物」版面')

  const board = desktop.getByRole('region',{name:'产物',exact:true})
  const rows = board.locator('.v2-output-row')
  await board.getByRole('button',{name:/^交接清单/}).waitFor()
  await board.getByLabel('排序').selectOption('name')
  await board.getByLabel('按工单筛选').selectOption({label:'整理交接清单'})
  await until(async () => (await rows.count()) === 1,'按工单筛选只剩交接清单')
  await board.getByRole('button',{name:/^交接清单/}).waitFor()
  await board.getByLabel('按工单筛选').selectOption('')
  await until(async () => (await rows.count()) === 2,'取消工单筛选')
  await button(board,'只看工单「给周五试点做一个手机报名页」的产物').click()
  await until(async () => (await rows.count()) === 1,'点工单标签按工单筛选')
  assert.equal(await board.getByLabel('按工单筛选').inputValue(),pageId)
  await board.getByLabel('按交付人筛选').selectOption({label:CODEX_STAFF.name})
  await until(async () => (await rows.count()) === 1,'工单与交付人叠加筛选')
  await board.getByLabel('按工单筛选').selectOption('')
  await until(async () => (await rows.count()) === 2,'只按交付人筛选')
  await board.getByLabel('按交付人筛选').selectOption('')
  await picture(desktop,'outputs-board-desktop')
  passed('「产物」版面按名称排序、按工单、按交付人和点标签筛选，取消后回到全部')

  await board.getByRole('button',{name:/^交接清单/}).click()
  const reader = desktop.getByRole('dialog',{name:'交接清单'})
  await reader.getByText('核对交付日期').waitFor()
  await button(reader,'关闭详情').click()
  await board.getByRole('button',{name:/^查看报名页源码/}).click()
  const pageReader = desktop.getByRole('dialog',{name:'查看报名页源码'})
  const frame = pageReader.locator('iframe')
  await frame.waitFor()
  assert.equal(await frame.getAttribute('sandbox'),'')
  assert.match(await frame.getAttribute('srcdoc') ?? '',/已修正/)
  await button(pageReader,'关闭详情').click()
  await desktop.reload()
  await board.getByRole('button',{name:/^交接清单/}).waitFor()
  assert.equal(await nav.getByRole('button',{name:'产物'}).getAttribute('aria-current'),'page')
  await desktop.goBack()
  await desktop.getByRole('region',{name:'最近产物'}).waitFor()
  assert.equal(place(desktop).get('panel'),null)
  passed('点产物打开阅读：文稿可读，报名页是修正后的无脚本静态页；刷新后仍在「产物」版面，后退回到概览')

  const phone = await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN',isMobile:true,hasTouch:true})
  phone.on('pageerror', error => errors.push(error.message))
  await signIn(phone,host)
  await phone.goto(host.base + '/#v2?' + new URLSearchParams({scope,view:'workspace',workspace,panel:'outputs'}))
  const narrow = phone.getByRole('region',{name:'产物',exact:true})
  await narrow.getByRole('button',{name:/^交接清单/}).waitFor()
  await picture(phone,'outputs-board-narrow')
  passed('390 像素宽的页面上「产物」版面不横向溢出')
  assert.deepEqual(errors,[])
} finally {
  await browser?.close()
  await host.dispose()
}
