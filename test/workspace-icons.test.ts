import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { recommendWorkspaceIcon, type WorkspaceIcon } from '../src/core/workspace-icons.ts'
import type { V2Workspace } from '../src/core/workspace-v2.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'

it.each([
  ['品牌Landing', '', 'landing'],
  ['品牌ＬａｎｄｉｎｇＰａｇｅ', '', 'landing'],
  ['我的交办', '', 'inbox'],
  ['命运', '', 'orbit'],
  ['健康', '记录每周运动和睡眠', 'health'],
  ['新计划', '梳理睡眠与体检数据', 'health'],
  ['产品研发', '交付报名页', 'prototype'],
  ['客户访谈', '', 'recorder'],
  ['研究周报', '', 'report'],
  ['秋季招聘', '', 'people'],
  ['季度整理', '核对账单和发票', 'finance'],
  ['新安排', 'Plan the team’s travel itinerary', 'travel'],
  ['写作选题', '', 'content'],
  ['读书会', '', 'learning'],
  ['Reportage', '', 'project'],
  ['未命名的内容', '', 'project'],
])('uses the workspace purpose for %s (%s)', (name, goal, icon) => {
  expect(recommendWorkspaceIcon(name, goal)).toBe(icon)
})

it('persists the selected artwork and refreshes only automatic artwork after a change of purpose', () => {
  const root = mkdtempSync(join(tmpdir(), 'superhub-workspace-icon-'))
  const scope = 'artwork'
  try {
    const store = new WorkspaceV2Store(root, scope)
    const create = (name: string, requestId: string, icon?: WorkspaceIcon) => {
      const body = { name, requestId, ...(icon && {icon}) }
      return store.createWorkspace(mutationKey(['v2','workspaces'], body), body).workspace
    }
    const automatic = create('产品研发', 'automatic')
    const manual = create('产品研发', 'manual', 'learning')
    expect(automatic).toMatchObject({icon:'prototype',iconMode:'auto'})
    expect(manual).toMatchObject({icon:'learning',iconMode:'manual'})
    expect(manual.id).not.toBe(automatic.id)
    expect(create('产品研发', 'manual', 'learning')).toEqual(manual)
    const invalid = {name:'项目',requestId:'invalid',icon:'__proto__'}
    expect(() => store.createWorkspace(mutationKey(['v2','workspaces'], invalid), invalid)).toThrow('请选择可用的工作区头像')
    expect(store.list()).toHaveLength(2)
    const change = (space: V2Workspace) => {
      const body = {name:'旅行计划',requestId:'edit-' + space.id}
      return store.updateWorkspace(mutationKey(['liaison','workspace-update'], body), space.id, body).workspace
    }
    expect(change(automatic)).toMatchObject({id:automatic.id,icon:'travel',iconMode:'auto'})
    expect(change(manual)).toMatchObject({id:manual.id,icon:'learning',iconMode:'manual'})
    store.dispose()

    const reopened = new WorkspaceV2Store(root, scope)
    expect(reopened.list().map(row=>[row.id,row.icon])).toEqual([[automatic.id,'travel'],[manual.id,'learning']])
    reopened.dispose()
  } finally { rmSync(root, {recursive:true, force:true}) }
})

it('repairs old automatic images and their create receipts once, retaining all other workspace data', () => {
  const root = mkdtempSync(join(tmpdir(), 'superhub-workspace-icon-'))
  const scope = 'legacy-artwork'
  try {
    const store = new WorkspaceV2Store(root, scope)
    const body = {name:'主题整理',goal:'分析睡眠和运动记录',requestId:'original-create'}
    const mutation = mutationKey(['v2','workspaces'], body)
    const original = store.createWorkspace(mutation, body).workspace
    const unknown = {id:'old',name:'历史项目 7',goal:'',owner:'我',createdAt:'2026-11-20T05:00:00Z',archivedAt:'2026-11-25T05:00:00Z'}
    store.dispose()
    const file = join(root, 'ops', 'superhub-v2', workspaceFingerprint(scope) + '.json')
    const board = JSON.parse(readFileSync(file, 'utf8')) as {
      workspaces: V2Workspace[]; receipts: Record<string, {result: {workspace: V2Workspace}}>
    }
    for (const record of [board.workspaces[0]!,board.receipts[mutation.key]!.result.workspace]) {
      record.icon = 'report'
      delete record.iconMode
    }
    board.workspaces.unshift(unknown)
    writeFileSync(file, JSON.stringify(board))

    const reopened = new WorkspaceV2Store(root, scope)
    expect(reopened.list()).toEqual([{...unknown,icon:'project',iconMode:'auto'},original])
    expect(reopened.createWorkspace(mutation, body).workspace).toEqual(original)
    reopened.dispose()
    const saved = readFileSync(file, 'utf8')
    new WorkspaceV2Store(root, scope).dispose()
    expect(readFileSync(file, 'utf8')).toBe(saved)
  } finally { rmSync(root, {recursive:true, force:true}) }
})
