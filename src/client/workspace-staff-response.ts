import { isSpeakerPortrait } from '../core/workspace-avatars.ts'
import type { StaffImpact, StaffView } from '../core/workspace-staff.ts'
import type { Scoped } from './superhub-api.ts'

const row = (v:unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fields = (v:unknown,...keys:string[]) => row(v) && keys.every(key=>typeof v[key] === 'string')
const optional = (v:unknown) => v === undefined || typeof v === 'string'
const items = (v:unknown,valid:(item:unknown)=>boolean) => Array.isArray(v) && v.every(valid)

export function staffPath(workspaceId?:string) {
  return workspaceId ? '/v2/workspaces/' + encodeURIComponent(workspaceId) + '/staff' : '/v2/staff'
}
export function isStaffView(v:unknown,resource:string): v is StaffView {
  return row(v) && typeof v.scope === 'string' && optional(v.workspaceId)
    && resource === staffPath(typeof v.workspaceId === 'string' ? v.workspaceId : undefined)
    && items(v.members,x=>row(x) && fields(x,'id','name','brief') && optional(x.homeWorkspaceId)
      && (x.portrait === undefined || isSpeakerPortrait(x.portrait)) && (x.defaultPortrait === undefined || isSpeakerPortrait(x.defaultPortrait))
      && items(x.memberships,m=>fields(m,'workspaceId','duty')))
    && items(v.available,x=>fields(x,'id','name'))
    && items(v.memories,x=>row(x) && fields(x,'id','staffId','text','at') && optional(x.workspaceId) && optional(x.orderId)
      && optional(x.adoptedAt) && optional(x.recordedAt) && (x.source === undefined || x.source === 'owner' || x.source === 'suggestion')
      && Number.isInteger(x.version) && (x.status === 'active' || x.status === 'proposed')
      && (x.lastUsed === undefined || fields(x.lastUsed,'workspaceId','orderId','at')))
    && items(v.shares,x=>row(x) && fields(x,'id','memoryId','staffId','targetStaffId','workspaceId','targetWorkspaceId','text')
      && optional(x.targetStaffName) && optional(x.purpose) && optional(x.expiresAt))
    && items(v.received,x=>row(x) && fields(x,'id','staffId','text') && optional(x.purpose) && optional(x.expiresAt))
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
