import { Buffer } from 'buffer'
// Audio metadata parsing still consumes Buffer-backed tag payloads in browsers.
;(globalThis as Record<string, unknown>).Buffer = Buffer

import React from 'react'
import ReactDOM from 'react-dom/client'
import { Agentation } from 'agentation'
import { initWebNotifications } from './utils/webNotifications'
import { initCipherSuite } from '@vesper/sdk/crypto'
import App from './App'
import 'katex/dist/katex.min.css'
import './index.css'

initWebNotifications()

// Initialize WASM for MLS E2EE
initCipherSuite('/assets/vesper_openmls_wasm_bg.wasm').catch((err) => {
  console.error('[E2EE] Failed to initialize WASM:', err)
})

const agentationEnabled =
  import.meta.env.DEV && import.meta.env.VITE_AGENTATION_ENABLED === 'true'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    {agentationEnabled ? <Agentation endpoint="http://localhost:4747" /> : null}
  </React.StrictMode>
)
