/** Browser journey against the real HTTP routes, engine, remote queue and durable discussion store. */
import assert from 'node:assert/strict'
import { recordAsset } from './record-reader-ui.mjs'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Engine } from '../src/core/engine.ts'
import { FileStore } from '../src/core/store.ts'
import { EMPTY_CUSTOM } from '../src/core/custom.ts'
import { FileRemoteQueue } from '../src/dsh/remote.ts'
import { Discussions } from '../src/dsh/discussions.ts'
import { Worklines } from '../src/dsh/worklines.ts'
import { Roster } from '../src/dsh/roster.ts'
import { runtimeRoutes, serveApi, json } from '../src/dsh/http.ts'
import { warroomState } from '../src/dsh/view.ts'
import { runOnce } from '../bin/runner.mjs'
const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const root = mkdtempSync(join(tmpdir(), 'chief-workflow-ui-'))
const staff = [
  { id: 'strategist', name: '谋士', executor: 'dsh', verifier: 'reviewer', brief: '整合证据更新简报' },
  { id: 'reviewer', name: '审查官', executor: 'dsh', verifier: 'none', brief: '独立核验' },
  { id: 'external', name: '外务作者', executor: 'remote', verifier: 'reviewer', brief: '工作电脑执行' },
]
const brain = { root, staff: () => staff, rules: () => [], constitution: () => '', goals: () => '', workspaces: () => [], commit() {}, workdir(id) { const dir = join(root, 'work', id); mkdirSync(dir, { recursive: true }); return dir }, saveRemoteReport(id, round, content) { const path = `work/${id}/remote-report-${round}.md`; writeFileSync(join(brain.workdir(id), `remote-report-${round}.md`), content); return path } }
let engine, runs = 0
const executors = { available: () => true, supportsSchema: () => true, run: async r => {
  if (r.label.startsWith('讨论')) return { text: '依据已核验的评测，甲方案的延迟更低；样本限制已列在原报告。', stopReason: 'completed' }
  if (r.label.startsWith('核验作者追问')) return { text: '', stopReason: 'completed', structured: { verdict: 'pass', critique: '明确回答问题并给出证据限制' } }
  if (r.staff.id === 'reviewer') return { text: '', stopReason: 'completed', structured: { verdict: 'pass', critique: '回传包含指标、证据与限制' } }
  runs++
  if (runs === 1) {
    await engine.delegate(r.binding, { key: 'evaluate', staff: 'external', text: '不应出域的模型重述', criterion: 0 })
    return { text: '', stopReason: 'completed', structured: { status: 'question', summary: '等待工作端评测', question: '等待关联子任务' } }
  }
  writeFileSync(join(brain.workdir(r.binding.ticketId), 'report.md'), '# 首轮评测简报\n\n甲方案的延迟更低，建议按当前负载采用。\n\n本轮证据来自工作端评测；样本限制为单机负载。')
  return { text: '', stopReason: 'completed', structured: { status: 'ready', summary: '已核验评测并更新首轮简报', outputs: [`work/${r.binding.ticketId}/report.md`] } }
} }
const store = new FileStore(root), remote = new FileRemoteQueue(root)
engine = new Engine(store, brain, executors, remote, { concurrency: 3, timeZone: 'UTC' })
const roster = new Roster(root, brain, () => '2026-11-16')
roster.upsertLine('评测线', { goal: '维护长期评测与决定' })
roster.addCommitment({ direction: 'theirs', who: '评测伙伴', what: '提供评测结果', line: '评测线' })
const worklines = new Worklines(engine, brain, roster), discussions = new Discussions(engine, brain, executors, remote)
const deps = { engine, brain, remote, roster, worklines, discussions, available: () => true, clock: () => ({ today: '2026-11-16', now: '2026-11-16T10:00' }), sources: () => [], timers: () => [], push: () => false }
const routes = runtimeRoutes({ ...deps, chat: { view: async () => ({ sessionId: 'workflow-test', messages: [], busy: false, notices: [] }) }, followUps: { cancel: () => false }, custom: {}, importer: {}, exporter: {} })
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local')
    if (url.pathname.startsWith('/chief/api/')) {
      if (url.pathname.endsWith('/state')) return json(res, 200, { ...warroomState(deps), custom: EMPTY_CUSTOM, dev: false })
      return await serveApi(req, res, 'public', [routes])
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    if (!['index.html', 'app.js', 'page.css', 'icon.svg', 'manifest.webmanifest'].includes(name)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(readFileSync(recordAsset(name)))
  } catch (e) { res.writeHead(500); res.end(String(e)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, ...process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {} })
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  // Explicitly test the HTTP gateway's missing randomUUID environment.
  await page.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }) })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.getByRole('navigation', { name: '区块' }).getByRole('button', { name: '人与线' }).click()
  await page.locator('section[data-tab="people"]').filter({ has: page.getByRole('heading', { name: /^横向线/ }) }).locator('.wr-row').filter({ hasText: '评测线' }).click()
  const line = page.getByRole('dialog', { name: '评测线', exact: true })
  await line.getByLabel('确认一项决定').fill('先测两个方案，再决定切换')
  await line.getByRole('button', { name: '记为已确认决定' }).click()
  await line.getByText('先测两个方案，再决定切换', { exact: false }).first().waitFor()
  await line.getByLabel('要推进什么', { exact: true }).fill('私人背景 PRIVATE_CONTEXT；让外务测两方案后由谋士更新简报')
  await line.getByLabel('完成标准（每行一条）', { exact: true }).fill('交付评测结论和证据摘要')
  await line.getByLabel('给工作端的任务说明（仅需工作电脑参与时填写）', { exact: true }).fill('在工作电脑评测两个方案；只回传指标摘要、证据位置和限制')
  await line.getByRole('button', { name: '发起并关联工单' }).click()
  const ticket = page.getByRole('dialog').filter({ has: page.getByText('等待关联子任务', { exact: true }) })
  await ticket.locator('.wr-kv dd').filter({ hasText: /^等待关联子任务$/ }).waitFor()
  const parent = engine.views().find(v => !v.ticket.parent).ticket
  const child = engine.views().find(v => v.ticket.parent).ticket
  const task = JSON.parse(readFileSync(join(remote.dir, 'outbox', `${child.assignments[0].id}.json`), 'utf8'))
  assert.doesNotMatch(task.prompt, /PRIVATE_CONTEXT/)
  let offline = true, executions = 0
  const transport = { root: join(root, 'workstation'), pull: async () => task, execute: async () => { executions++; return { status: 'ready', summary: '甲延迟 80ms，乙延迟 120ms，样本1000次；限制：单机。证据 local/report.md。' } }, push: async (id, report) => { if (offline) throw new Error('offline'); writeFileSync(join(remote.dir, 'inbox', `${id}.json`), JSON.stringify({ ticketId: task.ticketId, assignmentId: id, report })) } }
  await assert.rejects(runOnce(transport), /offline/); offline = false
  await runOnce({ ...transport, pull: async () => ({}) }); assert.equal(executions, 1)
  await remote.drain(r => engine.remoteReport(r.ticketId, r.assignmentId, r.report), () => {})
  const updated = page.getByRole('dialog').filter({ has: page.getByText('等你验收', { exact: true }) })
  await updated.getByText('等你验收', { exact: true }).waitFor()
  await updated.getByText('report.md', { exact: true }).click()
  const reader = page.getByRole('dialog', { name: '阅读器' })
  const paragraph = reader.locator('.wr-document-content .md p').first()
  await paragraph.waitFor()
  await reader.getByRole('button', { name: '批注这一段', exact: true }).first().click()
  await reader.getByPlaceholder('这一段要怎么改？').fill('手机批注仍可编辑')
  await reader.getByRole('button', { name: '取消', exact: true }).click()
  await paragraph.evaluate(p => { const range = document.createRange(); range.selectNodeContents(p); const s = window.getSelection(); s.removeAllRanges(); s.addRange(range) })
  try {
    const selection = await paragraph.evaluate(p => ({ selected: window.getSelection()?.toString(), expected: p.textContent, userSelect: getComputedStyle(p).userSelect, blockSelect: getComputedStyle(p.closest('.md-blk')).userSelect }))
    assert.equal(selection.selected, selection.expected, JSON.stringify(selection))
    assert.notEqual(selection.userSelect, 'none', JSON.stringify(selection))
    await reader.getByRole('button', { name: '引用提问', exact: true }).click()
    await reader.getByLabel('引用提问', { exact: true }).waitFor({ timeout: 5000 })
    await reader.getByLabel('引用提问', { exact: true }).fill('为什么建议甲方案？')
  } catch (error) {
    console.error('引用选区诊断', await paragraph.evaluate(p => ({ selected: window.getSelection()?.toString(), expected: p.textContent, userSelect: getComputedStyle(p).userSelect, blockSelect: getComputedStyle(p.closest('.md-blk')).userSelect, toolbar: document.querySelector('.wr-reader-tools')?.textContent, composer: document.querySelector('.wr-discussion')?.textContent })))
    throw error
  }
  await reader.getByRole('button', { name: '发送问题', exact: true }).click()
  await reader.getByText('依据已核验的评测，甲方案的延迟更低；样本限制已列在原报告。', { exact: true }).waitFor()
  assert.equal(store.ticket(parent.id).assignments.length, 2); assert.equal(engine.views().length, 2)
  const hash = new URL(page.url()).hash; assert.match(hash, /delivery/)
  await page.reload()
  await reader.getByRole('button').filter({ hasText: '甲方案的延迟更低' }).waitFor()
  await reader.getByRole('button').filter({ hasText: '甲方案的延迟更低' }).click()
  await reader.getByText('为什么建议甲方案？', { exact: true }).waitFor()
  await reader.getByLabel('继续追问', { exact: true }).fill('第二天继续问，样本限制是什么？')
  await reader.getByRole('button', { name: '发送问题', exact: true }).click()
  await reader.getByText('第二天继续问，样本限制是什么？', { exact: true }).waitFor()
  assert.equal(discussions.list(parent.id, `work/${parent.id}/report.md`)[0].messages.filter(m => m.role === 'owner').length, 2)
  assert.equal(await reader.evaluate(el => el.scrollWidth <= window.innerWidth), true)
  // Same built reader at desktop size: paragraph action remains usable.
  await page.setViewportSize({ width: 1440, height: 1000 })
  await reader.getByRole('button', { name: '问作者', exact: true }).first().click()
  await reader.getByLabel('引用提问', { exact: true }).waitFor()
  await reader.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('section[data-tab="people"]').filter({ has: page.getByRole('heading', { name: /^横向线/ }) }).locator('.wr-row').filter({ hasText: '评测线' }).click()
  await line.getByText('先测两个方案，再决定切换', { exact: false }).first().waitFor()
  await line.getByRole('heading', { name: '最新证据与交付' }).waitFor()
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('PASS 手机横向线交办、真实委派、断线补传、原谋士简报、引用追问、刷新继续与电脑段落提问')
} finally {
  await browser.close(); discussions.dispose(); engine.stop(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true })
}
