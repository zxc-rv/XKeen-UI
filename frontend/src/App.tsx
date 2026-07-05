import { AnimatePresence, motion } from 'framer-motion'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { LoginForm } from './components/auth/Login'
import type { CodeMirrorRef } from './components/configuration/CodeMirror'
import { ConfigPanel } from './components/configuration/ConfigPanel'
import { LogPanel } from './components/log/LogPanel'
import { StatusBar } from './components/status/StatusBar'
import { Toast } from './components/ui/toast'
import { apiCall, capitalize } from './lib/api'
import { LazyBoundary, lazyLoad, useLazyMount } from './lib/loader'
import { fetchClashProxies, getAppState, syncClashApiPort, useAppActions, useModalContext, useSettings } from './lib/store'
import { applyTheme, THEME_MEDIA_QUERY } from './lib/theme'
import { DEFAULT_PING_TEST_TIMEOUT, DEFAULT_PING_TEST_URL, type Config, type ThemeMode } from './lib/types'
import { parseClashApiCredentials } from './lib/utils'
import { parse as parseJsonc } from 'jsonc-parser'

const CommentsWarningModal = lazyLoad(() => import('./components/modals/CommentsWarning'), 'CommentsWarningModal')
const CoreManageModal = lazyLoad(() => import('./components/modals/CoreManagement'), 'CoreManageModal')
const UpdateModal = lazyLoad(() => import('./components/modals/Update'), 'UpdateModal')
const ImportModal = lazyLoad(() => import('./components/modals/AddProxy'), 'ImportModal')
const TemplateModal = lazyLoad(() => import('./components/modals/Templates'), 'TemplateModal')
const SettingsModal = lazyLoad(() => import('./components/modals/Settings'), 'SettingsModal')
const GeoScanModal = lazyLoad(() => import('./components/modals/GeoScan'), 'GeoScanModal')

function useThemeMode(theme: ThemeMode) {
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'auto') return

    const media = window.matchMedia(THEME_MEDIA_QUERY)
    const syncTheme = () => applyTheme('auto')

    media.addEventListener('change', syncTheme)
    return () => media.removeEventListener('change', syncTheme)
  }, [theme])
}

interface ModalManagerProps {
  onSwitchCore: (core: string) => void
  onInstalled: () => void
  onGenerate: (uri: string) => { content: string; type: string } | null
  onAddToConfig: (content: string, type: string, position: 'start' | 'end') => void
  onImportTemplate: (url: string) => Promise<void>
  openModal: (modal: string) => void
}

const ModalManager = memo(function ModalManager({
  onSwitchCore,
  onInstalled,
  onGenerate,
  onAddToConfig,
  onImportTemplate,
  openModal,
}: ModalManagerProps) {
  const { modals, dispatch } = useModalContext()

  const mountCommentsWarning = useLazyMount(modals.showCommentsWarningModal)
  const mountCoreManage = useLazyMount(modals.showCoreManageModal)
  const mountUpdate = useLazyMount(modals.showUpdateModal)
  const mountImport = useLazyMount(modals.showImportModal)
  const mountTemplate = useLazyMount(modals.showTemplateModal)
  const mountSettings = useLazyMount(modals.showSettingsModal)
  const mountGeoScan = useLazyMount(modals.showGeoScanModal)

  return (
    <>
      {mountCommentsWarning && (
        <LazyBoundary>
          <CommentsWarningModal />
        </LazyBoundary>
      )}
      {mountCoreManage && (
        <LazyBoundary>
          <CoreManageModal
            onSwitchCore={onSwitchCore}
            onOpenUpdate={(core: string) => {
              dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })
              openModal('showUpdateModal')
            }}
          />
        </LazyBoundary>
      )}
      {mountUpdate && (
        <LazyBoundary>
          <UpdateModal onInstalled={onInstalled} />
        </LazyBoundary>
      )}
      {mountImport && (
        <LazyBoundary>
          <ImportModal onGenerate={onGenerate} onAddToConfig={onAddToConfig} />
        </LazyBoundary>
      )}
      {mountTemplate && (
        <LazyBoundary>
          <TemplateModal onImport={onImportTemplate} />
        </LazyBoundary>
      )}
      {mountSettings && (
        <LazyBoundary>
          <SettingsModal />
        </LazyBoundary>
      )}
      {mountGeoScan && (
        <LazyBoundary>
          <GeoScanModal />
        </LazyBoundary>
      )}
    </>
  )
})

function AppContent({ onLogout }: { onLogout: () => void }) {
  const { dispatch, showToast } = useAppActions()
  const editorRef = useRef<CodeMirrorRef | null>(null)
  const configActionsRef = useRef<{ switchTab: (index: number) => void; getActiveIndex: () => number }>({
    switchTab: () => { },
    getActiveIndex: () => 0,
  })

  const checkStatus = useCallback(async () => {
    const data = await apiCall<any>('GET', 'control')
    if (!data.success) return null
    const currentCore = data.currentCore || 'xray'
    dispatch({
      type: 'SET_CORE_INFO',
      currentCore,
      coreVersions: getAppState().coreVersions,
      availableCores: data.cores || [],
    })
    dispatch({ type: 'SET_SERVICE_STATUS', status: data.running ? 'running' : 'stopped' })
    return currentCore
  }, [dispatch])

  const loadConfigs = useCallback(
    async (core?: string, skipProxies = false, silent = false): Promise<Config[]> => {
      if (!silent) dispatch({ type: 'SET_CONFIGS_LOADING', loading: true })
      try {
        const result = await apiCall<any>('GET', core ? `configs?core=${core}` : 'configs')
        if (result.success && result.configs) {
          const configs: Config[] = result.configs.map((c: any) => ({ ...c, savedContent: c.content, isDirty: false }))
          dispatch({ type: 'SET_CONFIGS', configs })
          const yamlConfig = configs.find((c: any) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
          const { port, secret, unix } = yamlConfig
            ? parseClashApiCredentials(yamlConfig.content)
            : { port: null, secret: null, unix: null }
          dispatch({ type: 'SET_DASHBOARD_PORT', port, secret, unix } as any)
          const appState = getAppState()
          const activeCores = core ?? appState.currentCore
          if ((port || unix) && activeCores === 'mihomo' && !skipProxies && appState.serviceStatus === 'running') {
            fetchClashProxies(port ?? '', secret, false, unix)
          }
          return configs
        } else {
          if (!silent) dispatch({ type: 'SET_CONFIGS_LOADING', loading: false })
          showToast('Не удалось загрузить конфигурации', 'error')
        }
      } catch (e: any) {
        if (!silent) dispatch({ type: 'SET_CONFIGS_LOADING', loading: false })
        showToast(`${e.message}`, 'error')
      }
      return []
    },
    [dispatch, showToast]
  )

  const checkVersion = useCallback(
    async (showUpdateToast = false) => {
      try {
        const data = await apiCall<any>('GET', 'version')
        if (!data.success) return

        const ui = data['xkeen-ui']
        if (!ui) return

        let isOutdatedCore = false
        const coreVersions: Record<string, string> = {}
        for (const core of ['mihomo', 'xray']) {
          if (data[core]?.version) {
            coreVersions[core] = data[core].version
            if (data[core].outdated) isOutdatedCore = true
          }
        }

        dispatch({
          type: 'SET_VERSION',
          version: ui.version,
          isOutdatedUI: !!ui.outdated,
          isOutdatedCore,
        })

        if (Object.keys(coreVersions).length > 0) {
          const appState = getAppState()
          dispatch({
            type: 'SET_CORE_INFO',
            currentCore: appState.currentCore,
            coreVersions: { ...appState.coreVersions, ...coreVersions },
            availableCores: appState.availableCores,
          })
        }

        if (!showUpdateToast) return
        if (ui.show_toast) showToast({ title: 'Доступно обновление', body: 'Доступна новая версия XKeen UI', persistent: true, id: 'update-ui', ...(ui.link && { action: { url: ui.link } }) })

        for (const core of ['mihomo', 'xray']) {
          const entry = data[core]
          if (entry?.show_toast) {
            showToast({
              title: 'Доступно обновление',
              body: `Доступна новая версия ${capitalize(core)}`,
              persistent: true,
              id: `update-${core}`,
              ...(entry.link ? { action: { url: entry.link } } : {}),
            })
          }
        }
      } catch {
        /* ignore */
      }
    },
    [dispatch, showToast]
  )

  useEffect(() => {
    const loadSettings = async () => {
      const data = await apiCall<any>('GET', 'settings')
      if (data.success)
        dispatch({
          type: 'SET_SETTINGS',
          settings: {
            autoApply: data.gui.auto_apply,
            guiRouting: data.gui.routing,
            guiLog: data.gui.log,
            autoCheckUI: data.updater.auto_check_ui ?? true,
            autoCheckCore: data.updater.auto_check_core ?? true,
            backupCore: data.updater.backup_core,
            githubProxies: data.updater.github_proxy || [],
            pingTestUrl: data.clash_api?.ping_url ?? DEFAULT_PING_TEST_URL,
            pingTestTimeout: data.clash_api?.ping_timeout ?? DEFAULT_PING_TEST_TIMEOUT,
            showSourceName: data.clash_api?.show_source_name ?? false,
            timezone: data.log.timezone,
            authEnabled: !!data.auth?.enabled,
          },
        })
    }

    const init = async () => {
      try {
        await loadSettings()
        const currentCore = await checkStatus()
        if (currentCore) loadConfigs(currentCore)
        checkVersion(true)
      } catch {
        showToast('Ошибка инициализации', 'error')
      }
    }

    init()
  }, [checkStatus, loadConfigs, dispatch, showToast, checkVersion])

  const switchCore = useCallback(
    async (core: string) => {
      const appState = getAppState()
      if (core === appState.currentCore) {
        showToast('Это ядро уже активно', 'error')
        return
      }
      dispatch({ type: 'SHOW_MODAL', modal: 'showCoreManageModal', show: false })
      dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Переключение...' })
      const configs = await loadConfigs(core, true)
      const mihomoYamlEmpty =
        core === 'mihomo' && !configs.find((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')?.content.trim()
      const result = await apiCall<any>('POST', 'control', { action: 'switchCore', core })
      showToast(result.success ? `Ядро изменено на ${capitalize(core)}` : `Ошибка: ${result.error}`, result.success ? 'success' : 'error')
      const data = await apiCall<any>('GET', 'control')
      if (data.success) {
        dispatch({
          type: 'SET_CORE_INFO',
          currentCore: data.currentCore,
          coreVersions: getAppState().coreVersions,
          availableCores: data.cores,
        })
        dispatch({ type: 'SET_SERVICE_STATUS', status: data.running ? 'running' : 'stopped' })
        if (result.success && mihomoYamlEmpty) await loadConfigs(core)
        else if (result.success) syncClashApiPort()
      }
    },
    [dispatch, showToast, loadConfigs]
  )

  const generateConfig = useCallback((uri: string) => {
    const currentCore = getAppState().currentCore
    if (typeof (window as any).generateConfigForCore === 'function')
      return (window as any).generateConfigForCore(uri, currentCore, editorRef.current?.getValue() ?? '')
    throw new Error('Parser not loaded')
  }, [])

  const importTemplate = useCallback(
    async (url: string) => {
      const activeIndex = configActionsRef.current.getActiveIndex()
      const active = getAppState().configs[activeIndex]
      if (active?.isDirty && !confirm('Несохраненные изменения будут потеряны. Продолжить?')) throw new Error('Отменено')
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const content = await res.text()
      if (editorRef.current) {
        editorRef.current.setValue(content)
        dispatch({ type: 'UPDATE_CONFIG_DIRTY', index: activeIndex, isDirty: true, content })
      }
      showToast('Шаблон импортирован')
    },
    [dispatch, showToast]
  )

  const addToConfig = useCallback(
    (generated: string, type: string, position: 'start' | 'end') => {
      const appState = getAppState()
      const core = appState.currentCore
      let targetIndex = configActionsRef.current.getActiveIndex()

      if (core === 'mihomo') {
        targetIndex = appState.configs.findIndex((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
        if (targetIndex === -1) {
          showToast('Файл config.yaml не найден', 'error')
          return
        }
      } else {
        try {
          try {
            const obj = parseJsonc(appState.configs[targetIndex].content)
            if (!Array.isArray(obj.outbounds)) throw new Error()
          } catch {
            targetIndex = appState.configs.findIndex((cfg) => {
              try {
                return Array.isArray(parseJsonc(cfg.content).outbounds)
              } catch {
                return false
              }
            })
            if (targetIndex === -1) {
              showToast('Массив outbounds не найден', 'error')
              return
            }
          }
        } catch (e: any) {
          showToast(`${e.message}`, 'error')
          return
        }
      }

      if (targetIndex !== configActionsRef.current.getActiveIndex()) configActionsRef.current.switchTab(targetIndex)

      setTimeout(() => {
        const editorWrapper = editorRef.current
        if (!editorWrapper) return
        let current = editorWrapper.getValue()
        const lineAtOffset = (text: string, offset: number) => text.slice(0, Math.min(offset, text.length)).split('\n').length
        const scrollToLine = (line: number) => setTimeout(() => editorWrapper.revealLine(Math.max(1, line)), 0)
        const insertAtOffset = (offset: number, text: string, scrollLine?: number) => {
          editorWrapper.replaceRange(offset, offset, text)
          scrollToLine(scrollLine ?? editorWrapper.offsetToLineColumn(offset).lineNumber)
        }

        if (core === 'mihomo') {
          const marker = type === 'proxy' ? 'proxies:' : 'proxy-providers:'
          const markerRegex = new RegExp(`^${marker}(.*)$`, 'm')
          const markerMatch = current.match(markerRegex)

          if (!markerMatch) {
            const eofStr = current.endsWith('\n') ? '' : '\n'
            const insertPos = current.length
            const targetLine = lineAtOffset(current, insertPos) + (eofStr ? 2 : 1)
            insertAtOffset(insertPos, `${eofStr}${marker}\n${generated}\n`, targetLine)
            return
          }

          const markerIdx = markerMatch.index!
          let markerLineEnd = current.indexOf('\n', markerIdx)
          if (markerLineEnd === -1) markerLineEnd = current.length
          else markerLineEnd += 1

          const lineContent = markerMatch[1].trim()
          if (lineContent === '[]' || lineContent === 'null') {
            const pre = current.slice(0, markerIdx)
            const post = current.slice(markerLineEnd)
            current = pre + marker + '\n' + post
            editorWrapper.replaceAll(current)
            markerLineEnd = markerIdx + marker.length + 1
          }

          if (position === 'start') {
            const line = lineAtOffset(current, markerLineEnd)
            insertAtOffset(markerLineEnd, generated + '\n', line)
          } else {
            const afterMarker = markerLineEnd
            const nextKeyMatch = current.slice(afterMarker).search(/^[a-zA-Z0-9_-]+:/m)
            const insertOffset = nextKeyMatch === -1 ? current.length : afterMarker + nextKeyMatch
            let textToInsert = generated + '\n'

            let targetLine = lineAtOffset(current, insertOffset)

            if (nextKeyMatch === -1 && !current.endsWith('\n')) {
              textToInsert = '\n' + textToInsert
              targetLine += 1
            }

            insertAtOffset(insertOffset, textToInsert, targetLine)
          }
        } else {
          try {
            const obj = parseJsonc(current)
            if (position === 'start') obj.outbounds.unshift(JSON.parse(generated))
            else obj.outbounds.push(JSON.parse(generated))
            editorWrapper.replaceAll(JSON.stringify(obj, null, 2))
            scrollToLine(position === 'start' ? 1 : editorWrapper.getLineCount())
          } catch (e: any) {
            showToast(`Ошибка парсинга: ${e.message}`, 'error')
          }
        }
      }, 150)
    },
    [showToast]
  )

  const logout = onLogout
  const onInstalled = useCallback(() => void checkVersion(), [checkVersion])
  const openModal = useCallback(
    (modal: string) => setTimeout(() => dispatch({ type: 'SHOW_MODAL', modal: modal as any, show: true }), 0),
    [dispatch]
  )

  return (
    <div className="bg-muted dark:bg-background flex min-h-dvh flex-col">
      <main className="flex flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-3 px-3 py-3">
          <StatusBar
            onOpenCoreManage={() => openModal('showCoreManageModal')}
            onOpenSettings={() => openModal('showSettingsModal')}
            onRefreshStatus={() => void checkStatus()}
            onOpenUpdate={(core: string) => {
              dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })
              openModal('showUpdateModal')
            }}
            onLogout={logout}
          />
          <ConfigPanel
            editorRef={editorRef}
            configActionsRef={configActionsRef}
            onOpenImport={() => openModal('showImportModal')}
            onOpenTemplate={() => openModal('showTemplateModal')}
            onOpenGeoScan={() => openModal('showGeoScanModal')}
            onOpenBackups={() => openModal('showBackupsModal')}
            onRefreshConfigs={() => loadConfigs(undefined, false, true)}
          />
          <LogPanel />
        </div>
      </main>
      <Toast />
      <ModalManager
        onSwitchCore={switchCore}
        onInstalled={onInstalled}
        onGenerate={generateConfig}
        onAddToConfig={addToConfig}
        onImportTemplate={importTemplate}
        openModal={openModal}
      />
    </div>
  )
}

type AuthState = 'loading' | 'login' | 'setup' | 'authenticated'

export default function App() {
  const [authState, setAuthState] = useState<AuthState>('loading')
  const theme = useSettings((s) => s.theme)

  useThemeMode(theme)

  useEffect(() => {
    fetch('/api/auth/login')
      .then((r) => r.json())
      .then((data) => {
        if (!data.enabled || data.authenticated) setAuthState('authenticated')
        else if (!data.has_password) setAuthState('setup')
        else setAuthState('login')
      })
      .catch(() => setAuthState('login'))
  }, [])

  const handleLogout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    setAuthState('login')
  }, [])

  if (authState === 'loading') return null

  return (
    <AnimatePresence mode="wait">
      {authState === 'login' || authState === 'setup' ? (
        <motion.div key="login" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          <LoginForm mode={authState} onAuth={() => setAuthState('authenticated')} />
          <Toast />
        </motion.div>
      ) : (
        <motion.div key="app" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
          <AppContent onLogout={handleLogout} />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
