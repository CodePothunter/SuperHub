import { useCallback, useEffect, useRef, useState } from 'react'
import type { GoalCandidate, GoalReference, GoalVersion, SuperhubGoal } from '../core/superhub-goals.ts'
import type { AcceptanceContract, Report, SuperhubTicket, Verification } from '../core/model.ts'
import type { NativeRooms } from '../dsh/rooms.ts'
import type { IntakeReceipt } from '../dsh/superhub.ts'
import type { SuperhubEvidence, SuperhubInstance, SuperhubMission, SuperhubRole } from '../dsh/superhub-trace.ts'
import type { SaaRecord } from '../dsh/superhub-saa.ts'
import type { WorkspaceTicket } from '../dsh/superhub-workspace.ts'
import type { CommandDecision } from '../dsh/view.ts'
import { api, ApiError } from './api.ts'
import { requestId } from './request-id.ts'

export type { WorkspaceTicket, IntakeReceipt, SuperhubEvidence }
type RoomAction = ReturnType<NativeRooms['ownerActions']>[number]
export interface Scoped { scope: string }
export interface HubOverview extends Scoped {
  asOf: string
  total: number
  nextOffset?: number
  tickets: WorkspaceTicket[]
  decisions: WorkspaceTicket[]
  roomActions: RoomAction[]
  /** 待审批的执行器命令（只给主人本人）。 */
  commands?: CommandDecision[]
  stuck: { id: string; text: string; reason: string; at: string }[]
  roles: (SuperhubRole & { instanceCount: number })[]
}
export interface HubRoleActivity extends Scoped {
  role: Omit<SuperhubRole, 'instances'>
  items: SuperhubInstance[]
  total: number
  asOf: string
  nextCursor?: string
}
export interface GoalSummary {
  id: string; version: number; name: string; owner: string; parent?: string; status: GoalVersion['status']
  type: GoalVersion['type']; relations: GoalVersion['relations']; horizon?: string
}
export interface HubGoals extends Scoped { asOf: string; goals: GoalSummary[]; candidates: GoalCandidate[] }
export interface HubGoal extends Scoped {
  goal: SuperhubGoal
  items: { receiptId: string; itemId: string; title: string; state: string; ticketId?: string; primary?: boolean; disputed?: boolean }[]
  tasks: WorkspaceTicket[]
  knownConditions: number
  requiredConditions: number
  hasNewEvidence?: boolean
  invalidEvidence?: (GoalReference & { reason: string })[]
}
export interface CurrentMission extends SuperhubMission {
  contractHistory: readonly AcceptanceContract[]
  sourceReceiptId?: string
  currentTarget?: { threadId: string; assignmentId: string | null; stage: string; contractVersion?: number; executionBoundary: 'local' | 'remote' }
  verificationDetail?: Verification
  report?: Report
  outputsChanged?: boolean
  ownerAcceptance?: SuperhubTicket['ownerAcceptance']
}
export interface HubReview extends Scoped {
  from: string; to: string; latest?: SaaRecord
  focus: { id: string; name: string; version: number }[]
  attention: WorkspaceTicket[]
  evidence: { ticket: WorkspaceTicket; evidence: SuperhubEvidence[]; coverage?: string; observed: number
    late: { id: string; title: string; ticketId: string; at?: string; observedAt?: string }[] }[]
  blockers: { goalId: string; target: string; name: string; status: string }[]
  roomActions: RoomAction[]
  sampled: number
  candidates: number
}
export interface EvidenceResult extends Scoped { evidence: SuperhubEvidence; content?: string }

export function scopedPath(scope: string, path: string, values: Record<string, string | number | undefined> = {}, pairs: [string, string][] = []) {
  const search = new URLSearchParams([['scope', scope], ...pairs])
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') search.set(key, String(value))
  return `/superhub/${path}?${search}`
}

export async function hubRead<T extends Scoped>(scope: string, path: string): Promise<T> {
  const data = await api<T>(path)
  if (data.scope !== scope) throw new ApiError('响应来自另一个第二大脑，请重新打开', 409)
  return data
}

/** A failed read retains the last successful observation for the same resource. */
export function useHubQuery<T extends Scoped>(scope: string, path: string | undefined, period?: number, active = true) {
  const [snapshot, setSnapshot] = useState<{ scope: string; path: string; data: T; readAt: string }>()
  const [error, setError] = useState<string>()
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    if (!path) return
    const request = ++generation.current
    try {
      const data = await hubRead<T>(scope, path)
      if (generation.current !== request) return
      setSnapshot({ scope, path, data, readAt: new Date().toISOString() })
      setError(undefined)
      return data
    } catch (error) {
      if (generation.current === request) setError((error as Error).message)
    }
  }, [scope, path])
  useEffect(() => {
    if (!active) return
    setError(undefined)
    void refresh()
    const interval = period ? setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, period) : undefined
    return () => { generation.current++; clearInterval(interval) }
  }, [refresh, period, active])
  const current = snapshot?.scope === scope && snapshot.path === path ? snapshot : undefined
  return { data: current?.data, readAt: current?.readAt, error, refresh }
}

export function useHubAction(scope: string) {
  const ref = useRef<{ fingerprint: string; id: string }>(undefined)
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = async <T extends Scoped>(path: string, value: Record<string, unknown>) => {
    if (inFlight.current) return
    const fingerprint = JSON.stringify([scope, path, value])
    if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, id: requestId() }
    inFlight.current = true
    setBusy(true); setError(undefined)
    try {
      const result = await api<T>(`/superhub/${path}`, { ...value, scope, requestId: ref.current.id })
      if (result.scope !== scope) throw new ApiError('回执来自另一个第二大脑，请重新读取', 409)
      ref.current = undefined
      return result
    } catch (error) {
      setError((error as Error).message)
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return { run, busy, error }
}

export const timeLabel = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未登记'
export function localInput(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.valueOf()) ? new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''
}

export { STAGE_LABEL } from './ticket-labels.ts'
export const COVERAGE_LABEL: Record<string, string> = {
  available: '可读取', complete: '完整', full: '完整', partial: '部分可见', collecting: '采集中', unsupported: '宿主未提供', unconfirmed: '尚未证实',
  unavailable: '当前不可用', unreadable: '读取失败', expired: '版本已过期或未保留', forbidden: '无权读取',
  cached: '上次可读快照', redacted: '已脱敏', none: '未采集', 'not-started': '暂无实例',
}
export const CRITERION_LABEL: Record<string, string> = { pass: '通过', fail: '未通过', unverified: '待核实', not_applicable: '不适用', disputed: '有争议' }
