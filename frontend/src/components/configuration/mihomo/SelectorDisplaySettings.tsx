import { useEffect, useState } from 'react'
import { IconAdjustmentsHorizontal } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'

export type SelectorDisplay = 'standard' | 'columns' | 'tiles' | 'popup'
export type RoutingMode = 'rule' | 'direct' | 'global'
const KEY = 'mihomo-selector-display'
export const DISPLAY_EVENT = 'mihomo:selector-display'

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

interface SelectorDisplaySettingsProps {
  mode: RoutingMode
  onModeChange: (mode: RoutingMode) => void
}

export function SelectorDisplaySettings({ mode, onModeChange }: SelectorDisplaySettingsProps) {
  const [display, setDisplay] = useState(readSelectorDisplay)
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
      <PopoverContent align="end" className="border-border bg-input-background w-56 gap-3 rounded-md border ring-0">
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs font-medium">Лейаут</span>
          <RadioGroup value={display} onValueChange={changeDisplay} className="gap-1">
            {layoutOptions.map((option) => (
              <label
                key={option.value}
                htmlFor={`selector-layout-${option.value}`}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-(--menu-active-bg)"
              >
                <RadioGroupItem value={option.value} id={`selector-layout-${option.value}`} />
                {option.label}
              </label>
            ))}
          </RadioGroup>
        </div>
        <Separator />
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs font-medium">Режим маршрутизации</span>
          <RadioGroup value={mode} onValueChange={(value) => onModeChange(value as RoutingMode)} className="gap-1">
            {MODE_OPTIONS.map((option) => (
              <label
                key={option.value}
                htmlFor={`selector-mode-${option.value}`}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-(--menu-active-bg)"
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
