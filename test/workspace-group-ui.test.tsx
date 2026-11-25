import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pagedReadsFromV2Read } from './paged-read-mock.ts'
import type { SpeakerPortraits } from '../src/core/workspace-avatars.ts'
import type { V2Delegation, V2PendingApproval, V2Session, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import type { GroupMemberState } from '../src/dsh/workspace-v2.ts'
import type { Scoped } from '../src/client/superhub-api.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import { Transcript } from '../src/client/workspace-v2-talk.tsx'
import { CreateSession, WorkOrderPage } from '../src/client/workspace-v2.tsx'
import { byMember, PendingCommandApprovals } from '../src/client/workspace-execution.tsx'
import {
  busyMembers, GroupDeliveries, GroupStatus, insertMention, mentionKey, MentionMenu, mentionOptions, mentionQuery, type MentionOption,
} from '../src/client/workspace-group.tsx'
import { isApprovalList, isSessionView, pendingApproval, type GroupState, type SessionLine } from '../src/client/workspace-v2-response.ts'
import { WORKSPACE_V2_STYLE } from '../src/client/workspace-v2-style.ts'
import { OwnerActions } from '../src/client/workspace-owner-actions.tsx'
import type { OwnerAction } from '../src/core/workspace-engagement.ts'

const at = '2026-11-24T08:00:00Z'
const id = (letter: string) => 's-' + letter.repeat(24)
const session: V2Session = { id:'g', workspaceId:'w', title:'方舟端点', kind:'group', executor:'dsh', engine:'roster', delegationIds:['d'], closed:false, createdAt:at }
const order: V2Delegation = { id:'d', workspaceId:'w', sessionId:'g', title:'核对开通的端点', promise:'端点清单', owner:'接口人', status:'active',
  boundary:'只读', remainingTurns:30, generation:1, createdAt:at }
const view: V2WorkspaceView = { scope:'brain', workspace:{id:'w', name:'方舟评测', goal:'', owner:'我', createdAt:at}, orders:[order], delegations:[order], sessions:[session], decisions:[] }
const member = (row: Partial<GroupMemberState> & Pick<GroupMemberState, 'id' | 'name' | 'speakerId'>): GroupMemberState =>
  ({ admin:false, kind:'dsh', status:'idle', queued:0, ...row })
const liaison = member({ id:'liaison', name:'接口人', speakerId:id('a'), admin:true })
const engineer = member({ id:'engineer', name:'工程师', speakerId:id('b'), kind:'codex', status:'working', since:'2026-11-24T08:01:00Z', note:'接口人 @ 了你', workOrderId:'d',
  duty:'效果评测：跑 arkcli 与脚本', tool:{name:'shell', detail:'arkcli endpoint list --region cn-beijing', at:'2026-11-24T08:04:00Z'},
  progress:{text:'正在运行 arkcli endpoint list', at:'2026-11-24T08:01:30Z'} })
const researcher = member({ id:'researcher', name:'研究员', speakerId:id('c'), status:'approval', since:'2026-11-24T08:02:00Z', note:'主人 @ 了你' })
const strategist = member({ id:'strategist', name:'谋士', speakerId:id('d'), status:'queued', queued:1 })
const members = [liaison, engineer, researcher, strategist]
const portraits: SpeakerPortraits = { owner:{shape:'plane', color:'blue'}, [id('a')]:{shape:'sprout', color:'mint'}, [id('b')]:{shape:'wrench', color:'apricot'},
  [id('c')]:{shape:'compass', color:'teal'}, [id('d')]:{shape:'key', color:'violet'} }
const approval: V2PendingApproval = { id:'a-1', workspaceId:'w', sessionId:'g', workOrderId:'d', turnId:'call-7', tool:'dsh', memberId:'researcher',
  command:'rm -rf ./tmp/probe', cwd:'/home/owner/projects/arklab', reason:'删除文件：rm', requestedAt:at, expiresAt:'2026-11-24T08:30:00Z' }
const lines: SessionLine[] = [
  { id:'g-1', seq:1, kind:'message', role:'user', author:'你', speakerId:'owner', at, text:'@工程师 看一下 arkcli 能不能拿到端点，`@研究员` 不用管',
    mentions:[{memberId:'engineer', label:'工程师'}, {text:' 看一下 arkcli 能不能拿到端点，`@研究员` 不用管'}], deliveries:[{memberId:'engineer', outcome:'steered'}] },
  { id:'g-2', seq:2, kind:'progress', role:'agent', author:'工程师', speakerId:id('b'), at:'2026-11-24T08:01:30Z', text:'正在运行 arkcli endpoint list', workOrderId:'d' },
  { id:'g-3', seq:3, kind:'message', role:'agent', author:'接口人', speakerId:id('a'), at:'2026-11-24T08:01:40Z', text:'- 已交给 @工程师\n- 结果出来后 @所有人 一起看',
    workOrderId:'d', mentions:[{text:'- 已交给 '}, {memberId:'engineer', label:'工程师'}, {text:'\n- 结果出来后 '}, {all:true, label:'所有人'}, {text:' 一起看'}] },
  { id:'g-4', seq:4, kind:'event', role:'agent', author:'SuperHub', at:'2026-11-24T08:05:00Z', event:'paused',
    text:'已暂停自动叫人：研究员 与成员之间连续 6 次没调用工具、只是客套或重复。对 @谋士 的叫人先挂起，主人发言后继续。' },
]
const pause = { reason:lines[3]!.text, since:'2026-11-24T08:05:00Z', parked:1, messageId:'g-4' }
const group: GroupState = { members, paused:pause, approvals:[approval] }
const sessionPath = '/v2/workspaces/w/sessions/g'
const sessionView = { scope:'brain', session, messages:lines, portraits, observedAt:Date.parse('2026-11-24T08:06:00Z'), group, working:true }

afterEach(() => vi.restoreAllMocks())
beforeEach(() => pagedReadsFromV2Read())

function mockReads(responses: Record<string, Scoped & Record<string, unknown>>) {
  vi.spyOn(api, 'useV2Read').mockImplementation((resource, valid) => {
    const value = resource ? responses[resource] : undefined
    return { data: resource && value && valid(value, resource) ? value : undefined, error: undefined, refresh: async () => {} }
  })
}
/** Every host element in a component's output; the components walked here use no hooks other than the mocked writer. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  if (typeof node.type === 'function') return elements((node.type as (props: object) => ReactNode)(node.props))
  return [node, ...elements(node.props.children as ReactNode)]
}
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join('') : isValidElement<{children?: ReactNode}>(node) ? text(node.props.children)
  : node === null || node === undefined || typeof node === 'boolean' ? '' : String(node)
const buttons = (node: ReactNode) => elements(node).filter(el => el.type === 'button')

describe('群聊的读取校验', () => {
  it('accepts a roster group view with speakerless event lines, mention segments, deliveries and a DSH member approval', () => {
    expect(isSessionView(sessionView as never, sessionPath)).toBe(true)
    // SuperHub's own lines carry no speaker; a made-up speaker id, a broken segment, delivery or member state rejects the read.
    expect(isSessionView({...sessionView, messages:[{...lines[3]!, speakerId:'host'}]} as never, sessionPath)).toBe(false)
    expect(isSessionView({...sessionView, messages:[{...lines[0]!, mentions:[{memberId:'engineer'}]}]} as never, sessionPath)).toBe(false)
    expect(isSessionView({...sessionView, messages:[{...lines[0]!, deliveries:[{memberId:'engineer', outcome:'rejected'}]}]} as never, sessionPath)).toBe(false)
    expect(isSessionView({...sessionView, messages:[{...lines[2]!, deliveries:[{memberId:'engineer', outcome:'started'}]}]} as never, sessionPath)).toBe(false)
    expect(isSessionView({...sessionView, group:{...group, paused:true}} as never, sessionPath)).toBe(false)
    expect(isSessionView({...sessionView, group:{...group, paused:undefined}} as never, sessionPath)).toBe(true)
    expect(isSessionView({...sessionView, group:{...group, members:[{...engineer, tool:{name:'shell'}}]}} as never, sessionPath)).toBe(false)
    expect(isSessionView({...sessionView, group:{...group, members:[{...engineer, status:'busy'}]}} as never, sessionPath)).toBe(false)
    expect(isSessionView({...sessionView, group:{...group, approvals:[{...approval, sessionId:'other'}]}} as never, sessionPath)).toBe(false)
    expect(isSessionView({...sessionView, session:{...session, engine:'other'}} as never, sessionPath)).toBe(false)
    expect(pendingApproval(approval, 'w')).toBe(true)
    expect(pendingApproval({...approval, tool:'shell'}, 'w')).toBe(false)
    expect(isApprovalList({scope:'brain', approvals:[{...approval, workspaceName:'方舟评测', sessionTitle:'方舟端点', memberName:'研究员'}]} as never)).toBe(true)
  })
})

describe('@ 菜单', () => {
  it('finds the @ being typed, lists members first and 「所有人」 last, and inserts the name with a space', () => {
    expect(mentionQuery('请 @工', 4)).toEqual({start:2, query:'工'})
    expect(mentionQuery('@', 1)).toEqual({start:0, query:''})
    expect(mentionQuery('mail a@b', 8)).toBeUndefined()
    expect(mentionQuery('@工程师 看一下', 9)).toBeUndefined()
    expect(mentionQuery('@工程师 看一下', 4)).toEqual({start:0, query:'工程师'})
    expect(mentionOptions(members, '').map(row => row.label)).toEqual(['接口人', '工程师', '研究员', '谋士', '所有人'])
    expect(mentionOptions(members, '研').map(row => row.label)).toEqual(['研究员'])
    // A prefix match comes before a match inside the name; 「所有人」 is offered for its own words.
    expect(mentionOptions([...members, member({id:'x', name:'首席研究', speakerId:id('e')})], '研').map(row => row.label)).toEqual(['研究员', '首席研究'])
    expect(mentionOptions(members, '所').map(row => row.label)).toEqual(['所有人'])
    expect(mentionOptions(members, 'al').map(row => row.label)).toEqual(['所有人'])
    expect(mentionOptions(members, 'zz')).toEqual([])
    expect(insertMention('请 @工 看看', 2, 4, '工程师')).toEqual({text:'请 @工程师 看看', caret:7})
    expect(insertMention('@', 0, 1, '所有人')).toEqual({text:'@所有人 ', caret:5})
  })

  it('moves with the arrow keys, picks with Enter or Tab, closes with Escape and leaves keys alone while an input method composes', () => {
    expect(mentionKey({key:'ArrowDown'})).toEqual({move:1})
    expect(mentionKey({key:'ArrowUp'})).toEqual({move:-1})
    expect(mentionKey({key:'Enter'})).toEqual({pick:true})
    expect(mentionKey({key:'Tab'})).toEqual({pick:true})
    expect(mentionKey({key:'Escape'})).toEqual({close:true})
    expect(mentionKey({key:'Enter', isComposing:true})).toBeUndefined()
    expect(mentionKey({key:'ArrowDown', keyCode:229})).toBeUndefined()
    // Ctrl/⌘+Enter still sends; Shift+Tab leaves the field.
    expect(mentionKey({key:'Enter', ctrlKey:true})).toBeUndefined()
    expect(mentionKey({key:'Enter', metaKey:true})).toBeUndefined()
    expect(mentionKey({key:'Tab', shiftKey:true})).toBeUndefined()
    expect(mentionKey({key:'a'})).toBeUndefined()
  })

  it('shows each option with its avatar, marks and duty, and picks on press without taking the focus', () => {
    const options = mentionOptions(members, '')
    const picked: MentionOption[] = []
    const menu = <MentionMenu id="m" options={options} active={1} portraits={portraits} pick={row => picked.push(row)}/>
    const html = renderToStaticMarkup(menu)
    expect(html).toMatch(/^<ul class="v2-mention-menu" id="m" role="listbox" aria-label="提及成员">/)
    expect(html.match(/role="option"/g)).toHaveLength(5)
    expect(html).toMatch(/id="m-1" role="option" aria-selected="true" data-option="engineer">.*data-shape="wrench".*<strong>工程师<\/strong><span class="v2-member-badge" data-badge="codex">Codex<\/span><small>效果评测：跑 arkcli 与脚本<\/small>/)
    expect(html).toMatch(/data-option="liaison">.*<strong>接口人<\/strong><span class="v2-member-badge" data-badge="admin">管理员<\/span>/)
    expect(html).toMatch(/data-option="all">.*<strong>所有人<\/strong><small>叫起群里所有成员<\/small><\/span><\/li><\/ul>$/)
    const prevented = vi.fn()
    const option = elements(menu).filter(el => el.type === 'li')[3]!
    ;(option.props.onMouseDown as (event: {preventDefault: () => void}) => void)({preventDefault:prevented})
    expect(prevented).toHaveBeenCalled()
    expect(picked.map(row => row.label)).toEqual(['谋士'])
  })
})

describe('群聊对话', () => {
  const render = (props: Partial<Parameters<typeof Transcript>[0]> = {}, items: OwnerAction[] = []) => renderToStaticMarkup(<api.V2Client.Provider value={{scope:'brain', revoke:vi.fn()}}>
    <OwnerActions.Provider value={{items, refresh:async () => {}}}>
    <Transcript base="/v2/workspaces/w" session={session} view={view}
      compact={false} back={vi.fn()} openDelegation={vi.fn()} changed={async () => {}} target={vi.fn()} newOrder={vi.fn()} {...props}/>
    </OwnerActions.Provider></api.V2Client.Provider>)

  it('anchors a question outside the order and offers only the answers for the current conversation', () => {
    const question = '哪位同事有最终签字权？'
    const source = {...lines[2]!, text:question, mentions:undefined, workOrderId:undefined}
    const item = {id:'question', workspaceId:'w', sessionId:'g', messageId:source.id, question, at,
      workspaceName:view.workspace.name, sessionTitle:session.title}
    mockReads({[sessionPath]: {...sessionView, messages:[source]}})
    const html = render({sourceMessage:source.id}, [item,
      {...item, id:'other-session', sessionId:'elsewhere', question:'另一个会话'},
      {...item, id:'other-order', orderId:order.id, question:'另一张工单'},
      {...item, id:'other-workspace', workspaceId:'elsewhere', question:'另一个工作区'}])
    expect(html).toMatch(/data-message-id="g-3"[^>]*class="v2-source-turn".*待你回应.*答复<\/button>/)
    expect(html.match(/待你回应/g)).toHaveLength(1)
    expect(html).not.toMatch(/另一[个张]|当前不可读/)
    expect(render({sourceMessage:source.id, origin:order.id})).toContain('这条工单原话当前不可读')
    expect(render({session:{...session, closed:true}}, [item])).not.toContain('待你回应')
  })

  it('keeps questions and choices anchored outside the loaded pages at the end, and only inline once their message is loaded', () => {
    const question = '哪位同事有最终签字权？'
    const source = {...lines[2]!, text:question, mentions:undefined, workOrderId:undefined}
    const item = {id:'question', workspaceId:'w', sessionId:'g', messageId:source.id, question, at, workspaceName:view.workspace.name, sessionTitle:session.title}
    const note = {id:'g-9', seq:9, kind:'message' as const, role:'agent' as const, author:'接口人', speakerId:id('a'), at, workOrderId:'d', text:'这句话是要收单吗？',
      actions:[{kind:'complete' as const, label:'确认收单'}, {kind:'forward' as const, label:'继续交给执行者', messageId:'g-8'}]}
    // Only the newest page is loaded: the question's line and the liaison's note are further up.
    pagedReadsFromV2Read({hasOlder:true})
    mockReads({[sessionPath]: {...sessionView, messages:[lines[3]!], pinned:[note]}})
    const partial = render({}, [item])
    const block = partial.slice(partial.indexOf('等你处理'))
    expect(partial).toMatch(/<\/ol><section class="v2-pending-elsewhere"/)
    expect(block).toMatch(/data-pending-for="g-9".*这句话是要收单吗？.*定位到原话.*确认收单.*继续交给执行者/s)
    expect(block).toMatch(/data-pending-for="g-3".*定位到原话.*待你回应.*哪位同事有最终签字权？.*答复<\/button>/s)
    expect(partial.match(/待你回应/g)).toHaveLength(1)
    // Everything loaded and nothing more to load: inline only, no block.
    pagedReadsFromV2Read({hasOlder:true})
    mockReads({[sessionPath]: {...sessionView, messages:[source, note, lines[3]!]}})
    const loaded = render({}, [item])
    expect(loaded).not.toContain('<section class="v2-pending-elsewhere"')
    expect(loaded.match(/待你回应/g)).toHaveLength(1)
    expect(loaded.match(/确认收单/g)).toHaveLength(1)
    expect(loaded).toMatch(/data-message-id="g-3".*待你回应.*data-message-id="g-9".*确认收单/s)
    // A stale pinned copy of a loaded message is not shown twice; a whole conversation has no block at all.
    mockReads({[sessionPath]: {...sessionView, messages:[source, note, lines[3]!], pinned:[note]}})
    expect(render({}, [item]).match(/确认收单/g)).toHaveLength(1)
    pagedReadsFromV2Read()
    mockReads({[sessionPath]: {...sessionView, messages:[lines[3]!], pinned:[note]}})
    expect(render({}, [item])).not.toContain('<section class="v2-pending-elsewhere"')
  })

  it('reopens input files with the owning message’s order even when reading a different order in the same group', () => {
    const file = {id:'ref', name:'sample.html', kind:'file' as const, bytes:18}
    const line = {...lines[2]!, text:'', inputAttachments:[file], workOrderId:'original', attachments:[{id:'output', label:'成果'}],
      deliveries:[{memberId:'researcher', outcome:'failed' as const, detail:'sample.html 未送达'}]}
    mockReads({[sessionPath]: {...sessionView, messages:[line]}})
    const html = render({embedded:true, origin:order.id})
    expect(html).toContain('href="/chief/api/input-attachments/ref?scope=brain&amp;sessionId=g&amp;workspaceId=w&amp;workOrderId=original" download="sample.html"')
    expect(html).toContain('aria-label="添加文件或图片"')
    expect(html).toContain('成果</button>')
    expect(html).toContain('未送达研究员 · sample.html 未送达')
    const invalid = {...sessionView, messages:[{...line, inputAttachments:[{...file, bytes:-1}]}]}
    expect(isSessionView(invalid, sessionPath)).toBe(false)
  })

  it('renders mention chips with avatars, muted progress and event lines, order tags and the member list', () => {
    mockReads({[sessionPath]: sessionView})
    const html = render()
    // Header: the owner and every member, the admin marked.
    expect(html).toContain('群聊 · 你和 4 位成员')
    expect(html).toMatch(/<ul class="v2-group-roster" aria-label="群成员"><li>.*<span>你<\/span><\/li><li data-member="liaison">.*<span>接口人<\/span><span class="v2-member-badge" data-badge="admin">管理员<\/span>/)
    // The owner's @ is a chip with the member's avatar; the one in inline code stays text.
    expect(html).toMatch(/<span class="v2-mention" data-member="engineer"><svg class="v2-chat-avatar v2-avatar-mini"[^>]*data-shape="wrench"[^>]*>.*?<\/svg>@工程师<\/span>/)
    expect(html).toContain('<code>@研究员</code>')
    expect(html.match(/class="v2-mention"/g)).toHaveLength(3)
    // Markdown structure survives: the chips sit inside the liaison's list items, and 「所有人」 is its own chip.
    expect(html).toMatch(/<li>已交给 <span class="v2-mention" data-member="engineer">/)
    expect(html).toMatch(/<span class="v2-mention" data-all="">.*@所有人<\/span>/)
    // Progress: muted bubble with 「进行中」; event: a faint centered line without an avatar.
    expect(html).toMatch(/data-kind="progress"[^>]*>.*?<div class="v2-turn  progress">.*?<span class="v2-member-badge" data-badge="codex">Codex<\/span><span class="v2-progress-tag">进行中<\/span>/)
    expect(html).toMatch(/<li [^>]*data-event="paused" class="v2-group-event"[^>]*><p><time[^>]*>[^<]*<\/time><span>已暂停自动叫人：/)
    // Lines said for an order carry its tag (the conversation board shows a single order's lines too).
    expect(html.match(/class="v2-link v2-order-tag"/g)).toHaveLength(2)
    expect(html).toContain('placeholder="在群里说点什么，输入 @ 叫人…"')
    expect(html).toContain('aria-autocomplete="list"')
    // The status capsule replaces the single-executor 「working」 line.
    expect(html).not.toContain('对方正在工作')
    // Under the owner's line: where the words went.
    expect(html).toMatch(/<small class="v2-delivery-note v2-group-delivery" data-delivery="group"><span data-member="engineer" data-outcome="steered">已送进工程师这一轮<\/span><\/small>/)
    // The group's commands outside any order, without repeating the approval cards above the composer.
    expect(html).toContain('<section class="v2-execution-block" aria-label="群里不属于工单的执行记录">')
    expect(html.match(/class="v2-approval"/g)).toHaveLength(1)
    expect(WORKSPACE_V2_STYLE).toMatch(/\.v2-turn\.progress \.v2-bubble \{[^}]*color:var\(--v-muted\)/)
    expect(WORKSPACE_V2_STYLE).toMatch(/\.v2-group-event p \{[^}]*color:var\(--v-muted\)/)
    expect(WORKSPACE_V2_STYLE).toMatch(/@container\(max-width:740px\) \{[^@]*\.v2-group-roster \{ flex-wrap:nowrap; overflow-x:auto;/)
  })

  it('leaves an older group and a coding session as they were', () => {
    const older = {...session, engine:undefined}
    mockReads({[sessionPath]: {scope:'brain', session:older, messages:[{id:'m', role:'agent', author:'讨论接口人', at, text:'@工程师 你好'}]}})
    const html = render({session:older})
    expect(html).toContain('群聊 · 讨论接口人')
    expect(html).not.toMatch(/class="v2-mention"|v2-group-roster|v2-group-state/)
  })

  it('opens an order page without repeating the order tag on each line', () => {
    mockReads({[sessionPath]: sessionView})
    expect(render({embedded:true, origin:'d'})).not.toContain('v2-order-tag')
  })

  it('shows the order’s waiting reason in the conversation before the user opens order details', () => {
    const waiting = {...order, status:'waiting' as const, reason:'等待合规团队回执，接口人将在 15:00 复核。'}
    mockReads({[sessionPath]: sessionView})
    const updated = {...view, orders:[waiting]}
    expect(render({view:updated})).toContain('<p class="v2-order-wait-reason" role="status">' + waiting.reason + '</p>')
    expect(render({view:updated, embedded:true, origin:order.id})).toContain('<p class="v2-order-wait-reason" role="status">' + waiting.reason + '</p>')
  })
})

describe('状态胶囊、停止与审批', () => {
  function stopWriter() {
    const posts: [string, Record<string, unknown>][] = []
    return { posts, writer: { busy:false, error:'', post: async (resource: string, body: Record<string, unknown>) => { posts.push([resource, body]); return {scope:'brain'} } } }
  }
  const now = Date.parse('2026-11-24T08:06:00Z')

  it('lists busy members waiting for approval first, then working, then queued, and stops one or all', async () => {
    expect(busyMembers(members).map(row => row.id)).toEqual(['researcher', 'engineer', 'strategist'])
    const {posts, writer} = stopWriter()
    let refreshed = 0
    const status = <GroupStatus path={sessionPath} group={{...group, paused:undefined, approvals:[]}} portraits={portraits} now={now} stop={writer} refresh={async () => { refreshed++ }}/>
    const html = renderToStaticMarkup(status)
    expect(html).toContain('aria-label="正在忙的成员：研究员等你批准，工程师在干活，谋士排队中"')
    expect(html).toMatch(/data-status="approval">.*研究员.*data-status="working">.*工程师.*data-status="queued">.*谋士/)
    // What the engineer is doing: for how long, who called it, its latest command and its latest progress words (from the host).
    expect(html).toContain('<small>已 5 分钟 · 接口人 @ 了你</small><small class="v2-busy-tool" data-tool="shell">正在用 shell：<code>arkcli endpoint list --region cn-beijing</code></small><small class="v2-busy-progress">正在运行 arkcli endpoint list</small>')
    expect(html).toContain('还有 1 件排队')
    const actions = buttons(status)
    expect(actions.map(button => [text(button.props.children as ReactNode), button.props['aria-label']])).toEqual([
      ['停止', '停止研究员'], ['停止', '停止工程师'], ['停止', '停止谋士'], ['全部停止', undefined]])
    await (actions[1]!.props.onClick as () => Promise<void>)()
    await (actions[3]!.props.onClick as () => Promise<void>)()
    await vi.waitFor(() => expect(refreshed).toBe(2))
    expect(posts).toEqual([[sessionPath + '/stop', {memberId:'engineer'}], [sessionPath + '/stop', {}]])
    expect(renderToStaticMarkup(<GroupStatus path={sessionPath} group={{members:[liaison], approvals:[]}} now={now} stop={writer} refresh={async () => {}}/>))
      .toBe('<div class="v2-group-state"></div>')
  })

  it('shows the idle guard\'s reason from the view while paused', () => {
    const {writer} = stopWriter()
    const html = renderToStaticMarkup(<GroupStatus path={sessionPath} group={{...group, approvals:[]}} now={now} stop={writer} refresh={async () => {}}/>)
    expect(html).toMatch(/<div class="v2-group-paused" role="status"><strong>自动叫人已暂停<\/strong><span>已暂停自动叫人：研究员 与成员之间连续 6 次[^<]*主人发言后继续。<\/span><small>挂起的叫人 1 次 · 你发言后恢复<\/small><\/div>/)
    expect(renderToStaticMarkup(<GroupStatus path={sessionPath} group={{...group, approvals:[], paused:{...pause, reason:'暂停的原因', parked:0}}} now={now} stop={writer} refresh={async () => {}}/>))
      .toContain('<span>暂停的原因</span><small>你发言后恢复</small></div>')
  })

  it('says under the owner\'s line where the words went for each member', () => {
    const html = renderToStaticMarkup(<GroupDeliveries members={members} deliveries={[{memberId:'liaison', outcome:'started'}, {memberId:'engineer', outcome:'steered'},
      {memberId:'researcher', outcome:'pending'}, {memberId:'strategist', outcome:'queued'}]}/>)
    expect(html).toContain('>接口人开始回答</span>')
    expect(html).toContain('> · 已送进工程师这一轮</span>')
    expect(html).toContain('> · 正在送进研究员这一轮</span>')
    expect(html).toContain('<span data-member="strategist" data-outcome="queued"> · 已排队，谋士忙完手上的就看</span>')
    expect(renderToStaticMarkup(<GroupDeliveries members={members}/>)).toBe('')
    const failed = renderToStaticMarkup(<GroupDeliveries members={members} deliveries={[
      {memberId:'researcher', outcome:'failed', detail:'sample.png · 当前模型只支持文字'}, {memberId:'engineer', outcome:'started'},
    ]}/>)
    expect(failed).toContain('未送达研究员 · sample.png · 当前模型只支持文字')
    expect(failed).toContain('工程师开始回答')
  })

  it('shows a DSH member\'s pending command by the member\'s name and answers it on the group', async () => {
    const posts: [string, Record<string, unknown>][] = []
    vi.spyOn(api, 'useV2Write').mockImplementation(() => ({busy:false, error:'', post:async (resource: string, body: Record<string, unknown>) => {
      posts.push([resource, body])
      return {scope:'brain'} as never
    }}) as never)
    const {writer} = stopWriter()
    let refreshed = 0
    const status = <GroupStatus path={sessionPath} group={{...group, paused:undefined}} now={now} stop={writer} refresh={async () => { refreshed++ }}/>
    const html = renderToStaticMarkup(status)
    expect(html).toContain('aria-label="等你决定：研究员 申请运行命令"')
    expect(html).toContain('<span>研究员 申请运行</span>')
    expect(html).toContain('rm -rf ./tmp/probe')
    expect(html).toContain('/home/owner/projects/arklab')
    const approve = buttons(status).find(button => text(button.props.children as ReactNode) === '批准')!
    await (approve.props.onClick as () => Promise<void>)()
    await vi.waitFor(() => expect(refreshed).toBe(1))
    expect(posts).toEqual([[sessionPath + '/approvals/a-1', {allow:true}]])
    // The engineer's card names its tool too.
    const codex = renderToStaticMarkup(<GroupStatus path={sessionPath} group={{...group, paused:undefined, approvals:[{...approval, tool:'codex', memberId:'engineer'}]}}
      now={now} stop={writer} refresh={async () => {}}/>)
    expect(codex).toContain('<span>工程师（Codex） 申请运行</span>')
  })

  it('names the member in 「等你决定」 on Today', () => {
    mockReads({'/v2/approvals': {scope:'brain', approvals:[{...approval, workspaceName:'方舟评测', sessionTitle:'方舟端点', orderTitle:'核对开通的端点', memberName:'研究员'}]}})
    const html = renderToStaticMarkup(<PendingCommandApprovals today goToday={vi.fn()} open={vi.fn()}/>)
    expect(html).toContain('方舟评测 · 研究员 · 删除文件：rm')
  })
})

describe('群聊里的工单页', () => {
  it('offers the command tier and the command record of a group order, with the approval cards only above the composer', () => {
    const execution = {scope:'brain', workspaceId:'w', delegationId:'d', commands:[], runs:[], pending:[approval], directory:{source:'workspace', path:'/home/owner/projects/arklab'}}
    mockReads({[sessionPath]: sessionView, '/v2/workspaces/w/orders/d/execution': execution,
      '/v2/approvals': {scope:'brain', approvals:[{...approval, workspaceName:'方舟评测', sessionTitle:'方舟端点'}]}})
    const html = renderToStaticMarkup(<WorkOrderPage job={order} view={{...view, directories:{d:{source:'workspace', path:'/home/owner/projects/arklab'}}}} base="/v2/workspaces/w"
      back={vi.fn()} open={vi.fn()} openOrder={vi.fn()} target={vi.fn()} newOrder={vi.fn()} popup={vi.fn()} changed={async () => {}} initialWide/>)
    expect(html).toContain('aria-label="命令档位"')
    expect(html).toContain('<dt>运行目录</dt>')
    expect(html).toContain('执行记录')
    expect(html.match(/class="v2-approval"/g)).toHaveLength(1)
    expect(html).toContain('<div class="v2-approvals v2-group-approvals"')
  })
})

describe('新建会话', () => {
  it('asks only for a title and opens a group', async () => {
    const posts: [string, Record<string, unknown>][] = []
    vi.spyOn(api, 'useV2Write').mockImplementation(() => ({busy:false, error:'', post:async (resource: string, body: Record<string, unknown>) => {
      posts.push([resource, body])
      return {scope:'brain', session} as never
    }}) as never)
    const html = renderToStaticMarkup(<CreateSession base="/v2/workspaces/w" view={view} close={vi.fn()} done={async () => {}}/>)
    expect(html).toContain('会话名称')
    expect(html).not.toMatch(/会话类型|编程工具|Claude Code/)
    expect(html).toContain('你、接口人和本工作区的幕僚都在里面')
  })
})

describe('群里不属于工单的执行记录', () => {
  it('lists commands per member in roster order, keeps a departed member under its old name, and the rest apart', () => {
    const command = (id: string, memberId?: string, memberName?: string) => ({kind:'command', row:{id, turnId:'c1.1', workOrderId:null, at, tool:'bash', command:'ls', cwd:'/tmp',
      ...memberId && {memberId}, ...memberName && {memberName}}})
    const tierChange = {kind:'tier', row:{at, from:'full-access', to:'ask'}}
    const split = byMember([command('1', 'researcher', '研究员'), command('2', 'engineer', '工程师'), command('3', 'gone', '旧幕僚'), command('4'), tierChange, command('5', 'engineer', '工程师')], members)
    expect(split.members.map(row => [row.id, row.label, row.kind, row.own.map(entry => (entry.row as {id: string}).id)])).toEqual([
      ['engineer', '工程师', 'codex', ['2', '5']], ['researcher', '研究员', 'dsh', ['1']], ['gone', '旧幕僚', undefined, ['3']]])
    expect(split.others).toEqual([command('4'), tierChange])
  })
})
