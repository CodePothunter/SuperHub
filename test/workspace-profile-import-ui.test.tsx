import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROFILE_IMPORT_ROOT, type ProfileImportDetail, type ProfileImportItem } from '../src/core/profile-import.ts'
import type { Scoped } from '../src/client/superhub-api.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import { WorkspaceProfileImports } from '../src/client/workspace-profile-import.tsx'

const id = 'profile-' + 'a'.repeat(64)
const original = '<img src="https://example.invalid/pixel"> 我可能偏好日报。 [推断]'
const inferred: ProfileImportItem = {
  id:'item-' + 'b'.repeat(32), version:1, category:'preferences', text:'我可能偏好日报。',
  quote:original, sourceType:'inference', confidential:false, status:'pending',
  targets:[{id:'new',label:'关于我 · 偏好 · 新增条目',version:0}],
}

function show(items: ProfileImportItem[], responseId = id) {
  const response: ProfileImportDetail = {scope:'brain',record:{
    id:responseId, source:'Claude', at:'2026-11-23T08:00:00Z', status:'review',
    pending:items.filter(item => item.status === 'pending').length, total:items.length, text:original, items,
  }}
  const list = {scope:'brain', imports:[]}
  const responses: Record<string, Scoped> = {[PROFILE_IMPORT_ROOT]:list,[PROFILE_IMPORT_ROOT + '/' + id]:response}
  vi.spyOn(api,'useV2Read').mockImplementation((path, valid) => {
    const value = path && responses[path]
    return {data:path && value && valid(value,path) ? value : undefined, error:undefined, refresh:async () => {}}
  })
  return renderToStaticMarkup(<WorkspaceProfileImports selected={id} open={vi.fn()}/>)
}

afterEach(() => vi.restoreAllMocks())

describe('个人资料核对页', () => {
  it('renders exact source text without embedding markup and asks the owner to clarify inferences', () => {
    const html = show([inferred])
    expect(html).toContain('待核实')
    expect(html).toContain('核实并编辑')
    expect(html).not.toContain('>采纳</button>')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })

  it('requires a destination choice and distinguishes multiple replacement targets by their current text', () => {
    const label = '关于我 · 偏好 · 替换条目'
    const html = show([{...inferred,sourceType:'memory',targets:[
      {id:'one', label, version:'1'.repeat(64), current:'上午安静工作'},
      {id:'two', label, version:'1'.repeat(64), current:inferred.text, match:true},
    ]}])
    expect(html).toContain('选择目标资料')
    expect(html).toContain(label + ' · 上午安静工作')
    expect(html).toContain(label + ' · 我可能偏好日报。 · 已记录')
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>采纳<\/button>/)
  })

  it('does not render private details returned for a different import', () => {
    expect(show([inferred], 'profile-' + 'c'.repeat(64))).not.toContain(inferred.text)
  })
})
