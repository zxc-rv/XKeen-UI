import { apiCall, fanOutRouters, type FanOutResult } from './api'
import { LOCAL_ROUTER_ID, type RemoteRouter, routerId, routerLabel } from './routers'
import { getBaseUrlForId, useRoutersStore } from './routers-store'

export async function persistRouters(routers: RemoteRouter[]): Promise<{ success: boolean; error?: string }> {
  return apiCall<{ success: boolean; error?: string }>('PATCH', 'settings', { plugins: { routers } }, { baseUrl: null })
}

export async function saveRouters(routers: RemoteRouter[]): Promise<void> {
  const result = await persistRouters(routers)
  if (!result.success) throw new Error(result.error || 'Не удалось сохранить список роутеров')
  useRoutersStore.getState().setRouters(routers)
}

export function applyRoutersFromSettings(routers: RemoteRouter[]): RemoteRouter[] {
  useRoutersStore.getState().setRouters(routers)
  return routers
}

export async function pingRouterOnline(id: string): Promise<boolean> {
  try {
    const data = await apiCall<{ success?: boolean }>('GET', 'version', undefined, {
      baseUrl: getBaseUrlForId(id),
      timeoutMs: 5000,
    })
    return !!data?.success
  } catch {
    return false
  }
}

export async function refreshAllOnline(): Promise<void> {
  const { routers, setOnline } = useRoutersStore.getState()
  const ids = [LOCAL_ROUTER_ID, ...routers.map(routerId)]
  await Promise.all(
    ids.map(async (id) => {
      const online = await pingRouterOnline(id)
      setOnline(id, online)
    })
  )
}

export function targetLabel(id: string): string {
  if (id === LOCAL_ROUTER_ID) return 'Этот роутер'
  const router = useRoutersStore.getState().routers.find((r) => routerId(r) === id)
  return router ? routerLabel(router) : id
}

export async function runMassTask(
  targetIds: string[],
  task: (id: string, baseUrl: string | null) => Promise<void>
): Promise<FanOutResult[]> {
  const { resetCommandStatuses, setCommandStatus, getBaseUrlForId: getBase } = useRoutersStore.getState()
  resetCommandStatuses()
  for (const id of targetIds) setCommandStatus(id, { status: 'pending' })

  const results = await fanOutRouters(targetIds, task, getBase)

  for (const result of results) {
    setCommandStatus(result.id, {
      status: result.ok ? 'success' : 'error',
      message: result.error,
    })
  }
  return results
}

export function summarizeFanOut(results: FanOutResult[]): { ok: number; fail: number; body: string } {
  const ok = results.filter((r) => r.ok).length
  const fail = results.length - ok
  if (results.length <= 1) {
    return { ok, fail, body: fail ? results[0]?.error || 'ошибка' : '' }
  }
  const lines = results.map((r) => `${targetLabel(r.id)}: ${r.ok ? 'OK' : r.error || 'ошибка'}`)
  return { ok, fail, body: lines.join('; ') }
}
