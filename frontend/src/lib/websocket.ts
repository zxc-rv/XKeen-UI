import { useCallback, useEffect, useRef } from 'react'
import { getActiveBaseUrl } from './routers-store'

function toWsOrigin(baseUrl: string | null | undefined): string {
  if (!baseUrl) {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${location.host}`
  }
  try {
    const url = new URL(baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.origin
  } catch {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${location.host}`
  }
}

export function clashWsUrl(
  port: string,
  path: string,
  secret?: string | null,
  unix?: string | null,
  baseUrl?: string | null
) {
  const normalizedPath = path.replace(/^\/+/, '')
  const params = new URLSearchParams()
  const useUnix = !!unix
  if (!useUnix && port) params.set('port', port)
  if (!useUnix && secret) params.set('secret', secret)
  if (useUnix && unix) params.set('unix', unix)
  const qs = params.toString()
  const resolved = baseUrl === undefined ? getActiveBaseUrl() : baseUrl
  const origin = toWsOrigin(resolved)
  return `${origin}/clash-ws/${normalizedPath}${qs ? `?${qs}` : ''}`
}

export function logWsUrl(file: string, baseUrl?: string | null) {
  const resolved = baseUrl === undefined ? getActiveBaseUrl() : baseUrl
  const origin = toWsOrigin(resolved)
  return `${origin}/ws?file=${encodeURIComponent(file)}`
}

type WsMessageHandler = (data: WsMessage) => void

export interface WsMessage {
  type: string
  lines?: string[]
  content?: string
  error?: string
}

export function useWebSocket(onMessage: WsMessageHandler, baseUrl?: string | null) {
  const wsRef = useRef<WebSocket | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentFileRef = useRef('error.log')
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectRef = useRef<() => void>(() => {})
  const baseUrlRef = useRef(baseUrl)
  baseUrlRef.current = baseUrl

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close()
    }
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current)

    const ws = new WebSocket(logWsUrl(currentFileRef.current, baseUrlRef.current))
    wsRef.current = ws

    ws.onopen = () => {
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30000)
    }

    ws.onclose = (event) => {
      console.warn(`WebSocket disconnected: ${event.code}. Reconnecting...`)
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current)
      reconnectTimeoutRef.current = setTimeout(() => connectRef.current(), 1000)
    }

    ws.onerror = () => ws.close()

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsMessage
        if (data.type === 'pong') return
        onMessage(data)
      } catch {
        /* */
      }
    }
  }, [onMessage])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  useEffect(() => {
    connect()
    return () => {
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current)
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
      wsRef.current?.close()
    }
  }, [connect, baseUrl])

  const send = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  const switchFile = useCallback(
    (filename: string) => {
      currentFileRef.current = filename
      send({ type: 'switchFile', file: filename })
    },
    [send]
  )

  const applyFilter = useCallback(
    (filter: string) => {
      if (!filter.trim()) {
        send({ type: 'reload' })
      } else {
        send({ type: 'filter', query: filter })
      }
    },
    [send]
  )

  const clearLog = useCallback(() => send({ type: 'clear' }), [send])
  const reload = useCallback((filter?: string) => send({ type: 'reload', query: filter ?? '' }), [send])

  return { switchFile, applyFilter, clearLog, reload }
}
