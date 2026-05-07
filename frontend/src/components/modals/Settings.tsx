import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { IconAlertCircle, IconSettings, IconX } from '@tabler/icons-react'
import { Fragment, memo, useCallback, useState } from 'react'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import type { AppSettings, ThemeMode } from '../../lib/types'

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

const clashApiSettings: ToggleSetting[] = [
  {
    id: 'show-source-name',
    key: 'showSourceName',
    path: 'clash_api.show_source_name',
    title: 'Показывать имя источника',
    description: 'Отображать имя клиента Keenetic вместо IP-адреса',
  },
]

const themeOptions: { value: ThemeMode; label: string }[] = [
  { value: 'auto', label: 'Авто' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Темная' },
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

const PingTestSettingsField = memo(function PingTestSettingsField({
  pingUrl,
  pingTimeout,
  onSave,
  showToast,
}: {
  pingUrl: string
  pingTimeout: number
  onSave: (url: string, timeout: number) => Promise<boolean>
  showToast: (msg: string, type?: 'success' | 'error') => void
}) {
  const [url, setUrl] = useState(pingUrl)
  const [timeout, setTimeout] = useState(String(pingTimeout))

  const trimmedUrl = url.trim()
  const parsedTimeout = Number(timeout)
  const isTimeoutValid = Number.isInteger(parsedTimeout) && parsedTimeout > 0
  const isDirty = trimmedUrl !== pingUrl || parsedTimeout !== pingTimeout

  const save = useCallback(async () => {
    if (!trimmedUrl) return showToast('URL пинг-теста пустой', 'error')
    if (!isTimeoutValid) return showToast('Таймаут должен быть целым числом больше 0', 'error')
    const ok = await onSave(trimmedUrl, parsedTimeout)
    if (ok) {
      setUrl(trimmedUrl)
      setTimeout(String(parsedTimeout))
    }
  }, [isTimeoutValid, onSave, parsedTimeout, showToast, trimmedUrl])

  return (
    <FieldGroup className="gap-0!">
      <Field className="px-0 py-3">
        <FieldContent>
          <FieldLabel htmlFor="ping-test-url">URL пинга</FieldLabel>
          <FieldDescription className="text-[13px]">Адрес для проверки задержки через Clash API</FieldDescription>
        </FieldContent>
        <InputGroup>
          <InputGroupInput
            id="ping-test-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder="https://www.gstatic.com/generate_204"
          />
        </InputGroup>
      </Field>

      <Separator className="my-0" />

      <Field className="px-0 py-3">
        <FieldContent>
          <FieldLabel htmlFor="ping-test-timeout">Таймаут</FieldLabel>
          <FieldDescription className="text-[13px]">В миллисекундах, используется для delay-теста прокси</FieldDescription>
        </FieldContent>
        <InputGroup className="max-w-40">
          <InputGroupInput
            id="ping-test-timeout"
            type="number"
            min={1}
            step={100}
            inputMode="numeric"
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            value={timeout}
            onChange={(e) => setTimeout(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder="5000"
          />
          <InputGroupAddon align="inline-end" className="text-muted-foreground px-2 text-xs">
            мс
          </InputGroupAddon>
        </InputGroup>
      </Field>

      <div className="flex justify-end pt-2">
        <Button size="sm" variant="outline" onClick={() => void save()} disabled={!isDirty || !trimmedUrl || !isTimeoutValid}>
          Сохранить
        </Button>
      </div>
    </FieldGroup>
  )
})

function AuthSettingsField({
  authEnabled,
  onToggle,
  showToast,
}: {
  authEnabled: boolean
  onToggle: (value: boolean) => Promise<void>
  showToast: (msg: string, type?: 'success' | 'error') => void
}) {
  const [resetOpen, setResetOpen] = useState(false)

  const resetPassword = useCallback(async () => {
    const res = await fetch('/api/auth/reset', { method: 'POST' })
    const data = await res.json()
    if (data.success) window.location.reload()
    else showToast(data.error ?? 'Ошибка', 'error')
  }, [showToast])

  return (
    <FieldGroup className="gap-0!">
      <Field orientation="horizontal" className="px-0 py-3">
        <FieldContent>
          <FieldLabel>Авторизация</FieldLabel>
          <FieldDescription className="text-[13px]">Защита панели с помощью пароля при входе</FieldDescription>
        </FieldContent>
        <Switch checked={authEnabled} onCheckedChange={onToggle} aria-label="Авторизация" />
      </Field>

      {authEnabled && (
        <>
          <Separator className="my-0" />
          <Field orientation="horizontal" className="px-0 py-3">
            <FieldContent>
              <FieldLabel>Сбросить пароль</FieldLabel>
              <FieldDescription className="text-[13px]">Сбросить старый пароль и установить новый</FieldDescription>
            </FieldContent>
            <Popover open={resetOpen} onOpenChange={setResetOpen}>
              <PopoverTrigger asChild>
                <Button variant="destructive" size="sm">
                  Сбросить
                </Button>
              </PopoverTrigger>
              <PopoverContent>
                <PopoverHeader>
                  <PopoverTitle>Вас перекинет на страницу установки пароля. Продолжить?</PopoverTitle>
                </PopoverHeader>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => setResetOpen(false)}>
                    Нет
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => void resetPassword()}>
                    Да
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </Field>
        </>
      )}
    </FieldGroup>
  )
}

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
        if (['gui', 'updater', 'log', 'auth', 'clash_api'].includes(section)) body[section] = key ? { [key]: value } : value
        const result = await apiCall<any>('PATCH', 'settings', body)
        if (!result.success) {
          showToast('Ошибка: ' + result.error, 'error')
          return false
        }
        return true
      } catch (e: any) {
        showToast(e.message, 'error')
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

  const setTheme = useCallback(
    (value: string) => {
      dispatch({ type: 'SET_SETTINGS', settings: { theme: value as ThemeMode } })
    },
    [dispatch]
  )

  const toggleAuth = useCallback(
    async (value: boolean) => {
      const ok = await saveSetting('auth.enabled', value)
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { authEnabled: value } })
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

  const savePingTestSettings = useCallback(
    async (url: string, timeout: number) => {
      const ok = await saveSetting('clash_api', { ping_url: url, ping_timeout: timeout })
      if (ok) dispatch({ type: 'SET_SETTINGS', settings: { pingTestUrl: url, pingTestTimeout: timeout } })
      return ok
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

        <Tabs defaultValue="general" className="flex flex-1 flex-col overflow-hidden">
          <div className="overflow-x-auto overflow-y-hidden [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsList
              variant="line"
              className="border-border w-max shrink-0 justify-start gap-3 rounded-none border-b px-0 whitespace-nowrap"
            >
              <TabsTrigger value="general">Общие</TabsTrigger>
              <TabsTrigger value="gui">Режим GUI</TabsTrigger>
              <TabsTrigger value="clash-api">Clash API</TabsTrigger>
              <TabsTrigger value="updates">Обновления</TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="pr-2">
              <TabsContent value="general">
                <FieldGroup className="gap-0!">
                  <p className="text-muted-foreground pt-3 pb-1 text-xs font-medium tracking-wider uppercase">Оформление</p>
                  <Field orientation="horizontal" className="px-0 py-3">
                    <FieldContent>
                      <FieldLabel htmlFor="theme">Тема приложения</FieldLabel>
                      <FieldDescription className="text-[13px]">Ручной режим или синхронизация с системой</FieldDescription>
                    </FieldContent>
                    <Select value={settings.theme} onValueChange={setTheme}>
                      <SelectTrigger id="theme" className="w-34 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {themeOptions.map((item) => (
                            <SelectItem key={item.value} value={item.value} className="text-sm">
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Separator className="my-2" />
                  <p className="text-muted-foreground pt-3 pb-1 text-xs font-medium tracking-wider uppercase">Авторизация</p>
                  <AuthSettingsField authEnabled={settings.authEnabled} onToggle={toggleAuth} showToast={showToast} />
                  <Separator className="my-2" />
                  <p className="text-muted-foreground pt-1 pb-1 text-xs font-medium tracking-wider uppercase">Журнал</p>
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

              <TabsContent value="gui">
                <Alert className="my-2 border-amber-500/20 bg-amber-100 p-2.75 text-yellow-600 dark:bg-[#2a1f0d] dark:text-amber-400">
                  <IconAlertCircle className="size-4.5" />
                  <AlertDescription className="text-xs leading-4.25 tracking-wide text-yellow-600 dark:text-amber-400">
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

              <TabsContent value="clash-api">
                <p className="text-muted-foreground pt-3 pb-1 text-xs font-medium tracking-wider uppercase">Соединения</p>
                <FieldGroup className="gap-0!">
                  {clashApiSettings.map((item) => (
                    <SwitchSettingField key={item.id} item={item} checked={settings[item.key]} onToggleSetting={toggleSetting} />
                  ))}
                </FieldGroup>
                <Separator className="my-2" />
                <p className="text-muted-foreground pt-3 pb-1 text-xs font-medium tracking-wider uppercase">Пинг тест</p>
                <PingTestSettingsField
                  key={`${settings.pingTestUrl}\x00${settings.pingTestTimeout}`}
                  pingUrl={settings.pingTestUrl}
                  pingTimeout={settings.pingTestTimeout}
                  onSave={savePingTestSettings}
                  showToast={showToast}
                />
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
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
