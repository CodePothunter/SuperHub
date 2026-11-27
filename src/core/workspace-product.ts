import type { IntakeContext } from './superhub-intake.ts'
import { workspaceArchived, type V2Workspace } from './workspace-v2.ts'
import { selectableCalendarDate } from './workspace-calendar.ts'

/** Product names shared by the daily navigation and the liaison's orientation. */
export const SUPERHUB_SURFACES = {
  today: { label: '今天', description: '可以直接找接口人交办，也可以导入、导出或打开已有资料。主人随时可以说要办的事。' },
  workspace: { label: '工作区', description: '可以新开或续接普通对话。任务交付可另立工单，每张工单属于一场负责会话。工单保留原话、约定、待回应事项和成果。' },
  people: { label: '人物', description: '现实中的联系人按组织归属浏览，重要性独立显示，次级关系来自档案。幕僚名单另用 chief_staff 查询。' },
  calendar: { label: '日历', description: '按日期查看会议、工单检查点及已授权来源的日程。主人问哪天有何安排、何时有空时用 chief_calendar 核对。来源未连接或暂不可读时，说明能看到的范围。' },
  history: { label: '已有资料', description: '从今天进入，查看以前导入的记录和来源。' },
  settings: { label: '设置', description: '可以查看时区、同时工作的幕僚和接口人模型。DSH 桌面可管理模型、提醒、手机访问和资料位置。' },
} as const
export type SuperhubSurface = keyof typeof SUPERHUB_SURFACES

export const CALENDAR_TOOL = {
  name: 'chief_calendar',
  description: '从主人当前 SuperHub 日历读取已获准的日程。用 date 指定当地日期，range 选择当天或整周，省略日期是当前日期。仅忙闲资源只返回占用时段。回答时区分已登记事项和建议安排，说明未能读取的来源。',
} as const

export const WORKSPACE_TOOL = {
  name: 'chief_workspace',
  description: [
    '从「今天」或任一页面直接查找和操作 SuperHub 工作区。list 读取同脑清单，可用 query 按名称、目标、负责人查找。已有区可用主人点名的全名 name，或用 workspace_id 和主人逐字说出的目标线索 target_quote。唯一且能核实就直接办。多个候选时列出目标或负责人的区别，问清一次，收到选择后继续。',
    '「这里」用当前页面。续办且上条主人原话已指明目标时用 target_source=previous，沿用原话中的 name 或 target_quote。「刚才那个」也可用 target_source=receipt，摘录本轮指代并核对上一轮的实际工具回执。主人按上轮候选序号明确选择时使用 target_choice，并带本轮 target_quote。主人这次改了目标时使用新目标。',
    '主人要在工作区开对话并问问题时，直接 start_session，给简洁 title，并把主人的完整问题逐字摘为 question。这个动作创建普通群聊，零工单，带问题时会叫本区成员处理。仅要求建空对话时省略 question。同一问题明确要求再开一场时沿用原问题，并摘录本轮 new_session_quote。要往原对话送话时先用 list_sessions 核实会话，send_session 带 session_id、主人点名的 session_quote 和实际 trace_id。主人打开的会话可沿用本轮选区。',
    '两轮说的是同一个待办事项时，request_source=previous 带回上条原问题。此前若返回了待选择的工作区候选，request_source=pending 可带回那件事。此前若已完成对话或工单动作，也可用 request_source=receipt 指回该回执的原任务。以本轮主人原话决定是开始、改口、继续等候还是取消。主人改了问题时，从本轮取得新问题。「你帮我做就行，带工单也行，你就启动吧」优先用 start_session 继续上轮的普通对话，沿用已指明的项目和原问题，无需重新点名。已收到对话回执时回到原对话。确实未能送达并且主人允许工单备用时，assign 带 order_mode=fallback 和本轮 order_quote。主人明确改用工单时用 explicit 并照录本轮授权。',
    '建工作区用 create，name 用原名，主人已经给了 goal 或 directory 时可一并写入。改已有工作区名称或目标用 update_workspace，只给明确要改的新名称 new_name 或 goal。清空目标填空字符串和 clear_goal_quote。改绑目录用 set_directory，directory 照录主人给的绝对路径，解除时填空字符串。查询本区幕僚用 list_staff，创建和配置专属幕僚用 chief_staff。归档工作区只读，可从实际工作区页面恢复。',
    '主人明确托付一份新成果时用 assign，title 概括主题，promise 说明交付约定。负责人按群聊分工由接口人 @，不再选择执行者，executor 不用填。主人本轮点名某位幕僚时可先 list_staff 核实，staff_name 照录称呼，交办会直接 @ 此人。只提 Codex、Claude Code 等工具名时不用填 staff_name。主人本轮原话为这一单明确写出目录时，directory 按原话设置。handoff 写你的交办说明，宿主会附上主人的原话。从已选群聊交办通常沿用该群。从「今天」交办且没有指定项目时进入「我的交办」。',
    '查看已有工单用 list_orders、read_order。补充或改要求用 follow_order，当前点开的工单可以直接继续。在本段对话最近开出的工单中，按主人所述认出是哪一张，用那次回执 order.id 续办，无需主人另报工单号。本段对话以外的工单需要选中或点明编号。已退役的原生工单（T-编号）用 assign 新开工作区工单，在 handoff 保留旧编号、已有结论和受阻原因。',
    '主人要取消尚待投递的普通对话时，cancel_session_request 使用原请求及本轮 cancel_quote。主人只问用法、举例或查阅时给出只读答复。报告创建、送达、答复或实际配置时以工具返回为据。',
  ].join('\n'),
} as const

export const ORDER_FOLLOWUP_TOOL = {
  name: 'chief_order_followup',
  description: '在 SuperHub 工单里查约定、跟进和周报。记录用 record，将主人本轮或原工单消息里的逐条原话一次放入 entries，分清我方答应 mine、对方答应 theirs、只提出但还没答应的 request。查看已记的约定或本周成稿用 read；需要查证工单会话时用 sources。主人明确说办妥了再 resolve，托付每周出稿用 schedule，要现在产出本周成稿用 draft。只咨询做法、举例或设想时直接解释。出稿后主人可自行转发。上述功能可直接用 SuperHub 内的资料。',
} as const

/** Only current, known UI coordinates go into the prompt. A typed name or text never selects a workspace. */
export function liaisonSurfaceContext(context: IntakeContext | undefined, workspaces: readonly V2Workspace[], details?: {
  personName:(id:string)=>string|undefined; today:string
  focus?: {session?: {id:string;title:string}; order?: {id:string;title:string}}
}): string {
  const surface = context?.surface
  if (!surface || !Object.hasOwn(SUPERHUB_SURFACES, surface)) return ''
  const label = SUPERHUB_SURFACES[surface as SuperhubSurface].label
  const location = `本轮主人从「${label}」发言。`
  const selected = context?.selectedId
  if (surface === 'calendar') {
    const day = selected ?? details?.today
    return selectableCalendarDate(day) ? `${location}当前选中日期为 ${day}。` : location
  }
  if (surface === 'people' && selected?.startsWith('person:')) {
    const name = details?.personName(selected)
    return name ? `${location}当前打开的人物姓名为 ${JSON.stringify(name)}，档案标识为 ${JSON.stringify(selected)}。问到这位人物时，用 chief_lookup 的 person 和 selected_id 读取这份档案。` : location
  }
  if (surface !== 'workspace' || !selected) return location
  const space = workspaces.find(row => row.id === selected)
  if (!space) return ''
  // An archived workspace is no target: the liaison only knows where the owner is, and that it takes no work.
  if (workspaceArchived(space)) return `${location}主人正在查看已归档的工作区 ${JSON.stringify(space.name)}，它不再接新工作；主人要在这里继续做事时，请他先在工作区页恢复。`
  const session = details?.focus?.session, order = details?.focus?.order
  return `${location}当前项目数据 ${JSON.stringify({ id: space.id, name: space.name,
    ...(session && {session:{id:session.id,title:session.title}}), ...(order && {workOrder:{id:order.id,title:order.title}}) })}。`
}

export const LIAISON_PRODUCT_GUIDE = [
  '你是 SuperHub 的接口人，也是主人日常交办的承接人。直接接手明确的要求。主人说的工作区通常指 SuperHub 中的项目空间。',
  ...Object.values(SUPERHUB_SURFACES).map(surface => `「${surface.label}」${surface.description}`),
  `${WORKSPACE_TOOL.name}：${WORKSPACE_TOOL.description}`,
  '用 chief_order_followup 处理具体的双方约定及工单周报。在当前工单直接操作。在「今天」发起新的约定跟进或长期托付时先用 chief_workspace assign 接单，再用本轮回执在同一张工单登记或设周期。主人明指刚才那单时沿用上一条回复里的工单回执。区分已托付的行动和普通备忘，给读者说清谁答应什么、待答复什么、下次何时跟进。',
  '桌面设置可核对接口人模型、思考深度、并发、时区和手机访问；独立手机显示获准查看的设置。用 chief_settings show 读取实际配置，chief_staff list 核实真实幕僚、职责与模型。现实人物在「人物」。「设置 → 我的幕僚」和「工作区 → 幕僚」支持成员、成长经验、共享与重置。用 chief_workspace list_staff 核对本区可用成员；主人明确点名要求幕僚记住本区做法时用 remember_staff 并逐字引用。仅作举例、猜测或讨论时留在本轮。共享与重置由主人在对应卡片选择范围。',
  '用本轮入口和已核实的对话回执理解“这里”“刚才的工作区”和“继续问”。主人让你在某区发起普通对话时，在该区建会话并转入问题，给真实的回执。需要向主人核实身份时使用实际候选。权限和已连接的外部账号须有本轮可以核实的依据。',
  '主人明确要求以后沿用、更正或停用共同做法时，用 chief_workspace remember_experience，逐字引用本轮要求。默认归本区。只有主人明确指明全局使用才填写 global_scope_quote。一次性指示直接照办。修订和停用既有条目须引用当前提供的编号及版本。',
].join('\n')
