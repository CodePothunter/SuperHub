import { useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError, type SettingsView } from './api.ts'
import { ModelPicker } from './model-select.tsx'
import { SettingsDiagnostics } from './settings-diagnostics.tsx'
import type { Scoped } from './superhub-api.ts'
import { clearV2PrivateCache, scopedResource, useV2Read, V2Client } from './workspace-v2-api.ts'
import { Issue } from './workspace-v2-elements.tsx'

type StaffEntry = {id:string; name:string; executor:string; brief:string}
interface SettingsPage extends Scoped {
  timeZone:string; concurrency:number; activeModel?:string
  admin?:{settings:SettingsView; staff:StaffEntry[]}
}
const object = (v:unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const texts = (v:unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
export function isWorkspaceSettings(value: unknown): value is SettingsPage {
  if (!object(value) || typeof value.scope !== 'string' || !value.scope || typeof value.timeZone !== 'string' || !value.timeZone ||
    !Number.isInteger(value.concurrency) || typeof value.concurrency !== 'number' || value.concurrency < 1 || value.concurrency > 6 ||
    (value.activeModel !== undefined && typeof value.activeModel !== 'string')) return false
  if (value.admin === undefined) return true
  if (!object(value.admin) || !object(value.admin.settings) || !Array.isArray(value.admin.staff)) return false
  const s = value.admin.settings, m = s.mobile, tools = s.liaisonTools
  return s.timeZone === value.timeZone && s.concurrency === value.concurrency && object(m) &&
    typeof m.enabled === 'boolean' && typeof m.running === 'boolean' && typeof m.hasPassword === 'boolean' && Number.isInteger(m.port) && texts(m.addresses) &&
    ['brain','notifyUrl','liaisonModel','liaisonReasoningEffort'].every(key => s[key] === undefined || typeof s[key] === 'string') &&
    (tools === undefined || object(tools) && Array.isArray(tools.sessions) && tools.sessions.every(row => object(row) &&
      typeof row.sessionId === 'string' && texts(row.maskedGlobal) && texts(row.maskFailed) &&
      ['registeredDenied','requestDenied','historyDenied'].every(key => row[key] == null || texts(row[key])))) &&
    value.admin.staff.every(member => object(member) && ['id','name','executor','brief'].every(key => typeof member[key] === 'string'))
}

type Save = (path:string, data:Record<string,unknown>, message:string) => Promise<boolean>
function Section({ title, children }: { title:string; children:ReactNode }) {
  return <section aria-label={title} className="v2-settings-section"><h2>{title}</h2><div>{children}</div></section>
}
function submit(event:FormEvent<HTMLFormElement>) { event.preventDefault(); return new FormData(event.currentTarget) }
const value = (form: FormData, name: string) => String(form.get(name) ?? '').trim()

export function WorkspaceSettings({ configure, reloadBrain, openStaff }: {configure:boolean; reloadBrain:() => Promise<void>; openStaff:()=>void}) {
  const {scope, revoke} = useContext(V2Client)
  const query = useV2Read('/v2/settings', isWorkspaceSettings)
  const [saving,setSaving] = useState(false)
  const [feedback,setFeedback] = useState('')
  const [problem,setProblem] = useState('')
  const live = useRef(true)
  const pending = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } },[])
  const save: Save = async (path,data,message) => {
    if (!configure || pending.current) return false
    pending.current = true
    setSaving(true); setFeedback(''); setProblem('')
    try {
      const reply = await api<{ok:boolean}>(scopedResource(scope,path),data)
      if (!reply?.ok) throw new Error('主机没有确认设置已保存。')
      if (path === '/settings/brain') { clearV2PrivateCache(scope); await reloadBrain() }
      else { await query.refresh(); if (live.current) setFeedback(message) }
      return true
    } catch (error) {
      if (live.current) {
        if (error instanceof ApiError && [401,403,409].includes(error.status)) revoke(error.message)
        else setProblem(error instanceof Error ? error.message : '保存失败，请重试。')
      }
      return false
    } finally {
      pending.current = false
      if (live.current) setSaving(false)
    }
  }
  const page = query.data
  const admin = configure ? page?.admin : undefined
  return <div className="v2-settings">
    <Issue text={query.error} retry={query.refresh}/>
    {!page && !query.error && <p className="v2-quiet" role="status">正在读取设置…</p>}
    {page && <><Section title="接口人与团队">
      {admin ? <>{!admin.settings.liaisonModel && page.activeModel && <p><small>当前接口人模型 · {page.activeModel}</small></p>}
        <TeamForm key={JSON.stringify([admin.settings.liaisonModel,admin.settings.liaisonReasoningEffort,admin.settings.concurrency])}
        settings={admin.settings} save={save} busy={saving}/>
        </>
        : <dl className="v2-ledger"><div><dt>接口人模型</dt><dd>{page.activeModel ?? '跟随 DSH 默认'}</dd></div>
          <div><dt>同时工作的幕僚</dt><dd>{page.concurrency} 位</dd></div></dl>}
      <button className="v2-button" onClick={openStaff}>我的幕僚</button>
    </Section>
    <Section title="时间与提醒">{admin ? <TimeForm key={JSON.stringify([page.timeZone,admin.settings.notifyUrl])}
      settings={admin.settings} save={save} busy={saving}/> : <dl className="v2-ledger"><div><dt>时区</dt><dd>{page.timeZone}</dd></div></dl>}</Section>
    <Section title="手机访问">{admin ? <MobileForm key={admin.settings.mobile.port + '/' + admin.settings.mobile.enabled}
      mobile={admin.settings.mobile} save={save} busy={saving}/> : <><p>已通过手机密码入口登录。</p>
        <a className="v2-button" href="/logout" onClick={() => clearV2PrivateCache(scope)}>退出本机登录</a></>}</Section>
    {admin && <Section title="资料与诊断"><BrainForm settings={admin.settings} save={save} busy={saving}/>
      {admin.settings.liaisonTools && <SettingsDiagnostics tools={admin.settings.liaisonTools} className="v2-settings-fold"/>}</Section>}
    </>}
    <div className="v2-settings-feedback"><Issue text={problem}/>{feedback && <p role="status">{feedback}</p>}</div>
  </div>
}

function TeamForm({settings,save,busy}:{settings:SettingsView;save:Save;busy:boolean}) {
  const [model,setModel] = useState({model:settings.liaisonModel ?? '',effort:settings.liaisonReasoningEffort ?? ''})
  return <form onSubmit={event => {
    const form = submit(event)
    const concurrency = Number(form.get('concurrency'))
    const data = { ...(concurrency !== settings.concurrency && {concurrency}), ...(model.model !== (settings.liaisonModel ?? '') && {liaisonModel:model.model}),
      ...(model.effort !== (settings.liaisonReasoningEffort ?? '') && {liaisonReasoningEffort:model.effort}) }
    void save('/settings',data,'接口人与团队设置已保存。')
  }}>
    <ModelPicker layout="form" label="接口人模型" effortLabel="思考深度" value={model} onChange={setModel} disabled={busy}/>
    <label>同时工作的幕僚<input name="concurrency" type="number" min={1} max={6} defaultValue={settings.concurrency} required/></label>
    <button className="v2-button" disabled={busy}>保存团队设置</button>
  </form>
}

function TimeForm({settings,save,busy}:{settings:SettingsView;save:Save;busy:boolean}) {
  return <form onSubmit={event => {
    const form = submit(event), timeZone = value(form,'timeZone'), notifyUrl = value(form,'notifyUrl')
    void save('/settings',{...(timeZone !== settings.timeZone && {timeZone}), ...(notifyUrl !== (settings.notifyUrl ?? '') && {notifyUrl})},'时间与提醒已保存。')
  }}><label>时区<input name="timeZone" required defaultValue={settings.timeZone} spellCheck={false}/></label>
    <details className="v2-settings-fold" open={!!settings.notifyUrl || undefined}><summary>额外推送地址（选填）</summary>
      <label>推送地址<input name="notifyUrl" type="url" defaultValue={settings.notifyUrl} placeholder="https://" autoComplete="off"/></label>
      <small>留空时，提醒只在 SuperHub 中显示。</small></details>
    <button className="v2-button" disabled={busy}>保存时间与提醒</button></form>
}

function MobileForm({mobile,save,busy}:{mobile:SettingsView['mobile'];save:Save;busy:boolean}) {
  const [password,setPassword] = useState('')
  return <><p>{mobile.enabled ? mobile.running ? '入口已开启' : mobile.problem ?? '等待入口启动' : '入口已关闭'}
    {mobile.enabled && !mobile.hasPassword && ' · 请设置登录密码'}</p>
    {mobile.enabled && mobile.addresses.length > 0 && <ul className="v2-addresses">{mobile.addresses.map(address => <li key={address}>{address}</li>)}</ul>}
    <form onSubmit={event => {
      const port = Number(submit(event).get('port'))
      void save('/settings',{mobile:{port,...!mobile.enabled && {enabled:true}}},mobile.enabled ? '手机端口已保存。' : '手机访问已开启。')
    }}><label>端口<input name="port" type="number" min={1024} max={65535} required defaultValue={mobile.port}/></label>
      <div className="v2-actions"><button className="v2-button" disabled={busy}>{mobile.enabled ? '保存端口' : '开启手机访问'}</button>
        {mobile.enabled && <button type="button" className="v2-link" disabled={busy} onClick={() => { void save('/settings',{mobile:{enabled:false}},'手机访问已关闭。') }}>关闭手机访问</button>}</div>
    </form>
    <details className="v2-settings-fold"><summary>{mobile.hasPassword ? '更换手机密码' : '设置手机密码'}</summary>
      <form onSubmit={async event => {
        event.preventDefault()
        if (await save('/settings/password',{password},'手机密码已保存。')) setPassword('')
      }}><label>新密码<input type="password" minLength={8} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)}/>
        <small>至少 8 位。更换后，手机需要重新登录。</small></label>
        <button className="v2-button" disabled={busy || password.length < 8}>保存密码</button></form></details>
  </>
}

function BrainForm({settings,save,busy}:{settings:SettingsView;save:Save;busy:boolean}) {
  const [brain,setBrain] = useState(settings.brain ?? '')
  return <><dl className="v2-ledger"><div><dt>资料位置</dt><dd>{settings.brain}</dd></div></dl>
    <details className="v2-settings-fold"><summary>切换第二大脑</summary><form onSubmit={event => {
      event.preventDefault()
      if (window.confirm('切换到「' + brain.trim() + '」并打开它的资料？')) void save('/settings/brain',{dir:brain.trim()},'已切换第二大脑。')
    }}><label>目标目录<input name="brain" value={brain} onChange={event => setBrain(event.target.value)} spellCheck={false} required/>
      <small>可选择已有的第二大脑，或用空目录开始。</small></label>
      <button className="v2-button" disabled={busy || !brain.trim() || brain.trim() === settings.brain}>切换目录</button>
    </form></details>{!settings.git && <p>本机未安装 Git，资料修改历史暂时不可用。</p>}</>
}
