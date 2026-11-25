import type { LineRow, PersonRow } from './api.ts'
import { groupPeople } from './people.ts'

export interface Geo { W: number; H: number; CX: number; CY: number; RX_LINE: number; RY_LINE: number; RX_PERSON: number; RY_PERSON: number }
export const WIDE: Geo = { W: 620, H: 440, CX: 310, CY: 222, RX_LINE: 118, RY_LINE: 82, RX_PERSON: 218, RY_PERSON: 168 }
export const TALL: Geo = { W: 400, H: 560, CX: 200, CY: 280, RX_LINE: 74, RY_LINE: 130, RX_PERSON: 122, RY_PERSON: 236 }
interface Placed<T> { item: T; x: number; y: number; angle: number }
interface Sector { label?: string; members: PersonRow[] }

export function layout(people: PersonRow[], lines: LineRow[], g: Geo = WIDE) {
  const { CX, CY, RX_LINE, RY_LINE, RX_PERSON, RY_PERSON } = g
  const ids = new Set(people.map(p => p.id))
  // 只按明确记录的组织聚集；旧卡和清空组织的卡都进入未分组。
  const sectors: Sector[] = groupPeople(people).map(section => ({ label: section.label, members: section.people }))
  const weight = (s: Sector) => Math.max(1, s.members.length)
  const total = sectors.reduce((n, s) => n + weight(s), 0) || 1
  const placedLines: Placed<LineRow>[] = [], placedPeople: Placed<PersonRow>[] = []
  const placedLabels: { label: string; x: number; y: number }[] = []
  const lineHome = new Map<string, number[]>() // 这条线的成员都在哪些扇区
  const sectorSpan = (i: number) => sectors[i] ? (weight(sectors[i]!) / total) * Math.PI * 2 : Math.PI * 2
  let start = -Math.PI / 2
  sectors.forEach((sector, si) => {
    const span = sectorSpan(si)
    const mid = start + span / 2
    if (sector.label) placedLabels.push({ label: sector.label, x: CX + Math.cos(mid) * ((RX_LINE + RX_PERSON) / 2), y: CY + Math.sin(mid) * ((RY_LINE + RY_PERSON) / 2) })
    sector.members.forEach((person, i) => {
      const angle = start + (span * (i + 0.5)) / sector.members.length
      // 相邻的人交错半径，名字不容易叠在一起
      const k = sector.members.length > 3 && i % 2 ? 0.86 : 1
      placedPeople.push({ item: person, angle, x: CX + Math.cos(angle) * RX_PERSON * k, y: CY + Math.sin(angle) * RY_PERSON * k })
      for (const id of person.lines) lineHome.set(id, [...lineHome.get(id) ?? [], si])
    })
    start += span
  })
  // 菱形跟着成员走：放在成员最多的那个扇区，角取成员角的圆平均；没人挂的线放第一个扇区中央
  for (const [index, line] of lines.entries()) {
    const homes = lineHome.get(line.id) ?? []
    const home = [...new Set(homes)]
    const best = home.length ? home.sort((a, b) => homes.filter(x => x === b).length - homes.filter(x => x === a).length || a - b)[0]! : 0
    const homeIds = new Set(sectors[best]?.members.map(p => p.id) ?? [])
    const members = placedPeople.filter(p => homeIds.has(p.item.id) && p.item.lines.includes(line.id))
    const angle = members.length
      ? Math.atan2(members.reduce((n, p) => n + Math.sin(p.angle), 0) / members.length, members.reduce((n, p) => n + Math.cos(p.angle), 0) / members.length)
      : !sectors.length ? -Math.PI / 2 + index * Math.PI * 2 / Math.max(1, lines.length)
      : -Math.PI / 2 + sectors.slice(0, best).reduce((n, _, i) => n + sectorSpan(i), 0) + sectorSpan(best) / 2
    placedLines.push({ item: line, angle, x: CX + Math.cos(angle) * RX_LINE, y: CY + Math.sin(angle) * RY_LINE })
  }
  return { placedLines, placedPeople, placedLabels, ids }
}
