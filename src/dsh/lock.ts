/**
 * 单写者锁。热重载可以交接同进程的实例，离线维护须独占一份脑。
 * 锁先写完整，再用硬链接发布。已退出进程的锁按该次持有身份串行接管。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, linkSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export const LEGACY_CLEANUP_PENDING = 'legacy-order-cleanup.pending'

export function acquireLock(root: string, maintenance = false): () => void {
  const file = join(root, 'ops', '.chief.lock')
  const instance = randomUUID()
  const mine = JSON.stringify({ pid: process.pid, instance, at: new Date().toISOString(), ...(maintenance && {maintenance}) })
  const proposed = file + '.' + instance + '.tmp'
  writeFileSync(proposed, mine, { flag:'wx', mode:0o600 })
  function read(path: string) {
    const stat = lstatSync(path,{throwIfNoEntry:false})
    if (!stat) return
    if (!stat.isFile()) throw new Error('第二大脑写锁路径不可用')
    try { return readFileSync(path,'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  function release(path: string) {
    if (read(path) === mine) rmSync(path,{force:true})
  }
  function claim(path: string, handoff: boolean, depth = 0): void {
    if (depth > 16) throw new Error('第二大脑写锁仍在交接，请稍后重试')
    for (;;) {
      try { linkSync(proposed,path); return }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const existing = read(path)
      if (existing === undefined) continue
      let holder: {pid?:number;maintenance?:boolean} | undefined
      try { holder = JSON.parse(existing) as typeof holder } catch { /* An incomplete former lock must not be stolen. */ }
      if (!holder?.pid || holder.pid < 1 || !Number.isSafeInteger(holder.pid)) throw new Error('第二大脑写锁内容不可读，请先核对是否仍有实例运行')
      if (!(handoff && holder.pid === process.pid && !holder.maintenance) && alive(holder.pid)) {
        throw new Error(`第二大脑 ${root} 已被进程 ${holder.pid} 的 SuperHub 占用；同一时间只能有一个写入实例`)
      }
      // All contenders for the same stale owner must first claim the same guard.
      // A crashed contender leaves another stale identity, handled by the same rule.
      const key = createHash('sha256').update(path).update('\0').update(existing).digest('hex')
      const guard = file + '.takeover-' + key + '.tmp'
      claim(guard,false,depth+1)
      try {
        if (read(path) !== existing) continue
        const swap = proposed + '.swap.tmp'
        try { linkSync(proposed,swap); renameSync(swap,path) }
        finally { rmSync(swap,{force:true}) }
        return
      } finally { release(guard) }
    }
  }

  try { claim(file,!maintenance) }
  finally { rmSync(proposed,{force:true}) }
  const unlock = () => release(file)
  if (!maintenance && existsSync(join(root, 'ops', LEGACY_CLEANUP_PENDING))) {
    unlock()
    throw new Error('这份第二大脑的旧工单清理尚未完成。请用原清单继续清理后再启动。')
  }
  return unlock
}
