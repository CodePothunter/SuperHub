/* Test wrapper only. The packaged app is unchanged; observe its actual successful HTTP responses. */
(() => {
  const notify = detail => parent !== window && parent.postMessage({ channel: 'superhub-human-study', ...detail }, location.origin)
  const originalFetch = window.fetch
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args)
    const path = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname
    const method = args[1]?.method ?? args[0]?.method ?? 'GET'
    if (response.ok && path.startsWith('/chief/api/superhub/evidence/')) notify({ kind: 'evidence', path })
    if (response.ok && method.toUpperCase() === 'POST' && path === '/chief/api/superhub/review') {
      response.clone().json().then(value => value.record?.id && notify({ kind: 'saved', path, recordId: value.record.id })).catch(() => {})
    }
    return response
  }
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    history[method] = function (...args) { const result = original.apply(this, args); notify({ kind: 'navigation', path: location.hash }); return result }
  }
  window.addEventListener('hashchange', () => notify({ kind: 'navigation', path: location.hash }))
})()
