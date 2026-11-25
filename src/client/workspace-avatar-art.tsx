import type { CSSProperties, ReactNode } from 'react'
import type { AvatarColor, AvatarShape } from '../core/workspace-avatars.ts'

/** The approved 64-unit object drawings. Every palette shares the exact same silhouette. */
export const avatarDrawing: Record<AvatarShape, ReactNode> = {
  plane: <>
    <path fill="var(--portrait-deep,#405BB6)" d="M4.9 29.7 56.3 6.1q2.3-1 2 1.6l-9.2 45.9q-.4 2-2.1 1.2L33.9 48l-8.5 8q-1.3 1.2-1.7-.5L19.9 39 5.4 33.1q-3.3-1.4-.5-3.4Z"/>
    <path fill="var(--portrait-light,#90ABFF)" d="M5 29.2 56.7 6.1q1.2-.5 1.3.2L22.3 36.9 5.4 31.6q-2.7-.8-.4-2.4Z"/>
    <path fill="var(--portrait-shade,#4969D8)" d="m22.3 36.9 35.5-30.6-30 36.6L25 54.7l-2.7-17.8Z"/>
    <path fill="var(--portrait-body,#6685EF)" d="m27.8 42.9 30-36.6q.8-.5.6.9l-10 44.6q-.2 1.4-1.6.7l-19-9.6Z"/>
  </>,
  sprout: <>
    <g data-moving="leaves"><path fill="var(--portrait-light,#6EDDB9)" d="M32.2 34.6C29 20.8 39.2 7.4 54.8 4.6q1.8-.3 1.6 1.6c-.9 13.1-8.8 27.5-24.2 28.4Z"/><path fill="var(--portrait-shade,#3CAD93)" d="M32.2 34.6C39.8 28 47.3 18.8 53.3 9.1c-2.5 11.5-10.6 23.4-21.1 25.5Z"/><path fill="var(--portrait-body,#50BE94)" d="M30.6 33.9C18.5 36.3 8.4 27.2 5.5 14.8q-.4-1.7 1.6-1.8c13.5-.3 23.2 7.3 23.5 20.9Z"/><path d="M13.7 19.1c9.4 5.5 14.4 10.8 17.9 20m-.1-1.3c.9-4.3 5.4-11.7 11.5-18.2" stroke="var(--portrait-detail,#388675)" strokeWidth="2.4" strokeLinecap="round"/></g>
    <path fill="var(--portrait-deep,#388C7C)" d="m24.5 39.2 15-3.2.8 21.9q.1 2-1.5 1l-5.2-3.6-4.9 5.1q-1.1 1.1-1.4-.3l-2.8-20.9Z"/>
    <path fill="var(--portrait-accent,#77DBC2)" d="m23.4 36.6 14.8-3 .8 22.9-6.8-4.4-6.1 6.5-2.7-22Z"/>
  </>,
  wrench: <>
    <path fill="var(--portrait-deep,#BE7553)" fillRule="evenodd" d="M47.1 6.7q1.8.3.4 1.8l-8.4 9.2 2 7.2 7.1 1.8 8.9-8.8q1.5-1.5 1.9.5c1.5 11-6.4 20.5-17.5 20.6l-4.9-.6L19.3 57.9c-3.4 3.8-8.2 4-11.7.8-3.4-3.3-3.2-8.1.1-11.4L27 28.1c-4.6-11.7 6.9-24.5 20.1-21.4Zm-34.5 42.9-3.4 3.1.9 3.5 3.8 1 3.3-2.9-1-3.8-3.6-.9Z"/>
    <path fill="var(--portrait-body,#F3A76E)" fillRule="evenodd" d="M46.6 4.9q1.9.3.4 1.8l-8.7 9.4 1.9 7.4 7.2 1.7 9.1-9q1.4-1.3 1.7.7c1.1 10.6-6.3 19.5-17.3 19.7l-5.6-.6-17.4 20.5c-3 3.3-7.5 3.8-10.5.8-3-3-2.8-7.6.3-10.7l19.6-20.4C22.7 15 33.6 2.8 46.6 4.9ZM12.6 49.6l-3.4 3.1.9 3.5 3.8 1 3.3-2.9-1-3.8-3.6-.9Z"/>
    <path fill="var(--portrait-light,#FFBF86)" d="M46.6 4.9q1.9.3.4 1.8l-8.7 9.4 1.9 7.4-6.6-4.3.4-7.9c3.5-4.6 7.9-6.6 12.6-6.4Z"/>
  </>,
  compass: <>
    <ellipse cx="32.7" cy="33.6" rx="25.5" ry="25.2" fill="var(--portrait-deep,#425BBA)"/>
    <circle cx="31.6" cy="30.7" r="25" fill="var(--portrait-body,#6887ED)"/>
    <g data-moving="needle"><path d="m44.2 14.7-7.4 20.5-11.4-7.5 18.8-13Z" fill="var(--portrait-light,#F1F7FF)"/><path d="m25.4 27.7 11.4 7.5-18.7 12.5 7.3-20Z" fill="var(--portrait-accent,#80E1C8)"/></g>
  </>,
  pencil: <>
    <g transform="rotate(-39 32 32)"><path d="M22.8 8.2q0-3.8 3.8-3.8h10.8q3.8 0 3.8 3.8v34.4l-9.1 16.5-9.3-16.5Z" fill="var(--portrait-body,#F1B468)"/><path d="M35.5 4.4h1.9q3.8 0 3.8 3.8v34.4l-5.7 1.9Z" fill="var(--portrait-shade,#C88751)"/><path d="m22.8 42.6 4.8 1.6 4.1-2.4 3.8 2.7 5.7-1.9-8.1 15.7q-1.1 2.1-2.2 0Z" fill="var(--portrait-light,#FFDAAB)"/><path d="m28 52.8 3.8.8 4.3-.8-3 5.5q-1.1 2.1-2.2 0Z" fill="var(--portrait-detail,#57586C)"/></g>
  </>,
  lighthouse: <>
    <path fill="var(--portrait-light,#FFE0C5)" d="M25 26h14l7 29H18z"/>
    <path fill="var(--portrait-body,#E77969)" d="m23.8 31.2 15.5-4 2.4 9.9-20.5 5.3z"/>
    <path fill="var(--portrait-shade,#BC5A58)" d="m36.3 27 2.9-.6 7 29-5.7.1z"/>
    <path fill="var(--portrait-deep,#934F52)" d="M18.4 53.4h27.3q2.8 0 3.3 2.3l.8 3H14.6l.8-3q.5-2.3 3-2.3Z"/>
    <path fill="var(--portrait-deep,#934F52)" d="M23.4 14.2h17.2v10.4H23.4z"/>
    <path data-moving="lamp" fill="var(--portrait-accent,#FFCA81)" d="M26.7 15.5h10.6V23H26.7z"/>
    <path fill="var(--portrait-body,#E77969)" d="M19 13.7 30.5 5q1.5-1.1 3 0L45 13.7q1.3 1-.8 1.4H19.8q-2.1-.4-.8-1.4Z"/>
    <path fill="var(--portrait-shade,#BC5A58)" d="M20 23.4h24q1.9 0 1.3 1.8l-.7 2q-.5 1.1-2 1.1H21.4q-1.5 0-2-1.1l-.7-2q-.6-1.8 1.3-1.8Z"/>
  </>,
  bell: <>
    <g data-moving="bell"><g transform="translate(4 0) rotate(9 32 12)"><path fill="var(--portrait-shade,#C89246)" d="M28.5 13.8V9a4.4 4.4 0 0 1 8.8 0v4.8h-2.8V9a1.6 1.6 0 0 0-3.2 0v4.8Z"/><path fill="var(--portrait-deep,#A66B39)" d="M26.3 47.3h13.1v3.1a6.6 6.6 0 0 1-13.1 0z"/><path fill="var(--portrait-body,#F0B758)" d="M12.3 40.7c4.3-4.8 5.3-8.2 5.6-14.8.4-8.9 6-15.3 15-15.3s14.2 6.8 14.7 15.3c.4 6.7 1.7 11 5.6 15.4q1.7 1.9 1 4.1H10.7q-.4-2.5 1.6-4.7Z"/><path fill="var(--portrait-shade,#C89246)" d="M37.8 11.5c6.3 2 9.4 7.5 9.8 14.4.4 6.7 1.7 11 5.6 15.4l-9.3.1c-3.3-5.6-3.4-11.5-3.1-17.2.3-5.7-.8-9.6-3-12.7Z"/><path fill="var(--portrait-light,#FAD18D)" d="M13.3 40.3h38.4c2.3 0 3.7 1.8 3.7 4v1.3q0 2.5-2.8 2.5h-40q-2.8 0-2.8-2.5v-1.3c0-2.2 1.4-4 3.5-4Z"/></g></g>
  </>,
  fan: <>
    <g data-moving="fan"><path fill="var(--portrait-body,#9C83DB)" d="M4.6 29.8 8.8 17l7.8-1.4 5.5-5.4 9 .6 6.7-3 8.7 4.1 6.8.6 4.7 9.7 2.4 4.9q.9 1.9-.8 3L34.7 52.8q-1.6 1.2-3.2-.1L5.5 32.9q-1.7-1.3-.9-3.1Z"/><path fill="var(--portrait-light,#C5B1ED)" d="m8.8 17 7.8-1.4L33 50.7 5.5 32.9q-1.7-1.3-.9-3.1Zm13.3-6.8 9 .6 2 39.9Z"/><path fill="var(--portrait-shade,#7863B7)" d="m37.8 7.8 8.7 4.1-13.4 38.8ZM53.3 12.5l4.7 9.7 2.4 4.9q.9 1.9-.8 3L33.1 50.7Z"/><path fill="var(--portrait-detail,#85669C)" d="m6.3 31.1 27 18.2 25.8-21.6 2 2.4-25.6 23.1 3.7 2.8-2.1 2.8-4.2-3.3-3.2 2.9-2.4-2.6 3-2.9L4.4 33.5Z"/><circle cx="33.1" cy="51.7" r="2.1" fill="var(--portrait-accent,#F5C58D)"/></g>
  </>,
  key: <>
    <g data-moving="key"><path fill="var(--portrait-shade,#42939D)" fillRule="evenodd" d="M20.3 7.8a14.5 14.5 0 1 0 5.8 27.8l20.1 20.1q1 1 2 .2l7-5.8-4.9-5 4.9-4.8-5.7-5.7-5.2 4.7-10.8-10.9A14.5 14.5 0 0 0 20.3 7.8Zm-3.1 8.2a4.9 4.9 0 1 1 0 9.8 4.9 4.9 0 0 1 0-9.8Z"/><path fill="var(--portrait-body,#73C3C3)" fillRule="evenodd" d="M20.1 5.8a14.5 14.5 0 1 0 5.8 27.8l20.6 20.6q1 1 2 .2l5.8-6-4.8-4.9 4.9-4.8-5.5-5.5-5.2 4.8L33 27.2A14.5 14.5 0 0 0 20.1 5.8Zm-3 7.1a5.6 5.6 0 1 1 0 11.2 5.6 5.6 0 1 1 0-11.2Z"/><path fill="var(--portrait-light,#ABE2DD)" d="M20.1 5.8c5.3 0 10 2.8 12.5 7l-9.3 3a6 6 0 0 0-10.7-1l-6 1.9a14.5 14.5 0 0 1 13.5-10.9Z"/></g>
  </>,
  hourglass: <>
    <path fill="var(--portrait-light,#BBD9F0)" d="M15.7 11.5h32.6c-.1 9.6-5.5 15.3-11.6 20.5 6.1 5.2 11.5 10.9 11.6 20.5H15.7c.1-9.6 5.5-15.3 11.6-20.5-6.1-5.2-11.5-10.9-11.6-20.5Z"/>
    <path fill="var(--portrait-body,#78A9D6)" d="M43.6 11.5h4.7c-.1 9.6-5.5 15.3-11.6 20.5 6.1 5.2 11.5 10.9 11.6 20.5h-4.7c-.7-8.2-4.7-13.2-10.6-18.7q-1.9-1.8 0-3.6c5.9-5.5 9.9-10.5 10.6-18.7Z"/>
    <path fill="var(--portrait-accent,#F4B56F)" d="M22.1 19.5h19.8c-2.2 4.2-6.3 7.9-9.9 11-3.6-3.1-7.7-6.8-9.9-11Zm-1.3 31.4q.4-2.1 2.6-3.2l7-4.7q1.7-1.2 3.4 0l6.8 4.6q2.3 1.4 2.7 3.3Z"/>
    <path data-moving="grain" fill="var(--portrait-detail,#B8794C)" d="M30.9 33.1q1.1-1.7 2.2 0l.7 1.5a2 2 0 1 1-3.6 0Z"/>
    <path fill="var(--portrait-deep,#546F9E)" d="M15 6h34q2.4 0 2.4 2.5v2.8q0 2.4-2.4 2.4H15q-2.4 0-2.4-2.4V8.5Q12.6 6 15 6Zm0 44.3h34q2.4 0 2.4 2.4v2.8q0 2.5-2.4 2.5H15q-2.4 0-2.4-2.5v-2.8q0-2.4 2.4-2.4Z"/>
  </>,
}

const originalPaint: Partial<Record<AvatarShape, AvatarColor>> = {
  plane: 'blue', sprout: 'mint', wrench: 'apricot', compass: 'blue', pencil: 'honey'
}

const paint: Record<AvatarColor, CSSProperties & Partial<Record<`--portrait-${string}`, string>>> = {
  blue: {
    '--portrait-body': '#6685EF', '--portrait-shade': '#4969D8', '--portrait-deep': '#405BB6',
    '--portrait-light': '#A3B9FF', '--portrait-accent': '#80E1C8', '--portrait-detail': '#3F526D'
  },
  mint: {
    '--portrait-body': '#64CAAB', '--portrait-shade': '#42A88E', '--portrait-deep': '#317D70',
    '--portrait-light': '#A6EAD6', '--portrait-accent': '#F2C883', '--portrait-detail': '#386C61'
  },
  apricot: {
    '--portrait-body': '#F3A76E', '--portrait-shade': '#D58B58', '--portrait-deep': '#AF694A',
    '--portrait-light': '#FFD09B', '--portrait-accent': '#81BADD', '--portrait-detail': '#785942'
  },
  violet: {
    '--portrait-body': '#A28ADF', '--portrait-shade': '#826AB9', '--portrait-deep': '#68559C',
    '--portrait-light': '#D1BEF2', '--portrait-accent': '#FFBF9E', '--portrait-detail': '#66556E'
  },
  rose: {
    '--portrait-body': '#E57D8B', '--portrait-shade': '#C15D73', '--portrait-deep': '#9B4860',
    '--portrait-light': '#FFC0CB', '--portrait-accent': '#A4DCC4', '--portrait-detail': '#794955'
  },
  teal: {
    '--portrait-body': '#60B8C9', '--portrait-shade': '#3794A7', '--portrait-deep': '#2B7088',
    '--portrait-light': '#AAE0E8', '--portrait-accent': '#FFAB97', '--portrait-detail': '#38677B'
  },
  honey: {
    '--portrait-body': '#EDBD54', '--portrait-shade': '#C89442', '--portrait-deep': '#9B7036',
    '--portrait-light': '#FFE3A3', '--portrait-accent': '#9CACEF', '--portrait-detail': '#79603D'
  },
}

export const portraitPaint = (shape: AvatarShape, color: AvatarColor) =>
  originalPaint[shape] === color ? undefined : paint[color]
