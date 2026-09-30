import { syntaxHighlighting } from '@codemirror/language'
import { openSearchPanel } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { editorHighlight, editorTheme, getLanguageExtension } from './highlighting'
import { SearchPanel } from './search/SearchPanel'
import { createSearchExtension, type SearchBridge, type SearchPanelHandle } from './search/searchExtension'

interface Props {
  content: string
}

export function ReadOnlyYamlView({ content }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [searchPanel, setSearchPanel] = useState<SearchPanelHandle | null>(null)
  const bridgeRef = useRef<SearchBridge>({
    open: (handle) => setSearchPanel(handle),
    // A stale destroy must not clear a newer panel.
    close: (handle) => setSearchPanel((prev) => (prev === handle ? null : prev)),
  })

  useEffect(() => {
    if (!containerRef.current) return

    const isDarkTheme = document.documentElement.classList.contains('dark')
    const isMobile = window.innerWidth < 768

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          createSearchExtension(bridgeRef.current, { replace: false }),
          lineNumbers({ formatNumber: (n) => String(n).padStart(3, '\u00a0') }),
          indentationMarkers(),
          syntaxHighlighting(editorHighlight),
          getLanguageExtension('yaml'),
          editorTheme(isMobile, isDarkTheme),
        ],
      }),
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [content])

  useEffect(() => {
    // Ctrl+F outside the editor (e.g. on the dialog chrome) would open the browser's own
    // find bar — hijack it while this view is mounted. Inside the editor CM handles the key
    // first and marks the event as default-prevented.
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.altKey || event.shiftKey || event.code !== 'KeyF') return
      if (event.defaultPrevented) return
      const view = viewRef.current
      if (!view) return
      event.preventDefault()
      openSearchPanel(view)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div ref={containerRef} className="h-full w-full">
      {searchPanel && createPortal(<SearchPanel handle={searchPanel} replaceEnabled={false} />, searchPanel.dom)}
    </div>
  )
}
