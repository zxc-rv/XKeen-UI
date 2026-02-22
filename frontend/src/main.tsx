import { createRoot } from "react-dom/client"

import "./index.css"
import "./lib/outboundParser.js"
import App from "./App.tsx"

createRoot(document.getElementById("root")!).render(<App />)
