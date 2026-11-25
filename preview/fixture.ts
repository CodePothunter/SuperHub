const person = (id: string, team: string, role: string, o: object = {}) => ({ id, name: id, team, role, lines: [], owe: 0, owed: 0, due: 0, ...o })
const people = [
  person('周岚', '数据平台', '研发负责人', { warmth: 'warm', influence: 'high', lines: ['数据平台接入'], daysSince: 2, lastContact: '2026-11-13', owe: 1, due: 1, stance: '支持' }),
  person('陈默', '数据平台', '调度系统 owner', { warmth: 'neutral', influence: 'mid', lines: ['数据平台接入'], daysSince: 9, reportsTo: '周岚' }),
  person('许知远', '数据平台', '产品经理', { warmth: 'warm', influence: 'mid', lines: ['数据平台接入'], daysSince: 4 }),
  person('韩松', '安全合规', '安全评审', { warmth: 'cold', influence: 'high', lines: ['安全评审'], daysSince: 21, owed: 1, due: 1, stance: '有顾虑' }),
  person('林溪', '安全合规', '合规 BP', { influence: 'low', lines: ['安全评审'] }),
  person('方远', '基础架构', '网关负责人', { warmth: 'neutral', influence: 'high', lines: ['网关限流改造'], daysSince: 6, owed: 1 }),
  person('苏禾', '基础架构', 'SRE', { warmth: 'warm', influence: 'low', lines: ['网关限流改造'], daysSince: 1, reportsTo: '方远' }),
  person('顾北', 'Agent 平台', '我的直属上级', { warmth: 'warm', influence: 'high', daysSince: 0, lastContact: '2026-11-15', owe: 1 }),
  person('叶知秋', '商业化', '运营负责人', { influence: 'mid', daysSince: 40 }),
]
const c = (id: string, direction: string, who: string, what: string, due: string | undefined, dueState: string, dueIn?: number, line?: string) => ({ id, direction, who, what, due, dueState, dueIn, line, status: 'open', createdAt: '' })
export const FIXTURE = {
  now: '', paused: false, problems: [], stuck: [],
  you: [
    { id: 'T-0012', title: '网关限流方案选型', stage: 'you/answer', staff: 'strategist', level: 'think', strength: 'explicit', scope: '', doneWhen: [], rounds: 1, hasProposal: false, latest: { executor: 'dsh', status: 'question', question: '方远倾向令牌桶，周岚要求不改现有 SDK。先保哪一边？', summary: '两个方案都能满足峰值，分歧在改造成本落在谁身上。', at: '' } },
    { id: 'T-0011', title: '和韩松的 1:1 准备材料', stage: 'you/review', staff: 'strategist', level: 'think', strength: 'rule', scope: '', doneWhen: [], rounds: 1, hasProposal: false, latest: { executor: 'dsh', status: 'ready', summary: '一页材料已写好：他最在意数据出域的审计链路，上次卡在日志保留期。建议开场先给出我们的保留期方案。', verdict: 'pass', critique: '', at: '' } },
  ],
  active: [{ id: 'T-0013', title: '整理本周横向进展', stage: 'working', staff: 'scribe', level: 'think', strength: 'rule', scope: '', doneWhen: [], rounds: 1, hasProposal: false }],
  queued: [], ended: [{ id: 'T-0009', title: '字节 Agent 入职学习清单', stage: 'ended', staff: 'researcher', ended: { outcome: 'done', at: '', note: '' } }],
  events: [{ at: '', source: 'inbox', text: '今天和周岚聊了排期，她答应周三给评审意见', disposition: '并入工单 T-0013' }],
  staff: [
    { id: 'chief', name: '研判官', executor: 'dsh', verifier: 'none', available: true, done: 0, doing: [], brief: '研判每一条事件：忽略、记一笔、并入在办工单，还是开新工单并指定负责的幕僚。' },
    { id: 'strategist', name: '谋士', executor: 'dsh', verifier: 'reviewer', available: true, done: 6, doing: [{ id: 'T-0012', title: '网关限流方案选型', stage: 'you/answer' }], brief: '负责帮主人想清楚：重要决定、方案取舍、沟通策略、会前准备。' },
    { id: 'scribe', name: '书记官', executor: 'dsh', verifier: 'reviewer', available: true, done: 9, doing: [{ id: 'T-0013', title: '整理本周横向进展', stage: 'working' }], brief: '负责主人的记忆：把主人说的话、会议纪要拆成花名册里的记录，写日志和复盘。' },
    { id: 'researcher', name: '研究员', executor: 'dsh', verifier: 'reviewer', available: true, done: 3, doing: [], brief: '负责调研、梳理与成文：把零散信息整理成主人能直接用的材料。' },
    { id: 'engineer', name: '工程师', executor: 'claude-code', verifier: 'reviewer', available: true, done: 1, doing: [], brief: '负责写代码、读代码、做技术方案与原型。' },
    { id: 'reviewer', name: '审查官', executor: 'dsh', verifier: 'none', available: true, done: 0, doing: [], brief: '负责独立核验：只看产出，不看执行过程，按完成标准逐条判断是否真的完成。' },
    { id: 'liaison', name: '外务', executor: 'remote', verifier: 'reviewer', available: true, done: 2, doing: [], brief: '负责必须在工作电脑上完成的任务。' },
  ],
  sources: [
    { id: 'inbox', name: '你的交办', what: '你对接口人说的、在台面上点的', mode: 'auto', fixed: true },
    { id: 'morning-brief', name: '定时：morning-brief', what: 'weekdays 08:30，早报', mode: 'auto', fixed: true },
    { id: 'meeting-prep', name: '会议临近', what: '登记过的会议开始前 12 小时，让谋士写准备材料', mode: 'auto', fixed: false },
    { id: 'commitment-due', name: '承诺逾期', what: '别人答应你的事过了约定日期，让谋士起草催办（不发送）', mode: 'auto', fixed: false },
    { id: 'stale-contact', name: '该联系了', what: '影响力高的人超过 14 天没联系，建议一个联系的由头', mode: 'observe', fixed: false },
  ],
  events: [
    { id: 'e1', at: '2026-11-15T07:02:00Z', source: 'stale-contact', kind: 'observed', disposition: '只记录，没有处理', text: '该联系了：韩松（影响力高）已经 21 天没有联系。' },
    { id: 'e2', at: '2026-11-15T06:40:00Z', source: 'inbox', kind: 'accepted', disposition: '开单 T-0012', ticketId: 'T-0012', reason: '方案取舍需要成文比较，交给谋士', text: '主人点名交给谋士：网关限流两个方案帮我比一下' },
    { id: 'e3', at: '2026-11-15T03:00:00Z', source: 'meeting-prep', kind: 'accepted', disposition: '开单 T-0011', ticketId: 'T-0011', reason: '按规则为今天的 1:1 准备材料', text: '会议准备：「和韩松 1:1」，时间 2026-11-15 15:00' },
    { id: 'e4', at: '2026-11-15T00:30:00Z', source: 'commitment-due', kind: 'accepted', disposition: '开单 T-0010', ticketId: 'T-0010', reason: '逾期 3 天，起草催办', text: '承诺逾期：韩松 答应的「给出日志保留期的评审意见」约定 2026-11-12' },
    { id: 'e5', at: '2026-11-14T13:30:00Z', source: 'inbox', kind: 'ignored', disposition: '忽略', reason: '只是寒暄，没有需要跟进的事', text: '今天食堂的面不错' },
  ],
  goals: '', remote: { waiting: 0, taken: 0 }, rules: [{ id: 'morning-brief', when: 'weekdays 08:30' }],
  poc: {
    today: '2026-11-15', people,
    lines: [
      { id: '数据平台接入', name: '数据平台接入', goal: '12 月前把调度切到新平台', health: 'green', partners: ['周岚', '陈默', '许知远'], nextSync: '2026-11-18', syncIn: 3, open: 1, lastProgress: '2026-11-14 接口评审通过，开始联调' },
      { id: '安全评审', name: '安全评审', goal: '拿到数据出域的评审结论', health: 'red', partners: ['韩松', '林溪'], blocker: '等安全团队排期，已拖一周', syncIn: -2, open: 1 },
      { id: '网关限流改造', name: '网关限流改造', goal: '峰值不再打挂下游', health: 'yellow', partners: ['方远', '苏禾'], syncIn: 0, open: 1, lastProgress: '2026-11-13 压测报告已出，两个方案待选' },
    ],
    ledger: [
      c('C-0004', 'theirs', '韩松', '给出日志保留期的评审意见', '2026-11-12', 'overdue', -3, '安全评审'),
      c('C-0007', 'mine', '周岚', '发接口文档终稿', '2026-11-15', 'today', 0, '数据平台接入'),
      c('C-0008', 'mine', '顾北', '本周横向进展一页纸', '2026-11-17', 'soon', 2),
      c('C-0006', 'theirs', '方远', '网关压测原始数据', '2026-11-19', 'later', 4, '网关限流改造'),
    ],
    closed: [],
    meetings: [
      { id: 'M-0003', title: '网关限流方案评审', at: '2026-11-14T16:00', with: ['方远', '苏禾'], line: '网关限流改造', past: true, today: false, needsNotes: true },
      { id: 'M-0004', title: '和韩松 1:1', at: '2026-11-15T15:00', with: ['韩松'], line: '安全评审', past: false, today: true, needsNotes: false, prepTicket: 'T-0011' },
      { id: 'M-0005', title: '数据平台周会', at: '2026-11-18T10:30', with: ['周岚', '陈默', '许知远'], line: '数据平台接入', past: false, today: false, needsNotes: false },
    ],
    situation: { decide: 2, overdue: 1, dueToday: 1, blocked: 1, meetingsToday: 1, stale: 3 },
  },
}
export const PERSON = { id: '韩松', name: '韩松', team: '安全合规', role: '安全评审', warmth: 'cold', influence: 'high', stance: '有顾虑', lastContact: '2026-10-25',
  profile: '最在意审计链路是否完整。讨厌临时加塞，提前两天给材料会顺很多。', facts: ['2026-11-01 负责所有数据出域类评审'], log: ['2026-10-25 [1:1] 卡在日志保留期，他要 180 天，我们现在是 30 天', '2026-10-18 [会议] 第一次过方案，提了三个问题'] }
export const LINE = { id: '安全评审', name: '安全评审', goal: '拿到数据出域的评审结论', health: 'red', partners: ['韩松', '林溪'], blocker: '等安全团队排期，已拖一周', log: ['2026-11-08 材料已提交，等排期'] }

export const CHAT = { busy: false, messages: [
  { seq: 1, role: 'you', time: 0, text: '今天下午和周岚过了一遍接入方案，她说周三前给我评审意见。我答应她今天把接口文档终稿发过去。' },
  { seq: 2, role: 'liaison', time: 0, text: '记下了：周岚周三前给你评审意见；你今天要把接口文档终稿发给她。\n\n这条算在「数据平台接入」线上。', did: ['记入花名册 3 条'] },
  { seq: 3, role: 'you', time: 0, text: '韩松那边还是没动静，这人比较冷，安全评审这条线我看有点悬' },
  { seq: 4, role: 'liaison', time: 0, text: '已经把韩松的关系标成"冷"，「安全评审」标成出问题。\n\n他欠你的日志保留期评审意见已经逾期 3 天。今天 15:00 你和他有 1:1，准备材料已经写好了，要不要我再起草一条会前提醒？', did: ['记入花名册 2 条', '查了花名册'] },
] }
