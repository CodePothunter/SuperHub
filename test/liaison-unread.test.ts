import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { liaisonUnread, unreadBadge } from '../src/core/liaison-unread.ts'
import { privateBrainData } from '../src/dsh/brain-private.ts'
import { chatFromEvents, LiaisonChat, type ChatView } from '../src/dsh/chat.ts'
import { runtimeRoutes, serveApi, type Via } from '../src/dsh/http.ts'
import { LIAISON_SEEN_FILE, LiaisonSeen } from '../src/dsh/liaison-seen.ts'
import { Outbox } from '../src/dsh/outbox.ts'
import type { SessionEventLike } from '../src/dsh/ports.ts'

const roots: string[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-liaison-unread-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

const iso = (ms: number) => new Date(ms).toISOString()

describe('outbox order binding', () => {
  it('keeps the work order of a reminder across a reopen, once per key, and local-only results stay local', () => {
    const file = join(temp(), 'ops', 'outbox.json')
    const outbox = new Outbox(file)
    const order = { workspaceId: 'w1', orderId: 'd1' }
    expect(outbox.enqueue('workspace-done:d1:t1', '「周报」已完成', new Date(1_000), undefined, { order, localOnly: true })).toBe(true)
    expect(outbox.enqueue('workspace-done:d1:t1', '又一次', new Date(2_000), undefined, { order })).toBe(false)
    expect(outbox.enqueue('workspace-stalled:d1:t2', '「周报」中断了', new Date(3_000), undefined, { order })).toBe(true)
    const reopened = new Outbox(file).recent(10)
    expect(reopened).toEqual([
      expect.objectContaining({ key: 'workspace-done:d1:t1', text: '「周报」已完成', order, push: 'local' }),
      expect.objectContaining({ key: 'workspace-stalled:d1:t2', order, push: 'pending' }),
    ])
    expect(reopened[0]).not.toHaveProperty('ticketId')
  })
})

describe('liaison seen marker', () => {
  it('starts from now on first use and after a damaged file, moves only forward and never past now', () => {
    const root = temp()
    const file = join(root, 'ops', LIAISON_SEEN_FILE)
    let clock = 10_000
    const seen = new LiaisonSeen(file, () => clock)
    expect(seen.get()).toBe(10_000)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ seenAt: iso(10_000) })
    clock = 20_000
    expect(seen.mark(iso(15_000))).toBe(15_000)
    expect(seen.mark(12_000)).toBe(15_000) // an older window does not move it back
    expect(seen.mark(iso(99_000))).toBe(20_000) // a client clock ahead is clamped to now
    expect(() => seen.mark('later')).toThrow('已读时间无效')
    expect(new LiaisonSeen(file, () => 30_000).get()).toBe(20_000)
    writeFileSync(file, '{broken')
    expect(new LiaisonSeen(file, () => 40_000).get()).toBe(40_000)
  })

  it('is private to this machine: not read through the brain files nor staged by git', () => {
    expect(privateBrainData(['ops', LIAISON_SEEN_FILE])).toBe(true)
    expect(privateBrainData(['ops', 'outbox.json'])).toBe(false)
  })
})

describe('liaison unread count', () => {
  const view = (patch: Partial<ChatView> = {}): ChatView => ({ messages: [], busy: false, notices: [], ...patch })
  it('counts settled liaison replies, discussion results and open reminders after the seen point', () => {
    const counted = view({
      messages: [
        { seq: 1, role: 'you', text: '帮我整理周报', time: 50 },
        { seq: 2, role: 'liaison', text: '旧回复', time: 90 },
        { seq: 3, role: 'liaison', text: '', time: 120 }, // no public content
        { seq: 4, role: 'liaison', text: '已经交给团队', time: 110 },
        // began before the owner looked, finished after: unread once it lands
        { seq: 6, firstSeq: 5, role: 'liaison', text: '补充', time: 95, lastTime: 130 },
      ],
      notices: [
        { key: 'workspace-done:d1:t1', at: iso(140), text: '「周报」已完成', order: { workspaceId: 'w', orderId: 'd1' } },
        { key: 'workspace-approval:d1:a', at: iso(150), text: '命令待批准', done: true },
        { key: 'need:T-1:you/review:1', at: iso(160), text: '旧工单', ticketId: 'T-1' },
        { key: 'morning:2026-11-23', at: iso(80), text: '早上好' },
      ],
      discussionResults: [{ id: 'r1', roomId: 'room', title: '讨论', text: '结果', at: iso(170), status: 'ready' }],
    })
    expect(liaisonUnread(counted, 100)).toEqual({ unread: 4, latestAt: iso(170) })
    expect(liaisonUnread(counted, 200)).toEqual({ unread: 0 })
    expect(liaisonUnread(view(), 0)).toEqual({ unread: 0 })
  })

  it('records when an aggregated liaison reply was last updated', () => {
    const event = (seq: number, time: number, type: string, data: unknown): SessionEventLike => ({ seq, time, type, data } as SessionEventLike)
    const text = (t: string) => ({ message: { content: [{ type: 'text', text: t }] } })
    const { messages } = chatFromEvents([
      event(1, 10, 'turn/start', {}),
      event(2, 11, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] }),
      event(3, 20, 'assistant/message', text('在。')),
      event(4, 45, 'assistant/message', text('已经查好了。')),
      event(5, 46, 'turn/end', {}),
      event(6, 50, 'turn/start', {}),
      event(7, 51, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '好' }] }),
      event(8, 60, 'assistant/message', text('收到')),
      event(9, 61, 'turn/end', {}),
    ])
    expect(messages.filter(m => m.role === 'liaison').map(m => [m.text, m.time, m.lastTime])).toEqual([['在。\n\n已经查好了。', 20, 45], ['收到', 60, undefined]])
  })

  it('counts from the conversation itself without the heavy parts of the full view', async () => {
    const event = (seq: number, time: number, type: string, data: unknown): SessionEventLike => ({ seq, time, type, data } as SessionEventLike)
    const events = [
      event(1, 10, 'turn/start', {}),
      event(2, 11, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] }),
      event(3, 300, 'assistant/message', { message: { content: [{ type: 'text', text: '在。' }] } }),
      event(4, 301, 'turn/end', {}),
    ]
    const asked: unknown[] = []
    const workReplies = vi.fn(() => [])
    const chat = new LiaisonChat({} as never, 'hq', async () => ({ id: 'hq', status: 'idle', session: { snapshotEvents: () => events } }) as never,
      () => [{ key: 'workspace-done:d:t', at: iso(400), text: '「周报」已完成' }], undefined, workReplies, undefined,
      async (_receipts, options) => { asked.push(options); return [{ id: 'r', roomId: 'room', title: '讨论', text: '结果', at: iso(500), status: 'ready' as const }] })
    expect(await chat.unread(200)).toEqual({ unread: 3, latestAt: iso(500) })
    expect(asked).toEqual([{ historical: false }])
    expect(workReplies).not.toHaveBeenCalled()
    await chat.view()
    expect(asked).toEqual([{ historical: false }, undefined])
  })

  it('shows 99+ beyond 99 and nothing at zero', () => {
    expect([0, 1, 99, 100, 512].map(unreadBadge)).toEqual([undefined, '1', '99', '99+', '99+'])
  })
})

describe('GET /chat/unread and POST /chat/seen', () => {
  function fixture() {
    const root = temp()
    let clock = 1_000
    const seen = new LiaisonSeen(join(root, 'ops', LIAISON_SEEN_FILE), () => clock)
    let chatView: ChatView = { messages: [], busy: false, notices: [] }
    const chat = { view: async () => chatView, unread: async (at: number) => liaisonUnread(chatView, at) }
    const superhub = { scope: 'brain', route: async () => false, checkScope(value: unknown) { if (value !== 'brain') throw Object.assign(new Error('第二大脑已切换'), { status: 409 }) } }
    const route = runtimeRoutes({ engine: {}, brain: {}, roster: {}, chat, superhub, liaisonSeen: seen } as never)
    async function call(path: string, body?: Record<string, unknown>, options: { via?: Via; owner?: boolean; headers?: Record<string, string> } = {}) {
      const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
        method: body ? 'POST' : 'GET', url: '/chief/api' + path, headers: options.headers ?? { 'x-chief-request': '1' },
      }) as unknown as IncomingMessage
      let status = 0, data: Record<string, unknown> = {}
      const res = { headersSent: false, writeHead(code: number) { status = code }, end(value: string) { data = JSON.parse(value) } } as unknown as ServerResponse
      await serveApi(req, res, options.via ?? 'dsh', [route], options.owner ?? true)
      return { status, data }
    }
    return { call, set: (next: ChatView) => { chatView = next }, tick: (ms: number) => { clock = ms } }
  }

  it('counts after the shared seen point; marking it clears the count for every window', async () => {
    const f = fixture()
    expect((await f.call('/chat/unread?scope=brain')).data).toEqual({ scope: 'brain', unread: 0 })
    f.set({ messages: [{ seq: 1, role: 'liaison', text: '「周报」已完成', time: 2_000 }], busy: false,
      notices: [{ key: 'workspace-stalled:d:t', at: iso(3_000), text: '中断了', order: { workspaceId: 'w', orderId: 'd' } }] })
    expect((await f.call('/chat/unread?scope=brain')).data).toEqual({ scope: 'brain', unread: 2, latestAt: iso(3_000) })
    f.tick(5_000)
    expect((await f.call('/chat/seen?scope=brain', { at: iso(2_500) })).data).toEqual({ scope: 'brain', seenAt: iso(2_500) })
    expect((await f.call('/chat/unread?scope=brain')).data).toMatchObject({ unread: 1 })
    await f.call('/chat/seen?scope=brain', { at: 4_000 })
    // Another window (the phone) reads the same server-side state.
    expect((await f.call('/chat/unread?scope=brain', undefined, { via: 'public' })).data).toEqual({ scope: 'brain', unread: 0 })
  })

  it('refuses other brains, non-owners, writes without the request mark and an invalid time', async () => {
    const f = fixture()
    expect((await f.call('/chat/unread?scope=other')).status).toBe(409)
    expect((await f.call('/chat/unread')).status).toBe(409)
    expect((await f.call('/chat/unread?scope=brain', undefined, { owner: false })).status).toBe(403)
    expect((await f.call('/chat/seen?scope=brain', { at: iso(500) }, { owner: false })).status).toBe(403)
    expect((await f.call('/chat/seen?scope=brain', { at: iso(500) }, { headers: {} })).status).toBe(403)
    expect((await f.call('/chat/seen?scope=brain', { at: 'soon' })).status).toBe(400)
  })
})
