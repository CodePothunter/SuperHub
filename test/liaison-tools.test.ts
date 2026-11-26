/**
 * 接口人工具的出口契约与方案 A 授权（2026-11-19 实测原话回归）。
 * 工具都经 registerTools 的注册包装调用，返回值按 DSH 工具管道的无损 JSON 规则检查。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Executors } from '../src/core/engine.ts'
import type { Staff } from '../src/core/model.ts'
import { FileStore } from '../src/core/store.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { Connectors } from '../src/dsh/connectors.ts'
import { CustomStore } from '../src/dsh/custom-store.ts'
import { jsonSafe, losslessViolations } from '../src/dsh/json-safe.ts'
import type { Agent, HostContext, SessionEventLike, Tools } from '../src/dsh/ports.ts'
import { FileRemoteQueue } from '../src/dsh/remote.ts'
import { roomExecution } from '../src/dsh/room-execution.ts'
import { inTurnOwnerMessages, NativeRooms, roomTools } from '../src/dsh/rooms.ts'
import { Roster } from '../src/dsh/roster.ts'
import { publicSettings, type Settings } from '../src/dsh/settings.ts'
import { SuperhubIntake } from '../src/dsh/superhub.ts'
import { registerTools } from '../src/dsh/tools.ts'
import { workspaceHistoryRoutes } from '../src/dsh/workspace-history.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'
import { WorkspaceStaffStore } from '../src/dsh/workspace-staff-store.ts'
import { workspaceV2Routes } from '../src/dsh/workspace-v2.ts'
import { WorkspaceGroupHost } from '../src/dsh/workspace-group-host.ts'
import { groupRoster } from '../src/dsh/workspace-group-members.ts'
import { workspaceArchived, type V2Message, type V2Workspace } from '../src/core/workspace-v2.ts'
import { ScheduleStore } from '../src/dsh/schedules.ts'
import { liaisonSurfaceContext } from '../src/core/workspace-product.ts'
import { briefText } from '../src/dsh/view.ts'

type Definition = Parameters<Tools['register']>[0]
const cleanup: (() => void)[] = []
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose() })

const scope = 'brain-liaison'
const role = (id: string, executor = 'dsh'): Staff => ({ id, name: id, executor, verifier: 'none', brief: '本地处理' })
const staff: Staff[] = [role('chief'), role('researcher'), { ...role('strategist'), name: '谋士', model: 'zhipu/glm-5.3', reasoningEffort: 'high' }, { ...role('engineer', 'codex'), name: '工程师' }, role('ui-smith'), { ...role('liaison', 'remote'), name: '外务' }]
const defaults = { liaison: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }, liaisonPinned: false, codexModel: 'gpt-6.2-sol' }
const settings: Settings = { timeZone: 'Asia/Shanghai', concurrency: 2, mobile: { enabled: false, port: 8787, host: '0.0.0.0' } }

/** 周三上午 10 点（上海）：定时安排的回执按这个时刻算下一次。 */
const SCHEDULE_NOW = new Date('2026-11-25T02:00:00Z')

function host(options: { groups?: boolean; push?: boolean; llm?: unknown } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'chief-liaison-tools-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'brain')
  mkdirSync(root)
  const brain = new BrainRepo(root)
  vi.spyOn(brain, 'staff').mockReturnValue(staff)
  vi.spyOn(brain, 'commit').mockImplementation(() => {})
  const store = new FileStore(root)
  const executors: Executors = { available: () => true, supportsSchema: () => true, run: vi.fn(async () => ({ text: '', stopReason: 'completed' as const })) }
  let intake: SuperhubIntake | undefined
  const engine = new Engine(store, brain, executors, { dispatch() {}, cancel() {} }, {
    concurrency: 1, timeZone: 'UTC', brainScope: scope, canStartSuperhub: auth => intake?.allowsCommand(auth) === true,
  })
  engine.setPaused(true)
  cleanup.push(() => engine.stop())
  intake = new SuperhubIntake({ root, chiefHome: join(directory, 'home'), brainScope: scope, engine, staff: () => staff })
  const superhub = intake

  // 原生宿主：讨论会话、团队成员与消息。prompt 把主人消息写成带 rpcId 的 user/message。
  const agents = new Map<string, Agent & { events: SessionEventLike[] }>()
  const nativeAgent = (id: string) => {
    const events: SessionEventLike[] = []
    return { id, events, session: { snapshotEvents: () => events, header: {} } } as unknown as Agent & { events: SessionEventLike[] }
  }
  const leads = new Set<string>()
  /** 讨论成员：会话 id → 所在讨论的根会话与成员名（spawn_teammate 的 name）。 */
  const teammates = new Map<string, { root: string; name: string }>()
  const teams = {
    tryMembership: (agent: { id: string }) => leads.has(agent.id) ? { role: 'lead', name: 'lead', root: { id: agent.id } }
      : teammates.has(agent.id) ? { role: 'teammate', name: teammates.get(agent.id)!.name, root: { id: teammates.get(agent.id)!.root } } : undefined,
    listMembers: (lead: { id: string }) => [{ id: lead.id, name: 'lead', role: 'lead', status: 'idle' }],
    listTasks: () => [],
    interrupt: () => {},
  }
  const sessionQuery = {
    observeSession: async (id: string) => ({ events: [...agents.get(id)?.events ?? []], [Symbol.dispose]: () => {} }),
  }
  const registered = new Map<string, Definition>()
  const admissions = new Map<string, NonNullable<Parameters<Tools['register']>[1]>>()
  const ctx = {
    get: (name: string) => name === 'agentTeams' ? teams : name === 'sessionQuery' ? sessionQuery : name === 'llm' ? options.llm : undefined,
    workspaceRegistry: { create: async () => ({ id: 'workspace' }) },
    sessionController: {
      resolveAgent: async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }: { sessionId: string }) => { agents.set(sessionId, nativeAgent(sessionId)); leads.add(sessionId) },
      prompt: async (input: { requestId: string; sessionId: string; content: { type: string; text: string }[] }) => {
        const agent = agents.get(input.sessionId)!
        agent.events.push({ type: 'user/message', seq: agent.events.length + 1, time: Date.now(),
          data: { id: `m-${agent.events.length + 1}`, source: { kind: 'user', rpcId: input.requestId }, content: input.content } })
        return {}
      },
    },
    tools: { register: (definition: Definition, options?: Parameters<Tools['register']>[1]) => {
      registered.set(definition.name, definition)
      if (options) admissions.set(definition.name, options)
      return () => {}
    } },
  } as unknown as HostContext
  const rooms = new NativeRooms(ctx, root, () => staff, () => true, {
    links: () => new Map(), thread: () => undefined, executionTicket: () => undefined,
  } as never, () => defaults)
  cleanup.push(() => rooms.dispose())
  const roster = new Roster(root, brain, () => '2026-11-19')
  const history = workspaceHistoryRoutes({scope,brain,rooms,roster,goals:{list:() => []}})
  cleanup.push(() => history.dispose())
  const workspaceStore = new WorkspaceV2Store(root, scope, undefined, { rosterGroups: options.groups === true })
  const staffStore = new WorkspaceStaffStore(root,scope,()=>brain.staff(),id=>workspaceStore.workspace(id),undefined,id=>workspaceArchived(workspaceStore.workspace(id)))
  const messages = new Map<string,V2Message[]>()
  const memberCalls: string[] = []
  const quiet = { run: async (call: { member: { id: string } }) => { memberCalls.push(call.member.id) }, continue: async () => {}, cancel: () => {}, reattach: async () => false, dispose: () => {} }
  const groups = options.groups ? new WorkspaceGroupHost({ root: realpathSync(root), scope, store: workspaceStore, runners: { dsh: quiet as never, codex: quiet as never },
    roster: workspaceId => groupRoster({ workspaceId, staff: staffStore.view(workspaceId).members, native: staff, defaults }) }) : undefined
  const workspaceRoutes = workspaceV2Routes({store:workspaceStore, staff:staffStore, ...(groups && {groups}), source:{
    read:async session => ({messages:messages.get(session.id) ?? []}),
    send:async () => {}, attachment:async () => undefined,
  }})
  cleanup.push(() => { workspaceRoutes.dispose(); groups?.dispose() })
  const outbox = { enqueue: vi.fn() }
  const schedules = new ScheduleStore(root, { timeZone: 'Asia/Shanghai', now: () => SCHEDULE_NOW })
  const requestRoomExecution = roomExecution({ rooms, superhub, engine, ticket: id => store.ticket(id), outbox: outbox as never, available: () => true })
  vi.spyOn(engine, 'delegate').mockResolvedValue('T-0099')
  const submitImport = vi.fn(async (_text: string, _source: string, requestId: string) => ({
    scope, status: 'organizing' as const, importId: 'profile-' + createHash('sha256').update(requestId).digest('hex'),
  }))
  registerTools(ctx, {
    engine, brain, brainScope: scope, roster, rooms, requestRoomExecution, remote: new FileRemoteQueue(root), connectors: new Connectors(join(directory, 'connectors')),
    available: () => true, clock: () => ({ today: '2026-11-19', now: '2026-11-19T17:33' }), push: () => options.push === true,
    sources: () => [{ id: 'inbox', name: '你的交办', what: '主人', mode: 'auto', fixed: true }, { id: 'stale-contact', name: '该联系了', what: '提醒', mode: 'observe', fixed: false }],
    isLiaison: (id: string) => id === 'hq', lookup: { info: () => ({ subagent: false }) },
    executionBinding: (id: string) => id === 'executor' ? { ticketId: 'T-0001', assignmentId: 'A-1' } : undefined,
    calendarWeek: async () => ({ scope,week:'2026-11-16',today:'2026-11-19',timeZone:'Asia/Shanghai',entries:[],sources:[],issues:[] }),
    personDetail: history.personDetail,
    schedules: { store: schedules, timeZone: 'Asia/Shanghai', now: () => SCHEDULE_NOW },
    ui: { dev: false, custom: new CustomStore(root), request: async () => 'T-0100', rollback: () => {}, status: () => ({ build: 'test', dev: false, deploying: false, recent: [] }) },
    // 与 src/index.ts 的 showSettings 相同：公开设置加运行信息。未设推送地址是 11-19 的原始故障。
    control: { show: () => ({ ...publicSettings(settings), dev: false, git: true, mobile: { ...publicSettings(settings).mobile, running: false, addresses: [] } }), update: async () => '已保存' },
    importer: { prompt: '把你对我的了解写出来', submit: submitImport },
    exporter: { build: () => ({ empty: true }) as never },
    superhub, workspaceStore, staffStore, ...(groups && {groups}), orderFollowup:workspaceRoutes.followup, assign:workspaceRoutes.assign, follow:workspaceRoutes.follow, modelDefaults: () => defaults,
  } as unknown as Parameters<typeof registerTools>[1])

  /** 主人本轮原话：宿主确认的人类 RPC 输入。 */
  const ownerTurn = (text: string, rpcId = `rpc-${text.length}-${text.charCodeAt(0)}`): SessionEventLike[] => [
    { type: 'turn/start', seq: 1, time: 1, data: {} },
    { type: 'user/message', seq: 2, time: 2, data: { id: `msg-${rpcId}`, source: { kind: 'user', rpcId }, content: [{ type: 'text', text }] } },
  ]
  const liaison = (events: SessionEventLike[]) => ({ agent: { id: 'hq', session: { snapshotEvents: () => events } }, signal: new AbortController().signal }) as never
  const call = (name: string, args: Record<string, unknown>, execution: never = liaison(ownerTurn('看一下简报'))) =>
    registered.get(name)!.execute(args, execution) as Promise<Record<string, unknown>>
  const leadOf = (session: string) => ({ agent: agents.get(session)!, signal: new AbortController().signal }) as never
  /** 在讨论里以主人身份发言，返回原话标识。 */
  const ownerSays = async (roomId: string, text: string) => {
    await rooms.say(roomId, `owner-${text.length}-${text.charCodeAt(0)}`, text)
    return (await rooms.view(roomId)).messages.filter(row => row.author === 'you' && row.text === text).at(-1)!.id
  }
  /** 本轮结束（turn/end）。 */
  const endTurn = (session: string) => { const agent = agents.get(session)!; agent.events.push({ type: 'turn/end', seq: agent.events.length + 1, time: Date.now(), data: {} }) }
  /** 讨论成员发来的消息（不是主人）。 */
  const memberSays = (session: string, text: string) => {
    const agent = agents.get(session)!
    agent.events.push({ type: 'user/message', seq: agent.events.length + 1, time: Date.now(), data: { id: `a-${agent.events.length + 1}`, source: { kind: 'agent-message', senderSessionId: 'member' }, content: [{ type: 'text', text }] } })
  }
  return { schedules, memberCalls, groups, root, brain, store, workspaceStore, staffStore, workspaceRoutes, messages, history, engine, intake: superhub, rooms, registered, admissions, call, liaison, ownerTurn, leadOf, ownerSays, endTurn, memberSays, requestRoomExecution, outbox, teammates, submitImport }
}

const plain = (value: unknown) => {
  expect(losslessViolations(value)).toEqual([])
  return value as Record<string, unknown>
}

it('接口人新建幕僚时保存目录中的默认造型，更新角色卡后沿用默认', async () => {
  const f = host()
  vi.mocked(f.brain.staff).mockRestore()
  const card = {action:'create',id:'training-helper',name:'培训教练',brief:'负责培训和辅导新成员，把常见问题整理成简短的练习和指引。'}
  for (const shape of ['plane','unknown']) {
    await expect(f.call('chief_staff',{...card,portrait_shape:shape})).rejects.toThrow('素材库')
  }
  expect(f.brain.staff()).toEqual([])

  const result = plain(await f.call('chief_staff',{...card,portrait_shape:'pencil'}))
  expect(result.staff).toMatchObject([{id:card.id,defaultPortrait:{shape:'pencil'}}])
  const defaultPortrait = f.brain.staff().find(member=>member.id===card.id)?.defaultPortrait
  expect(f.staffStore.view().members).toMatchObject([{id:card.id,portrait:defaultPortrait}])

  await f.call('chief_staff',{action:'update',id:card.id,name:'新人辅导员'})
  const reopened = new BrainRepo(f.root)
  expect(reopened.staff()).toMatchObject([{id:card.id,name:'新人辅导员',defaultPortrait}])
  expect(f.staffStore.view().members).toMatchObject([{id:card.id,portrait:defaultPortrait,defaultPortrait}])
})

describe('工具返回值的无损 JSON 契约', () => {
  it('与 DSH 工具管道相同的规则：省略 undefined 属性，其余非 JSON 值按路径报错', () => {
    expect(jsonSafe({ a: 1, b: undefined, c: { d: undefined, e: [1, 'x'] } }, 'demo')).toEqual({ a: 1, c: { e: [1, 'x'] } })
    expect(losslessViolations({ a: undefined })).toEqual([{ path: 'value.a', reason: 'undefined 不能表示为 JSON' }])
    const cycle: Record<string, unknown> = { name: 'loop' }
    cycle.self = cycle
    const shared = { x: 1 }
    expect(jsonSafe({ left: shared, right: shared }, 'demo')).toEqual({ left: { x: 1 }, right: { x: 1 } })
    for (const [value, path] of [
      [{ n: Number.NaN }, 'value.n'], [{ n: Infinity }, 'value.n'], [{ n: -0 }, 'value.n'], [{ at: new Date(0) }, 'value.at'],
      [{ map: new Map() }, 'value.map'], [{ list: [1, undefined] }, 'value.list[1]'], [{ big: 1n }, 'value.big'],
      [{ fn: () => 1 }, 'value.fn'], [cycle, 'value.self'], [{ 'a b': { set: new Set() } }, 'value["a b"].set'],
    ] as const) {
      expect(() => jsonSafe(value, 'demo')).toThrow(`工具 demo 返回值 ${path} 不是 JSON`)
    }
    // eslint-disable-next-line no-sparse-arrays
    expect(losslessViolations([1, , 3])).not.toEqual([])
    expect(jsonSafe('原样文本', 'demo')).toBe('原样文本')
  })

  const dshValues = process.env.DSH_VALUES_MODULE ?? ''
  it.skipIf(!existsSync(dshValues))('与已安装 DSH 的 isJsonValue 判定一致', async () => {
    const { isJsonValue } = await import(pathToFileURL(dshValues).href) as { isJsonValue: (value: unknown) => boolean }
    const cycle: unknown[] = []
    cycle.push(cycle)
    for (const value of [null, true, 'a', 1, -0, NaN, undefined, [], {}, { a: undefined }, { a: [1, { b: 'c' }] }, [undefined], new Date(0),
      new Map(), Object.create(null), Object.assign(Object.create(null), { a: 1 }), cycle, { a: 1n }, { [Symbol('s')]: 1 }].entries()) {
      expect(losslessViolations(value[1]).length === 0, `样例 ${value[0]}`).toBe(isJsonValue(value[1]))
    }
  })

  it('注册包装层省略 undefined 属性，其他非 JSON 值以工具名和路径报错', async () => {
    const f = host()
    const executor = { agent: { id: 'executor' }, signal: new AbortController().signal } as never
    vi.mocked(f.engine.delegate).mockResolvedValueOnce(undefined as never)
    expect(await f.call('chief_delegate', { key: 'k', staff: 'researcher', text: '查', criterion: 0 }, executor)).toEqual({ message: expect.any(String) })
    vi.mocked(f.engine.delegate).mockResolvedValueOnce(Number.NaN as never)
    await expect(f.call('chief_delegate', { key: 'k', staff: 'researcher', text: '查', criterion: 0 }, executor)).rejects.toThrow('工具 chief_delegate 返回值 value.ticketId 不是 JSON')
  })

  it('未设推送地址时公开设置不含 undefined', () => {
    expect(losslessViolations(publicSettings(settings))).toEqual([])
    expect(publicSettings({ ...settings, notifyUrl: 'https://hooks.example.com/t?token=x' }).notify).toBe('hooks.example.com（已配置）')
  })

  it('全部注册工具的代表性调用都返回无损 JSON；新增工具须登记代表性调用', async () => {
    const f = host()
    const room = await f.rooms.create('contract-room', '契约讨论')
    const lead = f.leadOf(room.session)
    const ownerMessage = await f.ownerSays(room.id, '请调研模型成本')
    const read = await f.call('chief_inbox', { text: '调研各幕僚的模型成本', operation: 'read' }, f.liaison(f.ownerTurn('帮我调研一下模型成本', 'contract-read')))
    const ticketId = String(read.ticketId)
    const followupOrder = f.workspaceStore.assign('read-followup-contract','整理季度档案').delegation
    const calls: Record<string, [Record<string, unknown>, never?][]> = {
      chief_calendar: [[{range:'day'}]],
      chief_order_followup: [[{action:'read',work_order_id:followupOrder.id},f.liaison(f.ownerTurn('读一下工单 ' + followupOrder.id))]],
      chief_workspace: [[{action:'list'}], [{action:'create',name:'评审'},f.liaison(f.ownerTurn('开个工作区叫评审'))]],
      chief_room: [[{ action: 'list' }], [{ action: 'read', room: room.id }]],
      chief_room_note: [[{ action: 'read' }, lead], [{ action: 'source', source: ownerMessage }, lead],
        [{ action: 'request_execution', source: ownerMessage, title: '模型成本只读调研', staff: 'researcher', operation: 'read' }, lead]],
      chief_connector: [[{ action: 'request', repository: 'owner/repo', purpose: '核对', path: 'README.md', ref: 'a'.repeat(40) }, lead]],
      chief_delegate: [[{ key: 'part-a', staff: 'researcher', text: '查一部分', criterion: 0 }, { agent: { id: 'executor' }, signal: new AbortController().signal } as never]],
      chief_inbox: [[{ text: '只记一下', operation: 'read', intent: 'memo' }, f.liaison(f.ownerTurn('只记一下：下周看成本', 'contract-memo'))]],
      chief_brief: [[{}]],
      chief_ticket: [[{ id: ticketId, action: 'view' }]],
      chief_lookup: [[{ what: 'overview' }]],
      chief_record: [[{ kind: 'person', person: '周岚', role: '评审' }]],
      chief_schedule: [[{ action: 'list' }], [{ action: 'set', for: 'self', at: '2026-11-27T09:00', text: '看评审意见' }],
        [{ action: 'set', title: '未关闭工单提醒', when: 'weekdays 09:00', content: 'open-orders' }, f.liaison(f.ownerTurn('每周一到周五上午 9:00 检查并提醒我各工作区尚未关闭的工单'))]],
      chief_staff: [[{ action: 'list' }], [{ action: 'create', workspace: '评审', name: '竞品观察员', brief: '盯竞品的定价、发布与渠道动作，每周汇总成一页要点。' },
        f.liaison(f.ownerTurn('给评审加一个盯竞品的幕僚'))]],
      chief_ui: [[{ action: 'show' }], [{ action: 'status' }]],
      chief_import: [[{ action: 'prompt' }]],
      chief_export: [[{ for: 'chatgpt' }]],
      chief_settings: [[{ action: 'show' }]],
    }
    expect([...f.registered.keys()].sort()).toEqual(Object.keys(calls).sort())
    plain(read)
    for (const [name, rows] of Object.entries(calls)) {
      for (const [args, execution] of rows) {
        const value = await f.call(name, args, execution)
        expect(losslessViolations(value), `${name} ${JSON.stringify(args)}`).toEqual([])
      }
    }
    expect(await f.call('chief_settings', { action: 'show' })).not.toHaveProperty('notify')
  })
})

describe('方案 A：模型理解、结构化提交；主人本轮原话作为授权来源', () => {
  it('个人工作区和日程工具的原生步骤只向本脑接口人公开', () => {
    const f=host()
    for (const name of ['chief_workspace','chief_calendar','chief_order_followup','chief_schedule']) {
      const admission=f.admissions.get(name)!
      expect(admission.when({agent:{id:'hq'}})).toBe(true)
      expect(admission.when({agent:{id:'worker'}})).toBe(false)
      expect(admission.when({agent:{id:'chief-room-quarterly'}})).toBe(false)
    }
  })
  it('从主人原话建真实工作区，重复、已有同名和多份同名各有可核对的结果', async () => {
    const f = host()
    const name = '字节 Landing', text = '建一个工作区 叫做 ' + name
    const create = { action:'create', name }, auth = f.liaison(f.ownerTurn(text, 'workspace-owner'))
    const first = await f.call('chief_workspace', create, auth)
    const space = f.workspaceStore.list()[0]!
    expect(first).toMatchObject({workspace:{ id:space.id, name, goal:'', owner:'我' },outcome:'created'})
    expect(await f.call('chief_workspace', create, auth)).toEqual(first)
    const repeat = await f.call('chief_workspace', create, f.liaison(f.ownerTurn('再帮我看看要建的 ' + name, 'next-intent')))
    expect(repeat).toMatchObject({ workspace:space,outcome:'existing' })
    expect(new WorkspaceV2Store(f.root,scope).list()).toEqual([space])
    const ui = {requestId:'manual',name,goal:'有意独立的项目'}
    f.workspaceStore.createWorkspace(mutationKey(['v2','workspaces'],ui),ui)
    await expect(f.call('chief_workspace', create, f.liaison(f.ownerTurn(text,'ambiguous')))).rejects.toThrow('多份同名')
    expect((await f.call('chief_workspace', {action:'list'})).workspaces).toHaveLength(2)
    f.workspaceStore.dispose()
    await expect(f.call('chief_workspace', create, auth)).rejects.toThrow('第二大脑已切换')
    await expect(f.call('chief_workspace', {action:'list'})).rejects.toThrow('第二大脑已切换')
  })

  it('只有本轮主人能操作；简短确认可承接前一句的名字，伪造名称、只读要求与旧回合被拒绝', async () => {
    const f = host(), args={action:'create',name:'春季评审'}, text='想建春季评审工作区'
    const earlier=f.ownerTurn(text,'earlier')
    const end={type:'turn/end',seq:3,time:3,data:{}}
    await expect(f.call('chief_workspace',args,f.liaison([...earlier,end]))).rejects.toThrow('经宿主确认')
    await expect(f.call('chief_workspace',args,{agent:{id:'staff',session:{snapshotEvents:()=>earlier}}} as never)).rejects.toThrow('经宿主确认')
    await expect(f.call('chief_workspace',args,f.liaison(f.ownerTurn('说说工作区是什么')))).rejects.toThrow('主人原话')
    await expect(f.call('chief_workspace',{...args,goal:'捏造'},f.liaison(earlier))).rejects.toThrow('目标')
    await f.intake.submit({scope,requestId:'readonly',operation:'read',text})
    await expect(f.call('chief_workspace',args,f.liaison(f.ownerTurn(text,'readonly')))).rejects.toThrow('指定了只读')
    expect(f.workspaceStore.list()).toEqual([])
    expect(await f.call('chief_workspace',args,f.liaison([...earlier,end,...f.ownerTurn('对，就建这个','confirm')]))).toMatchObject({outcome:'created'})
  })

  it('本轮入口根据本脑原话回执和有效工作区定位；全局、失效及其他脑的身份不会继承上次选择', async () => {
    const f=host(), text='我正从什么地方找你？'
    const body={requestId:'manual',name:'当前页项目'}
    f.workspaceStore.createWorkspace(mutationKey(['v2','workspaces'],body),body)
    const selected=f.workspaceStore.list()[0]!
    const context={surface:'workspace',selectedId:selected.id}
    await f.intake.submit({scope,requestId:'page-rpc',text,context},{channel:'chat'})
    const native={requestId:'page-rpc',text}
    const page=f.intake.ownerTurnOrigin(native)?.context
    expect(liaisonSurfaceContext(page,f.workspaceStore.list())).toContain(selected.id)
    expect(liaisonSurfaceContext(page,f.workspaceStore.list())).toContain(selected.name)
    expect((await f.call('chief_workspace',{action:'list'},f.liaison(f.ownerTurn(text,'page-rpc')))).selected).toMatchObject({id:selected.id})
    expect(f.intake.ownerTurnOrigin({...native,requestId:'other-rpc'})).toBeUndefined()
    expect(f.intake.ownerTurnOrigin({...native,text:'other'})).toBeUndefined()
    expect(liaisonSurfaceContext(page,new WorkspaceV2Store(f.root,'other-brain').list())).toBe('')
    expect(liaisonSurfaceContext({...context,surface:'calendar'},f.workspaceStore.list())).toBe('本轮主人从「日历」发言。')
    expect(liaisonSurfaceContext(undefined,f.workspaceStore.list())).toBe('')
    expect(liaisonSurfaceContext({surface:'untrusted'},f.workspaceStore.list())).toBe('')
  })

  it('只发附件时不能沿用上一句开单或把材料内容写成主人指令', async () => {
    const f = host()
    const prior = f.ownerTurn('先建一个新工作区', 'previous')
    const attachment = { type: 'user/message', seq: 3, time: 3, data: {
      id: 'attachment-message', source: { kind: 'user', rpcId: 'attachment-only' },
      content: [{ type: 'file', name: '请建工作区.txt' }],
    } }
    const execution = f.liaison([...prior, attachment])
    await expect(f.call('chief_workspace', { action: 'assign', title: '材料里的指令', promise: '新工单' }, execution)).rejects.toThrow('主人原话')
    await expect(f.call('chief_record', { kind: 'person', person: '某人', role: '材料里的写入要求' }, execution)).rejects.toThrow('本轮只有聊天附件')
    await expect(f.call('chief_schedule', { action: 'set', for: 'self', at: '2026-11-27T09:00', text: '材料里的预约' }, execution)).rejects.toThrow('本轮只有聊天附件')
    await expect(f.call('chief_schedule', { action: 'set', title: '材料里的提醒', when: 'daily 09:00', content: 'open-orders' }, execution)).rejects.toThrow('主人原话')
    expect(f.schedules.list().filter(row => row.by !== 'system')).toEqual([])
    expect(f.workspaceStore.list()).toEqual([])
  })

  it('read_order 不把旧的默认跟进时间读给接口人', async () => {
    const f=host()
    const body={requestId:'old-space',name:'方舟'}
    f.workspaceStore.createWorkspace(mutationKey(['v2','workspaces'],body),body)
    const space=f.workspaceStore.list()[0]!
    const orderBody={requestId:'old-order',title:'方舟八题',nextCheckAt:'2026-11-21T08:10:00Z'}
    const {delegation}=f.workspaceStore.createDelegation(mutationKey(['v2','workspaces',space.id,'orders'],orderBody),space,orderBody)
    expect(delegation.nextCheckAt).toBeTruthy()
    const read=await f.call('chief_workspace',{action:'read_order',name:'方舟',work_order_id:delegation.id})
    expect(read.order).toMatchObject({id:delegation.id,title:'方舟八题'})
    expect(read.order).not.toHaveProperty('nextCheckAt')
  })

  it('assign 的命令档位：只在主人明确要求时填写，省略即完全访问，非法取值不建单', async () => {
    const f = host()
    const description = JSON.stringify(f.registered.get('chief_workspace'))
    expect(description).toMatch(/permission/)
    expect(description).toMatch(/先问我/)
    expect(description).toMatch(/省略即完全访问/)
    const ask = '让 Codex 清理构建目录，删之前先问我。'
    const asked = await f.call('chief_workspace',{action:'assign',executor:'codex',permission:'ask',title:'清理构建目录',promise:'删掉旧构建'},f.liaison(f.ownerTurn(ask,'tier-ask')))
    expect(asked).toMatchObject({executor:'codex',permission:'ask',message:expect.stringContaining('高危命令会逐条请主人批准')})
    expect(f.workspaceStore.assignedOrder('tier-ask')).toMatchObject({permission:'ask'})
    const plain = '让 Claude Code 整理一下发布说明。'
    const omitted = await f.call('chief_workspace',{action:'assign',executor:'claude-code',title:'整理发布说明',promise:'一份发布说明'},f.liaison(f.ownerTurn(plain,'tier-none')))
    expect(omitted).not.toHaveProperty('permission')
    expect(f.workspaceStore.assignedOrder('tier-none')).not.toHaveProperty('permission')
    const before = f.workspaceStore.list().length
    await expect(f.call('chief_workspace',{action:'assign',executor:'codex',permission:'sandbox',title:'x',promise:'y'},f.liaison(f.ownerTurn('让 Codex 做件事','tier-bad'))))
      .rejects.toThrow('命令档位')
    expect(f.workspaceStore.assignedOrder('tier-bad')).toBeUndefined()
    expect(f.workspaceStore.list()).toHaveLength(before)
    // The workspace team has no command hook, so a tier is not stored for it.
    await f.call('chief_workspace',{action:'assign',executor:'dsh',permission:'approve-for-me',title:'团队单',promise:'一份清单'},f.liaison(f.ownerTurn('团队整理清单，替我把关','tier-team')))
    expect(f.workspaceStore.assignedOrder('tier-team')).not.toHaveProperty('permission')
  })

  it('群聊：assign 不再选执行者（executor 被忽略），工单进工作区群聊，点名的幕僚在群里被 @，档位照旧', async () => {
    const f = host({ groups: true })
    const description = JSON.stringify(f.registered.get('chief_workspace'))
    expect(description).toContain('不再选择执行者')
    expect(description).toContain('已废弃')
    const said = '让 Codex 清理构建目录，删之前先问我。'
    const result = await f.call('chief_workspace',{action:'assign',executor:'codex',permission:'ask',title:'清理构建目录',promise:'删掉旧构建',handoff:'请清理构建目录里的旧产物。'},f.liaison(f.ownerTurn(said,'group-ask')))
    expect(result).not.toHaveProperty('executor')
    expect(result).toMatchObject({ permission:'ask', group:{ id: expect.any(String) }, message: expect.stringContaining('接口人会在群里按分工 @ 幕僚') })
    const order = f.workspaceStore.assignedOrder('group-ask')!
    expect(order).toMatchObject({ permission:'ask' })
    expect(f.workspaceStore.session(order.workspaceId, order.sessionId)).toMatchObject({ engine:'roster', kind:'group' })
    await vi.waitFor(() => expect(f.memberCalls).toEqual(['liaison']))
    // A staff member the owner names is @-mentioned in the group (here from the workspace that has the engineer).
    const space = f.workspaceStore.workspace(order.workspaceId)
    f.staffStore.apply(space.id,{action:'join',staffId:'engineer',duty:'效果评测',requestId:'join-engineer'})
    const named = await f.call('chief_workspace',{action:'assign',name:space.name,staff_name:'工程师',title:'跑评测',promise:'评测结果'},
      f.liaison(f.ownerTurn('在' + space.name + '里让工程师跑一遍评测','group-named')))
    expect(named).toMatchObject({ message: expect.stringContaining('并 @ 了工程师') })
    await vi.waitFor(() => expect(f.memberCalls).toEqual(['liaison', 'engineer']))
  })

  it('项目目录：create 与 set_directory 绑定主人给的目录，assign 只在本轮原话写明目录时带上，不合法时什么也不保存', async () => {
    const f = host()
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'chief-liaison-project-')))
    const own = realpathSync(mkdtempSync(join(tmpdir(), 'chief-liaison-own-')))
    cleanup.push(() => { rmSync(project, { recursive: true, force: true }); rmSync(own, { recursive: true, force: true }) })
    const description = JSON.stringify(f.registered.get('chief_workspace'))
    for (const part of ['set_directory', 'directory', '空字符串', '只在主人本轮原话']) expect(description).toContain(part)
    const created = await f.call('chief_workspace', {action:'create', name:'字节 Landing'}, f.liaison(f.ownerTurn('建一个工作区 叫做 字节 Landing', 'dir-create')))
    const id = (created.workspace as V2Workspace).id
    // Bind: the path is quoted from the owner's words; the saved path is resolved.
    const bindText = '把字节 Landing 绑定到 ' + project + '/'
    const bound = await f.call('chief_workspace', {action:'set_directory', name:'字节 Landing', directory: project + '/'}, f.liaison(f.ownerTurn(bindText, 'dir-bind')))
    expect(bound).toMatchObject({workspace:{id, projectDirectory:project}, message:expect.stringContaining('下一轮起')})
    expect(f.workspaceStore.workspace(id).projectDirectory).toBe(project)
    // A directory the owner never said, or an unusable one, changes nothing.
    await expect(f.call('chief_workspace', {action:'set_directory', name:'字节 Landing', directory:own}, f.liaison(f.ownerTurn('把字节 Landing 换个目录', 'dir-invented'))))
      .rejects.toThrow('主人原话里没有目录')
    await expect(f.call('chief_workspace', {action:'set_directory', name:'字节 Landing', directory:'/etc'}, f.liaison(f.ownerTurn('把字节 Landing 绑定到 /etc', 'dir-etc'))))
      .rejects.toThrow('系统目录')
    await expect(f.call('chief_workspace', {action:'set_directory', name:'字节 Landing', directory:join(project, 'missing')},
      f.liaison(f.ownerTurn('把字节 Landing 绑定到 ' + join(project, 'missing'), 'dir-missing')))).rejects.toThrow('不存在')
    expect(f.workspaceStore.workspace(id).projectDirectory).toBe(project)
    // An order-specific directory, only from this turn's words, for a coding tool.
    const said = '新开一张工单交给 Codex，在字节 Landing 的 ' + own + ' 目录下检查 README 的命令。'
    const assigned = await f.call('chief_workspace', {action:'assign', name:'字节 Landing', executor:'codex', title:'检查 README', promise:'列出过时命令', directory:own}, f.liaison(f.ownerTurn(said, 'dir-order')))
    expect(assigned).toMatchObject({directory:{source:'order', path:own}, message:expect.stringContaining('本单指定目录 ' + own)})
    expect(f.workspaceStore.assignedOrder('dir-order')).toMatchObject({directory:own})
    const plain = await f.call('chief_workspace', {action:'assign', name:'字节 Landing', executor:'claude-code', title:'改首页', promise:'首页改版'}, f.liaison(f.ownerTurn('让 Claude Code 改一下字节 Landing 的首页', 'dir-default')))
    expect(plain).toMatchObject({directory:{source:'workspace', path:project}, message:expect.stringContaining('工作区默认目录')})
    expect(f.workspaceStore.assignedOrder('dir-default')).not.toHaveProperty('directory')
    const before = f.workspaceStore.view(id).orders.length
    await expect(f.call('chief_workspace', {action:'assign', name:'字节 Landing', executor:'codex', title:'x', promise:'y', directory:own}, f.liaison(f.ownerTurn('让 Codex 在字节 Landing 做件事', 'dir-guess'))))
      .rejects.toThrow('主人原话里没有目录')
    await expect(f.call('chief_workspace', {action:'assign', name:'字节 Landing', executor:'dsh', title:'x', promise:'y', directory:own}, f.liaison(f.ownerTurn('让团队在 ' + own + ' 整理字节 Landing 的资料', 'dir-team'))))
      .rejects.toThrow('只用于 Codex 或 Claude Code')
    expect(f.workspaceStore.view(id).orders).toHaveLength(before)
    // Unbind with an empty directory; a new workspace can be created with its directory.
    expect(await f.call('chief_workspace', {action:'set_directory', name:'字节 Landing', directory:''}, f.liaison(f.ownerTurn('解除字节 Landing 的项目目录', 'dir-unbind'))))
      .toMatchObject({message:expect.stringContaining('已解除')})
    expect(f.workspaceStore.workspace(id)).not.toHaveProperty('projectDirectory')
    const second = await f.call('chief_workspace', {action:'create', name:'接口服务', directory:own}, f.liaison(f.ownerTurn('建一个工作区叫接口服务，项目目录在 ' + own, 'dir-create-2')))
    expect(second).toMatchObject({outcome:'created', workspace:{name:'接口服务', projectDirectory:own}})
    expect((await f.call('chief_workspace', {action:'list'})).workspaces).toEqual(expect.arrayContaining([expect.objectContaining({name:'接口服务', projectDirectory:own})]))
  })

  it('assign 的 handoff：接口人用自己的话交办，主人原话由宿主附上，超长不建单', async () => {
    const f = host()
    const description = JSON.stringify(f.registered.get('chief_workspace'))
    expect(description).toMatch(/handoff/)
    expect(description).toMatch(/不要照抄/)
    expect(description).toMatch(/自动/)
    const said = '让 Codex 把发布说明整理成一页，列出新功能和已知问题。'
    const handoff = '请整理一页发布说明：分「新功能」「已知问题」两节，每条一句话。'
    await f.call('chief_workspace',{action:'assign',executor:'codex',title:'整理发布说明',promise:'一页发布说明',handoff},f.liaison(f.ownerTurn(said,'handoff-own')))
    const turnOf = (requestId: string) => 'start-' + createHash('sha256').update('assign:' + requestId).digest('hex')
    expect(f.workspaceStore.liaisonTurn(turnOf('handoff-own'))).toEqual({handoff})
    // The owner's words stay the authorization and the stored original, whatever the liaison wrote.
    const order = f.workspaceStore.assignedOrder('handoff-own')!
    expect(f.workspaceStore.orderOriginal(order.workspaceId,order.id)).toEqual({text:said,complete:true})
    await f.call('chief_workspace',{action:'assign',executor:'codex',title:'整理变更',promise:'一页变更清单'},f.liaison(f.ownerTurn('让 Codex 整理变更清单。','handoff-none')))
    expect(f.workspaceStore.liaisonTurn(turnOf('handoff-none'))).toEqual({handoff:'我把这件事交给你：整理变更。完成标准：一页变更清单。主人原话如下。'})
    // A model sending the optional field empty gets the template, not a refusal.
    await f.call('chief_workspace',{action:'assign',executor:'codex',title:'整理变更',promise:'一页变更清单',handoff:'  '},f.liaison(f.ownerTurn('让 Codex 再整理一份变更清单。','handoff-empty')))
    expect(f.workspaceStore.liaisonTurn(turnOf('handoff-empty'))).toEqual({handoff:'我把这件事交给你：整理变更。完成标准：一页变更清单。主人原话如下。'})
    await expect(f.call('chief_workspace',{action:'assign',executor:'codex',title:'x',promise:'y',handoff:'长'.repeat(601)},f.liaison(f.ownerTurn('让 Codex 做件事。','handoff-long'))))
      .rejects.toThrow('handoff')
    expect(f.workspaceStore.assignedOrder('handoff-long')).toBeUndefined()
  })

  it('今天直接接下三项约定，从本轮原话一次登记，重复调用保留原单与原署名', async () => {
    const f = host(), requestId = 'owner-promises'
    const text = '跟进这些约定。我答应小陈周四演示，她答应周三给样本，还请我看看预算，我没答应。'
    const turn = f.liaison(f.ownerTurn(text,requestId))
    const record = {action:'record',entries:[
      {kind:'mine',quote:'我答应小陈周四演示',person:'小陈'},
      {kind:'theirs',quote:'她答应周三给样本',person:'小陈'},
      {kind:'request',quote:'还请我看看预算，我没答应',person:'小陈'},
    ]}
    await expect(f.call('chief_order_followup',record,turn)).rejects.toThrow('工单')
    expect(f.workspaceStore.list()).toEqual([])
    await f.call('chief_workspace',{action:'assign',title:'客户演示约定',promise:'跟进演示、样本与待回应的预算请求。'},turn)
    const order = f.workspaceStore.assignedOrder(requestId)!
    const saved = await f.call('chief_order_followup',record,turn)
    expect(saved).toMatchObject({delegation:{id:order.id,sessionId:order.sessionId},commitments:{total:3}})
    expect(await f.call('chief_order_followup',record,turn)).toEqual(saved)
    const view = f.workspaceRoutes.followup.view(order.workspaceId,order.id)
    expect(view.commitments.map(row => [row.kind,row.quote]).sort()).toEqual(record.entries.map(row => [row.kind,row.quote]).sort())
    expect(view.commitments.every(row => row.source.kind === 'liaison' && row.source.sessionId === 'hq' && row.source.messageId === 'msg-' + requestId && row.source.at === new Date(2).toISOString())).toBe(true)
    await expect(f.call('chief_record',{kind:'commitment',direction:'mine',person:'小陈',text:'额外登记'},turn)).rejects.toThrow('所属工单')
    await expect(f.call('chief_order_followup',{action:'record',entries:[{kind:'mine',quote:'我同意扩大演示'}]},turn)).rejects.toThrow('引文')
    const outside = {agent:{id:'staff',session:{snapshotEvents:() => f.ownerTurn(text,requestId)}}} as never
    await expect(f.call('chief_order_followup',{action:'read'},outside)).rejects.toThrow('经宿主确认')
    expect(f.workspaceRoutes.followup.view(order.workspaceId,order.id).commitments).toHaveLength(3)
  })

  it('工作区的约定来源按负责工单过滤；只读的原话可查约定和周报，无法起草或改变周期', async () => {
    const f = host()
    const {workspace,delegation:order,session} = f.workspaceStore.assign('order-a','演示')
    const sibling = f.workspaceStore.assign('order-b','预算','dsh',workspace.id,session.id).delegation
    f.messages.set(session.id, [
      {id:'m1',role:'user',author:'我',at:'2026-11-19T08:00:00Z',text:'我答应讲解流程',workOrderId:order.id},
      {id:'m2',role:'agent',author:'研究员',at:'2026-11-19T08:00:01Z',text:'预算中的私有内容',workOrderId:sibling.id},
    ])
    const context = {surface:'workspace',selectedId:workspace.id,sessionId:session.id,workOrderId:order.id}
    const talk = async (text:string, requestId:string, operation?:'read') => {
      await f.intake.submit({scope,text,requestId,context,operation},{channel:operation ? 'owner' : 'chat'})
      return f.liaison(f.ownerTurn(text,requestId))
    }
    const sourceTurn = await talk('帮我从这张单的讨论里记下我作出的约定','use-local')
    const sources = await f.call('chief_order_followup',{action:'sources'},sourceTurn)
    expect(sources).toMatchObject({sources:{items:[{messageId:'m1',text:'我答应讲解流程'}],total:1}})
    const record = {action:'record',entries:[{kind:'mine',quote:'我答应讲解流程',messageId:'m1'}]}
    await f.call('chief_order_followup',record,sourceTurn)
    const saved = f.workspaceRoutes.followup.view(workspace.id,order.id).commitments[0]!
    expect(saved.source).toEqual({kind:'session',sessionId:session.id,messageId:'m1',author:'我',at:'2026-11-19T08:00:00Z'})
    await expect(f.call('chief_order_followup',{...record,work_order_id:sibling.id},sourceTurn)).rejects.toThrow('选中')
    await expect(f.call('chief_order_followup',{action:'sources',message_id:'m2'},sourceTurn)).rejects.toThrow('没有')
    await expect(f.call('chief_order_followup',{action:'record',entries:[{kind:'mine',quote:'预算',messageId:'m2'}]},sourceTurn)).rejects.toThrow()
    const consult = await talk('本周有哪些约定？只查，不要生成或改计划。','readonly-local','read')
    expect(await f.call('chief_order_followup',{action:'read'},consult)).toMatchObject({commitments:{total:1,items:[{id:saved.id}]},weeks:[]})
    for (const extra of [{action:'draft'},{action:'schedule',weekday:2,time:'09:00'},{action:'resolve',id:saved.id}]) {
      await expect(f.call('chief_order_followup',extra,consult)).rejects.toThrow('只读')
    }
    const run = await talk('为这张单每周五十七点出稿，现在给我本周稿。','weekly')
    expect(await f.call('chief_order_followup',{action:'schedule',weekday:5,time:'17:00'},run)).toMatchObject({schedule:{enabled:true,weekday:5,time:'17:00'},timeZone:'Asia/Shanghai'})
    const draft = await f.call('chief_order_followup',{action:'draft'},run)
    expect(draft).toMatchObject({report:{id:expect.any(String),markdown:expect.stringContaining('我答应讲解流程')}})
    expect(JSON.stringify(draft)).not.toContain('预算中的私有内容')
    expect(await f.call('chief_order_followup',{action:'draft'},run)).toEqual(draft)
    expect(await f.call('chief_order_followup',{action:'resolve',id:saved.id},await talk('讲解完成了，标记已处理','resolve'))).toMatchObject({commitments:{items:[{id:saved.id,resolved:true}]}})
  })

  it('点名项目时仍按主人打开的工单或会话查约定，在今天可以看整个项目', async () => {
    const f = host()
    const {workspace,session,delegation:first} = f.workspaceStore.assign('named-first','演示')
    const sibling = f.workspaceStore.assign('named-sibling','预算','dsh',workspace.id,session.id).delegation
    const third = f.workspaceStore.assign('named-third','资料','dsh',workspace.id).delegation
    for (const [order,quote] of [[first,'周四演示'],[sibling,'周五反馈'],[third,'另场私事']] as const) {
      await f.workspaceRoutes.followup.apply(workspace.id,order.id,{action:'record',requestId:'record-'+order.id,
        entries:[{kind:'mine',quote}]},{sessionId:'hq',messageId:'owner-'+order.id,text:quote})
    }
    const read = async (requestId:string, context:{surface:string;selectedId?:string;sessionId?:string;workOrderId?:string}) => {
      const text = '查查'+workspace.name+'的约定'
      await f.intake.submit({scope,text,requestId,context,operation:'read'},{channel:'owner'})
      return f.call('chief_order_followup',{action:'read',workspace_name:workspace.name},f.liaison(f.ownerTurn(text,requestId)))
    }
    const room = {surface:'workspace',selectedId:workspace.id,sessionId:session.id}
    const selected = await read('read-selected',{...room,workOrderId:first.id})
    expect(selected).toMatchObject({delegation:{id:first.id},commitments:{total:1,items:[{quote:'周四演示'}]}})
    const fromSession = await read('read-room',room)
    expect(fromSession).toMatchObject({total:2})
    expect(JSON.stringify(fromSession)).not.toContain('另场私事')
    expect(await read('read-today',{surface:'today'})).toMatchObject({total:3})
  })

  it('按本轮实际日期和可见的人物姓名理解指代，日期、人物档案和整份私人资料不跨页面', async () => {
    const f = host(), today = '2026-11-20'
    const personName = vi.fn((id:string) => id === 'person:real' ? '王老师' : undefined)
    const details = {personName,today}
    const page = async (surface:string, selectedId:string|undefined, requestId:string) => {
      const text = '这次选中了什么？'
      await f.intake.submit({scope,requestId,text,context:{surface,selectedId}},{channel:'chat'})
      return liaisonSurfaceContext(f.intake.ownerTurnOrigin({requestId,text})?.context,[],details)
    }
    expect(await page('calendar','2031-04-16','specific-day')).toBe('本轮主人从「日历」发言。当前选中日期为 2031-04-16。')
    expect(await page('calendar',undefined,'current-day')).toContain(today)
    expect(await page('calendar','2031-02-30','invalid-day')).toBe('本轮主人从「日历」发言。')
    expect(await page('calendar','9999-12-30','outside-calendar')).toBe('本轮主人从「日历」发言。')
    expect(personName).not.toHaveBeenCalled()
    const opened = await page('people','person:real','known-person')
    expect(opened).toContain('当前打开的人物姓名为 "王老师"，档案标识为 "person:real"')
    expect(opened).toContain('chief_lookup 的 person 和 selected_id')
    expect(await page('people','person:foreign','other-person')).toBe('本轮主人从「人物」发言。')
    expect(await page('people','ticket:real','other-kind')).toBe('本轮主人从「人物」发言。')
    expect(await page('today','person:real','back-home')).toBe('本轮主人从「今天」发言。')
    expect(personName.mock.calls).toEqual([['person:real'],['person:foreign']])
  })

  it('所选人物按本轮档案标识读取同名不同组织的实时和导入档案，并保留旧的执行者查人方式', async () => {
    const f = host()
    for (const [id,organization] of [['lin-edit','甲组织'],['lin-snapshot','乙组织']]) {
      writeFileSync(join(f.root,'people',id + '.md'),`---\nname: 林老师\norganization: ${organization}\n---\n\n## 事实\n- ${organization}的试点\n`)
    }
    const path = '/v2/history/import'
    const reply = {writeHead:vi.fn(),end:vi.fn()} as unknown as ServerResponse
    await f.history({method:'POST',path,seg:['v2','history','import'],url:new URL(path + '?scope=' + scope,'http://local'),via:'dsh',owner:true,body:{requestId:'save-people'}},reply)
    renameSync(join(f.root,'people','lin-snapshot.md'),join(f.root,'moved.md'))

    const said = '这位人物属于哪个组织？'
    const enter = async (requestId:string, surface:string, selectedId:string) => {
      await f.intake.submit({scope,requestId,text:said,context:{surface,selectedId}},{channel:'chat'})
      return f.liaison(f.ownerTurn(said,requestId))
    }
    const read = (selected_id:string, turn:never) => f.call('chief_lookup',{what:'person',selected_id},turn)
    const liveId = 'person:lin-edit', archivedId = 'person:lin-snapshot'
    const liveTurn = await enter('select-live','people',liveId)
    expect(await read(liveId,liveTurn)).toMatchObject({id:liveId,name:'林老师',organization:'甲组织',origin:'roster',body:expect.stringContaining('甲组织的试点')})
    await expect(read(archivedId,liveTurn)).rejects.toThrow('本轮人物页面')
    await expect(f.call('chief_lookup',{what:'person',id:'lin-snapshot',selected_id:liveId},liveTurn)).rejects.toThrow('只需')
    const archiveTurn = await enter('select-import','people',archivedId)
    const archived = await read(archivedId,archiveTurn)
    expect(archived).toMatchObject({id:archivedId,name:'林老师',organization:'乙组织',origin:'import',body:expect.stringContaining('乙组织的试点')})
    expect(archived.body).not.toContain('甲组织')
    expect(liaisonSurfaceContext({surface:'people',selectedId:archivedId},[],{personName:f.history.personName,today:'2026-11-20'})).toContain(archivedId)
    await expect(read(archivedId,await enter('leave-people','today',archivedId))).rejects.toThrow('本轮人物页面')
    await expect(read(archivedId,f.liaison([...f.ownerTurn(said,'select-import'),{type:'turn/end',seq:3,time:3,data:{}}]))).rejects.toThrow('经宿主确认')
    const executor = {agent:{id:'executor'},signal:new AbortController().signal} as never
    await expect(read(archivedId,executor)).rejects.toThrow('经宿主确认')
    expect(await f.call('chief_lookup',{what:'person',id:'lin-edit'},executor)).toMatchObject({id:'lin-edit',name:'林老师',organization:'甲组织'})
    await expect(f.call('chief_lookup',{what:'person',id:'lin-snapshot'},executor)).rejects.toThrow('没有这个人物')
  })
  it('从接口人导入仅接收本轮主人原文，回执独立于工单', async () => {
    const f = host()
    const original = '这是另一个助手对我的了解，帮我导入。\n我平时早上集中写作，设计评审希望先说明取舍。 [记忆] [机密]'
    const args = { action:'submit', source:'Claude' }
    const events = f.ownerTurn(original, 'profile-owner-turn')
    const state = f.liaison(events)
    await expect(f.call('chief_import', args,f.liaison([...events,{type:'turn/end',seq:3,time:3,data:{}}]))).rejects.toThrow('本轮贴回')
    expect(f.submitImport).not.toHaveBeenCalled()
    const first = await f.call('chief_import',args,state)
    expect(first).toEqual(await f.call('chief_import',{...args,text:'模型漏抄了来源标记。'},state))
    const requestId = f.submitImport.mock.calls[0]![2]
    expect(f.submitImport.mock.calls).toEqual([[original,'Claude',requestId],[original,'Claude',requestId]])
    expect(f.registered.get('chief_import')!.output.presentationMeta!(args,first)).toEqual({'dsh-chief/profile-import':{importId:first.importId}})
    expect(f.workspaceStore.list()).toEqual([])
    expect(f.store.tickets()).toEqual([])
  })

  it('今天的新交办进入 2.0，误用旧工具时给出正确入口且不会开旧单', async () => {
    const f = host()
    const text = '请交给团队拟一份产品访谈提纲。'
    const requestId = 'today-team-request'
    await f.intake.submit({scope,text,requestId,context:{surface:'today'}},{channel:'chat'})
    const state = f.liaison(f.ownerTurn(text,requestId))
    await expect(f.call('chief_inbox',{operation:'read',text},state)).rejects.toThrow('chief_workspace action=assign')
    expect(f.store.tickets()).toEqual([])
    const receipt = await f.call('chief_workspace',{action:'assign',title:'产品访谈提纲',promise:'交付可转发的提纲',executor:'dsh'},state)
    expect(receipt).toMatchObject({order:{id:expect.any(String),sessionId:expect.any(String)}})
    const workspaces = f.workspaceStore.list()
    expect(workspaces).toHaveLength(1)
    expect(f.workspaceStore.view(workspaces[0]!.id).orders).toHaveLength(1)
  })

  it('一位幕僚做一件事：chief_inbox 按声明的 operation 只读派工，回执原样记录结构化理解', async () => {
    const f = host()
    const said = '让研究员调研一下各模型的价格'
    const args = { text: '调研主流模型的公开价格，交付对比表和来源', operation: 'read', staff: 'researcher', title: '模型价格调研' }
    const value = plain(await f.call('chief_inbox', args, f.liaison(f.ownerTurn(said, 'rpc-price'))))
    expect(value).toMatchObject({ ticketId: 'T-0001', dispatched: true, message: expect.stringContaining('模型价格调研：已登记工单 T-0001') })
    const [view] = f.engine.views()
    expect(view).toMatchObject({ ticket: { mandate: { level: 'think' }, staff: 'researcher' } })
    expect(view!.stage).not.toBe('you/approve')
    expect(f.store.event(view!.ticket.mandate.eventId)?.text).toBe(said)
    expect(f.intake.get(String(value.receiptId)).authorization).toEqual({ by: 'liaison', ownerText: said, brief: args.text, requestId: 'rpc-price',
      messageId: 'msg-rpc-price', intent: 'execute', operation: 'read', restrictions: [], staff: 'researcher', sessionId: 'hq' })
    // 同一轮重试同一参数：同一回执，不重复建单；同一份说明换负责人或读写方式：冲突并说明
    expect(await f.call('chief_inbox', args, f.liaison(f.ownerTurn(said, 'rpc-price')))).toMatchObject({ ticketId: 'T-0001', receiptId: value.receiptId })
    for (const changed of [{ staff: 'strategist' }, { operation: 'write' }]) {
      await expect(f.call('chief_inbox', { ...args, ...changed }, f.liaison(f.ownerTurn(said, 'rpc-price'))))
        .rejects.toMatchObject({ status: 409, message: expect.stringContaining('已按主人这句话登记过') })
    }
    expect(f.store.tickets()).toHaveLength(1)
  })

  it('follow_order 可以补充到本段对话刚开出的工单（最近 3 张），不能补充到更早的或别处开出的工单', async () => {
    const f = host()
    const opened: string[] = []
    for (const [n, said] of ['把构建脚本超时改成 30 分钟', '整理发布说明', '补一份部署清单', '修一下登录页样式'].entries()) {
      const result = plain(await f.call('chief_workspace', { action: 'assign', executor: 'codex', title: said, promise: said }, f.liaison(f.ownerTurn(said, 'conv-' + n))))
      opened.push((result as { order: { id: string } }).order.id)
    }
    // 主人没有打开工单、原话也没点名工单号：只认本段对话最近开出的三张
    const stop = (id: string, rpc: string) => f.call('chief_workspace', { action: 'follow_order', work_order_id: id, handoff: '先停下修改，只读排查超时原因' }, f.liaison(f.ownerTurn('先别改，查一下构建为什么老超时', rpc)))
    expect(plain(await stop(opened[3]!, 'stop-new'))).toMatchObject({ state: expect.any(String) })
    // 中间又交办了别的单：主人说的仍是较早那张，也能补充
    expect(plain(await stop(opened[1]!, 'stop-earlier'))).toMatchObject({ delegation: { id: opened[1] }, state: expect.any(String) })
    await expect(stop(opened[0]!, 'stop-old')).rejects.toThrow('请先打开要继续的工单或在本轮点明工单号')
    // 报错列出本段对话还能补充的工单，接口人可以改用正确的 ID
    await expect(stop(opened[0]!, 'stop-old-again')).rejects.toThrow(new RegExp('还能补充的工单：.*' + opened[3] + '.*' + opened[1]))
    // 不是由接口人这段对话开出的工单
    const space = f.workspaceStore.list()[0]!
    const elsewhere = f.workspaceRoutes.assign('rpc-direct', '直接开的工单', 'codex', space.id) as { delegation: { id: string } }
    await expect(stop(elsewhere.delegation.id, 'stop-elsewhere')).rejects.toThrow('请先打开要继续的工单或在本轮点明工单号')
    // 来源对话只在服务端使用，发给界面的工单不带它
    const stored = f.workspaceStore.view(space.id).orders.find(o => o.id === opened[3])!
    expect(stored.conversationId).toBe('hq')
    expect(f.workspaceStore.present(stored, 'Asia/Shanghai')).not.toHaveProperty('conversationId')
  })

  it('已退役的契约工单：接口人不能追加、重试或批准，报错指向新开工作区工单，工单不变', async () => {
    const f = host()
    await f.call('chief_inbox', { text: '把构建脚本的超时改成 30 分钟', operation: 'write', title: '构建超时 30 分钟' }, f.liaison(f.ownerTurn('把构建脚本超时改成 30 分钟', 'rpc-old')))
    const before = JSON.stringify(f.store.ticket('T-0001'))
    for (const action of ['reply', 'retry', 'approve', 'accept', 'stop']) {
      const call = f.call('chief_ticket', { id: 'T-0001', action, text: '主人要求继续' }, f.liaison(f.ownerTurn('继续', 'rpc-' + action)))
      await expect(call).rejects.toThrow(/已经退役.*chief_workspace assign.*handoff/)
      await expect(f.call('chief_ticket', { id: 'T-0001', action, text: 'x' }, f.liaison(f.ownerTurn('继续', 'rpc2-' + action)))).rejects.toThrow(/契约/)
    }
    expect(JSON.stringify(f.store.ticket('T-0001'))).toBe(before)
    expect(plain(await f.call('chief_ticket', { id: 'T-0001', action: 'view' }, f.liaison(f.ownerTurn('看看 T-0001', 'rpc-view'))))).toMatchObject({ id: 'T-0001' })
    const ticketTool = JSON.stringify(f.registered.get('chief_ticket')), workspaceTool = JSON.stringify(f.registered.get('chief_workspace'))
    for (const part of ['已退役', 'chief_workspace assign', 'handoff', '不要让主人去原工单界面确认']) expect(ticketTool).toContain(part)
    for (const part of ['已退役的原生工单', '新开工作区工单', 'handoff']) expect(workspaceTool).toContain(part)
  })

  it('读写方式由接口人声明：write 进入主人批准；系统不再从文字猜写入，声明 read 的工单由工单桌限制只写本工单目录', async () => {
    const f = host()
    const write = plain(await f.call('chief_inbox', { text: '把构建脚本的超时改成 30 分钟', operation: 'write', title: '构建超时 30 分钟' }, f.liaison(f.ownerTurn('把构建脚本超时改成 30 分钟'))))
    expect(write).toMatchObject({ ticketId: 'T-0001', message: expect.stringContaining('等主人在「等你决定」里批准后才执行') })
    expect(f.engine.views()[0]).toMatchObject({ stage: 'you/approve', ticket: { staff: 'engineer', mandate: { level: 'propose' }, requestedExecutor: 'codex' } })
    expect(f.store.ticket('T-0001')!.assignments).toHaveLength(0)
    // 接口人自己写的任务说明不能由接口人自己批准：SuperHub 工单的批准要带主人核对过的契约版本
    await expect(f.call('chief_ticket', { id: 'T-0001', action: 'approve' }, f.liaison(f.ownerTurn('批准 T-0001')))).rejects.toThrow(/契约/)
    const read = plain(await f.call('chief_inbox', { text: '修复构建脚本里的超时问题的方案调研', operation: 'read' }, f.liaison(f.ownerTurn('先查一下构建为什么超时'))))
    expect(read).toMatchObject({ ticketId: 'T-0002', message: expect.stringContaining('已派给幕僚') })
    expect(f.store.ticket('T-0002')!.mandate.level).toBe('think')
    expect(f.store.ticket('T-0002')!.superhub?.contracts[0]?.denied).toEqual(['修改配置、代码或数据', '部署或对外发送'])
    // operation 必填：缺省时说明两种含义，不建单
    await expect(f.call('chief_inbox', { text: '调研构建时长' }, f.liaison(f.ownerTurn('查一下构建时长')))).rejects.toThrow(/operation 必填：read.*write/)
    expect(f.store.tickets()).toHaveLength(2)
  })

  it('restrictions 只能原样摘自主人本轮原话，写进契约禁止项；主人没说过的禁止项不进契约', async () => {
    const f = host()
    const said = '先别改，查一下构建为什么超时，不要部署'
    const value = plain(await f.call('chief_inbox', { text: '只读排查构建超时的原因，交付结论与证据', operation: 'read', restrictions: ['先别改', ' 不要部署 '] }, f.liaison(f.ownerTurn(said, 'rpc-limits'))))
    expect(value.ticketId).toBe('T-0001')
    const contract = f.store.ticket('T-0001')!.superhub!.contracts[0]!
    expect(contract.denied).toEqual(['先别改', '不要部署', '修改配置、代码或数据', '部署或对外发送'])
    expect(f.intake.get(String(value.receiptId)).authorization?.restrictions).toEqual(['先别改', '不要部署'])
    await expect(f.call('chief_inbox', { text: '只读排查构建超时', operation: 'read', restrictions: ['不要联系外部人员'] }, f.liaison(f.ownerTurn(said, 'rpc-limits-2'))))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('限制「不要联系外部人员」不是主人本轮原话里的片段，未建单') })
    expect(f.store.tickets()).toHaveLength(1)
  })

  it('T-0020：接口人任务说明里的「分别」「不要猜测」不会变成契约禁止项', async () => {
    const f = host()
    const brief = '请每位幕僚分别汇报当前实际使用的模型供应商、模型名称和执行器；无法获知时明确标注，不要猜测。汇总包括研判官、工程师、外务、研究员、审查官、书记官、谋士和界面师。'
    const value = plain(await f.call('chief_inbox', { text: brief, operation: 'read', title: '各幕僚自述当前模型' }, f.liaison(f.ownerTurn('让每个人汇报一下自己用的模型', 'rpc-t20'))))
    const ticket = f.store.ticket(String(value.ticketId))!
    const denied = ticket.superhub!.contracts[0]!.denied
    expect(denied).toEqual(['修改配置、代码或数据', '部署或对外发送'])
    expect(ticket.mandate.scope).toContain(`接口人理解的任务：${brief}`)
    expect(ticket.mandate.scope).toContain('禁止：修改配置、代码或数据；部署或对外发送。')
    expect(ticket.mandate.scope).not.toMatch(/禁止：[^\n]*(别汇报|不要猜测)/)
  })

  it('备忘由接口人声明 intent=memo：只记入回执、不派工；非主人触发都拒绝并说明', async () => {
    const f = host()
    const memo = plain(await f.call('chief_inbox', { text: '周五和张三对一下季度报告的交接安排', operation: 'read', intent: 'memo' }, f.liaison(f.ownerTurn('记一下：周五和张三对一下季度报告的交接安排'))))
    expect(memo).toMatchObject({ dispatched: false, message: expect.stringMatching(/^已记下原话，未派工：接口人判断主人只要求记下/) })
    expect(memo).not.toHaveProperty('ticketId')
    expect(f.intake.get(String(memo.receiptId))).toMatchObject({ items: [{ intent: 'memo', state: 'recorded' }], authorization: { intent: 'memo', restrictions: [] } })
    expect(f.store.tickets()).toEqual([])
    const noOwner = [{ type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '定时：汇总' }] } }] as SessionEventLike[]
    await expect(f.call('chief_inbox', { text: '汇总', operation: 'read' }, f.liaison(noOwner))).rejects.toThrow(/经宿主确认.*未建单/)
    await expect(f.call('chief_inbox', { text: '汇总', operation: 'read' }, f.liaison([...f.ownerTurn('请汇总'), { type: 'turn/end', seq: 3, time: 3, data: {} }]))).rejects.toThrow('经宿主确认')
    await expect(f.call('chief_room', { action: 'discuss', title: '汇总', text: '汇总' }, f.liaison(noOwner))).rejects.toThrow('未开讨论')
  })

  it('chief_room 描述分清祈使句的新请求与问句的追问进展', () => {
    const description = JSON.stringify(host().registered.get('chief_room'))
    for (const part of ['分清新请求与追问进展', '祈使句', '即使已有同题讨论', 'discuss 续接', '只有问句', '都汇报了吗', '不再发起']) expect(description).toContain(part)
  })
  it('「让每个人汇报一下自己用的模型」：chief_room 开讨论，首条消息是转述并引用主人原话', async () => {
    const f = host()
    const said = '让每个人汇报一下自己用的模型'
    const args = { action: 'discuss', request_id: 'staff-model-self-report-20261119', title: '幕僚模型自述', text: '请 researcher、strategist 各自说明自己当前实际运行的模型和思考深度' }
    const value = plain(await f.call('chief_room', args, f.liaison(f.ownerTurn(said, 'rpc-room'))))
    expect(value).toMatchObject({ title: '幕僚模型自述', reused: false, message: expect.stringContaining('已新建讨论「幕僚模型自述」') })
    const view = await f.rooms.view(String(value.id))
    expect(view.messages.map(row => row.text)).toEqual([`接口人转述：${args.text}\n主人原话：「${said}」`])
    await f.call('chief_room', args, f.liaison(f.ownerTurn(said, 'rpc-room')))
    expect((await f.rooms.view(String(value.id))).messages).toHaveLength(1)
  })

  it('把部分和最终回报绑定到同一房间内的各条私聊委托，不接受直接讨论或组员代发', async ({ onTestFinished }) => {
    const f = host()
    const dispatch = async (text: string, rpcId: string, room?: string) => {
      const value = await f.call('chief_room', { action: 'discuss', title: '幕僚自我介绍', room, text }, f.liaison(f.ownerTurn(text, rpcId)))
      return { id: String(value.id), session: String(value.session), title: String(value.title), requestId: String(value.requestId) }
    }
    const first = await dispatch('让他们自我介绍一下', 'intro')
    const second = await dispatch('再让他们分享一个常见案例', 'case', first.id)
    expect(first.id).toBe(second.id)
    expect(first.requestId).not.toBe(second.requestId)
    const lead = f.leadOf(first.session)
    const report = (args: Record<string, unknown>, caller = lead) => f.call('chief_room_note', { action: 'report_result', ...args }, caller)
    const direct = await f.ownerSays(first.id, '讨论里的另一件事')
    const read = await f.call('chief_room_note', { action: 'read' }, lead)
    const [b, a] = read.liaisonRequests as { source: string; excerpt: string; status: string }[]
    expect([a?.excerpt, b?.excerpt]).toEqual(['让他们自我介绍一下', '再让他们分享一个常见案例'])
    expect(a?.status).toBe('pending')
    expect(await f.rooms.discussionResults([first, second])).toEqual([])
    await expect(report({ source: direct, text: '不该出现在私聊', status: 'ready' })).rejects.toThrow('私聊转交')
    await expect(report({ source: 'another-room:1', text: '串题', status: 'ready' })).rejects.toThrow('本讨论')
    f.teammates.set('member', { root: first.session, name: 'researcher' })
    const teammate = { agent: { id: 'member' }, signal: new AbortController().signal } as never
    await expect(report({ source: a!.source, text: '未汇总', status: 'ready' }, teammate)).rejects.toThrow('讨论接口人')

    // The room lead reports from a later turn triggered by the arriving member result.
    f.endTurn(first.session)
    f.memberSays(first.session, '研究员：我负责查证资料。')
    vi.useFakeTimers({ now: new Date('2026-11-20T09:00:00Z'), toFake: ['Date'] })
    onTestFinished(() => { vi.useRealTimers() })
    const partial = { source: a!.source, text: '研究员负责查证资料，谋士尚未答复。', status: 'partial' }
    const submitted = plain(await report(partial))
    expect(await report(partial)).toEqual(submitted)
    const finished = plain(await report({ source: a!.source, text: '研究员负责查证资料，谋士负责场景分析。', status: 'ready' }))
    const caseResult = plain(await report({ source: b!.source, text: '案例：整理三家供应商的资费。', status: 'ready' }))
    const { session: _, ...firstReceipt } = first
    const firstResults = await f.rooms.discussionResults([first, first, firstReceipt])
    expect(submitted.at).toBe(finished.at)
    expect(firstResults.map(result => result.id)).toEqual([submitted.id, finished.id])
    expect(firstResults.every(result => result.roomId === first.id)).toBe(true)
    expect(await f.rooms.discussionResults([second])).toMatchObject([{ id: caseResult.id, text: caseResult.text }])
    expect(await f.rooms.discussionResults([{ ...second, id: 'unrelated-room' }])).toEqual([])
    expect(await f.rooms.discussionResults([])).toEqual([])
    const restored = new NativeRooms({} as HostContext, f.root, () => [])
    try { expect(await restored.discussionResults([first])).toEqual(firstResults) } finally { restored.dispose() }
  })

  it('工具描述按 R8 路由：多位幕僚各自回答用讨论，一人一件事用工单，配置事实直接查', () => {
    const f = host()
    const describe = (name: string) => String(f.registered.get(name)!.description)
    expect(describe('chief_inbox')).toContain('交给一位幕僚完成')
    expect(describe('chief_inbox')).toContain('用 chief_room discuss，不要用这里')
    expect(describe('chief_inbox')).not.toMatch(/「你让他们自述一下」「让每个人汇报一下」时使用/)
    expect(describe('chief_room')).toContain('不要用 chief_inbox')
    expect(describe('chief_staff')).toContain('effectiveModel')
    expect(f.registered.get('chief_inbox')!.parameters).toMatchObject({ required: ['text', 'operation'] })
  })
})

describe('幕僚的生效模型与讨论成员身份', () => {
  it('chief_staff list 给出每位幕僚的生效模型、思考深度与来源，且是无损 JSON', async () => {
    const f = host()
    const { staff: rows } = plain(await f.call('chief_staff', { action: 'list' })) as { staff: Record<string, unknown>[] }
    const by = (id: string) => rows.find(row => row.id === id)
    expect(by('researcher')).toMatchObject({ effectiveModel: 'deepseek-official/deepseek-flash', effectiveReasoningEffort: 'high', modelSource: 'DSH 默认' })
    expect(by('strategist')).toMatchObject({ model: 'zhipu/glm-5.3', effectiveModel: 'zhipu/glm-5.3', effectiveReasoningEffort: 'high', modelSource: '幕僚卡' })
    expect(by('engineer')).toMatchObject({ effectiveModel: 'gpt-6.2-sol', modelSource: 'Codex 配置' })
    expect(by('liaison')).toMatchObject({ name: '外务', modelSource: '远程，未知' })
    expect(by('liaison')).not.toHaveProperty('effectiveModel')
  })

  it('讨论成员以幕僚 id 命名时按幕僚卡模型运行并注入身份；Codex/远程幕僚的成员必须首句声明配置与实际差异', async () => {
    const f = host()
    const room = await f.rooms.create('models', '幕僚模型自述')
    const sections = new Map<string, () => string>()
    const member = (id: string, name: string) => {
      let current = { provider: 'deepseek-official', model: 'deepseek-pro' } as { provider: string; model: string; reasoningEffort?: string }
      const select = vi.fn((next: typeof current) => { current = next })
      f.teammates.set(id, { root: room.session, name })
      const agent = { id, session: { snapshotEvents: () => [], header: { parentSession: room.session } }, model: { current: () => current, select },
        ctx: { systemPrompt: { section: ({ name: section, text }: { name: string; text: () => string }) => { sections.set(`${id}:${section}`, text); return () => {} } } } }
      f.rooms.attachContext(agent as never)
      return { select, current: () => current, identity: () => sections.get(`${id}:chief-room-identity`)?.() ?? '' }
    }
    const strategist = member('m-strategist', 'strategist')
    expect(strategist.select).toHaveBeenCalledWith({ provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'high' })
    expect(strategist.identity()).toContain('你在本讨论中代表幕僚「谋士」（strategist）')
    expect(strategist.identity()).toContain('本次实际运行：zhipu/glm-5.3（思考深度 high）')
    const researcher = member('m-researcher', 'researcher')
    expect(researcher.current()).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
    // 再次挂接（重新加载会话）不重复切换
    f.rooms.attachContext({ id: 'm-researcher', session: { snapshotEvents: () => [], header: { parentSession: room.session } }, model: { current: researcher.current, select: researcher.select } } as never)
    expect(researcher.select).toHaveBeenCalledTimes(1)
    const engineer = member('m-engineer', 'engineer')
    expect(engineer.select).not.toHaveBeenCalled()
    expect(engineer.identity()).toContain('你不是这位幕僚本人：工程师 的执行器是 codex')
    expect(engineer.identity()).toContain('「工程师配置为 gpt-6.2-sol（执行器 codex），本次讨论中实际运行 deepseek-official/deepseek-pro」')
    // 幕僚 id 为 liaison（外务，远程）的成员按幕僚处理，不当作接口人
    const outside = member('m-liaison', 'liaison')
    expect(outside.select).not.toHaveBeenCalled()
    expect(outside.identity()).toContain('代表幕僚「外务」（liaison）')
    // 名字不是幕僚的成员不注入身份、不换模型
    const helper = member('m-helper', 'fact-checker')
    expect(helper.select).not.toHaveBeenCalled()
    expect(helper.identity()).toBe('')
    // 讨论接口人的设定列出每位幕僚的模型，以及只能经工单运行的幕僚
    const lead = { id: room.session, session: { snapshotEvents: () => [], header: {} }, ctx: { systemPrompt: { section: ({ name, text }: { name: string; text: () => string }) => { sections.set(`lead:${name}`, text); return () => {} } } } }
    f.rooms.attachContext(lead as never)
    const prompt = sections.get('lead:chief-room-context')!()
    expect(prompt).toContain('strategist（谋士，模型 zhipu/glm-5.3（幕僚卡））')
    expect(prompt).toContain('engineer（工程师，执行器 codex，只能经工单运行，不在讨论里拉起）')
    expect(prompt).toContain('name 必须写幕僚 id')
    // 面向主人的文字用中文名：设定里给出 id→中文名对照，远程幕僚说明经工作电脑工单交办
    expect(prompt).toContain('幕僚 id 与中文名对照：chief = chief，researcher = researcher，strategist = 谋士，engineer = 工程师，ui-smith = ui-smith，liaison = 外务')
    expect(prompt).toContain('写给主人看的文字（汇总、回答、表格、待办、笔记）一律用幕僚中文名，需要时在括号里附 id')
    expect(prompt).toContain('liaison（外务，远程幕僚，在工作电脑上执行，只能经工作电脑工单交办')
    expect(prompt).toContain('按幕僚中文名逐一汇总给主人')
  })
})

describe('讨论里的只读调查与派工', () => {
  it('「为什么工程师老失败？」「自己看历史」：讨论接口人只读查看工单、简报与花名册，不能代主人操作', async () => {
    const f = host()
    await f.call('chief_inbox', { text: '修复构建脚本', operation: 'write' }, f.liaison(f.ownerTurn('帮我修复构建脚本')))
    const room = await f.rooms.create('why-failing', '工程师失败')
    const lead = f.leadOf(room.session)
    for (const name of ['chief_ticket', 'chief_brief', 'chief_lookup']) expect(roomTools.has(name)).toBe(true)
    const ticket = plain(await f.call('chief_ticket', { id: 'T-0001', action: 'view' }, lead))
    expect(ticket).toMatchObject({ id: 'T-0001', staff: 'engineer', rounds: [] })
    plain(await f.call('chief_brief', {}, lead))
    plain(await f.call('chief_lookup', { what: 'overview' }, lead))
    await expect(f.call('chief_ticket', { id: 'T-0001', action: 'approve' }, lead)).rejects.toThrow(/讨论成员不能代主人.*chief_ticket（action=view）/)
    await expect(f.call('chief_ticket', { id: 'T-9999', action: 'view' }, lead)).rejects.toThrow('可用 chief_brief 查看')
    expect(f.engine.views()[0]!.stage).toBe('you/approve')
  })

  it('简报列出最近结束的工单，讨论接口人不必逐个猜编号查历史', () => {
    const card = (id: string, outcome: 'failed' | 'done', note: string) => ({ id, title: `工单 ${id}`, stage: 'ended', staff: 'engineer', ended: { at: '2026-11-19T09:18:00Z', outcome, note } })
    const state = { paused: false, problems: [], you: [], roomActions: [], active: [], queued: [], ended: [card('T-0018', 'failed', '执行者异常结束（error）：Codex 回合中断\n详细'), card('T-0014', 'done', '已验收')],
      poc: { situation: { decide: 0, overdue: 0, dueToday: 0, blocked: 0, meetingsToday: 0, stale: 0 }, ledger: [], lines: [], meetings: [] } } as unknown as Parameters<typeof briefText>[0]
    const text = briefText(state)
    expect(text).toContain('最近结束 2 项（详情和各轮执行记录用 chief_ticket（action=view）按工单号查看）：')
    expect(text).toContain('- T-0018「工单 T-0018」失败（engineer）：执行者异常结束（error）：Codex 回合中断')
    expect(text).not.toContain('详细')
    expect(text).toContain('- T-0014「工单 T-0014」已办结（engineer）：已验收')
  })

  it('讨论里的 request_execution：主人原话授权、讨论接口人声明读写与限制，read 直接派工，write 等批准', async () => {
    const f = host()
    const room = await f.rooms.create('history', '工程师失败排查')
    const lead = f.leadOf(room.session)
    await f.ownerSays(room.id, '为什么工程师老失败？')
    const source = await f.ownerSays(room.id, '自己看历史，先别改')
    const real = { action: 'request_execution', source, title: '排查工程师历史任务反复失败的原因', staff: 'engineer', operation: 'read', restrictions: ['先别改'],
      scope: '只读查看可访问的历史工单、执行记录和相关错误日志；不修改配置、代码或数据。', done_when: ['列出失败工单与原因', '给出改进建议'] }
    // 11-19 日志里讨论接口人没给 operation：现在必须声明
    const { operation: _omit, ...undeclared } = real
    await expect(f.call('chief_room_note', undeclared, lead)).rejects.toThrow(/operation 必填/)
    const direct = plain(await f.call('chief_room_note', real, lead))
    expect(direct).toMatchObject({ ticketId: 'T-0001', message: '已登记工单 T-0001，只读调查已派给幕僚，无需批准。' })
    expect(f.outbox.enqueue).not.toHaveBeenCalled()
    const ticket = f.store.ticket('T-0001')!
    expect(ticket.mandate.level).toBe('think')
    expect(ticket.mandate.scope).toContain('主人原话：「自己看历史，先别改」')
    expect(ticket.mandate.scope).toContain(`接口人理解的任务：${real.scope}`)
    expect(ticket.superhub?.contracts[0]?.denied).toEqual(['先别改', '修改配置、代码或数据', '部署或对外发送'])
    expect(f.rooms.meta(room.id).tickets).toEqual(['T-0001'])
    expect(await f.call('chief_room_note', real, lead)).toMatchObject({ ticketId: 'T-0001' })
    await expect(f.call('chief_room_note', { ...real, operation: 'write' }, lead)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('读写方式') })
    await expect(f.call('chief_room_note', { ...real, title: '另一项', restrictions: ['不要部署'] }, lead)).rejects.toThrow('不是主人本轮原话里的片段')
    const write = plain(await f.call('chief_room_note', { ...real, title: '修复构建超时', scope: '修改构建脚本的超时配置并重跑构建', operation: 'write', restrictions: [] }, lead))
    expect(write).toMatchObject({ ticketId: 'T-0002', stage: 'you/approve', executor: 'codex', message: expect.stringContaining('批准') })
    expect(f.outbox.enqueue).toHaveBeenCalledTimes(1)
    expect(f.store.event(f.store.ticket('T-0002')!.mandate.eventId)?.meta).toMatchObject({ room_id: room.id, room_source: source })
    expect(f.rooms.meta(room.id).tickets).toEqual(['T-0001', 'T-0002'])
    await expect(f.call('chief_room_note', { ...real, source: 'nope' }, lead)).rejects.toThrow('不是触发本轮的主人原话')
    // 远程幕僚（外务，executor remote）不能在讨论里建单：说明要经工作电脑工单交办，而不只是「没有可用的本地幕僚」
    const remote = f.call('chief_room_note', { ...real, title: '请外务核对客户名单', staff: 'liaison', restrictions: [] }, lead)
    await expect(remote).rejects.toThrow(/「外务（liaison）」是远程幕僚.*远程幕僚需经工作电脑工单交办.*点名交给外务/)
    expect(f.store.tickets()).toHaveLength(2)
  })

  it('讨论里的 request_execution 只接受触发本轮的主人原话；网页「提交执行审批」仍可用较早的原话', async () => {
    const f = host()
    const room = await f.rooms.create('stale', '构建排查')
    const lead = f.leadOf(room.session)
    const first = await f.ownerSays(room.id, '自己看历史')
    const ask = { action: 'request_execution', title: '排查工程师失败', staff: 'engineer', operation: 'read', scope: '只读查看历史工单和执行记录；不修改配置、代码或数据。' }
    expect(await f.call('chief_room_note', { ...ask, source: first }, lead)).toMatchObject({ ticketId: 'T-0001' })
    f.endTurn(room.session)
    f.memberSays(room.session, '我查完了，建议再开一单调研构建时长')
    await expect(f.call('chief_room_note', { ...ask, source: first, title: '调研构建时长', scope: '只读调研构建时长分布' }, lead))
      .rejects.toThrow(/本轮不是由主人的消息触发.*ask_owner/)
    expect(await f.call('chief_room_note', { ...ask, source: first }, lead)).toMatchObject({ ticketId: 'T-0001' })
    f.endTurn(room.session)
    const second = await f.ownerSays(room.id, '那就再查一下构建时长和失败率')
    await expect(f.call('chief_room_note', { ...ask, source: first, title: '调研构建时长', scope: '只读调研构建时长分布' }, lead))
      .rejects.toThrow(`不是触发本轮的主人原话，未建单。请用本轮主人原话的标识（${second}）`)
    expect(await f.call('chief_room_note', { ...ask, source: second, title: '调研构建时长', scope: '只读调研构建时长分布' }, lead)).toMatchObject({ ticketId: 'T-0002' })
    expect(await f.call('chief_room_note', { ...ask, source: second, title: '统计失败率', scope: '只读统计近一月构建失败率' }, lead)).toMatchObject({ ticketId: 'T-0003' })
    expect(await f.call('chief_room_note', { ...ask, source: second, title: '统计失败率', scope: '只读统计近一月构建失败率' }, lead)).toMatchObject({ ticketId: 'T-0003' })
    expect(f.store.tickets().map(ticket => ticket.id)).toEqual(['T-0001', 'T-0002', 'T-0003'])
    // 主人在网页上亲自「提交执行审批」不经讨论接口人的回合，可以选较早的原话（固定为 write，等主人批准）
    expect(await f.requestRoomExecution(room.id, { source: first, title: '复核失败记录', staff: 'engineer', scope: '只读复核 T-0001 的失败记录', operation: 'write' })).toMatchObject({ ticketId: 'T-0004', stage: 'you/approve' })
  })

  it('inTurnOwnerMessages 只算最近一次 turn/end 之后、宿主确认的主人输入（含中途插入）', () => {
    const owner = (seq: number, rpcId?: string) => ({ type: 'user/message', seq, time: seq, data: { id: `u${seq}`, source: { kind: 'user', ...rpcId ? { rpcId } : {} }, content: [{ type: 'text', text: `原话 ${seq}` }] } })
    const events: SessionEventLike[] = [
      owner(1, 'rpc-1'), { type: 'turn/end', seq: 2, time: 2, data: {} },
      { type: 'user/message', seq: 3, time: 3, data: { id: 'a3', source: { kind: 'agent-message', senderSessionId: 'member' }, content: [{ type: 'text', text: '成员回报' }] } },
      owner(4), owner(5, 'rpc-5'),
      { type: 'agent/inbox/spliced', seq: 6, time: 6, data: { inserted: [
        { id: 'a6', source: { kind: 'agent-message', senderSessionId: 'member' }, content: [{ type: 'text', text: '成员插话' }] },
        { id: 'u6', source: { kind: 'user', rpcId: 'rpc-6' }, content: [{ type: 'text', text: '主人插话' }] },
      ] } },
    ]
    expect(inTurnOwnerMessages('lead', events)).toEqual(['lead:5', 'lead:6:1'])
    expect(inTurnOwnerMessages('lead', [...events, { type: 'turn/end', seq: 7, time: 7, data: {} }])).toEqual([])
  })
})

it('接口人只从宿主确认的位置给点名的本区幕僚开单，并逐字保存主人明确纠正的做法', async()=>{
  const f = host()
  const {workspace} = f.workspaceStore.assign('local-member-scope','建立试点')
  const roster = f.staffStore.apply(workspace.id,{action:'create',requestId:'person',name:'访谈员',brief:'整理提纲'})
  const member = roster.members[0]!
  const talk = async(text:string,requestId:string,operation?:'read')=>{
    await f.intake.submit({scope,text,requestId,context:{surface:'workspace',selectedId:workspace.id},operation},{channel:operation ? 'owner' : 'chat'})
    return f.liaison(f.ownerTurn(text,requestId))
  }
  const turn = await talk('访谈员，记住每次先复述约定','staff-remember')
  const args = {action:'remember_staff',staff_name:'访谈员',quote:'每次先复述约定'}
  expect((await f.call('chief_workspace',{action:'list_staff'},turn)).members).toEqual([expect.objectContaining({id:member.id})])
  await f.call('chief_workspace',args,turn)
  await f.call('chief_workspace',args,turn)
  expect(f.staffStore.view(workspace.id).memories.map(m=>m.text)).toEqual(['每次先复述约定'])
  await expect(f.call('chief_workspace',{...args,quote:'虚构内容'},turn)).rejects.toThrow('引用')
  const consult = await talk('读取访谈员的“每次先复述约定”','staff-query','read')
  await expect(f.call('chief_workspace',args,consult)).rejects.toThrow()
  const assign = await talk('让访谈员撰写明天的访谈提纲','staff-work')
  const job = await f.call('chief_workspace',{action:'assign',staff_name:'访谈员',title:'访谈提纲',promise:'交付明天的访谈提纲'},assign)
  expect(f.workspaceStore.delegation(workspace.id,(job.order as {id:string}).id)).toMatchObject({staffId:member.id,owner:member.name})
})

describe('已归档的工作区与接口人', () => {
  const archived = (f: ReturnType<typeof host>, name: string) => {
    const body = {requestId: 'ws-' + name.length, name}
    const space = f.workspaceStore.createWorkspace(mutationKey(['v2', 'workspaces'], body), body).workspace
    return space
  }
  const archive = (f: ReturnType<typeof host>, id: string) => f.workspaceStore.archive(mutationKey(['v2', 'workspaces', id, 'archive'], {requestId: 'archive-' + id.slice(0, 8)}), id).workspace

  it('list 标出已归档；派单、补充、改目录、同名新建都被拒并请主人先恢复，什么也不保存；归档区仍可查约定', async () => {
    const f = host()
    const space = archived(f, '字节 Landing'), other = archived(f, '季度评审')
    const {delegation: order} = f.workspaceStore.assign('before-archive', '整理落地页文案', 'dsh', space.id)
    f.workspaceStore.act(mutationKey(['act'], {requestId: 'done'}), space.id, order.id, {action: 'complete'})
    archive(f, space.id)
    const refusal = '「字节 Landing」已归档，请先在工作区页恢复'
    const listed = await f.call('chief_workspace', {action: 'list'}) as {workspaces: Record<string, unknown>[]}
    expect(listed.workspaces).toEqual([expect.objectContaining({id: space.id, archived: true}), expect.not.objectContaining({archived: true})])
    expect(listed.workspaces[1]).toMatchObject({id: other.id})
    const turn = (text: string, id: string) => f.liaison(f.ownerTurn(text, id))
    await expect(f.call('chief_workspace', {action: 'assign', name: '字节 Landing', title: '改版', promise: '交付新版落地页'}, turn('在字节 Landing 做个改版', 'a-1'))).rejects.toThrow(refusal)
    await expect(f.call('chief_workspace', {action: 'set_directory', name: '字节 Landing', directory: ''}, turn('解除字节 Landing 的项目目录', 'a-2'))).rejects.toThrow(refusal)
    await expect(f.call('chief_workspace', {action: 'follow_order', work_order_id: order.id}, turn('工单 ' + order.id + ' 再补一句：标题要短', 'a-3'))).rejects.toThrow(refusal)
    await expect(f.call('chief_workspace', {action: 'create', name: '字节 Landing'}, turn('建一个工作区叫字节 Landing', 'a-4'))).rejects.toThrow(refusal)
    await expect(f.call('chief_order_followup', {action: 'schedule', work_order_id: order.id, weekday: 5, time: '17:00'}, turn('工单 ' + order.id + ' 每周五出稿', 'a-5'))).rejects.toThrow(refusal)
    expect(await f.call('chief_order_followup', {action: 'read', work_order_id: order.id}, turn('工单 ' + order.id + ' 有哪些约定？', 'a-6'))).toMatchObject({delegation: {id: order.id}})
    expect(f.workspaceStore.list()).toHaveLength(2)
    expect(f.workspaceStore.view(space.id).orders).toHaveLength(1)

    // From the archived workspace's own page: the liaison knows where the owner is, and that nothing new goes there.
    const page = {surface: 'workspace', selectedId: space.id, sessionId: order.sessionId, workOrderId: order.id}
    const fromPage = async (text: string, requestId: string, operation?: 'read') => {
      await f.intake.submit({scope, text, requestId, context: page, ...(operation && {operation})}, {channel: operation ? 'owner' : 'chat'})
      return turn(text, requestId)
    }
    const surface = liaisonSurfaceContext(page, f.workspaceStore.list())
    expect(surface).toContain('已归档的工作区 "字节 Landing"')
    expect(surface).not.toContain(space.id)
    await expect(f.call('chief_workspace', {action: 'assign', title: '改版', promise: '交付新版落地页'}, await fromPage('在这里做个改版', 'p-1'))).rejects.toThrow(refusal)
    await expect(f.call('chief_workspace', {action: 'set_directory', directory: ''}, await fromPage('解除这里的项目目录', 'p-2'))).rejects.toThrow(refusal)
    await expect(f.call('chief_workspace', {action: 'follow_order'}, await fromPage('这单再补一句', 'p-3'))).rejects.toThrow(refusal)
    expect(await f.call('chief_workspace', {action: 'read_order'}, await fromPage('读一下这张单', 'p-4'))).toMatchObject({order: {id: order.id}})
    expect(await f.call('chief_order_followup', {action: 'read'}, await fromPage('这单有哪些约定？', 'p-5', 'read'))).toMatchObject({delegation: {id: order.id}})
    await expect(f.call('chief_order_followup', {action: 'schedule', weekday: 5, time: '17:00'}, await fromPage('这单每周五出稿', 'p-6'))).rejects.toThrow(refusal)
    expect(f.workspaceStore.view(space.id).orders).toEqual([expect.objectContaining({id: order.id, status: 'done'})])
    expect(f.workspaceStore.workspace(space.id).projectDirectory).toBeUndefined()
  })

  it('chief_staff create 带 workspace：按主人原话建该区专属幕僚，不进全局名册；重放不重复，同名、不适用字段、未点名、不存在与已归档都被拒', async () => {
    const f = host({groups: true})
    const refresh = vi.spyOn(f.groups!, 'refresh')
    const saveStaff = vi.spyOn(f.brain, 'saveStaff')
    const space = archived(f, '字节 Landing'), closed = archived(f, '旧项目')
    archive(f, closed.id)
    const card = {action: 'create', workspace: '字节 Landing', name: '竞品观察员', brief: '盯竞品的定价、发布与渠道动作，每周汇总成一页要点。'}
    const text = '给字节 Landing 加一个盯竞品的幕僚', auth = f.liaison(f.ownerTurn(text, 'staff-here'))
    const local = () => f.staffStore.view(space.id).members.filter(m => m.homeWorkspaceId === space.id)

    await expect(f.call('chief_staff', card, f.liaison(f.ownerTurn('加一个盯竞品的幕僚', 'staff-unnamed')))).rejects.toThrow('主人原话里没有工作区「字节 Landing」')
    await expect(f.call('chief_staff', {...card, workspace: '不存在的项目'}, f.liaison(f.ownerTurn('给不存在的项目加个人', 'staff-missing')))).rejects.toThrow('没有名为「不存在的项目」的工作区')
    await expect(f.call('chief_staff', {...card, workspace: '旧项目'}, f.liaison(f.ownerTurn('给旧项目加一个盯竞品的幕僚', 'staff-closed')))).rejects.toThrow('「旧项目」已归档，请先在工作区页恢复')
    await expect(f.call('chief_staff', {...card, verifier: 'reviewer'}, auth)).rejects.toThrow('专属幕僚由接口人在群里验收，不设 verifier')
    await expect(f.call('chief_staff', {...card, executor: 'remote'}, auth)).rejects.toThrow('专属幕僚的 executor 只能是 dsh、codex 或 claude-code')
    await expect(f.call('chief_staff', {...card, model: 'zhipu/glm-5.3'}, auth)).rejects.toThrow('没有模型目录')
    await expect(f.call('chief_staff', {...card, brief: '太短'}, auth)).rejects.toThrow('角色卡太短')
    await expect(f.call('chief_staff', {...card, action: 'retire', id: 'researcher'}, auth)).rejects.toThrow('workspace 只用于 create 和 update')
    expect(local()).toEqual([])
    expect(f.staffStore.view(closed.id).members).toEqual([])

    const created = plain(await f.call('chief_staff', {...card, portrait_shape: 'lighthouse', id: 'ignored-id'}, auth))
    expect(created).toMatchObject({workspace: {id: space.id, name: '字节 Landing'}, staff: {name: '竞品观察员', executor: 'dsh'}, message: '已在「字节 Landing」加入专属幕僚「竞品观察员」，由 DSH 执行。下一张工单起生效。'})
    expect(local()).toEqual([expect.objectContaining({name: '竞品观察员', brief: card.brief, defaultPortrait: expect.objectContaining({shape: 'lighthouse'}),
      memberships: [{workspaceId: space.id, duty: ''}]})])
    expect(refresh).toHaveBeenCalledWith(space.id)
    expect(saveStaff).not.toHaveBeenCalled()
    expect(f.brain.staff().some(row => row.name === '竞品观察员')).toBe(false)
    // A retry of the same owner turn is the same creation; another turn with the same name is refused.
    expect(await f.call('chief_staff', {...card, portrait_shape: 'lighthouse', id: 'ignored-id'}, auth)).toEqual(created)
    expect(local()).toHaveLength(1)
    await expect(f.call('chief_staff', card, f.liaison(f.ownerTurn('再给字节 Landing 加一个盯竞品的幕僚', 'staff-again')))).rejects.toThrow('本工作区已有专属幕僚「竞品观察员」')
    // A short confirmation carries the workspace named in the owner's previous words.
    const earlier = f.ownerTurn('给字节 Landing 加个做访谈的幕僚', 'staff-ask'), end = {type: 'turn/end', seq: 3, time: 3, data: {}}
    const confirmed = await f.call('chief_staff', {...card, name: '访谈员', brief: '安排并主持用户访谈，整理成访谈纪要与关键发现。'},
      f.liaison([...earlier, end, ...f.ownerTurn('好，就这样', 'staff-confirm')]))
    expect(confirmed).toMatchObject({message: '已在「字节 Landing」加入专属幕僚「访谈员」，由 DSH 执行。下一张工单起生效。'})
    expect(local().map(m => m.name)).toEqual(['竞品观察员', '访谈员'])
    expect(f.staffStore.view(closed.id).members).toEqual([])
  })

  it('chief_staff 带 workspace 给专属幕僚指定执行器与模型：create 照填、update 只改点名的项，全局幕僚与未点名都被拒', async () => {
    const llm = {
      listProviders: () => [{id: 'openai-codex', name: 'OpenAI Codex'}],
      listModels: async () => [{id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol'}],
      resolveModelInfo: async () => ({reasoning: {efforts: [{id: 'medium', name: 'Medium'}, {id: 'high', name: 'High'}]}}),
    }
    const f = host({groups: true, llm})
    const space = archived(f, '命运')
    const local = () => f.staffStore.view(space.id).members.filter(m => m.homeWorkspaceId === space.id)
    const brief = '依据六爻解卦原则解读卦象，先调用六爻引擎排盘，再区分盘面与解读。'
    const created = plain(await f.call('chief_staff', {action: 'create', workspace: '命运', name: '六爻卦师', brief, model: 'gpt-6.1-sol', reasoning_effort: 'High'},
      f.liaison(f.ownerTurn('在命运里创建一个幕僚叫六爻卦师，模型设置为 gpt 6.1 sol high', 'liuyao-create'))))
    expect(created).toMatchObject({staff: {name: '六爻卦师', executor: 'dsh', model: 'openai-codex/gpt-6.1-sol', reasoningEffort: 'high',
      effectiveModel: 'openai-codex/gpt-6.1-sol', effectiveReasoningEffort: 'high', modelSource: '专属幕僚配置'}})
    await expect(f.call('chief_staff', {action: 'create', workspace: '命运', name: '工程师', brief: '编写合适的程序，读懂现有代码后再动手，跑通测试再交付。', reasoning_effort: 'ultra', model: 'gpt-6.1-sol'},
      f.liaison(f.ownerTurn('给命运加个工程师', 'engineer-bad')))).rejects.toThrow('没有思考深度 ultra')
    plain(await f.call('chief_staff', {action: 'create', workspace: '命运', name: '工程师', brief: '编写合适的程序，读懂现有代码后再动手，跑通测试再交付。'},
      f.liaison(f.ownerTurn('给命运加个工程师', 'engineer-create'))))
    expect(local().find(m => m.name === '工程师')).not.toHaveProperty('executor')

    const toCodex = f.liaison(f.ownerTurn('把命运工作区的工程师改成 Codex', 'engineer-codex'))
    await expect(f.call('chief_staff', {action: 'update', workspace: '命运', name: '工程师'}, toCodex)).rejects.toThrow('update 需要至少一项要改的内容')
    await expect(f.call('chief_staff', {action: 'update', workspace: '命运', name: '不存在'}, toCodex)).rejects.toThrow('「命运」里没有幕僚「不存在」。本区现有：六爻卦师、工程师')
    await expect(f.call('chief_staff', {action: 'update', workspace: '命运', name: '工程师', executor: 'codex'},
      f.liaison(f.ownerTurn('把工程师改成 Codex', 'engineer-unnamed')))).rejects.toThrow('主人原话里没有工作区「命运」')
    const updated = plain(await f.call('chief_staff', {action: 'update', workspace: '命运', name: '工程师', executor: 'codex'}, toCodex))
    expect(updated).toMatchObject({staff: {name: '工程师', executor: 'codex', modelSource: 'Codex 配置'}, message: '已更新「命运」的专属幕僚「工程师」，由 Codex 执行。下次在群里叫它时生效。'})
    expect(await f.call('chief_staff', {action: 'update', workspace: '命运', name: '工程师', executor: 'codex'}, toCodex)).toEqual(updated)
    expect(local().find(m => m.name === '工程师')).toMatchObject({executor: 'codex', brief: '编写合适的程序，读懂现有代码后再动手，跑通测试再交付。'})
    // Only the named field changes: the brief stays, the model of 六爻卦师 keeps its effort.
    plain(await f.call('chief_staff', {action: 'update', workspace: '命运', name: '六爻卦师', executor: 'dsh'},
      f.liaison(f.ownerTurn('命运的六爻卦师继续用 DSH', 'liuyao-dsh'))))
    expect(local().find(m => m.name === '六爻卦师')).toMatchObject({model: 'openai-codex/gpt-6.1-sol', reasoningEffort: 'high', brief})
    expect(local().find(m => m.name === '六爻卦师')).not.toHaveProperty('executor')

    f.staffStore.apply(space.id, {action: 'join', staffId: 'researcher', duty: '', requestId: 'join-researcher'})
    await expect(f.call('chief_staff', {action: 'update', workspace: '命运', name: 'researcher', executor: 'codex'},
      f.liaison(f.ownerTurn('把命运里的 researcher 改成 Codex', 'researcher-codex')))).rejects.toThrow('是全局幕僚，以全局角色卡为准')
    await f.intake.submit({scope, text: '看看这里有哪些幕僚', requestId: 'list-staff', context: {surface: 'workspace', selectedId: space.id}}, {channel: 'chat'})
    const listed = plain(await f.call('chief_workspace', {action: 'list_staff'}, f.liaison(f.ownerTurn('看看这里有哪些幕僚', 'list-staff')))) as {members: {name: string}[]}
    expect(listed.members).toEqual(expect.arrayContaining([expect.objectContaining({name: '工程师', executor: 'codex'}),
      expect.objectContaining({name: '六爻卦师', executor: 'dsh', effectiveModel: 'openai-codex/gpt-6.1-sol'})]))
  })
})

describe('chief_schedule：定时安排的唯一入口', () => {
  const ACCEPTANCE = '每周一到周五上午 9:00 检查并提醒我各工作区尚未关闭的工单'
  const openOrders = { action: 'set', title: '未关闭工单提醒', when: 'weekdays 09:00', content: 'open-orders' }

  it('验收原话：回执写明下一次时间、投递到接口人对话、是否推送和查看位置，清单里出现该条', async () => {
    const f = host()
    const receipt = plain(await f.call('chief_schedule', openOrders, f.liaison(f.ownerTurn(ACCEPTANCE, 'acceptance'))))
    expect(receipt.message).toBe('已建立「未关闭工单提醒」：工作日 09:00。下一次 2026-11-26 周四 09:00（Asia/Shanghai）。'
      + '到点会在接口人对话里提醒你；还没配置推送地址，所以不会推送到手机。可在「设置 → 定时安排」查看、停用或删除。')
    expect(receipt).toMatchObject({ created: true, next: '2026-11-26T01:00:00.000Z', schedule: { title: '未关闭工单提醒', when: 'weekdays 09:00', content: 'open-orders', by: 'owner', enabled: true } })
    const listed = plain(await f.call('chief_schedule', { action: 'list' }))
    expect((listed.schedules as { title: string }[]).map(row => row.title)).toEqual(['每周经验整理', '早报', '晚报', '未关闭工单提醒'])
    const pushed = host({ push: true })
    const withPush = await pushed.call('chief_schedule', openOrders, pushed.liaison(pushed.ownerTurn(ACCEPTANCE, 'acceptance')))
    expect(withPush.message).toContain('到点会在接口人对话里提醒你，同时推送到手机。')
    // 描述里写明回执即承诺：不得承诺回执以外的渠道。
    expect(JSON.stringify(f.registered.get('chief_schedule'))).toMatch(/回执的 message 就是对主人的承诺/)
  })

  it('主人的安排需要本轮原话；接口人自己的跟进只能是一次性提醒，且同样进清单', async () => {
    const f = host()
    const earlier = f.ownerTurn(ACCEPTANCE, 'earlier')
    await expect(f.call('chief_schedule', openOrders, f.liaison([...earlier, { type: 'turn/end', seq: 3, time: 3, data: {} }]))).rejects.toThrow('主人原话')
    await expect(f.call('chief_schedule', openOrders, { agent: { id: 'staff', session: { snapshotEvents: () => earlier } } } as never)).rejects.toThrow('主人原话')
    expect(f.schedules.list().filter(row => row.by !== 'system')).toEqual([])
    const outside = f.liaison([...earlier, { type: 'turn/end', seq: 3, time: 3, data: {} }])
    await expect(f.call('chief_schedule', { action: 'set', for: 'self', when: 'daily 09:00', text: '看看' }, outside)).rejects.toThrow('一次性')
    await expect(f.call('chief_schedule', { action: 'set', for: 'self', at: '2026-11-27T09:00', content: 'open-orders' }, outside)).rejects.toThrow('reminder')
    await expect(f.call('chief_schedule', { action: 'set', for: 'self', at: '2026-11-20T09:00', text: '已过去' }, outside)).rejects.toThrow('已经过了')
    const self = plain(await f.call('chief_schedule', { action: 'set', for: 'self', at: '2026-11-27T09:00', text: '看周岚给没给评审意见' }, outside))
    expect(self.message).toContain('已给自己定好跟进「跟进：看周岚给没给评审意见」：2026-11-27 09:00 一次。下一次 2026-11-27 周五 09:00')
    expect(self.schedule).toMatchObject({ by: 'liaison', content: 'reminder', at: '2026-11-27T09:00', removable: true })
    const owned = await f.call('chief_schedule', openOrders, f.liaison(f.ownerTurn(ACCEPTANCE, 'acceptance')))
    const id = (owned.schedule as { id: string }).id
    await expect(f.call('chief_schedule', { action: 'set', for: 'self', id, at: '2026-11-27T10:00', text: '改掉' }, outside)).rejects.toThrow('主人的定时安排')
  })

  it('停用、恢复、删除；系统内置的只能停用；修改只改给出的字段', async () => {
    const f = host()
    const created = await f.call('chief_schedule', openOrders, f.liaison(f.ownerTurn(ACCEPTANCE, 'acceptance')))
    const id = (created.schedule as { id: string }).id
    expect(id).toMatch(/^open-orders-[0-9a-f]{4}$/)
    expect((await f.call('chief_schedule', { action: 'disable', id })).message).toBe('已停用「未关闭工单提醒」，在「设置 → 定时安排」里可以重新打开。')
    expect(f.schedules.get(id)?.enabled).toBe(false)
    expect((await f.call('chief_schedule', { action: 'enable', id })).message).toContain('下一次 2026-11-26 周四 09:00')
    const moved = await f.call('chief_schedule', { action: 'set', id, when: 'weekly mon,thu 08:00' }, f.liaison(f.ownerTurn('改成周一和周四早上 8 点', 'move')))
    expect(moved).toMatchObject({ created: false, schedule: { title: '未关闭工单提醒', whenLabel: '每周一、四 08:00', content: 'open-orders' } })
    await expect(f.call('chief_schedule', { action: 'remove', id: 'weekly-dream' })).rejects.toThrow('不能删除，可以停用')
    await expect(f.call('chief_schedule', { action: 'set', id: 'morning-brief', content: 'reminder', text: 'x' }, f.liaison(f.ownerTurn('早报改成提醒', 'brief')))).rejects.toThrow('不能改内容类别')
    const brief = await f.call('chief_schedule', { action: 'set', id: 'morning-brief', when: 'weekdays 09:00' }, f.liaison(f.ownerTurn('早报改到 9 点', 'brief-time')))
    expect(brief.message).toContain('这条安排目前已停用')
    expect((await f.call('chief_schedule', { action: 'remove', id })).message).toBe('已删除定时安排「未关闭工单提醒」，之后不会再提醒。')
    expect(f.schedules.get(id)).toBeUndefined()
    await expect(f.call('chief_schedule', { action: 'set', title: '每半小时', when: 'every 30m', content: 'open-orders' }, f.liaison(f.ownerTurn('每半小时提醒', 'every')))).rejects.toThrow('不支持按间隔重复')
  })

  it('停用、恢复、删除主人或系统的安排需要主人本轮原话；接口人自己的跟进可以自己停', async () => {
    const f = host()
    const outside = f.liaison([...f.ownerTurn(ACCEPTANCE, 'earlier'), { type: 'turn/end', seq: 3, time: 3, data: {} }] as never)
    const owned = await f.call('chief_schedule', openOrders, f.liaison(f.ownerTurn(ACCEPTANCE, 'acceptance')))
    const id = (owned.schedule as { id: string }).id
    const before = f.schedules.list()
    for (const action of ['disable', 'remove']) {
      await expect(f.call('chief_schedule', { action, id }, outside)).rejects.toThrow('需要本轮接口人会话中经宿主确认的主人原话')
    }
    await expect(f.call('chief_schedule', { action: 'disable', id: 'weekly-dream' }, outside)).rejects.toThrow('主人原话')
    await expect(f.call('chief_schedule', { action: 'enable', id: 'morning-brief' }, outside)).rejects.toThrow('主人原话')
    await expect(f.call('chief_schedule', { action: 'disable', id }, { agent: { id: 'staff', session: { snapshotEvents: () => [] } } } as never)).rejects.toThrow()
    expect(f.schedules.list()).toEqual(before)

    const self = await f.call('chief_schedule', { action: 'set', for: 'self', at: '2026-11-27T09:00', text: '看周岚给没给评审意见' }, outside)
    const selfId = (self.schedule as { id: string }).id
    expect((await f.call('chief_schedule', { action: 'disable', id: selfId }, outside)).message).toContain('已停用')
    expect(f.schedules.get(selfId)?.enabled).toBe(false)
    expect((await f.call('chief_schedule', { action: 'remove', id: selfId }, outside)).message).toContain('已删除')
    expect(f.schedules.get(selfId)).toBeUndefined()

    const turn = f.liaison(f.ownerTurn('先把未关闭工单提醒停掉', 'stop'))
    expect((await f.call('chief_schedule', { action: 'disable', id }, turn)).message).toBe('已停用「未关闭工单提醒」，在「设置 → 定时安排」里可以重新打开。')
    expect((await f.call('chief_schedule', { action: 'enable', id }, turn)).message).toContain('已恢复「未关闭工单提醒」')
    expect((await f.call('chief_schedule', { action: 'remove', id }, turn)).message).toContain('已删除')
    expect(f.schedules.get(id)).toBeUndefined()
    await expect(f.call('chief_schedule', { action: 'disable', id }, turn)).rejects.toThrow('没有这条定时安排')
  })

  it('chief_settings 不再有规则动作，show 指向 chief_schedule', async () => {
    const f = host()
    const settings = f.registered.get('chief_settings')!
    expect(JSON.stringify(settings.parameters)).not.toMatch(/rule/)
    expect(await f.call('chief_settings', { action: 'show' })).toMatchObject({ schedules: expect.stringContaining('chief_schedule list') })
    expect(f.registered.has('chief_followup')).toBe(false)
  })
})
