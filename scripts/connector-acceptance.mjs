/** T14–T19 on the packaged app. The isolated test gateway stands in for GitHub. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, delay, until } from './acceptance-host.mjs'

const dir = mkdtempSync(join(tmpdir(), 'chief-connector-probe-'))
const secret = 'chief-fixture-' + randomUUID(), probeFile = join(dir, 'probe.txt')
writeFileSync(probeFile, secret, { mode: 0o600 })
const observed = [], pending = []
let mode = 'normal'
const fixture = createServer((req, res) => {
  observed.push({ path: req.url, method: req.method, authMatch: req.headers.authorization === 'Bearer ' + secret, mode })
  if (mode === 'offline') return req.socket.destroy()
  if (mode === '401') { res.writeHead(401); return res.end() }
  if (mode === 'redirect') { res.writeHead(302, { location: '/not-the-authorized-target' }); return res.end() }
  const respond = () => {
    res.writeHead(200, { etag: mode === 'header-echo' ? secret : '"fixture"', 'x-github-request-id': 'fixture-accept-' + observed.length })
    res.end('可靠正文 ' + (mode === 'body-echo' ? secret : 'fixture'))
  }
  if (mode === 'delayed') pending.push(respond)
  else respond()
})
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const hook = join(dir, 'fetch-fixture.mjs')
writeFileSync(hook, `const upstream = globalThis.fetch
globalThis.fetch = (target, init) => {
  const url = new URL(typeof target === 'string' || target instanceof URL ? target : target.url)
  if (url.hostname === 'api.github.com' && url.pathname.startsWith('/repos/acceptance-sandbox/')) {
    return upstream('http://127.0.0.1:${fixture.address().port}' + url.pathname + url.search, init)
  }
  return upstream(target, init)
}
`)
const host = await acceptanceHost({ probe: 'acceptance-surface-probe.mjs', mobile: true,
  extraEnv: { NODE_OPTIONS: `--import=${hook}`, CHIEF_PROBE_FILE: probeFile, CHIEF_LIAISON_ROTATE_AT: '1' } })
console.log('Connector native host', host.work)
const evidence = { scope: 'packaged DSH, native sessions and tool dispatch, isolated synthetic upstream', work: host.work, cases: [] }
const target = resolve(process.env.CHIEF_CONNECTOR_EVIDENCE ?? 'artifacts/acceptance/connector-matrix-20261118.json')
function save() { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(evidence, null, 2) + '\n') }
const redact = value => String(value).replaceAll(secret, '[probe]')
async function run(id, check, fn) {
  try { evidence.cases.push({ id, check, status: '通过', detail: await fn() }); console.log('PASS', id, check) }
  catch (error) { evidence.cases.push({ id, check, status: '失败', error: redact(error) }); console.log('FAIL', id, check, redact(error)) }
  finally { mode = 'normal'; for (const respond of pending.splice(0)) respond(); save() }
}
const ref = 'a'.repeat(40), path = 'verify.md', repository = 'acceptance-sandbox/allowed'
const connectors = () => host.api('/settings/connectors')
const decide = (id, allow) => host.api('/settings/connectors/decide', { id, allow })
const revoke = id => host.api('/settings/connectors/revoke', { id })
const probe = (room, action, args = {}) => host.request('/chief-acceptance-surface', { session: room.session, action, ...args })
const call = (room, actor, name, args) => probe(room, 'tool', { actor, name, args })
const snap = room => probe(room, 'snapshot')
const waitIdle = room => until(async () => {
  const value = await host.api('/rooms/' + room.id)
  return value.members.every(m => !['running', 'provisioning'].includes(m.status)) ? value : undefined
}, '原生团队回合结束')
async function askAccess(room, purpose, repo = repository) {
  const r = await call(room, 'engineer', 'chief_connector', { action: 'request', repository: repo, path, ref, purpose })
  assert.ok(r.ok, r.message)
  return r.value
}
const read = (room, id, actor = 'engineer', file = path, version = ref) =>
  call(room, actor, 'chief_connector', { action: 'read', request_id: id, path: file, ref: version })
const release = (room, names = ['engineer', 'researcher']) => probe(room, 'release', { names })
const request = async (room, purpose) => {
  const row = await askAccess(room, purpose)
  await decide(row.id, true)
  return row
}
function cookieRows(base) { return host.cookie().split('; ').map(value => ({ name: value.split('=')[0], value: value.slice(value.indexOf('=') + 1), url: base })) }
async function browserPage(browser, room, width, height) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.context().addCookies(cookieRows(host.base))
  await page.goto(host.base + '/chief/m/#room=' + room.id)
  const panel = page.locator('.room-main').getByRole('button', { name: '连接器', exact: true })
  await panel.click()
  return page
}
async function publicCookie() {
  const password = 'isolated!' + randomUUID()
  await host.api('/settings/password', { password })
  const response = await until(async () => {
    const value = await fetch(host.mobileBase + '/login', { method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual' }).catch(() => undefined)
    return value?.status === 303 ? value : undefined
  }, '公开手机登录')
  return response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ')
}

let browser
try {
  await host.start()
  await host.api('/pause', { paused: true })
  await host.api('/settings/connectors/configure', { service: 'github', token: secret })
  const room = await host.api('/rooms', { request_id: 'gateway-a', title: '连接器验收甲' })
  const other = await host.api('/rooms', { request_id: 'gateway-b', title: '连接器验收乙' })
  await probe(room, 'spawn', { names: ['engineer', 'researcher'] })
  await probe(other, 'spawn', { names: ['engineer'] })
  await waitIdle(room); await waitIdle(other)
  const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })
  const login = await publicCookie()

  await run('T14', '关页面保留申请，研究员继续，原工程师接收允许或拒绝各一次', async () => {
    const pendingRequest = await askAccess(room, '核对验收依据')
    const replay = await askAccess(room, '核对验收依据')
    assert.equal(replay.id, pendingRequest.id)
    const popup = await browserPage(browser, room, 1440, 900)
    await popup.getByText('核对验收依据', { exact: true }).waitFor()
    assert.match(await popup.locator('.room-panel').innerText(), /工程师申请读取[\s\S]*acceptance-sandbox\/allowed[\s\S]*30 分钟/)
    await popup.close()
    assert.equal((await connectors()).requests.find(r => r.id === pendingRequest.id).state, 'pending')
    await probe(room, 'send', { actor: 'researcher', target: 'lead', text: '研究员已独立整理公共资料' })
    const before = await host.api('/rooms/' + room.id)
    assert.ok(before.messages.some(m => m.author === 'researcher' && m.text === '研究员已独立整理公共资料'))
    assert.ok(!JSON.stringify(before.messages).includes(secret))
    await decide(pendingRequest.id, true)
    const valid = await read(room, pendingRequest.id)
    assert.ok(valid.ok, valid.message)
    const denied = await askAccess(room, '验收拒绝及恢复')
    await decide(denied.id, false)
    await assert.rejects(decide(denied.id, false))
    assert.equal((await read(room, denied.id)).ok, false)
    await release(room); await waitIdle(room)
    const inputs = (await snap(room)).members.find(m => m.name === 'engineer').inputIds
    for (const row of [pendingRequest, denied]) assert.equal(inputs.filter(id => id === 'access-' + row.id).length, 1)
    assert.ok((await host.api('/rooms/' + room.id)).messages.some(m => m.author === 'engineer' && m.text === '仓库未获授权，现阶段只保留可见公共依据。'))
    return { approval: pendingRequest.id, denial: denied.id, originalReceiver: 'engineer', researcherContinued: true, serviceReceipt: valid.value.receipt }
  })

  await run('T15', '仓库、角色、讨论、版本、假写工具均须在出站前校验', async () => {
    const row = await request(room, '核对范围')
    const foreign = await askAccess(room, '未获批准的另一仓库', 'acceptance-sandbox/denied')
    const start = observed.length
    const outcomes = await Promise.all([
      read(room, row.id, 'researcher'), read(other, row.id), read(room, row.id, 'engineer', 'other.md'), read(room, row.id, 'engineer', path, 'b'.repeat(40)),
      read(room, foreign.id), call(room, 'engineer', 'fixture_write'), call(room, 'engineer', 'fixture_read_named_write'),
      call(room, 'engineer', 'unknown_fixture_action'), call(room, 'engineer', 'chief_connector', { action: 'write' }),
    ])
    assert.ok(outcomes.every(o => !o.ok))
    assert.equal(observed.length, start)
    assert.deepEqual((await snap(room)).noops, {})
    assert.ok((await read(room, row.id)).ok)
    assert.equal((await read(room, row.id)).ok, false)
    const fresh = await askAccess(room, '另一条新申请')
    assert.equal((await read(room, fresh.id)).ok, false)
    const redirect = await request(room, '重定向拒绝')
    mode = 'redirect'
    assert.equal((await read(room, redirect.id)).ok, false)
    assert.equal(observed.filter(row => row.path === '/not-the-authorized-target').length, 0)
    assert.equal(observed.filter(row => row.method !== 'GET').length, 0)
    await release(room); await release(other, ['engineer'])
    return { blocked: outcomes.length, targetChanged: false, writes: 0, oldGrantReplayed: false }
  })

  await run('T15', '换段前后接口人都拒绝工作端直接操作', async () => {
    const chat = await host.api('/chat')
    const settings = () => JSON.parse(readFileSync(host.settingsFile, 'utf8')).liaison
    const initial = settings()?.session ?? chat.sessionId
    const policy = id => probe({ session: id }, 'policy', { name: 'remote_fixture_forward' })
    const before = await probe({ session: initial }, 'tool', { name: 'remote_fixture_forward' })
    assert.equal(before.ok, false)
    const initialPolicy = await policy(initial)
    assert.ok(initialPolicy.guard)
    await host.api('/chat', { sessionId: chat.sessionId, text: '供验收的换段请求。' })
    const next = await until(() => settings()?.session !== initial && settings()?.session, '接口人原生换段')
    const after = await probe({ session: next }, 'tool', { name: 'remote_fixture_forward' })
    assert.equal(after.ok, false)
    const nextPolicy = await policy(next)
    assert.ok(nextPolicy.guard)
    assert.deepEqual((await probe({ session: next }, 'snapshot')).noops, {})
    return { initial, next, initialPolicy, nextPolicy }
  })

  await run('T16', '公开入口和缺请求标记均拒绝，正文回显只返回遮蔽串', async () => {
    const publicOptions = { baseUrl: host.mobileBase, login, raw: true }
    for (const [route, body] of [['/settings', undefined], ['/settings/connectors', undefined], ['/settings/connectors/configure', { service: 'github', token: 'ignored' }], ['/settings/connectors/decide', { id: 'ignored', allow: true }]])
      assert.equal((await host.api(route, body, publicOptions)).status, 403)
    assert.equal((await host.api('/settings/connectors/configure', { service: 'github', token: 'ignored' }, { marked: false, raw: true })).status, 403)
    const row = await request(room, '正文回显探针')
    mode = 'body-echo'
    const result = await read(room, row.id)
    assert.ok(result.ok, result.message)
    assert.ok(!result.credentialHit && result.value.content.includes('已隐藏凭据'))
    assert.ok(!JSON.stringify(await connectors()).includes(secret))
    return { publicStatuses: [403, 403, 403, 403], unmarked: 403, bodyCredentialHit: false }
  })

  await run('T16', '响应头探针不得进入工具结果', async () => {
    const row = await request(room, '异常回显的响应头')
    mode = 'header-echo'
    const result = await read(room, row.id)
    assert.equal(!!result.credentialHit, false, '模型工具结果的 etag 包含测试凭据')
  })

  await run('T16', '日志、脑内文件和普通 DSH 工具环境探针', async () => {
    assert.ok(!host.logs().includes(secret))
    const brainHit = readdirSync(host.brain, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && !entry.parentPath.includes('/.git'))
      .some(entry => readFileSync(join(entry.parentPath, entry.name)).includes(secret))
    assert.equal(brainHit, false)
    const native = await snap(room)
    assert.ok(native.members.every(m => !m.credentialHit))
    const ordinary = { session: 'fixture-ordinary-work' }
    await probe(ordinary, 'create-root', { brain: host.brain })
    const envCheck = await call(ordinary, 'lead', 'bash', { description: 'Check synthetic credential absence in environment', command: 'node -e "console.log(Object.values(process.env).some(v=>v.startsWith(\'chief-fixture-\')))"' })
    assert.ok(envCheck.ok, envCheck.message)
    assert.ok(JSON.stringify(envCheck.value).includes('false') && !envCheck.credentialHit)
    const client = await browserPage(browser, room, 1440, 900)
    try {
      const stored = await client.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }))
      assert.ok(!stored.includes(secret))
    } finally { await client.close() }
    const chiefHome = join(host.home, 'chief')
    const privateEntry = readdirSync(chiefHome, { recursive: true, withFileTypes: true }).find(entry => entry.name === 'connector-secrets.json')
    assert.ok(privateEntry)
    const privateFile = join(privateEntry.parentPath, privateEntry.name)
    const data = await call(ordinary, 'lead', 'read', { file_path: privateFile })
    assert.ok(!data.credentialHit, '普通 DSH 会话的 Read 工具读取到连接器私有文件里的探针')
    return { brainHit, agentLogs: false, environment: false, fileBlocked: !data.ok, fileReadResult: data.message, browserStorageHit: false }
  })

  await run('T17', '五个并发 401、离线、再连接与原权限', async () => {
    const rows = []
    for (let i = 0; i < 5; i++) rows.push(await request(room, '固定凭据过期 ' + i))
    mode = '401'
    const start = observed.length
    const replies = await Promise.all(rows.map(r => read(room, r.id)))
    assert.ok(replies.every(r => !r.ok && r.message.includes('401')))
    assert.equal(observed.length - start, 5)
    mode = 'normal'
    const view = await connectors()
    assert.ok(rows.every(row => view.requests.find(r => r.id === row.id).state === 'used'))
    const offline = await request(room, '传输离线')
    mode = 'offline'
    assert.equal((await read(room, offline.id)).ok, false)
    mode = 'normal'
    await host.api('/settings/connectors/configure', { service: 'github', token: secret })
    const resumed = await read(room, offline.id)
    assert.equal(resumed.ok, true, '401 后仍显示已连接，离线请求已消耗，重连后原申请不能续办。固定令牌适配器没有刷新分支')
  })

  await run('T18', '桌面处理后手机旧卡拒绝，排队和在途撤权丢弃', async () => {
    const row = await askAccess(room, '双客户端批准')
    const desktop = await browserPage(browser, room, 1440, 900)
    const mobile = await browserPage(browser, room, 390, 844)
    const card = page => page.locator('.room-panel section').filter({ hasText: '双客户端批准' })
    try {
      await card(mobile).getByRole('button', { name: '拒绝' }).waitFor()
      await card(desktop).getByRole('button', { name: '允许本次' }).click()
      await until(async () => (await connectors()).requests.find(r => r.id === row.id)?.notified, '桌面写入批准')
      await card(mobile).getByRole('button', { name: '拒绝' }).click()
      await mobile.getByRole('alert').filter({ hasText: /已处理|已过期/ }).waitFor()
      const shot = process.env.CHIEF_SCREENSHOT_DIR
      if (shot) {
        await mobile.locator('.room-panel').getByRole('button', { name: '返回讨论', exact: true }).click()
        await mobile.getByRole('alert').filter({ hasText: /已处理|已过期/ }).scrollIntoViewIfNeeded()
        await mobile.screenshot({ path: join(shot, 'acceptance-1118-t18-mobile.png') })
      }
    } finally { await desktop.close(); await mobile.close() }
    assert.equal((await connectors()).requests.find(r => r.id === row.id).state, 'allowed')
    const notStarted = await askAccess(room, '未开始撤销')
    await revoke(notStarted.id)
    await assert.rejects(decide(notStarted.id, true))
    const before = observed.length
    await revoke(row.id)
    assert.equal((await read(room, row.id)).ok, false)
    assert.equal(observed.length, before)
    const inFlight = await request(room, '已经出站的撤销')
    mode = 'delayed'
    const late = read(room, inFlight.id)
    await until(() => pending.length > 0, '请求已经出站')
    await revoke(inFlight.id)
    pending.shift()()
    const result = await late
    assert.equal(result.ok, false); assert.match(result.message, /已失效/)
    mode = 'normal'
    assert.equal((await read(other, inFlight.id)).ok, false)
    await release(room); await release(other, ['engineer'])
    await host.stop(true); await host.start()
    const beforeReplay = observed.length
    assert.equal((await read(room, inFlight.id)).ok, false)
    assert.equal(observed.length, beforeReplay)
    const history = (await connectors()).requests.find(r => r.id === inFlight.id)
    assert.equal(history.state, 'used'); assert.ok(history.revoked)
    return { staleWindowRejected: true, pendingBlocked: true, delayedDiscarded: true, lateStatus: history.state, restartReplay: false,
      publicDecision: (await host.api('/settings/connectors/decide', { id: row.id, allow: true }, { baseUrl: host.mobileBase, login, raw: true })).status }
  })
  await run('T19', '个人连接器许可无法通过其他原生讨论或执行会话转发', async () => {
    const row = await request(room, '连接器许可与外派隔离')
    const normal = { session: 'fixture-non-room-worker' }
    await probe(normal, 'create-root', { brain: host.brain })
    const start = observed.length
    assert.equal((await read(other, row.id)).ok, false)
    assert.equal((await call(normal, 'lead', 'chief_connector', { action: 'read', request_id: row.id, path, ref })).ok, false)
    await revoke(row.id)
    assert.equal((await read(room, row.id)).ok, false)
    assert.equal(observed.length, start)
    return { blockedBeforeEgress: true, scopeReplayed: false }
  })
  await run('T17', '到期的原批准在重启后仍无法出站', async () => {
    const r = await request(room, '授予后超过本地有效期')
    await release(room)
    await host.stop()
    const entry = readdirSync(join(host.home, 'chief'), { recursive: true, withFileTypes: true }).find(row => row.name === 'connector-state.json')
    const file = join(entry.parentPath, entry.name)
    const state = JSON.parse(readFileSync(file, 'utf8'))
    state.requests.find(row => row.id === r.id).expires = Date.now() - 60_000
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 })
    await host.start()
    const before = observed.length
    assert.equal((await read(room, r.id)).ok, false)
    assert.equal(observed.length, before)
    return { expiredBeforeEgress: true }
  })
  evidence.egress = observed
  evidence.completed = true
  save()
  if (evidence.cases.some(row => row.status === '失败')) process.exitCode = 1
} catch (error) {
  evidence.error = redact(error)
  console.error(evidence.error)
  process.exitCode = 1
  save()
} finally {
  await browser?.close()
  await host.stop()
  await new Promise(resolve => fixture.close(resolve))
}
