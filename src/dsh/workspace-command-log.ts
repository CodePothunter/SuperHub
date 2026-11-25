import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeSync, constants } from 'node:fs'
import { commandBody } from '../core/coding-risk.ts'
import type { V2CodingPermission, V2CommandDecision, V2CommandRecord, V2PermissionChange } from '../core/workspace-v2.ts'

/**
 * Append-only execution record of one coding session (`commands.jsonl` next to its `source.json`). A command start
 * stays in memory; one line is appended when the command ends, when the command gate decides, and when the owner
 * changes an order's tier. Readers take the most recent lines from the end of the file.
 */
export interface GateLine {
  kind: 'gate'
  id: string
  turnId: string
  workOrderId: string | null
  at: string
  tool: string
  command: string
  cwd: string
  risk: 'high' | 'normal'
  tier: V2CodingPermission
  decision: V2CommandDecision
  /** `owner`, `reviewer`, `policy` (tier or risk decided) or `gate` (the gate itself could not decide). */
  by: string
  reason: string
  /** Claude Code's `tool_use_id` (and Codex's when present), pairing the decision with the tool's own report. */
  toolUseId?: string
  /** The group member that ran it (roster groups). */
  memberId?: string
  memberName?: string
}
export interface CommandLine {
  kind: 'command'
  id: string
  /** The tool's own item id (Codex item id, Claude Code tool_use id). */
  itemId: string
  turnId: string
  workOrderId: string | null
  at: string
  tool: string
  command: string
  cwd: string
  endedAt?: string
  exitCode?: number | null
  failed?: boolean
  outputTail?: string
  unfinished?: true
  /** The command hook was running this turn, but no ask matched this run's text (for review; not a breach). */
  unmatched?: true
  /** The group member that ran it (roster groups). */
  memberId?: string
  memberName?: string
}
export interface PermissionLine { kind: 'permission'; id: string; workOrderId: string; at: string; from: V2CodingPermission; to: V2CodingPermission; by: 'owner' }
export type CommandLogLine = GateLine | CommandLine | PermissionLine

export const EXECUTION_LIMIT = 200
const CHUNK = 256 * 1024
const MAX_SCAN = 16 * 1024 * 1024

function ownedFile(path: string) {
  if (existsSync(path) && (realpathSync(path) !== path || !lstatSync(path).isFile())) throw new Error('执行记录的归属已改变。')
}

/** One JSON line per call. A torn last line from a crash is closed first, so later lines stay readable. */
export function appendCommandLog(path: string, line: CommandLogLine) {
  ownedFile(path)
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    const size = fstatSync(fd).size
    let prefix = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      const reader = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { readSync(reader, last, 0, 1, size - 1) } finally { closeSync(reader) }
      if (last[0] !== 0x0a) prefix = '\n'
    }
    writeSync(fd, prefix + JSON.stringify(line) + '\n')
  } finally { closeSync(fd) }
}

/** Complete lines from the end of the file, oldest first, until `enough` reports that the caller has what it needs. */
function tailLines(path: string, enough: (lines: string[]) => boolean): string[] {
  if (!existsSync(path)) return []
  ownedFile(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const size = fstatSync(fd).size
    let position = size, carry = Buffer.alloc(0)
    const lines: string[] = []
    while (position > 0 && size - position < MAX_SCAN) {
      const length = Math.min(CHUNK, position)
      position -= length
      const chunk = Buffer.alloc(length)
      readSync(fd, chunk, 0, length, position)
      let data = Buffer.concat([chunk, carry])
      const found: string[] = []
      let end = data.length
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue
        if (end > i + 1) found.push(data.subarray(i + 1, end).toString('utf8'))
        end = i
      }
      carry = data.subarray(0, end)
      data = Buffer.alloc(0)
      lines.unshift(...found.reverse())
      if (enough(lines)) return lines
    }
    if (position === 0 && carry.length) lines.unshift(carry.toString('utf8'))
    return lines
  } finally { closeSync(fd) }
}

function parse(line: string): CommandLogLine | undefined {
  try {
    const value = JSON.parse(line) as CommandLogLine
    return value && typeof value === 'object' && typeof value.id === 'string' && ['gate', 'command', 'permission'].includes(value.kind) ? value : undefined
  } catch { return undefined }
}

const ALLOWING = new Set<V2CommandDecision>(['auto', 'allowed', 'reviewer-allowed'])
const gateFields = (gate: GateLine) => ({risk: gate.risk, tier: gate.tier, decision: gate.decision, by: gate.by, reason: gate.reason})
const memberFields = (line: GateLine | CommandLine) => ({...(line.memberId && {memberId: line.memberId}), ...(line.memberName && {memberName: line.memberName})})

/**
 * Command records of one order (`null`: the session discussion), newest last. A gate decision and the tool's own
 * report of the same command become one record: paired by tool use id, otherwise by the command the shell runs.
 * `running` holds commands that have started but not ended yet (kept in memory by the running turn).
 */
export function readCommandLog(path: string, workOrderId: string | null, running: readonly CommandLine[] = [], limit = EXECUTION_LIMIT): {commands: V2CommandRecord[]; permissions: V2PermissionChange[]} {
  const mine = (line: CommandLogLine | undefined): line is CommandLogLine => !!line && line.workOrderId === workOrderId
  const raw = tailLines(path, lines => lines.filter(line => line.includes('"workOrderId":' + JSON.stringify(workOrderId))).length >= limit * 3)
  const lines = [...raw.map(parse).filter(mine), ...running.filter(line => line.workOrderId === workOrderId)]
  const records: V2CommandRecord[] = []
  const permissions: V2PermissionChange[] = []
  const open: {gate: GateLine; record: V2CommandRecord}[] = []
  for (const line of lines) {
    if (line.kind === 'permission') { permissions.push({at: line.at, from: line.from, to: line.to}); continue }
    if (line.kind === 'gate') {
      const record: V2CommandRecord = {id: line.id, turnId: line.turnId, workOrderId: line.workOrderId, at: line.at, tool: line.tool, command: line.command, cwd: line.cwd,
        ...gateFields(line), ...memberFields(line)}
      open.push({gate: line, record})
      records.push(record)
      continue
    }
    const body = commandBody(line.command)
    const sameTurn = ({gate}: {gate: GateLine}) => gate.turnId === line.turnId
    let index = open.findIndex(entry => sameTurn(entry) && entry.gate.toolUseId === line.itemId)
    if (index === -1) {
      // By text, a command that ran pairs only with a decision that let it run: a refused earlier attempt of the
      // same text must not show this run's exit code. A declined report follows its refusal, so it takes the latest.
      const ran = typeof line.exitCode === 'number' || !!line.unfinished || !line.failed
      const same = (entry: {gate: GateLine}) => sameTurn(entry) && commandBody(entry.gate.command) === body
      index = ran ? open.findIndex(entry => same(entry) && ALLOWING.has(entry.gate.decision))
        : open.findLastIndex(entry => same(entry) && !ALLOWING.has(entry.gate.decision))
      if (index === -1 && !ran) index = open.findLastIndex(same)
    }
    const reported: V2CommandRecord = {id: line.id, turnId: line.turnId, workOrderId: line.workOrderId, at: line.at, tool: line.tool, command: line.command, cwd: line.cwd,
      ...(line.endedAt && {endedAt: line.endedAt}), ...(line.exitCode !== undefined && {exitCode: line.exitCode}), ...(line.failed && {failed: true}),
      ...(line.outputTail && {outputTail: line.outputTail}), ...(line.unfinished && {unfinished: true}), ...(line.unmatched && {unmatched: true}), ...memberFields(line)}
    if (index === -1) { records.push(reported); continue }
    const {gate, record} = open.splice(index, 1)[0]!
    // The gate saw the command first: keep its time, place and directory; the tool adds the outcome.
    Object.assign(record, reported, {at: gate.at, cwd: gate.cwd, ...gateFields(gate), ...memberFields(gate), ...memberFields(line)})
  }
  return {commands: records.slice(-limit), permissions: permissions.slice(-limit)}
}
