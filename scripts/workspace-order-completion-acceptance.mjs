/**
 * Order-completion acceptance (task 11-23, prd AC1–AC7 and the classifier set of AC8) with the REAL liaison model and
 * the REAL Codex CLI, in an isolated, disposable DSH host that installs the candidate package.
 *
 *   CHIEF_ACCEPTANCE_PACKAGE=/tmp/pack/dsh-chief-<v>.tgz \
 *   CHIEF_PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs [CHIEF_CHROMIUM_PATH=/path/to/chrome] \
 *   CHIEF_OC_EVIDENCE=/path/evidence.json CHIEF_OC_SCREENSHOTS=/path/screenshots \
 *   node scripts/workspace-order-completion-acceptance.mjs [--only CLS,AC1,AC2] [--model provider/model] [--no-browser] [--keep]
 *
 * The liaison (its reading of the owner's words on an order and its acceptance review) uses `--model` (default
 * openai-codex/gpt-6.1-terra, the production liaison). `openai-codex/*` installs dsh-codex-subscription@3.2.24 in the
 * isolated host and copies ONLY the everyday login's current access token with a placeholder refresh token, as
 * scripts/workspace-order-dialogue-acceptance.mjs does; a missing token or one expiring within two hours stops the run.
 * `deepseek-official/*` reads the credential from the everyday DSH without writing it.
 *
 * Every order is a Codex order that has delivered once (a 「工单回报」 the liaison reviews) before the owner speaks. Codex is
 * asked only to answer short questions without running commands or writing files. scripts/workspace-order-dialogue-codex-proxy.mjs sits in front
 * of the real `codex` (no faults) and records every `turn/start` and `turn/steer`, i.e. exactly what reached the
 * executor. scripts/workspace-order-completion-probe.mjs records the liaison's model requests with their timing and
 * can hold its reading past the product's 8 s deadline (the "model unavailable" case).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acceptanceHost, delay } from './acceptance-host.mjs'

const argv = process.argv.slice(2)
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const only = option('--only')?.split(',').map(s => s.trim().toUpperCase())
const wanted = ac => !only || only.includes(ac)
const browserWanted = !argv.includes('--no-browser') && !!process.env.CHIEF_PLAYWRIGHT_PATH
const keep = argv.includes('--keep')
const MODEL = option('--model') || 'openai-codex/gpt-6.1-terra'
const shotsDir = process.env.CHIEF_OC_SCREENSHOTS
const evidenceFile = process.env.CHIEF_OC_EVIDENCE

/** The classifier set (owner words on a Codex order that already delivered once). */
const PHRASES = {
  explicit: ['可以收单', '没问题了 可以收单', '完成了', '这单结束吧', '收了吧'],
  ambiguous: ['可以验收了', '看着可以', '差不多了', '行吧', 'OK'],
  normal: ['OK，下一题', '没问题，继续做第四题', '完成第三题后再检查', '验收标准改成三条', '完成了吗？'],
}
const AC1_PHRASE = '没问题了 可以收单'

const which = name => execFileSync('bash', ['-lc', 'command -v ' + name], {encoding: 'utf8'}).trim()
const realCodex = which('codex')
const evidence = {model: MODEL, candidate: process.env.CHIEF_ACCEPTANCE_PACKAGE, startedAt: new Date().toISOString(),
  tools: {codex: execFileSync(realCodex, ['--version'], {encoding: 'utf8'}).trim()}, classifier: [], results: {}, notes: [], screenshots: []}
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)
const save = () => { if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)) }

const base = join(tmpdir(), 'chief-order-completion-' + randomUUID().slice(0, 8))
mkdirSync(base, {recursive: true, mode: 0o700})
const wrappers = join(base, 'bin'), control = join(base, 'proxy-control.json'), proxyLog = join(base, 'codex-proxy.jsonl')
mkdirSync(wrappers)
writeFileSync(control, '{}')
writeFileSync(join(wrappers, 'codex'), '#!/bin/sh\n# Acceptance only: record the app-server traffic (see the proxy file).\nexec '
  + JSON.stringify(process.execPath) + ' ' + JSON.stringify(fileURLToPath(new URL('./workspace-order-dialogue-codex-proxy.mjs', import.meta.url))) + ' "$@"\n')
chmodSync(join(wrappers, 'codex'), 0o700)
const proxyRows = () => existsSync(proxyLog) ? readFileSync(proxyLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const hostEnv = {PATH: wrappers + delimiter + process.env.PATH, CHIEF_OD_PROXY_REAL: realCodex, CHIEF_OD_PROXY_CONTROL: control, CHIEF_OD_PROXY_LOG: proxyLog}

const hash = (...items) => createHash('sha256').update(JSON.stringify(items)).digest('hex')

async function poll(check, label, timeout = 10 * 60_000, every = 1000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await check()
    if (value) return value
    await delay(every)
  }
  throw Error('等待超时：' + label)
}

/** The isolated host may only ever use the owner's current access token; the refresh token is replaced (see header). */
async function codexSubscription(host) {
  const yaml = (await import('yaml')).default
  const doc = yaml.parse(readFileSync(join(homedir(), 'workspace/dsh/home/.credentials.yaml'), 'utf8'))
  const payload = doc?.records?.['codex-subscription/accounts']?.payload
  const active = payload?.accounts?.find(row => row.id === payload.activeId) ?? payload?.accounts?.[0]
  if (!active?.credential?.access) throw Error('日常 DSH 没有已登录的 Codex 订阅，未运行（不改用其他模型）')
  if (active.credential.expires - Date.now() < 2 * 3600_000) throw Error('Codex 订阅的访问令牌两小时内到期（隔离宿主不允许刷新），未运行')
  host.install('dsh-codex-subscription@3.2.24')
  const isolated = {...payload, activeId: active.id, accounts: [{...active, credential: {...active.credential, refresh: 'isolated-eval-refresh-disabled'}}]}
  writeFileSync(join(host.home, '.credentials.yaml'), yaml.stringify({version: 1, records: {'codex-subscription/accounts': {kind: 'grant', payload: isolated}}}), {mode: 0o600})
  const patch = join(host.home, 'profiles/web/cordis.patch.yml')
  writeFileSync(patch, readFileSync(patch, 'utf8') + '- id: codex-subscription\n  config:\n    defaultReasoningEffort: high\n', {mode: 0o600})
}
const isolatedCredentials = new Set()
const opened = []

let h
async function open(candidate) {
  const host = await acceptanceHost({candidate, probe: 'workspace-order-completion-probe.mjs', model: MODEL, mobile: true, directory: base, extraEnv: hostEnv})
  opened.push(host)
  if (MODEL.startsWith('openai-codex/')) {
    isolatedCredentials.add(join(host.home, '.credentials.yaml'))
    await codexSubscription(host)
  }
  const yaml = (await import('yaml')).default
  const rulesFile = join(host.brain, 'rules.yaml')
  writeFileSync(rulesFile, yaml.stringify({...yaml.parse(readFileSync(rulesFile, 'utf8')), rules: []}))
  const x = {host, scope: '', q: ''}
  x.boot = async () => {
    await host.start()
    await host.api('/pause', {paused: true})
    const boot = await host.api('/v2/bootstrap')
    x.scope = boot.scope
    x.build = boot.build
    x.q = '?scope=' + encodeURIComponent(x.scope)
  }
  x.get = (path, params = '') => host.api(path + x.q + params)
  x.post = (path, body = {}) => host.api(path + x.q, {...body, requestId: randomUUID()})
  x.probe = body => host.request('/chief-order-completion-probe', body)
  /** POST with the time it took, without the client's 18 s timeout. */
  x.call = (path, body) => {
    const started = Date.now(), payload = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const request = httpRequest(host.base + '/chief/api' + path + x.q, {method: 'POST',
        headers: {cookie: host.cookie(), 'x-chief-request': '1', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}}, response => {
        let data = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { data += chunk })
        response.on('end', () => {
          let parsed = {}
          try { parsed = JSON.parse(data) } catch { parsed = {raw: data.slice(0, 500)} }
          resolve({status: response.statusCode, body: parsed, ms: Date.now() - started})
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end(payload)
    })
  }
  x.bind = (session, order, workspaceId) => {
    const area = hash(x.scope, workspaceId), room = hash(area, session.id)
    return {session, order, wsId: workspaceId, sessionPath: '/v2/workspaces/' + workspaceId + '/sessions/' + session.id,
      orderPath: '/v2/workspaces/' + workspaceId + '/orders/' + order.id,
      work: join(host.brain, 'work', 'superhub-v2', area, room), journal: join(host.brain, 'ops', 'superhub-v2-dialogues', area, room, 'source.json')}
  }
  x.board = () => {
    const dir = join(host.brain, 'ops', 'superhub-v2')
    for (let i = 0; i < 5; i++) {
      try { return JSON.parse(readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith('.json'))), 'utf8')) } catch { /* replaced while reading */ }
    }
    return {}
  }
  return x
}

const journalOf = s => { try { return JSON.parse(readFileSync(s.journal, 'utf8')) } catch { return {messages: [], turns: []} } }
const orderTurns = s => journalOf(s).turns.filter(turn => turn.workOrderId === s.order.id)
const brief = messages => messages.map(m => ({id: m.id, author: m.author, role: m.role, at: m.at, text: m.text.slice(0, 300),
  ...(m.held && {held: m.held}), ...(m.actions && {actions: m.actions}), ...(m.delivery && {delivery: m.delivery})}))

async function check(ac, label, body) {
  if (!wanted(ac)) return
  log('▶', ac, label)
  const record = evidence.results[ac + ' · ' + label] = {status: 'running', startedAt: new Date().toISOString()}
  save()
  try {
    Object.assign(record, await body(record) ?? {})
    record.status = 'pass'
    log('✔', ac, label)
  } catch (error) {
    record.status = 'fail'
    record.error = error instanceof Error ? error.message : String(error)
    log('✘', ac, label, record.error)
  }
  record.endedAt = new Date().toISOString()
  save()
}

let browser, desktop, mobile
async function picture(page, name) {
  if (!shotsDir || !page) return
  mkdirSync(shotsDir, {recursive: true})
  const file = join(shotsDir, name + '.png')
  await page.screenshot({path: file, fullPage: false}).catch(error => evidence.notes.push('截图失败 ' + name + '：' + error.message))
  evidence.screenshots.push(file)
}
const button = (page, name) => page.getByRole('button', {name, exact: true})
const origin = page => page === desktop ? h.host.base : h.host.mobileBase
const width = page => page === desktop ? '1280' : '390'
const orderHash = s => '#v2?' + new URLSearchParams({scope: h.scope, view: 'workspace', workspace: s.wsId, order: s.order.id})
async function openOrderPage(page, s) {
  await page.goto(origin(page) + '/' + orderHash(s))
  await page.reload()
  await page.getByRole('heading', {name: s.order.title, exact: true, level: 1}).waitFor({timeout: 30_000})
  await page.getByRole('list', {name: '会话发言'}).waitFor({timeout: 30_000})
}
async function signInPages(host, password) {
  await desktop.context().addCookies(host.cookie().split('; ').map(row => ({name: row.slice(0, row.indexOf('=')), value: row.slice(row.indexOf('=') + 1), url: host.base})))
  await mobile.goto(host.mobileBase)
  await mobile.getByLabel('密码').fill(password)
  await button(mobile, '进入').click()
  await mobile.getByRole('heading', {name: '今天', exact: true}).waitFor({timeout: 30_000})
}
/** Click a choice on one liaison message of the order page. */
async function choose(page, s, noteId, label) {
  await openOrderPage(page, s)
  const message = page.locator('[data-message-id="' + noteId + '"]')
  await message.scrollIntoViewIfNeeded()
  const choice = message.getByRole('button', {name: label, exact: true})
  await choice.waitFor({timeout: 30_000})
  return {message, choice}
}
/** The order page's information panel: the side panel at 1280 px, the folded details on the phone. */
async function infoPanel(page) {
  if (page === desktop) return page.getByRole('complementary', {name: '工单信息'})
  const fold = page.locator('details.v2-order-fold')
  if (!await fold.evaluate(el => el.open)) await fold.locator(':scope > summary').click()
  return fold
}
const ledger = async (panel, label) => (await panel.locator('dl.v2-ledger > div', {has: panel.page().locator('dt', {hasText: new RegExp('^' + label + '$')})}).locator('dd').first().textContent())?.trim()

let workspace, wsPath
const transcript = s => h.get(s.sessionPath)
const orderNow = async s => (await h.get(s.orderPath)).order
const liaisonMessages = messages => messages.filter(m => m.role === 'agent' && m.author === '接口人')
// The first answer is a 「工单回报」, so it is a delivery: 「今天」 lists it and the liaison reviews it against the promise.
const QUESTION = '这是 SuperHub 的验收测试。不要运行任何命令，不要读写文件。请按这个格式回复：第一行只写「工单回报」四个字，第二行用一句话回答。第一题：一加一等于几？'
const PROMISE = '主人会逐题提问，每题用一句话作答；不运行命令，不读写文件。'

async function codexOrder(label) {
  const {session} = await h.post(wsPath + '/sessions', {title: label, kind: 'coding', executor: 'codex'})
  const {order} = await h.post(wsPath + '/orders', {title: label, promise: PROMISE, sessionId: session.id})
  return h.bind(session, order, workspace.id)
}
/** Nothing running, nothing queued, no review pending on this session, for `quiet` ms. */
async function settled(s, timeout = 20 * 60_000, quiet = 5000) {
  let since
  return poll(async () => {
    const view = await transcript(s)
    const board = h.board()
    const busy = view.working || (board.starts ?? []).some(row => row.sessionId === s.session.id)
      || Object.values(board.acceptances ?? {}).some(row => row.sessionId === s.session.id && row.state === 'pending')
    if (busy) { since = undefined; return false }
    since ??= Date.now()
    return Date.now() - since >= quiet && view
  }, '会话安静下来 ' + s.order.title, timeout)
}
/** Owner words that reached Codex on this order (thread input of `turn/start` / `turn/steer`), optionally since `at`. */
const reached = (s, text, at = '') => proxyRows().filter(row => row.cwd === s.work && row.at >= at && (row.method === 'turn/start' || row.method === 'turn/steer')
  && (text === undefined || (row.text ?? '').includes(text)))
const judgeOf = async (text, since) => (await h.probe({action: 'requests', kind: 'judge', since}))
  .filter(row => row.lastUser.includes('"主人这句话":' + JSON.stringify(text)))
const intentOf = reply => { try { return JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)).intent } catch { return undefined } }

/**
 * The owner says `text` on the order (the real order-chat route, `wait:false`) and everything that followed is read back:
 * the response, the liaison's reading (intent, model time), the board's record and what reached Codex.
 */
async function ownerSays(s, text, {expect} = {}) {
  const before = await orderNow(s)
  const turnsBefore = orderTurns(s).length
  const since = new Date().toISOString()
  const requestId = randomUUID()
  const response = await h.call(s.sessionPath + '/messages', {text, requestId, workOrderId: s.order.id, wait: false})
  assert.equal(response.status, 200, '发言被接受：' + JSON.stringify(response.body).slice(0, 300))
  const command = response.body.command
  const judges = await judgeOf(text, since)
  const judge = judges[0]
  const row = {text, order: s.order.title, status: response.status, postMs: response.ms, outcome: command ? command.outcome : 'dispatched',
    judgeCalls: judges.length, ...(judge && {judgeModel: judge.provider + '/' + judge.model, judgeMs: judge.answeredAt ? Date.parse(judge.answeredAt) - Date.parse(judge.at) : undefined,
      judgeReply: judge.reply, ...(judge.heldMs && {judgeHeldMs: judge.heldMs, judgeAbandoned: !!judge.abandoned})}),
    budgetBefore: before.remainingTurns, requestId, since}
  const saved = h.board().commands?.[requestId]
  row.intent = saved?.judged ?? (judge ? intentOf(judge.reply ?? '') ?? 'unreadable' : 'prefilter-miss')
  if (saved?.reason) row.reason = saved.reason
  if (command) {
    // Held or completed words: give the executor time to (wrongly) receive them, then read the order back.
    await delay(4000)
    await settled(s, 5 * 60_000, 3000)
  } else {
    await poll(() => reached(s, text, since).length > 0, 'Codex 收到「' + text + '」', 5 * 60_000, 500)
    await settled(s)
  }
  const after = await orderNow(s)
  Object.assign(row, {statusAfter: after.status, budgetAfter: after.remainingTurns, newTurns: orderTurns(s).length - turnsBefore,
    reachedExecutor: reached(s, text, since).length, dispatchedTurns: orderTurns(s).filter(turn => turn.text === text).length, autoFollowUps: orderTurns(s).slice(turnsBefore).filter(turn => turn.id.startsWith('accept-')).length})
  const view = await transcript(s)
  const mine = view.messages.find(m => m.role === 'user' && m.text === text && m.at >= since.slice(0, 19)) ?? view.messages.filter(m => m.role === 'user' && m.text === text).at(-1)
  row.ownerMessage = mine && {id: mine.id, held: mine.held}
  const note = saved && h.board().commands?.[requestId]?.noteMessageId
  const noteMessage = note && view.messages.find(m => m.id === note)
  if (noteMessage) row.note = {id: noteMessage.id, author: noteMessage.author, text: noteMessage.text, actions: noteMessage.actions}
  if (expect) row.expected = expect
  return row
}

try {
  h = await open(process.env.CHIEF_ACCEPTANCE_PACKAGE)
  evidence.host = h.host.work
  await h.boot()
  evidence.build = h.build
  ;({workspace} = await h.post('/v2/workspaces', {name: '收单验收', goal: '验收工单的完成与主人对工单的指令'}))
  wsPath = '/v2/workspaces/' + workspace.id
  const password = randomUUID()
  await h.host.api('/settings/password', {password})
  if (browserWanted) {
    const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
    browser = await chromium.launch({headless: true, ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath: process.env.CHIEF_CHROMIUM_PATH})})
    desktop = await browser.newPage({viewport: {width: 1280, height: 900}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai'})
    mobile = await browser.newPage({viewport: {width: 390, height: 844}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true})
    await signInPages(h.host, password)
  }

  // ── Orders: every one a Codex order that has delivered once ──
  const needs = {
    explicit: wanted('CLS') || wanted('AC1') || wanted('AC7'), ambiguous: wanted('CLS') || wanted('AC2'), normal: wanted('CLS') || wanted('AC3'),
    unavailable: wanted('AC3'), review: wanted('AC4'), panel: wanted('AC4'), schedule: wanted('AC5') || wanted('AC6'), cancelled: wanted('AC7'),
  }
  const o = {}
  const plan = [
    // Neutral titles: the liaison reads the order's title with the owner's words, and the executor's first input names it.
    ...(needs.explicit ? PHRASES.explicit.map((phrase, i) => ['explicit' + i, '算术答题 E' + (i + 1)]) : []),
    ...(needs.ambiguous ? [['ambiguous', '算术答题 A']] : []), ...(needs.normal ? [['normal', '算术答题 N']] : []),
    ...(needs.unavailable ? [['unavailable', '算术答题 U']] : []), ...(needs.review ? [['review', '算术答题 R']] : []),
    ...(needs.panel ? [['panel', '算术答题 P']] : []), ...(needs.schedule ? [['schedule', '每周算术答题 S']] : []), ...(needs.cancelled ? [['cancelled', '算术答题 X']] : []),
  ]
  for (const [key, title] of plan) o[key] = await codexOrder(title)
  evidence.orders = Object.fromEntries(Object.entries(o).map(([key, s]) => [key, {id: s.order.id, title: s.order.title, sessionId: s.session.id}]))
  log('开单', Object.keys(o).length, '张，第一题同时发出')
  for (const s of Object.values(o)) {
    const first = await h.call(s.sessionPath + '/messages', {text: QUESTION, requestId: randomUUID(), workOrderId: s.order.id, wait: false})
    assert.equal(first.status, 200, '第一题送达：' + JSON.stringify(first.body).slice(0, 300))
  }
  await Promise.all(Object.values(o).map(s => poll(() => reached(s, '一加一').length > 0, 'Codex 收到第一题 ' + s.order.title, 10 * 60_000)))
  await Promise.all(Object.values(o).map(s => settled(s)))
  evidence.firstDeliveries = Object.fromEntries(await Promise.all(Object.entries(o).map(async ([key, s]) => {
    const order = await orderNow(s)
    return [key, {status: order.status, remainingTurns: order.remainingTurns, acceptance: order.acceptance, turns: orderTurns(s).map(turn => ({id: turn.id.slice(0, 18), state: turn.state}))}]
  })))
  save()

  // ── Classifier set through the real order-chat route ──
  const rows = {explicit: [], ambiguous: [], normal: []}
  const reopenIfDone = async (s, row) => {
    if ((await orderNow(s)).status !== 'done') return
    await h.post(s.orderPath + '/action', {action: 'reopen'})
    row.reopenedForNext = true
  }
  /** One phrase of the set; a failure is recorded on its row and the set goes on. */
  const tryPhrase = async (s, phrase, expect, kind) => {
    try { return {class: kind, ...await ownerSays(s, phrase, {expect})} }
    catch (error) { return {class: kind, text: phrase, order: s.order.title, error: error instanceof Error ? error.message : String(error), pass: false} }
  }
  if (needs.explicit) {
    for (const [i, phrase] of PHRASES.explicit.entries()) {
      const row = await tryPhrase(o['explicit' + i], phrase, 'complete', 'explicit')
      if (!row.error) row.pass = row.outcome === 'completed' && row.statusAfter === 'done' && row.reachedExecutor === 0 && row.newTurns === 0 && row.budgetAfter === row.budgetBefore
      rows.explicit.push(row)
      evidence.classifier.push(row)
      log('明确', phrase, row.intent, row.outcome, row.judgeMs + ' ms')
      save()
    }
  }
  if (needs.ambiguous) {
    for (const phrase of PHRASES.ambiguous) {
      const s = o.ambiguous
      const row = await tryPhrase(s, phrase, 'ambiguous', 'ambiguous')
      if (!row.error) row.pass = row.outcome === 'held' && row.reachedExecutor === 0 && row.newTurns === 0 && row.budgetAfter === row.budgetBefore
        && row.ownerMessage?.held === 'choosing' && row.note?.actions?.map(a => a.kind).join(',') === 'complete,forward'
      rows.ambiguous.push(row)
      evidence.classifier.push(row)
      log('含糊', phrase, row.intent, row.outcome, row.judgeMs + ' ms')
      await reopenIfDone(s, row)
      save()
    }
  }
  if (needs.normal) {
    for (const phrase of PHRASES.normal) {
      const s = o.normal
      const row = await tryPhrase(s, phrase, 'other', 'normal')
      if (!row.error) row.pass = row.outcome === 'dispatched' && row.dispatchedTurns === 1 && row.reachedExecutor >= 1
      rows.normal.push(row)
      evidence.classifier.push(row)
      log('普通', phrase, row.intent, row.outcome, (row.judgeMs ?? 0) + ' ms')
      await reopenIfDone(s, row)
      save()
    }
  }
  await check('CLS', '收单判断（明确 5 / 含糊 5 / 普通 5）', async record => {
    const count = list => list.filter(row => row.pass).length + '/' + list.length
    Object.assign(record, {explicit: count(rows.explicit), ambiguous: count(rows.ambiguous), normal: count(rows.normal)})
    assert.ok(rows.explicit.every(row => row.pass), '明确收单全部直接收单：' + record.explicit)
    assert.ok(rows.normal.every(row => row.pass), '普通指令全部派发：' + record.normal)
    assert.ok(rows.ambiguous.every(row => !row.error && row.outcome !== 'dispatched' && row.reachedExecutor === 0), '含糊的话没有未经选择就派发')
    assert.ok(rows.ambiguous.every(row => row.pass), '含糊的话全部保留并给出选项：' + record.ambiguous)
  })

  // ── AC1: explicit close, undo ──
  await check('AC1', '明确收单 → 已完成、接口人回复与撤销；执行者未收到；撤销回到等待', async record => {
    const i = PHRASES.explicit.indexOf(AC1_PHRASE), s = o['explicit' + i], row = rows.explicit[i]
    assert.ok(row, '先跑明确收单')
    Object.assign(record, {phrase: AC1_PHRASE, intent: row.intent, judgeMs: row.judgeMs, budget: {before: row.budgetBefore, after: row.budgetAfter}, reachedExecutor: row.reachedExecutor, note: row.note, ownerMessage: row.ownerMessage})
    assert.equal(row.statusAfter, 'done')
    assert.equal(row.note?.author, '接口人')
    assert.equal(row.note?.text, '已按你的话收单。')
    assert.deepEqual(row.note?.actions?.map(a => [a.kind, a.label]), [['reopen', '撤销']])
    assert.equal(row.ownerMessage?.held, 'completed')
    assert.equal(row.reachedExecutor, 0, '执行者没有收到这句话')
    assert.equal(row.budgetAfter, row.budgetBefore, '额度不变')
    const order = await orderNow(s)
    record.completed = {completedAt: order.completedAt, completedBy: order.completedBy, completedFrom: order.completedFrom}
    assert.equal(order.completedBy, 'owner-words')
    if (browserWanted) {
      const {message, choice} = await choose(desktop, s, row.note.id, '撤销')
      await picture(desktop, 'ac1-completed-1280')
      await choice.click()
      await message.locator('.v2-choice-done').waitFor({timeout: 30_000})
      record.undoneNote = (await message.locator('.v2-choice-done').textContent())?.trim()
      record.undoVia = 'desktop UI 1280 px'
    } else await h.post(s.orderPath + '/action', {action: 'reopen', from: row.note.id})
    const reopened = await poll(async () => { const order = await orderNow(s); return order.status === 'waiting' && order }, '撤销后回到等待', 30_000, 500)
    record.afterUndo = {status: reopened.status, reason: reopened.reason, remainingTurns: reopened.remainingTurns}
    assert.equal(reopened.remainingTurns, row.budgetBefore, '撤销后额度仍不变')
    assert.equal(reached(s, AC1_PHRASE).length, 0)
    if (browserWanted) {
      await openOrderPage(desktop, s)
      await desktop.locator('[data-message-id="' + row.note.id + '"]').scrollIntoViewIfNeeded()
      await picture(desktop, 'ac1-undone-1280')
      // Completed again for the display checks of AC7 (the overview keeps one finished order of each kind).
    }
    await h.post(s.orderPath + '/action', {action: 'complete'})
  })

  // ── AC2: ambiguous words held; 「继续交给执行者」 sends them exactly once ──
  await check('AC2', '含糊的话保留并给出选项；继续交给执行者只发一次', async record => {
    const s = o.ambiguous, row = rows.ambiguous.find(r => r.text === '可以验收了')
    assert.ok(row?.note, '「可以验收了」有接口人的说明')
    Object.assign(record, {phrase: row.text, intent: row.intent, outcome: row.outcome, note: row.note, ownerMessage: row.ownerMessage})
    assert.equal(row.outcome, 'held')
    assert.deepEqual(row.note.actions.map(a => a.label), ['确认收单', '继续交给执行者'])
    assert.equal(row.reachedExecutor, 0)
    const before = await orderNow(s), since = new Date().toISOString(), turnsBefore = orderTurns(s).length
    if (browserWanted) {
      const {message, choice} = await choose(desktop, s, row.note.id, '继续交给执行者')
      await desktop.locator('[data-message-id="' + row.ownerMessage.id + '"] .v2-held-note').waitFor({timeout: 10_000})
      await picture(desktop, 'ac2-held-1280')
      await choice.click()
      await message.locator('.v2-choice-done').waitFor({timeout: 60_000})
      record.forwardVia = 'desktop UI 1280 px'
    } else {
      const sent = await h.post(s.sessionPath + '/messages/' + row.ownerMessage.id + '/forward')
      record.forwardResponse = {forwarded: sent.forwarded, delivery: sent.delivery}
    }
    await poll(() => reached(s, row.text, since).length > 0, 'Codex 收到转交的话', 5 * 60_000, 500)
    await settled(s)
    // A second forward of the same words is refused.
    const again = await h.call(s.sessionPath + '/messages/' + row.ownerMessage.id + '/forward', {requestId: randomUUID()})
    const after = await orderNow(s)
    const turns = orderTurns(s).slice(turnsBefore)
    Object.assign(record, {reachedExecutor: reached(s, row.text).length, dispatchedTurns: orderTurns(s).filter(t => t.text === row.text).length, secondForward: {status: again.status, error: again.body.error},
      budget: {before: before.remainingTurns, after: after.remainingTurns, autoFollowUps: turns.filter(t => t.id.startsWith('accept-')).length},
      turns: turns.map(t => ({id: t.id.slice(0, 18), state: t.state, text: t.text.slice(0, 60)})), statusAfter: after.status})
    assert.equal(record.dispatchedTurns, 1, '这句话只派发一次')
    assert.ok(record.reachedExecutor >= 1, 'Codex 收到了这句话')
    assert.equal(again.status, 409, '再次转交被拒')
    assert.equal(after.remainingTurns, before.remainingTurns - 1 - record.budget.autoFollowUps, '转交按一轮扣额度')
    // The other held words: one click on 「确认收单」 (phone) completes the order; the rest stay unsent.
    const other = rows.ambiguous.find(r => r.text === '看着可以')
    if (browserWanted) {
      const {message, choice} = await choose(mobile, s, other.note.id, '确认收单')
      await picture(mobile, 'ac2-choices-390')
      await choice.click()
      await message.locator('.v2-choice-done').waitFor({timeout: 30_000})
      record.confirmVia = 'phone UI 390 px'
    } else await h.post(s.orderPath + '/action', {action: 'complete', from: other.note.id})
    const done = await poll(async () => { const order = await orderNow(s); return order.status === 'done' && order }, '确认收单后完成', 30_000, 500)
    const view = await transcript(s)
    record.heldAfter = Object.fromEntries(rows.ambiguous.map(r => [r.text, view.messages.find(m => m.id === r.ownerMessage?.id)?.held]))
    record.completedBy = done.completedBy
    assert.equal(done.completedBy, 'owner')
    record.dispatchedByPhrase = Object.fromEntries(rows.ambiguous.map(r => [r.text, orderTurns(s).filter(t => t.text === r.text).length]))
    for (const r of rows.ambiguous) assert.equal(record.dispatchedByPhrase[r.text], r === row ? 1 : 0, '只有转交的那句派发给执行者：' + r.text)
    if (browserWanted) {
      await openOrderPage(mobile, s)
      await mobile.locator('[data-message-id="' + other.note.id + '"]').scrollIntoViewIfNeeded()
      await picture(mobile, 'ac2-confirmed-390')
    }
  })

  // ── AC3: ordinary words are not slowed; an unavailable reading holds the words with choices ──
  await check('AC3', '普通发言不增加延迟；判断不可用时给出选项', async record => {
    const s = o.normal
    const text = '把第三题改成表格'
    const since = new Date().toISOString()
    const response = await h.call(s.sessionPath + '/messages', {text, requestId: randomUUID(), workOrderId: s.order.id, wait: false})
    assert.equal(response.status, 200)
    const judges = await judgeOf(text, since)
    await poll(() => reached(s, text, since).length > 0, 'Codex 收到普通发言', 5 * 60_000, 500)
    await settled(s)
    const hits = rows.normal.filter(r => r.judgeCalls)
    const ms = list => list.map(r => r.judgeMs).filter(Number.isFinite)
    record.plain = {text, postMs: response.ms, judgeCalls: judges.length, reachedExecutor: reached(s, text).length}
    record.lexiconHits = {count: hits.length, judgeMs: ms(hits), postMs: hits.map(r => r.postMs)}
    record.noLexicon = rows.normal.filter(r => !r.judgeCalls).map(r => ({text: r.text, postMs: r.postMs}))
    assert.equal(judges.length, 0, '不含收单词语的话不经接口人判断（零额外延迟）')
    assert.equal(record.plain.reachedExecutor, 1)
    // The liaison's model does not answer within 8 s: the words are held with choices, never lost.
    const u = o.unavailable
    await h.probe({action: 'hold', ms: 12_000})
    let stalled, completeStalled
    try {
      stalled = await ownerSays(u, '没问题，继续做第五题', {expect: 'held (reading unavailable)'})
      completeStalled = await ownerSays(u, '可以收单', {expect: 'held (reading unavailable)'})
    } finally { await h.probe({action: 'hold', ms: 0}) }
    record.unavailable = [stalled, completeStalled].map(r => ({text: r.text, outcome: r.outcome, intent: r.intent, reason: r.reason, postMs: r.postMs, judgeHeldMs: r.judgeHeldMs,
      judgeAbandoned: r.judgeAbandoned, held: r.ownerMessage?.held, note: r.note?.text, actions: r.note?.actions?.map(a => a.label), reachedExecutor: r.reachedExecutor,
      budget: [r.budgetBefore, r.budgetAfter], statusAfter: r.statusAfter}))
    for (const r of [stalled, completeStalled]) {
      assert.equal(r.outcome, 'held', '判断不可用时保留：' + r.text)
      assert.equal(r.intent, 'failed')
      assert.equal(r.ownerMessage?.held, 'choosing')
      assert.deepEqual(r.note?.actions?.map(a => a.kind), ['complete', 'forward'])
      assert.match(r.note?.text ?? '', /^我没能确认这句话是不是要收单。/)
      assert.equal(r.reachedExecutor, 0)
      assert.ok(r.postMs < 11_000, '8 秒时限后即答复：' + r.postMs)
    }
    assert.equal(completeStalled.statusAfter, 'waiting', '判断不可用时“可以收单”也不直接收单')
    // Not lost: the instruction is handed over once by the owner's choice.
    const at = new Date().toISOString()
    if (browserWanted) {
      const {message, choice} = await choose(desktop, u, stalled.note.id, '继续交给执行者')
      await picture(desktop, 'ac3-unavailable-held-1280')
      await choice.click()
      await message.locator('.v2-choice-done').waitFor({timeout: 60_000})
    } else await h.post(u.sessionPath + '/messages/' + stalled.ownerMessage.id + '/forward')
    await poll(() => reached(u, '继续做第五题', at).length > 0, 'Codex 收到转交的指令', 5 * 60_000, 500)
    await settled(u)
    record.unavailableForwarded = {dispatchedTurns: orderTurns(u).filter(t => t.text === stalled.text).length, reachedExecutor: reached(u, '继续做第五题').length}
    assert.equal(record.unavailableForwarded.dispatchedTurns, 1, '转交后只派发一次')
    // The held 「可以收单」 still offers the choice afterwards (the reading is not retried silently).
    const view = await transcript(u)
    record.stillChoosing = view.messages.find(m => m.id === completeStalled.ownerMessage.id)?.held
    assert.equal(record.stillChoosing, 'choosing')
  })

  // ── AC4: one-click completion after a passing review; 「标为完成」 in the information panel ──
  await check('AC4', '验收达标后「确认收单」；信息栏「标为完成」', async record => {
    const candidates = [o.review, o.panel].filter(Boolean)
    const passing = []
    for (const s of candidates) {
      const view = await transcript(s)
      const verdict = liaisonMessages(view.messages).find(m => m.text.startsWith('已对照约定核对') && m.actions?.some(a => a.kind === 'complete'))
      passing.push({s, verdict, acceptance: (await orderNow(s)).acceptance})
    }
    record.reviews = passing.map(row => ({order: row.s.order.title, acceptance: row.acceptance, verdict: row.verdict && {id: row.verdict.id, text: row.verdict.text.slice(0, 300), actions: row.verdict.actions}}))
    const review = passing.find(row => row.verdict)
    assert.ok(review, '有接口人验收达标的消息并附“确认收单”')
    assert.deepEqual(review.verdict.actions.map(a => a.label), ['确认收单'])
    const s = review.s
    const budget = (await orderNow(s)).remainingTurns
    if (browserWanted) {
      const {message, choice} = await choose(desktop, s, review.verdict.id, '确认收单')
      await picture(desktop, 'ac4-review-pass-1280')
      await choice.click()
      await message.locator('.v2-choice-done').waitFor({timeout: 30_000})
      record.doneNote = (await message.locator('.v2-choice-done').textContent())?.trim()
      await picture(desktop, 'ac4-review-confirmed-1280')
    } else await h.post(s.orderPath + '/action', {action: 'complete', from: review.verdict.id})
    const done = await poll(async () => { const order = await orderNow(s); return order.status === 'done' && order }, '一键收单完成', 30_000, 500)
    record.confirmed = {order: s.order.title, status: done.status, completedBy: done.completedBy, budget: [budget, done.remainingTurns]}
    assert.equal(done.completedBy, 'owner')
    assert.equal(done.remainingTurns, budget)
    // 「标为完成」 on the other order (phone, folded information).
    const other = candidates.find(c => c !== s)
    if (other) {
      if (browserWanted) {
        await openOrderPage(mobile, other)
        const panel = await infoPanel(mobile)
        const mark = panel.getByRole('button', {name: '标为完成', exact: true})
        await mark.scrollIntoViewIfNeeded()
        await picture(mobile, 'ac4-panel-before-390')
        await mark.click()
        await panel.getByRole('button', {name: '重新打开', exact: true}).waitFor({timeout: 30_000})
        record.panelState = await ledger(panel, '状态')
        record.panelCompleted = await ledger(panel, '完成时间')
        await panel.getByRole('button', {name: '重新打开', exact: true}).scrollIntoViewIfNeeded()
        await picture(mobile, 'ac4-panel-done-390')
      } else await h.post(other.orderPath + '/action', {action: 'complete'})
      const marked = await poll(async () => { const order = await orderNow(other); return order.status === 'done' && order }, '标为完成', 30_000, 500)
      record.panel = {order: other.order.title, status: marked.status, completedBy: marked.completedBy}
      if (browserWanted) {
        assert.equal(record.panelState, '已完成')
        assert.match(record.panelCompleted ?? '', /你已确认收单/)
      }
    }
  })

  // ── AC6: the next follow-up only from an enabled schedule; AC5: 「可以收单」 on a scheduled order ──
  let scheduleNext
  await check('AC6', '下次跟进只取周期安排；日历同步', async record => {
    const s = o.schedule
    const tomorrow = new Date(Date.now() + 24 * 3600_000)
    const weekday = Number(new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Shanghai', weekday: 'short'}).formatToParts(tomorrow).find(p => p.type === 'weekday').value
      .replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/, d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(d)))
    const before = await orderNow(s)
    record.beforeSchedule = {nextCheckAt: before.nextCheckAt ?? null, hasSchedule: before.hasSchedule ?? false}
    assert.equal(before.nextCheckAt, undefined, '没有周期安排时不提供下次跟进（也没有开单默认的 24 小时）')
    const followup = await h.post(s.orderPath + '/followup', {action: 'schedule', weekday, time: '09:30'})
    record.schedule = followup.schedule
    assert.equal(followup.schedule?.enabled, true)
    const order = await orderNow(s)
    scheduleNext = order.nextCheckAt
    const local = scheduleNext && new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short'}).format(new Date(scheduleNext))
    record.afterSchedule = {nextCheckAt: scheduleNext, local, hasSchedule: order.hasSchedule}
    assert.ok(scheduleNext, '有周期安排时显示下次时间')
    assert.match(local, /09:30$/)
    assert.ok(Date.parse(scheduleNext) > Date.now() && Date.parse(scheduleNext) - Date.now() <= 7 * 24 * 3600_000)
    const view = await h.get(wsPath)
    record.others = view.orders.filter(row => row.id !== s.order.id).map(row => ({title: row.title, status: row.status, nextCheckAt: row.nextCheckAt ?? null}))
    assert.ok(record.others.every(row => row.nextCheckAt === null), '其他工单都不显示下次跟进')
    const week = scheduleNext && new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'}).format(new Date(scheduleNext))
    const calendar = await h.get('/v2/calendar', '&week=' + week)
    record.calendar = calendar.entries.filter(row => row.kind === 'checkpoint').map(row => ({id: row.id, title: row.title, start: row.start}))
    assert.deepEqual(record.calendar.map(row => row.id), ['checkpoint:' + s.order.id], '日历只有周期安排的跟进')
    if (browserWanted) {
      await openOrderPage(desktop, s)
      const panel = await infoPanel(desktop)
      record.panelNext = await ledger(panel, '下次跟进')
      assert.match(record.panelNext ?? '', /按周期安排/)
      await picture(desktop, 'ac6-scheduled-1280')
      const plain = o.normal ?? o.review ?? o.panel
      if (plain) {
        await openOrderPage(desktop, plain)
        record.plainHasNext = await (await infoPanel(desktop)).locator('dt', {hasText: /^下次跟进$/}).count()
        assert.equal(record.plainHasNext, 0, '没有安排的工单不显示下次跟进')
      }
      await desktop.goto(h.host.base + '/#v2?' + new URLSearchParams({scope: h.scope, view: 'calendar', date: week}))
      await desktop.getByRole('region', {name: '个人日历'}).waitFor({timeout: 30_000})
      await desktop.getByText(s.order.title).first().waitFor({timeout: 30_000})
      await picture(desktop, 'ac6-calendar-1280')
    }
  })

  await check('AC5', '有周期安排时给出「收单并停止周期安排」；确认后完成并停用', async record => {
    const s = o.schedule
    const followup = await h.get(s.orderPath + '/followup')
    if (!followup.schedule?.enabled) {
      const tomorrow = new Date(Date.now() + 24 * 3600_000)
      await h.post(s.orderPath + '/followup', {action: 'schedule', weekday: tomorrow.getDay(), time: '09:30'})
    }
    const row = await ownerSays(s, '可以收单', {expect: 'held (scheduled)'})
    Object.assign(record, {intent: row.intent, judgeMs: row.judgeMs, outcome: row.outcome, note: row.note, ownerMessage: row.ownerMessage, budget: [row.budgetBefore, row.budgetAfter], reachedExecutor: row.reachedExecutor})
    evidence.classifier.push({...row, class: 'scheduled'})
    assert.equal(row.outcome, 'held', '不直接收单')
    assert.equal(row.statusAfter, 'waiting')
    assert.match(row.note?.text ?? '', /^这张工单有启用中的周期安排，我没有直接收单。/)
    assert.deepEqual(row.note?.actions?.map(a => a.label), ['收单并停止周期安排', '继续交给执行者'])
    assert.equal(row.reachedExecutor, 0)
    if (browserWanted) {
      const {message, choice} = await choose(desktop, s, row.note.id, '收单并停止周期安排')
      await picture(desktop, 'ac5-scheduled-choice-1280')
      await choice.click()
      await message.locator('.v2-choice-done').waitFor({timeout: 30_000})
      await picture(desktop, 'ac5-scheduled-done-1280')
    } else await h.post(s.orderPath + '/action', {action: 'complete', from: row.note.id, stopSchedule: true})
    const done = await poll(async () => { const order = await orderNow(s); return order.status === 'done' && order }, '收单并停止周期安排', 30_000, 500)
    const after = await h.get(s.orderPath + '/followup')
    const week = scheduleNext && new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai'}).format(new Date(scheduleNext))
    const calendar = week ? await h.get('/v2/calendar', '&week=' + week) : {entries: []}
    Object.assign(record, {status: done.status, completedBy: done.completedBy, nextCheckAt: done.nextCheckAt ?? null, schedule: after.schedule,
      calendarCheckpoints: calendar.entries.filter(row => row.kind === 'checkpoint').map(row => row.id)})
    assert.equal(after.schedule?.enabled, false, '安排已停用')
    assert.equal(done.nextCheckAt, undefined)
    assert.equal(record.calendarCheckpoints.length, 0, '日历不再有该事项')
  })

  // ── AC7: 「已完成」 and 「已关闭」 on the overview, 「今天」 and the order page ──
  await check('AC7', '已完成与已关闭的展示（1280 / 390）', async record => {
    const done = o['explicit' + PHRASES.explicit.indexOf('完成了')] ?? o['explicit0']
    const closed = o.cancelled
    assert.ok(done && closed)
    if ((await orderNow(done)).status !== 'done') await h.post(done.orderPath + '/action', {action: 'complete'})
    await h.post(closed.orderPath + '/action', {action: 'cancel'})
    const [a, b] = [await orderNow(done), await orderNow(closed)]
    record.orders = {done: {title: a.title, status: a.status, completedBy: a.completedBy}, closed: {title: b.title, status: b.status, reason: b.reason}}
    assert.equal(a.status, 'done')
    assert.equal(b.status, 'closed')
    // 「今天」 lists the results of these two orders unread; everything else is marked read.
    let all = []
    for (let offset = 0; ; offset += 25) {
      const page = await h.get('/v2/notices', offset ? '&offset=' + offset : '')
      all.push(...page.items)
      if (page.nextOffset === undefined) break
    }
    for (const row of all.filter(row => !row.read && row.orderId !== a.id && row.orderId !== b.id)) await h.post('/v2/notices/' + row.id + '/read')
    const notices = (await h.get('/v2/notices')).items.filter(row => row.orderId === a.id || row.orderId === b.id)
    record.notices = notices.map(row => ({orderTitle: row.orderTitle, orderDone: row.orderDone ?? false, read: row.read}))
    assert.ok(notices.some(row => row.orderId === a.id && row.orderDone === true), '已完成工单的交付标“工单已完成”')
    assert.ok(notices.filter(row => row.orderId === b.id).every(row => !row.orderDone), '已关闭工单不标已完成')
    if (!browserWanted) return
    record.ui = {}
    for (const page of [desktop, mobile]) {
      const ui = record.ui[width(page)] = {}
      await page.goto(origin(page) + '/#v2?' + new URLSearchParams({scope: h.scope, view: 'workspace', workspace: workspace.id}))
      await page.reload()
      const overview = page.getByRole('region', {name: '会话与工单'})
      await overview.waitFor({timeout: 30_000})
      const doneRow = overview.locator('button.v2-order-row', {hasText: a.title}).first()
      const closedRow = overview.locator('button.v2-order-row', {hasText: b.title}).first()
      ui.overview = {done: (await doneRow.locator('.v2-status').textContent())?.trim(), doneNote: (await doneRow.locator('.v2-next').textContent())?.trim(),
        closed: (await closedRow.locator('.v2-status').textContent())?.trim(), closedNote: (await closedRow.locator('.v2-next').textContent().catch(() => ''))?.trim()}
      assert.equal(ui.overview.done, '已完成')
      assert.equal(ui.overview.closed, '已关闭')
      ui.overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      await doneRow.scrollIntoViewIfNeeded()
      await picture(page, 'ac7-overview-' + width(page))
      await page.goto(origin(page) + '/#v2?' + new URLSearchParams({scope: h.scope, view: 'today'}))
      const inbox = page.getByRole('region', {name: '工单交付提醒'})
      await inbox.waitFor({timeout: 30_000})
      ui.today = await inbox.locator('button.v2-row small').allTextContents()
      assert.ok(ui.today.some(text => text.startsWith(a.title + ' · 工单已完成')), '「今天」标出工单已完成')
      assert.ok(ui.today.filter(text => text.startsWith(b.title)).every(text => !text.includes('工单已完成')))
      await inbox.scrollIntoViewIfNeeded()
      await picture(page, 'ac7-today-' + width(page))
      await openOrderPage(page, done)
      let panel = await infoPanel(page)
      ui.donePage = {state: await ledger(panel, '状态'), completed: await ledger(panel, '完成时间'), reopen: await panel.getByRole('button', {name: '重新打开', exact: true}).count(),
        footer: (await page.locator('.v2-send-footer').first().textContent().catch(() => ''))?.trim()}
      assert.equal(ui.donePage.state, '已完成')
      await picture(page, 'ac7-order-done-' + width(page))
      await openOrderPage(page, closed)
      panel = await infoPanel(page)
      ui.closedPage = {state: await ledger(panel, '状态'), reason: await ledger(panel, '关闭原因')}
      assert.equal(ui.closedPage.state, '已关闭')
      await picture(page, 'ac7-order-closed-' + width(page))
      if (page === mobile) assert.ok(ui.overflow <= 0, '390 px 无横向溢出')
    }
  })

  evidence.judgeRequests = (await h.probe({action: 'requests', kind: 'judge'})).map(row => ({at: row.at, model: row.provider + '/' + row.model, heldMs: row.heldMs, abandoned: row.abandoned,
    ms: row.answeredAt ? Date.parse(row.answeredAt) - Date.parse(row.at) : undefined, owner: /"主人这句话":"([^"]*)"/.exec(row.lastUser)?.[1], reply: row.reply}))
  evidence.reviewModels = [...new Set((await h.probe({action: 'requests', kind: 'review'})).map(row => row.provider + '/' + row.model))]
  evidence.executorModels = [...new Set(Object.values(o).flatMap(s => orderTurns(s).map(turn => turn.model)).filter(Boolean))]
  evidence.hostLogTail = h.host.logs().split('\n').filter(line => /error|warn/i.test(line)).slice(-30).join('\n')
  await h.host.stop()
} catch (error) {
  evidence.fatal = error instanceof Error ? error.stack : String(error)
  log('FATAL', evidence.fatal)
} finally {
  evidence.endedAt = new Date().toISOString()
  save()
  await browser?.close().catch(() => {})
  for (const host of opened) {
    const homes = await host.dispose().catch(error => ({warnings: [String(error?.message ?? error)]}))
    if (homes) (evidence.toolHomes ??= []).push(homes)
  }
  save()
  for (const file of isolatedCredentials) rmSync(file, {force: true})
  if (!keep) rmSync(base, {recursive: true, force: true})
  else log('保留隔离目录', base)
}
for (const row of evidence.classifier) console.log([row.class, row.text, row.intent, row.outcome, (row.judgeMs ?? '-') + 'ms', 'post ' + row.postMs + 'ms', row.pass === false ? 'MISS' : 'ok'].join(' | '))
const results = Object.entries(evidence.results)
for (const [name, row] of results) console.log((row.status === 'pass' ? 'PASS ' : 'FAIL ') + name + (row.error ? ' — ' + row.error : ''))
process.exitCode = results.every(([, row]) => row.status === 'pass') && !evidence.fatal ? 0 : 1
