/** Exercise Codex App Server approval routing through a packaged plugin and real DSH host. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileStore } from '../src/core/store.ts'
import { acceptanceHost, until } from './acceptance-host.mjs'

const endpoint = '/settings/approvals'
const host = await acceptanceHost()
const executable = join(host.work, 'codex-fixture')
let browser
try {
  host.install('@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1')
  writeFileSync(executable, `#!/usr/bin/env node
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const audit = ${JSON.stringify(join(host.work, 'codex-audit'))}
assert.deepEqual(process.argv.slice(2), ['-c','sandbox_workspace_write.writable_roots=[]','-c','sandbox_workspace_write.network_access=false','-c','features.multi_agent=false','-c','features.multi_agent_v2=false','-c','features.multi_agent_v2.disable_native_tools=true','app-server','--stdio'])
const send = value => console.log(JSON.stringify(value))
const threadId = 'fixture-thread', turnId = 'fixture-turn'
const frame = (method, params) => send({ method, params: { threadId, turnId, ...params } })
const request = (id, params) => send({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command-' + id, ...params } })
const ticket = process.cwd().split('/').at(-1)
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params, result } = JSON.parse(line)
  if (method === 'initialize') send({ id, result: {} })
  if (method === 'thread/start') {
    assert.equal(params.sandbox, 'workspace-write')
    assert.equal(params.approvalPolicy, 'on-request')
    assert.equal(params.approvalsReviewer, 'user')
    assert.equal(params.ephemeral, true)
    send({ id, result: { thread: { id: threadId, ephemeral: true }, sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] }, approvalPolicy: 'on-request' } })
  }
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: turnId } } })
    if (ticket === 'T-0055') {
      // Codex 0.170 offers no decline for an escalated command; chief must still answer decline.
      request('expire', { cwd: process.cwd(), command: 'printf "needs network ' + ticket + '"', reason: '需要联网',
        availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf'] } }, 'cancel'] })
      return
    }
    const params ={ cwd: process.cwd(), command: 'printf "isolated fixture ' + ticket + '"', reason: '隔离夹具命令', availableDecisions: ['accept', 'acceptForSession', 'decline'] }
    request('aggregate', { ...params, networkApprovalContext: { host: 'example.invalid', protocol: 'https' } })
    request('unbound', { ...params, threadId: 'another-thread', availableDecisions: ['accept', 'cancel', 'decline'] })
    request('first', params)
    request('first', params)
  }
  if (result?.decision) {
    appendFileSync(audit, JSON.stringify({ ticket, id, decision: result.decision }) + '\\n')
    if (id === 'aggregate' || id === 'unbound') return
    if (ticket === 'T-0051' && id === 'first' && result.decision === 'accept') {
      request('next', { cwd: process.cwd(), command: 'printf "separate fixture"', reason: '第二条独立命令' })
      return
    }
    if (ticket === 'T-0055') {
      // Emulate a build that still ends the turn after the refusal, without a native error.
      frame('turn/completed', { turn: { id: turnId, status: 'interrupted', error: null } })
      return
    }
    if (ticket === 'T-0054') {
      frame('turn/completed', { turn: { id: turnId, status: 'failed', error: { codexErrorInfo: 'streamDisconnected', message: 'fixture transport error' } } })
      return
    }
    const fence = String.fromCharCode(96).repeat(3)
    const text = fence + 'chief-report\\n' + JSON.stringify({ status: 'blocked', summary: '隔离夹具已完成权限决定验证。' }) + '\\n' + fence
    frame('item/completed', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text } })
    frame('turn/completed', { turn: { id: turnId, status: 'completed', error: null } })
  }
})
`, { mode: 0o700 })
  writeFileSync(join(host.home, 'profiles/web/cordis.patch.yml'),
    '- id: dsh-chief\n  config:\n    codex:\n      executable: ' + JSON.stringify(executable) + '\n')
  await host.start()
  await host.api('/staff', { id: 'engineer', name: '工程师', executor: 'codex', brief: '验证隔离命令的单次审批。' })
  await host.stop()
  const store = new FileStore(host.brain)
  for (const [idx, action] of ['批准一次', '拒绝', '停止'].entries()) {
    const id = 'T-005' + (idx + 1), at = '2026-11-17T04:00:00Z'
    const title = '验证 Codex 命令审批 · ' + action
    store.appendEvent({ id, at, source: 'inbox', dedupe: id, text: title })
    store.setDisposition(id, { kind: 'accepted', ticketId: id })
    store.saveTicket({ id, title, staff: 'engineer', requestedExecutor: 'codex', createdAt: at, priority: 3 - idx, events: [id], inputs: [], assignments: [],
      mandate: { eventId: id, scope: '验证隔离夹具的命令通信', level: 'think', strength: 'explicit', needsReview: true, doneWhen: ['验证权限决定'] } })
  }
  await host.start()
  const pending = (ticket, command) => until(async () =>
    (await host.api(endpoint)).find(row => row.ticket === ticket && (!command || row.command.includes(command))), `${ticket} Codex 原生命令申请`)
  const audit = () => {
    try { return readFileSync(join(host.work, 'codex-audit'), 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row)) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  const allow = await pending('T-0051')
  const deny = await pending('T-0052')
  assert.equal(allow.executor, 'codex')
  assert.equal(allow.workdir, join(host.brain, 'work', allow.ticket))
  // Default window and an owner reminder raised when Codex asks, with no browser open.
  assert.equal(Date.parse(allow.expiresAt) - Date.parse(allow.requestedAt), 30 * 60_000)
  const reminder = key => until(async () => (await host.api('/chat')).notices.find(row => row.key === key), `${key} 审批提醒`)
  const asked = await reminder(`approval:${allow.ticket}:${allow.id}`)
  assert.equal(asked.ticketId, allow.ticket)
  assert.match(asked.text, /^命令待审批：工程师在「验证 Codex 命令审批 · 批准一次」（T-0051）申请运行 printf "isolated fixture T-0051"。\d{2}:\d{2} 前未处理会过期/)
  assert.equal(asked.done, undefined)
  assert.equal((await host.api(endpoint)).length, 2)
  assert.deepEqual(audit().filter(row => row.id === 'first'), [])
  assert.equal((await host.api(endpoint, undefined, { login: '', raw: true })).status, 401)
  assert.equal((await host.api(endpoint, { id: allow.id, allow: true }, { marked: false, raw: true })).status, 403)

  const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.context().addCookies(host.cookie().split('; ').map(item => ({ name: item.split('=')[0], value: item.slice(item.indexOf('=') + 1), url: host.base })))
  await page.goto(host.base)
  const panel = page.getByRole('region', { name: '命令权限审批' })
  const card = id => panel.locator('article').filter({ hasText: id })
  await card(allow.ticket).locator('pre').waitFor()
  assert.equal(await card(allow.ticket).locator('pre').textContent(), allow.command)
  await card(allow.ticket).getByText(/仅这条命令会解除 Codex 沙箱限制/).waitFor()
  const screenshots = process.env.CHIEF_SCREENSHOT_DIR
  if (screenshots) {
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'codex-approval-desktop.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(screenshots, 'codex-approval-mobile.png') })
  }
  await card(deny.ticket).getByRole('button', { name: '拒绝', exact: true }).click()
  const cancelled = await pending('T-0053')
  const thread = await host.api('/tickets/T-0053/thread')
  await host.api('/tickets/T-0053/stop', { reason: '隔离验证', thread_id: thread.thread_id, reply_to: thread.reply_to, stage: thread.stage })
  await until(async () => !(await host.api(endpoint)).some(row => row.id === cancelled.id), '停止后撤下 Codex 审批')
  assert.equal((await host.api(endpoint, { id: cancelled.id, allow: true }, { raw: true })).status, 409)

  await card(allow.ticket).getByRole('button', { name: '仅允许本次命令' }).click()
  const next = await pending('T-0051', 'separate fixture')
  assert.notEqual(next.id, allow.id)
  assert.equal((await host.api(endpoint, { id: allow.id, allow: true }, { raw: true })).status, 409)
  assert.deepEqual(audit().filter(row => row.id === 'first').map(row => [row.ticket, row.decision]).sort(), [[allow.ticket, 'accept'], [deny.ticket, 'decline']])
  assert.equal(audit().some(row => row.id === 'next'), false)
  assert.ok(audit().filter(row => row.id === 'aggregate').every(row => row.decision === 'decline'))
  await card(allow.ticket).getByRole('button', { name: '拒绝', exact: true }).click()
  await until(() => audit().find(row => row.id === 'next' && row.decision === 'decline'), '第二条命令由独立决定处理')
  assert.ok(audit().filter(row => row.id === 'unbound').every(row => row.decision === 'decline'))
  const original = await until(async () => {
    const view = await host.api('/tickets/T-0051/thread')
    return view.stage === 'you/blocked' ? view : undefined
  }, '获取原工单和持久审批记录')
  assert.deepEqual(original.executions.at(-1).approvals.map(item => item.status),
    ['unsupported', 'out-of-scope', 'requested', 'allowed-once', 'requested', 'rejected'])
  assert.equal(original.executions.at(-1).approvals.find(item => item.id === allow.id && item.status === 'requested')?.command, allow.command)
  assert.deepEqual(await reminder(`approval:${allow.ticket}:${allow.id}`).then(row => [row.status, row.done]), ['已允许本次', true])
  const plan = { thread_id: original.thread_id, reply_to: original.reply_to, stage: original.stage,
    checkpoint: '已核对夹具首段产出', groups: [{ key: 'next', title: '下一组', scope: '只执行第二组隔离夹具' }] }
  assert.equal((await host.api('/tickets/T-0051/execution%2Dplan', plan, { marked: false, raw: true })).status, 403)
  await host.api('/tickets/T-0051/execution-plan', plan)
  const planned = await until(async () => (await host.api('/tickets/T-0051')).groups?.[0], '原工单显示原生分组')
  const child = await pending(planned.id)
  assert.match(child.title, /下一组/)
  assert.equal((await host.api('/tickets/T-0051')).stage, 'waiting')
  await host.api(endpoint, { id: child.id, allow: false })
  const failure = await until(async () => (await host.api('/tickets/' + child.ticket)).ticket.assignments.at(-1)?.report, '原生回合失败单独回传')
  assert.match(failure.summary, /Codex 回合失败（streamDisconnected）/)
  assert.doesNotMatch(failure.summary, /mode: never/)
  assert.equal((await host.api('/tickets/T-0051')).stage, 'waiting')

  // Expiry: a one-minute window from the plugin config. Chief answers decline, and a turn that
  // still ends is reported as waiting for the owner with the expired command, not an executor fault.
  await host.stop()
  writeFileSync(join(host.home, 'profiles/web/cordis.patch.yml'),
    '- id: dsh-chief\n  config:\n    approvalTimeoutMinutes: 1\n    codex:\n      executable: ' + JSON.stringify(executable) + '\n')
  {
    const id = 'T-0055', at = '2026-11-17T04:00:00Z', title = '验证 Codex 命令审批 · 过期'
    store.appendEvent({ id, at, source: 'inbox', dedupe: id, text: title })
    store.setDisposition(id, { kind: 'accepted', ticketId: id })
    store.saveTicket({ id, title, staff: 'engineer', requestedExecutor: 'codex', createdAt: at, priority: 9, events: [id], inputs: [], assignments: [],
      mandate: { eventId: id, scope: '验证隔离夹具的命令审批过期', level: 'think', strength: 'explicit', needsReview: true, doneWhen: ['验证过期处理'] } })
  }
  await host.start()
  const expiring = await pending('T-0055')
  assert.equal(Date.parse(expiring.expiresAt) - Date.parse(expiring.requestedAt), 60_000)
  await reminder(`approval:T-0055:${expiring.id}`)
  const blocked = await until(async () => {
    const view = await host.api('/tickets/T-0055/thread')
    return view.stage === 'you/blocked' ? view : undefined
  }, '审批过期后工单等待主人', 120_000)
  const report = (await host.api('/tickets/T-0055')).ticket.assignments.at(-1).report
  assert.equal(report.status, 'blocked')
  assert.match(report.summary, /^命令审批未在 1 分钟内处理已过期：printf "needs network T-0055"（\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC 申请）。工作未完成，需要你处理后重试本工单。/)
  assert.doesNotMatch(report.summary, /执行者异常|category: unknown/)
  assert.deepEqual(blocked.executions.at(-1).approvals.map(item => item.status), ['requested', 'expired'])
  assert.deepEqual(audit().filter(row => row.ticket === 'T-0055').map(row => row.decision), ['decline'])
  assert.deepEqual(await reminder(`approval:T-0055:${expiring.id}`).then(row => [row.status, row.done]), ['已过期', true])
  console.log('PASS Codex 原生子代理、受限启动、自动展开、单次批准、拒绝、停止、重复与范围外请求、审批提醒与过期转受阻')
} catch (error) {
  console.error(host.logs().split('\n').filter(row => /chief|codex/i.test(row)).slice(-35).join('\n'))
  throw error
} finally {
  await browser?.close()
  await host.stop()
}
