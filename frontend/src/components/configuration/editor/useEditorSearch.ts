import { openSearchPanel } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { SearchBridge, SearchPanelHandle } from './search/searchExtension'

export function useEditorSearch(viewRef: RefObject<EditorView | null>) {
  const [searchPanel, setSearchPanel] = useState<SearchPanelHandle | null>(null)
  const bridgeRef = useRef<SearchBridge>({
    open: (handle) => setSearchPanel(handle),
    close: (handle) => setSearchPanel((previous) => (previous === handle ? null : previous)),
  })

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const hasModifier = event.metaKey || event.ctrlKey
      if (!hasModifier || event.altKey || event.shiftKey || event.code !== 'KeyF' || event.defaultPrevented) return
      if (!viewRef.current) return
      event.preventDefault()
      openSearchPanel(viewRef.current)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [viewRef])

  return { searchPanel, bridge: bridgeRef.current }
}
