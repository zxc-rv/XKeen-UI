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
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { IconPlus } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import { saveRouters } from '../../lib/routers-actions'
import {
  DEFAULT_ROUTER_PORT,
  LOCAL_ROUTER_ID,
  type RemoteRouter,
  routerId,
  routerLabel,
} from '../../lib/routers'
import { useRoutersStore } from '../../lib/routers-store'
import { showToast } from '../../lib/store'
import { RouterOnlineDot } from './RouterTabsBar'

function RouterOptionLabel({ id, label }: { id: string; label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <RouterOnlineDot id={id} />
      <span className="truncate">{label}</span>
    </span>
  )
}

export function RouterSelect({
  onSwitch,
  disabled,
}: {
  onSwitch: (id: string) => void
  disabled?: boolean
}) {
  const activeId = useRoutersStore((s) => s.activeId)
  const routers = useRoutersStore((s) => s.routers)
  const [addOpen, setAddOpen] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(DEFAULT_ROUTER_PORT))
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const items = useMemo(() => {
    const map: Record<string, string> = { [LOCAL_ROUTER_ID]: 'Этот роутер' }
    for (const r of routers) map[routerId(r)] = routerLabel(r)
    return map
  }, [routers])

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
      await saveRouters(list)
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

  return (
    <>
      <Select
        value={activeId}
        items={items}
        disabled={disabled}
        onValueChange={(v) => !disabled && onSwitch(v)}
      >
        <SelectTrigger size="sm" popper className="min-w-32 max-w-44">
          <RouterOnlineDot id={activeId} />
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="p-0">
          <div className="max-h-48 overflow-y-auto p-1">
            <SelectGroup className="p-0">
              <SelectItem value={LOCAL_ROUTER_ID}>
                <RouterOptionLabel id={LOCAL_ROUTER_ID} label="Этот роутер" />
              </SelectItem>
              {routers.map((r) => {
                const id = routerId(r)
                return (
                  <SelectItem key={id} value={id}>
                    <RouterOptionLabel id={id} label={routerLabel(r)} />
                  </SelectItem>
                )
              })}
            </SelectGroup>
          </div>
          <div className="border-border border-t p-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-1.5"
              disabled={disabled || saving}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setAddOpen(true)
              }}
            >
              <IconPlus className="size-4" />
              Добавить роутер
            </Button>
          </div>
        </SelectContent>
      </Select>

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
