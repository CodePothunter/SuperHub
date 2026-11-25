/**
 * 态势图：主人在中心，横向线在内圈，人物在外圈。
 *
 * 读法：
 *   菱形  横向线，颜色是健康度（绿 / 黄 / 红；空心表示还没评估）
 *   圆点  人物，大小是影响力；实心深色是关系热，灰是一般，蓝色空心是冷，虚线是还不了解
 *   黄环  这个人身上有到期或逾期的承诺
 *   虚线  汇报关系
 *   浅色小字（内外圈之间）组名
 * 布局是确定性的：扇区按组织划分；没有明确组织归属的人放进未分组，关系标签不改变主归属。
 * 扇区大小按人数分配。横向线的菱形跟着成员走：放在成员最多的那个扇区里。
 */
import { useEffect, useState } from 'react'
import type { LineRow, PersonRow } from './api.ts'
import { layout, TALL, WIDE } from './map-layout.ts'

/** 宽屏用横向椭圆；窄屏换成竖向，名字才放得下。 */
const LAMP: Record<string, string> = { green: 'var(--lamp-g)', yellow: 'var(--lamp-y)', red: 'var(--lamp-r)' }
const RADIUS: Record<string, number> = { high: 10, mid: 7.5, low: 5.5 }

function PersonGlyph({ p, x, y }: { p: PersonRow; x: number; y: number }) {
  const r = RADIUS[p.influence ?? ''] ?? 6.5
  const look = p.warmth === 'warm' ? { fill: 'var(--paper)', stroke: 'var(--paper)' }
    : p.warmth === 'neutral' ? { fill: 'var(--faint)', stroke: 'var(--faint)' }
    : p.warmth === 'cold' ? { fill: 'var(--bg)', stroke: 'var(--tide)' }
    : { fill: 'var(--bg)', stroke: 'var(--faint)', strokeDasharray: '2.5 2.5' }
  return <>
    {p.due > 0 && <circle className="ring" cx={x} cy={y} r={r + 5} />}
    <circle cx={x} cy={y} r={r} strokeWidth={1.6} {...look} />
  </>
}

export function SituationMap({ people, lines, openPerson, openLine }: { people: PersonRow[]; lines: LineRow[]; openPerson: (id: string) => void; openLine: (id: string) => void }) {
  const [tall, setTall] = useState(() => typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches)
  useEffect(() => {
    const query = matchMedia('(max-width: 640px)')
    const onChange = () => setTall(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  const g = tall ? TALL : WIDE
  const { W, H, CX, CY, RX_LINE, RY_LINE, RX_PERSON, RY_PERSON } = g
  const { placedLines, placedPeople, placedLabels } = layout(people, lines, g)
  const at = new Map(placedPeople.map(p => [p.item.id, p]))
  const lineAt = new Map(placedLines.map(l => [l.item.id, l]))
  const key = (fn: () => void) => (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } }
  return (
    <div className="wr-map">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`态势图：${lines.length} 条横向线，${people.length} 位干系人`}>
        {/* 经纬线 */}
        <ellipse className="grat" cx={CX} cy={CY} rx={RX_LINE} ry={RY_LINE} />
        <ellipse className="grat" cx={CX} cy={CY} rx={RX_PERSON} ry={RY_PERSON} strokeDasharray="1 5" />
        {[0, 1, 2, 3, 4, 5].map(i => {
          const a = (i * Math.PI) / 3
          return <line key={i} className="grat" strokeOpacity={0.45} x1={CX + Math.cos(a) * 26} y1={CY + Math.sin(a) * 18} x2={CX + Math.cos(a) * (RX_PERSON + (tall ? 20 : 40))} y2={CY + Math.sin(a) * (RY_PERSON + 26)} />
        })}
        {/* 连线 */}
        {placedLines.map(l => <line key={`c${l.item.id}`} x1={CX} y1={CY} x2={l.x} y2={l.y} stroke={LAMP[l.item.health ?? ''] ?? 'var(--faint)'} strokeOpacity={0.55} strokeWidth={1.5} />)}
        {placedPeople.flatMap(p => p.item.lines.map(id => {
          const l = lineAt.get(id)
          return l ? <line key={`${p.item.id}-${id}`} x1={l.x} y1={l.y} x2={p.x} y2={p.y} stroke="var(--rule)" strokeWidth={1.2} /> : null
        }))}
        {placedPeople.map(p => {
          const boss = p.item.reportsTo ? at.get(p.item.reportsTo) : undefined
          return boss ? <line key={`r${p.item.id}`} x1={p.x} y1={p.y} x2={boss.x} y2={boss.y} stroke="var(--dim)" strokeOpacity={0.6} strokeWidth={1} strokeDasharray="3 4" /> : null
        })}
        {/* 中心：我 */}
        <circle cx={CX} cy={CY} r={17} fill="var(--ink)" />
        <text x={CX} y={CY + 4.5} textAnchor="middle" style={{ fill: 'var(--on-ink)', fontWeight: 600, fontSize: 13 }}>我</text>
        {/* 组名 */}
        {placedLabels.map((l, i) => <text key={`g${i}`} className="sub grp" x={l.x} y={l.y + 4} textAnchor="middle">{l.label}</text>)}
        {/* 横向线 */}
        {placedLines.map(l => {
          const color = LAMP[l.item.health ?? '']
          const below = Math.sin(l.angle) >= 0
          return (
            <g key={l.item.id} className="hit" tabIndex={0} role="button" aria-label={`横向线 ${l.item.name}`} onClick={() => openLine(l.item.id)} onKeyDown={key(() => openLine(l.item.id))}>
              <rect x={l.x - 7} y={l.y - 7} width={14} height={14} rx={2} transform={`rotate(45 ${l.x} ${l.y})`} fill={color ?? 'var(--bg)'} stroke={color ?? 'var(--faint)'} strokeWidth={1.5} />
              <text x={l.x} y={l.y + (below ? 26 : -16)} textAnchor="middle" style={{ fontWeight: 600 }}>{l.item.name}</text>
              {l.item.blocker && <text className="sub" x={l.x} y={l.y + (below ? 40 : -30)} textAnchor="middle" style={{ fill: 'var(--lamp-r)' }}>受阻</text>}
            </g>
          )
        })}
        {/* 人物 */}
        {placedPeople.map(p => {
          const right = Math.cos(p.angle) >= 0
          const dx = right ? 15 : -15
          return (
            <g key={p.item.id} className="hit" tabIndex={0} role="button" aria-label={`人物 ${p.item.name}`} onClick={() => openPerson(p.item.id)} onKeyDown={key(() => openPerson(p.item.id))}>
              <circle cx={p.x} cy={p.y} r={18} fill="transparent" />
              <PersonGlyph p={p.item} x={p.x} y={p.y} />
              <text x={p.x + dx} y={p.y + 1} textAnchor={right ? 'start' : 'end'}>{p.item.name}</text>
              {(p.item.role || p.item.team) && <text className="sub" x={p.x + dx} y={p.y + 14} textAnchor={right ? 'start' : 'end'}>{(p.item.role ?? p.item.team ?? '').slice(0, 10)}</text>}
            </g>
          )
        })}
        {!people.length && !lines.length && <text x={CX} y={CY + 52} textAnchor="middle" className="sub" style={{ fontSize: 13 }}>添加第一条横向线或第一位干系人，图就会展开</text>}
      </svg>
      <div className="wr-legend">
        <span><svg viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" rx="1.5" transform="rotate(45 7 7)" fill="var(--lamp-g)" /></svg>横向线，颜色是健康度</span>
        <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--paper)" /></svg>关系热</span>
        <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="var(--faint)" /></svg>一般</span>
        <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="var(--tide)" strokeWidth="1.6" /></svg>冷</span>
        <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="var(--faint)" strokeWidth="1.6" strokeDasharray="2.5 2.5" /></svg>还不了解</span>
        <span><svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--lamp-y)" strokeWidth="2" /></svg>有承诺到期</span>
        <span>圆点越大，影响力越高</span>
        <span>浅色小字是组织；无组织归属的在未分组</span>
      </div>
    </div>
  )
}
