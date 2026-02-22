import { useEffect, useRef, forwardRef, useImperativeHandle } from "react"
import type * as Monaco from "monaco-editor"
import { getFileLanguage } from "../lib/api"

declare global {
  interface Window {
    monaco: typeof Monaco
    require: any
    MonacoEnvironment: any
    prettier: any
    prettierPlugins: any
    LOCAL: boolean
    jsyaml: any
  }
}

export interface MonacoEditorRef {
  getValue: () => string
  setValue: (value: string, newSavedContent?: string) => void
  setSavedContent: (content: string) => void
  setLanguage: (language: string) => void
  validate: (filename: string) => void
  format: () => void
  layout: () => void
  isValid: (filename: string) => boolean
  getEditor: () => Monaco.editor.IStandaloneCodeEditor | null
}

interface Props {
  onContentChange: (content: string, isDirty: boolean) => void
  onValidationChange: (isValid: boolean, error?: string) => void
  onReady?: () => void
}

const THEME: Monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "string.key.json", foreground: "7aa2f7" },
    { token: "string.value.json", foreground: "9ece6a" },
    { token: "number.json", foreground: "ff9e64" },
    { token: "number.yaml", foreground: "ff9e64" },
    { token: "keyword.json", foreground: "bb9af7" },
    { token: "keyword.yaml", foreground: "bb9af7" },
    { token: "comment", foreground: "565f89" },
    { token: "string.yaml", foreground: "9ece6a" },
    { token: "type.yaml", foreground: "7aa2f7" },
  ],
  colors: {
    "editor.background": "#080e1d",
    "editor.foreground": "#c0caf5",
    "editorLineNumber.foreground": "#3b4261",
    "editorLineNumber.activeForeground": "#a9b1d6",
    "editorCursor.foreground": "#c0caf5",
    "editor.selectionBackground": "#364a82",
    "editor.inactiveSelectionBackground": "#292e42",
    "editorBracketMatch.border": "#7aa2f7",
    "editorBracketMatch.background": "#283457",
    "editorGutter.modifiedBackground": "#7aa2f7",
    "editorGutter.addedBackground": "#9ece6a",
    "editorGutter.deletedBackground": "#f7768e",
  },
}

export const MonacoEditor = forwardRef<MonacoEditorRef, Props>(({ onContentChange, onValidationChange, onReady }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  const onContentChangeRef = useRef(onContentChange)
  const onValidationChangeRef = useRef(onValidationChange)
  const onReadyRef = useRef(onReady)
  const savedContentRef = useRef("")
  const filenameRef = useRef("")
  const suppressRef = useRef(false)

  onContentChangeRef.current = onContentChange
  onValidationChangeRef.current = onValidationChange
  onReadyRef.current = onReady

  useImperativeHandle(ref, () => ({
    getValue: () => editorRef.current?.getValue() ?? "",
    setValue: (value: string, newSavedContent?: string) => {
      if (!editorRef.current) return
      suppressRef.current = true
      if (newSavedContent !== undefined) savedContentRef.current = newSavedContent
      editorRef.current.setValue(value)
      suppressRef.current = false
    },
    setSavedContent: (content: string) => {
      savedContentRef.current = content
    },
    setLanguage: (language: string) => {
      if (editorRef.current) window.monaco?.editor.setModelLanguage(editorRef.current.getModel()!, language)
      filenameRef.current = language
    },
    validate: (filename: string) => {
      filenameRef.current = filename
      if (!editorRef.current) return
      runValidation(editorRef.current, filename)
    },
    format: () => editorRef.current?.getAction("editor.action.formatDocument")?.run(),
    layout: () => editorRef.current?.layout(),
    isValid: (fname: string) => {
      if (!editorRef.current) return false
      const lang = getFileLanguage(fname)
      if (lang === "json") {
        const model = editorRef.current.getModel()
        if (!model) return true
        const markers = window.monaco?.editor.getModelMarkers({ owner: "json" }) ?? []
        return !markers.some((m) => m.resource.toString() === model.uri.toString() && m.severity === window.monaco.MarkerSeverity.Error)
      }
      if (lang === "yaml") {
        try {
          window.jsyaml?.load(editorRef.current.getValue())
          return true
        } catch {
          return false
        }
      }
      return true
    },
    getEditor: () => editorRef.current,
  }))

  useEffect(() => {
    if (!containerRef.current || !window.monaco) return
    window.monaco.editor.defineTheme("tokyo-night", THEME)

    const isMobile = window.innerWidth < 768
    const editor = window.monaco.editor.create(containerRef.current, {
      value: "",
      language: "json",
      theme: "tokyo-night",
      automaticLayout: true,
      scrollBeyondLastLine: false,
      minimap: { enabled: !isMobile, showSlider: "always" },
      fontSize: isMobile ? 13 : 14,
      fontFamily: '"JetBrains Mono", monospace, "Noto Color Emoji"',
      fontWeight: "400",
      smoothScrolling: true,
      lineHeight: 1.5,
      renderLineHighlight: "none",
      tabSize: 2,
      insertSpaces: true,
      wordWrap: "off",
      folding: !isMobile,
      lineNumbers: isMobile ? "off" : "on",
      glyphMargin: false,
      stickyScroll: { enabled: false },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      scrollbar: { vertical: "hidden", horizontal: "hidden", verticalScrollbarSize: 0, useShadows: false },
      quickSuggestions: !isMobile,
      suggestOnTriggerCharacters: !isMobile,
      accessibilitySupport: isMobile ? "off" : "auto",
    })

    editorRef.current = editor
    registerFormatters()

    window.monaco?.editor.onDidChangeMarkers((uris) => {
      if (getFileLanguage(filenameRef.current) !== "json") return
      const model = editor.getModel()
      if (!model || !uris.some((u) => u.toString() === model.uri.toString())) return
      const markers = window.monaco.editor.getModelMarkers({ owner: "json", resource: model.uri })
      const err = markers.find((m) => m.severity === window.monaco.MarkerSeverity.Error)
      onValidationChangeRef.current(!err, err?.message)
    })

    editor.onDidChangeModelContent(() => {
      if (suppressRef.current) return
      const content = editor.getValue()
      const isDirty = content !== savedContentRef.current
      onContentChangeRef.current(content, isDirty)
      if (getFileLanguage(filenameRef.current) === "yaml") runValidation(editor, filenameRef.current)
    })

    onReadyRef.current?.()
    return () => editor.dispose()
  }, [])

  function runValidation(editor: Monaco.editor.IStandaloneCodeEditor, filename: string) {
    const lang = getFileLanguage(filename)
    if (lang === "yaml") {
      try {
        window.jsyaml?.load(editor.getValue())
        window.monaco?.editor.setModelMarkers(editor.getModel()!, "yaml", [])
        onValidationChangeRef.current(true)
      } catch (e: any) {
        const line = e.mark ? e.mark.line + 1 : 1
        const col = e.mark ? e.mark.column + 1 : 1
        const msg = e.mark ? `${e.reason || e.message} [строка ${line}]` : e.message
        window.monaco?.editor.setModelMarkers(editor.getModel()!, "yaml", [
          {
            severity: window.monaco.MarkerSeverity.Error,
            message: msg,
            startLineNumber: line,
            startColumn: col,
            endLineNumber: line,
            endColumn: 999,
          },
        ])
        onValidationChangeRef.current(false, msg)
      }
    } else if (lang === "json") {
      setTimeout(() => {
        const model = editor.getModel()
        if (!model) return
        const markers = window.monaco?.editor.getModelMarkers({ owner: "json", resource: model.uri }) ?? []
        const err = markers.find((m) => m.severity === window.monaco.MarkerSeverity.Error)
        onValidationChangeRef.current(!err, err?.message)
      }, 300)
    } else {
      onValidationChangeRef.current(true)
    }
  }

  function registerFormatters() {
    window.monaco?.languages.registerDocumentFormattingEditProvider("json", {
      async provideDocumentFormattingEdits(model) {
        try {
          const text = await window.prettier.format(model.getValue(), {
            parser: "json",
            plugins: [window.prettierPlugins.babel, window.prettierPlugins.estree],
            semi: false,
            trailingComma: "none",
            printWidth: 120,
            endOfLine: "lf",
          })
          return [
            {
              range: model.getFullModelRange(),
              text: text
                .replace(/\n{3,}/g, "\n\n")
                .replace(/\s+$/gm, "")
                .replace(/\n$/, ""),
            },
          ]
        } catch {
          return []
        }
      },
    })
    window.monaco?.languages.registerDocumentFormattingEditProvider("yaml", {
      async provideDocumentFormattingEdits(model) {
        try {
          const text = await window.prettier.format(model.getValue(), {
            parser: "yaml",
            plugins: [window.prettierPlugins.yaml],
            printWidth: 200,
            tabWidth: 2,
            singleQuote: true,
            endOfLine: "lf",
          })
          return [{ range: model.getFullModelRange(), text }]
        } catch {
          return []
        }
      },
    })
  }

  return (
    <div className="absolute inset-4 rounded-md overflow-hidden border border-border bg-input-background">
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
})

MonacoEditor.displayName = "MonacoEditor"
