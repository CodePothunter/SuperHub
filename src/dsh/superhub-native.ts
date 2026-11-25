import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExecutionRef } from '../core/model.ts'
import type { HostContext, SessionEventLike } from './ports.ts'

const knownTools = new Set(['read', 'write', 'edit', 'grep', 'glob', 'bash', 'shell', 'exec_command', 'structured_output', 'chief_lookup', 'chief_ticket', 'chief_record', 'chief_brief'])
const turnReasons = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens'])
const sourceKinds = new Set(['user', 'tool', 'assistant', 'agent', 'subagent', 'team', 'system', 'hook'])
const eventTypes = [
  'subagent/descriptor', 'model/selection', 'turn/start', 'turn/end',
  'user/message', 'agent/inbox/spliced', 'tool/call', 'tool/result',
] as const
type EventType = typeof eventTypes[number]
type Channel = 'live' | 'history'

export interface NativeFact {
  type: EventType
  seq: number
  at: string
  observedAt: string
  channel: Channel
  turn?: number
  step?: number
  callKey?: string
  sourceCallKey?: string
  tool?: string
  failed?: boolean
  reason?: string
  provider?: string
  model?: string
  descriptorVersion?: number
  inputKind?: string
  inboxTarget?: string
  inserted?: number
}

type ReadState = 'available' | 'unreadable' | 'unconfirmed' | 'unsupported'
interface Sample {
  facts: Map<number, NativeFact>
  sorted?: NativeFact[]
  version: number
  pending: Map<number, NativeFact>
  confirmed: boolean
  lastObservedAt?: string
  lastReadAt?: string
  lastCheckedAt?: string
  readState?: ReadState
  reading?: Promise<void>
}

interface NativeOptions { storage?: string; log?: (message: string) => void; now?: () => Date }
type LogEntry = { scope: string; sessionId: string } & ({ row: NativeFact } | { checkedAt: string })

const object = (data: unknown): Record<string, unknown> => data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const token = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/.test(value) && !/^(?:sk-|bearer|ghp_|github_pat_)/i.test(value) ? value : undefined
const allowed = (value: unknown, values: Set<string>) => typeof value === 'string' && values.has(value) ? value : undefined
const callKey = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 512 ? createHash('sha256').update(value).digest('hex') : undefined
const savedCallKey = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined
const iso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined
const descriptor = (row: NativeFact) => row.type === 'subagent/descriptor' && row.provider === 'spawn' && row.descriptorVersion === 3

/** Session/activation lookup applies only to the provider whose native identity was measured. */
export const nativeCandidate = (ref: ExecutionRef | undefined): string | undefined =>
  ref?.provider === 'spawn' ? token(ref.sessionId ?? ref.activationId) : undefined

function project(event: SessionEventLike, observedAt: string, channel: Channel): NativeFact | undefined {
  const type = eventTypes.find(type => type === event.type)
  const seq = integer(event.seq)
  const time = new Date(event.time)
  if (type === undefined || seq === undefined || !Number.isFinite(time.getTime())) return undefined
  const row: NativeFact = { type, seq, at: time.toISOString(), observedAt, channel }
  const data = object(event.data)
  switch (type) {
    case 'subagent/descriptor':
      return data.provider === 'spawn' && data.mode === 'continuable'
        ? { ...row, provider: 'spawn', descriptorVersion: integer(data.version) } : undefined
    case 'model/selection':
      return { ...row, provider: token(data.provider), model: token(data.model) }
    case 'turn/start':
      return { ...row, turn: integer(data.turn) }
    case 'turn/end': {
      const reason = object(data.reason).kind
      // Cold queries can synthesize this closer at the next physical sequence.
      if (reason === 'interrupted' || reason === 'forked') return
      return { ...row, turn: integer(data.turn), reason: allowed(reason, turnReasons) }
    }
    case 'user/message':
      return { ...row, inputKind: allowed(object(data.source).kind, sourceKinds) }
    case 'agent/inbox/spliced':
      return { ...row, inserted: Array.isArray(data.inserted) ? data.inserted.length : undefined,
        inboxTarget: data.target === 'next-step' || data.target === 'next-turn' ? data.target : undefined }
    case 'tool/call':
      return { ...row, turn: integer(data.turn), step: integer(data.step), callKey: callKey(data.callId), tool: allowed(data.name, knownTools) ?? 'other' }
    case 'tool/result': {
      const message = object(data.message)
      return { ...row, turn: integer(data.turn), step: integer(data.step), callKey: callKey(message.toolCallId),
        sourceCallKey: callKey(object(message.source).callId), failed: Object.hasOwn(message, 'toolCallId') || Object.hasOwn(message, 'source')
          ? message.isError === true : undefined }
    }
  }
}

function savedFact(value: unknown): NativeFact | undefined {
  const row = object(value)
  const type = eventTypes.find(type => type === row.type), seq = integer(row.seq)
  const at = iso(row.at), observedAt = iso(row.observedAt)
  if (type === undefined || seq === undefined || !at || !observedAt || (row.channel !== 'live' && row.channel !== 'history')) return undefined
  return {
    type, seq, at, observedAt, channel: row.channel, turn: integer(row.turn), step: integer(row.step),
    callKey: savedCallKey(row.callKey), sourceCallKey: savedCallKey(row.sourceCallKey),
    tool: allowed(row.tool, knownTools) ?? (row.tool === 'other' ? 'other' : undefined),
    failed: typeof row.failed === 'boolean' ? row.failed : undefined,
    reason: allowed(row.reason, turnReasons), provider: token(row.provider), model: token(row.model),
    descriptorVersion: integer(row.descriptorVersion), inputKind: allowed(row.inputKind, sourceKinds),
    inboxTarget: row.inboxTarget === 'next-step' || row.inboxTarget === 'next-turn' ? row.inboxTarget : undefined, inserted: integer(row.inserted),
  }
}

/** Holds only allowlisted metadata from ticket-bound native sessions. */
export class SuperhubNative {
  private readonly samples = new Map<string, Sample>()
  private readonly tracked = new Set<string>()
  private readonly abort = new AbortController()
  private readonly now: () => Date
  private readonly off?: () => void
  private storageFailed = false
  version = 0

  constructor(private readonly ctx: Pick<HostContext, 'get' | 'on'>, private readonly scope: string, private readonly options: NativeOptions) {
    this.now = options.now ?? (() => new Date())
    this.load()
    this.off = ctx.on?.('session/event', (session, event) => {
      if (!this.tracked.has(session.id)) return
      const row = project(event, this.now().toISOString(), 'live')
      if (!row) return
      const sample = this.sample(session.id)
      if (descriptor(row)) sample.confirmed = true
      if (!sample.confirmed) {
        sample.pending.set(row.seq, row)
        if (sample.pending.size > 64) sample.pending.delete(sample.pending.keys().next().value!)
        return
      }
      this.ingest(session.id, sample, [...sample.pending.values(), row])
      sample.pending.clear()
    })
  }

  status() { return this.storageFailed ? 'unreadable' : this.options.storage ? 'complete' : 'unsupported' }

  revision(id: string | undefined) { return id ? this.samples.get(id)?.version ?? 0 : 0 }

  watch(ids: readonly string[]) {
    for (const id of ids) this.tracked.add(id)
  }

  forget(id: string) {
    this.tracked.delete(id)
  }

  async refresh(ids: readonly string[]) {
    this.watch(ids)
    for (let i = 0; i < ids.length; i += 4) {
      await Promise.all(ids.slice(i, i + 4).map(id => this.refreshOne(id)))
    }
  }

  async refreshForQuery(ids: readonly string[]) {
    if (!ids.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Let the already indexed view serve even if native storage is slow.
      await Promise.race([this.refresh(ids), new Promise<void>(resolve => { timer = setTimeout(resolve, 700) })])
    } finally { clearTimeout(timer) }
  }

  read(id: string) {
    const sample = this.samples.get(id)
    if (!sample) return undefined
    const facts = sample.confirmed ? (sample.sorted ??= [...sample.facts.values()].sort((a, b) => a.seq - b.seq)) : []
    return { facts, confirmed: sample.confirmed, readState: sample.readState,
      lastReadAt: sample.lastReadAt, lastCheckedAt: sample.lastCheckedAt,
      lastObservedAt: sample.confirmed ? sample.lastObservedAt : undefined,
      sourceSequence: facts.at(-1)?.seq }
  }

  observedSessions(from: string, to: string): string[] {
    const sessions: string[] = []
    for (const [id, sample] of this.samples) {
      if (!sample.confirmed || !this.tracked.has(id) || !sample.lastObservedAt || sample.lastObservedAt < from) continue
      if (sample.lastObservedAt <= to
        || [...sample.facts.values()].some(row => row.observedAt >= from && row.observedAt <= to)) sessions.push(id)
    }
    return sessions
  }

  dispose() {
    this.abort.abort()
    this.off?.()
    this.tracked.clear()
  }

  private sample(id: string) {
    let sample = this.samples.get(id)
    if (!sample) {
      sample = { facts: new Map(), pending: new Map(), confirmed: false, version: 0 }
      this.samples.set(id, sample)
    }
    return sample
  }

  private refreshOne(id: string): Promise<void> | undefined {
    if (this.abort.signal.aborted) return
    const sample = this.sample(id)
    if (sample.reading) return sample.reading
    const now = this.now()
    if (sample.lastCheckedAt && now.getTime() - Date.parse(sample.lastCheckedAt) < 2500) return
    sample.lastCheckedAt = now.toISOString()
    sample.reading = this.query(id, sample).finally(() => { sample.reading = undefined })
    return sample.reading
  }

  private async query(id: string, sample: Sample) {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(1600)])
    try {
      const query = this.ctx.get('sessionQuery')
      if (!query) { this.mark(sample, 'unsupported'); return }
      const pending = query.observeSession(id, { projectionMode: 'none', signal })
      const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
        const expired = () => reject(signal.reason)
        if (signal.aborted) expired()
        signal.addEventListener('abort', expired, { once: true })
        void pending.then(
          observation => {
            signal.removeEventListener('abort', expired)
            if (signal.aborted) observation[Symbol.dispose]()
            else resolve(observation)
          },
          error => { signal.removeEventListener('abort', expired); reject(error) },
        ).catch(() => undefined)
      })
      try {
        if (!this.tracked.has(id) || this.abort.signal.aborted) return
        const seen = this.now().toISOString()
        if (result.header && result.header.id !== id) { this.mark(sample, 'unconfirmed'); return }
        const rows = result.events.filter(event => event.seq >= (result.inheritedEventCount ?? 0))
          .map(event => project(event, seen, 'history')).filter(row => row !== undefined)
        if (!rows.some(descriptor)) { this.mark(sample, 'unconfirmed'); return }
        sample.confirmed = true
        // Pending live observations preserve the original receipt time for a source sequence.
        this.ingest(id, sample, [...sample.pending.values(), ...rows], seen)
        sample.pending.clear()
        this.mark(sample, 'available')
      } finally {
        result[Symbol.dispose]()
      }
    } catch {
      this.mark(sample, 'unreadable')
    }
  }

  private mark(sample: Sample, state: ReadState) {
    if (sample.readState !== state) { sample.version++; this.version++ }
    sample.readState = state
  }

  private addFact(sample: Sample, row: NativeFact): boolean {
    if (sample.facts.has(row.seq)) return false
    sample.facts.set(row.seq, row)
    if (!sample.lastObservedAt || row.observedAt > sample.lastObservedAt) sample.lastObservedAt = row.observedAt
    return true
  }

  private ingest(id: string, sample: Sample, rows: readonly NativeFact[], checkedAt?: string) {
    const additions: LogEntry[] = []
    for (const row of rows) {
      if (!this.addFact(sample, row)) continue
      additions.push({ scope: this.scope, sessionId: id, row })
    }
    if (additions.length) {
      sample.sorted = undefined
      sample.version++
      this.version++
    }
    if (checkedAt && (!sample.lastReadAt || additions.length > 0)) additions.push({ scope: this.scope, sessionId: id, checkedAt })
    if (checkedAt) sample.lastReadAt = checkedAt
    if (!this.options.storage || !additions.length) return
    try {
      mkdirSync(dirname(this.options.storage), { recursive: true, mode: 0o700 })
      // A leading newline makes the next batch recoverable if a prior process died mid-write.
      appendFileSync(this.options.storage, '\n' + additions.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 })
    } catch {
      this.failStorage()
    }
  }

  private load() {
    if (!this.options.storage) return
    let log: string
    try { log = readFileSync(this.options.storage, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.failStorage()
      return
    }
    for (const line of log.split('\n')) {
      if (!line) continue
      try {
        const entry = object(JSON.parse(line)), id = token(entry.sessionId)
        if (entry.scope !== this.scope || !id) continue
        const sample = this.sample(id), row = savedFact(entry.row), checkedAt = iso(entry.checkedAt)
        if (row) this.addFact(sample, row)
        if (checkedAt && (!sample.lastReadAt || checkedAt > sample.lastReadAt)) sample.lastReadAt = checkedAt
        if (row && descriptor(row)) sample.confirmed = true
      } catch {
        this.failStorage()
      }
    }
  }

  private failStorage() {
    if (!this.storageFailed) this.options.log?.('SuperHub 原生轨迹存储部分不可读写')
    this.storageFailed = true
  }
}
