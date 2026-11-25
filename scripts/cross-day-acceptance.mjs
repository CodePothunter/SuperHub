/** T10 against the real liaison model after native rotation and an isolated day change. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { acceptanceHost, until } from './acceptance-host.mjs'

const clockDir = mkdtempSync(join(tmpdir(), 'chief-acceptance-clock-'))
const day = join(clockDir, 'shift.txt'), preload = join(clockDir, 'clock.mjs')
writeFileSync(day, '-86400000')
writeFileSync(preload, `import { readFileSync } from 'node:fs'
const Original = Date, shift = Number(readFileSync(${JSON.stringify(day)}, 'utf8'))
globalThis.Date = new Proxy(Original, {
  construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [Original.now() + shift], newTarget) },
  apply() { return new Original(Original.now() + shift).toString() },
  get(target, field, receiver) { return field === 'now' ? () => Original.now() + shift : Reflect.get(target, field, receiver) },
})
`)
const host = await acceptanceHost({ model: 'deepseek-official/deepseek-flash', probe: 'acceptance-surface-probe.mjs',
  extraEnv: { NODE_OPTIONS: `--import=${preload}`, CHIEF_ACCEPTANCE_REAL_MODEL: '1', CHIEF_LIAISON_ROTATE_AT: '1' } })
console.log('T10 isolated host', host.work)
const evidence = { work: host.work, model: 'deepseek-official/deepseek-flash', checks: [] }
const dest = resolve(process.env.CHIEF_CROSS_DAY_EVIDENCE ?? 'artifacts/acceptance/cross-day-20261118.json')
const save = () => { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, JSON.stringify(evidence, null, 2) + '\n') }
const bindings = () => JSON.parse(readFileSync(host.settingsFile, 'utf8')).liaison
const probe = (room, fields) => host.request('/chief-acceptance-surface', { session: room.session, ...fields })
const view = room => host.api('/rooms/' + room.id)
const yesterday = Date.now() - 86400000
let stage = 'warmup'
async function chat(text) {
  const before = await host.api('/chat')
  await host.api('/chat', { text, sessionId: before.sessionId })
  return until(async () => {
    const after = await host.api('/chat')
    const answer = after.messages.filter(m => m.role === 'liaison' && !before.messages.some(old => old.seq === m.seq && old.text === m.text)).at(-1)
    return !after.busy && answer ? answer : undefined
  }, stage, 135_000)
}
async function seed(room, text, id) {
  await probe(room, { action: 'seed', text })
  const source = (await view(room)).messages.findLast(m => m.text === text)
  assert.ok(source)
  const patched = await host.api(`/rooms/${room.id}/notes`, { session: room.session, id, text, source: source.id, category: 'verified' })
  return { source: source.id, at: patched.notes.at(-1).at }
}
async function readOnlyState(rooms) {
  const [inbox, chat, ...views] = await Promise.all([host.api('/state'), host.api('/chat'), ...rooms.map(view)])
  return { events: inbox.events?.length ?? inbox.recent?.length ?? 0,
    tickets: ['you', 'active', 'queued', 'ended'].flatMap(key => inbox[key] ?? []).map(t => t.id),
    sources: views.map(row => row.messages.map(m => m.id)), notices: chat.notices.filter(n => !n.key.startsWith('morning:')).map(n => n.key) }
}
try {
  // A clock-triggered morning brief is independent of the read-only query.
  writeFileSync(join(host.brain, 'rules.yaml'), '[]\n')
  await host.start(); await host.api('/pause', { paused: true })
  const first = await host.api('/rooms', { request_id: 'versions', title: '发布联调' })
  const second = await host.api('/rooms', { request_id: 'wake', title: '发布联调' })
  await seed(first, '版本分支，只比较 4.2 与 4.3 的文件列表。', 'versions')
  const wake = await seed(second, '唤醒分支，冷重启后原生唤醒已核实为 WAKE-042，尚未核实断网重连。', 'wake')
  assert.ok(Math.abs(Date.parse(wake.at) - yesterday) < 180000)
  const start = (await host.api('/chat')).sessionId
  await chat('这是隔离验收的起始回合，只回复“已就绪”。')
  const rotated = await until(() => bindings()?.parts?.length > 0 && bindings(), '接口人换段')
  await host.stop()
  writeFileSync(day, '0')
  await host.start(); await host.api('/pause', { paused: true })
  const referenceBefore = await readOnlyState([first, second])
  stage = '独一匹配'
  const answer = await chat('昨天那个唤醒问题，后来怎么样了？')
  const referenceAfter = await readOnlyState([first, second])
  const linked = answer.discussions?.some(r => r.id === second.id) || answer.text.includes('#room=' + second.id)
  evidence.checks.push({ stage, start, rotated, wake, answer: answer.text, linked, correct: /WAKE-042/.test(answer.text) && /断网重连/.test(answer.text),
    before: referenceBefore, after: referenceAfter,
    noBackgroundChanges: JSON.stringify(referenceBefore) === JSON.stringify(referenceAfter) })
  save()
  const alternate = await seed(first, '另一项唤醒结果，热重启验证标记 WAKE-137，跨进程尚待测。', 'second-wake')
  evidence.alternate = alternate
  const before = await readOnlyState([first, second])
  stage = '同名且均匹配'
  const ambiguous = await chat('那个唤醒问题，后来怎么样了？我还没指定具体是哪间讨论，请把可选讨论区分开。')
  evidence.checks.push({ stage, answer: ambiguous.text, tools: ambiguous.did, references: ambiguous.discussions ?? [],
    both: /WAKE-042|冷重启|断网重连/.test(ambiguous.text) && /WAKE-137|热重启|跨进程/.test(ambiguous.text),
    noBackgroundChanges: JSON.stringify(before) === JSON.stringify(await readOnlyState([first, second])) })
  evidence.completed = true
  evidence.passed = evidence.checks[0].linked && evidence.checks[0].correct && evidence.checks[0].noBackgroundChanges &&
    evidence.checks[1].both && evidence.checks[1].noBackgroundChanges
  save(); console.log('T10', evidence.passed ? 'PASS' : 'FAIL')
  if (!evidence.passed) process.exitCode = 1
} catch (error) { evidence.error = String(error); save(); throw error }
finally { await host.stop() }
