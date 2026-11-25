/** The two real authenticated transports render the same settings page with different capabilities. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost } from './acceptance-host.mjs'
import { button, createOrder, newSpace, signIn } from './workspace-browser-fixture.mjs'

const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const host = await acceptanceHost({ mobile:true, probe:'workspace-v2-probe.mjs' })
const checks = []
const errors = []
let browser, activePage
function inspect(page) {
  activePage = page
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => errors.push(error.message))
}
async function shot(page,name) {
  assert.ok(await page.locator('.v2-page').evaluate(el => el.scrollWidth <= el.clientWidth + 1))
  if (process.env.CHIEF_SCREENSHOT_DIR) {
    mkdirSync(process.env.CHIEF_SCREENSHOT_DIR,{recursive:true})
    await page.screenshot({path:join(process.env.CHIEF_SCREENSHOT_DIR, name + '.png')})
  }
}
function passed(label) { checks.push(label); console.log('PASS ' + label) }
try {
  await host.start()
  const password = randomUUID()
  await host.api('/settings/password',{password})
  const {scope} = await host.api('/v2/bootstrap')
  const resource = '/v2/settings?scope=' + encodeURIComponent(scope)
  const deskView = await host.api(resource)
  assert.ok(deskView.admin.settings.brain && deskView.admin.staff.length)
  await assert.rejects(host.api('/settings?scope=stale-settings',{concurrency:6}),{status:409})
  assert.equal((await host.api(resource)).concurrency,deskView.concurrency)
  browser = await chromium.launch({headless:true,...process.env.CHIEF_CHROMIUM_PATH && {executablePath:process.env.CHIEF_CHROMIUM_PATH}})
  const desktop = await browser.newPage({viewport:{width:1440,height:900}, locale:'zh-CN'})
  inspect(desktop)
  await signIn(desktop,host)
  await desktop.goto(host.base)
  await newSpace(desktop,'设置验收','从打开的真实工单进出设置')
  await createOrder(desktop,'准备本周资料','一份资料','接口人')
  const orderHash = new URL(desktop.url()).hash
  await button(desktop,'设置').focus()
  await desktop.keyboard.press('Enter')
  await desktop.getByRole('heading',{name:'设置',level:1}).waitFor()
  await desktop.getByLabel('接口人模型',{exact:true}).waitFor()
  await button(desktop,'我的幕僚').click()
  const member = deskView.admin.staff[0]
  await button(desktop,member.name).waitFor()
  await button(desktop,'返回').click()
  await desktop.getByLabel('时区',{exact:true}).fill('Etc/UTC')
  const concurrency = deskView.concurrency === 3 ? 2 : 3
  const form = desktop.getByRole('region',{name:'接口人与团队'})
  await form.getByLabel('同时工作的幕僚').fill(String(concurrency))
  const pending = desktop.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/chief/api/settings')
  await button(form,'保存团队设置').click()
  assert.deepEqual((await pending).postDataJSON(),{concurrency})
  await desktop.getByText('接口人与团队设置已保存。',{exact:true}).waitFor()
  assert.equal(await desktop.getByLabel('时区',{exact:true}).inputValue(),'Etc/UTC')
  await button(desktop,'保存时间与提醒').click()
  await desktop.getByText('时间与提醒已保存。',{exact:true}).waitFor()
  await desktop.reload()
  await desktop.getByLabel('时区',{exact:true}).waitFor()
  assert.equal(await desktop.getByLabel('时区',{exact:true}).inputValue(),'Etc/UTC')
  assert.equal(await desktop.getByLabel('同时工作的幕僚').inputValue(),String(concurrency))
  await shot(desktop,'settings-desktop-light')
  await desktop.evaluate(() => document.body.setAttribute('data-ds-dark-theme','dark'))
  await shot(desktop,'settings-desktop-dark')
  await button(desktop,'返回').click()
  await desktop.getByRole('heading',{name:'准备本周资料',level:1}).waitFor()
  assert.equal(new URL(desktop.url()).hash,orderHash)
  assert.equal(await button(desktop,'设置').evaluate(el => document.activeElement === el),true)
  passed('桌面按分组保存并读回，只提交变更字段，保留另一组输入；可回到上一张工单及原焦点')

  for (const width of [390,320]) {
    const mobile = await browser.newPage({viewport:{width,height:800},isMobile:true,hasTouch:true,locale:'zh-CN',colorScheme:width === 390 ? 'dark' : 'light'})
    inspect(mobile)
    await mobile.goto(host.mobileBase)
    await mobile.getByLabel('密码').fill(password)
    await button(mobile,'进入').click()
    await mobile.getByRole('heading',{name:'今天',exact:true}).waitFor()
    await button(mobile.getByRole('navigation',{name:'日常入口'}),'日历').click()
    await mobile.getByRole('heading',{name:'日历',level:1}).waitFor()
    const prior = new URL(mobile.url()).hash
    const reads = []
    mobile.on('request',req => { if (req.url().includes('/chief/api/')) reads.push(new URL(req.url()).pathname) })
    await button(mobile,'设置').click()
    await mobile.getByRole('heading',{name:'设置',level:1}).waitFor()
    const signOut = mobile.getByRole('link',{name:'退出本机登录'})
    await signOut.waitFor()
    await mobile.getByText('Etc/UTC',{exact:true}).waitFor()
    await mobile.getByText(concurrency + ' 位',{exact:true}).waitFor()
    assert.equal(await mobile.getByLabel('推送地址',{exact:true}).count(),0)
    assert.equal(await mobile.getByRole('textbox').count(),0)
    assert.ok(!reads.includes('/chief/api/state') && !reads.includes('/chief/api/settings') && !reads.includes('/chief/api/models'))
    const access = await mobile.evaluate(async ({resource,scope}) => {
      const root = '/chief/api'
      const response = await fetch(root + resource)
      const reads = await Promise.all(['/settings','/v2/settings?scope=stale'].map(path => fetch(root + path)))
      const write = await fetch(root + '/v2/settings?scope=' + scope, {method:'POST',headers:{'content-type':'application/json','x-chief-request':'1'},body:'{}'})
      return {value:await response.json(),denied:reads.map(r => r.status),write:write.status}
    },{resource,scope})
    const fields = Object.keys(access.value)
    assert.ok(fields.every(key => ['scope','timeZone','activeModel','concurrency'].includes(key)))
    assert.equal(access.value.scope,scope)
    assert.equal(access.value.concurrency,concurrency)
    assert.deepEqual(access.denied,[403,409])
    assert.equal(access.write,405)
    await shot(mobile,'settings-mobile-' + width)
    await mobile.goBack()
    await mobile.getByRole('heading',{name:'日历',level:1}).waitFor()
    assert.equal(new URL(mobile.url()).hash,prior)
    await button(mobile,'设置').click()
    await signOut.click()
    await mobile.getByLabel('密码').waitFor()
    const denied = await mobile.evaluate(async resource => (await fetch('/chief/api' + resource)).status,resource)
    assert.equal(denied,401)
    await mobile.close()
    passed(width + ' 像素手机真实密码入口只收到可公开的设置，返回日历并退出后会话失效')
  }
  assert.deepEqual(errors,[])
  if (process.env.CHIEF_SETTINGS_UI_EVIDENCE) writeFileSync(process.env.CHIEF_SETTINGS_UI_EVIDENCE,JSON.stringify({checks},null,2))
} catch (error) {
  if (activePage && !activePage.isClosed()) console.error((await activePage.locator('.v2-page').ariaSnapshot().catch(() => '')).slice(-2200))
  throw error
} finally {
  await browser?.close()
  await host.stop()
}
