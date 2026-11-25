import type { WeeklyReport } from '../core/workspace-followup.ts'
import type { OrderResultNotice, ResultNoticeList, SavedOrderResults } from '../core/workspace-notices.ts'
import { reportFromText } from '../core/report.ts'
import { messageWorkOrder, type V2Attachment, type V2Delegation, type V2DialogueSource, type V2Session, type V2Workspace } from '../core/workspace-v2.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'
import { mutationKey, type WorkspaceV2Store } from './workspace-v2-store.ts'

export interface StoredResult extends Omit<OrderResultNotice, 'orderTitle' | 'workspaceName'> { text: string; requestId?: string }

export const fileVersion = (file: Pick<V2Attachment, 'format' | 'content'>) => workspaceFingerprint([file.format, file.content])
const priorDay = 86_400_000

/** A native receipt describes the report submitted. Closing an order belongs to its separate lifecycle. */
function submitted(text: string) {
  const heading = /^(?:#{1,3}\s+)?(工单回报|阶段回报)[：:]?\s*\n([\s\S]+)$/u.exec(text.trim())
  if (heading && heading[2]!.trim()) return {partial: heading[1] === '阶段回报', text: heading[2]!.trim()}
  if (text.includes('```chief-report')) {
    const report = reportFromText(text)
    if (report.structured && ['ready','blocked','failed'].includes(report.status)) return {partial: report.status !== 'ready', text: report.summary}
  }
}

function orderResults(scope: string, space: V2Workspace, order: V2Delegation, session: V2Session, requestId: string, evidence: SavedOrderResults) {
  const files = new Map(evidence.attachments.map(file => [file.id, file]))
  const results: StoredResult[] = []
  for (const message of evidence.messages) {
    if (message.role !== 'agent' || messageWorkOrder(session,message) !== order.id || !Number.isFinite(Date.parse(message.at))) continue
    const attachments = (message.attachments ?? []).flatMap(ref => {
      const file = files.get(ref.id)
      return file?.label === ref.label && file.content.trim() ? [{...ref,version:fileVersion(file)}] : []
    })
    const report = submitted(message.text)
    if (!attachments.length && !report) continue
    const text = report?.text ?? message.text
    const version = workspaceFingerprint([text,attachments])
    results.push({id:workspaceFingerprint([scope,space.id,order.id,session.id,message.id,version]),version,
      workspaceId:space.id,orderId:order.id,sessionId:session.id,
      messageId:message.id,requestId,title:attachments[0]?.label || (report?.partial ? '阶段回报' : '工单回报'),
      kind:report?.partial ? 'partial' : 'report',at:message.at,read:false,attachments,text})
  }
  return results
}

/** A member's line of a roster group for one of its orders, with the files it links as they read now. */
export interface GroupResultLine {
  seq: number; at: string; text: string; orderId: string
  files: (Pick<V2Attachment, 'id' | 'label' | 'format' | 'content'>)[]
}

/**
 * Results of a roster group's member lines (message id `g-<序号>`): a line that links readable files and/or is a report
 * (「工单回报」/「阶段回报」 first, or a chief-report block). A file version the order already published (`seen`:
 * `<工单>:<版本>`, extended here) is not a new delivery; a line left with neither publishes nothing.
 */
export function groupResults(scope: string, space: V2Workspace, session: V2Session, lines: readonly GroupResultLine[], seen: Set<string>): StoredResult[] {
  const results: StoredResult[] = []
  for (const line of lines) {
    if (!Number.isFinite(Date.parse(line.at))) continue
    const attachments = line.files.flatMap(file => {
      if (!file.content.trim()) return []
      const version = fileVersion(file), key = line.orderId + ':' + version
      if (seen.has(key)) return []
      seen.add(key)
      return [{id: file.id, label: file.label, version}]
    })
    const report = submitted(line.text)
    if (!attachments.length && !report) continue
    const text = report?.text ?? line.text
    const version = workspaceFingerprint([text, attachments])
    const messageId = 'g-' + line.seq
    results.push({id: workspaceFingerprint([scope, space.id, line.orderId, session.id, messageId, version]), version,
      workspaceId: space.id, orderId: line.orderId, sessionId: session.id, messageId,
      title: attachments[0]?.label || (report?.partial ? '阶段回报' : '工单回报'),
      kind: report?.partial ? 'partial' : 'report', at: line.at, read: false, attachments, text})
  }
  return results
}

/** Where group results come from: published from the group ledgers, files read back from their archived versions. */
export interface GroupResultSource {
  /** Publish results of group lines not checked yet. */
  collect(): void
  /** The file of a group result as it was delivered (its version), or undefined when it can no longer be read. */
  attachment(notice: StoredResult, fileId: string): V2Attachment | undefined
}

export function weeklyResult(scope: string, space: V2Workspace, order: V2Delegation, report: WeeklyReport): StoredResult {
  const version = workspaceFingerprint(report.markdown)
  return { id:workspaceFingerprint([scope,space.id,order.id,order.sessionId,report.id,version]), version,
    workspaceId:space.id,orderId:order.id,sessionId:order.sessionId,
    reportId:report.id, title:report.title, at:report.createdAt, read:false, kind:'weekly', attachments:[], text:report.markdown }
}

export class WorkspaceResultNotices {
  constructor(private readonly store: WorkspaceV2Store, private readonly source: V2DialogueSource,
    private readonly current: () => void, private readonly now = () => new Date(),
    /** Called after results were checked, so new results can be reviewed (the liaison's acceptance). */
    private readonly checked?: () => void,
    /** Results of roster groups (absent: only coding and team sessions publish). */
    private readonly groups?: GroupResultSource) {}

  private present({text, requestId, ...notice}: StoredResult): OrderResultNotice {
    const order = this.store.delegation(notice.workspaceId, notice.orderId)
    const workspaceName = this.store.workspace(notice.workspaceId).name
    return {...notice, orderTitle:order.title, workspaceName, ...(order.status === 'done' && {orderDone: true as const})}
  }

  collect(requestId?: string) {
    this.current()
    const failures: unknown[] = []
    if (requestId === undefined && this.groups) try { this.groups.collect() } catch (error) { failures.push(error) }
    if (!this.source.savedResults) {
      if (failures.length) throw failures[0]
      return
    }
    this.store.startResultBackfill(this.now().getTime() - priorDay)
    for (const check of this.store.uncheckedResults(requestId)) {
      try {
        const {order} = check
        const session = this.store.session(order.workspaceId, order.sessionId)
        const evidence = this.source.savedResults(session, check.requestId)
        if (!evidence) continue
        if (check.state === 'unknown') this.store.confirmTurn(session, check.requestId)
        this.store.publishResults(check.requestId, orderResults(this.store.scope, this.store.workspace(order.workspaceId), order, session, check.requestId, evidence))
      } catch (error) { failures.push(error) }
    }
    this.checked?.()
    if (failures.length) throw failures[0]
  }

  list(offset: number): ResultNoticeList {
    this.current()
    if (!Number.isSafeInteger(offset) || offset < 0) return workspaceError(400,'请选择有效的提醒列表位置')
    const rows = this.store.resultNotices().sort((a,b) => Number(a.read) - Number(b.read) || b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    const end = offset + 25
    return {scope:this.store.scope,items:rows.slice(offset,end).map(row => this.present(row)),unread:rows.filter(row => !row.read).length,
      total:rows.length,...(end < rows.length && {nextOffset:end})}
  }
  read(id: string, body: Record<string,unknown>) {
    this.current()
    return this.present(this.store.readResult(id, mutationKey(['v2','notices',id,'read'],body)))
  }
  detail(id: string) {
    this.current()
    const record = this.store.resultNotice(id)
    this.store.delegation(record.workspaceId, record.orderId)
    return {notice:this.present(record),text:record.text}
  }
  attachment(id: string, fileId: string) {
    this.current()
    const notice = this.store.resultNotice(id)
    const order = this.store.delegation(notice.workspaceId, notice.orderId)
    const session = this.store.session(order.workspaceId, order.sessionId)
    const ref = notice.attachments.find(file => file.id === fileId)
    if (ref && notice.sessionId === session.id && /^g-\d+$/.test(notice.messageId ?? '') && this.groups) {
      const file = this.groups.attachment(notice, fileId)
      if (!file || fileVersion(file) !== ref.version) return workspaceError(404,'原报告的这版附件暂不可读，可查看提交时的原话')
      return file
    }
    if (!ref || !notice.requestId || notice.sessionId !== session.id) return workspaceError(404,'这条提醒没有这份附件')
    const snapshot = this.source.savedResults?.(session, notice.requestId)
    const message = snapshot?.messages.find(row => row.id === notice.messageId && messageWorkOrder(session,row) === order.id)
    const file = message?.attachments?.some(row => row.id === fileId) && snapshot?.attachments.find(row => row.id === fileId)
    if (!file || fileVersion(file) !== ref.version) return workspaceError(404,'原报告的这版附件暂不可读，可查看提交时的原话')
    return file
  }
}
