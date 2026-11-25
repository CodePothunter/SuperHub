import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SECRET } from '../core/export.ts'
import { validId } from '../core/poc.ts'
import type { ProfileImportItem, ProfileImportTarget, ProfileSavedItem, ProfileTargetVersion } from '../core/profile-import.ts'
import { currentGoal, SUPERHUB_GOALS_FILE, type GoalCandidate, type GoalVersion } from '../core/superhub-goals.ts'
import { profileDirectory, readProfileFile, writeProfileFile } from './profile-import-files.ts'
import { formatDoc, parseDoc } from './roster.ts'
import { workspaceError, workspaceFingerprint, type SuperhubGoals } from './superhub-goals.ts'

const SECTIONS = {
  identity: ['me.md', '身份与背景', '关于我'],
  stage: ['me.md', '当前阶段', '关于我'],
  preferences: ['me.md', '偏好', '关于我'],
  collaboration: ['AGENTS.md', '我希望幕僚团怎样帮我', '协作约定'],
  principles: ['AGENTS.md', '原则', '协作约定'],
} as const

const SECRET_MARKER = /\[机密\]|【机密】|［机密］/
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const BLANK_OR_TEMPLATE = /^(?:\s*$|（(?:例[：:]|待定|每周))/
const CONFIDENTIAL = ' [机密]'
const markdownText = (text: string) => text.replace(/<(?=[!/?A-Za-z])/g, '&lt;')
const readableText = (text: string) => text.replaceAll('&lt;', '<')

export type ProfileCandidate = Omit<ProfileImportItem, 'targets'>
type Doc = ReturnType<typeof readProfileFile>
interface Entry { id: string; text: string; start: number; end: number; prefix: string }
interface Section { entry: Entry[]; at: number; current?: string; append: boolean; found: boolean }
interface FileTarget {
  kind: 'file'
  view: ProfileImportTarget
  label: string
  path?: string
  doc: Doc
  section: Section
  heading: string
  entry?: Entry
  subject?: string
}
interface GoalTarget {
  kind: 'goal'
  view: ProfileImportTarget
  id?: string
  current?: GoalVersion
  candidate?: GoalCandidate
}
type Target = FileTarget | GoalTarget
export type ProfileWrite =
  | {kind: 'recorded'; saved: ProfileSavedItem}
  | {kind: 'goal'; id?: string; args: Record<string, unknown>; text: string}
  | {kind: 'file'; path: string; before: ProfileTargetVersion; after: string; start: number; end: number; insert: string; saved: ProfileSavedItem}

export const profileText = (value: string) => value.trim().replace(/[ \t]*(?:\r\n|[\r\n\u0085\u2028\u2029])[ \t]*/g, ' ')
const compare = (value: string) => profileText(readableText(value)).normalize('NFKC').replace(/\s+/g, ' ')
export const isPrivateProfileText = (value: string) => SECRET_MARKER.test(value)
const withoutSecret = (value: string) => compare(value.replace(/\[机密\]|【机密】|［机密］/g, ''))
const sameText = (a: string, b: string) => !!withoutSecret(a) && withoutSecret(a) === withoutSecret(b)
const matching = (a: string, b: string, confidential: boolean) => sameText(a, b) && (!(confidential || isPrivateProfileText(a)) || SECRET.test(b))
const entryId = (path: string, value: string, copy: number) => 'entry-' + workspaceFingerprint([path, value, copy]).slice(0, 32)
const eolOf = (text: string) => /\r\n|\n|\r/.exec(text)?.[0] ?? '\n'

/** Find standalone entries in the requested section, without interpreting the rest of an owner's document. */
function readSection(path: string, body: string, title: string): Section {
  const visible = body.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => comment.replace(/[^\r\n]/g, ' '))
  const headings: {depth: number; title: string; start: number; end: number}[] = []
  let fence: string | undefined
  for (const row of visible.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(row[0].trimEnd())
    if (marker) {
      const delim = marker[1]!
      if (!fence) fence = delim
      else if (fence[0] === delim[0] && fence.length <= delim.length && !marker[2]) fence = undefined
      continue
    }
    if (fence) continue
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(row[0].trimEnd())
    if (heading) headings.push({depth: heading[1]!.length, title: heading[2]!, start: row.index, end: row.index + row[0].length})
  }
  const matches = headings.filter(row => row.depth === 2 && row.title === title)
  const selected = matches[0]
  const next = selected && headings.find(row => row.start > selected.start)
  const at = next?.start ?? body.length
  const openComment = body.lastIndexOf('<!--') > body.lastIndexOf('-->')
  const section: Section = {entry: [], at, append: matches.length < 2 && (!!next || (!fence && !openComment)), found: !!selected}
  if (!selected || matches.length !== 1) return section
  const region = body.slice(selected.end, at)
  section.current = readableText(region.split(/\r\n|\n|\r/)
    .filter(line => !/^\s*>/.test(line) && !BLANK_OR_TEMPLATE.test(line.replace(/^\s*[-*+]\s+/, ''))).join('\n').trim())

  const rows = [...visible.slice(selected.end, at).matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)]
  const copies = new Map<string, number>()
  let inFence: string | undefined
  for (const [index, row] of rows.entries()) {
    const line = row[0].replace(/(?:\r\n|[\r\n])$/, '')
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line.trimEnd())
    if (marker) {
      const delim = marker[1]!
      if (!inFence) inFence = delim
      else if (inFence[0] === delim[0] && inFence.length <= delim.length && !marker[2]) inFence = undefined
      continue
    }
    if (inFence) continue
    const bullet = /^([-*+][ \t]+)(\S.*)$/.exec(line)
    const nextLine = rows[index + 1]?.[0].trim() ?? ''
    const previousLine = rows[index - 1]?.[0].trim() ?? ''
    // Only offer to replace an independent entry. Keep nested and multiline Markdown in place.
    const standalone = !previousLine && !nextLine && /^[\p{L}\p{N}「『]/u.test(line)
    if ((!bullet && !standalone) || BLANK_OR_TEMPLATE.test(bullet?.[2] ?? line)
      || (nextLine && !/^[-*+][ \t]+/.test(rows[index + 1]![0]))) continue
    if (rows[index + 2] && !nextLine && /^ {2,}\S/.test(rows[index + 2]![0])) continue
    const start = selected.end + row.index
    const end = start + line.length
    const text = body.slice(start + (bullet?.[1]?.length ?? 0), end).trim()
    const copy = copies.get(text) ?? 0
    copies.set(text, copy + 1)
    section.entry.push({id: entryId(path, text, copy), text, start, end, prefix: bullet?.[1] ?? '- '})
  }
  return section
}

function choices(path: string, doc: Doc, heading: string, label: string, item: ProfileCandidate, add = 'new'): FileTarget[] {
  const section = readSection(path, doc.text, heading)
  const base = {kind: 'file' as const, path, label, doc, heading, section}
  const options = section.entry.map(entry => ({...base, entry, view: {
    id: entry.id, label: label + ' · 替换条目', version: doc.version, current: readableText(entry.text),
    match: matching(item.text, entry.text, item.confidential),
  }}))
  return section.append ? [{...base, view: {id: add, label: label + ' · 新增条目', version: doc.version, current: section.current}}, ...options] : options
}

function withSecret(value: string, confidential: boolean): string {
  const text = profileText(value).replace(/［机密］/g, '[机密]')
  return confidential && !SECRET.test(text) ? text + CONFIDENTIAL : text
}

function appendEntry(target: FileTarget, text: string): string {
  const {section, doc, heading} = target
  const eol = eolOf(doc.text)
  const before = doc.text.slice(0, section.at)
  const gap = !before || before.endsWith(eol + eol) ? '' : before.endsWith(eol) ? eol : eol + eol
  const header = section.found ? '' : '## ' + heading + eol + eol
  return gap + header + '- ' + text + eol + (section.at < doc.text.length ? eol : '')
}

export class ProfileImportTargets {
  constructor(private readonly root: string, private readonly goals: SuperhubGoals, private readonly committed?: (message: string, paths: string[]) => void) {}

  private choices(item: ProfileCandidate): Target[] {
    if (item.category === 'goal') return this.goalChoices(item)
    if (item.category === 'person') return this.personChoices(item)
    const [path, heading, label] = SECTIONS[item.category]
    return choices(path, readProfileFile(join(this.root, path)), heading, label + ' · ' + heading, item)
  }

  private checkGoalFiles() {
    readProfileFile(join(this.root, 'goals.md'))
    readProfileFile(join(this.root, SUPERHUB_GOALS_FILE))
  }

  private goalChoices(item: ProfileCandidate): GoalTarget[] {
    this.checkGoalFiles()
    const existing: GoalTarget[] = this.goals.list().map(goal => {
      const current = currentGoal(goal)
      return {kind: 'goal', id: goal.id, current, view: {
        id: goal.id, version: workspaceFingerprint(current), label: '目标 · ' + current.name,
        current: [current.name, current.description].filter(Boolean).join('\n'),
        match: matching(item.text, current.name, item.confidential),
      }}
    })
    const previous: GoalTarget[] = this.goals.candidates().map(candidate => ({
      kind: 'goal', candidate, view: {
        id: 'candidate-' + candidate.id, version: workspaceFingerprint(candidate), label: '目标 · ' + candidate.section,
        current: candidate.text, match: matching(item.text, candidate.text, item.confidential),
      },
    }))
    return [{kind: 'goal', view: {id: 'new', version: 0, label: '新增目标'}}, ...existing, ...previous]
  }

  private personChoices(item: ProfileCandidate): FileTarget[] {
    if (!item.subject) return []
    const path = join(this.root, 'people')
    const rows = profileDirectory(path) ? readdirSync(path, {withFileTypes: true}) : []
    const existing = rows.flatMap(row => {
      const id = row.name.slice(0, -3)
      if (!row.isFile() || !row.name.endsWith('.md') || !validId(id)) return []
      const rel = 'people/' + row.name
      const doc = readProfileFile(join(this.root, rel))
      const {meta} = parseDoc(doc.text)
      if (compare(meta.name || id) !== compare(item.subject!)) return []
      const label = [meta.name || id, meta.organization, meta.team].filter(Boolean).join(' · ') + '（' + id + '）'
      return choices(rel, doc, '事实', label, item, 'person-' + id)
    })
    return [{
      kind: 'file', subject: item.subject, label: '人物 · ' + item.subject, doc: {text: '', version: 0}, heading: '事实',
      section: {entry: [], at: 0, append: true, found: false},
      view: {id: 'new', label: '新增人物 · ' + item.subject, version: 0},
    }, ...existing]
  }

  list(item: ProfileCandidate): ProfileImportTarget[] {
    return this.choices(item).map(target => target.view)
  }

  plan(item: ProfileCandidate, targetId: string, version: ProfileTargetVersion, text: string, requestKey: string): ProfileWrite {
    const targets = this.choices(item)
    const target = targets.find(candidate => candidate.view.id === targetId)
    if (!target || target.view.version !== version) return workspaceError(409, '资料档案已更新，请重新核对后再保存')
    const before = target.kind === 'file' ? target.entry?.text : target.current?.name ?? target.candidate?.text
    const value = withSecret(text, item.confidential || isPrivateProfileText(before ?? ''))
    const max = target.kind === 'goal' ? 200 : 1200
    if (!withoutSecret(value) || value.length > max || CONTROLS.test(value)) return workspaceError(400, '请填写有效的资料内容，最多 ' + max + ' 字')
    if (target.kind === 'goal') {
      const duplicate = targetId === 'new' && targets.find(other => other.kind === 'goal' && (other.current || other.candidate)
        && sameText(value, other.current?.name ?? other.candidate!.text))
      if (duplicate) return workspaceError(409, '已有相同目标，请核对并选择已有目标')
      if (target.id && value === target.current?.name) return {kind: 'recorded', saved: {targetId, label: '目标 · ' + value, text: value}}
      const args = {requestId: 'profile-import-' + requestKey, expectedVersion: target.current?.version ?? 0,
        name: value, reason: '主人核对并保存外部助手资料', ...(target.candidate && {candidateId: target.candidate.id})}
      return {kind: 'goal', id: target.id, args, text: value}
    }

    const path = target.path ?? ('people/p-' + randomUUID() + '.md')
    const duplicate = target.section.entry.find(entry => entry !== target.entry && sameText(value, entry.text))
    if (duplicate && !target.entry && matching(value, duplicate.text, item.confidential)) {
      return {kind: 'recorded', saved: {targetId: duplicate.id, label: target.label, text: readableText(duplicate.text)}}
    }
    if (duplicate) return workspaceError(409, '目标档案已有相同内容，请核对已有条目')
    if (target.entry && matching(value, target.entry.text, item.confidential)) {
      return {kind: 'recorded', saved: {targetId: target.entry.id, label: target.label, text: readableText(target.entry.text)}}
    }
    const start = target.entry?.start ?? target.section.at
    const end = target.entry?.end ?? start
    const entry = markdownText(value)
    const insert = target.subject
      ? formatDoc({meta: {name: target.subject}, sections: new Map([['事实', '- ' + entry]])}, ['画像', '事实', '互动'])
      : target.entry ? target.entry.prefix + entry : appendEntry(target, entry)
    const updated = target.doc.text.slice(0, start) + insert + target.doc.text.slice(end)
    return {kind: 'file', path, before: version, after: workspaceFingerprint(updated), start, end, insert,
      saved: {targetId: entryId(path, entry, 0), label: target.label, text: value}}
  }

  apply(change: ProfileWrite): ProfileSavedItem {
    if (change.kind === 'recorded') return change.saved
    if (change.kind === 'goal') {
      this.checkGoalFiles()
      const result = this.goals.change(change.id, change.args, () => false)
      return {targetId: result.goal.id, label: '目标 · ' + result.current.name, text: change.text}
    }
    const person = /^people\/(.+)\.md$/.exec(change.path)?.[1]
    if (change.path !== 'me.md' && change.path !== 'AGENTS.md' && !validId(person)) return workspaceError(503, '个人资料写入记录不可用')
    const path = join(this.root, change.path)
    const {text, version} = readProfileFile(path)
    if (version !== change.after) {
      if (version !== change.before) return workspaceError(409, '资料档案已更新，请重新核对后再保存')
      const next = text.slice(0, change.start) + change.insert + text.slice(change.end)
      if (workspaceFingerprint(next) !== change.after) return workspaceError(503, '个人资料写入记录不可用')
      profileDirectory(dirname(path), true)
      writeProfileFile(path, next)
    }
    this.committed?.('保存主人确认的个人资料', [change.path])
    return change.saved
  }
}
