/**
 * 对话历史分页：接口人对话、群聊与工单对话共用一套游标。
 *
 * 游标就是消息自己的稳定 id（群聊 `g-<seq>`，日志消息 `id`，接口人 `firstSeq ?? seq`），不另造序号。
 * 完全不带分页参数的请求保持旧行为（由调用方决定全量或旧上限）。
 */

export const PAGE_DEFAULT = 40
export const PAGE_MAX = 100

export interface PageQuery {
  limit: number
  /** 严格早于这条消息的最近 limit 条。 */
  before?: string
  /** 严格晚于这条消息的最早 limit 条。 */
  after?: string
  /** 以这条消息为中心的 limit 条。 */
  around?: string
}

/** 返回的窗口之前 / 之后是否还有消息。 */
export interface PageInfo { older: boolean; newer: boolean }

const pageError = (status: number, message: string) => Object.assign(new Error(message), { status })

/** 从查询参数读分页；一个分页参数都没有时返回 undefined（旧客户端）。参数不合法抛 400。 */
export function pageQuery(params: URLSearchParams): PageQuery | undefined {
  const raw = params.get('limit'), before = params.get('before'), after = params.get('after'), around = params.get('around')
  if (raw === null && before === null && after === null && around === null) return undefined
  const limit = raw === null || raw === '' ? PAGE_DEFAULT : Number(raw)
  if (!Number.isSafeInteger(limit) || limit < 1) throw pageError(400, '分页条数应为 1 到 ' + PAGE_MAX + ' 的整数')
  const cursors = [before, after, around].filter(value => value !== null)
  if (cursors.length > 1) throw pageError(400, 'before、after、around 只能选一个')
  if (cursors.some(value => !value || value.length > 200)) throw pageError(400, '分页游标不合法')
  return { limit: Math.min(limit, PAGE_MAX), ...before !== null && { before }, ...after !== null && { after }, ...around !== null && { around } }
}

/**
 * 在完整、按时间排好的列表上取一页。游标指向的消息不存在时抛 410（客户端回到最新一页）。
 */
export function pageWindow<T>(all: readonly T[], key: (item: T) => string, query: PageQuery): { items: T[]; page: PageInfo } {
  const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(query.limit) || PAGE_DEFAULT))
  const cursor = query.before ?? query.after ?? query.around
  let start: number, end: number
  if (cursor === undefined) {
    end = all.length
    start = Math.max(0, end - limit)
  } else {
    const index = all.findIndex(item => key(item) === cursor)
    if (index < 0) throw pageError(410, '消息已不可用')
    if (query.before !== undefined) {
      end = index
      start = Math.max(0, end - limit)
    } else if (query.after !== undefined) {
      start = index + 1
      end = Math.min(all.length, start + limit)
    } else {
      // 目标前约一半、后约一半；靠近两头时整体平移，尽量凑满一页。
      start = Math.max(0, index - Math.floor((limit - 1) / 2))
      end = Math.min(all.length, start + limit)
      start = Math.max(0, end - limit)
    }
  }
  return { items: all.slice(start, end), page: { older: start > 0, newer: end < all.length } }
}

/** 接口人消息的分页游标：回复取第一条事件的序号（回复增长时不变），主人的话取自己的序号。 */
export const speechCursor = (message: { seq: number; firstSeq?: number }) => String(message.firstSeq ?? message.seq)
