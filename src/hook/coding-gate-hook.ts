/**
 * PreToolUse hook for Codex and Claude Code sessions started by SuperHub (shipped as `lib/coding-gate-hook.js`).
 *
 * Reads the hook input on stdin, asks the SuperHub command gate over `SUPERHUB_GATE_SOCKET` with the turn token
 * `SUPERHUB_GATE_TOKEN`, and answers on every path before the tool's own timeout:
 *
 * - deny: prints `hookSpecificOutput.permissionDecision = "deny"` with a non-empty reason (both tools honour it);
 * - allow: prints nothing and exits 0. Codex 0.170 rejects `permissionDecision: "allow"` as unsupported, and an
 *   empty answer lets both tools run the call in their own (full-access) mode.
 *
 * Codex runs a command when its hook times out or dies, so this script answers `deny` itself at
 * `SUPERHUB_GATE_DEADLINE_MS` (approval window + 30 s), before the tool's own timeout (window + 90 s).
 * When the gate cannot be reached or refuses the token, the shared classifier decides locally:
 * high risk is denied, everything else runs.
 */
import { connect } from 'node:net'
import { classifyToolCall } from '../core/coding-risk.ts'

const DEFAULT_DEADLINE_MS = 30 * 60_000 + 30_000
const MAX_INPUT = 8 * 1024 * 1024
const CARRY_ON = '不要重试，也不要换一种写法绕过；继续完成其余工作，并在回复中说明这一步没有执行。'

let answered = false
function answer(decision: 'allow' | 'deny', reason: string) {
  if (answered) return
  answered = true
  if (decision === 'allow') return process.exit(0)
  const line = JSON.stringify({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: reason.trim() || 'SuperHub 没有放行这条命令。' + CARRY_ON}}) + '\n'
  process.stdout.write(line, () => process.exit(0))
}

const configured = Number(process.env.SUPERHUB_GATE_DEADLINE_MS)
const deadline = setTimeout(() => answer('deny', '等待 SuperHub 答复超时，这条命令没有执行。' + CARRY_ON),
  Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DEADLINE_MS)

function readInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      text += chunk
      if (text.length > MAX_INPUT) reject(new Error('钩子输入过长'))
    })
    process.stdin.once('end', () => resolve(text))
    process.stdin.once('error', reject)
  })
}

function local(input: Record<string, unknown>, why: string) {
  let high = true, reason = '无法可靠解析的写法'
  try {
    const risk = classifyToolCall(typeof input.tool_name === 'string' ? input.tool_name : 'Bash', input.tool_input)
    high = risk.risk === 'high'
    reason = risk.reason
  } catch { /* unreadable input counts as high risk */ }
  if (high) answer('deny', 'SuperHub 把关服务不可用（' + why + '），高危命令（' + reason + '）没有执行。' + CARRY_ON)
  else answer('allow', 'SuperHub 把关服务不可用（' + why + '），普通命令照常执行。')
}

function ask(socketPath: string, request: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let text = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk: string) => { text += chunk; if (text.length > 64 * 1024) socket.destroy(new Error('答复过长')) })
    socket.once('error', reject)
    socket.once('close', () => {
      const line = text.split('\n')[0]
      try { resolve(JSON.parse(line!) as Record<string, unknown>) }
      catch { reject(new Error('把关服务没有给出答复')) }
    })
  })
}

async function main() {
  let input: Record<string, unknown>
  try {
    const value = JSON.parse(await readInput()) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('钩子输入格式无法识别')
    input = value as Record<string, unknown>
  } catch {
    answer('deny', 'SuperHub 无法读取这次工具调用的内容，没有执行。' + CARRY_ON)
    return
  }
  const socketPath = process.env.SUPERHUB_GATE_SOCKET, token = process.env.SUPERHUB_GATE_TOKEN
  if (!socketPath || !token) return local(input, '缺少回合凭据')
  let reply: Record<string, unknown>
  try {
    reply = await ask(socketPath, {token, tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd,
      session_id: input.session_id, tool_use_id: input.tool_use_id})
  } catch (error) {
    return local(input, error instanceof Error ? error.message.slice(0, 80) : '连接失败')
  }
  if ((reply.decision === 'allow' || reply.decision === 'deny') && typeof reply.reason === 'string') {
    clearTimeout(deadline)
    return answer(reply.decision, reply.reason)
  }
  return local(input, typeof reply.error === 'string' ? reply.error.slice(0, 80) : '答复无法识别')
}

main().catch(() => answer('deny', 'SuperHub 命令把关出错，这条命令没有执行。' + CARRY_ON))
