import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { V2Delegation, V2Session } from '../src/core/workspace-v2.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import { checkedOrderBrief, interimOrderBrief } from '../src/dsh/workspace-order-brief.ts'
import { workspaceV2Routes } from '../src/dsh/workspace-v2.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}) })
const raw = '  # 展馆作业 · 展示核查（8 题）\n\n完成本次展馆的八项核查。请在全部完成后交付逐题答案、每题耗时和执行记录。本次仅涉及读取、计算和撰写。\n\n## 按题执行\n'+
  Array.from({length:8},(_,i) => (i+1)+'. 核对展示材料\n'+'查阅样例文档与现有证据。'.repeat(95)).join('\n')+'\n\n这是原始交办末行。\n '
const brief = {title:'展馆八项核查',promise:'完成八项只读核查，交付逐题答案、耗时和执行记录。',sessionTitle:'展馆核查讨论'}
function setup() {
  const root = mkdtempSync(join(tmpdir(),'order-brief-')); roots.push(root)
  return {root,store:new WorkspaceV2Store(root,'daily')}
}

it('accepts a single semantic summary, sends the complete original, and keeps the first accepted wording on replay', async () => {
  const {store} = setup(), send = vi.fn(async () => {})
  const route = workspaceV2Routes({store,source:{send,read:async () => ({messages:[]}),attachment:async () => undefined}})
  const accept = (summary:Partial<typeof brief>) => route.assign('owner-brief',raw,'dsh',undefined,undefined,summary)
  expect(() => accept({title:raw,promise:raw})).toThrow('重新概括')
  expect(() => accept({})).toThrow('交办')
  expect(store.list()).toHaveLength(0)
  const {workspace,delegation,session} = accept(brief)
  expect(accept({...brief,title:'措辞变体'}).delegation).toMatchObject({id:delegation.id,title:brief.title,promise:brief.promise})
  expect(session.title).toBe(brief.sessionTitle)
  expect(store.orderOriginal(workspace.id,delegation.id)).toEqual({text:raw,complete:true})
  expect(store.view(workspace.id).orders[0]).not.toHaveProperty('original')
  expect(JSON.stringify(store.view(workspace.id))).not.toContain('这是原始交办末行')
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  expect(send).toHaveBeenCalledWith(expect.objectContaining({id:session.id}),expect.objectContaining({text:raw,workOrderId:delegation.id}),expect.any(AbortSignal),expect.anything())
  expect(() => store.orderOriginal('别的范围',delegation.id)).toThrow('没有这张工单')
  route.dispose()
})

it('migrates verified automatic labels in place using the original agreement, leaving handwritten labels and partial deliveries intact', () => {
  const {root,store} = setup()
  const job = store.assign('old-rpc',raw,'dsh',undefined,undefined,brief)
  const manualInput = {requestId:'manual',title:raw.trim().slice(0,198),kind:'group',executor:'dsh'}
  const manual = store.createSession(mutationKey(['sessions'],manualInput),job.workspace.id,manualInput).session
  const attached = store.assign('second-rpc',raw,'dsh',job.workspace.id,manual.id,brief)
  const handwrittenInput = {requestId:'user-wrote',title:'自行命名的工作',promise:'保留长说明\n'+raw.slice(0,6000)}
  const handwritten = store.createDelegation(mutationKey(['orders'],handwrittenInput),job.workspace,handwrittenInput).delegation
  const path = join(root,'ops','superhub-v2',workspaceFingerprint('daily')+'.json')
  const old = JSON.parse(readFileSync(path,'utf8'))
  delete old.originals
  old.starts=[]
  for (const row of [job,attached]) {
    const saved = old.receipts['req-'+row.firstRequestId.slice(6)].result
    const current = old.delegations.find((o:V2Delegation) => o.id === row.delegation.id)
    const session = old.sessions.find((s:V2Session) => s.id === row.session.id)
    for (const item of [saved.delegation,current]) {
      item.title=raw.trim().slice(0,200); item.promise=raw.trim().slice(0,8000); delete item.hasOriginal
    }
    if (row === job) saved.session.title = session.title = current.title
    current.remainingTurns=7; current.generation=2
  }
  writeFileSync(path,JSON.stringify(old))
  const migrated = new WorkspaceV2Store(root,'daily')
  const sources = vi.fn(() => [{requestId:'old-rpc',text:raw},{requestId:'second-rpc',text:raw}])
  const evidence = () => ({report:{label:'片段.md',text:'# 只完成两题的报告\n\n## 部分记录'}})
  migrated.restoreAssignmentBriefs(sources,evidence)
  const one = migrated.delegation(job.workspace.id,job.delegation.id)
  expect(one).toMatchObject({title:'展馆作业 · 展示核查（8 题）',sessionId:job.session.id,hasOriginal:true,remainingTurns:7,generation:2})
  expect(one.promise).toContain('逐题答案、每题耗时和执行记录')
  expect(one.promise).toContain('仅涉及读取')
  expect(one.promise).not.toContain('两题')
  expect(migrated.orderOriginal(job.workspace.id,one.id)).toEqual({text:raw,complete:true})
  expect(migrated.session(job.workspace.id,job.session.id).title).toBe(one.title)
  expect(migrated.session(job.workspace.id,manual.id).title).toBe(manualInput.title)
  expect(migrated.delegation(job.workspace.id,handwritten.id)).toEqual(handwritten)
  expect(migrated.pendingStarts()).toEqual([])
  const replay = migrated.assign('old-rpc',raw,'dsh',undefined,undefined,{title:'重试起名',promise:'试图改变已接单文案'})
  expect(replay.delegation).toMatchObject({id:one.id,title:one.title,promise:one.promise})
  migrated.restoreAssignmentBriefs(sources,evidence)
  expect(sources).toHaveBeenCalledOnce()
  expect(migrated.view(job.workspace.id).orders).toHaveLength(3)
})

it('keeps a meaningful complete phrase when an old source is incomplete and rejects multiline new labels', () => {
  expect(interimOrderBrief('# 核对材料\n\n## 步骤\n1. 读取目录')).toEqual({title:'核对材料',promise:'交付要求详见原始交办。'})
  expect(() => checkedOrderBrief(raw,{title:'核对\n资料',promise:'整理记录。'})).toThrow('重新概括')
  const name = randomUUID()
  expect(checkedOrderBrief('记录标识 '+name,{title:'记录标识',promise:'交回标识清单。'}).title).toBe('记录标识')
})
