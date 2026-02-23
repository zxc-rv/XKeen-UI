import { useEffect, useRef } from "react";
import { AppProvider, useAppContext } from "./store";
import { apiCall, getFileLanguage, capitalize } from "./lib/api";
import { StatusBar } from "./components/StatusBar";
import { ConfigPanel } from "./components/ConfigPanel";
import { LogPanel } from "./components/LogPanel";
import { Toast } from "./components/Toast";
import { DirtyModal } from "./components/modals/DirtyModal";
import { CommentsWarningModal } from "./components/modals/CommentsWarningModal";
import { CoreManageModal } from "./components/modals/CoreManageModal";
import { UpdateModal } from "./components/modals/UpdateModal";
import { ImportModal } from "./components/modals/OutboundImportModal";
import { TemplateModal } from "./components/modals/TemplateImportModal";
import { SettingsModal } from "./components/modals/SettingsModal";
import { GeoScanModal } from "./components/modals/GeoScanModal";
import type { MonacoEditorRef } from "./components/MonacoEditor";
import type { Config } from "./types";

function AppContent() {
  const { state, dispatch, showToast } = useAppContext();
  const editorRef = useRef<MonacoEditorRef | null>(null);

  useEffect(() => {
    init();
  }, []);

  async function init() {
    try {
      await loadSettings();
      checkStatus();
      checkVersion();
    } catch {
      showToast("Ошибка инициализации", "error");
    }
  }

  async function loadSettings() {
    const data = await apiCall<any>("GET", "settings");
    if (data.success)
      dispatch({
        type: "SET_SETTINGS",
        settings: {
          autoApply: data.gui.auto_apply,
          guiRouting: data.gui.routing,
          guiLog: data.gui.log,
          autoCheckUI: data.updater.auto_check_ui ?? true,
          autoCheckCore: data.updater.auto_check_core ?? true,
          backupCore: data.updater.backup_core,
          githubProxies: data.updater.github_proxy || [],
          timezone: data.log.timezone,
        },
      });
  }

  async function checkStatus() {
    const data = await apiCall<any>("GET", "control");
    if (!data.success) return;
    dispatch({
      type: "SET_CORE_INFO",
      currentCore: data.currentCore || "xray",
      coreVersions: data.versions || {},
      availableCores: data.cores || [],
    });
    dispatch({
      type: "SET_SERVICE_STATUS",
      status: data.running ? "running" : "stopped",
    });
    await loadConfigs(data.currentCore);
  }

  async function checkVersion() {
    try {
      const data = await apiCall<any>("GET", "version");
      if (data.success && data.version) {
        dispatch({
          type: "SET_VERSION",
          version: data.version.replace(/^v/i, ""),
          isOutdatedUI: !!data.outdated?.ui,
        });
        if (data.show_toast?.ui) showToast("Доступна новая версия XKeen UI");
        if (data.show_toast?.core)
          showToast(`Доступна новая версия ${capitalize(state.currentCore)}`);
      }
    } catch {
      /* ignore */
    }
  }

  async function loadConfigs(core?: string) {
    dispatch({ type: "SET_CONFIGS_LOADING", loading: true });
    try {
      const url = core ? `/api/configs?core=${core}` : "/api/configs";
      const result = await (await fetch(url)).json();
      if (result.success && result.configs) {
        const configs: Config[] = result.configs.map((c: any) => ({
          ...c,
          savedContent: c.content,
          isDirty: false,
        }));
        dispatch({ type: "SET_CONFIGS", configs });
        const saved = localStorage.getItem("lastSelectedTab");
        const index = Math.max(
          0,
          configs.findIndex((c) => c.filename === saved),
        );
        // SET_ACTIVE_CONFIG + dashboard port — editor content is populated via onReady callback
        dispatch({ type: "SET_ACTIVE_CONFIG", index });
        const yamlConfig = configs.find(
          (c: any) => c.filename === "config.yaml",
        );
        const port =
          yamlConfig?.content.match(
            /^external-controller:\s*[\w.-]+:(\d+)/m,
          )?.[1] ?? null;
        dispatch({ type: "SET_DASHBOARD_PORT", port });
      } else {
        dispatch({ type: "SET_CONFIGS_LOADING", loading: false });
        showToast("Ошибка загрузки конфигураций", "error");
      }
    } catch (e: any) {
      dispatch({ type: "SET_CONFIGS_LOADING", loading: false });
      showToast(`Ошибка загрузки: ${e.message}`, "error");
    }
  }

  async function switchCore(core: string) {
    if (core === state.currentCore) {
      showToast("Это ядро уже активно", "error");
      return;
    }
    dispatch({ type: "SHOW_MODAL", modal: "showCoreManageModal", show: false });
    dispatch({
      type: "SET_CORE_INFO",
      currentCore: core,
      coreVersions: state.coreVersions,
      availableCores: state.availableCores,
    });
    await loadConfigs(core);
    dispatch({
      type: "SET_SERVICE_STATUS",
      status: "pending",
      pendingText: "Переключение...",
    });
    const result = await apiCall<any>("POST", "control", {
      action: "switchCore",
      core,
    });
    showToast(
      result.success
        ? `Ядро изменено на ${capitalize(core)}`
        : `Ошибка: ${result.error}`,
      result.success ? "success" : "error",
    );
    const data = await apiCall<any>("GET", "control");
    if (data.success) {
      dispatch({
        type: "SET_CORE_INFO",
        currentCore: data.currentCore,
        coreVersions: data.versions,
        availableCores: data.cores,
      });
      dispatch({
        type: "SET_SERVICE_STATUS",
        status: data.running ? "running" : "stopped",
      });
    }
  }

  async function handleSaveAndSwitch() {
    const { pendingSwitchIndex, configs, activeConfigIndex } = state;
    if (pendingSwitchIndex < 0) return;
    const config = configs[activeConfigIndex];
    if (config && editorRef.current) {
      const content = editorRef.current.getValue();
      await apiCall<any>("PUT", "configs", {
        action: "save",
        filename: config.filename,
        content,
      });
      dispatch({ type: "SAVE_CONFIG", index: activeConfigIndex, content });
    }
    dispatch({ type: "SHOW_MODAL", modal: "showDirtyModal", show: false });
    applySwitch(pendingSwitchIndex, configs);
  }

  function handleDiscardAndSwitch() {
    const { pendingSwitchIndex, configs, activeConfigIndex } = state;
    if (pendingSwitchIndex < 0) return;
    const config = configs[activeConfigIndex];
    if (config && editorRef.current)
      editorRef.current.setValue(config.savedContent);
    dispatch({
      type: "SAVE_CONFIG",
      index: activeConfigIndex,
      content: config.savedContent,
    });
    dispatch({ type: "SHOW_MODAL", modal: "showDirtyModal", show: false });
    applySwitch(pendingSwitchIndex, configs);
  }

  function applySwitch(index: number, configs: Config[]) {
    dispatch({ type: "SET_ACTIVE_CONFIG", index });
    dispatch({ type: "SET_PENDING_SWITCH", index: -1 });
    const target = configs[index];
    if (target && editorRef.current) {
      editorRef.current.setValue(target.content);
      editorRef.current.setLanguage(getFileLanguage(target.filename));
    }
  }

  function generateConfig(uri: string) {
    if (typeof (window as any).generateConfigForCore === "function")
      return (window as any).generateConfigForCore(
        uri,
        state.currentCore,
        editorRef.current?.getValue() ?? "",
      );
    throw new Error("Parser not loaded");
  }

  async function importTemplate(url: string) {
    const active = state.configs[state.activeConfigIndex];
    if (
      active?.isDirty &&
      !confirm("Несохраненные изменения будут потеряны. Продолжить?")
    )
      throw new Error("Отменено");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = await res.text();
    if (editorRef.current) {
      editorRef.current.setValue(content);
      dispatch({
        type: "UPDATE_CONFIG_DIRTY",
        index: state.activeConfigIndex,
        isDirty: true,
        content,
      });
    }
    showToast("Шаблон импортирован");
  }

  function addToConfig(
    generated: string,
    type: string,
    position: "start" | "end",
  ) {
    const editorWrapper = editorRef.current;
    if (!editorWrapper) return;
    const monacoEditor = editorWrapper.getEditor();
    if (!monacoEditor) return;
    const model = monacoEditor.getModel();
    if (!model) return;

    const current = editorWrapper.getValue();
    const core = state.currentCore;
    const stripComments = (s: string) =>
      s.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");

    const scrollToEdge = (ed: any, m: any) => {
      setTimeout(() => {
        ed.revealLine(position === "start" ? 1 : m.getLineCount());
      }, 100);
    };

    const insertAtOffset = (offset: number, text: string) => {
      const pos = model.getPositionAt(offset);
      monacoEditor.executeEdits("add-to-config", [
        {
          range: {
            startLineNumber: pos.lineNumber,
            startColumn: pos.column,
            endLineNumber: pos.lineNumber,
            endColumn: pos.column,
          },
          text,
        },
      ]);
      scrollToEdge(monacoEditor, model);
    };

    if (core === "mihomo") {
      const marker = type === "proxy" ? "proxies:" : "proxy-providers:";
      const idx = current.indexOf(marker);
      if (idx === -1) {
        insertAtOffset(current.length, `\n${marker}\n${generated}`);
        return;
      }
      if (position === "start") {
        insertAtOffset(current.indexOf("\n", idx) + 1, generated);
      } else {
        const afterMarker = current.indexOf("\n", idx) + 1;
        const nextKey = current.slice(afterMarker).search(/^[a-zA-Z]/m);
        const insertOffset =
          nextKey === -1 ? current.length : afterMarker + nextKey;
        insertAtOffset(insertOffset, generated + "\n");
      }
    } else {
      try {
        let targetIndex = state.activeConfigIndex;
        let obj;

        try {
          obj = JSON.parse(stripComments(current));
          if (!Array.isArray(obj.outbounds)) throw new Error();
        } catch {
          targetIndex = state.configs.findIndex((cfg) => {
            try {
              return Array.isArray(
                JSON.parse(stripComments(cfg.content)).outbounds,
              );
            } catch {
              return false;
            }
          });
          if (targetIndex === -1) {
            showToast("Массив outbounds не найден", "error");
            return;
          }
          obj = JSON.parse(stripComments(state.configs[targetIndex].content));
        }

        if (position === "start") obj.outbounds.unshift(JSON.parse(generated));
        else obj.outbounds.push(JSON.parse(generated));

        const newContent = JSON.stringify(obj, null, 2);

        if (targetIndex !== state.activeConfigIndex) {
          dispatch({ type: "SET_ACTIVE_CONFIG", index: targetIndex });
        }

        setTimeout(() => {
          const ed = editorRef.current?.getEditor();
          const m = ed?.getModel();
          if (!ed || !m) return;
          ed.executeEdits("add-to-config", [
            { range: m.getFullModelRange(), text: newContent },
          ]);
          scrollToEdge(ed, m);
        }, 150);
      } catch (e: any) {
        showToast(`Ошибка: ${e.message}`, "error");
      }
    }
  }

  const openModal = (modal: string) =>
    dispatch({ type: "SHOW_MODAL", modal: modal as any, show: true });

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <main className="flex-1 flex flex-col">
        <div className="w-full max-w-7xl mx-auto flex-1 flex flex-col gap-3 py-3 px-3 sm:px-4">
          <StatusBar
            onOpenCoreManage={() => openModal("showCoreManageModal")}
            onOpenSettings={() => openModal("showSettingsModal")}
            onOpenUpdate={(core) => {
              dispatch({ type: "SET_UPDATE_MODAL_CORE", core });
              openModal("showUpdateModal");
            }}
          />
          <ConfigPanel
            editorRef={editorRef}
            onOpenImport={() => openModal("showImportModal")}
            onOpenTemplate={() => openModal("showTemplateModal")}
            onOpenGeoScan={() => openModal("showGeoScanModal")}
          />
          <LogPanel />
        </div>
      </main>

      <Toast />
      <DirtyModal
        onSaveAndSwitch={handleSaveAndSwitch}
        onDiscardAndSwitch={handleDiscardAndSwitch}
      />
      <CommentsWarningModal />
      <CoreManageModal
        onSwitchCore={switchCore}
        onOpenUpdate={(core) => {
          dispatch({ type: "SET_UPDATE_MODAL_CORE", core });
          openModal("showUpdateModal");
        }}
      />
      <UpdateModal onInstalled={checkStatus} />
      <ImportModal onGenerate={generateConfig} onAddToConfig={addToConfig} />
      <TemplateModal onImport={importTemplate} />
      <SettingsModal />
      <GeoScanModal />
    </div>
  );
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
