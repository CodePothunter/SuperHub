/** getRandomValues also works on the authenticated HTTP mobile gateway. */
export function requestId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const h = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Store unresolved intent IDs per tab. A dropped response or remount can be retried with the same ID. */
export function pendingIntent(scope: string, resource: string, body: object, fallback: Map<string, string>, persist = true) {
  const prefix = 'superhub-v2:intent:' + scope + ':' + resource + ':'
  const payload = JSON.stringify(body)
  const signature = prefix + payload
  let prior = fallback.get(signature)
  try {
    for (let i = 0; persist && !prior && i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(prefix) && sessionStorage.getItem(key) === payload) prior = key.slice(prefix.length)
    }
  } catch { /* Storage is optional in embedded hosts. */ }
  const id = prior || requestId()
  fallback.set(signature, id)
  try { if (persist) sessionStorage.setItem(prefix + id, payload) } catch { /* In-memory retry still works. */ }
  return { id, reused: prior !== undefined, settle() {
    fallback.delete(signature)
    try { if (persist) sessionStorage.removeItem(prefix + id) } catch { /* Storage unavailable. */ }
  } }
}
