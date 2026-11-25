import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { avatarColors, avatarShapes, liaisonPortrait, ownerPortrait, registerSpeakers } from '../src/core/workspace-avatars.ts'
import type { V2Session } from '../src/core/workspace-v2.ts'
import { ChatAvatar, ConversationArrivals } from '../src/client/workspace-chat-avatar.tsx'
import { animatePortrait } from '../src/client/workspace-avatar-motion.ts'
import { groupLeadId, liaisonSpeakerId, workspaceSpeakerId } from '../src/dsh/workspace-speaker-id.ts'
import { dialogueKey, groupSpeech, ownerMessageId, WorkspaceGroups } from '../src/dsh/workspace-v2-group.ts'
import { createV2DialogueSource } from '../src/dsh/workspace-v2-dialogue.ts'
import { mutationKey, WorkspaceV2Store } from '../src/dsh/workspace-v2-store.ts'
import { chatFromEvents, offsetSpeech } from '../src/dsh/chat.ts'
import type { HostContext, SessionEventLike } from '../src/dsh/ports.ts'

afterEach(() => vi.unstubAllGlobals())
const event = (seq: number, type: string, data: unknown): SessionEventLike => ({seq, type, time: seq * 1000, data})

describe('conversation speaker identity and motion', () => {
  it('keeps five actual speakers distinct, including two identical signatures, after refresh, reordering and a new arrival', () => {
    const root = mkdtempSync(join(tmpdir(), 'chief-chat-portrait-'))
    try {
      const store = new WorkspaceV2Store(root, 'brain')
      const workspace = store.createWorkspace(mutationKey(['spaces'], {requestId:'space'}), {name:'研发'}).workspace
      const session = store.createSession(mutationKey(['sessions'], {requestId:'session'}), workspace.id, {kind:'group',title:'实施'}).session
      const scope = 'opaque-native-lead'
      const peers = [
        {id:'opaque-native-1', name:'同名成员', events:[]}, {id:'opaque-native-2', name:'同名成员', events:[]},
        {id:'opaque-native-3', name:'项目协调人', events:[]},
      ]
      const content = [{type:'text', text:'核对进展'}]
      const sources = [{id:scope, name:'lead', events:[
        event(1,'user/message',{source:{kind:'user',rpcId:'authorized'},content}),
        event(2,'assistant/message',{message:{content}}),
        ...peers.map((m,i) => event(i+3,'user/message',{source:{kind:'agent-message',senderSessionId:m.id},content})),
      ]}, ...peers]
      const rows = groupSpeech(scope, sources)
      expect(rows.map(row => row.author)).toEqual(['你','讨论接口人','同名成员','同名成员','项目协调人'])
      const ids = rows.map(row => row.speakerId!)
      expect(new Set(ids).size).toBe(5)
      expect(JSON.stringify(ids)).not.toContain('opaque-native')
      const initial = store.speakerPortraits(workspace.id, session.id, ids)
      expect(initial.owner).toEqual(ownerPortrait)
      expect(new Set(Object.values(initial).map(portrait => portrait.shape)).size).toBe(5)
      store.dispose()
      const reopened = new WorkspaceV2Store(root, 'brain')
      const subsequent = workspaceSpeakerId(scope, 'native-member', 'late')
      const again = reopened.speakerPortraits(workspace.id, session.id, [subsequent, ...ids.toReversed()])
      for (const id of ids) expect(again[id]).toEqual(initial[id])
      expect(Object.values(initial).some(p => p.shape === again[subsequent]!.shape)).toBe(false)
      // Allocation is deterministic; the store keeps the liaison's look reserved for the liaison of this conversation.
      const liaison = liaisonSpeakerId(groupLeadId('brain', workspace.id, session.id))
      const {[liaison]: reservedLook, ...pure} = registerSpeakers({[liaison]: liaisonPortrait}, ids.toReversed())
      expect(reservedLook).toEqual(liaisonPortrait)
      expect(pure).toEqual(initial)
      expect(Object.values(initial).some(p => p.shape === liaisonPortrait.shape)).toBe(false)
      expect(workspaceSpeakerId('another conversation', 'native-member', peers[0]!.id)).not.toBe(ids[2])
      expect(registerSpeakers({}, ['同名成员', '__proto__'])).toEqual({})
      expect(renderToStaticMarkup(<ChatAvatar/>)).toContain('data-shape="neutral"')
      reopened.dispose()
    } finally { rmSync(root, {recursive:true, force:true}) }
  })

  it('reproduces all seventy painted silhouettes and keeps original colors for the five reviewed default drawings', () => {
    const outputs = new Set<string>()
    for (const shape of avatarShapes) for (const color of avatarColors) {
      const svg = renderToStaticMarkup(<ChatAvatar portrait={{shape, color}}/>)
      expect(svg).toContain(`data-shape="${shape}" data-color="${color}"`)
      expect(svg).toContain('aria-hidden="true"')
      expect(svg).toContain('<path')
      expect(svg).not.toMatch(/<img|<image|href=/)
      outputs.add(svg.replace(/ data-(?:shape|color)="[^"]+"/g,''))
    }
    expect(outputs.size).toBe(70)
    for (const portrait of [ownerPortrait, {shape:'sprout',color:'mint'}, {shape:'wrench',color:'apricot'},
      {shape:'compass',color:'blue'}, {shape:'pencil',color:'honey'}] as const) {
      expect(renderToStaticMarkup(<ChatAvatar portrait={portrait}/>)).not.toContain('style="')
    }
    expect(renderToStaticMarkup(<ChatAvatar portrait={{shape:'plane',color:'blue'}}/>)).toContain('#90ABFF')
    expect(renderToStaticMarkup(<ChatAvatar portrait={{shape:'plane',color:'mint'}}/>)).toContain('--portrait-body:#64CAAB')
  })

  it('recovers source-backed owners, executor and acceptance replies from a pre-avatar journal while a signature alone stays unassigned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'chief-chat-legacy-'))
    const scope = 'avatar-migration', ctx = {get:() => undefined} as unknown as HostContext
    const session: V2Session = {id:'session',workspaceId:'project',executor:'codex',kind:'coding',title:'原始记录',
      delegationIds:[],closed:true,createdAt:'2026-01-01T00:00:00Z'}
    const groups = new WorkspaceGroups(ctx, scope)
    const source = createV2DialogueSource({root,scope,ctx})
    try {
      await source.read(session)
      const lead = groups.leadId(session.workspaceId, session.id)
      const area = dialogueKey(scope, session.workspaceId)
      const journal = join(root, 'ops','superhub-v2-dialogues',area,dialogueKey(area,session.id),'source.json')
      const ownerId = ownerMessageId(lead, 'brief'), feedbackId = ownerMessageId(lead, 'repair-one')
      const records = [
        {id:ownerId,role:'user',author:'你',text:'写个交接清单'},
        {id:'m-'+dialogueKey(lead,'brief','confirmed-output').slice(0,32),role:'agent',author:'Codex',text:'这是清单'},
        {id:feedbackId,role:'agent',author:'交付验收',text:'请补充范围'},
        {id:'name-only',role:'agent',author:'Codex',text:'旧来源只有署名'},
      ]
      writeFileSync(journal, JSON.stringify({turns:[
        {id:'brief',text:'写个交接清单',state:'done'}, {id:'repair-one',text:'请补充范围',state:'done'}],
      members:[],attachments:[],messages:records.map(m => ({...m,at:session.createdAt}))}))
      const rows = (await source.read(session)).messages
      expect(rows.map(row => row.speakerId)).toEqual(['owner',workspaceSpeakerId(lead,'executor','codex'),
        workspaceSpeakerId(lead,'host','delivery-review'),undefined])
      expect(rows.map(row => row.author)).toEqual(records.map(record => record.author))
    } finally { source.dispose(); groups.dispose(); rmSync(root,{recursive:true,force:true}) }
  })

  it('leaves the initial, reloaded and late historical snapshots still; a distinct new message plays once', () => {
    const view = new ConversationArrivals()
    const first = {id:'existing', at:100}, next = {id:'new', at:201}, backup = {id:'older', at:150}
    expect(view.observe('group', [first], 190).size).toBe(0)
    expect([...view.observe('group', [backup, next, first], 220)]).toEqual(['new'])
    expect(view.observe('group', [next, backup, first], 250).size).toBe(0)
    expect(view.observe('different group', [next], 300).size).toBe(0)
    expect(view.observe('group', [next, backup, first], 320).size).toBe(0)
  })

  it('plays each individual gesture on its intended part, replaces replays, and stops immediately on reduced motion', async () => {
    const preference = Object.assign(new EventTarget(), {matches:false})
    vi.stubGlobal('window', {matchMedia:() => preference})
    for (const shape of avatarShapes) {
      preference.matches = false
      const played: {frames:Keyframe[]; duration:number; stopped:boolean}[] = []
      const animate = (frames:Keyframe[], options:{duration:number}) => {
        const state = {frames,duration:options.duration,stopped:false}
        const completed = Promise.withResolvers<void>()
        played.push(state)
        return {finished:completed.promise, cancel:() => { state.stopped = true; completed.resolve() }}
      }
      const selector = vi.fn(() => ({animate}))
      const svg = {querySelector:selector} as unknown as SVGSVGElement
      animatePortrait(svg, shape)
      expect(selector).toHaveBeenCalledWith(['sprout','compass','lighthouse','hourglass'].includes(shape) ? '[data-moving]' : '[data-object]')
      expect(played[0]!.duration).toBeGreaterThanOrEqual(630)
      expect(played[0]!.duration).toBeLessThanOrEqual(810)
      expect(played[0]!.frames[0]!.transform).toBe('none')
      expect(played[0]!.frames.at(-1)!.transform).toBe('none')
      animatePortrait(svg, shape)
      expect(played.map(run => run.stopped)).toEqual([true,false])
      preference.matches = true
      preference.dispatchEvent(new Event('change'))
      expect(played[1]!.stopped).toBe(true)
      expect(animatePortrait(svg, shape)).toBeUndefined()
      await Promise.resolve()
    }
  })

  it('carries one native liaison speech identity through streaming, completion and archived sequence offsets', () => {
    const messages = [event(1,'turn/start',{}),
      event(2,'assistant/message',{message:{content:[{type:'text',text:'正在查。'}]}}),
      event(3,'assistant/message',{message:{content:[{type:'text',text:'已查到。'}]}})]
    const live = chatFromEvents(messages).live!
    expect(live).toMatchObject({firstSeq:2,firstSpokenAt:2000})
    const settled = chatFromEvents([...messages,event(4,'turn/end',{})]).messages[0]!
    expect(settled).toMatchObject({firstSeq:2,seq:3,time:2000,text:'正在查。\n\n已查到。'})
    expect(offsetSpeech(settled, 1000)).toMatchObject({firstSeq:1002,seq:1003})
  })
})
