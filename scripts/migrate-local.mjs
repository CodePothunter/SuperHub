#!/usr/bin/env node
/**
 * 一次性迁移：把 0.1 版（独立网关 + .env 密码 + profile 里写死的第二大脑路径）搬到 0.2 版的配置。
 *
 *   node scripts/migrate-local.mjs --brain <第二大脑> --env <.env 文件> [--gateway-state <旧网关状态目录>] [--dry-run]
 *
 * 做的事：
 *   1. 写 $DSH_HOME/chief/config.json：第二大脑原地接管、时区、手机访问（端口 50388、0.0.0.0、密码哈希）、
 *      接口人会话沿用 chief-liaison（保住现有对话）。密码从 .env 的 CHIEF_GATEWAY_PASSWORD 读，只写哈希，不打印。
 *   2. 旧网关的登录会话拷成 mobile-sessions.json（格式相同），手机不用重新登录。
 *   3. 第二大脑里的部署记录移到 $DSH_HOME/chief/。
 *   4. 删掉 rules.yaml 里指向插件仓库的工作区（开发模式下插件目录自动是工作区），提交到第二大脑的 git。
 * 不动：systemd 服务、.env 文件本身（验证通过后再手动删密码那一行）。
 */
import { execFileSync } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const dry = args.includes('--dry-run')
const expand = p => p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
const brain = resolve(expand(valueOf('--brain') ?? ''))
const envFile = resolve(expand(valueOf('--env') ?? ''))
const gatewayState = valueOf('--gateway-state') ? resolve(expand(valueOf('--gateway-state'))) : undefined
if (!process.env.DSH_HOME) { console.error('请设置 DSH_HOME'); process.exit(2) }
const chiefHome = join(resolve(expand(process.env.DSH_HOME)), 'chief')
const step = text => console.log(`· ${text}`)

if (!existsSync(join(brain, 'AGENTS.md')) || !existsSync(join(brain, 'staff'))) { console.error(`不是第二大脑：${brain}`); process.exit(2) }
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').map(l => /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2')]))
const password = env.CHIEF_GATEWAY_PASSWORD ?? ''
if (password.length < 8) { console.error('.env 里没有可用的 CHIEF_GATEWAY_PASSWORD'); process.exit(2) }

// 和 src/dsh/settings.ts 的 hashPassword 一致
const salt = randomBytes(16)
const passwordHash = `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex')}`

const configFile = join(chiefHome, 'config.json')
let existing = {}
try { existing = JSON.parse(readFileSync(configFile, 'utf8')) } catch { /* 没有就新建 */ }
const config = {
  ...existing,
  brain,
  timeZone: existing.timeZone ?? 'Asia/Shanghai',
  concurrency: existing.concurrency ?? 2,
  ...env.CHIEF_NOTIFY_URL ? { notifyUrl: env.CHIEF_NOTIFY_URL } : {},
  mobile: { enabled: true, port: 50388, host: '0.0.0.0', passwordHash },
  liaison: { session: 'chief-liaison', brain },
}
step(`写 ${configFile}（第二大脑 ${brain}，手机访问 0.0.0.0:50388，密码只存哈希）`)
if (!dry) {
  mkdirSync(chiefHome, { recursive: true, mode: 0o700 })
  chmodSync(chiefHome, 0o700)
  writeFileSync(`${configFile}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${configFile}.tmp`, configFile)
}

if (gatewayState && existsSync(join(gatewayState, 'sessions.json'))) {
  step('沿用旧网关的登录会话（手机不用重新登录）')
  if (!dry) { copyFileSync(join(gatewayState, 'sessions.json'), join(chiefHome, 'mobile-sessions.json')); chmodSync(join(chiefHome, 'mobile-sessions.json'), 0o600) }
}

const ops = join(brain, 'ops')
const moved = readdirSync(ops).filter(n => /^deploy-\d+\.log$/.test(n) || n === 'deploys.jsonl')
if (moved.length) {
  step(`部署记录移到 ${chiefHome}：${moved.join('、')}`)
  if (!dry) for (const n of moved) renameSync(join(ops, n), join(chiefHome, n))
}

const rulesFile = join(brain, 'rules.yaml')
if (existsSync(rulesFile)) {
  const doc = parseDocument(readFileSync(rulesFile, 'utf8'))
  const list = doc.get('workspaces')
  const items = list?.items ?? []
  const index = items.findIndex(item => resolve(brain, String(item.value ?? item)) === ROOT || String(item.value ?? item).endsWith('/dsh-chief'))
  if (index >= 0) {
    step('rules.yaml：删掉指向插件仓库的工作区（开发模式下它自动是工作区）')
    if (!dry) {
      doc.deleteIn(['workspaces', index])
      writeFileSync(rulesFile, doc.toString())
      try {
        execFileSync('git', ['add', 'rules.yaml'], { cwd: brain })
        execFileSync('git', ['commit', '-q', '-m', '规则：插件仓库不再写在 workspaces 里（0.2 版开发模式下自动是工作区）', '--', 'rules.yaml'], { cwd: brain })
      } catch (error) { console.log(`  （没有提交：${error.message.split('\n')[0]}）`) }
    }
  }
}
console.log(dry ? '✓ 演练完成，没有改动任何文件' : '✓ 迁移完成。接下来：停掉旧网关服务，重启 dsh web')
