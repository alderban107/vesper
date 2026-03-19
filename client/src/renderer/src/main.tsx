import { Buffer } from 'buffer'
// music-metadata-browser uses Node.js Buffer at runtime
;(globalThis as Record<string, unknown>).Buffer = Buffer

import React from 'react'
import ReactDOM from 'react-dom/client'
import { Agentation } from 'agentation'
import { initWebNotifications } from './utils/webNotifications'
import App from './App'
import 'katex/dist/katex.min.css'
import './index.css'

initWebNotifications()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    {import.meta.env.DEV ? <Agentation endpoint="http://localhost:4747" /> : null}
  </React.StrictMode>
)
