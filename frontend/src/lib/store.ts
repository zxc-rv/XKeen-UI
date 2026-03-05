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
  dashboardPort: null,
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
          return { dashboardPort: action.port }
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
        dashboardPort: s.dashboardPort,
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

// getConnections() для чтения без подписки (Selectors selectProxy callback)
export function getConnections(): Connection[] {
  return useStore.getState().connections
}

export function useConnectionsSync(dashboardPort: string | null) {
  const dispatch = useStore((s) => s.dispatch)

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
      return baseWsUrl + '&t=' + Date.now()
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
      if (touchHandler) document.removeEventListener('touchstart', touchHandler)
    }
  }, [dashboardPort, dispatch])
}

// ─── Provider (no-op wrapper for API compatibility) ────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
  return createElement(Fragment, null, children)
}
