import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { apiCall } from '@/lib/api'
import { useAppContext } from '@/lib/store'
import { IconAlertTriangle, IconBox, IconBoxOff, IconChevronDown, IconPlus, IconRestore, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'

type BackupContent = 'xkeen' | 'xkeen-ui' | 'xray' | 'mihomo'

interface BackupItem {
  name: string
  created_at: string
  size: number
  content?: Partial<Record<BackupContent, string[]>>
}

interface BackupsResponse {
  success: boolean
  error?: string
  backups?: BackupItem[]
}

interface BackupCreateResponse {
  success: boolean
  error?: string
  backup?: BackupItem
}

interface BackupActionResponse {
  success: boolean
  error?: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRefreshConfigs: () => Promise<unknown>
}

type ConfirmAction = { type: 'restore'; name: string; contents?: BackupContent[] } | { type: 'delete'; name: string }

const CONTENT_LABELS: Record<BackupContent, string> = {
  xkeen: 'XKeen',
  'xkeen-ui': 'XKeen UI',
  xray: 'Xray',
  mihomo: 'Mihomo',
}

const CONTENT_VARIANTS: Record<BackupContent, 'sky' | 'emerald' | 'amber' | 'rose'> = {
  xkeen: 'sky',
  'xkeen-ui': 'rose',
  xray: 'emerald',
  mihomo: 'amber',
}

const CONTENT_ORDER: BackupContent[] = ['xkeen', 'xkeen-ui', 'xray', 'mihomo']
const MAX_BACKUPS_TO_KEEP = 5
const KEEP_LATEST_BACKUPS_KEY = 'backups:keepLatest'

export function BackupsModal({ open, onOpenChange, onRefreshConfigs }: Props) {
  const { showToast } = useAppContext()

  const [backups, setBackups] = useState<BackupItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [keepLatestBackups, setKeepLatestBackups] = useState(() => localStorage.getItem(KEEP_LATEST_BACKUPS_KEY) === 'true')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [dialogAction, setDialogAction] = useState<ConfirmAction | null>(null)

  const fetchBackups = useCallback(async () => {
    const result = await apiCall<BackupsResponse>('GET', 'backup')
    if (!result.success) throw new Error(result.error ?? 'Не удалось загрузить бэкапы')
    return Array.isArray(result.backups) ? result.backups : []
  }, [])

  const loadBackups = useCallback(
    async (silent = false) => {
      if (!silent) setIsLoading(true)
      try {
        setBackups(await fetchBackups())
      } catch (error: any) {
        showToast(error.message ?? 'Не удалось загрузить бэкапы', 'error')
      } finally {
        setIsLoading(false)
      }
    },
    [fetchBackups, showToast]
  )

  useEffect(() => {
    if (open) void loadBackups()
  }, [open, loadBackups])

  useEffect(() => {
    localStorage.setItem(KEEP_LATEST_BACKUPS_KEY, String(keepLatestBackups))
  }, [keepLatestBackups])

  useEffect(() => {
    if (!open) {
      setConfirmAction(null)
      setDialogAction(null)
    }
  }, [open])

  useEffect(() => {
    if (confirmAction) setDialogAction(confirmAction)
  }, [confirmAction])

  const createBackup = useCallback(async () => {
    setPendingAction('create')
    try {
      const result = await apiCall<BackupCreateResponse>('PUT', 'backup')
      if (!result.success) {
        showToast(result.error ?? 'Не удалось создать бэкап', 'error')
        return
      }
      setConfirmAction(null)
      try {
        let nextBackups = await fetchBackups()
        const staleBackups = keepLatestBackups ? getNewestBackups(nextBackups).slice(MAX_BACKUPS_TO_KEEP) : []

        for (const backup of staleBackups) {
          await deleteBackupRequest(backup.name)
        }

        if (staleBackups.length > 0) {
          const staleNames = new Set(staleBackups.map((backup) => backup.name))
          nextBackups = nextBackups.filter((backup) => !staleNames.has(backup.name))
        }

        setBackups(nextBackups)
        showToast(staleBackups.length > 0 ? `Бэкап создан, старые удалены: ${staleBackups.length}` : 'Бэкап создан')
      } catch (error: any) {
        showToast(`Бэкап создан, но ${(error.message ?? 'автоочистка не удалась').toLowerCase()}`, 'error')
        await loadBackups(true)
      }
    } catch (error: any) {
      showToast(error.message ?? 'Не удалось создать бэкап', 'error')
    } finally {
      setPendingAction(null)
    }
  }, [fetchBackups, keepLatestBackups, loadBackups, showToast])

  const restoreBackup = useCallback(
    async (name: string, contents?: BackupContent[]) => {
      setPendingAction(getRestoreActionKey(name, contents))
      try {
        const result = await apiCall<BackupActionResponse>('POST', 'backup', contents?.length ? { name, contents } : { name })
        if (!result.success) {
          showToast(result.error ?? 'Не удалось восстановить бэкап', 'error')
          return
        }
        setConfirmAction(null)
        await onRefreshConfigs()
        showToast(contents?.length ? `Восстановлено: ${formatContentList(contents)}` : 'Бэкап восстановлен')
        onOpenChange(false)
      } catch (error: any) {
        showToast(error.message ?? 'Не удалось восстановить бэкап', 'error')
      } finally {
        setPendingAction(null)
      }
    },
    [onOpenChange, onRefreshConfigs, showToast]
  )

  const deleteBackup = useCallback(
    async (name: string) => {
      setPendingAction(`delete:${name}`)
      try {
        await deleteBackupRequest(name)
        setConfirmAction(null)
        setBackups((prev) => prev.filter((backup) => backup.name !== name))
        showToast('Бэкап удалён')
      } catch (error: any) {
        showToast(error.message ?? 'Не удалось удалить бэкап', 'error')
      } finally {
        setPendingAction(null)
      }
    },
    [showToast]
  )

  const closeConfirm = useCallback(() => {
    if (pendingAction === null) setTimeout(() => setConfirmAction(null), 0)
  }, [pendingAction])

  const submitConfirm = useCallback(async () => {
    if (!confirmAction) return
    if (confirmAction.type === 'delete') await deleteBackup(confirmAction.name)
    else await restoreBackup(confirmAction.name, confirmAction.contents)
  }, [confirmAction, deleteBackup, restoreBackup])

  const activeDialogAction = dialogAction ?? confirmAction

  return (
    <TooltipProvider>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex h-[70dvh]! max-w-2xl! flex-col overflow-hidden p-4 sm:p-5 md:h-128!">
          <DialogHeader className="pr-10">
            <DialogTitle className="flex items-center gap-2">
              <IconBox size={27} className="text-chart-2" /> Бэкапы конфигураций
            </DialogTitle>
            <DialogDescription>
              Сохранение конфигураций XKeen, XKeen-UI, Xray и Mihomo. Восстановление перезапишет текущие конфигурации.
            </DialogDescription>
          </DialogHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="px-1 py-1.5 pr-3">
              {isLoading ? (
                <div className="text-muted-foreground flex min-h-52 items-center justify-center gap-2 text-sm">
                  <Spinner />
                  Загрузка бэкапов...
                </div>
              ) : backups.length === 0 ? (
                <Empty className="min-h-64 border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <IconBoxOff />
                    </EmptyMedia>
                    <EmptyTitle>Бэкапы не найдены</EmptyTitle>
                  </EmptyHeader>
                  <EmptyContent>
                    <div className="flex flex-wrap items-center justify-center gap-3">
                      <KeepLatestBackupsToggle
                        id="keep-latest-backups-empty"
                        checked={keepLatestBackups}
                        disabled={pendingAction !== null}
                        onCheckedChange={setKeepLatestBackups}
                      />
                      <Button variant="outline" onClick={() => void createBackup()} disabled={pendingAction !== null}>
                        {pendingAction === 'create' ? <Spinner data-icon="inline-start" /> : <IconPlus data-icon="inline-start" />}
                        Создать бэкап
                      </Button>
                    </div>
                  </EmptyContent>
                </Empty>
              ) : (
                <div className="grid gap-3">
                  {backups.map((backup) => {
                    const contents = getBackupContents(backup)
                    const isRestoring = pendingAction?.startsWith(`restore:${backup.name}:`) ?? false
                    const isDeleting = pendingAction === `delete:${backup.name}`
                    const isBusy = pendingAction !== null && !isRestoring && !isDeleting
                    const isRestoreDisabled = isBusy || isDeleting || contents.length === 0

                    return (
                      <Card key={backup.name} size="sm">
                        <CardHeader className="border-b">
                          <CardTitle className="text-sm break-all sm:text-base">{backup.name}</CardTitle>
                          <CardAction>
                            <Badge variant="outline">{formatBytes(backup.size)}</Badge>
                          </CardAction>
                          <CardDescription className="text-xs">{backup.created_at}</CardDescription>
                        </CardHeader>

                        <CardContent className="flex flex-wrap gap-1">
                          {contents.length > 0 ? (
                            contents.map((content) => (
                              <ContentBadge key={content} content={content} files={backup.content?.[content] ?? []} />
                            ))
                          ) : (
                            <Badge variant="outline">Контент не найден</Badge>
                          )}
                        </CardContent>

                        <CardFooter className="justify-end gap-1">
                          <ButtonGroup>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setConfirmAction({ type: 'restore', name: backup.name })}
                              disabled={isRestoreDisabled}
                            >
                              {isRestoring ? <Spinner data-icon="inline-start" /> : <IconRestore />}
                              Восстановить
                            </Button>
                            <DropdownMenu modal={false}>
                              <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="px-2" disabled={isRestoreDisabled || contents.length <= 1}><IconChevronDown /></Button>} />
                              <DropdownMenuContent align="end" className="min-w-40">
                                {contents.map((content) => (
                                  <DropdownMenuItem
                                    key={content}
                                    onClick={() => setConfirmAction({ type: 'restore', name: backup.name, contents: [content] })}
                                  >
                                    {CONTENT_LABELS[content]}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </ButtonGroup>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setConfirmAction({ type: 'delete', name: backup.name })}
                            disabled={isBusy || isRestoring}
                          >
                            {isDeleting ? <Spinner data-icon="inline-start" /> : <IconTrash data-icon="inline-start" />}
                            Удалить
                          </Button>
                        </CardFooter>
                      </Card>
                    )
                  })}
                </div>
              )}
            </div>
          </ScrollArea>

          {backups.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-3">
              <KeepLatestBackupsToggle
                id="keep-latest-backups"
                checked={keepLatestBackups}
                disabled={pendingAction !== null}
                onCheckedChange={setKeepLatestBackups}
              />
              <Button onClick={() => void createBackup()} disabled={pendingAction !== null}>
                {pendingAction === 'create' ? <Spinner data-icon="inline-start" /> : <IconPlus data-icon="inline-start" />}
                Создать бэкап
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmAction} onOpenChange={(next) => !next}>
        <AlertDialogContent
          size="sm"
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            closeConfirm()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogMedia className={activeDialogAction?.type === 'delete' ? 'bg-destructive/10 text-destructive' : undefined}>
              {activeDialogAction?.type === 'delete' ? <IconTrash /> : <IconAlertTriangle />}
            </AlertDialogMedia>
            <AlertDialogTitle>
              {activeDialogAction?.type === 'delete'
                ? 'Удалить бэкап?'
                : activeDialogAction?.contents?.length
                  ? `Восстановить конфиги ${formatContentList(activeDialogAction.contents)}?`
                  : 'Восстановить конфигурации?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {activeDialogAction?.type === 'delete' ? 'Файл будет удален безвозвратно.' : 'Текущие конфиги будут перезаписаны.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" disabled={pendingAction !== null} onClick={closeConfirm}>
              Отмена
            </Button>
            <AlertDialogAction
              variant={activeDialogAction?.type === 'delete' ? 'destructive' : 'default'}
              onClick={() => void submitConfirm()}
              disabled={pendingAction !== null}
            >
              {activeDialogAction?.type === 'delete' ? 'Удалить' : 'Восстановить'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  )
}

function ContentBadge({ content, files }: { content: BackupContent; files: string[] }) {
  const badge = (
    <Badge className="cursor-default select-none" variant={CONTENT_VARIANTS[content]}>
      {CONTENT_LABELS[content]}
    </Badge>
  )

  if (files.length === 0) return badge

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex cursor-default select-none">{badge}</span>} />
      <TooltipContent sideOffset={6} className="max-w-80 px-3 py-2">
        <div className="space-y-1">
          <div className="text-[11px] font-medium opacity-70">{CONTENT_LABELS[content]}</div>
          <div className="max-h-56 overflow-y-auto">
            {files.map((file) => (
              <div key={file} className="text-xs leading-5 break-all">
                {file}
              </div>
            ))}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function KeepLatestBackupsToggle({
  id,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <Label htmlFor={id} className="text-muted-foreground cursor-pointer text-xs font-normal">
        Оставлять {MAX_BACKUPS_TO_KEEP} бэкапов
      </Label>
    </div>
  )
}

function getRestoreActionKey(name: string, contents?: BackupContent[]) {
  return `restore:${name}:${contents?.join(',') ?? 'all'}`
}

function getBackupContents(backup: BackupItem) {
  return CONTENT_ORDER.filter((content) => (backup.content?.[content]?.length ?? 0) > 0)
}

function formatContentList(contents: BackupContent[]) {
  return contents.map((content) => CONTENT_LABELS[content]).join(', ')
}

async function deleteBackupRequest(name: string) {
  const result = await apiCall<BackupActionResponse>('DELETE', 'backup', { name })
  if (!result.success) throw new Error(result.error ?? 'Не удалось удалить бэкап')
}

function getNewestBackups(backups: BackupItem[]) {
  return [...backups].sort((a, b) => getBackupSortKey(b).localeCompare(getBackupSortKey(a)))
}

function getBackupSortKey(backup: BackupItem) {
  const match = backup.name.match(/^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:_(\d+))?_/)
  return match ? `${match[1]}_${(Number(match[2]) || 1).toString().padStart(4, '0')}` : backup.name
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Б'
  const units = ['Б', 'КБ', 'МБ', 'ГБ']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}
