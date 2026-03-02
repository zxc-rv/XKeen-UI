import { useEffect, useRef, useState, useMemo } from "react";
import {
  IconX,
  IconTrash,
  IconWifi,
  IconWifiOff,
  IconArrowUp,
  IconArrowDown,
  IconArrowsSort,
  IconSearch,
  IconCircleArrowRightFilled,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ProxyInfo {
  name: string;
  type: string;
  icon?: string;
}

interface ConnectionMetadata {
  network: string;
  type: string;
  sourceIP: string;
  destinationIP: string;
  sourcePort: string;
  destinationPort: string;
  inboundIP: string;
  inboundPort: string;
  inboundName: string;
  host: string;
  dnsMode: string;
  uid: number;
  process: string;
  processPath: string;
  remoteDestination: string;
  sniffHost: string;
}

interface Connection {
  id: string;
  metadata: ConnectionMetadata;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  providerChains: string[];
  rule: string;
  rulePayload: string;
}

type SortColumn = "host" | "chains" | "source" | "start" | null;
type SortDirection = "asc" | "desc";

interface Props {
  dashboardPort: string;
}

function SortIcon({
  column,
  sortColumn,
  sortDirection,
}: {
  column: SortColumn;
  sortColumn: SortColumn;
  sortDirection: SortDirection;
}) {
  if (sortColumn !== column)
    return <IconArrowsSort size={13} className="opacity-30" />;
  return sortDirection === "asc" ? (
    <IconArrowUp size={13} className="text-primary" />
  ) : (
    <IconArrowDown size={13} className="text-primary" />
  );
}

function getConnectionSortValue(conn: Connection, column: SortColumn): string {
  switch (column) {
    case "host":
      return conn.metadata.host || conn.metadata.destinationIP;
    case "chains":
      return conn.chains[0] ?? "";
    case "source":
      return conn.metadata.sourceIP;
    case "start":
      return conn.start;
    default:
      return "";
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function timeAgo(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60)
    return `${diffSec} ${pluralize(diffSec, "сек", "сек", "сек")} назад`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)
    return `${diffMin} ${pluralize(diffMin, "мин", "мин", "мин")} назад`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24)
    return `${diffHour} ${pluralize(diffHour, "час", "часа", "часов")} назад`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} ${pluralize(diffDay, "день", "дня", "дней")} назад`;
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex gap-2 py-1.5 border-b border-border last:border-0">
      <span className="text-muted-foreground shrink-0 w-40 text-xs">
        {label}
      </span>
      <span className="text-xs break-all">{String(value)}</span>
    </div>
  );
}

function WithTooltip({
  content,
  children,
}: {
  content: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{content}</TooltipContent>
    </Tooltip>
  );
}

export function ConnectionsPanel({ dashboardPort }: Props) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortColumn, setSortColumn] = useState<SortColumn>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [selectedConnection, setSelectedConnection] =
    useState<Connection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const lastSelectedRef = useRef<Connection | null>(null);
  const [proxies, setProxies] = useState<Record<string, ProxyInfo>>({});

  const baseUrl = `http://${location.hostname}:${dashboardPort}`;
  const wsUrl = `ws://${location.hostname}:${dashboardPort}/connections?interval=1000`;

  useEffect(() => {
    function connect() {
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current)
        clearTimeout(reconnectTimeoutRef.current);

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        setConnected(false);
        reconnectTimeoutRef.current = setTimeout(connect, 2000);
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (Array.isArray(data.connections)) setConnections(data.connections);
        } catch {}
      };
    }

    connect();

    fetch(`http://${location.hostname}:${dashboardPort}/proxies`)
      .then((r) => r.json())
      .then((data) => {
        if (data.proxies) setProxies(data.proxies);
      })
      .catch(() => {});

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          connect();
        }
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (reconnectTimeoutRef.current)
        clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, [wsUrl]);

  function toggleSort(column: SortColumn) {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  const filteredAndSorted = useMemo(() => {
    const query = filter.toLowerCase().trim();
    let result = connections.filter(
      (conn) => !conn.chains.some((c) => c.toLowerCase() === "dns-out"),
    );
    result = query
      ? result.filter(
          (conn) =>
            conn.chains.some((c) => c.toLowerCase().includes(query)) ||
            conn.metadata.host.toLowerCase().includes(query) ||
            conn.metadata.destinationIP.includes(query) ||
            conn.metadata.sourceIP.includes(query) ||
            conn.rule.toLowerCase().includes(query) ||
            conn.rulePayload.toLowerCase().includes(query),
        )
      : result;

    if (sortColumn) {
      result = [...result].sort((a, b) => {
        const valueA = getConnectionSortValue(a, sortColumn);
        const valueB = getConnectionSortValue(b, sortColumn);
        return sortDirection === "asc"
          ? valueA.localeCompare(valueB)
          : valueB.localeCompare(valueA);
      });
    }
    return result;
  }, [connections, filter, sortColumn, sortDirection]);

  async function closeConnection(id: string) {
    await fetch(`${baseUrl}/connections/${id}`, { method: "DELETE" });
    if (selectedConnection?.id === id) setSelectedConnection(null);
  }

  async function closeAll() {
    await fetch(`${baseUrl}/connections`, { method: "DELETE" });
    setConnections([]);
    setSelectedConnection(null);
  }

  const selected = selectedConnection
    ? (connections.find((c) => c.id === selectedConnection.id) ??
      selectedConnection)
    : null;

  if (selected) lastSelectedRef.current = selected;
  const displayedConnection = selected ?? lastSelectedRef.current;

  const columns: { key: SortColumn; label: string; className?: string }[] = [
    { key: "host", label: "Хост", className: "min-w-40" },
    { key: "chains", label: "Цепочка", className: "min-w-32" },
    { key: "source", label: "Источник", className: "min-w-32" },
    { key: "start", label: "Время", className: "min-w-24" },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute inset-4 rounded-md overflow-hidden border border-border bg-input-background flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground shrink-0">
            {connected ? (
              <IconWifi size={15} className="text-green-400" />
            ) : (
              <IconWifiOff size={15} className="text-red-400" />
            )}
            <span className="tabular-nums">
              {filteredAndSorted.length}
              {filter ? `/${connections.length}` : ""}
            </span>
          </div>
          <div className="relative flex-1">
            <IconSearch
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Фильтр"
              className={`h-9 pl-7 text-xs ${filter ? "pr-7" : ""}`}
            />
            {filter && (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setFilter("")}
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
                  <TableHead
                    key={col.key}
                    className={`cursor-pointer select-none ${col.className ?? ""}`}
                    onClick={() => toggleSort(col.key)}
                  >
                    <span className="flex items-center gap-1">
                      {col.label}
                      <SortIcon
                        column={col.key}
                        sortColumn={sortColumn}
                        sortDirection={sortDirection}
                      />
                    </span>
                  </TableHead>
                ))}
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAndSorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center text-muted-foreground py-8"
                  >
                    {!connected
                      ? "Подключение..."
                      : filter
                        ? "Нет совпадений"
                        : "Нет активных соединений"}
                  </TableCell>
                </TableRow>
              ) : (
                filteredAndSorted.map((conn) => {
                  const host =
                    conn.metadata.host || conn.metadata.destinationIP;
                  const hostFull = `${host}:${conn.metadata.destinationPort}`;
                  const reversedChains = [...conn.chains].reverse();
                  const chainsFull = reversedChains.join(" → ");

                  return (
                    <TableRow
                      key={conn.id}
                      className="cursor-pointer"
                      onClick={() => setSelectedConnection(conn)}
                    >
                      <TableCell className="text-[13px] max-w-48">
                        <WithTooltip content={hostFull}>
                          <span className="block truncate">
                            {host}
                            {conn.metadata.destinationPort && (
                              <span className="text-muted-foreground">
                                :{conn.metadata.destinationPort}
                              </span>
                            )}
                          </span>
                        </WithTooltip>
                      </TableCell>
                      <TableCell className="text-[13px] max-w-40">
                        <WithTooltip content={chainsFull}>
                          <div className="flex items-center gap-1 min-w-0">
                            {reversedChains.length > 0 &&
                              (() => {
                                const icon = proxies[reversedChains[0]]?.icon;
                                return (
                                  <div className="flex items-center gap-1 min-w-0 shrink truncate">
                                    {icon && (
                                      <img
                                        src={icon}
                                        alt=""
                                        className="size-3.5 shrink-0 object-contain"
                                        onError={(e) => {
                                          (
                                            e.target as HTMLImageElement
                                          ).style.display = "none";
                                        }}
                                      />
                                    )}
                                    <span className="truncate">
                                      {reversedChains[0]}
                                    </span>
                                  </div>
                                );
                              })()}
                            {reversedChains.length > 1 &&
                              (() => {
                                const last =
                                  reversedChains[reversedChains.length - 1];
                                const icon = proxies[last]?.icon;
                                return (
                                  <>
                                    <IconCircleArrowRightFilled
                                      size={13}
                                      className="text-muted-foreground shrink-0"
                                    />
                                    <div className="flex items-center gap-1 min-w-0 shrink truncate">
                                      {icon && (
                                        <img
                                          src={icon}
                                          alt=""
                                          className="size-3.5 shrink-0 object-contain"
                                          onError={(e) => {
                                            (
                                              e.target as HTMLImageElement
                                            ).style.display = "none";
                                          }}
                                        />
                                      )}
                                      <span className="truncate">{last}</span>
                                    </div>
                                  </>
                                );
                              })()}
                          </div>
                        </WithTooltip>
                      </TableCell>
                      <TableCell className="text-[13px] text-muted-foreground">
                        <WithTooltip
                          content={`${conn.metadata.sourceIP}:${conn.metadata.sourcePort}`}
                        >
                          <span>
                            {conn.metadata.sourceIP}
                            <span className="opacity-60">
                              :{conn.metadata.sourcePort}
                            </span>
                          </span>
                        </WithTooltip>
                      </TableCell>
                      <TableCell className="text-[13px] text-muted-foreground tabular-nums">
                        {timeAgo(conn.start)}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-muted-foreground hover:text-red-400"
                          onClick={(e) => {
                            e.stopPropagation();
                            closeConnection(conn.id);
                          }}
                        >
                          <IconX size={13} />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog
        open={!!selected}
        onOpenChange={(open) => !open && setSelectedConnection(null)}
      >
        <DialogContent className="max-w-lg! overflow-hidden flex flex-col max-h-[80dvh]!">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-base truncate pr-8">
              {displayedConnection?.metadata.host ||
                displayedConnection?.metadata.destinationIP ||
                "Соединение"}
            </DialogTitle>
          </DialogHeader>

          <div className="overflow-y-auto flex-1 min-h-0 -mx-6 px-6">
            {displayedConnection && (
              <>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  Цепочка
                </p>
                <div className="mb-4 flex flex-wrap gap-1">
                  {[...displayedConnection.chains].reverse().map((chain, i) => (
                    <span
                      key={i}
                      className="text-xs px-2 py-0.5 rounded-md bg-muted text-foreground"
                    >
                      {chain || "—"}
                    </span>
                  ))}
                </div>

                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  Правило
                </p>
                <div className="mb-4 text-xs">
                  <span className="text-blue-400">
                    {displayedConnection.rule}
                  </span>
                  {displayedConnection.rulePayload && (
                    <span className="text-muted-foreground ml-1">
                      {displayedConnection.rulePayload}
                    </span>
                  )}
                </div>

                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  Трафик
                </p>
                <div className="mb-4 flex gap-4 text-xs">
                  <span>↑ {formatBytes(displayedConnection.upload)}</span>
                  <span>↓ {formatBytes(displayedConnection.download)}</span>
                </div>

                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  Метаданные
                </p>
                <div className="rounded-lg border border-border px-3 mb-4">
                  <MetaRow
                    label="Протокол"
                    value={displayedConnection.metadata.network}
                  />
                  <MetaRow
                    label="Тип"
                    value={displayedConnection.metadata.type}
                  />
                  <MetaRow
                    label="Хост"
                    value={displayedConnection.metadata.host}
                  />
                  <MetaRow
                    label="Источник"
                    value={`${displayedConnection.metadata.sourceIP}:${displayedConnection.metadata.sourcePort}`}
                  />
                  <MetaRow
                    label="Назначение"
                    value={`${displayedConnection.metadata.destinationIP}:${displayedConnection.metadata.destinationPort}`}
                  />
                  <MetaRow
                    label="Удалённый хост"
                    value={displayedConnection.metadata.remoteDestination}
                  />
                  <MetaRow
                    label="Sniff Host"
                    value={displayedConnection.metadata.sniffHost}
                  />
                  <MetaRow
                    label="DNS режим"
                    value={displayedConnection.metadata.dnsMode}
                  />
                  <MetaRow
                    label="Inbound"
                    value={displayedConnection.metadata.inboundName}
                  />
                  <MetaRow
                    label="Inbound адрес"
                    value={`${displayedConnection.metadata.inboundIP}:${displayedConnection.metadata.inboundPort}`}
                  />
                  <MetaRow
                    label="Процесс"
                    value={
                      displayedConnection.metadata.process ||
                      displayedConnection.metadata.processPath
                    }
                  />
                  <MetaRow
                    label="UID"
                    value={displayedConnection.metadata.uid || undefined}
                  />
                  <MetaRow
                    label="Начало"
                    value={new Date(displayedConnection.start).toLocaleString()}
                  />
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
                onClick={() => closeConnection(displayedConnection.id)}
              >
                <IconX size={13} /> Закрыть соединение
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
