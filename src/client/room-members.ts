import type { NativeTeamMember } from '../dsh/ports.ts'
import type { TicketThreadView } from './ticket-thread.tsx'
import { staffName, type RosterName } from './staff-names.ts'

export interface RoomParticipant { key: string; staff: string; label: string; detail: string; available: boolean; work?: TicketThreadView }
const executors: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', dsh: 'DSH', remote: '工作电脑' }
export function roomParticipants(native: NativeTeamMember[], work: TicketThreadView[], roster: readonly RosterName[] = []): RoomParticipant[] {
  const names = (id: string) => staffName(id, roster)
  const participants: RoomParticipant[] = native.map(m => ({ key: m.name, staff: m.name, label: names(m.name), detail: m.status === 'running' ? '正在讨论' : '原生讨论成员', available: m.status !== 'failed' && m.status !== 'provisioning' }))
  for (const row of work) {
    const execution = row.executions.at(-1)
    const staff = row.messages.find(m => m.assignment_id === execution?.assignment_id && m.staff_id)?.staff_id
    if (staff && execution) participants.push({ key: `work:${row.ticket_id}`, staff, label: names(staff), detail: `${executors[execution.executor] ?? execution.executor} · ${row.read_only ? '已交回' : '执行者，可追加说明'}`, available: !row.read_only && row.execution_boundary !== 'remote', work: row })
    for (const reviewer of new Set(row.messages.filter(m => m.role === 'verifier' && m.staff_id).map(m => m.staff_id!))) if (!participants.some(p => p.staff === reviewer)) participants.push({ key: `review:${row.ticket_id}:${reviewer}`, staff: reviewer, label: names(reviewer), detail: '独立核验记录', available: false, work: row })
  }
  return participants
}
