import { createElement, Fragment, useCallback, useEffect, type ReactNode } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { AppState, AppAction, AppSettings, ToastMessage, Connection } from './types'

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
          const configs = [...state.configs]
          configs[action.index] = {
            ...configs[action.index],
            isDirty: action.isDirty,
            ...(action.content !== undefined ? { content: action.content } : {}),
          }
          return { configs }
        }
        case 'SAVE_CONFIG': {
          const configs = [...state.configs]
          configs[action.index] = {
            ...configs[action.index],
            content: action.content,
            savedContent: action.content,
            isDirty: false,
          }
          return { configs }
        }
        case 'SET_SETTINGS':
          return { settings: { ...state.settings, ...action.settings } }
        case 'SET_VERSION':
          return { version: action.version, isOutdatedUI: action.isOutdatedUI }
        case 'SET_DASHBOARD_PORT':
          return { clashApiPort: action.port, ...(action.secret !== undefined ? { clashApiSecret: action.secret } : {}) }
        case 'SET_CONNECTIONS':
          return {
            connections: action.connections,
            ...(action.wsConnected !== undefined ? { wsConnected: action.wsConnected } : {}),
          }
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

type ShowToastFn = (message: string | { title: string; body: string }, type?: 'success' | 'error') => void

export type CoreState = Omit<
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
>

export type ModalState = Pick<
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

// ─── Hooks ─────────────────────────────────────────────────────────────────────

function useShowToast(): ShowToastFn {
  const dispatch = useStore((s) => s.dispatch)
  return useCallback<ShowToastFn>(
    (message, type = 'success') => {
      const id = Math.random().toString(36).slice(2)
      const toast: ToastMessage =
        typeof message === 'string'
          ? { id, title: type === 'error' ? 'Ошибка' : 'Успех', body: message, type }
          : { id, title: message.title, body: message.body, type }
      dispatch({ type: 'ADD_TOAST', toast })
      setTimeout(() => dispatch({ type: 'REMOVE_TOAST', id }), 5000)
    },
    [dispatch]
  )
}

export function useAppContext() {
  const state = useStore(
    useShallow(
      (s): CoreState => ({
        serviceStatus: s.serviceStatus,
        pendingText: s.pendingText,
        currentCore: s.currentCore,
        coreVersions: s.coreVersions,
        availableCores: s.availableCores,
        configs: s.configs,
        isConfigsLoading: s.isConfigsLoading,
        settings: s.settings,
        version: s.version,
        isOutdatedUI: s.isOutdatedUI,
        clashApiPort: s.clashApiPort,
        clashApiSecret: s.clashApiSecret,
      })
    )
  )
  const dispatch = useStore((s) => s.dispatch)
  const showToast = useShowToast()
  return { state, dispatch, showToast }
}

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
  const dispatch = useStore((s) => s.dispatch)
  return { modals, dispatch }
}

export function useToastContext() {
  const toasts = useStore((s) => s.toasts)
  const showToast = useShowToast()
  return { toasts, showToast }
}

// ─── Connections hook — WS sync ────────────────────────────────────────────────

export function useConnections() {
  return useStore(useShallow((s) => ({ connections: s.connections, connected: s.wsConnected })))
}

export function useWsConnected() {
  return useStore((s) => s.wsConnected)
}

export function useConnectionsCount() {
  return useStore((s) => s.connections.length)
}

export function subscribeConnections(callback: (connections: Connection[]) => void): () => void {
  let prev = useStore.getState().connections
  return useStore.subscribe((s) => {
    if (s.connections !== prev) {
      prev = s.connections
      callback(s.connections)
    }
  })
}

export function getConnections(): Connection[] {
  return useStore.getState().connections
}

export function useConnectionsSync(clashApiPort: string | null, clashApiSecret?: string | null) {
  const dispatch = useStore((s) => s.dispatch)

  useEffect(() => {
    if (!clashApiPort) return

    const wsUrl = `ws://${location.hostname}:${clashApiPort}/connections?interval=1000${clashApiSecret ? `&token=${clashApiSecret}` : ''}`

    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let isActive = true
    let retryCount = 0

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
      ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        dispatch({ type: 'SET_WS_CONNECTED', connected: true })
        retryCount = 0
      }

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (Array.isArray(data.connections)) dispatch({ type: 'SET_CONNECTIONS', connections: data.connections })
        } catch {}
      }

      ws.onerror = () => ws?.close()

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
      dispatch({ type: 'SET_CONNECTIONS', connections: [], wsConnected: false })
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (touchHandler) document.removeEventListener('touchstart', touchHandler)
    }
  }, [clashApiPort, clashApiSecret, dispatch])
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

export async function refreshClashProxies(baseUrl: string, authHeaders?: HeadersInit): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/proxies`, { headers: authHeaders })
    const data = await res.json()
    if (data.proxies) useProxiesStore.setState({ proxies: data.proxies })
  } catch {}
}

export async function fetchClashProxies(baseUrl: string, authHeaders?: HeadersInit): Promise<void> {
  useProxiesStore.setState({ loading: true, error: false })
  try {
    const res = await fetch(`${baseUrl}/proxies`, { headers: authHeaders })
    const data = await res.json()
    if (data.proxies) useProxiesStore.setState({ proxies: data.proxies, loading: false })
    else useProxiesStore.setState({ loading: false, error: true })
  } catch {
    useProxiesStore.setState({ loading: false, error: true })
  }
}

export function resetClashProxies(): void {
  useProxiesStore.setState({ proxies: {}, testingAll: {}, testingSingle: {}, loading: false, error: false })
}

export function syncClashApiPort(): void {
  const { configs, currentCore, dispatch } = useStore.getState()
  const yamlConfig = configs.find((c) => c.file.endsWith('/config.yaml') || c.file === 'config.yaml')
  const port = yamlConfig?.content.match(/^external-controller:\s*[\w.-]+:(\d+)/m)?.[1] ?? null
  const secret = yamlConfig?.content.match(/^secret:\s*['"]?(.+?)['"]?\s*$/m)?.[1] ?? null
  dispatch({ type: 'SET_DASHBOARD_PORT', port, secret } as any)
  if (port && currentCore === 'mihomo') {
    const authHeaders = secret ? { Authorization: `Bearer ${secret}` } : undefined
    fetchClashProxies(`http://${location.hostname}:${port}`, authHeaders)
  }
}

// ─── Global tick for timeAgo refresh (every 1s) ────────────────────────────────

export const useNowStore = create<{ tick: number }>(() => ({ tick: 0 }))
setInterval(() => useNowStore.setState((s) => ({ tick: s.tick + 1 })), 1000)

// ─── Provider (no-op wrapper for API compatibility) ────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
  return createElement(Fragment, null, children)
}
