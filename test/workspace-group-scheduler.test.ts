import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GroupLedger, type GroupLine, type GroupLineInput, type GroupSay } from '../src/dsh/workspace-group-ledger.ts'
import {
  CONTINUE_TEXT, GROUP_LIMITS, GroupScheduler, HOST_ID, OWNER_ID, isIdleRelayText, isPass, promisesWork, stripOwnName,
  type GroupEffect, type GroupMember,
} from '../src/dsh/workspace-group-scheduler.ts'

const roots: string[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-group-scheduler-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

const MEMBERS: GroupMember[] = [
  { id: 'liaison', name: '接口人', admin: true },
  { id: 'eng', name: '工程师' },
  { id: 'res', name: '研究员' },
  { id: 'adv', name: '谋士' },
]

class MemoryLedger implements GroupSay {
  lines: GroupLine[] = []
  constructor(private readonly now: () => number) {}
  say(input: GroupLineInput): GroupLine {
    const line = { ...input, seq: this.lines.length + 1, at: new Date(this.now()).toISOString(), mentions: input.mentions ?? [] } as GroupLine
    this.lines.push(line)
    return line
  }
}

function setup(members = MEMBERS) {
  let t = 1_000_000
  const now = () => t
  const ledger = new MemoryLedger(now)
  const sched = new GroupScheduler({ members, say: ledger, now })
  return { sched, ledger, now, advance: (ms: number) => { t += ms } }
}

type Start = Extract<GroupEffect, { type: 'start' }>
const starts = (effects: GroupEffect[]) => effects.filter((e): e is Start => e.type === 'start')
const startOf = (effects: GroupEffect[], memberId: string) => {
  const found = starts(effects).find(e => e.memberId === memberId)
  if (!found) throw new Error(`no start for ${memberId} in ${JSON.stringify(effects)}`)
  return found
}
const who = (effects: GroupEffect[]) => starts(effects).map(e => e.memberId)
const wakes = (effects: GroupEffect[]) => effects.filter(e => e.type === 'wake')
const events = (effects: GroupEffect[]) => effects.flatMap(e => e.type === 'event' ? [e.event] : [])

describe('who answers', () => {
  it('an owner message without @ goes to the liaison (admin) only', () => {
    const { sched, ledger } = setup()
    const { line, effects } = sched.ownerSaid({ text: '看一下 arkcli 能不能拿到当前开通的端点', workOrderId: 'd1' })
    expect(line).toMatchObject({ seq: 1, kind: 'message', speakerId: OWNER_ID, mentions: [], workOrderId: 'd1' })
    expect(effects).toEqual([{ type: 'start', callId: 'c2', memberId: 'liaison', by: OWNER_ID, reason: 'owner', note: '主人发了新消息',
      triggerSeq: 1, batchId: 'b1', workOrderId: 'd1', coAnswering: [] }])
    expect(ledger.lines).toHaveLength(1)
  })

  it('an owner message with @ calls only the named members, in parallel, each told who else answers (AC2)', () => {
    const { sched, ledger } = setup()
    const { effects } = sched.ownerSaid({ text: '@研究员 @谋士 各自看一下竞品' })
    expect(who(effects)).toEqual(['res', 'adv'])
    expect(startOf(effects, 'res').coAnswering).toEqual(['adv'])
    expect(startOf(effects, 'adv').coAnswering).toEqual(['res'])
    expect(ledger.lines[0]!.mentions).toEqual(['res', 'adv'])
  })

  it('an all-word from the owner calls everyone, admin first, all at once', () => {
    const { sched, ledger } = setup()
    const { effects } = sched.ownerSaid({ text: '@所有人 今天下午对一下进度' })
    expect(who(effects)).toEqual(['liaison', 'eng', 'res', 'adv'])
    expect(starts(effects).every(e => e.reason === 'all')).toBe(true)
    expect(ledger.lines[0]!.all).toBe(true)
  })

  it('a member\'s all-word only counts from the admin', () => {
    const { sched } = setup()
    const first = startOf(sched.ownerSaid({ text: '@工程师 你先看' }).effects, 'eng')
    expect(who(sched.finished(first.callId, { text: '@所有人 我看完了，大家看看' }))).toEqual([])
    const admin = startOf(sched.ownerSaid({ text: '安排一下' }).effects, 'liaison')
    expect(who(sched.finished(admin.callId, { text: '@all 各自汇报一下' }))).toEqual(['eng', 'res', 'adv'])
  })

  it('a member never calls itself, and one turn calls each member once', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '安排' }).effects, 'liaison')
    expect(who(sched.stepped(admin.callId, '@接口人 @工程师 先看日志'))).toEqual(['eng'])
    expect(who(sched.finished(admin.callId, { text: '@工程师 记得也看配置' }))).toEqual([])
  })
})

describe('one call at a time per member', () => {
  it('a member busy answering gets the next call queued, started when it is free', () => {
    const { sched } = setup()
    const eng = startOf(sched.ownerSaid({ text: '@工程师 跑一下测试' }).effects, 'eng')
    const admin = startOf(sched.ownerSaid({ text: '再安排点别的' }).effects, 'liaison')
    expect(who(sched.finished(admin.callId, { text: '@工程师 测试跑完顺便看下覆盖率' }))).toEqual([])
    expect(sched.activity().find(a => a.memberId === 'eng')).toMatchObject({ status: 'speaking', queued: 1 })
    const next = sched.finished(eng.callId, { text: '测试都过了' })
    expect(startOf(next, 'eng')).toMatchObject({ by: 'liaison', reason: 'mention', note: '接口人 @ 了你' })
  })

  it('a compatible call to a member still queued updates that call instead of queueing twice', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '第一句' }).effects, 'liaison')
    expect(who(sched.ownerSaid({ text: '第二句' }).effects)).toEqual([])
    expect(who(sched.ownerSaid({ text: '第三句' }).effects)).toEqual([])
    expect(sched.calls.filter(c => c.memberId === 'liaison')).toHaveLength(2)
    const next = startOf(sched.finished(admin.callId, { text: '收到第一句的事，这就安排。' }), 'liaison')
    expect(next.triggerSeq).toBe(3)
  })
})

describe('relay', () => {
  it('an @ in a progress line calls at once, while the speaker is still at work', () => {
    const { sched, ledger } = setup()
    const admin = startOf(sched.ownerSaid({ text: '看一下 arkcli 能不能拿到端点', workOrderId: 'd1' }).effects, 'liaison')
    const effects = sched.stepped(admin.callId, '@工程师 在 arklab 里跑一下 arkcli 看端点')
    const eng = startOf(effects, 'eng')
    expect(eng).toMatchObject({ by: 'liaison', reason: 'mention', triggerSeq: 2, workOrderId: 'd1' })
    expect(ledger.lines[1]).toMatchObject({ kind: 'progress', speakerId: 'liaison', mentions: ['eng'], replyTo: 1, workOrderId: 'd1' })
    expect(sched.activity().find(a => a.memberId === 'liaison')?.status).toBe('speaking')
  })

  it('an @ in a final reply relays too, and the line carries its batch', () => {
    const { sched, ledger } = setup()
    const admin = startOf(sched.ownerSaid({ text: '安排' }).effects, 'liaison')
    const eng = startOf(sched.finished(admin.callId, { text: '@工程师 你来' }), 'eng')
    sched.tool(eng.callId)
    const res = startOf(sched.finished(eng.callId, { text: '日志看了，@研究员 查一下这个报错的来历' }), 'res')
    expect(res.by).toBe('eng')
    expect(ledger.lines.at(-1)).toMatchObject({ speakerId: 'eng', mentions: ['res'], batchId: eng.batchId })
  })

  it('mid-turn lines less than 30 s apart reach the group as one progress line; held lines open the result', () => {
    const { sched, ledger, advance } = setup()
    const eng = startOf(sched.ownerSaid({ text: '@工程师 排查一下' }).effects, 'eng')
    sched.tool(eng.callId)
    sched.stepped(eng.callId, '先看日志')
    advance(5_000)
    sched.stepped(eng.callId, '日志里有 502')
    sched.stepped(eng.callId, '日志里有 502')
    advance(10_000)
    sched.stepped(eng.callId, '再看网关配置')
    expect(ledger.lines.map(l => l.text)).toEqual(['@工程师 排查一下', '先看日志'])
    expect(sched.nextDeadline()).toBe(1_000_000 + 15_000) // background deadline comes first
    advance(15_000)
    sched.tick()
    expect(ledger.lines.at(-1)).toMatchObject({ kind: 'progress', text: '日志里有 502\n\n再看网关配置' })
    sched.stepped(eng.callId, '网关超时设成了 1 秒')
    sched.finished(eng.callId, { text: '原因是网关超时太短，已改成 30 秒。' })
    expect(ledger.lines.at(-1)).toMatchObject({ kind: 'message', text: '网关超时设成了 1 秒\n\n原因是网关超时太短，已改成 30 秒。' })
  })

  it('a final that only repeats the last line is not posted again', () => {
    const { sched, ledger } = setup()
    const eng = startOf(sched.ownerSaid({ text: '@工程师 看下' }).effects, 'eng')
    sched.stepped(eng.callId, '端点有 3 个')
    sched.finished(eng.callId, { text: '端点有 3 个' })
    expect(ledger.lines.map(l => l.text)).toEqual(['@工程师 看下', '端点有 3 个'])
  })
})

describe('background work', () => {
  it('15 s after the first non-team tool the call goes to the background; the late reply still settles and relays', () => {
    const { sched, ledger, advance } = setup()
    const admin = startOf(sched.ownerSaid({ text: '看下端点' }).effects, 'liaison')
    const eng = startOf(sched.finished(admin.callId, { text: '@工程师 跑一下 arkcli' }), 'eng')
    sched.tool(eng.callId, { team: true })
    advance(20_000)
    expect(sched.tick()).toEqual([])
    sched.tool(eng.callId)
    advance(14_999)
    expect(sched.tick()).toEqual([])
    advance(1)
    expect(sched.tick()).toEqual([{ type: 'background', callId: eng.callId, memberId: 'eng' }])
    expect(sched.activity().find(a => a.memberId === 'eng')?.status).toBe('working')
    advance(GROUP_LIMITS.replyTimeoutMs * 2)
    expect(events(sched.tick())).toEqual([])
    const late = sched.finished(eng.callId, { text: '跑完了，有 3 个端点。@研究员 看下计费' })
    expect(who(late)).toEqual(['res'])
    expect(ledger.lines.at(-1)).toMatchObject({ speakerId: 'eng', kind: 'message', mentions: ['res'] })
  })
})

describe('batch settlement', () => {
  it('wakes the dispatcher once, when every callee landed and someone used tools', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '分头查一下', workOrderId: 'd9' }).effects, 'liaison')
    const called = sched.finished(admin.callId, { text: '@工程师 跑命令 @研究员 查资料' })
    const eng = startOf(called, 'eng'), res = startOf(called, 'res')
    expect(eng.batchId).toBe(res.batchId)
    sched.tool(eng.callId)
    const first = sched.finished(eng.callId, { text: '命令跑完：3 个端点' })
    expect(wakes(first)).toEqual([])
    expect(who(first)).toEqual([])
    const second = sched.finished(res.callId, { text: '资料里说是按量计费' })
    expect(wakes(second)).toEqual([{ type: 'wake', memberId: 'liaison', batchId: eng.batchId, done: ['eng', 'res'], results: [3, 4], workOrderId: 'd9', triggerSeq: 2 }])
    expect(startOf(second, 'liaison')).toMatchObject({ by: HOST_ID, reason: 'wake', note: '工程师、研究员 做完了你交代的活', done: ['eng', 'res'], results: [3, 4], workOrderId: 'd9' })
  })

  it('does not wake when nobody used a tool', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '问问意见' }).effects, 'liaison')
    const adv = startOf(sched.finished(admin.callId, { text: '@谋士 你怎么看' }), 'adv')
    expect(wakes(sched.finished(adv.callId, { text: '我建议先做 A，再做 B，理由是成本更低。' }))).toEqual([])
  })

  it('does not wake when a callee handed on with a new @', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '查' }).effects, 'liaison')
    const eng = startOf(sched.finished(admin.callId, { text: '@工程师 查' }), 'eng')
    sched.tool(eng.callId)
    const effects = sched.finished(eng.callId, { text: '我这边查完，@研究员 你补一下来源' })
    expect(wakes(effects)).toEqual([])
    expect(who(effects)).toEqual(['res'])
  })

  it('a dispatcher still in its own turn is woken after that turn', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '查' }).effects, 'liaison')
    const eng = startOf(sched.stepped(admin.callId, '@工程师 跑一下'), 'eng')
    sched.tool(eng.callId)
    const done = sched.finished(eng.callId, { text: '跑完了' })
    expect(wakes(done)).toHaveLength(1)
    expect(who(done)).toEqual([])
    expect(startOf(sched.finished(admin.callId, { text: '先等工程师' }), 'liaison').reason).toBe('wake')
  })

  it('calls the owner made directly never wake the liaison', () => {
    const { sched } = setup()
    const effects = sched.ownerSaid({ text: '@研究员 @谋士 分别给个结论' }).effects
    const res = startOf(effects, 'res'), adv = startOf(effects, 'adv')
    sched.tool(res.callId)
    sched.tool(adv.callId)
    const all = [...sched.finished(res.callId, { text: '结论 A' }), ...sched.finished(adv.callId, { text: '结论 B' })]
    expect(wakes(all)).toEqual([])
    expect(who(all)).toEqual([])
    expect(sched.batches).toEqual([])
  })

  it('a second call of the same dispatcher folds the finished part of the older batch into the newer one', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '查' }).effects, 'liaison')
    const first = sched.finished(admin.callId, { text: '@工程师 @研究员 先查' })
    const eng = startOf(first, 'eng'), res = startOf(first, 'res')
    sched.tool(eng.callId)
    sched.finished(eng.callId, { text: '工程师查完' })
    const again = startOf(sched.ownerSaid({ text: '让研究员再补一份来源' }).effects, 'liaison')
    expect(who(sched.finished(again.callId, { text: '@研究员 再补一份来源' }))).toEqual([])
    expect(sched.batches.map(b => [b.by, b.pending, b.done, b.worked])).toEqual([['liaison', ['res'], ['eng'], true]])
    // 研究员手上那一回合落地即收回整批（DS-Bot batchOfSlot 取同一派活者最新的批次），只唤醒一次。
    const landed = sched.finished(res.callId, { text: '研究员查完' })
    expect(wakes(landed)).toEqual([expect.objectContaining({ memberId: 'liaison', done: ['eng', 'res'] })])
    const queued = startOf(landed, 'res')
    expect(wakes(sched.finished(queued.callId, { text: '来源补上了' }))).toEqual([])
  })
})

describe('[PASS]', () => {
  it('a member can pass without posting; a batch where everyone passed wakes nobody', () => {
    const { sched, ledger } = setup()
    for (const text of ['', '[PASS]', ' 【pass】 then more', '(pass)', 'pass.', 'Pass！', '  PASS  ']) expect(isPass(text), text).toBe(true)
    for (const text of ['passing the ball', 'I pass on this one', 'ok']) expect(isPass(text), text).toBe(false)
    const admin = startOf(sched.ownerSaid({ text: '有事吗' }).effects, 'liaison')
    const eng = startOf(sched.finished(admin.callId, { text: '@工程师 有补充吗' }), 'eng')
    sched.tool(eng.callId)
    const before = ledger.lines.length
    expect(sched.finished(eng.callId, { text: '[PASS]' })).toEqual([])
    expect(ledger.lines).toHaveLength(before)
    expect(sched.batches).toEqual([])
  })

  it('the liaison passing alone on the owner\'s plain message leaves a hint line', () => {
    const { sched, ledger } = setup()
    const admin = startOf(sched.ownerSaid({ text: '嗯' }).effects, 'liaison')
    expect(events(sched.finished(admin.callId, { text: '[PASS]' }))).toEqual(['admin-passed'])
    expect(ledger.lines.at(-1)).toMatchObject({ kind: 'event', speakerId: HOST_ID, event: 'admin-passed' })
  })
})

describe('continue push', () => {
  it('ported promise phrasing: promises count, reports of done work do not', () => {
    for (const said of ['收到，我现在开始排查构建日志。', '明白，我先排查一下日志，然后跑测试。', '收到，我现在开始排查。稍后给你结果。', '收到，我先查看过去的记录。', '好的，我先检查完成情况。', '我现在开始排查', '开工！', "I'll check the logs. Then I'll run the tests.", 'Let me look into it.']) {
      expect(promisesWork(said), said).toBe(true)
    }
    for (const said of ['好的，我检查过了，配置没问题。', '好的，我检查过，没问题。', '收到，我排查完了，是端口冲突。', '好的，我处理好了。', '查完了，原因是端口冲突。']) {
      expect(promisesWork(said), said).toBe(false)
    }
  })

  it('"ack without tools" is posted as progress and pushed once in the same session; it may answer [PASS]', () => {
    const { sched, ledger } = setup()
    const admin = startOf(sched.ownerSaid({ text: '查下端点' }).effects, 'liaison')
    const eng = startOf(sched.finished(admin.callId, { text: '@工程师 跑 arkcli' }), 'eng')
    const pushed = sched.finished(eng.callId, { text: '收到，我去排查一下' })
    expect(pushed).toEqual([{ type: 'continue', callId: eng.callId, memberId: 'eng', text: CONTINUE_TEXT }])
    expect(ledger.lines.at(-1)).toMatchObject({ kind: 'progress', speakerId: 'eng', text: '收到，我去排查一下' })
    expect(sched.activity().find(a => a.memberId === 'eng')?.status).toBe('speaking')
    const passed = sched.finished(eng.callId, { text: '[PASS]' })
    expect(passed.filter(e => e.type === 'continue')).toEqual([])
    expect(ledger.lines.at(-1)!.text).toBe('收到，我去排查一下')
    expect(sched.calls.filter(c => c.memberId === 'eng')).toEqual([])
  })

  it('pushes only once, not after tools, not for "done" phrasing, not when it hands on with @', () => {
    const once = setup()
    const a = startOf(once.sched.ownerSaid({ text: '@工程师 查' }).effects, 'eng')
    expect(once.sched.finished(a.callId, { text: '好的，我检查一下' })[0]?.type).toBe('continue')
    expect(once.sched.finished(a.callId, { text: '好的，我检查一下配置' }).some(e => e.type === 'continue')).toBe(false)
    expect(once.ledger.lines.at(-1)).toMatchObject({ kind: 'message', text: '好的，我检查一下配置' })

    const tools = setup()
    const b = startOf(tools.sched.ownerSaid({ text: '@工程师 查' }).effects, 'eng')
    tools.sched.tool(b.callId)
    expect(tools.sched.finished(b.callId, { text: '好的，我检查一下' }).some(e => e.type === 'continue')).toBe(false)

    const done = setup()
    const c = startOf(done.sched.ownerSaid({ text: '@工程师 查' }).effects, 'eng')
    expect(done.sched.finished(c.callId, { text: '好的，我检查过了，配置没问题。' }).some(e => e.type === 'continue')).toBe(false)

    const handoff = setup()
    const d = startOf(handoff.sched.ownerSaid({ text: '@工程师 查' }).effects, 'eng')
    const effects = handoff.sched.finished(d.callId, { text: '收到，我去排查 @研究员' })
    expect(effects.some(e => e.type === 'continue')).toBe(false)
    expect(who(effects)).toEqual(['res'])
  })
})

describe('idle guard', () => {
  it('ported status phrasing: status posts count, talk about work does not', () => {
    const everyone = [{ id: 'a', name: 'Chief' }, { id: 'b', name: 'Writer' }]
    for (const text of ['待命', '暂无待办', '静候下一步', '收到，待命', '收口无待办', '保持待命', '暂无待办，静候下一步', '目前没有新进展', '今日无任务', '当前无任务', '@Writer 谢谢', '好的！']) {
      expect(isIdleRelayText(text, everyone, []), text).toBe(true)
    }
    for (const text of ['当前任务：修 502', '目前任务已完成', '今天任务很多', '任务', '待我确认', '安排在周三上线', '进展：接口改完', '正在核对 09:31 之后的日志', '@Chief 这段日志也看一下']) {
      expect(isIdleRelayText(text, everyone, []), text).toBe(false)
    }
    expect(isIdleRelayText('端口已经确认是 8080 了', everyone, ['端口已经确认是 8080 了'])).toBe(true)
  })

  /** 两位幕僚互相客套：每次都 @ 对方、0 工具。 */
  function pingPong(sched: GroupScheduler, startCall: Start, turns: number) {
    let current = startCall
    const replies = ['@研究员 收到，谢谢', '@工程师 不客气', '@研究员 好的', '@工程师 辛苦了', '@研究员 明白', '@工程师 收到', '@研究员 谢谢', '@工程师 好嘞']
    let last: GroupEffect[] = []
    for (let i = 0; i < turns; i++) {
      last = sched.finished(current.callId, { text: replies[i % replies.length]! })
      const next = starts(last)[0]
      if (!next) break
      current = next
    }
    return last
  }

  it('6 consecutive zero-tool pleasantries between members stop auto calls, park them with one event line, and only the owner unparks (AC4)', () => {
    const { sched, ledger } = setup()
    const admin = startOf(sched.ownerSaid({ text: '安排一下' }).effects, 'liaison')
    const called = sched.finished(admin.callId, { text: '@工程师 和 @研究员 对一下' })
    const eng = startOf(called, 'eng'), res = startOf(called, 'res')
    sched.finished(res.callId, { text: '[PASS]' })
    const last = pingPong(sched, eng, 6)
    expect(who(last)).toEqual([])
    expect(events(last)).toEqual(['paused'])
    expect(sched.paused).toBe(true)
    expect(sched.parked.map(p => [p.memberId, p.by])).toEqual([['eng', 'res']])
    expect(ledger.lines.filter(l => l.event === 'paused')).toHaveLength(1)
    // 暂停期间成员的空转不再提示第二次，也不会自己放行。
    expect(sched.tick()).toEqual([])
    const resumed = sched.ownerSaid({ text: '继续，研究员把结论写下来' }).effects
    expect(who(resumed).sort()).toEqual(['eng', 'liaison'])
    expect(startOf(resumed, 'eng')).toMatchObject({ by: 'res', reason: 'unpark' })
    expect(sched.paused).toBe(false)
    expect(sched.parked).toEqual([])
  })

  it('a tool call between the pleasantries clears the streak, so a working group is never paused', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '安排' }).effects, 'liaison')
    let current = startOf(sched.finished(admin.callId, { text: '@工程师 开始' }), 'eng')
    const replies = ['@研究员 收到', '@工程师 好的', '@研究员 谢谢', '@工程师 收到']
    for (let i = 0; i < 10; i++) {
      if (i === 4) sched.tool(current.callId)
      const effects = sched.finished(current.callId, { text: replies[i % 4]! })
      expect(events(effects), `turn ${i}`).toEqual([])
      current = starts(effects)[0]!
    }
    expect(sched.paused).toBe(false)
  })

  it('answering the owner does not count toward the streak', () => {
    const { sched } = setup()
    for (let i = 0; i < 8; i++) {
      const admin = startOf(sched.ownerSaid({ text: `第 ${i} 句` }).effects, 'liaison')
      sched.finished(admin.callId, { text: '好的' })
    }
    expect(sched.paused).toBe(false)
  })
})

describe('timeout', () => {
  it('240 s with no member event moves on with a faint event line; any event resets the timer; the late reply still settles', () => {
    const { sched, ledger, advance } = setup()
    const admin = startOf(sched.ownerSaid({ text: '查' }).effects, 'liaison')
    const eng = startOf(sched.finished(admin.callId, { text: '@工程师 查' }), 'eng')
    advance(200_000)
    sched.touched(eng.callId)
    advance(239_999)
    expect(sched.tick()).toEqual([])
    expect(sched.nextDeadline()).toBe(1_000_000 + 200_000 + 240_000)
    advance(1)
    const effects = sched.tick()
    expect(events(effects)).toEqual(['missed'])
    expect(ledger.lines.at(-1)).toMatchObject({ kind: 'event', event: 'missed', text: '工程师 4 分钟没有动静，先往下走；如果还在干，结果之后会作为迟到回复发出。' })
    expect(sched.activity().find(a => a.memberId === 'eng')?.status).toBe('missed')
    sched.tool(eng.callId)
    expect(wakes(sched.finished(eng.callId, { text: '终于跑完了' }))).toHaveLength(1)
  })

  it('a member waiting for the owner\'s approval yields and does not time out', () => {
    const { sched, advance } = setup()
    const eng = startOf(sched.ownerSaid({ text: '@工程师 删掉旧镜像' }).effects, 'eng')
    sched.approval(eng.callId, true)
    expect(sched.activity().find(a => a.memberId === 'eng')?.status).toBe('approval')
    advance(GROUP_LIMITS.replyTimeoutMs * 3)
    expect(sched.tick()).toEqual([])
    sched.approval(eng.callId, false)
    expect(sched.activity().find(a => a.memberId === 'eng')?.status).toBe('working')
  })
})

describe('owner message during a round', () => {
  it('joins at once: the liaison answers while the engineer still works, and the owner can call a free member directly', () => {
    const { sched, advance } = setup()
    const admin = startOf(sched.ownerSaid({ text: '查端点' }).effects, 'liaison')
    const eng = startOf(sched.finished(admin.callId, { text: '@工程师 跑一下' }), 'eng')
    sched.tool(eng.callId)
    advance(16_000)
    sched.tick()
    expect(who(sched.ownerSaid({ text: '顺便问下，费用怎么算？' }).effects)).toEqual(['liaison'])
    expect(who(sched.ownerSaid({ text: '@研究员 查下计费文档' }).effects)).toEqual(['res'])
  })

  it('the owner\'s call to a busy member merges into its queued call and is answered next, as the owner\'s', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '安排' }).effects, 'liaison')
    const eng = startOf(sched.stepped(admin.callId, '@工程师 先做 A'), 'eng')
    const res = startOf(sched.ownerSaid({ text: '@研究员 看下' }).effects, 'res')
    sched.finished(res.callId, { text: '@工程师 你顺便做 B' })
    const { line } = sched.ownerSaid({ text: '@工程师 做完手上的先做 C' })
    expect(sched.calls.filter(c => c.memberId === 'eng' && c.status === 'queued')).toHaveLength(1)
    const next = startOf(sched.finished(eng.callId, { text: 'A 做完了' }), 'eng')
    expect(next).toMatchObject({ by: OWNER_ID, reason: 'mention', note: '主人 @ 了你', triggerSeq: line.seq })
  })
})

describe('stop', () => {
  it('stops one member: cancels its running turn, drops its queue and batch without waking, writes one line', () => {
    const { sched, ledger } = setup()
    const admin = startOf(sched.ownerSaid({ text: '查' }).effects, 'liaison')
    const eng = startOf(sched.finished(admin.callId, { text: '@工程师 查' }), 'eng')
    sched.tool(eng.callId)
    const effects = sched.stop('eng')
    expect(effects.filter(e => e.type === 'cancel')).toEqual([{ type: 'cancel', callId: eng.callId, memberId: 'eng' }])
    expect(events(effects)).toEqual(['stopped'])
    expect(wakes(effects)).toEqual([])
    expect(ledger.lines.at(-1)!.text).toBe('主人叫停了 工程师 在本群的工作。')
    expect(sched.batches).toEqual([])
    expect(sched.finished(eng.callId, { text: '迟到的结果', status: 'cancelled' })).toEqual([])
    expect(sched.stop('eng')).toEqual([])
  })

  it('stop all cancels every running member, clears queues, batches and parked calls', () => {
    const { sched, ledger } = setup()
    const effects = sched.ownerSaid({ text: '@所有人 动起来' }).effects
    const admin = startOf(effects, 'liaison')
    sched.stepped(admin.callId, '@工程师 再做一件')
    const stopped = sched.stop()
    expect(stopped.filter(e => e.type === 'cancel').map(e => e.memberId).sort()).toEqual(['adv', 'eng', 'liaison', 'res'])
    expect(sched.calls).toEqual([])
    expect(sched.batches).toEqual([])
    expect(ledger.lines.at(-1)).toMatchObject({ event: 'stopped', text: '主人叫停了本群的全部工作。' })
    expect(sched.activity().every(a => a.status === 'idle')).toBe(true)
  })
})

describe('persistence and restart', () => {
  it('the state round-trips through JSON and a restarted scheduler continues without repeating work', () => {
    const dir = temp()
    let t = 5_000_000
    const now = () => t
    const ledger = new GroupLedger(dir, now)
    const first = new GroupScheduler({ members: MEMBERS, say: ledger, now })
    const admin = startOf(first.ownerSaid({ text: '分头查', workOrderId: 'd3' }).effects, 'liaison')
    const called = first.finished(admin.callId, { text: '@工程师 @研究员 查' })
    const eng = startOf(called, 'eng'), res = startOf(called, 'res')
    first.tool(eng.callId)
    first.finished(eng.callId, { text: '工程师结果' })
    first.tool(res.callId)
    const saved = JSON.parse(JSON.stringify(first.snapshot()))

    // 重启后研究员的回合还在跑：续上，不重复开始，落地后唤醒接口人一次。
    t += 60_000
    const alive = new GroupScheduler({ members: MEMBERS, say: new GroupLedger(dir, now), now, state: saved })
    expect(alive.restart([res.callId])).toEqual([])
    const wake = alive.finished(res.callId, { text: '研究员结果' })
    expect(wakes(wake)).toHaveLength(1)
    expect(startOf(wake, 'liaison').workOrderId).toBe('d3')

    // 重启后研究员的回合没了：记一行中断，批次按已有结果唤醒接口人一次。
    const cut = new GroupScheduler({ members: MEMBERS, say: new GroupLedger(dir, now), now, state: saved })
    const effects = cut.restart([])
    expect(events(effects)).toEqual(['interrupted'])
    expect(wakes(effects)).toEqual([{ type: 'wake', memberId: 'liaison', batchId: eng.batchId, done: ['eng'], results: [3], workOrderId: 'd3', triggerSeq: 2 }])
    expect(who(effects)).toEqual(['liaison'])
    expect(new GroupLedger(dir).all().map(l => l.seq)).toEqual(new GroupLedger(dir).all().map((_, i) => i + 1))
  })

  it('queued calls start after a restart', () => {
    const { sched, ledger, now } = setup()
    const admin = startOf(sched.ownerSaid({ text: '一' }).effects, 'liaison')
    sched.ownerSaid({ text: '二' })
    const again = new GroupScheduler({ members: MEMBERS, say: ledger, now, state: sched.snapshot() })
    expect(who(again.restart([]))).toEqual(['liaison'])
    expect(again.calls.some(c => c.id === admin.callId)).toBe(false)
  })
})

describe('membership', () => {
  it('a staff member leaving the workspace leaves the group: its turn is cancelled and batches settle without it', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '查' }).effects, 'liaison')
    const called = sched.finished(admin.callId, { text: '@工程师 @谋士 查' })
    const eng = startOf(called, 'eng'), adv = startOf(called, 'adv')
    sched.tool(eng.callId)
    sched.finished(eng.callId, { text: '工程师结果' })
    const effects = sched.setMembers(MEMBERS.filter(m => m.id !== 'adv'))
    expect(effects.filter(e => e.type === 'cancel')).toEqual([{ type: 'cancel', callId: adv.callId, memberId: 'adv' }])
    expect(wakes(effects)).toHaveLength(1)
    expect(() => sched.setMembers([...MEMBERS, { id: 'eng', name: '重复' }])).toThrow(/重复/)
    expect(() => sched.setMembers([{ id: 'a', name: 'A', admin: true }, { id: 'b', name: 'B', admin: true }])).toThrow(/管理员/)
  })
})

describe('constants and helpers', () => {
  it('mirrors DS-Bot values', () => {
    expect(GROUP_LIMITS).toMatchObject({ replyTimeoutMs: 240_000, stepGapMs: 30_000, workGraceMs: 15_000, idleRelayLimit: 6, maxMembers: 12 })
  })

  it('strips an echoed "Name:" prefix (ported from DS-Bot)', () => {
    expect(stripOwnName('Writer', 'Writer: hello')).toBe('hello')
    expect(stripOwnName('Writer', '**Writer**：你好')).toBe('你好')
    expect(stripOwnName('A.b', 'A.b: x')).toBe('x')
    expect(stripOwnName('A.b', 'Axb: x')).toBe('Axb: x')
    expect(stripOwnName('Writer', 'Coder: hi')).toBe('Coder: hi')
  })
})

describe('owner words reach a working member at once (steer)', () => {
  type Steer = Extract<GroupEffect, { type: 'steer' }>
  const steers = (effects: GroupEffect[]) => effects.filter((e): e is Steer => e.type === 'steer')

  it('a named member mid-call gets a steer effect instead of a queued call; others start as usual', () => {
    const { sched } = setup()
    const eng = startOf(sched.ownerSaid({ text: '@工程师 跑评测' }).effects, 'eng')
    const { line, effects } = sched.ownerSaid({ text: '@工程师 @研究员 先别删数据', steer: true, workOrderId: 'd1' })
    expect(steers(effects)).toEqual([{ type: 'steer', callId: eng.callId, memberId: 'eng', seq: line.seq, reason: 'mention', note: '主人 @ 了你', workOrderId: 'd1' }])
    expect(who(effects)).toEqual(['res'])
    expect(sched.calls.filter(c => c.memberId === 'eng')).toHaveLength(1)
    // Delivered: the engineer's turn ends with nothing queued behind it.
    expect(who(sched.finished(eng.callId, { text: '好，没删' }))).toEqual([])
  })

  it('a plain message while the admin answers is steered into the admin; @all steers the busy, starts the rest', () => {
    const { sched } = setup()
    const admin = startOf(sched.ownerSaid({ text: '查端点' }).effects, 'liaison')
    const plain = sched.ownerSaid({ text: '顺便看下配额', steer: true })
    expect(steers(plain.effects).map(e => [e.memberId, e.callId, e.reason])).toEqual([['liaison', admin.callId, 'owner']])
    expect(who(plain.effects)).toEqual([])
    const all = sched.ownerSaid({ text: '@所有人 停一下', steer: true })
    expect(steers(all.effects).map(e => e.memberId)).toEqual(['liaison'])
    expect(who(all.effects)).toEqual(['eng', 'res', 'adv'])
  })

  it('steering impossible: steerFailed queues the owner call first, started when the member is free', () => {
    const { sched } = setup()
    const eng = startOf(sched.ownerSaid({ text: '@工程师 跑评测' }).effects, 'eng')
    const admin = startOf(sched.ownerSaid({ text: '安排一下' }).effects, 'liaison')
    sched.stepped(admin.callId, '@工程师 跑完顺便看覆盖率')
    const [steer] = steers(sched.ownerSaid({ text: '@工程师 先停', steer: true }).effects)
    expect(who(sched.steerFailed(steer!))).toEqual([])
    const next = startOf(sched.finished(eng.callId, { text: '跑完了' }), 'eng')
    expect(next).toMatchObject({ by: OWNER_ID, triggerSeq: steer!.seq, note: '主人 @ 了你' })
  })

  it('without steer the old queueing stays (a busy member answers the owner next)', () => {
    const { sched } = setup()
    startOf(sched.ownerSaid({ text: '@工程师 跑评测' }).effects, 'eng')
    const effects = sched.ownerSaid({ text: '@工程师 先停' }).effects
    expect(steers(effects)).toEqual([])
    expect(sched.calls.filter(c => c.memberId === 'eng' && c.status === 'queued')).toHaveLength(1)
  })
})

describe('host-written member lines, held order wakes, stopping an order', () => {
  it('memberSaid: the liaison\'s line @-mentions a member under its own batch; callFor calls the liaison itself', () => {
    const { sched, ledger } = setup()
    const { line, effects } = sched.memberSaid('liaison', { text: '@研究员 请整理计费规则', workOrderId: 'd1', ref: 'start-1', quote: { label: '主人原话', text: '查计费' }, onBehalfOfOwner: true })
    expect(ledger.lines.at(-1)).toMatchObject({ seq: line.seq, speakerId: 'liaison', author: '接口人', mentions: ['res'], ref: 'start-1', quote: { label: '主人原话', text: '查计费' }, workOrderId: 'd1' })
    expect(startOf(effects, 'res')).toMatchObject({ by: 'liaison', reason: 'mention', note: '接口人 @ 了你', workOrderId: 'd1' })
    const res = startOf(effects, 'res')
    sched.tool(res.callId)
    const wake = startOf(sched.finished(res.callId, { text: '按量计费' }), 'liaison')
    expect(wake).toMatchObject({ reason: 'wake' })
    sched.finished(wake.callId, { text: '研究员查到了：按量计费。' })
    const plain = sched.memberSaid('liaison', { text: '主人交来一件事' })
    expect(who(plain.effects)).toEqual([])
    expect(startOf(sched.callFor('liaison', { triggerSeq: plain.line.seq, note: '按分工派活', workOrderId: 'd2' }), 'liaison')).toMatchObject({ by: OWNER_ID, note: '按分工派活', workOrderId: 'd2' })
  })

  it('holdOrderWakes: the liaison\'s order batch lands with a held wake and no call; wakeNow calls it; other batches wake as usual', () => {
    let t = 1_000_000
    const ledger = new MemoryLedger(() => t)
    const sched = new GroupScheduler({ members: MEMBERS, say: ledger, now: () => t, holdOrderWakes: true })
    const admin = startOf(sched.ownerSaid({ text: '查端点', workOrderId: 'd1' }).effects, 'liaison')
    const eng = startOf(sched.finished(admin.callId, { text: '@工程师 跑 arkcli' }), 'eng')
    sched.tool(eng.callId)
    const landed = sched.finished(eng.callId, { text: '3 个端点' })
    expect(wakes(landed)).toEqual([expect.objectContaining({ memberId: 'liaison', held: true, workOrderId: 'd1', done: ['eng'] })])
    expect(who(landed)).toEqual([])
    const [wake] = wakes(landed) as Extract<GroupEffect, { type: 'wake' }>[]
    expect(startOf(sched.wakeNow(wake!), 'liaison')).toMatchObject({ reason: 'wake', by: HOST_ID, results: wake!.results })
    // No order: the wake is not held.
    const free = new GroupScheduler({ members: MEMBERS, say: new MemoryLedger(() => t), now: () => t, holdOrderWakes: true })
    const a2 = startOf(free.ownerSaid({ text: '聊聊' }).effects, 'liaison')
    const e2 = startOf(free.finished(a2.callId, { text: '@工程师 看下' }), 'eng')
    free.tool(e2.callId)
    expect(wakes(free.finished(e2.callId, { text: '好了' }))).toEqual([expect.not.objectContaining({ held: true })])
  })

  it('stopOrder cancels that order\'s running calls, drops its queue and batches, keeps other work, writes one line', () => {
    const { sched } = setup()
    const eng = startOf(sched.ownerSaid({ text: '@工程师 跑评测', workOrderId: 'd1' }).effects, 'eng')
    const res = startOf(sched.ownerSaid({ text: '@研究员 查资料', workOrderId: 'd2' }).effects, 'res')
    sched.ownerSaid({ text: '@工程师 再跑一遍', workOrderId: 'd1' })
    const effects = sched.stopOrder('d1', '工单已暂停')
    expect(effects.filter(e => e.type === 'cancel')).toEqual([{ type: 'cancel', callId: eng.callId, memberId: 'eng' }])
    expect(events(effects)).toEqual(['stopped'])
    expect(sched.calls.map(c => c.memberId)).toEqual(['res'])
    expect(sched.batches.every(b => b.workOrderId !== 'd1')).toBe(true)
    expect(sched.stopOrder('d1')).toEqual([])
    expect(res.callId).toBeTruthy()
  })

  it('a failed call names its member and order on the event', () => {
    const { sched } = setup()
    const eng = startOf(sched.ownerSaid({ text: '@工程师 跑评测', workOrderId: 'd1' }).effects, 'eng')
    const effects = sched.finished(eng.callId, { status: 'failed', detail: '进程退出' })
    expect(effects.find(e => e.type === 'event')).toMatchObject({ event: 'failed', memberId: 'eng', workOrderId: 'd1' })
  })
})

describe('coordinated order generations', () => {
  it('queued calls retain their generation and a restart discards old running and queued calls', () => {
    const now = () => Date.now()
    const ledger = new MemoryLedger(now)
    let generation = 1
    const engage = (orderId?: string) => orderId ? {generation} : undefined
    const sched = new GroupScheduler({members: MEMBERS, say: ledger, now, engage})
    const first = startOf(sched.ownerSaid({text: '@工程师 完成初始检查', workOrderId: 'd1'}).effects, 'eng')
    const later = sched.dispatchEngagement('relay-next', ['eng'], {triggerSeq: 1, note: '下一项', workOrderId: 'd1'})
    expect(starts(later)).toHaveLength(0)
    expect(sched.snapshot().calls.map(call => call.engagement?.generation)).toEqual([1, 1])
    generation = 2
    const restored = new GroupScheduler({members: MEMBERS, say: ledger, now, engage, state: sched.snapshot()})
    expect(starts(restored.restart([first.callId]))).toHaveLength(0)
    expect(restored.calls).toHaveLength(0)
    expect(starts(restored.dispatchEngagement('relay-revised', ['eng'], {triggerSeq: 1, note: '按新范围继续', workOrderId: 'd1'}))).toHaveLength(1)
    expect(restored.snapshot().calls[0]?.engagement?.generation).toBe(2)
  })
})
