import { describe, expect, it } from 'vitest'
import { PAGE_DEFAULT, PAGE_MAX, pageQuery, pageWindow } from '../src/core/paging.ts'

const rows = Array.from({ length: 300 }, (_, i) => ({ id: 'm' + i }))
const key = (row: { id: string }) => row.id
const ids = (items: { id: string }[]) => items.map(key)

describe('pageQuery', () => {
  it('keeps the legacy shape when no paging parameter is present', () => {
    expect(pageQuery(new URLSearchParams('scope=x'))).toBeUndefined()
  })
  it('defaults and caps the limit', () => {
    expect(pageQuery(new URLSearchParams('before=m3'))).toEqual({ limit: PAGE_DEFAULT, before: 'm3' })
    expect(pageQuery(new URLSearchParams('limit=500'))).toEqual({ limit: PAGE_MAX })
    expect(pageQuery(new URLSearchParams('limit=7&around=m9'))).toEqual({ limit: 7, around: 'm9' })
  })
  it('rejects invalid limits, empty cursors and several cursors at once', () => {
    for (const query of ['limit=0', 'limit=abc', 'limit=1.5', 'before=', 'before=a&after=b', 'around=a&before=b'])
      expect(() => pageQuery(new URLSearchParams(query)), query).toThrow(expect.objectContaining({ status: 400 }))
  })
})

describe('pageWindow', () => {
  it('returns the newest window without a cursor', () => {
    const { items, page } = pageWindow(rows, key, { limit: 40 })
    expect(ids(items)).toEqual(ids(rows.slice(260)))
    expect(page).toEqual({ older: true, newer: false })
  })
  it('pages strictly before and after a message', () => {
    const before = pageWindow(rows, key, { limit: 40, before: 'm260' })
    expect(ids(before.items)).toEqual(ids(rows.slice(220, 260)))
    expect(before.page).toEqual({ older: true, newer: true })
    const first = pageWindow(rows, key, { limit: 40, before: 'm25' })
    expect(ids(first.items)).toEqual(ids(rows.slice(0, 25)))
    expect(first.page.older).toBe(false)
    const after = pageWindow(rows, key, { limit: 40, after: 'm279' })
    expect(ids(after.items)).toEqual(ids(rows.slice(280)))
    expect(after.page).toEqual({ older: true, newer: false })
    expect(pageWindow(rows, key, { limit: 40, after: 'm299' }).items).toEqual([])
  })
  it('centres a window on a message and shifts it at the edges', () => {
    const middle = pageWindow(rows, key, { limit: 40, around: 'm150' })
    expect(middle.items[0]!.id).toBe('m131')
    expect(middle.items).toHaveLength(40)
    expect(ids(middle.items)).toContain('m150')
    expect(middle.page).toEqual({ older: true, newer: true })
    const early = pageWindow(rows, key, { limit: 40, around: 'm10' })
    expect(ids(early.items)).toEqual(ids(rows.slice(0, 40)))
    expect(early.page).toEqual({ older: false, newer: true })
    const late = pageWindow(rows, key, { limit: 40, around: 'm298' })
    expect(ids(late.items)).toEqual(ids(rows.slice(260)))
    expect(late.page).toEqual({ older: true, newer: false })
  })
  it('answers 410 for a cursor that is not in the list', () => {
    expect(() => pageWindow(rows, key, { limit: 40, before: 'gone' })).toThrow(expect.objectContaining({ status: 410, message: '消息已不可用' }))
  })
  it('handles short and empty lists', () => {
    expect(pageWindow([], key, { limit: 40 })).toEqual({ items: [], page: { older: false, newer: false } })
    expect(pageWindow(rows.slice(0, 3), key, { limit: 40 }).page).toEqual({ older: false, newer: false })
  })
})
