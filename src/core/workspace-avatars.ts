/** Public portrait choices. A speaker ID is scoped to the conversation that verified it. */
export const avatarShapes = ['plane', 'sprout', 'wrench', 'compass', 'pencil', 'lighthouse', 'bell', 'fan', 'key', 'hourglass'] as const
export const avatarColors = ['blue', 'mint', 'apricot', 'violet', 'rose', 'teal', 'honey'] as const
export type AvatarShape = typeof avatarShapes[number]
export type AvatarColor = typeof avatarColors[number]
export const staffAvatarShapes = avatarShapes.filter(shape => shape !== 'plane')
export type StaffAvatarShape = typeof staffAvatarShapes[number]
export interface SpeakerPortrait { shape: AvatarShape; color: AvatarColor }
export type SpeakerPortraits = Record<string, SpeakerPortrait>
export const ownerPortrait: SpeakerPortrait = {shape: 'plane', color: 'blue'}
/** The liaison looks the same in its own chat and when it speaks in an order's conversation. */
export const liaisonPortrait: SpeakerPortrait = {shape: 'sprout', color: 'mint'}
export const isSpeakerId = (id: unknown): id is string => id === 'owner' || typeof id === 'string' && /^s-[a-f0-9]{24}$/.test(id)

export function isSpeakerPortrait(value: unknown): value is SpeakerPortrait {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const {shape,color} = value as Partial<SpeakerPortrait>
  return avatarShapes.some(s=>s===shape) && avatarColors.some(c=>c===color)
}

export function isStaffAvatarShape(value: unknown): value is StaffAvatarShape {
  return staffAvatarShapes.some(shape => shape === value)
}

const builtinStaffPortraits = new Map<string, SpeakerPortrait>([
  ['chief', {shape:'bell',color:'apricot'}],
  ['engineer', {shape:'wrench',color:'blue'}],
  ['liaison', {shape:'key',color:'teal'}],
  ['researcher', {shape:'compass',color:'mint'}],
  ['reviewer', {shape:'lighthouse',color:'violet'}],
  ['scribe', {shape:'pencil',color:'honey'}],
  ['strategist', {shape:'hourglass',color:'blue'}],
  ['ui-smith', {shape:'fan',color:'rose'}],
])

const rolePortraits: readonly {shape:StaffAvatarShape; use:string; cues:readonly string[]}[] = [
  {shape:'fan',use:'折扇（界面、视觉与版式）',cues:['界面师','界面设计','界面原型','前端界面','视觉设计','版式设计','ui designer','ux designer']},
  {shape:'wrench',use:'扳手（工程、构建与维修）',cues:['工程师','程序员','开发者','软件开发','编程','写代码','维修','engineer','developer']},
  {shape:'key',use:'钥匙（外务、跨设备执行与交接）',cues:['外务','交接员','工作电脑','跨设备','远程执行','remote operations']},
  {shape:'compass',use:'指南针（研究、访谈与探索）',cues:['研究员','调研','调查','访谈','市场研究','researcher','research']},
  {shape:'lighthouse',use:'灯塔（审查、核验与风险）',cues:['审查','审核','审计','核验','验收质量','风险检查','reviewer','auditor']},
  {shape:'pencil',use:'铅笔（记录、编辑与归档）',cues:['书记','文档编辑','编辑员','归档','纪要','会议记录','记录员','editor','scribe']},
  {shape:'hourglass',use:'沙漏（谋划、取舍与时机）',cues:['谋士','策略顾问','决策顾问','优先级','权衡','路线规划','strategist','planner']},
  {shape:'bell',use:'铃铛（研判、值班与提醒）',cues:['研判','值班','提醒','事件分流','告警','通知员','triage','alerts']},
  {shape:'sprout',use:'双叶书签（学习、训练与知识积累）',cues:['教练','培训','辅导','学习','知识库','coach','training']},
]

export const staffAvatarGuidance = rolePortraits.map(({shape,use}) => shape + ' ' + use).join('、')

/** The same role keeps its default across orders, workspaces and name changes. */
export function defaultStaffPortrait(staffId: string, savedDefault?: SpeakerPortrait): SpeakerPortrait {
  const portrait = builtinStaffPortraits.get(staffId) ?? savedDefault
  if (portrait) return portrait
  let hash = 2166136261
  for (const c of staffId) hash = Math.imul(hash ^ c.codePointAt(0)!,16777619) >>> 0
  const count = staffAvatarShapes.length
  return {shape:staffAvatarShapes[hash % count]!,color:avatarColors[Math.floor(hash / count) % avatarColors.length]!}
}

function roleShapes(text: string) {
  const normalized = text.normalize('NFKC').toLowerCase()
  return rolePortraits.filter(role => role.cues.some(cue => normalized.includes(cue))).map(role => role.shape)
}

/** Choose once at creation using role-card fields and the current roster. */
export function recommendStaffPortrait(role: {id:string; name:string; brief:string}, roster: readonly SpeakerPortrait[],
  preferredShape?: StaffAvatarShape): SpeakerPortrait {
  const builtin = builtinStaffPortraits.get(role.id)
  if (builtin) return builtin
  const stable = defaultStaffPortrait(role.id)
  const titleShapes = roleShapes(role.name)
  const dutyShapes = roleShapes(role.brief.split('\n', 1)[0] ?? '')
  const sharedShapes = titleShapes.filter(shape => dutyShapes.includes(shape))
  const candidates = sharedShapes.length ? sharedShapes : dutyShapes.length ? dutyShapes : titleShapes
  const shape = preferredShape ?? candidates.find(shape => !roster.some(portrait => portrait.shape === shape)) ?? candidates[0]
  if (!shape) return stable

  const start = avatarColors.indexOf(stable.color)
  const colors = [...avatarColors.slice(start), ...avatarColors.slice(0, start)]
  const color = colors.find(color => !roster.some(portrait => portrait.color === color))
    ?? colors.find(color => !roster.some(portrait => portrait.shape === shape && portrait.color === color))
    ?? stable.color
  return {shape,color}
}

export function isSpeakerPortraits(value: unknown): value is SpeakerPortraits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value).every(([id,p])=>isSpeakerId(id) && isSpeakerPortrait(p))
}

/** Allocate new identities together and keep every previously published pairing, even after a member leaves. */
export function registerSpeakers(previous: SpeakerPortraits, ids: readonly string[]): SpeakerPortraits {
  const incoming = [...new Set(ids.filter(id => isSpeakerId(id) && !Object.hasOwn(previous, id)))].sort()
  if (!incoming.length) return previous
  const portraits = {...previous}
  const shapes = staffAvatarShapes
  for (const id of incoming) {
    if (id === 'owner') {
      portraits[id] = ownerPortrait
      continue
    }
    const used = Object.values(portraits)
    const shapeStart = parseInt(id.slice(2, 10), 16) % shapes.length
    const colorStart = parseInt(id.slice(10, 18), 16) % avatarColors.length
    const rankedShapes = [...shapes.slice(shapeStart), ...shapes.slice(0, shapeStart)]
    const rankedColors = [...avatarColors.slice(colorStart), ...avatarColors.slice(0, colorStart)]
    const shape = rankedShapes.find(candidate => !used.some(p => p.shape === candidate)) ?? rankedShapes[0]!
    const color = rankedColors.find(candidate => candidate !== 'blue' && !used.some(p => p.color === candidate))
      ?? rankedColors.find(candidate => !used.some(p => p.shape === shape && p.color === candidate))
      ?? rankedColors[0]!
    portraits[id] = {shape, color}
  }
  return portraits
}
