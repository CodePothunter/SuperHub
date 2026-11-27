/** Run a packaged candidate with real DSH transport and deterministic model responses. Set CHIEF_PLAYWRIGHT_PATH for real browser checks. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const inject = ['llm']
const ownerQuestion = '请选择采用校对版还是初版。'
const workspaceName = '材料核查'
const liaisonTitle = '接口人转问会址'
const memberPrompt = '请核对活动的会址。'
const liaisonRequest = `在${workspaceName}开个对话，让研究员回答。${memberPrompt}`
const memberQuestion = '请告诉我活动几点到几点，以及在哪间会议室。'
const reportParagraph = `日程已核对。主人，${memberQuestion}`
const memberReport = `阶段回报\n\n${reportParagraph}`
const formatRequest = '请谋士复核格式。'
const formatReport = '已复核回报格式。'
const ownerAnswer = '活动从九点到十一点，用第二会议室。'
const exhibit = ['核对来源甲', '核对来源乙', '核对来源丙']
const answers = ['甲来源已核对', '乙来源已核对', '丙来源已核对']
const draft = '请依次核对甲乙丙三份来源，全部核对后给我一个汇总。'

export function apply(ctx) {
  ctx.on('llm/stream', (request) => reply(request))
}

function textOf(row) {
  return row?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
}

function fixture({messages, sessionId}) {
  if (sessionId?.startsWith('chief-liaison-') && textOf(messages.findLast(row => row.role === 'user' && row.source?.kind === 'user')) === liaisonRequest) {
    const id = 'site-detail-dialogue'
    const result = messages.find(row => row.role === 'tool' && row.toolCallId === id)
    if (result) return result.isError ? textOf(result) : '已转请研究员在群里核对会址。'
    return {type: 'tool-call', id, name: 'chief_workspace', arguments: JSON.stringify({action: 'start_session',
      name: workspaceName, title: liaisonTitle, staff_name: '研究员', question: memberPrompt, handoff: memberPrompt})}
  }
  const prompts = messages.filter(row => row.role === 'user')
    .map(textOf)
  const prompt = prompts.findLast(text => text.includes('群成员：') || text.startsWith('{"turn":')) ?? ''
  let input
  try { input = JSON.parse(prompt) } catch { /* ordinary group message */ }
  if (input?.source && input?.turn) {
    const {source, turn, order, members, pending, messages: lines} = input
    if (turn === 'owner' && source.text === '请采用校对版。') return JSON.stringify({kind: 'none', resolved: pending.map(row => row.id)})
    if (turn === 'liaison' && source.text === ownerQuestion) return JSON.stringify({kind: 'ask', text: ownerQuestion, sourceSeq: source.seq})
    if (turn === 'member' && !order && source.text.startsWith(memberReport)) return JSON.stringify({kind: 'ask', text: memberQuestion})
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
  if (prompt.includes('你（研究员）') && latest.includes(memberPrompt)) {
    return latest.includes(formatRequest) ? `${memberReport}\n\n@谋士 复核回报格式。` : memberReport
  }
  if (prompt.includes('你（谋士）') && latest.includes('请安排会址分工。')) return `@研究员 ${memberPrompt}`
  if (prompt.includes('你（谋士）') && latest.includes('@谋士 复核回报格式。')) return formatReport
  const index = exhibit.findIndex(step => latest.includes(step))
  if (index >= 0 && prompt.includes('你（研究员）')) return '工单回报\n\n' + answers[index]
  if (latest.includes(draft)) return '我按顺序安排研究员逐项核对。先' + exhibit[0] + '。'
  if (latest.includes('汇总会议信息')) return ownerQuestion
  return '收到。'
}

async function* reply(request) {
  const response = fixture(request)
  const block = typeof response === 'string' ? {type: 'text', text: response} : response
  yield {type: 'block-start', index: 0, blockType: block.type}
  if (block.type === 'text') yield {type: 'text-delta', index: 0, text: block.text}
  else yield {type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments}
  yield {type: 'block-end', index: 0, block}
  yield {type: 'finish', reason: {kind: block.type === 'text' ? 'stop' : 'tool-calls'}}
}

async function verifyMemberQuestionInBrowsers(host, scope, item, actionCount) {
  const {chromium} = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
  const {button, signIn} = await import('./workspace-browser-fixture.mjs')
  const password = randomUUID()
  await host.api('/settings/password', {password})
  const browser = await chromium.launch({headless: true,
    ...(process.env.CHIEF_CHROMIUM_PATH && {executablePath: process.env.CHIEF_CHROMIUM_PATH})})
  try {
    const desktop = await browser.newPage({viewport: {width: 1440, height: 900}})
    const phone = await browser.newPage({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true})
    await signIn(desktop, host)
    await desktop.goto(host.base + '/#v2?' + new URLSearchParams({scope, view: 'today'}))
    await phone.goto(host.mobileBase)
    await phone.getByLabel('密码').fill(password)
    await button(phone, '进入').click()
    const pending = (page, count) => page.getByRole('button', {name: new RegExp(`^一句话交办.*，${count} 件待回应$`)})
    const source = page => page.locator(`.v2-source-turn[data-message-id="${item.messageId}"]`)
    for (const page of [desktop, phone]) {
      await pending(page, actionCount).click()
      const popover = page.getByRole('dialog', {name: '接口人'})
      await popover.locator(`[data-owner-action-id="${item.id}"]`).click()
      await source(page).getByText(reportParagraph, {exact: true}).waitFor()
      await pending(page, actionCount).waitFor()
    }
    const answer = source(desktop).locator('.v2-owner-action-reply')
    await button(answer, '答复').click()
    await answer.getByRole('textbox', {name: '答复这件事'}).fill(ownerAnswer)
    await button(answer, '发送答复').click()
    for (const page of [desktop, phone]) await pending(page, actionCount - 1).waitFor()
    console.log('PASS 真实桌面和手机均从顶栏定位幕僚原话，桌面答复后双端销项')
  } finally {
    await browser.close()
  }
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
    const {workspace} = await api('/v2/workspaces', {name: workspaceName, goal: '整理可靠的来源记录'})
    const groups = '/v2/workspaces/' + workspace.id + '/sessions'
    for (const [staffId, duty] of [['researcher', '核查来源'], ['strategist', '复核格式']]) {
      await api('/v2/workspaces/' + workspace.id + '/staff', {action: 'join', staffId, duty})
    }
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

    const {sessionId: liaisonSession} = await host.api('/chat')
    await host.api('/chat', {text: liaisonRequest, mode: 'auto', sessionId: liaisonSession, scope, request_id: randomUUID()})
    const relayed = await until(async () => (await api('/v2/workspaces/' + workspace.id)).sessions.find(row => row.title === liaisonTitle), '接口人经真实工具建立普通群')
    const {session: direct} = await api(groups, {title: '主人点名核对会址'})
    await api(groups + '/' + direct.id + '/messages', {text: `@研究员 ${memberPrompt}${formatRequest}`})
    const {session: staffRelay} = await api(groups, {title: '幕僚接力核对会址'})
    await api(groups + '/' + staffRelay.id + '/messages', {text: '@谋士 请安排会址分工。'})
    const memberItems = []
    for (const group of [relayed, direct, staffRelay]) {
      const location = groups + '/' + group.id
      const report = await until(async () => (await api(location)).messages.find(row => row.author === '研究员' && row.text.startsWith(memberReport)), group.title + '的幕僚原话')
      const items = await until(async () => {
        const pending = (await api('/v2/owner-actions')).items.filter(row => row.sessionId === group.id)
        return pending.length && pending
      }, group.title + '产生待回应')
      assert.equal(items.length, 1)
      assert.equal(items[0].question, memberQuestion)
      assert.equal(items[0].messageId, report.id)
      assert.equal(items[0].orderId, undefined)
      memberItems.push(items[0])
    }
    await until(async () => (await api(groups + '/' + direct.id)).messages.some(row => row.author === '谋士' && row.text === formatReport), '混合回报中的同事接力')
    await host.stop(true)
    await host.start()
    assert.deepEqual((await api('/v2/owner-actions')).items.map(row => row.id).sort(), memberItems.map(row => row.id).sort())
    assert.equal((await api(groups + '/' + direct.id)).messages.filter(row => row.author === '谋士' && row.text === formatReport).length, 1)
    if (process.env.CHIEF_PLAYWRIGHT_PATH) await verifyMemberQuestionInBrowsers(host, scope, memberItems[0], memberItems.length)
    const remaining = (await api('/v2/owner-actions')).items
    for (const item of remaining) await api('/v2/owner-actions/' + item.id + '/reply', {text: ownerAnswer})
    await until(async () => (await api('/v2/owner-actions')).items.length === 0, '三种入口的待回应均已答复')
    for (const group of [relayed, direct, staffRelay]) {
      const view = await api(groups + '/' + group.id)
      assert.equal(view.messages.filter(row => row.role === 'user' && row.text === ownerAnswer).length, 1)
    }
    console.log('PASS 接口人转问、主人点名、幕僚接力均有唯一待回应，混合回报接力一次，重启与答复后保持一致')

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
