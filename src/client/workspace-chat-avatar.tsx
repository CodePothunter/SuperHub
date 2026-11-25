import { useLayoutEffect, useRef, type RefObject } from 'react'
import { avatarShapes, type SpeakerPortrait } from '../core/workspace-avatars.ts'
import { avatarDrawing, portraitPaint } from './workspace-avatar-art.tsx'
import { animatePortrait } from './workspace-avatar-motion.ts'

export const chatAvatarStyle = `
.wv2 .v2-chat-avatar { display:block; flex:0 0 auto; width:36px; height:36px; color:var(--v-muted); }
.wv2 .v2-turn .v2-byline strong { min-width:0; overflow-wrap:anywhere; }
@container (max-width:740px) { .wv2 .v2-chat-avatar:not(.v2-avatar-mini) { width:32px; height:32px; } }
`

/** `className` adds a size variant; `v2-avatar-mini` (mention chips, member lists) never plays the arrival motion. */
export function ChatAvatar({portrait, className}: {portrait?: SpeakerPortrait; className?: string}) {
  return <svg className={className ? 'v2-chat-avatar ' + className : 'v2-chat-avatar'} viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false"
    data-shape={portrait?.shape ?? 'neutral'} data-color={portrait?.color ?? 'neutral'}
    style={portrait && portraitPaint(portrait.shape, portrait.color)}>
    {portrait ? <g data-object="">{avatarDrawing[portrait.shape]}</g> : <g stroke="currentColor" strokeWidth="3">
      <circle cx="32" cy="22" r="9"/><path d="M14 53c0-12 8-18 18-18s18 6 18 18" strokeLinecap="round"/>
    </g>}
  </svg>
}

type TimedMessage = {id: string; at: string | number}
/** Record the initial snapshot in full. Only subsequent, newly observed public messages trigger motion. */
export class ConversationArrivals {
  private source?: string
  private seen = new Set<string>()
  private latest = -Infinity

  observe(source: string, messages: readonly TimedMessage[], openedAt: number): Set<string> {
    const initial = this.source !== source
    if (initial) {
      this.source = source
      this.seen.clear()
      this.latest = openedAt
    }
    const floor = this.latest
    const fresh = new Set<string>()
    for (const message of messages) {
      const at = typeof message.at === 'number' ? message.at : Date.parse(message.at)
      if (!initial && !this.seen.has(message.id) && at >= floor) fresh.add(message.id)
      this.seen.add(message.id)
      if (Number.isFinite(at)) this.latest = Math.max(this.latest, at)
    }
    return fresh
  }
}

export function usePortraitArrivals(container: RefObject<HTMLElement | null>, source: string | undefined,
  messages: readonly TimedMessage[] | undefined, observedAt?: number) {
  const tracker = useRef(new ConversationArrivals())
  const playing = useRef(new Set<Animation>())
  useLayoutEffect(() => {
    const active = playing.current
    return () => { for (const animation of active) animation.cancel(); active.clear() }
  }, [source])
  useLayoutEffect(() => {
    if (!source || !messages) return
    const fresh = tracker.current.observe(source, messages, observedAt ?? Date.now())
    if (!fresh.size || !container.current || document.visibilityState === 'hidden') return
    for (const row of Array.from(container.current.querySelectorAll<HTMLElement>('[data-message-id]'))) {
      if (!fresh.has(row.dataset.messageId!)) continue
      const avatar = row.querySelector<SVGSVGElement>('svg.v2-chat-avatar:not(.v2-avatar-mini)')
      const shape = avatarShapes.find(value => value === avatar?.dataset.shape)
      if (!avatar || !shape) continue
      const animation = animatePortrait(avatar, shape)
      if (!animation) continue
      playing.current.add(animation)
      const done = () => { playing.current.delete(animation) }
      animation.finished.then(done, done)
    }
  }, [source, messages, observedAt, container])
}
