import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildExport, readGoalsDocument } from '../src/core/export.ts'
import { SUPERHUB_GOALS_FILE, currentGoal } from '../src/core/superhub-goals.ts'
import { BrainRepo } from '../src/dsh/brain.ts'
import { SuperhubGoals } from '../src/dsh/superhub-goals.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chief-superhub-goals-'))
  roots.push(root)
  const committed = vi.fn()
  const goals = new SuperhubGoals(root, committed)
  const file = join(root, SUPERHUB_GOALS_FILE)
  const create = (requestId: string, name: string) => goals.change(undefined, {
    requestId, name, expectedVersion: 0, reason: '主人确认新目标',
  }, () => false).goal
  return { root, file, goals, create, committed }
}

describe('SuperHub goals storage', () => {
  it('adopts an open Markdown goal once, keeps its source bytes, and exports the authorized current projection', () => {
    const f = fixture()
    const path = join(f.root, 'goals.md')
    const original = [
      '# 目标', '', '这里记录旧目标的背景。', '',
      '## 本周', '- [ ] 梳理归档流程', '- [ ] 整理交接入口', '- [x] 完成旧发布',
      '- [ ] （例：模板目标）', '- [ ] （待定）', '- [ ] （每周整理）', '- [ ] [机密] 私人旧目标',
      '~~~md', '- [ ] 引用内的示例任务', '~~~', '',
    ].join('\r\n')
    writeFileSync(path, original)
    const candidates = f.goals.candidates()
    expect(candidates.map(({ text, state }) => [text, state])).toEqual([
      ['梳理归档流程', 'open'], ['整理交接入口', 'open'], ['完成旧发布', 'done'], ['[机密] 私人旧目标', 'open'],
    ])
    const candidate = candidates[0]!
    const importRequest = { requestId: 'adopt-goal', candidateId: candidate.id, expectedVersion: 0,
      reason: '主人确认导入旧目标', name: '验证归档流程', description: '复查归档入口\n【机密】隐藏目标的私人限制' }
    const adopted = f.goals.change(undefined, importRequest, () => false)
    const restarted = new SuperhubGoals(f.root, f.committed)

    expect(restarted.change(undefined, importRequest, () => false)).toEqual(adopted)
    expect(restarted.candidates().map(row => row.id)).toEqual(candidates.slice(1).map(row => row.id))
    expect(() => restarted.change(undefined, { ...importRequest, requestId: 'adopt-goal-again' }, () => false))
      .toThrow('原始目标已变更或已导入')
    expect(adopted.goal.source).toEqual({ kind: 'markdown', candidateId: candidate.id, section: '本周', text: '梳理归档流程' })
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(f.committed).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(adopted.goal.id), [SUPERHUB_GOALS_FILE])

    const goals = readGoalsDocument(f.root)
    expect(goals).toContain('这里记录旧目标的背景。')
    expect(goals).toContain('完成旧发布')
    expect(goals).not.toContain('梳理归档流程')
    const exported = buildExport('session', { goals }, '2026-11-18').parts[0]?.text
    expect(exported).toContain('验证归档流程 · 复查归档入口')
    expect(exported).toContain('整理交接入口')
    expect(exported).not.toMatch(/机密|私人|模板目标|完成旧发布|梳理归档流程/)
  })

  it('preserves the closed state when a checked Markdown item is adopted', () => {
    const f = fixture()
    const path = join(f.root, 'goals.md')
    const original = '## 旧交接\n- [x] 完成旧发布\n'
    writeFileSync(path, original)
    const candidate = f.goals.candidates()[0]!
    const adopted = f.goals.change(undefined, {
      requestId: 'adopt-closed', candidateId: candidate.id, expectedVersion: 0, reason: '保留原发布记录',
    }, () => false)

    expect(adopted.current).toMatchObject({ name: '完成旧发布', status: 'archived' })
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(buildExport('session', { goals: readGoalsDocument(f.root) }, '2026-11-18').empty).toBe(true)
  })

  it('retains identity, exact old standards, and the saved reply to a retried request', () => {
    const f = fixture()
    const firstRequest = { requestId: 'create-goal', expectedVersion: 0, reason: '定义交付',
      name: '季度目标', type: 'project', owner: '档案负责人', horizon: '2026 Q4',
      criteria: [{ text: '记录入口现状' }, { text: '上线后复查' }, { text: '整理延伸反馈', required: false }] }
    const first = f.goals.change(undefined, firstRequest, () => false)
    const [initial, second, optional] = first.current.criteria
    const revision = { requestId: 'revise-goal', expectedVersion: 1, reason: '调整两项成果的展示顺序和复查窗口',
      name: '归档交付验证', criteria: [{ ...second, text: '上线后七天复查' }, initial, optional] }
    const renamed = f.goals.change(first.goal.id, revision, () => false)
    const restarted = new SuperhubGoals(f.root, f.committed)

    expect(renamed.goal.id).toBe(first.goal.id)
    expect(renamed.goal.source).toEqual(first.goal.source)
    expect(renamed.previous).toEqual(first.current)
    expect(renamed.current.criteria.map(row => row.id)).toEqual([second!.id, initial!.id, optional!.id])
    expect(renamed.current).toMatchObject({ version: 2, owner: '档案负责人', horizon: '2026 Q4', name: '归档交付验证' })
    expect(restarted.get(first.goal.id)?.versions).toEqual([first.current, renamed.current])
    expect(restarted.change(undefined, firstRequest, () => false).current).toEqual(first.current)
    expect(restarted.change(first.goal.id, revision, () => false)).toEqual(renamed)
    const persisted = readFileSync(f.file, 'utf8')
    expect(() => restarted.change(first.goal.id, { ...revision, requestId: 'stale-revision' }, () => false))
      .toThrow('目标已更新')
    expect(readFileSync(f.file, 'utf8')).toBe(persisted)
    expect(f.committed).toHaveBeenCalledTimes(2)
  })

  it('carries an approved assessment across a pure reorder of stable criterion IDs', () => {
    const f = fixture()
    const initial = f.goals.change(undefined, {
      requestId: 'create-order', expectedVersion: 0, name: '交付核验', reason: '定义两项必要条件',
      criteria: [{ text: '核对入口' }, { text: '核对恢复' }],
    }, () => false)
    const reference = { ticketId: 'T-0001', evidenceId: 'verified-delivery' }
    const checked = f.goals.change(initial.goal.id, {
      requestId: 'approve-order', expectedVersion: 1, status: 'achieved', reason: '主人确认实际结果',
      assessment: { result: 'met', note: '两个条件均有可查交付', findings: initial.current.criteria.map(row => ({
        criterionId: row.id, status: 'met', note: '逐项核对', evidence: [reference],
      })) },
    }, () => true)
    const reordered = f.goals.change(initial.goal.id, {
      requestId: 'reorder', expectedVersion: 2, reason: '调整显示顺序',
      criteria: [...initial.current.criteria].reverse(),
    }, () => true)

    expect(reordered.current.status).toBe('achieved')
    expect(reordered.current.assessment).toEqual(checked.current.assessment)
    expect(reordered.current.criteria).toEqual([...initial.current.criteria].reverse())
    expect(reordered.previous).toEqual(checked.current)
  })

  it('rejects both parent and blocking cycles with their exact paths and permits background links', () => {
    const f = fixture()
    const top = f.create('top', '归档调整'), middle = f.create('middle', '核对索引'), leaf = f.create('leaf', '收集样例')
    const edit = (id: string, requestId: string, expectedVersion: number, fields: Record<string, unknown>) =>
      f.goals.change(id, { requestId, expectedVersion, reason: '核对目标关系', ...fields }, () => false)
    edit(middle.id, 'middle-parent', 1, { parent: top.id })
    edit(leaf.id, 'leaf-parent', 1, { parent: middle.id })
    const original = readFileSync(f.file, 'utf8')
    expect(() => edit(top.id, 'hierarchy-cycle', 1, { parent: leaf.id }))
      .toThrow('归档调整 → 收集样例 → 核对索引 → 归档调整')
    expect(readFileSync(f.file, 'utf8')).toBe(original)

    edit(top.id, 'top-blocker', 1, { relations: [{ target: middle.id, kind: 'requires' }] })
    edit(middle.id, 'middle-blocker', 2, { relations: [{ target: leaf.id, kind: 'requires' }] })
    expect(() => edit(leaf.id, 'blocker-cycle', 2, { relations: [{ target: top.id, kind: 'requires' }] }))
      .toThrow('收集样例 → 归档调整 → 核对索引 → 收集样例')
    expect(currentGoal(f.goals.get(leaf.id)!)).toMatchObject({ version: 2, parent: middle.id, relations: [] })
    expect(edit(leaf.id, 'leaf-background', 2, { relations: [{ target: top.id, kind: 'related' }] }).current)
      .toMatchObject({ version: 3, parent: middle.id, relations: [{ target: top.id, kind: 'related' }] })
  })

  it('applies the long-term-memory protection to structured goal writes', async () => {
    const f = fixture()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim()
    git('init', '-q')
    git('config', 'user.name', 'Goal test')
    git('config', 'user.email', 'goal-fixture@example.test')
    const brain = new BrainRepo(f.root)
    const goals = new SuperhubGoals(f.root, (message, paths) => brain.commit(message, { paths }))

    goals.change(undefined, { requestId: 'owner-authorized', expectedVersion: 0, name: '主人确认的目标', reason: '主人明确写入' }, () => false)
    expect(await brain.protectedChanges()).toEqual([])
    await brain.flush()
    expect(git('ls-files')).toBe(SUPERHUB_GOALS_FILE)
    expect(brain.constitution()).toContain('主人确认的目标')

    writeFileSync(f.file, readFileSync(f.file, 'utf8').replace('主人确认的目标', '未经确认的修改'))
    expect(await brain.protectedChanges()).toEqual([SUPERHUB_GOALS_FILE])
  })
})
