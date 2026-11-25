/** 重构后的新模块：配置、初始化、界面定制、手机访问、接口挂载方式。 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyPatch, EMPTY_CUSTOM, normalizeCustom } from '../src/core/custom.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { CustomStore } from '../src/dsh/custom-store.ts'
import { runtimeRoutes, serveApi, type Route } from '../src/dsh/http.ts'
import { Gatekeeper, revokeSessions, startMobileServer } from '../src/dsh/mobile-server.ts'
import { classify, ensureDevStaff, resolveBrainDir, scaffoldBrain, templatesDir } from '../src/dsh/scaffold.ts'
import { hashPassword, publicSettings, SettingsStore, verifyPassword } from '../src/dsh/settings.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'chief-setup-'))

describe('配置', () => {
  it('缺省值、局部更新、文件权限', () => {
    const dir = join(tmp(), 'chief')
    const store = new SettingsStore(dir)
    expect(store.get().brain).toBeUndefined()
    expect(store.get().mobile).toMatchObject({ enabled: false, port: 50388, host: '0.0.0.0' })
    store.update({ brain: '/x/brain', timeZone: 'Asia/Shanghai', mobile: { enabled: true } })
    const again = new SettingsStore(dir)
    expect(again.get()).toMatchObject({ brain: '/x/brain', timeZone: 'Asia/Shanghai', mobile: { enabled: true, port: 50388 } })
    expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('拒绝不合法的值', () => {
    const store = new SettingsStore(join(tmp(), 'chief'))
    expect(() => store.update({ timeZone: 'Mars/Base' })).toThrow('时区')
    expect(() => store.update({ concurrency: 9 })).toThrow('并发')
    expect(() => store.update({ notifyUrl: 'ftp://x' })).toThrow('推送')
    expect(() => store.update({ mobile: { port: 80 } })).toThrow('端口')
    store.update({ notifyUrl: 'https://ntfy.sh/x' })
    store.update({ notifyUrl: '' })
    expect(store.get().notifyUrl).toBeUndefined()
  })

  it('坏文件按缺省处理并留下备份', () => {
    const dir = join(tmp(), 'chief')
    mkdirSync(dir)
    writeFileSync(join(dir, 'config.json'), '{坏的')
    expect(new SettingsStore(dir).get().concurrency).toBe(2)
    expect(existsSync(join(dir, 'config.json'))).toBe(false)
  })

  it('密码只存哈希，对外不暴露', () => {
    const hash = hashPassword('correct horse')
    expect(hash).not.toContain('correct')
    expect(verifyPassword('correct horse', hash)).toBe(true)
    expect(verifyPassword('wrong horse', hash)).toBe(false)
    expect(verifyPassword('x', undefined)).toBe(false)
    expect(() => hashPassword('short')).toThrow('8')
    const store = new SettingsStore(join(tmp(), 'chief'))
    store.update({ mobile: { passwordHash: hash } })
    expect(JSON.stringify(publicSettings(store.get()))).not.toContain('scrypt')
    expect(publicSettings(store.get()).mobile.hasPassword).toBe(true)
  })
})

describe('初始化', () => {
  const home = '/home/someone'
  it('校验路径', () => {
    expect(resolveBrainDir('~/chief-brain', { home })).toBe('/home/someone/chief-brain')
    expect(() => resolveBrainDir('relative/dir', { home })).toThrow('完整路径')
    expect(() => resolveBrainDir('/', { home })).toThrow()
    expect(() => resolveBrainDir('/tmp', { home })).toThrow('一级目录')
    expect(() => resolveBrainDir('~', { home })).toThrow()
    expect(() => resolveBrainDir('~/.dsh/chief', { home, dshHome: '/home/someone/.dsh' })).toThrow('DSH')
    expect(() => resolveBrainDir('~/.dsh/brain', { home, dshHome: undefined })).toThrow('DSH') // 没设 DSH_HOME 时默认 ~/.dsh
    expect(() => resolveBrainDir('~brain', { home })).toThrow('~/')
  })

  it('空目录：复制模板并提交', () => {
    const dir = join(tmp(), 'brain')
    const result = scaffoldBrain(dir)
    expect(result.kind).toBe('created')
    for (const f of ['AGENTS.md', 'goals.md', 'rules.yaml', 'README.md', '.gitignore', 'staff/chief.md', 'staff/reviewer.md', 'staff/liaison.md']) expect(existsSync(join(dir, f)), f).toBe(true)
    expect(existsSync(join(dir, 'staff', 'ui-smith.md'))).toBe(false) // 界面师只在开发模式下有
    expect(classify(dir)).toBe('brain')
    expect(new BrainRepo(dir).staff().length).toBe(7)
    if (result.git) expect(execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' })).toContain('初始化')
  })

  it('已有的第二大脑：只补缺失的顶层条目，不覆盖、不复活退休的幕僚', () => {
    const dir = join(tmp(), 'brain')
    scaffoldBrain(dir)
    writeFileSync(join(dir, 'AGENTS.md'), '我自己的宪法')
    mkdirSync(join(dir, 'staff', '.retired'))
    renameSync(join(dir, 'staff', 'researcher.md'), join(dir, 'staff', '.retired', 'researcher.md'))
    execFileSync('rm', [join(dir, 'goals.md')])
    const result = scaffoldBrain(dir)
    expect(result.kind).toBe('adopted')
    expect(result.added).toEqual(['goals.md'])
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('我自己的宪法')
    expect(existsSync(join(dir, 'staff', 'researcher.md'))).toBe(false)
  })

  it('非空又不是第二大脑：拒绝', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'notes.txt'), 'x')
    expect(classify(dir)).toBe('other')
    expect(() => scaffoldBrain(dir)).toThrow('别的东西')
  })

  it('开发模式补上界面师，但不复活退休的', () => {
    const dir = join(tmp(), 'brain')
    scaffoldBrain(dir)
    expect(ensureDevStaff(dir)).toEqual(['staff/ui-smith.md'])
    expect(ensureDevStaff(dir)).toEqual([])
    renameSync(join(dir, 'staff', 'ui-smith.md'), join(dir, 'staff', '.retired-ui.md'))
    mkdirSync(join(dir, 'staff', '.retired'), { recursive: true })
    writeFileSync(join(dir, 'staff', '.retired', 'ui-smith.md'), 'x')
    expect(ensureDevStaff(dir)).toEqual([])
  })

  it('模板里没有本机路径和个人信息', () => {
    const t = templatesDir()
    let hits = ''
    try { hits = execFileSync('grep', ['-rl', '-e', 'ubuntu', '-e', '字节', '-e', '106.55', t], { encoding: 'utf8' }).trim() } catch { /* 没有匹配时 grep 以 1 退出 */ }
    expect(hits).toBe('')
  })
})

describe('界面定制', () => {
  it('丢掉不安全或不认识的值，并说明原因', () => {
    const { custom, dropped } = normalizeCustom({
      theme: { accent: '#3B82F6', warn: 'red; background:url(x)', radius: 'round', scale: 3, css: 'body{}' },
      layout: { hidden: ['events', 'chat', 'nope'], tabs: ['today', 'chat', 'x'], defaultTab: 'people', sections: { today: ['ledger', 'decide', 'map'] } },
      panels: [
        { id: 'okr', title: '本季目标', kind: 'markdown', path: 'goals.md' },
        { id: 'evil', title: '越界', kind: 'markdown', path: '../../etc/passwd.md' },
        { id: 'owed', title: '别人欠我的', kind: 'records', of: 'ledger', where: { direction: 'theirs', secret: 'x' } },
        { id: 'today', title: '重名', kind: 'markdown', path: 'a.md' },
      ],
    })
    expect(custom.theme).toEqual({ accent: '#3b82f6', radius: 'round' })
    expect(custom.layout.hidden).toEqual(['events'])
    expect(custom.layout.tabs).toEqual(['today', 'chat'])
    expect(custom.layout.sections?.today).toEqual(['ledger', 'decide'])
    expect(custom.panels.map(p => p.id)).toEqual(['okr', 'owed'])
    expect(custom.panels[1]).toMatchObject({ where: { direction: 'theirs' }, limit: 10 })
    expect(dropped.length).toBeGreaterThanOrEqual(7)
  })

  it('局部修改：null 恢复默认，删面板时一并清理引用', () => {
    let c = applyPatch(EMPTY_CUSTOM, { theme: { accent: '#112233', density: 'compact' }, panels: [{ id: 'okr', title: '目标', kind: 'markdown', path: 'goals.md' }], layout: { hidden: ['okr'], sections: { today: ['okr', 'decide'] } } }).custom
    expect(c.rev).toBe(1)
    c = applyPatch(c, { theme: { accent: null } }).custom
    expect(c.theme).toEqual({ density: 'compact' })
    c = applyPatch(c, { removePanels: ['okr'] }).custom
    expect(c.panels).toEqual([])
    expect(c.layout.hidden).toBeUndefined()
    expect(c.layout.sections?.today).toEqual(['decide'])
  })

  it('存取、撤销、恢复默认', () => {
    const dir = tmp()
    const commits: string[] = []
    const store = new CustomStore(dir, m => { commits.push(m) })
    expect(store.canUndo()).toBe(false)
    store.update({ theme: { accent: '#111111' } })
    store.update({ theme: { accent: '#222222' } })
    expect(store.get().theme.accent).toBe('#222222')
    expect(store.undo()?.theme.accent).toBe('#111111')
    expect(store.undo()?.theme.accent).toBeUndefined()
    expect(store.undo()).toBeUndefined()
    store.update({ layout: { hidden: ['events'] } })
    expect(store.reset().layout).toEqual({})
    expect(store.undo()?.layout.hidden).toEqual(['events'])
    expect(commits.length).toBe(7)
    writeFileSync(join(dir, 'ui', 'custom.json'), '{"theme":{"accent":"javascript:alert(1)"}}')
    expect(store.get().theme).toEqual({})
  })
})

describe('接口挂载方式', () => {
  const fakeReq = (method: string, url: string, headers: Record<string, string> = {}, body = '') => {
    const chunks = body ? [Buffer.from(body)] : []
    return Object.assign((async function* () { yield* chunks })(), { method, url, headers }) as unknown as IncomingMessage
  }
  const fakeRes = () => {
    const out = { status: 0, body: '' }
    const res = { headersSent: false, writeHead(s: number) { out.status = s; return res }, end(b: string) { out.body = b } } as unknown as ServerResponse
    return { res, out }
  }
  const echo: Route = async ({ path, via }, res) => { res.writeHead(200); res.end(JSON.stringify({ path, via })); return true }

  it('手机端口拿不到设置类接口', async () => {
    for (const path of ['/setup', '/settings', '/settings/password', '/settings/brain']) {
      const { res, out } = fakeRes()
      await serveApi(fakeReq('GET', `/chief/api${path}`), res, 'public', [echo])
      expect(out.status, path).toBe(403)
    }
    const { res, out } = fakeRes()
    await serveApi(fakeReq('GET', '/chief/api/state'), res, 'public', [echo])
    expect(JSON.parse(out.body)).toEqual({ path: '/state', via: 'public' })
  })

  it('写操作要带请求标记', async () => {
    const a = fakeRes()
    await serveApi(fakeReq('POST', '/chief/api/chat', {}, '{}'), a.res, 'dsh', [echo])
    expect(a.out.status).toBe(403)
    const b = fakeRes()
    await serveApi(fakeReq('POST', '/chief/api/chat', { 'x-chief-request': '1' }, '{"text":"hi"}'), b.res, 'dsh', [echo])
    expect(b.out.status).toBe(200)
  })

  it('导出核对主人与当前脑，旧助手导入接口已退役', async () => {
    const exports: string[] = []
    const route = runtimeRoutes({
      superhub: { route: async () => false, checkScope(value: unknown) {
        if (value !== 'my-brain') throw Object.assign(Error('资料归属已变'), {status:409})
      } },
      exporter: { build: (target: string) => { exports.push(target); return {target,parts:[]} } },
    } as unknown as Parameters<typeof runtimeRoutes>[0])
    const send = async (path: string, owner: boolean, body?: object) => {
      const { res, out } = fakeRes()
      await serveApi(fakeReq(body ? 'POST' : 'GET','/chief/api' + path,{'x-chief-request':'1'},body ? JSON.stringify(body) : ''),res,'dsh',[route],owner)
      return out.status
    }
    const data = {text:'之前的助手资料',source:'Claude',requestId:'paste-1'}
    expect(await send('/export?for=claude&scope=my-brain',false)).toBe(403)
    expect(await send('/export?for=claude&scope=other',true)).toBe(409)
    expect(await send('/import?scope=my-brain',true,data)).toBe(404)
    expect(await send('/export?for=claude&scope=my-brain',true)).toBe(200)
    expect(exports).toEqual(['claude'])
  })
})

describe('手机访问', () => {
  it('会话与锁定', () => {
    let now = 1_000_000
    const gate = new Gatekeeper(tmp(), () => now)
    const token = gate.open('test')
    expect(gate.session(token)).toBeTruthy()
    expect(gate.session('x'.repeat(43))).toBeUndefined()
    for (let i = 0; i < 5; i++) gate.fail('1.2.3.4')
    expect(gate.locked('1.2.3.4')).toBe(15)
    expect(gate.locked('5.6.7.8')).toBe(0)
    now += 16 * 60_000
    expect(gate.locked('1.2.3.4')).toBe(0)
    now += 31 * 86_400_000
    expect(gate.session(token)).toBeUndefined()
  })

  it('沿用旧网关的会话文件格式（迁移后手机不掉登录）', () => {
    const dir = tmp()
    const gate = new Gatekeeper(dir)
    const token = gate.open('phone')
    const again = new Gatekeeper(dir)
    expect(again.session(token)).toBeTruthy()
    revokeSessions(dir) // 端口没开着时换密码
    expect(new Gatekeeper(dir).session(token)).toBeUndefined()
  })

  it('并发登录：尝试先计数，成功再撤回', () => {
    const gate = new Gatekeeper(tmp())
    for (let i = 0; i < 5; i++) gate.attempt('9.9.9.9') // 五个请求同时进来，都还没校验完
    expect(gate.locked('9.9.9.9')).toBeGreaterThan(0)
    const other = new Gatekeeper(tmp())
    other.attempt('1.1.1.1'); other.succeed('1.1.1.1')
    expect(other.locked('1.1.1.1')).toBe(0)
  })

  it('登录后才能调接口；没设密码时提示去设置', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'static'))
    for (const f of ['index.html', 'app.js', 'page.css', 'icon.svg', 'manifest.webmanifest']) writeFileSync(join(dir, 'static', f), f)
    let hash: string | undefined
    const calls: string[] = []
    const server = await startMobileServer({
      port: 0, host: '127.0.0.1', passwordHash: () => hash, stateDir: dir, staticDir: join(dir, 'static'), log: () => {},
      api: async (req, res) => { calls.push(req.url ?? ''); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') },
    })
    const call = (method: string, path: string, body?: string, cookie?: string) => new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, method, path, headers: { ...body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}, ...cookie ? { cookie } : {} } }, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, ...res.headers['set-cookie'] ? { cookie: res.headers['set-cookie'][0]!.split(';')[0]! } : {} }))
      })
      req.on('error', reject)
      req.end(body)
    })
    try {
      expect((await call('GET', '/')).status).toBe(503)
      hash = hashPassword('a good password')
      expect((await call('GET', '/chief/api/state')).status).toBe(401)
      expect((await call('POST', '/login', 'password=wrong')).status).toBe(401)
      const ok = await call('POST', '/login', `password=${encodeURIComponent('a good password')}`)
      expect(ok.status).toBe(303)
      expect(ok.cookie).toMatch(/^chief_gw=/)
      expect((await call('GET', '/chief/api/state', undefined, ok.cookie)).status).toBe(200)
      expect((await call('GET', '/app.js', undefined, ok.cookie)).body).toBe('app.js')
      expect((await call('GET', '/etc/passwd', undefined, ok.cookie)).status).toBe(404)
      expect(calls).toEqual(['/chief/api/state'])
    } finally { await server.close() }
  })
})

describe('执行者回退', () => {
  it('claude-code 没装时用 spawn，装了用自己', async () => {
    const { DshExecutors } = await import('../src/dsh/executors.ts')
    const providers = new Map<string, { capabilities: { outputSchema: boolean; agentOptions: boolean } }>([['spawn', { capabilities: { outputSchema: true, agentOptions: true } }]])
    const warnings: string[] = []
    const ctx = { subagents: { getProvider: (n: string) => providers.get(n), list: () => [...providers.keys()] }, logger: { warn: (f: string, n: string) => warnings.push(n), info() {}, error() {} } } as never
    const ex = new DshExecutors(ctx, async () => ({ id: 'x' }))
    expect(ex.available('claude-code')).toBe(true)
    expect(ex.supportsSchema('claude-code')).toBe(true)
    expect(ex.available('nope')).toBe(false)
    ex.available('claude-code')
    expect(warnings).toEqual(['claude-code'])
    providers.set('claude-code', { capabilities: { outputSchema: false, agentOptions: false } })
    expect(ex.supportsSchema('claude-code')).toBe(false)
  })
})

describe('工单桌：工单目录里的执行只能写本工单目录', () => {
  const hqAgent = (mode: string, approvalOverride?: string) => ({ id: 'chief-liaison', session: { snapshotEvents: () => [], mode, approvalOverride },
    model: { current: () => ({ provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'high' }), select() {} }, ctx: { name: 'hq-scope' } })
  const host = (hq: ReturnType<typeof hqAgent>) => {
    const created: { sessionId: string; meta: Record<string, unknown> }[] = [], appended: unknown[][] = [], policies: string[] = [], composed: unknown[][] = []
    let disposed = 0
    const ctx = {
      agents: { get: (id: string) => id === 'chief-liaison' ? { session: { header: { agentPreset: 'standard' } } } : undefined, create: async ({ setup, ...options }: { sessionId: string; meta: Record<string, unknown>; setup(scope: unknown): void }) => {
        created.push(options)
        const scope = { get: (name: string) => name === 'agentPresets' ? { composeFrom: (...row: unknown[]) => { composed.push(row); return 'standard' } } : undefined }
        setup(scope)
        return { agent: { id: options.sessionId, session: { snapshotEvents: () => [], append: (...row: unknown[]) => { appended.push(row) } } }, dispose: async () => { disposed++ } }
      } },
      get: (name: string) => name === 'sandboxPolicy' ? { resolve: ({ session }: { session: { mode: string } }) => ({ mode: session.mode }) }
        : name === 'approval' ? { config: { policy: 'ask' }, overrideOf: (session: { approvalOverride?: string }) => session.approvalOverride, setPolicy: (_agent: unknown, policy: string) => { policies.push(policy) } } : undefined,
      logger: { warn() {}, info() {}, error() {} },
    }
    return { ctx, created, appended, policies, composed, disposed: () => disposed }
  }

  it('只认 work/<工单> 本身；桌的会话 cwd 是工单目录，记为接口人的子会话，沙箱钉在工作区写入', async () => {
    const { ticketDesk } = await import('../src/dsh/executors.ts')
    const brain = join(tmp(), 'brain'), work = join(brain, 'work', 'T-0007')
    mkdirSync(work, { recursive: true })
    const f = host(hqAgent('danger-full-access'))
    const desk = ticketDesk(f.ctx as never, join(brain, 'work'), async () => hqAgent('danger-full-access') as never)
    expect([work, join(brain, 'work'), join(work, 'sub'), join(brain, 'people'), join(brain, 'work', 'notes')].map(desk.owns)).toEqual([true, false, false, false, false])
    const lease = await desk.open(work)
    expect(f.created).toEqual([{ sessionId: lease.agent.id, meta: { cwd: realpathSync(work), parentSession: 'chief-liaison', origin: 'subagent', delegationDepth: 0, agentPreset: 'standard' },
      agentOptions: { provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'high' } }])
    expect(lease.agent.id).toMatch(/^chief-desk-/)
    expect(f.appended).toEqual([['sandbox/mode', { mode: 'workspace-write' }]])
    expect(f.policies).toEqual([])
    // 桌接上接口人的工具组合，执行者才有 read/write/bash
    expect(f.composed).toEqual([[expect.objectContaining({ get: expect.any(Function) }), { name: 'hq-scope' }]])
    await lease.release()
    expect(f.disposed()).toBe(1)
  })

  it('接口人会话只读或不许审批时，桌保持同样的限制', async () => {
    const { ticketDesk } = await import('../src/dsh/executors.ts')
    const work = join(tmp(), 'work', 'T-0001')
    mkdirSync(work, { recursive: true })
    const hq = hqAgent('read-only', 'never'), f = host(hq)
    await ticketDesk(f.ctx as never, dirname(work), async () => hq as never).open(work)
    expect(f.appended).toEqual([['sandbox/mode', { mode: 'read-only' }]])
    expect(f.policies).toEqual(['never'])
  })

  it('执行器用桌作父会话，执行结束、启动失败都释放桌', async () => {
    const { DshExecutors } = await import('../src/dsh/executors.ts')
    const parents: string[] = []
    let released = 0, fail = false
    const ctx = {
      subagents: {
        getProvider: () => ({ capabilities: { outputSchema: false, agentOptions: false } }),
        startActivation: async (spec: { request: { parent: { id: string } } }) => {
          parents.push(spec.request.parent.id)
          if (fail) throw new Error('启动失败')
          return { childId: 'child', result: Promise.resolve({ output: [{ type: 'text', text: '汇报' }], stopReason: 'completed' }), dispose: async () => {} }
        },
      },
      get: () => undefined,
      logger: { warn() {}, info() {}, error() {} },
    }
    const ex = new DshExecutors(ctx as never, async () => ({ agent: { id: 'desk' }, release: async () => { released++ } }) as never)
    const run = () => ex.run({ staff: { id: 'researcher', name: '研究员', executor: 'dsh', verifier: 'none', brief: '' }, label: 'T-0001', prompt: '查', cwd: '/tmp' }, new AbortController().signal)
    expect((await run()).text).toBe('汇报')
    expect(released).toBe(1)
    fail = true
    await expect(run()).rejects.toThrow('启动失败')
    expect(parents).toEqual(['desk', 'desk'])
    expect(released).toBe(2)
  })
})

describe('导入', () => {
  it('新建的第二大脑有 me.md；老的第二大脑启动时补上，不覆盖', async () => {
    const { ensureTemplateFiles } = await import('../src/dsh/scaffold.ts')
    const dir = join(tmp(), 'brain')
    scaffoldBrain(dir)
    expect(existsSync(join(dir, 'me.md'))).toBe(true)
    expect(new BrainRepo(dir).constitution()).toContain('### me.md')
    writeFileSync(join(dir, 'me.md'), '我自己写的')
    expect(ensureTemplateFiles(dir)).toEqual([])
    expect(readFileSync(join(dir, 'me.md'), 'utf8')).toBe('我自己写的')
    execFileSync('rm', [join(dir, 'me.md')])
    expect(ensureTemplateFiles(dir)).toEqual(['me.md'])
  })

  it('助手导入提示词要求事实、来源和保密标记', async () => {
    const { IMPORT_PROMPT } = await import('../src/core/onboarding.ts')
    for (const s of ['不要猜', '[记忆]', '[推断]', '[机密]', '## 我是谁', '## 常打交道的人']) expect(IMPORT_PROMPT).toContain(s)
  })
})

describe('导出', () => {
  it('模板状态下是空的：占位行和说明都不算内容', async () => {
    const { buildExport } = await import('../src/core/export.ts')
    const t = templatesDir()
    const docs = { me: readFileSync(join(t, 'brain', 'me.md'), 'utf8'), agents: readFileSync(join(t, 'brain', 'AGENTS.md'), 'utf8'), goals: readFileSync(join(t, 'brain', 'goals.md'), 'utf8') }
    const r = buildExport('chatgpt', { me: docs.me }, '2026-11-16')
    expect(r.empty).toBe(true)
    // 整份模板也算空：AGENTS.md 里只有模板自带的通用原则，不是主人本人的事实
    expect(buildExport('session', docs, '2026-11-16').empty).toBe(true)
  })

  it('只导出确认过的内容；各目标格式；区块可以反复写入', async () => {
    const { buildExport, upsertBlock, BLOCK_END } = await import('../src/core/export.ts')
    const docs = {
      me: '# 关于我\n> 说明\n## 身份与背景\n- 即将入职字节，岗位 POC\n- （例：占位）\n- 负责未公开的项目，3 月灰度 [对话 2026-11][机密]\n## 偏好\n- 中文，结论先行\n',
      agents: '# 宪法\n## 我是谁\n- 不该导出这一节\n## 我希望幕僚团怎样帮我\n- 少打扰\n## 隐私边界\n- 不该导出\n',
      goals: '# 目标\n## 第 1 个月\n- [ ] 画出团队地图\n- [x] 已完成的不导出\n## 第 2 个月\n- [ ] （待定：…）\n',
    }
    const gpt = buildExport('chatgpt', docs, '2026-11-16')
    expect(gpt.parts.length).toBe(2)
    const text = gpt.parts.map(p => p.text).join('\n')
    for (const s of ['即将入职字节', '中文，结论先行', '画出团队地图', '少打扰']) expect(text).toContain(s)
    for (const s of ['占位', '不该导出', '已完成的不导出', '待定', '说明', '灰度', '机密']) expect(text).not.toContain(s)
    const md = buildExport('agents-md', docs, '2026-11-16').parts[0]!.text
    const once = upsertBlock('# 我自己的说明\n', md)
    expect(once.startsWith('# 我自己的说明')).toBe(true)
    const twice = upsertBlock(once, md.replace('少打扰', '更少打扰'))
    expect(twice.split(BLOCK_END).length).toBe(2)
    expect(twice).toContain('更少打扰')
    expect(twice).toContain('# 我自己的说明')
  })
})
