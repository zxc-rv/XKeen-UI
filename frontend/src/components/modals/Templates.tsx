import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { IconFileText } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { capitalize } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import { cn } from '../../lib/utils'

const TEMPLATES_URL = 'https://raw.githubusercontent.com/zxc-rv/assets/main/config_templates/templates.json'
let templatesCache: Record<string, { name: string; url: string }[]> | null = null

export function TemplateModal({ onImport }: { onImport: (url: string) => Promise<void> }) {
  const { state, showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const { currentCore } = state
  const [templates, setTemplates] = useState<{ name: string; url: string }[]>([])
  const [selectedUrl, setSelectedUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showTemplateModal', show: false })

  useEffect(() => {
    if (modals.showTemplateModal) loadTemplates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modals.showTemplateModal, currentCore])

  async function loadTemplates() {
    if (!templatesCache) {
      setLoading(true)
      try {
        const res = await fetch(TEMPLATES_URL)
        if (!res.ok) throw new Error(res.statusText)
        templatesCache = await res.json()
      } catch {
        showToast('Не удалось загрузить шаблоны', 'error')
        setLoading(false)
        return
      }
      setLoading(false)
    }
    const list = templatesCache?.[currentCore] ?? []
    setTemplates(list)
    if (list.length > 0) setSelectedUrl(list[0].url)
  }

  async function handleImport() {
    if (!selectedUrl) return
    setImporting(true)
    try {
      await onImport(selectedUrl)
      close()
    } catch (e: any) {
      showToast(`Ошибка импорта: ${e.message}`, 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={modals.showTemplateModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[80vh] max-w-140! flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
            <IconFileText size={24} className="text-chart-2" />
            Импорт шаблона
            <span className="text-muted-foreground text-sm font-normal"></span>
          </DialogTitle>
          <DialogDescription className="flex w-full items-center justify-between">
            <span>
              Выберите готовый шаблон конфигурации для <span className="text-chart-2 font-semibold">{capitalize(currentCore)}</span>
            </span>
            {!loading && <Badge className="h-6 w-6 rounded-full border-blue-500/20 bg-blue-500/10 text-blue-400">{templates.length}</Badge>}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1">
          {loading ? (
            <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-12">
              <Spinner className="text-chart-2 size-10" />
              <span className="text-xs">Загрузка шаблонов...</span>
            </div>
          ) : templates.length === 0 ? (
            <p className="text-muted-foreground py-12 text-center text-sm">Нет доступных шаблонов</p>
          ) : (
            <RadioGroup value={selectedUrl} onValueChange={setSelectedUrl} className="gap-1.5 py-1">
              {templates.map((template, i) => (
                <div
                  key={i}
                  onClick={() => setSelectedUrl(template.url)}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3.5 transition-all',
                    selectedUrl === template.url
                      ? 'border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15'
                      : 'border-ring/40 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] from-blue-500/15 to-blue-500/5 hover:border-[#60a5fa] hover:bg-linear-to-b'
                  )}
                >
                  <RadioGroupItem value={template.url} id={`tpl-${i}`} className="shrink-0" />
                  <span className="text-sm font-medium">{template.name}</span>
                </div>
              ))}
            </RadioGroup>
          )}
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button onClick={handleImport} disabled={!selectedUrl || importing} className="w-full">
            {importing ? 'Загрузка...' : 'Импортировать'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
