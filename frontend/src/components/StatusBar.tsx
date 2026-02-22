import { useEffect } from "react"
import { IconPlayerPlay, IconRefresh, IconSettings, IconCpu, IconPlayerStopFilled } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "../lib/utils"
import { useAppContext } from "../store"
import { apiCall, capitalize } from "../lib/api"

export function StatusBar({
  onOpenCoreManage,
  onOpenSettings,
  onOpenUpdate,
}: {
  onOpenCoreManage: () => void
  onOpenSettings: () => void
  onOpenUpdate: (core: string) => void
}) {
  const { state, dispatch, showToast } = useAppContext()
  const { serviceStatus, pendingText, currentCore, coreVersions, isConfigsLoading, version, isOutdatedUI } = state

  const isRunning = serviceStatus === "running"
  const isPending = serviceStatus === "pending" || serviceStatus === "loading"

  useEffect(() => {
    const interval = setInterval(() => {
      if (state.serviceStatus !== "pending") checkStatus()
    }, 15000)
    return () => clearInterval(interval)
  }, [state.serviceStatus])

  async function checkStatus() {
    try {
      const data = await apiCall<any>("GET", "control")
      if (!data.success) return
      dispatch({
        type: "SET_CORE_INFO",
        currentCore: data.currentCore || "xray",
        coreVersions: data.versions || { xray: "", mihomo: "" },
        availableCores: data.cores || [],
      })
      dispatch({ type: "SET_SERVICE_STATUS", status: data.running ? "running" : "stopped" })
    } catch {
      /* ok */
    }
  }

  function setPending(text: string) {
    dispatch({ type: "SET_SERVICE_STATUS", status: "pending", pendingText: text })
  }

  async function startService() {
    setPending("Запуск...")
    const result = await apiCall<any>("POST", "control", { action: "start" })
    showToast(result.success ? "XKeen запущен" : `Ошибка запуска: ${result.output || result.error}`, result.success ? "success" : "error")
    dispatch({ type: "SET_SERVICE_STATUS", status: result.success ? "running" : "stopped" })
    checkStatus()
  }

  async function stopService() {
    setPending("Остановка...")
    const result = await apiCall<any>("POST", "control", { action: "stop" })
    showToast(
      result.success ? "XKeen остановлен" : `Ошибка остановки: ${result.output || result.error}`,
      result.success ? "success" : "error",
    )
    checkStatus()
  }

  async function restartService() {
    setPending("Перезапуск...")
    const result = await apiCall<any>("POST", "control", { action: "hardRestart" })
    showToast(
      result.success ? "XKeen перезапущен" : `Ошибка перезапуска: ${result.output || result.error}`,
      result.success ? "success" : "error",
    )
    checkStatus()
  }

  const statusLabel =
    serviceStatus === "running" ? "Сервис запущен" : serviceStatus === "stopped" ? "Сервис остановлен" : pendingText || "Загрузка..."

  const badgeClasses = cn(
    "status-badge-custom",
    serviceStatus === "running" && "status-badge-running",
    (serviceStatus === "pending" || serviceStatus === "loading") && "status-badge-pending",
    serviceStatus === "stopped" && "status-badge-stopped",
  )

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-3 sm:p-4 rounded-xl border border-border bg-card shrink-0 z-40 relative">
        {/* Левая часть (на десктопе), вторая строка (на мобиле) */}
        <div className="flex flex-wrap items-center justify-center md:justify-start gap-1.5 order-2 md:order-1">
          <div className={badgeClasses}>{statusLabel}</div>
          <div className="flex items-center gap-1.5">
            {isConfigsLoading ? (
              <>
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-8 w-8 rounded-md" />
              </>
            ) : (
              <>
                {isRunning && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon" className="h-8 w-8" onClick={restartService} disabled={isPending}>
                        {isPending ? <Spinner className="size-4 text-muted-foreground" /> : <IconRefresh size={15} />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Перезапустить</TooltipContent>
                  </Tooltip>
                )}
                {!isRunning && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 text-green-500 hover:text-green-400 hover:border-green-500/50"
                        onClick={startService}
                        disabled={isPending}
                      >
                        {isPending ? <Spinner className="size-4 text-muted-foreground" /> : <IconPlayerPlay size={15} />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Запустить</TooltipContent>
                  </Tooltip>
                )}
                {isRunning && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive hover:border-destructive/50"
                        onClick={stopService}
                        disabled={isPending}
                      >
                        {isPending ? <Spinner className="size-4 text-muted-foreground" /> : <IconPlayerStopFilled size={15} />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Остановить</TooltipContent>
                  </Tooltip>
                )}
              </>
            )}
          </div>
        </div>

        {/* Центр (на десктопе), первая строка (на мобиле) */}
        <div className="flex justify-center items-center order-1 md:order-2 md:absolute md:left-1/2 md:-translate-x-1/2">
          <h1 className="text-[24px] sm:text-[28px] font-semibold bg-linear-to-r from-cyan-400 via-blue-500 to-blue-600 bg-clip-text text-transparent animate-dark-glow">
            XKeen UI
          </h1>
          {version && (
            <Button
              variant="ghost"
              onClick={() => onOpenUpdate("self")}
              className={cn(
                "cursor-pointer text-xs h-3 items-start tracking-wide",
                isOutdatedUI
                  ? "bg-yellow-500/10 text-yellow-500 border-yellow-500/20 hover:bg-yellow-500/20"
                  : "text-blue-400 hover:bg-blue-500/0!",
              )}
            >
              v{version}
            </Button>
          )}
        </div>

        {/* Правая часть (на десктопе), третья строка (на мобиле) */}
        <div className="flex items-center justify-center md:justify-end gap-1.5 order-3 ml-auto w-full md:w-auto">
          {isConfigsLoading ? (
            <Skeleton className="h-9 w-32 rounded-md" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="h-9 gap-2" onClick={onOpenCoreManage}>
                  <IconCpu className="text-muted-foreground size-5" />
                  <span className="text-[13px]">{capitalize(currentCore)}</span>
                  {coreVersions[currentCore as keyof typeof coreVersions] && (
                    <span className="text-xs mt-0.5 text-muted-foreground/60">
                      {coreVersions[currentCore as keyof typeof coreVersions]}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Управление ядром</TooltipContent>
            </Tooltip>
          )}
          {isConfigsLoading ? (
            <Skeleton className="h-9 w-9 rounded-md" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="h-9 w-9" onClick={onOpenSettings}>
                  <IconSettings className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Настройки</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
