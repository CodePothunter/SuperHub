import { describe, expect, it } from 'vitest'
import { anchoredPage, appendNewer, emptyPaged, mergeTail, pageParams, prependOlder, type Paged } from '../src/client/paged-history.ts'
import { anchorShift, firstVisible } from '../src/client/scroll-anchor.ts'

type Row = { id: string; v?: number }
const id = (row: Row) => row.id
const rows = (from: number, to: number, v = 0): Row[] => Array.from({ length: to - from }, (_, i) => ({ id: 'm' + (from + i), v }))
const ids = (state: Paged<Row>) => state.items.map(id)

describe('分页合并', () => {
  it('第一次读到最新一页时照收', () => {
    expect(mergeTail(emptyPaged<Row>(), rows(260, 300), { older: true, newer: false }, id, true)).toEqual({ items: rows(260, 300), hasOlder: true, hasNewer: false })
  })

  it('轮询并入新消息，已加载的旧页保留且不重复，重叠部分以新数据为准', () => {
    let state = mergeTail(emptyPaged<Row>(), rows(260, 300), { older: true, newer: false }, id, true)
    state = prependOlder(state, rows(220, 260), { older: true, newer: true }, id)
    state = mergeTail(state, rows(263, 303, 1), { older: true, newer: false }, id, false)
    expect(ids(state)).toEqual(rows(220, 303).map(id))
    expect(state.items.find(row => row.id === 'm280')!.v).toBe(1)
    expect(state.items.find(row => row.id === 'm230')!.v).toBe(0)
    expect(state.hasOlder).toBe(true)
    // 同一窗口再读一次：既不丢也不重。
    expect(ids(mergeTail(state, rows(263, 303), { older: true, newer: false }, id, false))).toEqual(ids(state))
  })

  it('最新一页覆盖已加载的开头时，开头之前是否还有消息以服务端为准', () => {
    const short = mergeTail(emptyPaged<Row>(), rows(0, 30), { older: false, newer: false }, id, true)
    const grown = mergeTail(short, rows(5, 45), { older: true, newer: false }, id, true)
    expect(ids(grown)).toEqual(rows(0, 45).map(id))
    expect(grown.hasOlder).toBe(false)
    const same = mergeTail(short, rows(0, 31), { older: false, newer: false }, id, true)
    expect(same.hasOlder).toBe(false)
  })

  it('两次轮询之间新增超过一页：停在底部换成最新一页，往上翻阅时保留并标记还有更新的', () => {
    const state = prependOlder(mergeTail(emptyPaged<Row>(), rows(260, 300), { older: true, newer: false }, id, true), rows(220, 260), { older: true, newer: true }, id)
    const jumped = mergeTail(state, rows(400, 440), { older: true, newer: false }, id, true)
    expect(ids(jumped)).toEqual(rows(400, 440).map(id))
    expect(jumped.hasNewer).toBe(false)
    const kept = mergeTail(state, rows(400, 440), { older: true, newer: false }, id, false)
    expect(ids(kept)).toEqual(ids(state))
    expect(kept.hasNewer).toBe(true)
    // 补到与最新一页重叠后回到 live。
    const caught = mergeTail(appendNewer(kept, rows(300, 410), { older: true, newer: true }, id), rows(400, 440), { older: true, newer: false }, id, false)
    expect(ids(caught)).toEqual(rows(220, 440).map(id))
    expect(caught.hasNewer).toBe(false)
  })

  it('深链接的一页不被轮询替换，向下补到最新时回到 live', () => {
    let state = anchoredPage(rows(0, 40), { older: false, newer: true })
    state = mergeTail(state, rows(260, 300), { older: true, newer: false }, id, true)
    expect(ids(state)).toEqual(rows(0, 40).map(id))
    expect(state.hasNewer).toBe(true)
    state = appendNewer(state, rows(40, 80), { older: true, newer: true }, id)
    expect(state.hasNewer).toBe(true)
    state = appendNewer(state, rows(80, 300), { older: true, newer: false }, id)
    expect(state.hasNewer).toBe(false)
    expect(state.items).toHaveLength(300)
  })

  it('没有分页的旧主机整体替换；整段历史都在一页里时以它为准', () => {
    const state = prependOlder(mergeTail(emptyPaged<Row>(), rows(260, 300), { older: true, newer: false }, id, true), rows(220, 260), { older: true, newer: true }, id)
    expect(mergeTail(state, rows(0, 80), undefined, id, false)).toEqual({ items: rows(0, 80), hasOlder: false, hasNewer: false })
    expect(mergeTail(state, rows(500, 510), { older: false, newer: false }, id, false)).toEqual({ items: rows(500, 510), hasOlder: false, hasNewer: false })
  })

  it('查询串', () => {
    expect(pageParams()).toBe('limit=40')
    expect(pageParams({ before: 'g-3' })).toBe('limit=40&before=g-3')
    expect(pageParams({ around: '10' }, 20)).toBe('limit=20&around=10')
  })
})

describe('阅读位置', () => {
  it('取第一条可见的消息和它离顶部的距离，插入后算出要补的滚动', () => {
    const boxes = [{ id: 'a', top: -300, bottom: -120 }, { id: 'b', top: -120, bottom: 30 }, { id: 'c', top: 30, bottom: 200 }]
    expect(firstVisible(boxes, 0)).toEqual({ id: 'b', offset: -120 })
    expect(firstVisible(boxes, 500)).toBeUndefined()
    // 上方插入 2400px：同一条消息现在在 2280，滚动补 2400 回到原处。
    expect(anchorShift({ id: 'b', offset: -120 }, 2280, 0)).toBe(2400)
    expect(anchorShift({ id: 'b', offset: 20 }, 120, 100)).toBe(0)
  })
})
