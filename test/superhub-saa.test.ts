import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SuperhubSaa, type SaaRecord } from '../src/dsh/superhub-saa.ts'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const from = '2026-11-19T01:00:00.000Z', to = '2026-11-19T03:00:00.000Z'
const now = () => '2026-11-19T03:05:00.000Z'
const context: Pick<SaaRecord, 'goals' | 'tickets' | 'references'> = {
  goals: [{ id: 'G-project', version: 2 }], tickets: ['T-0001'],
  references: [{ ticketId: 'T-0001', evidenceId: 'verified-version-evidence' }],
}
const compactDraft = () => ({ requestId: 'compact-review', mode: 'compact', from, to,
  bottleneck: ' 报送范围尚未确认 ', nextFocus: '确认报送范围', firstStep: '打开范围说明，列出待确认的两项' })
const fullDraft = () => ({ requestId: 'full-review', from, to,
  alignment: '已核对登记，与当前报送目标一致', bottleneck: '报送范围尚未确认', nextFocus: '确认报送范围',
  firstStep: '打开范围说明，列出待确认的两项', coordination: '等待授权人确认范围', drift: '配色微调留到稍后',
  checkpoint: { blockedOn: '授权人尚未确认', ruledOut: '不是登记数据缺失', resumeAt: '打开刚才的范围说明' },
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'chief-saa-contract-'))
  roots.push(root)
  mkdirSync(join(root, 'ops'))
  const committed = vi.fn()
  const saa = new SuperhubSaa(root, committed, now)
  return { root, saa, committed, file: join(root, 'ops/superhub-saa.json'), reopen: () => new SuperhubSaa(root, committed, now) }
}

describe('简短复盘的持久保存契约', () => {
  it('仅填写三个判断即可保存重开，复工线索复用原输入而缺失判断仍为空', () => {
    const f = fixture()
    const draft = compactDraft()
    const record = f.saa.save(draft, context)
    expect(record).toMatchObject({ mode: 'compact', from, to, savedAt: now(), ...context,
      bottleneck: '报送范围尚未确认', nextFocus: draft.nextFocus, firstStep: draft.firstStep,
      alignment: '', coordination: '', drift: '',
      checkpoint: { blockedOn: '报送范围尚未确认', ruledOut: '', resumeAt: draft.firstStep } })
    const reopened = f.reopen()
    expect(reopened.get(record.id)).toEqual(record)
    expect(reopened.latest()).toEqual(record)
    expect(reopened.list()).toEqual([record])
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toMatchObject({ schema: 1, records: [record] })
    expect(f.committed).toHaveBeenCalledExactlyOnceWith('记录局势校准与复工线索', ['ops/superhub-saa.json'])
  })

  it('保留可选补充及与核心输入一致的复工线索，空白补充不会变成“无”', () => {
    const f = fixture()
    const draft = compactDraft()
    const record = f.saa.save({ ...draft, alignment: '  两条登记已经核对  ', coordination: '等负责人确认范围', drift: '   ',
      checkpoint: { blockedOn: draft.bottleneck, resumeAt: '  ' + draft.firstStep, ruledOut: '  不是登记遗漏  ' } }, context)
    expect(f.reopen().get(record.id)).toMatchObject({ alignment: '两条登记已经核对', coordination: '等负责人确认范围', drift: '',
      checkpoint: { blockedOn: '报送范围尚未确认', resumeAt: draft.firstStep, ruledOut: '不是登记遗漏' } })
  })

  it('重放相同请求不重写，改变判断或填写方式会产生冲突', () => {
    const f = fixture()
    const draft = compactDraft()
    const saved = f.saa.save(draft, context)
    const bytes = readFileSync(f.file, 'utf8')
    const reopened = f.reopen()
    expect(reopened.save(draft, context)).toEqual(saved)
    expect(() => reopened.save({ ...draft, nextFocus: '先处理配色' }, context)).toThrow('该请求标识已用于另一份局势校准')
    expect(() => reopened.save({ ...draft, mode: undefined }, context)).toThrow('该请求标识已用于另一份局势校准')
    expect(readFileSync(f.file, 'utf8')).toBe(bytes)
    expect(f.committed).toHaveBeenCalledTimes(1)
  })

  it('旧完整记录仍可读取，旧请求不能借新表单绕过任何必填判断', () => {
    const f = fixture()
    const draft = fullDraft()
    const saved = f.saa.save(draft, context)
    expect(saved).not.toHaveProperty('mode')
    expect(f.reopen().get(saved.id)).toEqual(saved)
    const bytes = readFileSync(f.file, 'utf8')
    for (const field of ['alignment', 'bottleneck', 'nextFocus', 'firstStep', 'coordination', 'drift', 'checkpoint'] as const) {
      expect(() => f.saa.save({ ...draft, requestId: 'missing-' + field, [field]: undefined }, context)).toThrow()
    }
    for (const field of ['blockedOn', 'ruledOut', 'resumeAt'] as const) {
      expect(() => f.saa.save({ ...draft, requestId: 'missing-' + field, checkpoint: { ...draft.checkpoint, [field]: '' } }, context)).toThrow()
    }
    expect(readFileSync(f.file, 'utf8')).toBe(bytes)
    expect(f.committed).toHaveBeenCalledTimes(1)
  })

  it('拒绝冲突的重复线索、未知填写方式及不合法字段，不写入半份记录', () => {
    const f = fixture()
    const draft = compactDraft()
    for (const checkpoint of [{ blockedOn: '另一个卡点' }, { resumeAt: '做另一件事' }]) {
      expect(() => f.saa.save({ ...draft, checkpoint }, context)).toThrow('不一致')
    }
    for (const mode of ['full', '', null, true]) {
      expect(() => f.saa.save({ ...draft, mode }, context)).toThrow('复盘填写方式无效')
    }
    for (const field of ['bottleneck', 'nextFocus', 'firstStep'] as const) {
      expect(() => f.saa.save({ ...draft, [field]: ' ' }, context)).toThrow()
    }
    for (const field of ['alignment', 'coordination', 'drift'] as const) {
      expect(() => f.saa.save({ ...draft, [field]: null }, context)).toThrow()
    }
    for (const checkpoint of [null, [], '线索', { ruledOut: false }]) {
      expect(() => f.saa.save({ ...draft, checkpoint }, context)).toThrow()
    }
    expect(f.saa.list()).toEqual([])
    expect(f.committed).not.toHaveBeenCalled()
  })

  it('仍限制每项输入长度，并允许简短复盘的空补充对象', () => {
    const f = fixture()
    const draft = compactDraft()
    const limits = { bottleneck: 600, nextFocus: 300, firstStep: 500, alignment: 1000, coordination: 1000, drift: 1000 }
    for (const [field, limit] of Object.entries(limits)) {
      expect(() => f.saa.save({ ...draft, [field]: '字'.repeat(limit + 1) }, context)).toThrow(`最多 ${limit} 字`)
    }
    expect(() => f.saa.save({ ...draft, checkpoint: { ruledOut: '字'.repeat(601) } }, context)).toThrow('最多 600 字')
    expect(f.saa.list()).toEqual([])
    expect(f.saa.save({ ...draft, checkpoint: {} }, context).checkpoint.ruledOut).toBe('')
  })
})
