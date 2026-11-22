import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconAdjustmentsHorizontal,
  IconArrowsExchange,
  IconBox,
  IconBoltFilled,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconDeviceFloppy,
  IconDotsFilled,
  IconExternalLinkFilled,
  IconEye,
  IconEyeOff,
  IconFileCode,
  IconFilePlus,
  IconFileText,
  IconFileUpload,
  IconHistory,
  IconLink,
  IconListDetails,
  IconPencil,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconTerminal2,
  IconTrash,
  IconWorld,
  IconX,
} from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { apiCall, capitalize, clashFetch, getFileLanguage } from '../../lib/api'
import { saveConfigRevision, supportsConfigHistory } from '../../lib/config-history'
import { LazyBoundary, lazyLoad, useLazyMount } from '../../lib/loader'
import {
  runMassTask,
  summarizeFanOut,
  targetLabel,
  filterAuthBlockedTargets,
  REMOTE_AUTH_UNSUPPORTED,
} from '../../lib/multi-routers/actions'
import { LOCAL_ROUTER_ID } from '../../lib/multi-routers/model'
import { useRoutersStore } from '../../lib/multi-routers/store'
import { syncClashApiPort, useAppContext, useConnectionsSync, useModalContext, useSettings } from '../../lib/store'
import type { Config } from '../../lib/types'
import { cn } from '../../lib/utils'
import { parse as parseJsonc } from 'jsonc-parser'
import { LogPanel } from '../log/LogPanel'
import { MassConfirmDialog } from '../log/multi-routers/MassConfirmDialog'
import { BackupsModal } from '../modals/Backups'
import { ConfigHistoryView } from '../modals/ConfigHistory'
import { ProvidersModal } from '../modals/Providers'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../ui/context-menu'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '../ui/input-group'
import { Popover, PopoverContent } from '../ui/popover'
import type { CodeMirrorRef } from './CodeMirror'

const GuiRouting = lazyLoad(() => import('./xray/GuiRouting'), 'GuiRouting')
const GuiLog = lazyLoad(() => import('./xray/GuiLog'), 'GuiLog')
const GuiOutbounds = lazyLoad(() => import('./xray/GuiOutbounds'), 'GuiOutbounds')
const ConnectionsPanel = lazyLoad(() => import('./mihomo/Connections'), 'ConnectionsPanel')
const SelectorsPanel = lazyLoad(() => import('./mihomo/Selectors'), 'SelectorsPanel')
import { DnsPanel } from './mihomo/DnsPanel'
import { getMihomoSectionHeaderLine, getMihomoSections, type MihomoSectionKey } from './mihomo/sectionNavigation'
import { DISPLAY_EVENT, readSelectorDisplay, SelectorDisplaySettings } from './mihomo/SelectorDisplaySettings'
import { Kbd } from '../ui/kbd'
const CodeMirrorEditorLazy = lazyLoad(() => import('./CodeMirror'), 'CodeMirrorEditor')

const BackupsModalContainer = memo(function BackupsModalContainer({ onRefreshConfigs }: { onRefreshConfigs: () => Promise<unknown> }) {
  const { modals, dispatch } = useModalContext()
  const mounted = useLazyMount(modals.showBackupsModal)
  const handleOpenChange = useCallback(
    (open: boolean) => dispatch({ type: 'SHOW_MODAL', modal: 'showBackupsModal', show: open }),
    [dispatch]
  )
  if (!mounted) return null
  return <BackupsModal open={modals.showBackupsModal} onOpenChange={handleOpenChange} onRefreshConfigs={onRefreshConfigs} />
})

type ClashMode = 'rule' | 'global' | 'direct'
export type PanelTab = 'selectors' | 'connections' | 'config' | 'dns' | 'log'
type ApiResult = { success: boolean; error?: string }

const HOT_RELOAD_UNAVAILABLE = 'Hot reload unavailable'

const isXkeenFile = (file: string) => file.startsWith('/opt/etc/xkeen')

const findNeighborFile = (configs: Config[], removedFile: string, isAvailable: (file: string) => boolean) => {
  const group = configs.filter((config) => isXkeenFile(config.file) === isXkeenFile(removedFile))
  const removedIndex = group.findIndex((config) => config.file === removedFile)
  if (removedIndex < 0) return undefined
  const previous = group
    .slice(0, removedIndex)
    .reverse()
    .find((config) => isAvailable(config.file))
  const following = group.slice(removedIndex + 1).find((config) => isAvailable(config.file))
  return (previous ?? following)?.file
}
type ProvidersModalKind = 'rules' | 'proxies'

const TOGGLE_ALL_SELECTORS_EVENT = 'mihomo:toggle-all-selectors'
const SHOW_HIDDEN_SELECTORS_KEY = 'showHiddenSelectors'

interface Props {
  onOpenImport: () => void
  onOpenImportAmnezia: () => void
  onOpenTemplate: () => void
  onOpenGeoScan: () => void
  onOpenRouteTest: () => void
  onOpenBackups: () => void
  onRefreshConfigs: () => Promise<Config[]>
  onPanelChange?: (panel: PanelTab) => void
  editorRef: React.RefObject<CodeMirrorRef | null>
  configActionsRef: React.RefObject<{ switchTab: (index: number) => void; getActiveIndex: () => number }>
}

interface ConfigTabProps {
  config: Config
  currentCore: string
  isActive: boolean
  showToast: (msg: string, type?: 'success' | 'error') => void
  onRefreshConfigs: () => Promise<Config[]>
  withContextMenu?: boolean
  onHideFile?: (file: string) => void
  onOpenHistory: (file: string) => void
  onNavigateToSection: (file: string, section: MihomoSectionKey) => void
}

type DialogState =
  | { type: 'create'; dir: string; isLst: boolean; anchorFile: string }
  | { type: 'rename'; file: string }
  | { type: 'delete'; file: string }
  | null

function ConfigTab({
  config,
  currentCore,
  isActive,
  showToast,
  onRefreshConfigs,
  onHideFile,
  onOpenHistory,
  onNavigateToSection,
  withContextMenu = false,
}: ConfigTabProps) {
  const [dialogData, setDialogData] = useState<DialogState>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false)
  const contextMenuOpenRef = useRef(false)
  const sectionMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sectionHoverSessionRef = useRef(false)
  const touchStartedOnActiveConfigRef = useRef(false)
  const sectionTabRef = useRef<HTMLButtonElement>(null)
  const tabTriggerRef = useRef<HTMLButtonElement>(null)
  const setTabTriggerRef = useCallback((node: HTMLButtonElement | null) => {
    tabTriggerRef.current = node
    sectionTabRef.current = node
  }, [])

  const inputRef = useRef<HTMLInputElement>(null)
  const [inputValue, setInputValue] = useState('')

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768
  const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches
  const isCoreMihomo = currentCore === 'mihomo'
  const isMainMihomoConfig = config.file.split('/').pop()?.toLowerCase() === 'config.yaml'
  const availableSections = isCoreMihomo && isMainMihomoConfig && !isXkeenFile(config.file)
    ? getMihomoSections(config.content)
    : []
  const tabsTrigger = (
    <TabsTrigger
      ref={setTabTriggerRef}
      value={config.file}
      className="dark:data-[state=active]:bg-input-background! relative data-[state=active]:bg-white!"
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse' && isActive) {
          sectionHoverSessionRef.current = true
          keepSectionMenuOpen()
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse' && isActive) closeSectionMenuSoon()
      }}
      onPointerDown={(event) => {
        touchStartedOnActiveConfigRef.current = event.pointerType !== 'mouse' && isActive
      }}
      onClick={(event) => {
        const openFromSecondTouchTap = isTouchDevice && event.detail > 0 && touchStartedOnActiveConfigRef.current
        touchStartedOnActiveConfigRef.current = false
        if (openFromSecondTouchTap && !contextMenuOpenRef.current) setSectionMenuOpen(true)
      }}
      onKeyDown={(event) => {
        if (isActive && !contextMenuOpenRef.current && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault()
          setSectionMenuOpen(true)
        }
      }}
    >
      {config.file
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '')}
      {availableSections.length > 0 && (
        <IconChevronDown
          aria-hidden
          className={cn('size-3.5 shrink-0 opacity-70 transition-transform duration-200', sectionMenuOpen && 'rotate-180')}
        />
      )}
      {config.isDirty && <span className="absolute top-0.75 right-0.75 h-1.5 w-1.5 rounded-full bg-amber-400" />}
    </TabsTrigger>
  )

  const closeSectionMenuSoon = () => {
    if (sectionMenuCloseTimerRef.current) clearTimeout(sectionMenuCloseTimerRef.current)
    sectionMenuCloseTimerRef.current = setTimeout(() => {
      sectionHoverSessionRef.current = false
      setSectionMenuOpen(false)
    }, 500)
  }
  const keepSectionMenuOpen = () => {
    if (sectionMenuCloseTimerRef.current) clearTimeout(sectionMenuCloseTimerRef.current)
    sectionMenuCloseTimerRef.current = null
    setSectionMenuOpen(true)
  }
  useEffect(() => () => {
    if (sectionMenuCloseTimerRef.current) clearTimeout(sectionMenuCloseTimerRef.current)
  }, [])

  const sectionNavigation = availableSections.length > 0 ? (
    <DropdownMenu
      open={sectionMenuOpen}
      modal={false}
      onOpenChange={(open, details) => {
        if (!open && details.reason === 'focus-out' && sectionHoverSessionRef.current) return
        setSectionMenuOpen(open)
      }}
    >
      {tabsTrigger}
      <DropdownMenuContent
        anchor={sectionTabRef}
        align="start"
        side="bottom"
        sideOffset={5}
        className="w-52 min-w-52"
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') {
            sectionHoverSessionRef.current = true
            keepSectionMenuOpen()
          }
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') closeSectionMenuSoon()
        }}
      >
        {availableSections.map((section) => (
          <DropdownMenuItem
            key={section}
            onSelect={() => {
              setSectionMenuOpen(false)
              onNavigateToSection(config.file, section)
            }}
          >
            {section}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <TooltipTrigger render={<span className="inline-flex">{tabsTrigger}</span>} />
  )

  const openDialog = (value: NonNullable<DialogState>) => {
    setDialogData(value)
    setPopoverOpen(true)
  }

  const closeDialog = () => setPopoverOpen(false)

  const fileExt = useMemo(() => {
    if (!dialogData || dialogData.type === 'delete') return ''
    if (dialogData.type === 'rename') return dialogData.file.match(/(\.[^.]+)$/)?.[1] ?? ''
    return dialogData.isLst ? '.lst' : isCoreMihomo ? '.yaml' : '.json'
  }, [dialogData, isCoreMihomo])

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

  if (!withContextMenu)
    return (
      availableSections.length > 0 ? (
        sectionNavigation
      ) : (
        <Tooltip>
          {sectionNavigation}
          <TooltipContent className="text-[13px]">{config.file}</TooltipContent>
        </Tooltip>
      )
    )

  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(open) => {
        if (!open) setPopoverOpen(false)
      }}
    >
      <ContextMenu
        onOpenChange={(open) => {
          contextMenuOpenRef.current = open
          if (open) setSectionMenuOpen(false)
        }}
      >
        <ContextMenuTrigger className="contents">
          {availableSections.length > 0 ? (
            sectionNavigation
          ) : (
            <Tooltip>
              {sectionNavigation}
              <TooltipContent className="text-[13px]">{config.file}</TooltipContent>
            </Tooltip>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-48" finalFocus={false}>
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
          {onHideFile && (
            <ContextMenuItem disabled={isProtected} onSelect={() => onHideFile(config.file)}>
              <IconEyeOff /> Скрыть файл
            </ContextMenuItem>
          )}
          {supportsConfigHistory(config.file) && (
            <ContextMenuItem onSelect={() => onOpenHistory(config.file)}>
              <IconHistory /> История изменений
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={isProtected} variant="destructive" onSelect={() => openDialog({ type: 'delete', file: config.file })}>
            <IconTrash /> Удалить файл
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <PopoverContent
        anchor={tabTriggerRef}
        align="start"
        className="w-auto min-w-64"
        avoidCollisions={!isMobile}
        initialFocus={dialogData?.type === 'delete' ? true : inputRef}
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

export function ConfigPanel({
  onOpenImport,
  onOpenImportAmnezia,
  onOpenTemplate,
  onOpenGeoScan,
  onOpenRouteTest,
  onOpenBackups,
  onRefreshConfigs,
  onPanelChange,
  editorRef,
  configActionsRef,
}: Props) {
  const { state, dispatch, showToast } = useAppContext({ includeConfigs: true })
  const {
    configs,
    isConfigsLoading,
    currentCore,
    serviceStatus,
    isOutdatedCore,
    isOutdatedUI,
    clashApiPort,
    clashApiSecret,
    clashApiUnix,
  } = state
  const configHistoryMaxSnapshots = useSettings((s) => s.configHistoryMaxSnapshots)
  const isLocalHistoryEnabled = configHistoryMaxSnapshots > 0
  const guiRouting = useSettings((s) => s.guiRouting)
  const guiLog = useSettings((s) => s.guiLog)
  const guiOutbounds = useSettings((s) => s.guiOutbounds)
  const multiRouter = useSettings((s) => s.multiRouter)
  const closeConnsOnApply = useSettings((s) => s.closeConnectionsOnApply)
  const hiddenConfigFiles = useSettings((s) => s.hiddenConfigFiles)
  const [configHistoryFile, setConfigHistoryFile] = useState<string | null>(null)
  const applyTargets = useRoutersStore((s) => s.applyTargets)
  const getMassTargets = () => {
    if (!multiRouter) return [LOCAL_ROUTER_ID]
    return applyTargets.length > 0 ? applyTargets : [LOCAL_ROUTER_ID]
  }

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending'
  const activeClashApiPort = isRunning ? clashApiPort : null
  const activeClashApiUnix = isRunning ? clashApiUnix : null

  const isCoreMihomo = currentCore === 'mihomo'

  useConnectionsSync(isCoreMihomo ? activeClashApiPort : null, clashApiSecret, serviceStatus, activeClashApiUnix)

  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const updateViewport = () => setIsMobile(media.matches)
    media.addEventListener('change', updateViewport)
    return () => media.removeEventListener('change', updateViewport)
  }, [])

  const [activeConfigFile, setActiveConfigFile] = useState<string>(() => localStorage.getItem('lastSelectedTab') ?? '')
  const activeConfigIndex = useMemo(() => {
    if (!configs.length) return 0
    const idx = configs.findIndex((c) => c.file === activeConfigFile)
    if (idx >= 0 && !hiddenConfigFiles.includes(activeConfigFile)) return idx
    const firstVisible = configs.findIndex((c) => !hiddenConfigFiles.includes(c.file))
    return firstVisible >= 0 ? firstVisible : 0
  }, [configs, activeConfigFile, hiddenConfigFiles])
  const [validationState, setValidationState] = useState<{ isValid: boolean; error?: string } | null>(null)
  const [pendingSectionJump, setPendingSectionJump] = useState<{ file: string; section: MihomoSectionKey } | null>(null)

  const [isEditorMounted, setIsEditorMounted] = useState(false)

  const [activePanel, setActivePanel] = useState<PanelTab>('selectors')
  const [mountedPanels, setMountedPanels] = useState<Set<string>>(() => new Set(['selectors']))
  const panelScrollRefs = useRef<Partial<Record<PanelTab, HTMLDivElement | null>>>({})
  const panelPointerDownRef = useRef<PanelTab | null>(null)
  const scrollPanelToTop = useCallback((panel: PanelTab) => {
    panelScrollRefs.current[panel]?.querySelector<HTMLElement>('[data-panel-scroll]')?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])
  const changePanel = useCallback((panel: PanelTab) => {
    setActivePanel(panel)
    if (panel !== 'config') setConfigHistoryFile(null)
    setMountedPanels((prev) => (prev.has(panel) ? prev : new Set([...prev, panel])))
  }, [])
  const [mode, setMode] = useState<ClashMode>('rule')
  const [allSelectorsCollapsed, setAllSelectorsCollapsed] = useState(false)
  const [selectorDisplay, setSelectorDisplay] = useState(readSelectorDisplay)
  useEffect(() => {
    const update = () => setSelectorDisplay(readSelectorDisplay())
    window.addEventListener(DISPLAY_EVENT, update)
    window.addEventListener('storage', update)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener(DISPLAY_EVENT, update)
      window.removeEventListener('storage', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  const [showHiddenSelectors, setShowHiddenSelectors] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_HIDDEN_SELECTORS_KEY) === '1'
    } catch {
      return false
    }
  })
  const [providersModalKind, setProvidersModalKind] = useState<ProvidersModalKind | null>(null)
  const [isProvidersModalOpen, setIsProvidersModalOpen] = useState(false)
  const mountProvidersModal = useLazyMount(isProvidersModalOpen)
  const currentPanel = activePanel === 'log' ? (isMobile ? 'log' : 'config') : isRunning ? activePanel : 'config'
  const isLogPanel = currentPanel === 'log'
  useEffect(() => {
    if (!isMobile && activePanel === 'log') setActivePanel('config')
  }, [isMobile, activePanel])
  useEffect(() => {
    onPanelChange?.(currentPanel)
  }, [currentPanel, onPanelChange])
  const [massConfirm, setMassConfirm] = useState<{
    title: string
    description: string
    targets: string[]
    action: () => void
  } | null>(null)

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
    if (!isCoreMihomo || (!activeClashApiPort && !activeClashApiUnix)) return
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
  }, [isCoreMihomo, activeClashApiPort, clashApiSecret, activeClashApiUnix])

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

  function openConfigHistory(file: string) {
    const index = configsRef.current.findIndex((config) => config.file === file)
    if (index >= 0 && index !== activeIndexRef.current) switchTab(index)
    setActivePanel('config')
    setMountedPanels((prev) => (prev.has('config') ? prev : new Set([...prev, 'config'])))
    setConfigHistoryFile(file)
  }

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

  const savedContentKey = activeConfig?.savedContent
  useEffect(() => {
    const config = configsRef.current[activeConfigIndex]
    if (editorRef.current && config) {
      loadConfigIntoEditor(config)
    }
  }, [activeConfigIndex, savedContentKey, loadConfigIntoEditor, editorRef])

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

  const refreshConfigsAndEditor = useCallback(async () => {
    const currentCfg = configsRef.current[activeIndexRef.current]
    if (currentCfg) saveViewState(currentCfg.file, currentCfg.isDirty)

    const targetFile = currentCfg?.file ?? activeConfigFile
    const previousConfigs = configsRef.current
    const nextConfigs = await onRefreshConfigs()
    const target = nextConfigs.find((config) => config.file === targetFile)
    const neighborFile = findNeighborFile(
      previousConfigs,
      targetFile,
      (file) => !hiddenConfigFiles.includes(file) && nextConfigs.some((config) => config.file === file)
    )
    const nextConfig =
      target && !hiddenConfigFiles.includes(target.file)
        ? target
        : (nextConfigs.find((config) => config.file === neighborFile) ??
          nextConfigs.find((config) => !hiddenConfigFiles.includes(config.file)) ??
          nextConfigs[0])

    if (nextConfig) {
      if (nextConfig.file !== activeConfigFile) {
        setActiveConfigFile(nextConfig.file)
        localStorage.setItem('lastSelectedTab', nextConfig.file)
      }
      loadConfigIntoEditor(nextConfig)
    }

    return nextConfigs
  }, [activeConfigFile, hiddenConfigFiles, loadConfigIntoEditor, onRefreshConfigs, saveViewState])

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

  const navigateToSection = useCallback(
    (file: string, section: MihomoSectionKey) => {
      const index = configsRef.current.findIndex((config) => config.file === file)
      if (index < 0) return
      setPendingSectionJump({ file, section })
      if (index !== activeIndexRef.current) switchTab(index)
      setActivePanel('config')
      setMountedPanels((previous) => (previous.has('config') ? previous : new Set([...previous, 'config'])))
    },
    [switchTab]
  )

  useEffect(() => {
    if (!pendingSectionJump || !isEditorMounted || currentPanel !== 'config' || activeConfig?.file !== pendingSectionJump.file) return
    const line = getMihomoSectionHeaderLine(activeConfig.content, pendingSectionJump.section)
    setPendingSectionJump(null)
    if (line !== null) requestAnimationFrame(() => editorRef.current?.revealLine(line))
  }, [activeConfig?.content, activeConfig?.file, currentPanel, editorRef, isEditorMounted, pendingSectionJump])

  useEffect(() => {
    configActionsRef.current = { switchTab, getActiveIndex: () => activeIndexRef.current }
  }, [configActionsRef, switchTab])

  async function executeSave(targets: string[], cfg: Config, content: string, targetIndex: number) {
    const historyErrors: string[] = []
    const results = await runMassTask(targets, async (id, baseUrl) => {
      const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'configs', { file: cfg.file, content }, { baseUrl })
      if (!result.success) throw new Error(result.error || 'ошибка сохранения')
      const historyError = baseUrl || isLocalHistoryEnabled ? await saveConfigRevision(cfg.file, content, baseUrl, cfg.savedContent) : null
      if (historyError) historyErrors.push(`${targetLabel(id)}: ${historyError}`)
    })

    const localOk = results.find((r) => r.id === LOCAL_ROUTER_ID)?.ok
    if (targets.includes(LOCAL_ROUTER_ID) ? localOk : results.some((r) => r.ok)) {
      const currentConfigs = configsRef.current
      let finalIndex = currentConfigs.findIndex((c) => c.file === cfg.file)
      if (finalIndex < 0) finalIndex = targetIndex
      dispatch({ type: 'SAVE_CONFIG', index: finalIndex, content })
      if (configsRef.current[activeIndexRef.current]?.file === cfg.file) {
        editorRef.current?.setSavedContent(content)
        saveViewState(cfg.file, false)
      }
    }

    const summary = summarizeFanOut(results)
    const fileName = cfg.file.split('/').pop()
    const historyWarning = historyErrors.length ? ` Не удалось записать историю: ${historyErrors.join('; ')}` : ''
    if (results.length <= 1) {
      showToast(
        summary.fail === 0 ? `Файл "${fileName}" сохранен.${historyWarning}` : errorToastText(summary.body, 'Ошибка сохранения'),
        summary.fail === 0 && !historyWarning ? 'success' : 'error'
      )
    } else {
      showToast(
        {
          title: summary.fail === 0 ? `Файл "${fileName}" сохранен` : 'Сохранение завершено с ошибками',
          body: [summary.body, historyWarning].filter(Boolean).join('\n'),
        },
        summary.fail === 0 && !historyWarning ? 'success' : 'error'
      )
    }
  }

  async function resolveMassTargets(): Promise<string[] | null> {
    const selected = getMassTargets()
    const { allowed, blocked } = await filterAuthBlockedTargets(selected)
    if (blocked.length > 0) {
      showToast(
        {
          title: 'Пропущены панели с авторизацией',
          body: `${blocked.map(targetLabel).join(', ')}. ${REMOTE_AUTH_UNSUPPORTED}`,
        },
        'error'
      )
    }
    if (allowed.length === 0) return null
    return allowed
  }

  async function saveCurrentConfig(force = false) {
    const targetIndex = activeIndexRef.current
    const cfg = configsRef.current[targetIndex]
    if (!cfg || !editorRef.current) return
    const content = editorRef.current.getValue()
    if (!content.trim() && !cfg.file.endsWith('.lst')) return showToast('Конфигурация пустая', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: () => saveCurrentConfig(true) })
      dispatch({ type: 'SHOW_MODAL', modal: 'showCommentsWarningModal', show: true })
      return
    }

    const targets = await resolveMassTargets()
    if (!targets) return
    const hasRemote = targets.some((t) => t !== LOCAL_ROUTER_ID)
    if (hasRemote) {
      setMassConfirm({
        title: 'Массовое сохранение',
        description: 'Конфиг будет сохранён на выбранных роутерах:',
        targets: targets.map(targetLabel),
        action: () => void executeSave(targets, cfg, content, targetIndex),
      })
      return
    }

    await executeSave(targets, cfg, content, targetIndex)
  }

  function restartActionFor(cfg: Config, content: string) {
    const lang = getFileLanguage(cfg.file)
    return !isXkeenFile(cfg.file) && (lang === 'json' || lang === 'yaml') && !hasCriticalChanges(cfg.savedContent, content, lang)
      ? 'softRestart'
      : 'hardRestart'
  }

  async function applyToHost(baseUrl: string | null, cfg: Config, content: string, onHistoryError: (message: string) => void) {
    let core = currentCore
    if (baseUrl) {
      try {
        const ctrl = await apiCall<{ success?: boolean; currentCore?: string }>('GET', 'control', undefined, { baseUrl })
        if (ctrl?.currentCore) core = ctrl.currentCore
      } catch {
        /* keep local core */
      }
    }

    const isHotReload = core === 'mihomo' && !isXkeenFile(cfg.file)

    let validate = ''
    if (!isXkeenFile(cfg.file) && (core === 'mihomo' || core === 'xray')) {
      validate = `?validate=${core}`
      if (core === 'mihomo' && closeConnsOnApply) validate += '&closeConns=true'
    }
    const saveResult = await apiCall<ApiResult>(
      'PUT',
      `configs${validate}`,
      { file: cfg.file, content },
      {
        baseUrl,
      }
    )
    const hotReloadUnavailable = saveResult.error === HOT_RELOAD_UNAVAILABLE
    if (!saveResult.success && !hotReloadUnavailable) {
      throw new Error(
        saveResult.error === 'Validation failed'
          ? `Ошибка валидации ${capitalize(core)}: проверьте журнал`
          : saveResult.error || 'Ошибка сохранения'
      )
    }

    const historyError = baseUrl || isLocalHistoryEnabled ? await saveConfigRevision(cfg.file, content, baseUrl, cfg.savedContent) : null
    if (historyError) onHistoryError(historyError)

    if (hotReloadUnavailable) showToast('Clash API недоступен, выполняем полный рестарт', 'warning')

    const action = hotReloadUnavailable
      ? 'hardRestart'
      : isHotReload
        ? hasCriticalChanges(cfg.savedContent, content, 'yaml')
          ? 'hardRestart'
          : null
        : restartActionFor(cfg, content)
    if (!action) return false

    const restartResult = await apiCall<ApiResult>('POST', 'control', { action, core }, { baseUrl })
    if (!restartResult?.success) throw new Error(restartResult?.error || 'ошибка перезапуска')
    return true
  }

  async function executeApply(targets: string[], cfg: Config, content: string, targetIndex: number) {
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Применение...' })
    const isMihomoHotReload = currentCore === 'mihomo' && !isXkeenFile(cfg.file)
    let localRestarted = false
    const historyErrors: string[] = []
    const results = await runMassTask(targets, async (id, baseUrl) => {
      const restarted = await applyToHost(baseUrl, cfg, content, (error) => historyErrors.push(`${targetLabel(id)}: ${error}`))
      if (id === LOCAL_ROUTER_ID) localRestarted = restarted
    })

    const localOk = results.find((r) => r.id === LOCAL_ROUTER_ID)?.ok
    if (targets.includes(LOCAL_ROUTER_ID) ? localOk : results.some((r) => r.ok)) {
      const currentConfigs = configsRef.current
      let finalIndex = currentConfigs.findIndex((c) => c.file === cfg.file)
      if (finalIndex < 0) finalIndex = targetIndex
      dispatch({ type: 'SAVE_CONFIG', index: finalIndex, content })
      if (configsRef.current[activeIndexRef.current]?.file === cfg.file) {
        editorRef.current?.setSavedContent(content)
        saveViewState(cfg.file, false)
      }
    }

    const summary = summarizeFanOut(results)
    const historyWarning = historyErrors.length ? ` Не удалось записать историю: ${historyErrors.join('; ')}` : ''
    if (results.length <= 1) {
      showToast(
        summary.fail === 0 ? `Изменения применены.${historyWarning}` : errorToastText(summary.body),
        summary.fail === 0 && !historyWarning ? 'success' : 'error'
      )
    } else {
      showToast(
        {
          title: summary.fail === 0 ? 'Изменения применены' : 'Применение завершено с ошибками',
          body: [summary.body, historyWarning].filter(Boolean).join('\n'),
        },
        summary.fail === 0 && !historyWarning ? 'success' : 'error'
      )
    }

    if (targets.includes(LOCAL_ROUTER_ID)) {
      const nextStatus =
        localOk === false && !(isMihomoHotReload && !localRestarted) ? 'stopped' : isRunning || localOk ? 'running' : 'stopped'
      dispatch({
        type: 'SET_SERVICE_STATUS',
        status: nextStatus,
      })
      if (localOk !== false) syncClashApiPort(200)
    } else {
      dispatch({ type: 'SET_SERVICE_STATUS', status: isRunning ? 'running' : 'stopped' })
    }
  }

  async function saveAndApply(force = false) {
    const targetIndex = activeIndexRef.current
    const cfg = configsRef.current[targetIndex]
    if (!cfg || !editorRef.current) return
    const content = editorRef.current.getValue()
    if (!content.trim() && !cfg.file.endsWith('.lst')) return showToast('Файл пустой', 'error')
    if (!editorRef.current.isValid(cfg.file)) return showToast('Файл содержит ошибки', 'error')
    if (!force && isGuiActive(cfg) && hasComments(cfg.savedContent)) {
      dispatch({ type: 'SET_PENDING_SAVE_ACTION', action: () => saveAndApply(true) })
      dispatch({ type: 'SHOW_MODAL', modal: 'showCommentsWarningModal', show: true })
      return
    }

    const targets = await resolveMassTargets()
    if (!targets) return
    const hasRemote = targets.some((t) => t !== LOCAL_ROUTER_ID)
    if (hasRemote) {
      setMassConfirm({
        title: 'Массовое применение',
        description: 'Конфиг будет сохранён и применён на выбранных роутерах:',
        targets: targets.map(targetLabel),
        action: () => void executeApply(targets, cfg, content, targetIndex),
      })
      return
    }

    await executeApply(targets, cfg, content, targetIndex)
  }

  async function executeQuickBackup(targets: string[]) {
    const results = await runMassTask(targets, async (_id, baseUrl) => {
      const result = await apiCall<{ success: boolean; error?: string }>('PUT', 'backup', undefined, { baseUrl })
      if (!result.success) throw new Error(result.error || 'ошибка бэкапа')
    })
    const summary = summarizeFanOut(results)
    if (results.length <= 1) {
      showToast(summary.fail === 0 ? 'Быстрый бэкап создан' : errorToastText(summary.body), summary.fail === 0 ? 'success' : 'error')
    } else {
      showToast(
        {
          title: summary.fail === 0 ? 'Быстрый бэкап создан' : 'Бэкап завершён с ошибками',
          body: summary.body,
        },
        summary.fail === 0 ? 'success' : 'error'
      )
    }
  }

  async function quickBackup() {
    const targets = await resolveMassTargets()
    if (!targets) return
    const hasRemote = targets.some((t) => t !== LOCAL_ROUTER_ID)
    if (hasRemote) {
      setMassConfirm({
        title: 'Быстрый бэкап',
        description: 'Бэкап конфигураций будет создан на выбранных роутерах:',
        targets: targets.map(targetLabel),
        action: () => void executeQuickBackup(targets),
      })
      return
    }
    void executeQuickBackup(targets)
  }

  function isGuiActive(cfg: Config) {
    const f = cfg.file.toLowerCase()
    return (f.includes('routing') && guiRouting) || (f.includes('log') && guiLog) || (f.includes('outbound') && guiOutbounds)
  }

  const fileForGui = activeConfig?.file
  const contentForGui = activeConfig?.savedContent
  const isRoutingGui = useMemo(() => {
    if (!guiRouting || !fileForGui) return false
    if (!fileForGui.toLowerCase().includes('routing')) return false
    try {
      const j = parseJsonc(contentForGui || '')
      return j && typeof j.routing === 'object'
    } catch {
      return false
    }
  }, [guiRouting, fileForGui, contentForGui])

  const isLogGui = useMemo(() => {
    if (!guiLog || !fileForGui) return false
    if (!fileForGui.toLowerCase().includes('log')) return false
    try {
      const j = parseJsonc(contentForGui || '')
      return j && typeof j.log === 'object'
    } catch {
      return false
    }
  }, [guiLog, fileForGui, contentForGui])

  const isOutboundsGui = useMemo(() => {
    if (!guiOutbounds || !fileForGui || isRoutingGui || isLogGui) return false
    try {
      const j = parseJsonc(contentForGui || '')
      return Array.isArray(j?.outbounds)
    } catch {
      return false
    }
  }, [guiOutbounds, fileForGui, contentForGui, isRoutingGui, isLogGui])

  const isAnyGui = isRoutingGui || isLogGui || isOutboundsGui

  const coreConfigs = configs.filter((c) => !isXkeenFile(c.file) && !hiddenConfigFiles.includes(c.file))
  const xkeenConfigs = configs.filter((c) => isXkeenFile(c.file) && !hiddenConfigFiles.includes(c.file))

  const hideConfigFile = useCallback(
    async (file: string) => {
      const visibleCount = configs.filter((c) => c.file !== file && !hiddenConfigFiles.includes(c.file)).length
      if (visibleCount === 0) {
        showToast('Нельзя скрыть последний файл', 'error')
        return
      }
      const next = hiddenConfigFiles.includes(file) ? hiddenConfigFiles : [...hiddenConfigFiles, file]
      try {
        const result = await apiCall<{ success: boolean; error?: string }>('PATCH', 'settings', { ui: { hidden_files: next } })
        if (!result.success) {
          showToast(`Ошибка: ${result.error}`, 'error')
          return
        }
        dispatch({ type: 'SET_SETTINGS', settings: { hiddenConfigFiles: next } })
        showToast('Файл успешно скрыт. Скрытый файл можно вернуть в настройках', 'success')
        if (activeConfigFile === file) {
          const nextFile = findNeighborFile(configs, file, (candidate) => !next.includes(candidate))
          if (nextFile) {
            setActiveConfigFile(nextFile)
            localStorage.setItem('lastSelectedTab', nextFile)
          }
        }
      } catch (e: any) {
        showToast(e.message, 'error')
      }
    },
    [configs, hiddenConfigFiles, activeConfigFile, dispatch, showToast]
  )

  async function rollbackConfig(file: string, content: string, applying = false) {
    const configIndex = configsRef.current.findIndex((config) => config.file === file)
    const config = configsRef.current[configIndex]
    if (!config) throw new Error('Конфигурация недоступна')

    const isDirty = content !== config.savedContent
    dispatch({ type: 'UPDATE_CONFIG_DIRTY', index: configIndex, content, isDirty })
    if (configsRef.current[activeIndexRef.current]?.file === file) {
      const editorViewState = editorRef.current?.saveViewState()
      editorRef.current?.setValue(content)
      editorRef.current?.validate(file)
      if (editorViewState) editorRef.current?.restoreViewState(editorViewState)
      saveViewState(file, isDirty)
    }
    if (!applying) showToast('Изменение отменено в редакторе. Сохраните файл, чтобы применить.', 'success')
  }

  async function rollbackConfigAndApply(file: string, content: string) {
    await rollbackConfig(file, content, true)
    await saveAndApply()
  }

  function showRollbackError(reason: unknown) {
    showToast(reason instanceof Error ? reason.message : 'Не удалось отменить изменение', 'error')
  }

  const isMihomo = isCoreMihomo && (!!activeClashApiPort || !!activeClashApiUnix)
  const panelNavItems: { value: PanelTab; label: string; icon: typeof IconWorld; disabled?: boolean }[] = isMihomo
    ? [
        { value: 'selectors', label: 'Селекторы', icon: IconAdjustmentsHorizontal, disabled: !isRunning },
        { value: 'connections', label: 'Соединения', icon: IconArrowsExchange, disabled: !isRunning },
        { value: 'dns', label: 'DNS', icon: IconWorld },
        { value: 'config', label: 'Конфиг', icon: IconFileCode },
        { value: 'log', label: 'Статус', icon: IconTerminal2 },
      ]
    : [
        { value: 'config', label: 'Конфиг', icon: IconFileCode },
        { value: 'log', label: 'Статус', icon: IconTerminal2 },
      ]
  const usefulLinks = [
    { title: 'Инструкция XKeen', url: 'https://github.com/Corvus-Malus/XKeen/' },
    { title: 'FAQ XKeen', url: 'https://jameszero.net/faq-xkeen.htm' },
    { title: 'Документация Xray', url: 'https://xtls.github.io/ru/config' },
    { title: 'Документация Mihomo', url: 'https://wiki.metacubex.one/ru/config/general' },
  ]

  const isServicePending = serviceStatus === 'pending' || serviceStatus === 'loading'
  const hasUpdate = isOutdatedCore || isOutdatedUI
  const statusTabTone = isRunning
    ? 'text-emerald-500! dark:text-emerald-400! data-active:bg-emerald-500/15! data-active:text-emerald-400!'
    : isServicePending
      ? 'text-amber-500! dark:text-amber-400! data-active:bg-amber-500/15! data-active:text-amber-400!'
      : 'text-red-500! dark:text-red-400! data-active:bg-red-500/15! data-active:text-red-400!'

  const mobilePanelNav = (
    <div className="absolute inset-x-3 bottom-3 z-20 md:hidden">
      <div className="border-border/70 bg-card/70 rounded-full border p-1 shadow-lg backdrop-blur-xl backdrop-saturate-150">
        <Tabs value={currentPanel} onValueChange={(value) => changePanel(value as PanelTab)} className="w-full gap-0">
          <TabsList variant="line" className="h-auto! w-full gap-0 rounded-full bg-transparent p-0">
            {panelNavItems.map(({ value, label, icon: NavIcon, disabled }) => {
              const isStatus = value === 'log'
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  disabled={disabled}
                  onPointerDown={() => {
                    panelPointerDownRef.current = currentPanel
                  }}
                  onClick={() => {
                    if (panelPointerDownRef.current === value) scrollPanelToTop(value)
                    panelPointerDownRef.current = null
                  }}
                  className={cn(
                    'text-muted-foreground h-auto! flex-1 flex-col gap-0.5 rounded-full px-1 py-2 text-[10px] font-medium after:hidden data-active:border-transparent!',
                    isStatus
                      ? statusTabTone
                      : 'data-active:bg-blue-500/15! data-active:text-blue-400! dark:data-active:text-blue-400!'
                  )}
                >
                  <span className="relative">
                    <NavIcon className="size-4.5" stroke={currentPanel === value ? 2.2 : 1.8} />
                    {isStatus && hasUpdate && (
                      <span className="absolute -top-0.5 -right-0.5 flex">
                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75" />
                        <span className="relative inline-flex size-1.75 rounded-full bg-blue-500" />
                      </span>
                    )}
                  </span>
                  <span className="max-w-full truncate leading-none">{label}</span>
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>
      </div>
    </div>
  )

  return (
    <TooltipProvider delayDuration={700} timeout={0}>
      <>
        <div className="border-border bg-card relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border-0 md:border">
          {configHistoryFile && (
            <div className="absolute inset-0 z-30 flex min-h-0 flex-col">
              <ConfigHistoryView
                file={configHistoryFile}
                currentContent={configs.find((config) => config.file === configHistoryFile)?.content ?? ''}
                onClose={() => setConfigHistoryFile(null)}
                onRollback={(file, content) => rollbackConfig(file, content).catch(showRollbackError)}
                onRollbackAndApply={(file, content) => rollbackConfigAndApply(file, content).catch(showRollbackError)}
              />
            </div>
          )}
          <div
            className={cn(
              'flex shrink-0 flex-col gap-2 px-2.5 pt-2.5 md:flex-row md:items-start md:px-4 md:pt-4',
              (isLogPanel || currentPanel === 'dns' || currentPanel === 'connections') && 'max-md:hidden'
            )}
          >
            <div className="hidden min-w-0 shrink-0 items-center gap-2 md:flex">
              {isMihomo ? (
                <div className="min-w-0">
                  <Tabs value={currentPanel} onValueChange={(value) => changePanel(value as PanelTab)} className="w-max flex-row!">
                    <TabsList variant="line" className="w-max shrink-0 gap-3 p-0 whitespace-nowrap">
                      <TabsTrigger value="selectors" className="p-0 text-sm font-semibold md:text-lg" disabled={!isRunning}>
                        Селекторы
                      </TabsTrigger>
                      <TabsTrigger value="connections" className="p-0 text-sm font-semibold md:text-lg" disabled={!isRunning}>
                        Соединения
                      </TabsTrigger>
                      <TabsTrigger value="dns" className="p-0 text-sm font-semibold md:text-lg">
                        DNS
                      </TabsTrigger>
                      <TabsTrigger value="config" className="p-0 text-sm font-semibold md:text-lg">
                        Конфигурация
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
              ) : (
                <h2 className="shrink-0 text-lg font-semibold select-none">Конфигурация</h2>
              )}
            </div>

            {isMihomo && currentPanel === 'selectors' && (
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="outline" className="text-[13px]" onClick={() => openProvidersModal('proxies')}>
                  <IconListDetails data-icon="inline-start" />
                  Подписки
                </Button>
                <Button variant="outline" className="text-[13px]" onClick={() => openProvidersModal('rules')}>
                  <IconListDetails data-icon="inline-start" />
                  Рулсеты
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon"
                        aria-label={showHiddenSelectors ? 'Скрыть скрытые селекторы' : 'Показывать скрытые селекторы'}
                        aria-pressed={showHiddenSelectors}
                        className={cn(showHiddenSelectors && 'border-[#60a5fa] text-blue-400')}
                        onClick={() => {
                          setShowHiddenSelectors((prev) => {
                            try {
                              localStorage.setItem(SHOW_HIDDEN_SELECTORS_KEY, prev ? '0' : '1')
                            } catch {
                              /* */
                            }
                            return !prev
                          })
                        }}
                      >
                        {showHiddenSelectors ? <IconEyeOff /> : <IconEye />}
                      </Button>
                    }
                  />
                  <TooltipContent>{showHiddenSelectors ? 'Скрыть скрытые' : 'Показывать скрытые'}</TooltipContent>
                </Tooltip>
                <SelectorDisplaySettings mode={mode} onModeChange={changeMode} />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon"
                        className={cn(selectorDisplay === 'popup' && 'max-md:hidden')}
                        aria-label={allSelectorsCollapsed ? 'Развернуть все селекторы' : 'Свернуть все селекторы'}
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent(TOGGLE_ALL_SELECTORS_EVENT, { detail: { collapsed: !allSelectorsCollapsed } })
                          )
                        }
                      >
                        {allSelectorsCollapsed ? <IconChevronDown /> : <IconChevronUp />}
                      </Button>
                    }
                  />
                  <TooltipContent>{allSelectorsCollapsed ? 'Развернуть все' : 'Свернуть все'}</TooltipContent>
                </Tooltip>
              </div>
            )}

            {!isLogPanel && (!isMihomo || currentPanel === 'config') && (
              <div className="scrollbar-none overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] md:ml-auto [&::-webkit-scrollbar]:hidden">
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
                            isActive={config.file === activeConfigFile}
                            showToast={showToast}
                            onRefreshConfigs={refreshConfigsAndEditor}
                            onOpenHistory={openConfigHistory}
                            onNavigateToSection={navigateToSection}
                            onHideFile={(file) => void hideConfigFile(file)}
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
                            isActive={config.file === activeConfigFile}
                            showToast={showToast}
                            onRefreshConfigs={refreshConfigsAndEditor}
                            onOpenHistory={openConfigHistory}
                            onNavigateToSection={navigateToSection}
                          />
                        ))}
                      </TabsList>
                    )}
                  </Tabs>
                )}
              </div>
            )}
          </div>

          {/* Keep panels mounted while the log tab is open so switching back doesn't remount them */}
          <div className={cn('relative min-h-0 flex-1 md:min-h-175!', isLogPanel && 'hidden')}>
            {isEditorMounted && activeConfig && isRoutingGui && (
              <GuiRouting editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
            )}
            {isEditorMounted && activeConfig && isLogGui && (
              <GuiLog editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
            )}
            {isEditorMounted && activeConfig && isOutboundsGui && (
              <GuiOutbounds editorRef={editorRef} configs={configs} activeConfigIndex={activeConfigIndex} />
            )}

            {isMihomo && (
              <>
                {mountedPanels.has('selectors') && (
                  <div
                    ref={(el) => {
                      panelScrollRefs.current.selectors = el
                    }}
                    className={cn(currentPanel !== 'selectors' && 'hidden')}
                  >
                    <LazyBoundary>
                      <SelectorsPanel
                        clashApiPort={(activeClashApiPort ?? '') as string}
                        mode={mode}
                        clashApiSecret={clashApiSecret ?? null}
                        clashApiUnix={activeClashApiUnix ?? null}
                        showHiddenSelectors={showHiddenSelectors}
                        onCollapsedStateChange={setAllSelectorsCollapsed}
                      />
                    </LazyBoundary>
                  </div>
                )}
                {mountedPanels.has('connections') && (
                  <div
                    ref={(el) => {
                      panelScrollRefs.current.connections = el
                    }}
                    className={cn(currentPanel !== 'connections' && 'hidden')}
                  >
                    <LazyBoundary>
                      <ConnectionsPanel
                        clashApiPort={(activeClashApiPort ?? '') as string}
                        clashApiSecret={clashApiSecret ?? null}
                        clashApiUnix={activeClashApiUnix ?? null}
                      />
                    </LazyBoundary>
                  </div>
                )}
                {mountedPanels.has('dns') && (
                  <div
                    ref={(el) => {
                      panelScrollRefs.current.dns = el
                    }}
                    className={cn(currentPanel !== 'dns' && 'hidden')}
                  >
                    <LazyBoundary>
                      <DnsPanel />
                    </LazyBoundary>
                  </div>
                )}
              </>
            )}

            {!isConfigsLoading && (!isMihomo || mountedPanels.has('config')) && (
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
              </div>
            )}
          </div>

          {isLogPanel && (
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-x-0 top-0 bottom-[4.5rem] md:bottom-0">
                <LogPanel embedded />
              </div>
            </div>
          )}

          {!isLogPanel && (!isMihomo || currentPanel === 'config') && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 px-2.5 pb-20 md:px-4 md:pb-4">
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
                      <TooltipTrigger
                        render={
                          <Button
                            size="default"
                            disabled={!canApply}
                            className="bg-green-600 text-white hover:bg-green-700"
                            onClick={() => saveAndApply()}
                          >
                            <IconRefresh data-icon="inline-start" /> Применить
                          </Button>
                        }
                      />
                      <TooltipContent>Сохранить и перезапустить</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button size="default" disabled={!canSave} onClick={() => saveCurrentConfig()}>
                            <IconDeviceFloppy data-icon="inline-start" /> Сохранить
                          </Button>
                        }
                      />
                      <TooltipContent>
                        Сохранить файл <Kbd>Ctrl+S</Kbd>
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="outline" disabled={!canFormat} onClick={() => editorRef.current?.format()}>
                            <IconCode data-icon="inline-start" /> <span className="hidden sm:inline">Формат</span>
                          </Button>
                        }
                      />
                      <TooltipContent>
                        Форматировать файл <Kbd>Shift+Alt+F</Kbd>
                      </TooltipContent>
                    </Tooltip>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="outline">
                            <IconDotsFilled data-icon="inline-start" /> <span className="hidden sm:inline">Утилиты</span>
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="min-w-64">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Утилиты</DropdownMenuLabel>
                          <DropdownMenuItem onClick={onOpenImport}>
                            <IconLink /> Добавить подключение
                          </DropdownMenuItem>
                          {isCoreMihomo && (
                            <DropdownMenuItem onClick={onOpenImportAmnezia}>
                              <IconFileUpload /> Импорт AmneziaWG
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={onOpenTemplate}>
                            <IconFileText /> Шаблоны конфигураций
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="whitespace-nowrap"
                            onClick={(e) => {
                              if ((e.target as HTMLElement).closest('[data-quick-backup]')) void quickBackup()
                              else onOpenBackups()
                            }}
                          >
                            <IconBox /> Бэкапы конфигураций
                            <Button
                              variant="outline"
                              size="icon-xs"
                              data-quick-backup
                              aria-label="Быстрый бэкап"
                              title="Быстрый бэкап"
                              tabIndex={-1}
                              className="ml-auto size-5 rounded-[min(var(--radius-md),6px)]"
                            >
                              <IconBoltFilled className="size-3.5" />
                            </Button>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={onOpenGeoScan}>
                            <IconSearch /> Скан геофайлов
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={onOpenRouteTest}>
                            <IconRoute /> Проверка маршрута
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        {isMobile ? (
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>Полезные ссылки</DropdownMenuLabel>
                            {usefulLinks.map((link) => (
                              <DropdownMenuItem key={link.url} onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}>
                                <IconExternalLinkFilled /> {link.title}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuGroup>
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
          {mobilePanelNav}
        </div>
        {!isMobile && <LogPanel />}
        {providersModalKind && mountProvidersModal && (
          <ProvidersModal
            open={isProvidersModalOpen}
            kind={providersModalKind}
            clashApiPort={activeClashApiPort ?? ''}
            clashApiSecret={clashApiSecret ?? null}
            clashApiUnix={activeClashApiUnix ?? null}
            onOpenChange={handleProvidersModalOpenChange}
          />
        )}
        <BackupsModalContainer onRefreshConfigs={refreshConfigsAndEditor} />
        {massConfirm && (
          <MassConfirmDialog
            open={!!massConfirm}
            onOpenChange={(open) => !open && setMassConfirm(null)}
            title={massConfirm.title}
            description={massConfirm.description}
            targets={massConfirm.targets}
            onConfirm={massConfirm.action}
          />
        )}
      </>
    </TooltipProvider>
  )
}

function errorToastText(body: string, fallbackPrefix = 'Ошибка') {
  return /^ошибк/i.test(body) ? body : `${fallbackPrefix}: ${body}`
}

function hasComments(content: string) {
  return /(?<!:)\/\/|\/\*[\s\S]*?\*\//.test(content) || /^\s*#/m.test(content)
}

function hasCriticalChanges(oldContent: string, newContent: string, language: string): boolean {
  try {
    if (language === 'yaml') {
      const o = jsyaml.load(oldContent) as Record<string, unknown>
      const n = jsyaml.load(newContent) as Record<string, unknown>
      return [
        'listeners',
        'redir-port',
        'tproxy-port',
        'routing-mark',
        'external-controller',
        'external-controller-tls',
        'external-controller-unix',
        'external-controller-pipe',
        'external-controller-cors',
        'external-controller-routing-mark',
        'external-ui',
        'external-ui-url',
        'external-ui-name',
        'external-doh-server',
        'secret',
        'tls',
      ].some((f) => JSON.stringify(o?.[f]) !== JSON.stringify(n?.[f]))
    }
    if (language === 'json') {
      const o = parseJsonc(oldContent)
      const n = parseJsonc(newContent)
      const clean = (arr: Record<string, unknown>[]) =>
        (arr || []).map((item) => Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'sniffing')))
      return JSON.stringify(clean(o?.inbounds)) !== JSON.stringify(clean(n?.inbounds))
    }
  } catch {
    return false
  }
  return false
}
