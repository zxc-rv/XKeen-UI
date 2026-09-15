import { apiCall, fanOutRouters, type FanOutResult } from './api'
import { LOCAL_ROUTER_ID, type RemoteRouter, isRouterSelectable, routerId, routerLabel } from './routers'
import { getBaseUrlForId, useRoutersStore } from './routers-store'

export const REMOTE_AUTH_UNSUPPORTED =
  'Удалённые панели с авторизацией не поддерживаются: cookie сессии не передаётся между хостами. Откройте панель напрямую или отключите auth в LAN.'

export async function persistRouters(routers: RemoteRouter[]): Promise<{ success: boolean; error?: string }> {
  return apiCall<{ success: boolean; error?: string }>('PATCH', 'settings', { plugins: { routers } })
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

/** `true` / `false` if reachable; `null` if probe failed. */
export async function isRemoteAuthEnabled(baseUrl: string | null): Promise<boolean | null> {
  if (!baseUrl) return false
  try {
    const data = await apiCall<{ enabled?: boolean }>('GET', 'auth/login', undefined, {
      baseUrl,
      timeoutMs: 5000,
    })
    return !!data?.enabled
  } catch {
    return null
  }
}

export async function filterAuthBlockedTargets(
  targetIds: string[]
): Promise<{ allowed: string[]; blocked: string[] }> {
  const allowed: string[] = []
  const blocked: string[] = []
  await Promise.all(
    targetIds.map(async (id) => {
      if (id === LOCAL_ROUTER_ID) {
        allowed.push(id)
        return
      }
      const enabled = await isRemoteAuthEnabled(getBaseUrlForId(id))
      if (enabled === true) blocked.push(id)
      else allowed.push(id)
    })
  )
  return { allowed, blocked }
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
  const { routers, setOnline, setAuth } = useRoutersStore.getState()
  const ids = [LOCAL_ROUTER_ID, ...routers.map(routerId)]
  await Promise.all(
    ids.map(async (id) => {
      const online = await pingRouterOnline(id)
      if (id === LOCAL_ROUTER_ID || online) {
        setOnline(id, online)
        setAuth(id, false)
        return
      }
      const authEnabled = await isRemoteAuthEnabled(getBaseUrlForId(id))
      setOnline(id, false)
      setAuth(id, authEnabled === true)
    })
  )
  const state = useRoutersStore.getState()
  const next = state.applyTargets.filter((id) => isRouterSelectable(id, state.online, state.auth))
  if (next.length !== state.applyTargets.length) state.setApplyTargets(next)
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
