import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceOutput } from '../src/core/workspace-v2.ts'
import type { Scoped } from '../src/client/superhub-api.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import { arrangeOutputs, availableFilter, outputChoices, OutputsBoard, RecentOutputs } from '../src/client/workspace-outputs.tsx'
import { isWorkspaceOutputs } from '../src/client/workspace-v2-response.ts'
import { readPlace } from '../src/client/workspace-v2.tsx'

const base = '/v2/workspaces/w'
const path = base + '/outputs'
const researcher = {id:'staff:researcher', name:'研究员'}, engineer = {id:'staff:engineer', name:'工程师'}
const billing = {id:'d1', title:'方舟计费'}, prices = {id:'d2', title:'核对价目'}
const output = (label: string, minute: number, orders = [billing], deliveredBy = [researcher]): WorkspaceOutput => ({
  key:'k-' + label, label, at:'2026-11-25T08:' + String(minute).padStart(2, '0') + ':00Z',
  sessionId:'s', messageId:'g-' + minute, attachment:{id:'g-' + minute + '-0', label}, orders, deliveredBy})
// Newest first, as the host answers.
const seven = [
  output('汇总', 7, [billing], [engineer]),
  output('计费表', 6, [prices, billing]),
  output('价目', 5, [prices]),
  output('报价单', 4),
  output('Alpha 说明', 3, [billing], [engineer]),
  output('附录', 2),
  output('草图', 1, [prices], [engineer]),
]
const feed = {live: true, revision: 3}
const answer = (outputs: WorkspaceOutput[], issue?: string) => ({scope:'brain', workspaceId:'w', outputs, ...(issue && {issue})})

function mockReads(responses: Record<string, Scoped>) {
  return vi.spyOn(api, 'useV2Read').mockImplementation((resource, valid) => {
    const value = resource ? responses[resource] : undefined
    return {data: resource && value && valid(value, resource) ? value : undefined, error: undefined, refresh: async () => {}}
  })
}
const titles = (html: string) => [...html.matchAll(/<strong>(?:<svg.*?<\/svg>)?(.*?)<\/strong>/g)].map(match => match[1])
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('工作区产物：概览「最近产物」', () => {
  it('只列最近 5 个，标题旁给出「查看全部（7）」，每个带工单名标签', () => {
    mockReads({[path]: answer(seven)})
    const html = renderToStaticMarkup(createElement(RecentOutputs, {base, feed, showAll: vi.fn(), openOrder: vi.fn()}))
    expect(html).toContain('最近产物')
    expect(html).toContain('查看全部（7）')
    expect(titles(html)).toEqual(['汇总', '计费表', '价目', '报价单', 'Alpha 说明'])
    // On the overview a tag opens its order; filtering by a tag happens on the board.
    expect(html).toContain('aria-label="打开工单「核对价目」"')
    expect(html).toContain('aria-label="打开工单「方舟计费」"')
    expect(html).not.toContain('只看工单')
    expect(html).toContain('研究员')
  })

  it('有工单还在进行时每 15 秒重读，否则只在工单变化时重读', () => {
    const read = mockReads({[path]: answer(seven)})
    renderToStaticMarkup(createElement(RecentOutputs, {base, feed, showAll: vi.fn(), openOrder: vi.fn()}))
    expect(read).toHaveBeenLastCalledWith(path, isWorkspaceOutputs, 15000, 3)
    renderToStaticMarkup(createElement(OutputsBoard, {base, feed: {live: false, revision: 4}}))
    expect(read).toHaveBeenLastCalledWith(path, isWorkspaceOutputs, undefined, 4)
  })

  it('没有产物时整块不出现', () => {
    mockReads({[path]: answer([])})
    expect(renderToStaticMarkup(createElement(RecentOutputs, {base, feed, showAll: vi.fn(), openOrder: vi.fn()}))).toBe('')
  })
})

describe('工作区产物：「产物」版面', () => {
  it('列出全部产物，带排序与按工单、按交付人筛选，标签可点即按该工单筛选', () => {
    mockReads({[path]: answer(seven)})
    const html = renderToStaticMarkup(createElement(OutputsBoard, {base, feed}))
    expect(titles(html)).toEqual(seven.map(row => row.label))
    expect(html).toContain('7 个产物')
    expect(html).toMatch(/<option value="recent" selected="">最近交付<\/option><option value="name">名称<\/option>/)
    expect(html).toContain('<option value="d1">方舟计费</option>')
    expect(html).toContain('<option value="staff:engineer">工程师</option>')
    expect(html).toContain('aria-label="只看工单「核对价目」的产物"')
    expect(html).not.toContain('清除筛选')
  })

  it('还没有产物时说明会列在这里；部分会话读不到时提示，其余照常显示', () => {
    mockReads({[path]: answer([])})
    expect(renderToStaticMarkup(createElement(OutputsBoard, {base, feed}))).toContain('还没有产物')
    mockReads({[path]: answer(seven.slice(0, 1), '有的会话暂时读不到，产物可能不全，请稍后重试')})
    const html = renderToStaticMarkup(createElement(OutputsBoard, {base, feed}))
    expect(html).toContain('暂时读不到')
    expect(titles(html)).toEqual(['汇总'])
  })

  it('排序：默认最近交付，切到名称按中文名称排列', () => {
    expect(arrangeOutputs([...seven].reverse(), 'recent').map(row => row.label)).toEqual(seven.map(row => row.label))
    const byName = arrangeOutputs(seven, 'name').map(row => row.label)
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b, 'zh-CN')))
    // Chinese names in pinyin order (bao, cao, fu, hui, ji, jia); the zh-CN collation puts Latin names after them.
    expect(byName).toEqual(['报价单', '草图', '附录', '汇总', '计费表', '价目', 'Alpha 说明'])
  })

  it('筛选：按工单（同一份文件属于两张工单时两边都在）、按交付人，二者可叠加；无结果为空', () => {
    expect(arrangeOutputs(seven, 'recent', {order: 'd2'}).map(row => row.label)).toEqual(['计费表', '价目', '草图'])
    expect(arrangeOutputs(seven, 'recent', {order: 'd1'}).map(row => row.label)).toEqual(['汇总', '计费表', '报价单', 'Alpha 说明', '附录'])
    expect(arrangeOutputs(seven, 'recent', {by: 'staff:engineer'}).map(row => row.label)).toEqual(['汇总', 'Alpha 说明', '草图'])
    expect(arrangeOutputs(seven, 'name', {order: 'd2', by: 'staff:engineer'}).map(row => row.label)).toEqual(['草图'])
    expect(arrangeOutputs(seven, 'recent', {order: 'gone'})).toEqual([])
    expect(outputChoices(seven)).toEqual({orders: [billing, prices], deliveredBy: [engineer, researcher]})
  })

  it('选中的工单或交付人已不在产物里时不再筛选（例如工单被移除）', () => {
    const choices = outputChoices(seven)
    expect(availableFilter({order: 'd2', by: 'staff:engineer'}, choices)).toEqual({order: 'd2', by: 'staff:engineer'})
    expect(availableFilter({order: 'gone', by: 'staff:engineer'}, choices)).toEqual({by: 'staff:engineer'})
    expect(availableFilter({order: 'gone', by: 'nobody'}, choices)).toEqual({})
    expect(arrangeOutputs(seven, 'recent', availableFilter({order: 'gone'}, choices))).toHaveLength(seven.length)
  })
})

describe('工作区产物：地址与响应', () => {
  it('「产物」版面有自己的地址，刷新后仍在', () => {
    vi.stubGlobal('location', {hash: '#v2?scope=brain&view=workspace&workspace=w&panel=outputs'})
    expect(readPlace('brain')).toMatchObject({view: 'workspace', workspace: 'w', panel: 'outputs'})
    vi.stubGlobal('location', {hash: '#v2?scope=brain&view=workspace&workspace=w&panel=staff'})
    expect(readPlace('brain')).toMatchObject({panel: 'staff'})
  })

  it('「经验」有独立的工作区地址，忽略混入的个人条目或工单参数', () => {
    vi.stubGlobal('location', {hash: '#v2?scope=brain&view=workspace&workspace=w&panel=experience&item=private&order=stale'})
    expect(readPlace('brain')).toEqual({view:'workspace',workspace:'w',panel:'experience'})
    expect(readPlace('other')).toEqual({view:'today'})
  })

  it('只接受本工作区的产物，每个须有工单标签', () => {
    const value = answer(seven)
    expect(isWorkspaceOutputs(value, path)).toBe(true)
    expect(isWorkspaceOutputs(answer([], '读不到'), path)).toBe(true)
    expect(isWorkspaceOutputs({...value, workspaceId: 'other'}, path)).toBe(false)
    expect(isWorkspaceOutputs(value, base + '/orders/d1/outputs')).toBe(false)
    expect(isWorkspaceOutputs(answer([{...seven[0]!, orders: []}]), path)).toBe(false)
    expect(isWorkspaceOutputs(answer([{...seven[0]!, key: ''}]), path)).toBe(false)
    expect(isWorkspaceOutputs(answer([{...seven[0]!, deliveredBy: [{id: 'x'}]}] as unknown as WorkspaceOutput[]), path)).toBe(false)
    expect(isWorkspaceOutputs({...value, issue: 3}, path)).toBe(false)
  })
})
