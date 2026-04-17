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

export async function apiCall<T = unknown>(method: string, endpoint: string, body?: unknown): Promise<T> {
  const isGet = method === 'GET'
  const res = await fetch(`/api/${endpoint}`, {
    method,
    headers: !isGet ? { 'Content-Type': 'application/json' } : {},
    body: !isGet ? JSON.stringify(body) : undefined,
  })
  return (await res.json()) as T
}

export async function clashFetch<T = unknown>(
  port: string,
  path: string,
  options?: { method?: string; secret?: string | null; body?: unknown; unix?: string | null; retry?: boolean }
): Promise<T> {
  const { method = 'GET', secret, body, unix, retry = true } = options ?? {}
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

  // Ретраим только GET-запросы если пришла 502/503/504 или отвалилась сеть
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    let res: Response
    try {
      res = await fetch(`/clash/${normalizedPath}`, reqOptions)
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

export function getFileLanguage(filename: string): string {
  if (filename.endsWith('.yaml') || filename.endsWith('.yml')) return 'yaml'
  if (filename.endsWith('.lst')) return 'plaintext'
  return 'json'
}

export function capitalize(str: string) {
  return str ? str[0].toUpperCase() + str.slice(1) : ''
}
