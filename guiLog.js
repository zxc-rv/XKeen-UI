let guiLogState = {
  enabled: false,
  config: {
    access: "",
    error: "",
    loglevel: "warning",
    dnsLog: false,
  },
}

const LOG_LEVELS = ["none", "error", "warning", "info", "debug"]
const LOG_COLORS = { none: "transparent", error: "#22c55e", warning: "#eab308", info: "#f97316", debug: "#ef4444" }

function isLogFile() {
  const config = configs[activeConfigIndex]
  if (!config) return false

  const filename = config.filename.toLowerCase()
  if (!filename.includes("log")) return false

  try {
    const content = JSON.parse(config.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
    return content.log !== undefined
  } catch (e) {
    return false
  }
}

function parseLogJSON(content) {
  try {
    const json = JSON.parse(content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
    if (json.log) {
      guiLogState.config = {
        access: json.log.access || "",
        error: json.log.error || "",
        loglevel: json.log.loglevel || "warning",
        dnsLog: json.log.dnsLog !== undefined ? json.log.dnsLog : false,
      }
      return true
    }
  } catch (e) {
    console.error("Parse error:", e)
  }
  return false
}

async function buildLogJSON() {
  const currentContent = monacoEditor.getValue()
  try {
    const json = JSON.parse(currentContent.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))

    json.log = {}

    if (guiLogState.config.access && guiLogState.config.access !== "") {
      json.log.access = guiLogState.config.access
    } else {
      json.log.access = "none"
    }

    if (guiLogState.config.error && guiLogState.config.error !== "") {
      json.log.error = guiLogState.config.error
    } else {
      json.log.error = "none"
    }

    json.log.loglevel = guiLogState.config.loglevel
    json.log.dnsLog = guiLogState.config.dnsLog

    const preFormatted = JSON.stringify(json, null, 2)

    const formatted = await window.prettier.format(preFormatted, {
      parser: "json",
      plugins: [window.prettierPlugins.babel],
      semi: false,
      singleQuote: false,
      trailingComma: "none",
      printWidth: 120,
      endOfLine: "lf",
    })

    const cleanedText = formatted
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s+$/gm, "")
      .replace(/\n$/, "")

    return cleanedText
  } catch (e) {
    console.error("Build JSON error:", e)
    return currentContent
  }
}

function syncJSONToguiLog() {
  const content = monacoEditor.getValue()
  parseLogJSON(content)
  renderGuiLog()
}

function syncguiLogToJSON() {
  buildLogJSON()
    .then((newContent) => {
      monacoEditor.setValue(newContent)
      configs[activeConfigIndex].content = newContent
      configs[activeConfigIndex].isDirty = true
      updateUIDirtyState()
    })
    .catch((err) => {
      console.error("Error syncing GUI to JSON:", err)
    })
}

function applyGuiLogState() {
  if (!monacoEditor) return
  const editorContainer = document.getElementById("editorContainer")
  if (!editorContainer) return

  const config = configs[activeConfigIndex]
  if (!config) return

  if (!isLogFile()) return

  const isLogActive = guiLogState.enabled

  editorContainer.style.display = "none"
  const guiLogContainer = document.getElementById("guiLogContainer")
  if (guiLogContainer) guiLogContainer.style.display = "none"
  document.querySelector(".tabs-content")?.classList.remove("no-border")

  if (isLogActive) {
    let guiContainer = document.getElementById("guiLogContainer")
    if (!guiContainer) {
      guiContainer = document.createElement("div")
      guiContainer.id = "guiLogContainer"
      guiContainer.className = "log-gui-container"
      editorContainer.parentNode.appendChild(guiContainer)
    }
    guiContainer.style.display = "block"
    syncJSONToguiLog()
    renderGuiLog()
    document.querySelector(".tabs-content")?.classList.add("no-border")
  }
}

function renderGuiLog() {
  let container = document.getElementById("guiLogContainer")
  if (!container) return

  const cfg = guiLogState.config
  const idx = LOG_LEVELS.indexOf(cfg.loglevel)
  const pct = (idx / (LOG_LEVELS.length - 1)) * 100
  const clr = LOG_COLORS[cfg.loglevel]

  container.innerHTML = `
    <div class="log-gui-section">
      <h3 class="log-gui-title">Access Log</h3>
      <div class="log-path-buttons">
        <button class="log-path-btn ${cfg.access === "none" || cfg.access === "" ? "active" : ""}"
                onclick="setLogPath('access', 'none')">
          none
        </button>
        <button class="log-path-btn ${cfg.access === "/opt/var/log/xray/access.log" ? "active" : ""}"
                onclick="setLogPath('access', '/opt/var/log/xray/access.log')">
          /opt/var/log/xray/access.log
        </button>
      </div>
    </div>

    <div class="log-gui-section">
      <h3 class="log-gui-title">Error Log</h3>
      <div class="log-path-buttons">
        <button class="log-path-btn ${cfg.error === "none" || cfg.error === "" ? "active" : ""}"
                onclick="setLogPath('error', 'none')">
          none
        </button>
        <button class="log-path-btn ${cfg.error === "/opt/var/log/xray/error.log" ? "active" : ""}"
                onclick="setLogPath('error', '/opt/var/log/xray/error.log')">
          /opt/var/log/xray/error.log
        </button>
      </div>
    </div>

    <div class="log-gui-section">
      <h3 class="log-gui-title">Log Level</h3>
      <div class="log-slider-container">
        <div class="log-slider-track">
          <div class="log-slider-fill" style="width: ${pct}%; background: ${clr}; box-shadow: 0 0 10px ${clr}66"></div>
          <div class="log-slider-dots">
            ${LOG_LEVELS.map(
              (l, i) => `
              <div class="log-dot ${i <= idx ? "active" : ""}"
                  style="${i <= idx ? `--dot-clr: ${clr}` : ""}"
                  onclick="setLogLevel('${l}')"
                  data-label="${l.toUpperCase()}">
              </div>
            `,
            ).join("")}
          </div>
        </div>
      </div>
    </div>

    <div class="log-gui-section">
      <h3 class="log-gui-title">DNS Log</h3>
      <div class="log-dns-toggle">
        <input type="checkbox" id="dnsLogCheckbox" ${cfg.dnsLog ? "checked" : ""} onchange="toggleDNSLog()" />
        <label for="dnsLogCheckbox"></label>
        <span class="log-dns-label">${cfg.dnsLog ? "Включено" : "Выключено"}</span>
      </div>
    </div>
  `
}

function setLogPath(type, path) {
  guiLogState.config[type] = path === "" ? "none" : path
  syncguiLogToJSON()
  renderGuiLog()

  if (autoApply) {
    setTimeout(() => {
      if (typeof saveAndRestart === "function") {
        saveAndRestart()
      }
    }, 100)
  }
}

function setLogLevel(level) {
  guiLogState.config.loglevel = level
  syncguiLogToJSON()

  const idx = LOG_LEVELS.indexOf(level)
  const pct = (idx / (LOG_LEVELS.length - 1)) * 100
  const clr = LOG_COLORS[level]
  const fill = document.querySelector(".log-slider-fill")

  if (fill) {
    fill.style.width = `${pct}%`
    fill.style.backgroundColor = clr
    fill.style.boxShadow = `0 0 10px ${clr}66`
  }

  document.querySelectorAll(".log-dot").forEach((dot, i) => {
    dot.classList.toggle("active", i <= idx)
    if (i <= idx) {
      dot.style.setProperty("--dot-clr", clr)
    }
  })

  if (autoApply) {
    setTimeout(() => {
      if (typeof saveAndRestart === "function") saveAndRestart()
    }, 100)
  }
}

function toggleDNSLog() {
  const cb = document.getElementById("dnsLogCheckbox")
  guiLogState.config.dnsLog = cb.checked
  syncguiLogToJSON()

  const label = document.querySelector(".log-dns-label")
  if (label) label.textContent = cb.checked ? "Включено" : "Выключено"

  if (autoApply) {
    setTimeout(() => {
      if (typeof saveAndRestart === "function") saveAndRestart()
    }, 100)
  }
}

function toggleGuiLog() {
  const checkbox = document.getElementById("guiLogCheckboxSettings")
  if (checkbox) {
    guiLogState.enabled = checkbox.checked
    localStorage.setItem("guiLog_enabled", guiLogState.enabled ? "1" : "0")
  }
  const config = configs[activeConfigIndex]
  if (config && config.filename.toLowerCase().includes("log") && typeof applyGUIState === "function") {
    applyGUIState()
  }
}

function loadGuiLogState() {
  const saved = localStorage.getItem("guiLog_enabled")
  return saved === "1"
}
