import { useEffect, useRef, useState } from "react";
import { AppProvider, useAppContext } from "./lib/store";
import { apiCall, capitalize } from "./lib/api";
import { stripJsonComments } from "./lib/utils";
import { StatusBar } from "./modules/status/StatusBar";
import { ConfigPanel } from "./modules/configuration/ConfigPanel";
import { LogPanel } from "./modules/log/LogPanel";
import { Toast } from "./components/Toast";
import { CommentsWarningModal } from "./modules/modals/CommentsWarning";
import { CoreManageModal } from "./modules/modals/CoreManagement";
import { UpdateModal } from "./modules/modals/Update";
import { ImportModal } from "./modules/modals/AddProxy";
import { TemplateModal } from "./modules/modals/Templates";
import { SettingsModal } from "./modules/modals/Settings";
import { GeoScanModal } from "./modules/modals/GeoScan";
import type { MonacoEditorRef } from "./modules/configuration/MonacoEditor";
import type { Config } from "./lib/types";

function useLazyMount(open: boolean, delay = 200) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
    } else {
      const timer = setTimeout(() => setMounted(false), delay);
      return () => clearTimeout(timer);
    }
  }, [open, delay]);
  return mounted;
}

function AppContent() {
  const { state, dispatch, showToast } = useAppContext();
  const editorRef = useRef<MonacoEditorRef | null>(null);

  const mountCommentsWarning = useLazyMount(state.showCommentsWarningModal);
  const mountCoreManage = useLazyMount(state.showCoreManageModal);
  const mountUpdate = useLazyMount(state.showUpdateModal);
  const mountImport = useLazyMount(state.showImportModal);
  const mountTemplate = useLazyMount(state.showTemplateModal);
  const mountSettings = useLazyMount(state.showSettingsModal);
  const mountGeoScan = useLazyMount(state.showGeoScanModal);

  useEffect(() => {
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        if (data.show_toast?.ui)
          showToast({
            title: "Доступно обновление",
            body: "Доступна новая версия XKeen UI",
          });
        if (data.show_toast?.core)
          showToast({
            title: "Доступно обновление",
            body: `Доступна новая версия ${capitalize(state.currentCore)}`,
          });
      }
    } catch {
      /* ignore */
    }
  }

  async function loadConfigs(core?: string): Promise<Config[]> {
    dispatch({ type: "SET_CONFIGS_LOADING", loading: true });
    try {
      const result = await apiCall<any>(
        "GET",
        core ? `configs?core=${core}` : "configs",
      );
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
          configs.findIndex((c) => c.file === saved),
        );
        dispatch({ type: "SET_ACTIVE_CONFIG", index });
        const yamlConfig = configs.find(
          (c: any) =>
            c.file.endsWith("/config.yaml") || c.file === "config.yaml",
        );
        const port =
          yamlConfig?.content.match(
            /^external-controller:\s*[\w.-]+:(\d+)/m,
          )?.[1] ?? null;
        dispatch({ type: "SET_DASHBOARD_PORT", port });
        return configs;
      } else {
        dispatch({ type: "SET_CONFIGS_LOADING", loading: false });
        showToast("Ошибка загрузки конфигураций", "error");
      }
    } catch (e: any) {
      dispatch({ type: "SET_CONFIGS_LOADING", loading: false });
      showToast(`Ошибка загрузки: ${e.message}`, "error");
    }
    return [];
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
    const configs = await loadConfigs(core);
    const mihomoYamlEmpty =
      core === "mihomo" &&
      !configs
        .find(
          (c) => c.file.endsWith("/config.yaml") || c.file === "config.yaml",
        )
        ?.content.trim();
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
      if (result.success && mihomoYamlEmpty) await loadConfigs(core);
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
    const core = state.currentCore;
    let targetIndex = state.activeConfigIndex;

    if (core === "mihomo") {
      targetIndex = state.configs.findIndex(
        (c) => c.file.endsWith("/config.yaml") || c.file === "config.yaml",
      );
      if (targetIndex === -1) {
        showToast("Файл config.yaml не найден", "error");
        return;
      }
    } else {
      try {
        let obj;
        try {
          obj = JSON.parse(
            stripJsonComments(state.configs[targetIndex].content),
          );
          if (!Array.isArray(obj.outbounds)) throw new Error();
        } catch {
          targetIndex = state.configs.findIndex((cfg) => {
            try {
              return Array.isArray(
                JSON.parse(stripJsonComments(cfg.content)).outbounds,
              );
            } catch {
              return false;
            }
          });
          if (targetIndex === -1) {
            showToast("Массив outbounds не найден", "error");
            return;
          }
        }
      } catch (e: any) {
        showToast(`Ошибка: ${e.message}`, "error");
        return;
      }
    }

    if (targetIndex !== state.activeConfigIndex) {
      dispatch({ type: "SET_ACTIVE_CONFIG", index: targetIndex });
    }

    setTimeout(() => {
      const editorWrapper = editorRef.current;
      if (!editorWrapper) return;
      const monacoEditor = editorWrapper.getEditor();
      if (!monacoEditor) return;
      const model = monacoEditor.getModel();
      if (!model) return;

      const current = editorWrapper.getValue();

      const lineAtOffset = (text: string, offset: number) =>
        text.slice(0, Math.min(offset, text.length)).split("\n").length;

      const scrollToLine = (editor: any, line: number) => {
        setTimeout(() => editor.revealLineInCenter(Math.max(1, line)), 100);
      };

      const insertAtOffset = (
        offset: number,
        text: string,
        scrollLine?: number,
      ) => {
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
        scrollToLine(monacoEditor, scrollLine ?? pos.lineNumber);
      };

      if (core === "mihomo") {
        const marker = type === "proxy" ? "proxies:" : "proxy-providers:";
        const markerIdx = current.indexOf(marker);

        if (markerIdx === -1) {
          insertAtOffset(
            current.length,
            `\n${marker}\n${generated}`,
            lineAtOffset(current, current.length) + 2,
          );
          return;
        }

        const markerLineEnd = current.indexOf("\n", markerIdx) + 1;

        if (position === "start") {
          const targetLine = lineAtOffset(current, markerLineEnd);
          insertAtOffset(markerLineEnd, generated, targetLine);
        } else {
          const afterMarker = markerLineEnd;
          const nextKeyMatch = current.slice(afterMarker).search(/^[a-zA-Z]/m);
          const insertOffset =
            nextKeyMatch === -1 ? current.length : afterMarker + nextKeyMatch;
          const targetLine = lineAtOffset(current, insertOffset) - 1;
          insertAtOffset(insertOffset, generated + "\n", targetLine);
        }
      } else {
        try {
          const obj = JSON.parse(stripJsonComments(current));
          if (position === "start")
            obj.outbounds.unshift(JSON.parse(generated));
          else obj.outbounds.push(JSON.parse(generated));

          const newContent = JSON.stringify(obj, null, 2);
          monacoEditor.executeEdits("add-to-config", [
            { range: model.getFullModelRange(), text: newContent },
          ]);
          scrollToLine(
            monacoEditor,
            position === "start" ? 1 : model.getLineCount(),
          );
        } catch (e: any) {
          showToast(`Ошибка парсинга: ${e.message}`, "error");
        }
      }
    }, 150);
  }

  const openModal = (modal: string) =>
    dispatch({ type: "SHOW_MODAL", modal: modal as any, show: true });

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <main className="flex-1 flex flex-col">
        <div className="w-full max-w-7xl mx-auto flex-1 flex flex-col gap-3 py-3 px-3">
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
      {mountCommentsWarning && <CommentsWarningModal />}
      {mountCoreManage && (
        <CoreManageModal
          onSwitchCore={switchCore}
          onOpenUpdate={(core) => {
            dispatch({ type: "SET_UPDATE_MODAL_CORE", core });
            openModal("showUpdateModal");
          }}
        />
      )}
      {mountUpdate && <UpdateModal onInstalled={checkStatus} />}
      {mountImport && (
        <ImportModal onGenerate={generateConfig} onAddToConfig={addToConfig} />
      )}
      {mountTemplate && <TemplateModal onImport={importTemplate} />}
      {mountSettings && <SettingsModal />}
      {mountGeoScan && <GeoScanModal />}
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
