/**
 * Disposable, authenticated human acceptance lab. Never points at the daily brain.
 * CHIEF_ACCEPTANCE_PACKAGE=/absolute/candidate.tgz node --experimental-transform-types scripts/superhub-human-study.mjs
 * Optional CHIEF_STUDY_BIND, CHIEF_STUDY_PORT, CHIEF_STUDY_ORIGIN, CHIEF_STUDY_DIR.
 * Read the private access-code.txt locally; no secrets are logged or included in results.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { acceptanceHost } from './acceptance-host.mjs'
import { seedHumanScenario } from './superhub-human-fixture.mjs'
import { createDeviceTrace } from './superhub-human-clock.mjs'

const scripts = dirname(fileURLToPath(import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const cookieName = 'chief_human_acceptance'
const safeText = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const fail = (status, message) => { throw Object.assign(Error(message), { status }) }
const finite = value => typeof value === 'number' && Number.isFinite(value)
const publicRun = run => run && ({ id: run.id, kind: run.kind, status: run.status, goalName: run.scenario.goalName,
  startPath: `/chief/m/#superhub?${new URLSearchParams({ scope: run.scenario.scope, page: run.kind === 'resume' ? 'review' : 'goals',
    id: run.kind === 'resume' ? run.resumeRecord.id : run.scenario.goalId })}`,
  startedAt: run.startedAt, finishedAt: run.finishedAt, elapsedMs: run.elapsedMs,
  structure: run.structure, recordId: run.savedRecord?.id, interrupted: run.interrupted,
  resumeTask: run.kind === 'resume' ? '找回这份复盘的目标、当时证据和第一步，打开正确证据后填写你准备如何继续。' : undefined })

async function body(req, limit = 65_536) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) fail(413, '内容过长')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, '请求格式有误')
    return value
  }
  catch { fail(400, '请求格式有误') }
}

export async function startHumanStudy(options = {}) {
  const candidate = resolve(options.candidate ?? process.env.CHIEF_ACCEPTANCE_PACKAGE ?? '')
  assert.ok(candidate.endsWith('.tgz') && existsSync(candidate), '必须明确指定已打包的隔离候选包')
  const bind = options.bind ?? process.env.CHIEF_STUDY_BIND ?? '127.0.0.1'
  const port = Number(options.port ?? process.env.CHIEF_STUDY_PORT ?? 50389)
  const publicOrigin = options.origin ?? process.env.CHIEF_STUDY_ORIGIN
  if (bind !== '127.0.0.1' && bind !== '::1') assert.ok(publicOrigin, '非本机监听必须明确指定 CHIEF_STUDY_ORIGIN')
  const directory = resolve(options.directory ?? process.env.CHIEF_STUDY_DIR ?? mkdtempSync(join(tmpdir(), 'superhub-human-')))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  assert.ok(!existsSync(join(directory, 'study-results.json')), '请为每次启动使用新的证据目录，避免覆盖已有参与者结果')
  const accessCode = randomBytes(15).toString('base64url')
  writeFileSync(join(directory, 'access-code.txt'), accessCode + '\n', { mode: 0o600 })
  const report = { schema: 1, startedAt: new Date().toISOString(), candidateSha256: sha(readFileSync(candidate)),
    provenance: 'packaged app; disposable DSH/brain; deterministic execution fixture; actual participant data only after browser interaction',
    humanClaims: 'Device type and familiarity are participant declarations; the facilitator must confirm physical devices and grade free text.',
    participants: [], runs: [], clockPairs: [], clockSamples: [], notes: [], humanPasses: 0 }
  const reportPath = join(directory, 'study-results.json')
  const persist = () => {
    const temp = reportPath + '.tmp'
    writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, reportPath)
  }
  persist()
  const host = await acceptanceHost({ candidate, probe: 'superhub-vertical-probe.mjs', extraEnv: { CHIEF_ACCEPTANCE_HUMAN: '1' } })
  try { await host.start() } catch (error) { await host.stop(); throw error }
  report.host = { work: host.work, brain: host.brain, scope: (await host.api('/state')).superhubScope }
  const staticRoot = join(host.home, 'profiles/web/node_modules/dsh-chief/lib/mobile')
  assert.ok(existsSync(join(staticRoot, 'app.js')))
  const sessions = new Map(), failures = new Map(), traces = new Map(), starts = new Map()
  let preparing = false, scenarioIndex = 0
  const security = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'" }
  const send = (res, status, value, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, { ...security, 'content-type': type, ...extra })
    res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  }
  const current = session => report.runs.find(row => row.id === session.runId)
  const saveRun = (session, update) => { const run = current(session); if (!run) fail(409, '请先准备测试'); Object.assign(run, update); persist(); return run }
  const knownClient = (session, data) => {
    if (typeof data.documentId !== 'string' || data.documentId !== session.documentId) fail(409, '测试页面已刷新，请重新准备一次测试')
  }
  const origins = new Set([publicOrigin, `http://127.0.0.1:${port}`, `http://localhost:${port}`].filter(Boolean))
  const server = createServer(async (req, res) => {
    const receivedWall = Date.now()
    const receivedMonotonic = performance.now()
    try {
      const url = new URL(req.url, `http://${req.headers.host}`)
      const path = url.pathname
      if (req.method !== 'GET' && req.method !== 'POST') fail(405, '不支持此操作')
      if (req.method === 'POST') {
        if (!origins.has(req.headers.origin)) fail(403, '请从测试入口提交')
        if (path.startsWith('/study/') && req.headers['x-study-request'] !== '1') fail(403, '缺少请求标记')
        if (path.startsWith('/chief/') && req.headers['x-chief-request'] !== '1') fail(403, '缺少请求标记')
      }
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ready: true })
      if (req.method === 'GET' && (path === '/' || path === '/study-client.js')) return send(res, 200,
        readFileSync(join(scripts, path === '/' ? 'superhub-human-study.html' : 'superhub-human-client.js')),
        path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8')
      if (req.method === 'POST' && path === '/study/login') {
        const ip = req.socket.remoteAddress
        const failed = (failures.get(ip) ?? []).filter(at => Date.now() - at < 900_000)
        if (failed.length >= 10) fail(429, '尝试过多，请稍后再试')
        const value = await body(req, 4096)
        const supplied = Buffer.from(sha(safeText(value.code, 100)))
        if (!timingSafeEqual(supplied, Buffer.from(sha(accessCode)))) { failed.push(Date.now()); failures.set(ip, failed); fail(401, '访问口令不正确') }
        const token = randomBytes(32).toString('base64url')
        sessions.set(sha(token), {})
        return send(res, 200, { ok: true }, undefined, { 'set-cookie': `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${publicOrigin?.startsWith('https:') ? '; Secure' : ''}` })
      }
      const token = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
      const session = token && sessions.get(sha(token))
      if (!session) fail(401, '请先填写测试访问口令')
      if (req.method === 'GET' && path === '/study/status') return send(res, 200, {
        registered: !!session.participantId, participantId: session.participantId, run: publicRun(current(session)),
        preparing, deviceId: session.deviceId,
      })
      if (req.method === 'POST' && path === '/study/register') {
        const value = await body(req, 8192)
        if (!['desktop', 'phone'].includes(value.device) || !['new', 'familiar'].includes(value.experience)
          || !/^[A-Za-z0-9_-]{1,24}$/.test(value.participantCode)
          || !/^[a-zA-Z0-9-]{16,60}$/.test(value.deviceId) || !/^[a-zA-Z0-9-]{16,60}$/.test(value.documentId)) fail(400, '请完整填写设备和使用经验')
        const old = current(session)
        if (old && ['ready', 'running', 'saved'].includes(old.status)) { old.status = 'interrupted'; old.interrupted = 'wrapper reloaded or participant registration changed'; old.interruptedAt = new Date().toISOString() }
        const participantId = session.participantId ?? `P${String(report.participants.length + 1).padStart(3, '0')}`
        const participant = { id: participantId, participantCode: value.participantCode, deviceId: value.deviceId, device: value.device,
          experience: value.experience, physicalDeviceDeclared: value.physicalDevice === true,
          automation: value.automation === true, browser: safeText(req.headers['user-agent'], 240),
          viewport: value.viewport, timeZone: safeText(value.timeZone, 80), registeredAt: new Date().toISOString() }
        report.participants.push(participant)
        Object.assign(session, { participantId, deviceId: value.deviceId, documentId: value.documentId, participant, runId: undefined })
        persist()
        return send(res, 200, { participantId })
      }
      if (req.method === 'POST' && path === '/study/prepare') {
        const value = await body(req)
        knownClient(session, value)
        if (!session.participantId) fail(409, '请先填写设备信息')
        if (!['locate', 'review', 'resume'].includes(value.kind)) fail(400, '未知测试')
        if (preparing) fail(409, '另一台设备正在准备场景，请稍后重试')
        if (report.runs.some(row => ['running', 'saved'].includes(row.status))) fail(409, '请先完成正在计时的测试，再开始下一项')
        let scenario, resumeRecord
        const previous = current(session)
        if (value.kind === 'resume') {
          if (previous?.kind !== 'review' || previous.status !== 'completed' || !previous.savedRecord) fail(409, '先完成一次复盘，才能测试复工')
          scenario = previous.scenario
          resumeRecord = previous.savedRecord
        } else {
          preparing = true
          try { scenario = await seedHumanScenario(host, ++scenarioIndex) } finally { preparing = false }
        }
        const run = { id: randomUUID(), kind: value.kind, participantId: session.participantId, deviceId: session.deviceId,
          participant: session.participant, status: 'ready', scenario, resumeRecord, preparedAt: new Date().toISOString(),
          assisted: false, manualReviewRequired: true, productEvents: [] }
        if (previous && ['running', 'ready'].includes(previous.status)) { previous.status = 'interrupted'; previous.interrupted = 'new test prepared' }
        report.runs.push(run)
        session.runId = run.id
        persist()
        // The participant sees the task's name, never the ground-truth answers or IDs of evidence.
        return send(res, 200, { run: publicRun(run) })
      }
      if (req.method === 'POST' && path === '/study/start') {
        const value = await body(req)
        knownClient(session, value)
        const run = current(session)
        if (!run || run.status !== 'ready' || !finite(value.monotonicMs)) fail(409, '请准备一个新场景')
        if (preparing || report.runs.some(row => row.id !== run.id && ['running', 'saved'].includes(row.status))) fail(409, '请先完成另一台设备上的测试，再开始计时')
        starts.set(run.id, performance.now())
        saveRun(session, { status: 'running', startedAt: new Date().toISOString(), clientStart: value.monotonicMs,
          clientWallStart: value.wallMs, viewportAtStart: value.viewport })
        return send(res, 200, { ok: true })
      }
      if (req.method === 'POST' && path === '/study/cancel') {
        const value = await body(req)
        knownClient(session, value)
        const run = current(session)
        if (run && ['ready', 'running', 'saved'].includes(run.status)) {
          saveRun(session, { status: 'interrupted', interrupted: 'participant ended this attempt', interruptedAt: new Date().toISOString() })
        }
        return send(res, 200, { ok: true })
      }
      if (req.method === 'POST' && path === '/study/event') {
        const value = await body(req)
        knownClient(session, value)
        const run = current(session)
        if (!run || !['running', 'saved'].includes(run.status)) fail(409, '没有进行中的测试')
        if (!['navigation', 'evidence', 'saved', 'hidden', 'visible', 'interrupted'].includes(value.kind)) fail(400, '未知记录类型')
        const elapsedMs = finite(value.monotonicMs) && value.monotonicMs >= run.clientStart ? value.monotonicMs - run.clientStart : undefined
        if (!finite(elapsedMs)) fail(400, '计时值无效')
        run.productEvents.push({ kind: value.kind, path: safeText(value.path, 400), at: new Date().toISOString(), elapsedMs })
        if (run.productEvents.length > 1000) run.productEvents.shift()
        if (value.kind === 'interrupted') { run.status = 'interrupted'; run.interrupted = 'page exited during timed operation' }
        if (value.kind === 'saved' && run.kind === 'review') {
          if (!run.savedRecord || value.recordId !== run.savedRecord.id) fail(409, '尚未收到真实保存回执')
          run.elapsedMs = elapsedMs
          run.serverElapsedMs = performance.now() - starts.get(run.id)
          run.finishedAt = new Date().toISOString()
          run.status = 'completed'
          run.structure = { withinFiveMinutes: elapsedMs <= 300_000,
            selectedGoal: run.savedRecord.goals.some(row => row.id === run.scenario.goalId && row.version === run.scenario.goalVersion),
            exactEvidence: run.savedRecord.references.some(row => row.ticketId === run.scenario.ticketId && row.evidenceId === run.scenario.evidenceId),
            openedExactEvidence: run.productEvents.some(row => row.kind === 'evidence'
              && row.path.includes(`/evidence/${run.scenario.ticketId}/${run.scenario.evidenceId}`)),
            checkpointPresent: ['blockedOn', 'ruledOut', 'resumeAt'].every(key => !!run.savedRecord.checkpoint[key]?.trim()) }
        }
        persist()
        return send(res, 200, { run: publicRun(run) })
      }
      if (req.method === 'POST' && path === '/study/finish') {
        const value = await body(req)
        knownClient(session, value)
        const run = current(session)
        if (!run || run.status !== 'running' || !['locate', 'resume'].includes(run.kind)) fail(409, '当前不在定位或复工测试中')
        const elapsedMs = value.monotonicMs - run.clientStart
        if (!finite(elapsedMs) || elapsedMs < 0) fail(400, '计时值无效')
        const answers = Object.fromEntries(['owner', 'blocker', 'waiting', 'resumeAt'].map(key => [key, safeText(value.answers?.[key])]))
        if (run.kind === 'locate' && ['owner', 'blocker', 'waiting'].some(key => !answers[key]) || run.kind === 'resume' && !answers.resumeAt) fail(400, '请填写完整答案')
        saveRun(session, { status: 'completed', finishedAt: new Date().toISOString(), elapsedMs,
          serverElapsedMs: performance.now() - starts.get(run.id), answers, assisted: value.assisted === true,
          structure: { withinSixtySeconds: run.kind === 'locate' ? elapsedMs <= 60_000 : undefined,
            openedExactEvidence: run.productEvents.some(row => row.kind === 'evidence'
              && row.path.includes(`/evidence/${run.scenario.ticketId}/${run.scenario.evidenceId}`)) } })
        return send(res, 200, { run: publicRun(run) })
      }
      if (req.method === 'GET' && path === '/study/time') return send(res, 200, {
        receivedWall, sentWall: Date.now(), serverProcessingMs: performance.now() - receivedMonotonic,
      })
      if (req.method === 'POST' && path === '/study/clock-samples') {
        const value = await body(req)
        knownClient(session, value)
        if (!Array.isArray(value.samples) || !value.samples.length || value.samples.length > 10) fail(400, '时钟样本无效')
        const samples = value.samples.map(row => {
          if (!['clientSend', 'clientReceive', 'monoSend', 'monoReceive', 'receivedWall', 'sentWall'].every(key => finite(row[key]))) fail(400, '时钟样本缺失')
          const rttMs = row.monoReceive - row.monoSend
          if (rttMs < 0 || rttMs > 30_000) fail(400, '时钟样本超出范围')
          const wallJumpMs = (row.clientReceive - row.clientSend) - rttMs
          const serverWallJumpMs = finite(row.serverProcessingMs) ? row.sentWall - row.receivedWall - row.serverProcessingMs : undefined
          const usable = row.sentWall >= row.receivedWall && Math.abs(wallJumpMs) <= 10 && finite(serverWallJumpMs) && Math.abs(serverWallJumpMs) <= 10
            && row.clientSend - row.receivedWall <= row.clientReceive - row.sentWall
          return { ...row, rttMs, wallJumpMs, serverWallJumpMs, usable,
            offsetConvention: 'client wall clock minus server wall clock',
            offsetLowerMs: row.clientSend - row.receivedWall, offsetUpperMs: row.clientReceive - row.sentWall,
            offsetCenterMs: ((row.clientSend - row.receivedWall) + (row.clientReceive - row.sentWall)) / 2 }
        })
        report.clockSamples.push({ participantId: session.participantId, deviceId: session.deviceId,
          participant: session.participant, samples, capturedAt: new Date().toISOString() })
        persist()
        return send(res, 200, { samples: samples.map(row => ({ rttMs: row.rttMs, offsetCenterMs: row.offsetCenterMs, usable: row.usable,
          uncertaintyMs: (row.offsetUpperMs - row.offsetLowerMs) / 2, wallJumpMs: row.wallJumpMs })) })
      }
      if (req.method === 'POST' && path === '/study/clock-reserve') {
        const value = await body(req)
        knownClient(session, value)
        const pair = { id: randomUUID(), code: randomBytes(3).toString('hex').toUpperCase(),
          sourceDeviceId: session.deviceId, sourceParticipantId: session.participantId, status: 'reserved',
          startedAt: new Date().toISOString(), sourceParticipant: session.participant,
          mechanism: 'source browser retains the call envelope until the other physical device delivers its explicitly linked result; no wall-clock offset is injected' }
        report.clockPairs.push(pair)
        traces.set(pair.id, createDeviceTrace(pair.id, directory))
        persist()
        return send(res, 200, { id: pair.id, code: pair.code })
      }
      if (req.method === 'POST' && path === '/study/clock-pair') {
        const value = await body(req)
        knownClient(session, value)
        const pair = report.clockPairs.find(row => value.id ? row.id === value.id : row.code === safeText(value.code, 10).toUpperCase())
        if (!pair) fail(404, '找不到这个同步码')
        if (value.action === 'announce') {
          if (pair.sourceDeviceId !== session.deviceId || pair.status !== 'reserved') fail(409, '这个同步码不能再开始')
          pair.status = 'waiting'
        } else if (value.action === 'respond') {
          if (pair.status !== 'waiting' || pair.sourceDeviceId === session.deviceId) fail(409, '请在另一台实际设备上回应，且每个同步码只能回应一次')
          if (!finite(value.wallMs) || !Number.isFinite(new Date(value.wallMs).valueOf()) || !finite(value.monotonicMs)) fail(400, '来源时间无效')
          pair.result = { deviceId: session.deviceId, participantId: session.participantId,
            wallMs: value.wallMs, monotonicMs: value.monotonicMs, receivedWallMs: receivedWall }
          pair.resultParticipant = session.participant
          traces.get(pair.id).receive('result', value.wallMs)
          pair.status = 'result-received'
        } else if (value.action === 'deliver') {
          if (pair.sourceDeviceId !== session.deviceId || pair.status !== 'result-received') fail(409, '等待另一台设备回应后再补传')
          if (!finite(value.wallMs) || !Number.isFinite(new Date(value.wallMs).valueOf()) || !finite(value.monotonicMs)) fail(400, '来源时间无效')
          pair.call = { deviceId: session.deviceId, participantId: session.participantId,
            wallMs: value.wallMs, monotonicMs: value.monotonicMs, receivedWallMs: receivedWall }
          pair.status = 'projecting'
          traces.get(pair.id).receive('call', value.wallMs)
          pair.projection = await traces.get(pair.id).result()
          pair.status = 'completed'
          pair.completedAt = new Date().toISOString()
          pair.manualDeviceConfirmationRequired = true
          traces.get(pair.id).close()
          traces.delete(pair.id)
        } else fail(400, '未知同步操作')
        persist()
        return send(res, 200, { id: pair.id, status: pair.status, projection: pair.projection && {
          sourceTimestampsPreserved: pair.projection.sourceTimestampsPreserved, explicitCausePreserved: pair.projection.explicitCausePreserved,
          observedArrivalReversed: pair.projection.observedArrivalReversed } })
      }
      if (req.method === 'GET' && path === '/study/clock-pair') {
        const pair = report.clockPairs.find(row => row.id === url.searchParams.get('id'))
        if (!pair || pair.sourceDeviceId !== session.deviceId) fail(404, '找不到本设备的同步记录')
        return send(res, 200, { id: pair.id, status: pair.status })
      }
      if (req.method === 'GET' && path === '/study-instrument.js') return send(res, 200,
        readFileSync(join(scripts, 'superhub-human-instrument.js')), 'text/javascript; charset=utf-8')
      if (req.method === 'GET' && path.startsWith('/chief/m/')) {
        const file = path.slice('/chief/m/'.length) || 'index.html'
        if (!['index.html', 'app.js', 'page.css', 'icon.svg', 'manifest.webmanifest'].includes(file)) fail(404, '找不到页面')
        const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', webmanifest: 'application/manifest+json' }
        let content = readFileSync(join(staticRoot, file))
        if (file === 'index.html') content = content.toString('utf8').replace('<script src="app.js">', '<script src="/study-instrument.js"></script><script src="app.js">')
        return send(res, 200, content, types[file.split('.').at(-1)])
      }
      if (path.startsWith('/chief/api/')) {
        let decodedPath
        try { decodedPath = decodeURIComponent(path) } catch { fail(400, '接口路径格式有误') }
        if (/\/(?:settings|setup|remote|execution-plan)(?:\/|$)/.test(decodedPath)) fail(403, '测试期间不开放配置操作')
        if (req.method === 'POST' && path !== '/chief/api/superhub/review') fail(403, '本次测试只允许保存复盘，不会交办或改变日常任务')
        const data = req.method === 'POST' ? await body(req) : undefined
        const run = current(session)
        if (req.method === 'POST' && (!run || run.kind !== 'review' || run.status !== 'running')) fail(409, '请从测试入口开始复盘计时')
        const response = await host.request(path + url.search, data, { raw: true })
        const bytes = Buffer.from(await response.arrayBuffer())
        if (data && response.ok) {
          const saved = JSON.parse(bytes.toString('utf8'))
          if (saved.record && run) { run.savedRecord = saved.record; run.status = 'saved'; run.serverSavedAt = new Date().toISOString(); persist() }
        }
        return send(res, response.status, bytes, response.headers.get('content-type') ?? 'application/json')
      }
      fail(404, '找不到页面')
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 500, { error: error.status ? error.message : '测试服务暂时无法完成操作，请联系主持人' })
      else res.end()
      if (!error.status) { report.notes.push({ at: new Date().toISOString(), error: error.message }); persist() }
    }
  })
  try { await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, bind, resolveListen) }) }
  catch (error) { await host.stop(); throw error }
  report.endpoint = publicOrigin ?? `http://${bind}:${server.address().port}`
  persist()
  const close = async () => {
    for (const run of report.runs) if (['running', 'saved', 'ready'].includes(run.status)) { run.status = 'interrupted'; run.interrupted = 'study server stopped' }
    report.stoppedAt = new Date().toISOString()
    persist()
    for (const trace of traces.values()) trace.close()
    await new Promise(resolveClose => server.close(resolveClose))
    await host.stop()
  }
  return { endpoint: report.endpoint, directory, reportPath, accessCode, report, close }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const study = await startHumanStudy()
  console.log(JSON.stringify({ ready: true, endpoint: study.endpoint, evidence: study.reportPath,
    accessCodeFile: join(study.directory, 'access-code.txt') }))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await study.close(); process.exit(0) })
}
