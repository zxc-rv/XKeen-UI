let monacoEditor;
let configs = [];
let activeConfigIndex = -1;
let isServiceRunning = false;
let isActionInProgress = false;
let userScrolled = false;
let pendingSwitchIndex = -1;
let currentLogFile = "error.log";
let isConfigsLoading = true;
let logFilter = "";
let isStatusLoading = true;
let ws = null;
let pingInterval = null;
let allLogLines = [];
let displayLines = [];
let availableCores = [];
let currentCore = "";
let pendingCoreChange = "";
let isCurrentFileJson = false;
let dashboardPort = null;

function getFileLanguage(filename) {
  if (filename.endsWith(".json")) return "json";
  if (filename.endsWith(".yaml") || filename.endsWith(".yml")) return "yaml";
  if (filename.endsWith(".lst")) return "plaintext";
  return "json";
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  const icons = {
    success: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="toast-icon success"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>`,
    error: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="toast-icon error"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg>`,
  };

  if (typeof message === "object" && message.title && message.body) {
    toast.innerHTML = `
      <div class="toast-header">
        ${icons[type] || icons.success}
        <div class="toast-title">${message.title}</div>
      </div>
      <div class="toast-body">${message.body}</div>
    `;
  } else {
    toast.innerHTML = `
      <div class="toast-header">
        ${icons[type] || icons.success}
        <div class="toast-title">${type === "error" ? "Ошибка" : "Успех"}</div>
      </div>
      <div class="toast-body">${message}</div>
    `;
  }

  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add("show"), 100);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => document.body.removeChild(toast), 300);
  }, 3000);
}

function updateValidationInfo(isValid, error = null) {
  const validationInfo = document.getElementById("validationInfo");
  const messageContainer = document.getElementById(
    "validationMessageContainer",
  );
  const currentConfig = configs[activeConfigIndex];

  // Показываем/скрываем только контейнер с сообщением, а не весь блок
  const shouldShowMessage =
    currentConfig && getFileLanguage(currentConfig.filename) === "json";

  if (!shouldShowMessage) {
    // Скрываем только контейнер с сообщением
    messageContainer.style.display = "none";

    // Показываем кнопки управления редактором
    const editorControls = document.querySelector(".editor-controls");
    if (editorControls) {
      editorControls.style.display = "flex";
    }
  } else {
    // Показываем контейнер с сообщением
    messageContainer.style.display = "flex";

    // Обновляем содержимое сообщения
    if (isValid) {
      messageContainer.innerHTML = `
        <span class="validation-icon validation-success">✓</span>
        <span class="validation-success">JSON валиден</span>
      `;
    } else {
      messageContainer.innerHTML = `
        <span class="validation-icon validation-error">✗</span>
        <span class="validation-error"> Ошибка валидации: ${
          error || "Файл невалиден"
        }</span>
      `;
    }
  }
}

function updateControlButtons() {
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const restartBtn = document.getElementById("restartBtn");
  const controlsSkeletons = document.getElementById("controlsSkeletons");

  if (isStatusLoading) {
    if (controlsSkeletons) controlsSkeletons.style.display = "inline-flex";
    startBtn.style.display = "none";
    stopBtn.style.display = "none";
    restartBtn.style.display = "none";
    return;
  }

  if (isActionInProgress) {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    restartBtn.disabled = true;
    return;
  }

  if (controlsSkeletons) controlsSkeletons.style.display = "none";
  startBtn.style.display = isServiceRunning ? "none" : "inline-flex";
  stopBtn.style.display = isServiceRunning ? "inline-flex" : "none";
  restartBtn.style.display = isServiceRunning ? "inline-flex" : "none";

  startBtn.disabled = false;
  stopBtn.disabled = false;
  restartBtn.disabled = false;
}

function setPendingState(actionText) {
  isActionInProgress = true;
  const indicator = document.getElementById("statusIndicator");
  const text = document.getElementById("statusText");

  indicator.className = "status status-pending";
  text.textContent = actionText;
  updateControlButtons();
}

function parseLogLine(line) {
  if (!line.trim()) return null;

  let processedLine = line;
  let className = "log-line";

  processedLine = processedLine
    .replace(
      /\u001b\[32m(.*?)\u001b\[0m/g,
      '<span style="color: #10b981;">$1</span>',
    )
    .replace(
      /\u001b\[33m(.*?)\u001b\[0m/g,
      '<span style="color: #f59e0b;">$1</span>',
    )
    .replace(
      /\u001b\[31m(.*?)\u001b\[0m/g,
      '<span style="color: #ef4444;">$1</span>',
    )
    .replace(
      /\u001b\[36m(.*?)\u001b\[0m/g,
      '<span style="color: #06b6d4;">$1</span>',
    )
    .replace(/\u001b\[\d+m/g, "");

  processedLine = processedLine
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;span style="color: #[\w\d]+;"&gt;/g, (match) =>
      match.replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    )
    .replace(/&lt;\/span&gt;/g, "</span>");

  processedLine = processedLine
    .replace(/\[Info\]/g, '<span style="color: #3b82f6;">[Info]</span>')
    .replace(/\[Warning\]/g, '<span style="color: #f59e0b;">[Warning]</span>')
    .replace(/\[Error\]/g, '<span style="color: #ef4444;">[Error]</span>')
    .replace(/level=(info)/gi, 'level=<span style="color: #3b82f6;">$1</span>')
    .replace(
      /level=(warning)/gi,
      'level=<span style="color: #f59e0b;">$1</span>',
    )
    .replace(/level=(error)/gi, 'level=<span style="color: #ef4444;">$1</span>')
    .replace(
      /level=(fatal)/gi,
      'level=<span style="color: #dc2626;">$1</span>',
    );

  return { className, content: processedLine };
}

function updateServiceStatus(running) {
  const indicator = document.getElementById("statusIndicator");
  const text = document.getElementById("statusText");

  isServiceRunning = running;
  isStatusLoading = false;

  if (running) {
    indicator.className = "status status-running";
    text.textContent = "Сервис запущен";
  } else {
    indicator.className = "status status-stopped";
    text.textContent = "Сервис остановлен";
  }

  updateControlButtons();
}

function renderLines(container, lines) {
  const wasAtBottom =
    container.scrollTop + container.clientHeight >= container.scrollHeight - 5;

  if (lines.length === 0) {
    container.classList.add("centered");
    container.innerHTML = '<div style="color: #6b7280;">Журнал пуст</div>';
    return;
  }

  container.classList.remove("centered");
  const processedLines = lines
    .map((line) => {
      const parsed = parseLogLine(line);
      return parsed
        ? `<div class="${parsed.className}">${parsed.content}</div>`
        : "";
    })
    .filter(Boolean);

  container.innerHTML = processedLines.join("");

  if (wasAtBottom && !userScrolled) {
    container.scrollTop = container.scrollHeight;
  }
}

function applyFilter() {
  if (!logFilter || logFilter.trim() === "") {
    displayLines = allLogLines.slice(-1000);
    renderLines(document.getElementById("logsContainer"), displayLines);
  } else {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "filter",
          query: logFilter,
        }),
      );
    }
  }
}

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }

  if (pingInterval) {
    clearInterval(pingInterval);
  }

  ws = new WebSocket(
    `ws://${window.location.hostname}:8080/ws?file=${currentLogFile}`,
  );

  ws.onopen = () => {
    console.log("WebSocket connected");
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 15000);
  };

  ws.onclose = (event) => {
    console.warn(
      `WebSocket disconnected: ${event.code} (${event.reason}). Reconnecting in 1 seconds...`,
    );
    clearInterval(pingInterval);
    setTimeout(connectWebSocket, 1000);
  };

  ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    ws.close();
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "pong") return;

    if (data.error) {
      console.error("WebSocket error:", data.error);
      const container = document.getElementById("logsContainer");
      container.classList.add("centered");
      container.innerHTML = `<div style="color: #ef4444;">Ошибка WebSocket: ${data.error}</div>`;
      return;
    }

    if (data.type === "initial") {
      allLogLines = data.allLines || [];
      displayLines = data.displayLines || [];
      renderLines(document.getElementById("logsContainer"), displayLines);

      if (logFilter && logFilter.trim() !== "") {
        applyFilter();
      }
      return;
    }

    if (data.type === "clear") {
      allLogLines = [];
      displayLines = [];
      const container = document.getElementById("logsContainer");
      container.classList.add("centered");
      container.innerHTML = '<div style="color: #6b7280;">Логи очищены</div>';
      return;
    }

    if (data.type === "append") {
      const newLines = data.content.split("\n").filter((line) => line.trim());
      allLogLines.push(...newLines);

      if (!logFilter) {
        displayLines.push(...newLines);
        displayLines = displayLines.slice(-1000);
        renderLines(document.getElementById("logsContainer"), displayLines);
      } else {
        const matchedNewLines = newLines.filter((line) =>
          line.includes(logFilter),
        );
        if (matchedNewLines.length > 0) {
          displayLines.push(...matchedNewLines);
          renderLines(document.getElementById("logsContainer"), displayLines);
        }
      }
      return;
    }

    if (data.type === "filtered") {
      displayLines = data.lines || [];
      renderLines(document.getElementById("logsContainer"), displayLines);
      return;
    }
  };
}

function switchLogFile(newLogFile) {
  if (currentLogFile === newLogFile) return;

  currentLogFile = newLogFile;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: "switchFile",
        file: newLogFile,
      }),
    );
  }
}

function initMonacoEditor() {
  require(["vs/editor/editor.main"], function () {
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      allowComments: true,
    });
    monaco.languages.json.jsonDefaults.setModeConfiguration({
      ...monaco.languages.json.jsonDefaults.modeConfiguration,
      documentFormattingEdits: false,
    });

    monaco.languages.registerDocumentFormattingEditProvider("json", {
      async provideDocumentFormattingEdits(model, options, token) {
        try {
          console.log("Using Prettier for JSON formatting...");
          const text = await window.prettier.format(model.getValue(), {
            parser: "json",
            plugins: [window.prettierPlugins.babel],
            semi: false,
            singleQuote: false,
            trailingComma: "none",
            printWidth: 80,
            endOfLine: "lf",
          });
          const cleanedText = text
            .replace(/\n{3,}/g, "\n\n")
            .replace(/\s+$/gm, "")
            .replace(/\n$/, "");
          return [
            {
              range: model.getFullModelRange(),
              text: cleanedText,
            },
          ];
        } catch (error) {
          console.error("Prettier formatting error:", error);
          showToast(`Ошибка форматирования: ${error.message}`, "error");
          return [];
        }
      },
    });

    monaco.languages.registerDocumentFormattingEditProvider("yaml", {
      async provideDocumentFormattingEdits(model, options, token) {
        try {
          console.log("Using Prettier for YAML formatting...");
          const text = await window.prettier.format(model.getValue(), {
            parser: "yaml",
            plugins: [window.prettierPlugins.yaml],
            singleQuote: true,
            proseWrap: "preserve",
          });

          return [
            {
              range: model.getFullModelRange(),
              text: text,
            },
          ];
        } catch (error) {
          console.error("Prettier YAML formatting error:", error);
          showToast(`Ошибка форматирования YAML: ${error.message}`, "error");
          return [];
        }
      },
    });

    monaco.editor.defineTheme("tokyo-night", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "string.key.json", foreground: "#7aa2f7" },
        { token: "string.value.json", foreground: "#9ece6a" },
        { token: "number.json", foreground: "#ff9e64" },
        { token: "keyword.json", foreground: "#bb9af7" },
        { token: "identifier", foreground: "#c0caf5" },
        { token: "comment", foreground: "#565f89" },
        {
          token: "comment.line",
          foreground: "#565f89",
        },
        {
          token: "comment.block",
          foreground: "#565f89",
        },
        { token: "operator", foreground: "#89ddff" },
        { token: "delimiter", foreground: "#c0caf5" },
        { token: "tag", foreground: "#f7768e" },
        { token: "attribute.name", foreground: "#e0af68" },
        { token: "attribute.value", foreground: "#9ece6a" },
      ],
      colors: {
        "editor.background": "#020817",
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
    });

    const editorContainer = document.getElementById("editorContainer");
    editorContainer.innerHTML = "";

    monacoEditor = monaco.editor.create(editorContainer, {
      value: "",
      language: "json",
      theme: "tokyo-night",
      automaticLayout: true,
      formatOnPaste: false,
      formatOnType: false,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "JetBrains Mono, monospace",
      fontWeight: "400",
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
      rulers: [],
      overviewRulerLanes: 0,
      scrollbar: {
        vertical: "visible",
        horizontal: "visible",
        useShadows: false,
        verticalHasArrows: false,
        horizontalHasArrows: false,
      },
      find: {
        addExtraSpaceOnTop: false,
        autoFindInSelection: "never",
        seedSearchStringFromSelection: "never",
      },
    });

    function isMobileViewport() {
      return (
        window.matchMedia && window.matchMedia("(max-width: 768px)").matches
      );
    }

    function applyDynamicEditorHeight() {
      const container = document.getElementById("editorContainer");
      if (!container || !monacoEditor) return;
      if (isMobileViewport()) {
        const contentHeight = Math.max(
          monacoEditor.getContentHeight ? monacoEditor.getContentHeight() : 0,
          200,
        );
        container.style.height = contentHeight + "px";
        monacoEditor.layout();
      } else {
        container.style.height = "700px";
        monacoEditor.layout();
      }
    }

    monaco.editor.onDidChangeMarkers((uris) => {
      const currentConfig = configs[activeConfigIndex];
      if (
        !currentConfig ||
        getFileLanguage(currentConfig.filename) !== "json"
      ) {
        updateValidationInfo(false);
        return;
      }

      const model = monacoEditor.getModel();
      if (!model) return;

      if (uris.some((uri) => uri.toString() === model.uri.toString())) {
        const markers = monaco.editor.getModelMarkers({ resource: model.uri });
        const errorMarker = markers.find(
          (m) => m.severity === monaco.MarkerSeverity.Error,
        );

        if (!errorMarker) {
          updateValidationInfo(true);
        } else {
          updateValidationInfo(false, errorMarker.message);
        }
      }
    });

    monacoEditor.onDidChangeModelContent(() => {
      const currentConfig = configs[activeConfigIndex];
      if (currentConfig) {
        const currentContent = monacoEditor.getValue();
        const isDirty = currentContent !== currentConfig.savedContent;
        if (currentConfig.isDirty !== isDirty) {
          currentConfig.isDirty = isDirty;
          updateUIDirtyState();
        }

        if (getFileLanguage(currentConfig.filename) !== "json") {
          updateValidationInfo(false);
        }
      }
    });

    if (monacoEditor.onDidContentSizeChange) {
      monacoEditor.onDidContentSizeChange(() => {
        applyDynamicEditorHeight();
      });
    }

    window.addEventListener(
      "resize",
      () => {
        applyDynamicEditorHeight();
      },
      { passive: true },
    );

    loadConfigs();

    requestAnimationFrame(() => applyDynamicEditorHeight());
  });
}

function updateUIDirtyState() {
  const saveBtn = document.getElementById("saveBtn");
  const saveRestartBtn = document.getElementById("saveRestartBtn");
  const currentConfig = configs[activeConfigIndex];

  if (currentConfig) {
    saveBtn.disabled = !currentConfig.isDirty;

    const fileLanguage = getFileLanguage(currentConfig.filename);
    const hasChanges = currentConfig.isDirty;

    if (fileLanguage === "json") {
      const isXray = currentCore === "xray";
      saveRestartBtn.disabled = !(isXray && hasChanges && isServiceRunning);
    } else if (fileLanguage === "yaml") {
      const isMihomo = currentCore === "mihomo";
      saveRestartBtn.disabled = !(isMihomo && hasChanges && isServiceRunning);
    } else if (fileLanguage === "plaintext") {
      saveRestartBtn.disabled = !(hasChanges && isServiceRunning);
    } else {
      saveRestartBtn.disabled = true;
    }
  } else {
    saveBtn.disabled = true;
    saveRestartBtn.disabled = true;
  }
  renderTabs();
}

function validateCurrentFile() {
  if (!monacoEditor || typeof monaco === "undefined") return;

  const currentConfig = configs[activeConfigIndex];

  if (!currentConfig || getFileLanguage(currentConfig.filename) !== "json") {
    updateValidationInfo(false);
    return;
  }

  const model = monacoEditor.getModel();
  if (!model) {
    updateValidationInfo(true);
    return;
  }

  const markers = monaco.editor.getModelMarkers({ owner: "json" });
  const currentModelMarkers = markers.filter(
    (marker) => marker.resource.toString() === model.uri.toString(),
  );

  const errorMarker = currentModelMarkers.find(
    (m) => m.severity === monaco.MarkerSeverity.Error,
  );

  if (!errorMarker) {
    updateValidationInfo(true);
  } else {
    updateValidationInfo(false, errorMarker.message);
  }
}

function renderTabs() {
  const coreTabsList = document.getElementById("coreTabsList");
  const xkeenTabsList = document.getElementById("xkeenTabsList");

  // Сохраняем позиции индикаторов перед очисткой
  const coreIndicator = coreTabsList?.querySelector(".tab-active-indicator");
  const xkeenIndicator = xkeenTabsList?.querySelector(".tab-active-indicator");
  const coreTransform = coreIndicator?.style.transform || "";
  const xkeenTransform = xkeenIndicator?.style.transform || "";

  const editorControlsSkeletons = document.getElementById(
    "editorControlsSkeletons",
  );
  const saveBtn = document.getElementById("saveBtn");
  const saveRestartBtn = document.getElementById("saveRestartBtn");
  const formatBtn = document.getElementById("formatBtn");
  const validationSkeleton = document.getElementById("validationSkeleton");
  const validationInfo = document.getElementById("validationInfo");

  if (isConfigsLoading) {
    if (validationInfo) validationInfo.style.display = "flex";
    if (editorControlsSkeletons)
      editorControlsSkeletons.style.display = "inline-flex";
    if (saveBtn) saveBtn.style.display = "none";
    if (saveRestartBtn) saveRestartBtn.style.display = "none";
    if (formatBtn) formatBtn.style.display = "none";
    if (validationSkeleton) validationSkeleton.style.display = "block";

    coreTabsList.innerHTML = "";
    xkeenTabsList.innerHTML = "";
    for (let i = 0; i < 3; i++) {
      const sk = document.createElement("div");
      sk.className = "skeleton skeleton-tab";
      coreTabsList.appendChild(sk);
    }
    for (let i = 0; i < 2; i++) {
      const sk = document.createElement("div");
      sk.className = "skeleton skeleton-tab";
      xkeenTabsList.appendChild(sk);
    }
    return;
  }

  if (editorControlsSkeletons) editorControlsSkeletons.style.display = "none";
  if (saveBtn) saveBtn.style.display = "inline-flex";
  if (saveRestartBtn) saveRestartBtn.style.display = "inline-flex";
  if (formatBtn) formatBtn.style.display = "inline-flex";
  if (validationSkeleton) validationSkeleton.style.display = "none";
  if (validationInfo) {
    // Всегда показываем validationInfo (контейнер с кнопками)
    validationInfo.style.display = "flex";

    // Но управляем видимостью только messageContainer
    const messageContainer = document.getElementById(
      "validationMessageContainer",
    );
    if (messageContainer) messageContainer.style.display = "none";
    const currentConfig = configs[activeConfigIndex];
    const shouldShowMessage =
      currentConfig && getFileLanguage(currentConfig.filename) === "json";

    if (messageContainer) {
      messageContainer.style.display = shouldShowMessage ? "flex" : "none";
    }
  }

  // Разделяем конфиги
  const coreConfigs = configs.filter(
    (config) => !config.filename.endsWith(".lst"),
  );
  const xkeenConfigs = configs.filter((config) =>
    config.filename.endsWith(".lst"),
  );

  // Рендерим Core вкладки
  coreTabsList.innerHTML = "";
  const newCoreIndicator = document.createElement("div");
  newCoreIndicator.className = "tab-active-indicator";
  newCoreIndicator.style.transform = coreTransform;
  coreTabsList.appendChild(newCoreIndicator);

  coreConfigs.forEach((config, index) => {
    const globalIndex = configs.indexOf(config);
    const tabTrigger = document.createElement("button");
    tabTrigger.className = `tab-trigger ${
      globalIndex === activeConfigIndex ? "active" : ""
    } ${config.isDirty ? "dirty" : ""}`;
    tabTrigger.innerHTML = `${config.name}<span class="dirty-indicator"></span>`;
    tabTrigger.onclick = () => attemptSwitchTab(globalIndex);
    coreTabsList.appendChild(tabTrigger);
  });

  // Рендерим Xkeen вкладки только если они есть
  xkeenTabsList.innerHTML = "";
  if (xkeenConfigs.length > 0) {
    const newXkeenIndicator = document.createElement("div");
    newXkeenIndicator.className = "tab-active-indicator";
    newXkeenIndicator.style.transform = xkeenTransform;
    xkeenTabsList.appendChild(newXkeenIndicator);

    xkeenConfigs.forEach((config, index) => {
      const globalIndex = configs.indexOf(config);
      const tabTrigger = document.createElement("button");
      tabTrigger.className = `tab-trigger ${
        globalIndex === activeConfigIndex ? "active" : ""
      } ${config.isDirty ? "dirty" : ""}`;
      tabTrigger.innerHTML = `${config.name}<span class="dirty-indicator"></span>`;
      tabTrigger.onclick = () => attemptSwitchTab(globalIndex);
      xkeenTabsList.appendChild(tabTrigger);
    });

    // Показываем xkeen группу
    xkeenTabsList.parentElement.style.display = "inline-block";
  } else {
    // Скрываем xkeen группу если нет конфигов
    xkeenTabsList.parentElement.style.display = "none";
  }

  // Обновляем индикатор после рендера
  setTimeout(() => updateActiveTabIndicator(), 0);
}

function updateActiveTabIndicator() {
  const coreTabsList = document.getElementById("coreTabsList");
  const xkeenTabsList = document.getElementById("xkeenTabsList");

  // Скрываем все индикаторы
  [coreTabsList, xkeenTabsList].forEach((container) => {
    if (!container) return;
    const indicator = container.querySelector(".tab-active-indicator");
    if (indicator) {
      indicator.style.opacity = "0";
    }
  });

  const activeConfig = configs[activeConfigIndex];
  if (!activeConfig) return;

  const isXkeen = activeConfig.filename.endsWith(".lst");
  const activeContainer = isXkeen ? xkeenTabsList : coreTabsList;
  if (!activeContainer) return;

  const indicator = activeContainer.querySelector(".tab-active-indicator");
  if (!indicator) return;

  const tabs = Array.from(activeContainer.querySelectorAll(".tab-trigger"));
  const groupConfigs = isXkeen
    ? configs.filter((c) => c.filename.endsWith(".lst"))
    : configs.filter((c) => !c.filename.endsWith(".lst"));

  const groupIndex = groupConfigs.indexOf(activeConfig);
  if (groupIndex === -1) return;

  const activeTab = tabs[groupIndex];
  if (!activeTab) return;

  const offsetLeft = activeTab.offsetLeft;
  const width = activeTab.offsetWidth;

  indicator.style.width = `${width}px`;
  indicator.style.transform = `translateX(${offsetLeft}px)`;
  indicator.style.opacity = "1";

  // Анимация перехода между группами
  if (window.lastActiveGroup !== (isXkeen ? "xkeen" : "core")) {
    indicator.style.transition = "none";
    setTimeout(() => {
      indicator.style.transition = "";
    }, 10);
  }
  window.lastActiveGroup = isXkeen ? "xkeen" : "core";
}

function attemptSwitchTab(index) {
  if (index === activeConfigIndex) return;

  const currentConfig = configs[activeConfigIndex];
  if (currentConfig && currentConfig.isDirty) {
    pendingSwitchIndex = index;
    document.getElementById("dirtyModal").classList.add("show");
  } else {
    switchTab(index);
  }
}

function closeDirtyModal() {
  pendingSwitchIndex = -1;
  document.getElementById("dirtyModal").classList.remove("show");
}

async function saveAndSwitch() {
  if (pendingSwitchIndex !== -1) {
    await saveCurrentConfig();
    if (!configs[activeConfigIndex].isDirty) {
      switchTab(pendingSwitchIndex);
    }
    closeDirtyModal();
  }
}

function discardAndSwitch() {
  if (pendingSwitchIndex !== -1) {
    const config = configs[activeConfigIndex];
    monacoEditor.setValue(config.savedContent);
    config.isDirty = false;
    updateUIDirtyState();
    switchTab(pendingSwitchIndex);
    closeDirtyModal();
  }
}

function switchTab(index) {
  if (index < 0 || index >= configs.length || index === activeConfigIndex)
    return;

  activeConfigIndex = index;

  const config = configs[index];
  const formatBtn = document.getElementById("formatBtn");

  if (config) {
    const language = getFileLanguage(config.filename);
    isCurrentFileJson = language === "json";
    if (formatBtn)
      formatBtn.disabled = !(language === "json" || language === "yaml");
  }

  if (monacoEditor && config) {
    const language = getFileLanguage(config.filename);

    monacoEditor.setValue(config.content);
    monaco.editor.setModelLanguage(monacoEditor.getModel(), language);
    config.isDirty = false;
  }
  renderTabs();
  const validationInfo = document.getElementById("validationInfo");
  if (validationInfo) {
    validationInfo.style.display = "flex";
  }
  updateUIDirtyState();
  validateCurrentFile();
  requestAnimationFrame(updateActiveTabIndicator);
}

async function apiCall(endpoint, data = null) {
  try {
    const options = {
      method: data ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
    };
    if (data) options.body = JSON.stringify(data);

    const response = await fetch(
      `http://${window.location.host}/cgi/${endpoint}`,
      options,
    );

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error("API Error:", error);
    return { success: false, error: error.message };
  }
}

async function loadConfigs() {
  const tabsList = document.getElementById("tabsList");
  isConfigsLoading = true;
  if (tabsList) tabsList.classList.add("empty");
  renderTabs();
  const result = await apiCall("configs");

  if (result.success && result.configs) {
    configs = result.configs.map((c) => ({
      ...c,
      savedContent: c.content,
      isDirty: false,
    }));

    if (configs.length > 0) {
      isConfigsLoading = false;
      if (tabsList) tabsList.classList.remove("empty");
      switchTab(0);
    } else {
      isConfigsLoading = false;
      renderTabs();
      updateUIDirtyState();
    }
  } else {
    isConfigsLoading = false;
    showToast("Ошибка загрузки конфигураций", "error");
    renderTabs();
  }
  updateDashboardLink();
}

async function saveCurrentConfig() {
  if (activeConfigIndex < 0 || !configs[activeConfigIndex] || !monacoEditor)
    return;

  const config = configs[activeConfigIndex];
  const content = monacoEditor.getValue();

  if (!content.trim()) {
    showToast("Конфиграция пустая", "error");
    return;
  }

  const language = getFileLanguage(config.filename);

  if (language === "json") {
    const model = monacoEditor.getModel();
    if (model) {
      const allMarkers = monaco.editor.getModelMarkers({});
      const errorMarker = allMarkers.find(
        (m) =>
          m.resource.toString() === model.uri.toString() &&
          m.severity === monaco.MarkerSeverity.Error,
      );
      if (errorMarker) {
        showToast(
          {
            title: "Ошибка сохранения",
            body: `Invalid JSON: ${errorMarker.message}`,
          },
          "error",
        );
        return;
      }
    }
  }

  const result = await apiCall("configs", {
    action: "save",
    filename: config.filename,
    content: content,
  });

  if (result.success) {
    config.content = content;
    config.savedContent = content;
    config.isDirty = false;
    updateUIDirtyState();
    showToast(`Конфигурация "${config.name}" сохранена`);
  } else {
    showToast(`Ошибка сохранения: ${result.error}`, "error");
  }
}

function formatCurrentConfig() {
  if (!monacoEditor) return;

  const content = monacoEditor.getValue().trim();
  if (!content) {
    showToast("Конфигурация пустая", "error");
    return;
  }

  const currentConfig = configs[activeConfigIndex];
  const language = getFileLanguage(currentConfig.filename);

  if (language === "json" || language === "yaml") {
    const formatAction = monacoEditor.getAction("editor.action.formatDocument");
    if (formatAction) {
      formatAction.run().catch((e) => {
        showToast(
          `Ошибка форматирования: ${e?.message || "неизвестная ошибка"}`,
          "error",
        );
      });
    } else {
      showToast("Форматирование недоступно", "error");
    }
  } else {
    showToast("Форматирование доступно только для JSON и YAML", "error");
  }
}

async function checkStatus() {
  if (isActionInProgress) return;
  const result = await apiCall("status");
  updateServiceStatus(result.running);
}

async function startXKeen() {
  try {
    setPendingState("Запускается...");
    const result = await apiCall("control", { action: "start" });
    if (result.success) {
      showToast("XKeen запущен");
      isActionInProgress = false;
      isServiceRunning = true;
      updateServiceStatus(true);
    } else {
      showToast(`Ошибка запуска: ${result.output || result.error}`, "error");
      isActionInProgress = false;
      checkStatus();
    }
  } catch (e) {
    isActionInProgress = false;
    checkStatus();
  }
}

async function stopXKeen() {
  try {
    setPendingState("Останавливается...");
    const result = await apiCall("control", { action: "stop" });
    if (result.success) {
      showToast("XKeen остановлен");
      isServiceRunning = false;
      updateServiceStatus(false);
    } else {
      showToast(`Ошибка остановки: ${result.output || result.error}`, "error");
    }
  } finally {
    isActionInProgress = false;
    checkStatus();
  }
}

async function restartXKeen() {
  try {
    setPendingState("Перезапускается...");
    const result = await apiCall("control", { action: "restart" });
    if (result.success) {
      showToast("XKeen перезапущен");
      isActionInProgress = false;
      isServiceRunning = true;
      updateServiceStatus(true);
      updateDashboardLink();
    } else {
      showToast(
        `Ошибка перезапуска: ${result.output || result.error}`,
        "error",
      );
      isActionInProgress = false;
      checkStatus();
    }
  } catch (e) {
    isActionInProgress = false;
    checkStatus();
  }
}

async function clearCurrentLog() {
  if (!currentLogFile) {
    showToast("Не выбран файл журнала", "error");
    return;
  }

  try {
    const result = await apiCall("logs", {
      action: "clear",
      file: currentLogFile,
    });

    if (result.success) {
      allLogLines = [];
      displayLines = [];

      const container = document.getElementById("logsContainer");
      container.classList.add("centered");
      container.innerHTML = '<div style="color: #6b7280;">Лог очищен</div>';

      showToast(`Лог ${currentLogFile} очищен`);
    } else {
      showToast(`Ошибка очистки лога: ${result.error}`, "error");
    }
  } catch (error) {
    showToast(`Ошибка: ${error.message}`, "error");
  }
}

async function loadCores() {
  try {
    const result = await apiCall("core");
    if (result.success) {
      availableCores = result.cores || [];
      currentCore = result.currentCore || "xray"; // Добавляем значение по умолчанию

      const coreSelectRoot = document.getElementById("coreSelectRoot");
      const coreSelectLabel = document.getElementById("coreSelectLabel");

      if (availableCores.length >= 2) {
        coreSelectRoot.style.display = "inline-block";
        coreSelectLabel.textContent = currentCore;

        const items = document.querySelectorAll(
          "#coreSelectContent .select-item",
        );
        items.forEach((item) => {
          const value = item.getAttribute("data-value");
          item.setAttribute(
            "aria-selected",
            value === currentCore ? "true" : "false",
          );
        });
      }
    }
  } catch (error) {
    console.error("Error loading cores:", error);
  }
}

function closeCoreModal() {
  pendingCoreChange = "";
  document.getElementById("coreModal").classList.remove("show");
}

async function confirmCoreChange() {
  console.log("confirmCoreChange called");

  // Получаем значение напрямую из модального окна
  const selectedCoreElement = document.getElementById("selectedCore");
  const selectedCore = selectedCoreElement
    ? selectedCoreElement.textContent
    : "";

  console.log("Selected core from DOM:", selectedCore);

  if (!selectedCore || (selectedCore !== "xray" && selectedCore !== "mihomo")) {
    showToast("Ошибка: не выбрано ядро", "error");
    return;
  }

  closeCoreModal();
  setPendingState("Выполняется смена ядра...");

  try {
    console.log("Sending API request with core:", selectedCore);
    const result = await apiCall("core", { core: selectedCore });

    console.log("API response:", result);

    if (result.success) {
      showToast(`Ядро изменено на ${selectedCore}`);
      currentCore = selectedCore;

      // Обновляем интерфейс выбора ядра
      const coreSelectLabel = document.getElementById("coreSelectLabel");
      if (coreSelectLabel) {
        coreSelectLabel.textContent = currentCore;
      }

      const items = document.querySelectorAll(
        "#coreSelectContent .select-item",
      );
      items.forEach((item) => {
        const value = item.getAttribute("data-value");
        if (item && value) {
          item.setAttribute(
            "aria-selected",
            value === currentCore ? "true" : "false",
          );
        }
      });

      // Сбрасываем статус действия
      isActionInProgress = false;

      // Ждем немного перед проверкой статуса
      setTimeout(() => {
        checkStatus().then(() => {
          console.log("Status checked after core change");
          forceReloadConfigs();
        });
      }, 100);
    } else {
      showToast(`Ошибка смены ядра: ${result.error}`, "error");
      isActionInProgress = false;
      checkStatus();
    }
  } catch (error) {
    console.error("Core change error:", error);
    showToast(`Ошибка: ${error.message}`, "error");
    isActionInProgress = false;
    checkStatus();
  }
}

function parseDashboardPort(yamlContent) {
  const match = yamlContent.match(/^external-controller:\s*[\w\.-]+:(\d+)/m);
  return match ? match[1] : null;
}

function updateDashboardLink() {
  const dashboardLink = document.getElementById("dashboardLink");
  if (currentCore === "mihomo") {
    const mihomoConfig = configs.find((c) => c.filename === "config.yaml");
    if (mihomoConfig) {
      const port = parseDashboardPort(mihomoConfig.content);
      if (port) {
        dashboardPort = port;
        dashboardLink.style.display = "inline-flex";
        dashboardLink.href = `http://${window.location.hostname}:${port}/ui`;
        return;
      }
    }
  }
  dashboardLink.style.display = "none";
}

document.addEventListener("DOMContentLoaded", () => {
  const logsContainer = document.getElementById("logsContainer");
  const logSelectRoot = document.getElementById("logSelectRoot");
  const logSelectTrigger = document.getElementById("logSelectTrigger");
  const logSelectContent = document.getElementById("logSelectContent");
  const logSelectLabel = document.getElementById("logSelectLabel");
  const logFilterInput = document.getElementById("logFilterInput");
  const tabsList = document.getElementById("tabsList");
  const coreSelectRoot = document.getElementById("coreSelectRoot");
  const coreSelectTrigger = document.getElementById("coreSelectTrigger");
  const coreSelectContent = document.getElementById("coreSelectContent");
  const logFilterClear = document.getElementById("logFilterClear");

  if (tabsList) tabsList.classList.add("empty");
  isConfigsLoading = true;
  isStatusLoading = true;
  updateControlButtons();
  renderTabs();

  if (logFilterInput && logFilterClear) {
    let filterTimeout;

    logFilterInput.addEventListener("input", () => {
      logFilterClear.classList.toggle("show", logFilterInput.value.length > 0);

      clearTimeout(filterTimeout);
      filterTimeout = setTimeout(() => {
        logFilter = logFilterInput.value || "";
        applyFilter();
      }, 100);
    });

    logFilterClear.addEventListener("click", () => {
      logFilterInput.value = "";
      logFilter = "";
      logFilterClear.classList.remove("show");
      applyFilter();
    });
  }

  const tabsScroll = document.querySelector(".tabs-scroll");
  if (tabsScroll) {
    tabsScroll.addEventListener(
      "wheel",
      (e) => {
        const canScroll = tabsScroll.scrollWidth > tabsScroll.clientWidth;
        if (!canScroll) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          tabsScroll.scrollLeft += e.deltaY;
        }
      },
      { passive: false },
    );

    tabsScroll.addEventListener(
      "scroll",
      () => {
        requestAnimationFrame(
          () => updateActiveTabIndicator && updateActiveTabIndicator(),
        );
      },
      { passive: true },
    );
  }

  logsContainer.addEventListener("scroll", () => {
    const isAtBottom =
      logsContainer.scrollTop + logsContainer.clientHeight >=
      logsContainer.scrollHeight - 5;
    userScrolled = !isAtBottom;
  });

  function closeLogMenu() {
    logSelectRoot.classList.remove("select-open");
    logSelectTrigger.setAttribute("aria-expanded", "false");
  }

  function openLogMenu() {
    logSelectRoot.classList.add("select-open");
    logSelectTrigger.setAttribute("aria-expanded", "true");
  }

  function setActiveLogItem(value) {
    const items = logSelectContent.querySelectorAll(".select-item");
    items.forEach((el) => {
      const selected = el.getAttribute("data-value") === value;
      el.setAttribute("aria-selected", selected ? "true" : "false");
    });
  }

  function applyLogSelection(value) {
    if (currentLogFile === value) return;
    switchLogFile(value);
    logSelectLabel.textContent = value;
    setActiveLogItem(value);
  }

  function closeCoreMenu() {
    coreSelectRoot.classList.remove("select-open");
    coreSelectTrigger.setAttribute("aria-expanded", "false");
  }

  function openCoreMenu() {
    coreSelectRoot.classList.add("select-open");
    coreSelectTrigger.setAttribute("aria-expanded", "true");
  }

  function applyCoreSelection(value) {
    console.log("applyCoreSelection called with:", value);
    if (!value) {
      console.error("Empty value provided to applyCoreSelection");
      return;
    }

    if (value === currentCore) {
      console.log("Same core selected, ignoring");
      return;
    }

    pendingCoreChange = value;
    console.log("pendingCoreChange set to:", pendingCoreChange);

    document.getElementById("selectedCore").textContent = value;
    document.getElementById("coreModal").classList.add("show");
  }

  logSelectTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = logSelectRoot.classList.contains("select-open");
    if (isOpen) {
      closeLogMenu();
    } else {
      openLogMenu();
    }
  });

  logSelectContent.addEventListener("click", (e) => {
    const target = e.target.closest(".select-item");
    if (!target) return;
    const value = target.getAttribute("data-value");
    applyLogSelection(value);
    closeLogMenu();
  });

  logSelectContent.addEventListener("mouseenter", () => {
    logSelectRoot.classList.add("select-hovering");
  });
  logSelectContent.addEventListener("mouseleave", () => {
    logSelectRoot.classList.remove("select-hovering");
  });

  coreSelectTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = coreSelectRoot.classList.contains("select-open");
    if (isOpen) {
      closeCoreMenu();
    } else {
      openCoreMenu();
    }
  });

  coreSelectContent.addEventListener("click", (e) => {
    const target = e.target.closest(".select-item");
    if (!target) return;

    const value = target.getAttribute("data-value");
    console.log("Core selected:", value);

    applyCoreSelection(value);
    closeCoreMenu();
  });

  coreSelectContent.addEventListener("mouseenter", () => {
    coreSelectRoot.classList.add("select-hovering");
  });
  coreSelectContent.addEventListener("mouseleave", () => {
    coreSelectRoot.classList.remove("select-hovering");
  });

  document.addEventListener("click", (e) => {
    if (!logSelectRoot.contains(e.target)) {
      closeLogMenu();
    }
    if (!coreSelectRoot.contains(e.target)) {
      closeCoreMenu();
    }
  });

  logSelectTrigger.addEventListener("keydown", (e) => {
    const items = Array.from(logSelectContent.querySelectorAll(".select-item"));
    const currentIndex = items.findIndex(
      (i) => i.getAttribute("data-value") === currentLogFile,
    );
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!logSelectRoot.classList.contains("select-open")) openLogMenu();
      let nextIndex = currentIndex;
      if (e.key === "ArrowDown")
        nextIndex = Math.min(items.length - 1, currentIndex + 1);
      if (e.key === "ArrowUp") nextIndex = Math.max(0, currentIndex - 1);
      const nextItem = items[nextIndex];
      if (nextItem) {
        items.forEach((i) => (i.tabIndex = -1));
        nextItem.tabIndex = 0;
        nextItem.focus();
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (logSelectRoot.classList.contains("select-open")) closeLogMenu();
      else openLogMenu();
    } else if (e.key === "Escape") {
      closeLogMenu();
    }
  });

  logSelectContent.addEventListener("keydown", (e) => {
    const items = Array.from(logSelectContent.querySelectorAll(".select-item"));
    let idx = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      idx = Math.min(items.length - 1, idx + 1);
      items[idx].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      idx = Math.max(0, idx - 1);
      items[idx].focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const value = document.activeElement.getAttribute("data-value");
      if (value) applyLogSelection(value);
      closeLogMenu();
    } else if (e.key === "Escape") {
      closeLogMenu();
      logSelectTrigger.focus();
    }
  });

  logSelectLabel.textContent = currentLogFile;
  setActiveLogItem(currentLogFile);

  initMonacoEditor();
  checkStatus();
  loadCores();
  setInterval(() => {
    if (!isActionInProgress) checkStatus();
  }, 15000);

  logsContainer.classList.add("centered");
  logsContainer.innerHTML =
    '<div style="color: #6b7280;">Подключение к WebSocket...</div>';

  connectWebSocket();
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault();
    const saveBtn = document.getElementById("saveBtn");
    if (!saveBtn.disabled) {
      saveCurrentConfig();
    }
  }
});

async function forceReloadConfigs() {
  console.log("Force reloading configs...");

  isConfigsLoading = true;
  const tabsList = document.getElementById("tabsList");
  if (tabsList) tabsList.classList.add("empty");
  renderTabs();

  configs = [];
  activeConfigIndex = -1;

  await new Promise((resolve) => setTimeout(resolve, 500));

  const result = await apiCall("configs");

  if (result.success && result.configs) {
    configs = result.configs.map((c) => ({
      ...c,
      savedContent: c.content,
      isDirty: false,
    }));

    if (configs.length > 0) {
      isConfigsLoading = false;
      if (tabsList) tabsList.classList.remove("empty");
      switchTab(0);
      console.log("Configs reloaded successfully, count:", configs.length);
    } else {
      isConfigsLoading = false;
      renderTabs();
      updateUIDirtyState();
      console.log("No configs found after reload");
    }
  } else {
    isConfigsLoading = false;
    showToast("Ошибка загрузки конфигов после смены ядра", "error");
    renderTabs();
    console.error("Failed to reload configs:", result.error);
  }
  updateUIDirtyState();
  updateDashboardLink();
}

async function saveAndRestart() {
  if (activeConfigIndex < 0 || !configs[activeConfigIndex] || !monacoEditor)
    return;

  const config = configs[activeConfigIndex];
  const content = monacoEditor.getValue();

  if (!content.trim()) {
    showToast("Конфиг пустой", "error");
    return;
  }

  const language = getFileLanguage(config.filename);

  if (language === "json") {
    const model = monacoEditor.getModel();
    if (model) {
      const allMarkers = monaco.editor.getModelMarkers({});
      const errorMarker = allMarkers.find(
        (m) =>
          m.resource.toString() === model.uri.toString() &&
          m.severity === monaco.MarkerSeverity.Error,
      );
      if (errorMarker) {
        showToast(
          {
            title: "Ошибка сохранения",
            body: `Invalid JSON: ${errorMarker.message}`,
          },
          "error",
        );
        return;
      }
    }
  }

  const result = await apiCall("configs", {
    action: "save",
    filename: config.filename,
    content: content,
  });

  if (result.success) {
    config.content = content;
    config.savedContent = content;
    config.isDirty = false;
    updateUIDirtyState();
    updateDashboardLink();
    showToast(`Конфиг "${config.name}" сохранен`);

    setPendingState("Перезапускается...");

    try {
      let restartResult;

      if (language === "json" || language === "yaml") {
        restartResult = await apiCall("control", {
          action: "restartCore",
          core: currentCore,
        });
      } else if (language === "plaintext") {
        restartResult = await apiCall("control", { action: "restart" });
      }

      if (restartResult && restartResult.success) {
        showToast("Сервис перезапущен");
        isActionInProgress = false;
        isServiceRunning = true;
        updateServiceStatus(true);
      } else {
        showToast(
          `Ошибка перезапуска: ${restartResult?.error || "unknown"}`,
          "error",
        );
        isActionInProgress = false;
        checkStatus();
      }
    } catch (e) {
      isActionInProgress = false;
      checkStatus();
    }
  } else {
    showToast(`Ошибка сохранения: ${result.error}`, "error");
  }
}
