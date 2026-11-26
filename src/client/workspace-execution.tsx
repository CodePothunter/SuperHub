import { useState } from 'react'
import { codingPermission, orderEnded, type V2CodingPermission, type V2CommandDecision, type V2CommandRecord, type V2Delegation, type V2PendingApproval,
  type V2PermissionChange, type V2RunRecord, type V2Session } from '../core/workspace-v2.ts'
import type { Scoped } from './superhub-api.ts'
import { segment, useV2Read, useV2Write } from './workspace-v2-api.ts'
import { Issue, readableTime, V2Icon } from './workspace-v2-elements.tsx'
import { isApprovalList, isExecutionView, type AcceptanceDecision, type ApprovalListItem } from './workspace-v2-response.ts'
import type { OwnerAction } from '../core/workspace-engagement.ts'
import { OwnerActionRows } from './workspace-owner-actions.tsx'

type Entry = { kind: 'command'; at: string; row: V2CommandRecord } | { kind: 'run'; at: string; row: V2RunRecord } | { kind: 'tier'; at: string; row: V2PermissionChange }
const LONG_COMMAND = 160
const APPROVALS = '/v2/approvals'

export const TIER_LABEL: Record<V2CodingPermission, string> = { ask: '请求批准', 'approve-for-me': '代为批准', 'full-access': '完全访问' }
const TIER_NOTE: Record<V2CodingPermission, string> = {
  ask: '删除、推送、安装、提权、云资源写操作等高危命令逐条等你批准，其余命令直接执行。',
  'approve-for-me': '高危命令由自动审查按工单目标判断；审查不可用时转为请你批准。',
  'full-access': '所有命令直接执行，事后留痕。',
}
export const DECISION_LABEL: Record<V2CommandDecision, string> = {
  auto: '自动放行', allowed: '已允许', rejected: '已拒绝', expired: '已过期',
  'reviewer-allowed': '代为放行', 'reviewer-denied': '代为拒绝', 'gate-unavailable': '把关不可用',
}
const DENIED = new Set<V2CommandDecision>(['rejected', 'expired', 'reviewer-denied', 'gate-unavailable'])
const toolName = (tool: string) => tool === 'codex' ? 'Codex' : tool === 'claude-code' ? 'Claude Code' : tool === 'dsh' ? 'DSH 成员' : tool

function exitLabel(row: V2CommandRecord) {
  // A refused command never ran; the tool may still report the refusal as a failed call.
  if (row.decision && DENIED.has(row.decision)) return '未执行'
  if (!row.endedAt) return row.unfinished ? '未见结束' : row.decision ? '已放行' : '运行中'
  if (typeof row.exitCode === 'number') return '退出码 ' + row.exitCode
  return row.failed ? '失败' : '完成'
}
const runFailed = (row: V2RunRecord) => !!row.process.signal || row.process.exitCode !== 0
function runLabel(row: V2RunRecord) {
  const exit = row.process.signal ? '信号 ' + row.process.signal : row.process.exitCode === null ? '退出码未知' : '退出码 ' + row.process.exitCode
  return '工具进程' + (runFailed(row) ? '异常结束' : '结束') + ' · ' + exit
}

/** Pending high-risk commands of this brain; the order page and 「今天」 share one cheap in-memory list. */
export function usePendingApprovals(enabled = true) {
  return useV2Read(enabled ? APPROVALS : undefined, isApprovalList, 4000)
}

/**
 * The owner's tier for one coding work order. Saved at once; the running turn picks it up from its next command.
 * `archived`: the order page's workspace is archived, so the tier it had stays on show and nothing changes it.
 */
export function OrderPermission({ base, job, changed, archived = false }: { base: string; job: V2Delegation; changed: () => Promise<void>; archived?: boolean }) {
  const write = useV2Write()
  const current = codingPermission(job)
  const closed = orderEnded(job) || archived
  async function choose(permission: V2CodingPermission) {
    if (permission === current || closed) return
    await write.post(base + '/orders/' + segment(job.id) + '/permission', { permission })
    await changed()
  }
  return <section className="v2-tier" aria-label="命令档位">
    <div className="v2-tier-head"><h2>命令档位</h2><small>下一条命令起生效</small></div>
    <div className="v2-tier-options" role="group" aria-label="选择命令档位">
      {(['ask', 'approve-for-me', 'full-access'] as const).map(tier => <button key={tier} type="button" className="v2-tier-option"
        aria-pressed={tier === current} disabled={closed || write.busy} onClick={() => void choose(tier)}>{TIER_LABEL[tier]}</button>)}
    </div>
    <p className="v2-exec-note">{TIER_NOTE[current]}{job.permissionChangedAt && ' 上次调整：' + readableTime(job.permissionChangedAt) + '。'}</p>
    <Issue text={write.error}/>
  </section>
}

/**
 * One high-risk command waiting for the owner: full command, absolute directory, reason and expiry. `actor` names the
 * group member that asked (a DSH member has no tool name of its own).
 */
export function ApprovalCard({ row, path, decided, actor }: { row: V2PendingApproval; path: string; decided: () => Promise<void>; actor?: string }) {
  const write = useV2Write(undefined, false)
  async function answer(allow: boolean) {
    const receipt = await write.post<Scoped>(path + '/approvals/' + segment(row.id), {allow, ...(row.traceId && {expectedTraceId:row.traceId})})
    if (receipt) await decided()
  }
  const who = actor ?? toolName(row.tool)
  return <article className="v2-approval" aria-label={'等你决定：' + who + ' 申请运行命令'}>
    <div className="v2-approval-head"><strong>等你决定</strong><span>{who} 申请运行</span>
      <time dateTime={row.expiresAt}>{readableTime(row.expiresAt)} 前未处理会过期</time></div>
    {/* Long commands scroll inside the card; the region takes keyboard focus so the whole text can be read. */}
    <pre className="v2-exec-pre v2-approval-command" tabIndex={0} aria-label="命令全文">{row.command}</pre>
    <dl className="v2-approval-facts">
      <div><dt>目录</dt><dd><code>{row.cwd}</code></dd></div>
      <div><dt>理由</dt><dd>{row.reason}</dd></div>
    </dl>
    <div className="v2-actions">
      <button type="button" className="v2-button primary" disabled={write.busy} onClick={() => void answer(true)}>批准</button>
      <button type="button" className="v2-button" disabled={write.busy} onClick={() => void answer(false)}>拒绝</button>
    </div>
    <Issue text={write.error}/>
  </article>
}

/**
 * Command history of a coding work order: every tool use with its gate decision, exit and output tail, newest first.
 * `cards: false` (a roster group): the approval cards stand above the group's composer instead.
 */
export function OrderExecution({ base, job, session, cards = true }: { base: string; job: V2Delegation; session: V2Session; cards?: boolean }) {
  const approvals = usePendingApprovals(cards && !orderEnded(job))
  const pending = cards ? approvals.data?.approvals.filter(row => row.workspaceId === job.workspaceId && row.workOrderId === job.id) ?? [] : []
  return <ExecutionRecord path={base + '/orders/' + segment(job.id)} matches={data => data.delegationId === job.id}
    session={session} tier={codingPermission(job)} active={job.status === 'active' && !job.paused}
    pending={pending} refreshPending={approvals.refresh}/>
}

/**
 * The same record for the session's general discussion (commands without a work order). With `members` (a roster group)
 * the commands are listed per member, and there are no approval cards here: the group shows them above its composer.
 */
export function SessionExecution({ base, session, members }: { base: string; session: V2Session; members?: readonly RecordMember[] }) {
  const approvals = usePendingApprovals(!session.closed && !members)
  const pending = members ? [] : approvals.data?.approvals.filter(row => row.workspaceId === session.workspaceId && row.sessionId === session.id && row.workOrderId === null) ?? []
  return <ExecutionRecord path={base + '/sessions/' + segment(session.id)} matches={data => data.sessionId === session.id && !data.delegationId}
    session={session} tier="full-access" discussion active={!session.closed} pending={pending} refreshPending={approvals.refresh} {...members && { members }}/>
}
/** A member of a roster group, as the execution record names it. */
export interface RecordMember { id: string; name: string; kind: string }

/**
 * A roster group's record per member, in roster order (members with no command left out); commands of someone no longer
 * in the group stay under the name they had. `others`: records without a member (tier changes, older lines).
 */
export function byMember<T extends { kind: string; row: object }>(entries: readonly T[], members: readonly RecordMember[]) {
  const memberOf = (entry: T) => entry.kind === 'command' ? (entry.row as V2CommandRecord).memberId : undefined
  const ids = [...new Set([...members.map(member => member.id), ...entries.flatMap(entry => memberOf(entry) ?? [])])]
  return {
    members: ids.flatMap(id => {
      const own = entries.filter(entry => memberOf(entry) === id)
      const member = members.find(row => row.id === id)
      const label = member?.name ?? own.flatMap(entry => (entry.row as V2CommandRecord).memberName ?? [])[0] ?? '已离开的成员'
      return own.length ? [{id, label, kind: member?.kind, own}] : []
    }),
    others: entries.filter(entry => !memberOf(entry)),
  }
}

/** A path as one shell word (quoted only when needed). */
const shellWord = (text: string) => /^[\w./@%+=:,-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'"

function ExecutionRecord({ path, matches, session, tier, active, discussion, pending, refreshPending, members }: {
  path: string; matches: (data: {delegationId?: string; sessionId?: string}) => boolean; session: V2Session; tier: V2CodingPermission
  active: boolean; discussion?: boolean; pending: V2PendingApproval[]; refreshPending: () => Promise<void>; members?: readonly RecordMember[]
}) {
  const [opened, setOpened] = useState(false)
  const query = useV2Read(opened ? path + '/execution' : undefined, isExecutionView, active || pending.length ? 5000 : undefined)
  const data = query.data && matches(query.data) ? query.data : undefined
  const entries: Entry[] = data ? [
    ...data.commands.map(row => ({kind: 'command' as const, at: row.at, row})),
    ...data.runs.filter(row => runFailed(row) || row.process.stderrTail && row.state !== 'done')
      .map(row => ({kind: 'run' as const, at: row.endedAt ?? row.startedAt ?? '', row})),
    ...(data.permissions ?? []).map(row => ({kind: 'tier' as const, at: row.at, row})),
  ].sort((a, b) => b.at.localeCompare(a.at)) : []
  const latest = data?.runs.findLast(row => row.nativeSessionId)
  // Claude Code keeps sessions per directory: the command opens the run's own directory first.
  const resume = latest && (latest.cwd ? 'cd ' + shellWord(latest.cwd) + ' && ' : '') + (latest.tool === 'codex' ? 'codex resume ' : 'claude --resume ') + latest.nativeSessionId
  const model = data?.runs.findLast(row => row.model)?.model
  const decided = async () => { await Promise.all([refreshPending(), opened ? query.refresh() : undefined]) }
  const name = session.engine === 'roster' ? '群成员' : toolName(session.executor)
  const title = members ? '群里不属于工单的执行记录' : discussion ? '会话讨论的执行记录' : '执行记录'
  const rows = (list: Entry[]) => list.map(entry => entry.kind === 'command'
    ? <CommandRow key={'c/' + entry.row.id} row={entry.row}/>
    : entry.kind === 'run' ? <RunRow key={'r/' + entry.row.turnId} row={entry.row}/>
    : <TierRow key={'t/' + entry.row.at + entry.row.to} row={entry.row}/>)
  const split = members && byMember(entries, members)
  const byMemberRows = split?.members, others = split?.others ?? []
  return <section className="v2-execution-block" aria-label={title}>
    {pending.length > 0 && <div className="v2-approvals" aria-live="polite">{pending.map(row => <ApprovalCard key={row.id} row={row} path={path} decided={decided}/>)}</div>}
    <details className="v2-execution" onToggle={event => setOpened(event.currentTarget.open)}>
      <summary>{title}{data ? '（' + data.commands.length + ' 条命令）' : ''}</summary>
      <Issue text={query.error} retry={query.refresh}/>
      {opened && !data && !query.error && <p role="status" className="v2-quiet">正在读取执行记录…</p>}
      {data && <>
        <p className="v2-exec-note">{TIER_LABEL[tier]}：{name} 以你的本机配置运行。{TIER_NOTE[tier]}</p>
        {model && <p className="v2-exec-note">最近一轮的实际模型：<code>{model}</code></p>}
        {resume && <p className="v2-exec-note">原生会话可在终端打开：<code>{resume}</code></p>}
        {!entries.length ? <p className="v2-quiet">{members ? '还没有执行记录。成员在群里（不为某张工单）运行命令后会按成员列在这里。' : '还没有执行记录。编程工具运行命令后会出现在这里。'}</p>
          : byMemberRows ? <>{byMemberRows.map(group => <section key={group.id} className="v2-exec-member" data-member={group.id} aria-label={group.label + ' 的命令'}>
              <h3>{group.label}{group.kind && group.kind !== 'dsh' && <small>{toolName(group.kind)}</small>}<small>{group.own.length} 条</small></h3>
              <ol className="v2-exec-list">{rows(group.own)}</ol></section>)}
            {others.length > 0 && <ol className="v2-exec-list" aria-label="其他记录">{rows(others)}</ol>}</>
          : <ol className="v2-exec-list" aria-label="命令与工具进程">{rows(entries)}</ol>}
      </>}
    </details>
  </section>
}

function CommandRow({ row }: { row: V2CommandRecord }) {
  const long = row.command.length > LONG_COMMAND || row.command.includes('\n')
  const denied = !!row.decision && DENIED.has(row.decision)
  const state = denied ? 'denied' : !row.endedAt ? 'running' : row.failed || typeof row.exitCode === 'number' && row.exitCode !== 0 ? 'failed' : 'done'
  return <li className="v2-exec-row" data-state={state}>
    <div className="v2-exec-meta"><time dateTime={row.at}>{readableTime(row.at)}</time><span>{row.tool}</span>
      {row.decision && <span className="v2-decision-badge" data-decision={row.decision}>{DECISION_LABEL[row.decision]}</span>}
      <strong className="v2-exec-exit">{exitLabel(row)}</strong></div>
    {long ? <details className="v2-exec-more"><summary><code className="v2-exec-command">{row.command.split('\n')[0]!.slice(0, LONG_COMMAND)}…</code></summary>
      <pre className="v2-exec-pre">{row.command}</pre></details>
      : <code className="v2-exec-command">{row.command}</code>}
    {row.decision && row.decision !== 'auto' && row.reason && <p className="v2-exec-note">{row.reason}</p>}
    {row.decision === 'auto' && row.risk === 'high' && row.reason && <p className="v2-exec-note">高危命令 · {row.reason}</p>}
    {row.outputTail && <details className="v2-exec-more"><summary>输出末尾</summary><pre className="v2-exec-pre">{row.outputTail}</pre></details>}
  </li>
}

function RunRow({ row }: { row: V2RunRecord }) {
  const at = row.endedAt ?? row.startedAt
  return <li className="v2-exec-row" data-state={runFailed(row) ? 'failed' : 'done'}>
    <div className="v2-exec-meta">{at && <time dateTime={at}>{readableTime(at)}</time>}<span>{toolName(row.tool)}</span>
      <strong className="v2-exec-exit">{runLabel(row)}</strong></div>
    {row.process.stderrTail ? <details className="v2-exec-more"><summary>错误输出末尾</summary><pre className="v2-exec-pre">{row.process.stderrTail}</pre></details>
      : <p className="v2-exec-note">工具没有留下错误输出。</p>}
  </li>
}

function TierRow({ row }: { row: V2PermissionChange }) {
  return <li className="v2-exec-row" data-state="tier">
    <div className="v2-exec-meta"><time dateTime={row.at}>{readableTime(row.at)}</time><span>你</span>
      <strong className="v2-exec-exit">命令档位：{TIER_LABEL[row.from]} → {TIER_LABEL[row.to]}</strong></div>
  </li>
}

/**
 * 「等你决定」 on 「今天」, and a short reminder elsewhere. Opening a command lands on the order with its approval card;
 * an order the liaison found still short after its follow-up opens on its conversation.
 */
export function PendingCommandApprovals({ today, goToday, open, openOrder, list, ownerActions = [], openOwnerAction, ownerActionError, retryOwnerActions }: {
  today: boolean; goToday: () => void; open: (row: ApprovalListItem) => void; openOrder?: (row: AcceptanceDecision) => void
  list?: { approvals: readonly ApprovalListItem[]; acceptances?: readonly AcceptanceDecision[] }
  ownerActions?: readonly OwnerAction[]; openOwnerAction?: (row: OwnerAction) => void; ownerActionError?: string; retryOwnerActions?: () => Promise<void>
}) {
  const query = usePendingApprovals(!list)
  const snapshot = list ?? query.data
  const rows = snapshot?.approvals ?? []
  const decisions = openOrder ? snapshot?.acceptances ?? [] : []
  const counts = [rows.length && rows.length + ' 条命令', decisions.length && decisions.length + ' 张工单待验收'].filter(Boolean).join('，')
  if (!today) return counts ? <button type="button" className="v2-link v2-result-alert v2-approval-alert" onClick={goToday}>
    <V2Icon name="work"/>{counts}等你决定</button> : null
  const pending = openOwnerAction && ownerActions.length > 0
  if (!counts && !pending && !ownerActionError) return null
  return <div className="v2-pending-approvals">
    {(pending || ownerActionError) && <section aria-label="待你回应">
      <div className="v2-section-head"><h2><V2Icon name="chat"/>待你回应{pending && '（' + ownerActions.length + '）'}</h2></div>
      <Issue text={ownerActionError} retry={retryOwnerActions}/>
      {pending && <OwnerActionRows items={ownerActions} open={openOwnerAction}/>}
    </section>}
    {counts && <section aria-label="等你决定">
      <div className="v2-section-head"><h2 aria-live="polite"><V2Icon name="work"/>等你决定（{counts}）</h2></div>
      {decisions.length > 0 && <div className="v2-card">{decisions.map(row => <button type="button" key={row.orderId} className="v2-row" data-acceptance={row.orderId} onClick={() => openOrder!(row)}>
        <span className="v2-row-title"><strong>{row.orderTitle}</strong><V2Icon name="next"/></span>
        <small>{row.workspaceName} · 接口人验收：追问后仍有缺口{row.gaps.length ? '（' + row.gaps.slice(0, 2).join('；') + (row.gaps.length > 2 ? '…' : '') + '）' : ''} · {readableTime(row.at)}</small>
      </button>)}</div>}
      {rows.length > 0 && <div className="v2-card">{rows.map(row => <button type="button" key={row.id} className="v2-row" onClick={() => open(row)}>
        <span className="v2-row-title"><strong>{row.orderTitle ?? row.sessionTitle}</strong><V2Icon name="next"/></span>
        <code className="v2-exec-command">{row.command.length > LONG_COMMAND ? row.command.slice(0, LONG_COMMAND) + '…' : row.command}</code>
        <small>{row.workspaceName} · {row.memberName ? row.memberName + (row.tool === 'dsh' ? '' : '（' + toolName(row.tool) + '）') : toolName(row.tool)} · {row.reason} · {readableTime(row.expiresAt)} 前未处理会过期</small>
      </button>)}</div>}
    </section>}
  </div>
}
