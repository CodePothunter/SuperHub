/* Local presentation only: generic sample projects, no storage or network calls. */
(() => {
 const $=s=>document.querySelector(s);
 const icon=name=>`<img src="assets/${name}.svg" alt="">`;
 const projects={
  product:{name:'产品研发',icon:'prototype',goal:'把接入问题整理成可验证的修复方案，实际改动由你确认。',directory:'/projects/product-app',
   members:[['工程师','wrench','核对材料，整理修复方案。'],['研究员','compass','补充依据，列出待验证项。'],['验收顾问','pencil','检查验证与回退步骤。']],
   orders:[
    {session:'接入问题排查',title:'接入修复方案',state:'执行中',owner:'工程师',avatar:'wrench',promise:'提交修复与验证方案，列明待确认项。',boundary:'只读核对；实际配置改动等你确认。',material:'接入记录.md',output:'接入排查报告.md',request:'请核对接入记录，整理修复与验证方案；实际改动等我确认。',reply:'材料显示检查程序仍读取旧接入点。已整理修复建议，新接入点的当前状态还需要验证。',doc:'材料支持旧配置是问题原因。建议先核对新接入点的可用状态，再确认是否变更配置。当前样例没有执行实际修改。'},
    {session:'发布准备',title:'发布核对清单',state:'已接手',owner:'验收顾问',avatar:'pencil',promise:'整理验证前提、发布步骤与回退条件。',boundary:'先整理清单，发布前由你确认。',material:'发布要求.md',request:'按当前发布要求，把验证前提和回退条件列清楚。',reply:'已接下这份清单，先核对必须满足的验证前提；不确定的条件会单独列出。'}]},
  interviews:{name:'客户访谈',icon:'recorder',goal:'归纳首轮访谈证据，把尚未确认的判断写成下一轮问题。',directory:'/projects/customer-research',
   members:[['研究员','compass','整理原话，区分事实与推断。'],['访谈顾问','fan','把假设写成具体追问。']],
   orders:[
    {session:'第一轮访谈',title:'首轮反馈归纳',state:'已完成',owner:'研究员',avatar:'compass',promise:'归纳原话、共性问题和待核实假设。',boundary:'保留出处，不把推断写成事实。',material:'首轮访谈记录.md',output:'访谈发现摘要.md',request:'整理首轮反馈，引用原话，区分发现和假设。',reply:'两位受访者提到邀请同事时中断。摘要已区分原话与假设，并保留待核实问题。',doc:'共同现象：两位受访者在邀请同事时中断。待核实：入口是否清晰、权限说明是否充分。这些是下一轮追问方向，尚不足以断定原因。'},
    {session:'下一轮访谈',title:'访谈提纲',state:'执行中',owner:'访谈顾问',avatar:'fan',promise:'把尚未确认的判断写成下一轮追问。',boundary:'先问具体经历，再问判断。',material:'待核实问题.md',request:'下一轮先核对：是否看见邀请入口，以及在哪一步不敢继续。',reply:'提纲从实际经历开始，再追问当时最需要哪一条说明。接着原来的访谈目标继续整理。'}]},
  weekly:{name:'研究周报',icon:'report',goal:'汇总本周发现与出处，留下值得继续验证的问题。',directory:'/projects/research-notes',
   members:[['研究员','compass','核对出处与结论。'],['编辑','pencil','整理结构与阅读顺序。']],
   orders:[{session:'本周观察',title:'研究周报初稿',state:'执行中',owner:'研究员',avatar:'compass',promise:'整理发现、来源与下一步验证问题。',boundary:'保留来源，明确事实与推断的差别。',material:'本周阅读笔记.md',output:'研究周报草稿.md',request:'把本周笔记整理成周报，结论要有出处，缺少依据的地方单列。',reply:'草稿已按发现、依据与待验证问题组织。接下来继续核对引用和结论之间的关系。',doc:'本周周报样例按发现、来源和待验证问题组织。它保留阅读材料的引用入口，把尚缺依据的判断列为下一步问题。'}]}
 };
 let selected='product',panel='overview',orderIndex=0;
 const picker=$('#workspace-picker'),documentDialog=$('#workspace-document');
 function file(label,kind){return `<button class="ws-file" data-ws-document="${kind}">${icon('report')}<span>${label}<small>${kind==='material'?'本单材料':'本单成果'}</small></span><b>↗</b></button>`;}
 function overview(p){return `<div class="ws-directory"><div><span>项目目录</span><code>${p.directory}</code></div><small>已绑定 · 示例路径</small></div><div class="ws-section-head"><h4>会话与工单</h4><span>新建会话　　新建工单</span></div><div class="ws-order-groups">${p.orders.map((o,i)=>`<section class="ws-order-group"><button class="ws-session" data-ws-order="${i}"><b>${o.session}</b><span>群聊 · 1 张工单　›</span></button><button class="ws-order" data-ws-order="${i}"><span><b>${o.title}</b><small>${o.owner} · ${o.promise}</small></span><em class="${o.state==='已完成'?'finished':''}">${o.state}</em></button></section>`).join('')}</div>`;}
 function execution(p){const o=p.orders[orderIndex];return `<div class="ws-execution"><div class="ws-conversation"><div class="ws-conversation-head"><h4>${o.session}</h4><span>${p.name} · 原会话</span></div><div class="ws-messages"><div class="ws-message own">${icon('plane')}<div><small>你</small><p>${o.request}</p></div></div><div class="ws-message">${icon(o.avatar)}<div><small>${o.owner}</small><p>${o.reply}</p>${o.output?file(o.output,'output'):''}</div></div></div><div class="ws-composer">沿着这件事继续说…<span>↑</span></div></div><aside class="ws-order-info"><h4>工单信息</h4><dl><div><dt>工单</dt><dd>${o.title}</dd></div><div><dt>承诺结果</dt><dd>${o.promise}</dd></div><div><dt>执行范围</dt><dd>${o.boundary}</dd></div><div><dt>状态</dt><dd>${o.state}</dd></div></dl>${file(o.material,'material')}</aside></div>`;}
 function staff(p){return `<div class="ws-member-head"><h4>本工作区的幕僚</h4><span>邀请已有幕僚　　创建专属幕僚</span></div><div class="ws-member-list">${p.members.map(m=>`<div>${icon(m[1])}<h4>${m[0]}</h4><p>${m[2]}</p></div>`).join('')}</div><p class="ws-member-note">成员在这里围绕「${p.name}」的目标分工，职责可以按项目调整。</p>`;}
 function render(){const p=projects[selected];$('#workspace-demo-name').textContent=p.name;$('#workspace-demo-goal').textContent=p.goal;$('#workspace-demo-icon').src=`assets/${p.icon}.svg`;$('#workspace-panel').innerHTML=panel==='overview'?overview(p):panel==='execution'?execution(p):staff(p);$('#workspace-panel').dataset.project=selected;$('#workspace-panel').setAttribute('aria-labelledby','workspace-tab-'+panel);document.querySelectorAll('[data-workspace-panel]').forEach(button=>{const on=button.dataset.workspacePanel===panel;button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;});document.querySelectorAll('[data-workspace-choice]').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.workspaceChoice===selected));});}
 document.querySelectorAll('[data-workspace-panel]').forEach(button=>button.addEventListener('click',()=>{panel=button.dataset.workspacePanel;render();}));
 const tabs=[...document.querySelectorAll('[data-workspace-panel]')];
 $('.workspace-preview-tabs').addEventListener('keydown',event=>{const index=tabs.indexOf(event.target);if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;panel=tabs[next].dataset.workspacePanel;render();tabs[next].focus();});
 $('#workspace-switch').addEventListener('click',()=>picker.showModal());
 $('#workspace-picker-close').addEventListener('click',()=>picker.close());
 document.querySelectorAll('[data-workspace-choice]').forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.workspaceChoice;panel='overview';orderIndex=0;render();picker.close();}));
 $('#workspace-panel').addEventListener('click',event=>{const order=event.target.closest('[data-ws-order]');if(order){orderIndex=Number(order.dataset.wsOrder);panel='execution';render();$('#workspace-tab-execution').focus();return;}const attachment=event.target.closest('[data-ws-document]');if(!attachment)return;const o=projects[selected].orders[orderIndex];const material=attachment.dataset.wsDocument==='material';$('#workspace-document-title').textContent=material?o.material:o.output;$('#workspace-document-copy').textContent=material?`这份材料用于「${o.title}」。本次交办：${o.request}`:o.doc;documentDialog.showModal();});
 $('#workspace-document-close').addEventListener('click',()=>documentDialog.close());
 render();
})();
