import { useEffect, useId, useState } from 'react'
import { VISUAL_THEME } from './visual-theme.ts'
import { Avatar, AVATAR_CSS } from './avatar.tsx'
import { OVERVIEW_NAME, RETURN_TO_DSH, WORKSPACE_NAME, WorkspaceMark } from './workspace-brand.tsx'
import type { ReactNode } from 'react'

const KEY = 'chief-surface-mode'
const listeners = new Set<() => void>()
const read = () => { try { return localStorage.getItem(KEY) === 'native' ? 'native' : 'chief' } catch { return 'chief' } }
let mode = read()
export function setSurface(next: 'chief' | 'native') { mode = next; try { localStorage.setItem(KEY, next) } catch {} for (const notify of listeners) notify() }
export const currentSurface = () => mode
export function subscribeSurface(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify) } }

export function WorkspaceFrame({ children, notice, native, rooms = [], selected, overviewActive, choose, create, error, openOverview }: {
  children: ReactNode; notice?: ReactNode; native?: () => void; rooms?: { id: string; title: string }[]; selected?: string
  overviewActive?: boolean; choose?: (id?: string) => void; create?: (title: string) => Promise<boolean>; error?: string; openOverview?: () => void
}) {
  const navId = useId()
  const [open, setOpen] = useState(false), [creating, setCreating] = useState(false), [title, setTitle] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => {
    const previousTitle = document.title
    document.title = WORKSPACE_NAME
    return () => { if (document.title === WORKSPACE_NAME) document.title = previousTitle }
  }, [])
  const inChat = !overviewActive && !selected
  const inRoom = !overviewActive && Boolean(selected)
  const go = (id?: string) => { choose?.(id); setOpen(false) }
  const goOverview = () => { openOverview?.(); setOpen(false) }
  return <div className={`chief-surface ${open ? 'navigation-open' : ''}`}>
    <style>{FRAME_CSS + AVATAR_CSS + VISUAL_THEME}</style>
    <header className="chief-mobile-bar">
      <div className="chief-mobile-brand"><WorkspaceMark size={19} /><b>{WORKSPACE_NAME}</b></div>
      <nav aria-label="工作空间导航">
        <button onClick={() => go()} aria-current={inChat ? 'page' : undefined}>接口人</button>
        {openOverview && <button onClick={goOverview} aria-current={overviewActive ? 'page' : undefined}>{OVERVIEW_NAME}</button>}
        <button onClick={() => setOpen(!open)} aria-controls={navId} aria-expanded={open} aria-current={inRoom ? 'page' : undefined}>讨论</button>
      </nav>
    </header>
    {open && <button className="chief-nav-scrim" aria-label="关闭会话导航" onClick={() => setOpen(false)} />}
    <nav id={navId} className="chief-navigation" aria-label="会话导航">
      <div className="chief-wordmark"><WorkspaceMark /><b>{WORKSPACE_NAME}</b></div>
      <button className={`chief-home ${inChat ? 'is-active' : ''}`} onClick={() => go()} aria-current={inChat ? 'page' : undefined}>
        <Avatar who="lead" size={34} /><span>接口人<small>对话与交办</small></span>
      </button>
      {openOverview && <button className={`chief-home ${overviewActive ? 'is-active' : ''}`} onClick={goOverview} aria-current={overviewActive ? 'page' : undefined}>
        <span className="chief-hub-mark" aria-hidden="true">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="3" /><path d="M4 10h16M10 10v10" />
          </svg>
        </span>
        <span>{OVERVIEW_NAME}<small>决定、目标与复盘</small></span>
      </button>}
      <div className="chief-nav-heading"><span>讨论</span><button aria-label="发起新讨论" title="发起新讨论" onClick={() => setCreating(!creating)}>＋</button></div>
      {creating && <form className="chief-topic-form" onSubmit={async e => { e.preventDefault(); if (!title.trim() || !create) return; setBusy(true); try { if (await create(title.trim())) { setTitle(''); setCreating(false); setOpen(false) } } finally { setBusy(false) } }}><input autoFocus aria-label="新讨论标题" placeholder="讨论什么？" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} /><button disabled={busy || !title.trim()}>＋ 新讨论</button></form>}
      <div className="chief-conversations">{rooms.map(room => {
        const active = inRoom && selected === room.id
        return <button key={room.id} title={room.title} className={active ? 'is-active' : ''} aria-current={active ? 'page' : undefined} onClick={() => go(room.id)}>
          <span className="chief-topic-mark" aria-hidden><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 3v-3H3V7a2 2 0 0 1 2-2Z" /></svg></span>
          <span>{room.title}</span>
        </button>
      })}{!rooms.length && <p>还没有讨论。</p>}</div>
      {error && <p className="chief-nav-error" role="alert">{error}</p>}
      {native && <footer><button onClick={native}><span aria-hidden="true">←</span>{RETURN_TO_DSH}</button></footer>}
    </nav>
    <div className="chief-surface-content">{notice}<div className="chief-surface-view">{children}</div></div>
  </div>
}
const FRAME_CSS = `
.chief-surface{position:fixed;inset:0;z-index:1000;height:100dvh;display:flex;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#18202a);pointer-events:auto;font:14px/1.55 system-ui,-apple-system,"Noto Sans CJK SC",sans-serif;--surface-rule:var(--dsw-alias-border-l2,#e6e8eb);--surface-dim:var(--dsw-alias-label-secondary,#737b85);--surface-hover:var(--dsw-alias-interactive-bg-hover,#e9ecef);--chief-action:light-dark(#3a50d0,#aebaff);--chief-on-action:light-dark(#fff,#171b29)}
.chief-surface *{box-sizing:border-box}
.chief-surface-content{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0;isolation:isolate}
.chief-surface-view{position:relative;min-height:0;flex:1}.chief-surface-view>.wr{height:100%}
.chief-surface-view>.wr[inert]{position:absolute;inset:0;visibility:hidden}
.chief-surface-content .chief-rooms{position:absolute;height:100%;grid-template-columns:minmax(0,1fr) 300px}
.chief-navigation{width:190px;flex:none;padding:24px 13px 14px;background:var(--dsw-alias-bg-module-platform,#f6f7f8);border-right:1px solid var(--surface-rule);display:flex;flex-direction:column;min-height:0;overflow:auto}
.chief-navigation button{font:inherit;color:inherit;cursor:pointer;border:0;border-radius:8px;background:transparent;text-align:left}
.chief-navigation button:hover{background:var(--surface-hover)}
.chief-wordmark{display:flex;gap:9px;align-items:center;margin:0 12px 22px;color:inherit;font-size:19px;letter-spacing:-.02em}
.chief-wordmark svg,.chief-topic-mark{flex:none}.chief-wordmark b{font-weight:650}
.chief-navigation .chief-home{display:flex;flex:none;align-items:center;gap:10px;padding:9px 10px;min-height:56px;font-weight:600}
.chief-home small{display:block;font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary,var(--surface-dim));margin-top:2px}
.chief-hub-mark{width:34px;height:34px;flex:none;display:grid;place-items:center;border-radius:11px;background:color-mix(in srgb,var(--chief-action) 12%,transparent);color:var(--chief-action)}
.chief-navigation .is-active{background:var(--dsw-alias-bg-base,#fff);box-shadow:0 1px 3px #00000008;font-weight:600;color:var(--chief-action)}
.chief-nav-heading{display:flex;flex:none;align-items:center;justify-content:space-between;margin:23px 10px 7px;color:var(--surface-dim);font-size:12px}
.chief-nav-heading button{font-size:21px;line-height:26px;width:26px;text-align:center}
.chief-conversations{overflow:auto;flex:1;min-height:50px}
.chief-conversations>button{width:100%;display:flex;align-items:flex-start;gap:9px;font-size:12px;line-height:1.6;padding:10px;margin:3px 0}
.chief-conversations>button>span:last-child{min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.chief-topic-mark{color:var(--surface-dim)}.chief-conversations>p{margin:0;padding:9px 10px;color:var(--surface-dim);font-size:12px}
.chief-navigation footer{border-top:1px solid var(--surface-rule);padding-top:9px;flex:none}
.chief-navigation footer button{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;min-height:35px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--surface-dim))}
.chief-navigation footer button span{font-size:16px}
.chief-topic-form{margin:0 6px 12px}.chief-topic-form input{width:100%;padding:8px;border:1px solid var(--surface-rule);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:12px}
.chief-topic-form button{padding:7px 4px;font-size:12px}.chief-nav-error{font-size:11px;color:#a43e36}
.chief-mobile-bar,.chief-nav-scrim{display:none}
@media(max-width:1000px) and (min-width:761px){
  .chief-navigation{width:166px;padding-inline:10px}.chief-surface-content .chief-rooms{grid-template-columns:minmax(0,1fr) 250px}
}
@media(max-width:760px){
  .chief-surface{flex-direction:column}
  .chief-mobile-bar{display:flex;min-height:48px;align-items:center;justify-content:space-between;gap:8px;padding:0 12px;border-bottom:1px solid var(--surface-rule)}
  .chief-mobile-brand{display:flex;align-items:center;gap:5px}
  .chief-mobile-bar b{font-size:15px;font-weight:650;letter-spacing:-.015em}
  .chief-mobile-bar nav{display:flex;align-items:center;gap:2px}
  .chief-mobile-bar button{border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,var(--surface-dim));font:inherit;font-size:12px;min-height:36px;padding:6px 8px;white-space:nowrap}
  .chief-mobile-bar button:is([aria-current=page],[aria-expanded=true]){background:color-mix(in srgb,var(--chief-action) 10%,transparent);color:var(--chief-action);font-weight:600}
  .chief-navigation,.chief-navigation .chief-home,.chief-wordmark{display:none}
  .navigation-open .chief-navigation{display:flex;position:absolute;inset:48px auto 0 0;width:min(260px,100%);z-index:90;padding-top:10px}
  .chief-nav-scrim{position:absolute;inset:48px 0 0;border:0;background:#0004;z-index:80}.navigation-open .chief-nav-scrim{display:block}
  .chief-surface-content .chief-rooms{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr)}
  .chief-nav-heading{margin-top:0}
}
`
