import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceStaffStore } from '../src/dsh/workspace-staff-store.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import { renderExperience, type ExperienceEvidence, type ExperienceSupport } from '../src/core/workspace-experience.ts'

const roots: string[] = []
afterEach(()=>{ for (const directory of roots.splice(0)) rmSync(directory,{recursive:true,force:true}) })
function setup() {
  const root = mkdtempSync(join(tmpdir(),'chief-staff-'))
  roots.push(root)
  let now = '2026-11-20T13:00:00Z'
  const open = (scope='my-brain') => new WorkspaceStaffStore(root,scope,()=>[{id:'researcher',name:'研究员',brief:'访谈和验证'}],
    id=>{ if (id !== 'alpha' && id !== 'beta') throw new Error('工作区不存在') },()=>new Date(now))
  const store = open()
  const apply = (workspaceId: string | undefined, action: string, body: Record<string,unknown>={}) =>
    store.apply(workspaceId,{action,staffId:'researcher',requestId:randomUUID(),...body})
  const ctx = (workspaceId: string) => store.context(workspaceId,'researcher')
  apply('alpha','join',{duty:'整理甲的访谈'})
  apply('beta','join',{duty:'研究产品'})
  return {root,open,store,apply,ctx,at:(when:string)=>{ now=when }}
}

describe('幕僚与工作区的经验',()=>{
  it('依来源采纳、按指定版本共享并核对重置后的原始证据与重试',()=>{
    const f = setup()
    const original = {action:'learn',staffId:'researcher',text:'客户甲姓名及其全部访谈原文',proposed:true,orderId:'ticket-A',requestId:'learn-once'}
    const memory = f.store.apply('alpha',original).memories[0]!
    expect(f.ctx('alpha').memories).toEqual([])
    f.apply('alpha','accept',{memoryId:memory.id})
    expect(f.ctx('alpha').memories).toEqual([{id:memory.id,text:original.text}])
    expect(f.store.view('beta').memories).toEqual([])
    expect(()=>f.apply('beta','accept',{memoryId:memory.id})).toThrow('此处没有')
    const shared = f.apply('alpha','share',{memoryId:memory.id,sourceVersion:2,targetWorkspaceId:'beta',text:'首屏按钮容易混淆'}).shares[0]!
    const before = f.ctx('beta')
    expect(before.memories).toEqual([{id:shared.id,text:'首屏按钮容易混淆',shared:true}])
    expect(()=>f.apply('beta','learn',{text:'来自共享内容的新推论',proposed:true})).toThrow('跨区共享')
    expect(JSON.stringify(f.store.view('beta'))).not.toContain('ticket-A')
    f.store.markUsed(before,'ticket-B')
    expect(f.store.view().memories[0]?.lastUsed?.orderId).toBe('ticket-B')
    expect(f.store.view('alpha').memories[0]?.lastUsed).toBeUndefined()
    f.apply('beta','learn',{text:'独立研发经验'})
    const impact = f.store.impact('researcher','alpha')
    expect(impact).toMatchObject({memories:1,shares:1})
    expect(impact.workspaceIds.sort()).toEqual(['alpha','beta'])
    f.apply('alpha','reset',{confirmation:impact.token})
    expect(()=>f.store.assertCurrent(before)).toThrow()
    expect(f.store.apply('alpha',original).memories).toEqual([])
    const reopened = f.open()
    expect(reopened.context('beta','researcher').memories.map(x=>x.text)).toEqual(['独立研发经验'])
    const persisted=readFileSync(join(f.root,'ops','superhub-staff',workspaceFingerprint('my-brain')+'.json'),'utf8')
    expect(persisted).not.toContain(original.text)
    expect(persisted).not.toContain('首屏按钮容易混淆')
    f.apply(undefined,'reset',{confirmation:reopened.impact('researcher').token})
    expect(reopened.context('beta','researcher').memories).toEqual([])
    expect(reopened.view('beta').members[0]?.memberships).toEqual([{workspaceId:'beta',duty:'研究产品'}])
  })

  it('可撤销、有期限的共享仅供选中的接收幕僚，修订后旧授权作废',()=>{
    const f = setup()
    const peer = f.apply('beta','create',{name:'研究员',brief:'独立角色'}).members.find(m=>m.homeWorkspaceId)!
    expect(()=>f.apply('alpha','join',{staffId:peer.id})).toThrow()
    const memoryId = f.apply('alpha','learn',{text:'客户内部访谈笔记'}).memories[0]!.id
    const grant = (sourceVersion=1) => f.apply('alpha','share',{memoryId,sourceVersion,targetWorkspaceId:'beta',targetStaffId:peer.id,text:'被允许的一句',expiresAt:'2026-11-22T00:00:00Z'}).shares[0]!
    const first = grant()
    expect(f.ctx('beta').memories).toEqual([])
    const shared = f.store.context('beta',peer.id)
    expect(shared.memories.map(x=>x.text)).toEqual(['被允许的一句'])
    f.apply('alpha','revoke',{shareId:first.id})
    expect(()=>f.store.assertCurrent(shared)).toThrow()
    grant()
    f.apply('alpha','revise',{memoryId,text:'新调查的结论'})
    expect(f.store.context('beta',peer.id).memories).toEqual([])
    expect(()=>grant()).toThrow('来源经验已变化')
    grant(2)
    const valid = f.store.context('beta',peer.id)
    f.at('2026-11-22T00:00:00Z')
    expect(()=>f.store.assertCurrent(valid)).toThrow()
    expect(f.store.view('beta').received).toEqual([])
    expect(()=>f.store.context('alpha',peer.id)).toThrow()
  })

  it('请求与脑隔离、重复提交与旧确认均保持一致',()=>{
    const f = setup()
    const global = {action:'create',name:'研究员',brief:'协调访谈',requestId:'create'}
    const first=f.store.apply(undefined,global)
    expect(f.open().apply(undefined,global)).toEqual(first)
    expect(()=>f.store.apply(undefined,{...global,name:'改名'})).toThrow('已用于')
    const oldImpact=f.store.impact('researcher','alpha')
    f.apply('alpha','learn',{text:'今天的新经验'})
    expect(()=>f.apply('alpha','reset',{confirmation:oldImpact.token})).toThrow('重新查看')
    f.apply(undefined,'learn',{text:'本人明确要求所有项目遵循的准则'})
    expect(f.ctx('beta').memories.map(x=>x.text)).toEqual(['本人明确要求所有项目遵循的准则'])
    expect(f.open('other-brain').view().memories).toEqual([])
    const former = f.ctx('alpha')
    f.apply('alpha','leave')
    expect(()=>f.store.assertCurrent(former)).toThrow()
    f.apply('alpha','join',{duty:former.duty})
    expect(()=>f.store.assertCurrent(former)).toThrow()
  })

  it('提议不改变会话上下文，采纳后可复用；纠正依据时会撤回派生经验及其共享',()=>{
    const f = setup()
    const base = f.apply('alpha','learn',{text:'原调查结论'}).memories[0]!
    const before = f.ctx('alpha')
    const proposal = f.apply('alpha','learn',{text:'依据调查得出的做法',proposed:true,witnessedToken:before.token}).memories.at(-1)!
    expect(f.ctx('alpha').token).toBe(before.token)
    f.apply('alpha','accept',{memoryId:proposal.id})
    const granted = f.apply('alpha','share',{memoryId:proposal.id,sourceVersion:2,targetWorkspaceId:'beta',text:'只带走做法'}).shares[0]!
    expect(f.ctx('beta').memories[0]?.id).toBe(granted.id)
    f.apply('alpha','revise',{memoryId:base.id,text:'新调查改变了结论'})
    expect(f.store.view('alpha').memories.map(m=>m.text)).toEqual(['新调查改变了结论'])
    expect(f.ctx('beta').memories).toEqual([])
    expect(()=>f.apply('alpha','learn',{text:'过期结果',proposed:true,witnessedToken:before.token})).toThrow('来源已变化')
  })

  it('已接管名册的原角色退休后不能借旧授权工作，恢复角色要重新加入',()=>{
    const f = setup()
    const retired = new WorkspaceStaffStore(f.root,'my-brain',()=>[],()=>true)
    const former = f.ctx('alpha')
    expect(retired.view('alpha').members).toEqual([])
    expect(()=>retired.assertCurrent(former)).toThrow()
    expect(f.store.view('alpha').available).toEqual([{id:'researcher',name:'研究员'}])
    expect(()=>f.store.assertCurrent(former)).toThrow()
  })
})

describe('已归档工作区的幕僚',()=>{
  it('已归档区不收任何幕僚改动、不能加入或接收共享；全局与其他区照常；恢复后照旧',()=>{
    const f = setup()
    const archived = new Set<string>()
    const store = new WorkspaceStaffStore(f.root,'my-brain',()=>[{id:'researcher',name:'研究员',brief:'访谈和验证'}],
      id=>{ if (id !== 'alpha' && id !== 'beta') throw new Error('工作区不存在') },()=>new Date('2026-11-24T09:00:00Z'),id=>archived.has(id))
    const apply = (workspaceId: string | undefined, action: string, body: Record<string,unknown>={}) =>
      store.apply(workspaceId,{action,staffId:'researcher',requestId:randomUUID(),...body})
    const memory = apply('alpha','learn',{text:'先访谈再出结论'}).memories[0]!
    archived.add('beta')
    const before = store.view('beta')
    expect(()=>apply('beta','join',{duty:'换一份职责'})).toThrow('工作区已归档，请先恢复')
    expect(()=>apply('beta','learn',{text:'不该记下'})).toThrow('工作区已归档，请先恢复')
    expect(()=>store.apply('beta',{action:'create',name:'竞品观察员',brief:'盯竞品动态并每周汇总',requestId:randomUUID()})).toThrow('工作区已归档，请先恢复')
    expect(()=>apply('alpha','share',{memoryId:memory.id,sourceVersion:1,targetWorkspaceId:'beta',text:'带走做法'})).toThrow('工作区已归档，请先恢复')
    expect(store.view('beta')).toEqual(before)
    expect(apply(undefined,'learn',{text:'全局经验照常'}).memories.some(m=>m.text==='全局经验照常')).toBe(true)
    archived.delete('beta')
    expect(apply('beta','learn',{text:'恢复后可以记'}).memories.some(m=>m.text==='恢复后可以记')).toBe(true)
  })

  it('专属幕僚可只给头像造型（配色照常推荐），接口人建的同名专属幕僚被拒绝且重放不重复',()=>{
    const f = setup()
    const created = f.store.apply('alpha',{action:'create',name:'竞品观察员',brief:'盯竞品动态并每周汇总',portraitShape:'lighthouse',uniqueName:true,requestId:'liaison-1'})
    const member = created.members.find(m=>m.name==='竞品观察员')!
    expect(member).toMatchObject({homeWorkspaceId:'alpha',defaultPortrait:{shape:'lighthouse',color:expect.any(String)},memberships:[{workspaceId:'alpha',duty:''}]})
    expect(f.store.apply('alpha',{action:'create',name:'竞品观察员',brief:'盯竞品动态并每周汇总',portraitShape:'lighthouse',uniqueName:true,requestId:'liaison-1'})
      .members.filter(m=>m.name==='竞品观察员')).toHaveLength(1)
    expect(()=>f.store.apply('alpha',{action:'create',name:'竞品观察员',brief:'另一份职责描述写得足够长',uniqueName:true,requestId:'liaison-2'})).toThrow('本工作区已有专属幕僚「竞品观察员」')
    expect(()=>f.store.apply('alpha',{action:'create',name:'画师',brief:'画图',portraitShape:'plane',requestId:'liaison-3'})).toThrow('头像造型')
    expect(f.store.view().members.some(m=>m.name==='竞品观察员' && !m.homeWorkspaceId)).toBe(false)
  })
})

it('matches a legacy Chinese topic split into single characters only inside its authorized workspace', () => {
  const f = setup()
  const stored = f.apply('alpha','learn',{text:'访谈结束复述约定。甲的虚构访谈对象。'}).memories[0]!
  expect(f.store.selectExperience({workspaceId:'alpha',staffId:'researcher',task:'核对访谈方法'}).entries.map(row=>row.id))
    .toContain(stored.id)
  expect(f.store.selectExperience({workspaceId:'alpha',staffId:'researcher',task:'整理公司财报'}).entries).toEqual([])
  expect(f.store.selectExperience({workspaceId:'beta',task:'核对访谈方法'}).entries).toEqual([])
})

describe('共享智能体经验',()=>{
  it('升级旧经验为具名专属，并按来源区、接收身份和任务适用性选取',()=>{
    const f = setup()
    const path = join(f.root,'ops','superhub-staff',workspaceFingerprint('my-brain')+'.json')
    const legacy = JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>
    const old = {id:'old-experience',staffId:'researcher',workspaceId:'alpha',text:'缺陷修复检查同类调用路径',
      status:'active',version:3,at:'2026-11-19T13:00:00Z'}
    writeFileSync(path,JSON.stringify({...legacy,schema:1,memories:[old]}))
    const request = {task:'处理登录缺陷',taskTypes:['缺陷修复']}
    expect(f.store.selectExperience({...request,workspaceId:'alpha'}).entries).toEqual([])
    expect(f.store.selectExperience({...request,workspaceId:'alpha',staffId:'researcher'}).entries)
      .toEqual([expect.objectContaining({id:old.id,version:3})])
    expect(f.store.selectExperience({...request,workspaceId:'beta',staffId:'researcher'}).entries).toEqual([])
    expect(f.open().experienceMemories('alpha')[0]).toMatchObject({audience:'staff',...old})
    const common = (workspaceId: string | undefined, text: string, taskTypes: string[]) => f.store.apply(workspaceId,
      {action:'learn',audience:'shared',requestId:randomUUID(),text,taskTypes})
    common(undefined,'提交版本前保存测试回执',['缺陷修复'])
    common('alpha','甲区登录缺陷需要覆盖旧账号',['缺陷修复'])
    common('beta','乙区内部登录方案',['缺陷修复'])
    common('alpha','研读采购报价',['采购'])
    const alpha = f.store.selectExperience({...request,workspaceId:'alpha'})
    expect(alpha.entries.map(x=>x.text)).toEqual(['甲区登录缺陷需要覆盖旧账号','提交版本前保存测试回执'])
    expect(alpha.authorized).toHaveLength(3)
    const beta = f.open().selectExperience({...request,workspaceId:'beta'})
    expect(beta.entries.map(x=>x.text)).toEqual(['乙区内部登录方案','提交版本前保存测试回执'])
    const delegated = f.store.selectExperience({...request,workspaceId:'alpha',delegated:[{id:old.id,version:3}]})
    expect(delegated.entries.some(ref=>ref.id===old.id)).toBe(true)
    expect(f.store.selectExperience({...request,workspaceId:'beta',delegated:[{id:old.id,version:3}]}).authorized)
      .not.toContainEqual({id:old.id,version:3})
    expect(f.store.selectExperience({workspaceId:'alpha',task:'编排行政日历'}).entries).toEqual([])
    expect(renderExperience({...alpha,behavior:'共同偏好'})).toMatch(/^共同偏好\n\n/)
  })

  it('只分享批准文字，限制用途并将派生权限绑到共享版本',()=>{
    const f = setup()
    const input = {action:'learn',audience:'shared',requestId:'source',text:'访谈含内部名字张三与联系方式',
      evidence:[{id:'message-a',kind:'owner',workspaceId:'alpha',quote:'甲区私密原话'}]}
    const source = f.store.apply('alpha',input).sharedExperiences![0]!
    const shared = f.store.apply('alpha',{action:'share',audience:'shared',requestId:'share',memoryId:source.id,
      sourceVersion:source.version,targetAudience:'shared',targetWorkspaceId:'beta',text:'续约前安排访谈',
      purpose:'客户续约',expiresAt:'2026-11-22T00:00:00Z'}).shares[0]!
    expect(f.store.selectExperience({workspaceId:'beta',task:'客户投诉'}).authorized).toEqual([])
    expect(f.store.selectExperience({workspaceId:'beta',task:'客户投诉',domains:['客户续约'],taskTypes:['客户续约']}).authorized).toEqual([])
    expect(f.store.selectExperience({workspaceId:'beta',task:'客户续约作为接口人补充',purposeTask:'客户投诉'}).authorized).toEqual([])
    const selected = f.store.selectExperience({workspaceId:'beta',task:'客户续约'})
    expect(selected.entries).toEqual([{id:shared.id,version:1,shareId:shared.id,text:'续约前安排访谈',
      purpose:'客户续约',workspaceId:'beta',staffId:undefined}])
    const rendered = renderExperience(selected)
    expect(rendered).toContain('续约前安排访谈')
    expect(rendered).not.toMatch(/张三|message-a|甲区私密原话/)
    expect(()=>f.store.experienceVersion('beta',source.id,1)).toThrow('此处没有')
    f.store.apply('beta',{action:'learn',audience:'shared',requestId:'derived',text:'续约经验的衍生整理',
      dependencies:[{id:shared.id,version:1}]})
    const derived = f.store.experienceMemories('beta')[0]!
    expect(()=>f.store.apply('beta',{action:'share',audience:'shared',requestId:'share-derived',
      memoryId:derived.id,sourceVersion:derived.version,targetAudience:'shared',targetWorkspaceId:'alpha',text:derived.text}))
      .toThrow('原有共享未覆盖这次接收范围')
    expect(f.store.selectExperience({workspaceId:'beta',task:'其他类型续约'}).entries).toEqual([])
    f.at('2026-11-22T00:00:00Z')
    expect(()=>f.store.assertExperienceCurrent(selected)).toThrow('授权已经变化')
    expect(f.open().experienceMemories('beta')).toMatchObject([{status:'retired',reason:'来源经验或共享授权已失效'}])
  })

  it('幂等登记真实送达，批次遇旧版本保持原状，停用后可审阅及恢复旧版本',()=>{
    const f = setup()
    const source = f.store.apply('alpha',{action:'learn',audience:'shared',requestId:'learn',text:'登录缺陷按历史账号复测'})
      .sharedExperiences![0]!
    const selection = f.store.selectExperience({workspaceId:'alpha',task:'复测登录缺陷'})
    const target = {sessionId:'group-one',nativeSessionId:'native-one',executorId:'temp-one',turnId:'reply-1',orderId:'order-1'}
    const readDelivery = () => f.open().experienceDeliveries({workspaceId:'alpha',sessionId:'group-one'})
    expect(readDelivery()).toEqual([])
    f.store.recordExperienceDelivery(selection,target)
    f.open().recordExperienceDelivery(selection,target)
    expect(readDelivery()).toMatchObject([{...target,entries:[{id:source.id,version:1}]}])
    const evidence = {kind:'owner',id:'message-id',workspaceId:'alpha'}
    const feedback = {id:'feedback-id',memory:{id:source.id,version:1},kind:'owner-correction',evidence,sessionId:'group-one'}
    const revise = {action:'revise',audience:'shared',memoryId:source.id,version:1,text:'登录缺陷按账号类型复测'}
    const batch = {id:'change-set',basedOn:[source],changes:[revise,{action:'feedback',feedback}]}
    const stale = {id:'stale-set',basedOn:[source],changes:[{action:'learn',audience:'shared',text:'可能使已停用经验复活'}]}
    expect(()=>f.store.applyExperienceBatch('alpha',{id:'failed-set',changes:[revise,{...revise,version:5}]}))
      .toThrow('经验已变化')
    expect(f.open().experienceMemories('alpha')).toMatchObject([{version:1,text:source.text}])
    expect(f.store.applyExperienceBatch('alpha',batch)).toBe('applied')
    expect(f.open().applyExperienceBatch('alpha',batch)).toBe('duplicate')
    expect(()=>f.store.applyExperienceBatch('alpha',stale)).toThrow('经验已经变化')
    expect(f.store.experienceVersion('alpha',source.id,1).text).toBe(source.text)
    expect(f.store.experienceMemories('alpha')).toMatchObject([{version:2,feedback:[{kind:'owner-correction',memory:{version:1}}]}])
    expect(()=>f.store.assertExperienceCurrent(selection)).toThrow('经验或使用授权已经变化')
    const apply = (action: string, version: number, extra: Record<string,unknown> = {}) => f.store.apply('alpha',
      {action,audience:'shared',version,memoryId:source.id,requestId:randomUUID(),...extra})
    apply('retire',2,{reason:'这项流程不再适用'})
    expect(f.store.selectExperience({workspaceId:'alpha',task:'复测登录缺陷'}).entries).toEqual([])
    expect(f.store.view('alpha').sharedExperiences).toMatchObject([{version:3,status:'retired',reason:'这项流程不再适用'}])
    apply('restore',3,{restoreVersion:1})
    expect(f.open().selectExperience({workspaceId:'alpha',task:'复测登录缺陷'}).entries)
      .toMatchObject([{id:source.id,version:4,text:source.text}])
  })
})

describe('自动维护的经验版本',()=>{
  const memory = (f: ReturnType<typeof setup>) => f.open().experienceMemories('alpha')[0]!
  const task = {workspaceId:'alpha',task:'核对访谈引文时间戳'}
  const artifact = (id: string, orderId: string, version = 'v1'): ExperienceEvidence => ({
    kind:'artifact',id,orderId,workspaceId:'alpha',sessionId:'interview',fileId:'transcript',resultId:'result-' + id,version,quote:'00:04 原始引文',
  })
  const operate = (f: ReturnType<typeof setup>, action: string, extra: Record<string,unknown>) =>
    f.store.apply('alpha',{action,audience:'shared',requestId:randomUUID(),...extra},true)

  it('在第二份独立工单原件到达后自动采纳，并在同一批次保存依据和历史',()=>{
    const f = setup()
    const candidate = operate(f,'learn',{text:'访谈引文保留时间戳',proposed:true}).sharedExperiences![0]!
    const support = (orderId: string, origin: string): ExperienceSupport => ({orderId,origin,evidence:[artifact(orderId,orderId)]})
    const batch = (id: string, supports: ExperienceSupport[]) => ({id,changes:[{
      action:'support',audience:'shared',memoryId:candidate.id,version:1,supports,supportsComplete:true,
    }]})
    f.store.applyExperienceBatch('alpha',batch('first',[support('interview-a','original-a')]))
    f.store.applyExperienceBatch('alpha',batch('followup',[support('interview-a','original-a'),support('interview-a','followup-a')]))
    expect(f.store.selectExperience(task).entries).toEqual([])
    f.store.applyExperienceBatch('alpha',batch('copies',[support('interview-a','original-a'),support('interview-b','original-a')]))
    expect(f.store.selectExperience(task).entries).toEqual([])
    expect(f.store.view('alpha',true).sharedExperiences?.[0]).toMatchObject({version:1,status:'proposed',supportCount:1})
    expect(f.store.view('alpha',true).sharedExperiences?.[0]).not.toHaveProperty('supports')
    const privateSupport = {...support('private','private-origin'),evidence:[{...artifact('private','private'),staffId:'researcher'}]}
    expect(()=>f.store.applyExperienceBatch('alpha',batch('private',[privateSupport]))).toThrow('本范围')
    expect(()=>operate(f,'accept',{memoryId:candidate.id,version:1,actor:'system'})).toThrow('只接受主人操作')
    const verified = batch('second',[support('interview-a','original-a'),support('interview-b','original-b')])
    f.open().applyExperienceBatch('alpha',verified)
    expect(f.open().hasExperienceBatch('alpha',verified.id,verified.changes)).toBe(true)
    expect(f.open().applyExperienceBatch('alpha',verified)).toBe('duplicate')
    expect(memory(f)).toMatchObject({version:2,status:'active',maintenance:{actor:'system',action:'accept'},
      evidence:[{orderId:'interview-a',fileId:'transcript'},{orderId:'interview-b',fileId:'transcript'}]})
    expect(f.open().experienceVersion('alpha',candidate.id,1,true)).toMatchObject({status:'proposed',supportCount:1})
    expect(f.open().selectExperience(task).entries).toMatchObject([{id:candidate.id,version:2}])
    expect(f.open().selectExperience({...task,workspaceId:'beta'}).entries).toEqual([])
  })

  it('过期立即影响执行和旧版恢复，修改期限以新版本恢复，低频只提醒',()=>{
    const f = setup()
    const expiring = operate(f,'learn',{text:'核对访谈引文时间戳',experienceExpiresAt:'2026-11-21T09:00:00+08:00'}).sharedExperiences![0]!
    const prior = f.store.selectExperience(task)
    expect(prior.entries).toMatchObject([{id:expiring.id,version:1}])
    f.at('2026-11-21T01:00:00Z')
    expect(()=>f.open().assertExperienceCurrent(prior)).toThrow('使用授权已经变化')
    const expired = memory(f)
    expect(expired).toMatchObject({version:2,status:'retired',expiresAt:'2026-11-21T01:00:00.000Z',
      maintenance:{actor:'system',action:'expire',at:'2026-11-21T01:00:00.000Z'}})
    expect(()=>operate(f,'restore',{memoryId:expiring.id,version:2,restoreVersion:1})).toThrow('有效期')
    operate(f,'revise',{memoryId:expiring.id,version:2,experienceExpiresAt:null})
    expect(f.open().selectExperience(task).entries).toMatchObject([{id:expiring.id,version:3}])
    f.at('2027-02-20T01:00:00Z')
    expect(f.open().view('alpha',true).sharedExperiences?.[0]).toMatchObject({version:3,status:'active',reviewSuggested:true})
    const current = f.store.selectExperience(task)
    f.store.recordExperienceDelivery(current,{sessionId:'conversation',executorId:'liaison',turnId:'conversation-1'})
    expect(f.open().view('alpha',true).sharedExperiences?.[0]?.reviewSuggested).toBeUndefined()
    expect(f.open().selectExperience(task).entries).toHaveLength(1)
  })

  it('自动纠正替代材料后旧前提不能恢复，冲突暂停可由主人裁决',()=>{
    const f = setup()
    const original = artifact('template-old','template-order')
    const replacement = artifact('template-new','template-order-2','v2')
    f.store.applyExperienceBatch('alpha',{id:'learn',changes:[{action:'learn',audience:'shared',
      text:'访谈引文使用原模板',situation:'访谈引文',source:'observation',evidence:[original],premise:original}]})
    const {id:memoryId} = memory(f)
    const live = f.store.selectExperience(task)
    expect(live.entries).toHaveLength(1)
    f.store.holdReplacedExperience('alpha',undefined,[{id:memoryId,version:1}])
    expect(()=>f.open().assertExperienceCurrent(live)).toThrow('使用授权已经变化')
    expect(memory(f)).toMatchObject({version:1,status:'active',replacementPending:true})
    expect(f.open().view('alpha',true).sharedExperiences?.[0]).toMatchObject({replacementPending:true})
    const revise = {action:'revise',audience:'shared',memoryId,version:1,text:'访谈引文使用新模板',evidence:[replacement],
      premise:replacement,supersedes:true}
    f.store.applyExperienceBatch('alpha',{id:'revise',changes:[revise]})
    expect(memory(f)).toMatchObject({version:2,text:revise.text,maintenance:{actor:'system',action:'revise'}})
    expect(()=>operate(f,'restore',{memoryId,version:2,restoreVersion:1})).toThrow('材料已失效')
    const conflict = artifact('alternate','alternate-order')
    const batch = {id:'pause',changes:[{action:'pause',audience:'shared',memoryId,version:2,evidence:[replacement,conflict]}]}
    f.store.applyExperienceBatch('alpha',batch)
    expect(f.store.selectExperience(task).entries).toEqual([])
    expect(memory(f)).toMatchObject({version:3,status:'retired',maintenance:{actor:'system',action:'pause'},conflict:[replacement,conflict]})
    operate(f,'restore',{memoryId,version:3,restoreVersion:2})
    expect(f.store.applyExperienceBatch('alpha',batch)).toBe('duplicate')
    expect(memory(f)).toMatchObject({version:4,status:'active',maintenance:{actor:'manual',action:'restore'}})
    expect(memory(f)).not.toHaveProperty('conflict')
    expect(f.open().selectExperience(task).entries).toMatchObject([{id:memoryId,version:4}])
    f.store.applyExperienceBatch('alpha',{id:'source-expired',changes:[{action:'expire',audience:'shared',memoryId,version:4,
      reason:'访谈模板已废止',evidence:[artifact('notice','template-order-3')]}]})
    expect(memory(f)).toMatchObject({version:5,status:'retired',maintenance:{actor:'system',action:'expire',reason:'访谈模板已废止'}})
    expect(()=>operate(f,'restore',{memoryId,version:5,restoreVersion:4})).toThrow('材料已失效')
  })
})
