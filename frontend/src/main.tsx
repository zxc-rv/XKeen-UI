import { createRoot } from 'react-dom/client'

import App from './App.tsx'
import './globals.css'
import './lib/outboundParser.js'

createRoot(document.getElementById('root')!).render(<App />)
