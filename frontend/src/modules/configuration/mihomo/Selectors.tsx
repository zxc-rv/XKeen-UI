import { useEffect, useState, useCallback, useMemo } from "react";
import { IconRefresh, IconLoader2 } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

interface ProxyHistory {
  time: string;
  delay: number;
}

interface ProxyInfo {
  name: string;
  type: string;
  udp: boolean;
  uot?: boolean;
  xudp?: boolean;
  alive: boolean;
  hidden?: boolean;
  now?: string;
  all?: string[];
  history: ProxyHistory[];
  "provider-name"?: string;
  icon?: string;
}

type ClashMode = "rule" | "global" | "direct";

const NO_DELAY_TYPES = new Set(["reject", "dns", "pass", "relay"]);

interface Props {
  dashboardPort: string;
  mode: ClashMode;
}

function getLastDelay(proxy: ProxyInfo): number | null {
  if (NO_DELAY_TYPES.has(proxy.type.toLowerCase())) return null;
  const history = proxy.history;
  return history.length > 0 ? history[history.length - 1].delay : null;
}

function delayColor(delay: number | null): string {
  if (delay === null) return "text-muted-foreground";
  if (delay < 300) return "text-green-400";
  if (delay < 600) return "text-yellow-400";
  return "text-red-400";
}

function ProxyTransportLabel({ proxy }: { proxy: ProxyInfo }) {
  const type = proxy.type.toLowerCase();
  const transport = proxy.xudp ? "xudp" : proxy.udp ? "udp" : "tcp";
  return (
    <span className="text-muted-foreground text-xs">
      {type} / {transport}
    </span>
  );
}

export function SelectorsPanel({ dashboardPort, mode }: Props) {
  const [proxies, setProxies] = useState<Record<string, ProxyInfo>>({});
  const [loading, setLoading] = useState(true);
  const [testingAll, setTestingAll] = useState<Record<string, boolean>>({});
  const [testingSingle, setTestingSingle] = useState<Record<string, boolean>>(
    {},
  );

  const baseUrl = `http://${location.hostname}:${dashboardPort}`;

  const fetchProxies = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/proxies`);
      const data = await res.json();
      if (data.proxies) setProxies(data.proxies);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    fetchProxies();
  }, [baseUrl, fetchProxies]);

  async function selectProxy(selectorName: string, proxyName: string) {
    await fetch(`${baseUrl}/proxies/${encodeURIComponent(selectorName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: proxyName }),
    });
    setProxies((prev) => ({
      ...prev,
      [selectorName]: { ...prev[selectorName], now: proxyName },
    }));

    try {
      const res = await fetch(`${baseUrl}/connections`);
      const data = await res.json();
      const affected: string[] = (data.connections ?? [])
        .filter(
          (conn: any) =>
            Array.isArray(conn.chains) &&
            conn.chains.some((c: string) => c === selectorName),
        )
        .map((conn: any) => conn.id);
      await Promise.all(
        affected.map((id) =>
          fetch(`${baseUrl}/connections/${id}`, { method: "DELETE" }),
        ),
      );
    } catch {}
  }

  async function testDelay(proxyName: string): Promise<number | null> {
    try {
      const res = await fetch(
        `${baseUrl}/proxies/${encodeURIComponent(proxyName)}/delay?url=https://www.gstatic.com/generate_204&timeout=5000`,
      );
      const data = await res.json();
      return data.delay ?? null;
    } catch {
      return null;
    }
  }

  function applyDelayResult(proxyName: string, delay: number | null) {
    setProxies((prev) => {
      const proxy = prev[proxyName];
      if (!proxy) return prev;
      const newHistory =
        delay !== null
          ? [...proxy.history, { time: new Date().toISOString(), delay }].slice(
              -10,
            )
          : proxy.history;
      return {
        ...prev,
        [proxyName]: { ...proxy, history: newHistory, alive: delay !== null },
      };
    });
  }

  async function testAll(selectorName: string) {
    const selector = proxies[selectorName];
    if (!selector?.all) return;
    setTestingAll((prev) => ({ ...prev, [selectorName]: true }));
    await Promise.all(
      selector.all
        .filter((name) => {
          const p = proxies[name];
          return !p || !NO_DELAY_TYPES.has(p.type.toLowerCase());
        })
        .map(async (proxyName) => {
          const delay = await testDelay(proxyName);
          applyDelayResult(proxyName, delay);
        }),
    );
    setTestingAll((prev) => ({ ...prev, [selectorName]: false }));
  }

  async function testSingle(proxyName: string) {
    setTestingSingle((prev) => ({ ...prev, [proxyName]: true }));
    const delay = await testDelay(proxyName);
    applyDelayResult(proxyName, delay);
    setTestingSingle((prev) => ({ ...prev, [proxyName]: false }));
  }

  const selectors = useMemo(() => {
    const allSelectors = Object.values(proxies).filter((p) => {
      if (p.type !== "Selector") return false;
      if (p.hidden) return false;
      if (mode === "global") return p.name === "GLOBAL";
      return p.name !== "GLOBAL";
    });

    const globalProxy = proxies["GLOBAL"];
    if (!globalProxy?.all) return allSelectors;

    const globalOrder = globalProxy.all.filter(
      (name) => proxies[name]?.type === "Selector",
    );
    const orderMap = new Map(globalOrder.map((name, i) => [name, i]));

    return [...allSelectors].sort((a, b) => {
      const indexA = orderMap.get(a.name) ?? Infinity;
      const indexB = orderMap.get(b.name) ?? Infinity;
      return indexA - indexB;
    });
  }, [proxies, mode]);

  if (loading) {
    return (
      <div className="absolute inset-4 rounded-md border border-border bg-input-background flex items-center justify-center text-muted-foreground text-sm">
        Загрузка...
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute inset-4 rounded-md overflow-hidden border border-border bg-input-background flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {selectors.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Селекторы не найдены
            </div>
          ) : (
            selectors.map((selector) => {
              const allProxies = selector.all ?? [];
              const isTesting = testingAll[selector.name];

              return (
                <div key={selector.name}>
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex items-center gap-2 min-w-0 pl-0.5">
                      {selector.icon && (
                        <img
                          src={selector.icon}
                          alt=""
                          className="size-6 shrink-0 object-contain rounded-sm"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display =
                              "none";
                          }}
                        />
                      )}
                      <span className="font-medium text-[15px] truncate">
                        {selector.name}
                      </span>
                      <span className="text-muted-foreground text-xs shrink-0">
                        Selector ({allProxies.length})
                      </span>
                      {selector.now && (
                        <span className="text-muted-foreground text-xs truncate hidden sm:block">
                          {selector.now}
                        </span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs shrink-0"
                      onClick={() => testAll(selector.name)}
                      disabled={isTesting}
                    >
                      {isTesting ? (
                        <IconLoader2 size={13} className="animate-spin" />
                      ) : (
                        <IconRefresh size={13} />
                      )}
                      Проверить
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                    {allProxies.map((proxyName) => {
                      const proxy = proxies[proxyName];
                      const delay = proxy ? getLastDelay(proxy) : null;
                      const isActive = selector.now === proxyName;
                      const showDelay =
                        proxy && !NO_DELAY_TYPES.has(proxy.type.toLowerCase());
                      const isTestingSingle = testingSingle[proxyName];

                      return (
                        <Tooltip key={proxyName}>
                          <TooltipTrigger asChild>
                            <div
                              className={cn(
                                "flex flex-col gap-2 px-3 py-2.5 rounded-sm border cursor-pointer transition-all text-sm",
                                isActive
                                  ? "border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15"
                                  : "border-ring/40 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] hover:border-[#60a5fa] hover:bg-linear-to-b hover:from-blue-500/15 hover:to-blue-500/5",
                                !proxy?.alive && proxy && "opacity-50",
                              )}
                              onClick={() =>
                                selectProxy(selector.name, proxyName)
                              }
                            >
                              {/* 1-я строка — только имя */}
                              <span className="text-xs font-medium truncate">
                                {proxyName}
                              </span>

                              {/* 2-я строка — transport + delay справа */}
                              <div className="flex items-center justify-between gap-1">
                                {proxy && <ProxyTransportLabel proxy={proxy} />}

                                {showDelay && (
                                  <span
                                    className={cn(
                                      "text-xs tabular-nums shrink-0 font-medium transition-opacity",
                                      delayColor(delay),
                                      isTestingSingle && "opacity-40",
                                    )}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!isTestingSingle)
                                        testSingle(proxyName);
                                    }}
                                  >
                                    {isTestingSingle ? (
                                      <Spinner />
                                    ) : (
                                      (delay ?? "—")
                                    )}
                                  </span>
                                )}
                              </div>
                            </div>
                          </TooltipTrigger>

                          {proxy && (
                            <TooltipContent side="top">
                              {proxyName} · {proxy.type}
                              {showDelay && delay !== null
                                ? ` · ${delay}ms`
                                : ""}
                            </TooltipContent>
                          )}
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
