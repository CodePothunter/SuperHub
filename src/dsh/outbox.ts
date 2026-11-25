/**
 * 发件箱：把"需要主人知道的事"主动送到他面前。
 *
 * 原则是先安静：待主人决定、工作结果、每天一条的早间态势和系统问题进入发件箱。
 * 每条消息有一个 key，同一件事只说一次；发过的记录同时是"已经告诉过主人什么"的记忆。
 *
 * 两个渠道：作战台里接口人对话中的提醒（总是有）；可选的推送（配置了 CHIEF_NOTIFY_URL 才有，
 * 安静时段不推，攒到早上一起发；多条合并成一条）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Notice {
  key: string
  at: string
  text: string
  ticketId?: string
  kind?: 'result'
  assignmentId?: string
  delivery?: { path: string; version: string; title: string }
  /** SuperHub 2.0 工单：提醒里的「打开工单」直接定位到这张单。 */
  order?: NoticeOrder
  /** 定时安排到点的提醒：来自哪条安排（「停用」「在设置中查看」按它操作）。 */
  schedule?: NoticeSchedule
  /** 推送状态：pending 等待推送；pushed 已推；local 没有配置推送，只在作战台显示；failed 多次推送失败。 */
  push: 'pending' | 'pushed' | 'local' | 'failed'
  attempts: number
}

export interface NoticeOrder { workspaceId: string; orderId: string }
export interface NoticeSchedule { id: string; title: string; when: string }

const KEEP = 400
const MAX_ATTEMPTS = 5

export class Outbox {
  private notices: Notice[] = []
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) try { const v = JSON.parse(readFileSync(file, 'utf8')) as unknown; if (Array.isArray(v)) this.notices = v as Notice[] } catch { /* 损坏时从空开始 */ }
  }

  private save(): void {
    this.notices = this.notices.slice(-KEEP)
    writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.notices, null, 1)}\n`)
    renameSync(`${this.file}.tmp`, this.file)
  }

  has(key: string): boolean { return this.notices.some(n => n.key === key) }

  /** 放进发件箱；同一个 key 说过就不再说。正文默认最长 600 字，定时安排的汇总可放宽（maxLength）。 */
  enqueue(key: string, text: string, now: Date, ticketId?: string,
    options: Pick<Notice, 'kind' | 'assignmentId' | 'delivery' | 'order' | 'schedule'> & { localOnly?: boolean; maxLength?: number } = {}): boolean {
    if (this.has(key)) return false
    const { localOnly, maxLength = 600, ...details } = options
    this.notices.push({ key, at: now.toISOString(), text: text.trim().slice(0, maxLength), push: localOnly ? 'local' : 'pending', attempts: 0, ...ticketId ? { ticketId } : {}, ...details })
    this.save()
    return true
  }

  recent(limit: number): Notice[] { return this.notices.slice(-limit) }

  /**
   * 推送待发的消息。没有配置推送：直接标为 local。安静时段：留着不动。
   * 多条合并成一条发出；失败会在后面的轮次重试，超过次数标为 failed 并返回错误说明。
   */
  async dispatch(send: ((text: string) => Promise<void>) | undefined, quiet: boolean): Promise<string | undefined> {
    const pending = this.notices.filter(n => n.push === 'pending')
    if (!pending.length) return undefined
    if (!send) { for (const n of pending) n.push = 'local'; this.save(); return undefined }
    if (quiet) return undefined
    const lines = pending.slice(0, 6).map(n => `· ${n.text}`)
    const text = `接口人提醒\n${lines.join('\n')}${pending.length > 6 ? `\n· 还有 ${pending.length - 6} 条，打开作战台查看` : ''}`
    try {
      await send(text)
      for (const n of pending) n.push = 'pushed'
      this.save()
      return undefined
    } catch (error) {
      let gaveUp = false
      for (const n of pending) { n.attempts += 1; if (n.attempts >= MAX_ATTEMPTS) { n.push = 'failed'; gaveUp = true } }
      this.save()
      return gaveUp ? `推送失败 ${MAX_ATTEMPTS} 次，已放弃这批提醒（作战台里仍能看到）：${(error as Error).message}` : undefined
    }
  }
}

/**
 * 按地址类型发送：飞书自定义机器人、ntfy（纯文本），其余按通用 JSON `{ text }` 发。
 * 地址来自环境变量 CHIEF_NOTIFY_URL（不进 git）；没配置时返回 undefined。
 */
export function makeNotifier(url: string | undefined): ((text: string) => Promise<void>) | undefined {
  if (!url) return undefined
  let target: URL
  try { target = new URL(url) } catch { return undefined }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return undefined
  const feishu = /(^|\.)feishu\.cn$|(^|\.)larksuite\.com$/.test(target.hostname)
  const ntfy = /(^|\.)ntfy\./.test(target.hostname) || target.hostname.startsWith('ntfy')
  return async text => {
    const init: RequestInit = ntfy
      ? { method: 'POST', body: text, headers: { 'content-type': 'text/plain; charset=utf-8', title: '=?UTF-8?B?' + Buffer.from('接口人').toString('base64') + '?=' } }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(feishu ? { msg_type: 'text', content: { text } } : { text }) }
    const response = await fetch(target, { ...init, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`推送地址返回 ${response.status}`)
  }
}
