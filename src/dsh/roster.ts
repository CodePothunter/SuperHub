/**
 * 花名册：人物、横向线、承诺、会议的文件读写。
 *
 *   people/张三.md      头部元数据 + 「画像」「事实」「互动」三节
 *   lines/数据平台.md   头部元数据 + 「背景」「进展」两节
 *   ledger/C-0001.json  一条承诺
 *   meetings/M-0001.json 一场会议
 *
 * 这些目录是受保护的：幕僚不能直接改文件，只能经这里的方法写入，而这里按"事实 / 判断"分开设限
 * （见 src/core/poc.ts）。每次写入都只提交自己改动的文件。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertId, cleanGroups, isDate, isDateTime, validId,
  type Commitment, type Health, type Influence, type Line, type Meeting, type Person, type PersonFacts, type PersonJudgement, type Warmth,
} from '../core/poc.ts'

// ───────────── 带头部元数据和小节的 Markdown ─────────────

interface Doc { meta: Record<string, string>; sections: Map<string, string> }

export function parseDoc(text: string): Doc {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const meta: Record<string, string> = {}
  let body = text
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (match) {
    body = match[2]!
    for (const line of match[1]!.split('\n')) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
      if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '')
    }
  }
  const sections = new Map<string, string>()
  let current: string | undefined
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) { current = heading[1]!; sections.set(current, ''); continue }
    if (current !== undefined) sections.set(current, `${sections.get(current)}${line}\n`)
  }
  for (const [key, value] of sections) sections.set(key, value.trim())
  return { meta, sections }
}

/** 元数据值写成单行：换行会破坏头部格式，也是注入其他字段的途径。 */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()

export function formatDoc(doc: Doc, order: readonly string[]): string {
  const meta = Object.entries(doc.meta).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${oneLine(v)}`)
  const names = [...order, ...[...doc.sections.keys()].filter(name => !order.includes(name))]
  const body = names.map(name => `## ${name}\n${doc.sections.get(name) ?? ''}`.trimEnd()).join('\n\n')
  return `---\n${meta.join('\n')}\n---\n\n${body}\n`
}

const bullets = (text: string | undefined) => (text ?? '').split('\n').map(l => l.replace(/^[-*]\s+/, '').trim()).filter(Boolean)
const toBullets = (items: readonly string[]) => items.map(item => `- ${oneLine(item)}`).join('\n')
const csv = (value: string | undefined) => (value ?? '').split(/[,，]/).map(s => s.trim()).filter(Boolean)
const pick = <T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined =>
  allowed.includes(value as T) ? value as T : undefined

const PERSON_SECTIONS = ['画像', '事实', '互动'] as const
const LINE_SECTIONS = ['背景', '进展'] as const
const MAX_LOG = 200

export interface Committer { commit(message: string, options?: { paths?: string[] }): void }

export class Roster {
  constructor(private readonly root: string, private readonly committer: Committer, private readonly today: () => string) {
    for (const dir of ['people', 'lines', 'ledger', 'meetings']) mkdirSync(join(root, dir), { recursive: true })
  }

  private write(rel: string, content: string, message: string): void {
    const file = join(this.root, rel)
    mkdirSync(join(file, '..'), { recursive: true }) // 目录可能被主人整理时删掉
    writeFileSync(`${file}.tmp`, content)
    renameSync(`${file}.tmp`, file)
    this.committer.commit(message, { paths: [rel] })
  }

  private ids(dir: string, ext: string): string[] {
    if (!existsSync(join(this.root, dir))) return []
    return readdirSync(join(this.root, dir)).filter(n => n.endsWith(ext) && !n.startsWith('.')).map(n => n.slice(0, -ext.length)).sort()
  }

  // ───────────── 人物 ─────────────

  private readPerson(id: string): { doc: Doc; person: Person } | undefined {
    const file = join(this.root, 'people', `${id}.md`)
    if (!validId(id) || !existsSync(file)) return undefined
    const doc = parseDoc(readFileSync(file, 'utf8'))
    const m = doc.meta
    return { doc, person: {
      id, name: m.name || id, facts: bullets(doc.sections.get('事实')), log: bullets(doc.sections.get('互动')),
      ...m.role ? { role: m.role } : {}, ...m.team ? { team: m.team } : {}, ...m.reports_to ? { reportsTo: m.reports_to } : {},
      ...m.organization?.trim() ? { organization: m.organization.trim() } : {},
      ...m.groups && cleanGroups([m.groups]).length ? { groups: cleanGroups([m.groups]) } : {},
      ...pick<Influence>(m.influence, ['high', 'mid', 'low']) ? { influence: m.influence as Influence } : {},
      ...pick<Warmth>(m.warmth, ['warm', 'neutral', 'cold']) ? { warmth: m.warmth as Warmth } : {},
      ...m.stance ? { stance: m.stance } : {}, ...isDate(m.last_contact) ? { lastContact: m.last_contact } : {},
      ...doc.sections.get('画像') ? { profile: doc.sections.get('画像')! } : {},
    } }
  }

  people(): Person[] { return this.ids('people', '.md').flatMap(id => this.readPerson(id)?.person ?? []) }
  person(id: string): Person | undefined { return this.readPerson(id)?.person }

  private savePerson(id: string, doc: Doc, message: string): void {
    this.write(`people/${id}.md`, formatDoc(doc, PERSON_SECTIONS), message)
  }

  /** 取出人物文档；不存在则新建一张只有名字的卡。 */
  private ensurePerson(nameOrId: unknown): { id: string; doc: Doc } {
    const id = assertId(nameOrId, '人物')
    const found = this.readPerson(id)
    return { id, doc: found?.doc ?? { meta: { name: id }, sections: new Map() } }
  }

  /** 记录事实字段（角色、团队、汇报线、组）与一条事实。幕僚与主人都可以调用。groups 整体替换；addGroups / removeGroups 增删。 */
  recordPersonFacts(nameOrId: unknown, facts: PersonFacts & { fact?: string; addGroups?: readonly string[]; removeGroups?: readonly string[] }): string {
    const { id, doc } = this.ensurePerson(nameOrId)
    if (facts.groups !== undefined || facts.addGroups?.length || facts.removeGroups?.length) {
      const current = facts.groups !== undefined ? cleanGroups(facts.groups) : cleanGroups([doc.meta.groups ?? ''])
      const remove = new Set(cleanGroups(facts.removeGroups ?? []))
      const next = cleanGroups([...current, ...facts.addGroups ?? []]).filter(g => !remove.has(g))
      if (next.length) doc.meta.groups = next.join('、'); else delete doc.meta.groups
    }
    if (facts.role !== undefined) doc.meta.role = oneLine(facts.role).slice(0, 80)
    if (facts.team !== undefined) doc.meta.team = oneLine(facts.team).slice(0, 80)
    if (facts.organization !== undefined) {
      const organization = oneLine(facts.organization).slice(0, 80)
      if (organization) doc.meta.organization = organization; else delete doc.meta.organization
    }
    if (facts.reportsTo !== undefined) doc.meta.reports_to = facts.reportsTo ? assertId(facts.reportsTo, '汇报对象') : ''
    if (facts.fact?.trim()) {
      const list = [`${this.today()} ${oneLine(facts.fact).slice(0, 500)}`, ...bullets(doc.sections.get('事实'))].slice(0, MAX_LOG)
      doc.sections.set('事实', toBullets(list))
    }
    this.savePerson(id, doc, `人物：${id} 更新事实`)
    return id
  }

  /** 记一次互动，并更新最近接触日期。 */
  logInteraction(nameOrId: unknown, entry: { date?: string; channel?: string; text: string }): string {
    const text = oneLine(entry.text ?? '')
    if (!text) throw new Error('互动内容不能为空')
    const { id, doc } = this.ensurePerson(nameOrId)
    const date = isDate(entry.date) ? entry.date : this.today()
    const channel = entry.channel ? `[${oneLine(entry.channel).slice(0, 20)}] ` : ''
    const list = [`${date} ${channel}${text.slice(0, 800)}`, ...bullets(doc.sections.get('互动'))].sort((a, b) => b.slice(0, 10).localeCompare(a.slice(0, 10))).slice(0, MAX_LOG)
    doc.sections.set('互动', toBullets(list))
    if (!isDate(doc.meta.last_contact) || date > doc.meta.last_contact) doc.meta.last_contact = date
    this.savePerson(id, doc, `人物：记录与 ${id} 的互动`)
    return id
  }

  /** 判断性字段：只给主人的操作入口调用（作战台接口），幕僚工具不暴露它。 */
  setPersonJudgement(id: string, j: PersonJudgement): void {
    const found = this.readPerson(id)
    if (!found) throw new Error(`没有这个人物：${id}`)
    const { doc } = found
    if (j.influence !== undefined) doc.meta.influence = pick(j.influence, ['high', 'mid', 'low']) ?? ''
    if (j.warmth !== undefined) doc.meta.warmth = pick(j.warmth, ['warm', 'neutral', 'cold']) ?? ''
    if (j.stance !== undefined) doc.meta.stance = oneLine(j.stance).slice(0, 80)
    if (j.profile !== undefined) doc.sections.set('画像', j.profile.trim().slice(0, 4000))
    this.savePerson(id, doc, `人物：${id} 更新判断`)
  }

  // ───────────── 横向线 ─────────────

  private readLine(id: string): { doc: Doc; line: Line } | undefined {
    const file = join(this.root, 'lines', `${id}.md`)
    if (!validId(id) || !existsSync(file)) return undefined
    const doc = parseDoc(readFileSync(file, 'utf8'))
    const m = doc.meta
    return { doc, line: {
      id, name: m.name || id, partners: csv(m.partners), log: bullets(doc.sections.get('进展')),
      ...m.goal ? { goal: m.goal } : {}, ...pick<Health>(m.health, ['green', 'yellow', 'red']) ? { health: m.health as Health } : {},
      ...m.blocker ? { blocker: m.blocker } : {}, ...isDate(m.next_sync) ? { nextSync: m.next_sync } : {},
      ...doc.sections.get('背景') ? { background: doc.sections.get('背景')! } : {},
    } }
  }

  lines(): Line[] { return this.ids('lines', '.md').flatMap(id => this.readLine(id)?.line ?? []) }
  line(id: string): Line | undefined { return this.readLine(id)?.line }

  /** 新建或修改横向线的定义（目标、合作方、健康度、背景）：主人的操作。 */
  upsertLine(nameOrId: unknown, patch: { goal?: string; partners?: string[]; health?: Health | ''; background?: string; blocker?: string; nextSync?: string }): string {
    const id = assertId(nameOrId, '横向线')
    const doc: Doc = this.readLine(id)?.doc ?? { meta: { name: id }, sections: new Map() }
    if (patch.goal !== undefined) doc.meta.goal = oneLine(patch.goal).slice(0, 200)
    if (patch.partners !== undefined) doc.meta.partners = patch.partners.map(p => assertId(p, '合作方')).join(', ')
    if (patch.health !== undefined) doc.meta.health = pick(patch.health, ['green', 'yellow', 'red']) ?? ''
    if (patch.background !== undefined) doc.sections.set('背景', patch.background.trim().slice(0, 4000))
    this.applyLineFacts(doc, patch)
    this.write(`lines/${id}.md`, formatDoc(doc, LINE_SECTIONS), `横向线：${id} 更新`)
    return id
  }

  private applyLineFacts(doc: Doc, facts: { blocker?: string; nextSync?: string }): void {
    if (facts.blocker !== undefined) doc.meta.blocker = oneLine(facts.blocker).slice(0, 200)
    if (facts.nextSync !== undefined) doc.meta.next_sync = isDate(facts.nextSync) ? facts.nextSync : ''
  }

  /** 横向线健康度：判断，只给主人的入口调用。 */
  setLineHealth(id: string, health: unknown): void {
    const found = this.readLine(id)
    if (!found) throw new Error(`没有这条横向线：${id}`)
    found.doc.meta.health = pick(typeof health === 'string' ? health : '', ['green', 'yellow', 'red']) ?? ''
    this.write(`lines/${id}.md`, formatDoc(found.doc, LINE_SECTIONS), `横向线：${id} 更新健康度`)
  }

  /** 记一条进展，可同时更新阻塞与下次对齐日期（事实）。幕僚与主人都可以调用；横向线必须已存在。 */
  logLine(id: string, entry: { text?: string; blocker?: string; nextSync?: string }): void {
    const found = this.readLine(id)
    if (!found) throw new Error(`没有这条横向线：${id}。横向线由主人创建。`)
    const { doc } = found
    const text = oneLine(entry.text ?? '')
    if (text) doc.sections.set('进展', toBullets([`${this.today()} ${text.slice(0, 800)}`, ...bullets(doc.sections.get('进展'))].slice(0, MAX_LOG)))
    this.applyLineFacts(doc, entry)
    this.write(`lines/${id}.md`, formatDoc(doc, LINE_SECTIONS), `横向线：${id} 记录进展`)
  }

  // ───────────── 承诺与会议（JSON） ─────────────

  private readJson<T>(dir: string, id: string): T | undefined {
    try { return JSON.parse(readFileSync(join(this.root, dir, `${id}.json`), 'utf8')) as T } catch { return undefined }
  }

  private nextId(dir: string, prefix: string): string {
    const max = this.ids(dir, '.json').reduce((n, id) => Math.max(n, Number(id.slice(prefix.length + 1)) || 0), 0)
    return `${prefix}-${String(max + 1).padStart(4, '0')}`
  }

  ledger(): Commitment[] { return this.ids('ledger', '.json').flatMap(id => this.readJson<Commitment>('ledger', id) ?? []) }

  addCommitment(input: { direction?: unknown; who?: unknown; what?: unknown; due?: unknown; line?: unknown }): Commitment {
    const what = typeof input.what === 'string' ? oneLine(input.what).slice(0, 300) : ''
    const who = typeof input.who === 'string' ? oneLine(input.who).slice(0, 40) : ''
    if (!what || !who) throw new Error('承诺需要写明对方是谁、答应了什么')
    if (input.direction !== 'mine' && input.direction !== 'theirs') throw new Error('方向只能是 mine（我答应别人）或 theirs（别人答应我）')
    const commitment: Commitment = {
      id: this.nextId('ledger', 'C'), direction: input.direction, who, what, status: 'open', createdAt: new Date().toISOString(),
      ...isDate(input.due) ? { due: input.due } : {}, ...validId(input.line) ? { line: input.line } : {},
    }
    this.write(`ledger/${commitment.id}.json`, `${JSON.stringify(commitment, null, 2)}\n`, `承诺：${commitment.direction === 'mine' ? '我答应' : ''}${who}${commitment.direction === 'theirs' ? ' 答应我' : ''}「${what.slice(0, 30)}」`)
    return commitment
  }

  updateCommitment(id: string, patch: { status?: unknown; due?: unknown }): Commitment {
    const commitment = /^C-\d+$/.test(id) ? this.readJson<Commitment>('ledger', id) : undefined
    if (!commitment) throw new Error(`没有这条承诺：${id}`)
    if (patch.status === 'open' || patch.status === 'done' || patch.status === 'dropped') {
      commitment.status = patch.status
      if (patch.status === 'open') delete commitment.closedAt
      else commitment.closedAt = new Date().toISOString()
    }
    if (patch.due !== undefined) { if (isDate(patch.due)) commitment.due = patch.due; else delete commitment.due }
    this.write(`ledger/${id}.json`, `${JSON.stringify(commitment, null, 2)}\n`, `承诺：${id} ${commitment.status}`)
    return commitment
  }

  meetings(): Meeting[] { return this.ids('meetings', '.json').flatMap(id => this.readJson<Meeting>('meetings', id) ?? []) }
  meeting(id: string): Meeting | undefined { return /^M-\d+$/.test(id) ? this.readJson<Meeting>('meetings', id) : undefined }

  addMeeting(input: { title?: unknown; at?: unknown; with?: unknown; line?: unknown }): Meeting {
    const title = typeof input.title === 'string' ? oneLine(input.title).slice(0, 80) : ''
    if (!title || !isDateTime(input.at)) throw new Error('会议需要标题和时间（YYYY-MM-DDTHH:MM）')
    const people = Array.isArray(input.with) ? input.with.filter(validId).slice(0, 20) : []
    const meeting: Meeting = {
      id: this.nextId('meetings', 'M'), title, at: input.at, with: people, createdAt: new Date().toISOString(),
      ...validId(input.line) ? { line: input.line } : {},
    }
    this.write(`meetings/${meeting.id}.json`, `${JSON.stringify(meeting, null, 2)}\n`, `会议：${title}（${meeting.at}）`)
    return meeting
  }

  setMeetingNotes(id: string, notes: string): Meeting {
    const meeting = this.meeting(id)
    if (!meeting) throw new Error(`没有这场会议：${id}`)
    meeting.notes = notes.trim().slice(0, 20_000)
    this.write(`meetings/${id}.json`, `${JSON.stringify(meeting, null, 2)}\n`, `会议：${meeting.title} 纪要`)
    return meeting
  }
}
