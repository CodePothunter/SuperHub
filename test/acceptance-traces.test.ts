import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeLoginSettings, codexModelConfig, isolateToolHomes, sweepStaleHomes, withoutToolEnv } from '../scripts/acceptance-homes.mjs'
import { claudeProjectName, codexRollout, inTestDirectory, isClaudeAcceptanceDir, isClaudeTestDirName, planConfig, underAcceptanceRoot, verifyConfig } from '../scripts/cleanup-acceptance-traces.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/cleanup-acceptance-traces.mjs', import.meta.url))
const roots: string[] = []
function temp(prefix = 'chief-traces-') { const path = mkdtempSync(join(tmpdir(), prefix)); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, {recursive: true, force: true}) })
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const mode = (file: string) => statSync(file).mode & 0o777

/**
 * A stand-in for `codex app-server --stdio`: threads in a JSON file, `thread/list` pages of two (active or, with
 * `archived: true`, archived only), `thread/delete` removing the thread and its rollout file (unless `keepFile`).
 */
const FAKE_APP_SERVER = `
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const file = process.env.FAKE_CODEX_STATE, log = process.env.FAKE_CODEX_LOG
if (process.argv[2] !== 'app-server' || process.argv[3] !== '--stdio') { console.error('unexpected argv ' + process.argv.slice(2)); process.exit(3) }
appendFileSync(log, JSON.stringify({codexHome: process.env.CODEX_HOME}) + '\\n')
const load = () => JSON.parse(readFileSync(file, 'utf8'))
const reply = frame => process.stdout.write(JSON.stringify(frame) + '\\n')
createInterface({input: process.stdin}).on('line', line => {
  const frame = JSON.parse(line)
  appendFileSync(log, JSON.stringify({method: frame.method, params: frame.params}) + '\\n')
  if (frame.id === undefined) return
  const state = load()
  if (frame.method === 'initialize') return reply({id: frame.id, result: {}})
  if (frame.method === 'thread/list') {
    const kinds = frame.params.sourceKinds?.length ? frame.params.sourceKinds : ['cli', 'vscode']
    const rows = state.threads.filter(row => !!row.archived === !!frame.params.archived && kinds.includes(row.kind))
    const from = Number(frame.params.cursor ?? 0), page = rows.slice(from, from + 2)
    return reply({id: frame.id, result: {data: page.map(({kind, archived, keepFile, ...thread}) => ({...thread, source: kind})), nextCursor: from + 2 < rows.length ? String(from + 2) : null, backwardsCursor: null}})
  }
  if (frame.method === 'thread/delete') {
    const row = state.threads.find(item => item.id === frame.params.threadId)
    if (!row || row.id.startsWith('fail')) return reply({id: frame.id, error: {code: -32600, message: 'no rollout found for thread id ' + frame.params.threadId}})
    state.threads = state.threads.filter(item => item !== row)
    if (row.path && !row.keepFile) rmSync(row.path, {force: true})
    writeFileSync(file, JSON.stringify(state))
    return reply({id: frame.id, result: {}})
  }
  reply({id: frame.id, error: {code: -32601, message: 'unknown method'}})
})
`

const SUPERHUB = '你在独立的工作区会话中直接回复。交付本会话生成的文本……'

function environment(extraThreads: object[] = []) {
  const home = temp('chief-traces-home-')
  const codexHome = join(home, '.codex'), claudeDir = join(home, '.claude'), projects = join(claudeDir, 'projects')
  mkdirSync(codexHome, {recursive: true})
  mkdirSync(projects, {recursive: true})
  const cache = join(home, '.cache', 'chief-acceptance')
  const threads = [
    {id: 'exec-tmp', kind: 'exec', cwd: '/tmp/chief-accept-a/brain/work/superhub-v2/x/y', preview: SUPERHUB},
    {id: 'app-shm', kind: 'vscode', cwd: '/dev/shm/od/chief-accept-b/brain', preview: '  ' + SUPERHUB},
    {id: 'app-cache', kind: 'appServer', cwd: join(cache, 'chief-accept-c/brain'), preview: '你在主人的项目目录中工作（就是当前工作目录），按项目……'},
    {id: 'superhub-real', kind: 'vscode', cwd: '/home/me/workspace/landing', preview: SUPERHUB},
    {id: 'owner-tmp', kind: 'cli', cwd: '/tmp/scratch', preview: '帮我看看这个脚本'},
    {id: 'prefix-sibling', kind: 'exec', cwd: '/tmpx/chief-accept-d', preview: SUPERHUB},
    {id: 'owner-real', kind: 'cli', cwd: '/home/me/workspace/landing', preview: '修复构建'},
    // A SuperHub thread in /tmp itself is not an acceptance run's (they always work in a subdirectory).
    {id: 'superhub-tmp-root', kind: 'exec', cwd: '/tmp', preview: SUPERHUB},
    {id: 'owner-shm-root', kind: 'cli', cwd: '/dev/shm', preview: '随便试试'},
    // Already archived by an earlier cleanup: deleted too.
    {id: 'archived-superhub', kind: 'vscode', archived: true, cwd: '/dev/shm/od-tmp3/chief-run-as-owner-1/chief-accept-e/brain', preview: SUPERHUB,
      path: join(codexHome, 'archived_sessions', 'rollout-archived-superhub.jsonl')},
    // Our own spikes and probes, whose first message is not SuperHub's: chosen by the test directory's name.
    {id: 'spike-plain', kind: 'vscode', archived: true, cwd: '/tmp/od-spike-work.MXpr', preview: '运行 `sleep 40`，然后回复'},
    {id: 'shm-tier', kind: 'exec', cwd: '/dev/shm/codex-tier-probe-1/w', preview: 'probe'},
    // Someone else's experiment in /tmp, and an archived thread of the owner's own project: never touched.
    {id: 'ark-work', kind: 'cli', cwd: '/tmp/ark-work-abc', preview: 'hello'},
    {id: 'archived-owner-real', kind: 'cli', archived: true, cwd: '/home/me/workspace/landing', preview: '旧的修复'},
    // thread/delete left the rollout behind: removed only when it lies inside the Codex home's session directories.
    {id: 'leftover', kind: 'appServer', cwd: '/tmp/pd-spike-1', preview: SUPERHUB, keepFile: true,
      path: join(codexHome, 'sessions', '2026', '11', '23', 'rollout-leftover.jsonl')},
    {id: 'outside', kind: 'appServer', cwd: '/tmp/chief-accept-o', preview: SUPERHUB, keepFile: true, path: join(home, 'elsewhere', 'rollout-outside.jsonl')},
    ...extraThreads,
  ]
  for (const row of threads as {path?: string}[]) if (row.path) {
    mkdirSync(dirname(row.path), {recursive: true})
    writeFileSync(row.path, '{}\n')
  }
  const state = join(home, 'fake-state.json'), log = join(home, 'fake-log.jsonl')
  writeFileSync(state, JSON.stringify({threads}))
  writeFileSync(log, '')
  const bin = join(home, 'fake-codex')
  writeFileSync(join(home, 'fake-codex.mjs'), FAKE_APP_SERVER)
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(home, 'fake-codex.mjs'))} "$@"\n`)
  chmodSync(bin, 0o755)
  const testDirs = ['-tmp-chief-accept-a-brain', '-dev-shm-od-tmp-chief-accept-b-brain', claudeProjectName(join(cache, 'chief-accept-c', 'brain'))]
  // The roots themselves (the owner's own sessions in /tmp live in `-tmp`) and a look-alike name whose sessions
  // recorded /tmp-lookalike (the encoding turns `/tmp-` and `/tmp/` into the same `-tmp-`) stay.
  // (The cache root's own name is checked in a unit case: this fake home lies in /tmp, so here it is below a root.)
  // The owner's own sessions in a temporary directory are not ours either: by recorded cwd (`-tmp-scratch`,
  // `-tmp-resume-check-x` = /tmp/resume-check, not a `mktemp` name) or, with none recorded, by name (`-dev-shm-notes`).
  const keptDirs = ['-home-me-workspace-landing', '-tmpx-chief-accept-d', '-home-me', '-tmp', '-dev-shm', '-tmp-lookalike', '-tmp-scratch',
    '-tmp-resume-check-x', '-dev-shm-notes']
  for (const name of [...testDirs, ...keptDirs]) {
    mkdirSync(join(projects, name, 'memory'), {recursive: true})
    writeFileSync(join(projects, name, 'session-1.jsonl'), '{"type":"custom-title","customTitle":"' + name + '"}\n')
  }
  writeFileSync(join(projects, '-tmp-chief-accept-a-brain', 'session-2.jsonl'), '{"type":"user","cwd":"/tmp/chief-accept-a/brain","message":{}}\n')
  writeFileSync(join(projects, '-tmp-lookalike', 'session-2.jsonl'), '{"type":"user","cwd":"/tmp-lookalike","message":{}}\n')
  writeFileSync(join(projects, '-tmp-scratch', 'session-2.jsonl'), '{"type":"user","cwd":"/tmp/scratch","message":{}}\n')
  writeFileSync(join(projects, '-tmp-resume-check-x', 'session-2.jsonl'), '{"type":"user","cwd":"/tmp/resume-check/x","message":{}}\n')
  writeFileSync(join(projects, '-tmp', 'sessions-index.json'), '{}')
  writeFileSync(join(projects, 'stray-file.json'), '{}')
  const config = [
    '# owner settings',
    'model = "gpt-6.2-sol"',
    'model_reasoning_effort = "high"',
    '',
    '[tui]',
    'theme = "dark"',
    '',
    '[projects."/home/me/workspace/landing"]',
    'trust_level = "trusted"',
    '',
    '[projects."/tmp"]',
    'trust_level = "trusted"',
    '',
    '[projects."/tmp/chief-accept-a/brain"]',
    'trust_level = "trusted"',
    '',
    "[projects.'/dev/shm/od/chief-accept-b/brain']",
    'trust_level = "trusted"   # added by codex',
    '',
    '# the next table is mine',
    '[projects."' + join(cache, 'chief-accept-c', 'brain') + '"]',
    'trust_level = "trusted"',
    '# keep this comment',
    '[mcp_servers.docs]',
    'command = "docs-mcp"',
    'args = ["--port", "1"]',
    '',
    '[projects."/tmpx/chief-accept-d"]',
    'trust_level = "trusted"',
    '',
    '[hooks.state."/tmp/chief-accept-a/.codex/hooks.json:x"]',
    'trusted_hash = "abc"',
    '',
    '[projects."/tmp/last-one/brain"]',
    'trust_level = "trusted"',
  ].join('\n') + '\n'
  writeFileSync(join(codexHome, 'config.toml'), config, {mode: 0o644})
  return {home, codexHome, claudeDir, projects, cache, state, log, bin, testDirs, keptDirs, config}
}

function run(env: ReturnType<typeof environment>, ...args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, '--home', env.home, '--codex-bin', env.bin, ...args], {
    encoding: 'utf8', env: {...process.env, FAKE_CODEX_STATE: env.state, FAKE_CODEX_LOG: env.log}, timeout: 60_000})
  return {status: result.status, out: result.stdout + result.stderr}
}
const requests = (env: ReturnType<typeof environment>) => readFileSync(env.log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
/** What sits next to config.toml (the session directories hold the fake rollouts). */
const configFiles = (env: {codexHome: string}) => readdirSync(env.codexHome).filter(name => !['sessions', 'archived_sessions'].includes(name))
const remaining = (env: ReturnType<typeof environment>) => (JSON.parse(readFileSync(env.state, 'utf8')).threads as {id: string}[]).map(row => row.id).sort()
const ALL_THREADS = ['app-cache', 'app-shm', 'archived-owner-real', 'archived-superhub', 'ark-work', 'exec-tmp', 'leftover', 'outside', 'owner-real', 'owner-shm-root',
  'owner-tmp', 'prefix-sibling', 'shm-tier', 'spike-plain', 'superhub-real', 'superhub-tmp-root']
const KEPT_THREADS = ['archived-owner-real', 'ark-work', 'owner-real', 'owner-shm-root', 'owner-tmp', 'prefix-sibling', 'superhub-real', 'superhub-tmp-root']

describe('cleanup-acceptance-traces', () => {
  it('lists by default and changes nothing', () => {
    const env = environment()
    const before = sha(join(env.codexHome, 'config.toml'))
    const {status, out} = run(env)
    expect(status).toBe(0)
    expect(out).toContain('只列出，不改动')
    expect(out).toContain('共列出 16 场（来源 exec、vscode、appServer、cli、unknown，含已归档 3 场），其中 SuperHub 会话 9 场')
    expect(out).toContain('在验收临时目录、属于验收测试：8 场（其中已归档 2 场，按测试目录名认定 2 场），将删除（不可恢复）')
    expect(out).toContain('SuperHub 会话在其他目录（只列出，不处理）：3 场')
    expect(out).toContain('临时目录中其他的会话（不是 SuperHub 开头、也不在我们的测试目录，只列出，不处理）：2 场')
    expect(out).toContain('/tmp/ark-work-abc  「hello」')
    expect(out).toContain('以验收临时目录命名的 3 个')
    expect(out).toContain('将删除（不备份；需要备份请加 --backup）')
    expect(out).toContain('但会话记录的工作目录不在其下（只列出，不处理）：1 个')
    expect(out).toContain('-tmp-lookalike  /tmp-lookalike')
    expect(out).toContain('临时目录中其他的会话目录（不在我们的测试目录，只列出，不处理）：3 个')
    expect(out).toContain('-tmp-scratch  /tmp/scratch')
    expect(out).toContain('共 7 条 [projects]，指向验收临时目录的 4 条')
    expect(out).toContain('列出完成，没有改动任何文件')
    expect(sha(join(env.codexHome, 'config.toml'))).toBe(before)
    expect(configFiles(env)).toEqual(['config.toml'])
    for (const name of [...env.testDirs, ...env.keptDirs]) expect(existsSync(join(env.projects, name))).toBe(true)
    expect(existsSync(join(env.home, '.local'))).toBe(false)
    const calls = requests(env)
    expect(calls[0]).toEqual({codexHome: env.codexHome})
    expect(calls.filter(row => row.method === 'thread/delete' || row.method === 'thread/archive')).toEqual([])
    // Every page asked for the exec-era threads too, both active and archived.
    const lists = calls.filter(row => row.method === 'thread/list')
    expect(lists.length).toBeGreaterThan(2)
    for (const row of lists) expect(row.params.sourceKinds).toEqual(expect.arrayContaining(['exec', 'vscode', 'appServer']))
    expect(new Set(lists.map(row => row.params.archived))).toEqual(new Set([false, true]))
    expect(remaining(env)).toEqual(ALL_THREADS)
    expect(existsSync(join(env.codexHome, 'sessions', '2026', '11', '23', 'rollout-leftover.jsonl'))).toBe(true)
  })

  it('deletes our test threads (archived ones too), removes Claude test directories, and drops only temporary trust entries', () => {
    const env = environment()
    const {status, out} = run(env, '--apply')
    expect(out).toContain('清理完成')
    expect(status).toBe(0)
    // Codex: only ours in an acceptance root, never the owner's, someone else's or a look-alike path.
    expect(remaining(env)).toEqual(KEPT_THREADS)
    expect(out).toContain('已删除 8 场（另删残留记录文件 1 个）')
    expect(requests(env).filter(row => row.method === 'thread/archive')).toEqual([])
    expect(existsSync(join(env.codexHome, 'archived_sessions', 'rollout-archived-superhub.jsonl'))).toBe(false)
    expect(existsSync(join(env.codexHome, 'sessions', '2026', '11', '23', 'rollout-leftover.jsonl'))).toBe(false)
    // A leftover path outside the Codex home's session directories is not ours to remove.
    expect(existsSync(join(env.home, 'elsewhere', 'rollout-outside.jsonl'))).toBe(true)
    // Claude: deleted without a backup by default.
    expect(out).toContain('已删除 3 个')
    expect(existsSync(join(env.home, '.local'))).toBe(false)
    expect(out).toContain('Codex 会话和 Claude 目录已删除，不能恢复；config.toml 可从 ')
    expect(readFileSync(join(env.projects, '-tmp', 'sessions-index.json'), 'utf8')).toBe('{}')
    for (const name of env.testDirs) expect(existsSync(join(env.projects, name))).toBe(false)
    for (const name of env.keptDirs) expect(readFileSync(join(env.projects, name, 'session-1.jsonl'), 'utf8')).toContain(name)
    expect(existsSync(join(env.projects, 'stray-file.json'))).toBe(true)
    // config.toml: a private byte-for-byte backup; the new file is the original without exactly those sections.
    const files = readdirSync(env.codexHome)
    const bak = files.find(name => name.startsWith('config.toml.bak-'))!
    expect(bak).toMatch(/^config\.toml\.bak-\d{8}T\d{6}Z$/)
    expect(readFileSync(join(env.codexHome, bak), 'utf8')).toBe(env.config)
    expect(mode(join(env.codexHome, bak))).toBe(0o600)
    expect(mode(join(env.codexHome, 'config.toml'))).toBe(0o644)
    expect(readFileSync(join(env.codexHome, 'config.toml'), 'utf8')).toBe([
      '# owner settings',
      'model = "gpt-6.2-sol"',
      'model_reasoning_effort = "high"',
      '',
      '[tui]',
      'theme = "dark"',
      '',
      '[projects."/home/me/workspace/landing"]',
      'trust_level = "trusted"',
      '',
      '[projects."/tmp"]',
      'trust_level = "trusted"',
      '',
      '# the next table is mine',
      '# keep this comment',
      '[mcp_servers.docs]',
      'command = "docs-mcp"',
      'args = ["--port", "1"]',
      '',
      '[projects."/tmpx/chief-accept-d"]',
      'trust_level = "trusted"',
      '',
      '[hooks.state."/tmp/chief-accept-a/.codex/hooks.json:x"]',
      'trusted_hash = "abc"',
      '',
    ].join('\n') + '\n')
    // A second run finds nothing left to do.
    const again = run(env, '--apply')
    expect(again.status).toBe(0)
    expect(again.out).toContain('属于验收测试：0 场')
    expect(again.out).toContain('以验收临时目录命名的 0 个')
    expect(again.out).toContain('指向验收临时目录的 0 条')
    expect(readdirSync(env.codexHome).filter(name => name.startsWith('config.toml.bak-'))).toHaveLength(1)
  })

  it('never follows a symlink out of the Codex session directories or the Claude projects directory', () => {
    const outside = temp('chief-traces-outside-')
    const env = environment([{id: 'linked', kind: 'appServer', cwd: '/tmp/chief-accept-l', preview: SUPERHUB, keepFile: true}])
    // A leftover rollout whose directory is a symlink to somewhere else.
    writeFileSync(join(outside, 'rollout-linked.jsonl'), '{}\n')
    symlinkSync(outside, join(env.codexHome, 'sessions', 'linked'))
    const state = JSON.parse(readFileSync(env.state, 'utf8'))
    state.threads.find((row: {id: string}) => row.id === 'linked').path = join(env.codexHome, 'sessions', 'linked', 'rollout-linked.jsonl')
    writeFileSync(env.state, JSON.stringify(state))
    // A Claude directory named like ours that is a symlink to a real directory.
    mkdirSync(join(outside, 'claude-target'))
    writeFileSync(join(outside, 'claude-target', 'keep.jsonl'), '{"cwd":"/tmp/chief-accept-z"}\n')
    symlinkSync(join(outside, 'claude-target'), join(env.projects, '-tmp-chief-accept-z'))
    const {status, out} = run(env, '--apply')
    expect(status).toBe(0)
    expect(out).toContain('已删除 9 场（另删残留记录文件 1 个）')
    expect(remaining(env)).toEqual(KEPT_THREADS)
    expect(readFileSync(join(outside, 'rollout-linked.jsonl'), 'utf8')).toBe('{}\n')
    expect(lstatSync(join(env.projects, '-tmp-chief-accept-z')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(outside, 'claude-target', 'keep.jsonl'), 'utf8')).toContain('chief-accept-z')
  })

  it('backs up the Claude test directories first only when asked with --backup', () => {
    const env = environment()
    const {status, out} = run(env, '--apply', '--backup', '--skip-codex-threads')
    expect(status).toBe(0)
    const recovery = join(env.home, '.local/state/superhub/recovery')
    const [backup] = readdirSync(recovery)
    expect(backup).toMatch(/^claude-test-sessions-\d{8}T\d{6}Z\.tar\.gz$/)
    expect(mode(join(recovery, backup!))).toBe(0o600)
    expect(out).toContain('已备份到 ' + join(recovery, backup!) + ' 并删除 3 个')
    const packed = spawnSync('tar', ['-tzf', join(recovery, backup!)], {encoding: 'utf8'}).stdout.split('\n').filter(Boolean)
    expect([...new Set(packed.map(line => line.split('/')[0]))].sort()).toEqual([...env.testDirs].sort())
    expect(packed).toContain(env.testDirs[0] + '/session-1.jsonl')
    expect(packed).toContain(env.testDirs[0] + '/session-2.jsonl')
    expect(packed).toContain(env.testDirs[0] + '/memory/')
    for (const name of env.testDirs) expect(existsSync(join(env.projects, name))).toBe(false)
    for (const name of env.keptDirs) expect(existsSync(join(env.projects, name))).toBe(true)
  })

  it('reports a thread it could not delete and exits non-zero, finishing the other steps', () => {
    const env = environment([{id: 'fail-1', kind: 'exec', cwd: '/tmp/chief-accept-x', preview: SUPERHUB}])
    const {status, out} = run(env, '--apply')
    expect(status).toBe(1)
    expect(out).toContain('删除失败 fail-1')
    expect(out).toContain('Codex 会话：1 场删除失败')
    expect(remaining(env)).toEqual([...KEPT_THREADS, 'fail-1'].sort())
    expect(env.testDirs.some(name => existsSync(join(env.projects, name)))).toBe(false)
    expect(readFileSync(join(env.codexHome, 'config.toml'), 'utf8')).not.toContain('/tmp/chief-accept-a/brain"]')
  })

  it('leaves config.toml alone when a temporary section holds something it cannot remove line by line', () => {
    const env = environment()
    const odd = env.config + '\n[projects."/tmp/odd"]\ntrust_level = """\ntrusted\n"""\n'
    writeFileSync(join(env.codexHome, 'config.toml'), odd)
    const {status, out} = run(env, '--apply', '--skip-codex-threads')
    expect(status).toBe(1)
    expect(out).toContain('无法逐行处理')
    expect(readFileSync(join(env.codexHome, 'config.toml'), 'utf8')).toBe(odd)
    expect(configFiles(env)).toEqual(['config.toml'])
    expect(requests(env)).toEqual([])
  })

  it('exits non-zero when the Codex app server cannot be started', () => {
    const env = environment()
    const {status, out} = run(env, '--codex-bin', join(env.home, 'missing-codex'))
    expect(status).toBe(1)
    expect(out).toContain('Codex 会话：')
    expect(out).toContain('未完成')
  })

  it('plans config edits on path-segment boundaries and keeps CRLF files intact', () => {
    const roots = ['/tmp', '/dev/shm', '/home/me/.cache/chief-acceptance']
    const text = '[projects."/tmp/a"]\r\ntrust_level = "trusted"\r\n\r\n[projects."/tmpfile"]\r\ntrust_level = "trusted"\r\n[projects."/home/me/.cache/chief-acceptance"]\r\ntrust_level = "trusted"'
    const plan = planConfig(text, roots)
    // The cache root itself is not an acceptance run's directory: kept, like /tmp.
    expect(plan.remove.map(row => row.path)).toEqual(['/tmp/a'])
    expect(plan.text).toBe('[projects."/tmpfile"]\r\ntrust_level = "trusted"\r\n[projects."/home/me/.cache/chief-acceptance"]\r\ntrust_level = "trusted"')
    expect(() => verifyConfig(text, plan, roots)).not.toThrow()
    expect(() => verifyConfig(text, {...plan, text: plan.text + ' '}, roots)).toThrow()
    expect(isClaudeAcceptanceDir('-tmp-x', roots)).toBe(true)
    expect(isClaudeAcceptanceDir('-tmpx', roots)).toBe(false)
    // Never a root itself.
    for (const name of ['-tmp', '-tmp-', '-dev-shm', '-dev-shm-', claudeProjectName('/home/me/.cache/chief-acceptance')]) expect(isClaudeAcceptanceDir(name, roots)).toBe(false)
    expect(isClaudeAcceptanceDir('-home-example-tmp-x', roots)).toBe(false)
    for (const path of ['/tmp', '/tmp/', '/dev/shm', '/dev/shm/', '/home/me/.cache/chief-acceptance', '/home/me/.cache/chief-acceptance/', '/tmpx/y', '/home/example/tmp/x']) {
      expect(underAcceptanceRoot(path, roots)).toBe(false)
    }
    expect(underAcceptanceRoot('/tmp/x', roots)).toBe(true)
    expect(underAcceptanceRoot('/home/me/.cache/chief-acceptance/run', roots)).toBe(true)
    expect(planConfig('[projects."/tmp"]\ntrust_level = "trusted"\n[projects."/dev/shm/"]\ntrust_level = "trusted"\n', roots).remove).toEqual([])
    expect(isClaudeAcceptanceDir(claudeProjectName('/home/me/.cache/chief-acceptance/run/brain'), roots)).toBe(true)
    expect(isClaudeAcceptanceDir('-home-me--cache-other', roots)).toBe(false)
    // Our test directories, by their first component below a root.
    for (const path of ['/dev/shm/od-tmp3/x', '/dev/shm/od-tmp/x', '/tmp/od-spike-work.MXpr', '/tmp/pd-spike-1/w', '/home/me/.cache/chief-acceptance/chief-accept-a/brain',
      '/tmp/resume-check.1', '/tmp/spike-work.zFs9Cu'])
      expect(inTestDirectory(path, roots)).toBe(true)
    // Not ours: generic words without the `mktemp` dot, an owner's `od-tmp-…`, a bare prefix, the wrong level, and
    // paths that only look as if they were below a root.
    for (const path of ['/tmp/ark-work-1', '/tmp/x/chief-accept-a', '/tmp/chief-accept-', '/home/me/chief-accept-a', '/tmp', '/tmpx/od-spike',
      '/tmp/od-tmp-mine/x', '/tmp/od-tmpfoo', '/tmp/resume-check', '/tmp/resume-check-notes', '/tmp/spike-workshop/x', '/tmp/spike-json',
      '/tmp/../home/me/chief-accept-a', '/tmp/./chief-accept-a', '/tmp//chief-accept-a'])
      expect(inTestDirectory(path, roots), path).toBe(false)
    for (const path of ['/tmp/../home/me', '/tmp/x/../../home', '/tmp/./x', '/dev/shm//x']) expect(underAcceptanceRoot(path, roots), path).toBe(false)
    expect(planConfig('[projects."/tmp/../home/me/app"]\ntrust_level = "trusted"\n', roots).remove).toEqual([])
    // Claude directories without a recorded cwd: by the encoded name.
    for (const name of ['-tmp-chief-accept-a-brain', '-dev-shm-od-tmp3-chief-run-as-owner-1-chief-accept-x-brain', '-dev-shm-od-tmp-chief-order-dialogue-1',
      '-tmp-spike-work-YnoNL5', claudeProjectName('/home/me/.cache/chief-acceptance/chief-accept-a/brain')])
      expect(isClaudeTestDirName(name, roots), name).toBe(true)
    for (const name of ['-tmp-scratch', '-tmp-chief-accept-', '-dev-shm-od-tmp', '-dev-shm-od-tmpfoo-x', '-tmp-resume-check', '-tmp-spike-workshop', '-tmpx-chief-accept-a', '-home-me-chief-accept-a'])
      expect(isClaudeTestDirName(name, roots), name).toBe(false)
    // Rollouts inside the Codex home's session directories only.
    expect(codexRollout('/home/me/.codex/sessions/2026/11/23/r.jsonl', '/home/me/.codex')).toBe(true)
    expect(codexRollout('/home/me/.codex/archived_sessions/r.jsonl', '/home/me/.codex')).toBe(true)
    for (const path of ['/home/me/.codex/sessions/../config.toml.jsonl', '/home/me/.codex/sessions', '/home/me/.codex/sessions-x/r.jsonl', '/home/me/.codex/sessions/r.json', '/tmp/r.jsonl', undefined])
      expect(codexRollout(path, '/home/me/.codex')).toBe(false)
  })
})

describe('cleanup-acceptance-traces config edge cases', () => {
  const roots = ['/tmp', '/dev/shm', '/home/me/.cache/chief-acceptance']

  it('never takes a line inside a multi-line string for a table header', () => {
    const text = 'notes = """\n[projects."/tmp/inside-a-string"]\ntrust_level = "trusted"\n"""\n[projects."/tmp/real"]\ntrust_level = "trusted"\n'
    const plan = planConfig(text, roots)
    expect(plan.remove.map(row => row.path)).toEqual(['/tmp/real'])
    expect(plan.text).toBe('notes = """\n[projects."/tmp/inside-a-string"]\ntrust_level = "trusted"\n"""\n')
    expect(() => verifyConfig(text, plan, roots)).not.toThrow()
  })

  it('keeps a comment inside a removed section with it, so no key moves into the table above', () => {
    const text = '[projects."/home/me/x"]\ntrust_level = "trusted"\n\n[projects."/tmp/a"]\n# note\ntrust_level = "trusted"\n\n# about tui\n[tui]\ntheme = "dark"\n'
    const plan = planConfig(text, roots)
    expect(plan.problems).toEqual([])
    expect(plan.text).toBe('[projects."/home/me/x"]\ntrust_level = "trusted"\n\n# about tui\n[tui]\ntheme = "dark"\n')
  })

  it('does not rewrite a config.toml that is a symlink', () => {
    const env = environment()
    const target = join(env.home, 'real-config.toml')
    writeFileSync(target, env.config)
    rmSync(join(env.codexHome, 'config.toml'))
    symlinkSync(target, join(env.codexHome, 'config.toml'))
    const {status, out} = run(env, '--apply', '--skip-codex-threads')
    expect(status).toBe(1)
    expect(out).toContain('符号链接')
    expect(lstatSync(join(env.codexHome, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe(env.config)
    expect(configFiles(env)).toEqual(['config.toml'])
  })
})

describe('acceptance tool homes', () => {
  function owner() {
    const home = temp('chief-homes-owner-')
    const codex = join(home, '.codex'), claude = join(home, '.claude')
    mkdirSync(codex)
    mkdirSync(claude)
    writeFileSync(join(codex, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"refresh_token":"r1"}}', {mode: 0o600})
    writeFileSync(join(codex, 'config.toml'), 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "high"\napproval_policy = "never"\n\n[projects."/home/me/x"]\ntrust_level = "trusted"\n\n[mcp_servers.a]\nmodel = "not-top-level"\n')
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({
      env: {ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://proxy.example', xANTHROPIC_MODEL: 'off', DISABLE_TELEMETRY: '1'},
      model: 'opus[1m]', effortLevel: 'high', modelSettings: {opus: {x: 1}}, permissions: {allow: ['Bash']}, enabledPlugins: {a: true}, hooks: {Stop: []}}))
    return {home, codex, claude, base: join(home, '.cache', 'chief-acceptance')}
  }

  it('builds private homes with only the login and model settings, and removes them', () => {
    const o = owner(), logs: string[] = []
    const homes = isolateToolHomes({ownerHome: o.home, base: o.base, env: {}, log: line => logs.push(line), onExit: false})!
    expect(homes.root.startsWith(o.base + '/tool-homes-')).toBe(true)
    expect(readFileSync(join(homes.codexHome, 'auth.json'), 'utf8')).toBe(readFileSync(join(o.codex, 'auth.json'), 'utf8'))
    expect(mode(join(homes.codexHome, 'auth.json'))).toBe(0o600)
    expect(readFileSync(join(homes.codexHome, 'config.toml'), 'utf8')).toBe('model = "gpt-6.2-sol"\nmodel_reasoning_effort = "high"\n')
    expect(JSON.parse(readFileSync(join(homes.claudeConfigDir, 'settings.json'), 'utf8'))).toEqual({
      env: {ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://proxy.example'}, model: 'opus[1m]', effortLevel: 'high', modelSettings: {opus: {x: 1}}})
    expect(mode(join(homes.claudeConfigDir, 'settings.json'))).toBe(0o600)
    // The owner's credentials file holds no Claude login (only plugin OAuth): it is not copied.
    expect(existsSync(join(homes.claudeConfigDir, '.credentials.json'))).toBe(false)
    const env = homes.apply({PATH: '/bin', ANTHROPIC_API_KEY: 'outer', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/elsewhere', CODEX_THREAD_ID: 't', DSH_HOME: '/d'})
    expect(env).toEqual({PATH: '/bin', DSH_HOME: '/d', CODEX_HOME: homes.codexHome, CLAUDE_CONFIG_DIR: homes.claudeConfigDir})
    expect(homes.teardown()).toMatchObject({codexAuth: 'unchanged', claudeLogin: 'unchanged', warnings: [], removed: true})
    expect(existsSync(homes.root)).toBe(false)
    expect(logs).toEqual([])
    // The owner's files are untouched.
    expect(readdirSync(o.codex).sort()).toEqual(['auth.json', 'config.toml'])
  })

  it('writes a rotated Codex login back when the owner\'s file is unchanged, with a backup', () => {
    const o = owner()
    const original = readFileSync(join(o.codex, 'auth.json'), 'utf8')
    const homes = isolateToolHomes({ownerHome: o.home, base: o.base, env: {}, log: () => {}, onExit: false})!
    const rotated = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"r2"}}'
    writeFileSync(join(homes.codexHome, 'auth.json'), rotated)
    const report = homes.teardown()
    expect(report).toMatchObject({codexAuth: 'written-back', warnings: []})
    expect(readFileSync(join(o.codex, 'auth.json'), 'utf8')).toBe(rotated)
    expect(mode(join(o.codex, 'auth.json'))).toBe(0o600)
    expect(readFileSync(report.codexBackup!, 'utf8')).toBe(original)
    expect(mode(report.codexBackup!)).toBe(0o600)
    expect(existsSync(homes.root)).toBe(false)
    expect(readdirSync(o.codex).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('does not overwrite an owner login that changed meanwhile, and warns instead', () => {
    const o = owner(), logs: string[] = []
    const homes = isolateToolHomes({ownerHome: o.home, base: o.base, env: {}, log: line => logs.push(line), onExit: false})!
    writeFileSync(join(homes.codexHome, 'auth.json'), '{"tokens":{"refresh_token":"r2"}}')
    writeFileSync(join(o.codex, 'auth.json'), '{"tokens":{"refresh_token":"owner-relogin"}}')
    const report = homes.teardown()
    expect(report.codexAuth).toBe('conflict')
    expect(readFileSync(join(o.codex, 'auth.json'), 'utf8')).toBe('{"tokens":{"refresh_token":"owner-relogin"}}')
    expect(logs.join('\n')).toContain('请检查主人的 Codex 登录')
    expect(readdirSync(o.codex).filter(name => name.includes('.bak-'))).toEqual([])
    expect(existsSync(homes.root)).toBe(false)
    expect(homes.teardown()).toBe(report)
  })

  it('copies a Claude OAuth login alone and warns when it changed', () => {
    const o = owner(), logs: string[] = []
    writeFileSync(join(o.claude, '.credentials.json'), JSON.stringify({claudeAiOauth: {accessToken: 'a'}, mcpOAuth: {posthog: {}}}))
    const homes = isolateToolHomes({ownerHome: o.home, base: o.base, env: {}, log: line => logs.push(line), onExit: false})!
    expect(JSON.parse(readFileSync(join(homes.claudeConfigDir, '.credentials.json'), 'utf8'))).toEqual({claudeAiOauth: {accessToken: 'a'}})
    expect(mode(join(homes.claudeConfigDir, '.credentials.json'))).toBe(0o600)
    writeFileSync(join(homes.claudeConfigDir, '.credentials.json'), JSON.stringify({claudeAiOauth: {accessToken: 'b'}}))
    expect(homes.teardown()).toMatchObject({claudeLogin: 'changed'})
    expect(logs.join('\n')).toContain('Claude Code 的 OAuth 登录发生了变化')
  })

  it('stops what uses the homes first, then removes them', () => {
    const o = owner(), order: string[] = []
    const homes = isolateToolHomes({ownerHome: o.home, base: o.base, env: {}, log: () => {}, onExit: false})!
    homes.onTeardown(() => { order.push('stop:' + existsSync(homes.root)) })
    homes.onTeardown(() => { throw Error('already gone') })
    expect(homes.teardown().removed).toBe(true)
    expect(order).toEqual(['stop:true'])
  })

  it('sweeps homes a killed run left, writing a rotated login back, and leaves live or unknown ones', () => {
    const o = owner(), logs: string[] = []
    const original = readFileSync(join(o.codex, 'auth.json'), 'utf8')
    const killed = isolateToolHomes({ownerHome: o.home, base: o.base, env: {}, log: () => {}, onExit: false})!
    const live = isolateToolHomes({ownerHome: o.home, base: o.base, env: {}, log: () => {}, onExit: false})!
    expect(mode(join(killed.root, 'owner.json'))).toBe(0o600)
    // The killed run: a process that has exited, after Codex rotated its login.
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {encoding: 'utf8'})
    const meta = JSON.parse(readFileSync(join(killed.root, 'owner.json'), 'utf8'))
    writeFileSync(join(killed.root, 'owner.json'), JSON.stringify({...meta, pid: Number(dead.stdout.trim())}))
    writeFileSync(join(killed.codexHome, 'auth.json'), '{"tokens":{"refresh_token":"r9"}}')
    const unknown = join(o.base, 'tool-homes-unknown')
    mkdirSync(unknown)
    const swept = sweepStaleHomes(o.base, line => logs.push(line))
    expect(swept).toMatchObject([{root: killed.root, codexAuth: 'written-back', removed: true}])
    expect(readFileSync(join(o.codex, 'auth.json'), 'utf8')).toBe('{"tokens":{"refresh_token":"r9"}}')
    expect(readFileSync(swept[0]!.codexBackup!, 'utf8')).toBe(original)
    expect(existsSync(killed.root)).toBe(false)
    expect(existsSync(live.root)).toBe(true)
    expect(existsSync(unknown)).toBe(true)
    expect(logs.join('\n')).toContain(killed.root)
    // A new run sweeps too (here: nothing left to sweep but the live one, which stays).
    const next = isolateToolHomes({ownerHome: o.home, base: o.base, env: {}, log: () => {}, onExit: false})!
    expect(existsSync(live.root)).toBe(true)
    live.teardown()
    next.teardown()
  })

  it('can be turned off for debugging only', () => {
    const o = owner(), logs: string[] = []
    expect(isolateToolHomes({ownerHome: o.home, base: o.base, env: {CHIEF_ACCEPTANCE_OWNER_HOMES: '1'}, log: line => logs.push(line), onExit: false})).toBeUndefined()
    expect(logs[0]).toContain('CHIEF_ACCEPTANCE_OWNER_HOMES=1')
    expect(existsSync(o.base)).toBe(false)
  })

  it('reads only top-level model lines and ANTHROPIC_* login settings', () => {
    expect(codexModelConfig('[profiles.a]\nmodel = "x"\n')).toBe('')
    expect(codexModelConfig('  model="m" # c\r\nmodel_provider = "p"\n')).toBe('model="m" # c\n')
    expect(claudeLoginSettings(undefined)).toEqual({})
    expect(withoutToolEnv({CODEX_HOME: 'a', ANTHROPIC_X: 'b', CLAUDE_Y: 'c', HOME: 'h'})).toEqual({HOME: 'h'})
  })
})
