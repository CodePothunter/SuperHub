import { RoomWorkspace } from './rooms.tsx'
import { setRoster } from './staff-names.ts'
import { APPROVALS_CHANGED, CommandApprovals, CommandDecisionRow } from './approvals.tsx'
import { requestId } from './request-id.ts'
import { WorkspaceFrame } from './surface.tsx'
import { DECISIONS_NAME, NO_DECISIONS, WORKSPACE_NAME } from './workspace-brand.tsx'
/**
 * 作战台：左边和接口人对话，右边是台面。
 *
 * 主人只需要说话：互动、承诺、会议、横向线都由接口人记进花名册，台面随之更新。
 * 台面上只保留"看"和少量必须由主人亲手做的动作（回答、批准、验收、标记完成、修改判断）。
 * 窄屏时用底部标签在接口人和台面各区块之间切换。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { TAB_NAMES, type TabId } from '../core/custom.ts'
import { api, isSetup, useAction, useChat, useWarroom, type CommitmentRow, type MeetingRow, type PocState, type ReadyState, type TicketCard, type WarroomState } from './api.ts'
import { Chat } from './chat.tsx'
import { densityClass, isHidden, PanelView, sectionOrder, tabOrder, themeStyle } from './custom.tsx'
import { LineDrawer, PersonDrawer, Shell, TicketDrawer } from './drawers.tsx'
import { SituationMap } from './map.tsx'
import { groupPeople } from './people.ts'
import { Reader } from './reader.tsx'
import { ExportDrawer } from './export.tsx'
import { SettingsDrawer } from './settings.tsx'
import { Setup } from './setup.tsx'
import { EventsView, StaffDrawer, StaffView } from './staff.tsx'
import { CSS } from './style.ts'
import { SuperHub, hubHash, hubPlace, type HubPlace } from './superhub.tsx'
import { STAGE_LABEL } from './ticket-labels.ts'

type Run = ReturnType<typeof useAction>['run']
type Open = { kind: 'ticket' | 'threads' | 'person' | 'line' | 'staff' | 'reader' | 'settings' | 'export'; id: string; threadId?: string; path?: string; version?: string }
  | { kind: 'superhub'; id: string; place: HubPlace }
type Tab = TabId
type RoomSelection = { room: string; scope?: string }

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const OVERVIEW_ROOM_STATE = 'dshChiefOverviewRoom'

function overviewRoom(): RoomSelection | undefined {
  const saved = history.state?.[OVERVIEW_ROOM_STATE]
  if (typeof saved?.scope === 'string' && typeof saved.room === 'string' && saved.room) return saved
}

function replaceHash(hash: string, origin?: { scope: string; room: string }) {
  const state: Record<string, unknown> | null = history.state
  let next = state
  if (origin || (state && Object.hasOwn(state, OVERVIEW_ROOM_STATE))) {
    next = { ...state }
    if (origin) next[OVERVIEW_ROOM_STATE] = origin
    else delete next[OVERVIEW_ROOM_STATE]
  }
  history.replaceState(next, '', `${location.pathname}${location.search}${hash}`)
}

function linkedSelection(opened: Open | undefined): RoomSelection | undefined {
  const room = new URLSearchParams(location.hash.slice(1)).get('room')
  if (location.hash.startsWith('#room=') && room) return { room }
  const origin = overviewRoom()
  if (opened?.kind === 'superhub' && origin?.scope === opened.id) return origin
}

function linkedOpen(): Open | undefined {
  if (location.hash === '#threads') return { kind: 'threads', id: '' }
  if (location.hash.startsWith('#superhub?')) {
    const params = new URLSearchParams(location.hash.slice('#superhub?'.length))
    const scope = params.get('scope'), place = hubPlace(params)
    if (scope && place && /^[a-f0-9]{32}$/.test(scope)) return { kind: 'superhub', id: scope, place }
  }
  const kind = location.hash.startsWith('#thread?') ? 'ticket' : location.hash.startsWith('#delivery?') ? 'reader' : undefined
  if (!kind) return
  const q = new URLSearchParams(location.hash.slice(location.hash.indexOf('?') + 1)), id = q.get('ticket') ?? ''
  return /^T-\d+$/.test(id) ? { kind, id, threadId: q.get('thread') || undefined, path: q.get('path') || undefined, version: q.get('version') || undefined } : undefined
}

function ThreadInbox({ state, close, openTicket, staffName }: { state: ReadyState | undefined; close: () => void; openTicket: (id: string) => void; staffName: (id: string) => string }) {
  const current = state ? [...state.you, ...state.active, ...state.queued] : []
  const rows = (tickets: TicketCard[]) => <div className="wr-thread-inbox">{tickets.map(t => <button key={t.id} onClick={() => openTicket(t.id)}>
    <span className="meta">{t.id} · {staffName(t.staff)} · {STAGE_LABEL[t.stage] ?? t.stage}</span><b>{t.title}</b><span className="meta">{t.latest?.question ?? t.latest?.summary ?? t.scope}</span>
  </button>)}</div>
  return <Shell title="执行记录" meta="每件工作有自己的记录，打开后可继续推进、查看交付和作出决定。" close={close}>
    <h3>在办（{current.length}）</h3>{rows(current)}
    {!current.length && <p className="wr-empty">现在没有在办工单。</p>}
    {!!state?.ended.length && <><h3>最近结束</h3>{rows(state.ended)}</>}
  </Shell>
}

function headline(s: PocState['situation']): string {
  const parts = [
    s.decide ? `${s.decide} 件事${DECISIONS_NAME}` : '', s.overdue ? `${s.overdue} 个承诺已逾期` : '', s.dueToday ? `${s.dueToday} 个承诺今天到期` : '',
    s.blocked ? `${s.blocked} 条横向线受阻` : '', s.meetingsToday ? `今天还有 ${s.meetingsToday} 场会` : '', s.stale ? `${s.stale} 位干系人该联系了` : '',
  ].filter(Boolean)
  return parts.length ? `${parts.join('，')}。` : '今天没有需要你处理的事。'
}

const dueLabel = (c: { dueState: string; dueIn?: number; due?: string }) =>
  c.dueState === 'overdue' ? `逾期 ${-(c.dueIn ?? 0)} 天` : c.dueState === 'today' ? '今天' : c.dueState === 'none' ? '未定' : c.dueIn === 1 ? '明天' : (c.due ?? '').slice(5).replace('-', '/')

/** 让一个非按钮元素可以用键盘打开。 */
const tap = (fn: () => void) => ({ role: 'button', tabIndex: 0, onClick: fn, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') fn() } })

// ───────────── 等你决定 ─────────────

function Decision({ card, run, busy, open, staffName }: { card: TicketCard; run: Run; busy?: string; open: (o: Open) => void; staffName: (id: string) => string }) {
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string>()
  const act = async (verb: string, body: unknown = {}) => {
    const message = await run(`${card.id}:${verb}`, `/tickets/${card.id}/${verb}`, body)
    setError(message)
    if (!message && verb === 'reply') setReply('')
  }
  const off = busy?.startsWith(`${card.id}:`)
  const latest = card.latest
  const body = card.stage === 'you/approve' ? card.scope : card.stage === 'you/answer' ? latest?.question ?? latest?.summary : latest?.summary
  if (card.scoped) return <div className="wr-row need"><span className="lead">{card.id.slice(2)}</span>
    <div className="main"><b>{card.title}</b><div className="note">{body}</div></div>
    <span className="tail">{STAGE_LABEL[card.stage]}</span><div className="acts"><button onClick={() => open({ kind: 'ticket', id: card.id })}>打开执行指挥塔</button></div></div>
  return (
    <div className={`wr-row ${card.stage === 'you/blocked' ? 'bad' : 'need'}`}>
      <span className="lead">{card.id.slice(2)}</span>
      <div className="main" style={{ cursor: 'pointer' }} {...tap(() => open({ kind: 'ticket', id: card.id }))}>
        <b>{card.title}</b>
        {body && <div className="note">{body}</div>}
      </div>
      <span className="tail"><span className={`wr-tag ${card.stage === 'you/blocked' ? 'bad' : 'need'}`}>{STAGE_LABEL[card.stage]}</span>{staffName(card.staff)}</span>
      <div className="acts">
        <input value={reply} onChange={e => setReply(e.target.value)} aria-label="回复" placeholder={card.stage === 'you/answer' ? '写下你的回答' : card.stage === 'you/review' ? '要改什么就写在这里' : '补充说明'} />
        {reply.trim() && <button disabled={off} onClick={() => act('reply', { text: reply })}>{card.stage === 'you/answer' ? '回答' : card.stage === 'you/review' ? '退回修改' : '回复'}</button>}
        {card.stage === 'you/approve' && <button className="go" disabled={off} onClick={() => card.requestedExecutor ? open({ kind: 'ticket', id: card.id }) : act('approve')}>{card.requestedExecutor ? '查看并批准' : '批准'}</button>}
        {(card.stage === 'you/review' || card.stage === 'you/answer') && card.hasFiles && <button className={card.hasProposal ? '' : 'go'} onClick={() => open({ kind: 'reader', id: card.id })}>看产出并批注</button>}
        {/* 有提案：通过就是要落地，主按钮是"验收并执行"；只结案不落地是少数情况，放次要位置 */}
        {card.stage === 'you/review' && card.hasProposal && !reply.trim() && <button className="go" disabled={off} onClick={() => act('accept', { applyProposal: true })}>验收并执行</button>}
        {card.stage === 'you/review' && !reply.trim() && <button className={card.hasFiles || card.hasProposal ? 'quiet' : 'go'} disabled={off} onClick={() => act('accept')}>{card.hasProposal ? '只验收，不执行' : '验收'}</button>}
        {card.stage === 'you/blocked' && <button disabled={off} onClick={() => act('retry')}>重试</button>}
        <button className="quiet stop" disabled={off} onClick={() => act('stop', { reason: `在 ${WORKSPACE_NAME} 停止` })}>停止</button>
      </div>
      {error && <div className="wr-err" style={{ gridColumn: '2 / -1' }}>{error}</div>}
    </div>
  )
}

// ───────────── 人物（按组） ─────────────

function PersonRowView({ p, open }: { p: PocState['people'][number]; open: (id: string) => void }) {
  const stale = p.daysSince === undefined || p.daysSince > (p.influence === 'high' ? 14 : 30)
  return <div className="wr-row tap" {...tap(() => open(p.id))}>
    <span className="lead"><span className={`wr-dot ${p.warmth ?? 'unknown'}`} /></span>
    <div className="main"><b>{p.name}</b><div className="note">{[p.organization, p.team, p.role, p.stance].filter(Boolean).join('，') || '还没有资料'}</div></div>
    <span className="tail">{p.owe > 0 && <span className="wr-tag">我欠 {p.owe}</span>}{p.owed > 0 && <span className="wr-tag tide">欠我 {p.owed}</span>}
      <span className={stale ? 'wr-due today' : ''}>{p.daysSince === undefined ? '没联系过' : p.daysSince === 0 ? '今天' : `${p.daysSince} 天前`}</span></span>
  </div>
}

/** 人物按组织聚集，原有组标签仍可跨组织筛选。 */
export function PeopleSection({ people, open, ask }: { people: PocState['people']; open: (id: string) => void; ask: (text: string) => void }) {
  const [filter, setFilter] = useState<string>(() => { try { return localStorage.getItem('chief-people-group') ?? '' } catch { return '' } })
  const pick = (g: string) => { setFilter(g); try { localStorage.setItem('chief-people-group', g) } catch { /* 无痕模式 */ } }
  const groups = [...new Set(people.flatMap(p => p.groups ?? []))].sort((a, b) => a.localeCompare(b, 'zh'))
  const active = groups.includes(filter) ? filter : ''
  const visible = active ? people.filter(p => p.groups?.includes(active)) : people
  const sections = groupPeople(visible)
  return <section className="wr-sec" data-tab="people">
    <h2>人物<span className="n">{people.length}</span><button onClick={() => ask('我最近打交道比较多的人有')}>加一位</button></h2>
    {groups.length > 0 && <div className="wr-chipset wr-groups" aria-label="按关系标签筛选">
      <span>标签</span><button className={active ? '' : 'on'} aria-pressed={!active} onClick={() => pick('')}>全部</button>
      {groups.map(g => <button key={g} className={active === g ? 'on' : ''} aria-pressed={active === g} onClick={() => pick(g)}>{g}<i>{people.filter(p => p.groups?.includes(g)).length}</i></button>)}
    </div>}
    {!people.length ? <div className="wr-empty">跟接口人提到谁，谁就会出现在这里。</div>
      : sections.map(section => <div key={section.key} className="wr-group">
        <h3>{section.label}<span className="n">{section.people.length}</span></h3>
        <div className="wr-rows">{section.people.map(p => <PersonRowView key={p.id} p={p} open={open} />)}</div>
      </div>)}
    {people.length > 0 && <div className="wr-empty" style={{ marginTop: 6 }}>点开人物可编辑组织；没有归属的在「未分组」。关系标签可以跨组织筛选。</div>}
  </section>
}

// ───────────── 承诺、会议 ─────────────

function CommitmentRowView({ c, run, busy }: { c: CommitmentRow; run: Run; busy?: string }) {
  const [error, setError] = useState<string>()
  const act = async (key: string, path: string, body: unknown) => setError(await run(key, path, body))
  const hot = c.dueState === 'overdue' || c.dueState === 'today'
  return (
    <div className={`wr-row ${c.dueState === 'overdue' ? 'bad' : c.dueState === 'today' ? 'need' : ''}`}>
      <span className={`lead wr-due ${c.dueState}`}>{dueLabel(c)}</span>
      <div className="main">{c.what}<div className="note"><span className={`wr-tag ${c.direction === 'theirs' ? 'tide' : ''}`}>{c.direction === 'mine' ? '我答应' : '答应我'}</span> {c.who}{c.line ? `，${c.line}` : ''}</div>{error && <div className="wr-err">{error}</div>}</div>
      <span className="tail">
        {c.direction === 'theirs' && hot && <button disabled={busy === `n${c.id}`} onClick={() => act(`n${c.id}`, `/ledger/${c.id}/nudge`, {})}>起草催办</button>}
        <button disabled={busy === `d${c.id}`} onClick={() => act(`d${c.id}`, `/ledger/${c.id}`, { status: 'done' })}>{c.direction === 'mine' ? '已给到' : '已收到'}</button>
      </span>
    </div>
  )
}

function MeetingRowView({ m, open, ask }: { m: MeetingRow; open: (o: Open) => void; ask: (text: string) => void }) {
  const day = m.today ? '今天' : `${m.at.slice(5, 10).replace('-', '/')} ${WEEK[new Date(`${m.at.slice(0, 10)}T12:00`).getDay()]}`
  return (
    <div className={`wr-row ${m.needsNotes ? 'need' : ''}`}>
      <span className="lead">{m.at.slice(11)}</span>
      <div className="main">{m.title}<div className="note">{day}{m.with.length ? `，${m.with.join('、')}` : ''}{m.line ? `，${m.line}` : ''}</div></div>
      <span className="tail">
        {m.prepTicket && <button onClick={() => open({ kind: 'ticket', id: m.prepTicket! })}>看准备材料</button>}
        {!m.past && !m.prepTicket && <span>会前自动准备</span>}
        {m.past && (m.notes ? <span>纪要已录</span> : <button className="go" onClick={() => ask(`「${m.title}」的纪要：`)}>说说会上的结论</button>)}
      </span>
    </div>
  )
}

// ───────────── 幕僚团 ─────────────

function Staff({ state, open, staffName, run, busy }: { state: WarroomState; open: (o: Open) => void; staffName: (id: string) => string; run: Run; busy?: string }) {
  const rows = [...state.active, ...state.queued]
  const row = (c: TicketCard, tail: React.ReactNode) => <div key={c.id} className="wr-row tap" {...tap(() => open({ kind: 'ticket', id: c.id }))}>
    <span className="lead">{c.id.slice(2)}</span><div className="main">{c.title}</div><span className="tail">{tail}</span>
  </div>
  return (
    <section className="wr-sec" data-tab="today">
      <h2>幕僚团在办<span className="n">{rows.length}</span>
        <button disabled={busy === 'pause'} onClick={() => run('pause', '/pause', { paused: !state.paused })}>{state.paused ? '恢复幕僚团' : '暂停幕僚团'}</button></h2>
      {rows.length ? <div className="wr-rows">{rows.map(c => row(c, <><span className="wr-tag">{STAGE_LABEL[c.stage]}</span>{staffName(c.staff)}</>))}</div>
        : <div className="wr-empty">现在没有在办的事。需要调研或写材料，跟接口人说一声。</div>}
      {state.ended.length > 0 && <details className="wr-fold"><summary>最近办完的 {state.ended.length} 件</summary>
        <div className="wr-rows">{state.ended.map(c => row(c, STAGE_LABEL[c.ended?.outcome ?? ''] ?? ''))}</div>
      </details>}
    </section>
  )
}

// ───────────── 主界面 ─────────────

export function App({ native, reconnect, connectionState }: { native?: () => void; reconnect?: () => void; connectionState?: 'connected' | 'connecting' | 'disconnected' } = {}) {
  const { state, error, refresh } = useWarroom()
  const scope = !isSetup(state) ? state?.superhubScope : undefined
  const custom = !isSetup(state) ? state?.custom : undefined
  const [opened, setOpened] = useState(linkedOpen)
  const [selection, setSelection] = useState(() => linkedSelection(opened))
  const selected = selection && (selection.scope === undefined || selection.scope === scope) ? selection.room : undefined
  const [tab, setTab] = useState<Tab>('chat')
  const [rooms, setRooms] = useState<{ id: string; title: string }[]>([])
  const [navError, setNavError] = useState('')
  const returnFocus = useRef<HTMLElement | null>(null)
  const previousScope = useRef(scope)
  const tabInit = useRef(false)
  const pendingCreation = useRef<{ title: string; id: string } | undefined>(undefined)
  const loadRooms = useCallback(async () => { try { const rows = await api<{ id: string; title: string }[]>('/rooms'); if (Array.isArray(rows)) setRooms(rows) } catch {} }, [])
  useEffect(() => { void loadRooms(); const timer = setInterval(() => { void loadRooms() }, 3000); return () => clearInterval(timer) }, [loadRooms])
  useEffect(() => {
    const followLink = () => {
      const next = linkedOpen()
      returnFocus.current = null
      if (!next || next.kind === 'superhub') {
        const linked = linkedSelection(next)
        setSelection(linked && { ...linked, scope: linked.scope ?? scope })
      }
      setOpened(next)
    }
    window.addEventListener('hashchange', followLink)
    return () => window.removeEventListener('hashchange', followLink)
  }, [scope])
  useEffect(() => {
    if (previousScope.current !== scope) {
      if (previousScope.current !== undefined) {
        returnFocus.current = null
        setOpened(linkedOpen())
        setSelection(undefined)
        replaceHash(location.hash.startsWith('#room=') ? '' : location.hash)
      } else if (scope) {
        setSelection(current => current && current.scope === undefined ? { ...current, scope } : current)
      }
      previousScope.current = scope
      setTab('chat')
      tabInit.current = false
    }
    if (custom && !tabInit.current) {
      tabInit.current = true
      if (custom.layout.defaultTab) setTab(custom.layout.defaultTab)
    }
  }, [custom, scope])
  useEffect(() => {
    const origin = overviewRoom()
    if (origin && (opened?.kind !== 'superhub' || opened.id !== origin.scope || (scope !== undefined && scope !== origin.scope))) {
      replaceHash(location.hash)
    }
  }, [opened, scope])
  const choose = (id?: string) => {
    returnFocus.current = null
    setOpened(undefined)
    setSelection(id ? { room: id, scope } : undefined)
    if (!id) setTab('chat')
    replaceHash(id ? `#room=${encodeURIComponent(id)}` : '')
  }
  const overviewActive = opened?.kind === 'superhub'
  const openHub = (place: HubPlace) => {
    if (!scope) return
    const focused = document.activeElement
    if (!overviewActive) returnFocus.current = focused instanceof HTMLElement && focused !== document.body ? focused : null
    replaceHash(hubHash(scope, place), selected ? { scope, room: selected } : undefined)
    setOpened({ kind: 'superhub', id: scope, place })
  }
  const closeHub = () => {
    const origin = returnFocus.current
    returnFocus.current = null
    setOpened(undefined)
    if (origin) requestAnimationFrame(() => { if (origin.isConnected) origin.focus({ preventScroll: true }) })
  }
  const create = async (title: string) => {
    try {
      if (pendingCreation.current?.title !== title) pendingCreation.current = { title, id: requestId() }
      const room = await api<{ id: string }>('/rooms', { title, request_id: pendingCreation.current.id })
      pendingCreation.current = undefined
      await loadRooms()
      choose(room.id)
      setNavError('')
      return true
    } catch (error) { setNavError((error as Error).message); return false }
  }
  const retryConnection = () => { reconnect?.(); void refresh() }
  const openOverview = scope ? () => { if (!overviewActive || opened.id !== scope) openHub({ page: 'overview' }) } : undefined
  return <WorkspaceFrame native={native} notice={native && state && !isSetup(state) && <CommandApprovals />}
    rooms={rooms} selected={selected} choose={choose} error={navError} overviewActive={overviewActive} openOverview={openOverview} create={create}>
    {!state ? <div className="chief-connection-state" role="status">
      <h1>{error ? `${WORKSPACE_NAME} 暂时未连接` : `正在连接 ${WORKSPACE_NAME}`}</h1>
      <p>{error ?? '正在读取你的事务和对话…'}</p>
      {error && <><p>尚未读到数据，这不表示原有记录已清空。</p><button onClick={retryConnection}>重新连接</button></>}
    </div> : isSetup(state) ? <Setup state={state} refresh={refresh} /> : <>
      <div className="chief-connection-banner" role="status" hidden={!error && connectionState !== 'disconnected'}>
        {error ?? 'DSH 连接已断开'} · 保留上次读取的数据 <button onClick={retryConnection}>重试连接</button>
      </div>
      <Warroom key={scope} selected={selected} choose={choose} tab={tab} setTab={setTab} opened={opened} setOpened={setOpened} openHub={openHub} closeHub={closeHub}
        state={state} error={error} refresh={refresh} />
    </>}
  </WorkspaceFrame>
}

function Warroom({ state, error, refresh, selected, choose, tab, setTab, opened, setOpened, openHub, closeHub }: {
  selected?: string; choose: (id?: string) => void; tab: Tab; setTab: (tab: Tab) => void
  state: ReadyState | undefined; error?: string | undefined; refresh: () => Promise<void>
  opened?: Open; setOpened: Dispatch<SetStateAction<Open | undefined>>; openHub: (place: HubPlace) => void; closeHub: () => void
}) {
  const { busy, run } = useAction(refresh)
  // 头像等组件按同一份花名册解析角色名（staff-names.ts）。
  setRoster(state?.staff)
  const onSettled = useCallback(() => { void refresh() }, [refresh])
  useEffect(() => {
    window.addEventListener(APPROVALS_CHANGED, onSettled)
    return () => window.removeEventListener(APPROVALS_CHANGED, onSettled)
  }, [onSettled])
  const scope = state?.superhubScope
  const chat = useChat(onSettled, scope)
  const [draft, setDraftValue] = useState('')
  useEffect(() => { if (chat.sessionId) setDraftValue(sessionStorage.getItem(`chief-liaison-draft:${chat.sessionId}`) ?? '') }, [chat.sessionId])
  const setDraft = (value: string) => { setDraftValue(value); if (chat.sessionId) sessionStorage.setItem(`chief-liaison-draft:${chat.sessionId}`, value) }
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (opened?.kind === 'superhub') return
    if (selected) {
      if (location.hash.startsWith('#superhub?')) replaceHash(`#room=${encodeURIComponent(selected)}`)
      return
    }
    if (opened?.kind === 'reader') {
      const query = new URLSearchParams({ ticket: opened.id, ...opened.path ? { path: opened.path } : {}, ...opened.version ? { version: opened.version } : {} })
      replaceHash(`#delivery?${query}`)
    } else if (opened?.kind === 'ticket') {
      const query = new URLSearchParams({ ticket: opened.id, ...opened.threadId ? { thread: opened.threadId } : {} })
      replaceHash(`#thread?${query}`)
    } else if (opened?.kind === 'threads') replaceHash('#threads')
    else if (/^#(?:delivery\?|thread\?|threads$|superhub\?)/.test(location.hash)) replaceHash('')
  }, [opened, selected])
  const custom = state?.custom
  const staffName = (id: string) => state?.staff.find(s => s.id === id)?.name ?? id
  /** 替主人起个头，交给接口人：切到对话并把光标放进输入框。 */
  const ask = (text: string) => { setDraft(text); setTab('chat'); setOpened(undefined); requestAnimationFrame(() => inputRef.current?.focus()) }
  const poc = state?.poc
  const now = new Date()
  const dueNow = poc ? poc.situation.overdue + poc.situation.dueToday : 0
  const calm = poc ? !Object.values(poc.situation).some(Boolean) : true
  const roomActions = state?.roomActions ?? []
  const commands = state?.commands ?? []
  const decide = state ? state.you.length + state.stuck.length + roomActions.length + commands.length : 0
  const counts: Record<Tab, number> = { chat: 0, today: decide + dueNow, people: 0, staff: state?.staff.reduce((n, s) => n + s.doing.length, 0) ?? 0, events: state?.events.filter(e => e.kind === 'observed').length ?? 0 }
  const tabs = tabOrder(custom)
  const view = tab === 'staff' || tab === 'events' ? tab : 'board'
  const views = (['today', 'staff', 'events'] as const).filter(id => id === 'today' || !isHidden(custom, id))
  const openTicket = (id: string) => {
    if (scope && state && [...state.you, ...state.active, ...state.queued, ...state.ended].some(ticket => ticket.id === id && ticket.scoped)) openHub({ page: 'mission', id })
    else setOpened({ kind: 'ticket', id })
  }
  const openDecision = (item: Open) => { if (item.kind === 'ticket') openTicket(item.id); else setOpened(item) }
  const hubActive = opened?.kind === 'superhub'
  // DSH and standalone bundles can use different React versions. The DOM property keeps the source pane inert in both.
  const setSourcePane = useCallback((node: HTMLDivElement | null) => { if (node) node.inert = hubActive }, [hubActive])
  const hub = hubActive && <SuperHub key={`${opened.id}:${JSON.stringify(opened.place)}`} scope={opened.id} currentScope={scope} initial={opened.place}
    returnLabel={selected ? '返回讨论' : '返回接口人'} close={closeHub} style={themeStyle(custom)} staff={state?.staff ?? []} openRoom={choose}
    legacyTicket={id => setOpened({ kind: 'ticket', id })} refreshBoard={onSettled} />
  const openDiscussion = async (id: string) => {
    const room = await api<{ id: string }>('/rooms/from-ticket', { ticket: id })
    choose(room.id)
  }
  const empty = poc ? !poc.people.length && !poc.lines.length : false

  /** 台面上的每个区块；顺序和显隐由定制决定（sectionOrder）。 */
  const section = (id: string): React.ReactNode => {
    if (!state || !poc) return null
    const panel = custom?.panels.find(p => p.id === id)
    if (panel && custom) return <PanelView key={id} panel={panel} state={state} poc={poc} custom={custom} open={o => setOpened(o)} />
    switch (id) {
      case 'map': return <section key={id} className="wr-sec" data-tab="people"><SituationMap people={poc.people} lines={poc.lines} openPerson={pid => setOpened({ kind: 'person', id: pid })} openLine={lid => setOpened({ kind: 'line', id: lid })} /></section>
      case 'lines': return <section key={id} className="wr-sec" data-tab="people">
        <h2>横向线<span className="n">{poc.lines.length}</span><button onClick={() => ask('我还负责对接')}>加一条</button></h2>
        {poc.lines.length ? <div className="wr-rows">{poc.lines.map(l => <div key={l.id} className={`wr-row tap ${l.blocker || l.health === 'red' ? 'bad' : ''}`} {...tap(() => setOpened({ kind: 'line', id: l.id }))}>
          <span className="lead"><span className={`wr-lamp ${l.health ?? 'none'}`} /></span>
          <div className="main"><b>{l.name}</b><div className="note">{l.blocker ? `受阻：${l.blocker}` : l.lastProgress?.slice(11) ?? l.goal ?? '还没有进展记录'}</div></div>
          <span className="tail">{l.open > 0 && <span>{l.open} 个承诺</span>}{l.syncIn !== undefined && <span className={`wr-due ${l.syncIn < 0 ? 'overdue' : l.syncIn === 0 ? 'today' : 'later'}`}>{l.syncIn < 0 ? '对齐已过期' : l.syncIn === 0 ? '今天对齐' : `${l.syncIn} 天后对齐`}</span>}</span>
        </div>)}</div> : <div className="wr-empty">告诉接口人你负责对接哪些团队或项目，每个会成为一条横向线。</div>}
      </section>
      case 'people': return <PeopleSection key={id} people={poc.people} open={pid => setOpened({ kind: 'person', id: pid })} ask={ask} />
      case 'decide': return <section key={id} className="wr-sec" data-tab="today">
        <h2>{DECISIONS_NAME}<span className={`n ${decide ? 'hot' : ''}`}>{decide}</span></h2>
        {decide ? <div className="wr-rows">
          {state.stuck.map(e => <div key={e.id} className="wr-row bad"><span className="lead" /><div className="main"><b>这件事没能分派出去</b><div className="note">{e.text}</div></div>
            <span className="tail"><button disabled={busy === `rt${e.id}`} onClick={() => run(`rt${e.id}`, `/events/${e.id}/retriage`)}>再试一次</button></span></div>)}
          {roomActions.map(action => <div key={action.id} className="wr-row need"><span className="lead">讨论</span><div className="main"><b>{action.roomTitle}</b><div className="note">{action.text}</div></div>
            <span className="tail"><button onClick={() => choose(action.roomId)}>打开讨论待办</button></span></div>)}
          {commands.map(row => <CommandDecisionRow key={row.id} row={row} />)}
          {state.you.map(c => <Decision key={c.id} card={c} run={run} busy={busy} open={openDecision} staffName={staffName} />)}
        </div> : <div className="wr-empty">{NO_DECISIONS}</div>}
      </section>
      case 'ledger': return <section key={id} className="wr-sec" data-tab="today">
        <h2>承诺<span className={`n ${dueNow ? 'hot' : ''}`}>{poc.ledger.length}</span><button onClick={() => ask('我答应了')}>记一条</button></h2>
        {poc.ledger.length ? <div className="wr-rows">{poc.ledger.map(c => <CommitmentRowView key={c.id} c={c} run={run} busy={busy} />)}</div> : <div className="wr-empty">你答应别人的、别人答应你的，说给接口人听，到期会提醒你。</div>}
      </section>
      case 'meetings': return <section key={id} className="wr-sec" data-tab="today">
        <h2>会议<span className="n">{poc.meetings.filter(m => !m.past).length}</span><button onClick={() => ask('帮我登记一场会议：')}>登记</button></h2>
        {poc.meetings.length ? <div className="wr-rows">{poc.meetings.map(m => <MeetingRowView key={m.id} m={m} open={setOpened} ask={ask} />)}</div>
          : <div className="wr-empty">登记一场会议，幕僚团会在会前准备材料。会后把结论说给接口人，它来拆成承诺和记录。</div>}
      </section>
      case 'doing': return <Staff key={id} state={state} open={setOpened} staffName={staffName} run={run} busy={busy} />
      default: return null
    }
  }
  const peopleCol = isHidden(custom, 'people') ? [] : sectionOrder(custom, 'people')
  const todayCol = isHidden(custom, 'today') ? [] : sectionOrder(custom, 'today')
  if (selected) return <>
    <div className="wr" ref={setSourcePane}>
      <style>{CSS}</style>
      <RoomWorkspace key={selected} selectedId={selected} staff={state?.staff} embedded openTicket={openTicket} close={() => choose()} />
      {opened?.kind === 'ticket' && <TicketDrawer openDiscussion={openDiscussion} key={opened.id} id={opened.id} expectedThreadId={opened.threadId} bound={threadId => setOpened(current => current?.kind === 'ticket' && current.id === opened.id ? { ...current, threadId } : current)} staffName={staffName} inbox={() => setOpened({ kind: 'threads', id: '' })} refreshed={() => { void refresh() }} open={openTicket} readSource={(id, path, version) => setOpened({ kind: 'reader', id, path, version })} close={() => setOpened(undefined)} read={path => setOpened({ kind: 'reader', id: opened.id, ...path ? { path } : {} })} />}
      {opened?.kind === 'reader' && <Reader key={`${opened.id}:${opened.path ?? ''}:${opened.version ?? ''}`} ticketId={opened.id} version={opened.version} {...opened.path ? { path: opened.path } : {}} run={run} staffName={staffName} openTicket={openTicket} close={() => setOpened(undefined)} />}
    </div>
    {hub}
  </>

  return (
    <><div className={`wr wr-workroom t-${tab} ${densityClass(custom)}`} ref={setSourcePane} style={themeStyle(custom)}>
      <style>{CSS}</style>
      <Chat scope={scope} sessionId={chat.sessionId} openRoom={choose} openDiscussion={id => { void openDiscussion(id).catch(error => { window.alert((error as Error).message) }) }} messages={chat.messages} notices={chat.notices} workReplies={chat.workReplies} discussionResults={chat.discussionResults} live={chat.live} openTicket={openTicket} busy={chat.busy} error={chat.error} say={chat.say} draft={draft} setDraft={setDraft} inputRef={inputRef} empty={empty}
        openDelivery={(id, path, version) => setOpened({ kind: 'reader', id, path, version })}
        openWork={(id, at) => openHub({ page: 'mission', id, ...at ? { at } : {} })} />

      <main className="wr-board">
        <div className="wr-in">
          <header className="wr-top">
            <div className="wr-date">{now.getMonth() + 1} 月 {now.getDate()} 日 {WEEK[now.getDay()]}{state?.paused ? '，幕僚团已暂停' : ''}
              <button className="quiet" onClick={() => setOpened({ kind: 'threads', id: '' })}>执行记录</button>
              <button className="quiet" onClick={() => setOpened({ kind: 'export', id: '' })}>导出</button>
              <button className="quiet" onClick={() => setOpened({ kind: 'settings', id: '' })} aria-label="设置">设置</button></div>
            <h1 className={`wr-headline ${calm ? 'calm' : ''}`}>{poc ? headline(poc.situation) : '正在读取'}</h1>
            {views.length > 1 && <div className="wr-views" role="tablist">{views.map(id =>
              <button key={id} role="tab" aria-selected={view === (id === 'today' ? 'board' : id)} className={view === (id === 'today' ? 'board' : id) ? 'on' : ''} onClick={() => setTab(id)}>{TAB_NAMES[id]}</button>)}</div>}
          </header>
          {error && <div className="wr-alert">{error}</div>}
          {state?.problems.length ? <div className="wr-alert">{state.problems.map((p, i) => <div key={i}>{p.text}</div>)}</div> : null}

          {state && view === 'staff' && <StaffView state={state} openStaff={id => id === 'new' ? ask('帮我加一位幕僚，负责') : setOpened({ kind: 'staff', id })} openTicket={openTicket} />}
          {state && view === 'events' && <EventsView state={state} run={run} busy={busy} openTicket={openTicket} />}
          {state && poc && view === 'board' && <div className={`wr-grid ${peopleCol.length && todayCol.length ? '' : 'one'}`}>
            {peopleCol.length > 0 && <div className="wr-col">{peopleCol.map(section)}</div>}
            {todayCol.length > 0 && <div className="wr-col today">{todayCol.map(section)}</div>}
          </div>}
        </div>
      </main>

      <nav className="wr-tabs" aria-label="区块">
        {tabs.map(id => <button key={id} className={tab === id ? 'on' : ''} aria-current={tab === id} onClick={() => setTab(id)}>{TAB_NAMES[id]}<i>{counts[id] || ''}</i></button>)}
      </nav>

      {opened?.kind === 'export' && <ExportDrawer close={() => setOpened(undefined)} />}
      {opened?.kind === 'settings' && <SettingsDrawer close={() => setOpened(undefined)} refresh={refresh} />}
      {opened?.kind === 'staff' && state && <StaffDrawer key={opened.id} id={opened.id} state={state} run={run} ask={ask} close={() => setOpened(undefined)} openTicket={openTicket} />}
      {opened?.kind === 'threads' && <ThreadInbox state={state} staffName={staffName} openTicket={openTicket} close={() => setOpened(undefined)} />}
      {opened?.kind === 'ticket' && <TicketDrawer openDiscussion={openDiscussion} key={opened.id} id={opened.id} expectedThreadId={opened.threadId} bound={threadId => setOpened(current => current?.kind === 'ticket' && current.id === opened.id ? { ...current, threadId } : current)} staffName={staffName} inbox={() => setOpened({ kind: 'threads', id: '' })} refreshed={() => { void refresh() }} open={openTicket} readSource={(id, path, version) => setOpened({ kind: 'reader', id, path, version })} close={() => setOpened(undefined)} read={path => setOpened({ kind: 'reader', id: opened.id, ...path ? { path } : {} })} />}
      {opened?.kind === 'reader' && <Reader key={`${opened.id}:${opened.path ?? ''}:${opened.version ?? ''}`} ticketId={opened.id} version={opened.version} {...opened.path ? { path: opened.path } : {}} run={run} staffName={staffName} openTicket={openTicket} close={() => setOpened(undefined)} />}
      {opened?.kind === 'person' && poc && <PersonDrawer key={opened.id} id={opened.id} poc={poc} run={run} ask={ask} close={() => setOpened(undefined)} />}
      {opened?.kind === 'line' && poc && <LineDrawer key={opened.id} id={opened.id} staff={state?.staff ?? []} openTicket={openTicket} read={(id, path, version) => setOpened({ kind: 'reader', id, path, version })} poc={poc} run={run} ask={ask} close={() => setOpened(undefined)} />}
      <datalist id="wr-people">{poc?.people.map(p => <option key={p.id} value={p.id} />)}</datalist>
    </div>{hub}</>
  )
}
