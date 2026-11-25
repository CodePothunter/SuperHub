#!/usr/bin/env node
/**
 * Protocol fixture installed as codex/claude only in the acceptance host's temporary PATH.
 * Codex speaks the app-server JSON-RPC protocol (`codex … app-server --stdio`); Claude Code reads stream-json user
 * messages and replays each one it takes (`--input-format stream-json --replay-user-messages`).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'

const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const codex = basename(process.argv[1]) === 'codex'
const ownerTurn = '本轮发言\n', original = '主人原话：\n'

/** The owner's words of a turn: quoted after a liaison hand-over, otherwise after the speaker's label. */
function ownerWords(said) {
  const quoted = said.lastIndexOf(original)
  if (quoted >= 0) return said.slice(quoted + original.length).split('\n').map(line => line.replace(/^> ?/, '')).join('\n').trim()
  return said.replace(/^〔(?:主人|接口人)〕/, '').trim()
}

/**
 * A group member's prompt (SuperHub group chat): the newest line the owner or the liaison said to it, without the leading
 * `@名字`; a liaison hand-over quotes the owner's original words, which are the request.
 */
const groupSections = ['群里最近的消息：\n', '群里的新消息（自你上次读后）：\n']
function groupRequest(prompt) {
  const at = Math.max(...groupSections.map(head => { const i = prompt.lastIndexOf(head); return i < 0 ? -1 : i + head.length }))
  if (!prompt.includes('群成员：') || at < 0) return undefined
  const entries = [...prompt.slice(at).matchAll(/^#\d+ ([^\n：]+?)(?:（进行中）)?：([\s\S]*?)(?=\n#\d+ |(?![\s\S]))/gm)]
  const asked = entries.findLast(entry => entry[1] === '主人' || entry[1] === '接口人')
  if (!asked) return undefined
  const said = asked[2].replace(/^(?:@\S+\s*)+/, '').trim()
  return said.includes(original) ? ownerWords(said) : said
}

/** What the fixture does for one prompt: files it writes and the public answers it gives. */
function respond(prompt) {
  const group = prompt.includes(ownerTurn) ? undefined : groupRequest(prompt)
  if (!prompt.includes(ownerTurn) && group === undefined) process.exit(2)
  const request = group !== undefined ? group : ownerWords(prompt.slice(prompt.lastIndexOf(ownerTurn) + ownerTurn.length).trim())
  const createSignup = request === '请做好「周五试点」的手机报名页，让我能填写姓名并提交。' || request === '请让 Codex 做一个手机报名页，我想自己试填一下。'
  const repairSignup = request === '修复按钮，让试点报名可以重新提交。'
  if (createSignup || repairSignup) {
    let html
    if (createSignup) {
      html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>周五试点报名</title><style>body{margin:24px;color:#20372b;font:18px/1.5 sans-serif}label,input{display:block}input,button{font:inherit;padding:8px;margin:5px 0 16px}input{max-width:100%;box-sizing:border-box}</style></head>
<body><main><h1>周五试点报名</h1>
<form action="/registrations" method="post"><label>姓名<input name="name" type="text" required></label>
<button type="submit">提交报名</button>
</form></main></body></html>`
    } else {
      html = readFileSync('index.html','utf8')
      if (!html.includes('周五试点报名')) throw new Error('本场会话需要以上次的报名页为起点')
      html = html.replace('<h1>周五试点报名</h1>', '<h1>周五试点报名 · 已修正</h1>')
    }
    writeFileSync('index.html',html)
    return {answers: ['这版报名页可以查看了。[查看报名页源码](index.html)']}
  }
  if (request === '请把交接要点写成一份 Markdown 清单。') {
    if (prompt.includes('/registrations')) throw new Error('普通文稿不应收到报名服务的执行要求')
    writeFileSync('交接清单.md','# 交接清单\n\n核对交付日期\n')
    return {answers: ['[交接清单](交接清单.md)']}
  }
  if (codex) {
    writeFileSync('报名表.md', '# 报名表\n\n请填写姓名和邮箱。\n')
    return {answers: ['我先核对两个必填字段。', '报名表已整理好。[打开报名表](报名表.md)'], command: 'fixture-internal-only'}
  }
  return {answers: ['我检查过提交提示，手机页面可以直接显示确认文字。']}
}

/** Like Codex, ask the installed PreToolUse hook before running a command; a denial means no command item. */
function hookAllows(command, threadId) {
  const config = process.argv.find(arg => arg.startsWith('hooks.PreToolUse='))
  const hook = config && /command=("(?:[^"\\]|\\.)*")/.exec(config)?.[1]
  if (!hook) return true
  const run = spawnSync('sh', ['-c', JSON.parse(hook)], {input: JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: {command}, cwd: process.cwd(), session_id: threadId}), encoding: 'utf8', env: process.env})
  return run.status === 0 && !/"permissionDecision"\s*:\s*"deny"/.test(run.stdout)
}

const lines = createInterface({input: process.stdin, crlfDelay: Infinity})
if (codex) {
  if (!process.argv.includes('app-server')) process.exit(2)
  let threadId, turn = 0
  const reply = (id, result) => emit({id, result})
  for await (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') reply(message.id, {userAgent: 'fixture'})
    else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      threadId = message.params.threadId ?? 'fixture-thread-' + process.pid
      reply(message.id, {thread: {id: threadId}, model: 'fixture-model'})
      if (message.params.config?.bypass_hook_trust === true) emit({method: 'warning', params: {threadId, message: '`--dangerously-bypass-hook-trust` is enabled for this thread.'}})
    } else if (message.method === 'turn/start') {
      const turnId = 'fixture-turn-' + ++turn
      reply(message.id, {turn: {id: turnId, status: 'inProgress', items: [], error: null}})
      emit({method: 'turn/started', params: {threadId, turn: {id: turnId, status: 'inProgress'}}})
      const {answers, command} = respond(message.params.input.map(part => part.text).join('\n'))
      answers.forEach((text, i) => {
        emit({method: 'item/completed', params: {threadId, turnId, item: {type: 'agentMessage', id: turnId + '-m' + i, text, phase: i === answers.length - 1 ? 'final_answer' : 'commentary'}}})
        if (i === 0 && command && hookAllows(command, threadId)) emit({method: 'item/completed', params: {threadId, turnId, item: {type: 'commandExecution', id: turnId + '-c', command, aggregatedOutput: '', exitCode: 0, status: 'completed'}}})
      })
      emit({method: 'turn/completed', params: {threadId, turn: {id: turnId, status: 'completed', error: null}}})
    } else if (message.method === 'turn/steer') emit({id: message.id, error: {code: -32600, message: 'no active turn to steer'}})
    else if (message.id !== undefined) reply(message.id, {})
  }
} else {
  if (!process.argv.includes('stream-json') || !process.argv.includes('--replay-user-messages')) process.exit(2)
  for await (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line).message
    const text = message.content.map(part => part.text).join('\n')
    emit({type: 'user', isReplay: true, message})
    emit({type: 'system', subtype: 'init', session_id: 'fixture-claude-' + process.pid, model: 'fixture-model'})
    const {answers} = respond(text)
    emit({type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'fixture-claude-' + process.pid, result: answers.join('\n')})
  }
}
