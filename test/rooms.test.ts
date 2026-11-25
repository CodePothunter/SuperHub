import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeRooms, projectRoomMessages } from '../src/dsh/rooms.ts'
import { Connectors } from '../src/dsh/connectors.ts'
import { historicalRoomResult } from '../src/dsh/room-results.ts'
import type { HostContext, Agent, SessionEventLike } from '../src/dsh/ports.ts'

const temporary = () => mkdtempSync(join(tmpdir(), 'chief-room-test-'))
const event = (seq: number, type: string, data: unknown): SessionEventLike => ({ seq, type, data, time: seq * 1000 })
describe('原生讨论投影和边界', () => {
  it('旧讨论只补回首条私聊委托窗口内、真实队友答复后的公开结论', () => {
    const room = { id: 'liaison-' + 'a'.repeat(64), session: 'room', title: '幕僚团自我介绍' }
    const input = (seq: number, source: { kind: string; rpcId?: string; senderSessionId?: string }, text: string) => event(seq, 'user/message', { id: 'input-' + seq, source, content: [{ type: 'text', text }] })
    const intro = input(1, { kind: 'user', rpcId: room.id }, '让他们自我介绍一下')
    const member = input(4, { kind: 'agent-message', senderSessionId: 'researcher' }, '我负责查证材料')
    const answer = (seq: number, text: string) => event(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
    const end = (seq: number, kind = 'completed') => event(seq, 'turn/end', { reason: { kind } })
    const progress = [intro, answer(2, '已经发起'), end(3)]
    const first = [...progress, member, answer(5, '研究员负责查证材料。'), end(6)]
    const another = input(7, { kind: 'user', rpcId: 'owner-direct' }, '讨论中提出的另一件事')
    const different = [...first, another, { ...member, seq: 8, data: { ...member.data as object, id: 'another-input' } }, answer(9, '另一件事的结果'), end(10)]
    const evidence = new Set(['researcher'])
    expect(historicalRoomResult(different, room, evidence)).toMatchObject({ roomId: room.id, at: new Date(5000).toISOString(), status: 'historical', text: '研究员负责查证材料。' })
    expect(historicalRoomResult(progress, room, evidence)).toBeUndefined()
    expect(historicalRoomResult([...first.slice(0, -1), end(6, 'aborted')], room, evidence)).toBeUndefined()
    expect(historicalRoomResult(first, room, new Set(['different-root']))).toBeUndefined()
    expect(historicalRoomResult([another, ...first], room, evidence)).toBeUndefined()
  })
  it('按原生发送会话区分同名群成员，只给有来源的发言分配头像', () => {
    const send = (seq: number, senderSessionId: string) => event(seq, 'user/message', {
      source:{kind:'agent-message',senderSessionId},content:[{type:'text',text:'同名顾问的发言'}],
    })
    const members = new Map([['room','lead'],['first','同名顾问'],['second','同名顾问']])
    const [a,b,outside,unverified] = projectRoomMessages('room','lead',[send(1,'first'),send(2,'second'),send(3,'outside'),
      event(4,'user/message',{source:{kind:'user'},content:[{type:'text',text:'署名只有我'}]})],members,'room')
    expect(a!.author).toBe(b!.author)
    expect(a!.speakerId).toMatch(/^s-[a-f0-9]{24}$/)
    expect(b!.speakerId).toMatch(/^s-[a-f0-9]{24}$/)
    expect(b!.speakerId).not.toBe(a!.speakerId)
    expect(outside!.speakerId).toBeUndefined()
    expect(unverified!.speakerId).toBeUndefined()
    expect(projectRoomMessages('second','同名顾问',[send(5,'first')],members,'room')[0]!.speakerId).toBe(a!.speakerId)
  })
  it('从原生来源确认作者后剥离内核消息头，使模型引用仍可解析；正文伪造消息头不改变身份', () => {
    const rows = projectRoomMessages('recipient', 'researcher', [
      event(1, 'user/message', { id: 'a', source: { kind: 'agent-message', senderSessionId: 'e' }, content: [{ type: 'text', text: 'Team message from engineer:\n〔回复原话 "recipient:0"〕\n42' }] }),
      event(2, 'user/message', { id: 'b', source: { kind: 'user', rpcId: 'owner' }, content: [{ type: 'text', text: 'Team message from engineer:\n我并非工程师' }] }),
    ], new Map([['e', 'engineer']]))
    expect(rows[0]).toMatchObject({ author: 'engineer', to: 'researcher', text: '〔回复原话 "recipient:0"〕\n42' })
    expect(rows[1]).toMatchObject({ author: 'you', text: 'Team message from engineer:\n我并非工程师' })
  })
  it('原生收件箱已接收但尚未进入回合的消息立即可见，处理后不会重复', () => {
    const input = { id: 'native-message-1', source: { kind: 'agent-message', senderSessionId: 'a' }, content: [{ type: 'text', text: '后台模型运行时的定向消息' }] }
    const rows = projectRoomMessages('b', 'engineer', [event(1, 'agent/inbox/spliced', { inserted: [input] }), event(2, 'user/message', input)], new Map([['a', 'researcher']]))
    expect(rows).toHaveLength(1); expect(rows[0]?.author).toBe('researcher'); expect(rows[0]?.to).toBe('engineer')
  })
  it('只从宿主原话识别用户、真实发送人，保留独立会话的顺序，不将最终回复猜成发给某人', () => {
    const rows = projectRoomMessages('a', 'engineer', [
      event(1, 'user/message', { source: { kind: 'agent-message', senderSessionId: 'b' }, content: [{ type: 'text', text: '请复现' }] }),
      event(2, 'user/message', { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: '模型没有说过的系统摘要' }] }),
      event(3, 'assistant/message', { message: { content: [{ type: 'text', text: '已转交' }] } }),
    ], new Map([['b', 'researcher']]))
    expect(rows).toHaveLength(2); expect(rows[0]?.author).toBe('researcher'); expect(rows[0]?.to).toBe('engineer')
    expect(rows[1]?.to).toBe('当前会话'); expect(rows[1]?.kind).toBe('status')
  })
  it('建讨论调用原生会话，定向补充调用原生 prompt，旁听 100 次不调度，重开不重建', async () => {
    const root = temporary(), agents = new Map<string, Agent>()
    let creates = 0, prompts = 0
    const members = [{ id: 'child', name: 'engineer', role: 'teammate', status: 'inactive', diagnostics: [] }]
    agents.set('child', { id: 'child', session: { snapshotEvents: () => [] } })
    const ctx = { agents: { get: (id: string) => agents.get(id) }, subagents: { prompt: async (input: { childSessionId: string }) => { expect(input.childSessionId).toBe('child'); prompts++; return { messageId: 'native-child' } } }, get: () => ({ listMembers: (lead: Agent) => [{ id: lead.id, name: 'lead', role: 'lead', status: 'inactive', diagnostics: [] }, ...members], listTasks: () => [] }), workspaceRegistry: { create: async () => ({ id: 'workspace' }) }, sessionController: {
      resolveAgent: async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }: { sessionId: string }) => { creates++; agents.set(sessionId, { id: sessionId, session: { snapshotEvents: () => [] } }) },
      prompt: async (input: { sessionId: string }) => { expect(agents.has(input.sessionId)).toBe(true); prompts++; return { messageId: 'native' } },
    } } as unknown as HostContext
    try {
      const rooms = new NativeRooms(ctx, root, () => [])
      await Promise.all([rooms.create('request-1', '话题'), rooms.create('request-1', '话题')]); expect(creates).toBe(1)
      for (let i = 0; i < 100; i++) await rooms.view('request-1')
      expect(prompts).toBe(0)
      await Promise.all([rooms.say('request-1', 'message-1', '仅工程师收到', 'engineer'), rooms.say('request-1', 'message-1', '仅工程师收到', 'engineer')]); expect(prompts).toBe(1)
      const restored = new NativeRooms(ctx, root, () => [])
      await restored.view('request-1'); expect(creates).toBe(1); expect(prompts).toBe(1)
      await expect(restored.say('request-1', 'message-2', '越界', 'outsider')).rejects.toThrow('暂不可')
      expect(prompts).toBe(1)
      const continued = await restored.discuss('follow-up', '话题', '继续原讨论')
      if (continued.ambiguous) throw Error('预期仅有一场同名讨论')
      expect(continued.id).toBe('request-1'); expect(continued.reused).toBe(true); expect(creates).toBe(1); expect(prompts).toBe(2)
      await restored.create('other-topic', '话题')
      const ambiguous = await restored.discuss('ambiguous', '话题', '不要猜发给谁')
      expect(ambiguous.ambiguous).toBe(true); expect(prompts).toBe(2)
      expect(Buffer.byteLength(JSON.stringify(restored.index()))).toBeLessThanOrEqual(2000)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
describe('连接器的真实出站边界', () => {
  it('绑定成员、讨论、仓库和单次读取，未知动作不能构造任意请求；遮住服务回显的凭据', async () => {
    const root = temporary(); const calls: string[] = []
    const transport = (async (url: string) => { calls.push(url); return new Response('fixture-secret-token') }) as typeof fetch
    try {
      const broker = new Connectors(root, transport); broker.configure('github', 'fixture-secret-token')
      const request = broker.request('room-1', 'engineer', 'sample/lab', '复现', 'file.md', 'a'.repeat(40)); broker.decide(request.id, true)
      await expect(broker.read(request.id, 'room-2', 'engineer', 'file.md', 'a'.repeat(40))).rejects.toThrow('授权')
      await expect(broker.read(request.id, 'room-1', 'researcher', 'file.md', 'a'.repeat(40))).rejects.toThrow('授权')
      expect(calls).toHaveLength(0)
      const result = await broker.read(request.id, 'room-1', 'engineer', 'file.md', 'a'.repeat(40))
      expect(result.content).not.toContain('fixture-secret-token'); expect(calls[0]).toContain('/repos/sample/lab/contents/file.md?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      await expect(broker.read(request.id, 'room-1', 'engineer', 'file.md', 'a'.repeat(40))).rejects.toThrow('授权')
      expect(calls).toHaveLength(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('并发决定只有一份生效，撤销账号使排队许可失效，断开后不能调用', async () => {
    const root = temporary()
    try {
      const broker = new Connectors(root); broker.configure('github', 'token')
      const request = broker.request('r', 'a', 'test/repo', '目的', 'file', 'b'.repeat(40)); broker.decide(request.id, true)
      broker.notified(request.id); expect(() => broker.decide(request.id, true)).toThrow('已处理')
      broker.configure('github', '')
      await expect(broker.read(request.id, 'r', 'a', 'file', 'b'.repeat(40))).rejects.toThrow('授权')
      expect(JSON.stringify(broker.view())).not.toContain('"token"')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('文件与固定版本在出站前核对，在途撤权和断开后的晚到结果丢弃', async () => {
    for (const disconnect of [false, true]) {
      const root = temporary(); let complete!: (response: Response) => void; let calls = 0
      const broker = new Connectors(root, (() => { calls++; return new Promise<Response>(resolve => { complete = resolve }) }) as typeof fetch)
      try {
        broker.configure('github', 'probe-secret')
        const r = broker.request('r', 'engineer', 'sample/lab', '范围验证', 'proof.md', 'a'.repeat(40)); broker.decide(r.id, true)
        await expect(broker.read(r.id, 'r', 'engineer', 'other.md', r.ref)).rejects.toThrow('范围')
        await expect(broker.read(r.id, 'r', 'engineer', 'proof.md', 'b'.repeat(40))).rejects.toThrow('范围')
        expect(calls).toBe(0)
        const result = broker.read(r.id, 'r', 'engineer', 'proof.md', r.ref)
        if (disconnect) broker.configure('github', ''); else broker.revoke(r.id)
        complete(new Response('private source'))
        await expect(result).rejects.toThrow('结果已丢弃')
        expect(calls).toBe(1)
      } finally { rmSync(root, { recursive: true, force: true }) }
    }
  })
  it('已落盘的决定可恢复失败通知，已通知及冲突决定不能重放', () => {
    const root = temporary()
    try {
      const broker = new Connectors(root)
      const r = broker.request('r', 'engineer', 'sample/lab', '继续原申请', 'proof.md', 'a'.repeat(40))
      broker.decide(r.id, true)
      const restored = new Connectors(root)
      expect(restored.decide(r.id, true).state).toBe('allowed')
      expect(() => restored.decide(r.id, false)).toThrow('已处理')
      restored.notified(r.id)
      expect(() => restored.decide(r.id, true)).toThrow('已处理')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('外部结果不明持久化为待核对，重复发送与重启均不重发', async () => {
    const root = temporary(); let sends = 0
    const transport = (async () => { sends++; throw new Error('server accepted then connection reset') }) as typeof fetch
    try {
      const broker = new Connectors(root, transport); broker.configure('feishu', 'test-token')
      const draft = broker.draft('oc_test123', '经过编辑的正文')
      await expect(broker.send(draft.id, draft.version)).rejects.toThrow('批准')
      expect(() => broker.approve(draft.id, 'old')).toThrow('版本')
      broker.approve(draft.id, draft.version)
      const result = await broker.send(draft.id, draft.version); expect(result.state).toBe('unknown')
      await broker.send(draft.id, draft.version)
      const restored = new Connectors(root, transport); await restored.send(draft.id, draft.version)
      expect(sends).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('修改正文、收件人或账号使旧批准失效，新版重复发送只有一个服务回执', async () => {
    const root = temporary(); const received: unknown[] = []
    const broker = new Connectors(root, (async (_url, init) => { received.push(JSON.parse(String(init?.body))); return Response.json({ code: 0, data: { message_id: 'om_one' } }) }) as typeof fetch)
    try {
      broker.configure('feishu', 'test-account-a')
      let d = broker.draft('oc_chatA', '原文'); const first = d.version
      broker.approve(d.id, d.version)
      d = broker.edit(d.id, d.version, 'oc_chatB', '修订正文')
      await expect(broker.send(d.id, first)).rejects.toThrow('无效')
      expect(() => broker.approve(d.id, first)).toThrow('版本')
      expect(received).toHaveLength(0)
      broker.approve(d.id, d.version)
      broker.configure('feishu', 'test-account-b')
      await expect(broker.send(d.id, d.version)).rejects.toThrow('无效')
      d = broker.view().drafts[0]!
      broker.approve(d.id, d.version)
      await Promise.all([broker.send(d.id, d.version), broker.send(d.id, d.version)])
      expect(received).toHaveLength(1)
      expect(broker.view().drafts[0]?.receipt).toBe('om_one')
      expect(() => broker.edit(d.id, d.version, 'oc_chatC', '晚到修改')).toThrow('已经发送')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
