import { Button } from '@/components/ui/button'
import { ShineBorder } from '@/components/ui/shine-border'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { IconBox, IconCpu, IconDatabase, IconLogout, IconPlayerPlayFilled, IconPlayerStopFilled, IconRefresh, IconSettings } from '@tabler/icons-react'
import { useEffect, useState, useCallback } from 'react'
import { apiCall, capitalize, clashFetch } from '../../lib/api'
import { ensureDnsEnabled, setDnsEnabled, DEFAULT_DNS_CONFIG } from '../configuration/mihomo/DnsPanel'
import {
  syncClashApiPort,
  getAppState,
  useAppContext,
  bumpDnsRefresh,
  setDnsStatus,
  setDnsStatusLoading,
  useDnsStatusStore,
} from '../../lib/store'
import { cn } from '../../lib/utils'

type SystemStats = { memoryUsed: number; memoryTotal: number; cpuUsage: number }

function formatMemoryMB(bytes: number) {
  if (!bytes) return '—'
  return Math.round(bytes / 1024 / 1024).toString()
}

function usageColorClass(percent: number) {
  if (percent >= 90) return 'text-red-500'
  if (percent >= 70) return 'text-amber-500'
  return 'text-muted-foreground'
}

async function applyAutoDns(setupFilter: boolean) {
  const configsResult = await apiCall<{ success: boolean; configs?: { file: string; content: string }[] }>('GET', 'configs')
  const yamlConfig = configsResult.success ? configsResult.configs?.find((c) => c.file.endsWith('/config.yaml')) : undefined
  if (!yamlConfig) return
  const configContent = ensureDnsEnabled(yamlConfig.content, DEFAULT_DNS_CONFIG)
  await apiCall('POST', 'dns', { config_content: configContent, setup_filter: setupFilter })
}

async function persistDnsEnabled(enabled: boolean) {
  const configsResult = await apiCall<{ success: boolean; configs?: { file: string; content: string }[] }>('GET', 'configs')
  const yamlConfig = configsResult.success ? configsResult.configs?.find((c) => c.file.endsWith('/config.yaml')) : undefined
  if (!yamlConfig) return
  const updated = setDnsEnabled(yamlConfig.content, enabled)
  await apiCall('PUT', 'configs', { file: yamlConfig.file, content: updated })
}

export function StatusBar({
  onOpenCoreManage,
  onOpenSettings,
  onRefreshStatus,
  onOpenUpdate,
  onLogout,
}: {
  onOpenCoreManage: () => void
  onOpenSettings: () => void
  onRefreshStatus: () => void
  onOpenUpdate: (core: string) => void
  onLogout: () => void
}) {
  const { state, dispatch, showToast } = useAppContext({ includeSettings: true })
  const { serviceStatus, pendingText, currentCore, coreVersions, isConfigsLoading, version, isOutdatedUI, isOutdatedCore, settings } = state
  const authEnabled = settings.authEnabled

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending' || serviceStatus === 'loading'

  const [dnsWarningOpen, setDnsWarningOpen] = useState(false)
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null)

  const fetchDnsStatus = useCallback(async () => {
    try {
      setDnsStatusLoading(true)
      const data = await apiCall<{ success: boolean; status?: { dnsOverride: boolean; dnsMihomo: boolean; providerIgnored: boolean } }>(
        'GET',
        'dns'
      )
      if (data.success && data.status) {
        setDnsStatus(data.status)
        return data.status.dnsOverride && data.status.dnsMihomo
      }
    } catch {
      // ignore
    }
    return false
  }, [])

  useEffect(() => {
    if (currentCore === 'mihomo') fetchDnsStatus()
  }, [fetchDnsStatus, currentCore])

  useEffect(() => {
    const interval = setInterval(() => {
      if (state.serviceStatus !== 'pending') onRefreshStatus()
    }, 3000)
    return () => clearInterval(interval)
  }, [state.serviceStatus, onRefreshStatus])

  useEffect(() => {
    let mounted = true
    const refreshSystemStats = async () => {
      try {
        const result = await apiCall<{ success: boolean } & SystemStats>('GET', 'system')
        if (mounted && result.success) setSystemStats(result)
      } catch {
        // The status panel remains usable if system statistics are unavailable.
      }
    }
    refreshSystemStats()
    const interval = setInterval(refreshSystemStats, 3000)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  function setPending(text: string) {
    dispatch({
      type: 'SET_SERVICE_STATUS',
      status: 'pending',
      pendingText: text,
    })
  }

  async function startService() {
    setPending('Запуск...')
    const result = await apiCall<any>('POST', 'control', { action: 'start' })
    showToast(result.success ? 'XKeen запущен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    if (!result.success) {
      dispatch({ type: 'SET_SERVICE_STATUS', status: 'stopped' })
      onRefreshStatus()
      return
    }
    syncClashApiPort()
    if (settings.autoDns !== 'disabled' && state.currentCore === 'mihomo') {
      await applyAutoDns(settings.autoDns === 'with_filter')
      const { clashApiPort, clashApiSecret, clashApiUnix } = getAppState()
      await clashFetch(clashApiPort ?? '', 'configs', { method: 'PUT', secret: clashApiSecret, unix: clashApiUnix, body: {} })
      bumpDnsRefresh()
    }
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'running' })
    onRefreshStatus()
  }

  async function stopService() {
    const cached = useDnsStatusStore.getState().status
    const enabled = currentCore === 'mihomo' && !!cached && cached.dnsOverride && cached.dnsMihomo
    if (enabled) {
      setDnsWarningOpen(true)
      return
    }
    setPending('Остановка...')
    const result = await apiCall<any>('POST', 'control', { action: 'stop' })
    showToast(result.success ? 'XKeen остановлен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    onRefreshStatus()
  }

  async function forceStopService() {
    setPending('Остановка...')
    const result = await apiCall<any>('POST', 'control', { action: 'stop' })
    showToast(result.success ? 'XKeen остановлен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    onRefreshStatus()
  }

  async function disableDnsAndStop() {
    setPending('Остановка...')
    try {
      await persistDnsEnabled(false)
      const result = await apiCall<{ success: boolean; error?: string }>('DELETE', 'dns', {})
      if (result.success) {
        showToast('Управление DNS отключено')
      } else {
        showToast(`Ошибка DNS: ${result.error}`, 'error')
      }
    } catch {
      showToast('Ошибка отключения DNS', 'error')
    }
    const stopResult = await apiCall<any>('POST', 'control', { action: 'stop' })
    showToast(
      stopResult.success ? 'XKeen остановлен' : `${stopResult.output || stopResult.error}`,
      stopResult.success ? 'success' : 'error'
    )
    onRefreshStatus()
  }

  async function restartService() {
    setPending('Перезапуск...')
    const result = await apiCall<any>('POST', 'control', { action: 'hardRestart' })
    showToast(result.success ? 'XKeen перезапущен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: result.success ? 'running' : 'stopped' })
    if (result.success) {
      syncClashApiPort()
    }
    onRefreshStatus()
  }

  const statusText = serviceStatus === 'running' ? 'Сервис запущен' : serviceStatus === 'stopped' ? 'Сервис остановлен' : pendingText || 'Загрузка...'

  return (
    <>
      <TooltipProvider delayDuration={500}>
        <div className="border-border bg-card relative z-40 flex shrink-0 flex-col justify-between gap-2 rounded-xl border px-3 py-3 sm:px-4 md:flex-row md:items-center">

          {/* Статус */}
          <div className="order-2 flex w-full items-center justify-center md:justify-start gap-1.5 md:order-1 md:w-auto">
            <div className="flex items-center rounded-lg border bg-muted/40 px-3 py-1">
              <div className="flex flex-col">
                <div className="flex items-center gap-1.75 pb-0.5">
                  <div className="relative flex size-2.5 shrink-0 items-center justify-center">
                    {isRunning && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
                    <span className={cn(
                      "relative inline-flex size-1.75 rounded-full",
                      isRunning ? "bg-emerald-500" : isPending ? "bg-amber-500 animate-pulse" : "bg-red-500"
                    )} />
                  </div>
                  <span className="text-xs font-medium text-foreground/80">
                    {statusText}
                  </span>
                </div>
                <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] tracking-tight text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <IconDatabase className="size-3" />
                    <span className={usageColorClass(((systemStats?.memoryUsed ?? 0) / (systemStats?.memoryTotal || 1)) * 100)}>
                      {formatMemoryMB(systemStats?.memoryUsed ?? 0)}/{formatMemoryMB(systemStats?.memoryTotal ?? 0)} МБ
                    </span>
                  </span>
                  <span className="h-3 w-px bg-border" />
                  <span className="flex items-center gap-1">
                    <IconCpu className="size-3" />
                    <span className={systemStats ? usageColorClass(systemStats.cpuUsage) : ''}>
                      {systemStats ? `${systemStats.cpuUsage.toFixed(0)}%` : '—'}
                    </span>
                  </span>
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {isConfigsLoading ? (
                <>
                  <Skeleton className="size-8 rounded-md" />
                  <Skeleton className="size-8 rounded-md" />
                </>
              ) : (
                <>
                  {isRunning && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="outline" size="icon" onClick={restartService} disabled={isPending}>
                            {isPending ? <Spinner className="size-4 text-muted-foreground" /> : <IconRefresh className="size-4" />}
                          </Button>
                        }
                      />
                      <TooltipContent>Перезапустить</TooltipContent>
                    </Tooltip>
                  )}
                  {!isRunning && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="outline" size="icon" className="text-emerald-500 hover:border-emerald-500/50 hover:text-emerald-400" onClick={startService} disabled={isPending}>
                            {isPending ? <Spinner className="size-4 text-muted-foreground" /> : <IconPlayerPlayFilled className="size-4" />}
                          </Button>
                        }
                      />
                      <TooltipContent>Запустить</TooltipContent>
                    </Tooltip>
                  )}
                  {isRunning && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="outline" size="icon" className="text-destructive hover:text-destructive/80" onClick={stopService} disabled={isPending}>
                            {isPending ? <Spinner className="size-4 text-muted-foreground" /> : <IconPlayerStopFilled className="size-4" />}
                          </Button>
                        }
                      />
                      <TooltipContent>Остановить</TooltipContent>
                    </Tooltip>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Логотип */}
          <div className="order-1 flex items-center justify-center md:absolute md:left-1/2 md:order-2 md:-translate-x-1/2">
            <a
              href="https://github.com/zxc-rv/XKeen-UI"
              target="_blank"
              rel="noreferrer"
              className="rounded-md transition-opacity hover:opacity-85"
            >
              <span className="bg-linear-to-r from-[#00D3F2] via-[#2B7FFF] to-[#155DFC] bg-clip-text text-[28px] font-semibold text-transparent">
                XKeen UI
              </span>
            </a>
          </div>

          {/* Правая сторона */}
          <div className="order-3 ml-auto flex w-full items-center justify-center gap-1.5 md:w-auto md:justify-end">
            {isConfigsLoading || !version ? (
              <Skeleton className="h-9 w-35.75" />
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="outline" onClick={onOpenCoreManage}>
                      <IconCpu data-icon="inline-start" className="size-4.5" />
                      <span className="text-[13px]">{capitalize(currentCore)}</span>
                      {coreVersions[currentCore] && (
                        <span className="text-muted-foreground/60 mt-0.5 text-xs">{coreVersions[currentCore]}</span>
                      )}
                      {isOutdatedCore && (
                        <span className="relative mb-3 -ml-0.75 flex">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-75" />
                          <span className="relative inline-flex size-1.75 rounded-full bg-blue-500" />
                        </span>
                      )}
                    </Button>
                  }
                />
                <TooltipContent>Управление ядром</TooltipContent>
              </Tooltip>
            )}
            {isConfigsLoading || !version ? (
              <Skeleton className="h-9 w-18.75" />
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      onClick={() => onOpenUpdate('self')}
                      className={cn(
                        'relative overflow-hidden text-xs tracking-wider',
                        isOutdatedUI ? 'border-none! text-cyan-300 hover:text-cyan-300' : ''
                      )}
                    >
                      {isOutdatedUI && <ShineBorder duration={7} borderWidth={2} shineColor={['#00D3F2', '#2B7FFF', '#155DFC']} />}
                      <IconBox data-icon="inline-start" className="size-4.5" />
                      {version}
                    </Button>
                  }
                />
                <TooltipContent>{isOutdatedUI ? 'Доступно обновление' : 'Версия XKeen UI'}</TooltipContent>
              </Tooltip>
            )}
            {isConfigsLoading || !version ? (
              <Skeleton className="size-9" />
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="outline" size="icon" onClick={onOpenSettings}>
                      <IconSettings className="size-4.5" />
                    </Button>
                  }
                />
                <TooltipContent>Настройки</TooltipContent>
              </Tooltip>
            )}
            {authEnabled &&
              (isConfigsLoading || !version ? (
                <Skeleton className="size-9" />
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button variant="outline" size="icon" onClick={onLogout}>
                        <IconLogout className="size-4.5" />
                      </Button>
                    }
                  />
                  <TooltipContent>Выйти</TooltipContent>
                </Tooltip>
              ))}
          </div>
        </div>
      </TooltipProvider>

      <AlertDialog open={dnsWarningOpen} onOpenChange={setDnsWarningOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Внимание</AlertDialogTitle>
            <AlertDialogDescription>
              Включено управление DNS, при остановке сервиса пропадет доступ в интернет. Отключить управление?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDnsWarningOpen(false)}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={() => {
                setDnsWarningOpen(false)
                forceStopService()
              }}
            >
              Не отключать
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                setDnsWarningOpen(false)
                disableDnsAndStop()
              }}
            >
              Отключить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
