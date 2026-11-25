#!/usr/bin/env node
/**
 * 冒烟测试：把打好的包装进一个全新的 DSH_HOME，真的起一个 DSH，按陌生用户的路径走一遍。
 *
 *   node scripts/smoke.mjs [--tarball dsh-chief-x.y.z.tgz] [--keep]
 *
 * 不给 --tarball 就先 npm pack。需要 PATH 里有 dsh（Node 24+）。不测接口人对话（那要模型）。
 * 检查：
 *   1. 装好启动后 /state 是"待初始化"
 *   2. 选定文件夹后建好第二大脑（宪法、目标、规则、7 位幕僚、git），状态正常
 *   3. 开启手机访问并设密码：能登录，拿不到设置类接口
 *   4. 界面定制：改主色、隐藏区块后状态立刻带上；撤销后恢复
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const keep = args.includes('--keep')
const work = mkdtempSync(join(tmpdir(), 'chief-smoke-'))
const home = join(work, 'home'), brain = join(work, 'brain')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
delete env.CHIEF_NOTIFY_URL
let dsh
let failed = 0

const step = text => console.log(`· ${text}`)
const check = (ok, text, detail = '') => { console.log(`  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? `：${detail}` : ''}`); if (!ok) failed++ }
const freePort = () => new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cleanup() {
  if (dsh && dsh.exitCode === null) { try { process.kill(-dsh.pid, 'SIGTERM') } catch { /* 已退出 */ } await sleep(1500) }
  if (keep) console.log(`保留现场：${work}`)
  else rmSync(work, { recursive: true, force: true })
}

try {
  let tarball = valueOf('--tarball')
  if (!tarball) {
    step('打包（npm pack）')
    const out = execFileSync('npm', ['pack', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    tarball = join(work, out.trim().split('\n').at(-1))
  }
  tarball = resolve(tarball)
  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean)
  check(files.includes('package/lib/index.js') && files.includes('package/lib/client.js') && files.includes('package/lib/mobile/app.js'), '包里有构建产物')
  check(files.includes('package/templates/brain/AGENTS.md') && files.includes('package/templates/brain/gitignore'), '包里有模板')
  check(!files.some(f => /^package\/(src|test|scripts|preview|docs)\//.test(f)), '包里没有源码、测试和开发脚本')

  step('装进全新的 DSH_HOME')
  execFileSync('dsh', ['plugin', '--profile', 'web', 'add', tarball], { env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 300_000 })

  if (args.includes('--native-team')) {
    const probe = join(work, 'native-team-probe'); mkdirSync(probe)
    writeFileSync(join(probe, 'package.json'), JSON.stringify({ name: 'chief-native-team-probe', version: '1.0.0', type: 'module', main: 'index.mjs', dsh: { manifestVersion: 1, bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(probe, 'cordis.patch.yml'), '- insert:\n    - id: chief-native-team-probe\n      name: chief-native-team-probe\n')
    copyFileSync(join(ROOT, 'scripts/native-team-probe.mjs'), join(probe, 'index.mjs'))
    execFileSync('dsh', ['plugin', '--profile', 'web', 'add', probe], { env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 60000 })
  }

  const port = await freePort()
  step(`启动 dsh web（端口 ${port}）`)
  let log = ''
  dsh = spawn('dsh', ['web', '--no-open', '--port', String(port)], { env, cwd: work, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  dsh.stdout.on('data', d => { log += d })
  dsh.stderr.on('data', d => { log += d })
  let token
  for (let i = 0; i < 120 && !token; i++) { await sleep(500); token = [...log.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]; if (dsh.exitCode !== null) break }
  if (!token) throw new Error(`DSH 没有启动：\n${log.slice(-3000)}`)
  const base = `http://127.0.0.1:${port}`
  const login = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  const call = async (path, body) => {
    const res = await fetch(`${base}/chief/api${path}`, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-chief-request': '1' }, body: JSON.stringify(body) })
    const text = await res.text()
    let value = {}
    try { value = JSON.parse(text) } catch { value = { raw: text } }
    return { status: res.status, value }
  }

  let state
  for (let i = 0; i < 60; i++) { state = await call('/state'); if (state.status === 200) break; await sleep(500) }
  check(state.status === 200 && state.value.setup, '1. 启动后是"待初始化"', JSON.stringify(state.value).slice(0, 300))
  check(state.value.setup?.suggested === '~/chief-brain', '   建议的位置是 ~/chief-brain')
  check((await call('/chat')).status === 409, '   初始化前其他接口回"还没选"')

  step('选定第二大脑的位置')
  check((await call('/setup', { dir: 'relative/path' })).status === 400, '   相对路径被拒绝')
  check(!('settings' in state.value), '   状态里不带设置')
  const setup = await call('/setup', { dir: brain })
  check(setup.status === 200 && setup.value.kind === 'created', '2. 建好第二大脑', JSON.stringify(setup.value))
  for (const f of ['AGENTS.md', 'goals.md', 'rules.yaml', '.gitignore', 'staff/chief.md']) check(existsSync(join(brain, f)), `   有 ${f}`)
  check(readdirSync(join(brain, 'staff')).filter(n => n.endsWith('.md')).length === 7, '   7 位默认幕僚')
  check(existsSync(join(brain, '.git')), '   是 git 仓库')
  state = await call('/state')
  check(state.status === 200 && !state.value.setup && Array.isArray(state.value.staff) && state.value.staff.length === 7, '   状态正常，幕僚团就位', JSON.stringify(state.value).slice(0, 300))
  check(state.value.dev === false, '   从 npm 包安装不是开发模式')
  check((await call('/setup', { dir: brain })).status === 409, '   不能重复初始化')

  step('原生 DSH 团队讨论')
  const nativeRoom = await call('/rooms', { request_id: 'native-smoke-room', title: '原生团队验收' })
  check(nativeRoom.status === 200 && nativeRoom.value.session?.startsWith('chief-room-'), '   讨论绑定 DSH 原生根会话', JSON.stringify(nativeRoom.value))
  const roomView = await call('/rooms/native-smoke-room')
  check(roomView.status === 200 && roomView.value.members?.some(m => m.role === 'lead') && Array.isArray(roomView.value.tasks), '   读取原生团队成员与共享任务', JSON.stringify(roomView.value).slice(0, 300))
  const reopenedRoom = await call('/rooms', { request_id: 'native-smoke-room', title: '原生团队验收' })
  check(reopenedRoom.value.session === nativeRoom.value.session, '   相同请求保持同一个原生会话')

  if (args.includes('--native-team')) {
    const response = await fetch(`${base}/chief-native-team-probe`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-chief-request': '1' }, body: JSON.stringify({ session: nativeRoom.value.session }) })
    const transport = await response.json()
    check(response.ok && transport.received && transport.members.length === 3 && transport.receipt, '   原生团队创建两名子代理并按真实作者完成 agent-to-agent 投递', JSON.stringify(transport))
    check(transport.humanAccepted && transport.humanCount === 1, '   主人定向补充通过原生子代理接口接收', JSON.stringify(transport))
    const input = { session: nativeRoom.value.session, request_id: 'human-room-request', to: 'engineer', text: 'human-native-idempotent-probe' }
    await Promise.all([call('/rooms/native-smoke-room', input), call('/rooms/native-smoke-room', input)])
    const projected = await call('/rooms/native-smoke-room')
    check(projected.value.messages?.filter(m => m.text === input.text).length === 1, '   依据原生已接受消息去重，重复主人请求只投递一次')
    check(projected.value.messages?.some(m => m.author === 'researcher' && m.to === 'engineer' && m.text.includes('native-a2a-acceptance-message')), '   幕僚室从真实 DSH 子会话日志投影同一条定向消息', JSON.stringify(projected.value).slice(0, 300))
  }

  step('同名工单的独立对话')
  check((await call('/pause', { paused: true })).status === 200, '   暂停真实模型调度')
  const line = (await call('/lines', { name: 'smoke-line' })).value.id
  const issue = async requestId => (await call(`/lines/${line}/commission`, { text: '隔离测试', title: '同名任务', staff: 'strategist', requestId })).value.ticketId
  const first = await issue('smoke-first'), second = await issue('smoke-second')
  const threadPath = id => `/tickets/${id}/thread`
  const firstThread = (await call(threadPath(first))).value
  const secondThread = (await call(threadPath(second))).value
  check(first && second && first !== second && firstThread.thread_id && firstThread.thread_id !== secondThread.thread_id, '   同名工单具有独立讨论标识')
  const reply = { thread_id: firstThread.thread_id, ticket_id: first, reply_to: firstThread.reply_to, execution_boundary: firstThread.execution_boundary, request_id: 'smoke-answer', text: '只交给第一张工单' }
  check((await call(threadPath(second), reply)).status === 409, '   拒绝投到另一张工单')
  check((await call(threadPath(first), reply)).status === 200, '   第一张工单收到回复')
  const retried = await call(threadPath(first), reply)
  check(retried.status === 200 && retried.value.messages?.filter(m => m.request_id === reply.request_id).length === 1, '   同一请求重试只产生一条回复')
  const other = (await call(threadPath(second))).value
  check(other.messages?.every(m => m.text !== reply.text), '   第二张工单没有收到该内容')

  step('手机访问')
  const mport = await freePort()
  check((await call('/settings', { mobile: { enabled: true, port: mport, host: '127.0.0.1' } })).status === 200, '   开启')
  check((await call('/settings/password', { password: 'smoke-test-password' })).status === 200, '   设密码')
  const settings = (await call('/settings')).value
  check(settings.liaisonTools?.guardInstalled === true && settings.liaisonTools?.requestAudit === 'available', '   接口人工具拦截与请求观测已装上')
  check(!('liaisonTools' in state.value), '   工具诊断仅在设置页提供')
  check(settings.mobile?.running === true && settings.mobile.hasPassword === true && !JSON.stringify(settings).includes('scrypt'), '   在运行，密码只存哈希', JSON.stringify(settings.mobile))
  const m = `http://127.0.0.1:${mport}`
  const bad = await fetch(`${m}/login`, { method: 'POST', body: 'password=wrong', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' })
  check(bad.status === 401, '   错误密码进不去')
  const ok = await fetch(`${m}/login`, { method: 'POST', body: 'password=smoke-test-password', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' })
  const mcookie = ok.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  check(ok.status === 303 && mcookie.startsWith('chief_gw='), '3. 正确密码能登录')
  const mstate = await fetch(`${m}/chief/api/state`, { headers: { cookie: mcookie } })
  const mbody = await mstate.json()
  check(mstate.status === 200 && Array.isArray(mbody.staff), '   手机上能看作战台')
  check(!('settings' in mbody) && !JSON.stringify(mbody).includes('scrypt'), '   手机上的状态不带设置')
  check((await fetch(`${m}/chief/api/settings`, { headers: { cookie: mcookie } })).status === 403, '   手机上拿不到设置')
  check((await fetch(`${m}/chief/api/settings/password`, { method: 'POST', headers: { cookie: mcookie, 'x-chief-request': '1', 'content-type': 'application/json' }, body: '{"password":"hijacked-password"}' })).status === 403, '   手机上改不了密码')
  check((await fetch(`${m}/`, { headers: { cookie: mcookie } })).status === 200 && (await fetch(`${m}/app.js`, { headers: { cookie: mcookie } })).status === 200, '   手机页面能打开')
  check((await fetch(`${m}/api/sessions`, { headers: { cookie: mcookie } })).status === 404, '   DSH 自己的接口不经过手机端口')

  step('不带外壳的作战台（/chief/m/）')
  check((await fetch(`${base}/chief/m/`, { headers: { cookie } })).status === 200 && (await fetch(`${base}/chief/m/app.js`, { headers: { cookie } })).status === 200, '   登录 DSH 后能打开')
  check((await fetch(`${base}/chief/m/`)).status === 401, '   没登录打不开')
  check((await fetch(`${base}/chief/m/../index.js`, { headers: { cookie } })).status !== 200, '   拿不到别的文件')

  step('界面定制')
  const set = await call('/custom', { theme: { accent: '#2255aa' }, layout: { hidden: ['events'] } })
  check(set.status === 200 && set.value.dropped?.length === 0, '   修改被接受', JSON.stringify(set.value))
  state = await call('/state')
  check(state.value.custom?.theme?.accent === '#2255aa' && state.value.custom.layout.hidden?.includes('events'), '4. 状态立刻带上新定制')
  check(existsSync(join(brain, 'ui', 'custom.json')), '   存在第二大脑的 ui/custom.json')
  await call('/custom/undo', {})
  state = await call('/state')
  check(!state.value.custom?.theme?.accent, '   撤销后恢复')

  step('关闭手机访问')
  await call('/settings', { mobile: { enabled: false } })
  let closed = false
  try { await fetch(`${m}/login`) } catch { closed = true }
  check(closed, '   端口已释放')
} catch (error) {
  console.error(`✗ ${error.message}`)
  failed++
} finally {
  await cleanup()
}
console.log(failed ? `\n✗ ${failed} 项没通过` : '\n✓ 冒烟测试全部通过')
process.exit(failed ? 1 : 0)
