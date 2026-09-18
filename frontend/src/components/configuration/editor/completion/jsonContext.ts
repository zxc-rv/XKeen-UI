import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

/** Context resolved at the cursor, shared by the JSON and YAML resolvers. */
export interface ResolvedContext {
  readonly kind: 'key' | 'value'
  /** Path from the schema root; array items are always `'*'`. */
  readonly path: readonly string[]
  /** Range of the token being completed (replaced on accept). */
  readonly from: number
  readonly to: number
  /** Whether the token sits inside an already-open quoted string. */
  readonly quoted: boolean
  /** Regex `CompletionResult.validFor` should use to keep the popup open while typing. */
  readonly validFor: RegExp
  /** Sibling keys already present in the container being completed (key context only). */
  readonly existingKeys: ReadonlySet<string>
  /** Reads a sibling key's value written elsewhere in the document, for `oneOf` resolution. */
  readonly getSibling: (depth: number, key: string) => string | undefined
}

const BARE_TOKEN_RE = /[\w.-]*$/
const BARE_TOKEN_FORWARD_RE = /^[\w.-]*/
const QUOTED_VALID_FOR = /^[^"\n]*$/
const BARE_VALID_FOR = /^[\w.-]*$/
const TRIVIA_LOOKBACK = 4000
const TRIVIA_MAX_STEPS = 20

function readQuoted(text: string): string {
  return text.startsWith('"') ? text.replace(/^"|"$/g, '') : text
}

/** Scans `[from, to)` for a `//` line-comment start that is not inside a `"..."` string. */
function findLineCommentStart(text: string, from: number, to: number): number {
  const slice = text.slice(from, to)
  let quoted = false
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]
    if (quoted) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === '/' && slice[i + 1] === '/') return from + i
  }
  return -1
}

/** True when `pos` falls inside a `/* ... *‍/` block comment, using a bounded lookback window. */
function isInsideBlockComment(doc: EditorState['doc'], pos: number): boolean {
  const start = Math.max(0, pos - TRIVIA_LOOKBACK)
  const text = doc.sliceString(start, pos)
  const lastOpen = text.lastIndexOf('/*')
  const lastClose = text.lastIndexOf('*/')
  return lastOpen !== -1 && lastOpen > lastClose
}

/** Scans the current line's text up to `pos` for quote/comment state (single-line only). */
function scanLine(before: string): { quoted: boolean; lineComment: boolean; stringStart: number } {
  let quoted = false
  let stringStart = -1
  for (let i = 0; i < before.length; i++) {
    const ch = before[i]
    if (quoted) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === '"') {
        quoted = false
        stringStart = -1
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      stringStart = i
      continue
    }
    if (ch === '/' && before[i + 1] === '/') return { quoted: false, lineComment: true, stringStart: -1 }
  }
  return { quoted, lineComment: false, stringStart }
}

function scanForwardQuote(lineText: string, from: number): number {
  for (let i = from; i < lineText.length; i++) {
    if (lineText[i] === '\\') {
      i++
      continue
    }
    if (lineText[i] === '"') return i
  }
  return -1
}

/** Walks backward past whitespace and comments (bounded), returning the position right after the last real character. */
function skipTrivia(doc: EditorState['doc'], pos: number): number {
  let p = pos
  for (let step = 0; step < TRIVIA_MAX_STEPS; step++) {
    const winStart = Math.max(0, p - TRIVIA_LOOKBACK)
    const chunk = doc.sliceString(winStart, p)
    const wsLen = /\s*$/.exec(chunk)![0].length
    if (wsLen) {
      p -= wsLen
      continue
    }
    if (chunk.endsWith('*/')) {
      const openIdx = chunk.slice(0, -2).lastIndexOf('/*')
      if (openIdx === -1) break
      p = winStart + openIdx
      continue
    }
    const line = doc.lineAt(p)
    const commentAt = findLineCommentStart(doc.sliceString(line.from, line.to), 0, p - line.from)
    if (commentAt !== -1) {
      p = line.from + commentAt
      continue
    }
    break
  }
  return p
}

function findAncestor(node: SyntaxNode | null, names: readonly string[]): SyntaxNode | null {
  let n = node
  while (n && !names.includes(n.name)) n = n.parent
  return n
}

function readPropertyName(state: EditorState, node: SyntaxNode): string {
  return readQuoted(state.doc.sliceString(node.from, node.to))
}

/** Root-to-`container` path (array items = `'*'`) plus the Object/Array nodes passed through. */
function pathToContainer(state: EditorState, container: SyntaxNode): { path: string[]; containers: SyntaxNode[] } {
  const chain: SyntaxNode[] = [container]
  let cur: SyntaxNode = container
  while (cur.parent && cur.parent.name !== 'JsonText') {
    cur = cur.parent
    chain.unshift(cur)
  }
  const path: string[] = []
  const containers: SyntaxNode[] = []
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i]
    const nextChild = chain[i + 1]
    if (node.name === 'Object' || node.name === 'Array') containers.push(node)
    if (node.name === 'Array' && nextChild) path.push('*')
    if (node.name === 'Property' && nextChild) {
      const nameNode = node.getChild('PropertyName')
      if (nameNode) path.push(readPropertyName(state, nameNode))
    }
  }
  return { path, containers }
}

function makeGetSibling(state: EditorState, containers: readonly SyntaxNode[]): (depth: number, key: string) => string | undefined {
  return (depth, key) => {
    const node = containers[depth]
    if (!node || node.name !== 'Object') return undefined
    for (const child of node.getChildren('Property')) {
      const nameNode = child.getChild('PropertyName')
      if (!nameNode || readPropertyName(state, nameNode) !== key) continue
      const valueNode = child.lastChild
      if (!valueNode) return undefined
      if (valueNode.name === 'String') return readQuoted(state.doc.sliceString(valueNode.from, valueNode.to))
      if (valueNode.name === 'True') return 'true'
      if (valueNode.name === 'False') return 'false'
      if (valueNode.name === 'Number') return state.doc.sliceString(valueNode.from, valueNode.to)
      return undefined
    }
    return undefined
  }
}

function collectExistingKeys(state: EditorState, container: SyntaxNode, from: number, to: number): Set<string> {
  const keys = new Set<string>()
  for (const child of container.getChildren('Property')) {
    const nameNode = child.getChild('PropertyName')
    if (!nameNode) continue
    if (nameNode.from <= to && nameNode.to >= from) continue // the token being edited itself
    keys.add(readPropertyName(state, nameNode))
  }
  return keys
}

/**
 * Resolves the schema-completion context at `pos` in a JSONC document. Returns `null` inside
 * comments, or when the cursor is not in a key/value/item position CodeMirror can complete.
 */
export function resolveJsonContext(state: EditorState, pos: number): ResolvedContext | null {
  const doc = state.doc
  if (isInsideBlockComment(doc, pos)) return null

  const line = doc.lineAt(pos)
  const before = line.text.slice(0, pos - line.from)
  const scan = scanLine(before)
  if (scan.lineComment) return null

  let from: number
  let to: number
  const quoted = scan.quoted
  if (quoted) {
    from = line.from + scan.stringStart + 1
    const closeRel = scanForwardQuote(line.text, pos - line.from)
    to = closeRel === -1 ? line.to : line.from + closeRel
  } else {
    const back = BARE_TOKEN_RE.exec(before)![0]
    const rest = line.text.slice(pos - line.from)
    const fwd = BARE_TOKEN_FORWARD_RE.exec(rest)![0]
    from = pos - back.length
    to = pos + fwd.length
  }

  const anchor = quoted ? from - 1 : from
  if (anchor <= 0) return null
  const trivialPos = skipTrivia(doc, anchor)
  if (trivialPos <= 0) return null

  const charBefore = doc.sliceString(trivialPos - 1, trivialPos)
  if (charBefore !== '{' && charBefore !== ',' && charBefore !== '[' && charBefore !== ':') return null

  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state)
  const validFor = quoted ? QUOTED_VALID_FOR : BARE_VALID_FOR

  if (charBefore === ':') {
    const leaf = tree.resolveInner(trivialPos - 1, 1)
    const property = findAncestor(leaf, ['Property'])
    const nameNode = property?.getChild('PropertyName')
    if (!property || !nameNode) return null
    const name = readPropertyName(state, nameNode)
    const parentContainer = property.parent ? findAncestor(property.parent, ['Object', 'Array']) : null
    const { path, containers } = parentContainer ? pathToContainer(state, parentContainer) : { path: [], containers: [] }
    return {
      kind: 'value',
      path: [...path, name],
      from,
      to,
      quoted,
      validFor,
      existingKeys: new Set(),
      getSibling: makeGetSibling(state, containers),
    }
  }

  const leaf = tree.resolveInner(trivialPos - 1, 1)
  const container = findAncestor(leaf, ['Object', 'Array'])
  if (!container) return null
  const { path, containers } = pathToContainer(state, container)

  if (container.name === 'Object') {
    return {
      kind: 'key',
      path,
      from,
      to,
      quoted,
      validFor,
      existingKeys: collectExistingKeys(state, container, from, to),
      getSibling: makeGetSibling(state, containers),
    }
  }

  return {
    kind: 'value',
    path: [...path, '*'],
    from,
    to,
    quoted,
    validFor,
    existingKeys: new Set(),
    getSibling: makeGetSibling(state, containers),
  }
}
