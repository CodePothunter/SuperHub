/**
 * Workspace archive acceptance (task 11-24 workspace-archive, prd A1–A5): archive refused while an order is open (paused
 * included), archive once every order has ended, read-only archived page with 「恢复」, out of 「今天」 and under
 * 「切换工作区 → 已归档」, writes refused (409), restore, and the archive surviving a host restart — in a real browser
 * against an isolated, disposable DSH host that installs the candidate package. No model and no coding tool runs (the
 * order sits in a coding session without a named staff member, which never starts a turn by itself).
 *
 *   CHIEF_ACCEPTANCE_PACKAGE=<candidate tgz> CHIEF_PLAYWRIGHT_PATH=<playwright/index.mjs> [CHIEF_CHROMIUM_PATH=<chromium>] \
 *   [CHIEF_ARCHIVE_SCREENSHOTS=<dir>] node scripts/workspace-archive-acceptance.mjs [--keep]
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'

const keep = process.argv.includes('--keep')
const shots = process.env.CHIEF_ARCHIVE_SCREENSHOTS
assert.ok(process.env.CHIEF_PLAYWRIGHT_PATH, '需要 CHIEF_PLAYWRIGHT_PATH')
const BASE = process.env.CHIEF_ACCEPTANCE_BASE || join(homedir(), '.cache/chief-acceptance')
mkdirSync(BASE, {recursive: true, mode: 0o700})
const run = realpathSync(mkdtempSync(join(BASE, 'archive-run-')))
const project = join(run, 'project')
mkdirSync(project)

const host = await acceptanceHost({directory: join(run, 'host'), mobile: true})
const results = []
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts)
async function check(label, body) {
  try { await body(); results.push({label, ok: true}); log('✔', label) }
  catch (error) { results.push({label, ok: false, error: error.message}); log('✘', label, error.message) }
}
let browser
try {
  await host.start()
  await host.api('/pause', {paused: true})
  const scope = (await host.api('/v2/bootstrap')).scope
  const q = '?scope=' + encodeURIComponent(scope)
  const post = (path, body = {}) => host.api(path + q, {...body, requestId: randomUUID()})
  const get = path => host.api(path + q)
  const refused = (path, body = {}) => post(path, body).then(() => ({status: 200}), error => ({status: error.status, error: error.message}))
  const wsPath = ws => '/v2/workspaces/' + encodeURIComponent(ws.id)
  const {workspace: A} = await post('/v2/workspaces', {name: '归档验收 甲', goal: '做完就归档'})
  const {workspace: B} = await post('/v2/workspaces', {name: '归档验收 乙'})
  const {workspace: M} = await post('/v2/workspaces', {name: '归档验收 手机'})
  await post(wsPath(A) + '/directory', {directory: project})
  const {session} = await post(wsPath(A) + '/sessions', {title: '甲的会话', kind: 'coding', executor: 'codex'})
  const {order} = await post(wsPath(A) + '/orders', {title: '甲的收尾工单', promise: '整理交付', sessionId: session.id})
  const orderPath = wsPath(A) + '/orders/' + encodeURIComponent(order.id)
  const password = randomUUID()
  await host.api('/settings/password', {password})

  const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  browser = await chromium.launch({headless: true, ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath: process.env.CHIEF_CHROMIUM_PATH})})
  const desktop = await browser.newPage({viewport: {width: 1280, height: 900}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai'})
  await desktop.context().addCookies(host.cookie().split('; ').map(row => ({name: row.slice(0, row.indexOf('=')), value: row.slice(row.indexOf('=') + 1), url: host.base})))
  const picture = async (page, name) => {
    if (!shots) return
    mkdirSync(shots, {recursive: true})
    await page.screenshot({path: join(shots, name + '.png')})
  }
  const hash = (params) => '/#v2?' + new URLSearchParams({scope, ...params})
  async function openWorkspace(page, origin, ws) {
    await page.goto(origin + hash({view: 'workspace', workspace: ws.id}))
    await page.getByRole('heading', {name: ws.name, exact: true, level: 1}).waitFor({timeout: 30_000})
  }
  const todayCards = async page => {
    await page.goto(host.base + hash({view: 'today'}))
    await page.getByRole('heading', {name: '今天', exact: true}).waitFor({timeout: 30_000})
    await until(async () => (await page.locator('.v2-space-card').count()) > 0 || (await page.locator('.v2-empty').count()) > 0, '今天的工作区')
    return page.locator('.v2-space-card strong').allTextContents()
  }
  const confirmArchive = async page => {
    await page.getByRole('button', {name: '归档工作区', exact: true}).click()
    const dialog = page.getByRole('dialog', {name: '归档这个工作区？'})
    await dialog.waitFor()
    await dialog.getByRole('button', {name: '确认归档', exact: true}).click()
    return dialog
  }

  await check('A1 有进行中的工单时归档被拒，原因列出工单', async () => {
    await openWorkspace(desktop, host.base, A)
    const dialog = await confirmArchive(desktop)
    await dialog.getByRole('alert').filter({hasText: '甲的收尾工单'}).waitFor({timeout: 8_000})
    assert.match(await dialog.getByRole('alert').textContent(), /还有 1 张工单未结束/)
    await picture(desktop, 'a1-refused-open-order')
    await dialog.getByRole('button', {name: '取消', exact: true}).click()
  })
  await check('A1 暂停的工单同样算未结束', async () => {
    await post(orderPath + '/action', {action: 'pause'})
    const answer = await refused(wsPath(A) + '/archive')
    assert.equal(answer.status, 409)
    assert.match(answer.error, /甲的收尾工单/)
  })
  await check('A1 工单取消后，在原对话框里再点一次即可归档，回到今天', async () => {
    await openWorkspace(desktop, host.base, A)
    const dialog = await confirmArchive(desktop)
    await dialog.getByRole('alert').waitFor({timeout: 8_000})
    await post(orderPath + '/action', {action: 'cancel', reason: '验收：取消后归档'})
    await dialog.getByRole('button', {name: '确认归档', exact: true}).click()
    await dialog.waitFor({state: 'detached', timeout: 8_000})
    await desktop.getByText('已归档「归档验收 甲」').waitFor({timeout: 8_000})
    assert.ok((await get(wsPath(A))).workspace.archivedAt, '已记下归档时间')
  })
  await check('A2 「今天」不再列出，「切换工作区 → 已归档」能打开', async () => {
    const cards = await todayCards(desktop)
    assert.ok(!cards.includes('归档验收 甲') && cards.includes('归档验收 乙'), '今天：' + cards)
    await openWorkspace(desktop, host.base, B)
    await desktop.getByRole('button', {name: '切换工作区'}).click()
    const dialog = desktop.getByRole('dialog', {name: '切换工作区'})
    await dialog.waitFor()
    assert.ok(!(await dialog.locator('.v2-space-grid').first().textContent()).includes('归档验收 甲'), '正常列表里没有已归档的')
    await dialog.getByText('已归档（1）').click()
    await picture(desktop, 'a2-switcher-archived')
    await dialog.locator('.v2-archived-spaces .v2-space-card').filter({hasText: '归档验收 甲'}).click()
    await desktop.getByRole('heading', {name: '归档验收 甲', exact: true, level: 1}).waitFor({timeout: 30_000})
  })
  await check('A2 已归档页只读：横幅与恢复可见，写入口不在', async () => {
    const banner = desktop.getByRole('region', {name: '工作区已归档'})
    await banner.waitFor({timeout: 8_000})
    assert.ok(await banner.getByRole('button', {name: '恢复', exact: true}).isVisible())
    for (const name of ['新建工单', '新建会话', '归档工作区', '绑定目录', '修改', '解除']) {
      assert.equal(await desktop.getByRole('button', {name, exact: true}).count(), 0, '不应出现「' + name + '」')
    }
    assert.ok(await desktop.getByText(project).first().isVisible(), '项目目录照常显示')
    await picture(desktop, 'a2-archived-page')
  })
  await check('A3 写已归档工作区的接口返回 409', async () => {
    const writes = {
      newOrder: refused(wsPath(A) + '/orders', {title: '不该建成', promise: '—', sessionId: session.id}),
      newSession: refused(wsPath(A) + '/sessions', {title: '不该建成', kind: 'coding', executor: 'codex'}),
      directory: refused(wsPath(A) + '/directory', {directory: ''}),
      reopen: refused(orderPath + '/action', {action: 'reopen'}),
    }
    for (const [name, answer] of Object.entries(writes)) {
      const {status, error} = await answer
      assert.equal(status, 409, name + '：' + error)
      assert.match(error, /工作区已归档，请先恢复/, name)
    }
    assert.equal((await get(wsPath(A))).workspace.projectDirectory, project, '目录没被解除')
  })
  await check('A5 重启宿主后仍是归档状态', async () => {
    await host.stop()
    await host.start()
    assert.ok((await get(wsPath(A))).workspace.archivedAt)
    const cards = await todayCards(desktop)
    assert.ok(!cards.includes('归档验收 甲'), '今天：' + cards)
  })
  await check('A4 恢复后一切如前', async () => {
    await openWorkspace(desktop, host.base, A)
    await desktop.getByRole('region', {name: '工作区已归档'}).getByRole('button', {name: '恢复', exact: true}).click()
    await desktop.getByRole('region', {name: '工作区已归档'}).waitFor({state: 'detached', timeout: 8_000})
    await desktop.getByRole('button', {name: '新建工单', exact: true}).first().waitFor({timeout: 8_000})
    const view = await get(wsPath(A))
    assert.equal(view.workspace.archivedAt, undefined)
    assert.equal(view.workspace.projectDirectory, project)
    assert.ok(view.orders.some(row => row.id === order.id))
    assert.ok((await todayCards(desktop)).includes('归档验收 甲'))
  })
  await check('手机宽度：归档、横幅、恢复', async () => {
    const mobile = await browser.newPage({viewport: {width: 390, height: 844}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true})
    await mobile.goto(host.mobileBase)
    await mobile.getByLabel('密码').fill(password)
    await mobile.getByRole('button', {name: '进入', exact: true}).click()
    await mobile.getByRole('heading', {name: '今天', exact: true}).waitFor({timeout: 30_000})
    await openWorkspace(mobile, host.mobileBase, M)
    await mobile.getByRole('button', {name: '归档工作区', exact: true}).tap()
    const dialog = mobile.getByRole('dialog', {name: '归档这个工作区？'})
    await dialog.getByRole('button', {name: '确认归档', exact: true}).tap()
    await dialog.waitFor({state: 'detached', timeout: 8_000})
    await openWorkspace(mobile, host.mobileBase, M)
    const restore = mobile.getByRole('region', {name: '工作区已归档'}).getByRole('button', {name: '恢复', exact: true})
    const box = await restore.boundingBox()
    assert.ok(box && box.height >= 44, '恢复按钮高 ' + box?.height)
    await picture(mobile, 'mobile-archived')
    await restore.tap()
    await mobile.getByRole('region', {name: '工作区已归档'}).waitFor({state: 'detached', timeout: 8_000})
    assert.equal((await get(wsPath(M))).workspace.archivedAt, undefined)
  })
} finally {
  await browser?.close()
  await host.dispose()
  if (!keep) rmSync(run, {recursive: true, force: true})
}
const failed = results.filter(row => !row.ok)
log(failed.length ? `✘ ${failed.length}/${results.length} 项未通过` : `✔ ${results.length} 项全部通过`, keep ? '（保留 ' + run + '）' : '（运行目录已删除）')
process.exit(failed.length ? 1 : 0)
