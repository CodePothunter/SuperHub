/** Run a packaged candidate with the real DSH transport and deterministic model responses in a disposable brain. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['llm']
const ownerQuestion = '请选择采用校对版还是初版。'
const exhibit = ['核对来源甲', '核对来源乙', '核对来源丙']
const answers = ['甲来源已核对', '乙来源已核对', '丙来源已核对']
const draft = '请依次核对甲乙丙三份来源，全部核对后给我一个汇总。'

export function apply(ctx) {
  ctx.on('llm/stream', (request) => reply(request.messages))
}

function fixture(messages) {
  const prompts = messages.filter(row => row.role === 'user')
    .map(row => row.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '')
  const prompt = prompts.findLast(text => text.includes('群成员：') || text.startsWith('{"turn":')) ?? ''
  let input
  try { input = JSON.parse(prompt) } catch { /* ordinary group message */ }
  if (input?.source && input?.turn) {
    const {source, turn, order, members, pending, messages: lines} = input
    if (turn === 'owner' && source.text === '请采用校对版。') return JSON.stringify({kind: 'none', resolved: pending.map(row => row.id)})
    if (turn === 'liaison' && source.text === ownerQuestion) return JSON.stringify({kind: 'ask', text: ownerQuestion, sourceSeq: source.seq})
    const researcher = members.find(row => row.id === 'researcher')
    if (turn === 'liaison' && !order && source.text.includes(exhibit[0])) {
      const original = lines.findLast(row => row.speakerId === 'owner' && row.text === draft)
      return JSON.stringify({kind: 'continue', sourceSeq: original.seq, text: exhibit[0], memberIds: [researcher.id],
        title: '核对三份来源', promise: '提供三份来源的核对结论', reporting: 'final'})
    }
    if (turn === 'member' && order) {
      const index = answers.findIndex(answer => source.text.includes(answer))
      if (index >= 0 && index < answers.length - 1) return JSON.stringify({kind: 'continue', text: exhibit[index + 1], memberIds: [researcher.id]})
      if (index === answers.length - 1) return JSON.stringify({kind: 'deliver', text: answers.join('。') + '。', final: true})
    }
    return '{"kind":"none"}'
  }
  const latest = prompt.split(/\n#\d+ /).at(-1) ?? ''
  const index = exhibit.findIndex(step => latest.includes(step))
  if (index >= 0 && prompt.includes('你（研究员）')) return '工单回报\n\n' + answers[index]
  if (latest.includes(draft)) return '我按顺序安排研究员逐项核对。先' + exhibit[0] + '。'
  if (latest.includes('汇总会议信息')) return ownerQuestion
  return '收到。'
}

async function* reply(messages) {
  const text = fixture(messages)
  yield {type: 'block-start', index: 0, blockType: 'text'}
  yield {type: 'text-delta', index: 0, text}
  yield {type: 'block-end', index: 0, block: {type: 'text', text}}
  yield {type: 'finish', reason: {kind: 'stop'}}
}

async function run() {
  const {acceptanceHost, until} = await import('./acceptance-host.mjs')
  const host = await acceptanceHost({probe: 'workspace-engagement-acceptance.mjs', mobile: true})
  try {
    const rules = join(host.brain, 'rules.yaml')
    const yaml = (await import('yaml')).default
    writeFileSync(rules, yaml.stringify({...yaml.parse(readFileSync(rules, 'utf8')), rules: []}))
    await host.start()
    const {scope} = await host.api('/v2/bootstrap')
    const api = (path, body) => host.api(path + '?' + new URLSearchParams({scope}),
      body && {requestId: randomUUID(), ...body})
    const {workspace} = await api('/v2/workspaces', {name: '材料核查', goal: '整理可靠的来源记录'})
    const groups = '/v2/workspaces/' + workspace.id + '/sessions'
    await api('/v2/workspaces/' + workspace.id + '/staff', {action: 'join', staffId: 'researcher', duty: '核查来源'})
    const {session: discussion} = await api(groups, {title: '会议回顾'})
    await api(groups + '/' + discussion.id + '/messages', {text: '请汇总会议信息。'})
    const pending = await until(async () => (await api('/v2/owner-actions')).items[0], '群内待主人回应').catch(async error => {
      const view = await api(groups + '/' + discussion.id)
      throw new Error(error.message + '，会话：' + view.messages.map(row => row.text).join(' | '), {cause: error})
    })
    assert.equal(pending.question, ownerQuestion)
    assert.equal(pending.sessionId, discussion.id)
    const before = await api(groups + '/' + discussion.id)
    assert.ok(before.messages.some(row => row.id === pending.messageId && row.text === ownerQuestion))
    await host.stop(true)
    await host.start()
    assert.equal((await api('/v2/owner-actions')).items[0].id, pending.id)
    await api('/v2/owner-actions/' + pending.id + '/reply', {text: '请采用校对版。'})
    await until(async () => (await api('/v2/owner-actions')).items.length === 0, '待回应经有效答复解除')

    const {session} = await api(groups, {title: '逐项核对'})
    await api(groups + '/' + session.id + '/messages', {text: draft})
    const result = await until(async () => (await api('/v2/notices')).items.find(row => row.sessionId === session.id), '逐项核实完成后的汇总')
    const view = await api(groups + '/' + session.id)
    assert.deepEqual(view.messages.filter(row => row.text.startsWith('工单回报')).map(row => row.text.split('\n\n').at(-1)), answers)
    assert.deepEqual((await api('/v2/notices')).items.filter(row => row.sessionId === session.id).map(row => row.id), [result.id])
    const detail = await api('/v2/notices/' + result.id)
    for (const answer of answers) assert.ok(detail.text.includes(answer))
    console.log('PASS 群内待答重启恢复、有效答复销项、零工具逐项推进、唯一最终交付')
    const baseline = process.env.CHIEF_ENGAGEMENT_BASELINE
    const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE
    if (baseline && candidate) {
      for (const pkg of [baseline, candidate]) {
        await host.stop()
        host.install(resolve(pkg))
        await host.start()
        assert.equal((await host.api('/v2/bootstrap')).scope, scope)
        assert.deepEqual((await api('/v2/notices')).items.filter(row => row.sessionId === session.id).map(row => row.id), [result.id])
      }
      assert.deepEqual((await api('/v2/owner-actions')).items, [])
      console.log('PASS 隔离看板回退和重新升级，交付保持唯一')
    }
  } finally {
    await host.dispose()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run()
