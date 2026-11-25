/** Marker that replaces a credential-like value before tool output is persisted. */
export const REDACTED = '‹已隐去›'

const SECRET_NAME = '[A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|authorization)[A-Za-z0-9_.-]*'
// "api_key": "value" / 'token': 'value'
const JSON_PAIR = new RegExp('(["\'])(' + SECRET_NAME + ')\\1(\\s*:\\s*)(["\'])((?:\\\\.|(?!\\4).)*)\\4', 'gi')
// --token value / --api-key=value
const FLAG_PAIR = new RegExp('(--?' + SECRET_NAME + ')(=|[ \\t]+)(?!-)(?:Bearer[ \\t]+)?([^\\s"\'`;&|]+)', 'gi')
// TOKEN=value / password: value / Authorization: Bearer value
const PLAIN_PAIR = new RegExp('(?<![A-Za-z0-9_.-])(' + SECRET_NAME + ')([ \\t]*[=:][ \\t]*)(["\']?)(?:Bearer[ \\t]+)?([^\\s"\'`;&|,]+)\\3', 'gi')
const BEARER = /\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]+/g
// scheme://user:password@host
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)([^\s@/'"`]+)@/gi
const RUN = /[A-Za-z0-9+/_=-]{32,}/g

/** Random-looking runs mix letters with digits and carry close to the entropy of a base64 alphabet. */
function highEntropy(run: string) {
  if (!/[a-z]/.test(run) || !/[A-Z]/.test(run) || !/[0-9]/.test(run)) return false
  const counts = new Map<string, number>()
  for (const character of run) counts.set(character, (counts.get(character) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) { const p = count / run.length; bits -= p * Math.log2(p) }
  return bits >= 4
}

/** Remove credential-shaped values from command text, output tails and stderr before they are written to disk. */
export function redactSecrets(text: string): string {
  return text
    .replace(JSON_PAIR, (_all, quote, name, colon, valueQuote) => quote + name + quote + colon + valueQuote + REDACTED + valueQuote)
    .replace(FLAG_PAIR, (_all, flag, gap) => flag + gap + REDACTED)
    .replace(PLAIN_PAIR, (all, name, gap, quote, value: string) => value === REDACTED || value.startsWith(REDACTED) ? all : name + gap + quote + REDACTED + quote)
    .replace(BEARER, (_all, word) => word + ' ' + REDACTED)
    .replace(URL_PASSWORD, (_all, user) => user + REDACTED + '@')
    .replace(RUN, run => highEntropy(run) ? REDACTED : run)
}

/** Keep the last `bytes` of UTF-8 text without starting inside a multi-byte character. */
export function utf8Tail(text: string, bytes: number): string {
  const data = Buffer.from(text)
  if (data.length <= bytes) return text
  let start = data.length - bytes
  while (start < data.length && (data[start]! & 0xc0) === 0x80) start++
  return data.subarray(start).toString('utf8')
}

/** The partial first word of a cut window, up to its first delimiter within 512 characters. */
const CUT_WORD = /^[^\s"'`,;&|]{0,512}(?=[\s"'`,;&|])/
/**
 * Redact first, then cap: the marker can be longer than a short secret. A cut can separate a value from its
 * name (`…KEY=` | `value`), so a truncated window drops its partial first word before it is redacted. A longer
 * unbroken run stays: its end is not the start of a value, and the entropy rule still applies to it.
 */
export function redactedTail(text: string, bytes: number): string {
  const window = utf8Tail(text, bytes * 2)
  return utf8Tail(redactSecrets(window.length < text.length ? window.replace(CUT_WORD, '') : window), bytes)
}
