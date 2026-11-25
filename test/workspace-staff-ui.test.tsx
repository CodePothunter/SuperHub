import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { StaffPortraitPicker } from '../src/client/workspace-staff-portrait.tsx'
import { StaffBoard } from '../src/client/workspace-staff.tsx'
import { isStaffImpact, isStaffView, staffPath } from '../src/client/workspace-staff-response.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import type { StaffView } from '../src/core/workspace-staff.ts'
import type { V2WorkspaceView } from '../src/core/workspace-v2.ts'

const space = {id:'customer',name:'客户访谈',owner:'本人',goal:'准备访谈',createdAt:'2026-11-20'}
const view:V2WorkspaceView = {scope:'b',workspace:space,delegations:[],orders:[],sessions:[],decisions:[]}
const member = {id:'analyst',name:'研究员',brief:'研究使用体验',memberships:[{workspaceId:space.id,duty:'整理访谈'}]}
const global:StaffView = {scope:'b',members:[member],available:[],memories:[],received:[],shares:[]}
const local:StaffView = {...global,workspaceId:space.id,received:[{id:'g',staffId:member.id,text:'两种按钮容易混淆'}],memories:[
  {id:'m',staffId:member.id,workspaceId:space.id,text:'确认下一步',status:'active',version:1,at:'2026-11-20'},
]}
function card(staff:StaffView,workspace?:V2WorkspaceView) {
  vi.spyOn(api,'useV2Read').mockImplementation((path,valid)=>({data:path && valid(staff,path) ? staff : undefined,refresh:async()=>{},error:undefined}))
  return renderToStaticMarkup(<StaffBoard selected={member.id} workspace={workspace} spaces={[space]} select={()=>{}} openOrder={()=>{}}
    openMembership={()=>{}} assign={workspace ? ()=>{} : undefined}/>)
}
afterEach(()=>vi.restoreAllMocks())
it('validates the exact station for a roster and requires server counts and token before reset',()=>{
  expect(isStaffView(local,staffPath(space.id))).toBe(true)
  expect(isStaffView(global,staffPath(space.id))).toBe(false)
  expect(isStaffView(local,staffPath('other'))).toBe(false)
  expect(isStaffView({...local,received:[{}]},staffPath(space.id))).toBe(false)
  expect(isStaffImpact({scope:'b',impact:{token:'x',memories:1,shares:0,workspaceIds:['customer']}})).toBe(true)
  expect(isStaffImpact({scope:'b',impact:{token:'x',memories:1,workspaceIds:[]}})).toBe(false)
})
it('gives the global role card its membership list and whole-role reset',()=>{
  const html=card(global)
  expect(html).toContain('参与的工作区')
  expect(html).toContain('客户访谈')
  expect(html).toContain('重置全部记忆')
  expect(html).not.toContain('重置本区记忆')
})
it('shows the local duty, granted excerpt, and limited reset on the same card',()=>{
  const html=card(local,view)
  for(const text of ['研究员','整理访谈','确认下一步','两种按钮容易混淆','交给这位幕僚','共享经验','重置本区记忆']) expect(html).toContain(text)
  expect(html).not.toContain('重置全部记忆')
})

it('offers the approved ten objects and seven colors with a static saved portrait in the owner view',()=>{
  const portrait = {shape:'fan',color:'violet'} as const
  const saved = {...member,portrait}
  expect(isStaffView({...global,members:[{...saved,portrait:{shape:'bird',color:'violet'}}]},staffPath())).toBe(false)
  const summary = card({...global,members:[saved]})
  expect(summary).toContain('data-shape="fan" data-color="violet"')
  expect(summary).toContain('更换头像')
  expect(card({...local,members:[saved]},view)).not.toContain('更换头像')
  const picker = renderToStaticMarkup(<StaffPortraitPicker member={saved} busy={false} close={()=>{}} save={()=>{}}/>)
  expect(picker.match(/type="radio"/g)).toHaveLength(17)
  expect(picker.match(/checked=""/g)).toHaveLength(2)
  for(const label of ['折扇','指南针','双叶书签','纸飞机','钴蓝','莓红','鸢紫','恢复默认头像','保存头像','预览动效']) expect(picker).toContain(label)
})
