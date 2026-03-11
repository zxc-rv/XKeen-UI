import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconSearch, IconServer, IconWorld, IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { useAppContext, useModalContext } from '../../lib/store'
import { cn } from '../../lib/utils'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group'

type GeoType = 'domain' | 'ip'
type FileStatus = {
  categories: string[]
  status: 'idle' | 'scanning' | 'found' | 'not-found' | 'error'
}

export function GeoScanModal() {
  const { showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const [geoType, setGeoType] = useState<GeoType>('domain')
  const [input, setInput] = useState('')
  const [geoFiles, setGeoFiles] = useState<{ domain: string[]; ip: string[] }>({
    domain: [],
    ip: [],
  })
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatus>>({})
  const [scanning, setScanning] = useState(false)
  const [loading, setLoading] = useState(true)

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showGeoScanModal', show: false })

  function initStatuses(files: string[]) {
    setFileStatuses(Object.fromEntries(files.map((f) => [f, { categories: [], status: 'idle' as const }])))
  }

  async function loadGeoFiles() {
    setLoading(true)
    try {
      const res = await fetch('/api/geo')
      const data = await res.json()
      if (data.success) {
        const files = {
          domain: data.site_files || [],
          ip: data.ip_files || [],
        }
        setGeoFiles(files)
        setSelectedFiles(files.domain)
        initStatuses(files.domain)
      }
    } catch {
      /* ignore */
    }
    setLoading(false)
  }

  useEffect(() => {
    loadGeoFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function switchType(type: GeoType) {
    setGeoType(type)
    setInput('')
    setSelectedFiles(geoFiles[type])
    initStatuses(geoFiles[type])
  }

  function toggleFile(filename: string) {
    setSelectedFiles((prev) => (prev.includes(filename) ? prev.filter((f) => f !== filename) : [...prev, filename]))
  }

  async function scan() {
    if (!input.trim() || selectedFiles.length === 0) return
    setScanning(true)
    const endpoint = geoType === 'ip' ? '/api/geo/ip' : '/api/geo/site'
    const paramName = geoType === 'ip' ? 'ip' : 'domain'

    for (const file of selectedFiles) {
      setFileStatuses((prev) => ({
        ...prev,
        [file]: { status: 'scanning', categories: [] },
      }))
      try {
        const res = await fetch(`${endpoint}?file=${encodeURIComponent(file)}&${paramName}=${encodeURIComponent(input.trim())}`)
        const data = await res.json()
        if (!data.success && data.error) {
          showToast(data.error, 'error')
          setFileStatuses((prev) => ({
            ...prev,
            [file]: { status: 'error', categories: [] },
          }))
        } else {
          setFileStatuses((prev) => ({
            ...prev,
            [file]:
              data.success && data.categories?.length
                ? { status: 'found', categories: data.categories }
                : { status: 'not-found', categories: [] },
          }))
        }
      } catch {
        setFileStatuses((prev) => ({
          ...prev,
          [file]: { status: 'error', categories: [] },
        }))
      }
    }
    setScanning(false)
  }

  const currentFiles = geoFiles[geoType]
  const allSelected = currentFiles.length > 0 && currentFiles.every((f) => selectedFiles.includes(f))

  return (
    <Dialog open={modals.showGeoScanModal} onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="flex flex-col overflow-hidden"
        style={{
          maxHeight: '95vh',
          maxWidth: '36rem',
          width: 'calc(100vw - 2rem)',
        }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pb-3">
            <IconSearch size={24} className="text-chart-2" />
            Скан геофайлов
          </DialogTitle>
          <DialogDescription>Проверка наличия домена или IP-адреса в геофайлах</DialogDescription>
        </DialogHeader>

        <Tabs value={geoType} onValueChange={(value) => switchType(value as GeoType)} className="shrink-0">
          <TabsList className="border-border h-full! w-full! overflow-hidden rounded-lg border bg-transparent p-0">
            <TabsTrigger
              value="domain"
              className="bg-input-background! data-active:bg-primary! hover:bg-muted! data-active:hover:bg-primary! h-full flex-1 gap-1.5 rounded-none border-none! py-2"
            >
              <IconWorld size={16} /> GeoSite
            </TabsTrigger>
            <TabsTrigger
              value="ip"
              className="bg-input-background! data-active:bg-primary! hover:bg-muted! data-active:hover:bg-primary! h-full flex-1 gap-1.5 rounded-none border-none! py-2"
            >
              <IconServer size={16} /> GeoIP
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Files header */}
        <div className="-my-2 flex shrink-0 items-center justify-between">
          <div className="flex items-center gap-2 pl-1">
            <Checkbox
              id="select-all"
              checked={allSelected}
              onCheckedChange={() => setSelectedFiles(allSelected ? [] : [...currentFiles])}
            />
            <Label htmlFor="select-all" className="text-muted-foreground cursor-pointer text-xs tracking-wide">
              Все файлы
            </Label>
          </div>
          <Badge
            variant="outline"
            className={cn(
              'h-6 w-6 rounded-full p-0 text-xs',
              geoType === 'domain' ? 'border-red-500/20 bg-red-500/10 text-red-400' : 'border-blue-500/20 bg-blue-500/10 text-blue-400'
            )}
          >
            {currentFiles.length}
          </Badge>
        </div>

        {/* File list — fixed height, scrollable */}
        <ScrollArea className="border-border bg-input-background relative max-h-62.5 min-h-62.5 overflow-y-auto rounded-lg border">
          {loading ? (
            <div className="space-y-1 p-1.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-9 rounded-md" />
              ))}
            </div>
          ) : currentFiles.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-muted-foreground text-xs tracking-wide">Геофайлы не найдены</p>
            </div>
          ) : (
            <div className="space-y-1 rounded-lg p-1.5">
              {currentFiles.map((file) => {
                const status = fileStatuses[file]
                const isChecked = selectedFiles.includes(file)
                return (
                  <div key={file} className={cn('rounded-md transition-colors', status?.status === 'found' && 'bg-card')}>
                    <div className="flex h-9 items-center gap-3 px-3 py-1.5">
                      <Checkbox id={`file-${file}`} checked={isChecked} onCheckedChange={() => toggleFile(file)} />
                      <Label htmlFor={`file-${file}`} className="flex-1 cursor-pointer truncate text-xs font-normal tracking-wide">
                        {file}
                      </Label>
                      {status && status.status !== 'idle' && (
                        <span
                          className={cn('shrink-0 font-mono text-xs', {
                            'text-muted-foreground animate-pulse': status.status === 'scanning',
                            'text-green-500': status.status === 'found',
                            'text-destructive/60': status.status === 'not-found',
                            'text-destructive': status.status === 'error',
                          })}
                        >
                          {status.status === 'scanning' && <Spinner className="size-3" />}
                          {status.status === 'found' && `${status.categories.length}`}
                          {status.status === 'not-found' && '—'}
                          {status.status === 'error' && '✗'}
                        </span>
                      )}
                    </div>
                    {status?.categories.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                        {status.categories.map((cat) => (
                          <Badge
                            key={cat}
                            variant="outline"
                            onClick={() =>
                              navigator.clipboard.writeText(`"ext:${file}:${cat}"`).then(() => showToast('Категория скопирована'))
                            }
                            className={cn(
                              'h-6 cursor-pointer rounded-sm border-none p-2 pt-2.5 text-[11px] tracking-wide transition-colors',
                              geoType === 'domain'
                                ? 'bg-red-400/15 text-red-400 hover:bg-red-400/25'
                                : 'bg-blue-400/15 text-blue-400 hover:bg-blue-400/25'
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

        <InputGroup>
          <InputGroupInput
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !scanning && scan()}
            placeholder={geoType === 'ip' ? '1.1.1.1' : 'example.com'}
          />
          <InputGroupAddon align="inline-end">
            {input && (
              <InputGroupButton
                variant="ghost"
                size="icon-xs"
                onClick={() => setInput('')}
                className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
              >
                <IconX className="size-3.5" />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>

        <DialogFooter className="shrink-0">
          <Button onClick={scan} disabled={scanning || !input.trim() || selectedFiles.length === 0} className="h-9 w-full">
            {scanning ? 'Сканирование...' : 'Сканировать'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
