#!/usr/bin/env node
/** Workstation runner. Results enter a durable local outbox before any upload.
 * CHIEF_HUB, CHIEF_WORKDIR, CHIEF_AGENT, CHIEF_TIMEOUT retain their existing meanings.
 * A crashed execution is reported as uncertain; it is never silently rerun.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

export const validTask = t => t && /^T-\d+$/.test(t.ticketId) && /^[A-Za-z0-9-]{8,64}$/.test(t.assignmentId) && typeof t.prompt === 'string'
const save = (file, value) => { writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${file}.tmp`, file) }
function acquireRunLock(dir) {
  let db
  try {
    db = new DatabaseSync(join(dir, 'lock.sqlite'), { timeout: 0 })
    // Never unlink this file: SQLite owns the lock and the OS releases it on
    // process death, without stale-PID reclamation or a mkdir→pid crash window.
    db.exec('BEGIN EXCLUSIVE')
    const legacy = join(dir, 'lock')
    let stat
    try { stat = lstatSync(legacy) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (stat?.isDirectory()) {
      let pid
      try { pid = Number(readFileSync(join(legacy, 'pid'), 'utf8')) } catch {}
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('旧版 runner 运行锁缺少有效进程标识；请确认所有旧版 runner 已退出后移除 .chief-runner/lock，再重试')
      try { process.kill(pid, 0); throw new Error('已有 runner 在运行') } catch (e) { if (e.code !== 'ESRCH') throw e }
      rmSync(legacy, { recursive: true })
      stat = undefined
    }
    // A permanent regular file also makes old mkdir-based runners fail closed.
    // It is not the lock; even a crash while creating it cannot strand a runner.
    if (!stat) closeSync(openSync(legacy, 'wx', 0o600))
    else if (!stat.isFile()) throw new Error('运行锁标记不合法，请人工检查 .chief-runner/lock')
    return () => db.close()
  } catch (e) {
    db?.close()
    if (e.errcode === 5 || e.errcode === 6) throw new Error('已有 runner 在运行')
    throw e
  }
}
export async function runOnce({ root, pull, push, execute }) {
  const dir = join(root, '.chief-runner')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const release = acquireRunLock(dir)
  try {
    const flush = async () => {
      for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
        const file = join(dir, name), row = JSON.parse(readFileSync(file, 'utf8'))
        if (!validTask(row.task)) throw new Error('本地任务损坏，请人工检查')
        if (row.state === 'sent') continue
        if (row.state === 'running') {
          row.report = { status: 'failed', summary: '上次执行在回传落盘前中断，工作目录可能已有产物或外部副作用。未自动重跑，请主人检查后决定。' }
          row.state = 'completed'; save(file, row)
        }
        if (row.state === 'completed') { await push(row.task.assignmentId, row.report); row.state = 'sent'; save(file, row) }
        else if (row.state === 'claimed') return row
      }
    }
    // No fresh execution while a previous result still needs upload.
    let row = await flush()
    if (!row) {
      // Save the request token before SSH. A lost response retries this exact claim,
      // rather than asking the hub to hand an ambiguous task to another worker.
      const pendingPull = join(dir, 'pull')
      const claimId = existsSync(pendingPull) ? JSON.parse(readFileSync(pendingPull, 'utf8')) : randomUUID()
      if (typeof claimId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(claimId)) throw new Error('本地领取标识损坏，请人工检查')
      save(pendingPull, claimId)
      const task = await pull(claimId)
      if (!task.assignmentId) { rmSync(pendingPull, { force: true }); return }
      if (!validTask(task)) throw new Error('hub 返回非法任务')
      const file = join(dir, `${task.assignmentId}.json`)
      if (existsSync(file)) { rmSync(pendingPull, { force: true }); await flush(); return }
      row = { task, state: 'claimed' }; save(file, row)
      rmSync(pendingPull, { force: true })
    }
    const file = join(dir, `${row.task.assignmentId}.json`)
    const cwd = join(root, row.task.ticketId)
    mkdirSync(cwd, { recursive: true }); writeFileSync(join(cwd, row.task.kind === 'discussion' ? `QUESTION-${row.task.assignmentId}.md` : 'TASK.md'), row.task.prompt)
    row.state = 'running'; save(file, row)
    try { row.report = await execute(row.task, cwd) } catch (e) { row.report = { status: 'failed', summary: `执行失败：${e.message}` } }
    row.state = 'completed'; save(file, row)
    await push(row.task.assignmentId, row.report)
    row.state = 'sent'; save(file, row)
  } finally { release() }
}

export async function main() {
  const hub = process.env.CHIEF_HUB || 'hub'
  const root = process.env.CHIEF_WORKDIR || join(homedir(), 'chief-work')
  const ssh = (args, input) => {
    const result = spawnSync('ssh', ['-o', 'BatchMode=yes', hub, ...args], { input, encoding: 'utf8', timeout: 60_000 })
    // Only the old bridge's exact protocol rejection permits a legacy retry.
    // Transport failures must retain the durable token and retry the same claim.
    if (args[0] === 'pull' && args.length === 2 && result.status === 2 && /^(?:dsh-chief|SuperHub): 只允许 pull 或 push <id>\r?\n?$/.test(result.stderr)) return ssh(['pull'])
    if (result.status !== 0) throw new Error(result.stderr || String(result.error || 'SSH 失败'))
    return result.stdout
  }
  await runOnce({ root, pull: async claimId => JSON.parse(ssh(['pull', claimId])), push: async (id, report) => { ssh(['push', id], JSON.stringify(report)) }, execute: async (task, cwd) => {
    const [command, ...args] = (process.env.CHIEF_AGENT || 'claude -p --output-format text').split(/\s+/)
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const keep = (s, d) => (s + d).slice(-400 * 1024)
    child.stdout.on('data', d => { out = keep(out, d) }); child.stderr.on('data', d => { err = keep(err, d) })
    child.stdin.on('error', () => {}); child.stdin.end(task.prompt)
    const timer = setTimeout(() => child.kill('SIGTERM'), Number(process.env.CHIEF_TIMEOUT || 60) * 60_000)
    const code = await new Promise(r => { child.on('error', e => { err += e.message; r(-1) }); child.on('close', c => r(c ?? -1)) })
    clearTimeout(timer)
    return code === 0 ? out : { status: 'failed', summary: `执行命令退出码 ${code}：${err.slice(-1500)}` }
  } })
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1 })
