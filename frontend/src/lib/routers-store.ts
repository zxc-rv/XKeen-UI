import { create } from 'zustand'
import { LOCAL_ROUTER_ID, type RemoteRouter, type RouterCommandState, findRouter, routerBaseUrl, routerId } from './routers'

interface RoutersState {
  routers: RemoteRouter[]
  applyTargets: string[]
  online: Record<string, boolean | null>
  commandStatus: Record<string, RouterCommandState>
  setRouters: (routers: RemoteRouter[]) => void
  toggleApplyTarget: (id: string) => void
  setApplyTargets: (ids: string[]) => void
  setOnline: (id: string, online: boolean | null) => void
  setCommandStatus: (id: string, status: RouterCommandState) => void
  resetCommandStatuses: () => void
  getBaseUrlForId: (id: string) => string | null
}

export const useRoutersStore = create<RoutersState>((set, get) => ({
  routers: [],
  applyTargets: [LOCAL_ROUTER_ID],
  online: { [LOCAL_ROUTER_ID]: true },
  commandStatus: {},

  setRouters: (routers) =>
    set((state) => {
      const ids = new Set(routers.map(routerId))
      const applyTargets = state.applyTargets.filter((id) => id === LOCAL_ROUTER_ID || ids.has(id))
      if (applyTargets.length === 0) applyTargets.push(LOCAL_ROUTER_ID)
      return { routers, applyTargets }
    }),

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

  getBaseUrlForId: (id) => {
    if (id === LOCAL_ROUTER_ID) return null
    const router = findRouter(get().routers, id)
    return router ? routerBaseUrl(router.host, router.port) : null
  },
}))

export function getBaseUrlForId(id: string): string | null {
  return useRoutersStore.getState().getBaseUrlForId(id)
}
