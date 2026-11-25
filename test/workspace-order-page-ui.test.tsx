import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2Delegation, V2Message, V2Session, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import type { Scoped } from '../src/client/superhub-api.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import { WorkOrderPage } from '../src/client/workspace-v2.tsx'
import { ConversationBoard } from '../src/client/workspace-v2-talk.tsx'
import { HistoryPanel } from '../src/client/workspace-history.tsx'
import { isSessionView } from '../src/client/workspace-v2-response.ts'
import { WORKSPACE_V2_STYLE } from '../src/client/workspace-v2-style.ts'

const at = '2026-11-22T08:00:00Z'
const session: V2Session = {id:'s', workspaceId:'w', title:'周报会话', kind:'coding', executor:'codex', delegationIds:['d'], closed:false, createdAt:at}
const order: V2Delegation = {id:'d', workspaceId:'w', sessionId:'s', title:'整理本周周报', promise:'一份表格周报', owner:'接口人', status:'active',
  boundary:'只读资料', remainingTurns:3, generation:1, createdAt:at, nextCheckAt:at}
const view: V2WorkspaceView = {scope:'brain', workspace:{id:'w', name:'研究周报', goal:'', owner:'我', createdAt:at}, orders:[order], delegations:[order], sessions:[session], decisions:[]}
const messages: V2Message[] = [
  {id:'u1', role:'user', author:'你', speakerId:'owner', at, text:'写一份周报', workOrderId:'d'},
  {id:'u2', role:'user', author:'你', speakerId:'owner', at, text:'改用表格输出', workOrderId:'d', delivery:'steered'},
  {id:'u3', role:'user', author:'你', speakerId:'owner', at, text:'再加一页附录', workOrderId:'d', delivery:'queued'},
  {id:'m1', role:'agent', author:'Codex', at, text:'正在整理表格。', workOrderId:'d'},
]
const sessionPath = '/v2/workspaces/w/sessions/s'

function mockReads(responses: Record<string, Scoped & Record<string, unknown>>) {
  vi.spyOn(api, 'useV2Read').mockImplementation((resource, valid) => {
    const value = resource ? responses[resource] : undefined
    return {data: resource && value && valid(value, resource) ? value : undefined, error: undefined, refresh: async () => {}}
  })
}
const transcript = (extra: Record<string, unknown> = {}) => ({[sessionPath]: {scope:'brain', session, messages, ...extra}})
const page = (job: V2Delegation, wide: boolean, room = view) => renderToStaticMarkup(<WorkOrderPage job={job} view={room} base="/v2/workspaces/w"
  back={vi.fn()} open={vi.fn()} openOrder={vi.fn()} target={vi.fn()} newOrder={vi.fn()}
  popup={vi.fn()} changed={async () => {}} initialWide={wide}/>)
afterEach(() => vi.restoreAllMocks())

describe('工单页即对话', () => {
  it('opens the order as its conversation, with the order\'s details in a side panel on a wide workspace', () => {
    mockReads(transcript())
    const html = page(order, true)
    expect(html).toContain('写一份周报')
    expect(html).toMatch(/<textarea[^>]*placeholder="对 Codex 说…"/)
    expect(html).toMatch(/<aside class="v2-order-info" aria-label="工单信息">/)
    for (const part of ['工单约定', '一份表格周报', '暂停工单', '收窄范围', '取消工单', '命令档位', '执行记录']) expect(html).toContain(part)
    // The conversation is already open: no detour through 「打开会话」 or 「返回工单」.
    expect(html).not.toContain('打开会话')
    expect(html).not.toContain('返回工单')
    expect(html).not.toContain('打开工单「')
    expect(html.indexOf('写一份周报')).toBeLessThan(html.indexOf('<aside'))
  })

  it('puts the details in a collapsible 「工单信息」 above the conversation on a narrow workspace, keeping approvals outside the fold', () => {
    mockReads(transcript())
    const html = page(order, false)
    expect(html).not.toContain('<aside')
    expect(html).toMatch(/<details class="v2-order-fold"><summary>工单信息/)
    expect(html.indexOf('v2-order-fold')).toBeLessThan(html.indexOf('写一份周报'))
    // The execution block (approval cards, record) sits between the fold and the conversation.
    expect(html.indexOf('v2-execution-block')).toBeGreaterThan(html.indexOf('</details>'))
    expect(html.indexOf('v2-execution-block')).toBeLessThan(html.indexOf('写一份周报'))
  })

  it('answers an old ticket bookmark without reopening its actions or reading its source', () => {
    mockReads({})
    const html = renderToStaticMarkup(<HistoryPanel itemId="ticket:T-0042" back={vi.fn()} openItem={vi.fn()}/>)
    expect(html).toContain('这张工单已不可用')
    expect(html).toContain('返回资料库')
    expect(vi.mocked(api.useV2Read).mock.calls.every(([resource]) => resource === undefined)).toBe(true)
  })

  it('lays out without horizontal overflow and keeps the chat column shrinkable', () => {
    expect(WORKSPACE_V2_STYLE).toMatch(/\.v2-order-page\[data-wide=true\] \.v2-order-layout \{ grid-template-columns:minmax\(0,1\.75fr\) minmax\(300px,1fr\); \}/)
    expect(WORKSPACE_V2_STYLE).toMatch(/:is\(\.v2-order-chat,\.v2-order-info,\.v2-order-details,\.v2-order-fold\) \{ min-width:0; \}/)
  })
})

describe('对话中随时发言', () => {
  it('keeps the composer open while the executor works and says the words arrive right away', () => {
    mockReads(transcript({working:true}))
    const html = page(order, true)
    expect(html).toContain('对方正在工作，你的话会立即送达')
    expect(html).not.toMatch(/<textarea[^>]*disabled/)
    expect(html).toContain('已送进当前一轮')
    expect(html).toContain('已排到下一轮')
  })

  it('still closes the composer for a paused order, and for one without budget once its last turn ended', () => {
    mockReads(transcript({working:true}))
    const paused = {...order, paused:true}
    let html = page(paused, true, {...view, orders:[paused], delegations:[paused]})
    expect(html).toMatch(/<textarea[^>]*disabled/)
    expect(html).not.toContain('对方正在工作')
    // Words said into the running last turn use no budget.
    const spent = {...order, remainingTurns:0}
    html = page(spent, true, {...view, orders:[spent], delegations:[spent]})
    expect(html).not.toMatch(/<textarea[^>]*disabled/)
    expect(html).toContain('对方正在工作')
    mockReads(transcript())
    html = page(spent, true, {...view, orders:[spent], delegations:[spent]})
    expect(html).toMatch(/<textarea[^>]*disabled/)
    expect(html).toContain('本次额度已用完')
  })

  it('validates delivery states and the working flag of a session read', () => {
    const value: Scoped & Record<string, unknown> = {scope:'brain', session, messages, working:true}
    expect(isSessionView(value, sessionPath)).toBe(true)
    expect(isSessionView({...value, working:'yes'} as Scoped, sessionPath)).toBe(false)
    expect(isSessionView({...value, messages:[{...messages[1]!, delivery:'lost'}]} as Scoped, sessionPath)).toBe(false)
  })

  it('keeps the session view with its way back to the order', () => {
    mockReads(transcript())
    const html = renderToStaticMarkup(<ConversationBoard base="/v2/workspaces/w" view={view} selected="s" origin="d" open={vi.fn()} back={vi.fn()}
      openDelegation={vi.fn()} target={vi.fn()} newOrder={vi.fn()} visible={vi.fn()} create={vi.fn()} changed={async () => {}}/>)
    expect(html).toContain('返回工单')
    expect(html).toContain('写一份周报')
  })
})
