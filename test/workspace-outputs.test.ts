import { describe, expect, it } from 'vitest'
import type { V2Message, V2Session } from '../src/core/workspace-v2.ts'
import { publishedOutputs, workspaceOutputs } from '../src/dsh/workspace-outputs.ts'

const session = (id: string, legacy?: V2Session['legacyMessageOrder']): V2Session => ({id, workspaceId: 'w', title: id, kind: 'coding', executor: 'codex',
  delegationIds: [], closed: false, createdAt: '2026-11-25T00:00:00Z', ...(legacy && {legacyMessageOrder: legacy})})
const line = (id: string, minute: number, rest: Partial<V2Message>): V2Message => ({id, role: 'agent', author: 'Codex', speakerId: 'codex',
  at: '2026-11-25T08:' + String(minute).padStart(2, '0') + ':00Z', text: '', ...rest})

describe('workspaceOutputs：编程会话与旧会话', () => {
  it('没有文件路径时每个附件各算一个产物；主人附件、讨论、未列出（已退役）的工单都不算；与工单「交付成果」一致', () => {
    const coding = session('s1', {id: 'old', through: '2026-11-25T08:02:00Z'})
    const transcript = {messages: [
      line('m1', 1, {attachments: [{id: 'a1', label: '旧报告.md'}]}),
      line('m2', 3, {workOrderId: 'd1', attachments: [{id: 'a2', label: '方案.md'}, {id: 'a3', label: '方案.md'}]}),
      line('m3', 4, {role: 'user', author: '你', speakerId: 'owner', workOrderId: 'd1', attachments: [{id: 'a4', label: '草稿.md'}]}),
      line('m4', 5, {attachments: [{id: 'a5', label: '讨论.md'}]}),
      line('m5', 6, {workOrderId: 'retired', attachments: [{id: 'a6', label: '退役.md'}]}),
    ]}
    const orders = [{id: 'd1', title: '新方案'}, {id: 'old', title: '旧单'}]
    const rows = workspaceOutputs([{session: coding, transcript, orders}])
    expect(rows.map(row => [row.key, row.label, row.orders.map(order => order.id)])).toEqual([
      ['s1/a2', '方案.md', ['d1']], ['s1/a3', '方案.md', ['d1']], ['s1/a1', '旧报告.md', ['old']]])
    expect(rows[0]).toMatchObject({sessionId: 's1', messageId: 'm2', attachment: {id: 'a2'}, deliveredBy: [{id: 'codex', name: 'Codex'}]})
    // The same lines as each order's 「交付成果」.
    for (const order of orders) {
      expect(rows.filter(row => row.orders.some(o => o.id === order.id)).map(row => row.attachment.id).sort())
        .toEqual(publishedOutputs(coding, transcript, order.id).map(row => row.attachment.id).sort())
    }
  })

  it('同名附件在不同会话里是不同产物；交付人按身份去重，缺身份时按署名', () => {
    const rows = workspaceOutputs([
      {session: session('s1'), orders: [{id: 'd1', title: '一'}], transcript: {messages: [line('m1', 1, {workOrderId: 'd1', attachments: [{id: 'a', label: '表.md'}]})]}},
      {session: session('s2'), orders: [{id: 'd2', title: '二'}], transcript: {messages: [line('m1', 2, {workOrderId: 'd2', speakerId: undefined, author: '旧执行者', attachments: [{id: 'a', label: '表.md'}]})]}},
    ])
    expect(rows.map(row => [row.key, row.deliveredBy])).toEqual([['s2/a', [{id: '旧执行者', name: '旧执行者'}]], ['s1/a', [{id: 'codex', name: 'Codex'}]]])
  })
})
