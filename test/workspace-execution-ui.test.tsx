import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2Delegation, V2ExecutionView, V2PendingApproval, V2Session } from '../src/core/workspace-v2.ts'
import * as client from '../src/client/workspace-v2-api.ts'
import { ApprovalCard, OrderExecution, OrderPermission, PendingCommandApprovals, SessionExecution } from '../src/client/workspace-execution.tsx'
import { isApprovalList, isExecutionView, type ApprovalListItem } from '../src/client/workspace-v2-response.ts'
import { WORKSPACE_V2_STYLE as workspaceV2Style } from '../src/client/workspace-v2-style.ts'

const at = '2026-11-20T08:10:00Z'
const session: V2Session = { id:'session', workspaceId:'space', title:'方舟核查', kind:'coding', executor:'codex', delegationIds:['order'], closed:false, createdAt:at }
const job: V2Delegation = { id:'order', workspaceId:'space', sessionId:'session', title:'核查方舟控制台', promise:'八题结论', owner:'接口人',
  status:'active', nextCheckAt:at, generation:1, remainingTurns:2, createdAt:at, boundary:'只读' }
const long = 'arkcli resources list --region cn-beijing --output json ' + '--filter name=x '.repeat(20)
const execution: V2ExecutionView = {
  commands:[
    {id:'c1', turnId:'t1', workOrderId:'order', at, tool:'shell', command:'arkcli --version', cwd:'/w', exitCode:0, outputTail:'arkcli 1.0.50', endedAt:at},
    {id:'c2', turnId:'t1', workOrderId:'order', at:'2026-11-20T08:11:00Z', tool:'shell', command:long, cwd:'/w', exitCode:1, failed:true, outputTail:'unauthorized', endedAt:at},
    {id:'c3', turnId:'t1', workOrderId:'order', at:'2026-11-20T08:12:00Z', tool:'shell', command:'sleep 330', cwd:'/w'},
  ],
  runs:[
    {turnId:'t0', workOrderId:'order', tool:'codex', state:'done', nativeSessionId:'019a-old', endedAt:'2026-11-20T08:00:00Z', process:{exitCode:0, stderrTail:''}},
    {turnId:'t1', workOrderId:'order', tool:'codex', state:'unknown', nativeSessionId:'019a-thread', resumed:true, endedAt:'2026-11-20T08:13:00Z',
      process:{exitCode:1, stderrTail:'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'}},
  ],
}
const path = '/v2/workspaces/space/orders/order/execution'
const view = {scope:'brain', workspaceId:'space', delegationId:'order', ...execution}
function render(data: object, room = session) {
  vi.spyOn(client, 'useV2Read').mockImplementation((_resource, valid) => ({
    data: valid(data as never, path) ? data as never : undefined, error:undefined, refresh:async () => {},
  }))
  return renderToStaticMarkup(<OrderExecution base="/v2/workspaces/space" job={job} session={room}/>)
}
afterEach(() => vi.restoreAllMocks())

describe('工单执行记录', () => {
  it('accepts only the scoped order and well-formed records', () => {
    expect(isExecutionView(view, path)).toBe(true)
    expect(isExecutionView(view, '/v2/workspaces/space/orders/other/execution')).toBe(false)
    expect(isExecutionView({...view, commands:[{...execution.commands[0], workOrderId:'other'}]}, path)).toBe(false)
    expect(isExecutionView({...view, commands:[{...execution.commands[0], exitCode:'0'}]}, path)).toBe(false)
    expect(isExecutionView({...view, runs:[{...execution.runs[0], process:{stderrTail:''}}]}, path)).toBe(false)
    expect(isExecutionView({...view, runs:undefined}, path)).toBe(false)
  })

  it('lists commands newest first with exit codes, expandable output and the failed tool process', () => {
    const html = render(view)
    expect(html).toContain('执行记录（3 条命令）')
    for (const text of ['arkcli --version', '退出码 0', '退出码 1', '运行中', 'sleep 330', '输出末尾', 'arkcli 1.0.50', 'unauthorized',
      '工具进程异常结束 · 退出码 1', '错误输出末尾', 'Operation not permitted', 'codex resume 019a-thread', '完全访问']) expect(html).toContain(text)
    expect(html.indexOf('sleep 330')).toBeLessThan(html.indexOf('arkcli --version'))
    expect(html.indexOf('工具进程异常结束')).toBeLessThan(html.indexOf('sleep 330'))
    expect(html).not.toContain('019a-old</code>')
    expect(html).toContain(long.trim())
    expect(html.match(/data-state="failed"/g)).toHaveLength(2)
  })

  it('explains an empty record and names the Claude Code resume command', () => {
    expect(render({...view, commands:[], runs:[]})).toContain('还没有执行记录')
    const claude = render({...view, runs:[{...execution.runs[0], tool:'claude-code', nativeSessionId:'cc-1'}]}, {...session, executor:'claude-code'})
    expect(claude).toContain('Claude Code 以你的本机配置运行')
    expect(claude).toContain('claude --resume cc-1')
  })

  it('wraps long commands and output inside narrow layouts', () => {
    expect(workspaceV2Style).toMatch(/\.v2-exec-pre \{[^}]*max-width:100%[^}]*overflow:auto[^}]*white-space:pre-wrap/)
    expect(workspaceV2Style).toMatch(/:is\(\.v2-exec-command,\.v2-exec-pre,\.v2-exec-note code\) \{[^}]*overflow-wrap:anywhere/)
  })
})

/** Every host element in a component's output, without a DOM (the components here only use mocked data hooks). */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  if (typeof node.type === 'function') return elements((node.type as (props: object) => ReactNode)(node.props))
  return [node, ...elements(node.props.children as ReactNode)]
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join('') : isValidElement<{children?: ReactNode}>(node) ? text(node.props.children) : node === null || node === undefined || typeof node === 'boolean' ? '' : String(node)
function writer() {
  const posts: [string, Record<string, unknown>][] = []
  vi.spyOn(client, 'useV2Write').mockImplementation(() => ({busy:false, error:'', post:async (resource: string, body: Record<string, unknown>) => {
    posts.push([resource, body])
    return {scope:'brain'} as never
  }}) as never)
  return posts
}
const pending: V2PendingApproval = {id:'a-1', workspaceId:'space', sessionId:'session', workOrderId:'order', turnId:'t1', tool:'codex',
  command:'rm -rf /home/owner/work/space/build/probe.txt && git push origin main', cwd:'/home/owner/work/space/build', reason:'删除文件：rm（自动审查超时，转请主人批准）',
  requestedAt:at, expiresAt:'2026-11-20T08:40:00Z'}

describe('命令档位与审批', () => {
  it('shows the three tiers with the current one pressed, saves a change and refreshes the order', async () => {
    const posts = writer()
    let refreshed = 0
    const html = renderToStaticMarkup(<OrderPermission base="/v2/workspaces/space" job={job} changed={async () => { refreshed++ }}/>)
    for (const label of ['命令档位', '下一条命令起生效', '请求批准', '代为批准', '完全访问', '所有命令直接执行']) expect(html).toContain(label)
    expect(html).toMatch(/aria-pressed="true"[^>]*>完全访问/)
    const buttons = elements(OrderPermission({base:'/v2/workspaces/space', job, changed:async () => { refreshed++ }})).filter(el => el.type === 'button')
    expect(buttons.map(button => [text(button.props.children as ReactNode), button.props['aria-pressed']])).toEqual([['请求批准', false], ['代为批准', false], ['完全访问', true]])
    await (buttons[0]!.props.onClick as () => Promise<void>)()
    await vi.waitFor(() => expect(refreshed).toBe(1))
    expect(posts).toEqual([['/v2/workspaces/space/orders/order/permission', {permission:'ask'}]])
    ;(buttons[2]!.props.onClick as () => void)()
    expect(posts).toHaveLength(1)
    const asked = renderToStaticMarkup(<OrderPermission base="/v2/workspaces/space" job={{...job, permission:'ask', permissionChangedAt:at}} changed={async () => {}}/>)
    expect(asked).toMatch(/aria-pressed="true"[^>]*>请求批准/)
    expect(asked).toContain('高危命令逐条等你批准')
    expect(renderToStaticMarkup(<OrderPermission base="/v2/workspaces/space" job={{...job, status:'closed'}} changed={async () => {}}/>).match(/disabled=""/g)).toHaveLength(3)
  })

  it('shows the full command, absolute directory, reason and expiry, and posts the owner\'s decision to the order', async () => {
    const posts = writer()
    let decided = 0
    const html = renderToStaticMarkup(<ApprovalCard row={pending} path="/v2/workspaces/space/orders/order" decided={async () => { decided++ }}/>)
    for (const value of ['等你决定', 'Codex 申请运行', pending.command.replaceAll('&', '&amp;'), pending.cwd, pending.reason, '前未处理会过期', 'dateTime="2026-11-20T08:40:00Z"', '批准', '拒绝']) expect(html).toContain(value)
    const buttons = elements(ApprovalCard({row:pending, path:'/v2/workspaces/space/orders/order', decided:async () => { decided++ }})).filter(el => el.type === 'button')
    expect(buttons.map(button => text(button.props.children as ReactNode))).toEqual(['批准', '拒绝'])
    await (buttons[1]!.props.onClick as () => Promise<void>)()
    await (buttons[0]!.props.onClick as () => Promise<void>)()
    await vi.waitFor(() => expect(decided).toBe(2))
    expect(posts).toEqual([['/v2/workspaces/space/orders/order/approvals/a-1', {allow:false}], ['/v2/workspaces/space/orders/order/approvals/a-1', {allow:true}]])
  })

  it('labels each gate decision and shows a refused command as not run', () => {
    const decisions = {...view, commands:[
      {id:'g1', turnId:'t1', workOrderId:'order', at, tool:'Bash', command:'rm probe.txt', cwd:'/w', risk:'high', tier:'ask', decision:'allowed', by:'owner', reason:'主人允许本次执行', exitCode:0, endedAt:at},
      {id:'g2', turnId:'t1', workOrderId:'order', at, tool:'Bash', command:'git push', cwd:'/w', risk:'high', tier:'ask', decision:'rejected', by:'owner', reason:'主人拒绝', exitCode:null, failed:true, endedAt:at},
      {id:'g3', turnId:'t1', workOrderId:'order', at, tool:'Bash', command:'npm ci', cwd:'/w', risk:'high', tier:'approve-for-me', decision:'reviewer-denied', by:'reviewer', reason:'越出工单目标'},
      {id:'g4', turnId:'t1', workOrderId:'order', at, tool:'Bash', command:'ls', cwd:'/w', risk:'normal', tier:'ask', decision:'auto', by:'policy', reason:'不在高危清单内', exitCode:0, endedAt:at},
      {id:'g5', turnId:'t1', workOrderId:'order', at, tool:'Bash', command:'rm x', cwd:'/w', risk:'high', tier:'full-access', decision:'auto', by:'policy', reason:'完全访问：删除文件：rm'},
      {id:'g6', turnId:'t1', workOrderId:'order', at, tool:'Bash', command:'sudo id', cwd:'/w', risk:'high', tier:'ask', decision:'expired', by:'gate', reason:'审批未在 30 分钟内处理，已过期'},
      {id:'g7', turnId:'t1', workOrderId:'order', at, tool:'Bash', command:'rm y', cwd:'/w', risk:'high', tier:'ask', decision:'reviewer-allowed', by:'reviewer', reason:'符合目标', exitCode:0, endedAt:at},
      {id:'g8', turnId:'t1', workOrderId:'order', at, tool:'Bash', command:'rm z', cwd:'/w', risk:'high', tier:'ask', decision:'gate-unavailable', by:'gate', reason:'读不到工单的当前档位'},
    ], runs:[], permissions:[{at, from:'full-access', to:'ask'}]}
    expect(isExecutionView(decisions, path)).toBe(true)
    const html = render(decisions)
    for (const label of ['已允许', '已拒绝', '代为拒绝', '自动放行', '已过期', '代为放行', '把关不可用', '主人拒绝', '越出工单目标', '高危命令 · 完全访问：删除文件：rm',
      '命令档位：完全访问 → 请求批准']) expect(html).toContain(label)
    expect(html.match(/data-state="denied"/g)).toHaveLength(4)
    expect(html.match(/未执行/g)).toHaveLength(4)
    expect(html).toContain('data-decision="rejected"')
    expect(isExecutionView({...decisions, commands:[{...decisions.commands[0], decision:'maybe'}]}, path)).toBe(false)
    expect(isExecutionView({...decisions, permissions:[{at, from:'ask', to:'sandbox'}]}, path)).toBe(false)
  })

  it('shows the order\'s pending approval cards above the record, and the discussion its own record', () => {
    const list = {scope:'brain', approvals:[{...pending, workspaceName:'方舟', sessionTitle:'方舟核查', orderTitle:'核查方舟控制台'},
      {...pending, id:'a-2', workOrderId:'other', workspaceName:'方舟', sessionTitle:'方舟核查'}]}
    expect(isApprovalList(list)).toBe(true)
    vi.spyOn(client, 'useV2Read').mockImplementation((resource, valid) => ({
      data: resource === '/v2/approvals' && valid(list as never, resource) ? list as never : undefined, error:undefined, refresh:async () => {},
    }))
    const html = renderToStaticMarkup(<OrderExecution base="/v2/workspaces/space" job={job} session={session}/>)
    expect(html.match(/class="v2-approval"/g)).toHaveLength(1)
    expect(html.indexOf('等你决定')).toBeLessThan(html.indexOf('<summary>执行记录'))
    const discussion = renderToStaticMarkup(<SessionExecution base="/v2/workspaces/space" session={session}/>)
    expect(discussion).toContain('会话讨论的执行记录')
    expect(discussion).not.toContain('class="v2-approval"')
  })

  it('lists every pending command on 「今天」 and opens its order; elsewhere it shows a short reminder', () => {
    const rows: ApprovalListItem[] = [{...pending, workspaceName:'方舟', sessionTitle:'方舟核查', orderTitle:'核查方舟控制台'},
      {...pending, id:'a-2', workOrderId:null, workspaceName:'方舟', sessionTitle:'方舟核查'}]
    const list = {scope:'brain', approvals:rows}
    vi.spyOn(client, 'useV2Read').mockImplementation((_resource, valid) => ({
      data: valid(list as never, '/v2/approvals') ? list as never : undefined, error:undefined, refresh:async () => {},
    }))
    const opened: ApprovalListItem[] = []
    let today = 0
    const html = renderToStaticMarkup(<PendingCommandApprovals today goToday={() => { today++ }} open={row => opened.push(row)}/>)
    for (const value of ['等你决定（2 条命令）', '核查方舟控制台', '方舟核查', '方舟 · Codex', '前未处理会过期']) expect(html).toContain(value)
    const buttons = elements(PendingCommandApprovals({today:true, goToday:() => { today++ }, open:row => opened.push(row)})).filter(el => el.type === 'button')
    ;(buttons[0]!.props.onClick as () => void)()
    expect(opened.map(row => row.id)).toEqual(['a-1'])
    const elsewhere = renderToStaticMarkup(<PendingCommandApprovals today={false} goToday={() => { today++ }} open={() => {}}/>)
    expect(elsewhere).toContain('2 条命令等你决定')
    expect(isApprovalList({scope:'brain', approvals:[{...pending}]} as never)).toBe(false)
    expect(isApprovalList({scope:'brain', approvals:[{...rows[0], tool:'shell'}]} as never)).toBe(false)
  })

  it('keeps the tier control, approval cards and 「等你决定」 readable in narrow and dark layouts', () => {
    expect(workspaceV2Style).toMatch(/\.v2-tier-options \{[^}]*flex-wrap:wrap/)
    expect(workspaceV2Style).toMatch(/\.v2-tier-option\[aria-pressed=true\] \{[^}]*var\(--hub-brand\)/)
    expect(workspaceV2Style).toMatch(/\.v2-approval-facts dd \{[^}]*min-width:0[^}]*overflow-wrap:anywhere/)
    expect(workspaceV2Style).toMatch(/\.v2-approval \{[^}]*min-width:0/)
    // 「等你决定」 takes its own row on 「今天」 and pushes the result inbox and lists below it, in both layouts.
    expect(workspaceV2Style).toMatch(/\.v2-home>\.v2-pending-approvals \{ grid-area:3\/1\/4\/-1/)
    expect(workspaceV2Style).toMatch(/\.v2-pending-approvals~\.v2-result-inbox~:is\(\.v2-history,\.v2-today\) \{ grid-row:5; \}/)
    expect(workspaceV2Style).toMatch(/@container\(max-width:740px\)[\s\S]*\.v2-pending-approvals~\.v2-result-inbox~\.v2-today \{ grid-row:7; \}/)
    expect(workspaceV2Style).not.toMatch(/\.v2-(?:tier|approval|decision)[^{]*\{[^}]*#[0-9a-fA-F]{3,6}/)
  })
})
