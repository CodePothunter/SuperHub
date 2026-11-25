import { expect, it, vi } from 'vitest'
import type { ExperienceSelection } from '../src/core/workspace-experience.ts'
import { NativeExperience } from '../src/dsh/workspace-native-experience.ts'

const selection: ExperienceSelection = {scope:'brain', authority:'current', query:{workspaceId:'alpha',task:'访谈'},
  entries:[{id:'method',version:1,text:'访谈结束后复述约定',workspaceId:'alpha'}], authorized:[{id:'method',version:1}]}
const target = {sessionId:'group',nativeSessionId:'agent',turnId:'request',executorId:'member'}
const request = (text: string) => ({sessionId:'agent',messages:[{role:'system',content:[{type:'text',text}]}]})
async function collect(source: AsyncIterable<unknown>) { for await (const _chunk of source) { /* Consume the actual response. */ } }

it('records only when the rendered version reaches an actual model response', async () => {
  const recordExperienceDelivery = vi.fn(), assertExperienceCurrent = vi.fn()
  const native = new NativeExperience({selectExperience:()=>selection,recordExperienceDelivery,assertExperienceCurrent},vi.fn())
  const prompt = native.prompt('agent',selection.query,target)
  await collect(native.request(request('另一个请求'), async function* () { yield {type:'text-delta',text:'完成'} }))
  await collect(native.request(request(prompt), async function* () { yield {type:'finish',reason:{kind:'error'}} }))
  expect(recordExperienceDelivery).not.toHaveBeenCalled()
  await collect(native.request(request(prompt), async function* () {
    yield {type:'text-delta',text:'完成'}
    yield {type:'finish',reason:{kind:'stop'}}
  }))
  expect(assertExperienceCurrent).toHaveBeenCalledWith(selection)
  expect(recordExperienceDelivery).toHaveBeenCalledExactlyOnceWith(selection,target)
})

it('binds the owner input before the system prompt and rejects a stale retained experience block', () => {
  const selectExperience = vi.fn().mockReturnValueOnce(selection)
    .mockReturnValueOnce({...selection,query:{workspaceId:'beta',task:'访谈'},entries:[],authorized:[]})
  const native = new NativeExperience({selectExperience,recordExperienceDelivery:vi.fn(),assertExperienceCurrent:vi.fn()},vi.fn())
  const previous = native.prompt('agent',selection.query,target)
  expect(native.step('agent',{kind:'enter',messages:[{source:{kind:'user',rpcId:'new'},content:[{type:'text',text:'在乙准备访谈'}]}]},true))
    .toMatchObject({startsRequestSeries:true})
  expect(native.ownedInput('agent')?.text).toBe('在乙准备访谈')
  native.prompt('agent',{workspaceId:'beta',task:'访谈'},{...target,turnId:'new'})
  const next = vi.fn()
  expect(()=>native.request(request(previous),next)).toThrow('原生会话仍含已变化的经验')
  expect(next).not.toHaveBeenCalled()
})
