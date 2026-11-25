import { useState } from 'react'
import type { HistoryItem, PeopleList } from '../core/workspace-history.ts'
import { groupPeople } from './people.ts'
import type { Scoped } from './superhub-api.ts'
import { HistoryRecord, isHistoryItem, PersonRows, personImportance } from './workspace-history.tsx'
import { useV2Read } from './workspace-v2-api.ts'
import { Issue, V2Icon } from './workspace-v2-elements.tsx'

function isDirectory(value: Scoped): value is PeopleList {
  return 'items' in value && Array.isArray(value.items) && value.items.every(item => isHistoryItem(item) && item.kind === 'person')
    && (!('issue' in value) || typeof value.issue === 'string' || value.issue === undefined)
}

const searchable = (text: string) => text.normalize('NFKC').trim().toLocaleLowerCase()
const organizationKey = (item: HistoryItem) => item.person?.organization?.trim() ? 'organization:' + item.person.organization.trim() : 'ungrouped'

export function WorkspacePeople({ selected, open, back }: { selected?: string; open: (id: string) => void; back: () => void }) {
  const directory = useV2Read('/v2/people', isDirectory, 15000)
  const [query, setQuery] = useState('')
  const [organization, setOrganization] = useState('')
  const [importance, setImportance] = useState('')
  if (selected) return <HistoryRecord key={selected} id={selected} personDirectory back={back} openItem={open}/>
  const { data } = directory
  const items = data?.items ?? []
  const organizations = groupPeople(items.map(item => ({ organization:item.person?.organization })))
  const activeOrganization = organizations.some(group => group.key === organization) ? organization : ''
  const words = searchable(query)
  const matches = items.filter(item => {
    const person = item.person
    if (activeOrganization && activeOrganization !== organizationKey(item)) return false
    if (importance && importance !== (person?.influence ?? 'unknown')) return false
    return !words || [item.title, person?.team, person?.organization, person?.role, item.subtitle, ...(person?.groups ?? [])]
      .some(text => text && searchable(text).includes(words))
  })
  return <section className="v2-people" aria-label="人物名册">
    <Issue text={directory.error || data?.issue} retry={directory.refresh}/>
    {!data && !directory.error && <p className="v2-quiet" role="status">正在读取人物名册…</p>}
    {data && (items.length ? <>
      <div className="v2-people-tools">
        <label className="v2-people-search"><span>搜索人物</span><span><V2Icon name="search"/>
          <input type="search" aria-label="搜索人物" placeholder="姓名、机构、职务或关系" value={query} onChange={e => setQuery(e.target.value)}/></span></label>
        <label>组织<select aria-label="组织" value={activeOrganization} onChange={e => setOrganization(e.target.value)}>
          <option value="">全部组织</option>
          {organizations.map(g => <option key={g.key} value={g.key}>{g.key === 'ungrouped' ? '组织待补' : g.label}</option>)}
        </select></label>
        <label>重要性<select aria-label="重要性" value={importance} onChange={e => setImportance(e.target.value)}>
          <option value="">全部重要性</option>
          {Object.entries(personImportance).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
          <option value="unknown">待补</option>
        </select></label>
      </div>
      <div className="v2-people-count" role="status">{matches.length === items.length ? items.length + ' 人' : '找到 ' + matches.length + ' 人，共 ' + items.length + ' 人'}</div>
      {matches.length ? <PersonRows items={matches} openItem={open}/> : <div className="v2-empty">
        <p>没有符合这些条件的人物。</p>
        <button type="button" className="v2-link" onClick={() => {setQuery('');setOrganization('');setImportance('')}}>清除筛选</button>
      </div>}
    </> : !data.issue && <div className="v2-empty"><strong>还没有人物档案</strong><p>可以把认识的人及其组织告诉接口人。</p></div>)}
  </section>
}
