import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../src/client/api.ts'
import { pendingIntent } from '../src/client/request-id.ts'
import { WorkspaceLiaison } from '../src/client/workspace-liaison.tsx'
import * as v2 from '../src/client/workspace-v2-api.ts'
import { UnreadBadge, unreadLabel, useLiaisonUnread } from '../src/client/workspace-liaison-unread.tsx'
import { reconcilePending } from '../src/client/chat-state.ts'
import type { ChatInputAttachment } from '../src/core/chat-attachments.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const noPaging = { hasOlder: false, hasNewer: false, loadOlder: vi.fn(), loadNewer: vi.fn(), toLatest: vi.fn(), loadingOlder: false, olderError: undefined as string | undefined, loadingNewer: false, newerError: undefined as string | undefined }

describe('一句话交办', () => {
  it('opens attachment-only history in the private conversation even when the dialog is opened from an order', () => {
    const file: ChatInputAttachment = {id:'one', name:'report.html', kind:'file', bytes:1024}
    const image: ChatInputAttachment = {id:'two', name:'图.png', kind:'image', bytes:42}
    vi.spyOn(api, 'useChat').mockReturnValue({
      sessionId:'hq', confirmedMessages:[], observedAt:3, messages:[{seq:1, time:1, role:'you', text:'', inputAttachments:[file, image]}],
      live:undefined, notices:[], workReplies:[], busy:false, error:undefined, say:vi.fn(), refresh:vi.fn(), tick:0,  ...noPaging,
    })
    const html = renderToStaticMarkup(<WorkspaceLiaison scope="brain" surface="workspace" workspace={{id:'w', name:'工作区'}} sessionId="group" workOrderId="order"
      changed={vi.fn()} close={vi.fn()} openProfileImport={vi.fn()} openWorkspace={vi.fn()}/>)
    expect(html).toContain('href="/chief/api/input-attachments/one?scope=brain&amp;sessionId=hq" download="report.html"')
    expect(html).toContain('aria-label="查看图片 图.png"')
    expect(html).not.toContain('workOrderId=')
  })

  it('matches repeated text and attachment-only retries to their original requests, including lost responses', () => {
    const file: ChatInputAttachment = {id:'A', name:'same.txt', kind:'file', bytes:1}
    const pending = {id:1, time:30, text:'', afterSeq:5, requestId:'this-request', inputAttachments:[file]}
    const owner = {seq:6, time:29, role:'you' as const, text:'', inputAttachments:[file]}
    expect(reconcilePending([pending], [owner, {...owner, requestId:'another-request'}])).toMatchObject([{id:1}])
    expect(reconcilePending([pending], [{...owner, seq:3, requestId:'this-request'}])).toEqual([])
    const old = {...pending, requestId:undefined, text:'同一原话'}
    expect(reconcilePending([old], [{...owner, text:old.text, inputAttachments:[{...file, id:'B'}]}])).toMatchObject([{id:1}])
    expect(reconcilePending([old], [{...owner, text:old.text}])).toEqual([])
  })
  it('原对话按时间直接显示讨论回报正文，查看过程是可选入口', () => {
    vi.spyOn(api, 'useChat').mockReturnValue({
      sessionId: 'hq', confirmedMessages: [], observedAt: 3, messages: [
        { seq: 1, time: 1, role: 'you', text: '让他们自我介绍一下' },
        { seq: 2, time: 2, role: 'liaison', text: '已经发起。', discussions: [{ id: 'room', title: '幕僚团自我介绍' }] },
      ], discussionResults: [{ id: 'result-1', roomId: 'room', title: '幕僚团自我介绍', at: new Date(3).toISOString(),
        status: 'partial', text: '**研究员**负责查证。工程师尚未答复。' }],
      live: undefined, notices: [], workReplies: [], busy: false, error: undefined, say: vi.fn(), refresh: vi.fn(), tick: 0,  ...noPaging,
    })
    const html = renderToStaticMarkup(<WorkspaceLiaison scope="brain" surface="today" changed={vi.fn()} close={vi.fn()} openProfileImport={vi.fn()} openRoom={vi.fn()} openWorkspace={vi.fn()}/>)
    expect(html).toMatch(/已经发起。.+部分结果 · 幕僚团自我介绍.+研究员.*负责查证。工程师尚未答复。.+查看讨论过程/s)
    expect(html).not.toContain('接口人提醒')
  })
  it('shows public speech and review receipts while omitting retired ticket links', () => {
    vi.spyOn(api, 'useChat').mockReturnValue({
      sessionId: 'hq', confirmedMessages: [], observedAt: 0, messages: [
        { seq: 1, time: 1, role: 'you', text: '帮我跟一下这件事' },
        { seq: 2, time: 2, role: 'liaison', text: '我已把跟进交给团队。', dispatches: [{ eventId: 'event', state: 'accepted', ticketId: 'T-0042' }],
          workspaces: [{id:'actual-workspace',name:'评审'}],
          steps: [{ kind: 'think', label: 'private step', detail: 'private detail', done: true }] },
        { seq: 3, time: 3, role: 'liaison', text: '', profileImports: [{importId:'profile-' + 'a'.repeat(64)}] },
      ], live: undefined, notices: [{key:'retired',at:'2026-11-22T08:00:00Z',text:'旧工单提醒',ticketId:'T-0042'}],
      workReplies: [], busy: false, error: undefined, say: vi.fn(), refresh: vi.fn(), tick: 0,  ...noPaging,
    })
    const html = renderToStaticMarkup(<WorkspaceLiaison scope="brain" surface="today" changed={vi.fn()} close={vi.fn()} openProfileImport={vi.fn()} openWorkspace={vi.fn()}/>)
    expect(html).toContain('aria-label="接口人"')
    expect(html).toContain('对接口人说')
    expect(html).toContain('帮我跟一下这件事')
    expect(html).toContain('我已把跟进交给团队。')
    expect(html).toContain('核对资料')
    expect(html).not.toMatch(/T-0042|旧工单提醒/)
    expect(html).toContain('打开工作区「评审」')
    expect(html).not.toMatch(/创建工作区|归属工作区|负责人|承诺结果|private step|private detail/)
  })

  it('opens real work orders from both saved and live replies for different kinds of outcomes', () => {
    const receipt = {id:'personal',name:'我的工作区',delegationId:'review',delegationTitle:'本周简报'}
    vi.spyOn(api, 'useChat').mockReturnValue({
      sessionId:'hq', confirmedMessages:[], observedAt:0, messages:[{seq:1,time:1,role:'liaison',text:'已接手',workspaces:[receipt]}],
      live:{since:2,steps:[],text:'',workspaces:[{...receipt,delegationId:'next',delegationTitle:'下期报名'}]},
      notices:[], workReplies:[], busy:true, error:undefined, say:vi.fn(), refresh:vi.fn(), tick:0,  ...noPaging,
    })
    const html = renderToStaticMarkup(<WorkspaceLiaison scope="brain" surface="today" changed={vi.fn()} close={vi.fn()}
      openProfileImport={vi.fn()} openWorkspace={vi.fn()} openDelegation={vi.fn()}/>)
    expect(html).toContain('打开工单「本周简报」')
    expect(html).toContain('打开工单「下期报名」')
    expect(html).not.toContain('打开工作区')
  })

  it('opens separate saved and live conversations and keeps unavailable receipts readable', () => {
    const receipt = { id: 'other-workspace', name: '客户体验' }
    vi.spyOn(api, 'useChat').mockReturnValue({
      sessionId: 'hq', confirmedMessages: [], observedAt: 0, messages: [
        { seq: 1, time: 1, role: 'liaison', text: '', workspaces: [
          { ...receipt, sessionId: 'interview', sessionTitle: '访谈发现', sessionTraceId: 'initial', sourceMessageId: 'g-1' },
          { ...receipt, sessionId: 'prototype', sessionTitle: '初版核对', sessionDeletedAt: '2026-11-27T01:00:00.000Z' },
          { ...receipt, sessionId: 'missing', sessionTitle: '其他反馈', sessionUnavailable: true },
        ] },
      ],
      live: { since: 2, steps: [], text: '', workspaces: [{ ...receipt, sessionId: 'review', sessionTitle: '回访建议' }] },
      notices: [], workReplies: [], busy: true, error: undefined, say: vi.fn(), refresh: vi.fn(), tick: 0, ...noPaging,
    })
    const html = renderToStaticMarkup(<WorkspaceLiaison scope="brain" surface="today" changed={vi.fn()} close={vi.fn()}
      openProfileImport={vi.fn()} openWorkspace={vi.fn()} openSession={vi.fn()}/>)
    expect(html).toMatch(/<button [^>]*>打开对话「访谈发现」<\/button>/)
    expect(html).toMatch(/<button [^>]*>打开对话「回访建议」<\/button>/)
    expect(html).toContain('「初版核对」 · 对话已删除')
    expect(html).toContain('「其他反馈」 · 对话已不可用')
    expect(html).not.toMatch(/打开对话「初版核对|打开对话「其他反馈|打开工作区/)
  })

  it('shows reminders as liaison turns in time order, with the order or discussion they open', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 24, 3, minute)).toISOString()
    vi.spyOn(api, 'useChat').mockReturnValue({
      sessionId: 'hq', confirmedMessages: [], observedAt: Date.parse(at(30)), messages: [
        { seq: 1, time: Date.parse(at(1)), role: 'you', text: '帮我写周报' },
        { seq: 2, time: Date.parse(at(2)), role: 'liaison', text: '已交给工作区团队。' },
        { seq: 3, time: Date.parse(at(20)), role: 'liaison', text: '还有别的吗？' },
      ], live: undefined, workReplies: [], busy: false, error: undefined, say: vi.fn(), refresh: vi.fn(), tick: 0,  ...noPaging,
      notices: [
        { key: 'workspace-done:d1:t1', at: at(10), text: '「本周周报」已完成，接口人验收通过。打开工单查看成果。', order: { workspaceId: 'w1', orderId: 'd1' } },
        { key: 'room-action:q', at: at(15), text: '「选型讨论」需要你回答', roomId: 'room-1', status: '已回答', done: true },
        { key: 'need:T-9:you/review:1', at: at(16), text: '旧工单待验收', ticketId: 'T-9' },
      ],
    })
    const html = renderToStaticMarkup(<WorkspaceLiaison scope="brain" surface="today" changed={vi.fn()} close={vi.fn()} openProfileImport={vi.fn()}
      openRoom={vi.fn()} openWorkspace={vi.fn()} openDelegation={vi.fn()}/>)
    expect(html).toMatch(/已交给工作区团队。.+「本周周报」已完成，接口人验收通过。.+打开工单.+「选型讨论」需要你回答.+已回答.+打开讨论.+还有别的吗？/s)
    expect(html).toContain('data-message-id="notice-workspace-done:d1:t1"')
    expect(html).toMatch(/class="v2-turn settled"[^>]*data-message-id="notice-room-action:q"|data-message-id="notice-room-action:q" class="v2-turn settled"/)
    expect(html).not.toMatch(/旧工单待验收|接口人提醒|<details/)
  })

  it('只显示已加载时间范围内的提醒与讨论回报；顶部说明能否加载更早的消息', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 24, 3, minute)).toISOString()
    const loaded = Array.from({ length: 40 }, (_, i) => ({ seq: 100 + i, time: Date.parse(at(10 + i)), role: (i % 2 ? 'liaison' : 'you') as 'you' | 'liaison', text: '第 ' + i + ' 条' }))
    const chat = (paging: Partial<typeof noPaging>) => ({
      sessionId: 'hq', confirmedMessages: loaded, observedAt: Date.parse(at(59)), messages: loaded, live: undefined, workReplies: [], busy: false,
      error: undefined, say: vi.fn(), refresh: vi.fn(), tick: 0, ...noPaging, ...paging,
      discussionResults: [{ id: 'r-old', roomId: 'room', title: '旧讨论', text: '更早的讨论回报', at: at(5), status: 'ready' as const }],
      notices: [{ key: 'early', at: at(3), text: '更早的提醒' }, { key: 'inside', at: at(30), text: '范围内的提醒' }],
    })
    const render = () => renderToStaticMarkup(<WorkspaceLiaison scope="brain" surface="today" changed={vi.fn()} close={vi.fn()} openProfileImport={vi.fn()}
      openRoom={vi.fn()} openWorkspace={vi.fn()} openDelegation={vi.fn()}/>)
    vi.spyOn(api, 'useChat').mockReturnValue(chat({ hasOlder: true }))
    let html = render()
    expect(html).toContain('范围内的提醒')
    expect(html).not.toMatch(/更早的提醒|更早的讨论回报/)
    expect(html).toContain('加载更早的消息')
    vi.mocked(api.useChat).mockReturnValue(chat({ hasOlder: true, loadingOlder: true }))
    expect(render()).toContain('正在加载更早的消息…')
    vi.mocked(api.useChat).mockReturnValue(chat({ hasOlder: true, olderError: '连接不上主机' }))
    expect(render()).toMatch(/没能加载更早的消息.*重试/)
    vi.mocked(api.useChat).mockReturnValue(chat({}))
    html = render()
    expect(html).toMatch(/已经到最早的消息.*更早的提醒.*更早的讨论回报.*范围内的提醒/s)
    vi.mocked(api.useChat).mockReturnValue(chat({ hasNewer: true }))
    expect(render()).toContain('跳到最新')
  })

  it('shows the unread badge with 99+ beyond 99, none at zero or while the conversation is open', () => {
    expect(renderToStaticMarkup(<UnreadBadge count={0}/>)).toBe('')
    expect(renderToStaticMarkup(<UnreadBadge count={3}/>)).toBe('<span class="v2-badge" aria-hidden="true">3</span>')
    expect(renderToStaticMarkup(<UnreadBadge count={120}/>)).toContain('>99+<')
    expect([unreadLabel('一句话交办', 0), unreadLabel('一句话交办', 4), unreadLabel('一句话交办', 300)])
      .toEqual(['一句话交办', '一句话交办，4 条未读', '一句话交办，超过 99 条未读'])
    const read = vi.spyOn(v2, 'useV2Read').mockImplementation((resource, valid) => {
      const data = { scope: 'brain', unread: 7 }
      return { data: resource === '/chat/unread' && valid(data, resource) ? data as never : undefined, error: undefined, refresh: async () => {} }
    })
    function Probe({ open }: { open: boolean }) { return <b>{useLiaisonUnread(open)}</b> }
    expect(renderToStaticMarkup(<Probe open={false}/>)).toBe('<b>7</b>')
    expect(renderToStaticMarkup(<Probe open/>)).toBe('<b>0</b>')
    expect(read).toHaveBeenCalledWith('/chat/unread', expect.any(Function), 6000, 0)
  })

  it('keeps the request ID for a dropped reply even after closing the dialog, scoped to the same brain and origin', () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      get length() { return storage.size },
      key: (index: number) => [...storage.keys()][index],
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    const body = { text: '跟进昨天提到的事', sessionId: 'hq', mode: 'auto' }
    const retry = (scope = 'brain', payload: object = body) => pendingIntent(scope, '/chat', payload, new Map())
    const original = retry()
    expect(retry().id).toBe(original.id)
    expect(retry('another-brain').id).not.toBe(original.id)
    expect(retry('brain', { ...body, context: { selectedId: 'project' } }).id).not.toBe(original.id)
    original.settle()
    expect(retry().id).not.toBe(original.id)
  })
})
