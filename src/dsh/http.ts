/**
 * 作战台 HTTP 接口：/chief/api/*
 *
 * 同一套路由挂在两处（见 src/index.ts）：
 *   - DSH 网页服务下：先过 DSH 连接服务的 `requestRejection`（Host/Origin 围栏 + 已登录 Peer），与 DSH Web 同一套登录；
 *   - 手机访问端口（src/dsh/mobile-server.ts）：先过它自己的密码会话。经这里的请求拿不到设置类接口（PUBLIC_DENY）。
 * 写操作另外要求自定义请求头 `x-chief-request: 1`——跨站页面无法在不触发预检的情况下携带它，我们也不响应预检。
 * 这里是主人的操作入口，所以可以修改判断性字段（关系温度、影响力、横向线健康度等）。
 */
import type { RequestRoomExecution } from './rooms.ts'
import type { Connectors } from './connectors.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { OwnerTarget } from '../core/engine.ts'
import type { Worklines } from './worklines.ts'
import type { LiaisonChat } from './chat.ts'
import type { ChatAttachments } from './chat-attachments.ts'
import type { ChatInputAttachment } from '../core/chat-attachments.ts'
import type { LiaisonSeen } from './liaison-seen.ts'
import { deliveryDocument, discussionView, documentView, type Discussions } from './discussions.ts'
import type { CustomStore } from './custom-store.ts'
import type { Exporter } from './tools.ts'
import { EXPORT_TARGETS, type ExportTarget } from '../core/export.ts'
import { readBrainFile, ticketDetail, ticketThread, type StateDeps } from './view.ts'
import type { commandApprovals } from './approvals.ts'
import type { SuperhubIntake } from './superhub.ts'
import type { Llm } from './ports.ts'
import { canonicalSelection, modelCatalog } from './models.ts'

export const API_PREFIX = '/chief/api'
const MAX_BODY = 256 * 1024

export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  if (!size) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('请求体应为 JSON 对象'), { status: 400 })
  return value as Record<string, unknown>
}

const text = (v: unknown, max = 8000) => typeof v === 'string' ? v.trim().slice(0, max) : ''
const opt = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined
const list = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined

/** 请求从哪里来：DSH 自己的网页服务，或者手机访问端口。 */
export type Via = 'dsh' | 'public'
export interface ApiCall { method: string; path: string; seg: string[]; url: URL; via: Via; body: Record<string, unknown>; owner?: boolean; request?: IncomingMessage }
/** 一组路由：处理了返回 true，不认识返回 false。 */
export type Route = (call: ApiCall, res: ServerResponse) => Promise<boolean>

/** 手机访问端口拿不到的接口：选数据目录、改配置（包括手机访问自己的密码）。 */
const PUBLIC_DENY = [/^\/setup(\/|$)/, /^\/settings(\/|$)/, /^\/tickets\/T-\d+\/execution-plan$/]

/** 认证之后的统一入口：解析路径和请求体，依次交给路由。 */
export async function serveApi(req: IncomingMessage, res: ServerResponse, via: Via, routes: readonly Route[], owner = via === 'public'): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local')
  const path = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
  try {
    if (via === 'public' && PUBLIC_DENY.some(r => r.test(decodeURIComponent(path)))) return json(res, 403, { error: '这个操作只能在电脑上的 DSH 里做' })
    const seg = path.split('/').filter(Boolean).map(s => decodeURIComponent(s))
    const method = req.method ?? 'GET'
    let body: Record<string, unknown> = {}
    if (method === 'POST') {
      if (req.headers['x-chief-request'] !== '1') return json(res, 403, { error: '缺少请求标记' })
      if (path !== '/input-attachments') body = await readBody(req)
    } else if (method !== 'GET') return json(res, 405, { error: '只支持 GET / POST' })
    const call: ApiCall = { method, path, seg, url, via, body, owner, request: req }
    for (const route of routes) if (await route(call, res)) return
    json(res, 404, { error: '未知接口' })
  } catch (error) {
    if (res.headersSent) return
    json(res, (error as { status?: number }).status ?? 400, { error: (error as Error).message })
  }
}

/** 第二大脑就绪之后的全部接口（状态由外层的控制路由给出，见 src/index.ts）。 */
export function runtimeRoutes(deps: StateDeps & { requestRoomExecution?: RequestRoomExecution; connectors?: Connectors; approvals?: ReturnType<typeof commandApprovals>; chat: LiaisonChat; liaisonSeen?: LiaisonSeen; discussions?: Discussions; worklines?: Worklines; custom: CustomStore; exporter: Exporter; superhub?: SuperhubIntake; inputAttachments?: ChatAttachments; llm?: () => Llm | undefined }): Route {
  const { engine, brain, roster } = deps
  const inbox = (t: string, meta: Record<string, string>) => engine.receive({ source: 'inbox', dedupe: `inbox:${randomUUID()}`, text: t, meta })
  const ok = (res: ServerResponse, extra: object = {}) => json(res, 200, { ok: true, ...extra })

  /** 主人对花名册的写操作。返回 true 表示已处理。 */
  async function poc(seg: string[], body: Record<string, unknown>, res: ServerResponse): Promise<boolean> {
    const [kind, id, verb] = seg
    if (kind === 'people' && !id) {
      const pid = roster.recordPersonFacts(body.name, { ...opt(body.role) !== undefined ? { role: opt(body.role)! } : {}, ...opt(body.team) !== undefined ? { team: opt(body.team)! } : {}, ...opt(body.organization) !== undefined ? { organization: opt(body.organization)! } : {}, ...opt(body.reportsTo) !== undefined ? { reportsTo: opt(body.reportsTo)! } : {}, ...list(body.groups) ? { groups: list(body.groups)! } : {} })
      roster.setPersonJudgement(pid, {
        ...opt(body.influence) !== undefined ? { influence: body.influence as never } : {}, ...opt(body.warmth) !== undefined ? { warmth: body.warmth as never } : {},
        ...opt(body.stance) !== undefined ? { stance: opt(body.stance)! } : {}, ...opt(body.profile) !== undefined ? { profile: opt(body.profile)! } : {},
      })
      return ok(res, { id: pid }), true
    }
    if (kind === 'people' && id && verb === 'log') { roster.logInteraction(id, { text: text(body.text), ...opt(body.date) ? { date: opt(body.date)! } : {}, ...opt(body.channel) ? { channel: opt(body.channel)! } : {} }); return ok(res), true }
    if (kind === 'people' && id && verb === 'prep') {
      if (!roster.person(id)) throw new Error(`没有这个人物：${id}`)
      await inbox(`准备与「${id}」的下一次 1:1。读 people/${id}.md、相关横向线和未结承诺（用 chief_lookup），写一份准备材料：对方现在关心什么、上次聊到哪、我欠对方和对方欠我的、这次我想拿到什么、建议的开场和三个问题。`, { channel: 'warroom', person: id })
      return ok(res), true
    }
    if (kind === 'lines' && !id) {
      const lid = roster.upsertLine(body.name, {
        ...opt(body.goal) !== undefined ? { goal: opt(body.goal)! } : {}, ...list(body.partners) ? { partners: list(body.partners)! } : {},
        ...opt(body.health) !== undefined ? { health: body.health as never } : {}, ...opt(body.background) !== undefined ? { background: opt(body.background)! } : {},
        ...opt(body.blocker) !== undefined ? { blocker: opt(body.blocker)! } : {}, ...opt(body.nextSync) !== undefined ? { nextSync: opt(body.nextSync)! } : {},
      })
      return ok(res, { id: lid }), true
    }
    if (kind === 'lines' && id && verb === 'log') { roster.logLine(id, { text: text(body.text, 800) }); return ok(res), true }
    if (kind === 'ledger' && !id) { return ok(res, { commitment: roster.addCommitment(body) }), true }
    if (kind === 'ledger' && id && !verb) { roster.updateCommitment(id, body); return ok(res), true }
    if (kind === 'ledger' && id && verb === 'nudge') {
      const c = roster.ledger().find(x => x.id === id)
      if (!c) throw new Error(`没有这条承诺：${id}`)
      await inbox(`起草一条催办消息（只起草，不发送）。${c.who} 答应我「${c.what}」${c.due ? `，约定 ${c.due}` : ''}，还没有给到。读 people/${c.who}.md 了解对方，写两个版本：一个轻提醒，一个明确要时间点。`, { channel: 'warroom', commitment: id })
      return ok(res), true
    }
    if (kind === 'meetings' && !id) { return ok(res, { meeting: roster.addMeeting(body) }), true }
    if (kind === 'meetings' && id && verb === 'notes') {
      const meeting = roster.setMeetingNotes(id, text(body.text, 20_000))
      await inbox(`会议纪要需要拆解。会议「${meeting.title}」（${meeting.at}${meeting.with.length ? `，参与者：${meeting.with.join('、')}` : ''}${meeting.line ? `，横向线：${meeting.line}` : ''}）。\n纪要原文：\n${meeting.notes}\n\n请交给书记官：用 chief_record 记下每位参与者的互动摘要、所有承诺（谁欠谁、什么、何时）、横向线进展；对人或横向线的判断性更新写成提案。`, { channel: 'warroom', meeting: id, purpose: 'notes' })
      return ok(res), true
    }
    return false
  }

  return async (call, res) => {
    const { method, path, seg, url, body, owner } = call
    if (deps.superhub && await deps.superhub.route(call, res)) return true
    if (path === '/models' && method === 'GET') {
      // 模型目录只给主人：设置页和幕僚卡的下拉框用它
      if (!owner) return json(res, 403, { error: '需要主人身份才能读取模型目录' }), true
      return json(res, 200, await modelCatalog(deps.llm?.())), true
    }
    const exporting = path === '/export'
    if (exporting && owner !== true) return json(res, 403, { error: '需要主人身份才能导出资料' }), true
    const chatPath = path === '/chat' || path === '/chat/unread' || path === '/chat/seen'
    if (deps.superhub && !owner && (chatPath || (seg[0] === 'rooms' && method === 'POST'))) {
      return json(res, 403, { error: '需要主人身份才能访问接口人对话或向讨论发送操作' }), true
    }
    if (deps.superhub) {
      const id = seg[0] === 'tickets' ? seg[1] : undefined
      const file = url.searchParams.get('path') ?? ''
      const queryScope = url.searchParams.get('scope')
      if (queryScope !== null && (id || exporting || chatPath || path === '/file' || seg[0] === 'discussions')) {
        if (!owner) return json(res, 403, { error: '需要主人身份才能打开这份资料' }), true
        deps.superhub.checkScope(queryScope)
      }
      const find = (ticketId?: string) => ticketId && /^T-\d+$/.test(ticketId) ? engine.ticketView(ticketId)?.ticket.superhub : undefined
      const discussion = seg[0] === 'discussions' && deps.discussions
        ? seg[1] ? deps.discussions.get(seg[1])?.document.ticketId : method === 'GET' ? url.searchParams.get('ticket') ?? undefined : opt(body.ticketId)
        : undefined
      let authorization = find(id ?? discussion)
      const retired = (ticketId?: string) => !!ticketId && engine.isRetiredTicket(ticketId)
      const retiredTarget = retired(id ?? discussion)
      let internal = retiredTarget
      if (path === '/file' && file) {
        try {
          // Resolve aliases before applying the same policy as a direct file read.
          const parts = relative(realpathSync(brain.root), realpathSync(join(brain.root, file))).split(sep)
          internal = parts[0] === 'ops' || parts[0] === 'work' && retired(parts[1])
          if (parts[0] === 'work') authorization = find(parts[1])
        } catch { /* The file reader will return the missing or unreadable file response. */ }
      }
      if (authorization) deps.superhub.checkScope(authorization.brainScope)
      if (!owner && (authorization || internal)) return json(res, 403, { error: '需要主人身份才能访问工单、证据或内部记录' }), true
      if (id && retiredTarget) return json(res, 404, { error: '工单已不可用' }), true
    }
    if (seg[0] === 'rooms' && deps.rooms) {
      if (method === 'POST' && seg[1] === 'from-ticket') {
        const ticket = engine.views().find(v => v.ticket.id === text(body.ticket, 40))?.ticket
        if (!ticket) throw new Error('没有这张工单')
        const existing = deps.rooms.list().find(r => r.tickets.includes(ticket.id))
        const room = existing ? deps.rooms.meta(existing.id) : await deps.rooms.create(`ticket-${ticket.id}`, ticket.title)
        deps.rooms.link(room.id, ticket.id)
        return json(res, 200, room), true
      }
      if (method === 'GET') {
        const raw = url.searchParams.get('after')
        let after: import('./rooms.ts').RoomCursor | undefined
        if (raw !== null) {
          if (raw.length > 8000) throw new Error('原话游标无效')
          const value = JSON.parse(raw) as import('./rooms.ts').RoomCursor
          if (!value || typeof value.session !== 'string' || !value.positions || Array.isArray(value.positions) || typeof value.positions !== 'object' || Object.keys(value.positions).length > 64 || Object.entries(value.positions).some(([id, seq]) => !/^[a-zA-Z0-9_-]{1,160}$/.test(id) || !Number.isSafeInteger(seq) || seq < 0)) throw new Error('原话游标无效')
          after = value
        }
        return json(res, 200, seg[1] ? await deps.rooms.view(seg[1], after) : deps.rooms.list()), true
      }
      if (!seg[1]) return json(res, 200, await deps.rooms.create(text(body.request_id, 120), text(body.title, 200))), true
      if (body.session !== deps.rooms.meta(seg[1]).session) return json(res, 409, { error: '讨论所属的第二大脑已改变，请重新打开讨论并确认草稿' }), true
      if (seg[2] === 'submit-work' && deps.requestRoomExecution) {
        // 网页「提交执行审批」是主人明确要求的执行：按写入建单，等主人批准。
        const result = await deps.requestRoomExecution(seg[1], { source: text(body.source, 240), title: text(body.title, 200), staff: text(body.staff, 60),
          scope: opt(body.scope), doneWhen: list(body.doneWhen), operation: 'write' })
        return json(res, 200, result), true
      }
      if (seg[2] === 'answer-action') {
        const answer = text(body.text)
        if (!answer) throw Error('请填写回答')
        await deps.rooms.answerOwner(seg[1], text(body.id, 80), answer)
        return ok(res), true
      }
      if (seg[2] === 'stop') await deps.rooms.stop(seg[1])
      else if (seg[2] === 'restore-note') await deps.rooms.restoreNote(seg[1], text(body.id, 120), Number(body.version), Number(body.target_version))
      else if (seg[2] === 'link') { const ticket = text(body.ticket, 40); if (!engine.views().some(v => v.ticket.id === ticket)) throw new Error('没有这张工单'); deps.rooms.link(seg[1], ticket) }
      else if (seg[2] === 'notes') await deps.rooms.note(seg[1], { by: 'you', id: text(body.id, 120) || randomUUID(), source: text(body.source, 240), text: text(body.text, 4000), reason: text(body.reason, 1000) || undefined, category: body.category as never, version: typeof body.version === 'number' ? body.version : undefined })
      else await deps.rooms.say(seg[1], text(body.request_id, 120), typeof body.text === 'string' ? body.text : '', text(body.to, 100) || 'lead', text(body.reply_to, 240) || undefined)
      return json(res, 200, await deps.rooms.view(seg[1])), true
    }
    if (path === '/settings/approvals' && deps.approvals) {
      // Coding-session commands of SuperHub 2.0 are decided on their work order; this list stays native-only.
      const native = deps.approvals.list().filter(row => !row.workspace)
      if (method === 'GET') return json(res, 200, native), true
      if (typeof body.id !== 'string' || typeof body.allow !== 'boolean') return json(res, 400, { error: '请选择允许或拒绝这次命令' }), true
      if (!native.some(row => row.id === body.id) || !deps.approvals.decide(body.id, body.allow)) return json(res, 409, { error: '这条申请已处理或过期' }), true
      return ok(res), true
    }
    if (seg[0] === 'settings' && seg[1] === 'connectors' && deps.connectors) {
      if (method === 'GET') return json(res, 200, deps.connectors.view()), true
      if (seg[2] === 'configure') deps.connectors.configure(text(body.service, 30), typeof body.token === 'string' ? body.token : '')
      else if (seg[2] === 'decide') {
        const request = deps.connectors.decide(text(body.id, 120), body.allow === true)
        if (!request.notified) {
          if (!deps.rooms) throw new Error('原生讨论暂不可用，请重试原申请')
          await deps.rooms.say(request.room, `access-${request.id}`, `仓库申请 ${request.id} ${request.state === 'allowed' ? '已允许本次读取' : '已拒绝，请说明依据缺口'}`, request.staff)
          deps.connectors.notified(request.id)
        }
      }
      else if (seg[2] === 'revoke') deps.connectors.revoke(text(body.id, 120))
      else if (seg[2] === 'draft') deps.connectors.draft(text(body.chat, 120), text(body.text, 10000))
      else if (seg[2] === 'edit-draft') deps.connectors.edit(text(body.id, 120), text(body.version, 100), text(body.chat, 120), text(body.text, 10000))
      else if (seg[2] === 'approve') deps.connectors.approve(text(body.id, 120), text(body.version, 100))
      else if (seg[2] === 'reconcile') deps.connectors.reconcile(text(body.id, 120), text(body.version, 100), text(body.receipt, 200))
      else if (seg[2] === 'send') await deps.connectors.send(text(body.id, 120), text(body.version, 100))
      else throw new Error('未知连接器操作')
      return json(res, 200, deps.connectors.view()), true
    }
    if (method === 'GET') {
      if (seg[0] === 'tickets' && seg[1] && seg[2] === 'thread' && seg.length === 3) {
        const thread = ticketThread(engine, brain, seg[1])
        return thread ? json(res, 200, thread) : json(res, 404, { error: '没有这张工单' }), true
      }
      if (seg[0] === 'lines' && seg[1] && seg[2] === 'work' && deps.worklines) return json(res, 200, deps.worklines.view(seg[1])), true
      if (path === '/discussions' && deps.discussions) return json(res, 200, deps.discussions.list(url.searchParams.get('ticket') ?? '', url.searchParams.get('path') ?? '').map(discussionView)), true
      if (seg[0] === 'discussions' && seg[1] && deps.discussions) { const row = deps.discussions.get(seg[1]); return row ? json(res, 200, discussionView(row)) : json(res, 404, { error: '没有这条讨论' }), true }
      if (seg[0] === 'tickets' && seg[1] && seg[2] === 'file') {
        const path = url.searchParams.get('path') ?? '', version = url.searchParams.get('version') || undefined
        if (version) return json(res, 200, { content: deliveryDocument(engine, brain, seg[1], path, version).content }), true
        const detail = ticketDetail(engine, brain, seg[1])
        if (!detail?.files.some(f => f.path === path)) throw new Error('文件不属于这张工单')
        const content = readBrainFile(brain, path)
        return content === undefined ? json(res, 404, { error: '文件不可读' }) : json(res, 200, { content }), true
      }
      if (seg[0] === 'tickets' && seg[1] && seg[2] === 'document') return json(res, 200, documentView(deliveryDocument(engine, brain, seg[1], url.searchParams.get('path') ?? '', url.searchParams.get('version') || undefined))), true
      if (path === '/chat') return json(res, 200, await deps.chat.view()), true
      // 「一句话交办」的红点：上次看过之后接口人的新消息数（网页与手机共用服务端的已读点）
      if (path === '/chat/unread' && deps.liaisonSeen) {
        deps.superhub?.checkScope(url.searchParams.get('scope'))
        return json(res, 200, { ...deps.superhub && { scope: deps.superhub.scope }, ...await deps.chat.unread(deps.liaisonSeen.get()) }), true
      }
      if (seg[0] === 'tickets' && seg[1] && seg.length === 2) {
        const detail = ticketDetail(engine, brain, seg[1])
        if (detail && url.searchParams.has('scope')) {
          const authors = new Set([detail.ticket.staff, ...detail.ticket.assignments.map(a => a.staff)])
          const staffNames = Object.fromEntries(brain.staff().filter(staff => authors.has(staff.id)).map(staff => [staff.id,staff.name]))
          return json(res, 200, { ...detail, staffNames }), true
        }
        return detail ? json(res, 200, detail) : json(res, 404, { error: '没有这张工单' }), true
      }
      if (seg[0] === 'people' && seg[1] && seg.length === 2) {
        const person = roster.person(seg[1])
        return person ? json(res, 200, person) : json(res, 404, { error: '没有这个人物' }), true
      }
      if (seg[0] === 'lines' && seg[1] && seg.length === 2) {
        const line = roster.line(seg[1])
        return line ? json(res, 200, line) : json(res, 404, { error: '没有这条横向线' }), true
      }
      if (path === '/export') {
        const target = url.searchParams.get('for') ?? 'chatgpt'
        if (!(EXPORT_TARGETS as readonly string[]).includes(target)) return json(res, 400, { error: `不认识的目标：${target}` }), true
        return json(res, 200, deps.exporter.build(target as ExportTarget)), true
      }
      if (path === '/file') {
        const content = readBrainFile(brain, url.searchParams.get('path') ?? '')
        return content === undefined ? json(res, 404, { error: '文件不存在或不可读' }) : json(res, 200, { content }), true
      }
      return false
    }
    // 以下都是 POST（serveApi 已校验请求标记、读好请求体）
    const done = (status = 200, value: object = { ok: true }) => { json(res, status, value); return true }
    if (seg[0] === 'tickets' && seg[1] && seg[2] === 'thread' && seg.length === 3) {
      if (typeof body.thread_id !== 'string' || !body.thread_id || typeof body.ticket_id !== 'string' || !body.ticket_id
        || (body.reply_to !== null && (typeof body.reply_to !== 'string' || !body.reply_to))
        || typeof body.request_id !== 'string' || !body.request_id
        || (body.execution_boundary !== 'local' && body.execution_boundary !== 'remote')) return done(400, { error: '缺少工单讨论、派工目标、执行位置或请求标识，请刷新后重试' })
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000) return done(400, { error: '执行回复需为 1 到 8000 字' })
      const brainScope = opt(body.brainScope ?? body.scope)
      const version = body.contractVersion ?? body.contract_version
      await engine.reply(seg[1], body.text, { threadId: body.thread_id, ticketId: body.ticket_id, replyTo: body.reply_to, requestId: body.request_id, executionBoundary: body.execution_boundary, allowRemote: body.allow_remote === true,
        brainScope, contractVersion: typeof version === 'number' ? version : undefined })
      return done(200, { ok: true, ...ticketThread(engine, brain, seg[1]) })
    }
    if (seg[0] === 'lines' && seg[1] && deps.worklines) {
      const id = seg[1]
      if (seg[2] === 'link') { deps.worklines.link(id, text(body.ticketId, 40), text(body.path, 500) || undefined); return done() }
      if (seg[2] === 'decision') { deps.worklines.confirm(id, text(body.text, 4000)); return done() }
      if (seg[2] === 'commission') {
        if (!roster.line(id)) throw new Error('没有这条横向线')
        const task = text(body.text)
        if (!task) throw new Error('交办内容不能为空')
        const staff = text(body.staff, 40)
        if (brain.staff().find(s => s.id === staff)?.executor === 'remote') throw new Error('请选择本地负责人，工作端只通过单独的任务说明参与')
        const ticketId = await engine.commission({ text: task, title: text(body.title, 100) || `${id}：${task.slice(0, 24)}`, staff, level: 'think', scope: task, doneWhen: list(body.doneWhen)?.filter(Boolean) ?? ['交付可核验结论与证据，指出限制和下一步'], needsReview: true, lineId: id, remoteBrief: text(body.remoteBrief, 6000) || undefined, requestKey: `line:${id}:${text(body.requestId, 40) || randomUUID()}` })
        return done(200, { ticketId })
      }
    }
    if (path === '/discussions' && deps.discussions) return done(200, discussionView(deps.discussions.create({ ticketId: text(body.ticketId, 40), path: text(body.path, 500), version: text(body.version, 64), quote: typeof body.quote === 'string' ? body.quote : '', requestId: text(body.requestId, 40), text: text(body.text), remote: body.mode === 'remote' })))
    if (seg[0] === 'discussions' && seg[1] && deps.discussions) {
      if (seg[2] === 'remote') return done(200, discussionView(deps.discussions.askRemote(seg[1], text(body.requestId, 40), text(body.text, 6000))))
      if (seg[2] === 'followup') return done(200, { ticketId: await deps.discussions.followUp(seg[1], text(body.text)) })
      return done(200, discussionView(deps.discussions.say(seg[1], text(body.requestId, 40), text(body.text))))
    }
    if (path === '/chat/seen' && deps.liaisonSeen) {
      deps.superhub?.checkScope(url.searchParams.get('scope'))
      const seenAt = deps.liaisonSeen.mark(body.at)
      return done(200, { ...deps.superhub && { scope: deps.superhub.scope }, seenAt: new Date(seenAt).toISOString() })
    }
    if (path === '/chat') {
      const t = text(body.text, 40_000) // 主人可能贴进一大段别的助手的回答
      const mode = body.mode === 'queue' || body.mode === 'steer' ? body.mode : 'auto'
      const sessionId = text(body.sessionId, 100) || undefined
      let inputAttachments: ChatInputAttachment[] | undefined
      if (body.inputAttachments !== undefined) {
        if (!owner) return done(403, { error: '需要主人身份才能发送聊天附件' })
        if (!deps.superhub || !deps.inputAttachments) return done(503, { error: '当前宿主无法发送聊天附件' })
        deps.superhub.checkScope(body.scope)
        if (!sessionId || sessionId !== body.sessionId) return done(409, { error: '请刷新接口人对话后重新发送附件' })
        deps.chat.assertSession(sessionId)
        inputAttachments = deps.inputAttachments.resolve({ sessionId }, body.inputAttachments)
      }
      if (!t && !inputAttachments?.length) return done(400, { error: '内容不能为空' })
      if (deps.superhub && (body.scope !== undefined || body.request_id !== undefined || body.requestId !== undefined)) {
        deps.chat.assertSession(sessionId)
        const requestId = body.request_id ?? body.requestId
        // 每一句原话都交给接口人理解，系统不预先分类；原话回执记下原话，接口人登记的工作随后挂在它下面。
        const receipt = await deps.superhub.submit({ ...body, requestId }, { channel: 'chat', sessionId, chatMode: mode, inputAttachments })
        if (receipt.items.every(item => item.state === 'conversation')) {
          await deps.superhub.deliver(receipt.id, receipt.items[0]!.id, receipt.source.text, receipt.source.requestId,
            (said, id, refs) => deps.chat.say(said, mode, sessionId, id, refs))
        }
        return done(200, { ok: true, receipt: deps.superhub.view(receipt.id) })
      }
      await deps.chat.say(t, mode, sessionId)
      return done()
    }
    if (path === '/inbox') {
      const t = text(body.text)
      if (!t) return done(400, { error: '内容不能为空' })
      await inbox(t, { channel: 'warroom' })
      return done()
    }
    if (seg[0] === 'events' && seg[1] && (seg[2] === 'retriage' || seg[2] === 'evaluate')) { await engine.retriage(seg[1]); return done() }
    if (seg[0] === 'sources' && seg[1] && seg.length === 2) { brain.setSourceMode(seg[1], body.mode as never); return done() }
    if (seg[0] === 'staff' && seg.length === 1) {
      const id = text(body.id, 40)
      const found = brain.staff().find(s => s.id === id)
      // 和接口人的模型一样经 DSH 目录校验；没改动的旧值原样保留，空值表示用默认。档位必须是所选模型支持的
      const { model, effort } = await canonicalSelection(deps.llm?.(), { model: text(body.model, 200), ...typeof body.reasoningEffort === 'string' ? { effort: text(body.reasoningEffort, 80) } : {} }, { model: found?.model, effort: found?.reasoningEffort })
      brain.saveStaff({ id, name: text(body.name, 40), executor: text(body.executor, 20), verifier: text(body.verifier, 40), brief: text(body.brief, 6000), ...model ? { model } : {}, ...effort ? { reasoningEffort: effort } : {} })
      return done()
    }
    if (seg[0] === 'staff' && seg[1] && seg[2] === 'assign') {
      const member = brain.staff().find(s => s.id === seg[1])
      if (!member) return done(404, { error: '没有这位幕僚' })
      const t = text(body.text)
      if (!t) return done(400, { error: '内容不能为空' })
      await inbox(`主人点名交给${member.name}（${member.id}）：${t}`, { channel: 'warroom', staff: member.id })
      return done()
    }
    if (path === '/pause') { engine.setPaused(body.paused === true); return done() }
    // 界面定制（和接口人的 chief_ui 是同一份数据）
    if (path === '/custom') {
      const { custom, dropped } = deps.custom.update({
        ...body.theme && typeof body.theme === 'object' ? { theme: body.theme as Record<string, unknown> } : {},
        ...body.layout && typeof body.layout === 'object' ? { layout: body.layout as Record<string, unknown> } : {},
        ...Array.isArray(body.panels) ? { panels: body.panels as unknown[] } : {},
        ...Array.isArray(body.removePanels) ? { removePanels: (body.removePanels as unknown[]).filter((x): x is string => typeof x === 'string') } : {},
      })
      return done(200, { ok: true, custom, dropped })
    }
    if (path === '/custom/undo') return done(200, { ok: true, custom: deps.custom.undo() ?? deps.custom.get() })
    if (path === '/custom/reset') return done(200, { ok: true, custom: deps.custom.reset() })
    if (seg[0] === 'tickets' && /^T-\d+$/.test(seg[1] ?? '') && seg.length === 3) {
      const id = seg[1]!, verb = seg[2]
      let target: OwnerTarget | undefined
      if (body.thread_id !== undefined) {
        if (typeof body.thread_id !== 'string' || !body.thread_id
          || (body.reply_to !== null && (typeof body.reply_to !== 'string' || !body.reply_to))
          || (body.stage !== undefined && typeof body.stage !== 'string')) return done(400, { error: '缺少完整的工单讨论与派工目标，请刷新后重试' })
        const version = body.contractVersion ?? body.contract_version
        target = { threadId: body.thread_id, replyTo: body.reply_to, ...typeof body.stage === 'string' ? { stage: body.stage } : {},
          brainScope: opt(body.brainScope ?? body.scope), contractVersion: typeof version === 'number' ? version : undefined, deviationReason: opt(body.deviationReason) }
      }
      if (verb === 'approve') await engine.approve(id, target)
      else if (verb === 'remote-brief') await engine.setRemoteBrief(id, text(body.text, 6000), target)
      else if (verb === 'reply') {
        await engine.reply(id, text(body.text), target)
      }
      else if (verb === 'accept') await engine.accept(id, body.applyProposal === true, target)
      else if (verb === 'stop') await engine.stopTicket(id, text(body.reason, 500), target)
      else if (verb === 'retry') await engine.retry(id, target)
      else if (verb === 'execution-plan') {
        if (!target?.replyTo || target.stage !== 'you/blocked' || !Array.isArray(body.groups)) return done(400, { error: '请确认当前受阻派工、已有进度和待执行分组' })
        const groups = body.groups.map((group: unknown) => {
          const fields = group && typeof group === 'object' ? group as Record<string, unknown> : {}
          return { key: opt(fields.key) ?? '', title: opt(fields.title)?.trim() ?? '', scope: opt(fields.scope)?.trim() ?? '' }
        })
        await engine.planExecution(id, groups, opt(body.checkpoint)?.trim() ?? '', target)
      }
      else if (verb === 'apply') await engine.applyProposal(id, target)
      else return done(404, { error: '未知操作' })
      return done()
    }
    return poc(seg, body, res)
  }
}
