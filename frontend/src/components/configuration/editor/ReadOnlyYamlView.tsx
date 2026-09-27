import { syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { useEffect, useRef } from 'react'
import { editorHighlight, editorTheme, getLanguageExtension } from './highlighting'

interface Props {
  content: string
}

export function ReadOnlyYamlView({ content }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

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
          lineNumbers({ formatNumber: (n) => String(n).padStart(3, '\u00a0') }),
          indentationMarkers(),
          syntaxHighlighting(editorHighlight),
          getLanguageExtension('yaml'),
          editorTheme(isMobile, isDarkTheme),
        ],
      }),
      parent: containerRef.current,
    })

    return () => view.destroy()
  }, [content])

  return <div ref={containerRef} className="h-full w-full" />
}
