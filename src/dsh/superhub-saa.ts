import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GoalReference } from '../core/superhub-goals.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'

export interface SaaRecord {
  id: string
  mode?: 'compact'
  from: string
  to: string
  savedAt: string
  goals: { id: string; version: number }[]
  tickets: string[]
  references: GoalReference[]
  alignment: string
  bottleneck: string
  nextFocus: string
  firstStep: string
  coordination: string
  drift: string
  checkpoint: { blockedOn: string; ruledOut: string; resumeAt: string }
}
interface SaaFile { schema: 1; records: SaaRecord[]; requests: Record<string, { hash: string; id: string }> }

export function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${label}需要有效的日期、时间和时区`)
  return new Date(value).toISOString()
}

export function uniqueIds(value: unknown, max: number, check: RegExp, label: string): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(id => typeof id !== 'string' || !check.test(id)) || new Set(value).size !== value.length) throw new Error(`${label}无效（最多 ${max} 个）`)
  return value as string[]
}

function answer(value: unknown, label: string, max: number, required = true): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || required && !value.trim() || value.length > max) throw new Error(`请填写${label}（最多 ${max} 字）`)
  return value.trim()
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const fileName = 'ops/superhub-saa.json'
export class SuperhubSaa {
  private readonly file: string
  constructor(root: string, private readonly committed: (message: string, paths: string[]) => void, private readonly now = () => new Date().toISOString()) {
    this.file = join(root, fileName)
  }
  private load(): SaaFile {
    if (!existsSync(this.file)) return { schema: 1, records: [], requests: {} }
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as SaaFile
    if (data.schema !== 1 || !Array.isArray(data.records) || !data.requests) throw new Error('局势校准记录格式未知')
    return data
  }
  latest(): SaaRecord | undefined { return this.load().records.at(-1) }
  list(): SaaRecord[] { return this.load().records.slice(-40).reverse() }
  get(id: string): SaaRecord | undefined { return this.load().records.find(row => row.id === id) }
  existing(body: Record<string, unknown>): SaaRecord | undefined {
    if (body.mode !== undefined && body.mode !== 'compact') throw new Error('复盘填写方式无效')
    if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(body.requestId)) throw new Error('缺少稳定的请求标识')
    const data = this.load()
    const saved = data.requests[hash(body.requestId)]
    if (!saved) return
    if (saved.hash !== workspaceFingerprint(body) && saved.hash !== hash(JSON.stringify(body))) workspaceError(409, '该请求标识已用于另一份局势校准')
    return data.records.find(row => row.id === saved.id)
  }
  save(body: Record<string, unknown>, context: Pick<SaaRecord, 'goals' | 'tickets' | 'references'>): SaaRecord {
    const replay = this.existing(body)
    if (replay) return replay
    const from = timestamp(body.from, '工作段起点'), to = timestamp(body.to, '工作段终点')
    const savedAt = this.now()
    if (to > savedAt || from >= to) throw new Error('请选择已发生的工作段')
    const compact = body.mode === 'compact'
    const checkpoint = compact && body.checkpoint === undefined ? {} : body.checkpoint
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw new Error('请填写三条复工线索')
    const cp = checkpoint as Record<string, unknown>
    const bottleneck = answer(body.bottleneck, '最重要的卡点', compact ? 600 : 1000)
    const nextFocus = answer(body.nextFocus, '下一段唯一专注事项', 300)
    const firstStep = answer(body.firstStep, '前 15 分钟的第一步', 500)
    if (compact) {
      for (const [key, label, expected] of [['blockedOn', '复工卡点', bottleneck], ['resumeAt', '复工第一步', firstStep]] as const) {
        if (cp[key] !== undefined && answer(cp[key], label, 600) !== expected) throw new Error(`${label}与本次填写的内容不一致，请重新核对`)
      }
    }
    const record: SaaRecord = { id: randomUUID(), ...compact ? { mode: 'compact' as const } : {}, from, to, savedAt, ...context,
      alignment: answer(body.alignment, '本段实际推进与主线的关系', 1000, !compact),
      bottleneck, nextFocus, firstStep,
      coordination: answer(body.coordination, '需要交付给谁（没有可填“无”）', 1000, !compact),
      drift: answer(body.drift, '是否偏离主线', 1000, !compact),
      checkpoint: { blockedOn: compact ? bottleneck : answer(cp.blockedOn, '具体卡点', 600),
        ruledOut: answer(cp.ruledOut, '已排除方向', 600, !compact), resumeAt: compact ? firstStep : answer(cp.resumeAt, '复工第一步', 600) },
    }
    const data = this.load()
    data.records.push(record)
    data.requests[hash(body.requestId as string)] = { hash: workspaceFingerprint(body), id: record.id }
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.file)
    this.committed('记录局势校准与复工线索', [fileName])
    return record
  }
}
