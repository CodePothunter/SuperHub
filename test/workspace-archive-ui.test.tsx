import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StaffView } from '../src/core/workspace-staff.ts'
import type { V2Delegation, V2Message, V2Session, V2Workspace, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import type { Scoped } from '../src/client/superhub-api.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import { ArchivedBanner, ArchiveWorkspace, Overview, TodaySpaces, WorkOrderPage, WorkspaceSwitcher } from '../src/client/workspace-v2.tsx'
import { ARCHIVED_NOTE, ArchivedWorkspace } from '../src/client/workspace-v2-elements.tsx'
import { ProjectDirectory } from '../src/client/workspace-directory.tsx'
import { OrderFollowup } from '../src/client/workspace-followup.tsx'
import type { FollowupView } from '../src/core/workspace-followup.ts'
import { ConversationBoard, MessageChoices } from '../src/client/workspace-v2-talk.tsx'
import { StaffBoard } from '../src/client/workspace-staff.tsx'
import { hasMutationObject, isWorkspaceIndex, isWorkspaceView } from '../src/client/workspace-v2-response.ts'
import { WORKSPACE_V2_STYLE } from '../src/client/workspace-v2-style.ts'

const at = '2026-11-23T08:00:00Z'
const archivedAt = '2026-11-24T02:30:00Z'
const space: V2Workspace = {id:'w', name:'字节 Landing', goal:'上线落地页', owner:'我', createdAt:at, projectDirectory:'/home/me/landing'}
const shelved: V2Workspace = {...space, archivedAt}
const other: V2Workspace = {id:'o', name:'客户访谈', goal:'', owner:'我', createdAt:at}
const old: V2Workspace = {id:'x', name:'旧项目', goal:'', owner:'我', createdAt:at, archivedAt}
const session: V2Session = {id:'s', workspaceId:'w', title:'落地页群聊', kind:'coding', executor:'codex', delegationIds:['d'], closed:false, createdAt:at}
const order: V2Delegation = {id:'d', workspaceId:'w', sessionId:'s', title:'首页改版', promise:'改好首页', owner:'接口人', status:'accepted',
  boundary:'只改首页', remainingTurns:3, generation:1, createdAt:at}
const view = (workspace: V2Workspace): V2WorkspaceView => ({scope:'brain', workspace, orders:[order], delegations:[order], sessions:[session], decisions:[]})
const sessionPath = '/v2/workspaces/w/sessions/s'

function mockReads(responses: Record<string, object>) {
  vi.spyOn(api, 'useV2Read').mockImplementation((resource, valid) => {
    const value = resource ? responses[resource.split('?')[0]!] as Scoped | undefined : undefined
    return {data: resource && value && valid(value, resource) ? value : undefined, error: undefined, refresh: async () => {}}
  })
}
/** What the workspace page passes down: one `archived` for the whole page. */
const inside = (archived: boolean, node: ReactNode) => renderToStaticMarkup(<ArchivedWorkspace.Provider value={archived}>{node}</ArchivedWorkspace.Provider>)
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(match => match[1]!.replace(/<[^>]+>/g, ''))
afterEach(() => vi.restoreAllMocks())

describe('已归档工作区页', () => {
  it('shows since when it is archived and offers 「恢复」', () => {
    const html = renderToStaticMarkup(<ArchivedBanner workspace={shelved} restored={async () => {}}/>)
    expect(html).toMatch(/^<section class="v2-archived-banner" aria-label="工作区已归档">/)
    expect(html).toMatch(/<strong>已归档 · 2026年[^<]+<\/strong>/)
    expect(buttons(html)).toEqual(['恢复'])
  })

  it('hides the overview\'s new session, new order, directory changes and 「归档工作区」', () => {
    const live = inside(false, <><ProjectDirectory workspace={space} changed={async () => {}}/>
      <Overview view={view(space)} openJob={vi.fn()} openSession={vi.fn()} delegate={vi.fn()} create={vi.fn()}/>
      <ArchiveWorkspace workspace={space} done={async () => {}}/></>)
    for (const label of ['修改', '解除', '新建会话', '新建工单', '归档工作区']) expect(buttons(live)).toContain(label)
    const html = inside(true, <><ProjectDirectory workspace={shelved} changed={async () => {}}/>
      <Overview view={view(shelved)} openJob={vi.fn()} openSession={vi.fn()} delegate={vi.fn()} create={vi.fn()}/>
      <ArchiveWorkspace workspace={shelved} done={async () => {}}/></>)
    // Still readable: the directory, the session and its order.
    for (const text of ['/home/me/landing', '落地页群聊', '首页改版']) expect(html).toContain(text)
    for (const label of ['修改', '绑定目录', '解除', '新建会话', '新建工单', '归档工作区']) expect(buttons(html)).not.toContain(label)
  })

  it('keeps the order page readable with no order actions, tier change, composer, close or new order', () => {
    const render = (archived: boolean) => {
      mockReads({[sessionPath]: {scope:'brain', session, messages:[{id:'m', role:'agent', author:'Codex', at, text:'首页已改好'}]}})
      return inside(archived, <WorkOrderPage job={order} view={view(archived ? shelved : space)} base="/v2/workspaces/w" back={vi.fn()} open={vi.fn()}
        openOrder={vi.fn()} target={vi.fn()} newOrder={vi.fn()} popup={vi.fn()} changed={async () => {}} initialWide/>)
    }
    const live = render(false)
    for (const label of ['标为完成', '暂停工单', '收窄范围', '取消工单', '关闭会话', '新建工单']) expect(buttons(live)).toContain(label)
    const send = /<button\b[^>]*aria-label="发送"/
    expect(live).toMatch(send)
    expect(live).toContain('<textarea')
    const html = render(true)
    expect(html).toContain('首页已改好')
    expect(html).toContain(ARCHIVED_NOTE)
    for (const label of ['标为完成', '暂停工单', '恢复工单', '收窄范围', '取消工单', '重新打开', '绑定项目目录', '关闭会话', '恢复会话', '新建工单'])
      expect(buttons(html)).not.toContain(label)
    expect(html).not.toMatch(send)
    expect(html).not.toContain('<textarea')
    // The tier it had stays visible; none of the three can be chosen.
    expect(html.match(/<button type="button" class="v2-tier-option"[^>]*disabled=""/g)).toHaveLength(3)
  })

  it('offers no new session in the conversation list', () => {
    mockReads({[sessionPath]: {scope:'brain', session, messages:[]}})
    const board = (archived: boolean) => inside(archived, <ConversationBoard base="/v2/workspaces/w" view={view(archived ? shelved : space)} selected="s"
      open={vi.fn()} back={vi.fn()} openDelegation={vi.fn()} create={vi.fn()} changed={async () => {}} target={vi.fn()} newOrder={vi.fn()} visible={vi.fn()}/>)
    expect(buttons(board(false))).toContain('新建会话')
    const html = board(true)
    expect(buttons(html)).not.toContain('新建会话')
    expect(html).not.toContain('<textarea')
  })

  it('leaves the liaison\'s choices disabled and says why', () => {
    const message: V2Message = {id:'c', role:'agent', author:'接口人', at, text:'可以收单了吗？', actions:[{kind:'complete', label:'确认收单'}]}
    const html = inside(true, <MessageChoices message={message} order={order} base="/v2/workspaces/w" path={sessionPath} done={async () => {}}/>)
    expect(html).toMatch(/<button type="button" class="v2-button primary" disabled="">确认收单<\/button>/)
    expect(html).toContain('工作区已归档')
  })

  it('keeps commitments and reports readable without recording, resolving, scheduling or drafting', () => {
    const source = {kind:'session' as const, sessionId:'s', messageId:'m', author:'主人', at}
    const followup: FollowupView = {scope:'brain', workspaceId:'w', orderId:'d', timeZone:'Asia/Shanghai', currentWeek:'2026-11-16',
      commitments:[{id:'q', kind:'request', quote:'请看看预算', resolved:false, dueState:'unscheduled', source}],
      schedule:{enabled:true, weekday:5, time:'16:00'}, reports:[]}
    mockReads({'/v2/workspaces/w/orders/d/followup': followup})
    const render = (archived: boolean) => buttons(inside(archived, <OrderFollowup base="/v2/workspaces/w" job={order} session={session} openSource={vi.fn()}/>))
    expect(render(false)).toEqual(expect.arrayContaining(['从会话记录', '标记已处理', '设置周期', '生成本周周报']))
    const html = render(true)
    expect(html).toContain('定位原话')
    for (const label of ['从会话记录', '标记已处理', '设置周期', '停用周期', '生成本周周报']) expect(html).not.toContain(label)
  })

  it('reads the staff panel only: no invite, create, duty, experience, portrait, reset or new order', () => {
    const member = {id:'analyst', name:'研究员', brief:'研究使用体验', homeWorkspaceId:'w', memberships:[{workspaceId:'w', duty:'整理访谈'}]}
    const staff: StaffView = {scope:'brain', workspaceId:'w', members:[member], available:[{id:'g', name:'书记官'}],
      received:[], shares:[], memories:[{id:'m', staffId:member.id, workspaceId:'w', text:'确认下一步', status:'proposed', version:1, at}]}
    vi.spyOn(api, 'useV2Read').mockImplementation((path, valid) => ({data: path && valid(staff, path) ? staff : undefined, refresh: async () => {}, error: undefined}))
    const panel = (archived: boolean, selected?: string) => inside(archived, <StaffBoard workspace={view(archived ? shelved : space)} spaces={[archived ? shelved : space]}
      selected={selected} select={vi.fn()} openOrder={vi.fn()} openMembership={vi.fn()} assign={vi.fn()}/>)
    expect(buttons(panel(false))).toEqual(expect.arrayContaining(['邀请幕僚', '创建专属幕僚']))
    const card = (archived: boolean) => buttons(panel(archived, member.id))
    for (const label of ['交给这位幕僚', '更换头像', '编辑职责', '调整本区职责', '添加经验', '采纳', '更正', '停用', '重置本区记忆']) expect(card(false)).toContain(label)
    const list = panel(true)
    expect(list).toContain('研究员')
    expect(list).toContain(ARCHIVED_NOTE)
    for (const label of ['邀请幕僚', '创建专属幕僚']) expect(buttons(list)).not.toContain(label)
    const html = panel(true, member.id)
    expect(html).toContain('确认下一步')
    for (const label of ['交给这位幕僚', '更换头像', '编辑职责', '调整本区职责', '移出本区', '添加经验', '采纳', '共享经验', '更正', '停用', '重置本区记忆', '到来源工作区管理'])
      expect(buttons(html)).not.toContain(label)
  })

  it('does not offer joining an archived workspace from a global role card', () => {
    const member = {id:'analyst', name:'研究员', brief:'研究使用体验', memberships:[{workspaceId:'o', duty:''}]}
    const staff: StaffView = {scope:'brain', members:[member], available:[], memories:[], received:[], shares:[]}
    vi.spyOn(api, 'useV2Read').mockImplementation((path, valid) => ({data: path && valid(staff, path) ? staff : undefined, refresh: async () => {}, error: undefined}))
    const card = (spaces: V2Workspace[]) => buttons(renderToStaticMarkup(<StaffBoard spaces={spaces} selected={member.id} select={vi.fn()} openOrder={vi.fn()} openMembership={vi.fn()}/>))
    expect(card([other, space])).toContain('加入工作区')
    expect(card([other, shelved])).not.toContain('加入工作区')
  })
})

describe('归档入口与工作区列表', () => {
  it('offers 「归档工作区」 with its confirmation, but not for 「我的交办」', () => {
    expect(renderToStaticMarkup(<ArchiveWorkspace workspace={space} personalId="mine" done={async () => {}}/>)).toContain('>归档工作区</button>')
    expect(renderToStaticMarkup(<ArchiveWorkspace workspace={space} personalId="w" done={async () => {}}/>)).toBe('')
  })

  it('lists only active workspaces on 「今天」, and points to the archived ones when nothing else is left', () => {
    const html = renderToStaticMarkup(<TodaySpaces spaces={[space, old, other]} open={vi.fn()} showArchived={vi.fn()}/>)
    expect(html).toContain('data-workspace-id="w"')
    expect(html).toContain('data-workspace-id="o"')
    expect(html).not.toContain('data-workspace-id="x"')
    const none = renderToStaticMarkup(<TodaySpaces spaces={[old, shelved]} open={vi.fn()} showArchived={vi.fn()}/>)
    expect(none).not.toContain('data-workspace-id')
    expect(none).toContain('没有进行中的工作区。')
    expect(buttons(none)).toEqual(['查看已归档（2）'])
    expect(renderToStaticMarkup(<TodaySpaces spaces={[]} open={vi.fn()} showArchived={vi.fn()}/>)).toContain('还没有工作区。')
  })

  it('groups archived workspaces under a folded 「已归档（N）」 after the active ones in 「切换工作区」', () => {
    const html = renderToStaticMarkup(<WorkspaceSwitcher spaces={[old, space, other]} open={vi.fn()} create={vi.fn()}/>)
    const fold = html.indexOf('<details class="v2-archived-spaces">')
    expect(fold).toBeGreaterThan(html.indexOf('data-workspace-id="o"'))
    expect(fold).toBeGreaterThan(html.indexOf('data-workspace-id="w"'))
    expect(html.indexOf('data-workspace-id="x"')).toBeGreaterThan(fold)
    expect(html).toContain('<summary>已归档（1）</summary>')
    expect(html).toMatch(/data-workspace-id="x"[^]*已归档 · 2026年/)
    expect(buttons(html).at(-1)).toBe('创建工作区')
    // Opened on its own while the archived workspace is the one on screen.
    expect(renderToStaticMarkup(<WorkspaceSwitcher spaces={[old, space]} current="x" open={vi.fn()} create={vi.fn()}/>)).toContain('<details class="v2-archived-spaces" open="">')
    expect(renderToStaticMarkup(<WorkspaceSwitcher spaces={[space]} open={vi.fn()} create={vi.fn()}/>)).not.toContain('已归档')
  })

  it('accepts the archive fields in responses and the archive and restore receipts', () => {
    const scoped = (value: object) => value as unknown as Scoped
    expect(isWorkspaceIndex(scoped({scope:'brain', workspaces:[space, old], personalWorkspaceId:'w'}))).toBe(true)
    expect(isWorkspaceIndex(scoped({scope:'brain', workspaces:[space]}))).toBe(true)
    expect(isWorkspaceIndex(scoped({scope:'brain', workspaces:[space], personalWorkspaceId:1}))).toBe(false)
    expect(isWorkspaceIndex(scoped({scope:'brain', workspaces:[{...space, archivedAt:1}]}))).toBe(false)
    expect(isWorkspaceView(scoped({...view(shelved), personalWorkspaceId:'o'}), '/v2/workspaces/w')).toBe(true)
    expect(isWorkspaceView(scoped({...view(space), personalWorkspaceId:false}), '/v2/workspaces/w')).toBe(false)
    expect(hasMutationObject(scoped({scope:'brain', workspace:shelved}), '/v2/workspaces/w/archive')).toBe(true)
    expect(hasMutationObject(scoped({scope:'brain', workspace:space}), '/v2/workspaces/w/restore')).toBe(true)
    expect(hasMutationObject(scoped({scope:'brain', workspace:other}), '/v2/workspaces/w/archive')).toBe(false)
  })

  it('styles the banner with the theme\'s amber and gives phone-sized touch targets', () => {
    expect(WORKSPACE_V2_STYLE).toMatch(/\.wv2 \.v2-archived-banner \{[^}]*border-inline-start:3px solid var\(--v-amber\)[^}]*background:var\(--v-tint\)/)
    expect(WORKSPACE_V2_STYLE).toMatch(/\.wv2 \.v2-archived-spaces>summary \{[^}]*min-height:44px/)
    const phone = WORKSPACE_V2_STYLE.slice(WORKSPACE_V2_STYLE.indexOf('@media(max-width:700px)'))
    expect(phone).toMatch(/\.wv2 \.v2-archived-banner>\.v2-button \{[^}]*min-height:44px/)
    expect(phone).toMatch(/\.wv2 \.v2-archive-workspace>\.v2-link \{[^}]*min-height:44px/)
  })
})
