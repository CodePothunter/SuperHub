import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { StaffPortraitPicker } from '../src/client/workspace-staff-portrait.tsx'
import { runLabel, StaffBoard, StaffForm } from '../src/client/workspace-staff.tsx'
import { isExperienceVersion, isSharedExperienceVersion, isStaffImpact, isStaffView, staffPath } from '../src/client/workspace-staff-response.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import type { StaffMember, StaffView } from '../src/core/workspace-staff.ts'
import type { ExperienceEvidence, ExperienceMaintenance } from '../src/core/workspace-experience.ts'
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
it('shows the evidence reference on global growth records from legacy orders',()=>{
  const memory = {...local.memories[0]!,workspaceId:undefined,
    evidence:[{kind:'order' as const,id:'T-0001',version:'2026-11-20T08:00:00.000Z'}]}
  const html = card({...global,memories:[memory]})
  expect(html).toContain('来源工单')
  expect(html).toContain('来源编号 · T-0001 · 来源版本 2026-11-20T08:00:00.000Z')
})
it('shows the local duty, granted excerpt, and limited reset on the same card',()=>{
  const inherited = {...local.memories[0]!,id:'global-staff',workspaceId:undefined,text:'全局幕僚专属经验'}
  const html=card({...local,memories:[...local.memories,inherited]},view)
  for(const text of ['研究员','整理访谈','成长记录','确认下一步','两种按钮容易混淆','交给这位幕僚','共享经验','重置本区记忆']) expect(html).toContain(text)
  expect(html).not.toContain(inherited.text)
  expect(html).not.toContain('重置全部记忆')
  expect(card({...global,memories:[inherited]})).toContain(inherited.text)
})

it('reads and manages shared experience from a dedicated workspace projection',()=>{
  const common = {id:'common',audience:'shared',workspaceId:space.id,text:'复述访谈决定',status:'active',version:2,at:'2026-11-24',
    situation:'访谈收尾',taskTypes:['访谈'],evidence:[{kind:'owner',id:'message-id',quote:'以后要复述访谈决定'}]} as const
  const current = {...common,evidence:[...common.evidence],taskTypes:[...common.taskTypes]}
  const staff: StaffView = {...local,members:[],memories:[],received:[],
    sharedExperiences:[current,{...current,id:'candidate',status:'proposed',text:'访谈前复述提纲'},
      {...current,id:'retired',status:'retired',text:'旧的访谈安排',reason:'交接已统一',previousVersions:[1]},
      {...current,id:'inherited',workspaceId:undefined,text:'统一全局命名'}],
    sharedReceived:[{id:'borrowed',text:'获准参考实例',purpose:'编写访谈提纲'}]}
  const path = staffPath(space.id,true)
  expect(isStaffView(staff,path)).toBe(true)
  const read = vi.spyOn(api,'useV2Read').mockImplementation((resource,valid)=>({data:resource && valid(staff,resource) ? staff : undefined,refresh:async()=>{},error:undefined}))
  const html = renderToStaticMarkup(<StaffBoard workspace={view} experience spaces={[space]} select={()=>{}}
    openOrder={()=>{}} openMembership={()=>{}} openGlobal={()=>{}}/>)
  expect(read).toHaveBeenCalledWith(path,isStaffView,10000)
  for (const text of ['本区共同经验','复述访谈决定','以后要复述访谈决定','任务类型 · 访谈','现在整理','添加共同经验','待采纳','已停用','交接已统一','历史版本',
    '全局共同经验','统一全局命名','到「我的幕僚」管理','获准参考实例','获准借入 · 只读','编写访谈提纲']) expect(html).toContain(text)
  expect(html.match(/>更正<\/button>/g)).toHaveLength(2)
  expect(html).not.toContain(member.name)
  expect(html).not.toContain(local.memories[0]!.text)
  expect(html).not.toContain(local.received[0]!.text)
  expect(isStaffView({...staff,memories:local.memories},path)).toBe(false)
  expect(isStaffView({...staff,received:local.received},path)).toBe(false)
  expect(isStaffView({...staff,retiredMemories:[{...local.memories[0]!,audience:'staff',status:'retired'}]},path)).toBe(false)
  expect(isSharedExperienceVersion({scope:'b',memory:current})).toBe(true)
  expect(isSharedExperienceVersion({scope:'b',memory:{...local.memories[0]!,audience:'staff'}})).toBe(false)
})

it('identifies maintenance, accumulates candidate proof, and leaves paused and expired growth records manageable',()=>{
  const expiresAt = '2026-11-25T16:00:00.000Z'
  const maintenance = (action:ExperienceMaintenance['action'],actor:ExperienceMaintenance['actor'],reason?:string) => ({action,actor,at:expiresAt,reason})
  const artifact: ExperienceEvidence = {kind:'artifact',id:'source-1',workspaceId:space.id,orderId:'first',resultId:'result-first',
    fileId:'quote-1',version:'revision-1',quote:'是按段号引用'}
  const second: ExperienceEvidence = {...artifact,id:'source-2',orderId:'second',quote:'是按行号引用'}
  const record = {...local.memories[0]!,audience:'staff' as const,version:2}
  const staff: StaffView = {...local,timeZone:'Asia/Shanghai',memories:[
    {...record,text:'已经核实的做法',maintenance:maintenance('accept','system'),evidence:[artifact]},
    {...record,id:'candidate',status:'proposed',text:'还在核对的做法',supportCount:1},
    {...record,id:'old',text:'很少提供的做法',reviewSuggested:true,maintenance:maintenance('accept','manual')},
    {...record,id:'corrected',text:'本次采用段号',previousVersions:[1],maintenance:maintenance('revise','system','按新规范更正')},
    {...record,id:'replacement',text:'稍后确认的新摘录方式',replacementPending:true},
  ],retiredMemories:[
    {...record,id:'paused',status:'retired',text:'有争议的引用方式',conflict:[artifact,second],
      previousVersions:[1],maintenance:maintenance('pause','system')},
    {...record,id:'expired',status:'retired',text:'试行期旧规则',expiresAt,maintenance:maintenance('expire','system','到达有效期')},
  ]}
  const html = card(staff,view)
  for (const text of ['自动采纳','手动采纳','已有 1 个独立工单支持','仍可使用','自动更正','按新规范更正','历史版本',
    '暂停使用 · 待裁决','查看冲突依据','确认停用','是按段号引用','是按行号引用','查看交付原件','自动过期','更新期限','到达有效期',
    '来源已更新 · 暂停使用','正在核对替代材料及适用范围。',
    'dateTime="2026-11-25T16:00:00.000Z">2026-11-25</time> 当天结束']) expect(html).toContain(text)
  const path = staffPath(space.id)
  expect(isStaffView(staff,path)).toBe(true)
  expect(isStaffView({...staff,timeZone:'invalid/time-zone'},path)).toBe(false)
  expect(isStaffView({...staff,memories:[{...record,supportCount:-1}]},path)).toBe(false)
  expect(isStaffView({...staff,memories:[{...record,maintenance:{action:'accept',actor:'unknown',at:expiresAt}}]},path)).toBe(false)
  expect(isExperienceVersion({scope:'b',memory:staff.retiredMemories?.[0]})).toBe(true)
  expect(isExperienceVersion({scope:'b',memory:{...record,expiresAt:'昨天晚上'}})).toBe(false)
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

it('shows and edits how a workspace member runs; global members keep their role card',()=>{
  const own: StaffMember = {...member,id:'liuyao',name:'六爻卦师',homeWorkspaceId:space.id,model:'openai-codex/gpt-6.1-sol',reasoningEffort:'high'}
  expect(runLabel(own)).toBe('执行：DSH · openai-codex/gpt-6.1-sol（思考深度 high）')
  expect(runLabel({executor:'codex'})).toBe('执行：Codex（模型以它自己的配置为准）')
  expect(runLabel({})).toBe('执行：DSH · 沿用接口人的模型')
  const staff:StaffView = {...local,members:[own,member]}
  vi.spyOn(api,'useV2Read').mockImplementation((path,valid)=>({data:path && valid(staff,path) ? staff : undefined,refresh:async()=>{},error:undefined}))
  const detail = renderToStaticMarkup(<StaffBoard selected={own.id} workspace={view} spaces={[space]} select={()=>{}} openOrder={()=>{}} openMembership={()=>{}}/>)
  expect(detail).toContain('执行：DSH · openai-codex/gpt-6.1-sol（思考深度 high）')
  const form = (action:'create'|'edit',who:StaffMember=own) => renderToStaticMarkup(<StaffForm operation={{action}} member={who} view={staff} spaces={[space]} workspace={view}
    path={staffPath(space.id)} busy={false} close={()=>{}} save={async()=>true}/>)
  for (const html of [form('create'),form('edit')]) {
    expect(html).toContain('由谁执行')
    expect(html).toContain('>Codex</option>')
    expect(html).toContain('aria-label="模型"')
  }
  expect(form('edit',{...own,executor:'claude-code'})).toContain('在群里由 Claude Code 执行，模型和思考深度以 Claude Code 自己的配置为准。')
  expect(form('edit',member)).not.toContain('由谁执行')
})
