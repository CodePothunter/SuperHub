import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { until } from './acceptance-host.mjs'
import { button, CODEX_STAFF, openOrderInfo, say, signIn } from './workspace-browser-fixture.mjs'

async function revise(page, row, text) {
  await button(row, '编辑历史消息').click()
  const editor = page.getByRole('dialog', {name:'编辑历史消息', exact:true})
  await editor.getByLabel('消息正文').fill(text)
  const posted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/edit'))
  await button(editor, '保存并重新续写').click()
  const response = await posted
  const receipt = await response.json()
  assert.equal(response.status(), 200, JSON.stringify(receipt))
  return {receipt, body:response.request().postDataJSON(), path:new URL(response.url()).pathname.slice('/chief/api'.length)}
}

export async function checkConversationEdits({host, desktop, mobile, scope, workspace}) {
  const root = '/v2/workspaces/' + workspace
  const scoped = (path, query = {}) => path + '?' + new URLSearchParams({scope,...query})
  const get = (path, query) => host.api(scoped(path, query))
  const post = (path, body) => host.api(scoped(path), {requestId:randomUUID(),...body})
  const hash = (extra = {}) => '/#v2?' + new URLSearchParams({scope,view:'workspace',workspace,...extra})
  const {session} = await post(root + '/sessions', {title:'核对历史编辑'})
  const sessionPath = root + '/sessions/' + session.id
  const order = async title => (await post(root + '/orders', {title, promise:title, owner:'接口人', sessionId:session.id})).order
  const first = await order('交付复写稿')
  const second = await order('核对另一份资料')
  const sessionCount = (await get(root)).sessions.length
  const initial = (await get(sessionPath)).traceId
  const before = '@' + CODEX_STAFF.name + ' 交付七天复写稿'
  await desktop.bringToFront()
  await desktop.goto(host.base + hash({order:first.id}))
  await say(desktop, '复写验收共同前文')
  await say(desktop, before)
  const rows = desktop.getByRole('list',{name:'会话发言'})
  await rows.getByText('已交付七天版本。').first().waitFor()
  await say(desktop, before)
  await until(async () => (await get(sessionPath)).messages.filter(row => row.text === before).length === 2, '两条同文的主人发言')
  await desktop.goto(host.base + hash({order:second.id}))
  await say(desktop, '另一张工单继续核对')
  const original = (await get(sessionPath)).messages.find(row => row.role === 'user' && row.text === before)
  assert.ok(original?.canEdit)
  const anchorSelector = '[data-message-id=' + JSON.stringify(original.id) + ']'
  await desktop.goto(host.base + hash({order:first.id}))
  await button(desktop.locator(anchorSelector),'编辑历史消息').click()
  const staleEditor = desktop.getByRole('dialog',{name:'编辑历史消息',exact:true})
  const staleDraft = '保留另一窗口的改稿'
  await staleEditor.getByLabel('消息正文').fill(staleDraft)

  await mobile.bringToFront()
  await mobile.goto(host.mobileBase + hash({order:first.id}))
  const address = mobile.url()
  const anchor = mobile.locator(anchorSelector)
  await button(anchor, '编辑历史消息').click()
  const editor = mobile.getByRole('dialog',{name:'编辑历史消息',exact:true})
  assert.equal(await editor.getByLabel('消息正文').inputValue(), before)
  await button(editor,'取消').click()
  const revised = await revise(mobile, anchor, '@' + CODEX_STAFF.name + ' 交付三天复写稿')
  assert.equal(mobile.url(), address)
  assert.equal(revised.receipt.sessionId, session.id)
  assert.notEqual(revised.receipt.traceId, initial)
  assert.deepEqual(await host.api(scoped(revised.path),revised.body), revised.receipt)
  await assert.rejects(post(revised.path, {...revised.body, requestId:randomUUID()}), {status:409})
  await desktop.bringToFront()
  const conflict = desktop.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/edit'))
  await button(staleEditor,'保存并重新续写').click()
  assert.equal((await conflict).status(),409)
  await staleEditor.getByRole('alert').waitFor()
  assert.equal(await staleEditor.getByLabel('消息正文').inputValue(),staleDraft)
  await button(staleEditor,'取消').click()
  const active = await until(async () => {
    const view = await get(sessionPath)
    return view.messages.some(row => row.text.includes('已交付三天版本')) && view
  }, '改稿后的成员交付')
  assert.ok(active.messages.some(row => row.text === '复写验收共同前文'))
  assert.ok(active.messages.every(row => row.text !== before && row.text !== '另一张工单继续核对'))
  assert.equal(active.messages.filter(row => row.id === revised.receipt.messageId).length, 1)
  assert.equal(active.messages.filter(row => row.text.includes('已交付三天版本')).length,1)
  assert.equal((await get(root)).sessions.length, sessionCount)
  const old = await get(sessionPath, {trace:initial})
  assert.equal(old.messages.filter(row => row.text === before).length, 2)
  assert.ok(old.messages.some(row => row.text === '另一张工单继续核对' && row.workOrderId === second.id))

  await desktop.bringToFront()
  await desktop.goto(host.base + hash({panel:'outputs'}))
  await desktop.getByRole('button',{name:/^复写稿(?:\s|$)/}).click()
  const file = desktop.getByRole('dialog',{name:'复写稿',exact:true})
  await file.getByText('三天复写稿',{exact:true}).waitFor()
  await file.getByLabel('交付版本').selectOption({index:1})
  await file.getByText('七天复写稿',{exact:true}).waitFor()
  await button(file,'查看来源').click()
  await desktop.getByText('编辑前的对话',{exact:true}).waitFor()
  await desktop.getByText('另一张工单继续核对',{exact:true}).first().waitFor()
  const sourceAnchor = new URLSearchParams(new URL(desktop.url()).hash.slice(4))
  assert.equal(sourceAnchor.get('trace'),initial)
  assert.equal(sourceAnchor.get('session'),session.id)
  await button(desktop,'返回当前对话').click()
  await desktop.getByText('已交付三天版本。').first().waitFor()
  const sharedPrefix = active.messages.find(row => row.text === '复写验收共同前文')
  await desktop.goto(host.base + hash({panel:'execution',session:session.id,order:first.id,message:sharedPrefix.id}))
  await desktop.getByText('编辑前的对话',{exact:true}).waitFor()
  await desktop.getByText('已交付七天版本。').first().waitFor()

  await mobile.bringToFront()
  await mobile.goto(host.mobileBase + hash({order:second.id}))
  await openOrderInfo(mobile)
  await button(mobile,'删除工单').click()
  const deleteOrder = mobile.getByRole('dialog',{name:'删除工单？',exact:true})
  await deleteOrder.getByText(second.title,{exact:true}).waitFor()
  await button(deleteOrder,'确认删除').click()
  await mobile.waitForURL(url => !new URLSearchParams(url.hash.slice(4)).has('order'))
  const deletedOrder = await until(async () => {
    const response = await host.api(scoped(root + '/orders/' + second.id), undefined, {raw:true})
    return response.status === 410
  }, '只删除第二张工单')
  assert.ok(deletedOrder)
  await mobile.goto(host.mobileBase + hash({order:second.id}))
  await mobile.getByText('工单已删除。',{exact:true}).waitFor()
  assert.ok((await get(root)).orders.some(row => row.id === first.id))
  assert.equal((await get(root)).sessions.length, sessionCount)
  const oldAfterDelete = await get(sessionPath,{trace:initial})
  assert.ok(oldAfterDelete.messages.some(row => row.text === '另一张工单继续核对' && row.workOrderDeletedAt))
  const deleteReceipt = await post(root + '/orders/' + second.id + '/delete', {})
  assert.equal((await post(root + '/orders/' + second.id + '/delete', {})).deletedAt, deleteReceipt.deletedAt)

  await desktop.bringToFront()
  await desktop.goto(host.base + hash({panel:'execution', session:session.id}))
  await button(desktop,'删除会话').click()
  const deleteSession = desktop.getByRole('dialog',{name:'删除会话？',exact:true})
  await deleteSession.getByText(session.title,{exact:true}).waitFor()
  await button(deleteSession,'确认删除').click()
  await desktop.waitForURL(url => !new URLSearchParams(url.hash.slice(4)).has('session'))
  await until(async () => (await get(root)).orders.some(row => row.id === first.id && row.sessionDeletedAt), '保留关联工单')
  await desktop.goto(host.base + hash({panel:'execution', session:session.id, trace:initial}))
  await desktop.getByText('会话已删除。',{exact:true}).waitFor()
  await desktop.goto(host.base + hash({order:first.id}))
  await desktop.getByText('所属会话已删除。',{exact:true}).waitFor()
  await assert.rejects(post(sessionPath + '/messages',{text:'删除后拒绝发言'}), {status:410})
  const firstOrderPath = root + '/orders/' + first.id
  const surviving = (await get(firstOrderPath + '/outputs')).outputs.filter(row => row.attachment.label === '复写稿')
  assert.equal(surviving.length,2)
  const files = []
  for (const row of surviving) {
    assert.ok(row.sessionDeletedAt && row.attachment.version)
    const path = scoped(firstOrderPath + '/outputs/' + row.attachment.id, {
      trace:row.traceId, message:row.messageId, version:row.attachment.version,
    })
    const {attachment} = await host.api(path)
    const content = row.traceId === initial ? '# 七天复写稿\n' : '# 三天复写稿\n'
    assert.equal(attachment.content,content)
    files.push({path,content})
  }
  return {sessionPath, initial, firstOrderPath, deletedOrderPath:root + '/orders/' + second.id, files}
}

export async function checkLiaisonEdit({host, page, scope}) {
  const read = query => host.api('/chat?' + new URLSearchParams({scope,...query}))
  await page.bringToFront()
  await page.goto(host.base + '/#v2?' + new URLSearchParams({scope,view:'today'}))
  await button(page,/^一句话交办(，|$)/).click()
  const liaison = page.getByRole('dialog',{name:'接口人',exact:true})
  async function send(words, reply) {
    await liaison.getByLabel('对接口人说').fill(words)
    await button(liaison,'发送').click()
    await liaison.getByText(reply,{exact:true}).waitFor()
  }
  const previous = '请先拟七天的续写验收计划'
  await send('接口人续写保留的共同前文','记住了续写验收的共同前文。')
  await send(previous,'旧版计划按七天安排。')
  await send('接口人续写时排除这条后文','旧版后文已经收到。')
  const before = await read({limit:40})
  const prior = before.messages.find(row => row.role === 'you' && row.text === previous)
  const row = liaison.locator('[data-message-id="you-' + (prior.messageId ?? prior.firstSeq ?? prior.seq) + '"]')
  const {receipt} = await revise(page,row,'请先拟三天的续写验收计划')
  assert.equal(receipt.sessionId,before.sessionId)
  await liaison.getByText('已按原前文续写三天计划。',{exact:true}).waitFor()
  assert.ok((await read({trace:before.traceId,limit:40})).messages.some(row => row.text === '旧版后文已经收到。'))
  return {before, receipt}
}

export async function verifyConversationRestart({host, page, scope, group, liaison}) {
  await host.stop()
  await host.start()
  await signIn(page,host)
  const query = '?scope=' + encodeURIComponent(scope)
  await assert.rejects(host.api(group.deletedOrderPath + query),{status:410})
  await assert.rejects(host.api(group.sessionPath + query + '&trace=' + group.initial),{status:410})
  assert.ok((await host.api(group.firstOrderPath + query)).order.sessionDeletedAt)
  for (const {path, content} of group.files) assert.equal((await host.api(path)).attachment.content, content)
  const current = await host.api('/chat' + query + '&limit=40')
  assert.equal(current.sessionId,liaison.receipt.sessionId)
  assert.equal(current.traceId,liaison.receipt.traceId)
  assert.ok(current.messages.some(row => row.text === '已按原前文续写三天计划。'))
}
