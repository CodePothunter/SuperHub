import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildExport, readGoalsDocument } from '../src/core/export.ts'
import {
  isProfileImportDetail, isProfileImportList, isProfileImportReceipt, isProfileItemReceipt, PROFILE_IMPORT_ROOT,
  type ProfileImportDetail, type ProfileImportList, type ProfileImportReceipt, type ProfileItemReceipt,
} from '../src/core/profile-import.ts'
import { createProfileImportService, llmProfileOrganizer, type ProfileOrganizer } from '../src/dsh/assistant-import.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { serveApi } from '../src/dsh/http.ts'
import type { Llm } from '../src/dsh/ports.ts'
import { SuperhubGoals } from '../src/dsh/superhub-goals.ts'
import { readBrainFile } from '../src/dsh/view.ts'

const cleanups: (() => void)[] = []
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean() })
const scope = 'owner-brain'
function fixture(organize: ProfileOrganizer, committed?: (message: string, paths: string[]) => void) {
  const root = mkdtempSync(join(tmpdir(), 'chief-profile-'))
  cleanups.push(() => rmSync(root, {recursive: true, force: true}))
  let goals = new SuperhubGoals(root, () => {})
  let service = createProfileImportService({root, scope, organize, goals, committed})
  cleanups.push(() => service.dispose())
  const restart = (changed = organize) => {
    service.dispose()
    goals = new SuperhubGoals(root, () => {})
    service = createProfileImportService({root, scope, organize: changed, goals, committed})
  }
  async function call<T>(path = '', body?: Record<string, unknown>, opts?: {scope?: string; owner?: boolean; marker?: boolean; desktop?: boolean}) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method: body ? 'POST' : 'GET', url: '/chief/api' + PROFILE_IMPORT_ROOT + path + '?scope=' + (opts?.scope ?? scope),
      headers: opts?.marker === false ? {} : {'x-chief-request': '1'},
    }) as unknown as IncomingMessage
    let status = 0
    let data!: T
    const response = {writeHead(code: number) { status = code }, end(value: string) { data = JSON.parse(value) }} as unknown as ServerResponse
    await serveApi(req, response, opts?.desktop ? 'dsh' : 'public', [service.route], opts?.owner ?? true)
    return {status, data}
  }
  async function submit(text: string, id = 'submit') {
    const result = await call<ProfileImportReceipt>('', {text, source: 'Claude', requestId: id}, {desktop: true})
    expect(result.status).toBe(200)
    expect(isProfileImportReceipt(result.data)).toBe(true)
    return result.data
  }
  async function detail(id: string) {
    const result = await call<ProfileImportDetail>('/' + id)
    expect(result.status).toBe(200)
    expect(isProfileImportDetail(result.data)).toBe(true)
    return result.data.record
  }
  const getReady = (id: string) => vi.waitFor(async () => {
    const row = await detail(id)
    expect(row.status).toBe('review')
    return row
  })
  return {root, goals: () => goals, restart, submit, call, detail, getReady}
}

const rec = (quote: string, text = quote, category = 'preferences', extra: object = {}) => ({quote, text, category, ...extra})
const decide = (id: string, itemId: string) => '/' + id + '/items/' + itemId

describe('其他助手的个人资料导入', () => {
  it('先把原文保存在本脑私有目录，待复核时保留真实来源与机密标记', async () => {
    let finish!: (value: unknown) => void
    const organizer = vi.fn<ProfileOrganizer>(() => new Promise(resolve => { finish = resolve }))
    const t = fixture(organizer)
    const original = '- 我习惯上午写作 [记忆]\r\n- 我可能更喜欢下午开会 [推断]\r\n- 我负责内部项目\r\n  尚未发布 [对话 2026-11][机密]\r\n'
    const first = await t.submit(original)
    const list = await t.call<ProfileImportList>()
    expect(isProfileImportList(list.data)).toBe(true)
    expect(list.data.imports).toEqual([expect.objectContaining({id: first.importId, status: 'organizing', pending: 0})])
    expect(list.data.imports[0]).not.toHaveProperty('text')
    expect(await t.detail(first.importId)).toMatchObject({text: original, items: []})
    expect(await t.submit(original)).toEqual(first)
    expect(organizer).toHaveBeenCalledTimes(1)
    expect((await t.call('', {text: original, source: 'ChatGPT', requestId: 'submit'})).status).toBe(409)
    expect((await t.call('/' + first.importId, undefined, {owner: false})).status).toBe(403)
    expect((await t.call('/' + first.importId, undefined, {scope: 'other-brain'})).status).toBe(409)
    expect((await t.call('', {text: original, source: 'Claude', requestId: 'no-marker'}, {marker: false})).status).toBe(403)

    finish({items: [
      rec('我习惯上午写作'), rec('我可能更喜欢下午开会'), rec('我负责内部项目', '我负责内部项目', 'stage'),
      rec('原文中根本没有这句话'), rec('我习惯上午写作', '与小赵共事', 'person', {subject: '小赵'}),
    ]})
    const ready = await t.getReady(first.importId)
    expect(ready.items).toEqual([
      expect.objectContaining({sourceType: 'memory', quote: '我习惯上午写作', confidential: false}),
      expect.objectContaining({sourceType: 'inference', quote: '我可能更喜欢下午开会'}),
      expect.objectContaining({sourceType: 'conversation', quote: '我负责内部项目', confidential: true}),
      expect.objectContaining({sourceType: 'unknown', quote: '', text: '', confidential: true}),
      expect.objectContaining({category: 'person', targets: []}),
    ])
    expect(existsSync(join(t.root, 'me.md'))).toBe(false)
    expect(existsSync(join(t.root, 'inbox'))).toBe(false)
    expect(existsSync(join(t.root, 'ops', 'tickets'))).toBe(false)
    expect(existsSync(join(t.root, 'ops', 'superhub-v2'))).toBe(false)
    const path = join(t.root, 'ops', 'profile-imports')
    expect(readdirSync(path)).toHaveLength(1)
    expect(statSync(path).mode & 0o777).toBe(0o700)
    expect(statSync(join(path, readdirSync(path)[0]!)).mode & 0o777).toBe(0o600)
    t.restart()
    expect(await t.submit(original, 're-paste-after-lost-response')).toMatchObject({importId:first.importId,status:'review'})
    expect((await t.call<ProfileImportList>()).data.imports).toHaveLength(1)
    expect(organizer).toHaveBeenCalledTimes(1)
  })

  it('按所选档案处理冲突、去重和更正，保留其他字节及整条机密', async () => {
    const firstText = '# 关于我\r\n\r\n## 偏好\r\n- 我下午写作 [机密]\r\n\r\n## 其他\r\n- 这是用户原有内容\r\n'
    const firstAgents = '# 宪法\n\n## 原则\n- 旧约定\n\n## 隐私边界\n- 用户自己控制分享\n'
    const original = '我上午写作 [对话]\n\n重要决定需要假设 [记忆]\n\n我可能讨厌长文 [推断]\n\n我想学水彩 [记忆]\n\n与陈晨一起做过周报 [记忆]'
    const t = fixture(async () => ({items: [
      rec('我上午写作'), rec('重要决定需要假设', '重要决定列出假设', 'principles'), rec('我可能讨厌长文'),
      rec('我想学水彩', '学水彩', 'goal'), rec('与陈晨一起做过周报', '一起做过周报', 'person', {subject: '陈晨'}),
    ]}))
    writeFileSync(join(t.root, 'me.md'), firstText)
    writeFileSync(join(t.root, 'AGENTS.md'), firstAgents)
    writeFileSync(join(t.root, 'goals.md'), '## 学习\n- [ ] 学水彩\n')
    mkdirSync(join(t.root, 'people'))
    const person = (organization: string) => '---\nname: 陈晨\norganization: ' + organization + '\n---\n\n## 画像\n保持原样。\n\n## 事实\n- 原有资料\n'
    writeFileSync(join(t.root, 'people', 'person-a.md'), person('甲'))
    writeFileSync(join(t.root, 'people', 'person-b.md'), person('乙'))
    const receipt = await t.submit(original)
    const {importId} = receipt
    const review = await t.getReady(importId)
    const [pref, principle, inference, goal, relation] = review.items
    const destination = pref!.targets.find(target => target.current === '我下午写作 [机密]' && target.id !== 'new')!
    const choice = {expectedVersion: 1, action: 'save', text: '我上午写作\n## 文字里的标题 <!--', targetId: destination.id,
      expectedTargetVersion: destination.version, requestId: 'save-pref'}
    const saved = await t.call<ProfileItemReceipt>(decide(importId, pref!.id), choice)
    expect(saved.status).toBe(200)
    expect(isProfileItemReceipt(saved.data)).toBe(true)
    expect(saved.data.saved?.text).toBe('我上午写作 ## 文字里的标题 <!-- [机密]')
    expect(readFileSync(join(t.root, 'me.md'), 'utf8')).toBe(firstText.replace('我下午写作', '我上午写作 ## 文字里的标题 &lt;!--'))
    expect(await t.call(decide(importId, pref!.id), choice)).toEqual(saved)
    expect((await t.call(decide(importId, pref!.id), {...choice, text: '换内容'})).status).toBe(409)
    expect((await t.call(decide(importId, pref!.id), {...choice, requestId: 'stale-item'})).status).toBe(409)

    const correction = (await t.detail(importId)).items[0]!
    const selected = correction.targets[0]!
    expect(selected.current).toBe(saved.data.saved?.text)
    const updated = await t.call<ProfileItemReceipt>(decide(importId, pref!.id), {...choice, requestId: 'correct-pref',
      expectedVersion: correction.version, targetId: selected.id, expectedTargetVersion: selected.version, text: '我改在傍晚写作'})
    expect(updated.data.saved?.text).toBe('我改在傍晚写作 [机密]')

    const addPrinciple = principle!.targets[0]!
    const principleResult = await t.call(decide(importId, principle!.id), {action: 'save', expectedVersion: 1,
      targetId: addPrinciple.id, expectedTargetVersion: addPrinciple.version, text: principle!.text, requestId: 'save-principle'})
    expect(principleResult.status).toBe(200)
    expect(readFileSync(join(t.root, 'AGENTS.md'), 'utf8')).toBe(firstAgents.replace('## 隐私边界', '- 重要决定列出假设\n\n## 隐私边界'))
    const skipped = await t.call(decide(importId, inference!.id), {action: 'skip', expectedVersion: 1, requestId: 'skip'})
    expect(skipped.data).toMatchObject({status: 'skipped'})

    const goalTarget = goal!.targets.find(target => target.match)!
    expect(goalTarget.id).toMatch(/^candidate-/)
    const goalResult = await t.call(decide(importId, goal!.id), {action: 'save', text: goal!.text, targetId: goalTarget.id,
      expectedVersion: 1, expectedTargetVersion: goalTarget.version, requestId: 'save-goal'})
    expect(goalResult.status).toBe(200)
    expect(t.goals().list()).toMatchObject([{source: {kind: 'markdown', text: '学水彩'}, versions: [{name: '学水彩'}]}])
    const personTarget = relation!.targets.find(target => target.id === 'person-person-b')!
    expect(relation!.targets.map(target => target.label).join('\n')).toContain('陈晨 · 甲（person-a）')
    const relationResult = await t.call(decide(importId, relation!.id), {action: 'save', text: relation!.text, targetId: personTarget.id,
      expectedVersion: 1, expectedTargetVersion: personTarget.version, requestId: 'save-person'})
    expect(relationResult.status).toBe(200)
    expect(readFileSync(join(t.root, 'people', 'person-a.md'), 'utf8')).toBe(person('甲'))
    expect(readFileSync(join(t.root, 'people', 'person-b.md'), 'utf8')).toBe(person('乙') + '\n- 一起做过周报\n')
    expect((await t.detail(importId)).status).toBe('processed')
    const report = buildExport('session', {me: readFileSync(join(t.root, 'me.md'), 'utf8'),
      agents: readFileSync(join(t.root, 'AGENTS.md'), 'utf8'), goals: readGoalsDocument(t.root)}, '2026-11-23').parts[0]!.text
    expect(report).toContain('重要决定列出假设')
    expect(report.match(/学水彩/g)).toHaveLength(1)
    for (const privateText of ['上午写作', '傍晚写作', '可能讨厌长文', '一起做过周报']) expect(report).not.toContain(privateText)
  })

  it('对同一目标版本的第二次写入要求重新核对，并按已写事实恢复中断的回执', async () => {
    let interrupted = true
    const t = fixture(async () => ({items: [rec('我上午写作'), rec('我常用终端')]}), () => {
      if (interrupted) { interrupted = false; throw new Error('写入后中断') }
    })
    const {importId} = await t.submit('我上午写作 [记忆]\n\n我常用终端 [记忆]')
    const [first, second] = (await t.getReady(importId)).items
    const command = {action: 'save', text: first!.text, targetId: 'new', expectedVersion: 1, expectedTargetVersion: 0, requestId: 'first'}
    expect((await t.call(decide(importId, first!.id), command)).status).toBe(503)
    expect(readFileSync(join(t.root, 'me.md'), 'utf8')).toContain('我上午写作')
    t.restart()
    expect((await t.call(decide(importId, first!.id), command)).data).toMatchObject({status: 'saved', version: 2})
    expect(readFileSync(join(t.root, 'me.md'), 'utf8').match(/我上午写作/g)).toHaveLength(1)
    const stale = {action: 'save', text: second!.text, targetId: 'new', expectedVersion: 1, expectedTargetVersion: 0, requestId: 'second'}
    expect((await t.call(decide(importId, second!.id), stale)).status).toBe(409)
    const current = (await t.detail(importId)).items[1]!.targets.find(target => target.id === 'new')!
    expect((await t.call(decide(importId, second!.id), {...stale, expectedTargetVersion: current.version})).status).toBe(200)
    expect(readFileSync(join(t.root, 'me.md'), 'utf8')).toContain('我常用终端')
  })

  it('将重复的机密建议标为已有资料，不能用新增在档案里留下另一条可导出的版本', async () => {
    const t = fixture(async () => ({items: [rec('我使用内部评审工具')]}))
    const path = join(t.root, 'me.md')
    writeFileSync(path, '## 偏好\n- 我使用内部评审工具\n')
    const {importId} = await t.submit('我使用内部评审工具 [机密] [记忆]')
    const item = (await t.getReady(importId)).items[0]!
    const newTarget = item.targets[0]!
    const duplicate = {action: 'save', text: item.text, targetId: newTarget.id,
      expectedVersion: 1, expectedTargetVersion: newTarget.version, requestId: 'duplicate'}
    expect((await t.call(decide(importId, item.id), duplicate)).status).toBe(409)
    const existing = item.targets[1]!
    expect((await t.call(decide(importId, item.id), {...duplicate, targetId: existing.id})).status).toBe(200)
    const sameImport = await t.submit('我使用内部评审工具 [机密] [对话]', 'same-fact')
    expect(sameImport.importId).not.toBe(importId)
    const later = (await t.getReady(sameImport.importId)).items[0]!
    expect(later.targets[1]?.match).toBe(true)
    const original = readFileSync(path, 'utf8')
    expect(original).toBe('## 偏好\n- 我使用内部评审工具 [机密]\n')
    const result = await t.call(decide(sameImport.importId, later.id), {action: 'save', text: later.text, expectedVersion: 1,
      targetId: later.targets[1]!.id, expectedTargetVersion: later.targets[1]!.version, requestId: 'same-confirm'})
    expect(result.status).toBe(200)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('恢复中断的整理并拒绝迟到回调和越界文件', async () => {
    let finish!: (value: unknown) => void
    const t = fixture(() => new Promise(resolve => { finish = resolve }))
    const {importId} = await t.submit('我上午写作 [记忆]')
    t.restart(async () => ({items: [rec('我上午写作')]}))
    finish({items: [rec('直接代替主人改资料')]})
    expect((await t.detail(importId)).status).toBe('failed')
    const result = await t.call('/' + importId + '/retry', {requestId: 'recover'})
    expect(result.data).toMatchObject({importId, status: 'organizing'})
    expect((await t.getReady(importId)).items.map(item => item.text)).toEqual(['我上午写作'])
    expect(await t.call('/' + importId + '/retry', {requestId: 'recover'})).toEqual(result)

    const other = mkdtempSync(join(tmpdir(), 'chief-profile-other-'))
    cleanups.push(() => rmSync(other, {recursive: true, force: true}))
    const outside = join(other, 'me.md')
    writeFileSync(outside, '其他脑的资料')
    symlinkSync(outside, join(t.root, 'me.md'))
    expect((await t.call('/' + importId)).status).toBe(503)
    expect(readFileSync(outside, 'utf8')).toBe('其他脑的资料')
  })

  it('整理模型只收到原始回答，使用结构化答复并且没有工具和用户档案', async () => {
    const stream = vi.fn<Llm['stream'] & object>(async function* () {
      yield {type: 'text-delta', text: '{"items":[]}'}
    })
    const organize = llmProfileOrganizer(() => ({stream} as unknown as Llm), () => ({provider: 'test', model: 'test'}))
    const reply = '不知道'
    expect(await organize(reply, new AbortController().signal)).toEqual({items: []})
    expect(stream.mock.calls[0]?.[0]).toMatchObject({
      tools: [], messages: [{role: 'user', content: [{type: 'text', text: JSON.stringify({助手原始回答: reply})}]}],
    })
  })

  it('旧脑的自动 Git 提交和普通文件读取都排除原始回答与未确认资料', async () => {
    const t = fixture(async () => ({items: []}))
    const git = (...args: string[]) => execFileSync('git', args, {cwd: t.root, encoding: 'utf8'})
    git('init', '-q')
    git('config', 'user.name', 'test')
    git('config', 'user.email', 'test@example.invalid')
    const brain = new BrainRepo(t.root)
    await t.submit('没有记录')
    const directory = join('ops', 'profile-imports')
    const stored = join(directory, readdirSync(join(t.root, directory))[0]!)
    symlinkSync(join(t.root, stored), join(t.root, 'alias.md'))
    expect(readBrainFile(brain, stored)).toBeUndefined()
    expect(readBrainFile(brain, 'alias.md')).toBeUndefined()
    writeFileSync(join(t.root, 'ops/other-state.json'), '{}')
    writeFileSync(join(t.root, 'me.md'), '# 关于我\n\n## 偏好\n- 本人已确认的内容\n')
    brain.commit('保存确认资料', {paths: ['me.md']})
    await brain.flush()
    expect(git('ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n')).toEqual(['me.md', 'ops/other-state.json'])
  })
})
