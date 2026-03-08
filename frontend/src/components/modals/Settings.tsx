import { Fragment, useState } from 'react'
import { IconAlertCircle, IconSettings, IconX } from '@tabler/icons-react'
import { apiCall } from '../../lib/api'
import { useAppContext, useModalContext } from '../../lib/store'
import type { AppSettings } from '../../lib/types'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

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

const SwitchSettingField = ({ item, checked, onToggle }: { item: ToggleSetting; checked: boolean; onToggle: (v: boolean) => void }) => (
  <Field orientation="horizontal" className="px-0 py-3">
    <FieldContent>
      <FieldLabel htmlFor={item.id}>{item.title}</FieldLabel>
      <FieldDescription className="text-[13px]">{item.description}</FieldDescription>
    </FieldContent>
    <Switch id={item.id} checked={checked} onCheckedChange={onToggle} aria-label={item.title} />
  </Field>
)

export function SettingsModal() {
  const { state, dispatch, showToast } = useAppContext()
  const { modals } = useModalContext()
  const { settings } = state
  const [newProxy, setNewProxy] = useState('')

  const hasNewProxy = newProxy.trim().length > 0

  const close = () => dispatch({ type: 'SHOW_MODAL', modal: 'showSettingsModal', show: false })

  async function saveSetting(path: string, value: unknown) {
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
  }

  async function toggle(key: keyof typeof settings, settingPath: string, value: boolean) {
    const ok = await saveSetting(settingPath, value)
    if (ok) dispatch({ type: 'SET_SETTINGS', settings: { [key]: value } })
  }

  async function addProxy() {
    let url = newProxy.trim().replace(/\/+$/, '')
    if (!url) return
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url
    if (settings.githubProxies.includes(url)) {
      showToast('Уже добавлен', 'error')
      return
    }
    const next = [...settings.githubProxies, url]
    const ok = await saveSetting('updater.github_proxy', next)
    if (ok) {
      dispatch({ type: 'SET_SETTINGS', settings: { githubProxies: next } })
      setNewProxy('')
    }
  }

  async function removeProxy(index: number) {
    const next = settings.githubProxies.filter((_, i) => i !== index)
    const ok = await saveSetting('updater.github_proxy', next)
    if (ok) dispatch({ type: 'SET_SETTINGS', settings: { githubProxies: next } })
  }

  async function setTimezone(value: string) {
    const offset = parseInt(value, 10)
    const ok = await saveSetting('log.timezone', offset)
    if (ok) dispatch({ type: 'SET_SETTINGS', settings: { timezone: offset } })
  }

  return (
    <Dialog open={modals.showSettingsModal} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-xl! flex flex-col overflow-hidden h-[79dvh]! md:h-142!">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <IconSettings size={24} className="text-chart-2" /> Настройки
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="gui" className="flex flex-col flex-1 overflow-hidden">
          <TabsList variant="line" className="shrink-0 justify-start rounded-none border-b border-border px-0 gap-3">
            <TabsTrigger value="gui">Режим GUI</TabsTrigger>
            <TabsTrigger value="updates">Обновления</TabsTrigger>
            <TabsTrigger value="logs">Журнал</TabsTrigger>
          </TabsList>

          <ScrollArea className="flex-1 min-h-0">
            <div className="pr-2">
              <TabsContent value="gui">
                <Alert className="my-2 p-2.75 border-amber-500/20 bg-[#2a1f0d] text-amber-400">
                  <IconAlertCircle className="text-amber-400 size-4.5" />
                  <AlertDescription className="text-xs tracking-wide text-amber-400 leading-4.25">
                    Функция экспериментальная. Перед включением сделайте бэкап конфигураций. Несовместимо с комментариями.
                  </AlertDescription>
                </Alert>

                <FieldGroup className="gap-0!">
                  {guiSettings.map((item, index) => (
                    <Fragment key={item.id}>
                      <SwitchSettingField
                        item={item}
                        checked={settings[item.key]}
                        onToggle={(value) => toggle(item.key, item.path, value)}
                      />
                      {index < guiSettings.length - 1 && <Separator className="my-0" />}
                    </Fragment>
                  ))}
                </FieldGroup>
              </TabsContent>

              <TabsContent value="updates">
                <FieldGroup className="gap-0!">
                  {updateSettings.map((item) => (
                    <Fragment key={item.id}>
                      <SwitchSettingField
                        item={item}
                        checked={settings[item.key]}
                        onToggle={(value) => toggle(item.key, item.path, value)}
                      />
                      <Separator className="my-0" />
                    </Fragment>
                  ))}

                  <Field className="px-0 py-3">
                    <FieldContent>
                      <FieldLabel htmlFor="github-proxy-input">GitHub Proxy</FieldLabel>
                      <FieldDescription className="text-[13px] text-wrap!">
                        Прокси для загрузки обновлений при отсутствии доступа к GitHub, используются по порядку сверху вниз
                      </FieldDescription>
                    </FieldContent>

                    {settings.githubProxies.length === 0 ? (
                      <FieldDescription className="text-[13px] py-1">Прокси не добавлены</FieldDescription>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {settings.githubProxies.map((proxy, index) => (
                          <div key={proxy + index} className="flex items-center gap-2">
                            <div className="h-9 flex flex-1 min-w-0 items-center rounded-md border bg-input-background px-2.5">
                              <span className="w-full truncate text-[13px]">{proxy}</span>
                            </div>
                            <Button
                              variant="destructive"
                              className="shrink-0"
                              onClick={() => removeProxy(index)}
                              aria-label={`Удалить прокси ${proxy}`}
                            >
                              Удалить
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    <Field orientation="horizontal" className="gap-2">
                      <InputGroup className="flex-1">
                        <InputGroupInput
                          id="github-proxy-input"
                          value={newProxy}
                          onChange={(e) => setNewProxy(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && addProxy()}
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
                      <Button variant="default" className="shrink-0" onClick={addProxy} disabled={!hasNewProxy}>
                        Добавить
                      </Button>
                    </Field>
                  </Field>
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
                        {Array.from({ length: 27 }, (_, i) => i - 12).map((offset) => (
                          <SelectItem key={offset} value={String(offset)} className="text-sm">
                            UTC{offset >= 0 ? '+' : ''}
                            {offset}
                          </SelectItem>
                        ))}
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
