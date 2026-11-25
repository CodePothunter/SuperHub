/** Exercise both real owner transports and the scoped model input before and after reset and restart. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceHost, until } from './acceptance-host.mjs'
import { button, signIn } from './workspace-browser-fixture.mjs'

const host = await acceptanceHost({mobile:true,probe:'workspace-v2-probe.mjs'})
const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
const name = '轮值访谈研究员'
const dialogueStaff = '社区导览员'
const dialogueRequest = '帮我加一位社区导览员，负责帮助新成员上手。'
const builtInPortraits = [
  ['研判官','bell','apricot'], ['工程师','wrench','blue'], ['外务','key','teal'], ['研究员','compass','mint'],
  ['审查官','lighthouse','violet'], ['书记官','pencil','honey'], ['谋士','hourglass','blue'], ['界面师','fan','rose'],
]
const method = '访谈结束复述约定'
const sourceOnly = '甲的虚构访谈对象'
const independent = '乙的独立经验'
const timedMethod = '访谈阶段要在每次核对时标明原始出处。'
const shanghaiDay = offset => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0,10)
const shanghaiCutoff = day => new Date(Date.parse(day + 'T00:00:00+08:00') + 86_400_000).toISOString()
let browser, pageUnderTest
async function capturePicker(picker, label) {
  assert.ok(await picker.evaluate(el => el.scrollWidth <= el.clientWidth+1))
  if (process.env.CHIEF_SCREENSHOT_DIR) {
    mkdirSync(process.env.CHIEF_SCREENSHOT_DIR,{recursive:true})
    await picker.screenshot({path:join(process.env.CHIEF_SCREENSHOT_DIR,'staff-portrait-'+label+'.png')})
  }
}
async function checkRosterPortrait(page, name, shape, color) {
  const icon = button(page,name).locator('.v2-chat-avatar')
  await icon.waitFor()
  assert.equal(await icon.getAttribute('data-shape'),shape,name)
  if (color) assert.equal(await icon.getAttribute('data-color'),color,name)
}
try {
  copyFileSync(new URL('../templates/dev/staff/ui-smith.md',import.meta.url),join(host.brain,'staff','ui-smith.md'))
  await host.start()
  const password = randomUUID()
  await host.api('/settings/password',{password})
  await host.api('/settings',{liaisonModel:'deepseek-official/deepseek-flash'})
  const {scope} = await host.api('/v2/bootstrap')
  const query = '?scope=' + encodeURIComponent(scope)
  const api = (path, data) => host.api(path + (path.includes('?') ? '&' + query.slice(1) : query), data && {...data,scope,requestId:randomUUID()})
  const project = async name => (await api('/v2/workspaces',{name,goal:'完成访谈验收'})).workspace.id
  const source = await project('访谈甲组')
  const target = await project('研发乙组')
  const workspace = id => '/v2/workspaces/' + id
  const staff = id => workspace(id) + '/staff'
  const cardUrl = (base, id, staffId) => base + '/#v2?' + new URLSearchParams({scope,view:'workspace',workspace:id,panel:'staff',...(staffId && {item:staffId})})
  const experienceUrl = (base,id) => base + '/#v2?' + new URLSearchParams({scope,view:'workspace',workspace:id,panel:'experience'})
  browser = await chromium.launch({headless:true,...process.env.CHIEF_CHROMIUM_PATH && {executablePath:process.env.CHIEF_CHROMIUM_PATH}})
  const desktop = await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'})
  pageUnderTest = desktop
  desktop.setDefaultTimeout(12000)
  await signIn(desktop,host)
  await desktop.goto(host.base)
  await button(desktop,'设置').click()
  await button(desktop,'我的幕僚').click()
  for (const [role,shape,color] of builtInPortraits) await checkRosterPortrait(desktop,role,shape,color)
  if (process.env.CHIEF_SCREENSHOT_DIR) {
    mkdirSync(process.env.CHIEF_SCREENSHOT_DIR,{recursive:true})
    await desktop.getByRole('region',{name:'我的幕僚'}).locator('.v2-card').screenshot({path:join(process.env.CHIEF_SCREENSHOT_DIR,'staff-default-portraits.png')})
  }
  await button(desktop,'创建全局幕僚').click()
  await desktop.getByLabel('名称',{exact:true}).fill(name)
  await desktop.getByLabel('职责',{exact:true}).fill('整理访谈方法')
  await button(desktop,'创建').click()
  const member = await until(async () => (await api('/v2/staff')).members.find(row=>row.name===name),'新幕僚')
  assert.equal(member.defaultPortrait.shape,'compass')
  assert.deepEqual(member.portrait,member.defaultPortrait)
  const {sessionId} = await host.api('/chat')
  await host.api('/chat',{scope,sessionId,text:dialogueRequest,mode:'auto',request_id:randomUUID(),context:{surface:'today'}})
  const native = await until(async () => (await api('/v2/staff')).members.find(row=>row.name===dialogueStaff),'接口人新建幕僚')
  assert.equal(native.defaultPortrait.shape,'sprout')
  assert.deepEqual(native.portrait,native.defaultPortrait)
  console.log('PASS 八位内置幕僚轮廓各异，网页和接口人新建幕僚均选用职责头像')
  const staffId = member.id
  const roleUrl = base => base + '/#v2?' + new URLSearchParams({scope,view:'settings',panel:'staff',item:staffId})
  await desktop.goto(roleUrl(host.base))
  const chosen = {shape:'compass',color:member.defaultPortrait.color === 'violet' ? 'teal' : 'violet'}
  const choosePortrait = async page => {
    await button(page,'更换头像').click()
    const picker=page.getByRole('dialog',{name:'更换头像'})
    assert.equal(await picker.getByRole('radio').count(),17)
    await picker.getByRole('radio',{name:'指南针',exact:true}).check()
    await picker.getByRole('radio',{name:chosen.color === 'teal' ? '湖青' : '鸢紫',exact:true}).check()
    const preview=picker.locator('[data-portrait-preview] svg')
    assert.equal(await preview.getAttribute('data-shape'),chosen.shape)
    assert.equal(await preview.getAttribute('data-color'),chosen.color)
    return picker
  }
  const trial = await choosePortrait(desktop)
  await capturePicker(trial,'desktop')
  await button(trial,'取消').click()
  const currentPortrait=async () => (await api('/v2/staff')).members.find(m=>m.id===staffId).portrait
  assert.deepEqual(await currentPortrait(),member.portrait)
  await button(await choosePortrait(desktop),'保存头像').click()
  await until(async () => (await currentPortrait()).color===chosen.color,'选定头像已保存')
  for (const id of [source,target]) {
    await desktop.goto(host.base + '/#v2?' + new URLSearchParams({scope,view:'workspace',workspace:id}))
    await button(desktop,'幕僚').click()
    await button(desktop,'邀请幕僚').click()
    await desktop.getByRole('combobox',{name:/^选择幕僚/}).selectOption(staffId)
    await desktop.getByLabel('本区职责',{exact:true}).fill('核对本区访谈提纲')
    await button(desktop,'确认邀请').click()
    await until(async () => (await api(staff(id))).members.some(row=>row.id===staffId),'本区参与')
  }
  await desktop.goto(cardUrl(host.base,source,staffId))
  await button(desktop,'添加经验').click()
  await desktop.getByLabel('经验内容',{exact:true}).fill(method+'。'+sourceOnly+'。')
  await button(desktop,'保存经验').click()
  await until(async () => (await api(staff(source))).memories.some(m=>m.text.includes(method)), '来源经验')
  await host.api('/chat',{scope,sessionId,text:'请轮值访谈研究员记住本区做法：乙的独立经验。',mode:'auto',
    request_id:randomUUID(),context:{surface:'workspace',selectedId:target}})
  await until(async ()=>(await api(staff(target))).memories.some(m=>m.staffId===staffId && m.text===independent),'从接口人登记本区原话')
  await host.api('/chat',{scope,sessionId,text:'以后本区访谈结束都先核对原始录音。',mode:'auto',
    request_id:randomUUID(),context:{surface:'workspace',selectedId:source}})
  const common = await until(async () => (await api(staff(source))).sharedExperiences?.find(memory=>memory.text.includes('核对原始录音')), '进经验库的原话')
  assert.ok(common.evidence.some(evidence=>evidence.quote === '以后本区访谈结束都先核对原始录音。'))
  async function confirmLiaison(id, message, expected) {
    const text = '请你自己核对访谈流程' + message
    await host.api('/chat',{scope,sessionId,text,mode:'auto',request_id:randomUUID(),context:{surface:'workspace',selectedId:id}})
    await until(async () => {
      const recent = (await host.api('/chat')).messages
      const at = recent.findLastIndex(row=>row.text === text)
      return at >= 0 && recent.slice(at + 1).some(row=>row.text === expected)
    },expected)
  }
  await confirmLiaison(source,'（甲区）','已收到本区共同经验。')
  await confirmLiaison(target,'（乙区）','本轮没有这条共同经验。')
  const storedStaff = join(host.brain,'ops','superhub-staff')
  const staffFile = join(storedStaff,readdirSync(storedStaff).find(name=>name.endsWith('.json')))
  const readLedger = () => JSON.parse(readFileSync(staffFile,'utf8'))
  const deliveries = Object.values(readLedger().deliveries)
  assert.ok(deliveries.some(row=>row.workspaceId===source && row.executorId==='liaison' &&
    row.entries.some(entry=>entry.id===common.id && entry.version===common.version)))
  assert.ok(!deliveries.some(row=>row.workspaceId===target && row.entries.some(entry=>entry.id===common.id)))
  const ask = '核对本轮获准的访谈方法和独立经验'
  async function assign(id) {
    const {order} = await api(workspace(id)+'/orders',{staffId,title:ask,promise:'核对当前可用记录'})
    assert.equal(order.staffId,staffId)
    return order
  }
  async function replies(id,order,min) {
    return until(async () => {
      const data=await api(workspace(id)+'/sessions/'+order.sessionId)
      const messages=data.messages.filter(m=>m.workOrderId===order.id && m.role==='agent' && m.author===name)
      return messages.length>=min && messages.at(-1).text
    },'具名幕僚在负责会话的回复')
  }
  await button(desktop,'交给这位幕僚').click()
  const orderForm=desktop.getByRole('dialog',{name:'新建工单'})
  await orderForm.getByRole('textbox',{name:'你想交办什么？'}).fill(ask)
  await orderForm.getByRole('textbox',{name:'承诺结果'}).fill('核对当前可用记录')
  const firstOrder=desktop.waitForResponse(response=>response.request().method()==='POST' && response.url().includes('/orders?'))
  await button(orderForm,'交给团队').click()
  const {order:original}=await (await firstOrder).json()
  assert.equal(original.staffId,staffId)
  const originalReply=await replies(source,original,1)
  assert.ok(originalReply.includes(method) && originalReply.includes(sourceOnly) && originalReply.includes('先核对原始录音') && !originalReply.includes(independent), originalReply)
  const unseen=await assign(target)
  const isolated=await replies(target,unseen,1)
  assert.ok(isolated.includes(independent) && !isolated.includes(method) && !isolated.includes(sourceOnly) && !isolated.includes('先核对原始录音'), isolated)
  console.log('PASS 本区共同经验在接口人和幕僚的实际请求中生效，另一工作区隔离')
  async function verifyConversationPortrait(page,base,id,order,expected) {
    await page.goto(base + '/#v2?' + new URLSearchParams({scope,view:'workspace',workspace:id,panel:'execution',session:order.sessionId,order:order.id}))
    const row=page.locator('[data-message-id]').filter({has:page.locator('.v2-byline strong',{hasText:name})}).first()
    const icon=row.locator('.v2-chat-avatar')
    await icon.waitFor()
    assert.equal(await icon.getAttribute('data-shape'),expected.shape)
    assert.equal(await icon.getAttribute('data-color'),expected.color)
  }
  await verifyConversationPortrait(desktop,host.base,source,original,chosen)
  await verifyConversationPortrait(desktop,host.base,target,unseen,chosen)
  console.log('PASS 全套造型配色可选择，取消不保存，同一幕僚在两区的原工单使用选定头像')
  console.log('PASS 同一幕僚在两区的首次执行只收到本区经验')
  await desktop.goto(cardUrl(host.base,source,staffId))
  await button(desktop,'共享经验').click()
  await desktop.getByRole('combobox',{name:/^接收工作区/}).selectOption(target)
  await desktop.getByRole('combobox',{name:/^接收幕僚/}).selectOption(staffId)
  await desktop.getByRole('textbox',{name:'共享内容',exact:true}).fill(method)
  await button(desktop,'预览共享').click()
  const preview=desktop.getByRole('region',{name:'共享预览'})
  assert.ok((await preview.textContent()).includes(method) && !(await preview.textContent()).includes(sourceOnly))
  await button(desktop,'确认共享').click()
  await until(async () => (await api(staff(target))).received.some(row=>row.text===method),'选定内容到达乙')
  const shared=await assign(target)
  const sharedReply=await replies(target,shared,1)
  assert.ok(sharedReply.includes(independent) && sharedReply.includes(method) && !sharedReply.includes(sourceOnly))
  console.log('PASS 收到预览选定的文字并用于实际执行，来源原文未随共享带入')

  const expiryDate = shanghaiDay(2)
  await desktop.goto(experienceUrl(host.base,source))
  await button(desktop,'添加共同经验').click()
  const expiryForm = desktop.getByRole('dialog',{name:'添加经验'})
  await expiryForm.getByLabel('经验内容',{exact:true}).fill(timedMethod)
  await expiryForm.locator('input[type=date]').fill(expiryDate)
  await button(expiryForm,'保存经验').click()
  const timed = await until(async () => (await api(staff(source))).sharedExperiences?.find(memory=>memory.text===timedMethod),'已保存有期限的经验')
  assert.equal(timed.expiresAt,shanghaiCutoff(expiryDate))
  assert.deepEqual([timed.maintenance.action,timed.maintenance.actor],['learn','manual'])
  const deliveredTo = (order,version) => Object.values(readLedger().deliveries).some(row=>row.orderId===order.id &&
    row.entries.some(entry=>entry.id===timed.id && entry.version===version))
  const timedOrder = await assign(source)
  await replies(source,timedOrder,1)
  assert.ok(deliveredTo(timedOrder,timed.version),'期限内经验应已提供给实际执行者')

  const mobile=await browser.newPage({isMobile:true,hasTouch:true,viewport:{width:320,height:740},colorScheme:'dark',timezoneId:'America/Los_Angeles'})
  pageUnderTest=mobile
  await mobile.goto(host.mobileBase)
  await mobile.getByLabel('密码').fill(password)
  await button(mobile,'进入').click()
  await mobile.getByRole('heading',{name:'今天',exact:true}).waitFor()
  await button(mobile,'设置').click()
  await button(mobile,'我的幕僚').click()
  for (const [role,shape,color] of builtInPortraits) await checkRosterPortrait(mobile,role,shape,color)
  await checkRosterPortrait(mobile,dialogueStaff,'sprout')
  await button(mobile,name).waitFor()
  const inList=button(mobile,name).locator('.v2-chat-avatar')
  assert.equal(await inList.getAttribute('data-color'),chosen.color)
  await button(mobile,name).click()
  await button(mobile,'更换头像').click()
  await capturePicker(mobile.getByRole('dialog',{name:'更换头像'}),'mobile')
  await button(mobile,'取消').click()
  await mobile.goto(cardUrl(host.mobileBase,source))
  const workspaceNav = mobile.getByRole('navigation',{name:'工作区版面'})
  await button(workspaceNav,'经验').click()
  assert.equal(await button(workspaceNav,'经验').getAttribute('aria-current'),'page')
  assert.match(mobile.url(),/[?&]panel=experience(?:&|$)/)
  const sections = await workspaceNav.getByRole('button').allTextContents()
  assert.deepEqual(sections,['概览','执行','产物','幕僚','经验'])
  assert.ok(await workspaceNav.evaluate(el => [...el.querySelectorAll('button')].every(button => {
    const bounds = button.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.height >= 44
  })))
  const commonRegion = mobile.getByRole('region',{name:'本区共同经验'})
  const commonCard = commonRegion.getByRole('article').filter({hasText:'先核对原始录音'})
  await commonCard.waitFor()
  await commonCard.getByText('按本人指示',{exact:true}).waitFor()
  const mobileTimed = commonRegion.getByRole('article').filter({hasText:timedMethod})
  await mobileTimed.getByText('手动添加',{exact:true}).waitFor()
  await button(mobileTimed,'更正').click()
  const mobileExpiry = mobile.getByRole('dialog',{name:'更正经验'})
  assert.equal(await mobileExpiry.locator('input[type=date]').inputValue(),expiryDate)
  await button(mobileExpiry,'关闭详情').click()
  assert.ok(await mobile.locator('.v2-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1))
  const sharedProjection = await api(staff(source)+'?experience=shared')
  assert.deepEqual(sharedProjection.members,[])
  assert.deepEqual(sharedProjection.memories,[])
  assert.ok(!JSON.stringify(sharedProjection).includes(sourceOnly))
  await commonCard.getByText('查看依据',{exact:true}).click()
  await commonCard.getByText('主人原话',{exact:true}).waitFor()
  const correction = '本区访谈交接先核对原始录音并确认摘要。'
  await button(commonCard,'更正').click()
  await mobile.getByRole('dialog',{name:'更正经验'}).getByRole('textbox',{name:'经验内容',exact:true}).fill(correction)
  await button(mobile,'保存更正').click()
  await commonCard.getByText(correction,{exact:true}).waitFor()
  await button(commonCard,'停用').click()
  await until(async () => (await api(staff(source))).sharedExperiences?.some(memory=>memory.id===common.id && memory.status==='retired'),'手机停用共同经验')
  await commonCard.getByText('历史版本',{exact:true}).click()
  await button(commonCard,'版本 '+common.version).click()
  await button(commonCard,'恢复这个版本').click()
  await until(async () => (await api(staff(source))).sharedExperiences?.some(memory=>memory.id===common.id && memory.status==='active' && memory.text===common.text),'手机恢复共同经验')
  console.log('PASS 320px 工作区经验页展示共同经验及依据，专属经验未透传，可更正、停用和恢复')
  await mobile.goto(cardUrl(host.mobileBase,source,staffId))
  await button(mobile,'重置本区记忆').click()
  const confirm = button(mobile,'确认重置')
  await confirm.waitFor()
  const metrics = await mobile.locator('.v2-page').evaluate(el=>{
    const right = el.getBoundingClientRect().right
    const overflowing = [...el.querySelectorAll('*')].filter(node=>node.getBoundingClientRect().right > right + 1)
      .slice(0,8).map(node=>({name:node.tagName,class:node.className,text:node.textContent?.slice(0,80)}))
    return {width:el.clientWidth,scroll:el.scrollWidth,overflowing}
  })
  assert.ok(metrics.scroll <= metrics.width + 1, JSON.stringify(metrics))
  await confirm.click()
  await until(async () => !(await api(staff(target))).received.length,'重置收回派生共享')
  await host.stop()
  // A stopped, isolated fixture crosses the deadline without depending on the wall clock or waiting for Dream.
  const ledger = readLedger()
  const expiredAt = shanghaiCutoff(shanghaiDay(-2))
  ledger.memories.find(memory=>memory.id===timed.id).expiresAt = expiredAt
  writeFileSync(staffFile,JSON.stringify(ledger)+'\n')
  await host.start()
  assert.deepEqual(await currentPortrait(),chosen)
  assert.deepEqual((await api('/v2/staff')).members.find(row=>row.id===native.id)?.defaultPortrait,native.defaultPortrait)
  // The order's conversation is a group: words without @ go to the liaison, so the owner calls the staff member by name.
  const continued=workspace(target)+'/sessions/'+shared.sessionId+'/messages'
  await api(continued,{workOrderId:shared.id,text:'@'+name+' '+ask})
  const after=await replies(target,shared,2)
  assert.ok(after.includes(independent) && !after.includes(method) && !after.includes(sourceOnly))
  assert.equal(await replies(source,original,1),originalReply)
  const targetView=await api(staff(target))
  assert.ok(targetView.memories.some(m=>m.text===independent))
  console.log('PASS 手机预览并重置甲，重启后乙在原工单续办，已撤回经验不会从旧回复恢复，主人仍能打开原记录')
  await signIn(desktop,host)
  const afterExpiry = await assign(source)
  await replies(source,afterExpiry,1)
  assert.equal(deliveredTo(afterExpiry,timed.version),false,'到期版本不应进入新的实际执行')
  await desktop.goto(experienceUrl(host.base,source))
  const expired = desktop.getByRole('region',{name:'本区共同经验'}).getByRole('article').filter({hasText:timedMethod})
  await expired.getByText('自动过期',{exact:true}).waitFor()
  assert.equal(await expired.locator('.v2-experience-meta time').getAttribute('datetime'),expiredAt)
  await expired.getByText('历史版本',{exact:true}).click()
  await button(expired,'版本 '+timed.version).click()
  await expired.getByText(/^这版的有效期已结束/).waitFor()
  assert.equal(await button(expired,'恢复这个版本').count(),0)
  await button(expired,'更新期限').click()
  const renewal = desktop.getByRole('dialog',{name:'更正经验'})
  await renewal.locator('input[type=date]').fill(expiryDate)
  await button(renewal,'保存更正').click()
  await expired.getByText('手动更正',{exact:true}).waitFor()
  const renewed = (await api(staff(source))).sharedExperiences.find(memory=>memory.id===timed.id)
  assert.equal(renewed.status,'active')
  assert.equal(renewed.expiresAt,shanghaiCutoff(expiryDate))
  const afterRenewal = await assign(source)
  await replies(source,afterRenewal,1)
  assert.ok(deliveredTo(afterRenewal,renewed.version),'延期后的新版本应提供给实际执行者')
  console.log('PASS 双端使用工作区日期，到期阻止实际送达，历史保留原因并可更新期限')
  await desktop.goto(host.base + '/#v2?' + new URLSearchParams({scope,view:'settings',panel:'staff',item:staffId}))
  await button(desktop,'重置全部记忆').click()
  await button(desktop,'确认重置').click()
  await until(async () => !(await api(staff(target))).memories.some(m=>m.staffId===staffId),'清空乙独立经验')
  assert.ok((await api(staff(source))).members.some(m=>m.id===staffId))
  console.log('PASS 整位幕僚重置清除乙的独立经验，可继续从原身份接单')
  await desktop.goto(roleUrl(host.base))
  await button(desktop,'更换头像').click()
  await button(desktop,'恢复默认头像').click()
  await button(desktop,'保存头像').click()
  await until(async () => (await currentPortrait()).color===member.defaultPortrait.color,'已恢复默认配色')
  await verifyConversationPortrait(desktop,host.base,target,shared,member.defaultPortrait)
  console.log('PASS 手机同步、宿主重启、记忆重置与恢复默认后，历史发言继续使用该成员的头像')
} catch (error) {
  if (pageUnderTest) console.error((await pageUnderTest.locator('.v2-page').ariaSnapshot().catch(()=>'' )).slice(-2600))
  throw error
} finally {
  await browser?.close()
  await host.stop()
}
