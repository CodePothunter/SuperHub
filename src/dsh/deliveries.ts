import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { DeliveryVersion } from '../core/model.ts'

const MAX_OUTPUT = 512 * 1024
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function workRoot(brainRoot: string, ticketId: string): string {
  if (!/^T-\d+$/.test(ticketId)) throw new Error('工单标识无效')
  const expected = join(realpathSync(brainRoot), 'work', ticketId)
  if (realpathSync(expected) !== expected) throw new Error('工单目录已迁移')
  return expected
}

function readOutput(path: string): string {
  const info = statSync(path)
  if (!info.isFile() || info.size > MAX_OUTPUT) throw new Error('文件不在文本证据大小限制内')
  const buffer = readFileSync(path)
  const content = buffer.toString('utf8')
  if (buffer.length > MAX_OUTPUT || !buffer.equals(Buffer.from(content))) throw new Error('证据需要使用 UTF-8 文本')
  return content
}

export function archivedOutput(brainRoot: string, ticketId: string, version: string): string | undefined {
  if (!/^T-\d+$/.test(ticketId) || !/^[a-f0-9]{64}$/.test(version)) return
  try {
    const path = join(realpathSync(brainRoot), 'ops', 'delivery-versions', ticketId, `${version}.json`)
    if (realpathSync(path) !== path || statSync(path).size > MAX_OUTPUT * 6 + 64) return
    const row = JSON.parse(readFileSync(path, 'utf8')) as { content?: unknown }
    if (typeof row.content === 'string' && hash(row.content) === version) return row.content
  } catch { /* Expired or damaged archive. */ }
}

export function currentOutputEvidence(brainRoot: string, ticketId: string, delivery: DeliveryVersion): string | undefined {
  try {
    const root = workRoot(brainRoot, ticketId)
    const full = realpathSync(resolve(brainRoot, delivery.path))
    if (!inside(root, full) || hash(readOutput(full)) !== delivery.version) return
    return archivedOutput(brainRoot, ticketId, delivery.version)
  } catch { /* A changed or unreadable file requires new evidence. */ }
}

/** Record only real files within this ticket, so later edits cannot inherit an old author's identity. */
export function snapshotOutputs(brainRoot: string, ticketId: string, outputs: readonly string[]) {
  const found: { path: string; version: string }[] = []
  let root: string
  try { root = workRoot(brainRoot, ticketId) } catch { return found }
  for (const output of outputs) for (const candidate of [resolve(brainRoot, output), resolve(root, output)]) {
    try {
      const full = realpathSync(candidate)
      if (!inside(root, full)) continue
      const path = relative(realpathSync(brainRoot), full)
      if (!found.some(f => f.path === path)) {
        const content = readOutput(full), version = hash(content)
        const dir = join(realpathSync(brainRoot), 'ops', 'delivery-versions', ticketId)
        mkdirSync(dir, { recursive: true })
        if (realpathSync(dir) !== dir) continue
        const file = join(dir, `${version}.json`)
        if (!existsSync(file)) {
          const temp = `${file}.${randomUUID()}.tmp`
          writeFileSync(temp, JSON.stringify({ content }), { mode: 0o600, flag: 'wx' })
          renameSync(temp, file)
        }
        if (archivedOutput(brainRoot, ticketId, version) === undefined) continue
        found.push({ path, version })
      }
    } catch { /* Only registered, readable output files are eligible for author discussions. */ }
  }
  return found
}
