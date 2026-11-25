import { describe, expect, it } from 'vitest'
import { REDACTED, redactedTail, redactSecrets, utf8Tail } from '../src/core/redact.ts'

describe('redaction before tool output is persisted', () => {
  it.each([
    ['OPENAI_API_KEY=sk-live-abc123', 'OPENAI_API_KEY=' + REDACTED],
    ['export GITHUB_TOKEN="ghp_shortvalue"', 'export GITHUB_TOKEN="' + REDACTED + '"'],
    ['password: hunter2', 'password: ' + REDACTED],
    ['{"api_key": "abc", "name": "x"}', '{"api_key": "' + REDACTED + '", "name": "x"}'],
    ["{'client_secret':'s3'}", "{'client_secret':'" + REDACTED + "'}"],
    ['Authorization: Bearer abc.def-ghi', 'Authorization: ' + REDACTED],
    ['curl -H "Authorization: Bearer xyz123" https://a', 'curl -H "Authorization: ' + REDACTED + '" https://a'],
    ['got Bearer abcdef123 from cache', 'got Bearer ' + REDACTED + ' from cache'],
    ['tool --token abc123 --verbose', 'tool --token ' + REDACTED + ' --verbose'],
    ['tool --api-key=abc123', 'tool --api-key=' + REDACTED],
    ['https://x.test/cb?access_token=abc&state=1', 'https://x.test/cb?access_token=' + REDACTED + '&state=1'],
    ['blob wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY9z end', 'blob ' + REDACTED + ' end'],
    ['psql postgres://app:hunter2@db.local:5432/x', 'psql postgres://app:' + REDACTED + '@db.local:5432/x'],
  ])('%s', (input, output) => expect(redactSecrets(input)).toBe(output))

  it('keeps ordinary command output readable', () => {
    for (const text of [
      'On branch main\nnothing to commit, working tree clean',
      '/home/example/workspaces/superhub/src/dsh/workspace-v2-coding.ts',
      'commit 3f9a1c2e4b5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f',
      'arkcli 1.0.50', 'total 12\ndrwx------ 2 ubuntu ubuntu 4096 Nov 20 16:10 .',
      '0123456789abcdef0123456789abcdef0123',
    ]) expect(redactSecrets(text)).toBe(text)
  })

  it('caps tails by UTF-8 bytes without splitting a character, after redaction', () => {
    const text = '前'.repeat(2000) + 'token=abc'
    const tail = redactedTail(text, 2048)
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(2048)
    expect(tail.endsWith('token=' + REDACTED)).toBe(true)
    expect(tail).not.toContain('�')
    expect(utf8Tail('短', 100)).toBe('短')
  })

  it('does not keep a value whose name was cut off by the tail window', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const run = Array.from({length: 113}, (_, i) => alphabet[(i * 37 + 11) % 62]).join('')
    // The 128-byte window starts at `EY=sk-live-abc`, and redacting the random run shrinks the rest below 64 bytes.
    const text = 'OPENAI_API_KEY=sk-live-abc ' + run
    expect(Buffer.byteLength(text) - 128).toBe('OPENAI_API_K'.length)
    const tail = redactedTail(text, 64)
    expect(tail).not.toContain('sk-live')
    expect(tail).toBe(' ' + REDACTED)
  })

})
