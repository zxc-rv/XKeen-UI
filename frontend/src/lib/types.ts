export interface Config {
  file: string
  content: string
  savedContent: string
  isDirty: boolean
}

export interface AppSettings {
  autoApply: boolean
  guiRouting: boolean
  guiLog: boolean
  autoCheckUI: boolean
  autoCheckCore: boolean
  backupCore: boolean
  githubProxies: string[]
  timezone: number
}

export type ServiceStatus = 'loading' | 'running' | 'stopped' | 'pending'

export interface Release {
  version: string
  name: string
  published_at: string
  is_prerelease: boolean
  body: string
}

export interface ToastMessage {
  id: string
  title: string
  body: string
  type: 'success' | 'error'
}

export interface ConnectionMetadata {
  network: string
  type: string
  sourceIP: string
  destinationIP: string
  sourcePort: string
  destinationPort: string
  inboundIP: string
  inboundPort: string
  inboundName: string
  host: string
  dnsMode: string
  uid: number
  process: string
  processPath: string
  remoteDestination: string
  sniffHost: string
}

export interface Connection {
  id: string
  metadata: ConnectionMetadata
  upload: number
  download: number
  start: string
  chains: string[]
  providerChains: string[]
  rule: string
  rulePayload: string
}

export interface AppState {
  serviceStatus: ServiceStatus
  pendingText: string
  currentCore: string
  coreVersions: { xray: string; mihomo: string }
  availableCores: string[]
  configs: Config[]
  isConfigsLoading: boolean
  settings: AppSettings
  version: string
  isOutdatedUI: boolean
  clashApiPort: string | null
  clashApiSecret: string | null
  connections: Connection[]
  wsConnected: boolean
  showDirtyModal: boolean
  showCoreManageModal: boolean
  showUpdateModal: boolean
  showImportModal: boolean
  showTemplateModal: boolean
  showSettingsModal: boolean
  showCommentsWarningModal: boolean
  showGeoScanModal: boolean
  updateModalCore: string
  toasts: ToastMessage[]
  pendingSaveAction: (() => void) | null
}

export type AppAction =
  | { type: 'SET_SERVICE_STATUS'; status: ServiceStatus; pendingText?: string }
  | {
      type: 'SET_CORE_INFO'
      currentCore: string
      coreVersions: { xray: string; mihomo: string }
      availableCores: string[]
    }
  | { type: 'SET_CONFIGS_LOADING'; loading: boolean }
  | { type: 'SET_CONFIGS'; configs: Config[] }
  | { type: 'UPDATE_CONFIG_DIRTY'; index: number; isDirty: boolean; content?: string }
  | { type: 'SAVE_CONFIG'; index: number; content: string }
  | { type: 'SET_SETTINGS'; settings: Partial<AppSettings> }
  | { type: 'SET_VERSION'; version: string; isOutdatedUI: boolean }
  | { type: 'SET_DASHBOARD_PORT'; port: string | null; secret?: string | null }
  | { type: 'SET_CONNECTIONS'; connections: Connection[]; wsConnected?: boolean }
  | { type: 'SET_WS_CONNECTED'; connected: boolean }
  | {
      type: 'SHOW_MODAL'
      modal: keyof Pick<
        AppState,
        | 'showDirtyModal'
        | 'showCoreManageModal'
        | 'showUpdateModal'
        | 'showImportModal'
        | 'showTemplateModal'
        | 'showSettingsModal'
        | 'showCommentsWarningModal'
        | 'showGeoScanModal'
      >
      show: boolean
    }
  | { type: 'SET_UPDATE_MODAL_CORE'; core: string }
  | { type: 'ADD_TOAST'; toast: ToastMessage }
  | { type: 'REMOVE_TOAST'; id: string }
  | { type: 'SET_PENDING_SAVE_ACTION'; action: (() => void) | null }
