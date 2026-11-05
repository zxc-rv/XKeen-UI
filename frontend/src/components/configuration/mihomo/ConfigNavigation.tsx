import { IconCheck, IconChevronDown, IconCode, IconRoute } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { TabsTrigger } from '@/components/ui/tabs'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export type MihomoConfigSection = 'editor' | 'routing'
interface ConfigNavigationProps {
  value: MihomoConfigSection
  onChange: (value: MihomoConfigSection) => void
  onOpen: () => void
}
const sections: { value: MihomoConfigSection; label: string }[] = [
  { value: 'editor', label: 'Редактор' },
  { value: 'routing', label: 'Маршрутизация' },
]
export function ConfigNavigation({ value, onChange, onOpen }: ConfigNavigationProps) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerType = useRef('mouse')
  const cancelClose = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    timer.current = setTimeout(() => setOpen(false), 1500)
  }
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )
  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (
          details.reason === 'trigger-press' &&
          pointerType.current === 'mouse' &&
          details.event.type !== 'keydown' &&
          !('detail' in details.event && details.event.detail === 0)
        ) {
          details.cancel()
          cancelClose()
          setOpen(false)
          onOpen()
          return
        }
        cancelClose()
        setOpen(next)
      }}
    >
      <PopoverTrigger
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') {
            cancelClose()
            setOpen(true)
          }
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'touch') scheduleClose()
        }}
        onPointerDown={(event) => {
          pointerType.current = event.pointerType || 'mouse'
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            cancelClose()
            setOpen(true)
          }
        }}
        render={<TabsTrigger value="config" className="p-0 text-sm font-semibold md:text-lg" />}
      >
        Конфигурация
        <IconChevronDown size={14} className={cn('ml-0.5 transition-transform duration-150', open && 'rotate-180')} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={5}
        initialFocus={false}
        finalFocus={false}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onFocusCapture={cancelClose}
        className="bg-input-background border-border w-48 gap-0.5 rounded-md border p-1 duration-150"
      >
        <div role="group" aria-label="Разделы конфигурации" className="flex flex-col gap-0.5">
          {sections.map((section) => (
            <button
              key={section.value}
              type="button"
              onClick={() => {
                cancelClose()
                onOpen()
                onChange(section.value)
                setOpen(false)
              }}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1.25 text-left text-sm transition-colors outline-none hover:bg-(--menu-active-bg) hover:font-semibold hover:text-[#60a5fa] focus-visible:bg-(--menu-active-bg) focus-visible:text-[#60a5fa]',
                value === section.value ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {section.value === 'editor' ? <IconCode size={16} /> : <IconRoute size={16} />}
              <span className="flex-1">{section.label}</span>
              {value === section.value && <IconCheck size={14} />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
