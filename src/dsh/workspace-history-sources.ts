import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isLegacyAssistantImport } from './workspace-history-store.ts'
import { validId, type Commitment } from '../core/poc.ts'
import { currentGoal, SUPERHUB_GOALS_FILE } from '../core/superhub-goals.ts'
import { historyItemId, type HistoryDetail, type HistoryItem, type HistoryKind } from '../core/workspace-history.ts'
import type { V2Attachment } from '../core/workspace-v2.ts'
import type { BrainRepo } from './brain.ts'
import { roomSessionId, type NativeRooms } from './rooms.ts'
import type { Roster } from './roster.ts'
import { templatesDir } from './scaffold.ts'
import type { SuperhubGoals } from './superhub-goals.ts'

type Detail = Omit<HistoryDetail, 'scope' | 'item'>
type Material = Partial<Detail>
export interface HistorySource {
  item: HistoryItem
  detail(): Promise<Material> | Material
  attachment?(id: string): V2Attachment | undefined
}
export interface HistoryDependencies {
  brain: BrainRepo
  rooms: Pick<NativeRooms, 'list' | 'meta' | 'view'> & Partial<Pick<NativeRooms,'knownPortraits'>>
  roster: Pick<Roster, 'person' | 'line' | 'meeting'>
  goals: Pick<SuperhubGoals, 'list'>
  scope: string
}

const textLimit = 512 * 1024
const documentExtension = /\.(md|markdown|txt)$/i
const joinText = (parts: (string | undefined)[], delimiter = '\n\n') => parts.filter(Boolean).join(delimiter)
const field = (label: string, value: string | undefined) => value && label + '　' + value
const notes = (label: string, rows: string[]) => rows.length ? '## ' + label + '\n\n' + rows.map(s => '- ' + s).join('\n') : ''
const sum = (content: string) => createHash('sha256').update(content).digest('hex')
const textFormat = (path: string): V2Attachment['format'] => /\.html?$/i.test(path) ? 'html' : /\.(md|markdown)$/i.test(path) ? 'markdown' : 'text'
const issue = (message: string) => ({ issue: message })

/** Every discovery starts at an allowlisted directory. Reject redirected files and directory ancestors. */
function inside(root: string, path: string) {
  const rel = relative(root, path)
  return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}
function local(root: string, path: string) {
  const full = resolve(root, path)
  try { if (inside(root, full) && realpathSync(full) === full) return full } catch { /* removed or unavailable */ }
}
function entries(root: string, dir: string) {
  const full = local(root, dir)
  if (!full || !statSync(full).isDirectory()) return []
  return readdirSync(full, { withFileTypes: true }).filter(e => !e.name.startsWith('.') && !e.isSymbolicLink()).sort((a,b) => a.name.localeCompare(b.name))
}
function readText(root: string, path: string) {
  const full = local(root, path)
  if (!full) return
  const st = statSync(full)
  if (!st.isFile() || st.size > textLimit) return
  const bytes = readFileSync(full)
  const content = bytes.toString('utf8')
  if (bytes.length <= textLimit && !content.includes('\0') && bytes.equals(Buffer.from(content))) return content
}

function item(kind: HistoryKind, sourceId: string, title: string, subtitle?: string, at?: string): HistoryItem {
  return { kind, sourceId, id: historyItemId(kind, sourceId), title, subtitle, at }
}
const linked = (kind: HistoryKind, sourceId: string, label = sourceId) => ({ id: historyItemId(kind, sourceId), label })

function discussionSources({brain, rooms}: HistoryDependencies): HistorySource[] {
  const staff = new Map(brain.staff().map(s => [s.id, s.name]))
  const sources: HistorySource[] = []
  for (const room of rooms.list()) {
    const meta = rooms.meta(room.id)
    sources.push({
      item: item('room', room.id, room.title, '团队群聊', meta.notes.at(-1)?.at),
      async detail() {
        const latest = new Map(meta.notes.map(n => [n.id,n]))
        const body = notes('讨论笔记', [...latest.values()].map(n => n.text))
        if (room.session !== roomSessionId(brain.root,room.id)) return { body, issue:'旧群聊的原生会话与当前第二大脑的绑定不匹配。' }
        try {
          const view = await rooms.view(room.id)
          const messages = view.messages.filter(m => m.kind === 'message' || m.publicReply).map(m => ({
            id: m.id, author: m.author === 'you' ? '我' : m.author === 'lead' ? '接口人' : staff.get(m.author) ?? m.author,
            at: new Date(m.time).toISOString(), text: m.text, replyTo: m.replyTo, ...(m.speakerId && {speakerId: m.speakerId}),
          }))
          return { body, messages, ...(view.portraits && {portraits:view.portraits}) }
        } catch { return { body, issue: '原生群聊的公开发言暂时不可读，可稍后再打开。' } }
      },
    })
  }
  return sources
}

function rosterIds(root: string, dir: string, ext: string) {
  return entries(root,dir).filter(e => e.isFile() && e.name.endsWith(ext))
    .map(e => e.name.slice(0, -ext.length)).filter(validId)
}

export function currentPeopleSources(deps: HistoryDependencies, root = realpathSync(deps.brain.root), onlyItemId?: string): HistorySource[] {
  const people: HistorySource[] = []
  for (const id of rosterIds(root,'people','.md')) {
    if (onlyItemId && historyItemId('person',id) !== onlyItemId) continue
    const p = deps.roster.person(id)
    if (!p) continue
    const influence = p.influence && {high:'高',mid:'中',low:'低'}[p.influence]
    const warmth = p.warmth && {warm:'熟络',neutral:'一般',cold:'疏远'}[p.warmth]
    const row = item('person', id, p.name, p.role, p.lastContact)
    row.person = { organization:p.organization, team:p.team, role:p.role, influence:p.influence, groups:p.groups }
    people.push({ item: row, detail: () => ({
      body: joinText([field('组织',p.organization),field('团队',p.team),field('角色',p.role),field('重要性',influence),
        field('关系',p.groups?.join('、')),field('关系温度',warmth),field('立场',p.stance),p.profile,notes('事实',p.facts),notes('互动',p.log)]),
      links: p.reportsTo ? [linked('person',p.reportsTo,'汇报给 ' + p.reportsTo)] : [],
    }) })
  }
  return people
}

function rosterSources(deps: HistoryDependencies, root: string): HistorySource[] {
  const sources = currentPeopleSources(deps,root)
  function push(row: HistoryItem, body: string, links: Detail['links'] = []) {
    sources.push({ item: row, detail: () => ({ body, links }) })
  }
  for (const id of rosterIds(root,'lines','.md')) {
    const l = deps.roster.line(id)
    if (!l) continue
    push(item('line',id,l.name,l.goal,l.nextSync),joinText([l.goal,l.background,field('阻碍',l.blocker),field('下次对齐',l.nextSync),notes('进展',l.log)]),
      l.partners.map(p => linked('person',p)))
  }
  for (const id of rosterIds(root,'ledger','.json')) {
    const raw = readText(root,join('ledger',id + '.json'))
    if (!raw) continue
    let c: Commitment
    try { c = JSON.parse(raw) as Commitment } catch { continue }
    if (c?.id !== id || typeof c.what !== 'string' || typeof c.who !== 'string') continue
    const direction = c.direction === 'mine' ? '我答应' + c.who : c.who + '答应我'
    const status = {open:'进行中',done:'已履行',dropped:'已撤销'}[c.status]
    push(item('commitment',id,c.what,joinText([direction,status],' · '),c.closedAt ?? c.createdAt),
      joinText([direction,c.what,field('状态',status),field('约定日期',c.due),field('完成时间',c.closedAt)]),
      [linked('person',c.who), ...(c.line ? [linked('line',c.line)] : [])])
  }
  for (const id of rosterIds(root,'meetings','.json')) {
    const m = deps.roster.meeting(id)
    if (m?.id !== id) continue
    push(item('meeting',id,m.title,m.at,m.at),joinText([field('时间',m.at),field('参与人',m.with.join('、')),m.notes]),
      [...m.with.map(p => linked('person',p)), ...(m.line ? [linked('line',m.line)] : [])])
  }
  if (local(root, SUPERHUB_GOALS_FILE)) for (const goal of deps.goals.list()) {
    const g = currentGoal(goal)
    const status = {draft:'草稿',active:'进行中',paused:'暂停',achieved:'已达成',archived:'已归档'}[g.status]
    push(item('goal',goal.id,g.name,joinText([status,g.owner],' · '),g.at),
      joinText([g.description,field('负责人',g.owner),field('时间范围',g.horizon),notes('验收标准',g.criteria.map(c => c.text)),g.assessment?.note]),
      [...g.relations.map(r => linked('goal',r.target)), ...(g.parent ? [linked('goal',g.parent)] : [])])
  }
  return sources
}

const rootDocuments = ['me.md','goals.md','proposal.md','AGENTS.md','README.md']
const documentFolders = ['inbox','journal','notes','decisions','proposals']
const ignoredFolders = new Set(['node_modules','vendor','dist','build','coverage','cache','__pycache__','raw','logs'])
const templates = new Map<string,string>()
function isStock(path: string, content: string) {
  if (!rootDocuments.includes(path)) return false
  if (!templates.has(path)) templates.set(path, readText(realpathSync(templatesDir()), join('brain',path)) ?? '')
  return templates.get(path) === content
}
function markdownFiles(root: string, dir: string, recurse: boolean): string[] {
  return entries(root,dir).flatMap(entry => {
    const path = join(dir,entry.name)
    if (entry.isFile() && documentExtension.test(entry.name)) return [path]
    if (entry.isDirectory() && recurse && !ignoredFolders.has(entry.name)) return markdownFiles(root,path,true)
    return []
  })
}
const heading = (content: string, fallback: string) => /^#\s+(.+?)\s*$/m.exec(content)?.[1]?.slice(0,200) ?? fallback

function fileSources(root: string): HistorySource[] {
  const sources: HistorySource[] = []
  const paths = [...rootDocuments,...documentFolders.flatMap(dir => markdownFiles(root,dir,true))]
  for (const path of paths) {
    const content = readText(root,path)
    if (!content?.trim() || isStock(path,content)) continue
    const title = heading(content,basename(path,extname(path)))
    if (isLegacyAssistantImport(path, title)) continue
    sources.push({ item: item('document',path,title,path,statSync(join(root,path)).mtime.toISOString()),
      detail: () => ({ body: content }) })
  }
  for (const entry of entries(root,'projects')) {
    if (!entry.isDirectory() || ignoredFolders.has(entry.name)) continue
    const dir = join('projects',entry.name)
    const files = [...markdownFiles(root,dir,false),...markdownFiles(root,join(dir,'docs'),true)]
    const docs = files.flatMap(path => {
      const content = readText(root,path)
      return content === undefined ? [] : [{ path, content, id: sum(path), label: relative(dir,path) }]
    })
    const readme = docs.find(d => /^readme\.(md|markdown|txt)$/i.test(d.label))
    sources.push({ item: item('project',entry.name,readme ? heading(readme.content,entry.name) : entry.name,dir),
      detail: () => ({ body: readme?.content, attachments: docs.map(({id,label}) => ({id,label})),
        ...!docs.length ? issue('原项目没有可预览的说明文档。') : {} }),
      attachment(id) {
        const d = docs.find(d => d.id === id)
        if (d) return { id, label: d.label, format: textFormat(d.path), content: d.content }
      },
    })
  }
  return sources
}

export function historySources(deps: HistoryDependencies) {
  const root = realpathSync(deps.brain.root)
  const sources = [...discussionSources(deps),...rosterSources(deps,root),...fileSources(root)]
  return new Map(sources.map(source => [source.item.id,source]))
}
