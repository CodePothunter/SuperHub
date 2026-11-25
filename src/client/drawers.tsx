/**
 * 抽屉：人物、横向线、工单的详情与编辑。
 * 这里是主人的入口，所以判断字段（关系、影响力、立场、画像、健康度）可以直接改。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useLegacyRequest } from './legacy-scope.ts'
import { Workline } from './workline.tsx'
import { api, type Line, type Person, type PocState } from './api.ts'
import { TicketConversation } from './ticket-thread.tsx'
import { STAGE_LABEL } from './ticket-labels.ts'
import { ownerTarget } from './ticket-target.ts'

type Run = (key: string, path: string, body?: unknown) => Promise<string | undefined>
const enc = encodeURIComponent
const WARMTH: Record<string, string> = { warm: '热', neutral: '一般', cold: '冷' }
const INFLUENCE: Record<string, string> = { high: '高', mid: '中', low: '低' }
const HEALTH: Record<string, string> = { green: '顺', yellow: '有风险', red: '出问题' }
const splitLog = (entry: string) => /^\d{4}-\d{2}-\d{2}/.test(entry) ? [entry.slice(5, 10), entry.slice(11)] as const : ['', entry] as const

export function Seg<T extends string>({ value, options, onChange }: { value: T | ''; options: readonly (readonly [T, string])[]; onChange: (v: T | '') => void }) {
  return <span className="wr-seg">{options.map(([v, label]) =>
    <button key={v} type="button" className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => onChange(value === v ? '' : v)}>{label}</button>)}</span>
}

export function Shell({ title, meta, close, children, modal = false }: { title: string; meta?: React.ReactNode; close: () => void; children: React.ReactNode; modal?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (!modal) return
    const previous = document.activeElement
    closeButton.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [modal])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // A receipt can return to a native dialog. Consume this key before opening it.
      if (modal) e.preventDefault()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, modal])
  const containFocus = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Tab' || !dialog.current) return
    const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button, input, textarea, select, summary, a[href], [tabindex]'))
      .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && control.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    const next = event.shiftKey && document.activeElement === first ? last : !event.shiftKey && document.activeElement === last ? first : undefined
    if (next) { event.preventDefault(); next.focus() }
  }
  return (
    <div className="wr-veil" onClick={close}>
      <div ref={dialog} className="wr-drawer" role="dialog" aria-label={title} aria-modal={modal || undefined} onKeyDown={modal ? containFocus : undefined} onClick={e => e.stopPropagation()}>
        <div className="head"><h2>{title}</h2><span className="wr-grow" /><button ref={closeButton} onClick={close}>关闭</button></div>
        {meta && <div className="meta">{meta}</div>}
        {children}
      </div>
    </div>
  )
}

/** 选组：点已有的组切换，或者输入一个新组名回车。 */
function GroupPicker({ value, all, onChange }: { value: string[]; all: string[]; onChange: (groups: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const toggle = (g: string) => onChange(value.includes(g) ? value.filter(x => x !== g) : [...value, g])
  const add = () => { const g = draft.trim().slice(0, 20); if (g && !value.includes(g)) onChange([...value, g]); setDraft('') }
  return <span className="wr-chipset">
    {[...new Set([...all, ...value])].map(g => <button key={g} type="button" className={value.includes(g) ? 'on' : ''} aria-pressed={value.includes(g)} onClick={() => toggle(g)}>{g}</button>)}
    <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add() } }} onBlur={add} placeholder="新组名，回车" style={{ width: 110 }} />
  </span>
}

export function PersonDrawer({ id, poc, run, ask, close }: { id: string; poc: PocState; run: Run; ask: (text: string) => void; close: () => void }) {
  const [p, setP] = useState<Person>()
  const [error, setError] = useState<string>()
  const [edit, setEdit] = useState<Partial<Person>>()
  const load = () => api<Person>(`/people/${enc(id)}`).then(setP, e => setError((e as Error).message))
  useEffect(() => { void load() }, [id])
  const act = async (key: string, path: string, body: unknown, after?: () => void) => {
    const message = await run(key, path, body)
    setError(message)
    if (!message) { after?.(); await load() }
  }
  const row = poc.people.find(x => x.id === id)
  const ledger = poc.ledger.filter(c => c.who === id)
  const f = edit ?? p ?? {}
  return (
    <Shell title={p?.name ?? id} close={close} meta={p && <>{[p.team, p.role].filter(Boolean).join('，') || '还没有填角色'}{p.reportsTo ? `，汇报给 ${p.reportsTo}` : ''}{row?.daysSince !== undefined ? `。上次联系是 ${row.daysSince} 天前` : '。还没有互动记录'}</>}>
      {error && <div className="wr-err">{error}</div>}
      {p && <>
        <div className="head" style={{ marginTop: 12 }}>
          <button className="go" onClick={() => ask(`刚和${p.name}`)}>跟接口人说说他</button>
          <button onClick={() => act('prep', `/people/${enc(id)}/prep`, {})}>准备和他的 1:1</button>
          <button className="quiet" onClick={() => setEdit(edit ? undefined : { ...p })}>{edit ? '取消编辑' : '编辑资料与判断'}</button>
        </div>
        {edit ? <div className="wr-form">
          <div className="line">
            <label>角色<input value={f.role ?? ''} onChange={e => setEdit({ ...f, role: e.target.value })} /></label>
            <label>组织<input value={f.organization ?? ''} onChange={e => setEdit({ ...f, organization: e.target.value })} list="wr-organizations" placeholder="未填写则归未分组" /></label>
            <label>团队<input value={f.team ?? ''} onChange={e => setEdit({ ...f, team: e.target.value })} /></label>
            <label>汇报给<input value={f.reportsTo ?? ''} onChange={e => setEdit({ ...f, reportsTo: e.target.value })} list="wr-people" /></label>
          </div>
          <datalist id="wr-organizations">{[...new Set(poc.people.flatMap(x => x.organization ? [x.organization] : []))].map(name => <option key={name} value={name} />)}</datalist>
          <label>标签 / 关系圈<GroupPicker value={f.groups ?? []} all={[...new Set(poc.people.flatMap(x => x.groups ?? []))]} onChange={groups => setEdit({ ...f, groups })} /></label>
          <label>关系<Seg value={f.warmth ?? ''} options={[['warm', '热'], ['neutral', '一般'], ['cold', '冷']]} onChange={v => setEdit({ ...f, warmth: v || undefined })} /></label>
          <label>影响力<Seg value={f.influence ?? ''} options={[['high', '高'], ['mid', '中'], ['low', '低']]} onChange={v => setEdit({ ...f, influence: v || undefined })} /></label>
          <label>对我这摊事的立场<input value={f.stance ?? ''} onChange={e => setEdit({ ...f, stance: e.target.value })} placeholder="例如：支持、观望、有顾虑" /></label>
          <label>画像<textarea rows={4} value={f.profile ?? ''} onChange={e => setEdit({ ...f, profile: e.target.value })} placeholder="他关心什么、怎么沟通有效、要避开什么" /></label>
          <div className="line"><button className="go" onClick={() => act('psave', '/people', { name: id, role: f.role ?? '', team: f.team ?? '', organization: f.organization ?? '', reportsTo: f.reportsTo ?? '', groups: f.groups ?? [], warmth: f.warmth ?? '', influence: f.influence ?? '', stance: f.stance ?? '', profile: f.profile ?? '' }, () => setEdit(undefined))}>保存</button></div>
        </div> : <>
          <dl className="wr-kv">
            <dt>组织</dt><dd>{p.organization || '未分组'}</dd>
            <dt>标签 / 关系圈</dt><dd>{p.groups?.length ? p.groups.join('、') : '还没归组'}</dd>
            <dt>关系</dt><dd>{WARMTH[p.warmth ?? ''] ?? '还没判断'}</dd>
            <dt>影响力</dt><dd>{INFLUENCE[p.influence ?? ''] ?? '还没判断'}</dd>
            {p.stance && <><dt>立场</dt><dd>{p.stance}</dd></>}
            {row?.lines.length ? <><dt>横向线</dt><dd>{row.lines.join('、')}</dd></> : null}
          </dl>
          {p.profile && <><h3>画像</h3><div className="wr-pre">{p.profile}</div></>}
        </>}
        {ledger.length > 0 && <><h3>未结承诺</h3><ul className="wr-list">{ledger.map(c => <li key={c.id}><span className={`wr-tag ${c.direction === 'theirs' ? 'tide' : ''}`}>{c.direction === 'mine' ? '我答应' : '答应我'}</span> {c.what}{c.due ? `，${c.due.slice(5)}` : ''}</li>)}</ul></>}
        <h3>互动</h3>
        {p.log.length ? <ul className="wr-list">{p.log.map((entry, i) => { const [d, t] = splitLog(entry); return <li key={i}><time>{d}</time>{t}</li> })}</ul> : <div className="wr-empty">还没有记录。下次见面后跟接口人说一声。</div>}
        {p.facts.length > 0 && <><h3>事实</h3><ul className="wr-list">{p.facts.map((entry, i) => { const [d, t] = splitLog(entry); return <li key={i}><time>{d}</time>{t}</li> })}</ul></>}
      </>}
    </Shell>
  )
}

export function LineDrawer({ id, poc, run, ask, close, staff, openTicket, read }: { id: string; poc: PocState; run: Run; ask: (text: string) => void; close: () => void; staff: { id: string; name: string; executor?: string }[]; openTicket: (id: string) => void; read: (ticket: string, path: string, version?: string) => void }) {
  const [l, setL] = useState<Line>()
  const [error, setError] = useState<string>()
  const [edit, setEdit] = useState<Partial<Line> & { partnersText?: string }>()
  const load = () => api<Line>(`/lines/${enc(id)}`).then(setL, e => setError((e as Error).message))
  useEffect(() => { void load() }, [id])
  const act = async (key: string, path: string, body: unknown, after?: () => void) => {
    const message = await run(key, path, body)
    setError(message)
    if (!message) { after?.(); await load() }
  }
  const ledger = poc.ledger.filter(c => c.line === id)
  const f = edit ?? { ...l, partnersText: l?.partners.join('、') }
  return (
    <Shell title={l?.name ?? id} close={close} meta={l?.goal ?? '还没有写目标'}>
      {error && <div className="wr-err">{error}</div>}
      {l && <>
        <div className="head" style={{ marginTop: 12 }}><button className="go" onClick={() => ask(`「${l.name}」这条线`)}>跟接口人说说进展</button><button className="quiet" onClick={() => setEdit(edit ? undefined : { ...l, partnersText: l.partners.join('、') })}>{edit ? '取消编辑' : '编辑这条线'}</button></div>
        {edit ? <div className="wr-form">
          <label>目标<input value={f.goal ?? ''} onChange={e => setEdit({ ...f, goal: e.target.value })} /></label>
          <label>合作方（用顿号或逗号分隔人名）<input value={f.partnersText ?? ''} onChange={e => setEdit({ ...f, partnersText: e.target.value })} /></label>
          <label>健康度<Seg value={f.health ?? ''} options={[['green', '顺'], ['yellow', '有风险'], ['red', '出问题']]} onChange={v => setEdit({ ...f, health: v || undefined })} /></label>
          <div className="line">
            <label>当前阻塞<input value={f.blocker ?? ''} onChange={e => setEdit({ ...f, blocker: e.target.value })} placeholder="没有就留空" /></label>
            <label>下次对齐<input type="date" value={f.nextSync ?? ''} onChange={e => setEdit({ ...f, nextSync: e.target.value })} /></label>
          </div>
          <label>背景<textarea rows={3} value={f.background ?? ''} onChange={e => setEdit({ ...f, background: e.target.value })} /></label>
          <div className="line"><button className="go" onClick={() => act('lsave', '/lines', { name: id, goal: f.goal ?? '', partners: (f.partnersText ?? '').split(/[,，、]/).map(s => s.trim()).filter(Boolean), health: f.health ?? '', blocker: f.blocker ?? '', nextSync: f.nextSync ?? '', background: f.background ?? '' }, () => setEdit(undefined))}>保存</button></div>
        </div> : <dl className="wr-kv">
          <dt>健康度</dt><dd><span className={`wr-lamp ${l.health ?? 'none'}`} />{HEALTH[l.health ?? ''] ?? '还没评估'}</dd>
          <dt>合作方</dt><dd>{l.partners.join('、') || '还没有'}</dd>
          <dt>阻塞</dt><dd>{l.blocker ?? '没有'}</dd>
          <dt>下次对齐</dt><dd>{l.nextSync ?? '没定'}</dd>
          {l.background && <><dt>背景</dt><dd>{l.background}</dd></>}
        </dl>}
        {ledger.length > 0 && <><h3>这条线上的未结承诺</h3><ul className="wr-list">{ledger.map(c => <li key={c.id}><span className={`wr-tag ${c.direction === 'theirs' ? 'tide' : ''}`}>{c.direction === 'mine' ? `我答应 ${c.who}` : `${c.who} 答应我`}</span> {c.what}{c.due ? `，${c.due.slice(5)}` : ''}</li>)}</ul></>}
        <Workline id={id} staff={staff} openTicket={openTicket} read={read} />
        <h3>进展</h3>
        {l.log.length ? <ul className="wr-list">{l.log.map((entry, i) => { const [d, t] = splitLog(entry); return <li key={i}><time>{d}</time>{t}</li> })}</ul> : <div className="wr-empty">还没有进展记录。</div>}
      </>}
    </Shell>
  )
}

interface Detail {
  staffNames?: Record<string,string>
  threadId?: string
  ticket: { id: string; title: string; staff: string; requestedExecutor?: string; related?: { ticketId: string; path: string; version?: string }; lineId?: string; parent?: { ticketId: string }; waitingFor?: string[]; remoteBrief?: string; mandate: { scope: string; doneWhen: string[]; level: string; strength: string; needsReview: boolean }
    assignments: { id: string; staff: string; executor: string; round: number; startedAt: string; state: string
      report?: { status: string; summary: string; question?: string; structured: boolean }; verification?: { verdict: string; critique: string } }[]
    inputs: { at: string; from: string; text: string }[]; ended?: { outcome: string; note: string }
    superhub?: { brainScope: string; contracts: { version: number }[] } }
  stage: string
  groups?: { id: string; title: string; stage: string; outcome?: string }[]
  files: { path: string; size: number }[]
  proposal?: { exists: boolean; applyTicket?: string }
}
const LEVEL: Record<string, string> = { think: '只思考和写材料', write: '可以改文件', propose: '需要先批准' }
const FROM: Record<string, string> = { owner: '你', verifier: '审查官', system: '系统' }
const REPORT: Record<string, string> = { ready: '完成', question: '有问题要问', blocked: '受阻', failed: '失败', dropped: '无需处理' }
const VERDICT: Record<string, string> = { pass: '通过', revise: '要求修改', fail: '不通过' }
const hm = (iso: string) => new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function ExecutionPlanForm({ busy, submit }: { busy: boolean; submit: (body: unknown) => Promise<void> }) {
  const [checkpoint, setCheckpoint] = useState('')
  const [groups, setGroups] = useState([{ title: '', scope: '' }])
  const edit = (index: number, field: 'title' | 'scope', value: string) => setGroups(current => current.map((group, i) => i === index ? { ...group, [field]: value } : group))
  return <details className="wr-fold"><summary>分组续跑</summary>
    <form className="wr-ticket-compose" onSubmit={e => { e.preventDefault(); void submit({ checkpoint, groups: groups.map((group, i) => ({ ...group, key: String(i + 1) })) }) }}>
      <label>已有进度<textarea required rows={2} maxLength={6000} value={checkpoint} onChange={e => setCheckpoint(e.target.value)} placeholder="注明已经核对的结果和产物位置" /></label>
      {groups.map((group, i) => <div className="wr-ticket-compose" key={i}>
        <label>分组标题 <input required maxLength={100} value={group.title} onChange={e => edit(i, 'title', e.target.value)} /></label>
        <label>执行范围<textarea required rows={2} maxLength={9000} value={group.scope} onChange={e => edit(i, 'scope', e.target.value)} /></label>
        {groups.length > 1 && <button type="button" onClick={() => setGroups(current => current.filter((_, index) => index !== i))}>移除此组</button>}
      </div>)}
      <div className="row"><button type="button" disabled={groups.length >= 12} onClick={() => setGroups(current => [...current, { title: '', scope: '' }])}>添加分组</button>
        <button type="submit" className="go" disabled={busy}>确认并续跑</button></div>
    </form>
  </details>
}

/** 工单详情：授权、时间线（读执行轨迹）、产出文件。 */
export function TicketDrawer({ id, expectedThreadId, bound, staffName: fallbackName, close, read, open, readSource, inbox, refreshed, openDiscussion, modal = false }: { id: string; modal?: boolean; expectedThreadId?: string; bound: (threadId: string) => void; staffName: (id: string) => string; close: () => void; read: (path?: string) => void; open?: (id: string) => void; readSource?: (id: string, path: string, version?: string) => void; inbox?: () => void; refreshed?: () => void; openDiscussion?: (id: string) => Promise<void> }) {
  const request = useLegacyRequest()
  const [detail, setDetail] = useState<Detail>()
  const staffName = (id: string) => detail?.staffNames?.[id] ?? fallbackName(id)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [remoteBrief, setRemoteBrief] = useState<string>()
  const load = () => request<Detail>(`/tickets/${id}`).then(d => { setDetail(d); setError(undefined) }, e => setError((e as Error).message))
  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await request<Detail>(`/tickets/${id}`)
        if (!current) return
        setDetail(next); setError(undefined)
        if (next.ticket.ended) return
      } catch (e) { if (!current) return; setError((e as Error).message) }
      timer = setTimeout(() => { void poll() }, 3000)
    }
    void poll()
    return () => { current = false; clearTimeout(timer) }
  }, [id,request])
  /** 验收时没执行的提案：补执行。 */
  const target = () => ownerTarget(detail)
  const apply = async () => {
    setBusy(true); setError(undefined)
    try { await request(`/tickets/${id}/apply`, target()); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const act = async (verb: string, body: unknown = {}) => {
    setBusy(true); setError(undefined)
    try { await request(`/tickets/${id}/${verb}`, { ...(body as object), ...target() }); await load(); refreshed?.() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const t = detail?.ticket
  if (expectedThreadId && detail && detail.threadId !== expectedThreadId) return <Shell title={id} close={close} modal={modal}>
    {inbox && <button className="quiet" onClick={inbox}>全部执行记录</button>}
    <p className="wr-note">这条链接属于其他工单记录。请返回全部执行记录重新选择。</p>
  </Shell>
  const steps = t ? [
    ...t.assignments.map(a => ({ at: a.startedAt, node: <li key={a.id}>
      <time>{hm(a.startedAt)}</time><b>{staffName(a.staff)}</b> 第 {a.round + 1} 轮{a.report ? `，${REPORT[a.report.status] ?? a.report.status}` : '，执行中'}
      {a.report && <div>{a.report.summary}{a.report.question ? `\n问：${a.report.question}` : ''}</div>}
      {a.verification && <div style={{ color: 'var(--dim)' }}>审查{VERDICT[a.verification.verdict] ?? ''}：{a.verification.critique}</div>}
    </li> })),
    ...t.inputs.map((input, i) => ({ at: input.at, node: <li key={`i${i}`}><time>{hm(input.at)}</time><b>{FROM[input.from] ?? input.from}</b>：{input.text}</li> })),
  ].sort((a, b) => a.at.localeCompare(b.at)) : []
  return (
    <Shell title={t ? t.title : id} close={close} modal={modal} meta={t && `${t.id}，由${staffName(t.staff)}负责`}>
      {inbox && <button className="quiet" onClick={inbox}>全部执行记录</button>}
      {error && <div className="wr-err">{error}</div>}
      {t && <>
        {openDiscussion && <button className="quiet" onClick={() => { void openDiscussion(id).catch(e => setError((e as Error).message)) }}>打开关联讨论</button>}
        {t.requestedExecutor && <p className="wr-note">指定执行器 <b>{t.requestedExecutor === 'codex' ? 'Codex' : t.requestedExecutor === 'dsh' ? 'DSH 原生' : t.requestedExecutor}</b>。{t.requestedExecutor === 'dsh' ? '超出工作区的命令会另行申请单次权限。' : t.requestedExecutor === 'codex' ? '启用 Codex 单次审批后，命令的权限申请会出现在 SuperHub 顶部。' : '该执行器在自己的沙箱内运行，遇到需要人工提升权限的命令会报告受阻。'}</p>}
        <dl className="wr-kv">
          <dt>状态</dt><dd>{STAGE_LABEL[detail.stage] ?? detail.stage}</dd>
        </dl>
        {detail.groups?.length ? <section aria-label="分组工单"><h3>分组工单</h3><ul className="wr-list">{detail.groups.map(group => <li key={group.id}>
          {open ? <button className="quiet" onClick={() => open(group.id)}>{group.id} · {group.title}</button> : <span>{group.id} · {group.title}</span>}
          <span className="meta"> · {STAGE_LABEL[group.outcome ?? group.stage] ?? group.stage}</span>
        </li>)}</ul></section> : null}
        {detail.stage === 'you/blocked' && t.requestedExecutor === 'codex' && !detail.groups && !t.parent && <ExecutionPlanForm busy={busy} submit={body => act('execution-plan', body)} />}
        <TicketConversation id={id} expectedThreadId={expectedThreadId} bound={bound} staffName={staffName} assignmentStaff={aid => t.assignments.find(a => a.id === aid)?.staff} refreshed={() => { void load(); refreshed?.() }} />
        {!t.ended && <div className="wr-ticket-actions" aria-label="工单决策">
          {detail.stage === 'you/approve' && <button className="go" disabled={busy} onClick={() => act('approve')}>批准</button>}
          {(detail.stage === 'you/review' || detail.stage === 'you/answer') && detail.files.length > 0 && <button onClick={() => read()}>看产出并批注</button>}
          {detail.stage === 'you/review' && detail.proposal?.exists && <button className="go" disabled={busy} onClick={() => act('accept', { applyProposal: true })}>验收并执行</button>}
          {detail.stage === 'you/review' && <button disabled={busy} onClick={() => act('accept')}>{detail.proposal?.exists ? '只验收，不执行' : '验收'}</button>}
          {detail.stage === 'you/blocked' && <button disabled={busy} onClick={() => act('retry')}>重试</button>}
          <button className="quiet stop" disabled={busy} onClick={() => act('stop', { reason: '在执行记录停止' })}>停止</button>
        </div>}
        <details className="wr-fold" open={t.requestedExecutor && detail.stage === 'you/approve' ? true : undefined}><summary>工单范围与授权</summary><dl className="wr-kv">
          <dt>范围</dt><dd>{t.mandate.scope}</dd>
          <dt>完成标准</dt><dd>{t.mandate.doneWhen.map(d => `· ${d}`).join('\n')}</dd>
          <dt>授权</dt><dd>{LEVEL[t.mandate.level]}{t.mandate.strength === 'explicit' ? '，你亲自交办' : '，规则触发'}{t.mandate.needsReview ? '，需要你验收' : ''}</dd>
          {t.ended && <><dt>结果</dt><dd>{t.ended.note}</dd></>}
        </dl></details>
        {t.related && <button onClick={() => readSource?.(t.related!.ticketId, t.related!.path, t.related!.version)}>返回原交付 {t.related.ticketId}</button>}
        {t.lineId && <p className="wr-note">关联横向线：{t.lineId}</p>}
        {t.parent && <button onClick={() => open?.(t.parent!.ticketId)}>返回父工单 {t.parent.ticketId}</button>}
        {t.waitingFor?.map(child => <button className="wr-file" key={child} onClick={() => open?.(child)}>等待子任务 {child}</button>)}
        {!t.ended && <details><summary>给工作端的任务说明</summary><div className="wr-form"><p className="meta">仅此字段可交给工作电脑，不会附带父工单的私人背景。修改不等于重跑或新开工单。</p><textarea aria-label="给工作端的任务说明" rows={3} value={remoteBrief ?? t.remoteBrief ?? ''} onChange={e => setRemoteBrief(e.target.value)} /><button disabled={busy} onClick={async () => { setBusy(true); try { await request(`/tickets/${id}/remote-brief`, { text: remoteBrief ?? t.remoteBrief ?? '', ...target() }); await load(); setError(undefined) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>保存任务说明</button></div></details>}
        {detail.proposal?.exists && t.ended?.outcome === 'done' && (detail.proposal.applyTicket
          ? <div className="wr-note">这份提案已经交给 <a className="wr-file" tabIndex={0} onClick={() => open?.(detail.proposal!.applyTicket!)}>{detail.proposal.applyTicket}</a> 执行。</div>
          : <div className="wr-note">验收时没有执行这份提案，第二大脑没有变化。<div className="row" style={{ marginTop: 8 }}><button className="go" disabled={busy} onClick={apply}>执行提案</button></div></div>)}
        <h3>产出</h3>
        {detail.files.length ? detail.files.map(f => <a key={f.path} className="wr-file" tabIndex={0} onClick={() => read(f.path)} onKeyDown={e => { if (e.key === 'Enter') read(f.path) }}>{f.path.split('/').at(-1)}</a>) : <div className="wr-empty">工作目录还是空的。</div>}
        <details className="wr-fold"><summary>原始派工经过</summary><ul className="wr-list">{steps.map(s => s.node)}</ul></details>
      </>}
    </Shell>
  )
}
