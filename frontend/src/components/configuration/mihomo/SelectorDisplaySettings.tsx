import { useEffect, useState } from 'react'
import { IconAdjustmentsHorizontal } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'

export type SelectorDisplay = 'standard' | 'columns' | 'tiles' | 'popup'
export type RoutingMode = 'rule' | 'direct' | 'global'
const KEY = 'mihomo-selector-display'
const GROUP_BY_SUBSCRIPTIONS_KEY = 'mihomo-selector-group-by-subscriptions'
export const DISPLAY_EVENT = 'mihomo:selector-display'
export const GROUP_BY_SUBSCRIPTIONS_EVENT = 'mihomo:selector-group-by-subscriptions'

const LAYOUT_OPTIONS: { value: SelectorDisplay; label: string; mobileOnly?: boolean; desktopOnly?: boolean }[] = [
  { value: 'standard', label: 'Стандартный' },
  { value: 'columns', label: 'Две колонки', desktopOnly: true },
  { value: 'tiles', label: 'Три колонки', desktopOnly: true },
  { value: 'popup', label: 'Плитка', mobileOnly: true },
]

const MODE_OPTIONS: { value: RoutingMode; label: string }[] = [
  { value: 'rule', label: 'RULE' },
  { value: 'direct', label: 'DIRECT' },
  { value: 'global', label: 'GLOBAL' },
]

export function readSelectorDisplay(): SelectorDisplay {
  const value = localStorage.getItem(KEY)
  if (window.matchMedia('(max-width: 767px)').matches) return value === 'standard' ? 'standard' : 'popup'
  if (value === 'popup' && !window.matchMedia('(max-width: 767px)').matches) return 'standard'
  return value === 'columns' || value === 'tiles' || value === 'popup' ? value : 'standard'
}

export function readGroupBySubscriptions(): boolean {
  return localStorage.getItem(GROUP_BY_SUBSCRIPTIONS_KEY) === '1'
}

interface SelectorDisplaySettingsProps {
  mode: RoutingMode
  onModeChange: (mode: RoutingMode) => void
}

export function SelectorDisplaySettings({ mode, onModeChange }: SelectorDisplaySettingsProps) {
  const [display, setDisplay] = useState(readSelectorDisplay)
  const [groupBySubscriptions, setGroupBySubscriptions] = useState(readGroupBySubscriptions)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches)

  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const updateViewport = () => {
      setIsMobile(media.matches)
      setDisplay(readSelectorDisplay())
    }
    media.addEventListener('change', updateViewport)
    return () => media.removeEventListener('change', updateViewport)
  }, [])

  const changeDisplay = (value: string) => {
    const next = value as SelectorDisplay
    setDisplay(next)
    localStorage.setItem(KEY, next)
    window.dispatchEvent(new Event(DISPLAY_EVENT))
  }

  const changeGroupBySubscriptions = (checked: boolean) => {
    setGroupBySubscriptions(checked)
    localStorage.setItem(GROUP_BY_SUBSCRIPTIONS_KEY, checked ? '1' : '0')
    window.dispatchEvent(new Event(GROUP_BY_SUBSCRIPTIONS_EVENT))
  }

  const layoutOptions = LAYOUT_OPTIONS.filter((option) => (isMobile ? !option.desktopOnly : !option.mobileOnly))

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label="Настройки селекторов"
            className="bg-input-background hover:bg-input-background-hover aria-expanded:bg-input-background shadow-xs transition-[background-color,border-color,box-shadow] duration-200"
          >
            <IconAdjustmentsHorizontal />
          </Button>
        }
      />
      <PopoverContent align="end" className="border-border bg-input-background w-56 gap-0 rounded-md border p-1 ring-0">
        <div className="flex flex-col">
          <span className="text-muted-foreground px-2 py-1.5 text-xs font-medium">Лейаут</span>
          <RadioGroup value={display} onValueChange={changeDisplay} className="gap-0">
            {layoutOptions.map((option) => (
              <label
                key={option.value}
                htmlFor={`selector-layout-${option.value}`}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1.25 text-sm hover:bg-(--menu-active-bg)"
              >
                <RadioGroupItem value={option.value} id={`selector-layout-${option.value}`} />
                {option.label}
              </label>
            ))}
          </RadioGroup>
        </div>
        <Separator className="-mx-1 my-1 data-horizontal:w-auto" />
        <div className="flex flex-col">
          <span className="text-muted-foreground px-2 py-1.5 text-xs font-medium">Список подключений</span>
          <label
            htmlFor="selector-group-by-subscriptions"
            className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1.25 text-sm hover:bg-(--menu-active-bg)"
          >
            <Switch
              id="selector-group-by-subscriptions"
              checked={groupBySubscriptions}
              onCheckedChange={changeGroupBySubscriptions}
              aria-label="Группировать по подпискам"
            />
            По подпискам
          </label>
        </div>
        <Separator className="-mx-1 my-1 data-horizontal:w-auto" />
        <div className="flex flex-col">
          <span className="text-muted-foreground px-2 py-1.5 text-xs font-medium">Режим маршрутизации</span>
          <RadioGroup value={mode} onValueChange={(value) => onModeChange(value as RoutingMode)} className="gap-0">
            {MODE_OPTIONS.map((option) => (
              <label
                key={option.value}
                htmlFor={`selector-mode-${option.value}`}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1.25 text-sm hover:bg-(--menu-active-bg)"
              >
                <RadioGroupItem value={option.value} id={`selector-mode-${option.value}`} />
                {option.label}
              </label>
            ))}
          </RadioGroup>
        </div>
      </PopoverContent>
    </Popover>
  )
}
