import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  IconDeviceFloppy,
  IconLink,
  IconFileText,
  IconSearch,
  IconRefresh,
  IconCode,
  IconMenu2,
  IconCheck,
  IconX,
  IconLoader2,
} from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn, stripJsonComments } from '../../lib/utils'
import { useAppContext } from '../../lib/store'
import { apiCall, getFileLanguage } from '../../lib/api'
import { MonacoEditor, type MonacoEditorRef } from './MonacoEditor'
import { RoutingPanel } from './xray/GuiRouting'
import { GuiLog } from './xray/GuiLog'
import { ConnectionsPanel } from './mihomo/Connections'
import { SelectorsPanel } from './mihomo/Selectors'
import type { Config } from '../../lib/types'

type ClashMode = 'rule' | 'global' | 'direct'

interface Connection {
  id: string
  metadata: {
    host: string
    destinationIP: string
    sourceIP: string
    sourcePort: string
    destinationPort: string
    network: string
    type: string
    inboundIP: string
    inboundPort: string
    inboundName: string
    dnsMode: string
    uid: number
    process: string
    processPath: string
    remoteDestination: string
    sniffHost: string
  }
  upload: number
  download: number
  start: string
  chains: string[]
  providerChains: string[]
  rule: string
  rulePayload: string
}

interface Props {
  onOpenImport: () => void
  onOpenTemplate: () => void
  onOpenGeoScan: () => void
  editorRef: React.RefObject<MonacoEditorRef | null>
}

export function ConfigPanel({ onOpenImport, onOpenTemplate, onOpenGeoScan, editorRef }: Props) {
  const { state, dispatch, showToast } = useAppContext()
  const { configs, activeConfigIndex, isConfigsLoading, currentCore, serviceStatus, settings, dashboardPort } = state

  const [connections, setConnections] = useState<Connection[]>([])
  const [wsConnected, setWsConnected] = useState(false)

  const [validationState, setValidationState] = useState<{ isValid: boolean; error?: string } | null>(null)
  const [monacoReady, setMonacoReady] = useState(false)
  const [activePanel, setActivePanel] = useState<'config' | 'selectors' | 'connections'>(
    () => (localStorage.getItem('lastSelectedPanel') as 'config' | 'selectors' | 'connections') ?? 'config'
  )
  const [mode, setMode] = useState<ClashMode>('rule')
  const [updatingRuleProviders, setUpdatingRuleProviders] = useState(false)
  const [updatingProxyProviders, setUpdatingProxyProviders] = useState(false)

  const configsRef = useRef(configs)
  const activeIndexRef = useRef(activeConfigIndex)
  const viewStatesRef = useRef<Record<string, any>>({})

  useEffect(() => {
    configsRef.current = configs
  }, [configs])
  useEffect(() => {
    activeIndexRef.current = activeConfigIndex
  }, [activeConfigIndex])

  useEffect(() => {
    if (currentCore !== 'mihomo' || !dashboardPort) return
    const baseUrl = `http://${location.hostname}:${dashboardPort}`
    fetch(`${baseUrl}/configs`)
      .then((r) => r.json())
      .then((data) => {
        if (data.mode) setMode(data.mode as ClashMode)
      })
      .catch(() => {})
  }, [currentCore, dashboardPort])

  useEffect(() => {
    if (!dashboardPort) return

    const baseWsUrl = `ws://${location.hostname}:${dashboardPort}/connections?interval=1000`
    const isIOSSafari =
      /iP(ad|od|hone)/i.test(navigator.userAgent) && /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS/i.test(navigator.userAgent)

    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let isActive = true
    let retryCount = 0

    function getWsUrl() {
      return baseWsUrl + (baseWsUrl.includes('?') ? '&' : '?') + 't=' + Date.now()
    }

    function cleanup() {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) {
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
        ws = null
      }
    }

    function connect() {
      if (!isActive || document.visibilityState !== 'visible') return
      cleanup()

      ws = new WebSocket(getWsUrl())

      ws.onopen = () => {
        setWsConnected(true)
        retryCount = 0
      }

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (Array.isArray(data.connections)) setConnections(data.connections)
        } catch {}
      }

      ws.onerror = () => ws?.close()

      ws.onclose = () => {
        setWsConnected(false)
        if (isActive && document.visibilityState === 'visible' && retryCount < 12) {
          retryCount++
          const delay = Math.min(800 * Math.pow(1.4, retryCount), 12000)
          reconnectTimer = setTimeout(connect, delay)
        }
      }
    }

    setTimeout(connect, 0)

    let touchHandler: (() => void) | null = null
    if (isIOSSafari) {
      touchHandler = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) connect()
      }
      document.addEventListener('touchstart', touchHandler, { once: true })
    }

    return () => {
      isActive = false
      cleanup()
      if (touchHandler) document.removeEventListener('touchstart', touchHandler)
    }
  }, [dashboardPort])

  const changeMode = useCallback(
    async (newMode: ClashMode) => {
      if (newMode === mode) return
      setMode(newMode)
      if (!dashboardPort) return
      await fetch(`http://${location.hostname}:${dashboardPort}/configs`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      })
    },
    [dashboardPort, mode]
  )

  async function updateAllProviders(type: 'rules' | 'proxies', setLoading: (v: boolean) => void) {
    if (!dashboardPort) return
    const baseUrl = `http://${location.hostname}:${dashboardPort}`
    setLoading(true)
    try {
      const res = await fetch(`${baseUrl}/providers/${type}`)
      const data = await res.json()
      const names = Object.keys(data.providers ?? {})
      await Promise.all(names.map((name) => fetch(`${baseUrl}/providers/${type}/${encodeURIComponent(name)}`, { method: 'PUT' })))
      showToast(`Наборы ${type === 'rules' ? 'правил' : 'прокси'} обновлены`)
    } catch {
      showToast('Ошибка обновления', 'error')
    } finally {
      setLoading(false)
    }
  }

  const activeConfig = configs[activeConfigIndex]
  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending'
  const fileLanguage = activeConfig ? getFileLanguage(activeConfig.file) : null
  const isJsonOrYaml = fileLanguage === 'json' || fileLanguage === 'yaml'
  const canSave = !!(activeConfig?.isDirty && validationState?.isValid)
  const canApply = canSave && isRunning && !isPending
  const canFormat = !!(isJsonOrYaml && validationState?.isValid)

  const configFilenamesKey = configs.map((c) => c.file).join(',')

  const loadConfigIntoEditor = useCallback(
    (config: Config) => {
      if (!editorRef.current) return
      editorRef.current.setSavedContent(config.savedContent)
      editorRef.current.setValue(config.content, config.savedContent)
      editorRef.current.setLanguage(getFileLanguage(config.file))
      editorRef.current.validate(config.file)
      const savedState = viewStatesRef.current[config.file]
      if (savedState) editorRef.current.restoreViewState(savedState)
    },
    [editorRef]
  )

  useEffect(() => {
    const config = configsRef.current[activeConfigIndex]
    if (monacoReady && config && editorRef.current) loadConfigIntoEditor(config)
  }, [activeConfigIndex, configFilenamesKey, monacoReady, loadConfigIntoEditor, editorRef])

  const handleMonacoReady = useCallback(() => {
    setMonacoReady(true)
    const config = configsRef.current[activeIndexRef.current]
    if (config) loadConfigIntoEditor(config)
  }, [editorRef, loadConfigIntoEditor])

  const handleContentChange = useCallback(
    (content: string, isDirty: boolean) => {
      const index = activeIndexRef.current
      if (index < 0) return
      dispatch({ type: 'UPDATE_CONFIG_DIRTY', index, isDirty, content })
    },
    [dispatch]
  )

  const handleValidationChange = useCallback((isValid: boolean, error?: string) => {
    setValidationState({ isValid, error })
  }, [])

  function switchTab(index: number) {
    if (index === activeConfigIndex) return
    const currentCfg = configsRef.current[activeIndexRef.current]
    if (currentCfg && editorRef.current) {
      viewStatesRef.current[currentCfg.file] = editorRef.current.saveViewState()
    }
    activeIndexRef.current = index
    dispatch({ type: 'SET_ACTIVE_CONFIG', index })
    localStorage.setItem('lastSelectedTab', configs[index]?.file ?? '')
  }

  async function saveCurrentConfig(force = false) {
    const cfg = configsRef.current[activeIndexRef.current]
    if (!cfg || !editorRef.current) return
    const content = editorRef.current.getValue()
    if (!content.trim()) return showToast('Конфигурация пустая', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: () => saveCurrentConfig(true) })
      dispatch({ type: 'SHOW_MODAL', modal: 'showCommentsWarningModal', show: true })
      return
    }
    const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', { file: cfg.file, content })
    if (result.success) {
      editorRef.current.setSavedContent(content)
      dispatch({ type: 'SAVE_CONFIG', index: activeIndexRef.current, content })
      showToast(`Файл "${cfg.file.split('/').pop()}" сохранен`)
    } else {
      showToast(`Ошибка сохранения: ${result.error}`, 'error')
    }
  }

  async function saveAndApply(force = false) {
    const cfg = configsRef.current[activeIndexRef.current]
    if (!cfg || !editorRef.current) return
    const content = editorRef.current.getValue()
    if (!content.trim()) return showToast('Файл пустой', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: () => saveAndApply(true) })
      dispatch({ type: 'SHOW_MODAL', modal: 'showCommentsWarningModal', show: true })
      return
    }
    const saveResult = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', { file: cfg.file, content })
    if (!saveResult.success) return showToast(`Ошибка сохранения: ${saveResult.error}`, 'error')
    editorRef.current.setSavedContent(content)
    dispatch({ type: 'SAVE_CONFIG', index: activeIndexRef.current, content })
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Перезапуск...' })
    const lang = getFileLanguage(cfg.file)
    const r = await apiCall<{ success: boolean; error?: string }>('POST', 'control', {
      action: (lang === 'json' || lang === 'yaml') && !hasCriticalChanges(cfg.savedContent, content, lang) ? 'softRestart' : 'hardRestart',
      core: currentCore,
    })
    showToast(r?.success ? 'Изменения применены' : `Ошибка: ${r?.error}`, r?.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'running' })
  }

  function isGuiActive(cfg: Config) {
    const f = cfg.file.toLowerCase()
    return (f.includes('routing') && settings.guiRouting) || (f.includes('log') && settings.guiLog)
  }

  const isRoutingGui = useMemo(() => {
    if (!settings.guiRouting || !activeConfig) return false
    if (!activeConfig.file.toLowerCase().includes('routing')) return false
    try {
      const j = JSON.parse(stripJsonComments(activeConfig.content))
      return j && typeof j.routing === 'object'
    } catch {
      return false
    }
  }, [settings.guiRouting, activeConfig])

  const isLogGui = useMemo(() => {
    if (!settings.guiLog || !activeConfig) return false
    if (!activeConfig.file.toLowerCase().includes('log')) return false
    try {
      const j = JSON.parse(stripJsonComments(activeConfig.content))
      return j && typeof j.log === 'object'
    } catch {
      return false
    }
  }, [settings.guiLog, activeConfig])

  const isAnyGui = isRoutingGui || isLogGui

  const coreConfigs = configs.filter((c) => !c.file.endsWith('.lst'))
  const xkeenConfigs = configs.filter((c) => c.file.endsWith('.lst'))

  const isMihomo = currentCore === 'mihomo' && !!dashboardPort

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col rounded-xl border border-border bg-card overflow-hidden md:flex-1 md:min-h-0">
        <div className={cn('px-3 sm:px-4 pt-3 sm:pt-4 flex flex-col md:flex-row md:items-start gap-2 shrink-0')}>
          <div className="flex items-center gap-2 shrink-0">
            {isMihomo ? (
              <Tabs
                value={activePanel}
                onValueChange={(value) => {
                  const panel = value as 'config' | 'selectors' | 'connections'
                  setActivePanel(panel)
                  localStorage.setItem('lastSelectedPanel', panel)
                }}
                className="flex-row!"
              >
                <TabsList variant="line" className="p-0 gap-3">
                  <TabsTrigger value="config" className="text-lg font-semibold p-0">
                    Конфигурация
                  </TabsTrigger>
                  <TabsTrigger value="selectors" className="text-lg font-semibold p-0">
                    Селекторы
                  </TabsTrigger>
                  <TabsTrigger value="connections" className="text-lg font-semibold p-0">
                    Соединения
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : (
              <h2 className="text-lg font-semibold shrink-0 select-none">Конфигурация</h2>
            )}
          </div>

          {isMihomo && activePanel === 'connections' && (
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                className="gap-1.5 text-xs"
                disabled={updatingRuleProviders}
                onClick={() => updateAllProviders('rules', setUpdatingRuleProviders)}
              >
                {updatingRuleProviders ? <IconLoader2 size={13} className="animate-spin" /> : <IconRefresh size={13} />}
                Наборы правил
              </Button>
              <Button
                variant="outline"
                className="gap-1.5 text-xs"
                disabled={updatingProxyProviders}
                onClick={() => updateAllProviders('proxies', setUpdatingProxyProviders)}
              >
                {updatingProxyProviders ? <IconLoader2 size={13} className="animate-spin" /> : <IconRefresh size={13} />}
                Наборы прокси
              </Button>
            </div>
          )}

          {isMihomo && activePanel === 'selectors' && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Режим маршрутизации</span>
              <Select value={mode} onValueChange={(value) => changeMode(value as ClashMode)}>
                <SelectTrigger className="h-8 w-35">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="direct">DIRECT</SelectItem>
                  <SelectItem value="rule">RULE</SelectItem>
                  <SelectItem value="global">GLOBAL</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {(!isMihomo || activePanel === 'config') && (
            <div className="overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:ml-auto">
              {isConfigsLoading ? (
                <div className="flex gap-2">
                  {[524, 311].map((w) => (
                    <Skeleton key={w} className="h-9 rounded-lg p-0.75 gap-0.5" style={{ width: w }} />
                  ))}
                </div>
              ) : (
                <Tabs
                  value={activeConfig?.file || ''}
                  onValueChange={(value) => {
                    const index = configs.findIndex((c) => c.file === value)
                    if (index >= 0) switchTab(index)
                  }}
                  className="flex-row!"
                >
                  {coreConfigs.length > 0 && (
                    <TabsList className="shrink-0">
                      {coreConfigs.map((config) => (
                        <TabsTrigger key={config.file} value={config.file} className="data-[state=active]:bg-input-background! relative">
                          {config.file
                            .split('/')
                            .pop()
                            ?.replace(/\.[^.]+$/, '')}
                          {config.isDirty && <span className="absolute top-0.75 right-0.75 w-1.5 h-1.5 rounded-full bg-amber-400" />}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  )}
                  {xkeenConfigs.length > 0 && (
                    <TabsList className="shrink-0">
                      {xkeenConfigs.map((config) => (
                        <TabsTrigger key={config.file} value={config.file} className="data-[state=active]:bg-input-background! relative">
                          {config.file
                            .split('/')
                            .pop()
                            ?.replace(/\.[^.]+$/, '')}
                          {config.isDirty && <span className="absolute top-0.75 right-0.75 w-1.5 h-1.5 rounded-full bg-amber-400" />}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  )}
                </Tabs>
              )}
            </div>
          )}
        </div>

        <div className="relative min-h-175! md:flex-1 md:min-h-0">
          {monacoReady && activeConfig && isRoutingGui && (
            <RoutingPanel editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
          )}
          {monacoReady && activeConfig && isLogGui && (
            <GuiLog editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
          )}

          {isMihomo && (
            <>
              <div className={cn(activePanel !== 'selectors' && 'hidden')}>
                <SelectorsPanel dashboardPort={dashboardPort!} mode={mode} connections={connections} />
              </div>
              {activePanel === 'connections' && (
                <ConnectionsPanel dashboardPort={dashboardPort!} connections={connections} connected={wsConnected} />
              )}
            </>
          )}

          <div
            className={cn(
              'absolute inset-0',
              isAnyGui && 'invisible opacity-0 pointer-events-none',
              isMihomo && activePanel !== 'config' && 'hidden'
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
                {isConfigsLoading ? 'Загрузка конфигураций...' : 'Инициализация редактора...'}
              </div>
            )}
          </div>
        </div>

        {(!isMihomo || activePanel === 'config') && (
          <div className="px-3 sm:px-4 pb-3 sm:pb-4 flex flex-wrap items-center justify-between gap-1.5 shrink-0">
            <div className="text-xs min-w-0">
              {isConfigsLoading ? (
                <Skeleton className="h-4 w-28" />
              ) : validationState && activeConfig && isJsonOrYaml ? (
                <span
                  className={cn(
                    'flex items-center gap-1.5 tracking-wide text-[13px]',
                    validationState.isValid ? 'text-green-400/90' : 'text-red-500'
                  )}
                >
                  {validationState.isValid ? <IconCheck size={15} /> : <IconX size={15} />}
                  {validationState.isValid
                    ? `${fileLanguage?.toUpperCase()} валиден`
                    : `Ошибка: ${validationState.error || 'Файл невалиден'}`}
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
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="default"
                          disabled={!canFormat}
                          className="h-full rounded-none border-0 gap-1.5 px-3"
                          onClick={() => editorRef.current?.format()}
                        >
                          <IconCode size={14} /> <span className="hidden sm:inline">Формат</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Форматировать файл</TooltipContent>
                    </Tooltip>
                    <div className="w-px bg-border" />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon" className="h-full w-8 rounded-none border-0">
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
        )}
      </div>
    </TooltipProvider>
  )
}

function hasComments(content: string) {
  return /\/\/|\/\*[\s\S]*?\*\//.test(content)
}

function hasCriticalChanges(oldContent: string, newContent: string, language: string): boolean {
  try {
    if (language === 'yaml') {
      const o = jsyaml.load(oldContent) as Record<string, unknown>
      const n = jsyaml.load(newContent) as Record<string, unknown>
      return ['listeners', 'redir-port', 'tproxy-port'].some((f) => JSON.stringify(o?.[f]) !== JSON.stringify(n?.[f]))
    }
    if (language === 'json') {
      const o = JSON.parse(stripJsonComments(oldContent))
      const n = JSON.parse(stripJsonComments(newContent))
      const clean = (arr: Record<string, unknown>[]) =>
        (arr || []).map((item) => Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'sniffing')))
      return JSON.stringify(clean(o?.inbounds)) !== JSON.stringify(clean(n?.inbounds))
    }
  } catch {
    return false
  }
  return false
}
