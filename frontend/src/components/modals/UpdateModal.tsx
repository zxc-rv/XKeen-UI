import { useState, useEffect } from "react"
import { IconDownload } from "@tabler/icons-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { cn } from "../../lib/utils"
import { useAppContext } from "../../store"
import { capitalize } from "../../lib/api"
import type { Release } from "../../types"
import { Spinner } from "../ui/spinner"

const ITEM_HEIGHT = 62
const VISIBLE_ITEMS = 5

export function UpdateModal({ onInstalled }: { onInstalled: () => void }) {
  const { state, dispatch, showToast } = useAppContext()
  const { updateModalCore, settings } = state
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedVersion, setSelectedVersion] = useState("")
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)

  const coreLabel = updateModalCore === "self" ? "XKeen UI" : capitalize(updateModalCore)
  const close = () => dispatch({ type: "SHOW_MODAL", modal: "showUpdateModal", show: false })

  useEffect(() => {
    if (state.showUpdateModal) fetchReleases()
  }, [state.showUpdateModal, updateModalCore])

  async function fetchReleases() {
    setLoading(true)
    setSelectedVersion("")
    setReleases([])
    try {
      const res = await fetch(`/api/update?core=${updateModalCore}`)
      const data = await res.json()
      if (data.success && data.releases?.length) {
        setReleases(data.releases)
        setSelectedVersion(data.releases[0].version)
      }
    } catch {
      /* ignore */
    }
    setLoading(false)
  }

  async function install() {
    if (!selectedVersion) return
    setInstalling(true)
    close()
    dispatch({ type: "SET_SERVICE_STATUS", status: "pending", pendingText: "Обновление..." })
    try {
      const res = await fetch("/api/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ core: updateModalCore, version: selectedVersion, backup_core: settings.backupCore }),
      })
      const data = await res.json()
      if (data.success) {
        showToast(`Установлен ${coreLabel} ${selectedVersion}`)
        if (updateModalCore === "self") {
          setTimeout(() => location.reload(), 100)
          return
        }
        onInstalled()
      } else {
        showToast(data.error || "Ошибка установки", "error")
      }
    } catch {
      showToast("Ошибка установки", "error")
    } finally {
      setInstalling(false)
      dispatch({ type: "SET_SERVICE_STATUS", status: "stopped" })
    }
  }

  return (
    <Dialog open={state.showUpdateModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
            <IconDownload size={24} className="text-chart-2" />
            Обновление {coreLabel}
          </DialogTitle>

          <DialogDescription className="flex items-center justify-between w-full">
            Выберите версию для установки
            {!loading && releases.length > 0 && (
              <Badge variant="outline" className="rounded-full w-6 h-6 bg-blue-500/10 text-blue-400 border-blue-500/20">
                {releases.length}
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0" style={{ maxHeight: ITEM_HEIGHT * VISIBLE_ITEMS + 8 }}>
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
              <Spinner className="size-10 text-chart-2" />
              <span className="text-xs">Загрузка релизов...</span>
            </div>
          ) : releases.length === 0 ? (
            <p className="text-center py-12 text-muted-foreground text-sm">Нет доступных релизов</p>
          ) : (
            <RadioGroup value={selectedVersion} onValueChange={setSelectedVersion} className="py-1 gap-1.5">
              {releases.map((release) => {
                const checked = selectedVersion === release.version

                return (
                  <label
                    key={release.version}
                    htmlFor={release.version}
                    className={cn(
                      "flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all",
                      checked ? "border-chart-2 bg-primary/15" : "border-border hover:bg-primary/15 hover:border-chart-2",
                    )}
                  >
                    <div className="flex flex-col gap-2 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{release.name || release.version}</span>

                        {release.is_prerelease && (
                          <Badge variant="outline" className="text-xs border-none rounded-sm px-2 text-amber-400 bg-amber-500/10">
                            Pre-Release
                          </Badge>
                        )}
                      </div>

                      <span className="text-xs text-muted-foreground">{release.published_at}</span>
                    </div>

                    <RadioGroupItem value={release.version} id={release.version} className="mt-1 shrink-0" />
                  </label>
                )
              })}
            </RadioGroup>
          )}
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button onClick={install} disabled={!selectedVersion || installing} className="w-full h-9">
            {installing ? "Установка..." : "Установить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
