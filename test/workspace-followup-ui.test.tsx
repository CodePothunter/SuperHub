import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FollowupView, OrderCommitment } from '../src/core/workspace-followup.ts'
import type { V2Delegation, V2Session } from '../src/core/workspace-v2.ts'
import * as client from '../src/client/workspace-v2-api.ts'
import { OrderFollowup } from '../src/client/workspace-followup.tsx'
import { isFollowupView } from '../src/client/workspace-v2-response.ts'

const at = '2026-11-20T07:00:00Z'
const session: V2Session = { id:'session', workspaceId:'space', title:'客户演示', kind:'group', executor:'dsh', delegationIds:['order','other'], closed:false, createdAt:at }
const job: V2Delegation = { id:'order', workspaceId:'space', sessionId:'session', title:'准备演示', promise:'可看的演示', owner:'我',
  status:'active', nextCheckAt:at, generation:1, remainingTurns:2, createdAt:at, boundary:'本单' }
const commitment: OrderCommitment = { id:'quote', kind:'request', quote:'请我看看预算', resolved:false, dueAt:'2026-11-19', dueState:'overdue',
  source:{ kind:'session', sessionId:'session', messageId:'line', author:'主人', at } }
const view: FollowupView = { scope:'brain', workspaceId:'space', orderId:'order', timeZone:'Asia/Shanghai', currentWeek:'2026-11-16',
  commitments:[commitment], schedule:{enabled:true, weekday:5, time:'16:00'},
  reports:[{id:'report', week:'2026-11-16', title:'本周客户演示', markdown:'正文', createdAt:at, sources:[commitment.source]}] }
const path = '/v2/workspaces/space/orders/order/followup'
function render(data: FollowupView, order = job) {
  vi.spyOn(client, 'useV2Read').mockImplementation((resource, valid) => ({
    data: resource && valid(data,resource) ? data : undefined, error:undefined, refresh:async () => {},
  }))
  return renderToStaticMarkup(<OrderFollowup base="/v2/workspaces/space" job={order} session={session} openSource={() => {}}/>)
}
afterEach(() => vi.restoreAllMocks())

describe('工单中的约定与周报', () => {
  it('requires an exact scoped order, known source and an actual report in the draft receipt', () => {
    expect(isFollowupView({...view, reportId:'report'},path)).toBe(true)
    expect(isFollowupView({...view, workspaceId:'other'},path)).toBe(false)
    expect(isFollowupView({...view, orderId:'other'},path)).toBe(false)
    expect(isFollowupView({...view, reportId:'missing'},path)).toBe(false)
    expect(isFollowupView({...view, commitments:[{...commitment, source:{kind:'session',author:'主人'}}]},path)).toBe(false)
    expect(isFollowupView({...view, reports:[{...view.reports[0], sources:[{kind:'unknown'}]}]},path)).toBe(false)
    expect(isFollowupView({...view, schedule:{enabled:true,weekday:8,time:'24:30'}},path)).toBe(false)
  })
  it('keeps pending requests, source context and overdue status visible together', () => {
    const html = render(view)
    for (const value of ['待回应请求','请我看看预算','已逾期','定位原话','每周五','16:00','Asia/Shanghai','打开本周周报']) expect(html).toContain(value)
    expect(html).not.toContain('生成本周周报')
  })
  it('preserves a liaison quotation without pointing it to another conversation of the same order', () => {
    const html = render({...view, commitments:[{...commitment,source:{...commitment.source, kind:'liaison', sessionId:'liaison'}}]})
    expect(html).toContain('接口人对话')
    expect(html).toContain('请我看看预算')
    expect(html).not.toContain('定位原话')
  })
  it('keeps paused history readable and can stop an existing schedule', () => {
    const html = render(view,{...job,paused:true})
    expect(html).toContain('打开本周周报')
    expect(html).toContain('停用周期')
    expect(html).not.toMatch(/从会话记录|标记已处理|生成本周周报|设置周期/)
  })
})
