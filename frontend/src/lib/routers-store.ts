import { create } from 'zustand'
import { LOCAL_ROUTER_ID, type RemoteRouter, type RouterCommandState, findRouter, routerBaseUrl, routerId } from './routers'

interface RoutersState {
  activeId: string
  routers: RemoteRouter[]
  applyTargets: string[]
  online: Record<string, boolean | null>
  commandStatus: Record<string, RouterCommandState>
  isSwitching: boolean
  setRouters: (routers: RemoteRouter[]) => void
  setActiveId: (id: string) => void
  setSwitching: (switching: boolean) => void
  toggleApplyTarget: (id: string) => void
  setApplyTargets: (ids: string[]) => void
  setOnline: (id: string, online: boolean | null) => void
  setCommandStatus: (id: string, status: RouterCommandState) => void
  resetCommandStatuses: () => void
  getActiveBaseUrl: () => string | null
  getBaseUrlForId: (id: string) => string | null
}

export const useRoutersStore = create<RoutersState>((set, get) => ({
  activeId: LOCAL_ROUTER_ID,
  routers: [],
  applyTargets: [LOCAL_ROUTER_ID],
  online: { [LOCAL_ROUTER_ID]: true },
  commandStatus: {},
  isSwitching: false,

  setRouters: (routers) =>
    set((state) => {
      const ids = new Set(routers.map(routerId))
      const activeId = state.activeId === LOCAL_ROUTER_ID || ids.has(state.activeId) ? state.activeId : LOCAL_ROUTER_ID
      if (activeId === LOCAL_ROUTER_ID) {
        const applyTargets = state.applyTargets.filter((id) => id === LOCAL_ROUTER_ID || ids.has(id))
        if (applyTargets.length === 0) applyTargets.push(LOCAL_ROUTER_ID)
        return { routers, activeId, applyTargets }
      }
      return { routers, activeId, applyTargets: [activeId] }
    }),

  setActiveId: (id) =>
    set({
      activeId: id,
      applyTargets: id === LOCAL_ROUTER_ID ? [LOCAL_ROUTER_ID] : [id],
    }),

  setSwitching: (isSwitching) => set({ isSwitching }),

  toggleApplyTarget: (id) =>
    set((state) => {
      const has = state.applyTargets.includes(id)
      return {
        applyTargets: has ? state.applyTargets.filter((t) => t !== id) : [...state.applyTargets, id],
      }
    }),

  setApplyTargets: (ids) => set({ applyTargets: ids }),

  setOnline: (id, online) => set((state) => ({ online: { ...state.online, [id]: online } })),

  setCommandStatus: (id, status) => set((state) => ({ commandStatus: { ...state.commandStatus, [id]: status } })),

  resetCommandStatuses: () => set({ commandStatus: {} }),

  getActiveBaseUrl: () => {
    const { activeId, routers } = get()
    if (activeId === LOCAL_ROUTER_ID) return null
    const router = findRouter(routers, activeId)
    return router ? routerBaseUrl(router.host, router.port) : null
  },

  getBaseUrlForId: (id) => {
    if (id === LOCAL_ROUTER_ID) return null
    const router = findRouter(get().routers, id)
    return router ? routerBaseUrl(router.host, router.port) : null
  },
}))

export function getActiveBaseUrl(): string | null {
  return useRoutersStore.getState().getActiveBaseUrl()
}

export function getBaseUrlForId(id: string): string | null {
  return useRoutersStore.getState().getBaseUrlForId(id)
}

export function isLocalActive(): boolean {
  return useRoutersStore.getState().activeId === LOCAL_ROUTER_ID
}
