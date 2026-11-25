/**
 * SuperHub：基于 DeepSeek Harness 的个人 AI 工作空间。
 *
 * 这里只做装配：
 *   - 机器私有的配置在 $DSH_HOME/chief/config.json（src/dsh/settings.ts）；
 *   - 还没选第二大脑时停在"待初始化"，作战台显示开场白，主人选好位置后建好目录（src/dsh/scaffold.ts）；
 *   - 第二大脑就绪后创建运行时（src/dsh/runtime.ts）；换第二大脑、时区、并发数时拆了重建，不重启 DSH；
 *   - 作战台接口挂在 DSH 网页服务下，手机访问端口按设置开关（src/dsh/mobile-server.ts）。
 * 设计见 docs/DESIGN.md。
 */
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_PREFIX, json, serveApi, type ApiCall, type Route } from './dsh/http.ts'
import { revokeSessions, sendMobileFile, startMobileServer, type MobileServer } from './dsh/mobile-server.ts'
import type { HostContext } from './dsh/ports.ts'
import { createRuntime, type Runtime } from './dsh/runtime.ts'
import { canonicalSelection } from './dsh/models.ts'
import { classify, devCheckout, hasGit, resolveBrainDir, scaffoldBrain, SUGGESTED_BRAIN } from './dsh/scaffold.ts'
import { chiefHomeOf, expandHome, hashPassword, publicSettings, SettingsStore, type Settings, type SettingsPatch } from './dsh/settings.ts'
import type { ChiefControl } from './dsh/tools.ts'
import type { CodexApprovalConfig } from './dsh/codex-approvals.ts'

export const name = 'dsh-chief'
export const inject = ['agents', 'subagents', 'sessionController', 'workspaceRegistry', 'webServer', 'tools']

export interface Config {
  /** 插件私有目录，缺省 $DSH_HOME/chief。一般不用改。 */
  home?: string
  /** 旧版本的配置项：第一次启动时如果还没选第二大脑，就用它。之后以 config.json 为准。 */
  brain?: string
  concurrency?: number
  timeZone?: string
  /** Choose an installed Codex CLI for per-command approvals on formal tickets. */
  codex?: CodexApprovalConfig
  /** Minutes before an unanswered command approval expires (1 to 1440, default 30). */
  approvalTimeoutMinutes?: number
}

/**
 * 接口人会话的 id 按第二大脑的路径算：会话的工作区创建后不能改，子代理的文件沙箱又跟着它走，
 * 所以每个第二大脑一个会话。配置里记录过的（例如从旧版本迁移来的）照旧沿用。
 */
const liaisonIdOf = (root: string) => `chief-liaison-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`

export async function apply(ctx: HostContext, config: Config = {}): Promise<void> {
  const chiefHome = chiefHomeOf(config.home)
  const settings = new SettingsStore(chiefHome)
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const dev = devCheckout(pluginRoot)
  const profile = (ctx as unknown as { get(name: string): { patchPath?: string } | undefined }).get('profileContext')
  const log = (message: string) => ctx.logger.info('%s', message)
  const warn = (message: string) => ctx.logger.warn('%s', message)

  // 旧版本把第二大脑写在 profile 的配置里：第一次启动时搬进 config.json
  if (!settings.get().brain && config.brain) {
    const dir = resolve(expandHome(config.brain))
    if (classify(dir) === 'brain') settings.update({ brain: dir, ...config.timeZone ? { timeZone: config.timeZone } : {}, ...config.concurrency ? { concurrency: config.concurrency } : {} })
  }

  // ───────────── 运行时的建与拆 ─────────────
  let runtime: Runtime | undefined
  let problem: string | undefined
  let disposed = false
  /** 所有建拆操作排成一队，避免两次设置修改同时重建。 */
  let queue: Promise<void> = Promise.resolve()
  const serial = (fn: () => Promise<void>) => { const next = queue.then(fn, fn); queue = next.catch(() => undefined); return next }

  const liaisonFor = (root: string): string => {
    const s = settings.get()
    if (s.liaison?.brain === root) return s.liaison.session
    const session = liaisonIdOf(root)
    settings.update({ liaison: { session, brain: root } })
    return session
  }

  const stop = async () => {
    const current = runtime
    runtime = undefined
    if (current) await current.dispose().catch(e => warn(`停止幕僚团时出错：${String(e)}`))
  }
  const start = async () => {
    const root = settings.get().brain
    if (!root || disposed || runtime) return
    try {
      runtime = await createRuntime(ctx, { root, settings, chiefHome, pluginRoot, dev, ...profile?.patchPath ? { patchPath: profile.patchPath } : {}, liaisonSession: liaisonFor(root), control, codex: config.codex, approvalTimeoutMinutes: config.approvalTimeoutMinutes })
      problem = undefined
    } catch (error) {
      problem = (error as Error).message
      warn(`幕僚团没有启动：${problem}`)
    }
  }
  const restart = () => serial(async () => { await stop(); await start() })

  // ───────────── 手机访问端口 ─────────────
  let mobile: MobileServer | undefined
  /** 当前端口按什么设置开的：端口或监听地址变了要重开。 */
  let mobileAt = ''
  let mobileProblem: string | undefined
  const mobileApi = (req: IncomingMessage, res: ServerResponse) => serveApi(req, res, 'public', routes())
  const syncMobile = () => serial(async () => {
    const m = settings.get().mobile
    const want = m.enabled && !disposed
    if (mobile && (!want || mobileAt !== `${m.host}:${m.port}`)) { await mobile.close(); mobile = undefined }
    if (!want) mobileProblem = undefined
    if (want && !mobile) {
      try {
        mobileAt = `${m.host}:${m.port}`
        mobile = await startMobileServer({ port: m.port, host: m.host, passwordHash: () => settings.get().mobile.passwordHash, stateDir: chiefHome, staticDir: join(pluginRoot, 'lib', 'mobile'), api: mobileApi, log })
        mobileProblem = undefined
        log(`手机访问已开启：http://${m.host}:${m.port}`)
      } catch (error) {
        mobileProblem = `手机访问端口 ${m.port} 打不开：${(error as Error).message}`
        warn(mobileProblem)
      }
    }
  })
  const lanAddresses = (): string[] => {
    // 容器可能允许服务监听，但不允许枚举网卡。地址提示缺失时仍能查看或修改设置。
    try { return Object.values(networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n!.address) }
    catch { return [] }
  }

  // ───────────── 设置 ─────────────
  /** full：电脑上的设置页要编辑推送地址，给完整的；给模型的只有脱敏版本。 */
  const showSettings = (full = false) => {
    const s = settings.get()
    const pub = publicSettings(s)
    return {
      ...pub, ...full && runtime ? { liaisonTools: runtime.liaisonToolStatus() } : {}, ...full && s.notifyUrl ? { notifyUrl: s.notifyUrl } : {}, dev, git: hasGit(),
      mobile: { ...pub.mobile, running: Boolean(mobile), ...mobileProblem ? { problem: mobileProblem } : {}, addresses: s.mobile.enabled ? (s.mobile.host === '127.0.0.1' ? ['127.0.0.1'] : lanAddresses()).map(ip => `http://${ip}:${s.mobile.port}`) : [] },
    }
  }
  /**
   * 接口人的模型和思考深度：模型在 DSH 的模型目录里找到，存成 provider/model，空串表示跟随默认；
   * 档位必须是该模型支持的，换了模型又没给档位时回到模型默认。与已存值相同的原样保留（可能已不在目录里）。
   */
  const resolveLiaison = async (patch: { model?: string; effort?: string }): Promise<SettingsPatch> => {
    if (patch.model === undefined && patch.effort === undefined) return {}
    const s = settings.get()
    const next = await canonicalSelection(ctx.get('llm'), patch, { model: s.liaisonModel, effort: s.liaisonReasoningEffort })
    return { liaisonModel: next.model, liaisonReasoningEffort: next.effort }
  }
  const control: ChiefControl = {
    show: showSettings,
    update: async patch => {
      const before = settings.get()
      const liaison = await resolveLiaison({ model: patch.liaisonModel, effort: patch.liaisonReasoningEffort })
      const next: SettingsPatch = {
        ...liaison,
        ...patch.timeZone !== undefined ? { timeZone: patch.timeZone } : {},
        ...patch.concurrency !== undefined ? { concurrency: patch.concurrency } : {},
        ...patch.notifyUrl !== undefined ? { notifyUrl: patch.notifyUrl } : {},
        ...patch.mobileEnabled !== undefined || patch.mobilePort !== undefined ? { mobile: { ...patch.mobileEnabled !== undefined ? { enabled: patch.mobileEnabled } : {}, ...patch.mobilePort !== undefined ? { port: patch.mobilePort } : {} } } : {},
      }
      const s = settings.update(next)
      const said: string[] = []
      if (patch.timeZone !== undefined) said.push(`时区改为 ${s.timeZone}`)
      if (patch.concurrency !== undefined) said.push(`同时最多 ${s.concurrency} 位幕僚干活`)
      if (patch.notifyUrl !== undefined) said.push(s.notifyUrl ? '推送地址已更新' : '不再推送，提醒只在作战台显示')
      if (patch.mobileEnabled !== undefined || patch.mobilePort !== undefined) {
        await queue
        said.push(s.mobile.enabled ? `手机访问已开启，端口 ${s.mobile.port}${s.mobile.passwordHash ? '' : '。还没设密码：请主人在作战台的"设置"里设置'}${mobileProblem ? `。但是${mobileProblem}` : ''}` : '手机访问已关闭')
      }
      if (liaison.liaisonModel !== undefined) {
        const effort = s.liaisonReasoningEffort ? `，思考深度 ${s.liaisonReasoningEffort}` : before.liaisonReasoningEffort && patch.liaisonReasoningEffort === undefined && s.liaisonModel ? '，思考深度回到模型默认（原档位不一定适用于新模型）' : s.liaisonModel ? '，思考深度用模型默认' : ''
        said.push(s.liaisonModel ? `接口人改用 ${s.liaisonModel}${effort}，下一句话起生效（幕僚各自的模型不受影响）` : '接口人改回跟随 DSH 的默认模型和思考深度')
      }
      if (patch.timeZone !== undefined || patch.concurrency !== undefined) said.push('幕僚团已按新设置重启（几秒钟）')
      return `${said.join('；')}。`
    },
  }
  settings.onChange((next, prev) => {
    if (next.brain !== prev.brain || next.timeZone !== prev.timeZone || next.concurrency !== prev.concurrency) void restart()
    if (next.mobile.enabled !== prev.mobile.enabled || next.mobile.port !== prev.mobile.port || next.mobile.host !== prev.mobile.host) void syncMobile()
    // 换密码：所有手机重新登录。端口没开着也要清掉会话文件，否则再开启时旧登录还有效
    if (next.mobile.passwordHash !== prev.mobile.passwordHash) { if (mobile) mobile.revokeAll(); else revokeSessions(chiefHome) }
  })

  // ───────────── 接口 ─────────────
  /** 选定（或更换）第二大脑：建好目录，写进配置，等运行时起来。 */
  const chooseBrain = async (input: string) => {
    const dir = resolveBrainDir(input)
    const result = scaffoldBrain(dir)
    settings.update({ brain: dir })
    await queue
    // 同一个目录再试一次（上次启动失败）：设置没变不会触发重启，这里补一次
    if (!runtime) await restart()
    if (!runtime) throw new Error(problem ?? '幕僚团没有启动')
    return { dir, kind: result.kind, git: result.git, added: result.added.length }
  }

  const controlRoute: Route = async ({ method, path, body, owner, via, url }: ApiCall, res) => {
    const requestedScope = url.searchParams.get('scope')
    const stale = () => !runtime || requestedScope !== runtime.scope || runtime.root !== settings.get().brain
    const changedScope = () => json(res, 409, { error:'第二大脑已切换，请重新打开设置。' })
    if (method === 'GET' && path === '/v2/bootstrap') {
      if (!owner) return json(res, 403, { error: '请使用主人的 DSH 连接打开工作区' }), true
      const configure = via === 'dsh'
      const build = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev'
      if (runtime) return json(res, 200, { scope: runtime.scope, configure, build }), true
      if (!configure) return json(res, 200, { needsDesktopSetup: true }), true
      return json(res, 200, { setup: { suggested: SUGGESTED_BRAIN, git: hasGit(), ...problem ? { problem } : {} } }), true
    }
    if (path === '/v2/settings') {
      if (!owner) return json(res, 403, { error:'请用主人的连接查看设置。' }), true
      if (method !== 'GET') return json(res, 405, { error:'当前设置页只提供读取。' }), true
      if (!runtime || stale()) return changedScope(), true
      const s = settings.get()
      const activeModel = runtime.settingsLiaisonModel()
      return json(res, 200, { scope:runtime.scope, timeZone:s.timeZone, concurrency:s.concurrency,
        ...(activeModel && {activeModel}),
        ...(via === 'dsh' && {admin:{settings:showSettings(true), staff:runtime.settingsStaff()}}) }), true
    }
    if (path === '/settings' || path.startsWith('/settings/')) {
      if (!owner || via !== 'dsh') return json(res, 403, { error:'请在主人的 DSH 中管理设置。' }), true
      if (requestedScope !== null && stale()) return changedScope(), true
    }
    if (method === 'GET' && path === '/state') {
      // 状态里不带设置：手机端口也能拿 /state，设置只经 /settings（手机端口拿不到）。
      // 待审批命令同 /settings/approvals：只在电脑上的 DSH 里列出和处理。
      if (runtime) return json(res, 200, runtime.state(owner === true, owner === true && via === 'dsh')), true
      return json(res, 200, { setup: { suggested: SUGGESTED_BRAIN, git: hasGit(), ...problem ? { problem } : {} } }), true
    }
    if (method === 'GET' && path === '/settings') return json(res, 200, showSettings(true)), true
    if (method !== 'POST') return false
    if (path === '/setup' || path === '/settings/brain') {
      if (path === '/setup' && runtime) return json(res, 409, { error: '已经初始化过了；要换位置请到设置里改' }), true
      const dir = typeof body.dir === 'string' ? body.dir : ''
      return json(res, 200, { ok: true, ...await chooseBrain(dir) }), true
    }
    if (path === '/settings') {
      const m = (body.mobile && typeof body.mobile === 'object' ? body.mobile : {}) as Record<string, unknown>
      // 下拉框里保留的旧值（可能已不在目录里）原样存回，不因改别的设置而报错
      const liaison = await resolveLiaison({ ...typeof body.liaisonModel === 'string' ? { model: body.liaisonModel } : {}, ...typeof body.liaisonReasoningEffort === 'string' ? { effort: body.liaisonReasoningEffort } : {} })
      if (requestedScope !== null && stale()) return changedScope(), true
      settings.update({
        ...liaison,
        ...typeof body.timeZone === 'string' ? { timeZone: body.timeZone } : {},
        ...typeof body.concurrency === 'number' ? { concurrency: body.concurrency } : {},
        ...typeof body.notifyUrl === 'string' ? { notifyUrl: body.notifyUrl.trim() } : {},
        mobile: { ...typeof m.enabled === 'boolean' ? { enabled: m.enabled } : {}, ...typeof m.port === 'number' ? { port: m.port } : {}, ...m.host === '127.0.0.1' || m.host === '0.0.0.0' ? { host: m.host } : {} },
      })
      await queue
      if (requestedScope !== null && stale()) return changedScope(), true
      return json(res, 200, { ok: true, settings: showSettings(true) }), true
    }
    if (path === '/settings/password') {
      const password = typeof body.password === 'string' ? body.password : ''
      settings.update({ mobile: { passwordHash: hashPassword(password) } })
      return json(res, 200, { ok: true }), true
    }
    return false
  }
  /** 第二大脑还没就绪时，其余接口统一回一句话。 */
  const notReady: Route = async (_call, res) => { json(res, 409, { error: problem ?? '还没有选第二大脑的位置' }); return true }
  const routes = (): Route[] => [controlRoute, runtime ? runtime.routes : notReady]

  const unregister = ctx.webServer.register({
    kind: 'prefix', path: API_PREFIX,
    handler: async (req, res) => {
      const connection = ctx.get('connection')
      const rejection = connection ? connection.requestRejection(req) : 503
      if (rejection) { json(res, rejection, { error: rejection === 401 ? '未登录' : '拒绝访问' }); return }
      let path: string
      try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname).replace(/\/+$/, '') }
      catch { json(res, 400, { error: '无效的请求路径' }); return }
      const admission = connection?.admit?.(req)
      const owner = !!admission && 'peer' in admission && admission.peer.principal.kind === 'owner' && admission.peer.interactions === 'answer'
      if (!owner && (path === `${API_PREFIX}/settings/approvals` || /^\/chief\/api\/(?:tickets\/T-\d+\/execution-plan$|(?:superhub|v2)(?:\/|$))/.test(path))) {
        json(res, 403, { error: '此操作需要 DSH 主人权限' }); return
      }
      await serveApi(req, res, 'dsh', routes(), owner)
    },
  })

  /** 不带 DSH 外壳的作战台（已登录 DSH 的浏览器打开 /chief/m/），和手机访问端口是同一个页面。 */
  const unregisterPage = ctx.webServer.register({
    kind: 'prefix', path: '/chief/m',
    handler: async (req, res) => {
      const connection = ctx.get('connection')
      const rejection = connection ? connection.requestRejection(req) : 503
      if (rejection) { res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' }); res.end(rejection === 401 ? '请先在这个浏览器里登录 DSH' : '拒绝访问'); return }
      const path = new URL(req.url ?? '/', 'http://local').pathname
      if (path === '/chief/m') { res.writeHead(308, { location: '/chief/m/' }); res.end(); return }
      try {
        if (req.method !== 'GET' || !sendMobileFile(res, join(pluginRoot, 'lib', 'mobile'), path.slice('/chief/m/'.length))) { res.writeHead(404); res.end() }
      } catch (error) {
        warn(`手机页面出错：${(error as Error).message}`)
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('手机页面打不开（插件构建不完整？）') }
      }
    },
  })

  ctx.effect(() => async () => {
    disposed = true
    unregister()
    unregisterPage()
    await serial(async () => {
      if (mobile) { await mobile.close(); mobile = undefined }
      await stop()
    })
  })

  await serial(start)
  await syncMobile()
  confirmDeploy(chiefHome)
  if (!settings.get().brain) log('SuperHub 已加载。请从左侧栏打开「SuperHub」，选择第二大脑目录。')
}

/**
 * 开发模式部署的确认：部署脚本先写 deploy-pending.json 再触发热重载，
 * 新的插件实例启动时发现自己就是那次构建，写下确认，脚本据此判断已生效。
 */
function confirmDeploy(chiefHome: string) {
  if (typeof __BUILD__ !== 'string') return
  try {
    const pending = JSON.parse(readFileSync(join(chiefHome, 'deploy-pending.json'), 'utf8')) as { id?: string }
    if (pending.id !== __BUILD__) return
    writeFileSync(join(chiefHome, 'deploy-confirmed.json'), JSON.stringify({ id: pending.id, at: new Date().toISOString() }))
    rmSync(join(chiefHome, 'deploy-pending.json'), { force: true })
  } catch { /* 没有待确认的部署 */ }
}

export type { Settings }
