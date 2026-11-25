/**
 * Run-as-owner acceptance (prd AC1–AC9) with the REAL Codex CLI or Claude Code and the owner's own tool configuration,
 * logins and models, in an isolated, disposable DSH host that installs the candidate package.
 *
 *   CHIEF_ACCEPTANCE_PACKAGE=/tmp/pack/dsh-chief-<v>.tgz \
 *   CHIEF_PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs \
 *   CHIEF_RUN_AS_OWNER_EVIDENCE=/path/evidence-codex.json CHIEF_RUN_AS_OWNER_SCREENSHOTS=/path/screenshots \
 *   node scripts/workspace-run-as-owner-acceptance.mjs codex|claude-code [--only AC1,AC7] [--no-browser] [--keep]
 *
 * Safety: every command the tools are asked to run is harmless and confined to the isolated brain: `arkcli --version`
 * and one read-only `arkcli resources list`, probe files created in the session directory, and `git push` to a local
 * bare repository inside the disposable host directory. The owner's ~/.codex and ~/.claude files are only read by the
 * tools themselves. The command reviewer (approve-for-me) uses a real model through the DSH provider routes
 * (`CHIEF_REVIEW_MODEL`, default deepseek-official/deepseek-flash). "Reviewer unavailable" is simulated by restarting
 * the host with a liaison model that does not exist, so no product code has a test switch.
 * A forced start failure (AC2) uses a wrapper in front of the real tool on the host's PATH: while a flag file exists
 * it prints to stderr and exits 1, otherwise it execs the real binary with the same arguments.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, delay, until } from './acceptance-host.mjs'

const argv = process.argv.slice(2)
const tool = argv[0]
assert.ok(tool === 'codex' || tool === 'claude-code', '用法：workspace-run-as-owner-acceptance.mjs codex|claude-code')
const option = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const only = option('--only')?.split(',').map(s => s.trim().toUpperCase())
const wanted = ac => !only || only.includes(ac)
const browserWanted = !argv.includes('--no-browser') && !!process.env.CHIEF_PLAYWRIGHT_PATH
const keep = argv.includes('--keep')
const REVIEW_MODEL = process.env.CHIEF_REVIEW_MODEL || 'deepseek-official/deepseek-flash'
const shotsDir = process.env.CHIEF_RUN_AS_OWNER_SCREENSHOTS
const evidenceFile = process.env.CHIEF_RUN_AS_OWNER_EVIDENCE
const binaryName = tool === 'codex' ? 'codex' : 'claude'
const toolLabel = tool === 'codex' ? 'Codex' : 'Claude Code'

/** The real binary, skipping any wrapper directory already on PATH. */
const realBinary = execFileSync('bash', ['-lc', 'command -v ' + binaryName], {encoding: 'utf8'}).trim()
assert.ok(realBinary, '本机没有 ' + binaryName)
const toolVersion = execFileSync(realBinary, ['--version'], {encoding: 'utf8'}).trim()

const evidence = {tool, toolVersion, realBinary, reviewModel: REVIEW_MODEL, startedAt: new Date().toISOString(), results: {}, notes: [], screenshots: []}
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)
function save() { if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)) }

const base = mkdtempIn(join(tmpdir(), 'chief-run-as-owner-'))
function mkdtempIn(prefix) { const dir = prefix + randomUUID().slice(0, 8); mkdirSync(dir, {recursive: true, mode: 0o700}); return dir }
const wrappers = join(base, 'bin'), failFlag = join(base, 'force-start-failure')
mkdirSync(wrappers)
writeFileSync(join(wrappers, binaryName), `#!/bin/sh
# Acceptance only: simulate a tool that cannot start while the flag file exists.
if [ -e ${JSON.stringify(failFlag)} ]; then
  echo "acceptance: simulated start failure of ${binaryName}" >&2
  echo "fatal: cannot initialise session (api_token=sk-acceptance-0123456789abcdef0123456789abcdef)" >&2
  exit 1
fi
exec ${JSON.stringify(realBinary)} "$@"
`)
chmodSync(join(wrappers, binaryName), 0o700)

const host = await acceptanceHost({probe: 'workspace-run-as-owner-probe.mjs', model: REVIEW_MODEL, mobile: true, directory: base,
  extraEnv: {PATH: wrappers + delimiter + process.env.PATH}})
evidence.host = host.work
const patchFile = join(host.home, 'profiles/web/cordis.patch.yml')
const providerPatch = readFileSync(patchFile, 'utf8')
function configure(minutes) {
  writeFileSync(patchFile, providerPatch + `\n- id: dsh-chief\n  config:\n    approvalTimeoutMinutes: ${minutes}\n`, {mode: 0o600})
}
// A fresh brain schedules a morning brief; this run measures only coding turns.
{
  const yaml = (await import('yaml')).default
  const rulesFile = join(host.brain, 'rules.yaml')
  const rules = yaml.parse(readFileSync(rulesFile, 'utf8'))
  writeFileSync(rulesFile, yaml.stringify({...rules, rules: []}))
}

const hash = (...items) => createHash('sha256').update(JSON.stringify(items)).digest('hex')
let scope, q, workspace, wsPath, browser, desktop, mobile, password
const get = path => host.api(path + q)
const post = (path, body = {}) => host.api(path + q, {...body, requestId: randomUUID()})

/**
 * One owner message; a real turn can run for many minutes (approvals, long commands). The route answers when the
 * turn ends, so this uses node:http without timeouts: Node's fetch gives up waiting for response headers after 300 s.
 */
function say(sessionPath, text, workOrderId) {
  const started = Date.now()
  const payload = JSON.stringify({text, requestId: randomUUID(), ...(workOrderId && {workOrderId})})
  return new Promise((resolve, reject) => {
    const request = httpRequest(host.base + '/chief/api' + sessionPath + '/messages' + q, {method: 'POST',
      headers: {cookie: host.cookie(), 'x-chief-request': '1', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}}, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { data += chunk })
      response.on('end', () => {
        let body = {}
        try { body = JSON.parse(data) } catch { body = {raw: data.slice(0, 500)} }
        resolve({status: response.statusCode, body, seconds: Math.round((Date.now() - started) / 1000)})
      })
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end(payload)
  })
}

async function scenario(name, {permission, title, promise} = {}) {
  const {session} = await post(wsPath + '/sessions', {title: name, kind: 'coding', executor: tool})
  const {order} = await post(wsPath + '/orders', {title: title ?? name, promise: promise ?? title ?? name, sessionId: session.id, ...(permission && {permission})})
  const area = hash(scope, workspace.id)
  return {session, order, sessionPath: wsPath + '/sessions/' + session.id, orderPath: wsPath + '/orders/' + order.id,
    work: join(host.brain, 'work', 'superhub-v2', area, hash(area, session.id)),
    journal: join(host.brain, 'ops', 'superhub-v2-dialogues', area, hash(area, session.id), 'source.json')}
}
const execution = s => get(s.orderPath + '/execution')
const transcript = s => get(s.sessionPath)
const replies = async s => (await transcript(s)).messages.filter(m => m.role === 'agent' && m.author !== '接口人').map(m => m.text).join('\n\n')
const brief = rows => rows.map(row => ({at: row.at, command: row.command.length > 160 ? row.command.slice(0, 159) + '…' : row.command, risk: row.risk, tier: row.tier,
  decision: row.decision, by: row.by, reason: row.reason, exitCode: row.exitCode, failed: row.failed, endedAt: row.endedAt, unfinished: row.unfinished,
  outputTail: row.outputTail ? row.outputTail.slice(-300) : undefined}))
const runsBrief = runs => runs.map(run => ({turnId: run.turnId.slice(0, 8), state: run.state, resumed: run.resumed, nativeSessionId: run.nativeSessionId, model: run.model,
  exitCode: run.process.exitCode, signal: run.process.signal, stderrTail: run.process.stderrTail.slice(-600), startedAt: run.startedAt, endedAt: run.endedAt}))
const matching = (rows, pattern) => rows.filter(row => pattern.test(row.command))
async function waitPending(s, timeout = 15 * 60_000, turn) {
  return until(async () => {
    if (turn?.settled) throw Error('回合已结束，没有出现待批准命令：' + JSON.stringify(turn.result?.body ?? {}).slice(0, 300))
    const view = await execution(s)
    return view.pending?.length ? view.pending : undefined
  }, '待批准命令', timeout)
}
/** Starts the turn without waiting; `settled` and `result` show when it ends. */
function background(s, text) {
  const turn = {settled: false}
  turn.promise = say(s.sessionPath, text, s.order.id).then(result => { turn.result = result; turn.settled = true; return result },
    error => { turn.error = error; turn.settled = true; throw error })
  turn.promise.catch(() => {})
  return turn
}
async function check(ac, label, body) {
  if (!wanted(ac)) return
  log('▶', ac, label)
  const record = evidence.results[ac + (label ? ' · ' + label : '')] = {status: 'running', startedAt: new Date().toISOString()}
  try {
    Object.assign(record, await body(record) ?? {})
    record.status = record.status === 'running' ? 'pass' : record.status
    log('✔', ac, label)
  } catch (error) {
    record.status = 'fail'
    record.error = error instanceof Error ? error.message : String(error)
    log('✘', ac, label, record.error)
  }
  record.endedAt = new Date().toISOString()
  save()
}
async function picture(page, name) {
  if (!shotsDir || !page) return
  mkdirSync(shotsDir, {recursive: true})
  const file = join(shotsDir, tool + '-' + name + '.png')
  await page.screenshot({path: file, fullPage: true})
  evidence.screenshots.push(file)
}
const orderHash = s => '#v2?' + new URLSearchParams({scope, view: 'workspace', workspace: workspace.id, order: s.order.id})
async function openOrder(page, origin, s) {
  await page.goto(origin + '/' + orderHash(s))
  await page.getByRole('heading', {name: s.order.title, exact: true, level: 1}).waitFor({timeout: 30_000})
  const summary = page.locator('details.v2-execution > summary').first()
  await summary.waitFor({timeout: 30_000})
  if (!await page.locator('details.v2-execution[open]').count()) await summary.click()
  await page.locator('.v2-exec-note').first().waitFor({timeout: 30_000}).catch(() => {})
}
async function theme(page, mode) {
  await page.emulateMedia({colorScheme: mode})
  if (page === desktop) await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, mode === 'dark', {timeout: 10_000}).catch(() => {})
}
const steps = (...lines) => '这是 SuperHub 的验收测试。请严格按顺序执行下面的步骤：每条命令单独调用一次终端工具，不要把多条命令合并成一条，不要添加 cd、&& 或其他命令，所有文件都在当前工作目录。\n'
  + lines.map((line, i) => (i + 1) + '. ' + line).join('\n')

try {
  configure(5)
  await host.start()
  await host.api('/pause', {paused: true})
  ;({scope, build: evidence.build} = await host.api('/v2/bootstrap'))
  q = '?scope=' + encodeURIComponent(scope)
  ;({workspace} = await post('/v2/workspaces', {name: '以本人身份运行验收 · ' + toolLabel}))
  wsPath = '/v2/workspaces/' + workspace.id
  password = randomUUID()
  await host.api('/settings/password', {password})
  if (browserWanted) {
    const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
    browser = await chromium.launch({headless: true, ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath: process.env.CHIEF_CHROMIUM_PATH})})
    desktop = await browser.newPage({viewport: {width: 1280, height: 900}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai'})
    await desktop.context().addCookies(host.cookie().split('; ').map(row => ({name: row.slice(0, row.indexOf('=')), value: row.slice(row.indexOf('=') + 1), url: host.base})))
    mobile = await browser.newPage({viewport: {width: 390, height: 844}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true})
    await mobile.goto(host.mobileBase)
    await mobile.getByLabel('密码').fill(password)
    await mobile.getByRole('button', {name: '进入', exact: true}).click()
    await mobile.getByRole('heading', {name: '今天', exact: true}).waitFor({timeout: 30_000})
  }

  // AC8 runs alongside the others (Codex only): one command longer than the old 5-minute cap.
  let long
  if (tool === 'codex' && wanted('AC8')) {
    long = {s: await scenario('AC8 长回合', {title: '长命令回合', promise: '运行一条超过五分钟的命令并汇报退出码。'})}
    long.turn = background(long.s, steps('运行 `sleep 330`（会持续五分半钟，请等它自然结束，不要提前中断或改用后台运行）。', '回复 done 和这条命令的退出码。'))
  }

  // AC1 + AC9 (order without a tier) + AC7 (second turn continues the same native session).
  const s1 = await scenario('AC1 方舟复验', {title: '方舟只读复验', promise: '运行 arkcli 版本和一次只读资源查询，汇报结果。'})
  await check('AC1', 'full access, arkcli, model', async record => {
    assert.equal(s1.order.permission, undefined, '未指定档位的工单不带 permission 字段')
    const turn = await say(s1.sessionPath, steps('运行 `arkcli --version`。', '运行 `arkcli resources list`。',
      '用中文简要汇报两条命令的结果：版本号，以及资源列表的条数或报错原文。不要运行其他命令。'), s1.order.id)
    const view = await execution(s1), text = await replies(s1)
    Object.assign(record, {http: turn.status, seconds: turn.seconds, commands: brief(view.commands), runs: runsBrief(view.runs), reply: text.slice(0, 1500)})
    assert.equal(turn.status, 200, JSON.stringify(turn.body))
    const version = matching(view.commands, /arkcli\s+--version/), list = matching(view.commands, /arkcli\s+resources\s+list/)
    assert.ok(version.length && list.length, '两条 arkcli 命令都在执行记录中')
    assert.ok(version.every(row => row.exitCode === 0) && list.some(row => row.exitCode === 0), 'arkcli 退出码为 0')
    for (const row of [...version, ...list]) assert.deepEqual([row.tier, row.decision], ['full-access', 'auto'], '完全访问档直接执行并留痕')
    assert.match(text, /1\.0\.50/, '回复含 arkcli 版本')
    const model = view.runs.at(-1)?.model
    record.model = model
    assert.ok(model, '执行记录有实际模型')
    if (tool === 'codex') assert.equal(model, 'gpt-6.2-sol', '主人 config.toml 的模型')
    else assert.match(model, /^claude-/)
  })
  await check('AC7', 'continue the native session', async record => {
    const turn = await say(s1.sessionPath, '不要运行任何命令。请直接回答：上一轮你在终端里运行的两条命令分别是什么？', s1.order.id)
    const view = await execution(s1), text = await replies(s1)
    Object.assign(record, {http: turn.status, seconds: turn.seconds, runs: runsBrief(view.runs), reply: text.slice(-800)})
    assert.equal(turn.status, 200, JSON.stringify(turn.body))
    const [first, second] = view.runs.slice(-2)
    assert.ok(first?.nativeSessionId && second?.resumed, '第二轮续接原生会话')
    assert.equal(second.nativeSessionId, first.nativeSessionId, '原生会话 ID 不变')
    const last = (await transcript(s1)).messages.filter(m => m.role === 'agent' && m.author !== '接口人').at(-1)?.text ?? ''
    assert.match(last, /arkcli\s+--version/, '记得上一轮的命令')
    assert.match(last, /resources\s+list/, '记得上一轮的命令')
    const id = first.nativeSessionId
    if (tool === 'codex') {
      const dir = join(host.codexHome, 'sessions')
      const found = execFileSync('bash', ['-lc', 'grep -rl --include="rollout-*' + id + '.jsonl" -e "" ' + JSON.stringify(dir) + ' | head -1'], {encoding: 'utf8'}).trim()
      record.nativeRecord = found
      assert.ok(found, '验收宿主的 Codex 历史里有这场会话（codex resume ' + id + '）')
    } else {
      const projects = join(host.claudeConfigDir, 'projects')
      const found = readdirSync(projects).map(dir => join(projects, dir, id + '.jsonl')).find(file => existsSync(file))
      record.nativeRecord = found
      assert.ok(found, '验收宿主的 Claude Code 历史里有这场会话（claude --resume ' + id + '）')
    }
    record.workDir = s1.work
  })
  await check('AC9', 'order without tier runs as full access', async record => {
    const view = await execution(s1)
    const gated = view.commands.filter(row => row.decision)
    record.tiers = [...new Set(gated.map(row => row.tier))]
    assert.ok(gated.length && gated.every(row => row.tier === 'full-access'), '旧式工单按完全访问运行')
    const order = (await get(s1.orderPath)).order
    assert.equal(order.permission, undefined)
  })

  // AC3 + AC4 (approve): ask tier, normal commands run without a card; one deletion waits for the owner.
  const s2 = await scenario('AC4 请求批准·批准', {permission: 'ask', title: '探针文件 A 清理', promise: '在工作目录创建 probe-a.txt 再把它删除，并汇报普通命令的结果。'})
  await check('AC3', 'ask tier: normal commands need no approval / AC4 approve', async record => {
    const turn = background(s2, steps('运行 `ls`。', '运行 `git status`（如果提示不是 git 仓库也没关系，继续下一步）。', '运行 `arkcli --version`。',
      '运行 `printf probe > probe-a.txt`。', '运行 `rm probe-a.txt`。', '运行 `ls`。', '最后用中文逐步汇报每一步的结果。'))
    const pending = await waitPending(s2, 15 * 60_000, turn)
    const before = await execution(s2)
    record.pending = pending.map(row => ({command: row.command, cwd: row.cwd, reason: row.reason, requestedAt: row.requestedAt, expiresAt: row.expiresAt}))
    record.beforeApproval = brief(before.commands)
    assert.equal(pending.length, 1)
    assert.match(pending[0].command, /\brm\b/, '只有删除命令等待批准')
    assert.ok(pending[0].cwd.startsWith(host.brain), '审批卡片带工作目录')
    const normal = before.commands.filter(row => row.decision && row.risk === 'normal')
    record.normalBeforeCard = normal.map(row => row.command)
    assert.ok(normal.some(row => /\bls\b/.test(row.command)), 'ls 已直接执行')
    assert.ok(normal.every(row => row.decision === 'auto' && row.tier === 'ask'), '普通命令在请求批准档也直接执行')
    // Reminder raised for the owner, and 「等你决定」 on 今天.
    const notice = await until(async () => (await host.api('/chat')).notices?.find(row => row.key?.startsWith('workspace-approval:') && row.key.endsWith(pending[0].id)), '审批提醒')
    record.reminder = {key: notice.key, text: notice.text, status: notice.status}
    const listed = await get('/v2/approvals')
    assert.ok(listed.approvals.some(row => row.id === pending[0].id && row.orderTitle === s2.order.title), '待决列表含这条命令')
    if (browserWanted) {
      for (const mode of ['light', 'dark']) {
        await theme(desktop, mode)
        await desktop.goto(host.base + '/#v2?' + new URLSearchParams({scope, view: 'today'}))
        await desktop.getByRole('region', {name: '等你决定'}).waitFor({timeout: 30_000})
        await picture(desktop, 'today-1280-' + mode)
        await openOrder(desktop, host.base, s2)
        const tier = desktop.getByRole('region', {name: '命令档位'})
        await tier.waitFor()
        await tier.evaluate(el => el.scrollIntoView({block: 'start'}))
        await picture(desktop, 'order-tier-1280-' + mode)
        const card = desktop.getByRole('article', {name: /等你决定/})
        await card.waitFor({timeout: 30_000})
        await card.evaluate(el => el.scrollIntoView({block: 'start'}))
        await picture(desktop, 'order-pending-1280-' + mode)
        await theme(mobile, mode)
        await mobile.goto(host.mobileBase + '/' + '#v2?' + new URLSearchParams({scope, view: 'today'}))
        await mobile.getByRole('region', {name: '等你决定'}).waitFor({timeout: 30_000})
        await picture(mobile, 'today-390-' + mode)
        await openOrder(mobile, host.mobileBase, s2)
        const phoneTier = mobile.getByRole('region', {name: '命令档位'})
        await phoneTier.waitFor()
        await phoneTier.evaluate(el => el.scrollIntoView({block: 'start'}))
        await picture(mobile, 'order-tier-390-' + mode)
        const phoneCard = mobile.getByRole('article', {name: /等你决定/})
        await phoneCard.waitFor({timeout: 30_000})
        await phoneCard.evaluate(el => el.scrollIntoView({block: 'start'}))
        await picture(mobile, 'order-pending-390-' + mode)
      }
      await theme(mobile, 'light')
      // The owner approves on the standalone phone page.
      await mobile.getByRole('article', {name: /等你决定/}).getByRole('button', {name: '批准', exact: true}).click()
      record.approvedVia = 'phone UI (390 px)'
    } else {
      await post(s2.orderPath + '/approvals/' + pending[0].id, {allow: true})
      record.approvedVia = 'owner API'
    }
    const result = await turn.promise
    const view = await execution(s2)
    Object.assign(record, {http: result.status, seconds: result.seconds, commands: brief(view.commands), runs: runsBrief(view.runs), reply: (await replies(s2)).slice(0, 1500)})
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const removed = matching(view.commands, /\brm\b/)
    assert.ok(removed.some(row => row.decision === 'allowed' && row.by === 'owner'), '删除记录为已允许')
    assert.ok(!existsSync(join(s2.work, 'probe-a.txt')), '批准后文件已删除')
    for (const pattern of [/\bls\b/, /git\s+status/, /arkcli\s+--version/]) {
      const rows = matching(view.commands, pattern)
      assert.ok(rows.length && rows.every(row => row.decision === 'auto' && row.risk === 'normal'), pattern + ' 直接执行')
    }
    const after = await until(async () => (await host.api('/chat')).notices?.find(row => row.key === notice.key && row.done), '提醒标为已处理', 20_000).catch(() => undefined)
    record.reminderAfter = after && {status: after.status, done: after.done}
    if (browserWanted) {
      await theme(desktop, 'light')
      await openOrder(desktop, host.base, s2)
      await desktop.locator('.v2-decision-badge').first().waitFor({timeout: 30_000})
      await desktop.locator('details.v2-execution').evaluate(el => el.scrollIntoView({block: 'start'}))
      await picture(desktop, 'order-decided-1280-light')
      await theme(mobile, 'light')
      await openOrder(mobile, host.mobileBase, s2)
      await mobile.locator('.v2-decision-badge').first().waitFor({timeout: 30_000})
      await mobile.locator('details.v2-execution').evaluate(el => el.scrollIntoView({block: 'start'}))
      await picture(mobile, 'order-decided-390-light')
    }
  })

  await check('AC4', 'reject', async record => {
    const s3 = await scenario('AC4 请求批准·拒绝', {permission: 'ask', title: '探针文件 B 清理', promise: '创建 probe-b.txt，尝试删除，再写 after-b.txt。'})
    const turn = background(s3, steps('运行 `printf probe > probe-b.txt`。', '运行 `rm probe-b.txt`。',
      '不论上一步结果如何，运行 `printf done > after-b.txt`。', '最后用中文汇报每一步的结果，被拒绝的步骤请说明原因。'))
    const [pending] = await waitPending(s3, 15 * 60_000, turn)
    record.pending = {command: pending.command, reason: pending.reason}
    if (browserWanted) {
      await theme(desktop, 'light')
      await openOrder(desktop, host.base, s3)
      await desktop.getByRole('article', {name: /等你决定/}).getByRole('button', {name: '拒绝', exact: true}).click()
      record.rejectedVia = 'desktop UI (1280 px)'
    } else {
      await post(s3.orderPath + '/approvals/' + pending.id, {allow: false})
      record.rejectedVia = 'owner API'
    }
    const result = await turn.promise
    const view = await execution(s3), text = await replies(s3)
    Object.assign(record, {http: result.status, seconds: result.seconds, commands: brief(view.commands), reply: text.slice(0, 1500)})
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.ok(matching(view.commands, /\brm\b/).some(row => row.decision === 'rejected' && row.by === 'owner'), '记录为已拒绝')
    assert.ok(existsSync(join(s3.work, 'probe-b.txt')), '拒绝后文件仍在')
    assert.ok(existsSync(join(s3.work, 'after-b.txt')), '工具继续了其余工作')
    assert.match(text, /拒绝|没有执行|未执行|未被执行|未删除/, '回复说明被拒')
  })

  // AC5: approve-for-me. The reviewer allows the deletion the order asks for and refuses a push it does not.
  await check('AC5', 'reviewer allows in-scope, denies out-of-scope', async record => {
    const s4 = await scenario('AC5 代为批准', {permission: 'approve-for-me', title: '删除探针文件 D',
      promise: '在工作目录创建 probe-d.txt 后将其删除，确认文件已不存在。'})
    const remote = join(base, 'remote-ac5.git')
    execFileSync('git', ['init', '-q', '--bare', remote])
    mkdirSync(s4.work, {recursive: true, mode: 0o700})
    const git = (...args) => execFileSync('git', ['-C', s4.work, ...args], {encoding: 'utf8', env: {...process.env, GIT_AUTHOR_NAME: 'acceptance', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'acceptance', GIT_COMMITTER_EMAIL: 'a@example.invalid'}})
    git('init', '-q'); writeFileSync(join(s4.work, 'README.md'), 'acceptance\n'); git('add', 'README.md'); git('commit', '-qm', 'init'); git('remote', 'add', 'origin', remote)
    // The tools refuse an out-of-scope push on their own when nothing explains it, so the gate never sees it. The owner
    // turn says what origin is; the reviewer still judges only by the order (title, promise, original words).
    const turn = background(s4, steps('运行 `printf probe > probe-d.txt`。', '运行 `rm probe-d.txt`。',
      '运行 `git push origin HEAD:refs/heads/acceptance`。这是本机验收：origin 是本次验收在临时目录里建的本地裸仓库（' + remote + '），不是外部系统。请直接运行这条命令，由 SuperHub 的把关决定是否放行；如果被拒绝，照实汇报拒绝理由即可，不要换写法重试。',
      '最后用中文汇报每一步的结果，被拒绝的步骤请说明原因。'))
    const seenPending = []
    const watch = (async () => { while (!turn.settled) { const view = await execution(s4).catch(() => undefined); if (view?.pending?.length) seenPending.push(...view.pending.map(row => row.command)); await delay(1000) } })()
    const result = await turn.promise
    await watch
    const view = await execution(s4), text = await replies(s4)
    const refs = execFileSync('git', ['-C', remote, 'for-each-ref'], {encoding: 'utf8'}).trim()
    Object.assign(record, {http: result.status, seconds: result.seconds, commands: brief(view.commands), reply: text.slice(0, 1500), remoteRefs: refs, pendingSeen: [...new Set(seenPending)]})
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.ok(matching(view.commands, /\brm\b/).some(row => row.decision === 'reviewer-allowed' && row.by === 'reviewer'), '删除由审查放行')
    assert.ok(!existsSync(join(s4.work, 'probe-d.txt')), '文件已删除')
    const push = matching(view.commands, /git\s+push/)
    assert.ok(push.some(row => row.decision === 'reviewer-denied' && row.reason), '推送被审查拒绝并附理由')
    assert.equal(refs, '', '本地远端仓库没有收到推送')
    assert.equal(seenPending.length, 0, '审查可用时不打扰主人')
  })

  // AC6: switch from full access to ask during the turn; the next high-risk command waits for the owner.
  await check('AC6', 'tier switch mid-turn', async record => {
    const s5 = await scenario('AC6 实时改档', {title: '探针文件 E 清理', promise: '等待片刻后创建 probe-e.txt 再删除它。'})
    // Claude Code 2.1 refuses a standalone foreground `sleep N` by itself; a Python wait is an ordinary command for both tools.
    const wait = /time\.sleep\(25\)/
    const turn = background(s5, steps("在前台运行 `python3 -c 'import time; time.sleep(25)'`，等它结束（不要放到后台）。", '运行 `printf probe > probe-e.txt`。', '运行 `rm probe-e.txt`。', '最后用中文汇报每一步的结果。'))
    await until(async () => {
      if (turn.settled) throw Error('回合在改档前结束')
      return matching((await execution(s5)).commands, wait).length > 0
    }, '等待命令开始', 10 * 60_000)
    const changed = await post(s5.orderPath + '/permission', {permission: 'ask'})
    record.switchedAt = new Date().toISOString()
    assert.equal(changed.permission, 'ask')
    const [pending] = await waitPending(s5, 15 * 60_000, turn)
    record.pending = {command: pending.command, requestedAt: pending.requestedAt}
    await post(s5.orderPath + '/approvals/' + pending.id, {allow: true})
    // A tool that retries the step asks again; keep answering for the rest of this turn and list every request.
    record.laterApprovals = []
    while (!turn.settled) {
      const later = (await execution(s5).catch(() => ({pending: []}))).pending ?? []
      for (const row of later) {
        record.laterApprovals.push({command: row.command, requestedAt: row.requestedAt})
        await post(s5.orderPath + '/approvals/' + row.id, {allow: true}).catch(() => {})
      }
      await delay(1000)
    }
    const result = await turn.promise
    const view = await execution(s5)
    Object.assign(record, {http: result.status, seconds: result.seconds, commands: brief(view.commands), permissions: view.permissions})
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.deepEqual(view.permissions.map(row => [row.from, row.to]), [['full-access', 'ask']])
    record.waitTiers = matching(view.commands, wait).map(row => row.tier)
    assert.ok(matching(view.commands, /\brm\b/).some(row => row.tier === 'ask' && row.decision === 'allowed'), '改档后的删除需主人批准')
  })

  // AC2: the tool cannot start; the order shows the exit code and the stderr tail.
  await check('AC2', 'start failure keeps exit code and stderr', async record => {
    const s6 = await scenario('AC2 故障留证', {title: '启动失败留证'})
    writeFileSync(failFlag, '')
    let result
    try { result = await say(s6.sessionPath, '运行 `ls` 并汇报。', s6.order.id) } finally { rmSync(failFlag, {force: true}) }
    const view = await execution(s6), read = await transcript(s6)
    Object.assign(record, {http: result.status, body: result.body, runs: runsBrief(view.runs), issue: read.issue})
    assert.notEqual(result.status, 200)
    const run = view.runs.at(-1)
    assert.equal(run?.process.exitCode, 1, '记录了进程退出码')
    assert.match(run.process.stderrTail, /simulated start failure/, '记录了 stderr 末尾')
    assert.doesNotMatch(run.process.stderrTail, /sk-acceptance-0123456789abcdef/, 'stderr 已脱敏')
    assert.match(read.issue ?? '', /退出码 1/, '工单显示退出码，不只是“未确认完成”')
    if (browserWanted) {
      await theme(desktop, 'light')
      await openOrder(desktop, host.base, s6)
      await desktop.getByText('退出码 1', {exact: false}).first().waitFor({timeout: 30_000})
      await desktop.locator('.v2-exec-row[data-state="failed"] details summary').first().click().catch(() => {})
      await picture(desktop, 'order-start-failure-1280-light')
    }
  })

  // AC9: an older journal without commands, native sessions or process records still loads.
  await check('AC9', 'old journal loads', async record => {
    const s7 = await scenario('AC9 旧日志', {title: '旧日志兼容'})
    mkdirSync(join(s7.journal, '..'), {recursive: true})
    const at = '2026-11-19T08:00:00.000Z'
    writeFileSync(s7.journal, JSON.stringify({messages: [
      {id: 'u-old', role: 'user', author: '你', speakerId: 'owner', text: '旧版本的一条原话', at, workOrderId: s7.order.id},
      {id: 'm-old', role: 'agent', author: toolLabel, text: '旧版本的一条答复', at: '2026-11-19T08:01:00.000Z', workOrderId: s7.order.id}],
      attachments: [], turns: [{id: 'old-turn', text: '旧版本的一条原话', state: 'done', workOrderId: s7.order.id}], members: []}))
    const read = await transcript(s7), view = await execution(s7)
    Object.assign(record, {messages: read.messages.map(m => m.text), issue: read.issue, execution: {commands: view.commands.length, runs: view.runs.length}})
    assert.deepEqual(read.messages.map(m => m.text), ['旧版本的一条原话', '旧版本的一条答复'])
    assert.deepEqual([view.commands.length, view.runs.length], [0, 0])
  })

  if (long) await check('AC8', 'turn longer than five minutes', async record => {
    const result = await long.turn.promise
    const view = await execution(long.s)
    Object.assign(record, {http: result.status, seconds: result.seconds, commands: brief(view.commands), runs: runsBrief(view.runs), reply: (await replies(long.s)).slice(0, 600)})
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.ok(result.seconds > 330, '回合超过 5 分 30 秒')
    const sleep = matching(view.commands, /sleep\s+330/)
    assert.ok(sleep.some(row => row.exitCode === 0 && row.endedAt && Date.parse(row.endedAt) - Date.parse(row.at) >= 325_000), 'sleep 330 正常结束')
    assert.equal(view.runs.at(-1)?.state, 'done')
  })

  // Phase B: one-minute approval window, and a reviewer model that does not exist.
  if (wanted('AC4') || wanted('AC5')) {
    await host.stop()
    configure(1)
    const settings = JSON.parse(readFileSync(host.settingsFile, 'utf8'))
    writeFileSync(host.settingsFile, JSON.stringify({...settings, liaisonModel: REVIEW_MODEL.split('/')[0] + '/acceptance-model-that-does-not-exist'}), {mode: 0o600})
    await host.start()
    if (browserWanted) await desktop.context().addCookies(host.cookie().split('; ').map(row => ({name: row.slice(0, row.indexOf('=')), value: row.slice(row.indexOf('=') + 1), url: host.base})))
    evidence.notes.push('Phase B: approvalTimeoutMinutes=1, liaisonModel set to a model that does not exist (reviewer unavailable).')

    await check('AC5', 'reviewer unavailable escalates to the owner', async record => {
      const s8 = await scenario('AC5 审查不可用', {permission: 'approve-for-me', title: '删除探针文件 F', promise: '创建 probe-f.txt 后删除它。'})
      const turn = background(s8, steps('运行 `printf probe > probe-f.txt`。', '运行 `rm probe-f.txt`。', '最后用中文汇报每一步的结果。'))
      const [pending] = await waitPending(s8, 15 * 60_000, turn)
      record.pending = {command: pending.command, reason: pending.reason, requestedAt: pending.requestedAt, expiresAt: pending.expiresAt}
      assert.match(pending.reason, /审查/, '卡片注明自动审查不可用')
      await post(s8.orderPath + '/approvals/' + pending.id, {allow: true})
      const result = await turn.promise
      const view = await execution(s8)
      Object.assign(record, {http: result.status, seconds: result.seconds, commands: brief(view.commands)})
      assert.equal(result.status, 200, JSON.stringify(result.body))
      const rm = matching(view.commands, /\brm\b/)
      assert.ok(rm.some(row => row.decision === 'allowed' && row.by === 'owner' && /审查/.test(row.reason)), '转主人批准并在记录中注明原因')
      assert.ok(!existsSync(join(s8.work, 'probe-f.txt')))
    })

    await check('AC4', 'expire after one minute', async record => {
      const s9 = await scenario('AC4 请求批准·过期', {permission: 'ask', title: '探针文件 C 清理', promise: '创建 probe-c.txt 再尝试删除。'})
      const turn = background(s9, steps('运行 `printf probe > probe-c.txt`。', '运行 `rm probe-c.txt`。', '最后用中文汇报每一步的结果，没有执行的步骤请说明原因。'))
      const [pending] = await waitPending(s9, 15 * 60_000, turn)
      record.pending = {command: pending.command, requestedAt: pending.requestedAt, expiresAt: pending.expiresAt}
      // The window is computed from the remaining time, so it may be a few milliseconds short of the full minute.
      const window = Date.parse(pending.expiresAt) - Date.parse(pending.requestedAt)
      assert.ok(window > 59_000 && window <= 60_000, '一分钟审批窗口：' + window + ' ms')
      const result = await turn.promise
      const view = await execution(s9), text = await replies(s9)
      Object.assign(record, {http: result.status, seconds: result.seconds, commands: brief(view.commands), reply: text.slice(0, 1200)})
      assert.equal(result.status, 200, JSON.stringify(result.body))
      assert.ok(matching(view.commands, /\brm\b/).some(row => row.decision === 'expired'), '记录为已过期')
      assert.ok(existsSync(join(s9.work, 'probe-c.txt')), '过期后文件仍在')
      const notice = (await host.api('/chat')).notices?.find(row => row.key?.startsWith('workspace-approval:') && row.key.endsWith(pending.id))
      record.reminder = notice && {status: notice.status, done: notice.done}
    })
  }
} catch (error) {
  evidence.fatal = error instanceof Error ? error.stack : String(error)
  log('FATAL', evidence.fatal)
} finally {
  evidence.endedAt = new Date().toISOString()
  evidence.hostLogTail = host.logs().split('\n').filter(line => /error|warn|把关|gate/i.test(line)).slice(-40).join('\n')
  await browser?.close().catch(() => {})
  evidence.toolHomes = await host.dispose().catch(error => ({warnings: [String(error?.message ?? error)]}))
  save()
  if (!keep) rmSync(base, {recursive: true, force: true})
  else log('保留隔离目录', base)
}
const rows = Object.entries(evidence.results)
for (const [name, row] of rows) console.log((row.status === 'pass' ? 'PASS ' : 'FAIL ') + name + (row.error ? ' — ' + row.error : ''))
process.exitCode = rows.every(([, row]) => row.status === 'pass') && !evidence.fatal ? 0 : 1
