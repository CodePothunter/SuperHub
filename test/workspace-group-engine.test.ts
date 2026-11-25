import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StaffMember } from '../src/core/workspace-staff.ts'
import type { ChatInputAttachment } from '../src/core/chat-attachments.ts'
import { GroupEngine, GROUP_ADMIN_NOTE, GROUP_DELIVERY, linkedGroupFiles, memberIdentity, memberPrompt, type GroupEngineOptions } from '../src/dsh/workspace-group-engine.ts'
import { groupRoster, GroupMemberSessions, LIAISON_MEMBER_ID, type GroupRosterMember, type MemberCall, type MemberCallSink, type MemberReattach, type MemberRunner } from '../src/dsh/workspace-group-members.ts'
import { GROUP_LIMITS, type GroupEffect } from '../src/dsh/workspace-group-scheduler.ts'
import { WorkspaceStaffStore } from '../src/dsh/workspace-staff-store.ts'

const roots: string[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-group-engine-')); roots.push(p); return p }
const engines: GroupEngine[] = []
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

/** A runner whose members answer when the test says so. */
class FakeRunner implements MemberRunner {
  calls: MemberCall[] = []
  sinks = new Map<string, MemberCallSink>()
  continued: { callId: string; text: string }[] = []
  cancelled: string[] = []
  alive = new Set<string>()
  reattached: MemberReattach[] = []
  refuse?: string
  run(call: MemberCall, sink: MemberCallSink) {
    if (this.refuse) return Promise.reject(new Error(this.refuse))
    this.calls.push(call)
    this.sinks.set(call.callId, sink)
    call.group.sessions.setMember(call.member.id, { kind: call.member.kind, cwd: call.group.workDir, session: 'native-' + call.member.id })
    return Promise.resolve()
  }
  continue(callId: string, text: string) { this.continued.push({ callId, text }); return Promise.resolve() }
  cancel(callId: string) { this.cancelled.push(callId) }
  async reattach(call: MemberReattach, sink: MemberCallSink) {
    this.reattached.push(call)
    if (!this.alive.has(call.callId)) return false
    this.sinks.set(call.callId, sink)
    return true
  }
  dispose() {}
  last(memberId: string) {
    const call = this.calls.findLast(row => row.member.id === memberId)
    if (!call) throw new Error(`${memberId} was never called`)
    return { call, sink: this.sinks.get(call.callId)! }
  }
  count(memberId: string) { return this.calls.filter(row => row.member.id === memberId).length }
}

const ROSTER: GroupRosterMember[] = [
  { id: LIAISON_MEMBER_ID, name: '接口人', admin: true, kind: 'dsh' },
  { id: 'eng', name: '工程师', kind: 'codex', brief: '写代码、跑命令', duty: '效果评测' },
  { id: 'res', name: '研究员', kind: 'dsh', duty: '调研' },
  { id: 'adv', name: '谋士', kind: 'dsh', duty: '出主意' },
]

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(options: { dir?: string; roster?: GroupRosterMember[]; dsh?: FakeRunner; codex?: FakeRunner; now?: () => number;
  experience?: GroupEngineOptions['experience'] } = {}) {
  const dir = options.dir ?? temp()
  const dsh = options.dsh ?? new FakeRunner(), codex = options.codex ?? new FakeRunner()
  const effects: GroupEffect[] = []
  let roster = options.roster ?? ROSTER
  const engineOptions: GroupEngineOptions = {
    scope: 'brain', workspaceId: 'w1', groupId: 'g1', dir: join(dir, 'group'), workDir: () => join(dir, 'project'),
    info: () => ({ workspaceName: '方舟评测', goal: '评测方舟模型服务', title: '端点排查' }),
    roster: () => roster, runners: { dsh, codex }, onEffects: rows => effects.push(...rows), experience: options.experience,
    approvals: { pending: filter => [{ id: 'a1', workspaceId: filter.workspaceId!, sessionId: filter.sessionId!, workOrderId: null, turnId: 'c3.1', tool: 'codex', memberId: 'eng',
      command: 'rm -rf build', cwd: dir, reason: '删除文件', requestedAt: '2026-11-24T00:00:00.000Z', expiresAt: '2026-11-24T00:30:00.000Z' }] },
    ...options.now && { now: options.now },
  }
  const engine = new GroupEngine(engineOptions)
  engines.push(engine)
  const lines = () => engine.ledger.all().map(line => `${line.kind}:${line.author}:${line.text}`)
  return { engine, dsh, codex, effects, lines, dir, setRoster: (next: GroupRosterMember[]) => { roster = next } }
}

describe('组装成员可见的经验和群历史', () => {
  it('将成员行关联到实际原生会话的经验版本，并在换成员、撤回和重启后滤掉无范围授权的回放', async () => {
    const dir = temp()
    const store = new WorkspaceStaffStore(dir,'brain',()=>[],()=>{})
    const join = (name: string, requestId: string) => store.apply('w1',{action:'create',name,brief:'团队协作',requestId}).members.find(member=>member.name===name)!
    const lead = join('研究员','lead'), teammate = join('新成员','teammate')
    const roster = [ROSTER[0]!,{id:lead.id,name:lead.name,kind:'dsh' as const},{id:teammate.id,name:teammate.name,kind:'dsh' as const}]
    store.apply('w1',{action:'learn',audience:'shared',text:'检查缓存路径：协作例程',requestId:'shared'})
    store.apply('w1',{action:'learn',staffId:lead.id,text:'检查缓存路径：专属依据',requestId:'private'})
    const local = store.experienceMemories('w1')
    const t = setup({dir,roster,experience:store})
    await t.engine.start()
    t.engine.ownerSay('@研究员 先列公开结果', {workOrderId:'w'})
    const publicWork = t.dsh.last(lead.id)
    expect(publicWork.call.experience?.entries).toEqual([])
    publicWork.sink.finished(publicWork.call.callId,{text:'可传递的普通团队回报',toolCalls:0,status:'completed'})
    t.engine.ownerSay('@研究员 检查缓存路径', {workOrderId:'w'})
    const restricted = t.dsh.last(lead.id)
    expect(restricted.call.experience?.entries.map(row=>row.id).sort()).toEqual(local.map(row=>row.id).sort())
    restricted.sink.finished(restricted.call.callId,{text:'专属资料摘录及其结论',toolCalls:0,status:'completed'})
    expect(t.engine.ledger.all().find(line=>line.text==='专属资料摘录及其结论')?.experienceRefs)
      .toEqual(expect.arrayContaining(local.map(({id,version})=>({id,version}))))
    expect(t.engine.projectLiaisonHistory(t.engine.ledger.all(),t.engine.ledger.lastSeq,'w').map(line=>line.text))
      .not.toContain('专属资料摘录及其结论')

    t.engine.ownerSay('@新成员 检查缓存路径', {workOrderId:'w'})
    const first = t.dsh.last(teammate.id)
    expect(first.call.prompt).toContain('可传递的普通团队回报')
    expect(first.call.prompt).not.toContain('专属资料摘录及其结论')
    first.sink.finished(first.call.callId,{text:'共享经验衍生成果',toolCalls:0,status:'completed'})
    const shared = local.find(row=>row.audience==='shared')!
    store.apply('w1',{action:'retire',audience:'shared',memoryId:shared.id,version:shared.version,requestId:'retire'})
    t.engine.dispose()

    const reopened = setup({dir,roster,experience:store})
    await reopened.engine.start()
    reopened.engine.ownerSay('@研究员 检查缓存路径', {workOrderId:'w'})
    const current = reopened.dsh.last(lead.id).call
    expect(current.recap?.()).toContain('可传递的普通团队回报')
    expect(current.recap?.()).not.toContain('共享经验衍生成果')
    expect(current.recap?.()).not.toContain('专属资料摘录及其结论')
  })

  it('使用主人来源判断共享用途，成员交接文本不能代替授权', async () => {
    const dir = temp()
    const store = new WorkspaceStaffStore(dir,'brain',()=>[],()=>{})
    store.apply('w2',{action:'learn',audience:'shared',text:'续约专用的私有经验',requestId:'source'})
    const [memory] = store.experienceMemories('w2')
    store.apply('w2',{action:'share',audience:'shared',memoryId:memory!.id,sourceVersion:memory!.version,
      targetWorkspaceId:'w1',targetAudience:'shared',text:'续约专用的外区摘要',purpose:'续约',requestId:'grant'})
    const eng = store.apply('w1',{action:'create',name:'工程师',brief:'执行',requestId:'engineer'}).members[0]!
    const t = setup({dir,roster:[ROSTER[0]!,{id:eng.id,name:'工程师',kind:'codex'}],experience:store})
    await t.engine.start()
    t.engine.ownerSay('核对软硬件库存',{workOrderId:'w'})
    const liaison = t.dsh.last('liaison')
    liaison.sink.finished(liaison.call.callId,{text:'@工程师 附带查一下续约',toolCalls:0,status:'completed'})
    const call = t.codex.last(eng.id).call
    expect(call.prompt).toContain('附带查一下续约')
    expect(call.experience?.authorized).toEqual([])
  })

  it('经验撤回后不发布先前缓冲的中途发言', async () => {
    const dir = temp()
    const store = new WorkspaceStaffStore(dir,'brain',()=>[],()=>{})
    const [memory] = store.apply('w1',{action:'learn',audience:'shared',text:'版本缓存需要回归测试',requestId:'learn'}).sharedExperiences!
    let now = Date.now()
    const t = setup({dir,experience:store,roster:[ROSTER[0]!],now:()=>now})
    await t.engine.start()
    t.engine.ownerSay('查询版本缓存',{workOrderId:'w'})
    const {call,sink} = t.dsh.last('liaison')
    expect(call.experience?.entries).toHaveLength(1)
    sink.stepped(call.callId,'第一句已公开中途发言')
    sink.stepped(call.callId,'根据所获经验继续核查的缓冲文字')
    expect(t.engine.ledger.all().map(line=>line.text)).not.toContain('根据所获经验继续核查的缓冲文字')
    store.apply('w1',{action:'retire',audience:'shared',memoryId:memory!.id,version:memory!.version,requestId:'retire'})
    now += GROUP_LIMITS.stepGapMs
    t.engine.tick()
    sink.finished(call.callId,{text:'撤回之后迟到的结果',status:'completed',toolCalls:0})
    expect(t.engine.ledger.all().map(line=>line.text)).not.toContain('根据所获经验继续核查的缓冲文字')
    expect(t.engine.ledger.all().map(line=>line.text)).not.toContain('撤回之后迟到的结果')
    expect(t.lines().some(line=>line.includes('本轮经验授权已变化'))).toBe(true)
  })
})

describe('AC1：主人不 @ → 接口人 @工程师 → 工程师交回 → 接口人只被唤醒一次', () => {
  it('runs the whole relay with the right prompts', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('看一下 arkcli 能不能拿到当前开通的端点', { workOrderId: 'd1' })
    await flush()
    // Only the liaison is called; its prompt has the roster with duties, the notice and the owner's line.
    expect(t.dsh.calls.map(call => call.member.id)).toEqual(['liaison'])
    const liaison = t.dsh.last('liaison')
    expect(liaison.call.workOrderId).toBe('d1')
    expect(liaison.call.prompt).toContain('群成员：主人、工程师（Codex，分工：效果评测）、研究员（分工：调研）、谋士（分工：出主意） 和 你（接口人）。')
    expect(liaison.call.prompt).toContain('群公告：工作区「方舟评测」的目标：评测方舟模型服务；本群：「端点排查」。')
    expect(liaison.call.prompt).toContain('这次：主人发了新消息。')
    expect(liaison.call.prompt).toContain('#1 主人：看一下 arkcli 能不能拿到当前开通的端点')
    expect(liaison.call.identity).toContain(GROUP_ADMIN_NOTE)
    expect(liaison.call.group).toMatchObject({ workspaceId: 'w1', groupId: 'g1', workDir: join(t.dir, 'project'), title: '端点排查' })
    expect(t.engine.ledger.seen('liaison')).toBe(1)

    liaison.sink.finished(liaison.call.callId, { text: '@工程师 请在项目目录用 arkcli 列出当前开通的端点。', status: 'completed', toolCalls: 0 })
    await flush()
    expect(t.codex.calls.map(call => call.member.id)).toEqual(['eng'])
    const eng = t.codex.last('eng')
    expect(eng.call.workOrderId).toBe('d1')
    expect(eng.call.prompt).toContain('这次：接口人 @ 了你。')
    expect(eng.call.prompt).toContain('#2 接口人：@工程师 请在项目目录用 arkcli 列出当前开通的端点。')

    eng.sink.tool(eng.call.callId, { name: 'shell', team: false })
    eng.sink.stepped(eng.call.callId, '我先跑 arkcli endpoint list。')
    eng.sink.finished(eng.call.callId, { text: '当前开通 3 个端点：ep-1、ep-2、ep-3。', status: 'completed', toolCalls: 1 })
    await flush()
    // The batch landed: the liaison is woken exactly once, with the result lines.
    expect(t.effects.filter(effect => effect.type === 'wake')).toEqual([expect.objectContaining({ memberId: 'liaison', done: ['eng'], workOrderId: 'd1' })])
    expect(t.dsh.count('liaison')).toBe(2)
    const woken = t.dsh.last('liaison')
    expect(woken.call.prompt).toContain('这次：工程师 做完了你交代的活，结果见 #3、#4。')
    expect(woken.call.prompt).toContain('群里的新消息（自你上次读后）：\n#3 工程师（进行中）：我先跑 arkcli endpoint list。\n#4 工程师：当前开通 3 个端点：ep-1、ep-2、ep-3。')
    expect(woken.call.prompt).not.toContain('#1 主人')

    woken.sink.finished(woken.call.callId, { text: '工程师查到当前开通 3 个端点：ep-1、ep-2、ep-3。', status: 'completed', toolCalls: 0 })
    await flush()
    expect(t.dsh.count('liaison')).toBe(2)
    expect(t.lines()).toEqual([
      'message:主人:看一下 arkcli 能不能拿到当前开通的端点',
      'message:接口人:@工程师 请在项目目录用 arkcli 列出当前开通的端点。',
      'progress:工程师:我先跑 arkcli endpoint list。',
      'message:工程师:当前开通 3 个端点：ep-1、ep-2、ep-3。',
      'message:接口人:工程师查到当前开通 3 个端点：ep-1、ep-2、ep-3。',
    ])
    expect(t.engine.ledger.all().every(line => line.kind === 'event' || line.workOrderId === 'd1')).toBe(true)
    expect(t.engine.view().members.every(member => member.status === 'idle')).toBe(true)
  })
})

describe('材料沿群里的实际叫人链路传递', () => {
  const first: ChatInputAttachment = {id:'original',name:'@谋士 A.pdf',kind:'file',bytes:7}
  const second: ChatInputAttachment = {id:'update',name:first.name,kind:'file',bytes:9}

  it('新消息各自通过图片限额后，重建会话只对当前消息发原生块，上一版可按授权读取', async () => {
    const t = setup()
    await t.engine.start()
    const a = {...first,kind:'image' as const}, b = {...second,kind:'image' as const}
    t.engine.ownerSay('@研究员 看第一版',{workOrderId:'d1',inputAttachments:[a]})
    await flush()
    const res = t.dsh.last('res')
    res.sink.finished(res.call.callId,{status:'completed',text:'已核对第一版。',toolCalls:1})
    t.engine.ownerSay('@研究员 比较新图',{workOrderId:'d1',inputAttachments:[b]})
    await flush()
    expect(t.dsh.last('res').call.recapInputs).toEqual({inputAttachments:[b],readAttachments:[a]})
  })

  it('管理员把主人发来的材料转给点到的人；另一位未接单成员和另一工单均不重放原件', async () => {
    const t = setup()
    await t.engine.start()
    const source = t.engine.ownerSay('请安排人核对', {workOrderId:'d1',inputAttachments:[first]})
    await flush()
    expect(source.mentions).toEqual([])
    const lead = t.dsh.last('liaison')
    expect(lead.call.inputAttachments).toEqual([first])
    lead.sink.finished(lead.call.callId, {text:'@工程师 请核对原件。',status:'completed',toolCalls:0})
    await flush()
    const eng = t.codex.last('eng')
    expect(eng.call.inputAttachments).toEqual([first])
    expect(eng.call.recapInputs?.inputAttachments).toEqual([first])
    t.engine.ownerSay('@谋士 看本周天气', {workOrderId:'d1'})
    expect(t.dsh.last('adv').call.inputAttachments).toBeUndefined()
    const update = t.engine.say('@工程师 读新版', {workOrderId:'d2',inputAttachments:[second]})
    await expect(update.deliveries[0]!.outcome).resolves.toBe('queued')
    eng.sink.finished(eng.call.callId, {text:'核对完毕。',status:'completed',toolCalls:1})
    await flush()
    expect(t.codex.last('eng').call).toMatchObject({workOrderId:'d2',inputAttachments:[second],recapInputs:{inputAttachments:[second]}})
    expect(t.codex.last('eng').call.prompt).not.toContain('请安排人核对')
  })

  it('同一张图发给两人时，只在拒收成员的投递结果中记录原因；重开群仍可见', async () => {
    const codex = new FakeRunner()
    codex.refuse = '当前模型不支持图片输入'
    const t = setup({codex})
    await t.engine.start()
    const line = t.engine.ownerSay('@研究员 @工程师 看这张图', {inputAttachments:[{...first,kind:'image'}]})
    await flush()
    expect(t.engine.deliveryOf(line.seq)).toEqual(expect.arrayContaining([
      {memberId:'eng',outcome:'failed',detail:expect.stringContaining('不支持图片')}, {memberId:'res',outcome:'started'},
    ]))
    t.engine.dispose()
    const reopened = setup({dir:t.dir})
    await reopened.engine.start()
    expect(reopened.engine.deliveryOf(line.seq)).toEqual(t.engine.deliveryOf(line.seq))
  })
})

describe('AC2：@研究员 @谋士 并行，主人直接叫的不唤醒接口人', () => {
  it('starts both at once and wakes nobody when they finish', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('@研究员 @谋士 各自查一下方舟的计费规则')
    await flush()
    expect(t.dsh.calls.map(call => call.member.id)).toEqual(['res', 'adv'])
    expect(t.dsh.last('res').call.prompt).toContain('同时被叫的还有：谋士（同时回答，在对方发言前看不到彼此的回复）。')
    expect(t.dsh.last('adv').call.prompt).toContain('同时被叫的还有：研究员')
    expect(t.dsh.last('adv').call.prompt).toContain('仍在忙的：研究员（正在答）')
    expect(t.engine.view().members.filter(member => member.status === 'speaking').map(member => member.memberId)).toEqual(['res', 'adv'])
    for (const id of ['res', 'adv']) {
      const { call, sink } = t.dsh.last(id)
      sink.tool(call.callId, { name: 'web_search', team: false })
      sink.finished(call.callId, { text: `${id} 的结论`, status: 'completed', toolCalls: 1 })
    }
    await flush()
    expect(t.dsh.count('liaison')).toBe(0)
    expect(t.effects.filter(effect => effect.type === 'wake')).toEqual([])
  })
})

describe('续推、空转守卫、超时', () => {
  it('「收到，我去查」且 0 工具：续推一次，同一回合', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('@研究员 查一下')
    await flush()
    const { call, sink } = t.dsh.last('res')
    sink.finished(call.callId, { text: '收到，我去排查一下。', status: 'completed', toolCalls: 0 })
    await flush()
    expect(t.dsh.continued).toEqual([{ callId: call.callId, text: expect.stringContaining('没有调用任何工具') }])
    expect(t.lines().at(-1)).toBe('progress:研究员:收到，我去排查一下。')
  })

  it('两位幕僚互相客套 6 次后暂停自动叫人，主人一说话恢复', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('@研究员 跟谋士打个招呼')
    await flush()
    let speaker = 'res'
    for (let i = 0; i < 12 && !t.engine.view().paused; i++) {
      const { call, sink } = t.dsh.last(speaker)
      const other = speaker === 'res' ? '谋士' : '研究员'
      sink.finished(call.callId, { text: `@${other} 好的，收到`, status: 'completed', toolCalls: 0 })
      await flush()
      speaker = speaker === 'res' ? 'adv' : 'res'
    }
    const pausedLine = t.engine.ledger.all().filter(line => line.event === 'paused')
    expect(pausedLine).toHaveLength(1)
    // The pause is explicit in the view: its reason is that line, with when it started and how many calls wait.
    expect(t.engine.view().paused).toEqual({ reason: pausedLine[0]!.text, since: expect.any(Number), parked: 1, seq: pausedLine[0]!.seq })
    expect(pausedLine[0]!.text).toMatch(/^已暂停自动叫人：/)
    // It survives a restart of the engine (the scheduler state keeps the reason).
    const again = setup({ dir: t.dir })
    await again.engine.start()
    expect(again.engine.view().paused).toMatchObject({ reason: pausedLine[0]!.text, parked: 1 })
    again.engine.dispose()
    const before = t.dsh.calls.length
    t.engine.ownerSay('继续，研究员先说结论')
    await flush()
    expect(t.engine.view().paused).toBeUndefined()
    expect(t.dsh.calls.length).toBeGreaterThan(before)
  })

  it('240 秒没动静记超时；有动静就重新计时', async () => {
    let now = 1_000_000
    const t = setup({ now: () => now })
    await t.engine.start()
    t.engine.ownerSay('@研究员 查一下')
    await flush()
    const { call, sink } = t.dsh.last('res')
    now += GROUP_LIMITS.replyTimeoutMs - 1000
    sink.touched(call.callId)
    now += 2000
    t.engine.tick()
    expect(t.engine.ledger.all().some(line => line.event === 'missed')).toBe(false)
    now += GROUP_LIMITS.replyTimeoutMs
    t.engine.tick()
    expect(t.engine.ledger.all().filter(line => line.event === 'missed')).toHaveLength(1)
    expect(t.engine.view().members.find(member => member.memberId === 'res')!.status).toBe('missed')
    // The late answer still lands.
    sink.finished(call.callId, { text: '迟到的结论', status: 'completed', toolCalls: 0 })
    expect(t.lines().at(-1)).toBe('message:研究员:迟到的结论')
  })
})

describe('叫停', () => {
  it('停一位成员：取消它在跑的回合，迟到的上报不入账本；全部停止也一样', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('@工程师 @研究员 跑一下评测')
    await flush()
    const eng = t.codex.last('eng'), res = t.dsh.last('res')
    t.engine.stop('eng')
    expect(t.codex.cancelled).toEqual([eng.call.callId])
    expect(t.lines().at(-1)).toBe('event:SuperHub:主人叫停了 工程师 在本群的工作。')
    eng.sink.finished(eng.call.callId, { text: '跑完了', status: 'cancelled', toolCalls: 0 })
    expect(t.lines().some(line => line.includes('跑完了'))).toBe(false)
    t.engine.stop()
    expect(t.dsh.cancelled).toEqual([res.call.callId])
    expect(t.engine.view().members.every(member => member.status === 'idle')).toBe(true)
  })
})

describe('重启', () => {
  it('仍在跑的回合续上（不重复执行、不写中断），没续上的写中断，排队的照常开始', async () => {
    const dir = temp()
    const first = setup({ dir })
    await first.engine.start()
    first.engine.ownerSay('@研究员 查计费')
    first.engine.ownerSay('@研究员 顺便查配额')
    first.engine.ownerSay('@工程师 跑评测')
    await flush()
    const res = first.dsh.last('res'), eng = first.codex.last('eng')
    res.sink.tool(res.call.callId, { name: 'bash', team: false })
    first.engine.dispose()

    const dsh = new FakeRunner(), codex = new FakeRunner()
    dsh.alive.add(res.call.callId)
    const second = setup({ dir, dsh, codex })
    await second.engine.start()
    await flush()
    expect(dsh.reattached.map(call => [call.callId, call.member.id, call.identity.startsWith('〔群成员身份〕你是「研究员」')])).toEqual([[res.call.callId, 'res', true]])
    expect(codex.reattached.map(call => call.callId)).toEqual([eng.call.callId])
    // The engineer's turn could not be resumed; the researcher's still runs and was not started again.
    expect(second.lines().filter(line => line.startsWith('event:'))).toEqual(['event:SuperHub:工程师 的工作因重启中断了；还需要的话可以让它接着做。'])
    expect(dsh.calls).toHaveLength(0)
    dsh.sinks.get(res.call.callId)!.finished(res.call.callId, { text: '计费按 token。', status: 'completed', toolCalls: 1 })
    await flush()
    expect(second.lines().at(-1)).toBe('message:研究员:计费按 token。')
    // Its queued call starts next, with only the lines it has not seen.
    expect(dsh.calls.map(call => call.member.id)).toEqual(['res'])
    expect(dsh.calls[0]!.prompt).toContain('#2 主人：@研究员 顺便查配额')
    expect(dsh.calls[0]!.prompt).not.toContain('#1 主人')
  })

  it('补读期间运行器报来的结束，在调度器续上之后再处理', async () => {
    const dir = temp()
    const first = setup({ dir })
    await first.engine.start()
    first.engine.ownerSay('@研究员 查计费')
    await flush()
    const res = first.dsh.last('res')
    first.engine.dispose()
    const dsh = new FakeRunner()
    dsh.reattach = async (call, sink) => { sink.finished(call.callId, { text: '不在时做完了', status: 'completed', toolCalls: 2 }); return true }
    const second = setup({ dir, dsh })
    await second.engine.start()
    expect(second.lines()).toEqual(['message:主人:@研究员 查计费', 'message:研究员:不在时做完了'])
    expect(res.call.callId).toBeTruthy()
  })
})

describe('名册、视图与送达失败', () => {
  it('view 带成员状态与本群待批准命令；送达失败记为没能答完', async () => {
    const t = setup()
    await t.engine.start()
    t.codex.refuse = '当前宿主没有可用的 Codex'
    t.engine.ownerSay('@工程师 跑一下')
    await flush()
    await flush()
    expect(t.lines().at(-1)).toMatch(/^event:SuperHub:工程师 没能答完：工程师 没收到：当前宿主没有可用的 Codex/)
    const view = t.engine.view()
    expect(view.members.map(member => [member.memberId, member.name, member.kind, member.admin, member.status])).toEqual([
      ['liaison', '接口人', 'dsh', true, 'idle'], ['eng', '工程师', 'codex', false, 'idle'], ['res', '研究员', 'dsh', false, 'idle'], ['adv', '谋士', 'dsh', false, 'idle']])
    expect(view.approvals).toEqual([expect.objectContaining({ id: 'a1', sessionId: 'g1', memberId: 'eng' })])
    // Each member carries its duty in this workspace (the @ menu needs nothing else).
    expect(view.members.map(member => member.duty)).toEqual([undefined, '效果评测', '调研', '出主意'])
  })

  it('成员在做什么：最近的工具（隐去密钥、截短）和最近的中途发言；回合结束就清掉', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('@工程师 跑一下 arkcli')
    await flush()
    const eng = t.codex.last('eng')
    const secret = 'sk-' + 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z'
    eng.sink.tool(eng.call.callId, { name: 'shell', team: false, detail: `ARK_API_KEY=${secret} arkcli endpoint list\n  --region cn-beijing ` + 'x'.repeat(300) })
    eng.sink.stepped(eng.call.callId, '我先列一下端点，\n稍等。')
    await flush()
    const doing = t.engine.view().members.find(member => member.memberId === 'eng')!
    expect(doing.tool).toMatchObject({ name: 'shell', at: expect.any(Number) })
    expect(doing.tool!.detail).toMatch(/^ARK_API_KEY=‹已隐去› arkcli endpoint list --region cn-beijing x+…$/)
    expect(doing.tool!.detail).not.toContain(secret)
    expect(doing.tool!.detail!.length).toBeLessThanOrEqual(161)
    expect(doing.progress).toMatchObject({ text: '我先列一下端点， 稍等。' })
    eng.sink.finished(eng.call.callId, { text: '列好了', status: 'completed', toolCalls: 1 })
    await flush()
    const after = t.engine.view().members.find(member => member.memberId === 'eng')!
    expect(after.tool).toBeUndefined()
    expect(after.progress).toBeUndefined()
  })

  it('重启后在跑的成员的中途发言从账本补上', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('@研究员 查计费')
    await flush()
    const res = t.dsh.last('res')
    res.sink.tool(res.call.callId, { name: 'bash', team: false, detail: 'curl https://example.com/price' })
    res.sink.stepped(res.call.callId, '正在查官网的价目表')
    res.sink.tool(res.call.callId, { name: 'web_search', team: false, detail: '方舟 计费' })
    await flush()
    t.engine.dispose()
    t.dsh.alive.add(res.call.callId)
    const again = setup({ dir: t.dir, dsh: t.dsh })
    await again.engine.start()
    const member = again.engine.view().members.find(row => row.memberId === 'res')!
    expect(member.status).toBe('speaking')
    expect(member.progress).toMatchObject({ text: '正在查官网的价目表' })
    expect(member.tool).toBeUndefined()
  })

  it('幕僚离开工作区：在跑的回合取消，离群', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('@谋士 想想')
    await flush()
    const adv = t.dsh.last('adv')
    t.setRoster(ROSTER.filter(member => member.id !== 'adv'))
    t.engine.refreshMembers()
    expect(t.dsh.cancelled).toEqual([adv.call.callId])
    expect(t.engine.view().members.map(member => member.memberId)).toEqual(['liaison', 'eng', 'res'])
  })

  it('调度状态原子存盘', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('@研究员 查一下')
    await flush()
    const saved = JSON.parse(readFileSync(join(t.dir, 'group', 'scheduler.json'), 'utf8'))
    expect(saved).toMatchObject({ version: 1, state: { version: 1, calls: [expect.objectContaining({ memberId: 'res', status: 'speaking' })] } })
  })
})

describe('提示与身份', () => {
  it('身份写明分工、经验、管理员说明与群规则', () => {
    const text = memberIdentity({ id: 'eng', name: '工程师', kind: 'codex', brief: '写代码', duty: '效果评测', memories: ['先跑 --help'] }, { workspaceName: '方舟评测', goal: '', title: 't' }, '/p')
    expect(text).toContain('你是「工程师」，在工作区「方舟评测」的群聊里。')
    expect(text).toContain('在本工作区的分工：效果评测')
    expect(text).toContain('- 先跑 --help')
    expect(text).toContain('/p')
    expect(text).not.toContain(GROUP_ADMIN_NOTE)
    // How results reach the owner's 「工单交付」: linked files and a report's first line.
    expect(text).toContain(GROUP_DELIVERY)
    expect(GROUP_DELIVERY).toMatch(/\[名字\]\(相对路径\).*工单回报.*阶段回报/)
  })

  it('重开会话时看最近几行；没有新消息时明说', () => {
    const base = { member: ROSTER[2]!, members: ROSTER, info: { workspaceName: 'w', goal: '', title: 't' }, start: { note: '主人 @ 了你', coAnswering: [] }, results: [], busy: [] }
    expect(memberPrompt({ ...base, lines: [], fresh: false })).toContain('群里没有新消息。')
    expect(memberPrompt({ ...base, lines: [{ seq: 1, at: '', kind: 'event', speakerId: 'host', author: 'SuperHub', text: '已暂停', mentions: [] }], fresh: true }))
      .toContain('群里最近的消息：\n#1 [已暂停]')
  })
})

describe('groupRoster 与 members.json', () => {
  const staff = (id: string, name: string, duty = '', workspaceId = 'w1'): StaffMember => ({ id, name, brief: name + '的职责', memberships: [{ workspaceId, duty }] })
  it('接口人当管理员排第一；执行方式与模型按幕僚卡；远程、叫不到、重名、别的工作区的跳过', () => {
    const roster = groupRoster({ workspaceId: 'w1', liaisonName: '接口人',
      staff: [staff('engineer', '工程师', '效果评测'), staff('researcher', '研究员'), staff('advisor', '谋士'), staff('remote-op', '外务'), staff('x', '@坏名'), staff('dup', '研究员'), staff('other', '别区', '', 'w2'), staff('own', '专属')],
      native: [{ id: 'engineer', executor: 'codex' }, { id: 'researcher', executor: 'dsh', model: 'zhipu/glm-5.3', reasoningEffort: 'high' }, { id: 'advisor', executor: 'dsh' }, { id: 'remote-op', executor: 'remote' }],
      defaults: { liaison: { provider: 'deepseek', model: 'deepseek-v4' }, liaisonPinned: true },
      context: id => id === 'researcher' ? { workspaceId: 'w1', staffId: id, name: '研究员', brief: '调研', duty: '查资料', memories: [{ id: 'm', text: '先看官方文档' }], token: 't' } : undefined })
    expect(roster).toEqual([
      { id: 'liaison', name: '接口人', admin: true, kind: 'dsh', model: { provider: 'deepseek', model: 'deepseek-v4' } },
      { id: 'engineer', name: '工程师', kind: 'codex', brief: '工程师的职责', duty: '效果评测' },
      { id: 'researcher', name: '研究员', kind: 'dsh', brief: '调研', duty: '查资料', memories: ['先看官方文档'], model: { provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'high' }, token: 't' },
      { id: 'advisor', name: '谋士', kind: 'dsh', brief: '谋士的职责', model: { provider: 'deepseek', model: 'deepseek-v4' } },
      { id: 'own', name: '专属', kind: 'dsh', brief: '专属的职责', model: { provider: 'deepseek', model: 'deepseek-v4' } },
    ])
  })

  it('不超过 12 人', () => {
    const many = Array.from({ length: 20 }, (_, i) => staff('s' + i, '幕僚' + i))
    expect(groupRoster({ workspaceId: 'w1', staff: many, native: [], defaults: { liaisonPinned: false } })).toHaveLength(GROUP_LIMITS.maxMembers)
  })

  it('members.json：成员会话与在跑的投递原子存取，重新打开后还在', () => {
    const dir = temp()
    const sessions = new GroupMemberSessions(dir)
    sessions.setMember('eng', { kind: 'codex', cwd: '/p', session: 'thread-1' })
    sessions.setLive('c1', { memberId: 'res', session: 's', request: 'r', push: 1 })
    sessions.advanceLive('c1', 7)
    sessions.advanceLive('c1', 3)
    const reopened = new GroupMemberSessions(dir)
    expect(reopened.member('eng')).toMatchObject({ kind: 'codex', cwd: '/p', session: 'thread-1' })
    expect(reopened.live('c1')).toMatchObject({ memberId: 'res', request: 'r', push: 1, eventSeq: 7 })
    reopened.clearLive('c1')
    expect(new GroupMemberSessions(dir).lives()).toEqual({})
  })
})

/** A runner whose running calls take owner words (`answer` decides each one). */
class SteerRunner extends FakeRunner {
  steered: { callId: string; id: string; text: string }[] = []
  answer: 'steered' | 'pending' | 'rejected' = 'steered'
  steer(callId: string, words: { id: string; text: string }) {
    this.steered.push({ callId, ...words })
    return Promise.resolve(this.answer)
  }
}

describe('主人的话立即送到正在干活的成员（steer）', () => {
  it('被点名的成员在干活：送进它在跑的回合（带它没读过的新行），记已读，不另开一次', async () => {
    const dsh = new SteerRunner()
    const t = setup({ dsh })
    await t.engine.start()
    t.engine.ownerSay('@研究员 查计费')
    await flush()
    const res = t.dsh.last('res')
    t.engine.liaisonSay('研究员在查，别急', { ref: 'n1' })
    const { line, deliveries } = t.engine.say('@研究员 先查包月的', { requestId: 'r2' })
    expect(deliveries.map(row => row.memberId)).toEqual(['res'])
    await expect(deliveries[0]!.outcome).resolves.toBe('steered')
    await flush()
    expect(t.engine.deliveryOf(line.seq)).toEqual([{ memberId: 'res', outcome: 'steered' }])
    expect(dsh.steered).toEqual([{ callId: res.call.callId, id: `steer-${line.seq}`, text: expect.stringContaining('#3 主人：@研究员 先查包月的') }])
    expect(dsh.steered[0]!.text).toContain('#2 接口人：研究员在查，别急')
    expect(t.engine.ledger.seen('res')).toBe(line.seq)
    res.sink.finished(res.call.callId, { text: '包月 99 元', status: 'completed', toolCalls: 1 })
    await flush()
    expect(t.dsh.count('res')).toBe(1)
    // The same request again is not said twice.
    expect(t.engine.say('@研究员 先查包月的', { requestId: 'r2' }).line.seq).toBe(line.seq)
    expect(t.engine.ledger.all().filter(row => row.requestId === 'r2')).toHaveLength(1)
  })

  it('没有在干活的成员照常开一次；送不进（rejected）就排队，回合一结束主人的话先到', async () => {
    const dsh = new SteerRunner()
    dsh.answer = 'rejected'
    const t = setup({ dsh })
    await t.engine.start()
    const first = t.engine.say('@研究员 查计费')
    await expect(first.deliveries[0]!.outcome).resolves.toBe('started')
    await flush()
    expect(t.engine.deliveryOf(first.line.seq)).toEqual([{ memberId: 'res', outcome: 'started' }])
    const res = t.dsh.last('res')
    const { line, deliveries } = t.engine.say('@研究员 换个方向')
    await expect(deliveries[0]!.outcome).resolves.toBe('queued')
    await flush()
    // Read back for the owner's line (also after the engine is rebuilt): it waits behind the member's current work.
    expect(t.engine.deliveryOf(line.seq)).toEqual([{ memberId: 'res', outcome: 'queued' }])
    expect(JSON.parse(readFileSync(join(t.dir, 'group', 'deliveries.json'), 'utf8')).lines[String(line.seq)]).toEqual([{ memberId: 'res', outcome: 'queued' }])
    expect(t.engine.view().members.find(row => row.memberId === 'res')).toMatchObject({ status: 'speaking', queued: 1 })
    res.sink.finished(res.call.callId, { text: '查完了', status: 'completed', toolCalls: 1 })
    await flush()
    expect(t.dsh.count('res')).toBe(2)
    expect(t.dsh.last('res').call.prompt).toContain(`#${line.seq} 主人：@研究员 换个方向`)
    // Its next call answers the words that waited.
    expect(t.engine.deliveryOf(line.seq)).toEqual([{ memberId: 'res', outcome: 'started' }])
  })

  it('运行器不支持送进去：直接排队（第 3 阶段的行为）', async () => {
    const t = setup()
    await t.engine.start()
    t.engine.ownerSay('@研究员 查计费')
    await flush()
    const { deliveries } = t.engine.say('@研究员 顺便查配额')
    await expect(deliveries[0]!.outcome).resolves.toBe('queued')
  })
})

describe('宿主代写的行、被叫前的核对', () => {
  it('liaisonSay 的 @ 叫人；没叫到人时 callAdmin 叫接口人自己，提示里带上那一行（含主人原话）', async () => {
    const t = setup()
    await t.engine.start()
    const handed = t.engine.liaisonSay('我把这件事交给你：查端点。', { workOrderId: 'd1', ref: 'start-1', quote: { label: '主人原话', text: '看看 arkcli 能不能列端点' }, onBehalfOfOwner: true,
      callAdmin: '主人交给你这张工单，按分工 @ 成员' })
    await flush()
    expect(t.engine.liaisonSay('again', { ref: 'start-1' }).seq).toBe(handed.seq)
    const liaison = t.dsh.last('liaison')
    expect(liaison.call.workOrderId).toBe('d1')
    expect(liaison.call.prompt).toContain('这次：主人交给你这张工单，按分工 @ 成员。')
    expect(liaison.call.prompt).toContain('#1 接口人：我把这件事交给你：查端点。\n主人原话：\n> 看看 arkcli 能不能列端点')
    const named = t.engine.liaisonSay('@工程师 你来跑', { workOrderId: 'd2', ref: 'start-2', callAdmin: '不该叫我' })
    await flush()
    expect(t.codex.last('eng').call.workOrderId).toBe('d2')
    expect(t.dsh.count('liaison')).toBe(1)
    expect(named.mentions).toEqual(['eng'])
  })

  it('admit 拒绝（额度用完等）：这一次不叫，账本记没能答完并带工单', async () => {
    const t = setup()
    const refusals: string[] = []
    const engine = new GroupEngine({ scope: 'brain', workspaceId: 'w1', groupId: 'g2', dir: join(t.dir, 'g2'), workDir: () => t.dir, info: () => ({ workspaceName: 'w', goal: '', title: 't' }),
      roster: () => ROSTER, runners: { dsh: t.dsh, codex: t.codex }, onEffects: rows => t.effects.push(...rows),
      admit: call => { refusals.push(call.member.id); return call.workOrderId ? '这张工单的对话额度已用完' : undefined } })
    engines.push(engine)
    await engine.start()
    engine.ownerSay('@研究员 查', { workOrderId: 'd1' })
    await flush()
    await flush()
    expect(t.dsh.count('res')).toBe(0)
    expect(engine.ledger.all().at(-1)).toMatchObject({ kind: 'event', event: 'failed', workOrderId: 'd1', text: expect.stringContaining('这张工单的对话额度已用完') })
    expect(t.effects.find(effect => effect.type === 'event')).toMatchObject({ memberId: 'res', workOrderId: 'd1' })
    engine.ownerSay('@研究员 随便聊聊')
    await flush()
    expect(t.dsh.count('res')).toBe(1)
    expect(refusals).toEqual(['res', 'res'])
  })

  it('note 只记一行不叫人，按 ref / 请求号去重；名册里已不在的人被叫时记为不在本群', async () => {
    const t = setup()
    await t.engine.start()
    const held = t.engine.note({ speaker: 'owner', text: '可以收单了', requestId: 'r9', workOrderId: 'd1' })
    expect(t.engine.note({ speaker: 'owner', text: '可以收单了', requestId: 'r9' }).seq).toBe(held.seq)
    t.engine.note({ speaker: 'liaison', text: '这句话像是要收单。', ref: 'command-r9' })
    await flush()
    expect(t.dsh.calls).toHaveLength(0)
    expect(t.lines()).toEqual(['message:主人:可以收单了', 'message:接口人:这句话像是要收单。'])
    t.engine.callOwnerLine(held.seq)
    await flush()
    expect(t.dsh.last('liaison').call.prompt).toContain('#1 主人：可以收单了')
    t.setRoster(ROSTER.filter(member => member.id !== 'adv'))
    t.engine.ownerSay('@谋士 想想')
    await flush()
    await flush()
    expect(t.lines().some(line => line.includes('谋士 没能答完：这位成员已不在本群'))).toBe(true)
  })
})

describe('成员发言里链接的文件', () => {
  it('only files the member links inside the working directory become attachments; host-written lines never do', async () => {
    const t = setup()
    const work = join(t.dir, 'project')
    mkdirSync(join(work, 'docs'), { recursive: true })
    mkdirSync(join(work, '.secret'), { recursive: true })
    writeFileSync(join(work, '报名表.md'), '# 报名表\n')
    writeFileSync(join(work, 'docs', 'index.html'), '<h1>hi</h1>')
    writeFileSync(join(work, '.secret', 'key.md'), 'x')
    writeFileSync(join(work, 'run.sh'), 'echo')
    writeFileSync(join(t.dir, 'outside.md'), 'x')
    symlinkSync(join(t.dir, 'outside.md'), join(work, 'link.md'))
    expect(linkedGroupFiles('[打开报名表](报名表.md) [页](docs/index.html) [k](.secret/key.md) [s](run.sh) [o](../outside.md) [l](link.md) [a](/etc/passwd.md) [m](missing.md)', work))
      .toEqual([{ name: '打开报名表', path: join(work, '报名表.md'), size: 12 }, { name: '页', path: join(work, 'docs', 'index.html'), size: 11 }])
    await t.engine.start()
    t.engine.ownerSay('@工程师 整理报名表 [打开报名表](报名表.md)')
    await flush()
    const eng = t.codex.last('eng')
    eng.sink.finished(eng.call.callId, { text: '报名表已整理好。[打开报名表](报名表.md)', status: 'completed', toolCalls: 1 })
    await flush()
    const lines = t.engine.ledger.all()
    expect(lines[0]!.attachments).toBeUndefined()
    expect(lines.at(-1)).toMatchObject({ author: '工程师', attachments: [{ name: '打开报名表', path: join(work, '报名表.md') }] })
    const handed = t.engine.liaisonSay('@工程师 参考 [打开报名表](报名表.md)', { ref: 'start-x' })
    expect(handed.attachments).toBeUndefined()
  })
})
