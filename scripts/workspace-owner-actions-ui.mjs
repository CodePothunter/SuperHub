/** CHIEF_LIB_DIR points to the isolated build. CHIEF_PLAYWRIGHT_PATH points to Playwright's index.mjs. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const scope = 'owner-action-browser'
const at = '2026-11-25T08:00:00Z'
const workspaces = [['design','设计审查'], ['other','另一个工作区']].map(([id,name]) => ({id, name, createdAt:at, goal:'', owner:'我'}))
const session = {id:'draft', workspaceId:'design', title:'报告草案', createdAt:at, kind:'group', engine:'roster', executor:'dsh', delegationIds:[], closed:false}
const question = {id:'recipient', workspaceId:'design', sessionId:session.id, messageId:'g-12', question:'报告给哪一组同事使用？',
  workspaceName:'设计审查', sessionTitle:session.title, at}
const second = {...question, id:'deadline', messageId:'g-13', question:'报告在什么时间前需要送达？'}
const messages = [question, second].map(({messageId,question},i) => ({id:messageId, seq:12+i, kind:'message', text:question, at, author:'接口人', role:'agent'}))
const counts = {room:0, person:0, commitment:0, line:0, meeting:0, project:0, goal:0, document:0}
let items = [question, second]
let unread = 1
let approvalUnavailable = false
const replies = []
const send = (res, body) => {
  res.writeHead(200, {'content-type':'application/json; charset=utf-8', 'cache-control':'no-store'})
  res.end(JSON.stringify({scope,...body}))
}
const fail = (res, status, error) => {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8'})
  res.end(JSON.stringify({error}))
}

const staticTypes = {'index.html':'text/html', 'app.js':'text/javascript', 'page.css':'text/css',
  'manifest.webmanifest':'application/manifest+json', 'icon.svg':'image/svg+xml'}
const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost')
  const root = '/chief/api'
  const {pathname} = url
  if (pathname === root + '/v2/bootstrap') return send(res, {configure:false, build:'dev'})
  if (pathname.startsWith(root) && url.searchParams.get('scope') !== scope) return fail(res,409,'工作区归属已改变')
  if (pathname === root + '/v2/workspaces') return send(res, {workspaces})
  if (pathname === root + '/v2/workspaces/design') return send(res, {workspace:workspaces[0], orders:[], decisions:[], sessions:[session]})
  if (pathname === root + '/v2/workspaces/other') return send(res, {workspace:workspaces[1], orders:[], decisions:[], sessions:[]})
  if (pathname === root + '/v2/workspaces/design/sessions/draft') return send(res, {session, messages, observedAt:Date.now(),
    group:{members:[{id:'liaison', speakerId:'s-' + 'a'.repeat(24), name:'接口人', admin:true, kind:'dsh', status:'idle', queued:0}], approvals:[]}})
  if (pathname === root + '/v2/workspaces/design/sessions/draft/execution') return send(res, {workspaceId:'design', sessionId:'draft', commands:[], runs:[]})
  if (pathname === root + '/v2/history') return send(res, {total:0, available:0, items:[], counts})
  if (pathname === root + '/v2/approvals') return approvalUnavailable ? fail(res,503,'暂时无法读取审批') : send(res,{approvals:[]})
  if (pathname === root + '/v2/notices') return send(res, {total:0, unread:0, items:[]})
  if (pathname === root + '/chat/unread') return send(res, {unread})
  if (pathname === root + '/chat') return send(res, {sessionId:'private', busy:false, messages:[], notices:[], observedAt:Date.now()})
  if (pathname === root + '/chat/seen' && req.method === 'POST') { req.resume(); unread = 0; return send(res,{seenAt:Date.now()}) }
  if (pathname === root + '/v2/owner-actions') return send(res,{items})
  if (pathname === root + '/v2/owner-actions/recipient/reply' && req.method === 'POST') {
    if (req.headers['x-chief-request'] !== '1') return fail(res,400,'请求标记缺失')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    replies.push(body)
    if (replies.length === 1) return fail(res,503,'暂时未能确认答复，请重试')
    return send(res,{ok:true})
  }
  const filename = pathname === '/chief/m/' ? 'index.html' : pathname.split('/').at(-1)
  if (!Object.hasOwn(staticTypes,filename)) return fail(res,404,'没有该入口')
  res.writeHead(200,{'content-type':staticTypes[filename]})
  res.end(readFileSync(join(process.env.CHIEF_LIB_DIR ?? 'lib','mobile',filename)))
})

await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
let browser
try {
  browser = await chromium.launch({headless:true, ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath:process.env.CHIEF_CHROMIUM_PATH})})
  const base = `http://127.0.0.1:${server.address().port}/chief/m/`
  for (const [width,height] of [[1440,900],[390,844],[320,568]]) {
    items = [question, second]
    unread = 1
    approvalUnavailable = width === 390
    replies.length = 0
    const phone = width < 700
    const page = await browser.newPage({viewport:{width,height}, isMobile:phone, hasTouch:phone, colorScheme:width === 390 ? 'dark' : 'light'})
    page.setDefaultTimeout(10_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let observer
    try {
      await page.goto(base + '#v2?' + new URLSearchParams({scope, view:'workspace', workspace:'other'}))
      await page.getByRole('heading',{name:'另一个工作区', exact:true}).waitFor()
      const liaison = page.locator('.v2-liaison-button')
      await page.getByRole('button',{name:'一句话交办，1 条未读，2 件待回应'}).click()
      const popup = page.getByRole('dialog',{name:'接口人'})
      const row = popup.getByRole('button',{name:/报告给哪一组同事使用/})
      await row.waitFor()
      assert.ok(await page.getByRole('button',{name:'一句话交办，2 件待回应',includeHidden:true}).count())
      await page.keyboard.press('Escape')
      await popup.waitFor({state:'hidden'})
      await page.getByRole('button',{name:'一句话交办，2 件待回应'}).waitFor()
      assert.ok(await liaison.evaluate(element => element.getBoundingClientRect().right <= innerWidth))
      await liaison.click()
      await row.click()
      await popup.waitFor({state:'hidden'})
      const mark = page.locator('.v2-source-turn[data-message-id="g-12"]')
      await mark.waitFor()
      assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(4)).get('workspace'),'design')
      assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(4)).get('session'),'draft')
      assert.ok(await mark.evaluate(element => element.contains(document.activeElement)))
      const reply = mark.locator('.v2-owner-action-reply')
      await reply.getByRole('button',{name:'答复',exact:true}).click()
      const field = reply.getByRole('textbox',{name:'答复这件事'})
      assert.ok(await field.evaluate(element => element === document.activeElement))
      await field.fill('请给负责验收的同事使用。')
      await reply.getByRole('button',{name:'取消',exact:true}).click()
      const reopen = reply.getByRole('button',{name:'答复',exact:true})
      assert.ok(await reopen.evaluate(element => element === document.activeElement))
      await reopen.click()
      assert.equal(await field.inputValue(),'请给负责验收的同事使用。')
      const submit = reply.getByRole('button',{name:'发送答复'})
      await submit.click()
      await reply.getByText('暂时未能确认答复，请重试').waitFor()
      assert.equal(await field.inputValue(),'请给负责验收的同事使用。')
      await submit.click()
      await reply.getByText('已发送，等待接口人确认。').waitFor()
      assert.equal(replies.length,2)
      assert.equal(replies[1].text,'请给负责验收的同事使用。')
      assert.ok(replies[1].requestId)
      assert.equal(replies[1].requestId,replies[0].requestId)
      await page.getByRole('button',{name:'一句话交办，2 件待回应'}).waitFor()
      if (!phone) {
        observer = await browser.newPage({viewport:{width:390,height:844}, isMobile:true, hasTouch:true})
        await observer.goto(base)
        await observer.getByRole('button',{name:'一句话交办，2 件待回应'}).waitFor({timeout:10_000})
      }
      items = [second]
      await reply.waitFor({state:'hidden'})
      await page.getByRole('button',{name:'一句话交办，1 件待回应'}).waitFor()
      if (observer) await observer.getByRole('button',{name:'一句话交办，1 件待回应'}).waitFor({timeout:10_000})
      await page.getByRole('button',{name:'今天',exact:true}).click()
      const inbox = page.getByRole('region',{name:'待你回应'})
      assert.equal(await inbox.getByRole('button',{name:/报告给哪一组同事使用/}).count(),0)
      await inbox.getByRole('button',{name:/报告在什么时间前需要送达/}).click()
      await page.locator('.v2-source-turn[data-message-id="g-13"]').waitFor()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      assert.deepEqual(errors,[])
      console.log(`PASS ${width} px · 跨区定位、查看仍待回应、答复重试及逐条销项`)
    } finally { await observer?.close(); await page.close() }
  }
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
