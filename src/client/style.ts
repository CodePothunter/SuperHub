/**
 * 作战台样式：跟随 DSH 主界面。
 *
 * 颜色、字体、圆角全部取 DSH 的设计变量（--dsw-*），所以深浅模式和主界面一致；后面的值只是预览时的兜底。
 * 语义色只有三种用途：琥珀表示需要主人处理，红黄绿表示横向线健康度，蓝表示别人欠主人的。
 * 以 .wr 为根作用域。窄屏时用底部标签在"接口人"和台面各区块之间切换。
 */
import { CHAT_ATTACHMENT_STYLE } from './chat-attachments-style.ts'

export const CSS = `
.wr { --bg:var(--dsw-alias-bg-base,#fff); --board:var(--dsw-alias-bg-module-platform,#f5f6f7); --raise:var(--dsw-alias-interactive-bg-hover,#2631480f);
  --rule:var(--dsw-alias-border-l2,#0000001a); --hair:var(--dsw-alias-border-l1,#0000000a);
  --paper:var(--dsw-alias-label-primary,#0f1115); --dim:var(--dsw-alias-label-secondary,#61666b); --faint:var(--dsw-alias-label-tertiary,#81858c);
  --ink:var(--dsw-alias-brand-primary,#0f1115); --on-ink:var(--dsw-alias-label-primary-inverted,#fff);
  --amber:var(--dsw-alias-state-warn-label,#dd8629); --amber-bg:var(--dsw-alias-state-warn-tertiary,#fef5e7);
  --lamp-g:var(--dsw-alias-state-success-primary,#22c55e); --lamp-y:var(--dsw-alias-state-warn-primary,#f59e0b); --lamp-r:var(--dsw-alias-state-error-primary,#ec1313);
  --tide:var(--dsw-alias-state-business-primary,#4176e6); --tide-bg:var(--dsw-alias-state-business-tertiary,#e4edfd);
  --r-s:var(--dsw-radius-sm,8px); --r-m:var(--dsw-radius-md,12px); --r-l:var(--dsw-radius-lg,16px);
  height:100%; display:flex; background:var(--bg); color:var(--paper);
  font:14px/1.55 var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif); }
.wr *, .wr *::before { box-sizing:border-box; }
.wr-num { font-variant-numeric:tabular-nums; }

/* 表单元素 */
.wr input, .wr textarea, .wr select { background:var(--bg); border:1px solid var(--rule); border-radius:var(--r-s); color:var(--paper); font:inherit; padding:7px 10px; min-height:34px; min-width:0; }
.wr textarea { resize:none; }
.wr input::placeholder, .wr textarea::placeholder { color:var(--faint); }
.wr :is(input,textarea,select,button,[tabindex]):focus-visible { outline:2px solid var(--tide); outline-offset:1px; }
.wr button { background:var(--bg); border:1px solid var(--rule); border-radius:var(--r-s); color:var(--paper); font:inherit; padding:0 12px; min-height:32px; cursor:pointer; white-space:nowrap; }
.wr button:hover:not(:disabled) { background:var(--raise); }
.wr button:disabled { opacity:.4; cursor:default; }
.wr button.go { background:var(--ink); border-color:var(--ink); color:var(--on-ink); font-weight:600; }
.wr button.go:hover:not(:disabled) { background:var(--ink); opacity:.86; }
.wr button.quiet { border-color:transparent; background:transparent; color:var(--dim); padding:0 8px; }
.wr button.stop { color:var(--lamp-r); }
.wr-err { color:var(--lamp-r); font-size:13px; margin-top:6px; }
.wr-alert { border-radius:var(--r-m); background:var(--amber-bg); color:var(--paper); padding:10px 14px; margin-bottom:16px; font-size:13px; }
.wr-grow { flex:1; }

/* 左：接口人 */
.wr-chat { flex:0 0 clamp(350px, 35%, 430px); display:flex; flex-direction:column; min-height:0; min-width:0; border-right:1px solid var(--rule); background:var(--bg); }
.wr-chat-head { padding:18px 20px 12px; display:flex; align-items:baseline; gap:10px; }
.wr-chat-head h2 { margin:0; font-size:16px; font-weight:600; }
.wr-chat-head span { font-size:12px; color:var(--faint); }
.wr-chat-head .live { color:var(--tide); }
.wr-msgs { flex:1; min-height:0; overflow:auto; padding:4px 20px 12px; display:flex; flex-direction:column; gap:14px; }
.wr-msg { max-width:100%; white-space:pre-wrap; word-break:break-word; line-height:1.65; }
.wr-msg.you { align-self:flex-end; max-width:86%; background:var(--board); border-radius:var(--r-l); border-bottom-right-radius:4px; padding:8px 14px; }
.wr-msg.notice { background:var(--amber-bg); border-radius:var(--r-m); padding:8px 12px; font-size:13px; }
.wr-msg.notice[role=button] { cursor:pointer; }
.wr-msg.notice small { display:flex; align-items:center; gap:8px; color:var(--amber); font-weight:600; font-size:12px; }
.wr-msg.notice .state { margin-left:auto; font-weight:500; color:var(--dim); background:var(--bg); border-radius:999px; padding:0 8px; }
/* 处理过的提醒：退到背景里，状态写在角上 */
.wr-msg.notice.done { background:var(--board); color:var(--dim); }
.wr-msg.notice.done small { color:var(--faint); }
.wr-msg.notice.done .state { color:var(--lamp-g); }
.wr-msg.notice.result { background:var(--board); color:var(--paper); border:1px solid var(--rule); }
.wr-msg.notice.result small { color:var(--dim); }
.wr-notice-summary { margin:7px 0; overflow-wrap:anywhere; line-height:1.65; }
.wr-notice-actions { display:flex; flex-wrap:wrap; gap:7px; margin-top:8px; }
.wr-notice-actions button { min-height:32px; font-size:12px; }
.wr-notice-detail, .wr-notice-history { font-size:12px; color:var(--dim); }
.wr-notice-detail summary, .wr-notice-history>summary { cursor:pointer; padding:6px 0; }
.wr-notice-detail p { white-space:pre-wrap; overflow-wrap:anywhere; }
.wr-notice-unavailable { font-size:12px; color:var(--dim); }
.wr-notice-history { margin-block:12px; }.wr-notice-history .notice { margin-block:8px; }
.wr-work-reply { background:var(--board); border:1px solid var(--rule); border-radius:var(--r-m); padding:10px 12px; font-size:13px; overflow-wrap:anywhere; }
.wr-work-reply header,.wr-work-reply footer { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.wr-work-reply header { justify-content:space-between; font-size:12px; color:var(--dim); }
.wr-work-reply-text { margin:6px 0; white-space:pre-wrap; }
.wr-work-reply footer button { padding:3px 6px; font-size:11px; }
.wr-msg .did { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.wr-msg .did span { font-size:12px; color:var(--tide); background:var(--tide-bg); border-radius:999px; padding:1px 10px; }
.wr-live { border:1px solid var(--rule); border-radius:var(--r-m); padding:10px 12px; font-size:13px; color:var(--dim); }
.wr-live .head { display:flex; align-items:center; gap:8px; color:var(--paper); font-weight:500; }
.wr-live .sec { margin-left:auto; color:var(--faint); font-weight:400; font-variant-numeric:tabular-nums; font-size:12px; }
.wr-live .spin { width:12px; height:12px; border-radius:50%; border:2px solid var(--rule); border-top-color:var(--tide); flex:none; }
@media (prefers-reduced-motion: no-preference) { .wr-live .spin { animation:wr-spin .8s linear infinite; } }
@keyframes wr-spin { to { transform:rotate(360deg); } }
.wr-live .partial { margin-top:8px; color:var(--paper); white-space:pre-wrap; line-height:1.65; }
.wr-steps { list-style:none; margin:8px 0 0; padding:0; display:grid; gap:5px; }
.wr-steps li { display:grid; grid-template-columns:14px auto 1fr; gap:6px; align-items:baseline; font-size:12.5px; color:var(--dim); }
.wr-steps .mark { width:7px; height:7px; border-radius:50%; background:var(--rule); align-self:center; justify-self:center; }
.wr-steps li.done .mark { background:var(--lamp-g); } .wr-steps li.failed .mark { background:var(--lamp-r); }
.wr-steps li.running .mark { background:var(--tide); box-shadow:0 0 0 3px var(--tide-bg); }
.wr-steps li.running .what { color:var(--paper); }
.wr-steps li.think .what { color:var(--faint); }
.wr-steps .detail { color:var(--faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
.wr-steps li.think .detail { white-space:normal; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.wr-process { margin-top:6px; } .wr-process button { min-height:24px; padding:0; font-size:12px; color:var(--faint); }
.wr-typing { color:var(--faint); font-size:13px; }
@media (prefers-reduced-motion: no-preference) { .wr-typing i { display:inline-block; width:4px; height:4px; margin-left:3px; border-radius:50%; background:currentColor; animation:wr-blink 1.2s infinite; }
  .wr-typing i:nth-child(2) { animation-delay:.2s; } .wr-typing i:nth-child(3) { animation-delay:.4s; } }
@keyframes wr-blink { 0%,80%,100% { opacity:.2; } 40% { opacity:1; } }
.wr-hello { margin:auto 0; color:var(--dim); line-height:1.75; }
.wr-hello b { color:var(--paper); display:block; font-size:16px; margin-bottom:6px; }
.wr-hello button { margin-top:14px; }
.wr-say { padding:10px 16px 16px; }
.wr-chips { display:flex; gap:6px; overflow-x:auto; padding-bottom:8px; scrollbar-width:none; }
.wr-chips button { border-radius:999px; min-height:28px; font-size:12.5px; color:var(--dim); flex:none; }

/* 右：台面 */
.wr-board { flex:1; min-width:0; overflow:auto; }
.wr-in { max-width:1180px; margin:0 auto; padding:22px 28px 64px; }
.wr-top { margin-bottom:20px; }
.wr-date { font-size:12.5px; color:var(--faint); }
.wr-headline { font-size:22px; line-height:1.35; font-weight:600; margin:2px 0 0; max-width:30em; text-wrap:balance; overflow-wrap:anywhere; letter-spacing:-.01em; }
.wr-headline.calm { color:var(--dim); font-weight:500; }
.wr-views { display:inline-flex; gap:2px; margin-top:14px; padding:3px; background:var(--board); border-radius:999px; }
.wr-views button { border:0; background:transparent; border-radius:999px; min-height:28px; padding:0 14px; color:var(--dim); font-size:13px; }
.wr-views button.on { background:var(--bg); color:var(--paper); font-weight:600; box-shadow:0 1px 3px var(--rule); }
.wr-board .wr-in > .wr-sec { margin-bottom:28px; }
/* 幕僚团 */
.wr-staff { display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:12px; }
.wr-card { border:1px solid var(--rule); border-radius:var(--r-l); padding:14px 16px; display:grid; gap:10px; align-content:start; cursor:pointer; background:var(--bg); }
.wr-card:hover { background:var(--raise); }
.wr-card.busy { border-color:color-mix(in srgb, var(--amber) 45%, var(--rule)); }
.wr-card .who { display:flex; gap:10px; align-items:center; }
.wr-card .avatar { width:36px; height:36px; border-radius:50%; background:var(--board); display:grid; place-items:center; font-weight:600; font-size:15px; flex:none; }
.wr-card.busy .avatar { background:var(--amber-bg); color:var(--amber); }
.wr-card b { display:block; font-weight:600; } .wr-card small { color:var(--faint); font-size:12px; }
.wr-card p { margin:0; color:var(--dim); font-size:13px; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; min-height:3.9em; }
.wr-card .now { display:flex; flex-wrap:wrap; gap:6px; } .wr-card .now .wr-tag { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; }
.wr-card .idle { color:var(--faint); font-size:12px; }
.wr-row .src { font-size:12px; color:var(--faint); } .wr-row .why { font-size:12px; color:var(--faint); margin-top:2px; }
.wr-row .why::before { content:'研判：'; }
.wr-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:28px; align-items:start; }
@container wr-board (min-width: 900px) { .wr-grid { grid-template-columns:minmax(0,1.1fr) minmax(0,1fr); gap:28px 32px; } }
.wr-board { container:wr-board / inline-size; }
.wr-col { display:grid; gap:28px; min-width:0; }
/* 台面只有一栏时，今天要处理的事排在态势图前面 */
.wr-col.today { order:-1; }
@container wr-board (min-width: 900px) { .wr-col.today { order:0; } }
.wr-sec > h2 { font-size:13px; font-weight:600; color:var(--dim); margin:0 0 8px; display:flex; align-items:center; gap:8px; min-height:28px; }
.wr-sec > h2 .n { font-variant-numeric:tabular-nums; color:var(--faint); font-weight:500; }
.wr-sec > h2 .n.hot { color:var(--amber); font-weight:600; }
.wr-sec > h2 button { margin-left:auto; min-height:26px; font-size:12px; border-radius:999px; color:var(--dim); }
.wr-empty { color:var(--faint); font-size:13px; padding:4px 0; }

/* 态势图 */
.wr-map { background:var(--board); border-radius:var(--r-l); overflow:hidden; }
.wr-map svg { display:block; width:100%; height:auto; }
.wr-map text { font-family:inherit; fill:var(--paper); font-size:12px; }
.wr-map .sub { fill:var(--faint); font-size:10.5px; }
.wr-map .grat { fill:none; stroke:var(--rule); stroke-width:1; }
.wr-map .hit { cursor:pointer; }
.wr-map .hit:focus:not(:focus-visible) { outline:none; }
.wr-map .ring { fill:none; stroke:var(--lamp-y); stroke-width:2; }
@media (prefers-reduced-motion: no-preference) { .wr-map .ring { animation:wr-pulse 2.4s ease-in-out infinite; } }
@keyframes wr-pulse { 50% { stroke-opacity:.3; } }
.wr-legend { display:flex; flex-wrap:wrap; gap:4px 16px; padding:10px 16px 12px; font-size:12px; color:var(--faint); }
.wr-legend span { display:inline-flex; align-items:center; gap:6px; }
.wr-legend svg { width:14px; height:14px; flex:none; }

/* 行 */
.wr-rows { border-radius:var(--r-m); border:1px solid var(--rule); overflow:hidden; }
.wr-row { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:2px 12px; align-items:baseline; padding:10px 14px; border-bottom:1px solid var(--hair); }
.wr-row:last-child { border-bottom:0; }
.wr-row.tap { cursor:pointer; }
.wr-row.tap:hover { background:var(--raise); }
.wr-row .lead { font-variant-numeric:tabular-nums; font-size:13px; color:var(--faint); min-width:2.6em; }
.wr-row .lead.wr-due { min-width:4.6em; }
.wr-row .main { min-width:0; overflow-wrap:anywhere; }
.wr-row .main b { font-weight:600; }
.wr-row .note .wr-tag { font-size:11.5px; padding:0 7px; line-height:17px; }
.wr-row .note { color:var(--dim); font-size:13px; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; white-space:pre-wrap; word-break:break-word; }
.wr-row .tail { display:flex; gap:6px; align-items:center; font-size:12px; color:var(--faint); white-space:nowrap; }
.wr-row .tail button { min-height:28px; padding:0 10px; font-size:12px; border-radius:999px; }
.wr-row .acts { grid-column:2 / -1; display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
.wr-row .acts input, .wr-row .acts textarea { flex:1 1 200px; }
.wr-row .acts.end { justify-content:flex-end; margin-top:4px; }
.wr-row .acts.end button { min-height:28px; font-size:12px; border-radius:999px; }
.wr-row.need { background:linear-gradient(90deg, var(--amber-bg), transparent 55%); }
.wr-row.bad { box-shadow:inset 3px 0 0 var(--lamp-r); }
.wr-tag { font-size:12px; color:var(--dim); background:var(--board); border-radius:999px; padding:1px 9px; line-height:18px; }
.wr-tag.need { color:var(--amber); background:var(--amber-bg); }
.wr-tag.bad { color:var(--lamp-r); background:color-mix(in srgb, var(--lamp-r) 10%, transparent); }
.wr-tag.tide { color:var(--tide); background:var(--tide-bg); }
.wr-due { font-variant-numeric:tabular-nums; font-size:13px; }
.wr-due.overdue { color:var(--lamp-r); font-weight:600; } .wr-due.today { color:var(--amber); font-weight:600; } .wr-due.soon { color:var(--paper); } .wr-due.later, .wr-due.none { color:var(--faint); }
.wr-lamp { display:inline-block; width:9px; height:9px; border-radius:2px; transform:rotate(45deg); background:var(--faint); margin:0 2px 1px 2px; }
.wr-lamp.green { background:var(--lamp-g); } .wr-lamp.yellow { background:var(--lamp-y); } .wr-lamp.red { background:var(--lamp-r); }
.wr-lamp.none { background:transparent; border:1px solid var(--faint); }
.wr-dot { display:inline-block; width:10px; height:10px; border-radius:50%; border:1.5px solid var(--faint); vertical-align:-1px; }
.wr-dot.warm { background:var(--paper); border-color:var(--paper); } .wr-dot.neutral { background:var(--faint); border-color:var(--faint); }
.wr-dot.cold { border-color:var(--tide); } .wr-dot.unknown { border-style:dashed; }
.wr-two { display:grid; grid-template-columns:1fr 1fr; gap:12px 16px; align-items:start; }
.wr-two h3 { font-size:12px; font-weight:500; color:var(--faint); margin:0 0 6px; }
.wr-fold > summary { cursor:pointer; color:var(--faint); font-size:13px; padding:8px 0 6px; }

/* 内联表单（抽屉里） */
.wr-form { display:grid; gap:10px; padding:14px; margin:10px 0; background:var(--board); border-radius:var(--r-m); }
.wr-form .line { display:flex; gap:8px; flex-wrap:wrap; }
.wr-form .line > * { flex:1 1 120px; }
.wr-form .line > button { flex:0 0 auto; }
.wr-form label { display:grid; gap:4px; font-size:12px; color:var(--dim); }
.wr-seg { display:inline-flex; border:1px solid var(--rule); border-radius:var(--r-s); overflow:hidden; flex:0 0 auto !important; width:max-content; background:var(--bg); }
.wr-seg button { border:0; border-radius:0; min-height:30px; color:var(--dim); background:transparent; }
.wr-seg button.on { background:var(--ink); color:var(--on-ink); }

/* 抽屉 */
.wr-veil { position:fixed; inset:0; background:var(--dsw-alias-bg-mask-1,#0000003d); display:flex; justify-content:flex-end; z-index:50; }
.wr-drawer { width:min(600px,100%); height:100%; overflow:auto; background:var(--bg); padding:22px 26px 48px; box-shadow:-12px 0 40px #00000014; }
.wr-drawer h2 { font-size:20px; margin:0; font-weight:600; }
.wr-drawer h3 { font-size:13px; font-weight:600; color:var(--dim); margin:22px 0 6px; }
.wr-drawer .head { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:6px; }
.wr-drawer .meta { color:var(--dim); font-size:13px; }
.wr-list { margin:0; padding:0; list-style:none; }
.wr-list li { padding:8px 0; border-bottom:1px solid var(--hair); font-size:13px; white-space:pre-wrap; word-break:break-word; }
.wr-list li time { font-variant-numeric:tabular-nums; color:var(--faint); margin-right:8px; }
.wr-kv { display:grid; grid-template-columns:76px 1fr; gap:6px 12px; font-size:13px; margin:12px 0; }
.wr-kv dt { color:var(--faint); } .wr-kv dd { margin:0; white-space:pre-wrap; }
.wr-pre { white-space:pre-wrap; word-break:break-word; font-size:13px; line-height:1.7; background:var(--board); border-radius:var(--r-m); padding:12px 14px; max-height:60vh; overflow:auto; margin:0; }
.wr-file { display:block; color:var(--tide); cursor:pointer; padding:3px 0; font-size:13px; word-break:break-all; }

/* Markdown 正文 */
.md { font-size:15px; line-height:1.75; color:var(--paper); word-break:break-word; }
.md > :first-child, .md .md-blk > :first-child { margin-top:0; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { line-height:1.35; font-weight:600; margin:1.4em 0 .5em; }
.md h1 { font-size:24px; } .md h2 { font-size:19px; padding-bottom:.3em; border-bottom:1px solid var(--hair); } .md h3 { font-size:16.5px; } .md h4, .md h5, .md h6 { font-size:15px; }
.md p { margin:.6em 0; }
.md ul, .md ol { margin:.5em 0; padding-left:1.4em; } .md li { margin:.25em 0; } .md li::marker { color:var(--faint); }
.md li.task { list-style:none; margin-left:-1.4em; display:flex; gap:8px; align-items:baseline; } .md li.task > .md-blk, .md li.task > * { flex:1; }
.md-check { display:inline-block; width:13px; height:13px; border:1.5px solid var(--faint); border-radius:3px; flex:none; transform:translateY(1px); }
.md-check.on { background:var(--lamp-g); border-color:var(--lamp-g); }
.md blockquote { margin:.8em 0; padding:.2em 0 .2em 1em; border-left:3px solid var(--rule); color:var(--dim); }
.md code { font-family:"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; font-size:.88em; background:var(--board); border-radius:4px; padding:.1em .35em; }
.md .md-code { background:var(--board); border-radius:var(--r-m); padding:12px 14px; overflow:auto; font-size:13px; line-height:1.6; margin:.8em 0; }
.md .md-code code { background:none; padding:0; font-size:inherit; }
.md .md-table { overflow-x:auto; margin:.8em 0; }
.md table { border-collapse:collapse; font-size:13.5px; min-width:100%; }
.md th, .md td { border:1px solid var(--rule); padding:6px 10px; text-align:left; vertical-align:top; }
.md th { background:var(--board); font-weight:600; }
.md a { color:var(--tide); text-decoration:none; } .md a:hover { text-decoration:underline; }
.md hr { border:0; border-top:1px solid var(--rule); margin:1.4em 0; }
.md .md-raw { color:var(--faint); font-family:monospace; font-size:12.5px; white-space:pre-wrap; }
.md.chat { font-size:14px; line-height:1.65; } .md.chat h1, .md.chat h2, .md.chat h3 { font-size:15px; border:0; padding:0; margin:.8em 0 .3em; }
.md.chat p { margin:.4em 0; } .md.chat > :last-child { margin-bottom:0; }

/* 批注 */
.md-blk { position:relative; margin:0 -12px; padding:1px 12px; border-radius:var(--r-s); transition:background .15s; }
@media (hover: hover) { .md-blk:hover { background:var(--raise); } .md-blk:hover > .md-note-btn { opacity:1; } }
.md-blk.on { background:var(--tide-bg); }
.md-blk.noted { background:color-mix(in srgb, var(--amber-bg) 70%, transparent); box-shadow:inset 3px 0 0 var(--amber); }
.md-note-btn { position:absolute; top:2px; right:-6px; opacity:0; transform:translateX(100%); min-height:26px !important; padding:0 10px !important; font-size:12px !important;
  border-radius:999px !important; background:var(--bg) !important; box-shadow:0 1px 4px var(--rule); color:var(--tide) !important; border-color:var(--rule) !important; }
.md-note-btn:focus-visible { opacity:1; }
.md-note { margin:4px 0 8px; padding:6px 10px; border-radius:var(--r-s); background:var(--bg); border:1px solid color-mix(in srgb, var(--amber) 40%, var(--rule)); font-size:13px; line-height:1.55; cursor:pointer; }
.md-note b { display:block; font-size:11.5px; color:var(--amber); font-weight:600; }
.md-compose { margin:6px 0 10px; padding:10px; border-radius:var(--r-m); background:var(--bg); border:1px solid var(--rule); box-shadow:0 4px 18px var(--rule); display:grid; gap:8px; }
.md-compose .quote { font-size:12.5px; color:var(--faint); line-height:1.5; }
.md-compose textarea { width:100%; resize:vertical; min-height:72px; font-size:14px; }
.md-compose .row { display:flex; gap:8px; align-items:center; }

/* 阅读器 */
.wr-reader { position:fixed; inset:0; z-index:60; background:var(--bg); display:flex; flex-direction:column; color:var(--paper); }
.wr-reader > header { display:flex; align-items:center; gap:8px; padding:10px 16px; border-bottom:1px solid var(--hair); padding-top:max(10px, env(safe-area-inset-top)); }
.wr-reader > header .title { min-width:0; display:grid; } .wr-reader > header .title b { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wr-reader > header .title span { font-size:12px; color:var(--faint); }
.wr-reader .files { display:flex; gap:6px; padding:8px 16px; overflow-x:auto; border-bottom:1px solid var(--hair); scrollbar-width:none; }
.wr-reader .files button { border-radius:999px; min-height:28px; font-size:12.5px; color:var(--dim); flex:none; }
.wr-reader .files button.on { background:var(--ink); color:var(--on-ink); border-color:var(--ink); }
.wr-reader .body { flex:1; overflow:auto; -webkit-overflow-scrolling:touch; }
.wr-reader .page { max-width:760px; margin:0 auto; padding:20px 72px 40px 28px; }
.wr-reader .tip { font-size:12.5px; color:var(--faint); margin-bottom:14px; }
.wr-reader .done { display:grid; gap:14px; justify-items:start; padding:40px 0; }
.wr-reader > footer { border-top:1px solid var(--rule); padding:10px 16px; padding-bottom:max(10px, env(safe-area-inset-bottom)); display:grid; gap:8px; background:var(--bg); }
.wr-reader > footer .bar { display:flex; align-items:center; gap:8px; max-width:760px; width:100%; margin:0 auto; }
.wr-reader > footer input { max-width:760px; width:100%; margin:0 auto; }
.wr-reader > footer .count { flex:1; font-size:13px; color:var(--dim); }
@media (hover: none) { .wr-document-content, .md-blk { -webkit-touch-callout:default; -webkit-user-select:text; user-select:text; } .md-blk button { -webkit-user-select:none; user-select:none; } }
/* 第一次打开：接口人的开场白 */
.wr-setup { align-items:center; justify-content:center; overflow:auto; }
.wr-setup-in { width:min(560px,100%); padding:32px 24px; display:flex; flex-direction:column; gap:14px; }
.wr-setup .who { display:flex; align-items:center; gap:10px; }
.wr-avatar { width:32px; height:32px; border-radius:50%; background:var(--ink); color:var(--on-ink); display:inline-flex; align-items:center; justify-content:center; font-size:14px; font-weight:600; }
.wr-setup .wr-msg p { margin:0 0 10px; }
.wr-setup-form { display:flex; gap:8px; }
.wr-setup-form input { flex:1; font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.wr-setup .hint { color:var(--faint); font-size:12.5px; line-height:1.6; }

/* 设置 */
.wr-date { display:flex; align-items:center; gap:8px; }
.wr-gear { margin-left:auto; font-size:12.5px; min-height:26px; }
.wr-settings { display:flex; flex-direction:column; gap:12px; }
.wr-settings h3 { margin:18px 0 0; }
.wr-field { display:grid; grid-template-columns:8.5em minmax(0,1fr); gap:4px 12px; align-items:baseline; }
.wr-field .label { color:var(--dim); font-size:13px; }
.wr-field .hint { grid-column:2; color:var(--faint); font-size:12px; line-height:1.55; }
.wr-model-select { width:100%; max-width:100%; text-overflow:ellipsis; }
.wr .wr-model-select:disabled { opacity:.7; cursor:not-allowed; }
.wr-form .line > .wr-model-cell { flex:1 1 220px; min-width:0; align-content:start; }
.wr-form .wr-model-note { color:var(--faint); font-size:12px; line-height:1.55; overflow-wrap:anywhere; }
.wr-field .wr-model-note { overflow-wrap:anywhere; }
.wr .wr-model-note.warn { color:var(--lamp-r); }
.wr-settings .row { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; }
.wr-note { color:var(--dim); font-size:12.5px; line-height:1.6; background:var(--board); border-radius:var(--r-m); padding:8px 12px; }
.wr-ok { color:var(--lamp-g); font-size:13px; }
.mono { font-family:var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size:12.5px; word-break:break-all; }

/* 导入 */
.wr-import { display:flex; flex-direction:column; gap:10px; }
.wr-import h3 { margin:14px 0 0; }
.wr-import textarea { width:100%; resize:vertical; line-height:1.6; }
.wr-import .prompt { font-size:12.5px; color:var(--dim); background:var(--board); }
.wr-import .row { display:flex; gap:8px; align-items:center; justify-content:flex-end; }
.wr-import .count { font-size:12px; color:var(--faint); }
.wr-chipset { display:flex; flex-wrap:wrap; gap:6px; }
.wr-mode { min-height:32px; font-size:12.5px; color:var(--dim); }
.wr-map .grp { opacity:.75; }
.wr-groups { margin:0 0 10px; } .wr-groups i { font-style:normal; margin-left:6px; opacity:.6; font-variant-numeric:tabular-nums; }
.wr-group + .wr-group { margin-top:14px; }
.wr-group h3 { font-size:12px; font-weight:600; color:var(--faint); margin:0 0 4px; display:flex; gap:6px; } .wr-group h3 .n { font-weight:400; }
.wr-chipset button { border-radius:999px; min-height:28px; font-size:13px; }
.wr .wr-chipset button.on, .wr .wr-chipset button.on:hover:not(:disabled) { background:var(--ink); border-color:var(--ink); color:var(--on-ink); }
.wr-hello .row { display:flex; gap:8px; flex-wrap:wrap; }
.wr-groups { margin:0 0 10px; } .wr-groups i { font-style:normal; margin-left:6px; opacity:.6; font-variant-numeric:tabular-nums; }
.wr-group + .wr-group { margin-top:14px; }
.wr-group h3 { font-size:12px; font-weight:600; color:var(--faint); margin:0 0 4px; display:flex; gap:6px; } .wr-group h3 .n { font-weight:400; }
.wr-export-part h3 { display:flex; align-items:baseline; gap:8px; } .wr-export-part h3 .count { margin-left:auto; font-weight:400; }
.wr-export-part { display:flex; flex-direction:column; gap:8px; }

/* 定制：密度、单列、自定义面板 */
.wr.d-compact .wr-row { padding:6px 12px; } .wr.d-compact .wr-col, .wr.d-compact .wr-grid { gap:18px; }
.wr.d-roomy .wr-row { padding:14px 16px; } .wr.d-roomy .wr-col, .wr.d-roomy .wr-grid { gap:36px; }
@container wr-board (min-width: 900px) { .wr-grid.one { grid-template-columns:minmax(0,1fr); } }
.wr-panel-md { background:var(--board); border-radius:var(--r-m); padding:10px 16px; max-height:420px; overflow:auto; }
@media (max-width: 860px) {
  .wr-reader .page { padding:16px 18px 32px; }
  .md { font-size:16px; } .md h1 { font-size:22px; } .md h2 { font-size:18.5px; }
  .md-blk { margin:0 -8px; padding:1px 8px; }
}

/* 工作区按栏内宽度切换布局，计入侧栏和界面缩放。 */
.wr-workroom { container:wr-workroom / inline-size; position:relative; --wr-tabs-height:calc(56px + env(safe-area-inset-bottom, 0px)); }
.wr-tabs { display:none; }
@container wr-workroom (max-width: 800px) {
  .wr-chat { display:none; flex:1; height:calc(100% - var(--wr-tabs-height)); }
  .chief-surface .wr-chat { border-right:0; }
  .wr.t-chat .wr-chat { display:flex; }
  .wr.t-chat .wr-board { display:none; }
  .wr-board { height:calc(100% - var(--wr-tabs-height)); }
  .wr-in { padding:16px 14px 40px; }
  .wr-headline { font-size:19px; }
  .wr-grid { gap:24px; } .wr-col { display:contents; }
  .wr-board [data-tab] { display:none; }
  .wr.t-today [data-tab~="today"], .wr.t-people [data-tab~="people"] { display:block; }
  .wr-views { display:none; }
  .wr-tabs { display:grid; grid-auto-flow:column; grid-auto-columns:minmax(0,1fr); position:absolute; left:0; right:0; bottom:0; height:var(--wr-tabs-height); padding-bottom:env(safe-area-inset-bottom, 0px); background:var(--bg); border-top:1px solid var(--rule); z-index:40; }
  .wr-tabs button { border:0; border-radius:0; background:transparent; color:var(--faint); font-size:12.5px; display:grid; place-items:center; align-content:center; gap:1px; padding:0; min-height:0; }
  .wr-tabs button.on { color:var(--paper); font-weight:600; }
  .wr-tabs button i { font-style:normal; font-size:11px; color:var(--amber); font-variant-numeric:tabular-nums; line-height:12px; min-height:12px; }
  .wr-map text { font-size:13px; } .wr-map .sub { font-size:11px; }
}
@media (max-width: 860px) {
  .wr button { min-height:40px; } .wr-chips button { min-height:34px; } .wr-row .tail button, .wr-row .acts.end button { min-height:36px; }
  .wr input, .wr textarea, .wr select { font-size:16px; min-height:40px; }
  .wr-two { grid-template-columns:1fr; }
  .wr-drawer { padding:16px 16px 48px; }
  .wr-field { grid-template-columns:minmax(0,1fr); } .wr-field .hint { grid-column:1; }
  .wr-setup { display:block; }
  .wr-setup-form { flex-direction:column; }
}

.wr-reader-tools { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:8px 16px; border-bottom:1px solid var(--hair); font-size:12px; }
.md-ask-btn { margin:3px 0 8px; min-height:30px !important; font-size:12px !important; color:var(--dim); }
.wr-discussion { border-top:1px solid var(--rule); margin-top:30px; padding-top:12px; scroll-margin-top:12px; overflow-wrap:anywhere; }
.wr-discussion .meta, .wr-workline .meta { color:var(--dim); font-size:12px; overflow-wrap:anywhere; }
.wr-thread-list { display:grid; gap:6px; margin-bottom:12px; }
.wr-thread-list button { text-align:left; white-space:normal; height:auto; }
.wr-thread-list .on { border-color:var(--ink); }
.wr-disc-message { padding:10px 12px; margin:8px 0; background:var(--raise); border-radius:8px; }
.wr-disc-message.owner { border-left:2px solid var(--ink); }
.wr-discussion blockquote { margin:8px 0; padding:8px 12px; border-left:2px solid var(--rule); max-height:180px; overflow:auto; }
.wr-discussion .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.wr-workline h4 { margin:20px 0 8px; }
.wr-workline .wr-file { display:block; width:100%; text-align:left; overflow-wrap:anywhere; white-space:normal; height:auto; }
.wr-date { flex-wrap:wrap; }
.wr-thread-inbox { display:grid; gap:8px; }
.wr-thread-inbox > button { display:grid; gap:4px; text-align:left; white-space:normal; height:auto; padding:12px; overflow-wrap:anywhere; }
.wr-thread-inbox b { font-size:14px; font-weight:600; }
.wr-thread-inbox .meta:last-child { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
.wr-ticket-conversation { margin:14px 0; min-width:0; }
.wr-ticket-conversation h3 { display:flex; gap:10px; align-items:baseline; }
.wr-ticket-messages { max-height:45dvh; overflow:auto; overscroll-behavior:contain; padding:2px; scroll-behavior:smooth; }
.wr-ticket-message { padding:10px 12px; margin:8px 0; border-radius:var(--r-m); background:var(--board); overflow-wrap:anywhere; }
.wr-ticket-message.owner { margin-left:24px; border-right:2px solid var(--ink); }
.wr-ticket-message.system { background:transparent; color:var(--dim); border-left:2px solid var(--rule); }
.wr-ticket-message .by { display:flex; gap:8px; flex-wrap:wrap; color:var(--faint); font-size:11.5px; margin-bottom:5px; }
.wr-ticket-message .by b { color:var(--dim); }
.wr-ticket-message .wr-chipset { margin-top:10px; }
.wr-ticket-question { margin-top:8px; padding-top:7px; border-top:1px solid var(--rule); }
.wr-ticket-message .wr-chipset button { white-space:normal; height:auto; padding:5px 10px; }
.wr-ticket-compose { display:grid; gap:7px; border-top:1px solid var(--rule); padding-top:12px; }
.wr-ticket-compose label { font-size:13px; font-weight:600; }
.wr-ticket-compose .wr-remote-consent { display:flex; align-items:center; gap:8px; font-weight:400; }
.wr-remote-consent input { flex:none; width:18px; min-height:18px; }
.wr-ticket-compose p { margin:0; }
.wr-ticket-compose textarea { width:100%; resize:vertical; min-height:80px; }
.wr-ticket-compose .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
.wr-ticket-compose .wr-note button { margin:6px 0 0; display:block; }
.wr-ticket-actions { display:flex; flex-wrap:wrap; gap:8px; border-top:1px solid var(--rule); padding-top:14px; }
@media(max-width:600px) { .wr-reader > footer .bar { flex-wrap:wrap; } .wr-discussion textarea { font-size:16px; } }

/* One conversation language across the liaison and topic views. */
.wr-chat-head{height:88px;flex:none;padding:22px 24px;align-items:center;border-bottom:1px solid var(--hair);gap:12px}
.wr-chat-head h2{font-size:16px;line-height:1.5;margin:0 0 3px}.wr-chat-head span{font-size:11px}.wr-chat-head>i{width:5px;height:5px;background:#849d8b;border-radius:50%;margin-left:auto}.wr-chat-head>i.working{background:var(--amber)}
.wr-liaison-avatar{width:36px;height:36px;border-radius:11px;background:var(--board);display:grid;place-items:center;font-size:14px;font-weight:600;color:var(--dim)}
.wr-msgs{padding:24px;gap:23px}.wr-msg{font-size:14px;line-height:1.75}.wr-msg.you{padding:10px 14px;background:var(--board);max-width:90%;border-radius:12px 12px 3px 12px}
.wr-hello{font-size:13px;line-height:1.9;padding:12px 0}.wr-hello b{font-size:20px;font-weight:600;line-height:1.5;margin-bottom:14px;letter-spacing:-.3px}.wr-hello .row{display:flex;flex-direction:column;align-items:flex-start;gap:6px}.wr-hello button{font-size:11px;margin-top:8px;max-width:100%}
.wr-say{padding:16px 18px 20px;border-top:1px solid var(--hair)}.wr-chips{gap:5px;padding-bottom:12px}.wr-chips button{border:0;background:var(--board);font-size:11px;padding:0 9px;min-height:27px;border-radius:6px}
.room-provenance{font-size:10px;color:var(--dim)}.room-provenance summary{cursor:pointer}
@media(max-width:860px){.wr-chat-head{height:76px;padding:17px 20px}.wr-msgs{padding:20px}.wr-hello{max-width:360px;margin:auto}.wr-hello .row{gap:6px}.wr-say{padding-bottom:18px}}
${CHAT_ATTACHMENT_STYLE}
`
