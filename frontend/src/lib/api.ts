import { getActiveBaseUrl } from './routers-store'
import { REMOTE_FETCH_TIMEOUT_MS } from './routers'

const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000]
const RETRY_STATUSES = new Set([502, 503, 504])

function extractClashErrorMessage(bodyText: string): string {
  const trimmed = bodyText.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown; error?: unknown }
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : typeof parsed.error === 'string' ? parsed.error.trim() : ''
    return message || trimmed
  } catch {
    return trimmed
  }
}

function resolveBaseUrl(baseUrl?: string | null): string | null {
  if (baseUrl === undefined) return getActiveBaseUrl()
  return baseUrl
}

function apiPrefix(baseUrl?: string | null): string {
  const base = resolveBaseUrl(baseUrl)
  return base ? `${base}/api` : '/api'
}

function clashPrefix(baseUrl?: string | null): string {
  const base = resolveBaseUrl(baseUrl)
  return base ? `${base}/clash` : '/clash'
}

export async function apiCall<T = unknown>(
  method: string,
  endpoint: string,
  body?: unknown,
  options?: { baseUrl?: string | null; timeoutMs?: number }
): Promise<T> {
  const isGet = method === 'GET'
  const timeoutMs = options?.timeoutMs ?? (resolveBaseUrl(options?.baseUrl) ? REMOTE_FETCH_TIMEOUT_MS : undefined)
  const controller = timeoutMs ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    const res = await fetch(`${apiPrefix(options?.baseUrl)}/${endpoint}`, {
      method,
      headers: !isGet ? { 'Content-Type': 'application/json' } : {},
      body: !isGet ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    })
    return (await res.json()) as T
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function clashFetch<T = unknown>(
  port: string,
  path: string,
  options?: {
    method?: string
    secret?: string | null
    body?: unknown
    unix?: string | null
    retry?: boolean
    baseUrl?: string | null
  }
): Promise<T> {
  const { method = 'GET', secret, body, unix, retry = true, baseUrl } = options ?? {}
  const canRetry = retry && method === 'GET'
  const normalizedPath = path.replace(/^\/+/, '')

  const headers: Record<string, string> = {}
  if (!unix && port) headers['X-Clash-Port'] = port
  if (!unix && secret) headers['X-Clash-Secret'] = secret
  if (unix) headers['X-Clash-Unix'] = unix
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const reqOptions: RequestInit = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }

  const maxAttempts = canRetry ? RETRY_DELAYS.length : 0
  const prefix = clashPrefix(baseUrl)

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    let res: Response
    try {
      res = await fetch(`${prefix}/${normalizedPath}`, reqOptions)
    } catch (error) {
      if (attempt === maxAttempts) throw error
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
      continue
    }

    if (!res.ok) {
      if (canRetry && RETRY_STATUSES.has(res.status) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
        continue
      }
      const bodyText = await res.text().catch(() => '')
      const details = extractClashErrorMessage(bodyText)
      const messageLooksLikeStatus = /^\d{3}\s+/u.test(details)
      throw new Error(
        messageLooksLikeStatus
          ? `Clash request failed: ${details}`
          : `Clash request failed: ${res.status} ${res.statusText}${details ? ` - ${details}` : ''}`
      )
    }

    if (res.status === 204 || res.headers.get('content-length') === '0') return {} as T
    return (await res.json()) as T
  }
  throw new Error('Max retries exceeded')
}

export type FanOutResult = { id: string; ok: boolean; error?: string }

export async function fanOutRouters(
  targetIds: string[],
  task: (id: string, baseUrl: string | null) => Promise<void>,
  getBaseUrl: (id: string) => string | null
): Promise<FanOutResult[]> {
  const results = await Promise.allSettled(
    targetIds.map(async (id) => {
      await task(id, getBaseUrl(id))
      return id
    })
  )

  return results.map((result, index) => {
    const id = targetIds[index]
    if (result.status === 'fulfilled') return { id, ok: true }
    const error = result.reason instanceof Error ? result.reason.message : String(result.reason ?? 'Ошибка')
    return { id, ok: false, error }
  })
}

export function getFileLanguage(filename: string): string {
  if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'yaml'
  if (filename.endsWith('.lst')) return 'plaintext'
  return 'json'
}

export function capitalize(str: string) {
  return str ? str[0].toUpperCase() + str.slice(1) : ''
}
