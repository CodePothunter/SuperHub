/**
 * 讨论、执行记录与头像里的角色名：一律按幕僚花名册（id → name）解析。只有系统身份写死：lead 是接口人、you 是主人。
 * 幕僚 id 恰好是 liaison（外务）或 chief（研判官）时按幕僚处理，不当作接口人或系统。未知 id 原样显示。
 */
export interface RosterName { readonly id: string; readonly name: string }

let current: readonly RosterName[] = []
/** 作战台状态到达时登记当前花名册（头像等拿不到 props 的地方用它）。 */
export function setRoster(rows: readonly RosterName[] | undefined) { if (rows) current = rows.map(({ id, name }) => ({ id, name })) }

export function staffName(id: string, roster: readonly RosterName[] = current): string {
  if (id === 'lead') return '接口人'
  if (id === 'you') return '你'
  return roster.find(row => row.id === id)?.name ?? id
}

/** 头像按幕僚 id 取样式：传进来的是中文称呼时按花名册换回 id。 */
export function staffKey(who: string, roster: readonly RosterName[] = current): string {
  if (who === '接口人') return 'lead'
  if (who === '你') return 'you'
  return roster.some(row => row.id === who) ? who : roster.find(row => row.name === who)?.id ?? who
}
