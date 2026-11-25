/**
 * The static UI tests mock `useV2Read`. Conversations read through `useV2PagedRead`; this mock answers it from the
 * same `useV2Read` mock (one page, nothing older or newer), so each test keeps a single table of responses.
 */
import { vi } from 'vitest'
import * as api from '../src/client/workspace-v2-api.ts'

/** `paging` overrides the page state (e.g. `{hasOlder: true}`: the loaded messages are not the whole conversation). */
export function pagedReadsFromV2Read(paging: Record<string, unknown> = {}) {
  vi.spyOn(api, 'useV2PagedRead').mockImplementation(((resource: string | undefined, valid: never) => {
    const read = api.useV2Read(resource, valid)
    const view = read.data as { messages?: unknown[] } | undefined
    return { view, messages: view?.messages ?? [], hasOlder: false, hasNewer: false, older: 'idle', newer: 'idle', olderError: undefined, newerError: undefined,
      error: read.error, jumping: undefined, refresh: read.refresh, loadOlder: async () => {}, loadNewer: async () => {}, toLatest: async () => {}, jumpTo: async () => {}, ...paging }
  }) as never)
}
