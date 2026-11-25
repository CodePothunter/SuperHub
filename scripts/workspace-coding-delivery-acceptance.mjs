/**
 * Install the exact candidate in an isolated DSH. Code authors are protocol fixtures; both browser paths are real.
 * Sessions are group chats: a Codex staff member builds the deliverables when the owner @-mentions it, and the files it
 * links reach the owner's 「工单交付」 inbox (tray, read state, 定位原话 into the group, mobile, restart). The signup-page
 * preview, trial fill and the delivery check's repair rounds are retired (2026-11-24).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { button, backToOrder, CODEX_STAFF, codexStaff, createOrder, createSession, joinStaff, openOrderInfo, openOrderSession, openWorkspace, newSpace, providerBinaries, say, signIn } from './workspace-browser-fixture.mjs'

const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const host = await acceptanceHost({probe:'workspace-v2-probe.mjs',mobile:true,extraEnv:{PATH:providerBinaries() + delimiter + process.env.PATH}})
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE
const clientFile = join(host.home,'profiles/web/node_modules/dsh-chief/lib/client.js')
assert.equal(statSync(clientFile).nlink,1,'隔离宿主的客户端不能与其他安装共享硬链接')
const clientSha256 = sha256(readFileSync(clientFile))
assert.equal(clientSha256,sha256(execFileSync('tar',['-xOzf',candidate,'package/lib/client.js'], {maxBuffer:16*1024*1024})))
const evidence = {sha256:sha256(readFileSync(candidate)), clientSha256, checks:[]}
const passed = text => { evidence.checks.push(text); console.log('PASS ' + text) }
const errors = []
let browser

async function picture(page, name) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  if (!process.env.CHIEF_SCREENSHOT_DIR) return
  mkdirSync(process.env.CHIEF_SCREENSHOT_DIR, {recursive:true})
  await page.screenshot({path:join(process.env.CHIEF_SCREENSHOT_DIR, name + '.png')})
}
try {
  codexStaff(host.brain)
  await host.start()
  const password = randomUUID()
  await host.api('/settings/password', {password})
  const {scope} = await host.api('/v2/bootstrap')
  const query = '?scope=' + encodeURIComponent(scope)
  const get = route => host.api(route + query)
  const set = (route,body) => host.api(route + query, {requestId:randomUUID(),...body})
  browser = await chromium.launch({headless:true,...(process.env.CHIEF_CHROMIUM_PATH && {executablePath:process.env.CHIEF_CHROMIUM_PATH})})
  const desktop = await browser.newPage({viewport:{width:1440,height:900}, locale:'zh-CN'})
  desktop.on('pageerror', error => errors.push(error.message))
  desktop.setDefaultTimeout(20_000)
  await signIn(desktop,host)
  await desktop.goto(host.base)
  assert.deepEqual((await get('/v2/workspaces')).workspaces,[])
  await button(desktop,/^一句话交办(，|$)/).click()
  const liaison = desktop.getByRole('dialog',{name:'接口人'})
  const firstAsk = '请让 Codex 做一个手机报名页，我想自己试填一下。'
  const polls = []
  const orderReceipts = chat => [...(Array.isArray(chat?.messages) ? chat.messages : []), ...(chat?.live ? [chat.live] : [])]
    .flatMap(message => message?.workspaces ?? []).filter(row => row?.delegationId)
  const observeChat = async response => {
    if (new URL(response.url()).pathname !== '/chief/api/chat') return
    const chat = await response.json().catch(() => ({}))
    polls.push({method:response.request().method(), status:response.status(), messages:chat?.messages?.length,
      live:!!chat?.live, orders:orderReceipts(chat).map(row => row.delegationId)})
  }
  desktop.on('response', observeChat)
  try {
    await liaison.getByLabel('对接口人说').fill(firstAsk)
    await button(liaison,'发送').click()
    await liaison.getByRole('button',{name:/打开工单/}).click({timeout:90_000})
    const receipt = await until(async () => orderReceipts(await get('/chat')).find(row => row.delegationTitle === '手机试点报名页'), '接口人的原始工单回执')
    const opened = new URLSearchParams(new URL(desktop.url()).hash.slice(4))
    assert.equal(opened.get('workspace'),receipt.id)
    assert.equal(opened.get('order'),receipt.delegationId)
    const original = await get('/v2/workspaces/'+receipt.id+'/orders/'+receipt.delegationId+'/original')
    assert.deepEqual(original.original,{text:firstAsk,complete:true})
    const disclosure = desktop.locator('details.v2-order-original')
    await disclosure.getByText('原始交办',{exact:true}).waitFor()
    assert.equal(await disclosure.getAttribute('open'),null)
    await disclosure.locator('summary').click()
    await disclosure.getByText(firstAsk,{exact:true}).waitFor()
    await disclosure.locator('summary').click()
  } catch (cause) {
    const hostOrders = await get('/chat').then(chat => orderReceipts(chat).map(row => row.delegationId)).catch(error => error.message)
    const screen = await desktop.evaluate(() => ({visibility:document.visibilityState, hash:location.hash,
      dialog:document.querySelector('dialog[open]')?.getAttribute('aria-label'),
      status:document.querySelector('.v2-liaison [role="status"]')?.textContent,
      alerts:[...document.querySelectorAll('[role="alert"]')].map(el => el.textContent)}))
    throw new Error('接口人工单回执未核对 ' + JSON.stringify({screen, hostOrders, polls, errors}), {cause})
  } finally { desktop.off('response', observeChat) }
  // The liaison hands the order into a group (the executor it names is ignored there) and is called to dispatch it.
  const firstOrder = new URLSearchParams(new URL(desktop.url()).hash.slice(4))
  const handed = desktop.getByRole('list',{name:'会话发言'}).locator('details.v2-relay-quote')
  await handed.first().waitFor()
  const firstView = await get('/v2/workspaces/'+firstOrder.get('workspace'))
  const firstSession = firstView.sessions.find(row => row.delegationIds.includes(firstOrder.get('order')))
  assert.equal(firstSession?.engine,'roster')
  passed('从空白脑的今天一句话交给接口人，工单进入群聊，接口人带着主人原话被叫来派活')
  await newSpace(desktop,'试点研发','交给团队制作并验证报名页')
  await joinStaff(host,scope,openWorkspace(desktop),[[CODEX_STAFF.id,'制作报名页与交接文稿']])
  await createSession(desktop,'报名页实现')
  await createOrder(desktop,'整理交接清单')
  const checklistHash = new URL(desktop.url()).hash
  await openOrderSession(desktop)
  await say(desktop,'@' + CODEX_STAFF.name + ' 请把交接要点写成一份 Markdown 清单。')
  await desktop.getByRole('list',{name:'会话发言'}).getByRole('button',{name:'交接清单'}).waitFor({timeout:60_000})
  await backToOrder(desktop)
  const files = desktop.getByRole('region',{name:'交付成果'})
  await button(files,'交接清单').click()
  const checklist = desktop.getByRole('dialog',{name:'交接清单'})
  await checklist.getByText('核对交付日期').waitFor()
  await button(checklist,'关闭详情').click()
  const checklistId = new URLSearchParams(checklistHash.slice(4)).get('order')
  // The member's line that linked the file is a 「工单交付」 notice bound to the order, the group and that line.
  const resultReceipt = await until(async () => (await get('/v2/notices')).items.find(row => row.orderId === checklistId && row.title === '交接清单'), '原工单的站内交付提醒')
  assert.equal(resultReceipt.read,false)
  assert.match(resultReceipt.messageId,/^g-\d+$/)
  await desktop.getByRole('button',{name:/\d+ 条新交付/}).click()
  let tray = desktop.getByRole('region',{name:'工单交付提醒'})
  await tray.getByRole('button',{name:/交接清单/}).click()
  await checklist.getByText('核对交付日期').waitFor()
  await until(async () => (await get('/v2/notices/'+resultReceipt.id)).notice.read,'主人打开后登记已读')
  await button(checklist,'定位原话').click()
  const sourceLine = desktop.locator('li.v2-source-turn[data-message-id="' + resultReceipt.messageId + '"]')
  await sourceLine.waitFor()
  assert.match(await sourceLine.textContent(),/交接清单/)
  const sourceLocation = new URLSearchParams(new URL(desktop.url()).hash.slice(4))
  assert.equal(sourceLocation.get('order'),checklistId)
  assert.equal(sourceLocation.get('message'),resultReceipt.messageId)
  assert.equal(sourceLocation.get('session'),resultReceipt.sessionId)
  await backToOrder(desktop)
  await openOrderSession(desktop)
  await createOrder(desktop,'给周五试点做一个手机报名页')
  passed('从同一个新建工单表单交办文稿和网页，两单归入同一群聊。成员交回的文稿进「工单交付」：从其他版面看到未读，读后登记已读，定位原话回到群里那一行')
  const hash = new URL(desktop.url()).hash
  const params = new URLSearchParams(hash.slice(4))
  const workspace = params.get('workspace'), delegation = params.get('order')
  assert.ok(workspace && delegation)
  const base = '/v2/workspaces/' + workspace
  const jobPath = base + '/orders/' + delegation
  // The retired delivery check (candidates, preview, trial registrations) has no routes any more.
  await assert.rejects(get(jobPath + '/delivery'),{status:404})
  await openOrderSession(desktop)
  await say(desktop,'@' + CODEX_STAFF.name + ' 请做好「周五试点」的手机报名页，让我能填写姓名并提交。',90_000)
  const messages = desktop.getByRole('list',{name:'会话发言'})
  await button(messages,'查看报名页源码').click({timeout:60_000})
  const document = desktop.getByRole('dialog',{name:'查看报名页源码'})
  // The page the member linked opens as a static, script-free document.
  assert.equal(await document.locator('iframe').getAttribute('sandbox'),'')
  await button(document,'关闭详情').click()
  await picture(desktop,'coding-delivery-desktop')
  passed('Codex 群成员在群的工作目录里写出报名页并在回复里链接，网页附件以无脚本的静态文档打开')
  const own = await get(jobPath + '/outputs')
  assert.deepEqual(own.outputs.map(row => row.attachment.label),['查看报名页源码'])
  const otherId = new URLSearchParams(checklistHash.slice(4)).get('order')
  const other = await get(base+'/orders/'+otherId+'/outputs')
  assert.deepEqual(other.outputs.map(row => row.attachment.label),['交接清单'])
  const project = await get(base)
  const sessionId = project.orders.find(order => order.id === delegation).sessionId
  assert.equal(project.orders.filter(order => order.sessionId === sessionId).length,2)
  assert.equal(project.sessions.find(row => row.id === sessionId).engine,'roster')
  passed('两张工单的交付按工单区分：各自只列本单成员链接的文件')
  const mobile = await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN',isMobile:true,hasTouch:true})
  mobile.on('pageerror', error => errors.push(error.message))
  await mobile.bringToFront()
  await mobile.goto(host.mobileBase)
  await mobile.getByLabel('密码').fill(password)
  await button(mobile,'进入').click()
  await mobile.getByRole('heading',{name:'今天',exact:true}).waitFor()
  // The same notice, already read on the desktop, opens on the phone and leads back to its order.
  tray = mobile.getByRole('region',{name:'工单交付提醒'})
  await button(tray,'查看已读').click()
  await tray.getByRole('button',{name:/交接清单/}).click()
  const mobileReport = mobile.getByRole('dialog',{name:'交接清单'})
  await mobileReport.getByText('核对交付日期').waitFor()
  await button(mobileReport,'打开工单').click()
  assert.equal(new URLSearchParams(new URL(mobile.url()).hash.slice(4)).get('order'),checklistId)
  await button(mobile,'今天').click()
  await mobile.getByRole('button',{name:/试点研发.*交给团队制作并验证报名页/}).click()
  await mobile.getByRole('button',{name:/给周五试点做一个手机报名页/}).click()
  await openOrderInfo(mobile)
  const mobileFiles = mobile.getByRole('region',{name:'交付成果'})
  await button(mobileFiles,'查看报名页源码').click()
  await mobile.getByRole('dialog',{name:'查看报名页源码'}).locator('iframe').waitFor()
  await picture(mobile,'coding-delivery-mobile')
  await button(mobile.getByRole('dialog',{name:'查看报名页源码'}),'关闭详情').click()
  await say(mobile,'@' + CODEX_STAFF.name + ' 修复按钮，让试点报名可以重新提交。',90_000)
  const turns = mobile.getByRole('list',{name:'会话发言'})
  await until(async () => (await turns.getByRole('button',{name:'查看报名页源码'}).count()) === 2,'手机上的修正版本回复', 60_000)
  await button(mobile,'关闭会话').click()
  await button(mobile.getByRole('dialog'),'确认关闭').click()
  await mobile.getByText(/群聊 · 你和 \d+ 位成员 · 已关闭/).first().waitFor()
  const fixed = await get(jobPath + '/outputs')
  assert.equal(fixed.outputs.length,2)
  passed('真实密码手机入口读到同一份已读交付并回到原单，打开工单的交付，在群里让 Codex 成员修正后关闭会话，工单仍列出两次交付')

  const second = (await set('/v2/workspaces',{name:'独立试点'})).workspace
  await assert.rejects(get('/v2/workspaces/' + second.id + '/sessions/' + sessionId),{status:404})
  const attachment = own.outputs[0].attachment.id
  assert.equal((await host.request('/chief/api'+base+'/sessions/'+sessionId+'/attachments/'+attachment+query,undefined,{raw:true,login:''})).status,401)
  await host.stop()
  await host.start()
  await desktop.bringToFront()
  await signIn(desktop,host)
  await desktop.goto(host.base + '/' + hash)
  await button(desktop.getByRole('region',{name:'交付成果'}),'查看报名页源码').first().waitFor()
  assert.equal((await get(base+'/sessions/'+sessionId+'/attachments/'+attachment)).attachment.format,'html')
  const afterRestartNotices = (await get('/v2/notices')).items.filter(row => row.orderId === checklistId)
  assert.deepEqual(afterRestartNotices.map(row => [row.id,row.read]),[[resultReceipt.id,true]])
  const kept = await get('/v2/notices/'+resultReceipt.id+'/attachments/'+resultReceipt.attachments[0].id)
  assert.match(kept.attachment.content,/核对交付日期/)
  passed('重启后能打开原工单和成员交付的网页，交付提醒保持唯一且已读，越区或匿名请求被拒绝')
  await openOrderSession(desktop)
  await button(desktop,'恢复会话').click()
  await backToOrder(desktop)
  await button(desktop,'暂停工单').click()
  await button(desktop,'恢复工单').waitFor()
  await desktop.getByText('工单已暂停').first().waitFor()
  await assert.rejects(set(base+'/sessions/'+sessionId+'/messages',{workOrderId:delegation,text:'@' + CODEX_STAFF.name + ' 再改一版'}),{status:409})
  passed('暂停后工单的交付仍可查看，群里为这张工单的发言被拒绝')
  assert.deepEqual(errors,[])
  if (process.env.CHIEF_CODING_DELIVERY_EVIDENCE) {
    const path = process.env.CHIEF_CODING_DELIVERY_EVIDENCE
    mkdirSync(dirname(path),{recursive:true})
    writeFileSync(path,JSON.stringify(evidence,null,2) + '\n')
  }
} finally {
  await browser?.close()
  await host.stop()
}
