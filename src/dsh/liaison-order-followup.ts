import { createHash } from 'node:crypto'
import type { IntakeContext } from '../core/superhub-intake.ts'
import { workspaceArchived, type V2Message } from '../core/workspace-v2.ts'
import type { FollowupView } from '../core/workspace-followup.ts'
import { chatFromEvents } from './chat.ts'
import type { SessionEventLike } from './ports.ts'
import type { nativeIntakeSource } from './superhub.ts'
import type { workspaceV2Routes } from './workspace-v2.ts'
import { archivedRefusal, type WorkspaceV2Store } from './workspace-v2-store.ts'

type Args = Record<string,unknown>
export type OrderFollowupAccess = Pick<ReturnType<typeof workspaceV2Routes>['followup'], 'view' | 'apply' | 'sources' | 'workspaceView'>
interface OwnerTurn {
  source: NonNullable<ReturnType<typeof nativeIntakeSource>>
  sessionId: string
  events: readonly SessionEventLike[]
}

export const followupParameters = {
  type: 'object', required: ['action'], additionalProperties: false,
  properties: {
    action: { type:'string', enum:['read','sources','record','resolve','schedule','draft'] },
    work_order_id: { type:'string', description:'可省略当前工单。本轮刚接的新单可填回执内的标识。主人在已打开的项目明确点名工单时，用 list_orders 核对。' },
    workspace_name:{type:'string',description:'read 在今天查看指定工作区的未结约定时，照录本轮主人点名的完整项目名称。在工作区概览直接 read 即可。'},
    reference: { type:'string', description:'在今天续办上一条回复中已展示的工单时，照录主人本轮指代那张工单的短语。' },
    entries: { type:'array', minItems:1, maxItems:20, description:'record 一次填写这句话中的各项承诺与待答复请求。', items:{
      type:'object', required:['kind','quote'], additionalProperties:false, properties:{
        kind:{type:'string',enum:['mine','theirs','request']},
        quote:{type:'string',description:'来源中逐字连续的一段，保留表示请求、答应或尚未同意的词。'},
        person:{type:'string',description:'来源明确点名的现实人物，可省略。'},
        dueAt:{type:'string',description:'确定的当地日期 YYYY-MM-DD，明确到时刻才用带时区日期时间。'},
        messageId:{type:'string',description:'引用本轮主人原话时省略。引用本单会话时用 sources 返回的实际标识。'},
      },
    } },
    id:{type:'string',description:'resolve 使用 read 返回的约定标识。'},
    enabled:{type:'boolean',description:'主人停用每周出稿时为 false。'},
    weekday:{type:'integer',minimum:0,maximum:6,description:'每周出稿日，0 为周日，5 为周五。'},
    time:{type:'string',description:'当地出稿时刻 HH:mm。主人只定周几时采用 17:00，并回报所用时间。'},
    week:{type:'string',description:'read 查看过往周报时填该期的周一 YYYY-MM-DD。'},
    message_id:{type:'string',description:'sources 查看一条工单消息全文时使用列表中的标识。'},
    offset:{type:'integer',minimum:0,description:'用上页返回的 nextOffset 继续。'},
  },
}

function previousOrderReceipt(events: readonly SessionEventLike[], ownerWords:string, named?: string) {
  const end = events.findLastIndex(event => event.type === 'turn/end')
  if (end < 0) return
  const reply = chatFromEvents(events.slice(0, end + 1), 1).messages.at(-1)
  const links = reply?.role === 'liaison' ? reply.workspaces?.filter(link => link.delegationId) ?? [] : []
  const pointed = links.length < 2 ? links : links.filter(link => ownerWords.includes(link.delegationId!) || link.delegationTitle && ownerWords.includes(link.delegationTitle))
  if (pointed.length === 1 && (!named || named === pointed[0]!.delegationId)) return pointed[0]
}

function page<T>(rows: T[], offset: number, size = 30) {
  const end = Math.min(rows.length, offset + size)
  return { items: rows.slice(offset,end), total:rows.length, ...(end < rows.length && {nextOffset:end}) }
}

function sourcePage(messages: V2Message[], args: Args, offset: number) {
  if (args.message_id !== undefined) {
    const row = messages.find(message => message.id === args.message_id)
    if (!row) throw new Error('本单会话中没有这条可引用的发言。')
    const end = Math.min(row.text.length, offset + 4000)
    return { messageId:row.id, author:row.author, at:row.at, text:row.text.slice(offset,end), ...(end < row.text.length && {nextOffset:end}) }
  }
  const result = page([...messages].reverse(), offset, 8)
  return {...result,items:result.items.map(row => ({messageId:row.id,author:row.author,at:row.at,text:row.text.slice(0,1000),length:row.text.length}))}
}

function projection(view: FollowupView, args: Args, offset: number) {
  const report = args.action === 'draft' ? view.reports.find(row => row.id === view.reportId)
    : args.action === 'read' ? view.reports.find(row => row.week === (args.week ?? view.currentWeek)) : undefined
  if (args.action === 'draft' && !report) throw new Error('尚未取得本期成稿的回执，请从原工单核对。')
  const entries = Array.isArray(args.entries) ? args.entries : []
  const relevant = args.action === 'record' ? view.commitments.filter(row => entries.some(entry => entry?.quote === row.quote && entry?.kind === row.kind))
    : args.action === 'resolve' ? view.commitments.filter(row => row.id === args.id) : view.commitments
  const summary = {
    read:'已读回这张工单的约定与周报。', record:'已按原话登记到这张工单。', resolve:'已将这条约定标记为已处理。',
    schedule:view.schedule?.enabled ? '已保存每周出稿时间。' : '每周自动出稿已停用。', draft:'本期周报成稿已保存在工单，可以打开或自行转发。',
  }
  return { timeZone:view.timeZone, currentWeek:view.currentWeek, schedule:view.schedule,
    ...(['read','record','resolve'].includes(String(args.action)) && {commitments:page(relevant,offset)}),
    ...(args.action === 'read' && {weeks:view.reports.map(row => row.week)}), ...(report && {report}),
    message:summary[args.action as keyof typeof summary] }
}

export async function liaisonOrderFollowup(store: WorkspaceV2Store, access: OrderFollowupAccess, args: Args, turn: OwnerTurn,
  origin?: {context?:IntakeContext; operation?:'read'|'write'}) {
  const {source} = turn
  const {action, work_order_id:named, reference, offset = 0} = args
  if (!['read','sources','record','resolve','schedule','draft'].includes(String(action))) throw new Error('请选择有效的工单跟进操作。')
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('请使用回执中的有效分页位置。')
  if (origin?.operation === 'read' && action !== 'read' && action !== 'sources') throw new Error('主人本轮指定了只读，可以查约定、原话和已保存的周报。')
  if (named !== undefined && (typeof named !== 'string' || !named.trim())) throw new Error('请使用工单回执中的有效标识。')
  if (reference !== undefined && (typeof reference !== 'string' || !reference.trim() || !source.text.includes(reference))) throw new Error('请引用主人本轮指代那张工单的原话。')

  const context = origin?.context
  // An archived workspace stays readable here; anything it would record or schedule waits until it is restored.
  const focus = store.focus(context, true)
  if (focus && !store.focus(context) && action !== 'read' && action !== 'sources') throw new Error(archivedRefusal(focus.workspace.name))
  if (context?.surface === 'workspace' && ((context.selectedId && !focus) || (context.sessionId && !focus?.session) || (context.workOrderId && !focus?.order))) {
    throw new Error('当前工单位置已变更，请重新打开后继续。')
  }
  if (args.workspace_name !== undefined) {
    const name = args.workspace_name
    if (action !== 'read' || named || typeof name !== 'string' || !name.trim() || !source.text.includes(name)) throw new Error('查询指定项目的约定时，请沿用主人本轮点名的完整工作区名称。')
    const spaces = (focus ? [focus.workspace] : store.list()).filter(space => space.name === name)
    if (spaces.length !== 1) throw new Error('没有找到唯一匹配的工作区，请核对项目名称。')
    const space = spaces[0]!
    if (!focus?.order) {
      return {workspace:{id:space.id,name:space.name}, ...access.workspaceView(space.id,offset,focus?.session?.id),message:'已读回当前范围内未处理的约定及各自的工单出处。'}
    }
  }
  // Only an actual page selection, the current assignment receipt, a human-supplied ID, or a shown receipt can select an order.
  const assigned = store.assignedOrder(source.requestId)
  let order = focus?.order
  if (!order || (named && named === assigned?.id)) order = assigned ?? order
  if (!order && named && source.text.includes(named)) {
    const spaces = focus ? [focus.workspace] : store.list()
    order = spaces.flatMap(space => store.view(space.id).orders).find(row => row.id === named)
  }
  if (!order && focus) {
    const mentioned = store.view(focus.workspace.id).orders.filter(row =>
      (!focus.session || row.sessionId === focus.session.id) && source.text.normalize('NFC').includes(row.title.normalize('NFC')))
    if (mentioned.length === 1 && (!named || mentioned[0]!.id === named)) order = mentioned[0]
  }
  if (!order && reference) {
    const prior = previousOrderReceipt(turn.events, source.text, named)
    if (prior?.delegationId && (!focus || focus.workspace.id === prior.id)) order = store.delegation(prior.id, prior.delegationId)
  }
  if (!order && !named && !reference && focus && action === 'read') {
    return {workspace:{id:focus.workspace.id,name:focus.workspace.name}, ...access.workspaceView(focus.workspace.id,offset,focus.session?.id),message:'已读取当前范围内各张工单未处理的约定。'}
  }
  if (!order || (named && named !== order.id) || (focus && order.workspaceId !== focus.workspace.id) || (focus?.session && order.sessionId !== focus.session.id)) {
    throw new Error('请沿用本轮选中的工单、主人明指的工单号或刚刚展示的回执。主人新托付一项约定或周报时，可直接用 chief_workspace assign 接单，再在该单操作。')
  }
  const {id,name} = store.workspace(order.workspaceId)
  const target = {workspace:{id,name},delegation:{id:order.id,title:order.title,sessionId:order.sessionId}}
  if (action === 'sources') return {...target, sources:sourcePage(await access.sources(id,order.id),args,offset)}
  if (action === 'read') return {...target, ...projection(access.view(id,order.id),args,offset)}
  // Also an order named outside its page: its archived workspace records and schedules nothing until it is restored.
  if (workspaceArchived(store.workspace(id))) throw new Error(archivedRefusal(name))

  // One owner turn can contain multiple independent quotes or resolved IDs. A retry of the same edit must use the same receipt.
  const identity = action === 'record' && Array.isArray(args.entries) ? args.entries.map(row => [row?.messageId ?? source.messageId,row?.quote]).sort()
    : action === 'resolve' ? args.id : null
  const requestId = createHash('sha256').update(JSON.stringify(['order-followup',source.requestId,order.id,action,identity])).digest('hex')
  const body = {action, requestId, ...(action === 'record' && {entries:args.entries}), ...(action === 'resolve' && {id:args.id}),
    ...(action === 'schedule' && (args.enabled === false ? {enabled:false} : {weekday:args.weekday,time:args.time ?? '17:00'}))}
  const evidence = action === 'record' ? {sessionId:turn.sessionId,messageId:source.messageId,text:source.text,at:source.at} : undefined
  const result = await access.apply(id,order.id,body,evidence)
  return {...target, ...projection(result,args,0)}
}
