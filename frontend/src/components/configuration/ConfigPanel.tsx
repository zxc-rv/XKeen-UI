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
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconDeviceFloppy,
  IconDotsFilled,
  IconExternalLinkFilled,
  IconFilePlus,
  IconFileText,
  IconLink,
  IconListDetails,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall, clashFetch, getFileLanguage } from '../../lib/api'
import { LazyBoundary, lazyLoad, useLazyMount } from '../../lib/loader'
import { syncClashApiPort, useAppContext, useConnectionsSync, useSettings } from '../../lib/store'
import type { Config } from '../../lib/types'
import { cn, stripJsonComments } from '../../lib/utils'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../ui/input-group'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { Spinner } from '../ui/spinner'
import type { CodeMirrorRef } from './CodeMirror'

const GuiRouting = lazyLoad(() => import('./xray/GuiRouting'), 'GuiRouting')
const GuiLog = lazyLoad(() => import('./xray/GuiLog'), 'GuiLog')
const ConnectionsPanel = lazyLoad(() => import('./mihomo/Connections'), 'ConnectionsPanel')
const ProvidersModal = lazyLoad(() => import('../modals/Providers'), 'ProvidersModal')
const SelectorsPanel = lazyLoad(() => import('./mihomo/Selectors'), 'SelectorsPanel')
const CodeMirrorEditorLazy = lazyLoad(() => import('./CodeMirror'), 'CodeMirrorEditor')

type ClashMode = 'rule' | 'global' | 'direct'
type ProvidersModalKind = 'rules' | 'proxies'

const TOGGLE_ALL_SELECTORS_EVENT = 'mihomo:toggle-all-selectors'

interface Props {
  onOpenImport: () => void
  onOpenTemplate: () => void
  onOpenGeoScan: () => void
  onRefreshConfigs: () => Promise<unknown>
  editorRef: React.RefObject<CodeMirrorRef | null>
  configActionsRef: React.RefObject<{ switchTab: (index: number) => void; getActiveIndex: () => number }>
}

interface ConfigTabProps {
  config: Config
  currentCore: string
  showToast: (msg: string, type?: 'success' | 'error') => void
  onRefreshConfigs: () => Promise<unknown>
  withContextMenu?: boolean
}

type DialogState =
  | { type: 'create'; dir: string; isLst: boolean; anchorFile: string }
  | { type: 'rename'; file: string }
  | { type: 'delete'; file: string }
  | null

function ConfigTab({ config, currentCore, showToast, onRefreshConfigs, withContextMenu = false }: ConfigTabProps) {
  const [dialogData, setDialogData] = useState<DialogState>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const pendingInputFocusRef = useRef(false)
  const [inputValue, setInputValue] = useState('')

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768

  const openDialog = (value: NonNullable<DialogState>) => {
    pendingInputFocusRef.current = value.type !== 'delete'
    setDialogData(value)
    setPopoverOpen(true)
  }

  const closeDialog = () => setPopoverOpen(false)

  const fileExt = useMemo(() => {
    if (!dialogData || dialogData.type === 'delete') return ''
    if (dialogData.type === 'rename') return dialogData.file.match(/(\.[^.]+)$/)?.[1] ?? ''
    return dialogData.isLst ? '.lst' : currentCore === 'mihomo' ? '.yaml' : '.json'
  }, [dialogData, currentCore])

  async function commitDialog() {
    if (!dialogData) return
    const val = inputValue.trim()
    const ext = fileExt

    let req: { method: 'POST' | 'PATCH' | 'DELETE'; body: Record<string, any>; msg: string }

    if (dialogData.type === 'create') {
      if (!val) return
      req = { method: 'POST', body: { file: `${dialogData.dir}/${val}${ext}`, content: '' }, msg: `Файл "${val}${ext}" создан` }
    } else if (dialogData.type === 'rename') {
      if (!val) return
      const dir = dialogData.file.substring(0, dialogData.file.lastIndexOf('/'))
      req = { method: 'PATCH', body: { file: dialogData.file, new_file: `${dir}/${val}${ext}` }, msg: `Файл переименован в "${val}${ext}"` }
    } else {
      req = { method: 'DELETE', body: { file: dialogData.file }, msg: `Файл "${dialogData.file.split('/').pop()}" удалён` }
    }

    const result = await apiCall<{ success: boolean; error?: string }>(req.method, 'configs', req.body)

    if (result.success) {
      showToast(req.msg)
      await onRefreshConfigs()
      closeDialog()
    } else {
      showToast(`Ошибка: ${result.error}`, 'error')
    }
  }

  const isProtected = config.file.endsWith('/config.yaml') || config.file === 'config.yaml'

  const tabsTrigger = (
    <TabsTrigger value={config.file} className="dark:data-[state=active]:bg-input-background! relative data-[state=active]:bg-white!">
      {config.file
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '')}
      {config.isDirty && <span className="absolute top-0.75 right-0.75 h-1.5 w-1.5 rounded-full bg-amber-400" />}
    </TabsTrigger>
  )

  if (!withContextMenu)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{tabsTrigger}</span>
        </TooltipTrigger>
        <TooltipContent className="text-[13px]">{config.file}</TooltipContent>
      </Tooltip>
    )

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <ContextMenu>
        <ContextMenuTrigger className="contents">
          <Tooltip>
            <PopoverAnchor asChild>
              <TooltipTrigger asChild>
                <span className="inline-flex">{tabsTrigger}</span>
              </TooltipTrigger>
            </PopoverAnchor>
            <TooltipContent className="text-[13px]">{config.file}</TooltipContent>
          </Tooltip>
        </ContextMenuTrigger>
        <ContextMenuContent
          side="right"
          onCloseAutoFocus={(e) => {
            if (pendingInputFocusRef.current) {
              e.preventDefault()
              pendingInputFocusRef.current = false
              requestAnimationFrame(() => inputRef.current?.focus())
            }
          }}
        >
          <ContextMenuItem
            onSelect={() => {
              const dir = config.file.substring(0, config.file.lastIndexOf('/'))
              setInputValue('')
              openDialog({ type: 'create', dir, isLst: config.file.endsWith('.lst'), anchorFile: config.file })
            }}
          >
            <IconFilePlus /> Создать файл
          </ContextMenuItem>
          <ContextMenuItem
            disabled={isProtected}
            onSelect={() => {
              const name =
                config.file
                  .split('/')
                  .pop()
                  ?.replace(/\.[^.]+$/, '') ?? ''
              setInputValue(name)
              openDialog({ type: 'rename', file: config.file })
            }}
          >
            <IconPencil /> Переименовать
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={isProtected} variant="destructive" onSelect={() => openDialog({ type: 'delete', file: config.file })}>
            <IconTrash /> Удалить
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent
        align="start"
        className="w-auto min-w-64"
        avoidCollisions={!isMobile}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
        }}
        onFocusOutside={(e) => e.preventDefault()}
      >
        {dialogData?.type === 'delete' ? (
          <>
            <p className="text-sm font-medium">Удалить «{config.file.split('/').pop()}»?</p>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={closeDialog}>
                Отмена
              </Button>
              <Button size="sm" variant="destructive" onClick={commitDialog}>
                Удалить
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm font-medium">{dialogData?.type === 'create' ? 'Создать файл' : 'Переименовать файл'}</p>
            <InputGroup>
              <InputGroupInput
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && commitDialog()}
                placeholder="Имя файла"
              />
              {fileExt && (
                <InputGroupAddon align="inline-end">
                  <InputGroupText>{fileExt}</InputGroupText>
                </InputGroupAddon>
              )}
            </InputGroup>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={closeDialog}>
                Отмена
              </Button>
              <Button size="sm" onClick={commitDialog}>
                {dialogData?.type === 'create' ? 'Создать' : 'Переименовать'}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function ConfigPanel({ onOpenImport, onOpenTemplate, onOpenGeoScan, onRefreshConfigs, editorRef, configActionsRef }: Props) {
  const { state, dispatch, showToast } = useAppContext({ includeConfigs: true })
  const { configs, isConfigsLoading, currentCore, serviceStatus, clashApiPort, clashApiSecret, clashApiUnix } = state
  const guiRouting = useSettings((s) => s.guiRouting)
  const guiLog = useSettings((s) => s.guiLog)

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending'
  const activeClashApiPort = isRunning ? clashApiPort : null
  const activeClashApiUnix = isRunning ? clashApiUnix : null

  useConnectionsSync(currentCore === 'mihomo' ? activeClashApiPort : null, clashApiSecret, serviceStatus, activeClashApiUnix)

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
  const [allSelectorsCollapsed, setAllSelectorsCollapsed] = useState(false)
  const [providersModalKind, setProvidersModalKind] = useState<ProvidersModalKind | null>(null)
  const [isProvidersModalOpen, setIsProvidersModalOpen] = useState(false)
  const mountProvidersModal = useLazyMount(isProvidersModalOpen)
  const currentPanel = isRunning ? activePanel : 'config'

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

  useEffect(() => {
    if (currentCore !== 'mihomo' || (!activeClashApiPort && !activeClashApiUnix)) return
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      clashFetch<{ mode?: ClashMode }>(activeClashApiPort ?? '', 'configs', { secret: clashApiSecret, unix: activeClashApiUnix })
        .then((data) => {
          if (data.mode) setMode(data.mode)
        })
        .catch(() => {})
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [currentCore, activeClashApiPort, clashApiSecret, activeClashApiUnix])

  const changeMode = useCallback(
    async (newMode: ClashMode) => {
      if (newMode === mode || (!activeClashApiPort && !activeClashApiUnix)) return
      setMode(newMode)
      await clashFetch(activeClashApiPort ?? '', 'configs', {
        method: 'PATCH',
        secret: clashApiSecret,
        unix: activeClashApiUnix,
        body: { mode: newMode },
      })
      await clashFetch(activeClashApiPort ?? '', 'connections', { method: 'DELETE', secret: clashApiSecret, unix: activeClashApiUnix })
    },
    [activeClashApiPort, clashApiSecret, activeClashApiUnix, mode]
  )

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

  const openProvidersModal = useCallback((kind: ProvidersModalKind) => {
    setProvidersModalKind(kind)
    setIsProvidersModalOpen(true)
  }, [])

  const handleProvidersModalOpenChange = useCallback((open: boolean) => setIsProvidersModalOpen(open), [])

  const switchTab = useCallback(
    (index: number) => {
      if (index === activeIndexRef.current) return
      const currentCfg = configsRef.current[activeIndexRef.current]
      if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)

      const file = configsRef.current[index]?.file ?? ''
      setActiveConfigFile(file)
      localStorage.setItem('lastSelectedTab', file)
    },
    [saveViewState]
  )

  useEffect(() => {
    configActionsRef.current = { switchTab, getActiveIndex: () => activeIndexRef.current }
  }, [configActionsRef, switchTab])

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
      action:
        !xkeenConfigs.some((c) => c.file === cfg.file) &&
        (lang === 'json' || lang === 'yaml') &&
        !hasCriticalChanges(cfg.savedContent, content, lang)
          ? 'softRestart'
          : 'hardRestart',
      core: currentCore,
    })
    showToast(r?.success ? 'Изменения применены' : `Ошибка: ${r?.error}`, r?.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'running' })
    if (r?.success) {
      syncClashApiPort(200)
    }
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

  const coreConfigs = configs.filter((c) => !c.file.startsWith('/opt/etc/xkeen'))
  const xkeenConfigs = configs.filter((c) => c.file.startsWith('/opt/etc/xkeen'))

  const isMihomo = currentCore === 'mihomo' && (!!activeClashApiPort || !!activeClashApiUnix)
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const usefulLinks = [
    { title: 'Инструкция XKeen', url: 'https://github.com/Corvus-Malus/XKeen/' },
    { title: 'FAQ XKeen', url: 'https://jameszero.net/faq-xkeen.htm' },
    { title: 'Документация Xray', url: 'https://xtls.github.io/ru/config' },
    { title: 'Документация Mihomo', url: 'https://wiki.metacubex.one/ru/config/general' },
  ]

  return (
    <TooltipProvider delayDuration={500}>
      <>
        <div className="border-border bg-card flex flex-col overflow-hidden rounded-xl border md:min-h-0 md:flex-1">
          <div className={cn('flex shrink-0 flex-col gap-2 px-3 pt-3 sm:px-4 sm:pt-4 md:flex-row md:items-start')}>
            <div className="flex min-w-0 shrink-0 items-center gap-2">
              {isMihomo ? (
                <div className="min-w-0 overflow-x-auto [scrollbar-width:none] md:overflow-x-visible [&::-webkit-scrollbar]:hidden">
                  <Tabs
                    value={currentPanel}
                    onValueChange={(value) => {
                      const panel = value as 'config' | 'selectors' | 'connections'
                      setActivePanel(panel)
                      setMountedPanels((prev) => (prev.has(panel) ? prev : new Set([...prev, panel])))
                    }}
                    className="w-max flex-row!"
                  >
                    <TabsList variant="line" className="mb-2 w-max shrink-0 gap-3 p-0 whitespace-nowrap md:mb-0">
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
                </div>
              ) : (
                <h2 className="shrink-0 text-lg font-semibold select-none">Конфигурация</h2>
              )}
            </div>

            {isMihomo && currentPanel === 'connections' && (
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

            {isMihomo && currentPanel === 'selectors' && (
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="outline" className="text-[13px]" onClick={() => openProvidersModal('rules')}>
                  <IconListDetails data-icon="inline-start" />
                  Пров. правил
                </Button>
                <Button variant="outline" className="text-[13px]" onClick={() => openProvidersModal('proxies')}>
                  <IconListDetails data-icon="inline-start" />
                  Пров. прокси
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={allSelectorsCollapsed ? 'Развернуть все селекторы' : 'Свернуть все селекторы'}
                      onClick={() =>
                        window.dispatchEvent(new CustomEvent(TOGGLE_ALL_SELECTORS_EVENT, { detail: { collapsed: !allSelectorsCollapsed } }))
                      }
                    >
                      {allSelectorsCollapsed ? <IconChevronDown /> : <IconChevronUp />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{allSelectorsCollapsed ? 'Развернуть все' : 'Свернуть все'}</TooltipContent>
                </Tooltip>
              </div>
            )}

            {(!isMihomo || currentPanel === 'config') && (
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
                          <ConfigTab
                            key={config.file}
                            config={config}
                            currentCore={currentCore}
                            showToast={showToast}
                            onRefreshConfigs={onRefreshConfigs}
                            withContextMenu
                          />
                        ))}
                      </TabsList>
                    )}
                    {xkeenConfigs.length > 0 && (
                      <TabsList className="shrink-0">
                        {xkeenConfigs.map((config) => (
                          <ConfigTab
                            key={config.file}
                            config={config}
                            currentCore={currentCore}
                            showToast={showToast}
                            onRefreshConfigs={onRefreshConfigs}
                          />
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
                  <div className={cn(currentPanel !== 'selectors' && 'hidden')}>
                    <LazyBoundary>
                      <SelectorsPanel
                        clashApiPort={(activeClashApiPort ?? '') as string}
                        mode={mode}
                        clashApiSecret={clashApiSecret ?? null}
                        clashApiUnix={activeClashApiUnix ?? null}
                        onCollapsedStateChange={setAllSelectorsCollapsed}
                      />
                    </LazyBoundary>
                  </div>
                )}
                {mountedPanels.has('connections') && (
                  <div className={cn(currentPanel !== 'connections' && 'hidden')}>
                    <LazyBoundary>
                      <ConnectionsPanel
                        clashApiPort={(activeClashApiPort ?? '') as string}
                        clashApiSecret={clashApiSecret ?? null}
                        clashApiUnix={activeClashApiUnix ?? null}
                      />
                    </LazyBoundary>
                  </div>
                )}
              </>
            )}

            <div
              className={cn(
                'absolute inset-0',
                isAnyGui && 'pointer-events-none invisible opacity-0',
                isMihomo && currentPanel !== 'config' && 'hidden'
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

          {(!isMihomo || currentPanel === 'config') && (
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
                    {[120, 117, 96, 100].map((w) => (
                      <Skeleton key={w} className="h-9" style={{ width: w }} />
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
                        <Button variant="outline">
                          <IconDotsFilled data-icon="inline-start" /> <span className="hidden sm:inline">Утилиты</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-57">
                        <DropdownMenuLabel>Утилиты</DropdownMenuLabel>
                        <DropdownMenuItem onClick={onOpenImport}>
                          <IconLink /> Добавить прокси
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onOpenTemplate}>
                          <IconFileText /> Шаблоны конфигураций
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={onOpenGeoScan}>
                          <IconSearch /> Скан геофайлов
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
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        {providersModalKind && mountProvidersModal && (
          <LazyBoundary>
            <ProvidersModal
              open={isProvidersModalOpen}
              kind={providersModalKind}
              clashApiPort={activeClashApiPort ?? ''}
              clashApiSecret={clashApiSecret ?? null}
              clashApiUnix={activeClashApiUnix ?? null}
              onOpenChange={handleProvidersModalOpenChange}
            />
          </LazyBoundary>
        )}
      </>
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
