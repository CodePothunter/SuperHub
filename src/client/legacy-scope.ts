import { useCallback, useContext } from 'react'
import { api, ApiError } from './api.ts'
import { scopedResource, V2Client } from './workspace-v2-api.ts'

/** Keep a V2 entry's scope on every read and action inside an existing workroom drawer. */
export function useLegacyRequest() {
  const { scope, revoke } = useContext(V2Client)
  return useCallback(async function request<T>(path: string, body?: unknown): Promise<T> {
    if (!scope) return api<T>(path, body)
    try {
      return await api<T>(scopedResource(scope, path), body)
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) revoke(error.message)
        if (error.status === 403 || error.status === 409) {
          try {
            const active = await api<{scope?: string}>('/v2/bootstrap')
            if (active.scope !== scope) revoke('第二大脑已切换，请重新打开。')
          } catch (check) {
            if (check instanceof ApiError && (check.status === 401 || check.status === 403)) revoke(check.message)
          }
        }
      }
      throw error
    }
  }, [scope, revoke])
}
