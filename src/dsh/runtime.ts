/**
 * 运行时：一个第二大脑上的全部装配——文件存储、引擎、执行者、工作电脑队列、花名册、定时安排、发件箱、接口人、工具、接口。
 *
 * 由 src/index.ts 在第二大脑就绪后创建；换第二大脑、时区或并发数时 dispose 再重建，不重启 DSH。
 * 推送地址每次发送前现读配置，改了立即生效。
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slotKey } from '../core/clock.ts'
import type { Custom } from '../core/custom.ts'
import { buildExport, confirmedWorkBehavior, type ExportTarget } from '../core/export.ts'
import type { ExperienceEvidence, WorkspaceExperiencePort } from '../core/workspace-experience.ts'
import { IMPORT_PROMPT } from '../core/onboarding.ts'
import { Engine } from '../core/engine.ts'
import { FileStore } from '../core/store.ts'
import { latestAssignment } from '../core/stage.ts'
import type { Assignment, Ticket } from '../core/model.ts'
import { captureUiSource, UI_SOURCE_PROOF_FILENAME } from '../../scripts/ui-source-proof.mjs'
import { approvalNotice, commandApprovals, commandSummary } from './approvals.ts'
import { CodingGate, llmReviewer } from './coding-gate.ts'
import { BrainRepo } from './brain.ts'
import { createProfileImportService, llmProfileOrganizer } from './assistant-import.ts'
import { inboxDispatchState, LIAISON_PROMPT, LiaisonChat, offsetSpeech, type ChatMessage, type LiaisonParts } from './chat.ts'
import { chatAttachmentError, ChatAttachments } from './chat-attachments.ts'
import { registerCodexApprovals, type CodexApprovalConfig } from './codex-approvals.ts'
import { contextTokens, handoffText, hasRawConnectorHistory, liaisonGuard, LiaisonToolVisibility, mergeHistory, nextPartId, rotateLine, SteerCutter, type LiaisonToolStatus } from './liaison.ts'
import { applySelection, contextWindow, liaisonSelection } from './models.ts'
import { Worklines } from './worklines.ts'
import { NativeRooms, roomTools } from './rooms.ts'
import { executorOnly, staffForMember, teammateSelection, type ModelDefaults } from './staff-models.ts'
import { roomExecution } from './room-execution.ts'
import { recentTicketReplies } from './room-work.ts'
import { Connectors } from './connectors.ts'
import { Discussions } from './discussions.ts'
import { DshExecutors, ticketDesk, type ParentFor } from './executors.ts'
import { runtimeRoutes, type Route } from './http.ts'
import { workspaceV2Routes } from './workspace-v2.ts'
import { orderEnded, workspaceArchived } from '../core/workspace-v2.ts'
import { llmAcceptanceReviewer } from './workspace-acceptance.ts'
import { llmEngagementCoordinator } from './workspace-engagement.ts'
import { llmCommandJudge } from './workspace-order-command.ts'
import { liaisonSurfaceContext } from '../core/workspace-product.ts'
import { WorkspaceStaffStore } from './workspace-staff-store.ts'
import { createExperienceLearning } from './workspace-experience-learning.ts'
import { commandExperienceEvidence } from './workspace-experience-evidence.ts'
import { NativeExperience } from './workspace-native-experience.ts'
import { isRosterGroup, workspaceScope, WorkspaceV2Store } from './workspace-v2-store.ts'
import { workspaceCalendarRoutes } from './workspace-calendar.ts'
import { workspaceHistoryRoutes } from './workspace-history.ts'
import { createV2DialogueSource } from './workspace-v2-dialogue.ts'
import { executable } from './workspace-v2-coding.ts'
import { DshMemberRunner } from './workspace-group-dsh-member.ts'
import { CodingMemberRunner } from './workspace-group-coding-member.ts'
import { groupRoster, LIAISON_MEMBER_ID } from './workspace-group-members.ts'
import { WorkspaceGroupHost } from './workspace-group-host.ts'
import { GROUP_LEDGER_FILE, memberCompletionEvidenceId, readGroupLedger } from './workspace-group-ledger.ts'
import { LIAISON_AUTHOR } from '../core/workspace-v2.ts'
import { acquireLock } from './lock.ts'
import { makeNotifier, Outbox, type Notice } from './outbox.ts'
import { ScheduleRunner, scheduleProducer, scheduleRoutes, ScheduleStore } from './schedules.ts'
import { LIAISON_SEEN_FILE, LiaisonSeen } from './liaison-seen.ts'
import { enqueueResultNotice, noticeDelivery, resultDelivery } from './result-notices.ts'
import { situationText } from './poc-view.ts'
import type { Agent, HostContext } from './ports.ts'
import { FileRemoteQueue } from './remote.ts'
import { Roster } from './roster.ts'
import { CustomStore } from './custom-store.ts'
import { ensureDevStaff, ensureTemplateFiles, migrateStaffNames } from './scaffold.ts'
import type { SettingsStore } from './settings.ts'
import { nativeIntakeSource, SuperhubIntake } from './superhub.ts'
import { SuperhubGoals } from './superhub-goals.ts'
import { SuperhubSaa } from './superhub-saa.ts'
import { createSuperhubTrace } from './superhub-trace.ts'
import { superhubWorkspaceRoutes } from './superhub-workspace.ts'
import { registerTools, type ChiefControl } from './tools.ts'
import { stageLabel, ticketThread, warroomState, type WarroomState } from './view.ts'

/** 每一段接口人会话的消息序号偏移：换段后序号仍然递增，作战台按序号确认消息已送达。 */
const PART_SEQ = 1_000_000_000
const CLOCK_INTERVAL = 30_000
const REMOTE_INTERVAL = 15_000
const MEETING_PREP_HOURS = 12
const ROOM_EXECUTION_TOOLS = new Set(['bash', 'write', 'edit', 'apply_patch', 'run_code', 'working_directory', 'subagent_codex', 'subagent_claude_code'])
export const UI_STAFF = 'ui-smith'

export interface RuntimeOptions {
  root: string
  settings: SettingsStore
  /** $DSH_HOME/chief：部署记录等机器私有的东西放这里。 */
  chiefHome: string
  /** 插件包所在目录。 */
  pluginRoot: string
  /** 从 git 源码运行：界面师可以改源码并部署。 */
  dev: boolean
  /** 当前 profile 的 cordis.patch.yml，开发模式部署时用来触发热重载。 */
  patchPath?: string
  codex?: CodexApprovalConfig
  /** Minutes before an unanswered command approval expires (1 to 1440, default 30). */
  approvalTimeoutMinutes?: number
  liaisonSession: string
  /** 设置类操作（接口人的 chief_settings 工具用），由 src/index.ts 提供。 */
  control: ChiefControl
}

export interface Runtime {
  readonly root: string
  readonly scope: string
  readonly routes: Route
  state(owner?: boolean, commands?: boolean): WarroomState & { custom: Custom; dev: boolean }
  /** 按需查看工具限制与只读模型请求诊断；只含工具名，不含对话或凭据。 */
  liaisonToolStatus(): LiaisonToolStatus
  settingsStaff(): { id: string; name: string; executor: string; brief: string }[]
  settingsLiaisonModel(): string | undefined
  dispose(): Promise<void>
}

export async function createRuntime(ctx: HostContext, opts: RuntimeOptions): Promise<Runtime> {
  const { root, settings, chiefHome, pluginRoot, dev, liaisonSession: HQ_SESSION } = opts
  const { timeZone, concurrency } = settings.get()
  const log = (message: string) => ctx.logger.info('%s', message)
  const brain = new BrainRepo(root, message => ctx.logger.warn('%s', message))
  mkdirSync(join(root, 'ops'), { recursive: true })
  const brainScope = workspaceScope(root)
  const releaseLock = acquireLock(root)
  const releases: (() => void)[] = []
  let stopEngine: (() => void) | undefined
  try {
    const filled = ensureTemplateFiles(root)
    if (filled.length) brain.commit(`第二大脑：补上新版本的模板文件 ${filled.join('、')}`, { paths: filled })
    const renamed = migrateStaffNames(root)
    if (renamed.length) brain.commit('幕僚：研判事件的幕僚改名为"研判官"，和对话的接口人区分开', { paths: renamed })
    if (dev) {
      brain.extraWorkspaces = [pluginRoot]
      const added = ensureDevStaff(root)
      if (added.length) brain.commit('幕僚：开发模式，加入界面师', { paths: added })
    }
    const store = new FileStore(root)
    // The plugin's home is private storage, never a project directory for coding tools.
    // Every new workspace conversation is a group on the group engine; older sessions keep their old path until migrated.
    const workspaceStore = new WorkspaceV2Store(root, brainScope, undefined, { internal: [chiefHome], rosterGroups: true })
    const staffStore = new WorkspaceStaffStore(root,brainScope,() => brain.staff(),id=>workspaceStore.workspace(id),undefined,
      id=>workspaceArchived(workspaceStore.workspace(id)))
    const learningProblem = (error: unknown) => ctx.logger.warn('经验处理待重试：%s', String(error))
    const liaisonModel = () => {
      try { return liaisonSelection(settings.get(), ctx.get('agentDefaultModel')?.currentSelection()) } catch { return undefined }
    }
    const learning = createExperienceLearning({ root, scope: brainScope, staff: staffStore, llm: () => ctx.get('llm'),
      model: liaisonModel, timeZone, writable: id => { workspaceStore.writable(id) },
      workspaces: () => workspaceStore.list().filter(row => !workspaceArchived(row)).map(row => row.id),
      verifyOriginal: (evidence, audience) => v2Routes.verifyLearningOriginal(evidence, audience),
      resolveOriginals: (evidence, audience) => v2Routes.resolveLearningOriginals(evidence, audience),
      verifyEvidence(evidence) {
        const {workspaceId, sessionId, orderId} = evidence
        if (workspaceId && workspaceArchived(workspaceStore.workspace(workspaceId))) return false
        if (orderId && !workspaceId) return false
        const order = workspaceId && orderId ? workspaceStore.delegation(workspaceId,orderId) : undefined
        if (evidence.kind === 'owner' && !evidence.id.startsWith('group:')) {
          return superhub.receipts().some(({source}) => source.requestId === evidence.id && source.text.includes(evidence.quote ?? '')
            && (!workspaceId || workspaceStore.focus(source.context, true)?.workspace.id === workspaceId))
            || !!(sessionId && isLiaison(sessionId) && ctx.agents.get(sessionId)) && (ctx.agents.get(sessionId) as unknown as Agent).session
              ?.snapshotEvents().some(event => {
                const source = nativeIntakeSource([event])
                return source?.requestId === evidence.id && source.text.includes(evidence.quote ?? '')
              }) === true
        }
        if (!workspaceId || !sessionId || order && order.sessionId !== sessionId) return false
        const session = workspaceStore.session(workspaceId,sessionId)
        if (evidence.kind === 'artifact' || evidence.kind === 'tool' || evidence.kind === 'test') {
          return !!v2Routes.verifyLearningOriginal(evidence, {staffId: evidence.staffId})
        }
        if (evidence.kind === 'owner' && evidence.id.startsWith('group:')) {
          const seq = Number(evidence.messageId?.slice(2))
          const rows = groupHost.loaded(session.id)?.ledger.all() ?? readGroupLedger(join(groupHost.paths(session).dir,GROUP_LEDGER_FILE))
          return evidence.id === 'group:' + sessionId + ':' + seq &&
            rows.some(row=>row.seq === seq && row.speakerId === 'owner' && row.workOrderId === orderId && row.text.includes(evidence.quote ?? ''))
        }
        if (evidence.kind === 'group' && evidence.id.startsWith('group-member:')) {
          if (!isRosterGroup(session) || !/^g-[1-9]\d*$/.test(evidence.messageId ?? '')) return false
          const seq = Number(evidence.messageId!.slice(2))
          const rows = groupHost.loaded(session.id)?.ledger.all() ?? readGroupLedger(join(groupHost.paths(session).dir,GROUP_LEDGER_FILE))
          const line = rows.find(row => row.seq === seq && row.workOrderId === orderId)
          if (!line || [LIAISON_MEMBER_ID, 'owner', 'host'].includes(line.speakerId) || !line.text.includes(evidence.quote ?? '')
            || !staffStore.view(workspaceId).members.some(member => member.id === line.speakerId)) return false
          if (memberCompletionEvidenceId(sessionId, line) === evidence.id) return true
          const formal = orderId && [...workspaceStore.groupEvidence(orderId), ...workspaceStore.resultNotices()].some(result =>
            result.workspaceId === workspaceId && result.sessionId === sessionId && result.orderId === orderId && result.messageId === evidence.messageId)
          return !!formal && memberCompletionEvidenceId(sessionId, line, true) === evidence.id
        }
        if (evidence.kind === 'delivery' && evidence.version) {
          return workspaceStore.resultNotices().some(row=>row.id === evidence.id && row.workspaceId === workspaceId
            && row.sessionId === sessionId && row.orderId === orderId && row.messageId === evidence.messageId && row.version === evidence.version)
        }
        return true
      } })
    releases.push(() => learning.dispose())
    const brainDocument = (name: string) => { try { return readFileSync(join(root, name), 'utf8') } catch { return undefined } }
    const experience: WorkspaceExperiencePort = {
      selectExperience: query => ({...staffStore.selectExperience(query),
        behavior: confirmedWorkBehavior({me: brainDocument('me.md'), agents: brainDocument('AGENTS.md')})}),
      assertExperienceCurrent: selection => staffStore.assertExperienceCurrent(selection),
      recordExperienceDelivery: (selection, target, entries) => staffStore.recordExperienceDelivery(selection, target, entries),
    }
    const nativeExperience = new NativeExperience(experience, learningProblem)
    releases.push(() => workspaceStore.dispose())
    const commitPaths = (message: string, paths: string[]) => brain.commit(message, { paths })
    const goals = new SuperhubGoals(root, commitPaths)
    const saa = new SuperhubSaa(root, commitPaths)
    /** 本地时间：now 形如 2026-11-15T09:30，today 是它的日期部分。 */
    const clock = () => { const now = slotKey(new Date(), timeZone); return { now, today: now.slice(0, 10) } }
    const roster = new Roster(root, brain, () => clock().today)
    const outbox = new Outbox(join(root, 'ops', 'outbox.json'))
    // 定时安排：第一次启动时迁入旧 rules.yaml 的 rules 与 ops/timers.json 的跟进（之后不再读取它们）。
    const schedules = new ScheduleStore(root, { timeZone, takeLegacyRules: save => brain.takeLegacyRules(save), warn: message => ctx.logger.warn('%s', message) })
    if (schedules.migrated) log('定时安排已初始化：' + schedules.list().map(row => row.title + (row.enabled ? '' : '（停用）')).join('、'))
    else if (brain.hasLegacyRules()) ctx.logger.warn('rules.yaml 里又出现了 rules：定时规则已不再读取，请改用接口人建立定时安排（「设置 → 定时安排」可查看）。')
    const liaisonSeen = new LiaisonSeen(join(root, 'ops', LIAISON_SEEN_FILE))
    /** 推送地址：设置里的优先，其次是旧版本用的环境变量。每次现读，改了马上生效。 */
    const notifier = () => makeNotifier(settings.get().notifyUrl ?? process.env.CHIEF_NOTIFY_URL)
    brain.extraContext = () => {
      const lines = roster.lines().map(l => `${l.name}${l.health ? `（${l.health}）` : ''}${l.blocker ? `，受阻：${l.blocker}` : ''}`)
      const people = roster.people().map(p => `${p.name}${p.organization || p.role || p.team || p.groups?.length ? `（${[p.organization, p.groups?.join('、'), p.team, p.role].filter(Boolean).join('，')}）` : ''}`)
      return [lines.length ? `横向线：${lines.join('；')}` : '', people.length ? `人物：${people.join('、')}` : ''].filter(Boolean).join('\n')
    }
    const remote = new FileRemoteQueue(root)

    // ───────────── 接口人会话 ─────────────
    /**
     * 接口人会话：所有子代理的默认父节点，也是主人对话的入口；不承载工单状态。
     * 对话太长时换一段新会话（liaison.ts）：hqSession 是当前这一段，之前的段记在设置里，仍算接口人自己。
     */
    let hqSession = HQ_SESSION
    let hqWorkspace: string | undefined
    let titled = false
    /** 最近一次拿到的接口人 Agent（插话打断和换段检查用）。 */
    let hqAgent: Agent | undefined
    /** 已经带上接口人设定的 Agent 实例（会话卸载后重新加载会是新实例）。 */
    const briefed = new WeakSet<Agent>()
    const liaisonDir = join(chiefHome, 'liaison')
    const binding = () => { const b = settings.get().liaison; return b?.brain === root ? b : undefined }
    const earlier = () => binding()?.parts ?? []
    const baseId = () => binding()?.base ?? hqSession
    const isLiaison = (id: string) => id === hqSession || earlier().includes(id)
    const historyFile = () => join(liaisonDir, `${baseId()}.history.json`)
    const handoffFile = (id: string) => join(liaisonDir, `${id}.handoff.md`)
    let archive: ChatMessage[] | undefined
    const archived = (): ChatMessage[] => {
      if (archive) return archive
      try { archive = JSON.parse(readFileSync(historyFile(), 'utf8')) as ChatMessage[] } catch { archive = [] }
      return archive
    }
    let rotating: Promise<void> | undefined
    const parts: LiaisonParts = { current: () => hqSession, base: baseId, offset: () => earlier().length * PART_SEQ, archived, ready: async () => {
      await rotating
      const agent = hqAgent?.id === hqSession ? hqAgent : await hq()
      if (!hasRawConnectorHistory(agent.session?.toolHistory?.())) return
      await maybeRotate()
      await rotating
      if (hqSession === agent.id) throw Object.assign(new Error('上一轮正在收尾，接口人稍后会在同一段对话中接收你的话。'), { status: 503 })
    } }
    const inputAttachments = new ChatAttachments({ root, scope: brainScope, ctx, profilePatch: opts.patchPath, validateTarget(target, action) {
      const fail = (message: string) => { throw Object.assign(new Error(message), { status: 409 }) }
      if (!target.workspaceId) {
        if (target.sessionId !== parts.base() || target.workOrderId) fail('接口人对话已切换，请刷新后再打开附件')
        if (action === 'upload' && hqAgent?.id === hqSession) return hqSession
        return
      }
      const group = workspaceStore.session(target.workspaceId, target.sessionId)
      if (!isRosterGroup(group)) fail('请在工作区群聊或工单对话中使用附件')
      if (action !== 'upload') return
      // An archived workspace takes nothing new, attachments included (409 like every other write there).
      workspaceStore.writable(target.workspaceId)
      if (group.closed) fail('群聊已关闭，请重新打开后发送附件')
      const orderId = workspaceStore.target(group, target.workOrderId)
      if (orderId) {
        const order = workspaceStore.delegation(target.workspaceId, orderId)
        if (order.paused || orderEnded(order)) fail('工单已暂停或结束，恢复后可继续发送附件')
      }
    } })
    /** 接口人自己的问题：显示在作战台顶部，同一句只显示一次。 */
    const flag = (text: string) => { ctx.logger.warn('%s', text); engine.report(text) }

    /**
     * 工具限制分两层：执行时拦截（guard，真正的边界，每段会话都算）和逐名遮住真实全局工具。
     * 执行拦截安装失败时立即报告，注册表屏蔽无法覆盖会话自己的工具。
     */
    let guarded = false
    try {
      const off = ctx.tools.guard?.(liaisonGuard(id => isLiaison(id)))
      if (off) { releases.push(off); guarded = true }
    } catch (error) { ctx.logger.warn('接口人的工具拦截没装上：%s', String(error)) }
    if (!guarded) flag('接口人的执行时工具拦截未启用。请在修复前关闭手机访问；沙箱可能仍提供命令或写文件工具。')
    const toolVisibility = new LiaisonToolVisibility(ctx.tools, isLiaison)
    releases.push(() => toolVisibility.dispose())
    let requestAudit: LiaisonToolStatus['requestAudit'] = 'unavailable'
    try {
      const off = ctx.on?.('llm/stream', (options, next) => {
        try { toolVisibility.observe(options) } catch { requestAudit = 'unavailable' }
        return nativeExperience.request(options, next)
      }, {prepend: true})
      if (typeof off === 'function') { releases.push(off); requestAudit = 'available' }
    } catch { /* 旧宿主没有最终请求事件时，诊断明确显示不可用 */ }
    const offToolChanges = ctx.on?.('tools/change', () => toolVisibility.refresh())
    if (typeof offToolChanges === 'function') releases.push(offToolChanges)
    const offCreated = ctx.on?.('agent/created', ({ agent }) => { if (isLiaison(agent.id)) toolVisibility.attach(agent) })
    if (typeof offCreated === 'function') releases.push(offCreated)

    /**
     * 接口人的模型和思考深度：设置里指定了就用指定的，清空了就回到 DSH 的默认选择（含默认档位）。
     * 指定了模型但没指定档位时不带 reasoningEffort，由适配器用模型默认。只改这个会话，不动 profile 默认。
     */
    const applyModel = (agent: Agent) => {
      if (!agent.model) return
      const want = liaisonSelection(settings.get(), ctx.get('agentDefaultModel')?.currentSelection())
      try { applySelection(agent.model, want) } catch (error) {
        flag(`接口人没能换到模型 ${want?.provider}/${want?.model}${want?.reasoningEffort ? `（思考深度 ${want.reasoningEffort}）` : ''}：${String(error)}`)
      }
    }
    releases.push(settings.onChange((next, prev) => {
      if ((next.liaisonModel !== prev.liaisonModel || next.liaisonReasoningEffort !== prev.liaisonReasoningEffort) && hqAgent) applyModel(hqAgent)
    }))

    const hq = async (): Promise<Agent> => {
      const sessionId = hqSession
      let result = await ctx.sessionController.resolveAgent(sessionId)
      if ('error' in result) {
        if (result.error.code !== 'session/not-found') throw new Error(`接口人会话不可用：${result.error.code}`)
        hqWorkspace ??= (await ctx.workspaceRegistry.create(root, '第二大脑')).id
        await ctx.sessionController.create({ sessionId, workspaceId: hqWorkspace })
        result = await ctx.sessionController.resolveAgent(sessionId)
        if ('error' in result) throw new Error(`无法创建接口人会话：${result.error.code}`)
      }
      if (!titled) {
        // 每次启动设置一次标题：会话活跃后改名才可靠，重复设置无副作用。
        titled = true
        const renamed = await ctx.sessionController.rename({ sessionId, title: '接口人' }).catch((e: unknown) => ({ error: e }))
        if (renamed && typeof renamed === 'object' && 'error' in renamed) ctx.logger.warn('接口人会话改名失败：%o', renamed)
      }
      const agent = result.agent
      if (!briefed.has(agent)) {
        briefed.add(agent)
        try {
          // 换段后的新会话：交接内容接在设定后面，进系统提示（不占一轮对话，重启后也还在）
          const handoff = existsSync(handoffFile(sessionId)) ? readFileSync(handoffFile(sessionId), 'utf8') : ''
          const prompt = handoff ? `${LIAISON_PROMPT}\n\n${handoff}` : LIAISON_PROMPT
          const system = agent.ctx?.systemPrompt
          const currentContext = () => {
            const ownerTurn = nativeExperience.ownedInput(agent.id) ?? nativeIntakeSource(agent.session?.snapshotEvents() ?? [])
            const origin = ownerTurn && superhub.ownerTurnOrigin(ownerTurn)
            const focus = workspaceStore.focus(origin?.context)
            const surface = liaisonSurfaceContext(origin?.context, workspaceStore.list(), {
              personName:historyRoutes.personName, today:clock().today, focus })
            nativeExperience.clear(agent.id)
            const inherited = ownerTurn ? nativeExperience.prompt(agent.id, {workspaceId: focus?.workspace.id, task: ownerTurn.text},
              {turnId: ownerTurn.requestId, sessionId: focus?.session?.id ?? agent.id, nativeSessionId: agent.id,
                executorId: 'liaison', orderId: focus?.order?.id}, agent.session?.snapshotEvents()) : ''
            return [surface, inherited].filter(Boolean).join('\n\n')
          }
          const dynamic = system?.context?.({name:'dsh-chief-liaison-turn',order:130,required:true,interpolate:false,text:currentContext})
          if (dynamic) releases.push(dynamic)
          const release = system?.section({ name: 'dsh-chief-liaison', order: 9000, interpolate: false, text: () => {
            const recent = recentTicketReplies(store.tickets(), [], 5).map(({ ticketId, title, at }) => ({ ticketId, title: title.slice(0, 120), at }))
            return [prompt, dynamic ? '' : currentContext(), recent.length ? `最近有主人补充的工单索引（仅供定位）：${JSON.stringify(recent)}。查询原话时用 chief_ticket view。` : ''].filter(Boolean).join('\n\n')
          } })
          if (release) releases.push(release)
          else flag('接口人设定没有生效：这个版本的 DSH 不支持按会话追加系统提示')
        } catch (error) { flag(`接口人设定没有生效：${String(error)}`) }
        toolVisibility.attach(agent)
        applyModel(agent)
      }
      if (sessionId === hqSession) hqAgent = agent
      return agent
    }
    const chat = new LiaisonChat(ctx.sessionController, parts, hq,
      () => [
        ...outbox.recent(30).map(projectNotice).filter(row => row !== undefined),
        ...rooms.ownerActions().filter(action => !action.ticketId).map(action => ({ key: `room-action:${action.id}`, at: action.at,
          text: `「${action.roomTitle}」${action.text}`, roomId: action.roomId, status: action.answered ? '已回答' : action.kind === 'question' ? '待回答' : '待提交工单', done: action.answered === true })),
      ],
      eventId => inboxDispatchState(store, eventId),
      () => recentTicketReplies(store.tickets(), rooms.list()), (workspaceId,orderId) => workspaceStore.orderLabel(workspaceId,orderId),
      (receipts, options) => rooms.discussionResults(receipts, options),
      { service: inputAttachments, forRequest: source => superhub.ownerTurnOrigin(source)?.inputAttachments },
      async (requestId, text) => {
        const context = superhub.ownerTurnOrigin({requestId,text})?.context
        const query = {workspaceId: workspaceStore.focus(context)?.workspace.id, task:text}
        const needsFresh = () => !!hqAgent && nativeExperience.needsFreshHistory(hqAgent.session?.snapshotEvents() ?? [],query)
        if (!needsFresh()) return
        await maybeRotate(true)
        if (needsFresh()) throw Object.assign(Error('接口人正在处理原工作区的消息。请等本轮结束后重新发送，届时会用当前范围打开新一段。'),{status:409})
      })

    /**
     * 换段：一轮结束、接口人闲着、上下文超过线时，开一段新会话。
     * 旧的一段原样留着（DSH 里能打开），作战台把它的消息归档后接在前面；新的一段从交接内容开始。
     */
    const maybeRotate = async (restrictedHistory = false) => {
      const agent = hqAgent
      const idle = () => agent?.id === hqSession && agent.status !== 'running' && !rotating && !chat.sending()
        && (agent.inbox?.nextTurn.length ?? 0) + (agent.inbox?.nextStep.length ?? 0) === 0
      if (!agent || !idle()) return
      const events = agent.session?.snapshotEvents() ?? []
      const used = contextTokens(events)
      const legacyConnectors = hasRawConnectorHistory(agent.session?.toolHistory?.())
      // CHIEF_LIAISON_ROTATE_AT：调试用，临时把换段线调低（token 数）
      const line = legacyConnectors || restrictedHistory ? 0 : Number(process.env.CHIEF_LIAISON_ROTATE_AT) || rotateLine(await contextWindow(ctx.get('llm'), agent.model?.current()))
      if ((!restrictedHistory && !legacyConnectors && (!used || used < line)) || !idle()) return
      const omitHistory = restrictedHistory || nativeExperience.needsFreshHistory(events,{task:''})
      rotating = (async () => {
        const previous = hqSession, next = nextPartId(previous), base = baseId()
        // The context-window lookup can overlap a completed send. Archive the last idle snapshot.
        const { messages } = chat.project(agent.session?.snapshotEvents() ?? [])
        mkdirSync(liaisonDir, { recursive: true, mode: 0o700 })
        writeFileSync(handoffFile(next), handoffText(previous, omitHistory ? [] : messages, clock().now.replace('T', ' ')))
        const merged = mergeHistory(archived(), messages.map(m => offsetSpeech(m, parts.offset())), 200)
        const materials = new Map(merged.flatMap(message => (message.inputAttachments ?? []).map(file => [file.id, file] as const)))
        for (const [id, file] of omitHistory ? [] : materials) {
          try { inputAttachments.allowRead(next, [file]) }
          catch (error) { ctx.logger.warn('接口人换段未能恢复附件 %s：%s', id, chatAttachmentError(error)) }
        }
        hqWorkspace ??= (await ctx.workspaceRegistry.create(root, '第二大脑')).id
        await ctx.sessionController.create({ sessionId: next, workspaceId: hqWorkspace })
        writeFileSync(join(liaisonDir, `${base}.history.json`), JSON.stringify(merged))
        archive = merged
        settings.update({ liaison: { session: next, brain: root, base, parts: [...earlier(), previous] } })
        hqSession = next
        titled = false
        await hq()
        await ctx.sessionController.rename({ sessionId: previous, title: `接口人（第 ${earlier().length} 段，已归档）` }).catch(() => undefined)
        log(`接口人对话换段：${previous} → ${next}（${legacyConnectors ? '更新连接器授权范围' : `上一段用了约 ${used} tokens，线是 ${line}`}）`)
      })().finally(() => { rotating = undefined })
      await rotating
    }

    /** 接口人会话的事件：插话即时生效；每轮结束检查要不要换段。 */
    const cutter = new SteerCutter(() => hqAgent)
    let rotateCheck: ReturnType<typeof setTimeout> | undefined
    const offEvents = ctx.on?.('session/event', (session, event) => {
      if (event.type === 'turn/end') nativeExperience.finishTurn(session.id)
      if (session.id !== hqSession) return
      cutter.observe(event)
      if (event.type === 'turn/end') {
        clearTimeout(rotateCheck)
        rotateCheck = setTimeout(() => { void maybeRotate().catch(e => flag(`接口人对话换段失败：${String(e)}`)) }, 2_000)
      }
    })
    if (typeof offEvents === 'function') releases.push(offEvents)
    else ctx.logger.warn('收不到会话事件：主人插话要等接口人这一步做完，长对话也不会自动换段')
    releases.push(() => clearTimeout(rotateCheck))

    /**
     * 工坊会话：改第二大脑以外的仓库（rules.yaml 的 workspaces）时用作子代理的父会话。
     * 子代理的文件沙箱跟随父会话的工作区，接口人会话只能写第二大脑。每个工作区一个，会话 id 固定。
     */
    const workshops = new Map<string, Promise<Agent>>()
    const workshop = (dir: string): Promise<Agent> => {
      const cached = workshops.get(dir)
      if (cached) return cached
      const sessionId = `chief-workshop-${createHash('sha256').update(dir).digest('hex').slice(0, 10)}`
      const made = (async () => {
        let result = await ctx.sessionController.resolveAgent(sessionId)
        if ('error' in result) {
          const workspace = await ctx.workspaceRegistry.create(dir)
          await ctx.sessionController.create({ sessionId, workspaceId: workspace.id })
          await ctx.sessionController.rename({ sessionId, title: `工坊 · ${dir.split('/').at(-1)}` }).catch(() => undefined)
          result = await ctx.sessionController.resolveAgent(sessionId)
          if ('error' in result) throw new Error(`无法创建工坊会话：${result.error.code}`)
        }
        return result.agent
      })()
      made.catch(() => workshops.delete(dir))
      workshops.set(dir, made)
      return made
    }
    /** 工单目录用工单桌（executors.ts 的 ticketDesk）；工作目录在哪个允许的工作区里，就用那个工坊；否则（第二大脑）用接口人会话。 */
    const desk = ticketDesk(ctx, join(root, 'work'), hq)
    const parentFor: ParentFor = async cwd => {
      if (desk.owns(cwd)) return desk.open(cwd)
      const dir = brain.workspaces().find(w => cwd === w || cwd.startsWith(`${w}/`))
      return dir ? workshop(dir) : hq()
    }
    const executors = new DshExecutors(ctx, parentFor, !!opts.codex)

    // ───────────── 开发模式：界面修改的部署 ─────────────
    const deployLog = join(chiefHome, 'deploys.jsonl')
    let deploying = false
    /**
     * 在独立进程里部署：部署会热重载本插件，所以不能在插件进程的生命周期里等它。
     * 结果写进 $DSH_HOME/chief/deploys.jsonl，下一轮检查时变成提醒。
     */
    const startDeploy = (args: string[], ticketId?: string) => {
      if (!dev) throw new Error('只有从 git 源码安装时才能改源码')
      if (!opts.patchPath) throw new Error('不知道当前 profile 在哪里，没法热重载')
      if (deploying) throw new Error('上一次部署还没结束')
      deploying = true
      const id = String(Date.now())
      mkdirSync(chiefHome, { recursive: true, mode: 0o700 })
      const out = openSync(join(chiefHome, `deploy-${id}.log`), 'a')
      const child = spawn(process.execPath, [join(pluginRoot, 'scripts', 'deploy.mjs'), ...args, '--log', deployLog, '--patch', opts.patchPath, '--home', chiefHome, ...ticketId ? ['--ticket', ticketId] : []],
        { cwd: pluginRoot, detached: true, stdio: ['ignore', out, out], env: { ...process.env, CHIEF_DEPLOY_ID: id } })
      child.on('exit', () => { deploying = false })
      child.unref()
    }
    const deploys = () => existsSync(deployLog) ? readFileSync(deployLog, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as { id: string; ticket?: string; ok: boolean; title: string; detail: string; at: string }] } catch { return [] } }) : []

    let intake: SuperhubIntake | undefined
    const sourceTicket = (ticket: Ticket) => dev && ticket.superhub && ticket.staff === UI_STAFF && ticket.workspace === pluginRoot
    const uiProofPath = (id: string) => `work/${id}/${UI_SOURCE_PROOF_FILENAME}`
    const approvedUiDigest = (ticket: Ticket, assignment: Assignment): string => {
      const evidence = assignment.verification?.criteria?.flatMap(criterion => criterion.status === 'pass' ? criterion.evidence : [])
        .find(ref => ref.kind === 'delivery' && ref.path === uiProofPath(ticket.id))
      if (!evidence || evidence.kind !== 'delivery') throw Error('请核验本次界面改动的源代码快照')
      const saved = brain.deliveryEvidence(ticket.id, evidence)
      const current = captureUiSource(pluginRoot)
      if (!current.paths.length || current.proof !== saved) throw Error('界面源代码已变化，请重新生成并核验交付快照')
      return current.digest
    }
    brain.hostOutputs = id => {
      const ticket = store.ticket(id)
      if (!ticket || !sourceTicket(ticket)) return []
      try {
        const snapshot = captureUiSource(pluginRoot)
        if (!snapshot.paths.length) return []
        if (realpathSync(brain.workdir(id)) !== join(realpathSync(root), 'work', id)) throw Error('无法确认工单目录')
        const file = join(root, uiProofPath(id)), temp = `${file}.${randomUUID()}.tmp`
        writeFileSync(temp, snapshot.proof, { mode: 0o600, flag: 'wx' })
        renameSync(temp, file)
        return [uiProofPath(id)]
      } catch (error) {
        log(`${id} 界面源代码快照采集失败：${(error as Error).message}`)
        return []
      }
    }
    const engine = new Engine(store, brain, executors, remote, {
      brainScope,
      canStartSuperhub: auth => intake?.allowsCommand(auth) === true,
      checkSuperhubAcceptance: (ticket, assignment) => {
        if (!sourceTicket(ticket)) return
        try { approvedUiDigest(ticket, assignment) } catch (error) { return (error as Error).message }
      },
      onEnded: ticket => {
        // 界面师的工单核验通过：自动部署（只在开发模式下）。
        if (dev && ticket.staff === UI_STAFF && ticket.ended?.outcome === 'done' && (!ticket.superhub || ticket.superhub.ownerAcceptance?.kind === 'accepted')) {
          try {
            const args = [ticket.title]
            if (ticket.superhub) {
              const assignment = latestAssignment(ticket)
              if (!assignment || !sourceTicket(ticket)) throw Error('缺少已核验的界面源代码工作区')
              args.push('--source-digest', approvedUiDigest(ticket, assignment))
            }
            startDeploy(args, ticket.id)
          } catch (e) { ctx.logger.warn('自动部署没有开始：%s', String(e)) }
        }
      },
      concurrency,
      timeZone,
      log,
    })
    const superhub = new SuperhubIntake({ root, chiefHome, brainScope, engine, hasGoal: id => !!goals.get(id),
      staff: () => brain.staff(), uiWorkspace: dev ? pluginRoot : undefined,
      // SuperHub 交办与补充原话：作为主人的消息交给接口人理解（与网页对话同一个入口）。
      liaison: (text, requestId, refs) => chat.say(text, 'auto', undefined, requestId, refs),
      uiCanBegin: () => {
        if (deploying || store.tickets().some(ticket => !ticket.ended && sourceTicket(ticket))) throw Error('已有界面工单或部署在办，请先处理那个工作区')
        if (captureUiSource(pluginRoot).paths.length) throw Error('工作区有尚未归属的界面改动，请先处理这些改动再交办')
      } })
    intake = superhub
    const trace = createSuperhubTrace(ctx, engine, brainScope, {
      storage: join(chiefHome, brainScope, 'superhub-trace.jsonl'), brainRoot: root, staff: () => brain.staff(), log,
    })
    executors.observeExecution = trace.observeExecution
    releases.push(() => trace.dispose())
    /**
     * 提醒发出之后事情会变：每次显示时对照工单的现状，处理过的标上现在的状态（页面上变暗），
     * 不然"等你验收"的提醒在验收后还原样挂着。
     */
    const OUTCOME_LABEL: Record<string, string> = { done: '已完成', stopped: '已停止', dropped: '已放弃', failed: '失败了' }
    const APPROVAL_LABEL: Record<string, string> = { 'allowed-once': '已允许本次', rejected: '已拒绝', expired: '已过期', cancelled: '已撤回' }
    /** Live command approvals are created after the chat; until then nothing is pending. */
    let approvalPending = (_id: string) => false
    /** Coding-session approvals answered through the command gate (pending, a decision, or unknown after a restart). */
    let workspaceApproval = (_id: string): string | undefined => undefined
    const WORKSPACE_APPROVAL_LABEL: Record<string, string> = { allowed: '已允许本次', rejected: '已拒绝', expired: '已过期' }
    function projectNotice(notice: Notice) {
      const ticket = notice.ticketId ? store.ticket(notice.ticketId) : undefined
      if (ticket?.superhub && ticket.superhub.brainScope !== brainScope) return undefined
      // Older decision receipts did not persist a document target. Bind them to their original round.
      const reviewRound = /^need:[^:]+:you\/review:(\d+)$/.exec(notice.key)?.[1]
      const original = ticket && (notice.assignmentId ? ticket.assignments.find(row => row.id === notice.assignmentId)
        : reviewRound ? ticket.assignments[Number(reviewRound) - 1] : undefined)
      const delivery = ticket && (notice.delivery ? noticeDelivery(root, ticket, notice)
        : original ? resultDelivery(root, ticket, original) : undefined)
      return { key: notice.key, at: notice.at, text: notice.text, ...notice.ticketId ? { ticketId: notice.ticketId } : {},
        ...notice.kind ? { kind: notice.kind } : {}, ...delivery ? { delivery } : {}, ...notice.order ? { order: notice.order } : {},
        ...notice.delivery && !delivery ? { deliveryUnavailable: true } : {}, ...notice.schedule ? { schedule: notice.schedule } : {},
        ...noticeState(notice.key, notice.ticketId, notice.order) }
    }
    function noticeState(key: string, ticketId?: string, order?: Notice['order']): { status?: string; done?: boolean } {
      if (key.startsWith('schedule:')) {
        // The reminder itself stays unread until seen; its line only says what became of the schedule since.
        const current = schedules.get(key.split(':')[1] ?? '')
        if (!current) return { status: '这条定时安排已删除' }
        if (current.at && current.lastRun?.slot === current.at) return { status: '一次性安排，已完成' }
        return current.enabled ? {} : { status: '已停用' }
      }
      if (key.startsWith('workspace-approval:')) {
        const status = workspaceApproval(key.split(':')[2] ?? '')
        return status === 'pending' ? {} : { status: status ? WORKSPACE_APPROVAL_LABEL[status] ?? '已处理' : '已结束', done: true }
      }
      if (key.startsWith('workspace-acceptance:') && order) {
        // Waiting for the owner until the owner answers, the order moves on to a newer verdict, or it ends.
        const [, , turnId] = key.split(':')
        let current: ReturnType<typeof workspaceStore.delegation> | undefined
        try { current = workspaceStore.delegation(order.workspaceId, order.orderId) } catch { return { status: '工单已不可用', done: true } }
        if (orderEnded(current)) return { status: current.status === 'done' ? '工单已完成' : '工单已关闭', done: true }
        return current.acceptance?.awaitingOwner && current.acceptance.turnId === turnId ? {} : { status: '已处理', done: true }
      }
      if (key.startsWith('workspace-stalled:') && order) {
        let current: ReturnType<typeof workspaceStore.delegation> | undefined
        try { current = workspaceStore.delegation(order.workspaceId, order.orderId) } catch { return { status: '工单已不可用', done: true } }
        if (orderEnded(current)) return { status: current.status === 'done' ? '工单已完成' : '工单已关闭', done: true }
        return {}
      }
      if (key.startsWith('approval:') && ticketId) {
        const id = key.split(':')[2] ?? ''
        if (approvalPending(id)) return {} // 还在等你决定
        const settled = store.ticket(ticketId)?.assignments.flatMap(row => row.commandApprovals ?? []).filter(row => row.id === id && row.status !== 'requested').at(-1)
        return { status: settled ? APPROVAL_LABEL[settled.status] ?? '已处理' : '已结束', done: true }
      }
      if (key.startsWith('result:') && ticketId) {
        const view = engine.ticketView(ticketId)
        return { status: view?.ticket.ended ? view.ticket.ended.outcome === 'done' ? '已办结' : OUTCOME_LABEL[view.ticket.ended.outcome]
          : view ? `已有结果 · 当前${stageLabel(view.stage)}` : '工作记录暂不可读', done: true }
      }
      if (key.startsWith('need:') && ticketId) {
        const [, , stage, rounds] = key.split(':')
        const view = engine.views().find(v => v.ticket.id === ticketId)
        if (!view) return {}
        const t = view.ticket
        if (t.ended) {
          const applied = engine.views().some(v => v.ticket.title === `执行提案 ${t.id}`)
          const label = t.ended.outcome === 'done' && stage === 'you/review' ? (applied ? '已验收并执行' : '已验收') : t.ended.outcome === 'done' && stage === 'you/approve' ? '已批准，已完成' : OUTCOME_LABEL[t.ended.outcome] ?? '已结束'
          return { status: label, done: true }
        }
        if (view.stage === stage && String(t.assignments.length) === rounds) return {} // 还在等你
        if (view.stage === stage) return { status: stage === 'you/review' ? '改过一版，又在等你验收' : `现在：${stageLabel(view.stage)}`, done: true }
        if (view.stage.startsWith('you/')) return { status: `现在：${stageLabel(view.stage)}`, done: true }
        return { status: stage === 'you/approve' ? '已批准，处理中' : stage === 'you/review' ? '已退回修改，处理中' : stage === 'you/answer' ? '已回答，处理中' : '处理中', done: true }
      }
      if (key.startsWith('stuck:')) {
        const kind = store.disposition(key.slice('stuck:'.length))?.kind
        return kind && kind !== 'unavailable' ? { status: '已处理', done: true } : {}
      }
      if (key.startsWith('morning:')) return key.slice('morning:'.length) === clock().today ? {} : { done: true }
      if (key.startsWith('deploy:')) return { done: true }
      return {}
    }
    const offResultNotices = engine.onTicketSaved(ticket => {
      try { enqueueResultNotice(outbox, root, brainScope, ticket) }
      catch (error) { ctx.logger.warn('记录工作结果提醒失败：%s', String(error)) }
    })
    if (offResultNotices) releases.push(offResultNotices)
    const available = (executor: string) => executors.available(executor)
    const lookup = {
      info: (id: string) => {
        const header = ctx.agents.get(id)?.session.header
        return header ? { subagent: header.origin === 'subagent', ...header.parentSession ? { parent: header.parentSession } : {} } : undefined
      },
    }

    /** 事件来源一览。前几个是固定的；后面是花名册驱动的来源，可以调档（rules.yaml 的 sources）。 */
    const ROSTER_SOURCES = [
      { id: 'meeting-prep', name: '会议临近', what: '登记过的会议开始前 12 小时，让谋士写准备材料', fallback: 'auto' },
      { id: 'commitment-due', name: '承诺逾期', what: '别人答应你的事过了约定日期，让谋士起草催办（不发送）', fallback: 'auto' },
      { id: 'stale-contact', name: '该联系了', what: '影响力高的人超过 14 天没联系，建议一个联系的由头', fallback: 'observe' },
    ] as const
    const modeOf = (id: typeof ROSTER_SOURCES[number]['id']) => brain.sourceMode(id, ROSTER_SOURCES.find(s => s.id === id)!.fallback)
    const sources = () => [
      { id: 'inbox', name: '你的交办', what: '你对接口人说的、在台面上点的', mode: 'auto' as const, fixed: true },
      { id: 'remote', name: '工作电脑回传', what: '外务在工作电脑上办完的事', mode: 'auto' as const, fixed: true },
      ...ROSTER_SOURCES.map(s => ({ id: s.id, name: s.name, what: s.what, mode: modeOf(s.id), fixed: false })),
    ]
    let roomGuardInstalled = false
    /** 幕僚没写模型时各执行器的默认（chief_staff list 与讨论成员身份共用）。 */
    const modelDefaults = (): ModelDefaults => {
      let liaison
      try { liaison = liaisonSelection(settings.get(), ctx.get('agentDefaultModel')?.currentSelection()) } catch { liaison = undefined }
      return { ...liaison ? { liaison } : {}, liaisonPinned: !!settings.get().liaisonModel, ...opts.codex?.model ? { codexModel: opts.codex.model } : {} }
    }
    const rooms = new NativeRooms(ctx, root, () => brain.staff(), () => roomGuardInstalled, {
      links: () => {
        const links = new Map<string, string[]>()
        for (const ticket of store.tickets()) for (const eventId of ticket.events) {
          const room = store.event(eventId)?.meta?.room_id
          if (typeof room !== 'string') continue
          const ids = links.get(room) ?? []
          if (!ids.includes(ticket.id)) ids.push(ticket.id)
          links.set(room, ids)
        }
        return links
      },
      thread: id => ticketThread(engine, brain, id),
      executionTicket: (roomId, source) => store.tickets().find(ticket => {
        const meta = store.event(ticket.mandate.eventId)?.meta
        return (meta?.channel === 'room-review' || meta?.channel === 'superhub') && meta.room_id === roomId && meta.room_source === source
      })?.id,
    }, modelDefaults, staffStore, nativeExperience, (id, orderId) => {
      if (workspaceArchived(workspaceStore.workspace(id))) return false
      return !orderId || !orderEnded(workspaceStore.delegation(id, orderId))
    })
    const offRoomCreated = ctx.on?.('agent/created', ({ agent }) => rooms.attachContext(agent))
    if (offRoomCreated) releases.push(offRoomCreated)
    const offNativeExperience = ctx.on?.('agent/pre-step', async ({agent}, next) => {
      const selected = isLiaison(agent.id) || !!rooms.roomIdForAgent(agent)
      const decision = await next()
      return selected ? nativeExperience.step(agent.id, decision, !agent.ctx?.systemPrompt?.context) : decision
    })
    if (offNativeExperience) releases.push(offNativeExperience)
    const connectors = new Connectors(join(chiefHome, createHash('sha256').update(root).digest('hex').slice(0, 20), 'connectors'))
    releases.push(() => rooms.dispose())
    const requestRoomExecution = roomExecution({ rooms, superhub, engine, ticket: id => store.ticket(id), outbox,
      available: executor => executors.available(executor, true) })
    const roomGuard = ctx.tools.guard?.(execution => {
      const candidate = execution.agent?.id ? ctx.agents.get(execution.agent.id) as unknown as Agent | undefined : undefined
      const membership = candidate && ctx.get('agentTeams')?.tryMembership(candidate)
      const parent = execution.agent?.id ? ctx.agents.get(execution.agent.id)?.session.header.parentSession : undefined
      const scoped = [membership?.root.id, execution.agent?.id, parent].some(id => rooms.containsSession(id))
      if (!scoped) return undefined
      if (!membership || !ctx.get('agentTeams')?.listMembers(membership.root).some(m => m.id === execution.agent?.id && m.status !== 'failed')) return '原生讨论身份已失效，请由主人重新授权。'
      const externalSpawn = execution.name === 'spawn_teammate' && ['codex', 'claude-code'].includes(String((execution.arguments as { provider?: unknown } | undefined)?.provider ?? ''))
      // Codex、Claude Code、远程幕僚只能经工单在自己的执行器上运行：讨论成员不能以他的名字冒充。
      const impersonated = execution.name === 'spawn_teammate' ? staffForMember(brain.staff(), String((execution.arguments as { name?: unknown } | undefined)?.name ?? '')) : undefined
      if (impersonated && executorOnly(impersonated)) {
        return `${impersonated.name}（${impersonated.id}）的执行器是 ${impersonated.executor}，只能经工单在那个执行器上运行，讨论成员不能代他回答，未拉起。请在讨论里如实说明他的配置（执行器 ${impersonated.executor}${impersonated.model ? `，模型 ${impersonated.model}` : ''}）；主人要他本人回答时，用 chief_room_note 的 request_execution 交给他一张只读工单。`
      }
      if (roomTools.has(execution.name) && !externalSpawn) return undefined
      if (execution.callId && (externalSpawn || ROOM_EXECUTION_TOOLS.has(execution.name))) {
        const roomId = rooms.roomIdForAgent(candidate!)
        if (roomId) {
          const action = rooms.executionBlocked(roomId, membership.root)
          const detail = action.ticketId ? `已关联正式工单 ${action.ticketId}，请查看该工单状态。` : '已在接口人私聊和等你决定登记待办。请让讨论接口人用 chief_room_note request_execution 提交正式工单，等待主人批准。'
          return `本讨论仅开放原生团队协作、公开检索、获准连接器，以及只读的 chief_ticket（view）、chief_brief、chief_lookup。${detail}`
        }
      }
      return '本讨论仅开放原生团队协作、公开检索、获准连接器，以及只读的 chief_ticket（view）、chief_brief、chief_lookup。实际执行需经主人授权工单。'
    })
    if (roomGuard) { roomGuardInstalled = true; releases.push(roomGuard) }
    else engine.report('幕僚室的调用守卫未启用，请修复后再创建讨论')
    const approvalTarget = (binding: { ticketId: string; assignmentId: string }, codex = false) => {
      const ticket = store.ticket(binding.ticketId)
      const assignment = ticket && latestAssignment(ticket)
      if (!ticket || ticket.ended || assignment?.id !== binding.assignmentId || assignment.state !== 'running' || assignment.executor === 'remote') return
      if (codex && (assignment.executor !== 'codex' || ctx.get('approval')?.config.policy === 'never')) return
      return { ticket: ticket.id, assignmentId: assignment.id, title: ticket.title, staff: assignment.role?.name ?? assignment.staff, staffId: assignment.staff, consolidation: !!ticket.executionPlan }
    }
    const approvals = commandApprovals(ctx, agentId => {
      const binding = executors.binding(agentId)
      if (binding?.canAsk && !executors.readOnly(agentId)) return approvalTarget(binding)
    }, {
      timeoutMinutes: opts.approvalTimeoutMinutes,
      // Ask the owner where they already look: the liaison reminders and the optional push channel.
      onRequest: row => {
        if (row.workspace) {
          // A coding session of a workspace: decided on its SuperHub work order, not on a native ticket.
          const until = row.expiresAt ? slotKey(new Date(row.expiresAt), timeZone).slice(11) + ' 前' : ''
          outbox.enqueue(`workspace-approval:${row.ticket}:${row.id}`, `命令待批准：${row.staff}在「${row.title}」申请运行 ${commandSummary(row.command, 120)}（${row.reason}）。`
            + `${until}未处理会过期，命令不会执行。请在 SuperHub 打开这张工单批准或拒绝。`, new Date(), undefined,
            row.workspace.orderId ? { order: { workspaceId: row.workspace.workspaceId, orderId: row.workspace.orderId } } : {})
          return
        }
        const { key, text } = approvalNotice(row, row.expiresAt ? slotKey(new Date(row.expiresAt), timeZone).slice(11) : undefined)
        outbox.enqueue(key, text, new Date(), row.ticket, row.assignmentId ? { assignmentId: row.assignmentId } : {})
      },
      audit: (binding, id, status, detail) => {
        void engine.recordCommandApproval(binding, id, status, detail).catch(error => ctx.logger.warn('工单 %s 的命令审批记录写入失败：%s', binding.ticketId, String(error)))
      },
    })
    approvalPending = id => approvals.list().some(row => row.id === id)
    releases.push(approvals.dispose)
    const bundledHook = fileURLToPath(new URL('./coding-gate-hook.js', import.meta.url))
    const gate = new CodingGate({ scope: brainScope, socketDir: join(chiefHome, 'run'), approvals, logger: ctx.logger,
      hookScript: existsSync(bundledHook) ? bundledHook : join(pluginRoot, 'lib', 'coding-gate-hook.js'),
      order: (workspaceId, orderId) => {
        const order = workspaceStore.delegation(workspaceId, orderId)
        let original: string | undefined
        try { original = order.hasOriginal ? workspaceStore.orderOriginal(workspaceId, orderId).text : undefined } catch { original = undefined }
        return { permission: order.permission, title: order.title, promise: order.promise, ...original ? { original } : {} }
      },
      review: llmReviewer(() => ctx.get('llm'), () => {
        try { return liaisonSelection(settings.get(), ctx.get('agentDefaultModel')?.currentSelection()) } catch { return undefined }
      }) })
    try { await gate.start() }
    catch (error) { engine.report(`SuperHub 命令把关服务未启动，编程会话的高危命令将一律拒绝：${(error as Error).message}`) }
    workspaceApproval = id => gate.status(id)
    releases.push(() => gate.dispose())
    if (opts.codex) {
      try {
        if (!opts.patchPath) throw Error('找不到当前 DSH profile')
        executors.codexApprovals = await registerCodexApprovals(ctx, opts.codex, opts.patchPath, binding => approvalTarget(binding, true), approvals,
          (binding, id, status, detail) => engine.recordCommandApproval(binding, id, status, detail))
        releases.push(executors.codexApprovals.dispose)
      } catch (error) {
        engine.report(`Codex 单次命令审批未启用：${(error as Error).message}`)
      }
    }
    const worklines = new Worklines(engine, brain, roster)
    const discussions = new Discussions(engine, brain, executors, remote)
    const deps = { rooms, requestRoomExecution, connectors, discussions, worklines, engine, brain, brainScope, remote, roster, available, clock, sources, push: () => notifier() !== undefined }
    const custom = new CustomStore(root, (message, paths) => brain.commit(message, { paths }))
    const ui = {
      dev,
      custom,
      request: (request: string) => {
        if (!dev) throw new Error('改源码只在从 git 源码安装时可用；先看看界面定制（chief_ui set）能不能满足')
        return engine.commission({
          text: `主人要改作战台界面：${request}`, title: `改界面：${request.replace(/\s+/g, ' ').slice(0, 24)}`, staff: UI_STAFF, level: 'write' as const, workspace: pluginRoot,
          scope: `按主人的要求修改作战台界面：${request}。只改 src/client/、src/mobile/ 下的文件，不碰引擎和服务端代码。`,
          doneWhen: ['改动满足主人的要求，并且只涉及界面文件', '在仓库根目录运行 node scripts/deploy.mjs --check 通过（类型检查、测试、改动范围）', '汇报里用一两句话写清改了哪里、看起来会是什么样'],
          needsReview: false, priority: 3,
        })
      },
      rollback: () => startDeploy(['--rollback']),
      status: () => ({ build: typeof __BUILD__ === 'string' ? __BUILD__ : 'dev', dev, deploying, recent: deploys().slice(-5).map(({ ok, title, detail, at }) => ({ ok, title, detail, at })) }),
    }
    const profileImports = createProfileImportService({ root, scope: brainScope, goals, committed: commitPaths,
      organize: llmProfileOrganizer(() => ctx.get('llm'), () => modelDefaults().liaison),
    })
    releases.push(() => profileImports.dispose())
    const importer = { prompt: IMPORT_PROMPT, submit: profileImports.submit }
    /** 反哺：把主人确认过的内容整理成别的系统能用的形式（见 src/core/export.ts）。 */
    const cliEnv = process.env.DSH_HOME ? `DSH_HOME=${process.env.DSH_HOME} ` : ''
    const cli = `${cliEnv}${process.execPath} ${join(pluginRoot, 'bin', 'cli.mjs')}`
    const exporter = {
      build: (target: ExportTarget) => ({
        ...buildExport(target, { me: brainDocument('me.md'), agents: brainDocument('AGENTS.md'), goals: brain.goals() }, clock().today),
        // 本机的 Claude Code / Codex 可以自动同步：给出这台机器上能直接用的命令
        commands: {
          session: `${cli} export --for session`,
          claudeMd: `${cli} export --for agents-md --write ~/.claude/CLAUDE.md`,
          codexMd: `${cli} export --for agents-md --write ~/.codex/AGENTS.md`,
        },
      }),
    }
    const calendarRoutes = workspaceCalendarRoutes({root,scope:brainScope,timeZone,roster,workspaces:workspaceStore,tools:ctx.tools})
    releases.push(() => calendarRoutes.dispose())
    const historyRoutes = workspaceHistoryRoutes({brain,rooms,roster,goals,scope:brainScope})
    releases.push(() => historyRoutes.dispose())
    const dialogue = createV2DialogueSource({ ctx, root, scope: brainScope, codex: opts.codex, gate, internalDirectories: [chiefHome], experience,
      onCodingResult(result) {
        const {workspaceId, sessionId, orderId, turnId} = result
        const original = dialogue.experienceSource?.(workspaceStore.session(workspaceId, sessionId), turnId)
        if (!original) return
        const staffId = original.staffId
        const where = {workspaceId, sessionId, orderId, staffId}
        const commands = result.commands.slice(-8)
        const messages = result.messages.filter(item => item.text.trim()).reverse().slice(0, Math.min(6, 8 - commands.length)).reverse()
        const evidence: ExperienceEvidence[] = messages.map(message => ({
          kind: 'delivery', id: message.id, messageId: message.id, ...where}))
        for (const command of commands) evidence.push(commandExperienceEvidence({...where, turnId}, command.itemId, command))
        const summary = result.messages.map(message => message.text).join('\n').trim().slice(-8000) ||
          evidence.flatMap(item => item.quote ? [item.quote] : []).join('\n').slice(-8000)
        if (summary && evidence.length) void learning.settle({id: 'coding-evidence:' + sessionId + ':' + turnId, ...where, turnId, sourceExperienceRefs: original.refs,
          kind: result.recovered ? 'recovery' : 'delivery', summary,
          evidence}).catch(learningProblem)
      }, staff:{
      context:(workspace,id)=>staffStore.context(workspace,id), current:context=>staffStore.assertCurrent(context),
      used:(context,order)=>staffStore.markUsed(context,order),
      propose(context,orderId,requestId,text,selection) {
        staffStore.assertCurrent(context)
        if (selection) staffStore.assertExperienceCurrent(selection)
        staffStore.apply(context.workspaceId,{action:'learn',staffId:context.staffId,orderId,text,proposed:true,witnessedToken:context.token,
          requestId:createHash('sha256').update(JSON.stringify(['staff-suggestion',orderId,requestId])).digest('hex')})
      },
      model(id) {
        const native = brain.staff().find(s=>s.id===id)
        return native?.executor === 'dsh' ? teammateSelection(native,modelDefaults()) : modelDefaults().liaison
      },
    } })
    releases.push(() => dialogue.dispose())
    workspaceStore.restoreAssignmentBriefs(() => superhub.receipts().filter(row => row.source.channel === 'owner' || row.source.channel === 'chat').map(row => row.source),
      (session,turnId,orderId) => {
        try { return dialogue.briefEvidence?.(session,turnId,orderId) ?? {} }
        catch { return {} } // A missing native archive can still be restored from its accepted owner RPC.
      })
    // Workspace group chats: one DSH member runner (the liaison and DSH staff, gated like coding turns) and one runner per
    // coding tool, with the executable, model and subprocess setup of the coding sessions.
    const dshMembers = new DshMemberRunner(ctx, { scope: brainScope, gate, logger: ctx.logger, inputAttachments })
    releases.push(() => dshMembers.dispose())
    const codingMembers = (tool: 'codex' | 'claude-code') => new CodingMemberRunner({ tool, subprocess: () => ctx.get('subprocess'), gate, logger: ctx.logger, inputAttachments,
      executable: () => executable(tool === 'codex' ? opts.codex?.executable || 'codex' : 'claude'), ...tool === 'codex' && opts.codex?.model && { model: opts.codex.model } })
    const codexMembers = codingMembers('codex'), claudeMembers = codingMembers('claude-code')
    releases.push(() => codexMembers.dispose(), () => claudeMembers.dispose())
    const groupHost = new WorkspaceGroupHost({ root: realpathSync(root), scope: brainScope, store: workspaceStore, approvals: gate, logger: ctx.logger, experience,
      runners: { dsh: dshMembers, codex: codexMembers, 'claude-code': claudeMembers },
      roster: workspaceId => groupRoster({ workspaceId, staff: staffStore.view(workspaceId).members, native: brain.staff(), defaults: modelDefaults(),
        context: id => staffStore.context(workspaceId, id), liaisonName: LIAISON_AUTHOR }) })
    releases.push(() => groupHost.dispose())
    const v2Routes = workspaceV2Routes({ staff:staffStore, store: workspaceStore, source: dialogue, timeZone, approvals: gate, groups: groupHost, inputAttachments, learning, learningProblem,
      coordinate: llmEngagementCoordinator(() => ctx.get('llm'), liaisonModel),
      // The liaison reviews new results with its own model, and reminds the owner when an order still falls short.
      review: llmAcceptanceReviewer(() => ctx.get('llm'), liaisonModel),
      // It also reads the owner's short words about an order itself (可以收单) before they go to the executor.
      judge: llmCommandJudge(() => ctx.get('llm'), liaisonModel),
      remind: (key, text, order, options) => { outbox.enqueue(key, text, new Date(), undefined, { ...order && { order }, ...options?.localOnly && { localOnly: true } }) } })
    releases.push(() => v2Routes.dispose())
    v2Routes.recover()
    releases.push(...registerTools(ctx, { ...deps, calendarWeek: day => calendarRoutes.week(day), personDetail:historyRoutes.personDetail, isLiaison, lookup, readOnlyExecution: (id: string) => executors.readOnly(id), executionBinding: (id: string) => executors.binding(id), schedules: { store: schedules, timeZone }, ui, control: opts.control, importer, exporter, superhub, modelDefaults, workspaceStore, staffStore, learning, assign: v2Routes.assign, follow: v2Routes.follow, orderFollowup: v2Routes.followup, groups: groupHost, inputAttachments }))
    for (const agent of ctx.agents.list?.() ?? []) rooms.attachContext(agent)
    const legacyRoutes = runtimeRoutes({ ...deps, approvals, chat, liaisonSeen, custom, exporter, superhub, inputAttachments, llm: () => ctx.get('llm') })
    const workspaceRoutes = superhubWorkspaceRoutes({ scope: brainScope, engine, brain, trace, superhub, goals, saa, rooms, commands: () => approvals.list() })
    const scheduleRunner = new ScheduleRunner({ store: schedules, outbox, timeZone, warn: message => ctx.logger.warn('%s', message),
      produce: scheduleProducer({ timeZone, workspaces: workspaceStore, learning, llm: () => ctx.get('llm'), model: liaisonModel, calendarWeek: day => calendarRoutes.week(day) }) })
    /** 安静时段（22:30 到 8:00，按设置的时区）不推送，攒到早上。 */
    const quietAt = (instant: Date) => { const hhmm = slotKey(instant, timeZone).slice(11); return hhmm >= '22:30' || hhmm < '08:00' }
    const schedulesRoute = scheduleRoutes({ scope: brainScope, timeZone, store: schedules, push: () => notifier() !== undefined,
      // 验收专用的拨钟入口：只有以 CHIEF_ACCEPTANCE_SCHEDULE_CLOCK=1 启动的隔离宿主才有（scripts/schedules-ui-regression.mjs）。
      ...process.env.CHIEF_ACCEPTANCE_SCHEDULE_CLOCK === '1' && { debugTick: async (now: Date) => {
        await scheduleRunner.tick(now)
        const failure = await outbox.dispatch(notifier(), quietAt(now))
        if (failure) throw Error(failure)
      } } })
    const routes: Route = async (call, res) => {
      if (call.seg[0] === 'input-attachments') return inputAttachments.route(call, res)
      if (call.seg[0] === 'v2' && call.seg[1] === 'schedules') return schedulesRoute(call, res)
      if (call.seg[0] === 'v2' && (call.seg[1] === 'calendar' || call.seg[1] === 'connections')) return calendarRoutes(call,res)
      if (call.seg[0] === 'v2' && (call.seg[1] === 'history' || call.seg[1] === 'people')) return historyRoutes(call, res)
      if (call.seg[0] === 'v2' && call.seg[1] === 'profile') return profileImports.route(call, res)
      if (call.seg[0] === 'v2') return v2Routes(call, res)
      return await workspaceRoutes(call, res) || legacyRoutes(call, res)
    }

    /** 会议开始前 12 小时内，自动开一张准备材料的工单（每场会议只触发一次）。 */
    const prepMeetings = async () => {
      const mode = modeOf('meeting-prep')
      if (mode === 'off') return
      const { now } = clock()
      for (const m of roster.meetings()) {
        const hours = (Date.parse(m.at) - Date.parse(now)) / 3_600_000
        if (hours < 0 || hours > MEETING_PREP_HOURS) continue
        await engine.receive({
          source: 'clock', dedupe: `meeting:${m.id}:prep`, meta: { meeting: m.id, purpose: 'prep', rule: 'meeting-prep' }, observe: mode === 'observe',
          text: `会议准备：「${m.title}」，时间 ${m.at.replace('T', ' ')}${m.with.length ? `，参与者：${m.with.join('、')}` : ''}${m.line ? `，横向线：${m.line}` : ''}。`
            + '交给谋士：用 chief_lookup 读参与者的人物卡、相关横向线和未结承诺，写一份一页的准备材料 prep.md：每位参与者现在关心什么、上次聊到哪、我欠对方和对方欠我的、这场会我要拿到什么、建议的开场和要问的问题。不需要主人验收。',
        })
      }
    }

    /**
     * 花名册驱动的两个来源。去重键里带上日期，所以同一件事只触发一次：
     * 承诺逾期按"承诺 + 约定日期"，该联系了按"人 + 最近接触日期"（联系过之后会重新计时）。
     */
    const rosterSources = async () => {
      const { today } = clock()
      const dueMode = modeOf('commitment-due'), staleMode = modeOf('stale-contact')
      if (dueMode !== 'off') for (const c of roster.ledger()) {
        if (c.status !== 'open' || c.direction !== 'theirs' || !c.due || c.due >= today) continue
        await engine.receive({
          source: 'clock', dedupe: `due:${c.id}:${c.due}`, meta: { rule: 'commitment-due', commitment: c.id }, observe: dueMode === 'observe',
          text: `承诺逾期：${c.who} 答应的「${c.what}」约定 ${c.due}，还没有给到${c.line ? `（横向线：${c.line}）` : ''}。交给谋士：读 ${c.who} 的人物卡，起草一条催办消息，写一个轻提醒和一个明确要时间点的版本。只起草不发送，需要主人验收。`,
        })
      }
      if (staleMode !== 'off') for (const p of roster.people()) {
        if (p.influence !== 'high') continue
        const days = p.lastContact ? Math.round((Date.parse(today) - Date.parse(p.lastContact)) / 86_400_000) : undefined
        if (days !== undefined && days <= 14) continue
        await engine.receive({
          source: 'clock', dedupe: `stale:${p.id}:${p.lastContact ?? 'never'}`, meta: { rule: 'stale-contact', person: p.id }, observe: staleMode === 'observe',
          text: `该联系了：${p.name}（影响力高）${days === undefined ? '还没有任何互动记录' : `已经 ${days} 天没有联系`}。交给谋士：读人物卡和相关横向线，给出一个自然的联系由头和一句开场白，不需要主人验收。`,
        })
      }
    }

    /**
     * 发件箱：待主人决定、工作结果、每天早上一条态势及研判失败的事。
     * 每类都有稳定的 key，同一件事只说一次。安静时段（22:30 到 8:00）不推送，攒到早上。
     */
    const notify = async () => {
      const state = warroomState(deps)
      const now = new Date(), { now: local, today } = clock()
      for (const c of state.you) {
        const detail = (c.latest?.question ?? c.latest?.summary ?? c.scope).split('\n')[0]!.slice(0, 120)
        const ticket = store.ticket(c.id), last = ticket && latestAssignment(ticket)
        const delivery = c.stage === 'you/review' && ticket ? resultDelivery(root, ticket) : undefined
        outbox.enqueue(`need:${c.id}:${c.stage}:${c.rounds}`, `${stageLabel(c.stage)}：${c.title}（${c.id}）。${detail}`, now, c.id,
          { ...last ? { assignmentId: last.id } : {}, ...delivery ? { delivery } : {} })
      }
      // Recover recent missed completions without announcing the entire historical archive on upgrade.
      for (const c of state.ended) {
        const finished = Date.parse(c.ended?.at ?? '')
        if (!Number.isFinite(finished) || finished < now.valueOf() - 24 * 3600_000 || finished > now.valueOf()) continue
        const ticket = store.ticket(c.id)
        if (ticket) enqueueResultNotice(outbox, root, brainScope, ticket, now)
      }
      for (const e of state.stuck) outbox.enqueue(`stuck:${e.id}`, `有件事没能分派出去，需要你看一眼：${e.text.slice(0, 80)}`, now)
      const hhmm = local.slice(11)
      const s = state.poc.situation
      if (hhmm >= '08:30' && hhmm < '12:00' && (s.overdue || s.dueToday || s.blocked || s.meetingsToday)) {
        const mine = state.poc.ledger.filter(c => c.direction === 'mine' && (c.dueState === 'today' || c.dueState === 'overdue')).slice(0, 3).map(c => `你答应${c.who}的「${c.what}」`)
        outbox.enqueue(`morning:${today}`, `早上好。${situationText({ ...s, decide: 0, stale: 0 })}${mine.length ? `到期的有：${mine.join('、')}。` : ''}`, now)
      }
      // 部署结果：每次部署说一次
      if (dev) for (const d of deploys().slice(-10)) outbox.enqueue(`deploy:${d.id}`, d.ok ? `界面已更新：${d.title}。打开着的作战台会自动刷新；不满意跟接口人说"撤销"。` : `界面修改没有上线（${d.title}）：${d.detail.split('\n')[0]}`, now, d.ticket)
      const failure = await outbox.dispatch(notifier(), quietAt(now))
      if (failure) ctx.logger.warn('%s', failure)
    }

    const tick = () => {
      void scheduleRunner.tick().catch(e => ctx.logger.warn('定时安排检查失败：%s', String(e)))
      void v2Routes.followup.tick().catch(e => ctx.logger.warn('工单周报检查失败：%s', String(e)))
      try { v2Routes.notices.collect() } catch (error) { ctx.logger.warn('工单交付提醒待重试：%s', String(error)) }
      void engine.sweepRemote().catch(e => ctx.logger.warn('工作电脑超时检查失败：%s', String(e)))
      void prepMeetings().catch(e => ctx.logger.warn('会议准备检查失败：%s', String(e)))
      void rosterSources().catch(e => ctx.logger.warn('花名册来源检查失败：%s', String(e)))
      void notify().catch(e => ctx.logger.warn('发件箱处理失败：%s', String(e)))
    }
    stopEngine = () => engine.stop()
    await superhub.resume(error => engine.report(`恢复 SuperHub 交办失败：${(error as Error).message}`))
    await engine.recover()
    // 定时器在恢复成功之后才开：恢复失败时不能留下一个没人管的引擎继续跑
    const clockTimer = setInterval(tick, CLOCK_INTERVAL)
    const remotePoll = setInterval(() => {
      void remote.drain(async r => (await discussions.remoteReport(r.ticketId, r.assignmentId, r.report)) ?? engine.remoteReport(r.ticketId, r.assignmentId, r.report), m => ctx.logger.warn('%s', m))
        .catch(e => ctx.logger.warn('读取工作电脑回传失败：%s', String(e)))
    }, REMOTE_INTERVAL)
    void hq().then(agent => hasRawConnectorHistory(agent.session?.toolHistory?.()) ? maybeRotate() : undefined)
      .catch(e => ctx.logger.warn('接口人会话初始化失败：%s', String(e)))
    // 热重载只处理已经加载的旧段，避免为诊断把全部历史上下文都加载进内存。
    // Agents.get 的实际返回值是存活 Agent；ports 只声明了其他调用处需要的祖先头信息。
    for (const id of earlier()) {
      const loaded = ctx.agents.get(id) as unknown as Agent | undefined
      if (loaded?.id === id) toolVisibility.attach(loaded)
    }
    tick()
    ctx.logger.info('SuperHub 就绪：第二大脑 %s%s', root, dev ? '（开发模式）' : '')

    let disposed = false
    return {
      root,
      scope: brainScope,
      routes,
      // 待审批命令只进主人自己的视图（电脑端宿主连接），和 /settings/approvals 的可见范围一致。
      state: (owner = true, commands = owner) => ({ ...warroomState(owner ? { ...deps, ...commands ? { commands: () => approvals.list() } : {} } : { ...deps, brainScope: undefined }), custom: custom.get(), dev,
        ...owner ? { superhubScope: brainScope } : {} }),
      liaisonToolStatus: () => toolVisibility.status(guarded, requestAudit),
      settingsStaff: () => brain.staff().map(({id, name, executor, brief}) => ({id, name, executor, brief})),
      settingsLiaisonModel: () => {
        const model = modelDefaults().liaison
        return model && model.provider + '/' + model.model
      },
      dispose: async () => {
        if (disposed) return
        disposed = true
        clearInterval(clockTimer)
        clearInterval(remotePoll)
        engine.stop()
        discussions.dispose()
        for (const release of releases.splice(0).reverse()) { try { release() } catch { /* 释放失败不影响其他 */ } }
        try { await brain.flush() } finally { releaseLock() }
      },
    }
  } catch (error) {
    try { stopEngine?.() } catch { /* 忽略 */ }
    for (const release of releases.splice(0).reverse()) { try { release() } catch { /* 忽略 */ } }
    releaseLock()
    throw error
  }
}
