import { CHAT_ATTACHMENT_STYLE } from './chat-attachments-style.ts'

const darkPalette = `
  --v-paper:#141519; --v-surface:#191A20; --v-ink:#F2F2F6; --v-muted:#B6B8C2;
  --v-line:#454750; --v-soft:#30323A; --v-tint:#25272F; --v-leaf:#29324C;
  --hub-brand:#91A0FF; --hub-brand-text:#B2BDFF; --hub-action:#F2F2F7; --hub-action-text:#13141A;
  --chat-own:#2B3758; --chat-back:#1B1D23; --v-amber:#E8BA7C; --v-alert:#F39B99;
  --v-disabled:#9095A6; --v-disabled-ink:#15171C; color-scheme:dark;
`

export const WORKSPACE_V2_STYLE = `
.wv2 {
  --v-paper:#FFFFFF; --v-surface:#FFFFFF; --v-ink:#181A20; --v-muted:#5B6069;
  --v-line:#DCDFE5; --v-soft:#E9EBEF; --v-tint:#F3F4F6; --v-leaf:#EFF2FF;
  --hub-brand:#4D65F5; --hub-brand-text:#3F55C4; --hub-action:#0D0E13; --hub-action-text:#FFFFFF;
  --chat-own:#E9EEFF; --chat-back:#FFFFFF; --v-amber:#835316; --v-alert:#A13A34;
  --v-disabled:#686C76; --v-disabled-ink:#FFFFFF; --v-green:var(--hub-brand-text); --v-on:var(--hub-action-text);
  --v-font:Inter,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;
  position:relative; display:flex; flex-direction:column; width:100%; height:100%; min-width:0; min-height:0;
  overflow:hidden; isolation:isolate; container-type:inline-size; background:var(--v-paper); color:var(--v-ink); color-scheme:light; font:15px/1.65 var(--v-font);
}
body[data-ds-dark-theme]:not([data-chief-standalone]) .wv2 { ${darkPalette} }
@media(prefers-color-scheme:dark) { body[data-chief-standalone] .wv2 { ${darkPalette} } }
.wv2 *, .wv2 *::before, .wv2 *::after { box-sizing:border-box; }
.wv2 [hidden] { display:none!important; }
.wv2 :is(h1,h2,h3,p,ul,ol,dl,dd) { margin:0; }
.wv2 :is(h1,h2,h3) { color:var(--v-ink); }
.wv2 button,.wv2 input,.wv2 select,.wv2 textarea { color:inherit; font:inherit; }
.wv2 button { border:0; padding:0; background:transparent; cursor:pointer; }
.wv2 button:disabled { color:var(--v-muted); cursor:default; }
.wv2 :is(button,input,textarea,select,summary,a,[tabindex]):focus-visible { outline:3px solid var(--hub-brand); outline-offset:2px; }
.wv2 .v2-bound { width:min(calc(100% - 100px),1180px); margin-inline:auto; min-width:0; }
.wv2 .v2-icon { display:inline-block; flex:none; width:17px; height:17px; }
.wv2 .v2-mast { flex:none; background:var(--v-paper); }
.wv2 .v2-mast>.v2-bound { width:min(calc(100% - 72px),1392px); min-height:70px; display:flex; align-items:center; gap:30px; }
.wv2 .v2-brand { display:inline-flex; flex:none; align-items:center; gap:9px; margin:0; padding:0; border:0; border-radius:6px; background:none; color:var(--v-ink); font:720 23px/1.1 var(--v-font); letter-spacing:-.065em; cursor:pointer; }
.wv2 .v2-brand img { width:27px; height:30px; object-fit:contain; }
.wv2 .v2-primary-nav,.wv2 .v2-subnav { display:flex; gap:24px; align-self:stretch; }
.wv2 .v2-primary-nav { margin-inline-start:auto; align-self:center; }
.wv2 .v2-primary-nav button,.wv2 .v2-subnav button { position:relative; display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:42px; padding-inline:3px; color:var(--v-muted); font-size:14px; white-space:nowrap; }
.wv2 .v2-primary-nav button[aria-current],.wv2 .v2-subnav button[aria-current] { color:var(--v-ink); font-weight:650; }
.wv2 :is(.v2-primary-nav,.v2-subnav) button[aria-current] .v2-icon { color:var(--hub-brand-text); }
.wv2 .v2-subnav button[aria-current]::after { content:""; position:absolute; inset:auto 0 -1px; height:2px; background:var(--hub-brand); }
.wv2 .v2-mast-actions,.wv2 .v2-actions { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.wv2 .v2-button,.wv2 .v2-link { display:inline-flex; align-items:center; justify-content:center; gap:7px; min-height:40px; text-align:left; font-size:14px; line-height:1.45; font-weight:550; }
.wv2 .v2-button { padding:8px 16px; border:1px solid var(--v-line); border-radius:12px; background:var(--v-surface); }
.wv2 .v2-button.primary { color:var(--hub-action-text); border-color:var(--hub-action); border-radius:15px; background:var(--hub-action); }
.wv2 .v2-button.primary:disabled { color:var(--v-disabled-ink); background:var(--v-disabled); border-color:var(--v-disabled); }
.wv2 .v2-button:hover:enabled:not(.primary),.wv2 .v2-row:hover,.wv2 .v2-thread:hover,.wv2 .v2-space-card:hover { background:var(--v-tint); }
.wv2 .v2-button.primary:hover:enabled { filter:brightness(.9); }
.wv2 .v2-liaison-button { position:relative; }
.wv2 .v2-badge { position:absolute; top:-8px; inset-inline-end:-8px; display:inline-flex; align-items:center; justify-content:center; min-width:20px; height:20px; padding:0 5px;
  border:2px solid var(--v-paper); border-radius:10px; background:var(--v-alert); color:var(--v-paper); font-size:11px; line-height:1; font-weight:700; font-variant-numeric:tabular-nums; pointer-events:none; }
.wv2 .v2-owner-action-count { padding:2px 5px; border-radius:6px; background:var(--v-alert); color:var(--v-paper); font-size:11px; white-space:nowrap; font-variant-numeric:tabular-nums; }
.wv2 .v2-liaison-actions { margin:0 0 12px; max-height:26dvh; overflow:auto; }
.wv2 .v2-liaison-actions>.v2-pending-approvals { margin:0; }
.wv2 .v2-liaison-actions .v2-section-head h2 { font-size:16px; }
.wv2 .v2-owner-action-row .v2-row-title { white-space:normal; overflow-wrap:anywhere; }
.wv2 .v2-owner-action-reply { border-left:2px solid var(--v-alert); padding:6px 0 0 10px; margin-top:9px; overflow-wrap:anywhere; }
.wv2 .v2-owner-action-reply>strong { color:var(--v-alert); }
.wv2 .v2-owner-action-reply>small { display:block; color:var(--v-muted); }
.wv2 .v2-owner-action-reply .v2-compose { margin:0; padding:4px 0 0; }
.wv2 .v2-reader .v2-order-wait-reason { margin-top:5px; color:var(--v-muted); font-size:13px; overflow-wrap:anywhere; }
.wv2 .v2-link { color:var(--v-ink); }
.wv2 .v2-link:hover:enabled { text-decoration:underline; text-underline-offset:4px; }
.wv2 .v2-page { flex:1; min-height:0; overflow:auto; padding-bottom:36px; scrollbar-gutter:stable; }
.wv2 .v2-hero { display:flex; justify-content:space-between; align-items:flex-end; gap:16px; padding:28px 0 20px; border-bottom:1px solid var(--v-line); }
.wv2 .v2-hero>div { min-width:0; }
.wv2 .v2-work-hero>div:first-child { flex:1 1 16rem; }
.wv2 .v2-work-hero>.v2-button { flex:none; white-space:nowrap; }
.wv2 .v2-eyebrow { display:flex; align-items:center; gap:8px; color:var(--v-muted); font-size:13px; }
.wv2 .v2-hero h1,.wv2 .v2-offline h1 { margin:5px 0; font:650 clamp(34px,4cqw,52px)/1.25 var(--v-font); letter-spacing:-.055em; overflow-wrap:anywhere; }
.wv2 .v2-hero p { color:var(--v-muted); overflow-wrap:anywhere; }
.wv2 .v2-hero .v2-actions { margin:0; }
.wv2 .v2-transfer { gap:2px; }
.wv2 .v2-transfer .v2-link { color:var(--v-muted); font-size:13px; padding:4px 9px; border-radius:8px; }
.wv2 .v2-transfer .v2-link:hover { background:var(--v-tint); }
.wv2 .v2-home { display:grid; grid-template-columns:minmax(0,1.22fr) minmax(0,1fr); column-gap:clamp(32px,6.2cqw,96px); align-items:start; }
.wv2 .v2-home>.v2-hero { display:contents; }
.wv2 .v2-home>.v2-hero>div:first-child { grid-area:1/1; align-self:end; padding-top:35px; }
.wv2 .v2-home .v2-eyebrow { font-size:14px; font-weight:500; letter-spacing:.035em; }
.wv2 .v2-home .v2-hero h1 { margin:10px 0 1px; font:750 clamp(57px,5.85cqw,86px)/1.19 var(--v-font); letter-spacing:-.078em; }
.wv2 .v2-home .v2-transfer { grid-area:1/2; justify-self:end; padding-top:8px; z-index:1; }
.wv2 .v2-home-emblem { display:block; grid-area:1/2/3/3; align-self:center; width:100%; height:clamp(310px,31cqw,420px); margin-block:12px 2px; padding-top:13px; object-fit:contain; }
.wv2 .v2-liaison-card { grid-area:2/1; display:grid; justify-items:start; gap:18px; padding:14px 0 34px; }
.wv2 .v2-liaison-card h2 { font:650 20px/1.45 var(--v-font); letter-spacing:-.03em; }
.wv2 .v2-liaison-card p { margin-top:6px; font-size:clamp(15px,1.3cqw,18px); color:var(--v-muted); }
.wv2 .v2-liaison-card .v2-button { min-height:46px; padding:8px 19px; gap:11px; }
.wv2 .v2-home>.v2-history,.wv2 .v2-home>.v2-today { min-width:0; margin:0; border-top:1px solid var(--v-line); padding:22px 0 30px; }
.wv2 .v2-home>.v2-history { grid-area:3/1; }
.wv2 .v2-home>.v2-today { grid-area:3/2; }
.wv2 .v2-home>.v2-result-inbox { grid-area:3/1/4/-1; min-width:0; border-top:1px solid var(--v-line); padding:20px 0 26px; }
.wv2 .v2-result-inbox~.v2-history,.wv2 .v2-result-inbox~.v2-today { grid-row:4; }
.wv2 .v2-result-alert { margin:0 0 14px; }
.wv2 .v2-home>.v2-feedback { grid-column:1/-1; }
.wv2 .v2-home .v2-history .v2-card { border:0; border-radius:0; overflow:visible; background:transparent; }
.wv2 .v2-home .v2-history .v2-row { padding:14px 2px; border:0; border-bottom:1px solid var(--v-soft); }
.wv2 .v2-home .v2-row-title strong { font:630 17px/1.5 var(--v-font); }
.wv2 .v2-home .v2-section-head>.v2-link { color:var(--v-muted); font-size:13px; }
.wv2 .v2-subnav { border-bottom:1px solid var(--v-line); }
.wv2 .v2-subnav button { min-height:44px; }
.wv2 .v2-columns { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(240px,1fr); gap:24px; align-items:start; }
.wv2 .v2-columns,.wv2 .v2-talk-board,.wv2 .v2-today { margin-top:22px; }
.wv2 .v2-columns>* { min-width:0; }
.wv2 .v2-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:9px; }
.wv2 .v2-section-head h2,.wv2 .v2-job h2 { min-width:0; display:flex; align-items:center; gap:8px; font:680 23px/1.5 var(--v-font); letter-spacing:-.035em; overflow-wrap:anywhere; }
.wv2 .v2-section-head h2 .v2-icon { color:var(--v-muted); }
.wv2 .v2-card,.wv2 .v2-welcome { background:var(--v-surface); border:1px solid var(--v-line); border-radius:11px; overflow-wrap:anywhere; }
.wv2 .v2-space-grid { display:grid; grid-template-columns:minmax(0,1fr); }
.wv2 .v2-space-card { display:grid; grid-template-columns:38px minmax(0,1fr) auto; align-items:center; gap:12px; width:100%; min-height:64px; padding:12px 2px; text-align:left; border-bottom:1px solid var(--v-soft); }
.wv2 .v2-tile-mark { display:block; width:38px; height:40px; object-fit:contain; }
.wv2 .v2-space-description { min-width:0; overflow-wrap:anywhere; }
.wv2 .v2-space-description strong { display:block; font:630 16px/1.5 var(--v-font); }
.wv2 .v2-space-description small { display:block; margin-top:2px; color:var(--v-muted); font-size:13px; }
.wv2 .v2-open { display:inline-flex; align-items:center; gap:2px; color:var(--v-muted); font-size:12px; white-space:nowrap; }
.wv2 .v2-open .v2-icon { width:13px; height:13px; }
.wv2 .v2-welcome>.v2-icon { color:var(--hub-brand-text); margin-bottom:8px; }
.wv2 .v2-welcome { max-width:760px; padding:clamp(25px,6cqw,64px); margin:25px 0; }
.wv2 .v2-welcome>.v2-icon { width:32px; height:32px; }
.wv2 .v2-welcome h2 { font:650 clamp(26px,3.2cqw,36px)/1.45 var(--v-font); }
.wv2 .v2-welcome p,.wv2 .v2-empty p,.wv2 .v2-offline p { color:var(--v-muted); }
.wv2 .v2-welcome .v2-button,.wv2 .v2-offline .v2-button { margin:17px 8px 0 0; }
.wv2 .v2-offline { padding-block:10vh; }
.wv2 .v2-empty { border:1px dashed var(--v-line); border-radius:8px; padding:20px; color:var(--v-muted); overflow-wrap:anywhere; }
.wv2 .v2-hero+.v2-empty { margin-top:18px; }
.wv2 .v2-empty strong { color:var(--v-ink); font-size:16px; }
.wv2 .v2-empty p { margin-top:3px; font-size:14px; }
.wv2 .v2-row { display:block; width:100%; padding:14px 17px; text-align:left; }
.wv2 .v2-row+.v2-row,.wv2 .v2-thread+.v2-thread { border-top:1px solid var(--v-soft); }
.wv2 .v2-row-title { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.wv2 :is(.v2-row,.v2-thread) strong { min-width:0; overflow-wrap:anywhere; }
.wv2 .v2-row small,.wv2 .v2-thread small,.wv2 .v2-quiet,.wv2 .v2-chat-meta { display:block; color:var(--v-muted); font-size:13px; }
.wv2 .v2-row small { margin-top:4px; overflow-wrap:anywhere; }
.wv2 .v2-people { margin-block:22px; min-width:0; }
.wv2 .v2-people-tools { display:grid; grid-template-columns:minmax(180px,2fr) repeat(2,minmax(120px,1fr)); gap:14px; }
.wv2 .v2-people-tools label { display:grid; min-width:0; gap:4px; color:var(--v-muted); font-size:13px; }
.wv2 .v2-people-tools :is(select,input) { min-height:42px; background:var(--v-surface); }
.wv2 .v2-people-search>span:last-child { position:relative; }
.wv2 .v2-people-search .v2-icon { position:absolute; inset:50% auto auto 12px; transform:translateY(-50%); }
.wv2 .v2-people-search input[type=search] { padding-inline-start:37px; }
.wv2 .v2-people-count { margin:15px 0 10px; font-size:13px; color:var(--v-muted); }
.wv2 .v2-people-groups { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,410px),1fr)); gap:20px 24px; align-items:start; }
.wv2 .v2-people-group { min-width:0; }
.wv2 .v2-people-group>header { display:flex; align-items:baseline; gap:8px; margin:0 0 7px; }
.wv2 .v2-people-group h3 { font:650 18px/1.5 var(--v-font); overflow-wrap:anywhere; }
.wv2 .v2-people-group>header span { color:var(--v-muted); font-size:12px; white-space:nowrap; }
.wv2 .v2-person-rank { flex:none; color:var(--v-muted); font-size:12px; }
.wv2 .v2-person-rank[data-level=high] { border-radius:4px; padding:1px 7px; background:var(--v-leaf); color:var(--v-green); font-weight:700; }
.wv2 .v2-person-rank[data-level=mid] { color:var(--v-ink); font-weight:600; }
.wv2 .v2-quiet { padding:14px; }
.wv2 .v2-status { flex:none; padding:1px 7px; border-radius:4px; background:var(--v-leaf); color:var(--v-green); font-size:12px; }
.wv2 .v2-next { display:block; color:var(--v-green); font-size:13px; margin-top:4px; }
.wv2 .v2-job { margin-top:10px; }
.wv2 .v2-work-orders { margin-top:20px; }
.wv2 .v2-work-orders>.v2-section-head { flex-wrap:wrap; }
.wv2 .v2-work-orders .v2-actions { margin:0; }
.wv2 .v2-order-groups { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr)); align-items:start; gap:14px; }
.wv2 .v2-order-session { background:var(--v-tint); }
.wv2 .v2-order-row { padding-inline-start:28px; }
.wv2 .v2-job .v2-columns { margin-top:7px; }
.wv2 .v2-followup { margin-top:24px; padding-top:15px; border-top:1px solid var(--v-line); }
.wv2 .v2-followup .v2-quiet { padding:0 0 10px; }
.wv2 .v2-followup-list { list-style:none; padding:0; }
.wv2 .v2-followup-list li { padding:12px 0 6px; border-top:1px solid var(--v-soft); overflow-wrap:anywhere; }
.wv2 .v2-followup-list small,.wv2 .v2-period,.wv2 .v2-followup-meta { color:var(--v-muted); font-size:13px; }
.wv2 .v2-followup-meta { display:flex; gap:4px 10px; align-items:baseline; flex-wrap:wrap; }
.wv2 .v2-followup-meta strong { color:var(--v-ink); }
.wv2 .v2-followup-due { color:var(--v-amber); }
.wv2 .v2-followup-quote { margin:5px 0; white-space:pre-wrap; }
.wv2 .v2-period { margin-bottom:10px; }
.wv2 .v2-followup-archive,.wv2 .v2-original { margin-block:12px; }
.wv2 :is(.v2-followup-archive,.v2-original) summary { color:var(--v-muted); cursor:pointer; }
.wv2 .v2-original p { max-height:22vh; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; }
.wv2 .v2-source-turn .v2-bubble { outline:2px solid var(--hub-brand); outline-offset:2px; }
.wv2 .v2-report-body { margin-bottom:16px; overflow-wrap:anywhere; }
.wv2 .v2-report-body .v2-markdown h2 { margin-block:14px 5px; font-size:18px; }
.wv2 .v2-order-original { padding:9px 0; border-block:1px solid var(--v-soft); }
.wv2 .v2-order-original p { margin-block:7px; max-height:42vh; }
.wv2 .v2-staff { max-width:900px; margin:18px 0 36px; }
.wv2 .v2-staff :is(p,small,h2,h3,strong),.wv2 .v2-staff-memory { overflow-wrap:anywhere; }
.wv2 .v2-staff .v2-quiet { padding:10px 14px; }
.wv2 .v2-staff .v2-section-head { flex-wrap:wrap; }
.wv2 .v2-staff .v2-actions { flex-wrap:wrap; }
.wv2 .v2-staff-identity,.wv2 .v2-portrait-preview { display:flex; align-items:center; gap:12px; min-width:0; }
.wv2 .v2-staff-identity .v2-chat-avatar { display:block; flex:none; width:36px; height:36px; }
.wv2 .v2-portrait-preview { margin:10px 0 20px; }
.wv2 .v2-portrait-preview .v2-chat-avatar { width:48px; height:48px; }
.wv2 .v2-portrait-preview>div { display:grid; justify-items:start; }
.wv2 .v2-portrait-choices { display:grid; grid-template-columns:repeat(auto-fit,minmax(70px,1fr)); gap:6px; }
.wv2 .v2-portrait-choices.colors { grid-template-columns:repeat(auto-fit,minmax(54px,1fr)); }
.wv2 .v2-portrait-choices label { position:relative; display:grid; justify-items:center; align-content:center; min-height:60px;
  gap:3px; padding:3px; border:1px solid var(--v-line); border-radius:7px; font-size:13px; color:var(--v-ink); cursor:pointer; }
.wv2 .v2-portrait-choices input[type="radio"] { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; }
.wv2 .v2-portrait-choices label:has(input:checked) { border-color:var(--hub-brand); background:var(--v-leaf); outline:1px solid var(--hub-brand); }
.wv2 .v2-portrait-choices label:has(input:focus-visible) { outline:3px solid var(--hub-brand); outline-offset:2px; }
.wv2 .v2-portrait-choices .v2-chat-avatar { width:30px; height:30px; }
.wv2 .v2-staff-portrait-form .v2-actions { flex-wrap:wrap; }
@container (max-width:740px) { .wv2 .v2-staff-identity .v2-chat-avatar { width:32px; height:32px; } }
.wv2 .v2-staff-section { border-top:1px solid var(--v-line); margin:18px 0; padding-top:14px; }
.wv2 .v2-staff h3 { margin:12px 0 8px; }
.wv2 .v2-staff-brief,.wv2 .v2-staff-memory p { white-space:pre-wrap; }
.wv2 .v2-staff-memory { padding:14px; margin:8px 0; }
.wv2 .v2-staff-memory small,.wv2 .v2-staff small { color:var(--v-muted); }
.wv2 .v2-staff-share { display:grid; justify-items:start; gap:4px; border-top:1px solid var(--v-line); padding-top:10px; margin-top:8px; }
.wv2 .v2-dialog form>div:not([hidden])>label { display:grid; min-width:0; gap:5px; margin-bottom:13px; font-size:14px; font-weight:550; }
.wv2 .v2-settings { max-width:960px; margin:2px 0 28px; }
.wv2 .v2-settings-section { display:grid; grid-template-columns:minmax(160px,1fr) minmax(0,2fr); align-items:start; gap:28px;
  padding:23px 0; border-bottom:1px solid var(--v-line); }
.wv2 .v2-settings-section h2 { font:680 23px/1.5 var(--v-font); letter-spacing:-.035em; }
.wv2 .v2-settings-section>div,.wv2 .v2-settings form,.wv2 .v2-settings label { display:grid; min-width:0; gap:10px; }
.wv2 .v2-settings label { gap:4px; font-size:14px; font-weight:560; }
.wv2 .v2-settings :is(small,.hint) { color:var(--v-muted); font-size:13px; font-weight:400; }
.wv2 .v2-settings :is(.v2-button,.v2-link) { justify-self:start; justify-content:center; text-decoration:none; }
.wv2 .v2-settings a.v2-button { color:var(--v-ink); }
.wv2 .v2-settings .v2-ledger>div { padding:8px 0; }
.wv2 .v2-settings-fold { margin:5px 0; }
.wv2 .v2-settings-fold summary { padding:8px 0; cursor:pointer; font-weight:560; }
.wv2 .v2-settings-fold details { padding-inline:12px; border-inline-start:1px solid var(--v-line); }
.wv2 .v2-settings :is(p,small,li,dd,summary) { overflow-wrap:anywhere; }
.wv2 .v2-addresses { list-style:none; padding:0; font-family:ui-monospace,monospace; font-size:13px; }
.wv2 .v2-settings-feedback { position:sticky; bottom:4px; z-index:1; }
.wv2 .v2-settings-feedback:has(.v2-issue,p) { margin-top:12px; padding:8px 12px; background:var(--v-surface); border:1px solid var(--v-line); border-radius:9px; }
.wv2 .v2-order-outputs { margin:12px 0 20px; }
.wv2 .v2-order-outputs .v2-card { margin-top:8px; }
.wv2 .v2-delivery-ready { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px 20px; padding:14px 16px; background:var(--v-leaf); }
.wv2 .v2-delivery-ready>div { flex:1 1 210px; }
.wv2 .v2-delivery-ready small,.wv2 .v2-delivery-log time { color:var(--v-muted); font-size:13px; }
.wv2 .v2-delivery-latest { padding:12px 16px; }
.wv2 .v2-delivery-log { border-top:1px solid var(--v-soft); padding:8px 16px; }
.wv2 .v2-delivery-log summary { cursor:pointer; color:var(--v-muted); }
.wv2 .v2-delivery-log ul { list-style:none; padding:0; }
.wv2 .v2-delivery-log li { padding:9px 0; border-top:1px solid var(--v-soft); overflow-wrap:anywhere; }
.wv2 .v2-delivery-log li>div { display:flex; align-items:center; flex-wrap:wrap; gap:5px 14px; }
.wv2 .v2-execution { margin-top:24px; padding-top:12px; border-top:1px solid var(--v-line); min-width:0; }
.wv2 .v2-execution>summary { cursor:pointer; font:650 18px/1.5 var(--v-font); }
.wv2 .v2-exec-note { margin:8px 0; color:var(--v-muted); font-size:13px; overflow-wrap:anywhere; }
.wv2 .v2-exec-list { list-style:none; padding:0; margin:6px 0 0; }
.wv2 .v2-exec-row { min-width:0; padding:10px 0; border-top:1px solid var(--v-soft); }
.wv2 .v2-exec-meta { display:flex; flex-wrap:wrap; align-items:baseline; gap:3px 12px; color:var(--v-muted); font-size:13px; }
.wv2 .v2-exec-exit { color:var(--v-ink); font-weight:600; }
.wv2 .v2-exec-row[data-state=failed] .v2-exec-exit { color:var(--v-alert); }
.wv2 .v2-exec-row[data-state=running] .v2-exec-exit { color:var(--v-amber); }
.wv2 :is(.v2-exec-command,.v2-exec-pre,.v2-exec-note code) { font:13px/1.6 "IBM Plex Mono",ui-monospace,monospace; overflow-wrap:anywhere; word-break:break-word; }
.wv2 .v2-exec-command { display:block; margin-top:4px; white-space:pre-wrap; }
.wv2 .v2-exec-more { margin-top:4px; min-width:0; }
.wv2 .v2-exec-more>summary { cursor:pointer; color:var(--v-muted); font-size:13px; }
.wv2 .v2-exec-more>summary .v2-exec-command { display:inline; }
.wv2 .v2-exec-pre { max-width:100%; max-height:40vh; overflow:auto; margin:6px 0 0; padding:8px 10px; white-space:pre-wrap; background:var(--v-tint); border-radius:6px; }
.wv2 .v2-exec-row[data-state=denied] .v2-exec-exit { color:var(--v-muted); }
.wv2 .v2-exec-row[data-state=tier] .v2-exec-exit { font-weight:550; }
.wv2 .v2-decision-badge { padding:0 7px; border:1px solid var(--v-line); border-radius:999px; color:var(--v-muted); font-size:12px; line-height:1.6; white-space:nowrap; }
.wv2 .v2-decision-badge:is([data-decision=allowed],[data-decision=reviewer-allowed]) { color:var(--hub-brand-text); border-color:var(--hub-brand); }
.wv2 .v2-decision-badge:is([data-decision=rejected],[data-decision=reviewer-denied],[data-decision=gate-unavailable]) { color:var(--v-alert); border-color:currentColor; }
.wv2 .v2-decision-badge[data-decision=expired] { color:var(--v-amber); border-color:currentColor; }
.wv2 .v2-tier { margin:14px 0 4px; padding:12px 0; border-block:1px solid var(--v-line); min-width:0; }
.wv2 .v2-tier-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; }
.wv2 .v2-tier-head h2 { font:650 17px/1.5 var(--v-font); }
.wv2 .v2-tier-head small { color:var(--v-muted); font-size:13px; }
.wv2 .v2-tier-options { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
.wv2 .v2-tier-option { min-height:40px; padding:7px 14px; border:1px solid var(--v-line); border-radius:12px; background:var(--v-surface); font-size:14px; font-weight:550; }
.wv2 .v2-tier-option:hover:enabled { background:var(--v-tint); }
.wv2 .v2-tier-option[aria-pressed=true] { color:var(--hub-brand-text); border-color:var(--hub-brand); background:var(--v-leaf); box-shadow:inset 0 0 0 1px var(--hub-brand); }
.wv2 .v2-tier-option:disabled:not([aria-pressed=true]) { color:var(--v-muted); }
.wv2 .v2-approvals { display:grid; gap:12px; margin-top:20px; }
.wv2 .v2-approval { min-width:0; padding:13px 15px; border:1px solid var(--v-line); border-inline-start:3px solid var(--v-amber); border-radius:12px; background:var(--v-surface); }
.wv2 .v2-approval-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:3px 12px; }
.wv2 .v2-approval-head strong { color:var(--v-amber); }
.wv2 .v2-approval-head :is(span,time) { color:var(--v-muted); font-size:13px; }
.wv2 .v2-approval-facts { display:grid; gap:4px; margin:8px 0 10px; font-size:13px; }
.wv2 .v2-approval-facts>div { display:grid; grid-template-columns:44px minmax(0,1fr); gap:8px; }
.wv2 .v2-approval-facts dt { color:var(--v-muted); }
.wv2 .v2-approval-facts dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.wv2 .v2-approval-facts code { font:13px/1.6 "IBM Plex Mono",ui-monospace,monospace; overflow-wrap:anywhere; word-break:break-word; }
.wv2 .v2-approval .v2-actions { gap:10px; }
.wv2 .v2-pending-approvals { min-width:0; margin:0 0 14px; }
.wv2 .v2-pending-approvals>section+section { margin-top:16px; }
.wv2 .v2-home>.v2-pending-approvals { grid-area:3/1/4/-1; margin:0; border-top:1px solid var(--v-line); padding:20px 0 26px; }
.wv2 .v2-pending-approvals .v2-section-head h2 .v2-icon { color:var(--v-amber); }
.wv2 .v2-pending-approvals~.v2-result-inbox,.wv2 .v2-pending-approvals~:is(.v2-history,.v2-today) { grid-row:4; }
.wv2 .v2-pending-approvals~.v2-result-inbox~:is(.v2-history,.v2-today) { grid-row:5; }
.wv2 .v2-ledger { padding:3px 16px; margin:9px 0 12px; }
.wv2 .v2-ledger>div { display:grid; grid-template-columns:74px minmax(0,1fr); gap:8px; padding:11px 0; }
.wv2 .v2-ledger>div+div { border-top:1px solid var(--v-soft); }
.wv2 .v2-ledger dt,.wv2 .v2-decision small { color:var(--v-muted); font-size:13px; }
.wv2 .v2-ledger dd { font-size:14px; overflow-wrap:anywhere; }
.wv2 .v2-decisions { margin-top:21px; }
.wv2 .v2-decision { margin:8px 0; padding:8px 12px; border-inline-start:2px solid var(--v-green); }
.wv2 .v2-issue,.wv2 .v2-source-status,.wv2 .v2-feedback { margin:12px 0; padding:9px 13px; border-inline-start:3px solid var(--v-amber); background:var(--v-tint); overflow-wrap:anywhere; font-size:14px; }
.wv2 .v2-issue { color:var(--v-alert); }
.wv2 .v2-issue button { margin-inline-start:10px; }
.wv2 .v2-feedback { border-color:var(--v-green); }
.wv2 .v2-talk-board { display:grid; grid-template-columns:minmax(210px,.7fr) minmax(0,1.95fr); align-items:start; gap:clamp(22px,3.3cqw,46px); }
.wv2 .v2-talk-board :is(.v2-directory,.v2-reader) { border:0; border-radius:0; background:transparent; }
.wv2 .v2-talk-board[data-compact=true] { display:block; }
.wv2 .v2-directory { position:sticky; top:8px; max-height:75dvh; overflow:auto; }
.wv2 .v2-talk-board[data-compact=true] .v2-directory { position:static; max-height:none; }
.wv2 .v2-directory .v2-section-head { margin:0 0 8px; padding:0 8px; min-height:44px; }
.wv2 .v2-directory .v2-section-head h2 { font-size:16px; }
.wv2 .v2-thread { display:flex; align-items:center; gap:10px; width:100%; padding:13px 15px; text-align:left; }
.wv2 .v2-thread[aria-current] { background:var(--v-leaf); box-shadow:inset 3px 0 var(--hub-brand); }
.wv2 .v2-thread>span:last-child { min-width:0; }
.wv2 .v2-symbol,.wv2 .v2-speaker { display:grid; place-items:center; flex:none; width:34px; height:34px; border:1px solid var(--v-line); border-radius:7px; color:var(--v-green); background:var(--v-surface); }
.wv2 .v2-reader { min-width:0; overflow:clip; }
.wv2 .v2-reader>header { padding:15px 20px; background:var(--v-surface); border-bottom:1px solid var(--v-soft); }
.wv2 .v2-reader>header h2,.wv2 .v2-dialog h2 { font:650 24px/1.4 var(--v-font); overflow-wrap:anywhere; }
.wv2 .v2-chat-context,.wv2 .v2-chat-foot { display:flex; align-items:center; flex-wrap:wrap; gap:4px 14px; }
.wv2 .v2-chat-history { padding:13px 20px; }
.wv2 .v2-turns { display:grid; grid-template-columns:minmax(0,1fr); gap:15px; padding:0; list-style:none; }
.wv2 .v2-date { display:flex; align-items:center; gap:8px; margin:2px 0 14px; color:var(--v-muted); font-size:12px; }
.wv2 .v2-date::before,.wv2 .v2-date::after { content:""; height:1px; flex:1; background:var(--v-soft); }
.wv2 .v2-turn { display:flex; align-items:flex-start; gap:9px; min-width:0; }
.wv2 .v2-turn.mine { flex-direction:row-reverse; }
.wv2 .v2-turn.mine .v2-byline { justify-content:flex-end; }
.wv2 .v2-speaker { width:32px; height:32px; background:var(--v-green); color:var(--v-on); font-size:13px; font-weight:650; }
.wv2 .mine .v2-speaker { background:var(--v-surface); color:var(--v-green); }
.wv2 .v2-message { min-width:0; max-width:min(calc(100% - 46px),55ch); }
.wv2 .v2-byline { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; margin:0 2px 3px; font-size:13px; }
.wv2 .v2-byline strong { min-width:0; overflow-wrap:anywhere; }
.wv2 .v2-byline time { color:var(--v-muted); font-size:12px; font-variant-numeric:tabular-nums; }
.wv2 .v2-bubble { padding:8px 12px; border:1px solid var(--v-soft); border-radius:2px 10px 10px; background:var(--chat-back); font:400 14px/1.7 var(--v-font); }
.wv2 .mine .v2-bubble { border-color:transparent; border-radius:10px 2px 10px 10px; background:var(--chat-own); }
.wv2 .v2-markdown { min-width:0; overflow-wrap:anywhere; }
.wv2 .v2-markdown p,.wv2 .v2-file { white-space:pre-wrap; }
.wv2 .v2-markdown p+p,.wv2 .v2-markdown p+ul,.wv2 .v2-markdown p+ol { margin-top:7px; }
.wv2 .v2-markdown :is(ul,ol) { padding-inline-start:1.5em; }
.wv2 .v2-markdown :is(h1,h2,h3,h4) { font:650 17px/1.5 var(--v-font); margin:5px 0; }
.wv2 .v2-markdown pre,.wv2 .v2-markdown .md-table { display:block; max-width:100%; overflow:auto; }
.wv2 .v2-markdown code,.wv2 .v2-file { font:13px/1.6 "IBM Plex Mono",monospace; overflow-wrap:anywhere; }
.wv2 .v2-markdown a { color:var(--v-green); text-decoration:underline; }
.wv2 .v2-quote { display:block; max-width:100%; margin-bottom:7px; padding:5px 8px; border-inline-start:2px solid var(--v-green); color:var(--v-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; text-align:left; }
.wv2 .v2-attachment { display:flex; margin-top:5px; overflow-wrap:anywhere; }
.wv2 .v2-compose { margin:5px 20px 14px; }
.wv2 .v2-owner-action-reply textarea { min-height:66px; }
.wv2 .v2-compose label,.wv2 .v2-dialog form>label { display:grid; gap:5px; font-size:14px; font-weight:550; }
.wv2 :is(textarea,input:not([type=checkbox]),select) { width:100%; min-width:0; border:1px solid var(--v-line); border-radius:6px; padding:8px 11px; background:var(--v-paper); color:var(--v-ink); font-size:15px; font-weight:400; }
.wv2 textarea { resize:vertical; }
.wv2 .v2-close-chat { margin-inline-start:auto; }
.wv2 .v2-chat-foot { border-top:1px solid var(--v-line); padding:7px 17px; }
.wv2 .v2-chat-foot:empty { display:none; }
.wv2 .v2-dialog { --dialog-inline:22px; --dialog-block:22px; width:min(570px,calc(100% - 32px)); max-height:85dvh;
  margin:auto; padding:0; border:1px solid var(--v-line); border-radius:13px; overflow:hidden;
  background:var(--v-surface); color:var(--v-ink); box-shadow:0 18px 75px #10121A38; font:inherit; }
.wv2 .v2-dialog[open] { display:flex; flex-direction:column; }
.wv2 .v2-dialog::backdrop { background:#14151966; }
.wv2 .v2-dialog>header { flex:none; display:flex; align-items:start; justify-content:space-between; gap:12px;
  padding:var(--dialog-block) var(--dialog-inline) 12px; border-bottom:1px solid var(--v-soft); }
.wv2 .v2-dialog>header>div { min-width:0; }
.wv2 .v2-dialog>header :is(h2,.v2-eyebrow) { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; overflow-wrap:anywhere; }
.wv2 .v2-dialog-body { min-width:0; min-height:0; overflow:auto; overscroll-behavior:contain; margin:0 4px 4px;
  padding:14px calc(var(--dialog-inline) - 4px) calc(var(--dialog-block) - 4px); }
.wv2 .v2-dialog-body:focus-visible { outline-offset:-3px; border-radius:6px; }
.wv2 .v2-dialog .v2-icon-btn { flex:none; display:grid; place-items:center; width:40px; height:40px; border-radius:50%; background:var(--v-tint); color:var(--v-muted); }
.wv2 .v2-dialog form>label,.wv2 .v2-dialog fieldset { margin-bottom:13px; }
.wv2 .v2-dialog fieldset { min-width:0; padding:8px 10px; border:1px solid var(--v-line); border-radius:6px; }
.wv2 .v2-dialog legend { padding:0 4px; font-size:14px; }
.wv2 .v2-check { display:flex; align-items:center; gap:8px; min-height:36px; overflow-wrap:anywhere; }
.wv2 .v2-check input { flex:none; width:18px; height:18px; accent-color:var(--v-green); }
.wv2 .v2-dialog textarea { min-height:72px; }
.wv2 .v2-dialog-body>p,.wv2 .v2-dialog form>p,.wv2 .v2-dialog .v2-rows { margin-bottom:13px; }
.wv2 .v2-dialog iframe { display:block; width:100%; height:min(59dvh,600px); background:#fff; border:1px solid var(--v-line); border-radius:6px; }
.wv2 .v2-working { margin:0 0 7px; color:var(--hub-brand-text); font-size:13px; font-weight:550; }
.wv2 .v2-waiting { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 12px; margin:0 0 7px; padding:7px 11px; border-inline-start:3px solid var(--v-amber); background:var(--v-tint); color:var(--v-ink); font-size:13px; overflow-wrap:anywhere; }
.wv2 .v2-waiting>span { flex:1 1 220px; min-width:0; }
.wv2 .v2-project-directory { margin-top:20px; }
.wv2 .v2-project-directory>.v2-section-head { flex-wrap:wrap; }
.wv2 .v2-project-directory .v2-actions { margin:0; }
.wv2 .v2-project-directory>.v2-quiet { padding:0; }
.wv2 .v2-archived-banner { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; margin-top:16px; padding:11px 15px; border:1px solid var(--v-line); border-inline-start:3px solid var(--v-amber); border-radius:10px; background:var(--v-tint); color:var(--v-ink); overflow-wrap:anywhere; }
.wv2 .v2-archived-banner>div { flex:1 1 240px; min-width:0; }
.wv2 .v2-archived-banner strong { display:block; color:var(--v-amber); font-weight:650; }
.wv2 .v2-archived-banner small { display:block; margin-top:2px; color:var(--v-muted); font-size:13px; }
.wv2 .v2-archived-banner>.v2-button { flex:none; }
.wv2 .v2-archived-banner>.v2-issue { flex-basis:100%; margin:0; }
.wv2 .v2-archived-spaces { margin-bottom:13px; border-top:1px solid var(--v-soft); }
.wv2 .v2-archived-spaces>summary { display:flex; align-items:center; min-height:44px; cursor:pointer; color:var(--v-muted); font-weight:560; }
.wv2 .v2-archived-spaces[open]>summary { color:var(--v-ink); }
.wv2 .v2-archive-workspace { margin-top:28px; padding-top:10px; border-top:1px solid var(--v-soft); }
.wv2 .v2-archive-workspace>.v2-link { color:var(--v-muted); font-size:13px; }
.wv2 .v2-reader>.v2-archived-note { padding:10px 16px; border-top:1px solid var(--v-soft); }
.wv2 .v2-directory-path { margin:6px 0 4px; font-size:14px; overflow-wrap:anywhere; }
.wv2 .v2-directory-path code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; overflow-wrap:anywhere; word-break:break-all; }
.wv2 .v2-directory-form { display:grid; gap:8px; }
.wv2 .v2-directory-form input { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.wv2 .v2-directory-form small { color:var(--v-muted); font-size:13px; }
.wv2 .v2-path-field { display:grid; gap:4px; min-width:0; }
.wv2 .v2-dialog .v2-directory-form>.v2-path-field>label { margin-bottom:0; }
/* In the flow under the field: the dialog body scrolls (and would clip a floating menu), so the menu pushes the rest down. */
.wv2 .v2-path-menu { max-height:min(272px,40dvh); overflow:auto; overscroll-behavior:contain; padding:4px; border:1px solid var(--v-line); border-radius:10px;
  background:var(--v-surface); box-shadow:0 10px 32px #10121A29; }
.wv2 .v2-path-menu[hidden] { display:none; }
.wv2 .v2-path-menu ul { margin:0; padding:0; list-style:none; }
.wv2 .v2-path-menu li { display:grid; gap:1px; min-height:36px; padding:5px 9px; border-radius:7px; cursor:pointer; min-width:0; }
.wv2 .v2-path-menu li:hover { background:var(--v-tint); }
.wv2 .v2-path-menu li[aria-selected=true] { background:var(--v-leaf); box-shadow:inset 3px 0 var(--hub-brand); }
.wv2 .v2-path-menu li strong { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.wv2 .v2-path-menu li span { color:var(--v-muted); font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; word-break:break-all; }
.wv2 .v2-path-menu li[data-bindable=false] strong { color:var(--v-muted); font-weight:500; }
.wv2 .v2-path-menu li small { font-size:12px; }
.wv2 .v2-path-note { margin:0; padding:7px 9px; color:var(--v-muted); font-size:13px; overflow-wrap:anywhere; }
.wv2 .v2-delivery-note { display:block; margin:3px 2px 0; color:var(--v-muted); font-size:12px; }
.wv2 .v2-relay-note { display:block; margin-bottom:4px; color:var(--v-muted); font-size:12px; }
.wv2 .v2-relay-quote { margin-top:8px; padding-top:6px; border-top:1px solid var(--v-soft); }
.wv2 .v2-relay-quote summary { cursor:pointer; color:var(--hub-brand-text); font-size:13px; font-weight:550; min-height:28px; }
.wv2 .v2-relay-text { margin-top:6px; padding:6px 10px; border-inline-start:2px solid var(--v-line); color:var(--v-ink); white-space:pre-wrap; overflow-wrap:anywhere; }
.wv2 .mine .v2-delivery-note { text-align:end; }
.wv2 .v2-delivery-note[data-delivery=queued] { color:var(--v-amber); }
.wv2 .v2-delivery-note[data-delivery=unsent] { color:var(--v-alert); }
.wv2 .v2-group-delivery [data-outcome=queued] { color:var(--v-amber); }
.wv2 .v2-held-note[data-held=choosing] { color:var(--v-amber); }
.wv2 .v2-choices { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:8px; }
.wv2 .v2-choices .v2-button { min-height:40px; padding:6px 14px; font-size:13px; }
.wv2 .v2-choices>small { color:var(--v-muted); font-size:12px; }
.wv2 .v2-choices>.v2-issue { flex-basis:100%; }
.wv2 .v2-choice-done { display:flex; align-items:center; gap:4px; margin:6px 2px 0; color:var(--v-muted); font-size:12px; }
.wv2 .v2-choice-done .v2-icon { width:12px; height:12px; }
.wv2 .v2-next[data-state=done] { color:var(--v-muted); }
.wv2 .v2-order-layout { display:grid; grid-template-columns:minmax(0,1fr); gap:clamp(20px,2.6cqw,36px); align-items:start; margin-top:12px; }
.wv2 .v2-order-page[data-wide=true] .v2-order-layout { grid-template-columns:minmax(0,1.75fr) minmax(300px,1fr); }
.wv2 :is(.v2-order-chat,.v2-order-info,.v2-order-details,.v2-order-fold) { min-width:0; }
.wv2 .v2-order-chat .v2-reader { border:1px solid var(--v-line); border-radius:12px; background:var(--v-surface); }
.wv2 .v2-order-info { border-inline-start:1px solid var(--v-soft); padding-inline-start:clamp(16px,2cqw,26px); }
.wv2 .v2-order-info>h2 { font:680 20px/1.5 var(--v-font); letter-spacing:-.02em; margin-bottom:6px; }
.wv2 .v2-order-details>*+* { margin-top:18px; }
.wv2 .v2-order-details h3 { font:650 16px/1.5 var(--v-font); overflow-wrap:anywhere; }
.wv2 .v2-order-details :is(.v2-section-head h2,.v2-job h2) { font-size:17px; }
.wv2 .v2-order-details .v2-ledger>div { grid-template-columns:70px minmax(0,1fr); }
.wv2 .v2-order-fold { margin-top:10px; border:1px solid var(--v-line); border-radius:12px; padding:0 14px; background:var(--v-surface); }
.wv2 .v2-order-fold>summary { display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 10px; padding:11px 0; cursor:pointer; font-weight:650; }
.wv2 .v2-order-fold>summary small { color:var(--v-muted); font-size:13px; font-weight:500; }
.wv2 .v2-order-fold[open] { padding-bottom:14px; }
.wv2 .v2-order-page>.v2-execution-block { margin-top:10px; }
.wv2 .v2-chat-avatar.v2-avatar-mini { display:inline-block; flex:none; width:18px; height:18px; vertical-align:-4px; }
.wv2 .v2-group-roster { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:6px; padding:0; list-style:none; color:var(--v-muted); font-size:13px; }
.wv2 .v2-group-roster li { display:inline-flex; align-items:center; gap:5px; min-width:0; }
.wv2 .v2-group-roster li>span:not(.v2-member-badge) { color:var(--v-ink); overflow-wrap:anywhere; }
.wv2 .v2-member-badge { display:inline-flex; align-items:center; padding:0 7px; border:1px solid var(--v-line); border-radius:999px; color:var(--v-muted); font-size:11px; font-weight:550; line-height:18px; white-space:nowrap; }
.wv2 .v2-member-badge[data-badge=admin] { border-color:transparent; background:var(--v-leaf); color:var(--hub-brand-text); }
.wv2 .v2-mention { display:inline-flex; align-items:center; gap:3px; max-width:100%; margin:0 1px; padding:0 7px 0 3px; border-radius:999px; background:var(--v-leaf); color:var(--hub-brand-text); font-weight:600; line-height:1.55; vertical-align:baseline; overflow-wrap:anywhere; }
.wv2 .mine .v2-mention { background:var(--v-surface); }
.wv2 .v2-mention .v2-avatar-mini { width:16px; height:16px; }
.wv2 .v2-mention .v2-icon { width:14px; height:14px; }
.wv2 .v2-turn.progress .v2-bubble { border-style:dashed; background:transparent; color:var(--v-muted); }
.wv2 .v2-progress-tag { color:var(--v-muted); font-size:12px; }
.wv2 .v2-group-event p { display:flex; flex-wrap:wrap; justify-content:center; gap:2px 8px; max-width:62ch; margin:0 auto; color:var(--v-muted); font-size:12px; line-height:1.6; text-align:center; overflow-wrap:anywhere; }
.wv2 .v2-group-event time { flex:none; font-variant-numeric:tabular-nums; }
.wv2 .v2-group-event:is([data-event=paused],[data-event=failed],[data-event=missed]) p { color:var(--v-amber); }
.wv2 .v2-group-event .v2-order-tag { display:flex; margin:0 auto; }
.wv2 .v2-order-tag { min-height:28px; gap:4px; color:var(--v-muted); font-size:12px; overflow-wrap:anywhere; }
.wv2 .v2-order-tag .v2-icon { width:13px; height:13px; }
.wv2 .v2-mention-field { position:relative; }
.wv2 .v2-mention-menu { position:absolute; z-index:3; bottom:calc(100% + 4px); inset-inline-start:0; width:min(100%,420px); max-height:min(272px,45dvh); overflow:auto; overscroll-behavior:contain;
  margin:0; padding:4px; list-style:none; border:1px solid var(--v-line); border-radius:10px; background:var(--v-surface); box-shadow:0 10px 32px #10121A29; }
.wv2 .v2-mention-menu li { display:flex; align-items:center; gap:9px; min-height:44px; padding:5px 9px; border-radius:7px; cursor:pointer; }
.wv2 .v2-mention-menu li:hover { background:var(--v-tint); }
.wv2 .v2-mention-menu li[aria-selected=true] { background:var(--v-leaf); box-shadow:inset 3px 0 var(--hub-brand); }
.wv2 .v2-mention-menu .v2-avatar-mini { width:28px; height:28px; }
.wv2 .v2-mention-all { display:grid; place-items:center; flex:none; width:28px; height:28px; border-radius:50%; background:var(--v-tint); color:var(--hub-brand-text); }
.wv2 .v2-mention-option { display:flex; flex-wrap:wrap; align-items:center; gap:1px 6px; min-width:0; }
.wv2 .v2-mention-option strong { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.wv2 .v2-mention-option small { flex-basis:100%; min-width:0; color:var(--v-muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wv2 .v2-mention-option small:empty { display:none; }
.wv2 .v2-group-state { display:grid; gap:8px; margin-bottom:8px; }
.wv2 .v2-group-state:empty { display:none; }
.wv2 .v2-group-paused { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 10px; padding:7px 11px; border-inline-start:3px solid var(--v-amber); background:var(--v-tint); font-size:13px; overflow-wrap:anywhere; }
.wv2 .v2-group-paused strong { color:var(--v-amber); }
.wv2 .v2-group-paused span { flex:1 1 220px; min-width:0; }
.wv2 .v2-group-paused small { color:var(--v-muted); font-size:12px; }
.wv2 .v2-group-approvals { margin-top:0; }
.wv2 .v2-group-status { min-width:0; border:1px solid var(--v-line); border-radius:14px; background:var(--v-surface); }
.wv2 .v2-group-status>summary { display:flex; flex-wrap:wrap; align-items:center; gap:4px 12px; min-height:40px; padding:6px 13px; list-style:none; cursor:pointer; }
.wv2 .v2-group-status>summary::-webkit-details-marker { display:none; }
.wv2 .v2-group-status[open] { padding-bottom:10px; }
.wv2 .v2-capsule { display:flex; flex-wrap:wrap; gap:4px 14px; min-width:0; }
.wv2 .v2-capsule-member { display:inline-flex; align-items:center; gap:5px; min-width:0; font-size:13px; font-weight:600; overflow-wrap:anywhere; }
.wv2 .v2-capsule-member small,.wv2 .v2-busy-state { color:var(--hub-brand-text); font-size:12px; font-weight:500; }
.wv2 :is(.v2-capsule-member,.v2-busy-list li)[data-status=approval] :is(small,.v2-busy-state) { color:var(--v-amber); font-weight:600; }
.wv2 :is(.v2-capsule-member,.v2-busy-list li):is([data-status=queued],[data-status=missed]) :is(small,.v2-busy-state) { color:var(--v-muted); }
.wv2 .v2-capsule-hint { margin-inline-start:auto; color:var(--v-muted); font-size:12px; }
.wv2 .v2-busy-list { margin:0 13px; padding:0; list-style:none; border-top:1px solid var(--v-soft); }
.wv2 .v2-busy-list li { display:flex; align-items:center; gap:9px; padding:8px 0; border-bottom:1px solid var(--v-soft); }
.wv2 .v2-busy-list .v2-avatar-mini { width:24px; height:24px; }
.wv2 .v2-busy-list li>div { display:flex; flex:1; flex-wrap:wrap; align-items:baseline; gap:0 8px; min-width:0; }
.wv2 .v2-busy-list li>div strong { font-size:14px; overflow-wrap:anywhere; }
.wv2 .v2-busy-list li>div small { flex-basis:100%; min-width:0; color:var(--v-muted); font-size:12px; overflow-wrap:anywhere; }
.wv2 .v2-busy-list .v2-button { flex:none; min-height:36px; padding:4px 12px; font-size:13px; }
.wv2 .v2-busy-list li>div small.v2-busy-tool code { font-size:12px; overflow-wrap:anywhere; }
.wv2 .v2-busy-list li>div small.v2-busy-progress { color:var(--v-ink); }
.wv2 .v2-exec-member h3 { display:flex; align-items:baseline; gap:8px; margin:10px 0 0; font-size:14px; }
.wv2 .v2-exec-member h3 small { color:var(--v-muted); font-size:12px; font-weight:400; }
.wv2 .v2-group-status>.v2-actions { justify-content:flex-end; margin:8px 13px 0; }
.wv2 .v2-group-status>.v2-issue { margin:6px 13px 0; }
@container(min-width:741px) and (max-width:940px) {
  .wv2 .v2-bound { width:calc(100% - 60px); }
  .wv2 .v2-mast>.v2-bound { width:calc(100% - 42px); gap:18px; }
  .wv2 .v2-primary-nav { gap:12px; }
}
@container(max-width:740px) {
  .wv2 .v2-bound,.wv2 .v2-mast>.v2-bound { width:calc(100% - 36px); }
  .wv2 .v2-mast>.v2-bound { min-height:57px; gap:8px; }
  .wv2 .v2-brand { font-size:21px; gap:6px; }
  .wv2 .v2-brand img { width:23px; height:26px; }
  .wv2 .v2-wide { display:none; }
  .wv2 .v2-mast-actions { margin-inline-start:auto; gap:8px; }
  .wv2 .v2-mast-actions .v2-button { padding:6px 9px; font-size:13px; }
  .wv2 .v2-primary-nav { margin:0; position:absolute; z-index:2; inset:auto 0 0; gap:0; min-height:55px; padding-bottom:env(safe-area-inset-bottom); background:var(--v-surface); border-top:1px solid var(--v-line); }
  .wv2 .v2-primary-nav button { flex:1; padding:9px 3px; }
  .wv2 .v2-primary-nav button[aria-current]::after { content:""; position:absolute; inset:0 calc(50% - 9.5px) auto; height:2px; border-radius:2px; background:var(--hub-brand); }
  .wv2 .v2-page { margin-bottom:calc(55px + env(safe-area-inset-bottom)); padding-bottom:18px; scrollbar-gutter:auto; }
  .wv2 .v2-hero { padding:17px 0 13px; align-items:start; flex-wrap:wrap; gap:8px 14px; }
  .wv2 .v2-hero h1 { font-size:35px; }
  .wv2 .v2-hero .v2-button { margin-inline-start:auto; }
  .wv2 .v2-home { grid-template-columns:minmax(0,1fr) minmax(0,.92fr); column-gap:6px; }
  .wv2 .v2-home>.v2-hero>div:first-child { padding-top:9px; }
  .wv2 .v2-home .v2-eyebrow { font-size:12px; letter-spacing:0; }
  .wv2 .v2-home .v2-hero h1 { margin:6px 0 0; font-size:clamp(42px,10cqw,60px); }
  .wv2 .v2-home .v2-transfer { grid-area:2/1; align-self:start; justify-self:start; margin-inline-start:-7px; padding:0; }
  .wv2 .v2-home-emblem { height:clamp(144px,42cqw,225px); margin:3px 0 4px; padding:0; }
  .wv2 .v2-liaison-card { grid-area:3/1/4/-1; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; padding:6px 0 23px; }
  .wv2 .v2-liaison-card h2 { font-size:18px; }
  .wv2 .v2-liaison-card p { margin-top:3px; font-size:14px; line-height:1.55; }
  .wv2 .v2-liaison-card .v2-button { min-height:44px; padding:6px 12px; gap:6px; }
  .wv2 .v2-home>.v2-history,.wv2 .v2-home>.v2-today { grid-column:1/-1; padding:15px 0 16px; }
  .wv2 .v2-home>.v2-history { grid-row:4; }
  .wv2 .v2-home>.v2-today { grid-row:5; }
  .wv2 .v2-home>.v2-result-inbox { grid-row:4; padding:14px 0 16px; }
  .wv2 .v2-result-inbox~.v2-history { grid-row:5; }
  .wv2 .v2-result-inbox~.v2-today { grid-row:6; }
  .wv2 .v2-home>.v2-pending-approvals { grid-row:4; padding:14px 0 16px; }
  .wv2 .v2-pending-approvals~.v2-result-inbox,.wv2 .v2-pending-approvals~.v2-history { grid-row:5; }
  .wv2 .v2-pending-approvals~.v2-today,.wv2 .v2-pending-approvals~.v2-result-inbox~.v2-history { grid-row:6; }
  .wv2 .v2-pending-approvals~.v2-result-inbox~.v2-today { grid-row:7; }
  .wv2 .v2-tier-option { flex:1 1 0; min-height:44px; padding:6px 8px; }
  .wv2 .v2-section-head h2,.wv2 .v2-job h2 { font-size:20px; }
  .wv2 .v2-settings-section { grid-template-columns:minmax(0,1fr); gap:8px; padding:17px 0; }
  .wv2 .v2-settings-section h2 { font-size:20px; }
  .wv2 .v2-home .v2-row-title strong { font-size:16px; }
  .wv2 .v2-space-card { padding:10px 2px; }
  .wv2 .v2-people { margin-block:15px; }
  .wv2 .v2-people-tools { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 12px; }
  .wv2 .v2-people-search { grid-column:1 / -1; }
  .wv2 .v2-people-tools :is(input,select) { min-height:44px; }
  .wv2 .v2-columns { grid-template-columns:minmax(0,1fr); gap:19px; }
  .wv2 .v2-columns,.wv2 .v2-talk-board,.wv2 .v2-today { margin-top:15px; }
  .wv2 .v2-page.reading .v2-hero,.wv2 .v2-page.reading .v2-subnav,.wv2 .v2-page.reading .v2-archived-banner { display:none; }
  .wv2 .v2-reader>header,.wv2 .v2-chat-history { padding:10px 12px; }
  .wv2 .v2-reader>header { position:sticky; top:0; z-index:1; }
  .wv2 .v2-reader>header h2 { font-size:21px; }
  .wv2 .v2-compose { margin-inline:12px; }
  .wv2 .v2-turn { gap:7px; }
  .wv2 .v2-speaker { width:27px; height:29px; }
  .wv2 .v2-message { max-width:min(calc(100% - 39px),55ch); }
  .wv2 .v2-bubble { padding:7px 9px; }
  .wv2 .v2-link,.wv2 .v2-button,.wv2 .v2-quote,.wv2 .v2-check { min-height:44px; }
  .wv2 :is(input:not([type=checkbox]),textarea,select) { font-size:16px; }
  .wv2 .v2-chat-context { justify-content:space-between; }
  .wv2 .v2-group-roster { flex-wrap:nowrap; overflow-x:auto; scrollbar-width:none; padding-bottom:2px; }
  .wv2 .v2-group-roster li { flex:none; }
  .wv2 .v2-mention-menu { width:100%; }
  .wv2 .v2-capsule-hint { margin-inline-start:0; flex-basis:100%; }
  .wv2 .v2-busy-list .v2-button { min-height:44px; }
}
@media(max-width:700px) {
  .wv2 .v2-dialog { --dialog-inline:18px; --dialog-block:17px; width:calc(100% - 24px); max-width:none;
    max-height:calc(90dvh - env(safe-area-inset-bottom)); margin:auto auto calc(12px + env(safe-area-inset-bottom)); }
  .wv2 .v2-dialog .v2-icon-btn { width:44px; height:44px; }
  .wv2 .v2-path-menu li { min-height:44px; align-content:center; }
  .wv2 .v2-archived-banner { padding:10px 12px; }
  .wv2 .v2-archived-banner>.v2-button { flex:1 1 100%; min-height:44px; }
  .wv2 .v2-archive-workspace>.v2-link { min-height:44px; }
}
${CHAT_ATTACHMENT_STYLE}
`
