import { openSearchPanel } from '@codemirror/search'
import type { EditorView } from '@codemirror/view'
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { SearchBridge, SearchPanelHandle } from './search/searchExtension'

const mountedViewRefs: RefObject<EditorView | null>[] = []

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
      if (mountedViewRefs.at(-1) !== viewRef || !viewRef.current) return
      event.preventDefault()
      openSearchPanel(viewRef.current)
    }
    mountedViewRefs.push(viewRef)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      mountedViewRefs.splice(mountedViewRefs.indexOf(viewRef), 1)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [viewRef])

  return { searchPanel, bridge: bridgeRef.current }
}
