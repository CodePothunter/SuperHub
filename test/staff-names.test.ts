/** 讨论成员、执行记录与头像的角色名按花名册解析（R8-6）。 */
import { describe, expect, it } from 'vitest'
import { roomParticipants } from '../src/client/room-members.ts'
import { staffKey, staffName } from '../src/client/staff-names.ts'

// 2026-11-19 生产讨论 ticket-T-0020 的花名册与成员：成员以幕僚 id 命名。
const roster = [
  { id: 'chief', name: '研判官' }, { id: 'engineer', name: '工程师' }, { id: 'liaison', name: '外务' }, { id: 'researcher', name: '研究员' },
  { id: 'reviewer', name: '审查官' }, { id: 'scribe', name: '书记官' }, { id: 'strategist', name: '谋士' }, { id: 'ui-smith', name: '界面师' },
]

describe('角色名按花名册解析', () => {
  it('lead 是接口人；liaison、chief 等幕僚 id 显示花名册中文名，未知 id 原样显示', () => {
    expect(staffName('lead', roster)).toBe('接口人')
    expect(staffName('you', roster)).toBe('你')
    expect(['chief', 'liaison', 'scribe', 'ui-smith'].map(id => staffName(id, roster))).toEqual(['研判官', '外务', '书记官', '界面师'])
    expect(staffName('fact-checker', roster)).toBe('fact-checker')
    expect(staffKey('书记官', roster)).toBe('scribe')
    expect(staffKey('外务', roster)).toBe('liaison')
    expect(staffKey('接口人', roster)).toBe('lead')
  })

  it('讨论成员列表不出现 chief/liaison/scribe/ui-smith 原始 id', () => {
    const names = ['lead', 'chief', 'engineer', 'liaison', 'reviewer', 'scribe', 'strategist', 'ui-smith']
    const members = names.map((name, i) => ({ id: `m-${i}`, name, role: name === 'lead' ? 'lead' : 'teammate', status: 'inactive' }))
    const labels = roomParticipants(members as never, [], roster).map(row => row.label)
    expect(labels).toEqual(['接口人', '研判官', '工程师', '外务', '审查官', '书记官', '谋士', '界面师'])
  })
})
