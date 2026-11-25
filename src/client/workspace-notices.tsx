import { useEffect, useRef, useState, type RefObject } from 'react'
import type { OrderResultNotice, ResultNoticeList } from '../core/workspace-notices.ts'
import { Markdown } from './markdown.tsx'
import type { Scoped } from './superhub-api.ts'
import { segment, useV2Read, useV2Write } from './workspace-v2-api.ts'
import { Issue, readableTime, V2Dialog, V2Icon } from './workspace-v2-elements.tsx'
import { isAttachmentView } from './workspace-v2-response.ts'
import { V2AttachmentContent } from './workspace-v2-talk.tsx'

const path = '/v2/notices'
interface NoticeDetail extends Scoped { notice:OrderResultNotice; text:string }
function notice(value: unknown): value is OrderResultNotice {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<OrderResultNotice>
  return typeof row.id === 'string' && typeof row.orderId === 'string' && typeof row.workspaceId === 'string' &&
    typeof row.sessionId === 'string' && typeof row.title === 'string' && typeof row.workspaceName === 'string' &&
    typeof row.orderTitle === 'string' && typeof row.at === 'string' && typeof row.version === 'string' && typeof row.read === 'boolean' &&
    ['report','partial','weekly'].includes(row.kind ?? '') && Array.isArray(row.attachments) && (row.orderDone === undefined || row.orderDone === true) &&
    row.attachments.every(ref => !!ref && typeof ref.id === 'string' && typeof ref.label === 'string' && typeof ref.version === 'string')
}
function validList(value: Scoped): value is ResultNoticeList {
  const list = value as Partial<ResultNoticeList>
  return Number.isSafeInteger(list.unread) && Number.isSafeInteger(list.total) && Array.isArray(list.items) && list.items.every(notice)
}
function validDetail(value: Scoped, resource: string): value is NoticeDetail {
  const data = value as Partial<NoticeDetail>
  return notice(data.notice) && resource === path + '/' + segment(data.notice.id) && typeof data.text === 'string'
}
const validRead = (data: Scoped) => notice((data as Partial<NoticeDetail>).notice)
const status = {report:'提交了报告，完成情况见正文', partial:'提交了阶段回报，仍有事项待处理', weekly:'本期周报已生成'}

interface Props {
  today: boolean
  goToday: () => void
  openOrder: (row: OrderResultNotice) => void
  openSource: (row: OrderResultNotice) => void
}
export function OrderResultInbox({today, goToday, openOrder, openSource}: Props) {
  const [offset,setOffset] = useState(0)
  const [history,setHistory] = useState(false)
  const [selected,setSelected] = useState<string>()
  const historyButton = useRef<HTMLButtonElement>(null)
  const query = useV2Read(path + (offset ? '?offset=' + offset : ''),validList,6000)
  const list = query.data
  if (!today) return list?.unread ? <button className="v2-link v2-result-alert" onClick={() => {setOffset(0);goToday()}}>
    <V2Icon name="book"/>{list.unread} 条新交付</button> : null
  if (!list?.total && !selected) return query.error ? <Issue text={query.error} retry={query.refresh}/> : null
  const rows = list?.items.filter(row => history || !row.read) ?? []
  const close = () => setSelected(undefined)
  return <section className="v2-result-inbox" aria-label="工单交付提醒">
    <div className="v2-section-head"><h2 aria-live="polite"><V2Icon name="book"/>工单交付{list?.unread ? '（' + list.unread + ' 条未读）' : ''}</h2>
      {list && list.total > list.unread && <button ref={historyButton} className="v2-link" onClick={() => {setOffset(0);setHistory(!history)}}>{history ? '只看未读' : '查看已读'}</button>}</div>
    <Issue text={query.error} retry={query.refresh}/>
    {rows.length > 0 && <div className="v2-card">{rows.map(row => <button type="button" key={row.id} className="v2-row"
      onClick={() => setSelected(row.id)}>
      <span className="v2-row-title"><strong>{row.title}</strong><V2Icon name="next"/></span>
      <small>{row.orderTitle}{row.orderDone && ' · 工单已完成'} · {status[row.kind]} · {readableTime(row.at)}{history && (row.read ? ' · 已读' : ' · 未读')}</small>
    </button>)}</div>}
    {(offset > 0 || list?.nextOffset !== undefined && (history || list.unread > list.nextOffset)) && <div className="v2-actions">
      {offset > 0 && <button className="v2-link" onClick={() => setOffset(Math.max(0,offset-25))}>上一页</button>}
      {list?.nextOffset !== undefined && <button className="v2-link" onClick={() => setOffset(list.nextOffset!)}>下一页</button>}
    </div>}
    {selected && <ResultReader key={selected} id={selected} close={close} changed={query.refresh} fallbackFocus={historyButton}
      openOrder={row => {close();openOrder(row)}} openSource={row => {close();openSource(row)}}/>}
  </section>
}

function ResultReader({id,close,changed,openOrder,openSource,fallbackFocus}: {
  id:string;close:()=>void;changed:()=>Promise<void>;openOrder:Props['openOrder'];openSource:Props['openSource'];
  fallbackFocus:RefObject<HTMLButtonElement | null>
}) {
  const base = path + '/' + segment(id)
  const query = useV2Read(base,validDetail)
  const record = query.data?.notice
  const write = useV2Write(validRead)
  const attempted = useRef(false)
  const [choice,setChoice] = useState<string>()
  const selected = record?.attachments.find(ref => ref.id === choice) ?? record?.attachments[0]
  const document = useV2Read(selected ? base + '/attachments/' + segment(selected.id) : undefined,isAttachmentView)
  async function markRead() {
    const receipt = await write.post<Scoped & {notice:OrderResultNotice}>(base + '/read',{})
    if (receipt?.notice.id === id && receipt.notice.read) await changed()
  }
  useEffect(() => {
    if (!record || record.read || attempted.current) return
    attempted.current = true
    void markRead()
  },[record?.id,record?.read])
  return <V2Dialog title={record?.title ?? '交付报告'} meta={record?.workspaceName} close={close} fallbackFocus={fallbackFocus}>
    <Issue text={query.error} retry={query.refresh}/><Issue text={write.error} retry={markRead}/>
    {record && <><p className="v2-quiet">{status[record.kind]} · {readableTime(record.at)}</p>
      {record.attachments.length > 1 && <div className="v2-actions">{record.attachments.map(ref => <button className="v2-link"
        key={ref.id} aria-pressed={selected?.id === ref.id} onClick={() => setChoice(ref.id)}>{ref.label}</button>)}</div>}
      <Issue text={document.error} retry={document.refresh}/>
      {document.data ? <V2AttachmentContent item={document.data.attachment}/>
        : selected && !document.error ? <p role="status">正在读取报告…</p> : <Markdown text={query.data!.text} className="v2-markdown"/>}
      <div className="v2-actions"><button className="v2-button" onClick={() => openOrder(record)}>打开工单</button>
        {record.messageId && <button className="v2-link" onClick={() => openSource(record)}>定位原话</button>}</div>
    </>}
  </V2Dialog>
}
