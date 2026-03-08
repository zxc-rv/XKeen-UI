import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AppProvider, useAppActions, useModalContext, fetchClashProxies, syncClashApiPort, getAppState } from './lib/store'
import { apiCall, capitalize } from './lib/api'
import { stripJsonComments } from './lib/utils'
import { StatusBar } from './components/status/StatusBar'
import { ConfigPanel } from './components/configuration/ConfigPanel'
import { LogPanel } from './components/log/LogPanel'
import { Toast } from './components/ui/toast'
import { CommentsWarningModal } from './components/modals/CommentsWarning'
import { CoreManageModal } from './components/modals/CoreManagement'
import { UpdateModal } from './components/modals/Update'
import { ImportModal } from './components/modals/AddProxy'
import { TemplateModal } from './components/modals/Templates'
import { SettingsModal } from './components/modals/Settings'
import { GeoScanModal } from './components/modals/GeoScan'
import type { MonacoEditorRef } from './components/configuration/MonacoEditor'
import type { Config } from './lib/types'

function useLazyMount(open: boolean, delay = 200) {
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => setMounted(false), delay)
    return () => clearTimeout(timer)
  }, [open, delay])
  return mounted
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
      {mountCommentsWarning && <CommentsWarningModal />}
      {mountCoreManage && (
        <CoreManageModal
          onSwitchCore={onSwitchCore}
          onOpenUpdate={(core) => {
            dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })
            openModal('showUpdateModal')
          }}
        />
      )}
      {mountUpdate && <UpdateModal onInstalled={onInstalled} />}
      {mountImport && <ImportModal onGenerate={onGenerate} onAddToConfig={onAddToConfig} />}
      {mountTemplate && <TemplateModal onImport={onImportTemplate} />}
      {mountSettings && <SettingsModal />}
      {mountGeoScan && <GeoScanModal />}
    </>
  )
})

function AppContent() {
  const { dispatch, showToast } = useAppActions()
  const editorRef = useRef<MonacoEditorRef | null>(null)
  const configActionsRef = useRef<{ switchTab: (index: number) => void; getActiveIndex: () => number }>({
    switchTab: () => {},
    getActiveIndex: () => 0,
  })

  useEffect(() => {
    init()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    try {
      await loadSettings()
      const currentCore = await checkStatus()
      if (currentCore) await loadConfigs(currentCore)
      checkVersion()
    } catch {
      showToast('Ошибка инициализации', 'error')
    }
  }

  async function loadSettings() {
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
          timezone: data.log.timezone,
        },
      })
  }

  async function checkStatus() {
    const data = await apiCall<any>('GET', 'control')
    if (!data.success) return null
    const currentCore = data.currentCore || 'xray'
    dispatch({
      type: 'SET_CORE_INFO',
      currentCore,
      coreVersions: data.versions || {},
      availableCores: data.cores || [],
    })
    dispatch({ type: 'SET_SERVICE_STATUS', status: data.running ? 'running' : 'stopped' })
    return currentCore
  }

  async function checkVersion() {
    try {
      const data = await apiCall<any>('GET', 'version')
      if (data.success && data.version) {
        dispatch({
          type: 'SET_VERSION',
          version: data.version.replace(/^v/i, ''),
          isOutdatedUI: !!data.outdated?.ui,
        })
        if (data.show_toast?.ui) showToast({ title: 'Доступно обновление', body: 'Доступна новая версия XKeen UI' })
        if (data.show_toast?.core)
          showToast({ title: 'Доступно обновление', body: `Доступна новая версия ${capitalize(getAppState().currentCore)}` })
      }
    } catch {
      /* ignore */
    }
  }

  async function loadConfigs(core?: string, skipProxies = false): Promise<Config[]> {
    dispatch({ type: 'SET_CONFIGS_LOADING', loading: true })
    try {
      const result = await apiCall<any>('GET', core ? `configs?core=${core}` : 'configs')
      if (result.success && result.configs) {
        const configs: Config[] = result.configs.map((c: any) => ({ ...c, savedContent: c.content, isDirty: false }))
        dispatch({ type: 'SET_CONFIGS', configs })
        const yamlConfig = configs.find((c: any) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
        const port = yamlConfig?.content.match(/^external-controller:\s*[\w.-]+:(\d+)/m)?.[1] ?? null
        const secret = yamlConfig?.content.match(/^secret:\s*['"]?(.+?)['"]?\s*$/m)?.[1] ?? null
        dispatch({ type: 'SET_DASHBOARD_PORT', port, secret } as any)
        const appState = getAppState()
        const activeCores = core ?? appState.currentCore
        if (port && activeCores === 'mihomo' && !skipProxies && appState.serviceStatus !== 'pending') {
          fetchClashProxies(port, secret)
        }
        return configs
      } else {
        dispatch({ type: 'SET_CONFIGS_LOADING', loading: false })
        showToast('Не удалось загрузить конфигурации', 'error')
      }
    } catch (e: any) {
      dispatch({ type: 'SET_CONFIGS_LOADING', loading: false })
      showToast(`${e.message}`, 'error')
    }
    return []
  }

  async function switchCore(core: string) {
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
        coreVersions: data.versions,
        availableCores: data.cores,
      })
      dispatch({ type: 'SET_SERVICE_STATUS', status: data.running ? 'running' : 'stopped' })
      if (result.success && mihomoYamlEmpty) await loadConfigs(core)
      else if (result.success) syncClashApiPort()
    }
  }

  function generateConfig(uri: string) {
    const currentCore = getAppState().currentCore
    if (typeof (window as any).generateConfigForCore === 'function')
      return (window as any).generateConfigForCore(uri, currentCore, editorRef.current?.getValue() ?? '')
    throw new Error('Parser not loaded')
  }

  async function importTemplate(url: string) {
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
  }

  function addToConfig(generated: string, type: string, position: 'start' | 'end') {
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
          const obj = JSON.parse(stripJsonComments(appState.configs[targetIndex].content))
          if (!Array.isArray(obj.outbounds)) throw new Error()
        } catch {
          targetIndex = appState.configs.findIndex((cfg) => {
            try {
              return Array.isArray(JSON.parse(stripJsonComments(cfg.content)).outbounds)
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
      const monacoEditor = editorWrapper.getEditor()
      if (!monacoEditor) return
      const model = monacoEditor.getModel()
      if (!model) return
      const current = editorWrapper.getValue()
      const lineAtOffset = (text: string, offset: number) => text.slice(0, Math.min(offset, text.length)).split('\n').length
      const scrollToLine = (editor: any, line: number) => setTimeout(() => editor.revealLineInCenter(Math.max(1, line)), 100)
      const insertAtOffset = (offset: number, text: string, scrollLine?: number) => {
        const pos = model.getPositionAt(offset)
        monacoEditor.executeEdits('add-to-config', [
          {
            range: { startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column },
            text,
          },
        ])
        scrollToLine(monacoEditor, scrollLine ?? pos.lineNumber)
      }

      if (core === 'mihomo') {
        const marker = type === 'proxy' ? 'proxies:' : 'proxy-providers:'
        const markerIdx = current.indexOf(marker)
        if (markerIdx === -1) {
          insertAtOffset(current.length, `\n${marker}\n${generated}`, lineAtOffset(current, current.length) + 2)
          return
        }
        const markerLineEnd = current.indexOf('\n', markerIdx) + 1
        if (position === 'start') {
          insertAtOffset(markerLineEnd, generated, lineAtOffset(current, markerLineEnd))
        } else {
          const afterMarker = markerLineEnd
          const nextKeyMatch = current.slice(afterMarker).search(/^[a-zA-Z]/m)
          const insertOffset = nextKeyMatch === -1 ? current.length : afterMarker + nextKeyMatch
          insertAtOffset(insertOffset, generated + '\n', lineAtOffset(current, insertOffset) - 1)
        }
      } else {
        try {
          const obj = JSON.parse(stripJsonComments(current))
          if (position === 'start') obj.outbounds.unshift(JSON.parse(generated))
          else obj.outbounds.push(JSON.parse(generated))
          monacoEditor.executeEdits('add-to-config', [{ range: model.getFullModelRange(), text: JSON.stringify(obj, null, 2) }])
          scrollToLine(monacoEditor, position === 'start' ? 1 : model.getLineCount())
        } catch (e: any) {
          showToast(`Ошибка парсинга: ${e.message}`, 'error')
        }
      }
    }, 150)
  }

  const openModal = useCallback((modal: string) => dispatch({ type: 'SHOW_MODAL', modal: modal as any, show: true }), [dispatch])

  return (
    <div className="min-h-dvh flex flex-col bg-background">
      <main className="flex-1 flex flex-col">
        <div className="w-full max-w-7xl mx-auto flex-1 flex flex-col gap-3 py-3 px-3">
          <StatusBar
            onOpenCoreManage={() => openModal('showCoreManageModal')}
            onOpenSettings={() => openModal('showSettingsModal')}
            onRefreshStatus={() => void checkStatus()}
            onOpenUpdate={(core) => {
              dispatch({ type: 'SET_UPDATE_MODAL_CORE', core })
              openModal('showUpdateModal')
            }}
          />
          <ConfigPanel
            editorRef={editorRef}
            configActionsRef={configActionsRef}
            onOpenImport={() => openModal('showImportModal')}
            onOpenTemplate={() => openModal('showTemplateModal')}
            onOpenGeoScan={() => openModal('showGeoScanModal')}
          />
          <LogPanel />
        </div>
      </main>
      <Toast />
      <ModalManager
        onSwitchCore={switchCore}
        onInstalled={() => void checkStatus()}
        onGenerate={generateConfig}
        onAddToConfig={addToConfig}
        onImportTemplate={importTemplate}
        openModal={openModal}
      />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  )
}
