import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppResource } from '../core/workspace-calendar.ts'
import { workspaceError, workspaceFingerprint } from './superhub-goals.ts'

interface Binding {resource:AppResource; contents?:string}
interface State {
  schema: 1
  bindings: Binding[]
  receipts: Record<string,{fingerprint:string; resourceId:string}>
}
type Mutation = {key:string; fingerprint:string}
type ResourceKey = Pick<AppResource,'connectionId'|'kind'|'resourceId'>
const address = (key:ResourceKey) => JSON.stringify([key.connectionId,key.kind,key.resourceId])

export class AppResources {
  private file: string
  private state: State
  private revisions = new Map<string,number>()
  constructor(root:string, scope:string) {
    this.file = join(root, 'ops', 'superhub-v2', workspaceFingerprint(scope) + '.resources.json')
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file,'utf8')) : {schema:1,bindings:[],receipts:{}}
    if (this.state.schema !== 1 || !Array.isArray(this.state.bindings) || !this.state.receipts) throw new Error('应用连接记录格式无效')
  }
  list(kind?: string) { return this.state.bindings.filter(row => !kind || row.resource.kind === kind) }
  get(id:string) { return this.state.bindings.find(row => row.resource.id === id) }
  revision(key:ResourceKey) { return this.revisions.get(address(key)) ?? 0 }
  mutation(action:string, body:Record<string, unknown>) {
    if (typeof body.requestId !== 'string' || !/^[\w-]{1,128}$/.test(body.requestId)) return workspaceError(400,'请提供有效的请求标识。')
    return {key:'request-' + body.requestId,fingerprint:workspaceFingerprint([action,body])}
  }
  replay(mutation:Mutation) {
    const receipt = this.state.receipts[mutation.key]
    if (!receipt) return undefined
    if (mutation.fingerprint !== receipt.fingerprint) return workspaceError(409,'同一请求已用于其他连接操作。')
    return receipt.resourceId
  }
  put(mutation:Mutation, resource:Omit<AppResource,'id'>, contents?:string) {
    const replay = this.replay(mutation)
    if (replay) return replay
    const existing = this.state.bindings.find(row => row.resource.connectionId === resource.connectionId && row.resource.kind === resource.kind && row.resource.resourceId === resource.resourceId)
    const id = existing?.resource.id ?? randomUUID()
    const binding:Binding = {resource:{...resource,id}, ...(contents === undefined ? {} : {contents})}
    this.commit(mutation,binding.resource,[...this.state.bindings.filter(row => row !== existing),binding])
    return id
  }
  remove(mutation: Mutation,id:string) {
    if (this.replay(mutation)) return id
    const binding = this.get(id) ?? workspaceError(404,'这个资源已移除。')
    this.commit(mutation,binding.resource,this.state.bindings.filter(row => row.resource.id !== id))
    return id
  }
  private commit(mutation:Mutation,resource:AppResource,bindings:Binding[]) {
    const next:State = {...this.state, bindings,receipts:{...this.state.receipts,[mutation.key]:{fingerprint:mutation.fingerprint,resourceId:resource.id}}}
    mkdirSync(dirname(this.file),{recursive:true,mode:0o700})
    const temp = this.file + '.tmp'
    writeFileSync(temp,JSON.stringify(next),{mode:0o600})
    renameSync(temp,this.file)
    this.state = next
    this.revisions.set(address(resource),this.revision(resource) + 1)
  }
}
