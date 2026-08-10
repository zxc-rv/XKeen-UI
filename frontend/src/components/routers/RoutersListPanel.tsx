import { Checkbox } from '@/components/ui/checkbox'
import { Empty, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Button } from '@/components/ui/button'
import { IconCheck, IconLoader2, IconRouter, IconTrash, IconX } from '@tabler/icons-react'
import { useState } from 'react'
import { persistRouters, targetLabel } from '../../lib/routers-actions'
import { LOCAL_ROUTER_ID, routerId, routerLabel } from '../../lib/routers'
import { useRoutersStore } from '../../lib/routers-store'
import { showToast } from '../../lib/store'
import { cn } from '../../lib/utils'
import { RouterOnlineDot } from './RouterTabsBar'

function CommandStatusBadge({ id }: { id: string }) {
  const state = useRoutersStore((s) => s.commandStatus[id])
  if (!state || state.status === 'idle') return null
  if (state.status === 'pending') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-[12px]">
        <IconLoader2 className="size-3.5 animate-spin" /> выполняется…
      </span>
    )
  }
  if (state.status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-green-600 dark:text-green-400">
        <IconCheck className="size-3.5" /> OK
      </span>
    )
  }
  return (
    <span className="text-destructive inline-flex max-w-40 items-center gap-1 truncate text-[12px]" title={state.message}>
      <IconX className="size-3.5 shrink-0" />
      {state.message || 'ошибка'}
    </span>
  )
}

export function RoutersListPanel() {
  const routers = useRoutersStore((s) => s.routers)
  const activeId = useRoutersStore((s) => s.activeId)
  const applyTargets = useRoutersStore((s) => s.applyTargets)
  const toggleApplyTarget = useRoutersStore((s) => s.toggleApplyTarget)
  const isLocal = activeId === LOCAL_ROUTER_ID

  const [saving, setSaving] = useState(false)

  async function removeRouter(id: string) {
    const list = routers.filter((r) => routerId(r) !== id)
    setSaving(true)
    try {
      const result = await persistRouters(list)
      if (!result.success) throw new Error(result.error || 'Ошибка сохранения')
      useRoutersStore.getState().setRouters(list)
      showToast('Роутер удалён')
    } catch (e: any) {
      showToast(e.message || 'Ошибка удаления', 'error')
    } finally {
      setSaving(false)
    }
  }

  const rows: { id: string; title: string; subtitle: string }[] = [
    { id: LOCAL_ROUTER_ID, title: targetLabel(LOCAL_ROUTER_ID), subtitle: 'локальная панель' },
    ...routers.map((r) => ({
      id: routerId(r),
      title: routerLabel(r),
      subtitle: `${r.host}:${r.port}`,
    })),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-3">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length <= 1 && routers.length === 0 ? (
          <Empty className="h-full gap-1 py-6">
            <EmptyMedia variant="icon" className="size-8.5">
              <IconRouter className="text-muted-foreground size-5" />
            </EmptyMedia>
            <EmptyTitle className="text-ring text-[13px] font-normal tracking-normal">
              Нет удалённых роутеров — добавьте через «+» над редактором
            </EmptyTitle>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => {
              const isActiveTab = row.id === activeId
              const checked = isLocal ? applyTargets.includes(row.id) : isActiveTab
              const canToggle = isLocal
              return (
                <div
                  key={row.id}
                  className={cn(
                    'border-border grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded-lg border px-2.5 py-1.5',
                    checked ? 'bg-muted/40' : 'bg-muted/10',
                    !canToggle && !isActiveTab && 'opacity-60'
                  )}
                >
                  <Checkbox
                    checked={checked}
                    disabled={!canToggle}
                    onCheckedChange={() => canToggle && toggleApplyTarget(row.id)}
                    aria-label={canToggle ? `Выбрать ${row.title}` : `Выбран ${row.title}`}
                  />
                  <RouterOnlineDot id={row.id} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{row.title}</div>
                    <div className="text-muted-foreground truncate text-[11px]">{row.subtitle}</div>
                  </div>
                  <CommandStatusBadge id={row.id} />
                  {row.id !== LOCAL_ROUTER_ID ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      disabled={saving}
                      onClick={() => removeRouter(row.id)}
                      aria-label="Удалить"
                    >
                      <IconTrash className="size-4" />
                    </Button>
                  ) : (
                    <span className="size-8 shrink-0" aria-hidden />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
