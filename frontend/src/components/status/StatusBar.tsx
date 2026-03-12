import { AuroraText } from '@/components/ui/aurora-text'
import { Button } from '@/components/ui/button'
import { ShineBorder } from '@/components/ui/shine-border'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { IconBox, IconCpu, IconPlayerPlayFilled, IconPlayerStopFilled, IconRefresh, IconSettings } from '@tabler/icons-react'
import { useEffect } from 'react'
import { apiCall, capitalize } from '../../lib/api'
import { syncClashApiPort, useAppContext } from '../../lib/store'
import { cn } from '../../lib/utils'

export function StatusBar({
  onOpenCoreManage,
  onOpenSettings,
  onRefreshStatus,
  onOpenUpdate,
}: {
  onOpenCoreManage: () => void
  onOpenSettings: () => void
  onRefreshStatus: () => void
  onOpenUpdate: (core: string) => void
}) {
  const { state, dispatch, showToast } = useAppContext()
  const { serviceStatus, pendingText, currentCore, coreVersions, isConfigsLoading, version, isOutdatedUI } = state

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
    setPending('Запуск...')
    const result = await apiCall<any>('POST', 'control', { action: 'start' })
    showToast(result.success ? 'XKeen запущен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: result.success ? 'running' : 'stopped' })
    if (result.success) syncClashApiPort()
    onRefreshStatus()
  }

  async function stopService() {
    setPending('Остановка...')
    const result = await apiCall<any>('POST', 'control', { action: 'stop' })
    showToast(result.success ? 'XKeen остановлен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    onRefreshStatus()
  }

  async function restartService() {
    setPending('Перезапуск...')
    const result = await apiCall<any>('POST', 'control', { action: 'hardRestart' })
    showToast(result.success ? 'XKeen перезапущен' : `${result.output || result.error}`, result.success ? 'success' : 'error')
    dispatch({ type: 'SET_SERVICE_STATUS', status: result.success ? 'running' : 'stopped' })
    if (result.success) syncClashApiPort()
    onRefreshStatus()
  }

  const statusLabel =
    serviceStatus === 'running' ? 'Сервис запущен' : serviceStatus === 'stopped' ? 'Сервис остановлен' : pendingText || 'Загрузка...'

  const badgeClasses = cn('status-badge-custom', serviceStatus === 'stopped' && 'status-badge-stopped')

  const shineColors = isRunning ? ['#195040', '#34d399', '#195040'] : isPending ? ['#4a3615', '#fbbf24', '#4a3615'] : null

  const badgeBg = isRunning
    ? { background: '#19292c', color: '#10b981', border: 'none' }
    : isPending
      ? { background: '#2a1f0d', color: '#f59e0b', border: 'none' }
      : {}

  return (
    <TooltipProvider delayDuration={300}>
      <div className="border-border bg-card relative z-40 flex shrink-0 flex-col justify-between gap-3 rounded-xl border p-3 sm:p-4 md:flex-row md:items-center">
        <div className="order-2 flex flex-wrap items-center justify-center gap-1.5 md:order-1 md:justify-start">
          <div className={badgeClasses} style={badgeBg}>
            {shineColors && <ShineBorder duration={8} borderWidth={2} shineColor={shineColors} />}
            {statusLabel}
          </div>
          <div className="flex items-center gap-1.5">
            {isConfigsLoading ? (
              <>
                <Skeleton className="h-8 w-8 rounded-lg" />
                <Skeleton className="h-8 w-8 rounded-lg" />
              </>
            ) : (
              <>
                {isRunning && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="icon" onClick={restartService} disabled={isPending}>
                        {isPending ? <Spinner className="text-muted-foreground size-4" /> : <IconRefresh className="size-4.5" />}
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
                        {isPending ? <Spinner className="text-muted-foreground size-4" /> : <IconPlayerPlayFilled className="size-4.5" />}
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
                        {isPending ? <Spinner className="text-muted-foreground" /> : <IconPlayerStopFilled className="size-4.5" />}
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
          <AuroraText className="animate-dark-glow text-[28px] font-semibold" colors={['#00D3F2', '#2B7FFF', '#155DFC']}>
            XKeen UI
          </AuroraText>
        </div>

        <div className="order-3 ml-auto flex w-full items-center justify-center gap-1.5 md:w-auto md:justify-end">
          {isConfigsLoading || !version ? (
            <Skeleton className="h-8 w-35.75 rounded-lg" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" onClick={onOpenCoreManage}>
                  <IconCpu data-icon="inline-start" className="size-4.5" />
                  <span className="text-[13px]">{capitalize(currentCore)}</span>
                  {coreVersions[currentCore] && (
                    <span className="text-muted-foreground/60 mt-0.5 text-xs">{coreVersions[currentCore]}</span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Управление ядром</TooltipContent>
            </Tooltip>
          )}
          {isConfigsLoading || !version ? (
            <Skeleton className="h-8 w-18.75 rounded-lg" />
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
            <Skeleton className="size-8 rounded-lg" />
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
        </div>
      </div>
    </TooltipProvider>
  )
}
