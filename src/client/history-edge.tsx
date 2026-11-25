/** 对话列表两头的状态行：顶部（更早的消息）与底部（没接到最新时）。哨兵就是状态行本身。 */
import type { RefObject } from 'react'
import { PAGE_SIZE } from './paged-history.ts'

export const historyEdgeStyle = `
/* One height in every state (loading, retry, start), so a change of state does not move the messages below. */
.wv2 .v2-history-edge { display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:0 8px; min-height:32px; margin:2px 0 6px;
  color:var(--v-muted); font-size:13px; line-height:19px; text-align:center; }
.wv2 .v2-history-edge:empty { min-height:1px; margin:0; }
.wv2 .v2-history-edge .v2-link { min-height:32px; padding-block:0; font-size:13px; line-height:19px; color:var(--hub-brand-text); }
@container(max-width:740px) {
  .wv2 .v2-history-edge:not(:empty),.wv2 .v2-history-edge .v2-link { min-height:44px; }
}
.wv2 .v2-history-sentinel { height:1px; }
.wv2 .v2-pending-elsewhere { margin:6px 0 10px; padding:10px 12px; border:1px solid var(--v-line); border-radius:12px; background:var(--v-surface); }
.wv2 .v2-pending-elsewhere h3 { margin:0 0 4px; font-size:14px; font-weight:650; }
.wv2 .v2-pending-item+.v2-pending-item { margin-top:8px; padding-top:8px; border-top:1px solid var(--v-soft); }
.wv2 .v2-pending-source { margin:0; color:var(--v-muted); font-size:13px; overflow-wrap:anywhere; }
.wv2 .v2-history-edge.newer { position:sticky; bottom:0; z-index:1; }
.wv2 .v2-history-edge.newer .v2-button { min-height:34px; padding:4px 14px; border-radius:999px; box-shadow:0 2px 8px rgb(0 0 0 / .12); }
`

export function OlderEdge({ edge, hasOlder, loading, error, count, load }: {
  edge: RefObject<HTMLDivElement | null>; hasOlder: boolean; loading: boolean; error?: string; count: number; load: () => void
}) {
  return <div ref={edge} className="v2-history-edge older" aria-live="polite" data-history-edge="older">
    {loading ? <span role="status">正在加载更早的消息…</span>
      : error ? <><span>没能加载更早的消息</span><button type="button" className="v2-link" onClick={load}>重试</button></>
      : hasOlder ? <button type="button" className="v2-link" onClick={load}>加载更早的消息</button>
      // 只有一页都不到的短对话不提示“到最早”。
      : count >= PAGE_SIZE ? <span>已经到最早的消息</span> : null}
  </div>
}

export function NewerEdge({ edge, hasNewer, loading, error, load, latest }: {
  edge: RefObject<HTMLDivElement | null>; hasNewer: boolean; loading: boolean; error?: string; load: () => void; latest: () => void
}) {
  if (!hasNewer) return null
  // 哨兵不能是吸底的那一行：吸底的元素总在视口里，会不停触发加载。
  return <>
    <div ref={edge} className="v2-history-sentinel" aria-hidden="true"/>
    <div className="v2-history-edge newer" aria-live="polite" data-history-edge="newer">
      {loading ? <span role="status">正在加载更新的消息…</span>
        : error ? <><span>没能加载更新的消息</span><button type="button" className="v2-link" onClick={load}>重试</button></> : null}
      <button type="button" className="v2-button" onClick={latest}>跳到最新</button>
    </div>
  </>
}
