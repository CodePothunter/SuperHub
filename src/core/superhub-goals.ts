export const SUPERHUB_GOALS_FILE = 'goals.superhub.json'

export const GOAL_TYPES = ['direction', 'project', 'maintenance'] as const
export const GOAL_STATES = ['draft', 'active', 'paused', 'achieved', 'archived'] as const
export const GOAL_RESULTS = ['none', 'in-progress', 'blocked', 'insufficient', 'met'] as const
export const GOAL_RELATIONS = ['requires', 'contributes', 'related'] as const

export interface GoalCriterion { id: string; text: string; required: boolean }
export interface GoalReference { ticketId: string; evidenceId: string }
export interface GoalFinding {
  criterionId: string
  status: 'met' | 'unmet' | 'uncertain'
  note: string
  evidence: GoalReference[]
}
export interface GoalAssessment {
  at: string
  version: number
  result: typeof GOAL_RESULTS[number]
  note: string
  findings: GoalFinding[]
}
export interface GoalVersion {
  version: number
  at: string
  reason: string
  name: string
  description: string
  type: typeof GOAL_TYPES[number]
  status: typeof GOAL_STATES[number]
  owner: string
  horizon: string
  parent?: string
  relations: { target: string; kind: typeof GOAL_RELATIONS[number] }[]
  criteria: GoalCriterion[]
  assessment?: GoalAssessment
}
export interface SuperhubGoal {
  id: string
  source: { kind: 'owner'; requestId: string } | { kind: 'markdown'; candidateId: string; section: string; text: string }
  versions: GoalVersion[]
}
export interface GoalCandidate { id: string; section: string; text: string; state: 'open' | 'done' }
export const currentGoal = (goal: SuperhubGoal): GoalVersion => goal.versions[goal.versions.length - 1]!
