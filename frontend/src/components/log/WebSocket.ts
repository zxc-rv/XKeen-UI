import { useRef, useCallback, useEffect } from 'react'

type WsMessageHandler = (data: WsMessage) => void

export interface WsMessage {
  type: string
  lines?: string[]
  content?: string
  error?: string
}

export function useWebSocket(onMessage: WsMessageHandler) {
  const wsRef = useRef<WebSocket | null>(null)
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const currentFileRef = useRef('error.log')
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectRef = useRef<() => void>(() => {})

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.close()
    }
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current)

    const ws = new WebSocket(`/ws?file=${currentFileRef.current}`)
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
  }, [connect])

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
  const reload = useCallback(() => send({ type: 'reload' }), [send])

  return { switchFile, applyFilter, clearLog, reload }
}
