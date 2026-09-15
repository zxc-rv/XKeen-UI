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
import { useState } from 'react'
import { saveRouters } from '../../lib/routers-actions'
import { DEFAULT_ROUTER_PORT, type RemoteRouter, routerId, routerLabel } from '../../lib/routers'
import { useRoutersStore } from '../../lib/routers-store'
import { showToast } from '../../lib/store'

export function AddRouterDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const routers = useRoutersStore((s) => s.routers)
  const [host, setHost] = useState('')
  const [port, setPort] = useState(String(DEFAULT_ROUTER_PORT))
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  function reset() {
    setHost('')
    setPort(String(DEFAULT_ROUTER_PORT))
    setName('')
  }

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
      await saveRouters([...routers, next])
      onOpenChange(false)
      reset()
      showToast(`Добавлен ${routerLabel(next)}`)
    } catch (e: any) {
      showToast(e.message || 'Ошибка сохранения', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) reset()
      }}
    >
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button disabled={saving} onClick={addRouter}>
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
