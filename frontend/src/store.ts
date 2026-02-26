import {
  createContext,
  useContext,
  useReducer,
  useCallback,
  createElement,
  type ReactNode,
} from "react";
import type { AppState, AppAction, AppSettings } from "./types";

const initialSettings: AppSettings = {
  autoApply: false,
  guiRouting: false,
  guiLog: false,
  autoCheckUI: true,
  autoCheckCore: true,
  backupCore: true,
  githubProxies: [],
  timezone: 0,
};

const initialState: AppState = {
  serviceStatus: "loading",
  pendingText: "",
  currentCore: "",
  coreVersions: { xray: "", mihomo: "" },
  availableCores: [],
  configs: [],
  activeConfigIndex: -1,
  isConfigsLoading: true,
  settings: initialSettings,
  version: "",
  isOutdatedUI: false,
  dashboardPort: null,
  showDirtyModal: false,
  showCoreManageModal: false,
  showUpdateModal: false,
  showImportModal: false,
  showTemplateModal: false,
  showSettingsModal: false,
  showCommentsWarningModal: false,
  showGeoScanModal: false,
  pendingSwitchIndex: -1,
  updateModalCore: "",
  toasts: [],
  pendingSaveAction: null,
};

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_SERVICE_STATUS":
      return {
        ...state,
        serviceStatus: action.status,
        pendingText: action.pendingText ?? state.pendingText,
      };

    case "SET_CORE_INFO":
      return {
        ...state,
        currentCore: action.currentCore,
        coreVersions: action.coreVersions,
        availableCores: action.availableCores,
      };

    case "SET_CONFIGS_LOADING":
      return { ...state, isConfigsLoading: action.loading };

    case "SET_CONFIGS":
      return { ...state, configs: action.configs, isConfigsLoading: false };

    case "SET_ACTIVE_CONFIG":
      return { ...state, activeConfigIndex: action.index };

    case "UPDATE_CONFIG_DIRTY": {
      const configs = [...state.configs];
      configs[action.index] = {
        ...configs[action.index],
        isDirty: action.isDirty,
        ...(action.content !== undefined ? { content: action.content } : {}),
      };
      return { ...state, configs };
    }

    case "SAVE_CONFIG": {
      const configs = [...state.configs];
      configs[action.index] = {
        ...configs[action.index],
        content: action.content,
        savedContent: action.content,
        isDirty: false,
      };
      return { ...state, configs };
    }

    case "SET_SETTINGS":
      return { ...state, settings: { ...state.settings, ...action.settings } };

    case "SET_VERSION":
      return {
        ...state,
        version: action.version,
        isOutdatedUI: action.isOutdatedUI,
      };

    case "SET_DASHBOARD_PORT":
      return { ...state, dashboardPort: action.port };

    case "SHOW_MODAL":
      return { ...state, [action.modal]: action.show };

    case "SET_PENDING_SWITCH":
      return { ...state, pendingSwitchIndex: action.index };

    case "SET_UPDATE_MODAL_CORE":
      return { ...state, updateModalCore: action.core };

    case "ADD_TOAST":
      return { ...state, toasts: [action.toast, ...state.toasts] };

    case "REMOVE_TOAST":
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.id),
      };

    case "SET_PENDING_SAVE_ACTION":
      return { ...state, pendingSaveAction: action.action };

    default:
      return state;
  }
}

interface AppContextValue {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  showToast: (
    message: string | { title: string; body: string },
    type?: "success" | "error",
  ) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const showToast = useCallback(
    (
      message: string | { title: string; body: string },
      type: "success" | "error" = "success",
    ) => {
      const id = Math.random().toString(36).slice(2);
      const toast =
        typeof message === "string"
          ? {
              id,
              title: type === "error" ? "Ошибка" : "Успех",
              body: message,
              type,
            }
          : { id, title: message.title, body: message.body, type };
      dispatch({ type: "ADD_TOAST", toast });
      setTimeout(() => dispatch({ type: "REMOVE_TOAST", id }), 5000);
    },
    [],
  );

  return createElement(
    AppContext.Provider,
    { value: { state, dispatch, showToast } },
    children,
  );
}

export function useAppContext() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within AppProvider");
  return ctx;
}
