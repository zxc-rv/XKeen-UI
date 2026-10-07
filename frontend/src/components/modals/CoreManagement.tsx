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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { IconAlertCircle, IconCpu } from '@tabler/icons-react'
import { useState } from 'react'
import { useAppContext, useDnsStatusStore, useModalContext } from '../../lib/store'

interface Props {
  onSwitchCore: (core: string) => void
  onOpenUpdate: (core: string) => void
}

const CORES = [
  { id: 'xray', label: 'Xray' },
  { id: 'mihomo', label: 'Mihomo' },
]

export function CoreManageModal({ onSwitchCore, onOpenUpdate }: Props) {
  const { state } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const { currentCore, coreVersions, availableCores } = state
  const dnsStatus = useDnsStatusStore((s) => s.status)

  const isDnsEnabled = currentCore === 'mihomo' && !!dnsStatus && dnsStatus.dnsOverride && dnsStatus.dnsMihomo

  const [pendingCore, setPendingCore] = useState<string | null>(null)

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showCoreManageModal', show: false })

  const handleSwitch = (core: string) => {
    if (isDnsEnabled) {
      setPendingCore(core)
      return
    }
    close()
    onSwitchCore(core)
  }

  return (
    <>
      <Dialog open={modals.showCoreManageModal} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pb-3">
              <IconCpu size={24} className="text-chart-2" /> Управление ядром
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {CORES.map((core, i) => {
              const isActive = currentCore === core.id
              const isInstalled = availableCores.includes(core.id)
              const version = coreVersions[core.id as keyof typeof coreVersions]

              return (
                <div key={core.id}>
                  {i > 0 && <Separator className="mb-4" />}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-medium">{core.label}</span>
                        {isActive && (
                          <Badge variant="outline" className="rounded-sm border-none bg-green-500/10 px-2 text-xs text-green-400">
                            Активно
                          </Badge>
                        )}
                        {!isInstalled && (
                          <Badge variant="outline" className="rounded-sm border-none bg-red-500/10 px-2 text-xs text-red-400">
                            Не установлено
                          </Badge>
                        )}
                      </div>
                      {isInstalled && <p className="text-muted-foreground mt-0.5 text-xs">{version || 'Установлено'}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {!isActive && isInstalled && (
                        <Button size="sm" onClick={() => handleSwitch(core.id)}>
                          Переключить
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          close()
                          onOpenUpdate(core.id)
                        }}
                      >
                        {isInstalled ? 'Обновить' : 'Установить'}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingCore !== null} onOpenChange={(open) => !open && setPendingCore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <IconAlertCircle size={18} className="text-amber-400" /> Внимание
            </AlertDialogTitle>
            <AlertDialogDescription>
              Управление DNS активно, при переключении ядра может пропасть доступ в интернет. Продолжить?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingCore(null)}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const core = pendingCore
                setPendingCore(null)
                if (core) {
                  close()
                  onSwitchCore(core)
                }
              }}
            >
              Продолжить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
