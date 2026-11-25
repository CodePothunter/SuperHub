import type { IntakeContext } from './superhub-intake.ts'
import { workspaceArchived, type V2Workspace } from './workspace-v2.ts'
import { selectableCalendarDate } from './workspace-calendar.ts'

/** Product names shared by the daily navigation and the liaison's orientation. */
export const SUPERHUB_SURFACES = {
  today: { label: '今天', description: '可以直接找接口人交办，也可以导入、导出或打开已有资料。主人随时可以说要办的事。' },
  workspace: { label: '工作区', description: '工作区内有会话，每张工单属于一场负责会话，一场会话可处理多张工单。工单可以保存双方约定、待回应请求以及按期交回的周报，都能追溯原话和成果。' },
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
  description: '管理 SuperHub 工作区与工单。主人给出项目名要求建工作区时直接 create，只需 name。工作区可以绑定一个项目目录，工作区群聊里的幕僚默认在那里干活（未绑定时在 SuperHub 工作目录）：主人要把工作区绑定、改绑到某个目录（如「把字节 Landing 绑定到 /home/me/landing」）用 set_directory，name 为工作区名，directory 照录主人给的路径；主人要解除时 directory 传空字符串。建工作区时主人同时给了目录，create 可带 directory。查询项目及当前选区用 list，已归档的工作区在 list 里标 archived：它只读，不能交办、补充、改目录或加幕僚，主人要用时请他先在工作区页恢复（归档与恢复只在界面操作）。查看工单用 list_orders，再用 read_order 按真实标识读取负责会话、状态和结果约定。主人明确托付一份新成果时用 assign。先给这项工作起简洁的主题标题 title，再用一句 promise 说明实际交付约定。工单在工作区的群聊里办：群里有你（接口人，群管理员）和本工作区的幕僚，幕僚按各自的幕僚卡用 Codex、Claude Code 或 DSH 模型真实执行，由你在群里按分工 @ 人派活，不再选择执行者，executor 不用填。你以接口人身份把工作交到群里：在 handoff 里用自己的话写交办说明（做什么、交付什么、注意事项），不要照抄主人原话，本轮原话会作为引用完整附在后面。从当前打开的群交办会沿用该群。主人本轮点名某位幕僚做这件事时，先用 list_staff 核实本区成员，assign 的 staff_name 照录主人的称呼，交办会在群里直接 @ 这位幕僚；主人只提 Codex、Claude Code 这类工具名时不填 staff_name。主人本轮原话为这一单明确写出目录（如「这单在 /home/me/x 目录下做」）时，assign 带上 directory，本单会开一个在该目录干活的群；主人没写目录时不要填。要继续已选工单、补充新要求时用 follow_order，同样可用 handoff 写你的补充说明。主人接着对本段对话里你最近开出的工单补充或改主意时（例如交办“改超时”后又交办了别的事，主人再说“先别改，先查原因”），按说的事认出是哪一张，直接 follow_order，work_order_id 用那张单 assign 回执里的 order.id，不必是最后一张，不用请主人打开工单或报工单号；本段对话以外开出的工单才需要主人打开或点名工单号。主人要继续已退役的原生工单（T-编号）里的事时，也用 assign 新开工作区工单，把旧工单编号、已有结论和受阻原因写进 handoff。从今天也能直接交办。只问做法、举例或讨论时直接回答。接手与交付分别以实际回执、成果为据。',
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
  '用本轮入口信息理解“这里”或“这个项目”。实际已建的工作区通过工具查询。工具成功后才报告完成。权限和已连接的外部账号须有本轮可以核实的依据。',
].join('\n')
