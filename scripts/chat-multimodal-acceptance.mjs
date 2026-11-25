/**
 * Runs synthetic chat attachment cases through a packaged Chief and a disposable DSH Web host.
 * CHIEF_ACCEPTANCE_PACKAGE identifies the candidate. CHIEF_ACCEPTANCE_BASE identifies a private test directory.
 * CHIEF_CHAT_MEDIA_CASES can select private,group,delegate,restart,text-only,rollback.
 * CHIEF_CHAT_MEDIA_MODEL overrides the model. The rollback case also takes CHIEF_CHAT_MEDIA_ROLLBACK_PACKAGE.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { acceptanceHost, until } from './acceptance-host.mjs'

const model = process.env.CHIEF_CHAT_MEDIA_MODEL ?? 'openai-codex/gpt-6.1-terra'
const enabled = new Set((process.env.CHIEF_CHAT_MEDIA_CASES ?? 'private,group,delegate,restart,text-only').split(','))
const host = await acceptanceHost({
  model, probe: 'liaison-core-probe.mjs', mobile: true, directory: process.env.CHIEF_ACCEPTANCE_BASE,
  extraEnv: { CHIEF_ACCEPTANCE_REAL_MODEL: '1', CHIEF_ACCEPTANCE_MEDIA: '1' },
})
const evidence = { model, cases: {} }
const sayResult = (name, detail) => { evidence.cases[name] = detail; console.log(name, JSON.stringify(detail)) }
const fixture = name => readFileSync(new URL('../test/fixtures/chat-input/' + name, import.meta.url))
const figure = { name: 'figure.png', mediaType: 'image/png', kind: 'image', bytes: fixture('figure.png') }
const plain = (name, value) => ({ name, mediaType: 'text/plain', bytes: Buffer.from(value) })
const material = [
  figure, plain('e.txt', 'Internal reference: MAPLE-6259'),
  { name: 'a.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: fixture('a.docx') },
  { name: 'b.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: fixture('b.xlsx') },
  { name: 'c.pdf', mediaType: 'application/pdf', bytes: fixture('c.pdf') },
  { name: 'd.pdf', mediaType: 'application/pdf', bytes: fixture('d.pdf') },
]
const question = '请只读取本消息的材料并直接用中文逐项回答，无需建单或产出文件。'
  + 'figure.png 的蓝色圆点在哪个图形里？e.txt 的编号是什么？a.docx 正文中的代号是什么？'
  + 'b.xlsx 的 Detail 工作表 Line-A 的金额是什么？c.pdf 第 1 页文字层里的编号是什么？'
  + 'd.pdf 是扫描件，请实际读取第 1 页页图，回答橙色圆形在蓝色矩形的哪边。'
const verifyAnswers = text => {
  for (const pattern of [/红色.*(?:方形|正方形|矩形|长方形)/, /MAPLE-6259/, /WREN-4817/, /4[ ,]?811/, /TEXT-LARCH-3892/, /右(?:边|侧|面)/]) assert.match(text, pattern)
}
let scope
let phoneLogin
let sessionId
let privateBody
let privateRefs
let groupPath
let groupTarget
let groupSource
const q = () => '?scope=' + encodeURIComponent(scope)
const get = path => host.api(path + q())
const post = (path, body) => host.api(path + q(), { requestId: randomUUID(), scope, ...body })
const chat = () => get('/chat')
const chatBody = (text, refs, context) => ({
  text, requestId: randomUUID(), scope, sessionId, inputAttachments: refs.map(ref => ref.id), ...(context && { context }),
})
const mobile = () => ({ baseUrl: host.mobileBase, login: phoneLogin, raw: true })
const route = (target, id, file) => '/chief/api/input-attachments' + (id ? '/' + id : '') + '?' + new URLSearchParams({
  scope, ...target, ...(file && { name: file.name, kind: file.kind ?? 'file' }),
})
const raw = (path, phone, options = {}) => fetch((phone ? host.mobileBase : host.base) + path, {
  redirect: 'manual', signal: AbortSignal.timeout(45_000), ...options,
  headers: { cookie: phone ? phoneLogin ?? '' : host.cookie(), ...options.headers },
})
async function upload(target, file, phone = false) {
  const response = await raw(route(target, undefined, file), phone, {
    method: 'POST', headers: { 'x-chief-request': '1', 'content-type': file.mediaType }, body: file.bytes,
  })
  const reply = await response.json()
  assert.equal(response.status, 201, file.name + ' 上传失败 ' + JSON.stringify(reply))
  assert.equal(reply.attachment.name, file.name)
  return reply.attachment
}
async function reopen(target, ref, bytes, phone = false) {
  const response = await raw(route(target, ref.id), phone)
  assert.equal(response.status, 200, ref.name)
  const received = Buffer.from(await response.arrayBuffer())
  // DSH is allowed to normalize image encoding, and the visual answer verifies its pixels.
  if (ref.kind === 'image') assert.ok(received.length && response.headers.get('content-type').startsWith('image/'))
  else assert.deepEqual(received, bytes)
}
async function login(password) {
  const response = await fetch(host.mobileBase + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password }) })
  assert.equal(response.status, 303)
  phoneLogin = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
  assert.ok(phoneLogin)
}
const probe = action => host.request('/chief-liaison-core-probe', { action })
const privateAnswer = async requestId => until(async () => {
  const view = await chat()
  const owner = view.messages.find(row => row.requestId === requestId)
  return owner && !view.busy && view.messages.find(row => row.role === 'liaison' && row.seq > owner.seq && row.text.trim())
}, '接口人完成合成附件问答', 360_000)
const groupAnswer = (path, from, pattern) => until(async () => {
  const rows = (await get(path)).messages.filter(row => row.author === '研究员' && row.seq > from)
  return rows.find(row => pattern.test(row.text))
}, '研究员从原件得到指定结果', 360_000)

try {
  if (model.startsWith('openai-codex/')) {
    const credentials = YAML.parse(readFileSync(join(homedir(), 'workspace/dsh/home/.credentials.yaml'), 'utf8'))
    const login = credentials.records?.['codex-subscription/accounts']?.payload
    const active = login?.accounts?.find(row => row.id === login.activeId) ?? login?.accounts?.[0]
    assert.ok(active?.credential?.access && active.credential.expires - Date.now() > 2 * 3600_000, '隔离验收需要有效的本机 DSH Codex 订阅')
    const isolated = { ...login, activeId: active.id, accounts: [{ ...active, credential: { ...active.credential, refresh: 'acceptance-refresh-disabled' } }] }
    writeFileSync(join(host.home, '.credentials.yaml'),
      YAML.stringify({ version: 1, records: { 'codex-subscription/accounts': { kind: 'grant', payload: isolated } } }), { mode: 0o600 })
    host.install('dsh-codex-subscription@3.2.24')
  }
  const rules = join(host.brain, 'rules.yaml')
  writeFileSync(rules, YAML.stringify({ ...YAML.parse(readFileSync(rules, 'utf8')), rules: [] }))
  await host.start()
  await host.api('/pause', { paused: true })
  ;({ scope } = await host.api('/v2/bootstrap'))
  ;({ sessionId } = await chat())
  const password = randomUUID()
  await host.api('/settings/password', { password })
  assert.equal((await raw(route({ sessionId }, undefined, figure), true, { method: 'POST', body: figure.bytes })).status, 401)
  await login(password)
  console.log('宿主就绪', model)

  if (enabled.has('private') || enabled.has('restart') || enabled.has('rollback')) {
    privateRefs = []
    for (const file of material) privateRefs.push(await upload({ sessionId }, file))
    privateBody = chatBody(question, privateRefs)
    const { receipt } = await host.api('/chat' + q(), privateBody)
    assert.deepEqual(receipt.source.inputAttachments, privateRefs)
    const answer = await privateAnswer(privateBody.requestId)
    verifyAnswers(answer.text)
    assert.deepEqual((await chat()).messages.find(row => row.requestId === privateBody.requestId).inputAttachments, privateRefs)
    for (let i = 0; i < material.length; i++) await reopen({ sessionId }, privateRefs[i], material[i].bytes, true)
    const routes = Object.values(await probe('routes')).flat()
    assert.ok(routes.some(row => row.media?.some(message => message.role === 'user' && message.kinds.includes('image') && message.kinds.includes('file'))))
    assert.ok(routes.some(row => row.media?.some(message => message.kinds.includes('image') && message.role.toLowerCase().includes('tool'))))
    sayResult('private', { answer: answer.text, readFromMobile: material.length, mediaAtModelBoundary: true })
  }

  if (enabled.has('group') || enabled.has('delegate')) {
    const { workspace } = await post('/v2/workspaces', { name: '多模态验收' })
    const workspacePath = '/v2/workspaces/' + workspace.id
    await post(workspacePath + '/staff', { action: 'join', staffId: 'researcher', duty: '根据业主提供的合成资料进行只读核对' })
    if (enabled.has('group')) {
      const { session } = await post(workspacePath + '/sessions', { title: '群聊识图' })
      groupPath = workspacePath + '/sessions/' + session.id
      groupTarget = { workspaceId: workspace.id, sessionId: session.id }
      groupSource = []
      for (const file of material) groupSource.push(await upload(groupTarget, file, true))
      const send = await host.api(groupPath + '/messages' + q(), {
        scope, requestId: randomUUID(), text: '@研究员 ' + question, inputAttachments: groupSource.map(ref => ref.id),
      }, mobile())
      assert.equal(send.status, 200, JSON.stringify(await send.clone().json()))
      const reply = await groupAnswer(groupPath, 0, /TEXT-LARCH-3892/)
      verifyAnswers(reply.text)
      for (let i = 0; i < material.length; i++) await reopen(groupTarget, groupSource[i], material[i].bytes)
      const proof = (await get(groupPath)).messages.find(row => row.role === 'user' && row.inputAttachments?.length)
      assert.deepEqual(proof.inputAttachments, groupSource)
      assert.equal((await raw(route({ sessionId }, groupSource[0].id), false)).status, 404)
      sayResult('group', { answer: reply.text, readFromDesktop: material.length, rejectedCrossSession: true })
    }
    if (enabled.has('delegate')) {
      const files = [plain('q1.txt', '报价版本 A\n合计：1985 元'), plain('q2.txt', '报价版本 B\n合计：2567 元')]
      const refs = await Promise.all(files.map(file => upload({ sessionId }, file)))
      const body = chatBody('请在「多模态验收」给研究员开一张工单，核对本轮两份报价的准确差额，把结论回复到工单里，不用生成文件。',
        refs, { surface: 'workspace', selectedId: workspace.id })
      await host.api('/chat' + q(), body)
      const order = await until(async () => (await get(workspacePath)).orders.find(row => row.staffId === 'researcher'), '研究员工单', 360_000)
      const orderPath = workspacePath + '/sessions/' + order.sessionId
      const first = await groupAnswer(orderPath, 0, /582/)
      const target = { workspaceId: workspace.id, sessionId: order.sessionId, workOrderId: order.id }
      assert.deepEqual((await get(orderPath)).messages.find(row => row.inputAttachments?.some(ref => ref.id === refs[0].id)).inputAttachments, refs)
      for (let i = 0; i < files.length; i++) await reopen(target, refs[i], files[i].bytes)
      const revised = plain('q2-r.txt', '报价版本 B（修订）\n合计：2502 元')
      const newRef = await upload({ sessionId }, revised, true)
      const follow = chatBody('请给当前研究员工单补充：用本轮附件替换第二份报价，第一份仍用原来的，重新算两份的差额并回复到这张工单里。明确这是当前工单的补充。',
        [newRef], { surface: 'workspace', selectedId: workspace.id, sessionId: order.sessionId, workOrderId: order.id })
      const submitted = await host.api('/chat' + q(), follow, mobile())
      assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()))
      const second = await groupAnswer(orderPath, first.seq, /517/)
      await reopen(target, newRef, revised.bytes)
      sayResult('delegate', { initial: first.text, follow: second.text, bothFromSameOrder: first.workOrderId === order.id && second.workOrderId === order.id })
      assert.equal(first.workOrderId, order.id)
      assert.equal(second.workOrderId, order.id)
    }
  }

  if (enabled.has('restart')) {
    await host.stop()
    await host.start()
    await login(password)
    await host.api('/chat' + q(), privateBody)
    assert.equal((await chat()).messages.filter(row => row.requestId === privateBody.requestId).length, 1)
    await reopen({ sessionId }, privateRefs[1], material[1].bytes, true)
    if (groupPath) {
      assert.ok((await get(groupPath)).messages.some(row => row.inputAttachments?.some(ref => ref.id === groupSource[1].id)))
      await reopen(groupTarget, groupSource[1], material[1].bytes)
    }
    sayResult('restart', { deduplicated: true, sourcesStillReadable: true })
  }
  if (enabled.has('rollback')) {
    const previous = process.env.CHIEF_CHAT_MEDIA_ROLLBACK_PACKAGE
    assert.ok(previous, '回滚验收需要上一版打包产物')
    await host.stop()
    host.install(previous)
    await host.start()
    const projected = (await chat()).messages.find(row => row.role === 'you' && row.text === privateBody.text)
    assert.ok(projected && !projected.inputAttachments, '旧包按既有聊天字段读取原话')
    const legacy = { scope, sessionId, requestId: randomUUID(), text: '这是回滚后的纯文字验收。请只回复 ROLLBACK-OK。' }
    await host.api('/chat' + q(), legacy)
    const legacyReply = await until(async () => {
      const view = await chat()
      const at = view.messages.findIndex(row => row.role === 'you' && row.text === legacy.text)
      return at >= 0 && !view.busy && view.messages.slice(at + 1).find(row => row.role === 'liaison' && row.text.includes('ROLLBACK-OK'))
    }, '旧包纯文字问答', 180_000)
    await host.stop()
    host.install(process.env.CHIEF_ACCEPTANCE_PACKAGE)
    await host.start()
    await host.api('/chat' + q(), privateBody)
    await reopen({ sessionId }, privateRefs[1], material[1].bytes)
    assert.equal((await chat()).messages.filter(row => row.requestId === privateBody.requestId).length, 1)
    sayResult('rollback', { legacyReply: legacyReply.text, deduplicated: true, sourceStillReadable: true })
  }
  if (enabled.has('text-only')) {
    const textModel = process.env.CHIEF_CHAT_MEDIA_TEXT_MODEL ?? 'zhipu/glm-5.3-flash'
    await host.api('/settings' + q(), { liaisonModel: textModel })
    const ref = await upload({ sessionId }, figure)
    const body = chatBody('', [ref])
    const response = await host.api('/chat' + q(), body, { raw: true })
    assert.equal(response.status, 422, JSON.stringify(await response.clone().json()))
    assert.match((await response.json()).error, /不支持图片/)
    assert.ok(!(await chat()).messages.some(row => row.requestId === body.requestId))
    sayResult('text-only', { model: textModel, informativeRejection: true })
  }
} finally {
  try {
    if (process.env.CHIEF_CHAT_MEDIA_EVIDENCE) writeFileSync(process.env.CHIEF_CHAT_MEDIA_EVIDENCE, JSON.stringify(evidence, null, 2))
  } finally {
    try { await host.dispose() } finally {
      if (model.startsWith('openai-codex/')) rmSync(join(host.home, '.credentials.yaml'), { force: true })
      if (process.env.CHIEF_CHAT_MEDIA_KEEP === '1') console.log('保留隔离验收目录', host.work)
      else rmSync(host.work, { recursive: true, force: true })
    }
  }
}
