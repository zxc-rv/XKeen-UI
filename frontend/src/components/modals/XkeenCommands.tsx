import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useHighlightedCode } from '@/hooks/use-highlighted-code'
import { cn } from '@/lib/utils'
import {
  IconActivity,
  IconAlertTriangle,
  IconChevronRight,
  IconCircleCheck,
  IconCornerDownLeft,
  IconPlayerStop,
  IconRefresh,
  IconTerminal2,
} from '@tabler/icons-react'
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useSettings } from '../../lib/store'
import type { UpdateEvent, WsMessage } from '../../lib/websocket'
import { useExecWebSocket } from '../../lib/websocket'

type Action = 'status' | 'version' | 'diagnostics' | 'update_channel' | 'update_xkeen' | 'update_geo_files' | 'custom'

type ActionItem = {
  id: Action
  title: string
  command: string
  group: 'update' | 'tools'
  description?: string
  confirmation?: boolean
}

type LogEntry = { id: number; text: string; level?: string; ts?: string; tsUtc?: number }

const ACTIONS: ActionItem[] = [
  {
    id: 'update_xkeen',
    title: 'Обновить XKeen',
    command: 'xkeen -uk auto',
    group: 'update',
    description: 'Запускает штатную проверку и обновление XKeen.',
    confirmation: true,
  },
  {
    id: 'update_channel',
    title: 'Канал обновлений XKeen',
    command: 'xkeen -channel',
    group: 'update',
    description: 'Выберите канал обновлений XKeen, введя цифру из меню команды.',
  },
  {
    id: 'update_geo_files',
    title: 'Обновление GeoFile и GeoIPSET',
    command: 'xkeen -ug',
    group: 'update',
    description: 'Обновляет установленные базы GeoFile и GeoIPSET.',
    confirmation: true,
  },
  {
    id: 'status',
    title: 'Статус XKeen',
    command: 'xkeen -status',
    group: 'tools',
    description: 'Показывает состояние XKeen и прокси-ядра.',
  },
  {
    id: 'version',
    title: 'Версия XKeen',
    command: 'xkeen -v',
    group: 'tools',
    description: 'Показывает установленную версию XKeen.',
  },
  {
    id: 'diagnostics',
    title: 'Диагностика XKeen',
    command: 'xkeen -diag',
    group: 'tools',
    description: 'Запускает встроенную диагностику XKeen.',
  },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function formatTerminalText(text: string, level?: string) {
  // A terminal uses SGR colors for plain diagnostics, so let the ANSI
  // highlighter style them instead of coloring the whole line with CSS.
  const color = level === 'error' ? '\u001b[31m' : level === 'warn' ? '\u001b[33m' : ''

  return text
    .split('\n')
    .map((line) => `${color}${line.replace(/^[\t ]*[#$][\t ]?/, '').trimStart()}${color ? '\u001b[0m' : ''}`)
    .join('\n')
}

function TerminalLogLine({ entry, timezone }: { entry: LogEntry; timezone: number }) {
  const lines = useHighlightedCode(formatTerminalText(entry.text, entry.level), 'ansi')

  return (
    <div className="flex min-w-0 gap-2">
      {(entry.tsUtc !== undefined || entry.ts) && (
        <span className="text-muted-foreground/60 shrink-0">{formatEventTime(entry.tsUtc, timezone, entry.ts)}</span>
      )}
      <span className="min-w-0 whitespace-pre-wrap wrap-anywhere">
        {lines.map((line, index) => (
          <Fragment key={index}>
            {index > 0 && '\n'}
            {line}
          </Fragment>
        ))}
      </span>
    </div>
  )
}

function formatEventTime(tsUtc: number | undefined, timezone: number, fallback?: string) {
  if (tsUtc === undefined || !Number.isFinite(tsUtc)) return fallback ?? ''
  const date = new Date((tsUtc + timezone * 60 * 60) * 1000)
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

export function XkeenCommandsModal({ open, onOpenChange }: Props) {
  const timezone = useSettings((settings) => settings.timezone)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [started, setStarted] = useState(false)
  const [selected, setSelected] = useState<ActionItem | null>(null)
  const [confirmAction, setConfirmAction] = useState<ActionItem | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [commandInput, setCommandInput] = useState('')
  const [commandResponse, setCommandResponse] = useState('')
  const [ownCommandOpen, setOwnCommandOpen] = useState(false)
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [result, setResult] = useState<boolean | null>(null)
  const [requestError, setRequestError] = useState('')
  const lastSeqRef = useRef(0)
  const nextIdRef = useRef(0)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [entries])

  const applyEvent = useCallback((event: UpdateEvent) => {
    if (event.seq && event.seq <= lastSeqRef.current) return
    if (event.seq) lastSeqRef.current = event.seq
    if (event.type === 'log') {
      setEntries((prev) => {
        const last = prev.at(-1)
        if (event.append && last) {
          return [...prev.slice(0, -1), { ...last, text: last.text + (event.message ?? '') }]
        }
        return [
          ...prev,
          { id: nextIdRef.current++, text: event.message ?? '', level: event.level, ts: event.ts, tsUtc: event.ts_utc },
        ].slice(-200)
      })
    } else if (event.type === 'done') {
      setRunning(false)
      setCancelling(false)
      setResult(!!event.success)
      setStarted(false)
    }
  }, [])

  const handleWsMessage = useCallback(
    (message: WsMessage) => {
      if (message.type !== 'update') return
      if (message.history) message.history.forEach(applyEvent)
      else if (message.event) applyEvent(message.event)
    },
    [applyEvent]
  )

  useExecWebSocket(handleWsMessage, open && started)

  const reset = () => {
    setEntries([])
    setSelected(null)
    setConfirmAction(null)
    setConfirmOpen(false)
    setOwnCommandOpen(false)
    setResult(null)
    setCancelling(false)
    setRequestError('')
    setStarted(false)
    lastSeqRef.current = 0
    nextIdRef.current = 0
  }

  const startAction = async (action: ActionItem) => {
    setSelected(action)
    setRunning(true)
    setCancelling(false)
    setResult(null)
    setRequestError('')
    setEntries([])
    setCommandResponse('')
    setStarted(false)
    lastSeqRef.current = 0
    nextIdRef.current = 0
    try {
      const response = await apiCall<{ success: boolean; error?: string }>('POST', 'exec', { command: action.command })
      if (!response.success) throw new Error(response.error || 'Не удалось запустить команду')
      setStarted(true)
    } catch (error) {
      setRunning(false)
      setRequestError(error instanceof Error ? error.message : 'Не удалось запустить команду')
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (running) return
    if (!next) reset()
    onOpenChange(next)
  }

  const runCustomCommand = () => {
    const args = commandInput.trim()
    if (!args || args === '-') return
    const command = `xkeen -${args}`
    void startAction({
      id: 'custom',
      title: 'Своя команда',
      command,
      group: 'tools',
    })
  }

  const sendCommandInput = async () => {
    const input = commandResponse.trim()
    if (!input) return
    try {
      const response = await apiCall<{ success: boolean; error?: string }>('POST', 'exec/input', { input })
      if (!response.success) throw new Error(response.error || 'Не удалось передать ответ команде')
      setCommandResponse('')
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Не удалось передать ответ команде')
    }
  }

  const cancelAction = async () => {
    setCancelling(true)
    try {
      const response = await apiCall<{ success: boolean; error?: string }>('POST', 'exec/control', { action: 'cancel' })
      if (!response.success) throw new Error(response.error || 'Не удалось прервать операцию')
    } catch (error) {
      setCancelling(false)
      setRequestError(error instanceof Error ? error.message : 'Не удалось прервать операцию')
    }
  }

  const actionSection = (title: string, actions: ActionItem[], icon: ReactNode) => (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-foreground px-2 text-xs font-medium">{title}</h3>
      {actions.map((action) => (
        <Button
          key={action.id}
          variant="outline"
          className="dark:bg-[color-mix(in_oklab,var(--input-background)_80%,var(--muted)_20%)] h-auto w-full justify-between gap-3 rounded-lg px-3 py-2.5 text-left whitespace-normal transition-colors"
          disabled={running}
          onClick={() => {
            if (action.confirmation) {
              setConfirmAction(action)
              setConfirmOpen(true)
            } else {
              void startAction(action)
            }
          }}
        >
          <span className="flex min-w-0 items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center">{icon}</span>
            <span className="min-w-0">
              <span className="block font-medium">{action.title}</span>
              <code className="text-muted-foreground block truncate text-[11px] font-normal">{action.command}</code>
            </span>
          </span>
          <IconChevronRight data-icon="inline-end" className="text-muted-foreground" />
        </Button>
      ))}
    </section>
  )

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={!running}
          className={cn(
            'flex min-h-0 w-full flex-col gap-6 overflow-hidden sm:max-w-md md:w-187.5 md:max-w-[95vw]!',
            selected ? 'max-h-[90dvh]' : 'h-[88dvh] max-h-[48rem] md:h-auto md:max-h-[90dvh]'
          )}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <IconTerminal2 className="text-chart-2 size-6" />
              Команды XKeen
            </DialogTitle>
          </DialogHeader>

          {!selected && (
            <ScrollArea className="min-h-0 flex-1 pr-1">
              <div className="flex flex-col gap-4 pb-1">
                {actionSection(
                  'Обновление',
                  ACTIONS.filter((action) => action.group === 'update'),
                  <IconRefresh className="text-chart-2 size-4" />
                )}
                {actionSection(
                  'Состояние и диагностика',
                  ACTIONS.filter((action) => action.group === 'tools'),
                  <IconActivity className="text-chart-2 size-4" />
                )}

                <Accordion
                  type="single"
                  collapsible
                  value={ownCommandOpen ? 'own-command' : ''}
                  onValueChange={(value: string) => {
                    const nextOpen = value === 'own-command'
                    setOwnCommandOpen(nextOpen)
                  }}
                >
                  <AccordionItem
                    value="own-command"
                    className="border-input bg-input-background dark:bg-[color-mix(in_oklab,var(--input-background)_80%,var(--muted)_20%)] rounded-lg border transition-colors hover:bg-input-background-hover"
                  >
                    <AccordionTrigger className="border-0 px-3 py-2.5 hover:no-underline">
                      <span className="flex items-center gap-3">
                        <span className="flex size-8 shrink-0 items-center justify-center">
                          <IconTerminal2 className="text-chart-2 size-4" />
                        </span>
                        Своя команда
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="px-3">
                      <Field className="gap-2">
                        <FieldLabel htmlFor="xkeen-custom-command" className="sr-only">
                          Команда XKeen
                        </FieldLabel>
                        <div className="w-full">
                          <InputGroup>
                            <InputGroupAddon align="inline-start" className="text-muted-foreground pr-0 font-normal">
                              xkeen -
                            </InputGroupAddon>
                            <InputGroupInput
                              className="pl-0!"
                              id="xkeen-custom-command"
                              value={commandInput}
                              placeholder="uk"
                              autoComplete="off"
                              spellCheck={false}
                              onChange={(event) => setCommandInput(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  runCustomCommand()
                                }
                              }}
                            />
                            <InputGroupAddon align="inline-end">
                              <InputGroupButton variant="default" disabled={!commandInput.trim() || commandInput.trim() === '-'} onClick={runCustomCommand}>
                                Выполнить
                                <IconCornerDownLeft />
                              </InputGroupButton>
                            </InputGroupAddon>
                          </InputGroup>
                        </div>
                      </Field>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </ScrollArea>
          )}

          {selected && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="bg-muted/30 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                <div className="min-w-0">
                  <div className="font-medium">{selected.title}</div>
                  <code className="text-muted-foreground block text-xs break-all">{selected.command}</code>
                </div>
                {running ? (
                  <Badge variant="secondary" className="shrink-0">
                    Выполняется
                  </Badge>
                ) : result === true ? (
                  <Badge className="shrink-0 gap-1.5 bg-emerald-500/15 text-emerald-400">
                    <IconCircleCheck className="size-3" />
                    Готово
                  </Badge>
                ) : result === false || requestError ? (
                  <Badge variant="destructive" className="shrink-0 gap-1.5">
                    <IconAlertTriangle className="size-3" />
                    Ошибка
                  </Badge>
                ) : null}
              </div>
              <CodeBlock size="sm" className="bg-input-background! h-72 min-h-0 md:h-80">
                <CodeBlockContent ref={logRef} wrap className="flex-1 scrollbar-thin">
                  {requestError && <div className="text-destructive wrap-anywhere">{requestError}</div>}
                  {entries.map((entry) => (
                    <TerminalLogLine key={entry.id} entry={entry} timezone={timezone} />
                  ))}
                </CodeBlockContent>
              </CodeBlock>
              {running && (selected?.id === 'custom' || selected?.id === 'update_channel') && (
                <Field>
                  <FieldLabel htmlFor="xkeen-command-input">
                    {selected?.id === 'update_channel' ? 'Номер канала XKeen' : 'Ответ команды'}
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="xkeen-command-input"
                      value={commandResponse}
                      placeholder={selected?.id === 'update_channel' ? 'Введите цифру' : 'Введите ответ команды'}
                      inputMode={selected?.id === 'update_channel' ? 'numeric' : undefined}
                      maxLength={selected?.id === 'update_channel' ? 1 : undefined}
                      autoComplete="off"
                      onChange={(event) =>
                        setCommandResponse(
                          selected?.id === 'update_channel' ? event.target.value.replace(/\D/g, '').slice(0, 1) : event.target.value
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void sendCommandInput()
                        }
                      }}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton variant="default" disabled={!commandResponse.trim()} onClick={() => void sendCommandInput()}>
                        Отправить
                        <IconCornerDownLeft />
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
              )}
              {running && (
                <div className="flex justify-end">
                  <Button variant="destructive" disabled={cancelling} onClick={() => void cancelAction()}>
                    <IconPlayerStop data-icon="inline-start" />
                    {cancelling ? 'Прерывание…' : 'Прервать'}
                  </Button>
                </div>
              )}
              {!running && (
                <div className="flex justify-end gap-2">
                  <Button onClick={reset}>К списку</Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="z-[70]" overlayClassName="z-[60]">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.id === 'custom' ? 'Выполнить свою команду?' : 'Запустить обновление?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.description && <span className="mb-2 block">{confirmAction.description}</span>}
              {confirmAction?.command && (
                <code className="bg-muted text-foreground block rounded-md px-2 py-1.5 font-mono text-xs">{confirmAction.command}</code>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmOpen(false)}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false)
                if (confirmAction) void startAction(confirmAction)
              }}
            >
              Запустить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
