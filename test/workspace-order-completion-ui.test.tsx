import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2Delegation, V2Message, V2Session, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import type { Scoped } from '../src/client/superhub-api.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import { Overview, WorkOrderPage } from '../src/client/workspace-v2.tsx'
import { delegationState } from '../src/client/workspace-v2-elements.tsx'
import { OrderResultInbox } from '../src/client/workspace-notices.tsx'
import { isSessionView, isWorkspaceView } from '../src/client/workspace-v2-response.ts'
import { WORKSPACE_V2_STYLE } from '../src/client/workspace-v2-style.ts'

const at = '2026-11-23T00:20:00Z'
const liaisonId = 's-' + 'b'.repeat(24)
const session: V2Session = {id:'s', workspaceId:'w', title:'方舟会话', kind:'coding', executor:'codex', delegationIds:['d'], closed:false, createdAt:at}
const order: V2Delegation = {id:'d', workspaceId:'w', sessionId:'s', title:'方舟八题', promise:'八题全部作答', owner:'接口人', status:'waiting',
  boundary:'本区', remainingTurns:3, generation:2, createdAt:at}
const view = (job: V2Delegation): V2WorkspaceView => ({scope:'brain', workspace:{id:'w', name:'方舟', goal:'', owner:'我', createdAt:at}, orders:[job], delegations:[job], sessions:[session], decisions:[]})
const sessionPath = '/v2/workspaces/w/sessions/s'
const held: V2Message[] = [
  {id:'u1', role:'user', author:'你', speakerId:'owner', at, text:'可以验收了', workOrderId:'d', held:'choosing'},
  {id:'l1', role:'agent', author:'接口人', speakerId:liaisonId, at, text:'这句话像是在确认收单，但不够明确。', workOrderId:'d',
    actions:[{kind:'complete', label:'确认收单'}, {kind:'forward', label:'继续交给执行者', messageId:'u1'}]},
]
function mockReads(messages: V2Message[]) {
  const transcript = {scope:'brain', session, messages}
  expect(isSessionView(transcript as never, sessionPath)).toBe(true)
  vi.spyOn(api, 'useV2Read').mockImplementation((resource, valid) => {
    const value: (Scoped & Record<string, unknown>) | undefined = resource === sessionPath ? transcript as never : undefined
    return {data: resource && value && valid(value, resource) ? value : undefined, error: undefined, refresh: async () => {}}
  })
}
const page = (job: V2Delegation) => renderToStaticMarkup(<WorkOrderPage job={job} view={view(job)} base="/v2/workspaces/w"
  back={vi.fn()} open={vi.fn()} openOrder={vi.fn()} target={vi.fn()} newOrder={vi.fn()} popup={vi.fn()} changed={async () => {}} initialWide/>)
afterEach(() => vi.restoreAllMocks())

describe('收单的对话与工单页', () => {
  it('marks held words and offers the liaison\'s two choices as keyboard buttons', () => {
    mockReads(held)
    const html = page(order)
    expect(html).toContain('<small class="v2-delivery-note v2-held-note" data-held="choosing">待你选择 · 还没有发给执行者</small>')
    expect(html).toMatch(/<div class="v2-choices" role="group" aria-label="接口人给出的选项"><button type="button" class="v2-button primary">确认收单<\/button><button type="button" class="v2-button">继续交给执行者<\/button>/)
    // The order page also offers to complete it; no follow-up time without a recurring schedule.
    expect(html).toContain('>标为完成</button>')
    expect(html).not.toContain('下次跟进')
  })

  it('shows a taken choice as a note, and a finished order as 已完成 with reopen instead of the controls', () => {
    const taken: V2Message[] = [
      {...held[0]!, held:'completed'},
      {...held[1]!, actions:[{kind:'complete', label:'确认收单', done:{at}}]},
      {id:'l2', role:'agent', author:'接口人', speakerId:liaisonId, at, text:'已按你的话收单。', workOrderId:'d', actions:[{kind:'reopen', label:'撤销'}]},
    ]
    mockReads(taken)
    const done: V2Delegation = {...order, status:'done', completedAt:at, completedBy:'owner-words', completedFrom:'u1'}
    const html = page(done)
    expect(html).toContain('已按这句话收单 · 没有发给执行者')
    expect(html).toMatch(/<p class="v2-choice-done" role="status">.*已收单 · /)
    expect(html).not.toContain('>继续交给执行者</button>')
    // Undo is available while the order is finished.
    expect(html).toMatch(/<button type="button" class="v2-button">撤销<\/button>/)
    expect(html).toContain('已完成')
    expect(html).toContain('按你在对话中的话收单')
    expect(html).toContain('>重新打开</button>')
    expect(html).not.toContain('>暂停工单</button>')
    expect(html).not.toContain('>标为完成</button>')
    expect(html).toContain('工单已完成，重新打开后可继续')
    expect(delegationState(done)).toBe('已完成')
    expect(delegationState({...order, status:'closed'})).toBe('已关闭')
  })

  it('disables choices the order no longer allows', () => {
    mockReads(held)
    const html = page({...order, status:'closed', reason:'你已取消这张工单'})
    expect(html).toMatch(/<button type="button" class="v2-button primary" disabled="">确认收单<\/button>/)
    expect(html).toContain('工单已关闭')
  })

  it('names the schedule when the order has one, in the order page and the overview', () => {
    mockReads([])
    const weekly: V2Delegation = {...order, nextCheckAt:'2026-11-23T01:00:00Z', hasSchedule:true}
    const html = page(weekly)
    expect(html).toContain('按周期安排')
    expect(html).toContain('>标为完成并停止周期安排</button>')
    // Paused: no next run is shown, but completing still stops the schedule, as the liaison's choice says.
    const paused = page({...order, paused:true, hasSchedule:true})
    expect(paused).not.toContain('下次跟进')
    expect(paused).toContain('>标为完成并停止周期安排</button>')
    // A stored time alone is not a schedule.
    expect(page({...order, nextCheckAt:'2026-11-23T01:00:00Z'})).toContain('>标为完成</button>')
    const overview = (job: V2Delegation) => renderToStaticMarkup(<Overview view={view(job)} openJob={() => {}} openSession={() => {}} delegate={() => {}} create={() => {}}/>)
    expect(overview(weekly)).toContain('下次跟进 · ')
    expect(overview(order)).not.toContain('下次跟进')
    const finished = overview({...order, status:'done', completedAt:at})
    expect(finished).toContain('<span class="v2-status">已完成</span>')
    expect(finished).toMatch(/<span class="v2-next" data-state="done">已完成 · /)
    expect(overview({...order, status:'closed', reason:'你已取消这张工单'})).toContain('<span class="v2-status">已关闭</span>')
  })

  it('accepts the new status and fields, and rejects malformed choices', () => {
    const space = view({...order, status:'done', completedAt:at, completedBy:'owner'})
    expect(isWorkspaceView(space as never, '/v2/workspaces/w')).toBe(true)
    expect(isWorkspaceView(view({...order, completedBy:'someone' as never}) as never, '/v2/workspaces/w')).toBe(false)
    expect(isWorkspaceView(view({...order, hasSchedule:true}) as never, '/v2/workspaces/w')).toBe(true)
    expect(isWorkspaceView(view({...order, hasSchedule:false as never}) as never, '/v2/workspaces/w')).toBe(false)
    const transcript = (messages: unknown[]) => ({scope:'brain', session, messages}) as never
    expect(isSessionView(transcript([{...held[1]!, actions:[{kind:'delete', label:'x'}]}]), sessionPath)).toBe(false)
    expect(isSessionView(transcript([{...held[0]!, held:'maybe'}]), sessionPath)).toBe(false)
    expect(isSessionView(transcript([{...held[1]!, actions:[{kind:'complete', label:'确认收单', done:{at}}]}]), sessionPath)).toBe(true)
    expect(WORKSPACE_V2_STYLE).toMatch(/\.v2-choices \{[^}]*flex-wrap:wrap/)
    expect(WORKSPACE_V2_STYLE).toMatch(/\.v2-choices \.v2-button \{[^}]*min-height:40px/)
  })

  it('tells 「今天」 that a delivered order has been completed', () => {
    const list = {scope:'brain', unread:1, total:1, items:[{id:'n', orderId:'d', workspaceId:'w', sessionId:'s', title:'工单回报', workspaceName:'方舟',
      orderTitle:'方舟八题', at, version:'v', read:false, kind:'report', attachments:[], orderDone:true}]}
    vi.spyOn(api, 'useV2Read').mockImplementation((_resource, valid) => ({data: valid(list as never, '/v2/notices') ? list as never : undefined, error: undefined, refresh: async () => {}}))
    const html = renderToStaticMarkup(<OrderResultInbox today goToday={() => {}} openOrder={() => {}} openSource={() => {}}/>)
    expect(html).toContain('方舟八题 · 工单已完成 · ')
  })
})
