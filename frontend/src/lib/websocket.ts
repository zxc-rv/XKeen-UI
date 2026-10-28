import { useCallback, useEffect, useRef } from 'react'

const PING_INTERVAL_MS = 30000
const RECONNECT_DELAY_MS = 1000

const socketUrl = (path: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`

export function clashWsUrl(port: string, path: string, secret?: string | null, unix?: string | null) {
  const normalizedPath = path.replace(/^\/+/, '')
  const params = new URLSearchParams()
  const useUnix = !!unix
  if (!useUnix && port) params.set('port', port)
  if (!useUnix && secret) params.set('secret', secret)
  if (useUnix && unix) params.set('unix', unix)
  const qs = params.toString()
  return `${socketUrl(`/clash-ws/${normalizedPath}`)}${qs ? `?${qs}` : ''}`
}

type WsMessageHandler = (data: WsMessage) => void

export interface UpdateEvent {
  type: 'stage' | 'log' | 'progress' | 'done'
  seq?: number
  stage?: string
  ts?: string
  level?: string
  message?: string
  downloaded?: number
  total?: number
  speed?: number
  success?: boolean
  error?: string | null
}

export interface WsMessage {
  type: string
  lines?: string[]
  content?: string
  error?: string
  event?: UpdateEvent
  history?: UpdateEvent[]
}

function useReconnectingSocket(getPath: () => string, onMessage: WsMessageHandler, enabled = true) {
  const socketRef = useRef<WebSocket | null>(null)
  const getPathRef = useRef(getPath)
  const onMessageRef = useRef(onMessage)

  useEffect(() => {
    getPathRef.current = getPath
    onMessageRef.current = onMessage
  })

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let pingInterval: ReturnType<typeof setInterval> | undefined
    let reconnectTimeout: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      const socket = new WebSocket(socketUrl(getPathRef.current()))
      socketRef.current = socket

      socket.onopen = () => {
        pingInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
        }, PING_INTERVAL_MS)
      }

      socket.onclose = (event) => {
        clearInterval(pingInterval)
        if (disposed) return
        console.warn(`WebSocket disconnected: ${event.code}. Reconnecting...`)
        reconnectTimeout = setTimeout(connect, RECONNECT_DELAY_MS)
      }

      socket.onerror = () => socket.close()

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WsMessage
          if (data.type !== 'pong') onMessageRef.current(data)
        } catch {
          return
        }
      }
    }

    connect()
    return () => {
      disposed = true
      clearInterval(pingInterval)
      clearTimeout(reconnectTimeout)
      socketRef.current?.close()
    }
  }, [enabled])

  return socketRef
}

export function useWebSocket(onMessage: WsMessageHandler) {
  const currentFileRef = useRef('error.log')
  const socketRef = useReconnectingSocket(() => `/ws/log?file=${currentFileRef.current}`, onMessage)

  const send = useCallback(
    (data: object) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify(data))
      }
    },
    [socketRef]
  )

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

export function useUpdateWebSocket(onMessage: WsMessageHandler, enabled: boolean) {
  useReconnectingSocket(() => '/ws/updater', onMessage, enabled)
}
