/**
 * Test doubles for the two coding tools as SuperHub drives them: Codex as `codex … app-server --stdio` (JSON-RPC) and
 * Claude Code with stream-json input that replays each user message it takes. Scripts speak the older, compact
 * exec-style frames (`item.completed` / `agent_message` / `command_execution` / `turn.completed`); the Codex double
 * translates them into app-server notifications.
 */
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import type { HostContext, Subprocess } from '../src/dsh/ports.ts'

export type Spec = Parameters<Subprocess['spawn']>[0]
export interface FakeCall {
  spec: Spec
  /** Codex: the turn/start text. Claude Code: the first user message. */
  prompt: string
  /** Codex: continued thread id; Claude Code: `--resume` value. */
  resume?: string
  /** Codex: thread/start or thread/resume parameters. */
  thread?: Record<string, unknown>
  /** Owner words written into the running turn (turn/steer, or later stream-json user messages). */
  steers: string[]
  /** Codex: requests the client sent, in order. */
  methods: string[]
  /** Ordered native input blocks, including images, across startup and steering. */
  inputs: unknown[][]
}
export interface FakeIo {
  say(frame: object): void
  stderr(text: string): void
  /** Codex: a raw app-server notification. */
  notify(method: string, params: object): void
  /** The next owner words that reach this turn. */
  nextSteer(): Promise<string>
  /** Claude Code: echo the oldest written but untaken owner words (the model takes them). */
  take(): void
  /** Codex: resolves when the client asked to interrupt the turn. */
  interrupted: Promise<void>
  turnId: string
  threadId: string
  /** Claude Code: keep running after the script returns until the client closes the input. */
  linger(): void
}
export type FakeScript = (spec: Spec, prompt: string, io: FakeIo, call: FakeCall) => Promise<number> | number
export interface FakeOptions {
  /** Codex thread id for a new thread (default `thread-<n>`). */
  thread?: (call: FakeCall) => string
  /** Codex: refuse thread/resume with this JSON-RPC error message. */
  refuseResume?: (threadId: string) => string | undefined
  /** Codex: confirm hook trust when the thread asks for it (default true). */
  trust?: boolean
  /** Codex: answer every turn/steer as if the turn had just ended. */
  refuseSteer?: boolean
  /** Claude Code: echo the prompt when taken (default true). */
  replay?: boolean
  model?: string
}

const text = (content: unknown) => Array.isArray(content) ? content.map(part => (part as {text?: string}).text ?? '').join('\n') : String(content ?? '')

function codexItem(item: Record<string, unknown>, done: boolean): Record<string, unknown> {
  if (item.type === 'command_execution') return {type: 'commandExecution', id: item.id, command: item.command ?? '', cwd: '/',
    status: item.status ?? (done ? 'completed' : 'inProgress'), exitCode: item.exit_code ?? null, aggregatedOutput: item.aggregated_output ?? null,
    source: item.source ?? 'agent'}
  if (item.type === 'agent_message') return {type: 'agentMessage', id: item.id, text: item.text, phase: 'final_answer'}
  return {...item}
}

export function cliHost(perform: FakeScript, options: FakeOptions = {}) {
  const calls: FakeCall[] = []
  /** Codex thread titles set with thread/name/set, as thread/resume reports them back. */
  const names = new Map<string, string>()
  let threads = 0
  const subprocess: Subprocess = {spawn(spec) {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    const write = (frame: object) => { if (!stdout.writableEnded) stdout.write(JSON.stringify(frame) + '\n') }
    const codex = spec.argv.includes('app-server')
    const call: FakeCall = {spec, prompt: '', steers: [], methods: [], inputs: []}
    calls.push(call)
    const resumeAt = spec.argv.indexOf('--resume')
    if (!codex && resumeAt !== -1) call.resume = spec.argv[resumeAt + 1]
    const waiters: ((value: string) => void)[] = [], queued: string[] = []
    const steered = (value: string) => { call.steers.push(value); const next = waiters.shift(); if (next) next(value); else queued.push(value) }
    const interrupted = Promise.withResolvers<void>()
    const inputEnded = Promise.withResolvers<void>()
    const aborted = new Promise<void>(resolve => spec.signal?.addEventListener('abort', () => resolve(), {once: true}))
    let turnOpen = false, linger = false
    const untaken: object[] = []
    const io: FakeIo = {
      say: frame => {
        if (!codex) { write(frame); return }
        const event = frame as Record<string, unknown>
        const item = event.item as Record<string, unknown> | undefined
        if (event.type === 'thread.started' || event.type === 'turn.started') return
        if ((event.type === 'item.started' || event.type === 'item.completed') && item) {
          write({method: event.type === 'item.started' ? 'item/started' : 'item/completed', params: {threadId: io.threadId, turnId: io.turnId, item: codexItem(item, event.type === 'item.completed')}})
          return
        }
        if (event.type === 'turn.completed' || event.type === 'turn.failed') {
          turnOpen = false
          write({method: 'turn/completed', params: {threadId: io.threadId, turn: {id: io.turnId, status: event.type === 'turn.completed' ? 'completed' : 'failed', error: null}}})
          return
        }
        write(frame)
      },
      stderr: value => { stderr.write(value) },
      notify: (method, params) => write({method, params}),
      nextSteer: () => new Promise(resolve => { const value = queued.shift(); if (value !== undefined) resolve(value); else waiters.push(resolve) }),
      take: () => { const message = untaken.shift(); if (message) write({type: 'user', isReplay: true, message}) },
      interrupted: interrupted.promise,
      turnId: 'turn-' + calls.length,
      threadId: '',
      linger: () => { linger = true },
    }
    const finish = (code: number) => {
      if (!stdout.writableEnded) stdout.end()
      if (!stderr.writableEnded) stderr.end()
      return {exitCode: spec.signal?.aborted ? code || 143 : code, signal: null}
    }
    const runScript = async () => {
      return await Promise.race([Promise.resolve(perform(spec, call.prompt, io, call)), aborted.then(() => 143)])
    }
    const done = (async () => {
      const lines = createInterface({input: stdin, crlfDelay: Infinity})
      let script: Promise<number> | undefined
      const reader = (async () => {
        for await (const line of lines) {
          if (!line.trim()) continue
          const message = JSON.parse(line) as Record<string, unknown>
          if (!codex) {
            const content = (message.message as {content?: unknown} | undefined)?.content
            if (Array.isArray(content)) call.inputs.push(content)
            if (!script) {
              call.prompt = text(content)
              if (options.replay !== false) write({type: 'user', isReplay: true, message: message.message})
              script = runScript()
            } else {
              untaken.push(message.message as object)
              steered(text(content))
            }
            continue
          }
          const method = message.method as string | undefined
          if (!method) continue
          call.methods.push(method)
          const params = (message.params ?? {}) as Record<string, unknown>
          const reply = (result: object) => write({id: message.id, result})
          const refuse = (text: string) => write({id: message.id, error: {code: -32600, message: text}})
          if (method === 'initialize') reply({userAgent: 'fake'})
          else if (method === 'thread/start' || method === 'thread/resume') {
            call.thread = params
            if (method === 'thread/resume') {
              call.resume = params.threadId as string
              const refusal = options.refuseResume?.(call.resume)
              if (refusal) { refuse(refusal); continue }
            }
            io.threadId = method === 'thread/resume' ? call.resume! : options.thread?.(call) ?? 'thread-' + ++threads
            reply({thread: {id: io.threadId, ...(names.has(io.threadId) && {name: names.get(io.threadId)})}, model: options.model ?? 'gpt-fake'})
            if (options.trust !== false && (params.config as {bypass_hook_trust?: boolean} | undefined)?.bypass_hook_trust === true) {
              write({method: 'warning', params: {threadId: io.threadId, message: '`--dangerously-bypass-hook-trust` is enabled for this thread.'}})
            }
          } else if (method === 'thread/name/set') {
            names.set(params.threadId as string, params.name as string)
            reply({})
          } else if (method === 'turn/start') {
            call.inputs.push(params.input as unknown[])
            call.prompt = text((params.input as unknown[]).map(part => part))
            turnOpen = true
            reply({turn: {id: io.turnId, status: 'inProgress', items: [], error: null}})
            write({method: 'turn/started', params: {threadId: io.threadId, turn: {id: io.turnId, status: 'inProgress'}}})
            script = runScript()
          } else if (method === 'turn/steer') {
            if (!turnOpen || options.refuseSteer) refuse('no active turn to steer')
            else if (params.expectedTurnId !== io.turnId) refuse('expected active turn id `' + String(params.expectedTurnId) + '` but found `' + io.turnId + '`')
            else {
              call.inputs.push(params.input as unknown[])
              reply({turnId: io.turnId})
              const words = text(params.input)
              write({method: 'item/completed', params: {threadId: io.threadId, turnId: io.turnId, item: {type: 'userMessage', id: 'u-' + call.steers.length, clientId: params.clientUserMessageId ?? null, content: params.input}}})
              steered(words)
            }
          } else if (method === 'turn/interrupt') {
            reply({})
            interrupted.resolve()
            if (turnOpen) {
              turnOpen = false
              write({method: 'turn/completed', params: {threadId: io.threadId, turn: {id: io.turnId, status: 'interrupted', error: null}}})
            }
          } else if (message.id !== undefined) reply({})
        }
        inputEnded.resolve()
      })()
      reader.catch(() => inputEnded.resolve())
      // Before a turn starts, the process lives until its input closes (or it is stopped).
      while (!script) {
        const stop = await Promise.race([inputEnded.promise.then(() => 'ended' as const), aborted.then(() => 'aborted' as const),
          new Promise(resolve => setTimeout(resolve, 5)).then(() => 'tick' as const)])
        if (stop !== 'tick' && !script) return finish(stop === 'aborted' ? 143 : 0)
      }
      const code = await script
      if (spec.signal?.aborted) return finish(code)
      // Codex exits once its input closes after a completed turn; a script that left its turn open has crashed.
      if (codex && !turnOpen) {
        await Promise.race([inputEnded.promise, aborted])
        return finish(code)
      }
      if (!codex) await Promise.race([inputEnded.promise, aborted, ...(linger ? [] : [new Promise(resolve => setTimeout(resolve, 300))])])
      return finish(code)
    })()
    return {stdin, stdout, stderr, done}
  }}
  const ctx = {get: (name: string) => name === 'subprocess' ? subprocess : undefined} as unknown as HostContext
  return {ctx, calls, subprocess, names}
}
