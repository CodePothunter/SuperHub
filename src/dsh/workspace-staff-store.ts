import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Staff } from '../core/model.ts'
import type { StaffContext, StaffImpact, StaffMember, StaffMemory, StaffShare, StaffView } from '../core/workspace-staff.ts'
import { defaultStaffPortrait, isSpeakerPortrait, isStaffAvatarShape, recommendStaffPortrait, type SpeakerPortrait, type SpeakerPortraits } from '../core/workspace-avatars.ts'
import { WORKSPACE_ARCHIVED } from '../core/workspace-v2.ts'
import { workspaceSpeakerId } from './workspace-speaker-id.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import { mutationKey } from './workspace-v2-store.ts'

type Body = Record<string, unknown>
type RosterEntry = Pick<Staff, 'id' | 'name' | 'brief' | 'defaultPortrait'>
interface StaffState {
  schema: 1
  members: StaffMember[]
  native: Record<string, { name: string; brief: string; retired: boolean }>
  dependencies: Record<string, { id: string; version: number }[]>
  memories: StaffMemory[]
  shares: StaffShare[]
  roomSpeakers?: Record<string,string>
  generations: Record<string, number>
  receipts: Record<string, string>
}
const empty = (): StaffState => ({schema:1, members:[], native:{}, dependencies:{}, memories:[], shares:[], generations:{}, receipts:{}})
function field(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return workspaceError(400, '请填写有效的' + label)
  return value.trim()
}
function optional(value: unknown, label: string, max: number) {
  return value === undefined || value === '' ? undefined : field(value,label,max)
}
function selectedPortrait(value: unknown): SpeakerPortrait {
  if (!isSpeakerPortrait(value)) return workspaceError(400,'请选择头像的形状和配色')
  return {shape:value.shape,color:value.color}
}
function memberPortraits(member: StaffMember) {
  const defaultPortrait = defaultStaffPortrait(member.id,member.defaultPortrait)
  return {defaultPortrait,portrait: member.portrait ?? defaultPortrait}
}
function activeMembers(db: StaffState, workspaceId?: string) {
  return db.members.filter(member => !db.native['role-' + member.id]?.retired
    && (workspaceId === undefined || member.memberships.some(m => m.workspaceId === workspaceId)))
}
function memberIn(db: StaffState, staffId: unknown, workspaceId?: string) {
  const member = db.members.find(row => row.id === staffId)
  if (!member || db.native['role-' + member.id]?.retired || workspaceId !== undefined && !member.memberships.some(m => m.workspaceId === workspaceId)) {
    return workspaceError(404, '此处没有这位幕僚')
  }
  return member
}
const generationKey = (staffId: string, workspaceId?: string) => workspaceFingerprint([staffId, workspaceId ?? null])
function advance(db: StaffState, staffId: string, workspaceId?: string) {
  const key = generationKey(staffId,workspaceId)
  db.generations[key] = (db.generations[key] ?? 0) + 1
}
function affectedShare(share: StaffShare, staffId: string, workspaceId?: string) {
  return share.staffId === staffId && (!workspaceId || share.workspaceId === workspaceId)
    || share.targetStaffId === staffId && (!workspaceId || share.targetWorkspaceId === workspaceId)
}
function isLive(share: StaffShare, now: string) {
  return !share.expiresAt || share.expiresAt > now
}
function invalidateShares(db: StaffState, drop: (share: StaffShare) => boolean) {
  db.shares = db.shares.filter(share => {
    if (!drop(share)) return true
    advance(db,share.targetStaffId,share.targetWorkspaceId)
    return false
  })
}
function pruneSuggestions(db: StaffState) {
  // Suggestions only point back to older, active memories. One pass in insertion order also removes their descendants.
  const versions = new Map<string,number>()
  const forgotten = new Set<string>()
  db.memories = db.memories.filter(memory => {
    const valid = db.dependencies[memory.id]?.every(source=>versions.get(source.id)===source.version) ?? true
    if (valid && memory.status==='active') versions.set(memory.id,memory.version)
    if (!valid) {
      forgotten.add(memory.id)
      advance(db,memory.staffId,memory.workspaceId)
    }
    return valid
  })
  if (forgotten.size) invalidateShares(db,s=>forgotten.has(s.memoryId))
  const retained = new Set(db.memories.map(m=>m.id))
  for (const id of Object.keys(db.dependencies)) if (!retained.has(id)) delete db.dependencies[id]
}
function affected(db: StaffState, staffId: string, workspaceId?: string): StaffImpact {
  const member = memberIn(db,staffId)
  if (workspaceId && member.homeWorkspaceId && member.homeWorkspaceId !== workspaceId) workspaceError(404,'此处没有这位幕僚')
  const memories = db.memories.filter(m => m.staffId === staffId && (!workspaceId || m.workspaceId === workspaceId))
  const shares = db.shares.filter(s => affectedShare(s,staffId,workspaceId))
  const workspaceIds = new Set(memories.flatMap(m => m.workspaceId ? [m.workspaceId] : []))
  if (workspaceId) workspaceIds.add(workspaceId)
  else for (const m of member.memberships) workspaceIds.add(m.workspaceId)
  for (const s of shares) {
    if (!workspaceId || s.workspaceId === workspaceId) workspaceIds.add(s.workspaceId)
    workspaceIds.add(s.targetWorkspaceId)
  }
  const token = workspaceFingerprint([staffId,workspaceId,memories.map(m=>[m.id,m.version]),shares.map(s=>s.id),
    [...workspaceIds].sort(),db.generations[generationKey(staffId,workspaceId)] ?? 0])
  return {memories:memories.length,shares:shares.length,workspaceIds:[...workspaceIds],token}
}

/** The host holds the brain's writer lock. Read/modify/rename stays synchronous, also across hot reloads. */
export class WorkspaceStaffStore {
  private readonly file: string

  /** `archived`: the workspace is archived, so its staff take no changes (and nobody joins it) until it is restored. */
  constructor(root: string, readonly scope: string, private readonly roster: () => readonly RosterEntry[],
    private readonly workspace: (id: string) => unknown, private readonly now: () => Date = () => new Date(),
    private readonly archived: (id: string) => boolean = () => false) {
    this.file = join(root,'ops','superhub-staff',workspaceFingerprint(scope) + '.json')
  }

  private read() {
    let db: StaffState
    try {
      db = existsSync(this.file) ? JSON.parse(readFileSync(this.file,'utf8')) as StaffState : empty()
      if (db.schema !== 1 || !Array.isArray(db.members) || !Array.isArray(db.memories) || !Array.isArray(db.shares) ||
        !db.generations || !db.receipts) throw new Error()
    } catch { return workspaceError(503,'幕僚资料暂时无法读取') }
    const roster = this.roster()
    db.native ??= {}
    db.dependencies ??= {}
    let retired = false
    for (const member of db.members) {
      const native = db.native['role-' + member.id]
      if (native && !native.retired && !roster.some(row=>row.id===member.id)) {
        native.retired = true
        member.memberships = []
        invalidateShares(db,s=>affectedShare(s,member.id))
        advance(db,member.id)
        retired = true
      }
    }
    for (const entry of roster) {
      let member = db.members.find(row=>row.id===entry.id)
      const native = db.native['role-' + entry.id]
      if (!member) {
        member = {id:entry.id, name:entry.name, brief:entry.brief, memberships:[]}
        db.members.push(member)
      } else if (native) {
        if (member.name===native.name) member.name = entry.name
        if (member.brief===native.brief) member.brief = entry.brief
      }
      member.defaultPortrait = entry.defaultPortrait
      db.native['role-' + entry.id] = {name:entry.name,brief:entry.brief,retired:false}
    }
    if (retired) this.save(db)
    return db
  }

  private save(db: StaffState) {
    const tmp = this.file + '.' + randomUUID() + '.tmp'
    try {
      mkdirSync(dirname(this.file),{recursive:true,mode:0o700})
      writeFileSync(tmp,JSON.stringify(db) + '\n',{flag:'wx',mode:0o600})
      renameSync(tmp,this.file)
    } catch {
      rmSync(tmp,{force:true})
      workspaceError(503,'幕僚资料暂时无法保存')
    }
  }

  private present(db: StaffState, workspaceId?: string): StaffView {
    const active = activeMembers(db)
    const local = active.filter(m => !workspaceId || m.memberships.some(p => p.workspaceId === workspaceId))
    const now = this.now().toISOString()
    return {scope:this.scope,workspaceId,
      members:local.map(m => ({...m,...memberPortraits(m),
        memberships:m.memberships.filter(p => !workspaceId || p.workspaceId === workspaceId)})),
      available:workspaceId ? active.filter(m => !m.homeWorkspaceId && !local.includes(m)).map(({id,name})=>({id,name})) : [],
      memories:db.memories.filter(m=>local.some(s=>s.id===m.staffId) &&
        (!workspaceId || m.workspaceId === workspaceId || !m.workspaceId && m.status==='active')).map(m => ({...m,
        lastUsed: !workspaceId || m.lastUsed?.workspaceId === workspaceId ? m.lastUsed : undefined})),
      shares:db.shares.filter(s=>(!workspaceId || s.workspaceId===workspaceId) && isLive(s,now))
        .map(s=>({...s,targetStaffName:active.find(m=>m.id===s.targetStaffId)?.name})),
      received:db.shares.filter(s=>s.targetWorkspaceId===workspaceId && isLive(s,now))
        .map(s=>({id:s.id,staffId:s.targetStaffId,text:s.text,purpose:s.purpose,expiresAt:s.expiresAt}))}
  }

  view(workspaceId?: string) {
    if (workspaceId) this.workspace(workspaceId)
    return this.present(this.read(),workspaceId)
  }

  /** Only a native teammate actually initialized with its staff identity creates this binding. */
  bindRoomSpeaker(speakerId:string,staffId:string) {
    const db = this.read()
    if (db.roomSpeakers?.[speakerId] || !db.members.some(m=>m.id===staffId)) return
    ;(db.roomSpeakers ??= {})[speakerId] = staffId
    this.save(db)
  }

  roomPortraits(ids:readonly string[]): SpeakerPortraits {
    if (!ids.length) return {}
    const db = this.read()
    const members = new Map(db.members.map(member=>[member.id,member]))
    const portraits: SpeakerPortraits = {}
    for (const id of ids) {
      const staffId = db.roomSpeakers?.[id]
      const member = staffId && members.get(staffId)
      if (member) portraits[id] = memberPortraits(member).portrait
    }
    return portraits
  }

  /** Historical messages carry opaque IDs derived from the originating adapter's verified role identity. */
  speakerPortraits(ids: readonly string[], sources: {conversation:string; kind:string}[]): SpeakerPortraits {
    const observed = new Set(ids.filter(id=>id !== 'owner'))
    const result: SpeakerPortraits = {}
    if (!observed.size) return result
    for (const member of this.read().members) {
      for (const {conversation,kind} of sources) {
        const id = workspaceSpeakerId(conversation,kind,member.id)
        if (observed.has(id)) result[id] = memberPortraits(member).portrait
      }
    }
    return result
  }

  impact(staffId: string, workspaceId?: string) {
    if (workspaceId) this.workspace(workspaceId)
    const db = this.read()
    memberIn(db,staffId,workspaceId)
    return affected(db,staffId,workspaceId)
  }

  apply(workspaceId: string | undefined, body: Body) {
    if (workspaceId) this.workspace(workspaceId)
    const db = this.read()
    const mutation = mutationKey(['v2','staff',workspaceId ?? ''],body)
    const previous = db.receipts[mutation.key]
    if (previous && previous !== mutation.hash) return workspaceError(409,'此请求已用于另一项幕僚操作')
    if (!previous) {
      if (workspaceId && this.archived(workspaceId)) return workspaceError(409,WORKSPACE_ARCHIVED)
      this.change(db,workspaceId,body)
      pruneSuggestions(db)
      db.receipts[mutation.key] = mutation.hash
      this.save(db)
    }
    return this.present(db,workspaceId)
  }

  private change(db: StaffState, workspaceId: string | undefined, body: Body) {
    const action = body.action
    if (action === 'create') {
      const name = field(body.name,'幕僚姓名',80)
      const brief = field(body.brief,'职责',3000)
      const portrait = body.portrait == null ? undefined : selectedPortrait(body.portrait)
      // Only a shape (the liaison's choice for the role): the color is recommended against the roster as usual.
      if (body.portraitShape != null && !isStaffAvatarShape(body.portraitShape)) return workspaceError(400,'请选择素材库中可用于幕僚的头像造型')
      // The liaison's creation (`uniqueName`) is refused when this workspace already has its own member of that name.
      if (body.uniqueName === true && workspaceId && activeMembers(db,workspaceId).some(m => m.homeWorkspaceId === workspaceId && m.name === name)) {
        return workspaceError(409,'本工作区已有专属幕僚「' + name + '」，未重复创建')
      }
      const role = {id:randomUUID(),name,brief}
      const roster = activeMembers(db,workspaceId).map(member => memberPortraits(member).portrait)
      const defaultPortrait = recommendStaffPortrait(role,roster,body.portraitShape ?? undefined)
      db.members.push({...role,portrait,defaultPortrait,homeWorkspaceId:workspaceId,memberships:workspaceId ? [{workspaceId,duty:''}] : []})
      return
    }
    const staff = memberIn(db,body.staffId,action==='join' ? undefined : workspaceId)
    if (action === 'portrait') {
      if (staff.homeWorkspaceId !== workspaceId) return workspaceError(403,'请在这位幕僚的所属范围修改头像')
      if (body.portrait === null) delete staff.portrait
      else staff.portrait = selectedPortrait(body.portrait)
      return
    }
    if (action === 'edit') {
      if (staff.homeWorkspaceId !== workspaceId) return workspaceError(403,'请在这位幕僚的所属范围修改角色')
      staff.name = field(body.name,'幕僚姓名',80)
      staff.brief = field(body.brief,'职责',3000)
      advance(db,staff.id)
      return
    }
    if (action === 'join' || action === 'leave') {
      if (!workspaceId || staff.homeWorkspaceId && staff.homeWorkspaceId !== workspaceId) return workspaceError(403,'只能在允许的工作区设置幕僚')
      const previous = staff.memberships.find(m=>m.workspaceId===workspaceId)
      if (action === 'join') {
        const duty = optional(body.duty,'本区职责',3000) ?? ''
        if (previous) previous.duty = duty
        else staff.memberships.push({workspaceId,duty})
      } else {
        if (staff.homeWorkspaceId) return workspaceError(409,'专属幕僚属于本工作区')
        staff.memberships = staff.memberships.filter(m=>m.workspaceId!==workspaceId)
        invalidateShares(db,s=>affectedShare(s,staff.id,workspaceId))
      }
      advance(db,staff.id,workspaceId)
      return
    }
    if (!workspaceId && staff.homeWorkspaceId && action!=='reset') return workspaceError(403,'请在所属工作区管理专属幕僚的经验')
    if (action === 'reset') {
      const impact = affected(db,staff.id,workspaceId)
      if (body.confirmation !== impact.token) return workspaceError(409,'重置范围已有变化，请重新查看影响后确认')
      db.memories = db.memories.filter(m => m.staffId !== staff.id || !!workspaceId && m.workspaceId !== workspaceId)
      invalidateShares(db,s=>affectedShare(s,staff.id,workspaceId))
      advance(db,staff.id,workspaceId)
      return
    }
    if (action === 'learn') {
      const text = field(body.text,'要记住的经验',3000)
      if (body.proposed !== undefined && typeof body.proposed !== 'boolean') return workspaceError(400,'请选择有效的经验状态')
      const orderId = optional(body.orderId,'来源工单',160)
      if (orderId && !workspaceId) return workspaceError(400,'工单经验需要来源工作区')
      const id = randomUUID()
      if (body.proposed && workspaceId) {
        const context = this.buildContext(db,workspaceId,staff.id)
        if (body.witnessedToken !== undefined && body.witnessedToken !== context.token) return workspaceError(409,'来源已变化，请从当前工单重新提出建议')
        if (context.memories.some(m=>m.shared)) return workspaceError(409,'本轮含跨区共享资料，请在来源区整理需要长期使用的结论')
        const used = new Set(context.memories.map(m=>m.id))
        db.dependencies[id] = db.memories.filter(m=>used.has(m.id)).map(m=>({id:m.id,version:m.version}))
      }
      const at = this.now().toISOString()
      db.memories.push({id,staffId:staff.id,workspaceId,text,status:body.proposed ? 'proposed' : 'active',
        source:body.proposed ? 'suggestion' : 'owner',recordedAt:at,adoptedAt:body.proposed ? undefined : at,version:1,at,orderId})
      if (!body.proposed) advance(db,staff.id,workspaceId)
      return
    }
    if (action === 'revoke') {
      const share = db.shares.find(s=>s.id===body.shareId && s.staffId===staff.id && s.workspaceId===workspaceId)
      if (!share) return workspaceError(404,'此处没有这份共享')
      invalidateShares(db,s=>s.id===share.id)
      return
    }
    const memory = db.memories.find(m=>m.id===body.memoryId && m.staffId===staff.id && m.workspaceId===workspaceId)
    if (!memory) return workspaceError(404,'此处没有这条经验')
    if (action === 'share') {
      if (body.sourceVersion !== memory.version) return workspaceError(409,'来源经验已变化，请重新打开并预览共享内容')
      if (memory.status !== 'active' || !workspaceId) return workspaceError(409,'请从经验已生效的来源工作区共享')
      const targetWorkspaceId = field(body.targetWorkspaceId,'接收工作区',160)
      if (targetWorkspaceId===workspaceId) return workspaceError(400,'请选择另一个工作区')
      this.workspace(targetWorkspaceId)
      if (this.archived(targetWorkspaceId)) return workspaceError(409,WORKSPACE_ARCHIVED)
      const target = memberIn(db,body.targetStaffId ?? staff.id,targetWorkspaceId)
      const text = field(body.text,'共享文字',3000)
      const purpose = optional(body.purpose,'共享用途',500)
      const expires = optional(body.expiresAt,'有效期',40)
      if (expires && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires)<=this.now().getTime())) return workspaceError(400,'请选择将来的有效期')
      db.shares.push({id:randomUUID(),staffId:staff.id,memoryId:memory.id,workspaceId,targetWorkspaceId,targetStaffId:target.id,text,purpose,
        expiresAt:expires ? new Date(expires).toISOString() : undefined})
      advance(db,target.id,targetWorkspaceId)
      return
    }
    switch (action) {
      case 'retire':
        db.memories = db.memories.filter(m=>m.id!==memory.id)
        break
      case 'revise':
        memory.text = field(body.text,'修订后的经验',3000)
        memory.lastUsed = undefined
        memory.version++
        memory.at = this.now().toISOString()
        break
      case 'accept':
        if (memory.status==='active') return
        memory.status = 'active'
        memory.version++
        memory.at = this.now().toISOString()
        memory.adoptedAt = memory.at
        break
      default: return workspaceError(400,'未知的幕僚操作')
    }
    invalidateShares(db,s=>s.memoryId===memory.id)
    advance(db,staff.id,workspaceId)
  }

  private buildContext(db: StaffState,workspaceId: string,staffId: string): StaffContext {
    const staff = memberIn(db,staffId,workspaceId)
    const duty = staff.memberships.find(m=>m.workspaceId===workspaceId)!.duty
    const memories: StaffContext['memories'] = db.memories.filter(m=>m.staffId===staffId && m.status==='active' && (!m.workspaceId || m.workspaceId===workspaceId))
      .map(m=>({id:m.id,text:m.text}))
    const now = this.now().toISOString()
    for (const share of db.shares) {
      if (share.targetStaffId===staffId && share.targetWorkspaceId===workspaceId && isLive(share,now)) {
        memories.push({id:share.id,text:share.text,shared:true,...(share.purpose && {purpose:share.purpose})})
      }
    }
    const brief = {staffId,workspaceId,name:staff.name,brief:staff.brief,duty,memories}
    const token = workspaceFingerprint([brief,db.generations[generationKey(staffId)] ?? 0,db.generations[generationKey(staffId,workspaceId)] ?? 0])
    return {...brief,token}
  }

  context(workspaceId: string,staffId: string) {
    this.workspace(workspaceId)
    return this.buildContext(this.read(),workspaceId,staffId)
  }

  assertCurrent(context: StaffContext) {
    if (this.context(context.workspaceId,context.staffId).token !== context.token) {
      workspaceError(409,'幕僚可见的资料已经变化，请用当前范围重新执行')
    }
  }

  /** This receipt proves which instructions were supplied to the order. */
  markUsed(context: StaffContext,orderId: string) {
    this.workspace(context.workspaceId)
    const db = this.read()
    if (this.buildContext(db,context.workspaceId,context.staffId).token !== context.token) {
      return workspaceError(409,'幕僚可见的资料已经变化，请用当前范围重新执行')
    }
    const ids = new Set(context.memories.map(m=>m.id))
    for (const share of db.shares) if (ids.has(share.id)) ids.add(share.memoryId)
    const prior = db.memories.filter(m=>ids.has(m.id))
    if (!prior.length) return
    for (const m of prior) m.lastUsed = {workspaceId:context.workspaceId,orderId,at:this.now().toISOString()}
    this.save(db)
  }
}
