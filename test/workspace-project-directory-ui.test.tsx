import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pagedReadsFromV2Read } from './paged-read-mock.ts'
import type { V2Delegation, V2Session, V2WorkspaceView } from '../src/core/workspace-v2.ts'
import type { Scoped } from '../src/client/superhub-api.ts'
import * as api from '../src/client/workspace-v2-api.ts'
import { WorkOrderPage } from '../src/client/workspace-v2.tsx'
import { DirectoryDialog, movedHighlight, PathMenu, pathKey, ProjectDirectory, submittedDirectory } from '../src/client/workspace-directory.tsx'
import { OrderExecution } from '../src/client/workspace-execution.tsx'
import { deliveryNote } from '../src/client/workspace-v2-talk.tsx'
import { hasMutationObject, isDirectorySuggestions, isExecutionView, isSessionView, isWorkspaceView } from '../src/client/workspace-v2-response.ts'
import { WORKSPACE_V2_STYLE } from '../src/client/workspace-v2-style.ts'

const at = '2026-11-23T08:00:00Z'
const session: V2Session = {id:'s', workspaceId:'w', title:'首页会话', kind:'coding', executor:'codex', delegationIds:['d'], closed:false, createdAt:at}
const order: V2Delegation = {id:'d', workspaceId:'w', sessionId:'s', title:'首页改版', promise:'改好首页', owner:'接口人', status:'accepted',
  boundary:'只改首页', remainingTurns:3, generation:1, createdAt:at, nextCheckAt:at}
const base = {scope:'brain', workspace:{id:'w', name:'字节 Landing', goal:'', owner:'我', createdAt:at}, orders:[order], delegations:[order], sessions:[session], decisions:[]}
const sessionPath = '/v2/workspaces/w/sessions/s'

function mockReads(responses: Record<string, Scoped & Record<string, unknown>>) {
  vi.spyOn(api, 'useV2Read').mockImplementation((resource, valid) => {
    const value = resource ? responses[resource] : undefined
    return {data: resource && value && valid(value, resource) ? value : undefined, error: undefined, refresh: async () => {}}
  })
}
const page = (view: V2WorkspaceView, extra: Record<string, unknown> = {}) => {
  mockReads({[sessionPath]: {scope:'brain', session, messages:[], ...extra}})
  return renderToStaticMarkup(<WorkOrderPage job={order} view={view} base="/v2/workspaces/w" back={vi.fn()} open={vi.fn()} openOrder={vi.fn()}
    target={vi.fn()} newOrder={vi.fn()} popup={vi.fn()} changed={async () => {}} initialWide/>)
}
afterEach(() => vi.restoreAllMocks())
beforeEach(() => pagedReadsFromV2Read())

describe('项目目录的界面', () => {
  it('shows the workspace\'s project directory, or that it runs in SuperHub\'s working directory, with bind, change and unbind', () => {
    const unbound = renderToStaticMarkup(<ProjectDirectory workspace={base.workspace} changed={async () => {}}/>)
    expect(unbound).toContain('项目目录')
    expect(unbound).toContain('未绑定，在 SuperHub 工作目录运行')
    expect(unbound).toContain('绑定目录')
    expect(unbound).not.toContain('解除')
    const bound = renderToStaticMarkup(<ProjectDirectory workspace={{...base.workspace, projectDirectory:'/home/me/landing'}} changed={async () => {}}/>)
    expect(bound).toContain('<code>/home/me/landing</code>')
    expect(bound).toContain('修改')
    expect(bound).toContain('解除')
  })

  it('names the order\'s actual directory and its source, and offers binding when it runs in SuperHub\'s directory', () => {
    const own = page({...base, directories:{d:{source:'order', path:'/home/me/api'}}})
    expect(own).toContain('运行目录')
    expect(own).toContain('/home/me/api · 本单指定')
    expect(own).not.toContain('绑定项目目录')
    expect(page({...base, directories:{d:{source:'workspace', path:'/home/me/landing'}}})).toContain('/home/me/landing · 工作区默认')
    const superhub = page({...base, directories:{d:{source:'superhub', path:'/brain/work/superhub-v2/a/b'}}})
    expect(superhub).toContain('/brain/work/superhub-v2/a/b · SuperHub 工作目录')
    expect(superhub).toContain('绑定项目目录')
  })

  it('says which order the conversation waits for and lets the owner stop it, instead of 「对方正在工作」', () => {
    const html = page(base, {waiting:{sessionId:'other', workOrderId:'x', title:'接口文档'}})
    expect(html).toContain('等待『接口文档』完成后开始')
    // One model for the words: they wait with the turn, so the hint and each bubble's note both say 「下一轮」.
    expect(html).toContain('现在说的话会一起排到下一轮')
    expect(html).not.toContain('这一轮')
    expect(deliveryNote.queued).toBe('已排到下一轮')
    expect(html).toMatch(/<button type="button" class="v2-link"[^>]*>叫停<\/button>/)
    expect(html).not.toContain('对方正在工作')
    // The composer stays open while waiting.
    expect(html).toMatch(/<textarea(?![^>]*disabled)[^>]*placeholder="对 Codex 说…"/)
  })

  it('accepts the new fields in responses and keeps older ones valid', () => {
    const scoped = (value: object) => value as unknown as Scoped
    expect(isWorkspaceView(scoped({...base, directories:{d:{source:'workspace', path:'/x'}}}), '/v2/workspaces/w')).toBe(true)
    expect(isWorkspaceView(base, '/v2/workspaces/w')).toBe(true)
    expect(isWorkspaceView(scoped({...base, directories:{d:{source:'elsewhere'}}}), '/v2/workspaces/w')).toBe(false)
    expect(isSessionView(scoped({scope:'brain', session, messages:[], waiting:{sessionId:'s2', title:'接口文档'}}), sessionPath)).toBe(true)
    expect(isSessionView(scoped({scope:'brain', session, messages:[], waiting:{title:'接口文档'}}), sessionPath)).toBe(false)
    expect(hasMutationObject(scoped({scope:'brain', workspace:{...base.workspace, projectDirectory:'/x'}}), '/v2/workspaces/w/directory')).toBe(true)
    expect(hasMutationObject(scoped({scope:'brain', workspace:{...base.workspace, id:'other'}}), '/v2/workspaces/w/directory')).toBe(false)
    expect(isExecutionView({scope:'brain', workspaceId:'w', delegationId:'d', commands:[], runs:[], directory:{source:'order', path:'/x'}}, '/v2/workspaces/w/orders/d/execution')).toBe(true)
  })

  it('opens the run\'s own directory in the terminal resume command', () => {
    const execution = {scope:'brain', workspaceId:'w', delegationId:'d', commands:[], runs:[
      {turnId:'t1', workOrderId:'d', tool:'claude-code', state:'done', nativeSessionId:'cc-1', cwd:"/home/me/my landing's", process:{exitCode:0, stderrTail:''}}]}
    vi.spyOn(api, 'useV2Read').mockImplementation((_resource, valid) => ({data: valid(execution as never, '/v2/workspaces/w/orders/d/execution') ? execution as never : undefined,
      error: undefined, refresh: async () => {}}))
    const html = renderToStaticMarkup(<OrderExecution base="/v2/workspaces/w" job={order} session={{...session, executor:'claude-code'}}/>)
    expect(html).toContain("cd &#x27;/home/me/my landing&#x27;\\&#x27;&#x27;s&#x27; &amp;&amp; claude --resume cc-1")
  })

  it('wraps long paths instead of overflowing narrow layouts', () => {
    expect(WORKSPACE_V2_STYLE).toMatch(/\.v2-directory-path code \{[^}]*word-break:break-all/)
    expect(WORKSPACE_V2_STYLE).toMatch(/\.v2-waiting \{[^}]*flex-wrap:wrap[^}]*overflow-wrap:anywhere/)
  })

  it('aligns the directory\'s helper text with the path above it instead of indenting it like an empty-list note', () => {
    const html = renderToStaticMarkup(<ProjectDirectory workspace={base.workspace} changed={async () => {}}/>)
    expect(html).toMatch(/<section class="v2-project-directory"[^>]*>(?:<div class="v2-section-head">.*?<\/div><\/div>)<p class="v2-directory-path">[^<]*<\/p><small class="v2-quiet">/)
    const rule = WORKSPACE_V2_STYLE.match(/\.wv2 \.v2-project-directory>\.v2-quiet \{([^}]*)\}/)
    expect(rule?.[1]).toContain('padding:0')
    // Later and more specific than the general 14px padding of empty-list notes.
    expect(WORKSPACE_V2_STYLE.indexOf('.wv2 .v2-project-directory>.v2-quiet')).toBeGreaterThan(WORKSPACE_V2_STYLE.indexOf('.wv2 .v2-quiet { padding:14px; }'))
  })
})

describe('项目目录的路径补全', () => {
  const closed = {open: false, active: -1, count: 3}, open = {open: true, active: -1, count: 3}, chosen = {open: true, active: 1, count: 3}

  it('moves, opens, picks and closes with the keys, and leaves Enter, Tab and Escape alone when they are not the menu\'s', () => {
    expect(pathKey({key: 'ArrowDown'}, closed)).toEqual({open: true})
    expect(pathKey({key: 'ArrowDown'}, open)).toEqual({move: 1})
    expect(pathKey({key: 'ArrowUp'}, open)).toEqual({move: -1})
    expect(pathKey({key: 'ArrowUp'}, closed)).toBeUndefined()
    expect(pathKey({key: 'ArrowDown'}, {open: true, active: -1, count: 0})).toBeUndefined()
    // Nothing highlighted: Enter saves what was typed, Tab moves the focus on.
    expect(pathKey({key: 'Enter'}, open)).toBeUndefined()
    expect(pathKey({key: 'Tab'}, open)).toBeUndefined()
    expect(pathKey({key: 'Enter'}, closed)).toBeUndefined()
    expect(pathKey({key: 'Enter'}, chosen)).toEqual({pick: true})
    expect(pathKey({key: 'Tab'}, chosen)).toEqual({pick: true})
    expect(pathKey({key: 'Tab', shiftKey: true}, chosen)).toBeUndefined()
    expect(pathKey({key: 'Enter', ctrlKey: true}, chosen)).toBeUndefined()
    expect(pathKey({key: 'Enter'}, {open: false, active: 1, count: 3})).toBeUndefined()
    // Escape closes an open menu only; closed, it is the dialog's.
    expect(pathKey({key: 'Escape'}, open)).toEqual({close: true})
    expect(pathKey({key: 'Escape'}, closed)).toBeUndefined()
    // An input method's keys are its own while it composes.
    for (const key of ['Enter', 'Tab', 'ArrowDown', 'Escape']) {
      expect(pathKey({key, isComposing: true}, chosen)).toBeUndefined()
      expect(pathKey({key, keyCode: 229}, chosen)).toBeUndefined()
    }
    expect(pathKey({key: 'a'}, chosen)).toBeUndefined()
  })

  it('starts the highlight from none and wraps around', () => {
    expect(movedHighlight(-1, 1, 3)).toBe(0)
    expect(movedHighlight(-1, -1, 3)).toBe(2)
    expect(movedHighlight(2, 1, 3)).toBe(0)
    expect(movedHighlight(0, -1, 3)).toBe(2)
    expect(movedHighlight(-1, 1, 0)).toBe(-1)
  })

  it('saves the path without its trailing slash and reads ~ as the home once it is known', () => {
    expect(submittedDirectory(' /home/me/app/ ')).toBe('/home/me/app')
    expect(submittedDirectory('/home/me/app//')).toBe('/home/me/app')
    expect(submittedDirectory('/')).toBe('/')
    expect(submittedDirectory('~/app/', '/home/me')).toBe('/home/me/app')
    expect(submittedDirectory('~', '/home/me/')).toBe('/home/me')
    expect(submittedDirectory('~/app', '/')).toBe('/app')
    // Unknown home: sent as typed, and the host says it needs an absolute path.
    expect(submittedDirectory('~/app/')).toBe('~/app/')
    expect(submittedDirectory('projects/app')).toBe('projects/app')
  })

  const suggestions = {parent: '/home/me', home: '/home/me', more: false, entries: [
    {path: '/home/me/app', name: 'app', bindable: true},
    {path: '/home/me/brain', name: 'brain', bindable: false, reason: '内部目录'}]}
  const menu = (props: Partial<Parameters<typeof PathMenu>[0]> = {}) =>
    renderToStaticMarkup(<PathMenu id="p" open suggestions={suggestions} active={-1} pick={vi.fn()} {...props}/>)

  it('lists directories as options, greys out those that cannot be bound with the reason, and marks the highlight', () => {
    const html = menu({active: 1})
    expect(html).toContain('<ul id="p" role="listbox" aria-label="可选目录">')
    expect(html).toMatch(/<li id="p-0" role="option" aria-selected="false" data-bindable="true"><strong>app\/<\/strong><span>\/home\/me\/app<\/span><\/li>/)
    expect(html).toMatch(/<li id="p-1" role="option" aria-selected="true" data-bindable="false">.*<small>不能绑定：内部目录<\/small><\/li>/)
    expect(html).not.toContain('v2-path-note')
    expect(menu({open: false})).toMatch(/^<div class="v2-path-menu" hidden="">/)
    expect(menu({open: false})).not.toContain('v2-path-note')
  })

  it('says in one line that there are more, that the parent cannot be read, that nothing matches, or that the read failed', () => {
    expect(menu({suggestions: {...suggestions, more: true}})).toContain('<p class="v2-path-note" role="status">还有更多，继续输入以缩小范围</p>')
    expect(menu({suggestions: {...suggestions, entries: [], issue: '目录不存在'}})).toContain('role="status">目录不存在</p>')
    expect(menu({suggestions: {...suggestions, entries: []}})).toContain('role="status">没有匹配的目录</p>')
    expect(menu({suggestions: undefined})).toContain('role="status">正在读取目录…</p>')
    expect(menu({suggestions: undefined, error: '请求失败（500）'})).toContain('role="status">请求失败（500）</p>')
  })

  it('makes the field a combobox tied to its list, closed until it is used', () => {
    const html = renderToStaticMarkup(<DirectoryDialog workspace={base.workspace} close={vi.fn()} changed={async () => {}}/>)
    const input = html.match(/<input[^>]*name="directory"[^>]*>/)?.[0] ?? ''
    expect(input).toContain('role="combobox"')
    expect(input).toContain('aria-autocomplete="list"')
    expect(input).toContain('aria-expanded="false"')
    expect(input).not.toContain('aria-activedescendant')
    const controls = input.match(/aria-controls="([^"]+)"/)?.[1]
    expect(controls).toBeTruthy()
    expect(html).toContain('<ul id="' + controls + '" role="listbox"')
    expect(html).toMatch(/<div class="v2-path-menu" hidden="">/)
  })

  it('accepts the suggestions response and rejects malformed ones', () => {
    const value = {scope: 'brain', ...suggestions}
    expect(isDirectorySuggestions(value)).toBe(true)
    expect(isDirectorySuggestions({...value, entries: [], issue: '目录不存在'})).toBe(true)
    expect(isDirectorySuggestions({...value, home: undefined})).toBe(false)
    expect(isDirectorySuggestions({...value, more: 'no'})).toBe(false)
    expect(isDirectorySuggestions({...value, entries: [{path: '/x', name: 'x'}]})).toBe(false)
    expect(isDirectorySuggestions({...value, entries: [{path: '/x', name: 'x', bindable: false, reason: 1}]})).toBe(false)
  })

  it('opens the menu downward in the dialog\'s flow with full-height touch rows on small screens', () => {
    expect(WORKSPACE_V2_STYLE).toMatch(/\.wv2 \.v2-path-menu \{[^}]*max-height:[^}]*overflow:auto/)
    expect(WORKSPACE_V2_STYLE).not.toMatch(/\.wv2 \.v2-path-menu \{[^}]*position:absolute/)
    const small = WORKSPACE_V2_STYLE.slice(WORKSPACE_V2_STYLE.lastIndexOf('@media(max-width:700px)'))
    expect(small).toMatch(/\.v2-path-menu li \{[^}]*min-height:44px/)
  })
})
