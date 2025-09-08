let autoRefreshInterval;
let monacoEditor;
let configs = [];
let activeConfigIndex = -1;
let isServiceRunning = false;
let isActionInProgress = false;
let lastLogContent = null;
let userScrolled = false;
let pendingSwitchIndex = -1;
let currentLogFile = "error.log";
let isConfigsLoading = true;
let logFilter = "";
let isStatusLoading = true;

require.config({
  paths: {
    vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.0/min/vs",
  },
});

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add("show"), 100);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => document.body.removeChild(toast), 300);
  }, 3000);
}

function updateValidationInfo(isValid, error = null) {
  const validationInfo = document.getElementById("validationInfo");
  if (isValid) {
    validationInfo.innerHTML = `
                    <span class="validation-icon validation-success">✓</span>
                    <span class="validation-success">JSON валиден</span>
                `;
  } else {
    validationInfo.innerHTML = `
                    <span class="validation-icon validation-error">✗</span>
                    <span class="validation-error">${
                      error || "Ошибка в JSON"
                    }</span>
                `;
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
      '<span style="color: #10b981;">$1</span>'
    )
    .replace(
      /\u001b\[33m(.*?)\u001b\[0m/g,
      '<span style="color: #f59e0b;">$1</span>'
    )
    .replace(
      /\u001b\[31m(.*?)\u001b\[0m/g,
      '<span style="color: #ef4444;">$1</span>'
    )
    .replace(
      /\u001b\[36m(.*?)\u001b\[0m/g,
      '<span style="color: #06b6d4;">$1</span>'
    )
    .replace(/\u001b\[\d+m/g, "");

  processedLine = processedLine
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;span style="color: #[\w\d]+;"&gt;/g, (match) =>
      match.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    )
    .replace(/&lt;\/span&gt;/g, "</span>");

  processedLine = processedLine
    .replace(/\[Info\]/g, '<span style="color: #3b82f6;">[Info]</span>')
    .replace(
      /\[Warning\]/g,
      '<span style="color: #f59e0b;">[Warning]</span>'
    )
    .replace(
      /\[Error\]/g,
      '<span style="color: #ef4444;">[Error]</span>'
    );

  return { className, content: processedLine };
}

function checkServiceStatusFromLogs(newLogContent) {
  if (isActionInProgress && newLogContent !== lastLogContent) {
    const lines = newLogContent.split("\n");

    for (const line of lines.slice(-10)) {
      const cleanLine = line.replace(/\u001b\[\d+m/g, "");

      if (
        cleanLine.includes("Прокси-клиент") &&
        cleanLine.includes("запущен")
      ) {
        console.log("Found startup line in logs!");
        isServiceRunning = true;
        isActionInProgress = false;
        updateServiceStatus(true);
        break;
      }
    }
  }
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

function initMonacoEditor() {
  require(["vs/editor/editor.main"], function () {
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      allowComments: true,
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
        { token: "comment", foreground: "#565f89", fontStyle: "italic" },
        {
          token: "comment.line",
          foreground: "#565f89",
          fontStyle: "italic",
        },
        {
          token: "comment.block",
          foreground: "#565f89",
          fontStyle: "italic",
        },
        { token: "operator", foreground: "#89ddff" },
        { token: "delimiter", foreground: "#c0caf5" },
        { token: "tag", foreground: "#f7768e" },
        { token: "attribute.name", foreground: "#e0af68" },
        { token: "attribute.value", foreground: "#9ece6a" },
      ],
      colors: {
        "editor.background": "#171717",
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
      formatOnPaste: true,
      formatOnType: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "JetBrains Mono",
      fontWeight: "500",
      smoothScrolling: true,
      lineHeight: 1.5,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "off",
      folding: false,
      lineNumbers: "on",
      glyphMargin: false,
      stickyScroll: { enabled: false },
      rulers: [],
      scrollbar: {
        vertical: "visible",
        horizontal: "visible",
        useShadows: false,
        verticalHasArrows: true,
        horizontalHasArrows: true,
      },
      find: {
        addExtraSpaceOnTop: false,
        autoFindInSelection: "never",
        seedSearchStringFromSelection: "never",
      },
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
        validateCurrentJSON();
      }
    });

    monaco.editor.onDidChangeMarkers((changedUris) => {
      const model = monacoEditor.getModel();
      if (!model) return;
      if (
        changedUris.some((u) => u.toString() === model.uri.toString())
      ) {
        validateCurrentJSON();
      }
    });

    loadConfigs();
  });
}

function updateUIDirtyState() {
  const saveBtn = document.getElementById("saveBtn");
  const currentConfig = configs[activeConfigIndex];

  if (currentConfig) {
    saveBtn.disabled = !currentConfig.isDirty;
  } else {
    saveBtn.disabled = true;
  }
  renderTabs();
}

function validateCurrentJSON() {
  if (!monacoEditor || typeof monaco === "undefined") return;

  const model = monacoEditor.getModel();
  if (!model) {
    updateValidationInfo(true);
    return;
  }

  const allMarkers = monaco.editor.getModelMarkers({});
  const errorMarker = allMarkers.find(
    (m) =>
      m.resource.toString() === model.uri.toString() &&
      m.severity === monaco.MarkerSeverity.Error
  );

  if (!errorMarker) {
    updateValidationInfo(true);
  } else {
    updateValidationInfo(false, errorMarker.message);
  }
}

function renderTabs() {
  const tabsList = document.getElementById("tabsList");
  tabsList.innerHTML = "";

  tabsList.classList.toggle(
    "empty",
    isConfigsLoading || configs.length === 0
  );

  const editorControlsSkeletons = document.getElementById("editorControlsSkeletons");
  const saveBtn = document.getElementById("saveBtn");
  const formatBtn = document.getElementById("formatBtn");
  const validationSkeleton = document.getElementById("validationSkeleton");
  const validationInfo = document.getElementById("validationInfo");

  if (isConfigsLoading) {
    if (editorControlsSkeletons) editorControlsSkeletons.style.display = "inline-flex";
    if (saveBtn) saveBtn.style.display = "none";
    if (formatBtn) formatBtn.style.display = "none";
    if (validationSkeleton) validationSkeleton.style.display = "block";
    if (validationInfo) validationInfo.style.display = "none";
  } else {
    if (editorControlsSkeletons) editorControlsSkeletons.style.display = "none";
    if (saveBtn) saveBtn.style.display = "inline-flex";
    if (formatBtn) formatBtn.style.display = "inline-flex";
    if (validationSkeleton) validationSkeleton.style.display = "none";
    if (validationInfo) validationInfo.style.display = "flex";
  }

  if (isConfigsLoading) {
    for (let i = 0; i < 6; i++) {
      const sk = document.createElement("div");
      sk.className = "skeleton skeleton-tab";
      tabsList.appendChild(sk);
    }
    return;
  }

  configs.forEach((config, index) => {
    const tabTrigger = document.createElement("button");
    tabTrigger.className = `tab-trigger ${
      index === activeConfigIndex ? "active" : ""
    } ${config.isDirty ? "dirty" : ""}`;
    tabTrigger.innerHTML = `
                    ${config.name}
                    <span class="dirty-indicator"></span>
                `;
    tabTrigger.onclick = () => attemptSwitchTab(index);
    tabsList.appendChild(tabTrigger);
  });
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

  if (monacoEditor && configs[index]) {
    monacoEditor.setValue(configs[index].content);
    configs[index].isDirty = false;
  }
  renderTabs();
  updateUIDirtyState();
  validateCurrentJSON();
}

async function apiCall(endpoint, data = null) {
  try {
    const options = {
      method: data ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
    };
    if (data) options.body = JSON.stringify(data);

    const response = await fetch(
      `http://192.168.1.1:91/cgi-bin/${endpoint}`,
      options
    );
    const result = await response.text();

    try {
      return JSON.parse(result);
    } catch {
      return { success: response.ok, output: result };
    }
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
  const result = await apiCall("configs.sh");

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
    showToast("Ошибка загрузки конфигов", "error");
    renderTabs();
  }
}

async function saveCurrentConfig() {
  if (
    activeConfigIndex < 0 ||
    !configs[activeConfigIndex] ||
    !monacoEditor
  )
    return;

  const config = configs[activeConfigIndex];
  const content = monacoEditor.getValue();

  if (!content.trim()) {
    showToast("Конфиг пустой", "error");
    return;
  }

  const model = monacoEditor.getModel();
  if (model) {
    const allMarkers = monaco.editor.getModelMarkers({});
    const errorMarker = allMarkers.find(
      (m) =>
        m.resource.toString() === model.uri.toString() &&
        m.severity === monaco.MarkerSeverity.Error
    );
    if (errorMarker) {
      showToast(`Невалидный JSON: ${errorMarker.message}`, "error");
      return;
    }
  }

  const result = await apiCall("configs.sh", {
    action: "save",
    filename: config.filename,
    content: content,
  });

  if (result.success) {
    config.content = content;
    config.savedContent = content;
    config.isDirty = false;
    updateUIDirtyState();
    showToast(`Конфиг "${config.name}" сохранен`);
  } else {
    showToast(`Ошибка сохранения: ${result.error}`, "error");
  }
}

function formatCurrentConfig() {
  if (!monacoEditor) return;

  const content = monacoEditor.getValue().trim();
  if (!content) {
    showToast("Конфиг пустой", "error");
    return;
  }

  const formatAction = monacoEditor.getAction("editor.action.formatDocument");
  if (formatAction) {
    formatAction.run().catch((e) => {
      showToast(`Ошибка форматирования: ${e?.message || "неизвестная ошибка"}`, "error");
    });
  } else {
    showToast("Форматирование недоступно", "error");
  }
}

async function loadLogs() {
  const result = await apiCall(`logs.sh?file=${currentLogFile}`);
  const container = document.getElementById("logsContainer");

  if (result.success) {
    const newContent = result.data ?? "";

    if (newContent !== lastLogContent || lastLogContent === null) {
      checkServiceStatusFromLogs(newContent);

      const wasAtBottom =
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - 5;

      const lines = newContent.split("\n").filter((line) => line.trim());
      const filteredLines = logFilter
        ? lines.filter((line) => line.includes(logFilter))
        : lines;

      if (filteredLines.length === 0) {
        container.classList.add("centered");
        container.innerHTML =
          `<div style="color: #6b7280;">${lines.length === 0 ? "Журнал пуст" : "Нет совпадений"}</div>`;
      } else {
        container.classList.remove("centered");
        const processedLines = filteredLines
          .slice(-100)
          .map((line) => {
            const parsed = parseLogLine(line);
            return parsed
              ? `<div class="${parsed.className}">${parsed.content}</div>`
              : "";
          })
          .filter(Boolean);

        container.innerHTML = processedLines.join("");
      }

      if (wasAtBottom && !userScrolled) {
        container.scrollTop = container.scrollHeight;
      }

      lastLogContent = newContent;
    }
  } else {
    container.classList.add("centered");
    container.innerHTML = `<div style="color: #ef4444;">Ошибка загрузки логов: ${result.error}</div>`;
  }
}

async function checkStatus() {
  if (isActionInProgress) return;

  const result = await apiCall("status.sh");
  updateServiceStatus(result.running);
}

async function startXkeen() {
  try {
    setPendingState("Запускается...");
    const result = await apiCall("control.sh", { action: "start" });
    if (result.success) {
      showToast("XKeen запущен");
      isActionInProgress = false;
      isServiceRunning = true;
      updateServiceStatus(true);
    } else {
      showToast(
        `Ошибка запуска: ${result.output || result.error}`,
        "error"
      );
      isActionInProgress = false;
      checkStatus();
    }
  } catch (e) {
    isActionInProgress = false;
    checkStatus();
  }
}

async function stopXkeen() {
  try {
    setPendingState("Останавливается...");
    const result = await apiCall("control.sh", { action: "stop" });
    if (result.success) {
      showToast("XKeen остановлен");
      isServiceRunning = false;
      updateServiceStatus(false);
    } else {
      showToast(
        `Ошибка остановки: ${result.output || result.error}`,
        "error"
      );
    }
  } finally {
    isActionInProgress = false;
    checkStatus();
  }
}

async function restartXkeen() {
  try {
    setPendingState("Перезапускается...");
    const result = await apiCall("control.sh", { action: "restart" });
    if (result.success) {
      showToast("XKeen перезапущен");
      isActionInProgress = false;
      isServiceRunning = true;
      updateServiceStatus(true);
    } else {
      showToast(
        `Ошибка перезапуска: ${result.output || result.error}`,
        "error"
      );
      isActionInProgress = false;
      checkStatus();
    }
  } catch (e) {
    isActionInProgress = false;
    checkStatus();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const logsContainer = document.getElementById("logsContainer");
  const logSelectRoot = document.getElementById("logSelectRoot");
  const logSelectTrigger = document.getElementById("logSelectTrigger");
  const logSelectContent = document.getElementById("logSelectContent");
  const logSelectLabel = document.getElementById("logSelectLabel");
  const logFilterInput = document.getElementById("logFilterInput");
  const tabsList = document.getElementById("tabsList");
  if (tabsList) tabsList.classList.add("empty");
  isConfigsLoading = true;
  isStatusLoading = true;
  updateControlButtons();
  renderTabs();

  if (logFilterInput) {
    logFilterInput.addEventListener("input", () => {
      logFilter = logFilterInput.value || "";
      const wantStickToBottom =
        logsContainer.scrollTop + logsContainer.clientHeight >=
        logsContainer.scrollHeight - 5;
      if (lastLogContent !== null) {
        const lines = lastLogContent.split("\n").filter((line) => line.trim());
        const filteredLines = logFilter
          ? lines.filter((line) => line.includes(logFilter))
          : lines;
        if (filteredLines.length === 0) {
          logsContainer.classList.add("centered");
          logsContainer.innerHTML =
            `<div style=\"color: #6b7280;\">${lines.length === 0 ? "Журнал пуст" : "Нет совпадений"}</div>`;
        } else {
          logsContainer.classList.remove("centered");
          const processedLines = filteredLines
            .slice(-100)
            .map((line) => {
              const parsed = parseLogLine(line);
              return parsed
                ? `<div class=\"${parsed.className}\">${parsed.content}</div>`
                : "";
            })
            .filter(Boolean);
          logsContainer.innerHTML = processedLines.join("");
        }
        if (wantStickToBottom) {
          logsContainer.scrollTop = logsContainer.scrollHeight;
        }
      }
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
      { passive: false }
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

  function setActiveItem(value) {
    const items = logSelectContent.querySelectorAll(".select-item");
    items.forEach((el) => {
      const selected = el.getAttribute("data-value") === value;
      el.setAttribute("aria-selected", selected ? "true" : "false");
    });
  }

  function applyLogSelection(value) {
    if (currentLogFile === value) return;
    currentLogFile = value;
    logSelectLabel.textContent = value;
    setActiveItem(value);
    lastLogContent = null;
    logsContainer.classList.add("centered");
    logsContainer.innerHTML =
      '<div style="color: #6b7280;">Загрузка журнала...</div>';
    loadLogs();
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

  document.addEventListener("click", (e) => {
    if (!logSelectRoot.contains(e.target)) {
      closeLogMenu();
    }
  });

  logSelectTrigger.addEventListener("keydown", (e) => {
    const items = Array.from(
      logSelectContent.querySelectorAll(".select-item")
    );
    const currentIndex = items.findIndex(
      (i) => i.getAttribute("data-value") === currentLogFile
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
    const items = Array.from(
      logSelectContent.querySelectorAll(".select-item")
    );
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
  setActiveItem(currentLogFile);

  initMonacoEditor();
  checkStatus();
  logsContainer.classList.add("centered");
  logsContainer.innerHTML =
    '<div style="color: #6b7280;">Загрузка журнала...</div>';
  loadLogs();

  autoRefreshInterval = setInterval(() => {
    loadLogs();
  }, 2000);
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
