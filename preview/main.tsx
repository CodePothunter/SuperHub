/** 设计预览：用假数据渲染作战室，不碰真实的第二大脑。只用于开发时截图检查。 */
import { createRoot } from 'react-dom/client'
import { App } from '../src/client/app.tsx'
import { CHAT, FIXTURE, PERSON, LINE } from './fixture.ts'

window.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  const body = url.includes('/chat') ? CHAT : url.includes('/state') ? FIXTURE : url.includes('/people/') ? PERSON : url.includes('/lines/') ? LINE : { ok: true }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

createRoot(document.getElementById('root')!).render(<App />)
