import { Button } from '@/components/ui/button'
import { ShineBorder } from '@/components/ui/shine-border'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IconBox, IconCpu, IconLogout, IconPlayerPlayFilled, IconPlayerStopFilled, IconRefresh, IconSettings } from '@tabler/icons-react'
import { useEffect } from 'react'
import { apiCall, capitalize } from '../../lib/api'
import { syncClashApiPort, useAppContext } from '../../lib/store'
import { cn } from '../../lib/utils'
import type { ServiceStatus } from '../../lib/types'

function StatusWaveform({ status }: { status: ServiceStatus }) {
  const isStopped = status === 'stopped'
  const color = isStopped
    ? 'color-mix(in srgb, var(--status-badge-stopped-color) 30%, transparent)'
    : status === 'running'
      ? 'color-mix(in srgb, var(--status-running-color) 35%, transparent)'
      : 'color-mix(in srgb, var(--status-pending-color) 35%, transparent)'

  return (
    <svg aria-hidden="true" className="status-badge-wave" viewBox="0 0 200 36" preserveAspectRatio="none" fill="none">
      {isStopped ? (
        <line x1="0" y1="18" x2="200" y2="18" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      ) : (
        <path
          d="M 0,18 L 22,18 L 26,14.5 L 30,18 L 36,18 L 39,21 L 43,4 L 47,30 L 51,18 L 57,13.5 L 63,18 L 112,18 L 116,14.5 L 120,18 L 126,18 L 129,21 L 133,4 L 137,30 L 141,18 L 147,13.5 L 153,18 L 200,18"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  )
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

  useEffect(() => {
    const interval = setInterval(() => {
      if (state.serviceStatus !== 'pending') onRefreshStatus()
    }, 15000)
    return () => clearInterval(interval)
  }, [state.serviceStatus, onRefreshStatus])

  function setPending(text: string) {
    dispatch({
      type: 'SET_SERVICE_STATUS',
      status: 'pending',
      pendingText: text,
    })
  }

  async function startService() {
    setPending('Запуск сервиса...')
    const result = await apiCall<any>('POST', 'control', { action: 'start' })
    showToast(result.success ? 'XKeen запущен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: result.success ? 'running' : 'stopped' })
    if (result.success) {
      syncClashApiPort()
    }
    onRefreshStatus()
  }

  async function stopService() {
    setPending('Остановка сервиса...')
    const result = await apiCall<any>('POST', 'control', { action: 'stop' })
    showToast(result.success ? 'XKeen остановлен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
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

  const statusLabel =
    serviceStatus === 'running' ? 'Сервис запущен' : serviceStatus === 'stopped' ? 'Сервис остановлен' : pendingText || 'Загрузка...'

  const badgeClasses = cn(
    'status-badge-custom',
    isRunning && 'status-badge-running',
    isPending && 'status-badge-pending',
    serviceStatus === 'stopped' && 'status-badge-stopped'
  )

  return (
    <TooltipProvider delayDuration={500}>
      <div className="border-border bg-card relative z-40 flex shrink-0 flex-col justify-between gap-3 rounded-xl border p-3 sm:p-4 md:flex-row md:items-center">
        <div className="order-2 flex flex-wrap items-center justify-center gap-1.5 md:order-1 md:justify-start">
          <div className={badgeClasses}>
            <StatusWaveform status={serviceStatus} />
            {statusLabel}
          </div>
          <div className="flex items-center gap-1.5">
            {isConfigsLoading ? (
              <>
                <Skeleton className="size-9 rounded-lg" />
                <Skeleton className="size-9 rounded-lg" />
              </>
            ) : (
              <>
                {isRunning && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon" onClick={restartService} disabled={isPending}>
                        {isPending ? <Spinner className="text-muted-foreground size-4" /> : <IconRefresh />}
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
                        className="text-green-500 hover:border-green-500/50 hover:text-green-400"
                        onClick={startService}
                        disabled={isPending}
                      >
                        {isPending ? <Spinner className="text-muted-foreground size-4" /> : <IconPlayerPlayFilled />}
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
                        className="text-destructive hover:text-destructive"
                        onClick={stopService}
                        disabled={isPending}
                      >
                        {isPending ? <Spinner className="text-muted-foreground" /> : <IconPlayerStopFilled />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Остановить</TooltipContent>
                  </Tooltip>
                )}
              </>
            )}
          </div>
        </div>

        <div className="order-1 flex items-center justify-center md:absolute md:left-1/2 md:order-2 md:-translate-x-1/2">
          <a
            href="https://github.com/zxc-rv/XKeen-UI"
            target="_blank"
            rel="noreferrer"
            className="rounded-md transition-opacity hover:opacity-85"
          >
            <span
              className="text-[28px] font-semibold bg-linear-to-r from-[#00D3F2] via-[#2B7FFF] to-[#155DFC] bg-clip-text text-transparent"
            >
              XKeen UI
            </span>
          </a>
        </div>

        <div className="order-3 ml-auto flex w-full items-center justify-center gap-1.5 md:w-auto md:justify-end">
          {isConfigsLoading || !version ? (
            <Skeleton className="h-9 w-35.75" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent>Управление ядром</TooltipContent>
            </Tooltip>
          )}
          {isConfigsLoading || !version ? (
            <Skeleton className="h-9 w-18.75" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent>{isOutdatedUI ? 'Доступно обновление' : 'Версия XKeen UI'}</TooltipContent>
            </Tooltip>
          )}
          {isConfigsLoading || !version ? (
            <Skeleton className="size-9" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" onClick={onOpenSettings}>
                  <IconSettings className="size-4.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Настройки</TooltipContent>
            </Tooltip>
          )}
          {authEnabled &&
            (isConfigsLoading || !version ? (
              <Skeleton className="size-9" />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon" onClick={onLogout}>
                    <IconLogout className="size-4.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Выйти</TooltipContent>
              </Tooltip>
            ))}
        </div>
      </div>
    </TooltipProvider>
  )
}
