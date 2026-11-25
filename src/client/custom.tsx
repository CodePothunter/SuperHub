/**
 * 界面定制层在页面上的应用：主题变成 CSS 变量，版式决定页签和区块的顺序与显隐，自定义面板在台面上渲染。
 * 定制随 /state 下发（见 src/core/custom.ts），每次轮询都会拿到最新的，不用刷新页面。
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { SECTION_IDS, TAB_IDS, type BoardTab, type Custom, type Panel, type TabId } from '../core/custom.ts'
import { api, type PocState, type WarroomState } from './api.ts'
import { Markdown } from './markdown.tsx'

const RADIUS = { square: ['4px', '6px', '8px'], normal: undefined, round: ['12px', '18px', '24px'] } as const

/** 主题 → 根节点的内联样式（只设 CSS 变量和缩放，值已在服务端校验过）。 */
export function themeStyle(custom: Custom | undefined): CSSProperties {
  const t = custom?.theme
  if (!t) return {}
  const vars: Record<string, string> = {}
  if (t.accent) { vars['--ink'] = t.accent; vars['--on-ink'] = '#fff' }
  if (t.warn) { vars['--amber'] = t.warn; vars['--amber-bg'] = `${t.warn}1f` }
  const r = t.radius ? RADIUS[t.radius] : undefined
  if (r) { vars['--r-s'] = r[0]; vars['--r-m'] = r[1]; vars['--r-l'] = r[2] }
  return { ...vars, ...t.scale && t.scale !== 1 ? { zoom: t.scale } : {} } as CSSProperties
}

export const densityClass = (custom: Custom | undefined) => custom?.theme.density && custom.theme.density !== 'normal' ? `d-${custom.theme.density}` : ''

export const isHidden = (custom: Custom | undefined, id: string) => custom?.layout.hidden?.includes(id) ?? false

/** 页签顺序：定制里写了的在前，其余按默认顺序；隐藏的去掉（接口人永远在）。 */
export function tabOrder(custom: Custom | undefined): TabId[] {
  const first = custom?.layout.tabs ?? []
  return [...first, ...TAB_IDS.filter(t => !first.includes(t))].filter(t => t === 'chat' || !isHidden(custom, t))
}

/** 一个页签里区块和面板的顺序（已去掉隐藏的）。 */
export function sectionOrder(custom: Custom | undefined, tab: BoardTab): string[] {
  const builtin = SECTION_IDS[tab] as readonly string[]
  const panels = (custom?.panels ?? []).filter(p => p.tab === tab).map(p => p.id)
  const first = custom?.layout.sections?.[tab] ?? []
  return [...first, ...builtin.filter(x => !first.includes(x)), ...panels.filter(x => !first.includes(x))].filter(x => !isHidden(custom, x))
}

// ───────────── 自定义面板 ─────────────

type Row = { key: string; title: string; note?: string; open?: { kind: 'person' | 'line' | 'ticket'; id: string } }

function rowsFor(panel: Extract<Panel, { kind: 'records' }>, state: WarroomState, poc: PocState): Row[] {
  const match = (row: Record<string, unknown>) => Object.entries(panel.where).every(([k, v]) => row[k] === v)
  let rows: Row[] = []
  if (panel.of === 'people') rows = poc.people.filter(p => match({ ...p, group: typeof panel.where.group === 'string' && p.groups?.includes(panel.where.group) ? panel.where.group : undefined } as Record<string, unknown>)).map(p => ({ key: p.id, title: p.name, note: [p.team, p.role].filter(Boolean).join('，'), open: { kind: 'person', id: p.id } }))
  if (panel.of === 'lines') rows = poc.lines.filter(l => match({ ...l, blocked: Boolean(l.blocker) })).map(l => ({ key: l.id, title: l.name, note: l.blocker ? `受阻：${l.blocker}` : l.goal ?? '', open: { kind: 'line', id: l.id } }))
  if (panel.of === 'ledger') rows = [...poc.ledger, ...poc.closed].filter(c => match(c as unknown as Record<string, unknown>)).map(c => ({ key: c.id, title: c.what, note: `${c.direction === 'mine' ? '我答应' : '答应我'} ${c.who}${c.due ? `，${c.due}` : ''}` }))
  if (panel.of === 'meetings') rows = poc.meetings.filter(m => match(m as unknown as Record<string, unknown>)).map(m => ({ key: m.id, title: m.title, note: `${m.at.replace('T', ' ')}${m.with.length ? `，${m.with.join('、')}` : ''}` }))
  if (panel.of === 'tickets') rows = [...state.you, ...state.active, ...state.queued, ...state.ended].filter(c => match(c as unknown as Record<string, unknown>)).map(c => ({ key: c.id, title: c.title, note: c.id, open: { kind: 'ticket', id: c.id } }))
  return rows.slice(0, panel.limit)
}

function MarkdownPanel({ path, rev }: { path: string; rev: number }) {
  const [text, setText] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let live = true
    const load = () => api<{ content: string }>(`/file?path=${encodeURIComponent(path)}`).then(r => { if (live) { setText(r.content); setError(undefined) } }, e => { if (live) setError((e as Error).message) })
    void load()
    const t = setInterval(load, 60_000)
    return () => { live = false; clearInterval(t) }
  }, [path, rev])
  if (error) return <div className="wr-empty">打不开 {path}：{error}</div>
  if (text === undefined) return <div className="wr-empty">正在读取</div>
  return <div className="wr-panel-md"><Markdown text={text} /></div>
}

export function PanelView({ panel, state, poc, custom, open }: { panel: Panel; state: WarroomState; poc: PocState; custom: Custom; open: (o: { kind: 'person' | 'line' | 'ticket'; id: string }) => void }): ReactNode {
  if (panel.kind === 'markdown') return <section className="wr-sec wr-panel" data-tab={panel.tab}><h2>{panel.title}</h2><MarkdownPanel path={panel.path} rev={custom.rev} /></section>
  const rows = rowsFor(panel, state, poc)
  return <section className="wr-sec wr-panel" data-tab={panel.tab}>
    <h2>{panel.title}<span className="n">{rows.length}</span></h2>
    {rows.length ? <div className="wr-rows">{rows.map(r => <div key={r.key} className={`wr-row ${r.open ? 'tap' : ''}`} {...r.open ? { role: 'button', tabIndex: 0, onClick: () => open(r.open!), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') open(r.open!) } } : {}}>
      <span className="lead" /><div className="main"><b>{r.title}</b>{r.note && <div className="note">{r.note}</div>}</div>
    </div>)}</div> : <div className="wr-empty">没有符合条件的记录。</div>}
  </section>
}
