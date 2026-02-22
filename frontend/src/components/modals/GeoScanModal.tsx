import { useState, useEffect } from "react"
import { IconSearch, IconServer, IconWorld, IconX } from "@tabler/icons-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { cn } from "../../lib/utils"
import { useAppContext } from "../../store"
import { Spinner } from "../ui/spinner"

type GeoType = "domain" | "ip"
type FileStatus = { categories: string[]; status: "idle" | "scanning" | "found" | "not-found" | "error" }

export function GeoScanModal() {
  const { state, dispatch, showToast } = useAppContext()
  const [geoType, setGeoType] = useState<GeoType>("domain")
  const [input, setInput] = useState("")
  const [geoFiles, setGeoFiles] = useState<{ domain: string[]; ip: string[] }>({ domain: [], ip: [] })
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatus>>({})
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)

  const close = () => dispatch({ type: "SHOW_MODAL", modal: "showGeoScanModal", show: false })

  useEffect(() => {
    if (state.showGeoScanModal) loadGeoFiles()
  }, [state.showGeoScanModal])

  async function loadGeoFiles() {
    setLoading(true)
    try {
      const res = await fetch("/api/geo")
      const data = await res.json()
      if (data.success) {
        const files = { domain: data.site_files || [], ip: data.ip_files || [] }
        setGeoFiles(files)
        setSelectedFiles(files.domain)
        initStatuses(files.domain)
      }
    } catch {
      /* ignore */
    }
    setLoading(false)
  }

  function initStatuses(files: string[]) {
    setFileStatuses(Object.fromEntries(files.map((f) => [f, { categories: [], status: "idle" as const }])))
  }

  function switchType(type: GeoType) {
    setGeoType(type)
    setInput("")
    setSelectedFiles(geoFiles[type])
    initStatuses(geoFiles[type])
  }

  function toggleFile(filename: string) {
    setSelectedFiles((prev) => (prev.includes(filename) ? prev.filter((f) => f !== filename) : [...prev, filename]))
  }

  async function scan() {
    if (!input.trim() || selectedFiles.length === 0) return
    setScanning(true)
    const endpoint = geoType === "ip" ? "/api/geo/ip" : "/api/geo/site"
    const paramName = geoType === "ip" ? "ip" : "domain"

    for (const file of selectedFiles) {
      setFileStatuses((prev) => ({ ...prev, [file]: { status: "scanning", categories: [] } }))
      try {
        const res = await fetch(`${endpoint}?file=${encodeURIComponent(file)}&${paramName}=${encodeURIComponent(input.trim())}`)
        const data = await res.json()
        setFileStatuses((prev) => ({
          ...prev,
          [file]:
            data.success && data.categories?.length
              ? { status: "found", categories: data.categories }
              : { status: "not-found", categories: [] },
        }))
      } catch {
        setFileStatuses((prev) => ({ ...prev, [file]: { status: "error", categories: [] } }))
      }
    }
    setScanning(false)
  }

  const currentFiles = geoFiles[geoType]
  const allSelected = currentFiles.length > 0 && currentFiles.every((f) => selectedFiles.includes(f))

  return (
    <Dialog open={state.showGeoScanModal} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="flex flex-col overflow-hidden"
        style={{ maxHeight: "95vh", maxWidth: "36rem", width: "calc(100vw - 2rem)" }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pb-3">
            <IconSearch size={24} className="text-chart-2" />
            Скан геофайлов
          </DialogTitle>
          <DialogDescription>Проверка наличия домена или IP-адреса в геофайлах</DialogDescription>
        </DialogHeader>

        {/* Type switcher */}
        <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
          {(
            [
              ["domain", "GeoSite", IconWorld],
              ["ip", "GeoIP", IconServer],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => switchType(id as GeoType)}
              className={cn(
                "cursor-pointer flex-1 flex items-center justify-center gap-1.5 py-2 text-sm transition-colors",
                geoType === id ? "bg-primary text-foreground" : "bg-input-background text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon size={18} /> {label}
            </button>
          ))}
        </div>

        {/* Files header */}
        <div className="flex items-center justify-between shrink-0 -my-2">
          <div className="flex items-center gap-2 pl-1">
            <Checkbox
              id="select-all"
              checked={allSelected}
              onCheckedChange={() => setSelectedFiles(allSelected ? [] : [...currentFiles])}
            />
            <Label htmlFor="select-all" className="text-xs text-muted-foreground cursor-pointer tracking-wide">
              Все файлы
            </Label>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "rounded-full w-6 h-6 p-0 text-xs bg-blue-500/10 text-blue-400 border-blue-500/20",
              geoType === "domain" ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-blue-500/10 text-blue-400 border-blue-500/20",
            )}
          >
            {currentFiles.length}
          </Badge>
        </div>

        {/* File list — fixed height, scrollable */}
        <ScrollArea className="min-h-63 max-h-63 rounded-lg border border-border bg-input-background overflow-y-auto relative">
          {loading ? (
            <div className="rounded-lg p-1.5 space-y-1.5">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="h-9 rounded-lg bg-muted animate-pulse" />
              ))}
            </div>
          ) : currentFiles.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-xs text-muted-foreground">Геофайлы не найдены</p>
            </div>
          ) : (
            <div className="rounded-lg p-1.5 space-y-1">
              {currentFiles.map((file) => {
                const status = fileStatuses[file]
                const isChecked = selectedFiles.includes(file)
                return (
                  <div key={file} className={cn("rounded-md transition-colors", status?.status === "found" && "bg-card")}>
                    {/* File row - УБРАЛИ h-9, ДОБАВИЛИ py-1.5 */}
                    <div className="flex items-center gap-3 px-3 h-9 py-1.5">
                      <Checkbox id={`file-${file}`} checked={isChecked} onCheckedChange={() => toggleFile(file)} />
                      <Label htmlFor={`file-${file}`} className="flex-1 text-xs font-normal tracking-wide cursor-pointer truncate">
                        {file}
                      </Label>
                      {status && status.status !== "idle" && (
                        <span
                          className={cn("text-xs shrink-0 font-mono", {
                            "text-muted-foreground animate-pulse": status.status === "scanning",
                            "text-green-500": status.status === "found",
                            "text-destructive/60": status.status === "not-found",
                            "text-destructive": status.status === "error",
                          })}
                        >
                          {status.status === "scanning" && <Spinner className="size-3" />}
                          {status.status === "found" && `${status.categories.length}`}
                          {status.status === "not-found" && "—"}
                          {status.status === "error" && "✗"}
                        </span>
                      )}
                    </div>
                    {/* Categories */}
                    {status?.categories.length > 0 && (
                      <div className="px-3 pb-2 flex flex-wrap gap-1.5">
                        {status.categories.map((cat) => (
                          <Badge
                            key={cat}
                            variant="outline"
                            onClick={() =>
                              navigator.clipboard.writeText(`"ext:${file}:${cat}"`).then(() => showToast("Категория скопирована"))
                            }
                            className={cn(
                              "cursor-pointer h-6 p-2 pt-2.5 text-[11px] tracking-wide rounded-sm transition-colors",
                              geoType === "domain"
                                ? "bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/20"
                                : "bg-blue-500/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/20",
                            )}
                          >
                            {cat}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <div className="relative shrink-0 -mt-3">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !scanning && scan()}
            placeholder={geoType === "ip" ? "1.1.1.1" : "example.com"}
            className="h-9 pr-8"
          />
          {input && (
            <button
              onClick={() => setInput("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <IconX size={13} />
            </button>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button onClick={scan} disabled={scanning || !input.trim() || selectedFiles.length === 0} className="h-9 w-full">
            {scanning ? "Сканирование..." : "Сканировать"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
