/**
 * 手机访问：插件自己开的一个端口，让手机从公网用密码打开作战台。默认关闭。
 *
 * 只开放作战台，不开放 DSH 本身：
 *   GET  /login /logout            登录页、退出
 *   GET  / /app.js /page.css ...   手机版作战台的静态文件（登录后）
 *   *    /chief/api/*              作战台接口（登录后），直接调用同一套路由，标记为 public——拿不到设置类接口
 * 其余路径一律 404。DSH 主界面、终端、插件管理不经过这里。
 *
 * 登录：
 *   - 密码只存 scrypt 哈希（$DSH_HOME/chief/config.json），在作战台的设置页里设。
 *   - 每次失败延迟 0.8 秒；同一 IP 15 分钟内失败 5 次锁 15 分钟；全局 1 小时失败 30 次全部锁 1 小时。
 *   - 登录后发一个 32 字节随机会话令牌（HttpOnly、SameSite=Strict、30 天）；服务器只存它的哈希，重启和热重载都不掉登录。
 *
 * 注意：这个端口是 HTTP，密码和会话在公网上是明文。别在不可信的公共 Wi-Fi 上用；要加密请在前面放一个 HTTPS 反向代理。
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { verifyPasswordAsync } from './settings.ts'

const COOKIE = 'chief_gw'
const SESSION_DAYS = 30
const MAX_SESSIONS = 20
const MAX_LOGIN_BODY = 4 * 1024
/** 同时在校验的登录最多几个：并发请求不能绕过限流，也不能把 CPU 吃满。 */
const MAX_INFLIGHT_LOGINS = 4

export interface MobileServerOptions {
  port: number
  host: string
  /** 每次登录时现读，改了密码立即生效。 */
  passwordHash: () => string | undefined
  /** 会话文件放这里（$DSH_HOME/chief）。 */
  stateDir: string
  /** 手机页面的静态文件目录（lib/mobile）。 */
  staticDir: string
  /** 已登录的 /chief/api/* 请求交给它。 */
  api: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  log: (message: string) => void
}

export interface MobileServer { readonly port: number; close(): Promise<void>; revokeAll(): void }

interface Session { created: number; seen: number; ua?: string }

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
const STATIC = new Set(['/app.js', '/page.css', '/icon.svg', '/manifest.webmanifest'])
const SECURITY = {
  'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  // The composer shows just-picked photos from browser-owned object URLs.
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function loginPage(message = '', form = true) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#151517" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/icon.svg">
<title>SuperHub</title><link rel="stylesheet" href="/login.css"></head><body>
<main><img src="/icon.svg" alt="" width="56" height="56"><h1>SuperHub</h1>
${form ? '<form method="post" action="/login"><input type="password" name="password" autocomplete="current-password" placeholder="密码" aria-label="密码" required autofocus><button>进入</button></form>' : ''}${message ? `<p role="alert">${esc(message)}</p>` : ''}</main></body></html>`
}

const LOGIN_CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#0f1115;--dim:#81858c;--line:#0000001a;--ink:#0f1115;--on:#fff;--err:#ec1313}
@media (prefers-color-scheme:dark){:root{--bg:#151517;--fg:#f9fafb;--dim:#adb2b8;--line:#ffffff1f;--ink:#f9fafb;--on:#151517;--err:#f25a5a}}
html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;box-sizing:border-box;text-align:center}
img{border-radius:14px}h1{font-size:22px;margin:0 0 8px;font-weight:600}
form{display:flex;flex-direction:column;gap:10px;width:min(320px,100%)}
input{font:inherit;font-size:16px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg)}
input:focus{outline:2px solid #4176e6;outline-offset:1px}
button{font:inherit;font-weight:600;padding:12px;border:0;border-radius:12px;background:var(--ink);color:var(--on);cursor:pointer}
p{color:var(--err);font-size:14px;margin:0;max-width:320px}`

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY, 'content-type': type, 'cache-control': 'no-store', ...extra })
  res.end(body)
}

async function readSmallBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_LOGIN_BODY) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return undefined
}

/** 会话与防暴力破解。单独成类，便于测试。 */
export class Gatekeeper {
  private sessions: Map<string, Session>
  private readonly failures = new Map<string, number[]>()
  private globalFailures: number[] = []
  private globalLockUntil = 0
  private readonly file: string

  constructor(stateDir: string, private readonly now = () => Date.now()) {
    this.file = join(stateDir, 'mobile-sessions.json')
    let raw: Record<string, Session> = {}
    try { raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Session> } catch { /* 没有或坏了就从空开始 */ }
    this.sessions = new Map(Object.entries(raw))
  }

  private save() {
    const dir = join(this.file, '..')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** 有效会话返回它的键（令牌哈希）。 */
  session(token: string | undefined): string | undefined {
    if (!token || !/^[A-Za-z0-9_-]{40,}$/.test(token)) return undefined
    const key = sha(token)
    const s = this.sessions.get(key)
    if (!s || this.now() - s.created > SESSION_DAYS * 86_400_000) return undefined
    if (this.now() - (s.seen ?? 0) > 3_600_000) { s.seen = this.now(); this.save() }
    return key
  }

  open(ua: string): string {
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(sha(token), { created: this.now(), seen: this.now(), ua: ua.slice(0, 120) })
    if (this.sessions.size > MAX_SESSIONS) this.sessions = new Map([...this.sessions].sort((a, b) => b[1].seen - a[1].seen).slice(0, MAX_SESSIONS))
    this.save()
    return token
  }

  close(key: string) { if (this.sessions.delete(key)) this.save() }
  /** 改密码时让所有手机重新登录。 */
  revokeAll() { this.sessions.clear(); this.save() }

  /** 还要锁多少分钟；0 表示可以尝试。 */
  locked(ip: string): number {
    const now = this.now()
    if (now < this.globalLockUntil) return Math.ceil((this.globalLockUntil - now) / 60_000)
    const recent = (this.failures.get(ip) ?? []).filter(t => now - t < 15 * 60_000)
    this.failures.set(ip, recent)
    return recent.length >= 5 ? Math.ceil((recent[0]! + 15 * 60_000 - now) / 60_000) : 0
  }

  /** 登录前先记一次失败（并发请求也会被计数），成功后再撤回。 */
  attempt(ip: string): boolean { return this.fail(ip) }

  fail(ip: string): boolean {
    const now = this.now()
    this.failures.set(ip, [...this.failures.get(ip) ?? [], now])
    this.globalFailures = [...this.globalFailures.filter(t => now - t < 3_600_000), now]
    if (this.globalFailures.length >= 30) { this.globalLockUntil = now + 3_600_000; return true }
    return false
  }

  succeed(ip: string) {
    this.failures.delete(ip)
    this.globalFailures.pop()
  }
}

/**
 * 手机页面的静态文件（index.html、app.js 等）。DSH 网页服务下的 /chief/m/ 也用它：
 * 已经登录 DSH 的浏览器打开 /chief/m/，就是不带 DSH 外壳的作战台。返回 false 表示不是手机页面的文件。
 */
export function sendMobileFile(res: ServerResponse, staticDir: string, name: string): boolean {
  const file = name === '' || name === 'index.html' ? 'index.html' : name
  if (file !== 'index.html' && !STATIC.has(`/${file}`)) return false
  const type = TYPES[file.slice(file.lastIndexOf('.'))]
  send(res, 200, readFileSync(join(staticDir, file)), type, file === 'index.html' ? {} : { 'cache-control': 'no-cache' })
  return true
}

/** 清掉所有手机登录（手机访问端口没开着时换了密码用）。 */
export function revokeSessions(stateDir: string) { new Gatekeeper(stateDir).revokeAll() }

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * 启动手机访问端口。热重载时新旧插件实例在同一进程里交接，旧实例可能还没关端口：端口被占用时重试 5 秒。
 */
export async function startMobileServer(opts: MobileServerOptions): Promise<MobileServer> {
  const gate = new Gatekeeper(opts.stateDir)
  let inflight = 0
  const file = (name: string) => join(opts.staticDir, name)
  const server = createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? '?'
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://mobile') } catch { return send(res, 400, '请求格式错误') }
    const path = url.pathname
    try {
      if (path === '/login.css') return send(res, 200, LOGIN_CSS, TYPES['.css'], { 'cache-control': 'public, max-age=3600' })
      if (path === '/icon.svg' || path === '/manifest.webmanifest') return send(res, 200, readFileSync(file(path.slice(1))), TYPES[path.slice(path.lastIndexOf('.'))], { 'cache-control': 'public, max-age=86400' })
      const hash = opts.passwordHash()
      if (!hash) return send(res, 503, loginPage('请在电脑上打开 SuperHub，在「设置」中设定手机访问密码。', false), TYPES['.html'])
      if (path === '/login' && req.method === 'GET') return send(res, 200, loginPage(), TYPES['.html'])
      if (path === '/login' && req.method === 'POST') {
        const tooMany = (wait: number) => send(res, 429, loginPage(`尝试次数过多，请 ${wait} 分钟后再试。`), TYPES['.html'])
        let wait = gate.locked(ip)
        if (wait) return tooMany(wait)
        const password = new URLSearchParams(await readSmallBody(req)).get('password') ?? ''
        // 读请求体期间别的请求可能已经把它锁住了
        if ((wait = gate.locked(ip))) return tooMany(wait)
        if (inflight >= MAX_INFLIGHT_LOGINS) return send(res, 429, loginPage('登录请求太多，请稍后再试。'), TYPES['.html'])
        if (gate.attempt(ip)) opts.log('手机访问：失败次数过多，全部锁定 1 小时')
        inflight++
        let ok = false
        try { ok = await verifyPasswordAsync(password, hash) } finally { inflight-- }
        if (!ok) {
          opts.log(`手机访问：登录失败 ${ip}`)
          await new Promise(r => setTimeout(r, 800))
          return send(res, 401, loginPage('密码不对。'), TYPES['.html'])
        }
        gate.succeed(ip)
        opts.log(`手机访问：登录成功 ${ip}`)
        const token = gate.open(String(req.headers['user-agent'] ?? ''))
        res.writeHead(303, { ...SECURITY, location: '/', 'cache-control': 'no-store', 'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}` })
        return res.end()
      }
      if (path === '/logout') {
        const key = gate.session(cookieOf(req, COOKIE))
        if (key) gate.close(key)
        res.writeHead(303, { ...SECURITY, location: '/login', 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
        return res.end()
      }

      // 以下都需要登录
      const session = gate.session(cookieOf(req, COOKIE))
      const api = path.startsWith('/chief/api/')
      if (!session) {
        if (api) return send(res, 401, JSON.stringify({ error: '登录已过期，请刷新页面重新登录' }), 'application/json; charset=utf-8')
        res.writeHead(303, { ...SECURITY, location: '/login', 'cache-control': 'no-store' })
        return res.end()
      }
      if (path === '/' || path === '/index.html') return send(res, 200, readFileSync(file('index.html')), TYPES['.html'])
      if (STATIC.has(path)) return send(res, 200, readFileSync(file(path.slice(1))), TYPES[path.slice(path.lastIndexOf('.'))], { 'cache-control': 'no-cache' })
      if (api) { await opts.api(req, res); return }
      return send(res, 404, '没有这个页面')
    } catch (error) {
      opts.log(`手机访问出错 ${path}：${(error as Error).message}`)
      if (!res.headersSent) {
        const status = (error as { status?: number }).status ?? 500
        if (path.startsWith('/chief/api/')) send(res, status, JSON.stringify({ error: (error as Error).message }), 'application/json; charset=utf-8')
        else send(res, status, '出错了')
      }
    }
  })
  server.headersTimeout = 15_000
  server.requestTimeout = 60_000
  const deadline = Date.now() + 5_000
  for (;;) {
    try { await listen(server, opts.port, opts.host); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || Date.now() > deadline) throw error
      await new Promise(r => setTimeout(r, 250))
    }
  }
  if (!existsSync(file('app.js'))) opts.log('手机访问：缺少 app.js，手机页面打不开（插件没有构建完整）')
  const port = (server.address() as { port: number }).port
  return {
    port,
    revokeAll: () => gate.revokeAll(),
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
