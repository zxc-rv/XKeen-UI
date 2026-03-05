import { useEffect, useRef } from 'react'
import { IconRefresh, IconSettings, IconCpu, IconPlayerStopFilled, IconPlayerPlayFilled, IconBox } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '../../lib/utils'
import { useAppContext } from '../../lib/store'
import { apiCall, capitalize } from '../../lib/api'
import { AuroraText } from '@/components/ui/aurora-text'
import { ShineBorder } from '@/components/ui/shine-border'

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

  const isRunning = serviceStatus === 'running'
  const isPending = serviceStatus === 'pending' || serviceStatus === 'loading'

  const lastStatusRef = useRef(serviceStatus)
  const lastCoreRef = useRef({ currentCore, coreVersions, availableCores: state.availableCores })

  useEffect(() => {
    lastStatusRef.current = serviceStatus
  }, [serviceStatus])
  useEffect(() => {
    lastCoreRef.current = { currentCore, coreVersions, availableCores: state.availableCores }
  }, [currentCore, coreVersions, state.availableCores])

  async function checkStatus() {
    try {
      const data = await apiCall<any>('GET', 'control')
      if (!data.success) return
      const newStatus: 'running' | 'stopped' = data.running ? 'running' : 'stopped'
      const prev = lastCoreRef.current
      const coreChanged =
        data.currentCore !== prev.currentCore ||
        JSON.stringify(data.versions) !== JSON.stringify(prev.coreVersions) ||
        JSON.stringify(data.cores ?? []) !== JSON.stringify(prev.availableCores)
      if (coreChanged)
        dispatch({
          type: 'SET_CORE_INFO',
          currentCore: data.currentCore || 'xray',
          coreVersions: data.versions || { xray: '', mihomo: '' },
          availableCores: data.cores || [],
        })
      if (newStatus !== lastStatusRef.current) dispatch({ type: 'SET_SERVICE_STATUS', status: newStatus })
    } catch {
      /* ok */
    }
  }

  useEffect(() => {
    const interval = setInterval(() => {
      if (state.serviceStatus !== 'pending') checkStatus()
    }, 15000)
    return () => clearInterval(interval)
  }, [state.serviceStatus])

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
    dispatch({
      type: 'SET_SERVICE_STATUS',
      status: result.success ? 'running' : 'stopped',
    })
    checkStatus()
  }

  async function stopService() {
    setPending('Остановка...')
    const result = await apiCall<any>('POST', 'control', { action: 'stop' })
    showToast(
      result.success ? 'XKeen остановлен' : `Ошибка остановки: ${result.output || result.error}`,
      result.success ? 'success' : 'error'
    )
    checkStatus()
  }

  async function restartService() {
    setPending('Перезапуск...')
    const result = await apiCall<any>('POST', 'control', {
      action: 'hardRestart',
    })
    showToast(
      result.success ? 'XKeen перезапущен' : `Ошибка перезапуска: ${result.output || result.error}`,
      result.success ? 'success' : 'error'
    )
    checkStatus()
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
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-3 sm:p-4 rounded-xl border border-border bg-card shrink-0 z-40 relative">
        <div className="flex flex-wrap items-center justify-center md:justify-start gap-1.5 order-2 md:order-1">
          <div className={badgeClasses} style={badgeBg}>
            {shineColors && <ShineBorder duration={8} borderWidth={2} shineColor={shineColors} />}
            {statusLabel}
          </div>
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
                        {isPending ? <Spinner className="size-4 text-muted-foreground" /> : <IconPlayerPlayFilled size={15} />}
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

        <div className="flex justify-center items-center order-1 md:order-2 md:absolute md:left-1/2 md:-translate-x-1/2">
          <AuroraText className="text-[28px] font-semibold animate-dark-glow" colors={['#00D3F2', '#2B7FFF', '#155DFC']}>
            XKeen UI
          </AuroraText>
        </div>

        <div className="flex items-center justify-center md:justify-end gap-1.5 order-3 ml-auto w-full md:w-auto">
          {isConfigsLoading ? (
            <Skeleton className="h-9 w-32 rounded-md" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" className="h-9 gap-2" onClick={onOpenCoreManage}>
                  <IconCpu className="size-5" />
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
          {version &&
            (isConfigsLoading ? (
              <Skeleton className="h-9 w-14 rounded-md" />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    onClick={() => onOpenUpdate('self')}
                    className={cn(
                      'relative h-9 text-xs tracking-wider overflow-hidden',
                      isOutdatedUI ? 'text-cyan-300 hover:text-cyan-300 border-none!' : ''
                    )}
                  >
                    {isOutdatedUI && <ShineBorder duration={7} borderWidth={2} shineColor={['#00D3F2', '#2B7FFF', '#155DFC']} />}
                    <IconBox className="size-5" />
                    {version}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isOutdatedUI ? 'Доступно обновление' : 'Версия XKeen UI'}</TooltipContent>
              </Tooltip>
            ))}
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
