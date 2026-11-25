import { isSpeakerPortrait } from '../core/workspace-avatars.ts'
import type { StaffImpact, StaffView } from '../core/workspace-staff.ts'
import type { ExperienceMemory } from '../core/workspace-experience.ts'
import type { Scoped } from './superhub-api.ts'

const row = (v:unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v:unknown,...keys:string[]) => row(v) && keys.every(key=>typeof v[key] === 'string')
const optional = (v:unknown) => v === undefined || typeof v === 'string'
const items = (v:unknown,valid:(item:unknown)=>boolean) => Array.isArray(v) && v.every(valid)
const optionalItems = (v:unknown,valid:(item:unknown)=>boolean) => v === undefined || items(v,valid)
const empty = (v:unknown) => Array.isArray(v) && v.length === 0
const timestamp = (v:unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
function optionalTimeZone(v:unknown) {
  if (v === undefined) return true
  if (typeof v !== 'string') return false
  try { return !!new Intl.DateTimeFormat('en',{timeZone:v}).resolvedOptions().timeZone }
  catch { return false }
}
const evidence = (v:unknown) => row(v) && fields(v,'id','kind')
  && ['owner','group','delivery','tool','test','model-review','owner-acceptance','order','artifact'].includes(String(v.kind))
  && [v.workspaceId,v.sessionId,v.orderId,v.messageId,v.version,v.quote,v.fileId,v.resultId,v.turnId,v.staffId].every(optional)
const maintenance = (v:unknown) => row(v) && timestamp(v.at) && optional(v.reason)
  && ['learn','accept','revise','retire','expire','pause','restore'].includes(String(v.action))
  && ['manual','owner','system'].includes(String(v.actor))
const experienceFields = (v:Record<string,unknown>) => fields(v,'id','text','at')
  && [v.staffId,v.workspaceId,v.orderId,v.situation,v.boundary,v.reason,v.adoptedAt,v.recordedAt].every(optional)
  && (v.source === undefined || ['owner','suggestion','observation'].includes(String(v.source)))
  && Number.isSafeInteger(v.version) && Number(v.version) > 0
  && (v.lastUsed === undefined || fields(v.lastUsed,'workspaceId','orderId','at'))
  && (v.expiresAt === undefined || timestamp(v.expiresAt))
  && (v.maintenance === undefined || maintenance(v.maintenance))
  && (v.supportCount === undefined || Number.isSafeInteger(v.supportCount) && Number(v.supportCount) >= 0)
  && (v.reviewSuggested === undefined || typeof v.reviewSuggested === 'boolean')
  && (v.replacementPending === undefined || v.replacementPending === true)
  && (v.conflict === undefined || Array.isArray(v.conflict) && v.conflict.length > 0 && v.conflict.every(evidence))
  && optionalItems(v.evidence,evidence) && optionalItems(v.previousVersions,n=>Number.isInteger(n))
  && optionalItems(v.feedback,f=>row(f) && fields(f,'id','kind') && evidence(f.evidence) && row(f.memory) && Number.isInteger(f.memory.version))
  && optionalItems(v.domains,tag=>typeof tag === 'string') && optionalItems(v.taskTypes,tag=>typeof tag === 'string')
const experience = (v:unknown): v is ExperienceMemory => row(v) && experienceFields(v)
  && (v.audience === 'staff' && typeof v.staffId === 'string' || v.audience === 'shared' && v.staffId === undefined)
  && (v.status === 'active' || v.status === 'proposed' || v.status === 'retired')

const sharedExperience = (v:unknown): v is ExperienceMemory => experience(v) && v.audience === 'shared' && v.staffId === undefined

export function staffPath(workspaceId?:string, sharedOnly = false) {
  const path = workspaceId ? '/v2/workspaces/' + encodeURIComponent(workspaceId) + '/staff' : '/v2/staff'
  return sharedOnly ? path + '?experience=shared' : path
}
export function isStaffView(v:unknown,resource:string): v is StaffView {
  if (!row(v) || typeof v.scope !== 'string' || !optional(v.workspaceId) || !optionalTimeZone(v.timeZone)) return false
  const workspaceId = typeof v.workspaceId === 'string' ? v.workspaceId : undefined
  const sharedOnly = resource === staffPath(workspaceId,true)
  return (sharedOnly || resource === staffPath(workspaceId))
    && items(v.members,x=>row(x) && fields(x,'id','name','brief') && optional(x.homeWorkspaceId)
      && (x.portrait === undefined || isSpeakerPortrait(x.portrait)) && (x.defaultPortrait === undefined || isSpeakerPortrait(x.defaultPortrait))
      && items(x.memberships,m=>fields(m,'workspaceId','duty')))
    && items(v.available,x=>fields(x,'id','name'))
    && items(v.memories,x=>row(x) && experienceFields(x) && typeof x.staffId === 'string'
      && (x.audience === undefined || x.audience === 'staff') && (x.status === 'active' || x.status === 'proposed'))
    && items(v.shares,x=>row(x) && fields(x,'id','memoryId','workspaceId','targetWorkspaceId','text')
      && [x.staffId,x.targetStaffId,x.targetStaffName,x.purpose,x.expiresAt].every(optional))
    && items(v.received,x=>row(x) && fields(x,'id','staffId','text') && optional(x.purpose) && optional(x.expiresAt))
    && optionalItems(v.sharedExperiences,x=>sharedExperience(x)
      && (!sharedOnly || x.workspaceId === workspaceId || !x.workspaceId && x.status === 'active'))
    && optionalItems(v.retiredMemories,x=>experience(x) && x.audience === 'staff' && x.status === 'retired')
    && optionalItems(v.sharedReceived,x=>row(x) && fields(x,'id','text') && optional(x.purpose) && optional(x.expiresAt))
    && (!sharedOnly || (empty(v.members) && empty(v.available) && empty(v.memories) && empty(v.received)
      && (v.retiredMemories === undefined || empty(v.retiredMemories)) && items(v.shares,s=>row(s) && s.staffId === undefined)))
}
export function isExperienceVersion(v:unknown): v is Scoped & {memory:ExperienceMemory} {
  return row(v) && typeof v.scope === 'string' && experience(v.memory)
}
export function isSharedExperienceVersion(v:unknown): v is Scoped & {memory:ExperienceMemory} {
  return isExperienceVersion(v) && sharedExperience(v.memory)
}
export function isStaffImpact(v:unknown): v is Scoped & {impact:StaffImpact} {
  return row(v) && typeof v.scope === 'string' && row(v.impact) && typeof v.impact.token === 'string'
    && Number.isInteger(v.impact.memories) && Number.isInteger(v.impact.shares)
    && items(v.impact.workspaceIds,x=>typeof x === 'string')
}

export function isStaffRecipients(v:unknown,resource:string): v is Scoped & {workspaceId:string;members:{id:string;name:string}[]} {
  return row(v) && typeof v.scope === 'string' && typeof v.workspaceId === 'string'
    && resource === staffPath(v.workspaceId) + '?recipients=1' && items(v.members,m=>fields(m,'id','name'))
}
