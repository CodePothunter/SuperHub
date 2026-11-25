/** Two independent conversations against real routes, engine and durable ticket files. */
import assert from 'node:assert/strict'
import { recordAsset } from './record-reader-ui.mjs'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const root = mkdtempSync(join(tmpdir(), 'chief-thread-ui-'))
const staff = [{ id: 'strategist', name: '谋士', executor: 'dsh', verifier: 'reviewer', brief: '执行本工单' }, { id: 'reviewer', name: '审查官', executor: 'dsh', verifier: 'none', brief: '独立核验' }, { id: 'external', name: '工作端作者', executor: 'remote', verifier: 'reviewer', brief: '仅执行核对后的工作端任务' }]
const brain = { root, staff: () => staff, rules: () => [], constitution: () => '', goals: () => '', workspaces: () => [], commit() {}, workdir(id) { const dir = join(root, 'work', id); mkdirSync(dir, { recursive: true }); return dir } }
const runs = new Map(), releases = new Map(), prompts = new Map()
const result = structured => ({ text: '', stopReason: 'completed', structured })
const executors = { available: () => true, supportsSchema: () => true, run: async r => {
  if (r.staff.id === 'reviewer') return result({ verdict: 'pass', critique: '独立核验通过' })
  const id = r.binding.ticketId, round = (runs.get(id) ?? 0) + 1
  runs.set(id, round); prompts.set(id, r.prompt)
  if (round === 1) return result({ status: 'question', summary: `${id} 首轮问题`, question: `${id} 要采用哪种方案？`, choices: ['保守方案', '积极方案'] })
  await new Promise(resolve => releases.set(id, resolve))
  writeFileSync(join(brain.workdir(id), 'report.md'), `# ${id} 交付\n\n仅属于 ${id} 的结果。`)
  return result({ status: 'ready', summary: `${id} 已根据回复完成`, outputs: [`work/${id}/report.md`] })
} }
const store = new FileStore(root), remote = new FileRemoteQueue(root)
const engine = new Engine(store, brain, executors, remote, { concurrency: 3, timeZone: 'UTC' })
const roster = new Roster(root, brain, () => '2026-11-17')
const worklines = new Worklines(engine, brain, roster), discussions = new Discussions(engine, brain, executors, remote)
const deps = { engine, brain, remote, roster, worklines, discussions, available: () => true, clock: () => ({ today: '2026-11-17', now: '2026-11-17T10:00' }), sources: () => [], timers: () => [], push: () => false }
const routes = runtimeRoutes({ ...deps, chat: { view: async () => ({ sessionId: 'liaison-untouched', messages: [], busy: false, notices: [] }) }, followUps: { cancel: () => false }, custom: {}, importer: {}, exporter: {} })
let activeDeps = deps, activeRoutes = routes, otherEngine
const commission = title => engine.commission({ title, text: title, staff: 'strategist', level: 'think', scope: title, doneWhen: ['回答并交付报告'], needsReview: true })
const a = await commission('甲工作独立对话'), b = await commission('乙工作独立对话')
const remoteId = await engine.commission({ title: '工作端独立工单', text: '仅工作端上下文', staff: 'external', level: 'think', scope: '仅工作端上下文', doneWhen: ['提供摘要'], needsReview: true })
let failNextA = true, chatWrites = 0
const posts = []
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local')
    if (url.pathname.startsWith('/chief/api/')) {
      if (req.method === 'POST' && url.pathname.endsWith('/chat')) chatWrites++
      if (req.method === 'POST' && url.pathname.endsWith('/thread')) {
        let raw = ''; req.on('data', part => { raw += part })
        res.on('finish', () => { posts.push({ path: url.pathname, body: JSON.parse(raw) }) })
        if (url.pathname === `/chief/api/tickets/${a}/thread` && failNextA) {
          failNextA = false
          for await (const _ of req) { /* read real request before a transient gateway failure */ }
          return json(res, 503, { error: '临时连接失败' })
        }
      }
      if (url.pathname.endsWith('/state')) return json(res, 200, { ...warroomState(activeDeps), custom: EMPTY_CUSTOM, dev: false })
      return await serveApi(req, res, 'public', [activeRoutes])
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    if (!['index.html', 'app.js', 'page.css', 'icon.svg', 'manifest.webmanifest'].includes(name)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(readFileSync(recordAsset(name)))
  } catch (e) { res.writeHead(500); res.end(String(e)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ headless: true, ...process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {} })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }) })
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const inbox = page.getByRole('dialog', { name: '执行记录', exact: true })
  const open = async (id, title) => { await inbox.getByRole('button').filter({ hasText: title }).click(); await page.getByRole('log', { name: `${id} 消息记录`, exact: true }).getByText(`${id} 要采用哪种方案？`, { exact: false }).waitFor() }
  const ticketA = page.getByRole('dialog', { name: '甲工作独立对话', exact: true })
  const ticketB = page.getByRole('dialog', { name: '乙工作独立对话', exact: true })
  const draftA = '甲的唯一执行说明 ALPHA_ONLY', draftB = '乙的独立草稿 BETA_ONLY'
  await page.locator('.wr-date').getByRole('button', { name: '执行记录', exact: true }).click()
  await open(a, '甲工作独立对话')
  await ticketA.getByRole('button', { name: '保守方案', exact: true }).click()
  assert.equal(await ticketA.getByLabel('追加给本工单的执行说明').inputValue(), '保守方案')
  assert.equal(posts.length, 0, '建议选项不得直接发送')
  await ticketA.getByLabel('追加给本工单的执行说明').fill(draftA)
  await ticketA.getByRole('button', { name: '全部执行记录', exact: true }).click()
  await open(b, '乙工作独立对话')
  assert.equal(await ticketB.getByText(`${a} 要采用哪种方案？`, { exact: false }).count(), 0)
  await ticketB.getByLabel('追加给本工单的执行说明').fill(draftB)
  assert.match(new URL(page.url()).hash, new RegExp(`thread.*${b}`))
  await page.reload()
  await ticketB.getByLabel('追加给本工单的执行说明').waitFor()
  assert.equal(await ticketB.getByLabel('追加给本工单的执行说明').inputValue(), draftB)
  await ticketB.getByRole('button', { name: '全部执行记录', exact: true }).click()
  await open(a, '甲工作独立对话')
  assert.equal(await ticketA.getByLabel('追加给本工单的执行说明').inputValue(), draftA)
  await ticketA.getByRole('button', { name: '发送并推进执行', exact: true }).click()
  await ticketA.getByRole('alert').filter({ hasText: '临时连接失败' }).waitFor()
  assert.equal(await ticketA.getByLabel('追加给本工单的执行说明').inputValue(), draftA)
  await page.reload()
  await ticketA.getByRole('alert').filter({ hasText: '临时连接失败' }).waitFor()
  await ticketA.getByRole('button', { name: '重试发送执行说明', exact: true }).click()
  await ticketA.getByRole('log').getByText(draftA, { exact: true }).waitFor()
  assert.equal(posts[0].body.request_id, posts[1].body.request_id, '失败重试保留同一请求标识')
  assert.equal(posts[1].body.ticket_id, a); assert.equal(posts[1].body.reply_to, store.ticket(a).assignments[0].id)
  assert.equal(store.ticket(a).inputs.filter(i => i.from === 'owner' && i.text === draftA).length, 1)
  assert.equal(store.ticket(b).inputs.some(i => i.text.includes('ALPHA_ONLY')), false)
  assert.doesNotMatch(prompts.get(a), /BETA_ONLY/)
  releases.get(a)()
  await ticketA.getByRole('log').getByText(`${a} 已根据回复完成`, { exact: true }).waitFor()
  await ticketA.getByText('report.md', { exact: true }).click()
  const reader = page.getByRole('dialog', { name: '阅读器', exact: true })
  await reader.getByText(`仅属于 ${a} 的结果。`, { exact: true }).waitFor()
  await reader.getByRole('button', { name: '关闭', exact: true }).click()
  // The same navigation and persisted draft must work at phone width.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('navigation', { name: '区块' }).getByRole('button', { name: /今天/ }).click()
  await page.locator('.wr-date').getByRole('button', { name: '执行记录', exact: true }).click()
  await open(b, '乙工作独立对话')
  assert.equal(await ticketB.getByLabel('追加给本工单的执行说明').inputValue(), draftB)
  assert.equal(await ticketB.evaluate(el => el.scrollWidth <= window.innerWidth), true)
  await ticketB.getByRole('button', { name: '发送并推进执行', exact: true }).click()
  await ticketB.getByRole('log').getByText(draftB, { exact: true }).waitFor()
  releases.get(b)()
  await ticketB.getByRole('log').getByText(`${b} 已根据回复完成`, { exact: true }).waitFor()
  assert.equal(await ticketB.getByRole('log').getByText(draftA, { exact: true }).count(), 0)
  assert.doesNotMatch(prompts.get(b), /ALPHA_ONLY/)
  await page.reload()
  await ticketB.getByRole('log').getByText(draftB, { exact: true }).waitFor()
  await ticketB.getByRole('button', { name: '验收', exact: true }).click()
  await ticketB.getByText('这张工单已结束，对话保留供查阅。', { exact: true }).waitFor()
  assert.equal(store.ticket(b).ended.outcome, 'done')
  await ticketB.getByRole('button', { name: '全部执行记录', exact: true }).click()
  await inbox.getByRole('button').filter({ hasText: '工作端独立工单' }).click()
  const remoteTicket = page.getByRole('dialog', { name: '工作端独立工单', exact: true })
  await remoteTicket.getByLabel('追加给本工单的执行说明').fill('核对后发送到工作电脑 REMOTE_ALLOWED')
  assert.equal(await remoteTicket.getByRole('button', { name: '发送并推进执行', exact: true }).isDisabled(), true)
  await remoteTicket.getByLabel('我已核对要发给工作电脑的内容', { exact: true }).check()
  await remoteTicket.getByRole('button', { name: '发送并推进执行', exact: true }).click()
  await remoteTicket.getByRole('log').getByText('核对后发送到工作电脑 REMOTE_ALLOWED', { exact: true }).waitFor()
  const remotePost = posts.find(p => p.body.ticket_id === remoteId)
  assert.equal(remotePost.body.execution_boundary, 'remote'); assert.equal(remotePost.body.allow_remote, true)
  await remoteTicket.getByRole('button', { name: '全部执行记录', exact: true }).click()
  await open(a, '甲工作独立对话')
  await ticketA.getByLabel('追加给本工单的执行说明').fill('旧第二大脑的私有草稿 OLD_BRAIN_ONLY')
  const oldLink = page.url()
  assert.match(new URL(oldLink).hash, /thread=/, '深链接必须带不可变讨论标识')
  const otherRoot = join(root, 'another-brain')
  const otherBrain = { ...brain, root: otherRoot, workdir(id) { const dir = join(otherRoot, 'work', id); mkdirSync(dir, { recursive: true }); return dir } }
  const otherStore = new FileStore(otherRoot), otherRemote = new FileRemoteQueue(otherRoot)
  const otherExecutors = { available: () => true, supportsSchema: () => true, run: async () => result({ status: 'question', summary: '另一个工单的问题', question: '新工单需要什么？' }) }
  otherEngine = new Engine(otherStore, otherBrain, otherExecutors, otherRemote, { concurrency: 3, timeZone: 'UTC' })
  const otherRoster = new Roster(otherRoot, otherBrain, () => '2026-11-17')
  assert.equal(await otherEngine.commission({ title: '另一第二大脑同号工单', text: '新背景', staff: 'strategist', level: 'think', scope: '新范围', doneWhen: ['新标准'], needsReview: true }), a)
  activeDeps = { ...deps, engine: otherEngine, brain: otherBrain, remote: otherRemote, roster: otherRoster }
  activeRoutes = runtimeRoutes({ ...activeDeps, chat: { view: async () => ({ messages: [], notices: [], busy: false }) }, followUps: { cancel: () => false }, custom: {}, importer: {}, exporter: {} })
  await page.goto(oldLink)
  const mismatched = page.getByRole('dialog', { name: a, exact: true })
  await mismatched.getByText('这条链接属于其他工单记录。请返回全部执行记录重新选择。', { exact: true }).waitFor()
  assert.equal(await mismatched.getByText('另一第二大脑同号工单', { exact: true }).count(), 0)
  assert.equal(await mismatched.getByRole('button', { name: '停止', exact: true }).count(), 0)
  await mismatched.getByRole('button', { name: '全部执行记录', exact: true }).click()
  await inbox.getByRole('button').filter({ hasText: '另一第二大脑同号工单' }).click()
  const otherTicket = page.getByRole('dialog', { name: '另一第二大脑同号工单', exact: true })
  await otherTicket.getByLabel('追加给本工单的执行说明').waitFor()
  assert.equal(await otherTicket.getByLabel('追加给本工单的执行说明').inputValue(), '')
  assert.equal(await otherTicket.getByText('旧第二大脑的私有草稿 OLD_BRAIN_ONLY', { exact: true }).count(), 0)
  assert.equal(chatWrites, 0, '独立工单不得写入接口人聊天')
  assert.deepEqual(errors, [])
  console.log('PASS 两工单隔离、入口、刷新、双草稿、失败重试、执行回报、交付、手机验收及跨第二大脑同号防混淆')
} finally {
  for (const release of releases.values()) release()
  await browser.close(); discussions.dispose(); engine.stop(); otherEngine?.stop(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true })
}
