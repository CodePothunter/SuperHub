import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface Result { code: number | null; out: string; err: string }
interface Job { child: ChildProcess; result: Promise<Result>; outcome?: Result }
const jobs: Job[] = [], roots: string[] = []
afterEach(async () => {
  for (const job of jobs) if (!job.outcome) job.child.kill('SIGKILL')
  await Promise.all(jobs.splice(0).map(job => job.result))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 4000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待运行器测试事件超时')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
function start(args: string[], env: NodeJS.ProcessEnv): Job {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const job = { child } as Job
  job.result = new Promise((resolve, reject) => {
    let out = '', err = ''
    child.stdout!.on('data', chunk => { out += chunk })
    child.stderr!.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('close', code => { job.outcome = { code, out, err }; resolve(job.outcome) })
  })
  jobs.push(job)
  return job
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chief-runner-lock-'))
  roots.push(root)
  const work = join(root, 'work'), dir = join(work, '.chief-runner'), legacy = join(dir, 'lock'), calls = join(root, 'calls')
  mkdirSync(dir, { recursive: true })
  // Keep the real script/CLI entry points and filesystem. Only the SSH boundary
  // is local; optional barriers expose crash and stale-reclamation windows.
  const preload = join(root, 'transport.mjs')
  writeFileSync(preload, `import fs from 'node:fs'
import cp from 'node:child_process'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const wait = new Int32Array(new SharedArrayBuffer(4))
const pause = (ready, release) => { fs.writeFileSync(ready, ''); while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10) }
const read = fs.readFileSync, rename = fs.renameSync, spawnSync = cp.spawnSync
fs.readFileSync = function (file, ...args) {
  const value = read.call(this, file, ...args)
  if (process.env.STALE_READY && file === join(process.env.CHIEF_WORKDIR, '.chief-runner', 'lock', 'pid')) pause(process.env.STALE_READY, process.env.STALE_RELEASE)
  return value
}
fs.renameSync = function (from, to) {
  const result = rename.call(this, from, to)
  if (process.env.SENT_READY && to === process.env.SENT_FILE && JSON.parse(read(to, 'utf8')).state === 'sent') pause(process.env.SENT_READY, process.env.SENT_RELEASE)
  return result
}
cp.spawnSync = function (command, args, options) {
  if (command !== 'ssh') return spawnSync.call(this, command, args, options)
  fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n')
  if (process.env.PULL_READY && args[3] === 'pull') pause(process.env.PULL_READY, process.env.PULL_RELEASE)
  return { status: 0, stdout: args[3] === 'pull' ? '{}\\n' : '', stderr: '' }
}
syncBuiltinESMExports()
`)
  const launch = (extra: NodeJS.ProcessEnv = {}, cli = false) => start(['--import', preload, resolve(cli ? 'bin/cli.mjs' : 'bin/runner.mjs'), ...cli ? ['runner'] : []], { CHIEF_WORKDIR: work, CALLS: calls, ...extra })
  const requests = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(row => JSON.parse(row) as string[]) : []
  const oldLock = (pid?: string) => { mkdirSync(legacy); if (pid !== undefined) writeFileSync(join(legacy, 'pid'), pid) }
  return { root, work, dir, legacy, launch, requests, oldLock }
}

describe('运行器进程锁', () => {
  it('正常脚本和命令行入口在无任务时静默退出，恢复已退出的旧锁并保留稳定锁文件', async () => {
    const f = fixture()
    f.oldLock('2147483647')
    expect(await f.launch().result).toEqual({ code: 0, out: '', err: '' })
    expect(lstatSync(f.legacy).isFile()).toBe(true)
    expect(existsSync(join(f.dir, 'lock.sqlite'))).toBe(true)
    expect(await f.launch({}, true).result).toEqual({ code: 0, out: '', err: '' })
    expect(f.requests()).toHaveLength(2)
  })

  it.each([undefined, '', '0', 'not-a-pid'])('旧版无有效进程标识（%s）时给出恢复步骤，确认退出并移除后可以恢复', async pid => {
    const f = fixture()
    f.oldLock(pid)
    const result = await f.launch().result
    expect(result.code).toBe(1)
    expect(result.err).toContain('确认所有旧版 runner 已退出后移除 .chief-runner/lock')
    expect(f.requests()).toEqual([])
    rmSync(f.legacy, { recursive: true })
    expect(await f.launch().result).toEqual({ code: 0, out: '', err: '' })
  })

  it('仍存活的旧版进程锁不会被接管或删除', async () => {
    const f = fixture()
    f.oldLock(String(process.pid))
    const result = await f.launch().result
    expect(result.code).toBe(1)
    expect(result.err).toContain('已有 runner 在运行')
    expect(readFileSync(join(f.legacy, 'pid'), 'utf8')).toBe(String(process.pid))
    expect(f.requests()).toEqual([])
  })

  it('同目录并发运行被拒绝，持锁进程崩溃后无需删除标记即可恢复同一次领取', async () => {
    const f = fixture(), ready = join(f.root, 'ready'), release = join(f.root, 'release')
    const owner = f.launch({ PULL_READY: ready, PULL_RELEASE: release })
    await until(() => existsSync(ready))
    const other = await f.launch().result
    expect(other.code).toBe(1)
    expect(other.err).toContain('已有 runner 在运行')
    expect(f.requests()).toHaveLength(1)
    owner.child.kill('SIGKILL')
    await owner.result
    expect(await f.launch().result).toEqual({ code: 0, out: '', err: '' })
    expect(f.requests()).toHaveLength(2)
    expect(f.requests()[0]).toEqual(f.requests()[1])
  })

  it('两个同时回收同一旧锁的进程不会删除彼此的新锁', async () => {
    const f = fixture(), staleA = join(f.root, 'stale-a'), staleB = join(f.root, 'stale-b')
    const releaseA = join(f.root, 'release-a'), releaseB = join(f.root, 'release-b'), ready = join(f.root, 'pull-ready'), release = join(f.root, 'pull-release')
    f.oldLock('2147483647')
    const owner = f.launch({ STALE_READY: staleA, STALE_RELEASE: releaseA, PULL_READY: ready, PULL_RELEASE: release })
    await until(() => existsSync(staleA))
    const other = f.launch({ STALE_READY: staleB, STALE_RELEASE: releaseB, PULL_READY: join(f.root, 'other-pull'), PULL_RELEASE: release })
    await until(() => Boolean(other.outcome) || existsSync(staleB))
    writeFileSync(releaseA, '')
    await until(() => existsSync(ready))
    writeFileSync(releaseB, '')
    await until(() => Boolean(other.outcome) || f.requests().length > 1)
    expect(f.requests()).toHaveLength(1)
    expect((await other.result).err).toContain('已有 runner 在运行')
    writeFileSync(release, '')
    expect(await owner.result).toEqual({ code: 0, out: '', err: '' })
  })

  it('最后的已发送状态落盘后直到本轮清理结束都继续持锁', async () => {
    const f = fixture(), id = randomUUID(), file = join(f.dir, `${id}.json`), ready = join(f.root, 'sent-ready'), release = join(f.root, 'sent-release')
    writeFileSync(file, JSON.stringify({ state: 'completed', task: { ticketId: 'T-0001', assignmentId: id, prompt: '任务' }, report: { status: 'ready', summary: '完成' } }))
    const owner = f.launch({ SENT_FILE: file, SENT_READY: ready, SENT_RELEASE: release })
    await until(() => existsSync(ready))
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('sent')
    const other = await f.launch().result
    expect(other.code).toBe(1)
    expect(other.err).toContain('已有 runner 在运行')
    expect(f.requests()).toHaveLength(1)
    writeFileSync(release, '')
    expect(await owner.result).toEqual({ code: 0, out: '', err: '' })
    expect(await f.launch().result).toEqual({ code: 0, out: '', err: '' })
    expect(f.requests().filter(args => args[3] === 'push')).toHaveLength(1)
  })

  it('同一进程再次调用时同样互斥，结束后可以重新调用', async () => {
    const f = fixture(), source = `import assert from 'node:assert/strict'
import { runOnce } from ${JSON.stringify(new URL('../bin/runner.mjs', import.meta.url).href)}
let release
const transport = { root: process.env.CHIEF_WORKDIR, pull: async () => new Promise(resolve => { release = resolve }), push: async () => {}, execute: async () => '' }
const owner = runOnce(transport)
await new Promise(resolve => setImmediate(resolve))
await assert.rejects(runOnce(transport), /已有 runner 在运行/)
release({}); await owner
await runOnce({ ...transport, pull: async () => ({}) })
`
    expect(await start(['--input-type=module', '-e', source], { CHIEF_WORKDIR: f.work }).result).toEqual({ code: 0, out: '', err: '' })
  })
})
