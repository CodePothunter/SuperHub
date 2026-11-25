import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Executors } from '../src/core/engine.ts'
import { FileStore } from '../src/core/store.ts'
import type { PendingCommand } from '../src/dsh/approvals.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { serveApi, type Via } from '../src/dsh/http.ts'
import type { HostContext } from '../src/dsh/ports.ts'
import { FileRemoteQueue } from '../src/dsh/remote.ts'
import { NativeRooms } from '../src/dsh/rooms.ts'
import { Roster } from '../src/dsh/roster.ts'
import { SuperhubGoals } from '../src/dsh/superhub-goals.ts'
import { SuperhubSaa } from '../src/dsh/superhub-saa.ts'
import { createSuperhubTrace } from '../src/dsh/superhub-trace.ts'
import { superhubWorkspaceRoutes } from '../src/dsh/superhub-workspace.ts'
import { SuperhubIntake } from '../src/dsh/superhub.ts'
import { commandDecisions, warroomState, type CommandDecision } from '../src/dsh/view.ts'

const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

const pending = (ticket: string, expiresAt: string, command = `printf "needs network ${ticket}"`): PendingCommand => ({
  id: `approval-${ticket}`, ticket, title: `工单 ${ticket}`, staff: '工程师', staffId: 'engineer', command, workdir: `/brain/work/${ticket}`,
  mode: 'danger-full-access', reason: '需要联网', executor: 'codex', assignmentId: `A-${ticket}`, requestedAt: '2026-11-19T09:13:00.000Z', expiresAt,
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'chief-command-decisions-'))
  cleanup.push(() => rmSync(directory, { force: true, recursive: true }))
  const scope = 'scope-a', root = join(directory, 'brain')
  const store = new FileStore(root)
  mkdirSync(join(root, 'staff'), { recursive: true })
  writeFileSync(join(root, 'staff', 'engineer.md'), '---\nname: 工程师\nexecutor: codex\nverifier: reviewer\n---\n写代码。\n')
  const brain = new BrainRepo(root)
  const run = vi.fn<Executors['run']>(async () => { throw new Error('fixture work stays paused') })
  let superhub: SuperhubIntake
  const engine = new Engine(store, brain, { available: () => true, supportsSchema: () => true, run }, { dispatch: vi.fn(), cancel: vi.fn() },
    { concurrency: 1, timeZone: 'UTC', brainScope: scope, canStartSuperhub: authorization => superhub.allowsCommand(authorization) })
  engine.setPaused(true)
  superhub = new SuperhubIntake({ root, chiefHome: join(directory, 'app'), brainScope: scope, engine, staff: () => brain.staff() })
  const host = { get: () => undefined } as unknown as HostContext
  const rooms = new NativeRooms(host, root, () => brain.staff())
  const trace = createSuperhubTrace(host, engine, scope, { brainRoot: root, staff: () => brain.staff() })
  cleanup.push(() => { engine.stop(); trace.dispose(); rooms.dispose() })
  const at = '2026-11-19T09:00:00.000Z'
  for (const id of ['T-0001', 'T-0002']) {
    store.appendEvent({ id, at, source: 'inbox', dedupe: id, text: `工单 ${id}` })
    store.setDisposition(id, { kind: 'accepted', ticketId: id })
    store.saveTicket({ id, title: `工单 ${id}`, staff: 'engineer', createdAt: at, priority: 1, events: [id], inputs: [], assignments: [],
      mandate: { eventId: id, scope: '调大构建脚本超时', level: 'think', strength: 'explicit', needsReview: true, doneWhen: ['完成'] } })
  }
  const rows = [pending('T-0002', '2026-11-19T09:43:00.000Z'), pending('T-0001', '2026-11-19T09:40:00.000Z'), pending('T-9999', '2026-11-19T09:30:00.000Z')]
  const commands = () => rows
  const deps = {
    engine, brain, brainScope: scope, remote: new FileRemoteQueue(root), roster: new Roster(root, brain, () => '2026-11-19'), rooms,
    available: () => true, clock: () => ({ today: '2026-11-19', now: '2026-11-19T17:20' }), sources: () => [], push: () => false,
  }
  const workspace = superhubWorkspaceRoutes({ scope, brain, engine, trace, rooms, superhub, commands,
    goals: new SuperhubGoals(root, vi.fn()), saa: new SuperhubSaa(root, vi.fn()) })
  async function overview(via: Via, owner: boolean) {
    const req = Object.assign(Readable.from([]), { method: 'GET', url: `/chief/api/superhub/overview?scope=${scope}`, headers: {} }) as unknown as IncomingMessage
    let code = 0, result: { commands?: CommandDecision[] } = {}
    const res = { writeHead(status: number) { code = status }, end(value: string) { result = JSON.parse(value) } } as unknown as ServerResponse
    await serveApi(req, res, via, [workspace], owner)
    return { code, result }
  }
  return { deps, commands, overview }
}

describe('等你决定里的命令审批', () => {
  it('只列当前第二大脑可见的工单，按过期时间排序并给出单行摘要', () => {
    const multiline = pending('T-0003', '2026-11-19T10:00:00.000Z', `curl -sS https://example.invalid/a \\\n  --retry 3 ${'x'.repeat(300)}`)
    const rows = commandDecisions([pending('T-0002', '2026-11-19T09:43:00.000Z'), multiline, pending('T-0001', '2026-11-19T09:40:00.000Z'), pending('T-9', '2026-11-19T09:00:00.000Z')],
      id => id !== 'T-9')
    expect(rows.map(row => row.ticket)).toEqual(['T-0001', 'T-0002', 'T-0003'])
    expect(rows[0]).toMatchObject({ id: 'approval-T-0001', staff: '工程师', title: '工单 T-0001', summary: 'printf "needs network T-0001"', expiresAt: '2026-11-19T09:40:00.000Z', executor: 'codex' })
    expect(rows[2]!.summary).not.toContain('\n')
    expect(rows[2]!.summary.length).toBeLessThanOrEqual(160)
    expect(rows[2]!.command).toBe(multiline.command)
  })

  it('工作区编程会话的命令只在 SuperHub 工单上决定，即使编号碰巧与原生工单相同也不进原生列表', () => {
    const coding = {...pending('T-0001', '2026-11-19T09:30:00.000Z'), id: 'a-1',
      workspace: {scope: 'brain', workspaceId: 'w1', sessionId: 's1', orderId: 'T-0001', turnId: 't1', tool: 'codex' as const}}
    expect(commandDecisions([coding, pending('T-0002', '2026-11-19T09:43:00.000Z')], () => true).map(row => row.id)).toEqual(['approval-T-0002'])
  })

  it('作战台状态把待审批命令计入等你决定；未提供命令来源时不出现', () => {
    const { deps, commands } = fixture()
    const plain = warroomState(deps)
    expect(plain.commands).toBeUndefined()
    const owner = warroomState({ ...deps, commands })
    expect(owner.commands?.map(row => row.ticket)).toEqual(['T-0001', 'T-0002'])
    expect(owner.poc.situation.decide).toBe(plain.poc.situation.decide + 2)
    // 工具出口要求无损 JSON：投影里不能有 undefined 属性。
    expect(JSON.parse(JSON.stringify(owner.commands))).toEqual(owner.commands)
  })

  it('SuperHub 总览只在电脑上的 DSH 里给主人列出命令，手机网关不带命令原文', async () => {
    const { overview } = fixture()
    const desktop = await overview('dsh', true)
    expect(desktop.code).toBe(200)
    expect(desktop.result.commands?.map(row => row.ticket)).toEqual(['T-0001', 'T-0002'])
    const phone = await overview('public', true)
    expect(phone.code).toBe(200)
    expect(phone.result.commands).toBeUndefined()
  })
})
