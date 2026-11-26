export type CommitmentKind = 'mine' | 'theirs' | 'request'
export type DueState = 'unscheduled' | 'upcoming' | 'today' | 'overdue' | 'resolved'

export interface CommitmentSource {
  kind: 'session' | 'liaison'
  sessionId: string
  traceId?: string
  messageId: string
  author: string
  at: string
  /** View only, for an explicitly deleted workspace conversation. */
  sessionDeletedAt?: string
}

export interface OrderCommitment {
  id: string
  kind: CommitmentKind
  quote: string
  person?: string
  dueAt?: string
  resolved: boolean
  dueState: DueState
  source: CommitmentSource
}

export interface WeeklySchedule {
  enabled: boolean
  weekday: number
  time: string
}

export interface WeeklyReport {
  id: string
  /** Local calendar date of the Monday opening this period. */
  week: string
  title: string
  markdown: string
  createdAt: string
  sources: CommitmentSource[]
}

export interface FollowupView {
  scope: string
  workspaceId: string
  orderId: string
  timeZone: string
  currentWeek: string
  sessionDeletedAt?: string
  commitments: OrderCommitment[]
  schedule: WeeklySchedule | null
  reports: WeeklyReport[]
  /** Stable receipt for manual generation, including replay after a week boundary. */
  reportId?: string
}
