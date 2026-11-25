import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type SetupState } from './api.ts'
import { CommandApprovals } from './approvals.tsx'
import { Setup } from './setup.tsx'
import { clearV2PrivateCache } from './workspace-v2-api.ts'
import { WorkspaceV2 } from './workspace-v2.tsx'

interface EntryProps {
  native?: () => void
  reconnect?: () => void
  connectionState?: 'connected' | 'connecting' | 'disconnected'
}
type Bootstrap = { scope: string; configure: boolean; build: string } | SetupState | { needsDesktopSetup: true }

function validBootstrap(value: unknown): value is Bootstrap {
  if (!value || typeof value !== 'object') return false
  if ('setup' in value) {
    const setup = value.setup
    return !!setup && typeof setup === 'object'
      && 'suggested' in setup && typeof setup.suggested === 'string'
      && 'git' in setup && typeof setup.git === 'boolean'
      && (!('problem' in setup) || typeof setup.problem === 'string')
  }
  if ('needsDesktopSetup' in value) return value.needsDesktopSetup === true
  return 'scope' in value && typeof value.scope === 'string' && !!value.scope.trim()
    && 'configure' in value && typeof value.configure === 'boolean'
    && 'build' in value && typeof value.build === 'string'
}

const entryStyle = `
.chief-v2-entry { display:flex; flex:1 1 auto; flex-direction:column; width:100%; height:100%; min-width:0; min-height:0; overflow:hidden;
  color:var(--dsw-alias-label-primary,#202c25); background:var(--dsw-alias-bg-base,#f7f7f1); font:15px/1.6 "DM Sans","PingFang SC","Microsoft YaHei",sans-serif }
.chief-v2-entry>.wv2 { flex:1; height:auto }
.chief-v2-entry .chief-connection-state { box-sizing:border-box; width:min(100%,34rem); margin:auto; padding:24px; max-height:100%; overflow:auto; overflow-wrap:anywhere }
.chief-v2-entry .chief-connection-state h1 { margin:0; font-size:clamp(22px,4vw,30px); line-height:1.4 }
.chief-v2-entry .chief-connection-state p { color:var(--dsw-alias-label-secondary,#566359); margin:10px 0 20px }
.chief-v2-entry .chief-connection-banner { position:static; flex:none; display:flex; align-items:center; justify-content:center; flex-wrap:wrap;
  gap:8px 16px; padding:6px 16px; border-bottom:1px solid var(--dsw-alias-border-l2,#d5dbd0); background:var(--dsw-alias-state-warn-tertiary,#fef5e7); font-size:14px }
.chief-v2-entry :is(.chief-connection-state,.chief-connection-banner) button { min-height:40px; padding:6px 14px; margin:0 8px 0 0;
  border:1px solid var(--dsw-alias-border-l2,#d5dbd0); border-radius:7px; color:inherit; background:var(--dsw-alias-bg-base,#fffef9); font:inherit; cursor:pointer }
.chief-v2-entry :is(.chief-connection-state,.chief-connection-banner) button:focus-visible { outline:2px solid currentColor; outline-offset:2px }
`

export function WorkspaceEntry(props: EntryProps) {
  return <div className="chief-v2-entry"><style>{entryStyle}</style><WorkspaceHome {...props} /></div>
}

function WorkspaceHome({ native, reconnect, connectionState }: EntryProps) {
  const [entry, setEntry] = useState<Bootstrap>()
  const [error, setError] = useState('')
  const generation = useRef(0)
  const activeScope = useRef<string>(undefined)
  const refresh = useCallback(async () => {
    const request = ++generation.current
    try {
      const next = await api<unknown>('/v2/bootstrap')
      if (request !== generation.current) return
      if (!validBootstrap(next)) throw new Error('主机未返回工作区，请重新连接')
      const scope = 'scope' in next ? next.scope : undefined
      if (activeScope.current && activeScope.current !== scope) {
        clearV2PrivateCache(activeScope.current)
      }
      activeScope.current = scope
      setEntry(next)
      setError('')
      if ('scope' in next && typeof __BUILD__ === 'string' && next.build && next.build !== 'dev' && next.build !== __BUILD__ && sessionStorage.getItem('chief-reloaded') !== next.build) {
        sessionStorage.setItem('chief-reloaded', next.build)
        location.reload()
      }
    } catch (err) {
      if (request !== generation.current) return
      if (err instanceof ApiError && [401, 403, 409].includes(err.status)) {
        clearV2PrivateCache(activeScope.current)
        activeScope.current = undefined
        setEntry(undefined)
      }
      setError((err as Error).message)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const whenVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    const interval = setInterval(whenVisible, 5000)
    document.addEventListener('visibilitychange', whenVisible)
    return () => { generation.current++; clearInterval(interval); document.removeEventListener('visibilitychange', whenVisible) }
  }, [refresh, connectionState])
  const retry = () => { reconnect?.(); void refresh() }
  if (entry && 'setup' in entry) return <Setup state={entry} refresh={refresh} />
  if (entry && 'needsDesktopSetup' in entry) return <main className="chief-connection-state"><h1>先在电脑上启用 SuperHub</h1>
    <p>用 DSH 打开 SuperHub，选好存放工作资料的文件夹，再回到手机。</p><button onClick={retry}>重新连接</button></main>
  if (!entry) return <main className="chief-connection-state" role="status"><h1>{error ? '工作区连接中断' : '正在打开 SuperHub'}</h1>
    {error && <><p>{error}</p><button onClick={retry}>重新连接</button>{native && <button onClick={native}>返回 DSH</button>}</>}</main>
  return <>
    {(error || connectionState === 'disconnected') && <div className="chief-connection-banner" role="status">{error || 'DSH 连接已断开'} <button onClick={retry}>重试连接</button></div>}
    {entry.configure && <CommandApprovals key={'approvals-' + entry.scope} />}
    <WorkspaceV2 key={entry.scope} scope={entry.scope} native={native} configure={entry.configure} reloadBrain={refresh}/>
  </>
}
