import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  gotoLine,
  openSearchPanel,
  search,
  selectNextOccurrence,
  selectSelectionMatches,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import { Prec, StateEffect, StateField, type Extension, type EditorState } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding, type Panel, type ViewUpdate } from '@codemirror/view'
import type { ThemeSpec } from '../types'

/** Created by CodeMirror's `createPanel`; the React `SearchPanel` renders into `dom` through a portal. */
export interface SearchPanelHandle {
  dom: HTMLDivElement
  view: EditorView
  listeners: Set<(update: ViewUpdate) => void>
}

export interface SearchBridge {
  open(handle: SearchPanelHandle): void
  close(handle: SearchPanelHandle): void
}

/** Maximum number of matches `MatchIndex` will collect before reporting the count as "5000+". */
export const MAX_MATCHES = 5000

/** Whether the replace row is visible in the panel — CM state is the single source of truth. */
export const setReplaceVisible = StateEffect.define<boolean>()

export const replaceVisibleField = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((acc, effect) => (effect.is(setReplaceVisible) ? effect.value : acc), value),
})

export function createSearchExtension(bridge: SearchBridge): Extension {
  return [
    replaceVisibleField,
    search({
      top: true,
      literal: true,
      createPanel(view): Panel {
        const dom = document.createElement('div')
        dom.className = 'cm-search-host'
        const handle: SearchPanelHandle = { dom, view, listeners: new Set() }
        bridge.open(handle)
        return {
          dom,
          top: true,
          update: (update) => handle.listeners.forEach((listener) => listener(update)),
          destroy: () => {
            handle.listeners.clear()
            bridge.close(handle)
          },
        }
      },
    }),
    Prec.high(keymap.of(editorSearchKeymap)),
  ]
}

export const openReplacePanel = (view: EditorView): boolean => {
  openSearchPanel(view)
  view.dispatch({ effects: setReplaceVisible.of(true) })
  return true
}

export const editorSearchKeymap: readonly KeyBinding[] = [
  { key: 'Mod-f', run: openSearchPanel, scope: 'editor search-panel' },
  { key: 'Mod-h', run: openReplacePanel, scope: 'editor search-panel' },
  { key: 'Mod-Alt-f', run: openReplacePanel, scope: 'editor search-panel' }, // macOS: Cmd-H hides the app
  { key: 'F3', run: findNext, shift: findPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Mod-g', run: findNext, shift: findPrevious, scope: 'editor search-panel', preventDefault: true },
  { key: 'Escape', run: closeSearchPanel, scope: 'editor search-panel' },
  { key: 'Mod-Shift-l', run: selectSelectionMatches },
  { key: 'Mod-Alt-g', run: gotoLine },
  { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
]

export interface QueryPatch {
  search?: string
  caseSensitive?: boolean
  regexp?: boolean
  replace?: string
  wholeWord?: boolean
}

/** Build a new `SearchQuery` from the current one, always carrying `literal` over — `SearchQuery.eq` ignores it. */
export function updateQuery(view: EditorView, patch: QueryPatch): void {
  const current = getSearchQuery(view.state)
  const next = new SearchQuery({
    search: current.search,
    caseSensitive: current.caseSensitive,
    regexp: current.regexp,
    replace: current.replace,
    wholeWord: current.wholeWord,
    literal: current.literal,
    ...patch,
  })
  if (next.eq(current)) return
  view.dispatch({ effects: setSearchQuery.of(next) })
}

/**
 * After the query changes, if the main selection isn't already on a match, select the first match
 * at or after the selection (wrapping to the start of the document, like VS Code) and scroll it
 * into view. Focus is left untouched so the caller (the search field) keeps it.
 */
export function jumpToNearestMatch(view: EditorView): void {
  const query = getSearchQuery(view.state)
  if (!query.valid) return
  const selection = view.state.selection.main
  const cursor = query.getCursor(view.state)
  let first: { from: number; to: number } | null = null
  let target: { from: number; to: number } | null = null
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    const range = step.value
    if (range.from === selection.from && range.to === selection.to) return
    if (!first) first = range
    if (range.from >= selection.from) {
      target = range
      break
    }
  }
  target ??= first
  if (!target) return
  view.dispatch({
    selection: { anchor: target.from, head: target.to },
    effects: EditorView.scrollIntoView(target.from, { y: 'nearest' }),
    userEvent: 'select.search',
  })
}

/**
 * Caches the list of matches for a query against a document, keyed by identity (`state.doc` +
 * `query.eq`) so repeated lookups (counter re-render on every keystroke/selection change) don't
 * re-scan the whole document. Caps collection at `MAX_MATCHES`.
 */
export class MatchIndex {
  private doc: EditorState['doc'] | null = null
  private query: SearchQuery | null = null
  private ranges: { from: number; to: number }[] = []
  private truncated = false

  /** Recomputes (if needed) and returns `{ total, truncated, current }` for the given state/selection. */
  compute(state: EditorState): { total: number; truncated: boolean; current: number | null } {
    const query = getSearchQuery(state)
    if (!query.valid) {
      this.doc = null
      this.query = null
      this.ranges = []
      this.truncated = false
      return { total: 0, truncated: false, current: null }
    }
    if (this.doc !== state.doc || !this.query || !this.query.eq(query) || this.query.literal !== query.literal) {
      this.doc = state.doc
      this.query = query
      this.ranges = []
      this.truncated = false
      const cursor = query.getCursor(state)
      for (let step = cursor.next(); !step.done; step = cursor.next()) {
        if (this.ranges.length >= MAX_MATCHES) {
          this.truncated = true
          break
        }
        this.ranges.push(step.value)
      }
    }
    const selection = state.selection.main
    const current = this.currentIndex(selection.from, selection.to)
    return { total: this.ranges.length, truncated: this.truncated, current }
  }

  /** Binary search for a match equal to `[from, to)`; ranges are produced in document order. */
  private currentIndex(from: number, to: number): number | null {
    let lo = 0
    let hi = this.ranges.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const range = this.ranges[mid]
      if (range.from === from && range.to === to) return mid
      if (range.from < from) lo = mid + 1
      else hi = mid - 1
    }
    return null
  }
}

export function searchThemeSpec(isDarkTheme: boolean): ThemeSpec {
  return {
    '.cm-searchMatch': {
      backgroundColor: isDarkTheme ? 'rgba(234,179,8,0.28)' : '#fef08a',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: isDarkTheme ? 'rgba(249,115,22,0.6)' : '#fdba74',
      outline: `1px solid ${isDarkTheme ? 'rgba(249,115,22,0.6)' : '#fdba74'}`,
    },
    '.cm-panels': {
      backgroundColor: 'transparent',
      color: 'inherit',
      border: 'none',
    },
    '.cm-panels.cm-panels-bottom': {
      backgroundColor: isDarkTheme ? '#0f172a' : '#f8fafc',
      color: isDarkTheme ? '#c0caf5' : '#0f172a',
      borderTop: `1px solid ${isDarkTheme ? '#334155' : '#cbd5e1'}`,
      zIndex: '1',
    },
    '.cm-panels.cm-panels-top': {
      position: 'absolute',
      top: '8px',
      right: '14px',
      left: '0',
      width: 'auto',
      display: 'flex',
      justifyContent: 'flex-end',
      pointerEvents: 'none',
      zIndex: '10',
      borderBottom: 'none',
    },
    '.cm-panels.cm-panels-top > *': {
      pointerEvents: 'auto',
    },
    '@media (max-width: 767px)': {
      '.cm-panels.cm-panels-top': {
        top: '0',
        right: '0',
      },
    },
  }
}
