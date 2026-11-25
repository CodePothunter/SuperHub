import type { StaffContext } from '../core/workspace-staff.ts'
import type { HostContext, ModelSelection } from './ports.ts'
import { beforeDispatch } from './workspace-v2-coding.ts'

export interface StaffRunOptions {
  context(workspaceId:string,staffId:string):StaffContext
  current(context:StaffContext):void
  used(context:StaffContext,orderId:string):void
  propose(context:StaffContext,orderId:string,requestId:string,text:string):void
  model(staffId:string):ModelSelection | undefined
}

/** Assemble each request from the owner's current grants. The model receives no agent tools or native history. */
export function prepareStaffRun(ctx:HostContext, options:StaffRunOptions | undefined, workspaceId:string, staffId:string) {
  const llm = ctx.get('llm')
  const model = options?.model(staffId)
  if (!options || !llm?.stream || !model) throw beforeDispatch('当前幕僚的受限模型不可用，请在设置中核对模型。')
  let member:StaffContext
  try { member = options.context(workspaceId,staffId) }
  catch { throw beforeDispatch('这位幕僚目前无法读取本区资料，请核对参与范围。') }
  const stream = llm.stream.bind(llm)
  return { member, async answer(instructions:string, prior:{author:string;text:string}[], text:string, signal:AbortSignal) {
    const prompt = JSON.stringify({职责:member.brief,本区职责:member.duty,可用经验:member.memories.map(m=>m.purpose ? {内容:m.text,限定用途:m.purpose} : m.text),
      工单:instructions,同单先前对话:prior,本轮发言:text})
    let reply = '', finished = false
    for await (const chunk of stream({...model,tools:[],system:'你是本工单具名幕僚'+JSON.stringify(member.name)+'。本轮发言以〔接口人〕开头的是接口人的交办、补充或追问，以〔主人〕开头的是主人本人对你说的话，冲突时以主人的话为准。只使用本次提供的信息作答，有限定用途的资料只在所列用途内使用。你能阅读和撰写文字。无法实查的内容应在回报中说明。可在结尾用单独一行「经验建议：…」提出一项值得主人采纳的本区做法。交付报告时第一行写“工单回报”或“阶段回报”。',
      messages:[{role:'user',content:[{type:'text',text:prompt}]}],signal})) {
      signal.throwIfAborted()
      if (chunk.type === 'text-delta') reply += chunk.text ?? ''
      if (reply.length > 96_000) throw new Error('幕僚本轮回报超出可保存长度。')
      if (chunk.type === 'finish') finished = chunk.reason?.kind === 'stop'
    }
    if (!finished || !reply.trim()) throw new Error('幕僚本轮没有返回完整答复。')
    signal.throwIfAborted()
    options.current(member)
    return {reply:reply.trim(),proposal:/(?:^|\n)经验建议[：:]\s*([^\n]{1,1000})\s*$/.exec(reply)?.[1]?.trim()}
  }}
}
