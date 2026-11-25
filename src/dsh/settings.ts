/**
 * 机器私有的配置：$DSH_HOME/chief/config.json（目录 700，文件 600）。
 *
 * 和第二大脑分开放：用户可能把第二大脑推到远端仓库，密码哈希、推送地址这类东西不能跟着走。
 * 所有字段都可以缺省；读到坏文件时按缺省处理并保留原文件改名备份，不让插件起不来。
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface MobileSettings {
  /** 是否开启公网密码访问（插件自己开的端口）。 */
  enabled: boolean
  port: number
  /** 监听地址：0.0.0.0 允许公网，127.0.0.1 只给本机（例如前面有反向代理）。 */
  host: string
  /** scrypt$<盐 hex>$<哈希 hex>；没设密码时手机访问不会真正打开。 */
  passwordHash?: string
}

export interface Settings {
  /** 第二大脑的绝对路径；没有时插件停在"待初始化"。 */
  brain?: string
  timeZone: string
  concurrency: number
  /** 推送地址（POST JSON {text}）；没有时提醒只出现在作战台。 */
  notifyUrl?: string
  mobile: MobileSettings
  /**
   * 接口人会话与它绑定的第二大脑：换第二大脑时要换会话（会话的工作区不能改）。
   * session 是当前这一段；对话太长换段后，之前的段记在 parts 里（仍算接口人自己），base 是第一段的 id。
   */
  liaison?: LiaisonBinding
  /** 接口人用的模型，写法 provider/model；不设时跟随 DSH 的默认模型。 */
  liaisonModel?: string
  /** 接口人的思考深度（所选模型 reasoning.efforts 里的 id）；不设时用模型默认。只在指定了模型时有效。 */
  liaisonReasoningEffort?: string
}

export interface LiaisonBinding { session: string; brain: string; base?: string; parts?: string[] }

export const DEFAULT_PORT = 50388
export const systemTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' } }

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true } catch { return false }
}

export const expandHome = (p: string) => p === '~' ? homedir() : /^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p

/** 插件私有目录：配置项 home > $DSH_HOME/chief > ~/.dsh/chief。 */
export function chiefHomeOf(configured?: string): string {
  if (configured?.trim()) return resolve(expandHome(configured.trim()))
  const dshHome = process.env.DSH_HOME?.trim() ? resolve(expandHome(process.env.DSH_HOME.trim())) : join(homedir(), '.dsh')
  return join(dshHome, 'chief')
}

function normalize(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const m = (r.mobile && typeof r.mobile === 'object' ? r.mobile : {}) as Record<string, unknown>
  const port = Number(m.port)
  const conc = Number(r.concurrency)
  const zone = typeof r.timeZone === 'string' && validTimeZone(r.timeZone) ? r.timeZone : systemTimeZone()
  const liaison = r.liaison as { session?: unknown; brain?: unknown; base?: unknown; parts?: unknown } | undefined
  const parts = Array.isArray(liaison?.parts) ? liaison.parts.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(-50) : []
  return {
    ...typeof r.brain === 'string' && r.brain ? { brain: r.brain } : {},
    timeZone: zone,
    concurrency: Number.isInteger(conc) && conc >= 1 && conc <= 6 ? conc : 2,
    ...typeof r.notifyUrl === 'string' && /^https?:\/\//.test(r.notifyUrl) ? { notifyUrl: r.notifyUrl } : {},
    mobile: {
      enabled: m.enabled === true,
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
      host: m.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
      ...typeof m.passwordHash === 'string' && m.passwordHash.startsWith('scrypt$') ? { passwordHash: m.passwordHash } : {},
    },
    ...liaison && typeof liaison.session === 'string' && typeof liaison.brain === 'string' ? { liaison: {
      session: liaison.session, brain: liaison.brain,
      ...typeof liaison.base === 'string' && liaison.base ? { base: liaison.base } : {},
      ...parts.length ? { parts } : {},
    } } : {},
    ...typeof r.liaisonModel === 'string' && r.liaisonModel.includes('/') ? { liaisonModel: r.liaisonModel } : {},
    ...typeof r.liaisonModel === 'string' && r.liaisonModel.includes('/') && typeof r.liaisonReasoningEffort === 'string' && r.liaisonReasoningEffort ? { liaisonReasoningEffort: r.liaisonReasoningEffort } : {},
  }
}

export type SettingsPatch = Partial<Omit<Settings, 'mobile'>> & { mobile?: Partial<MobileSettings> } & { notifyUrl?: string | undefined; liaisonModel?: string | undefined; liaisonReasoningEffort?: string | undefined }

export class SettingsStore {
  readonly file: string
  private value: Settings
  private readonly listeners = new Set<(next: Settings, prev: Settings) => void>()

  constructor(readonly dir: string) {
    this.file = join(dir, 'config.json')
    this.value = this.read()
  }

  private read(): Settings {
    if (!existsSync(this.file)) return normalize({})
    try { return normalize(JSON.parse(readFileSync(this.file, 'utf8'))) } catch {
      // 坏文件：改名留着给人看，按缺省继续
      try { renameSync(this.file, `${this.file}.broken-${Date.now()}`) } catch { /* 改不了名也继续 */ }
      return normalize({})
    }
  }

  get(): Settings { return this.value }

  /** 局部更新；notifyUrl 传空串表示删除。返回新值，并通知订阅者。 */
  update(patch: SettingsPatch): Settings {
    const prev = this.value
    const merged: Record<string, unknown> = { ...prev, ...patch, mobile: { ...prev.mobile, ...patch.mobile } }
    if (patch.notifyUrl === '') delete merged.notifyUrl
    if (patch.liaisonModel === '') delete merged.liaisonModel
    if (patch.liaisonReasoningEffort === '') delete merged.liaisonReasoningEffort
    if (patch.notifyUrl && !/^https?:\/\//.test(patch.notifyUrl)) throw new Error('推送地址要以 http:// 或 https:// 开头')
    if (patch.timeZone !== undefined && !validTimeZone(patch.timeZone)) throw new Error(`不认识的时区：${patch.timeZone}`)
    if (patch.concurrency !== undefined && !(Number.isInteger(patch.concurrency) && patch.concurrency >= 1 && patch.concurrency <= 6)) throw new Error('并发数是 1 到 6 的整数')
    if (patch.mobile?.port !== undefined && !(Number.isInteger(patch.mobile.port) && patch.mobile.port >= 1024 && patch.mobile.port < 65536)) throw new Error('端口要在 1024 到 65535 之间')
    const next = normalize(merged)
    this.write(next)
    this.value = next
    for (const fn of this.listeners) { try { fn(next, prev) } catch { /* 订阅者自己记日志 */ } }
    return next
  }

  onChange(fn: (next: Settings, prev: Settings) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private write(value: Settings) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try { chmodSync(this.dir, 0o700) } catch { /* 不是自己的目录就算了 */ }
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

// ───────────── 密码 ─────────────

const SCRYPT = { N: 16384, r: 8, p: 1 }

export function hashPassword(password: string): string {
  if (password.length < 8) throw new Error('密码至少 8 位')
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, SCRYPT)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false
  const [kind, saltHex, hashHex] = stored.split('$')
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** 推送地址常带 token：给模型和手机看的只有主机名。 */
export function maskUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try { return `${new URL(url).host}（已配置）` } catch { return '（已配置）' }
}

/** 异步版本：手机登录用，不卡住 DSH 的事件循环。 */
export async function verifyPasswordAsync(password: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false
  const [kind, saltHex, hashHex] = stored.split('$')
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await new Promise<Buffer>((resolve, reject) => scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT, (e, key) => e ? reject(e) : resolve(key)))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** 给界面和接口人看的配置：不含密码哈希，推送地址脱敏。完整推送地址只在电脑上的设置页给（见 src/index.ts）。 */
export function publicSettings(s: Settings) {
  return {
    // 工具返回值须是无损 JSON：没设的项省略，不写成 undefined。
    ...s.brain ? { brain: s.brain } : {}, timeZone: s.timeZone, concurrency: s.concurrency, ...s.notifyUrl ? { notify: maskUrl(s.notifyUrl)! } : {},
    liaisonModel: s.liaisonModel ?? '', liaisonReasoningEffort: s.liaisonReasoningEffort ?? '',
    mobile: { enabled: s.mobile.enabled, port: s.mobile.port, host: s.mobile.host, hasPassword: Boolean(s.mobile.passwordHash) },
  }
}
