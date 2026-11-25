/* Synthetic scenes for the product tour. All controls change local presentation state. */
(() => {
 const $=s=>document.querySelector(s);
 const art=(name,cls='')=>`<img class="${cls}" src="assets/${name}.svg" alt="">`;
 const button=(text,primary=false)=>`<span class="stage-button${primary?' primary':''}">${text}</span>`;
 const message=(name,avatar,text,own=false,fresh=false)=>`<div class="msg ${own?'own':''} ${fresh?'fresh':''}">${art(avatar)}<div><div class="by">${name}<small>09:41</small></div><div class="bubble">${text}</div></div></div>`;
 const receipt=()=>`<div class="receipt-card">${art('prototype')}<div><b>接入修复方案</b><small>产品研发 · 已交办到工作区</small></div><span>打开工单 ↗</span></div>`;
 const reportFile=()=>`<button class="file" data-report>${art('report')}<span>接入排查报告.md<small>点击查看演示文稿</small></span><span>↗</span></button>`;
 const place=(name,goal,icon)=>`<div class="today-space">${art(icon)}<div><b>${name}</b><p>${goal}</p></div><span>进入工作区 ›</span></div>`;
 const bar=(active='today',unread=0,arrive=false)=>`<div class="story-appbar"><span class="brand">${art('hub-small')}SuperHub</span><div class="story-appnav"><span class="${active==='today'?'active':''}">今天</span><span class="${active!=='today'?'active':''}">工作区</span><span class="wide">人物</span><span class="wide">日历</span></div><div class="story-actions"><span class="setting">设置</span><span class="story-say">一句话交办${unread?`<b class="red-badge${arrive?' arrive':''}">${unread}</b>`:''}</span></div></div>`;
 function home(delivered=false){return `<div class="stage-page today-page"><div class="today-top ${delivered?'compact':''}"><div><div class="stage-eyebrow">2026 年 11 月 25 日　星期三</div><h2>今天</h2><p>导入　·　导出</p></div><img src="assets/hub-fold.webp" alt=""></div>${delivered?`<div class="inbox-mini"><h4>工单交付（1 条未读）</h4><p><b>接入修复方案</b>　产品研发</p><small>已交回报告 · 实际配置尚未变更</small>${reportFile()}</div>`:`<div class="today-intake"><div><h3>接口人</h3><p>把想办的事交给我。</p></div>${button('打开对话',true)}</div>`}<div class="today-columns"><div class="history-block"><h3>已有资料</h3><div class="today-records"><span>个人背景与偏好</span><span>查看 ›</span></div><div class="today-records"><span>人物、约定与文档</span><span>查看 ›</span></div></div><div><h3>我的工作区</h3>${place('产品研发','把当前接入问题整理成可执行方案。','prototype')}${place('客户访谈','归纳访谈发现，明确下一轮问题。','recorder')}${!delivered?place('研究周报','汇总本周发现与参考资料。','report'):''}</div></div></div>`;}
 function modal(title,body,sub='',small=false,composer=false){return `<div class="stage-overlay"><div class="stage-modal ${small?'small-modal':''}"><div class="stage-modal-head">${art('sprout')}<div><b>${title}</b>${sub?`<small>${sub}</small>`:''}</div><span class="fake-close">×</span></div><div class="stage-modal-body">${body}</div>${composer?`<div class="composer">对接口人说…<div class="composer-bottom"><span>＋　文件或图片</span><span class="send">↑</span></div></div>`:''}</div></div>`;}
 const request=()=>message('你','plane','我先继续客户访谈。请核对产品研发的接入问题，给我修复与验证方案；实际改动等我确认。',true);
 const accepted=()=>message('接口人','sprout','已放进「产品研发」，由工程师核对材料、验收顾问检查方案。目标和改动边界都记在原工单里。'+receipt(),false,true);
 function spaceTop(name,goal,tab){return `<div class="space-head"><div><div class="stage-eyebrow">${tab==='execution'?name:'工作区'}</div><h2>${tab==='execution'?'执行对话':name}</h2><p>${goal}</p></div>${button('切换工作区 ⌄')}</div><div class="space-tabs"><span class="${tab==='overview'?'active':''}">概览</span><span class="${tab==='execution'?'active':''}">执行</span><span class="${tab==='staff'?'active':''}">幕僚</span></div>`;}
 const assign=()=>message('接口人','sprout','<span class="mention">@工程师</span> 核对接入记录，整理修复方案。<br><span class="mention">@验收顾问</span> 检查验证和回退步骤，列明待确认项。',false,true);
 const progress=()=>message('工程师','wrench','现有材料显示检查程序仍在读取旧接入点。我正在整理最小改动与验证方法。',false,true);
 function group(withProgress=false){return `<div class="stage-page execution-page">${spaceTop('产品研发','接入修复方案','execution')}<div class="group-layout"><div class="group-aside"><h3>会话</h3><div class="thread selected">接入问题排查<small>工单 · 接入修复方案</small></div><div class="thread">发布准备<small>工作区群聊</small></div></div><div class="group-conversation"><div class="conversation-head"><h3>接入问题排查</h3><div class="roster"><span>${art('sprout')}接口人 <b class="badge">管理员</b></span><span>${art('wrench')}工程师 <b class="badge">Codex</b></span><span>${art('pencil')}验收顾问</span></div></div><div class="work-status">工程师 · 在干活　　验收顾问 · 在干活</div><div class="messages">${assign().replace(withProgress?'fresh':'__none__','')}${withProgress?progress():''}</div><div class="composer">发言，或 @ 一位成员…<div class="composer-bottom"><span>＋　添加文件或图片</span><span class="send">↑</span></div></div></div></div></div>`;}
 const outcome=()=>message('接口人','sprout','<b>已有结论</b>：材料支持旧配置是原因。<br><b>还缺什么</b>：新接入点当前是否可用，待验证。<br><b>下一步</b>：可先做只读核对，实际配置保持不变。'+receipt(),false,true);
 const reply=()=>message('你','plane','按这个方向继续只读核对。实际配置暂不改。',true,true);
 function interviews(step=0){return `<div class="stage-page interview-page">${spaceTop('客户访谈','访谈提纲 · 第一轮反馈','execution')}<div class="group-layout"><div class="group-aside"><h3>会话</h3><div class="thread selected">下一轮访谈提纲<small>工单 · 核对首轮假设</small></div><div class="thread">原话与访谈记录<small>本区材料</small></div></div><div class="group-conversation"><div class="conversation-head"><h3>下一轮访谈提纲</h3><div class="roster"><span>${art('compass')}研究员</span><span>${art('fan')}访谈顾问</span><span>客户访谈 · 本区对话</span></div></div><div class="messages">${message('研究员','compass','首轮有两位受访者在邀请同事时中断。还不能判断：是入口不明显，还是权限说明不清楚。')}${step>=1?message('你','plane','下一轮先核对：他们是否看见入口，以及在哪一步不敢继续。',true):''}${step>=2?message('你','plane','把这两个问题放在提纲前面。先问经历，再问判断。',true):''}</div><div class="composer">继续整理访谈问题…<div class="composer-bottom"><span>＋　添加文件或图片</span><span class="send">↑</span></div></div></div></div></div>`;}
 const scheduleAsk=()=>message('你','plane','每周一到周五上午 9:00，提醒我各工作区尚未关闭的工单。',true);
 const scheduleReceipt=()=>message('接口人','sprout','已建立「未关闭工单提醒」：工作日 09:00。下一次 11 月 26 日 周四 09:00。到点会在这里提醒你，同时推送到手机。可在「设置 → 定时安排」查看、停用或删除。');
 const scheduleNotice=()=>message('接口人','sprout','各工作区未关闭的工单共 3 张：<br><b>产品研发</b>　接入修复方案 · 执行中<br><b>客户访谈</b>　下一轮访谈提纲 · 等你验收<br><b>研究周报</b>　本周数据整理 · 已接手<span class="schedule-source">— 来自定时安排「未关闭工单提醒」· 工作日 09:00<span><u>停用这条安排</u><u>在设置中查看</u></span></span>',false,true);
 const frames=[
  {title:'先决定，今天把注意力放在哪。',copy:'从「今天」看见项目和资料。你选择先整理客户访谈，临时的接入排查也有地方交出去。',icon:'hub-small',view:'today',render:()=>home()},
  {title:'临时冒出的事，先交出去。',copy:'告诉接口人目标和边界，同时说清自己要继续客户访谈。交办不必变成一次漫长的工作切换。',icon:'sprout',view:'today',render:()=>home()+modal('接口人',request(),'一句话交办',false,true)},
  {title:'交办有去处，回来有线索。',copy:'目标、材料和改动边界随原工单保存。你知道谁在接手，也知道回来时去哪里找。',icon:'prototype',view:'today',render:()=>home()+modal('接口人',request()+accepted(),'一句话交办',false,true)},
  {title:'想看细节，随时能进工作区。',copy:'排查与验证讨论留在「产品研发」。这里可以查看过程；团队成员与职责也能按项目配置。',icon:'wrench',view:'workspace',render:()=>group(true)},
  {title:'把注意力放回客户访谈。',copy:'进入访谈自己的对话。眼前是受访者原话与待核实假设，接入排查留在另一个工作区。',icon:'recorder',view:'workspace',canvas:'interview-0',render:()=>interviews()},
  {title:'你推进主线，排查留在另一边。',copy:'把访谈假设写成追问。这段时间，另一项工作的执行过程保留在它自己的上下文里。',icon:'plane',view:'workspace',canvas:'interview-1',render:()=>interviews(1)},
  {title:'红点出现，眼前这件事照常继续。',copy:'接口人收到新汇报，右上角留下一条未读。访谈对话保持原处，不替你打开另一件事。',icon:'sprout',view:'workspace',unread:1,canvas:'interview-1',render:()=>interviews(1)},
  {title:'先把这一句写完。',copy:'你继续补充访谈提纲，红点仍留着。新汇报不等于必须现在切换，打开时机由你决定。',icon:'plane',view:'workspace',unread:1,canvas:'interview-2',render:()=>interviews(2)},
  {title:'腾出注意力，再打开汇报。',copy:'先看结论、缺口和下一步，需要细节再进原工单。打开后未读标记消退，不表示任务自动完成。',icon:'sprout',view:'workspace',render:()=>interviews(2)+modal('接口人',outcome(),'来自产品研发的汇报',false,true)},
  {title:'补一句方向，把细节交回去。',copy:'「继续只读核对，配置暂不改」回到原工单。你做取舍，团队接着处理具体问题。',icon:'plane',view:'workspace',render:()=>interviews(2)+modal('接口人',outcome().replace('fresh','')+reply(),'继续原工单',false,true)},
  {title:'回来时，刚才的思路还在。',copy:'关闭汇报，回到同一份访谈提纲。原话、问题和最后一句都在，不需要把研发过程重新装进脑中。',icon:'recorder',view:'workspace',canvas:'interview-2',render:()=>interviews(2)},
  {title:'到点提醒，也回到同一个入口。',copy:'说一句「工作日 9 点提醒我未关闭的工单」，回执写明下一次时间和提醒位置。到点后汇总出现在接口人对话里，所有安排集中在「设置 → 定时安排」。',icon:'sprout',view:'today',render:()=>home(true)+modal('接口人',scheduleAsk()+scheduleReceipt()+scheduleNotice(),'定时安排',false,true)},
  {title:'再抬头，回到全局。',copy:'「今天」保留项目和成果入口。你可以查看报告，再选择下一步；什么时候深入，什么时候抬头，都由你安排。',icon:'hub-small',view:'today',render:()=>home(true)}
 ];
 const scene = $('#story-scene');
 const section = $('#story-sequence');
 const sticky = $('.story-sticky');
 const report = $('#report');
 const lastFrame = frames.length - 1;
 let current = -1;
 let stepSize = 260;
 let start = 0;
 let lastChange = 0;
 let wheelDelta = 0;
 let lastWheel = 0;
 let pendingScroll = false;

 function render(index) {
  index = Math.max(0, Math.min(lastFrame, index));
  if (index === current) return;
  const previous = frames[current];
  const frame = frames[index];
  const appBar = bar(frame.view, frame.unread || 0, !!frame.unread && !previous?.unread);
  current = index;
  lastChange = performance.now();

  if (frame.canvas && previous?.canvas === frame.canvas) {
   // The unread badge changes while the interview remains in place.
   scene.querySelector('.story-appbar').outerHTML = appBar;
  } else {
   const animation = previous && previous.view !== frame.view ? 'scene-enter' : '';
   scene.innerHTML = `${appBar}<div class="stage-screen ${animation}">${frame.render()}</div>`;
   for (const log of scene.querySelectorAll('.stage-modal-body,.messages')) {
    if (log.querySelector('.msg')) log.scrollTop = log.scrollHeight;
   }
  }

  $('#story-caption-icon').src = `assets/${frame.icon}.svg`;
  $('#story-title').textContent = frame.title;
  $('#story-copy').textContent = frame.copy;
  $('#story-count').textContent = `${String(index + 1).padStart(2, '0')} / ${frames.length}`;
  $('#story-fill').style.width = `${(index + 1) / frames.length * 100}%`;
  section.dataset.frame = String(index);
 }

 function measure() {
  stepSize = innerWidth < 741 ? 210 : 260;
  section.style.setProperty('--player-h', `${sticky.offsetHeight}px`);
  section.style.setProperty('--travel', `${lastFrame * stepSize}px`);
  start = scrollY + section.getBoundingClientRect().top - parseFloat(getComputedStyle(sticky).top);
 }

 function active() {
  return scrollY >= start - 5 && scrollY <= start + lastFrame * stepSize + 45;
 }

 function sync() {
  pendingScroll = false;
  render(Math.round((scrollY - start) / stepSize));
 }

 function leave(direction = 1) {
  if (direction < 0) {
   window.scrollTo({ top: Math.max(0, start - 200), behavior: 'instant' });
   return;
  }
  const after = $('#after-demo');
  after.scrollIntoView({ block: 'start', behavior: 'instant' });
  after.focus({ preventScroll: true });
 }

 function seek(index) {
  render(index);
  window.scrollTo({ top: start + index * stepSize, behavior: 'instant' });
 }

 function move(direction) {
  const next = current + direction;
  if (next < 0 || next > lastFrame) leave(direction);
  else seek(next);
 }

 render(0);
 measure();
 window.addEventListener('resize', () => { measure(); sync(); });
 window.addEventListener('scroll', () => {
  if (pendingScroll) return;
  pendingScroll = true;
  requestAnimationFrame(sync);
 }, { passive: true });

 for (const link of document.querySelectorAll('a[href="#story-sequence"]')) {
  link.addEventListener('click', event => {
   if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
   event.preventDefault();
   if (location.hash !== link.hash) history.pushState(null, '', link.hash);
   measure();
   seek(0);
   sticky.focus({ preventScroll: true });
  });
 }

 section.addEventListener('wheel', event => {
  if (event.ctrlKey || event.metaKey || !active() || $('dialog[open]')) return;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  const direction = Math.sign(event.deltaY);
  if (!direction || (current === 0 && direction < 0) || (current === lastFrame && direction > 0)) return;
  event.preventDefault();
  const now = performance.now();
  if (now - lastWheel > 180) wheelDelta = 0;
  lastWheel = now;
  if (now - lastChange < 380) return;
  wheelDelta += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
  if (Math.abs(wheelDelta) >= 36) {
   wheelDelta = 0;
   move(direction);
  }
 }, { passive: false });

 window.addEventListener('keydown', event => {
  if (!active() || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || $('dialog[open]')) return;
  const target = event.target;
  if (target.closest('input,textarea,select,[contenteditable=true],button,a,summary')) return;
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
   event.preventDefault();
   move(event.key === 'ArrowRight' ? 1 : -1);
  } else if (event.key === 'Escape') {
   event.preventDefault();
   leave();
  }
 });

 $('#skip-story').addEventListener('click', event => { event.preventDefault(); leave(); });
 document.addEventListener('click', event => {
  if (event.target.closest('[data-report]')) report.showModal();
 });
 $('#close-report').addEventListener('click', () => report.close());
 document.fonts.ready.then(() => { measure(); sync(); });
})();
