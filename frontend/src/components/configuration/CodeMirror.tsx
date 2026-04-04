import { autocompletion, completeAnyWord } from '@codemirror/autocomplete'
import { historyField, indentWithTab } from '@codemirror/commands'
import { jsonLanguage } from '@codemirror/lang-json'
import { yamlLanguage } from '@codemirror/lang-yaml'
import {
  ensureSyntaxTree,
  foldedRanges,
  foldEffect,
  foldKeymap as foldKeymapCmd,
  HighlightStyle,
  indentService,
  LanguageSupport,
  syntaxHighlighting,
  syntaxTree,
  unfoldEffect,
} from '@codemirror/language'
import { setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { selectSelectionMatches } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, Prec, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { basicSetup } from 'codemirror'
import * as jsyaml from 'js-yaml'
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { getFileLanguage } from '../../lib/api'

type EditorLanguage = 'json' | 'yaml' | 'text'

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

interface ValidationResult {
  diagnostics: Diagnostic[]
  isValid: boolean
  error?: string
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

const BOOL_RE = /^(true|false|True|False|TRUE|FALSE)$/
const NULL_RE = /^(null|Null|NULL|~)$/
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^0x[0-9a-fA-F]+$|^0o[0-7]+$|^0b[01]+$/

const boolDecoration = Decoration.mark({ attributes: { style: 'color: var(--cm-bool)' } })
const nullDecoration = Decoration.mark({ attributes: { style: 'color: var(--cm-bool)' } })
const numberDecoration = Decoration.mark({ attributes: { style: 'color: var(--cm-number)' } })

function buildYamlDecorations(view: EditorView): DecorationSet {
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 1000) ?? syntaxTree(view.state)
  const builder = new RangeSetBuilder<Decoration>()
  tree.iterate({
    enter(node) {
      if (node.name === 'QuotedLiteral') {
        builder.add(node.from, node.to, Decoration.mark({ attributes: { style: 'color: var(--cm-string)' } }))
      } else if (node.name === 'Literal') {
        const text = view.state.doc.sliceString(node.from, node.to)
        if (BOOL_RE.test(text)) builder.add(node.from, node.to, boolDecoration)
        else if (NULL_RE.test(text)) builder.add(node.from, node.to, nullDecoration)
        else if (NUMBER_RE.test(text)) builder.add(node.from, node.to, numberDecoration)
        else builder.add(node.from, node.to, Decoration.mark({ attributes: { style: 'color: var(--cm-string)' } }))
      }
    },
  })
  return builder.finish()
}

const yamlScalarDecorator = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildYamlDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = buildYamlDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

const yamlFlatIndent = indentService.of((context, pos) => {
  const line = context.lineAt(pos, -1)
  return line.text.match(/^(\s*)/)?.[1].length ?? 0
})

const jsoncLang = jsonLanguage.configure({ dialect: 'jsonc' })

const commentDecoration = Decoration.mark({ attributes: { style: 'color: var(--cm-comment); font-style: italic' } })

function buildJsoncCommentDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const content = view.state.doc.toString()
  const commentRe = /(?<!:|\w)\/\/[^\n]*|\/\*[\s\S]*?\*\//g
  for (const match of content.matchAll(commentRe)) builder.add(match.index!, match.index! + match[0].length, commentDecoration)
  return builder.finish()
}

const jsoncCommentDecorator = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildJsoncCommentDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = buildJsoncCommentDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

const jsoncEagerParser = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      ensureSyntaxTree(view.state, view.state.doc.length, 1000)
    }
    update(update: ViewUpdate) {
      if (update.docChanged) ensureSyntaxTree(update.view.state, update.view.state.doc.length, 1000)
    }
  }
)

const jsoncExtension = new LanguageSupport(jsoncLang, [
  jsoncLang.data.of({ commentTokens: { line: '//' } }),
  jsoncEagerParser,
  Prec.highest(jsoncCommentDecorator),
])

function getLanguageExtension(language: EditorLanguage): Extension {
  if (language === 'yaml') return [new LanguageSupport(yamlLanguage), yamlScalarDecorator, yamlFlatIndent]
  if (language === 'json') return jsoncExtension
  return []
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function offsetToLine(content: string, offset: number) {
  return content.slice(0, clamp(offset, 0, content.length)).split('\n').length
}

function lineColumnToOffset(content: string, line: number, column: number) {
  const lines = content.split('\n')
  let offset = 0
  for (let i = 0; i < Math.max(0, line - 1) && i < lines.length; i++) offset += lines[i].length + 1
  return clamp(offset + Math.max(0, column - 1), 0, content.length)
}

function validateJson(content: string): ValidationResult {
  const errors: ParseError[] = []
  parseJsonc(content, errors, {
    disallowComments: false,
  })
  if (!errors.length) return { diagnostics: [], isValid: true }

  const first = errors[0]
  const from = clamp(first.offset, 0, content.length)
  const parsedTo = clamp(first.offset + Math.max(first.length, 1), 0, content.length)
  const to = parsedTo > from ? parsedTo : from
  const message = `${printParseErrorCode(first.error)
    .replace(/([A-Z])/g, ' $1')
    .trim()} [строка ${offsetToLine(content, from)}]`
    .replace(/([A-Z])/g, ' $1')
    .trim()
  return {
    diagnostics: [{ from, to, severity: 'error', message }],
    isValid: false,
    error: message,
  }
}

function validateYaml(content: string): ValidationResult {
  try {
    jsyaml.load(content)
    return { diagnostics: [], isValid: true }
  } catch (error) {
    const yamlError = error as {
      message: string
      reason?: string
      mark?: { line: number; column: number }
    }
    const line = yamlError.mark ? yamlError.mark.line + 1 : 1
    const column = yamlError.mark ? yamlError.mark.column + 1 : 1
    const from = lineColumnToOffset(content, line, column)
    const lineEnd = content.indexOf('\n', from)
    const to = lineEnd === -1 ? content.length : lineEnd
    const message = yamlError.mark ? `${yamlError.reason || yamlError.message} [строка ${line}]` : yamlError.message
    return {
      diagnostics: [{ from, to, severity: 'error', message }],
      isValid: false,
      error: message,
    }
  }
}

function validateByLanguage(content: string, language: EditorLanguage): ValidationResult {
  if (language === 'json') return validateJson(content)
  if (language === 'yaml') return validateYaml(content)
  return { diagnostics: [], isValid: true }
}

const editorHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--cm-property)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string)' },
  { tag: tags.number, color: 'var(--cm-number)' },
  { tag: [tags.bool, tags.null, tags.atom], color: 'var(--cm-bool)' },
  { tag: tags.keyword, color: 'var(--cm-bool)' },
  { tag: tags.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: tags.labelName, color: 'var(--cm-property)' },
  { tag: tags.typeName, color: 'var(--cm-property)' },
  { tag: tags.punctuation, color: 'var(--cm-punctuation)' },
  { tag: tags.operator, color: 'var(--cm-punctuation)' },
])

const editorTheme = (isMobile: boolean, isDarkTheme: boolean) =>
  EditorView.theme(
    {
      '&': {
        height: '100%',
        '--cm-bg': isDarkTheme ? '#080e1d' : '#ffffff',
        '--cm-panel-bg': isDarkTheme ? '#0f172a' : '#f8fafc',
        '--cm-fg': isDarkTheme ? '#c0caf5' : '#0f172a',
        '--cm-caret': isDarkTheme ? '#c0caf5' : '#0f172a',
        '--cm-selection': isDarkTheme ? '#2d4f8e' : '#dbeafe',
        '--cm-selection-match': isDarkTheme ? '#1e3a5f' : '#bfdbfe',
        '--cm-gutter': isDarkTheme ? '#3b4261' : '#94a3b8',
        '--cm-gutter-active': isDarkTheme ? '#a9b1d6' : '#475569',
        '--cm-fold': isDarkTheme ? '#565f89' : '#64748b',
        '--cm-fold-placeholder-bg': isDarkTheme ? '#283457' : '#eff6ff',
        '--cm-fold-placeholder-border': isDarkTheme ? '#7aa2f7' : '#93c5fd',
        '--cm-fold-placeholder-text': isDarkTheme ? '#7aa2f7' : '#2563eb',
        '--cm-border': isDarkTheme ? '#334155' : '#cbd5e1',
        '--cm-property': isDarkTheme ? '#7aa2f7' : '#2563eb',
        '--cm-string': isDarkTheme ? '#9ece6a' : '#15803d',
        '--cm-number': isDarkTheme ? '#ff9e64' : '#ea580c',
        '--cm-bool': isDarkTheme ? '#bb9af7' : '#7c3aed',
        '--cm-comment': isDarkTheme ? '#565f89' : '#64748b',
        '--cm-punctuation': isDarkTheme ? '#89ddff' : '#0f766e',
        backgroundColor: 'var(--cm-bg)',
        color: 'var(--cm-fg)',
        fontSize: isMobile ? '13px' : '14px',
      },
      '.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
        scrollbarWidth: 'thin',
        backgroundColor: 'var(--cm-bg)',
      },
      '.cm-content': {
        caretColor: 'var(--cm-caret)',
        padding: '8px 0 16px 0',
      },
      '.cm-line': { padding: '0 4px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--cm-caret)' },
      '.cm-selectionBackground': { backgroundColor: 'var(--cm-selection) !important' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--cm-selection) !important' },
      '.cm-selectionMatch, .cm-searchMatch': { backgroundColor: 'var(--cm-selection-match)' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--cm-gutter-active)' },
      '.cm-lineNumbers': { minWidth: '3ch !important' },
      '.cm-lineNumbers .cm-gutterElement': { minWidth: '3ch !important', textAlign: 'right' },
      '.cm-gutters': {
        display: isMobile ? 'none' : 'flex',
        backgroundColor: 'var(--cm-bg)',
        color: 'var(--cm-gutter)',
        border: 'none',
      },
      '.cm-foldGutter': { width: '14px', cursor: 'pointer', color: 'var(--cm-fold)' },
      '.cm-foldGutter .cm-gutterElement:hover': { color: 'var(--cm-gutter-active)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--cm-fold-placeholder-bg)',
        borderColor: 'var(--cm-fold-placeholder-border)',
        color: 'var(--cm-fold-placeholder-text)',
      },
      '.cm-diagnosticText': { fontFamily: 'var(--font-mono)' },
      '.cm-panels': {
        backgroundColor: 'var(--cm-panel-bg)',
        color: 'var(--cm-fg)',
      },
      '.cm-tooltip': { backgroundColor: 'var(--cm-panel-bg)', color: 'var(--cm-fg)', border: '1px solid var(--cm-border)' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--cm-selection)' },
    },
    { dark: isDarkTheme }
  )

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
      basicSetup,
      autocompletion({ override: [completeAnyWord] }),
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
      EditorState.allowMultipleSelections.of(true),
      keymap.of([
        {
          key: 'Mod-s',
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
        ...foldKeymapCmd,
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
    []
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
        view.dispatch({
          changes: {
            from: clamp(from, 0, max),
            to: clamp(to, 0, max),
            insert: text,
          },
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
    </div>
  )
})

CodeMirrorEditor.displayName = 'CodeMirrorEditor'
