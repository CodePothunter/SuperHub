import { readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import type { V2DirectorySuggestion, V2DirectorySuggestions } from '../core/workspace-v2.ts'

/**
 * Project directories where Codex and Claude Code run as the owner. A directory must already exist, be the owner's own
 * and lie outside the system, the home directory itself and SuperHub's private storage. Nothing is ever created here.
 */
export interface DirectoryRules {
  /** The second brain: its `ops/` and SuperHub's own working directories are private. */
  brainRoot: string
  /** Other private storage (e.g. the plugin's home). */
  internal?: string[]
  /** Defaults to the process owner's home and uid. */
  home?: string
  uid?: number
  fs?: {
    realpath(path: string): string; stat(path: string): { isDirectory(): boolean; uid: number }
    /** Only directory suggestions list a directory; absent: the real filesystem. */
    readdir?(path: string): DirectoryEntry[]
  }
}

/** What suggestions need of a `Dirent`. */
export interface DirectoryEntry { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }

/** System trees a project never lives in (a home below one of them, e.g. `/root`, is still allowed). */
export const SYSTEM_DIRECTORIES = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/var', '/boot', '/proc', '/sys', '/dev',
  '/run', '/opt', '/root', '/snap', '/srv'] as const

export class DirectoryError extends Error {
  readonly status = 400
  /** `short`: the reason in a few words, shown next to a suggested directory that cannot be bound. */
  constructor(message: string, readonly short?: string) { super(message) }
}

const inside = (path: string, parent: string) => path === parent || path.startsWith(parent.endsWith('/') ? parent : parent + '/')

/**
 * Check a directory the owner named and return its resolved absolute path. Errors are 400 with a reason the owner can
 * act on. `value` absent or empty is not handled here (callers decide whether that means "unbind").
 */
export function checkProjectDirectory(value: unknown, rules: DirectoryRules): string {
  const fs = rules.fs ?? { realpath: (path: string) => realpathSync(path), stat: (path: string) => statSync(path) }
  if (typeof value !== 'string' || !value.trim()) throw new DirectoryError('请填写项目目录的绝对路径')
  const raw = value.trim()
  if (raw.length > 4096 || /[\u0000-\u001f]/.test(raw)) throw new DirectoryError('项目目录的路径无效')
  if (!isAbsolute(raw)) throw new DirectoryError('项目目录需要绝对路径（以 / 开头），例如 /home/me/project；收到「' + raw + '」')
  let real: string
  try { real = fs.realpath(normalize(raw).replace(/(.)\/+$/, '$1')) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new DirectoryError('目录不存在：' + raw + '。SuperHub 不会自动创建目录，请先建好再绑定')
    throw new DirectoryError('无法读取目录 ' + raw + '（' + (code ?? '未知错误') + '）')
  }
  let stat: { isDirectory(): boolean; uid: number }
  try { stat = fs.stat(real) }
  catch { throw new DirectoryError('无法读取目录 ' + real) }
  if (!stat.isDirectory()) throw new DirectoryError('这不是目录：' + real)
  if (real === '/') throw new DirectoryError('不能使用根目录 /，请选择具体的项目目录', '根目录')
  const resolved = (path: string) => { try { return fs.realpath(path) } catch { return normalize(path) } }
  const home = resolved(rules.home ?? homedir())
  if (real === home) throw new DirectoryError('不能直接使用家目录 ' + home + '，请选择家目录下的具体项目', '家目录本身')
  // A home of `/` (some service accounts) would contain everything: the system trees are refused there as well.
  if (home === '/' || !inside(real, home)) {
    for (const system of SYSTEM_DIRECTORIES) {
      if (inside(real, system) || inside(real, resolved(system))) throw new DirectoryError('不能使用系统目录 ' + system + '：' + real, '系统目录')
    }
  }
  const brain = resolved(rules.brainRoot)
  for (const blocked of [join(brain, 'ops'), join(brain, 'work', 'superhub-v2'), ...(rules.internal ?? [])].map(resolved)) {
    if (inside(real, blocked)) throw new DirectoryError('不能使用第二大脑或 SuperHub 的内部目录：' + real, '内部目录')
  }
  const uid = rules.uid ?? process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) throw new DirectoryError('目录不属于当前用户：' + real, '不属于你')
  return real
}

/** Names starting with `fragment`: exact case first, then any case; each group in name order. Others are dropped. */
export function rankDirectoryNames(names: readonly string[], fragment: string): string[] {
  const lower = fragment.toLowerCase()
  const exact: string[] = [], loose: string[] = []
  for (const name of names) {
    if (name.startsWith(fragment)) exact.push(name)
    else if (name.toLowerCase().startsWith(lower)) loose.push(name)
  }
  const order = (a: string, b: string) => a.localeCompare(b)
  return [...exact.sort(order), ...loose.sort(order)]
}

/**
 * Directories the owner may mean while typing `input` (an absolute path, `~/…`, or empty for the home): the
 * subdirectories of its parent that start with its last segment, each marked whether it can be bound. Read-only; a
 * parent that is missing or unreadable is an `issue`, never an error, so typing goes on.
 */
export function suggestDirectories(input: string, rules: DirectoryRules, limit = 50): V2DirectorySuggestions {
  const home = (rules.home ?? homedir()).replace(/(.)\/+$/, '$1')
  const none = (issue: string, parent = ''): V2DirectorySuggestions => ({parent, home, entries: [], more: false, issue})
  let raw = input.trim() || '~/'
  if (raw.length > 4096 || /[\u0000-\u001f]/.test(raw)) return none('路径无效')
  if (raw === '~') raw = home
  else if (raw.startsWith('~/')) raw = (home === '/' ? '' : home) + raw.slice(1)
  if (!isAbsolute(raw)) return none('项目目录需要绝对路径（以 / 开头）')
  const cut = raw.lastIndexOf('/')
  // Same lexical form the save check uses: `//` and `..` collapse; symlinks stay as written.
  const parent = normalize(raw.slice(0, cut) || '/').replace(/(.)\/+$/, '$1')
  const fragment = raw.slice(cut + 1)
  let listed: DirectoryEntry[]
  try { listed = rules.fs?.readdir ? rules.fs.readdir(parent) : readdirSync(parent, {withFileTypes: true}) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return none(code === 'ENOENT' || code === 'ENOTDIR' ? '目录不存在' : code === 'EACCES' || code === 'EPERM' ? '无权读取这个目录' : '无法读取这个目录', parent)
  }
  const stat = rules.fs?.stat ?? ((path: string) => statSync(path))
  const under = (name: string) => (parent === '/' ? '' : parent) + '/' + name
  const hidden = fragment.startsWith('.')
  const byName = new Map(listed.filter(row => row.name !== '.' && row.name !== '..' && row.name.startsWith('.') === hidden).map(row => [row.name, row]))
  // One past the limit tells there are more: a huge directory full of links is not followed link by link.
  const directories: string[] = []
  for (const name of rankDirectoryNames([...byName.keys()], fragment)) {
    if (directories.length > limit) break
    const row = byName.get(name)!
    if (row.isDirectory()) directories.push(name)
    else if (row.isSymbolicLink()) { try { if (stat(under(name)).isDirectory()) directories.push(name) } catch { /* a broken link is no directory */ } }
  }
  const entries = directories.slice(0, limit).map((name): V2DirectorySuggestion => {
    const path = under(name)
    try { checkProjectDirectory(path, rules); return {path, name, bindable: true} }
    catch (error) { return {path, name, bindable: false, reason: error instanceof DirectoryError && error.short || '无法读取'} }
  })
  return {parent, home, entries, more: directories.length > limit}
}

/** Resolve a stored directory for locking; a directory that disappeared keeps its stored path. */
export function directoryKey(path: string): string {
  try { return realpathSync(path) } catch { return normalize(path) }
}

/** Characters that continue a path name (ASCII; a CJK word right after a path ends it, as in 「/home/me/x 目录下」). */
const NAME = /[A-Za-z0-9_~-]/
/** `rest` (the text after a match) goes on with the same path: more name, an extension, or a deeper directory. */
function continues(rest: string): boolean {
  let at = 0
  if (rest[at] === '/') at++
  const next = rest[at]
  if (next === undefined) return false
  if (NAME.test(next) || next === '/') return true
  // 「/home/me/x.」 ends a sentence; 「/home/me/x.git」 or 「/home/me/x/./y」 names another path.
  return next === '.' && rest[at + 1] !== undefined && /[A-Za-z0-9_~./-]/.test(rest[at + 1]!)
}

/**
 * The owner wrote this directory in their words: as written, without a trailing slash, or with `~` for the home. The
 * match must be the whole path the owner wrote, so a parent (`/home/me` inside `/home/me/landing`) never counts.
 */
export function ownerGaveDirectory(directory: string, texts: string[], home = homedir()): boolean {
  const plain = directory.trim().normalize('NFC').replace(/(.)\/+$/, '$1')
  if (!plain) return false
  const variants = [plain]
  const base = home.replace(/\/+$/, '')
  if (inside(plain, base) && plain !== base) variants.push('~' + plain.slice(base.length))
  return texts.some(raw => {
    const text = raw.normalize('NFC')
    return variants.some(variant => {
      for (let at = text.indexOf(variant); at !== -1; at = text.indexOf(variant, at + 1)) {
        const before = at ? text[at - 1]! : ''
        if (before && (NAME.test(before) || before === '/' || before === '.')) continue
        if (!continues(text.slice(at + variant.length))) return true
      }
      return false
    })
  })
}
