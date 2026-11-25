import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GROUP_LEDGER_FILE, GROUP_SEEN_FILE, GroupLedger, readGroupLedger } from '../src/dsh/workspace-group-ledger.ts'

const roots: string[] = []
function temp() { const p = mkdtempSync(join(tmpdir(), 'chief-group-ledger-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

const clock = () => { let t = Date.UTC(2026, 10, 24, 8); return () => (t += 1000) }
const owner = (text: string) => ({ kind: 'message' as const, speakerId: 'owner', author: '主人', text })

describe('group ledger', () => {
  it('appends rows with a monotonic seq through say() and reads them back after a reopen', () => {
    const dir = join(temp(), 'ws', 'group')
    const ledger = new GroupLedger(dir, clock())
    expect(ledger.lastSeq).toBe(0)
    const first = ledger.say({ ...owner('@工程师 看一下 arkcli'), mentions: ['eng', 'eng'], workOrderId: 'd1' })
    const second = ledger.say({ kind: 'progress', speakerId: 'eng', author: '工程师', text: '在跑 arkcli', replyTo: 1, batchId: 'b1', workOrderId: 'd1' })
    const third = ledger.say({ kind: 'event', speakerId: 'host', author: 'SuperHub', text: '工程师 4 分钟没有动静', event: 'missed' })
    const fourth = ledger.say({ kind: 'message', speakerId: 'eng', author: '工程师', text: '结果见附件', mentions: [], all: true, attachments: [{ name: 'out.txt', path: 'work/out.txt', size: 3 }] })
    expect([first.seq, second.seq, third.seq, fourth.seq]).toEqual([1, 2, 3, 4])
    expect(first).toEqual({ seq: 1, at: '2026-11-24T08:00:01.000Z', kind: 'message', speakerId: 'owner', author: '主人', text: '@工程师 看一下 arkcli', mentions: ['eng'], workOrderId: 'd1' })
    expect(second).toMatchObject({ kind: 'progress', mentions: [], replyTo: 1, batchId: 'b1' })
    expect(third.event).toBe('missed')
    expect(fourth).toMatchObject({ all: true, attachments: [{ name: 'out.txt', path: 'work/out.txt', size: 3 }] })
    const reopened = new GroupLedger(dir)
    expect(reopened.all()).toEqual([first, second, third, fourth])
    expect(reopened.lastSeq).toBe(4)
    expect(reopened.say(owner('继续')).seq).toBe(5)
    expect(readFileSync(join(dir, GROUP_LEDGER_FILE), 'utf8').trim().split('\n')).toHaveLength(5)
  })

  it('rejects rows that are not message, progress or event, or have no speaker', () => {
    const ledger = new GroupLedger(temp())
    expect(() => ledger.say({ ...owner('x'), kind: 'working' as never })).toThrow(/不认识的行类型/)
    expect(() => ledger.say({ ...owner('x'), speakerId: '' })).toThrow(/发言人/)
    expect(ledger.lastSeq).toBe(0)
  })

  it('skips a torn last line from a crash and closes it before the next append', () => {
    const dir = temp()
    const ledger = new GroupLedger(dir)
    ledger.say(owner('一'))
    ledger.say(owner('二'))
    const file = join(dir, GROUP_LEDGER_FILE)
    appendFileSync(file, '{"seq":3,"at":"2026-11-24T08:00:00.000Z","kind":"mess')
    const reopened = new GroupLedger(dir)
    expect(reopened.all().map(line => line.text)).toEqual(['一', '二'])
    expect(reopened.say(owner('三')).seq).toBe(3)
    expect(readGroupLedger(file).map(line => [line.seq, line.text])).toEqual([[1, '一'], [2, '二'], [3, '三']])
  })

  it('tolerates garbage, blank and non-advancing lines in the middle', () => {
    const dir = temp()
    const file = join(dir, GROUP_LEDGER_FILE)
    const row = (seq: number, text: string) => JSON.stringify({ seq, at: 'x', kind: 'message', speakerId: 'owner', author: '主人', text, mentions: [] })
    writeFileSync(file, [row(1, 'a'), 'not json', '', row(1, 'dup'), JSON.stringify({ seq: 2, kind: 'message' }), row(3, 'c'), ''].join('\n'))
    expect(new GroupLedger(dir).all().map(line => [line.seq, line.text])).toEqual([[1, 'a'], [3, 'c']])
    expect(new GroupLedger(dir).say(owner('d')).seq).toBe(4)
  })

  it('reads since a seq, with an optional limit of the latest lines', () => {
    const ledger = new GroupLedger(temp())
    for (const text of ['1', '2', '3', '4', '5']) ledger.say(owner(text))
    expect(ledger.since(2).map(line => line.seq)).toEqual([3, 4, 5])
    expect(ledger.since(0, { limit: 2 }).map(line => line.seq)).toEqual([4, 5])
    expect(ledger.since(5)).toEqual([])
    expect(ledger.get(3)?.text).toBe('3')
  })

  it('keeps a per-member read cursor that only moves forward and survives a reopen', () => {
    const dir = temp()
    const ledger = new GroupLedger(dir)
    for (let i = 1; i <= 3; i++) ledger.say(owner(String(i)))
    expect(ledger.seen('eng')).toBeUndefined()
    expect(ledger.markSeen('eng', 2)).toBe(2)
    expect(ledger.markSeen('eng', 1)).toBe(2)
    expect(ledger.markSeen('eng', 99)).toBe(3)
    expect(ledger.markSeen('res', 1)).toBe(1)
    const reopened = new GroupLedger(dir)
    expect(reopened.seen('eng')).toBe(3)
    expect(reopened.seen('res')).toBe(1)
    expect(JSON.parse(readFileSync(join(dir, GROUP_SEEN_FILE), 'utf8'))).toEqual({ eng: 3, res: 1 })
  })

  it('a broken seen file reads as nobody has read yet', () => {
    const dir = temp()
    writeFileSync(join(dir, GROUP_SEEN_FILE), '{broken')
    const ledger = new GroupLedger(dir)
    expect(ledger.seen('eng')).toBeUndefined()
  })

  it('unseen: the last 12 lines the first time, then only others\' lines after the cursor, at most 24', () => {
    const ledger = new GroupLedger(temp())
    for (let i = 1; i <= 20; i++) ledger.say(owner(String(i)))
    expect(ledger.unseen('eng').map(line => line.seq)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
    ledger.markSeen('eng', 20)
    ledger.say({ kind: 'message', speakerId: 'eng', author: '工程师', text: '我自己的话' })
    ledger.say({ kind: 'message', speakerId: 'res', author: '研究员', text: '别人的话' })
    expect(ledger.unseen('eng').map(line => line.text)).toEqual(['别人的话'])
    for (let i = 0; i < 30; i++) ledger.say(owner(`more ${i}`))
    expect(ledger.unseen('eng')).toHaveLength(24)
    expect(ledger.unseen('eng').at(-1)?.text).toBe('more 29')
  })

  it('refuses a ledger file that was replaced by a symlink', () => {
    const dir = temp()
    const elsewhere = join(temp(), 'other.jsonl')
    writeFileSync(elsewhere, '')
    mkdirSync(dir, { recursive: true })
    symlinkSync(elsewhere, join(dir, GROUP_LEDGER_FILE))
    expect(() => new GroupLedger(dir).say(owner('x'))).toThrow(/归属已改变/)
  })
})
