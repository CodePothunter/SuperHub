/**
 * 接口人路由评估（真实模型，不进 CI）：主人的说法 → 接口人选哪个工具、给出什么结构化理解、产生什么结果。
 *
 * 工具描述和接口人提示词是代码：改动它们之后、部署之前必须跑这个评估。确定性回归（liaison-core-regression.mjs）
 * 重放固定的工具调用，测不出模型会不会选错工具；这里让隔离宿主里的真实接口人按候选包的提示词与工具描述自己决定。
 *
 * 运行：
 *   npm pack --ignore-scripts --pack-destination /tmp/eval-pack
 *   CHIEF_ACCEPTANCE_PACKAGE=/tmp/eval-pack/dsh-chief-<版本>.tgz \
 *   node --experimental-transform-types scripts/liaison-routing-eval.mjs [--model provider/model] [--runs 3] [--case hold,…] [--from-start]
 *
 * --case 只跑点名的说法（逗号分隔 id），并自动先跑它承接的前置说法（例如 hold 承接 write 刚开出的工单）；前置说法只用来
 * 铺垫对话，不计入通过率。加 --from-start 时，点名说法之前的整段对话都先跑一遍（与完整评估的上文相同）。
 *
 * 模型：默认与线上接口人相同（openai-codex/gpt-6.1-terra，日常 profile 的 liaisonModel）。它需要 dsh-codex-subscription 与日常 DSH
 * 已登录的订阅：只读取日常凭据里当前账号的访问令牌，刷新令牌换成占位值写进隔离宿主，隔离宿主永远不能轮换主人的登录；
 * 访问令牌两小时内到期或读不到时改用 deepseek-official/deepseek-flash（DEEPSEEK_API_KEY），并在结果里写明用的是哪个。
 * 不写日常 DSH 的任何文件。每轮（run）是一台全新的隔离宿主，按顺序进行一整段对话（第二句承接第一句）。
 *
 * 判定：两条「每个人各自回答」的说法必须 runs/runs 通过；其他每条至少 ⌈2/3·runs⌉ 通过。不达标时退出码为 1。
 * 每句都经网页对话入口（带 scope 与 request_id 的 POST /chief/api/chat，与网页客户端相同）发出：系统不预先分类，
 * 每句都必须到达接口人；表里另列原话回执（只记原话，接口人登记的回执挂在它下面）。
 * CHIEF_ROUTING_EVIDENCE=<文件> 保存逐轮工具调用与判定。
 * 隔离宿主在每轮结束后删除（含复制的登录信息）；需要排查未通过的轮次时加 --keep-failed 保留，排查完请手动删除。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acceptanceHost, delay, until } from './acceptance-host.mjs'

const argv = process.argv.slice(2)
const option = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback }
const PREFERRED = option('--model', 'openai-codex/gpt-6.1-terra')
const FALLBACK = 'deepseek-official/deepseek-flash'
const RUNS = Number(option('--runs', '3'))
const KEEP_FAILED = argv.includes('--keep-failed')
const calendarDay = '2031-04-16'
const calendarMeeting = '春季档案交接会'
const selectedPerson = 'person:trial-archived'
const selectedOrganization = '南桥联络处'
const pastedProfile = '我通常在上午写文稿。正式评审时，我希望团队先写清决定依据和取舍。 [记忆]'
if (!Number.isInteger(RUNS) || RUNS < 1 || RUNS > 10) throw Error('--runs 取 1 到 10')
const LIVE_HOME = join(homedir(), 'workspace/dsh/home')
const CREDENTIALS = join(LIVE_HOME, '.credentials.yaml')
if (!existsSync(CREDENTIALS)) { console.log('SKIP：没有找到日常 DSH 的凭据，路由评估未执行'); process.exit(0) }

/** 接口人自己建的工单。讨论接口人在讨论里经 request_execution 建的单（例如请 Codex 幕僚本人作答）不算接口人代答。 */
const createdTicket = (turn) => turn.tickets.some(ticket => !ticket.room)
const calls = (turn, name, test = () => true) => turn.rows.filter(row => row.name === name && test(row))
const args = row => { try { return JSON.parse(row.arguments) } catch { return {} } }
const succeeded = row => row.text !== undefined && row.isError === false
/** The liaison pasted the owner's words: most of the shorter text appears verbatim in the other (punctuation and spaces aside). */
function copied(handoff, said) {
  const plain = text => text.replace(/[\s，。、：；！？,.:;!?「」“”"'（）()]/g, '')
  const a = plain(handoff), b = plain(said)
  if (!a || !b) return false
  let longest = 0
  const previous = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0
      if (previous[j] > longest) longest = previous[j]
      diagonal = above
    }
  }
  return longest >= Math.min(a.length, b.length) * 0.6
}
const discussed = turn => calls(turn, 'chief_room', row => ['discuss', 'create'].includes(args(row).action) && succeeded(row)).length > 0
const inboxWork = turn => calls(turn, 'chief_inbox', row => args(row).intent !== 'memo')
/** A prohibition the owner never said: 「分别汇报」 once became 「禁止：别汇报…」. */
const inventedBie = turn => [...turn.denied, ...inboxWork(turn).flatMap(row => args(row).restrictions ?? [])].filter(rule => /别/.test(rule) && !turn.said.includes(rule))

/**
 * Real project directories inside each run's isolated host (created before the conversation starts), for the cases
 * that bind a workspace or give one order its own directory.
 */
let projectRoot = '/nonexistent'
const projectDir = name => join(projectRoot, name)
/** The directory the liaison passed resolves to the one the owner named (as written or with `~`). */
const sameDirectory = (value, expected) => {
  const given = String(value ?? '').trim().replace(/^~(?=\/|$)/, homedir())
  try { return realpathSync(given) === realpathSync(expected) } catch { return false }
}

/** Owner phrases in conversation order. `group` cases must pass every run. */
const allCases = [
  { id: 'models', said: '现在你和所有幕僚用的是什么模型？', expect: '用 chief_staff list / chief_settings show 回答，不建单、不开讨论',
    judge: turn => {
      if (!calls(turn, 'chief_staff', row => args(row).action === 'list').length && !calls(turn, 'chief_settings', row => args(row).action === 'show').length) return '没有查 chief_staff list 或 chief_settings show'
      if (createdTicket(turn) || turn.newRooms) return `建了工单或讨论（${turn.newTickets.join('、')}${turn.newRooms ? `，讨论 +${turn.newRooms}` : ''}）`
    } },
  { id: 'self-report', said: '你让他们自述一下', group: true, expect: 'chief_room discuss，不建单交给一位幕僚',
    judge: turn => {
      if (!discussed(turn)) return '没有成功开出或续接讨论'
      if (inboxWork(turn).length || createdTicket(turn)) return `建单交给了一位幕僚（${turn.newTickets.join('、') || 'chief_inbox'}）`
    } },
  { id: 'everyone', said: '让每个人汇报一下自己用的模型', group: true, expect: 'chief_room discuss，不建单交给一位幕僚',
    judge: turn => {
      if (!discussed(turn)) return '没有成功开出或续接讨论'
      if (inboxWork(turn).length || createdTicket(turn)) return `建单交给了一位幕僚（${turn.newTickets.join('、') || 'chief_inbox'}）`
    } },
  { id: 'everyone-progress', needs: ['everyone'], said: '他们都汇报了吗？', group: true, expect: 'chief_room read 后直接回答，不再发起讨论、不建单',
    judge: turn => {
      if (!calls(turn, 'chief_room', row => args(row).action === 'read' && succeeded(row)).length) return '没有读取已有讨论'
      if (discussed(turn)) return '追问进展却再次发起了讨论'
      if (inboxWork(turn).length || createdTicket(turn)) return '追问进展却建了单'
      if (!turn.reply.trim()) return '没有回答进展'
    } },
  { id: 'research', native: true, said: '让研究员调研一下主流向量数据库的价格', expect: '聊天入口同样开工作区工单（原生 chief_inbox 已退役），保留原话',
    judge: turn => {
      const assigned = calls(turn, 'chief_workspace', row => args(row).action === 'assign' && succeeded(row))
      if (!assigned.length) return '没有通过 chief_workspace assign 开工作区工单'
      if (inboxWork(turn).length || createdTicket(turn)) return `仍走了退役的原生工单（${turn.newTickets.join('、') || 'chief_inbox'}）`
      if (turn.workOrders.length !== 1 || turn.workOrders[0].original !== turn.said) return '回执没有对应原话的工作区工单'
      if (discussed(turn)) return '同时开了讨论'
    } },
  { id: 'memo', said: '记一下：周五和张三对一下季度报告的交接安排', expect: '不建单、不开讨论（chief_record 或 chief_inbox intent=memo）',
    judge: turn => {
      if (createdTicket(turn) || turn.newRooms) return `建了工单或讨论（${turn.newTickets.join('、')}${turn.newRooms ? `，讨论 +${turn.newRooms}` : ''}）`
      if (!calls(turn, 'chief_record').length && !calls(turn, 'chief_inbox', row => args(row).intent === 'memo').length) return '没有记下（既没有 chief_record，也没有 chief_inbox intent=memo）'
    } },
  { id: 'write', native: true, said: '把构建脚本超时改成 30 分钟', expect: '聊天入口同样开工作区工单（原生 chief_inbox 已退役），保留原话',
    judge: turn => {
      const assigned = calls(turn, 'chief_workspace', row => args(row).action === 'assign' && succeeded(row))
      if (!assigned.length) return '没有通过 chief_workspace assign 开工作区工单'
      if (inboxWork(turn).length || createdTicket(turn)) return `仍走了退役的原生工单（${turn.newTickets.join('、') || 'chief_inbox'}）`
      if (turn.workOrders.length !== 1 || turn.workOrders[0].original !== turn.said) return '回执没有对应原话的工作区工单'
    } },
  { id: 'separately', native: true, said: '让研究员分别汇报一下三家云厂商对象存储的价格', expect: '开工作区工单，交办说明里没有主人没说过的「别…」禁止项',
    judge: turn => {
      const assigned = calls(turn, 'chief_workspace', row => args(row).action === 'assign' && succeeded(row))
      if (!assigned.length) return '没有通过 chief_workspace assign 开工作区工单'
      if (inboxWork(turn).length || createdTicket(turn)) return `仍走了退役的原生工单（${turn.newTickets.join('、') || 'chief_inbox'}）`
      if (turn.workOrders.length !== 1 || turn.workOrders[0].original !== turn.said) return '回执没有对应原话的工作区工单'
      const brief = calls(turn, 'chief_workspace', row => args(row).action === 'assign').map(row => [args(row).handoff, args(row).promise].join(' ')).join(' ')
      if (/别/.test(brief) && !/别/.test(turn.said)) return `交办说明出现了主人没说过的禁止项：${brief.slice(0, 120)}`
    } },
  // 「先别改」承接 write 开出的单，中间隔着 separately 另开的单：前置说法保留这一整段聊天入口交办，才和完整评估的处境相同。
  { id: 'hold', needs: ['research', 'memo', 'write', 'separately'], native: true, said: '先别改，查一下构建为什么老超时', expect: '补充到上一张“改超时”的工单或新开工作区工单，交办说明保留先别改、只查原因',
    judge: turn => {
      if (inboxWork(turn).length || createdTicket(turn)) return `仍走了退役的原生工单（${turn.newTickets.join('、') || 'chief_inbox'}）`
      const followed = calls(turn, 'chief_workspace', row => args(row).action === 'follow_order' && succeeded(row))
      const assigned = calls(turn, 'chief_workspace', row => args(row).action === 'assign' && succeeded(row))
      if (!followed.length && !assigned.length) return '既没有补充到上一张工单，也没有新开工作区工单'
      if (!followed.length && (turn.workOrders.length !== 1 || turn.workOrders[0].original !== turn.said)) return '回执没有对应原话的工作区工单'
      const brief = [...followed, ...assigned].map(row => [args(row).handoff, args(row).promise].join(' ')).join(' ')
      if (!/先别改|别改|不要改|不改|先不改|暂不修改|暂停修改|不要修改|不要(实施|执行)修复|只查|只排查|仅排查|只读|不做(任何)?修改|不修改|不动|停下|停止/.test(brief)) return `交办说明没有保留「先别改」：${brief.slice(0, 120)}`
    } },
  { id: 'workspace-create', said: '建一个工作区 叫做 字节 Landing', group: true, expect: '按原名创建一个无目标工作区，同轮返回可以打开的真实回执',
    judge: turn => {
      const workspace = turn.workspaces.find(row => row.name === '字节 Landing')
      if (!turn.productGuide || !turn.workspaceTool) return '模型请求缺少产品说明或工作区工具'
      if (!workspace || workspace.goal !== '' || turn.newWorkspaces !== 1) return '未创建唯一具名工作区，或填入了主人没有指定的目标'
      if (!calls(turn, 'chief_workspace', row => args(row).action === 'create' && succeeded(row)).length) return '没有成功调用创建工具'
      if (!turn.workspaceLinks.some(link => link.id === workspace.id && link.name === workspace.name) || !turn.reply.includes(workspace.name)) return '缺少真实工作区入口或具名答复'
      if (createdTicket(turn) || turn.newRooms) return '意外派工或开启讨论'
    } },
  { id: 'workspace-list', needs: ['workspace-create'], said: '帮我看一下，现在有哪些项目工作区？', group: true, expect: '查本脑工作区清单，返回实际名称',
    judge: turn => {
      if (turn.newWorkspaces || !calls(turn, 'chief_workspace', row => args(row).action === 'list' && succeeded(row)).length || !turn.reply.includes('字节 Landing')) return '未从真实清单回答'
    } },
  { id: 'workspace-directory', needs: ['workspace-create'], get said() { return '把字节 Landing 绑定到 ' + projectDir('landing') }, expect: 'set_directory 把工作区绑定到主人给的目录，不建单',
    judge: turn => {
      const bound = calls(turn, 'chief_workspace', row => args(row).action === 'set_directory' && succeeded(row))
      if (!bound.some(row => sameDirectory(args(row).directory, projectDir('landing')))) return '没有用 set_directory 绑定主人给的目录'
      const workspace = turn.workspaces.find(row => row.name === '字节 Landing')
      if (!workspace || !sameDirectory(workspace.projectDirectory, projectDir('landing'))) return '工作区没有保存这个项目目录'
      if (turn.newWorkspaces || createdTicket(turn) || turn.newRooms || turn.workOrders.length) return '绑定目录时额外建了工作区、工单或讨论'
    } },
  { id: 'workspace-context', needs: ['workspace-create'], said: '我正从哪个工作区找你？只告诉我名字。', group: true, selected: true, expect: '按这一条消息的原始入口给出已核实工作区的名字',
    judge: turn => {
      if (!turn.currentSurface || turn.newWorkspaces || !turn.reply.includes('字节 Landing')) return '本轮未注入有效工作区上下文或答案不符'
    } },
  { id:'workspace-experience-remember', needs:['workspace-create'], selected:true,
    said:'请把这个长期要求记下来：以后本区访谈收尾都要核对蓝杉编号。',
    expect:'按主人原话登记本区共同经验，无额外交办',
    judge: turn => {
      const stored = turn.experiences?.find(memory => memory.status === 'active' && memory.evidence?.some(source =>
        source.kind === 'owner' && typeof source.quote === 'string' && turn.said.includes(source.quote) && source.quote.includes('蓝杉编号')))
      if (!stored || !calls(turn,'chief_workspace',row=>args(row).action === 'remember_experience' && succeeded(row)).length) return '本区缺少有原话来源的共同经验'
      if (createdTicket(turn) || turn.newRooms || turn.workOrders.length) return '登记经验时额外交办'
    }},
  // Staff for one workspace only (chief_staff create with `workspace`); without a workspace name it stays a global role card.
  { id: 'workspace-staff-global', said: '加一个盯行业政策变化的幕僚', expect: 'chief_staff create 不带 workspace，建全局幕僚',
    judge: turn => {
      const row = calls(turn, 'chief_staff', r => args(r).action === 'create' && succeeded(r)).at(-1)
      if (!row) return '没有成功创建幕僚'
      if (args(row).workspace) return `主人没提工作区却填了 workspace（${args(row).workspace}）`
      if (!turn.roster.some(card => card.id === args(row).id)) return '全局名册里没有这位幕僚'
      if (createdTicket(turn) || turn.newRooms || turn.workOrders.length) return '额外建了工单或讨论'
    } },
  { id: 'workspace-staff-local', needs: ['workspace-create'], said: '给字节 Landing 加一个盯竞品的幕僚', group: true, expect: 'chief_staff create 带 workspace=字节 Landing，该区出现专属幕僚，全局名册没有',
    judge: turn => {
      const row = calls(turn, 'chief_staff', r => args(r).action === 'create' && succeeded(r)).at(-1)
      if (!row) return '没有成功创建幕僚'
      if (args(row).workspace !== '字节 Landing') return `没有把 workspace 填为字节 Landing（${args(row).workspace ?? '未填'}）`
      const workspace = turn.workspaces.find(space => space.name === '字节 Landing')
      if (!turn.staff.some(member => member.homeWorkspaceId === workspace?.id && member.name === args(row).name)) return '该工作区没有出现这位专属幕僚'
      if (turn.roster.some(card => card.name === args(row).name)) return '全局名册里也出现了这位幕僚'
      if (createdTicket(turn) || turn.newRooms || turn.workOrders.length) return '额外建了工单或讨论'
    } },
  { id: 'workspace-calendar', said: '这天我有哪些安排？', group: true, calendar: true, expect: '核对当前所选日期的真实日程并说出会议名称',
    judge: turn => {
      if (turn.calendarDate !== calendarDay || turn.currentSurface) return '当前会话没有收到正确的日历日期'
      const read = calls(turn, 'chief_calendar', row => succeeded(row) && args(row).date === calendarDay && (args(row).range ?? 'day') === 'day')
      if (!read.some(row => row.text.includes(calendarMeeting)) || !turn.reply.includes(calendarMeeting)) return '没有核对所选日期并回答实际会议'
      if (turn.newWorkspaces || createdTicket(turn) || turn.newRooms) return '意外建立了项目、工单或讨论'
    } },
  { id:'workspace-person', said:'我正看的这个人属于哪家机构？只需要机构名。', group:true, person:true, expect:'按选中的档案区分同名人物，读回仅保留在导入资料中的组织',
    judge:turn => {
      const read = calls(turn,'chief_lookup',row => succeeded(row) && args(row).what === 'person' && args(row).selected_id === selectedPerson)
      if (!read.some(row => row.text.includes(selectedOrganization)) || !turn.reply.includes(selectedOrganization)) return '没有按选中档案读回正确组织'
      if (turn.reply.includes('北岸事务所') || turn.newWorkspaces || createdTicket(turn) || turn.newRooms) return '混入了另一个人物或额外操作'
    } },
  { id: 'workspace-explain', said: '假如以后想设一个工作区，我该怎么做？现在只给我讲讲。', group: true, expect: '解释产品用法，当前无项目上下文，不执行创建',
    judge: turn => {
      if (turn.currentSurface || turn.calendarDate || turn.newWorkspaces || calls(turn, 'chief_workspace', row => args(row).action === 'create').length || createdTicket(turn) || turn.newRooms) return '带入了上一轮的选择或执行了用户仅咨询的动作'
    } },
  { id: 'signup-explain', said: '手机报名页怎么验收？先给我讲讲步骤。', group:true, expect:'解释验收，对话没有交办或派工',
    judge: turn => {
      if (turn.workspaceLinks.length || turn.newWorkspaces || calls(turn,'chief_workspace',r => args(r).action === 'assign').length || createdTicket(turn) || turn.newRooms) return '只咨询验收却发起了委托'
      if (!turn.reply.trim()) return '没有说明验收方式'
    } },
  { id: 'signup-assign', said: '请让 Codex 做一个手机报名页，我想自己试填一下。', group:true, expect:'从今天接手、给出真实委托入口，工单进工作区群聊（不再选执行者）',
    judge: turn => {
      if (!calls(turn,'chief_workspace',r => args(r).action === 'assign' && succeeded(r)).length) return '未从接口人接入报名页的交付流程'
      if (turn.workOrders.length !== 1 || turn.workOrders[0].engine !== 'roster' || turn.workOrders[0].original !== turn.said) return '回执没有对应原话的已保存委托和工作区群聊'
      if (turn.workOrders[0].permission && turn.workOrders[0].permission !== 'full-access') return `主人没提把关却设了档位 ${turn.workOrders[0].permission}`
      if (createdTicket(turn) || turn.newRooms) return '产生了额外工单或讨论'
    } },
  { id: 'order-ask', said: '新开一张工单交给 Codex：清理它工作目录里不用的临时文件，删之前先问我。', group:true, expect:'群聊工单带请求批准档（permission=ask）',
    judge: turn => {
      const [job] = turn.workOrders
      if (turn.workOrders.length !== 1 || job.engine !== 'roster' || job.original !== turn.said) return '回执没有对应原话的群聊工单'
      if (job.permission !== 'ask') return `档位为 ${job.permission ?? '未设置（完全访问）'}，应为 ask`
    } },
  { id: 'order-delegate', said: '新开一张工单交给 Claude Code：把它工作目录里项目的依赖升级到最新版，安装和删除这类操作你替我把关就行，不用问我。', group:true, expect:'群聊工单带代为批准档（permission=approve-for-me）',
    judge: turn => {
      const [job] = turn.workOrders
      if (turn.workOrders.length !== 1 || job.engine !== 'roster' || job.original !== turn.said) return '回执没有对应原话的群聊工单'
      if (job.permission !== 'approve-for-me') return `档位为 ${job.permission ?? '未设置（完全访问）'}，应为 approve-for-me`
    } },
  {id:'order-directory', get said() { return '新开一张工单交给 Codex，在 ' + projectDir('landing-api') + ' 目录下检查 README 里的命令有没有过时。' },
    expect:'工单带 directory（本单指定），开在主人给的目录干活的群',
    judge:turn => {
      const [job] = turn.workOrders
      const [assigned] = calls(turn,'chief_workspace',r => args(r).action === 'assign' && succeeded(r))
      if (!assigned || turn.workOrders.length !== 1 || job.engine !== 'roster' || job.original !== turn.said) return '回执没有对应原话的群聊工单'
      if (!sameDirectory(args(assigned).directory, projectDir('landing-api'))) return `assign 没带主人给的目录：${args(assigned).directory ?? '未填'}`
      if (!sameDirectory(job.directory, projectDir('landing-api'))) return '工单没有保存本单目录'
      if (job.directorySource !== 'order') return `运行目录来源为 ${job.directorySource ?? '未知'}，应为本单指定`
    }},
  {id:'order-explain',said:'工作区、会话和工单到底怎么关联？先只解释，别开单。',group:true,expect:'说清每张工单只有一场负责会话，咨询不产生工单',
    judge:turn => {
      if (!/工单/.test(turn.reply) || !/会话/.test(turn.reply) || !/(一场|一个|唯一|一处|同一)/.test(turn.reply)) return '没有解释负责会话的关系'
      if (turn.workspaceLinks.some(row => row.delegationId) || turn.newWorkspaces || createdTicket(turn) || turn.newRooms) return '咨询时产生了额外记录'
    }},
  {id:'order-write',said:'替我开一张工单，起草一份给新同事的交接清单，用 Markdown 交给我。',group:true,expect:'一般文稿在一张工单和一场工作区群聊中接手',
    judge:turn => {
      if (turn.workOrders.length !== 1 || turn.workOrders[0].original !== turn.said || turn.workOrders[0].engine !== 'roster') return '未进工作区群聊或丢失原话'
    }},
  {id:'order-sibling',said:'在当前会话里再开一张工单，给周一例会起草一份议程。',bound:true,group:true,expect:'第二张工单沿用当前会话',
    judge:turn => {
      const [job] = turn.workOrders
      if (!turn.focus || !job || job.id === turn.focus.id || job.sessionId !== turn.focus.sessionId) return '新工单未归入已打开的会话'
    }},
  {id:'order-follow',said:'给当前这张工单补充一条要求，清单开头写清交接日期。',bound:true,group:true,expect:'把补充送入原工单会话',
    judge:turn => {
      const [job] = turn.workOrders
      if (!turn.focus || !job || job.id !== turn.focus.id || job.sessionId !== turn.focus.sessionId || !calls(turn,'chief_workspace',r => args(r).action === 'follow_order' && succeeded(r)).length) return '补充未送回原工单'
    }},
  {id:'order-handoff',said:'替我开一张工单交给团队：把上周三场客户访谈的录音要点整理成一份对比表，每家客户一行，列出痛点、预算和下一步，周五前给我。',group:true,
    expect:'assign 的 handoff 是接口人自己写的交办说明，不照抄主人原话；对话第一条是接口人发言并附主人原话',
    judge:turn => {
      const [assigned] = calls(turn,'chief_workspace',r => args(r).action === 'assign' && succeeded(r))
      if (!assigned || turn.workOrders.length !== 1 || turn.workOrders[0].original !== turn.said) return '未接单或丢失原话'
      const handoff = String(args(assigned).handoff ?? '').trim()
      if (handoff.length < 12) return '没有用 handoff 写交办说明'
      if (handoff.length > 600) return 'handoff 超过 600 字'
      if (copied(handoff, turn.said)) return 'handoff 照抄了主人原话：' + handoff.slice(0, 60)
      const first = turn.workOrders[0].firstMessage
      if (first && (first.author !== '接口人' || first.quote?.text !== turn.said || first.text !== handoff)) return '对话第一条不是附原话的接口人交办'
    }},
  {id:'followup-record',said:'请替我在 SuperHub 工单跟进这些约定。我答应小陈周四演示，她答应周三给样本，还请我看看预算，我没答应。',group:true,expect:'从今天接单并按原话登记双方约定及未回应请求',
    judge:turn => {
      if (turn.workOrders.length !== 1 || turn.workOrders[0].original !== turn.said) return '没有唯一的原话工单回执'
      const rows = turn.followup?.commitments ?? []
      if (rows.length !== 3 || !['mine','theirs','request'].every(kind => rows.filter(row => row.kind === kind && row.source.kind === 'liaison' && turn.said.includes(row.quote)).length === 1)) return '没有按照主人本轮原话分清三项约定'
      if (calls(turn,'chief_record').some(row => args(row).kind === 'commitment') || createdTicket(turn)) return '重复写入花名册或额外派工'
    }},
  {id:'followup-read',bound:'followup-record',said:'这个工单里我答应了什么，她答应了什么？预算我答应了吗？请只查已记下的约定。',group:true,
    expect:'读取所属工单的约定，指出预算仍待答复',
    judge:turn => {
      if (!calls(turn,'chief_order_followup',r => args(r).action === 'read' && succeeded(r)).length || !turn.reply.includes('预算') || !turn.reply.includes('样本')) return '未核对已登记的约定'
      if (calls(turn,'chief_order_followup',r => !['read','sources'].includes(args(r).action)).length) return '只读时修改了工单'
    }},
  {id:'followup-weekly',bound:'followup-record',said:'把当前这张单设成每周五17:00给我一篇周报，并把本周的先写好给我，我自己转发。',group:true,
    expect:'将每周出稿保存在同一张单，本地主人能打开本周实际成稿',
    judge:turn => {
      const view = turn.followup, schedule = view?.schedule
      if (!schedule?.enabled || schedule.weekday !== 5 || schedule.time !== '17:00') return '未保存实际周五出稿时间'
      if (view.reports.length !== 1 || !view.reports[0].markdown.includes('预算') || !view.reports[0].markdown.includes('样本')) return '没有基于本单约定的本期成稿'
      if (turn.workOrders.some(job => job.id !== turn.focus?.id) || calls(turn,'chief_connector').length) return '额外开单或使用了外部渠道'
    }},
  {id:'followup-explain',said:'假如以后要处理这种约定、写周报，一定得接入外部消息应用吗？先只解释用法。',group:true,expect:'说明站内即可办理，只咨询时不作修改',
    judge:turn => {
      if (calls(turn,'chief_order_followup',r => !['read','sources'].includes(args(r).action)).length || calls(turn,'chief_workspace',r => args(r).action === 'assign').length || createdTicket(turn) || turn.newRooms || !turn.reply.includes('工单')) return '咨询时执行或未解释站内来源'
    }},
  {id:'brief-long',said:['请开一张工单，按下面的要求完成展馆核查并交回结果。','# 展馆展示作业（8 题）','核查八个虚构展位。请在全部完成后交付逐题答案、每题耗时和执行记录。仅限读取下面的练习文字与计算。','## 按题执行',...Array.from({length:8},(_,n) => (n+1)+'. 展位 '+String.fromCharCode(65+n)+' 的展柜编号是 '+(n+10)+'。从这行文字读取编号并登记，标记实际耗时，保留每个答案的依据。'),'## 交付要求','请交一份包含八个结果、耗时和执行记录的报告。'].join('\n\n'),group:true,
    expect:'接口人概括新单与会话、保留原始交办全文；隔离练习只用提供的虚构文字',
    judge:turn => {
      const [job]=turn.workOrders
      if (turn.workOrders.length !== 1 || job.original !== turn.said || job.title.length > 48 || job.promise.length > 160 || job.sessionTitle.length > 48) return '长交办的摘要或完整原话没有保存'
      if (!/展馆|展位|展柜/.test(job.title) || !/八|8/.test(job.promise) || !/耗时|计时|用时/.test(job.promise) || !/记录|过程/.test(job.promise) || /\n/.test(job.title+job.promise+job.sessionTitle)) return '摘要没有概括约定的结果'
    }},
  {id:'portrait-scribe',said:'加一位轮值记录员，负责把每周会的讨论整理成纪要并归档。',
    expect:'通过 chief_staff 创建角色，按记录职责选择铅笔，名册显示所选默认头像',
    judge:turn => {
      const row = calls(turn,'chief_staff',r => args(r).action === 'create' && succeeded(r)).at(-1)
      if (!row) return '没有成功创建幕僚'
      const selected = args(row)
      if (selected.portrait_shape !== 'pencil') return '接口人没有为记录职责选择铅笔'
      const member = turn.staff.find(entry => entry.id === selected.id)
      if (member?.defaultPortrait?.shape !== 'pencil' || member?.portrait?.shape !== 'pencil') return '名册没有读到选定的默认头像'
      if (createdTicket(turn) || turn.newRooms) return '额外建了工单或讨论'
    }},
  {id:'profile-submit',said:'这是 Claude 对我的了解，帮我导入。\n' + pastedProfile,
    expect:'chief_import submit，宿主保留主人整条原话及来源标记，资料回执可打开',
    judge:turn => {
      const call = calls(turn,'chief_import',row => args(row).action === 'submit' && succeeded(row)).at(-1)
      if (!call) return '未使用 chief_import 导入'
      if (turn.profileRecords.length !== 1 || turn.profileRecords[0]?.text !== turn.said) return '没有完整原文与宿主确认的资料回执'
      if (createdTicket(turn) || turn.newRooms || turn.newWorkspaces || turn.workOrders.length) return '导入创建了工作对象'
    }},
  {id:'profile-team',said:'请交给团队做一份我能直接转发的产品访谈提纲。只拟文稿，我会自己发送。',
    expect:'从今天用 chief_workspace assign 接新工单并关联负责会话',
    judge:turn => {
      if (!calls(turn,'chief_workspace',row=>args(row).action === 'assign' && succeeded(row)).length || turn.workOrders.length !== 1) {
        return '未通过真实工作区回执打开新工单'
      }
      if (calls(turn,'chief_import').length || createdTicket(turn)) return '普通交办被登记到其他流程'
    }},
]
const scenario = option('--scenario', 'all')
if (!['all','workspace','signup','order','followup','brief','portrait','profile'].includes(scenario)) throw Error('--scenario 可选 all、workspace、signup、order、followup、brief、portrait 或 profile')
/**
 * `--case <id>[,<id>…]` runs only the named cases. Each one keeps the earlier turns it builds on (`needs`, and the order
 * a `bound` case opens), which run first in conversation order as prerequisites: their lines are printed but they do not
 * enter the pass table.
 */
const picked = option('--case', '').split(',').map(id => id.trim()).filter(Boolean)
const unknown = picked.filter(id => !allCases.some(item => item.id === id))
if (unknown.length) throw Error(`没有这些说法：${unknown.join('、')}（可选 ${allCases.map(item => item.id).join('、')}）`)
if (picked.length && scenario !== 'all') throw Error('--case 与 --scenario 不能同时使用')
const prerequisites = item => [...item.needs ?? [], ...item.bound ? [item.bound === true ? 'order-write' : item.bound] : []]
const included = new Set()
const include = id => { if (included.has(id)) return; included.add(id); prerequisites(allCases.find(item => item.id === id)).forEach(include) }
picked.forEach(include)
// --from-start: every earlier turn of the conversation runs first, as in the full eval (earlier discussions and hand-overs
// shape how the liaison routes later words).
if (picked.length && argv.includes('--from-start')) {
  const last = Math.max(...picked.map(id => allCases.findIndex(item => item.id === id)))
  allCases.slice(0, last).forEach(item => included.add(item.id))
}
const CASES = picked.length ? allCases.filter(item => included.has(item.id))
  : scenario === 'all' ? allCases : allCases.filter(item => item.id.startsWith(scenario+'-'))
/** Cases that enter the pass table; with --case the prerequisite turns only set up the conversation. */
const SCORED = picked.length ? CASES.filter(item => picked.includes(item.id)) : CASES

/** The isolated host may only ever use the owner's current access token; the refresh token is replaced. */
async function codexCredentials(home) {
  const yaml = (await import('yaml')).default
  const doc = yaml.parse(readFileSync(CREDENTIALS, 'utf8'))
  const payload = doc?.records?.['codex-subscription/accounts']?.payload
  const active = payload?.accounts?.find(row => row.id === payload.activeId) ?? payload?.accounts?.[0]
  if (!active?.credential?.access) return '日常 DSH 没有已登录的 Codex 订阅'
  if (active.credential.expires - Date.now() < 2 * 3600_000) return 'Codex 订阅的访问令牌两小时内到期（隔离宿主不允许刷新）'
  const isolated = { ...payload, activeId: active.id, accounts: [{ ...active, credential: { ...active.credential, refresh: 'isolated-eval-refresh-disabled' } }] }
  writeFileSync(join(home, '.credentials.yaml'), yaml.stringify({ version: 1, records: { 'codex-subscription/accounts': { kind: 'grant', payload: isolated } } }), { mode: 0o600 })
}

async function startHost(model) {
  const host = await acceptanceHost({ probe: 'liaison-core-probe.mjs', directory: process.env.CHIEF_ROUTING_DIR || join(homedir(), '.cache', 'chief-acceptance'), model, extraEnv: { CHIEF_ACCEPTANCE_REAL_MODEL: '1' } })
  try { return await configureHost(host, model) }
  catch (error) {
    try { await host.dispose() } finally { rmSync(join(host.home, '.credentials.yaml'), { force: true }) }
    throw error
  }
}

async function configureHost(host, model) {
  // A fresh brain normally schedules a morning brief at startup. This suite measures only owner turns.
  const yaml = (await import('yaml')).default
  const rulesFile = join(host.brain, 'rules.yaml')
  const rules = yaml.parse(readFileSync(rulesFile, 'utf8'))
  writeFileSync(rulesFile, yaml.stringify({ ...rules, rules: [] }))
  if (model.startsWith('openai-codex/')) {
    host.install('dsh-codex-subscription@3.2.24')
    const problem = await codexCredentials(host.home)
    if (problem) { rmSync(host.work, { recursive: true, force: true }); return { problem } }
    const patch = join(host.home, 'profiles/web/cordis.patch.yml')
    writeFileSync(patch, `${readFileSync(patch, 'utf8')}- id: codex-subscription\n  config:\n    defaultReasoningEffort: high\n`, { mode: 0o600 })
  }
  projectRoot = join(host.work, 'projects')
  for (const name of ['landing', 'landing-api']) mkdirSync(join(projectRoot, name), { recursive: true, mode: 0o700 })
  writeFileSync(join(projectRoot, 'landing-api', 'README.md'), '# landing-api\n\n运行 `npm run serve` 启动接口服务。\n')
  const directory = join(host.brain,'people')
  mkdirSync(directory,{recursive:true})
  for (const [id,organization] of [['trial-archived',selectedOrganization],['trial-current','北岸事务所']]) {
    writeFileSync(join(directory,id+'.md'),['---','name: 许老师','organization: '+organization,'---',''].join('\n'))
  }
  await host.start()
  await host.api('/pause', { paused: true })
  const {scope} = await host.api('/v2/bootstrap')
  await host.api('/v2/history/import?scope='+encodeURIComponent(scope),{scope,requestId:randomUUID()})
  rmSync(join(directory,'trial-archived.md'))
  await host.api('/meetings', { title:calendarMeeting, at:calendarDay + 'T10:30' })
  // 让一位 DSH 幕僚的幕僚卡模型与默认不同，观察讨论成员是否按幕僚卡运行（读不到目录时跳过，结果里会显示）。
  const card = (await host.api('/state')).staff.find(row => row.id === 'strategist')
  const staffModel = model.startsWith('openai-codex/') ? 'openai-codex/gpt-6-astra' : 'deepseek-official/deepseek-v4-pro'
  if (card) await host.api('/staff', { id: card.id, name: card.name, executor: card.executor, verifier: card.verifier, brief: card.brief, model: staffModel })
    .then(() => console.log(`  谋士的幕僚卡模型设为 ${staffModel}`), error => console.log(`  谋士的幕僚卡模型没设上：${error.message}`))
  return { host }
}

async function conversation(host) {
  const liaison = (await host.api('/chat')).sessionId
  const scope = (await host.api('/state')).superhubScope
  const probe = body => host.request('/chief-liaison-core-probe', body)
  const ticketList = async () => {
    const state = await host.api('/state')
    return [...state.you, ...state.queued, ...state.active, ...state.ended]
  }
  const turns = []
  for (const item of CASES) {
    if (scenario === 'workspace' && item.selected) {
      await host.stop()
      await host.start()
      if ((await host.api('/chat')).sessionId !== liaison || (await host.api('/state')).superhubScope !== scope) {
        throw Error('重启隔离宿主后没有恢复同一接口人和第二大脑')
      }
    }
    const beforeTickets = new Set((await ticketList()).map(row => row.id)), beforeRooms = (await host.api('/rooms')).length
    const beforeSpaces = (await host.api(`/v2/workspaces?scope=${scope}`)).workspaces
    const selectedId = item.selected && beforeSpaces.find(space => space.name === '字节 Landing')?.id
    const focus = item.bound && turns.find(t => t.id === (item.bound === true ? 'order-write' : item.bound))?.workOrders[0]
    const context = focus ? {surface:'workspace',selectedId:focus.workspaceId,sessionId:focus.sessionId,workOrderId:focus.id}
      : item.calendar ? {surface:'calendar',selectedId:calendarDay} : item.person ? {surface:'people',selectedId:selectedPerson}
      : selectedId ? {surface:'workspace',selectedId} : {surface:item.native ? 'chat' : 'today'}
    // 网页对话入口：与网页客户端相同的带 scope 请求。原话回执只记原话，不分类，原话交给接口人。
    const { receipt } = await host.api('/chat', { text: item.said, mode: 'auto', sessionId: liaison, scope, request_id: randomUUID(),
      context })
    const started = Date.now()
    let error
    await until(async () => {
      const view = await host.api('/chat')
      const mine = view.messages.filter(message => message.role === 'you' && message.text.trim() === item.said).at(-1)
      return !view.busy && !!mine && view.messages.some(message => message.role === 'liaison' && message.seq > mine.seq
        && (message.text.trim() || message.profileImports?.length))
    }, `「${item.said}」的回复`, 240_000).catch(e => { error = e.message })
    await delay(1500)
    const rows = (await probe({ action: 'records' })).filter(row => row.session === liaison && row.owner === item.said)
    const tickets = (await ticketList()).filter(row => !beforeTickets.has(row.id))
    const details = await Promise.all(tickets.map(row => host.api(`/tickets/${row.id}`)))
    const fromRoom = new Set((await host.api(`/superhub/items?scope=${scope}`)).receipts.filter(row => row.authorization?.roomId).flatMap(row => row.items.map(item => item.ticketId)))
    const view = await host.api('/chat')
    const mine = view.messages.filter(message => message.role === 'you' && message.text.trim() === item.said).at(-1)
    const replies = view.messages.filter(message => message.role === 'liaison' && message.seq > (mine?.seq ?? Infinity))
    const reply = replies.map(message => message.text).join('\n')
    const workspaces = (await host.api(`/v2/workspaces?scope=${scope}`)).workspaces
    const workspaceLinks = replies.flatMap(message => message.workspaces ?? [])
    const workOrders = []
    for (const link of workspaceLinks.filter(row => row.delegationId)) {
      const project = await host.api(`/v2/workspaces/${encodeURIComponent(link.id)}?scope=${scope}`)
      const job = project.orders.find(row => row.id === link.delegationId)
      const session = job && project.sessions.find(row => row.id === job.sessionId && row.delegationIds.includes(job.id))
      if (session) {
        const original = job.hasOriginal ? await host.api(`/v2/workspaces/${link.id}/orders/${job.id}/original?scope=${scope}`) : undefined
        // The conversation opens with the liaison's hand-over when the executor has started; absent before that.
        const transcript = await host.api(`/v2/workspaces/${link.id}/sessions/${session.id}?scope=${scope}`).catch(() => undefined)
        const opening = transcript?.messages?.find(message => message.workOrderId === job.id)
        workOrders.push({id:job.id,title:job.title,promise:job.promise,workspaceId:job.workspaceId,sessionId:session.id,sessionTitle:session.title,
          executor:session.executor,engine:session.engine,permission:job.permission,directory:job.directory,directorySource:project.directories?.[job.id]?.source,original:original?.original?.complete ? original.original.text : undefined,
          ...(opening && {firstMessage:{author:opening.author,text:opening.text,quote:opening.quote}})})
      }
    }
    const route = (await probe({ action: 'routes' }))[liaison]?.at(-1)
    const turn = { id: item.id, said: item.said, seconds: Math.round((Date.now() - started) / 1000), rows, newTickets: tickets.map(row => row.id),
      tickets: details.map(row => ({ id: row.ticket.id, staff: row.ticket.staff, stage: row.stage, ...fromRoom.has(row.ticket.id) ? { room: true } : {} })),
      denied: details.flatMap(row => row.ticket.superhub?.contracts?.at(-1)?.denied ?? []), newRooms: (await host.api('/rooms')).length - beforeRooms, reply: reply.slice(0, 400),
      workspaces, newWorkspaces: workspaces.length - beforeSpaces.length, workspaceLinks, workOrders,focus,
      currentSurface: route?.currentWorkspace === true, calendarDate:route?.calendarDate, productGuide: route?.productGuide === true, workspaceTool: route?.workspaceTool === true }
    const followupJob = focus || workOrders[0]
    if (item.id.startsWith('followup-') && followupJob) turn.followup = await host.api(`/v2/workspaces/${followupJob.workspaceId}/orders/${followupJob.id}/followup?scope=${scope}`)
    if (item.id.startsWith('portrait-') || item.id.startsWith('workspace-staff-')) turn.staff = (await host.api(`/v2/staff?scope=${encodeURIComponent(scope)}`)).members
    if (item.id.startsWith('workspace-staff-')) turn.roster = (await host.api('/state')).staff
    if (item.id === 'workspace-experience-remember' && selectedId) {
      turn.experiences = (await host.api(`/v2/workspaces/${selectedId}/staff?scope=${encodeURIComponent(scope)}`)).sharedExperiences
    }
    if (item.id === 'profile-submit') {
      const imports = replies.flatMap(message => message.profileImports ?? [])
      turn.profileRecords = await Promise.all(imports.map(async ({importId}) =>
        (await host.api(`/v2/profile/imports/${encodeURIComponent(importId)}?scope=${scope}`)).record))
    }
    const original = receipt ? await host.api(`/superhub/items/${receipt.id}?scope=${scope}`) : undefined
    turn.web = !receipt ? '没有原话回执' : receipt.items.every(row => row.intent === 'conversation' && row.state === 'conversation')
      ? `原话回执只记原话 → 接口人登记 ${original?.linked?.length ?? 0} 项` : `原话被预先分类：${receipt.items.map(row => `${row.intent}/${row.state}`).join('、')}`
    const why = error ? `回合未结束：${error}` : !turn.web.startsWith('原话回执只记原话') ? turn.web : item.judge(turn)
    turn.pass = !why
    if (why) turn.why = why
    turns.push(turn)
    console.log(`  ${turn.pass ? 'PASS' : 'FAIL'}${SCORED.includes(item) ? '' : '（前置）'} 「${item.said}」（${turn.seconds}s）${why ? `：${why}` : ''}`)
    for (const row of rows) console.log(`      ${row.isError ? '✗' : '✓'} ${row.name} ${String(row.arguments).slice(0, 220)}`)
  }
  // 讨论成员（参考信息，不计入通过率）：讨论接口人拉起的成员名、实际请求的模型、是否注入了幕僚身份。
  if (scenario === 'all' && !picked.length) await delay(20_000)
  const routes = await probe({ action: 'routes' })
  const staff = (await host.api('/state')).staff
  const members = []
  for (const room of await host.api('/rooms')) {
    const view = await host.api(`/rooms/${room.id}`)
    const spawns = (await probe({ action: 'records' })).filter(row => row.session === room.session && row.name === 'spawn_teammate')
    for (const member of view.members.filter(row => row.role !== 'lead')) {
      const route = routes[member.id]?.at(-1)
      members.push({ room: room.title, name: member.name, staff: staff.find(card => card.id === member.name)?.executor, model: route ? `${route.provider}/${route.model}` : undefined, identity: route?.identity === member.name })
    }
    for (const row of spawns.filter(row => row.isError)) members.push({ room: room.title, name: args(row).name, refused: String(row.text).slice(0, 120) })
  }
  for (const row of members) console.log(`  成员 ${row.room} · ${row.name}${row.refused ? ` 拉起被拒：${row.refused}` : `（执行器 ${row.staff ?? '非幕僚'}）→ ${row.model ?? '未请求'}${row.identity ? '，已注入幕僚身份' : ''}`}`)
  return { turns, members }
}

let model = PREFERRED, note = ''
const runs = []
for (let run = 1; run <= RUNS; run++) {
  let started = await startHost(model)
  if (started.problem && model !== FALLBACK) {
    note = `${PREFERRED} 不可用（${started.problem}），改用 ${FALLBACK}`
    console.log(note)
    model = FALLBACK
    started = await startHost(model)
  }
  if (started.problem) throw Error(started.problem)
  const { host } = started
  console.log(`第 ${run}/${RUNS} 轮：隔离宿主 ${host.work}，接口人模型 ${model}`)
  let turns = [], members = []
  try { ({ turns, members } = await conversation(host)) }
  finally {
    try { await host.dispose() } finally { rmSync(join(host.home, '.credentials.yaml'), { force: true }) }
  }
  // 首轮所有回合都没有工具调用、也没有回复：模型路由本身不可用（例如订阅令牌被拒），换用备用模型重来。
  if (run === 1 && model !== FALLBACK && turns.every(turn => !turn.rows.length && !turn.reply)) {
    note = `${model} 在隔离宿主上没有任何回复（${host.logs().split('\n').filter(line => /error|401|403/i.test(line)).slice(-2).join(' ').slice(0, 300)}），改用 ${FALLBACK}`
    console.log(note)
    model = FALLBACK
    run--
    continue
  }
  runs.push({ run, model, host: host.work, turns, members })
  // Test hosts are deleted after every run (the server's disk is small); keep failed ones only on request.
  if (!KEEP_FAILED || turns.every(turn => turn.pass)) rmSync(host.work, { recursive: true, force: true })
}

const required = item => item.group ? RUNS : Math.ceil(RUNS * 2 / 3)
const table = SCORED.map(item => {
  const passed = runs.filter(run => run.turns.find(turn => turn.id === item.id)?.pass).length
  const web = [...new Set(runs.map(run => run.turns.find(turn => turn.id === item.id)?.web).filter(Boolean))].join('；')
  return { id: item.id, said: item.said, expect: item.expect, passed, runs: runs.length, required: required(item), everyRun:!!item.group, ok: passed >= required(item), web }
})
const total = table.reduce((sum, row) => sum + row.passed, 0), all = table.reduce((sum, row) => sum + row.runs, 0)
console.log(`\n接口人路由评估：模型 ${model}${note ? `（${note}）` : ''}，每句 ${RUNS} 轮`)
console.log('| 说法 | 期望 | 通过 | 门槛 | 网页对话入口的原话回执 |\n| --- | --- | --- | --- | --- |')
for (const row of table) console.log(`| ${row.said} | ${row.expect} | ${row.passed}/${row.runs} ${row.ok ? '' : '✗'} | ${row.required}/${row.runs} | ${row.web} |`)
console.log(`总计 ${total}/${all}（${Math.round(total / all * 100)}%）`)
if (process.env.CHIEF_ROUTING_EVIDENCE) {
  mkdirSync(dirname(process.env.CHIEF_ROUTING_EVIDENCE), { recursive: true })
  writeFileSync(process.env.CHIEF_ROUTING_EVIDENCE, JSON.stringify({ checkedAt: new Date().toISOString(), host: 'DSH 0.2.2-rc.1', model, note, candidate: process.env.CHIEF_ACCEPTANCE_PACKAGE, table, runs }, null, 2))
}
if (table.some(row => !row.ok)) {
  if (KEEP_FAILED) for (const run of runs.filter(run => run.turns.some(turn => !turn.pass))) console.log('未通过的隔离宿主保留在', run.host)
  else console.log('未通过轮次的隔离宿主已删除；需要排查时加 --keep-failed 保留。')
  process.exitCode = 1
}
