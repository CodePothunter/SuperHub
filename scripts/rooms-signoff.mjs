/** T01/T11 signoff: actual DSH + actual configured model, in a disposable brain. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'

const only = process.env.CHIEF_SIGNOFF_ONLY
if (only && !['T01', 'T11'].includes(only)) throw Error('CHIEF_SIGNOFF_ONLY must be T01 or T11')
const pkg = process.env.CHIEF_ACCEPTANCE_PACKAGE
assert.ok(pkg, 'must explicitly select the isolated candidate package')
const work = mkdtempSync(join(tmpdir(), 'chief-signoff-')), home = join(work, 'home'), brain = join(work, 'brain')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }; delete env.CHIEF_NOTIFY_URL
const evidence = { host: 'DSH 0.2.2-rc.1', model: 'zhipu/glm-5.3', executor: 'native spawn', modelReplacement: false, work, candidate: createHash('sha256').update(readFileSync(pkg)).digest('hex'), cases: [] }
const evidenceFile = `artifacts/acceptance/rooms-signoff${only ? '-' + only : ''}.json`
const save = () => { mkdirSync('artifacts/acceptance', { recursive: true }); writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const port = await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
let child, cookie, base, relay
async function request(path, body) {
  const response = await fetch(base + path, { headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-chief-request': '1' }) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  const value = await response.json()
  if (!response.ok) throw Object.assign(Error(`${path}: ${response.status} ${value.error}`), { status: response.status })
  return value
}
const api = (path, body) => request('/chief/api' + path, body)
const inspect = session => request('/chief-signoff-audit', { session, action: 'inspect' })
async function start() {
  let log = ''; base = `http://127.0.0.1:${port}`
  child = spawn('dsh', ['web', '--no-open', '--port', String(port)], { cwd: work, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', part => { log += part })
  let token
  for (let n = 0; n < 120; n++) { token = [...log.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]; if (token) break; if (child.exitCode !== null) throw Error('isolated host exited'); await sleep(300) }
  assert.ok(token)
  const response = await fetch(base + '/?token=' + token, { redirect: 'manual' })
  cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  for (let n = 0; n < 60; n++) { try { await api('/state'); return } catch { await sleep(300) } }
  throw Error('candidate not ready')
}
async function stop() {
  if (child?.exitCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve)); process.kill(-child.pid, 'SIGTERM')
    await Promise.race([ended, sleep(8000)]); if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL')
    await sleep(300)
  }
}
async function settled(id, until = () => true) {
  for (let n = 0; n < 150; n++) {
    const view = await api('/rooms/' + id)
    if (view.members.every(m => !['running', 'provisioning'].includes(m.status)) && until(view)) return view
    if (n % 15 === 0) console.log('Waiting:', id, view.members.map(m => `${m.name}:${m.status}`).join(','))
    await sleep(2000)
  }
  const last = await api('/rooms/' + id);evidence.incomplete = { id, view: last };save();throw Error('real model did not reach the required state: ' + id)
}
async function turn(room, id, text, to = 'lead') {
  const before = (await api('/rooms/' + room.id)).messages.map(m => m.id)
  await api('/rooms/' + room.id, { session: room.session, request_id: id, text, to })
  return settled(room.id, view => view.messages.some(m => m.author === to && m.kind === 'status' && !before.includes(m.id)))
}
const answer = view => view.messages.filter(m => m.author === 'lead' && m.kind === 'status').at(-1)
async function run(id, fn) {
  if (only && id !== only) return
  try { const detail = await fn(); evidence.cases.push({ id, result: '通过', detail }); console.log('PASS', id) }
  catch (error) { evidence.cases.push({ id, result: '失败', error: String(error) }); console.log('FAIL', id, String(error)); process.exitCode = 1 }
  save()
}
try {
  console.log('Protected isolated host:', work)
  execFileSync('dsh', ['plugin', '--profile', 'web', 'add', pkg], { env, stdio: 'pipe', timeout: 300000 })
  const original = readFileSync(join(homedir(), 'workspace/dsh/home/profiles/web/cordis.patch.yml'), 'utf8')
  const providers = original.slice(original.indexOf('- id: llm-pi-ai'), original.indexOf('- id: agent-default-model'))
  assert.ok(providers.includes('zhipu'), 'existing protected provider configuration')
  writeFileSync(join(home, 'profiles/web/cordis.patch.yml'), providers + '\n- id: agent-default-model\n  config:\n    provider: zhipu\n    model: glm-5.3\n', { mode: 0o600 })
  const probe = join(work, 'audit'); mkdirSync(probe)
  writeFileSync(join(probe, 'package.json'), JSON.stringify({ name: 'chief-signoff-audit', version: '1.0.0', type: 'module', main: 'index.mjs', dsh: { manifestVersion: 1, bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(probe, 'cordis.patch.yml'), '- insert:\n    - id: chief-signoff-audit\n      name: chief-signoff-audit\n')
  copyFileSync('scripts/signoff-audit-probe.mjs', join(probe, 'index.mjs'))
  execFileSync('dsh', ['plugin', '--profile', 'web', 'add', probe], { env, stdio: 'pipe', timeout: 60000 })
  execFileSync('node', ['--experimental-transform-types', '--input-type=module', '-e', `import {scaffoldBrain} from './src/dsh/scaffold.ts';scaffoldBrain(${JSON.stringify(brain)})`], { stdio: 'pipe' })
  mkdirSync(join(home, 'chief'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'chief/config.json'), JSON.stringify({ brain, timeZone: 'Asia/Shanghai', concurrency: 2, liaisonModel: 'zhipu/glm-5.3', mobile: { enabled: false, port: 50388, host: '127.0.0.1' } }), { mode: 0o600 })
  await start(); await api('/pause', { paused: true })
  await run('T01', async () => {
    relay = await api('/rooms', { request_id: 'signoff-relay', title: '签收：三方原话与引用' })
    const provisioning = await request('/chief-signoff-audit', { session: relay.session, action: 'prepare-team' })
    await settled(relay.id)
    await api('/rooms/' + relay.id, { session: relay.session, request_id: 'relay-start', text: '隔离验收，只用原生团队。engineer、researcher 已由宿主通过原生团队创建。现在你必须只用一次 send_message 向 researcher 发出“请核对17+25”；不要用普通文字代替这条具名派工消息。等研究员的真实结果后只说“签收接力完成：42”。不访问外部资源，不创建工单，不反复发送消息。' })
    const view = await settled(relay.id, v => v.messages.some(m => m.author === 'lead' && m.text.includes('签收接力完成')) && v.messages.some(m => m.author === 'engineer' && m.to === 'researcher' && m.replyTo))
    const dispatch = view.messages.find(m => m.author === 'lead' && m.to === 'researcher')
    const question = view.messages.find(m => m.author === 'researcher' && m.to === 'engineer')
    const reply = view.messages.find(m => m.author === 'engineer' && m.to === 'researcher' && m.replyTo)
    assert.ok(dispatch && question && reply); assert.equal(reply.replyTo, question.id); assert.match(reply.text, /42/)
    const native = await inspect(relay.session)
    for (const message of [dispatch, question, reply]) {
      const member = native.members.find(m => m.id === message.session), event = member.events.find(e => e.seq === message.seq)
      const sources = event.type === 'agent/inbox/spliced' ? event.data.inserted : [event.data]
      assert.ok(sources.some(m => m.source?.kind === 'agent-message' && native.members.find(n => n.id === m.source.senderSessionId)?.name === message.author))
    }
    const forged = await request('/chief-signoff-audit', { session: relay.session, action: 'fake-author', target: 'engineer' })
    assert.equal(forged.accepted, false); assert.ok(forged.code)
    const plain = await api('/rooms', { request_id: 'plain-text', title: '文本声明不代表派工' })
    const declared = await turn(plain, 'declare', '只做文本渲染验收，不执行任何工具：逐字输出“已交给工程师”。不要实际交办、创建成员或调用工具。')
    assert.equal(declared.members.length, 1); assert.ok(declared.messages.some(m => m.author === 'lead' && m.kind === 'status' && m.text.includes('已交给工程师')))
    assert.ok(!declared.messages.some(m => m.author === 'engineer'))
    const screenshots = []
    assert.ok(process.env.CHIEF_PLAYWRIGHT_PATH, 'T01 requires both browser viewports')
    const { chromium } = await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
    const browser = await chromium.launch({ headless: true, ...(process.env.CHIEF_CHROMIUM_PATH ? { executablePath: process.env.CHIEF_CHROMIUM_PATH } : {}) })
    try {
      for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
        const page = await browser.newPage({ viewport: { width, height } })
        await page.context().addCookies(cookie.split('; ').map(item => ({ name: item.split('=')[0], value: item.slice(item.indexOf('=') + 1), url: base })))
        await page.goto(base + '/#room=' + relay.id)
        const welcome = page.getByRole('button', { name: 'Continue', exact: true }); await welcome.waitFor({ timeout: 4000 }).then(() => welcome.click()).catch(() => {})
        await page.getByRole('heading', { name: relay.title }).waitFor({ timeout: 20000 })
        for (const message of [dispatch, question, reply]) assert.equal(await page.locator(`[id="source-${message.id}"]`).getAttribute('data-author'), message.author)
        await page.locator(`[id="source-${reply.id}"]`).getByRole('button', { name: /回看引用原话/ }).click()
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'source-' + question.id)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        const path = `screenshots/signoff-relay-${label}.png`; mkdirSync('screenshots', { recursive: true }); await page.screenshot({ path }); screenshots.push(path); await page.close()
      }
    } finally { await browser.close() }
    return { room: relay.id, provisioning, members: view.members, dispatch, question, reply, forged, declared: declared.messages, screenshots }
  })
  await run('T11', async () => {
    const room = await api('/rooms', { request_id: 'signoff-notes', title: '签收：本次约定与纠错' })
    const hash = () => createHash('sha256').update(readFileSync(join(brain, 'AGENTS.md'))).digest('hex')
    const originalHash = hash()
    let view = await turn(room, 'scope-input', '本次只看派工。这是本次讨论范围，不能视为长期偏好。先简短确认，不要写笔记或派活。')
    const source = view.messages.find(m => m.author === 'you' && m.text.startsWith('本次只看派工'))
    await api('/rooms/' + room.id + '/notes', { session: room.session, id: 'scope', source: source.id, text: '本次只看派工', category: 'agreement' })
    view = await turn(room, 'scribe-inference', '书记官推测“主人永远只看派工”。这条仅为未确认推测，请用 chief_room_note save 记为待核实并引用刚才的主人原话。不要修改本次约定，也不要写长期原则。')
    assert.ok(view.notes.some(n => n.category === 'pending' && n.by === 'lead' && n.text.includes('永远')))
    assert.equal(hash(), originalHash)
    view = await turn(room, 'owner-correction', '主人纠正：本次还需要验证唤醒；“永远只看派工”的推测没有成立。只确认收到，等我修正笔记。')
    const correctedSource = view.messages.find(m => m.author === 'you' && m.text.startsWith('主人纠正：'))
    await api('/rooms/' + room.id + '/notes', { session: room.session, id: 'scope', version: 1, source: correctedSource.id, text: '本次同时验证派工与唤醒', reason: '主人明确扩大本次范围，否定长期推测', category: 'agreement' })
    const corrected = await turn(room, 'read-correction', '请调用 chief_room_note read，回答当前本次约定的原文、修订号及来源。区分未确认的长期推测，不开展新的调研。')
    assert.match(answer(corrected).text, /派工.*唤醒/s); assert.match(answer(corrected).text, /2/)
    await assert.rejects(api('/rooms/' + room.id + '/restore-note', { session: room.session, id: 'scope', version: 1, target_version: 1 }), e => e.status === 400)
    const restored = await api('/rooms/' + room.id + '/restore-note', { session: room.session, id: 'scope', version: 2, target_version: 1 })
    assert.deepEqual(restored.notes.filter(n => n.id === 'scope').map(n => [n.version, n.by]), [[1, 'you'], [2, 'you'], [3, 'you']])
    for (let n = 0; n < 2; n++) { await stop(); await start() }
    const reread = await turn(room, 'read-restored', '重新启动后，请调用 chief_room_note read，只报告当前本次约定的原文、修订号和来源；不要拿被撤销的版本当现行约定。')
    assert.match(answer(reread).text, /本次只看派工/); assert.match(answer(reread).text, /3/)
    const other = await api('/rooms', { request_id: 'unrelated-scope', title: '另一间讨论的范围' })
    const separate = await turn(other, 'unrelated-read', '请调用 chief_room_note read：本讨论是否已有任何约定？没有就明确说没有，不能借用其他讨论的范围。')
    assert.equal(separate.notes.length, 0); assert.ok(!answer(separate).text.includes('本次只看派工'))
    assert.equal(hash(), originalHash)
    const audit = readFileSync(join(home, 'signoff-model-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(audit.some(r => r.session === room.session && r.notes?.includes('本次同时验证派工与唤醒') && r.usage), 'real provider consumed corrected native system context')
    assert.ok(audit.some(r => r.session === room.session && r.notes?.includes('"version":3') && r.usage), 'native hydration consumed restored context')
    return { room: room.id, originalHash, finalHash: hash(), corrected: answer(corrected), restored: answer(reread), notes: reread.notes, unrelated: answer(separate), modelAudit: audit.filter(r => r.session === room.session) }
  })
  evidence.completed = true; save()
} catch (error) { evidence.error = String(error); save(); process.exitCode = 1; console.error(String(error)) }
finally { await stop(); console.log('Evidence:', evidenceFile) }
