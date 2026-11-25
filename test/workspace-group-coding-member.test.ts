import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2CodingPermission } from '../src/core/workspace-v2.ts'
import type { ChatInputAttachment } from '../src/core/chat-attachments.ts'
import type { ChatAttachments } from '../src/dsh/chat-attachments.ts'
import { commandApprovals, type PendingCommand } from '../src/dsh/approvals.ts'
import { CodingGate, GATE_TOKEN_ENV } from '../src/dsh/coding-gate.ts'
import type { HostContext } from '../src/dsh/ports.ts'
import { CodingMemberRunner } from '../src/dsh/workspace-group-coding-member.ts'
import { GroupMemberSessions, type GroupContext, type MemberCall, type MemberCallSink, type MemberFinish } from '../src/dsh/workspace-group-members.ts'
import { cliHost, type FakeScript } from './coding-cli-fake.ts'

const roots: string[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-group-coding-')); roots.push(p); return p }
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

function sinkLog() {
  const log: [string, ...unknown[]][] = []
  const finished: MemberFinish[] = []
  const done = Promise.withResolvers<void>()
  const waiters: (() => void)[] = []
  const sink: MemberCallSink = {
    stepped: (id, text) => log.push(['stepped', id, text]),
    tool: (id, info) => log.push(['tool', id, info.name]),
    touched: () => {},
    approval: (id, waiting) => log.push(['approval', id, waiting]),
    finished: (id, result) => { log.push(['finished', id, result.status]); finished.push(result); done.resolve(); waiters.splice(0).forEach(fn => fn()) },
  }
  const next = () => new Promise<void>(resolve => waiters.push(resolve))
  return { sink, log, finished, done: done.promise, next }
}

function setup(script: FakeScript, options: { tier?: V2CodingPermission; tool?: 'codex' | 'claude-code'; inputAttachments?: Pick<ChatAttachments, 'cliInputs'> } = {}) {
  const dir = temp()
  const hookScript = join(dir, 'hook.js')
  writeFileSync(hookScript, '')
  const asked: PendingCommand[] = []
  const approvals = commandApprovals({ logger: { warn: () => {} } } as unknown as HostContext, () => undefined, { onRequest: row => asked.push(row) })
  cleanups.push(() => approvals.dispose())
  const gate = new CodingGate({ scope: 'brain', socketDir: join(dir, 'run'), hookScript, approvals, node: '/usr/bin/node',
    order: () => ({ permission: options.tier, title: '查端点', promise: '列出开通的端点' }) })
  cleanups.push(() => gate.dispose())
  const h = cliHost(script, { thread: () => 'thread-eng' })
  const tool = options.tool ?? 'codex'
  const runner = new CodingMemberRunner({ tool, subprocess: () => h.subprocess, executable: () => '/usr/bin/' + tool, gate, model: 'gpt-5', trustWaitMs: 500, inputAttachments: options.inputAttachments })
  cleanups.push(() => runner.dispose())
  const sessions = new GroupMemberSessions(join(dir, 'group'))
  const group: GroupContext = { scope: 'brain', workspaceId: 'w1', groupId: 'g1', workspaceName: '方舟评测', title: '端点排查', workDir: dir, sessions, commandsPath: join(dir, 'group', 'commands.jsonl') }
  const call = (callId: string, prompt = '#1 接口人：@工程师 用 arkcli 看端点'): MemberCall => ({ callId, group, member: { id: 'eng', name: '工程师', kind: tool, duty: '效果评测' },
    identity: '〔群成员身份〕你是「工程师」', prompt, recap: () => '群里最近的消息：\n#1 …', workOrderId: 'd1' })
  const lines = () => readFileSync(group.commandsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { h, runner, gate, approvals, asked, sessions, group, call, dir, lines }
}

/** What the hook would ask before a command, then the tool's own report of the run. */
async function command(gate: CodingGate, spec: { env?: NodeJS.ProcessEnv; cwd: string }, say: (frame: object) => void, id: string, text: string) {
  const answer = await gate.decide({ token: spec.env![GATE_TOKEN_ENV], tool_name: 'Bash', tool_input: { command: text }, cwd: spec.cwd })
  if (answer.decision === 'allow') {
    say({ type: 'item.started', item: { id, type: 'command_execution', command: text } })
    say({ type: 'item.completed', item: { id, type: 'command_execution', command: text, aggregated_output: 'ok', exit_code: 0 } })
  }
  return answer
}

describe('编程成员收到的聊天材料', () => {
  const file: ChatInputAttachment = {id:'a', name:'A.dat', kind:'file', bytes:6}
  const image: ChatInputAttachment = {id:'b', name:'B.png', kind:'image', bytes:3, mediaType:'image/png'}

  it.each(['codex','claude-code'] as const)('%s 的首轮和插话携带原生图片块、可读文件路径和原顺序', async tool => {
    const dir = temp(), path = join(dir, 'private-file'), png = join(dir, 'private-image')
    writeFileSync(path, 'G27-XQ', {mode:0o400})
    writeFileSync(png, Buffer.from([0, 2, 254]), {mode:0o400})
    const cliInputs = vi.fn(async (refs: readonly ChatInputAttachment[]) => refs.map(ref => ({...ref, path:ref.kind === 'file' ? path : png})))
    const t = setup(async (_spec, _prompt, {say, nextSteer, take}) => {
      if (tool === 'claude-code') say({type:'system', subtype:'init', session_id:'claude-1'})
      await nextSteer()
      if (tool === 'codex') say({type:'turn.completed'})
      else { take(); say({type:'result', subtype:'success', is_error:false, num_turns:1, session_id:'claude-1', result:'读完'}) }
      return 0
    }, {tool, inputAttachments:{cliInputs}})
    const s = sinkLog()
    await t.runner.run({...t.call('material'), inputAttachments:[file, image]}, s.sink)
    const result = await t.runner.steer('material', {id:'extra', text:'看看新版', inputAttachments:[image, file]})
    expect(result).toBe(tool === 'codex' ? 'steered' : 'pending')
    await s.done
    const [initial, extra] = t.h.calls[0]!.inputs
    const imageBlock = tool === 'codex' ? {type:'localImage',path:png} : {type:'image',source:{type:'base64',media_type:'image/png',data:'AAL+'}}
    expect(initial).toEqual([expect.objectContaining({type:'text'}), expect.objectContaining({text:expect.stringContaining(path)}),
      expect.objectContaining({text:expect.stringContaining(image.name)}), imageBlock])
    expect(extra).toEqual([expect.objectContaining({type:'text',text:'看看新版'}), expect.objectContaining({text:expect.stringContaining(image.name)}),
      imageBlock, expect.objectContaining({text:expect.stringContaining(path)})])
    expect(readFileSync(path,'utf8')).toBe('G27-XQ')
    expect(s.finished[0]?.status).toBe('completed')
  })

  it('Codex 的旧 thread 已丢失时，用当前工单回放的材料重新开一轮', async () => {
    const t = setup(() => 0)
    t.sessions.setMember('eng', {kind:'codex',cwd:t.dir,session:'lost',workOrderId:'d1',inputScoped:true})
    const cliInputs = vi.fn(async (refs: readonly ChatInputAttachment[]) => refs.map(ref => ({...ref, path:join(t.dir, ref.id)})))
    const h = cliHost((_spec, _prompt, {say}) => { say({type:'turn.completed'}); return 0 }, {refuseResume: () => 'unknown thread'})
    const runner = new CodingMemberRunner({tool:'codex',subprocess:() => h.subprocess,executable:() => '/fake/codex',inputAttachments:{cliInputs}})
    cleanups.push(() => runner.dispose())
    const s = sinkLog()
    await runner.run({...t.call('resume'), inputAttachments:[file], recapInputs:{inputAttachments:[image],readAttachments:[file]}}, s.sink)
    await s.done
    expect(cliInputs.mock.calls.map(([refs]) => refs.map(ref => ref.id))).toEqual([['a'], ['b'], ['a']])
    expect(h.calls[0]!.inputs).toEqual([])
    expect(h.calls[1]!.inputs[0]).toContainEqual({type:'localImage',path:join(t.dir,'b')})
    expect(t.sessions.native('eng','d1')?.session).not.toBe('lost')
  })
})

describe('Codex 成员', () => {
  it('首次带身份开新 thread，记下 thread；之后续接同一 thread 只送增量；中途的话与最终回复分开报', async () => {
    let gate!: CodingGate
    const t = setup(async (spec, _prompt, { say }) => {
      say({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '我先看看 arkcli 版本。' } })
      await command(gate, spec, say, 'x1', 'arkcli --version')
      say({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: '当前开通了 3 个端点：…' } })
      say({ type: 'turn.completed' })
      return 0
    })
    gate = t.gate
    const first = sinkLog()
    await t.runner.run(t.call('c1'), first.sink)
    await first.done
    expect(t.h.calls[0]!.prompt).toBe('〔群成员身份〕你是「工程师」\n\n群里最近的消息：\n#1 …')
    expect(t.h.calls[0]!.resume).toBeUndefined()
    expect(t.h.calls[0]!.spec.cwd).toBe(t.dir)
    expect(t.h.calls[0]!.thread).toMatchObject({ cwd: t.dir, model: 'gpt-5', sandbox: 'danger-full-access' })
    expect(first.log).toEqual([['stepped', 'c1', '我先看看 arkcli 版本。'], ['tool', 'c1', 'shell'], ['finished', 'c1', 'completed']])
    expect(first.finished).toEqual([{ text: '当前开通了 3 个端点：…', status: 'completed', toolCalls: 1 }])
    expect(t.sessions.member('eng')).toMatchObject({ kind: 'codex', cwd: t.dir, session: 'thread-eng' })
    expect(t.h.names.get('thread-eng')).toBe('方舟评测 · 端点排查 · 工程师')
    expect(t.lines().map(line => [line.kind, line.turnId, line.workOrderId, line.command, line.decision ?? line.exitCode])).toEqual([
      ['gate', 'c1.1', 'd1', 'arkcli --version', 'auto'], ['command', 'c1.1', 'd1', 'arkcli --version', 0]])

    const second = sinkLog()
    await t.runner.run(t.call('c2', '#5 主人：@工程师 再看一下配额'), second.sink)
    await second.done
    expect(t.h.calls[1]!.resume).toBe('thread-eng')
    expect(t.h.calls[1]!.prompt).toBe('#5 主人：@工程师 再看一下配额')
    // Every record names the member that ran it.
    expect(t.lines().every(line => line.memberId === 'eng' && line.memberName === '工程师')).toBe(true)
  })

  it('经验被撤回：不再续接旧 thread（开场白里还有它），改开新 thread 带身份与最近几行', async () => {
    const t = setup(async (_spec, _prompt, { say }) => {
      say({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '好' } })
      say({ type: 'turn.completed' })
      return 0
    })
    const run = async (callId: string, memories: string[]) => {
      const log = sinkLog()
      await t.runner.run({ ...t.call(callId, '#9 主人：@工程师 再看看'), member: { id: 'eng', name: '工程师', kind: 'codex', memories } }, log.sink)
      await log.done
    }
    await run('c1', ['旧经验'])
    await run('c2', ['旧经验', '新经验'])
    expect(t.h.calls[1]!.resume).toBe('thread-eng')
    await run('c3', ['新经验'])
    expect(t.h.calls[2]!.resume).toBeUndefined()
    expect(t.h.calls[2]!.prompt).toBe('〔群成员身份〕你是「工程师」\n\n群里最近的消息：\n#1 …')
    await run('c4', ['新经验'])
    expect(t.h.calls[3]!.resume).toBe('thread-eng')
  })

  it('续推在同一 thread 再跑一轮', async () => {
    const t = setup(async (_spec, prompt, { say }) => {
      say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: prompt.includes('开工') ? '已完成。' : '收到，我去查。' } })
      say({ type: 'turn.completed' })
      return 0
    })
    const s = sinkLog()
    await t.runner.run(t.call('c1'), s.sink)
    await s.done
    const again = s.next()
    await t.runner.continue('c1', '你上一句说要开工……')
    await again
    expect(t.h.calls[1]!.resume).toBe('thread-eng')
    expect(s.finished.map(row => row.text)).toEqual(['收到，我去查。', '已完成。'])
  })

  it('请求批准档：高危命令出审批卡（写明成员与工具），等批准时让出发言位', async () => {
    let gate!: CodingGate
    const t = setup(async (spec, _prompt, { say }) => {
      const answer = await command(gate, spec, say, 'x1', 'rm -rf build')
      say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: answer.decision === 'allow' ? '删掉了。' : '没删。' } })
      say({ type: 'turn.completed' })
      return 0
    }, { tier: 'ask' })
    gate = t.gate
    const s = sinkLog()
    await t.runner.run(t.call('c1'), s.sink)
    await vi.waitFor(() => expect(t.asked).toHaveLength(1))
    expect(t.asked[0]).toMatchObject({ staff: '工程师（Codex）', staffId: 'eng', command: 'rm -rf build',
      workspace: { workspaceId: 'w1', sessionId: 'g1', orderId: 'd1', turnId: 'c1.1', tool: 'codex', memberId: 'eng' } })
    t.approvals.decide(t.asked[0]!.id, false)
    await s.done
    expect(s.log).toEqual([['approval', 'c1', true], ['approval', 'c1', false], ['finished', 'c1', 'completed']])
    expect(s.finished[0]!.text).toBe('没删。')
  })

  it('叫停：中断回合，报取消', async () => {
    const t = setup(async (_spec, _prompt, { interrupted }) => { await interrupted; return 0 })
    const s = sinkLog()
    await t.runner.run(t.call('c1'), s.sink)
    t.runner.cancel('c1')
    await s.done
    expect(s.finished).toEqual([expect.objectContaining({ status: 'cancelled', text: '' })])
  })

  it('续接的 thread 已不在：改开新 thread，带身份与最近几行', async () => {
    const t = setup(async (_spec, _prompt, { say }) => {
      say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '好了' } })
      say({ type: 'turn.completed' })
      return 0
    })
    t.sessions.setMember('eng', { kind: 'codex', cwd: t.dir, session: 'thread-gone' })
    const refused = cliHost(async (_spec, _prompt, { say }) => { say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '好了' } }); say({ type: 'turn.completed' }); return 0 },
      { thread: () => 'thread-new', refuseResume: id => id === 'thread-gone' ? 'no rollout found' : undefined })
    const runner = new CodingMemberRunner({ tool: 'codex', subprocess: () => refused.subprocess, executable: () => '/usr/bin/codex', gate: t.gate, trustWaitMs: 500 })
    cleanups.push(() => runner.dispose())
    const s = sinkLog()
    await runner.run(t.call('c1', '#9 主人：@工程师 继续'), s.sink)
    await s.done
    expect(refused.calls.map(call => call.resume)).toEqual(['thread-gone', undefined])
    expect(refused.calls[1]!.prompt).toBe('〔群成员身份〕你是「工程师」\n\n群里最近的消息：\n#1 …')
    expect(t.sessions.member('eng')).toMatchObject({ session: 'thread-new' })
  })

  it('没有可用的 Codex：不送达，拒绝', async () => {
    const t = setup(async () => 0)
    const runner = new CodingMemberRunner({ tool: 'codex', subprocess: () => t.h.subprocess, executable: () => undefined })
    const s = sinkLog()
    await expect(runner.run(t.call('c1'), s.sink)).rejects.toThrow(/没有可用的 Codex/)
    expect(s.log).toEqual([])
  })

  it('重启后进程不在：回合按中断处理', async () => {
    const t = setup(async () => 0)
    t.sessions.setLive('c1', { memberId: 'eng', session: 'thread-eng', request: 'r', push: 1 })
    await expect(t.runner.reattach(t.call('c1'), sinkLog().sink)).resolves.toBe(false)
    expect(t.sessions.live('c1')).toBeUndefined()
  })
})

describe('Claude Code 成员', () => {
  it('同一会话续接（--resume），钩子参数装在命令行上', async () => {
    let gate!: CodingGate
    const t = setup(async (spec, _prompt, { say }) => {
      say({ type: 'system', subtype: 'init', session_id: 'claude-1', model: 'opus' })
      await gate.decide({ token: spec.env![GATE_TOKEN_ENV], tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: spec.cwd })
      say({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } })
      say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.txt' }] } })
      say({ type: 'assistant', message: { content: [{ type: 'text', text: '目录里有 a.txt。' }] } })
      say({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'claude-1', result: '目录里有 a.txt。' })
      return 0
    }, { tool: 'claude-code' })
    gate = t.gate
    const s = sinkLog()
    await t.runner.run(t.call('c1'), s.sink)
    await s.done
    expect(t.h.calls[0]!.spec.argv).toContain('--settings')
    expect(s.finished).toEqual([{ text: '目录里有 a.txt。', status: 'completed', toolCalls: 1 }])
    expect(t.sessions.member('eng')).toMatchObject({ kind: 'claude-code', session: 'claude-1' })
    const next = sinkLog()
    await t.runner.run(t.call('c2', '#3 主人：再看看'), next.sink)
    await next.done
    expect(t.h.calls[1]!.resume).toBe('claude-1')
    expect(t.h.calls[1]!.prompt).toBe('#3 主人：再看看')
  })
})

describe('主人的话立即送进在干活的编程工具成员', () => {
  it('Codex：turn/steer 送进在跑的回合（steered）；回合已结束或被拒（-32600）为 rejected', async () => {
    const t = setup(async (_spec, _prompt, { say, nextSteer }) => {
      const words = await nextSteer()
      say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '收到主人的话：' + words } })
      say({ type: 'turn.completed' })
      return 0
    })
    const s = sinkLog()
    await t.runner.run(t.call('c1'), s.sink)
    await expect(t.runner.steer('c1', { id: 'steer-7', text: '#7 主人：先别删，先列出来' })).resolves.toBe('steered')
    await s.done
    expect(t.h.calls[0]!.steers).toEqual(['#7 主人：先别删，先列出来'])
    expect(s.finished[0]!.text).toBe('收到主人的话：#7 主人：先别删，先列出来')
    await expect(t.runner.steer('c1', { id: 'steer-8', text: '晚了' })).resolves.toBe('rejected')
    await expect(t.runner.steer('nobody', { id: 'x', text: 'x' })).resolves.toBe('rejected')

    const refused = cliHost(async (_spec, _prompt, { say, interrupted }) => { await Promise.race([interrupted, new Promise(r => setTimeout(r, 50))]); say({ type: 'turn.completed' }); return 0 }, { refuseSteer: true })
    const runner = new CodingMemberRunner({ tool: 'codex', subprocess: () => refused.subprocess, executable: () => '/usr/bin/codex' })
    cleanups.push(() => runner.dispose())
    const r = sinkLog()
    await runner.run(t.call('c9'), r.sink)
    await expect(runner.steer('c9', { id: 'steer-1', text: '先停一下' })).resolves.toBe('rejected')
    await r.done
  })

  it('Claude Code：追加一条 stream-json 用户消息（pending），回合在它被读到之前不收尾', async () => {
    const t = setup(async (_spec, _prompt, { say, nextSteer, take, linger }) => {
      say({ type: 'system', subtype: 'init', session_id: 'claude-1', model: 'opus' })
      linger()
      const words = await nextSteer()
      take()
      say({ type: 'assistant', message: { content: [{ type: 'text', text: '按主人的话改了：' + words }] } })
      say({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'claude-1', result: '按主人的话改了：' + words })
      return 0
    }, { tool: 'claude-code' })
    const s = sinkLog()
    await t.runner.run(t.call('c1'), s.sink)
    await expect(t.runner.steer('c1', { id: 'steer-3', text: '#3 主人：用中文' })).resolves.toBe('pending')
    await s.done
    expect(s.finished[0]).toMatchObject({ status: 'completed', text: '按主人的话改了：#3 主人：用中文' })
  })
})
