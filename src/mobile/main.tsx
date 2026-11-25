/** 独立的作战台页面（经网关在手机上打开）：直接渲染作战台，接口经网关转发到 DSH。 */
import { createRoot } from 'react-dom/client'
import { WorkspaceEntry } from '../client/workspace-entry.tsx'

document.body.dataset.chiefStandalone = 'true'
createRoot(document.getElementById('root')!).render(<WorkspaceEntry />)
