import { useEffect, useState } from 'react'
import { IconLayoutGrid } from '@tabler/icons-react'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from '@/components/ui/select'

export type SelectorDisplay = 'standard' | 'columns' | 'tiles' | 'popup'
const KEY = 'mihomo-selector-display'
const CONNECTIONS_DISPLAY_KEY = 'mihomo-connections-display'
const CONNECTIONS_DISPLAY_MANUAL_KEY = 'mihomo-connections-display-manual'
const CONNECTIONS_DISPLAY_EVENT = 'mihomo:connections-display'
export const DISPLAY_EVENT = 'mihomo:selector-display'

export function readSelectorDisplay(): SelectorDisplay {
  const value = localStorage.getItem(KEY)
  if (window.matchMedia('(max-width: 767px)').matches) return value === 'popup' ? 'popup' : 'standard'
  if (value === 'popup' && !window.matchMedia('(max-width: 767px)').matches) return 'standard'
  return value === 'columns' || value === 'tiles' || value === 'popup' ? value : 'standard'
}

export function SelectorDisplaySettings() {
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
    localStorage.setItem(CONNECTIONS_DISPLAY_KEY, next === 'popup' ? 'zashboard' : 'standard')
    localStorage.removeItem(CONNECTIONS_DISPLAY_MANUAL_KEY)
    window.dispatchEvent(new Event(CONNECTIONS_DISPLAY_EVENT))
    window.dispatchEvent(new Event(DISPLAY_EVENT))
  }

  return (
    <Select value={display} onValueChange={changeDisplay}>
      <SelectTrigger
        aria-label="Отображение селекторов"
        hideIcon
        className="size-9 justify-center p-2"
      >
        <IconLayoutGrid />
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="w-56">
        <SelectGroup>
          <SelectItem value="standard">Стандартный</SelectItem>
          {!isMobile && <SelectItem value="columns">Две колонки</SelectItem>}
          {!isMobile && <SelectItem value="tiles">Три колонки</SelectItem>}
          {isMobile && <SelectItem value="popup">Zashboard</SelectItem>}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
