import { defaultWorkspaceIcon, type V2Workspace } from '../core/workspace-v2.ts'
import prototype from './artwork/workspaces/prototype.svg'
import recorder from './artwork/workspaces/recorder.svg'
import report from './artwork/workspaces/report.svg'

const artwork = { prototype, recorder, report }

export function WorkspaceIcon({ workspace }: { workspace: V2Workspace }) {
  const icon = workspace.icon ?? defaultWorkspaceIcon(workspace.id, workspace.name)
  return <img className="v2-tile-mark" data-workspace-icon={icon} src={artwork[icon]} width={38} height={40} alt="" aria-hidden="true"/>
}
