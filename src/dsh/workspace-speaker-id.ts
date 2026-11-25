import { createHash } from 'node:crypto'

export const dialogueKey = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
export const groupPrefix = (scope:string) => 'chief-v2-group-' + dialogueKey(scope).slice(0,12) + '-'
export const groupLeadId = (scope:string,workspace:string,session:string) => groupPrefix(scope) + dialogueKey(workspace,session).slice(0,28)

/** Source IDs never leave the adapter and a membership in a different conversation has its own public identity. */
export const workspaceSpeakerId = (conversation: string, kind: string, sourceId: string) =>
  's-' + dialogueKey(conversation,kind,sourceId).slice(0,24)
/** The liaison speaking in one conversation (hand-overs, follow-ups, acceptance verdicts). */
export const liaisonSpeakerId = (lead: string) => workspaceSpeakerId(lead, 'host', 'liaison')
