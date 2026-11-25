import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defaultWorkspaceIcon, type V2Workspace } from '../src/core/workspace-v2.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'

it('assigns workspace artwork once and carries it across retries, older boards, reordering and a rename', () => {
  const root = mkdtempSync(join(tmpdir(), 'superhub-workspace-icon-'))
  const scope = 'artwork'
  try {
    const store = new WorkspaceV2Store(root, scope)
    const create = (name: string, requestId: string) => {
      const body = { name, requestId }
      return store.createWorkspace(mutationKey(['v2', 'workspaces'], body), body).workspace
    }
    const product = create('产品研发', 'product')
    const interview = create('客户访谈', 'interview')
    const report = create('研究周报', 'report')
    const duplicate = create('产品研发', 'another-product')
    const old = create('个人事务', 'personal')
    expect([product.icon, interview.icon, report.icon]).toEqual(['prototype', 'recorder', 'report'])
    expect(duplicate.id).not.toBe(product.id)
    expect(create('产品研发', 'product')).toEqual(product)
    store.dispose()

    const file = join(root, 'ops', 'superhub-v2', workspaceFingerprint(scope) + '.json')
    const board = JSON.parse(readFileSync(file, 'utf8')) as {workspaces: V2Workspace[]}
    board.workspaces.find(row => row.id === product.id)!.name = '已改名的工作区'
    delete board.workspaces.find(row => row.id === old.id)!.icon
    board.workspaces.reverse()
    writeFileSync(file, JSON.stringify(board))

    const reopened = new WorkspaceV2Store(root, scope)
    expect(reopened.workspace(product.id).icon).toBe('prototype')
    expect(reopened.workspace(duplicate.id).id).toBe(duplicate.id)
    const selected = defaultWorkspaceIcon(old.id, old.name)
    expect(reopened.workspace(old.id).icon).toBe(selected)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {workspaces: V2Workspace[]}
    expect(saved.workspaces.find(row => row.id === old.id)?.icon).toBe(selected)
    reopened.dispose()
  } finally { rmSync(root, {recursive:true, force:true}) }
})
