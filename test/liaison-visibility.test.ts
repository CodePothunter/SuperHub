import { describe, expect, it } from 'vitest'
import { hasRawConnectorHistory, LiaisonToolVisibility, liaisonGuard } from '../src/dsh/liaison.ts'
import type { Agent, LlmToolRequest, Tools } from '../src/dsh/ports.ts'

function fixture() {
  const globals = new Set(['ask_user_question', 'remote_create_session', 'job_list', 'chief_brief', 'read'])
  const own = new Map<string, Set<string>>()
  const masks = new Map<string, Set<string>>()
  const calls: string[] = []
  const tools = {
    schemas: (scope?: unknown) => [...globals].filter(name => !scope || !masks.get((scope as Agent).id)?.has(name))
      .concat(scope ? [...(own.get((scope as Agent).id) ?? [])] : []).map(name => ({ name })),
    get: (name: string) => globals.has(name) ? {} : undefined,
  } as unknown as Tools
  const agent = (id: string): Agent => {
    own.set(id, new Set(['bash', 'write', 'edit']))
    masks.set(id, new Set())
    return { id, ctx: { tools: { restrict: ({ deny = [] }) => {
      calls.push(`${id}:${deny.join(',')}`)
      if (deny.includes('ask_user_question')) throw new Error('host rejects this one name')
      for (const name of deny) masks.get(id)!.add(name)
      return () => { for (const name of deny) masks.get(id)!.delete(name) }
    } } } }
  }
  const policy = new LiaisonToolVisibility(tools, id => id === 'hq' || id === 'hq-p2')
  return { globals, tools, policy, agent, calls }
}

describe('接口人工具可见性诊断', () => {
  it('仅当模型适配器可以从旧会话声明重新投影原始 MCP 工具时才迁移该段', () => {
    const connector = { name:'mcp__calendar__update_event' }
    expect(hasRawConnectorHistory(undefined)).toBe(false)
    expect(hasRawConnectorHistory({tools:[{name:'chief_calendar'}], updates:[]})).toBe(false)
    expect(hasRawConnectorHistory({tools:[connector], updates:[]})).toBe(true)
    expect(hasRawConnectorHistory({tools:[], updates:[{additions:[connector]}]})).toBe(true)
  })
  it('逐名遮住实际全局工具；一个名字失败不妨碍其余远程和后台任务工具', () => {
    const f = fixture()
    f.policy.attach(f.agent('hq'))
    const status = f.policy.status(true, 'available')
    expect(f.calls).toEqual(['hq:ask_user_question', 'hq:job_list', 'hq:remote_create_session'])
    expect(status.sessions[0]).toMatchObject({ maskedGlobal: ['job_list', 'remote_create_session'], maskFailed: ['ask_user_question'], registeredDenied: ['ask_user_question', 'bash', 'edit', 'write'] })
    expect(status.sessions[0]).not.toHaveProperty('requestDenied')
    expect(status.boundary).toBe('llm/stream-before-adapter')
  })

  it('新注册的整类工具也遮住；换段使用同一策略；子代理和其他会话不受限制', () => {
    const f = fixture()
    f.policy.attach(f.agent('hq'))
    f.policy.attach(f.agent('hq-p2'))
    f.policy.attach(f.agent('worker'))
    f.globals.add('remote_copy_file')
    f.globals.add('mcp__calendar__create_event')
    f.globals.add('job_output')
    f.policy.refresh()
    expect(f.calls).toContain('hq:remote_copy_file')
    expect(f.calls).toContain('hq:mcp__calendar__create_event')
    expect(f.calls).toContain('hq-p2:job_output')
    expect(f.calls.some(call => call.startsWith('worker:'))).toBe(false)
    expect(f.policy.status(true, 'available').sessions.map(row => row.sessionId)).toEqual(['hq', 'hq-p2'])
  })

  it('观察已注入的声明及历史，不改冻结请求、不读取对话或把注册表成功当成最终请求成功', () => {
    const f = fixture()
    f.policy.attach(f.agent('hq'))
    const tools = Object.freeze([{ name: 'bash' }, { name: 'remote_create_session' }, { name: 'chief_brief' }])
    const history = Object.freeze({ tools: Object.freeze([{ name: 'write' }]), updates: Object.freeze([{ additions: Object.freeze([{ name: 'job_output' }]) }]) })
    const request = Object.freeze({ sessionId: 'hq', tools, toolHistory: history,
      get messages(): never { throw new Error('must never read conversation') } })
    f.policy.observe(request)
    expect(request.tools).toBe(tools)
    expect(request.toolHistory).toBe(history)
    expect(f.policy.status(true, 'available').sessions[0]).toMatchObject({
      requestDenied: ['bash', 'remote_create_session'], historyDenied: ['job_output', 'write'],
    })
    f.policy.observe({ sessionId: 'worker', tools, toolHistory: history } as LlmToolRequest)
    expect(f.policy.status(true, 'available').sessions).toHaveLength(1)
  })

  it('释放只撤销自己安装的遮蔽，随后不再观察请求或注册限制', () => {
    const f = fixture(), agent = f.agent('hq')
    f.policy.attach(agent)
    expect(f.tools.schemas!(agent).some(tool => tool.name === 'job_list')).toBe(false)
    f.policy.dispose()
    expect(f.tools.schemas!(agent).some(tool => tool.name === 'job_list')).toBe(true)
    f.policy.attach(agent)
    f.policy.observe({ sessionId: 'hq', tools: [{ name: 'bash' }] })
    expect(f.policy.status(true, 'available').sessions).toEqual([])
  })

  it('执行拦截继续覆盖各段的全部后台任务工具，幕僚可以照常使用', () => {
    const guard = liaisonGuard(id => id === 'hq' || id === 'hq-p2')
    expect(guard({ name: 'job_list', agent: { id: 'hq' } })).toContain('chief_inbox')
    expect(guard({ name: 'job_future', agent: { id: 'hq-p2' } })).toContain('chief_inbox')
    expect(guard({ name: 'job_list', agent: { id: 'worker' } })).toBeUndefined()
    expect(guard({ name: 'mcp__calendar__create_event', agent: { id: 'hq' } })).toContain('已授权')
    expect(guard({ name: 'chief_calendar', agent: { id: 'hq' } })).toBeUndefined()
    expect(guard({ name: 'mcp__calendar__list_events' })).toBeUndefined()
  })
})
