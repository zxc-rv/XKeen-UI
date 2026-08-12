export const LOCAL_ROUTER_ID = 'local'
export const DEFAULT_ROUTER_PORT = 1000
export const ONLINE_PING_INTERVAL_MS = 30_000
export const REMOTE_FETCH_TIMEOUT_MS = 12_000

export interface RemoteRouter {
  host: string
  port: number
  name: string
}

export type RouterCommandStatus = 'idle' | 'pending' | 'success' | 'error'

export interface RouterCommandState {
  status: RouterCommandStatus
  message?: string
}

export function routerId(router: Pick<RemoteRouter, 'host' | 'port'>): string {
  return `${router.host}:${router.port}`
}

export function routerBaseUrl(host: string, port = DEFAULT_ROUTER_PORT): string {
  return `http://${host}:${port}`
}

export function routerLabel(router: RemoteRouter): string {
  const label = router.name.trim()
  return label || `${router.host}:${router.port}`
}

export function findRouter(routers: RemoteRouter[], id: string): RemoteRouter | undefined {
  return routers.find((r) => routerId(r) === id)
}
