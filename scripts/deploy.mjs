#!/usr/bin/env node
/**
 * 部署作战台的改动：检查 → 打包 → 热重载 → 确认生效。不重启服务。
 *
 * 只在开发模式（插件从 git 源码运行）下使用，平时由插件在界面师的工单核验通过后自动调用：
 *
 *   node scripts/deploy.mjs "改了什么" --patch <profile 的 cordis.patch.yml> --home <$DSH_HOME/chief>
 *   node scripts/deploy.mjs --rollback ...   撤销最近一次界面修改，再部署
 *   node scripts/deploy.mjs --check          只检查（类型、测试、改动范围），不部署
 *   加 --source-digest <sha256>               核对已验收的界面源码版本
 *   加 --core                                 允许改界面以外的代码（只给主人用）
 *
 * 安全闸门：
 *   1. 改动范围：默认只允许界面相关的文件（src/client、src/mobile），碰到引擎或服务端代码就拒绝。
 *   2. 类型检查和全部测试必须通过。
 *   3. 先打包到临时目录，成功后才替换 lib/。
 *   4. 触发 DSH 重新组合（改 profile patch 里的一行标记）。新的插件实例启动时发现自己就是待确认的构建，
 *      写下确认文件（见 src/index.ts 的 confirmDeploy）；60 秒内没有确认就报错。
 *   5. 浏览器和手机页面发现编号变化后自动刷新。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureUiSource, UI_PATHS } from './ui-source-proof.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const LOG = valueOf('--log'), TICKET = valueOf('--ticket'), PATCH = valueOf('--patch'), HOME = valueOf('--home')
const SOURCE_DIGEST = valueOf('--source-digest')
const SCOPED = flag('--source-digest')
const VALUED = ['--log', '--ticket', '--patch', '--home', '--source-digest']
const message = args.filter((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1])).join(' ').trim()
/** 把结果追加到部署日志（作战台据此提醒主人）。 */
const report = (ok, detail) => { if (LOG) try { writeFileSync(LOG, JSON.stringify({ id: process.env.CHIEF_DEPLOY_ID ?? String(Date.now()), ticket: TICKET, ok, title: message || (flag('--rollback') ? '撤销上一次界面修改' : '界面修改'), detail: String(detail).slice(0, 1500), at: new Date().toISOString() }) + '\n', { flag: 'a' }) } catch { /* 日志写不了也不影响部署本身 */ } }
// 用运行插件的同一个 node（和它旁边的 npx）
const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` }

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
const step = text => console.log(`· ${text}`)
const fail = text => { console.error(`✗ ${text}`); report(false, text); process.exit(1) }

function assertSource(phase, tempBuild) {
  if (!SCOPED) return undefined
  try {
    const proof = captureUiSource(ROOT)
    if (proof.digest !== SOURCE_DIGEST) throw Error('构建输入已偏离工单确认的源码版本')
    return proof
  } catch (error) {
    if (tempBuild) rmSync(tempBuild, { recursive: true, force: true })
    fail(`${phase}无法确认已验收的源码。${error.message}`)
  }
}

function changedFiles() {
  const out = run('git', ['-c', 'core.quotePath=false', 'status', '--porcelain'])
  return out.split('\n').filter(Boolean).map(l => l.slice(3).replace(/^"|"$/g, '').split(' -> ').at(-1))
}

function gate() {
  const files = assertSource('检查前')?.paths ?? changedFiles()
  const outside = files.filter(f => !UI_PATHS.some(p => f.startsWith(p)))
  if (outside.length && !flag('--core')) fail(`这些改动不在界面范围内，拒绝部署：${outside.join('、')}。界面修改只能动 ${UI_PATHS.join('、')}。`)
  step(`改动文件：${files.length ? files.join('、') : '无'}`)
  step('类型检查')
  try { run('npx', ['tsc', '--noEmit', '-p', '.']) } catch (e) { fail(`类型检查没通过：\n${(e.stdout || '') + (e.stderr || '')}`.slice(0, 4000)) }
  step('运行测试')
  try { run('npx', ['vitest', 'run']) } catch (e) { fail(`测试没通过：\n${(e.stdout || '') + (e.stderr || '')}`.slice(-4000)) }
  return files
}

function build(id) {
  assertSource('打包前')
  const tmp = join(ROOT, '.deploy-tmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  step('打包')
  // 先打包到临时目录，成功后再整体覆盖 lib/（不 clean，正在运行的文件不会消失）
  try { run('npx', ['tsdown'], { env: { ...env, CHIEF_BUILD_ID: id, CHIEF_OUT_DIR: join(tmp, 'lib') } }) } catch (e) { fail(`打包失败：\n${(e.stdout || '') + (e.stderr || '')}`.slice(-3000)) }
  assertSource('打包结束', tmp)
  cpSync(join(tmp, 'lib'), join(ROOT, 'lib'), { recursive: true })
  rmSync(tmp, { recursive: true, force: true })
}

async function reload(id) {
  if (!PATCH || !HOME) fail('缺少 --patch 或 --home：部署由插件调用，不要手动运行（手动只用 --check）')
  assertSource('热重载前')
  step('热重载（触发 DSH 重新组合）')
  const confirmed = join(HOME, 'deploy-confirmed.json')
  rmSync(confirmed, { force: true })
  writeFileSync(join(HOME, 'deploy-pending.json'), JSON.stringify({ id, at: new Date().toISOString() }))
  const text = existsSync(PATCH) ? readFileSync(PATCH, 'utf8') : ''
  const marker = `# dsh-chief 热更新标记（部署脚本自动维护，改动它会让 DSH 重新加载作战台）：${id}\n`
  writeFileSync(PATCH, marker + text.replace(/^# dsh-chief 热更新标记.*\n/m, ''))
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try { if (JSON.parse(readFileSync(confirmed, 'utf8')).id === id) { step(`已生效，构建编号 ${id}`); return } } catch { /* 还没确认 */ }
  }
  fail('60 秒内没有生效。看一下 DSH 的日志，必要时重启 dsh web。')
}

if (SCOPED && (!/^[a-f0-9]{64}$/.test(SOURCE_DIGEST ?? '') || args.filter(arg => arg === '--source-digest').length !== 1)) {
  fail('需要一个 64 位已验收源码摘要')
}
if (SCOPED && (flag('--rollback') || flag('--core'))) fail('使用已验收源码的部署不能同时跨越界面范围或撤销构建')

if (flag('--rollback')) {
  const last = run('git', ['log', '-1', '--format=%H %s']).trim()
  const [commit, ...title] = last.split(' ')
  if (!/^(?:作战台：|✨【功能】：更新作战台界面)/.test(title.join(' '))) fail(`最近一次提交不是界面修改，不自动撤销：${last}`)
  step(`撤销：${title.join(' ')}`)
  run('git', ['revert', '--no-commit', 'HEAD'])
  run('git', ['commit', '-q', '-m', '⬅️【回滚】：撤销上一次作战台界面更新', '-m', `撤销 ${commit}`])
}
const files = gate()
assertSource('检查结束')
if (flag('--check')) { console.log('✓ 检查通过'); process.exit(0) }
const id = new Date().toISOString()
build(id)
await reload(id)
if (files.length && !flag('--rollback')) {
  assertSource('已热重载，提交前')
  run('git', SCOPED ? ['--literal-pathspecs', 'add', '-A', '--', ...files] : ['add', '-A'])
  const description = message ? `**界面变更**\n- ${message.replace(/\s+/g, ' ')}\n\n` : ''
  run('git', ['commit', '-q', '-m', '✨【功能】：更新作战台界面', '-m', `${description}Co-Authored-By: SuperHub <noreply@localhost>`])
  step('已提交到 git（撤销用 --rollback）')
}
report(true, '已生效')
console.log('✓ 部署完成，打开着的作战台会自动刷新')
