import { useState } from 'react'
import type { WorkOrderOutput, WorkspaceOutput } from '../core/workspace-v2.ts'
import { useV2Read } from './workspace-v2-api.ts'
import { Issue, readableTime, V2Icon } from './workspace-v2-elements.tsx'
import { isWorkspaceOutputs } from './workspace-v2-response.ts'
import { V2AttachmentDialog } from './workspace-v2-talk.tsx'
import { attachmentResource, outputSourceKey } from './workspace-output-source.ts'

/** How many of the latest outputs the overview shows. */
export const RECENT_OUTPUTS = 5
export type OutputSort = 'recent' | 'name'
export interface OutputFilter { order?: string; by?: string }

/** The board's sort and filters: newest delivery first by default, or by name; an order or a deliverer narrows it. */
export function arrangeOutputs(rows: WorkspaceOutput[], sort: OutputSort, filter: OutputFilter = {}): WorkspaceOutput[] {
  const shown = rows.filter(row => (!filter.order || row.orders.some(order => order.id === filter.order))
    && (!filter.by || row.deliveredBy.some(person => person.id === filter.by)))
  const recent = (a: WorkspaceOutput, b: WorkspaceOutput) => Date.parse(b.at) - Date.parse(a.at)
  return shown.sort(sort === 'name' ? (a, b) => a.label.localeCompare(b.label, 'zh-CN') || recent(a, b) : recent)
}

/** The orders and deliverers the outputs came from, each once, in the order they last delivered. */
export function outputChoices(rows: WorkspaceOutput[]) {
  const orders = new Map<string, WorkspaceOutput['orders'][number]>(), people = new Map<string, string>()
  for (const row of arrangeOutputs(rows, 'recent')) {
    for (const order of row.orders) if (!orders.has(order.id)) orders.set(order.id, order)
    for (const person of row.deliveredBy) if (!people.has(person.id)) people.set(person.id, person.name)
  }
  return {orders: [...orders.values()], deliveredBy: [...people].map(([id, name]) => ({id, name}))}
}

/**
 * Where outputs come from: while an order is still running new files can arrive, so the list is read again every
 * 15 s; otherwise it is read when the orders change (`revision`). Each read goes through every conversation of the
 * workspace, so a quiet workspace is not polled.
 */
export interface OutputsFeed { live: boolean; revision?: string | number }

/** A chosen order or deliverer that is no longer among the outputs (the order was retired, say) stops narrowing the list. */
export function availableFilter(filter: OutputFilter, choices: ReturnType<typeof outputChoices>): OutputFilter {
  return {...choices.orders.some(order => order.id === filter.order) && {order: filter.order},
    ...choices.deliveredBy.some(person => person.id === filter.by) && {by: filter.by}}
}

function useWorkspaceOutputs(base: string, {live, revision}: OutputsFeed) {
  return useV2Read(base + '/outputs', isWorkspaceOutputs, live ? 15000 : undefined, revision)
}

/** What clicking an order tag does: the board narrows to that order, the overview opens it. */
interface TagAction { label: (title: string) => string; pick: (orderId: string) => void }

/** A delivered file: its name, who delivered it and when, and the orders it came from (a tag each). */
function OutputRow({ row, open, tag }: { row: WorkspaceOutput; open: () => void; tag: TagAction }) {
  return <li className="v2-output-row">
    <button type="button" className="v2-output-open" onClick={open}>
      <span className="v2-row-title"><strong><V2Icon name="file"/>{row.label}</strong><V2Icon name="next"/></span>
      <small>{row.deliveredBy.map(person => person.name).join('、')} · {readableTime(row.at)}</small>
    </button>
    <ul className="v2-output-tags" aria-label="来自工单">{row.orders.map(order => <li key={order.id}>
      {order.deletedAt ? <span className="v2-output-tag"><V2Icon name="work"/>{order.title} · 工单已删除</span>
        : <button type="button" className="v2-output-tag" aria-label={tag.label(order.title)} onClick={() => tag.pick(order.id)}>
          <V2Icon name="work"/>{order.title}</button>}</li>)}</ul>
  </li>
}

/** Opens a file in the same reader as an order's 「交付成果」. */
export function OutputSourceAction({row, open}: {row:WorkOrderOutput; open?: (row:WorkOrderOutput) => void}) {
  return row.sessionDeletedAt ? <span className="v2-quiet">来源会话已删除</span> : open &&
    <button type="button" className="v2-link" onClick={() => open(row)}>查看来源</button>
}

function OutputReader({ base, row, close, openSource, selectedOrder }: {
  base: string; row: WorkspaceOutput; close: () => void; openSource?: (row: WorkOrderOutput) => void; selectedOrder?: string
}) {
  const versions = row.versions ?? [row]
  const [chosen, choose] = useState(() => outputSourceKey(versions.find(version => version.orderId === selectedOrder) ?? versions[0] ?? row))
  const version = versions.find(item => outputSourceKey(item) === chosen) ?? row
  return <V2AttachmentDialog path={attachmentResource(base, version)} reference={version.attachment}
    context={row.orders.map(order => order.title).join('、')} close={close}
    actions={<div className="v2-actions">
      {versions.length > 1 && <label>交付版本<select value={outputSourceKey(version)} onChange={event => choose(event.target.value)}>
        {versions.map((item, index) => <option key={outputSourceKey(item)} value={outputSourceKey(item)}>
          {index === 0 ? '最近交付' : '较早交付 ' + (versions.length - index)} · {readableTime(item.at)}
          {item.orderId && ' · ' + (row.orders.find(order => order.id === item.orderId)?.title ?? '工单')}
        </option>)}</select></label>}
      <OutputSourceAction row={version} open={openSource && (source => {close();openSource(source)})}/>
    </div>}/>
}

/** The overview's 「最近产物」: the latest few, and the way to the full board. Nothing when nothing was delivered. */
export function RecentOutputs({ base, feed, showAll, openOrder, openSource }: {
  base: string; feed: OutputsFeed; showAll: () => void; openOrder: (id: string) => void; openSource?: (row: WorkOrderOutput) => void
}) {
  const query = useWorkspaceOutputs(base, feed)
  const [file, setFile] = useState<string>()
  const rows = query.data?.outputs ?? []
  const selected = rows.find(row => row.key === file)
  if (!rows.length) return <Issue text={query.error} retry={query.refresh}/>
  return <section className="v2-outputs v2-recent-outputs" aria-label="最近产物">
    <div className="v2-section-head"><h2><V2Icon name="box"/>最近产物</h2>
      <button type="button" className="v2-link" onClick={showAll}>查看全部（{rows.length}）<V2Icon name="next"/></button></div>
    <Issue text={query.error || query.data?.issue} retry={query.refresh}/>
    <ul className="v2-card v2-output-list">{rows.slice(0, RECENT_OUTPUTS).map(row => <OutputRow key={row.key} row={row} open={() => setFile(row.key)}
      tag={{label: title => '打开工单「' + title + '」', pick: openOrder}}/>)}</ul>
    {selected && <OutputReader key={selected.key} base={base} row={selected} openSource={openSource} close={() => setFile(undefined)}/>}
  </section>
}

/** The 「产物」 board: every file the workspace's orders delivered, sorted and filtered here (not in the address). */
export function OutputsBoard({ base, feed, openSource }: { base: string; feed: OutputsFeed; openSource?: (row: WorkOrderOutput) => void }) {
  const query = useWorkspaceOutputs(base, feed)
  const [sort, setSort] = useState<OutputSort>('recent')
  const [chosen, setFilter] = useState<OutputFilter>({})
  const [file, setFile] = useState<string>()
  const data = query.data
  const rows = data?.outputs ?? []
  const choices = outputChoices(rows)
  const filter = availableFilter(chosen, choices)
  const shown = arrangeOutputs(rows, sort, filter)
  const selected = rows.find(row => row.key === file)
  return <section className="v2-outputs" aria-label="产物">
    <Issue text={query.error || data?.issue} retry={query.refresh}/>
    {!data && !query.error && <p className="v2-quiet" role="status">正在读取产物…</p>}
    {data && (rows.length ? <>
      <div className="v2-output-tools">
        <label>排序<select aria-label="排序" value={sort} onChange={e => setSort(e.target.value === 'name' ? 'name' : 'recent')}>
          <option value="recent">最近交付</option><option value="name">名称</option></select></label>
        <label>工单<select aria-label="按工单筛选" value={filter.order ?? ''} onChange={e => setFilter({...filter, order: e.target.value || undefined})}>
          <option value="">全部工单</option>
          {choices.orders.map(order => <option key={order.id} value={order.id}>{order.title}{order.deletedAt && ' · 工单已删除'}</option>)}</select></label>
        <label>交付人<select aria-label="按交付人筛选" value={filter.by ?? ''} onChange={e => setFilter({...filter, by: e.target.value || undefined})}>
          <option value="">全部交付人</option>
          {choices.deliveredBy.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
      </div>
      <div className="v2-people-count" role="status">{shown.length === rows.length ? rows.length + ' 个产物' : '找到 ' + shown.length + ' 个，共 ' + rows.length + ' 个'}</div>
      {shown.length ? <ul className="v2-card v2-output-list">{shown.map(row => <OutputRow key={row.key} row={row} open={() => setFile(row.key)}
        tag={{label: title => '只看工单「' + title + '」的产物', pick: order => setFilter({...filter, order})}}/>)}</ul>
        : <div className="v2-empty"><p>没有符合这些条件的产物。</p>
          <button type="button" className="v2-link" onClick={() => setFilter({})}>清除筛选</button></div>}
    </> : !data.issue && <div className="v2-empty"><strong>还没有产物</strong><p>工单交出的文件会集中列在这里，并标明来自哪张工单。</p></div>)}
    {selected && <OutputReader key={selected.key} base={base} row={selected} openSource={openSource} selectedOrder={filter.order} close={() => setFile(undefined)}/>}
  </section>
}
