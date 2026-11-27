export const CHAT_ATTACHMENT_STYLE = `
:is(.wv2,.wr) .chat-composer { display:grid; grid-template-columns:minmax(0,1fr); gap:3px; min-width:0; padding:8px;
  border:1px solid var(--v-line,var(--rule)); border-radius:20px; background:var(--v-surface,var(--bg)); }
:is(.wv2,.wr) .chat-composer:focus-within { border-color:var(--hub-brand,var(--tide)); }
:is(.wv2,.wr) .chat-composer:has(> textarea:focus-visible) { outline:3px solid color-mix(in srgb,var(--hub-brand,var(--tide)) 27%,transparent); outline-offset:2px; }
:is(.wv2,.wr) .chat-composer > textarea { display:block; width:100%; min-height:38px; max-height:148px; field-sizing:content;
  padding:8px 9px 4px; border:0; border-radius:0; background:transparent; color:inherit; font-size:15px; line-height:1.55; resize:none; }
:is(.wv2,.wr) .chat-composer > textarea::placeholder { color:var(--v-muted,var(--dim)); }
:is(.wv2,.wr) .chat-composer > textarea:focus-visible { outline:none; }
:is(.wv2,.wr) .chat-composer .v2-send-footer { display:flex; align-items:center; gap:8px; min-width:0; }
:is(.wv2,.wr) .chat-composer-status { flex:1; min-width:0; color:var(--v-muted,var(--dim)); font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
:is(.wv2,.wr) .chat-composer :is(.chat-attachment-picker,.chat-composer-send) { display:grid; place-items:center; flex:none; width:40px; height:40px;
  min-height:40px; padding:0; border:1px solid transparent; border-radius:50%; }
:is(.wv2,.wr) .chat-composer .chat-attachment-picker { border-color:var(--v-line,var(--rule)); color:var(--v-ink,var(--paper)); background:transparent; }
:is(.wv2,.wr) .chat-composer .chat-attachment-picker:not(:disabled):hover { background:var(--v-tint,var(--raise)); }
:is(.wv2,.wr) .chat-composer .chat-attachment-picker:disabled { opacity:.5; }
:is(.wv2,.wr) .chat-composer .chat-composer-send { color:var(--hub-action-text,var(--on-ink)); background:var(--hub-action,var(--ink)); }
:is(.wv2,.wr) .chat-composer .chat-composer-send:disabled { color:var(--v-muted,var(--dim)); background:var(--v-tint,var(--board)); opacity:1; }
:is(.wv2,.wr) .chat-composer .chat-composer-send:not(:disabled):hover { filter:brightness(.9); }
:is(.wv2,.wr) .chat-composer :is(.chat-attachment-picker,.chat-composer-send) .v2-icon { width:21px; height:21px; }
:is(.wv2,.wr) .chat-composer-spinner { width:15px; height:15px; border:1.5px solid currentColor; border-inline-end-color:transparent; border-radius:50%; }
@media (prefers-reduced-motion:no-preference) { .chat-composer-spinner { animation:chat-composer-spin .65s linear infinite; } }
@keyframes chat-composer-spin { to { transform:rotate(1turn); } }

:is(.wv2,.wr) .chat-selected-files { display:flex; gap:7px; min-width:0; overflow-x:auto; overscroll-behavior-inline:contain; scrollbar-width:thin;
  list-style:none; padding:3px 4px 6px; margin:0; }
:is(.wv2,.wr) .chat-selected-files > li { display:flex; flex:none; align-items:center; gap:7px; width:min(220px,100%); min-width:0;
  padding:5px 4px 5px 6px; border:1px solid var(--v-soft,var(--rule)); border-radius:12px; background:var(--v-tint,var(--board)); }
:is(.wv2,.wr) .chat-selected-files > li[data-failed] { width:min(320px,100%); }
:is(.wv2,.wr) .chat-file-detail { display:grid; flex:1; min-width:0; line-height:1.4; overflow-wrap:anywhere; }
:is(.wv2,.wr) .chat-file-detail strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:600; }
:is(.wv2,.wr) :is(.chat-file-detail,.chat-input-files) small { color:var(--v-muted,var(--dim)); font-size:12px; }
:is(.wv2,.wr) .chat-selected-files li[data-failed] small { color:var(--v-alert,var(--lamp-r)); }
:is(.wv2,.wr) .chat-selected-files :is(img,.chat-file-icon) { flex:none; width:38px; height:38px; object-fit:cover; border-radius:8px; }
:is(.wv2,.wr) .chat-file-icon { display:grid; place-items:center; color:var(--hub-brand-text,var(--tide)); background:var(--v-leaf,var(--tide-bg)); }
:is(.wv2,.wr) .chat-selected-files :is(.chat-file-remove,.chat-file-retry) { display:grid; place-items:center; flex:none; min-width:34px; min-height:38px;
  padding:0 4px; border:0; border-radius:8px; color:var(--v-muted,var(--dim)); background:transparent; font-size:12px; }
:is(.wv2,.wr) .chat-selected-files :is(.chat-file-remove,.chat-file-retry):enabled:hover { background:var(--v-soft,var(--raise)); }
:is(.wv2,.wr) :is(.chat-selected-files,.chat-input-files) .v2-icon { flex:none; width:17px; height:17px; }
:is(.wv2,.wr) .chat-selected-files > li[data-thumbnail] { position:relative; width:68px; height:68px; padding:0; }
:is(.wv2,.wr) .chat-selected-files > li[data-thumbnail] img { width:100%; height:100%; border-radius:inherit; }
:is(.wv2,.wr) .chat-thumbnail-status { position:absolute; inset:auto 3px 3px; padding:2px 0; border-radius:7px; text-align:center;
  white-space:nowrap; color:var(--v-ink,var(--paper)); background:var(--v-surface,var(--bg)); font-size:11px; }
:is(.wv2,.wr) .chat-selected-files > li[data-thumbnail] .chat-file-remove { position:absolute; inset:0 0 auto auto; display:flex;
  align-items:flex-start; justify-content:flex-end; padding:4px; background:transparent; }
:is(.wv2,.wr) .chat-selected-files > li[data-thumbnail] .chat-file-remove .v2-icon { width:21px; height:21px; padding:3px; border-radius:50%;
  background:var(--v-surface,var(--bg)); color:var(--v-ink,var(--paper)); }

:is(.wv2,.wr) .chat-input-files { display:flex; flex-wrap:wrap; gap:5px; list-style:none; padding:0; margin:6px 0 0; }
:is(.wv2,.wr) .chat-input-files > li { flex-basis:100%; min-width:0; }
:is(.wv2,.wr) .chat-input-files > li[data-image] { flex-basis:140px; }
:is(.wv2,.wr) .chat-input-files a { display:flex; align-items:center; gap:7px; min-height:38px; max-width:100%; color:inherit; text-decoration:underline; text-underline-offset:3px; }
:is(.wv2,.wr) .chat-input-files > li[data-image] a { display:block; overflow:hidden; border:1px solid var(--v-soft,var(--rule));
  border-radius:12px; background:var(--v-tint,var(--board)); }
:is(.wv2,.wr) .chat-input-files > li[data-image] a:hover { border-color:var(--hub-brand,var(--tide)); }
:is(.wv2,.wr) .chat-input-files a span { min-width:0; overflow-wrap:anywhere; }
:is(.wv2,.wr) .chat-input-files img { display:block; width:100%; aspect-ratio:4 / 3; object-fit:contain; }
:is(.wv2,.wr) .chat-input-files small { flex:none; }
.wv2 .v2-group-delivery [data-outcome=failed] { color:var(--v-alert); }
@container (max-width:740px) {
  .wv2 .chat-composer > textarea { font-size:16px; }
  .wv2 .chat-composer :is(.chat-attachment-picker,.chat-composer-send) { width:44px; height:44px; min-height:44px; }
  .wv2 .chat-selected-files > li:not([data-thumbnail],[data-failed]) { width:min(184px,70%); }
  .wv2 .chat-selected-files :is(.chat-file-remove,.chat-file-retry) { min-width:44px; min-height:44px; }
  .wv2 .chat-input-files a { min-height:44px; }
}
@media (max-width:860px) {
  .wr .chat-composer > textarea { font-size:16px; }
  .wr .chat-composer :is(.chat-attachment-picker,.chat-composer-send) { width:44px; height:44px; min-height:44px; }
  .wr .chat-selected-files > li:not([data-thumbnail],[data-failed]) { width:min(184px,70%); }
  .wr .chat-selected-files :is(.chat-file-remove,.chat-file-retry) { min-width:44px; min-height:44px; }
  .wr .chat-input-files a { min-height:44px; }
}
`
