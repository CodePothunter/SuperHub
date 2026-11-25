import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const UI_PATHS = Object.freeze(['src/client/', 'src/mobile/', 'preview/'])
export const UI_SOURCE_PROOF_FILENAME = 'ui-source-proof.json'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const bytes = (cwd, args, env) => execFileSync('git', ['--no-optional-locks', '-C', cwd, ...args], {
  env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
})

function rows(buffer) {
  const text = buffer.toString('utf8')
  if (!buffer.equals(Buffer.from(text)) || (text && !text.endsWith('\0'))) throw Error('Git 文件列表无法无损读取')
  return text.split('\0').slice(0, -1)
}

function safeRelative(path) {
  return path && !isAbsolute(path) && !path.split('/').some(segment => !segment || segment === '.' || segment === '..')
}

function sourceState(root, env) {
  return {
    head: bytes(root, ['rev-parse', '--verify', 'HEAD'], env).toString('ascii').trim(),
    index: bytes(root, ['ls-files', '--stage', '-z'], env),
    status: bytes(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none'], env),
  }
}

function sourceFile(root, path) {
  const full = join(root, path)
  let stat
  try { stat = lstatSync(full, { bigint: true }) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || realpathSync(full) !== full) throw Error(`构建输入必须是工作区中的普通文件：${path}`)
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const start = fstatSync(fd, { bigint: true })
    if (start.ino !== stat.ino || start.dev !== stat.dev) throw Error(`读取构建输入时文件已替换：${path}`)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let count
    while ((count = readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count))
    const end = fstatSync(fd, { bigint: true })
    if (end.size !== start.size || end.mtimeNs !== start.mtimeNs || end.ctimeNs !== start.ctimeNs) {
      throw Error(`读取构建输入时文件已变更：${path}`)
    }
    return { mode: (end.mode & 0o111n) ? '100755' : '100644', content: hash.digest('hex') }
  } finally {
    closeSync(fd)
  }
}

/** Snapshot the reviewed UI build inputs without writing an index, branch or working tree. */
export function captureUiSource(workspace) {
  const root = realpathSync(workspace)
  const env = { ...process.env }
  // Resolve the real index and work tree from the selected checkout.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX']) delete env[key]
  const top = bytes(root, ['rev-parse', '--show-toplevel'], env).toString('utf8').replace(/\r?\n$/, '')
  if (realpathSync(top) !== root) throw Error('界面构建目录必须是已核对的 Git 仓库根目录')
  const before = sourceState(root, env)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(before.head)) throw Error('缺少可核对的 Git HEAD')
  const changes = rows(before.status).map(row => {
    const status = row.slice(0, 2), path = row.slice(3)
    if (row[2] !== ' ' || !safeRelative(path)) throw Error('无法核对改动的文件路径')
    if (!UI_PATHS.some(prefix => path.startsWith(prefix))) throw Error(`改动不在允许的界面路径内：${path}`)
    return { path, status }
  })
  const index = new Map()
  for (const row of rows(before.index)) {
    const match = /^(100644|100755) ((?:[a-f0-9]{40}|[a-f0-9]{64})) 0\t([\s\S]+)$/.exec(row)
    if (!match || !safeRelative(match[3])) throw Error('Git 索引包含冲突、链接或未知类型的文件')
    index.set(match[3], { mode: match[1], object: match[2] })
  }
  const flags = rows(bytes(root, ['ls-files', '-v', '-z'], env))
  if (flags.some(row => !row.startsWith('H '))) throw Error('Git 索引隐藏了部分工作区文件，无法核对构建输入')
  const paths = [...new Set([...index.keys(), ...changes.map(row => row.path)])].sort()
  const worktree = new Map(paths.map(path => [path, sourceFile(root, path)]))

  const after = sourceState(root, env)
  if (before.head !== after.head || !before.index.equals(after.index) || !before.status.equals(after.status)) {
    throw Error('采集证据时 Git HEAD、暂存区或工作区状态已变更')
  }
  const manifest = {
    schema: 1, head: before.head, indexDigest: sha256(before.index),
    worktreeDigest: sha256(JSON.stringify([...worktree])),
    files: changes.map(({ path, status }) => ({ path, status, staged: index.get(path) ?? null, worktree: worktree.get(path) })),
  }
  const digest = sha256(JSON.stringify(manifest))
  return { digest, proof: `${JSON.stringify({ ...manifest, digest })}\n`, paths: changes.map(row => row.path) }
}
