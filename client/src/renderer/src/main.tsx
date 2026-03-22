import { Buffer } from 'buffer'
// music-metadata-browser uses Node.js Buffer at runtime
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

// Initialize WASM for MLS E2EE — pass the WASM binary URL explicitly
// so Vite's module bundling doesn't break the default import.meta.url loader.
const wasmUrl = new URL('../../../../sdk/wasm/pkg/vesper_openmls_wasm_bg.wasm', import.meta.url).href
initCipherSuite(wasmUrl).catch((err) => {
  console.error('[E2EE] Failed to initialize WASM:', err)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    {import.meta.env.DEV ? <Agentation endpoint="http://localhost:4747" /> : null}
  </React.StrictMode>
)
