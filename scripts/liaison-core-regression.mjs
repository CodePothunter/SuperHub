/**
 * 核心链路回归：对话 → 交办 / 讨论 → 讨论内只读调查与派工 → 命令审批通知、等你决定、过期转受阻。
 *
 * 在真实 DSH 0.2.2-rc.1 宿主上安装隔离候选包运行。模型回合由 liaison-core-probe.mjs 按 2026-11-19
 * 主人原话与接口人实际工具参数脚本化；每一次工具调用都经过 DSH 自己的工具管道（参数校验、守卫、
 * 无损 JSON 快照），所以返回值里的 undefined 等问题会像当天一样以 "invalid output" 暴露。
 * Codex 执行器由一个本地 App Server 夹具代替，审批与过期走插件的真实通道。
 *
 * 运行（与 CI 相同）：
 *   npm pack --ignore-scripts --pack-destination /tmp/core-pack
 *   CHIEF_ACCEPTANCE_PACKAGE=/tmp/core-pack/dsh-chief-<版本>.tgz \
 *   CHIEF_PLAYWRIGHT_PATH=/path/to/playwright/index.mjs [CHIEF_CHROMIUM_PATH=…] \
 *   node --experimental-transform-types scripts/liaison-core-regression.mjs
 *
 * 真实模型冒烟（不进 CI，部署前执行；需要日常 DSH 已有的 DeepSeek 凭据，只读取，不改日常 DSH）：
 *   … node --experimental-transform-types scripts/liaison-core-regression.mjs --live-model [deepseek-official/deepseek-flash]
 * 用同一批原话驱动隔离宿主里的真实接口人和讨论接口人（幕僚团保持暂停，不执行工单），打印每句原话
 * 引起的工具调用与结果；硬性检查只有：没有 invalid output / lossless，没有旧版的关键词拒绝。模型选择了别的
 * 工具、回合较慢等结果记为 INFO，不算失败。
 *
 * 可选：CHIEF_SCREENSHOT_DIR 保存截图；CHIEF_CORE_EVIDENCE=<文件> 保存逐项结果；CHIEF_CORE_EXPIRY_WAIT_MS 改变
 * 等待审批过期的上限（默认 150 秒，插件配置为 1 分钟；对比旧版本的 5 分钟固定过期时可调大）。
 * 每一项独立判定并继续执行，最后列出全部 PASS / FAIL；任一 FAIL 时退出码为 1。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileStore } from '../src/core/store.ts'
import { acceptanceHost, delay, until } from './acceptance-host.mjs'
import { signIn } from './workspace-browser-fixture.mjs'
import { INTRO_ANSWERS, INTRO_LIMIT, INTRO_REQUEST, INTRO_TITLE, leadScript, liaisonScript, ROOM_MEMBERS, SELF_REPORT, T0020_BRIEF } from './liaison-core-probe.mjs'

const argv = process.argv.slice(2)
const liveIndex = argv.indexOf('--live-model')
const live = liveIndex >= 0
const liveModel = live && argv[liveIndex + 1] && !argv[liveIndex + 1].startsWith('--') ? argv[liveIndex + 1] : 'deepseek-official/deepseek-flash'
if (argv.some((arg, index) => arg.startsWith('--') && arg !== '--live-model' || (!arg.startsWith('--') && index !== liveIndex + 1))) throw Error('用法：liaison-core-regression.mjs [--live-model [provider/model]]')
if (live && !existsSync(join(homedir(), 'workspace/dsh/home/.credentials.yaml'))) {
  console.log('SKIP --live-model：没有找到 DSH 服务凭据，真实模型冒烟未执行')
  process.exit(0)
}

const SAID = {
  staffCount: '我现在有几个幕僚？',
  models: '现在你和所有幕僚用的是什么模型？',
  selfReport: '你让他们自述一下',
  everyone: '让每个人汇报一下自己用的模型',
  memo: '记一下：周五和张三对一下季度报告的交接安排',
  write: '构建老是超时，你安排工程师修改构建脚本的超时配置，先别部署',
  contract: '让研究员汇总一下每位幕僚的模型配置',
  why: '为什么工程师老失败？',
  history: '自己看历史',
  sandbox: '让研究员沙箱核对一下第二大脑的目录结构',
  superhub: '让研究员分别汇报一下三家云厂商对象存储的价格',
}
for (const text of [SAID.staffCount, INTRO_REQUEST, SAID.models, SAID.selfReport, SAID.everyone, SAID.memo, SAID.write, SAID.sandbox, SAID.contract, SAID.superhub]) assert.ok(liaisonScript[text], `夹具缺少原话 ${text}`)
for (const text of [SAID.why, SAID.history, SAID.everyone]) assert.ok(leadScript[text], `夹具缺少原话 ${text}`)
const FALLBACK = 'T-0090'
const EXPIRY_WAIT = Number(process.env.CHIEF_CORE_EXPIRY_WAIT_MS) || 150_000
const OLD_REFUSALS = /请由主人明确提出建立或续接讨论|讨论原话已记录，请到 SuperHub 澄清/
/** Two staff with different configured models: a discussion member named after each must run on that model. */
const STAFF_MODELS = { researcher: 'deepseek-official/deepseek-v4-pro', strategist: 'deepseek-official/deepseek-flash' }
const DEFAULT_DENIED = ['修改配置、代码或数据', '部署或对外发送']
const FORMAT_ERRORS = /invalid output|lossless/i

const results = []
/** One independent assertion. `soft` results (real-model outcomes) are reported but do not fail the run. */
async function check(scenario, name, run, { soft = false } = {}) {
  try {
    const value = await run()
    results.push({ scenario, name, ok: true, ...soft ? { soft } : {} })
    console.log(`PASS [${scenario}] ${name}`)
    return value
  } catch (error) {
    const detail = String(error?.message ?? error).split('\n').slice(0, 6).join(' ').slice(0, 600)
    results.push({ scenario, name, ok: false, detail, ...soft ? { soft } : {} })
    console.log(`${soft ? 'INFO' : 'FAIL'} [${scenario}] ${name}：${detail}`)
    return undefined
  }
}
// With a real model the outcome depends on the model's choice of tools; only format and refusal checks are hard.
const outcome = { soft: live }

// DSH's workspace-write sandbox always allows /tmp and the temp directory: keep the brain outside both so the
// read-ticket check sees the real boundary (CHIEF_ACCEPTANCE_BASE overrides; removed after a passing run).
const directory = process.env.CHIEF_ACCEPTANCE_BASE ?? join(homedir(), '.cache', 'chief-acceptance')
const host = await acceptanceHost({ probe: 'liaison-core-probe.mjs', directory, mobile: !live, ...live ? { model: liveModel, extraEnv: { CHIEF_ACCEPTANCE_REAL_MODEL: '1' } } : {} })
console.log('Liaison core regression host', host.work, live ? `（真实模型 ${liveModel}）` : '（确定性模型夹具）')
const codexAudit = join(host.work, 'codex-audit')
const codexRows = () => existsSync(codexAudit) ? readFileSync(codexAudit, 'utf8').trim().split('\n').filter(Boolean).map(row => JSON.parse(row)) : []
if (!live) {
  host.install('@deepseek-ai/dsh-subagent-codex@0.2.2-rc.1')
  const executable = join(host.work, 'codex-fixture')
  // A Codex 0.170 App Server stand-in. The first command is denied by the owner; the second offers
  // only accept or cancel (as 0.170 does for escalations) and is left to expire.
  writeFileSync(executable, `#!/usr/bin/env node
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const audit = ${JSON.stringify(codexAudit)}
appendFileSync(audit, JSON.stringify({ argv: process.argv.slice(2), ticket: process.cwd().split('/').at(-1) }) + '\\n')
const send = value => console.log(JSON.stringify(value))
const threadId = 'core-thread', turnId = 'core-turn'
const request = (id, params) => send({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'command-' + id, cwd: process.cwd(), ...params } })
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, result } = JSON.parse(line)
  if (method === 'initialize') send({ id, result: {} })
  if (method === 'thread/start') send({ id, result: { thread: { id: threadId, ephemeral: true }, sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] }, approvalPolicy: 'on-request' } })
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: turnId } } })
    request('deny-me', { command: 'curl -sS https://ark.example.invalid/api/v3/models', reason: '需要联网核对方舟模型清单', availableDecisions: ['accept', 'acceptForSession', 'decline'] })
  }
  if (result && result.decision) {
    appendFileSync(audit, JSON.stringify({ id, decision: result.decision }) + '\\n')
    if (id === 'deny-me') request('expire-me', { command: 'node scripts/build.mjs --timeout 1800', reason: '需要在沙箱外运行构建，确认新的超时生效',
      availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['node'] } }, 'cancel'] })
    if (id === 'expire-me') send({ method: 'turn/completed', params: { threadId, turnId, turn: { id: turnId, status: 'interrupted', error: null } } })
  }
})
`, { mode: 0o700 })
  writeFileSync(join(host.home, 'profiles/web/cordis.patch.yml'),
    `- id: dsh-chief\n  config:\n    approvalTimeoutMinutes: 1\n    codex:\n      executable: ${JSON.stringify(executable)}\n`)
}

// The owner's real failing ticket, as the discussion lead would find it in history.
{
  const store = new FileStore(host.brain), at = '2026-11-19T09:13:00.000Z'
  store.appendEvent({ id: 'T-0001', at, source: 'inbox', dedupe: 'T-0001', text: 'C-0001 重跑 01–05：三组独立会话 + 逐题计时' })
  store.setDisposition('T-0001', { kind: 'accepted', ticketId: 'T-0001' })
  store.saveTicket({ id: 'T-0001', title: 'C-0001 重跑 01–05（隔离样例）', staff: 'engineer', requestedExecutor: 'codex', createdAt: at, priority: 2, events: ['T-0001'], inputs: [],
    assignments: [{ id: 'A-core-seed', staff: 'engineer', executor: 'codex', round: 0, startedAt: at, endedAt: '2026-11-19T09:18:00.000Z', state: 'reported',
      report: { status: 'blocked', summary: '执行者异常结束（error）：Codex 回合中断' } }],
    mandate: { eventId: 'T-0001', scope: '重跑 01–05 并逐题计时', level: 'think', strength: 'explicit', needsReview: true, doneWhen: ['逐题计时记录'] } })
  // Used for the approval checks only when the liaison could not register its own write ticket (an old build),
  // so a broken intake does not hide the executor-side results.
  store.appendEvent({ id: FALLBACK, at, source: 'inbox', dedupe: FALLBACK, text: '调大构建脚本超时（备用样例）' })
  store.setDisposition(FALLBACK, { kind: 'accepted', ticketId: FALLBACK })
  store.saveTicket({ id: FALLBACK, title: '调大构建脚本超时', staff: 'engineer', requestedExecutor: 'codex', createdAt: at, priority: 1, events: [FALLBACK], inputs: [], assignments: [],
    mandate: { eventId: FALLBACK, scope: '修改构建脚本的超时配置（备用样例）', level: 'propose', strength: 'explicit', needsReview: true, doneWhen: ['构建不再超时'] } })
}

let browser, page, calls = [], effective = {}
async function openBrowser() {
  if (browser) return browser
  const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch({ headless: true, ...process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {} })
  return browser
}
const probe = body => host.request('/chief-liaison-core-probe', body)
const records = () => probe({ action: 'records' })
const ticketIds = async () => {
  const state = await host.api('/state')
  return new Set([...state.you, ...state.queued, ...state.active, ...state.ended].map(row => row.id))
}
const receipts = async scope => (await host.api(`/superhub/items?scope=${scope}`)).receipts
const parse = text => { try { return JSON.parse(text) } catch { return undefined } }
const ok = (row, label = row?.name) => {
  assert.ok(row, `${label} 没有被调用`)
  assert.ok(row.text !== undefined, `${label} 没有返回`)
  assert.doesNotMatch(row.text, FORMAT_ERRORS, `${label} 返回了格式错误：${row.text.slice(0, 200)}`)
  assert.equal(row.isError, false, `${label} 报错：${row.text.slice(0, 300)}`)
  return row
}
/** Real-model hard check: a chief tool may refuse with an actionable reason, but never with a format error or an old keyword refusal. */
const clean = rows => {
  for (const row of rows.filter(row => row.name.startsWith('chief_'))) {
    assert.ok(row.text !== undefined, `${row.name} 没有返回`)
    assert.doesNotMatch(row.text, FORMAT_ERRORS, `${row.name} 返回了格式错误：${row.text.slice(0, 200)}`)
    assert.doesNotMatch(row.text, OLD_REFUSALS, `${row.name} 返回了旧版关键词拒绝：${row.text.slice(0, 200)}`)
  }
}
const describeRows = rows => rows.map(row => `    ${row.isError ? '✗' : '✓'} ${row.name} ${String(row.arguments).slice(0, 160)}\n      → ${String(row.text ?? '（无返回）').replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')

async function ownerTarget(scope, id) {
  const thread = await host.api(`/tickets/${id}/thread`)
  const detail = await host.api(`/tickets/${id}`)
  const version = detail.ticket.superhub?.contracts?.at(-1)?.version
  return { thread_id: thread.thread_id, reply_to: thread.reply_to, stage: thread.stage, ...detail.ticket.superhub ? { scope, contract_version: version } : {} }
}

/** Wait for the scripted calls of one owner message (fixture), or for the agent to go idle (live). */
async function settle(session, said, expected, idle) {
  const deadline = live ? 150_000 : 45_000
  const rows = await until(async () => {
    const all = (await records()).filter(row => row.session === session && row.owner === said)
    if (!live) return all.filter(row => row.text !== undefined).length >= expected && await idle() ? all : undefined
    return await idle() ? all : undefined
  }, `「${said}」的工具调用`, deadline).catch(async error => {
    console.log(describeRows((await records()).filter(row => row.session === session && row.owner === said)))
    throw error
  })
  if (live) await delay(1500)
  return (await records()).filter(row => row.session === session && row.owner === said)
}

try {
  await host.start()
  await host.api('/pause', { paused: true })
  if (!live) {
    await host.api('/staff', { id: 'engineer', name: '工程师', executor: 'codex', verifier: 'reviewer', brief: '写代码、读代码、做技术方案与原型。' })
    await host.api('/staff', { id: 'ui-smith', name: '界面师', executor: 'dsh', verifier: 'reviewer', brief: '制作 SuperHub 的界面。' })
  }
  if (!live) for (const [id, model] of Object.entries(STAFF_MODELS)) {
    const card = (await host.api('/state')).staff.find(row => row.id === id)
    await host.api('/staff', { id, name: card.name, executor: card.executor, verifier: card.verifier, brief: card.brief, model })
  }
  const state = await host.api('/state')
  const scope = state.superhubScope
  assert.ok(scope, '候选包没有给出当前 SuperHub 作用域')
  const liaison = (await host.api('/chat')).sessionId
  assert.ok(liaison, '没有接口人会话')
  /** The liaison has answered this owner message and is idle again. */
  const answered = said => async () => {
    const view = await host.api('/chat')
    const mine = view.messages.filter(message => message.role === 'you' && message.text.trim() === said).at(-1)
    return !view.busy && !!mine && view.messages.some(message => message.role === 'liaison' && message.seq > mine.seq)
  }
  /** Same payload as the web client: scoped chat with a stable request id. */
  const say = (text, scoped = true) => host.api('/chat', { text, mode: 'auto', sessionId: liaison, ...scoped ? { scope, request_id: randomUUID() } : {} })
  /** Scoped web chat records the original words and always hands them to the liaison (no pre-classification). */
  const originals = new Map()
  const liaisonTurn = async (text, scoped = true) => {
    const { receipt } = await say(text, scoped)
    if (scoped) {
      assert.deepEqual(receipt?.items?.map(item => [item.intent, item.state, item.ticketId ?? null]), [['conversation', 'conversation', null]], `网页对话预先分类了原话：${JSON.stringify(receipt?.items)}`)
      originals.set(text, receipt.id)
    }
    const rows = await settle(liaison, text, liaisonScript[text].flat().length, answered(text))
    console.log(`  「${text}」\n${describeRows(rows)}`)
    return rows
  }

  // ── 私聊：查模型 ──
  {
    const rows = await check('私聊查模型', '接口人收到原话并调用工具', () => liaisonTurn(SAID.models), outcome) ?? []
    await check('私聊查模型', 'chief_settings show 在未设推送地址时正常返回', () => {
      const row = ok(rows.find(row => row.name === 'chief_settings'), 'chief_settings')
      assert.ok(parse(row.text), `设置结果应为 JSON：${row.text.slice(0, 120)}`)
    }, outcome)
    await check('私聊查模型', 'chief_staff list 列出每位幕僚的生效模型与来源', () => {
      const row = ok(rows.find(row => row.name === 'chief_staff'), 'chief_staff')
      const staff = parse(row.text)?.staff ?? []
      assert.ok(staff.length >= 6, row.text.slice(0, 200))
      for (const card of staff) assert.ok(card.modelSource, `${card.id} 没有模型来源`)
      if (!live) {
        for (const [id, model] of Object.entries(STAFF_MODELS)) assert.deepEqual([staff.find(card => card.id === id)?.effectiveModel, staff.find(card => card.id === id)?.modelSource], [model, '幕僚卡'])
        assert.equal(staff.find(card => card.id === 'engineer')?.modelSource, 'Codex 配置')
        assert.equal(staff.find(card => card.id === 'liaison')?.modelSource, '远程，未知')
        assert.equal(staff.find(card => card.id === 'chief')?.modelSource, 'DSH 默认')
      }
      effective = Object.fromEntries(staff.map(card => [card.id, card]))
    }, outcome)
    if (live) await check('私聊查模型', '工具返回没有格式错误', () => clean(rows))
  }

  // ── 幕僚自我介绍：无需打开讨论，结果直接回到接口人对话 ──
  const intro = await check('自我介绍回报', '按原话先问幕僚人数，再交办自我介绍', async () => {
    const count = await liaisonTurn(SAID.staffCount)
    if (!live) assert.equal(parse(ok(count.find(row => row.name === 'chief_staff')).text).staff.length, 8)
    const rows = await liaisonTurn(INTRO_REQUEST)
    clean([...count, ...rows])
    const opened = parse(ok(rows.find(row => row.name === 'chief_room' && parse(row.arguments)?.action === 'discuss')).text)
    assert.ok(opened?.id && opened?.session, '自我介绍没有发出讨论回执')
    assert.equal(rows.some(row => row.name === 'chief_inbox'), false)
    if (!live) assert.equal(opened.title, INTRO_TITLE)
    return opened
  }, outcome)
  const introResult = intro && await check('自我介绍回报', '幕僚答复汇总后，同一段私聊主动显示正文与缺项', async () => {
    if (!live) await until(async () => (await records()).some(row => row.session === intro.session && row.callId === 'intro-room-result' && row.text !== undefined),
      '讨论组长收到实际答复并提交回报', 45_000)
    const viewChat = () => host.api(`/chat?scope=${encodeURIComponent(scope)}`)
    const result = await until(async () => (await viewChat()).discussionResults?.find(row => row.roomId === intro.id),
      '接口人原对话的自我介绍结果', live ? 60_000 : 5_000)
    assert.ok(result.text)
    if (!live) {
      assert.equal(result.status, 'partial')
      assert.ok(result.text.includes(INTRO_LIMIT))
      for (const text of Object.values(INTRO_ANSWERS)) assert.ok(result.text.includes(text), `回报缺少已收到的答复：${text}`)
      const tool = ok((await records()).find(row => row.session === intro.session && row.callId === 'intro-room-result'))
      assert.match(parse(tool.arguments).source, /^chief-room-[a-f0-9]+:/)
      const replies = (await host.api(`/rooms/${intro.id}`)).messages
      for (const [id, text] of Object.entries(INTRO_ANSWERS)) assert.ok(replies.some(reply => reply.author === id && reply.text.includes(text)), `讨论中缺少 ${id} 本人的发言`)
    }
    const refreshed = await viewChat()
    assert.deepEqual(refreshed.discussionResults.filter(row => row.roomId === intro.id), [result])
    assert.equal(refreshed.sessionId, liaison)
    return result
  }, outcome)
  if (!live && introResult) await check('自我介绍回报', '桌面与手机直接在接口人消息列表读到回报', async () => {
    const password = randomUUID()
    await host.api('/settings/password', { password })
    for (const mobile of [false, true]) {
      const client = await (await openBrowser()).newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        ...(mobile && { isMobile: true, hasTouch: true }) })
      try {
        if (!mobile) await signIn(client, host)
        await client.goto(mobile ? host.mobileBase : host.base)
        if (mobile) {
          await client.getByLabel('密码').fill(password)
          await client.getByRole('button', { name: '进入', exact: true }).click()
        }
        await client.getByRole('button', { name: /^一句话交办(，|$)/ }).click()
        const history = client.getByRole('dialog', { name: '接口人' }).getByRole('list', { name: '接口人对话' })
        await history.getByText(INTRO_ANSWERS.researcher, { exact: true }).waitFor()
        await history.getByText(INTRO_LIMIT, { exact: true }).waitFor()
        await history.getByRole('button', { name: '查看讨论过程', exact: true }).waitFor()
        assert.equal(await history.getByText(INTRO_ANSWERS.researcher, { exact: true }).count(), 1)
        assert.ok(await client.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      } finally { await client.close() }
    }
  })

  // ── 私聊：每个人各自回答 → 讨论（R8：不建单交给某一位幕僚代答） ──
  let everyoneRoom
  for (const [label, said, title] of [['私聊自述', SAID.selfReport, '幕僚自述当前模型'], ['私聊汇报', SAID.everyone, '幕僚模型自述']]) {
    const before = await ticketIds()
    const rows = await check(label, `「${said}」经接口人调用工具`, () => liaisonTurn(said), outcome) ?? []
    if (live) {
      await check(label, '工具返回没有格式错误或旧版关键词拒绝', () => clean(rows))
      continue
    }
    const room = await check(label, 'chief_room discuss 开出讨论，首条消息附主人原话', async () => {
      const row = ok(rows.find(row => row.name === 'chief_room' && /"discuss"/.test(row.arguments)), 'chief_room discuss')
      const opened = parse(row.text)
      assert.ok(opened?.id, `讨论结果缺少讨论标识：${row.text.slice(0, 200)}`)
      const room = (await host.api('/rooms')).find(item => item.title === title)
      assert.ok(room, `没有讨论「${title}」`)
      assert.equal(room.id, opened.id)
      const view = await until(async () => {
        const value = await host.api(`/rooms/${room.id}`)
        return value.messages.some(message => message.text.includes(said)) ? value : undefined
      }, '讨论首条消息', 20_000)
      const first = view.messages.find(message => message.text.includes(`主人原话：「${said}」`))
      assert.ok(first, '讨论里看不到主人原话')
      assert.doesNotMatch(first.text, /禁止：/, '讨论首条消息带进了主人没说过的禁止项')
      return room
    })
    await check(label, '没有建单交给某一位幕僚代答（没有 chief_inbox，没有新工单）', async () => {
      assert.equal(rows.filter(row => row.name === 'chief_inbox').length, 0)
      assert.deepEqual([...await ticketIds()].filter(id => !before.has(id)), [])
    })
    if (said === SAID.everyone) everyoneRoom = room
  }

  // ── 讨论成员按幕僚身份与幕僚卡模型运行，每位幕僚各自回答一次（生产讨论 ticket-T-0020 的成员名单） ──
  if (!live && everyoneRoom) {
    const roster = (await host.api('/state')).staff
    const local = ROOM_MEMBERS.filter(id => roster.find(card => card.id === id)?.executor === 'dsh')
    const external = ROOM_MEMBERS.filter(id => !local.includes(id))
    const view = await check('讨论成员', `讨论接口人以幕僚 id 拉起成员，${local.length} 位 DSH 幕僚各回答一次`, () => until(async () => {
      const value = await host.api(`/rooms/${everyoneRoom.id}`)
      const answers = value.messages.filter(message => message.text.startsWith(SELF_REPORT))
      return local.every(id => answers.some(message => message.author === id)) ? value : undefined
    }, '各成员回答', 90_000))
    await check('讨论成员', 'Codex、远程幕僚不由讨论成员冒充：拉起被拒并说明只能经工单运行', async () => {
      assert.ok(external.length >= 2, `夹具里应有 Codex 与远程幕僚：${external}`)
      const spawned = (await records()).filter(row => row.session === everyoneRoom.session && row.name === 'spawn_teammate')
      for (const id of external) {
        const row = spawned.find(item => parse(item.arguments)?.name === id)
        assert.ok(row?.isError, `${id} 的拉起没有被拒绝：${row?.text?.slice(0, 160)}`)
        assert.match(row.text, /只能经工单在那个执行器上运行/)
      }
      assert.deepEqual(view?.members.filter(member => member.role !== 'lead').map(member => member.name).sort(), [...local].sort())
    })
    await check('讨论成员', '每位成员的实际模型等于该幕僚的生效模型（两位幕僚卡模型不同），并注入了幕僚身份', async () => {
      const routes = await probe({ action: 'routes' })
      const members = view.members.filter(member => member.role !== 'lead')
      assert.notEqual(STAFF_MODELS.researcher, STAFF_MODELS.strategist)
      for (const member of members) {
        const rows = routes[member.id] ?? []
        assert.ok(rows.length, `${member.name} 没有模型请求`)
        const want = effective[member.name]?.effectiveModel
        assert.ok(want, `${member.name} 没有生效模型`)
        for (const row of rows) {
          assert.equal(`${row.provider}/${row.model}`, want, `${member.name} 的请求运行在 ${row.provider}/${row.model}`)
          assert.equal(`${row.current?.provider}/${row.current?.model}`, want, `${member.name} 的 agent.model.current() 是 ${JSON.stringify(row.current)}`)
        }
        assert.equal(rows[0].identity, member.name, `${member.name} 的系统提示没有幕僚身份`)
      }
      for (const [id, model] of Object.entries(STAFF_MODELS)) {
        const answers = view.messages.filter(message => message.author === id && message.text.startsWith(SELF_REPORT))
        assert.equal(answers.length, 1, `${id} 回答了 ${answers.length} 次`)
        assert.equal(answers[0].text, `${SELF_REPORT}${id}：本次实际运行 ${model}`)
      }
      console.log(`  成员模型：${members.map(member => `${member.name}=${routes[member.id]?.[0]?.provider}/${routes[member.id]?.[0]?.model}`).join('，')}`)
    })
  }

  // ── 一位幕僚做一件事：生产 T-0020 的任务说明不再产生「别汇报」禁止项 ──
  if (!live) {
    // 网页对话（带 scope）同样直达接口人：系统不预先分类，「让研究员汇总…」由接口人理解后建单。
    const rows = await check('契约', `「${SAID.contract}」建只读工单`, () => liaisonTurn(SAID.contract)) ?? []
    await check('契约', '契约禁止项只有默认项，scope 不含「别汇报」「不要猜测」类禁止条款', async () => {
      ok(rows.find(row => row.name === 'chief_inbox'), 'chief_inbox')
      const receipt = (await receipts(scope)).find(item => item.authorization?.ownerText === SAID.contract)
      assert.deepEqual([receipt?.authorization?.operation, receipt?.authorization?.restrictions], ['read', []])
      const view = await host.api(`/tickets/${receipt.items[0].ticketId}`)
      assert.deepEqual(view.ticket.superhub.contracts[0].denied, DEFAULT_DENIED)
      assert.ok(view.ticket.mandate.scope.includes(`接口人理解的任务：${T0020_BRIEF}`))
      assert.doesNotMatch(view.ticket.mandate.scope, /禁止：[^\n]*(别汇报|不要猜测)/)
      assert.equal(receipt.authorization.chatReceiptId, originals.get(SAID.contract), '接口人登记的回执没有挂回网页对话的原话回执')
      const original = await host.api(`/superhub/items/${originals.get(SAID.contract)}?scope=${scope}`)
      assert.deepEqual(original.linked?.map(row => row.id), [receipt.id])
    })
  }

  // ── SuperHub 交办页：主人直接写的一件事同样交给接口人理解，「分别」不会变成禁止项 ──
  if (!live) {
    const intake = await check('SuperHub 交办', '交办页的原话只记入原话回执并交给接口人', async () => {
      const receipt = await host.api('/superhub/items', { scope, requestId: randomUUID(), text: SAID.superhub })
      assert.equal(receipt.source.channel, 'owner')
      assert.deepEqual(receipt.items.map(item => [item.intent, item.state]), [['conversation', 'conversation']])
      const rows = await settle(liaison, SAID.superhub, liaisonScript[SAID.superhub].flat().length, answered(SAID.superhub))
      console.log(`  SuperHub「${SAID.superhub}」\n${describeRows(rows)}`)
      ok(rows.find(row => row.name === 'chief_inbox'), 'chief_inbox')
      return receipt
    })
    if (intake) await check('SuperHub 交办', '接口人登记的只读工单挂回原话回执，契约只有默认禁止项', async () => {
      const view = await until(async () => {
        const value = await host.api(`/superhub/items/${intake.id}?scope=${scope}`)
        return value.linked?.[0]?.items[0]?.ticketId ? value : undefined
      }, 'SuperHub 交办登记', 20_000)
      const work = view.linked[0]
      assert.deepEqual([work.authorization.operation, work.authorization.restrictions, work.authorization.chatReceiptId], ['read', [], intake.id])
      const ticket = await host.api(`/tickets/${work.items[0].ticketId}`)
      assert.equal(ticket.ticket.staff, 'researcher')
      assert.deepEqual(ticket.ticket.superhub.contracts[0].denied, DEFAULT_DENIED)
      assert.doesNotMatch(ticket.ticket.mandate.scope, /禁止：[^\n]*别/)
    })
  }

  // ── 备忘：只记录，不派工、不开讨论 ──
  {
    const before = await ticketIds(), roomsBefore = (await host.api('/rooms')).length
    // 网页对话的「记一下…」也交给接口人：由接口人判断只记下（intent=memo），系统不按关键词预先记录。
    const rows = await check('备忘', '网页对话里同一句话经接口人调用工具', () => liaisonTurn(SAID.memo), outcome) ?? []
    if (!live) {
      await check('备忘', 'chief_inbox（intent=memo）返回已记录、未派工及原因，回执挂在网页对话的原话回执下', async () => {
        const row = ok(rows.find(row => row.name === 'chief_inbox'), 'chief_inbox')
        assert.match(row.text, /已记下原话，未派工/)
        const receipt = (await receipts(scope)).find(item => item.authorization?.ownerText === SAID.memo)
        assert.deepEqual([receipt?.authorization?.intent, receipt?.items[0]?.state, receipt?.authorization?.chatReceiptId], ['memo', 'recorded', originals.get(SAID.memo)])
      })
    } else await check('备忘', '工具返回没有格式错误或旧版关键词拒绝', () => clean(rows))
    await check('备忘', '没有新工单、没有新讨论', async () => {
      assert.deepEqual([...await ticketIds()].filter(id => !before.has(id)), [])
      assert.equal((await host.api('/rooms')).length, roomsBefore)
    })
  }

  // ── 写入类交办：建单后等主人批准，批准前零执行 ──
  let writeTicket
  {
    const before = await ticketIds()
    const rows = await check('写入交办', '接口人交办修改构建脚本', () => liaisonTurn(SAID.write), outcome) ?? []
    writeTicket = await check('写入交办', '建单进入等你决定（待批准），回执记录主人原话', async () => {
      if (live) clean(rows)
      else assert.match(ok(rows.find(row => row.name === 'chief_inbox'), 'chief_inbox').text, /等主人在「等你决定」里批准/)
      const receipt = (await receipts(scope)).find(item => item.authorization?.ownerText === SAID.write)
      assert.ok(receipt?.items[0]?.ticketId, `没有建单：${receipt?.items[0]?.state ?? '无回执'} ${receipt?.items[0]?.question ?? receipt?.items[0]?.reason ?? ''}`)
      const id = receipt.items[0].ticketId
      assert.ok(!before.has(id))
      const view = await host.api(`/tickets/${id}`)
      assert.equal(view.stage, 'you/approve')
      assert.equal(view.ticket.assignments.length, 0, '批准前不得执行')
      if (!live) {
        assert.deepEqual([receipt.authorization.operation, receipt.authorization.restrictions], ['write', ['先别部署']])
        assert.deepEqual(view.ticket.superhub.contracts[0].denied, ['先别部署', '部署或对外发送'])
      }
      assert.ok((await host.api('/state')).you.some(card => card.id === id), '等你决定里没有这张工单')
      return id
    }, outcome)
  }

  // ── 本轮之外的调用：拒绝并说明 ──
  if (!live) {
    const before = await ticketIds()
    for (const [name, args] of [['chief_inbox', { text: '把构建脚本的超时改成 30 分钟', operation: 'write' }], ['chief_room', { action: 'discuss', title: '构建超时', text: '讨论构建超时' }]]) {
      await check('本轮之外', `${name} 在主人回合之外被拒绝并说明原因`, async () => {
        const result = await probe({ action: 'tool', session: liaison, name, args })
        assert.equal(result.ok, false, `应当拒绝：${JSON.stringify(result).slice(0, 200)}`)
        assert.match(result.message, /主人/)
        assert.doesNotMatch(result.message, FORMAT_ERRORS)
      })
    }
    await check('本轮之外', '没有新工单', async () => assert.deepEqual([...await ticketIds()].filter(id => !before.has(id)), []))
  }

  // ── 讨论：为什么工程师老失败 / 自己看历史 ──
  let historyTicket
  {
    const room = await host.api('/rooms', { request_id: 'core-why-engineer', title: '工程师为什么老失败' })
    const roomIdle = async () => {
      const view = await host.api(`/rooms/${room.id}`)
      const owner = view.messages.filter(message => message.author === 'you').at(-1)
      return !!owner && view.messages.some(message => message.author !== 'you' && message.seq > owner.seq && message.kind === 'status' && message.session === room.session)
    }
    const post = async text => {
      await host.api(`/rooms/${room.id}`, { session: room.session, request_id: randomUUID(), text })
      const rows = await settle(room.session, text, leadScript[text].flat().length, roomIdle)
      console.log(`  讨论「${text}」\n${describeRows(rows)}`)
      return rows
    }
    const why = await check('讨论', `「${SAID.why}」讨论接口人调用只读工具`, () => post(SAID.why), outcome) ?? []
    if (live) {
      await check('讨论', '工具返回没有格式错误或旧版拒绝', () => clean(why))
    } else {
      await check('讨论', 'chief_brief 在讨论里可用', () => ok(why.find(row => row.name === 'chief_brief'), 'chief_brief'))
      await check('讨论', 'chief_ticket view 看到工程师失败的工单与执行记录', () => {
        const row = ok(why.find(row => row.name === 'chief_ticket'), 'chief_ticket view')
        assert.match(row.text, /T-0001/)
        assert.match(row.text, /Codex 回合中断/)
        assert.match(row.text, /"rounds"/)
      })
    }
    const before = await ticketIds()
    const history = await check('讨论', `「${SAID.history}」讨论接口人提交只读调查`, () => post(SAID.history), outcome) ?? []
    historyTicket = await check('讨论', 'request_execution 声明 read 时只读直接派工，无需批准', async () => {
      if (live) clean(history)
      const receipt = (await receipts(scope)).find(item => item.authorization?.ownerText === SAID.history && item.authorization.roomId === room.id)
      if (!live) {
        const row = ok(history.find(row => row.name === 'chief_room_note' && /request_execution/.test(row.arguments)), 'request_execution')
        assert.match(row.text, /无需批准/)
      }
      assert.ok(receipt?.items[0]?.ticketId, `讨论派工没有建单：${receipt?.items[0]?.state ?? '无回执'}`)
      const id = receipt.items[0].ticketId
      assert.ok(!before.has(id))
      const view = await host.api(`/tickets/${id}`)
      assert.notEqual(view.stage, 'you/approve')
      assert.ok((await host.api(`/rooms/${room.id}`)).tickets.includes(id), '工单没有关联回讨论')
      return id
    }, outcome)
    // 讨论接口人在主人没有开口的回合里引用较早的主人原话：不得授权新工单。
    if (!live) await check('讨论', 'request_execution 在非主人触发的回合引用较早原话被拒绝并说明', async () => {
      await until(async () => (await host.api(`/rooms/${room.id}`)).members?.every(member => member.status !== 'running'), '讨论接口人本轮结束', 20_000)
      await delay(1000)
      const old = (await host.api(`/rooms/${room.id}`)).messages.filter(message => message.author === 'you' && message.text.includes(SAID.history)).at(-1)
      assert.ok(old, '没有找到较早的主人原话')
      const before = await ticketIds()
      const result = await probe({ action: 'tool', session: room.session, name: 'chief_room_note', args: { action: 'request_execution', source: old.id,
        title: '再查一次构建时长', staff: 'engineer', operation: 'read', scope: '只读调研构建时长分布；不修改配置、代码或数据。' } })
      assert.equal(result.ok, false, `应当拒绝：${JSON.stringify(result).slice(0, 200)}`)
      assert.match(result.message, /本轮不是由主人的消息触发.*ask_owner/)
      assert.doesNotMatch(result.message, FORMAT_ERRORS)
      assert.deepEqual([...await ticketIds()].filter(id => !before.has(id)), [])
    })
  }

  // ── 只读工单的执行者只能写本工单目录 ──
  let sandboxTicket, goalsBefore
  if (!live) {
    goalsBefore = readFileSync(join(host.brain, 'goals.md'), 'utf8')
    sandboxTicket = await check('只读工单沙箱', '接口人登记只读工单，无需批准', async () => {
      const rows = await liaisonTurn(SAID.sandbox)
      assert.doesNotMatch(ok(rows.find(row => row.name === 'chief_inbox'), 'chief_inbox').text, /未派工|未建单|批准/)
      const receipt = (await receipts(scope)).find(item => item.authorization?.ownerText === SAID.sandbox)
      const id = receipt?.items[0]?.ticketId
      assert.ok(id, `没有建单：${receipt?.items[0]?.state ?? '无回执'}`)
      const view = await host.api(`/tickets/${id}`)
      assert.equal(view.ticket.mandate.level, 'think')
      assert.notEqual(view.stage, 'you/approve')
      return id
    })
  }

  await check('全部', '所有 chief 工具返回都没有 invalid output / lossless', async () => {
    const bad = (await records()).filter(row => row.name.startsWith('chief_') && FORMAT_ERRORS.test(row.text ?? ''))
    assert.deepEqual(bad.map(row => `${row.name}: ${row.text.slice(0, 120)}`), [])
  })

  // ── 执行器命令审批：通知、等你决定、拒绝、过期转受阻 ──
  if (!live) {
    await check('命令审批', '使用接口人登记的写入工单', () => assert.ok(writeTicket, `接口人没有登记写入工单，改用备用样例 ${FALLBACK} 继续检查执行器审批`))
    writeTicket ??= FALLBACK
    // 只留下写入工单：其他只读工单由主人停止，避免夹具执行器处理它们。
    for (const card of (await host.api('/state')).queued.concat((await host.api('/state')).active)) {
      if (card.id === writeTicket || card.id === sandboxTicket) continue
      await host.api(`/tickets/${card.id}/stop`, { reason: '核心链路回归只保留写入工单', ...await ownerTarget(scope, card.id) }).catch(error => console.log('  停止', card.id, error.message))
    }
    await host.api('/pause', { paused: false })
    if (sandboxTicket) {
      const assignment = await check('只读工单沙箱', '研究员（DSH 子代理）执行结束并汇报', () => until(async () => {
        const first = (await host.api(`/tickets/${sandboxTicket}`)).ticket.assignments[0]
        return first && first.state !== 'running' ? first : undefined
      }, '只读工单执行', 90_000))
      const work = join(host.brain, 'work', sandboxTicket)
      const all = await records()
      const session = all.find(row => row.callId === 'sandbox-3' && row.arguments.includes(`/work/${sandboxTicket}/`))?.session
      const tried = all.filter(row => row.session === session && row.callId?.startsWith('sandbox-'))
      const result = (index) => tried.find(row => row.callId === `sandbox-${index}`)
      await check('只读工单沙箱', '越界写第二大脑被拒绝：goals.md 与 people/ 未改', () => {
        assert.equal(tried.filter(row => row.text !== undefined).length >= 6, true, `执行者的工具调用没有完成：${JSON.stringify(tried.map(row => [row.callId, row.isError, row.text?.slice(0, 80)]))}`)
        assert.equal(readFileSync(join(host.brain, 'goals.md'), 'utf8'), goalsBefore, 'goals.md 被执行者改写')
        assert.equal(existsSync(join(host.brain, 'people', 'sandbox-probe.md')), false, 'people/ 下出现了执行者写的文件')
        for (const index of [0, 1]) assert.equal(result(index).isError, true, `write 越界没有被拒绝：${result(index).text.slice(0, 200)}`)
        assert.match(result(1).text, /sandbox/i, `people/ 的写入不是被沙箱拒绝的：${result(1).text.slice(0, 200)}`)
        console.log(`  越界 write → ${result(0).text.replace(/\s+/g, ' ').slice(0, 160)}\n  越界 bash → ${result(2).text.replace(/\s+/g, ' ').slice(0, 160)}`)
      })
      await check('只读工单沙箱', '工单目录内的 write 与 bash 写入成功，交付已登记', () => {
        assert.equal(result(3).isError, false, result(3).text.slice(0, 200))
        assert.match(readFileSync(join(work, 'report.md'), 'utf8'), /只读核对完成/)
        assert.match(readFileSync(join(work, 'bash-report.md'), 'utf8'), /bash 工单目录/)
        assert.ok(assignment, '没有执行记录')
        assert.equal(assignment.report?.status, 'ready', JSON.stringify(assignment.report))
        assert.deepEqual(assignment.deliveries?.map(row => row.path), [`work/${sandboxTicket}/report.md`])
      })
      await check('只读工单沙箱', '工单桌下的执行者仍按幕僚身份受限，不能代主人停止工单', async () => {
        assert.equal(result(5).isError, true, result(5).text.slice(0, 200))
        assert.match(result(5).text, /幕僚团的执行者不能以主人身份/)
        assert.equal((await host.api('/tickets/T-0001')).ticket.ended, undefined, 'T-0001 被执行者停止')
      })
      await host.api(`/tickets/${sandboxTicket}/stop`, { reason: '沙箱核对完成', ...await ownerTarget(scope, sandboxTicket) }).catch(error => console.log('  停止', sandboxTicket, error.message))
    }
    await delay(3000)
    await check('命令审批', '幕僚团运行时写入工单仍等待批准、零执行', async () => {
      assert.ok(writeTicket, '没有写入工单')
      const view = await host.api(`/tickets/${writeTicket}`)
      assert.equal(view.stage, 'you/approve')
      assert.equal(view.ticket.assignments.length, 0)
    })
    const approved = await check('命令审批', '主人批准后由 Codex 执行', async () => {
      await host.api(`/tickets/${writeTicket}/approve`, await ownerTarget(scope, writeTicket))
      return true
    })
    const pending = (pattern, timeout = 60_000) => until(async () => (await host.api('/settings/approvals')).find(row => row.ticket === writeTicket && pattern.test(row.command)), `待审批命令 ${pattern}`, timeout)
    const denied = approved && await check('命令审批', 'Codex 申请越过沙箱时登记待审批命令', () => pending(/ark\.example\.invalid/))
    await check('命令审批', 'Codex 以禁用原生子代理的参数启动', () => {
      const started = codexRows().find(row => row.argv)
      assert.ok(started, 'Codex 夹具没有启动')
      assert.ok(started.argv.includes('features.multi_agent_v2.disable_native_tools=true'), started.argv.join(' '))
    })
    if (denied) {
      await check('命令审批', '申请时即提醒主人（接口人提醒）', async () => {
        const notice = await until(async () => (await host.api('/chat')).notices.find(row => row.key === `approval:${writeTicket}:${denied.id}`), '审批提醒', 10_000)
        assert.match(notice.text, /^命令待审批：工程师在「调大构建脚本超时」/)
        assert.match(notice.text, /curl -sS https:\/\/ark\.example\.invalid/)
      })
      await check('命令审批', '作战台状态把命令计入等你决定', async () => {
        const row = (await host.api('/state')).commands?.find(item => item.id === denied.id)
        assert.ok(row, '/state 没有 commands')
        assert.deepEqual([row.ticket, row.staff, row.summary], [writeTicket, '工程师', denied.command])
        assert.equal(Date.parse(row.expiresAt) - Date.parse(row.requestedAt), 60_000)
      })
      await check('命令审批', 'SuperHub 总览的等你决定列出命令', async () => {
        const overview = await host.api(`/superhub/overview?scope=${scope}`)
        assert.ok(overview.commands?.some(item => item.id === denied.id), 'SuperHub 总览没有 commands')
      })
      await check('命令审批', '电脑端显示命令、工单、幕僚、过期时间并可拒绝', async () => {
        page = await (await openBrowser()).newPage({ viewport: { width: 1440, height: 900 } })
        await page.context().addCookies(host.cookie().split('; ').map(item => ({ name: item.split('=')[0], value: item.slice(item.indexOf('=') + 1), url: host.base })))
        await page.goto(host.base)
        const desk = page.getByRole('region', {name:'命令权限审批'})
        const row = desk.getByRole('article', { name: `命令审批 ${writeTicket}` })
        await row.waitFor({ timeout: 15_000 })
        assert.equal(await row.locator('pre').textContent(), denied.command)
        await row.getByText(`${writeTicket} · 调大构建脚本超时`, { exact: true }).waitFor()
        await row.getByText('工程师 · Codex', {exact:true}).waitFor()
        assert.match(await row.locator('time').textContent(), /^\d{2}:\d{2} 前过期$/)
        if (process.env.CHIEF_SCREENSHOT_DIR) { mkdirSync(process.env.CHIEF_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.CHIEF_SCREENSHOT_DIR, 'core-command-decision-desktop.png') }) }
        await row.getByRole('button', { name: '拒绝', exact: true }).click()
        await until(async () => !(await host.api('/settings/approvals')).some(item => item.id === denied.id), '拒绝生效', 10_000)
      })
      // 旧版本没有这一入口时用审批接口拒绝，让后面的过期检查照常进行。
      if ((await host.api('/settings/approvals')).some(item => item.id === denied.id)) await host.api('/settings/approvals', { id: denied.id, allow: false }).catch(() => {})
      const expiring = await check('命令审批', '拒绝后 Codex 的下一条命令再次登记', () => pending(/scripts\/build\.mjs/))
      if (expiring) {
        await check('命令审批', '390px 命令审批可见可操作且不横向溢出', async () => {
          assert.ok(page, '浏览器没有打开')
          await page.setViewportSize({ width: 390, height: 844 })
          const row = page.getByRole('article', { name: `命令审批 ${writeTicket}` })
          await row.waitFor({ timeout: 15_000 })
          await row.scrollIntoViewIfNeeded()
          assert.equal(await row.locator('pre').textContent(), expiring.command)
          await row.getByRole('button', { name: '仅允许本次命令', exact: true }).waitFor()
          const box = await row.boundingBox()
          assert.ok(box && box.x >= 0 && box.x + box.width <= 391, `条目超出 390px：${JSON.stringify(box)}`)
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
          if (process.env.CHIEF_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.CHIEF_SCREENSHOT_DIR, 'core-command-decision-mobile.png') })
        })
        await check('命令审批', '过期后工单转为等你处理（受阻），摘要写明过期的命令', async () => {
          const view = await until(async () => {
            const value = await host.api(`/tickets/${writeTicket}`)
            return value.stage === 'you/blocked' || value.ticket.ended ? value : undefined
          }, '审批过期', EXPIRY_WAIT)
          assert.equal(view.stage, 'you/blocked')
          const report = view.ticket.assignments.at(-1).report
          assert.match(report.summary, /^命令审批未在 1 分钟内处理已过期：node scripts\/build\.mjs --timeout 1800/)
          assert.doesNotMatch(report.summary, /unknown|执行者异常/)
          const thread = await host.api(`/tickets/${writeTicket}/thread`)
          assert.deepEqual(thread.executions.at(-1).approvals.map(item => item.status), ['requested', 'rejected', 'requested', 'expired'])
        })
        await check('命令审批', '拒绝与过期都回复 decline，不以 cancel 中断回合', () => {
          assert.deepEqual(codexRows().filter(row => row.decision).map(row => [row.id, row.decision]), [['deny-me', 'decline'], ['expire-me', 'decline']])
        })
        await check('命令审批', '过期后提醒标记为已过期，命令从等你决定移除', async () => {
          const notice = (await host.api('/chat')).notices.find(row => row.key === `approval:${writeTicket}:${expiring.id}`)
          assert.deepEqual([notice?.status, notice?.done], ['已过期', true])
          assert.ok(!((await host.api('/state')).commands ?? []).some(item => item.id === expiring.id))
        })
      }
    }
  }
  if (!live && introResult) await check('自我介绍回报', '隔离宿主重启后仍只显示原来那份回报', async () => {
    calls = await records()
    await host.stop()
    await host.start()
    const view = await host.api(`/chat?scope=${encodeURIComponent(scope)}`)
    assert.equal(view.sessionId, liaison)
    assert.deepEqual(view.discussionResults?.filter(row => row.roomId === intro.id), [introResult])
  })
} catch (error) {
  results.push({ scenario: '运行', name: '回归脚本异常', ok: false, detail: String(error?.stack ?? error).slice(0, 800) })
  console.log('FAIL [运行] 回归脚本异常：', error)
} finally {
  if (!calls.length) calls = await records().catch(() => [])
  await browser?.close()
  await host.stop()
}

const failed = results.filter(row => !row.ok && !row.soft)
const passed = results.filter(row => row.ok).length
console.log(`\n核心链路回归（${live ? `真实模型 ${liveModel}` : '确定性模型夹具'}）：${passed}/${results.length} 通过`)
for (const row of results.filter(row => !row.ok)) console.log(`  ${row.soft ? 'INFO' : 'FAIL'} [${row.scenario}] ${row.name}：${row.detail}`)
if (process.env.CHIEF_CORE_EVIDENCE) {
  mkdirSync(dirname(process.env.CHIEF_CORE_EVIDENCE), { recursive: true })
  writeFileSync(process.env.CHIEF_CORE_EVIDENCE, JSON.stringify({ checkedAt: new Date().toISOString(), host: 'DSH 0.2.2-rc.1', model: live ? liveModel : 'deterministic fixture',
    candidate: process.env.CHIEF_ACCEPTANCE_PACKAGE, results, calls }, null, 2))
}
if (failed.length) {
  if (!live) console.log(host.logs().split('\n').filter(row => /chief|codex/i.test(row)).slice(-25).join('\n'))
  console.log('隔离宿主保留在', host.work)
  process.exitCode = 1
} else rmSync(host.work, { recursive: true, force: true })
