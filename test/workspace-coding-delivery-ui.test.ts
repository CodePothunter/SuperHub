import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOrderOutputs } from '../src/client/workspace-v2-response.ts'
import type { V2Delegation, V2Session, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import type { Scoped } from '../src/client/superhub-api.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import { OrderOutputs } from '../src/client/workspace-coding-delivery.tsx'
import { ConversationBoard } from '../src/client/workspace-v2-talk.tsx'

const at = '2026-11-20T01:00:00Z'
const order: V2Delegation = {id:'d',workspaceId:'w',sessionId:'s',title:'准备简报',promise:'一份可转发的文稿',owner:'接口人',
  status:'active',boundary:'内部',remainingTurns:4,generation:1,createdAt:at,nextCheckAt:at}
const session: V2Session = {id:'s',workspaceId:'w',title:'本周安排',kind:'coding',executor:'codex',closed:false,createdAt:at,delegationIds:['d','other']}

function mockReads(responses: Record<string, Scoped & Record<string,unknown>>) {
  vi.spyOn(api,'useV2Read').mockImplementation((resource,valid) => {
    const value = resource ? responses[resource] : undefined
    return {data: resource && value && valid(value,resource) ? value : undefined, error:undefined, refresh:async () => {}}
  })
}
afterEach(() => vi.restoreAllMocks())

describe('工单成果', () => {
  it('keeps the file and its source message bound to the requested work order, including a shared conversation', () => {
    const path = '/v2/workspaces/w/orders/d/outputs'
    const output = {sessionId:'shared-session',messageId:'reply',attachment:{id:'file',label:'一周简报'}}
    const view = {scope:'brain',workspaceId:'w',delegationId:'d',outputs:[output]}
    expect(isOrderOutputs(view,path)).toBe(true)
    expect(isOrderOutputs({...view,outputs:[]},path)).toBe(true)
    expect(isOrderOutputs({...view,delegationId:'other'},path)).toBe(false)
    expect(isOrderOutputs({...view,workspaceId:'another'},path)).toBe(false)
    expect(isOrderOutputs({...view,outputs:[{...output,messageId:''}]},path)).toBe(false)
    expect(isOrderOutputs({...view,outputs:[{...output,attachment:{label:'一周简报'}}]},path)).toBe(false)
  })
  it('opens a work order with just its published files (an old preview hint on the board shows nothing more)', () => {
    const path = '/v2/workspaces/w/orders/d'
    mockReads({
      [path + '/outputs']:{scope:'brain',workspaceId:'w',delegationId:'d',outputs:[
        {sessionId:'s',messageId:'reply',attachment:{id:'doc',label:'周五简报'}},
        {sessionId:'unrelated',messageId:'other',attachment:{id:'other',label:'另一场的文件'}}]},
    })
    const html = renderToStaticMarkup(createElement(OrderOutputs,{job:{...order,deliveryKind:'mobile-signup'},base:'/v2/workspaces/w',sessions:[session]}))
    expect(html).toContain('周五简报')
    expect(html).not.toMatch(/另一场的文件|报名|试填/)
  })
  it('lets a shared conversation write to its selected work order while a sibling is paused', () => {
    const sibling = {...order,id:'other',title:'周报校对',paused:true}
    const view: V2WorkspaceView = {scope:'brain',workspace:{id:'w',name:'本周',goal:'',owner:'接口人',createdAt:at},
      orders:[order,sibling],delegations:[order,sibling],sessions:[session],decisions:[]}
    mockReads({'/v2/workspaces/w/sessions/s':{scope:'brain',session,messages:[]}})
    function show(origin: string, closed = false) {
      return renderToStaticMarkup(createElement(ConversationBoard,{base:'/v2/workspaces/w',view:{...view,sessions:[{...session,closed}]},selected:'s',origin,
        open:vi.fn(),back:vi.fn(),openDelegation:vi.fn(),target:vi.fn(),newOrder:vi.fn(),visible:vi.fn(),create:vi.fn(),changed:vi.fn()}))
    }
    expect(show('d')).toContain('发言对象')
    expect(show('d')).not.toMatch(/<textarea[^>]*disabled|工单已暂停/)
    expect(show('other')).toMatch(/<textarea[^>]*disabled/)
    expect(show('other')).toContain('工单已暂停')
    expect(show('d',true)).toContain('恢复会话')
    expect(show('other',true)).not.toContain('恢复会话')
  })
})
