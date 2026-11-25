import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import * as client from '../src/client/workspace-v2-api.ts'
import { isOrderOriginal } from '../src/client/workspace-v2-response.ts'
import { isWorkspaceSettings, WorkspaceSettings } from '../src/client/workspace-settings.tsx'

const safe = {scope:'brain', timeZone:'Asia/Shanghai', concurrency:2, activeModel:'local/model'}
const desktop = {...safe, admin:{staff:[{id:'editor',name:'项目编辑',executor:'dsh',brief:'负责核对文稿。'}],settings:{
  timeZone:safe.timeZone, concurrency:safe.concurrency, brain:'/example/private-brain', git:true, dev:false,
  mobile:{enabled:true, port:20000, host:'127.0.0.1', running:true, hasPassword:true, addresses:['http://127.0.0.1:20000']},
  liaisonTools:{guardInstalled:true, requestAudit:'unavailable', boundary:'llm/stream-before-adapter', sessions:[
    {sessionId:'liaison',maskedGlobal:[],maskFailed:[],registeredDenied:null},
  ]},
}}}
function render(configure:boolean, value = desktop) {
  vi.spyOn(client, 'useV2Read').mockImplementation((path,valid) => ({
    data: path && valid(value,path) ? value : undefined, error:undefined, refresh:async () => {},
  }))
  return renderToStaticMarkup(<WorkspaceSettings configure={configure} openStaff={()=>{}} reloadBrain={async () => {}}/>)
}
afterEach(() => vi.restoreAllMocks())
it('can read only the current runtime settings or its properly formed admin detail', () => {
  expect(isWorkspaceSettings(safe)).toBe(true)
  expect(isWorkspaceSettings(desktop)).toBe(true)
  expect(isWorkspaceSettings({...desktop,concurrency:5})).toBe(false)
  expect(isWorkspaceSettings({...safe,scope:undefined})).toBe(false)
  expect(isWorkspaceSettings({...safe,admin:{...desktop.admin,staff:[{...desktop.admin.staff[0],brief:undefined}]}})).toBe(false)
})
it('opens the staff directory on both clients and keeps machine settings out of the mobile UI', () => {
  const admin = render(true)
  expect(admin).toContain('我的幕僚')
  expect(admin).toContain('/example/private-brain')
  expect(admin).toContain('保存团队设置')
  expect(admin).toContain('接口人工具诊断')
  const mobile = render(false)
  expect(mobile).toContain('我的幕僚')
  expect(mobile).toContain('local/model')
  expect(mobile).toContain('Asia/Shanghai')
  expect(mobile).toContain('href="/logout"')
  expect(mobile).not.toMatch(/项目编辑|private-brain|保存密码|推送地址|工具诊断/)
})
it('requires the original message to come from the opened work order and preserves a partial source', () => {
  const path = '/v2/workspaces/a/orders/b/original'
  const saved = {scope:'brain',workspaceId:'a',orderId:'b',original:{text:'当时的原话',complete:false}}
  expect(isOrderOriginal(saved,path)).toBe(true)
  expect(isOrderOriginal({...saved,orderId:'c'},path)).toBe(false)
  expect(isOrderOriginal({...saved,workspaceId:'other'},path)).toBe(false)
  expect(isOrderOriginal({...saved,original:{text:'丢失来源'}},path)).toBe(false)
})
