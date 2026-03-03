import React from 'react'
import ReactDOM from 'react-dom/client'
import { initWebNotifications } from './utils/webNotifications'
import App from './App'
import './index.css'

initWebNotifications()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
