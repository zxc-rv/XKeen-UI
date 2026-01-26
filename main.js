let monacoEditor
let configs = []
let activeConfigIndex = -1
let isServiceRunning = false
let isActionInProgress = false
let userScrolled = false
let pendingSwitchIndex = -1
let currentLogFile = "error.log"
let isConfigsLoading = true
let logFilter = ""
let isStatusLoading = true
let ws = null
let pingInterval = null
let allLogLines = []
let displayLines = []
let availableCores = []
let currentCore = ""
let pendingCoreChange = ""
let isCurrentFileJson = false
let dashboardPort = null
let dependenciesLoaded = false
let toastStack = []
let currentTimezone = 3
let autoApply = false

async function loadDependencies() {
  if (dependenciesLoaded) return

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const script = document.createElement("script")
      script.src = src
      script.onload = resolve
      script.onerror = reject
      document.head.appendChild(script)
    })

  if (LOCAL) {
    window.MonacoEnvironment = {
      getWorkerUrl: () => "/monaco-editor/vs/base/worker/workerMain.js",
    }
    await loadScript("/monaco-editor/standalone.min.js")
    await loadScript("/monaco-editor/babel.min.js")
    await loadScript("/monaco-editor/yaml.min.js")
    await loadScript("/monaco-editor/js-yaml.min.js")
    await loadScript("/monaco-editor/loader.min.js")
  } else {
    await loadScript("https://cdn.jsdelivr.net/npm/prettier@2/standalone.min.js")
    await loadScript("https://cdn.jsdelivr.net/npm/prettier@3/plugins/babel.min.js")
    await loadScript("https://cdn.jsdelivr.net/npm/prettier@3/plugins/yaml.min.js")
    await loadScript("https://cdn.jsdelivr.net/npm/js-yaml@4/dist/js-yaml.min.js")
    await loadScript("https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.min.js")
  }

  require.config({
    paths: {
      vs: LOCAL ? "/monaco-editor/vs" : "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs",
    },
  })
  dependenciesLoaded = true
}

async function init() {
  try {
    await loadDependencies()
    await new Promise((resolve, reject) => {
      require(["vs/editor/editor.main"], resolve, reject)
    })

    await checkXKeenStatus()
    await getAvailableCores()
    await loadTimezone()
    loadMonacoEditor()
    connectWebSocket()

    const savedState = localStorage.getItem("guiRouting_enabled")
    if (typeof guiRoutingState !== "undefined") {
      guiRoutingState.enabled = savedState === "1"
    }
    const routingCheckboxSettings = document.getElementById("guiRoutingCheckboxSettings")
    if (routingCheckboxSettings) {
      routingCheckboxSettings.checked = guiRoutingState.enabled
    }

    const savedLogState = localStorage.getItem("guiLog_enabled")
    if (typeof guiLogState !== "undefined") {
      guiLogState.enabled = savedLogState === "1"
    }
    const logCheckboxSettings = document.getElementById("guiLogCheckboxSettings")
    if (logCheckboxSettings) {
      logCheckboxSettings.checked = guiLogState.enabled
    }

    const savedAutoApply = localStorage.getItem("autoApply")
    autoApply = savedAutoApply === "1"
    const autoApplyCheckbox = document.getElementById("autoApplyCheckbox")
    if (autoApplyCheckbox) {
      autoApplyCheckbox.checked = autoApply
    }

    const logsContainer = document.getElementById("logsContainer")
    logsContainer.classList.add("centered")
    logsContainer.innerHTML = '<div style="color: #6b7280;">Установка соединения...</div>'

    setInterval(() => {
      if (!isActionInProgress) checkXKeenStatus()
    }, 15000)
  } catch (error) {
    console.error("Failed to initialize app:", error)
    showToast("Ошибка инициализации приложения", "error")
  }
}

function getFileLanguage(filename) {
  if (filename.endsWith(".json")) return "json"
  if (filename.endsWith(".yaml") || filename.endsWith(".yml")) return "yaml"
  if (filename.endsWith(".lst")) return "plaintext"
  return "json"
}

function showToast(message, type = "success") {
  const toast = document.createElement("div")
  toast.className = `toast ${type}`

  const icons = {
    success: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="toast-icon success"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>`,
    error: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="toast-icon error"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg>`,
  }

  if (typeof message === "object" && message.title && message.body) {
    toast.innerHTML = `
      <div class="toast-header">
        ${icons[type] || icons.success}
        <div class="toast-title">${message.title}</div>
      </div>
      <div class="toast-body">${message.body}</div>
    `
  } else {
    toast.innerHTML = `
      <div class="toast-header">
        ${icons[type] || icons.success}
        <div class="toast-title">${type === "error" ? "Ошибка" : "Успех"}</div>
      </div>
      <div class="toast-body">${message}</div>
    `
  }

  document.body.appendChild(toast)

  requestAnimationFrame(() => {
    const toastHeight = toast.offsetHeight
    toastStack.unshift({ element: toast, height: toastHeight }) // Изменено здесь

    toastStack.forEach((item, index) => {
      let offset = 35
      for (let i = 0; i < index; i++) {
        offset += toastStack[i].height + 12
      }
      item.element.style.bottom = `${offset}px`
    })

    setTimeout(() => toast.classList.add("show"), 10)

    setTimeout(() => {
      toast.classList.add("hide")
      setTimeout(() => {
        const toastIndex = toastStack.findIndex((item) => item.element === toast)
        if (toastIndex > -1) {
          toastStack.splice(toastIndex, 1)
        }

        if (toast.parentNode) {
          document.body.removeChild(toast)
        }

        toastStack.forEach((item, index) => {
          let offset = 35
          for (let i = 0; i < index; i++) {
            offset += toastStack[i].height + 12
          }
          item.element.style.bottom = `${offset}px`
        })
      }, 300)
    }, 3000)
  })
}

function updateValidationInfo(isValid, error = null) {
  const messageContainer = document.getElementById("validationMessageContainer")
  const currentConfig = configs[activeConfigIndex]
  const fileLanguage = currentConfig ? getFileLanguage(currentConfig.filename) : null
  const shouldShowMessage = currentConfig && (fileLanguage === "json" || fileLanguage === "yaml")

  if (!shouldShowMessage) {
    messageContainer.style.display = "none"
    const editorControls = document.querySelector(".editor-controls")
    if (editorControls) editorControls.style.display = "flex"
  } else {
    messageContainer.style.display = "flex"

    const fileType = fileLanguage.toUpperCase()
    if (isValid) {
      messageContainer.innerHTML = `
        <span class="validation-icon validation-success">✓</span>
        <span class="validation-success">${fileType} валиден</span>
      `
    } else {
      messageContainer.innerHTML = `
        <span class="validation-icon validation-error">✗</span>
        <span class="validation-error">Ошибка: ${error || "Файл невалиден"}</span>
      `
    }
  }
}

function updateControlButtons() {
  const startBtn = document.getElementById("startBtn")
  const stopBtn = document.getElementById("stopBtn")
  const restartBtn = document.getElementById("restartBtn")
  const controlsSkeletons = document.getElementById("controlsSkeletons")

  if (isStatusLoading) {
    if (controlsSkeletons) controlsSkeletons.style.display = "inline-flex"
    startBtn.style.display = "none"
    stopBtn.style.display = "none"
    restartBtn.style.display = "none"
    return
  }

  if (isActionInProgress) {
    startBtn.disabled = true
    stopBtn.disabled = true
    restartBtn.disabled = true
    return
  }

  if (controlsSkeletons) controlsSkeletons.style.display = "none"
  startBtn.style.display = isServiceRunning ? "none" : "inline-flex"
  stopBtn.style.display = isServiceRunning ? "inline-flex" : "none"
  restartBtn.style.display = isServiceRunning ? "inline-flex" : "none"

  startBtn.disabled = false
  stopBtn.disabled = false
  restartBtn.disabled = false
}

function setPendingState(actionText) {
  isActionInProgress = true
  const indicator = document.getElementById("statusIndicator")
  const text = document.getElementById("statusText")

  indicator.className = "status status-pending"
  text.textContent = actionText
  updateControlButtons()
}

function updateServiceStatus(running) {
  const indicator = document.getElementById("statusIndicator")
  const text = document.getElementById("statusText")

  isServiceRunning = running
  isStatusLoading = false

  if (running) {
    indicator.className = "status status-running"
    text.textContent = "Сервис запущен"
  } else {
    indicator.className = "status status-stopped"
    text.textContent = "Сервис остановлен"
  }

  updateControlButtons()
}

function renderAllLogs(container, lines) {
  const html = lines.join("")
  container.innerHTML = html || '<div class="centered" style="color: #6b7280;">Журнал пуст</div>'
  container.classList.toggle("centered", !html)
  container.scrollTop = container.scrollHeight
}

function appendLogLines(container, newLines) {
  if (newLines.length === 0) return

  const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50
  const htmlFragment = newLines.join("")

  if (!htmlFragment) return
  if (container.firstElementChild && container.firstElementChild.innerText === "Журнал пуст") {
    container.innerHTML = ""
    container.classList.remove("centered")
  }
  container.insertAdjacentHTML("beforeend", htmlFragment)

  const maxLines = 1000
  while (container.children.length > maxLines) {
    container.firstElementChild.remove()
  }

  if (wasAtBottom && !userScrolled) {
    container.scrollTop = container.scrollHeight
  }
}

function applyFilter() {
  if (!logFilter || logFilter.trim() === "") {
    displayLines = allLogLines.slice(-1000)
    renderAllLogs(document.getElementById("logsContainer"), displayLines)
  } else {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "filter",
          query: logFilter,
        }),
      )
    }
  }
}

function toggleLogFullscreen() {
  const panel = document.getElementById("logsPanel")
  const btn = document.getElementById("expandLogBtn")
  if (panel.classList.contains("expanded-vertical")) {
    panel.classList.remove("expanded-vertical")
    document.body.style.overflow = ""

    const clone = panel.cloneNode(true)
    clone.id = ""
    document.body.appendChild(clone)

    clone.classList.add("expanded-vertical")
    clone.style.pointerEvents = "none"
    clone.offsetHeight
    clone.style.animation = "panel-collapse 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards"

    setTimeout(() => {
      clone.remove()
    }, 350)

    btn.innerHTML = `
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="icon icon-tabler icons-tabler-outline icon-tabler-maximize"
      >
        <path stroke="none" d="M0 0h24v24H0z" fill="none" />
        <path d="M4 8v-2a2 2 0 0 1 2 -2h2" />
        <path d="M4 16v2a2 2 0 0 0 2 2h2" />
        <path d="M16 4h2a2 2 0 0 1 2 2v2" />
        <path d="M16 20h2a2 2 0 0 0 2 -2v-2" />
      </svg>`
    btn.title = "Развернуть"
  } else {
    panel.classList.add("expanded-vertical")
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-minimize"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M15 19v-2a2 2 0 0 1 2 -2h2" /><path d="M15 5v2a2 2 0 0 0 2 2h2" /><path d="M5 15h2a2 2 0 0 1 2 2v2" /><path d="M5 9h2a2 2 0 0 0 2 -2v-2" /></svg>`
    btn.title = "Свернуть"
    document.body.style.overflow = "hidden"
  }
  const container = document.getElementById("logsContainer")
  setTimeout(() => {
    container.scrollTop = container.scrollHeight
  }, 100)
}

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close()
  }

  if (pingInterval) {
    clearInterval(pingInterval)
  }

  ws = new WebSocket(`/ws?file=${currentLogFile}`)

  ws.onopen = () => {
    console.log("WebSocket connected")
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }))
      }
    }, 30000)
  }

  ws.onclose = (event) => {
    console.warn(`WebSocket disconnected: ${event.code} (${event.reason}). Reconnecting...`)
    clearInterval(pingInterval)
    setTimeout(connectWebSocket, 1000)
  }

  ws.onerror = (error) => {
    console.error("WebSocket error:", error)
    ws.close()
  }

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data)

    if (data.type === "pong") return
    if (data.error) {
      console.error("WebSocket error:", data.error)
      const container = document.getElementById("logsContainer")
      container.classList.add("centered")
      container.innerHTML = `<div style="color: #ef4444;">Ошибка WebSocket: ${data.error}</div>`
      return
    }
    if (data.type === "initial") {
      allLogLines = data.allLines || []
      displayLines = data.displayLines || []
      renderAllLogs(document.getElementById("logsContainer"), displayLines)

      if (logFilter && logFilter.trim() !== "") {
        applyFilter()
      }
      return
    }
    if (data.type === "clear") {
      allLogLines = []
      displayLines = []
      const container = document.getElementById("logsContainer")
      container.classList.add("centered")
      container.innerHTML = '<div style="color: #6b7280;">Логи очищены</div>'
      return
    }
    if (data.type === "append") {
      const newLines = data.content.split("\n").filter((line) => line.trim())
      allLogLines.push(...newLines)

      let linesToRender = []

      if (!logFilter) {
        displayLines.push(...newLines)
        linesToRender = newLines
      } else {
        const matchedNewLines = newLines.filter((line) => line.includes(logFilter))
        if (matchedNewLines.length > 0) {
          displayLines.push(...matchedNewLines)
          linesToRender = matchedNewLines
        }
      }

      if (displayLines.length > 1000) {
        displayLines = displayLines.slice(-1000)
      }
      if (linesToRender.length > 0) {
        appendLogLines(document.getElementById("logsContainer"), linesToRender)
      }
      return
    }

    if (data.type === "filtered") {
      displayLines = data.lines || []
      renderAllLogs(document.getElementById("logsContainer"), displayLines)
      return
    }
  }
}

function switchLogFile(newLogFile) {
  if (currentLogFile === newLogFile) return

  currentLogFile = newLogFile

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "switchFile",
        file: newLogFile,
      }),
    )
  }
}

function loadMonacoEditor() {
  if (!window.monaco) {
    console.error("Monaco Editor not loaded yet")
    return
  }
  require(["vs/editor/editor.main"], async function () {
    await document.fonts.ready
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      allowComments: true,
    })
    monaco.languages.json.jsonDefaults.setModeConfiguration({
      ...monaco.languages.json.jsonDefaults.modeConfiguration,
      documentFormattingEdits: false,
    })

    monaco.languages.registerDocumentFormattingEditProvider("json", {
      async provideDocumentFormattingEdits(model, options, token) {
        try {
          console.log("Using Prettier for JSON formatting...")
          const text = await window.prettier.format(model.getValue(), {
            parser: "json",
            plugins: [window.prettierPlugins.babel],
            semi: false,
            singleQuote: false,
            trailingComma: "none",
            printWidth: 120,
            endOfLine: "lf",
          })
          const cleanedText = text
            .replace(/\n{3,}/g, "\n\n")
            .replace(/\s+$/gm, "")
            .replace(/\n$/, "")
          return [
            {
              range: model.getFullModelRange(),
              text: cleanedText,
            },
          ]
        } catch (error) {
          console.error("Prettier formatting error:", error)
          showToast(
            {
              title: "Ошибка форматирования",
              body: `Файл содержит ошибки`,
            },
            "error",
          )
          return []
        }
      },
    })

    monaco.languages.registerDocumentFormattingEditProvider("yaml", {
      async provideDocumentFormattingEdits(model, options, token) {
        try {
          console.log("Using Prettier for YAML formatting...")
          const text = await window.prettier.format(model.getValue(), {
            parser: "yaml",
            plugins: [window.prettierPlugins.yaml],
            printWidth: 200,
            tabWidth: 2,
            useTabs: false,
            singleQuote: true,
            quoteProps: "as-needed",
            proseWrap: "preserve",
            endOfLine: "lf",
            bracketSpacing: true,
          })
          return [
            {
              range: model.getFullModelRange(),
              text: text,
            },
          ]
        } catch (error) {
          console.error("Prettier YAML formatting error:", error)
          const errorMessage = error.message.split("\n")[0]
          showToast(
            {
              title: "Ошибка форматирования",
              body: `Файл содержит ошибки`,
            },
            "error",
          )
          return []
        }
      },
    })

    monaco.editor.defineTheme("tokyo-night", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "string.key.json", foreground: "#7aa2f7" },
        { token: "string.value.json", foreground: "#9ece6a" },
        { token: "number.json", foreground: "#ff9e64" },
        { token: "number.yaml", foreground: "#ff9e64" },
        { token: "keyword.json", foreground: "#bb9af7" },
        { token: "keyword.yaml", foreground: "#bb9af7" },
        { token: "identifier", foreground: "#c0caf5" },
        { token: "comment", foreground: "#565f89" },
        { token: "comment.line", foreground: "#565f89" },
        { token: "comment.block", foreground: "#565f89" },
        { token: "operator", foreground: "#89ddff" },
        { token: "delimiter", foreground: "#c0caf5" },
        { token: "tag", foreground: "#f7768e" },
        { token: "attribute.name", foreground: "#e0af68" },
        { token: "attribute.value", foreground: "#9ece6a" },
        { token: "string.yaml", foreground: "#9ece6a" },
        { token: "type.yaml", foreground: "#7aa2f7" },
      ],
      colors: {
        "editor.background": "#080e1d",
        "editor.foreground": "#c0caf5",
        "editorLineNumber.foreground": "#3b4261",
        "editorLineNumber.activeForeground": "#a9b1d6",
        "editorCursor.foreground": "#c0caf5",
        "editorIndentGuide.background": "#2f3549",
        "editor.selectionBackground": "#364a82",
        "editor.inactiveSelectionBackground": "#292e42",
        "editorLineNumber.dimmedForeground": "#565f89",
        "editorBracketMatch.border": "#7aa2f7",
        "editorBracketMatch.background": "#283457",
        "editorWhitespace.foreground": "#3b4261",
        "editorGutter.modifiedBackground": "#7aa2f7",
        "editorGutter.addedBackground": "#9ece6a",
        "editorGutter.deletedBackground": "#f7768e",
      },
    })

    const editorContainer = document.getElementById("editorContainer")
    editorContainer.innerHTML = ""

    monacoEditor = monaco.editor.create(editorContainer, {
      value: "",
      language: "json",
      theme: "tokyo-night",
      automaticLayout: true,
      formatOnPaste: false,
      formatOnType: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: true, showSlider: "always" },
      fontSize: 14,
      fontFamily: "JetBrains Mono, monospace, Noto Color Emoji",
      fontWeight: 400,
      smoothScrolling: true,
      lineHeight: 1.5,
      renderLineHighlight: "none",
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "off",
      folding: true,
      lineNumbers: "on",
      glyphMargin: false,
      stickyScroll: { enabled: false },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      scrollbar: {
        vertical: "hidden",
        horizontal: "hidden",
        verticalScrollbarSize: 0,
        useShadows: false,
        verticalHasArrows: false,
        horizontalHasArrows: false,
      },
      quickSuggestions: true,
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: "on",
      tabCompletion: "on",
      wordBasedSuggestions: true,
    })

    function isMobileViewport() {
      return window.matchMedia && window.matchMedia("(max-width: 768px)").matches
    }

    function applyDynamicEditorHeight() {
      const container = document.getElementById("editorContainer")
      if (!container || !monacoEditor) return
      if (isMobileViewport()) {
        const contentHeight = Math.max(monacoEditor.getContentHeight ? monacoEditor.getContentHeight() : 0, 200)
        const maxHeight = 750
        container.style.height = Math.min(contentHeight, maxHeight) + "px"
        monacoEditor.layout()
      } else {
        container.style.height = "750px"
        monacoEditor.layout()
      }
    }

    monaco.editor.onDidChangeMarkers((uris) => {
      const currentConfig = configs[activeConfigIndex]
      if (!currentConfig) {
        updateValidationInfo(false)
        return
      }

      const language = getFileLanguage(currentConfig.filename)
      const model = monacoEditor.getModel()
      if (!model) return

      if (uris.some((uri) => uri.toString() === model.uri.toString())) {
        if (language === "json") {
          const markers = monaco.editor.getModelMarkers({
            owner: "json",
            resource: model.uri,
          })
          const errorMarker = markers.find((m) => m.severity === monaco.MarkerSeverity.Error)

          if (!errorMarker) {
            updateValidationInfo(true)
          } else {
            updateValidationInfo(false, errorMarker.message)
          }
          updateUIDirtyState()
        }
      }
    })

    monacoEditor.onDidChangeModelContent(async () => {
      const currentConfig = configs[activeConfigIndex]
      if (!currentConfig) return

      const currentContent = monacoEditor.getValue()
      const isDirty = currentContent !== currentConfig.savedContent

      if (currentConfig.isDirty !== isDirty) {
        currentConfig.isDirty = isDirty
        updateUIDirtyState()
      }

      const language = getFileLanguage(currentConfig.filename)
      const model = monacoEditor.getModel()

      if (language === "yaml") {
        try {
          jsyaml.load(currentContent)
          monaco.editor.setModelMarkers(model, "yaml", [])
          updateValidationInfo(true)
        } catch (e) {
          const line = e.mark ? e.mark.line + 1 : 1
          const column = e.mark ? e.mark.column + 1 : 1
          const message = e.mark ? `${e.reason || e.message} [строка ${line}]` : e.message
          const lineContent = model.getLineContent(line)
          const endColumn = column + Math.max(1, lineContent.length - column + 1)

          monaco.editor.setModelMarkers(model, "yaml", [
            {
              severity: monaco.MarkerSeverity.Error,
              message: message,
              startLineNumber: line,
              startColumn: column,
              endLineNumber: line,
              endColumn: endColumn,
            },
          ])
          updateValidationInfo(false, message)
        }
        updateUIDirtyState()
      } else if (language !== "json") {
        monaco.editor.setModelMarkers(model, "yaml", [])
        updateValidationInfo(false)
        updateUIDirtyState()
      }
    })

    if (monacoEditor.onDidContentSizeChange) {
      monacoEditor.onDidContentSizeChange(() => {
        applyDynamicEditorHeight()
      })
    }

    window.addEventListener(
      "resize",
      () => {
        applyDynamicEditorHeight()
      },
      { passive: true },
    )

    loadConfigs()

    requestAnimationFrame(() => applyDynamicEditorHeight())
  })
}

function updateUIDirtyState() {
  const saveBtn = document.getElementById("saveBtn")
  const saveRestartBtn = document.getElementById("saveRestartBtn")
  const formatBtn = document.getElementById("formatBtn")
  const formatDropdownBtn = document.getElementById("formatDropdownBtn")
  const currentConfig = configs[activeConfigIndex]

  if (currentConfig) {
    const isValid = isFileValid()
    const fileLanguage = getFileLanguage(currentConfig.filename)
    const hasChanges = currentConfig.isDirty

    saveBtn.disabled = !hasChanges || !isValid
    formatBtn.disabled = !(fileLanguage === "json" || fileLanguage === "yaml") || !isValid

    if (formatDropdownBtn) {
      formatDropdownBtn.disabled = !(fileLanguage === "json" || fileLanguage === "yaml") || !isValid
    }

    if (fileLanguage === "json") {
      const isXray = currentCore === "xray"
      saveRestartBtn.disabled = !(isXray && hasChanges && isServiceRunning && isValid)
    } else if (fileLanguage === "yaml") {
      const isMihomo = currentCore === "mihomo"
      saveRestartBtn.disabled = !(isMihomo && hasChanges && isServiceRunning && isValid)
    } else if (fileLanguage === "plaintext") {
      saveRestartBtn.disabled = !(hasChanges && isServiceRunning && isValid)
    } else {
      saveRestartBtn.disabled = true
    }
  } else {
    saveBtn.disabled = true
    saveRestartBtn.disabled = true
    formatBtn.disabled = true
    if (formatDropdownBtn) {
      formatDropdownBtn.disabled = true
    }
  }
  renderTabs()
}

function renderTabs() {
  const coreTabsList = document.getElementById("coreTabsList")
  const xkeenTabsList = document.getElementById("xkeenTabsList")
  const coreIndicator = coreTabsList?.querySelector(".tab-active-indicator")
  const xkeenIndicator = xkeenTabsList?.querySelector(".tab-active-indicator")
  const coreTransform = coreIndicator?.style.transform || ""
  const xkeenTransform = xkeenIndicator?.style.transform || ""
  const editorControlsSkeletons = document.getElementById("editorControlsSkeletons")
  const saveBtn = document.getElementById("saveBtn")
  const saveRestartBtn = document.getElementById("saveRestartBtn")
  const formatBtn = document.getElementById("formatBtn")
  const formatDropdownBtn = document.getElementById("formatDropdownBtn")
  const validationSkeleton = document.getElementById("validationSkeleton")
  const validationInfo = document.getElementById("validationInfo")

  if (isConfigsLoading) {
    if (validationInfo) validationInfo.style.display = "flex"
    if (editorControlsSkeletons) editorControlsSkeletons.style.display = "inline-flex"
    if (saveBtn) saveBtn.style.display = "none"
    if (saveRestartBtn) saveRestartBtn.style.display = "none"
    if (formatBtn) formatBtn.style.display = "none"
    if (formatDropdownBtn) formatDropdownBtn.disabled = true
    if (validationSkeleton) validationSkeleton.style.display = "block"

    coreTabsList.innerHTML = ""
    xkeenTabsList.innerHTML = ""
    for (let i = 0; i < 3; i++) {
      const sk = document.createElement("div")
      sk.className = "skeleton skeleton-tab"
      coreTabsList.appendChild(sk)
    }
    for (let i = 0; i < 2; i++) {
      const sk = document.createElement("div")
      sk.className = "skeleton skeleton-tab"
      xkeenTabsList.appendChild(sk)
    }
    return
  }

  if (editorControlsSkeletons) editorControlsSkeletons.style.display = "none"
  if (saveBtn) saveBtn.style.display = "inline-flex"
  if (saveRestartBtn) saveRestartBtn.style.display = "inline-flex"
  if (formatBtn) formatBtn.style.display = "inline-flex"
  if (formatDropdownBtn) formatDropdownBtn.style.display = "inline-flex"
  if (validationSkeleton) validationSkeleton.style.display = "none"

  const coreConfigs = configs.filter((config) => !config.filename.endsWith(".lst"))
  const xkeenConfigs = configs.filter((config) => config.filename.endsWith(".lst"))

  coreTabsList.innerHTML = ""
  const newCoreIndicator = document.createElement("div")
  newCoreIndicator.className = "tab-active-indicator"
  newCoreIndicator.style.transform = coreTransform
  coreTabsList.appendChild(newCoreIndicator)

  coreConfigs.forEach((config, index) => {
    const globalIndex = configs.indexOf(config)
    const tabTrigger = document.createElement("button")
    tabTrigger.className = `tab-trigger ${globalIndex === activeConfigIndex ? "active" : ""} ${config.isDirty ? "dirty" : ""}`
    tabTrigger.innerHTML = `${config.name}<span class="dirty-indicator"></span>`
    tabTrigger.onclick = () => switchTab(globalIndex)
    coreTabsList.appendChild(tabTrigger)
  })

  xkeenTabsList.innerHTML = ""
  if (xkeenConfigs.length > 0) {
    const newXkeenIndicator = document.createElement("div")
    newXkeenIndicator.className = "tab-active-indicator"
    newXkeenIndicator.style.transform = xkeenTransform
    xkeenTabsList.appendChild(newXkeenIndicator)
    xkeenConfigs.forEach((config, index) => {
      const globalIndex = configs.indexOf(config)
      const tabTrigger = document.createElement("button")
      tabTrigger.className = `tab-trigger ${globalIndex === activeConfigIndex ? "active" : ""} ${config.isDirty ? "dirty" : ""}`
      tabTrigger.innerHTML = `${config.name}<span class="dirty-indicator"></span>`
      tabTrigger.onclick = () => switchTab(globalIndex)
      xkeenTabsList.appendChild(tabTrigger)
    })
    xkeenTabsList.parentElement.style.display = "inline-block"
  } else {
    xkeenTabsList.parentElement.style.display = "none"
  }
  setTimeout(() => updateActiveTabIndicator(), 0)
}

function updateActiveTabIndicator() {
  const coreTabsList = document.getElementById("coreTabsList")
  const xkeenTabsList = document.getElementById("xkeenTabsList")
  ;[coreTabsList, xkeenTabsList].forEach((container) => {
    if (!container) return
    const indicator = container.querySelector(".tab-active-indicator")
    if (indicator) {
      indicator.style.opacity = "0"
    }
  })
  const activeConfig = configs[activeConfigIndex]
  if (!activeConfig) return
  const isXkeen = activeConfig.filename.endsWith(".lst")
  const activeContainer = isXkeen ? xkeenTabsList : coreTabsList
  if (!activeContainer) return
  const indicator = activeContainer.querySelector(".tab-active-indicator")
  if (!indicator) return
  const tabs = Array.from(activeContainer.querySelectorAll(".tab-trigger"))
  const groupConfigs = isXkeen ? configs.filter((c) => c.filename.endsWith(".lst")) : configs.filter((c) => !c.filename.endsWith(".lst"))
  const groupIndex = groupConfigs.indexOf(activeConfig)
  if (groupIndex === -1) return
  const activeTab = tabs[groupIndex]
  if (!activeTab) return
  const offsetLeft = activeTab.offsetLeft
  const width = activeTab.offsetWidth

  indicator.style.width = `${width}px`
  indicator.style.transform = `translateX(${offsetLeft}px)`
  indicator.style.opacity = "1"

  if (window.lastActiveGroup !== (isXkeen ? "xkeen" : "core")) {
    indicator.style.transition = "none"
    setTimeout(() => {
      indicator.style.transition = ""
    }, 10)
  }
  window.lastActiveGroup = isXkeen ? "xkeen" : "core"
}

function closeDirtyModal() {
  pendingSwitchIndex = -1
  document.getElementById("dirtyModal").classList.remove("show")
}

async function saveAndSwitch() {
  if (pendingSwitchIndex !== -1) {
    await saveCurrentConfig()
    if (!configs[activeConfigIndex].isDirty) {
      const targetIndex = pendingSwitchIndex
      pendingSwitchIndex = -1
      closeDirtyModal()
      switchTab(targetIndex)
    }
  }
}

function discardAndSwitch() {
  if (pendingSwitchIndex !== -1) {
    const config = configs[activeConfigIndex]

    config.content = config.savedContent
    monacoEditor.setValue(config.savedContent)
    config.isDirty = false
    updateUIDirtyState()

    const targetIndex = pendingSwitchIndex
    pendingSwitchIndex = -1
    closeDirtyModal()
    switchTab(targetIndex)
  }
}

function switchTab(index) {
  if (index < 0 || index >= configs.length || index === activeConfigIndex) return

  const currentConfig = configs[activeConfigIndex]
  if (currentConfig && currentConfig.isDirty) {
    pendingSwitchIndex = index
    document.getElementById("dirtyModal").classList.add("show")
    return
  }

  activeConfigIndex = index
  saveLastSelectedTab()

  const config = configs[index]
  const formatBtn = document.getElementById("formatBtn")
  const formatDropdownBtn = document.getElementById("formatDropdownBtn")

  if (config) {
    const language = getFileLanguage(config.filename)
    isCurrentFileJson = language === "json"

    if (formatBtn) formatBtn.disabled = !(language === "json" || language === "yaml")
    if (formatDropdownBtn) formatDropdownBtn.disabled = !(language === "json" || language === "yaml")
  }

  if (monacoEditor && config) {
    const language = getFileLanguage(config.filename)
    monacoEditor.setValue(config.content)
    monaco.editor.setModelLanguage(monacoEditor.getModel(), language)
    config.isDirty = false
  }

  const editorContainer = document.getElementById("editorContainer")
  if (editorContainer) editorContainer.style.display = "block"

  const guiRoutingContainer = document.getElementById("guiRoutingContainer")
  if (guiRoutingContainer) guiRoutingContainer.style.display = "none"

  const guiLogContainer = document.getElementById("guiLogContainer")
  if (guiLogContainer) guiLogContainer.style.display = "none"

  document.querySelector(".tabs-content")?.classList.remove("no-border")

  applyGUIState()
  renderTabs()
  updateUIDirtyState()

  const validationInfo = document.getElementById("validationInfo")
  if (validationInfo) validationInfo.style.display = "flex"

  if (config && getFileLanguage(config.filename) === "json") {
    const model = monacoEditor.getModel()
    if (model) {
      const markers = monaco.editor.getModelMarkers({ owner: "json" })
      const errorMarker = markers.find((m) => m.severity === monaco.MarkerSeverity.Error)
      updateValidationInfo(!errorMarker, errorMarker ? errorMarker.message : null)
    }
  }

  updateUIDirtyState()
}

async function apiCall(endpoint, data = null) {
  try {
    const options = {
      method: data ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
    }
    if (data) options.body = JSON.stringify(data)

    const response = await fetch(`/cgi/${endpoint}`, options)

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` }
    }

    const result = await response.json()
    return result
  } catch (error) {
    console.error("API Error:", error)
    return { success: false, error: error.message }
  }
}

async function loadConfigs() {
  const tabsList = document.getElementById("tabsList")
  isConfigsLoading = true
  if (tabsList) tabsList.classList.add("empty")
  renderTabs()
  const result = await apiCall("configs")
  if (result.success && result.configs) {
    configs = result.configs.map((c) => ({
      ...c,
      savedContent: c.content,
      isDirty: false,
    }))
    if (configs.length > 0) {
      isConfigsLoading = false
      if (tabsList) tabsList.classList.remove("empty")
      requestAnimationFrame(() => {
        setTimeout(() => {
          const savedIndex = loadLastSelectedTab()
          switchTab(savedIndex)
        }, 100)
        requestAnimationFrame(() => {
          updateActiveTabIndicator()
          if (monacoEditor) {
            monacoEditor.layout()
          }
        })
      })
    } else {
      isConfigsLoading = false
      renderTabs()
      updateUIDirtyState()
    }
  } else {
    isConfigsLoading = false
    showToast("Ошибка загрузки конфигураций", "error")
    renderTabs()
    updateUIDirtyState()
  }
  updateDashboardLink()
}

function isFileValid() {
  if (!monacoEditor) return false

  const currentConfig = configs[activeConfigIndex]
  if (!currentConfig) return false

  const language = getFileLanguage(currentConfig.filename)

  if (language === "json") {
    const model = monacoEditor.getModel()
    if (!model) return true

    const markers = monaco.editor.getModelMarkers({ owner: "json" })
    return !markers.some((m) => m.resource.toString() === model.uri.toString() && m.severity === monaco.MarkerSeverity.Error)
  } else if (language === "yaml") {
    try {
      jsyaml.load(monacoEditor.getValue())
      return true
    } catch (e) {
      return false
    }
  }

  return true
}

async function saveCurrentConfig() {
  if (activeConfigIndex < 0 || !configs[activeConfigIndex] || !monacoEditor) return

  const config = configs[activeConfigIndex]
  const content = monacoEditor.getValue()

  if (!content.trim()) {
    showToast("Конфигурация пустая", "error")
    return
  }

  if (!isFileValid()) {
    showToast("Невозможно сохранить: файл содержит ошибки", "error")
    return
  }

  const result = await apiCall("configs", {
    action: "save",
    filename: config.filename,
    content: content,
  })

  if (result.success) {
    config.content = content
    config.savedContent = content
    config.isDirty = false
    updateUIDirtyState()
    showToast(`Конфигурация "${config.name}" сохранена`)
  } else {
    showToast(`Ошибка сохранения: ${result.error}`, "error")
  }
}

function hasCriticalChanges(oldContent, newContent, language) {
  try {
    if (language === "yaml") {
      const oldConfig = jsyaml.load(oldContent)
      const newConfig = jsyaml.load(newContent)
      const criticalFields = ["listeners", "redir-port", "tproxy-port"]

      for (const field of criticalFields) {
        const oldValue = JSON.stringify(oldConfig?.[field])
        const newValue = JSON.stringify(newConfig?.[field])
        if (oldValue !== newValue) {
          return true
        }
      }
      return false
    } else if (language === "json") {
      const strip = (s) => s.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")
      const oldConfig = JSON.parse(strip(oldContent))
      const newConfig = JSON.parse(strip(newContent))
      const clean = (inb) => (inb || []).map(({ sniffing, ...rest }) => rest)
      const oldInbounds = JSON.stringify(clean(oldConfig?.inbounds))
      const newInbounds = JSON.stringify(clean(newConfig?.inbounds))

      return oldInbounds !== newInbounds
    }
  } catch (e) {
    console.error("Error checking critical changes:", e)
    return false
  }

  return false
}

async function saveAndRestart() {
  if (activeConfigIndex < 0 || !configs[activeConfigIndex] || !monacoEditor) return

  const config = configs[activeConfigIndex]
  const content = monacoEditor.getValue()

  if (!content.trim()) return showToast("Конфиг пустой", "error")
  if (!isFileValid()) return showToast("Невозможно сохранить: файл содержит ошибки", "error")

  const result = await apiCall("configs", {
    action: "save",
    filename: config.filename,
    content: content,
  })

  if (!result.success) {
    showToast(`Ошибка сохранения: ${result.error}`, "error")
    return
  }

  const language = getFileLanguage(config.filename)
  const needsFullRestart = hasCriticalChanges(config.savedContent, content, language)

  config.content = content
  config.savedContent = content
  config.isDirty = false
  updateUIDirtyState()
  updateDashboardLink()

  try {
    let restartResult
    if (language === "json" || language === "yaml") {
      if (needsFullRestart) {
        setPendingState("Перезапуск сервиса...")
        restartResult = await apiCall("control", { action: "restart" })
      } else {
        restartResult = await apiCall("control", { action: "restartCore", core: currentCore })
      }
    } else {
      setPendingState("Перезапуск сервиса...")
      restartResult = await apiCall("control", { action: "restart" })
    }

    if (!restartResult || !restartResult.success) {
      showToast(`Ошибка перезапуска: ${restartResult?.error || "unknown"}`, "error")
      isActionInProgress = false
      checkXKeenStatus()
      return
    }

    showToast(`Изменения успешно применены`)

    isActionInProgress = false
    isServiceRunning = true
    updateServiceStatus(true)
  } catch (e) {
    showToast("Ошибка перезапуска", "error")
    isActionInProgress = false
    checkXKeenStatus()
  }
}

function formatCurrentConfig() {
  if (!monacoEditor) return

  const formatAction = monacoEditor.getAction("editor.action.formatDocument")
  if (formatAction) {
    formatAction.run()
  }
}

function formatCurrentConfig() {
  if (!monacoEditor) return

  const formatAction = monacoEditor.getAction("editor.action.formatDocument")
  if (formatAction) {
    formatAction.run()
  }
}

async function checkXKeenStatus() {
  if (isActionInProgress) return
  const result = await apiCall("status")
  updateServiceStatus(result.running)
}

async function startXKeen() {
  try {
    setPendingState("Запуск сервиса...")
    const result = await apiCall("control", { action: "start" })
    if (result.success) {
      showToast("XKeen запущен")
      isActionInProgress = false
      isServiceRunning = true
      updateServiceStatus(true)
    } else {
      showToast(`Ошибка запуска: ${result.output || result.error}`, "error")
      isActionInProgress = false
      checkXKeenStatus()
    }
  } catch (e) {
    isActionInProgress = false
    checkXKeenStatus()
  }
}

async function stopXKeen() {
  try {
    setPendingState("Остановка сервиса...")
    const result = await apiCall("control", { action: "stop" })
    if (result.success) {
      showToast("XKeen остановлен")
      isServiceRunning = false
      updateServiceStatus(false)
    } else {
      showToast(`Ошибка остановки: ${result.output || result.error}`, "error")
    }
  } finally {
    isActionInProgress = false
    checkXKeenStatus()
  }
}

async function restartXKeen() {
  try {
    setPendingState("Перезапуск сервиса...")
    const result = await apiCall("control", { action: "restart" })
    if (result.success) {
      showToast("XKeen перезапущен")
      isActionInProgress = false
      isServiceRunning = true
      updateServiceStatus(true)
      updateDashboardLink()
    } else {
      showToast(`Ошибка перезапуска: ${result.output || result.error}`, "error")
      isActionInProgress = false
      checkXKeenStatus()
    }
  } catch (e) {
    isActionInProgress = false
    checkXKeenStatus()
  }
}

async function clearCurrentLog() {
  if (!currentLogFile) {
    showToast("Не выбран файл журнала", "error")
    return
  }

  try {
    const result = await apiCall("logs", {
      action: "clear",
      file: currentLogFile,
    })

    if (result.success) {
      allLogLines = []
      displayLines = []

      const container = document.getElementById("logsContainer")
      container.classList.add("centered")
      container.innerHTML = '<div style="color: #6b7280;">Лог очищен</div>'

      showToast(`Лог ${currentLogFile} очищен`)
    } else {
      showToast(`Ошибка очистки лога: ${result.error}`, "error")
    }
  } catch (error) {
    showToast(`Ошибка: ${error.message}`, "error")
  }
}

async function getAvailableCores() {
  try {
    const result = await apiCall("control")
    if (result.success) {
      availableCores = result.cores || []
      currentCore = result.currentCore || "xray"

      const coreSelectRoot = document.getElementById("coreSelectRoot")
      const coreSelectLabel = document.getElementById("coreSelectLabel")

      coreSelectLabel.textContent = currentCore

      if (availableCores.length >= 2) {
        coreSelectRoot.style.display = "inline-block"

        const items = document.querySelectorAll("#coreSelectContent .select-item")
        items.forEach((item) => {
          const value = item.getAttribute("data-value")
          item.setAttribute("aria-selected", value === currentCore ? "true" : "false")
        })
      }
    }
  } catch (error) {
    console.error("Error loading cores:", error)
  }
}

function closeCoreModal() {
  pendingCoreChange = ""
  document.getElementById("coreModal").classList.remove("show")
}

async function confirmCoreChange() {
  const selectedCoreElement = document.getElementById("selectedCore")
  const selectedCore = selectedCoreElement ? selectedCoreElement.textContent : ""

  if (!selectedCore || (selectedCore !== "xray" && selectedCore !== "mihomo")) {
    showToast("Ошибка: не выбрано ядро", "error")
    return
  }

  currentCore = selectedCore
  const coreSelectLabel = document.getElementById("coreSelectLabel")
  if (coreSelectLabel) {
    coreSelectLabel.textContent = currentCore
  }

  const items = document.querySelectorAll("#coreSelectContent .select-item")
  items.forEach((item) => {
    const value = item.getAttribute("data-value")
    if (item && value) {
      item.setAttribute("aria-selected", value === currentCore ? "true" : "false")
    }
  })
  closeCoreModal()
  setPendingState("Переключение ядра...")

  try {
    console.log("Sending API request with core:", selectedCore)
    const result = await apiCall("control", { action: "switchCore", core: selectedCore })

    console.log("API response:", result)

    if (result.success) {
      showToast(`Ядро изменено на ${selectedCore}`)
      const coreSelectLabel = document.getElementById("coreSelectLabel")
      if (coreSelectLabel) {
        coreSelectLabel.textContent = currentCore
      }

      const items = document.querySelectorAll("#coreSelectContent .select-item")
      items.forEach((item) => {
        const value = item.getAttribute("data-value")
        if (item && value) {
          item.setAttribute("aria-selected", value === currentCore ? "true" : "false")
        }
      })

      isActionInProgress = false

      setTimeout(() => {
        checkXKeenStatus().then(() => {
          console.log("Status checked after core change")
          forceReloadConfigs()
        })
      }, 100)
    } else {
      showToast(`Ошибка смены ядра: ${result.error}`, "error")
      isActionInProgress = false
      checkXKeenStatus()
    }
  } catch (error) {
    console.error("Core change error:", error)
    showToast(`Ошибка: ${error.message}`, "error")
    isActionInProgress = false
    checkXKeenStatus()
  }
}

function parseDashboardPort(yamlContent) {
  const match = yamlContent.match(/^external-controller:\s*[\w\.-]+:(\d+)/m)
  return match ? match[1] : null
}

function updateDashboardLink() {
  const dashboardLink = document.getElementById("dashboardLink")
  if (currentCore === "mihomo") {
    const mihomoConfig = configs.find((c) => c.filename === "config.yaml")
    if (mihomoConfig) {
      const port = parseDashboardPort(mihomoConfig.content)
      if (port) {
        dashboardPort = port
        dashboardLink.style.display = "inline-flex"
        dashboardLink.href = `http://${window.location.hostname}:${port}/ui`
        return
      }
    }
  }
  dashboardLink.style.display = "none"
}

const SUPPORTED_IMPORT_PROTOCOLS = ["ss://", "vless://", "vmess://", "hysteria2://", "http://", "https://", "trojan://"]

function checkImportURIInput() {
  const uri = document.getElementById("importInput").value.trim()
  const generateBtn = document.getElementById("generateBtn")

  if (!generateBtn) return

  if (uri.length === 0) {
    generateBtn.disabled = true
    return
  }

  const uriLower = uri.toLowerCase()
  const isValid = SUPPORTED_IMPORT_PROTOCOLS.some((protocol) => uriLower.startsWith(protocol))

  generateBtn.disabled = !isValid
}

document.addEventListener("DOMContentLoaded", () => {
  const logsContainer = document.getElementById("logsContainer")
  const logSelectRoot = document.getElementById("logSelectRoot")
  const logSelectTrigger = document.getElementById("logSelectTrigger")
  const logSelectContent = document.getElementById("logSelectContent")
  const logSelectLabel = document.getElementById("logSelectLabel")
  const logFilterInput = document.getElementById("logFilterInput")
  const tabsList = document.getElementById("tabsList")
  const coreSelectRoot = document.getElementById("coreSelectRoot")
  const coreSelectTrigger = document.getElementById("coreSelectTrigger")
  const coreSelectContent = document.getElementById("coreSelectContent")
  const logFilterClear = document.getElementById("logFilterClear")
  const importInput = document.getElementById("importInput")
  const importInputClear = document.getElementById("importInputClear")
  const scrollBtn = document.getElementById("scrollBottomBtn")

  if (tabsList) tabsList.classList.add("empty")
  isConfigsLoading = true
  isStatusLoading = true
  updateControlButtons()
  renderTabs()

  logsContainer.addEventListener("click", (e) => {
    const badge = e.target.closest(".log-badge")
    if (badge) {
      const filterText = badge.getAttribute("data-filter")
      if (filterText && logFilterInput) {
        logFilterInput.value = filterText
        logFilter = filterText
        logFilterClear.classList.add("show")
        applyFilter()
      }
    }
  })

  if (logFilterInput && logFilterClear) {
    let filterTimeout

    logFilterInput.addEventListener("input", () => {
      logFilterClear.classList.toggle("show", logFilterInput.value.length > 0)
      clearTimeout(filterTimeout)
      filterTimeout = setTimeout(() => {
        logFilter = logFilterInput.value || ""
        applyFilter()
      }, 100)
    })

    logFilterClear.addEventListener("click", () => {
      logFilterInput.value = ""
      logFilter = ""
      logFilterClear.classList.remove("show")
      applyFilter()
    })
  }

  if (scrollBtn && logsContainer) {
    scrollBtn.addEventListener("click", () => {
      logsContainer.scrollTo({ top: logsContainer.scrollHeight })
      userScrolled = false
    })

    logsContainer.addEventListener("scroll", () => {
      const isAtBottom = logsContainer.scrollTop + logsContainer.clientHeight >= logsContainer.scrollHeight - 5

      if (isAtBottom) {
        scrollBtn.style.pointerEvents = "none"
        scrollBtn.style.opacity = "0"
        scrollBtn.classList.remove("visible")
      } else {
        scrollBtn.style.pointerEvents = "auto"
        scrollBtn.style.opacity = ""
        scrollBtn.classList.add("visible")
      }
    })
  }

  if (importInput && importInputClear) {
    importInput.addEventListener("input", () => {
      importInputClear.classList.toggle("show", importInput.value.length > 0)
    })

    importInputClear.addEventListener("click", () => {
      importInput.value = ""
      importInputClear.classList.remove("show")
      importInput.focus()
      checkImportURIInput()
    })
  }

  const tabsScroll = document.querySelector(".tabs-scroll")
  if (tabsScroll) {
    tabsScroll.addEventListener(
      "wheel",
      (e) => {
        const canScroll = tabsScroll.scrollWidth > tabsScroll.clientWidth
        if (!canScroll) return
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault()
          tabsScroll.scrollLeft += e.deltaY
        }
      },
      { passive: false },
    )

    tabsScroll.addEventListener(
      "scroll",
      () => {
        requestAnimationFrame(() => updateActiveTabIndicator && updateActiveTabIndicator())
      },
      { passive: true },
    )
  }

  logsContainer.addEventListener("scroll", () => {
    const isAtBottom = logsContainer.scrollTop + logsContainer.clientHeight >= logsContainer.scrollHeight - 5
    userScrolled = !isAtBottom
  })

  function closeLogMenu() {
    logSelectRoot.classList.remove("select-open")
    logSelectTrigger.setAttribute("aria-expanded", "false")
  }

  function openLogMenu() {
    logSelectRoot.classList.add("select-open")
    logSelectTrigger.setAttribute("aria-expanded", "true")
  }

  function setActiveLogItem(value) {
    const items = logSelectContent.querySelectorAll(".select-item")
    items.forEach((el) => {
      const selected = el.getAttribute("data-value") === value
      el.setAttribute("aria-selected", selected ? "true" : "false")
    })
  }

  function applyLogSelection(value) {
    if (currentLogFile === value) return
    switchLogFile(value)
    logSelectLabel.textContent = value
    setActiveLogItem(value)
  }

  function closeCoreMenu() {
    coreSelectRoot.classList.remove("select-open")
    coreSelectTrigger.setAttribute("aria-expanded", "false")
  }

  function openCoreMenu() {
    coreSelectRoot.classList.add("select-open")
    coreSelectTrigger.setAttribute("aria-expanded", "true")
  }

  function applyCoreSelection(value) {
    if (!value) {
      console.error("Empty value provided to applyCoreSelection")
      return
    }

    if (value === currentCore) {
      console.log("Same core selected, ignoring")
      return
    }

    pendingCoreChange = value
    document.getElementById("selectedCore").textContent = value
    document.getElementById("coreModal").classList.add("show")
  }

  logSelectTrigger.addEventListener("click", (e) => {
    e.stopPropagation()
    const isOpen = logSelectRoot.classList.contains("select-open")
    if (isOpen) {
      closeLogMenu()
    } else {
      openLogMenu()
    }
  })

  logSelectContent.addEventListener("click", (e) => {
    const target = e.target.closest(".select-item")
    if (!target) return
    const value = target.getAttribute("data-value")
    applyLogSelection(value)
    closeLogMenu()
  })

  logSelectContent.addEventListener("mouseenter", () => {
    logSelectRoot.classList.add("select-hovering")
  })
  logSelectContent.addEventListener("mouseleave", () => {
    logSelectRoot.classList.remove("select-hovering")
  })

  coreSelectTrigger.addEventListener("click", (e) => {
    e.stopPropagation()
    const isOpen = coreSelectRoot.classList.contains("select-open")
    if (isOpen) {
      closeCoreMenu()
    } else {
      openCoreMenu()
    }
  })

  coreSelectContent.addEventListener("click", (e) => {
    const target = e.target.closest(".select-item")
    if (!target) return

    const value = target.getAttribute("data-value")

    applyCoreSelection(value)
    closeCoreMenu()
  })

  coreSelectContent.addEventListener("mouseenter", () => {
    coreSelectRoot.classList.add("select-hovering")
  })
  coreSelectContent.addEventListener("mouseleave", () => {
    coreSelectRoot.classList.remove("select-hovering")
  })

  document.addEventListener("click", (e) => {
    if (!logSelectRoot.contains(e.target)) {
      closeLogMenu()
    }
    if (!coreSelectRoot.contains(e.target)) {
      closeCoreMenu()
    }
  })

  logSelectTrigger.addEventListener("keydown", (e) => {
    const items = Array.from(logSelectContent.querySelectorAll(".select-item"))
    const currentIndex = items.findIndex((i) => i.getAttribute("data-value") === currentLogFile)
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!logSelectRoot.classList.contains("select-open")) openLogMenu()
      let nextIndex = currentIndex
      if (e.key === "ArrowDown") nextIndex = Math.min(items.length - 1, currentIndex + 1)
      if (e.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1)
      const nextItem = items[nextIndex]
      if (nextItem) {
        items.forEach((i) => (i.tabIndex = -1))
        nextItem.tabIndex = 0
        nextItem.focus()
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      if (logSelectRoot.classList.contains("select-open")) closeLogMenu()
      else openLogMenu()
    } else if (e.key === "Escape") {
      closeLogMenu()
    }
  })

  logSelectContent.addEventListener("keydown", (e) => {
    const items = Array.from(logSelectContent.querySelectorAll(".select-item"))
    let idx = items.indexOf(document.activeElement)
    if (e.key === "ArrowDown") {
      e.preventDefault()
      idx = Math.min(items.length - 1, idx + 1)
      items[idx].focus()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      idx = Math.max(0, idx - 1)
      items[idx].focus()
    } else if (e.key === "Enter") {
      e.preventDefault()
      const value = document.activeElement.getAttribute("data-value")
      if (value) applyLogSelection(value)
      closeLogMenu()
    } else if (e.key === "Escape") {
      closeLogMenu()
      logSelectTrigger.focus()
    }
  })

  logSelectLabel.textContent = currentLogFile
  setActiveLogItem(currentLogFile)

  if (importInput) {
    importInput.addEventListener("input", () => {
      const importInputClear = document.getElementById("importInputClear")
      if (importInputClear) {
        importInputClear.classList.toggle("show", importInput.value.length > 0)
      }
      checkImportURIInput()
    })
    setTimeout(checkImportURIInput, 100)
  }

  if (importInput) {
    importInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        const generateBtn = document.getElementById("generateBtn")
        if (generateBtn && !generateBtn.disabled) {
          generateConfig()
        }
      }
    })
  }

  init().catch((error) => {
    console.error("App initialization failed:", error)
  })
})

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault()
    const saveBtn = document.getElementById("saveBtn")
    if (!saveBtn.disabled) {
      saveCurrentConfig()
    }
  }
})

async function forceReloadConfigs() {
  console.log("Force reloading configs...")
  isConfigsLoading = true
  const tabsList = document.getElementById("tabsList")
  if (tabsList) tabsList.classList.add("empty")
  renderTabs()
  configs = []
  activeConfigIndex = -1
  await new Promise((resolve) => setTimeout(resolve, 500))
  const result = await apiCall("configs")
  if (result.success && result.configs) {
    configs = result.configs.map((c) => ({
      ...c,
      savedContent: c.content,
      isDirty: false,
    }))

    if (configs.length > 0) {
      isConfigsLoading = false
      if (tabsList) tabsList.classList.remove("empty")
      switchTab(0)
      console.log("Configs reloaded successfully, count:", configs.length)
    } else {
      isConfigsLoading = false
      renderTabs()
      updateUIDirtyState()
      console.log("No configs found after reload")
    }
  } else {
    isConfigsLoading = false
    showToast("Ошибка загрузки конфигов после смены ядра", "error")
    renderTabs()
    updateUIDirtyState()
    console.error("Failed to reload configs:", result.error)
  }
  updateUIDirtyState()
  updateDashboardLink()
}

function saveLastSelectedTab() {
  if (activeConfigIndex >= 0 && configs[activeConfigIndex]) {
    localStorage.setItem("lastSelectedTab", configs[activeConfigIndex].filename)
  }
}

function loadLastSelectedTab() {
  const savedFilename = localStorage.getItem("lastSelectedTab")
  if (!savedFilename) return 0
  const index = configs.findIndex((c) => c.filename === savedFilename)
  return index >= 0 ? index : 0
}

function toggleFormatMenu(e) {
  if (e) e.stopPropagation()
  document.getElementById("formatMenu").classList.toggle("show")
}

const configTemplates = {
  xray: [
    {
      name: "Log",
      url: "https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/xray/01_log.json",
    },
    {
      name: "Inbounds (Режим Mixed)",
      url: "https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/xray/03_inbounds_mixed.json",
    },
    {
      name: "Inbounds (Режим TProxy)",
      url: "https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/xray/03_inbounds_tproxy.json",
    },
    {
      name: "Outbounds",
      url: "https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/xray/04_outbounds.json",
    },
    {
      name: "Routing (только заблокированное, zkeen)",
      url: "https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/xray/05_routing_1.json",
    },
    {
      name: "Routing (все в прокси, кроме RU)",
      url: "https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/xray/05_routing_2.json",
    },
    {
      name: "Policy",
      url: "https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/xray/06_policy.json",
    },
  ],
  mihomo: [
    {
      name: "Сonfig (только заблокированное, refilter)",
      url: "https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/mihomo/config.yaml",
    },
  ],
}

let selectedTemplateUrl = null

function openTemplateImportModal() {
  const modal = document.getElementById("templateImportModal")
  const templateList = document.getElementById("templateList")
  const importBtn = document.getElementById("importTemplateBtn")
  const description = document.getElementById("templateModalDescription")
  const countBadge = document.getElementById("templateCountBadge")

  selectedTemplateUrl = null
  importBtn.disabled = true

  const templates = configTemplates[currentCore] || []

  if (countBadge) {
    countBadge.textContent = templates.length
  }

  const coreLabel = currentCore === "xray" ? "Xray" : "Mihomo"
  description.innerHTML = `Выберите готовый шаблон конфигурации для <span style="color: #3b82f6; font-weight: 600;">${coreLabel}</span>`

  if (templates.length === 0) {
    templateList.innerHTML = `
      <div class="template-list-empty">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"></path>
          <polyline points="13 2 13 9 20 9"></polyline>
        </svg>
        <p>Нет доступных шаблонов для текущего ядра</p>
      </div>
    `
    modal.classList.add("show")
    return
  }

  templateList.innerHTML = templates
    .map(
      (template, index) => `
    <div class="template-item" onclick="selectTemplate('${template.url}', ${index})">
      <span class="template-label">${template.name}</span>
    </div>
  `,
    )
    .join("")

  modal.classList.add("show")

  if (templates.length > 0) {
    setTimeout(() => selectTemplate(templates[0].url, 0), 0)
  }
}

function closeTemplateImportModal() {
  const modal = document.getElementById("templateImportModal")
  modal.classList.remove("show")
  selectedTemplateUrl = null
}

function selectTemplate(url, index) {
  selectedTemplateUrl = url
  const importBtn = document.getElementById("importTemplateBtn")
  importBtn.disabled = false

  const items = document.querySelectorAll(".template-item")
  items.forEach((item, i) => {
    if (i === index) {
      item.classList.add("selected")
    } else {
      item.classList.remove("selected")
    }
  })
}

async function importSelectedTemplate() {
  if (!selectedTemplateUrl) {
    showToast("Выберите шаблон для импорта", "error")
    return
  }

  const currentConfig = configs[activeConfigIndex]
  if (currentConfig && currentConfig.isDirty) {
    const confirmed = confirm(
      "Внимание! Текущий файл содержит несохраненные изменения.\n\n" +
        "При импорте шаблона все текущее содержимое файла будет заменено.\n\n" +
        "Продолжить импорт?",
    )
    if (!confirmed) {
      return
    }
  }

  const importBtn = document.getElementById("importTemplateBtn")
  importBtn.disabled = true
  importBtn.textContent = "Загрузка..."

  try {
    const response = await fetch(selectedTemplateUrl)
    if (!response.ok) {
      throw new Error(`Ошибка загрузки: ${response.status} ${response.statusText}`)
    }

    const templateContent = await response.text()

    if (monacoEditor) {
      monacoEditor.setValue(templateContent)

      if (configs[activeConfigIndex]) {
        configs[activeConfigIndex].content = templateContent
        configs[activeConfigIndex].isDirty = true
        configs[activeConfigIndex].isValid = true
      }

      updateUIDirtyState()
      renderTabs()

      showToast("Шаблон успешно импортирован", "success")
      closeTemplateImportModal()
      syncJSONToGUI()
    } else {
      throw new Error("Редактор не инициализирован")
    }
  } catch (error) {
    console.error("Ошибка импорта шаблона:", error)
    showToast(`Ошибка импорта шаблона: ${error.message}`, "error")
  } finally {
    importBtn.disabled = false
    importBtn.textContent = "Импортировать"
  }
}

function openImportModal() {
  const modal = document.getElementById("importModal")
  modal.classList.add("show")
  modal.querySelector(".modal-content").classList.remove("expanded")
  document.getElementById("importResult").style.display = "none"
  document.getElementById("importInputClear").classList.remove("show")
  document.getElementById("copyBtn").style.display = "none"
  document.getElementById("addBtn").style.display = "none"

  const btn = document.getElementById("generateBtn")
  btn ? (btn.disabled = true) : null

  const importInput = document.getElementById("importInput")
  importInput.value = ""
  setTimeout(() => {
    importInput.focus()
  }, 100)
}

function closeImportModal() {
  document.getElementById("importModal").classList.remove("show")
}

let importEditor = null

function generateConfig() {
  const uri = document.getElementById("importInput").value.trim()
  if (!uri) {
    showToast("Поле ввода не может быть пустым", "error")
    return
  }

  try {
    const existingConfig = monacoEditor ? monacoEditor.getValue() : ""
    const result = generateConfigForCore(uri, currentCore, existingConfig)
    const output = result.content

    const modalContent = document.getElementById("importModal").querySelector(".modal-content")
    modalContent.classList.add("expanded")
    document.getElementById("importResult").style.display = "block"

    const outputWrapper = document.querySelector("#importResult .output-wrapper")
    const container = document.getElementById("importOutput")
    if (container) container.style.display = "none"

    if (importEditor) {
      importEditor.dispose()
      importEditor = null
    }

    const copyBtn = document.getElementById("copyBtn")
    while (outputWrapper.firstChild) {
      outputWrapper.firstChild.remove()
    }
    if (copyBtn) outputWrapper.appendChild(copyBtn)

    outputWrapper.style.position = "relative"
    outputWrapper.style.height = "350px"
    outputWrapper.style.overflow = "hidden"
    outputWrapper.style.border = "1px solid #1e293b"
    outputWrapper.style.borderRadius = "8px"
    outputWrapper.style.background = "#080e1d"

    const innerContainer = document.createElement("div")
    innerContainer.style.margin = "16px"
    innerContainer.style.height = "calc(100% - 32px)"
    innerContainer.style.width = "calc(100% - 32px)"
    innerContainer.style.position = "relative"
    outputWrapper.appendChild(innerContainer)

    importEditor = monaco.editor.create(innerContainer, {
      value: output,
      language: currentCore === "xray" ? "json" : "yaml",
      theme: "tokyo-night",
      automaticLayout: true,
      readOnly: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: "JetBrains Mono, monospace, Noto Color Emoji",
      lineHeight: 1.5,
      lineNumbers: "off",
      scrollBeyondLastLine: false,
      wordWrap: "off",
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 0,
      lineNumbersMinChars: 3,
      renderLineHighlight: "none",
      renderIndentGuides: false,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      smoothScrolling: true,
      stickyScroll: { enabled: false },
      scrollbar: {
        vertical: "hidden",
        horizontal: "hidden",
        useShadows: false,
      },
    })

    importEditor.getModel().resultType = result.type

    if (copyBtn) copyBtn.style.display = "inline-flex"
    const addBtn = document.getElementById("addBtn")
    if (addBtn) addBtn.style.display = "inline-flex"
  } catch (e) {
    showToast(e.message, "error")
  }
}

function copyImportResult() {
  if (!importEditor) return
  const text = importEditor.getValue()
  const copyBtn = document.getElementById("copyBtn")
  const copyIcon = copyBtn.querySelector(".copy-icon")
  const checkIcon = copyBtn.querySelector(".check-icon")
  const ta = document.createElement("textarea")
  ta.value = text
  ta.style.position = "fixed"
  ta.style.left = "-9999px"
  document.body.appendChild(ta)
  ta.focus()
  ta.select()

  try {
    document.execCommand("copy")
    copyBtn.classList.add("copied")
    setTimeout(() => {
      copyBtn.classList.remove("copied")
      copyIcon.style.opacity = "1"
      copyIcon.style.transform = "scale(1)"
      checkIcon.style.display = "none"
    }, 2000)
    showToast("Скопировано в буфер")
  } catch (e) {
    showToast("Не удалось скопировать", "error")
  }

  document.body.removeChild(ta)
}

function addToOutbounds() {
  try {
    if (activeConfigIndex < 0 || !configs[activeConfigIndex]) {
      showToast("Нет активной конфигурации", "error")
      return
    }

    if (!monacoEditor) {
      showToast("Редактор не инициализирован", "error")
      return
    }

    const currentContent = monacoEditor.getValue()
    if (!importEditor) {
      showToast("Нечего добавлять", "error")
      return
    }
    const generatedConfig = importEditor.getValue()
    const resultType = importEditor.getModel().resultType || "outbound"

    if (currentCore === "xray") {
      let config
      try {
        config = JSON.parse(currentContent)
      } catch (e) {
        showToast("Ошибка парсинга конфигурации", "error")
        return
      }

      if (!config.outbounds || !Array.isArray(config.outbounds)) {
        showToast("Массив outbounds не найден", "error")
        return
      }

      let newOutbound
      try {
        newOutbound = JSON.parse(generatedConfig)
      } catch (e) {
        showToast("Ошибка парсинга сгенерированного конфига", "error")
        return
      }

      config.outbounds.unshift(newOutbound)

      const updatedConfig = JSON.stringify(config, null, 2)
      monacoEditor.setValue(updatedConfig)
      setTimeout(() => {
        const formatAction = monacoEditor.getAction("editor.action.formatDocument")
        if (formatAction) {
          formatAction.run().then(() => {
            configs[activeConfigIndex].content = monacoEditor.getValue()
            showToast("Outbound успешно добавлен", "success")
            const model = monacoEditor.getModel()
            const content = model.getValue()
            const lines = content.split("\n")
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes('"outbounds"')) {
                monacoEditor.revealLineInCenter(i + 1)
                break
              }
            }
          })
        } else {
          configs[activeConfigIndex].content = updatedConfig
          showToast("Outbound успешно добавлен", "success")
        }
      }, 50)
    } else if (currentCore === "mihomo") {
      let updatedContent = currentContent
      let scrollToLine = -1

      if (resultType === "proxy-provider") {
        const lines = updatedContent.split("\n")
        let insertIndex = -1
        let indent = 0
        let foundProxyProviders = false

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().startsWith("#")) continue
          if (lines[i].match(/^proxy-providers:\s*($|#)/)) {
            foundProxyProviders = true
            indent = lines[i].search(/\S/)
            for (let j = i + 1; j < lines.length; j++) {
              const line = lines[j]
              if (line.trim() === "") continue
              const lineIndent = line.search(/\S/)
              if (lineIndent !== -1 && lineIndent <= indent && !line.trim().startsWith("#")) {
                insertIndex = j
                break
              }
            }
            if (insertIndex === -1) insertIndex = lines.length
            break
          }
        }

        if (foundProxyProviders && insertIndex !== -1) {
          lines.splice(insertIndex, 0, generatedConfig)
          updatedContent = lines.join("\n")
          scrollToLine = insertIndex + 1
        } else {
          if (!updatedContent.endsWith("\n")) updatedContent += "\n"
          const beforeLength = updatedContent.split("\n").length
          updatedContent += "\nproxy-providers:\n" + generatedConfig
          scrollToLine = beforeLength + 2
        }

        showToast("Proxy provider успешно добавлен", "success")
      } else if (resultType === "proxy") {
        const lines = updatedContent.split("\n")
        let insertIndex = -1
        let indent = 0
        let foundProxies = false

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (line.trim().startsWith("#")) continue
          if (line.match(/^proxies:\s*($|#|\[)/)) {
            foundProxies = true
            indent = line.search(/\S/)
            for (let j = i + 1; j < lines.length; j++) {
              const nextLine = lines[j]
              if (nextLine.trim() === "") continue
              const lineIndent = nextLine.search(/\S/)
              if (lineIndent !== -1 && lineIndent <= indent && !nextLine.trim().startsWith("#")) {
                insertIndex = j
                break
              }
            }
            if (insertIndex === -1) insertIndex = lines.length
            break
          }
        }

        if (foundProxies && insertIndex !== -1) {
          lines.splice(insertIndex, 0, generatedConfig)
          updatedContent = lines.join("\n")
          scrollToLine = insertIndex + 1
        } else {
          if (!updatedContent.endsWith("\n")) updatedContent += "\n"
          const beforeLength = updatedContent.split("\n").length
          updatedContent += "\nproxies:\n" + generatedConfig
          scrollToLine = beforeLength + 2
        }

        showToast("Proxy успешно добавлен", "success")
      }

      monacoEditor.setValue(updatedContent)
      configs[activeConfigIndex].content = updatedContent

      if (scrollToLine > 0) {
        setTimeout(() => {
          monacoEditor.revealLineInCenter(scrollToLine)
          monacoEditor.setPosition({ lineNumber: scrollToLine, column: 1 })
        }, 100)
      }
    }

    closeImportModal()
  } catch (e) {
    showToast("Ошибка при добавлении: " + e.message, "error")
  }
}

document.addEventListener("click", (e) => {
  const menu = document.getElementById("formatMenu")
  if (menu && !e.target.closest(".btn-group")) {
    menu.classList.remove("show")
  }

  const tzSelect = document.getElementById("timezoneSelect")
  if (tzSelect && !tzSelect.contains(e.target)) {
    tzSelect.classList.remove("open")
  }

  if (e.target.classList.contains("modal-overlay")) {
    const id = e.target.id
    if (id === "settingsModal") closeSettingsModal()
    else if (id === "dirtyModal") closeDirtyModal()
    else if (id === "coreModal") closeCoreModal()
    else if (id === "importModal") closeImportModal()
    else if (id === "templateImportModal") closeTemplateImportModal()
  }
})

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const dirtyModal = document.getElementById("dirtyModal")
    const coreModal = document.getElementById("coreModal")
    const importModal = document.getElementById("importModal")
    const templateImportModal = document.getElementById("templateImportModal")
    const logsPanel = document.getElementById("logsPanel")

    if (logsPanel && logsPanel.classList.contains("expanded-vertical")) {
      toggleLogFullscreen()
      e.preventDefault()
    }

    if (settingsModal && settingsModal.classList.contains("show")) {
      closeSettingsModal()
      e.preventDefault()
    } else if (dirtyModal && dirtyModal.classList.contains("show")) {
      closeDirtyModal()
      e.preventDefault()
    } else if (coreModal && coreModal.classList.contains("show")) {
      closeCoreModal()
      e.preventDefault()
    } else if (templateImportModal && templateImportModal.classList.contains("show")) {
      closeTemplateImportModal()
      e.preventDefault()
    } else if (importModal && importModal.classList.contains("show")) {
      closeImportModal()
      e.preventDefault()
    }
  }
  if (e.key === "Enter") {
    const dirtyModal = document.getElementById("dirtyModal")
    const coreModal = document.getElementById("coreModal")
    const importModal = document.getElementById("importModal")
    const templateImportModal = document.getElementById("templateImportModal")

    if (dirtyModal && dirtyModal.classList.contains("show")) {
      saveAndSwitch()
      e.preventDefault()
    } else if (coreModal && coreModal.classList.contains("show")) {
      confirmCoreChange()
      e.preventDefault()
    } else if (templateImportModal && templateImportModal.classList.contains("show")) {
      if (selectedTemplateUrl) {
        importSelectedTemplate()
        e.preventDefault()
      }
    } else if (importModal && importModal.classList.contains("show")) {
      const importInput = document.getElementById("importInput")
      if (importInput.value.trim()) {
        if (generateBtn && !generateBtn.disabled) {
          generateConfig()
          e.preventDefault()
        }
      }
    }
  }
})

document.getElementById("fullscreenBackdrop")?.addEventListener("click", () => {
  const panel = document.getElementById("logsPanel")
  if (panel.classList.contains("expanded-vertical")) {
    toggleLogFullscreen()
  }
})

document.addEventListener("mousedown", (e) => {
  const panel = document.getElementById("logsPanel")
  if (!panel || !panel.classList.contains("expanded-vertical")) return
  const rect = panel.getBoundingClientRect()
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
    toggleLogFullscreen()
  }
})

function toggleSettingsModal() {
  const modal = document.getElementById("settingsModal")
  modal.classList.add("show")

  const routingCheckboxSettings = document.getElementById("guiRoutingCheckboxSettings")
  if (routingCheckboxSettings) {
    routingCheckboxSettings.checked = guiRoutingState.enabled
  }

  const autoApplyCheckbox = document.getElementById("autoApplyOutboundCheckbox")
  if (autoApplyCheckbox) {
    autoApplyCheckbox.checked = autoApplyOutbound
  }
}

function closeSettingsModal() {
  document.getElementById("settingsModal").classList.remove("show")
}

function saveGUIState() {
  localStorage.setItem("guiRouting_enabled", guiRoutingState.enabled ? "1" : "0")
}

function loadGUIState() {
  const saved = localStorage.getItem("guiRouting_enabled")
  return saved === "1"
}

async function loadTimezone() {
  try {
    const result = await apiCall("settings")
    if (result.success && result.timezoneOffset !== undefined) {
      currentTimezone = result.timezoneOffset
      updateTimezoneLabel()
    } else {
      console.error("Failed to load timezone:", result)
      currentTimezone = 3
      updateTimezoneLabel()
    }
  } catch (e) {
    console.error("Error loading timezone:", e)
    currentTimezone = 3
    updateTimezoneLabel()
  }
}

function updateTimezoneLabel() {
  const label = document.getElementById("timezoneLabel")
  if (!label) return
  const sign = currentTimezone >= 0 ? "+" : ""
  label.textContent = `UTC${sign}${currentTimezone}`
}

function toggleTimezoneSelect() {
  const select = document.getElementById("timezoneSelect")
  const dropdown = document.getElementById("timezoneDropdown")

  if (!dropdown.hasChildNodes()) {
    for (let i = -12; i <= 14; i++) {
      const option = document.createElement("div")
      option.className = "custom-select-option"
      option.dataset.value = i
      const sign = i >= 0 ? "+" : ""
      option.innerHTML = `UTC${sign}${i}`
      if (i === currentTimezone) option.classList.add("selected")
      option.onclick = () => selectTimezone(i)
      dropdown.appendChild(option)
    }
  }

  select.classList.toggle("open")
  if (select.classList.contains("open")) {
    setTimeout(() => {
      const selectedOption = dropdown.querySelector(".custom-select-option.selected")
      if (selectedOption) {
        selectedOption.scrollIntoView({ block: "center", behavior: "instant" })
      }
    }, 10)
  }
}

async function selectTimezone(offset) {
  try {
    console.log("Selecting timezone:", offset)
    const result = await apiCall("settings", { timezoneOffset: offset })

    if (result.success) {
      currentTimezone = offset
      updateTimezoneLabel()

      const options = document.querySelectorAll("#timezoneDropdown .custom-select-option")
      options.forEach((opt) => {
        opt.classList.toggle("selected", parseInt(opt.dataset.value) === offset)
      })

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "reload",
          }),
        )
      }

      showToast("Часовой пояс обновлён")
      document.getElementById("timezoneSelect").classList.remove("open")
    } else {
      console.error("Timezone update failed:", result)
      showToast(result.error || "Ошибка обновления", "error")
    }
  } catch (e) {
    console.error("Error updating timezone:", e)
    showToast("Ошибка обновления часового пояса", "error")
  }
}

document.addEventListener("click", (e) => {
  const select = document.getElementById("timezoneSelect")
  if (select && !select.contains(e.target)) {
    select.classList.remove("open")
  }
})

function toggleAutoApply() {
  const checkbox = document.getElementById("autoApplyCheckbox")
  if (checkbox) {
    autoApply = checkbox.checked
    localStorage.setItem("autoApply", autoApply ? "1" : "0")
  }
}

function applyGUIState() {
  if (!monacoEditor) return
  const editorContainer = document.getElementById("editorContainer")
  const routingContainer = document.getElementById("guiRoutingContainer")
  const logContainer = document.getElementById("guiLogContainer")
  const tabsContent = document.querySelector(".tabs-content")

  if (!editorContainer) return

  const config = configs[activeConfigIndex]
  if (!config) return

  const filenameLower = config.filename.toLowerCase()
  const isRouting = filenameLower.includes("routing")
  const isLog = filenameLower.includes("log")

  editorContainer.style.display = "none"
  if (routingContainer) routingContainer.style.display = "none"
  if (logContainer) logContainer.style.display = "none"
  tabsContent?.classList.remove("no-border")

  if (isRouting && guiRoutingState.enabled) {
    applyGuiRoutingState()
  } else if (isLog && guiLogState.enabled) {
    applyGuiLogState()
  } else {
    editorContainer.style.display = "block"
    tabsContent?.classList.remove("no-border")
  }
}
