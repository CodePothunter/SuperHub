#!/usr/bin/env node
/**
 * Clean up what acceptance runs left in the owner's Codex and Claude Code homes (SuperHub task 11-23, R6).
 *
 *   node scripts/cleanup-acceptance-traces.mjs            # list only (default; reads, changes nothing)
 *   node scripts/cleanup-acceptance-traces.mjs --apply    # delete what was listed (config.toml is backed up first)
 *
 * Options: --home <dir> (default: your home), --codex-home <dir> (default <home>/.codex), --claude-dir <dir>
 * (default <home>/.claude), --codex-bin <path> (default `codex`), --skip-codex-threads, --backup (pack the Claude
 * directories into a tarball before deleting them; off by default, the owner's disk is small).
 *
 * Acceptance roots are /tmp, /dev/shm and <home>/.cache/chief-acceptance. Only normalized paths strictly below a root
 * count (an acceptance run always works in its own subdirectory); the root itself, e.g. a session the owner started in
 * /tmp, and paths such as /tmp/../home/me are never selected. The cleanup handles the following test traces:
 * - Codex threads, active and already archived, whose working directory lies below an acceptance root and that are
 *   ours: the first message starts with SuperHub's fixed instructions, or the directory's first component below the
 *   root is one of our own test directories (`TEST_DIR_PREFIXES`). Deleted through `codex app-server`
 *   (`thread/delete`, which removes the rollout file and the thread's index entry); a rollout file that is still there
 *   afterwards is removed when it is a regular file inside <codex-home>/sessions or archived_sessions (symlinks resolved). Not restorable. Other
 *   threads in a temporary directory, and SuperHub threads elsewhere, are only listed.
 * - Claude Code project directories in <claude-dir>/projects named after a path below an acceptance root and that are
 *   ours: every working directory their session files recorded is one of our test directories (with none recorded, the
 *   name says so). Removed (a symlink is never followed). Others there are only listed. With --backup they are first
 *   packed into <home>/.local/state/superhub/recovery/claude-test-sessions-<time>.tar.gz (0600) and checked against the
 *   directories' files. A name that only looks like one (the encoding is lossy: `/tmp-x` and `/tmp/x` share it) whose
 *   sessions recorded another directory is only listed.
 * - `[projects."<path>"]` trust entries in <codex-home>/config.toml below an acceptance root: the file is copied to
 *   config.toml.bak-<time> (0600), then rewritten atomically without those sections; every other byte stays as it was.
 *
 * Exit code 1 when anything could not be listed or applied.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

/** How SuperHub's coding prompts have begun (current and earlier versions). */
export const SUPERHUB_PREFIXES = ['你在独立的工作区会话中', '你在主人的项目目录中工作（就是当前工作目录）']
/** Thread sources SuperHub threads come from: `exec` (codex exec era), `vscode` / `appServer` (app-server era). */
export const SOURCE_KINDS = ['exec', 'vscode', 'appServer', 'cli', 'unknown']

/**
 * Our own test directories, as the first path component below an acceptance root (`/tmp/od-spike-work.X`,
 * `/tmp/chief-accept-AbC123`): a thread working there is a test even when its first message is not SuperHub's prompt.
 * The component must be longer than the prefix. Generic words carry the `.` of `mktemp -t <name>.XXXXXX`, so an owner's
 * `/tmp/resume-check` or `/tmp/spike-workshop` is not taken for ours.
 */
export const TEST_DIR_PREFIXES = ['chief-accept-', 'chief-run-as-owner-', 'chief-order-dialogue-', 'od-spike', 'od-t-', 'pd-spike',
  'spike-work.', 'spike-json.', 'resume-check.', 'codex-tier-probe', 'codex-hook-script']
/** Test directories with an exact name: the `TMPDIR` of earlier acceptance runs (`/dev/shm/od-tmp`, `/dev/shm/od-tmp3`). */
export const TEST_DIR_NAMES = [/^od-tmp\d*$/]

export const acceptanceRoots = home => ['/tmp', '/dev/shm', join(home, '.cache', 'chief-acceptance')].map(root => root.replace(/\/+$/, ''))
/**
 * Strictly below `root` (by path segment): `/tmp/x` is, `/tmp`, `/tmp/` and `/tmpx` are not. Only a normalized absolute
 * path counts: `/tmp/../home/me` or `/tmp/./x` is never below a root.
 */
const below = (path, root) => typeof path === 'string' && posix.normalize(path) === path && path.startsWith(root + '/') && path.length > root.length + 1
export const underAcceptanceRoot = (path, roots) => roots.some(root => below(path, root))
const testComponent = first => TEST_DIR_PREFIXES.some(prefix => first.length > prefix.length && first.startsWith(prefix)) || TEST_DIR_NAMES.some(name => name.test(first))
/** The path lies below an acceptance root in one of our own test directories (see `TEST_DIR_PREFIXES`). */
export const inTestDirectory = (path, roots) => roots.some(root => below(path, root) && testComponent(path.slice(root.length + 1).split('/')[0]))
export const isSuperhubPreview = preview => typeof preview === 'string' && SUPERHUB_PREFIXES.some(prefix => preview.trimStart().startsWith(prefix))

/** Claude Code names a project directory after its path with every character other than [A-Za-z0-9] turned into `-`. */
export const claudeProjectName = path => path.replace(/[^A-Za-z0-9]/g, '-')
/** Named after a path strictly below an acceptance root (never the root itself, such as `-tmp` for /tmp). */
export const isClaudeAcceptanceDir = (name, roots) => roots.some(root => {
  const encoded = claudeProjectName(root) + '-'
  return name.startsWith(encoded) && name.length > encoded.length
})
/**
 * Named after one of our test directories below an acceptance root (`inTestDirectory` on the encoded name). Used only
 * for a directory whose session files recorded no working directory; otherwise the recorded one decides.
 */
export const isClaudeTestDirName = (name, roots) => roots.some(root => {
  const encoded = claudeProjectName(root) + '-'
  if (!name.startsWith(encoded)) return false
  const rest = name.slice(encoded.length), parts = rest.split('-')
  return TEST_DIR_PREFIXES.some(prefix => rest.length > prefix.length && rest.startsWith(claudeProjectName(prefix)))
    // An exact name followed by more (`od-tmp3-chief-…`): the encoding hides where the component ended.
    || TEST_DIR_NAMES.some(pattern => parts.some((_, at) => at + 1 < parts.length && pattern.test(parts.slice(0, at + 1).join('-'))))
})

/** The working directories the session files of a Claude project directory began in (first `cwd` of each file). */
export function claudeRecordedCwds(dir, limit = 256 * 1024) {
  const cwds = new Set()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const fd = openSync(join(dir, file), 'r')
    let text
    try {
      const buffer = Buffer.alloc(limit)
      text = buffer.subarray(0, readSync(fd, buffer, 0, limit, 0)).toString('utf8')
    } finally { closeSync(fd) }
    const match = text.match(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/)
    if (match) try { cwds.add(JSON.parse(match[1])) } catch { /* not a cwd we can read */ }
  }
  return [...cwds]
}

/** Every entry below `names` in `parent` (relative paths), with size and mtime: what a backup must hold. */
function snapshot(parent, names) {
  const entries = new Map()
  const walk = relative => {
    const stat = lstatSync(join(parent, relative))
    entries.set(relative, `${stat.isDirectory() ? 'd' : stat.size}:${stat.mtimeMs}`)
    if (stat.isDirectory()) for (const child of readdirSync(join(parent, relative))) walk(relative + '/' + child)
  }
  for (const name of names) walk(name)
  return entries
}

const sha256 = text => createHash('sha256').update(text).digest('hex')
const stamp = (at = new Date()) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

// ——— config.toml ———

const HEADER = /^\s*\[/
const PROJECT_HEADER = /^\s*\[\s*projects\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*(?:#.*)?$/
/** A single-line `key = value` (no multi-line strings or arrays). */
const SIMPLE_KEY = /^\s*[A-Za-z0-9_"'.-][^=]*=\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.+:-]+)\s*(?:#.*)?$/
const unescape = value => value.replace(/\\(["\\])/g, '$1')
const COMMENT = /^\s*#/

/** For each line, whether it begins inside a multi-line string (so a `[...]` line there is no table header). */
function inMultilineString(lines) {
  const inside = []
  let open = null
  for (const raw of lines) {
    inside.push(open !== null)
    const line = raw.replace(/\r?\n$/, '')
    let at = 0
    while (at < line.length) {
      if (open) {
        const close = line.indexOf(open, at)
        if (close < 0) break
        open = null
        at = close + 3
        continue
      }
      if (line[at] === '#') break
      if (line.startsWith('"""', at) || line.startsWith("'''", at)) { open = line.slice(at, at + 3); at += 3; continue }
      if (line[at] === '"') {
        at++
        while (at < line.length && line[at] !== '"') at += line[at] === '\\' ? 2 : 1
        at++
        continue
      }
      if (line[at] === "'") { const close = line.indexOf("'", at + 1); at = close < 0 ? line.length : close + 1; continue }
      at++
    }
  }
  return inside
}

/**
 * Plan the removal of `[projects."<path>"]` sections whose path is below an acceptance root. A section is its header
 * and the lines after it up to the next table header; comment lines that only lead up to the next header (or the end
 * of the file) introduce what follows and stay. Lines inside multi-line strings are never taken for headers. Returns
 * the kept text, which is the original with exactly those line ranges taken out.
 */
export function planConfig(text, roots) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const plain = at => lines[at].replace(/\r?\n$/, '')
  const quoted = inMultilineString(lines)
  const header = at => !quoted[at] && HEADER.test(plain(at))
  const sections = []
  for (let at = 0; at < lines.length; at++) {
    const match = !quoted[at] && plain(at).match(PROJECT_HEADER)
    if (!match) continue
    const path = match[1] !== undefined ? unescape(match[1]) : match[2]
    let end = at + 1
    while (end < lines.length) {
      if (header(end)) break
      if (COMMENT.test(plain(end))) {
        let look = end
        while (look < lines.length && !header(look) && (COMMENT.test(plain(look)) || !plain(look).trim())) look++
        if (look >= lines.length || header(look)) break
      }
      end++
    }
    sections.push({ path, start: at, end, temporary: underAcceptanceRoot(path, roots) })
  }
  const remove = sections.filter(section => section.temporary)
  const problems = []
  for (const section of remove) {
    for (const line of lines.slice(section.start + 1, section.end)) {
      const plain = line.replace(/\r?\n$/, '')
      if (plain.trim() && !COMMENT.test(plain) && !SIMPLE_KEY.test(plain)) problems.push(`[projects."${section.path}"] 含有无法逐行处理的内容：${plain.slice(0, 80)}`)
    }
  }
  const dropped = new Set(remove.flatMap(section => Array.from({ length: section.end - section.start }, (_, index) => section.start + index)))
  const kept = lines.filter((_, index) => !dropped.has(index)).join('')
  return { sections, remove, keep: sections.filter(section => !section.temporary), problems, text: kept, lines }
}

/** The kept text is the original minus the removed ranges, and no removed header survives; otherwise an error. */
export function verifyConfig(original, plan, roots) {
  const removedText = plan.remove.map(section => plan.lines.slice(section.start, section.end).join(''))
  const rebuilt = []
  let cursor = 0
  for (const section of plan.remove) {
    rebuilt.push(plan.lines.slice(cursor, section.start).join(''))
    cursor = section.end
  }
  rebuilt.push(plan.lines.slice(cursor).join(''))
  if (rebuilt.join('') !== plan.text) throw Error('config.toml 的改写结果与“原文减去这些条目”不一致，未写入')
  if (plan.text.length + removedText.join('').length !== original.length) throw Error('config.toml 的改写长度不符，未写入')
  const again = planConfig(plan.text, roots)
  if (again.remove.length) throw Error('config.toml 改写后仍有临时目录的信任条目，未写入')
  const headers = text => (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).filter(line => HEADER.test(line))
  const expected = headers(original).filter(line => !plan.remove.some(section => plan.lines[section.start] === line))
  if (JSON.stringify(headers(plan.text)) !== JSON.stringify(expected)) throw Error('config.toml 改写后其余表头有变化，未写入')
}

function writeAtomically(file, content, mode) {
  const temporary = join(dirname(file), '.' + randomUUID() + '.tmp')
  try {
    writeFileSync(temporary, content, { mode, flag: 'wx' })
    chmodSync(temporary, mode)
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

// ——— Codex app-server ———

function appServer(bin, codexHome, cwd) {
  const child = spawn(bin, ['app-server', '--stdio'], { cwd, env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'] })
  let serial = 0, stderr = ''
  const waiting = new Map()
  const fail = error => {
    for (const { reject, timer } of waiting.values()) { clearTimeout(timer); reject(error) }
    waiting.clear()
  }
  const exited = new Promise(resolve => {
    child.once('close', code => {
      fail(Error('codex app-server 已退出（' + code + '）' + (stderr ? '：' + stderr.trim().split('\n').at(-1) : '')))
      resolve(code)
    })
    // A binary that cannot start never closes.
    child.once('error', error => { fail(Error('无法启动 ' + bin + '：' + error.message)); resolve(null) })
  })
  child.stdin.on('error', () => {})
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
  createInterface({ input: child.stdout }).on('line', line => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    if (frame.id === undefined || !waiting.has(frame.id)) return
    const { resolve, reject, timer } = waiting.get(frame.id)
    clearTimeout(timer)
    waiting.delete(frame.id)
    if (frame.error) reject(Object.assign(Error(frame.error.message ?? 'JSON-RPC 错误'), { code: frame.error.code }))
    else resolve(frame.result)
  })
  const send = frame => child.stdin.write(JSON.stringify(frame) + '\n')
  function request(method, params, timeout = 60_000) {
    const id = ++serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(Error(method + ' 超时')) }, timeout)
      waiting.set(id, { resolve, reject, timer })
      send({ id, method, params })
    })
  }
  return {
    async start() {
      await request('initialize', { clientInfo: { name: 'superhub-cleanup', title: null, version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } })
      send({ method: 'initialized' })
    },
    request,
    async close() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    },
  }
}

/** Every thread of the listed source kinds: the active ones, or with `archived` only the archived ones. */
async function listThreads(server, archived) {
  const threads = []
  let cursor = null
  for (let page = 0; page < 1000; page++) {
    const result = await server.request('thread/list', { sourceKinds: SOURCE_KINDS, limit: 100, useStateDbOnly: true, archived, ...(cursor && { cursor }) })
    threads.push(...(result?.data ?? []).map(thread => ({ ...thread, archived })))
    cursor = result?.nextCursor
    if (!cursor) return threads
  }
  throw Error('thread/list 翻页超过上限')
}

/** A rollout file of `codexHome`: a regular `.jsonl` file strictly inside its sessions or archived_sessions directory. */
export function codexRollout(path, codexHome) {
  if (typeof path !== 'string' || !path.endsWith('.jsonl')) return false
  const file = resolve(path)
  return ['sessions', 'archived_sessions'].some(dir => file.startsWith(resolve(codexHome, dir) + sep))
}

/** Also after resolving symlinks: the rollout's directory really lies inside the Codex home's session directories. */
function realRollout(path, codexHome) {
  const parent = realpathSync(dirname(resolve(path)))
  return ['sessions', 'archived_sessions'].some(dir => {
    const root = join(codexHome, dir)
    return existsSync(root) && !lstatSync(root).isSymbolicLink() && (parent + sep).startsWith(realpathSync(root) + sep)
  })
}

// ——— Main ———

export async function cleanup({ apply = false, home = homedir(), codexHome = join(home, '.codex'), claudeDir = join(home, '.claude'),
  codexBin = 'codex', skipCodexThreads = false, backup = false, now = new Date(), print = line => console.log(line) } = {}) {
  const roots = acceptanceRoots(home)
  const failures = []
  const at = stamp(now)
  const summary = { apply, roots, codex: undefined, claude: undefined, config: undefined, failures }
  print((apply ? '执行清理' : '只列出，不改动（加 --apply 才执行）') + '。验收临时目录（只处理其下的子目录，不含目录本身）：' + roots.join('、'))

  // Codex threads.
  if (skipCodexThreads) print('\n【Codex 会话】已跳过（--skip-codex-threads）')
  else {
    const codex = { total: 0, archivedTotal: 0, superhub: 0, selected: [], elsewhere: [], otherTemporary: [], deleted: 0, rolloutsRemoved: 0, failed: [] }
    summary.codex = codex
    let server
    try {
      server = appServer(codexBin, codexHome, home)
      await server.start()
      // Each thread once, even if a Codex version ignored `archived` and listed it in both.
      const threads = [...new Map([...await listThreads(server, false), ...await listThreads(server, true)].map(thread => [thread.id, thread])).values()]
      codex.total = threads.length
      codex.archivedTotal = threads.filter(thread => thread.archived).length
      for (const thread of threads) {
        const superhub = isSuperhubPreview(thread.preview)
        if (superhub) codex.superhub++
        const row = { id: thread.id, cwd: thread.cwd, archived: thread.archived, source: typeof thread.source === 'string' ? thread.source : JSON.stringify(thread.source),
          createdAt: thread.createdAt, ...(typeof thread.path === 'string' && { path: thread.path }) }
        if (underAcceptanceRoot(thread.cwd, roots)) {
          // Ours: SuperHub's prompt, or one of our own test directories. Anything else there is only shown.
          if (superhub || inTestDirectory(thread.cwd, roots)) codex.selected.push({ ...row, reason: superhub ? 'superhub' : 'test-dir' })
          else codex.otherTemporary.push({ ...row, preview: String(thread.preview ?? '').slice(0, 40) })
        } else if (superhub) codex.elsewhere.push(row)
      }
      if (apply) {
        for (const row of codex.selected) {
          try { await server.request('thread/delete', { threadId: row.id }); codex.deleted++ }
          catch (error) { codex.failed.push({ id: row.id, error: error.message }); continue }
          // thread/delete removes the rollout; whatever is left of it inside the Codex home goes too.
          try {
            if (row.path && codexRollout(row.path, codexHome) && existsSync(row.path) && lstatSync(row.path).isFile() && realRollout(row.path, codexHome)) {
              rmSync(row.path)
              codex.rolloutsRemoved++
            }
          } catch (error) { codex.failed.push({ id: row.id, error: '会话已删除，残留的记录文件未能删除：' + error.message }) }
        }
      }
    } catch (error) {
      failures.push('Codex 会话：' + error.message)
    } finally {
      await server?.close().catch(() => {})
    }
    if (codex.failed.length) failures.push(`Codex 会话：${codex.failed.length} 场删除失败`)
    const archivedSelected = codex.selected.filter(row => row.archived).length
    print(`\n【Codex 会话】共列出 ${codex.total} 场（来源 ${SOURCE_KINDS.join('、')}，含已归档 ${codex.archivedTotal} 场），其中 SuperHub 会话 ${codex.superhub} 场`)
    print(`  在验收临时目录、属于验收测试：${codex.selected.length} 场（其中已归档 ${archivedSelected} 场，按测试目录名认定 ${codex.selected.filter(row => row.reason === 'test-dir').length} 场）`
      + (apply ? `，已删除 ${codex.deleted} 场` + (codex.rolloutsRemoved ? `（另删残留记录文件 ${codex.rolloutsRemoved} 个）` : '') + (codex.failed.length ? `，失败 ${codex.failed.length} 场` : '') : '，将删除（不可恢复）'))
    for (const row of codex.selected.slice(0, 5)) print(`    ${row.id}  ${row.cwd}${row.archived ? '  （已归档）' : ''}`)
    if (codex.selected.length > 5) print(`    ……另有 ${codex.selected.length - 5} 场`)
    print(`  SuperHub 会话在其他目录（只列出，不处理）：${codex.elsewhere.length} 场`)
    for (const row of codex.elsewhere.slice(0, 10)) print(`    ${row.id}  ${row.cwd}${row.archived ? '  （已归档）' : ''}`)
    if (codex.elsewhere.length > 10) print(`    ……另有 ${codex.elsewhere.length - 10} 场`)
    print(`  临时目录中其他的会话（不是 SuperHub 开头、也不在我们的测试目录，只列出，不处理）：${codex.otherTemporary.length} 场`)
    for (const row of codex.otherTemporary.slice(0, 10)) print(`    ${row.id}  ${row.cwd}  「${row.preview}」`)
    if (codex.otherTemporary.length > 10) print(`    ……另有 ${codex.otherTemporary.length - 10} 场`)
    for (const row of codex.failed.slice(0, 5)) print(`    删除失败 ${row.id}：${row.error}`)
  }

  // Claude Code project directories.
  const claude = { directories: [], elsewhere: [], otherTemporary: [], sessions: 0, backup: undefined, removed: 0 }
  summary.claude = claude
  try {
    const projects = join(claudeDir, 'projects')
    const names = existsSync(projects) ? readdirSync(projects, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort() : []
    claude.total = names.length
    for (const name of names.filter(name => isClaudeAcceptanceDir(name, roots))) {
      // The name is lossy (`/tmp-x` and `/tmp/x` look alike): a session that recorded another directory is not a test.
      const cwds = claudeRecordedCwds(join(projects, name))
      const other = cwds.find(cwd => !underAcceptanceRoot(cwd, roots))
      if (other !== undefined) claude.elsewhere.push({ name, cwd: other })
      // Ours only: every recorded directory is one of our test directories (or, with none recorded, the name says so).
      // Anything else in a temporary directory may be the owner's own session there: only listed, like Codex's.
      else if (cwds.length ? cwds.every(cwd => inTestDirectory(cwd, roots)) : isClaudeTestDirName(name, roots)) claude.directories.push(name)
      else claude.otherTemporary.push({ name, cwd: cwds.find(cwd => !inTestDirectory(cwd, roots)) ?? '' })
    }
    claude.sessions = claude.directories.reduce((sum, name) => sum + readdirSync(join(projects, name)).filter(file => file.endsWith('.jsonl')).length, 0)
    if (apply && claude.directories.length && backup) {
      const recovery = join(home, '.local', 'state', 'superhub', 'recovery')
      mkdirSync(recovery, { recursive: true, mode: 0o700 })
      const archive = join(recovery, `claude-test-sessions-${at}.tar.gz`)
      const before = snapshot(projects, claude.directories)
      // Private from the first byte; a failed or incomplete backup is removed and nothing is deleted.
      writeFileSync(archive, '', { mode: 0o600, flag: 'wx' })
      try {
        execFileSync('tar', ['-czf', archive, '-C', projects, '--', ...claude.directories], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
        chmodSync(archive, 0o600)
        const listed = new Set(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').map(line => line.replace(/\/+$/, '')))
        const missing = [...before.keys()].filter(path => !listed.has(path))
        if (missing.length) throw Error('备份包缺少 ' + missing.slice(0, 3).join('、') + '，未删除任何目录')
        const after = snapshot(projects, claude.directories)
        if (after.size !== before.size || [...before].some(([path, value]) => after.get(path) !== value)) throw Error('打包期间这些目录有变化（可能有验收正在运行），未删除任何目录')
      } catch (error) {
        rmSync(archive, { force: true })
        throw error
      }
      claude.backup = archive
    }
    if (apply && claude.directories.length) {
      for (const name of claude.directories) {
        rmSync(join(projects, name), { recursive: true, force: true })
        if (!existsSync(join(projects, name))) claude.removed++
      }
      if (claude.removed !== claude.directories.length) failures.push(`Claude 会话目录：${claude.directories.length - claude.removed} 个未能删除`)
    }
  } catch (error) {
    failures.push('Claude 会话目录：' + error.message)
  }
  print(`\n【Claude Code 会话目录】${join(claudeDir, 'projects')} 下共 ${claude.total ?? 0} 个，其中以验收临时目录命名的 ${claude.directories.length} 个（${claude.sessions} 个会话文件）`
    + (apply ? (claude.directories.length ? (claude.backup ? `，已备份到 ${claude.backup} 并删除 ${claude.removed} 个` : `，已删除 ${claude.removed} 个`) : '')
      : backup ? '，将先打包备份再删除' : '，将删除（不备份；需要备份请加 --backup）'))
  for (const name of claude.directories.slice(0, 5)) print(`    ${name}`)
  if (claude.directories.length > 5) print(`    ……另有 ${claude.directories.length - 5} 个`)
  if (claude.elsewhere.length) {
    print(`  名称像验收目录、但会话记录的工作目录不在其下（只列出，不处理）：${claude.elsewhere.length} 个`)
    for (const row of claude.elsewhere.slice(0, 10)) print(`    ${row.name}  ${row.cwd}`)
  }
  if (claude.otherTemporary.length) {
    print(`  临时目录中其他的会话目录（不在我们的测试目录，只列出，不处理）：${claude.otherTemporary.length} 个`)
    for (const row of claude.otherTemporary.slice(0, 10)) print(`    ${row.name}${row.cwd ? '  ' + row.cwd : ''}`)
  }

  // Codex trust entries.
  const config = { file: join(codexHome, 'config.toml'), entries: [], kept: [], backup: undefined, written: false }
  summary.config = config
  try {
    if (existsSync(config.file)) {
      const original = readFileSync(config.file, 'utf8')
      const plan = planConfig(original, roots)
      config.entries = plan.remove.map(section => section.path)
      config.kept = plan.keep.map(section => section.path)
      if (plan.problems.length) throw Error(plan.problems.join('；'))
      verifyConfig(original, plan, roots)
      if (apply && plan.remove.length) {
        // Renaming over a symlink would replace the link with a plain file.
        if (lstatSync(config.file).isSymbolicLink()) throw Error('config.toml 是符号链接，未改写（请对链接目标运行，或手动处理）')
        const mode = statSync(config.file).mode & 0o777
        config.backup = `${config.file}.bak-${at}`
        copyFileSync(config.file, config.backup, constants.COPYFILE_EXCL)
        chmodSync(config.backup, 0o600)
        if (sha256(readFileSync(config.backup, 'utf8')) !== sha256(original) || sha256(readFileSync(config.file, 'utf8')) !== sha256(original)) {
          rmSync(config.backup, { force: true })
          config.backup = undefined
          throw Error('config.toml 在处理期间被改动，未写入')
        }
        writeAtomically(config.file, plan.text, mode)
        if (readFileSync(config.file, 'utf8') !== plan.text) throw Error('config.toml 写入后读回不一致，请用备份 ' + config.backup + ' 还原')
        config.written = true
      }
    }
  } catch (error) {
    failures.push('config.toml：' + error.message)
  }
  print(`\n【Codex 信任条目】${config.file}：共 ${config.entries.length + config.kept.length} 条 [projects]，指向验收临时目录的 ${config.entries.length} 条`
    + (apply ? (config.written ? `，已备份到 ${config.backup} 并删除` : '') : '，将先备份再删除（其余内容逐字保留）'))
  for (const path of config.entries.slice(0, 5)) print(`    ${path}`)
  if (config.entries.length > 5) print(`    ……另有 ${config.entries.length - 5} 条`)
  print(`  保留：${config.kept.length} 条` + (config.kept.length ? '（' + config.kept.slice(0, 5).join('、') + (config.kept.length > 5 ? '……' : '') + '）' : ''))

  if (apply && !failures.length) {
    print('\n恢复方法：Codex 会话和 Claude 目录已删除，不能恢复' + (claude.backup ? '（Claude 目录可用 `tar -xzf ' + claude.backup + ' -C ' + join(claudeDir, 'projects') + '` 还原）' : '')
      + (config.backup ? '；config.toml 可从 ' + config.backup + ' 复制回去。' : '。'))
  }
  if (failures.length) {
    print('\n未完成：')
    for (const failure of failures) print('  ' + failure)
  } else print('\n' + (apply ? '清理完成。' : '列出完成，没有改动任何文件。'))
  return summary
}

function parseArgs(argv) {
  const options = { apply: false }
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]
    const value = () => { const next = argv[++at]; if (!next) throw Error(arg + ' 需要一个值'); return next }
    if (arg === '--apply') options.apply = true
    else if (arg === '--skip-codex-threads') options.skipCodexThreads = true
    else if (arg === '--backup') options.backup = true
    else if (arg === '--home') options.home = value()
    else if (arg === '--codex-home') options.codexHome = value()
    else if (arg === '--claude-dir') options.claudeDir = value()
    else if (arg === '--codex-bin') options.codexBin = value()
    else throw Error('未知参数 ' + arg)
  }
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options
  try { options = parseArgs(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exit(2) }
  const summary = await cleanup(options)
  process.exitCode = summary.failures.length ? 1 : 0
}
