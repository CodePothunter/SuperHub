/** Real DSH host for disposable acceptance runs. Authentication stays in process. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolateToolHomes } from './acceptance-homes.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export const freePort = () => new Promise(resolve => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => resolve(port))
  })
})
export async function until(check, label, timeout = 25_000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    const value = await check()
    if (value) return value
    await delay(250)
  }
  throw Error(`等待超时 ${label}`)
}

/**
 * `directory` holds the disposable DSH home and brain. DSH's workspace-write sandbox always allows /tmp and the
 * host temp directory, so a check that a write outside the session workspace is refused needs a base elsewhere.
 */
export async function acceptanceHost({ candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE, probe, model, mobile = false, extraEnv = {}, directory = tmpdir() } = {}) {
  assert.ok(candidate, '必须明确指定隔离候选包')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const work = mkdtempSync(join(directory, 'chief-accept-'))
  const home = join(work, 'home'), brain = join(work, 'brain'), settingsFile = join(home, 'chief/config.json')
  // Real Codex / Claude Code started by this host keep their sessions and trust entries in private homes (see
  // acceptance-homes.mjs); the owner's ~/.codex and ~/.claude stay as they were. `extraEnv` can still set its own.
  const tools = isolateToolHomes()
  const inherited = tools ? tools.apply(process.env) : process.env
  const env = { ...inherited, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...extraEnv }
  delete env.CHIEF_NOTIFY_URL
  // DSH watches bundle ctime for hot reload. Installing a hard link in another profile changes that
  // same inode and would reload this browser in the middle of a conversation. Only tests use copies.
  const install = packagePath => execFileSync('dsh', ['plugin', '--profile', 'web', 'add', packagePath, '--config.package-import-method=copy'], { env, cwd: work, stdio: 'pipe', timeout: 180_000 })
  install(candidate)
  if (probe) {
    const path = join(work, 'probe')
    mkdirSync(path)
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'chief-acceptance-case-probe', version: '0.0.1', type: 'module', main: 'index.mjs', dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(path, 'cordis.patch.yml'), '- insert:\n    - id: chief-acceptance-case-probe\n      name: chief-acceptance-case-probe\n')
    copyFileSync(join(root, 'scripts', probe), join(path, 'index.mjs'))
    install(path)
  }
  const providerEnv = { ...env }
  if (model) {
    const profile = readFileSync(join(homedir(), 'workspace/dsh/home/profiles/web/cordis.patch.yml'), 'utf8')
    const providers = profile.slice(profile.indexOf('- id: llm-pi-ai'), profile.indexOf('- id: agent-default-model'))
    assert.ok(providers.includes('zhipu'), '未找到服务器的模型路由配置')
    const [provider, name] = model.split('/')
    writeFileSync(join(home, 'profiles/web/cordis.patch.yml'), `${providers}\n- id: agent-default-model\n  config:\n    provider: ${provider}\n    model: ${name}\n`, { mode: 0o600 })
    if (provider === 'deepseek-official') {
      const yaml = (await import('yaml')).default
      const file = join(homedir(), 'workspace/dsh/home/.credentials.yaml')
      const parsed = yaml.parseDocument(readFileSync(file, 'utf8'))
      assert.ok(!parsed.errors.length, 'DSH 凭据文件无法读取')
      const credential = parsed.getIn(['refs', 'DEEPSEEK_API_KEY'])
      assert.ok(typeof credential === 'string' && credential, '隔离模型调用需要已有的 DSH 服务凭据')
      providerEnv.DEEPSEEK_API_KEY = credential
    }
  }
  execFileSync('node', ['--experimental-transform-types', '--input-type=module', '-e', `import { scaffoldBrain } from './src/dsh/scaffold.ts'; scaffoldBrain(${JSON.stringify(brain)})`], { cwd: root, stdio: 'pipe' })
  mkdirSync(dirname(settingsFile), { recursive: true, mode: 0o700 })
  const mobilePort = await freePort()
  writeFileSync(settingsFile, JSON.stringify({ brain, timeZone: 'Asia/Shanghai', concurrency: 2, liaisonModel: model, mobile: { enabled: mobile, port: mobilePort, host: '127.0.0.1' } }), { mode: 0o600 })
  const port = await freePort(), base = `http://127.0.0.1:${port}`, mobileBase = `http://127.0.0.1:${mobilePort}`
  let child, cookie = '', log = ''
  // A script that ends (or is interrupted) without stopping the host: the host and the tools it started go before their
  // private homes are deleted, so nothing keeps writing (or rotating a login) into a removed home.
  tools?.onTeardown(() => {
    if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }
  })
  async function request(path, body, options = {}) {
    const { baseUrl = base, login = cookie, marked = true, raw = false } = options
    const response = await fetch(baseUrl + path, {
      signal: AbortSignal.timeout(18_000), headers: {
        cookie: login, ...(body === undefined ? {} : { 'content-type': 'application/json', ...(marked ? { 'x-chief-request': '1' } : {}) }),
      }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), redirect: 'manual',
    })
    if (raw) return response
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw Object.assign(Error(`${path} ${response.status} ${value.error ?? ''}`), { status: response.status })
    return value
  }
  const api = (route, body, options) => request('/chief/api' + route, body, options)
  async function start() {
    log = ''
    child = spawn('dsh', ['web', '--no-open', '--port', String(port)], { cwd: work, env: providerEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data })
    const token = await until(() => {
      if (child.exitCode !== null) throw Error(`隔离 DSH 启动失败（${child.exitCode}）`)
      return [...log.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
    }, '隔离宿主登录地址')
    const response = await fetch(base + '/?token=' + token, { redirect: 'manual' })
    cookie = response.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
    assert.ok(cookie)
    await until(() => api('/state').catch(() => undefined), '候选包启动')
  }
  async function stop(crash = false) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    process.kill(-child.pid, crash ? 'SIGKILL' : 'SIGTERM')
    await until(() => child.exitCode !== null || child.signalCode !== null, '隔离宿主退出', 12_000).catch(() => process.kill(-child.pid, 'SIGKILL'))
  }
  /** Stop the host and remove the private tool homes (writing a rotated Codex login back); also runs on process exit. */
  async function dispose() {
    await stop()
    return tools?.teardown()
  }
  return { work, home, brain, settingsFile, base, mobileBase, api, request, install, start, stop, dispose, cookie: () => cookie,
    codexHome: tools?.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    claudeConfigDir: tools?.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    logs: () => log.replace(/[?&]token=[^\s&]+/g, '?token=[隐去]') }
}
