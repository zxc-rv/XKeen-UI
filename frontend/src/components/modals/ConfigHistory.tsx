import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from '@/components/ui/code-block'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { apiCall } from '@/lib/api'
import { deleteConfigHistory } from '@/lib/config-history'
import { cn } from '@/lib/utils'
import { IconAlertCircle, IconArrowLeft, IconHistory, IconLoader2, IconRestore, IconTrash } from '@tabler/icons-react'
import { motion } from 'framer-motion'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

interface Snapshot {
  id: string
  date: string
}

interface DiffSegment {
  text: string
  emphasized: boolean
}

interface DiffCell {
  line: number
  segments: DiffSegment[]
}

type DiffRow =
  | { type: 'equal'; left_line: number; right_line: number; text: string }
  | { type: 'change'; left: DiffCell | null; right: DiffCell | null }
  | { type: 'skipped'; count: number }

interface DiffPreview {
  rows: DiffRow[]
  content: string
}

interface Props {
  file: string
  currentContent: string
  onClose: () => void
  onRollback: (file: string, content: string) => Promise<void>
  onRollbackAndApply: (file: string, content: string) => Promise<void>
}

type SnapshotsResponse = { success: boolean; history?: Snapshot[]; error?: string }
type DiffResponse = { success: boolean; rows?: DiffRow[]; content?: string; error?: string }

function formatDay(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Сегодня'
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера'
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('ru-RU')
}

function getFileName(file: string) {
  return file.split(/[\\/]/).filter(Boolean).at(-1) || file
}

function DiffLine({ side, line, kind, segments }: { side: 'left' | 'right'; line?: number; kind?: 'added' | 'removed'; segments?: DiffSegment[] }) {
  return (
    <CodeBlockLine
      variant={kind}
      data-line={line}
      className={cn(
        'mx-0! ps-1.5! after:start-9! before:me-5 before:inline-block before:min-w-6! before:text-end before:content-[attr(data-line)]',
        side === 'left' && 'border-e border-border',
        !segments && 'bg-muted/30',
        segments && !kind && 'text-muted-foreground',
        kind === 'removed' && 'bg-red-500/10 text-red-800 dark:text-red-200',
        kind === 'added' && 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
      )}
    >
      {segments?.map((segment, index) => (
        <span key={index} className={cn(segment.emphasized && 'rounded-sm', segment.emphasized && (kind === 'removed' ? 'bg-red-500/40' : 'bg-emerald-500/40'))}>
          {segment.text}
        </span>
      ))}
    </CodeBlockLine>
  )
}

function SnapshotDiff({ preview, onRestore }: { preview: DiffPreview; onRestore: (content: string, apply: boolean) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {!preview.rows.length && <p className="text-sm text-muted-foreground">Снапшот совпадает с текущим конфигом</p>}

      {preview.rows.length > 0 && (
        <CodeBlock size="sm" className="bg-input-background!">
          <CodeBlockHeader className="grid grid-cols-2 border-b border-border pb-2">
            <CodeBlockTitle className="text-sm!">Снапшот</CodeBlockTitle>
            <CodeBlockTitle className="text-sm!">Текущий конфиг</CodeBlockTitle>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-96">
            {preview.rows.map((row, rowIndex) =>
              row.type === 'skipped' ? (
                <div key={rowIndex} className="bg-muted/40 py-0.5 text-center text-xs text-muted-foreground">
                  Скрыто строк: {row.count}
                </div>
              ) : (
                <div key={rowIndex} className="grid grid-cols-2">
                  {row.type === 'equal' ? (
                    <>
                      <DiffLine side="left" line={row.left_line} segments={[{ text: row.text, emphasized: false }]} />
                      <DiffLine side="right" line={row.right_line} segments={[{ text: row.text, emphasized: false }]} />
                    </>
                  ) : (
                    <>
                      <DiffLine side="left" line={row.left?.line} kind={row.left ? 'removed' : undefined} segments={row.left?.segments} />
                      <DiffLine side="right" line={row.right?.line} kind={row.right ? 'added' : undefined} segments={row.right?.segments} />
                    </>
                  )}
                </div>
              )
            )}
          </CodeBlockContent>
        </CodeBlock>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="outline" disabled={!preview.rows.length} onClick={() => onRestore(preview.content, false)}>
          <IconRestore />
          Откатить изменения
        </Button>
        <Button size="sm" disabled={!preview.rows.length} onClick={() => onRestore(preview.content, true)}>
          <IconRestore />
          Откатить и применить
        </Button>
      </div>
    </div>
  )
}

export function ConfigHistoryView({ file, currentContent, onClose, onRollback, onRollbackAndApply }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [expandedIds, setExpandedIds] = useState<string[]>([])
  const [previews, setPreviews] = useState<Record<string, DiffPreview>>({})
  const [loadingId, setLoadingId] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState('')
  const [isVisible, setIsVisible] = useState(true)
  const [isClosing, setIsClosing] = useState(false)

  const isBusy = isLoading || !!deletingId
  const fileName = getFileName(file)

  const closeHistory = useCallback(() => {
    if (isClosing) return
    setIsClosing(true)
    setIsVisible(false)
  }, [isClosing])

  const groups = useMemo(() => {
    const result: { day: string; entries: { snapshot: Snapshot; number: number }[] }[] = []
    for (let index = snapshots.length - 1; index >= 0; index--) {
      const day = formatDay(snapshots[index].date)
      const entry = { snapshot: snapshots[index], number: index + 1 }
      const group = result.at(-1)
      if (group?.day === day) group.entries.push(entry)
      else result.push({ day, entries: [entry] })
    }
    return result
  }, [snapshots])

  const loadHistory = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      const response = await apiCall<SnapshotsResponse>('GET', `configs/changes?file=${encodeURIComponent(file)}`)
      if (!response.success) throw new Error(response.error || 'Не удалось загрузить историю')
      setSnapshots(response.history ?? [])
      setExpandedIds([])
      setPreviews({})
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось загрузить историю')
    } finally {
      setIsLoading(false)
    }
  }, [file])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeHistory()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeHistory])

  async function changeExpanded(value: string[]) {
    setError('')
    const openedId = value.find((id) => !expandedIds.includes(id))
    if (!openedId) return setExpandedIds(value)
    if (loadingId) return
    setLoadingId(openedId)
    try {
      const response = await apiCall<DiffResponse>('POST', 'configs/changes/diff', { file, id: openedId, current_content: currentContent })
      if (!response.success || !response.rows || response.content === undefined) throw new Error(response.error || 'Не удалось построить diff')
      const preview: DiffPreview = { rows: response.rows, content: response.content }
      setPreviews((previous) => ({ ...previous, [openedId]: preview }))
      setExpandedIds((previous) => [...previous, openedId])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось построить diff')
    } finally {
      setLoadingId('')
    }
  }

  function restore(content: string, apply: boolean) {
    closeHistory()
    void (apply ? onRollbackAndApply : onRollback)(file, content)
  }

  async function removeHistory(id?: string) {
    setDeletingId(id ?? 'all')
    setError('')
    try {
      const deleteError = await deleteConfigHistory(file, id)
      if (deleteError) throw new Error(deleteError)
      setConfirmDeleteId(null)
      setConfirmClear(false)
      await loadHistory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось удалить историю')
    } finally {
      setDeletingId('')
    }
  }

  return (
    <motion.section
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-card text-foreground"
      initial={{ opacity: 0, y: 8, scale: 0.985 }}
      animate={isVisible ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 6, scale: 0.985 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      onAnimationComplete={() => {
        if (isClosing && !isVisible) onClose()
      }}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="outline" size="icon" aria-label="Выйти из истории изменений" onClick={closeHistory}>
            <IconArrowLeft />
          </Button>
          <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
            <h2 className="flex shrink-0 items-center gap-2.5 text-lg font-semibold">
              <IconHistory className="size-6 shrink-0 text-chart-2" /> История изменений
            </h2>
            <p className="truncate text-sm text-muted-foreground">{fileName}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Popover open={confirmClear} onOpenChange={setConfirmClear}>
            <PopoverTrigger disabled={!snapshots.length || isBusy} render={<Button variant="destructive" size="sm" />}>
              <IconTrash /> <span className="hidden sm:inline">Очистить</span>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" sideOffset={6} className="max-w-72">
              <PopoverHeader>
                <PopoverTitle>Очистить историю изменений?</PopoverTitle>
                <PopoverDescription>История файла {fileName} будет удалена.</PopoverDescription>
              </PopoverHeader>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" disabled={!!deletingId} onClick={() => setConfirmClear(false)}>Отмена</Button>
                <Button size="sm" variant="destructive" disabled={!!deletingId} onClick={() => void removeHistory()}>
                  {deletingId === 'all' ? <IconLoader2 className="animate-spin" /> : <IconTrash />} Очистить
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </header>

      {error && snapshots.length > 0 && (
        <Alert variant="destructive" className="mx-3 mt-3 w-auto sm:mx-4">
          <IconAlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="flex min-h-full flex-col p-3 sm:p-4">
          {snapshots.length ? (
            <Accordion
              type="multiple"
              value={expandedIds}
              onValueChange={(value) => void changeExpanded(value)}
              className="gap-3"
            >
              {groups.map((group) => (
                <Fragment key={group.day}>
                  <h3 className="mt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase first:mt-0">{group.day}</h3>
                  {group.entries.map(({ snapshot, number }) => (
                    <AccordionItem
                      key={snapshot.id}
                      value={snapshot.id}
                      className="overflow-hidden rounded-xl border bg-background/40"
                    >
                      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center">
                        <AccordionTrigger className="min-w-0 items-center gap-3 rounded-none border-0 px-3 py-3 hover:bg-accent/40 hover:no-underline focus-visible:ring-0 sm:px-4">
                          <span className="flex min-w-0 flex-1 items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-xs font-semibold">#{number}</span>
                            <span className="min-w-0">
                              <span className="block text-sm font-semibold">Снапшот {number}</span>
                              <time className="block text-xs text-muted-foreground">{formatTime(snapshot.date)}</time>
                            </span>
                          </span>
                          {loadingId === snapshot.id && <IconLoader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
                        </AccordionTrigger>
                        <Popover open={confirmDeleteId === snapshot.id} onOpenChange={(open) => setConfirmDeleteId(open ? snapshot.id : null)}>
                          <PopoverTrigger
                            disabled={isBusy}
                            aria-label={`Удалить снапшот ${number}`}
                            render={<Button variant="ghost" size="icon-sm" className="mr-2 text-muted-foreground hover:text-destructive" />}
                          >
                            <IconTrash />
                          </PopoverTrigger>
                          <PopoverContent side="left" align="center" sideOffset={6} className="max-w-72">
                            <PopoverHeader>
                              <PopoverTitle>Удалить этот снапшот?</PopoverTitle>
                              <PopoverDescription>Запись будет удалена из истории {fileName}.</PopoverDescription>
                            </PopoverHeader>
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="outline" disabled={!!deletingId} onClick={() => setConfirmDeleteId(null)}>Отмена</Button>
                              <Button size="sm" variant="destructive" disabled={!!deletingId} onClick={() => void removeHistory(snapshot.id)}>
                                {deletingId === snapshot.id ? <IconLoader2 className="animate-spin" /> : <IconTrash />} Удалить
                              </Button>
                            </div>
                          </PopoverContent>
                        </Popover>
                      </div>

                      <AccordionContent className="border-t border-border px-3 pt-3 sm:px-4">
                        {previews[snapshot.id] && <SnapshotDiff preview={previews[snapshot.id]} onRestore={restore} />}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Fragment>
              ))}
            </Accordion>
          ) : (
            <Empty className="min-h-64 flex-1 rounded-xl border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant={isLoading ? 'default' : 'icon'}>
                  {isLoading ? <IconLoader2 className="size-5 animate-spin text-muted-foreground" /> : <IconHistory />}
                </EmptyMedia>
                <EmptyTitle className="font-medium">{isLoading ? 'Загружаю историю…' : error || 'Снапшотов пока нет'}</EmptyTitle>
                {!isLoading && !error && <EmptyDescription>Новые записи появятся после сохранения файла.</EmptyDescription>}
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </motion.section>
  )
}
