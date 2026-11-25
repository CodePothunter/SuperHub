import type { ExperienceEvidence } from '../core/workspace-experience.ts'
import type { V2CommandRecord } from '../core/workspace-v2.ts'
import { workspaceFingerprint } from './superhub-goals.ts'

const isTest = /^\s*(?:(?:pnpm|npm|yarn|bun|cargo|go)\s+test\b|(?:pnpm\s+exec\s+)?(?:vitest|pytest)\b|node\s+--test\b)/

type CommandResult = { command: string; exitCode: number; outputTail?: string }

export function commandExperienceEvidence(where: {
  workspaceId: string; sessionId: string; orderId?: string; turnId: string; staffId?: string
}, id: string, {command, exitCode, outputTail}: CommandResult): ExperienceEvidence {
  return {
    ...where, id, kind: isTest.test(command) ? 'test' : 'tool',
    quote: `${command.slice(0, 300)}（退出码 ${exitCode}）${outputTail ? '\n' + outputTail.slice(-500) : ''}`.trim(),
  }
}

export function verifyCommandExperience(evidence: ExperienceEvidence, commands: readonly V2CommandRecord[], staffId?: string) {
  const command = commands.find(row => row.id === evidence.id && (row.turnId === evidence.turnId || !evidence.turnId)
    && row.workOrderId === (evidence.orderId ?? null) && row.endedAt && !row.unfinished && !row.unmatched
    && row.memberId === staffId)
  if (!command || typeof command.exitCode !== 'number' || evidence.staffId !== staffId || !evidence.quote
    || !evidence.workspaceId || !evidence.sessionId) return
  const verified = commandExperienceEvidence({
    workspaceId: evidence.workspaceId, sessionId: evidence.sessionId,
    orderId: evidence.orderId, turnId: command.turnId, staffId,
  }, command.id, {...command, exitCode: command.exitCode})
  if (verified.kind !== evidence.kind || verified.quote !== evidence.quote.trim()) return
  return {origin: workspaceFingerprint(['command', evidence.workspaceId, evidence.sessionId, command.turnId, command.id])}
}
