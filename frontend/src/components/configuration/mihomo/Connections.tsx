import { useEffect, useRef, useState, useMemo, memo, useCallback } from 'react'
import {
  IconX,
  IconTrash,
  IconWifi,
  IconArrowUp,
  IconArrowDown,
  IconArrowsSort,
  IconSearch,
  IconCircleArrowRightFilled,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface ProxyInfo {
  name: string
  type: string
  icon?: string
}

interface ConnectionMetadata {
  network: string
  type: string
  sourceIP: string
  destinationIP: string
  sourcePort: string
  destinationPort: string
  inboundIP: string
  inboundPort: string
  inboundName: string
  host: string
  dnsMode: string
  uid: number
  process: string
  processPath: string
  remoteDestination: string
  sniffHost: string
}

interface Connection {
  id: string
  metadata: ConnectionMetadata
  upload: number
  download: number
  start: string
  chains: string[]
  providerChains: string[]
  rule: string
  rulePayload: string
}

type SortColumn = 'host' | 'chains' | 'source' | 'start' | null
type SortDirection = 'asc' | 'desc'

interface Props {
  dashboardPort: string
  connections: Connection[]
  connected: boolean
}

function SortIcon({ column, sortColumn, sortDirection }: { column: SortColumn; sortColumn: SortColumn; sortDirection: SortDirection }) {
  if (sortColumn !== column) return <IconArrowsSort size={13} className="opacity-30" />
  return sortDirection === 'asc' ? <IconArrowUp size={13} className="text-primary" /> : <IconArrowDown size={13} className="text-primary" />
}

function getConnectionSortValue(conn: Connection, column: SortColumn): string {
  switch (column) {
    case 'host':
      return conn.metadata.host || conn.metadata.destinationIP
    case 'chains':
      return conn.chains[0] ?? ''
    case 'source':
      return conn.metadata.sourceIP
    case 'start':
      return conn.start
    default:
      return ''
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 19) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

function timeAgo(isoString: string): string {
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000)
  if (diffSec < 5) return 'неск. сек назад'
  if (diffSec < 60) return `${diffSec} ${pluralize(diffSec, 'сек', 'сек', 'сек')} назад`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} ${pluralize(diffMin, 'мин', 'мин', 'мин')} назад`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour} ${pluralize(diffHour, 'час', 'часа', 'часов')} назад`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay} ${pluralize(diffDay, 'день', 'дня', 'дней')} назад`
}

function MetaRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (!value && value !== 0) return null
  return (
    <div className="flex gap-2 py-1.5 border-b border-border last:border-0">
      <span className="text-muted-foreground shrink-0 w-40 text-xs">{label}</span>
      <span className="text-xs break-all">{String(value)}</span>
    </div>
  )
}

function WithTooltip({ content, children }: { content: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{content}</TooltipContent>
    </Tooltip>
  )
}

function ProxyIcon({ name, proxies }: { name: string; proxies: Record<string, ProxyInfo> }) {
  const icon = proxies[name]?.icon
  if (!icon) return null
  return (
    <img
      src={icon}
      alt=""
      className="size-4 shrink-0 object-contain mr-2"
      onError={(e) => {
        ;(e.target as HTMLImageElement).style.display = 'none'
      }}
    />
  )
}

const ConnectionRow = memo(
  ({
    conn,
    proxies,
    onSelect,
    onClose,
  }: {
    conn: Connection
    proxies: Record<string, ProxyInfo>
    onSelect: (conn: Connection) => void
    onClose: (id: string, e: React.MouseEvent) => void
  }) => {
    const host = conn.metadata.host || conn.metadata.destinationIP
    const hostFull = `${host}:${conn.metadata.destinationPort}`
    const reversedChains = [...conn.chains].reverse()
    const chainsFull = reversedChains.join(' → ')
    const first = reversedChains[0]
    const last = reversedChains[reversedChains.length - 1]

    return (
      <TableRow className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onSelect(conn)}>
        <TableCell className="text-[13px] max-w-40 pl-3">
          <WithTooltip content={chainsFull}>
            <div className="flex items-center gap-1 min-w-0">
              {first && (
                <div className="flex items-center gap-1 min-w-0 shrink truncate">
                  <ProxyIcon name={first} proxies={proxies} />
                  <span className="truncate">{first}</span>
                </div>
              )}
              {reversedChains.length > 1 && (
                <>
                  <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
                  <div className="flex items-center gap-1 min-w-0 shrink truncate">
                    <ProxyIcon name={last} proxies={proxies} />
                    <span className="truncate">{last}</span>
                  </div>
                </>
              )}
            </div>
          </WithTooltip>
        </TableCell>
        <TableCell className="text-[13px] max-w-48">
          <WithTooltip content={hostFull}>
            <span className="flex items-center min-w-0 overflow-hidden">
              <span className="truncate">{host}</span>
              {conn.metadata.destinationPort && <span className="text-muted-foreground shrink-0">:{conn.metadata.destinationPort}</span>}
            </span>
          </WithTooltip>
        </TableCell>
        <TableCell className="text-[13px] text-muted-foreground">
          <WithTooltip content={`${conn.metadata.sourceIP}:${conn.metadata.sourcePort}`}>
            <span>
              {conn.metadata.sourceIP}
              <span className="opacity-60">:{conn.metadata.sourcePort}</span>
            </span>
          </WithTooltip>
        </TableCell>
        <TableCell className="text-[13px] text-muted-foreground tabular-nums">{timeAgo(conn.start)}</TableCell>
        <TableCell>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-red-400"
            onClick={(e) => onClose(conn.id, e)}
          >
            <IconX size={13} />
          </Button>
        </TableCell>
      </TableRow>
    )
  }
)

ConnectionRow.displayName = 'ConnectionRow'

export function ConnectionsPanel({ dashboardPort, connections, connected }: Props) {
  const [filter, setFilter] = useState('')
  const [sortColumn, setSortColumn] = useState<SortColumn>('start')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [selectedConnection, setSelectedConnection] = useState<Connection | null>(null)
  const [proxies, setProxies] = useState<Record<string, ProxyInfo>>({})

  const lastSelectedRef = useRef<Connection | null>(null)
  const baseUrl = `http://${location.hostname}:${dashboardPort}`

  useEffect(() => {
    if (!dashboardPort) return
    fetch(`http://${location.hostname}:${dashboardPort}/proxies`)
      .then((r) => r.json())
      .then((data) => {
        if (data.proxies) setProxies(data.proxies)
      })
      .catch(() => {})
  }, [dashboardPort])

  function toggleSort(column: SortColumn) {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  const filteredAndSorted = useMemo(() => {
    const query = filter.toLowerCase().trim()
    let result = connections.filter((conn) => !conn.chains.some((c) => c.toLowerCase() === 'dns-out'))

    if (query) {
      result = result.filter(
        (conn) =>
          conn.chains.some((c) => c.toLowerCase().includes(query)) ||
          conn.metadata.host.toLowerCase().includes(query) ||
          conn.metadata.destinationIP.includes(query) ||
          conn.metadata.sourceIP.includes(query) ||
          conn.rule.toLowerCase().includes(query) ||
          conn.rulePayload.toLowerCase().includes(query)
      )
    }

    if (sortColumn) {
      result = [...result].sort((a, b) => {
        const valueA = getConnectionSortValue(a, sortColumn)
        const valueB = getConnectionSortValue(b, sortColumn)
        return sortDirection === 'asc' ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA)
      })
    }
    return result
  }, [connections, filter, sortColumn, sortDirection])

  const handleCloseConnection = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation()
      await fetch(`${baseUrl}/connections/${id}`, { method: 'DELETE' })
      setSelectedConnection((prev) => (prev?.id === id ? null : prev))
    },
    [baseUrl]
  )

  const handleSelectConnection = useCallback((conn: Connection) => {
    setSelectedConnection(conn)
  }, [])

  async function closeAll() {
    await fetch(`${baseUrl}/connections`, { method: 'DELETE' })
    setSelectedConnection(null)
  }

  const selected = selectedConnection ? (connections.find((c) => c.id === selectedConnection.id) ?? selectedConnection) : null
  if (selected) lastSelectedRef.current = selected
  const displayedConnection = selected ?? lastSelectedRef.current

  const columns: { key: SortColumn; label: string; className: string }[] = [
    { key: 'chains', label: 'Цепочка', className: 'w-[30%] pl-3' },
    { key: 'host', label: 'Хост', className: 'w-[40%]' },
    { key: 'source', label: 'Источник', className: 'w-[15%]' },
    { key: 'start', label: 'Время', className: 'w-[15%]' },
  ]

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute inset-4 rounded-xl overflow-hidden border border-border bg-input-background flex flex-col">
        <div className="flex items-center gap-2 p-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground shrink-0">
            {connected ? <IconWifi size={24} className="text-green-400" /> : <IconWifi size={24} className="text-red-400" />}
            <span className="tabular-nums">
              {filteredAndSorted.length}
              {filter ? `/${connections.length}` : ''}
            </span>
          </div>
          <div className="relative flex-1">
            <IconSearch size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Фильтр"
              className={`h-9 pl-7 text-xs ${filter ? 'pr-7' : ''}`}
            />
            {filter && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setFilter('')}
              >
                <IconX size={13} />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs text-red-400 hover:text-red-300 shrink-0"
            onClick={closeAll}
            disabled={connections.length === 0}
          >
            <IconTrash size={13} /> Закрыть все
          </Button>
        </div>

        <div className="flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((col) => (
                  <TableHead key={col.key} className={`cursor-pointer select-none ${col.className}`} onClick={() => toggleSort(col.key)}>
                    <span className="flex items-center gap-1">
                      {col.label}
                      <SortIcon column={col.key} sortColumn={sortColumn} sortDirection={sortDirection} />
                    </span>
                  </TableHead>
                ))}
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAndSorted.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    {!connected ? 'Подключение...' : filter ? 'Нет совпадений' : 'Нет активных соединений'}
                  </TableCell>
                </TableRow>
              ) : (
                filteredAndSorted.map((conn) => (
                  <ConnectionRow
                    key={conn.id}
                    conn={conn}
                    proxies={proxies}
                    onSelect={handleSelectConnection}
                    onClose={handleCloseConnection}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelectedConnection(null)}>
        <DialogContent className="max-w-lg! overflow-hidden flex flex-col max-h-[80dvh]!">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-base truncate pr-8">
              {displayedConnection?.metadata.host || displayedConnection?.metadata.destinationIP || 'Соединение'}
            </DialogTitle>
          </DialogHeader>

          <div className="overflow-y-auto flex-1 min-h-0 -mx-6 px-6">
            {displayedConnection && (
              <>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Цепочка</p>
                <div className="mb-4 flex flex-wrap gap-1">
                  {[...displayedConnection.chains].reverse().map((chain, i) => (
                    <span key={i} className="text-xs px-2 py-0.5 rounded-md bg-muted text-foreground">
                      {chain || '—'}
                    </span>
                  ))}
                </div>

                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Правило</p>
                <div className="mb-4 text-xs">
                  <span className="text-blue-400">{displayedConnection.rule}</span>
                  {displayedConnection.rulePayload && <span className="text-muted-foreground ml-1">{displayedConnection.rulePayload}</span>}
                </div>

                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Трафик</p>
                <div className="mb-4 flex gap-4 text-xs">
                  <span>↑ {formatBytes(displayedConnection.upload)}</span>
                  <span>↓ {formatBytes(displayedConnection.download)}</span>
                </div>

                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Метаданные</p>
                <div className="rounded-lg border border-border px-3 mb-4">
                  <MetaRow label="Протокол" value={displayedConnection.metadata.network} />
                  <MetaRow label="Тип" value={displayedConnection.metadata.type} />
                  <MetaRow label="Хост" value={displayedConnection.metadata.host} />
                  <MetaRow label="Источник" value={`${displayedConnection.metadata.sourceIP}:${displayedConnection.metadata.sourcePort}`} />
                  <MetaRow
                    label="Назначение"
                    value={`${displayedConnection.metadata.destinationIP}:${displayedConnection.metadata.destinationPort}`}
                  />
                  <MetaRow label="Удалённый хост" value={displayedConnection.metadata.remoteDestination} />
                  <MetaRow label="Sniff Host" value={displayedConnection.metadata.sniffHost} />
                  <MetaRow label="DNS режим" value={displayedConnection.metadata.dnsMode} />
                  <MetaRow label="Inbound" value={displayedConnection.metadata.inboundName} />
                  <MetaRow
                    label="Inbound адрес"
                    value={`${displayedConnection.metadata.inboundIP}:${displayedConnection.metadata.inboundPort}`}
                  />
                  <MetaRow label="Процесс" value={displayedConnection.metadata.process || displayedConnection.metadata.processPath} />
                  <MetaRow label="UID" value={displayedConnection.metadata.uid || undefined} />
                  <MetaRow label="Начало" value={new Date(displayedConnection.start).toLocaleString()} />
                </div>
              </>
            )}
          </div>

          {displayedConnection && (
            <div className="shrink-0 pt-2 border-t border-border">
              <Button
                variant="outline"
                size="sm"
                className="w-full h-9 gap-1.5 text-xs text-red-400 hover:text-red-300"
                onClick={() => handleCloseConnection(displayedConnection.id)}
              >
                <IconX size={13} /> Закрыть соединение
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
