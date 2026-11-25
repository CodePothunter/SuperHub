import type { Engine } from '../core/engine.ts'
import type { Ticket } from '../core/model.ts'
import type { Outbox } from './outbox.ts'
import type { NativeRooms, RequestRoomExecution, RoomExecutionRequest } from './rooms.ts'
import type { SuperhubIntake } from './superhub.ts'

interface RoomExecutionDeps {
  rooms: Pick<NativeRooms, 'view' | 'link'>
  superhub: Pick<SuperhubIntake, 'fromLiaison'>
  engine: Pick<Engine, 'views'>
  ticket: (id: string) => Ticket | undefined
  outbox: Pick<Outbox, 'enqueue'>
  available: (executor: string) => boolean
}

/**
 * 讨论里的正式工单（讨论接口人的 request_execution 与网页「提交执行审批」共用）。
 * 方案 A：讨论里主人的原话是授权来源，讨论接口人理解后的任务说明（scope，缺省用标题）是工作内容。
 * 读写方式由讨论接口人声明（operation），系统不解读文字：read 直接派工（工单桌只能写本工单目录），write 建单后等主人批准。
 * restrictions 逐条摘自那条主人原话，写进契约的禁止项。未建单时说明原因与下一步。
 */
export function roomExecution(deps: RoomExecutionDeps): RequestRoomExecution {
  return async (roomId: string, request: RoomExecutionRequest) => {
    const view = await deps.rooms.view(roomId)
    const source = view.messages.find(row => row.id === request.source && row.author === 'you')
    if (!source) throw Error('请选择当前讨论中的主人原话（chief_room_note read 里 author 为 you 的消息标识），作为正式工单的授权来源；未建单')
    if (request.operation !== 'read' && request.operation !== 'write') throw Object.assign(Error('operation 必填：read 表示只读调查（直接派工，执行者只能写本工单目录）；write 表示要改文件、运行命令或对外写入（建单后等主人批准）。未建单'), { status: 400 })
    if (!request.title.trim() || request.title.length > 200) throw Error('请填写 1 到 200 字的工单标题；未建单')
    const brief = request.scope?.trim() || request.title.trim()
    const doneWhen = request.doneWhen?.length ? request.doneWhen : ['按主人原话交付可核验结果，并说明未完成的范围']
    if (brief.length > 4000 || doneWhen.length > 20 || doneWhen.some(row => !row.trim() || row.length > 600)) {
      throw Error('请缩短工单范围（4000 字内）与完成标准（20 条内，每条 600 字内）；未建单')
    }
    const receipt = await deps.superhub.fromLiaison({ source: { requestId: source.id, messageId: source.id, text: source.text }, roomId, brief,
      title: request.title.trim(), staff: request.staff?.trim() || undefined, operation: request.operation, doneWhen,
      ...request.restrictions?.length ? { restrictions: request.restrictions } : {}, ...request.existingOnly ? { existingOnly: true } : {} })
    const item = receipt.items[0]
    const ticketId = item?.ticketId
    if (!ticketId) {
      const why = item?.question ?? item?.reason ?? '主人原话里没有找到这项工作的授权'
      throw Object.assign(Error(item?.state === 'dispatching' ? `已保存，工单回执尚未确认：${why}。用相同参数重试即可，不会重复建单。`
        : `未建单：${why}。可以先用 chief_room_note 的 ask_owner 请主人确认。`), { status: 409 })
    }
    deps.rooms.link(roomId, ticketId)
    const ticket = deps.ticket(ticketId)
    const stage = deps.engine.views().find(row => row.ticket.id === ticketId)?.stage
    if (ticket && stage === 'you/approve') {
      deps.outbox.enqueue(`need:${ticketId}:you/approve:0`, `待批准：${ticket.title}（${ticketId}）。${ticket.mandate.scope.split('\n')[0]!.slice(0, 120)}`, new Date(), ticketId)
    }
    const executor = ticket?.requestedExecutor, available = executor ? deps.available(executor) : false
    const missing = executor && !available ? `注意：当前 DSH 没有挂载执行器 ${executor}，工单会等待该执行器可用，请主人检查执行器配置或改派。` : ''
    return {
      ticketId, ...stage ? { stage } : {}, ...executor ? { executor } : {}, available,
      message: (stage === 'you/approve' ? `已登记工单 ${ticketId}，等主人在「等你决定」里批准后才执行。` : `已登记工单 ${ticketId}，只读调查已派给幕僚，无需批准。`) + missing,
    }
  }
}
