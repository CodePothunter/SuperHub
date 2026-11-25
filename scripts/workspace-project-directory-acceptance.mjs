/**
 * Project-directory acceptance (task 11-23, prd AC1–AC7) with the REAL Codex CLI and Claude Code, using the owner's own
 * login and models, in an isolated, disposable DSH host that installs the candidate package.
 *
 *   CHIEF_ACCEPTANCE_PACKAGE=<candidate tgz> \
 *   CHIEF_PLAYWRIGHT_PATH=<playwright/index.mjs> [CHIEF_CHROMIUM_PATH=<chromium>] \
 *   CHIEF_PD_EVIDENCE=<evidence.json> CHIEF_PD_SCREENSHOTS=<dir> \
 *   node scripts/workspace-project-directory-acceptance.mjs [--only AC1,AC5] [--model provider/model] [--no-browser] [--keep]
 *
 * Everything lives in one run directory under CHIEF_ACCEPTANCE_BASE (default ~/.cache/chief-acceptance): the isolated
 * DSH home and brain, and three small git repositories (`landing` with `sub/`, `board`, `third`) standing in for the
 * owner's projects. A run directory below the owner's home is an allowed project directory; /tmp would be one too, but
 * the private Codex home must not live there (see acceptance-homes.mjs). The host gives Codex and Claude Code private
 * CODEX_HOME / CLAUDE_CONFIG_DIR homes (acceptance-homes.mjs), so this run checks (AC7) that the owner's ~/.codex and
 * ~/.claude stay exactly as they were: the snapshot is read-only (hashes, sqlite opened `mode=ro`, directory listings).
 *
 * The liaison (binding through 「把〈工作区〉绑定到〈路径〉」, an order with its own directory) uses `--model` (default
 * deepseek-official/deepseek-flash, as the other acceptance scripts). `--model openai-codex/<model>` (the production
 * liaison) copies only the everyday login's current access token with a placeholder refresh token, exactly as
 * scripts/workspace-order-dialogue-acceptance.mjs does.
 *
 * Safety: the tools are asked only for harmless steps inside the run directory's repositories (pwd, git status, cat,
 * a Python wait, printf into new files).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, delay } from './acceptance-host.mjs'

const argv = process.argv.slice(2)
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const only = option('--only')?.split(',').map(s => s.trim().toUpperCase())
const wanted = ac => !only || only.includes(ac)
const browserWanted = !argv.includes('--no-browser') && !!process.env.CHIEF_PLAYWRIGHT_PATH
const keep = argv.includes('--keep')
const MODEL = option('--model') || 'deepseek-official/deepseek-flash'
const shotsDir = process.env.CHIEF_PD_SCREENSHOTS
const evidenceFile = process.env.CHIEF_PD_EVIDENCE
const HOME = homedir()

const which = name => execFileSync('bash', ['-lc', 'command -v ' + name], {encoding: 'utf8'}).trim()
const evidence = {model: MODEL, candidate: process.env.CHIEF_ACCEPTANCE_PACKAGE, startedAt: new Date().toISOString(),
  tools: {codex: execFileSync(which('codex'), ['--version'], {encoding: 'utf8'}).trim(), claude: execFileSync(which('claude'), ['--version'], {encoding: 'utf8'}).trim()},
  results: {}, notes: [], screenshots: []}
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)
const save = () => { if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)) }
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
const hash = (...items) => createHash('sha256').update(JSON.stringify(items)).digest('hex')

// ───────────── The owner's environment, read only (AC7) ─────────────
const SNAPSHOT_PY = `
import hashlib, json, os, sqlite3, sys
home = sys.argv[1]
out = {}
for f in ['.codex/config.toml', '.codex/auth.json', '.claude/settings.json', '.claude.json']:
    try: out[f] = hashlib.sha256(open(os.path.join(home, f), 'rb').read()).hexdigest()
    except Exception as e: out[f] = 'ERR ' + type(e).__name__
try:
    c = sqlite3.connect('file:' + os.path.join(home, '.codex/state_5.sqlite') + '?mode=ro', uri=True)
    out['threads'] = c.execute('select count(*) from threads').fetchone()[0]
    out['archivedThreads'] = c.execute('select count(*) from threads where archived=1').fetchone()[0]
    out['threadCwd'] = {r[0]: r[1] for r in c.execute('select id, cwd from threads')}
except Exception as e: out['threads'] = 'ERR ' + str(e)
def count(d):
    n = 0
    for _, _, fs in os.walk(os.path.join(home, d)): n += len(fs)
    return n
out['codexSessionFiles'] = count('.codex/sessions')
out['codexArchivedSessionFiles'] = count('.codex/archived_sessions')
try: out['claudeProjects'] = sorted(os.listdir(os.path.join(home, '.claude/projects')))
except Exception as e: out['claudeProjects'] = 'ERR ' + str(e)
try: out['codexProjectEntries'] = [line for line in open(os.path.join(home, '.codex/config.toml')).read().splitlines() if line.startswith('[projects.')]
except Exception: pass
try: out['claudeJsonProjects'] = sorted(json.load(open(os.path.join(home, '.claude.json'))).get('projects', {}).keys())
except Exception as e: out['claudeJsonProjects'] = 'ERR ' + type(e).__name__
print(json.dumps(out))
`
const snapshot = () => JSON.parse(execFileSync('python3', ['-I', '-c', SNAPSHOT_PY, HOME], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}))
/** Paths an acceptance run of this kind would leave behind (this run, any acceptance base, /tmp, /dev/shm). */
const acceptancePath = text => [run, BASE, '/tmp/', '/dev/shm/'].some(prefix => String(text).includes(prefix)) || /chief-accept|pd-run-/.test(String(text))
const acceptanceName = name => /chief-acceptance|chief-accept|pd-run|^-tmp-|^-dev-shm-/.test(name)

// ───────────── Run directory and the stand-in projects ─────────────
const BASE = process.env.CHIEF_ACCEPTANCE_BASE || join(HOME, '.cache', 'chief-acceptance')
mkdirSync(BASE, {recursive: true, mode: 0o700})
const run = realpathSync(mkdtempSync(join(BASE, 'pd-run-')))
const before = snapshot()
const brief = view => ({...view, threadCwd: undefined})
evidence.ownerBefore = brief(before)
const gitEnv = {...process.env, GIT_AUTHOR_NAME: 'acceptance', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'acceptance', GIT_COMMITTER_EMAIL: 'a@example.invalid'}
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8', env: gitEnv})
function project(name) {
  const dir = join(run, 'repos', name)
  mkdirSync(join(dir, 'sub'), {recursive: true})
  writeFileSync(join(dir, 'AGENTS.md'), `# 验收项目 ${name}\n\nPROJECT-MARKER: ${name}-ZEBRA-7\n\n回答时请在第一行写出上面的 PROJECT-MARKER 值。\n`)
  writeFileSync(join(dir, 'sub', 'README.md'), `子目录 ${name}/sub\n`)
  git(dir, 'init', '-q')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  return dir
}
const repos = {landing: project('landing'), board: project('board'), third: project('third')}
const nested = join(repos.landing, 'sub')
/** Files of the repository that are not committed, and SuperHub files anywhere in it. */
function repoState(dir) {
  const status = git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
  const superhub = execFileSync('find', [dir, '-path', join(dir, '.git'), '-prune', '-o', '(', '-name', 'index.html', '-o', '-name', 'accepted.html', '-o',
    '-name', 'previous-draft.html', '-o', '-name', 'revision-*', '-o', '-name', '.superhub', ')', '-print'], {encoding: 'utf8'}).split('\n').filter(Boolean)
  return {status, superhub}
}

const host = await acceptanceHost({probe: 'workspace-order-dialogue-probe.mjs', model: MODEL, mobile: true, directory: run})
evidence.host = host.work
evidence.privateHomes = {codex: host.codexHome, claude: host.claudeConfigDir}

/** The isolated host may only ever use the owner's current access token; the refresh token is replaced (see header). */
async function codexSubscription() {
  const yaml = (await import('yaml')).default
  const doc = yaml.parse(readFileSync(join(HOME, 'workspace/dsh/home/.credentials.yaml'), 'utf8'))
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

let scope = '', q = ''
const get = path => host.api(path + q)
const post = (path, body = {}) => host.api(path + q, {...body, requestId: randomUUID()})
/** POST without a client timeout (an owner message without `wait:false` answers when the turn ends). */
function call(path, body) {
  const started = Date.now(), payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const request = httpRequest(host.base + '/chief/api' + path + q, {method: 'POST',
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
/** A POST expected to fail: status and the owner-facing reason. */
async function refused(path, body) {
  const result = await call(path, {...body, requestId: randomUUID()})
  return {status: result.status, error: result.body.error}
}
async function poll(check, label, timeout = 10 * 60_000, every = 1000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await check()
    if (value) return value
    await delay(every)
  }
  throw Error('等待超时：' + label)
}
const board = () => {
  const dir = join(host.brain, 'ops', 'superhub-v2')
  for (let i = 0; i < 5; i++) {
    try { return JSON.parse(readFileSync(join(dir, readdirSync(dir).find(f => f.endsWith('.json'))), 'utf8')) } catch { /* replaced while reading */ }
  }
  return {}
}

const wsPath = ws => '/v2/workspaces/' + ws.id
const bind = (ws, session, order) => ({ws, session, order, sessionPath: wsPath(ws) + '/sessions/' + session.id, orderPath: wsPath(ws) + '/orders/' + order.id})
async function scenario(ws, {name, executor, title, promise, directory}) {
  const {session} = await post(wsPath(ws) + '/sessions', {title: name, kind: 'coding', executor})
  const {order} = await post(wsPath(ws) + '/orders', {title, promise, sessionId: session.id, ...(directory && {directory})})
  return bind(ws, session, order)
}
const transcript = s => get(s.sessionPath)
const execution = s => get(s.orderPath + '/execution')
const orderNow = async s => (await get(s.orderPath)).order
const directoryOf = async s => (await get(wsPath(s.ws))).directories?.[s.order.id]
const agentReplies = messages => messages.filter(m => m.role === 'agent' && m.author !== '接口人' && m.author !== '交付验收')
/** What the liaison said on the order (hand-over, acceptance verdicts and gaps). */
const liaisonNotes = async s => (await transcript(s)).messages.filter(m => m.role === 'agent' && m.author === '接口人').map(m => m.text.slice(0, 400))
const lastReply = async s => agentReplies((await transcript(s)).messages).map(m => m.text).join('\n\n')
const ownerSays = (s, text, wait = false) => call(s.sessionPath + '/messages', {text, requestId: randomUUID(), workOrderId: s.order.id, ...(wait ? {} : {wait: false})})
const runsBrief = runs => runs.map(run => ({turnId: run.turnId.slice(0, 18), state: run.state, cwd: run.cwd, model: run.model, nativeSessionId: run.nativeSessionId,
  resumed: run.resumed, startedAt: run.startedAt, endedAt: run.endedAt, exitCode: run.process?.exitCode}))
/** Nothing running, waiting or queued on this session, no review pending, for `quiet` ms. */
async function settled(s, timeout = 20 * 60_000, quiet = 6000) {
  let since
  return poll(async () => {
    const view = await transcript(s)
    const b = board()
    const busy = view.working || view.waiting || (b.starts ?? []).some(row => row.sessionId === s.session.id)
      || Object.values(b.acceptances ?? {}).some(row => row.sessionId === s.session.id && row.state === 'pending')
    if (busy) { since = undefined; return false }
    since ??= Date.now()
    return Date.now() - since >= quiet && view
  }, '会话安静下来 ' + s.session.title, timeout)
}
const steps = (...lines) => '这是 SuperHub 的验收测试。请严格按顺序执行下面的步骤：每条命令单独调用一次终端工具，不要把多条命令合并成一条，不要添加 cd、&& 或其他命令。\n'
  + lines.map((line, i) => (i + 1) + '. ' + line).join('\n')

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

// ───────────── Browser ─────────────
let browser, desktop, mobile
const button = (page, name) => page.getByRole('button', {name, exact: true})
const origin = page => page === desktop ? host.base : host.mobileBase
async function picture(page, name, locator) {
  if (!shotsDir || !page) return
  mkdirSync(shotsDir, {recursive: true})
  const file = join(shotsDir, name + '.png')
  try {
    if (locator) await locator.evaluate(el => el.scrollIntoView({block: 'center'}))
    await page.screenshot({path: file, fullPage: false})
    evidence.screenshots.push(file)
  } catch (error) { evidence.notes.push('截图失败 ' + name + '：' + error.message) }
}
async function openWorkspace(page, ws) {
  await page.goto(origin(page) + '/#v2?' + new URLSearchParams({scope, view: 'workspace', workspace: ws.id}))
  const section = page.getByRole('region', {name: '项目目录'})
  await section.waitFor({timeout: 30_000})
  return section
}
async function openOrderPage(page, s) {
  await page.goto(origin(page) + '/#v2?' + new URLSearchParams({scope, view: 'workspace', workspace: s.ws.id, order: s.order.id}))
  await page.getByRole('heading', {name: s.order.title, exact: true, level: 1}).waitFor({timeout: 30_000})
  await page.getByLabel('发言', {exact: true}).waitFor({timeout: 30_000})
}
/** The order's 「运行目录」 row (wide: side panel; narrow: the folded 「工单信息」, opened). */
async function directoryRow(page, s) {
  await openOrderPage(page, s)
  const fold = page.locator('details.v2-order-fold').first()
  if (await fold.count() && !await fold.evaluate(el => el.open)) await fold.locator(':scope > summary').click()
  const row = page.locator('.v2-ledger div').filter({has: page.locator('dt', {hasText: '运行目录'})}).first()
  await row.waitFor({timeout: 30_000})
  return row
}

// ───────────── Liaison ─────────────
let liaisonSession
async function liaisonSay(text, context) {
  const known = new Set((await host.request('/chief-order-dialogue-probe', {action: 'calls'})).map(row => row.session + row.callId))
  await host.api('/chat', {text, mode: 'auto', sessionId: liaisonSession, scope, request_id: randomUUID(), ...(context && {context})})
  const started = Date.now()
  await poll(async () => {
    const view = await host.api('/chat')
    const mine = view.messages.filter(m => m.role === 'you' && m.text.trim() === text).at(-1)
    return !view.busy && !!mine && view.messages.some(m => m.role === 'liaison' && m.seq > mine.seq && m.text.trim())
  }, '接口人答复', 5 * 60_000).catch(async error => {
    // What the liaison was doing when the wait ran out.
    const view = await host.api('/chat').catch(() => ({messages: []}))
    const requests = await host.request('/chief-order-dialogue-probe', {action: 'requests', since: new Date(started).toISOString()}).catch(() => [])
    throw Error(error.message + '；busy=' + view.busy + '，最近消息 ' + JSON.stringify(view.messages.slice(-3).map(m => ({role: m.role, text: m.text?.slice(0, 160)})))
      + '，本次以来模型请求 ' + requests.length + ' 次 ' + JSON.stringify(requests.slice(-3).map(row => ({at: row.at, model: row.model, review: row.review}))))
  })
  const view = await host.api('/chat')
  const mine = view.messages.filter(m => m.role === 'you' && m.text.trim() === text).at(-1)
  const replies = view.messages.filter(m => m.role === 'liaison' && m.seq > mine.seq)
  const calls = (await host.request('/chief-order-dialogue-probe', {action: 'calls'})).filter(row => !known.has(row.session + row.callId) && row.session === liaisonSession)
  return {seconds: Math.round((Date.now() - started) / 1000), reply: replies.map(m => m.text).join('\n').slice(0, 800),
    links: replies.flatMap(m => m.workspaces ?? []).filter(link => link.delegationId),
    calls: calls.map(row => ({name: row.name, arguments: row.arguments, isError: row.isError, text: row.text?.slice(0, 400)}))}
}
const args = row => { try { return JSON.parse(row.arguments) } catch { return {} } }

/** Thread title in the PRIVATE Codex home (never the owner's). */
function codexThread(id) {
  const py = 'import json,sqlite3,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nr=c.execute("select name,cwd,title from threads where id=?",(sys.argv[2],)).fetchone()\nprint(json.dumps(r))'
  const row = JSON.parse(execFileSync('python3', ['-I', '-c', py, join(host.codexHome, 'state_5.sqlite'), id], {encoding: 'utf8'}))
  return row && {name: row[0], cwd: row[1], title: row[2]?.slice(0, 80)}
}
/** Last custom title of a Claude Code session in the PRIVATE config directory. */
function claudeTitle(id) {
  const projects = join(host.claudeConfigDir, 'projects')
  const file = readdirSync(projects).map(dir => join(projects, dir, id + '.jsonl')).find(path => existsSync(path))
  if (!file) return {}
  const titles = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return {} } })
    .filter(row => row.type === 'custom-title').map(row => row.customTitle)
  return {file, title: titles.at(-1), count: titles.length}
}
const nativeName = (ws, s) => ws.name + ' · ' + s.session.title

let W0, W1, W2
try {
  if (MODEL.startsWith('openai-codex/')) await codexSubscription()
  const yaml = (await import('yaml')).default
  const rulesFile = join(host.brain, 'rules.yaml')
  writeFileSync(rulesFile, yaml.stringify({...yaml.parse(readFileSync(rulesFile, 'utf8')), rules: []}))
  await host.start()
  await host.api('/pause', {paused: true})
  const boot = await host.api('/v2/bootstrap')
  scope = boot.scope
  q = '?scope=' + encodeURIComponent(scope)
  evidence.build = boot.build
  liaisonSession = (await host.api('/chat')).sessionId
  ;({workspace: W0} = await post('/v2/workspaces', {name: '未绑定区'}))
  ;({workspace: W1} = await post('/v2/workspaces', {name: '字节 Landing', goal: '验收项目目录'}))
  ;({workspace: W2} = await post('/v2/workspaces', {name: '数据看板'}))
  evidence.repos = repos
  const password = randomUUID()
  await host.api('/settings/password', {password})
  if (browserWanted) {
    const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
    browser = await chromium.launch({headless: true, ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath: process.env.CHIEF_CHROMIUM_PATH})})
    desktop = await browser.newPage({viewport: {width: 1280, height: 900}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai'})
    await desktop.context().addCookies(host.cookie().split('; ').map(row => ({name: row.slice(0, row.indexOf('=')), value: row.slice(row.indexOf('=') + 1), url: host.base})))
    mobile = await browser.newPage({viewport: {width: 390, height: 844}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true})
    await mobile.goto(host.mobileBase)
    await mobile.getByLabel('密码').fill(password)
    await button(mobile, '进入').click()
    await mobile.getByRole('heading', {name: '今天', exact: true}).waitFor({timeout: 30_000})
  }

  // ───────────── AC1 bind and validation ─────────────
  let codexOrder, claudeOrder, unbound
  await check('AC1', 'refused directories (API)', async record => {
    const cases = {etc: '/etc', home: HOME, missing: join(run, 'missing-dir'), relative: 'repos/landing', file: join(repos.landing, 'AGENTS.md'), brainOps: join(host.brain, 'ops')}
    record.refused = {}
    for (const [name, directory] of Object.entries(cases)) record.refused[name] = {directory, ...await refused(wsPath(W1) + '/directory', {directory})}
    for (const row of Object.values(record.refused)) assert.equal(row.status, 400, row.directory + ' 被拒绝：' + JSON.stringify(row))
    assert.match(record.refused.etc.error, /系统目录/)
    assert.match(record.refused.home.error, /家目录/)
    assert.match(record.refused.missing.error, /不存在/)
    assert.match(record.refused.relative.error, /绝对路径/)
    assert.match(record.refused.brainOps.error, /内部目录/)
    assert.equal((await get(wsPath(W1))).workspace.projectDirectory, undefined, '被拒的目录都没有保存')
  })
  await check('AC1', 'bind on the workspace page', async record => {
    if (browserWanted) {
      let section = await openWorkspace(desktop, W1)
      await section.getByText('未绑定，在 SuperHub 工作目录运行').waitFor()
      await picture(desktop, 'ac1-workspace-unbound-1280', section)
      await section.getByRole('button', {name: '绑定目录', exact: true}).click()
      const dialog = desktop.getByRole('dialog', {name: '绑定项目目录'})
      const input = dialog.getByLabel('项目目录的绝对路径')
      record.uiRefusals = {}
      for (const [name, value, pattern] of [['etc', '/etc', /系统目录/], ['home', HOME, /家目录/], ['missing', join(run, 'missing-dir'), /不存在/]]) {
        await input.fill(value)
        await button(dialog, '保存目录').click()
        const issue = dialog.getByRole('alert').filter({hasText: pattern}).first()
        await issue.waitFor({timeout: 15_000})
        record.uiRefusals[name] = (await issue.textContent()).trim()
        if (name === 'etc') await picture(desktop, 'ac1-bind-refused-etc-1280')
      }
      await input.fill(repos.landing)
      await button(dialog, '保存目录').click()
      await dialog.waitFor({state: 'hidden', timeout: 15_000})
      section = desktop.getByRole('region', {name: '项目目录'})
      await section.locator('code', {hasText: repos.landing}).waitFor({timeout: 15_000})
      await picture(desktop, 'ac1-workspace-bound-1280', section)
      const phone = await openWorkspace(mobile, W1)
      await phone.locator('code', {hasText: repos.landing}).waitFor({timeout: 15_000})
      await picture(mobile, 'ac1-workspace-bound-390', phone)
      record.boundVia = 'desktop UI 1280 px'
    } else {
      await post(wsPath(W1) + '/directory', {directory: repos.landing})
      record.boundVia = 'owner API'
    }
    const ws = (await get(wsPath(W1))).workspace
    record.workspace = {projectDirectory: ws.projectDirectory, changedAt: ws.projectDirectoryChangedAt}
    assert.equal(ws.projectDirectory, repos.landing)
    W1 = ws
  })
  await check('AC1', 'order info shows 工作区默认', async record => {
    codexOrder = await scenario(W1, {name: 'Codex 项目会话', executor: 'codex', title: 'Codex 在项目里核对', promise: '在项目目录运行 pwd、核对 AGENTS.md 标记并新建两个文件，回复结果。'})
    claudeOrder = await scenario(W1, {name: 'Claude 项目会话', executor: 'claude-code', title: 'Claude 在项目里核对', promise: '在项目目录运行 pwd、核对 AGENTS.md 标记并新建一个文件，回复结果。'})
    record.directories = {codex: await directoryOf(codexOrder), claude: await directoryOf(claudeOrder), execution: (await execution(codexOrder)).directory}
    assert.deepEqual(record.directories.codex, {source: 'workspace', path: repos.landing})
    assert.deepEqual(record.directories.execution, {source: 'workspace', path: repos.landing})
    if (browserWanted) {
      const row = await directoryRow(desktop, codexOrder)
      record.uiRow = (await row.textContent()).trim()
      assert.ok(record.uiRow.includes(repos.landing + ' · 工作区默认'), record.uiRow)
      await picture(desktop, 'ac1-order-workspace-default-1280', row)
      const phone = await directoryRow(mobile, codexOrder)
      assert.ok((await phone.textContent()).includes('工作区默认'))
      await picture(mobile, 'ac1-order-workspace-default-390', phone)
    }
  })
  await check('AC1', 'bind through the liaison', async record => {
    const said = await liaisonSay('把数据看板绑定到 ' + repos.board)
    const calls = said.calls.filter(row => row.name === 'chief_workspace')
    Object.assign(record, {seconds: said.seconds, reply: said.reply, calls})
    const set = calls.find(row => args(row).action === 'set_directory' && !row.isError)
    assert.ok(set, '接口人调用了 set_directory：' + JSON.stringify(said.calls).slice(0, 600))
    assert.equal(args(set).directory, repos.board, '照录主人给的路径')
    const ws = (await get(wsPath(W2))).workspace
    record.workspace = {name: ws.name, projectDirectory: ws.projectDirectory}
    assert.equal(ws.projectDirectory, repos.board)
    W2 = ws
  })

  // ───────────── AC2 + AC6: run in the real directory, titles ─────────────
  await check('AC2', 'Codex runs in the project', async record => {
    const result = await ownerSays(codexOrder, steps('运行 `pwd`。', '运行 `git status --short`。', '运行 `printf codex > hello-codex.txt`。',
      '创建文件 `landing-codex.html`：一个最简单的 HTML 页面，标题为「验收」，正文一句话。在回复里用相对路径的 Markdown 链接附上它。',
      '回复的第一行写出本项目 AGENTS.md 里 PROJECT-MARKER 的值，第二行写出 pwd 的输出。除了这两个文件，不要创建或修改其他文件。'), true)
    assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
    await settled(codexOrder)
    const view = await execution(codexOrder), reply = await lastReply(codexOrder)
    const state = repoState(repos.landing)
    Object.assign(record, {seconds: Math.round(result.ms / 1000), runs: runsBrief(view.runs), commands: view.commands.filter(row => row.command).map(row => ({command: row.command.slice(0, 120), exitCode: row.exitCode})),
      reply: reply.slice(0, 1200), repo: state, outputs: (await get(codexOrder.orderPath + '/outputs')).outputs?.map(row => row.attachment?.label ?? row.attachment?.name),
      acceptance: (await orderNow(codexOrder)).acceptance, liaison: await liaisonNotes(codexOrder)})
    const first = view.runs[0]
    assert.equal(first.cwd, repos.landing, '执行记录的工作目录是项目')
    assert.equal(first.model, 'gpt-6.2-sol')
    assert.ok(view.commands.some(row => /\bpwd\b/.test(row.command) && row.exitCode === 0), 'pwd 在执行记录中')
    assert.ok(reply.includes('landing-ZEBRA-7'), '答复含 AGENTS.md 标记')
    assert.ok(reply.includes(repos.landing), '答复含 pwd 输出')
    assert.deepEqual(state.superhub, [], '项目里没有 SuperHub 文件')
    assert.deepEqual(state.status.map(line => line.slice(3)).sort(), ['hello-codex.txt', 'landing-codex.html'], '只有本单要求的文件')
  })
  await check('AC6', 'Codex thread title', async record => {
    const id = (await execution(codexOrder)).runs.find(run => run.nativeSessionId)?.nativeSessionId
    assert.ok(id)
    record.thread = {id, ...codexThread(id)}
    record.expected = nativeName(W1, codexOrder)
    assert.equal(record.thread.name, record.expected, '私有 CODEX_HOME 的 threads.name')
    assert.equal(record.thread.cwd, repos.landing)
    const config = readFileSync(join(host.codexHome, 'config.toml'), 'utf8')
    record.privateTrust = config.split('\n').filter(line => line.startsWith('[projects.'))
  })
  await check('AC2', 'Claude Code runs in the project', async record => {
    const result = await ownerSays(claudeOrder, steps('运行 `pwd`。', '运行 `printf claude > hello-claude.txt`。',
      '回复的第一行写出本项目 AGENTS.md 里 PROJECT-MARKER 的值，第二行写出 pwd 的输出。除了 hello-claude.txt，不要创建或修改其他文件。'), true)
    assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
    await settled(claudeOrder)
    const view = await execution(claudeOrder), reply = await lastReply(claudeOrder)
    const state = repoState(repos.landing)
    Object.assign(record, {seconds: Math.round(result.ms / 1000), runs: runsBrief(view.runs), commands: view.commands.filter(row => row.command).map(row => ({command: row.command.slice(0, 120), exitCode: row.exitCode})),
      reply: reply.slice(0, 1200), repo: state, acceptance: (await orderNow(claudeOrder)).acceptance, liaison: await liaisonNotes(claudeOrder)})
    const first = view.runs[0]
    assert.equal(first.cwd, repos.landing, '执行记录的工作目录是项目')
    assert.match(first.model ?? '', /^claude-/)
    assert.ok(reply.includes('landing-ZEBRA-7'), '答复含 AGENTS.md 标记')
    assert.ok(reply.includes(repos.landing), '答复含 pwd 输出')
    assert.deepEqual(state.superhub, [], '项目里没有 SuperHub 文件')
    assert.deepEqual(state.status.map(line => line.slice(3)).sort(), ['hello-claude.txt', 'hello-codex.txt', 'landing-codex.html'])
  })
  await check('AC6', 'Claude Code session title', async record => {
    const id = (await execution(claudeOrder)).runs.find(run => run.nativeSessionId)?.nativeSessionId
    assert.ok(id)
    record.session = {id, ...claudeTitle(id)}
    record.expected = nativeName(W1, claudeOrder)
    assert.equal(record.session.title, record.expected, '私有 CLAUDE_CONFIG_DIR 会话的 custom-title')
    assert.ok(record.session.file.startsWith(host.claudeConfigDir))
  })

  // ───────────── AC3 per-order directory through the liaison ─────────────
  await check('AC3', 'order directory from the owner words', async record => {
    const text = '这单在 ' + repos.third + ' 目录下做：请用 Codex 运行 pwd，然后告诉我这个项目 AGENTS.md 里 PROJECT-MARKER 的值。不要修改任何文件。'
    const said = await liaisonSay(text, {surface: 'workspace', selectedId: W1.id})
    const assign = said.calls.find(row => row.name === 'chief_workspace' && args(row).action === 'assign' && !row.isError)
    Object.assign(record, {seconds: said.seconds, reply: said.reply, calls: said.calls.filter(row => row.name === 'chief_workspace')})
    assert.ok(assign, '接口人接单：' + JSON.stringify(said.calls).slice(0, 600))
    record.assign = args(assign)
    assert.equal(record.assign.directory, repos.third, 'assign 带上了主人原话里的目录')
    const created = /"order":\{"id":"([^"]+)"/.exec(assign.text ?? '')?.[1]
    const view = await get(wsPath(W1))
    const order = view.orders.find(row => row.id === created)
    assert.ok(order, '找到新工单')
    const s = bind(W1, view.sessions.find(row => row.id === order.sessionId), order)
    record.order = {title: order.title, directory: order.directory, executor: s.session.executor, listed: view.directories?.[order.id]}
    assert.equal(order.directory, repos.third)
    assert.deepEqual(view.directories?.[order.id], {source: 'order', path: repos.third})
    if (browserWanted) {
      const row = await directoryRow(desktop, s)
      record.uiRow = (await row.textContent()).trim()
      assert.ok(record.uiRow.includes(repos.third + ' · 本单指定'), record.uiRow)
      await picture(desktop, 'ac3-order-own-directory-1280', row)
      const phone = await directoryRow(mobile, s)
      assert.ok((await phone.textContent()).includes('本单指定'))
      await picture(mobile, 'ac3-order-own-directory-390', phone)
    }
    await poll(async () => (await execution(s)).runs.length > 0, '首轮开始', 5 * 60_000)
    await settled(s)
    const exec = await execution(s), reply = await lastReply(s)
    Object.assign(record, {runs: runsBrief(exec.runs), reply: reply.slice(0, 800), repo: repoState(repos.third)})
    assert.equal(exec.runs[0].cwd, repos.third, '本单在指定目录运行')
    assert.ok(reply.includes('third-ZEBRA-7'), '答复含 third 的标记')
    assert.deepEqual(record.repo, {status: [], superhub: []}, '没有改动项目')
  })

  // ───────────── AC4 unbound workspace ─────────────
  await check('AC4', 'unbound runs in SuperHub working directory', async record => {
    const s = unbound = await scenario(W0, {name: '未绑定会话', executor: 'codex', title: '未绑定区里运行', promise: '运行 pwd 并回复输出。'})
    const listed = await directoryOf(s)
    const area = hash(scope, W0.id), expected = join(host.brain, 'work', 'superhub-v2', area, hash(area, s.session.id))
    record.listed = listed
    assert.equal(listed?.source, 'superhub')
    assert.equal(listed.path, expected, '显示 SuperHub 工作目录的路径')
    if (browserWanted) {
      const row = await directoryRow(desktop, s)
      record.uiRow = (await row.textContent()).trim()
      assert.ok(record.uiRow.includes(expected + ' · SuperHub 工作目录'), record.uiRow)
      const bindButton = desktop.locator('.v2-order-details').getByRole('button', {name: '绑定项目目录', exact: true})
      await bindButton.waitFor()
      await picture(desktop, 'ac4-order-superhub-1280', row)
      const phone = await directoryRow(mobile, s)
      await mobile.locator('.v2-order-details').getByRole('button', {name: '绑定项目目录', exact: true}).waitFor()
      await picture(mobile, 'ac4-order-superhub-390', phone)
      const section = await openWorkspace(desktop, W0)
      await section.getByText('未绑定，在 SuperHub 工作目录运行').waitFor()
    }
    const result = await ownerSays(s, steps('运行 `pwd`。', '回复 pwd 的输出。'), true)
    assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
    await settled(s)
    const view = await execution(s), reply = await lastReply(s)
    Object.assign(record, {runs: runsBrief(view.runs), reply: reply.slice(0, 600)})
    assert.equal(view.runs[0].cwd, expected)
    assert.ok(reply.includes(expected))
  })

  await check('AC4', 'binding later: next turn in the project, new native session', async record => {
    assert.ok(unbound, '需要先运行上一项')
    const earlier = (await execution(unbound)).runs.at(-1)
    await post(wsPath(W0) + '/directory', {directory: repos.third})
    record.listed = await directoryOf(unbound)
    assert.deepEqual(record.listed, {source: 'workspace', path: repos.third})
    const result = await ownerSays(unbound, steps('运行 `pwd`。', '回复 pwd 的输出。'), true)
    assert.equal(result.status, 200, JSON.stringify(result.body).slice(0, 300))
    await settled(unbound)
    const runs = (await execution(unbound)).runs
    const latest = runs.filter(run => run.cwd === repos.third)[0]
    record.runs = runsBrief(runs)
    record.threads = {before: codexThread(earlier.nativeSessionId), after: latest && codexThread(latest.nativeSessionId)}
    assert.ok(latest, '下一轮在新绑定的目录运行')
    assert.notEqual(latest.nativeSessionId, earlier.nativeSessionId, '换目录开新的原生会话')
    assert.ok(!latest.resumed, '没有续接旧目录的线程')
    assert.equal(record.threads.before.cwd, earlier.cwd, '旧线程的目录没有被改写')
    assert.ok((await lastReply(unbound)).includes(repos.third))
    assert.deepEqual(repoState(repos.third), {status: [], superhub: []})
    await post(wsPath(W0) + '/directory', {directory: ''})
    record.unbound = (await get(wsPath(W0))).workspace.projectDirectory ?? null
    assert.equal(record.unbound, null, '解除绑定')
    assert.equal((await directoryOf(unbound))?.source, 'superhub')
  })

  // ───────────── AC5 same-directory queue ─────────────
  await check('AC5', 'same directory waits, other directory runs, stop and nested', async record => {
    const wait = "在前台运行 `python3 -c 'import time; time.sleep(25)'`，等它结束（不要放到后台，不要提前中断）。"
    const job = (letter, where = '') => steps(wait, '运行 `printf ' + letter + ' > ' + where + 'queue-' + letter.toLowerCase() + '.txt`。', '回复 done。')
    const promise = letter => '等待 25 秒后写入 queue-' + letter.toLowerCase() + '.txt（内容 ' + letter + '），回复 done。'
    const A = await scenario(W1, {name: '排队 A', executor: 'codex', title: '排队 A', promise: promise('A')})
    const B = await scenario(W1, {name: '排队 B', executor: 'claude-code', title: '排队 B', promise: '等待 25 秒后写入 queue-b.txt（内容按主人最新要求），回复 done。'})
    const E = await scenario(W1, {name: '嵌套 E', executor: 'codex', title: '嵌套 E', promise: promise('E'), directory: nested})
    const D = await scenario(W1, {name: '排队 D', executor: 'codex', title: '排队 D 叫停', promise: promise('D')})
    const C = await scenario(W2, {name: '并行 C', executor: 'claude-code', title: '并行 C', promise: promise('C')})
    record.nestedOrder = {directory: E.order.directory, listed: await directoryOf(E)}
    assert.equal(E.order.directory, nested)
    const budget = async s => (await orderNow(s)).remainingTurns
    const before = {A: await budget(A), B: await budget(B), D: await budget(D)}
    const sends = await Promise.all([ownerSays(A, job('A')), ownerSays(C, job('C')), delay(300).then(() => ownerSays(B, job('B')))])
    record.sends = sends.map(row => ({status: row.status, delivery: row.body.delivery, ms: row.ms}))
    for (const row of sends) assert.equal(row.status, 200, JSON.stringify(row.body).slice(0, 300))
    // Whichever took the directory first; the other waits for it.
    const views = await poll(async () => {
      const [a, b] = await Promise.all([transcript(A), transcript(B)])
      return (a.working && b.waiting) || (b.working && a.waiting) ? {a, b} : undefined
    }, 'A、B 一个运行一个等待', 3 * 60_000, 300)
    const [first, second] = views.a.working ? [A, B] : [B, A]
    const waitingView = views.a.working ? views.b.waiting : views.a.waiting
    record.first = first.order.title
    record.waitingFor = waitingView
    assert.equal(waitingView.title, first.order.title, '等待的是先开始的那张工单')
    const sendsLater = [await ownerSays(E, job('E', '')), await ownerSays(D, job('D'))]
    record.sendsLater = sendsLater.map(row => ({status: row.status, delivery: row.body.delivery}))
    const [e, d] = await Promise.all([transcript(E), transcript(D)])
    record.nestedWaiting = e.waiting
    assert.ok(e.waiting, '嵌套目录 landing/sub 也在等待')
    assert.ok(d.waiting, 'D 在等待')
    const during = {second: await budget(second), D: await budget(D)}
    record.budgetWhileWaiting = {before, during}
    assert.equal(during.second, second === A ? before.A : before.B, '等待中不扣额度')
    // Owner words for the waiting order join its turn.
    const merged = await ownerSays(second, '补充：写入的文件内容改为 ' + (second === B ? 'B2' : 'A2') + '（只写这两个字符）。')
    record.mergedWords = {status: merged.status, delivery: merged.body.delivery}
    if (browserWanted) {
      await openOrderPage(desktop, second)
      const note = desktop.locator('.v2-waiting')
      await note.waitFor({timeout: 30_000})
      record.uiWaiting = (await note.textContent()).trim()
      await picture(desktop, 'ac5-waiting-1280', note)
      await openOrderPage(mobile, second)
      await mobile.locator('.v2-waiting').waitFor({timeout: 30_000})
      await picture(mobile, 'ac5-waiting-390', mobile.locator('.v2-waiting'))
      // Stop D on the desktop page.
      await openOrderPage(desktop, D)
      const stop = desktop.locator('.v2-waiting').getByRole('button', {name: '叫停', exact: true})
      await stop.waitFor({timeout: 30_000})
      const response = desktop.waitForResponse(r => r.request().method() === 'POST' && /\/stop-waiting\?/.test(r.url()))
      await stop.click()
      const answer = await response
      record.stop = {via: 'desktop UI 1280 px', status: answer.status(), body: await answer.json().catch(() => ({}))}
      await desktop.locator('.v2-waiting').waitFor({state: 'hidden', timeout: 15_000})
    } else {
      const answer = await call(D.sessionPath + '/stop-waiting', {requestId: randomUUID()})
      record.stop = {via: 'owner API', status: answer.status, body: answer.body}
    }
    assert.equal(record.stop.status, 200)
    assert.equal(record.stop.body.stopped, true)
    // C runs at the same time as the first one.
    const c = await transcript(C)
    record.cWorkingWhileFirstRuns = !!c.working
    for (const s of [first, second, E, C]) await settled(s, 20 * 60_000)
    await settled(D, 60_000, 3000)
    const runs = {}
    for (const [name, s] of Object.entries({A, B, C, D, E})) runs[name] = runsBrief((await execution(s)).runs)
    record.runs = runs
    record.files = Object.fromEntries(['queue-a.txt', 'queue-b.txt', 'sub/queue-e.txt', 'queue-d.txt'].map(f => [f, existsSync(join(repos.landing, f)) ? readFileSync(join(repos.landing, f), 'utf8').trim() : null]))
    record.files['board/queue-c.txt'] = existsSync(join(repos.board, 'queue-c.txt')) ? readFileSync(join(repos.board, 'queue-c.txt'), 'utf8').trim() : null
    record.budgetAfter = {A: await budget(A), B: await budget(B), D: await budget(D)}
    record.dTranscript = (await transcript(D)).messages.map(m => ({role: m.role, delivery: m.delivery, text: m.text.slice(0, 80)}))
    const span = name => ({from: Date.parse(runs[name][0].startedAt), to: Date.parse(runs[name].at(-1).endedAt)})
    const firstName = first === A ? 'A' : 'B', secondName = first === A ? 'B' : 'A'
    for (const name of ['A', 'B', 'C', 'E']) assert.ok(runs[name].length >= 1 && runs[name].every(run => run.state === 'done'), name + ' 完成')
    assert.equal(runs.D.length, 0, '叫停的 D 没有启动工具')
    assert.equal(record.budgetAfter.D, before.D, 'D 没有扣额度')
    assert.equal(record.files['queue-d.txt'], null)
    // Every turn in landing (A, B and E, follow-ups included) is disjoint from the others.
    const landing = ['A', 'B', 'E'].flatMap(name => runs[name].map(run => ({name, from: Date.parse(run.startedAt), to: Date.parse(run.endedAt)}))).sort((a, b) => a.from - b.from)
    for (let i = 1; i < landing.length; i++) assert.ok(landing[i].from >= landing[i - 1].to, '同目录回合不重叠：' + JSON.stringify(landing))
    assert.ok(span(secondName).from >= Date.parse(runs[firstName][0].endedAt), '第二张在第一张结束后开始')
    assert.ok(span('E').from >= Date.parse(runs[secondName][0].endedAt), '先来先得：E 在第二张之后')
    assert.ok(span('C').from < Date.parse(runs[firstName][0].endedAt) && Date.parse(runs[firstName][0].startedAt) < span('C').to, '另一目录的 C 与第一张并行')
    assert.equal(runs[secondName].filter(run => !run.turnId.startsWith('accept-')).length, 1, '等待期间的发言并入同一轮')
    assert.equal(record.files[second === B ? 'queue-b.txt' : 'queue-a.txt'], second === B ? 'B2' : 'A2', '并入的发言生效')
    assert.equal(runs.E[0].cwd, nested)
    assert.equal(record.files['sub/queue-e.txt'], 'E')
    assert.equal(runs.C[0].cwd, repos.board)
  })
} catch (error) {
  evidence.fatal = error instanceof Error ? error.stack : String(error)
  log('FATAL', evidence.fatal)
} finally {
  evidence.endedAt = new Date().toISOString()
  evidence.hostLogTail = host.logs().split('\n').filter(line => /error|warn/i.test(line)).slice(-40).join('\n')
  await browser?.close().catch(() => {})
  evidence.toolHomes = await host.dispose().catch(error => ({warnings: [String(error?.message ?? error)]}))
  // ───────────── AC7: the owner's homes are as they were ─────────────
  // The owner (Codex Desktop, the everyday DSH, this very Claude Code) may legitimately change these homes meanwhile:
  // every difference is listed; it fails when anything new points at an acceptance directory.
  const after = snapshot()
  evidence.ownerAfter = brief(after)
  const added = (a = [], b = []) => b.filter(row => !a.includes(row))
  const newThreads = Object.entries(after.threadCwd ?? {}).filter(([id]) => !(id in (before.threadCwd ?? {}))).map(([id, cwd]) => ({id, cwd}))
  const diff = {}
  for (const key of Object.keys(after)) if (key !== 'threadCwd' && JSON.stringify(after[key]) !== JSON.stringify(before[key])) diff[key] = {before: before[key], after: after[key]}
  const record = evidence.results['AC7 · owner homes unchanged'] = {status: 'pass', diff, newThreads,
    newClaudeProjects: added(before.claudeProjects, after.claudeProjects), newTrustEntries: added(before.codexProjectEntries, after.codexProjectEntries),
    newClaudeJsonProjects: added(before.claudeJsonProjects, after.claudeJsonProjects), toolHomes: evidence.toolHomes}
  try {
    assert.deepEqual(newThreads.filter(row => acceptancePath(row.cwd)), [], '主人的 Codex 没有验收目录里的新线程')
    assert.deepEqual(record.newClaudeProjects.filter(acceptanceName), [], '主人的 ~/.claude/projects 没有验收目录')
    assert.deepEqual(record.newTrustEntries.filter(acceptancePath), [], '主人的 config.toml 没有验收目录的信任条目')
    assert.deepEqual(record.newClaudeJsonProjects.filter(acceptancePath), [], '主人的 ~/.claude.json 没有验收项目')
    if ('.codex/auth.json' in diff) assert.equal(evidence.toolHomes?.codexAuth, 'written-back', 'auth.json 只在写回轮换的登录时变化')
    assert.ok(evidence.toolHomes?.removed, '私有主目录已删除')
    assert.ok(!existsSync(host.codexHome) && !existsSync(host.claudeConfigDir), '私有主目录已不存在')
  } catch (error) {
    record.status = 'fail'
    record.error = error.message
  }
  save()
  if (!keep) rmSync(run, {recursive: true, force: true})
  else log('保留运行目录', run)
}
const rows = Object.entries(evidence.results)
for (const [name, row] of rows) console.log((row.status === 'pass' ? 'PASS ' : 'FAIL ') + name + (row.error ? ' — ' + row.error : ''))
if (evidence.fatal) console.log('FATAL ' + evidence.fatal.split('\n')[0])
process.exitCode = rows.every(([, row]) => row.status === 'pass') && !evidence.fatal ? 0 : 1
