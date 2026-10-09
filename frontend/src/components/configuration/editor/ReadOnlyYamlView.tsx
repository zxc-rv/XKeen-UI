import { syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { editorHighlight, editorTheme, getLanguageExtension } from './highlighting'
import { SearchPanel } from './search/SearchPanel'
import { createSearchExtension } from './search/searchExtension'
import { useEditorSearch } from './useEditorSearch'

interface Props {
  content: string
  language?: 'yaml' | 'text'
}

export function ReadOnlyYamlView({ content, language = 'yaml' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const { searchPanel, bridge } = useEditorSearch(viewRef)

  useEffect(() => {
    if (!containerRef.current) return

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          createSearchExtension(bridge, { replace: false }),
          lineNumbers({ formatNumber: (lineNumber) => String(lineNumber).padStart(3, '\u00a0') }),
          indentationMarkers(),
          syntaxHighlighting(editorHighlight),
          getLanguageExtension(language),
          editorTheme(window.innerWidth < 768, document.documentElement.classList.contains('dark')),
        ],
      }),
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [content, language, bridge])

  return (
    <div ref={containerRef} className="h-full w-full">
      {searchPanel && createPortal(<SearchPanel handle={searchPanel} replaceEnabled={false} />, searchPanel.dom)}
    </div>
  )
}
