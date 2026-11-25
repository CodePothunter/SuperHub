import { useState } from 'react'
import type { V2Delegation, V2Session } from '../core/workspace-v2.ts'
import { segment, useV2Read } from './workspace-v2-api.ts'
import { Issue, V2Icon } from './workspace-v2-elements.tsx'
import { isOrderOutputs } from './workspace-v2-response.ts'
import { V2AttachmentDialog } from './workspace-v2-talk.tsx'

/** The files an order's conversations delivered (its 「交付成果」). */
export function OrderOutputs({ base, job, sessions }: { base: string; job: V2Delegation; sessions: V2Session[] }) {
  const path = base + '/orders/' + segment(job.id)
  const active = job.status === 'active' && !job.paused
  const query = useV2Read(path + '/outputs', isOrderOutputs, active ? 4000 : undefined, job.remainingTurns)
  const [file, setFile] = useState<{sessionId: string; messageId: string; id: string}>()
  const outputs = (query.data?.outputs ?? []).filter(row => sessions.some(s => s.id === row.sessionId))
  const selected = file && outputs.find(o => o.sessionId === file.sessionId && o.messageId === file.messageId && o.attachment.id === file.id)
  return <>
    <Issue text={query.error} retry={query.refresh}/>
    {outputs.length > 0 && <section aria-label="交付成果" className="v2-order-outputs">
      <div className="v2-section-head"><h2><V2Icon name="box"/>交付成果</h2></div>
      <div className="v2-card">{outputs.map(row => <button type="button" className="v2-row" key={row.sessionId + '/' + row.messageId + '/' + row.attachment.id}
        onClick={() => setFile({sessionId:row.sessionId,messageId:row.messageId,id:row.attachment.id})}>
        <span className="v2-row-title"><strong>{row.attachment.label}</strong><V2Icon name="next"/></span></button>)}</div>
    </section>}
    {selected && <V2AttachmentDialog path={base + '/sessions/' + segment(selected.sessionId) + '/attachments/' + segment(selected.attachment.id)}
      reference={selected.attachment} context={sessions.find(s => s.id === selected.sessionId)?.title ?? job.title} close={() => setFile(undefined)}/>}
  </>
}
