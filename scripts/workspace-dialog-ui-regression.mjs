/** Run with CHIEF_LIB_DIR pointing to built assets and CHIEF_PLAYWRIGHT_PATH to Playwright's index.mjs. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const scope = 'dialog-regression'
const notice = {
  id:'report', orderId:'order', orderTitle:'核对外部资料', workspaceId:'w', workspaceName:'资料整理',
  sessionId:'session', title:'核对报告', at:'2026-11-23T08:00:00Z', version:'v1', kind:'report', attachments:[],
}
const report = Array.from({ length: 70 }, (_, index) =>
  `## 核对结果 ${index + 1}\n\n这一段写明核对的材料、确认的内容和后续需要处理的事项。\n\n| 来源 | 结论 |\n| --- | --- |\n| 原始资料 | 已核对 |`).join('\n\n')
let read = false

function send(res, body) {
  res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' })
  res.end(JSON.stringify({ scope, ...body }))
}

const contentTypes = {
  'index.html':'text/html; charset=utf-8', 'app.js':'text/javascript; charset=utf-8', 'page.css':'text/css; charset=utf-8',
  'icon.svg':'image/svg+xml', 'manifest.webmanifest':'application/manifest+json',
}
const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (pathname === '/chief/api/v2/bootstrap') return send(res, { configure:false, build:'dev' })
  if (pathname === '/chief/api/v2/workspaces') return send(res, { workspaces:[] })
  if (pathname === '/chief/api/v2/history') return send(res, { total:0, available:0, items:[],
    counts:{ room:0, person:0, commitment:0, line:0, meeting:0, project:0, goal:0, document:0 },
  })
  if (pathname === '/chief/api/chat/unread') return send(res, { unread:0 })
  if (pathname === '/chief/api/v2/owner-actions') return send(res, { items:[] })
  if (pathname === '/chief/api/v2/notices') return send(res, { total:1, unread:read ? 0 : 1, items:[{ ...notice, read }] })
  if (pathname === '/chief/api/v2/notices/report') return send(res, { notice:{ ...notice, read }, text:report })
  if (pathname === '/chief/api/v2/notices/report/read' && req.method === 'POST') {
    req.resume()
    read = true
    return send(res, { notice:{ ...notice, read } })
  }
  const filename = pathname === '/chief/m/' ? 'index.html' : pathname.split('/').at(-1)
  if (!Object.hasOwn(contentTypes, filename)) {
    res.writeHead(404)
    return res.end()
  }
  res.writeHead(200, { 'content-type':contentTypes[filename] })
  res.end(readFileSync(join(process.env.CHIEF_LIB_DIR ?? 'lib', 'mobile', filename)))
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await chromium.launch({
    headless:true, ignoreDefaultArgs:['--hide-scrollbars'],
    ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath:process.env.CHIEF_CHROMIUM_PATH}),
  })
  const base = `http://127.0.0.1:${server.address().port}/chief/m/`
  for (const [width, height] of [[1440,900], [390,844], [320,568]]) {
    read = false
    const phone = width < 700
    const page = await browser.newPage({viewport:{width,height}, isMobile:phone, hasTouch:phone, colorScheme:width === 390 ? 'dark' : 'light'})
    page.setDefaultTimeout(8000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto(base)
      const inbox = page.getByRole('region', {name:'工单交付提醒'})
      const entry = inbox.getByRole('button', {name:/核对报告/})
      await entry.click()
      const dialog = page.getByRole('dialog', {name:notice.title})
      await dialog.getByRole('heading', {name:'核对结果 1', exact:true}).waitFor()
      const close = dialog.getByRole('button', {name:'关闭详情'})
      const position = await close.boundingBox()
      assert.ok(position)
      const content = dialog.getByRole('group', {name:'详情内容'})
      assert.equal(await content.count(), 1, width + ' px report needs its own scroll area')
      const shape = await dialog.evaluate(element => {
        const style = getComputedStyle(element)
        const body = element.querySelector('.v2-dialog-body')
        const outer = element.getBoundingClientRect(), inner = body.getBoundingClientRect()
        return {
          modal:element.matches(':modal'), overflow:style.overflow,
          corners:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomRightRadius,style.borderBottomLeftRadius].map(parseFloat),
          onScreen:outer.left > 0 && outer.right < innerWidth && outer.top >= 0 && outer.bottom <= innerHeight,
          inset:inner.right < outer.right && inner.bottom < outer.bottom,
          long:body.clientHeight > 80 && body.scrollHeight > 2 * body.clientHeight,
        }
      })
      assert.ok(shape.modal && shape.onScreen && shape.inset && shape.long)
      assert.equal(shape.overflow, 'hidden')
      assert.ok(shape.corners.every(radius => radius > 0))

      await close.focus()
      await page.keyboard.press('Tab')
      assert.equal(await content.evaluate(element => element === document.activeElement), true)
      await page.keyboard.press('End')
      await page.waitForFunction(() => {
        const body = document.querySelector('.v2-dialog[open] .v2-dialog-body')
        return body.scrollTop >= body.scrollHeight - body.clientHeight - 3
      })
      assert.equal(await dialog.evaluate(element => element.scrollTop), 0)
      assert.deepEqual(await close.boundingBox(), position, 'closing control stays visible at the end of the report')
      await page.evaluate(() => document.querySelector('.v2-primary-nav button').focus())
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'the background stays inert')

      if (process.env.CHIEF_SCREENSHOT_DIR) {
        mkdirSync(process.env.CHIEF_SCREENSHOT_DIR, {recursive:true})
        await dialog.locator('header').click({position:{x:8,y:8}})
        await page.screenshot({path:join(process.env.CHIEF_SCREENSHOT_DIR, `report-dialog-${width}.png`)})
      }
      const history = inbox.getByRole('button', {name:'查看已读', includeHidden:true})
      await history.waitFor()
      if (phone) {
        const x = position.x + position.width / 2, y = position.y + position.height / 2
        assert.equal(await close.evaluate((element, {x,y}) => element.contains(document.elementFromPoint(x,y)), {x,y}), true)
        await page.touchscreen.tap(x, y)
      } else await close.click()
      await dialog.waitFor({state:'hidden'})
      assert.equal(await history.evaluate(element => element === document.activeElement), true,
        'after the report becomes read, focus returns to the visible history control')

      await history.click()
      await entry.click()
      await dialog.waitFor()
      await page.keyboard.press('Escape')
      await dialog.waitFor({state:'hidden'})
      assert.equal(await entry.evaluate(element => element === document.activeElement), true)
      assert.deepEqual(errors, [])
      console.log(`PASS ${width} px · 长报告滚动、四角裁切、关闭和返回焦点`)
    } finally { await page.close() }
  }
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
