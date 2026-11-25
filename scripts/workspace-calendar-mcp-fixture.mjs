/** Disposable stdio server for the packaged DSH MCP bridge. It owns no credentials or network connections. */
import { createInterface } from 'node:readline'

const page = {pageSize:{type:'integer'},pageToken:{type:'string'}}
const inputs = {
  list_calendars:page,
  list_events:{...page,calendarId:{type:'string'},startTime:{type:'string'},endTime:{type:'string'},timeZone:{type:'string'}},
}

for await (const line of createInterface({input:process.stdin})) {
  if (!line.trim()) continue
  const message = JSON.parse(line)
  if (message.id === undefined) continue
  let result
  if (message.method === 'initialize') result = {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'calendar-acceptance',version:'1.0.0'}}
  if (message.method === 'ping') result = {}
  if (message.method === 'tools/list') result = {tools:Object.entries(inputs).map(([name,properties]) => ({
    name,description:name,inputSchema:{type:'object',properties},
  }))}
  if (message.method === 'tools/call') {
    const {name,arguments:args} = message.params
    let value
    if (name === 'list_calendars') value = {calendars:[{id:'trial',summary:'协议验收日历'}]}
    if (name === 'list_events' && args.calendarId === 'trial') value = {accessRole:'reader',events:[{
      id:'fixture-event',summary:'协议验收会议',
      start:{dateTime:args.startTime.slice(0,10)+'T12:00:00Z'},end:{dateTime:args.startTime.slice(0,10)+'T13:00:00Z'},
    }]}
    result = value ? {content:[{type:'text',text:JSON.stringify(value)}]}
      : {isError:true,content:[{type:'text',text:'未知的日历读取请求'}]}
  }
  const reply = result ? {result} : {error:{code:-32601,message:'Method not found'}}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...reply})+'\n')
}
