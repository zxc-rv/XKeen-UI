import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { apiCall } from '@/lib/api'
import { deleteConfigHistory } from '@/lib/config-history'
import { cn } from '@/lib/utils'
import { IconArrowLeft, IconChevronDown, IconHistory, IconLoader2, IconRestore, IconTrash } from '@tabler/icons-react'
import { CodeBlock, CodeBlockContent, CodeBlockLine } from '@/components/ui/code-block'
import { AnimatePresence, motion } from 'framer-motion'
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

type HistoryResponse = { success: boolean; history?: ConfigRevision[]; error?: string }

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU')
}

function getFileName(file: string) {
  return file.split(/[\\/]/).filter(Boolean).at(-1) || file
}

export function ConfigHistoryView({ file, currentContent, onClose, onRollback, onRollbackAndApply }: Props) {
  const [history, setHistory] = useState<ConfigRevision[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [isLoading, setIsLoading] = useState(true)
  const [rollingBackId, setRollingBackId] = useState('')
  const [deletingId, setDeletingId] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState('')
  const [isVisible, setIsVisible] = useState(true)
  const [isClosing, setIsClosing] = useState(false)
  const historyPanelRef = useRef<HTMLElement>(null)

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
      const items = response.history ?? []
      setHistory(items)
      setExpandedIds(new Set())
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

  async function rollback(entry: HistoryChange, apply = false) {
    setRollingBackId(entry.revision.id)
    setError('')
    try {
      const patchedContent = revertConfigChange(currentContent, entry.before.content, entry.revision.content)
      if (apply) await onRollbackAndApply(file, patchedContent, entry.revision.id)
      else await onRollback(file, patchedContent, entry.revision.id)
      await loadHistory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось отменить изменение')
    } finally {
      setRollingBackId('')
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
    <>
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
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-4 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="outline" size="icon" aria-label="Выйти из журнала изменений" onClick={closeHistory}>
            <IconArrowLeft />
          </Button>
          <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold">
            <IconHistory size={24} className="shrink-0 text-chart-2" /> Журнал изменений
          </h2>
        </div>
        <div className="ml-auto flex w-full shrink-0 flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
          <span className="rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-foreground">Изменений · {changes.length}</span>
          <Popover open={confirmClear} onOpenChange={setConfirmClear}>
            <PopoverTrigger disabled={!changes.length || isLoading || !!deletingId} render={<Button variant="destructive" size="sm" />}>
              <IconTrash /> Очистить
            </PopoverTrigger>
            <PopoverContent side="bottom" align="end" sideOffset={6} className="max-w-72">
              <PopoverHeader>
                <PopoverTitle>Очистить журнал изменений?</PopoverTitle>
                <PopoverDescription>История файла {getFileName(file)} будет удалена.</PopoverDescription>
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

      <div className="relative m-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-input-background text-foreground">
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3 sm:p-4">
        {isLoading && !history.length ? (
          <div className="flex h-full min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
            <IconLoader2 className="size-4 animate-spin" /> Загружаю историю…
          </div>
        ) : changes.length ? (
          <div className="space-y-2.5">
            {changes.map((entry, index) => {
              const { revision, changes: diff } = entry
              const isExpanded = expandedIds.has(revision.id)
              const additions = diff.filter((change) => change.kind === 'added').length
              const removals = diff.filter((change) => change.kind === 'removed').length
              return (
                <article key={revision.id} className={cn('overflow-hidden rounded-lg border border-border bg-card text-foreground transition-colors', isExpanded && 'ring-1 ring-border')}>
                  <div className="flex items-stretch">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => {
                        setError('')
                        setExpandedIds((current) => {
                          const next = new Set(current)
                          if (next.has(revision.id)) next.delete(revision.id)
                          else next.add(revision.id)
                          return next
                        })
                      }}
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none sm:px-4"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-sm font-semibold text-foreground">{index + 1}</span>
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-sm font-semibold">Изменение {index + 1}</span>
                            <span className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[11px] font-medium text-foreground">{getFileName(file)}</span>
                          </span>
                          <time className="mt-1 block text-xs text-muted-foreground">{formatDate(revision.date)}</time>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        <span className="hidden items-center gap-1.5 sm:flex">
                          <span className="text-emerald-500">+{additions}</span>
                          <span className="text-red-400">−{removals}</span>
                        </span>
                        <IconChevronDown className={cn('size-4', !isExpanded && '-rotate-90')} />
                      </span>
                    </button>
                    <Popover open={confirmDeleteId === revision.id} onOpenChange={(open) => setConfirmDeleteId(open ? revision.id : null)}>
                      <PopoverTrigger
                        disabled={!!deletingId || !!rollingBackId}
                        aria-label={`Удалить изменение ${index + 1}`}
                        render={<Button variant="ghost" size="icon-sm" className="my-auto mr-2 text-muted-foreground hover:text-destructive" />}
                      >
                        <IconTrash />
                      </PopoverTrigger>
                      <PopoverContent side="left" align="center" sideOffset={6} className="max-w-72">
                        <PopoverHeader>
                          <PopoverTitle>Удалить это изменение?</PopoverTitle>
                          <PopoverDescription>Запись будет удалена из журнала {getFileName(file)}.</PopoverDescription>
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

                  <AnimatePresence initial={false}>
                    {isExpanded && (
                    <motion.div
                      key="change-details"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                    <div className="border-t border-border px-3 py-3 sm:px-4 sm:py-4">
                      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <CodeBlock size="sm" className="order-2 min-w-0 w-full bg-background/40 sm:order-1 sm:w-1/2 sm:flex-none">
                          <CodeBlockContent className="max-h-64">
                          {diff.map((change, changeIndex) => (
                            <CodeBlockLine
                              key={`${change.kind}-${change.line}-${changeIndex}`}
                              variant={change.kind}
                              data-line={change.line}
                              className={cn(
                                'before:ms-1 before:me-1 before:content-[attr(data-line)]',
                                change.kind === 'removed' ? 'bg-red-500/10 text-red-800 dark:text-red-200' : 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                              )}
                            >
                              {change.text.trimStart() || ' '}
                            </CodeBlockLine>
                          ))}
                          </CodeBlockContent>
                        </CodeBlock>
                        <div className="order-1 flex w-full flex-wrap gap-2 sm:order-2 sm:w-auto sm:shrink-0 sm:justify-end">
                          <Button className="w-fit whitespace-nowrap" size="sm" variant="outline" disabled={!!rollingBackId || isLoading || !!deletingId} onClick={() => void rollback(entry)}>
                            {rollingBackId === revision.id ? <IconLoader2 className="animate-spin" /> : <IconRestore />}
                            Отменить изменение
                          </Button>
                          <Button className="w-fit whitespace-nowrap" size="sm" disabled={!!rollingBackId || isLoading || !!deletingId} onClick={() => void rollback(entry, true)}>
                            {rollingBackId === revision.id ? <IconLoader2 className="animate-spin" /> : <IconRestore />}
                            Откатить и применить
                          </Button>
                        </div>
                      </div>
                    </div>
                    </motion.div>
                  )}
                  </AnimatePresence>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="flex h-full min-h-32 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-background/25 px-5 text-center">
            {isLoading ? <IconLoader2 className="mb-2 size-5 animate-spin text-muted-foreground" /> : <IconHistory className="mb-2 size-6 text-muted-foreground/70" />}
            <p className="text-sm font-medium">{error || 'Изменений пока нет'}</p>
            {!error && <p className="mt-1 text-xs text-muted-foreground">Новые записи появятся после сохранения файла.</p>}
          </div>
        )}
        {error && changes.length > 0 && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        </div>
      </div>
      </motion.section>

    </>
  )
}
