import type { AvatarShape } from '../core/workspace-avatars.ts'

/** Gesture coordinates use the original 64-unit SVG view box. */
const gestures: Record<AvatarShape, {name: string; part?: boolean; origin: string; duration: number; frames: Keyframe[]}> = {
  plane: {
    name: '纸翼滑翔', origin: '31px 32px', duration: 760,
    frames: [
      { transform: 'none' },
      { offset: .24, transform: 'translate(-2px, 2px) rotate(-4deg)' },
      { offset: .61, transform: 'translate(4px, -4px) rotate(2deg)' },
      { transform: 'none' }
    ]
  },
  sprout: {
    name: '叶尖轻摆', part: true, origin: '32px 35px', duration: 720,
    frames: [
      { transform: 'none' },
      { offset: .32, transform: 'rotate(12deg)' },
      { offset: .68, transform: 'rotate(-5deg)' },
      { transform: 'none' }
    ]
  },
  wrench: {
    name: '转动扳手', origin: '43px 21px', duration: 630,
    frames: [
      { transform: 'none' },
      { offset: .20, transform: 'rotate(-5deg)' },
      { offset: .54, transform: 'rotate(14deg)' },
      { offset: .68, transform: 'rotate(14deg)' },
      { transform: 'none' }
    ]
  },
  compass: {
    name: '指针回正', part: true, origin: '31.3px 31.3px', duration: 810,
    frames: [
      { transform: 'none' },
      { offset: .25, transform: 'rotate(-34deg)' },
      { offset: .56, transform: 'rotate(15deg)' },
      { offset: .80, transform: 'rotate(-5deg)' },
      { transform: 'none' }
    ]
  },
  pencil: {
    name: '落笔写一划', origin: '47px 52px', duration: 740,
    frames: [
      { transform: 'none' },
      { offset: .23, transform: 'translate(-4px, -3px) rotate(-7deg)' },
      { offset: .42, transform: 'translate(-4px, 1px) rotate(2deg)' },
      { offset: .72, transform: 'translate(4px, -1px) rotate(-3deg)' },
      { transform: 'none' }
    ]
  },
  lighthouse: {
    name: '灯窗扫光', part: true, origin: '32px 19px', duration: 720,
    frames: [
      { transform: 'none', opacity: 1 },
      { offset: .32, transform: 'translateX(-2.4px) scaleX(.40)', opacity: .68 },
      { offset: .64, transform: 'translateX(2px) scaleX(.76)', opacity: 1 },
      { transform: 'none', opacity: 1 }
    ]
  },
  bell: {
    name: '铃身轻摇', origin: '36px 10px', duration: 760,
    frames: [
      { transform: 'none' },
      { offset: .24, transform: 'rotate(-16deg)' },
      { offset: .52, transform: 'rotate(10deg)' },
      { offset: .76, transform: 'rotate(-4deg)' },
      { transform: 'none' }
    ]
  },
  fan: {
    name: '扇面轻展', origin: '33.1px 51.7px', duration: 680,
    frames: [
      { transform: 'none' },
      { offset: .32, transform: 'rotate(-6deg) scaleX(.66)' },
      { offset: .66, transform: 'rotate(2deg) scaleX(1.02)' },
      { transform: 'none' }
    ]
  },
  key: {
    name: '钥匙转锁', origin: '17.1px 18.5px', duration: 680,
    frames: [
      { transform: 'none' },
      { offset: .28, transform: 'rotate(45deg) scaleY(.76) rotate(-45deg)' },
      { offset: .53, transform: 'rotate(45deg) scaleY(.48) rotate(-45deg)' },
      { offset: .66, transform: 'rotate(45deg) scaleY(.48) rotate(-45deg)' },
      { transform: 'none' }
    ]
  },
  hourglass: {
    name: '沙粒落下', part: true, origin: '32px 35px', duration: 710,
    frames: [
      { transform: 'none', opacity: 1, easing: 'ease-in' },
      { offset: .57, transform: 'translateY(5.5px)', opacity: 1 },
      { offset: .68, transform: 'translateY(6.5px)', opacity: 0 },
      { offset: .73, transform: 'translateY(-2px)', opacity: 0 },
      { transform: 'none', opacity: 1 }
    ]
  }
}

const playing = new WeakMap<SVGSVGElement, Animation>()

export function animatePortrait(svg: SVGSVGElement, shape: AvatarShape) {
  playing.get(svg)?.cancel()
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  const gesture = gestures[shape]
  const target = svg.querySelector(gesture.part ? '[data-moving]' : '[data-object]')
  if (preference.matches || !target?.animate) return
  const frames = gesture.frames.map(frame => ({
    transformOrigin: gesture.origin, transformBox: 'view-box', easing: 'cubic-bezier(.35, 0, .28, 1)', ...frame
  }))
  const animation = target.animate(frames, {duration: gesture.duration})
  playing.set(svg, animation)
  const stop = () => animation.cancel()
  const release = () => {
    preference.removeEventListener('change', stop)
    if (playing.get(svg) === animation) playing.delete(svg)
  }
  preference.addEventListener('change', stop)
  animation.finished.then(release, release)
  return animation
}
