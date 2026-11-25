import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrainRepo, parseFrontmatter } from '../src/dsh/brain.ts'
import { isStaffDescendant } from '../src/dsh/tools.ts'
import { briefCard, readBrainFile, toolCard, type WarroomState } from '../src/dsh/view.ts'

describe('工具调用方校验', () => {
  // 主人自己的根会话 mine、它派出的子代理 mine-sub；参谋长 chief-hq 派出 child → grandchild；orphan 的父会话不在线。
  const sessions: Record<string, { parent?: string; subagent: boolean }> = {
    'chief-hq': { subagent: false }, child: { parent: 'chief-hq', subagent: true }, grandchild: { parent: 'child', subagent: true },
    mine: { subagent: false }, 'mine-sub': { parent: 'mine', subagent: true }, orphan: { parent: 'gone', subagent: true },
  }
  const lookup = { info: (id: string) => sessions[id] }
  const exec = (id?: string) => ({ signal: new AbortController().signal, ...id ? { agent: { id } } : {} })
  it('参谋长派出的子代理（含多层）不能以主人身份操作', () => {
    expect(isStaffDescendant(exec('child'), 'chief-hq', lookup)).toBe(true)
    expect(isStaffDescendant(exec('grandchild'), 'chief-hq', lookup)).toBe(true)
  })
  it('主人的会话、主人会话派出的子代理、参谋长会话本身可以操作', () => {
    expect(isStaffDescendant(exec('mine'), 'chief-hq', lookup)).toBe(false)
    expect(isStaffDescendant(exec('mine-sub'), 'chief-hq', lookup)).toBe(false)
    expect(isStaffDescendant(exec('chief-hq'), 'chief-hq', lookup)).toBe(false)
  })
  it('拿不准就拒绝：无调用方、调用方查不到、祖先链断裂', () => {
    expect(isStaffDescendant(exec(), 'chief-hq', lookup)).toBe(true)
    expect(isStaffDescendant(exec('unknown'), 'chief-hq', lookup)).toBe(true)
    expect(isStaffDescendant(exec('orphan'), 'chief-hq', lookup)).toBe(true)
  })
})

describe('第二大脑', () => {
  const root = mkdtempSync(join(tmpdir(), 'brain-'))
  mkdirSync(join(root, 'staff'))
  writeFileSync(join(root, 'staff', 'eng.md'), '---\nname: 工程师\nexecutor: claude-code\nmodel: zhipu/glm-5.3\n---\n写代码。')
  writeFileSync(join(root, 'rules.yaml'), 'workspaces: [../code]\nrules:\n  - {id: a, when: daily 08:30, text: 早报}\n  - {id: b, when: daily 09:00, text: 关掉的, enabled: false}\n')
  const brain = new BrainRepo(root)
  it('读角色卡与工作区', () => {
    expect(brain.staff()).toEqual([{ id: 'eng', name: '工程师', executor: 'claude-code', model: 'zhipu/glm-5.3', verifier: 'reviewer', brief: '写代码。' }])
    expect(brain.workspaces()).toEqual([join(root, '..', 'code')])
  })
  it('笔记只能写进 journal/ 下的 .md', () => {
    expect(brain.appendNote('journal/2026-11-15.md', '想法一')).toBe('journal/2026-11-15.md')
    expect(readFileSync(join(root, 'journal/2026-11-15.md'), 'utf8')).toContain('想法一')
    expect(() => brain.appendNote('notes/x.md', '越权')).toThrow()
    expect(() => brain.appendNote('journal/../AGENTS.md', '越权')).toThrow()
    expect(() => brain.appendNote('/etc/passwd', '越权')).toThrow()
    expect(() => brain.appendNote('journal/x.sh', '越权')).toThrow()
  })
  it('读文件不能经符号链接越出第二大脑，也不能读工作电脑队列', () => {
    mkdirSync(join(root, 'work', 'T-0001'), { recursive: true })
    writeFileSync(join(root, 'work', 'T-0001', 'ok.md'), '产出')
    symlinkSync('/etc/hostname', join(root, 'work', 'T-0001', 'leak.md'))
    mkdirSync(join(root, 'ops', 'remote', 'inbox'), { recursive: true })
    writeFileSync(join(root, 'ops', 'remote', 'inbox', 'x.json'), '{}')
    expect(readBrainFile(brain, 'work/T-0001/ok.md')).toBe('产出')
    expect(readBrainFile(brain, 'work/T-0001/leak.md')).toBeUndefined()
    expect(readBrainFile(brain, 'ops/remote/inbox/x.json')).toBeUndefined()
    expect(readBrainFile(brain, '../../etc/hostname')).toBeUndefined()
  })
  it('工单目录只接受合法 id', () => {
    expect(() => brain.workdir('../x')).toThrow()
  })
  it('Windows 换行与 BOM 的角色卡仍能读取元数据与正文', () => {
    expect(parseFrontmatter('\uFEFF---\r\nname: 研究员\r\nexecutor: codex\r\n---\r\n调研。')).toEqual({ meta: { name: '研究员', executor: 'codex' }, body: '调研。' })
  })
  it('头部元数据缺失时整篇当正文', () => {
    expect(parseFrontmatter('只有正文')).toEqual({ meta: {}, body: '只有正文' })
  })
})

describe('简报卡片', () => {
  it('超过 8 KiB 时不出卡片，而不是让工具调用失败', () => {
    const big = { type: 'text', text: 'x'.repeat(9000) }
    expect(toolCard(() => big)).toEqual({})
    const state = { problems: [], you: [], active: [], queued: [], poc: { situation: { decide: 0, overdue: 0, dueToday: 0, blocked: 0, meetingsToday: 0, stale: 0 }, ledger: [] } } as unknown as WarroomState
    expect(toolCard(() => briefCard(state))).toHaveProperty('dsh-go/view')
  })
})

import { acquireLock } from '../src/dsh/lock.ts'
describe('单写者锁', () => {
  it('活着的其他进程持锁时拒绝；已退出进程的锁可接管', () => {
    const root = mkdtempSync(join(tmpdir(), 'lock-'))
    mkdirSync(join(root, 'ops'))
    writeFileSync(join(root, 'ops', '.chief.lock'), JSON.stringify({ pid: 1 })) // pid 1 一直活着
    expect(() => acquireLock(root)).toThrow(/已被进程 1/)
    writeFileSync(join(root, 'ops', '.chief.lock'), JSON.stringify({ pid: 2_147_000_000 })) // 不存在的进程
    const release = acquireLock(root)
    expect(JSON.parse(readFileSync(join(root, 'ops', '.chief.lock'), 'utf8')).pid).toBe(process.pid)
    // 热重载：同一进程的新实例接管，旧实例释放时不能删掉新实例的锁
    const releaseNext = acquireLock(root)
    release()
    expect(JSON.parse(readFileSync(join(root, 'ops', '.chief.lock'), 'utf8')).pid).toBe(process.pid)
    releaseNext()
    expect(() => readFileSync(join(root, 'ops', '.chief.lock'))).toThrow()
  })
})

import { chatFromEvents } from '../src/dsh/chat.ts'
describe('接口人对话', () => {
  const ev = (seq: number, type: string, data: unknown) => ({ seq, type, time: seq, data })
  const turn = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { content: [{ type: 'text', text: '今天和周岚聊了排期' }], source: { kind: 'user' } }),
    ev(3, 'assistant/message', { message: { content: [{ type: 'reasoning', text: '先查一下周岚是谁' }] } }),
    ev(4, 'tool/call', { callId: 'a', name: 'chief_lookup', arguments: '{"what":"overview"}' }),
    ev(5, 'tool/result', { message: { toolCallId: 'a', content: [{ type: 'text', text: 'ok' }] } }),
    ev(6, 'tool/call', { callId: 'b', name: 'chief_record', arguments: '{"kind":"commitment","person":"周岚","text":"周三给评审意见"}' }),
  ]
  it('进行中的一轮作为 live 返回，带着已经走过的步骤', () => {
    const { messages, live } = chatFromEvents(turn)
    expect(messages.map(m => m.role)).toEqual(['you'])
    expect(live?.steps.map(s => [s.label, s.done])).toEqual([['想了想', true], ['查花名册', true], ['记下承诺', false]])
    expect(live?.steps[2]?.detail).toBe('周岚：周三给评审意见')
  })
  it('一轮结束后：回复合并，带上过程和摘要；系统通知不算主人的话', () => {
    const { messages, live } = chatFromEvents([...turn,
      ev(7, 'tool/result', { message: { toolCallId: 'b', content: [{ type: 'text', text: 'ok' }] } }),
      ev(8, 'assistant/message', { message: { content: [{ type: 'text', text: '记下了。' }] } }),
      ev(9, 'user/message', { content: [{ type: 'text', text: '子代理完成通知' }], source: { kind: 'subagent' } }),
      ev(10, 'assistant/message', { message: { content: [{ type: 'text', text: '另外提醒你一件事。' }] } }),
      ev(11, 'turn/end', { turn: 1 }),
    ])
    expect(live).toBeUndefined()
    expect(messages.map(m => m.role)).toEqual(['you', 'liaison'])
    expect(messages[1]?.text).toBe('记下了。\n\n另外提醒你一件事。')
    expect(messages[1]?.did).toEqual(['查了花名册', '记入花名册 1 条'])
    expect(messages[1]?.steps?.every(s => s.done)).toBe(true)
  })
})

import { execFileSync } from 'node:child_process'
describe('第二大脑的 git 提交', () => {
  it('幕僚退休：角色卡的移动作为一次完整提交（删除也记下）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brain-git-'))
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' })
    git('init', '-q'); mkdirSync(join(root, 'staff'))
    writeFileSync(join(root, 'staff', 'watch.md'), '---\nname: 前哨\n---\n盯动态，给主人简报。')
    git('add', '-A'); git('commit', '-qm', 'init')
    const brain = new BrainRepo(root)
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't'; process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t'
    brain.retireStaff('watch')
    await brain.flush()
    expect(git('status', '--porcelain')).toBe('')
    expect(git('log', '-1', '--name-status', '--format=')).toMatch(/staff\/watch\.md/)
  })
})
