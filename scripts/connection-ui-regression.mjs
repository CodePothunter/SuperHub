/** A failed or expired connection must never be presented as an empty brain. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const scope = 'workspace-connection-fixture'
const workspace = { id:'w1', name:'保留的工作区', goal:'找回上一次保存的工作', owner:'我', createdAt:'2026-01-01T00:00:00Z' }
const library = {scope,total:0,available:0,items:[],counts:{room:0,person:0,commitment:0,line:0,meeting:0,project:0,goal:0,document:0}}
const {chromium}=await import(pathToFileURL(process.env.CHIEF_PLAYWRIGHT_PATH).href)
let failure=''
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://local').pathname.replace(/^\/mounted/,'')
 if(path.startsWith('/chief/api/')){
  const endpoint=path.slice('/chief/api'.length)
  if(endpoint==='/v2/bootstrap'&&failure){
   res.writeHead(failure==='unauthorized'?401:failure==='offline'?503:200,{'content-type':failure==='html'?'text/html':'application/json'})
   const malformed={invalid:{},setup:{setup:null},configure:{scope,configure:'false',build:'dev'}}
   res.end(failure==='html'?'<html>Wrong host</html>':JSON.stringify(malformed[failure] ?? {error:failure==='unauthorized'?'未登录':'主机暂不可达'}));return
  }
  res.writeHead(200,{'content-type':'application/json'})
  const records={'/v2/bootstrap':{scope,configure:false,build:'dev'},'/v2/workspaces':{scope,workspaces:[workspace]},'/v2/history':library,
    '/v2/notices':{scope,items:[],unread:0,total:0},'/chat/unread':{scope,unread:0},'/v2/approvals':{scope,approvals:[],acceptances:[]},
    '/v2/owner-actions':{scope,items:[]}}
  res.end(JSON.stringify(records[endpoint]??{}));return
 }
 const name=path.endsWith('/')?'index.html':path.split('/').at(-1)
 if(!['index.html','app.js','page.css','icon.svg','manifest.webmanifest'].includes(name)){res.writeHead(404);res.end();return}
 res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'})
 res.end(readFileSync(join(process.env.CHIEF_LIB_DIR ?? 'lib','mobile',name)))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({headless:true,...process.env.CHIEF_CHROMIUM_PATH?{executablePath:process.env.CHIEF_CHROMIUM_PATH}:{}})
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),base=`http://127.0.0.1:${server.address().port}`
 const errors=[];page.on('pageerror',error=>errors.push(error.message))
 for(const kind of ['unauthorized','html','invalid','setup','configure']){
  failure=kind
  await page.goto(base+'/')
  await page.getByRole('heading',{name:'工作区连接中断'}).waitFor()
  assert.equal(await page.getByRole('heading',{name:'今天',exact:true}).count(),0,'failed initial load must not show an empty board')
  if(kind==='unauthorized') await page.getByText('登录连接已失效，请重新连接 DSH',{exact:true}).waitFor()
  failure='';await page.getByRole('button',{name:'重新连接',exact:true}).click()
  await page.getByRole('heading',{name:'今天',exact:true}).waitFor()
  await page.getByRole('button',{name:/保留的工作区/}).waitFor({timeout:6000}).catch(async error=>{
   throw new Error(`恢复连接后缺少工作区（${kind}）：${await page.locator('main').innerText()} ${errors.join(' ')}`,{cause:error})
  })
 }
 const card=page.getByRole('button',{name:/保留的工作区/})
 const text=await card.innerText()
 failure='offline';await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
 await page.locator('.chief-connection-banner').waitFor({state:'visible'})
 assert.equal(await card.innerText(),text,'transient failure retains the previous workspace')
 assert.equal(await page.getByRole('heading',{name:'今天',exact:true}).count(),1)
 failure='';await page.locator('.chief-connection-banner').getByRole('button',{name:'重试连接'}).click()
 await page.locator('.chief-connection-banner').waitFor({state:'hidden'})
 await page.goto(base+'/mounted/chief/m/')
 await page.getByRole('heading',{name:'今天',exact:true}).waitFor()
 await card.waitFor()
 const legacyId='T-0011'
 const importId='profile-'+'a'.repeat(64)
 const note='我偏好先核对原文里的日期'
 const profile={scope,record:{id:importId,source:'Claude',at:workspace.createdAt,status:'review',pending:1,total:1,text:note+' [记忆]',
  items:[{id:'item-'+'b'.repeat(32),version:1,category:'preferences',text:note,quote:note+' [记忆]',
   sourceType:'memory',confidential:false,status:'pending',targets:[{id:'me',label:'关于我',version:0}]}]}}
 const apiPaths=[], recordScopes=[]
 await page.route('**/chief/api/**',async route=>{
  const url=new URL(route.request().url()),path=decodeURIComponent(url.pathname).split('/chief/api').at(-1)
  apiPaths.push(path)
  if(path==='/v2/profile/imports' || path==='/v2/profile/imports/'+importId){
   recordScopes.push(url.searchParams.get('scope'))
   return route.fulfill({json:path.endsWith('/'+importId) ? profile : {scope,imports:[]}})
  }
  return route.continue()
 })
 await page.goto(base+'/mounted/chief/m/#v2?'+new URLSearchParams({scope,view:'history',item:'ticket:'+legacyId}))
 await page.getByText(/这张工单已不可用/).waitFor()
 assert.equal(await page.getByRole('button',{name:'原工单操作'}).count(),0)
 assert.ok(!apiPaths.some(path=>/^\/(?:tickets|v2\/orders\/resolve)(?:\/|$)/.test(path)))
 await page.goto(base+'/mounted/chief/m/#v2?'+new URLSearchParams({scope,view:'profile',item:importId}))
 await page.getByRole('heading',{name:'核对资料',exact:true}).waitFor()
 await page.getByText(note,{exact:true}).first().waitFor()
 assert.ok(recordScopes.length>0 && recordScopes.every(seen=>seen===scope),'profile requests retain owner scope on a mounted base')
 const key=`superhub-v2:draft:${scope}:profile:${importId}`
 await page.evaluate(({key,note})=>sessionStorage.setItem(key,note),{key,note})
 assert.equal(await page.evaluate(note=>Object.values(localStorage).some(text=>text.includes(note)),note),false)
 await page.evaluate(()=>sessionStorage.setItem('superhub-v2:draft:other-owner:notes:sample','other'))
 failure='unauthorized';await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')))
 await page.getByText('登录连接已失效，请重新连接 DSH',{exact:true}).waitFor()
 assert.equal(await card.count(),0,'an expired owner login clears the last workspace')
 assert.equal(await page.getByText(note,{exact:true}).count(),0,'an expired owner login clears private profile data')
 assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),key),null,'revoking the owner removes private drafts')
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('superhub-v2:draft:other-owner:notes:sample')),'other')
 assert.deepEqual(errors,[])
 console.log('PASS expired login, invalid responses, recovery, retired links, scoped profile routing and revocation')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
