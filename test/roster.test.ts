import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dueState, validId } from '../src/core/poc.ts'
import { parseDoc, Roster } from '../src/dsh/roster.ts'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'roster-'))
  const commits: { message: string; paths: string[] }[] = []
  const roster = new Roster(root, { commit: (message, options) => { commits.push({ message, paths: options?.paths ?? [] }) } }, () => '2026-11-15')
  return { root, roster, commits }
}

describe('花名册', () => {
  it('名称同时是文件名：拒绝路径和控制字符', () => {
    for (const bad of ['', '../x', 'a/b', 'a\\b', '.hidden', 'x\ny', ' 张三', 'a'.repeat(41), 'a:b']) expect(validId(bad)).toBe(false)
    for (const good of ['张三', 'Li Lei', '数据平台-二期']) expect(validId(good)).toBe(true)
    const { roster, root } = setup()
    expect(() => roster.logInteraction('../../etc/x', { text: '越权' })).toThrow()
    expect(() => roster.recordPersonFacts('a/b', { role: 'x' })).toThrow()
    expect(existsSync(join(root, 'etc'))).toBe(false)
  })

  it('组：可以属于多个组，增删替换，写进文件再读回来', () => {
    const { roster, root } = setup()
    roster.recordPersonFacts('杨强', { addGroups: ['本组', '老板线'] })
    roster.recordPersonFacts('杨强', { addGroups: ['本组', '上游、前同事'] }) // 重复的不加，顿号也能分开
    expect(roster.person('杨强')!.groups).toEqual(['本组', '老板线', '上游', '前同事'])
    roster.recordPersonFacts('杨强', { removeGroups: ['老板线'], role: '平台负责人' })
    expect(roster.person('杨强')!.groups).toEqual(['本组', '上游', '前同事'])
    expect(readFileSync(join(root, 'people', '杨强.md'), 'utf8')).toContain('groups: 本组、上游、前同事')
    roster.recordPersonFacts('杨强', { groups: [] })
    expect(roster.person('杨强')!.groups).toBeUndefined()
    expect(roster.person('杨强')!.role).toBe('平台负责人')
    roster.recordPersonFacts('周岚', { groups: ['  下游 ', 'x'.repeat(30)] })
    expect(roster.person('周岚')!.groups).toEqual(['下游', 'x'.repeat(20)])
  })

  it('记互动会建卡、排序并更新最近接触日期', () => {
    const { roster, commits } = setup()
    roster.logInteraction('张三', { text: '聊了排期', channel: '1:1', date: '2026-11-10' })
    roster.logInteraction('张三', { text: '周会上同步了风险' })
    roster.logInteraction('张三', { text: '更早的一次', date: '2026-11-01' })
    const p = roster.person('张三')!
    expect(p.lastContact).toBe('2026-11-15')
    expect(p.log.map(l => l.slice(0, 10))).toEqual(['2026-11-15', '2026-11-10', '2026-11-01'])
    expect(p.log[1]).toContain('[1:1] 聊了排期')
    expect(commits.every(c => c.paths[0] === 'people/张三.md')).toBe(true)
  })

  it('事实接口改不了判断字段；判断接口保留事实与记录', () => {
    const { roster, root } = setup()
    roster.recordPersonFacts('李四', { role: '研发负责人', team: '数据平台', fact: '负责调度系统' , ...{ warmth: 'warm', influence: 'high' } as object })
    expect(roster.person('李四')).toMatchObject({ role: '研发负责人', team: '数据平台' })
    expect(roster.person('李四')?.warmth).toBeUndefined()
    roster.setPersonJudgement('李四', { warmth: 'warm', influence: 'high', stance: '支持', profile: '看重数据，先给结论' })
    roster.logInteraction('李四', { text: '对齐了接口' })
    const p = roster.person('李四')!
    expect(p).toMatchObject({ warmth: 'warm', influence: 'high', stance: '支持', profile: '看重数据，先给结论', role: '研发负责人' })
    expect(p.facts[0]).toContain('负责调度系统')
    expect(() => roster.setPersonJudgement('不存在', { warmth: 'warm' })).toThrow()
    // 元数据值不能借换行注入别的字段
    roster.recordPersonFacts('李四', { role: '架构师\nwarmth: cold' })
    expect(roster.person('李四')?.warmth).toBe('warm')
    expect(parseDoc(readFileSync(join(root, 'people/李四.md'), 'utf8')).meta.role).toBe('架构师 warmth: cold')
  })

  it('横向线：主人创建，幕僚只能给已有的线记进展', () => {
    const { roster } = setup()
    expect(() => roster.logLine('数据平台', { text: '进展' })).toThrow(/主人创建/)
    roster.upsertLine('数据平台', { goal: '接入新调度', partners: ['李四', '张三'], health: 'yellow' })
    roster.logLine('数据平台', { text: '评审通过', blocker: '等安全评审排期', nextSync: '2026-11-20' })
    expect(roster.line('数据平台')).toMatchObject({ health: 'yellow', partners: ['李四', '张三'], blocker: '等安全评审排期', nextSync: '2026-11-20' })
    roster.logLine('数据平台', { blocker: '' })
    expect(roster.line('数据平台')?.blocker).toBeUndefined()
    expect(roster.line('数据平台')?.log).toHaveLength(1)
  })

  it('承诺与会议', () => {
    const { roster } = setup()
    expect(() => roster.addCommitment({ direction: 'x', who: '张三', what: '文档' })).toThrow()
    const a = roster.addCommitment({ direction: 'mine', who: '张三', what: '给接口文档', due: '2026-11-15' })
    const b = roster.addCommitment({ direction: 'theirs', who: '王五', what: '评审意见', due: 'not-a-date' })
    expect([a.id, b.id]).toEqual(['C-0001', 'C-0002'])
    expect(b.due).toBeUndefined()
    expect(roster.updateCommitment('C-0001', { status: 'done' }).closedAt).toBeDefined()
    expect(() => roster.updateCommitment('../x', { status: 'done' })).toThrow()
    expect(() => roster.addMeeting({ title: '周会', at: '明天' })).toThrow()
    const m = roster.addMeeting({ title: '和李四 1:1', at: '2026-11-16T15:00', with: ['李四', '../x'] })
    expect(m.with).toEqual(['李四'])
    expect(roster.setMeetingNotes(m.id, '聊了排期').notes).toBe('聊了排期')
  })

  it('目录被删掉时当作空，写入时自动重建', () => {
    const { roster, root } = setup()
    rmSync(join(root, 'people'), { recursive: true }); rmSync(join(root, 'ledger'), { recursive: true })
    expect(roster.people()).toEqual([])
    expect(roster.ledger()).toEqual([])
    roster.logInteraction('张三', { text: '重建' })
    expect(roster.person('张三')?.log).toHaveLength(1)
  })

  it('到期状态', () => {
    expect([dueState('2026-11-14', '2026-11-15'), dueState('2026-11-15', '2026-11-15'), dueState('2026-11-18', '2026-11-15'), dueState('2026-12-01', '2026-11-15'), dueState(undefined, '2026-11-15')])
      .toEqual(['overdue', 'today', 'soon', 'later', 'none'])
  })
})
