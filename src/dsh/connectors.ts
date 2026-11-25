import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

export interface AccessRequest { id: string; room: string; staff: string; repository: string; path: string; ref: string; purpose: string; state: 'pending' | 'allowed' | 'denied' | 'used'; expires: number; notified?: boolean; revoked?: boolean }
export interface Draft { id: string; chat: string; text: string; version: string; state: 'draft' | 'approved' | 'sending' | 'sent' | 'unknown'; receipt?: string; revision?: number }
interface State { requests: AccessRequest[]; drafts: Draft[] }

/** Machine-private credential broker. Its tools expose fixed operations, never arbitrary URLs. */
export class Connectors {
  private readonly stateFile: string
  private readonly secretFile: string
  private state: State
  private secrets: { github?: string; feishu?: string } = {}
  private credentialRevision = 0
  constructor(home: string, private transport: typeof fetch = fetch) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    this.stateFile = join(home, 'connector-state.json'); this.secretFile = join(home, 'connector-secrets.json')
    this.state = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : { requests: [], drafts: [] }
    if (existsSync(this.secretFile)) this.secrets = JSON.parse(readFileSync(this.secretFile, 'utf8'))
    for (const draft of this.state.drafts) if (draft.state === 'sending') draft.state = 'unknown'
    // Older repository-wide approvals must never silently become file-scoped grants.
    for (const r of this.state.requests) if (!r.path || !r.ref) { r.state = 'denied'; r.revoked = true }
    this.save()
  }
  private write(file: string, value: unknown) { writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 }); renameSync(`${file}.tmp`, file) }
  private save() { this.write(this.stateFile, this.state) }
  view() { return { github: !!this.secrets.github, feishu: !!this.secrets.feishu, requests: structuredClone(this.state.requests), drafts: structuredClone(this.state.drafts) } }
  configure(service: string, token: string) {
    if (!['github', 'feishu'].includes(service) || token.length > 8000 || /[\r\n]/.test(token)) throw new Error('无效的连接器或凭据')
    this.credentialRevision++
    this.secrets[service as 'github' | 'feishu'] = token || undefined; this.write(this.secretFile, this.secrets)
    if (service === 'github') for (const r of this.state.requests) if (r.state === 'allowed') { r.state = 'denied'; r.revoked = true }
    if (service === 'feishu') for (const d of this.state.drafts) if (d.state === 'approved' || d.state === 'draft') { d.state = 'draft'; d.revision = (d.revision ?? 0) + 1; d.version = this.draftVersion(d) }
    this.save()
  }
  request(room: string, staff: string, repository: string, purpose: string, path: string, ref: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !purpose.trim() || purpose.length > 1000) throw new Error('需要有效仓库和用途')
    if (!path || path.length > 500 || path.startsWith('/') || path.split('/').some(s => !s || s === '..' || s === '.') || !/^[a-f0-9]{40}$/.test(ref)) throw new Error('需要文件路径及固定的 40 位提交版本')
    const old = this.state.requests.find(r => !r.revoked && r.room === room && r.staff === staff && r.repository === repository && r.path === path && r.ref === ref && r.purpose === purpose && ['pending', 'allowed'].includes(r.state) && r.expires > Date.now())
    if (old) return structuredClone(old)
    const request: AccessRequest = { id: randomUUID(), room, staff, repository, purpose, path, ref, state: 'pending', expires: Date.now() + 30 * 60000 }
    this.state.requests.push(request); this.save(); return structuredClone(request)
  }
  decide(id: string, allow: boolean) {
    const r = this.state.requests.find(r => r.id === id)
    if (!r || r.expires <= Date.now() || r.revoked) throw new Error('申请已处理或已过期')
    // A persisted decision may be retried only to finish its failed native notification.
    if (r.state !== 'pending') {
      if (!r.notified && r.state === (allow ? 'allowed' : 'denied')) return structuredClone(r)
      throw new Error('申请已处理或已过期')
    }
    r.state = allow ? 'allowed' : 'denied'; this.save(); return structuredClone(r)
  }
  notified(id: string) { const r = this.state.requests.find(r => r.id === id); if (r) { r.notified = true; this.save() } }
  revoke(id: string) { const r = this.state.requests.find(r => r.id === id); if (!r) throw new Error('没有这个申请'); r.revoked = true; this.save() }
  async read(id: string, room: string, staff: string, path: string, ref: string) {
    const r = this.state.requests.find(r => r.id === id)
    if (!r || r.room !== room || r.staff !== staff || r.state !== 'allowed' || r.revoked || r.expires <= Date.now() || !this.secrets.github) throw new Error('没有本次读取授权或连接已断开')
    if (path !== r.path || ref !== r.ref) throw new Error('文件路径或版本不在本次授权范围')
    const revision = this.credentialRevision
    const token = this.secrets.github
    r.state = 'used'; this.save()
    const response = await this.transport(`https://api.github.com/repos/${r.repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, { headers: { authorization: `Bearer ${this.secrets.github}`, accept: 'application/vnd.github.raw+json' }, redirect: 'error', signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`仓库读取失败（${response.status}），可重新申请`)
    const raw = await response.text()
    if (r.revoked || revision !== this.credentialRevision || token !== this.secrets.github || r.expires <= Date.now()) throw new Error('读取期间授权已失效，结果已丢弃')
    const content = Object.values(this.secrets).filter((s): s is string => !!s).reduce((value, secret) => value.split(secret).join('[已隐藏凭据]'), raw)
    if (content.length > 200000) throw new Error('文件过大，请选择较小文件')
    return { repository: r.repository, path, ref, content, receipt: response.headers.get('x-github-request-id') ?? undefined, etag: response.headers.get('etag') ?? undefined }
  }
  private draftVersion(d: Pick<Draft, 'chat' | 'text' | 'revision'>) { return createHash('sha256').update(JSON.stringify([d.chat, d.text, d.revision ?? 0])).digest('hex') }
  draft(chat: string, text: string) {
    if (!/^oc_[a-zA-Z0-9]+$/.test(chat) || !text.trim() || text.length > 10000) throw new Error('需要有效飞书会话和 1 到 10000 字正文')
    const draft: Draft = { id: randomUUID(), chat, text, revision: 0, version: this.draftVersion({ chat, text, revision: 0 }), state: 'draft' }
    this.state.drafts.push(draft); this.save(); return structuredClone(draft)
  }
  edit(id: string, version: string, chat: string, text: string) {
    const d = this.state.drafts.find(d => d.id === id)
    if (!d || d.version !== version || !['draft', 'approved'].includes(d.state)) throw new Error('草稿版本已改变或已经发送，不能修改')
    if (!/^oc_[a-zA-Z0-9]+$/.test(chat) || !text.trim() || text.length > 10000) throw new Error('需要有效飞书会话和 1 到 10000 字正文')
    d.chat = chat; d.text = text; d.revision = (d.revision ?? 0) + 1; d.version = this.draftVersion(d); d.state = 'draft'
    this.save(); return structuredClone(d)
  }
  approve(id: string, version: string) { const d = this.state.drafts.find(d => d.id === id); if (!d || d.state !== 'draft' || d.version !== version) throw new Error('草稿已处理或版本改变'); d.state = 'approved'; this.save() }
  reconcile(id: string, version: string, receipt: string) {
    const d = this.state.drafts.find(d => d.id === id)
    if (!d || d.version !== version || d.state !== 'unknown' || !/^[a-zA-Z0-9_-]{1,200}$/.test(receipt)) throw new Error('需要待核对操作的当前版本及接收端消息标识')
    d.state = 'sent'; d.receipt = receipt; this.save(); return structuredClone(d)
  }
  async send(id: string, version: string) {
    const d = this.state.drafts.find(d => d.id === id)
    if (!d || d.version !== version || !this.secrets.feishu) throw new Error('草稿或连接无效')
    if (d.state === 'sent' || d.state === 'unknown' || d.state === 'sending') return structuredClone(d)
    if (d.state !== 'approved') throw new Error('需要先批准这版草稿')
    d.state = 'sending'; this.save()
    try {
      const response = await this.transport('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', { method: 'POST', headers: { authorization: `Bearer ${this.secrets.feishu}`, 'content-type': 'application/json' }, body: JSON.stringify({ receive_id: d.chat, msg_type: 'text', content: JSON.stringify({ text: d.text }), uuid: d.id }), redirect: 'error', signal: AbortSignal.timeout(20000) })
      const result = await response.json() as { code?: number; data?: { message_id?: string } }
      if (!response.ok || result.code !== 0 || !result.data?.message_id) throw new Error('服务没有返回可核对的消息回执')
      d.state = 'sent'; d.receipt = result.data.message_id
    } catch { d.state = 'unknown' }
    this.save(); return structuredClone(d)
  }
}
