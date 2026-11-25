import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2Delegation, V2Message, V2Session, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import type { Scoped } from '../src/client/superhub-api.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import { acceptanceState, WorkOrderPage } from '../src/client/workspace-v2.tsx'
import { PendingCommandApprovals } from '../src/client/workspace-execution.tsx'
import { isApprovalList, isSessionView, type AcceptanceDecision } from '../src/client/workspace-v2-response.ts'
import { WORKSPACE_V2_STYLE } from '../src/client/workspace-v2-style.ts'

const at = '2026-11-22T08:00:00Z'
const liaisonId = 's-' + 'a'.repeat(24)
const session: V2Session = {id:'s', workspaceId:'w', title:'周报会话', kind:'coding', executor:'codex', delegationIds:['d'], closed:false, createdAt:at}
const order: V2Delegation = {id:'d', workspaceId:'w', sessionId:'s', title:'整理本周周报', promise:'一份表格周报', owner:'接口人', status:'active',
  boundary:'只读资料', remainingTurns:3, generation:1, createdAt:at, nextCheckAt:at}
const view: V2WorkspaceView = {scope:'brain', workspace:{id:'w', name:'研究周报', goal:'', owner:'我', createdAt:at}, orders:[order], delegations:[order], sessions:[session], decisions:[]}
const messages: V2Message[] = [
  {id:'u0', role:'user', author:'你', speakerId:'owner', at, text:'上周的周报也整理一下', workOrderId:'d', relayed:true},
  {id:'l1', role:'agent', author:'接口人', speakerId:liaisonId, at, text:'请整理一页表格周报，标出待跟进事项。', workOrderId:'d',
    quote:{label:'主人原话', text:'帮我把本周三份访谈整理成一页周报'}},
  {id:'m1', role:'agent', author:'Codex', at, text:'正在整理表格。', workOrderId:'d'},
]
const sessionPath = '/v2/workspaces/w/sessions/s'
function mockReads(responses: Record<string, Scoped & Record<string, unknown>>) {
  vi.spyOn(api, 'useV2Read').mockImplementation((resource, valid) => {
    const value = resource ? responses[resource] : undefined
    return {data: resource && value && valid(value, resource) ? value : undefined, error: undefined, refresh: async () => {}}
  })
}
const page = (job: V2Delegation) => renderToStaticMarkup(<WorkOrderPage job={job} view={{...view, orders:[job], delegations:[job]}} base="/v2/workspaces/w"
  back={vi.fn()} open={vi.fn()} openOrder={vi.fn()} target={vi.fn()} newOrder={vi.fn()}
  popup={vi.fn()} changed={async () => {}} initialWide/>)
afterEach(() => vi.restoreAllMocks())

describe('接口人在工单对话中发言', () => {
  it('shows the liaison\'s hand-over with its portrait and the owner\'s original folded, and labels older relayed words', () => {
    const transcript = {scope:'brain', session, messages, portraits:{[liaisonId]:{shape:'sprout', color:'mint'}, owner:{shape:'plane', color:'blue'}}}
    expect(isSessionView(transcript as never, sessionPath)).toBe(true)
    mockReads({[sessionPath]: transcript})
    const html = page(order)
    expect(html).toContain('<strong>接口人</strong>')
    expect(html).toContain('请整理一页表格周报，标出待跟进事项。')
    expect(html).toMatch(/<details class="v2-relay-quote"><summary>主人原话<\/summary><div class="v2-relay-text">帮我把本周三份访谈整理成一页周报<\/div><\/details>/)
    expect(html).toContain('<small class="v2-relay-note">经接口人转交的原话</small>')
    // The liaison speaks on the executor's side of the conversation; the owner stays 「你」.
    expect(html).toMatch(/<div class="v2-turn "><svg class="v2-chat-avatar"[^>]*data-shape="sprout" data-color="mint"/)
    expect(WORKSPACE_V2_STYLE).toMatch(/\.v2-relay-text \{[^}]*white-space:pre-wrap/)
    expect(isSessionView({...transcript, messages:[{...messages[1]!, quote:{label:'主人原话'}}]} as never, sessionPath)).toBe(false)
  })

  it('states the liaison\'s acceptance on the order page', () => {
    mockReads({[sessionPath]: {scope:'brain', session, messages}})
    const waiting = {...order, autoFollowUps:1, acceptance:{verdict:'gap' as const, at, turnId:'t', gaps:['缺少第三份访谈'], awaitingOwner:true as const}}
    expect(page(waiting)).toContain('追问后仍有缺口，等你决定：缺少第三份访谈')
    expect(acceptanceState({verdict:'pass', at, turnId:'t'})).toMatch(/^已对照约定核对，达标/)
    expect(acceptanceState({verdict:'failed', at, turnId:'t', reason:'验收超时（60 秒）'})).toBe('未完成验收：验收超时（60 秒）')
    expect(acceptanceState({verdict:'gap', at, turnId:'t', gaps:['缺 C']})).toBe('有缺口，已追问执行者：缺 C')
  })

  it('lists an order still short after the follow-up in 「等你决定」 and opens it', () => {
    const decision: AcceptanceDecision = {workspaceId:'w', workspaceName:'研究周报', orderId:'d', orderTitle:'整理本周周报', at, gaps:['缺少第三份访谈']}
    const list = {scope:'brain', approvals:[], acceptances:[decision]}
    expect(isApprovalList(list)).toBe(true)
    expect(isApprovalList({...list, acceptances:[{...decision, gaps:[1]}]} as never)).toBe(false)
    vi.spyOn(api, 'useV2Read').mockImplementation((_resource, valid) => ({
      data: valid(list as never, '/v2/approvals') ? list as never : undefined, error:undefined, refresh:async () => {},
    }))
    const opened: AcceptanceDecision[] = []
    const html = renderToStaticMarkup(<PendingCommandApprovals today goToday={() => {}} open={() => {}} openOrder={row => opened.push(row)}/>)
    for (const value of ['等你决定（1 张工单待验收）', '整理本周周报', '接口人验收：追问后仍有缺口（缺少第三份访谈）']) expect(html).toContain(value)
    const elsewhere = renderToStaticMarkup(<PendingCommandApprovals today={false} goToday={() => {}} open={() => {}} openOrder={() => {}}/>)
    expect(elsewhere).toContain('1 张工单待验收等你决定')
    // Without an order destination the list stays as it was.
    expect(renderToStaticMarkup(<PendingCommandApprovals today goToday={() => {}} open={() => {}}/>)).toBe('')
  })
})
