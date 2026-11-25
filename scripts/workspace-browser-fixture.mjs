/** Shared owner-facing UI operations for the isolated packaged SuperHub acceptance hosts. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function providerBinaries() {
  const binaries = mkdtempSync(join(tmpdir(), 'superhub-v2-providers-'))
  for (const name of ['codex', 'claude']) {
    const file = join(binaries, name)
    copyFileSync(fileURLToPath(new URL('./workspace-v2-cli-fixture.mjs', import.meta.url)), file)
    chmodSync(file, 0o700)
  }
  return binaries
}

export const button = (page, name) => page.getByRole('button', {name, exact:true})
export async function newSpace(page, name, goal) {
  await button(page, '工作区').click()
  const create = button(page, '创建工作区'), choose = button(page, '切换工作区')
  await create.or(choose).first().waitFor()
  if (!await create.isVisible()) await choose.click()
  await create.click()
  const form = page.getByRole('dialog', {name:'创建工作区'})
  await form.getByLabel('工作区名称').fill(name)
  await form.getByLabel('当前目标').fill(goal)
  await button(form, '创建并进入').click()
  await page.getByRole('heading', {name, exact:true}).waitFor()
}
/** A new session is a group chat: the owner, the liaison and the workspace's staff. Only a title is asked for. */
export async function createSession(page, title) {
  await button(page, '新建会话').click()
  const form = page.getByRole('dialog', {name:'新建会话'})
  await form.getByLabel('会话名称').fill(title)
  assert.equal(await form.getByLabel('会话类型').count(), 0, '新会话一律是群聊，不再选类型')
  assert.equal(await form.getByLabel('编程工具').count(), 0, '新会话一律是群聊，不再选编程工具')
  await button(form, '创建会话').click()
  await page.getByRole('heading', {name:title, exact:true}).waitFor()
}

/**
 * Coding tools join a group as staff members whose staff card names them as the executor. The scaffolded brain's 工程师
 * runs on Claude Code; `codexStaff` adds a Codex member card before the host starts.
 */
export const CODEX_STAFF = {id:'coder', name:'编码员'}
export const CLAUDE_STAFF = {id:'engineer', name:'工程师'}
export function codexStaff(brain) {
  writeFileSync(join(brain, 'staff', CODEX_STAFF.id + '.md'), '---\nname: ' + CODEX_STAFF.name + '\nexecutor: codex\nverifier: reviewer\n---\n负责按要求写代码、做网页和文稿，交付放在工作目录里并在回复里链接。\n')
}
/** Put staff members into a workspace (they are then members of all its groups). */
export async function joinStaff(host, scope, workspaceId, members) {
  for (const [staffId, duty] of members) {
    await host.api('/v2/workspaces/' + workspaceId + '/staff?scope=' + encodeURIComponent(scope), {scope, requestId:randomUUID(), action:'join', staffId, duty})
  }
}
/** The open workspace from the page's own location. */
export const openWorkspace = page => new URLSearchParams(new URL(page.url()).hash.slice(4)).get('workspace')
export async function createOrder(page,title,promise,owner) {
  await button(page,'新建工单').click()
  const form = page.getByRole('dialog',{name:'新建工单'})
  assert.equal(await form.getByLabel('交付类型').count(),0)
  assert.ok(!(await form.textContent()).includes('手机报名页'))
  await form.getByLabel('你想交办什么？').fill(title)
  if (promise) await form.getByLabel('承诺结果').fill(promise)
  if (owner) await form.getByLabel('负责人').fill(owner)
  await button(form,'交给团队').click()
  const detail = page.getByRole('heading',{name:title,exact:true,level:1})
  const receipt = button(page,'打开工单「' + title + '」')
  await detail.or(receipt).first().waitFor()
  if (!await detail.isVisible()) await receipt.click()
  await detail.waitFor()
}
/** A work order opens as its conversation; there is no separate 「打开会话」 step any more. */
export async function openOrderSession(page) {
  await page.getByRole('list',{name:'会话发言'}).or(page.getByLabel('发言',{exact:true})).first().waitFor()
}
/** On a narrow page the order's details (results, previews, controls) are folded under 「工单信息」 above the conversation. */
export async function openOrderInfo(page) {
  const fold = page.locator('details.v2-order-fold').first()
  await fold.or(page.getByRole('complementary',{name:'工单信息'})).first().waitFor()
  if (await fold.count() && !await fold.evaluate(el => el.open)) await fold.locator(':scope > summary').click()
}
/** From the session view back to the order; on the order page itself there is nothing to go back to. */
export async function backToOrder(page) {
  const back = button(page,'返回工单')
  if (await back.isVisible().catch(() => false)) await back.click()
}
export async function say(page, prompt, timeout = 45_000) {
  await page.getByLabel('发言', {exact:true}).fill(prompt)
  const response = page.waitForResponse(res => res.request().method() === 'POST' && /\/sessions\/[^/]+\/messages\?/.test(res.url()), {timeout})
  await button(page, '发送').click()
  const receipt = await response
  assert.equal(receipt.status(), 200, '发言应成功送达当前来源 ' + (receipt.ok() ? '' : await receipt.text()))
}
export async function signIn(page, host) {
  await page.context().addCookies(host.cookie().split('; ').map(row => ({
    name:row.slice(0,row.indexOf('=')), value:row.slice(row.indexOf('=')+1), url:host.base,
  })))
}
