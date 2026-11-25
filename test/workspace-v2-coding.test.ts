import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2CodingPermission, V2Session, V2TurnInput } from '../src/core/workspace-v2.ts'
import type { ExperienceEntry, WorkspaceExperiencePort } from '../src/core/workspace-experience.ts'
import { REDACTED } from '../src/core/redact.ts'
import { commandApprovals } from '../src/dsh/approvals.ts'
import { CodingGate, GATE_DEADLINE_ENV, GATE_SOCKET_ENV, GATE_TOKEN_ENV } from '../src/dsh/coding-gate.ts'
import type { HostContext } from '../src/dsh/ports.ts'
import { codexThreadParams, codingArguments, codingTurn, CodingTurnError, HOOK_TRUST_ISSUE, type CodingCommandEvent } from '../src/dsh/workspace-v2-coding.ts'
import { appendCommandLog, readCommandLog } from '../src/dsh/workspace-command-log.ts'
import { CODING_TURN_LIMIT_MS, createV2DialogueSource, OWNER_LABEL } from '../src/dsh/workspace-v2-dialogue.ts'
import { dialogueKey } from '../src/dsh/workspace-v2-group.ts'
import { cliHost, type FakeCall, type FakeIo, type FakeOptions, type Spec } from './coding-cli-fake.ts'

const roots: string[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-v2-coding-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, {recursive: true, force: true}) })

type Script = (spec: Spec, prompt: string, io: FakeIo, call: FakeCall) => Promise<number> | number
const host = (perform: Script, fake?: FakeOptions) => cliHost(perform, fake)
const signal = () => new AbortController().signal
const session: V2Session = {id:'s1', workspaceId:'w1', title:'方舟核查', kind:'coding', executor:'codex', delegationIds:['d1'], closed:false, createdAt:'2026-11-20'}
const claudeSession: V2Session = {...session, id:'s2', executor:'claude-code'}
const turn = (id: string, text: string): V2TurnInput => ({id, text, workOrderId:'d1'})
const options = (ctx: HostContext, root: string) => ({ctx, root, scope:'brain', codex:{executable:process.execPath, model:'host-model'}, claudeExecutable:process.execPath})
const journalOf = (root: string, s: V2Session) => {
  const area = dialogueKey('brain', s.workspaceId)
  return join(root, 'ops', 'superhub-v2-dialogues', area, dialogueKey(area, s.id), 'source.json')
}

describe('run-as-owner launch arguments', () => {
  it('runs Codex with full access and the owner\'s configuration (no SuperHub MCP server), continuing by thread id', () => {
    // The app server takes access, model and the continued thread as thread parameters; hooks stay global options.
    expect(codingArguments('codex')).toEqual(['app-server', '--stdio'])
    expect(codingArguments('codex', {model:'m'})).toEqual(['app-server', '--stdio'])
    expect(codingArguments('codex', {resume:'thread-1', extraArgs:['--enable', 'hooks']})).toEqual(['--enable', 'hooks', 'app-server', '--stdio'])
    for (const removed of ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--model', '--ephemeral',
      '--ignore-user-config', '--ignore-rules', '--strict-config']) expect(codingArguments('codex', {model:'m', resume:'t'})).not.toContain(removed)
    expect(codingArguments('codex').join(' ')).not.toMatch(/permissions\.|shell_environment_policy|web_search|project_doc_max_bytes|project_root_markers|features\.|approval_policy|mcp_servers=/)
    expect(codexThreadParams('/w')).toEqual({cwd:'/w', sandbox:'danger-full-access', approvalPolicy:'never', config:{bypass_hook_trust:true}})
    expect(codexThreadParams('/w', {model:'m', resume:'thread-1'})).toEqual({threadId:'thread-1', cwd:'/w', sandbox:'danger-full-access', approvalPolicy:'never',
      config:{bypass_hook_trust:true}, model:'m', excludeTurns:true})
  })

  it('runs Claude Code with bypassed permissions, the owner\'s settings and MCP, and a persistent session', () => {
    expect(codingArguments('claude-code')).toEqual(['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--replay-user-messages', '--permission-mode', 'bypassPermissions'])
    const cli = codingArguments('claude-code', {resume:'session-1', model:'ignored', extraArgs:['--settings', '{}']})
    expect(cli.slice(-4)).toEqual(['--resume', 'session-1', '--settings', '{}'])
    for (const removed of ['--mcp-config', '--restricted', '--safe-mode', '--setting-sources', '--tools', '--allowedTools', '--no-session-persistence', '--max-turns', '--strict-mcp-config', '--model']) {
      expect(cli).not.toContain(removed)
    }
  })

  it('inherits the full process environment including credentials, without harness-private DSH facts', async () => {
    const saved = {...process.env}
    Object.assign(process.env, {OPENAI_API_KEY:'sk-owner', ARK_TOKEN:'ark', DSH_SESSION_ID:'private', CHIEF_TEST_PLAIN:'plain'})
    try {
      const h = host((_spec, _prompt, {say}) => { say({type:'turn.completed'}); return 0 })
      await codingTurn(h.subprocess, 'codex', 'codex', tmpdir(), 'hi', signal(), {publish: () => {}, env: {SUPERHUB_GATE_TOKEN:'t'}})
      const env = h.calls[0]!.spec.env!
      expect(env).toMatchObject({OPENAI_API_KEY:'sk-owner', ARK_TOKEN:'ark', CHIEF_TEST_PLAIN:'plain', PATH:process.env.PATH, SUPERHUB_GATE_TOKEN:'t'})
      expect(env).not.toHaveProperty('DSH_SESSION_ID')
      expect(h.calls[0]!.prompt).toBe('hi')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })
})

describe('coding tool stream: commands, native session and process', () => {
  it('仅收到 Claude Code 初始化和拒绝时不登记输入送达', async () => {
    const h = host((_spec, _prompt, {say}) => {
      say({type:'system',subtype:'init',session_id:'unconfirmed'})
      say({type:'result',subtype:'error_during_execution',is_error:true,num_turns:0,session_id:'unconfirmed'})
      return 1
    }, {replay:false})
    const onInputAccepted = vi.fn()
    await expect(codingTurn(h.subprocess, 'claude-code', 'claude', tmpdir(), '需要认领的摘要', signal(),
      {publish:()=>{},onInputAccepted})).rejects.toThrow()
    expect(onInputAccepted).not.toHaveBeenCalled()
  })

  it('reports Codex command executions with exit code and a redacted output tail, and the thread id', async () => {
    const events: CodingCommandEvent[] = [], sessions: string[] = []
    const h = host((_spec, _prompt, {say}) => {
      say({type:'item.started', item:{id:'item_0', type:'command_execution', command:'bash -lc ls', status:'inProgress'}})
      say({type:'item.completed', item:{id:'item_0', type:'command_execution', command:'bash -lc ls', aggregated_output:'x'.repeat(5000) + '\nAPI_KEY=abc', exit_code:0, status:'completed'}})
      say({type:'item.completed', item:{id:'item_1', type:'command_execution', command:'arkcli --version', aggregated_output:'', exit_code:127, status:'failed'}})
      say({type:'item.completed', item:{id:'item_2', type:'agent_message', text:'完成'}})
      say({type:'turn.completed'})
      return 0
    }, {thread: () => '019a-thread', model:'gpt-6.2-sol'})
    const result = await codingTurn(h.subprocess, 'codex', 'codex', tmpdir(), 'p', signal(), {publish: () => {}, onCommand: e => events.push(e), onSession: id => sessions.push(id)})
    // The thread start names the model; no session record is read.
    expect(result).toMatchObject({sessionId:'019a-thread', started:true, model:'gpt-6.2-sol', process:{exitCode:0, stderrTail:''}, interjections:[]})
    expect(h.calls[0]!.methods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
    expect(h.calls[0]!.thread).toMatchObject({sandbox:'danger-full-access', approvalPolicy:'never', config:{bypass_hook_trust:true}})
    expect(sessions).toEqual(['019a-thread'])
    expect(events.map(e => [e.itemId, e.phase, e.command, e.exitCode, e.failed])).toEqual([
      ['item_0', 'start', 'bash -lc ls', undefined, undefined], ['item_0', 'end', 'bash -lc ls', 0, false], ['item_1', 'end', 'arkcli --version', 127, true]])
    expect(Buffer.byteLength(events[1]!.outputTail!)).toBeLessThanOrEqual(2048)
    expect(events[1]!.outputTail!.endsWith('API_KEY=' + REDACTED)).toBe(true)
  })

  it('reads the model from the Codex thread start and from the Claude Code init', async () => {
    const codex = host((_spec, _prompt, {say}) => { say({type:'turn.completed'}); return 0 }, {model:'gpt-6.2-sol'})
    expect((await codingTurn(codex.subprocess, 'codex', 'codex', tmpdir(), 'p', signal(), {publish: () => {}})).model).toBe('gpt-6.2-sol')
    const claude = host((_spec, _prompt, {say}) => {
      say({type:'system', subtype:'init', session_id:'c1', model:'claude-opus-5-5'})
      say({type:'result', subtype:'success', is_error:false, result:'好', session_id:'c1', num_turns:1})
      return 0
    })
    expect((await codingTurn(claude.subprocess, 'claude-code', 'claude', tmpdir(), 'p', signal(), {publish: () => {}})).model).toBe('claude-opus-5-5')
    // The prompt is the first stream-json user message.
    expect(claude.calls[0]!.prompt).toBe('p')
  })

  it('pairs Claude Code tool uses with their results, including subagent tools, and reads the session id from init', async () => {
    const events: CodingCommandEvent[] = []
    const h = host((_spec, _prompt, {say}) => {
      say({type:'system', subtype:'init', session_id:'claude-session'})
      say({type:'assistant', uuid:'a1', message:{id:'m1', content:[{type:'text', text:'先看看'}, {type:'tool_use', id:'tu1', name:'Bash', input:{command:'git status'}}]}})
      say({type:'user', message:{content:[{type:'tool_result', tool_use_id:'tu1', content:'On branch main', is_error:false}]}})
      say({type:'assistant', uuid:'a2', parent_tool_use_id:'task', message:{id:'m2', content:[{type:'tool_use', id:'tu2', name:'Bash', input:{command:'false'}}]}})
      say({type:'user', message:{content:[{type:'tool_result', tool_use_id:'tu2', content:[{type:'text', text:'Exit code 1\nboom'}], is_error:true}]}})
      say({type:'assistant', uuid:'a3', message:{id:'m3', content:[{type:'tool_use', id:'tu3', name:'Edit', input:{file_path:'/w/a.md', old_string:'x', new_string:'y'}}]}})
      say({type:'user', message:{content:[{type:'tool_result', tool_use_id:'tu3', content:'denied', is_error:true}]}})
      say({type:'result', subtype:'success', is_error:false, result:'好了', session_id:'claude-session', num_turns:3})
      return 0
    })
    const published: string[] = []
    const result = await codingTurn(h.subprocess, 'claude-code', 'claude', tmpdir(), 'p', signal(), {publish: (_id, text) => published.push(text), onCommand: e => events.push(e)})
    expect(result.sessionId).toBe('claude-session')
    expect(published).toEqual(['先看看', '好了'])
    expect(events.filter(e => e.phase === 'end').map(e => [e.tool, e.command, e.exitCode, e.failed, e.outputTail])).toEqual([
      ['Bash', 'git status', 0, false, 'On branch main'], ['Bash', 'false', 1, true, 'Exit code 1\nboom'], ['Edit', 'Edit /w/a.md', undefined, true, 'denied']])
  })

  it('keeps the last 4 KB of redacted, uncolored stderr and names the exit code in a one-line failure', async () => {
    const h = host((_spec, _prompt, {stderr}) => {
      stderr('\x1b[2m2026-11-22T10:00:00Z\x1b[0m \x1b[31mERROR\x1b[0m noise\n'.repeat(500) + 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted token=abc\n')
      return 1
    })
    const failure = await codingTurn(h.subprocess, 'codex', 'codex', tmpdir(), 'p', signal(), {publish: () => {}}).catch(error => error)
    expect(failure).toBeInstanceOf(CodingTurnError)
    const {process: proc, started} = (failure as CodingTurnError).result
    // The turn had started on the app server before the process died.
    expect(started).toBe(true)
    expect(proc.stderrTail).not.toContain('\x1b')
    expect(proc.stderrTail).toContain('ERROR noise')
    expect(proc.exitCode).toBe(1)
    expect(Buffer.byteLength(proc.stderrTail)).toBeLessThanOrEqual(4096)
    expect(proc.stderrTail).toContain('Operation not permitted token=' + REDACTED)
    expect(failure.message).toBe('编程工具未确认完成本轮（退出码 1：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted token=' + REDACTED + '）。已收到的发言保留在会话中。')
    expect(failure.message).not.toContain('\n')
  })

  it('does not treat a Claude Code result without any turn as a started turn', async () => {
    const h = host((_spec, _prompt, {say, stderr}) => {
      stderr('No conversation found with session ID: gone\n')
      say({type:'result', subtype:'error_during_execution', is_error:true, num_turns:0, session_id:'gone'})
      return 1
    }, {replay: false})
    const failure = await codingTurn(h.subprocess, 'claude-code', 'claude', tmpdir(), 'p', signal(), {publish: () => {}, launch:{resume:'gone'}}).catch(error => error)
    expect((failure as CodingTurnError).result.started).toBe(false)
  })
})

describe('coding session journal: commands, native continuation and process', () => {
  it.each([session, claudeSession])('$executor 普通会话刷新授权并登记实际输入与命令回执', async target => {
    const root = temp()
    const h = host((_spec, prompt, {say}) => {
      const result = prompt.includes('陈旧方法') ? '旧执行者的转述' : '现在的结果'
      if (target.executor === 'codex') {
        say({type:'item.completed',item:{id:'verify',type:'command_execution',command:'pnpm test',exit_code:0,aggregated_output:'ok'}})
        say({type:'item.completed',item:{id:'reply',type:'agent_message',text:result}})
        say({type:'turn.completed'})
      } else {
        say({type:'system',subtype:'init',session_id:'claude-1'})
        say({type:'assistant',message:{content:[{type:'tool_use',id:'verify',name:'Bash',input:{command:'pnpm test'}}]}})
        say({type:'user',message:{content:[{type:'tool_result',tool_use_id:'verify',content:'ok'}]}})
        say({type:'result',subtype:'success',session_id:'claude-1',num_turns:1,result})
      }
      return 0
    })
    const recordExperienceDelivery = vi.fn()
    const onCodingResult = vi.fn()
    let available: ExperienceEntry[] = [{id:'steps',version:1,text:'陈旧方法'}]
    const experience: WorkspaceExperiencePort = {
      selectExperience: query => ({query,scope:'brain',authority:'v1',entries:available,authorized:available}),
      assertExperienceCurrent: () => {},
      recordExperienceDelivery,
    }
    const source = createV2DialogueSource({...options(h.ctx,root),experience,onCodingResult})
    await source.send(target,turn('first','主人先前指示'),signal())
    available = [{id:'steps',version:2,text:'改后的新方法'}]
    await source.send(target,turn('second','主人的本轮指示'),signal())
    expect(h.calls[1]!.resume).toBeUndefined()
    expect(h.calls[1]!.prompt).toContain('改后的新方法')
    expect(h.calls[1]!.prompt).toContain('主人先前指示')
    expect(h.calls[1]!.prompt).not.toContain('旧执行者的转述')
    expect(recordExperienceDelivery.mock.calls.map(([picked, receipt]) => [picked.entries[0].version, receipt.sessionId, receipt.turnId]))
      .toEqual([[1,target.id,'first'],[2,target.id,'second']])
    expect(onCodingResult.mock.calls[1]?.[0]).toMatchObject({sessionId:target.id, turnId:'second',
      commands:[{command:'pnpm test',exitCode:0,outputTail:'ok'}]})
    source.dispose()
  })
  it('records commands per work order, continues the native session with only this turn, and keeps the process exit', async () => {
    const root = temp()
    const h = host((_spec, _prompt, {say}) => {
      say({type:'item.completed', item:{id:'item_0', type:'command_execution', command:'arkcli --version', aggregated_output:'arkcli 1.0.50', exit_code:0}})
      say({type:'item.completed', item:{id:'item_1', type:'agent_message', text:'arkcli 1.0.50 可用。'}})
      say({type:'turn.completed'})
      return 0
    }, {thread: () => 'thread-A'})
    const source = createV2DialogueSource(options(h.ctx, root))
    await source.send(session, turn('one', '查一下 arkcli 版本'), signal())
    await source.send(session, turn('two', '刚才查到的是哪个版本？'), signal())
    expect(h.calls[0]!.resume).toBeUndefined()
    expect(h.calls[0]!.methods).toContain('thread/start')
    expect(h.calls[1]!.methods).toContain('thread/resume')
    expect(h.calls[1]!.resume).toBe('thread-A')
    expect(h.calls[1]!.thread).toMatchObject({threadId:'thread-A', model:'host-model', sandbox:'danger-full-access', approvalPolicy:'never', config:{bypass_hook_trust:true}})
    expect(h.calls[1]!.spec.argv.slice(-2)).toEqual(['app-server', '--stdio'])
    expect(h.calls[1]!.prompt).not.toContain('查一下 arkcli 版本')
    expect(h.calls[1]!.prompt).toContain('刚才查到的是哪个版本？')
    const execution = source.execution!(session, 'd1')
    expect(execution.commands.map(c => [c.turnId, c.command, c.exitCode, c.outputTail, c.cwd])).toEqual([
      ['one', 'arkcli --version', 0, 'arkcli 1.0.50', h.calls[0]!.spec.cwd], ['two', 'arkcli --version', 0, 'arkcli 1.0.50', h.calls[0]!.spec.cwd]])
    expect(new Set(execution.commands.map(c => c.id)).size).toBe(2)
    expect(execution.runs).toMatchObject([{turnId:'one', tool:'codex', state:'done', nativeSessionId:'thread-A', model:'gpt-fake', process:{exitCode:0}},
      {turnId:'two', resumed:true, nativeSessionId:'thread-A'}])
    expect(execution.runs[0]).not.toHaveProperty('resumed')
    expect(source.execution!(session).commands).toEqual([])
    const stored = JSON.parse(readFileSync(journalOf(root, session), 'utf8'))
    expect(Object.values(stored.native)).toMatchObject([{tool:'codex', sessionId:'thread-A'}])
    source.dispose()
  })

  it('falls back to a new session with the public history when a continuation fails before the model saw the prompt', async () => {
    const root = temp()
    const h = host((_spec, _prompt, {say}) => {
      say({type:'item.completed', item:{id:'r', type:'agent_message', text:'答复 ' + h.calls.length}})
      say({type:'turn.completed'})
      return 0
    }, {refuseResume: id => 'no rollout found for thread id ' + id})
    const source = createV2DialogueSource(options(h.ctx, root))
    await source.send(session, turn('one', '第一轮原话'), signal())
    await source.send(session, turn('two', '第二轮'), signal())
    expect(h.calls).toHaveLength(3)
    // The refusal is a JSON-RPC error before turn/start: the model saw nothing.
    expect(h.calls[1]!.resume).toBe('thread-1')
    expect(h.calls[1]!.methods).not.toContain('turn/start')
    expect(h.calls[2]!.resume).toBeUndefined()
    expect(h.calls[2]!.prompt).toContain('第一轮原话')
    const stored = JSON.parse(readFileSync(journalOf(root, session), 'utf8'))
    expect(stored.turns[1]).toMatchObject({state:'done', nativeSessionId:'thread-2', resumeFailure:'退出码 0：thread/resume 失败：no rollout found for thread id thread-1'})
    expect(Object.values(stored.native)).toMatchObject([{sessionId:'thread-2'}])
    expect((await source.read(session)).messages.map(m => m.text)).toEqual(['第一轮原话', '答复 1', '第二轮', '答复 3'])
    source.dispose()
  })

  it('does not re-dispatch a continuation that already reached the model, and shows the exit and stderr while unconfirmed', async () => {
    const root = temp()
    const h = host((_spec, _prompt, {say, stderr}, call) => {
      if (call.resume) {
        say({type:'item.started', item:{id:'item_9', type:'command_execution', command:'sleep 600'}})
        stderr('fatal: stream disconnected Bearer abc.def\n')
        return 2
      }
      say({type:'turn.completed'})
      return 0
    }, {thread: () => 'thread-A'})
    const source = createV2DialogueSource(options(h.ctx, root))
    await source.send(session, turn('one', '开始'), signal())
    await expect(source.send(session, turn('two', '继续'), signal())).rejects.toThrow('退出码 2')
    expect(h.calls).toHaveLength(2)
    const read = await source.read(session)
    expect(read.issue).toBe('编程工具未确认完成本轮（退出码 2：fatal: stream disconnected Bearer ' + REDACTED + '）。已收到的发言保留在会话中。')
    const {commands, runs} = source.execution!(session, 'd1')
    expect(commands).toMatchObject([{command:'sleep 600', turnId:'two'}])
    expect(commands[0]).not.toHaveProperty('endedAt')
    expect(runs.at(-1)).toMatchObject({turnId:'two', state:'unknown', resumed:true, process:{exitCode:2, stderrTail:'fatal: stream disconnected Bearer ' + REDACTED + '\n'}})
    source.dispose()
  })

  it('continues a Claude Code session by its own id and keeps tool calls out of the public transcript', async () => {
    const root = temp()
    const h = host((spec, _prompt, {say}) => {
      say({type:'system', subtype:'init', session_id:'cc-1'})
      say({type:'assistant', uuid:'u' + h.calls.length, message:{id:'m', content:[{type:'tool_use', id:'t' + h.calls.length, name:'Bash', input:{command:'ls'}}]}})
      say({type:'user', message:{content:[{type:'tool_result', tool_use_id:'t' + h.calls.length, content:'a.md'}]}})
      say({type:'result', subtype:'success', is_error:false, result:spec.argv.includes('--resume') ? '续上了' : '看过了', num_turns:2})
      return 0
    })
    const source = createV2DialogueSource(options(h.ctx, root))
    await source.send(claudeSession, turn('one', '看看目录'), signal())
    await source.send(claudeSession, turn('two', '再说一次'), signal())
    expect(h.calls[1]!.spec.argv.slice(-2)).toEqual(['--resume', 'cc-1'])
    expect((await source.read(claudeSession)).messages.map(m => m.text)).toEqual(['看看目录', '看过了', '再说一次', '续上了'])
    expect(source.execution!(claudeSession, 'd1').commands.map(c => [c.tool, c.command, c.exitCode])).toEqual([['Bash', 'ls', 0], ['Bash', 'ls', 0]])
    source.dispose()
  })

  it('reads an older journal without commands, native sessions or process records', async () => {
    const root = temp()
    const h = host((_spec, _prompt, {say}) => { say({type:'item.completed', item:{id:'x', type:'agent_message', text:'新答复'}}); say({type:'turn.completed'}); return 0 })
    const source = createV2DialogueSource(options(h.ctx, root))
    await source.read(session)
    // An exec-era thread id is continued by the app server as it is.
    writeFileSync(journalOf(root, session), JSON.stringify({messages:[{id:'old', role:'user', author:'你', speakerId:'owner', at:'2026-11-19T00:00:00Z', text:'旧原话', workOrderId:'d1'}],
      attachments:[], turns:[{id:'old', text:'旧原话', state:'done', workOrderId:'d1'}], members:[]}))
    expect(source.execution!(session, 'd1')).toEqual({commands:[], permissions:[], runs:[]})
    expect((await source.read(session)).messages.map(m => m.text)).toEqual(['旧原话'])
    await source.send(session, turn('new', '接着做'), signal())
    expect(h.calls[0]!.resume).toBeUndefined()
    expect(h.calls[0]!.prompt).toContain('旧原话')
    expect(source.execution!(session, 'd1').runs.map(r => r.turnId)).toEqual(['new'])
    source.dispose()
  })

  it('stops the tool process when the owner stops the turn, keeps its exit and never re-dispatches', async () => {
    const root = temp(), control = new AbortController()
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const h = host(async (spec, _prompt, {say, stderr}) => {
      say({type:'item.started', item:{id:'item_0', type:'command_execution', command:'sleep 330'}})
      started()
      await new Promise(resolve => spec.signal!.addEventListener('abort', resolve, {once: true}))
      stderr('terminated\n')
      return 143
    })
    const source = createV2DialogueSource(options(h.ctx, root))
    const sent = source.send(session, turn('one', '跑一条长命令'), control.signal)
    await running
    control.abort()
    await expect(sent).rejects.toThrow('未确认')
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.spec.signal!.aborted).toBe(true)
    const stored = JSON.parse(readFileSync(journalOf(root, session), 'utf8'))
    expect(stored.turns[0]).toMatchObject({state:'unknown', process:{exitCode:143, stderrTail:'terminated\n'}})
    expect(stored.turns[0]).not.toHaveProperty('failure')
    source.dispose()
  })

  it('allows a turn to run for hours', () => expect(CODING_TURN_LIMIT_MS).toBe(4 * 60 * 60 * 1000))
})

describe('command gate in coding turns', () => {
  function gated(root: string, tier: () => V2CodingPermission | undefined) {
    const hookScript = join(root, 'hook.js')
    writeFileSync(hookScript, '')
    const approvals = commandApprovals({logger:{warn:() => {}}} as unknown as HostContext, () => undefined)
    return new CodingGate({scope:'brain', socketDir:join(root, 'run'), hookScript, approvals, node:'/usr/bin/node',
      order: () => ({permission:tier(), title:'清理探针', promise:'删除 probe.txt'})})
  }

  it('installs the hook for both tools (also when continuing), records each decision next to the tool report, and revokes the token after the turn', async () => {
    const root = temp()
    let tier: V2CodingPermission | undefined = 'ask'
    const gate = gated(root, () => tier)
    const tokens: string[] = []
    const h = host(async (spec, _prompt, {say}) => {
      const token = spec.env![GATE_TOKEN_ENV]!
      tokens.push(token)
      // What the hook would ask before each command.
      const ls = await gate.decide({token, tool_name:'Bash', tool_input:{command:'ls'}, cwd:spec.cwd})
      expect(ls.decision).toBe('allow')
      say({type:'item.completed', item:{id:'item_0', type:'command_execution', command:"/bin/bash -lc 'ls'", aggregated_output:'probe.txt', exit_code:0}})
      if (tokens.length > 1) { say({type:'turn.completed'}); return 0 }
      const removal = gate.decide({token, tool_name:'Bash', tool_input:{command:'rm probe.txt'}, cwd:spec.cwd})
      await vi.waitFor(() => expect(gate.pending()).toHaveLength(1))
      gate.answer(gate.pending()[0]!.id, false, {workspaceId:'w1', orderId:'d1'})
      expect((await removal).decision).toBe('deny')
      say({type:'item.completed', item:{id:'item_1', type:'agent_message', text:'删除被主人拒绝，其余已完成。'}})
      say({type:'turn.completed'})
      return 0
    }, {thread: () => 'thread-A'})
    const source = createV2DialogueSource({...options(h.ctx, root), gate})
    await source.send(session, turn('one', '删掉探针'), signal())
    const argv = h.calls[0]!.spec.argv
    const hooks = argv.indexOf('--enable')
    expect(argv.slice(hooks, hooks + 3)).toEqual(['--enable', 'hooks', '-c'])
    expect(argv[hooks + 3]).toMatch(/^hooks\.PreToolUse=\[\{matcher="\*",hooks=\[\{type="command",command="\/usr\/bin\/node .*hook\.js",timeout=1890\}\]\}\]$/)
    expect(argv.slice(-2)).toEqual(['app-server', '--stdio'])
    // Hook trust is a thread parameter; the command line has no trust flag for the app server.
    expect(argv).not.toContain('--dangerously-bypass-hook-trust')
    expect(h.calls[0]!.thread).toMatchObject({config:{bypass_hook_trust:true}})
    expect(Object.keys(h.calls[0]!.spec.env!)).toEqual(expect.arrayContaining([GATE_SOCKET_ENV, GATE_TOKEN_ENV, GATE_DEADLINE_ENV]))
    const record = source.execution!(session, 'd1')
    expect(record.commands.map(c => [c.command, c.decision, c.tier, c.risk, c.exitCode, c.by])).toEqual([
      ["/bin/bash -lc 'ls'", 'auto', 'ask', 'normal', 0, 'policy'], ['rm probe.txt', 'rejected', 'ask', 'high', undefined, 'owner']])
    await expect(gate.decide({token:tokens[0], tool_name:'Bash', tool_input:{command:'ls'}})).rejects.toThrow(/作废/)
    // A tier change is appended to the same record; source.json carries no command log.
    tier = 'full-access'
    source.recordPermission!(session, 'd1', {at:'2026-11-20T09:00:00.000Z', from:'ask', to:'full-access'})
    expect(source.execution!(session, 'd1').permissions).toEqual([{at:'2026-11-20T09:00:00.000Z', from:'ask', to:'full-access'}])
    expect(JSON.parse(readFileSync(journalOf(root, session), 'utf8'))).not.toHaveProperty('commands')
    const lines = readFileSync(join(dirname(journalOf(root, session)), 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).kind)
    expect(lines).toEqual(['gate', 'command', 'gate', 'permission'])
    // The continuation installs the hook as well, with the thread id after it.
    await source.send(session, turn('two', '再看一眼'), signal())
    const resumed = h.calls[1]!.spec.argv
    expect(h.calls[1]!.resume).toBe('thread-A')
    expect(h.calls[1]!.thread).toMatchObject({threadId:'thread-A', config:{bypass_hook_trust:true}})
    expect(resumed.indexOf('--enable')).toBeLessThan(resumed.indexOf('app-server'))
    expect(tokens[1]).not.toBe(tokens[0])
    gate.dispose()
    source.dispose()
  })

  it('does not start a Codex turn when the thread does not confirm hook trust, and reports it as not dispatched', async () => {
    const root = temp(), gate = gated(root, () => 'ask')
    const h = host(() => 0, {trust: false})
    const source = createV2DialogueSource({...options(h.ctx, root), gate, codexTrustWaitMs: 50})
    await expect(source.send(session, turn('one', '删掉探针'), signal())).rejects.toMatchObject({dispatched: false, message: HOOK_TRUST_ISSUE})
    expect(h.calls[0]!.thread).toMatchObject({config: {bypass_hook_trust: true}})
    expect(h.calls[0]!.methods).not.toContain('turn/start')
    expect(JSON.parse(readFileSync(journalOf(root, session), 'utf8')).turns[0]).toMatchObject({state: 'unsent', deliveryIssue: HOOK_TRUST_ISSUE})
    expect((await source.read(session)).issue).toContain('把关异常')
    gate.dispose()
    source.dispose()
  })

  it('interrupts a Codex turn when commands run but the hook has never asked anything (the hook is not running)', async () => {
    const root = temp(), gate = gated(root, () => 'ask')
    const h = host(async (_spec, _prompt, io) => {
      // Input written to a running process (write_stdin) never passes the hook and is not checked.
      io.say({type: 'item.started', item: {id: 'c0b', type: 'command_execution', command: "/bin/bash -lc 'ls'", source: 'unifiedExecInteraction'}})
      io.say({type: 'item.completed', item: {id: 'c0b', type: 'command_execution', command: "/bin/bash -lc 'ls'", source: 'unifiedExecInteraction', exit_code: 0}})
      // A hook that does not run: a command starts and the gate has never been asked anything this turn.
      io.say({type: 'item.started', item: {id: 'c1', type: 'command_execution', command: "/bin/bash -lc 'touch probe.txt'"}})
      await io.interrupted
      return 0
    })
    const source = createV2DialogueSource({...options(h.ctx, root), gate})
    await expect(source.send(session, turn('one', '看看'), signal())).rejects.toThrow('把关异常')
    expect(h.calls[0]!.methods).toContain('turn/interrupt')
    const stored = JSON.parse(readFileSync(journalOf(root, session), 'utf8')).turns[0]
    expect(stored).toMatchObject({state: 'unknown', failure: expect.stringContaining('touch probe.txt')})
    expect(source.execution!(session, 'd1').commands.map(c => [c.command, c.unfinished ?? false])).toEqual([
      ["/bin/bash -lc 'ls'", false], ["/bin/bash -lc 'touch probe.txt'", true]])
    gate.dispose()
    source.dispose()
  })

  it('keeps a Codex turn running when the hook runs but a reported command does not match its ask (heredocs, escapes)', async () => {
    const root = temp(), gate = gated(root, () => 'ask')
    const heredoc = "cat > note.mjs <<'JS'\nconsole.log(\"a\\\\b\")\nJS"
    const h = host(async (spec, _prompt, io) => {
      await gate.decide({token: spec.env![GATE_TOKEN_ENV], tool_name: 'Bash', tool_input: {command: 'ls'}, cwd: spec.cwd})
      io.say({type: 'item.started', item: {id: 'c0', type: 'command_execution', command: "/bin/bash -lc 'ls'"}})
      io.say({type: 'item.completed', item: {id: 'c0', type: 'command_execution', command: "/bin/bash -lc 'ls'", exit_code: 0}})
      // The hook was asked about the heredoc, but the tool reports it with different quoting.
      await gate.decide({token: spec.env![GATE_TOKEN_ENV], tool_name: 'Bash', tool_input: {command: heredoc}, cwd: spec.cwd})
      io.say({type: 'item.started', item: {id: 'c1', type: 'command_execution', command: '/bin/bash -lc "' + heredoc + ' # reported differently"'}})
      io.say({type: 'item.completed', item: {id: 'c1', type: 'command_execution', command: '/bin/bash -lc "' + heredoc + ' # reported differently"', exit_code: 0}})
      io.say({type: 'item.completed', item: {id: 'm1', type: 'agent_message', text: '写好了'}})
      io.say({type: 'turn.completed'})
      return 0
    })
    const source = createV2DialogueSource({...options(h.ctx, root), gate})
    await source.send(session, turn('one', '写个脚本'), signal())
    expect(h.calls[0]!.methods).not.toContain('turn/interrupt')
    const stored = JSON.parse(readFileSync(journalOf(root, session), 'utf8')).turns[0]
    expect(stored.state).toBe('done')
    expect(stored.failure).toBeUndefined()
    const commands = source.execution!(session, 'd1').commands
    expect(commands.find(c => c.command === "/bin/bash -lc 'ls'")).toMatchObject({decision: 'auto'})
    expect(commands.find(c => c.command === "/bin/bash -lc 'ls'")?.unmatched).toBeUndefined()
    expect(commands.find(c => c.command.startsWith('/bin/bash -lc "cat'))).toMatchObject({unmatched: true, exitCode: 0})
    gate.dispose()
    source.dispose()
  })

  it('passes the hook to Claude Code through --settings', async () => {
    const root = temp()
    const gate = gated(root, () => undefined)
    const h = host((_spec, _prompt, {say}) => { say({type:'result', subtype:'success', is_error:false, num_turns:1, result:'好了', session_id:'cc-1'}); return 0 })
    const source = createV2DialogueSource({...options(h.ctx, root), gate})
    await source.send(claudeSession, turn('one', '看看'), signal())
    const argv = h.calls[0]!.spec.argv
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!)
    expect(settings.hooks.PreToolUse[0]).toMatchObject({matcher:'*', hooks:[{type:'command', timeout:1890}]})
    // A project or user `disableAllHooks` must not switch the gate off.
    expect(settings.disableAllHooks).toBe(false)
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(/^\/usr\/bin\/node .*hook\.js$/)
    expect(argv).toContain('bypassPermissions')
    gate.dispose()
    source.dispose()
  })

  it('never pairs a refused attempt with a later run of the same command text', () => {
    const root = temp(), path = join(root, 'commands.jsonl')
    const gateLine = (id: string, decision: 'rejected' | 'allowed', at: string) => ({kind:'gate' as const, id, turnId:'t1', workOrderId:'d1', at, tool:'Bash',
      command:'rm probe.txt', cwd:root, risk:'high' as const, tier:'ask' as const, decision, by:'owner', reason:decision})
    appendCommandLog(path, gateLine('g1', 'rejected', '2026-11-20T10:00:00.000Z'))
    appendCommandLog(path, gateLine('g2', 'allowed', '2026-11-20T10:01:00.000Z'))
    appendCommandLog(path, {kind:'command', id:'c1', itemId:'item_3', turnId:'t1', workOrderId:'d1', at:'2026-11-20T10:01:01.000Z', tool:'shell',
      command:"/bin/bash -lc 'rm probe.txt'", cwd:root, endedAt:'2026-11-20T10:01:02.000Z', exitCode:0})
    const {commands} = readCommandLog(path, 'd1')
    expect(commands.map(c => [c.decision, c.exitCode])).toEqual([['rejected', undefined], ['allowed', 0]])
    // A declined report of the refused attempt still lands on the refusal.
    appendCommandLog(path, gateLine('g3', 'rejected', '2026-11-20T10:02:00.000Z'))
    appendCommandLog(path, {kind:'command', id:'c2', itemId:'item_4', turnId:'t1', workOrderId:'d1', at:'2026-11-20T10:02:01.000Z', tool:'shell',
      command:"/bin/bash -lc 'rm probe.txt'", cwd:root, endedAt:'2026-11-20T10:02:01.000Z', exitCode:null, failed:true})
    expect(readCommandLog(path, 'd1').commands.map(c => [c.decision, c.exitCode, c.failed ?? false])).toEqual([['rejected', undefined, false], ['allowed', 0, false], ['rejected', null, true]])
  })

  it('does not start the tool when the hook script is missing', async () => {
    const root = temp()
    const gate = gated(root, () => undefined)
    rmSync(join(root, 'hook.js'))
    const h = host(() => 0)
    const source = createV2DialogueSource({...options(h.ctx, root), gate})
    await expect(source.send(session, turn('one', '看看'), signal())).rejects.toMatchObject({dispatched:false, message:expect.stringContaining('钩子缺失')})
    expect(h.calls).toHaveLength(0)
    gate.dispose()
    source.dispose()
  })
})

describe('owner words during a running coding turn', () => {
  it('steers Codex with turn/steer in the same turn and records the words as delivered', async () => {
    const root = temp(), running = Promise.withResolvers<void>()
    const h = host(async (_spec, _prompt, io) => {
      io.say({type: 'item.started', item: {id: 'c0', type: 'command_execution', command: 'sleep 20'}})
      await new Promise(resolve => setTimeout(resolve, 20))
      running.resolve()
      const words = await io.nextSteer()
      io.say({type: 'item.completed', item: {id: 'c0', type: 'command_execution', command: 'sleep 20', exit_code: 0}})
      io.say({type: 'item.completed', item: {id: 'm', type: 'agent_message', text: '按新要求：' + words.split('\n').at(-1)}})
      io.say({type: 'turn.completed'})
      return 0
    })
    const source = createV2DialogueSource(options(h.ctx, root))
    const sent = source.send(session, turn('one', '写周报'), signal())
    await running.promise
    expect(await source.interject!(session, 'another-turn', {id: 'w0', text: '无关', workOrderId: 'd1'})).toBe('rejected')
    expect(await source.interject!(session, 'one', {id: 'w1', text: '改用表格输出', workOrderId: 'd1'})).toBe('steered')
    await sent
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.methods.filter(m => m === 'turn/steer')).toHaveLength(1)
    expect(h.calls[0]!.steers).toEqual([OWNER_LABEL + '改用表格输出'])
    expect(source.interjections!(session, 'one')).toEqual([{id: 'w1', delivered: true}])
    expect((await source.read(session)).messages.map(m => [m.author, m.text, m.delivery])).toEqual([
      ['你', '写周报', undefined], ['你', '改用表格输出', 'steered'], ['Codex', '按新要求：' + OWNER_LABEL + '改用表格输出', undefined]])
    // A finished turn takes nothing more.
    expect(await source.interject!(session, 'one', {id: 'w2', text: '再改', workOrderId: 'd1'})).toBe('rejected')
    source.dispose()
  })

  it('hands Codex words back when the app server has no active turn to steer, so the host can queue them', async () => {
    const root = temp(), running = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const h = host(async (_spec, _prompt, io) => {
      await new Promise(resolve => setTimeout(resolve, 20))
      running.resolve()
      await release.promise
      io.say({type: 'turn.completed'})
      return 0
    }, {refuseSteer: true})
    const source = createV2DialogueSource(options(h.ctx, root))
    const sent = source.send(session, turn('one', '写周报'), signal())
    await running.promise
    const words = {id: 'w1', text: '改用表格输出', workOrderId: 'd1'}
    expect(await source.interject!(session, 'one', words)).toBe('rejected')
    expect(h.calls[0]!.methods).toContain('turn/steer')
    release.resolve()
    await sent
    expect(source.interjections!(session, 'one')).toEqual([{id: 'w1', delivered: false}])
    source.markInterjection!(session, words, 'queued')
    expect((await source.read(session)).messages.find(m => m.text === '改用表格输出')?.delivery).toBe('queued')
    source.dispose()
  })

  it('keeps Claude Code input open until every written message was taken, so late words still join the same turn', async () => {
    const root = temp(), running = Promise.withResolvers<void>()
    const h = host(async (_spec, _prompt, io) => {
      io.say({type: 'system', subtype: 'init', session_id: 'cc-1'})
      await new Promise(resolve => setTimeout(resolve, 20))
      running.resolve()
      const words = await io.nextSteer()
      // The model ends its current step before reading the new words.
      io.say({type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: '第一版完成。'})
      io.take()
      io.say({type: 'assistant', uuid: 'a2', message: {id: 'm2', content: [{type: 'text', text: '收到：' + words.split('\n').at(-1)}]}})
      io.say({type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: '收到：' + words.split('\n').at(-1)})
      io.linger()
      return 0
    })
    const source = createV2DialogueSource(options(h.ctx, root))
    const sent = source.send(claudeSession, turn('one', '写周报'), signal())
    await running.promise
    expect(await source.interject!(claudeSession, 'one', {id: 'w1', text: '改用表格输出', workOrderId: 'd1'})).toBe('pending')
    await sent
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.steers).toEqual([OWNER_LABEL + '改用表格输出'])
    expect(source.interjections!(claudeSession, 'one')).toEqual([{id: 'w1', delivered: true}])
    const messages = (await source.read(claudeSession)).messages
    expect(messages.map(m => m.text)).toEqual(['写周报', '改用表格输出', '第一版完成。', '收到：' + OWNER_LABEL + '改用表格输出'])
    expect(messages[1]!.delivery).toBe('steered')
    expect(await source.interject!(claudeSession, 'one', {id: 'w2', text: '太晚了', workOrderId: 'd1'})).toBe('rejected')
    source.dispose()
  })

  it('reports Claude Code words the model never took before the process ended as not delivered', async () => {
    const root = temp(), running = Promise.withResolvers<void>()
    const h = host(async (_spec, _prompt, io) => {
      io.say({type: 'system', subtype: 'init', session_id: 'cc-1'})
      await new Promise(resolve => setTimeout(resolve, 20))
      running.resolve()
      await io.nextSteer()
      io.say({type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: '完成。'})
      return 0
    })
    const source = createV2DialogueSource(options(h.ctx, root))
    const sent = source.send(claudeSession, turn('one', '写周报'), signal())
    await running.promise
    expect(await source.interject!(claudeSession, 'one', {id: 'w1', text: '改用表格输出', workOrderId: 'd1'})).toBe('pending')
    await sent
    expect(source.interjections!(claudeSession, 'one')).toEqual([{id: 'w1', delivered: false}])
    expect(JSON.parse(readFileSync(journalOf(root, claudeSession), 'utf8')).turns[0]).toMatchObject({state: 'done'})
    source.dispose()
  })
})
