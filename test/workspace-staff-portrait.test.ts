import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { avatarColors, avatarShapes, defaultStaffPortrait, ownerPortrait } from '../src/core/workspace-avatars.ts'
import { groupLeadId, workspaceSpeakerId } from '../src/dsh/workspace-speaker-id.ts'
import type { Agent, HostContext, SessionEventLike } from '../src/dsh/ports.ts'
import { NativeRooms, roomSessionId } from '../src/dsh/rooms.ts'
import { WorkspaceStaffStore } from '../src/dsh/workspace-staff-store.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'

const roots:string[] = []
afterEach(()=>{for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true})})
const pick = {shape:'bell',color:'rose'} as const

function fixture(extraRoles: {id:string;name:string;brief:string}[] = []) {
  const root = mkdtempSync(join(tmpdir(),'chief-staff-portraits-'))
  roots.push(root)
  const scope = 'private-brain'
  const board = new WorkspaceV2Store(root,scope)
  const open = () => new WorkspaceStaffStore(root,scope,()=>[{id:'analyst',name:'分析师',brief:'核对数据'},...extraRoles],id=>board.workspace(id))
  const staff = open()
  const key = () => mutationKey(['portrait-test'],{requestId:randomUUID()})
  const work = (name:string) => board.createWorkspace(key(),{name}).workspace.id
  const a=work('甲'), b=work('乙')
  const apply = (workspaceId:string|undefined,body:Record<string,unknown>) => staff.apply(workspaceId,{requestId:randomUUID(),...body})
  for (const workspaceId of [a,b]) apply(workspaceId,{action:'join',staffId:'analyst'})
  const local=apply(a,{action:'create',name:'分析师',brief:'本区资料'}).members.find(m=>m.homeWorkspaceId===a)!
  const session = (workspaceId:string) => board.createSession(key(),workspaceId,{kind:'group',title:'发言'}).session.id
  return {root,scope,board,open,staff,a,b,apply,local,session}
}

it('内置幕僚按固定身份分配不同造型，手选和恢复默认同步到会话',()=>{
  const portraits = {
    chief:{shape:'bell',color:'apricot'}, engineer:{shape:'wrench',color:'blue'}, liaison:{shape:'key',color:'teal'},
    researcher:{shape:'compass',color:'mint'}, reviewer:{shape:'lighthouse',color:'violet'}, scribe:{shape:'pencil',color:'honey'},
    strategist:{shape:'hourglass',color:'blue'}, 'ui-smith':{shape:'fan',color:'rose'},
  }
  const f = fixture(Object.keys(portraits).map(id=>({id,name:'改名后的角色',brief:'新的职责'})))
  const roster = f.staff.view().members.filter(member=>Object.hasOwn(portraits,member.id))
  expect(Object.fromEntries(roster.map(member=>[member.id,member.portrait]))).toEqual(portraits)
  expect(new Set(roster.map(member=>member.portrait?.shape)).size).toBe(8)

  f.apply(f.a,{action:'join',staffId:'engineer'})
  const sessionId = f.session(f.a)
  const id = workspaceSpeakerId(groupLeadId(f.scope,f.a,sessionId),'staff','engineer')
  const current = () => f.board.speakerPortraits(f.a,sessionId,[id],f.open())[id]
  expect(current()).toEqual(portraits.engineer)
  f.apply(undefined,{action:'portrait',staffId:'engineer',portrait:pick})
  expect(f.open().view(f.a).members.find(member=>member.id==='engineer')).toMatchObject({portrait:pick,defaultPortrait:portraits.engineer})
  expect(current()).toEqual(pick)
  f.apply(undefined,{action:'portrait',staffId:'engineer',portrait:null})
  expect(current()).toEqual(portraits.engineer)
})

it('新幕僚按职责选择并保存默认头像，重试、改名与恢复默认沿用选择',()=>{
  const f = fixture([{id:'researcher',name:'研究员',brief:'调研'}])
  const body = {action:'create',name:'轮值访谈研究员',brief:'整理访谈方法',requestId:'semantic-create'}
  const made = f.apply(undefined,body).members.find(member=>member.name===body.name)!
  expect(made.defaultPortrait?.shape).toBe('compass')
  expect(made.defaultPortrait?.color).not.toBe('mint')
  expect(made.portrait).toEqual(made.defaultPortrait)
  expect(f.apply(undefined,body).members.filter(member=>member.name===body.name)).toEqual([made])

  f.apply(undefined,{action:'edit',staffId:made.id,name:'改名的幕僚',brief:'开展软件开发'})
  f.apply(undefined,{action:'portrait',staffId:made.id,portrait:pick})
  f.apply(f.a,{action:'join',staffId:made.id})
  expect(f.open().view(f.a).members.find(member=>member.id===made.id)).toMatchObject({portrait:pick,defaultPortrait:made.defaultPortrait})
  const restored = f.apply(undefined,{action:'portrait',staffId:made.id,portrait:null}).members.find(member=>member.id===made.id)
  expect(restored?.portrait).toEqual(made.defaultPortrait)

  const unknown = f.apply(undefined,{action:'create',name:'甲',brief:'处理临时事项'}).members.find(member=>member.name==='甲')!
  expect(unknown.portrait).toEqual(defaultStaffPortrait(unknown.id))
})

it('保存70种头像并校验角色所属范围，恢复默认后旧请求不会再改写，也不改变模型的记忆版本',()=>{
  const f = fixture()
  const body = {action:'portrait',staffId:'analyst',portrait:pick,requestId:'pick-first'}
  const token = f.staff.context(f.a,'analyst').token
  const previous = f.staff.view().members.find(m=>m.id==='analyst')!
  expect(previous.portrait).toEqual({shape:'lighthouse',color:'blue'})
  expect(previous.portrait).toEqual(previous.defaultPortrait)
  expect(()=>f.apply(f.a,body)).toThrow('所属范围')
  f.apply(undefined,body)
  const current = (area?:string)=>f.open().view(area).members.find(m=>m.id==='analyst')?.portrait
  expect(current(f.a)).toEqual(pick)
  expect(current(f.b)).toEqual(pick)
  expect(f.staff.context(f.a,'analyst').token).toBe(token)
  expect(()=>f.apply(undefined,{...body,portrait:null})).toThrow('已用于')
  for (const shape of avatarShapes) for (const color of avatarColors) {
    const view = f.apply(f.a,{action:'portrait',staffId:f.local.id,portrait:{shape,color}})
    expect(view.members.find(m=>m.id===f.local.id)?.portrait).toEqual({shape,color})
  }
  for (const invalid of [undefined,{},false,'',[],{shape:'bell',color:'unknown'},{shape:'unknown',color:'blue'}]) {
    expect(()=>f.apply(undefined,{action:'portrait',staffId:'analyst',portrait:invalid})).toThrow('形状和配色')
  }
  expect(()=>f.apply(undefined,{action:'portrait',staffId:f.local.id,portrait:pick})).toThrow('所属范围')
  expect(()=>f.apply(f.b,{action:'portrait',staffId:f.local.id,portrait:pick})).toThrow('没有这位幕僚')
  f.apply(undefined,{action:'portrait',staffId:'analyst',portrait:null})
  expect(current()).toEqual(previous.defaultPortrait)
  expect(f.apply(undefined,body).members.find(m=>m.id==='analyst')?.portrait).toEqual(previous.defaultPortrait)
})

it('同一具名幕僚在两区旧会话及原生工单沿用头像，身份未知的同名发言没有匹配',()=>{
  const f=fixture()
  f.apply(undefined,{action:'portrait',staffId:'analyst',portrait:pick})
  f.apply(f.a,{action:'portrait',staffId:f.local.id,portrait:{shape:'wrench',color:'mint'}})
  for (const area of [f.a,f.b]) {
    const sessionId=f.session(area)
    const lead=groupLeadId(f.scope,area,sessionId)
    const first=workspaceSpeakerId(lead,'staff','analyst'), second=workspaceSpeakerId(lead,'staff',f.local.id)
    const generic=workspaceSpeakerId(lead,'native-member','分析师')
    const ids = area===f.a ? [first,second,generic,'owner'] : [first,generic,'owner']
    const projected=f.board.speakerPortraits(area,sessionId,ids,f.staff)
    expect(projected[first]).toEqual(pick)
    if (area===f.a) expect(projected[second]).toEqual({shape:'wrench',color:'mint'})
    expect(projected.owner).toEqual(ownerPortrait)
    expect(f.staff.speakerPortraits([generic,'owner'],[{conversation:lead,kind:'staff'}])).toEqual({})
    f.apply(area,{action:'leave',staffId:'analyst'})
    expect(new WorkspaceV2Store(f.root,f.scope).speakerPortraits(area,sessionId,ids,f.open())).toEqual(projected)
  }
})


it('原生讨论中已由宿主绑定的幕僚沿用角色头像，历史快照可重读，不按相同署名猜测',async()=>{
  const f = fixture()
  const session = roomSessionId(f.root,'review')
  const peer = 'verified-peer', old = 'old-peer'
  const messages:SessionEventLike[] = [peer,old].map((sender,index)=>({
    seq:index+1,time:100+index,type:'user/message',data:{id:sender,
      source:{kind:'agent-message',senderSessionId:sender},content:[{type:'text',text:'一条公开发言'}]},
  }))
  const agent = (id:string):Agent => ({id,session:{snapshotEvents:()=>id===session ? messages : []},
    ctx:{systemPrompt:{section:()=>()=>{}}}})
  const lead = agent(session)
  const agents = new Map([session,peer,old].map(id=>[id,agent(id)]))
  const host = {agents:{get:(id:string)=>agents.get(id)},get:(key:string)=>key==='agentTeams' ? {
    tryMembership:(who:Agent)=>({role:who.id===session ? 'lead' : 'teammate',root:lead,name:who.id===session ? 'lead' : 'analyst'}),
    listMembers:()=>Array.from(agents.keys(),id=>({id,name:id===session ? 'lead' : 'analyst'})),listTasks:()=>[],
  } : undefined,sessionController:{resolveAgent:async(id:string)=>({agent:agents.get(id)})}} as unknown as HostContext
  writeFileSync(join(f.root,'ops','room-index.json'),JSON.stringify([{session,id:'review',title:'讨论',notes:[]}]))
  const known = workspaceSpeakerId(session,'native-member',peer)
  const unbound = workspaceSpeakerId(session,'native-member',old)
  const open = () => new NativeRooms(host,f.root,()=>[{id:'analyst',name:'分析师',brief:'阅读资料'}],undefined,undefined,undefined,f.open())
  const rooms = open()
  try {
    rooms.attachContext(agents.get(peer)!)
    f.apply(undefined,{action:'portrait',staffId:'analyst',portrait:pick})
    expect((await rooms.view('review')).portraits?.[known]).toEqual(pick)
    expect(rooms.knownPortraits([known,unbound,'owner'])).toEqual({[known]:pick})
  } finally {rooms.dispose()}
  const reopened = open()
  try {
    f.apply(undefined,{action:'portrait',staffId:'analyst',portrait:null})
    expect(reopened.knownPortraits([known,unbound])).toEqual({[known]:defaultStaffPortrait('analyst')})
  } finally {reopened.dispose()}
})
