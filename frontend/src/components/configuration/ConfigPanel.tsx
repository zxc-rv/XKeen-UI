import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconCheck,
  IconCode,
  IconDeviceFloppy,
  IconDotsFilled,
  IconExternalLinkFilled,
  IconFileText,
  IconLink,
  IconRefresh,
  IconSearch,
  IconX,
} from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall, clashFetch, getFileLanguage } from '../../lib/api'
import { LazyBoundary, lazyLoad } from '../../lib/loader'
import { syncClashApiPort, useAppContext, useConnectionsSync, useSettings } from '../../lib/store'
import type { Config } from '../../lib/types'
import { cn, stripJsonComments } from '../../lib/utils'
import { ButtonGroup } from '../ui/button-group'
import { Spinner } from '../ui/spinner'
import type { CodeMirrorRef } from './CodeMirror'

const GuiRouting = lazyLoad(() => import('./xray/GuiRouting'), 'GuiRouting')
const GuiLog = lazyLoad(() => import('./xray/GuiLog'), 'GuiLog')
const ConnectionsPanel = lazyLoad(() => import('./mihomo/Connections'), 'ConnectionsPanel')
const SelectorsPanel = lazyLoad(() => import('./mihomo/Selectors'), 'SelectorsPanel')
const CodeMirrorEditorLazy = lazyLoad(() => import('./CodeMirror'), 'CodeMirrorEditor')

type ClashMode = 'rule' | 'global' | 'direct'

interface Props {
  onOpenImport: () => void
  onOpenTemplate: () => void
  onOpenGeoScan: () => void
  editorRef: React.RefObject<CodeMirrorRef | null>
  configActionsRef: React.RefObject<{ switchTab: (index: number) => void; getActiveIndex: () => number }>
}

export function ConfigPanel({ onOpenImport, onOpenTemplate, onOpenGeoScan, editorRef, configActionsRef }: Props) {
  const { state, dispatch, showToast } = useAppContext({ includeConfigs: true })
  const { configs, isConfigsLoading, currentCore, serviceStatus, clashApiPort, clashApiSecret } = state
  const guiRouting = useSettings((s) => s.guiRouting)
  const guiLog = useSettings((s) => s.guiLog)

  useConnectionsSync(currentCore === 'mihomo' ? clashApiPort : null, clashApiSecret)

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending'

  useEffect(() => {
    if (!isRunning) setActivePanel('config')
  }, [isRunning])

  const [activeConfigFile, setActiveConfigFile] = useState<string>(() => localStorage.getItem('lastSelectedTab') ?? '')
  const activeConfigIndex = useMemo(() => {
    if (!configs.length) return 0
    const idx = configs.findIndex((c) => c.file === activeConfigFile)
    return idx >= 0 ? idx : 0
  }, [configs, activeConfigFile])
  const [validationState, setValidationState] = useState<{ isValid: boolean; error?: string } | null>(null)

  const [isEditorMounted, setIsEditorMounted] = useState(false)

  const [activePanel, setActivePanel] = useState<'config' | 'selectors' | 'connections'>('config')
  const [mountedPanels, setMountedPanels] = useState<Set<string>>(() => new Set(['config']))
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

  const saveViewState = useCallback(
    (file: string, isDirty?: boolean) => {
      if (!editorRef.current) return
      const state = editorRef.current.saveViewState()
      if (state) {
        viewStatesRef.current[file] = state
        if (!isDirty) {
          try {
            localStorage.setItem(`editor-folds:${file}`, JSON.stringify(state.folds ?? []))
          } catch {
            /* */
          }
        }
      }
    },
    [editorRef]
  )

  useEffect(() => {
    function onBeforeUnload() {
      const currentCfg = configsRef.current[activeIndexRef.current]
      if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [saveViewState])

  const configFilenamesKey = configs.map((c) => c.file).join(',')
  const prevConfigFilenamesKeyRef = useRef('')

  useEffect(() => {
    const currentConfigs = configsRef.current
    if (currentConfigs.length === 0) return
    const isFirstLoad = prevConfigFilenamesKeyRef.current === ''
    prevConfigFilenamesKeyRef.current = configFilenamesKey
    if (isFirstLoad) return

    const yamlIndex = currentConfigs.findIndex((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
    const next = yamlIndex >= 0 ? yamlIndex : 0
    setActiveConfigFile(currentConfigs[next]?.file ?? '')
  }, [configFilenamesKey])

  useEffect(() => {
    if (currentCore !== 'mihomo' || !clashApiPort) return
    clashFetch<{ mode?: ClashMode }>(clashApiPort, 'configs', { secret: clashApiSecret })
      .then((data) => {
        if (data.mode) setMode(data.mode)
      })
      .catch(() => {})
  }, [currentCore, clashApiPort, clashApiSecret])

  const changeMode = useCallback(
    async (newMode: ClashMode) => {
      if (newMode === mode || !clashApiPort) return
      setMode(newMode)
      await clashFetch(clashApiPort, 'configs', { method: 'PATCH', secret: clashApiSecret, body: { mode: newMode } })
      await clashFetch(clashApiPort, 'connections', { method: 'DELETE', secret: clashApiSecret })
    },
    [clashApiPort, clashApiSecret, mode]
  )

  async function updateAllProviders(type: 'rules' | 'proxies', setLoading: (v: boolean) => void) {
    if (!clashApiPort) return
    setLoading(true)
    try {
      const data = await clashFetch<{ providers?: Record<string, unknown> }>(clashApiPort, `providers/${type}`, { secret: clashApiSecret })
      const names = Object.keys(data.providers ?? {})
      await Promise.all(
        names.map((name) =>
          clashFetch(clashApiPort, `providers/${type}/${encodeURIComponent(name)}`, { method: 'PUT', secret: clashApiSecret })
        )
      )
      showToast(`Наборы ${type === 'rules' ? 'правил' : 'прокси'} обновлены`)
    } catch {
      showToast('Ошибка обновления', 'error')
    } finally {
      setLoading(false)
    }
  }

  const activeConfig = configs[activeConfigIndex]
  const fileLanguage = activeConfig ? getFileLanguage(activeConfig.file) : null
  const isJsonOrYaml = fileLanguage === 'json' || fileLanguage === 'yaml'
  const canSave = !!(activeConfig?.isDirty && validationState?.isValid)
  const canApply = canSave && isRunning && !isPending
  const canFormat = !!(isJsonOrYaml && validationState?.isValid)

  const loadConfigIntoEditor = useCallback(
    (config: Config) => {
      if (!editorRef.current) return
      editorRef.current.setSavedContent(config.savedContent)
      const inMemory = viewStatesRef.current[config.file]
      editorRef.current.setValue(config.content, config.savedContent, inMemory?.history)
      editorRef.current.setLanguage(getFileLanguage(config.file))
      editorRef.current.validate(config.file)
      if (inMemory) {
        editorRef.current.restoreViewState(inMemory)
      } else {
        const folds = (() => {
          try {
            return JSON.parse(localStorage.getItem(`editor-folds:${config.file}`) ?? 'null')
          } catch {
            return null
          }
        })()
        if (folds) editorRef.current.restoreViewState({ anchor: 0, head: 0, scrollTop: 0, scrollLeft: 0, folds })
      }
    },
    [editorRef]
  )

  useEffect(() => {
    const config = configsRef.current[activeConfigIndex]
    if (editorRef.current && config) {
      loadConfigIntoEditor(config)
    }
  }, [activeConfigIndex, configFilenamesKey, loadConfigIntoEditor, editorRef])

  const handleEditorReady = useCallback(() => {
    setIsEditorMounted(true)
    const config = configsRef.current[activeIndexRef.current]
    if (config && editorRef.current) loadConfigIntoEditor(config)
  }, [loadConfigIntoEditor, editorRef])

  const handleContentChange = useCallback(
    (content: string, isDirty: boolean) => {
      const index = activeIndexRef.current
      if (index < 0) return
      const current = configsRef.current[index]
      if (!current) return
      if (current.content === content && current.isDirty === isDirty) return
      dispatch({ type: 'UPDATE_CONFIG_DIRTY', index, isDirty, content })
    },
    [dispatch]
  )

  const handleValidationChange = useCallback((isValid: boolean, error?: string) => {
    setValidationState((prev) => (prev?.isValid === isValid && prev?.error === error ? prev : { isValid, error }))
  }, [])

  function switchTab(index: number) {
    if (index === activeConfigIndex) return
    const currentCfg = configsRef.current[activeIndexRef.current]
    if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)

    const file = configs[index]?.file ?? ''
    setActiveConfigFile(file)
    localStorage.setItem('lastSelectedTab', file)
  }

  configActionsRef.current = { switchTab, getActiveIndex: () => activeIndexRef.current }

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
      saveViewState(cfg.file, false)
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
    saveViewState(cfg.file, false)
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Перезапуск...' })
    const lang = getFileLanguage(cfg.file)
    const r = await apiCall<{ success: boolean; error?: string }>('POST', 'control', {
      action: (lang === 'json' || lang === 'yaml') && !hasCriticalChanges(cfg.savedContent, content, lang) ? 'softRestart' : 'hardRestart',
      core: currentCore,
    })
    showToast(r?.success ? 'Изменения применены' : `Ошибка: ${r?.error}`, r?.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'running' })
    if (r?.success) syncClashApiPort()
  }

  function isGuiActive(cfg: Config) {
    const f = cfg.file.toLowerCase()
    return (f.includes('routing') && guiRouting) || (f.includes('log') && guiLog)
  }

  const fileForGui = activeConfig?.file
  const contentForGui = activeConfig?.savedContent
  const isRoutingGui = useMemo(() => {
    if (!guiRouting || !fileForGui) return false
    if (!fileForGui.toLowerCase().includes('routing')) return false
    try {
      const j = JSON.parse(stripJsonComments(contentForGui || ''))
      return j && typeof j.routing === 'object'
    } catch {
      return false
    }
  }, [guiRouting, fileForGui, contentForGui])

  const isLogGui = useMemo(() => {
    if (!guiLog || !fileForGui) return false
    if (!fileForGui.toLowerCase().includes('log')) return false
    try {
      const j = JSON.parse(stripJsonComments(contentForGui || ''))
      return j && typeof j.log === 'object'
    } catch {
      return false
    }
  }, [guiLog, fileForGui, contentForGui])

  const isAnyGui = isRoutingGui || isLogGui

  const coreConfigs = configs.filter((c) => !c.file.endsWith('.lst'))
  const xkeenConfigs = configs.filter((c) => c.file.endsWith('.lst'))

  const isMihomo = currentCore === 'mihomo' && !!clashApiPort
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const usefulLinks = [
    { title: 'Инструкция XKeen', url: 'https://github.com/Corvus-Malus/XKeen/' },
    { title: 'FAQ XKeen', url: 'https://jameszero.net/faq-xkeen.htm' },
    { title: 'Документация Xray', url: 'https://xtls.github.io/ru/config' },
    { title: 'Документация Mihomo', url: 'https://wiki.metacubex.one/ru/config/general' },
  ]

  return (
    <TooltipProvider delayDuration={300}>
      <div className="border-border bg-card flex flex-col overflow-hidden rounded-xl border md:min-h-0 md:flex-1">
        <div className={cn('flex shrink-0 flex-col gap-2 px-3 pt-3 sm:px-4 sm:pt-4 md:flex-row md:items-start')}>
          <div className="flex shrink-0 items-center gap-2">
            {isMihomo ? (
              <Tabs
                value={activePanel}
                onValueChange={(value) => {
                  const panel = value as 'config' | 'selectors' | 'connections'
                  setActivePanel(panel)
                  setMountedPanels((prev) => (prev.has(panel) ? prev : new Set([...prev, panel])))
                }}
                className="flex-row!"
              >
                <TabsList variant="line" className="mb-2 gap-3 p-0 md:mb-0">
                  <TabsTrigger value="config" className="p-0 text-sm font-semibold md:text-lg">
                    Конфигурация
                  </TabsTrigger>
                  <TabsTrigger value="selectors" className="p-0 text-sm font-semibold md:text-lg" disabled={!isRunning}>
                    Селекторы
                  </TabsTrigger>
                  <TabsTrigger value="connections" className="p-0 text-sm font-semibold md:text-lg" disabled={!isRunning}>
                    Соединения
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            ) : (
              <h2 className="shrink-0 text-lg font-semibold select-none">Конфигурация</h2>
            )}
          </div>

          {isMihomo && activePanel === 'connections' && (
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                className="text-[13px]"
                disabled={updatingRuleProviders}
                onClick={() => updateAllProviders('rules', setUpdatingRuleProviders)}
              >
                {updatingRuleProviders ? (
                  <IconRefresh data-icon="inline-start" className="direction-[reverse] animate-spin" />
                ) : (
                  <IconRefresh data-icon="inline-start" />
                )}
                Наборы правил
              </Button>
              <Button
                variant="outline"
                className="text-[13px]"
                disabled={updatingProxyProviders}
                onClick={() => updateAllProviders('proxies', setUpdatingProxyProviders)}
              >
                {updatingProxyProviders ? (
                  <IconRefresh data-icon="inline-start" className="direction-[reverse] animate-spin" />
                ) : (
                  <IconRefresh data-icon="inline-start" />
                )}
                Наборы прокси
              </Button>
            </div>
          )}

          {isMihomo && activePanel === 'selectors' && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Режим маршрутизации</span>
              <Select value={mode} onValueChange={(value) => changeMode(value as ClashMode)}>
                <SelectTrigger className="w-30">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="direct">DIRECT</SelectItem>
                    <SelectItem value="rule">RULE</SelectItem>
                    <SelectItem value="global">GLOBAL</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          )}

          {(!isMihomo || activePanel === 'config') && (
            <div className="overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] md:ml-auto [&::-webkit-scrollbar]:hidden">
              {isConfigsLoading ? (
                <div className="flex gap-2">
                  {[525, 310].map((w) => (
                    <Skeleton key={w} className="h-9 gap-0.5 rounded-lg p-0.75" style={{ width: w }} />
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
                          {config.isDirty && <span className="absolute top-0.75 right-0.75 h-1.5 w-1.5 rounded-full bg-amber-400" />}
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
                          {config.isDirty && <span className="absolute top-0.75 right-0.75 h-1.5 w-1.5 rounded-full bg-amber-400" />}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  )}
                </Tabs>
              )}
            </div>
          )}
        </div>

        <div className="relative min-h-175! md:min-h-0 md:flex-1">
          {isEditorMounted && activeConfig && isRoutingGui && (
            <GuiRouting editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
          )}
          {isEditorMounted && activeConfig && isLogGui && (
            <GuiLog editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
          )}

          {isMihomo && (
            <>
              {mountedPanels.has('selectors') && (
                <div className={cn(activePanel !== 'selectors' && 'hidden')}>
                  <LazyBoundary>
                    <SelectorsPanel clashApiPort={clashApiPort!} mode={mode} clashApiSecret={clashApiSecret ?? null} />
                  </LazyBoundary>
                </div>
              )}
              {mountedPanels.has('connections') && (
                <div className={cn(activePanel !== 'connections' && 'hidden')}>
                  <LazyBoundary>
                    <ConnectionsPanel clashApiPort={clashApiPort!} clashApiSecret={clashApiSecret ?? null} />
                  </LazyBoundary>
                </div>
              )}
            </>
          )}

          <div
            className={cn(
              'absolute inset-0',
              isAnyGui && 'pointer-events-none invisible opacity-0',
              isMihomo && activePanel !== 'config' && 'hidden'
            )}
          >
            <CodeMirrorEditorLazy
              ref={editorRef}
              onContentChange={handleContentChange}
              onValidationChange={handleValidationChange}
              onReady={handleEditorReady}
              onSave={() => saveCurrentConfig()}
            />
            {(!isEditorMounted || isConfigsLoading) && (
              <div className="text-muted-foreground absolute inset-4 flex items-center justify-center text-sm">
                <Spinner className="mr-2 size-5" />
                {isConfigsLoading ? 'Загрузка конфигураций...' : 'Инициализация редактора...'}
              </div>
            )}
          </div>
        </div>

        {(!isMihomo || activePanel === 'config') && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 px-3 pb-3 sm:px-4 sm:pb-4">
            <div className="min-w-0 text-xs">
              {isConfigsLoading ? (
                <Skeleton className="h-4 w-30" />
              ) : validationState && activeConfig && isJsonOrYaml ? (
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-[13px] tracking-wide',
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
                  {[120, 116, 133].map((w) => (
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
                        className="bg-green-600 text-white hover:bg-green-700"
                        onClick={() => saveAndApply()}
                      >
                        <IconRefresh data-icon="inline-start" /> Применить
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Сохранить и перезапустить</TooltipContent>
                  </Tooltip>
                  <Button size="default" disabled={!canSave} onClick={() => saveCurrentConfig()}>
                    <IconDeviceFloppy data-icon="inline-start" /> Сохранить
                  </Button>
                  <ButtonGroup>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button variant="outline" disabled={!canFormat} onClick={() => editorRef.current?.format()}>
                          <IconCode data-icon="inline-start" /> <span className="hidden sm:inline">Формат</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Форматировать файл</TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="icon">
                          <IconDotsFilled />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-57">
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
                        <DropdownMenuSeparator />
                        {isMobile ? (
                          <>
                            <DropdownMenuLabel>Полезные ссылки</DropdownMenuLabel>
                            {usefulLinks.map((link) => (
                              <DropdownMenuItem key={link.url} onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}>
                                <IconExternalLinkFilled /> {link.title}
                              </DropdownMenuItem>
                            ))}
                          </>
                        ) : (
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <IconExternalLinkFilled /> Полезные ссылки
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="min-w-55">
                              {usefulLinks.map((link) => (
                                <DropdownMenuItem key={link.url} onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}>
                                  <IconExternalLinkFilled /> {link.title}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ButtonGroup>
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
  return /(?<!:)\/\/|\/\*[\s\S]*?\*\//.test(content) || /^\s*#/m.test(content)
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
