/**
 * 编程会话在指定项目目录运行：目录校验、来源优先级、真实目录不写 SuperHub 文件、按目录区分原生会话、同目录排队与会话标题。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2Delegation, V2DialogueSource, V2DirectorySuggestions, V2Session, V2SessionView, V2TurnInput, V2Workspace, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import { DirectoryLocks, lockConflict } from '../src/dsh/directory-locks.ts'
import { serveApi } from '../src/dsh/http.ts'
import { checkProjectDirectory, ownerGaveDirectory, rankDirectoryNames, suggestDirectories } from '../src/dsh/project-directory.ts'
import { createV2DialogueSource, nativeSessionName } from '../src/dsh/workspace-v2-dialogue.ts'
import { dialogueKey } from '../src/dsh/workspace-v2-group.ts'
import { WorkspaceV2Store, mutationKey } from '../src/dsh/workspace-v2-store.ts'
import { workspaceV2Routes } from '../src/dsh/workspace-v2.ts'
import { cliHost } from './coding-cli-fake.ts'

const roots: string[] = []
const cleanup: (() => void)[] = []
function temp(prefix = 'chief-project-dir-') { const p = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(p); return p }
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
  for (const p of roots.splice(0)) rmSync(p, {recursive: true, force: true})
})
const settle = () => new Promise(resolve => setTimeout(resolve, 15))

describe('project directory rules', () => {
  const stat = (uid = 1000, directory = true) => ({isDirectory: () => directory, uid})
  /** A fake filesystem: every listed path exists and resolves to itself. */
  const fake = (paths: Record<string, ReturnType<typeof stat>>) => ({
    realpath: (path: string) => { if (!(path in paths)) throw Object.assign(new Error('missing'), {code: 'ENOENT'}); return path },
    stat: (path: string) => paths[path]!,
  })
  const rules = (paths: Record<string, ReturnType<typeof stat>>) => ({brainRoot: '/home/me/brain', home: '/home/me', uid: 1000, internal: ['/home/me/.dsh/chief'], fs: fake(paths)})

  it.each([
    ['relative', 'projects/app', /绝对路径/],
    ['empty', '  ', /请填写/],
    ['missing (never created)', '/home/me/nowhere', /目录不存在.*不会自动创建/],
    ['root', '/', /根目录/],
    ['home itself', '/home/me', /家目录/],
    ['/etc', '/etc', /系统目录 \/etc/],
    ['inside /usr', '/usr/local/src', /系统目录 \/usr/],
    ['/var', '/var/www', /系统目录 \/var/],
    ['/opt', '/opt/tool', /系统目录 \/opt/],
    ['brain ops', '/home/me/brain/ops/superhub-v2', /内部目录/],
    ['SuperHub working copies', '/home/me/brain/work/superhub-v2/a/b', /内部目录/],
    ['plugin home', '/home/me/.dsh/chief/liaison', /内部目录/],
    ['someone else\'s', '/home/me/shared', /不属于当前用户/],
    ['a file', '/home/me/notes.md', /不是目录/],
  ])('rejects %s', (_case, value, reason) => {
    const paths = {'/': stat(0), '/home/me': stat(), '/etc': stat(0), '/usr/local/src': stat(), '/var/www': stat(), '/opt/tool': stat(),
      '/home/me/brain/ops/superhub-v2': stat(), '/home/me/brain/work/superhub-v2/a/b': stat(), '/home/me/.dsh/chief/liaison': stat(),
      '/home/me/shared': stat(1001), '/home/me/notes.md': stat(1000, false)}
    expect(() => checkProjectDirectory(value, rules(paths))).toThrow(reason)
    try { checkProjectDirectory(value, rules(paths)) } catch (error) { expect((error as {status: number}).status).toBe(400) }
  })

  it('accepts the owner\'s own project, the brain itself, other brain folders, /tmp and a home under a system tree', () => {
    const paths = {'/home/me/work/landing': stat(), '/home/me/brain': stat(), '/home/me/brain/projects/x': stat(), '/tmp/try': stat()}
    for (const path of Object.keys(paths)) expect(checkProjectDirectory(path + '/', rules(paths))).toBe(path)
    // A home below a system tree (e.g. /root) keeps its projects usable; the home itself is still refused.
    const rootHome = {...rules({'/root/app': stat(0), '/root': stat(0)}), home: '/root', uid: 0}
    expect(checkProjectDirectory('/root/app', rootHome)).toBe('/root/app')
    expect(() => checkProjectDirectory('/root', rootHome)).toThrow(/家目录/)
    expect(() => checkProjectDirectory('/home/me/gone', rules({}))).toThrow(/不存在/)
    expect(() => checkProjectDirectory('/srv/data/app', rules({'/srv/data/app': stat()}))).toThrow(/系统目录 \/srv/)
    // A process whose home is `/` still cannot use the system trees.
    expect(() => checkProjectDirectory('/etc', {...rules({'/etc': stat(0), '/': stat(0)}), home: '/', uid: 0})).toThrow(/系统目录 \/etc/)
  })

  it('resolves symlinks before checking, on the real filesystem', () => {
    const base = temp(), project = join(base, 'repo'), link = join(base, 'link')
    mkdirSync(project)
    symlinkSync(project, link)
    expect(checkProjectDirectory(link, {brainRoot: join(base, 'brain')})).toBe(project)
    symlinkSync('/etc', join(base, 'etc-link'))
    expect(() => checkProjectDirectory(join(base, 'etc-link'), {brainRoot: join(base, 'brain')})).toThrow(/系统目录|不属于当前用户/)
    expect(() => checkProjectDirectory(homedir(), {brainRoot: join(base, 'brain')})).toThrow(/家目录/)
  })

  it('finds a directory in the owner\'s words as written, without its trailing slash or with ~ for the home', () => {
    expect(ownerGaveDirectory('/home/me/landing', ['把字节 Landing 绑定到 /home/me/landing/'], '/home/me')).toBe(true)
    expect(ownerGaveDirectory('/home/me/landing/', ['绑定到 ~/landing'], '/home/me')).toBe(true)
    expect(ownerGaveDirectory('/home/me/landing', ['换个目录吧'], '/home/me')).toBe(false)
    expect(ownerGaveDirectory('', ['/'], '/home/me')).toBe(false)
    expect(ownerGaveDirectory('/home/me/landing', ['绑定到 /home/me/landing.'], '/home/me')).toBe(true)
    expect(ownerGaveDirectory('/home/me/landing', ['这单在「/home/me/landing」目录下做'], '/home/me')).toBe(true)
  })

  it('never takes a parent or a prefix of the path the owner wrote as the owner\'s directory', () => {
    const said = ['把字节 Landing 绑定到 /home/me/work/landing-api/']
    for (const guess of ['/home/me/work', '/home/me/work/landing', '/home/me', '/home', '~/work', '/work/landing-api', 'landing-api'])
      expect(ownerGaveDirectory(guess, said, '/home/me'), guess).toBe(false)
    expect(ownerGaveDirectory('/home/me/work/landing-api', said, '/home/me')).toBe(true)
    expect(ownerGaveDirectory('/home/me/app', ['在 /home/me/app.git 里看看'], '/home/me')).toBe(false)
    expect(ownerGaveDirectory('/home/me/app', ['在 /srv/home/me/app 里看看'], '/home/me')).toBe(false)
    // The root as the owner wrote it is passed on, and the directory rules refuse it with their own reason.
    expect(ownerGaveDirectory('/', ['绑定到 /'], '/home/me')).toBe(true)
  })

  it('names native sessions 〈工作区名〉 · 〈会话名〉 on one line', () => {
    expect(nativeSessionName('字节 Landing', '首页改版')).toBe('字节 Landing · 首页改版')
    expect(nativeSessionName(undefined, '首页\n改版')).toBe('首页 改版')
    expect(nativeSessionName('w', 'x'.repeat(200))).toHaveLength(80)
  })
})

describe('directory suggestions', () => {
  /** A home with projects, hidden folders, files, symlinks and the brain, under a temporary root. */
  function tree() {
    const base = temp(), home = join(base, 'home'), brain = join(home, 'brain')
    for (const name of ['app', 'App', 'apple', 'Apricot', 'banana', '.config', '.cache', 'brain/ops', 'brain/projects']) mkdirSync(join(home, name), {recursive: true})
    writeFileSync(join(home, 'apex.txt'), '')
    symlinkSync(join(home, 'app'), join(home, 'applink'))
    symlinkSync(join(home, 'apex.txt'), join(home, 'apfile'))
    symlinkSync(join(base, 'gone'), join(home, 'apbroken'))
    return {base, home, rules: {brainRoot: brain, home}}
  }
  const names = (result: {entries: {name: string}[]}) => result.entries.map(row => row.name)

  it('ranks exact-case prefix matches first, then any case, each by name, and drops the rest', () => {
    expect(rankDirectoryNames(['beta', 'Apple', 'apple', 'app', 'Apricot', 'zap'], 'ap')).toEqual(['app', 'apple', 'Apple', 'Apricot'])
    expect(rankDirectoryNames(['b', 'a', 'C'], '')).toEqual(['a', 'b', 'C'])
    expect(rankDirectoryNames(['Docs', 'docs-old'], 'D')).toEqual(['Docs', 'docs-old'])
    expect(rankDirectoryNames(['x'], 'y')).toEqual([])
  })

  it('lists only directories (and symlinks to directories) starting with the last segment, keeping the path as typed', () => {
    const {home, rules} = tree()
    const result = suggestDirectories(home + '/ap', rules)
    expect(result).toMatchObject({parent: home, home, more: false})
    expect(result).not.toHaveProperty('issue')
    expect(names(result)).toEqual(['app', 'apple', 'applink', 'App', 'Apricot'])
    expect(result.entries.find(row => row.name === 'applink')).toEqual({path: join(home, 'applink'), name: 'applink', bindable: true})
    // `//` and `..` collapse the way the save check reads them.
    expect(names(suggestDirectories(home + '/brain/..//ap', rules))).toEqual(names(result))
  })

  it('shows hidden directories only when the segment starts with a dot', () => {
    const {home, rules} = tree()
    expect(names(suggestDirectories(home + '/', rules))).toEqual(['app', 'App', 'apple', 'applink', 'Apricot', 'banana', 'brain'])
    expect(names(suggestDirectories(home + '/.c', rules))).toEqual(['.cache', '.config'])
    expect(names(suggestDirectories(home + '/.', rules))).toEqual(['.cache', '.config'])
  })

  it('reads ~ and an empty input as the home', () => {
    const {home, rules} = tree()
    const listed = names(suggestDirectories(home + '/', rules))
    for (const input of ['', '  ', '~/']) expect(suggestDirectories(input, rules)).toMatchObject({parent: home, home})
    expect(names(suggestDirectories('', rules))).toEqual(listed)
    expect(suggestDirectories('~/ba', rules).entries).toEqual([{path: join(home, 'banana'), name: 'banana', bindable: true}])
    expect(suggestDirectories('~', rules).entries.map(row => row.path)).toEqual([home])
    expect(suggestDirectories('~/', {...rules, home: home + '/'}).parent).toBe(home)
  })

  it('marks what cannot be bound with a short reason, and it stays listed', () => {
    const {base, home, rules} = tree()
    expect(suggestDirectories(base + '/', rules).entries).toEqual([{path: home, name: 'home', bindable: false, reason: '家目录本身'}])
    expect(suggestDirectories('~/brain/', rules).entries).toEqual([
      {path: join(home, 'brain', 'ops'), name: 'ops', bindable: false, reason: '内部目录'},
      {path: join(home, 'brain', 'projects'), name: 'projects', bindable: true}])
    expect(suggestDirectories('/et', rules).entries).toContainEqual({path: '/etc', name: 'etc', bindable: false, reason: '系统目录'})
    expect(suggestDirectories('/', rules).entries.find(row => row.name === 'etc')?.path).toBe('/etc')
    const stranger = suggestDirectories('~/ba', {...rules, uid: (process.getuid?.() ?? 0) + 4242})
    expect(stranger.entries).toEqual([{path: join(home, 'banana'), name: 'banana', bindable: false, reason: '不属于你'}])
    // A reason without a short form (here: a directory that vanished in between) reads 「无法读取」.
    const vanished = {...rules, fs: {realpath: () => { throw Object.assign(new Error('x'), {code: 'EIO'}) }, stat: (path: string) => statSync(path)}}
    expect(suggestDirectories('~/ba', vanished).entries).toEqual([{path: join(home, 'banana'), name: 'banana', bindable: false, reason: '无法读取'}])
  })

  it('reports a missing or unreadable parent and a path that is not absolute as one line, without throwing', () => {
    const {base, home, rules} = tree()
    expect(suggestDirectories(base + '/nowhere/x', rules)).toEqual({parent: base + '/nowhere', home, entries: [], more: false, issue: '目录不存在'})
    expect(suggestDirectories(home + '/apex.txt/x', rules).issue).toBe('目录不存在')
    const failing = (code: string) => ({...rules, fs: {realpath: realpathSync, stat: (path: string) => statSync(path),
      readdir: () => { throw Object.assign(new Error(code), {code}) }}})
    expect(suggestDirectories('~/x', failing('EACCES')).issue).toBe('无权读取这个目录')
    expect(suggestDirectories('~/x', failing('EPERM')).issue).toBe('无权读取这个目录')
    expect(suggestDirectories('~/x', failing('EIO')).issue).toBe('无法读取这个目录')
    for (const input of ['projects/app', '~someone/x']) expect(suggestDirectories(input, rules)).toMatchObject({entries: [], more: false, issue: expect.stringContaining('绝对路径')})
    expect(suggestDirectories('/home/\u0001', rules).issue).toBe('路径无效')
    expect(suggestDirectories('/' + 'a'.repeat(4100), rules).issue).toBe('路径无效')
  })

  it('keeps the best 50 and says there are more', () => {
    const base = temp()
    for (let i = 0; i < 55; i++) mkdirSync(join(base, 'd' + String(i).padStart(2, '0')))
    const rules = {brainRoot: join(base, 'brain'), home: join(base, 'elsewhere')}
    const cut = suggestDirectories(base + '/d', rules)
    expect(cut.entries).toHaveLength(50)
    expect(cut.entries[0]?.name).toBe('d00')
    expect(cut.more).toBe(true)
    expect(suggestDirectories(base + '/d5', rules)).toMatchObject({more: false, entries: expect.arrayContaining([expect.objectContaining({name: 'd54'})])})
    expect(suggestDirectories(base + '/d', rules, 60).more).toBe(false)
  })

  it('follows no more links than it needs to fill the list and see there are more', () => {
    const base = temp()
    mkdirSync(join(base, 'target'))
    let followed = 0
    const links = Array.from({length: 5000}, (_, i) => ({name: 'l' + String(i).padStart(4, '0'), isDirectory: () => false, isSymbolicLink: () => true}))
    const rules = {brainRoot: join(base, 'brain'), home: join(base, 'elsewhere'), fs: {realpath: (path: string) => path, readdir: () => links,
      stat: (path: string) => { if (path.startsWith(base + '/l')) followed++; return statSync(join(base, 'target')) }}}
    const result = suggestDirectories(base + '/l', rules)
    expect(result.entries).toHaveLength(50)
    expect(result.entries.every(row => row.bindable)).toBe(true)
    expect(result.more).toBe(true)
    // 51 to know the list is cut, then each listed link once more by the binding check.
    expect(followed).toBe(51 + 50)
  })
})

describe('directory locks', () => {
  const holder = (sessionId: string, requestId = sessionId + '-r') => ({sessionId, requestId, title: sessionId})

  it('hands the directory over first come, first served, and never to two turns at once', async () => {
    const locks = new DirectoryLocks(), order: string[] = []
    expect(locks.take('k', holder('a'))).toBe(true)
    expect(locks.take('k', holder('b'))).toBe(false)
    locks.wait('k', holder('b'), () => { order.push('b'); expect(locks.take('k', holder('b'))).toBe(true) })
    locks.wait('k', holder('c'), () => { order.push('c'); expect(locks.take('k', holder('c'))).toBe(true) })
    expect(locks.holder('k')?.sessionId).toBe('a')
    // Releasing with another request id changes nothing.
    locks.release('k', 'other')
    await settle()
    expect(order).toEqual([])
    locks.release('k', 'a-r')
    await settle()
    expect(order).toEqual(['b'])
    expect(locks.take('k', holder('d'))).toBe(false)
    locks.release('k', 'b-r')
    await settle()
    expect(order).toEqual(['b', 'c'])
    locks.release('k', 'c-r')
    expect(locks.busy('k')).toBe(false)
  })

  it('passes a hand-over nobody took to the next waiter, and a stopped wait never resumes', async () => {
    const locks = new DirectoryLocks(), order: string[] = []
    locks.take('k', holder('a'))
    locks.wait('k', holder('b'), () => { order.push('b') })
    const stop = locks.wait('k', holder('c'), () => { order.push('c') })
    locks.wait('k', holder('d'), () => { order.push('d'); locks.take('k', holder('d')) })
    stop()
    locks.release('k', 'a-r')
    await settle()
    // b never took the directory (its turn had ended meanwhile): d gets it, c was stopped.
    expect(order).toEqual(['b', 'd'])
    expect(locks.holder('k')?.sessionId).toBe('d')
  })

  it('treats nested project directories as one lock domain, but not siblings sharing a prefix', async () => {
    expect(lockConflict('dir:/repo', 'dir:/repo/sub')).toBe(true)
    expect(lockConflict('dir:/repo/sub/deeper', 'dir:/repo')).toBe(true)
    expect(lockConflict('dir:/repo', 'dir:/repo2')).toBe(false)
    expect(lockConflict('dir:/repo/a', 'dir:/repo/b')).toBe(false)
    expect(lockConflict('superhub:brain:s1', 'superhub:brain:s1/x')).toBe(false)
    const locks = new DirectoryLocks(), order: string[] = []
    expect(locks.take('dir:/repo', holder('a'))).toBe(true)
    // A subdirectory waits for its parent; a sibling with a common prefix runs at once.
    expect(locks.take('dir:/repo/sub', holder('b'))).toBe(false)
    expect(locks.holder('dir:/repo/sub')?.sessionId).toBe('a')
    expect(locks.take('dir:/repo2', holder('x'))).toBe(true)
    locks.wait('dir:/repo/sub', holder('b'), () => { order.push('b'); expect(locks.take('dir:/repo/sub', holder('b'))).toBe(true) })
    // The parent arriving later waits behind the subdirectory (first come, first served).
    expect(locks.take('dir:/repo', holder('c'))).toBe(false)
    locks.wait('dir:/repo', holder('c'), () => { order.push('c'); expect(locks.take('dir:/repo', holder('c'))).toBe(true) })
    // Another subdirectory not overlapping `/repo/sub` still queues behind the waiting `/repo` (no overtaking).
    expect(locks.take('dir:/repo/other', holder('d'))).toBe(false)
    locks.wait('dir:/repo/other', holder('d'), () => { order.push('d'); expect(locks.take('dir:/repo/other', holder('d'))).toBe(true) })
    locks.release('dir:/repo2', 'x-r')
    await settle()
    expect(order).toEqual([])
    locks.release('dir:/repo', 'a-r')
    await settle()
    expect(order).toEqual(['b'])
    expect(locks.holder('dir:/repo')?.sessionId).toBe('b')
    locks.release('dir:/repo/sub', 'b-r')
    await settle()
    expect(order).toEqual(['b', 'c'])
    locks.release('dir:/repo', 'c-r')
    await settle()
    expect(order).toEqual(['b', 'c', 'd'])
    locks.release('dir:/repo/other', 'd-r')
    expect(locks.busy('dir:/repo')).toBe(false)
  })

  it('does not deadlock when a handed-over turn now runs in a directory overlapping the one it was handed', async () => {
    const locks = new DirectoryLocks(), order: string[] = []
    locks.take('dir:/repo', holder('a'))
    // b waited for /repo; meanwhile its order moved to /repo/sub, which overlaps its own unclaimed hand-over.
    locks.wait('dir:/repo', holder('b'), () => {
      order.push('b:first')
      expect(locks.take('dir:/repo/sub', holder('b'))).toBe(false)
      locks.wait('dir:/repo/sub', holder('b'), () => { order.push('b:sub'); expect(locks.take('dir:/repo/sub', holder('b'))).toBe(true) })
    })
    locks.release('dir:/repo', 'a-r')
    await settle()
    expect(order).toEqual(['b:first', 'b:sub'])
    expect(locks.holder('dir:/repo/sub')?.sessionId).toBe('b')
    locks.release('dir:/repo/sub', 'b-r')
    expect(locks.busy('dir:/repo')).toBe(false)
  })

  it('hands two disjoint subdirectories over together once their common parent is free', async () => {
    const locks = new DirectoryLocks(), order: string[] = []
    locks.take('dir:/repo', holder('a'))
    locks.wait('dir:/repo/x', holder('b'), () => { order.push('b'); locks.take('dir:/repo/x', holder('b')) })
    locks.wait('dir:/repo/y', holder('c'), () => { order.push('c'); locks.take('dir:/repo/y', holder('c')) })
    locks.release('dir:/repo', 'a-r')
    await settle()
    expect(order).toEqual(['b', 'c'])
    expect(locks.take('dir:/repo', holder('e'))).toBe(false)
    expect(locks.holder('dir:/repo')?.sessionId).toBe('b')
  })
})

describe('store: workspace and order directories', () => {
  it('binds, changes and removes a workspace directory, validates order directories and keeps older data as it was', () => {
    const root = temp(), project = temp(), other = temp()
    const store = new WorkspaceV2Store(root, 'brain')
    const key = (id: string, body: Record<string, unknown>) => mutationKey(['test', id], {requestId: id, ...body})
    const plain = store.createWorkspace(key('w1', {name: '旧工作区'}), {requestId: 'w1', name: '旧工作区'}).workspace
    expect(plain).not.toHaveProperty('projectDirectory')
    expect(store.directoryOf(plain.id)).toBeUndefined()
    const bound = store.createWorkspace(key('w2', {name: '字节 Landing', directory: project + '/'}), {requestId: 'w2', name: '字节 Landing', directory: project + '/'}).workspace
    expect(bound.projectDirectory).toBe(project)
    expect(() => store.setDirectory(key('d0', {directory: '/etc'}), bound.id, {requestId: 'd0', directory: '/etc'})).toThrow(/系统目录/)
    expect(() => store.setDirectory(key('d1', {}), bound.id, {requestId: 'd1'})).toThrow(/留空以解除/)
    expect(store.workspace(bound.id).projectDirectory).toBe(project)
    store.setDirectory(key('d2', {directory: other}), bound.id, {requestId: 'd2', directory: other})
    expect(store.workspace(bound.id)).toMatchObject({projectDirectory: other, projectDirectoryChangedAt: expect.any(String)})
    store.setDirectory(key('d3', {directory: ''}), bound.id, {requestId: 'd3', directory: ''})
    expect(store.workspace(bound.id)).not.toHaveProperty('projectDirectory')
    const board = JSON.parse(readFileSync(join(root, 'ops', 'superhub-v2', readdirSync(join(root, 'ops', 'superhub-v2'))[0]!), 'utf8'))
    expect(board.directoryChanges.map((row: {from?: string; to?: string}) => [row.from, row.to])).toEqual([[undefined, project], [project, other], [other, undefined]])

    store.setDirectory(key('d4', {directory: project}), bound.id, {requestId: 'd4', directory: project})
    const own = store.createDelegation(key('o1', {}), bound, {requestId: 'o1', title: '改 README', executor: 'codex', directory: other}).delegation
    const shared = store.createDelegation(key('o2', {}), bound, {requestId: 'o2', title: '查构建', executor: 'claude-code'}).delegation
    expect(own.directory).toBe(other)
    expect(store.directoryOf(bound.id, own.id)).toEqual({source: 'order', path: other})
    expect(store.directoryOf(bound.id, shared.id)).toEqual({source: 'workspace', path: project})
    expect(() => store.createDelegation(key('o3', {}), bound, {requestId: 'o3', title: '团队单', executor: 'dsh', directory: other})).toThrow(/只用于 Codex 或 Claude Code/)
    expect(() => store.createDelegation(key('o4', {}), bound, {requestId: 'o4', title: '坏目录', executor: 'codex', directory: join(project, 'missing')})).toThrow(/不存在/)
    expect(store.view(bound.id).orders.map(row => row.title)).toEqual(['改 README', '查构建'])
    // The liaison's assignment: only coding executors take a directory; a retry with another directory is a different request.
    expect(() => store.assign('src-1', '团队整理', 'dsh', bound.id, undefined, undefined, undefined, undefined, undefined, other)).toThrow(/只用于/)
    const job = store.assign('src-2', '让 Codex 在这里改', 'codex', bound.id, undefined, undefined, undefined, undefined, undefined, other)
    expect(job.delegation.directory).toBe(other)
    expect(store.assign('src-2', '让 Codex 在这里改', 'codex', bound.id, undefined, undefined, undefined, undefined, undefined, other).delegation.id).toBe(job.delegation.id)
    expect(() => store.assign('src-2', '让 Codex 在这里改', 'codex', bound.id, undefined, undefined, undefined, undefined, undefined, project)).toThrow(/另一项操作/)
  })
})

// ——— Routes: one coding turn per project directory ———

const scope = 'brain-dir'
function fixture(turnLimit = 4) {
  const root = temp('superhub-dir-')
  const sends: {session: V2Session; input: V2TurnInput; release: () => void}[] = []
  const running = new Set<string>()
  let overlap = false
  const source = {
    read: vi.fn<V2DialogueSource['read']>(async () => ({messages: []})),
    send: vi.fn<V2DialogueSource['send']>(async (session, input, signal, events) => {
      const key = input.directory ?? 'superhub:' + session.id
      if ([...running].some(other => other === key || other.startsWith(key + '/') || key.startsWith(other + '/'))) overlap = true
      running.add(key)
      events?.dispatched?.()
      const done = Promise.withResolvers<void>()
      signal.addEventListener('abort', () => done.reject(new Error('stopped')), {once: true})
      sends.push({session, input, release: () => done.resolve()})
      try { await done.promise } finally { running.delete(key) }
    }),
    confirmed: vi.fn(async () => false),
    attachment: vi.fn(async () => undefined),
    markInterjection: vi.fn<NonNullable<V2DialogueSource['markInterjection']>>(),
    workDirectory: vi.fn((session: V2Session) => join(root, 'work', 'superhub-v2', session.id)),
  }
  let store!: WorkspaceV2Store
  // Each mount is a fresh process: a restart frees every directory.
  const mount = () => { store = new WorkspaceV2Store(root, scope, turnLimit); return workspaceV2Routes({store, source, locks: new DirectoryLocks()}) }
  let route = mount()
  cleanup.push(() => route.dispose())
  const restart = () => { route.dispose(); route = mount(); route.recover() }
  async function call<T = {error: string}>(path: string, body?: Record<string, unknown>, query = scope) {
    const url = new URL('/chief/api/v2/workspaces' + path, 'http://local')
    url.searchParams.set('scope', query)
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      method: body ? 'POST' : 'GET', url: url.pathname + url.search, headers: {'x-chief-request': '1'}}) as unknown as IncomingMessage
    let status = 0, data: T
    const res = {writeHead(code: number) { status = code }, end(value: string) { data = JSON.parse(value) }} as unknown as ServerResponse
    await serveApi(req, res, 'dsh', [route], true)
    return {status, data: data!}
  }
  let serial = 0
  const id = () => 'r' + ++serial
  const workspace = async (name: string, directory?: string) => {
    const r = await call<{workspace: V2Workspace}>('', {requestId: id(), name, ...(directory && {directory})})
    expect(r.status).toBe(200)
    return r.data.workspace
  }
  const order = async (w: V2Workspace, title: string, extra: Record<string, unknown> = {}) => {
    const r = await call<{order: V2Delegation}>('/' + w.id + '/orders', {requestId: id(), title, executor: 'codex', ...extra})
    expect(r.status).toBe(200)
    return r.data.order
  }
  const say = (d: V2Delegation, text: string, requestId = id()) =>
    call<{delivery?: string; error?: string}>('/' + d.workspaceId + '/sessions/' + d.sessionId + '/messages', {requestId, text, workOrderId: d.id, wait: false})
  const sessionView = async (d: V2Delegation) => (await call<V2SessionView>('/' + d.workspaceId + '/sessions/' + d.sessionId)).data
  const budget = (d: V2Delegation) => store.delegation(d.workspaceId, d.id).remainingTurns
  return {root, sends, source, call, workspace, order, say, sessionView, budget, restart, overlap: () => overlap, store: () => store, route: () => route}
}

describe('one coding turn per project directory', () => {
  it('lets a second order wait for the first in the same directory, without budget or tool, and starts it right after', async () => {
    const f = fixture(), project = temp(), elsewhere = temp()
    const w = await f.workspace('字节 Landing', project)
    const a = await f.order(w, '首页改版'), b = await f.order(w, '接口文档')
    const c = await f.order(w, '另一个目录', {directory: elsewhere})
    expect(await f.say(a, '改首页')).toMatchObject({status: 200})
    expect(f.sends).toHaveLength(1)
    expect(f.sends[0]!.input).toMatchObject({text: '改首页', directory: project})
    // The second order waits: no tool, no budget, the conversation says what it waits for.
    expect(await f.say(b, '写接口文档')).toMatchObject({status: 200, data: {delivery: 'queued'}})
    expect(f.sends).toHaveLength(1)
    expect(f.budget(b)).toBe(4)
    expect(await f.sessionView(b)).toMatchObject({waiting: {title: '首页改版', workOrderId: a.id}})
    expect(await f.sessionView(b)).not.toHaveProperty('working')
    expect(f.source.markInterjection).toHaveBeenCalledWith(expect.objectContaining({id: b.sessionId}), {id: expect.any(String), text: '写接口文档', workOrderId: b.id}, 'queued')
    // Owner words while it waits join that turn instead of becoming another one.
    expect(await f.say(b, '顺便列出鉴权方式')).toMatchObject({status: 200, data: {delivery: 'queued'}})
    expect(f.budget(b)).toBe(4)
    // Another directory runs in parallel.
    await f.say(c, '在别处干活')
    expect(f.sends.map(row => row.input.text)).toEqual(['改首页', '在别处干活'])
    expect(f.sends[1]!.input.directory).toBe(elsewhere)
    f.sends[0]!.release()
    await vi.waitFor(() => expect(f.sends).toHaveLength(3))
    expect(f.sends[2]!.input).toMatchObject({text: '写接口文档', workOrderId: b.id, directory: project, merged: [{id: expect.any(String), text: '顺便列出鉴权方式'}]})
    expect(f.budget(b)).toBe(3)
    expect(await f.sessionView(b)).toMatchObject({working: true})
    for (const row of f.sends) row.release()
    await settle()
    expect(f.overlap()).toBe(false)
  })

  it('makes a project and its subdirectory wait for each other, while a sibling sharing the name prefix runs', async () => {
    const f = fixture(), project = temp(), sub = join(project, 'packages', 'web'), sibling = project + '2'
    mkdirSync(sub, {recursive: true})
    mkdirSync(sibling)
    cleanup.push(() => rmSync(sibling, {recursive: true, force: true}))
    const w = await f.workspace('字节 Landing', project)
    const a = await f.order(w, '整仓升级'), b = await f.order(w, '前端子包', {directory: sub}), c = await f.order(w, '同名前缀', {directory: sibling})
    await f.say(b, '改前端子包')
    expect(await f.say(a, '升级整个仓库')).toMatchObject({status: 200, data: {delivery: 'queued'}})
    expect(await f.sessionView(a)).toMatchObject({waiting: {title: '前端子包', workOrderId: b.id}})
    await f.say(c, '在旁边的目录')
    expect(f.sends.map(row => [row.input.text, row.input.directory])).toEqual([['改前端子包', sub], ['在旁边的目录', sibling]])
    f.sends[0]!.release()
    await vi.waitFor(() => expect(f.sends).toHaveLength(3))
    expect(f.sends[2]!.input).toMatchObject({text: '升级整个仓库', directory: project})
    for (const row of f.sends) row.release()
    await settle()
    expect(f.overlap()).toBe(false)
  })

  it('frees the directory at once when a waiting turn runs elsewhere because the workspace directory changed, and names the turn it waits for now', async () => {
    const f = fixture(), first = temp(), second = temp()
    const w = await f.workspace('字节 Landing', first)
    const a = await f.order(w, '首页改版'), b = await f.order(w, '接口文档')
    const c = await f.order(w, '本单在第一个目录', {directory: first}), d = await f.order(w, '也在第一个目录', {directory: first})
    await f.say(a, '改首页')
    await f.say(b, '写接口文档')
    await f.say(c, '改第一个目录')
    await f.say(d, '再改第一个目录')
    expect(f.sends).toHaveLength(1)
    expect(await f.sessionView(d)).toMatchObject({waiting: {title: '首页改版'}})
    await f.call('/' + w.id + '/directory', {requestId: 'move', directory: second})
    f.sends[0]!.release()
    // b now runs in the second directory; c gets the first one right away instead of after b's whole turn.
    await vi.waitFor(() => expect(f.sends).toHaveLength(3))
    expect(f.sends.slice(1).map(row => [row.input.text, row.input.directory])).toEqual([['写接口文档', second], ['改第一个目录', first]])
    // d still waits, now for c, which holds the first directory.
    expect(await f.sessionView(d)).toMatchObject({waiting: {title: '本单在第一个目录', workOrderId: c.id}})
    f.sends[2]!.release()
    await vi.waitFor(() => expect(f.sends).toHaveLength(4))
    expect(f.sends[3]!.input).toMatchObject({text: '再改第一个目录', directory: first})
    for (const row of f.sends) row.release()
    await settle()
    expect(f.overlap()).toBe(false)
  })

  it('stops a waiting turn on the owner\'s request, and when its order is paused', async () => {
    const f = fixture(), project = temp()
    const w = await f.workspace('字节 Landing', project)
    const a = await f.order(w, '首页改版'), b = await f.order(w, '接口文档'), c = await f.order(w, '部署脚本')
    await f.say(a, '改首页')
    await f.say(b, '写接口文档')
    await f.say(b, '并入的补充')
    await f.say(c, '改部署脚本')
    const stop = await f.call<{stopped: boolean}>('/' + w.id + '/sessions/' + b.sessionId + '/stop-waiting', {requestId: 'stop-b'})
    expect(stop).toMatchObject({status: 200, data: {stopped: true}})
    expect(await f.sessionView(b)).not.toHaveProperty('waiting')
    expect(f.source.markInterjection).toHaveBeenCalledWith(expect.anything(), {id: expect.any(String), text: '写接口文档', workOrderId: b.id}, 'unsent')
    expect(f.source.markInterjection).toHaveBeenCalledWith(expect.anything(), {id: expect.any(String), text: '并入的补充', workOrderId: b.id}, 'unsent')
    expect(f.store().delegation(w.id, b.id)).toMatchObject({remainingTurns: 4, reason: expect.stringContaining('叫停')})
    // A retry of the stop is a replay and stops nothing else.
    expect((await f.call<{stopped: boolean}>('/' + w.id + '/sessions/' + b.sessionId + '/stop-waiting', {requestId: 'stop-b'})).data.stopped).toBe(false)
    const paused = await f.call('/' + w.id + '/orders/' + c.id + '/action', {requestId: 'pause-c', action: 'pause'})
    expect(paused.status).toBe(200)
    expect(await f.sessionView(c)).not.toHaveProperty('waiting')
    f.sends[0]!.release()
    await settle()
    expect(f.sends).toHaveLength(1)
    // The owner can start the stopped order again; the directory is free now.
    await f.say(b, '重新开始')
    expect(f.sends.at(-1)!.input).toMatchObject({text: '重新开始', directory: project})
    f.sends.at(-1)!.release()
  })

  it('queues waiting turns again in their original order after a restart, with the directory free', async () => {
    const f = fixture(), project = temp()
    const w = await f.workspace('字节 Landing', project)
    const a = await f.order(w, '首页改版'), b = await f.order(w, '接口文档'), c = await f.order(w, '部署脚本')
    await f.say(a, '改首页')
    await f.say(b, '写接口文档')
    await f.say(c, '改部署脚本')
    expect(f.sends).toHaveLength(1)
    f.restart()
    // The running turn is not sent again (its outcome is unknown); the earliest waiting turn takes the directory.
    await vi.waitFor(() => expect(f.sends).toHaveLength(2))
    expect(f.sends[1]!.input).toMatchObject({text: '写接口文档', directory: project})
    expect(await f.sessionView(c)).toMatchObject({waiting: {title: '接口文档'}})
    expect(await f.sessionView(a)).not.toHaveProperty('working')
    f.sends[1]!.release()
    await vi.waitFor(() => expect(f.sends).toHaveLength(3))
    expect(f.sends[2]!.input.text).toBe('改部署脚本')
    f.sends[2]!.release()
    await settle()
    expect(f.overlap()).toBe(false)
  })

  it('runs SuperHub working directories of different sessions side by side and leaves the turn input without a directory', async () => {
    const f = fixture()
    const w = await f.workspace('未绑定')
    const a = await f.order(w, '一'), b = await f.order(w, '二')
    await f.say(a, '甲')
    await f.say(b, '乙')
    expect(f.sends.map(row => row.input.text)).toEqual(['甲', '乙'])
    for (const row of f.sends) expect(row.input).not.toHaveProperty('directory')
    const view = (await f.call<V2WorkspaceView>('/' + w.id)).data
    expect(view.directories?.[a.id]).toEqual({source: 'superhub', path: join(f.root, 'work', 'superhub-v2', a.sessionId)})
    for (const row of f.sends) row.release()
  })

  it('takes a changed workspace directory from the next turn, shows each order\'s directory and refuses unusable ones', async () => {
    const f = fixture(), first = temp(), second = temp(), own = temp()
    const w = await f.workspace('字节 Landing', first)
    const a = await f.order(w, '首页改版'), b = await f.order(w, '单独目录', {directory: own})
    const group = await f.call('/' + w.id + '/orders', {requestId: 'g', title: '团队单', executor: 'dsh', directory: own})
    expect(group).toMatchObject({status: 400, data: {error: expect.stringContaining('只用于 Codex 或 Claude Code')}})
    await f.say(a, '第一轮')
    for (const [directory, reason] of [['/etc', '系统目录'], [homedir(), '家目录'], [join(first, 'nope'), '不存在'], ['relative/dir', '绝对路径']] as const) {
      const refused = await f.call('/' + w.id + '/directory', {requestId: 'bad-' + directory.length, directory})
      expect(refused).toMatchObject({status: 400, data: {error: expect.stringContaining(reason)}})
    }
    expect((await f.call<{workspace: V2Workspace}>('/' + w.id + '/directory', {requestId: 'move', directory: second})).data.workspace.projectDirectory).toBe(second)
    // The running turn keeps its directory.
    expect(f.sends[0]!.input.directory).toBe(first)
    const view = (await f.call<V2WorkspaceView>('/' + w.id)).data
    expect(view.directories).toEqual({[a.id]: {source: 'workspace', path: second}, [b.id]: {source: 'order', path: own}})
    const execution = (await f.call<{directory: unknown}>('/' + w.id + '/orders/' + b.id + '/execution')).data
    expect(execution.directory).toEqual({source: 'order', path: own})
    f.sends[0]!.release()
    await settle()
    await f.say(a, '第二轮')
    expect(f.sends.at(-1)!.input.directory).toBe(second)
    f.sends.at(-1)!.release()
    expect((await f.call<{workspace: V2Workspace}>('/' + w.id + '/directory', {requestId: 'unbind', directory: ''})).data.workspace).not.toHaveProperty('projectDirectory')
    expect((await f.call<V2WorkspaceView>('/' + w.id)).data.directories?.[a.id]?.source).toBe('superhub')
  })
})

describe('directory suggestions route', () => {
  it('lists directories for the owner\'s typing without touching the binding, 404 for an unknown workspace, 409 for another brain', async () => {
    const f = fixture(), project = temp()
    for (const name of ['alpha', 'beta']) mkdirSync(join(project, name))
    const w = await f.workspace('字节 Landing')
    const suggest = (path: string, workspaceId = w.id, query?: string) =>
      f.call<V2DirectorySuggestions & {scope: string; error?: string}>('/' + workspaceId + '/directory?path=' + encodeURIComponent(path), undefined, query)
    const listed = await suggest(project + '/al')
    expect(listed).toEqual({status: 200, data: {scope, parent: project, home: homedir(), more: false,
      entries: [{path: join(project, 'alpha'), name: 'alpha', bindable: true}]}})
    expect((await suggest(join(project, 'nowhere') + '/x')).data).toMatchObject({entries: [], issue: '目录不存在'})
    expect(await suggest(project + '/', 'missing')).toMatchObject({status: 404})
    expect(await suggest(project + '/', w.id, 'other-brain')).toMatchObject({status: 409})
    expect(f.store().workspace(w.id)).not.toHaveProperty('projectDirectory')
    expect((await f.call<V2WorkspaceView>('/' + w.id)).data.workspace).not.toHaveProperty('projectDirectoryChangedAt')
  })
})

// ——— The dialogue source in a real project directory ———

const codingSession: V2Session = {id: 's1', workspaceId: 'w1', title: '首页改版', kind: 'coding', executor: 'codex', delegationIds: ['d1'], closed: false, createdAt: '2026-11-23'}
const job: V2Delegation = {id: 'd1', workspaceId: 'w1', sessionId: 's1', title: '首页改版', owner: '接口人', promise: '改好首页', boundary: '', status: 'active',
  nextCheckAt: '2026-11-24T00:00:00Z', generation: 1, remainingTurns: 3, createdAt: '2026-11-23'}
const workspace: V2Workspace = {id: 'w1', name: '字节 Landing', goal: '', owner: '我', createdAt: '2026-11-23'}
const input = (id: string, text: string, directory?: string, extra: Partial<V2TurnInput> = {}): V2TurnInput =>
  ({id, text, workOrderId: 'd1', context: {workspace, delegations: [job], decisions: []}, ...(directory && {directory}), ...extra})
const journalOf = (root: string) => {
  const area = dialogueKey('brain', 'w1')
  return JSON.parse(readFileSync(join(root, 'ops', 'superhub-v2-dialogues', area, dialogueKey(area, 's1'), 'source.json'), 'utf8'))
}
const signal = () => new AbortController().signal

describe('coding turns in the owner\'s project directory', () => {
  it('runs there without SuperHub files, names the thread, and reads linked files as attachments', async () => {
    const root = temp(), project = temp()
    writeFileSync(join(project, 'README.md'), '# 项目\n')
    const h = cliHost((spec, _prompt, {say}) => {
      writeFileSync(join(spec.cwd!, 'index.html'), '<h1>首页</h1>')
      say({type: 'item.completed', item: {id: 'm', type: 'agent_message', text: '首页已改好：[首页](index.html)'}})
      say({type: 'turn.completed'})
      return 0
    }, {thread: () => 'thread-P'})
    const source = createV2DialogueSource({ctx: h.ctx, root, scope: 'brain', codex: {executable: process.execPath}})
    await source.send(codingSession, input('one', '改首页', project), signal())
    const call = h.calls[0]!
    expect(call.spec.cwd).toBe(project)
    expect(call.thread).toMatchObject({cwd: project})
    expect(call.spec.argv.join(' ')).not.toContain('mcp_servers.superhub')
    expect(call.prompt).toContain('主人的项目目录')
    expect(call.prompt).not.toMatch(/preview_capabilities|报名页|试填/)
    expect(call.methods).toEqual(['initialize', 'initialized', 'thread/start', 'thread/name/set', 'turn/start'])
    expect(h.names.get('thread-P')).toBe('字节 Landing · 首页改版')
    // Only the tool's own file is new: no .superhub, accepted.html, previous-draft.html or revision-* from SuperHub.
    expect(readdirSync(project).sort()).toEqual(['README.md', 'index.html'])
    const transcript = await source.read(codingSession)
    const reply = transcript.messages.find(m => m.role === 'agent')!
    expect(reply.attachments).toEqual([{id: expect.any(String), label: '首页'}])
    expect(source.execution!(codingSession, 'd1').runs).toMatchObject([{state: 'done', nativeSessionId: 'thread-P', cwd: project}])
    expect(journalOf(root).native).toEqual({[project]: expect.objectContaining({sessionId: 'thread-P'})})
    source.dispose()
  })

  it('never continues a thread recorded for another directory, and continues each directory\'s own thread', async () => {
    const root = temp(), first = temp(), second = temp()
    const h = cliHost((_spec, _prompt, {say}) => { say({type: 'turn.completed'}); return 0 })
    const source = createV2DialogueSource({ctx: h.ctx, root, scope: 'brain', codex: {executable: process.execPath}})
    await source.send(codingSession, input('one', '在第一个目录', first), signal())
    await source.send(codingSession, input('two', '换到第二个目录', second), signal())
    await source.send(codingSession, input('three', '回到第一个目录', first), signal())
    await source.send(codingSession, input('four', '回到 SuperHub 目录'), signal())
    expect(h.calls.map(call => [call.spec.cwd, call.resume])).toEqual([[first, undefined], [second, undefined], [first, 'thread-1'], [expect.stringContaining(join(root, 'work', 'superhub-v2')), undefined]])
    // thread/resume would silently move the thread to the new cwd; the second directory got its own thread instead.
    expect(h.calls[1]!.methods).toContain('thread/start')
    expect(Object.keys(journalOf(root).native).sort()).toEqual([first, second, expect.stringMatching(/^work\/superhub-v2\//)].sort())
    // A continued thread already carrying the title is not renamed; another title is set again.
    expect(h.calls[2]!.methods).not.toContain('thread/name/set')
    await source.send({...codingSession, title: '首页改版二期'}, input('five', '改名后', first), signal())
    expect(h.calls[4]!.methods).toContain('thread/name/set')
    expect(h.names.get('thread-1')).toBe('字节 Landing · 首页改版二期')
    source.dispose()
  })

  it('refuses before starting the tool when the directory became unusable, and carries words merged while waiting', async () => {
    const root = temp(), project = temp()
    const h = cliHost((_spec, _prompt, {say}) => { say({type: 'turn.completed'}); return 0 })
    const source = createV2DialogueSource({ctx: h.ctx, root, scope: 'brain', codex: {executable: process.execPath}})
    const refused = await source.send(codingSession, input('one', '改首页', join(project, 'gone')), signal()).catch(error => error)
    expect(refused).toMatchObject({dispatched: false, message: expect.stringContaining('项目目录不可用')})
    expect(h.calls).toHaveLength(0)
    expect(existsSync(join(project, 'gone'))).toBe(false)
    await source.send(codingSession, input('two', '改首页', project, {merged: [{id: 'extra', text: '顺便改页脚'}]}), signal())
    expect(h.calls[0]!.prompt).toMatch(/改首页[\s\S]*〔主人〕顺便改页脚/)
    source.dispose()
  })

  it('reports SuperHub\'s own directory for an order without creating it, as the next turn will use it', async () => {
    const root = temp()
    const h = cliHost((_spec, _prompt, {say}) => { say({type: 'turn.completed'}); return 0 })
    const source = createV2DialogueSource({ctx: h.ctx, root, scope: 'brain', codex: {executable: process.execPath}})
    const area = dialogueKey('brain', 'w1'), room = dialogueKey(area, 's1')
    const two = {...codingSession, delegationIds: ['d1', 'd2']}
    expect(source.workDirectory!(two, 'd1')).toBe(join(root, 'work', 'superhub-v2', area, room))
    expect(existsSync(join(root, 'work'))).toBe(false)
    await source.send(two, input('one', '第一轮'), signal())
    expect(h.calls[0]!.spec.cwd).toBe(source.workDirectory!(two, 'd1'))
    // A later order of the session has a sibling copy.
    expect(source.workDirectory!(two, 'd2')).toBe(join(root, 'work', 'superhub-v2', area, dialogueKey(area, 's1', 'order', 'd2')))
    expect(source.workDirectory!({...codingSession, kind: 'group', executor: 'dsh'}, 'd1')).toBeUndefined()
    source.dispose()
  })

  it('names Claude Code sessions with --name on every run', async () => {
    const root = temp(), project = temp()
    const h = cliHost((_spec, _prompt, {say}) => {
      say({type: 'system', subtype: 'init', session_id: 'c1'})
      say({type: 'result', subtype: 'success', is_error: false, result: '好', session_id: 'c1', num_turns: 1})
      return 0
    })
    const source = createV2DialogueSource({ctx: h.ctx, root, scope: 'brain', claudeExecutable: process.execPath})
    const claude = {...codingSession, executor: 'claude-code' as const}
    await source.send(claude, input('one', '看看项目', project), signal())
    await source.send(claude, input('two', '继续', project), signal())
    for (const call of h.calls) expect(call.spec.argv.slice(call.spec.argv.indexOf('--name'), call.spec.argv.indexOf('--name') + 2)).toEqual(['--name', '字节 Landing · 首页改版'])
    expect(h.calls[1]!.resume).toBe('c1')
    expect(h.calls[0]!.spec.cwd).toBe(project)
    source.dispose()
  })
})
