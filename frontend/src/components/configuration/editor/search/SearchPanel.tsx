import { closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, selectMatches } from '@codemirror/search'
import type { SearchQuery } from '@codemirror/search'
import { runScopeHandlers } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import { IconArrowDown, IconArrowUp, IconChevronRight, IconX } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { MatchIndex, MAX_MATCHES, replaceVisibleField, setReplaceVisible, updateQuery, jumpToNearestMatch } from './searchExtension'
import type { SearchPanelHandle } from './searchExtension'

interface Props {
  handle: SearchPanelHandle
}

interface PanelState {
  query: SearchQuery
  replaceVisible: boolean
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)

/** Displays `combo` with `Ctrl` swapped for `⌘` on macOS, matching the rest of the shortcuts UI. */
function shortcut(combo: string): string {
  return isMac ? combo.replace(/Ctrl/g, '⌘') : combo
}

function readPanelState(handle: SearchPanelHandle): PanelState {
  const state = handle.view.state
  return { query: getSearchQuery(state), replaceVisible: state.field(replaceVisibleField) }
}

function formatCounter(
  query: SearchQuery,
  counts: { total: number; truncated: boolean; current: number | null }
): { text: string; error: boolean } {
  if (!query.search) return { text: '', error: false }
  if (!query.valid) return { text: 'Неверное выражение', error: true }
  if (counts.total === 0) return { text: 'Нет совпадений', error: true }
  const total = counts.truncated ? `${MAX_MATCHES}+` : String(counts.total)
  // `current` can legitimately be 0 (the first match) — check against `null`, not falsiness.
  const current = counts.current === null ? '?' : String(counts.current + 1)
  return { text: `${current} из ${total}`, error: false }
}

export function SearchPanel({ handle }: Props) {
  const { view } = handle
  const [state, setState] = useState<PanelState>(() => readPanelState(handle))
  const matchIndexRef = useRef(new MatchIndex())
  const [counts, setCounts] = useState(() => matchIndexRef.current.compute(view.state))

  const searchInputRef = useRef<HTMLInputElement>(null)
  const replaceInputRef = useRef<HTMLInputElement>(null)
  const lastFieldRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const sync = (update: ViewUpdate | null) => {
      const s = update?.state ?? handle.view.state
      setState({ query: getSearchQuery(s), replaceVisible: s.field(replaceVisibleField) })
      setCounts(matchIndexRef.current.compute(s))
    }
    sync(null)
    handle.listeners.add(sync)
    return () => {
      handle.listeners.delete(sync)
    }
  }, [handle])

  useLayoutEffect(() => {
    const input = searchInputRef.current
    if (!input) return
    input.focus()
    input.select()
    lastFieldRef.current = input
  }, [handle])

  const refocusField = () => {
    const el = lastFieldRef.current ?? searchInputRef.current
    el?.focus()
  }

  const toggleReplaceVisible = () => {
    view.dispatch({ effects: setReplaceVisible.of(!state.replaceVisible) })
  }

  const toggleCaseSensitive = () => {
    updateQuery(view, { caseSensitive: !state.query.caseSensitive })
    jumpToNearestMatch(view)
  }
  const toggleRegexp = () => {
    updateQuery(view, { regexp: !state.query.regexp })
    jumpToNearestMatch(view)
  }
  const toggleWholeWord = () => {
    updateQuery(view, { wholeWord: !state.query.wholeWord })
    jumpToNearestMatch(view)
  }

  const handleFindPrevious = () => {
    findPrevious(view)
    refocusField()
  }
  const handleFindNext = () => {
    findNext(view)
    refocusField()
  }
  const handleReplaceOne = () => {
    replaceNext(view)
    refocusField()
  }
  const handleReplaceAll = () => {
    replaceAll(view)
    refocusField()
  }
  const handleClose = () => {
    closeSearchPanel(view)
    view.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = isMac ? event.metaKey : event.ctrlKey
    const target = event.target

    // Ctrl+F while a field is focused selects its contents instead of re-triggering the CM keymap
    // (`code` rather than `key` so it also works on non-Latin keyboard layouts).
    if (mod && !event.altKey && !event.shiftKey && event.code === 'KeyF' && target instanceof HTMLInputElement) {
      event.preventDefault()
      target.select()
      return
    }

    if (runScopeHandlers(view, event.nativeEvent, 'search-panel')) {
      event.preventDefault()
      return
    }

    if (event.key === 'Enter' && mod && event.altKey) {
      event.preventDefault()
      replaceAll(view)
      return
    }
    if (event.key === 'Enter' && event.altKey) {
      event.preventDefault()
      selectMatches(view)
      view.focus()
      return
    }
    if (event.key === 'Enter' && target === replaceInputRef.current) {
      event.preventDefault()
      replaceNext(view)
      return
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault()
      findPrevious(view)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      findNext(view)
      return
    }
    if (event.altKey && event.code === 'KeyC') {
      event.preventDefault()
      toggleCaseSensitive()
      return
    }
    if (event.altKey && event.code === 'KeyR') {
      event.preventDefault()
      toggleRegexp()
      return
    }
    if (event.altKey && event.code === 'KeyW') {
      event.preventDefault()
      toggleWholeWord()
    }
  }

  const counter = formatCounter(state.query, counts)
  const invalid = state.query.search.length > 0 && !state.query.valid

  return (
    <TooltipProvider delayDuration={500}>
      <div
        onKeyDown={handleKeyDown}
        className="border-border bg-popover/95 text-popover-foreground pointer-events-auto ml-auto flex w-full items-start gap-1 rounded-b-lg border-x-0 border-t-0 p-1.5 shadow-md backdrop-blur-sm md:w-auto md:max-w-[min(42rem,calc(100%-1.75rem))] md:min-w-[30rem] md:rounded-lg md:border"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-expanded={state.replaceVisible}
                aria-label={state.replaceVisible ? 'Скрыть замену' : 'Показать замену'}
                onClick={toggleReplaceVisible}
              >
                <IconChevronRight className={cn('transition-transform', state.replaceVisible && 'rotate-90')} />
              </Button>
            }
          />
          <TooltipContent>Показать замену ({shortcut('Ctrl+H')})</TooltipContent>
        </Tooltip>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1 md:flex-nowrap">
            {/* On narrow screens the field takes the whole first row; counter and buttons wrap below it. */}
            <InputGroup className="h-8 min-w-0 flex-1 basis-full md:w-auto md:basis-auto">
              <InputGroupInput
                ref={searchInputRef}
                className="h-8"
                {...{ 'main-field': '' }}
                placeholder="Найти"
                value={state.query.search}
                aria-invalid={invalid}
                enterKeyHint="search"
                spellCheck={false}
                onFocus={(e) => {
                  lastFieldRef.current = e.currentTarget
                }}
                onChange={(e) => {
                  updateQuery(view, { search: e.target.value })
                  jumpToNearestMatch(view)
                }}
              />
              <InputGroupAddon align="inline-end">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <InputGroupButton
                        aria-pressed={state.query.caseSensitive}
                        aria-label="Учитывать регистр"
                        className="aria-pressed:bg-accent font-mono text-[11px]"
                        onClick={toggleCaseSensitive}
                      >
                        Aa
                      </InputGroupButton>
                    }
                  />
                  <TooltipContent>Учитывать регистр ({shortcut('Alt+C')})</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <InputGroupButton
                        aria-pressed={state.query.regexp}
                        aria-label="Регулярное выражение"
                        className="aria-pressed:bg-accent font-mono text-[11px]"
                        onClick={toggleRegexp}
                      >
                        .*
                      </InputGroupButton>
                    }
                  />
                  <TooltipContent>Регулярное выражение ({shortcut('Alt+R')})</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <InputGroupButton
                        aria-pressed={state.query.wholeWord}
                        aria-label="Слово целиком"
                        className="aria-pressed:bg-accent font-mono text-[11px]"
                        onClick={toggleWholeWord}
                      >
                        ab
                      </InputGroupButton>
                    }
                  />
                  <TooltipContent>Слово целиком ({shortcut('Alt+W')})</TooltipContent>
                </Tooltip>
              </InputGroupAddon>
            </InputGroup>

            <span className={cn('text-muted-foreground mr-auto min-w-[6.5rem] text-xs tabular-nums', counter.error && 'text-destructive')}>
              {counter.text}
            </span>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="Предыдущее совпадение" onClick={handleFindPrevious}>
                    <IconArrowUp />
                  </Button>
                }
              />
              <TooltipContent>Предыдущее совпадение ({shortcut('Shift+Enter')})</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="Следующее совпадение" onClick={handleFindNext}>
                    <IconArrowDown />
                  </Button>
                }
              />
              <TooltipContent>Следующее совпадение ({shortcut('Enter')})</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="Закрыть" onClick={handleClose}>
                    <IconX />
                  </Button>
                }
              />
              <TooltipContent>Закрыть ({shortcut('Esc')})</TooltipContent>
            </Tooltip>
          </div>

          {state.replaceVisible && (
            <div className="flex items-center gap-1">
              <InputGroup className="h-8 min-w-0 flex-1">
                <InputGroupInput
                  ref={replaceInputRef}
                  className="h-8"
                  placeholder="Заменить"
                  value={state.query.replace}
                  spellCheck={false}
                  onFocus={(e) => {
                    lastFieldRef.current = e.currentTarget
                  }}
                  onChange={(e) => updateQuery(view, { replace: e.target.value })}
                />
              </InputGroup>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="sm" variant="outline" onClick={handleReplaceOne}>
                      Заменить
                    </Button>
                  }
                />
                <TooltipContent>Заменить ({shortcut('Enter')})</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="sm" variant="outline" onClick={handleReplaceAll}>
                      Заменить все
                    </Button>
                  }
                />
                <TooltipContent>Заменить все ({shortcut('Ctrl+Alt+Enter')})</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
