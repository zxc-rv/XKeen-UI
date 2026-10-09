import { historyField, indentWithTab } from '@codemirror/commands'
import { foldedRanges, foldEffect, syntaxHighlighting, unfoldEffect } from '@codemirror/language'
import { setDiagnostics } from '@codemirror/lint'
import { selectSelectionMatches } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getFileLanguage } from '../../lib/api'
import { configAutocompletion } from './editor/completion'
import { editorHighlight, editorTheme, getLanguageExtension } from './editor/highlighting'
import { SearchPanel } from './editor/search/SearchPanel'
import { createSearchExtension } from './editor/search/searchExtension'
import { baseSetup } from './editor/setup'
import { useEditorSearch } from './editor/useEditorSearch'
import type { EditorLanguage } from './editor/types'
import { clamp, validateByLanguage } from './editor/validation'

interface SavedViewState {
  anchor: number
  head: number
  scrollTop: number
  scrollLeft: number
  folds: { from: number; to: number }[]
  history?: unknown
}

export interface CodeMirrorRef {
  getValue: () => string
  setValue: (value: string, newSavedContent?: string, savedHistory?: unknown) => void
  setSavedContent: (content: string) => void
  setLanguage: (language: string) => void
  validate: (filename: string) => void
  format: () => Promise<void>
  layout: () => void
  focus: () => void
  isValid: (filename: string) => boolean
  saveViewState: () => SavedViewState | null
  restoreViewState: (state: SavedViewState | null) => void
  replaceAll: (text: string) => void
  replaceRange: (from: number, to: number, text: string) => void
  getLineCount: () => number
  offsetToLineColumn: (offset: number) => { lineNumber: number; column: number }
  revealLine: (line: number) => void
}

interface Props {
  onContentChange: (content: string, isDirty: boolean) => void
  onValidationChange: (isValid: boolean, error?: string) => void
  onReady?: () => void
  onSave?: () => void
}

function normalizeLanguage(language: string): EditorLanguage {
  if (language === 'yaml') return 'yaml'
  if (language === 'json') return 'json'
  return 'text'
}

function getLanguageFromFilename(filename: string, fallback: EditorLanguage): EditorLanguage {
  const fromFile = normalizeLanguage(getFileLanguage(filename))
  return fromFile === 'text' ? fallback : fromFile
}

export const CodeMirrorEditor = forwardRef<CodeMirrorRef, Props>(({ onContentChange, onValidationChange, onReady, onSave }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef(new Compartment())
  const themeCompartmentRef = useRef(new Compartment())
  const [isDarkTheme, setIsDarkTheme] = useState(() => document.documentElement.classList.contains('dark'))
  const initialIsDarkThemeRef = useRef(isDarkTheme)
  const currentThemeRef = useRef(isDarkTheme)
  const isMobileRef = useRef(typeof window !== 'undefined' && window.innerWidth < 768)

  const onContentChangeRef = useRef(onContentChange)
  const onValidationChangeRef = useRef(onValidationChange)
  const onReadyRef = useRef(onReady)
  const onSaveRef = useRef(onSave)
  const savedContentRef = useRef('')
  const filenameRef = useRef('')
  const languageRef = useRef<EditorLanguage>('json')
  const suppressRef = useRef(false)
  const lastValidationRef = useRef<{ isValid: boolean; error?: string } | null>(null)
  const extensionsRef = useRef<Extension[]>([])
  const { searchPanel, bridge: searchBridge } = useEditorSearch(viewRef)

  useLayoutEffect(() => {
    onContentChangeRef.current = onContentChange
    onValidationChangeRef.current = onValidationChange
    onReadyRef.current = onReady
    onSaveRef.current = onSave
  })

  useEffect(() => {
    const root = document.documentElement
    const syncTheme = () => setIsDarkTheme(root.classList.contains('dark'))
    syncTheme()

    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const createExtensions = useCallback(
    (darkTheme: boolean): Extension[] => [
      ...baseSetup,
      configAutocompletion(() => ({ file: filenameRef.current, language: languageRef.current })),
      createSearchExtension(searchBridge),
      Prec.highest(
        lineNumbers({
          formatNumber: (n) => String(n).padStart(3, '\u00a0'),
          domEventHandlers: {
            mousedown(view, line, event) {
              const mouse = event as MouseEvent
              const lineEnd = line.to === view.state.doc.length ? line.to : line.to + 1
              view.dispatch({
                selection: mouse.shiftKey
                  ? { anchor: view.state.selection.main.anchor, head: lineEnd }
                  : { anchor: line.from, head: lineEnd },
                userEvent: 'select',
              })
              return true
            },
          },
        })
      ),
      keymap.of([
        {
          key: 'Mod-s',
          scope: 'editor search-panel',
          run: () => {
            onSaveRef.current?.()
            return true
          },
        },
        {
          key: 'Shift-Alt-f',
          run: () => {
            void formatRef.current()
            return true
          },
        },
        {
          key: 'Mod-F2',
          run: (view) => {
            const sel = view.state.selection.main
            if (sel.empty) {
              const word = view.state.wordAt(sel.head)
              if (word) view.dispatch({ selection: { anchor: word.from, head: word.to } })
            }
            return selectSelectionMatches(view)
          },
        },
        indentWithTab,
      ]),
      Prec.highest(syntaxHighlighting(editorHighlight)),
      languageCompartmentRef.current.of(getLanguageExtension(languageRef.current)),
      indentationMarkers({ thickness: 2, colors: { activeDark: '#57a8d4', activeLight: '#3b82f6' } }),
      themeCompartmentRef.current.of(editorTheme(isMobileRef.current, darkTheme)),
      EditorView.contentAttributes.of({
        spellcheck: 'false',
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: 'off',
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || suppressRef.current) return
        const content = update.state.doc.toString()
        const isDirty = content !== savedContentRef.current
        onContentChangeRef.current(content, isDirty)
        runValidationRef.current(update.view, filenameRef.current)
      }),
    ],
    [searchBridge]
  )

  const emitValidation = useCallback((isValid: boolean, error?: string) => {
    const normalizedError = error || undefined
    const prev = lastValidationRef.current
    if (prev?.isValid === isValid && prev?.error === normalizedError) return
    lastValidationRef.current = { isValid, error: normalizedError }
    onValidationChangeRef.current(isValid, normalizedError)
  }, [])

  const runValidation = useCallback(
    (view: EditorView, filename: string) => {
      const language = getLanguageFromFilename(filename, languageRef.current)
      const result = validateByLanguage(view.state.doc.toString(), language)
      view.dispatch(setDiagnostics(view.state, result.diagnostics))
      emitValidation(result.isValid, result.error)
    },
    [emitValidation]
  )

  const runValidationRef = useRef(runValidation)
  useLayoutEffect(() => {
    runValidationRef.current = runValidation
  })

  const format = useCallback(async () => {
    const view = viewRef.current
    if (!view) return
    const language = getLanguageFromFilename(filenameRef.current, languageRef.current)
    const content = view.state.doc.toString()
    if (!content.trim()) return

    try {
      const cursorOffset = view.state.selection.main.head
      let text: string
      let newCursor: number

      if (language === 'json') {
        const [prettier, prettierBabel, prettierEstree] = await Promise.all([
          import('prettier'),
          import('prettier/plugins/babel'),
          import('prettier/plugins/estree'),
        ])
        const result = await prettier.formatWithCursor(content, {
          cursorOffset,
          parser: 'json',
          plugins: [prettierBabel, prettierEstree],
          printWidth: 120,
          endOfLine: 'lf',
        })
        text = result.formatted
          .replace(/\n{3,}/g, '\n\n')
          .replace(/\s+$/gm, '')
          .replace(/\n$/, '')
        newCursor = result.cursorOffset
      } else if (language === 'yaml') {
        const [prettier, prettierYaml] = await Promise.all([import('prettier'), import('prettier/plugins/yaml')])
        const result = await prettier.formatWithCursor(content, {
          cursorOffset,
          parser: 'yaml',
          plugins: [prettierYaml],
          printWidth: 200,
          tabWidth: 2,
          singleQuote: true,
          endOfLine: 'lf',
        })
        text = result.formatted
        newCursor = result.cursorOffset
      } else {
        return
      }
      if (text === content) return

      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: EditorSelection.cursor(Math.min(newCursor, text.length)),
        scrollIntoView: true,
      })
      runValidation(view, filenameRef.current)
    } catch {
      /* ignore formatting errors */
    }
  }, [runValidation])

  const formatRef = useRef(format)
  useLayoutEffect(() => {
    formatRef.current = format
  })

  useImperativeHandle(
    ref,
    () => ({
      getValue: () => viewRef.current?.state.doc.toString() ?? '',
      setValue: (value: string, newSavedContent?: string, savedHistory?: unknown) => {
        const view = viewRef.current
        if (!view) return
        suppressRef.current = true
        if (newSavedContent !== undefined) {
          savedContentRef.current = newSavedContent
          const fields = savedHistory ? { history: historyField } : undefined
          const json = {
            doc: value,
            selection: { main: 0, ranges: [{ anchor: 0, head: 0 }] },
            ...(savedHistory ? { history: savedHistory } : {}),
          }
          const extensions = createExtensions(currentThemeRef.current)
          extensionsRef.current = extensions
          view.setState(EditorState.fromJSON(json, { extensions }, fields))
        } else {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value },
            selection: EditorSelection.cursor(0),
          })
        }
        suppressRef.current = false
      },
      setSavedContent: (content: string) => {
        savedContentRef.current = content
      },
      setLanguage: (language: string) => {
        const nextLanguage = normalizeLanguage(language)
        languageRef.current = nextLanguage
        const view = viewRef.current
        extensionsRef.current = createExtensions(currentThemeRef.current)
        if (!view) return
        view.dispatch({
          effects: languageCompartmentRef.current.reconfigure(getLanguageExtension(nextLanguage)),
        })
      },
      validate: (filename: string) => {
        filenameRef.current = filename
        const view = viewRef.current
        if (!view) return
        runValidation(view, filename)
      },
      format,
      layout: () => {
        viewRef.current?.requestMeasure()
      },
      focus: () => {
        viewRef.current?.focus()
      },
      isValid: (filename: string) => {
        const view = viewRef.current
        if (!view) return false
        const language = getLanguageFromFilename(filename, languageRef.current)
        return validateByLanguage(view.state.doc.toString(), language).isValid
      },
      saveViewState: () => {
        const view = viewRef.current
        if (!view) return null
        const folds: { from: number; to: number }[] = []
        const cursor = foldedRanges(view.state).iter()
        while (cursor.value !== null) {
          folds.push({ from: cursor.from, to: cursor.to })
          cursor.next()
        }
        return {
          anchor: view.state.selection.main.anchor,
          head: view.state.selection.main.head,
          scrollTop: view.scrollDOM.scrollTop,
          scrollLeft: view.scrollDOM.scrollLeft,
          folds,
          history: view.state.toJSON({ history: historyField }).history,
        }
      },
      restoreViewState: (state: SavedViewState | null) => {
        const view = viewRef.current
        if (!view || !state) return
        const docLength = view.state.doc.length
        const effects = [
          ...(foldedRanges(view.state).size > 0 ? [unfoldEffect.of({ from: 0, to: docLength })] : []),
          ...state.folds.filter((f) => f.to <= docLength).map((f) => foldEffect.of(f)),
        ]
        view.dispatch({
          selection: {
            anchor: clamp(state.anchor, 0, docLength),
            head: clamp(state.head, 0, docLength),
          },
          ...(effects.length ? { effects } : {}),
        })
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = Math.max(0, state.scrollTop)
          view.scrollDOM.scrollLeft = Math.max(0, state.scrollLeft)
        })
      },
      replaceAll: (text: string) => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        })
      },
      replaceRange: (from: number, to: number, text: string) => {
        const view = viewRef.current
        if (!view) return
        const max = view.state.doc.length
        const safeFrom = clamp(from, 0, max)
        const safeTo = clamp(to, 0, max)
        view.dispatch({ changes: { from: safeFrom, to: safeTo, insert: text } })
        requestAnimationFrame(() => {
          const targetTop = Math.max(0, view.lineBlockAt(safeFrom).top - 20)
          const startTop = view.scrollDOM.scrollTop
          const distance = targetTop - startTop
          if (Math.abs(distance) < 1) return
          const duration = 50
          const startTime = performance.now()
          const step = (now: number) => {
            const progress = Math.min((now - startTime) / duration, 1)
            view.scrollDOM.scrollTop = startTop + distance * (1 - Math.pow(1 - progress, 3))
            if (progress < 1) requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })
      },
      getLineCount: () => viewRef.current?.state.doc.lines ?? 1,
      offsetToLineColumn: (offset: number) => {
        const view = viewRef.current
        if (!view) return { lineNumber: 1, column: 1 }
        const safeOffset = clamp(offset, 0, view.state.doc.length)
        const line = view.state.doc.lineAt(safeOffset)
        return {
          lineNumber: line.number,
          column: safeOffset - line.from + 1,
        }
      },
      revealLine: (line: number) => {
        const view = viewRef.current
        if (!view) return
        const safeLine = clamp(line, 1, view.state.doc.lines)
        const lineOffset = view.state.doc.line(safeLine).from

        view.scrollDOM.style.scrollBehavior = 'smooth'

        view.dispatch({
          effects: EditorView.scrollIntoView(lineOffset, { y: 'center' }),
        })

        setTimeout(() => {
          if (view.scrollDOM) view.scrollDOM.style.scrollBehavior = 'auto'
        }, 500)
      },
    }),
    [createExtensions, format, runValidation]
  )

  useEffect(() => {
    if (!containerRef.current) return
    const extensions = createExtensions(initialIsDarkThemeRef.current)
    extensionsRef.current = extensions
    const view = new EditorView({
      state: EditorState.create({ doc: '', extensions }),
      parent: containerRef.current,
    })
    viewRef.current = view
    document.fonts.ready.then(() => {
      view.requestMeasure()
      onReadyRef.current?.()
    })

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [createExtensions])

  useEffect(() => {
    currentThemeRef.current = isDarkTheme
    extensionsRef.current = createExtensions(isDarkTheme)
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(editorTheme(isMobileRef.current, isDarkTheme)),
    })
  }, [createExtensions, isDarkTheme])

  return (
    <div className="border-border bg-input-background absolute inset-4 overflow-hidden rounded-xl border">
      <div ref={containerRef} className="h-full w-full" />
      {searchPanel && createPortal(<SearchPanel handle={searchPanel} />, searchPanel.dom)}
    </div>
  )
})

CodeMirrorEditor.displayName = 'CodeMirrorEditor'
