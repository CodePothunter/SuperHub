/**
 * 第二大脑：brain git 仓库的读写。
 *
 * 读：AGENTS.md / goals.md（宪法）、staff/*.md（角色卡）、rules.yaml（工作区与来源档位；定时安排在 SuperHub 运行数据里，见 schedules.ts）。
 * 写：只有两处——journal/ 下的笔记追加、work/<工单>/ 工作目录；长期记忆只经提案（见 DESIGN.md 第 5 节）。
 * 提交：几秒内的多次改动合并成一次 commit，避免刷屏的历史。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isMap, parse as parseYaml, parseDocument } from 'yaml'
import { currentOutputEvidence, snapshotOutputs } from './deliveries.ts'
import { PRIVATE_OPS } from './brain-private.ts'
import { SUPERHUB_GOALS_FILE, readGoalsDocument } from '../core/export.ts'
import { defaultStaffPortrait, isSpeakerPortrait, isStaffAvatarShape, recommendStaffPortrait, type StaffAvatarShape } from '../core/workspace-avatars.ts'
import type { Brain } from '../core/engine.ts'
import type { LegacyRule } from './schedules.ts'
import type { DeliveryVersion, Staff } from '../core/model.ts'

const exec = promisify(execFile)
const CONSTITUTION_LIMIT = 8000
/** 幕僚可写、可自动提交的目录。其余（宪法、目标、角色卡、规则、长期知识）只经已批准的提案或主人自己提交。 */
const STAFF_WRITABLE = ['ops', 'work', 'journal', 'proposals', 'inbox']
const PROTECTED = ['AGENTS.md', 'me.md', 'goals.md', SUPERHUB_GOALS_FILE, 'staff', 'rules.yaml', 'notes', 'people', 'lines', 'ledger', 'meetings', 'decisions', 'README.md']
export { privateBrainData } from './brain-private.ts'

/** 简单的 Markdown 头部元数据解析：只支持 `key: value` 单行，足够角色卡使用。 */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '')
  }
  return { meta, body: match[2]!.trim() }
}

/** 带缓存的文件读取：按修改时间失效，避免每次调度都读盘。 */
class Cached<T> {
  private stamp = ''
  private value: T | undefined
  constructor(private readonly files: () => string[], private readonly load: () => T) {}
  get(): T {
    const stamp = this.files().map(file => existsSync(file) ? `${file}:${statSync(file).mtimeMs}` : file).join('|')
    if (stamp !== this.stamp || this.value === undefined) { this.value = this.load(); this.stamp = stamp }
    return this.value
  }
}

interface RulesFile {
  workspaces?: unknown
  sources?: unknown
}

/** 来源的档位：自动处理、只记录（留痕不研判，等主人放行）、关闭。 */
export type SourceMode = 'auto' | 'observe' | 'off'
export const SOURCE_MODES: readonly SourceMode[] = ['auto', 'observe', 'off']

export class BrainRepo implements Brain {
  private readonly staffCache: Cached<Staff[]>
  private readonly rulesCache: Cached<{ workspaces: string[]; sources: Record<string, SourceMode> }>
  private commitTimer: NodeJS.Timeout | undefined
  private readonly pendingMessages: string[] = []
  private pendingAll = false
  /** 插件自己写入、等待提交的受保护文件（花名册）。 */
  private readonly pendingPaths = new Map<string, number>()
  private writeSeq = 0
  private committing: Promise<void> = Promise.resolve()

  constructor(readonly root: string, private readonly log: (message: string) => void = () => {}) {
    const staffDir = join(root, 'staff')
    this.staffCache = new Cached(
      () => existsSync(staffDir) ? [staffDir, ...readdirSync(staffDir).map(name => join(staffDir, name))] : [staffDir],
      () => this.loadStaff(staffDir))
    const rulesFile = join(root, 'rules.yaml')
    this.rulesCache = new Cached(() => [rulesFile], () => this.loadRules(rulesFile))
  }

  /** 附加在宪法后面的动态上下文（花名册概况），供研判使用。 */
  extraContext?: () => string
  /** 本地宿主生成的额外交付证据。 */
  hostOutputs?: (ticketId: string) => string[]

  constitution(): string {
    const parts: string[] = []
    for (const name of ['AGENTS.md', 'me.md']) {
      const file = join(this.root, name)
      if (existsSync(file)) parts.push(`### ${name}\n${readFileSync(file, 'utf8').trim()}`)
    }
    const goals = this.goals()
    if (goals) parts.push(`### goals.md\n${goals.trim()}`)
    const text = parts.join('\n\n')
    const base = text.length > CONSTITUTION_LIMIT ? `${text.slice(0, CONSTITUTION_LIMIT)}\n…（已截断，完整内容见文件）` : text
    const extra = this.extraContext?.().slice(0, 2500)
    return extra ? `${base}\n\n### 花名册概况\n${extra}` : base
  }

  staff(): Staff[] { return this.staffCache.get() }
  goals(): string { return readGoalsDocument(this.root) }
  /** 系统自带的工作区（开发模式下的插件源码目录），不写进 rules.yaml。 */
  extraWorkspaces: readonly string[] = []
  workspaces(): string[] { return [...new Set([...this.rulesCache.get().workspaces, ...this.extraWorkspaces])] }
  /** 来源的档位；rules.yaml 里没写的用缺省值。 */
  sourceMode(id: string, fallback: SourceMode): SourceMode { return this.rulesCache.get().sources[id] ?? fallback }

  /** 改一个来源的档位：只改 rules.yaml 里的那一项，保留文件里的注释和其余内容。 */
  setSourceMode(id: string, mode: SourceMode): void {
    if (!/^[a-z][a-z-]{1,30}$/.test(id) || !SOURCE_MODES.includes(mode)) throw new Error('来源或档位不合法')
    const file = join(this.root, 'rules.yaml')
    const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '')
    doc.setIn(['sources', id], mode)
    writeFileSync(file, doc.toString())
    this.commit(`来源 ${id} 改为 ${mode}`, { paths: ['rules.yaml'] })
  }

  /**
   * 旧版定时规则迁到 SuperHub 定时安排（只在定时安排初始化时调用一次）：读出 rules.yaml 的 rules 交给 save，
   * save 成功后才删掉 rules 键（保留 workspaces、sources 与注释）并提交。没有 rules 键时以空列表调用 save，不改文件。
   */
  takeLegacyRules(save: (rules: LegacyRule[]) => void): void {
    const file = join(this.root, 'rules.yaml')
    if (!existsSync(file)) return save([])
    let doc: ReturnType<typeof parseDocument>
    try { doc = parseDocument(readFileSync(file, 'utf8')) } catch { return save([]) }
    if (doc.errors.length || !isMap(doc.contents) || !doc.has('rules')) return save([])
    const raw = doc.toJS() as { rules?: unknown }
    save((Array.isArray(raw.rules) ? raw.rules : []).flatMap(item => {
      const r = (item ?? {}) as Record<string, unknown>
      return typeof r.id === 'string' && typeof r.when === 'string' && typeof r.text === 'string' ? [{ id: r.id, when: r.when, text: r.text, enabled: r.enabled !== false }] : []
    }))
    doc.delete('rules')
    writeFileSync(file, doc.toString())
    this.commit('定时规则迁到 SuperHub 定时安排：到点投递到接口人对话，在「设置 → 定时安排」查看和开关；rules.yaml 不再有 rules', { paths: ['rules.yaml'] })
  }

  /** rules.yaml 里是否（又）出现了 rules 键：迁移之后不再读取，只提示。 */
  hasLegacyRules(): boolean {
    const file = join(this.root, 'rules.yaml')
    if (!existsSync(file)) return false
    try { const doc = parseDocument(readFileSync(file, 'utf8')); return isMap(doc.contents) && doc.has('rules') } catch { return false }
  }

  /** 让一位幕僚退休：角色卡移到 staff/.retired/，需要时可以搬回来。 */
  retireStaff(id: string): void {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error('幕僚代号不合法')
    const from = join(this.root, 'staff', `${id}.md`)
    if (!existsSync(from)) throw new Error(`没有这位幕僚：${id}`)
    mkdirSync(join(this.root, 'staff', '.retired'), { recursive: true })
    renameSync(from, join(this.root, 'staff', '.retired', `${id}.md`))
    this.commit(`幕僚：${id} 退休`, { paths: [`staff/${id}.md`, `staff/.retired/${id}.md`] })
  }

  /** 新建或修改一位幕僚的角色卡（主人的操作）。 */
  saveStaff(card: Omit<Staff, 'defaultPortrait'>, portraitShape?: StaffAvatarShape): void {
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(card.id)) throw new Error('幕僚的代号只能用小写字母、数字和短横线，例如 analyst')
    const one = (v: string) => v.replace(/[\r\n]+/g, ' ').trim()
    const roster = this.staff()
    const existing = roster.find(staff => staff.id === card.id)
    const defaultPortrait = existing ? existing.defaultPortrait
      : recommendStaffPortrait(card, roster.map(staff => defaultStaffPortrait(staff.id, staff.defaultPortrait)), portraitShape)
    const meta = [`name: ${one(card.name) || card.id}`, `executor: ${one(card.executor) || 'dsh'}`, `verifier: ${one(card.verifier) || 'reviewer'}`, ...card.model ? [`model: ${one(card.model)}`] : [], ...card.model && card.reasoningEffort ? [`reasoning-effort: ${one(card.reasoningEffort)}`] : []]
    if (defaultPortrait) meta.push(`portrait-shape: ${defaultPortrait.shape}`, `portrait-color: ${defaultPortrait.color}`)
    mkdirSync(join(this.root, 'staff'), { recursive: true })
    writeFileSync(join(this.root, 'staff', `${card.id}.md`), `---\n${meta.join('\n')}\n---\n${card.brief.trim()}\n`)
    this.commit(`幕僚：${card.name || card.id} 的角色卡更新`, { paths: [`staff/${card.id}.md`] })
  }

  private loadStaff(dir: string): Staff[] {
    if (!existsSync(dir)) return []
    const out: Staff[] = []
    for (const name of readdirSync(dir).filter(n => n.endsWith('.md')).sort()) {
      const { meta, body } = parseFrontmatter(readFileSync(join(dir, name), 'utf8'))
      const id = meta.id || name.replace(/\.md$/, '')
      const portrait = { shape:meta['portrait-shape'], color:meta['portrait-color'] }
      out.push({
        id, name: meta.name || id, executor: meta.executor || 'dsh', verifier: meta.verifier || 'reviewer', brief: body,
        ...meta.model ? { model: meta.model } : {},
        ...meta.model && meta['reasoning-effort'] ? { reasoningEffort: meta['reasoning-effort'] } : {},
        ...isSpeakerPortrait(portrait) && isStaffAvatarShape(portrait.shape) ? { defaultPortrait:portrait } : {},
      })
    }
    return out
  }

  private loadRules(file: string): { workspaces: string[]; sources: Record<string, SourceMode> } {
    if (!existsSync(file)) return { workspaces: [], sources: {} }
    let doc: RulesFile
    try { doc = (parseYaml(readFileSync(file, 'utf8')) ?? {}) as RulesFile } catch (error) {
      this.log(`rules.yaml 解析失败：${(error as Error).message}`)
      return { workspaces: [], sources: {} }
    }
    const workspaces = Array.isArray(doc.workspaces)
      ? doc.workspaces.filter((x): x is string => typeof x === 'string').map(p => resolve(this.root, p)) : []
    const sources: Record<string, SourceMode> = {}
    if (doc.sources && typeof doc.sources === 'object') for (const [id, mode] of Object.entries(doc.sources as object)) if (SOURCE_MODES.includes(mode as SourceMode)) sources[id] = mode as SourceMode
    return { workspaces, sources }
  }

  workdir(ticketId: string): string {
    if (!/^T-\d+$/.test(ticketId)) throw new Error(`非法工单 id：${ticketId}`)
    const dir = join(this.root, 'work', ticketId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  snapshotOutputs(ticketId: string, outputs: readonly string[]) {
    return snapshotOutputs(this.root, ticketId, [...(this.hostOutputs?.(ticketId) ?? []), ...outputs])
  }
  deliveryEvidence(ticketId: string, delivery: DeliveryVersion) { return currentOutputEvidence(this.root, ticketId, delivery) }

  saveRemoteReport(ticketId: string, round: number, content: string): string {
    const file = join(this.workdir(ticketId), `remote-report-${round + 1}.md`)
    writeFileSync(file, `<!-- 工作电脑回传（第 ${round + 1} 轮），未经核验 -->\n\n${content.slice(0, 200_000)}\n`)
    return relative(this.root, file)
  }

  /** 只允许写 journal/ 下的 .md 文件，防止研判结果把笔记写到别处。 */
  appendNote(path: string, content: string): string {
    const target = normalize(isAbsolute(path) ? path : join(this.root, path))
    const rel = relative(join(this.root, 'journal'), target)
    if (rel.startsWith('..') || isAbsolute(rel) || !target.endsWith('.md')) throw new Error(`笔记只能写在 journal/ 下的 .md 文件：${path}`)
    mkdirSync(dirname(target), { recursive: true })
    const stamp = new Date().toISOString().slice(11, 16)
    appendFileSync(target, `${existsSync(target) && readFileSync(target, 'utf8').length ? '\n' : ''}<!-- ${stamp} -->\n${content.trim()}\n`)
    return relative(this.root, target)
  }

  commit(message: string, options: { all?: boolean; paths?: string[] } = {}): void {
    this.pendingMessages.push(message)
    if (options.all) this.pendingAll = true
    for (const path of options.paths ?? []) this.pendingPaths.set(path, ++this.writeSeq)
    if (this.commitTimer) return
    this.commitTimer = setTimeout(() => {
      this.commitTimer = undefined
      const messages = this.pendingMessages.splice(0), all = this.pendingAll
      this.pendingAll = false
      this.committing = this.committing.then(() => this.gitCommit(messages, all)).catch(error => this.log(`git 提交失败：${(error as Error).message}`))
    }, 3000)
    this.commitTimer.unref?.()
  }

  /** 关闭前把未提交的改动提交掉。 */
  async flush(): Promise<void> {
    if (this.commitTimer) {
      clearTimeout(this.commitTimer)
      this.commitTimer = undefined
      const messages = this.pendingMessages.splice(0), all = this.pendingAll
      this.pendingAll = false
      this.committing = this.committing.then(() => this.gitCommit(messages, all))
    }
    await this.committing.catch(() => undefined)
  }

  async protectedChanges(): Promise<string[]> {
    if (!existsSync(join(this.root, '.git'))) return []
    const { stdout } = await exec('git', ['-c', 'core.quotePath=false', 'status', '--porcelain', '--', ...PROTECTED], { cwd: this.root })
    // 插件自己刚写入、还没来得及提交的文件不算。
    return stdout.split('\n').map(line => line.slice(3).trim().replace(/^"|"$/g, '')).filter(Boolean).filter(path => !this.pendingPaths.has(path))
  }

  private async gitCommit(messages: string[], all: boolean): Promise<void> {
    if (!existsSync(join(this.root, '.git')) || !messages.length) return
    const own = [...this.pendingPaths]
    try {
      // 自己写过的路径：存在的要加，被删掉的（例如幕僚退休时移走的角色卡）也要把删除记下来，所以已被 git 跟踪的也算
      const ownPaths = own.map(([path]) => path)
      const tracked = ownPaths.length ? new Set((await exec('git', ['-c', 'core.quotePath=false', 'ls-files', '--', ...ownPaths], { cwd: this.root })).stdout.split('\n').filter(Boolean)) : new Set<string>()
      // Old brains keep their existing ignore rules. This pathspec also protects their pending import material.
      const paths = all ? ['.'] : [...STAFF_WRITABLE.filter(p => existsSync(join(this.root, p))), ...ownPaths.filter(p => existsSync(join(this.root, p)) || tracked.has(p))]
      if (!paths.length) return
      const excluded = PRIVATE_OPS.map(name => ':(top,exclude)ops/' + name)
      await exec('git', ['-c', 'core.quotePath=false', 'add', '-A', '--', ...paths, ...excluded], { cwd: this.root })
      const { stdout } = await exec('git', ['diff', '--cached', '--name-only'], { cwd: this.root })
      if (!stdout.trim()) return
      const subject = messages.length === 1 ? messages[0]! : `${messages[0]} 等 ${messages.length} 项`
      const body = messages.length > 1 ? `\n\n${messages.map(m => `- ${m}`).join('\n')}` : ''
      await exec('git', ['commit', '-q', '-m', `chief: ${subject}${body}`], { cwd: this.root })
    } finally {
      // 提交完成（或失败）后才从待提交集合移除，期间这些文件不会被误报为"受保护文件被改动"。
      // 提交期间又被写过的文件（序号变了）留给下一次提交。
      for (const [path, seq] of own) if (this.pendingPaths.get(path) === seq) this.pendingPaths.delete(path)
    }
  }
}
