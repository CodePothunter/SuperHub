import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GROUP_SCHEDULER_FILE, GroupEngine, type GroupEngineOptions } from '../src/dsh/workspace-group-engine.ts'
import type { GroupRosterMember, MemberCall, MemberCallSink, MemberRunner } from '../src/dsh/workspace-group-members.ts'

const roster: GroupRosterMember[] = [
  {id: 'liaison', name: '接口人', admin: true, kind: 'dsh'},
  {id: 'writer', name: '整理员', kind: 'dsh'},
  {id: 'reader', name: '核对员', kind: 'dsh'},
]
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

function fixture(engage?: GroupEngineOptions['engage']) {
  const dir = mkdtempSync(join(tmpdir(), 'chief-engagement-scheduler-'))
  cleanup.push(() => rmSync(dir, {recursive: true, force: true}))
  const statePath = join(dir, GROUP_SCHEDULER_FILE)
  const calls: {call: MemberCall; sink: MemberCallSink}[] = []
  const reattached: string[] = []
  const runner: MemberRunner = {
    async run(call, sink) { calls.push({call, sink}) },
    async continue() {},
    cancel() {},
    async reattach(call) { reattached.push(call.callId); return false },
    dispose() {},
  }
  function open() {
    const engine = new GroupEngine({
      dir, scope: 'scope', workspaceId: 'workspace', groupId: 'group', roster: () => roster,
      workDir: () => dir, info: () => ({workspaceName: '资料整理', title: '核对版本', goal: ''}),
      runners: {dsh: runner}, engage,
    })
    cleanup.push(() => engine.dispose())
    return engine
  }
  return {open, calls, reattached, statePath}
}

describe('交接派发和回执恢复', () => {
  it('写调度失败不启动成员，重试和重开都只派一次', async () => {
    const {open, calls, statePath} = fixture(() => ({generation: 1}))
    const engine = open()
    await engine.start()
    // Occupy the atomic write's temporary path; this affects the scheduler but not the ledger.
    mkdirSync(statePath + '.tmp')
    try {
      expect(() => engine.dispatchEngagement('dispatch-1', ['writer'], '请核对版本', 'order')).toThrow()
      expect(calls).toHaveLength(0)
      expect(engine.ledger.all().filter(line => line.ref === 'dispatch-1')).toHaveLength(1)
      expect(engine.view().members.find(member => member.memberId === 'writer')?.status).toBe('idle')
    } finally { rmdirSync(statePath + '.tmp') }

    engine.dispatchEngagement('dispatch-1', ['writer'], '请核对版本', 'order')
    engine.dispatchEngagement('dispatch-1', ['writer'], '请核对版本', 'order')
    expect(calls).toHaveLength(1)
    const first = calls[0]!
    first.sink.finished(first.call.callId, {status: 'completed', text: '已核对原件与修订版。', toolCalls: 0})
    engine.dispose()
    const reopened = open()
    await reopened.start()
    reopened.dispatchEngagement('dispatch-1', ['writer'], '请核对版本', 'order')
    expect(calls).toHaveLength(1)
    expect(reopened.ledger.all().filter(line => line.ref === 'dispatch-1')).toHaveLength(1)
  })

  it('回执先写入群账本时，重启不会把已经交回的调用记为中断', async () => {
    const {open, calls, reattached, statePath} = fixture(() => ({generation: 3}))
    const engine = open()
    await engine.start()
    engine.dispatchEngagement('dispatch-2', ['reader'], '请核对两份记录', 'order')
    const inProgress = readFileSync(statePath)
    const first = calls[0]!
    first.sink.finished(first.call.callId, {status: 'completed', text: '两份记录一致。', toolCalls: 0})
    engine.dispose()
    // Reproduce a restart after the terminal message append, before its scheduler update.
    writeFileSync(statePath, inProgress)

    const reopened = open()
    await reopened.start()
    expect(reattached).toEqual([])
    expect(reopened.ledger.all().filter(line => line.event === 'interrupted')).toEqual([])
    expect(reopened.ledger.all().filter(line => line.engagement?.callId === first.call.callId)).toEqual([
      expect.objectContaining({text: '两份记录一致。', engagement: expect.objectContaining({generation: 3})}),
    ])
    expect(reopened.view().members.find(member => member.memberId === 'reader')?.status).toBe('idle')
  })

  it('无工单发言转交后保留 @ 的唯一接收人和成员间空转保护', async () => {
    const {open, calls} = fixture(() => ({}))
    const engine = open()
    await engine.start()
    const owner = engine.note({speaker: 'owner', requestId: 'group-post', text: '@整理员 跟核对员打招呼'})
    engine.forwardEngagementOwner('forward-owner', owner)
    engine.forwardEngagementOwner('forward-owner', owner)
    expect(calls.map(({call}) => call.member.id)).toEqual(['writer'])

    for (let index = 0; index < 12 && !engine.view().paused; index++) {
      const {call, sink} = calls.at(-1)!
      const next = roster.find(member => member.id === (call.member.id === 'writer' ? 'reader' : 'writer'))!
      sink.finished(call.callId, {status: 'completed', text: `@${next.name} 好的，收到`, toolCalls: 0})
      const line = engine.ledger.all().findLast(row => row.kind === 'message')!
      expect(line.mentions).toEqual([next.id])
      const before = calls.length
      engine.forwardEngagementMember('forward-' + line.seq, line)
      engine.forwardEngagementMember('forward-' + line.seq, line)
      expect(calls.length - before).toBe(engine.view().paused ? 0 : 1)
      if (!engine.view().paused) expect(calls.at(-1)?.call.member.id).toBe(next.id)
    }
    expect(engine.view().paused).toMatchObject({parked: 1})
    expect(engine.ledger.all().filter(line => line.event === 'paused')).toHaveLength(1)
  })

  it('工单新版本已写入时，重启不续接或启动旧版本的调用', async () => {
    let generation = 1
    const {open, calls, reattached} = fixture(() => ({generation}))
    const engine = open()
    await engine.start()
    engine.dispatchEngagement('old-active', ['writer'], '按旧范围整理', 'order')
    engine.dispatchEngagement('old-queued', ['writer'], '按旧范围补做', 'order')
    expect(calls).toHaveLength(1)
    expect(engine.view().members.find(member => member.memberId === 'writer')?.queued).toBe(1)
    generation = 2
    engine.dispose()
    const reopened = open()
    await reopened.start()
    expect(reattached).toEqual([])
    expect(calls).toHaveLength(1)
    expect(reopened.view().members.find(member => member.memberId === 'writer')).toMatchObject({status: 'idle', queued: 0})
    reopened.dispatchEngagement('new-work', ['writer'], '按新范围整理', 'order')
    expect(calls).toHaveLength(2)
    expect(calls.at(-1)?.call.prompt).toContain('按新范围整理')
  })
})
