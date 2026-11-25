/**
 * 工作区群聊（`engine: 'roster'` 的会话）在对话里多出来的部分：
 *
 * - 发言里的 `@名字` 渲染成带头像的名字签（按服务端给的分段，只高亮真被叫到的人）；
 * - 输入框的 `@` 菜单：成员在前（头像、名字、管理员 / Codex 等标记与在本工作区的分工），最后是「所有人」；
 *   ↑↓ 选择，Enter / Tab 填入 `@名字 `，Esc 关闭，输入法组字时不抢键；
 * - 输入框上方的状态胶囊：正在忙的成员（等你批准的在前，然后在干活的、排队的），可单个停止或全部停止；
 *   空转守卫暂停时的提示；成员（含 DSH 成员）待你批准的命令卡片；
 * - 页头的成员表（管理员标出）。
 */
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ALL_WORDS, mentionSpans, type Mentionable, type MentionSegment } from '../core/mentions.ts'
import type { SpeakerPortraits } from '../core/workspace-avatars.ts'
import type { GroupDeliveryState, GroupMemberState } from '../dsh/workspace-v2.ts'
import type { Decorate } from './markdown.tsx'
import type { Scoped } from './superhub-api.ts'
import { ChatAvatar } from './workspace-chat-avatar.tsx'
import { ApprovalCard } from './workspace-execution.tsx'
import { Issue, V2Icon } from './workspace-v2-elements.tsx'
import type { GroupState } from './workspace-v2-response.ts'

/** The all-word the menu offers (any of `ALL_WORDS` calls everyone). */
export const ALL_LABEL = '所有人'
export const MEMBER_KIND_LABEL: Record<GroupMemberState['kind'], string | undefined> = { dsh: undefined, codex: 'Codex', 'claude-code': 'Claude Code' }
export const MEMBER_STATUS_LABEL: Record<GroupMemberState['status'], string> = {
  idle: '空闲', queued: '排队中', speaking: '正在回答', working: '在干活', approval: '等你批准', missed: '很久没有动静',
}
const STATUS_ORDER: Record<GroupMemberState['status'], number> = { approval: 0, speaking: 1, working: 1, missed: 1, queued: 2, idle: 3 }

/** Where the owner's words went for one member they called. */
export const DELIVERY_LABEL: Record<GroupDeliveryState['outcome'], (name: string) => string> = {
  started: name => name + '开始回答', queued: name => '已排队，' + name + '忙完手上的就看', steered: name => '已送进' + name + '这一轮', pending: name => '正在送进' + name + '这一轮',
  failed: name => '未送达' + name,
}

/** Under an owner line: for each member it called, whether a new call answers it, it waits, or it went into the running call. */
export function GroupDeliveries({ deliveries, members }: { deliveries?: readonly GroupDeliveryState[]; members: readonly GroupMemberState[] }) {
  if (!deliveries?.length) return null
  return <small className="v2-delivery-note v2-group-delivery" data-delivery="group">{deliveries.map((row, index) => {
    const name = members.find(member => member.id === row.memberId)?.name ?? row.memberId
    return <span key={row.memberId} data-member={row.memberId} data-outcome={row.outcome}>{index > 0 && ' · '}{DELIVERY_LABEL[row.outcome](name)}{row.outcome === 'failed' && row.detail && ' · ' + row.detail}</span>
  })}</small>
}

/** Small marks next to a member's name: the admin, and the coding tool behind a member. */
export function MemberBadges({ member }: { member: Pick<GroupMemberState, 'admin' | 'kind'> }) {
  const kind = MEMBER_KIND_LABEL[member.kind]
  return <>{member.admin && <span className="v2-member-badge" data-badge="admin">管理员</span>}
    {kind && <span className="v2-member-badge" data-badge={member.kind}>{kind}</span>}</>
}

// ---------------------------------------------------------------------------------------------
// Mentions in a line

/**
 * Highlight the `@` the server found in a line (its `mentions` segments) wherever they stand in the Markdown body. Only
 * the names the server matched are looked for again (same rules, `mentionSpans`), so a highlighted name is a real call;
 * text in links, code and quotes is left as it is by the Markdown renderer.
 */
export function mentionDecorator(segments: readonly MentionSegment[] | undefined, members: readonly GroupMemberState[], portraits?: SpeakerPortraits): Decorate | undefined {
  if (!segments?.some(part => 'memberId' in part || 'all' in part)) return undefined
  const called: Mentionable[] = []
  for (const part of segments) if ('memberId' in part && !called.some(row => row.id === part.memberId && row.name === part.label)) called.push({ id: part.memberId, name: part.label })
  const all = segments.some(part => 'all' in part)
  return (text, key) => {
    const spans = mentionSpans(text, called).filter(span => span.member || all)
    if (!spans.length) return text
    const nodes: ReactNode[] = []
    let cursor = 0
    spans.forEach((span, index) => {
      if (span.start > cursor) nodes.push(text.slice(cursor, span.start))
      const label = text.slice(span.start + 1, span.end)
      const member = span.member && members.find(row => row.id === span.member!.id)
      nodes.push(<MentionChip key={key + '@' + index} label={label} {...(span.member ? { memberId: span.member.id } : { all: true })}
        portrait={member ? portraits?.[member.speakerId] : undefined}/>)
      cursor = span.end
    })
    if (cursor < text.length) nodes.push(text.slice(cursor))
    return nodes
  }
}

export function MentionChip({ label, memberId, all, portrait }: { label: string; memberId?: string; all?: true; portrait?: SpeakerPortraits[string] }) {
  return <span className="v2-mention" data-member={memberId} data-all={all ? '' : undefined}>
    {all ? <V2Icon name="group"/> : <ChatAvatar portrait={portrait} className="v2-avatar-mini"/>}@{label}</span>
}

// ---------------------------------------------------------------------------------------------
// The @ menu (pure parts first, so the keyboard flow is testable without a DOM)

export interface MentionOption { id: string; label: string; member?: GroupMemberState; all?: true }

/** The `@…` being typed right before the caret: where the `@` is and what follows it. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const before = text.slice(0, caret)
  const start = before.lastIndexOf('@')
  if (start < 0) return undefined
  const query = before.slice(start + 1)
  // An address (`a@b`, `x.com/@y`) is not a call; names in the menu are picked by a prefix without spaces.
  if (/[\s@`]/.test(query) || query.length > 24 || start > 0 && /[a-z0-9_./]/i.test(before[start - 1]!)) return undefined
  return { start, query }
}

/** Members whose name starts with (then contains) the query, in roster order, then 「所有人」. */
export function mentionOptions(members: readonly GroupMemberState[], query: string): MentionOption[] {
  const q = query.toLowerCase()
  const rank = (name: string) => { const n = name.toLowerCase(); return n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2 }
  const people = members.map(member => ({ member, rank: rank(member.name) })).filter(row => row.rank < 2).sort((a, b) => a.rank - b.rank)
  const all = !q || ALL_LABEL.includes(query) || ALL_WORDS.some(word => word.startsWith(q))
  return [...people.map(({ member }) => ({ id: member.id, label: member.name, member })), ...all ? [{ id: 'all', label: ALL_LABEL, all: true as const }] : []]
}

/** Replace the typed `@query` with `@名字 ` and put the caret after it. */
export function insertMention(text: string, start: number, caret: number, label: string): { text: string; caret: number } {
  const after = text.slice(caret)
  const spaced = /^\s/.test(after)
  const inserted = '@' + label + (spaced ? '' : ' ')
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length + (spaced ? 1 : 0) }
}

export type MentionStep = { move: 1 | -1 } | { pick: true } | { close: true }
type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }
/** What a key does while the menu is open; nothing while an input method composes (its Enter confirms the text). */
export function mentionKey(event: KeyLike): MentionStep | undefined {
  if (event.isComposing || event.keyCode === 229) return undefined
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey
  if (event.key === 'ArrowDown' && plain) return { move: 1 }
  if (event.key === 'ArrowUp' && plain) return { move: -1 }
  if ((event.key === 'Enter' || event.key === 'Tab') && plain && !event.shiftKey) return { pick: true }
  if (event.key === 'Escape') return { close: true }
  return undefined
}

/**
 * The composer's `@` menu over a textarea whose value is `text`. `track` follows the caret (change, select, focus);
 * `keyDown` returns true when the menu used the key.
 */
export function useMentionMenu(members: readonly GroupMemberState[] | undefined, text: string, edit: (value: string) => void) {
  const field = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
  const [caret, setCaret] = useState<number>()
  const [choice, setChoice] = useState({ key: '', index: 0 })
  const [dismissed, setDismissed] = useState<number>()
  const place = useRef<number>(undefined)
  const found = members && caret !== undefined ? mentionQuery(text, caret) : undefined
  const options = found ? mentionOptions(members!, found.query) : []
  const open = !!found && found.start !== dismissed && options.length > 0
  const key = found ? found.start + ':' + found.query : ''
  const active = open ? Math.min(choice.key === key ? choice.index : 0, options.length - 1) : -1
  useLayoutEffect(() => {
    const at = place.current
    if (at === undefined || !field.current) return
    place.current = undefined
    field.current.setSelectionRange(at, at)
  })
  function track(node: HTMLTextAreaElement) {
    const at = node.selectionStart === node.selectionEnd ? node.selectionEnd : undefined
    setCaret(at)
    if (at === undefined || !mentionQuery(node.value, at)) setDismissed(undefined)
  }
  function pick(option: MentionOption) {
    if (!found || caret === undefined) return
    const next = insertMention(text, found.start, caret, option.label)
    edit(next.text)
    setCaret(next.caret)
    place.current = next.caret
    field.current?.focus({ preventScroll: true })
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open) return false
    const step = mentionKey({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode })
    if (!step) return false
    event.preventDefault()
    event.stopPropagation()
    if ('move' in step) setChoice({ key, index: (active + step.move + options.length) % options.length })
    else if ('pick' in step) pick(options[active]!)
    else setDismissed(found!.start)
    return true
  }
  return { field, listId, open, options, active, track, pick, keyDown, close: () => setCaret(undefined),
    activeId: open ? listId + '-' + active : undefined }
}

/** The menu: each member with its avatar, marks and duty in this workspace (from the group's own view), then 「所有人」. */
export function MentionMenu({ id, options, active, portraits, pick }: {
  id: string; options: readonly MentionOption[]; active: number; portraits?: SpeakerPortraits
  pick: (option: MentionOption) => void
}) {
  return <ul className="v2-mention-menu" id={id} role="listbox" aria-label="提及成员">
    {options.map((option, index) => <li key={option.id} id={id + '-' + index} role="option" aria-selected={index === active}
      data-option={option.id} onMouseDown={event => { event.preventDefault(); pick(option) }}>
      {option.member ? <ChatAvatar portrait={portraits?.[option.member.speakerId]} className="v2-avatar-mini"/>
        : <span className="v2-mention-all" aria-hidden="true"><V2Icon name="group"/></span>}
      <span className="v2-mention-option"><strong>{option.label}</strong>{option.member && <MemberBadges member={option.member}/>}
        <small>{option.all ? '叫起群里所有成员' : option.member?.duty || (option.member?.admin ? '先接你的话，按分工派活和验收' : '')}</small></span>
    </li>)}
  </ul>
}

// ---------------------------------------------------------------------------------------------
// Members, status and stop

/** The member list in the group's header, admin marked. */
export function GroupRoster({ members, portraits }: { members: readonly GroupMemberState[]; portraits?: SpeakerPortraits }) {
  return <ul className="v2-group-roster" aria-label="群成员">
    <li><ChatAvatar portrait={portraits?.owner} className="v2-avatar-mini"/><span>你</span></li>
    {members.map(member => <li key={member.id} data-member={member.id}>
      <ChatAvatar portrait={portraits?.[member.speakerId]} className="v2-avatar-mini"/><span>{member.name}</span><MemberBadges member={member}/></li>)}
  </ul>
}

/** Busy members: waiting for approval first, then answering or working, then queued (roster order within each). */
export function busyMembers(members: readonly GroupMemberState[]): GroupMemberState[] {
  return members.filter(member => member.status !== 'idle').map((member, index) => ({ member, index }))
    .sort((a, b) => STATUS_ORDER[a.member.status] - STATUS_ORDER[b.member.status] || a.index - b.index).map(row => row.member)
}

const minutes = (since: string | undefined, now: number) => {
  const at = since ? Date.parse(since) : NaN
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : undefined
}

/** What a busy member is doing: for how long, who called it, and what is queued for it. */
function doing(member: GroupMemberState, now: number) {
  const elapsed = member.status === 'queued' ? undefined : minutes(member.since, now)
  return [elapsed !== undefined && (elapsed < 1 ? '刚开始' : '已 ' + elapsed + ' 分钟'), member.note, member.queued > 0 && '还有 ' + member.queued + ' 件排队'].filter(Boolean).join(' · ')
}
const clip = (text: string, max: number) => text.length > max ? text.slice(0, max) + '…' : text

/** Its running call's latest tool (and on what) and latest words, as the host reports them. */
function MemberActivity({ member }: { member: GroupMemberState }) {
  if (member.status === 'queued' || member.status === 'idle' || !member.tool && !member.progress) return null
  return <>{member.tool && <small className="v2-busy-tool" data-tool={member.tool.name}>正在用 {member.tool.name}{member.tool.detail && <>：<code>{clip(member.tool.detail, 120)}</code></>}</small>}
    {member.progress && <small className="v2-busy-progress">{clip(member.progress.text, 120)}</small>}</>
}

export interface StopWriter { post: (resource: string, body: Record<string, unknown>) => Promise<Scoped | undefined>; busy: boolean; error: string }

/**
 * Above the composer: the idle-guard notice, members' approval cards and the status capsule (busy members, each with
 * 「停止」, and 「全部停止」).
 */
export function GroupStatus({ path, group, portraits, now, stop, refresh }: {
  path: string; group: GroupState; portraits?: SpeakerPortraits; now: number
  stop: StopWriter; refresh: () => Promise<void>
}) {
  const busy = busyMembers(group.members)
  const halt = async (memberId?: string) => {
    const receipt = await stop.post(path + '/stop', memberId === undefined ? {} : { memberId })
    if (receipt) await refresh()
  }
  const nameOf = (memberId?: string) => group.members.find(member => member.id === memberId)
  return <div className="v2-group-state">
    {group.paused && <div className="v2-group-paused" role="status"><strong>自动叫人已暂停</strong>
      <span>{group.paused.reason}</span><small>{[group.paused.parked > 0 && '挂起的叫人 ' + group.paused.parked + ' 次', '你发言后恢复'].filter(Boolean).join(' · ')}</small></div>}
    {group.approvals.length > 0 && <div className="v2-approvals v2-group-approvals" aria-live="polite">{group.approvals.map(row => {
      const member = nameOf(row.memberId)
      return <ApprovalCard key={row.id} row={row} path={path} decided={refresh}
        {...member && { actor: member.name + (MEMBER_KIND_LABEL[member.kind] ? '（' + MEMBER_KIND_LABEL[member.kind] + '）' : '') }}/>
    })}</div>}
    {busy.length > 0 && <details className="v2-group-status">
      <summary aria-label={'正在忙的成员：' + busy.map(member => member.name + MEMBER_STATUS_LABEL[member.status]).join('，')}>
        <span className="v2-capsule">{busy.map(member => <span key={member.id} className="v2-capsule-member" data-status={member.status}>
          <ChatAvatar portrait={portraits?.[member.speakerId]} className="v2-avatar-mini"/>{member.name}<small>{MEMBER_STATUS_LABEL[member.status]}</small></span>)}</span>
        <small className="v2-capsule-hint">你的话会立即送到 · 展开可停止</small></summary>
      <ul className="v2-busy-list" aria-label="正在忙的成员">{busy.map(member => <li key={member.id} data-status={member.status}>
        <ChatAvatar portrait={portraits?.[member.speakerId]} className="v2-avatar-mini"/>
        <div><strong>{member.name}</strong><span className="v2-busy-state">{MEMBER_STATUS_LABEL[member.status]}</span><small>{doing(member, now)}</small>
          <MemberActivity member={member}/></div>
        <button type="button" className="v2-button" aria-label={'停止' + member.name} disabled={stop.busy} onClick={() => void halt(member.id)}>停止</button>
      </li>)}</ul>
      <div className="v2-actions"><button type="button" className="v2-button" disabled={stop.busy} onClick={() => void halt()}>全部停止</button></div>
      <Issue text={stop.error}/>
    </details>}
  </div>
}
