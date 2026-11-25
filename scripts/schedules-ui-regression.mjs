/**
 * 定时安排的验收：主人原话「每周一到周五上午 9:00 检查并提醒我各工作区尚未关闭的工单」经接口人建立；回执写明下一次时间、
 * 投递位置与查看位置；「设置 → 定时安排」列出、开关、删除；到点在接口人对话里出现与实际工单一致的汇总（带来源标记，
 * 未读 +1，推送端收到同一条）；重启同一时段不重复；停用后不投；接口人自己的一次性跟进、早报、每周经验整理各投一次；
 * 桌面 1440 与手机 390。
 *
 * 拨钟：隔离宿主以 CHIEF_ACCEPTANCE_SCHEDULE_CLOCK=1 启动时才有 `POST /v2/schedules/debug/tick {now}`，按给定时刻检查一遍
 * 定时安排并推送（安静时段按给定时刻判断）。正常运行的宿主没有这个入口。
 *
 * CHIEF_ACCEPTANCE_PACKAGE=<tgz> CHIEF_PLAYWRIGHT_PATH=<playwright/index.mjs> [CHIEF_CHROMIUM_PATH=<binary>]
 * [CHIEF_SCREENSHOT_DIR=<dir>] node scripts/schedules-ui-regression.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { button, signIn } from './workspace-browser-fixture.mjs'

const OWNER_WORDS = '每周一到周五上午 9:00 检查并提醒我各工作区尚未关闭的工单'
const SELF_WORDS = '周岚说后天给评审意见，你到时候上午十点回头看一下。'
const TZ = 'Asia/Shanghai'
const area = mkdtempSync(join(tmpdir(), 'chief-schedules-ui-'))
const shots = process.env.CHIEF_SCREENSHOT_DIR
if (shots) mkdirSync(shots, { recursive: true })
const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const minute = 60_000
const weekday = instant => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(instant)
const STATE = { accepted: '已接手', active: '执行中', waiting: '等待' }

const pushes = []
const pushServer = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => { try { pushes.push(JSON.parse(body).text) } catch { pushes.push(body) } res.end('ok') })
})
await new Promise(resolve => pushServer.listen(0, '127.0.0.1', resolve))

let browser, host
try {
  host = await acceptanceHost({ directory: area, mobile: true, probe: 'workspace-v2-probe.mjs', extraEnv: { CHIEF_ACCEPTANCE_SCHEDULE_CLOCK: '1' } })
  await host.start()
  await host.api('/pause', { paused: true })
  const scope = (await host.api('/v2/bootstrap')).scope
  const q = '?scope=' + encodeURIComponent(scope)
  const post = (path, body) => host.api(path + q, { ...body, requestId: randomUUID() })
  const schedules = async () => (await host.api('/v2/schedules' + q)).schedules
  const tick = at => host.api('/v2/schedules/debug/tick' + q, { now: at.toISOString() })
  const unread = async () => (await host.api('/chat/unread' + q)).unread
  const notices = async id => (await host.api('/chat')).notices.filter(row => row.key.startsWith('schedule:' + id + ':'))
  await host.api('/settings', { notifyUrl: `http://127.0.0.1:${pushServer.address().port}/push` })

  // 两个工作区的真实工单：一张完成（不算）、一张暂停（照算）。
  const space = async name => (await post('/v2/workspaces', { name })).workspace
  const landing = await space('字节 Landing'), research = await space('访谈')
  const order = async (w, title) => (await post(`/v2/workspaces/${encodeURIComponent(w.id)}/orders`, { title, promise: title + '交付' })).order
  await order(landing, '首页改版'); await order(landing, '报名页')
  const notes = await order(research, '整理访谈纪要'), shipped = await order(research, '已交付的提纲')
  await post(`/v2/workspaces/${encodeURIComponent(research.id)}/orders/${encodeURIComponent(shipped.id)}/action`, { action: 'complete' })
  await post(`/v2/workspaces/${encodeURIComponent(research.id)}/orders/${encodeURIComponent(notes.id)}/action`, { action: 'pause' })
  /** 由各工作区的实际工单算出汇总应当是什么。 */
  async function expectedSummary() {
    const groups = []
    for (const w of (await host.api('/v2/workspaces' + q)).workspaces.filter(w => !w.archivedAt)) {
      const open = (await host.api(`/v2/workspaces/${encodeURIComponent(w.id)}${q}`)).orders.filter(o => o.status !== 'done' && o.status !== 'closed')
      if (open.length) groups.push({ name: w.name, open })
    }
    const total = groups.reduce((sum, g) => sum + g.open.length, 0)
    const lines = [`各工作区共有 ${total} 张未关闭的工单：`]
    for (const g of groups) {
      lines.push(`「${g.name}」${g.open.length} 张`)
      for (const o of g.open.slice(0, 5)) lines.push(`· ${o.title}（${o.acceptance?.awaitingOwner ? '等你验收' : o.paused ? '已暂停' : STATE[o.status]}）`)
      if (g.open.length > 5) lines.push(`· 另有 ${g.open.length - 5} 张`)
    }
    return { total, text: lines.join('\n') }
  }

  const password = randomUUID()
  await host.api('/settings/password', { password })
  browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH && { executablePath: process.env.CHIEF_CHROMIUM_PATH }) })
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  desktop.setDefaultTimeout(20_000)
  await signIn(desktop, host)
  const today = (page, base = host.base) => page.goto(base + '/#v2?' + new URLSearchParams({ scope, view: 'today' }))
  async function openLiaison(page) {
    await page.getByRole('button', { name: /^一句话交办(，|$)/ }).first().click()
    const dialog = page.getByRole('dialog', { name: '接口人' })
    await dialog.waitFor()
    return dialog
  }
  async function say(page, words, expect) {
    const dialog = await openLiaison(page)
    const text = dialog.getByRole('textbox', { name: '对接口人说', exact: true })
    await until(async () => text.isEnabled(), '接口人输入框可用')
    await text.fill(words)
    await text.press('Enter')
    const reply = dialog.locator('.v2-turn:not(.mine)').filter({ hasText: expect }).last()
    await reply.waitFor({ timeout: 40_000 })
    const said = await reply.innerText()
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    return said
  }
  const settingsRow = (page, title) => page.locator('#schedules li').filter({ has: page.locator('strong', { hasText: title }) })

  // 1. 验收原话经接口人建立；回执写明下一次时间、投递位置、推送与查看位置。
  await today(desktop)
  await desktop.getByRole('heading', { name: '我的工作区', exact: true }).waitFor()
  const receipt = await say(desktop, OWNER_WORDS, '已建立「未关闭工单提醒」')
  const created = (await schedules()).find(row => row.by === 'owner' && row.content === 'open-orders')
  assert.ok(created, '清单里有这条安排')
  assert.equal(created.whenLabel, '工作日 09:00')
  for (const part of [`下一次 ${created.nextLabel}（${TZ}）`, '到点会在接口人对话里提醒你，同时推送到手机', '可在「设置 → 定时安排」查看、停用或删除']) {
    assert.ok(receipt.includes(part), `回执包含「${part}」：${receipt}`)
  }
  console.log('PASS 接口人回执', JSON.stringify(receipt.split('\n').at(-1)))

  // 2. 「设置 → 定时安排」列出该条。
  await button(desktop, '设置').click()
  await desktop.getByRole('heading', { name: '定时安排', exact: true }).waitFor()
  const row = settingsRow(desktop, '未关闭工单提醒')
  await row.waitFor()
  const rowText = await row.innerText()
  for (const part of ['已开启', '工作日 09:00', created.nextLabel, '还没有触发过', '主人经接口人']) assert.ok(rowText.includes(part), `清单行包含「${part}」：${rowText}`)
  assert.ok((await desktop.locator('#schedules').innerText()).includes('到点在接口人对话里提醒你，同时推送到手机'))
  if (shots) await desktop.screenshot({ path: join(shots, 'schedules-settings-1440.png'), fullPage: true })
  console.log('PASS 设置清单')

  // 3. 拨到触发时间：接口人对话出现与实际工单一致的汇总，带来源标记，未读 +1，推送端收到同一条。
  const fire = new Date(Date.parse(created.next) + minute)
  const before = await unread()
  const expected = await expectedSummary()
  await tick(fire)
  assert.equal(expected.total, 3, '两张进行中、一张暂停；已完成的不算')
  const footer = '\n— 来自定时安排「未关闭工单提醒」· 工作日 09:00'
  const [delivered] = await notices(created.id)
  assert.equal(delivered?.text, expected.text + footer)
  assert.deepEqual(delivered.schedule, { id: created.id, title: '未关闭工单提醒', when: '工作日 09:00' })
  assert.equal(await unread(), before + 1, '未读 +1')
  await until(() => pushes.some(text => text.includes(expected.text.split('\n')[0]) && text.includes('来自定时安排「未关闭工单提醒」')), '推送端收到同一条')
  assert.equal((await schedules()).find(r => r.id === created.id).lastRun.status, 'delivered')
  console.log('PASS 到点投递', JSON.stringify({ unread: before + 1, pushes: pushes.length }))

  // 4. 重启后同一时段不重复。
  await host.stop()
  await host.start()
  await tick(fire)
  assert.equal((await notices(created.id)).length, 1, '重启后同一时段只有一条')
  assert.equal(await unread(), before + 1)
  console.log('PASS 重启不重复')

  // 5. 网页：徽标、汇总正文、来源标记与两个操作；「在设置中查看」落到这一节。
  await signIn(desktop, host)
  await today(desktop)
  await desktop.getByRole('button', { name: new RegExp(`^一句话交办，${before + 1} 条未读`) }).first().waitFor()
  let dialog = await openLiaison(desktop)
  const turn = dialog.locator('.v2-turn').filter({ hasText: '来自定时安排「未关闭工单提醒」' })
  await turn.waitFor()
  assert.equal((await turn.locator('.v2-notice-text').innerText()).trim(), (expected.text + footer).trim())
  await button(turn, '停用这条安排').waitFor()
  if (shots) await desktop.screenshot({ path: join(shots, 'schedules-liaison-1440.png') })
  await button(turn, '在设置中查看').click()
  await dialog.waitFor({ state: 'detached' })
  await until(() => desktop.evaluate(() => document.activeElement?.id === 'v2-schedules-title'), '焦点落在「定时安排」')
  console.log('PASS 接口人提醒与「在设置中查看」')

  // 6. 停用：在提醒里停用，清单显示已停用；下一个工作日不再投递。
  dialog = await openLiaison(desktop)
  const again = dialog.locator('.v2-turn').filter({ hasText: '来自定时安排「未关闭工单提醒」' })
  await button(again, '停用这条安排').click()
  await again.getByText('已停用', { exact: true }).waitFor()
  await desktop.keyboard.press('Escape')
  assert.equal((await schedules()).find(r => r.id === created.id).enabled, false)
  let later = new Date(fire.getTime() + 86_400_000)
  while (['Sat', 'Sun'].includes(weekday(later))) later = new Date(later.getTime() + 86_400_000)
  await tick(later)
  assert.equal((await notices(created.id)).length, 1, '停用后不再投递')
  await desktop.reload()
  await desktop.getByRole('heading', { name: '定时安排', exact: true }).waitFor()
  await until(async () => (await settingsRow(desktop, '未关闭工单提醒').innerText()).includes('已停用'), '清单显示已停用')
  console.log('PASS 停用')

  // 7. 接口人自己的一次性跟进：进清单，到点投递到接口人对话。
  await today(desktop)
  const selfReceipt = await say(desktop, SELF_WORDS, '已给自己定好跟进')
  const follow = (await schedules()).find(r => r.by === 'liaison')
  assert.ok(follow?.at && selfReceipt.includes(follow.nextLabel), `跟进回执写明时间：${selfReceipt}`)
  await button(desktop, '设置').click()
  await until(async () => (await settingsRow(desktop, follow.title).innerText().catch(() => '')).includes('接口人自定跟进'), '跟进出现在清单')
  await tick(new Date(Date.parse(follow.next) + minute))
  const [followed] = await notices(follow.id)
  assert.equal(followed?.text, `接口人跟进：看周岚给没给评审意见\n— 来自定时安排「${follow.title}」· ${follow.at.replace('T', ' ')} 一次`)
  assert.equal(followed.status, '一次性安排，已完成', '到点后的一次性跟进不再给「停用」')
  console.log('PASS 接口人自定跟进')

  // 8. 早报：迁移后默认关闭，在设置里打开后按规则投递（基于工作区与工单数据撰写）。
  const brief = settingsRow(desktop, '早报')
  assert.ok((await brief.innerText()).includes('已停用'), '早报默认关闭')
  await button(brief, '开启「早报」').click()
  await desktop.getByRole('status').filter({ hasText: '已开启「早报」。' }).waitFor()
  const morning = (await schedules()).find(r => r.id === 'morning-brief')
  assert.equal(morning.enabled, true)
  await tick(new Date(Date.parse(morning.next) + minute))
  const [briefed] = await notices('morning-brief')
  const open = (await expectedSummary()).total
  assert.ok(briefed?.text.startsWith(`早报：今天还有 ${open} 张未关闭的工单`) && briefed.text.endsWith('\n— 来自定时安排「早报」· 工作日 08:30'), `早报：${briefed?.text}`)
  await host.api('/v2/schedules/morning-brief' + q, { action: 'disable' })
  console.log('PASS 早报')

  // 8b. 执行失败先隔 10 分钟重试，不打扰主人；第三次失败才在接口人对话里说明原因（夹具让晚报的模型调用失败）。
  await host.api('/v2/schedules/evening-review' + q, { action: 'enable' })
  const evening = (await schedules()).find(r => r.id === 'evening-review')
  const first = new Date(Date.parse(evening.next) + minute)
  await tick(first)
  assert.equal((await notices('evening-review')).length, 0, '第一次失败不投递')
  let retry = (await schedules()).find(r => r.id === 'evening-review')
  assert.deepEqual([retry.lastRun.status, retry.lastRun.attempts], ['failed', 1])
  await desktop.reload()
  await desktop.getByRole('heading', { name: '定时安排', exact: true }).waitFor()
  await until(async () => (await settingsRow(desktop, '晚报').innerText()).includes(`失败，第 1 次，将在 ${retry.retryLabel} 重试`), '清单显示重试时间')
  await tick(new Date(first.getTime() + 5 * minute))
  assert.equal((await schedules()).find(r => r.id === 'evening-review').lastRun.attempts, 1, '未到重试时间不重跑')
  await tick(new Date(first.getTime() + 10 * minute))
  retry = (await schedules()).find(r => r.id === 'evening-review')
  assert.deepEqual([retry.lastRun.attempts, (await notices('evening-review')).length], [2, 0])
  await tick(new Date(first.getTime() + 20 * minute))
  await tick(new Date(first.getTime() + 30 * minute))
  const failed = await notices('evening-review')
  assert.equal(failed.length, 1, '三次失败后只有一条失败说明')
  assert.match(failed[0].text, /^定时安排「晚报」这次没能完成（已试 3 次）：.*模型服务暂时不可用（夹具）.*\n— 来自定时安排「晚报」· 工作日 21:30$/s)
  await desktop.reload()
  await desktop.getByRole('heading', { name: '定时安排', exact: true }).waitFor()
  await until(async () => /失败（[^）]+，已试 3 次）/.test(await settingsRow(desktop, '晚报').innerText()), '清单显示最终失败')
  await host.api('/v2/schedules/evening-review' + q, { action: 'disable' })
  console.log('PASS 失败重试')

  // 9. 每周经验整理：「经验」面板可见，按时运行并投递。
  await desktop.goto(host.base + '/#v2?' + new URLSearchParams({ scope, view: 'workspace', workspace: landing.id, panel: 'experience' }))
  await desktop.getByText('每周日 20:00 自动整理', { exact: false }).waitFor()
  await button(desktop, '在设置中管理').click()
  await until(() => desktop.evaluate(() => document.activeElement?.id === 'v2-schedules-title'), '从「经验」到「定时安排」')
  const dream = (await schedules()).find(r => r.id === 'weekly-dream')
  // An earlier tick may already have recorded this Sunday as missed (ticks jump ahead of the host's real clock).
  await tick(new Date(Date.parse(dream.next) + (dream.lastRun ? 7 * 86_400_000 : 0) + minute))
  const [dreamt] = await notices('weekly-dream')
  assert.match(dreamt?.text ?? '', /^本周经验整理已完成.*\n— 来自定时安排「每周经验整理」· 每周日 20:00$/s)
  console.log('PASS 每周经验整理')

  // 10. 删除：确认后清单与运行数据里都没有。
  await desktop.goto(host.base + '/#v2?' + new URLSearchParams({ scope, view: 'settings', item: 'schedules' }))
  await settingsRow(desktop, '未关闭工单提醒').waitFor()
  assert.equal(await button(settingsRow(desktop, '早报'), '删除「早报」').count(), 0, '系统内置项没有删除')
  desktop.once('dialog', prompt => { assert.match(prompt.message(), /删除定时安排「未关闭工单提醒」/); void prompt.accept() })
  await button(settingsRow(desktop, '未关闭工单提醒'), '删除「未关闭工单提醒」').click()
  await settingsRow(desktop, '未关闭工单提醒').waitFor({ state: 'detached' })
  assert.ok(!(await schedules()).some(r => r.id === created.id))
  assert.ok(!readFileSync(join(host.brain, 'ops', 'superhub-schedules.json'), 'utf8').includes(created.id), '运行数据里没有这条')
  console.log('PASS 删除')

  // 11. 手机 390：清单与接口人提醒可用、无横向溢出、触控尺寸够。
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true })
  phone.setDefaultTimeout(20_000)
  await phone.goto(host.mobileBase)
  await phone.getByLabel('密码').fill(password)
  await button(phone, '进入').click()
  await phone.getByRole('heading', { name: '今天', exact: true }).waitFor()
  await phone.goto(host.mobileBase + '/#v2?' + new URLSearchParams({ scope, view: 'settings', item: 'schedules' }))
  const phoneRow = settingsRow(phone, '晚报')
  await phoneRow.waitFor()
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '手机设置页不横向溢出')
  const toggle = await button(phoneRow, '开启「晚报」').boundingBox()
  assert.ok(toggle && toggle.height >= 44, `手机开关触控高度 ${toggle?.height}`)
  if (shots) await phone.screenshot({ path: join(shots, 'schedules-settings-390.png'), fullPage: true })
  await phone.goto(host.mobileBase + '/#v2?' + new URLSearchParams({ scope, view: 'today' }))
  const phoneDialog = await openLiaison(phone)
  const removed = phoneDialog.locator('.v2-turn').filter({ hasText: '来自定时安排「未关闭工单提醒」' })
  await removed.getByText('这条定时安排已删除').waitFor()
  assert.equal(await button(removed, '停用这条安排').count(), 0)
  const view = await button(phoneDialog.locator('.v2-turn').filter({ hasText: '来自定时安排「早报」' }), '在设置中查看').boundingBox()
  assert.ok(view && view.height >= 44, `手机「在设置中查看」触控高度 ${view?.height}`)
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), '手机接口人不横向溢出')
  if (shots) await phone.screenshot({ path: join(shots, 'schedules-liaison-390.png') })
  console.log('PASS 手机 390')
  console.log('PASS schedules regression')
} finally {
  await browser?.close()
  await host?.dispose()
  pushServer.close()
  rmSync(area, { recursive: true, force: true })
}
