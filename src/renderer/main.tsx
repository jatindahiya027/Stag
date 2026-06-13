import React from 'react'
import ReactDOM from 'react-dom/client'
import RuntimeBootstrap from './components/RuntimeBootstrap'
import './styles/global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RuntimeBootstrap />
  </React.StrictMode>
)
