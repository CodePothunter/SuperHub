/** Real Codex and Claude Code checks for native images, read-only documents, steering and resuming a thread. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codingTurn } from '../src/dsh/workspace-v2-coding.ts'
import { isolateToolHomes } from './acceptance-homes.mjs'

const root = mkdtempSync(join(tmpdir(), 'chief-multimodal-cli-'))
const project = join(root, 'project')
const inputs = join(root, 'inputs')
const wait = () => AbortSignal.timeout(90_000)

function samples() {
  mkdirSync(project, {mode: 0o700})
  mkdirSync(inputs, {mode: 0o700})
  const a = join(inputs, 'A.png'), b = join(inputs, 'B.txt'), c = join(inputs, 'C.png')
  execFileSync('python3', ['-c', [
    'from PIL import Image, ImageDraw',
    'import sys',
    'im = Image.new("RGB", (280,120), "white")',
    'draw = ImageDraw.Draw(im)',
    'draw.ellipse((20,20,95,95), fill=(224,24,26))',
    'draw.rectangle((175,20,250,95), fill=(24,65,215))',
    'im.save(sys.argv[1])',
    'im = Image.new("RGB", (280,120), "white")',
    'ImageDraw.Draw(im).polygon([(20,98),(61,18),(102,98)], fill=(35,155,35))',
    'im.save(sys.argv[2])',
  ].join('\n'), a, c])
  chmodSync(a, 0o400)
  chmodSync(c, 0o400)
  writeFileSync(b, '样品代号 HARBOR-5F2K\n', {mode: 0o400})
  const file = (path, name, kind) => ({id: name, kind, name, path, bytes: statSync(path).size, ...kind === 'image' && {mediaType: 'image/png'}})
  return {initial: [file(b, 'B.txt', 'file'), file(a, 'A.png', 'image')], extra: [file(c, 'C.png', 'image')]}
}

function subprocess(homes) {
  return {spawn({argv, cwd, signal, env}) {
    const child = spawn(argv[0], argv.slice(1), {cwd, env: homes.apply(env), stdio: ['pipe', 'pipe', 'pipe']})
    const stop = () => child.kill('SIGTERM')
    signal.addEventListener('abort', stop, {once: true})
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => resolve({exitCode, signal}))
    }).finally(() => signal.removeEventListener('abort', stop))
    return {stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, done}
  }}
}

function verify(reply) {
  assert.match(reply, /红.{0,7}圆|red.{0,7}circle/i)
  assert.match(reply, /蓝.{0,7}(正方|方块|方形)|blue.{0,7}square/i)
  assert.match(reply, /HARBOR-5F2K/)
  assert.match(reply, /绿.{0,7}三角|green.{0,7}triangle/i)
}

async function probe(host, material, tool) {
  const command = tool === 'codex' ? 'codex' : 'claude'
  const received = []
  let added
  const first = await codingTurn(host, tool, command, project,
    '请直接观察 A.png，按从左到右写出每个图形的颜色和形状。只读 B.txt，抄出文内样品代号。只给答案。', wait(), {
      inputAttachments: material.initial,
      publish: (_id, text) => received.push(text),
      onSteerable: steer => { added = steer('test-extra', '请在最后一并写出新收到的 C.png 的颜色和形状。', material.extra) },
    })
  const delivery = await added
  assert.equal(delivery, tool === 'codex' ? 'steered' : 'pending')
  const reply = received.join('\n')
  verify(reply)
  assert.ok(first.sessionId)
  const recalled = []
  const next = await codingTurn(host, tool, command, project,
    '根据本会话之前的三份材料，复述 B 的完整代号和 A、C 的图形。仅给答案。', wait(), {
      launch: {resume: first.sessionId}, publish: (_id, text) => recalled.push(text),
    })
  assert.equal(next.sessionId, first.sessionId)
  const resumeReply = recalled.join('\n')
  verify(resumeReply)
  return {tool, model: first.model, delivery, reply, resumeReply}
}

const homes = isolateToolHomes({base: join(root, 'isolation'), env: {}})
try {
  const host = subprocess(homes), material = samples()
  const runs = await Promise.allSettled(['codex', 'claude-code'].map(tool => probe(host, material, tool)))
  for (const run of runs) {
    if (run.status === 'fulfilled') console.log(JSON.stringify(run.value))
    else { console.error(run.reason instanceof Error ? run.reason.message : String(run.reason)); process.exitCode = 1 }
  }
} finally {
  homes.teardown()
  rmSync(root, {recursive: true, force: true})
}
