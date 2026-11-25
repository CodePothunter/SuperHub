#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
/**
 * SuperHub 命令行：
 *
 *   superhub doctor              检查配置和环境（不显示密钥）
 *   superhub remote-setup [公钥]  打印要加进 hub 的 ~/.ssh/authorized_keys 的那一行
 *   superhub bridge              hub 侧 SSH 强制命令：工作电脑的钥匙只能 pull / push（见 remote-setup）
 *   superhub runner              工作电脑侧：领一条任务、交给本机 agent 执行、把汇报推回 hub
 *   superhub export --for <chatgpt|claude|agents-md|session> [--write <文件>]
 *                                 把第二大脑里你确认过的"关于我"导出给别的系统。--write 只替换文件里 SuperHub 管理的区块
 *                                 Claude Code 的 SessionStart 钩子用 --for session，每开一个会话自动带上最新内容
 *   superhub cleanup-legacy-orders --brain <目录> [--apply <清单标识>]
 *
 * 配置从 $DSH_HOME/chief/config.json 读（缺省 ~/.dsh/chief），可以用 CHIEF_HOME 指定别的位置。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, linkSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const expand = p => p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
const dshHome = () => process.env.DSH_HOME ? resolve(expand(process.env.DSH_HOME)) : join(homedir(), '.dsh')
const chiefHome = () => process.env.CHIEF_HOME ? resolve(expand(process.env.CHIEF_HOME)) : join(dshHome(), 'chief')
const config = () => { try { return JSON.parse(readFileSync(join(chiefHome(), 'config.json'), 'utf8')) } catch { return {} } }
const brainDir = () => process.env.CHIEF_BRAIN ? resolve(expand(process.env.CHIEF_BRAIN)) : config().brain
const die = (message, code = 2) => { process.stderr.write(`SuperHub: ${message}\n`); process.exit(code) }

// ───────────── bridge：hub 侧的 SSH 强制命令 ─────────────

async function bridge() {
  const ID = /^[A-Za-z0-9-]{8,64}$/
  const MAX = 1024 * 1024
  const brain = brainDir()
  if (!brain) die('还没有选第二大脑的位置（先在 SuperHub 完成第一次设置）')
  const checkMaintenance = () => {
    if (existsSync(join(brain,'ops','legacy-order-cleanup.pending'))) die('第二大脑正在清理旧工单，请稍后重试')
  }
  checkMaintenance()
  const dir = join(brain, 'ops', 'remote')
  for (const sub of ['outbox', 'taken', 'inbox', 'receipts', 'claims', 'cancelled']) mkdirSync(join(dir, sub), { recursive: true })
  // SSH 强制命令下，工作电脑要执行的命令在 SSH_ORIGINAL_COMMAND 里
  const args = (process.env.SSH_ORIGINAL_COMMAND ?? process.argv.slice(3).join(' ')).trim().split(/\s+/).filter(Boolean)
  if (args[0] === 'pull' && (args.length === 1 || args.length === 2)) {
    const claimId = args[1]
    if (claimId && !ID.test(claimId)) die('非法领取标识')
    const terminal = id => ['receipts', 'done', 'rejected', 'cancelled'].some(sub => existsSync(join(dir, sub, `${id}.json`)))
    const claimFile = claimId && join(dir, 'claims', `${claimId}.json`)
    let task = claimFile && existsSync(claimFile) ? JSON.parse(readFileSync(claimFile, 'utf8')) : undefined
    if (!task) {
      const names = readdirSync(join(dir, 'outbox')).filter(n => n.endsWith('.json')).flatMap(name => {
        try { return [{ name, at: statSync(join(dir, 'outbox', name)).mtimeMs }] } catch (error) { if (error.code === 'ENOENT') return []; throw error }
      }).sort((a, b) => a.at - b.at || a.name.localeCompare(b.name)).map(row => row.name)
      for (const name of names) {
        checkMaintenance()
        const source = join(dir, 'outbox', name)
        let candidate
        try { candidate = JSON.parse(readFileSync(source, 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
        if (terminal(candidate.assignmentId)) { rmSync(source, { force: true }); continue }
        if (claimFile) {
          // Publish an immutable request-to-task binding before acknowledging the claim.
          // Concurrent requests with the same token must all resume the winning binding.
          const temporary = `${claimFile}.${randomUUID()}.tmp`
          writeFileSync(temporary, JSON.stringify({ ...candidate, claimId }), { mode: 0o600 })
          try { linkSync(temporary, claimFile) } catch (error) { if (error.code !== 'EEXIST') throw error } finally { rmSync(temporary, { force: true }) }
          task = JSON.parse(readFileSync(claimFile, 'utf8'))
          break
        }
        try { linkSync(source, join(dir, 'taken', name)); task = candidate } catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error }
        // An existing owner wins; legacy pull must not overwrite its claim.
        rmSync(source, { force: true })
        if (task) break
      }
    }
    if (task && claimFile) {
      if (terminal(task.assignmentId)) task = undefined
      else {
        const taken = join(dir, 'taken', `${task.assignmentId}.json`)
        try { linkSync(claimFile, taken) } catch (error) { if (error.code !== 'EEXIST') throw error }
        const owner = JSON.parse(readFileSync(taken, 'utf8'))
        if (owner.claimId !== claimId) task = undefined
        else {
          rmSync(join(dir, 'outbox', `${task.assignmentId}.json`), { force: true })
          if (terminal(task.assignmentId)) { rmSync(taken, { force: true }); task = undefined }
        }
      }
    }
    if (task && terminal(task.assignmentId)) { rmSync(join(dir, 'taken', `${task.assignmentId}.json`), { force: true }); task = undefined }
    if (task) { const { claimId: _claim, ...payload } = task; process.stdout.write(`${JSON.stringify(payload)}\n`) }
    else process.stdout.write('{}\n')
  } else if (args[0] === 'push' && args.length === 2) {
    const id = args[1]
    if (!ID.test(id)) die('非法任务 id')
    let task
    try { task = JSON.parse(readFileSync(join(dir, 'taken', `${id}.json`), 'utf8')) } catch { try { task = JSON.parse(readFileSync(join(dir, 'receipts', `${id}.json`), 'utf8')) } catch { die('没有这条已领取的任务') } }
    const chunks = []
    let size = 0
    for await (const chunk of process.stdin) {
      size += chunk.length
      if (size > MAX) die('汇报超过 1 MiB')
      chunks.push(chunk)
    }
    let report
    try { report = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { die('汇报不是 JSON') }
    checkMaintenance()
    // A report arriving after cleanup must still have its assigned target.
    if (!existsSync(join(dir, 'taken', `${id}.json`)) && !existsSync(join(dir, 'receipts', `${id}.json`))) die('没有这条已领取的任务')
    const receiptFile = join(dir, 'receipts', `${id}.json`)
    const hash = createHash('sha256').update(JSON.stringify(report)).digest('hex')
    const record = { ticketId: task.ticketId, assignmentId: id, hash, report, at: new Date().toISOString() }
    // Publish one immutable record atomically. Competing pushes can only link the first complete record.
    const temporary = `${receiptFile}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 })
    try { linkSync(temporary, receiptFile) } catch (error) { if (error.code !== 'EEXIST') throw error } finally { rmSync(temporary, { force: true }) }
    const prior = JSON.parse(readFileSync(receiptFile, 'utf8'))
    if (prior.hash !== hash) die('同一次派工不能覆盖回传')
    // A retry also repairs a crash between receipt publication and inbox publication.
    if (!existsSync(join(dir, 'done', `${id}.json`)) && !existsSync(join(dir, 'rejected', `${id}.json`))) {
      try { linkSync(receiptFile, join(dir, 'inbox', `${id}.json`)) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    process.stdout.write('ok\n')
  } else die('只允许 pull 或 push <id>')
}

// ───────────── remote-setup ─────────────

function remoteSetup() {
  const key = process.argv.slice(3).join(' ').trim() || 'ssh-ed25519 AAAA...（工作电脑的公钥） work-laptop'
  const env = process.env.CHIEF_HOME ? `CHIEF_HOME=${chiefHome()} ` : process.env.DSH_HOME ? `DSH_HOME=${resolve(expand(process.env.DSH_HOME))} ` : ''
  const command = `${env ? `env ${env}` : ''}${process.execPath} ${join(HERE, 'cli.mjs')} bridge`
  console.log('把下面这一行加进这台机器（hub）的 ~/.ssh/authorized_keys：\n')
  console.log(`command="${command}",restrict ${key}\n`)
  console.log('然后在工作电脑上：')
  console.log('  1. 在 ~/.ssh/config 里给 hub 配好 HostName、User、IdentityFile；')
  console.log(`  2. 把 ${join(HERE, 'runner.mjs')} 拷过去（或者安装 SuperHub 后用 superhub runner）；`)
  console.log('  3. 用 cron / launchd 每隔几分钟运行一次：CHIEF_HUB=hub node runner.mjs')
  console.log('     可选：CHIEF_AGENT 指定执行命令（缺省 claude -p --output-format text），CHIEF_WORKDIR、CHIEF_TIMEOUT。')
}

// ───────────── doctor ─────────────

function doctor() {
  const ok = (label, value) => console.log(`  ✓ ${label}${value ? `：${value}` : ''}`)
  const bad = (label, value) => console.log(`  ✗ ${label}${value ? `：${value}` : ''}`)
  const c = config()
  console.log(`SuperHub ${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`)
  console.log(`\n配置（${join(chiefHome(), 'config.json')}）`)
  if (!existsSync(join(chiefHome(), 'config.json'))) bad('还没有配置文件', '打开 SuperHub 完成第一次设置后会生成')
  const brain = brainDir()
  if (!brain) bad('第二大脑', '还没选')
  else if (!existsSync(join(brain, 'AGENTS.md'))) bad('第二大脑', `${brain}（不存在或不完整）`)
  else ok('第二大脑', brain)
  ok('时区', c.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)
  ok('同时干活的幕僚', String(c.concurrency ?? 2))
  console.log(`  ${c.notifyUrl ? '✓' : '·'} 推送：${c.notifyUrl ? '已配置' : '没有（提醒只在作战台显示）'}`)
  const m = c.mobile ?? {}
  console.log(`  ${m.enabled ? '✓' : '·'} 手机访问：${m.enabled ? `开启，${m.host ?? '0.0.0.0'}:${m.port ?? 50388}${m.passwordHash ? '' : '，还没设密码'}` : '关闭'}`)
  console.log('\n环境')
  const major = Number(process.versions.node.split('.')[0])
  ;(major >= 24 ? ok : bad)('Node.js', process.versions.node)
  try { ok('git', execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()) } catch { bad('git', '没装：能用，但改动不会留历史') }
  try { execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 5000 }); ok('Claude Code（终端 PATH）') }
  catch { console.log('  · Claude Code（终端 PATH）：未找到可运行的命令') }
  let terminalCodex
  try {
    const version = execFileSync('codex', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    terminalCodex = /^codex(?:-cli)?\s+([\w.+-]+)\s*$/i.exec(version)?.[1]
    ok('Codex CLI（终端 PATH）', terminalCodex ?? '可运行，版本未识别')
  } catch { console.log('  · Codex CLI（终端 PATH）：未找到可运行的命令') }
  const codexManifest = join(dshHome(), 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-subagent-codex', 'package.json')
  if (existsSync(codexManifest)) {
    try {
      const manifest = realpathSync(codexManifest)
      const requireFromAdapter = createRequire(manifest)
      const adapter = JSON.parse(readFileSync(manifest, 'utf8'))
      ok('DSH Web Codex 适配器（磁盘）', adapter.version)
      const cli = JSON.parse(readFileSync(requireFromAdapter.resolve('@openai/codex/package.json'), 'utf8'))
      ok('适配器解析到的 Codex CLI', cli.version)
      if (terminalCodex && cli.version !== terminalCodex) console.log('  · 检测到两套 Codex 版本。请按 DSH 宿主版本核对官方适配器及其 CLI 依赖。')
    } catch { console.log('  · DSH Web Codex 适配器：无法读取 CLI 依赖版本，请检查官方适配器安装') }
  } else console.log('  · DSH Web Codex 适配器：未找到。需要 Codex 执行工单时，在 DSH 插件页启用与宿主匹配的官方适配器')
  ;(existsSync(join(ROOT, 'lib', 'index.js')) ? ok : bad)('插件构建', existsSync(join(ROOT, 'lib', 'mobile', 'app.js')) ? 'lib/ 完整' : 'lib/ 不完整')
  const dev = existsSync(join(ROOT, '.git')) && existsSync(join(ROOT, 'src', 'index.ts'))
  console.log(`  ${dev ? '✓' : '·'} 开发模式：${dev ? '是（从 git 源码运行，界面师可以改源码）' : '否'}`)
  if (brain) {
    const remote = join(brain, 'ops', 'remote')
    const count = sub => existsSync(join(remote, sub)) ? readdirSync(join(remote, sub)).filter(n => n.endsWith('.json')).length : 0
    console.log(`\n工作电脑队列：待领取 ${count('outbox')}，已领取 ${count('taken')}，待处理的回传 ${count('inbox')}`)
  }
}

// ───────────── export：反哺别的系统 ─────────────

async function exportCommand() {
  const { buildExport, upsertBlock, EXPORT_TARGETS, readGoalsDocument } = await import('../lib/export.js')
  const args = process.argv.slice(3)
  const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  const target = valueOf('--for') ?? 'session'
  if (!EXPORT_TARGETS.includes(target)) die(`--for 只能是 ${EXPORT_TARGETS.join(' / ')}`)
  const brain = brainDir()
  if (!brain) die('还没有选第二大脑的位置')
  const read = name => { try { return readFileSync(join(brain, name), 'utf8') } catch { return undefined } }
  const zone = config().timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const result = buildExport(target, { me: read('me.md'), agents: read('AGENTS.md'), goals: readGoalsDocument(brain) }, today)
  // 钩子里运行时不要报错打断会话：没有内容就安静地什么都不输出
  if (result.empty) { if (!valueOf('--write')) process.stderr.write('第二大脑里还没有你确认过的关于你自己的内容\n'); return }
  const text = result.parts.map(p => result.parts.length > 1 ? `# ${p.label}\n${p.text}` : p.text).join('\n\n')
  const file = valueOf('--write')
  if (!file) { process.stdout.write(`${text}\n`); return }
  if (target !== 'agents-md') die('--write 只配合 --for agents-md 使用')
  const path = resolve(expand(file))
  let existing = ''
  try { existing = readFileSync(path, 'utf8') } catch { /* 新文件 */ }
  const next = upsertBlock(existing, result.parts[0].text)
  if (next !== existing) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, next); console.log(`已更新 ${path}`) }
}

async function cleanupLegacyOrdersCommand() {
  const [brainFlag, location, applyFlag, previewId, ...rest] = process.argv.slice(3)
  if (brainFlag !== '--brain' || !location || location.startsWith('--') || rest.length ||
      (applyFlag !== undefined && (applyFlag !== '--apply' || !/^[a-f0-9]{64}$/.test(previewId ?? ''))) ||
      (applyFlag === undefined && previewId !== undefined)) die('用法：superhub cleanup-legacy-orders --brain <目录> [--apply <清单标识>]')
  try {
    const { cleanupLegacyOrders } = await import('../lib/legacy-order-cleanup.js')
    console.log(JSON.stringify(cleanupLegacyOrders(resolve(expand(location)), previewId),null,2))
  } catch (error) {
    die(error instanceof Error ? error.message : String(error))
  }
}

const command = process.argv[2]
if (command === 'bridge') await bridge()
else if (command === 'runner') { const { main } = await import('./runner.mjs'); await main() }
else if (command === 'remote-setup') remoteSetup()
else if (command === 'doctor') doctor()
else if (command === 'export') await exportCommand()
else if (command === 'cleanup-legacy-orders') await cleanupLegacyOrdersCommand()
else {
  console.log('用法：superhub <doctor | remote-setup [公钥] | bridge | runner | export --for <chatgpt|claude|agents-md|session> [--write 文件] | cleanup-legacy-orders --brain 目录 [--apply 清单标识]>')
  process.exit(command ? 2 : 0)
}
