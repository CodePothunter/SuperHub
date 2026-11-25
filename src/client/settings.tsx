/**
 * 设置：大多数也可以直接跟接口人说；这里给喜欢自己点的人，以及只能在这里做的事（手机访问的密码）。
 * 经手机访问端口打开时，服务端会拒绝这些接口，这里只显示说明。
 */
import { useEffect, useState } from 'react'
import { api, type SettingsView } from './api.ts'
import { Shell } from './drawers.tsx'
import { SettingsDiagnostics } from './settings-diagnostics.tsx'
import { ModelPicker, type ModelValue } from './model-select.tsx'

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return <label className="wr-field"><span className="label">{label}</span>{children}{hint && <span className="hint">{hint}</span>}</label>
}

export function SettingsDrawer({ close, refresh, modal = false }: { close: () => void; refresh: () => Promise<void>; modal?: boolean }) {
  const [s, setS] = useState<SettingsView>()
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const [denied, setDenied] = useState(false)
  const [zone, setZone] = useState('')
  const [conc, setConc] = useState(2)
  const [notify, setNotify] = useState('')
  const [model, setModel] = useState<ModelValue>({ model: '', effort: '' })
  const [port, setPort] = useState(50388)
  const [password, setPassword] = useState('')
  const [brain, setBrain] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const next = await api<SettingsView>('/settings')
      setS(next); setZone(next.timeZone); setConc(next.concurrency); setNotify(next.notifyUrl ?? ''); setModel({ model: next.liaisonModel ?? '', effort: next.liaisonReasoningEffort ?? '' }); setPort(next.mobile.port); setBrain(next.brain ?? '')
    } catch (e) { if (/电脑/.test((e as Error).message)) setDenied(true); else setError((e as Error).message) }
  }
  useEffect(() => { void load() }, [])

  const save = async (path: string, body: unknown, message: string) => {
    setBusy(true); setError(undefined); setSaved(undefined)
    try { await api(path, body); setSaved(message); await load(); await refresh() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  if (denied) return <Shell title="设置" close={close} modal={modal}><div className="wr-empty">设置只能在电脑上的 DSH 里改。也可以直接跟接口人说，比如「早报改到 9 点」「推送发到……」。</div></Shell>
  return (
    <Shell title="设置" close={close} modal={modal} meta={s ? <span>{s.dev ? '开发模式：从 git 源码运行，界面师可以改源码' : '这些也可以直接跟接口人说'}</span> : undefined}>
      {!s ? <div className="wr-empty">{error ?? '正在读取'}</div> : <div className="wr-settings">
        {error && <div className="wr-err">{error}</div>}
        {saved && <div className="wr-ok">{saved}</div>}

        <h3>幕僚团</h3>
        <Field label="时区" hint="定时安排、到期提醒、安静时段都按这个时区。">
          <input value={zone} onChange={e => setZone(e.target.value)} spellCheck={false} placeholder="Asia/Shanghai" />
        </Field>
        <Field label="同时干活的幕僚" hint="1 到 6。多了更快，也更费模型额度。">
          <input type="number" min={1} max={6} value={conc} onChange={e => setConc(Number(e.target.value))} />
        </Field>
        <Field label="推送地址" hint={<>有事等你决定时推送到这里（晚上 10 点半到早上 8 点不推）。支持 ntfy、飞书机器人，或任何接收 JSON {'{text}'} 的地址。留空时在 SuperHub 内提醒。</>}>
          <input value={notify} onChange={e => setNotify(e.target.value)} spellCheck={false} placeholder="https://ntfy.sh/你的主题" />
        </Field>
        {/* key：重新读取设置后，以新保存的值作为“已保存”基准 */}
        <ModelPicker key={`${s.liaisonModel ?? ''}|${s.liaisonReasoningEffort ?? ''}`} layout="field" label="接口人的模型" effortLabel="接口人的思考深度" value={model} onChange={setModel} disabled={busy}
          hint="只影响跟你对话的接口人，下一句话起生效；幕僚（含研判官）的模型在幕僚卡里改。选项来自 DSH 的模型目录。" />
        <div className="row"><button className="go" disabled={busy} onClick={() => save('/settings', { timeZone: zone.trim(), concurrency: conc, notifyUrl: notify.trim(), liaisonModel: model.model, liaisonReasoningEffort: model.effort }, '已保存。')}>保存</button></div>

        {s.liaisonTools && <SettingsDiagnostics tools={s.liaisonTools} className="wr-fold"/>}

        <h3>手机访问</h3>
        <div className="wr-note">手机浏览器通过独立端口和密码打开 SuperHub。该端口使用未加密的 HTTP，适合在可信网络内使用。跨公网使用时请配置 HTTPS 反向代理。也可以通过 dsh-go 连接。</div>
        <Field label="状态">
          <span>{s.mobile.enabled ? (s.mobile.running ? `已开启，端口 ${s.mobile.port}` : `开启失败：${s.mobile.problem ?? '原因不明'}`) : '关闭'}{s.mobile.enabled && !s.mobile.hasPassword ? '，还没设密码' : ''}</span>
        </Field>
        {s.mobile.enabled && s.mobile.addresses.length > 0 && <Field label="局域网地址" hint="公网访问用服务器的公网 IP 加这个端口，并确认防火墙放行。">
          <span className="mono">{s.mobile.addresses.join('  ')}</span></Field>}
        <Field label="端口"><input type="number" min={1024} max={65535} value={port} onChange={e => setPort(Number(e.target.value))} /></Field>
        <div className="row">
          {s.mobile.enabled
            ? <><button disabled={busy} onClick={() => save('/settings', { mobile: { port } }, '端口已更新。')}>换端口</button><button className="stop" disabled={busy} onClick={() => save('/settings', { mobile: { enabled: false } }, '手机访问已关闭。')}>关闭手机访问</button></>
            : <button className="go" disabled={busy} onClick={() => save('/settings', { mobile: { enabled: true, port } }, '手机访问已开启。')}>开启手机访问</button>}
        </div>
        <Field label={s.mobile.hasPassword ? '换密码' : '设置密码'} hint="至少 8 位。只保存哈希；换密码后所有手机要重新登录。密码不要发给接口人，对话内容会发给模型。">
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <div className="row"><button className="go" disabled={busy || password.length < 8} onClick={async () => { await save('/settings/password', { password }, '密码已设置。'); setPassword('') }}>保存密码</button></div>

        <h3>第二大脑</h3>
        <Field label="位置" hint="换到另一个文件夹：空文件夹会新建，已有的第二大脑会原样接着用。换了之后接口人会开一段新对话（对话绑定在文件夹上），原来的文件夹和对话都还在。">
          <input value={brain} onChange={e => setBrain(e.target.value)} spellCheck={false} />
        </Field>
        <div className="row"><button disabled={busy || !brain.trim() || brain.trim() === s.brain} onClick={() => { if (confirm(`把第二大脑换到 ${brain.trim()}？`)) void save('/settings/brain', { dir: brain.trim() }, '已换好。') }}>换到这里</button></div>
        {!s.git && <div className="wr-note">这台机器上没有 git：照样能用，只是改动不会留历史。</div>}
      </div>}
    </Shell>
  )
}
