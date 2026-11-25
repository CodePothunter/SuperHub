import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Chat } from '../src/client/chat.tsx'
import type { Ticket } from '../src/core/model.ts'
import type { ChatView } from '../src/dsh/chat.ts'
import { snapshotOutputs } from '../src/dsh/deliveries.ts'
import { Outbox } from '../src/dsh/outbox.ts'
import { enqueueResultNotice, noticeDelivery, resultDelivery } from '../src/dsh/result-notices.ts'

const cleanup: string[] = []
afterEach(() => cleanup.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const at = '2026-11-19T01:00:00.000Z'
const scope = 'a'.repeat(32)
function fixture(withFile = true) {
  const root = mkdtempSync(join(tmpdir(), 'chief-result-notice-'))
  cleanup.push(root)
  const file = 'work/T-0001/research.md'
  mkdirSync(join(root, 'work/T-0001'), { recursive: true })
  if (withFile) writeFileSync(join(root, file), '# 客户访谈结论\n\n已核对三份访谈记录。')
  const deliveries = withFile ? snapshotOutputs(root, 'T-0001', [file]) : []
  const ticket: Ticket = {
    id: 'T-0001', title: '核对访谈结论', staff: 'researcher', createdAt: at, priority: 1, inputs: [], events: ['source'],
    mandate: { eventId: 'source', strength: 'explicit', level: 'think', scope: '核对访谈结论', doneWhen: ['完成比对'], needsReview: false },
    assignments: [{ id: 'assignment-one', staff: 'researcher', executor: 'dsh', round: 0, state: 'reported', startedAt: at, endedAt: at,
      report: { status: 'ready', summary: '三份记录的日期一致。', structured: true, outputs: [file] }, deliveries }],
    ended: { at, outcome: 'done', note: '本次工作已结束' },
  }
  const outboxFile = join(root, 'ops/outbox.json')
  const outbox = new Outbox(outboxFile)
  return { root, file, ticket, outbox, outboxFile }
}

describe('接口人的通用工作结果回执', () => {
  it('已办结的真实结果可直接阅读原版本，重启只保留一条且不会新增外部推送', async () => {
    const f = fixture()
    expect(enqueueResultNotice(f.outbox, f.root, scope, f.ticket)).toBe(true)
    const notice = f.outbox.recent(5)[0]!
    expect(notice).toMatchObject({ kind: 'result', push: 'local', ticketId: f.ticket.id, assignmentId: 'assignment-one', at,
      delivery: { path: f.file, version: f.ticket.assignments[0]!.deliveries![0]!.version, title: '客户访谈结论' } })
    expect(notice.text).toContain('三份记录的日期一致。')
    expect(notice.text).not.toContain('验收通过')
    const reopened = new Outbox(f.outboxFile)
    expect(enqueueResultNotice(reopened, f.root, scope, f.ticket)).toBe(false)
    expect(reopened.recent(5)).toHaveLength(1)
    const send = vi.fn(async () => {})
    await reopened.dispatch(send, false)
    expect(send).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(f.outboxFile, 'utf8'))).toHaveLength(1)
    // A later edit must not silently change the receipt's immutable reading target.
    writeFileSync(join(f.root, f.file), '# 后来修改的内容')
    expect(resultDelivery(f.root, f.ticket)).toBeUndefined()
    expect(noticeDelivery(f.root, f.ticket, notice)).toEqual(notice.delivery)
    rmSync(join(f.root, 'ops/delivery-versions/T-0001', notice.delivery!.version + '.json'))
    expect(noticeDelivery(f.root, f.ticket, notice)).toBeUndefined()
  })

  it('无文件的工作仍主动交代结果，不把汇报中的路径当成可读取的交付', () => {
    const f = fixture(false)
    expect(enqueueResultNotice(f.outbox, f.root, scope, f.ticket)).toBe(true)
    expect(f.outbox.recent(1)[0]).toMatchObject({ kind: 'result', text: expect.stringContaining('三份记录的日期一致。') })
    expect(f.outbox.recent(1)[0]!.delivery).toBeUndefined()
    // A legacy report may name a real file without a recorded version: keep the result, not an invented citation.
    writeFileSync(join(f.root, f.file), '# 旧交付')
    delete f.ticket.assignments[0]!.deliveries
    expect(resultDelivery(f.root, f.ticket)).toBeUndefined()
  })

  it('等待决定的回执可带交付，已提醒验收的工作办结后不再新增结果卡', () => {
    const f = fixture()
    delete f.ticket.ended
    expect(enqueueResultNotice(f.outbox, f.root, scope, f.ticket)).toBe(false)
    const delivery = resultDelivery(f.root, f.ticket)!
    f.outbox.enqueue('need:T-0001:you/review:1', '等你验收', new Date(at), f.ticket.id,
      { assignmentId: f.ticket.assignments[0]!.id, delivery })
    expect(noticeDelivery(f.root, f.ticket, f.outbox.recent(1)[0]!)).toEqual(delivery)
    f.ticket.ended = { at, outcome: 'done', note: '已验收' }
    expect(enqueueResultNotice(f.outbox, f.root, scope, f.ticket)).toBe(false)
    expect(f.outbox.recent(5)).toHaveLength(1)
  })

  it('停止、失败、未生成结果和其他第二大脑不能冒充已完成结果', () => {
    const f = fixture()
    for (const outcome of ['failed', 'stopped', 'dropped'] as const) {
      expect(enqueueResultNotice(f.outbox, f.root, scope, { ...f.ticket, ended: { at, outcome, note: '' } })).toBe(false)
    }
    expect(enqueueResultNotice(f.outbox, f.root, scope, { ...f.ticket,
      assignments: [{ ...f.ticket.assignments[0]!, report: { status: 'failed', summary: '未完成', structured: true } }] })).toBe(false)
    expect(enqueueResultNotice(f.outbox, f.root, scope, { ...f.ticket,
      superhub: { brainScope: 'other', sourceId: 'source', commandId: 'command', contracts: [] } })).toBe(false)
    expect(f.outbox.recent(5)).toEqual([])
  })
})

describe('接口人的结果阅读与注意力层级', () => {
  const render = (notices: ChatView['notices']) => renderToStaticMarkup(<Chat messages={[]} notices={notices} busy={false}
    openTicket={() => {}} openDelivery={() => {}} say={async () => true} draft="" setDraft={() => {}} inputRef={{ current: null }}
    empty={false} openImport={() => {}} />)
  it('有实际交付才提供阅读按钮，无文件结果仍有查看结果入口，不把路径和哈希作为正文', () => {
    const f = fixture(), delivery = resultDelivery(f.root, f.ticket)!
    const notice = { key: 'result:T-0001:assignment-one', at, text: '核对访谈结论已有结果。', ticketId: f.ticket.id, kind: 'result' as const, done: true }
    const withFile = render([{ ...notice, delivery }])
    expect(withFile).toContain('阅读交付')
    expect(withFile).toContain('查看结果')
    expect(withFile).not.toContain('work/T-0001')
    expect(withFile).not.toContain(delivery.version)
    expect(render([notice])).not.toContain('阅读交付')
    expect(render([notice])).toContain('查看结果')
  })
  it('默认收起其余提醒，仍明确列出待处理数量，并提供显式按钮而不是整个卡片假装按钮', () => {
    const active = Array.from({ length: 5 }, (_, i) => ({ key: `need:T-${i}:you/answer:1`, at: new Date(Date.parse(at) + i).toISOString(), text: `问题${i}`, ticketId: `T-${i}` }))
    const result = Array.from({ length: 4 }, (_, i) => ({ key: `result:T-${i}:done`, at: new Date(Date.parse(at) + 100 + i).toISOString(), text: `结果${i}`, ticketId: `T-${i}`, kind: 'result' as const, done: true }))
    const html = render([...active, ...result])
    expect(html).toContain('其余 5 条提醒与结果')
    expect(html).toContain('2 条待处理')
    const history = html.indexOf('<details class="wr-notice-history">')
    expect(html.slice(0, history).match(/class="wr-msg notice /g)).toHaveLength(4)
    expect(html).not.toContain('role="button"')
    expect(html).toContain('回复</button>')
  })
})
