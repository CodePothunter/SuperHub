import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { IMPORT_MAX, IMPORT_PROMPT, IMPORT_SOURCES } from '../core/onboarding.ts'
import {
  PROFILE_IMPORT_ROOT, isProfileImportDetail, isProfileImportList, isProfileImportReceipt, isProfileItemReceipt, profileImportId,
  type ProfileImportDetail, type ProfileImportItem, type ProfileImportReceipt, type ProfileImportStatus, type ProfileImportTarget,
  type ProfileItemReceipt, type ProfileTargetVersion,
} from '../core/profile-import.ts'
import type { Scoped } from './superhub-api.ts'
import { segment, useV2Read, useV2Write } from './workspace-v2-api.ts'
import { Issue, readableTime, V2Icon } from './workspace-v2-elements.tsx'

const labels: Record<ProfileImportStatus, string> = {
  organizing: '正在整理', review: '待核对', processed: '已处理', failed: '整理失败',
}
const sourceLabels = { memory: '记忆', conversation: '对话', inference: '推断', unknown: '待核实' }
const categoryLabels = {
  identity: '身份与背景', stage: '当前阶段', preferences: '偏好', collaboration: '协作方式',
  principles: '原则', goal: '个人目标', person: '人物事实',
}
const reviewPath = (id: string) => PROFILE_IMPORT_ROOT + '/' + segment(id)
const itemPath = (importId: string, itemId: string) => reviewPath(importId) + '/items/' + segment(itemId)
const reviewOf = (value: Scoped, path: string): value is ProfileImportDetail =>
  isProfileImportDetail(value) && path === reviewPath(value.record.id)
const retryOf = (value: Scoped, path: string) => isProfileImportReceipt(value) && path === reviewPath(value.importId) + '/retry'
const decisionOf = (value: Scoped, path: string) => isProfileItemReceipt(value) && path === itemPath(value.importId, value.itemId)
const needsConfirmation = (item: ProfileImportItem) => item.sourceType === 'inference' || item.sourceType === 'unknown'
function targetLabel(target: ProfileImportTarget, options: ProfileImportTarget[]) {
  if (!target.current || !options.some(option => option.id !== target.id && option.label === target.label)) return target.label
  const excerpt = target.current.replace(/\s+/g, ' ').trim()
  return `${target.label} · ${excerpt.length > 60 ? excerpt.slice(0, 60) + '…' : excerpt}`
}

const profileStyle = `
.wv2 .v2-profile { width:min(100%,53rem); display:grid; gap:16px; margin-block:20px; }
.wv2 .v2-profile :is(.v2-profile-form,.v2-profile-item,.v2-profile-original) { min-width:0; padding:clamp(12px,2.5cqw,24px); }
.wv2 .v2-profile :is(.v2-profile-form,.v2-profile-item,section,.v2-profile-fields) { display:grid; gap:12px; }
.wv2 .v2-profile :is(.v2-profile-form,.v2-profile-item) label { display:grid; gap:4px; font-weight:550; min-width:0; }
.wv2 .v2-profile textarea { font-size:16px; }
.wv2 .v2-profile :is(.v2-quiet,.v2-eyebrow,.v2-issue) { padding-block:0; margin:0; }
.wv2 .v2-profile .v2-quiet { padding-inline:0; }
.wv2 .v2-profile .v2-issue { padding-block:7px; }
.wv2 .v2-profile :is(.v2-profile-status,.v2-profile-meta) { color:var(--v-muted); font-size:13px; }
.wv2 .v2-profile .v2-profile-meta { display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 12px; }
.wv2 .v2-profile summary { cursor:pointer; color:var(--hub-brand-text); font-weight:550; }
.wv2 .v2-profile :is(.v2-profile-quote,.v2-profile-value) { white-space:pre-wrap; overflow-wrap:anywhere; }
.wv2 .v2-profile .v2-profile-quote { margin:6px 0 0; padding-inline-start:10px; border-inline-start:2px solid var(--v-line); }
.wv2 .v2-profile .v2-profile-original pre { margin-block:8px 0; max-height:45dvh; overflow:auto; font:inherit; }
.wv2 .v2-profile .v2-profile-compare { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.wv2 .v2-profile .v2-profile-compare>div { min-width:0; padding:9px 12px; background:var(--v-tint); border-radius:6px; }
.wv2 .v2-profile .v2-profile-compare>div:only-child { grid-column:1/-1; }
.wv2 .v2-profile dt { color:var(--v-muted); font-size:13px; }
.wv2 .v2-profile .v2-profile-actions { margin-top:0; }
.wv2 .v2-profile .v2-profile-actions button { min-height:44px; }
@container(max-width:740px) { .wv2 .v2-profile .v2-profile-compare { grid-template-columns:minmax(0,1fr); } }
`

export function WorkspaceProfileImports({ selected, open }: { selected?: string; open: (id: string) => void }) {
  const list = useV2Read(PROFILE_IMPORT_ROOT, isProfileImportList, selected ? undefined : 6000)
  return <>
    <style>{profileStyle}</style>
    <div className="v2-profile" hidden={!!selected}>
      <ImportForm done={open}/>
      <section aria-labelledby="profile-import-history">
        <h2 id="profile-import-history">导入记录</h2>
        <Issue text={list.error} retry={list.refresh}/>
        {!list.data && !list.error && <p role="status" className="v2-quiet">正在读取导入记录…</p>}
        {list.data && (list.data.imports.length ? <div className="v2-card">
          {list.data.imports.map(record => <button type="button" key={record.id} className="v2-row" data-focus={'profile-' + record.id} onClick={() => open(record.id)}>
            <span className="v2-row-title"><strong>{record.source}</strong><V2Icon name="next"/></span>
            <small><time dateTime={record.at}>{readableTime(record.at)}</time> · {labels[record.status]}{record.pending > 0 && ` · ${record.pending} 条待核对`}</small>
          </button>)}
        </div> : <p className="v2-quiet">还没有从其他助手导入的资料。</p>)}
      </section>
    </div>
    {selected && (profileImportId.test(selected) ? <ImportReview key={selected} id={selected}/>
      : <p className="v2-empty">这份导入记录已不可用。</p>)}
  </>
}

function ImportForm({ done }: { done: (id: string) => void }) {
  const [source, setSource] = useState<string>(IMPORT_SOURCES[0])
  const [text, setText] = useState('')
  const [copyStatus, setCopyStatus] = useState('')
  const prompt = useRef<HTMLDetailsElement>(null)
  const promptText = useRef<HTMLTextAreaElement>(null)
  // Pasted personal information only lives in this tab's React state until it reaches the current brain.
  const write = useV2Write(isProfileImportReceipt, false)
  const tooLong = text.length > IMPORT_MAX

  async function copy() {
    try {
      await navigator.clipboard.writeText(IMPORT_PROMPT)
      setCopyStatus('已复制提示词')
    } catch {
      if (prompt.current) prompt.current.open = true
      promptText.current?.focus()
      promptText.current?.select()
      setCopyStatus('提示词已选中，请手动复制')
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!text.trim() || tooLong) return
    const receipt = await write.post<ProfileImportReceipt>(PROFILE_IMPORT_ROOT, {source,text})
    if (receipt) {
      setText('')
      setCopyStatus('')
      done(receipt.importId)
    }
  }

  return <form className="v2-card v2-profile-form" onSubmit={submit}>
    <div className="v2-profile-fields">
      <p>把提示词发给你常用的助手，再贴回它对你的了解。</p>
      <div className="v2-actions v2-profile-actions">
        <button type="button" className="v2-button" onClick={() => { void copy() }}>复制提示词</button>
        <small role="status" className="v2-profile-status">{copyStatus}</small>
      </div>
      <details ref={prompt}><summary>查看提示词</summary>
        <textarea ref={promptText} value={IMPORT_PROMPT} rows={7} readOnly aria-label="给助手的提示词"/>
      </details>
    </div>
    <label>来源助手<select value={source} onChange={event => setSource(event.target.value)} disabled={write.busy}>
      {IMPORT_SOURCES.map(option => <option value={option} key={option}>{option}</option>)}
    </select></label>
    <label>助手的回答<textarea value={text} onChange={event => setText(event.target.value)} rows={8} readOnly={write.busy}
      placeholder="粘贴助手的完整回答" aria-describedby={tooLong ? 'profile-import-limit' : undefined}/></label>
    {tooLong && <p id="profile-import-limit" role="alert">每次最多导入 {IMPORT_MAX.toLocaleString('zh-CN')} 字，请分段提交。</p>}
    <Issue text={write.error}/>
    <div className="v2-actions"><button className="v2-button primary" disabled={!text.trim() || tooLong || write.busy}>
      {write.busy ? '正在提交…' : '整理并核对'}</button></div>
  </form>
}

function ImportReview({ id }: { id: string }) {
  const path = reviewPath(id)
  const query = useV2Read(path, reviewOf, 3000)
  const retry = useV2Write(retryOf, false)
  const result = query.data
  const record = result?.record
  const candidates = record?.items.filter(item => !needsConfirmation(item)) ?? []
  const uncertain = record?.items.filter(needsConfirmation) ?? []
  return <div className="v2-profile" aria-label="核对资料">
    <Issue text={query.error} retry={query.refresh}/>
    {!record && !query.error && <p className="v2-quiet" role="status">正在读取导入记录…</p>}
    {record && <>
      <p className="v2-profile-meta"><strong>{record.source}</strong><time dateTime={record.at}>{readableTime(record.at)}</time></p>
      <p role="status" className="v2-profile-status">{labels[record.status]}{record.total > 0 && ` · ${record.pending} / ${record.total} 条待核对`}</p>
      <Issue text={record.issue}/>
      {record.status === 'failed' && <>
        <div className="v2-actions"><button type="button" className="v2-button" disabled={retry.busy} onClick={async () => {
          await retry.post<ProfileImportReceipt>(path + '/retry', {})
          await query.refresh()
        }}>{retry.busy ? '正在重试…' : '重新整理'}</button></div>
        <Issue text={retry.error}/>
      </>}
      {record.status === 'processed' && !record.items.length && <p className="v2-empty">这份回答里没有可核对的个人资料。</p>}
      {candidates.length > 0 && <section aria-label="核对条目">
        {candidates.map(item => <ReviewItem key={item.id} importId={id} item={item} refresh={query.refresh}/>)}
      </section>}
      {uncertain.length > 0 && <section aria-labelledby="profile-unverified">
        <div><h2 id="profile-unverified">待核实</h2><p className="v2-profile-status">先核对助手的推断，保存你确认的表述。</p></div>
        {uncertain.map(item => <ReviewItem key={item.id} importId={id} item={item} refresh={query.refresh}/>)}
      </section>}
      <details className="v2-card v2-profile-original"><summary>查看完整回答</summary>
        <pre className="v2-profile-value" tabIndex={0}>{record.text}</pre>
      </details>
    </>}
  </div>
}

interface EditDraft {
  text: string
  itemVersion: number
  targetVersion?: ProfileTargetVersion
}

function ReviewItem({ importId, item, refresh }: { importId: string; item: ProfileImportItem; refresh: () => Promise<void> }) {
  const [choice, setChoice] = useState('')
  const [draft, setDraft] = useState<EditDraft>()
  const [receipt, setReceipt] = useState<ProfileItemReceipt>()
  const feedback = useRef<HTMLParagraphElement>(null)
  const write = useV2Write(decisionOf, false)
  const confirmed = receipt && receipt.version >= item.version ? receipt : item
  const needsReadback = confirmed.version > item.version
  const defaultTarget = item.targets.find(target => target.id === item.saved?.targetId)
    ?? (item.targets.length === 1 ? item.targets[0] : undefined)
  const target = item.targets.find(candidate => candidate.id === (choice || defaultTarget?.id))
  const uncertain = needsConfirmation(item)
  const stale = draft && (draft.itemVersion !== item.version || draft.targetVersion !== target?.version)
  const limit = item.category === 'goal' ? 200 : 1200
  const available = !needsReadback && item.targets.length > 0 && !write.busy
  useLayoutEffect(() => { if (receipt) feedback.current?.focus({preventScroll:true}) }, [receipt])

  async function decide(action: 'save' | 'skip') {
    if (needsReadback) return
    const path = itemPath(importId, item.id)
    const text = draft?.text ?? item.text
    const saving = action === 'save'
    if (saving && (!target || !text.trim() || text.length > limit || stale)) return
    const result = await write.post<ProfileItemReceipt>(path, {
      expectedVersion: draft?.itemVersion ?? item.version,
      action,
      ...(saving && target && {text, targetId:target.id, expectedTargetVersion:target.version}),
    })
    if (result) {
      setDraft(undefined)
      setChoice('')
      setReceipt(result)
    }
    // Re-read even on a conflict. The editor keeps its text and the previous versions until the owner compares again.
    await refresh()
  }

  return <article className="v2-card v2-profile-item" aria-label={categoryLabels[item.category] + (item.subject ? ' · ' + item.subject : '')}>
    <div className="v2-profile-meta"><strong>{categoryLabels[item.category]}</strong>{item.subject && <span>{item.subject}</span>}
      {item.confidential && <span>机密</span>}</div>
    <details>
      <summary>查看依据</summary>
      <p className="v2-profile-status">{sourceLabels[item.sourceType]}</p>
      {item.quote ? <blockquote className="v2-profile-quote">{item.quote}</blockquote>
        : <p className="v2-profile-status">没有可核对的原句。</p>}
    </details>
    {confirmed.saved && <p ref={feedback} role="status" tabIndex={-1} className="v2-profile-value">
      <strong>已保存到{confirmed.saved.label}</strong> <span>{confirmed.saved.text}</span>
    </p>}
    {confirmed.status === 'skipped' && <p ref={feedback} role="status" tabIndex={-1} className="v2-profile-status">已跳过</p>}
    {(confirmed.status === 'pending' || draft) && <>
      {item.targets.length > 1 && <label>保存到<select value={target?.id ?? ''} disabled={!available} onChange={event => {
        const id = event.target.value
        setChoice(id)
        if (draft) setDraft({...draft, targetVersion:item.targets.find(candidate => candidate.id === id)?.version})
      }}>
        <option value="" disabled>选择目标资料</option>
        {item.targets.map(option => <option key={option.id} value={option.id}>
          {targetLabel(option, item.targets)}{option.match ? ' · 已记录' : ''}</option>)}
      </select></label>}
      {item.targets.length === 1 && <p className="v2-profile-status">保存到 {target?.label}</p>}
      <dl className="v2-profile-compare">
        {target?.current !== undefined && <div><dt>现有资料{target.match && ' · 已记录'}</dt><dd className="v2-profile-value">{target.current}</dd></div>}
        <div><dt>助手的建议</dt><dd className="v2-profile-value">{item.text || '等待你补充'}</dd></div>
      </dl>
    </>}
    {confirmed.status === 'pending' && item.targets.length === 0 && <p className="v2-profile-status">这条暂时没有可保存的位置。</p>}
    {draft && <label>确认后的文字<textarea rows={3} value={draft.text} readOnly={write.busy} maxLength={limit}
      onChange={event => setDraft({...draft,text:event.target.value})}/></label>}
    {stale && <div className="v2-issue" role="status"><span>资料已有更新，请核对上方现值。</span>
      <button type="button" className="v2-link" onClick={() => setDraft({...draft, itemVersion:item.version, targetVersion:target?.version})}>已核对现值</button>
    </div>}
    <Issue text={write.error}/>
    <div className="v2-actions v2-profile-actions">
      {draft ? <>
        <button type="button" className="v2-button primary" disabled={!available || !target || !draft.text.trim() || !!stale} onClick={() => { void decide('save') }}>
          {write.busy ? '正在保存…' : '保存'}</button>
        <button type="button" className="v2-link" disabled={write.busy} onClick={() => setDraft(undefined)}>取消修改</button>
      </> : <>
        {confirmed.status === 'pending' && !uncertain && <button type="button" className="v2-button primary"
          disabled={!available || !target || !item.text.trim() || item.text.length > limit} onClick={() => { void decide('save') }}>
          {target?.match ? '确认已有资料' : '采纳'}</button>}
        {item.targets.length > 0 && <button type="button" className="v2-link" disabled={!available} onClick={() => setDraft({
          text:confirmed.saved?.text ?? item.text, itemVersion:item.version, targetVersion:target?.version,
        })}>{uncertain && confirmed.status === 'pending' ? '核实并编辑' : '修改'}</button>}
        {confirmed.status === 'pending' && <button type="button" className="v2-link" disabled={write.busy || needsReadback} onClick={() => { void decide('skip') }}>跳过</button>}
      </>}
    </div>
  </article>
}
