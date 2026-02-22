import { useState, useEffect, useCallback, useRef } from "react"
import {
  IconExternalLink,
  IconDeviceFloppy,
  IconLink,
  IconFileText,
  IconSearch,
  IconChevronDown,
  IconRefresh,
  IconCode,
} from "@tabler/icons-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "../lib/utils"
import { useAppContext } from "../store"
import { apiCall, getFileLanguage } from "../lib/api"
import { MonacoEditor, type MonacoEditorRef } from "./MonacoEditor"
import { RoutingPanel } from "./GuiRouting"
import { GuiLog } from "./GuiLog"
import type { Config } from "../types"

interface Props {
  onOpenImport: () => void
  onOpenTemplate: () => void
  onOpenGeoScan: () => void
  editorRef: React.RefObject<MonacoEditorRef | null>
}

export function ConfigPanel({ onOpenImport, onOpenTemplate, onOpenGeoScan, editorRef }: Props) {
  const { state, dispatch, showToast } = useAppContext()
  const { configs, activeConfigIndex, isConfigsLoading, currentCore, serviceStatus, settings, dashboardPort } = state

  const [validationState, setValidationState] = useState<{ isValid: boolean; error?: string } | null>(null)
  const [monacoReady, setMonacoReady] = useState(false)

  const configsRef = useRef(configs)
  const activeIndexRef = useRef(activeConfigIndex)
  configsRef.current = configs
  activeIndexRef.current = activeConfigIndex

  const activeConfig = configs[activeConfigIndex]
  const isRunning = serviceStatus === "running"
  const isPending = serviceStatus === "pending"
  const fileLanguage = activeConfig ? getFileLanguage(activeConfig.filename) : null
  const isJsonOrYaml = fileLanguage === "json" || fileLanguage === "yaml"
  const canSave = !!(activeConfig?.isDirty && validationState?.isValid)
  const canApply = canSave && isRunning && !isPending
  const canFormat = !!(isJsonOrYaml && validationState?.isValid)

  const ed = () => editorRef.current as (MonacoEditorRef & { setSavedContent: (s: string) => void }) | null

  const configFilenamesKey = configs.map((c) => c.filename).join(",")

  useEffect(() => {
    if (monacoReady && activeConfig && editorRef.current) {
      loadConfigIntoEditor(activeConfig)
    }
  }, [activeConfigIndex, configFilenamesKey, monacoReady])

  useEffect(() => {
    loadMonacoAndInit()
  }, [])

  async function loadMonacoAndInit() {
    const load = (src: string) =>
      new Promise<void>((res, rej) => {
        const s = document.createElement("script")
        s.src = src
        s.onload = () => res()
        s.onerror = rej
        document.head.appendChild(s)
      })
    try {
      if (window.LOCAL) {
        window.MonacoEnvironment = { getWorkerUrl: () => "/monaco-editor/vs/base/worker/workerMain.js" }
        for (const s of [
          "/monaco-editor/standalone.min.js",
          "/monaco-editor/babel.min.js",
          "/monaco-editor/yaml.min.js",
          "/monaco-editor/js-yaml.min.js",
          "/monaco-editor/loader.min.js",
        ])
          await load(s)
      } else {
        for (const s of [
          "https://cdn.jsdelivr.net/npm/prettier@2/standalone.min.js",
          "https://cdn.jsdelivr.net/npm/prettier@3/plugins/babel.min.js",
          "https://cdn.jsdelivr.net/npm/prettier@3/plugins/yaml.min.js",
          "https://cdn.jsdelivr.net/npm/js-yaml@4/dist/js-yaml.min.js",
          "https://cdn.jsdelivr.net/npm/monaco-editor@0.55/min/vs/loader.min.js",
        ])
          await load(s)
      }
      const vsPath = window.LOCAL ? "/monaco-editor/vs" : "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs"
      window.require.config({ paths: { vs: vsPath } })
      await new Promise<void>((res, rej) => window.require(["vs/editor/editor.main"], res, rej))
      window.monaco.languages.json.jsonDefaults.setDiagnosticsOptions({ allowComments: true })
      window.monaco.languages.json.jsonDefaults.setModeConfiguration({
        ...window.monaco.languages.json.jsonDefaults.modeConfiguration,
        documentFormattingEdits: false,
      })
      setMonacoReady(true)
    } catch {
      showToast("Ошибка загрузки редактора", "error")
    }
  }

  const handleMonacoReady = useCallback(() => {
    const config = configsRef.current[activeIndexRef.current]
    if (!config || !ed()) return
    ed()!.setSavedContent(config.savedContent)
    ed()!.setValue(config.content, config.savedContent)
    ed()!.setLanguage(getFileLanguage(config.filename))
    ed()!.validate(config.filename)
  }, [])

  const handleContentChange = useCallback(
    (content: string, isDirty: boolean) => {
      const index = activeIndexRef.current
      if (index < 0) return
      dispatch({ type: "UPDATE_CONFIG_DIRTY", index, isDirty, content })
    },
    [dispatch],
  )

  const handleValidationChange = useCallback((isValid: boolean, error?: string) => {
    setValidationState({ isValid, error })
  }, [])

  function loadConfigIntoEditor(config: Config) {
    if (!ed()) return
    ed()!.setSavedContent(config.savedContent)
    ed()!.setValue(config.content, config.savedContent)
    ed()!.setLanguage(getFileLanguage(config.filename))
    ed()!.validate(config.filename)
    setValidationState(null)
  }

  function switchTab(index: number) {
    if (index === activeConfigIndex) return
    if (configs[activeConfigIndex]?.isDirty) {
      dispatch({ type: "SET_PENDING_SWITCH", index })
      dispatch({ type: "SHOW_MODAL", modal: "showDirtyModal", show: true })
      return
    }
    applyTabSwitch(index)
  }

  function applyTabSwitch(index: number) {
    const config = configs[index]
    if (!config) return
    activeIndexRef.current = index
    dispatch({ type: "SET_ACTIVE_CONFIG", index })
    setTimeout(() => localStorage.setItem("lastSelectedTab", config.filename), 0)
  }

  async function saveCurrentConfig(force = false) {
    const cfg = configsRef.current[activeIndexRef.current]
    if (!cfg || !ed()) return
    const content = ed()!.getValue()
    if (!content.trim()) return showToast("Конфигурация пустая", "error")
    if (!ed()!.isValid(cfg.filename)) return showToast("Файл содержит ошибки", "error")
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: "SET_PENDING_SAVE_ACTION", action: () => saveCurrentConfig(true) })
      dispatch({ type: "SHOW_MODAL", modal: "showCommentsWarningModal", show: true })
      return
    }
    const result = await apiCall<any>("PUT", "configs", { action: "save", filename: cfg.filename, content })
    if (result.success) {
      ed()!.setSavedContent(content)
      dispatch({ type: "SAVE_CONFIG", index: activeIndexRef.current, content })
      showToast(`Конфигурация "${cfg.name}" сохранена`)
    } else {
      showToast(`Ошибка сохранения: ${result.error}`, "error")
    }
  }

  async function saveAndApply(force = false) {
    const cfg = configsRef.current[activeIndexRef.current]
    if (!cfg || !ed()) return
    const content = ed()!.getValue()
    if (!content.trim()) return showToast("Конфиг пустой", "error")
    if (!ed()!.isValid(cfg.filename)) return showToast("Файл содержит ошибки", "error")
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: "SET_PENDING_SAVE_ACTION", action: () => saveAndApply(true) })
      dispatch({ type: "SHOW_MODAL", modal: "showCommentsWarningModal", show: true })
      return
    }
    const saveResult = await apiCall<any>("PUT", "configs", { action: "save", filename: cfg.filename, content })
    if (!saveResult.success) return showToast(`Ошибка сохранения: ${saveResult.error}`, "error")
    ed()!.setSavedContent(content)
    dispatch({ type: "SAVE_CONFIG", index: activeIndexRef.current, content })
    dispatch({ type: "SET_SERVICE_STATUS", status: "pending", pendingText: "Перезапуск..." })
    const lang = getFileLanguage(cfg.filename)
    const r = await apiCall<any>("POST", "control", {
      action: (lang === "json" || lang === "yaml") && !hasCriticalChanges(cfg.savedContent, content, lang) ? "softRestart" : "hardRestart",
      core: currentCore,
    })
    showToast(r?.success ? "Изменения применены" : `Ошибка: ${r?.error}`, r?.success ? "success" : "error")
    dispatch({ type: "SET_SERVICE_STATUS", status: "running" })
  }

  function isGuiActive(cfg: Config) {
    const f = cfg.filename.toLowerCase()
    return (f.includes("routing") && settings.guiRouting) || (f.includes("log") && settings.guiLog)
  }

  const isRoutingGui =
    settings.guiRouting &&
    !!activeConfig &&
    activeConfig.filename.toLowerCase().includes("routing") &&
    (() => {
      try {
        const j = JSON.parse(activeConfig.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
        return j && typeof j.routing === "object"
      } catch {
        return false
      }
    })()

  const isLogGui =
    settings.guiLog &&
    !!activeConfig &&
    activeConfig.filename.toLowerCase().includes("log") &&
    (() => {
      try {
        const j = JSON.parse(activeConfig.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
        return j && typeof j.log === "object"
      } catch {
        return false
      }
    })()

  const isAnyGui = isRoutingGui || isLogGui

  const coreConfigs = configs.filter((c) => !c.filename.endsWith(".lst"))
  const xkeenConfigs = configs.filter((c) => c.filename.endsWith(".lst"))

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col rounded-xl border border-border bg-card overflow-hidden md:flex-1 md:min-h-0">
        <div className="px-3 sm:px-4 pt-3 sm:pt-4 flex flex-col md:flex-row md:items-center gap-2 shrink-0">
          <div className="flex items-center gap-2 shrink-0">
            <h2 className="text-lg font-semibold shrink-0">Конфигурация</h2>
            {dashboardPort && currentCore === "mihomo" && (
              <a href={`http://${location.hostname}:${dashboardPort}/ui`} target="_blank" rel="noreferrer">
                <Badge variant="default" className="gap-1 cursor-pointer text-xs hover:bg-primary/80 transition-colors">
                  Dashboard <IconExternalLink size={11} />
                </Badge>
              </a>
            )}
          </div>
          <div className="overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:ml-auto">
            {isConfigsLoading ? (
              <div className="flex gap-2">
                {[280, 160].map((w) => (
                  <Skeleton key={w} className="h-9 rounded-lg p-0.75 gap-0.5" style={{ width: w }} />
                ))}
              </div>
            ) : (
              <Tabs
                value={activeConfig?.filename || ""}
                onValueChange={(value) => {
                  const index = configs.findIndex((c) => c.filename === value)
                  if (index >= 0) switchTab(index)
                }}
                className="flex flex-row! items-center gap-2 w-full"
              >
                <TabsList className="shrink-0">
                  {coreConfigs.map((config) => (
                    <TabsTrigger
                      key={config.filename}
                      value={config.filename}
                      className="relative data-[state=active]:bg-input-background!"
                    >
                      {config.name}
                      {config.isDirty && <span className="absolute top-0.75 right-0.75 w-1.5 h-1.5 rounded-full bg-amber-400" />}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {xkeenConfigs.length > 0 && (
                  <TabsList className="shrink-0">
                    {xkeenConfigs.map((config) => (
                      <TabsTrigger
                        key={config.filename}
                        value={config.filename}
                        className="relative data-[state=active]:bg-input-background!"
                      >
                        {config.name}
                        {config.isDirty && <span className="absolute top-0.75 right-0.75 w-1.5 h-1.5 rounded-full bg-amber-400" />}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                )}
              </Tabs>
            )}
          </div>
        </div>

        <div className="relative min-h-[70dvh] md:flex-1 md:min-h-0">
          {monacoReady && activeConfig && isRoutingGui ? (
            <RoutingPanel editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
          ) : monacoReady && activeConfig && isLogGui ? (
            <GuiLog editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
          ) : monacoReady && activeConfig ? (
            <MonacoEditor
              ref={editorRef}
              onContentChange={handleContentChange}
              onValidationChange={handleValidationChange}
              onReady={handleMonacoReady}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
              {isConfigsLoading ? "Загрузка конфигураций..." : monacoReady ? "Выберите файл" : "Загрузка редактора..."}
            </div>
          )}
          {/* Keep Monaco mounted but hidden so ref stays valid for save/apply */}
          {monacoReady && activeConfig && isAnyGui && (
            <div className="hidden">
              <MonacoEditor
                ref={editorRef}
                onContentChange={handleContentChange}
                onValidationChange={handleValidationChange}
                onReady={handleMonacoReady}
              />
            </div>
          )}
        </div>

        <div className="px-3 sm:px-4 pb-3 sm:pb-4 flex flex-wrap items-center justify-between gap-1.5 shrink-0">
          <div className="text-xs min-w-0">
            {isConfigsLoading ? (
              <Skeleton className="h-4 w-28" />
            ) : validationState && activeConfig && isJsonOrYaml ? (
              <span
                className={cn(
                  "flex items-center gap-1.5 tracking-wide text-[13px]",
                  validationState.isValid ? "text-green-500" : "text-destructive",
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
                  <Skeleton key={w} className="h-9 rounded-md" style={{ width: w }} />
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
                <Button size="default" className="h-9 gap-1.5 px-3" disabled={!canSave} onClick={() => saveCurrentConfig()}>
                  <IconDeviceFloppy size={14} /> Сохранить
                </Button>
                <div className="flex h-9 rounded-md overflow-hidden border border-border">
                  <Button
                    variant="outline"
                    size="default"
                    disabled={!canFormat}
                    className="h-full rounded-none border-0 gap-1.5 px-3"
                    onClick={() => editorRef.current?.format()}
                  >
                    <IconCode size={14} /> Формат
                  </Button>
                  <div className="w-px bg-border" />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon" className="h-full w-8 rounded-none border-0">
                        <IconChevronDown />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-max">
                      <DropdownMenuItem onClick={onOpenImport} className="gap-2 cursor-pointer px-3 py-2">
                        <IconLink /> Импорт подключения
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={onOpenTemplate} className="gap-2 cursor-pointer px-3 py-2">
                        <IconFileText /> Импорт шаблона
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={onOpenGeoScan} className="gap-2 cursor-pointer px-3 py-2">
                        <IconSearch /> Скан геофайлов
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
  )
}

function hasComments(content: string) {
  return /\/\/|\/\*[\s\S]*?\*\//.test(content)
}

function hasCriticalChanges(oldContent: string, newContent: string, language: string): boolean {
  try {
    if (language === "yaml") {
      const o = window.jsyaml?.load(oldContent),
        n = window.jsyaml?.load(newContent)
      return ["listeners", "redir-port", "tproxy-port"].some((f) => JSON.stringify(o?.[f]) !== JSON.stringify(n?.[f]))
    }
    if (language === "json") {
      const strip = (s: string) => s.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")
      const o = JSON.parse(strip(oldContent)),
        n = JSON.parse(strip(newContent))
      const clean = (arr: any[]) => (arr || []).map(({ sniffing, ...rest }: any) => rest)
      return JSON.stringify(clean(o?.inbounds)) !== JSON.stringify(clean(n?.inbounds))
    }
  } catch {
    return false
  }
  return false
}
