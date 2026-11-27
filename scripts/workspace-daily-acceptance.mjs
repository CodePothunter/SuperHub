import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { until } from './acceptance-host.mjs'
import { parse, stringify } from 'yaml'

const button = (page, name) => page.getByRole('button', {name, exact:true})
const navigation = page => page.getByRole('navigation', {name:'日常入口'})
const title = (page, name) => page.getByRole('heading', {name,exact:true,level:1})

export function connectTestCalendar(host) {
  const script = fileURLToPath(new URL('./workspace-calendar-mcp-fixture.mjs',import.meta.url))
  const path = join(host.home,'profiles/web/cordis.patch.yml')
  const patch = parse(readFileSync(path,'utf8'))
  patch.push({insert:[{id:'trial-mcp-calendar',name:'@deepseek-ai/dsh-mcp-client',config:{
    serverName:'calendar-trial',transport:'stdio',command:process.execPath,args:[script],
  }}]})
  writeFileSync(path,stringify(patch))
}

export async function checkCalendarConnection(host,scope) {
  const query = '?scope='+encodeURIComponent(scope)
  const connections = '/v2/connections'
  const server = 'calendar-trial'
  await until(async () => (await host.api(connections+query)).servers.includes(server),'DSH 原生发现 MCP 日历')
  const list = await host.api(connections+'/calendars/'+server+query)
  assert.ok(list.calendars.some(calendar => calendar.id==='trial'))
  const grant = {scope,server,resourceId:'trial',visibility:'busy',requestId:randomUUID()}
  const {resourceId} = await host.api(connections+'/bind'+query,grant)
  const agenda = await host.api('/v2/calendar'+query)
  const occupied = agenda.entries.filter(entry => entry.sourceId===resourceId)
  assert.equal(occupied.length,1,JSON.stringify({issues:agenda.issues,available:agenda.sources.map(s=>s.id),resourceId}))
  assert.equal(occupied[0].title,'已占用')
  assert.ok(!JSON.stringify(agenda).includes('协议验收会议'))
  await host.api(connections+'/remove/'+encodeURIComponent(resourceId)+query,{scope,requestId:randomUUID()})
  assert.ok(!(await host.api('/v2/calendar'+query)).entries.some(entry=>entry.sourceId===resourceId))
  console.log('PASS DSH 原生 MCP 发现、列出、绑定、仅忙闲读取及移除来源')
}

export async function readPeople(page, picture, device) {
  const nav = navigation(page)
  for (const name of ['今天','工作区','人物','日历']) await button(nav,name).waitFor()
  await button(nav,'人物').click()
  await title(page,'人物').waitFor()
  await page.getByRole('heading', {name:'客户团队',exact:true}).waitFor()
  const search = page.getByRole('searchbox', {name:'搜索人物'}).or(page.getByRole('textbox', {name:'搜索人物'}))
  await search.fill('这个人不存在')
  assert.equal(await page.getByRole('button',{name:/试点联系人林老师/}).count(),0)
  await search.fill('林老师')
  await picture(page, device+'-people')
  await page.getByRole('button',{name:/试点联系人林老师/}).click()
  await page.getByText(/是试点的资料对接人/).first().waitFor()
  await page.reload()
  await page.getByText(/是试点的资料对接人/).first().waitFor()
  await button(navigation(page),'今天').click()
  await title(page,'今天').waitFor()
}

export async function readCalendar(page, host, picture) {
  await button(navigation(page),'日历').click()
  await title(page,'日历').waitFor()
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()))
  await host.api('/meetings',{title:'本脑排期核对',at:today+'T10:30'})
  await page.reload()
  await page.getByText('本脑排期核对',{exact:true}).first().waitFor()
  await button(page,'管理日历来源').click()
  const sources = page.getByRole('dialog',{name:'管理日历来源'})
  await button(sources,'导入日历文件').click()
  await sources.getByLabel('应用名称').fill('测试日历 App')
  await sources.getByLabel('账号名称').fill('验收账号')
  await sources.getByLabel('日历名称').fill('试点日历')
  const stamp = today.replaceAll('-','')
  const file = [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//SuperHub//Acceptance//ZH',
    'BEGIN:VEVENT','UID:trial-calendar-event','DTSTAMP:'+stamp+'T000000Z',
    'DTSTART:'+stamp+'T040000Z','DTEND:'+stamp+'T050000Z','SUMMARY:来自日历文件的试点会议','END:VEVENT','END:VCALENDAR','',
  ].join('\r\n')
  await sources.getByLabel('日历文件').setInputFiles({name:'试点.ics',mimeType:'text/calendar',buffer:Buffer.from(file)})
  await button(sources,'导入').click()
  await sources.getByText('试点日历',{exact:true}).first().waitFor()
  await page.keyboard.press('Escape')
  await page.getByText('来自日历文件的试点会议',{exact:true}).first().waitFor()
  await picture(page,'desktop-calendar')
  await button(page,'下一周').click()
  await page.getByText('来自日历文件的试点会议',{exact:true}).first().waitFor({state:'hidden'})
  await button(page,'上一周').click()
  await button(page,'今天').last().click()
  await page.getByText('来自日历文件的试点会议',{exact:true}).first().waitFor()
  await button(page,/^一句话交办(，|$)/).click()
  const liaison = page.getByRole('dialog',{name:'接口人'})
  await liaison.getByLabel('对接口人说').fill('我今天有哪些安排？')
  await button(liaison,'发送').click()
  await liaison.getByText(/今天的安排包括.*来自日历文件的试点会议/).first().waitFor()
  await page.keyboard.press('Escape')
  await button(navigation(page),'今天').click()
}

export async function openCreatedWorkspace(page, host, scope) {
  await button(navigation(page),'今天').click()
  await button(page,/^一句话交办(，|$)/).click()
  const chat = page.getByRole('dialog', {name:'接口人'})
  const text = '建一个工作区 叫做 字节 Landing'
  await chat.getByLabel('对接口人说').fill(text)
  await button(chat,'发送').click()
  await chat.getByText('字节 Landing 工作区已就绪。',{exact:true}).waitFor()
  const readList = () => host.api('/v2/workspaces?scope='+encodeURIComponent(scope))
  const spaces = (await readList()).workspaces.filter(row => row.name==='字节 Landing')
  assert.equal(spaces.length,1)
  assert.equal(spaces[0].goal,'')
  const turn = (await host.api('/chat')).messages.findLast(m=>m.role==='liaison'&&m.text==='字节 Landing 工作区已就绪。')
  assert.ok(turn?.workspaces?.some(row=>row.id===spaces[0].id))
  await chat.getByRole('button',{name:/打开工作区/}).last().click()
  await title(page,'字节 Landing').waitFor()
  assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(4)).get('workspace'),spaces[0].id)
  await page.reload()
  await title(page,'字节 Landing').waitFor()
}

export async function checkLiaisonWorkspaceActions(desktop, mobile, host, scope, picture) {
  const query = '?scope=' + encodeURIComponent(scope)
  const list = async () => (await host.api('/v2/workspaces' + query)).workspaces
  const before = await list()
  const target = before.find(row => row.name === '字节 Landing')
  assert.ok(target)
  const read = id => host.api('/v2/workspaces/' + id + query)
  const beforeProjects = await Promise.all(before.map(row => read(row.id)))
  const confirmed = '你帮我做就行了，带工单也行，你就启动吧。'
  const question = '交接前需要核对哪两项？'
  const response = '交接前请核对来源和日期。'
  async function openChat(page) {
    await button(navigation(page), '今天').click()
    await button(page, /^一句话交办(，|$)/).click()
    return page.getByRole('dialog', {name:'接口人'})
  }
  async function say(chat, message) {
    await chat.getByLabel('对接口人说').fill(message)
    await button(chat, '发送').click()
    await chat.getByText(message, {exact:true}).last().waitFor()
  }
  async function waitTurn(message) {
    return until(async () => {
      const chat = await host.api('/chat')
      const mine = chat.messages.findLast(row => row.role === 'you' && row.text === message)
      return mine && !chat.busy && chat.messages.find(row => row.role === 'liaison' && row.seq > mine.seq)
    }, '接口人回答 ' + message)
  }
  const chat = await openChat(desktop)
  const first = '在字节 Landing 开个对话，不开工单。' + question
  await say(chat, first)
  const firstTurn = await waitTurn(first)
  const receipt = firstTurn.workspaces?.find(row => row.sessionId)
  assert.ok(receipt?.sourceMessageId)
  assert.equal(receipt.id, target.id)
  await say(chat, confirmed)
  const repeat = await waitTurn(confirmed)
  assert.equal(repeat.workspaces?.find(row => row.sessionId)?.sessionId, receipt.sessionId)
  const afterFirst = await read(target.id)
  assert.deepEqual(afterFirst.sessions.map(row => row.id), [receipt.sessionId])
  assert.deepEqual(afterFirst.orders, [])
  await button(chat, '打开对话「交接资料核对」').last().click()
  const feed = desktop.getByRole('list', {name:'会话发言'})
  await feed.getByText(response, {exact:true}).waitFor()
  await feed.getByText(question, {exact:true}).waitFor()
  const place = () => new URLSearchParams(new URL(desktop.url()).hash.slice(4))
  assert.equal(place().get('workspace'), target.id)
  assert.equal(place().get('session'), receipt.sessionId)
  assert.equal(place().get('message'), receipt.sourceMessageId)
  await picture?.(desktop, 'liaison-workspace-conversation')

  const next = await openChat(desktop)
  const held = '考虑在字节 Landing 开个对话，问补充材料最晚哪天交？先别执行。'
  await say(next, held)
  assert.equal((await waitTurn(held)).workspaces?.length ?? 0, 0)
  await say(next, confirmed)
  const afterConfirmation = await waitTurn(confirmed)
  const nextReceipt = afterConfirmation.workspaces?.find(row => row.sessionId)
  assert.ok(nextReceipt?.sessionId && nextReceipt.sessionId !== receipt.sessionId)
  assert.equal(nextReceipt.id, target.id)
  const thread = '/v2/workspaces/' + target.id + '/sessions/' + nextReceipt.sessionId
  const replied = await until(async () => {
    const view = await host.api(thread + query)
    return view.messages.some(row => row.replyTo === nextReceipt.sourceMessageId) && view
  }, '旧对话承接后的工作区答复')
  assert.ok(replied.messages.some(row => row.quote?.text === '补充材料最晚哪天交？'))
  const settings = '把字节 Landing 工作区的目标改成每周复核交接材料。'
  await say(next, settings)
  assert.equal((await waitTurn(settings)).workspaces?.[0]?.id, target.id)
  const after = await read(target.id)
  assert.equal(after.workspace.goal, '每周复核交接材料')
  assert.equal(after.sessions.length, 2)
  assert.equal(after.orders.length, 0)
  assert.deepEqual((await list()).map(row => row.id), before.map(row => row.id))
  for (const project of beforeProjects.filter(row => row.workspace.id !== target.id)) {
    const observed = await read(project.workspace.id)
    assert.deepEqual(observed.orders.map(row => row.id), project.orders.map(row => row.id))
    assert.deepEqual(observed.sessions.map(row => row.id), project.sessions.map(row => row.id))
  }
  await desktop.keyboard.press('Escape')
  await mobile.bringToFront()
  await mobile.reload()
  const mobileChat = await openChat(mobile)
  await button(mobileChat, '打开对话「补充材料核对」').last().click()
  const mobileFeed = mobile.getByRole('list', {name:'会话发言'})
  await mobileFeed.getByText('请提供交接日期，我再核对补充材料的最晚提交日。', {exact:true}).waitFor()
  const mobilePlace = new URLSearchParams(new URL(mobile.url()).hash.slice(4))
  assert.equal(mobilePlace.get('workspace'), target.id)
  assert.equal(mobilePlace.get('session'), nextReceipt.sessionId)
  assert.equal(mobilePlace.get('message'), nextReceipt.sourceMessageId)
  await picture?.(mobile, 'liaison-workspace-mobile-receipt')
  await desktop.bringToFront()
  console.log('PASS 主聊天零单开聊、承接上下文、去重、工作区配置及桌面和独立手机直达会话')
}
