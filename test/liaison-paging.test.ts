import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { liaisonUnread } from '../src/core/liaison-unread.ts'
import { chatCursor, LiaisonChat, offsetSpeech, type ChatMessage, type LiaisonParts } from '../src/dsh/chat.ts'
import { runtimeRoutes, serveApi } from '../src/dsh/http.ts'
import type { SessionEventLike } from '../src/dsh/ports.ts'

const PART = 1_000_000_000
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

/** 一段 `turns` 轮的对话（主人一句、接口人一句），时间从 `start` 起每轮 10 秒。 */
function events(turns: number, start: number, dispatchAt?: number): SessionEventLike[] {
  const rows: SessionEventLike[] = []
  let seq = 0
  const push = (time: number, type: string, data: unknown) => rows.push({ seq: ++seq, time, type, data } as SessionEventLike)
  for (let i = 0; i < turns; i++) {
    const at = start + i * 10_000
    push(at, 'turn/start', {})
    push(at + 1, 'user/message', { source: { kind: 'user', rpcId: 'now-' + i }, content: [{ type: 'text', text: '现在第 ' + i + ' 句' }] })
    if (i === dispatchAt) {
      push(at + 2, 'tool/call', { callId: 'c' + i, name: 'chief_inbox', arguments: '{}' })
      push(at + 3, 'tool/result', { message: { toolCallId: 'c' + i, content: [{ type: 'text', text: 'ok' }] }, meta: { 'dsh-chief/inbox': { eventId: uuid(900) } } })
    }
    push(at + 4, 'assistant/message', { message: { content: [{ type: 'text', text: '回复第 ' + i + ' 句' }] } })
    push(at + 5, 'turn/end', {})
  }
  return rows
}

/** 归档：之前一段的 `count` 条消息，序号未加偏移（第一段偏移为 0）。 */
function archive(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => i % 2
    ? { seq: i + 1, firstSeq: i + 1, role: 'liaison' as const, text: '旧回复 ' + i, time: 1_000 + i * 1_000, ...(i === 1 && { dispatches: [{ eventId: uuid(1), state: 'pending' as const }] }) }
    : { seq: i + 1, role: 'you' as const, text: '旧话 ' + i, time: 1_000 + i * 1_000 })
}

function liaison(archived: ChatMessage[], current: SessionEventLike[]) {
  const parts: LiaisonParts = { current: () => 'hq-p2', base: () => 'hq', offset: () => PART, archived: () => archived, ready: async () => {} }
  const dispatchState = vi.fn((_eventId: string) => ({ state: 'pending' as const }))
  const chat = new LiaisonChat({} as never, parts, async () => ({ id: 'hq-p2', status: 'idle', session: { snapshotEvents: () => current } }) as never,
    () => [], dispatchState)
  return { chat, dispatchState }
}

describe('接口人对话分页', () => {
  const archived = archive(200)
  const current = events(60, 1_000_000, 59)

  it('旧客户端仍拿最近 80 条且没有 page；带 limit 只拿尾窗口', async () => {
    const { chat } = liaison(archived, current)
    const legacy = await chat.view()
    expect(legacy.messages).toHaveLength(80)
    expect(legacy.page).toBeUndefined()
    const tail = await chat.view({ limit: 40 })
    expect(tail.messages).toHaveLength(40)
    expect(tail.messages.map(chatCursor)).toEqual(legacy.messages.slice(-40).map(chatCursor))
    expect(tail.page).toEqual({ older: true, newer: false })
    expect(tail.sessionId).toBe('hq')
  })

  it('按 before 游标跨归档段一直翻到最早，不重不漏', async () => {
    const { chat } = liaison(archived, current)
    let page = await chat.view({ limit: 40 })
    const seen = [...page.messages]
    let pages = 1
    while (page.page?.older) {
      page = await chat.view({ limit: 40, before: chatCursor(seen[0]!) })
      seen.unshift(...page.messages)
      pages++
    }
    expect(seen).toHaveLength(200 + 120)
    expect(pages).toBe(8)
    expect(new Set(seen.map(chatCursor)).size).toBe(seen.length)
    expect(seen[0]!.text).toBe('旧话 0')
    expect(seen.map(m => m.time)).toEqual([...seen.map(m => m.time)].sort((a, b) => a - b))
    // 当前段的消息带换段偏移：游标仍然唯一，且回到同一条。
    const offsetFirst = seen.find(m => m.text === '现在第 0 句')!
    expect(offsetFirst.seq).toBeGreaterThan(PART)
    const around = await chat.view({ limit: 10, around: chatCursor(offsetFirst) })
    expect(around.messages.map(m => m.text)).toContain('现在第 0 句')
    expect(around.messages.some(m => m.text.startsWith('旧'))).toBe(true)
    expect(around.page).toEqual({ older: true, newer: true })
    const after = await chat.view({ limit: 40, after: chatCursor(around.messages.at(-1)!) })
    expect(after.messages[0]!.time).toBeGreaterThan(around.messages.at(-1)!.time)
  })

  it('游标指向不存在的消息时 410', async () => {
    const { chat } = liaison(archived, current)
    await expect(chat.view({ limit: 40, before: '424242' })).rejects.toMatchObject({ status: 410 })
  })

  it('派工状态只解析返回的这一页', async () => {
    const { chat, dispatchState } = liaison(archived, current)
    const tail = await chat.view({ limit: 40 })
    expect(dispatchState.mock.calls.map(([id]) => id)).toEqual([uuid(900)])
    expect(tail.messages.at(-1)!.dispatches).toEqual([{ eventId: uuid(900), state: 'pending' }])
    dispatchState.mockClear()
    const first = await chat.view({ limit: 40, around: chatCursor(archived[1]!) })
    expect(first.messages[1]!.dispatches).toEqual([{ eventId: uuid(1), state: 'pending' }])
    expect(dispatchState.mock.calls.map(([id]) => id)).toEqual([uuid(1)])
  })

  it('未读口径与分页无关：仍按最近 80 条计数', async () => {
    const { chat } = liaison(archived, current)
    const recent = [...archived, ...(chat.project(current).messages.map(m => offsetSpeech(m, PART)))].slice(-80)
    expect(await chat.unread(0)).toEqual(liaisonUnread({ messages: recent, notices: [] }, 0))
    expect((await chat.unread(0)).unread).toBe(40)
  })

  it('GET /chat 把分页参数交给接口人对话；不合法的参数 400', async () => {
    const view = vi.fn(async (_page?: unknown) => ({ messages: [], busy: false, notices: [] }))
    const superhub = { scope: 'brain', route: async () => false, checkScope(value: unknown) { if (value !== 'brain') throw Object.assign(new Error('x'), { status: 409 }) } }
    const route = runtimeRoutes({ engine: {}, brain: {}, roster: {}, chat: { view }, superhub } as never)
    async function call(path: string) {
      const req = Object.assign(Readable.from([]), { method: 'GET', url: '/chief/api' + path, headers: {} }) as unknown as IncomingMessage
      let status = 0
      const res = { headersSent: false, writeHead(code: number) { status = code }, end() {} } as unknown as ServerResponse
      await serveApi(req, res, 'dsh', [route], true)
      return status
    }
    expect(await call('/chat?scope=brain')).toBe(200)
    expect(view).toHaveBeenLastCalledWith(undefined)
    expect(await call('/chat?scope=brain&limit=40&before=17')).toBe(200)
    expect(view).toHaveBeenLastCalledWith({ limit: 40, before: '17' })
    expect(await call('/chat?scope=brain&limit=-1')).toBe(400)
  })
})
