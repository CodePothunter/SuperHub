import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2DialogueSource, V2Message, V2Session, V2TurnInput } from '../src/core/workspace-v2.ts'
import { serveApi } from '../src/dsh/http.ts'
import { Outbox } from '../src/dsh/outbox.ts'
import type { AcceptanceReviewer, AcceptanceVerdict } from '../src/dsh/workspace-acceptance.ts'
import { workspaceV2Routes } from '../src/dsh/workspace-v2.ts'
import { WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'

const roots: string[] = []
const cleanup: (() => void)[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-liaison-reminders-')); roots.push(p); return p }
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

const scope = 'brain-r'
const pass: AcceptanceVerdict = { verdict: 'pass', message: '都已交付。', gaps: [] }
type Behaviour = (input: V2TurnInput, signal: AbortSignal) => Promise<void> | void

/** A router whose reminders go to a real outbox (key-deduplicated), restartable on the same brain. */
function fixture(review: AcceptanceReviewer | undefined, behave: Behaviour = () => {}) {
  const root = temp()
  const outbox = new Outbox(join(root, 'ops', 'outbox.json'))
  const remind = vi.fn((key: string, text: string, order?: { workspaceId: string; orderId: string }, options?: { localOnly?: boolean }) => {
    outbox.enqueue(key, text, new Date(), undefined, { ...order && { order }, ...options?.localOnly && { localOnly: true } })
  })
  const sent: V2TurnInput[] = []
  const replies = new Map<string, V2Message[]>()
  let act = behave
  const source: V2DialogueSource = {
    read: async () => ({ messages: [] }),
    attachment: async () => undefined,
    send: async (_session: V2Session, input: V2TurnInput, signal: AbortSignal) => {
      sent.push(structuredClone(input))
      await act(input, signal)
      replies.set(input.id, [{ id: 'r-' + input.id, role: 'agent', author: 'Codex', at: new Date().toISOString(), text: '工单回报\n交了周报。', workOrderId: input.workOrderId }])
    },
    savedResults: (_s, id) => replies.has(id) ? { messages: replies.get(id)!, attachments: [] } : undefined,
    note: () => {},
  }
  let store = new WorkspaceV2Store(root, scope)
  let route = workspaceV2Routes({ store, source, review, remind })
  cleanup.push(() => route.dispose())
  async function call(path: string, body: Record<string, unknown>) {
    const url = new URL('/chief/api/v2' + path, 'http://local')
    url.searchParams.set('scope', scope)
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: 'POST', url: url.pathname + url.search, headers: { 'x-chief-request': '1' } }) as unknown as IncomingMessage
    let status = 0
    const res = { writeHead(code: number) { status = code }, end() {} } as unknown as ServerResponse
    await serveApi(req, res, 'dsh', [route], true)
    return status
  }
  return {
    outbox, remind, sent, call, store: () => store, route: () => route, behave: (next: Behaviour) => { act = next },
    /** The host stops (turns in flight stay `pending` on disk) and starts again on the same brain. */
    restart() {
      route.dispose()
      store = new WorkspaceV2Store(root, scope)
      route = workspaceV2Routes({ store, source, review, remind })
      route.recover()
    },
    keys: () => outbox.recent(50).map(n => n.key),
  }
}
const brief = { title: '本周周报', promise: '一页周报' }

describe('接口人汇报：工单完成、待决定与中断', () => {
  it('reports a passed acceptance once as a local-only reminder that opens the order', async () => {
    const f = fixture(async () => pass)
    const job = f.route().assign('src-done', '写本周周报。', 'codex', undefined, undefined, brief)
    await vi.waitFor(() => expect(f.keys()).toHaveLength(1))
    const turnId = f.sent[0]!.id
    expect(f.outbox.recent(5)[0]).toMatchObject({ key: 'workspace-done:' + job.delegation.id + ':' + turnId, push: 'local',
      order: { workspaceId: job.workspace.id, orderId: job.delegation.id } })
    expect(f.outbox.recent(5)[0]!.text).toBe('「本周周报」已完成，接口人验收通过。打开工单查看成果。')
    f.restart()
    f.restart()
    expect(f.keys()).toEqual(['workspace-done:' + job.delegation.id + ':' + turnId])
  })

  it('reports a turn the executor failed to finish, but not one the owner stopped', async () => {
    const f = fixture(undefined, () => { throw new Error('编程工具本轮把关异常：命令「rm -rf build」没有经过 SuperHub 命令把关，已中断本轮。') })
    const job = f.route().assign('src-breach', '清理构建目录。', 'codex', undefined, undefined, brief)
    await vi.waitFor(() => expect(f.keys()).toHaveLength(1))
    const [notice] = f.outbox.recent(5)
    expect(notice).toMatchObject({ key: 'workspace-stalled:' + job.delegation.id + ':' + f.sent[0]!.id, push: 'pending',
      order: { workspaceId: job.workspace.id, orderId: job.delegation.id } })
    expect(notice!.text).toBe('「本周周报」这一轮执行中断了：编程工具本轮把关异常：命令「rm -rf build」没有经过 SuperHub 命令把关，已中断本轮。打开工单让执行者汇报或继续。')

    // Paused by the owner while running: the stop is the owner's own doing.
    const g = fixture(undefined, (_input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))))
    const other = g.route().assign('src-pause', '写周报。', 'codex', undefined, undefined, brief)
    await vi.waitFor(() => expect(g.sent).toHaveLength(1))
    expect(await g.call('/workspaces/' + other.workspace.id + '/orders/' + other.delegation.id + '/action', { requestId: 'pause-1', action: 'pause', expectedGeneration: 1 })).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(g.keys()).toEqual([])
  })

  it('reports work that never started on its own, once', async () => {
    const f = fixture(undefined, () => { throw Object.assign(new Error('项目目录不可用：/work/site 不存在'), { dispatched: false }) })
    const job = f.route().assign('src-unsent', '改首页。', 'codex', undefined, undefined, brief)
    await vi.waitFor(() => expect(f.keys()).toHaveLength(1))
    expect(f.outbox.recent(5)[0]).toMatchObject({ key: 'workspace-stalled:' + job.delegation.id + ':' + f.sent[0]!.id })
    expect(f.outbox.recent(5)[0]!.text).toBe('「本周周报」这一轮没能开始：项目目录不可用：/work/site 不存在。打开工单重新发起或调整。')
  })

  it('reports an acceptance review that could not finish', async () => {
    const f = fixture(async () => { throw new Error('模型暂不可用') })
    const job = f.route().assign('src-review', '写周报。', 'codex', undefined, undefined, brief)
    await vi.waitFor(() => expect(f.keys()).toHaveLength(1))
    expect(f.outbox.recent(5)[0]).toMatchObject({ key: 'workspace-stalled:' + job.delegation.id + ':' + f.sent[0]!.id,
      text: '「本周周报」的接口人验收没有完成：模型暂不可用。打开工单查看成果并决定下一步。' })
  })

  it('reports a turn a restart cut off once, also over further restarts', async () => {
    const f = fixture(undefined, () => new Promise(() => {}))
    const job = f.route().assign('src-restart', '写周报。', 'codex', undefined, undefined, brief)
    await vi.waitFor(() => expect(f.sent).toHaveLength(1))
    const turnId = f.sent[0]!.id
    f.behave(() => {})
    f.restart()
    expect(f.store().unknownTurns(job.session.id)).toEqual([turnId])
    expect(f.outbox.recent(5)).toEqual([expect.objectContaining({ key: 'workspace-stalled:' + job.delegation.id + ':' + turnId,
      text: '「本周周报」的执行在服务重启时中断了，打开工单让执行者汇报或继续。', order: { workspaceId: job.workspace.id, orderId: job.delegation.id } })])
    // The board forgets the mark once the owner was told; the outbox would deduplicate it anyway.
    expect(f.store().interruptedTurns()).toEqual([])
    const calls = f.remind.mock.calls.length
    f.restart()
    expect(f.remind.mock.calls.length).toBe(calls)
    expect(f.keys()).toHaveLength(1)
  })
})
