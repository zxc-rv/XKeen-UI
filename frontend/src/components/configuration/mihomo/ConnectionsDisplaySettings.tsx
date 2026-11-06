import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEffect, useState } from 'react'
import { DISPLAY_EVENT, readSelectorDisplay } from './SelectorDisplaySettings'

export type ConnectionsDisplay = 'standard' | 'zashboard'

const STORAGE_KEY = 'mihomo-connections-display'
const MANUAL_OVERRIDE_KEY = 'mihomo-connections-display-manual'
export const CONNECTIONS_DISPLAY_EVENT = 'mihomo:connections-display'

export function readConnectionsDisplay(): ConnectionsDisplay {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (localStorage.getItem(MANUAL_OVERRIDE_KEY) === 'true' && (saved === 'standard' || saved === 'zashboard')) return saved
  return readSelectorDisplay() === 'popup' ? 'zashboard' : 'standard'
}

export function ConnectionsDisplaySettings() {
  const [display, setDisplay] = useState<ConnectionsDisplay>(readConnectionsDisplay)

  useEffect(() => {
    const sync = () => setDisplay(readConnectionsDisplay())
    window.addEventListener('storage', sync)
    window.addEventListener(DISPLAY_EVENT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(DISPLAY_EVENT, sync)
    }
  }, [])

  const changeDisplay = (value: string) => {
    const next = value as ConnectionsDisplay
    setDisplay(next)
    localStorage.setItem(STORAGE_KEY, next)
    localStorage.setItem(MANUAL_OVERRIDE_KEY, 'true')
    window.dispatchEvent(new Event(CONNECTIONS_DISPLAY_EVENT))
  }

  return (
    <Select value={display} items={{ standard: 'Стандартный', zashboard: 'Zashboard' }} onValueChange={changeDisplay}>
      <SelectTrigger aria-label="Отображение соединений" className="h-9 w-[116px] shrink-0 px-2">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" sideOffset={4} className="min-w-[132px]">
        <SelectGroup>
          <SelectItem value="standard">Стандартный</SelectItem>
          <SelectItem value="zashboard">Zashboard</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
