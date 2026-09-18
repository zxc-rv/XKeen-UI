import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState, Text } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import type { ResolvedContext } from './jsonContext'

export type { ResolvedContext }

const VALUE_RE = /^(\s*)(- )?([\w.-]+):\s+(\S*)$/
const ITEM_RE = /^(\s*)- ([^\s,]*)$/
const KEY_RE = /^(\s*)(- )?([A-Za-z_][\w.-]*)?$/
const ANCESTOR_DASH_RE = /^(\s*)-\s/
const ANCESTOR_KEY_RE = /^(\s*)([A-Za-z_][\w.-]*):/
const BLOCK_PAIR_RE = /^\s*([A-Za-z_][\w.-]*):\s*(.*)$/
const INLINE_DASH_PAIR_RE = /^\s*-\s+([A-Za-z_][\w.-]*):\s*(.*)$/
const DASH_ONLY_RE = /^\s*-\s/
const DOCUMENT_MARKER_RE = /^---\s*$/
const BARE_VALID_FOR = /^[\w.-]*$/
const BLOCKED_NODE_NAMES = ['Comment', 'QuotedLiteral', 'FlowMapping', 'FlowSequence', 'BlockLiteral']

/** Hard cap on how many lines the upward/forward block scans will walk, however deep the file. */
const MAX_SCAN_LINES = 10000

interface YamlLevel {
  /** Line (1-based) where this block's own content starts — a `- ` line for a sequence item
   * (whose inline key, if any, lives on this exact line), or the first line after a `key:`
   * header otherwise. */
  startLine: number
  /** Column where this block's sibling keys/items are expected. */
  keyCol: number
  /** Column of the `-` marker when this level is a sequence-item mapping, else `null`. */
  dashCol: number | null
}

/** Line right after the nearest `---` document marker at or above `uptoLine`, or `1` if none. */
function findDocumentStart(doc: Text, uptoLine: number): number {
  for (let lineNo = uptoLine, steps = 0; lineNo >= 1 && steps < MAX_SCAN_LINES; lineNo--, steps++) {
    if (DOCUMENT_MARKER_RE.test(doc.line(lineNo).text)) return lineNo + 1
  }
  return 1
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isInBlockedNode(state: EditorState, pos: number): boolean {
  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state)
  let node: SyntaxNode | null = tree.resolveInner(pos, -1)
  while (node) {
    if (BLOCKED_NODE_NAMES.includes(node.name)) return true
    node = node.parent
  }
  return false
}

/**
 * Scans upward from `fromLine` by indentation to build the path from the schema root down to
 * the block that starts at `fromLine` (bounded by `MAX_SCAN_LINES`). `childCol` is the column at
 * which this block's own siblings/keys are expected; `hasDash`/`dashCol` describe whether
 * `fromLine` itself is a sequence-item line (its own `'*'` segment is seeded before scanning).
 */
function scanAncestors(
  doc: Text,
  fromLine: number,
  childCol: number,
  hasDash: boolean,
  dashCol: number | null
): { path: string[]; levels: YamlLevel[] } {
  const path: string[] = []
  const levels: YamlLevel[] = []
  let searchCol = childCol
  if (hasDash && dashCol !== null) {
    path.push('*')
    levels.push({ startLine: fromLine, keyCol: childCol, dashCol })
    searchCol = dashCol
  }

  let lineNo = fromLine - 1
  for (let steps = 0; lineNo >= 1 && searchCol > 0 && steps < MAX_SCAN_LINES; steps++, lineNo--) {
    const text = doc.line(lineNo).text
    if (!text.trim() || text.trimStart().startsWith('#')) continue
    if (DOCUMENT_MARKER_RE.test(text)) break

    const dashMatch = ANCESTOR_DASH_RE.exec(text)
    if (dashMatch && dashMatch[1].length < searchCol) {
      const dc = dashMatch[1].length
      path.unshift('*')
      levels.unshift({ startLine: lineNo, keyCol: searchCol, dashCol: dc })
      searchCol = dc
      continue
    }

    const keyMatch = ANCESTOR_KEY_RE.exec(text)
    if (keyMatch && keyMatch[1].length < searchCol) {
      path.unshift(keyMatch[2])
      levels.unshift({ startLine: lineNo + 1, keyCol: searchCol, dashCol: null })
      searchCol = keyMatch[1].length
      continue
    }
  }

  return { path, levels }
}

/** Visits `key: value` pairs of the block described by `level` (bounded, stops past its indent). */
function forEachBlockPair(doc: Text, level: YamlLevel, visit: (key: string, value: string) => boolean | void): void {
  if (level.dashCol !== null) {
    const inline = INLINE_DASH_PAIR_RE.exec(doc.line(level.startLine).text)
    if (inline && visit(inline[1], stripYamlScalar(inline[2])) === false) return
  }
  const firstLine = level.dashCol !== null ? level.startLine + 1 : level.startLine
  for (let lineNo = firstLine, steps = 0; lineNo <= doc.lines && steps < MAX_SCAN_LINES; lineNo++, steps++) {
    const text = doc.line(lineNo).text
    if (DOCUMENT_MARKER_RE.test(text)) break
    if (!text.trim() || text.trimStart().startsWith('#')) continue
    const indent = /^(\s*)/.exec(text)![1].length
    if (indent < level.keyCol) break
    if (indent > level.keyCol) continue
    const pair = BLOCK_PAIR_RE.exec(text)
    if (pair) {
      if (visit(pair[1], stripYamlScalar(pair[2])) === false) return
      continue
    }
    if (DASH_ONLY_RE.test(text)) break
  }
}

function collectBlockKeys(doc: Text, level: YamlLevel): Set<string> {
  const keys = new Set<string>()
  forEachBlockPair(doc, level, (key) => {
    keys.add(key)
  })
  return keys
}

function makeGetSibling(doc: Text, rootLevel: YamlLevel, levels: readonly YamlLevel[]): (depth: number, key: string) => string | undefined {
  const containers = [rootLevel, ...levels]
  return (depth, key) => {
    const level = containers[depth]
    if (!level) return undefined
    let found: string | undefined
    forEachBlockPair(doc, level, (k, v) => {
      if (k === key) {
        found = v
        return false
      }
    })
    return found
  }
}

/**
 * Resolves the schema-completion context at `pos` in a Mihomo YAML document, from the text up to
 * the cursor on its current line plus a bounded upward indentation scan. Returns `null` inside
 * comments, quoted scalars, flow collections or block literals.
 */
export function resolveYamlContext(state: EditorState, pos: number): ResolvedContext | null {
  if (isInBlockedNode(state, pos)) return null

  const doc = state.doc
  const line = doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  if (/(^|\s)#/.test(before)) return null

  const rootLevel: YamlLevel = { startLine: findDocumentStart(doc, line.number), keyCol: 0, dashCol: null }

  const valueMatch = VALUE_RE.exec(before)
  if (valueMatch) {
    const indent = valueMatch[1].length
    const hasDash = !!valueMatch[2]
    const key = valueMatch[3]
    const token = valueMatch[4]
    const { path, levels } = scanAncestors(doc, line.number, hasDash ? indent + 2 : indent, hasDash, hasDash ? indent : null)
    return {
      kind: 'value',
      path: [...path, key],
      from: pos - token.length,
      to: pos,
      quoted: false,
      validFor: BARE_VALID_FOR,
      existingKeys: new Set(),
      getSibling: makeGetSibling(doc, rootLevel, levels),
    }
  }

  const keyMatch = KEY_RE.exec(before)
  if (keyMatch) {
    const indent = keyMatch[1].length
    const hasDash = !!keyMatch[2]
    const token = keyMatch[3] ?? ''
    const { path, levels } = scanAncestors(doc, line.number, hasDash ? indent + 2 : indent, hasDash, hasDash ? indent : null)
    const container = levels.length ? levels[levels.length - 1] : rootLevel
    return {
      kind: 'key',
      path,
      from: pos - token.length,
      to: pos,
      quoted: false,
      validFor: BARE_VALID_FOR,
      existingKeys: collectBlockKeys(doc, container),
      getSibling: makeGetSibling(doc, rootLevel, levels),
    }
  }

  const itemMatch = ITEM_RE.exec(before)
  if (itemMatch) {
    const indent = itemMatch[1].length
    const token = itemMatch[2]
    const { path, levels } = scanAncestors(doc, line.number, indent + 2, true, indent)
    return {
      kind: 'value',
      path,
      from: pos - token.length,
      to: pos,
      quoted: false,
      validFor: BARE_VALID_FOR,
      existingKeys: new Set(),
      getSibling: makeGetSibling(doc, rootLevel, levels),
    }
  }

  return null
}
