import { expect, it } from 'vitest'
import type { V2CommandRecord } from '../src/core/workspace-v2.ts'
import { commandExperienceEvidence, verifyCommandExperience } from '../src/dsh/workspace-experience-evidence.ts'

it('重新核对带换行的测试输出时保留原始执行身份', () => {
  const command = {
    id: 'command', turnId: 'turn', workOrderId: 'order', memberId: 'staff',
    at: '2026-11-25T00:00:00Z', endedAt: '2026-11-25T00:01:00Z',
    tool: 'shell', cwd: '/work', command: 'pnpm test', exitCode: 0, outputTail: '报告：3 项通过\n',
  } satisfies V2CommandRecord
  const where = {workspaceId:'workspace', sessionId:'session', orderId:'order', turnId:'turn', staffId:'staff'}
  const evidence = commandExperienceEvidence(where, command.id, command)
  const restored = {...evidence, quote: evidence.quote!.trim()}
  const receipt = verifyCommandExperience(restored, [command], where.staffId)
  expect(receipt?.origin).toMatch(/^[0-9a-f]{64}$/)
  expect(verifyCommandExperience({...restored, quote: restored.quote + '\n'}, [command], where.staffId)).toEqual(receipt)
  expect(verifyCommandExperience({...restored, quote: restored.quote.replace('3 项', '8 项')}, [command], where.staffId)).toBeUndefined()
  expect(verifyCommandExperience(restored, [{...command, workOrderId:'other'}], where.staffId)).toBeUndefined()
})
