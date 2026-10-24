import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { IconBolt, IconCode, IconDeviceFloppy, IconGripVertical, IconPlus, IconTrash, IconX } from '@tabler/icons-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCall } from '../../../lib/api'
import { appendPingEntries, clearPingHistory, useAppActions, usePingHistoryStore, type PingEntry } from '../../../lib/store'
import type { Config } from '../../../lib/types'
import { cn, copyText } from '../../../lib/utils'
import { parse as parseJsonc } from 'jsonc-parser'
import type { CodeMirrorRef } from '../CodeMirror'
import { ProviderEditor } from '../editor/ProviderEditor'

type Outbound = Record<string, any>

const XRAY_START_ERROR = 'Не удалось запустить Xray, проверьте журнал'

type GenerateConfigForCore = (uri: string, core: string, existingConfig: string) => { type: string; content: string }

const OUTBOUND_LINK_PREFIXES = ['ss://', 'vless://', 'vmess://', 'hysteria2://', 'hy2://', 'trojan://']

interface OutboundMeta {
  protocol: string
  protocolLabel?: string
  address?: string
  port?: string | number
  network?: string
  security?: string
  sni?: string
  fingerprint?: string
  flow?: string
  domainStrategy?: string
  sockoptDomainStrategy?: string
  alpn?: string[]
  muxEnabled?: boolean
  congestion?: string
}

function parseOutbounds(content: string): Outbound[] {
  try {
    const json = parseJsonc(content)
    if (Array.isArray(json?.outbounds)) return JSON.parse(JSON.stringify(json.outbounds))
  } catch {
    /* */
  }
  return []
}

/** Достаёт из аутбаунда человекочитаемые метаданные подключения. */
function extractMeta(ob: Outbound): OutboundMeta {
  const s = ob.settings ?? {}
  const stream = ob.streamSettings ?? {}
  const tls = stream.tlsSettings ?? {}
  const reality = stream.realitySettings ?? {}
  const server = Array.isArray(s.servers) ? s.servers[0] : undefined

  let address: string | undefined = s.address ?? server?.address
  let port: string | number | undefined = s.port ?? server?.port
  // wireguard хранит конечную точку в peers[].endpoint как "host:port"
  if (!address && ob.protocol === 'wireguard') {
    if (Array.isArray(s.peers) && typeof s.peers[0]?.endpoint === 'string') {
      const endpoint: string = s.peers[0].endpoint
      const i = endpoint.lastIndexOf(':')
      address = i >= 0 ? endpoint.slice(0, i) : endpoint
      port = i >= 0 ? endpoint.slice(i + 1).replace(/\/.*$/, '') : undefined
    }
  }

  const sni = tls.serverName ?? reality.serverName ?? s.sni ?? undefined
  const alpn = Array.isArray(tls.alpn) && tls.alpn.length ? tls.alpn : Array.isArray(s.alpn) && s.alpn.length ? s.alpn : undefined
  const security =
    stream.security === 'tls' || stream.security === 'reality' ? stream.security : tls.serverName || reality.serverName ? 'tls' : 'none'
  // При security tls/reality без явного fingerprint Xray использует uTLS с профилем chrome — показываем дефолт.
  const fpDefault = security === 'tls' || security === 'reality' ? 'chrome' : undefined
  const fingerprint = tls.fingerprint ?? reality.fingerprint ?? fpDefault

  // mux: поле аутбаунда
  const muxObj = ob.mux ?? (s.muxEnabled != null ? { enabled: s.muxEnabled } : undefined)

  // freedom: доменная стратегия может задаваться и в settings, и в streamSettings.sockopt
  const isFreedom = ob.protocol === 'freedom'
  const domainStrategy = isFreedom && s.domainStrategy ? String(s.domainStrategy) : undefined
  const sockoptDomainStrategy = isFreedom && stream.sockopt?.domainStrategy ? String(stream.sockopt.domainStrategy) : undefined

  // hysteria: метод управления перегрузкой QUIC живёт в streamSettings.finalmask.quicParams
  const isHysteria = ob.protocol === 'hysteria'
  const congestion = isHysteria && stream.finalmask?.quicParams?.congestion ? String(stream.finalmask.quicParams.congestion) : undefined
  const version = ob.hysteriaSettings?.version ?? stream.hysteriaSettings?.version ?? s.version
  const protocolLabel = isHysteria && version === 2 ? 'Hysteria2' : undefined

  return {
    protocol: String(ob.protocol ?? 'unknown'),
    protocolLabel,
    address: address != null && address !== '' ? String(address) : undefined,
    port: port != null && port !== '' ? (Number.isFinite(+port) ? +port : String(port)) : undefined,
    network: stream.network ? String(stream.network) : undefined,
    security,
    sni: sni ? String(sni) : undefined,
    fingerprint: fingerprint ? String(fingerprint) : undefined,
    flow: s.flow ? String(s.flow) : undefined,
    domainStrategy,
    sockoptDomainStrategy,
    alpn: alpn as string[] | undefined,
    muxEnabled: muxObj?.enabled === true,
    congestion,
  }
}

function delayColor(delay: number | null): string {
  if (!delay) return 'text-red-400'
  if (delay < 300) return 'text-green-400'
  if (delay < 600) return 'text-yellow-400'
  return 'text-red-400'
}

function formatEntryTime(time: string): string {
  const date = new Date(time)
  if (isNaN(date.getTime())) return time
  return date.toLocaleString('sv-SE', { hour12: false }).replace('T', ' ')
}

/**
 * Значок «мёртвого» аутбаунда — delay 0 в истории (по аналогии с михомо-селекторами).
 */
function GraveIcon({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true" className={className} style={{ width: size, height: size }}>
      <rect x="46.913" y="424.382" width="418.175" height="87.618" />
      <path d="M263.957 0h-15.916C160.059 0 88.737 71.322 88.737 159.305v238.941h334.525V159.305C423.262 71.322 351.941 0 263.957 0m75.009 225.189h-61.389v95.91h-43.155v-95.91h-61.389v-43.304h61.389v-59.918h43.155v59.918h61.389z" />
    </svg>
  )
}

interface Props {
  editorRef: React.RefObject<CodeMirrorRef | null>
  configs: Config[]
  activeConfigIndex: number
}

export function GuiOutbounds({ editorRef, configs, activeConfigIndex }: Props) {
  const { showToast } = useAppActions()
  const [outbounds, setOutbounds] = useState<Outbound[]>(() => parseOutbounds(configs[activeConfigIndex]?.content ?? ''))
  const history = usePingHistoryStore((state) => state.history)
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [link, setLink] = useState('')
  const [isPingingAll, setIsPingingAll] = useState(false)
  const outboundsRef = useRef<Outbound[]>(outbounds)
  // «Чистый» список аутбаундов: актуален на момент открытия вкладки/последней синхронизации.
  // Если drag-перестановка вернула всё на прежние места, в редактор не пишем — конфиг не станет dirty.
  const cleanListRef = useRef<Outbound[]>(outbounds)
  const inFlightRef = useRef<Set<string>>(new Set())
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])
  const cardRefHandlersRef = useRef<Record<number, (el: HTMLDivElement | null) => void>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  // Модалка редактирования JSON аутбаунда
  const [editing, setEditing] = useState<{ index: number; tag: string; key: number } | null>(null)
  const [editContent, setEditContent] = useState('')
  // Исходный текст черновика: разница с editContent — признак изменений для кнопки сохранения.
  const [editOriginal, setEditOriginal] = useState('')
  const [editError, setEditError] = useState<string | undefined>(undefined)

  const getCardRef = useCallback((index: number) => {
    if (!cardRefHandlersRef.current[index]) {
      cardRefHandlersRef.current[index] = (el: HTMLDivElement | null) => {
        cardRefs.current[index] = el
      }
    }
    return cardRefHandlersRef.current[index]
  }, [])

  useEffect(() => {
    const list = parseOutbounds(configs[activeConfigIndex]?.content ?? '')
    // Контент мог обновиться из syncToEditor этой же вкладки — список совпал, перерисовку не трогаем.
    if (JSON.stringify(list) === JSON.stringify(outboundsRef.current)) return
    outboundsRef.current = list
    cleanListRef.current = list
    setOutbounds(list)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConfigIndex, configs])

  /** Записывает список аутбаундов обратно в активный конфиг в редакторе. */
  const syncToEditor = useCallback(
    (list: Outbound[]) => {
      cleanListRef.current = list
      const wrapper = editorRef.current
      if (!wrapper) return
      try {
        const json = parseJsonc(wrapper.getValue())
        json.outbounds = list
        wrapper.replaceAll(JSON.stringify(json, null, 2))
      } catch (e: any) {
        showToast(`Ошибка синхронизации: ${e.message}`, 'error')
      }
    },
    [editorRef, showToast]
  )

  const startDrag = useCallback(
    (e: React.MouseEvent | React.TouchEvent, fromIndex: number) => {
      if (e.cancelable) e.preventDefault()
      let current = fromIndex
      setDraggingIndex(fromIndex)

      const onMove = (ev: MouseEvent | TouchEvent) => {
        const clientY = 'touches' in ev ? ev.touches[0].clientY : ev.clientY
        for (let i = 0; i < cardRefs.current.length; i++) {
          if (i === current) continue
          const rect = cardRefs.current[i]?.getBoundingClientRect()
          if (!rect || clientY < rect.top || clientY > rect.bottom) continue
          const list = [...outboundsRef.current]
          const [moved] = list.splice(current, 1)
          list.splice(i, 0, moved)
          current = i
          outboundsRef.current = list
          setOutbounds(list)
          setDraggingIndex(i)
          break
        }
      }
      const onUp = () => {
        if (JSON.stringify(outboundsRef.current) === JSON.stringify(cleanListRef.current)) {
          setOutbounds(cleanListRef.current)
        } else {
          syncToEditor(outboundsRef.current)
        }
        setDraggingIndex(null)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('touchmove', onMove)
        document.removeEventListener('touchend', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.addEventListener('touchmove', onMove, { passive: true })
      document.addEventListener('touchend', onUp, { passive: true })
    },
    [syncToEditor]
  )

  const handlePing = useCallback(
    async (tag: string, outbound: Outbound) => {
      if (!tag || inFlightRef.current.has(tag)) return
      inFlightRef.current.add(tag)
      setTesting((prev) => ({ ...prev, [tag]: true }))
      try {
        const r = await apiCall<{ success: boolean; latency_ms?: number; error?: string }>(
          'POST',
          'healthcheck',
          { outbound },
          { timeoutMs: 30000 }
        )
        if (!r.success) {
          showToast(r.error ?? XRAY_START_ERROR, 'error')
          return
        }
        appendPingEntries([{ tag, delay: r.latency_ms ?? 0, error: r.error }])
      } catch (e: any) {
        showToast(`Пинг «${tag}»: ${e?.message ?? 'ошибка запроса'}`, 'error')
      } finally {
        setTesting((prev) => ({ ...prev, [tag]: false }))
        inFlightRef.current.delete(tag)
      }
    },
    [showToast]
  )

  const handlePingAll = useCallback(async () => {
    // Служебные аутбаунды (blackhole/dns/loopback) и объекты без тега не пингуем —
    // бэкенд фильтрует так же.
    const targets = outboundsRef.current.filter(
      (outbound) =>
        outbound.protocol !== 'blackhole' && outbound.protocol !== 'dns' && outbound.protocol !== 'loopback' && typeof outbound.tag === 'string' && outbound.tag
    )
    if (targets.length === 0) return
    setIsPingingAll(true)
    // Спиннер на каждой пингуемой карточке, пока идёт общий замер.
    setTesting((prev) => {
      const next = { ...prev }
      for (const { tag } of targets) next[tag] = true
      return next
    })
    try {
      const r = await apiCall<{
        success: boolean
        error?: string
        results?: { tag: string; success: boolean; latency_ms?: number; error?: string }[]
      }>('POST', 'healthcheck/all', { outbounds: targets }, { timeoutMs: 45000 })
      if (!r.success) {
        showToast(r.error ?? XRAY_START_ERROR, 'error')
        return
      }
      appendPingEntries(
        (r.results ?? []).map(({ tag, success, latency_ms, error }) => ({
          tag,
          delay: success ? (latency_ms ?? 0) : 0,
          error: success ? undefined : error,
        }))
      )
    } catch (e: any) {
      showToast(`Тест всех: ${e?.message ?? 'ошибка запроса'}`, 'error')
    } finally {
      setTesting((prev) => {
        const next = { ...prev }
        for (const { tag } of targets) next[tag] = false
        return next
      })
      setIsPingingAll(false)
    }
  }, [showToast])

  const addOutbound = useCallback(() => {
    try {
      const { generateConfigForCore } = window as unknown as { generateConfigForCore: GenerateConfigForCore }
      const outbound = JSON.parse(generateConfigForCore(link.trim(), 'xray', editorRef.current?.getValue() ?? '').content)
      const list = [...outboundsRef.current, outbound]
      outboundsRef.current = list
      setOutbounds(list)
      syncToEditor(list)
      setLink('')
      showToast(`Outbound «${outbound.tag}» добавлен`)
      setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 50)
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }, [link, editorRef, syncToEditor, showToast])

  const openEdit = useCallback((index: number) => {
    const ob = outboundsRef.current[index]
    if (!ob) return
    const original = JSON.stringify(ob, null, 2)
    setEditContent(original)
    setEditOriginal(original)
    setEditError(undefined)
    setEditing({ index, tag: typeof ob.tag === 'string' ? ob.tag : '', key: Date.now() })
  }, [])

  const saveEdit = useCallback(() => {
    if (editing == null || editContent === editOriginal || editError) return
    let parsed: Outbound
    try {
      parsed = JSON.parse(editContent)
    } catch {
      setEditError('Синтаксическая ошибка JSON')
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setEditError('Outbound должен быть JSON-объектом')
      return
    }
    const list = [...outboundsRef.current]
    list[editing.index] = parsed
    outboundsRef.current = list
    setOutbounds(list)
    syncToEditor(list)
    setEditing(null)
    showToast('Outbound обновлён')
  }, [editing, editContent, editOriginal, editError, syncToEditor, showToast])

  const handleRemove = useCallback(
    (index: number) => {
      const removed = outboundsRef.current[index]
      if (!removed) return
      const tag: string = typeof removed.tag === 'string' ? removed.tag : ''
      const list = outboundsRef.current.filter((_, i) => i !== index)
      outboundsRef.current = list
      setOutbounds(list)
      syncToEditor(list)
      if (tag) clearPingHistory(tag)
      showToast(tag ? `Outbound «${tag}» удалён` : 'Outbound удалён')
    },
    [syncToEditor, showToast]
  )

  const isValidLink = OUTBOUND_LINK_PREFIXES.some((prefix) => link.trim().toLowerCase().startsWith(prefix))
  const isDraftDirty = editing != null && editContent !== editOriginal
  const draftSaveDisabled = !isDraftDirty || !!editError
  const draftSaveHint = editError ? `Исправьте ошибки JSON: ${editError}` : !isDraftDirty ? 'Нет изменений' : 'Сохранить (Ctrl+S)'

  return (
    <TooltipProvider delayDuration={500}>
      <div className="absolute inset-4 -mb-2 flex flex-col">
        <div ref={scrollRef} className="flex min-h-0 flex-1 scrollbar-thin flex-col gap-2 overflow-y-auto pb-2">
          {outbounds.length === 0 ? (
            <div className="text-muted-foreground mt-6 flex flex-col items-center gap-1 text-sm">
              <span>Аутбаунды не найдены</span>
              <span className="text-muted-foreground/60 text-xs">Добавьте подключение через «Утилиты → Добавить подключение»</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {outbounds.map((ob, index) => {
                const tag: string = typeof ob?.tag === 'string' ? ob.tag : ''
                return (
                  <div key={index} ref={getCardRef(index)}>
                    <OutboundCard
                      index={index}
                      outbound={ob}
                      isDragging={draggingIndex === index}
                      entries={history[tag] ?? []}
                      isTesting={!!testing[tag]}
                      onPing={handlePing}
                      onEdit={openEdit}
                      onRemove={handleRemove}
                      onDragStart={startDrag}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 rounded-xl p-0">
          <InputGroup className="min-w-40 flex-1">
            <InputGroupInput
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isValidLink) addOutbound()
              }}
              placeholder="vless://..."
              className="tracking-wide"
            />

            {link && (
              <InputGroupAddon align="inline-end">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setLink('')}
                  className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
                >
                  <IconX size={13} />
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>
          <Button variant="outline" disabled={!isValidLink} onClick={addOutbound} aria-label="Добавить подключение">
            <IconPlus /> <span className="hidden sm:inline">Добавить</span>
          </Button>
          <Button
            variant="outline"
            disabled={isPingingAll || outbounds.length === 0}
            onClick={handlePingAll}
            aria-label="Тест всех подключений"
          >
            {isPingingAll ? <Spinner className="size-4" /> : <IconBolt />} <span className="hidden sm:inline">Тест всех</span>
          </Button>
        </div>
      </div>

      {/* Модалка редактирования JSON аутбаунда */}
      <Dialog
        open={editing != null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        <DialogContent className="w-full max-w-[95vw]! md:w-[min(80vw,700px)]">
          <div className="flex h-[54dvh] flex-col gap-4 overflow-hidden md:h-[50dvh]">
            <DialogHeader className="shrink-0">
              <DialogTitle className="flex items-center gap-2 pr-8 pb-3">
                <IconCode size={20} className="text-chart-2" />
                {editing?.tag || `#${(editing?.index ?? 0) + 1}`}
              </DialogTitle>
            </DialogHeader>
            <div className="border-border bg-input-background relative min-h-0 flex-1 overflow-hidden rounded-xl border">
              {editing != null && (
                <>
                  <ProviderEditor
                    key={editing.key}
                    content={editContent}
                    language="json"
                    lineWrap={false}
                    onChange={setEditContent}
                    onSave={() => saveEdit()}
                    onValidationChange={setEditError}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="absolute right-3 bottom-3 z-10">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="border-border/60 bg-background/40 hover:bg-background/70 supports-backdrop-filter:bg-background/40 gap-1.5 px-3 shadow-lg shadow-black/20 backdrop-blur-xl backdrop-saturate-150"
                            onClick={() => saveEdit()}
                            disabled={draftSaveDisabled}
                          >
                            <IconDeviceFloppy />
                            <span className="text-xs font-medium">Сохранить</span>
                          </Button>
                        </span>
                      }
                    />
                    <TooltipContent side="left">{draftSaveHint}</TooltipContent>
                  </Tooltip>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

interface OutboundCardProps {
  index: number
  outbound: Outbound
  isDragging: boolean
  entries: PingEntry[]
  isTesting: boolean
  onPing: (tag: string, outbound: Outbound) => void
  onEdit: (index: number) => void
  onRemove: (index: number) => void
  onDragStart: (e: React.MouseEvent | React.TouchEvent, index: number) => void
}

const OutboundCard = memo(function OutboundCard({
  index,
  outbound,
  isDragging,
  entries,
  isTesting,
  onPing,
  onEdit,
  onRemove,
  onDragStart,
}: OutboundCardProps) {
  const tag: string = typeof outbound?.tag === 'string' ? outbound.tag : ''
  const meta = useMemo(() => extractMeta(outbound), [outbound])
  const last = entries.length > 0 ? entries[entries.length - 1] : null
  const digits = last?.delay ? String(last.delay).length : 0
  const [confirmOpen, setConfirmOpen] = useState(false)
  const { showToast } = useAppActions()

  const handleCopy = useCallback(
    (label: string, value: string) => {
      copyText(value).then((ok) => (ok ? showToast(`${label} скопирован в буфер`) : showToast(`Ошибка копирования «${label}»`, 'error')))
    },
    [showToast]
  )
  const addr = meta.address ?? (meta.port != null ? String(meta.port) : '')

  return (
    <div
      className={cn(
        'bg-input-background flex flex-col gap-3 rounded-xl border p-3 transition-all duration-150 select-none',
        isDragging ? 'scale-[0.99] border-[#60a5fa] opacity-80' : 'border-border'
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1">
        <div
          className={cn(
            'text-muted-foreground hover:text-foreground hover:bg-muted/50 touch-none rounded p-1 transition-colors',
            isDragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
          onMouseDown={(e) => onDragStart(e, index)}
          onTouchStart={(e) => onDragStart(e, index)}
        >
          <IconGripVertical size={16} />
        </div>
        <Badge variant="outline" className="mr-1 size-7 rounded-full border-blue-500/20 bg-blue-500/10 text-blue-400">
          #{index + 1}
        </Badge>
        <span className={cn('truncate text-sm', !tag && 'text-muted-foreground italic')}>{tag || 'без тега'}</span>
        {(meta.address || meta.port) && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  onClick={() => handleCopy('Адрес', addr)}
                  className="border-border bg-input-background text-muted-foreground hover:text-foreground ml-0.5 hidden min-w-0 cursor-pointer truncate rounded-md border px-2 py-0.75 text-xs transition-colors sm:inline"
                >
                  {meta.address ?? ''}
                  {meta.port ? `:${meta.port}` : ''}
                </span>
              }
            />
            <TooltipContent side="top">Скопировать адрес</TooltipContent>
          </Tooltip>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="outline" size="icon-sm" onClick={() => onEdit(index)} aria-label="Редактировать JSON">
                  <IconCode />
                </Button>
              }
            />
            <TooltipContent>Редактировать JSON</TooltipContent>
          </Tooltip>
          <Popover open={confirmOpen} onOpenChange={setConfirmOpen}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <PopoverTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Удалить outbound"
                        disabled={isDragging}
                        className="hover:text-red-400"
                      />
                    }
                  >
                    <IconTrash size={16} />
                  </PopoverTrigger>
                }
              />
              <TooltipContent>Удалить подключение</TooltipContent>
            </Tooltip>
            <PopoverContent align="end" sideOffset={6} className="max-w-72">
              <PopoverHeader>
                <PopoverTitle>Удалить подключение «{tag || `#${index + 1}`}» из конфига?</PopoverTitle>
              </PopoverHeader>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirmOpen(false)}>
                  Нет
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setConfirmOpen(false)
                    onRemove(index)
                  }}
                >
                  Да
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          {meta.protocol !== 'blackhole' && meta.protocol !== 'dns' && meta.protocol !== 'loopback' && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size={digits === 0 ? 'icon-sm' : 'sm'}
                    onClick={() => !isTesting && tag && onPing(tag, outbound)}
                    disabled={isTesting || !tag}
                    aria-label="Проверить подключение"
                    className={cn(
                      'disabled:pointer-events-auto disabled:cursor-not-allowed',
                      digits > 0 && 'min-w-8 justify-center px-0 text-xs tabular-nums',
                      isTesting && 'disabled:opacity-100',
                      !tag && 'opacity-40'
                    )}
                    style={digits > 0 ? { width: `calc(${digits}ch + 1.25rem)` } : undefined}
                  >
                    {isTesting ? (
                      <Spinner className="size-4" />
                    ) : entries.length === 0 ? (
                      <IconBolt />
                    ) : !last!.delay ? (
                      <GraveIcon size={15} className="text-red-400!" />
                    ) : (
                      <span className={cn('text-xs font-medium tracking-wide tabular-nums', delayColor(last!.delay))}>{last!.delay}</span>
                    )}
                  </Button>
                }
              />
              {entries.length > 0 ? (
                <TooltipContent side="top" className="p-2">
                  <div className="flex min-w-35 flex-col gap-1">
                    {entries.map((entry, i) => (
                      <div key={i} className="flex flex-col">
                        <div className="flex items-center justify-between gap-3 text-[13px]">
                          <span className="tabular-nums">{formatEntryTime(entry.time)}</span>
                          <span className={cn('font-medium tabular-nums', delayColor(entry.delay))}>
                            {entry.delay ? `${entry.delay}ms` : '—'}
                          </span>
                        </div>
                        {entry.error && <span className="line-clamp-2 max-w-64 text-xs break-words text-red-400/80">{entry.error}</span>}
                      </div>
                    ))}
                  </div>
                </TooltipContent>
              ) : (
                <TooltipContent>Протестировать подключение</TooltipContent>
              )}
            </Tooltip>
          )}
        </div>
      </div>

      {/* Metadata badges */}
      <div className="flex flex-wrap items-center gap-1">
        <MetaChip className="bg-purple-400/15 text-purple-400">{meta.protocolLabel ?? meta.protocol.toUpperCase()}</MetaChip>
        {meta.protocol !== 'hysteria' && meta.network && (
          <MetaChip className="bg-violet-400/15 text-violet-400">{meta.network.toUpperCase()}</MetaChip>
        )}
        {meta.security === 'tls' && <MetaChip className="bg-teal-400/15 text-teal-400">TLS</MetaChip>}
        {meta.security === 'reality' && <MetaChip className="bg-fuchsia-400/15 text-fuchsia-400">REALITY</MetaChip>}
        {meta.flow && <MetaChip className="bg-cyan-400/15 text-cyan-400">{meta.flow}</MetaChip>}
        {meta.muxEnabled && <MetaChip className="bg-green-400/15 text-green-400">mux.cool</MetaChip>}
        {meta.fingerprint && <MetaChip className="bg-orange-400/15 text-orange-400">{meta.fingerprint}</MetaChip>}
        {meta.sni && (
          <Tooltip>
            <TooltipTrigger
              render={
                <MetaChip
                  className="cursor-pointer bg-red-400/15 text-red-400 hover:bg-red-400/25"
                  onClick={() => handleCopy('SNI', meta.sni!)}
                >
                  {meta.sni}
                </MetaChip>
              }
            />
            <TooltipContent side="top">Скопировать SNI</TooltipContent>
          </Tooltip>
        )}
        {meta.domainStrategy && <MetaChip className="bg-indigo-400/15 text-indigo-400">{meta.domainStrategy}</MetaChip>}
        {meta.sockoptDomainStrategy && <MetaChip className="bg-blue-400/15 text-blue-400">{meta.sockoptDomainStrategy}</MetaChip>}
        {meta.alpn && <MetaChip className="bg-yellow-400/15 text-yellow-400">{`ALPN: ${meta.alpn.join(', ')}`}</MetaChip>}
        {meta.congestion && <MetaChip className="bg-pink-400/15 text-pink-400">{meta.congestion.toUpperCase()}</MetaChip>}
      </div>
    </div>
  )
})

function MetaChip({ className, onClick, children }: { className?: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <span onClick={onClick} className={cn('rounded-sm border-none px-2 py-0.75 text-xs font-medium tracking-wide', className)}>
      {children}
    </span>
  )
}
