/**
 * 跟进定时器：接口人和幕僚给自己定的"到时候回头看一眼"。
 *
 * 和时钟规则（主人定的周期任务）不同，这是 agent 自己设的一次性提醒。定时器只是记录；
 * 到点由调度循环把它变成一条事件放进收件箱，再从列表里删除——事件的去重键是定时器 id，
 * 所以即使在"已发事件、未删记录"之间崩溃，重启后也不会重复触发。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface Timer {
  id: string
  /** 触发时刻（ISO 时间点）。 */
  at: string
  text: string
  /** 谁定的：接口人，或者某张工单的执行者。 */
  by: string
  createdAt: string
}

export const MAX_TIMERS = 200
const MAX_AHEAD_DAYS = 180

export class Timers {
  constructor(private readonly file: string) { mkdirSync(dirname(file), { recursive: true }) }

  list(): Timer[] {
    if (!existsSync(this.file)) return []
    try {
      const value = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(value) ? (value as Timer[]).filter(t => t && typeof t.id === 'string' && typeof t.at === 'string').sort((a, b) => a.at.localeCompare(b.at)) : []
    } catch { return [] }
  }

  private save(timers: Timer[]): void {
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify(timers, null, 2)}\n`)
    renameSync(`${this.file}.tmp`, this.file)
  }

  add(input: { at: Date; text: string; by: string }, now: Date): Timer {
    const text = input.text.replace(/\s+/g, ' ').trim().slice(0, 500)
    if (!text) throw new Error('跟进需要写明到时候要检查什么')
    const ahead = input.at.getTime() - now.getTime()
    if (Number.isNaN(ahead)) throw new Error('时间格式应为 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM')
    if (ahead < 30_000) throw new Error('跟进时间要在现在之后')
    if (ahead > MAX_AHEAD_DAYS * 86_400_000) throw new Error(`跟进最远只能定到 ${MAX_AHEAD_DAYS} 天后`)
    const timers = this.list()
    if (timers.length >= MAX_TIMERS) throw new Error('待触发的跟进太多了，先取消一些')
    const timer: Timer = { id: randomUUID().slice(0, 8), at: input.at.toISOString(), text, by: input.by.slice(0, 40), createdAt: now.toISOString() }
    this.save([...timers, timer])
    return timer
  }

  remove(id: string): boolean {
    const timers = this.list()
    const rest = timers.filter(t => t.id !== id)
    if (rest.length === timers.length) return false
    this.save(rest)
    return true
  }

  due(now: Date): Timer[] { return this.list().filter(t => Date.parse(t.at) <= now.getTime()) }
}
