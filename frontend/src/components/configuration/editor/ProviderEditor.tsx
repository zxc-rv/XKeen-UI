import { indentWithTab } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { setDiagnostics } from '@codemirror/lint'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { editorHighlight, editorTheme, getLanguageExtension } from './highlighting'
import { SearchPanel } from './search/SearchPanel'
import { createSearchExtension } from './search/searchExtension'
import { baseSetup } from './setup'
import { useEditorSearch } from './useEditorSearch'
import { validateYaml } from './validation'

export type ProviderEditorLanguage = 'yaml' | 'text'

interface Props {
  content: string
  language: ProviderEditorLanguage
  onChange: (value: string) => void
  onSave: () => void
  onValidationChange: (error?: string) => void
}

function validateView(view: EditorView, language: ProviderEditorLanguage) {
  const { diagnostics, error } = language === 'yaml' ? validateYaml(view.state.doc.toString()) : { diagnostics: [], error: undefined }
  view.dispatch(setDiagnostics(view.state, diagnostics))
  return error
}

export function ProviderEditor({ content, language, onChange, onSave, onValidationChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartmentRef = useRef(new Compartment())
  const latestRef = useRef({ language, onChange, onSave, onValidationChange })
  latestRef.current = { language, onChange, onSave, onValidationChange }
  const [initialContent] = useState(content)
  const { searchPanel, bridge } = useEditorSearch(viewRef)

  useEffect(() => {
    if (!containerRef.current) return

    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          ...baseSetup,
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-s',
                scope: 'editor search-panel',
                run: () => {
                  latestRef.current.onSave()
                  return true
                },
              },
            ])
          ),
          keymap.of([indentWithTab]),
          EditorView.lineWrapping,
          createSearchExtension(bridge),
          lineNumbers({ formatNumber: (lineNumber) => String(lineNumber).padStart(3, '\u00a0') }),
          indentationMarkers(),
          syntaxHighlighting(editorHighlight),
          languageCompartmentRef.current.of(getLanguageExtension(latestRef.current.language)),
          editorTheme(window.innerWidth < 768, document.documentElement.classList.contains('dark')),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            latestRef.current.onChange(update.state.doc.toString())
            latestRef.current.onValidationChange(validateView(update.view, latestRef.current.language))
          }),
        ],
      }),
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [initialContent, bridge])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: languageCompartmentRef.current.reconfigure(getLanguageExtension(language)) })
    latestRef.current.onValidationChange(validateView(view, language))
  }, [language])

  return (
    <div ref={containerRef} className="h-full w-full">
      {searchPanel && createPortal(<SearchPanel handle={searchPanel} />, searchPanel.dom)}
    </div>
  )
}
