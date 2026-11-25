/**
 * 界面定制的存取：第二大脑的 ui/custom.json。
 *
 * 每次修改前把旧版本存进 ops/ui-history/（保留最近 10 份），撤销就是取回最近一份。
 * 写入后提交到 git；主人手改这个文件也行，读的时候照样校验。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyPatch, EMPTY_CUSTOM, normalizeCustom, type Custom, type CustomPatch } from '../core/custom.ts'

const KEEP = 10

export class CustomStore {
  private readonly file: string
  private readonly history: string
  private cache: { stamp: number; value: Custom } | undefined

  constructor(private readonly root: string, private readonly commit: (message: string, paths: string[]) => void = () => {}) {
    this.file = join(root, 'ui', 'custom.json')
    this.history = join(root, 'ops', 'ui-history')
  }

  get(): Custom {
    if (!existsSync(this.file)) return EMPTY_CUSTOM
    const stamp = statSync(this.file).mtimeMs
    if (this.cache?.stamp === stamp) return this.cache.value
    let value = EMPTY_CUSTOM
    try { value = normalizeCustom(JSON.parse(readFileSync(this.file, 'utf8'))).custom } catch { /* 坏文件按没有定制处理 */ }
    this.cache = { stamp, value }
    return value
  }

  update(patch: CustomPatch, message = '界面定制：修改'): { custom: Custom; dropped: string[] } {
    const current = this.get()
    const result = applyPatch(current, patch)
    this.save(result.custom, current, message)
    return result
  }

  reset(): Custom {
    const current = this.get()
    const next = { ...EMPTY_CUSTOM, rev: current.rev + 1 }
    this.save(next, current, '界面定制：恢复默认')
    return next
  }

  /** 撤销上一次修改；没有可撤销的返回 undefined。 */
  undo(): Custom | undefined {
    const files = this.snapshots()
    const last = files.at(-1)
    if (!last) return undefined
    const current = this.get()
    let previous = EMPTY_CUSTOM
    try { previous = normalizeCustom(JSON.parse(readFileSync(join(this.history, last), 'utf8'))).custom } catch { /* 坏的历史当作默认 */ }
    const next = { ...previous, rev: current.rev + 1 }
    this.write(next)
    rmSync(join(this.history, last), { force: true })
    this.commit('界面定制：撤销上一次修改', ['ui/custom.json'])
    return next
  }

  canUndo(): boolean { return this.snapshots().length > 0 }

  private snapshots(): string[] {
    return existsSync(this.history) ? readdirSync(this.history).filter(n => /^\d+-\d+\.json$/.test(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : []
  }

  private save(next: Custom, previous: Custom, message: string) {
    mkdirSync(this.history, { recursive: true })
    writeFileSync(join(this.history, `${Date.now()}-${previous.rev}.json`), JSON.stringify(previous))
    for (const old of this.snapshots().slice(0, -KEEP)) rmSync(join(this.history, old), { force: true })
    this.write(next)
    this.commit(message, ['ui/custom.json'])
  }

  private write(value: Custom) {
    mkdirSync(join(this.root, 'ui'), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(tmp, this.file)
    this.cache = undefined
  }
}
