import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Apply the saved theme before the first render so the page doesn't flash.
let theme = 'dark'
try { theme = localStorage.getItem('localbase-theme') || 'dark' } catch {}
document.documentElement.classList.toggle('dark', theme === 'dark')

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
)
