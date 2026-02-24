import { useState, useEffect, useCallback, useRef } from "react";
import {
  IconExternalLink,
  IconDeviceFloppy,
  IconLink,
  IconFileText,
  IconSearch,
  IconRefresh,
  IconCode,
  IconMenu2,
} from "@tabler/icons-react";
import * as jsyaml from "js-yaml";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "../lib/utils";
import { useAppContext } from "../store";
import { apiCall, getFileLanguage } from "../lib/api";
import { MonacoEditor, type MonacoEditorRef } from "./MonacoEditor";
import { RoutingPanel } from "./GuiRouting";
import { GuiLog } from "./GuiLog";
import type { Config } from "../types";

interface Props {
  onOpenImport: () => void;
  onOpenTemplate: () => void;
  onOpenGeoScan: () => void;
  editorRef: React.RefObject<MonacoEditorRef | null>;
}

export function ConfigPanel({
  onOpenImport,
  onOpenTemplate,
  onOpenGeoScan,
  editorRef,
}: Props) {
  const { state, dispatch, showToast } = useAppContext();
  const {
    configs,
    activeConfigIndex,
    isConfigsLoading,
    currentCore,
    serviceStatus,
    settings,
    dashboardPort,
  } = state;

  const [validationState, setValidationState] = useState<{
    isValid: boolean;
    error?: string;
  } | null>(null);
  const [monacoReady, setMonacoReady] = useState(false);

  const configsRef = useRef(configs);
  const activeIndexRef = useRef(activeConfigIndex);
  const viewStatesRef = useRef<Record<string, any>>({});

  useEffect(() => {
    configsRef.current = configs;
  }, [configs]);

  useEffect(() => {
    activeIndexRef.current = activeConfigIndex;
  }, [activeConfigIndex]);

  const activeConfig = configs[activeConfigIndex];
  const isRunning = serviceStatus === "running";
  const isPending = serviceStatus === "pending";
  const fileLanguage = activeConfig
    ? getFileLanguage(activeConfig.filename)
    : null;
  const isJsonOrYaml = fileLanguage === "json" || fileLanguage === "yaml";
  const canSave = !!(activeConfig?.isDirty && validationState?.isValid);
  const canApply = canSave && isRunning && !isPending;
  const canFormat = !!(isJsonOrYaml && validationState?.isValid);

  const configFilenamesKey = configs.map((c) => c.filename).join(",");

  const loadConfigIntoEditor = useCallback(
    (config: Config) => {
      if (!editorRef.current) return;
      editorRef.current.setSavedContent(config.savedContent);
      editorRef.current.setValue(config.content, config.savedContent);
      editorRef.current.setLanguage(getFileLanguage(config.filename));
      editorRef.current.validate(config.filename);

      const savedState = viewStatesRef.current[config.filename];
      if (savedState) editorRef.current.restoreViewState(savedState);
    },
    [editorRef],
  );

  useEffect(() => {
    const config = configsRef.current[activeConfigIndex];
    if (monacoReady && config && editorRef.current) {
      loadConfigIntoEditor(config);
    }
  }, [
    activeConfigIndex,
    configFilenamesKey,
    monacoReady,
    loadConfigIntoEditor,
    editorRef,
  ]);

  const handleMonacoReady = useCallback(() => {
    setMonacoReady(true);
    const config = configsRef.current[activeIndexRef.current];
    if (!config || !editorRef.current) return;
    editorRef.current.setSavedContent(config.savedContent);
    editorRef.current.setValue(config.content, config.savedContent);
    editorRef.current.setLanguage(getFileLanguage(config.filename));
    editorRef.current.validate(config.filename);
  }, [editorRef]);

  const handleContentChange = useCallback(
    (content: string, isDirty: boolean) => {
      const index = activeIndexRef.current;
      if (index < 0) return;
      dispatch({ type: "UPDATE_CONFIG_DIRTY", index, isDirty, content });
    },
    [dispatch],
  );

  const handleValidationChange = useCallback(
    (isValid: boolean, error?: string) => {
      setValidationState({ isValid, error });
    },
    [],
  );

  function switchTab(index: number) {
    if (index === activeConfigIndex) return;
    applyTabSwitch(index);
  }

  function applyTabSwitch(index: number) {
    const config = configs[index];
    if (!config) return;

    const currentCfg = configsRef.current[activeIndexRef.current];
    if (currentCfg && editorRef.current) {
      viewStatesRef.current[currentCfg.filename] =
        editorRef.current.saveViewState();
    }

    activeIndexRef.current = index;
    dispatch({ type: "SET_ACTIVE_CONFIG", index });
    setTimeout(
      () => localStorage.setItem("lastSelectedTab", config.filename),
      0,
    );
  }

  async function saveCurrentConfig(force = false) {
    const cfg = configsRef.current[activeIndexRef.current];
    if (!cfg || !editorRef.current) return;
    const content = editorRef.current.getValue();
    if (!content.trim()) return showToast("Конфигурация пустая", "error");
    if (!editorRef.current.isValid(cfg.filename))
      return showToast("Файл содержит ошибки", "error");
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({
        type: "SET_PENDING_SAVE_ACTION",
        action: () => saveCurrentConfig(true),
      });
      dispatch({
        type: "SHOW_MODAL",
        modal: "showCommentsWarningModal",
        show: true,
      });
      return;
    }
    const result = await apiCall<{ success: boolean; error?: string }>(
      "PUT",
      "configs",
      {
        action: "save",
        filename: cfg.filename,
        content,
      },
    );
    if (result.success) {
      editorRef.current.setSavedContent(content);
      dispatch({ type: "SAVE_CONFIG", index: activeIndexRef.current, content });
      showToast(`Файл "${cfg.name}" сохранен`);
    } else {
      showToast(`Ошибка сохранения: ${result.error}`, "error");
    }
  }

  async function saveAndApply(force = false) {
    const cfg = configsRef.current[activeIndexRef.current];
    if (!cfg || !editorRef.current) return;
    const content = editorRef.current.getValue();
    if (!content.trim()) return showToast("Конфиг пустой", "error");
    if (!editorRef.current.isValid(cfg.filename))
      return showToast("Файл содержит ошибки", "error");
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({
        type: "SET_PENDING_SAVE_ACTION",
        action: () => saveAndApply(true),
      });
      dispatch({
        type: "SHOW_MODAL",
        modal: "showCommentsWarningModal",
        show: true,
      });
      return;
    }
    const saveResult = await apiCall<{ success: boolean; error?: string }>(
      "PUT",
      "configs",
      {
        action: "save",
        filename: cfg.filename,
        content,
      },
    );
    if (!saveResult.success)
      return showToast(`Ошибка сохранения: ${saveResult.error}`, "error");
    editorRef.current.setSavedContent(content);
    dispatch({ type: "SAVE_CONFIG", index: activeIndexRef.current, content });
    dispatch({
      type: "SET_SERVICE_STATUS",
      status: "pending",
      pendingText: "Перезапуск...",
    });
    const lang = getFileLanguage(cfg.filename);
    const r = await apiCall<{ success: boolean; error?: string }>(
      "POST",
      "control",
      {
        action:
          (lang === "json" || lang === "yaml") &&
          !hasCriticalChanges(cfg.savedContent, content, lang)
            ? "softRestart"
            : "hardRestart",
        core: currentCore,
      },
    );
    showToast(
      r?.success ? "Изменения применены" : `Ошибка: ${r?.error}`,
      r?.success ? "success" : "error",
    );
    dispatch({ type: "SET_SERVICE_STATUS", status: "running" });
  }

  function isGuiActive(cfg: Config) {
    const f = cfg.filename.toLowerCase();
    return (
      (f.includes("routing") && settings.guiRouting) ||
      (f.includes("log") && settings.guiLog)
    );
  }

  const isRoutingGui =
    settings.guiRouting &&
    !!activeConfig &&
    activeConfig.filename.toLowerCase().includes("routing") &&
    (() => {
      try {
        const j = JSON.parse(
          activeConfig.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""),
        );
        return j && typeof j.routing === "object";
      } catch {
        return false;
      }
    })();

  const isLogGui =
    settings.guiLog &&
    !!activeConfig &&
    activeConfig.filename.toLowerCase().includes("log") &&
    (() => {
      try {
        const j = JSON.parse(
          activeConfig.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""),
        );
        return j && typeof j.log === "object";
      } catch {
        return false;
      }
    })();

  const isAnyGui = isRoutingGui || isLogGui;

  const coreConfigs = configs.filter((c) => !c.filename.endsWith(".lst"));
  const xkeenConfigs = configs.filter((c) => c.filename.endsWith(".lst"));

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col rounded-xl border border-border bg-card overflow-hidden md:flex-1 md:min-h-0">
        <div className="px-3 sm:px-4 pt-3 sm:pt-4 flex flex-col md:flex-row md:items-center gap-2 shrink-0">
          <div className="flex items-center gap-2 shrink-0">
            <h2 className="text-lg font-semibold shrink-0 select-none">
              Конфигурация
            </h2>
            {dashboardPort && currentCore === "mihomo" && (
              <a
                href={`http://${location.hostname}:${dashboardPort}/ui`}
                target="_blank"
                rel="noreferrer"
              >
                <Badge
                  variant="default"
                  className="gap-1 cursor-pointer text-xs hover:bg-primary/80 transition-colors"
                >
                  Dashboard <IconExternalLink size={11} />
                </Badge>
              </a>
            )}
          </div>
          <div className="overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:ml-auto">
            {isConfigsLoading ? (
              <div className="flex gap-2">
                {[524, 311].map((w) => (
                  <Skeleton
                    key={w}
                    className="h-9 rounded-lg p-0.75 gap-0.5"
                    style={{ width: w }}
                  />
                ))}
              </div>
            ) : (
              <Tabs
                value={activeConfig?.filename || ""}
                onValueChange={(value) => {
                  const index = configs.findIndex((c) => c.filename === value);
                  if (index >= 0) switchTab(index);
                }}
                className="flex flex-row! items-center gap-2 w-full"
              >
                {coreConfigs.length > 0 && (
                  <TabsList className="shrink-0">
                    {coreConfigs.map((config) => (
                      <TabsTrigger
                        key={config.filename}
                        value={config.filename}
                        className="relative data-[state=active]:bg-input-background!"
                      >
                        {config.name}
                        {config.isDirty && (
                          <span className="absolute top-0.75 right-0.75 w-1.5 h-1.5 rounded-full bg-amber-400" />
                        )}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                )}
                {xkeenConfigs.length > 0 && (
                  <TabsList className="shrink-0">
                    {xkeenConfigs.map((config) => (
                      <TabsTrigger
                        key={config.filename}
                        value={config.filename}
                        className="relative data-[state=active]:bg-input-background!"
                      >
                        {config.name}
                        {config.isDirty && (
                          <span className="absolute top-0.75 right-0.75 w-1.5 h-1.5 rounded-full bg-amber-400" />
                        )}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                )}
              </Tabs>
            )}
          </div>
        </div>

        <div className="relative min-h-[70dvh] md:flex-1 md:min-h-0">
          {monacoReady && activeConfig && isRoutingGui && (
            <RoutingPanel
              editorRef={editorRef}
              configs={configs}
              activeConfigIndex={activeConfigIndex}
            />
          )}
          {monacoReady && activeConfig && isLogGui && (
            <GuiLog
              editorRef={editorRef}
              configs={configs}
              activeConfigIndex={activeConfigIndex}
            />
          )}

          <div
            className={cn(
              "absolute inset-0",
              isAnyGui && "invisible opacity-0 pointer-events-none",
            )}
          >
            <MonacoEditor
              ref={editorRef}
              onContentChange={handleContentChange}
              onValidationChange={handleValidationChange}
              onReady={handleMonacoReady}
            />

            {(!monacoReady || isConfigsLoading) && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-card text-muted-foreground text-sm">
                {isConfigsLoading
                  ? "Загрузка конфигураций..."
                  : "Инициализация редактора..."}
              </div>
            )}
          </div>
        </div>

        <div className="px-3 sm:px-4 pb-3 sm:pb-4 flex flex-wrap items-center justify-between gap-1.5 shrink-0">
          <div className="text-xs min-w-0">
            {isConfigsLoading ? (
              <Skeleton className="h-4 w-28" />
            ) : validationState && activeConfig && isJsonOrYaml ? (
              <span
                className={cn(
                  "flex items-center gap-1.5 tracking-wide text-[13px]",
                  validationState.isValid
                    ? "text-green-400/90"
                    : "text-red-500",
                )}
              >
                {validationState.isValid ? "✓ " : "✗ "}
                {validationState.isValid
                  ? `${fileLanguage?.toUpperCase()} валиден`
                  : `Ошибка: ${validationState.error || "Файл невалиден"}`}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {isConfigsLoading ? (
              <div className="flex gap-1.5">
                {[126, 121, 136].map((w) => (
                  <Skeleton
                    key={w}
                    className="h-9 rounded-md"
                    style={{ width: w }}
                  />
                ))}
              </div>
            ) : (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="default"
                      disabled={!canApply}
                      className="gap-1.5 h-9 px-3 bg-green-600 hover:bg-green-700 text-white"
                      onClick={() => saveAndApply()}
                    >
                      <IconRefresh size={14} /> Применить
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Сохранить и перезапустить</TooltipContent>
                </Tooltip>
                <Button
                  size="default"
                  className="h-9 gap-1.5 px-3"
                  disabled={!canSave}
                  onClick={() => saveCurrentConfig()}
                >
                  <IconDeviceFloppy size={14} /> Сохранить
                </Button>
                <div className="flex h-9 rounded-md overflow-hidden border border-border">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="default"
                        disabled={!canFormat}
                        className="h-full rounded-none border-0 gap-1.5 px-3"
                        onClick={() => editorRef.current?.format()}
                      >
                        <IconCode size={14} /> Формат
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Форматировать файл</TooltipContent>
                  </Tooltip>
                  <div className="w-px bg-border" />

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-full w-8 rounded-none border-0"
                      >
                        <IconMenu2 />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-max">
                      <DropdownMenuLabel>Утилиты</DropdownMenuLabel>
                      <DropdownMenuItem onClick={onOpenImport}>
                        <IconLink /> Добавить Прокси
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={onOpenTemplate}>
                        <IconFileText /> Шаблоны Конфигураций
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={onOpenGeoScan}>
                        <IconSearch /> Скан Геофайлов
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function hasComments(content: string) {
  return /\/\/|\/\*[\s\S]*?\*\//.test(content);
}

function hasCriticalChanges(
  oldContent: string,
  newContent: string,
  language: string,
): boolean {
  try {
    if (language === "yaml") {
      const o = jsyaml.load(oldContent) as Record<string, unknown>;
      const n = jsyaml.load(newContent) as Record<string, unknown>;
      return ["listeners", "redir-port", "tproxy-port"].some(
        (f) => JSON.stringify(o?.[f]) !== JSON.stringify(n?.[f]),
      );
    }
    if (language === "json") {
      const strip = (s: string) => s.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
      const o = JSON.parse(strip(oldContent));
      const n = JSON.parse(strip(newContent));
      const clean = (arr: Record<string, unknown>[]) =>
        (arr || []).map(({ sniffing: _, ...rest }) => rest);
      return (
        JSON.stringify(clean(o?.inbounds)) !==
        JSON.stringify(clean(n?.inbounds))
      );
    }
  } catch {
    return false;
  }
  return false;
}
