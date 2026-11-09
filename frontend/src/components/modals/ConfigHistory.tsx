import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from '@/components/ui/code-block'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { apiCall } from '@/lib/api'
import { deleteConfigHistory } from '@/lib/config-history'
import { cn } from '@/lib/utils'
import { IconAlertCircle, IconArrowLeft, IconHistory, IconLoader2, IconRestore, IconTrash } from '@tabler/icons-react'
import { motion } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getConfigChangeLines, revertConfigChange } from '../configuration/config-history-diff'

interface ConfigRevision {
  id: string
  date: string
  content: string
}

interface HistoryChange {
  revision: ConfigRevision
  before: ConfigRevision
  changes: ReturnType<typeof getConfigChangeLines>
}

interface Props {
  file: string
  currentContent: string
  onClose: () => void
  onRollback: (file: string, content: string, revisionId: string) => Promise<void>
  onRollbackAndApply: (file: string, content: string, revisionId: string) => Promise<void>
}

type DiffLine = ReturnType<typeof getConfigChangeLines>[number]
type DiffRow = { left?: DiffLine; right?: DiffLine }
type HistoryResponse = { success: boolean; history?: ConfigRevision[]; error?: string }

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU')
}

function getFileName(file: string) {
  return file.split(/[\\/]/).filter(Boolean).at(-1) || file
}

function buildDiffRows(lines: DiffLine[]) {
  const rows: DiffRow[] = []
  let openRows: DiffRow[] = []
  let previousKind: DiffLine['kind'] | undefined
  for (const change of lines) {
    if (change.kind === 'removed') {
      if (previousKind === 'added') openRows = []
      const row: DiffRow = { left: change }
      rows.push(row)
      openRows.push(row)
    } else {
      const row = openRows.shift()
      if (row) row.right = change
      else rows.push({ right: change })
    }
    previousKind = change.kind
  }
  return rows
}

function SideBySideDiff({ currentContent, entry }: { currentContent: string; entry: HistoryChange }) {
  const rows = useMemo(() => {
    try {
      const restoredContent = revertConfigChange(currentContent, entry.before.content, entry.revision.content)
      return buildDiffRows(getConfigChangeLines(currentContent, restoredContent))
    } catch {
      return null
    }
  }, [currentContent, entry])

  if (!rows) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle />
        <AlertDescription>Изменение не накладывается на текущий конфиг</AlertDescription>
      </Alert>
    )
  }

  if (!rows.length) return <p className="text-sm text-muted-foreground">Текущий конфиг уже совпадает с версией из истории</p>

  return (
    <CodeBlock size="sm" className="bg-background/60">
      <CodeBlockHeader className="grid grid-cols-2 border-b border-border pb-2">
        <CodeBlockTitle>Текущий конфиг</CodeBlockTitle>
        <CodeBlockTitle>Из истории</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-72">
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className="grid grid-cols-2">
            {(['left', 'right'] as const).map((side) => {
              const change = row[side]
              return (
                <CodeBlockLine
                  key={side}
                  variant={change?.kind}
                  data-line={change?.line}
                  className={cn(
                    'mx-0! ps-6! before:me-2 before:inline-block before:min-w-8! before:text-end before:content-[attr(data-line)]',
                    side === 'left' && 'border-e border-border',
                    !change && 'bg-muted/30',
                    change?.kind === 'removed' && 'bg-red-500/10 text-red-800 dark:text-red-200',
                    change?.kind === 'added' && 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                  )}
                >
                  {change?.text}
                </CodeBlockLine>
              )
            })}
          </div>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

export function ConfigHistoryView({ file, currentContent, onClose, onRollback, onRollbackAndApply }: Props) {
  const [history, setHistory] = useState<ConfigRevision[]>([])
  const [expandedIds, setExpandedIds] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [deletingId, setDeletingId] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState('')
  const [isVisible, setIsVisible] = useState(true)
  const [isClosing, setIsClosing] = useState(false)
  const historyPanelRef = useRef<HTMLElement>(null)

  const isBusy = isLoading || !!deletingId
  const fileName = getFileName(file)

  const closeHistory = useCallback(() => {
    if (isClosing) return
    setIsClosing(true)
    setIsVisible(false)
  }, [isClosing])

  const changes = useMemo<HistoryChange[]>(() => {
    const entries: HistoryChange[] = []
    for (let index = 1; index < history.length; index++) {
      const before = history[index - 1]
      const revision = history[index]
      const diff = getConfigChangeLines(before.content, revision.content)
      if (diff.length) entries.push({ revision, before, changes: diff })
    }
    return entries
  }, [history])

  const loadHistory = useCallback(async () => {
    setIsLoading(true)
    setError('')
    try {
      const response = await apiCall<HistoryResponse>('GET', `configs/changes?file=${encodeURIComponent(file)}`)
      if (!response.success) throw new Error(response.error || 'Не удалось загрузить историю')
      setHistory(response.history ?? [])
      setExpandedIds([])
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

  useEffect(() => {
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (confirmDeleteId !== null || confirmClear) return
      if (!(event.target instanceof Element) || historyPanelRef.current?.contains(event.target)) return
      if (event.target.closest('button, a, input, select, textarea, [role="button"], [role="menuitem"], [role="option"]')) return
      closeHistory()
    }
    document.addEventListener('pointerdown', handleOutsidePointerDown)
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown)
  }, [closeHistory, confirmClear, confirmDeleteId])

  function rollback(entry: HistoryChange, apply = false) {
    try {
      const patchedContent = revertConfigChange(currentContent, entry.before.content, entry.revision.content)
      closeHistory()
      void (apply ? onRollbackAndApply : onRollback)(file, patchedContent, entry.revision.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось отменить изменение')
    }
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
      ref={historyPanelRef}
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
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <IconHistory className="size-5 shrink-0 text-chart-2" /> История изменений
            </h2>
            <p className="truncate font-mono text-xs text-muted-foreground">{fileName}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary">{changes.length}</Badge>
          <Popover open={confirmClear} onOpenChange={setConfirmClear}>
            <PopoverTrigger disabled={!changes.length || isBusy} render={<Button variant="destructive" size="sm" />}>
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

      {error && changes.length > 0 && (
        <Alert variant="destructive" className="mx-3 mt-3 w-auto sm:mx-4">
          <IconAlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="flex min-h-full flex-col p-3 sm:p-4">
          {changes.length ? (
            <Accordion
              type="multiple"
              value={expandedIds}
              onValueChange={(value) => {
                setError('')
                setExpandedIds(value)
              }}
              className="gap-3"
            >
              {[...changes].reverse().map((entry, index) => {
                const { revision, changes: diff } = entry
                const number = changes.length - index
                const additions = diff.filter((change) => change.kind === 'added').length
                const removals = diff.length - additions
                return (
                  <AccordionItem
                    key={revision.id}
                    value={revision.id}
                    className={cn('overflow-hidden rounded-xl border bg-background/40 transition-colors', expandedIds.includes(revision.id) && 'border-ring/40 bg-card')}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center">
                      <AccordionTrigger className="min-w-0 items-center gap-3 rounded-none border-0 px-3 py-3 hover:bg-accent/40 hover:no-underline focus-visible:ring-0 sm:px-4">
                        <span className="flex min-w-0 flex-1 items-center gap-3">
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted font-mono text-xs font-semibold">#{number}</span>
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold">Изменение {number}</span>
                            <time className="block text-xs text-muted-foreground">{formatDate(revision.date)}</time>
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <Badge variant="emerald" className="font-mono">+{additions}</Badge>
                          <Badge variant="rose" className="font-mono">−{removals}</Badge>
                        </span>
                      </AccordionTrigger>
                      <Popover open={confirmDeleteId === revision.id} onOpenChange={(open) => setConfirmDeleteId(open ? revision.id : null)}>
                        <PopoverTrigger
                          disabled={isBusy}
                          aria-label={`Удалить изменение ${number}`}
                          render={<Button variant="ghost" size="icon-sm" className="mr-2 text-muted-foreground hover:text-destructive" />}
                        >
                          <IconTrash />
                        </PopoverTrigger>
                        <PopoverContent side="left" align="center" sideOffset={6} className="max-w-72">
                          <PopoverHeader>
                            <PopoverTitle>Удалить это изменение?</PopoverTitle>
                            <PopoverDescription>Запись будет удалена из истории {fileName}.</PopoverDescription>
                          </PopoverHeader>
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" disabled={!!deletingId} onClick={() => setConfirmDeleteId(null)}>Отмена</Button>
                            <Button size="sm" variant="destructive" disabled={!!deletingId} onClick={() => void removeHistory(revision.id)}>
                              {deletingId === revision.id ? <IconLoader2 className="animate-spin" /> : <IconTrash />} Удалить
                            </Button>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>

                    <AccordionContent className="border-t border-border px-3 pt-3 sm:px-4">
                      <SideBySideDiff currentContent={currentContent} entry={entry} />
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="outline" disabled={isBusy} onClick={() => rollback(entry)}>
                          <IconRestore />
                          Отменить
                        </Button>
                        <Button size="sm" disabled={isBusy} onClick={() => rollback(entry, true)}>
                          <IconRestore />
                          Отменить и применить
                        </Button>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                )
              })}
            </Accordion>
          ) : (
            <Empty className="min-h-64 flex-1 rounded-xl border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant={isLoading ? 'default' : 'icon'}>
                  {isLoading ? <IconLoader2 className="size-5 animate-spin text-muted-foreground" /> : <IconHistory />}
                </EmptyMedia>
                <EmptyTitle className="font-medium">{isLoading ? 'Загружаю историю…' : error || 'Изменений пока нет'}</EmptyTitle>
                {!isLoading && !error && <EmptyDescription>Новые записи появятся после сохранения файла.</EmptyDescription>}
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </motion.section>
  )
}
