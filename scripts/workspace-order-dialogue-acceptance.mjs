/**
 * Order-dialogue acceptance (task 11-22, prd AC1–AC8 and AC10; AC9 is scripts/liaison-routing-eval.mjs) with the REAL
 * Codex CLI, Claude Code and the DSH workspace team, using the owner's own tool configuration and logins, in an
 * isolated, disposable DSH host that installs the candidate package.
 *
 *   CHIEF_ACCEPTANCE_PACKAGE=/tmp/pack/dsh-chief-<v>.tgz \
 *   CHIEF_PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs \
 *   [CHIEF_OD_LEGACY_PACKAGE=/tmp/old-pack/dsh-chief-<v>.tgz]   # pre-change build for AC8 (old records, upgrade)
 *   CHIEF_OD_EVIDENCE=/path/evidence.json CHIEF_OD_SCREENSHOTS=/path/screenshots \
 *   node scripts/workspace-order-dialogue-acceptance.mjs [all|codex|claude-code|dsh|staff …] [--only AC1,AC2] \
 *     [--model provider/model] [--no-browser] [--keep]
 *
 * The executor arguments choose who is interrupted in AC2 (default: all four). The liaison, its acceptance review,
 * the workspace team and named staff use `--model` (default deepseek-official/deepseek-flash, credential read from the
 * everyday DSH without writing it). `--model openai-codex/<model>` (the production liaison, e.g. gpt-6.1-terra) installs
 * dsh-codex-subscription@3.2.24 in the isolated host and copies ONLY the everyday login's current access token, with a
 * placeholder refresh token, exactly as scripts/liaison-routing-eval.mjs does: the isolated host can never rotate the
 * owner's login. A missing token or one expiring within two hours stops the run (no silent fallback to another model).
 *
 * Safety: the tools are asked only for harmless steps confined to the isolated brain (sleep, printf, ls, cat and files
 * in the session directory; one `rm` of a probe file under the ask tier). Faults are simulated outside product code:
 * scripts/workspace-order-dialogue-codex-proxy.mjs sits in front of the real `codex` on the host's PATH (strip the
 * hook-trust thread parameter, fake its warning, reject one steer), and scripts/workspace-order-dialogue-probe.mjs can
 * hold the liaison's review request for a few seconds so the owner can speak while it is pending.
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
const valued = new Set(['--only', '--model'])
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const positional = argv.filter((arg, i) => !arg.startsWith('--') && !valued.has(argv[i - 1]))
const EXECUTORS = ['codex', 'claude-code', 'dsh', 'staff']
const interrupted = !positional.length || positional.includes('all') ? EXECUTORS : positional
for (const name of interrupted) assert.ok(EXECUTORS.includes(name), '未知执行者 ' + name + '；可选 ' + EXECUTORS.join('、'))
const only = option('--only')?.split(',').map(s => s.trim().toUpperCase())
const wanted = ac => !only || only.includes(ac)
const browserWanted = !argv.includes('--no-browser') && !!process.env.CHIEF_PLAYWRIGHT_PATH
const keep = argv.includes('--keep')
const MODEL = option('--model') || 'deepseek-official/deepseek-flash'
const shotsDir = process.env.CHIEF_OD_SCREENSHOTS
const evidenceFile = process.env.CHIEF_OD_EVIDENCE
const legacyPackage = process.env.CHIEF_OD_LEGACY_PACKAGE

const which = name => execFileSync('bash', ['-lc', 'command -v ' + name], {encoding: 'utf8'}).trim()
const realCodex = which('codex'), realClaude = which('claude')
const evidence = {model: MODEL, candidate: process.env.CHIEF_ACCEPTANCE_PACKAGE, legacy: legacyPackage, startedAt: new Date().toISOString(),
  tools: {codex: execFileSync(realCodex, ['--version'], {encoding: 'utf8'}).trim(), claude: execFileSync(realClaude, ['--version'], {encoding: 'utf8'}).trim()},
  results: {}, notes: [], screenshots: []}
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)
const save = () => { if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)) }

const base = join(tmpdir(), 'chief-order-dialogue-' + randomUUID().slice(0, 8))
mkdirSync(base, {recursive: true, mode: 0o700})
const wrappers = join(base, 'bin'), control = join(base, 'proxy-control.json'), proxyLog = join(base, 'codex-proxy.jsonl')
mkdirSync(wrappers)
writeFileSync(control, '{}')
writeFileSync(join(wrappers, 'codex'), '#!/bin/sh\n# Acceptance only: record the app-server traffic and simulate listed faults (see the proxy file).\nexec '
  + JSON.stringify(process.execPath) + ' ' + JSON.stringify(fileURLToPath(new URL('./workspace-order-dialogue-codex-proxy.mjs', import.meta.url))) + ' "$@"\n')
chmodSync(join(wrappers, 'codex'), 0o700)
const setFaults = value => writeFileSync(control, JSON.stringify(value))
const proxyRows = () => existsSync(proxyLog) ? readFileSync(proxyLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const hostEnv = {PATH: wrappers + delimiter + process.env.PATH, CHIEF_OD_PROXY_REAL: realCodex, CHIEF_OD_PROXY_CONTROL: control, CHIEF_OD_PROXY_LOG: proxyLog}

const hash = (...items) => createHash('sha256').update(JSON.stringify(items)).digest('hex')
const leadOf = (scope, workspaceId, sessionId) => 'chief-v2-group-' + hash(scope).slice(0, 12) + '-' + hash(workspaceId, sessionId).slice(0, 28)
const table = text => /\|\s*:?-{3,}/.test(text)
const steps = (...lines) => '这是 SuperHub 的验收测试。请严格按顺序执行下面的步骤：每条命令单独调用一次终端工具，不要把多条命令合并成一条，所有文件都在当前工作目录。\n'
  + lines.map((line, i) => (i + 1) + '. ' + line).join('\n')

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
/** Every host opened, so each one's private tool homes are removed at the end. */
const opened = []

/** One running candidate host and everything the cases need to talk to it. */
async function open(candidate) {
  const host = await acceptanceHost({candidate, probe: 'workspace-order-dialogue-probe.mjs', model: MODEL, mobile: true, directory: base, extraEnv: hostEnv})
  opened.push(host)
  if (MODEL.startsWith('openai-codex/')) {
    isolatedCredentials.add(join(host.home, '.credentials.yaml'))
    await codexSubscription(host)
  }
  const yaml = (await import('yaml')).default
  const rulesFile = join(host.brain, 'rules.yaml')
  writeFileSync(rulesFile, yaml.stringify({...yaml.parse(readFileSync(rulesFile, 'utf8')), rules: []}))
  const h = {host, scope: '', q: ''}
  h.boot = async () => {
    await host.start()
    await host.api('/pause', {paused: true})
    const boot = await host.api('/v2/bootstrap')
    h.scope = boot.scope
    h.build = boot.build
    h.q = '?scope=' + encodeURIComponent(h.scope)
  }
  h.get = path => host.api(path + h.q)
  h.post = (path, body = {}) => host.api(path + h.q, {...body, requestId: randomUUID()})
  h.probe = body => host.request('/chief-order-dialogue-probe', body)
  /** POST without the 18 s client timeout: an owner message without `wait:false` answers when the turn ends. */
  h.call = (path, body) => {
    const started = Date.now(), payload = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const request = httpRequest(host.base + '/chief/api' + path + h.q, {method: 'POST',
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
  h.bind = (session, order, workspaceId) => {
    const area = hash(h.scope, workspaceId), room = hash(area, session.id)
    return {session, order, wsId: workspaceId, sessionPath: '/v2/workspaces/' + workspaceId + '/sessions/' + session.id,
      orderPath: '/v2/workspaces/' + workspaceId + '/orders/' + order.id, lead: leadOf(h.scope, workspaceId, session.id),
      work: join(host.brain, 'work', 'superhub-v2', area, room), journal: join(host.brain, 'ops', 'superhub-v2-dialogues', area, room, 'source.json')}
  }
  h.board = () => {
    const dir = join(host.brain, 'ops', 'superhub-v2')
    for (let i = 0; i < 5; i++) {
      try { return JSON.parse(readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith('.json'))), 'utf8')) } catch { /* replaced while reading */ }
    }
    return {}
  }
  return h
}

const journalOf = s => { try { return JSON.parse(readFileSync(s.journal, 'utf8')) } catch { return {messages: [], turns: []} } }
const orderTurns = s => journalOf(s).turns.filter(turn => turn.workOrderId === s.order.id)
const turnBrief = turns => turns.map(turn => ({id: turn.id.slice(0, 18), state: turn.state, liaison: turn.liaison ? (turn.liaison.handoff ? 'handoff' : 'follow-up') : undefined,
  text: turn.text.slice(0, 120), interjections: turn.interjections?.map(row => ({state: row.state, text: row.text.slice(0, 80)})), startedAt: turn.startedAt, endedAt: turn.endedAt,
  model: turn.model, resumed: !!turn.resumed, failure: turn.failure}))
const brief = messages => messages.map(m => ({author: m.author, role: m.role, at: m.at, text: m.text.slice(0, 400), ...(m.quote && {quote: {label: m.quote.label, text: m.quote.text.slice(0, 200)}}),
  ...(m.delivery && {delivery: m.delivery}), ...(m.relayed && {relayed: true}), ...(m.attachments?.length && {attachments: m.attachments.map(a => a.label)})}))
const fileText = path => existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined

function copied(handoff, said) {
  const plain = text => text.replace(/[\s，。、：；！？,.:;!?「」“”"'（）()——]/g, '')
  const a = plain(handoff), b = plain(said)
  if (!a || !b) return false
  let longest = 0
  const previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0
      if (previous[j] > longest) longest = previous[j]
      diagonal = above
    }
  }
  return longest >= Math.min(a.length, b.length) * 0.6
}

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
async function theme(page, mode) {
  await page.emulateMedia({colorScheme: mode})
  if (page === desktop) await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, mode === 'dark', {timeout: 10_000}).catch(() => {})
}
const button = (page, name) => page.getByRole('button', {name, exact: true})

let h, workspace, wsPath, liaisonSession
const origin = page => page === desktop ? h.host.base : h.host.mobileBase
const orderHash = s => '#v2?' + new URLSearchParams({scope: h.scope, view: 'workspace', workspace: s.wsId, order: s.order.id})
async function openOrderPage(page, s) {
  await page.goto(origin(page) + '/' + orderHash(s))
  await page.getByRole('heading', {name: s.order.title, exact: true, level: 1}).waitFor({timeout: 30_000})
  await page.getByLabel('发言', {exact: true}).waitFor({timeout: 30_000})
}
async function signInPages(host, password) {
  await desktop.context().addCookies(host.cookie().split('; ').map(row => ({name: row.slice(0, row.indexOf('=')), value: row.slice(row.indexOf('=') + 1), url: host.base})))
  await mobile.goto(host.mobileBase)
  await mobile.getByLabel('密码').fill(password)
  await button(mobile, '进入').click()
  await mobile.getByRole('heading', {name: '今天', exact: true}).waitFor({timeout: 30_000})
}

const transcript = s => h.get(s.sessionPath)
const orderNow = async s => (await h.get(s.orderPath)).order
const execution = s => h.get(s.orderPath + '/execution')
const ownerSays = (s, text, extra = {}) => h.call(s.sessionPath + '/messages', {text, requestId: randomUUID(), ...(s.order && {workOrderId: s.order.id}), wait: false, ...extra})
const agentReplies = messages => messages.filter(m => m.role === 'agent' && m.author !== '接口人' && m.author !== '交付验收')

async function scenario(name, {executor, permission, staffId, title, promise}) {
  if (staffId) {
    const {order} = await h.post(wsPath + '/orders', {title, promise, staffId})
    const session = (await h.get(wsPath)).sessions.find(row => row.id === order.sessionId)
    return h.bind(session, order, workspace.id)
  }
  const {session} = await h.post(wsPath + '/sessions', {title: name, kind: executor === 'dsh' ? 'group' : 'coding', executor})
  const {order} = await h.post(wsPath + '/orders', {title, promise, sessionId: session.id, ...(permission && {permission})})
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
  }, '会话安静下来', timeout)
}
const working = s => poll(async () => (await transcript(s)).working, '执行者开始工作', 5 * 60_000, 500)
const commandStarted = (s, pattern) => poll(async () => (await execution(s)).commands.some(row => pattern.test(row.command)), '命令开始 ' + pattern, 10 * 60_000, 500)

/** Owner speaks on the order page: the composer must be usable while the executor works. */
async function uiSpeak(page, s, text, shot, {expectWorking = true} = {}) {
  await openOrderPage(page, s)
  const box = page.getByLabel('发言', {exact: true})
  const result = {}
  if (expectWorking) {
    await page.getByText('对方正在工作，你的话会立即送达').waitFor({timeout: 30_000})
    result.workingHint = true
  }
  result.enabledBefore = await box.isEnabled()
  assert.ok(result.enabledBefore, '执行者工作时输入框可用')
  await box.fill(text)
  if (shot) await picture(page, shot + '-typing')
  const response = page.waitForResponse(r => r.request().method() === 'POST' && /\/sessions\/[^/]+\/messages\?/.test(r.url()), {timeout: 120_000})
  const started = Date.now()
  await button(page, '发送').click()
  const answer = await response
  result.status = answer.status()
  result.body = await answer.json().catch(() => ({}))
  result.ms = Date.now() - started
  result.delivery = result.body.delivery
  result.enabledAfter = await box.isEnabled()
  assert.equal(result.status, 200, '发言送达：' + JSON.stringify(result.body).slice(0, 300))
  assert.ok(result.enabledAfter, '发出后输入框仍可用')
  await page.locator('[data-message-id]').filter({hasText: text.slice(0, 20)}).first().waitFor({timeout: 30_000}).catch(() => {})
  if (shot) await picture(page, shot + '-sent')
  return result
}

const probeRequests = async filter => (await h.probe({action: 'requests'})).filter(filter)

async function liaisonSay(text, context) {
  const before = new Set((await h.probe({action: 'calls'})).map(row => row.session + row.callId))
  await h.host.api('/chat', {text, mode: 'auto', sessionId: liaisonSession, scope: h.scope, request_id: randomUUID(), context})
  const started = Date.now()
  await poll(async () => {
    const view = await h.host.api('/chat')
    const mine = view.messages.filter(m => m.role === 'you' && m.text.trim() === text).at(-1)
    return !view.busy && !!mine && view.messages.some(m => m.role === 'liaison' && m.seq > mine.seq && m.text.trim())
  }, '接口人答复', 5 * 60_000)
  const view = await h.host.api('/chat')
  const mine = view.messages.filter(m => m.role === 'you' && m.text.trim() === text).at(-1)
  const replies = view.messages.filter(m => m.role === 'liaison' && m.seq > mine.seq)
  const calls = (await h.probe({action: 'calls'})).filter(row => !before.has(row.session + row.callId) && row.session === liaisonSession)
  return {seconds: Math.round((Date.now() - started) / 1000), reply: replies.map(m => m.text).join('\n').slice(0, 800),
    links: replies.flatMap(m => m.workspaces ?? []).filter(link => link.delegationId), calls: calls.map(row => ({name: row.name, arguments: row.arguments, isError: row.isError, text: row.text?.slice(0, 300)}))}
}
const args = row => { try { return JSON.parse(row.arguments) } catch { return {} } }
async function liaisonOrder(text, context = {surface: 'workspace', selectedId: workspace.id}) {
  const said = await liaisonSay(text, context)
  // The order this assign created (the reply may also link earlier orders it mentions).
  const created = said.calls.filter(row => row.name === 'chief_workspace' && args(row).action === 'assign' && !row.isError)
    .map(row => /"order":\{"id":"([^"]+)"/.exec(row.text ?? '')?.[1]).find(Boolean)
  const link = said.links.find(row => row.delegationId === created) ?? said.links.at(-1)
  assert.ok(link, '接口人没有接单：' + said.reply.slice(0, 200) + ' ' + JSON.stringify(said.calls).slice(0, 600))
  const view = await h.get('/v2/workspaces/' + link.id)
  const order = view.orders.find(row => row.id === link.delegationId)
  const session = view.sessions.find(row => row.id === order.sessionId)
  const assign = said.calls.find(row => row.name === 'chief_workspace' && args(row).action === 'assign')
  return {s: h.bind(session, order, link.id), said, assign: assign && args(assign)}
}
const liaisonMessages = messages => messages.filter(m => m.role === 'agent' && m.author === '接口人')

try {
  // ───────────────────────── Phase A: candidate host ─────────────────────────
  if (!only || only.some(ac => ac !== 'AC8')) {
    h = await open(process.env.CHIEF_ACCEPTANCE_PACKAGE)
    evidence.host = h.host.work
    await h.boot()
    evidence.build = h.build
    ;({workspace} = await h.post('/v2/workspaces', {name: '工单对话验收', goal: '验收工单对话的角色与插话'}))
    wsPath = '/v2/workspaces/' + workspace.id
    liaisonSession = (await h.host.api('/chat')).sessionId
    const password = randomUUID()
    await h.host.api('/settings/password', {password})
    if (browserWanted) {
      const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
      browser = await chromium.launch({headless: true, ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath: process.env.CHIEF_CHROMIUM_PATH})})
      desktop = await browser.newPage({viewport: {width: 1280, height: 900}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai'})
      mobile = await browser.newPage({viewport: {width: 390, height: 844}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true})
      await signInPages(h.host, password)
    }

    // AC2: the owner speaks while each executor works; the words join the SAME turn and use no budget.
    const ac2 = {}
    const interjection = async (executor, record) => {
      const label = {codex: 'Codex', 'claude-code': 'Claude Code', dsh: '工作区团队', staff: '具名幕僚'}[executor]
      let s
      if (executor === 'staff') {
        const created = await h.post('/v2/staff', {action: 'create', name: '文案幕僚', brief: '撰写和改写中文文字材料，按要求交回成稿。'})
        const staffId = created.members?.find(row => row.name === '文案幕僚')?.id ?? (await h.get('/v2/staff')).members.find(row => row.name === '文案幕僚').id
        await h.post(wsPath + '/staff', {action: 'join', staffId, duty: '为本区撰写说明文字'})
        // A named staff order starts its first turn with the promise as soon as it is created.
        s = await scenario('AC2 插话 · ' + label, {staffId, title: '插话验收 · ' + label,
          promise: '写一篇约 2000 字的文章，介绍城市骑行的好处，分成五个小节，每节都要有小标题和完整段落。'})
      } else s = await scenario('AC2 插话 · ' + label, {executor, title: '插话验收 · ' + label, promise: '按主人要求完成并回复结果。'})
      ac2[executor] = s
      const before = (await orderNow(s)).remainingTurns
      const wait = executor === 'claude-code' ? "在前台运行 `python3 -c 'import time; time.sleep(45)'`，等它结束（不要放到后台，不要提前中断）。"
        : '在前台运行 `sleep 45`，等它自然结束（不要放到后台，不要提前中断）。'
      const first = executor === 'dsh' ? '请先用 spawn_teammate 拉一位协作者，请它写三条关于时间管理的建议并用 send_message 回复你；收到回复后，再把三条建议整理成一份「工单回报」交给我。'
        : steps(wait, '运行 `printf ORIGINAL > result.txt`。', '用一句话回复 result.txt 的内容。')
      const words = executor === 'dsh' ? '改用表格输出：汇总时用一张 Markdown 表格，每条建议一行，列名为「建议」「理由」。'
        : executor === 'staff' ? '改用表格输出：不要写长文，只交一张 Markdown 表格，五个好处各占一行，列名为「好处」「一句话说明」。'
        : '改一下：第 2 步改为运行 `printf STEERED > result.txt`；最后用一张两列的 Markdown 表格回复（列名：文件、内容）。'
      const since = executor === 'staff' ? s.order.createdAt : new Date().toISOString()
      if (executor !== 'staff') {
        const start = await ownerSays(s, first)
        assert.equal(start.status, 200, '第一句送达：' + JSON.stringify(start.body).slice(0, 300))
        record.firstMs = start.ms
      }
      await working(s)
      const during = (await orderNow(s)).remainingTurns
      // Wait until the executor is really inside its turn.
      if (executor === 'codex') await commandStarted(s, /sleep\s+45/)
      else if (executor === 'claude-code') await commandStarted(s, /time\.sleep\(45\)/)
      else if (executor === 'dsh') await poll(async () => (await probeRequests(row => row.session === s.lead && row.at >= since)).length > 0, '群聊组长开始调用模型', 5 * 60_000, 500)
      else { await poll(async () => (await probeRequests(row => row.system.startsWith('你是本工单具名幕僚') && row.at >= since)).length > 0, '幕僚开始调用模型', 5 * 60_000, 300); await delay(2500) }
      record.interjectedAt = new Date().toISOString()
      const page = executor === 'claude-code' || executor === 'staff' ? mobile : desktop
      const sent = browserWanted ? await uiSpeak(page, s, words, 'ac2-' + executor + (page === mobile ? '-390' : '-1280'))
        : await ownerSays(s, words).then(r => ({status: r.status, delivery: r.body.delivery, ms: r.ms}))
      record.interjection = {via: browserWanted ? (page === mobile ? 'phone UI 390 px' : 'desktop UI 1280 px') : 'owner API', ...sent, body: undefined}
      assert.ok(['steered', 'pending'].includes(sent.delivery), '插进当前一轮：' + sent.delivery)
      const view = await settled(s)
      const order = await orderNow(s)
      const turns = orderTurns(s)
      const mine = view.messages.find(m => m.role === 'user' && m.text === words)
      const replies = agentReplies(view.messages)
      // A result the liaison found short gets one automatic follow-up turn of its own; it is not the owner's words.
      const followUps = turns.filter(turn => turn.id.startsWith('accept-'))
      const own = turns.filter(turn => !turn.id.startsWith('accept-'))
      Object.assign(record, {budget: {before, during, after: order.remainingTurns, acceptanceFollowUps: followUps.length}, turns: turnBrief(turns), acceptance: order.acceptance,
        messages: brief(view.messages).slice(-8)})
      assert.equal(mine?.delivery, 'steered', '对话里的这句话记为已送进当前一轮')
      assert.equal(own.length, 1, '主人这边只有一轮')
      assert.deepEqual(own[0].interjections?.filter(row => row.text === words).map(row => row.state), ['steered'])
      assert.equal(during, before - (executor === 'staff' ? 0 : 1))
      assert.equal(order.remainingTurns, before - (executor === 'staff' ? 0 : 1) - followUps.length, '插话没有额外扣额度')
      const after = replies.filter(m => m.at >= mine.at)
      const last = after.find(m => table(m.text))?.text ?? after.at(-1)?.text ?? ''
      record.reply = last.slice(0, 1200)
      if (executor === 'codex' || executor === 'claude-code') {
        record.resultFile = fileText(join(s.work, 'result.txt'))
        assert.equal(record.resultFile, 'STEERED', '同一轮采纳了插话')
        const runs = (await execution(s)).runs
        record.runs = runs.map(run => ({state: run.state, model: run.model, exitCode: run.process?.exitCode, startedAt: run.startedAt, endedAt: run.endedAt}))
        assert.equal(runs.length, 1 + followUps.length, '执行记录只有主人这一轮（另加接口人追问）')
      }
      if (executor === 'dsh') {
        const leadInputs = await probeRequests(row => row.session === s.lead && row.at >= since)
        record.leadRequests = leadInputs.length
        record.leadSawOwner = leadInputs.some(row => row.userTexts.includes('〔主人〕改用表格输出'))
        assert.ok(record.leadSawOwner, '组长的模型请求里有带〔主人〕标记的插话')
      }
      if (executor === 'staff') {
        const calls = await probeRequests(row => row.system.startsWith('你是本工单具名幕僚') && row.at >= since)
        record.staffCalls = calls.map(row => ({at: row.at, owner: row.userTexts.includes('〔主人〕改用表格输出')}))
        const ownEnd = own[0].endedAt ?? view.messages.find(m => m.role === 'agent' && m.at >= mine.at)?.at ?? new Date().toISOString()
        const inTurn = calls.filter(row => row.at <= ownEnd)
        record.staffCallsInTurn = inTurn.length
        assert.ok(inTurn.length >= 2 && inTurn.at(-1).lastUser.includes('〔主人〕改用表格输出'), '中止后同一轮带着主人的话重跑')
      }
      assert.ok(table(last), '执行者按插话改用表格：' + last.slice(0, 200))
      if (browserWanted) {
        await openOrderPage(page, s)
        await page.locator('.v2-delivery-note[data-delivery="steered"]').first().waitFor({timeout: 30_000})
        await page.locator('.v2-delivery-note').first().scrollIntoViewIfNeeded()
        await picture(page, 'ac2-' + executor + '-done' + (page === mobile ? '-390' : '-1280'))
      }
    }
    for (const executor of interrupted) await check('AC2', {codex: 'Codex', 'claude-code': 'Claude Code', dsh: '工作区团队', staff: '具名幕僚（中止并重跑同一轮）'}[executor], record => interjection(executor, record))

    // AC1: the order page IS the conversation; information beside it (desktop) or folded above it (phone).
    await check('AC1', '点开即聊天、侧栏与折叠信息', async record => {
      assert.ok(browserWanted, '需要浏览器')
      let s = ac2.codex
      if (!s) {
        s = await scenario('AC1 工单页', {executor: 'codex', title: '工单页验收', promise: '运行 ls 并回复。'})
        assert.equal((await ownerSays(s, steps('运行 `ls`。', '用一句话回复结果。'))).status, 200)
        await settled(s)
      }
      // From the workspace overview.
      await desktop.goto(h.host.base + '/#v2?' + new URLSearchParams({scope: h.scope, view: 'workspace', workspace: workspace.id}))
      await desktop.getByRole('region', {name: '会话与工单'}).waitFor({timeout: 30_000})
      await desktop.locator('button.v2-order-row', {hasText: s.order.title}).first().click()
      await desktop.getByRole('list', {name: '会话发言'}).waitFor({timeout: 30_000})
      const aside = desktop.getByRole('complementary', {name: '工单信息'})
      await aside.waitFor({timeout: 30_000})
      record.desktop = {chat: true, aside: true, composerEnabled: await desktop.getByLabel('发言', {exact: true}).isEnabled(),
        openSessionButton: await desktop.getByRole('button', {name: '打开会话'}).count()}
      assert.equal(record.desktop.openSessionButton, 0, '没有「打开会话」')
      for (const mode of ['light', 'dark']) { await theme(desktop, mode); await picture(desktop, 'ac1-order-1280-' + mode) }
      await theme(desktop, 'light')
      // Tier switch in the side panel.
      const tier = aside.getByRole('region', {name: '命令档位'})
      await tier.getByRole('button', {name: '请求批准', exact: true}).click()
      await poll(async () => (await orderNow(s)).permission === 'ask', '档位改为请求批准', 20_000, 500)
      await tier.getByRole('button', {name: '完全访问', exact: true}).click()
      await poll(async () => (await orderNow(s)).permission === 'full-access', '档位改回完全访问', 20_000, 500)
      record.tierSwitched = ['ask', 'full-access']
      // Execution record expands in the side panel.
      const exec = aside.locator('details.v2-execution').first()
      await exec.locator('summary').click()
      await aside.locator('.v2-exec-row').first().waitFor({timeout: 30_000})
      record.executionRows = await aside.locator('.v2-exec-row').count()
      await picture(desktop, 'ac1-order-1280-execution')
      // Pause and resume.
      await aside.getByRole('button', {name: '暂停工单', exact: true}).click()
      await poll(async () => (await orderNow(s)).paused === true, '工单已暂停', 20_000, 500)
      await desktop.getByText('工单已暂停').first().waitFor({timeout: 20_000})
      record.pausedComposerDisabled = !await desktop.getByLabel('发言', {exact: true}).isEnabled()
      await picture(desktop, 'ac1-order-1280-paused')
      await aside.getByRole('button', {name: '恢复工单', exact: true}).click()
      await poll(async () => !(await orderNow(s)).paused, '工单已恢复', 20_000, 500)
      // Narrow the scope.
      await aside.getByRole('button', {name: '收窄范围', exact: true}).click()
      const dialog = desktop.getByRole('dialog', {name: '收窄执行范围'})
      await dialog.getByRole('textbox').fill('只在本会话工作目录内读写文件，不联网。')
      await button(dialog, '保存范围').click()
      await poll(async () => (await orderNow(s)).boundary === '只在本会话工作目录内读写文件，不联网。', '范围已收窄', 20_000, 500)
      record.narrowed = true
      // Phone: conversation first, 「工单信息」 folded above it. A fresh load: the desktop just changed the order's generation.
      await openOrderPage(mobile, s)
      await mobile.reload()
      await mobile.getByLabel('发言', {exact: true}).waitFor({timeout: 30_000})
      const fold = mobile.locator('details.v2-order-fold')
      record.mobile = {foldOpen: await fold.evaluate(el => el.open), aside: await mobile.getByRole('complementary', {name: '工单信息'}).count(),
        overflow: await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)}
      assert.equal(record.mobile.foldOpen, false, '手机上工单信息默认收起')
      assert.equal(record.mobile.aside, 0)
      assert.ok(record.mobile.overflow <= 0, '390 px 无横向溢出')
      for (const mode of ['light', 'dark']) { await theme(mobile, mode); await picture(mobile, 'ac1-order-390-' + mode) }
      await theme(mobile, 'light')
      await fold.locator(':scope > summary').click()
      await fold.getByRole('button', {name: '暂停工单', exact: true}).waitFor()
      await fold.getByRole('region', {name: '命令档位'}).waitFor()
      await picture(mobile, 'ac1-order-390-info-open')
      await fold.getByRole('button', {name: '暂停工单', exact: true}).click()
      await poll(async () => (await orderNow(s)).paused === true, '手机上暂停', 20_000, 500)
      await fold.getByRole('button', {name: '恢复工单', exact: true}).click()
      await poll(async () => !(await orderNow(s)).paused, '手机上恢复', 20_000, 500)
      record.mobile.pauseResume = true
      for (const width of [320, 850]) {
        await mobile.setViewportSize({width, height: 844})
        await openOrderPage(mobile, s)
        record.mobile['overflow' + width] = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        await picture(mobile, 'ac1-order-' + width)
      }
      await mobile.setViewportSize({width: 390, height: 844})
      assert.ok(record.mobile.overflow320 <= 0 && record.mobile.overflow850 <= 0, '320 / 850 px 无横向溢出')
    })

    // AC3: words that cannot be steered (the real Codex rejects the steer) go to the next turn, once.
    await check('AC3', 'Codex 拒绝插话 → 排到下一轮', async record => {
      const s = await scenario('AC3 排到下一轮', {executor: 'codex', title: '插话转排队验收', promise: '按主人的每一句话办理，并把写好的文件用链接附在回复里。'})
      const before = (await orderNow(s)).remainingTurns
      const start = await ownerSays(s, '这是 SuperHub 的验收测试。先在前台运行 `sleep 30`（等它自然结束，不要放到后台），再运行 `printf FIRST > first.txt`，最后在回复里用 Markdown 链接附上 first.txt。')
      assert.equal(start.status, 200)
      await commandStarted(s, /sleep\s+30/)
      const words = '另外请运行 `printf QUEUED > queued.txt`，并在回复里用 Markdown 链接附上 queued.txt。'
      setFaults({steerReject: [s.work]})
      let sent
      try { sent = await ownerSays(s, words) } finally { setFaults({}) }
      record.response = {status: sent.status, delivery: sent.body.delivery, ms: sent.ms}
      assert.equal(sent.status, 200)
      assert.equal(sent.body.delivery, 'queued', '答复已排到下一轮')
      const view = await settled(s)
      const order = await orderNow(s)
      const turns = orderTurns(s)
      const proxy = proxyRows().filter(row => row.cwd === s.work)
      Object.assign(record, {budget: {before, after: order.remainingTurns}, turns: turnBrief(turns), messages: brief(view.messages),
        proxy: proxy.filter(row => ['turn/steer', 'turn/start'].includes(row.method) || row.event === 'error').map(row => ({event: row.event, method: row.method, simulated: row.simulated,
          code: row.code, message: row.message, text: row.text?.slice(0, 80)}))})
      const mine = view.messages.find(m => m.role === 'user' && m.text === words)
      const board = h.board()
      record.reviews = turns.map(turn => ({turnId: turn.id.slice(0, 18), ...board.acceptances?.[turn.id] && {state: board.acceptances[turn.id].state,
        cancelled: board.acceptances[turn.id].cancelled, followUp: !!board.acceptances[turn.id].followUp, note: board.acceptances[turn.id].note?.slice(0, 200)}}))
      record.acceptance = order.acceptance
      assert.equal(mine?.delivery, 'queued', '对话中注明已排到下一轮')
      assert.equal(turns.length, 2, '共两轮（没有接口人自动追问）')
      assert.equal(turns.filter(turn => turn.text === words).length, 1, '这句话只派发一次')
      assert.equal(order.remainingTurns, before - 2, '排到下一轮扣一轮')
      assert.equal(board.acceptances?.[turns[0].id]?.cancelled, true, '主人排队的话优先，第一轮的验收不追问')
      assert.equal(proxy.filter(row => row.method === 'turn/steer').length, 1)
      assert.ok(proxy.some(row => row.event === 'error' && row.code === -32600), 'Codex 以 -32600 拒绝插话')
      assert.equal(proxy.filter(row => row.method === 'turn/start' && row.text?.includes('printf QUEUED')).length, 1, 'turn/start 只带这句话一次')
      assert.equal(fileText(join(s.work, 'queued.txt')), 'QUEUED')
      assert.equal(fileText(join(s.work, 'first.txt')), 'FIRST')
      if (browserWanted) {
        await openOrderPage(mobile, s)
        await mobile.locator('.v2-delivery-note[data-delivery="queued"]', {hasText: '已排到下一轮'}).first().waitFor({timeout: 30_000})
        await mobile.locator('.v2-delivery-note[data-delivery="queued"]').first().scrollIntoViewIfNeeded()
        await picture(mobile, 'ac3-queued-390')
      }
    })

    // AC4: the liaison hands over in its own words, the owner's words folded under them; a supplement too.
    let ac4
    await check('AC4', '接口人交办与补充（Codex）', async record => {
      const said = '新开一张工单交给 Codex：在它的工作目录写一份 brew.md，列出三种常见的咖啡冲煮方式，每种一句话说明，写完把文件链接附在回复里。'
      const {s, said: chat, assign} = await liaisonOrder(said)
      ac4 = s
      Object.assign(record, {liaison: {seconds: chat.seconds, reply: chat.reply, calls: chat.calls}, handoff: assign?.handoff, executor: s.session.executor})
      assert.equal(s.session.executor, 'codex')
      const view = await settled(s)
      const first = view.messages[0]
      record.first = brief([first])[0]
      assert.equal(first.author, '接口人')
      assert.equal(first.role, 'agent')
      assert.equal(first.quote?.label, '主人原话')
      assert.equal(first.quote?.text, said, '附上主人原话全文')
      if (assign?.handoff) {
        assert.equal(first.text, assign.handoff, '第一条是接口人写的交办说明')
        assert.ok(!copied(assign.handoff, said), 'handoff 不是照抄原话')
      } else record.template = true
      const replies = agentReplies(view.messages)
      record.reply = replies.at(-1)?.text.slice(0, 800)
      assert.ok(replies.length, '执行者有答复')
      record.brew = fileText(join(s.work, 'brew.md'))?.slice(0, 600)
      assert.ok(record.brew, 'brew.md 已写好')
      // What Codex actually received: the rollout of its thread in the host's private Codex home.
      const run = (await execution(s)).runs[0]
      record.model = run?.model
      const dir = join(h.host.codexHome, 'sessions')
      const rollout = run?.nativeSessionId && execFileSync('bash', ['-lc', 'find ' + JSON.stringify(dir) + ' -name "rollout-*' + run.nativeSessionId + '.jsonl" | head -1'], {encoding: 'utf8'}).trim()
      const input = rollout ? readFileSync(rollout, 'utf8') : ''
      record.codexInput = {rollout, liaisonLabel: input.includes('〔接口人〕'), originalLabel: input.includes('主人原话'), handoff: !!assign?.handoff && input.includes(assign.handoff.slice(0, 30))}
      assert.ok(record.codexInput.liaisonLabel && record.codexInput.originalLabel, 'Codex 收到的输入注明接口人和主人原话')
      record.acceptance = (await orderNow(s)).acceptance
      // A supplement through the liaison is again the liaison's message with the owner's words.
      const more = '给当前这张工单补充一条要求：brew.md 末尾加一行「整理完毕」。'
      const follow = await liaisonSay(more, {surface: 'workspace', selectedId: s.wsId, sessionId: s.session.id, workOrderId: s.order.id})
      record.follow = {seconds: follow.seconds, reply: follow.reply, calls: follow.calls}
      assert.ok(follow.calls.some(row => row.name === 'chief_workspace' && args(row).action === 'follow_order' && !row.isError), 'follow_order 成功')
      const after = await settled(s)
      const relay = liaisonMessages(after.messages).find(m => m.quote?.text === more)
      record.followMessage = relay && brief([relay])[0]
      assert.ok(relay, '补充显示为接口人消息并附主人原话')
      record.brewAfter = fileText(join(s.work, 'brew.md'))?.slice(-200)
      assert.match(record.brewAfter ?? '', /整理完毕\s*$/, 'Codex 按补充修改')
      record.turns = turnBrief(orderTurns(s))
      record.finalAcceptance = (await orderNow(s)).acceptance
      if (browserWanted) {
        for (const page of [desktop, mobile]) {
          await openOrderPage(page, s)
          const quote = page.locator('details.v2-relay-quote').first()
          await quote.locator('summary').click()
          await quote.scrollIntoViewIfNeeded()
          await picture(page, 'ac4-liaison-handoff-' + (page === desktop ? '1280' : '390'))
        }
      }
    })

    // AC5: an easy order passes the liaison's review; 「今天」 shows the result and opens the order's conversation.
    await check('AC5', '验收达标（工作区团队）', async record => {
      const said = '替我开一张工单交给团队：写一份三条的晨间习惯建议清单，每条一句话，用 Markdown 交给我。'
      const {s, said: chat, assign} = await liaisonOrder(said)
      Object.assign(record, {liaison: {seconds: chat.seconds, reply: chat.reply, calls: chat.calls}, handoff: assign?.handoff, executor: s.session.executor})
      const view = await settled(s)
      const order = await orderNow(s)
      record.acceptance = order.acceptance
      record.messages = brief(view.messages)
      const verdict = liaisonMessages(view.messages).find(m => m.text.startsWith('已对照约定核对'))
      assert.equal(order.acceptance?.verdict, 'pass', '接口人验收结论为达标')
      assert.ok(verdict, '对话中有接口人的验收意见')
      const notices = await h.get('/v2/notices')
      record.notices = notices.items.filter(row => row.orderId === s.order.id).map(row => ({title: row.title, kind: row.kind, read: row.read}))
      assert.ok(record.notices.length, '有站内成果提醒')
      const reviews = await probeRequests(row => row.review && row.lastUser.includes(s.order.title))
      record.review = reviews.map(row => ({at: row.at, model: row.provider + '/' + row.model, reply: row.reply?.slice(0, 400)}))
      if (browserWanted) {
        for (const page of [desktop, mobile]) {
          await page.goto(origin(page) + '/#v2?' + new URLSearchParams({scope: h.scope, view: 'today'}))
          const inbox = page.getByRole('region', {name: '工单交付提醒'})
          await inbox.waitFor({timeout: 30_000})
          await picture(page, 'ac5-today-' + (page === desktop ? '1280' : '390'))
          const row = inbox.locator('button.v2-row', {hasText: s.order.title}).first()
          // The desktop pass already read it; read results are listed behind 「查看已读」.
          if (!await row.isVisible().catch(() => false)) await button(page, '查看已读').click()
          await row.click()
          await button(page, '打开工单').click()
          await page.getByRole('list', {name: '会话发言'}).waitFor({timeout: 30_000})
          await page.locator('.v2-turns li', {hasText: '已对照约定核对'}).last().scrollIntoViewIfNeeded()
          await picture(page, 'ac5-order-from-today-' + (page === desktop ? '1280' : '390'))
        }
        record.fromToday = '「今天」→ 工单交付提醒 → 打开工单 → 工单对话（桌面与手机）'
      }
    })

    // AC6: three promised files, the third impossible at first. One automatic follow-up; then pass, or the owner decides.
    await check('AC6', '缺口 → 追问一次 → 补齐后达标；补不齐转主人决定', async record => {
      await h.probe({action: 'hold', ms: 15_000})
      const passphrase = 'PLUM-' + Math.floor(100 + Math.random() * 800)
      const fixable = '新开一张工单交给 Codex：在它的工作目录交三份文件——a.md 写一句关于春天的话，b.md 写一句关于夏天的话，c.md 只写工作目录里 od-passphrase.txt 文件中的口令。三份文件缺一不可，少一份就不算完成，都用 Markdown 链接附在回复里。od-passphrase.txt 只在当前工作目录里找，不要到别处查找，也不要编造口令。'
      const stuck = '新开一张工单交给 Codex：在它的工作目录交三份文件——x.md 写一句关于海的话，y.md 写一句关于山的话，z.md 只写工作目录里 od-missing-key.txt 文件中的口令。三份文件缺一不可，少一份就不算完成，都用 Markdown 链接附在回复里。od-missing-key.txt 只在当前工作目录里找，不要到别处查找，也不要编造口令。'
      const a = await liaisonOrder(fixable)
      // The passphrase appears once the first turn is over, before the follow-up starts (the review is held 15 s).
      const watcher = poll(() => orderTurns(a.s).some(turn => turn.state === 'done'), 'a 的第一轮结束', 20 * 60_000, 250).then(() => {
        writeFileSync(join(a.s.work, 'od-passphrase.txt'), passphrase + '\n')
        record.passphraseWrittenAt = new Date().toISOString()
      })
      const b = await liaisonOrder(stuck)
      record.handoffs = [a.assign?.handoff, b.assign?.handoff]
      record.promises = [a.s.order.promise, b.s.order.promise]
      await watcher
      const [viewA, viewB] = await Promise.all([settled(a.s), settled(b.s)])
      await h.probe({action: 'hold', ms: 0})
      await delay(30_000)
      const [orderA, orderB] = [await orderNow(a.s), await orderNow(b.s)]
      const [turnsA, turnsB] = [orderTurns(a.s), orderTurns(b.s)]
      const board = h.board()
      const reviews = id => Object.entries(board.acceptances ?? {}).filter(([, row]) => row.orderId === id).map(([turnId, row]) => ({turnId: turnId.slice(0, 18), state: row.state,
        cancelled: row.cancelled, followUp: !!row.followUp, note: row.note?.slice(0, 300)}))
      record.fixable = {order: {remainingTurns: orderA.remainingTurns, autoFollowUps: orderA.autoFollowUps, acceptance: orderA.acceptance}, turns: turnBrief(turnsA), reviews: reviews(orderA.id),
        liaison: brief(liaisonMessages(viewA.messages)), c: fileText(join(a.s.work, 'c.md'))}
      record.stuck = {order: {remainingTurns: orderB.remainingTurns, autoFollowUps: orderB.autoFollowUps, acceptance: orderB.acceptance}, turns: turnBrief(turnsB), reviews: reviews(orderB.id),
        liaison: brief(liaisonMessages(viewB.messages)), z: fileText(join(b.s.work, 'z.md'))}
      // The liaison's raw review answers (verdict, gaps), in order, with the order they belong to.
      record.reviewerReplies = (await probeRequests(row => row.review)).map(row => ({at: row.at, model: row.provider + '/' + row.model,
        order: row.lastUser.includes(orderA.title) ? 'fixable' : row.lastUser.includes(orderB.title) ? 'stuck' : '?', heldMs: row.heldMs, reply: row.reply}))
      // Fixable: gap → one follow-up in the liaison's words → pass.
      assert.equal(turnsA.length, 2, 'a 共两轮（交办 + 一次追问）')
      assert.ok(turnsA[1].id.startsWith('accept-') && turnsA[1].liaison, '第二轮是接口人的追问')
      assert.equal(orderA.autoFollowUps, 1)
      assert.ok(liaisonMessages(viewA.messages).some(m => m.text.includes('还缺')), 'a 的对话列出缺口')
      assert.equal(orderA.acceptance?.verdict, 'pass', '补齐后达标')
      assert.ok(liaisonMessages(viewA.messages).some(m => m.text.startsWith('已对照约定核对')))
      assert.ok(record.fixable.c?.includes(passphrase), 'c.md 写入了口令')
      // Stuck: gap → follow-up → still a gap → the owner decides; no third turn.
      assert.equal(turnsB.length, 2, 'b 只追问一次')
      assert.equal(orderB.autoFollowUps, 1)
      assert.equal(orderB.acceptance?.verdict, 'gap')
      assert.equal(orderB.acceptance?.awaitingOwner, true, '转为等你决定')
      assert.ok(liaisonMessages(viewB.messages).some(m => m.text.startsWith('追问后仍有缺口，转给主人决定')))
      const decisions = await h.get('/v2/approvals')
      record.decisions = decisions.acceptances?.map(row => ({orderTitle: row.orderTitle, gaps: row.gaps}))
      assert.ok(decisions.acceptances?.some(row => row.orderId === b.s.order.id), '「等你决定」列出这张工单')
      const reminder = (await h.host.api('/chat')).notices?.find(row => row.key?.startsWith('workspace-acceptance:' + b.s.order.id))
      record.reminder = reminder && {key: reminder.key, text: reminder.text}
      assert.ok(reminder, '提醒通道通知了主人')
      if (browserWanted) {
        for (const page of [desktop, mobile]) {
          await page.goto(origin(page) + '/#v2?' + new URLSearchParams({scope: h.scope, view: 'today'}))
          const pending = page.getByRole('region', {name: '等你决定'})
          await pending.waitFor({timeout: 30_000})
          await picture(page, 'ac6-today-decide-' + (page === desktop ? '1280' : '390'))
          await pending.locator('[data-acceptance="' + b.s.order.id + '"]').click()
          await page.getByRole('list', {name: '会话发言'}).waitFor({timeout: 30_000})
          await page.locator('.v2-turns li', {hasText: '追问后仍有缺口'}).last().scrollIntoViewIfNeeded()
          await picture(page, 'ac6-stuck-order-' + (page === desktop ? '1280' : '390'))
          await openOrderPage(page, a.s)
          await page.locator('.v2-turns li', {hasText: '还缺'}).first().scrollIntoViewIfNeeded()
          await picture(page, 'ac6-fixable-gap-' + (page === desktop ? '1280' : '390'))
        }
      }
    })

    // AC7: the owner speaks while the review is pending: no automatic follow-up, the executor takes the owner's words.
    await check('AC7', '验收进行中主人插话', async record => {
      // Held below the 60 s review timeout. The liaison may answer the owner only after the executor's first turn, so
      // the order is picked up from the board while the liaison is still talking.
      await h.probe({action: 'hold', ms: 45_000})
      const said = '新开一张工单交给 Codex：在它的工作目录交三份文件——p.md 写一句关于秋天的话，q.md 写一句关于冬天的话，r.md 只写工作目录里 od-ticket.txt 文件中的编号。三份文件都用 Markdown 链接附在回复里。od-ticket.txt 只在当前工作目录里找，不要到别处查找，也不要编造编号。'
      const known = new Set(h.board().delegations.map(row => row.id))
      const talking = liaisonOrder(said)
      talking.catch(() => {})
      const created = await poll(() => h.board().delegations.find(row => !known.has(row.id)), '接口人建单', 5 * 60_000, 300)
      const s = h.bind(h.board().sessions.find(row => row.id === created.sessionId), created, created.workspaceId)
      const first = await poll(() => orderTurns(s).find(turn => turn.state === 'done'), '第一轮结束', 20 * 60_000, 300)
      await poll(() => h.board().acceptances?.[first.id]?.state === 'pending', '验收已登记', 60_000, 300)
      const words = 'r.md 不用做了。请在 p.md 末尾加一行「主人已确认」，然后回复。'
      record.ownerAt = new Date().toISOString()
      const sent = browserWanted ? await uiSpeak(desktop, s, words, 'ac7-owner-1280', {expectWorking: false})
        : await ownerSays(s, words).then(r => ({status: r.status, delivery: r.body.delivery}))
      record.owner = {status: sent.status, delivery: sent.delivery, ms: sent.ms}
      await h.probe({action: 'hold', ms: 0})
      const reviewed = await poll(() => { const row = h.board().acceptances?.[first.id]; return row?.state !== 'pending' && row }, '首轮验收返回', 3 * 60_000)
      record.firstReview = {state: reviewed.state, cancelled: reviewed.cancelled, followUp: reviewed.followUp, note: reviewed.note}
      record.acceptanceAfterFirst = (await orderNow(s)).acceptance
      const view = await settled(s)
      const order = await orderNow(s)
      const turns = orderTurns(s)
      Object.assign(record, {turns: turnBrief(turns), order: {autoFollowUps: order.autoFollowUps, acceptance: order.acceptance, remainingTurns: order.remainingTurns},
        liaison: brief(liaisonMessages(view.messages)), p: fileText(join(s.work, 'p.md'))})
      const heldReview = (await probeRequests(row => row.review && row.heldMs && row.lastUser.includes(s.order.title)))[0]
      record.heldReview = heldReview && {at: heldReview.at, sentAt: heldReview.sentAt, answeredAt: heldReview.answeredAt, reply: heldReview.reply?.slice(0, 300)}
      record.handoff = (await talking).assign?.handoff
      assert.equal(reviewed.cancelled, true, '主人说话取消了待发的追问')
      assert.ok(!reviewed.followUp, '没有登记自动追问')
      assert.ok(!turns.some(turn => turn.id.startsWith('accept-')), '没有派出自动追问')
      assert.ok(turns.some(turn => turn.text === words), '执行者处理了主人的话')
      assert.match(record.p ?? '', /主人已确认\s*$/, 'p.md 按主人的话修改')
      if (record.acceptanceAfterFirst?.turnId === first.id) assert.equal(record.acceptanceAfterFirst.reason, '主人已有新的指示，未自动追问')
      if (browserWanted) {
        await openOrderPage(desktop, s)
        await picture(desktop, 'ac7-owner-first-1280')
      }
    })

    // AC10: the command gate still holds under the app server.
    await check('AC10', '请求批准档出现审批卡片；去掉钩子信任不派发；钩子未运行即中断', async record => {
      const s = await scenario('AC10 把关', {executor: 'codex', permission: 'ask', title: '把关验收', promise: '创建并删除 probe.txt，汇报每一步。'})
      const before = (await orderNow(s)).remainingTurns
      const start = await ownerSays(s, steps('运行 `printf probe > probe.txt`。', '运行 `rm probe.txt`。', '用中文回复每一步的结果。'))
      assert.equal(start.status, 200)
      const pending = await poll(async () => (await execution(s)).pending?.[0], '待批准命令', 10 * 60_000)
      record.pending = {command: pending.command, cwd: pending.cwd, reason: pending.reason}
      assert.match(pending.command, /\brm\b/)
      if (browserWanted) {
        for (const page of [desktop, mobile]) {
          await openOrderPage(page, s)
          const card = page.getByRole('article', {name: /等你决定/})
          await card.waitFor({timeout: 30_000})
          await card.scrollIntoViewIfNeeded()
          await picture(page, 'ac10-approval-card-' + (page === desktop ? '1280' : '390'))
        }
        await mobile.getByRole('article', {name: /等你决定/}).getByRole('button', {name: '批准', exact: true}).click()
        record.approvedVia = 'phone UI 390 px'
      } else await h.post(s.orderPath + '/approvals/' + pending.id, {allow: true})
      await settled(s)
      const view = await execution(s)
      record.commands = view.commands.map(row => ({command: row.command.slice(0, 120), risk: row.risk, tier: row.tier, decision: row.decision, by: row.by, exitCode: row.exitCode}))
      assert.ok(view.commands.some(row => /\brm\b/.test(row.command) && row.decision === 'allowed' && row.by === 'owner'), '删除经主人批准')
      assert.ok(!existsSync(join(s.work, 'probe.txt')))
      // Thread opened without hook trust: the turn must not start. The owner's message is accepted at once (`wait:false`
      // answers when the words are journaled); the tool is started afterwards, so the fault stays until the turn settles.
      const budget = (await orderNow(s)).remainingTurns
      const marker = new Date().toISOString()
      setFaults({stripTrust: [s.work]})
      let stripped
      try {
        stripped = await ownerSays(s, '运行 `ls` 并回复结果。')
        await settled(s, 5 * 60_000)
      } finally { setFaults({}) }
      const afterStrip = await orderNow(s)
      const proxy = proxyRows().filter(row => row.cwd === s.work && row.at >= marker)
      const opened = proxy.filter(row => row.method === 'thread/resume' || row.method === 'thread/start')
      const started = proxy.filter(row => row.method === 'turn/start')
      const read = await transcript(s)
      const unsent = orderTurns(s).at(-1)
      record.stripTrust = {status: stripped.status, error: stripped.body.error, threads: opened.map(row => ({method: row.method, bypassHookTrust: row.bypassHookTrust, simulated: row.simulated})),
        turnStarts: started.length, turn: turnBrief([unsent])[0], deliveryIssue: unsent?.deliveryIssue, budget: {before: budget, after: afterStrip.remainingTurns},
        reason: afterStrip.reason, issue: read.issue, lastMessage: brief(read.messages.slice(-1))}
      assert.ok(opened.length && opened.every(row => row.simulated && !row.bypassHookTrust), '线程参数里没有钩子信任')
      assert.equal(started.length, 0, '没有发 turn/start')
      assert.equal(unsent?.state, 'unsent', '本轮记为未派发')
      assert.match(unsent?.deliveryIssue ?? '', /把关异常/)
      assert.equal(afterStrip.remainingTurns, budget, '未派发不扣额度')
      assert.match([read.issue, afterStrip.reason].join(' '), /把关异常/, '主人看得到把关异常')
      if (browserWanted) {
        await openOrderPage(desktop, s)
        await picture(desktop, 'ac10-hook-trust-missing-1280')
      }
      // Trust announced but the hook never runs: the first command nobody asked about interrupts the turn.
      setFaults({stripTrust: [s.work], fakeTrust: [s.work]})
      let breach
      try {
        breach = await ownerSays(s, steps('运行 `ls`。', '运行 `pwd`。', '回复结果。'))
        record.breachResponse = {status: breach.status, error: breach.body.error}
        if (breach.status === 200) await settled(s, 10 * 60_000)
      } finally { setFaults({}) }
      const rows = proxyRows().filter(row => row.cwd === s.work)
      const fakeAt = rows.filter(row => row.event === 'fake-warning').at(-1)?.at
      const after = rows.filter(row => fakeAt && row.at >= fakeAt)
      const turn = orderTurns(s).at(-1)
      const read2 = await transcript(s)
      record.breach = {interrupt: after.some(row => row.method === 'turn/interrupt'), completed: after.filter(row => row.event === 'turn/completed').map(row => row.status),
        commands: after.filter(row => row.event === 'item/started').map(row => ({command: row.command, source: row.source})), turn: turnBrief([turn])[0], issue: read2.issue,
        budget: (await orderNow(s)).remainingTurns}
      assert.ok(record.breach.interrupt, '中断了本轮')
      assert.match((turn.failure ?? '') + (read2.issue ?? ''), /把关异常/, '对话注明把关异常')
      if (browserWanted) {
        await openOrderPage(desktop, s)
        await picture(desktop, 'ac10-hook-breach-1280')
      }
      record.budgetStart = before
    })

    // Codex app-server command sources seen during this run (unifiedExecInteraction must not raise a false breach).
    const sources = {}
    for (const row of proxyRows().filter(row => row.event === 'item/started')) sources[row.source ?? '(none)'] = (sources[row.source ?? '(none)'] ?? 0) + 1
    evidence.codexCommandSources = sources
    evidence.codexUnifiedExec = proxyRows().filter(row => row.event === 'item/started' && row.source === 'unifiedExecInteraction').slice(0, 10).map(row => row.command)
    evidence.hostLogTail = h.host.logs().split('\n').filter(line => /error|warn|把关|gate/i.test(line)).slice(-40).join('\n')
    await h.host.stop()
  }

  // ───────────────────────── Phase B: AC8, pre-change records after an upgrade ─────────────────────────
  if (wanted('AC8') && legacyPackage) {
    await check('AC8', '旧版记录升级后显示', async record => {
      h = await open(legacyPackage)
      await h.boot()
      record.legacyBuild = h.build
      ;({workspace} = await h.post('/v2/workspaces', {name: '旧版工单', goal: '升级兼容'}))
      wsPath = '/v2/workspaces/' + workspace.id
      liaisonSession = (await h.host.api('/chat')).sessionId
      const said = '新开一张工单交给 Codex：在它的工作目录写一份 old.md，写一句话介绍这个工作目录，写完附上文件链接。'
      const {s} = await liaisonOrder(said)
      await poll(() => orderTurns(s).some(turn => turn.state === 'done'), '旧版第一轮结束', 15 * 60_000)
      const direct = '再在 old.md 末尾加一行 END，然后回复。'
      const old = await h.call(s.sessionPath + '/messages', {text: direct, requestId: randomUUID(), workOrderId: s.order.id})
      record.legacyDirect = {status: old.status, seconds: Math.round(old.ms / 1000)}
      assert.equal(old.status, 200)
      const legacyMessages = (await transcript(s)).messages
      record.legacyMessages = brief(legacyMessages)
      const legacyTurns = turnBrief(orderTurns(s))
      record.legacyTurns = legacyTurns
      await h.host.stop()
      // Upgrade the same host to the candidate.
      h.host.install(process.env.CHIEF_ACCEPTANCE_PACKAGE)
      await h.boot()
      record.candidateBuild = h.build
      const view = await transcript(s)
      record.messages = brief(view.messages)
      const relayed = view.messages.filter(m => m.relayed)
      assert.equal(relayed.length, 1, '只有交办产生的主人原话标注为经接口人转交')
      assert.equal(relayed[0].text, said)
      assert.ok(!view.messages.find(m => m.text === direct)?.relayed, '主人直接发言不标注')
      assert.equal(view.messages.length, legacyMessages.length, '旧对话条数不变')
      const order = await orderNow(s)
      record.order = {autoFollowUps: order.autoFollowUps, acceptance: order.acceptance, remainingTurns: order.remainingTurns}
      // A new turn continues the exec-era Codex thread through the app server.
      const next = await ownerSays(s, '不要运行命令，直接回答：old.md 最后一行是什么？')
      assert.equal(next.status, 200)
      await settled(s)
      const runs = (await execution(s)).runs
      record.runs = runs.map(run => ({state: run.state, resumed: run.resumed, nativeSessionId: run.nativeSessionId, model: run.model}))
      assert.equal(runs.at(-1).state, 'done')
      assert.ok(runs.at(-1).resumed && runs.at(-1).nativeSessionId === runs[0].nativeSessionId, '升级后续接原 Codex 线程')
      const last = agentReplies((await transcript(s)).messages).at(-1)?.text ?? ''
      record.lastReply = last.slice(0, 300)
      assert.match(last, /END/)
      if (browserWanted) {
        const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
        browser ??= await chromium.launch({headless: true, ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath: process.env.CHIEF_CHROMIUM_PATH})})
        desktop ??= await browser.newPage({viewport: {width: 1280, height: 900}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai'})
        mobile ??= await browser.newPage({viewport: {width: 390, height: 844}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true})
        const password = randomUUID()
        await h.host.api('/settings/password', {password})
        await signInPages(h.host, password)
        for (const page of [desktop, mobile]) {
          await openOrderPage(page, s)
          await page.getByText('经接口人转交的原话').first().waitFor({timeout: 30_000})
          await page.getByText('经接口人转交的原话').first().scrollIntoViewIfNeeded()
          await picture(page, 'ac8-legacy-relayed-' + (page === desktop ? '1280' : '390'))
        }
      }
      await h.host.stop()
    })
  } else if (wanted('AC8')) evidence.notes.push('AC8 旧版记录：未提供 CHIEF_OD_LEGACY_PACKAGE，未运行')
} catch (error) {
  evidence.fatal = error instanceof Error ? error.stack : String(error)
  log('FATAL', evidence.fatal)
} finally {
  evidence.endedAt = new Date().toISOString()
  evidence.proxyLog = proxyLog
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
const rows = Object.entries(evidence.results)
for (const [name, row] of rows) console.log((row.status === 'pass' ? 'PASS ' : 'FAIL ') + name + (row.error ? ' — ' + row.error : ''))
process.exitCode = rows.every(([, row]) => row.status === 'pass') && !evidence.fatal ? 0 : 1
