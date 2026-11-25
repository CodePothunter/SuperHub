/** Isolated entry for browser regression of the existing historical record reader. */
import { createRoot } from 'react-dom/client'
import { App } from '../src/client/app.tsx'

document.body.dataset.chiefStandalone = 'true'
createRoot(document.getElementById('root')!).render(<App />)
