/**
 * Private Codex and Claude Code homes for acceptance hosts.
 *
 * Real tools started by an isolated DSH host would otherwise write their sessions, trust entries and history into the
 * owner's `~/.codex` and `~/.claude`. Each host gets a temporary `CODEX_HOME` and `CLAUDE_CONFIG_DIR` holding only the
 * owner's login and model settings, so the run still uses the owner's account and models. Nothing is symlinked.
 *
 * - Codex: `auth.json` (0600) and a `config.toml` with only the top-level `model` and `model_reasoning_effort` lines.
 *   No `[projects]`, MCP servers, hooks or plugins.
 * - Claude Code: `settings.json` (0600) with `env.ANTHROPIC_*` (an owner-disabled key such as `xANTHROPIC_MODEL` is not
 *   an `ANTHROPIC_*` key and stays out), `model`, `effortLevel` and `modelSettings`; `.credentials.json` only when it
 *   holds a `claudeAiOauth` login (only that entry is copied).
 * - The host environment drops inherited `ANTHROPIC_*`, `CLAUDE*` and `CODEX_*` variables, so the login demonstrably
 *   comes from these homes.
 *
 * Teardown: Codex may rotate its refresh token during the run. When the temporary `auth.json` changed and the owner's
 * file is still the one copied, the owner's file is backed up and the new login written back atomically; otherwise the
 * report asks the owner to check the Codex login. Then the temporary homes are deleted. Each home records its process
 * (`owner.json`); a later run tears down homes whose process is gone (killed with SIGKILL, power loss) the same way, so
 * no copied login outlives its run for long and a rotated login still reaches the owner.
 *
 * `CHIEF_ACCEPTANCE_OWNER_HOMES=1` turns this off (debugging only: runs then write into the owner's homes again).
 */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
const readMaybe = file => { try { return readFileSync(file) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
const stamp = (at = new Date()) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/** Variables a tool would take its login or home from instead of the private homes. */
export const INHERITED_TOOL_ENV = /^(ANTHROPIC_|CLAUDE|CODEX_)/

/** `env` without inherited tool logins and homes. */
export function withoutToolEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !INHERITED_TOOL_ENV.test(key)))
}

/** The top-level `model` and `model_reasoning_effort` lines of a Codex `config.toml`, verbatim. */
export function codexModelConfig(text) {
  const lines = []
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break
    if (/^\s*(model|model_reasoning_effort)\s*=/.test(line)) lines.push(line.trim())
  }
  return lines.length ? lines.join('\n') + '\n' : ''
}

/** The parts of the owner's Claude `settings.json` that carry the login and the model choice. */
export function claudeLoginSettings(settings) {
  const out = {}
  const env = Object.fromEntries(Object.entries(settings?.env ?? {}).filter(([key, value]) => key.startsWith('ANTHROPIC_') && typeof value === 'string'))
  if (Object.keys(env).length) out.env = env
  for (const key of ['model', 'effortLevel', 'modelSettings']) if (settings?.[key] !== undefined) out[key] = settings[key]
  return out
}

function writePrivate(file, content) {
  writeFileSync(file, content, { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Replace `file` atomically (same directory, then rename), private. */
function replaceAtomically(file, content) {
  const temporary = join(dirname(file), '.' + randomUUID() + '.tmp')
  writePrivate(temporary, content)
  renameSync(temporary, file)
}

/** Whether process `pid` still runs (a process of another user counts as running). */
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/**
 * Write a rotated Codex login back when that is safe, check the Claude login, then delete `root`. `meta` is what the
 * home recorded when it was made (`owner.json`).
 */
function reconcile(root, meta, log) {
  const report = { codexAuth: 'unchanged', claudeLogin: 'unchanged', warnings: [] }
  const codex = join(root, 'codex-home'), claude = join(root, 'claude-config')
  try {
    const after = readMaybe(join(codex, 'auth.json'))
    if (meta.authHash && after && sha256(after) !== meta.authHash) {
      const current = readMaybe(meta.ownerAuth)
      if (current && sha256(current) === meta.authHash) {
        const backup = meta.ownerAuth + '.bak-' + stamp()
        copyFileSync(meta.ownerAuth, backup)
        chmodSync(backup, 0o600)
        replaceAtomically(meta.ownerAuth, after)
        report.codexAuth = 'written-back'
        report.codexBackup = backup
      } else {
        report.codexAuth = 'conflict'
        report.warnings.push('验收期间 Codex 刷新了登录，但主人的 ' + meta.ownerAuth + ' 在此期间也变了（或已不存在），没有写回。请检查主人的 Codex 登录（codex login status）。')
      }
    } else if (meta.authHash && !after) {
      report.codexAuth = 'missing'
      report.warnings.push('验收结束时隔离的 Codex auth.json 不见了（可能被登出），请检查主人的 Codex 登录。')
    }
    const claudeAfter = readMaybe(join(claude, '.credentials.json'))
    if (meta.credentialsHash && (!claudeAfter || sha256(claudeAfter) !== meta.credentialsHash)) {
      report.claudeLogin = 'changed'
      report.warnings.push('验收期间 Claude Code 的 OAuth 登录发生了变化，未写回主人的 ' + meta.ownerCredentials + '。请检查主人的 Claude Code 登录。')
    }
  } catch (error) {
    report.warnings.push('核对验收期间的工具登录失败：' + (error?.message ?? error) + '。请检查主人的 Codex 与 Claude Code 登录。')
  } finally {
    rmSync(root, { recursive: true, force: true })
    report.removed = !existsSync(root)
    for (const warning of report.warnings) log('警告：' + warning)
  }
  return report
}

/** Tear down homes left by runs whose process is gone. Homes without a readable `owner.json` are left alone. */
export function sweepStaleHomes(base, log = message => console.warn(message)) {
  const swept = []
  let names = []
  try { names = readdirSync(base).filter(name => name.startsWith('tool-homes-')) } catch { return swept }
  for (const name of names) {
    const root = join(base, name)
    let meta
    try { meta = JSON.parse(readFileSync(join(root, 'owner.json'), 'utf8')) } catch { continue }
    if (!Number.isInteger(meta?.pid) || meta.pid === process.pid || alive(meta.pid)) continue
    log('清理上次中断的验收留下的工具主目录：' + root)
    swept.push({ root, ...reconcile(root, meta, log) })
  }
  return swept
}

const active = new Set()
let hooked = false
/**
 * Tear every open home down when the process ends. On Ctrl-C / SIGTERM / SIGHUP with no handler of the script's own,
 * tear down and end with that signal as before; a script that handles the signal itself (e.g. closing a study
 * gracefully) keeps doing so, and the homes go when it exits.
 */
function hookExit() {
  if (hooked) return
  hooked = true
  const all = () => { for (const homes of [...active]) { try { homes.teardown() } catch { /* the next run sweeps it */ } } }
  process.once('exit', all)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      if (process.listenerCount(signal) > 0) return
      all()
      process.kill(process.pid, signal)
    })
  }
}

/**
 * Create the private homes. Returns `undefined` when the owner opted out with `CHIEF_ACCEPTANCE_OWNER_HOMES=1`.
 * `base` defaults to `CHIEF_ACCEPTANCE_BASE` or `~/.cache/chief-acceptance` (Codex refuses its shell helpers under /tmp).
 */
export function isolateToolHomes({ ownerHome = homedir(), codexHome = join(ownerHome, '.codex'), claudeDir = join(ownerHome, '.claude'),
  base = process.env.CHIEF_ACCEPTANCE_BASE || join(ownerHome, '.cache', 'chief-acceptance'), env = process.env, log = message => console.warn(message),
  onExit = true } = {}) {
  if (env.CHIEF_ACCEPTANCE_OWNER_HOMES === '1') {
    log('注意：CHIEF_ACCEPTANCE_OWNER_HOMES=1，本次验收使用主人的 ~/.codex 与 ~/.claude，会留下会话和信任条目。')
    return undefined
  }
  mkdirSync(base, { recursive: true, mode: 0o700 })
  sweepStaleHomes(base, log)
  const ownerAuth = join(codexHome, 'auth.json')
  const auth = readMaybe(ownerAuth)
  const credentialsText = readMaybe(join(claudeDir, '.credentials.json'))
  let credentials
  if (credentialsText) {
    try {
      const parsed = JSON.parse(credentialsText.toString('utf8'))
      if (parsed?.claudeAiOauth) credentials = JSON.stringify({ claudeAiOauth: parsed.claudeAiOauth })
    } catch { /* not a login the tool could use either */ }
  }
  const root = mkdtempSync(join(base, 'tool-homes-'))
  chmodSync(root, 0o700)
  // Recorded first, so a run killed before its teardown is still swept (and a rotated login written back) later.
  const meta = { pid: process.pid, ownerAuth, ...(auth && { authHash: sha256(auth) }),
    ownerCredentials: join(claudeDir, '.credentials.json'), ...(credentials && { credentialsHash: sha256(Buffer.from(credentials)) }) }
  writePrivate(join(root, 'owner.json'), JSON.stringify(meta))
  const codex = join(root, 'codex-home'), claude = join(root, 'claude-config')
  mkdirSync(codex, { mode: 0o700 })
  mkdirSync(claude, { mode: 0o700 })

  if (auth) writePrivate(join(codex, 'auth.json'), auth)
  const ownerConfig = readMaybe(join(codexHome, 'config.toml'))
  writePrivate(join(codex, 'config.toml'), ownerConfig ? codexModelConfig(ownerConfig.toString('utf8')) : '')

  const settingsText = readMaybe(join(claudeDir, 'settings.json'))
  let settings = {}
  if (settingsText) {
    try { settings = JSON.parse(settingsText.toString('utf8')) } catch { log('警告：无法读取主人的 Claude settings.json，隔离的 Claude Code 没有登录设置。') }
  }
  writePrivate(join(claude, 'settings.json'), JSON.stringify(claudeLoginSettings(settings), null, 2) + '\n')
  if (credentials) writePrivate(join(claude, '.credentials.json'), credentials)

  let report
  const before = []

  /** Environment for the host: inherited tool variables removed, the private homes set. */
  function apply(hostEnv) {
    return { ...withoutToolEnv(hostEnv), CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude }
  }

  /**
   * Stop what still uses the homes (`onTeardown`, e.g. the host process when the script ends without stopping it), write
   * a rotated Codex login back when that is safe, then delete the homes. Safe to call more than once.
   */
  function teardown() {
    if (report) return report
    active.delete(homes)
    for (const stop of before.splice(0)) { try { stop() } catch { /* the homes go anyway */ } }
    report = reconcile(root, meta, log)
    return report
  }

  const homes = { root, codexHome: codex, claudeConfigDir: claude, apply, teardown, onTeardown: stop => { before.push(stop) } }
  if (onExit) {
    active.add(homes)
    hookExit()
  }
  return homes
}
