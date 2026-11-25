/**
 * 工作电脑通道（DESIGN.md 第 6 节）：文件队列，工作电脑经 SSH 主动拉取与回传，hub 不连工作电脑。
 *
 *   ops/remote/outbox/<assignmentId>.json   待领取的任务（chief-bridge pull 领取后移到 taken/）
 *   ops/remote/inbox/<assignmentId>.json    回传的汇报（chief-bridge push 写入）
 *   ops/remote/done/                        已处理的回传
 *
 * ops/remote/ 不进 git：任务正文和回传内容只留在 hub 本机。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteQueue, RemoteTask } from '../core/engine.ts'

export const ASSIGNMENT_ID = /^[A-Za-z0-9-]{8,64}$/

export class FileRemoteQueue implements RemoteQueue {
  readonly dir: string
  constructor(root: string) {
    this.dir = join(root, 'ops', 'remote')
    for (const sub of ['staged', 'outbox', 'taken', 'inbox', 'done', 'rejected', 'receipts', 'claims', 'cancelled']) mkdirSync(join(this.dir, sub), { recursive: true })
  }

  prepare(task: RemoteTask): void {
    const file = join(this.dir, 'staged', `${task.assignmentId}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify(task), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  resume(ticketId: string, assignmentId: string): void {
    const file = join(this.dir, 'staged', `${assignmentId}.json`)
    if (!existsSync(file)) return
    const task = JSON.parse(readFileSync(file, 'utf8')) as RemoteTask
    if (task.ticketId !== ticketId || task.assignmentId !== assignmentId) throw new Error('工作电脑暂存任务身份不匹配')
    this.dispatch(task)
  }

  dispatch(task: RemoteTask): void {
    if (['outbox', 'taken', 'receipts', 'done', 'rejected', 'cancelled'].some(sub => existsSync(join(this.dir, sub, `${task.assignmentId}.json`)))) {
      rmSync(join(this.dir, 'staged', `${task.assignmentId}.json`), { force: true }); return
    }
    const file = join(this.dir, 'outbox', `${task.assignmentId}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify({ ...task, queuedAt: new Date().toISOString() }, null, 2))
    renameSync(`${file}.tmp`, file)
    rmSync(join(this.dir, 'staged', `${task.assignmentId}.json`), { force: true })
  }

  cancel(assignmentId: string): void {
    // A replayable pull claim must never resurrect a cancelled task.
    writeFileSync(join(this.dir, 'cancelled', `${assignmentId}.json`), '{}', { mode: 0o600 })
    for (const sub of ['staged', 'outbox', 'taken']) rmSync(join(this.dir, sub, `${assignmentId}.json`), { force: true })
  }

  /** 待领取与已领取未回传的数量，供作战台显示。 */
  counts(): { waiting: number; taken: number } {
    const count = (sub: string) => existsSync(join(this.dir, sub)) ? readdirSync(join(this.dir, sub)).filter(n => n.endsWith('.json')).length : 0
    return { waiting: count('outbox'), taken: count('taken') }
  }

  /** 读取回传；`handle` 返回后把文件移到 done/。坏文件也移走，避免反复报错。 */
  private draining = false

  async drain(handle: (report: { ticketId: string; assignmentId: string; report: unknown }) => Promise<boolean | void>, log: (m: string) => void): Promise<void> {
    const inbox = join(this.dir, 'inbox')
    if (this.draining || !existsSync(inbox)) return
    this.draining = true
    try { await this.drainOnce(inbox, handle, log) } finally { this.draining = false }
  }

  private async drainOnce(inbox: string, handle: (report: { ticketId: string; assignmentId: string; report: unknown }) => Promise<boolean | void>, log: (m: string) => void): Promise<void> {
    for (const name of readdirSync(inbox).filter(n => n.endsWith('.json')).sort()) {
      const file = join(inbox, name)
      let value: { ticketId: string; assignmentId: string; report: unknown }
      try {
        value = JSON.parse(readFileSync(file, 'utf8'))
        if (!/^T-\d+$/.test(value.ticketId) || !ASSIGNMENT_ID.test(value.assignmentId) || name !== `${value.assignmentId}.json` || value.report === undefined) throw new Error('非法 ticketId / assignmentId / report')
      } catch (error) {
        log(`工作电脑回传 ${name} 已隔离：${(error as Error).message}`)
        renameSync(file, join(this.dir, 'rejected', name)); continue
      }
      try {
        const accepted = await handle(value)
        if (accepted === false) {
          renameSync(file, join(this.dir, 'rejected', name))
          log(`工作电脑回传 ${name} 已拒绝：任务过期、取消或身份不匹配`)
          continue
        }
        renameSync(file, join(this.dir, 'done', name))
        rmSync(join(this.dir, 'taken', `${value.assignmentId}.json`), { force: true })
      } catch (error) {
        // 接收/存档/核验暂时失败不能确认完成，下轮继续处理原文件。
        log(`工作电脑回传 ${name} 暂未处理，保留待重试：${(error as Error).message}`)
      }
    }
  }
}
