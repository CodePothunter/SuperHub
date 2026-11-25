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
