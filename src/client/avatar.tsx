/** Original vector characters: a shared face language, a small tool of each trade. */
import { useId } from 'react'
import { staffKey } from './staff-names.ts'
const looks: Record<string, { paint: string; wash: string; kind: string }> = {
  lead: { paint: '#4d6bfe', wash: '#edf0ff', kind: 'lead' },
  researcher: { paint: '#d58b55', wash: '#fbefe4', kind: 'researcher' }, engineer: { paint: '#348b7a', wash: '#e4f2ed', kind: 'engineer' },
  reviewer: { paint: '#8b6ac3', wash: '#f0eafb', kind: 'reviewer' }, strategist: { paint: '#bd9651', wash: '#f8f0df', kind: 'strategist' },
  chief: { paint: '#bd9651', wash: '#f8f0df', kind: 'strategist' }, scribe: { paint: '#6b91aa', wash: '#e8f3f8', kind: 'researcher' }, liaison: { paint: '#5f8f6a', wash: '#e7f2ea', kind: 'engineer' }, 'ui-smith': { paint: '#c87f9c', wash: '#faebf2', kind: 'engineer' },
  you: { paint: '#6b7b91', wash: '#edf0f5', kind: 'you' },
}
export function Avatar({ who, size = 38, working = false }: { who: string; size?: number; working?: boolean }) {
  const id = useId().replace(/:/g, '')
  // 按花名册解析：幕僚 id liaison 是外务（不是接口人），书记官的 id 是 scribe。
  who = staffKey(who)
  const fallback = ['researcher', 'engineer', 'reviewer', 'strategist'][Array.from(who).reduce((n, c) => n + c.codePointAt(0)!, 0) % 4]!
  const look = looks[who] ?? looks[fallback]!
  return <span className={`chief-character ${working ? 'is-working' : ''}`} style={{ width: size, height: size, flex: 'none' }} aria-hidden="true">
    <svg viewBox="0 0 48 48" width={size} height={size} fill="none">
      <defs><linearGradient id={id} x1="9" y1="5" x2="37" y2="45" gradientUnits="userSpaceOnUse"><stop stopColor={look.paint} stopOpacity=".86" /><stop offset="1" stopColor={look.paint} /></linearGradient></defs>
      <rect x="1" y="1" width="46" height="46" rx="16" fill={look.wash} />
      {look.kind === 'you' ? <><circle cx="24" cy="19" r="7" fill={look.paint} /><path d="M12 38c0-8 4-12 12-12s12 4 12 12" fill={look.paint} /></> : <>
        {look.kind === 'engineer' ? <><rect x="10" y="13" width="29" height="26" rx="9" fill={`url(#${id})`} /><path d="m7 22-3 4 3 4m34-8 3 4-3 4" stroke={look.paint} strokeWidth="2" strokeLinecap="round" /></> : look.kind === 'reviewer' ? <path d="m24 10 15 7v12c0 7-8 12-15 14-7-2-15-7-15-14V17l15-7Z" fill={`url(#${id})`} /> : look.kind === 'strategist' ? <path d="m11 13 10 5h6l10-5v19c0 7-5 10-13 10S11 39 11 32V13Z" fill={`url(#${id})`} /> : <path d="M9 26c0-10 5-16 15-16s16 7 16 17c0 10-6 15-16 15S9 36 9 26Z" fill={`url(#${id})`} />}
        <g className="chief-character-eyes" stroke="white" strokeWidth="2.5" strokeLinecap="round">
          <path d={look.kind === 'lead' ? 'M17 25c1-2 3-2 4 0m7 0c1-2 3-2 4 0' : 'M18 24v3m12-3v3'} />
        </g>
        <path d="M22 33c1.5 1 3 1 4 0" stroke="white" strokeOpacity=".7" strokeWidth="1.3" strokeLinecap="round" />
        {look.kind === 'lead' && <><path d="m30 10 3-5" stroke={look.paint} strokeWidth="1.7" strokeLinecap="round" /><circle cx="34" cy="5" r="2.5" fill={look.paint} /><path d="m7 11 1 2.5 2.5 1-2.5 1L7 18l-1-2.5-2.5-1 2.5-1L7 11Z" fill={look.paint} opacity=".5" /></>}
        {look.kind === 'researcher' && <><circle cx="19" cy="25" r="6" stroke="#714b35" strokeWidth="1.2" /><circle cx="31" cy="25" r="6" stroke="#714b35" strokeWidth="1.2" /><path d="M25 24h1M14 10l6-3 3 2" stroke={look.paint} strokeWidth="2" strokeLinecap="round" /></>}
        {look.kind === 'engineer' && <><rect x="20" y="8" width="10" height="5" rx="2" fill={look.paint} /><path d="m35 34 2 2 4-4" stroke="#c5e7d4" strokeWidth="1.6" strokeLinecap="round" /></>}
        {look.kind === 'reviewer' && <path d="m31 12 2 2 5-5" stroke={look.paint} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        {look.kind === 'strategist' && <><path d="m20 10 4-4 4 4" stroke={look.paint} strokeWidth="1.6" strokeLinecap="round" /><circle cx="24" cy="8" r="1.5" fill={look.paint} /></>}
      </>}
      {working && <circle cx="42" cy="41" r="4" fill="#36a577" stroke="white" strokeWidth="2" />}
    </svg>
  </span>
}
export const AVATAR_CSS = `.chief-character{display:inline-flex;vertical-align:middle;border-radius:34%;overflow:visible}.chief-character svg{overflow:visible}.chief-character-eyes{transform-origin:24px 25px;transition:transform .18s ease}.chief-character:hover .chief-character-eyes{transform:translateY(-1px)}.chief-character.is-working svg{filter:drop-shadow(0 2px 4px #4d6bfe18)}@media(prefers-reduced-motion:reduce){.chief-character-eyes{transition:none}}`
