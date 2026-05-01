import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  IconActivity,
  IconArrowDown,
  IconArrowsSort,
  IconArrowUp,
  IconCircleArrowRightFilled,
  IconFilter,
  IconLoader2,
  IconPlugX,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { memo, useCallback, useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { clashFetch } from '../../../lib/api'
import { getConnections, subscribeConnections, useNowStore, useProxiesStore, useWsConnected } from '../../../lib/store'
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
  clashApiUnix?: string | null
}

// ─── Local store ───────────────────────────────────────────────────────────────

const toMap = (connections: Connection[]) => new Map(connections.map((c) => [c.id, c]))

const useConnectionsStore = create<{ map: Map<string, Connection>; closedMap: Map<string, Connection> }>(() => ({
  map: toMap(getConnections()),
  closedMap: new Map(),
}))

subscribeConnections((connections) => {
  const newMap = toMap(connections)
  const { map: prevMap, closedMap: prevClosed } = useConnectionsStore.getState()
  let nextClosed = prevClosed
  for (const [id, conn] of prevMap) {
    if (!newMap.has(id) && !prevClosed.has(id)) {
      if (nextClosed === prevClosed) nextClosed = new Map(prevClosed)
      nextClosed.set(id, conn)
    }
  }
  useConnectionsStore.setState({ map: newMap, closedMap: nextClosed })
})

const asnCache = new Map<string, string | null>()

function formatAsn(data: any): string | null {
  const asnObj = data?.asn && typeof data.asn === 'object' ? data.asn : null
  let asn = typeof asnObj?.asn === 'string' ? asnObj.asn.trim() : null
  let name = typeof asnObj?.name === 'string' ? asnObj.name.trim() : null
  if (!asn || !name) {
    const org = typeof data?.org === 'string' ? data.org.trim() : ''
    const match = org.match(/^AS(\d+)\s*(.*)?$/i)
    if (match) {
      if (!asn) asn = `AS${match[1]}`
      if (!name) name = match[2]?.trim() || null
    }
  }
  if (!asn) return null
  return name ? `${asn} (${name})` : asn
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getConnectionSortValue(conn: Connection, column: SortColumn): string {
  switch (column) {
    case 'host':
      return getConnectionHost(conn)
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

function getConnectionHost(conn: Connection): string {
  return conn.metadata.host || conn.metadata.destinationIP
}

function getConnectionHostLabel(conn: Connection): string {
  const host = getConnectionHost(conn)
  return conn.metadata.destinationPort ? `${host}:${conn.metadata.destinationPort}` : host
}

function getConnectionSourceLabel(conn: Connection): string {
  return `${conn.metadata.sourceIP}:${conn.metadata.sourcePort}`
}

function getConnectionSourceHost(conn: Connection): string {
  return conn.metadata.sourceIP
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
  if (diffSec < 5) return 'только что'
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

function MetaRow({ label, value, force }: { label: string; value: ReactNode; force?: boolean }) {
  if (!force && (value === null || value === undefined || value === '')) return null
  return (
    <div className="border-border flex gap-2 border-b py-1.5 last:border-0">
      <span className="text-muted-foreground w-40 shrink-0 text-xs">{label}</span>
      <span className="text-xs break-all">{value}</span>
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
      className={className ?? 'size-4.5 shrink-0 object-contain'}
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
    <span className="flex items-center gap-2 whitespace-nowrap tabular-nums">
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
  onApplyFilter,
}: {
  connId: string
  onSelect: (conn: Connection) => void
  onClose: (id: string, e: React.MouseEvent) => void
  onApplyFilter: (value: string) => void
}) {
  const displayKey = useConnectionsStore((s) => {
    const c = s.map.get(connId)
    if (!c) return null
    const host = getConnectionHost(c)
    return `${c.chains.join('|')}|${host}|${c.metadata.destinationPort}|${c.metadata.sourceIP}|${c.metadata.sourcePort}|${c.start}`
  })

  if (!displayKey) return null

  const conn = useConnectionsStore.getState().map.get(connId)!
  const host = getConnectionHost(conn)
  const hostLabel = getConnectionHostLabel(conn)
  const source = getConnectionSourceLabel(conn)
  const sourceHost = getConnectionSourceHost(conn)
  const reversedChains = [...conn.chains].reverse()
  const first = reversedChains[0]
  const last = reversedChains.at(-1)
  const applyChainFilter = (value: string | undefined, e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (value) onApplyFilter(value)
  }

  return (
    <TableRow className="hover:bg-muted/50 cursor-pointer transition-colors" onClick={() => onSelect(conn)}>
      <TableCell className="max-w-120 pl-3 text-[13px] md:max-w-40">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex w-fit max-w-full items-center gap-1 overflow-hidden text-left">
              {first && (
                <button
                  type="button"
                  className="flex shrink-0 cursor-copy items-center gap-1 text-left hover:text-blue-400"
                  onClick={(e) => applyChainFilter(first, e)}
                >
                  <ProxyIcon name={first} className="mr-0.5 size-4.5 shrink-0 object-contain" />
                  <span className="block whitespace-nowrap">{first}</span>
                </button>
              )}
              {reversedChains.length > 1 && (
                <>
                  <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-copy items-center gap-1 overflow-hidden text-left hover:text-blue-400"
                    onClick={(e) => applyChainFilter(last, e)}
                  >
                    <ProxyIcon name={last!} className="mr-0.5 size-4.5 shrink-0 object-contain" />
                    <span className="block truncate">{last}</span>
                  </button>
                </>
              )}
            </div>
          </TooltipTrigger>
          <ChainTooltip chains={reversedChains} />
        </Tooltip>
      </TableCell>
      <TableCell className="max-w-72 text-[13px] md:max-w-48">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex w-fit max-w-full cursor-copy items-center overflow-hidden text-left hover:text-blue-400"
              onClick={(e) => {
                e.stopPropagation()
                onApplyFilter(host)
              }}
            >
              <span className="truncate">{host}</span>
              {conn.metadata.destinationPort && <span className="text-muted-foreground shrink-0">:{conn.metadata.destinationPort}</span>}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[13px]" copyTextValue={hostLabel}>
            {hostLabel}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-muted-foreground max-w-64 text-[13px] md:max-w-47.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="block w-fit max-w-full cursor-copy truncate text-left hover:text-blue-400"
              onClick={(e) => {
                e.stopPropagation()
                onApplyFilter(sourceHost)
              }}
            >
              {source}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[13px]" copyTextValue={source}>
            {source}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px]">
        <TrafficCell connId={connId} />
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px] tabular-nums">
        <TimeAgoCell isoString={conn.start} />
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground size-5 hover:bg-transparent! hover:text-red-400"
          onClick={(e) => onClose(conn.id, e)}
        >
          <IconX className="size-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  )
})

// ─── Closed Row ────────────────────────────────────────────────────────────────

const ClosedConnectionRow = memo(function ClosedConnectionRow({
  conn,
  onSelect,
}: {
  conn: Connection
  onSelect: (conn: Connection) => void
}) {
  const reversedChains = [...conn.chains].reverse()
  const first = reversedChains[0]
  const last = reversedChains.at(-1)
  const host = getConnectionHost(conn)
  const hostLabel = getConnectionHostLabel(conn)
  const source = getConnectionSourceLabel(conn)

  return (
    <TableRow className="hover:bg-muted/50 h-9.75 cursor-pointer opacity-60 transition-colors" onClick={() => onSelect(conn)}>
      <TableCell className="max-w-120 pl-3 text-[13px] md:max-w-40">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex w-fit max-w-full items-center gap-1 overflow-hidden text-left">
              {first && (
                <span className="flex shrink-0 items-center gap-1">
                  <ProxyIcon name={first} className="mr-0.5 size-4.5 shrink-0 object-contain" />
                  <span className="block whitespace-nowrap">{first}</span>
                </span>
              )}
              {reversedChains.length > 1 && (
                <>
                  <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />
                  <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                    <ProxyIcon name={last!} className="mr-0.5 size-4.5 shrink-0 object-contain" />
                    <span className="block truncate">{last}</span>
                  </span>
                </>
              )}
            </div>
          </TooltipTrigger>
          <ChainTooltip chains={reversedChains} />
        </Tooltip>
      </TableCell>
      <TableCell className="max-w-72 text-[13px] md:max-w-48">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex w-fit max-w-full items-center overflow-hidden">
              <span className="truncate">{host}</span>
              {conn.metadata.destinationPort && <span className="text-muted-foreground shrink-0">:{conn.metadata.destinationPort}</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[13px]" copyTextValue={hostLabel}>
            {hostLabel}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-muted-foreground max-w-64 text-[13px] md:max-w-47.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block w-fit max-w-full truncate">{source}</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[13px]" copyTextValue={source}>
            {source}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px]">
        <span className="flex items-center gap-2 whitespace-nowrap tabular-nums">
          <span>↑ {formatBytes(conn.upload)}</span>
          <span>↓ {formatBytes(conn.download)}</span>
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground text-[13px] tabular-nums">
        <TimeAgoCell isoString={conn.start} />
      </TableCell>
      <TableCell />
    </TableRow>
  )
})

const ConnectionDialogMeta = memo(function ConnectionDialogMeta({ conn }: { conn: Connection }) {
  const reversedChains = [...conn.chains].reverse()
  const asnIp = conn.metadata.destinationIP?.trim() ?? ''
  const [asnText, setAsnText] = useState<string | null>(() => (asnIp ? (asnCache.get(asnIp) ?? null) : null))
  const [asnLoading, setAsnLoading] = useState(() => !!asnIp && !asnCache.has(asnIp))

  useEffect(() => {
    if (!asnIp || asnCache.has(asnIp)) return

    let alive = true
    const timeoutId = setTimeout(() => {
      if (!alive) return
      alive = false
      setAsnLoading(false)
      setAsnText(null)
    }, 3000)

    fetch(`https://ipinfo.io/${encodeURIComponent(asnIp)}/json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data) => {
        if (!alive) return
        const text = formatAsn(data)
        asnCache.set(asnIp, text)
        setAsnText(text)
      })
      .catch(() => {
        if (!alive) return
        asnCache.set(asnIp, null)
        setAsnText(null)
      })
      .finally(() => {
        if (!alive) return
        setAsnLoading(false)
        clearTimeout(timeoutId)
      })

    return () => {
      alive = false
      clearTimeout(timeoutId)
    }
  }, [asnIp])

  return (
    <>
      <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase">Цепочка</p>
      <div className="mb-4 flex flex-wrap items-center gap-1">
        {reversedChains.map((chain, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <IconCircleArrowRightFilled size={13} className="text-muted-foreground shrink-0" />}
            <span className="bg-muted text-foreground flex items-center gap-1 rounded-md px-2 py-0.5 text-xs">
              <ProxyIcon name={chain} className="size-3.5 shrink-0 object-contain" />
              {chain || '—'}
            </span>
          </span>
        ))}
      </div>

      <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase">Правило</p>
      <div className="mb-4 text-xs">
        <span className="text-blue-400">{conn.rule}</span>
        {conn.rulePayload && <span className="text-muted-foreground ml-1">{conn.rulePayload}</span>}
      </div>

      <ConnectionDialogTraffic conn={conn} />

      <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase">Метаданные</p>
      <div className="border-border rounded-lg border px-3">
        <MetaRow label="Протокол" value={conn.metadata.network?.toUpperCase()} />
        <MetaRow label="Тип" value={conn.metadata.type} />
        <MetaRow label="IP источника" value={`${conn.metadata.sourceIP}:${conn.metadata.sourcePort}`} />
        <MetaRow label="IP назначения" value={`${conn.metadata.destinationIP}:${conn.metadata.destinationPort}`} />
        <MetaRow label="Хост назначения" value={conn.metadata.host} />
        <MetaRow label="Удалённый хост" value={conn.metadata.remoteDestination} />
        <MetaRow label="Sniff Host" value={conn.metadata.sniffHost} />
        <MetaRow label="DNS режим" value={conn.metadata.dnsMode} />
        <MetaRow label="Inbound" value={conn.metadata.inboundName} />
        <MetaRow label="Inbound адрес" value={`${conn.metadata.inboundIP}:${conn.metadata.inboundPort}`} />
        <MetaRow label="Процесс" value={conn.metadata.process || conn.metadata.processPath} />
        <MetaRow label="UID" value={conn.metadata.uid || undefined} />
        <MetaRow label="Начало" value={new Date(conn.start).toLocaleString()} />
        {asnIp && (
          <MetaRow
            label="ASN"
            value={
              asnLoading ? (
                <span className="text-muted-foreground inline-flex items-center gap-2">
                  <IconLoader2 size={14} className="animate-spin" />
                </span>
              ) : (
                (asnText ?? '—')
              )
            }
            force
          />
        )}
      </div>
    </>
  )
})

function ConnectionDialogTraffic({ conn }: { conn: Connection }) {
  return (
    <>
      <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase">Трафик</p>
      <div className="mb-4 flex gap-4 text-xs">
        <span>↑ {formatBytes(conn.upload)}</span>
        <span>↓ {formatBytes(conn.download)}</span>
      </div>
    </>
  )
}

const ConnectionDialogTitle = memo(function ConnectionDialogTitle({ conn }: { conn: Connection }) {
  const title = conn.metadata.host || conn.metadata.destinationIP || 'Соединение'
  return <DialogTitle className="truncate pr-8 text-base">{title}</DialogTitle>
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
  const frozenConn = useConnectionsStore((s) => (connId ? (s.closedMap.get(connId) ?? null) : null))
  const [snapshot, setSnapshot] = useState<Connection | null>(null)
  if (liveConn !== null && liveConn !== snapshot) setSnapshot(liveConn)
  const conn = liveConn ?? snapshot ?? frozenConn
  const isClosed = !!connId && !liveConn

  return (
    <Dialog open={!!connId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80dvh]! max-w-lg! flex-col overflow-hidden">
        <DialogHeader className="shrink-0">{conn && <ConnectionDialogTitle conn={conn} />}</DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
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

// ─── Tabs ──────────────────────────────────────────────────────────────────────

const ConnectionsTabs = memo(function ConnectionsTabs({
  activeTab,
  onTabChange,
}: {
  activeTab: 'active' | 'closed'
  onTabChange: (tab: 'active' | 'closed') => void
}) {
  const activeCount = useConnectionsStore((s) => s.map.size)
  const closedCount = useConnectionsStore((s) => s.closedMap.size)
  const triggerStyles = 'data-[state=active]:bg-background! data-[state=active]:text-foreground! data-[state=active]:shadow-sm!'

  return (
    <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as 'active' | 'closed')}>
      <TabsList>
        <TabsTrigger value="active" className={triggerStyles}>
          <IconActivity />
          <span className="text-xs tabular-nums">{activeCount}</span>
        </TabsTrigger>
        <TabsTrigger value="closed" className={triggerStyles}>
          <IconPlugX />
          <span className="text-xs tabular-nums">{closedCount}</span>
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
})

const CloseAllBtn = memo(function CloseAllBtn({ onCloseAll }: { onCloseAll: () => void }) {
  const totalCount = useConnectionsStore((s) => s.map.size)
  return (
    <Button
      variant="destructive"
      className="text-[13px] max-md:size-9 max-md:px-0 max-md:pr-0! max-md:pl-0!"
      onClick={onCloseAll}
      disabled={totalCount === 0}
    >
      <IconTrash className="md:hidden" />
      <IconTrash data-icon="inline-start" className="hidden md:block" />
      <span className="hidden md:inline">Закрыть все</span>
    </Button>
  )
})

// ─── Header ────────────────────────────────────────────────────────────────────

const ConnectionsHeader = memo(function ConnectionsHeader({
  filter,
  activeTab,
  onTabChange,
  onFilterChange,
  onClearFilter,
  onCloseAll,
}: {
  filter: string
  activeTab: 'active' | 'closed'
  onTabChange: (tab: 'active' | 'closed') => void
  onFilterChange: (v: string) => void
  onClearFilter: () => void
  onCloseAll: () => void
}) {
  return (
    <div className="border-border flex shrink-0 items-center gap-2 border-b p-3">
      <ConnectionsTabs activeTab={activeTab} onTabChange={onTabChange} />

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

      {activeTab === 'active' && <CloseAllBtn onCloseAll={onCloseAll} />}
    </div>
  )
})

// ─── Table head ────────────────────────────────────────────────────────────────

const columns: { key: SortColumn; label: string; className: string }[] = [
  { key: 'chains', label: 'Цепочка', className: 'w-[50%] pl-3 md:w-[35%]' },
  { key: 'host', label: 'Хост', className: 'w-[26%] md:w-[35%]' },
  { key: 'source', label: 'Источник', className: 'w-[14%] max-w-[220px] md:w-[10%] md:max-w-[190px]' },
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
  onApplyFilter,
}: {
  filter: string
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSelect: (conn: Connection) => void
  onClose: (id: string, e: React.MouseEvent) => void
  onApplyFilter: (value: string) => void
}) {
  const connected = useWsConnected()

  const filteredIds = useConnectionsStore(
    useShallow((s) => {
      const connections = Array.from(s.map.values())
      const query = filter.trim()
      let result = connections.filter((conn) => !conn.chains.some((c) => c.toLowerCase() === 'dns-out'))

      if (query) {
        result = result.filter((conn) => {
          const hostLabel = getConnectionHostLabel(conn)
          const sourceLabel = getConnectionSourceLabel(conn)
          return (
            conn.chains.some((c) => c.includes(query)) ||
            hostLabel.includes(query) ||
            conn.metadata.host.includes(query) ||
            conn.metadata.destinationIP.includes(query) ||
            sourceLabel.includes(query) ||
            conn.metadata.sourceIP.includes(query) ||
            conn.rule.includes(query) ||
            conn.rulePayload.includes(query)
          )
        })
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
          <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
            {!connected ? 'Подключение...' : filter ? 'Нет совпадений' : 'Нет активных соединений'}
          </TableCell>
        </TableRow>
      ) : (
        filteredIds.map((id) => <ConnectionRow key={id} connId={id} onSelect={onSelect} onClose={onClose} onApplyFilter={onApplyFilter} />)
      )}
    </TableBody>
  )
})

const ClosedConnectionsBody = memo(function ClosedConnectionsBody({
  filter,
  sortColumn,
  sortDirection,
  onSelect,
}: {
  filter: string
  sortColumn: SortColumn
  sortDirection: SortDirection
  onSelect: (conn: Connection) => void
}) {
  const filteredConns = useConnectionsStore(
    useShallow((s) => {
      const connections = Array.from(s.closedMap.values())
      const query = filter.trim()
      let result = connections.filter((conn) => !conn.chains.some((c) => c.toLowerCase() === 'dns-out'))
      if (query) {
        result = result.filter((conn) => {
          const hostLabel = getConnectionHostLabel(conn)
          const sourceLabel = getConnectionSourceLabel(conn)
          return (
            conn.chains.some((c) => c.includes(query)) ||
            hostLabel.includes(query) ||
            conn.metadata.host.includes(query) ||
            conn.metadata.destinationIP.includes(query) ||
            sourceLabel.includes(query) ||
            conn.metadata.sourceIP.includes(query) ||
            conn.rule.includes(query) ||
            conn.rulePayload.includes(query)
          )
        })
      }
      if (sortColumn) {
        result = [...result].sort((a, b) => {
          const valueA = getConnectionSortValue(a, sortColumn)
          const valueB = getConnectionSortValue(b, sortColumn)
          return sortDirection === 'asc' ? valueA.localeCompare(valueB) : valueB.localeCompare(valueA)
        })
      }
      return result
    })
  )

  return (
    <TableBody>
      {filteredConns.length === 0 ? (
        <TableRow>
          <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
            {filter ? 'Нет совпадений' : 'Нет закрытых соединений'}
          </TableCell>
        </TableRow>
      ) : (
        filteredConns.map((conn) => <ClosedConnectionRow key={conn.id} conn={conn} onSelect={onSelect} />)
      )}
    </TableBody>
  )
})

// ─── Main panel ────────────────────────────────────────────────────────────────

export function ConnectionsPanel({ clashApiPort, clashApiSecret, clashApiUnix }: Props) {
  const [filter, setFilter] = useState('')
  const [sortColumn, setSortColumn] = useState<SortColumn>('start')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'active' | 'closed'>('active')

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
    await clashFetch(clashApiPort, 'connections', { method: 'DELETE', secret: clashApiSecret, unix: clashApiUnix ?? null })
    setSelectedId(null)
  }, [clashApiPort, clashApiSecret, clashApiUnix])

  const clearFilter = useCallback(() => setFilter(''), [])
  const handleApplyFilter = useCallback((value: string) => setFilter(value), [])

  const handleCloseConnection = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation()
      await clashFetch(clashApiPort, `connections/${id}`, { method: 'DELETE', secret: clashApiSecret, unix: clashApiUnix ?? null })
      setSelectedId((prev) => (prev === id ? null : prev))
    },
    [clashApiPort, clashApiSecret, clashApiUnix]
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
    <TooltipProvider delayDuration={700} skipDelayDuration={0}>
      <div className="border-border bg-input-background absolute inset-4 flex flex-col overflow-hidden rounded-xl border">
        <ConnectionsHeader
          filter={filter}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onFilterChange={setFilter}
          onClearFilter={clearFilter}
          onCloseAll={closeAll}
        />
        <div className="flex-1 overflow-auto [scrollbar-width:thin]">
          <Table className="min-w-240 md:min-w-190">
            <ConnectionsTableHead sortColumn={sortColumn} sortDirection={sortDirection} onSort={toggleSort} />
            {activeTab === 'active' ? (
              <ConnectionsBody
                filter={filter}
                sortColumn={sortColumn}
                sortDirection={sortDirection}
                onSelect={handleSelectConnection}
                onClose={handleCloseConnection}
                onApplyFilter={handleApplyFilter}
              />
            ) : (
              <ClosedConnectionsBody
                filter={filter}
                sortColumn={sortColumn}
                sortDirection={sortDirection}
                onSelect={handleSelectConnection}
              />
            )}
          </Table>
        </div>
      </div>
      <ConnectionDialog connId={selectedId} onClose={handleCloseDialog} onCloseConnection={handleCloseDialogConnection} />
    </TooltipProvider>
  )
}
