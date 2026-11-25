/**
 * 在 DSH 的侧栏注册 SuperHub。dsh-go 等面板宿主通过同一个入口打开工作空间。
 */
import { WorkspaceEntry } from './workspace-entry.tsx'
import { currentSurface, setSurface, subscribeSurface } from './surface.tsx'
import { WORKSPACE_NAME, WorkspaceMark } from './workspace-brand.tsx'
import { useSyncExternalStore } from 'react'

interface Slots {
  inject(name: string, fn: () => (() => void) | void): () => void
  entries?(name: string): { options?: { priority?: number } }[]
  register(options: Record<string, unknown>, component: unknown): () => void
}
interface NativeLayout {
  panelInfo: { getSnapshot(): { activePanelId: string | null }; subscribe(notify: () => void): () => void }
  selectPanel(panel: string | null): void
}
interface ClientContext {
  slots: Slots
  connection: { state: { getSnapshot(): 'connected' | 'connecting' | 'disconnected' | undefined; subscribe(notify: () => void): () => void }; reconnect(): void }
  get?(name: 'layout'): NativeLayout | undefined
  inject?(deps: ['layout'], apply: (ctx: ClientContext & { layout: NativeLayout }) => void): unknown
  effect(fn: () => () => void, label?: string): void
}

const PANEL_ID = 'dsh-chief'

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  function ConnectedApp({ canReturn = true }: { canReturn?: boolean }) {
    const connectionState = useSyncExternalStore(notify => ctx.connection.state.subscribe(notify), () => ctx.connection.state.getSnapshot())
    return <WorkspaceEntry native={canReturn ? () => setSurface('native') : undefined} reconnect={() => ctx.connection.reconnect()} connectionState={connectionState} />
  }
  function WorkspacePanel() {
    // DSH Web promotes the selection to the workspace root. Other hosts render the main panel in place.
    const selectedInWeb = ctx.inject && ctx.get?.('layout')?.panelInfo.getSnapshot().activePanelId === PANEL_ID
    return selectedInWeb ? null : <ConnectedApp canReturn={false} />
  }
  // Own the official root seat while active; withdraw the whole contribution
  // to restore the native frame, including its mobile drawers and other plugins.
  ctx.effect(() => {
    let release: (() => void) | undefined
    const sync = () => {
      if (currentSurface() === 'native') { release?.(); release = undefined }
      else if (!release) release = ctx.slots.inject('root', () => ctx.slots.register({ name: 'root', priority: Math.min(-100, ...(ctx.slots.entries?.('root') ?? []).map(e => (e.options?.priority ?? 0) - 1)) }, ConnectedApp))
    }
    sync(); const off = subscribeSurface(sync)
    return () => { off(); release?.() }
  }, 'SuperHub: unified surface')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, WorkspacePanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => WORKSPACE_NAME }, WorkspaceMark))
  ctx.inject?.(['layout'], native => native.effect(() => {
    const layout = native.layout
    let previousPanel: string | null = null
    let active = true
    const followSelection = () => {
      const { activePanelId } = layout.panelInfo.getSnapshot()
      if (activePanelId !== PANEL_ID) {
        previousPanel = activePanelId
        return
      }
      if (currentSurface() !== 'native') return
      // Restore the native selection outside its store notification, before switching roots.
      queueMicrotask(() => {
        if (!active || currentSurface() !== 'native' || layout.panelInfo.getSnapshot().activePanelId !== PANEL_ID) return
        try { layout.selectPanel(previousPanel) } catch { layout.selectPanel(null) }
        setSurface('chief')
      })
    }
    const unsubscribe = layout.panelInfo.subscribe(followSelection)
    followSelection()
    return () => { active = false; unsubscribe() }
  }, 'SuperHub: native panel navigation'))
}
