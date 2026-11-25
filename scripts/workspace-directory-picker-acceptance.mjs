/**
 * Project-directory picker acceptance (task 11-24, prd A1–A5): the 「绑定项目目录」 field lists directories as the owner
 * types, in a real browser against an isolated, disposable DSH host that installs the candidate package. No model and
 * no coding tool runs.
 *
 *   CHIEF_ACCEPTANCE_PACKAGE=<candidate tgz> CHIEF_PLAYWRIGHT_PATH=<playwright/index.mjs> [CHIEF_CHROMIUM_PATH=<chromium>] \
 *   [CHIEF_PICKER_SCREENSHOTS=<dir>] node scripts/workspace-directory-picker-acceptance.mjs [--keep]
 *
 * The run directory (and the projects standing in for the owner's) lives under CHIEF_ACCEPTANCE_BASE (default
 * ~/.cache/chief-acceptance), below the owner's home so its projects can be bound; it is removed at the end.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'

const keep = process.argv.includes('--keep')
const shots = process.env.CHIEF_PICKER_SCREENSHOTS
assert.ok(process.env.CHIEF_PLAYWRIGHT_PATH, '需要 CHIEF_PLAYWRIGHT_PATH')
const HOME = homedir()
const BASE = process.env.CHIEF_ACCEPTANCE_BASE || join(HOME, '.cache/chief-acceptance')
mkdirSync(BASE, {recursive: true, mode: 0o700})
const run = realpathSync(mkdtempSync(join(BASE, 'picker-run-')))
assert.ok(run.startsWith(HOME + '/'), '运行目录需在家目录下，项目才能绑定')
const projects = join(run, 'projects')
for (const name of ['alpha', 'Alpha2', 'beta', '.hidden-proj']) mkdirSync(join(projects, name), {recursive: true})
writeFileSync(join(projects, 'alpha-notes.txt'), 'not a directory')
symlinkSync(join(projects, 'beta'), join(projects, 'beta-link'))

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
  const {workspace: W1} = await post('/v2/workspaces', {name: '补全验收 桌面'})
  const {workspace: W2} = await post('/v2/workspaces', {name: '补全验收 回车'})
  const {workspace: W3} = await post('/v2/workspaces', {name: '补全验收 手机'})
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
  async function openDialog(page, origin, ws) {
    await page.goto(origin + '/#v2?' + new URLSearchParams({scope, view: 'workspace', workspace: ws.id}))
    const section = page.getByRole('region', {name: '项目目录'})
    await section.waitFor({timeout: 30_000})
    await section.getByRole('button', {name: '绑定目录', exact: true}).click()
    const dialog = page.getByRole('dialog', {name: '绑定项目目录'})
    await dialog.waitFor()
    return {section, dialog, field: dialog.getByRole('combobox'), menu: dialog.getByRole('listbox', {includeHidden: true})}
  }
  const names = menu => menu.getByRole('option').evaluateAll(rows => rows.map(row => row.querySelector('strong')?.textContent))
  const shows = async (menu, expected, label) => until(async () => JSON.stringify(await names(menu)) === JSON.stringify(expected), label, 8_000)
    .catch(async error => { throw Error(error.message + '；实际 ' + JSON.stringify(await names(menu))) })

  const d = await openDialog(desktop, host.base, W1)
  await check('A1 空输入列出家目录子目录', async () => {
    await d.field.click()
    await until(async () => (await names(d.menu)).length > 0, '家目录候选')
    assert.equal(await d.field.getAttribute('aria-expanded'), 'true')
    const listed = await names(d.menu)
    assert.ok(listed.every(name => !name.startsWith('.')), '不列隐藏目录：' + listed)
    await picture(desktop, 'a1-empty-home')
  })
  await check('A1 前缀匹配：只列目录，大小写一致优先，符号链接目录在列', async () => {
    await d.field.fill(projects + '/')
    await shows(d.menu, ['alpha/', 'Alpha2/', 'beta/', 'beta-link/'], '项目候选')
    await d.field.fill(projects + '/a')
    await shows(d.menu, ['alpha/', 'Alpha2/'], '前缀 a')
    await d.field.fill(projects + '/A')
    await shows(d.menu, ['Alpha2/', 'alpha/'], '前缀 A')
  })
  await check('A1 逐字快速输入后结果对应最后的输入', async () => {
    await d.field.fill('')
    await d.field.pressSequentially(projects + '/be', {delay: 5})
    await shows(d.menu, ['beta/', 'beta-link/'], '快速输入')
  })
  await check('A3 输入 . 才列隐藏目录', async () => {
    await d.field.fill(projects + '/.')
    await shows(d.menu, ['.hidden-proj/'], '隐藏目录')
  })
  await check('A4 不可绑定的目录置灰并注明原因', async () => {
    await d.field.fill('/et')
    await shows(d.menu, ['etc/'], '/et')
    const row = d.menu.getByRole('option').first()
    assert.equal(await row.getAttribute('data-bindable'), 'false')
    assert.match(await row.textContent(), /不能绑定：系统目录/)
    await d.field.fill(HOME)
    await until(async () => (await d.menu.getByRole('option').first().textContent())?.includes('家目录本身'), '家目录本身')
    await d.field.fill(host.brain + '/o')
    await until(async () => (await d.menu.getByRole('option').first().textContent())?.includes('内部目录'), '第二大脑 ops')
    await picture(desktop, 'a4-unbindable')
  })
  await check('A5 父目录不存在时下拉说明，输入不受影响', async () => {
    await d.field.fill(run + '/nope/x')
    await d.dialog.getByRole('status').filter({hasText: '目录不存在'}).waitFor({timeout: 8_000})
    assert.equal(await d.field.inputValue(), run + '/nope/x')
  })
  await check('A1 ↓ 高亮、Tab 进入下一层；Esc 只关下拉不关对话框', async () => {
    await d.field.fill(projects + '/al')
    await shows(d.menu, ['alpha/', 'Alpha2/'], '前缀 al')
    assert.equal(await d.field.getAttribute('aria-activedescendant'), null, '初始没有高亮')
    await d.field.press('ArrowDown')
    assert.ok(await d.field.getAttribute('aria-activedescendant'), '↓ 后有高亮')
    await d.field.press('Tab')
    assert.equal(await d.field.inputValue(), projects + '/alpha/')
    await d.dialog.getByRole('status').filter({hasText: '没有匹配的目录'}).waitFor({timeout: 8_000})
    await d.field.press('Escape')
    assert.equal(await d.field.getAttribute('aria-expanded'), 'false')
    assert.ok(await d.dialog.isVisible(), 'Esc 后对话框仍在')
    assert.ok(await d.field.evaluate(el => el === document.activeElement), '焦点仍在输入框')
  })
  await check('A2 下拉开着时点「保存目录」一次就保存', async () => {
    await d.field.press('ArrowDown')
    assert.equal(await d.field.getAttribute('aria-expanded'), 'true')
    await picture(desktop, 'a2-before-save')
    await d.dialog.getByRole('button', {name: '保存目录', exact: true}).click()
    await d.dialog.waitFor({state: 'detached', timeout: 8_000})
    await d.section.locator('code').filter({hasText: join(projects, 'alpha')}).waitFor({timeout: 8_000})
    assert.equal((await get('/v2/workspaces/' + encodeURIComponent(W1.id))).workspace.projectDirectory, join(projects, 'alpha'))
  })
  await check('A2 没有高亮时回车直接保存；~ 开头选中后换成绝对路径', async () => {
    const e = await openDialog(desktop, host.base, W2)
    await e.field.click()
    const relative = '~' + projects.slice(HOME.length) + '/b'
    await e.field.fill(relative)
    await shows(e.menu, ['beta/', 'beta-link/'], '~ 前缀')
    await e.menu.getByRole('option').first().click()
    assert.equal(await e.field.inputValue(), projects + '/beta/')
    await e.field.press('Escape')
    await e.field.fill(relative + 'eta')
    await e.field.press('Enter')
    await e.dialog.waitFor({state: 'detached', timeout: 8_000})
    assert.equal((await get('/v2/workspaces/' + encodeURIComponent(W2.id))).workspace.projectDirectory, join(projects, 'beta'))
  })
  await check('手机宽度：点选候选、下拉行高 ≥ 44px、点保存', async () => {
    const mobile = await browser.newPage({viewport: {width: 390, height: 844}, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', isMobile: true, hasTouch: true})
    await mobile.goto(host.mobileBase)
    await mobile.getByLabel('密码').fill(password)
    await mobile.getByRole('button', {name: '进入', exact: true}).click()
    await mobile.getByRole('heading', {name: '今天', exact: true}).waitFor({timeout: 30_000})
    const m = await openDialog(mobile, host.mobileBase, W3)
    await m.field.tap()
    await m.field.fill(projects + '/')
    await shows(m.menu, ['alpha/', 'Alpha2/', 'beta/', 'beta-link/'], '手机候选')
    const height = await m.menu.getByRole('option').first().evaluate(el => el.getBoundingClientRect().height)
    assert.ok(height >= 44, '行高 ' + height)
    await picture(mobile, 'mobile-menu')
    await m.menu.getByRole('option').nth(1).tap()
    assert.equal(await m.field.inputValue(), projects + '/Alpha2/')
    await m.dialog.getByRole('button', {name: '保存目录', exact: true}).tap()
    await m.dialog.waitFor({state: 'detached', timeout: 8_000})
    assert.equal((await get('/v2/workspaces/' + encodeURIComponent(W3.id))).workspace.projectDirectory, join(projects, 'Alpha2'))
  })
} finally {
  await browser?.close()
  await host.dispose()
  if (!keep) rmSync(run, {recursive: true, force: true})
}
const failed = results.filter(row => !row.ok)
log(failed.length ? `✘ ${failed.length}/${results.length} 项未通过` : `✔ ${results.length} 项全部通过`, keep ? '（保留 ' + run + '）' : '（运行目录已删除）')
process.exit(failed.length ? 1 : 0)
