import { useState, memo, useCallback } from 'react'
import { create } from 'zustand'
import {
  IconX,
  IconTrash,
  IconWifi,
  IconArrowUp,
  IconArrowDown,
  IconArrowsSort,
  IconCircleArrowRightFilled,
  IconFilter,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useWsConnected, subscribeConnections, useProxiesStore, useNowStore } from '../../../lib/store'
import { clashFetch } from '../../../lib/api'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { useShallow } from 'zustand/react/shallow'

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

type SortColumn = 'host' | 'chains' | 'source' | 'start' | 'upload' | 'download' | null
type SortDirection = 'asc' | 'desc'

interface Props {
  clashApiPort: string
  clashApiSecret: string | null
}

// ─── Local store ───────────────────────────────────────────────────────────────

const useConnectionsStore = create<{ map: Map<string, Connection> }>(() => ({ map: new Map() }))

subscribeConnections((connections) => {
  useConnectionsStore.setState({ map: new Map(connections.map((c) => [c.id, c])) })
})

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
    case 'upload':
      return String(conn.upload).padStart(20, '0')
    case 'download':
      return String(conn.download).padStart(20, '0')
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
  const mod10 = n % 10,
    mod100 = n % 100
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

function SortIcon({ column, sortColumn, sortDirection }: { column: SortColumn; sortColumn: SortColumn; sortDirection: SortDirection }) {
  if (sortColumn !== column) return <IconArrowsSort size={13} className="opacity-30" />
  return sortDirection === 'asc' ? <IconArrowUp size={13} className="text-primary" /> : <IconArrowDown size={13} className="text-primary" />
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

function ProxyIcon({ name, className }: { name: string; className?: string }) {
  const icon = useProxiesStore((s) => (s.proxies[name] as any)?.icon as string | undefined)
  if (!icon) return null
  return (
    <img
      src={icon}
      alt=""
      className={className ?? 'size-5 shrink-0 object-contain mr-1'}
      onError={(e) => {
        ;(e.target as HTMLImageElement).style.display = 'none'
      }}
    />
  )
}

function ChainTooltip({ chains }: { chains: string[] }) {
  return (
    <TooltipContent side="top" className="p-2">
      <div className="flex items-center gap-1">
        {chains.map((chain, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <IconCircleArrowRightFilled size={11} className="text-muted-foreground shrink-0" />}
            <ProxyIcon name={chain} className="size-4 shrink-0 object-contain" />
            <span className="text-[13px]">{chain}</span>
          </span>
        ))}
      </div>
    </TooltipContent>
  )
}

// ─── TimeAgoCell ───────────────────────────────────────────────────────────────

function TimeAgoCell({ isoString }: { isoString: string }) {
  useNowStore((s) => s.tick)
  return <>{timeAgo(isoString)}</>
}

function TrafficCell({ connId }: { connId: string }) {
  const upload = useConnectionsStore((s) => s.map.get(connId)?.upload ?? 0)
  const download = useConnectionsStore((s) => s.map.get(connId)?.download ?? 0)
  return (
    <span className="flex flex-col gap-0.5 tabular-nums">
      <span>↑ {formatBytes(upload)}</span>
      <span>↓ {formatBytes(download)}</span>
    </span>
  )
}

// ─── Row ───────────────────────────────────────────────────────────────────────

const ConnectionRow = memo(function ConnectionRow({
  connId,
  onSelect,
  onClose,
}: {
  connId: string
  onSelect: (conn: Connection) => void
  onClose: (id: string, e: React.MouseEvent) => void
}) {
  const displayKey = useConnectionsStore((s) => {
    const c = s.map.get(connId)
    if (!c) return null
    const host = c.metadata.host || c.metadata.destinationIP
    return `${c.chains.join('|')}|${host}|${c.metadata.destinationPort}|${c.metadata.sourceIP}|${c.metadata.sourcePort}|${c.start}`
  })

  if (!displayKey) return null

  const conn = useConnectionsStore.getState().map.get(connId)!
  const host = conn.metadata.host || conn.metadata.destinationIP
  const reversedChains = [...conn.chains].reverse()
  const first = reversedChains[0]
  const last = reversedChains.at(-1)

  return (
    <TableRow className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onSelect(conn)}>
      <TableCell className="text-[13px] max-w-40 pl-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1 min-w-0">
              {first && (
                <div className="flex items-center gap-1 min-w-0 shrink truncate">
                  <ProxyIcon name={first} />
                  <span className="truncate">{first}</span>
                </div>
              )}
              {reversedChains.length > 1 && (
                <>
                  <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
                  <div className="flex items-center gap-1 min-w-0 shrink truncate">
                    <ProxyIcon name={last!} />
                    <span className="truncate">{last}</span>
                  </div>
                </>
              )}
            </div>
          </TooltipTrigger>
          <ChainTooltip chains={reversedChains} />
        </Tooltip>
      </TableCell>
      <TableCell className="text-[13px] max-w-48">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center min-w-0 overflow-hidden">
              <span className="truncate">{host}</span>
              {conn.metadata.destinationPort && <span className="text-muted-foreground shrink-0">:{conn.metadata.destinationPort}</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[13px]">{`${host}:${conn.metadata.destinationPort}`}</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-[13px] text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              {conn.metadata.sourceIP}
              <span className="opacity-60">:{conn.metadata.sourcePort}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[13px]">{`${conn.metadata.sourceIP}:${conn.metadata.sourcePort}`}</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-[13px] text-muted-foreground">
        <TrafficCell connId={connId} />
      </TableCell>
      <TableCell className="text-[13px] text-muted-foreground tabular-nums">
        <TimeAgoCell isoString={conn.start} />
      </TableCell>
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
})

// ─── Dialog ────────────────────────────────────────────────────────────────────

const ConnectionDialogMeta = memo(function ConnectionDialogMeta({ conn }: { conn: Connection }) {
  const reversedChains = [...conn.chains].reverse()

  return (
    <>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Цепочка</p>
      <div className="mb-4 flex flex-wrap items-center gap-1">
        {reversedChains.map((chain, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />}
            <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-muted text-foreground">
              <ProxyIcon name={chain} className="size-3.5 shrink-0 object-contain" />
              {chain || '—'}
            </span>
          </span>
        ))}
      </div>

      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Правило</p>
      <div className="mb-4 text-xs">
        <span className="text-blue-400">{conn.rule}</span>
        {conn.rulePayload && <span className="text-muted-foreground ml-1">{conn.rulePayload}</span>}
      </div>

      <ConnectionDialogTraffic conn={conn} />

      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Метаданные</p>
      <div className="rounded-lg border border-border px-3">
        <MetaRow label="Протокол" value={conn.metadata.network?.toUpperCase()} />
        <MetaRow label="Тип" value={conn.metadata.type} />
        <MetaRow label="Хост" value={conn.metadata.host} />
        <MetaRow label="Источник" value={`${conn.metadata.sourceIP}:${conn.metadata.sourcePort}`} />
        <MetaRow label="Порт назначения" value={conn.metadata.destinationPort} />
        <MetaRow label="Удалённый хост" value={conn.metadata.remoteDestination} />
        <MetaRow label="Sniff Host" value={conn.metadata.sniffHost} />
        <MetaRow label="DNS режим" value={conn.metadata.dnsMode} />
        <MetaRow label="Inbound" value={conn.metadata.inboundName} />
        <MetaRow label="Inbound адрес" value={`${conn.metadata.inboundIP}:${conn.metadata.inboundPort}`} />
        <MetaRow label="Процесс" value={conn.metadata.process || conn.metadata.processPath} />
        <MetaRow label="UID" value={conn.metadata.uid || undefined} />
        <MetaRow label="Начало" value={new Date(conn.start).toLocaleString()} />
      </div>
    </>
  )
})

function ConnectionDialogTraffic({ conn }: { conn: Connection }) {
  return (
    <>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Трафик</p>
      <div className="mb-4 flex gap-4 text-xs">
        <span>↑ {formatBytes(conn.upload)}</span>
        <span>↓ {formatBytes(conn.download)}</span>
      </div>
    </>
  )
}

const ConnectionDialogTitle = memo(function ConnectionDialogTitle({ conn }: { conn: Connection }) {
  const title = conn.metadata.host || conn.metadata.destinationIP || 'Соединение'
  return <DialogTitle className="text-base truncate pr-8">{title}</DialogTitle>
})

const ConnectionDialog = memo(function ConnectionDialog({
  connId,
  onClose,
  onCloseConnection,
}: {
  connId: string | null
  onClose: () => void
  onCloseConnection: (id: string) => Promise<void>
}) {
  const liveConn = useConnectionsStore((s) => (connId ? (s.map.get(connId) ?? null) : null))
  const [snapshot, setSnapshot] = useState<Connection | null>(null)
  if (liveConn !== null && liveConn !== snapshot) setSnapshot(liveConn)
  const conn = liveConn ?? snapshot
  const isClosed = !!connId && !liveConn

  return (
    <Dialog open={!!connId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg! overflow-hidden flex flex-col max-h-[80dvh]!">
        <DialogHeader className="shrink-0">{conn && <ConnectionDialogTitle conn={conn} />}</DialogHeader>

        <div className="overflow-y-auto flex-1 min-h-0">
          {conn && (
            <>
              <ConnectionDialogMeta conn={conn} />
            </>
          )}
        </div>

        {conn && (
          <div>
            <Button
              variant="destructive"
              className="w-full"
              disabled={isClosed || !connId}
              onClick={() => connId && onCloseConnection(connId)}
            >
              <IconX size={14} /> {isClosed ? 'Соединение закрыто' : 'Закрыть соединение'}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
})

// ─── Header Subcomponents ─────────────────────────────────────────────────────

const ConnectionsStatus = memo(function ConnectionsStatus() {
  const connected = useWsConnected()
  const totalCount = useConnectionsStore((s) => s.map.size)
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground shrink-0">
      {connected ? <IconWifi size={24} className="text-green-400" /> : <IconWifi size={24} className="text-red-400" />}
      <span className="tabular-nums">{totalCount}</span>
    </div>
  )
})

const CloseAllBtn = memo(function CloseAllBtn({ onCloseAll }: { onCloseAll: () => void }) {
  const totalCount = useConnectionsStore((s) => s.map.size)
  return (
    <Button variant="destructive" className="text-[13px]" onClick={onCloseAll} disabled={totalCount === 0}>
      <IconTrash data-icon="inline-start" /> Закрыть все
    </Button>
  )
})

// ─── Header ────────────────────────────────────────────────────────────────────

const ConnectionsHeader = memo(function ConnectionsHeader({
  filter,
  onFilterChange,
  onClearFilter,
  onCloseAll,
}: {
  filter: string
  onFilterChange: (v: string) => void
  onClearFilter: () => void
  onCloseAll: () => void
}) {
  return (
    <div className="flex items-center gap-2 p-3 border-b border-border shrink-0">
      <ConnectionsStatus />

      <InputGroup>
        <InputGroupInput value={filter} onChange={(e) => onFilterChange(e.target.value)} placeholder="Фильтр" />
        <InputGroupAddon>
          <IconFilter />
        </InputGroupAddon>
        <InputGroupAddon align="inline-end">
          {filter && (
            <InputGroupButton className="text-muted-foreground hover:text-destructive" onClick={onClearFilter}>
              <IconX size={13} />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>

      <CloseAllBtn onCloseAll={onCloseAll} />
    </div>
  )
})

// ─── Table head ────────────────────────────────────────────────────────────────

const columns: { key: SortColumn; label: string; className: string }[] = [
  { key: 'chains', label: 'Цепочка', className: 'w-[35%] pl-3' },
  { key: 'host', label: 'Хост', className: 'w-[35%]' },
  { key: 'source', label: 'Источник', className: 'w-[10%]' },
  { key: 'upload', label: 'Трафик', className: 'w-[10%]' },
  { key: 'start', label: 'Время', className: 'w-[10%]' },
]

const ConnectionsTableHead = memo(function ConnectionsTableHead({
  sortColumn,
  sortDirection,
  onSort,
}: {
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSort: (col: SortColumn) => void
}) {
  return (
    <TableHeader>
      <TableRow>
        {columns.map((col) => {
          const isTraffic = col.key === 'upload'
          const trafficActive = isTraffic && (sortColumn === 'upload' || sortColumn === 'download')
          const effectiveKey = isTraffic ? (sortColumn === 'download' ? 'download' : 'upload') : col.key
          const label = isTraffic ? (trafficActive ? (sortColumn === 'upload' ? '↑ Отдано' : '↓ Скачано') : 'Трафик') : col.label
          return (
            <TableHead
              key={col.label}
              className={`select-none ${col.className} ${col.key ? 'cursor-pointer' : ''}`}
              onClick={() => col.key && onSort(col.key)}
            >
              <span className="flex items-center gap-1">
                {label}
                {col.key && <SortIcon column={effectiveKey} sortColumn={sortColumn} sortDirection={sortDirection} />}
              </span>
            </TableHead>
          )
        })}
        <TableHead className="w-10" />
      </TableRow>
    </TableHeader>
  )
})

// ─── Body ──────────────────────────────────────────────────────────────────────

const ConnectionsBody = memo(function ConnectionsBody({
  filter,
  sortColumn,
  sortDirection,
  onSelect,
  onClose,
}: {
  filter: string
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSelect: (conn: Connection) => void
  onClose: (id: string, e: React.MouseEvent) => void
}) {
  const connected = useWsConnected()

  const filteredIds = useConnectionsStore(
    useShallow((s) => {
      const connections = Array.from(s.map.values())
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

      return result.map((c) => c.id)
    })
  )

  return (
    <TableBody>
      {filteredIds.length === 0 ? (
        <TableRow>
          <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
            {!connected ? 'Подключение...' : filter ? 'Нет совпадений' : 'Нет активных соединений'}
          </TableCell>
        </TableRow>
      ) : (
        filteredIds.map((id) => <ConnectionRow key={id} connId={id} onSelect={onSelect} onClose={onClose} />)
      )}
    </TableBody>
  )
})

// ─── Main panel ────────────────────────────────────────────────────────────────

export function ConnectionsPanel({ clashApiPort, clashApiSecret }: Props) {
  const [filter, setFilter] = useState('')
  const [sortColumn, setSortColumn] = useState<SortColumn>('start')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const toggleSort = useCallback((column: SortColumn) => {
    setSortColumn((prev) => {
      if (column === 'upload' && prev === 'upload') {
        setSortDirection('desc')
        return 'download'
      }
      if (column === 'upload' && prev === 'download') {
        setSortDirection('desc')
        return 'upload'
      }
      if (prev === column) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'))
        return prev
      }
      setSortDirection('desc')
      return column
    })
  }, [])

  const closeAll = useCallback(async () => {
    await clashFetch(clashApiPort, 'connections', { method: 'DELETE', secret: clashApiSecret })
    setSelectedId(null)
  }, [clashApiPort, clashApiSecret])

  const clearFilter = useCallback(() => setFilter(''), [])

  const handleCloseConnection = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation()
      await clashFetch(clashApiPort, `connections/${id}`, { method: 'DELETE', secret: clashApiSecret })
      setSelectedId((prev) => (prev === id ? null : prev))
    },
    [clashApiPort, clashApiSecret]
  )

  const handleSelectConnection = useCallback((conn: Connection) => {
    setSelectedId(conn.id)
  }, [])

  const handleCloseDialog = useCallback(() => setSelectedId(null), [])

  const handleCloseDialogConnection = useCallback(
    async (id: string) => {
      await handleCloseConnection(id)
      setSelectedId(null)
    },
    [handleCloseConnection]
  )

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute inset-4 rounded-xl overflow-hidden border border-border bg-input-background flex flex-col">
        <ConnectionsHeader filter={filter} onFilterChange={setFilter} onClearFilter={clearFilter} onCloseAll={closeAll} />

        <div className="flex-1 overflow-auto">
          <Table>
            <ConnectionsTableHead sortColumn={sortColumn} sortDirection={sortDirection} onSort={toggleSort} />
            <ConnectionsBody
              filter={filter}
              sortColumn={sortColumn}
              sortDirection={sortDirection}
              onSelect={handleSelectConnection}
              onClose={handleCloseConnection}
            />
          </Table>
        </div>
      </div>

      <ConnectionDialog connId={selectedId} onClose={handleCloseDialog} onCloseConnection={handleCloseDialogConnection} />
    </TooltipProvider>
  )
}
