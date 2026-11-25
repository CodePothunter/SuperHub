import { isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { V2Brand } from '../src/client/workspace-v2.tsx'
import { WORKSPACE_V2_STYLE } from '../src/client/workspace-v2-style.ts'

it('makes the SuperHub mark a real button home to 「今天」 that looks like the plain mark', () => {
  const home = vi.fn()
  const html = renderToStaticMarkup(<V2Brand home={home}/>)
  // A native button: Enter and Space activate it from the keyboard, and it is reachable with Tab.
  expect(html).toMatch(/^<button type="button" class="v2-brand" aria-label="SuperHub 首页">/)
  expect(html).toContain('SuperHub</button>')
  const element = V2Brand({home}) as ReactElement<{onClick: () => void}>
  expect(isValidElement(element) && element.type).toBe('button')
  element.props.onClick()
  expect(home).toHaveBeenCalledTimes(1)
  // Same look as before: no button chrome, the mark's own font, a pointer, and the shared focus ring.
  const rule = WORKSPACE_V2_STYLE.match(/\.wv2 \.v2-brand \{([^}]*)\}/)?.[1] ?? ''
  for (const part of ['padding:0', 'border:0', 'background:none', 'font:720 23px/1.1 var(--v-font)', 'cursor:pointer']) expect(rule).toContain(part)
  expect(WORKSPACE_V2_STYLE).toMatch(/\.wv2 :is\(button,[^)]*\):focus-visible \{ outline:3px solid var\(--hub-brand\); outline-offset:2px; \}/)
  expect(WORKSPACE_V2_STYLE).toMatch(/@container\(max-width:740px\) \{[^@]*\.wv2 \.v2-brand \{ font-size:21px; gap:6px; \}/)
})
