/**
 * One coding turn at a time per project directory, first come first served. Keys are resolved paths (`dir:<realpath>`)
 * or a private key for SuperHub's per-session directories, which never collide. Nested project directories are one
 * lock domain: `/repo` and `/repo/sub` exclude each other (a tool in `/repo` reaches into `/repo/sub`), `/repo` and
 * `/repo2` do not. The lock lives in this process: a restart frees it, and the waiting turns, saved as start rows, queue
 * again in their original order.
 */
export interface DirectoryHolder { sessionId: string; requestId: string; workOrderId?: string; title: string }
interface Waiter { id: number; key: string; holder: DirectoryHolder; resume: () => unknown }
interface Held { key: string; holder: DirectoryHolder }
interface Handed { key: string; token: number; holder: DirectoryHolder }

const DIR = 'dir:'

/** Two keys share a lock domain: the same key, or project directories where one contains the other (by path segment). */
export function lockConflict(a: string, b: string): boolean {
  if (a === b) return true
  if (!a.startsWith(DIR) || !b.startsWith(DIR)) return false
  const x = a.slice(DIR.length), y = b.slice(DIR.length)
  const below = (path: string, parent: string) => path.startsWith(parent.endsWith('/') ? parent : parent + '/')
  return below(x, y) || below(y, x)
}

export class DirectoryLocks {
  private held: Held[] = []
  private handed: Handed[] = []
  private queue: Waiter[] = []
  private serial = 0

  /** Take the directory: nothing overlapping runs, was handed over or waits, or it was just handed to this session. */
  take(key: string, holder: DirectoryHolder): boolean {
    const mine = this.handed.find(item => item.key === key && item.holder.sessionId === holder.sessionId)
    if (mine) {
      this.handed = this.handed.filter(item => item !== mine)
      this.held.push({key, holder})
      return true
    }
    if (this.blocked(key)) return false
    this.held.push({key, holder})
    return true
  }

  /** Who uses (or was just handed) this directory or one overlapping it; otherwise the first overlapping turn waiting ahead. */
  holder(key: string): DirectoryHolder | undefined {
    const overlaps = (item: {key: string}) => lockConflict(item.key, key)
    return (this.held.find(item => item.key === key) ?? this.handed.find(item => item.key === key)
      ?? this.held.find(overlaps) ?? this.handed.find(overlaps) ?? this.queue.find(overlaps))?.holder
  }

  /** Whether a turn runs in this directory (or an overlapping one) or waits for it (any session). */
  busy(key: string) { return this.blocked(key) }

  /**
   * Wait behind the current holder. `resume` runs once the directory is handed over; it should start the turn, which
   * then takes the directory. A hand-over nobody took by the time `resume` settles goes to the next in line.
   * Returns a cancel function (stopping the wait, or giving back a hand-over not taken yet).
   */
  wait(key: string, holder: DirectoryHolder, resume: () => unknown): () => void {
    const waiter: Waiter = {id: ++this.serial, key, holder, resume}
    this.queue.push(waiter)
    this.next()
    return () => {
      this.queue = this.queue.filter(item => item !== waiter)
      this.handed = this.handed.filter(item => item.token !== waiter.id)
      this.next()
    }
  }

  /** The turn `requestId` ended (in any way): the waiting turns that no longer overlap a running one get their directories. */
  release(key: string, requestId: string) {
    const held = this.held.find(item => item.key === key && item.holder.requestId === requestId)
    if (!held) return
    this.held = this.held.filter(item => item !== held)
    this.next()
  }

  private blocked(key: string) {
    return this.held.some(item => lockConflict(item.key, key)) || this.handed.some(item => lockConflict(item.key, key))
      || this.queue.some(item => lockConflict(item.key, key))
  }

  /** Hand over, in queue order, every waiter whose directory overlaps nothing running, handed over or waiting before it. */
  private next() {
    const ahead: Waiter[] = []
    for (const waiter of [...this.queue]) {
      const overlaps = (item: {key: string}) => lockConflict(item.key, waiter.key)
      if (this.held.some(overlaps) || this.handed.some(overlaps) || ahead.some(overlaps)) { ahead.push(waiter); continue }
      this.queue = this.queue.filter(item => item !== waiter)
      this.handed.push({key: waiter.key, token: waiter.id, holder: waiter.holder})
      queueMicrotask(() => {
        let outcome: unknown
        try { outcome = waiter.resume() } catch { outcome = undefined }
        void Promise.resolve(outcome).catch(() => {}).finally(() => this.unclaimed(waiter.id))
      })
    }
  }

  private unclaimed(token: number) {
    const before = this.handed.length
    this.handed = this.handed.filter(item => item.token !== token)
    if (this.handed.length !== before) this.next()
  }
}

/** Shared by every brain served by this process, so two brains bound to one directory still take turns. */
export const directoryLocks = new DirectoryLocks()
