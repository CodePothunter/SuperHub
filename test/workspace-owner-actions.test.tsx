import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../src/client/workspace-v2-api.ts'
import { isOwnerActionList, OwnerActionRows } from '../src/client/workspace-owner-actions.tsx'
import { WorkspaceV2 } from '../src/client/workspace-v2.tsx'

const at = '2026-11-25T08:00:00.000Z'
const action = { id:'needs-input', workspaceId:'design', sessionId:'draft', messageId:'g-12', question:'报告应给哪一组同事使用？',
  at, workspaceName:'设计审查', sessionTitle:'报告草案' }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('跨工作区待回应', () => {
  it('requires a distinct id, readable source and valid date for every pending item', () => {
    expect(isOwnerActionList({scope:'brain', items:[action]})).toBe(true)
    expect(isOwnerActionList({scope:'brain', items:[action, action]})).toBe(false)
    expect(isOwnerActionList({scope:'brain', items:[{...action, messageId:''}]})).toBe(false)
    expect(isOwnerActionList({scope:'brain', items:[{...action, at:'invalid'}]})).toBe(false)
    expect(isOwnerActionList({scope:'brain', items:[{...action, orderId:17}]})).toBe(false)
  })

  it('keeps the header count separate from liaison unread and includes requests from other workspaces', () => {
    vi.stubGlobal('location', {hash:''})
    let unavailable = false
    vi.spyOn(api, 'useV2Read').mockImplementation((resource, valid) => {
      if (resource === '/v2/approvals' && unavailable) return {data:undefined, error:'无法读取命令审批', refresh:async () => {}}
      const charge = { id:'needs-approval', workspaceId:'engineering', sessionId:'check', workOrderId:null, turnId:'call-1', tool:'dsh', memberId:'liaison',
        workspaceName:'工程', sessionTitle:'核对', command:'check --write', cwd:'/tmp/test', reason:'写入确认', requestedAt:at,
        expiresAt:'2026-11-26T08:00:00.000Z' }
      const data = resource === '/v2/owner-actions' ? {scope:'brain', items:[action]} : resource === '/chat/unread' ? {scope:'brain', unread:7}
        : resource === '/v2/approvals' ? {scope:'brain', approvals:[charge]} : undefined
      return { data: resource && data && valid(data, resource) ? data as never : undefined, error: undefined, refresh: async () => {} }
    })
    const html = renderToStaticMarkup(<WorkspaceV2 scope="brain" configure={false} reloadBrain={async () => {}}/>)
    expect(html).toContain('aria-label="一句话交办，7 条未读，2 件待回应"')
    expect(html).toContain('>待回应 2</span><span class="v2-badge" aria-hidden="true">7</span>')
    expect(html).toMatch(/aria-label="待你回应".*data-owner-action-id="needs-input".*报告应给哪一组同事使用？.*设计审查 · 报告草案/)
    expect(html).toMatch(/aria-label="等你决定".*写入确认/)
    unavailable = true
    const degraded = renderToStaticMarkup(<WorkspaceV2 scope="brain" configure={false} reloadBrain={async () => {}}/>)
    expect(degraded).toContain('aria-label="一句话交办，7 条未读，1 件待回应"')
    expect(degraded).toContain('data-owner-action-id="needs-input"')
  })

  it('hands navigation the exact source for each item', () => {
    const other = {...action, id:'another-question', workspaceId:'other', sessionId:'triage', orderId:'work', messageId:'g-2'}
    const open = vi.fn()
    const list = OwnerActionRows({items:[action, other], open})
    list.props.children[1].props.onClick()
    expect(open).toHaveBeenCalledExactlyOnceWith(other)
  })
})
