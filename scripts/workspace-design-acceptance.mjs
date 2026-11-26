/** Exercise the shared SuperHub visual contract on the installed DSH and standalone bundles. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { button, CODEX_STAFF, say } from './workspace-browser-fixture.mjs'

const palette = {
  light: {paper:'rgb(255, 255, 255)', ink:'rgb(24, 26, 32)', action:'rgb(13, 14, 19)', on:'rgb(255, 255, 255)', focus:'rgb(77, 101, 245)', brandText:'rgb(63, 85, 196)', own:'rgb(233, 238, 255)', other:'rgb(255, 255, 255)'},
  dark: {paper:'rgb(20, 21, 25)', ink:'rgb(242, 242, 246)', action:'rgb(242, 242, 247)', on:'rgb(19, 20, 26)', focus:'rgb(145, 160, 255)', brandText:'rgb(178, 189, 255)', own:'rgb(43, 55, 88)', other:'rgb(27, 29, 35)'},
}
const title = (page, text) => page.getByRole('heading',{level:1,name:text,exact:true})
const navigation = page => page.getByRole('navigation',{name:'日常入口'})
const feed = page => page.getByRole('list',{name:'会话发言'})
const imageFacts = image => image.evaluate(async element => {
  await element.decode()
  return {local:element.currentSrc.startsWith('data:image/') || new URL(element.currentSrc).origin === location.origin,
    visible:element.naturalWidth > 0 && element.getBoundingClientRect().width > 0}
})
const contrast = (a,b) => {
  const luminance = color => color.match(/[\d.]+/g).slice(0,3).map(value => Number(value)/255)
    .map(value => value <= 0.04045 ? value/12.92 : ((value+0.055)/1.055)**2.4)
    .reduce((total,value,index) => total + value * [0.2126,0.7152,0.0722][index],0)
  const values = [luminance(a),luminance(b)].sort((x,y) => y-x)
  return (values[0]+0.05)/(values[1]+0.05)
}
const geometry = locator => locator.evaluate(element => {
  const {left,top,right,bottom,width,height} = element.getBoundingClientRect()
  return {left,top,right,bottom,width,height}
})

async function today(page,theme,projects) {
  const colors = palette[theme]
  await button(navigation(page),'今天').click()
  const heading = title(page,'今天'), primary = button(page,'打开对话')
  await heading.waitFor()
  await primary.waitFor()
  const rows = page.locator('.v2-space-card[data-workspace-id]')
  await rows.filter({hasText:projects.at(-1).goal}).waitFor()
  const surface = await page.locator('.wv2').evaluate(el => {
    const style = getComputedStyle(el)
    return {paper:style.backgroundColor, ink:style.color, scheme:style.colorScheme, width:el.clientWidth, font:style.fontFamily}
  })
  assert.equal(surface.paper,colors.paper)
  assert.equal(surface.ink,colors.ink)
  assert.equal(surface.scheme,theme)
  assert.match(surface.font,/Inter/)
  const compact = surface.width <= 740
  const fontSize = await heading.evaluate(el => parseFloat(getComputedStyle(el).fontSize))
  assert.ok(compact ? fontSize >= 42 && fontSize <= 60 : fontSize >= 57 && fontSize <= 86,`今天标题 ${fontSize}px，容器 ${surface.width}px`)
  const active = button(navigation(page),'今天')
  assert.equal(await active.getAttribute('aria-current'),'page')
  assert.deepEqual(await active.evaluate(el => [getComputedStyle(el).color,getComputedStyle(el.querySelector('svg')).color]),[colors.ink,colors.brandText])
  await active.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  assert.deepEqual(await active.evaluate(el => {
    const css = getComputedStyle(el)
    return [el === document.activeElement,css.outlineWidth,css.outlineColor,css.outlineOffset]
  }),[true,'3px',colors.focus,'2px'])
  await active.evaluate(el => el.blur())
  const [background,foreground] = await primary.evaluate(el => [getComputedStyle(el).backgroundColor,getComputedStyle(el).color])
  assert.deepEqual([background,foreground],[colors.action,colors.on])
  assert.ok(contrast(foreground,background) >= 4.5 && contrast(surface.ink,surface.paper) >= 4.5)

  const emblem = page.locator('.v2-home-emblem')
  const mark = page.locator('.v2-brand img')
  for (const asset of [emblem,mark]) assert.deepEqual(await imageFacts(asset),{local:true,visible:true})
  const markBox = await geometry(mark)
  assert.deepEqual([markBox.width,markBox.height],compact ? [23,26] : [27,30])
  const spacesHeading = page.getByRole('heading',{name:'我的工作区',exact:true})
  assert.equal(await spacesHeading.evaluate(el => getComputedStyle(el).fontSize),compact ? '20px' : '23px')
  const [hero,titleBox,library,workspaces] = await Promise.all([geometry(emblem),geometry(heading),
    geometry(page.getByRole('heading',{name:'已有资料',exact:true})), geometry(spacesHeading)])
  assert.ok(hero.left > titleBox.left && hero.bottom > titleBox.top && hero.top < titleBox.bottom,'今天标题与 H 在同一行')
  assert.ok(compact ? workspaces.top >= library.bottom && Math.abs(workspaces.left-library.left) <= 2
    : Math.abs(workspaces.top-library.top) <= 4 && workspaces.left > library.right, '资料和工作区跟随容器分栏')
  const icons = {}
  for (const entry of projects) {
    const row = rows.filter({hasText:entry.goal})
    assert.equal(await row.getAttribute('data-workspace-id'),entry.id)
    const icon = row.locator('img[data-workspace-icon]')
    assert.deepEqual(await imageFacts(icon),{local:true,visible:true})
    icons[entry.id] = await icon.getAttribute('data-workspace-icon')
    if (entry.icon) assert.equal(icons[entry.id],entry.icon)
    const label = await row.locator('strong').evaluate(el => {
      const style = getComputedStyle(el)
      return {size:style.fontSize,color:style.color,wraps:el.clientHeight >= 2 * parseFloat(style.lineHeight)-1,clipped:el.scrollWidth > el.clientWidth+1}
    })
    assert.deepEqual([label.size,label.color,label.clipped],['16px',colors.ink,false])
    if (compact && entry.name.length > 50) assert.ok(label.wraps,'长项目名完整换行')
    assert.ok(await row.evaluate(el => el.scrollWidth <= el.clientWidth+1 && el.getBoundingClientRect().right <= el.closest('.wv2').getBoundingClientRect().right+1),'项目名和进入操作在可读区域内')
  }
  return icons
}

async function readGroup(page,base,hash,theme) {
  await page.goto(base+'/'+hash)
  const list = feed(page)
  await list.getByText('我核对了报名字段，姓名和邮箱足够。',{exact:true}).waitFor()
  const compact = await page.locator('.wv2').evaluate(el => el.clientWidth <= 740)
  const avatars = {}
  // A group: the owner, the liaison (its admin) and the staff member it called.
  for (const name of ['你','接口人','研究员']) {
    const row = list.getByRole('listitem').filter({has:page.getByText(name,{exact:true})}).first()
    // The speaker's own avatar (a group's mention chips carry small member avatars inside the bubble too).
    const avatar = row.locator('.v2-turn > .v2-chat-avatar')
    const facts = await avatar.evaluate(el => ({shape:el.dataset.shape,color:el.dataset.color,width:Math.round(el.getBoundingClientRect().width),
      moving:el.getAnimations({subtree:true}).length,decorative:el.getAttribute('aria-hidden')}))
    assert.equal(facts.width,compact ? 32 : 36)
    assert.equal(facts.moving,0,'初次打开历史时头像静止')
    assert.equal(facts.decorative,'true')
    assert.ok(facts.shape && facts.shape !== 'neutral' && facts.color, '可核实来源具备物件和配色')
    if (name === '你') assert.equal(facts.shape,'plane')
    avatars[name] = [facts.shape,facts.color]
    const bubble = row.locator('.v2-bubble')
    const color = await bubble.evaluate(el => getComputedStyle(el).backgroundColor)
    assert.equal(color,name === '你' ? palette[theme].own : palette[theme].other)
    const textColor = await bubble.locator('p').first().evaluate(el => getComputedStyle(el).color)
    assert.ok(contrast(textColor,color) >= 4.5,'会话正文对比度至少 4.5∶1')
    assert.ok(await row.locator('time').first().getAttribute('datetime'))
  }
  assert.equal(new Set(Object.values(avatars).map(item => item[0])).size,3)
  if (compact) {
    await button(page,'返回会话列表').waitFor()
    assert.equal(await page.getByLabel('发言',{exact:true}).evaluate(el => getComputedStyle(el).fontSize),'16px')
  } else await page.getByRole('navigation',{name:'执行会话列表'}).waitFor()
  return avatars
}

async function checkLiveMotion(page,base,hash) {
  await page.goto(base+'/'+hash)
  await feed(page).getByText('我先核对两个必填字段。',{exact:true}).waitFor()
  // Count native animation objects while the actual view polls, including ones that finish before the test resumes.
  await page.evaluate(() => {
    const seen = new WeakSet(), counts = new Map()
    const scan = () => {
      for (const avatar of document.querySelectorAll('[data-message-id] .v2-chat-avatar')) {
        const id = avatar.closest('[data-message-id]').dataset.messageId
        for (const item of avatar.getAnimations({subtree:true})) {
          if (!seen.has(item)) { seen.add(item); counts.set(id,(counts.get(id) ?? 0)+1) }
        }
      }
      requestAnimationFrame(scan)
    }
    window.avatarPlayCounts = counts
    scan()
  })
  const text = '追加确认手机版字段顺序。'
  const row = feed(page).locator('[data-message-id]').filter({hasText:text}).first()
  const duringPlay = page.waitForFunction(text => {
    const row = [...document.querySelectorAll('[data-message-id]')].find(el => el.textContent.includes(text))
    return row && window.avatarPlayCounts.has(row.dataset.messageId) && row.querySelector('.v2-turn > .v2-chat-avatar').getAnimations({subtree:true}).some(item => item.playState === 'running')
  },text)
  // The coding group's conversation is between the owner and its Codex member: call it, as the owner did there.
  const to = '@' + CODEX_STAFF.name + ' '
  await Promise.all([say(page,to + text),duringPlay.then(async () => {
    await page.emulateMedia({reducedMotion:'reduce'})
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await row.locator('.v2-turn > .v2-chat-avatar').evaluate(el => el.getAnimations({subtree:true}).length),0,'播放中切换减少动态应立即归位')
  })])
  const id = await row.getAttribute('data-message-id')
  const count = await page.evaluate(id => window.avatarPlayCounts.get(id),id)
  assert.ok(count > 0,'真实新发言触发了头像动作')
  const quietText = '把减少动态时新增的提醒也记在这里。'
  await say(page,to + quietText)
  const quiet = feed(page).getByRole('listitem').filter({hasText:quietText}).first()
  const quietId = await quiet.getAttribute('data-message-id')
  assert.equal(await page.evaluate(id => window.avatarPlayCounts.has(id),quietId),false)
  await page.emulateMedia({reducedMotion:'no-preference'})
  const sessionId = new URLSearchParams(hash.slice(4)).get('session')
  await page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/sessions/'+sessionId))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.evaluate(id => window.avatarPlayCounts.get(id),id),count,'轮询重复收到同一条消息时保持静止')
  // Archived display names and independently identified, same-named people can coexist in an older projection.
  const archivedId = 'archived-display-name-only'
  const peers = ['s-'+ '3'.repeat(24),'s-'+ '4'.repeat(24),'s-'+ '5'.repeat(24)]
  const visibleShapes = () => feed(page).locator('.v2-chat-avatar').evaluateAll(icons =>
    [...new Set(icons.map(el => el.dataset.shape).filter(shape => shape !== 'neutral'))])
  const activeShapes = await visibleShapes()
  let reordered = false
  const sessionRead = url => url.pathname.endsWith('/sessions/'+sessionId)
  await page.route(sessionRead,async route => {
    const response = await route.fetch()
    const result = await response.json()
    const old = {id:archivedId,role:'agent',author:'Codex',at:'2020-01-01T00:00:00Z',text:'归档里只保留了这条发言的署名。'}
    const portraits = {...result.portraits}
    const used = new Set(Object.values(portraits).map(p => p.shape))
    const shapes = ['lighthouse','bell','fan','key','hourglass'].filter(shape => !used.has(shape))
    const older = peers.map((speakerId,i) => {
      portraits[speakerId] = {shape:shapes[i],color:['mint','violet','apricot'][i]}
      return {...old,id:'former-'+i,speakerId,author:i < 2 ? '同名顾问' : '在客户端展示完整署名的项目协调人',
        at:'2020-01-02T00:00:00Z',text:'第'+(i+1)+'位同事的归档发言。'}
    })
    await route.fulfill({response,json:{...result,portraits,messages:[old,...(reordered ? older.reverse() : older),...result.messages]}})
  })
  try {
    const old = feed(page).locator('[data-message-id="'+archivedId+'"]')
    await old.getByText('Codex',{exact:true}).waitFor()
    assert.equal(await old.locator('.v2-chat-avatar').getAttribute('data-shape'),'neutral')
    assert.equal(await page.evaluate(id => window.avatarPlayCounts.has(id),archivedId),false,'补读历史记录保持静止')
    const pairings = () => feed(page).locator('[data-message-id^="former-"]').evaluateAll(rows => Object.fromEntries(rows.map(row => {
      const avatar = row.querySelector('.v2-chat-avatar'), name = row.querySelector('.v2-byline strong').textContent
      return [row.dataset.messageId,[name,avatar.dataset.shape,avatar.dataset.color]]
    })))
    const initial = await pairings()
    assert.equal(initial['former-0'][0],initial['former-1'][0])
    assert.equal(initial['former-2'][0],'在客户端展示完整署名的项目协调人')
    assert.equal(new Set(Object.values(initial).map(([,shape]) => shape)).size,peers.length,'已有来源的同名成员各有独立头像')
    reordered = true
    await page.waitForFunction(() => document.querySelector('[data-message-id^="former-"]')?.dataset.messageId === 'former-2')
    assert.deepEqual(await pairings(),initial,'历史顺序改变也能读到同一位成员的署名与头像')
    const shapes = await visibleShapes()
    assert.equal(shapes.length,activeShapes.length + peers.length,'归档里的三位具名参与者各有可辨认的轮廓')
  } finally { await page.unroute(sessionRead) }
}

export async function checkWorkspaceDesign({desktop,mobile,host,scope,password,project,groupHash,codingHash,picture}) {
  const projects = [{...project,icon:'prototype'}]
  const longName = '跨团队交付与反馈的长期项目 ' + 'LongProjectName'.repeat(4)
  for (const [name,goal,icon] of [['客户访谈','跟进客户访谈的原始记录','recorder'],['研究周报','汇编研究小组的周报','report'],
    [longName,'按第一份协议跟进试点记录'],[longName,'按第二份协议跟进试点反馈']]) {
    const {workspace} = await host.api('/v2/workspaces?scope='+encodeURIComponent(scope),{scope,name,goal,requestId:randomUUID()})
    projects.push({...workspace,icon})
  }
  await desktop.goto(host.base)
  await mobile.goto(host.mobileBase)
  const login = mobile.getByLabel('密码')
  await login.or(title(mobile,'今天')).first().waitFor()
  if (await login.isVisible()) {
    await login.fill(password)
    await button(mobile,'进入').click()
  }
  let firstIcons,firstAvatars
  for (const [page,base,width,height] of [[desktop,host.base,1440,900],[desktop,host.base,850,900],
    [mobile,host.mobileBase,390,844],[mobile,host.mobileBase,320,740]]) {
    await page.bringToFront()
    await page.setViewportSize({width,height})
    for (const theme of ['light','dark']) {
      await page.emulateMedia({colorScheme:theme})
      if (page === desktop) await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark,theme === 'dark')
      const icons = await today(page,theme,projects)
      firstIcons ??= icons
      assert.deepEqual(icons,firstIcons)
      await picture(page,'design-today-'+width+'-'+theme)
      const avatars = await readGroup(page,base,groupHash,theme)
      firstAvatars ??= avatars
      assert.deepEqual(avatars,firstAvatars,'同一群的发言身份在主题、设备和重开后保持稳定')
      await picture(page,'design-group-'+width+'-'+theme)
    }
  }
  await desktop.setViewportSize({width:1440,height:900})
  for (const page of [desktop,mobile]) {
    await page.bringToFront()
    await page.emulateMedia({colorScheme:'light'})
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.wv2')).colorScheme === 'light')
    // DSH's explicit theme can differ from the OS. The standalone entry follows the OS preference.
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme',''))
    try {
      const actual = await page.locator('.wv2').evaluate(el => getComputedStyle(el).backgroundColor)
      assert.equal(actual,page === desktop ? palette.dark.paper : palette.light.paper)
    } finally { await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme')) }
  }
  // The header's SuperHub mark is the way home on both clients: a click, or Enter on the focused mark.
  for (const page of [desktop,mobile]) {
    await page.bringToFront()
    const brand = button(page,'SuperHub 首页')
    for (const [from,press] of [[projects[1],false],[projects[2],true]]) {
      await button(navigation(page),'今天').click()
      await page.getByRole('button').filter({hasText:from.goal}).click()
      await title(page,from.name).waitFor()
      assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(4)).get('workspace'),from.id)
      if (press) { await brand.focus(); await page.keyboard.press('Enter') }
      else await brand.click()
      await title(page,'今天').waitFor()
      const place = new URLSearchParams(new URL(page.url()).hash.slice(4))
      assert.equal(place.get('view') ?? 'today','today')
      assert.equal(place.get('workspace'),null,'标志回到不带工作区的今天')
    }
    assert.equal(await brand.evaluate(el => getComputedStyle(el).cursor),'pointer')
  }
  await desktop.bringToFront()
  await button(navigation(desktop),'今天').click()
  const narrow = await desktop.addStyleTag({content:'.wv2 { max-width:620px !important }'})
  await today(desktop,'light',projects)
  assert.equal(await desktop.evaluate(() => innerWidth),1440)
  assert.equal(await desktop.locator('.wv2').evaluate(el => el.clientWidth),620)
  await picture(desktop,'design-narrow-host-panel')
  await narrow.evaluate(el => el.remove())
  for (const record of projects.slice(-2)) {
    const row = desktop.getByRole('button').filter({hasText:record.goal})
    await row.focus()
    await desktop.keyboard.press('Enter')
    await title(desktop,record.name).waitFor()
    assert.equal(new URLSearchParams(new URL(desktop.url()).hash.slice(4)).get('workspace'),record.id)
    await button(navigation(desktop),'今天').click()
  }
  await checkLiveMotion(desktop,host.base,codingHash)
  console.log('PASS 双端打包设计规范、标志回到今天（点击与 Enter）、两种主题、1440/850/390/320 与窄宿主容器、本地标志、工作区身份和键盘进入、原生群头像与新发言动效')
}
