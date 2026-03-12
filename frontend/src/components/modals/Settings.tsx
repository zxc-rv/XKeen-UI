import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconAlertCircle, IconSettings, IconX } from '@tabler/icons-react'
import { Fragment, memo, useCallback, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import type { AppSettings } from '../../lib/types'

type BooleanSettingKey = {
  [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never
}[keyof AppSettings]

type ToggleSetting = {
  id: string
  key: BooleanSettingKey
  path: string
  title: string
  description: string
}

type ToggleSettingHandler = (item: ToggleSetting, value: boolean) => void

const guiSettings: ToggleSetting[] = [
  {
    id: 'gui-routing',
    key: 'guiRouting',
    path: 'gui.routing',
    title: 'Routing',
    description: 'Визуализация правил роутинга для Xray',
  },
  {
    id: 'gui-log',
    key: 'guiLog',
    path: 'gui.log',
    title: 'Log',
    description: 'Визуализация настроек логирования для Xray',
  },
  {
    id: 'auto-apply',
    key: 'autoApply',
    path: 'gui.auto_apply',
    title: 'Автоприменение',
    description: 'Автоматически применять следующие изменения в режиме GUI:\n • Routing: изменение outboundTag\n • Log: любые изменения',
  },
]

const updateSettings: ToggleSetting[] = [
  {
    id: 'auto-ui',
    key: 'autoCheckUI',
    path: 'updater.auto_check_ui',
    title: 'Автопроверка (панель)',
    description: 'Фоновая проверка обновлений панели с интервалом в 4 часа',
  },
  {
    id: 'auto-core',
    key: 'autoCheckCore',
    path: 'updater.auto_check_core',
    title: 'Автопроверка (ядро)',
    description: 'Фоновая проверка обновлений ядра с интервалом в 12 часов',
  },
  {
    id: 'backup',
    key: 'backupCore',
    path: 'updater.backup_core',
    title: 'Бэкап ядра',
    description: 'Сохранять резервную копию ядра при обновлении',
  },
]

const SwitchSettingField = memo(function SwitchSettingField({
  item,
  checked,
  onToggleSetting,
}: {
  item: ToggleSetting
  checked: boolean
  onToggleSetting: ToggleSettingHandler
}) {
  const onToggle = useCallback((value: boolean) => onToggleSetting(item, value), [item, onToggleSetting])

  return (
    <Field orientation="horizontal" className="px-0 py-3">
      <FieldContent>
        <FieldLabel htmlFor={item.id}>{item.title}</FieldLabel>
        <FieldDescription className="text-[13px] whitespace-pre-line">{item.description}</FieldDescription>
      </FieldContent>
      <Switch id={item.id} checked={checked} onCheckedChange={onToggle} aria-label={item.title} />
    </Field>
  )
})

const ProxyRow = memo(function ProxyRow({
  proxy,
  index,
  onRemove,
}: {
  proxy: string
  index: number
  onRemove: (index: number) => Promise<void>
}) {
  const onRemoveClick = useCallback(() => void onRemove(index), [index, onRemove])

  return (
    <div className="flex items-center gap-2">
      <div className="bg-input-background flex h-9 min-w-0 flex-1 items-center rounded-md border px-2.5">
        <span className="w-full truncate text-[13px]">{proxy}</span>
      </div>
      <Button variant="destructive" className="shrink-0" onClick={onRemoveClick} aria-label={`Удалить прокси ${proxy}`}>
        Удалить
      </Button>
    </div>
  )
})

const ProxySettingsField = memo(function ProxySettingsField({
  githubProxies,
  onAddProxy,
  onRemoveProxy,
}: {
  githubProxies: string[]
  onAddProxy: (url: string) => Promise<boolean>
  onRemoveProxy: (index: number) => Promise<void>
}) {
  const [newProxy, setNewProxy] = useState('')
  const hasNewProxy = newProxy.trim().length > 0

  const addProxy = useCallback(async () => {
    if (!hasNewProxy) return
    const ok = await onAddProxy(newProxy)
    if (ok) setNewProxy('')
  }, [hasNewProxy, newProxy, onAddProxy])

  return (
    <Field className="px-0 py-3">
      <FieldContent>
        <FieldLabel htmlFor="github-proxy-input">GitHub Proxy</FieldLabel>
        <FieldDescription className="text-[13px] text-wrap!">
          Прокси для загрузки обновлений при отсутствии доступа к GitHub, используются по порядку сверху вниз
        </FieldDescription>
      </FieldContent>

      {githubProxies.length === 0 ? (
        <FieldDescription className="py-1 text-[13px]">Прокси не добавлены</FieldDescription>
      ) : (
        <div className="flex flex-col gap-3">
          {githubProxies.map((proxy, index) => (
            <ProxyRow key={proxy + index} proxy={proxy} index={index} onRemove={onRemoveProxy} />
          ))}
        </div>
      )}

      <Field orientation="horizontal" className="gap-2">
        <InputGroup className="flex-1">
          <InputGroupInput
            id="github-proxy-input"
            value={newProxy}
            onChange={(e) => setNewProxy(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addProxy()}
            placeholder="Введите URL прокси..."
            className={hasNewProxy ? 'pr-7' : undefined}
          />
          <InputGroupAddon align="inline-end">
            {hasNewProxy && (
              <InputGroupButton
                aria-label="Очистить поле"
                className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
                onClick={() => setNewProxy('')}
              >
                <IconX />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        <Button variant="default" className="shrink-0" onClick={() => void addProxy()} disabled={!hasNewProxy}>
          Добавить
        </Button>
      </Field>
    </Field>
  )
})

export function SettingsModal() {
  const { state, dispatch, showToast } = useAppContext({ includeSettings: true })
  const { modals } = useModalContext()
  const { settings } = state

  const close = useCallback(() => dispatch({ type: 'SHOW_MODAL', modal: 'showSettingsModal', show: false }), [dispatch])

  const saveSetting = useCallback(
    async (path: string, value: unknown) => {
      const [section, key] = path.split('.')
      try {
        const body: Record<string, unknown> = {}
        if (['gui', 'updater', 'log'].includes(section)) body[section] = key ? { [key]: value } : value
        const result = await apiCall<any>('PATCH', 'settings', body)
        if (!result.success) {
          showToast('Ошибка: ' + result.error, 'error')
          return false
        }
        return true
      } catch (e: any) {
        showToast(e.message, 'error')
        console.error('Save setting failed:', e)
        return false
      }
    },
    [showToast]
  )

  const toggleSetting = useCallback(
    async (item: ToggleSetting, value: boolean) => {
      const ok = await saveSetting(item.path, value)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { [item.key]: value } as Partial<AppSettings> })
    },
    [dispatch, saveSetting]
  )

  const addProxy = useCallback(
    async (rawUrl: string) => {
      let url = rawUrl.trim().replace(/\/+$/, '')
      if (!url) return false
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url
      if (settings.githubProxies.includes(url)) {
        showToast('Уже добавлен', 'error')
        return false
      }
      const next = [...settings.githubProxies, url]
      const ok = await saveSetting('updater.github_proxy', next)
      if (ok) {
        dispatch({ type: 'SET_SETTINGS', settings: { githubProxies: next } })
        return true
      }
      return false
    },
    [dispatch, saveSetting, settings.githubProxies, showToast]
  )

  const removeProxy = useCallback(
    async (index: number) => {
      const next = settings.githubProxies.filter((_, i) => i !== index)
      const ok = await saveSetting('updater.github_proxy', next)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { githubProxies: next } })
    },
    [dispatch, saveSetting, settings.githubProxies]
  )

  const setTimezone = useCallback(
    async (value: string) => {
      const offset = parseInt(value, 10)
      const ok = await saveSetting('log.timezone', offset)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { timezone: offset } })
    },
    [dispatch, saveSetting]
  )

  return (
    <Dialog open={modals.showSettingsModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex h-[79dvh]! max-w-xl! flex-col overflow-hidden md:h-142!">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <IconSettings size={24} className="text-chart-2" /> Настройки
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="gui" className="flex flex-1 flex-col overflow-hidden">
          <TabsList variant="line" className="border-border shrink-0 justify-start gap-3 rounded-none border-b px-0">
            <TabsTrigger value="gui">Режим GUI</TabsTrigger>
            <TabsTrigger value="updates">Обновления</TabsTrigger>
            <TabsTrigger value="logs">Журнал</TabsTrigger>
          </TabsList>

          <ScrollArea className="min-h-0 flex-1">
            <div className="pr-2">
              <TabsContent value="gui">
                <Alert className="my-2 border-amber-500/20 bg-[#2a1f0d] p-2.75 text-amber-400">
                  <IconAlertCircle className="size-4.5 text-amber-400" />
                  <AlertDescription className="text-xs leading-4.25 tracking-wide text-amber-400">
                    Функция экспериментальная. Перед включением сделайте бэкап конфигураций. Несовместимо с комментариями.
                  </AlertDescription>
                </Alert>

                <FieldGroup className="gap-0!">
                  {guiSettings.map((item, index) => (
                    <Fragment key={item.id}>
                      <SwitchSettingField item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
                      {index < guiSettings.length - 1 && <Separator className="my-0" />}
                    </Fragment>
                  ))}
                </FieldGroup>
              </TabsContent>

              <TabsContent value="updates">
                <FieldGroup className="gap-0!">
                  {updateSettings.map((item) => (
                    <Fragment key={item.id}>
                      <SwitchSettingField item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
                      <Separator className="my-0" />
                    </Fragment>
                  ))}
                  <ProxySettingsField githubProxies={settings.githubProxies} onAddProxy={addProxy} onRemoveProxy={removeProxy} />
                </FieldGroup>
              </TabsContent>

              <TabsContent value="logs">
                <FieldGroup className="gap-0!">
                  <Field orientation="horizontal" className="px-0 py-3">
                    <FieldContent>
                      <FieldLabel htmlFor="timezone">Часовой пояс</FieldLabel>
                      <FieldDescription className="text-[13px]">Сдвиг времени для записей в журнале</FieldDescription>
                    </FieldContent>
                    <Select value={String(settings.timezone)} onValueChange={setTimezone}>
                      <SelectTrigger id="timezone" className="w-30 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {Array.from({ length: 27 }, (_, i) => i - 12).map((offset) => (
                            <SelectItem key={offset} value={String(offset)} className="text-sm">
                              UTC{offset >= 0 ? '+' : ''}
                              {offset}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
