import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Staff } from '../core/model.ts'
import { isStaffMemberExecutor, type StaffContext, type StaffImpact, type StaffMember, type StaffMemory, type StaffShare, type StaffView } from '../core/workspace-staff.ts'
import { EXPERIENCE_EVIDENCE_LIMIT, matchesExperiencePurpose, relevantExperience, type ExperienceDelivery, type ExperienceDeliveryTarget,
  type ExperienceEntry, type ExperienceEvidence, type ExperienceFeedback, type ExperienceMemory, type ExperienceQuery,
  type ExperienceMaintenance, type ExperienceRef, type ExperienceSelection, type ExperienceSupport } from '../core/workspace-experience.ts'
import { defaultStaffPortrait, isSpeakerPortrait, isStaffAvatarShape, recommendStaffPortrait, type SpeakerPortrait, type SpeakerPortraits } from '../core/workspace-avatars.ts'
import { WORKSPACE_ARCHIVED } from '../core/workspace-v2.ts'
import { workspaceSpeakerId } from './workspace-speaker-id.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import { mutationKey } from './workspace-v2-store.ts'

type Body = Record<string, unknown>
type RosterEntry = Pick<Staff, 'id' | 'name' | 'brief' | 'defaultPortrait'>
interface StaffState {
  schema: 1 | 2
  members: StaffMember[]
  native: Record<string, { name: string; brief: string; retired: boolean }>
  dependencies: Record<string, ExperienceRef[]>
  memories: ExperienceMemory[]
  shares: StaffShare[]
  roomSpeakers?: Record<string,string>
  generations: Record<string, number>
  receipts: Record<string, string>
  authority: Record<string, number>
  deliveries: Record<string, ExperienceDelivery>
  feedback: Record<string, ExperienceFeedback & { workspaceId?: string }>
  versions: Record<string, ExperienceVersion[]>
  supersededPremises: Record<string, string>
  pendingPremises: Record<string, string>
}
interface ExperienceVersion { memory: ExperienceMemory; dependencies: ExperienceRef[] }
const empty = (): StaffState => ({schema:2, members:[], native:{}, dependencies:{}, memories:[], shares:[], generations:{},
  receipts:{}, authority:{}, deliveries:{}, feedback:{}, versions:{}, supersededPremises:{},pendingPremises:{}})
const unattendedReviewMs = 90 * 24 * 60 * 60 * 1000
function field(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return workspaceError(400, '请填写有效的' + label)
  return value.trim()
}
function optional(value: unknown, label: string, max: number) {
  return value === undefined || value === '' ? undefined : field(value,label,max)
}
/**
 * The run settings a create or edit carries: `undefined` for a field leaves it, `null` clears it. DSH is the default,
 * so it is stored as no executor. A model is a catalog reference the route has already checked.
 */
function runSettings(body: Body) {
  const given = (key: string) => body[key] !== undefined
  if (given('executor') && body.executor !== null && body.executor !== '' && !isStaffMemberExecutor(body.executor)) {
    return workspaceError(400,'执行器只能是 DSH、Codex 或 Claude Code')
  }
  const text = (key: string, label: string, max: number) => !given(key) ? undefined : body[key] === null || body[key] === '' ? null : field(body[key],label,max)
  const model = text('model','模型',200)
  if (model && !/^[^/\s]+\/\S+$/.test(model)) return workspaceError(400,'模型需要写成“厂商/模型”')
  const effort = text('reasoningEffort','思考深度',80)
  const executor = !given('executor') ? undefined : body.executor === 'dsh' || body.executor === null || body.executor === '' ? null : body.executor as 'codex' | 'claude-code'
  return {executor, model, effort, given: ['executor','model','reasoningEffort'].some(given)}
}
function applyRunSettings(member: StaffMember, settings: ReturnType<typeof runSettings>) {
  if (settings.executor === null) delete member.executor
  else if (settings.executor) member.executor = settings.executor
  if (settings.model === null) { delete member.model; delete member.reasoningEffort }
  else if (settings.model) {
    if (settings.model !== member.model) delete member.reasoningEffort
    member.model = settings.model
  }
  if (settings.effort === null) delete member.reasoningEffort
  else if (settings.effort) member.reasoningEffort = settings.effort
  // A refusal here discards the whole change: `apply` saves only a completed change.
  if (member.reasoningEffort && !member.model) workspaceError(400,'指定思考深度前请先选择模型')
}
function object(value: unknown): Body | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Body : undefined
}
function tags(value: unknown, label: string) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 12) return workspaceError(400, '请选择有效的' + label)
  return [...new Set(value.map(tag => field(tag, label, 80)))]
}
const evidenceKinds = new Set(['owner','group','delivery','artifact','tool','test','model-review','owner-acceptance','order'])
const directKinds = new Set(['artifact','tool','test'])
function experienceEvidence(value: unknown, workspaceId?: string): ExperienceEvidence[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > EXPERIENCE_EVIDENCE_LIMIT) return workspaceError(400, '请选择有效的经验依据')
  return value.map(item => {
    const row = object(item)
    if (!row || typeof row.kind !== 'string' || !evidenceKinds.has(row.kind)) return workspaceError(400, '请选择有效的经验依据')
    if (row.workspaceId !== undefined && row.workspaceId !== workspaceId) return workspaceError(403, '经验依据必须来自所属范围')
    return {kind:row.kind as ExperienceEvidence['kind'], id:field(row.id,'依据编号',240),
      workspaceId: optional(row.workspaceId,'依据工作区',160), sessionId:optional(row.sessionId,'依据会话',240),
      ...(row.traceId !== undefined && {traceId: optional(row.traceId,'依据对话版本',240)}),
      orderId:optional(row.orderId,'依据工单',160), messageId:optional(row.messageId,'依据消息',240),
      turnId:optional(row.turnId,'依据回合',240), fileId:optional(row.fileId,'依据文件',240),
      staffId:optional(row.staffId,'依据所属幕僚',160), resultId:optional(row.resultId,'依据交付',240),
      version:optional(row.version,'依据版本',240), quote:optional(row.quote,'依据原话',3000)}
  })
}
function scopedProof(evidence: ExperienceEvidence, memory: ExperienceMemory) {
  return evidence.workspaceId === memory.workspaceId && (!evidence.staffId || evidence.staffId === memory.staffId)
}
function supportsFor(memory: ExperienceMemory, value: unknown, replace: boolean): ExperienceSupport[] {
  if (!Array.isArray(value) || value.length > EXPERIENCE_EVIDENCE_LIMIT) return workspaceError(400,'请选择有效的工单支持依据')
  const incoming = value.map(item => {
    const record = object(item)
    if (!record || !memory.workspaceId) return workspaceError(400,'归纳经验需要原工作区的工单依据')
    const orderId = field(record.orderId,'依据工单',160)
    const origin = field(record.origin,'原始结果标识',240)
    const evidence = experienceEvidence(record.evidence,memory.workspaceId)
    if (!evidence?.length || !evidence.every(item=>scopedProof(item,memory) && item.orderId === orderId && directKinds.has(item.kind))) {
      return workspaceError(400,'工单支持需要本范围的可核实原件')
    }
    return {orderId,origin,evidence}
  })
  return [...new Map([...(replace ? [] : memory.supports ?? []),...incoming].map(item=>
    [workspaceFingerprint([item.orderId,item.origin]),item])).values()].slice(-EXPERIENCE_EVIDENCE_LIMIT)
}
function independentSupports(supports: readonly ExperienceSupport[] = []) {
  for (const [index,first] of supports.entries()) {
    const other = supports.slice(index + 1).find(second=>first.orderId!==second.orderId && first.origin!==second.origin)
    if (other) return [first,other]
  }
  return supports.slice(0,1)
}
function uniqueEvidence(evidence: ExperienceEvidence[]) {
  const key = (item: ExperienceEvidence) => workspaceFingerprint([item.kind,item.id,item.version,item.quote])
  return [...new Map(evidence.map(item=>[key(item),item])).values()].slice(0,EXPERIENCE_EVIDENCE_LIMIT)
}
function expiresAt(value: unknown, now: string) {
  if (value === null) return undefined
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    return workspaceError(400,'请选择有效的经验期限')
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp <= Date.parse(now)) return workspaceError(400,'请选择将来的经验期限')
  return new Date(timestamp).toISOString()
}
function premiseKey(premise: ExperienceEvidence, staffId?: string) {
  return workspaceFingerprint([premise.workspaceId,staffId,premise.kind,premise.resultId,premise.fileId,premise.id,premise.version])
}
function experienceRefs(value: unknown): ExperienceRef[] {
  if (!Array.isArray(value) || value.length > 20) return workspaceError(400, '请选择有效的经验依赖')
  return value.map(item => {
    const row = object(item)
    if (!row || typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1) {
      return workspaceError(400, '请选择有效的经验版本')
    }
    return {id:field(row.id,'经验编号',240), version:row.version}
  })
}
function sameRef(a: ExperienceRef, b: ExperienceRef) {
  return a.id === b.id && a.version === b.version
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
function advance(db: StaffState, staffId: string | undefined, workspaceId?: string) {
  if (!staffId) return
  const key = generationKey(staffId,workspaceId)
  db.generations[key] = (db.generations[key] ?? 0) + 1
}
function advanceAuthority(db: StaffState, staffId: string, workspaceId?: string) {
  const key = generationKey(staffId,workspaceId)
  db.authority[key] = (db.authority[key] ?? 0) + 1
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
function recordVersion(db: StaffState, memory: ExperienceMemory) {
  const history = db.versions[memory.id] ??= []
  history.push({memory:structuredClone(memory), dependencies:structuredClone(db.dependencies[memory.id] ?? [])})
}
function bump(memory: ExperienceMemory, now: string) {
  memory.version++
  memory.at = now
  delete memory.lastUsed
  delete memory.lastDeliveredAt
}
function retire(db: StaffState, memory: ExperienceMemory, now: string, change: ExperienceMaintenance) {
  if (memory.status === 'retired') return false
  recordVersion(db,memory)
  bump(memory,now)
  memory.status = 'retired'
  memory.reason = change.reason
  memory.maintenance = change
  delete memory.conflict
  advance(db,memory.staffId,memory.workspaceId)
  invalidateShares(db,s=>s.memoryId===memory.id)
  return true
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
  return {memories:memories.filter(m=>m.text).length,shares:shares.length,workspaceIds:[...workspaceIds],token}
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
      if (db.schema !== 1 && db.schema !== 2 || !Array.isArray(db.members) || !Array.isArray(db.memories) || !Array.isArray(db.shares) ||
        !db.generations || !db.receipts) throw new Error()
    } catch { return workspaceError(503,'幕僚资料暂时无法读取') }
    const migrated = db.schema === 1
    if (migrated) {
      db.schema = 2
      db.memories = db.memories.map(memory => ({...memory,audience:'staff'}))
      const versions = new Map(db.memories.map(memory => [memory.id,memory.version]))
      db.shares = db.shares.map(share => ({...share,sourceVersion:versions.get(share.memoryId),targetAudience:'staff'}))
    }
    const roster = this.roster()
    db.native ??= {}
    db.dependencies ??= {}
    db.authority ??= {}
    db.deliveries ??= {}
    db.feedback ??= {}
    db.versions ??= {}
    db.supersededPremises ??= {}
    db.pendingPremises ??= {}
    let retired = false
    for (const member of db.members) {
      const native = db.native['role-' + member.id]
      if (native && !native.retired && !roster.some(row=>row.id===member.id)) {
        native.retired = true
        member.memberships = []
        invalidateShares(db,s=>affectedShare(s,member.id))
        advance(db,member.id)
        advanceAuthority(db,member.id)
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
    const expired = this.expireDue(db)
    const invalidated = this.invalidateDependencies(db)
    if (retired || migrated || expired || invalidated) this.save(db)
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

  /** Resolve exact versions through permission-bearing shares and their source dependencies. */
  private live(db: StaffState, ref: ExperienceRef, visited = new Set<string>(), checkArchive = true): boolean {
    if (visited.has(ref.id)) return false
    const memory = db.memories.find(item=>item.id===ref.id)
    if (memory) {
      if (memory.status!=='active' || memory.version!==ref.version || this.invalidity(db,memory) || this.replacementPending(db,memory) ||
        checkArchive && memory.workspaceId && this.archived(memory.workspaceId)) return false
      const next = new Set(visited).add(ref.id)
      return db.dependencies[memory.id]?.every(item=>this.live(db,item,next,checkArchive)) ?? true
    }
    const share = db.shares.find(item=>item.id===ref.id)
    return !!share && share.sourceVersion===ref.version && isLive(share,this.now().toISOString())
      && !(checkArchive && this.archived(share.targetWorkspaceId))
      && this.live(db,{id:share.memoryId,version:ref.version},new Set(visited).add(ref.id),checkArchive)
  }

  private invalidity(db: StaffState, memory: ExperienceMemory) {
    const replaced = memory.premise && db.supersededPremises[premiseKey(memory.premise,memory.staffId)]
    if (replaced) return {at:replaced,reason:'这条经验的材料版本已被替代'}
    if (memory.expiresAt && Date.parse(memory.expiresAt) <= this.now().getTime()) {
      return {at:memory.expiresAt,reason:'已到这条经验的有效期'}
    }
  }

  private replacementPending(db: StaffState, memory: ExperienceMemory) {
    return !!(memory.premise && db.pendingPremises[premiseKey(memory.premise,memory.staffId)])
  }

  /** Withhold an exact replaced premise immediately, while keeping the current record for reconciliation. */
  holdReplacedExperience(workspaceId: string, staffId: string | undefined, references: readonly ExperienceRef[]) {
    this.workspace(workspaceId)
    if (!references.length || this.archived(workspaceId)) return
    const db = this.read()
    const at = this.now().toISOString()
    let changed = false
    for (const memory of db.memories) {
      if (!memory.premise || memory.status==='retired' || memory.workspaceId!==workspaceId || memory.staffId!==staffId
        || !references.some(ref=>sameRef(ref,memory))) continue
      const key = premiseKey(memory.premise,staffId)
      if (db.pendingPremises[key] || db.supersededPremises[key]) continue
      db.pendingPremises[key] = at
      changed = true
    }
    if (changed) {
      this.invalidateDependencies(db)
      this.save(db)
    }
  }

  private supersedePremise(db: StaffState, premise: ExperienceEvidence, staffId: string | undefined, now: string) {
    const key = premiseKey(premise,staffId)
    db.supersededPremises[key] = db.pendingPremises[key] ?? now
    delete db.pendingPremises[key]
    return db.supersededPremises[key]
  }

  private expireDue(db: StaffState) {
    const now = this.now().toISOString()
    let changed = false
    for (const memory of db.memories) {
      const invalid = memory.status !== 'retired' && this.invalidity(db,memory)
      if (invalid) changed = retire(db,memory,now,{action:'expire',actor:'system',...invalid}) || changed
    }
    return changed
  }

  private invalidateDependencies(db: StaffState) {
    const now = this.now().toISOString()
    let changed = false
    for (const memory of db.memories) {
      if (memory.status!=='retired' && db.dependencies[memory.id]?.some(ref=>!this.live(db,ref,new Set<string>(),false))) {
        changed = retire(db,memory,now,{action:'expire',actor:'system',at:now,reason:'来源经验或共享授权已失效'}) || changed
      }
    }
    return changed
  }

  private projectMemory<T extends ExperienceMemory>(db: StaffState, memory: T, workspaceId?: string, current = true): T {
    const {supports,lastDeliveredAt,...publicMemory} = memory
    const reviewAt = Date.parse(lastDeliveredAt ?? memory.lastUsed?.at ?? memory.at)
    const replacementPending = current && memory.status!=='retired' && this.replacementPending(db,memory)
    const reviewSuggested = current && !replacementPending && memory.status === 'active' && this.now().getTime() - reviewAt >= unattendedReviewMs
    const supporting = memory.status === 'proposed' ? supports?.flatMap(item=>item.evidence) : undefined
    return {...publicMemory, lastUsed: !workspaceId || memory.lastUsed?.workspaceId === workspaceId ? memory.lastUsed : undefined,
      ...(supporting?.length && {evidence:uniqueEvidence([...supporting,...memory.evidence ?? []])}),
      ...(replacementPending && {replacementPending}),
      ...(supports?.length && {supportCount:independentSupports(supports).length}), ...(reviewSuggested && {reviewSuggested})} as T
  }

  private present(db: StaffState, workspaceId?: string, sharedOnly = false): StaffView {
    const active = activeMembers(db)
    const local = active.filter(m => !workspaceId || m.memberships.some(p => p.workspaceId === workspaceId))
    const byMember = (memory: ExperienceMemory) => memory.audience === 'staff' && local.some(s=>s.id===memory.staffId)
    const feedback = Object.values(db.feedback)
    const project = <T extends ExperienceMemory>(m: T): T => {
      const reports = feedback.filter(item=>item.workspaceId===m.workspaceId && item.memory.id===m.id)
        .map(({workspaceId: _workspaceId, ...item})=>item)
      return {...this.projectMemory(db,m,workspaceId),
        ...(reports.length && {feedback:reports}), ...(db.versions[m.id]?.length && {previousVersions:db.versions[m.id]!.map(item=>item.memory.version)})}
    }
    const scoped = db.memories.filter(m=>!workspaceId || m.workspaceId===workspaceId || !m.workspaceId && m.status==='active')
    const shares = db.shares.filter(s=>s.sourceVersion!==undefined && this.live(db,{id:s.id,version:s.sourceVersion},new Set<string>(),false))
    const received = shares.filter(s=>s.targetWorkspaceId===workspaceId)
      .map(s=>({id:s.id,staffId:s.targetStaffId,text:s.text,purpose:s.purpose,expiresAt:s.expiresAt}))
    const sharedExperiences = db.memories.filter(m=>m.audience==='shared' && (m.workspaceId===workspaceId
      || !!workspaceId && !m.workspaceId && m.status==='active')).map(project)
    const sharedReceived = received.filter(s=>s.staffId===undefined).map(({staffId:_staffId,...s})=>s)
    if (sharedOnly) {
      return {scope:this.scope, workspaceId, members:[], available:[], memories:[], received:[],
        shares:shares.filter(s=>s.staffId===undefined && s.workspaceId===workspaceId), sharedExperiences, sharedReceived}
    }
    const retiredMemories = scoped.filter(m=>byMember(m) && m.status==='retired' && m.text).map(project)
    return {scope:this.scope,workspaceId,
      members:local.map(m => ({...m,...memberPortraits(m),
        memberships:m.memberships.filter(p => !workspaceId || p.workspaceId === workspaceId)})),
      available:workspaceId ? active.filter(m => !m.homeWorkspaceId && !local.includes(m)).map(({id,name})=>({id,name})) : [],
      memories:scoped.filter((m): m is ExperienceMemory & StaffMemory => byMember(m) && m.status!=='retired').map(project),
      shares:shares.filter(s=>!workspaceId || s.workspaceId===workspaceId)
        .map(s=>({...s,targetStaffName:active.find(m=>m.id===s.targetStaffId)?.name})),
      received:received.filter((s): s is typeof s & {staffId:string} => s.staffId!==undefined),
      ...(sharedExperiences.length && {sharedExperiences}), ...(retiredMemories.length && {retiredMemories}),
      ...(sharedReceived.length && {sharedReceived})}
  }

  view(workspaceId?: string, sharedOnly = false) {
    if (workspaceId) this.workspace(workspaceId)
    return this.present(this.read(),workspaceId,sharedOnly)
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

  apply(workspaceId: string | undefined, body: Body, sharedOnly = false) {
    if (['actor','supports','supportsComplete','premise','supersedes'].some(key=>body[key]!==undefined)
      || ['expire','pause','support'].includes(String(body.action))) return workspaceError(400,'这里只接受主人操作')
    if (workspaceId) this.workspace(workspaceId)
    const db = this.read()
    const mutation = mutationKey(['v2','staff',workspaceId ?? ''],body)
    const previous = db.receipts[mutation.key]
    if (previous && previous !== mutation.hash) return workspaceError(409,'此请求已用于另一项幕僚操作')
    if (!previous) {
      if (workspaceId && this.archived(workspaceId)) return workspaceError(409,WORKSPACE_ARCHIVED)
      const ownerQuote = body.action==='learn' && experienceEvidence(body.evidence,workspaceId)?.some(item=>item.kind==='owner')
      this.change(db,workspaceId,body,ownerQuote ? 'owner' : 'manual')
      this.invalidateDependencies(db)
      db.receipts[mutation.key] = mutation.hash
      this.save(db)
    }
    return this.present(db,workspaceId,sharedOnly)
  }

  hasExperienceBatch(workspaceId: string | undefined, id: string, changes: Body[]) {
    if (workspaceId) this.workspace(workspaceId)
    const key = 'experience-' + workspaceFingerprint([workspaceId ?? null,id])
    return this.read().receipts[key]===workspaceFingerprint(changes)
  }

  /** The source key and every mutation in a learning change set are committed together. */
  applyExperienceBatch(workspaceId: string | undefined, batch: {
    id: string; changes: Array<Body>; basedOn?: readonly ExperienceRef[]
  }): 'applied' | 'duplicate' {
    if (workspaceId) this.workspace(workspaceId)
    const db = this.read()
    const id = field(batch.id,'整理标识',500)
    const key = 'experience-' + workspaceFingerprint([workspaceId ?? null,id])
    const hash = workspaceFingerprint(batch.changes)
    if (db.receipts[key] === hash) return 'duplicate'
    if (db.receipts[key]) return workspaceError(409,'整理标识已用于另一项经验变更')
    if (workspaceId && this.archived(workspaceId)) return workspaceError(409,WORKSPACE_ARCHIVED)
    if (batch.basedOn) {
      const basis = (refs: readonly ExperienceRef[]) => refs.map(({id,version})=>[id,version] as const)
        .sort(([a],[b])=>a.localeCompare(b))
      const current = db.memories.filter(row=>row.workspaceId===workspaceId)
      if (workspaceFingerprint(basis(current))!==workspaceFingerprint(basis(batch.basedOn))) {
        return workspaceError(409,'整理期间经验已经变化，请重新核对')
      }
    }
    for (const change of batch.changes) {
      if (change.action === 'feedback') this.addFeedback(db,workspaceId,change.feedback)
      else {
        if (!['learn','revise','retire','accept','restore','support','expire','pause'].includes(String(change.action))) return workspaceError(400,'整理只处理经验与反馈')
        if (change.action !== 'learn' && !Number.isSafeInteger(change.version)) return workspaceError(400,'请核对整理所依据的经验版本')
        this.change(db,workspaceId,change,change.actor==='owner' ? 'owner' : 'system')
      }
    }
    this.expireDue(db)
    this.invalidateDependencies(db)
    db.receipts[key] = hash
    this.save(db)
    return 'applied'
  }

  private change(db: StaffState, workspaceId: string | undefined, body: Body, actor: ExperienceMaintenance['actor']) {
    const action = body.action
    if (body.audience === 'shared') {
      if (body.staffId !== undefined) return workspaceError(400,'共同经验属于当前范围')
      return this.changeExperience(db,workspaceId,undefined,body,actor)
    }
    if (body.audience !== undefined && body.audience !== 'staff') return workspaceError(400,'请选择经验受众')
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
      const settings = runSettings(body)
      const role = {id:randomUUID(),name,brief}
      const roster = activeMembers(db,workspaceId).map(member => memberPortraits(member).portrait)
      const defaultPortrait = recommendStaffPortrait(role,roster,body.portraitShape ?? undefined)
      const member: StaffMember = {...role,portrait,defaultPortrait,homeWorkspaceId:workspaceId,memberships:workspaceId ? [{workspaceId,duty:''}] : []}
      applyRunSettings(member,settings)
      db.members.push(member)
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
      const settings = runSettings(body)
      if (settings.given && this.roster().some(row => row.id === staff.id)) {
        return workspaceError(409,'这位幕僚以全局角色卡为准，请在设置的幕僚卡里修改执行器和模型')
      }
      staff.name = body.name === undefined ? staff.name : field(body.name,'幕僚姓名',80)
      staff.brief = body.brief === undefined ? staff.brief : field(body.brief,'职责',3000)
      applyRunSettings(staff,settings)
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
      advanceAuthority(db,staff.id,workspaceId)
      return
    }
    if (!workspaceId && staff.homeWorkspaceId && action!=='reset') return workspaceError(403,'请在所属工作区管理专属幕僚的经验')
    if (action === 'reset') {
      const impact = affected(db,staff.id,workspaceId)
      if (body.confirmation !== impact.token) return workspaceError(409,'重置范围已有变化，请重新查看影响后确认')
      for (const [index,memory] of db.memories.entries()) {
        if (memory.staffId!==staff.id || workspaceId && memory.workspaceId!==workspaceId || !memory.text) continue
        db.memories[index] = {id:memory.id,version:memory.version+1,audience:'staff',staffId:staff.id,
          workspaceId:memory.workspaceId,text:'',status:'retired',at:this.now().toISOString(),reason:'已重置'}
        delete db.versions[memory.id]
        delete db.dependencies[memory.id]
        for (const [key,feedback] of Object.entries(db.feedback)) if (feedback.memory.id===memory.id) delete db.feedback[key]
      }
      invalidateShares(db,s=>affectedShare(s,staff.id,workspaceId))
      advance(db,staff.id,workspaceId)
      advanceAuthority(db,staff.id,workspaceId)
      return
    }
    return this.changeExperience(db,workspaceId,staff.id,body,actor)
  }

  private sameScopeDependencies(db: StaffState, memory: Pick<ExperienceMemory,'workspaceId' | 'staffId'>, refs: ExperienceRef[]) {
    for (const ref of refs) {
      if (!this.live(db,ref)) return workspaceError(409,'经验依据已变化，请重新核对')
      const source = db.memories.find(row=>row.id===ref.id)
      const share = db.shares.find(row=>row.id===ref.id)
      const workspaceId = share?.targetWorkspaceId ?? source?.workspaceId
      const staffId = share?.targetStaffId ?? source?.staffId
      if (workspaceId && workspaceId!==memory.workspaceId || staffId && staffId!==memory.staffId) {
        return workspaceError(403,'来源授权未覆盖这条经验的范围')
      }
    }
    return refs
  }

  private updateContent(memory: ExperienceMemory, body: Body) {
    if (body.text !== undefined) memory.text = field(body.text,'要记住的经验',3000)
    if (body.situation !== undefined) memory.situation = optional(body.situation,'经验适用情境',500)
    if (body.boundary !== undefined) memory.boundary = optional(body.boundary,'经验适用边界',500)
    if (body.domains !== undefined) memory.domains = tags(body.domains,'适用领域')
    if (body.taskTypes !== undefined) memory.taskTypes = tags(body.taskTypes,'适用任务')
    if (body.evidence !== undefined) memory.evidence = experienceEvidence(body.evidence,memory.workspaceId)
  }

  private updateSource(memory: ExperienceMemory, body: Body) {
    const source = body.source
    if (source !== undefined) {
      if (source !== 'owner' && source !== 'suggestion' && source !== 'observation') return workspaceError(400,'请选择有效的经验来源')
      memory.source = source
    }
    if (memory.source === 'observation' && memory.status === 'active' && (!memory.situation
      || !memory.evidence?.some(item => directKinds.has(item.kind)))) {
      return workspaceError(400,'观察生效前需要已验证的原始结果和适用情境')
    }
  }

  private updatePremise(memory: ExperienceMemory, value: unknown) {
    if (value === null) { delete memory.premise; return }
    const premise = experienceEvidence([value],memory.workspaceId)?.[0]
    if (!premise || premise.kind!=='artifact' || !premise.version || !premise.fileId || !premise.resultId || !scopedProof(premise,memory)) {
      return workspaceError(400,'请选择已验证的本范围材料版本')
    }
    memory.premise = premise
  }

  private adoptSupported(memory: ExperienceMemory, now: string) {
    const independent = independentSupports(memory.supports)
    if (independent.length < 2) return false
    memory.status = 'active'
    memory.adoptedAt = now
    memory.evidence = uniqueEvidence([...independent.flatMap(item=>item.evidence.slice(0,1)),
      ...(memory.evidence ?? []),...independent.flatMap(item=>item.evidence.slice(1))])
    memory.maintenance = {action:'accept',actor:'system',at:now,reason:'两个独立工单的原始结果支持这条做法'}
    return true
  }

  private changeExperience(db: StaffState, workspaceId: string | undefined, staffId: string | undefined, body: Body,
    actor: ExperienceMaintenance['actor']) {
    const action = body.action
    const now = this.now().toISOString()
    if (action === 'learn') {
      const text = field(body.text,'要记住的经验',3000)
      if (body.proposed !== undefined && typeof body.proposed !== 'boolean') return workspaceError(400,'请选择有效的经验状态')
      const orderId = optional(body.orderId,'来源工单',160)
      if (orderId && !workspaceId) return workspaceError(400,'工单经验需要来源工作区')
      const id = randomUUID()
      const audience = staffId ? 'staff' : 'shared'
      const memory: ExperienceMemory = {id,audience,staffId,workspaceId,text,status:body.proposed ? 'proposed' : 'active',
        source:body.proposed ? 'suggestion' : 'owner',recordedAt:now,adoptedAt:body.proposed ? undefined : now,version:1,at:now,orderId,
        discoveredBy:optional(body.discoveredBy,'经验发现者',160)}
      this.updateContent(memory,body)
      if (body.experienceExpiresAt !== undefined) memory.expiresAt = expiresAt(body.experienceExpiresAt,now)
      if (body.premise !== undefined) this.updatePremise(memory,body.premise)
      this.updateSource(memory,body)
      if (actor !== 'manual' || !body.proposed) {
        memory.maintenance = {action:actor === 'system' && !body.proposed ? 'accept' : 'learn',actor,at:now,
          reason:optional(body.reason,'操作原因',500) ?? (actor === 'system' && !body.proposed ? '原始结果支持适用情境内的观察' : undefined)}
      }
      if (body.supports !== undefined) {
        memory.supports = supportsFor(memory,body.supports,true)
        if (memory.status==='proposed') this.adoptSupported(memory,now)
      }
      if (body.dependencies !== undefined) {
        db.dependencies[id] = this.sameScopeDependencies(db,memory,experienceRefs(body.dependencies))
      } else if (body.proposed && workspaceId && staffId) {
        const context = this.buildContext(db,workspaceId,staffId)
        if (body.witnessedToken !== undefined && body.witnessedToken !== context.token) return workspaceError(409,'来源已变化，请从当前工单重新提出建议')
        if (context.memories.some(m=>m.shared)) return workspaceError(409,'本轮含跨区共享资料，请在来源区整理需要长期使用的结论')
        const used = new Set(context.memories.map(m=>m.id))
        db.dependencies[id] = db.memories.filter(m=>used.has(m.id)).map(m=>({id:m.id,version:m.version}))
      }
      db.memories.push(memory)
      if (memory.status==='active') advance(db,staffId,workspaceId)
      return
    }
    if (action === 'revoke') {
      const share = db.shares.find(s=>s.id===body.shareId && s.staffId===staffId && s.workspaceId===workspaceId)
      if (!share) return workspaceError(404,'此处没有这份共享')
      invalidateShares(db,s=>s.id===share.id)
      return
    }
    const memory = db.memories.find(m=>m.id===body.memoryId && m.staffId===staffId && m.workspaceId===workspaceId && m.text)
    if (!memory) return workspaceError(404,'此处没有这条经验')
    if (body.version !== undefined && body.version !== memory.version) return workspaceError(409,'经验已变化，请重新核对')
    if (action === 'share') {
      if (body.sourceVersion !== memory.version) return workspaceError(409,'来源经验已变化，请重新打开并预览共享内容')
      if (!workspaceId || !this.live(db,memory)) return workspaceError(409,'请从经验已生效的来源工作区共享')
      const targetWorkspaceId = field(body.targetWorkspaceId,'接收工作区',160)
      if (targetWorkspaceId===workspaceId) return workspaceError(400,'请选择另一个工作区')
      this.workspace(targetWorkspaceId)
      if (this.archived(targetWorkspaceId)) return workspaceError(409,WORKSPACE_ARCHIVED)
      if (body.targetAudience !== undefined && body.targetAudience !== 'shared' && body.targetAudience !== 'staff') {
        return workspaceError(400,'请选择有效的接收范围')
      }
      const targetAudience = body.targetAudience==='shared' ? 'shared' : 'staff'
      if (targetAudience==='shared' && body.targetStaffId!==undefined) return workspaceError(400,'共享给工作区时请选择整个工作区')
      const targetStaffId = targetAudience==='staff' ? memberIn(db,body.targetStaffId ?? staffId,targetWorkspaceId).id : undefined
      const text = field(body.text,'共享文字',3000)
      const purpose = optional(body.purpose,'共享用途',500)
      if (!this.permitsDependencyUse(db,memory,{workspaceId:targetWorkspaceId,staffId:targetStaffId,task:purpose ?? text})) {
        return workspaceError(403,'原有共享未覆盖这次接收范围，请从经验来源工作区另行授权')
      }
      const expires = optional(body.expiresAt,'有效期',40)
      if (expires && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires)<=this.now().getTime())) return workspaceError(400,'请选择将来的有效期')
      db.shares.push({id:randomUUID(),staffId,memoryId:memory.id,sourceVersion:memory.version,workspaceId,targetWorkspaceId,targetStaffId,targetAudience,text,purpose,
        expiresAt:expires ? new Date(expires).toISOString() : undefined})
      advance(db,targetStaffId,targetWorkspaceId)
      return
    }
    switch (action) {
      case 'support': {
        if (memory.status !== 'proposed' || memory.conflict || this.replacementPending(db,memory)) {
          return workspaceError(409,'请先核对待采纳经验的状态')
        }
        const supports = supportsFor(memory,body.supports,body.supportsComplete===true)
        if (independentSupports(supports).length < 2) {
          memory.supports = supports
          return
        }
        recordVersion(db,memory)
        memory.supports = supports
        this.adoptSupported(memory,now)
        bump(memory,now)
        break
      }
      case 'expire': {
        const reason = optional(body.reason,'过期原因',500) ?? '适用的材料版本已被明确替代'
        const evidence = experienceEvidence(body.evidence,workspaceId)
        if (!memory.premise || !evidence?.length || !evidence.every(item=>scopedProof(item,memory) && item.kind==='artifact')) {
          return workspaceError(400,'过期需要本范围内的替代材料')
        }
        const at = this.supersedePremise(db,memory.premise,memory.staffId,now)
        if (retire(db,memory,now,{action:'expire',actor,at,reason})) memory.evidence = evidence
        return
      }
      case 'pause': {
        const evidence = uniqueEvidence(experienceEvidence(body.evidence,workspaceId) ?? [])
        if (memory.status==='retired' || memory.conflict || evidence.length < 2 || evidence.some(item=>!scopedProof(item,memory))) {
          return workspaceError(400,'暂停使用需要同范围的两份冲突依据')
        }
        const reason = optional(body.reason,'暂停原因',500) ?? '相同适用条件下的依据互相冲突，需要裁决'
        const maintenance = {action:'pause',actor,at:now,reason} as const
        if (!retire(db,memory,now,maintenance)) return
        // A candidate remains available for review without becoming selectable.
        if (db.versions[memory.id]?.at(-1)?.memory.status==='proposed') memory.status = 'proposed'
        memory.conflict = evidence
        return
      }
      case 'retire': {
        const evidence = experienceEvidence(body.evidence,workspaceId)
        const reason = optional(body.reason,'停用原因',500) ?? '已停用'
        const maintenance = {action:'retire',actor,at:now,reason} as const
        if (memory.status==='retired' && memory.conflict && actor!=='system') {
          recordVersion(db,memory)
          bump(memory,now)
          memory.maintenance = maintenance
          memory.reason = reason
          delete memory.conflict
        } else if (retire(db,memory,now,maintenance) && evidence) memory.evidence = evidence
        return
      }
      case 'revise': {
        const previous = db.versions[memory.id]?.at(-1)?.memory
        const changingElapsedDate = body.experienceExpiresAt !== undefined && memory.maintenance?.action==='expire'
          && memory.expiresAt === memory.maintenance.at
        const resume = actor!=='system' && (memory.conflict || changingElapsedDate) && previous?.status
        if (memory.status==='retired' && (!resume || resume==='retired')) return workspaceError(409,'已停用的经验需要从历史版本恢复')
        recordVersion(db,memory)
        const originalPremise = memory.premise
        const originalMeaning = workspaceFingerprint([memory.text,memory.situation,memory.boundary,memory.domains,memory.taskTypes])
        this.updateContent(memory,body)
        if (body.experienceExpiresAt !== undefined) memory.expiresAt = expiresAt(body.experienceExpiresAt,now)
        const changedMeaning = originalMeaning!==workspaceFingerprint([memory.text,memory.situation,memory.boundary,memory.domains,memory.taskTypes])
        if (changedMeaning) {
          delete memory.supports
          if (actor!=='system') {
            memory.source = 'owner'
            if (body.evidence === undefined) delete memory.evidence
          }
        }
        if (body.premise !== undefined) this.updatePremise(memory,body.premise)
        else if (changedMeaning && actor!=='system') delete memory.premise
        if (body.supersedes===true && originalPremise && memory.premise
          && premiseKey(originalPremise,staffId)!==premiseKey(memory.premise,staffId)) {
          this.supersedePremise(db,originalPremise,staffId,now)
        }
        if (memory.status==='retired' && resume) memory.status = resume
        this.updateSource(memory,body)
        memory.reason = optional(body.reason,'修订原因',500)
        memory.maintenance = {action:'revise',actor,at:now,reason:memory.reason}
        delete memory.conflict
        if (body.dependencies !== undefined) {
          const refs = experienceRefs(body.dependencies)
          if (refs.some(ref=>ref.id===memory.id)) return workspaceError(400,'经验不能依赖自身')
          db.dependencies[memory.id] = this.sameScopeDependencies(db,memory,refs)
        }
        if (this.invalidity(db,memory) || this.replacementPending(db,memory)
          || memory.status==='active' && db.dependencies[memory.id]?.some(ref=>!this.live(db,ref))) {
          return workspaceError(409,'经验依据或有效期已变化，请使用当前材料')
        }
        bump(memory,now)
        break
      }
      case 'accept':
        if (memory.status==='active') return
        if (memory.status==='retired') return workspaceError(409,'已停用的经验需要从历史版本恢复')
        if (this.invalidity(db,memory) || this.replacementPending(db,memory)
          || db.dependencies[memory.id]?.some(ref=>!this.live(db,ref))) return workspaceError(409,'经验依据已变化，请重新核对')
        recordVersion(db,memory)
        if (body.evidence !== undefined) memory.evidence = experienceEvidence(body.evidence,workspaceId)
        if (body.premise !== undefined) {
          this.updatePremise(memory,body.premise)
          if (this.invalidity(db,memory) || this.replacementPending(db,memory)) return workspaceError(409,'经验依据已变化，请重新核对')
        }
        memory.status = 'active'
        this.updateSource(memory,body)
        bump(memory,now)
        memory.adoptedAt = now
        memory.maintenance = {action:'accept',actor,at:now,reason:optional(body.reason,'采纳原因',500)}
        delete memory.conflict
        break
      case 'restore': {
        if (body.version===undefined) return workspaceError(400,'请从当前版本恢复')
        const prior = db.versions[memory.id]?.find(row=>row.memory.version===body.restoreVersion)
        if (!prior || prior.memory.status==='retired') return workspaceError(409,'这个历史版本无法恢复')
        if (this.invalidity(db,prior.memory) || this.replacementPending(db,prior.memory)) {
          return workspaceError(409,'历史版本的有效期或材料已失效，请用当前资料更正')
        }
        const refs = this.sameScopeDependencies(db,prior.memory,prior.dependencies)
        recordVersion(db,memory)
        const restored = {...prior.memory,version:memory.version}
        restored.maintenance = {action:'restore',actor,at:now,reason:'恢复版本 ' + prior.memory.version}
        restored.reason = restored.maintenance.reason
        delete restored.conflict
        bump(restored,now)
        db.memories[db.memories.indexOf(memory)] = restored
        db.dependencies[memory.id] = refs
        break
      }
      default: return workspaceError(400,'未知的幕僚操作')
    }
    invalidateShares(db,s=>s.memoryId===memory.id)
    advance(db,staffId,workspaceId)
  }

  private buildContext(db: StaffState,workspaceId: string,staffId: string): StaffContext {
    const staff = memberIn(db,staffId,workspaceId)
    const duty = staff.memberships.find(m=>m.workspaceId===workspaceId)!.duty
    const memories: StaffContext['memories'] = db.memories.filter(m=>m.staffId===staffId && (!m.workspaceId || m.workspaceId===workspaceId)
      && this.live(db,m,new Set<string>(),false))
      .map(m=>({id:m.id,text:m.text}))
    for (const share of db.shares) {
      if (share.targetStaffId===staffId && share.targetWorkspaceId===workspaceId && share.sourceVersion!==undefined
        && this.live(db,{id:share.id,version:share.sourceVersion},new Set<string>(),false)) {
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
    const at = this.now().toISOString()
    for (const m of prior) {
      m.lastUsed = {workspaceId:context.workspaceId,orderId,at}
      m.lastDeliveredAt = at
    }
    this.save(db)
  }

  private authorityFor(db:StaffState, workspaceId: string | undefined, staffId: string | undefined) {
    if (!staffId) return 'shared'
    const member = memberIn(db,staffId,workspaceId)
    if (!workspaceId && member.homeWorkspaceId) return workspaceError(403,'专属幕僚需要已确认的工作区')
    return workspaceFingerprint([db.authority[generationKey(staffId)] ?? 0, db.authority[generationKey(staffId,workspaceId)] ?? 0])
  }

  private authorizedExperience(db: StaffState, query: ExperienceQuery): ExperienceEntry[] {
    const now = this.now().getTime()
    const entries: ExperienceEntry[] = []
    for (const memory of db.memories) {
      if (memory.workspaceId !== undefined && memory.workspaceId!==query.workspaceId || !this.live(db,memory)) continue
      let purpose: string | undefined
      if (memory.audience === 'staff') {
        if (!memory.staffId || !activeMembers(db,memory.workspaceId).some(member=>member.id===memory.staffId)) continue
        if (memory.staffId !== query.staffId) {
          const grant = query.workspaceId && query.delegated?.find(ref=>sameRef(ref,memory)
            && (!ref.expiresAt || Date.parse(ref.expiresAt)>now) && matchesExperiencePurpose(ref.purpose,query))
          if (!grant) continue
          purpose = grant.purpose
        }
      } else if (memory.audience !== 'shared' || memory.staffId!==undefined) {
        continue
      }
      // A derived entry keeps the audience and purpose restrictions of its entire share dependency chain.
      if (!this.permitsDependencyUse(db,memory,query)) continue
      const {id,version,text,workspaceId,staffId,situation,boundary,evidence,domains,taskTypes} = memory
      entries.push({id,version,text,workspaceId,staffId,situation,boundary,evidence,domains,taskTypes,purpose})
    }
    for (const share of db.shares) {
      const version = share.sourceVersion
      if (share.targetWorkspaceId!==query.workspaceId || !version || !this.live(db,{id:share.id,version})) continue
      if (share.targetAudience === 'shared' ? share.targetStaffId!==undefined : !query.staffId || share.targetStaffId!==query.staffId) continue
      if (!matchesExperiencePurpose(share.purpose,query) || !this.permitsDependencyUse(db,{id:share.memoryId,version},query)) continue
      entries.push({id:share.id,version,shareId:share.id,text:share.text,workspaceId:share.targetWorkspaceId,
        staffId:share.targetStaffId,purpose:share.purpose})
    }
    return entries
  }

  private permitsDependencyUse(db: StaffState, source: ExperienceRef, query: ExperienceQuery): boolean {
    return db.dependencies[source.id]?.every(ref => {
      const grant = db.shares.find(share=>share.id===ref.id)
      if (!grant) return this.permitsDependencyUse(db,ref,query)
      if (grant.targetWorkspaceId !== query.workspaceId || (grant.targetStaffId && grant.targetStaffId !== query.staffId)) return false
      return matchesExperiencePurpose(grant.purpose,query) && this.permitsDependencyUse(db,{id:grant.memoryId,version:ref.version},query)
    }) ?? true
  }

  selectExperience(query: ExperienceQuery): ExperienceSelection {
    if (query.workspaceId) {
      this.workspace(query.workspaceId)
      if (this.archived(query.workspaceId)) return workspaceError(409,WORKSPACE_ARCHIVED)
    }
    const db = this.read()
    const authority = this.authorityFor(db,query.workspaceId,query.staffId)
    const entries = this.authorizedExperience(db,query)
    return {query:structuredClone(query),entries:relevantExperience(entries,query),
      authorized:entries.map(({id,version})=>({id,version})),scope:this.scope,authority}
  }

  staffOwnExperience(workspaceId: string, staffId: string): ExperienceRef[] {
    const db = this.read()
    if (!activeMembers(db,workspaceId).some(member=>member.id===staffId)) return []
    // A version derived from a share the liaison could not use itself (e.g. one granted to this member alone) is not the member's own.
    return this.authorizedExperience(db,{workspaceId,staffId,task:''})
      .filter(entry=>entry.staffId===staffId && !entry.shareId && entry.purpose===undefined
        && this.permitsDependencyUse(db,entry,{workspaceId,task:''})).map(({id,version})=>({id,version}))
  }

  assertExperienceCurrent(selection: ExperienceSelection) {
    if (selection.scope!==this.scope) return workspaceError(409,'经验归属已经变化')
    const current = this.selectExperience(selection.query)
    if (current.authority!==selection.authority || selection.entries.some(entry=>!current.authorized.some(ref=>sameRef(ref,entry)))) {
      return workspaceError(409,'相关经验或使用授权已经变化，请用当前范围重新执行')
    }
  }

  /** Called only after the adapter can prove that the executor received these entries. */
  recordExperienceDelivery(selection: ExperienceSelection, target: ExperienceDeliveryTarget, entries: readonly ExperienceEntry[] = selection.entries) {
    if (selection.scope!==this.scope) return workspaceError(409,'经验归属已经变化')
    if (!entries.length) return
    const {workspaceId} = selection.query
    const key = workspaceFingerprint([workspaceId ?? null,target.sessionId,target.nativeSessionId ?? null,target.executorId,target.turnId])
    const db = this.read()
    const previous = db.deliveries[key]
    const delivered = entries.map(entry=>{
      const original = selection.entries.find(ref=>sameRef(ref,entry))
      if (!original) return workspaceError(409,'送达内容超出本轮选择')
      const {id,version,shareId} = original
      return {id,version,...(shareId && {shareId})}
    })
    const additional = delivered.filter((entry,index)=>!previous?.entries.some(ref=>sameRef(ref,entry))
      && delivered.findIndex(ref=>sameRef(ref,entry))===index)
    if (!additional.length) return
    const at = this.now().toISOString()
    db.deliveries[key] = {...target,workspaceId,entries:[...previous?.entries ?? [],...additional],at:previous?.at ?? at}
    const used = new Map(additional.filter(ref=>this.live(db,ref)).map(ref=>[
      db.shares.find(share=>share.id===ref.shareId)?.memoryId ?? ref.id,ref.version]))
    for (const memory of db.memories) {
      if (used.get(memory.id)!==memory.version) continue
      memory.lastDeliveredAt = at
      if (workspaceId && target.orderId) memory.lastUsed = {workspaceId,orderId:target.orderId,at}
    }
    this.save(db)
  }

  experienceDeliveries(filter: { workspaceId?: string; sessionId?: string; turnId?: string }) {
    if (filter.workspaceId) this.workspace(filter.workspaceId)
    return Object.values(this.read().deliveries).filter(row=>row.workspaceId===filter.workspaceId
      && (!filter.sessionId || row.sessionId===filter.sessionId) && (!filter.turnId || row.turnId===filter.turnId))
  }

  experienceMemories(workspaceId?: string) {
    if (workspaceId) this.workspace(workspaceId)
    const db = this.read()
    const feedback = Object.values(db.feedback)
    return db.memories.filter(row=>row.workspaceId===workspaceId).map(memory=>{
      const reports = feedback.filter(item=>item.workspaceId===workspaceId && item.memory.id===memory.id)
        .map(({workspaceId:_workspaceId,...item})=>item)
      return {...memory,...(this.replacementPending(db,memory) && {replacementPending:true}),...(reports.length && {feedback:reports})}
    })
  }

  experienceVersion(workspaceId: string | undefined, memoryId: string, version: number, sharedOnly = false) {
    if (workspaceId) this.workspace(workspaceId)
    const db = this.read()
    const current = db.memories.find(row=>row.id===memoryId && row.workspaceId===workspaceId && row.text
      && (!sharedOnly || row.audience==='shared'))
    const record = current?.version===version ? current : db.versions[memoryId]?.find(row=>row.memory.version===version)?.memory
    if (!current || !record || record.workspaceId!==workspaceId) return workspaceError(404,'此处没有这条经验的对应版本')
    return this.projectMemory(db,record,workspaceId,current===record)
  }

  private addFeedback(db:StaffState, workspaceId:string|undefined, input:unknown) {
    const value = object(input)
    if (!value) return workspaceError(400,'请选择有效的经验反馈')
    const id = field(value.id,'经验反馈编号',240)
    const memory = experienceRefs([value.memory])[0]!
    const kind = value.kind
    if (kind!=='owner-correction' && kind!=='supported' && kind!=='not-applicable' && kind!=='contradicted'
      && kind!=='owner-acceptance' && kind!=='model-review') return workspaceError(400,'请选择有效的经验反馈类型')
    const evidence = experienceEvidence([value.evidence],workspaceId)![0]!
    const sessionId = optional(value.sessionId,'送达会话',240)
    const turnId = optional(value.turnId,'送达回合',240)
    const key = workspaceFingerprint([workspaceId ?? null,id])
    const feedback: ExperienceFeedback & { workspaceId?: string } = {id,memory,kind,evidence,workspaceId,sessionId,turnId}
    const previous = db.feedback[key]
    if (previous) {
      if (workspaceFingerprint(previous)!==workspaceFingerprint(feedback)) return workspaceError(409,'经验反馈编号已用于其他反馈')
      return false
    }
    const delivery = Object.values(db.deliveries).some(row=>row.workspaceId===workspaceId
      && (!sessionId || row.sessionId===sessionId) && (!turnId || row.turnId===turnId) && row.entries.some(ref=>sameRef(ref,memory)))
    if (!delivery) return workspaceError(409,'找不到该版本的实际送达记录')
    db.feedback[key] = feedback
    return true
  }

  recordExperienceFeedback(workspaceId: string | undefined, feedback: ExperienceFeedback) {
    if (workspaceId) {
      this.workspace(workspaceId)
      if (this.archived(workspaceId)) return workspaceError(409,WORKSPACE_ARCHIVED)
    }
    const db = this.read()
    if (this.addFeedback(db,workspaceId,feedback)) this.save(db)
  }
}
