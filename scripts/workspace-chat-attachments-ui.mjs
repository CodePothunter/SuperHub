/**
 * Run the desktop DSH and authenticated phone composers against an isolated candidate. The existing model fixture
 * responds locally. Uploads, scoped reads, message persistence and request replay use the installed plugin.
 * CHIEF_ACCEPTANCE_PACKAGE=<tgz> CHIEF_PLAYWRIGHT_PATH=<playwright/index.mjs> [CHIEF_CHROMIUM_PATH=<binary>]
 * node scripts/workspace-chat-attachments-ui.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { button, signIn } from './workspace-browser-fixture.mjs'

const area = mkdtempSync(join(tmpdir(), 'chief-chat-input-ui-'))
const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const file = (name, content) => ({name, mimeType:'text/plain', buffer:Buffer.from(content)})
const image = {name:'sample.png', mimeType:'image/png',
  buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGMwyzr/59F2BggFADQsCAkWhEUKAAAAAElFTkSuQmCC', 'base64')}
const note = file('记录 & 1.txt', '合成记录，编号 317\n')
const extra = file('补充.txt', '留给下一条')
const removed = file('撤下.txt', '发送前移除')
const orderFile = file('a.csv', 'item,value\nalpha,82\n')
const privateFile = file('b.txt', '只用于本次接口人私聊')
const privateImage = {...image, name:'私聊.png'}
const isMessage = url => /\/sessions\/[^/]+\/messages\?/.test(url.pathname + url.search)
const isChat = url => url.pathname.endsWith('/chief/api/chat') && !url.search
const selected = form => form.locator('.chat-composer').getByRole('list', {name:'待发送附件'})

async function pick(page, form, files) {
  const chooser = page.waitForEvent('filechooser')
  await button(form, '添加文件或图片').click()
  const field = await chooser
  assert.ok(field.isMultiple())
  await field.setFiles(files)
}

async function ready(form) {
  await until(async () => button(form, '发送').isEnabled(), '附件完成上传').catch(async error => {
    throw Error(error.message + ' · ' + await form.innerText())
  })
}

async function downloads(page, link, expected) {
  const pending = page.waitForEvent('download')
  await link.click()
  const download = await pending
  assert.equal(download.suggestedFilename(), expected.name)
  assert.deepEqual(readFileSync(await download.path()), expected.buffer)
}

async function opensImage(page, link) {
  const pending = page.waitForEvent('popup')
  await link.click()
  const popup = await pending
  try {
    await popup.waitForLoadState('domcontentloaded')
    await until(async () => popup.locator('img').first().evaluate(img => img.naturalWidth > 0).catch(() => false), '打开消息原图')
  } finally { await popup.close() }
}

let browser, host
try {
  host = await acceptanceHost({directory:area, mobile:true, probe:'workspace-v2-probe.mjs'})
  await host.start()
  await host.api('/pause', {paused:true})
  const scope = (await host.api('/v2/bootstrap')).scope
  const post = (path, body) => host.api(path + '?scope=' + encodeURIComponent(scope), {...body, requestId:randomUUID()})
  const {workspace} = await post('/v2/workspaces', {name:'附件验收'})
  const path = '/v2/workspaces/' + encodeURIComponent(workspace.id)
  const {session:group} = await post(path + '/sessions', {title:'材料讨论'})
  const {session:orderGroup} = await post(path + '/sessions', {title:'工单讨论'})
  const {order} = await post(path + '/orders', {title:'材料核对', promise:'核对合成样例', sessionId:orderGroup.id})
  const password = randomUUID()
  await host.api('/settings/password', {password})
  browser = await chromium.launch({headless:true, ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath:process.env.CHIEF_CHROMIUM_PATH})})
  const desktop = await browser.newPage({viewport:{width:1280, height:900}, locale:'zh-CN'})
  const mobile = await browser.newPage({viewport:{width:390, height:844}, locale:'zh-CN', isMobile:true, hasTouch:true})
  await signIn(desktop, host)
  await mobile.goto(host.mobileBase)
  await mobile.getByLabel('密码').fill(password)
  await button(mobile, '进入').click()
  await mobile.getByRole('heading', {name:'今天', exact:true}).waitFor()

  async function open(page, where) {
    const origin = page === desktop ? host.base : host.mobileBase
    const route = where === 'group' ? {view:'workspace', workspace:workspace.id, panel:'execution', session:group.id}
      : where === 'order' ? {view:'workspace', workspace:workspace.id, order:order.id} : {view:'today'}
    await page.goto(origin + '/#v2?' + new URLSearchParams({scope, ...route}))
    if (where === 'private') await page.getByRole('button', {name:/^一句话交办/}).first().click()
    else await page.getByRole('heading', {name:where === 'group' ? group.title : order.title, exact:true}).first().waitFor()
    const text = page.getByRole('textbox', {name:where === 'private' ? '对接口人说' : '发言', exact:true})
    const form = text.locator('xpath=ancestor::form[1]')
    const composer = form.locator('.chat-composer')
    const add = button(composer, '添加文件或图片'), send = button(composer, '发送')
    await until(async () => add.isEnabled(), '附件输入框')
    assert.equal(await composer.getByRole('textbox').count(), 1, '正文和附件控件共用一个输入区')
    assert.equal(await text.evaluate(field => getComputedStyle(field).borderTopWidth), '0px', '正文没有独立边框')
    const [inputBox, addBox, sendBox] = await Promise.all([text.boundingBox(), add.boundingBox(), send.boundingBox()])
    assert.ok(inputBox && addBox && sendBox && addBox.y >= inputBox.y + inputBox.height &&
      Math.abs(sendBox.y - addBox.y) < 1 && sendBox.x > addBox.x, '加号和发送箭头在正文的下方同一栏')
    if (page === mobile) assert.ok(addBox.height >= 44 && sendBox.height >= 44, '手机工具按钮保留可点按面积')
    return {form, text}
  }

  const d = await open(desktop, 'group')
  await pick(desktop, d.form, [note, image, removed])
  await ready(d.form)
  await button(d.form, '移除 ' + removed.name).click()
  assert.equal(await selected(d.form).getByRole('listitem').count(), 2)
  await d.text.fill('@')
  const mentions = d.form.getByRole('listbox', {name:'提及成员'})
  await mentions.waitFor()
  const menuBox = await mentions.boundingBox(), composerBox = await d.form.locator('.chat-composer').boundingBox()
  assert.ok(menuBox && composerBox && menuBox.y + menuBox.height <= composerBox.y, '点名菜单展开在待发附件上方')
  await d.text.press('Escape')
  await d.text.fill('@接口人 请看这份材料。')
  // The host accepts this request before the browser sees the response. Edits and files added here belong to the next send.
  const accepted = Promise.withResolvers(), release = Promise.withResolvers()
  const held = async route => {
    const response = await route.fetch()
    accepted.resolve({status:response.status(), sent:route.request().postDataJSON()})
    await release.promise
    await route.fulfill({response})
  }
  await desktop.route(isMessage, held)
  await d.text.press('Control+Enter')
  const first = await accepted.promise
  try {
    assert.equal(first.status, 200)
    assert.equal(first.sent.inputAttachments.length, 2)
    await pick(desktop, d.form, [extra])
    await d.text.fill('@接口人 请看这份材料。 下一条')
  } finally { release.resolve() }
  await until(async () => await d.text.inputValue() === '下一条', '保留发送时新写的文字')
  await desktop.unroute(isMessage, held)
  assert.equal(await selected(d.form).getByRole('listitem').count(), 1)
  await button(d.form, '移除 ' + extra.name).waitFor()
  console.log('通过 · 桌面工作区混发、移除、键盘发送及发送中追加')

  const m = await open(mobile, 'group')
  const markup = mobile.getByRole('list', {name:'消息附件'}).filter({has:mobile.getByRole('link', {name:'下载 ' + note.name})})
  await markup.waitFor()
  assert.equal(await markup.getByRole('link').count(), 2)
  assert.equal(await mobile.getByText(removed.name, {exact:true}).count(), 0)
  await downloads(mobile, markup.getByRole('link', {name:'下载 ' + note.name}), note)
  await opensImage(mobile, markup.getByRole('link', {name:'查看图片 ' + image.name}))
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  console.log('通过 · 手机从桌面消息重新打开图片、下载原件')

  const o = await open(mobile, 'order')
  // Start with one rejected upload. Only this file must be retried and the text may remain empty.
  const isOrderUpload = url => url.pathname.endsWith('/input-attachments') && url.searchParams.get('name') === orderFile.name
  await mobile.route(isOrderUpload, route => route.abort('internetdisconnected'), {times:1})
  await pick(mobile, o.form, [orderFile])
  await button(o.form, '重新上传 ' + orderFile.name).waitFor()
  assert.ok(await button(o.form, '发送').isDisabled())
  await button(o.form, '重新上传 ' + orderFile.name).click()
  await ready(o.form)
  const sent = mobile.waitForRequest(req => req.method() === 'POST' && isMessage(new URL(req.url())))
  await button(o.form, '发送').tap()
  const submitted = (await sent).postDataJSON()
  assert.equal(submitted.text, '')
  assert.equal(submitted.workOrderId, order.id)
  await mobile.getByRole('link', {name:'下载 ' + orderFile.name}).waitFor()
  // A group upload may finish at the host just as its composer closes. It cannot put a handle into another order.
  const last = file('切页.txt', '独立群的草稿'), uploaded = Promise.withResolvers(), deliver = Promise.withResolvers()
  const isLast = url => url.pathname.endsWith('/input-attachments') && url.searchParams.get('name') === last.name
  await desktop.route(isLast, async route => {
    const response = await route.fetch()
    uploaded.resolve(response.status())
    await deliver.promise
    await route.fulfill({response}).catch(() => {})
  }, {times:1})
  await pick(desktop, d.form, [last])
  assert.equal(await uploaded.promise, 201)
  assert.ok(await button(d.form, '发送').isDisabled())
  const onDesktop = await open(desktop, 'order').finally(() => deliver.resolve())
  assert.equal(await selected(onDesktop.form).count(), 0)
  assert.equal(await onDesktop.text.inputValue(), '')
  const orderDownload = desktop.getByRole('link', {name:'下载 ' + orderFile.name})
  await orderDownload.waitFor()
  assert.equal(new URL(await orderDownload.getAttribute('href')).searchParams.get('workOrderId'), order.id)
  await downloads(desktop, orderDownload, orderFile)
  console.log('通过 · 手机工单仅发附件、逐件重试、桌面回看及上传中切换工单')

  const p = await open(desktop, 'private')
  await pick(desktop, p.form, [privateFile])
  await ready(p.form)
  const ids = []
  // A lost successful response is replayed with the identical request and original attachment.
  const dropped = async route => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON()
    ids.push(body.request_id)
    const response = await route.fetch()
    assert.ok(response.ok(), '接口人收件 ' + response.status() + ' ' + await response.text())
    if (ids.length === 1) await route.abort('failed')
    else await route.fulfill({response})
  }
  await desktop.route(isChat, dropped)
  await p.text.press('Enter')
  await p.form.getByRole('alert').filter({hasText:'连接不上主机'}).waitFor()
  assert.equal(await selected(p.form).getByRole('listitem').count(), 1)
  await button(p.form, '发送').click()
  await selected(p.form).waitFor({state:'detached'})
  await desktop.unroute(isChat, dropped)
  assert.equal(ids.length, 2)
  assert.equal(ids[0], ids[1])
  const phonePrivate = await open(mobile, 'private')
  const privateLink = mobile.getByRole('dialog', {name:'接口人'}).getByRole('link', {name:'下载 ' + privateFile.name})
  await privateLink.waitFor()
  assert.equal(await privateLink.count(), 1)
  await downloads(mobile, privateLink, privateFile)
  await phonePrivate.text.fill('继续看看刚才的材料。')
  await ready(phonePrivate.form)
  await phonePrivate.text.press('Enter')
  await until(async () => await phonePrivate.text.inputValue() === '', '手机继续私聊')
  await pick(mobile, phonePrivate.form, [privateImage, note])
  await phonePrivate.text.fill('看看新附的图和记录。')
  await ready(phonePrivate.form)
  assert.equal(await selected(phonePrivate.form).getByRole('listitem').count(), 2)
  const thumbnail = selected(phonePrivate.form).getByRole('img', {name:privateImage.name})
  await until(async () => thumbnail.evaluate(img => img.naturalWidth > 0), '手机能显示发送前的原图缩略图')
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  const response = mobile.waitForResponse(res => res.request().method() === 'POST' && isChat(new URL(res.url())))
  await button(phonePrivate.form, '发送').tap()
  const receipt = await response
  assert.ok(receipt.ok(), '手机接口人混发 · ' + receipt.status() + ' ' + await receipt.text())
  await selected(phonePrivate.form).waitFor({state:'detached'})
  await desktop.reload()
  await open(desktop, 'private')
  const fromMobile = desktop.getByRole('list', {name:'消息附件'}).filter({has:desktop.getByRole('link', {name:'查看图片 ' + privateImage.name})})
  await fromMobile.waitFor()
  await opensImage(desktop, fromMobile.getByRole('link', {name:'查看图片 ' + privateImage.name}))
  await downloads(desktop, fromMobile.getByRole('link', {name:'下载 ' + note.name}), note)
  console.log('通过 · 接口人仅附件、回执丢失后去重、手机追问与混发、桌面重开原件')
} finally {
  await browser?.close()
  await host?.dispose()
  rmSync(area, {recursive:true, force:true})
}
