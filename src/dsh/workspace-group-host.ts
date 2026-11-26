/**
 * 本脑所有工作区群聊（`engine: 'roster'` 的会话）的引擎宿主：每场群一个 `GroupEngine`，第一次用到时建好并 `start()`；
 * 宿主启动时，为还有在跑回合、排队、批次或挂起叫人的群立即建好，这样跑到一半的成员接着被把关、被续上。
 *
 * - 记录目录 `ops/superhub-v2-dialogues/<工作区>/<群>`（与旧会话来源同一位置，群 id 不同所以不会混）。
 * - 成员干活的目录：群自己的目录（为一张自带目录的工单开的群）→ 工作区绑定的项目目录 → 群的 SuperHub 工作目录
 *   （`work/superhub-v2/<工作区>/<群>`，里面放一个空的 `.git`，DSH 找项目说明时到此为止，不会读到第二大脑的说明）。
 *   项目目录每次被叫时再校验一次，不可用时那一次记为「没能答完」。
 * - 同目录排队：群在项目目录里有成员在干活时占着那个目录的锁（与编程会话的回合同一把锁、同一套先来先得），
 *   别的会话的编程回合等它；群里的成员之间不互相排队（他们本来就并行）。锁随最后一个在跑的成员回合结束而释放。
 * - 运行器由运行时提供（DSH 模型成员一个、Codex / Claude Code 各一个），这里只给它们套上目录锁。
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { workspaceArchived, type V2Session } from '../core/workspace-v2.ts'
import { directoryLocks, type DirectoryHolder, type DirectoryLocks } from './directory-locks.ts'
import { directoryKey } from './project-directory.ts'
import type { Logger } from './ports.ts'
import { GroupEngine, GROUP_SCHEDULER_FILE, type GroupEngineOptions } from './workspace-group-engine.ts'
import { GROUP_MEMBERS_FILE, type GroupContext, type GroupMemberKind, type GroupRosterMember, type MemberCall, type MemberCallSink, type MemberReattach, type MemberRunner } from './workspace-group-members.ts'
import type { GroupEffect, GroupLimits } from './workspace-group-scheduler.ts'
import { dialogueKey } from './workspace-speaker-id.ts'
import { scopedDirectory } from './workspace-v2-dialogue.ts'
import type { WorkspaceV2Store } from './workspace-v2-store.ts'

export interface GroupHostOptions {
  /** The brain root (resolved). */
  root: string
  scope: string
  store: WorkspaceV2Store
  /** The group's roster: the liaison as admin and the workspace's staff (`groupRoster`), read fresh each time. */
  roster: (workspaceId: string) => GroupRosterMember[]
  runners: Partial<Record<GroupMemberKind, MemberRunner>>
  experience?: GroupEngineOptions['experience']
  approvals?: GroupEngineOptions['approvals']
  locks?: DirectoryLocks
  logger?: Logger
  now?: () => number
  limits?: Partial<GroupLimits>
}

/** What the routes add: budget and staff checks before a call, acceptance after a batch, order status after a change. */
export interface GroupHostHandlers {
  admit?: (session: V2Session, call: Parameters<NonNullable<GroupEngineOptions['admit']>>[0]) => string | undefined
  onEffects?: (session: V2Session, effects: readonly GroupEffect[], engine: GroupEngine) => void
  onChange?: (session: V2Session, engine: GroupEngine) => void
  /** Hold the wake of the liaison's order batches for an acceptance review (see `GroupEffect` `wake.held`). */
  holdOrderWakes?: boolean
  engage?: (session: V2Session, workOrderId: string | undefined, memberId?: string) => {generation?: number} | undefined
}

export class WorkspaceGroupHost {
  /** `readOnly`: opened for reading while its workspace was archived (`GroupEngine.open`). */
  private readonly engines = new Map<string, { engine: GroupEngine; ready: Promise<GroupEngine>; readOnly: boolean }>()
  private handlers: GroupHostHandlers = {}
  private readonly locked: GroupDirectoryLocks
  private readonly runners: Partial<Record<GroupMemberKind, MemberRunner>>
  private disposed = false

  constructor(private readonly options: GroupHostOptions) {
    const superhub = join(options.root, 'work', 'superhub-v2') + sep
    this.locked = new GroupDirectoryLocks(options.locks ?? directoryLocks, group => group.workDir.startsWith(superhub) ? undefined : 'dir:' + directoryKey(group.workDir), options.logger)
    this.runners = Object.fromEntries(Object.entries(options.runners).map(([kind, runner]) => [kind, runner && this.locked.wrap(runner)]))
  }

  get scope() { return this.options.scope }

  /** Set once by the routes before the first engine starts. */
  attach(handlers: GroupHostHandlers) { this.handlers = handlers }

  /** The group's record directory and its SuperHub working directory (created when missing). */
  paths(session: Pick<V2Session, 'id' | 'workspaceId'>): { dir: string; work: string } {
    const area = dialogueKey(this.options.scope, session.workspaceId), room = dialogueKey(area, session.id)
    const dir = scopedDirectory(this.options.root, ['ops', 'superhub-v2-dialogues', area, room])
    const work = scopedDirectory(this.options.root, ['work', 'superhub-v2', area, room])
    // DSH discovers project instructions from cwd up to the nearest .git marker: stop it inside the group's directory.
    scopedDirectory(work, ['.git'])
    return { dir, work }
  }

  /** Where the members work now; a project directory is checked again (and throws its reason when unusable). */
  workDir(session: Pick<V2Session, 'id' | 'workspaceId'>): string {
    const current = this.options.store.session(session.workspaceId, session.id)
    const project = current.directory ?? this.options.store.workspace(session.workspaceId).projectDirectory
    if (project) {
      try { return this.options.store.checkDirectory(project) }
      catch (error) { throw new Error('项目目录不可用：' + (error instanceof Error ? error.message : String(error))) }
    }
    return this.paths(session).work
  }

  /**
   * The engine of a roster group, started (built on first use). In an archived workspace it is only opened for reading:
   * nothing resumes, nobody is called and nothing is written; once the workspace is restored the next use starts it.
   */
  engine(session: Pick<V2Session, 'id' | 'workspaceId'>): Promise<GroupEngine> {
    if (this.disposed) return Promise.reject(new Error('群聊运行环境已切换，请重新打开'))
    const known = this.engines.get(session.id)
    if (known && !known.readOnly) return known.ready
    const archived = workspaceArchived(this.options.store.workspace(session.workspaceId))
    if (known && archived) return known.ready
    // Opened read-only while archived, restored since: started for real now.
    if (known) { known.engine.dispose(); this.engines.delete(session.id) }
    const stored = this.options.store.session(session.workspaceId, session.id)
    if (stored.engine !== 'roster') return Promise.reject(new Error('这场会话不是群聊'))
    const { dir } = this.paths(stored)
    const workspaceId = stored.workspaceId, groupId = stored.id
    const current = () => this.options.store.session(workspaceId, groupId)
    let engine!: GroupEngine
    engine = new GroupEngine({
      scope: this.options.scope, workspaceId, groupId, dir,
      workDir: () => this.workDir(stored),
      info: () => {
        const space = this.options.store.workspace(workspaceId)
        return { workspaceName: space.name, goal: space.goal, title: current().title }
      },
      roster: () => this.options.roster(workspaceId),
      runners: this.runners,
      experience: this.options.experience,
      orderTask: orderId => {
        const order = this.options.store.delegation(workspaceId,orderId)
        return {task:[order.title,order.promise].join('\n'),
          original:order.hasOriginal ? this.options.store.orderOriginal(workspaceId,orderId).text : undefined}
      },
      ...this.options.approvals && { approvals: this.options.approvals },
      onEffects: effects => this.handlers.onEffects?.(current(), effects, engine),
      onChange: () => this.handlers.onChange?.(current(), engine),
      admit: call => this.handlers.admit?.(current(), call),
      engage: (orderId, memberId) => this.handlers.engage?.(current(), orderId, memberId),
      ...this.handlers.holdOrderWakes && { holdOrderWakes: true },
      ...this.options.logger && { logger: this.options.logger },
      ...this.options.now && { now: this.options.now },
      ...this.options.limits && { limits: this.options.limits },
    })
    const ready = (archived ? engine.open() : engine.start()).then(() => engine)
    ready.catch(() => this.engines.delete(groupId))
    this.engines.set(groupId, { engine, ready, readOnly: archived })
    return ready
  }

  /** An engine already built for this group (not necessarily started). */
  loaded(sessionId: string): GroupEngine | undefined { return this.engines.get(sessionId)?.engine }

  /** The host-recorded owner words a running liaison call in this group acts on (`GroupEngine.ownerSourceOf`). */
  ownerTurn(groupId: string, callId: string) {
    const held = this.engines.get(groupId)
    return held && !held.readOnly ? held.engine.ownerSourceOf(callId) : undefined
  }

  /**
   * On host start: every roster group that still has work in flight (running, queued or parked calls, open batches,
   * a delivered call) gets its engine now, so members mid-call are gated again and their turns resumed.
   */
  async boot(): Promise<void> {
    // An archived workspace's groups stay asleep: nothing ran there when it was archived, and nothing new may start.
    const archived = new Set(this.options.store.list().filter(workspaceArchived).map(space => space.id))
    const sessions = this.options.store.rosterSessions().filter(session => !archived.has(session.workspaceId))
    await Promise.all(sessions.map(async session => {
      if (!this.inFlight(session)) return
      try { await this.engine(session) }
      catch (error) { this.options.logger?.warn('群聊「%s」没能恢复：%s', session.title, String(error)) }
    }))
  }

  private inFlight(session: V2Session): boolean {
    let dir: string
    try { dir = this.paths(session).dir } catch { return false }
    const read = (name: string) => {
      const path = join(dir, name)
      try { return existsSync(path) && lstatSync(path).isFile() ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : undefined } catch { return undefined }
    }
    const state = (read(GROUP_SCHEDULER_FILE)?.state ?? {}) as { calls?: unknown[]; batches?: unknown[]; parked?: unknown[] }
    const live = (read(GROUP_MEMBERS_FILE)?.live ?? {}) as Record<string, unknown>
    return !!state.calls?.length || !!state.batches?.length || !!state.parked?.length || Object.keys(live).length > 0
  }

  /** Staff joined, left or changed in a workspace: its running groups take the new roster. */
  refresh(workspaceId?: string) {
    for (const { engine } of this.engines.values()) {
      if (workspaceId !== undefined && engine.workspaceId !== workspaceId) continue
      if (!engine.started) continue
      try { engine.refreshMembers() } catch (error) { this.options.logger?.warn('群名册没能刷新：%s', String(error)) }
    }
  }

  /** The workspace was archived: its groups' engines stop (timers, scheduler); reading a group opens it read-only. */
  stopWorkspace(workspaceId: string) {
    for (const [id, { engine }] of this.engines) {
      if (engine.workspaceId !== workspaceId) continue
      engine.dispose()
      this.engines.delete(id)
    }
  }

  dispose() {
    this.disposed = true
    for (const { engine } of this.engines.values()) engine.dispose()
    this.engines.clear()
    this.locked.dispose()
  }
}

interface GroupLock { key: string; holder: DirectoryHolder; held: boolean; active: Set<string>; waiting: { callId: string; resolve: () => void; reject: (error: Error) => void }[]; cancel?: () => void }

/**
 * A roster group holds its project directory while any member call runs there: the same lock as coding turns, so a coding
 * turn in that directory waits for the group and the group's next call waits for the coding turn. Members of one group
 * never wait for each other. The lock is released when the group's last running call ends.
 */
export class GroupDirectoryLocks {
  private readonly groups = new Map<string, GroupLock>()
  private readonly callGroup = new Map<string, string>()
  private serial = 0

  constructor(private readonly locks: DirectoryLocks, private readonly place: (group: GroupContext) => string | undefined, private readonly logger?: Logger) {}

  wrap(inner: MemberRunner): MemberRunner {
    const self = this
    const sinkFor = (sink: MemberCallSink): MemberCallSink => ({
      ...sink,
      finished(callId, result) {
        const name = self.callGroup.get(callId)
        const lock = name ? self.groups.get(name) : undefined
        lock?.active.delete(callId)
        try { sink.finished(callId, result) }
        finally { if (name) self.settle(name) }
      },
    })
    return {
      async run(call: MemberCall, sink: MemberCallSink) {
        await self.enter(call.group, call.callId)
        try { await inner.run(call, sinkFor(sink)) }
        catch (error) { self.leave(call.callId); throw error }
      },
      async continue(callId: string, text: string) {
        const name = self.callGroup.get(callId)
        const lock = name ? self.groups.get(name) : undefined
        lock?.active.add(callId)
        try { await inner.continue(callId, text) }
        catch (error) { self.leave(callId); throw error }
      },
      cancel(callId: string) {
        self.abandon(callId)
        inner.cancel(callId)
      },
      async reattach(call: MemberReattach, sink: MemberCallSink) {
        // Held before the runner catches up (it may report the end at once); given back when the call is gone.
        self.resume(call.group, call.callId)
        let alive = false
        try { alive = await inner.reattach(call, sinkFor(sink)) }
        finally { if (!alive) self.leave(call.callId) }
        return alive
      },
      ...inner.steer && { steer: (callId: string, words: { id: string; text: string }) => inner.steer!(callId, words) },
      dispose() { inner.dispose() },
    }
  }

  private nameOf(group: GroupContext) { return group.scope + '\u0000' + group.workspaceId + '\u0000' + group.groupId }

  /** Join the group's hold on its directory: at once when the group holds it or it is free, otherwise wait in line. */
  private enter(group: GroupContext, callId: string): Promise<void> {
    let key: string | undefined
    try { key = this.place(group) } catch { key = undefined }
    if (!key) return Promise.resolve()
    const name = this.nameOf(group)
    let lock = this.groups.get(name)
    if (lock && lock.key !== key && lock.active.size === 0 && lock.waiting.length === 0) { this.drop(name); lock = undefined }
    if (!lock) {
      lock = { key, holder: { sessionId: group.groupId, requestId: 'group-' + group.groupId + '-' + ++this.serial, title: '群聊「' + group.title + '」' }, held: false, active: new Set(), waiting: [] }
      this.groups.set(name, lock)
    }
    this.callGroup.set(callId, name)
    if (!lock.held && this.locks.take(lock.key, lock.holder)) lock.held = true
    if (lock.held) { lock.active.add(callId); return Promise.resolve() }
    const entered = Promise.withResolvers<void>()
    lock.waiting.push({ callId, resolve: entered.resolve, reject: entered.reject })
    const current = lock
    current.cancel ??= this.locks.wait(current.key, current.holder, () => {
      current.cancel = undefined
      if (this.groups.get(name) !== current || !this.locks.take(current.key, current.holder)) return
      current.held = true
      for (const row of current.waiting.splice(0)) { current.active.add(row.callId); row.resolve() }
    })
    return entered.promise
  }

  /** A call that survived a restart runs again in the group's directory: take it back when possible, never block it. */
  private resume(group: GroupContext, callId: string) {
    let key: string | undefined
    try { key = this.place(group) } catch { key = undefined }
    if (!key) return
    const name = this.nameOf(group)
    let lock = this.groups.get(name)
    if (!lock) {
      lock = { key, holder: { sessionId: group.groupId, requestId: 'group-' + group.groupId + '-' + ++this.serial, title: '群聊「' + group.title + '」' }, held: false, active: new Set(), waiting: [] }
      this.groups.set(name, lock)
    }
    this.callGroup.set(callId, name)
    lock.active.add(callId)
    if (!lock.held) lock.held = this.locks.take(lock.key, lock.holder)
    if (!lock.held) this.logger?.warn('群聊「%s」续上的成员回合所在目录正被别的回合占用', group.title)
  }

  /** The call is gone (cancelled before or while waiting): it no longer holds or waits. */
  private abandon(callId: string) {
    const name = this.callGroup.get(callId)
    const lock = name ? this.groups.get(name) : undefined
    if (!lock) return
    const waiting = lock.waiting.find(row => row.callId === callId)
    if (waiting) {
      lock.waiting = lock.waiting.filter(row => row !== waiting)
      waiting.reject(new Error('这一回合已叫停'))
    }
    this.settle(name!)
  }

  private leave(callId: string) {
    const name = this.callGroup.get(callId)
    if (!name) return
    this.groups.get(name)?.active.delete(callId)
    this.callGroup.delete(callId)
    this.settle(name)
  }

  /** Release the directory once no call of the group runs or waits. */
  private settle(name: string) {
    const lock = this.groups.get(name)
    if (!lock || lock.active.size > 0 || lock.waiting.length > 0) return
    this.drop(name)
  }

  private drop(name: string) {
    const lock = this.groups.get(name)
    if (!lock) return
    this.groups.delete(name)
    lock.cancel?.()
    if (lock.held) this.locks.release(lock.key, lock.holder.requestId)
    for (const [callId, group] of this.callGroup) if (group === name) this.callGroup.delete(callId)
  }

  dispose() {
    for (const name of [...this.groups.keys()]) {
      const lock = this.groups.get(name)!
      for (const row of lock.waiting.splice(0)) row.reject(new Error('群聊运行环境已切换'))
      lock.active.clear()
      this.drop(name)
    }
  }
}
