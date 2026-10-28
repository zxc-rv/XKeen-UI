import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { IconCancel, IconDownload, IconLogs, IconPlaylistX, IconRefresh, IconWorldShare } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { apiCall, capitalize } from '../../lib/api'
import { useAppContext, useModalContext, useSettings } from '../../lib/store'
import type { Release } from '../../lib/types'
import type { UpdateEvent, WsMessage } from '../../lib/websocket'
import { useUpdateWebSocket } from '../../lib/websocket'
import { cn, repoSlug } from '../../lib/utils'

const GITHUB_API = 'https://api.github.com/repos'
const JSDELIVR_API = 'https://data.jsdelivr.com/v1/package/gh'
const FETCH_TIMEOUT_MS = 5000
const CORE_REPOS = {
  xray: 'XTLS/Xray-core',
  mihomo: 'MetaCubeX/mihomo',
  self: 'zxc-rv/XKeen-UI',
} as const

const LEVEL_CLASSES: Record<string, string> = {
  info: 'text-foreground/80',
  warn: 'text-amber-400',
  error: 'text-red-400',
}

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

const fetchWithTimeout = (url: string, init?: RequestInit) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

interface ProcessProps {
  open: boolean
  core: string
  coreLabel: string
  version: string
  assets: string[]
  backupCore: boolean
  onInstalled: () => void
  onStartFailed: () => void
  onClose: () => void
}

interface LogLine {
  ts: string
  level: string
  message: string
}

/** Записи журнала: обычные строки лога и «живые» строки прогресса (по одной на файл). */
type Entry = { kind: 'log'; id: number; line: LogLine } | { kind: 'progress'; id: number; downloaded: number; total: number; speed: number }

function UpdateProcessModal({ open, core, coreLabel, version, assets, backupCore, onInstalled, onStartFailed, onClose }: ProcessProps) {
  const { dispatch, showToast } = useAppContext()
  const githubProxies = useSettings((s) => s.githubProxies)
  /** Записи журнала: обычные строки лога и «живые» строки прогресса (по одной на файл). */
  const [entries, setEntries] = useState<Entry[]>([])
  const [stage, setStage] = useState('')
  const [running, setRunning] = useState(true)
  const [started, setStarted] = useState(false)
  const [result, setResult] = useState<{ success: boolean; error: string | null } | null>(null)

  const logRef = useRef<HTMLPreElement>(null)
  const doneHandledRef = useRef(false)
  const startedRef = useRef(false)
  const lastSeqRef = useRef(0)
  const nextEntryIdRef = useRef(1)
  const activeProgressIdRef = useRef<number | null>(null)
  const propsRef = useRef({ core, coreLabel, version, onInstalled, showToast })
  useEffect(() => {
    propsRef.current = { core, coreLabel, version, onInstalled, showToast }
  })

  const restoreStatus = useCallback(() => {
    apiCall<any>('GET', 'control')
      .then((data) => {
        if (data.success) {
          dispatch({ type: 'SET_SERVICE_STATUS', status: data.running ? 'running' : 'stopped' })
        }
      })
      .catch(() => dispatch({ type: 'SET_SERVICE_STATUS', status: 'stopped' }))
  }, [dispatch])

  const applyEvent = useCallback(
    (ev: UpdateEvent) => {
      // Дедупликация: событие может прийти и из истории, и из broadcast-потока.
      if (typeof ev.seq === 'number') {
        if (ev.seq <= lastSeqRef.current) return
        lastSeqRef.current = ev.seq
      }
      switch (ev.type) {
        case 'log': {
          const line = { ts: ev.ts ?? '', level: ev.level ?? 'info', message: ev.message ?? '' }
          // Любая строка лога — это граница попытки: активная строка прогресса замораживается.
          // Новая закачка получит свою строку прогресса по первому реально пришедшему чанку.
          activeProgressIdRef.current = null
          setEntries((prev) => [...prev.slice(-199), { kind: 'log' as const, id: nextEntryIdRef.current++, line }])
          break
        }
        case 'stage':
          setStage(ev.stage ?? '')
          if (ev.stage !== 'download') activeProgressIdRef.current = null
          break
        case 'progress': {
          const values = { downloaded: ev.downloaded ?? 0, total: ev.total ?? 0, speed: ev.speed ?? 0 }
          activeProgressIdRef.current ??= nextEntryIdRef.current++
          const progressId = activeProgressIdRef.current
          setEntries((prev) =>
            prev.some((e) => e.kind === 'progress' && e.id === progressId)
              ? prev.map((e) => (e.kind === 'progress' && e.id === progressId ? { ...e, ...values } : e))
              : [...prev.slice(-199), { kind: 'progress' as const, id: progressId, ...values }]
          )
          break
        }
        case 'done': {
          if (doneHandledRef.current) break
          doneHandledRef.current = true
          activeProgressIdRef.current = null
          setRunning(false)
          setResult({ success: !!ev.success, error: ev.error ?? null })
          const { core, coreLabel, version, onInstalled, showToast } = propsRef.current
          if (ev.success) {
            if (core === 'self') {
              showToast(`Установлен XKeen UI ${version} — перезапуск интерфейса`)
              setTimeout(() => window.location.reload(), 1000)
            } else {
              showToast(`Установлен ${coreLabel} ${version}`)
              onInstalled()
              restoreStatus()
            }
          } else {
            showToast(ev.error || 'Обновление отменено', ev.error?.includes('Отменено') ? 'warning' : 'error')
            restoreStatus()
          }
          break
        }
      }
    },
    [restoreStatus]
  )

  const handleWsMessage = useCallback(
    (data: WsMessage) => {
      if (data.type !== 'update') return
      if (data.history) {
        const newestSeq = data.history.at(-1)?.seq ?? 0
        if (newestSeq < lastSeqRef.current) {
          lastSeqRef.current = 0
          activeProgressIdRef.current = null
        }
        data.history.forEach(applyEvent)
      } else if (data.event) {
        applyEvent(data.event)
      }
    },
    [applyEvent]
  )

  useUpdateWebSocket(handleWsMessage, started)

  // Запуск обновления — один раз при монтировании окна процесса.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const { core, version, showToast } = propsRef.current
    apiCall<{ success: boolean; error?: string }>('POST', 'update', {
      core,
      version,
      backup_core: backupCore,
      assets,
    })
      .then((data) => {
        if (data.success) {
          setStarted(true)
          return
        }
        showToast(data.error || 'Не удалось запустить обновление', 'error')
        restoreStatus()
        onStartFailed()
      })
      .catch(() => {
        showToast('Не удалось запустить обновление', 'error')
        restoreStatus()
        onStartFailed()
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Автоскролл журнала процесса.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  // Страховка для self-обновления: если событие done потерялось при перезапуске бэкенда — перезагружаемся.
  useEffect(() => {
    if (core !== 'self' || !running || stage !== 'restart') return
    const timer = setTimeout(() => window.location.reload(), 20000)
    return () => clearTimeout(timer)
  }, [core, running, stage])

  const control = (action: 'cancel' | 'proxy') => {
    apiCall('POST', 'update/control', { action }).catch(() => {})
  }

  const handleClose = () => {
    if (running) return
    if (core === 'self' && result?.success) {
      window.location.reload()
      return
    }
    onClose()
  }

  // Строка прогресса живёт как строка лога и остаётся видимой после завершения загрузки.
  // Позиция строки прогресса — просто очередная запись журнала.
  const renderLogLine = ({ id, line }: Extract<Entry, { kind: 'log' }>) => (
    <div key={`l${id}`} className="flex gap-2 wrap-anywhere">
      {line.ts && <span className="text-muted-foreground/50 shrink-0">{line.ts}</span>}
      <span className={line.message.startsWith('✓') ? 'font-medium text-green-400' : (LEVEL_CLASSES[line.level] ?? LEVEL_CLASSES.info)}>
        {line.message}
      </span>
    </div>
  )

  const renderProgressLine = (e: Extract<Entry, { kind: 'progress' }>) => {
    const pct = e.total > 0 ? Math.min(100, (e.downloaded / e.total) * 100) : null
    return (
      <div key={`p${e.id}`} className="flex items-center gap-2 wrap-anywhere">
        <Progress value={pct} className="min-w-16 flex-1 [&_[data-slot=progress-track]]:h-1.5" />
        <span className="text-muted-foreground shrink-0 font-mono">
          {pct !== null && `${Math.round(pct)}% · `}
          {formatBytes(e.downloaded)}
          {running && e.id === activeProgressIdRef.current && e.speed > 0 && ` · ${formatBytes(e.speed)}/с`}
        </span>
      </div>
    )
  }
  const selfRestarting = core === 'self' && result?.success
  // Управление доступно, пока идёт загрузка; после неё процесс доводится до конца.
  const canControl = running && (stage === '' || stage === 'prepare' || stage === 'download')

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent showCloseButton={!running} className="w-full max-w-[95vw]! p-0! md:w-150">
        <div className="flex flex-col gap-4 p-6">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 pr-8">
              <IconDownload size={24} className="text-chart-2" />
              Обновление {coreLabel}
            </DialogTitle>
          </DialogHeader>

          <CodeBlock size="sm" className="bg-muted/30 ring-ring/10 border-none ring-1">
            <CodeBlockContent
              ref={logRef}
              wrap
              className="h-72 [&>code:has([data-slot=empty])]:h-full [&>code:has([data-slot=empty])]:content-center"
            >
              {entries.length === 0 ? (
                <Empty className="p-2 font-sans">
                  <EmptyMedia variant="icon">
                    <IconLogs />
                  </EmptyMedia>
                  <EmptyTitle>Журнал пуст</EmptyTitle>
                  <EmptyDescription>Ожидание событий обновления...</EmptyDescription>
                </Empty>
              ) : (
                entries.map((e) => (e.kind === 'log' ? renderLogLine(e) : renderProgressLine(e)))
              )}
            </CodeBlockContent>
          </CodeBlock>

          <DialogFooter className="shrink-0">
            {running ? (
              <div className="flex w-full gap-2">
                <Button
                  variant="outline"
                  onClick={() => control('proxy')}
                  disabled={!canControl || githubProxies.length === 0}
                  className="flex-1 gap-1.5"
                >
                  <IconWorldShare size={16} />
                  GitHub прокси
                </Button>
                <Button variant="destructive" onClick={() => control('cancel')} disabled={!canControl} className="flex-1 gap-1.5">
                  <IconCancel size={16} />
                  Отмена
                </Button>
              </div>
            ) : (
              <Button onClick={handleClose} className="w-full gap-1.5">
                {selfRestarting ? (
                  <>
                    <IconRefresh size={16} />
                    Перезагрузить
                  </>
                ) : (
                  'Закрыть'
                )}
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function UpdateModal({ onInstalled }: { onInstalled: () => void }) {
  const { dispatch, showToast } = useAppContext()
  const { modals } = useModalContext()
  const backupCore = useSettings((s) => s.backupCore)
  const githubProxies = useSettings((s) => s.githubProxies)
  const xrayRepo = useSettings((s) => s.xrayRepo)
  const mihomoRepo = useSettings((s) => s.mihomoRepo)
  const { updateModalCore } = modals
  const [releases, setReleases] = useState<Release[]>([])
  const [selectedVersion, setSelectedVersion] = useState('')
  const [openVersion, setOpenVersion] = useState('')
  const [source, setSource] = useState<'github' | 'jsdelivr' | ''>('')
  const [loading, setLoading] = useState(true)
  const [step, setStep] = useState<'select' | 'process'>('select')
  const [pending, setPending] = useState<{ version: string; assets: string[] } | null>(null)

  const coreLabel = updateModalCore === 'self' ? 'XKeen UI' : capitalize(updateModalCore)
  const repo =
    updateModalCore === 'self'
      ? CORE_REPOS.self
      : updateModalCore === 'xray'
        ? repoSlug(xrayRepo) || CORE_REPOS.xray
        : updateModalCore === 'mihomo'
          ? repoSlug(mihomoRepo) || CORE_REPOS.mihomo
          : ''
  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showUpdateModal', show: false })

  useEffect(() => {
    if (!modals.showUpdateModal) {
      setStep('select')
      setPending(null)
      return
    }
    fetchReleases()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modals.showUpdateModal, updateModalCore, repo])

  async function fetchReleases() {
    setLoading(true)
    setSelectedVersion('')
    setOpenVersion('')
    setReleases([])
    setSource('')
    try {
      if (!repo) throw new Error('UNKNOWN_CORE')

      const ghUrl = `${GITHUB_API}/${repo}/releases?per_page=10`
      const ghUrls = [ghUrl, ...githubProxies.map((p) => `${p.replace(/\/+$/, '')}/${ghUrl}`)]

      for (const url of ghUrls) {
        let res: Response
        try {
          res = await fetchWithTimeout(url, { headers: { Accept: 'application/vnd.github+json' } })
        } catch {
          continue
        }
        if (!res.ok) continue
        const rels = (await res.json()) as Array<{
          tag_name?: string
          name?: string
          published_at?: string
          prerelease?: boolean
          body?: string | null
          assets?: Array<{ name: string; browser_download_url: string }>
        }>
        const parsed = (rels ?? [])
          .map((r) => ({
            version: (r.tag_name ?? '').replace(/^v/i, ''),
            name: r.name ?? '',
            published_at: (r.published_at ?? '').split('T')[0] ?? '',
            is_prerelease: !!r.prerelease,
            body: r.body ?? '',
            assets: (r.assets ?? []).map((a) => a.name),
          }))
          .filter((r) => r.version)

        if (parsed.length) {
          setReleases(parsed)
          setSelectedVersion(parsed[0].version)
          setOpenVersion(parsed[0].version)
          setSource('github')
          setLoading(false)
          return
        }
      }

      const jsdRes = await fetchWithTimeout(`${JSDELIVR_API}/${repo}`).catch(() => null)
      if (jsdRes?.ok) {
        const jsd = (await jsdRes.json()) as { versions?: string[] }
        const versions = (jsd.versions ?? []).slice(0, 10)
        if (versions.length) {
          const parsed = versions.map((v) => ({
            version: v,
            name: `Release ${v}`,
            published_at: '',
            is_prerelease: false,
            body: '',
            assets: [],
          }))
          setReleases(parsed)
          setSelectedVersion(parsed[0].version)
          setOpenVersion(parsed[0].version)
          setSource('jsdelivr')
          setLoading(false)
          return
        }
      }

      throw new Error('NO_RELEASES')
    } catch {
      showToast('Не удалось получить список релизов', 'error')
    }
    setLoading(false)
  }

  function startInstall() {
    if (!selectedVersion) return
    const release = releases.find((r) => r.version === selectedVersion)
    if (updateModalCore !== 'self') dispatch({ type: 'REMOVE_TOAST', id: 'update-core' })
    dispatch({ type: 'SET_SERVICE_STATUS', status: 'pending', pendingText: 'Обновление...' })
    setPending({ version: selectedVersion, assets: release?.assets ?? [] })
    setStep('process')
  }

  return (
    <>
      <Dialog open={modals.showUpdateModal && step === 'select' && !pending} onOpenChange={(open) => !open && close()}>
        <DialogContent className="w-full max-w-[95vw]! p-0! md:w-187.5">
          <div className="flex max-h-[90dvh] flex-col gap-4 overflow-hidden p-6">
            <DialogHeader className="shrink-0">
              <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
                <IconDownload size={24} className="text-chart-2" />
                Обновление {coreLabel}
              </DialogTitle>

              <DialogDescription
                className="flex w-full items-center justify-between"
                render={
                  <div>
                    Выберите версию
                    <span className="flex items-center gap-1.5">
                      {repo && (
                        <Badge variant="outline" className="border-ring/40 bg-muted/50 h-5 rounded-full px-2 text-xs font-medium">
                          {repo}
                        </Badge>
                      )}
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
                    </span>
                  </div>
                }
              />
            </DialogHeader>

            <ScrollArea className="h-125 min-h-0" hideScrollbar>
              {loading ? (
                <div className="text-muted-foreground flex min-h-125 flex-col items-center justify-center gap-3">
                  <Spinner className="text-chart-2 size-10" />
                  <span className="text-sm tracking-normal">Загрузка релизов...</span>
                </div>
              ) : releases.length === 0 ? (
                <Empty className="min-h-125 border-none">
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
                              <div className="max-h-48 w-full scrollbar-thin overflow-x-hidden overflow-y-auto">
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
              <Button onClick={startInstall} disabled={!selectedVersion} className="w-full">
                Установить
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {pending && (
        <UpdateProcessModal
          open={step === 'process'}
          core={updateModalCore}
          coreLabel={coreLabel}
          version={pending.version}
          assets={pending.assets}
          backupCore={backupCore}
          onInstalled={onInstalled}
          onStartFailed={() => {
            // Окно процесса закрывается с анимацией, затем возвращаемся к выбору версии.
            setStep('select')
            window.setTimeout(() => setPending(null), 250)
          }}
          onClose={() => {
            // open=false запускает exit-анимацию; размонтируем и закрываем модалку после неё.
            setStep('select')
            window.setTimeout(() => {
              setPending(null)
              close()
            }, 250)
          }}
        />
      )}
    </>
  )
}
