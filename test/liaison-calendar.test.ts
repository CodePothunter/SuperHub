import { describe, expect, it, vi } from 'vitest'
import type { CalendarWeek } from '../src/core/workspace-calendar.ts'
import { readLiaisonCalendar } from '../src/dsh/liaison-calendar.ts'

function fixture(): CalendarWeek {
  return {
    scope:'brain', week:'2026-11-16', today:'2026-11-20', timeZone:'Asia/Shanghai',
    entries:[
      {id:'past',sourceId:'work',kind:'external',title:'昨天的事项',start:'2026-11-19',end:'2026-11-20'},
      {id:'busy',sourceId:'work',kind:'external',title:'已占用',start:'2026-11-19T22:00',end:'2026-11-20T07:00'},
      {id:'next',sourceId:'work',kind:'external',title:'明天的事项',start:'2026-11-21T09:00'},
    ],
    sources:[{id:'work',connectionId:'test',provider:'test',app:'日历应用',account:'工作账号',resourceId:'private-id',name:'工作日历',kind:'calendar',capabilities:['calendar.busy.read']}],
    issues:[{sourceId:'work',message:'一项来源暂不可读'}],
  }
}

describe('接口人按本脑授权日历回答', () => {
  it('沿用脑时区的今天、已披露字段、来源与读取问题，保留跨午夜的占用', async () => {
    const read = vi.fn(async () => fixture())
    const day = await readLiaisonCalendar(read,{})
    expect(read).toHaveBeenCalledWith(undefined)
    expect(day).toMatchObject({from:'2026-11-20',through:'2026-11-20',timeZone:'Asia/Shanghai',total:1,
      entries:[{title:'已占用',source:'日历应用 · 工作账号 · 工作日历'}],issues:[{message:'一项来源暂不可读'}]})
    expect(JSON.stringify(day)).not.toContain('private-id')
    expect((await readLiaisonCalendar(read,{range:'week'})).total).toBe(3)
    expect((await readLiaisonCalendar(read,{date:'2026-11-21'})).entries[0]?.title).toBe('明天的事项')
  })

  it('日程较多时有可接续的位置，非法日期和位置在访问来源前失败', async () => {
    const data = fixture()
    data.entries = Array.from({length:41},(_,i) => ({id:String(i),sourceId:'work',kind:'meeting',title:'会议 '+i,start:'2026-11-20T10:00'}))
    const read = vi.fn(async () => data)
    for (const args of [{date:'2026-11-31'},{range:'month'},{offset:-1}]) {
      await expect(readLiaisonCalendar(read,args)).rejects.toThrow()
    }
    expect(read).not.toHaveBeenCalled()
    const first = await readLiaisonCalendar(read,{})
    expect(first.entries).toHaveLength(40)
    expect((await readLiaisonCalendar(read,{offset:first.nextOffset})).entries).toMatchObject([{title:'会议 40'}])
  })
})
