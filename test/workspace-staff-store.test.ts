import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceStaffStore } from '../src/dsh/workspace-staff-store.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'

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
