import { jsonLanguage } from '@codemirror/lang-json'
import { yamlLanguage } from '@codemirror/lang-yaml'
import { ensureSyntaxTree, HighlightStyle, indentService, LanguageSupport, syntaxTree } from '@codemirror/language'
import { Prec, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { completionThemeSpec } from './completion'
import { searchThemeSpec } from './search/searchExtension'
import type { EditorLanguage } from './types'

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

export function getLanguageExtension(language: EditorLanguage): Extension {
  if (language === 'yaml') return [new LanguageSupport(yamlLanguage), yamlScalarDecorator, yamlFlatIndent]
  if (language === 'json') return jsoncExtension
  return []
}

export const editorHighlight = HighlightStyle.define([
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

export const editorTheme = (isMobile: boolean, isDarkTheme: boolean) =>
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
        fontFeatureSettings: '"calt" 0',
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
        zIndex: 1,
      },
      '.cm-tooltip': { backgroundColor: 'var(--cm-panel-bg)', color: 'var(--cm-fg)', border: '1px solid var(--cm-border)', zIndex: 40 },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: 'var(--menu-active-bg)',
        color: '#60a5fa',
        fontWeight: '600',
      },
      ...searchThemeSpec(isDarkTheme),
      ...completionThemeSpec,
    },
    { dark: isDarkTheme }
  )
