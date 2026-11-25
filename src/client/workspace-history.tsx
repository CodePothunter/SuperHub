import { useState } from 'react'
import { HISTORY_KINDS, historyItemId, type HistoryDetail, type HistoryImport, type HistoryItem, type HistoryKind, type HistoryList } from '../core/workspace-history.ts'
import type { V2AttachmentRef } from '../core/workspace-v2.ts'
import { ExportDrawer } from './export.tsx'
import { Markdown } from './markdown.tsx'
import { groupPeople } from './people.ts'
import { CSS } from './style.ts'
import type { Scoped } from './superhub-api.ts'
import { segment, useV2Read, useV2Write } from './workspace-v2-api.ts'
import { Issue, V2Dialog, V2Icon } from './workspace-v2-elements.tsx'
import { V2AttachmentDialog } from './workspace-v2-talk.tsx'
import { ChatAvatar, chatAvatarStyle } from './workspace-chat-avatar.tsx'
import { isSpeakerId, isSpeakerPortraits, registerSpeakers } from '../core/workspace-avatars.ts'

const ROOT = '/v2/history'
const names: Record<HistoryKind, string> = {
  room: '群聊', person: '人物', commitment: '承诺', line: '工作线', meeting: '会议', project: '项目', goal: '目标', document: '文档',
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const optionalText = (value: unknown) => value === undefined || typeof value === 'string'
const kindOf = (value: unknown): value is HistoryKind => HISTORY_KINDS.some(k => k === value)
const refOf = (value: unknown): value is V2AttachmentRef => record(value) && typeof value.id === 'string' && typeof value.label === 'string'
export const personImportance = { high:'高', mid:'中', low:'低' }
export function isHistoryItem(value: unknown): value is HistoryItem {
  return record(value) && kindOf(value.kind) && typeof value.sourceId === 'string' && value.id === historyItemId(value.kind, value.sourceId)
    && typeof value.title === 'string' && optionalText(value.subtitle) && optionalText(value.at)
    && (value.person === undefined || record(value.person) && optionalText(value.person.organization) && optionalText(value.person.team)
      && optionalText(value.person.role) && (value.person.influence === undefined || value.person.influence === 'high' || value.person.influence === 'mid' || value.person.influence === 'low')
      && (value.person.groups === undefined || Array.isArray(value.person.groups) && value.person.groups.every(s => typeof s === 'string')))
}
function listOf(value: Scoped): value is HistoryList {
  if (!record(value) || !record(value.counts)) return false
  const counts = value.counts
  return count(value.available) && count(value.total) && HISTORY_KINDS.every(k => count(counts[k]))
    && Array.isArray(value.items) && value.items.every(isHistoryItem)
    && (value.nextOffset === undefined || count(value.nextOffset)) && optionalText(value.importedAt) && optionalText(value.sourceIssue)
}
function detailOf(value: Scoped, path: string): value is HistoryDetail {
  return record(value) && isHistoryItem(value.item)
    && (path === ROOT + '/' + segment(value.item.id)
      || value.item.kind === 'person' && (value.origin === 'roster' || value.origin === 'import') && path === '/v2/people/' + segment(value.item.id))
    && optionalText(value.body) && optionalText(value.issue)
    && (value.portraits === undefined || isSpeakerPortraits(value.portraits))
    && Array.isArray(value.attachments) && value.attachments.every(refOf) && Array.isArray(value.links) && value.links.every(refOf)
    && Array.isArray(value.messages) && value.messages.every(m => record(m) && typeof m.id === 'string' && typeof m.author === 'string'
      && typeof m.text === 'string' && optionalText(m.at) && optionalText(m.replyTo) && (m.speakerId === undefined || isSpeakerId(m.speakerId)))
}
function receiptOf(value: Scoped): value is HistoryImport {
  return record(value) && count(value.added) && count(value.updated) && count(value.unchanged) && count(value.total) && typeof value.importedAt === 'string'
    && (value.retained === undefined || count(value.retained)) && (value.incomplete === undefined || count(value.incomplete))
}
const historyStyle = `
.wv2 .v2-history { margin-block:22px; min-width:0; }
.wv2 .v2-history-head { flex-wrap:wrap; }
.wv2 .v2-history-filter { display:flex; flex-wrap:wrap; gap:7px; margin-block:14px; }
.wv2 .v2-history-filter button { padding:4px 11px; min-height:36px; border:1px solid var(--v-line); border-radius:6px; font-size:14px; }
.wv2 .v2-history-filter button[aria-pressed=true] { background:var(--v-leaf); color:var(--v-green); border-color:var(--v-green); }
.wv2 .v2-history .v2-card { overflow-wrap:anywhere; }
.wv2 .v2-history .v2-history-time { flex:none; color:var(--v-muted); font-size:12px; }
.wv2 .v2-history .v2-history-content { padding:clamp(14px,3cqw,28px); margin-block:10px 18px; }
.wv2 .v2-history .v2-history-content pre { overflow:auto; max-width:100%; white-space:pre-wrap; }
.wv2 .v2-history nav[aria-label=资料翻页] { display:flex; justify-content:space-between; align-items:center; margin-block:8px; }
.wv2 .v2-history>section+section { margin-top:18px; }
.wv2 .v2-history .v2-byline { align-items:baseline; }
.wv2 .v2-history .v2-bubble { max-width:78ch; width:fit-content; }
.wv2 .v2-history .v2-history-messages { padding:14px; }
.wv2 .v2-history .v2-history-link { display:flex; margin:4px 0; overflow-wrap:anywhere; }
.wv2 .v2-history .v2-markdown { overflow-x:auto; }
`
const time = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(value)
  return Number.isFinite(date.valueOf()) ? date.toLocaleString('zh-CN', {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : value
}

function Rows({ items, openItem }: { items: HistoryItem[]; openItem: (id: string) => void }) {
  return <div className="v2-card">{items.map(item => <button type="button" className="v2-row" key={item.id}
    onClick={() => openItem(item.id)}>
    <span className="v2-row-title"><strong>{item.title}</strong><V2Icon name="next"/></span>
    <small>{[names[item.kind],item.subtitle,item.at ? time(item.at) : undefined].filter(Boolean).join(' · ')}</small>
  </button>)}</div>
}

export function PersonRows({ items, openItem }: { items: HistoryItem[]; openItem: (id: string) => void }) {
  const groups = groupPeople(items.map(item => ({item,organization:item.person?.organization})))
  return <div className="v2-people-groups">{groups.map(group => <section className="v2-people-group" key={group.key}>
    <header><h3>{group.key === 'ungrouped' ? '组织待补' : group.label}</h3><span>{group.people.length} 人</span></header>
    <div className="v2-card">{group.people.map(({item}) => {
      const person = item.person
      const role = [person?.team,person?.role ?? item.subtitle].filter(Boolean).join(' · ')
      return <button className="v2-row" key={item.id} data-focus={item.id} onClick={() => openItem(item.id)}>
        <span className="v2-row-title"><strong>{item.title}</strong>
          <span className="v2-person-rank" data-level={person?.influence}>重要性 {person?.influence ? personImportance[person.influence] : '待补'}</span></span>
        {role && <small>{role}</small>}{!!person?.groups?.length && <small className="v2-person-relations">关系 · {person.groups.join('、')}</small>}
      </button>
    })}</div>
  </section>)}</div>
}

export function HistoryHome({ openLibrary, openItem }: { openLibrary: () => void; openItem: (id: string) => void }) {
  const index = useV2Read(ROOT + '?limit=3', listOf)
  const data = index.data
  return <section className="v2-history" aria-label="已有资料"><style>{historyStyle}</style>
    <div className="v2-section-head"><h2><V2Icon name="book"/>已有资料</h2>
      <button type="button" className="v2-link" onClick={openLibrary}>{data?.total ? '查看全部资料' : '打开资料库'}<V2Icon name="next"/></button></div>
    <Issue text={index.error} retry={index.refresh}/>
    <Issue text={data?.sourceIssue} retry={index.refresh}/>
    {data?.total ? <Rows items={data.items} openItem={openItem}/>
      : data ? <div className="v2-empty">{data.available
        ? <><p>找到 {data.available} 项可导入的资料。</p>
          <button type="button" className="v2-link" onClick={openLibrary}>查看可导入的资料</button></>
        : data.sourceIssue ? '暂时无法核对可导入的资料。' : '还没有已导入的资料。'}</div>
      : !index.error && <p className="v2-quiet" role="status">正在读取已有资料…</p>}
  </section>
}

export function HistoryPanel({ itemId, openItem, back }: {
  itemId?: string; openItem: (id: string) => void; back: () => void
}) {
  const [kind, setKind] = useState<HistoryKind | ''>('')
  const [offset, setOffset] = useState(0)
  const [receipt, setReceipt] = useState<HistoryImport>()
  const limit = 30
  const params = new URLSearchParams({limit:String(limit),offset:String(offset)})
  if (kind) params.set('kind', kind)
  const index = useV2Read(itemId ? undefined : ROOT + '?' + params, listOf)
  const write = useV2Write(receiptOf)
  const importOld = async () => {
    const result = await write.post<HistoryImport>(ROOT + '/import', {})
    if (!result) return
    setReceipt(result)
    setOffset(0)
    await index.refresh()
  }
  if (itemId?.startsWith('ticket:')) return <div className="v2-empty">这张工单已不可用。 <button className="v2-link" onClick={back}>返回资料库</button></div>
  if (itemId) return <HistoryRecord key={itemId} id={itemId} back={back} openItem={openItem}/>
  const data = index.data
  return <section className="v2-history" aria-label="资料库"><style>{historyStyle}</style>
    <div className="v2-section-head v2-history-head"><h2><V2Icon name="book"/>资料库</h2>
      {data && <button className="v2-button" disabled={write.busy || (!data.available && !data.total)} onClick={importOld}>{write.busy ? '正在导入…' : data.importedAt ? '重新导入旧版资料' : '导入旧版资料'}</button>}</div>
    {receipt && <p className="v2-feedback" role="status">本次新增 {receipt.added} 项，更新 {receipt.updated} 项，已有 {receipt.unchanged} 项内容相同。库中共 {receipt.total} 项。
      {!!receipt.retained && ` 有 ${receipt.retained} 项来源已移走，保留上次导入的版本。`}
      {!!receipt.incomplete && ` 有 ${receipt.incomplete} 项来源尚待补全。`}</p>}
    <Issue text={write.error}/>
    <Issue text={index.error} retry={index.refresh}/>
    <Issue text={data?.sourceIssue} retry={index.refresh}/>
    {!data && !index.error && <p className="v2-quiet" role="status">正在读取资料…</p>}
    {data && (data.total ? <>
      <nav className="v2-history-filter" aria-label="资料分类">
        <button aria-pressed={!kind} onClick={() => {setKind('');setOffset(0)}}>全部 {data.total}</button>
        {HISTORY_KINDS.filter(k => data.counts[k] || k === kind).map(k => <button key={k} aria-pressed={kind === k} onClick={() => {setKind(k);setOffset(0)}}>{names[k]} {data.counts[k]}</button>)}
      </nav>
      {data.items.length ? kind === 'person' ? <PersonRows items={data.items} openItem={openItem}/> : <Rows items={data.items} openItem={openItem}/> : <p className="v2-empty">这一页没有资料。</p>}
      {(offset > 0 || data.nextOffset !== undefined) && <nav aria-label="资料翻页">
        <button className="v2-link" disabled={!offset} onClick={() => setOffset(Math.max(0,offset-limit))}>上一页</button>
        <span>第 {Math.floor(offset/limit)+1} 页</span>
        <button className="v2-link" disabled={data.nextOffset === undefined} onClick={() => data.nextOffset !== undefined && setOffset(data.nextOffset)}>下一页</button></nav>}
    </> : <div className="v2-empty">{data.available
      ? <><strong>找到 {data.available} 项已有资料</strong><p>导入后可按类别查看群聊、人物和文档。</p></>
      : data.sourceIssue ? '暂时无法核对可导入的旧记录。' : '此资料目录目前没有可导入的旧记录。'}</div>)}
  </section>
}

export function HistoryRecord({ id, back, openItem, personDirectory = false }: {
  id: string; back: () => void; openItem: (id: string) => void; personDirectory?: boolean
}) {
  const path = (personDirectory ? '/v2/people' : ROOT) + '/' + segment(id)
  const query = useV2Read(path, detailOf, personDirectory ? 15000 : undefined)
  const [file, setFile] = useState<V2AttachmentRef>()
  const data = query.data
  const messages = new Map(data?.messages.map(message => [message.id,message]))
  const portraits = data?.portraits ?? registerSpeakers({}, data?.messages.flatMap(m => m.speakerId ? [m.speakerId] : []) ?? [])
  return <article className="v2-history" aria-label={personDirectory ? '人物档案' : '资料详情'}><style>{historyStyle + chatAvatarStyle}</style>
    <button className="v2-link" onClick={back}><V2Icon name="back"/>{personDirectory ? '返回人物名册' : '返回资料列表'}</button>
    <Issue text={query.error} retry={query.refresh}/>
    {!data && !query.error && <p className="v2-quiet" role="status">正在读取原记录…</p>}
    {data && <>
      <header className="v2-section-head v2-history-head"><div><p className="v2-eyebrow">{personDirectory ? (data.origin === 'roster' ? '当前花名册' : '已导入的人物档案') : names[data.item.kind]}{data.item.at && ' · ' + (personDirectory ? '最近联系 ' : '') + time(data.item.at)}</p>
        <h2>{data.item.title}</h2>{data.item.subtitle && <p>{data.item.subtitle}</p>}</div>
      </header>
      {data.issue && <p className="v2-source-status">{data.issue}</p>}
      {data.body && <div className="v2-card v2-history-content"><Markdown text={data.body} className="v2-markdown"/></div>}
      {personDirectory && !data.body && !data.links.length && !data.issue && <p className="v2-empty">这份档案还没有其他记录。</p>}
      {data.messages.length > 0 && <section><div className="v2-section-head"><h2>对话记录</h2></div>
        <ol className="v2-card v2-turns v2-history-messages" aria-label="历史发言">{data.messages.map(m => {
          const quoted = m.replyTo ? messages.get(m.replyTo) : undefined
          return <li key={m.id} id={'history-turn-' + m.id} data-message-id={m.id} className={'v2-turn' + (m.speakerId === 'owner' ? ' mine' : '')} tabIndex={-1}>
          <ChatAvatar portrait={m.speakerId ? portraits[m.speakerId] : undefined}/>
          <div className="v2-message"><div className="v2-byline"><strong>{m.author}</strong>{m.at && <time dateTime={m.at}>{time(m.at)}</time>}</div>
          <div className="v2-bubble">{quoted && <button className="v2-quote" onClick={() => document.getElementById('history-turn-' + quoted.id)?.focus()}>回复{quoted.author} · {quoted.text}</button>}
            <Markdown text={m.text} className="v2-markdown"/></div></div></li>
        })}</ol></section>}
      {data.attachments.length > 0 && <section><div className="v2-section-head"><h2>交付物和附件</h2></div>
        {data.attachments.map(a => <button className="v2-link v2-history-link" key={a.id} onClick={() => setFile(a)}><V2Icon name="box"/>{a.label}</button>)}</section>}
      {data.links.length > 0 && <section><div className="v2-section-head"><h2>关联资料</h2></div>
        {data.links.map(link => <button className="v2-link v2-history-link" key={link.id} onClick={() => openItem(link.id)}>{link.label}<V2Icon name="next"/></button>)}</section>}
      {file && data.attachments.some(a => a.id === file.id) && <V2AttachmentDialog path={path + '/attachments/' + segment(file.id)} reference={file} context={data.item.title} close={() => setFile(undefined)}/>}
    </>}
  </article>
}

export function TransferDialog({ mode, close, openLibrary, openProfile }: {
  mode: 'import' | 'export'; close: () => void; openLibrary: () => void; openProfile: () => void
}) {
  if (mode === 'export') return <div className="wr" style={{position:'absolute',inset:0,zIndex:40,background:'transparent'}}>
    <style>{CSS}</style><ExportDrawer modal close={close} openImport={openProfile}/>
  </div>
  return <V2Dialog title="导入资料" close={close}><div className="v2-card v2-rows">
    <button className="v2-row" onClick={openLibrary}><strong>从上一版 SuperHub 导入</strong><small>查看已有群聊、人物和文档。</small></button>
    <button className="v2-row" onClick={openProfile}><strong>从别的助手导入</strong><small>核对 ChatGPT、Claude 等助手对你的了解，再保存到个人资料。</small></button>
  </div></V2Dialog>
}
