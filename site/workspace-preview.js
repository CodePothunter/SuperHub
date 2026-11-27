/* Local presentation only: generic sample projects, no storage or network calls. */
(() => {
 const $=s=>document.querySelector(s);
 const icon=name=>`<img src="assets/${name}.svg" alt="">`;
 const projects={
  product:{name:'产品研发',icon:'prototype',goal:'把接入问题整理成可验证的修复方案，实际改动由你确认。',directory:'/projects/product-app',
   members:[['工程师','wrench','核对材料，整理修复方案。'],['研究员','compass','补充依据，列出待验证项。'],['验收顾问','pencil','检查验证与回退步骤。']],
   growth:{工程师:{status:'待采纳',text:'报告接入问题时，同时写出已确认的原因、尚待验证的新目标状态和变更前提。',source:'接入问题排查 · 工程师阶段回报'}},
   experiences:[{status:'待采纳',text:'切换接入点前，先核实新目标当前可用，再列出回退条件。',situation:'接入配置变更',boundary:'实际改动仍由你确认。',reason:'尚缺可核对的独立工单。',sources:['接入问题排查 · 工程师阶段回报：新目标状态仍待验证。']}],
   orders:[
    {session:'接入问题排查',title:'接入修复方案',state:'执行中',owner:'工程师',avatar:'wrench',promise:'提交修复与验证方案，列明待确认项。',boundary:'只读核对；实际配置改动等你确认。',material:'接入记录.md',output:'接入排查报告.md',request:'请核对接入记录，整理修复与验证方案；实际改动等我确认。',reply:'材料显示检查程序仍读取旧接入点。已整理修复建议，新接入点的当前状态还需要验证。',doc:'材料支持旧配置是问题原因。建议先核对新接入点的可用状态，再确认是否变更配置。当前样例没有执行实际修改。'},
    {session:'发布准备',title:'发布核对清单',state:'已接手',owner:'验收顾问',avatar:'pencil',promise:'整理验证前提、发布步骤与回退条件。',boundary:'先整理清单，发布前由你确认。',material:'发布要求.md',request:'按当前发布要求，把验证前提和回退条件列清楚。',reply:'已接下这份清单，先核对必须满足的验证前提；不确定的条件会单独列出。'}]},
  interviews:{name:'客户访谈',icon:'recorder',goal:'归纳首轮访谈证据，把尚未确认的判断写成下一轮问题。',directory:'/projects/customer-research',
   members:[['研究员','compass','整理原话，区分事实与推断。'],['访谈顾问','fan','把假设写成具体追问。']],
   growth:{研究员:{status:'已采纳 · 按本人指示',text:'先整理原话与共性现象，再把尚未证实的原因写为下一轮追问。',source:'第一轮访谈 · 主人给研究员的长期指示'}},
   experiences:[
    {status:'已采纳',action:'自动采纳',version:2,text:'访谈出稿时保留引文时间戳，供复核原话。',situation:'有录音的客户访谈',boundary:'仅引用获准使用的内容。',reason:'两个独立工单的逐字稿及引用复核记录均支持这项做法。',sources:['首轮反馈归纳 · 首轮访谈记录.md（逐字稿有时间戳，复核者据此定位原话）','次轮反馈复核 · 次轮访谈记录.md（独立记录了相同做法和结果）'],previous:'版本 1 · 待采纳，已有一份访谈材料。'},
    {status:'已采纳',action:'自动更正',version:2,text:'匿名摘录使用段号标明出处。',situation:'公开版访谈摘要',boundary:'主人内部的原话照常按时间戳定位。',reason:'本区引用规范的新版本把行号改成了段号。',sources:['公开摘录规范 · 当前版：「匿名摘录应按原文段号标明出处。」'],previous:'版本 1 · 匿名摘录使用行号标明出处。'},
   ],
   orders:[
    {session:'第一轮访谈',title:'首轮反馈归纳',state:'已完成',owner:'研究员',avatar:'compass',promise:'归纳原话、共性问题和待核实假设。',boundary:'保留出处，不把推断写成事实。',material:'首轮访谈记录.md',output:'访谈发现摘要.md',request:'整理首轮反馈，引用原话，区分发现和假设。',reply:'两位受访者提到邀请同事时中断。摘要已区分原话与假设，并保留待核实问题。',doc:'共同现象：两位受访者在邀请同事时中断。待核实：入口是否清晰、权限说明是否充分。这些是下一轮追问方向，尚不足以断定原因。'},
    {session:'下一轮访谈',title:'访谈提纲',state:'执行中',owner:'访谈顾问',avatar:'fan',promise:'把尚未确认的判断写成下一轮追问。',boundary:'先问具体经历，再问判断。',material:'待核实问题.md',request:'下一轮先核对：是否看见邀请入口，以及在哪一步不敢继续。',reply:'提纲从实际经历开始，再追问当时最需要哪一条说明。接着原来的访谈目标继续整理。'}]},
  weekly:{name:'研究周报',icon:'report',goal:'汇总本周发现与出处，留下值得继续验证的问题。',directory:'/projects/research-notes',
   members:[['研究员','compass','核对出处与结论。'],['编辑','pencil','整理结构与阅读顺序。']],
   growth:{},
   experiences:[{status:'已停用',action:'自动过期',version:2,text:'试行期间，周报使用一页模板。',situation:'试行周报',boundary:'有效期至 2026-11-22 当天结束。',reason:'已达到条目约定的有效期，后续周报不再收到这个版本。',sources:['周报试行约定 · 「一页模板用到 11 月 22 日。」'],previous:'版本 1 · 已采纳，适用于模板试行期间。'}],
   orders:[{session:'本周观察',title:'研究周报初稿',state:'执行中',owner:'研究员',avatar:'compass',promise:'整理发现、来源与下一步验证问题。',boundary:'保留来源，明确事实与推断的差别。',material:'本周阅读笔记.md',output:'研究周报草稿.md',request:'把本周笔记整理成周报，结论要有出处，缺少依据的地方单列。',reply:'草稿已按发现、依据与待验证问题组织。接下来继续核对引用和结论之间的关系。',doc:'本周周报样例按发现、来源和待验证问题组织。它保留阅读材料的引用入口，把尚缺依据的判断列为下一步问题。'}]}
 };
 const liaisonExample={
  workspace:'product',
  title:'发布前的两个问题',
  request:'在产品研发工作区开个对话，不用开工单。问一下发布前看哪几个指标，异常时怎么回退？',
  followup:'就启动吧，带工单也行。',
  answer:'先记录错误率、请求延迟和关键流程的成功率，发布后按同一口径比较。指标越过约定阈值时先停下扩大范围，再切回上一版本并验证三项指标是否恢复。',
 };
 let selected='product',panel='overview',orderIndex=0,showOrdinaryDialogue=false,liaisonTurns=0;
 const picker=$('#workspace-picker'),documentDialog=$('#workspace-document'),liaisonDialog=$('#liaison-preview');
 const liaisonOpen=$('#liaison-demo-open'),liaisonSend=$('#liaison-demo-send'),liaisonLog=$('#liaison-demo-messages');
 function file(label,kind){return `<button class="ws-file" data-ws-document="${kind}">${icon('report')}<span>${label}<small>${kind==='material'?'本单材料':'本单成果'}</small></span><b>↗</b></button>`;}
 function message(author,avatar,words,extra=''){
  return `<div class="ws-message${author==='你'?' own':''}">${icon(avatar)}<div><small>${author}</small><p>${words}</p>${extra}</div></div>`;
 }
 function overview(p){
  const dialogue=liaisonTurns && selected===liaisonExample.workspace
   ? `<section class="ws-order-group ws-ordinary-card"><button class="ws-session" type="button" data-ws-ordinary><b>${liaisonExample.title}</b><span>群聊 · 0 张工单　›</span></button></section>` : '';
  const orderGroups=p.orders.map((o,i)=>`<section class="ws-order-group"><button class="ws-session" data-ws-order="${i}"><b>${o.session}</b><span>群聊 · 1 张工单　›</span></button><button class="ws-order" data-ws-order="${i}"><span><b>${o.title}</b><small>${o.owner} · ${o.promise}</small></span><em class="${o.state==='已完成'?'finished':''}">${o.state}</em></button></section>`).join('');
  return `<div class="ws-directory"><div><span>项目目录</span><code>${p.directory}</code></div><small>已绑定 · 示例路径</small></div><div class="ws-section-head"><h4>会话与工单</h4><span>新建会话　　新建工单</span></div><div class="ws-order-groups">${dialogue}${orderGroups}</div>`;
 }
 function ordinaryDialogue(project){
  return `<section class="ws-conversation ws-ordinary-dialogue" aria-labelledby="ws-ordinary-title">
   <div class="ws-conversation-head"><h4 id="ws-ordinary-title" tabindex="-1">${liaisonExample.title}</h4><span>${project.name} · 关联工单 0 张</span></div>
   <div class="ws-messages">
    ${message('接口人','sprout','请验收顾问回答发布前的两个问题。',`<blockquote class="ws-forwarded"><small>你的原话</small><br>${liaisonExample.request}</blockquote>`)}
    ${message('验收顾问','pencil',liaisonExample.answer)}
   </div>
  </section>`;
 }
 function execution(p){
  if(showOrdinaryDialogue) return ordinaryDialogue(p);
  const o=p.orders[orderIndex];
  return `<div class="ws-execution"><div class="ws-conversation"><div class="ws-conversation-head"><h4>${o.session}</h4><span>${p.name} · 原会话</span></div><div class="ws-messages">${message('你','plane',o.request)}${message(o.owner,o.avatar,o.reply,o.output?file(o.output,'output'):'')}</div><div class="ws-composer">沿着这件事继续说…<span>↑</span></div></div><aside class="ws-order-info"><h4>工单信息</h4><dl><div><dt>工单</dt><dd>${o.title}</dd></div><div><dt>承诺结果</dt><dd>${o.promise}</dd></div><div><dt>执行范围</dt><dd>${o.boundary}</dd></div><div><dt>状态</dt><dd>${o.state}</dd></div></dl>${file(o.material,'material')}</aside></div>`;
 }
 function outputs(p){
  const items=p.orders.map((order,index)=>order.output ? `
   <button class="ws-output" data-ws-document="output" data-ws-source="${index}">
    ${icon('report')}
    <span><b>${order.output}</b><small>${order.session} · ${order.owner} · ${order.state}</small></span>
    <span aria-hidden="true">↗</span>
   </button>` : '').join('');
  return `
   <div class="ws-member-head"><h4>本区产物</h4><span>点击查看示例产物</span></div>
   <div class="ws-output-list">${items || '<p class="ws-member-note">这个工作区还没有产物。</p>'}</div>`;
 }
 function staff(p){
  const members=p.members.map(([name,avatar,duty])=>{
   const record=p.growth[name];
   const history=record ? `
    <details class="ws-growth">
     <summary>成长记录 · 1 条</summary>
     <small>${record.status} · 本区</small>
     <p>${record.text}</p>
     <small>依据 · ${record.source}</small>
    </details>` : '';
   return `<div>${icon(avatar)}<h4>${name}</h4><p>${duty}</p>${history}</div>`;
  }).join('');
  return `
   <div class="ws-member-head"><h4>本工作区的幕僚</h4><span>邀请已有幕僚　　创建专属幕僚</span></div>
   <div class="ws-member-list">${members}</div>
   <p class="ws-member-note">成员在这里围绕「${p.name}」的目标分工，成长记录归各自的幕僚卡。</p>`;
 }
 function experience(p){
  const stateClass={'待采纳':'pending','已采纳':'active','已停用':'retired'};
  const cards=p.experiences.map(record=>`
   <article class="ws-experience-card">
    <div class="ws-experience-meta">
     <span class="${stateClass[record.status]}">${record.status}</span>
     ${record.action ? `<b>${record.action}</b>` : ''}
     <small>本区共同经验 · 版本 ${record.version ?? 1}</small>
    </div>
    <p>${record.text}</p>
    <div class="ws-experience-context">
     <small>适用情境 · ${record.situation}</small>
     <small>边界 · ${record.boundary}</small>
    </div>
    <details><summary>查看依据</summary><p>${record.reason}</p>${record.sources.map(source=>`<p>${source}</p>`).join('')}</details>
    ${record.previous ? `<details><summary>历史版本</summary><p>${record.previous}</p></details>` : ''}
   </article>`).join('');
  return `
   <div class="ws-member-head"><h4>本区共同经验</h4></div>
   <p class="ws-experience-note">有足够依据的经验会自动生效。每次采纳、更正和过期都能回查理由。</p>
   <div class="ws-experience-list">${cards || '<p class="ws-member-note">尚未登记共同经验。工作成果也可以不产生新经验。</p>'}</div>
   <p class="ws-member-note">真实页面可采纳、更正、停用及恢复历史版本。跨区使用由你设置共享范围。</p>`;
 }
 const views={overview,execution,outputs,staff,experience};
 function render(){
  const project=projects[selected];
  $('#workspace-demo-name').textContent=project.name;
  $('#workspace-demo-goal').textContent=project.goal;
  $('#workspace-demo-icon').src=`assets/${project.icon}.svg`;
  $('#workspace-panel').innerHTML=views[panel](project);
  $('#workspace-panel').dataset.project=selected;
  $('#workspace-panel').setAttribute('aria-labelledby','workspace-tab-'+panel);
  document.querySelectorAll('[data-workspace-panel]').forEach(button=>{
   const on=button.dataset.workspacePanel===panel;
   button.setAttribute('aria-selected',String(on));
   button.tabIndex=on?0:-1;
  });
  document.querySelectorAll('[data-workspace-choice]').forEach(button=>{
   button.setAttribute('aria-pressed',String(button.dataset.workspaceChoice===selected));
  });
 }
 document.querySelectorAll('[data-workspace-panel]').forEach(button=>button.addEventListener('click',()=>{panel=button.dataset.workspacePanel;render();}));
 const tabs=[...document.querySelectorAll('[data-workspace-panel]')];
 $('.workspace-preview-tabs').addEventListener('keydown',event=>{const index=tabs.indexOf(event.target);if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;panel=tabs[next].dataset.workspacePanel;render();tabs[next].focus();});
 $('#workspace-switch').addEventListener('click',()=>picker.showModal());
 $('#workspace-picker-close').addEventListener('click',()=>picker.close());
 document.querySelectorAll('[data-workspace-choice]').forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.workspaceChoice;panel='overview';orderIndex=0;showOrdinaryDialogue=false;render();picker.close();}));
 function openLiaisonDialogue(){
  selected=liaisonExample.workspace;
  panel='execution';
  showOrdinaryDialogue=true;
  render();
  if(liaisonDialog.open) liaisonDialog.close();
  $('#ws-ordinary-title').focus();
 }
 $('#liaison-example-prompt').textContent=liaisonExample.request;
 liaisonOpen.disabled=false;
 liaisonOpen.addEventListener('click',()=>{
  liaisonDialog.showModal();
  const next=liaisonTurns===2 ? liaisonLog.lastElementChild.querySelector('[data-liaison-dialogue]') : liaisonSend;
  next.focus();
 });
 $('#liaison-demo-close').addEventListener('click',()=>liaisonDialog.close());
 liaisonSend.addEventListener('click',()=>{
  if(liaisonTurns===2) return;
  const first=liaisonTurns===0;
  liaisonTurns+=1;
  const project=projects[liaisonExample.workspace];
  const reply=first ? `已在「${project.name}」开聊，原问题已送达。` : '刚才的问题已送达，点回执可以打开同一场对话。';
  const count=first ? '<small class="liaison-count">新增 1 场对话 · 0 张工单</small>' : '';
  const receipt=`<button type="button" class="stage-button liaison-receipt" data-liaison-dialogue>打开对话「${liaisonExample.title}」</button>`;
  liaisonLog.insertAdjacentHTML('beforeend',
   message('你','plane',first?liaisonExample.request:liaisonExample.followup)+message('接口人','sprout',reply,count+receipt));
  if(first){
   $('#liaison-example-prompt').textContent=liaisonExample.followup;
   liaisonSend.textContent='发送补充';
   render();
  }else $('#liaison-example-draft').hidden=true;
  liaisonLog.lastElementChild.querySelector('[data-liaison-dialogue]').focus();
 });
 liaisonLog.addEventListener('click',event=>{
  if(event.target.closest('[data-liaison-dialogue]')) openLiaisonDialogue();
 });
 $('#workspace-panel').addEventListener('click',event=>{
  if(event.target.closest('[data-ws-ordinary]')){
   openLiaisonDialogue();
   return;
  }
  const attachment=event.target.closest('[data-ws-document]');
  if(attachment){
   const source=attachment.dataset.wsSource;
   const order=projects[selected].orders[source===undefined?orderIndex:Number(source)];
   const material=attachment.dataset.wsDocument==='material';
   $('#workspace-document-title').textContent=material?order.material:order.output;
   $('#workspace-document-copy').textContent=material?`这份材料用于「${order.title}」。本次交办：${order.request}`:order.doc;
   documentDialog.showModal();
   return;
  }
  const order=event.target.closest('[data-ws-order]');
  if(!order)return;
  orderIndex=Number(order.dataset.wsOrder);
  panel='execution';
  showOrdinaryDialogue=false;
  render();
  $('#workspace-tab-execution').focus();
 });
 $('#workspace-document-close').addEventListener('click',()=>documentDialog.close());
 render();
})();
