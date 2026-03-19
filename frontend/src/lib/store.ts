import { useEffect } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { clashFetch } from './api'
import type { AppAction, AppSettings, AppState, Connection, ToastMessage } from './types'
import { parseClashApiCredentials } from './utils'
import { clashWsUrl } from './websocket'

// ─── Zustand store ─────────────────────────────────────────────────────────────

const initialSettings: AppSettings = {
  autoApply: false,
  guiRouting: false,
  guiLog: false,
  autoCheckUI: true,
  autoCheckCore: true,
  backupCore: true,
  githubProxies: [],
  timezone: 0,
  authEnabled: false,
}

const initialState: AppState = {
  serviceStatus: 'loading',
  pendingText: '',
  currentCore: '',
  coreVersions: { xray: '', mihomo: '' },
  availableCores: [],
  configs: [],
  isConfigsLoading: true,
  settings: initialSettings,
  version: '',
  isOutdatedUI: false,
  clashApiPort: null,
  clashApiSecret: null,
  clashApiUnix: null,
  connections: [],
  wsConnected: false,
  showDirtyModal: false,
  showCoreManageModal: false,
  showUpdateModal: false,
  showImportModal: false,
  showTemplateModal: false,
  showSettingsModal: false,
  showCommentsWarningModal: false,
  showGeoScanModal: false,
  updateModalCore: '',
  toasts: [],
  pendingSaveAction: null,
}

interface StoreState extends AppState {
  dispatch: (action: AppAction) => void
}

const useStore = create<StoreState>((set) => ({
  ...initialState,

  dispatch: (action: AppAction) =>
    set((state) => {
      switch (action.type) {
        case 'SET_SERVICE_STATUS':
          return { serviceStatus: action.status, pendingText: action.pendingText ?? state.pendingText }
        case 'SET_CORE_INFO':
          return { currentCore: action.currentCore, coreVersions: action.coreVersions, availableCores: action.availableCores }
        case 'SET_CONFIGS_LOADING':
          return { isConfigsLoading: action.loading }
        case 'SET_CONFIGS':
          return { configs: action.configs, isConfigsLoading: false }
        case 'UPDATE_CONFIG_DIRTY': {
          const prevConfig = state.configs[action.index]
          if (!prevConfig) return {}
          const nextContent = action.content !== undefined ? action.content : prevConfig.content
          if (prevConfig.isDirty === action.isDirty && prevConfig.content === nextContent) return {}
          const configs = [...state.configs]
          configs[action.index] = {
            ...prevConfig,
            isDirty: action.isDirty,
            ...(action.content !== undefined && { content: action.content }),
          }
          return { configs }
        }
        case 'SAVE_CONFIG': {
          const prevConfig = state.configs[action.index]
          if (!prevConfig || (prevConfig.content === action.content && prevConfig.savedContent === action.content && !prevConfig.isDirty))
            return {}
          const configs = [...state.configs]
          configs[action.index] = { ...prevConfig, content: action.content, savedContent: action.content, isDirty: false }
          return { configs }
        }
        case 'SET_SETTINGS':
          return { settings: { ...state.settings, ...action.settings } }
        case 'SET_VERSION':
          return { version: action.version, isOutdatedUI: action.isOutdatedUI }
        case 'SET_DASHBOARD_PORT':
          return {
            clashApiPort: action.port,
            ...(action.secret !== undefined && { clashApiSecret: action.secret }),
            ...(action.unix !== undefined && { clashApiUnix: action.unix }),
          }
        case 'SET_CONNECTIONS':
          return { connections: action.connections, ...(action.wsConnected !== undefined && { wsConnected: action.wsConnected }) }
        case 'SET_WS_CONNECTED':
          return { wsConnected: action.connected }
        case 'SHOW_MODAL':
          return { [action.modal]: action.show }
        case 'SET_UPDATE_MODAL_CORE':
          return { updateModalCore: action.core }
        case 'ADD_TOAST':
          return { toasts: [action.toast, ...state.toasts] }
        case 'REMOVE_TOAST':
          return { toasts: state.toasts.filter((t) => t.id !== action.id) }
        case 'SET_PENDING_SAVE_ACTION':
          return { pendingSaveAction: action.action }
        default:
          return {}
      }
    }),
}))

// ─── Types ─────────────────────────────────────────────────────────────────────

type ShowToastFn = (message: string | { title: string; body: string; persistent?: boolean }, type?: 'success' | 'error') => void

type CoreState = Omit<
  AppState,
  | 'showDirtyModal'
  | 'showCoreManageModal'
  | 'showUpdateModal'
  | 'showImportModal'
  | 'showTemplateModal'
  | 'showSettingsModal'
  | 'showCommentsWarningModal'
  | 'showGeoScanModal'
  | 'updateModalCore'
  | 'pendingSaveAction'
  | 'toasts'
  | 'connections'
  | 'wsConnected'
  | 'settings'
  | 'configs'
>

type ModalState = Pick<
  AppState,
  | 'showDirtyModal'
  | 'showCoreManageModal'
  | 'showUpdateModal'
  | 'showImportModal'
  | 'showTemplateModal'
  | 'showSettingsModal'
  | 'showCommentsWarningModal'
  | 'showGeoScanModal'
  | 'updateModalCore'
  | 'pendingSaveAction'
>

type CoreStateWithSettings = CoreState & Pick<AppState, 'settings'>
type CoreStateWithConfigs = CoreState & Pick<AppState, 'configs'>
type CoreStateWithConfigsAndSettings = CoreState & Pick<AppState, 'configs' | 'settings'>

const selectCoreState = (s: StoreState): CoreState => ({
  serviceStatus: s.serviceStatus,
  pendingText: s.pendingText,
  currentCore: s.currentCore,
  coreVersions: s.coreVersions,
  availableCores: s.availableCores,
  isConfigsLoading: s.isConfigsLoading,
  version: s.version,
  isOutdatedUI: s.isOutdatedUI,
  clashApiPort: s.clashApiPort,
  clashApiSecret: s.clashApiSecret,
  clashApiUnix: s.clashApiUnix,
})

const selectCoreStateWithSettings = (s: StoreState): CoreStateWithSettings => ({ ...selectCoreState(s), settings: s.settings })
const selectCoreStateWithConfigs = (s: StoreState): CoreStateWithConfigs => ({ ...selectCoreState(s), configs: s.configs })
const selectCoreStateWithConfigsAndSettings = (s: StoreState): CoreStateWithConfigsAndSettings => ({
  ...selectCoreState(s),
  configs: s.configs,
  settings: s.settings,
})

// ─── Hooks & Utilities ─────────────────────────────────────────────────────────

export function showToast(message: string | { title: string; body: string; persistent?: boolean }, type: 'success' | 'error' = 'success') {
  const dispatch = useStore.getState().dispatch
  const id = Math.random().toString(36).slice(2)
  const toast: ToastMessage =
    typeof message === 'string'
      ? { id, title: type === 'error' ? 'Ошибка' : 'Успех', body: message, type }
      : { id, title: message.title, body: message.body, type, ...(message.persistent && { persistent: true }) }

  dispatch({ type: 'ADD_TOAST', toast })
  if (!toast.persistent) setTimeout(() => dispatch({ type: 'REMOVE_TOAST', id }), 5000)
}

export function useAppContext(): { state: CoreState; dispatch: (action: AppAction) => void; showToast: ShowToastFn }
export function useAppContext(options: { includeConfigs: true }): {
  state: CoreStateWithConfigs
  dispatch: (action: AppAction) => void
  showToast: ShowToastFn
}
export function useAppContext(options: { includeSettings: true }): {
  state: CoreStateWithSettings
  dispatch: (action: AppAction) => void
  showToast: ShowToastFn
}
export function useAppContext(options: { includeConfigs: true; includeSettings: true }): {
  state: CoreStateWithConfigsAndSettings
  dispatch: (action: AppAction) => void
  showToast: ShowToastFn
}
export function useAppContext(options?: { includeSettings?: boolean; includeConfigs?: boolean }) {
  const selector = options?.includeConfigs
    ? options?.includeSettings
      ? selectCoreStateWithConfigsAndSettings
      : selectCoreStateWithConfigs
    : options?.includeSettings
      ? selectCoreStateWithSettings
      : selectCoreState

  return { state: useStore(useShallow(selector)), dispatch: useStore((s) => s.dispatch), showToast }
}

export function useAppActions() {
  return { dispatch: useStore((s) => s.dispatch), showToast }
}

export function useCoreRuntimeState() {
  return useStore(useShallow((s) => ({ serviceStatus: s.serviceStatus, currentCore: s.currentCore })))
}

export const getAppState = () => useStore.getState()

export function useModalContext() {
  const modals = useStore(
    useShallow(
      (s): ModalState => ({
        showDirtyModal: s.showDirtyModal,
        showCoreManageModal: s.showCoreManageModal,
        showUpdateModal: s.showUpdateModal,
        showImportModal: s.showImportModal,
        showTemplateModal: s.showTemplateModal,
        showSettingsModal: s.showSettingsModal,
        showCommentsWarningModal: s.showCommentsWarningModal,
        showGeoScanModal: s.showGeoScanModal,
        updateModalCore: s.updateModalCore,
        pendingSaveAction: s.pendingSaveAction,
      })
    )
  )
  return { modals, dispatch: useStore((s) => s.dispatch) }
}

export function useSettings<T>(selector: (settings: AppSettings) => T): T {
  return useStore((s) => selector(s.settings))
}

// ─── Connections hook — WS sync ────────────────────────────────────────────────

export const useToasts = () => useStore((s) => s.toasts)
export const useWsConnected = () => useStore((s) => s.wsConnected)
export const getConnections = (): Connection[] => useStore.getState().connections

export function subscribeConnections(callback: (connections: Connection[]) => void): () => void {
  let prev = useStore.getState().connections
  return useStore.subscribe((s) => {
    if (s.connections !== prev) {
      prev = s.connections
      callback(s.connections)
    }
  })
}

export function useConnectionsSync(
  clashApiPort: string | null,
  clashApiSecret?: string | null,
  serviceStatus?: string,
  clashApiUnix?: string | null
) {
  const dispatch = useStore((s) => s.dispatch)

  useEffect(() => {
    if ((!clashApiPort && !clashApiUnix) || serviceStatus !== 'running') return

    const wsUrl = clashWsUrl(clashApiPort ?? '', 'connections', clashApiSecret, clashApiUnix)
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let isActive = true
    let retryCount = 0

    const cleanup = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) {
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
        ws = null
      }
    }

    const connect = () => {
      if (!isActive || document.visibilityState !== 'visible') return
      cleanup()
      ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        dispatch({ type: 'SET_WS_CONNECTED', connected: true })
        retryCount = 0
      }
      ws.onerror = () => ws?.close()
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (Array.isArray(data.connections)) dispatch({ type: 'SET_CONNECTIONS', connections: data.connections })
        } catch {
          /* ignore */
        }
      }

      ws.onclose = () => {
        dispatch({ type: 'SET_WS_CONNECTED', connected: false })
        if (isActive && document.visibilityState === 'visible' && retryCount < 12) {
          retryCount++
          reconnectTimer = setTimeout(connect, Math.min(800 * Math.pow(1.4, retryCount), 12000))
        }
      }
    }

    const isIOSSafari =
      /iP(ad|od|hone)/i.test(navigator.userAgent) && /Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS/i.test(navigator.userAgent)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && (!ws || ws.readyState !== WebSocket.OPEN)) {
        retryCount = 0
        connect()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    setTimeout(connect, 200)

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
      dispatch({ type: 'SET_CONNECTIONS', connections: [], wsConnected: false })
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (touchHandler) document.removeEventListener('touchstart', touchHandler)
    }
  }, [clashApiPort, clashApiSecret, clashApiUnix, dispatch, serviceStatus])
}

// ─── Shared proxies store ───────────────────────────────────────────────────────

interface ProxiesStore {
  proxies: Record<string, any>
  testingAll: Record<string, boolean>
  testingSingle: Record<string, boolean>
  loading: boolean
  error: boolean
}

export const useProxiesStore = create<ProxiesStore>(() => ({
  proxies: {},
  testingAll: {},
  testingSingle: {},
  loading: false,
  error: false,
}))

// ─── Кеш иконок ────────────────────────────────────────────────────────

const iconCache = new Map<string, string>()
const fetchingIcons = new Set<string>()

async function preloadIcons(urls: string[]) {
  let updated = false
  await Promise.allSettled(
    urls.map(async (url) => {
      if (fetchingIcons.has(url) || iconCache.has(url)) return
      fetchingIcons.add(url)
      try {
        const res = await fetch(url)
        if (res.ok) {
          iconCache.set(url, URL.createObjectURL(await res.blob()))
          updated = true
        }
      } catch {
        /* ignore */
      } finally {
        fetchingIcons.delete(url)
      }
    })
  )

  if (updated) {
    useProxiesStore.setState((state) => {
      const nextProxies = { ...state.proxies }
      let hasChanges = false
      for (const key in nextProxies) {
        const p = nextProxies[key] as any
        if (p.icon && iconCache.has(p.icon)) {
          nextProxies[key] = { ...p, icon: iconCache.get(p.icon) }
          hasChanges = true
        }
      }
      return hasChanges ? { proxies: nextProxies } : state
    })
  }
}

export async function fetchClashProxies(port: string, secret?: string | null, silent = false, unix?: string | null): Promise<void> {
  if (!silent) useProxiesStore.setState({ loading: true, error: false })
  try {
    const data = await clashFetch<{ proxies?: Record<string, unknown> }>(port, 'proxies', { secret, unix })
    if (data.proxies) {
      const urlsToFetch = new Set<string>()

      for (const key in data.proxies) {
        const p = data.proxies[key] as any
        if (p.icon) {
          if (iconCache.has(p.icon)) p.icon = iconCache.get(p.icon)
          else if (typeof p.icon === 'string' && !p.icon.startsWith('blob:')) urlsToFetch.add(p.icon)
        }
      }

      useProxiesStore.setState({ proxies: data.proxies, ...(!silent && { loading: false }) })
      if (urlsToFetch.size > 0) preloadIcons(Array.from(urlsToFetch))
    } else if (!silent) {
      useProxiesStore.setState({ loading: false, error: true })
    }
  } catch {
    if (!silent) useProxiesStore.setState({ loading: false, error: true })
  }
}

export function syncClashApiPort(delayMs = 0): void {
  const { configs, currentCore, dispatch } = useStore.getState()
  const yamlConfig = configs.find((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
  const { port, secret, unix } = yamlConfig ? parseClashApiCredentials(yamlConfig.content) : { port: null, secret: null, unix: null }

  dispatch({ type: 'SET_DASHBOARD_PORT', port, secret, unix } as any)
  if ((port || unix) && currentCore === 'mihomo' && useStore.getState().serviceStatus === 'running') {
    const fetchFn = () => fetchClashProxies(port ?? '', secret, true, unix)
    if (delayMs > 0) setTimeout(fetchFn, delayMs)
    else fetchFn()
  }
}

// ─── Global tick for timeAgo refresh (every 1s) ────────────────────────────────

export const useNowStore = create<{ tick: number }>(() => ({ tick: 0 }))
setInterval(() => useNowStore.setState((s) => ({ tick: s.tick + 1 })), 1000)
