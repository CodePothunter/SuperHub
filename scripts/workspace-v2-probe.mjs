/** Disposable DSH host. Only the model responses and onboarding preference are supplied by this probe. */
export const inject = ['llm', 'settings']

const text = value => ({ type: 'text', text: value })
const call = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) })
const said = message => (message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
const systemText = system => typeof system === 'string' ? system : JSON.stringify(system ?? '')

/**
 * Members of a SuperHub group chat (`chief-v2-member-…` sessions): the liaison is the admin, staff answer when @-called.
 * Who speaks is in the member identity (`〔群成员身份〕你是「名字」`); what it was asked is its latest prompt.
 */
function member({ messages, system }) {
  const context = systemText(system) + '\n' + messages.map(said).join('\n')
  const name = /〔群成员身份〕你是「([^」]+)」/.exec(context)?.[1]
  // DSH adds its own user-role context (runtime snapshot, time) after the group's prompt.
  const prompt = said(messages.findLast(m => m.role === 'user' && said(m).includes('群成员：')) ?? {})
  const replied = text => messages.some(m => m.role === 'assistant' && said(m).includes(text))
  if (name === '接口人') {
    if (prompt.includes('核对一下试点的联系人')) return text('我已经核对了试点联系人，可以在这张工单里查看结果。')
    if (prompt.includes('请同事一起核对报名表') && !replied('@研究员 请核对报名表')) return text('@研究员 请核对报名表的字段是否够用。')
    if (prompt.includes('做完了你交代的活')) return text('我已整理本轮讨论，报名表只需要姓名和邮箱。')
    return text('已收到，我在群里跟进。')
  }
  if (name === '研究员' && prompt.includes('请核对报名表的字段')) return text('我核对了报名字段，姓名和邮箱足够。')
  return undefined
}

/**
 * The engagement coordinator (`{"turn":…}` prompts): a member's line linking 交接清单 is the order's final delivery, citing
 * that line. Other judgements keep the probe's ordinary answer.
 */
function coordinate(messages) {
  const prompt = messages.filter(m => m.role === 'user').map(said).findLast(text => text.startsWith('{"turn":'))
  let input
  try { input = prompt && JSON.parse(prompt) } catch { return undefined }
  if (input?.turn === 'member' && input.order && input.source?.text?.includes('[交接清单](交接清单.md)')) {
    return text(JSON.stringify({kind:'deliver', text:'交接清单已整理好，核对交付日期一项已列入。', final:true, evidenceSeqs:[input.source.seq]}))
  }
  return undefined
}

function response({ messages, sessionId, tools, system }) {
  const coordinated = coordinate(messages)
  if (coordinated) return coordinated
  const history = messages.map(said).join('\n')
  if (typeof system === 'string' && system.startsWith('你负责整理其他助手对主人的了解。')) {
    const original = JSON.parse(messages[0].content[0].text).助手原始回答
    const items = original.trim().split('\n').filter(quote => !quote.startsWith('这是另一个助手')).map(quote => ({
      category:'preferences',
      quote,
      text:quote.replace(/\s*\[[^\]]+\]/g,'').trim(),
    }))
    return text(JSON.stringify({items}))
  }
  // 定时安排的早报、晚报：接口人的模型只依据快照撰写（scripts/schedules-ui-regression.mjs）。
  // 晚报模拟模型故障：定时安排先按 10 分钟间隔重试，第三次失败才在接口人对话里说明原因。
  if (typeof system === 'string' && system.startsWith('你是主人的接口人，正在写今天的晚报')) return { type: 'error', message: '模型服务暂时不可用（夹具）' }
  if (typeof system === 'string' && /^你是主人的接口人，正在写今天的(早报|晚报)/.test(system)) {
    const snapshot = JSON.parse(said(messages[0]))
    const open = snapshot.openOrders ?? []
    return text(`${system.includes('早报') ? '早报' : '晚报'}：今天还有 ${open.length} 张未关闭的工单${open[0] ? `，先看「${open[0].title}」` : ''}。`)
  }
  const done = id => messages.some(m => m.role === 'tool' && m.toolCallId === id)
  const owner = messages.findLast(m => m.role === 'user' && m.source?.kind === 'user')
  const words = owner?.content?.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
  const importRequest = '这是另一个助手对我的了解，帮我导入。\n'
  if (sessionId?.startsWith('chief-liaison-') && words?.startsWith(importRequest)) {
    if (!done('paste-profile')) return call('paste-profile','chief_import',{action:'submit',source:'Claude'})
    return text('')
  }
  const toolMessage = id => {
    const result = messages.find(m => m.role === 'tool' && m.toolCallId === id)
    if (!result || result.isError) return undefined
    try { return JSON.parse(result.content.find(block => block.type === 'text').text).message } catch { return undefined }
  }
  // 2026-11-25 owner's words: a schedule delivered to the liaison conversation (scripts/schedules-ui-regression.mjs).
  if (sessionId?.startsWith('chief-liaison-') && words === '每周一到周五上午 9:00 检查并提醒我各工作区尚未关闭的工单') {
    if (!done('schedule-open-orders')) return call('schedule-open-orders','chief_schedule',{action:'set',title:'未关闭工单提醒',when:'weekdays 09:00',content:'open-orders'})
    return text(toolMessage('schedule-open-orders') ?? '定时安排没有建成。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '周岚说后天给评审意见，你到时候上午十点回头看一下。') {
    const day = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    if (!done('schedule-self')) return call('schedule-self','chief_schedule',{action:'set',for:'self',at:day + 'T10:00',text:'看周岚给没给评审意见'})
    return text(toolMessage('schedule-self') ?? '跟进没有定好。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '帮我加一位社区导览员，负责帮助新成员上手。') {
    if (!done('staff-create-with-portrait')) return call('staff-create-with-portrait','chief_staff',{
      action:'create',id:'community-guide',name:'社区导览员',brief:'帮助社区新成员上手，整理资料入口并答复常见问题。',portrait_shape:'sprout',
    })
    const result = messages.find(m => m.role === 'tool' && m.toolCallId === 'staff-create-with-portrait')
    return text(result?.isError ? '社区导览员创建失败。' : '已添加社区导览员。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '请轮值访谈研究员记住本区做法：乙的独立经验。') {
    if (!done('staff-remember-local')) return call('staff-remember-local','chief_workspace',{action:'remember_staff',staff_name:'轮值访谈研究员',quote:'乙的独立经验'})
    return text('已记录本区访谈做法。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '以后本区访谈结束都先核对原始录音。') {
    if (!done('remember-shared-interview')) return call('remember-shared-interview','chief_workspace',{
      action:'remember_experience',quote:words,
    })
    return text('已记录本区共同做法。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words?.startsWith('请你自己核对访谈流程')) {
    const prompted = messages.some(message => (message.role === 'system' || message.source?.kind === 'runtime-context') && said(message).includes('〔SuperHub 经验版本〕')
      && said(message).includes('先核对原始录音'))
    return text(prompted ? '已收到本区共同经验。' : '本轮没有这条共同经验。')
  }
  if (history.includes('核对本轮获准的访谈方法')) {
    const actual = messages.filter(message => message.role === 'user').map(said).findLast(text => text.startsWith('〔本轮参考经验〕'))
    const given = actual ? (actual.split('\n本轮可参考的经验。')[1] ?? '').split('\n\n')[0]
      : systemText(system) + '\n' + messages.filter(m => m.role === 'system').map(said).join('\n')
    const visible = ['访谈结束复述约定', '甲的虚构访谈对象', '乙的独立经验','先核对原始录音'].filter(method => given.includes(method))
    return text('本轮可用记录为 ' + (visible.join('、') || '空') + '。')
  }
  if (sessionId?.startsWith('chief-v2-member-')) {
    const reply = member({ messages, system })
    if (reply) return reply
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '跟进展会约定。我答应小陈演示，小陈答应给样本，她还请我看预算，我没有答应。') {
    if (!done('exhibit-work')) return call('exhibit-work','chief_workspace',{action:'assign',title:'展会演示约定',promise:'跟进演示与样本，保留尚待答复的预算请求。',session_title:'展会筹备'})
    if (!done('exhibit-promises')) return call('exhibit-promises','chief_order_followup',{action:'record',entries:[
      {kind:'mine',quote:'我答应小陈演示',person:'小陈'},{kind:'theirs',quote:'小陈答应给样本',person:'小陈'},{kind:'request',quote:'她还请我看预算，我没有答应',person:'小陈'},
    ]})
    return text('演示由你负责，小陈给样本。预算仍待你回应。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '查刚才那张单目前记下的三项约定。') {
    if (!done('exhibit-read')) return call('exhibit-read','chief_order_followup',{action:'read',reference:'刚才那张单'})
    return text('已从工单核对了演示、样本和预算。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '当前这张单每周五17:00出稿，请给我本周成稿，我自己转发。') {
    if (!done('exhibit-schedule')) return call('exhibit-schedule','chief_order_followup',{action:'schedule',weekday:5,time:'17:00'})
    if (!done('exhibit-draft')) return call('exhibit-draft','chief_order_followup',{action:'draft'})
    return text('每周五 17:00 出稿。本期成稿已保存。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '这个工作区目前有哪些待跟进约定？') {
    if (!done('exhibit-open')) return call('exhibit-open','chief_order_followup',{action:'read'})
    return text('已核对本区未处理的约定。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '先停掉这张单的自动周报。') {
    if (!done('exhibit-stop')) return call('exhibit-stop','chief_order_followup',{action:'schedule',enabled:false})
    return text('自动周报已停用。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '请让 Codex 做一个手机报名页，我想自己试填一下。') {
    if (!done('signup-brief')) return call('signup-brief','chief_workspace',{action:'assign',executor:'codex',title:'手机试点报名页',promise:'交付可在手机填写并读回报名回执的页面。',session_title:'试点报名实现'})
    const result = messages.find(m => m.role === 'tool' && m.toolCallId === 'signup-brief')
    return text(result?.isError ? '交办失败。' : '我已接手，你可以打开工单。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '我今天有哪些安排？') {
    if (!tools?.some(tool => tool.name === 'chief_calendar')) return text('本回合没有日历工具。')
    if (!done('today-agenda')) return call('today-agenda','chief_calendar',{})
    const result = messages.find(m => m.role === 'tool' && m.toolCallId === 'today-agenda')
    const agenda = !result?.isError && JSON.parse(result.content.find(block => block.type === 'text').text)
    return text(agenda?.entries ? '今天的安排包括' + agenda.entries.map(entry => entry.title).join('、') + '。' : '没有读到日历。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '建一个工作区 叫做 字节 Landing') {
    if (!tools?.some(tool => tool.name === 'chief_workspace')) return text('本回合没有工作区工具。')
    if (!done('named-workspace')) return call('named-workspace','chief_workspace',{action:'create',name:'字节 Landing'})
    const result = messages.find(m => m.role === 'tool' && m.toolCallId === 'named-workspace')
    return text(result?.isError ? '工作区创建失败。' : '字节 Landing 工作区已就绪。')
  }
  if (sessionId?.startsWith('chief-liaison-') && words === '请帮我核对一下试点的联系人，整理成交给团队的清单。') {
    if (!done('check-trial-contact')) return call('check-trial-contact','chief_workspace',{
      action:'assign',title:'核对试点联系人',promise:'交付试点联系人清单。',session_title:'试点联系人梳理',executor:'dsh',
    })
    return text('联系人清单已交给团队跟进。')
  }
  if (sessionId?.startsWith('chief-v2-group-')) {
    if (history.includes('核对一下试点的联系人')) return text('我已经核对了试点联系人，可以在这张工单里查看结果。')
    const agreed = '我已整理本轮讨论，报名表只需要姓名和邮箱。'
    if (messages.some(m => m.role === 'assistant' && m.content?.some(b => b.type === 'text' && b.text === agreed))) return text('')
    if (history.includes('请同事一起核对报名表') && !done('invite-reviewer')) return call('invite-reviewer', 'spawn_teammate', {
      name: 'reviewer', description: '核对报名表字段', prompt: '核对报名字段后向 lead 发送群消息。',
    })
    if (!history.includes('我核对了报名字段，姓名和邮箱足够。')) return text('我已请负责核对的同事看看这两个字段。')
    return text(agreed)
  }
  if (history.includes('核对报名字段后向 lead 发送群消息') && !done('send-review')) {
    return call('send-review', 'send_message', { target: 'lead', message: '我核对了报名字段，姓名和邮箱足够。' })
  }
  return text('已完成本轮核对。')
}
async function* stream(block) {
  if (block.type === 'error') { yield { type:'finish', reason:{ kind:'error', failure:{ message:block.message } } }; return }
  yield { type:'block-start', index:0, blockType:block.type }
  if (block.type === 'text') yield { type:'text-delta', index:0, text:block.text }
  else yield { type:'tool-call-delta', index:0, id:block.id, name:block.name, argumentsDelta:block.arguments }
  yield { type:'block-end', index:0, block }
  yield { type:'finish', reason:{ kind:block.type === 'text' ? 'stop' : 'tool-calls' } }
}
export function apply(ctx) {
  ctx.on('ready', () => ctx.get('settings').update('ui-settings-account', { step:'done', completion:'skipped' }))
  ctx.on('llm/stream', request => stream(response(request)))
}
