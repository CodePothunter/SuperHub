import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/dsh/chat.ts'
import { contextTokens, handoffText, knownDeny, leakedTools, liaisonGuard, mergeHistory, nextPartId, rotateLine, SteerCutter, STEER_CUT } from '../src/dsh/liaison.ts'
import { findModel } from '../src/dsh/models.ts'
import type { Agent, Llm, PendingInput } from '../src/dsh/ports.ts'
import { migrateStaffNames } from '../src/dsh/scaffold.ts'
import { SettingsStore } from '../src/dsh/settings.ts'
import { isStaffDescendant } from '../src/dsh/tools.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'chief-liaison-'))

describe('接口人的工具限制', () => {
  it('只限制本机存在的工具：不认识的名字会让 DSH 整体拒绝', () => {
    const registered = new Set(['bash', 'write', 'edit', 'ask_user_question'])
    expect(knownDeny(n => registered.has(n), ['bash', 'subagent_claude_code', 'write', 'workflow'])).toEqual(['bash', 'write'])
  })
  it('查询本身出错的名字不算存在', () => {
    expect(knownDeny(() => { throw new Error('boom') }, ['bash'])).toEqual([])
  })
  it('限制之后还看得见的危险工具要报出来；查不了按泄漏算', () => {
    expect(leakedTools(n => n === 'bash')).toEqual(['bash'])
    expect(leakedTools(() => false)).toEqual([])
    expect(leakedTools(() => { throw new Error('boom') }, ['write'])).toEqual(['write'])
  })
})

describe('插话即时生效', () => {
  /** 一个最小的假 Agent：记录取消和投递，收件箱是两个数组。 */
  function fake() {
    const nextStep: PendingInput[] = [], nextTurn: PendingInput[] = []
    const calls: string[] = []
    const agent = {
      id: 'hq', status: 'running' as const,
      inbox: {
        nextStep, nextTurn,
        remove: (id: string) => { for (const list of [nextStep, nextTurn]) { const i = list.findIndex(m => m.id === id); if (i >= 0) { list.splice(i, 1); return true } } return false },
        prepend: (_t: string, m: never) => { nextTurn.unshift(m as PendingInput) },
      },
      cancel: (cause: { reason: string }, o?: { keepInbox?: boolean }) => { calls.push(`cancel:${cause.reason}:${o?.keepInbox}`) },
      send: (m: never, target: string) => { calls.push(`send:${target}`); nextTurn.push(m as PendingInput) },
    }
    const cutter = new SteerCutter(() => agent as unknown as Agent, fn => fn())
    return { agent, cutter, calls, nextStep, nextTurn }
  }
  const steer = { type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [{ id: 'u1', source: { kind: 'user' } }] } }

  it('模型正在生成时，主人插话：取消这次调用，插话排到下一轮最前面', () => {
    const { cutter, calls, nextStep, nextTurn } = fake()
    nextTurn.push({ id: 'old', source: { kind: 'user' } })
    cutter.observe({ type: 'step/start', data: {} })
    nextStep.push({ id: 'u1', source: { kind: 'user' } })
    cutter.observe(steer)
    expect(calls).toEqual([`cancel:${STEER_CUT}:true`, 'send:next-turn'])
    expect(nextStep).toEqual([])
    expect(nextTurn[0]?.id).toBe('u1')
    expect(cutter.cuts).toBe(1)
  })
  it('工具正在执行时不打断，等这一步做完', () => {
    const { cutter, calls, nextStep } = fake()
    cutter.observe({ type: 'step/start', data: {} })
    cutter.observe({ type: 'assistant/message', data: {} })
    nextStep.push({ id: 'u1', source: { kind: 'user' } })
    cutter.observe(steer)
    expect(calls).toEqual([])
  })
  it('系统消息不算插话；同一步只打断一次', () => {
    const { cutter, calls, nextStep } = fake()
    cutter.observe({ type: 'step/start', data: {} })
    nextStep.push({ id: 's1', source: { kind: 'time-context' } })
    cutter.observe({ type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [{ id: 's1', source: { kind: 'time-context' } }] } })
    expect(calls).toEqual([])
    nextStep.push({ id: 'u1', source: { kind: 'user' } })
    cutter.observe(steer)
    nextStep.push({ id: 'u2', source: { kind: 'user' } })
    cutter.observe(steer)
    expect(cutter.cuts).toBe(1)
  })
  it('步开始时已经有插话在等，也立刻打断', () => {
    const { cutter, nextStep } = fake()
    nextStep.push({ id: 'u1', source: { kind: 'user' } })
    cutter.observe({ type: 'step/start', data: {} })
    expect(cutter.cuts).toBe(1)
  })
})

describe('长对话换段', () => {
  it('换段线：窗口的 60%，有上限；没声明窗口按 128k', () => {
    expect(rotateLine(200_000)).toBe(120_000)
    expect(rotateLine(1_000_000)).toBe(160_000)
    expect(rotateLine(undefined)).toBe(76_800)
  })
  it('用量取最近一次模型回复', () => {
    expect(contextTokens([
      { type: 'assistant/message', data: { usage: { totalTokens: 10 } } },
      { type: 'tool/result', data: {} },
      { type: 'assistant/message', data: { usage: { totalTokens: 97_023 } } },
      { type: 'turn/end', data: {} },
    ])).toBe(97_023)
    expect(contextTokens([])).toBeUndefined()
  })
  it('段号递增', () => {
    expect(nextPartId('chief-liaison-abc')).toBe('chief-liaison-abc-p2')
    expect(nextPartId('chief-liaison-abc-p2')).toBe('chief-liaison-abc-p3')
  })
  it('交接带最近原话和查找方法，不带太早的话', () => {
    const msgs: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({ seq: i, role: i % 2 ? 'liaison' : 'you', text: `第${i}句`, time: i }))
    const text = handoffText('old', msgs, '2026-11-17 10:00')
    expect(text).toContain('chief_lookup')
    expect(text).toContain('主人：第18句')
    expect(text).toContain('你：第19句')
    expect(text).not.toContain('第7句')
  })
  it('历史合并：按时间排序、去重、限条数', () => {
    const a: ChatMessage = { seq: 1, role: 'you', text: '甲', time: 1 }
    const b: ChatMessage = { seq: 1_000_000_001, role: 'liaison', text: '乙', time: 2 }
    expect(mergeHistory([a, b], [b], 80)).toEqual([a, b])
    expect(mergeHistory([a], [b], 1)).toEqual([b])
  })
  it('换段保留同一时刻发出的不同附件，并在交接里指向只读工具', () => {
    const first: ChatMessage = {seq: 1, role: 'you', text: '', time: 1, requestId: 'first',
      inputAttachments: [{id: 'a', name: '图.png', kind: 'image', bytes: 30}]}
    const second: ChatMessage = {seq: 2, role: 'you', text: '', time: 1, requestId: 'second',
      inputAttachments: [{id: 'b', name: '图.png', kind: 'image', bytes: 30}]}
    const messages = mergeHistory([first], [{...first}, second])
    expect(messages).toEqual([first, second])
    expect(handoffText('old', messages, '2026-11-17 10:00')).toContain('附 1 份材料，可用 chief_read_attachment 查看')
  })
  it('之前各段派出的子代理仍然算幕僚，不能冒充主人', () => {
    const sessions: Record<string, { parent?: string; subagent: boolean }> = {
      'hq-p2': { subagent: false }, hq: { subagent: false }, child: { parent: 'hq', subagent: true },
    }
    const lookup = { info: (id: string) => sessions[id] }
    const exec = (id: string) => ({ signal: new AbortController().signal, agent: { id } })
    const isHq = (id: string) => id === 'hq-p2' || id === 'hq'
    expect(isStaffDescendant(exec('child'), isHq, lookup)).toBe(true)
    expect(isStaffDescendant(exec('child'), 'hq-p2', lookup)).toBe(false) // 只认当前段时的漏洞
    expect(isStaffDescendant(exec('hq'), isHq, lookup)).toBe(false)
  })
})

describe('接口人的模型', () => {
  const llm: Llm = {
    listProviders: () => [{ id: 'zhipu', name: '智谱' }, { id: 'deepseek', name: 'DeepSeek' }, { id: 'mirror', name: 'Mirror' }],
    listModels: async p => p === 'zhipu' ? [{ id: 'glm-5.3', name: 'GLM-5.3' }]
      : p === 'deepseek' ? [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'shared', name: 'shared' }]
        : [{ id: 'shared', name: 'shared' }],
    resolveModelInfo: async () => ({}),
  }
  it('只写模型 id 或显示名就能找到厂商', async () => {
    expect(await findModel(llm, 'deepseek-v4.1-flash')).toEqual({ provider: 'deepseek', model: 'deepseek-v4.1-flash' })
    expect(await findModel(llm, 'glm-5.3')).toEqual({ provider: 'zhipu', model: 'glm-5.3' })
    expect(await findModel(llm, 'DeepSeek V4.1 Flash')).toEqual({ provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  })
  it('写了厂商就只在这个厂商里找', async () => {
    expect(await findModel(llm, 'mirror/shared')).toEqual({ provider: 'mirror', model: 'shared' })
  })
  it('重名要求写厂商；找不到时列出可选的', async () => {
    await expect(findModel(llm, 'shared')).rejects.toThrow(/厂商\/模型/)
    await expect(findModel(llm, 'gpt-9')).rejects.toThrow(/可选的有：zhipu\/glm-5.3/)
    await expect(findModel(llm, 'nobody/x')).rejects.toThrow(/没有叫 nobody/)
  })
  it('设置里存 provider/model，空串清掉', () => {
    const store = new SettingsStore(tmp())
    expect(store.update({ liaisonModel: 'deepseek/deepseek-v4.1-flash' }).liaisonModel).toBe('deepseek/deepseek-v4.1-flash')
    expect(store.update({ liaisonModel: '' }).liaisonModel).toBeUndefined()
  })
  it('设置记得换过的段', () => {
    const dir = tmp()
    new SettingsStore(dir).update({ liaison: { session: 'hq-p3', brain: '/b', base: 'hq', parts: ['hq', 'hq-p2'] } })
    expect(new SettingsStore(dir).get().liaison).toEqual({ session: 'hq-p3', brain: '/b', base: 'hq', parts: ['hq', 'hq-p2'] })
  })
})

describe('研判官改名', () => {
  const card = (name: string) => `---\nname: ${name}\nexecutor: dsh\nverifier: none\n---\n负责研判每一条事件。接口人收到的事也在这里研判。\n`
  it('旧名字"接口人"改成"研判官"，正文不动', () => {
    const brain = tmp()
    mkdirSync(join(brain, 'staff'))
    writeFileSync(join(brain, 'staff', 'chief.md'), card('接口人'))
    expect(migrateStaffNames(brain)).toEqual([join('staff', 'chief.md')])
    const text = readFileSync(join(brain, 'staff', 'chief.md'), 'utf8')
    expect(text).toContain('name: 研判官')
    expect(text).toContain('接口人收到的事也在这里研判')
    expect(migrateStaffNames(brain)).toEqual([])
  })
  it('主人自己起过的名字不动；没有卡也不报错', () => {
    const brain = tmp()
    mkdirSync(join(brain, 'staff'))
    writeFileSync(join(brain, 'staff', 'chief.md'), card('参谋长'))
    expect(migrateStaffNames(brain)).toEqual([])
    expect(migrateStaffNames(tmp())).toEqual([])
  })
})

describe('接口人的执行拦截', () => {
  const guard = liaisonGuard(id => id === 'hq' || id === 'hq-p2')
  it('拦接口人各段会话的 bash / write / 子代理', () => {
    expect(guard({ name: 'bash', agent: { id: 'hq' } })).toMatch(/chief_inbox 交给工程师/)
    expect(guard({ name: 'write', agent: { id: 'hq-p2' } })).toMatch(/chief_record/)
    expect(guard({ name: 'spawn_teammate', agent: { id: 'hq' } })).toMatch(/chief_inbox/)
    expect(guard({ name: 'ask_user_question', agent: { id: 'hq' } })).toMatch(/回复里/)
  })
  it('拦 DSH 远程模块的整类工具：不能绕过外务直接操作别的机器', () => {
    expect(guard({ name: 'remote_send_message', agent: { id: 'hq' } })).toMatch(/交给外务/)
    expect(guard({ name: 'remote_create_session', agent: { id: 'hq-p2' } })).toMatch(/交给外务/)
    expect(guard({ name: 'remote_send_message', agent: { id: 'staff-child' } })).toBeUndefined()
  })
  it('幕僚、主人自己的会话、接口人的普通工具不拦', () => {
    expect(guard({ name: 'bash', agent: { id: 'staff-child' } })).toBeUndefined()
    expect(guard({ name: 'bash' })).toBeUndefined()
    expect(guard({ name: 'chief_record', agent: { id: 'hq' } })).toBeUndefined()
    expect(guard({ name: 'read', agent: { id: 'hq' } })).toBeUndefined()
  })
})
