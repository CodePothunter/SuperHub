/** Real-host acceptance for a changed feature anchor and conflicting source-ticket checks. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const marker = 'SUPERHUB_RELEASE_FIXTURE'
const reports = ['typecheck.json', 'mobile-layout.json']
const proofFiles = [...reports, 'ui-source-proof.json']
const baselineTitle = '幕僚室导航'
const revisedTitle = '讨论模板入口'
const roomTitle = '换版验收讨论'
const sourceText = '把左侧那个乱糟糟的地方改清爽一点，验收编号 ' + marker + '。'
const checks = ['类型检查通过', '390px 视口内的输入区完整可见', '送审源码只改动约定的工作空间文件']
const hash = data => createHash('sha256').update(data).digest('hex')

export const inject = ['llm']

// AcceptanceHost installs a copy of this module as the deterministic model fixture.
export function apply(ctx) {
  ctx.on('llm/stream', request => {
    const prompt = request.messages.filter(row => row.role === 'user')
      .flatMap(row => row.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    return reply(prompt)
  })
}

async function* reply(prompt) {
  let block
  if (!prompt.includes(marker)) {
    block = { type: 'text', text: '隔离验收。' }
  } else {
    let value
    if (prompt.includes('你是独立审查官。')) {
      const data = /已验证版本及内容[^\n]*\n([^\n]+)/.exec(prompt)
      const records = data ? JSON.parse(data[1]) : []
      const standardIds = [...prompt.matchAll(/^\s*- ([\w-]+)（必要，登记的产物版本）/gm)].map(match => match[1])
      const outcomes = [
        measured => measured.exitCode === 0, measured => measured.fits === true,
        measured => measured.files?.length === 1 && measured.files[0].path === 'src/client/surface.tsx',
      ]
      const criteria = proofFiles.map((filename, index) => {
        const proof = records.find(item => item.path.endsWith('/' + filename))
        const measured = proof ? JSON.parse(proof.content) : undefined
        const status = !measured ? 'unverified' : outcomes[index](measured) ? 'pass' : 'fail'
        return { criterionId: standardIds[index], status,
          evidence: proof ? [{ path: proof.path, version: proof.version }] : [], comment: checks[index] }
      })
      value = { critique: '分别核对同一源码的类型检查与手机布局记录。', criteria }
    } else {
      value = { status: 'ready', summary: '已生成同一候选的两项检查记录。', outputs: reports }
    }
    block = { type: 'tool-call', id: 'release-gap-output', name: 'structured_output', arguments: JSON.stringify(value) }
  }
  yield { type: 'block-start', index: 0, blockType: block.type }
  if (block.type === 'tool-call') {
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
  } else yield { type: 'text-delta', index: 0, text: block.text }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
}

function replaceOne(value, before, after) {
  assert.equal(value.split(before).length, 2, 'Test fixture no longer matches the reference source')
  return value.replace(before, after)
}

async function run() {
  const candidate = process.env.CHIEF_ACCEPTANCE_PACKAGE
  const sourceRef = process.env.CHIEF_ACCEPTANCE_SOURCE_REF
  const report = process.env.CHIEF_SUPERHUB_GAP_EVIDENCE
  const playwright = process.env.CHIEF_PLAYWRIGHT_PATH
  const chromiumPath = process.env.CHIEF_CHROMIUM_PATH
  assert.ok(candidate, 'Set CHIEF_ACCEPTANCE_PACKAGE to the reference package.')
  assert.match(sourceRef ?? '', /^[a-f0-9]{7,64}$/, 'Set CHIEF_ACCEPTANCE_SOURCE_REF to the matching reference commit.')
  assert.ok(playwright, 'Set CHIEF_PLAYWRIGHT_PATH to Playwright.')
  const [{ acceptanceHost, until }, { captureUiSource }] = await Promise.all([
    import('./acceptance-host.mjs'), import('./ui-source-proof.mjs'),
  ])
  const evidence = { checkedAt: new Date().toISOString(), referenceSha256: hash(readFileSync(candidate)), sourceRef }
  const cwd = dirname(dirname(fileURLToPath(import.meta.url)))
  const work = mkdtempSync(join(tmpdir(), 'chief-release-gaps-'))
  const checkout = join(work, 'source')
  let host, browser
  let scope
  let checkpoint = 'isolate test variants'
  const query = (path, fields = {}) => '/superhub/' + path + '?' + new URLSearchParams({ scope, ...fields })
  const read = (path, fields) => host.api(query(path, fields))
  const write = (path, fields) => host.api('/superhub/' + path, { scope, requestId: randomUUID(), ...fields })
  const build = out => execFileSync('pnpm', ['build'], { cwd: checkout, stdio: 'pipe',
    env: { ...process.env, CHIEF_BUILD_ID: 'superhub-gap-fixture', CHIEF_OUT_DIR: out }, timeout: 120_000 })
  const view = (page, place, id) => page.goto(host.base + '/#superhub?' + new URLSearchParams({ scope, page: place, id }))
  const roomButton = page => page.locator('.chief-conversations').getByRole('button', { name: roomTitle, exact: true })
  const hub = page => page.locator('.hub-shell')
  const phoneViewport = { width: 390, height: 844 }
  async function open(viewport = { width: 1260, height: 547 }) {
    const page = await browser.newPage({ viewport, locale: 'zh-CN' })
    page.setDefaultTimeout(10_000)
    const cookies = host.cookie().split('; ').map(pair => {
      const split = pair.indexOf('=')
      return { name: pair.slice(0, split), value: pair.slice(split + 1), url: host.base }
    })
    await page.context().addCookies(cookies)
    await page.goto(host.base)
    return page
  }
  async function clickReceipt(page, label, id) {
    const completing = page.waitForResponse(response => new URL(response.url()).pathname === '/chief/api/superhub/items/' + id
      && response.request().method() === 'POST')
    await hub(page).getByRole('button', { name: label, exact: true }).click()
    const response = await completing
    assert.ok(response.ok())
    return response.json()
  }
  async function mobileMeasure() {
    const page = await open(phoneViewport)
    try {
      const input = page.getByRole('textbox', { name: '对接口人说' })
      await input.waitFor()
      const bounds = await page.locator('.wr-say').boundingBox()
      assert.ok(bounds && bounds.width > 0)
      const viewportWidth = page.viewportSize().width
      const composerRight = Math.round(bounds.x + bounds.width)
      return { viewportWidth, composerRight, fits: bounds.x >= 0 && composerRight <= viewportWidth }
    } finally {
      await page.close()
    }
  }

  try {
    execFileSync('git', ['clone', '--shared', '--quiet', '--no-checkout', cwd, checkout], { stdio: 'pipe', timeout: 40_000 })
    execFileSync('git', ['checkout', '--detach', sourceRef], { cwd: checkout, stdio: 'pipe', timeout: 40_000 })
    symlinkSync(join(cwd, 'node_modules'), join(checkout, 'node_modules'), 'dir')
    const anchorFile = join(checkout, 'src/core/superhub-intake.ts')
    const surfaceFile = join(checkout, 'src/client/surface.tsx')
    const originalAnchor = readFileSync(anchorFile, 'utf8')
    const originalSurface = readFileSync(surfaceFile, 'utf8')
    const fixtureSurface = replaceOne(
      replaceOne(originalSurface, 'onClick={() => go(room.id)}', 'onClick={() => setCreating(true)}'),
      'const FRAME_CSS = `', 'const FRAME_CSS = `\n@media(max-width:600px){.wr-say{min-width:520px}}\n',
    )
    writeFileSync(anchorFile, replaceOne(originalAnchor, "id: 'discussion-navigation', version: 1, title: '" + baselineTitle,
      "id: 'discussion-navigation', version: 2, title: '" + revisedTitle))
    writeFileSync(surfaceFile, fixtureSurface)
    build(join(checkout, 'lib'))
    evidence.variantClientSha256 = hash(readFileSync(join(checkout, 'lib', 'client.js')))
    writeFileSync(anchorFile, originalAnchor)
    writeFileSync(surfaceFile, originalSurface)

    checkpoint = 'create old receipt and record original selector'
    const { chromium } = await import(pathToFileURL(resolve(playwright)).href)
    browser = await chromium.launch({ headless: true, ...chromiumPath ? { executablePath: chromiumPath } : {} })
    evidence.browser = browser.version()
    host = await acceptanceHost({ candidate: resolve(candidate), probe: 'superhub-release-gaps.mjs' })
    await host.start()
    await host.api('/pause', { paused: true })
    scope = (await host.api('/state')).superhubScope
    assert.ok(scope)
    const { id: room } = await host.api('/rooms', { title: roomTitle, request_id: 'superhub-release-gap-room' })
    assert.ok(room)
    const oldPage = await open()
    await roomButton(oldPage).click()
    await oldPage.waitForURL(url => url.hash === '#room=' + encodeURIComponent(room))
    await oldPage.close()
    const baselineMobile = await mobileMeasure()
    assert.equal(baselineMobile.fits, true)
    const receipt = await write('items', { text: sourceText })
    const item = receipt.items[0]
    const feature = 'discussion-navigation'
    assert.equal(item.state, 'clarify')
    assert.equal(item.candidates.find(row => row.id === feature).version, 1)
    const ticketCount = (await read('overview')).total

    checkpoint = 'verify stale feature on the upgraded host'
    await host.stop()
    host.install(checkout)
    await host.start()
    await host.api('/pause', { paused: true })
    const upgraded = await host.api('/state')
    assert.equal(upgraded.superhubScope, scope)
    assert.equal(upgraded.dev, true)
    const page = await open()
    await roomButton(page).click()
    await page.getByRole('textbox', { name: '新讨论标题' }).waitFor()
    assert.equal(new URL(page.url()).hash, '')
    await view(page, 'intake', receipt.id)
    const stale = await clickReceipt(page, baselineTitle, receipt.id)
    await hub(page).getByText('这个功能定位已失效，请确认当前功能与版本。', { exact: true }).waitFor()
    assert.equal(stale.items[0].state, 'clarify')
    assert.equal(stale.items[0].ticketId, undefined)
    assert.deepEqual(stale.items[0].candidates.map(({ id, version }) => ({ id, version })), [{ id: feature, version: 2 }])
    assert.equal((await read('overview')).total, ticketCount)
    const fresh = await clickReceipt(page, revisedTitle, receipt.id)
    const ticketId = fresh.items[0].ticketId
    assert.ok(ticketId)
    assert.equal(fresh.items[0].feature.version, 2)
    const pending = await read('mission/' + ticketId)
    assert.equal(pending.ticket.stage, 'queued')
    assert.equal(pending.ticket.staff, 'ui-smith')
    evidence['AT-12'] = { receiptId: receipt.id, stableSelector: '.chief-conversations button', originalAction: 'opens room',
      variantAction: 'opens discussion template form', oldVersion: 1, newVersion: 2, staleDispatched: false, freshlyConfirmedTicket: ticketId }
    console.log('PASS AT-12 same browser selector with changed behavior, stale version blocked and current version accepted')

    checkpoint = 'register two real checks on the same source ticket'
    assert.equal(pending.contract.criteria.length, checks.length)
    await write('mission/' + ticketId, { ...pending.currentTarget, action: 'reviseContract', reason: '分别验收类型与手机场景',
      criteria: pending.contract.criteria.map((criterion, index) => ({ ...criterion, text: checks[index] })) })
    writeFileSync(surfaceFile, fixtureSurface)
    const sourceSnapshot = captureUiSource(checkout)
    const sourceSha256 = hash(readFileSync(surfaceFile))
    const typecheck = spawnSync('pnpm', ['typecheck'], { cwd: checkout, encoding: 'utf8', timeout: 120_000 })
    assert.ifError(typecheck.error)
    assert.equal(typecheck.status, 0, typecheck.stderr)
    const verifiedBuild = join(work, 'checked-build')
    build(verifiedBuild)
    assert.equal(hash(readFileSync(join(verifiedBuild, 'client.js'))), evidence.variantClientSha256)
    assert.equal(captureUiSource(checkout).digest, sourceSnapshot.digest)
    const mobile = await mobileMeasure()
    assert.equal(mobile.fits, false, 'The real 390px check must catch the test-only overflow')
    assert.equal(hash(readFileSync(surfaceFile)), sourceSha256)
    const contents = [
      { sourceSha256, command: 'pnpm typecheck', exitCode: typecheck.status },
      { sourceSha256, ...mobile },
    ].map(value => JSON.stringify(value) + '\n')
    const directory = join(host.brain, 'work', ticketId)
    mkdirSync(directory, { recursive: true })
    reports.forEach((name, index) => writeFileSync(join(directory, name), contents[index]))
    await host.api('/pause', { paused: false })
    const mission = await until(async () => {
      const value = await read('mission/' + ticketId)
      return value.ticket.stage === 'you/review' && value.verification?.status === 'completed' ? value : undefined
    }, 'independent verification of both observations', 90_000)
    const criterionStates = mission.criteria.map(criterion => criterion.status)
    assert.deepEqual(criterionStates, ['pass', 'fail', 'pass'])
    const versions = mission.criteria.map((criterion, index) => {
      const registered = mission.evidence.find(row => row.id === criterion.evidenceIds[0])
      assert.ok(registered?.path.endsWith('/' + proofFiles[index]))
      const expected = contents[index] ?? readFileSync(join(directory, proofFiles[index]), 'utf8')
      assert.equal(registered.version, hash(expected))
      return registered.version
    })
    assert.equal(readFileSync(join(directory, proofFiles[2]), 'utf8'), sourceSnapshot.proof)
    await view(page, 'mission', ticketId)
    const criteria = hub(page).locator('.hub-section').filter({ has: page.getByRole('heading', { name: /^验收标准/ }) })
    for (const [index, text] of checks.entries()) {
      const label = criterionStates[index] === 'pass' ? '必要 · 通过' : '必要 · 未通过'
      await criteria.getByRole('listitem').filter({ hasText: text }).getByText(label, { exact: true }).waitFor()
    }
    assert.equal(await hub(page).getByRole('button', { name: '确认验收', exact: true }).isEnabled(), false)
    await assert.rejects(write('mission/' + ticketId, { ...mission.currentTarget, action: 'accept' }), { status: 409 })
    assert.equal((await read('mission/' + ticketId)).ticket.stage, 'you/review')
    evidence['AT-14'] = { ticketId, sourceSha256, sourceDigest: sourceSnapshot.digest, baselineMobile, typecheckExitCode: typecheck.status, mobile,
      criterionStates, versions, stage: 'you/review', ordinaryAcceptanceStatus: 409, model: 'deterministic native reviewer fixture' }
    console.log('PASS AT-14 one source ticket with separately registered actual typecheck and mobile outcomes')
  } catch (error) {
    evidence.failure = { checkpoint, message: error.message }
    process.exitCode = 1
    console.error('FAIL SuperHub release gap acceptance', evidence.failure)
  } finally {
    await browser?.close()
    await host?.stop()
    if (report) {
      mkdirSync(dirname(resolve(report)), { recursive: true })
      writeFileSync(report, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await run()
