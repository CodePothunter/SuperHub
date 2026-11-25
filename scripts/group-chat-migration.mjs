#!/usr/bin/env node
/**
 * 工作区群聊上线迁移（任务 11-24 D3 / D5 / R6 / AC7）：删除旧会话（编程会话、临时 Lead 群）及其工单、对话记录、命令日志、
 * 提醒、DSH 原生会话、Codex thread / Claude Code 会话；另删看板 `retiredOrders` 里的退役原生工单（工单文件、事件正文、
 * 处理结果、提醒、讨论室挂接、交付版本、`work/T-xxxx`、工单桌 DSH 会话）。`work/superhub-v2` 下的交付文件、工作区、幕僚、
 * 资料都保留。第二大脑是 git 仓库：本脚本不提交，删除会出现在它的下一次自动提交里。
 *
 *   node --experimental-transform-types scripts/group-chat-migration.mjs --brain <第二大脑>            # 只预览（默认，不改任何文件）
 *   node --experimental-transform-types scripts/group-chat-migration.mjs --brain <第二大脑> --apply [清单标识]
 *
 * 选项：
 *   --scope <原第二大脑路径|32 位作用域>  在第二大脑的副本上运行时，用原来的路径（作用域由它算出）
 *   --dsh-home <目录>      DSH 数据目录（默认 $DSH_HOME，否则 ~/.dsh）：旧群的原生会话在 sessions/ 下
 *   --codex-home <目录>    默认 $CODEX_HOME，否则 ~/.codex；--codex-bin <路径>（默认 codex）用于 thread/delete
 *   --claude-dir <目录>    默认 ~/.claude
 *   --skip-natives         不看 DSH / Codex / Claude 目录（只预览第二大脑里的记录）
 *   --json                 输出清单 JSON
 *   --again                已完成过迁移后再执行一次（只在又出现旧式会话时用）
 *   --skip-service-check   不检查 dsh-web 服务（只用于副本或测试；本脑写锁仍会检查）
 *
 * 执行前：停止 dsh-web（它持有第二大脑写锁和 DSH 数据目录）。执行中断或有失败项时，重跑同一命令会接着原清单做完。
 * 逐项日志与清单保存在 <第二大脑>/ops/superhub-group-migration/。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { applyGroupChatMigration, formatApplyReport, formatMigrationManifest, planGroupChatMigration, readMigrationSnapshot } from '../src/dsh/workspace-group-migration.ts'

const USAGE = '用法：node --experimental-transform-types scripts/group-chat-migration.mjs --brain <第二大脑> [--scope <原路径|作用域>] [--dsh-home 目录] [--codex-home 目录] [--claude-dir 目录] [--skip-natives] [--json] [--apply [清单标识]] [--again]'

export function parseArgs(argv, env = process.env, home = homedir()) {
  const options = { apply: false, json: false, again: false, natives: true, serviceCheck: true, codexBin: 'codex' }
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]
    const value = () => { const next = argv[++at]; if (!next || next.startsWith('--')) throw Error(arg + ' 需要一个值'); return next }
    if (arg === '--brain') options.brain = resolve(value())
    else if (arg === '--scope') options.scope = /^[a-f0-9]{32}$/.test(argv[at + 1] ?? '') ? value() : resolve(value())
    else if (arg === '--dsh-home') options.dshHome = resolve(value())
    else if (arg === '--codex-home') options.codexHome = resolve(value())
    else if (arg === '--claude-dir') options.claudeDir = resolve(value())
    else if (arg === '--codex-bin') options.codexBin = value()
    else if (arg === '--skip-natives') options.natives = false
    else if (arg === '--json') options.json = true
    else if (arg === '--again') options.again = true
    else if (arg === '--skip-service-check') options.serviceCheck = false
    else if (arg === '--apply') {
      options.apply = true
      if (/^[a-f0-9]{64}$/.test(argv[at + 1] ?? '')) options.expect = argv[++at]
    } else throw Error('未知参数 ' + arg)
  }
  if (!options.brain) throw Error(USAGE)
  if (options.natives) {
    options.dshHome ??= env.DSH_HOME ? resolve(env.DSH_HOME) : join(home, '.dsh')
    options.codexHome ??= env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex')
    options.claudeDir ??= join(home, '.claude')
    for (const key of ['dshHome', 'codexHome', 'claudeDir']) if (!existsSync(options[key])) delete options[key]
  } else {
    delete options.dshHome; delete options.codexHome; delete options.claudeDir
  }
  return options
}

/** `codex app-server --stdio`, only for `thread/delete` of the ids in the manifest (started on first use). */
function codexDeleter(bin, codexHome) {
  let child, ready, serial = 0, stderr = ''
  const waiting = new Map()
  const fail = error => { for (const { reject, timer } of waiting.values()) { clearTimeout(timer); reject(error) } waiting.clear() }
  function request(method, params, timeout = 60_000) {
    const id = ++serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(Error(method + ' 超时')) }, timeout)
      waiting.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  let exited
  function start() {
    child = spawn(bin, ['app-server', '--stdio'], { cwd: homedir(), env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] })
    exited = new Promise(done => {
      child.once('close', code => { fail(Error('codex app-server 已退出（' + code + '）' + (stderr ? '：' + stderr.trim().split('\n').at(-1) : ''))); done(code) })
      child.once('error', error => { fail(Error('无法启动 ' + bin + '：' + error.message)); done(null) })
    })
    child.stdin.on('error', () => {})
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
    createInterface({ input: child.stdout }).on('line', line => {
      let frame
      try { frame = JSON.parse(line) } catch { return }
      if (frame.id === undefined || !waiting.has(frame.id)) return
      const { resolve, reject, timer } = waiting.get(frame.id)
      clearTimeout(timer)
      waiting.delete(frame.id)
      if (frame.error) reject(Object.assign(Error(frame.error.message ?? 'JSON-RPC 错误'), { code: frame.error.code }))
      else resolve(frame.result)
    })
    return request('initialize', { clientInfo: { name: 'superhub-group-migration', title: null, version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } })
      .then(() => child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'))
  }
  return {
    async delete(threadId) {
      ready ??= start()
      await ready
      await request('thread/delete', { threadId })
    },
    async close() {
      if (!child) return
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    },
  }
}

/** dsh-web serves the brain and owns the DSH data directory: it must be stopped. */
function serviceReasons() {
  try {
    const state = execFileSync('systemctl', ['--user', 'is-active', 'dsh-web'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (state === 'active' || state === 'activating' || state === 'reloading') return ['dsh-web 服务正在运行，请先停止（systemctl --user stop dsh-web）']
  } catch { /* not active, or no systemd: the brain lock still guards the brain */ }
  return []
}

export async function main(argv = process.argv.slice(2), print = text => process.stdout.write(text)) {
  let options
  try { options = parseArgs(argv) }
  catch (error) { console.error(error.message); return 2 }
  const snapshotOptions = { ...(options.scope && { scope: options.scope }), ...(options.dshHome && { dshHome: options.dshHome }),
    ...(options.codexHome && { codexHome: options.codexHome }), ...(options.claudeDir && { claudeDir: options.claudeDir }) }
  try {
    if (!options.apply) {
      const manifest = planGroupChatMigration(readMigrationSnapshot(options.brain, snapshotOptions))
      print(options.json ? JSON.stringify(manifest, null, 2) + '\n' : formatMigrationManifest(manifest))
      return manifest.blockers.length ? 1 : 0
    }
    const codex = options.codexHome ? codexDeleter(options.codexBin, options.codexHome) : undefined
    try {
      const report = await applyGroupChatMigration(options.brain, {
        ...snapshotOptions, ...(options.expect && { expect: options.expect }), again: options.again,
        ...(codex && { deleteCodexThread: id => codex.delete(id) }),
        live: () => options.serviceCheck ? serviceReasons() : [],
      })
      print(options.json ? JSON.stringify(report, null, 2) + '\n' : (report.resumed || report.already ? '' : formatMigrationManifest(report.manifest, 'apply') + '\n') + formatApplyReport(report))
      return report.complete ? 0 : 1
    } finally {
      await codex?.close().catch(() => {})
    }
  } catch (error) {
    console.error(error.message)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main()
