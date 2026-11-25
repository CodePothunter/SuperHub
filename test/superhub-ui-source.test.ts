import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureUiSource } from '../scripts/ui-source-proof.mjs'

const fixtures: string[] = []
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'chief-ui-source-'))
  fixtures.push(directory)
  const root = join(directory, 'repo')
  for (const path of ['src/client', 'scripts']) mkdirSync(join(root, path), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (relative: string, value: string) => writeFileSync(join(root, relative), value)
  for (const script of ['deploy.mjs', 'ui-source-proof.mjs']) {
    copyFileSync(new URL(`../scripts/${script}`, import.meta.url), join(root, 'scripts', script))
  }
  write('.gitignore', 'lib/\n.deploy-tmp/\n')
  write('src/client/panel.ts', 'original')
  write('server.ts', 'server')
  git('init', '-q')
  git('config', 'user.name', 'Trellis fixture')
  git('config', 'user.email', 'trellis@example.test')
  git('add', '-A')
  git('commit', '-qm', 'baseline')
  return { root, directory, git, write }
}

describe('scoped UI source versions', () => {
  it('binds HEAD, separate staged and live versions, and raw untracked names and bytes', () => {
    const { root, git, write } = fixture()
    const initial = captureUiSource(root)
    write('src/client/panel.ts', 'staged')
    git('add', 'src/client/panel.ts')
    write('src/client/panel.ts', 'unstaged')
    const filename = 'src/client/导航 -> 菜单\n说明.txt'
    write(filename, 'untracked')
    const edited = captureUiSource(root)
    expect(edited.digest).not.toBe(initial.digest)
    expect(captureUiSource(root)).toEqual(edited)
    expect(edited.paths).toEqual(['src/client/panel.ts', filename])
    expect(JSON.parse(edited.proof)).toMatchObject({
      head: git('rev-parse', 'HEAD'),
      digest: edited.digest,
      files: [
        { path: 'src/client/panel.ts', status: 'MM', staged: { object: git('rev-parse', ':src/client/panel.ts') }, worktree: { content: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        { path: filename, status: '??', staged: null, worktree: { content: expect.stringMatching(/^[a-f0-9]{64}$/) } },
      ],
    })
    write(filename, 'changed untracked contents')
    expect(captureUiSource(root).digest).not.toBe(edited.digest)
    write(filename, 'untracked')
    git('add', 'src/client/panel.ts')
    expect(captureUiSource(root).digest).not.toBe(edited.digest)
    git('add', '--', filename)
    git('commit', '-qm', 'approved source')
    const committed = captureUiSource(root)
    expect(committed.paths).toEqual([])
    expect(committed.digest).not.toBe(initial.digest)
  })

  it('rejects modifications and rename sources outside the existing UI gate', () => {
    const { root, write, git } = fixture()
    write('server.ts', 'changed outside UI')
    expect(() => captureUiSource(root)).toThrow('server.ts')
    git('restore', 'server.ts')
    git('mv', 'server.ts', 'src/client/server.ts')
    expect(() => captureUiSource(root)).toThrow('server.ts')
  })

  it('rejects hidden Git index paths', () => {
    const { root, write, git } = fixture()
    git('update-index', '--assume-unchanged', 'server.ts')
    write('server.ts', 'hidden change outside UI')
    expect(() => captureUiSource(root)).toThrow('隐藏')
  })
})

const mockBuild = `
const fs = require('node:fs')
const cp = require('node:child_process')
const { join } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const realExec = cp.execFileSync
const realCopy = fs.cpSync
const realWrite = fs.writeFileSync
cp.execFileSync = function (command, args, options) {
  if (command !== 'npx') return realExec(command, args, options)
  if (args[0] === 'tsdown') {
    fs.mkdirSync(options.env.CHIEF_OUT_DIR, { recursive: true })
    fs.writeFileSync(join(options.env.CHIEF_OUT_DIR, 'index.js'), 'candidate')
    if (process.env.CHIEF_TEST_DEPLOY_PHASE === 'build') fs.writeFileSync(join(options.cwd, 'src/client/panel.ts'), 'changed during build')
  }
  return ''
}
fs.cpSync = function (source, destination, options) {
  realCopy(source, destination, options)
  if (process.env.CHIEF_TEST_DEPLOY_PHASE === 'copy') {
    fs.writeFileSync(join(process.cwd(), 'src/client/panel.ts'), 'changed before reload')
  }
}
fs.writeFileSync = function (file, text, options) {
  realWrite(file, text, options)
  if (file === process.env.CHIEF_TEST_PATCH && String(text).startsWith('# dsh-chief 热更新标记')) {
    const directory = process.env.CHIEF_TEST_DEPLOY_STATE
    realWrite(join(directory, 'deploy-confirmed.json'), fs.readFileSync(join(directory, 'deploy-pending.json')))
  }
}
syncBuiltinESMExports()
`

function deploy(phase: 'build' | 'copy' | 'success', digest?: string) {
  const repo = fixture()
  const patch = join(repo.directory, 'profile.yml'), state = join(repo.directory, 'state'), preload = join(repo.directory, 'build.cjs')
  mkdirSync(state)
  writeFileSync(patch, 'original profile\n')
  writeFileSync(preload, mockBuild)
  repo.write('src/client/panel.ts', 'approved UI')
  const source = digest ?? captureUiSource(repo.root).digest
  const result = spawnSync(process.execPath, ['--require', preload, 'scripts/deploy.mjs', '更新面板', '--patch', patch, '--home', state, '--source-digest', source], {
    cwd: repo.root, encoding: 'utf8', timeout: 4000,
    env: { ...process.env, CHIEF_TEST_DEPLOY_PHASE: phase, CHIEF_TEST_PATCH: patch, CHIEF_TEST_DEPLOY_STATE: state },
  })
  return { ...repo, patch, result, state }
}

describe('scoped deployment gate', () => {
  it('rejects a stale approval before building', () => {
    const run = deploy('success', 'b'.repeat(64))
    expect(run.result.status).toBe(1)
    expect(run.result.stderr).toContain('检查前')
    expect(existsSync(join(run.root, 'lib', 'index.js'))).toBe(false)
    expect(readFileSync(run.patch, 'utf8')).toBe('original profile\n')
  })

  it('rejects source drift during the build before replacing the active package', () => {
    const run = deploy('build')
    expect(run.result.status).toBe(1)
    expect(run.result.stderr).toContain('打包结束')
    expect(existsSync(join(run.root, 'lib', 'index.js'))).toBe(false)
    expect(existsSync(join(run.root, '.deploy-tmp'))).toBe(false)
    expect(readFileSync(run.patch, 'utf8')).toBe('original profile\n')
  })

  it('rechecks source after copying the package and before writing reload markers', () => {
    const run = deploy('copy')
    expect(run.result.status).toBe(1)
    expect(run.result.stderr).toContain('热重载前')
    expect(existsSync(join(run.state, 'deploy-pending.json'))).toBe(false)
    expect(readFileSync(run.patch, 'utf8')).toBe('original profile\n')
  })

  it('deploys unchanged approved source and commits the intended UI paths', () => {
    const run = deploy('success')
    expect(run.result.stderr).toBe('')
    expect(run.result.status).toBe(0)
    expect(readFileSync(join(run.root, 'lib', 'index.js'), 'utf8')).toBe('candidate')
    expect(run.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('src/client/panel.ts')
    expect(run.git('log', '-1', '--format=%s')).toBe('✨【功能】：更新作战台界面')
    expect(readFileSync(run.patch, 'utf8')).toContain('dsh-chief 热更新标记')
  })
})
