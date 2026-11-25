/**
 * 导出：把第二大脑里你确认过的"关于我"带到常用的系统里（ChatGPT、Claude、Claude Code、Codex）。
 * 网页和手机端只能复制粘贴；本机的 Claude Code / Codex 可以自动同步。
 */
import { useEffect, useState } from 'react'
import type { ExportResult, ExportTarget } from '../core/export.ts'
import { Shell } from './drawers.tsx'
import { useLegacyRequest } from './legacy-scope.ts'

type Result = ExportResult & { commands: { session: string; claudeMd: string; codexMd: string } }

const TABS: readonly (readonly [ExportTarget, string])[] = [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['session', 'Claude Code'], ['agents-md', 'Codex 等']]

function Copy({ text, label = '复制' }: { text: string; label?: string }) {
  const [feedback, setFeedback] = useState('')
  return <><button className="go" onClick={async event => {
    const field = event.currentTarget.closest('.wr-export-part')?.querySelector('textarea')
    try { await navigator.clipboard.writeText(text); setFeedback('已复制') }
    catch { field?.focus(); field?.select(); setFeedback('已选中文字，可长按或按 Ctrl+C 复制。') }
  }}>{label}</button>{feedback && <span role="status">{feedback}</span>}</>
}

function Block({ text, rows = 8 }: { text: string; rows?: number }) {
  return <textarea className="prompt" readOnly value={text} rows={rows} onFocus={e => e.currentTarget.select()} />
}

export function ExportDrawer({ close, openImport, modal = false }: { close: () => void; openImport?: () => void; modal?: boolean }) {
  const request = useLegacyRequest()
  const [target, setTarget] = useState<ExportTarget>('chatgpt')
  const [result, setResult] = useState<Result>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let current = true
    setResult(undefined); setError(undefined)
    void request<Result>(`/export?for=${target}`).then(value => {
      if (!current) return
      if (value.target !== target || typeof value.empty !== 'boolean' || !Array.isArray(value.parts)
        || !value.parts.every(p => typeof p.label === 'string' && typeof p.text === 'string')
        || !value.commands || ![value.commands.session, value.commands.claudeMd, value.commands.codexMd].every(c => typeof c === 'string')) throw new Error('导出内容不完整，请重新选择目标。')
      setResult(value)
    }).catch(e => { if (current) setError((e as Error).message) })
    return () => { current = false }
  }, [target,request])

  const hook = result ? JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: result.commands.session }] }] } }, null, 2) : ''
  return (
    <Shell title="导出给常用的助手" close={close} modal={modal} meta={<span>可带走的内容包括已确认的个人资料、工作偏好和当前目标。</span>}>
      <div className="wr-import">
        <div className="wr-chipset">{TABS.map(([id, label]) => <button key={id} className={target === id ? 'on' : ''} aria-pressed={target === id} onClick={() => setTarget(id)}>{label}</button>)}</div>
        {error && <div className="wr-err">{error}</div>}
        {!result || result.target !== target ? !error && <div className="wr-empty" role="status">正在整理</div> : result.empty ? <>
          <p className="wr-note">目前没有可导出的个人资料。{openImport && '你可以导入其他助手的回答，逐条核对并保存。'}</p>
          {openImport && <div className="row"><button className="go" onClick={() => { close(); openImport() }}>去导入</button></div>}
        </> : <>
          {target === 'chatgpt' && <p className="wr-note">打开 ChatGPT 的个性化设置，有"想让它了解你什么"和"希望它怎样回应"两栏，分别贴进去（每栏大约 1500 字以内）。</p>}
          {target === 'claude' && <p className="wr-note">贴进 Claude 设置里的个人偏好；或者只想在某个项目里用，就贴进那个项目的说明。</p>}
          {target === 'session' && <p className="wr-note">在别处开新对话时，把这段贴在最前面。把下面的钩子加进本机的 ~/.claude/settings.json，Claude Code 每次开启会话时都会读取你在 SuperHub 确认的最新内容。</p>}
          {target === 'agents-md' && <p className="wr-note">Codex 读 ~/.codex/AGENTS.md，Claude Code 读 ~/.claude/CLAUDE.md。运行下面的命令会把这个区块写进去，只替换 SuperHub 管理的区块，你自己写的内容不动。想保持同步就用 cron 定时运行。</p>}
          {result.parts.map(p => <div key={p.label} className="wr-export-part">
            <h3>{p.label}{p.limit ? <span className="count">{p.text.length} / {p.limit} 字</span> : null}</h3>
            <Block text={p.text} />
            <div className="row"><Copy text={p.text} /></div>
          </div>)}
          {target === 'session' && <div className="wr-export-part"><h3>Claude Code 钩子（这台机器）</h3><Block text={hook} rows={6} /><div className="row"><Copy text={hook} label="复制钩子配置" /></div></div>}
          {target === 'agents-md' && <div className="wr-export-part"><h3>同步命令（这台机器）</h3><Block text={`${result.commands.codexMd}\n${result.commands.claudeMd}`} rows={3} /><div className="row"><Copy text={`${result.commands.codexMd}\n${result.commands.claudeMd}`} label="复制命令" /></div></div>}
          <p className="wr-note">公司电脑不在自动同步的范围内：要不要带过去，由你自己决定、自己复制。</p>
        </>}
      </div>
    </Shell>
  )
}
