import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, ApiError } from './api.ts'
import { pendingIntent } from './request-id.ts'
import { hubRead, type Scoped } from './superhub-api.ts'
import { hasMutationObject } from './workspace-v2-response.ts'
import { usePagedHistory, type PagedView } from './paged-history.ts'

export const V2_ROOT = '/v2/workspaces'
export const segment = encodeURIComponent
export const V2Client = createContext({ scope: '', revoke: (_message: string) => {} })
type Observation<T> = { key: string; data?: T; error?: string }
const messageOf = (error: unknown) => error instanceof Error ? error.message : '读取工作区时出现问题'

export function scopedResource(scope: string, resource: string) {
  const [path, search] = resource.split('?')
  const params = new URLSearchParams(search)
  params.set('scope', scope)
  return path + '?' + params
}

export function clearV2PrivateCache(scope?: string) {
  const target = scope === undefined ? '' : scope + ':'
  const prefixes = ['superhub-v2:draft:' + target, 'superhub-v2:intent:' + target]
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (key && prefixes.some(prefix => key.startsWith(prefix))) sessionStorage.removeItem(key)
    }
  } catch { /* Storage is optional in embedded hosts. */ }
}

/** A failed transport can keep its last observation. A denied or missing object cannot. */
export function useV2Read<T extends Scoped>(resource: string | undefined, valid: (value: Scoped, resource: string) => value is T, interval?: number, revision?: number) {
  const { scope, revoke } = useContext(V2Client)
  const key = resource && scopedResource(scope, resource)
  const generation = useRef(0)
  const liveKey = useRef(key)
  const [state, setState] = useState<Observation<T>>()
  useLayoutEffect(() => {
    liveKey.current = key
    return () => { liveKey.current = undefined; generation.current++ }
  }, [key])
  const refresh = useCallback(async () => {
    if (!key || !resource || key !== liveKey.current) return
    const version = ++generation.current
    try {
      const data = await hubRead<Scoped>(scope, key)
      if (!valid(data, resource)) throw new Error('工作区返回的内容不完整，请重新读取。')
      if (generation.current === version) setState({ key, data })
    } catch (error) {
      if (generation.current !== version) return
      const status = error instanceof ApiError ? error.status : undefined
      if (status === 401 || status === 403 || status === 409) {
        revoke(messageOf(error))
        return
      }
      setState(previous => ({ key, data: status !== 404 && previous?.key === key ? previous.data : undefined, error: messageOf(error) }))
    }
  }, [scope, key, resource, valid, revoke])
  useEffect(() => {
    if (!key) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll(first = false) {
      if (first || document.visibilityState === 'visible') await refresh()
      if (!stopped && interval) timer = setTimeout(poll, interval)
    }
    void poll(true)
    return () => { stopped = true; clearTimeout(timer) }
  }, [key, refresh, interval, revision])
  return { data: state?.key === key ? state?.data : undefined, error: state?.key === key ? state?.error : undefined, refresh }
}

/**
 * A paged conversation read (see paged-history.ts): the newest page, or the page around `anchor`, polled every `interval`;
 * older and newer pages on demand. Denied or switched brains revoke like `useV2Read`; a missing object clears the view.
 */
export function useV2PagedRead<V extends Scoped & PagedView<T>, T extends { id: string }>(resource: string | undefined,
  valid: (value: Scoped, resource: string) => value is V,
  options: { interval?: number; anchor?: string; following?: () => boolean; combine?: (previous: V | undefined, next: V) => V } = {}) {
  const { scope, revoke } = useContext(V2Client)
  const read = useCallback(async (query: string) => {
    if (!resource) throw new Error('没有可读的对话')
    const data = await hubRead<Scoped>(scope, scopedResource(scope, resource + '?' + query))
    if (!valid(data, resource)) throw new Error('工作区返回的内容不完整，请重新读取。')
    return data
  }, [scope, resource, valid])
  return usePagedHistory<V, T>({
    key: resource && scope + '\n' + resource, read, id: item => item.id, ...options,
    failed: error => {
      const status = error instanceof ApiError ? error.status : undefined
      if (status === 401 || status === 403 || status === 409) { revoke(messageOf(error)); return 'stop' }
      return status === 404 ? 'clear' : 'keep'
    },
    message: messageOf,
  })
}

export function useV2Write(validReceipt = hasMutationObject, persistIntent = true) {
  const { scope, revoke } = useContext(V2Client)
  const memory = useRef(new Map<string, string>())
  const active = useRef(false)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function post<T extends Scoped>(resource: string, body: Record<string, unknown>, confirm?: (receipt: T) => Promise<void>, allowNew = true) {
    if (active.current) return
    active.current = true
    setBusy(true); setError('')
    const intent = pendingIntent(scope, resource, body, memory.current, persistIntent)
    let received = false
    try {
      if (!allowNew && !intent.reused) { intent.settle(); return }
      const data = await api<T>(scopedResource(scope, resource), { ...body, requestId: intent.id })
      if (data.scope !== scope) { if (mounted.current) revoke('工作区归属已改变，请重新连接。'); return }
      if (!validReceipt(data, resource)) throw new Error('主机返回的回执不完整，请重试以核对结果。')
      // Retain the original intent across remounts until a required service readback succeeds.
      received = true
      if (confirm) await confirm(data)
      intent.settle()
      if (mounted.current) return data
    } catch (error) {
      if (!received && error instanceof ApiError && [400, 401, 403, 404, 405, 413].includes(error.status)) intent.settle()
      if (mounted.current) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) revoke(messageOf(error))
        else {
          setError(messageOf(error))
          if (error instanceof ApiError && error.status === 409) {
            // A stale delegation, an unknown turn and a different brain all report conflicts.
            try { await hubRead<Scoped>(scope, '/v2/bootstrap') }
            catch (check) {
              if (mounted.current && check instanceof ApiError && [401, 403, 409].includes(check.status)) revoke(messageOf(check))
            }
          }
        }
      }
    } finally {
      active.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return { post, busy, error }
}
