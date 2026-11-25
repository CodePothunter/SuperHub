import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { DIRECTORY_SOURCE_LABEL, type V2DirectorySuggestion, type V2DirectorySuggestions, type V2WorkDirectory, type V2Workspace } from '../core/workspace-v2.ts'
import { ApiError } from './api.ts'
import { hubRead, type Scoped } from './superhub-api.ts'
import { scopedResource, segment, useV2Write, V2_ROOT, V2Client } from './workspace-v2-api.ts'
import { Issue, useArchived, V2Dialog, V2Icon } from './workspace-v2-elements.tsx'
import { isDirectorySuggestions } from './workspace-v2-response.ts'

const UNBOUND = '未绑定，在 SuperHub 工作目录运行'
/** Typing pauses this long before the host lists directories. */
const SUGGEST_DELAY = 150

export type PathStep = { move: 1 | -1 } | { open: true } | { pick: true } | { close: true }
type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }
/**
 * What a key does in the path field. Nothing is highlighted at first, so Enter saves what was typed and Tab moves on;
 * Escape only closes an open menu (the dialog stays); nothing while an input method composes.
 */
export function pathKey(event: KeyLike, menu: { open: boolean; active: number; count: number }): PathStep | undefined {
  if (event.isComposing || event.keyCode === 229) return undefined
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey
  if (event.key === 'Escape') return menu.open ? { close: true } : undefined
  if (!plain) return undefined
  if (event.key === 'ArrowDown') return !menu.open ? { open: true } : menu.count ? { move: 1 } : undefined
  if (event.key === 'ArrowUp') return menu.open && menu.count ? { move: -1 } : undefined
  if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && menu.open && menu.active >= 0 && menu.active < menu.count) return { pick: true }
  return undefined
}
/** The highlight after ↓/↑, wrapping around; from none, ↓ takes the first and ↑ the last. */
export function movedHighlight(active: number, move: 1 | -1, count: number) {
  if (!count) return -1
  if (active < 0) return move === 1 ? 0 : count - 1
  return (active + move + count) % count
}
/** The directory to save: trimmed, without a trailing slash (the root excepted), `~` read as the home when it is known. */
export function submittedDirectory(value: string, home?: string) {
  let path = value.trim()
  if (home && (path === '~' || path.startsWith('~/'))) path = path === '~' ? home : home.replace(/\/+$/, '') + path.slice(1)
  return path.startsWith('/') ? path.replace(/\/+$/, '') || '/' : path
}

/**
 * Directories under what the owner typed, read from the host after a pause in typing. A later answer always wins over
 * an earlier one; a lost connection or another brain revokes the workspace, any other failure is one line in the menu.
 */
function useDirectorySuggestions(workspaceId: string, value: string, open: boolean) {
  const { scope, revoke } = useContext(V2Client)
  const [state, setState] = useState<{ key: string; data?: V2DirectorySuggestions; error?: string; home?: string }>()
  const generation = useRef(0)
  const urgent = useRef(false)
  useEffect(() => {
    if (!open) return
    const version = ++generation.current
    const wait = urgent.current ? 0 : SUGGEST_DELAY
    urgent.current = false
    const timer = setTimeout(async () => {
      try {
        const data = await hubRead<Scoped>(scope, scopedResource(scope, V2_ROOT + '/' + segment(workspaceId) + '/directory?path=' + encodeURIComponent(value)))
        if (!isDirectorySuggestions(data)) throw new Error('主机返回的目录列表不完整')
        if (generation.current === version) setState({ key: value, data, home: data.home })
      } catch (error) {
        if (generation.current !== version) return
        const message = error instanceof Error ? error.message : '暂时无法列出目录'
        if (error instanceof ApiError && [401, 403, 409].includes(error.status)) revoke(message)
        else setState(previous => ({ key: value, error: message, ...(previous?.home !== undefined && { home: previous.home }) }))
      }
    }, wait)
    return () => { clearTimeout(timer); generation.current++ }
  }, [scope, revoke, workspaceId, value, open])
  // The previous level stays on screen until the next answer arrives, so the menu does not flicker while typing.
  return { data: state?.data, home: state?.home, error: state?.key === value ? state.error : undefined, now: () => { urgent.current = true } }
}

/** The menu under the path field: directories to open (greyed with the reason when they cannot be bound) and one note. */
export function PathMenu({ id, open, suggestions, error, active, pick }: {
  id: string; open: boolean; suggestions?: V2DirectorySuggestions; error?: string; active: number; pick: (entry: V2DirectorySuggestion) => void
}) {
  const entries = suggestions?.entries ?? []
  const note = error ?? suggestions?.issue ?? (!suggestions ? '正在读取目录…' : suggestions.more ? '还有更多，继续输入以缩小范围'
    : entries.length ? undefined : '没有匹配的目录')
  // Pressing anywhere in the menu (its scrollbar included) keeps the focus, and with it the menu, in the field.
  return <div className="v2-path-menu" hidden={!open} onMouseDown={event => event.preventDefault()}>
    <ul id={id} role="listbox" aria-label="可选目录">
      {entries.map((entry, index) => <li key={entry.path} id={id + '-' + index} role="option" aria-selected={index === active}
        data-bindable={String(entry.bindable)} onMouseDown={() => pick(entry)}>
        <strong>{entry.name}/</strong><span>{entry.path}</span>
        {!entry.bindable && <small>不能绑定：{entry.reason ?? '无法读取'}</small>}
      </li>)}
    </ul>
    {open && note && <p className="v2-path-note" role="status">{note}</p>}
  </div>
}

/**
 * Bind, change or remove the workspace's project directory. The field is a combobox that lists directories as the owner
 * types, level by level; errors on saving (missing, system or home directory) stay inline.
 */
function DirectoryForm({ workspace, done }: { workspace: V2Workspace; done: () => Promise<void> }) {
  const write = useV2Write()
  const [value, setValue] = useState(workspace.projectDirectory ?? '')
  const [open, setOpen] = useState(false)
  // A highlight belongs to one answer for one input: typing on, or a fresh answer, starts again from none.
  const [choice, setChoice] = useState<{ key: string; data?: V2DirectorySuggestions; index: number }>({ key: '', index: -1 })
  const field = useRef<HTMLInputElement>(null)
  const toEnd = useRef(false)
  const listId = useId()
  const suggested = useDirectorySuggestions(workspace.id, value, open)
  const entries = suggested.data?.entries ?? []
  const active = open && choice.key === value && choice.data === suggested.data ? Math.min(choice.index, entries.length - 1) : -1
  const path = V2_ROOT + '/' + segment(workspace.id) + '/directory'
  useLayoutEffect(() => {
    if (!toEnd.current || !field.current) return
    toEnd.current = false
    field.current.setSelectionRange(value.length, value.length)
  }, [value])
  // The focus stays in the field, so the menu does not follow the highlight by itself: ↓/↑ past its edge scroll it.
  useEffect(() => {
    if (active >= 0) document.getElementById(listId + '-' + active)?.scrollIntoView({ block: 'nearest' })
  }, [active, listId])
  function pick(entry: V2DirectorySuggestion) {
    const next = entry.path + '/'
    toEnd.current = true
    suggested.now()
    setValue(next)
    setChoice({ key: next, index: -1 })
    setOpen(true)
    field.current?.focus()
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    const step = pathKey({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, { open, active, count: entries.length })
    if (!step) return
    event.preventDefault()
    // Escape would otherwise also cancel the dialog.
    event.stopPropagation()
    if ('open' in step) setOpen(true)
    else if ('move' in step) setChoice({ key: value, data: suggested.data, index: movedHighlight(active, step.move, entries.length) })
    else if ('pick' in step) pick(entries[active]!)
    else setOpen(false)
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setOpen(false)
    const result = await write.post<Scoped & { workspace: V2Workspace }>(path, { directory: submittedDirectory(value, suggested.home) })
    if (result) await done()
  }
  return <form className="v2-directory-form" onSubmit={save}>
    <div className="v2-path-field">
      <label>项目目录的绝对路径<input ref={field} name="directory" value={value} required maxLength={4096} spellCheck={false} autoComplete="off"
        autoCapitalize="off" placeholder="/home/me/project" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId}
        aria-activedescendant={active >= 0 ? listId + '-' + active : undefined} aria-describedby={workspace.id + '-directory-help'}
        onChange={event => { setValue(event.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onKeyDown={keyDown}/></label>
      <PathMenu id={listId} open={open} suggestions={suggested.data} error={suggested.error} active={active} pick={pick}/>
    </div>
    <small id={workspace.id + '-directory-help'}>目录需已存在并属于你本人；不能是根目录、系统目录或家目录本身。可输入 ~ 表示家目录，↓ 选择候选目录，Tab 进入下一层。修改从下一轮起生效。</small>
    <Issue text={write.error}/>
    {/* Pressing the button keeps the focus in the field: a blur would fold the in-flow menu, move the button up from
        under the pointer and lose the click. Saving closes the menu. */}
    <div className="v2-actions"><button className="v2-button primary" disabled={write.busy || !value.trim()}
      onMouseDown={event => event.preventDefault()}>{write.busy ? '正在保存…' : '保存目录'}</button></div>
  </form>
}

export function DirectoryDialog({ workspace, close, changed }: { workspace: V2Workspace; close: () => void; changed: () => Promise<void> }) {
  return <V2Dialog title={workspace.projectDirectory ? '修改项目目录' : '绑定项目目录'} meta={workspace.name} close={close}>
    <DirectoryForm workspace={workspace} done={async () => { await changed(); close() }}/>
  </V2Dialog>
}

/** The workspace page's 「项目目录」 item: where this workspace's Codex and Claude Code orders run. */
export function ProjectDirectory({ workspace, changed }: { workspace: V2Workspace; changed: () => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const unbind = useV2Write()
  const archived = useArchived()
  const bound = workspace.projectDirectory
  return <section className="v2-project-directory" aria-label="项目目录">
    <div className="v2-section-head"><h2><V2Icon name="work"/>项目目录</h2>
      {!archived && <div className="v2-actions">
        <button className="v2-link" onClick={() => setEditing(true)}>{bound ? '修改' : '绑定目录'}</button>
        {bound && <button className="v2-link" disabled={unbind.busy} onClick={async () => {
          const result = await unbind.post<Scoped & { workspace: V2Workspace }>(V2_ROOT + '/' + segment(workspace.id) + '/directory', { directory: '' })
          if (result) await changed()
        }}>解除</button>}
      </div>}</div>
    <p className="v2-directory-path">{bound ? <code>{bound}</code> : UNBOUND}</p>
    <small className="v2-quiet">派给 Codex 或 Claude Code 的工单默认在这里运行；单张工单可以另指目录。同一目录一次只运行一张工单，其余排队。</small>
    <Issue text={unbind.error}/>
    {editing && !archived && <DirectoryDialog workspace={workspace} close={() => setEditing(false)} changed={changed}/>}
  </section>
}

/** 「运行目录」 of a coding order: the actual directory and where it comes from. */
export function directoryText(directory: V2WorkDirectory | undefined) {
  if (!directory) return '尚未登记'
  return (directory.path ?? 'SuperHub 工作目录') + ' · ' + DIRECTORY_SOURCE_LABEL[directory.source]
}
