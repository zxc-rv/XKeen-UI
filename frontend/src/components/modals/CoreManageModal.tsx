import { IconCpu } from "@tabler/icons-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { cn } from "../../lib/utils"
import { useAppContext } from "../../store"

interface Props {
  onSwitchCore: (core: string) => void
  onOpenUpdate: (core: string) => void
}

const CORES = [
  { id: "xray", label: "Xray" },
  { id: "mihomo", label: "Mihomo" },
]

export function CoreManageModal({ onSwitchCore, onOpenUpdate }: Props) {
  const { state, dispatch } = useAppContext()
  const { currentCore, coreVersions, availableCores } = state

  const close = () => dispatch({ type: "SHOW_MODAL", modal: "showCoreManageModal", show: false })

  return (
    <Dialog open={state.showCoreManageModal} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
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
                        <Badge variant="outline" className="text-xs text-green-500 border-green-500/30">
                          Активно
                        </Badge>
                      )}
                    </div>
                    <p className={cn("text-xs mt-0.5", isInstalled ? "text-muted-foreground" : "text-destructive/70")}>
                      {isInstalled ? version || "Установлено" : "Не установлено"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!isActive && isInstalled && (
                      <Button
                        className="p-3"
                        onClick={() => {
                          close()
                          onSwitchCore(core.id)
                        }}
                      >
                        Переключить
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      className="p-3"
                      onClick={() => {
                        close()
                        onOpenUpdate(core.id)
                      }}
                    >
                      {isInstalled ? "Обновить" : "Установить"}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
