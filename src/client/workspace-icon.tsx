import { useId, useState } from 'react'
import { WORKSPACE_ICONS, workspaceIconLabel, type WorkspaceIcon as IconId } from '../core/workspace-icons.ts'
import content from './artwork/workspaces/content.svg'
import finance from './artwork/workspaces/finance.svg'
import health from './artwork/workspaces/health.svg'
import inbox from './artwork/workspaces/inbox.svg'
import landing from './artwork/workspaces/landing.svg'
import learning from './artwork/workspaces/learning.svg'
import orbit from './artwork/workspaces/orbit.svg'
import people from './artwork/workspaces/people.svg'
import project from './artwork/workspaces/project.svg'
import prototype from './artwork/workspaces/prototype.svg'
import recorder from './artwork/workspaces/recorder.svg'
import report from './artwork/workspaces/report.svg'
import travel from './artwork/workspaces/travel.svg'

const artwork: Record<IconId, string> = {content, finance, health, inbox, landing, learning, orbit, people, project, prototype, recorder, report, travel}

export function WorkspaceIcon({ icon }: { icon: IconId }) {
  return <img className="v2-tile-mark" data-workspace-icon={icon} src={artwork[icon]} width={38} height={40} alt="" aria-hidden="true"/>
}

export function WorkspaceIconPicker({recommendation, selected, choose, disabled}: {
  recommendation: IconId; selected?: IconId; choose: (icon?: IconId) => void; disabled: boolean
}) {
  const [open,setOpen] = useState(false)
  const group = useId()
  const current = selected ?? recommendation
  return <fieldset className="v2-space-icon-picker" disabled={disabled}>
    <legend>工作区头像</legend>
    <div className="v2-space-icon-preview" data-workspace-icon-preview="">
      <WorkspaceIcon icon={current}/>
      <div aria-live="polite"><strong>{workspaceIconLabel(current)}</strong>
        <small>{selected ? '手动选定' : '按名称和目标推荐'}</small></div>
      <button type="button" className="v2-link" aria-expanded={open} aria-controls={group} onClick={()=>setOpen(!open)}>
        {open ? '收起头像' : '选择头像'}
      </button>
    </div>
    <div className="v2-portrait-choices" id={group} hidden={!open}>
      <label><input type="radio" name="workspace-icon" checked={!selected} onChange={()=>choose()}/>
        <WorkspaceIcon icon={recommendation}/><span>自动推荐</span></label>
      {WORKSPACE_ICONS.map(icon=><label key={icon}>
        <input type="radio" name="workspace-icon" checked={icon === selected} onChange={()=>choose(icon)}/>
        <WorkspaceIcon icon={icon}/><span>{workspaceIconLabel(icon)}</span>
      </label>)}
    </div>
  </fieldset>
}
