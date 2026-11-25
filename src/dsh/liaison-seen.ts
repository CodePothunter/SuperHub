/**
 * 主人看过「一句话交办」的时间点：之后接口人新说的话和新到的提醒算未读（见 core/liaison-unread.ts）。
 *
 * 存在本脑 `ops/liaison-seen.json`，网页和手机共用；只前进不后退。文件不存在或读不出时以当前时刻为起点，
 * 首次上线不会把历史上的提醒一下子都算成未读。不引第三方依赖。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const LIAISON_SEEN_FILE = 'liaison-seen.json'

export class LiaisonSeen {
  private seenAt: number
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    let saved: number | undefined
    try {
      if (existsSync(file)) {
        const value = JSON.parse(readFileSync(file, 'utf8')) as { seenAt?: unknown }
        const at = typeof value?.seenAt === 'string' ? Date.parse(value.seenAt) : NaN
        if (Number.isFinite(at)) saved = at
      }
    } catch { /* 读不出：从现在开始 */ }
    this.seenAt = saved ?? this.now()
    if (saved === undefined) try { this.save() } catch { /* 下一次标记已读时再写 */ }
  }

  get(): number { return this.seenAt }

  /** 记下主人看到了 `at`（ISO 或毫秒）为止的内容；不超过现在，不倒退。 */
  mark(at: unknown): number {
    const value = typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : NaN
    if (!Number.isFinite(value)) throw Object.assign(new Error('已读时间无效'), { status: 400 })
    const next = Math.min(value, this.now())
    if (next > this.seenAt) { this.seenAt = next; this.save() }
    return this.seenAt
  }

  private save() {
    const temporary = this.file + '.tmp'
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temporary, JSON.stringify({ seenAt: new Date(this.seenAt).toISOString() }) + '\n', { mode: 0o600 })
      renameSync(temporary, this.file)
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* nothing left to clean */ }
      throw error
    }
  }
}
