/** Browser regressions exercise the historical record component and an isolated, temporary Roster. */
import assert from 'node:assert/strict'
import { recordAsset } from './record-reader-ui.mjs'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Roster } from '../src/dsh/roster.ts'
import { FIXTURE, CHAT } from '../preview/fixture.ts'

const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const root = mkdtempSync(join(tmpdir(), 'chief-ui-'))
const roster = new Roster(root, { commit() {} }, () => '2026-11-16')
roster.recordPersonFacts('杨强', { team: '旧团队', groups: ['前同事'] })
roster.recordPersonFacts('周岚', { organization: '平台部', groups: ['前同事'] })
let slowA = false, detailReads = 0
const files = [{ path: 'work/T-0011/a.md', size: 60 }, { path: 'work/T-0011/b.md', size: 60 }]
const detail = id => ({ threadId: `fixture:${id}`, ticket: { id, title: '回归工单', staff: 'strategist', mandate: { scope: '验证', doneWhen: ['完成验证'], level: 'think', strength: 'explicit', needsReview: true }, assignments: [], inputs: [] }, stage: id === 'T-0013' ? (++detailReads > 1 ? 'verifying' : 'working') : 'you/review', files, proposal: { exists: false } })
// Pending executor command approvals in 「等你决定」: the host lists them only for the desktop owner.
const longCommand = `curl -sS --retry 3 https://ark.example.invalid/api/v3/models?page=1 -H 'Accept: application/json' -o work/T-0042/models.json ${'--data-urlencode q=batch '.repeat(12)}`
let commands = [], decisions = []
const pendingCommand = (ticket, command, minutes) => ({ id: `approval-${ticket}`, ticket, title: '调大构建脚本超时', staff: '工程师', staffId: 'engineer', summary: command.length > 160 ? `${command.slice(0, 159)}…` : command,
  command, workdir: `/brain/work/${ticket}`, mode: 'danger-full-access', reason: '需要联网下载模型清单', executor: 'codex', requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() })
const state = () => ({ ...FIXTURE, ...commands.length ? { commands } : {}, you: FIXTURE.you.map(c => ({ ...c, hasFiles: c.id === 'T-0011' })), poc: { ...FIXTURE.poc, people: roster.people().map(p => ({ ...p, lines: [], owe: 0, owed: 0, due: 0 })) } })
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local')
    if (url.pathname.startsWith('/chief/api/')) {
      let body = ''
      for await (const chunk of req) body += chunk
      const value = body ? JSON.parse(body) : {}
      let answer = { ok: true }
      if (url.pathname.endsWith('/state')) answer = state()
      else if (url.pathname === '/chief/api/settings/approvals' && req.method === 'POST') {
        decisions.push(value)
        commands = commands.filter(row => row.id !== value.id)
      }
      else if (url.pathname.endsWith('/chat')) answer = { ...CHAT, sessionId: 'ui-test', busy: false, notices: [] }
      else if (url.pathname === '/chief/api/people' && req.method === 'POST') {
        roster.recordPersonFacts(value.name, value)
        roster.setPersonJudgement(value.name, value)
      } else if (url.pathname.startsWith('/chief/api/people/')) answer = roster.person(decodeURIComponent(url.pathname.split('/').at(-1)))
      else if (url.pathname.startsWith('/chief/api/discussions')) answer = []
      else if (url.pathname.endsWith('/document')) answer = { ticketId: 'T-0011', path: url.searchParams.get('path'), version: 'ui-version', assignmentId: 'ui-assignment', author: { id: 'strategist', name: '谋士' }, summary: '报告摘要', remote: false }
      else if (url.pathname.endsWith('/thread')) { const id = url.pathname.split('/').at(-2); answer = { thread_id: `fixture:${id}`, ticket_id: id, title: '回归工单', stage: 'working', read_only: false, reply_to: null, execution_boundary: 'local', messages: [], executions: [] } }
      else if (url.pathname.endsWith('/file')) {
        const a = url.searchParams.get('path').endsWith('/a.md')
        if (a && slowA) await new Promise(resolve => setTimeout(resolve, 650))
        answer = { content: a ? '# 第一份文档\n\nA 独有内容。' : '# 第二份文档\n\nB 独有内容。' }
      }
      else if (url.pathname.startsWith('/chief/api/tickets/')) answer = detail(url.pathname.split('/').at(-1))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer)); return
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const allowed = new Set(['index.html', 'app.js', 'page.css', 'icon.svg', 'manifest.webmanifest'])
    if (!allowed.has(name)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream' })
    res.end(readFileSync(recordAsset(name)))
  } catch (e) { res.writeHead(500); res.end(String(e)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, ...process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {} })
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const people = page.locator('section[data-tab="people"]').filter({ has: page.getByRole('heading', { name: /^人物/ }) })
  await people.getByRole('heading', { name: /^未分组/ }).waitFor()
  await page.emulateMedia({ colorScheme: 'dark' })
  assert.equal(await page.locator('.chief-surface').evaluate(el => getComputedStyle(el).getPropertyValue('--chief-main').trim()), '#141414')
  // In the host, explicit light mode wins over the operating system preference.
  await page.evaluate(() => { delete document.body.dataset.chiefStandalone })
  assert.equal(await page.locator('.chief-surface').evaluate(el => getComputedStyle(el).getPropertyValue('--chief-main').trim()), '#fcfcfc')
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  assert.equal(await page.locator('.chief-surface').evaluate(el => getComputedStyle(el).getPropertyValue('--chief-main').trim()), '#141414')
  await page.evaluate(() => { delete document.body.dataset.dsDarkTheme; document.body.dataset.chiefStandalone = 'true' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({width:1440,height:900}); await page.screenshot({path:'screenshots/workspace-desktop.png'}); await page.setViewportSize({width:390,height:844}); await page.screenshot({path:'screenshots/workspace-mobile.png'}); await page.setViewportSize({width:1600,height:1100})
  await people.locator('.wr-row').filter({ hasText: '杨强' }).click()
  const card = page.getByRole('dialog', { name: '杨强' })
  await card.getByRole('button', { name: '编辑资料与判断' }).click()
  await card.getByLabel('组织', { exact: true }).fill('产品部')
  await card.getByRole('button', { name: '保存', exact: true }).click()
  await card.getByText('产品部', { exact: true }).waitFor()
  await card.getByRole('button', { name: '关闭', exact: true }).click()
  await people.getByRole('heading', { name: /^产品部/ }).waitFor()
  await page.reload()
  await people.getByRole('heading', { name: /^产品部/ }).waitFor()
  await people.locator('.wr-row').filter({ hasText: '杨强' }).click()
  await card.getByRole('button', { name: '编辑资料与判断' }).click()
  await card.getByLabel('组织', { exact: true }).fill('平台部')
  await card.getByRole('button', { name: '保存', exact: true }).click()
  await card.getByText('平台部', { exact: true }).waitFor()
  await card.getByRole('button', { name: '编辑资料与判断' }).click()
  await card.getByLabel('组织', { exact: true }).fill('')
  await card.getByRole('button', { name: '保存', exact: true }).click()
  await card.getByText('未分组', { exact: true }).waitFor()
  await card.getByRole('button', { name: '关闭', exact: true }).click()
  await page.reload()
  await people.getByRole('heading', { name: /^未分组/ }).waitFor()
  await page.setViewportSize({width:1440,height:900}); await page.screenshot({path:'screenshots/workspace-desktop.png'}); await page.setViewportSize({width:390,height:844}); await page.screenshot({path:'screenshots/workspace-mobile.png'}); await page.setViewportSize({width:1600,height:1100})
  assert.equal(new Roster(root, { commit() {} }, () => '2026-11-16').person('杨强').organization, undefined)
  assert.deepEqual(roster.person('杨强').groups, ['前同事'])
  console.log('PASS 人物卡编辑、改组、清空、刷新及关系标签保留')

  await page.locator('.wr-row').filter({ hasText: '整理本周横向进展' }).click()
  const ticket = page.getByRole('dialog', { name: '回归工单' })
  await ticket.getByText('执行中', { exact: true }).waitFor()
  await ticket.getByText('核验中', { exact: true }).waitFor({ timeout: 7000 })
  await ticket.getByRole('button', { name: '关闭', exact: true }).click()
  console.log('PASS 打开的工单详情自动更新进度')

  await page.evaluate(() => {
    localStorage.setItem('chief-notes:T-0011:work/T-0011/a.md', JSON.stringify([{ key: '0', quote: '第一份文档', text: 'A 的批注' }]))
    localStorage.setItem('chief-notes:T-0011:work/T-0011/b.md', JSON.stringify([{ key: '0', quote: '第二份文档', text: 'B 的批注' }]))
  })
  await page.getByRole('button', { name: '看产出并批注', exact: true }).click()
  const reader = page.getByRole('dialog', { name: '阅读器' })
  await reader.locator('.md-note').filter({ hasText: 'A 的批注' }).waitFor()
  await reader.locator('.md-note').click()
  await reader.getByRole('button', { name: '删除', exact: true }).click()
  await reader.getByText('看完没问题就验收', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('chief-notes:T-0011:work/T-0011/a.md'))), [])
  await reader.getByRole('button', { name: 'b.md', exact: true }).click()
  await reader.locator('.md-note').filter({ hasText: 'B 的批注' }).waitFor()
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('chief-notes:T-0011:work/T-0011/b.md'))[0].text), 'B 的批注')
  slowA = true
  const oldResponse = page.waitForResponse(r => r.url().includes('/file?') && r.url().includes('a.md'))
  const requestStarted = page.waitForRequest(r => r.url().includes('/file?') && r.url().includes('a.md'))
  await reader.getByRole('button', { name: 'a.md', exact: true }).click()
  await requestStarted
  await reader.getByRole('button', { name: 'b.md', exact: true }).click()
  await oldResponse
  await reader.getByText('B 独有内容。', { exact: true }).waitFor()
  assert.equal(await reader.getByText('A 独有内容。', { exact: true }).count(), 0)
  await reader.locator('.md-note').filter({ hasText: 'B 的批注' }).waitFor()
  console.log('PASS 批注删除、跨文件恢复与慢响应隔离')

  commands = [pendingCommand('T-0042', 'printf "needs network T-0042"', 30), pendingCommand('T-0043', longCommand, 45)]
  await page.goto(page.url().split('#')[0])
  const decide = page.locator('section.wr-sec').filter({ has: page.getByRole('heading', { level: 2, name: /^等你决定/ }) })
  const denied = decide.getByRole('group', { name: '命令审批 T-0042' })
  await denied.waitFor()
  assert.equal(await denied.locator('.note code').textContent(), 'printf "needs network T-0042"')
  await denied.getByText('工程师（Codex）申请运行命令', { exact: true }).waitFor()
  await denied.getByText('T-0042 · 调大构建脚本超时', { exact: true }).waitFor()
  assert.match(await denied.locator('.tail').textContent(), /^\d{2}:\d{2} 前过期$/)
  const count = Number(await decide.getByRole('heading', { level: 2 }).locator('.n').textContent())
  assert.equal(count, FIXTURE.you.length + FIXTURE.stuck.length + (FIXTURE.roomActions?.length ?? 0) + 2, '命令审批计入等你决定')
  await denied.getByRole('button', { name: '拒绝', exact: true }).click()
  await denied.waitFor({ state: 'detached' })
  assert.deepEqual(decisions, [{ id: 'approval-T-0042', allow: false }])
  await page.setViewportSize({ width: 390, height: 844 })
  const tabs = page.getByRole('navigation', { name: '区块' })
  // 手机宽度下「今天」页签的数字同样计入命令审批。
  assert.equal(await tabs.getByRole('button', { name: /^今天/ }).locator('i').textContent(), String(count - 1 + FIXTURE.poc.situation.overdue + FIXTURE.poc.situation.dueToday))
  await tabs.getByRole('button', { name: /^今天/ }).click()
  const allowed = decide.getByRole('group', { name: '命令审批 T-0043' })
  await allowed.scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '390px 下长命令不撑出横向滚动')
  const box = await allowed.boundingBox()
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, '命令审批条目在 390px 内')
  await allowed.getByText('完整命令与原因', { exact: true }).click()
  await allowed.locator('details pre').getByText(longCommand, { exact: true }).waitFor()
  if (process.env.CHIEF_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.CHIEF_SCREENSHOT_DIR, 'command-decision-mobile.png') })
  await allowed.getByRole('button', { name: '仅允许本次命令', exact: true }).click()
  await allowed.waitFor({ state: 'detached' })
  assert.deepEqual(decisions.at(-1), { id: 'approval-T-0043', allow: true })
  await page.setViewportSize({ width: 1600, height: 1100 })
  console.log('PASS 等你决定列出命令审批（摘要、工单、幕僚、过期时间），桌面与 390px 下单次允许或拒绝')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
