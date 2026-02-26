import { createRoot } from "react-dom/client";

import "./globals.css";
import "./lib/outboundParser.js";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);
