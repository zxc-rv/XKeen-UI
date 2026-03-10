import { useEffect, useRef, useLayoutEffect, forwardRef, useImperativeHandle, useCallback } from 'react'
import { basicSetup } from 'codemirror'
import { lineNumbers } from '@codemirror/view'
import { foldKeymap as foldKeymapCmd } from '@codemirror/language'
import { EditorSelection, EditorState, Compartment, Prec, type Extension, RangeSetBuilder } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { indentWithTab, historyField } from '@codemirror/commands'
import {
  HighlightStyle,
  syntaxHighlighting,
  foldedRanges,
  foldEffect,
  unfoldEffect,
  LanguageSupport,
  syntaxTree,
  ensureSyntaxTree,
  indentService,
} from '@codemirror/language'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { tags } from '@lezer/highlight'
import { jsonLanguage } from '@codemirror/lang-json'
import { yamlLanguage } from '@codemirror/lang-yaml'
import { setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser'
import * as prettier from 'prettier'
import prettierBabel from 'prettier/plugins/babel'
import prettierEstree from 'prettier/plugins/estree'
import prettierYaml from 'prettier/plugins/yaml'
import * as jsyaml from 'js-yaml'
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

const boolDecoration = Decoration.mark({ attributes: { style: 'color: #bb9af7' } })
const nullDecoration = Decoration.mark({ attributes: { style: 'color: #bb9af7' } })
const numberDecoration = Decoration.mark({ attributes: { style: 'color: #ff9e64' } })

function buildYamlDecorations(view: EditorView): DecorationSet {
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 1000) ?? syntaxTree(view.state)
  const builder = new RangeSetBuilder<Decoration>()
  tree.iterate({
    enter(node) {
      if (node.name === 'QuotedLiteral') {
        builder.add(node.from, node.to, Decoration.mark({ attributes: { style: 'color: #9ece6a' } }))
      } else if (node.name === 'Literal') {
        const text = view.state.doc.sliceString(node.from, node.to)
        if (BOOL_RE.test(text)) builder.add(node.from, node.to, boolDecoration)
        else if (NULL_RE.test(text)) builder.add(node.from, node.to, nullDecoration)
        else if (NUMBER_RE.test(text)) builder.add(node.from, node.to, numberDecoration)
        else builder.add(node.from, node.to, Decoration.mark({ attributes: { style: 'color: #9ece6a' } }))
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

const commentDecoration = Decoration.mark({ attributes: { style: 'color: #565f89; font-style: italic' } })

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

const tokyoNightHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: '#7aa2f7' },
  { tag: [tags.string, tags.special(tags.string)], color: '#9ece6a' },
  { tag: tags.number, color: '#ff9e64' },
  { tag: [tags.bool, tags.null, tags.atom], color: '#bb9af7' },
  { tag: tags.keyword, color: '#bb9af7' },
  { tag: tags.comment, color: '#565f89', fontStyle: 'italic' },
  { tag: tags.labelName, color: '#7aa2f7' },
  { tag: tags.typeName, color: '#7aa2f7' },
  { tag: tags.punctuation, color: '#89ddff' },
  { tag: tags.operator, color: '#89ddff' },
])

const editorTheme = (isMobile: boolean) =>
  EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: '#080e1d',
        color: '#c0caf5',
        fontSize: isMobile ? '13px' : '14px',
      },
      '.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: 'var(--font-mono)',
        lineHeight: '1.5',
        scrollbarWidth: 'thin',
      },
      '.cm-content': {
        caretColor: '#c0caf5',
        padding: '8px 0 16px 0',
      },
      '.cm-line': { padding: '0 4px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#c0caf5' },
      '.cm-selectionBackground': { backgroundColor: '#2d4f8e' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: '#2d4f8e' },
      '.cm-selectionMatch': { backgroundColor: '#1e3a5f' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#a9b1d6' },
      '.cm-lineNumbers': { minWidth: '3ch' },
      '.cm-lineNumbers .cm-gutterElement': { minWidth: '3ch', textAlign: 'right' },
      '.cm-gutters': {
        display: isMobile ? 'none' : 'flex',
        backgroundColor: '#080e1d',
        color: '#3b4261',
        border: 'none',
      },
      '.cm-foldGutter': { width: '14px', cursor: 'pointer', color: '#565f89' },
      '.cm-foldGutter .cm-gutterElement:hover': { color: '#a9b1d6' },
      '.cm-foldPlaceholder': { backgroundColor: '#283457', borderColor: '#7aa2f7', color: '#7aa2f7' },
      '.cm-diagnosticText': { fontFamily: 'var(--font-mono)' },
      '.cm-panels': {
        backgroundColor: '#080e1d',
        color: '#c0caf5',
      },
      '.cm-indent-markers': {
        '--indent-marker-bg-color': '#1e2233',
        '--indent-marker-active-bg-color': '#2a3150',
      },
      '@media all and (hover:none)': {
        '.cm-content.cm-content, .cm-line.cm-line': {
          caretColor: '#ffffff !important',
        },
      },
    },
    { dark: true }
  )

export const CodeMirrorEditor = forwardRef<CodeMirrorRef, Props>(({ onContentChange, onValidationChange, onReady, onSave }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef(new Compartment())

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

  const format = useCallback(async () => {
    const view = viewRef.current
    if (!view) return
    const language = getLanguageFromFilename(filenameRef.current, languageRef.current)
    const content = view.state.doc.toString()
    if (!content.trim()) return

    try {
      let text = content
      if (language === 'json') {
        text = await prettier.format(content, {
          parser: 'json',
          plugins: [prettierBabel, prettierEstree],
          printWidth: 120,
          endOfLine: 'lf',
        })
        text = text
          .replace(/\n{3,}/g, '\n\n')
          .replace(/\s+$/gm, '')
          .replace(/\n$/, '')
      } else if (language === 'yaml') {
        text = await prettier.format(content, {
          parser: 'yaml',
          plugins: [prettierYaml],
          printWidth: 200,
          tabWidth: 2,
          singleQuote: true,
          endOfLine: 'lf',
        })
      } else {
        return
      }
      if (text === content) return

      const head = Math.min(view.state.selection.main.head, text.length)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: EditorSelection.cursor(head),
      })
      runValidation(view, filenameRef.current)
    } catch {
      /* ignore formatting errors */
    }
  }, [runValidation])

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
          view.setState(EditorState.fromJSON(json, { extensions: extensionsRef.current }, fields))
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
        view.dispatch({
          effects: EditorView.scrollIntoView(lineOffset, { y: 'center' }),
        })
      },
    }),
    [format, runValidation]
  )

  useEffect(() => {
    if (!containerRef.current) return

    const isMobile = window.innerWidth < 768
    const extensions: Extension[] = [
      basicSetup,
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
            void format()
            return true
          },
        },
        indentWithTab,
        ...foldKeymapCmd,
      ]),
      Prec.highest(syntaxHighlighting(tokyoNightHighlight)),
      languageCompartmentRef.current.of(getLanguageExtension(languageRef.current)),
      indentationMarkers({ hideFirstIndent: true, highlightActiveBlock: true }),
      editorTheme(isMobile),
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
        runValidation(update.view, filenameRef.current)
      }),
    ]
    extensionsRef.current = extensions
    const view = new EditorView({
      state: EditorState.create({ doc: '', extensions }),
      parent: containerRef.current,
    })
    viewRef.current = view
    const editorStyle = document.createElement('style')
    editorStyle.textContent =
      '.cm-scroller { overflow-y: scroll !important; } .cm-lineNumbers { min-width: 3ch !important; } .cm-lineNumbers .cm-gutterElement { min-width: 3ch !important; } .cm-selectionBackground { background-color: #2d4f8e !important; }'
    document.head.appendChild(editorStyle)
    document.fonts.ready.then(() => {
      view.requestMeasure()
      onReadyRef.current?.()
    })

    return () => {
      view.destroy()
      viewRef.current = null
      editorStyle.remove()
    } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runValidation])

  return (
    <div className="absolute inset-4 rounded-xl overflow-hidden border border-border bg-input-background">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
})

CodeMirrorEditor.displayName = 'CodeMirrorEditor'
