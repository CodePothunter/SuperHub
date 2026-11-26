import { useState } from 'react'
import type { V2Delegation, V2Session } from '../core/workspace-v2.ts'
import { segment, useV2Read } from './workspace-v2-api.ts'
import { Issue, readableTime, V2Icon } from './workspace-v2-elements.tsx'
import { isOrderOutputs } from './workspace-v2-response.ts'
import { V2AttachmentDialog } from './workspace-v2-talk.tsx'
import { attachmentResource, outputSourceKey } from './workspace-output-source.ts'
import { OutputSourceAction } from './workspace-outputs.tsx'

/** The files an order's conversations delivered (its 「交付成果」). */
export function OrderOutputs({ base, job, sessions, openSource }: {
  base: string; job: V2Delegation; sessions: V2Session[]; openSource?: (sessionId: string, messageId: string, trace?: string) => void
}) {
  const path = base + '/orders/' + segment(job.id)
  const active = job.status === 'active' && !job.paused && !job.sessionDeletedAt
  const query = useV2Read(path + '/outputs', isOrderOutputs, active ? 4000 : undefined, JSON.stringify([job.remainingTurns, job.sessionDeletedAt]))
  const [file, setFile] = useState<string>()
  const outputs = (query.data?.outputs ?? []).filter(row => sessions.some(session => session.id === row.sessionId)
    || row.sessionDeletedAt && (row.sessionId === job.sessionId || job.historySessionIds?.includes(row.sessionId)))
  const selected = outputs.find(row => outputSourceKey(row) === file)
  return <>
    <Issue text={query.error} retry={query.refresh}/>
    {outputs.length > 0 && <section aria-label="交付成果" className="v2-order-outputs">
      <div className="v2-section-head"><h2><V2Icon name="box"/>交付成果</h2></div>
      <div className="v2-card">{outputs.map(row => <button type="button" className="v2-row" key={outputSourceKey(row)}
        onClick={() => setFile(outputSourceKey(row))}>
        <span className="v2-row-title"><strong>{row.attachment.label}</strong><V2Icon name="next"/></span>
        {row.at && <small>{readableTime(row.at)}</small>}</button>)}</div>
    </section>}
    {selected && <V2AttachmentDialog path={attachmentResource(base, selected)} reference={selected.attachment}
      context={sessions.find(s => s.id === selected.sessionId)?.title ?? job.title} close={() => setFile(undefined)}
      actions={<div className="v2-actions"><OutputSourceAction row={selected} open={openSource && (source => {
        setFile(undefined)
        openSource(source.sessionId, source.messageId, source.traceId)
      })}/></div>}/>}
  </>
}
