import { execFile, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { BrainRepo } from '../src/dsh/brain.ts'
import { GROUP_MIGRATION_FOLDER, PRIVATE_OPS, privateBrainData } from '../src/dsh/brain-private.ts'
import { acquireLock } from '../src/dsh/lock.ts'
import { workspaceFingerprint } from '../src/dsh/superhub-goals.ts'
import { applyGroupChatMigration, formatMigrationManifest, manifestId, MIGRATION_DIR, planGroupChatMigration, readMigrationSnapshot,
  sessionRecordsDir, type GroupChatMigrationManifest } from '../src/dsh/workspace-group-migration.ts'
import { dialogueKey, groupLeadId } from '../src/dsh/workspace-speaker-id.ts'
import { readBrainFile } from '../src/dsh/view.ts'
import { WorkspaceV2Store, workspaceBoardFile, workspaceScope } from '../src/dsh/workspace-v2-store.ts'

const at = '2026-11-24T03:00:00.000Z'
const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, {recursive: true, force: true}) })

const W1 = '11111111-1111-4111-8111-111111111111', W2 = '22222222-2222-4222-8222-222222222222'
/** Old group (temporary lead) with one order, old Codex coding session with one order, old Claude session, roster group. */
const G1 = 'aaaaaaaa-0000-4000-8000-000000000001', C1 = 'aaaaaaaa-0000-4000-8000-000000000002'
const C2 = 'aaaaaaaa-0000-4000-8000-000000000003', R1 = 'aaaaaaaa-0000-4000-8000-000000000004'
const O1 = 'bbbbbbbb-0000-4000-8000-000000000001', O2 = 'bbbbbbbb-0000-4000-8000-000000000002', O3 = 'bbbbbbbb-0000-4000-8000-000000000003'
const TEAMMATE = '79d4a526-1827-49b3-8f81-12d25d3bb0e6'
const THREAD = '01a2077b-22a9-7b80-a275-0edf0517e03f', THREAD_GONE = '01a20732-666e-79d0-a51b-9d975419ff02'
const CLAUDE = '5c1e9c7e-1111-4222-8333-444455556666'

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'chief-group-migration-'))
  roots.push(base)
  const root = join(base, 'brain'), dshHome = join(base, 'dsh'), codexHome = join(base, 'codex'), claudeDir = join(base, 'claude')
  const write = (path: string, value: string | object) => {
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const brain = (...parts: string[]) => join(root, ...parts)
  mkdirSync(brain('ops'), {recursive: true})
  const scope = workspaceScope(root)
  const session = (id: string, workspaceId: string, kind: string, executor: string, orders: string[], extra = {}) =>
    ({id, workspaceId, title: '会话 ' + id.slice(-1), kind, executor, delegationIds: orders, closed: false, createdAt: at, ...extra})
  const order = (id: string, workspaceId: string, sessionId: string, status = 'done') =>
    ({id, workspaceId, sessionId, title: '工单 ' + id.slice(-1), owner: '我', promise: '交付', boundary: '范围', status, generation: 1, remainingTurns: 3, createdAt: at})
  const board = {
    schema: 2, personalWorkspaceId: W2,
    workspaces: [{id: W1, name: '方舟评测', goal: '', owner: '我', createdAt: at, icon: 'a'}, {id: W2, name: '我的交办', goal: '', owner: '我', createdAt: at, icon: 'b'}],
    sessions: [session(G1, W1, 'group', 'dsh', [O1]), session(C1, W1, 'coding', 'codex', [O2]), session(C2, W2, 'coding', 'claude-code', []),
      session(R1, W2, 'group', 'dsh', [O3], {engine: 'roster'})],
    delegations: [order(O1, W1, G1, 'waiting'), order(O2, W1, C1), {...order(O3, W2, R1), historySessionIds: [C2]}],
    decisions: [{id: 'd1', workspaceId: W1, delegationId: O2, text: '边界', version: 1, at}, {id: 'd3', workspaceId: W2, delegationId: O3, text: '边界', version: 1, at}],
    receipts: {
      'req-make-g1': {kind: 'mutation', hash: 'h', result: {session: session(G1, W1, 'group', 'dsh', [O1])}},
      'req-make-o2': {kind: 'mutation', hash: 'h', result: {delegation: order(O2, W1, C1), session: session(C1, W1, 'coding', 'codex', [O2])}},
      'req-make-ws': {kind: 'mutation', hash: 'h', result: {workspace: {id: W1}}},
      'req-make-r1': {kind: 'mutation', hash: 'h', result: {session: session(R1, W2, 'group', 'dsh', [O3])}},
      'req-turn-g1': {kind: 'turn', hash: 'h', sessionId: G1, state: 'sent', reserved: [{id: O1, generation: 1}], at},
      'req-turn-c1': {kind: 'turn', hash: 'h', sessionId: C1, state: 'sent', reserved: [{id: O2, generation: 1}], at},
      'req-accept-c1': {kind: 'turn', hash: 'h', sessionId: C1, state: 'sent', reserved: [{id: O2, generation: 1}], at},
      'req-words-c1': {kind: 'interject', hash: 'h', sessionId: C1, workOrderId: O2, generation: 1, text: '补充', at, state: 'steered'},
      'req-say-r1': {kind: 'group-say', hash: 'h', sessionId: R1, at},
      'req-read': {kind: 'notice-read', hash: 'h'},
      'req-report': {kind: 'followup', hash: 'h', reportId: 'report-o2'},
    },
    acceptances: {
      'turn-c1': {workspaceId: W1, sessionId: C1, orderId: O2, generation: 1, at, state: 'done', followUp: 'accept-c1'},
      'turn-r1': {workspaceId: W2, sessionId: R1, orderId: O3, generation: 1, at, state: 'done'},
    },
    liaisonTurns: {'accept-c1': {handoff: '请补齐'}, 'turn-c1': {}, 'keep-r1': {}},
    resultNotices: {['n'.repeat(40)]: {id: 'n'.repeat(40), workspaceId: W1, orderId: O2, sessionId: C1, title: '交付', at, read: true},
      ['m'.repeat(40)]: {id: 'm'.repeat(40), workspaceId: W2, orderId: O3, sessionId: R1, title: '群交付', at}},
    commands: {'cmd-c1': {workspaceId: W1, sessionId: C1, orderId: O2, generation: 1, text: '收单', hash: 'h', at, judged: 'complete', outcome: 'completed'}},
    starts: [{workspaceId: W1, sessionId: G1, delegationId: O1, generation: 1, requestId: 'queued-g1', text: '继续'}],
    groupStarts: [{kind: 'assign', requestId: 'start-r1', workspaceId: W2, sessionId: R1, orderId: O3, handoff: '交给群'}],
    followups: {[O2]: {reports: [{id: 'report-o2'}]}, [O3]: {reports: []}},
    originals: {[O2]: {text: '原话'}, [O3]: {text: '群原话'}},
    portraits: {[G1]: {}, [C1]: {}, [R1]: {}},
    directoryChanges: [{workspaceId: W1, at, to: '/home/me/projects/arklab'}],
    retiredOrders: {orders: [{id: 'T-0007', legacyTicketId: 'T-0007', workspaceId: W1, sessionId: 'native-7', title: '旧原生工单', status: 'done'}],
      sessions: [{id: 'native-7', workspaceId: W1, title: '旧原生工单', kind: 'group', executor: 'dsh', delegationIds: ['T-0007'], closed: false, createdAt: at}]},
  }
  write(brain(workspaceBoardFile(scope)), JSON.stringify(board) + '\n')
  const records = (ws: string, id: string) => brain(sessionRecordsDir(scope, ws, id))
  const work = (ws: string, id: string) => { const area = dialogueKey(scope, ws); return brain('work', 'superhub-v2', area, dialogueKey(area, id)) }
  const lead = groupLeadId(scope, W1, G1)
  write(join(records(W1, G1), 'source.json'), {messages: [{id: 'm1'}, {id: 'm2'}], attachments: [], turns: [{id: 't1'}],
    members: [{id: lead, name: 'lead'}, {id: TEAMMATE, name: 'endpoint-check'}]})
  write(join(records(W1, C1), 'source.json'), {messages: [{id: 'm1'}], attachments: [{id: 'a1'}], turns: [{id: 't1', nativeSessionId: THREAD_GONE}, {id: 't2', resumed: THREAD_GONE, nativeSessionId: THREAD}],
    members: [], native: {['work/x']: {tool: 'codex', sessionId: THREAD, at}}})
  write(join(records(W1, C1), 'commands.jsonl'), '{"kind":"command"}\n{"kind":"gate"}\n')
  write(join(records(W2, C2), 'source.json'), {messages: [], attachments: [], turns: [{id: 't1', nativeSessionId: CLAUDE}], members: []})
  write(join(records(W2, R1), 'ledger.jsonl'), '{"seq":1}\n')
  write(join(records(W2, R1), 'members.json'), '{}')
  write(join(work(W1, G1), 'notes.md'), '群里的交付')
  mkdirSync(join(work(W1, G1), '.git'), {recursive: true})
  write(join(work(W1, C1), '方舟作业.md'), '编程交付')
  write(join(work(W2, R1), 'group.md'), '新群交付')
  write(brain('ops', 'outbox.json'), JSON.stringify([
    {key: 'workspace-acceptance:' + O2 + ':turn-c1', at, text: '验收', order: {workspaceId: W1, orderId: O2}, push: 'local', attempts: 0},
    {key: 'workspace-approval:' + G1 + ':x', at, text: '审批', push: 'local', attempts: 0},
    {key: 'workspace-done:' + O3 + ':turn-r1', at, text: '群完成', order: {workspaceId: W2, orderId: O3}, push: 'local', attempts: 0},
    {key: 'morning:2026-11-24', at, text: '早上好', push: 'local', attempts: 0},
    {key: 'need:T-0007:you/review:0', ticketId: 'T-0007', at, text: '旧审批', push: 'local', attempts: 0},
    {key: 'result:T-0007:as-T-0007', ticketId: 'T-0007', kind: 'result', at, text: '旧结果', push: 'local', attempts: 0},
    {key: 'need:T-0003:you/review:0', ticketId: 'T-0003', at, text: '保留的审批', push: 'local', attempts: 0},
  ], null, 1) + '\n')
  // Native tickets: T-0007 is retired (deleted with everything tied to it), T-0003 is not (kept, as are events it shares).
  const ticket = (id: string, events: string[], extra = {}) => ({id, title: '原生 ' + id, staff: 'engineer', priority: 1, createdAt: at,
    mandate: {eventId: events[0], strength: 'explicit', level: 'think', scope: '范围', doneWhen: [], needsReview: false}, events, inputs: [],
    assignments: [{id: 'as-' + id, state: 'reported', attempts: [{status: 'completed'}]}], ended: {at, outcome: 'done', note: '完成'}, ...extra})
  write(brain('ops', 'tickets', 'T-0007.json'), ticket('T-0007', ['ev-7', 'ev-7b', 'ev-shared']))
  write(brain('ops', 'tickets', 'T-0003.json'), ticket('T-0003', ['ev-3', 'ev-shared']))
  write(brain('ops', 'events', '2026-11.jsonl'), [
    {id: 'ev-7', at, source: 'inbox', dedupe: 'd-7', text: '旧交办原话'},
    {id: 'ev-7b', at, source: 'room', dedupe: 'd-7b', text: '讨论里的交办', meta: {room_id: 'room-a', room_source: 'src-1'}},
    {id: 'ev-3', at, source: 'inbox', dedupe: 'd-3', text: '保留的原话'},
    {id: 'ev-shared', at, source: 'inbox', dedupe: 'd-s', text: '两张单共用'},
    {id: 'ev-x', at, source: 'inbox', dedupe: 'd-x', text: '无关'},
  ].map(row => JSON.stringify(row)).join('\n') + '\n{torn line\n')
  write(brain('ops', 'dispositions.jsonl'), [
    {eventId: 'ev-7', disposition: {kind: 'accepted', ticketId: 'T-0007'}, at},
    {eventId: 'ev-3', disposition: {kind: 'accepted', ticketId: 'T-0003'}, at},
    {eventId: 'ev-x', disposition: {kind: 'ignored', reason: '无需开单'}, at},
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  const room = {id: 'room-a', title: '讨论', session: 's', notes: [], tickets: ['T-0007', 'T-0003'], ownerActions: [{kind: 'execute', source: 'src-1'}, {kind: 'execute', source: 'src-2'}]}
  write(brain('ops', 'room-index.json'), [room])
  write(brain('ops', 'rooms', 'room-a.json'), room)
  write(brain('ops', 'ticket-sequence.json'), '5\n')
  write(brain('work', 'T-0007', 'answer.md'), '原生交付')
  write(brain('work', 'T-0003', 'keep.md'), '保留的原生交付')
  write(brain('ops', 'delivery-versions', 'T-0007', 'v1.json'), {content: '原生交付'})
  write(brain('ops', 'superhub-staff', workspaceFingerprint(scope) + '.json'), {members: [{id: 'engineer', memberships: [{workspaceId: W1}]}]})
  write(brain('ops', 'superhub-history-' + workspaceFingerprint(scope), 'index.json'), {schema: 2, entries: {}})
  write(brain('ops', 'profile-imports', 'import.json'), {})
  // DSH home: lead + teammate of the old group, an unrelated session in the same folder, another session elsewhere.
  const groupFolder = join(dshHome, 'sessions', '--group-dir--')
  for (const id of [lead, TEAMMATE, 'owner-own-session']) write(join(groupFolder, id, 'session.v4.jsonl.zstd'), 'x')
  write(join(dshHome, 'sessions', '--brain--', 'chief-liaison-1', 'session.v4.jsonl.zstd'), 'x')
  for (const id of [lead, TEAMMATE, 'chief-liaison-1']) write(join(dshHome, 'storages', 'session_projcache', 'sessions', id + '.json'), '{}')
  // The ticket desk of T-0007 and the subagent it started work in work/T-0007; a stranger in the same folder does not.
  const dshLog = (id: string, cwd: string, parent?: string) => zstdCompressSync(Buffer.from(JSON.stringify({type: 'session', version: 4, id, cwd, ...(parent && {parentSession: parent})}) + '\n{"type":"x"}\n'))
  const deskFolder = join(dshHome, 'sessions', '--brain-work-T-0007--')
  write(join(deskFolder, 'chief-desk-1', 'session.v4.jsonl.zstd'), '')
  writeFileSync(join(deskFolder, 'chief-desk-1', 'session.v4.jsonl.zstd'), dshLog('chief-desk-1', join(root, 'work', 'T-0007'), 'chief-liaison-1'))
  write(join(deskFolder, 'child-1', 'session.v4.jsonl.zstd'), '')
  writeFileSync(join(deskFolder, 'child-1', 'session.v4.jsonl.zstd'), dshLog('child-1', join(root, 'work', 'T-0007'), 'chief-desk-1'))
  write(join(deskFolder, 'stranger', 'session.v4.jsonl.zstd'), '')
  writeFileSync(join(deskFolder, 'stranger', 'session.v4.jsonl.zstd'), dshLog('stranger', join(root, 'work')))
  write(join(dshHome, 'storages', 'session_projcache', 'sessions', 'chief-desk-1.json'), '{}')
  write(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({unit: {name: 'workspace', version: 2},
    global: {initialized: true, workspaceIds: ['dw-brain', 'dw-group', 'dw-t7'], archivedSessionIds: [TEAMMATE], pinnedSessionIds: []},
    tables: {workspaces: {'dw-brain': {path: root, sessionIds: ['chief-liaison-1']}, 'dw-group': {path: work(W1, G1), sessionIds: [lead]},
      'dw-t7': {path: join(root, 'work', 'T-0007'), sessionIds: ['chief-desk-1']}}}}, null, 2) + '\n')
  write(join(codexHome, 'sessions', '2026', '11', '23', 'rollout-2026-11-23T16-17-21-' + THREAD + '.jsonl'), '{}')
  write(join(codexHome, 'sessions', '2026', '11', '23', 'rollout-2026-11-23T16-17-21-01a2077b-0000-7b80-a275-0edf0517e03f.jsonl'), '{}')
  write(join(claudeDir, 'projects', '-home-me-projects-x', CLAUDE + '.jsonl'), '{}')
  write(join(claudeDir, 'projects', '-home-me-projects-x', CLAUDE, 'tool-results', 'a.txt'), 'x')
  write(join(claudeDir, 'projects', '-home-me-projects-x', 'owner-session.jsonl'), '{}')
  const homes = {dshHome, codexHome, claudeDir}
  const deleted: string[] = []
  const deleteCodexThread = async (id: string) => {
    deleted.push(id)
    if (id !== THREAD) throw new Error('thread not found')
    for (const file of readdirSync(join(codexHome, 'sessions', '2026', '11', '23'))) if (file.endsWith(id + '.jsonl')) rmSync(join(codexHome, 'sessions', '2026', '11', '23', file))
  }
  return {base, root, scope, brain, records, work, lead, homes, dshHome, codexHome, claudeDir, write, deleted, deleteCodexThread,
    read: (path: string) => readFileSync(path, 'utf8'), json: <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T}
}
type Fixture = ReturnType<typeof fixture>
const plan = (f: Fixture) => planGroupChatMigration(readMigrationSnapshot(f.root, f.homes))
/** Everything the migration may change, to prove a refused run changed nothing. */
function state(f: Fixture) {
  const walk = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, {withFileTypes: true}).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)).map(path => entry.name + '/' + path) : [entry.name + ':' + readFileSync(join(dir, entry.name), 'utf8')])
  return walk(f.base).filter(row => !row.includes('.chief.lock')).sort()
}

describe('workspace group chat migration (D3)', () => {
  it('plans exactly the old sessions with their orders, records and native sessions, and lists what stays', () => {
    const f = fixture()
    const manifest = plan(f)
    expect(manifest.sessionIds).toEqual([G1, C1, C2].sort())
    expect(manifest.orderIds).toEqual([O1, O2].sort())
    expect(manifest.blockers).toEqual([])
    const ark = manifest.workspaces.find(space => space.id === W1)!
    expect(ark.name).toBe('方舟评测')
    const group = ark.sessions.find(row => row.id === G1)!
    expect(group.orders).toEqual([{id: O1, title: '工单 1', status: 'waiting'}])
    expect(group.dsh.map(row => [row.id, row.label, row.found])).toEqual([[f.lead, '讨论接口人', true], [TEAMMATE, 'endpoint-check', true]])
    expect(group.dialogue).toMatchObject({exists: true, messages: 2, turns: 1})
    expect(group.workDirs.map(dir => dir.files)).toEqual([1])
    expect(group.board).toMatchObject({sessions: 1, delegations: 1, receipts: 2, starts: 1, portraits: 1})
    expect(group.outbox).toEqual(['workspace-approval:' + G1 + ':x'])
    const coding = ark.sessions.find(row => row.id === C1)!
    expect(coding.codex.map(row => [row.id, row.found])).toEqual([[THREAD_GONE, false], [THREAD, true]])
    expect(coding.dialogue.commandLines).toBe(2)
    expect(coding.board).toMatchObject({receipts: 5, acceptances: 1, liaisonTurns: 2, resultNotices: 1, commands: 1, decisions: 1, followups: 1, originals: 1})
    expect(coding.outbox).toEqual(['workspace-acceptance:' + O2 + ':turn-c1'])
    const mine = manifest.workspaces.find(space => space.id === W2)!
    expect(mine.sessions.map(row => row.id)).toEqual([C2])
    expect(mine.sessions[0]!.claude.map(row => [row.id, row.found])).toEqual([[CLAUDE, true]])
    expect(mine.kept).toEqual([{id: R1, title: '会话 4'}])
    expect(manifest.dshIndex).toEqual({sessions: 2, workspaces: [{id: 'dw-group', path: f.work(W1, G1)}, {id: 'dw-t7', path: join(f.root, 'work', 'T-0007')}]})
    expect(manifest.kept.workspaces.map(row => row.name)).toEqual(['方舟评测', '我的交办'])
    expect(manifest.kept.rosterSessions).toBe(1)
    expect(manifest.kept.workDirs).toHaveLength(3)
    expect(manifest.totals).toMatchObject({sessions: 3, orders: 2, outbox: 2, dialogueDirs: 3, dsh: 2, codex: 2, claude: 1,
      tickets: 1, ticketBoardRows: 2, ticketOutbox: 2, ticketEvents: 2, ticketDirs: 2, ticketDirFiles: 2, desks: 2})
    // The retired native ticket: its records, directories and desk sessions; the kept ticket and shared event stay.
    expect(manifest.tickets.ids).toEqual(['T-0007'])
    expect(manifest.tickets.rows[0]).toMatchObject({id: 'T-0007', title: '原生 T-0007', ended: true, file: 'ops/tickets/T-0007.json', events: 2, board: 2,
      outbox: ['need:T-0007:you/review:0', 'result:T-0007:as-T-0007'],
      dirs: [{path: 'work/T-0007', files: 1}, {path: 'ops/delivery-versions/T-0007', files: 1}]})
    expect(manifest.tickets.rows[0]!.dsh.map(row => [row.id, row.label])).toEqual([['chief-desk-1', '工单桌'], ['child-1', '执行子会话']])
    expect(manifest.tickets.events).toEqual([['ev-7', 'T-0007'], ['ev-7b', 'T-0007']])
    expect([...manifest.tickets.references].sort()).toEqual(['ops/dispositions.jsonl', 'ops/events/2026-11.jsonl', 'ops/room-index.json', 'ops/rooms/room-a.json', 'ops/ticket-sequence.json'])
    expect(manifest.tickets.retiredSessionIds).toEqual(['native-7'])
    expect(manifest.kept.retiredOrders).toBe(0)
    expect(manifest.warnings.join('\n')).toContain('T-0003')
    expect(manifest.steps.filter(step => step.kind === 'dialogue-dir').map(step => 'path' in step && step.path).sort())
      .toEqual([f.records(W1, G1), f.records(W1, C1), f.records(W2, C2)].map(path => path.slice(f.root.length + 1)).sort())
    expect(manifest.warnings.join('\n')).toContain('尚未结束')
    expect(manifest.warnings.join('\n')).toContain('owner-own-session')
    // Deterministic: the same data gives the same manifest and id; the id covers exactly what is deleted.
    expect(plan(f)).toEqual(manifest)
    expect(manifestId(manifest)).toBe(manifest.id)
    const text = formatMigrationManifest(manifest)
    expect(text).toContain('工作区「方舟评测」')
    expect(text).toContain('群聊（旧机制：临时 Lead）「会话 1」')
    expect(text).toContain('编程会话（Codex）')
    expect(text).toContain('交付目录（保留）')
    expect(text).toContain(manifest.id)
    expect(text).toContain('T-0007「原生 T-0007」')
    expect(text).toContain('下一次自动提交')
    // Without the native homes the natives are listed as unchecked; the desk sessions are then not listed at all.
    const bare = planGroupChatMigration(readMigrationSnapshot(f.root))
    expect(bare.sessionIds).toEqual(manifest.sessionIds)
    expect(bare.workspaces[0]!.sessions[0]!.dsh[0]!.found).toBeNull()
    expect(bare.tickets.rows[0]!.dsh).toEqual([])
    expect(bare.warnings.join('\n')).toContain('工单桌会话未列出')
  })

  it('works on a copy of the brain with --scope naming the original', () => {
    const f = fixture()
    const copy = join(f.base, 'copy')
    cpSync(f.root, copy, {recursive: true})
    const own = planGroupChatMigration(readMigrationSnapshot(copy, f.homes))
    expect(own.sessionIds).toEqual([])
    expect(own.blockers.join('')).toContain('--scope')
    const scoped = planGroupChatMigration(readMigrationSnapshot(copy, {...f.homes, scope: f.root}))
    expect(scoped.id).toBe(plan(f).id)
    expect(scoped.dshIndex?.workspaces).toHaveLength(2)
    expect(scoped.tickets.rows[0]!.dsh).toHaveLength(2)
  })

  it('applies: deletes the old sessions and their traces, keeps work files, workspaces, staff, history and the roster group', async () => {
    const f = fixture()
    const manifest = plan(f)
    const report = await applyGroupChatMigration(f.root, {...f.homes, expect: manifest.id, deleteCodexThread: f.deleteCodexThread, now: () => new Date(at)})
    expect(report.failures).toEqual([])
    expect(report.complete).toBe(true)
    // Board: only the roster group and its order remain; detached from deleted sessions.
    const board = f.json<Record<string, any>>(f.brain(workspaceBoardFile(f.scope)))
    expect(board.sessions.map((row: {id: string}) => row.id)).toEqual([R1])
    expect(board.delegations.map((row: {id: string}) => row.id)).toEqual([O3])
    expect(board.delegations[0].historySessionIds).toBeUndefined()
    expect(Object.keys(board.receipts).sort()).toEqual(['req-make-r1', 'req-make-ws', 'req-read', 'req-say-r1'])
    expect(Object.keys(board.acceptances)).toEqual(['turn-r1'])
    expect(Object.keys(board.liaisonTurns)).toEqual(['keep-r1'])
    expect(Object.keys(board.resultNotices)).toEqual(['m'.repeat(40)])
    expect(board.commands).toEqual({})
    expect(board.starts).toEqual([])
    expect(board.groupStarts).toHaveLength(1)
    expect(Object.keys(board.followups)).toEqual([O3])
    expect(Object.keys(board.originals)).toEqual([O3])
    expect(Object.keys(board.portraits)).toEqual([R1])
    expect(board.decisions.map((row: {id: string}) => row.id)).toEqual(['d3'])
    expect(board.workspaces).toHaveLength(2)
    expect(board.directoryChanges).toHaveLength(1)
    expect(board.migratedGroupChat).toEqual({manifestId: manifest.id, at})
    // The store still opens the board.
    const store = new WorkspaceV2Store(f.root, f.scope)
    expect(store.view(W1).sessions).toEqual([])
    expect(store.view(W2).sessions.map(row => row.id)).toEqual([R1])
    store.dispose()
    expect(f.json<{key: string}[]>(f.brain('ops', 'outbox.json')).map(row => row.key)).toEqual(['workspace-done:' + O3 + ':turn-r1', 'morning:2026-11-24', 'need:T-0003:you/review:0'])
    // Records of the old sessions are gone; the roster group's stay.
    for (const [ws, id] of [[W1, G1], [W1, C1], [W2, C2]] as const) expect(existsSync(f.records(ws, id))).toBe(false)
    expect(readdirSync(f.records(W2, R1)).sort()).toEqual(['ledger.jsonl', 'members.json'])
    // Delivered files, staff, history and imports stay.
    expect(f.read(join(f.work(W1, G1), 'notes.md'))).toBe('群里的交付')
    expect(f.read(join(f.work(W1, C1), '方舟作业.md'))).toBe('编程交付')
    expect(f.read(join(f.work(W2, R1), 'group.md'))).toBe('新群交付')
    expect(existsSync(f.brain('ops', 'superhub-staff', workspaceFingerprint(f.scope) + '.json'))).toBe(true)
    expect(existsSync(f.brain('ops', 'superhub-history-' + workspaceFingerprint(f.scope), 'index.json'))).toBe(true)
    expect(existsSync(f.brain('ops', 'profile-imports', 'import.json'))).toBe(true)
    // Natives: only the listed ids.
    const folder = join(f.dshHome, 'sessions', '--group-dir--')
    expect(readdirSync(folder)).toEqual(['owner-own-session'])
    expect(existsSync(join(f.dshHome, 'sessions', '--brain--', 'chief-liaison-1'))).toBe(true)
    expect(readdirSync(join(f.dshHome, 'storages', 'session_projcache', 'sessions'))).toEqual(['chief-liaison-1.json'])
    expect(f.deleted).not.toContain('stranger')
    const index = f.json<any>(join(f.dshHome, 'storages', 'workspace.json'))
    expect(index.global).toEqual({initialized: true, workspaceIds: ['dw-brain'], archivedSessionIds: [], pinnedSessionIds: []})
    expect(Object.keys(index.tables.workspaces)).toEqual(['dw-brain'])
    expect(f.deleted.sort()).toEqual([THREAD_GONE, THREAD].sort())
    expect(readdirSync(join(f.codexHome, 'sessions', '2026', '11', '23'))).toEqual(['rollout-2026-11-23T16-17-21-01a2077b-0000-7b80-a275-0edf0517e03f.jsonl'])
    expect(readdirSync(join(f.claudeDir, 'projects', '-home-me-projects-x'))).toEqual(['owner-session.jsonl'])
    // One log line per item, a done marker, no pending pointer.
    const log = f.read(f.brain(report.log)).trim().split('\n').map(line => JSON.parse(line) as {kind: string; outcome: string})
    expect(log).toHaveLength(manifest.steps.length)
    expect(log.find(row => row.kind === 'codex-thread' && 'id' in row && row.id === THREAD_GONE)?.outcome).toBe('absent')
    expect(f.json<any>(f.brain(MIGRATION_DIR, 'state.json')).migratedGroupChat.manifestId).toBe(manifest.id)
    // The retired native ticket is gone with its records; the other ticket and what it shares stay.
    expect(board.retiredOrders).toBeUndefined()
    expect(readdirSync(f.brain('ops', 'tickets'))).toEqual(['T-0003.json'])
    expect(readdirSync(f.brain('work')).sort()).toEqual(['T-0003', 'superhub-v2'])
    expect(readdirSync(f.brain('ops', 'delivery-versions'))).toEqual([])
    const events = f.read(f.brain('ops', 'events', '2026-11.jsonl')).split('\n')
    expect(JSON.parse(events[0]!)).toEqual({id: 'ev-7', at, source: 'inbox', dedupe: 'd-7', text: '', meta: {retired_ticket: 'T-0007'}})
    expect(JSON.parse(events[1]!).text).toBe('')
    expect(events.slice(2, 5).map(line => JSON.parse(line).text)).toEqual(['保留的原话', '两张单共用', '无关'])
    expect(events[5]).toBe('{torn line')
    const dispositions = f.read(f.brain('ops', 'dispositions.jsonl')).trim().split('\n').map(line => JSON.parse(line) as {eventId: string; disposition: {kind: string}})
    expect(dispositions.map(row => row.eventId + ':' + row.disposition.kind)).toEqual(['ev-3:accepted', 'ev-x:ignored', 'ev-7:ignored', 'ev-7b:ignored'])
    for (const rooms of [f.json<any[]>(f.brain('ops', 'room-index.json'))[0], f.json<any>(f.brain('ops', 'rooms', 'room-a.json'))]) {
      expect(rooms.tickets).toEqual(['T-0003'])
      expect(rooms.ownerActions).toEqual([{kind: 'execute', source: 'src-1', answered: true}, {kind: 'execute', source: 'src-2'}])
    }
    expect(f.read(f.brain('ops', 'ticket-sequence.json'))).toBe('7\n')
    expect(f.json<{key: string}[]>(f.brain('ops', 'outbox.json')).map(row => row.key)).not.toContain('need:T-0007:you/review:0')
    expect(readdirSync(join(f.dshHome, 'sessions', '--brain-work-T-0007--'))).toEqual(['stranger'])
    expect(existsSync(join(f.dshHome, 'storages', 'session_projcache', 'sessions', 'chief-desk-1.json'))).toBe(false)
    expect(existsSync(f.brain(MIGRATION_DIR, 'pending'))).toBe(false)
  })

  it('is idempotent: a completed migration is not run again, and running it again deletes nothing new', async () => {
    const f = fixture()
    await applyGroupChatMigration(f.root, {...f.homes, deleteCodexThread: f.deleteCodexThread})
    const after = state(f)
    const again = await applyGroupChatMigration(f.root, {...f.homes, deleteCodexThread: f.deleteCodexThread})
    expect(again.already).toBe(true)
    expect(state(f)).toEqual(after)
    const forced = await applyGroupChatMigration(f.root, {...f.homes, deleteCodexThread: f.deleteCodexThread, again: true})
    expect(forced.manifest.sessionIds).toEqual([])
    expect(forced.results).toEqual([])
    expect(f.json<any>(f.brain(workspaceBoardFile(f.scope))).sessions.map((row: {id: string}) => row.id)).toEqual([R1])
  })

  it('resumes a run that failed part-way or crashed, with the saved manifest', async () => {
    const f = fixture()
    const manifest = plan(f)
    const failing = await applyGroupChatMigration(f.root, {...f.homes, deleteCodexThread: async () => { throw new Error('app-server 不可用') }})
    expect(failing.complete).toBe(false)
    expect(failing.failures.map(row => row.step)).toEqual([{kind: 'codex-thread', id: THREAD}])
    expect(f.read(f.brain(MIGRATION_DIR, 'pending')).trim()).toBe(manifest.id)
    // The board is already pruned: a fresh plan would be empty, the saved manifest is what continues.
    expect(plan(f).sessionIds).toEqual([])
    await expect(applyGroupChatMigration(f.root, {...f.homes, expect: plan(f).id, deleteCodexThread: f.deleteCodexThread})).rejects.toThrow('还没做完')
    const resumed = await applyGroupChatMigration(f.root, {...f.homes, deleteCodexThread: f.deleteCodexThread})
    expect(resumed.resumed).toBe(true)
    expect(resumed.complete).toBe(true)
    expect(resumed.manifest.id).toBe(manifest.id)
    expect(resumed.results.find(row => row.step.kind === 'board')?.outcome).toBe('unchanged')
    expect(resumed.results.find(row => row.step.kind === 'codex-thread' && row.step.id === THREAD)?.outcome).toBe('done')
    expect(f.read(f.brain(resumed.log)).trim().split('\n')).toHaveLength(manifest.steps.length * 2)

    // A crash right after the DSH sessions were removed.
    const g = fixture()
    await expect(applyGroupChatMigration(g.root, {...g.homes, deleteCodexThread: g.deleteCodexThread,
      checkpoint: row => { if (row.step.kind === 'dsh-index') throw new Error('进程被杀') }})).rejects.toThrow('进程被杀')
    expect(existsSync(g.records(W1, G1))).toBe(true)
    const finished = await applyGroupChatMigration(g.root, {...g.homes, deleteCodexThread: g.deleteCodexThread})
    expect(finished.resumed && finished.complete).toBe(true)
    expect(finished.results.filter(row => row.step.kind === 'dsh-session').map(row => row.outcome)).toEqual(['absent', 'absent', 'absent', 'absent'])
    expect(finished.results.find(row => row.step.kind === 'ticket-refs')?.outcome).toBe('unchanged')
    expect(existsSync(g.brain('work', 'T-0007'))).toBe(false)
    expect(existsSync(g.records(W1, G1))).toBe(false)
  })

  it('refuses paths outside the old sessions\' records directories and ids not in the manifest, changing nothing', async () => {
    const f = fixture()
    const manifest = plan(f)
    const before = state(f)
    const tamper = (change: (copy: GroupChatMigrationManifest) => void) => {
      const copy = structuredClone(manifest)
      change(copy)
      copy.id = manifestId(copy)
      return copy
    }
    const outside = tamper(copy => {
      const step = copy.steps.find(row => row.kind === 'dialogue-dir')!
      if (step.kind === 'dialogue-dir') step.path = join('work', 'superhub-v2', ...step.path.split('/').slice(2))
    })
    await expect(applyGroupChatMigration(f.root, {...f.homes, manifest: outside})).rejects.toThrow('ops/superhub-v2-dialogues')
    const parent = tamper(copy => {
      const step = copy.steps.find(row => row.kind === 'dialogue-dir')!
      if (step.kind === 'dialogue-dir') step.path = join('ops', 'superhub-v2-dialogues', '..', '..', 'work')
    })
    await expect(applyGroupChatMigration(f.root, {...f.homes, manifest: parent})).rejects.toThrow('ops/superhub-v2-dialogues')
    const roster = tamper(copy => {
      copy.steps.push({kind: 'dialogue-dir', path: sessionRecordsDir(f.scope, W2, R1), workspaceId: W2, sessionId: R1})
    })
    await expect(applyGroupChatMigration(f.root, {...f.homes, manifest: roster})).rejects.toThrow('ops/superhub-v2-dialogues')
    const keptTicket = tamper(copy => { copy.steps.push({kind: 'ticket-dir', path: 'work/T-0003'}) })
    await expect(applyGroupChatMigration(f.root, {...f.homes, manifest: keptTicket})).rejects.toThrow('工单目录')
    const staffFile = tamper(copy => { copy.steps.push({kind: 'ticket-refs', path: 'ops/superhub-staff/x.json'}) })
    await expect(applyGroupChatMigration(f.root, {...f.homes, manifest: staffFile})).rejects.toThrow('允许范围')
    const workTree = tamper(copy => { copy.steps.push({kind: 'ticket-dir', path: 'work'}) })
    await expect(applyGroupChatMigration(f.root, {...f.homes, manifest: workTree})).rejects.toThrow('工单目录')
    const native = tamper(copy => { copy.steps.push({kind: 'dsh-session', id: 'chief-liaison-1'}) })
    await expect(applyGroupChatMigration(f.root, {...f.homes, manifest: native})).rejects.toThrow('DSH 会话标识无效')
    const unsigned = structuredClone(manifest)
    unsigned.steps.push({kind: 'codex-thread', id: '01a2077b-0000-7b80-a275-0edf0517e03f'})
    await expect(applyGroupChatMigration(f.root, {...f.homes, manifest: unsigned})).rejects.toThrow('标识不符')
    expect(state(f)).toEqual(before)

    // A records directory replaced by a symlink to elsewhere is never followed.
    const g = fixture()
    const target = g.records(W1, C1)
    rmSync(target, {recursive: true})
    mkdirSync(join(g.base, 'elsewhere'))
    writeFileSync(join(g.base, 'elsewhere', 'keep.txt'), '别删')
    symlinkSync(join(g.base, 'elsewhere'), target)
    expect(planGroupChatMigration(readMigrationSnapshot(g.root, g.homes)).blockers.join('')).toContain('符号链接')
    await expect(applyGroupChatMigration(g.root, {...g.homes, deleteCodexThread: g.deleteCodexThread})).rejects.toThrow('符号链接')
    expect(g.read(join(g.base, 'elsewhere', 'keep.txt'))).toBe('别删')
    expect(existsSync(g.records(W1, G1))).toBe(true)
  })

  it('refuses while the brain is held by a running host or the live check objects', async () => {
    const f = fixture()
    const before = state(f)
    await expect(applyGroupChatMigration(f.root, {...f.homes, live: () => ['dsh-web 正在为这些会话跑回合']})).rejects.toThrow('现在不能执行')
    const unlock = acquireLock(f.root)
    try { await expect(applyGroupChatMigration(f.root, {...f.homes})).rejects.toThrow('已被进程') }
    finally { unlock() }
    expect(state(f)).toEqual(before)
  })

  it('CLI previews in Chinese by default and changes nothing', async () => {
    const f = fixture()
    const before = state(f)
    const {stdout} = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--no-warnings', join('scripts', 'group-chat-migration.mjs'),
      '--brain', f.root, '--dsh-home', f.dshHome, '--codex-home', f.codexHome, '--claude-dir', f.claudeDir], {cwd: join(__dirname, '..')})
    expect(stdout).toContain('只预览，没有改动任何文件')
    expect(stdout).toContain(plan(f).id)
    expect(stdout).toContain('工作区「方舟评测」')
    expect(state(f)).toEqual(before)
  })
})

describe('迁移记录只留在本机', () => {
  it('清单与逐项日志不经资料视图读出，也不进第二大脑的自动 Git 提交', async () => {
    expect(MIGRATION_DIR).toBe(join('ops', GROUP_MIGRATION_FOLDER))
    expect(PRIVATE_OPS).toContain(GROUP_MIGRATION_FOLDER)
    expect(privateBrainData(['ops', GROUP_MIGRATION_FOLDER, 'state.json'])).toBe(true)
    expect(privateBrainData(['ops', 'superhub-v2-dialogues'])).toBe(false)
    const root = mkdtempSync(join(tmpdir(), 'chief-group-migration-git-'))
    roots.push(root)
    const git = (...args: string[]) => execFileSync('git', args, {cwd: root, encoding: 'utf8'})
    git('init', '-q')
    git('config', 'user.name', 'test')
    git('config', 'user.email', 'test@example.invalid')
    mkdirSync(join(root, MIGRATION_DIR), {recursive: true})
    writeFileSync(join(root, MIGRATION_DIR, 'state.json'), '{"migratedGroupChat":{}}')
    writeFileSync(join(root, MIGRATION_DIR, 'log.jsonl'), '{"item":"session"}\n')
    writeFileSync(join(root, 'ops', 'other-state.json'), '{}')
    writeFileSync(join(root, 'me.md'), '# 关于我\n')
    const brain = new BrainRepo(root)
    expect(readBrainFile(brain, join(MIGRATION_DIR, 'state.json'))).toBeUndefined()
    brain.commit('保存', {all: true})
    await brain.flush()
    expect(git('ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n')).toEqual(['me.md', 'ops/other-state.json'])
  })
})
