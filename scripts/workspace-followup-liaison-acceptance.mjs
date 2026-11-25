/** Replay a local model's choices through the packaged liaison and its real DSH tool pipeline. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { acceptanceHost, until } from './acceptance-host.mjs'

const host = await acceptanceHost({probe:'workspace-v2-probe.mjs'})
try {
  await host.start()
  await host.api('/pause',{paused:true})
  const {scope} = await host.api('/v2/bootstrap')
  const query = '?scope='+encodeURIComponent(scope)
  const {sessionId} = await host.api('/chat')
  const talk = async (text, context) => {
    await host.api('/chat',{scope,sessionId,text,context,mode:'auto',request_id:randomUUID()})
    return until(async () => {
      const chat = await host.api('/chat')
      const mine = chat.messages.findLast(row => row.role === 'you' && row.text === text)
      const reply = mine && chat.messages.find(row => row.role === 'liaison' && row.seq > mine.seq && row.text)
      if (!chat.busy && reply) {
        assert.ok(!reply.steps?.some(step => step.failed),JSON.stringify(reply.steps))
        return reply
      }
    },'本地接口人回执')
  }
  const words = '跟进展会约定。我答应小陈演示，小陈答应给样本，她还请我看预算，我没有答应。'
  const today = {surface:'today'}
  const given = await talk(words,today)
  assert.equal(given.workspaces?.length,1)
  const [{id:workspace,delegationId:order}] = given.workspaces
  const orderPath = '/v2/workspaces/'+workspace+'/orders/'+order
  const get = suffix => host.api(orderPath+suffix+query)
  const job = (await get('')).order
  assert.equal(job.title,'展会演示约定')
  assert.equal((await get('/original')).original.text,words)
  const receipt = await get('/followup')
  assert.deepEqual(receipt.commitments.map(row => row.kind).sort(),['mine','request','theirs'])
  for (const row of receipt.commitments) assert.ok(row.source.kind === 'liaison' && row.source.sessionId === sessionId && words.includes(row.quote))
  const heard = await talk('查刚才那张单目前记下的三项约定。',today)
  assert.equal(heard.workspaces?.[0]?.delegationId,order)
  const focused = {surface:'workspace',selectedId:workspace,sessionId:job.sessionId,workOrderId:order}
  const weekly = await talk('当前这张单每周五17:00出稿，请给我本周成稿，我自己转发。',focused)
  assert.equal(weekly.workspaces?.[0]?.delegationId,order)
  const saved = await get('/followup')
  assert.deepEqual(saved.schedule,{enabled:true,weekday:5,time:'17:00'})
  assert.equal(saved.reports.length,1)
  assert.match(saved.reports[0].markdown,/预算/)
  assert.match(saved.reports[0].markdown,/样本/)
  const project = await talk('这个工作区目前有哪些待跟进约定？',{surface:'workspace',selectedId:workspace})
  assert.equal(project.workspaces?.[0]?.id,workspace)
  await talk('先停掉这张单的自动周报。',focused)
  const stopped = await get('/followup')
  assert.equal(stopped.schedule.enabled,false)
  assert.equal(stopped.reports[0].id,saved.reports[0].id)
  const view = await host.api('/v2/workspaces/'+workspace+query)
  assert.equal(view.orders.length,1)
  const result = {source:'隔离 DSH 与本地模型回放',workspace,order,sessionId:job.sessionId,ownerSource:sessionId,commitments:3,
    reports:1,report:saved.reports[0].id,checked:['今天直接交办与逐条登记','上一条回执续读','定期及当期出稿','工作区全部未结约定','停用并保留本期稿']}
  if (process.env.CHIEF_FOLLOWUP_LIAISON_EVIDENCE) writeFileSync(process.env.CHIEF_FOLLOWUP_LIAISON_EVIDENCE,JSON.stringify(result,null,2)+'\n')
  console.log('PASS '+result.checked.join('、'))
} finally { await host.stop() }
