/**
 * 第一次启动：选定第二大脑的位置，并把它建好。
 *
 *   - 空目录或不存在：从包里的 templates/brain/ 复制宪法、目标、规则、默认幕僚，git init 并提交。
 *   - 已经是第二大脑（有 AGENTS.md 和 staff/）：直接接管，只补整个缺失的顶层文件或目录，不覆盖、不往已有目录里加东西
 *     （例如退休的幕僚不会被模板"复活"）。
 *   - 非空又不是第二大脑：拒绝，免得把别人的文件夹弄乱。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from './settings.ts'

/** 包里的模板目录：lib/index.js 或 src/dsh/scaffold.ts 往上找到含 templates/ 的那一层。 */
export function templatesDir(from = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, 'templates', 'brain'))) return join(dir, 'templates')
    dir = dirname(dir)
  }
  throw new Error('找不到模板目录 templates/，插件包不完整')
}

export const SUGGESTED_BRAIN = '~/chief-brain'

const inside = (child: string, parent: string) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

/** 校验用户给的路径，返回绝对路径。危险位置直接拒绝。 */
export function resolveBrainDir(input: string, { home = homedir(), dshHome = process.env.DSH_HOME }: { home?: string; dshHome?: string | undefined } = {}): string {
  const raw = input.trim()
  if (!raw) throw new Error('请给一个文件夹路径')
  if (raw.startsWith('~') && raw !== '~' && !/^~[\\/]/.test(raw)) throw new Error('只支持 ~/ 开头表示家目录，例如 ~/chief-brain')
  if (!raw.startsWith('~') && !isAbsolute(raw)) throw new Error('请写完整路径（以 / 或 ~/ 开头）')
  const dir = resolve(raw.startsWith('~') ? (raw === '~' ? home : join(home, raw.slice(2))) : expandHome(raw))
  if (dir === resolve('/') || dir.split(sep).filter(Boolean).length < 2) throw new Error('不能放在根目录或一级目录下')
  if (dir === resolve(home)) throw new Error('不能直接用家目录，请在下面建一个子文件夹，例如 ~/chief-brain')
  // 和 chiefHomeOf 一样：没设 DSH_HOME 时 DSH 用 ~/.dsh
  const dsh = dshHome?.trim() ? resolve(dshHome.trim() === '~' ? home : /^~[\\/]/.test(dshHome.trim()) ? join(home, dshHome.trim().slice(2)) : dshHome.trim()) : join(home, '.dsh')
  if (inside(dir, dsh)) throw new Error('不能放在 DSH 自己的数据目录里')
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error('这个路径是一个文件，不是文件夹')
  return dir
}

export type BrainKind = 'empty' | 'brain' | 'other'

export function classify(dir: string): BrainKind {
  if (!existsSync(dir)) return 'empty'
  const entries = readdirSync(dir).filter(n => n !== '.DS_Store')
  if (!entries.length || (entries.length === 1 && entries[0] === '.git')) return 'empty'
  if (existsSync(join(dir, 'AGENTS.md')) && existsSync(join(dir, 'staff'))) return 'brain'
  return 'other'
}

/** 模板里的文件名到目标文件名：gitignore 在包里不能叫 .gitignore（npm 会把它丢掉）。 */
const targetName = (name: string) => name === 'gitignore' ? '.gitignore' : name

function copyTree(from: string, to: string, overwrite: boolean): string[] {
  const copied: string[] = []
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const src = join(from, name), dst = join(to, targetName(name))
    if (statSync(src).isDirectory()) copied.push(...copyTree(src, dst, overwrite).map(p => join(targetName(name), p)))
    else if (overwrite || !existsSync(dst)) { copyFileSync(src, dst); copied.push(targetName(name)) }
  }
  return copied
}

function git(dir: string, args: string[]): boolean {
  try { execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); return true } catch { return false }
}

export function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

export interface ScaffoldResult { dir: string; kind: 'created' | 'adopted'; added: string[]; git: boolean }

/** 建好或接管第二大脑。调用前先用 resolveBrainDir 校验路径。 */
export function scaffoldBrain(dir: string, templates = templatesDir()): ScaffoldResult {
  const kind = classify(dir)
  if (kind === 'other') throw new Error('这个文件夹里已经有别的东西了。请换一个空文件夹，或者一个已有的第二大脑')
  const base = join(templates, 'brain')
  const added: string[] = []
  if (kind === 'empty') added.push(...copyTree(base, dir, false))
  else {
    // 接管：只补整个缺失的顶层条目
    for (const name of readdirSync(base)) {
      const dst = join(dir, targetName(name))
      if (existsSync(dst)) continue
      const src = join(base, name)
      if (statSync(src).isDirectory()) added.push(...copyTree(src, dst, false).map(p => join(targetName(name), p)))
      else { copyFileSync(src, dst); added.push(targetName(name)) }
    }
  }
  for (const sub of ['ops', 'work', 'journal', 'proposals']) mkdirSync(join(dir, sub), { recursive: true })
  let tracked = existsSync(join(dir, '.git'))
  if (hasGit()) {
    if (!tracked) tracked = git(dir, ['init', '-q'])
    if (tracked && added.length) {
      git(dir, ['add', '--', ...added])
      // 没配置身份的机器上也能提交
      git(dir, ['-c', 'user.name=SuperHub', '-c', 'user.email=superhub@localhost', 'commit', '-q', '-m', kind === 'empty' ? '第二大脑：初始化' : '第二大脑：补齐缺失的文件', '--', ...added])
    }
  }
  return { dir, kind: kind === 'empty' ? 'created' : 'adopted', added, git: tracked }
}

/** 升级时新增的模板文件（例如 me.md）：已有的第二大脑缺了就补上，不覆盖。返回补上的路径。 */
export function ensureTemplateFiles(brain: string, names: readonly string[] = ['me.md'], templates = templatesDir()): string[] {
  const added: string[] = []
  for (const name of names) {
    const src = join(templates, 'brain', name), dst = join(brain, name)
    if (existsSync(src) && !existsSync(dst)) { copyFileSync(src, dst); added.push(name) }
  }
  return added
}

/** 开发模式：插件目录是一个带源码和构建工具的 git 检出。 */
export function devCheckout(pluginRoot: string): boolean {
  return existsSync(join(pluginRoot, '.git')) && existsSync(join(pluginRoot, 'src', 'index.ts')) && existsSync(join(pluginRoot, 'node_modules', '.bin', 'tsdown'))
}

/** 开发模式下补上界面师的角色卡（不覆盖已有的）。 */
export function ensureDevStaff(brain: string, templates = templatesDir()): string[] {
  const from = join(templates, 'dev', 'staff')
  if (!existsSync(from)) return []
  const added: string[] = []
  for (const name of readdirSync(from)) {
    // 主人让它退休过就不再补回来
    if (existsSync(join(brain, 'staff', name)) || existsSync(join(brain, 'staff', '.retired', name))) continue
    mkdirSync(join(brain, 'staff'), { recursive: true })
    copyFileSync(join(from, name), join(brain, 'staff', name))
    added.push(join('staff', name))
  }
  return added
}

/**
 * 老版本里研判事件的幕僚（staff/chief.md）也叫"接口人"，和作战台上对话的接口人重名：
 * 主人说"接口人换个模型"时会改错对象。只改还是旧名字的卡，主人自己起过别的名字就不动。
 */
export function migrateStaffNames(brain: string): string[] {
  const file = join(brain, 'staff', 'chief.md')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const next = text.replace(/^(---\r?\n(?:[^\n]*\n)*?)name:[ \t]*接口人[ \t]*$/m, '$1name: 研判官')
  if (next === text) return []
  writeFileSync(file, next)
  return [join('staff', 'chief.md')]
}
