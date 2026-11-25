/** Human-readable scenarios, seeded through the same scoped APIs as the product. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { until } from './acceptance-host.mjs'
import { humanScenario, liaisonWork, teach } from './superhub-vertical-probe.mjs'

export async function seedHumanScenario(host, index) {
  const scope = (await host.api('/state')).superhubScope
  const post = (path, fields) => host.api(`/superhub/${path}`, { requestId: randomUUID(), scope, ...fields })
  const get = path => host.api(`/superhub/${path}?scope=${encodeURIComponent(scope)}`)
  const label = `${index % 2 ? '北区' : '南区'}客户交付报告（第 ${index} 期）`
  const owner = index % 2 ? '林岚' : '周宁'
  const approver = index % 2 ? '陈静' : '赵晴'
  const create = async (name, fields = {}) => (await post('goals', { expectedVersion: 0, name,
    horizon: '本周', owner, type: 'project', status: 'active', reason: '独立的产品使用验收场景', ...fields })).goal
  const dependency = await create(`${label} · 业务确认`, { owner: approver })
  const goal = await create(`发布${label}`, {
    relations: [{ kind: 'requires', target: dependency.id }],
    criteria: [{ text: '交付文件包含晨光商贸的完整登记' }, { text: '交付文件包含远航科技的完整登记' }, { text: `${approver}已确认报送内容` }],
  })
  const before = new Date(Date.now() - 1_000).toISOString()
  await post('review', { from: new Date(Date.parse(before) - 7_200_000).toISOString(), to: before,
    goalIds: [goal.id], goalVersions: [{ id: goal.id, version: 1 }], tickets: [], references: [],
    alignment: '已明确本周报告范围，待核对交付文件。', bottleneck: '客户登记仍待补齐。',
    nextFocus: '补齐并核对客户登记。', firstStep: '打开交付文件核对两条客户登记。', coordination: '完成核对后交给业务负责人。',
    drift: '页面颜色调整留到稍后。', checkpoint: { blockedOn: '客户登记仍待核对', ruledOut: '无需重新整理整份报告', resumeAt: '打开客户登记文件' } })
  // Owner inputs reach the liaison; the scripted liaison registers a memo and the report task.
  const memoText = `记一下：${label}的配色微调留到下班前批量处理，不影响发布。`
  await teach(host, memoText, [['chief_inbox', { text: `${label}的配色微调留到下班前批量处理`, intent: 'memo', operation: 'read' }]])
  await liaisonWork(host, scope, (await post('items', { text: memoText, goalIds: [goal.id] })).id)
  const workText = `请核对${label}，将晨光商贸和远航科技的客户登记整理成《${humanScenario.artifact}》，完成后交给主人验收。`
  await teach(host, workText, [['chief_inbox', { text: `核对${label}：在工单目录写入《${humanScenario.artifact}》，整理晨光商贸和远航科技的客户登记，回读并登记文件`,
    title: `核对${label}`, staff: 'researcher', operation: 'read' }]])
  const receipt = await post('items', { text: workText, goalIds: [goal.id] })
  const ticketId = (await liaisonWork(host, scope, receipt.id)).linked[0].items[0].ticketId
  assert.ok(ticketId, '场景必须产生一张实际工单')
  const mission = await until(async () => {
    const found = await get(`mission/${ticketId}`)
    assert.notEqual(found.ticket.stage, 'you/blocked', '验收场景执行失败')
    return found.ticket.stage === 'you/review' && found.criteria.every(row => row.status === 'pass') ? found : undefined
  }, '准备报告成果及独立核验', 60_000)
  const verified = mission.evidence.find(row => row.kind === 'delivery' && row.id === mission.criteria[0].evidenceIds[0])
  assert.ok(verified?.version)
  const proof = await get(`evidence/${ticketId}/${verified.id}`)
  assert.deepEqual(proof.content.trim().split(/\r?\n/), humanScenario.lines, '真人场景必须包含实际写入且独立核验的可读客户登记')
  const changed = await post(`goals/${goal.id}`, { expectedVersion: 1, reason: '核对交付文件，记录仍待业务确认的发布条件',
    assessment: { result: 'blocked', note: `两条登记均已核对，等待${approver}确认报送内容`,
      findings: goal.versions.at(-1).criteria.map((condition, i) => ({ criterionId: condition.id,
        status: i < 2 ? 'met' : 'unmet', note: i < 2 ? '已核对登记文件的对应条目' : `等待${approver}确认`,
        evidence: i < 2 ? [{ ticketId, evidenceId: verified.id }] : [] })) } })
  return { scope, fixtureVersion: humanScenario.id, goalId: goal.id, goalVersion: changed.current.version, goalName: changed.current.name,
    ticketId, evidenceId: verified.id, evidenceVersion: verified.version, from: before,
    expected: { owner, approver, blocker: `${approver}尚未确认报送内容`, waitingFor: '主人验收工单',
      progress: '两条客户登记已补齐并独立核对', nonBlocking: '报告配色微调',
      requiredReference: { ticketId, evidenceId: verified.id, version: verified.version } } }
}
