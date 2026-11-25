/** Choose local storage once before opening the business workspace. */
import { useState } from 'react'
import { api, type SetupState } from './api.ts'
import { CSS } from './style.ts'

export function Setup({ state, refresh }: { state: SetupState; refresh: () => Promise<void> }) {
  const [dir, setDir] = useState(state.setup.suggested)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async () => {
    setBusy(true); setError(undefined)
    try { await api('/setup', { dir }); await refresh() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="wr wr-setup">
      <style>{CSS}</style>
      <div className="wr-setup-in">
        <h1>启用 SuperHub</h1>
        <div className="wr-msg liaison">
          <p>选择这台电脑上存放工作资料的文件夹。工作区、会话、工单和交付物会保存在这里。</p>
        </div>
        {state.setup.problem && <div className="wr-alert">{state.setup.problem}</div>}
        <form className="wr-setup-form" onSubmit={e => { e.preventDefault(); void submit() }}>
          <input value={dir} onChange={e => setDir(e.target.value)} aria-label="第二大脑的文件夹" spellCheck={false} autoCapitalize="off" />
          <button className="go" disabled={busy || !dir.trim()}>{busy ? '正在准备' : '打开 SuperHub'}</button>
        </form>
        {error && <div className="wr-err">{error}</div>}
        <div className="hint">可以选择新文件夹，也可以使用已有的第二大脑。{state.setup.git ? '' : '安装 Git 后可为资料保留版本历史。'}</div>
      </div>
    </div>
  )
}
