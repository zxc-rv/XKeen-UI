import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { IconChevronLeft, IconChevronRight, IconPlus, IconX } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ensureRoutersFile, persistRouters } from '../../lib/routers-actions'
import {
  DEFAULT_ROUTER_PORT,
  LOCAL_ROUTER_ID,
  type RemoteRouter,
  routerId,
  routerLabel,
} from '../../lib/routers'
import { useCoreRuntimeState, showToast } from '../../lib/store'
import { useRoutersStore } from '../../lib/routers-store'
import { cn } from '../../lib/utils'

export const tabBarSectionClass =
  'border-border bg-muted/30 shrink-0 border-b px-3 py-2.5 sm:px-4'

function OnlineDot({ online }: { online: boolean | null }) {
  return (
    <span
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        online === true && 'bg-green-500',
        online === false && 'bg-red-500',
        online === null && 'bg-muted-foreground/40'
      )}
      aria-hidden
    />
  )
}

export function RouterTabsCard({ onSwitch }: { onSwitch: (id: string) => void }) {
  const isRouterSwitching = useRoutersStore((s) => s.isSwitching)
  const { serviceStatus } = useCoreRuntimeState()
  const disabled = serviceStatus === 'pending' || isRouterSwitching

  return (
    <div className="border-border bg-card shrink-0 overflow-hidden rounded-xl border px-3 py-2.5 sm:px-4">
      <RouterTabsBar onSwitch={onSwitch} disabled={disabled} />
    </div>
  )
}

export function RouterTabsBar({
  onSwitch,
  disabled,
}: {
  onSwitch: (id: string) => void
  disabled?: boolean
}) {
  const activeId = useRoutersStore((s) => s.activeId)
  const routers = useRoutersStore((s) => s.routers)
  const online = useRoutersStore((s) => s.online)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(DEFAULT_ROUTER_PORT))
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const updateScrollEdges = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    setCanScrollLeft(scrollLeft > 1)
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateScrollEdges()
    const onScroll = () => updateScrollEdges()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(updateScrollEdges)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [updateScrollEdges, routers.length])

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current
    if (!el) return
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
  }, [])

  const scrollByDir = useCallback((dir: -1 | 1) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.6), behavior: 'smooth' })
  }, [])

  async function addRouter() {
    const h = host.trim()
    const p = Number(port) || DEFAULT_ROUTER_PORT
    if (!h) return showToast('Укажите IP или хост', 'error')
    if (p < 1 || p > 65535) return showToast('Неверный порт', 'error')
    const next: RemoteRouter = { host: h, port: p, name: name.trim() }
    const id = routerId(next)
    if (routers.some((r) => routerId(r) === id)) return showToast('Роутер уже добавлен', 'error')

    setSaving(true)
    try {
      const list = [...routers, next]
      await ensureRoutersFile(list)
      setAddOpen(false)
      setHost('')
      setPort(String(DEFAULT_ROUTER_PORT))
      setName('')
      showToast(`Добавлен ${routerLabel(next)}`)
    } catch (e: any) {
      showToast(e.message || 'Ошибка сохранения', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function removeRouter(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    const list = routers.filter((r) => routerId(r) !== id)
    setSaving(true)
    try {
      const result = await persistRouters(list)
      if (!result.success) throw new Error(result.error || 'Ошибка сохранения')
      useRoutersStore.getState().setRouters(list)
      if (activeId === id) onSwitch(LOCAL_ROUTER_ID)
      showToast('Роутер удалён')
    } catch (err: any) {
      showToast(err.message || 'Ошибка удаления', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        {(canScrollLeft || canScrollRight) && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            disabled={!canScrollLeft}
            onClick={() => scrollByDir(-1)}
            aria-label="Прокрутить вкладки влево"
          >
            <IconChevronLeft className="size-4" />
          </Button>
        )}
        <div
          ref={scrollRef}
          onWheel={onWheel}
          className="scrollbar-none min-w-0 flex-1 overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        >
          <Tabs
            value={activeId}
            onValueChange={(v) => !disabled && onSwitch(v)}
            className="w-max flex-row!"
          >
            <TabsList variant="line" className="mb-0 w-max shrink-0 gap-3 p-0 whitespace-nowrap">
              <TabsTrigger value={LOCAL_ROUTER_ID} className="gap-1.5 p-0 text-sm font-semibold md:text-base" disabled={disabled}>
                <OnlineDot online={online[LOCAL_ROUTER_ID] ?? true} />
                Этот роутер
              </TabsTrigger>
              {routers.map((r) => {
                const id = routerId(r)
                return (
                  <TabsTrigger key={id} value={id} className="group gap-1.5 p-0 text-sm font-semibold md:text-base" disabled={disabled}>
                    <OnlineDot online={online[id] ?? null} />
                    <span className="max-w-36 truncate">{routerLabel(r)}</span>
                    <span
                      role="button"
                      tabIndex={-1}
                      className="text-muted-foreground hover:text-destructive ml-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-data-[state=active]:opacity-100"
                      onClick={(e) => removeRouter(id, e)}
                      onKeyDown={(e) => e.key === 'Enter' && removeRouter(id, e as any)}
                      aria-label="Удалить роутер"
                    >
                      <IconX className="size-3.5" />
                    </span>
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </Tabs>
        </div>
        {(canScrollLeft || canScrollRight) && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            disabled={!canScrollRight}
            onClick={() => scrollByDir(1)}
            aria-label="Прокрутить вкладки вправо"
          >
            <IconChevronRight className="size-4" />
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="shrink-0"
                disabled={disabled || saving}
                onClick={() => setAddOpen(true)}
                aria-label="Добавить роутер"
              >
                <IconPlus className="size-4" />
              </Button>
            }
          />
          <TooltipContent>Добавить роутер</TooltipContent>
        </Tooltip>
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Добавить роутер</DialogTitle>
            <DialogDescription>Укажите адрес панели XKeen UI (по умолчанию порт 1000).</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <InputGroup>
              <InputGroupInput
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="IP или хост"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && addRouter()}
              />
            </InputGroup>
            <InputGroup>
              <InputGroupInput
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                placeholder="Порт"
                inputMode="numeric"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>port</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
            <InputGroup>
              <InputGroupInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя (необязательно)" />
            </InputGroup>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Отмена
            </Button>
            <Button disabled={saving} onClick={addRouter}>
              Добавить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function MassConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  targets,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  targets: string[]
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ul className="bg-muted/40 max-h-48 list-inside list-disc overflow-y-auto rounded-md border px-3 py-2 text-sm">
          {targets.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            Продолжить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RouterOnlineDot({ id }: { id: string }) {
  const online = useRoutersStore((s) => s.online[id] ?? null)
  return <OnlineDot online={online} />
}

export function useHorizontalWheelScroll<T extends HTMLElement>() {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  return ref
}
