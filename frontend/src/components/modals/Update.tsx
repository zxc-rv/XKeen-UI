import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { IconDownload, IconPlaylistX, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { capitalize } from '../../lib/api'
import { useAppContext, useModalContext, useSettings } from '../../lib/store'
import type { Release } from '../../lib/types'
import { cn } from '../../lib/utils'

const mdClass = `
  text-xs text-muted-foreground leading-relaxed
  [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mb-2 [&_h1]:mt-3 [&_h1:first-child]:mt-0
  [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2:first-child]:mt-0
  [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mb-1 [&_h3]:mt-2 [&_h3:first-child]:mt-0
  [&_p]:mb-2 [&_p:last-child]:mb-0 [&_p]:break-words
  [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ul:last-child]:mb-0 [&_li]:mb-0.5 [&_li]:break-words
  [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol:last-child]:mb-0
  [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[10px] [&_code]:font-mono [&_code]:wrap-anywhere
  [&_pre]:bg-muted [&_pre]:p-2 [&_pre]:rounded [&_pre]:mb-2 [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_pre]:max-w-full
  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:break-normal
  [&_a]:text-blue-400 [&_a]:underline [&_a]:underline-offset-2 [&_a]:wrap-anywhere
  [&_strong]:text-foreground [&_strong]:font-semibold
  [&_hr]:border-ring/20 [&_hr]:my-2
  [&_blockquote]:border-l-2 [&_blockquote]:border-ring/40 [&_blockquote]:pl-3 [&_blockquote]:italic
`.trim()

export function UpdateModal({ onInstalled }: { onInstalled: () => void }) {
  const { dispatch, showToast } = useAppContext()
  const { modals } = useModalContext()
  const backupCore = useSettings((s) => s.backupCore)
  const { updateModalCore } = modals
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedVersion, setSelectedVersion] = useState('')
  const [openVersion, setOpenVersion] = useState('')
  const [source, setSource] = useState<'github' | 'jsdelivr' | ''>('')
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)

  const coreLabel = updateModalCore === 'self' ? 'XKeen UI' : capitalize(updateModalCore)
  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showUpdateModal', show: false })

  useEffect(() => {
    if (modals.showUpdateModal) fetchReleases()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modals.showUpdateModal, updateModalCore])

  async function fetchReleases() {
    setLoading(true)
    setSelectedVersion('')
    setOpenVersion('')
    setReleases([])
    setSource('')
    try {
      const res = await fetch(`/api/update?core=${updateModalCore}`)
      const data = await res.json()
      if (data.success && data.releases?.length) {
        setReleases(data.releases)
        setSelectedVersion(data.releases[0].version)
        setOpenVersion(data.releases[0].version)
        setSource(data.source ?? '')
      }
      if (!data.success || !data.releases?.length) throw new Error()
    } catch {
      showToast('Не удалось получить список релизов', 'error')
    }
    setLoading(false)
  }

  async function install() {
    if (!selectedVersion) return
    setInstalling(true)
    close()
    dispatch({
      type: 'SET_SERVICE_STATUS',
      status: 'pending',
      pendingText: 'Обновление...',
    })
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          core: updateModalCore,
          version: selectedVersion,
          backup_core: backupCore,
        }),
      })
      const data = await res.json()
      if (data.success) {
        showToast(`Установлен ${coreLabel} ${selectedVersion}`)
        if (updateModalCore === 'self') {
          setTimeout(() => location.reload(), 100)
          return
        }
        onInstalled()
      } else {
        showToast(data.error || 'Ошибка установки', 'error')
      }
    } catch {
      showToast('Ошибка установки', 'error')
    } finally {
      setInstalling(false)
      dispatch({ type: 'SET_SERVICE_STATUS', status: 'stopped' })
    }
  }

  return (
    <Dialog open={modals.showUpdateModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="w-full max-w-[95vw]! p-0! md:w-187.5">
        <div className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
              <IconDownload size={24} className="text-chart-2" />
              Обновление {coreLabel}
            </DialogTitle>

            <DialogDescription className="flex w-full items-center justify-between" asChild>
              <div>
                Выберите версию для установки
                <span className="flex items-center gap-1.5">
                  {!loading && source && (
                    <Badge
                      variant="outline"
                      className={cn(
                        'h-5 rounded-full border-none px-2 text-xs font-medium',
                        source === 'github' ? 'bg-green-500/10 text-green-400' : 'bg-orange-500/10 text-orange-400'
                      )}
                    >
                      {source === 'github' ? 'GitHub' : 'jsDelivr'}
                    </Badge>
                  )}
                  {!loading && releases.length > 0 && (
                    <Badge variant="outline" className="h-6 w-6 rounded-full border-blue-500/20 bg-blue-500/10 text-blue-400">
                      {releases.length}
                    </Badge>
                  )}
                </span>
              </div>
            </DialogDescription>
          </DialogHeader>

          <ScrollArea
            className="shrink-0"
            hideScrollbar
            style={{
              maxHeight: 'min(calc(70px * 7 + 8px), calc(90dvh - 160px))',
            }}
          >
            {loading ? (
              <div className="text-muted-foreground flex min-h-88 flex-col items-center justify-center gap-3 py-16">
                <Spinner className="text-chart-2 size-10" />
                <span className="text-sm tracking-normal">Загрузка релизов...</span>
              </div>
            ) : releases.length === 0 ? (
              <Empty className="min-h-88 border-none">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <IconPlaylistX className="size-8" />
                  </EmptyMedia>
                  <EmptyTitle className="text-[16px] tracking-normal">Нет доступных релизов</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" size="sm" onClick={fetchReleases} className="bg-card! hover:bg-input! gap-1.5">
                    <IconRefresh size={14} />
                    Повторить
                  </Button>
                </EmptyContent>
              </Empty>
            ) : source === 'github' ? (
              <Accordion
                type="single"
                collapsible
                value={openVersion}
                onValueChange={setOpenVersion}
                className="flex flex-col gap-1.5 px-0.5 py-1"
              >
                {releases.map((release) => {
                  const checked = selectedVersion === release.version
                  return (
                    <AccordionItem
                      key={release.version}
                      value={release.version}
                      className={cn(
                        'rounded-lg border transition-all',
                        checked
                          ? 'border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15'
                          : 'border-ring/40 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] hover:border-[#60a5fa] hover:bg-linear-to-b hover:from-blue-500/15 hover:to-blue-500/5'
                      )}
                    >
                      <AccordionTrigger
                        className="min-w-0 overflow-hidden px-3 py-0 hover:no-underline *:data-[slot=accordion-trigger-icon]:hidden"
                        onClick={() => setSelectedVersion(release.version)}
                      >
                        <div className="flex w-full min-w-0 items-center justify-between gap-3 py-2.5">
                          <div className="flex min-w-0 flex-1 flex-col gap-2">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">{release.name || release.version}</span>
                              {release.is_prerelease && (
                                <Badge variant="outline" className="rounded-sm border-none bg-amber-500/10 px-2 text-xs text-amber-400">
                                  Pre-Release
                                </Badge>
                              )}
                            </div>
                            <span className="text-muted-foreground text-xs">{release.published_at}</span>
                          </div>
                          <div
                            className={cn(
                              'flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                              checked ? 'border-primary bg-primary' : 'border-muted-foreground/50'
                            )}
                          >
                            {checked && <div className="bg-primary-foreground size-2 rounded-full" />}
                          </div>
                        </div>
                      </AccordionTrigger>
                      {release.body && (
                        <AccordionContent className="px-3 pt-0 pb-3">
                          <div className="border-ring/20 border-t pt-2.5">
                            <div className="max-h-48 w-full overflow-x-hidden overflow-y-auto">
                              <div className={cn(mdClass, 'min-w-0')}>
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null }}>
                                  {release.body}
                                </ReactMarkdown>
                              </div>
                            </div>
                          </div>
                        </AccordionContent>
                      )}
                    </AccordionItem>
                  )
                })}
              </Accordion>
            ) : (
              <RadioGroup value={selectedVersion} onValueChange={setSelectedVersion} className="gap-1.5 px-0.5 py-1">
                {releases.map((release) => {
                  const checked = selectedVersion === release.version
                  return (
                    <label
                      key={release.version}
                      htmlFor={release.version}
                      className={cn(
                        'flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5 transition-all',
                        checked
                          ? 'border-[#60a5fa] bg-linear-to-b from-blue-500/25 to-blue-500/15'
                          : 'border-ring/40 bg-[linear-gradient(135deg,rgba(59,130,246,0.05)_0%,transparent_50%)] from-blue-500/15 to-blue-500/5 hover:border-[#60a5fa] hover:bg-linear-to-b'
                      )}
                    >
                      <span className="truncate text-sm font-medium">{release.name || release.version}</span>
                      <RadioGroupItem value={release.version} id={release.version} className="mt-0.5 shrink-0" />
                    </label>
                  )
                })}
              </RadioGroup>
            )}
          </ScrollArea>

          <DialogFooter className="shrink-0">
            <Button onClick={install} disabled={!selectedVersion || installing} className="w-full">
              {installing ? 'Установка...' : 'Установить'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
