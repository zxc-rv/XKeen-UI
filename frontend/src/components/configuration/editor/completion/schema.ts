/**
 * Schema model for context-aware autocompletion (Xray JSON / Mihomo YAML configs).
 *
 * Build trees with the helpers below instead of object literals, so the shape stays consistent:
 *
 *   obj(keys, ...oneOfs)              — object with known `keys`; `oneOfs` (from `by()`) add
 *                                        discriminator-dependent keys on top
 *   arr(items, detail?)               — array of `items` (path segment for an item is `'*'`)
 *   str(values?, detail?)             — string leaf, optional enum
 *   bool(detail?)                     — boolean leaf (offers `true`/`false`)
 *   num(detail?)                      — number leaf (never offers completions)
 *   any(detail?)                      — untyped leaf (never offers completions)
 *   map(values, detail?)              — object with arbitrary keys, all shaped like `values`
 *   by(discriminator, cases, common?) — one entry for `obj()`'s `oneOf` list: `discriminator` is
 *                                        a sibling key name (e.g. `'protocol'`) or a list of
 *                                        alternative names (the first one present in the document
 *                                        wins, e.g. `['method', 'network']`), `cases` maps its
 *                                        value to the extra keys unlocked for that case, `common`
 *                                        keys (optional) are merged into every case
 *
 * Path convention: array items are always segment `'*'`; a `map()`'s arbitrary key does not need
 * to appear in the path (`lookupSchema` falls back to `wildcard` for any key not found in `keys`).
 *
 * `obj()` derives the discriminator's own enum from the case names automatically — e.g.
 * `obj({}, by('protocol', { vless: {...}, freedom: {...} }))` implies a `protocol` key of
 * `str(['vless', 'freedom'])` without spelling it out. An explicit `keys.protocol` overrides it.
 *
 * `lookupSchema(root, path, getSibling)` walks `path` from `root`, resolving `oneOf` at each
 * object node using `getSibling(depth, key)` — `depth` is how many path segments were already
 * consumed when that object was reached. Returns `undefined` once the path leaves the schema.
 *
 * `effectiveKeys(node, getSibling)` returns one object node's key map: plain `keys` merged with
 * the `oneOf` case selected by its discriminator's current sibling value, or the union of every
 * case's keys when the discriminator is missing/unrecognised (on a key name shared by more than
 * one case, the last case listed wins).
 *
 * `detailOf(node)` returns the short inline label shown next to a completion.
 */

export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'any'

export interface OneOfCase {
  readonly by: readonly string[]
  readonly cases: Readonly<Record<string, SchemaNode>>
}

export interface SchemaNode {
  readonly type: SchemaType
  readonly keys?: Readonly<Record<string, SchemaNode>>
  readonly items?: SchemaNode
  readonly values?: readonly string[]
  readonly detail?: string
  readonly oneOf?: readonly OneOfCase[]
  readonly wildcard?: SchemaNode
}

/** Reads a sibling key's already-written value at a given path depth (see `lookupSchema`). */
export type GetSibling = (depth: number, key: string) => string | undefined

export function obj(keys: Readonly<Record<string, SchemaNode>> = {}, ...oneOf: OneOfCase[]): SchemaNode {
  let merged = keys
  for (const entry of oneOf) {
    for (const name of entry.by) {
      if (merged[name]) continue
      if (merged === keys) merged = { ...keys }
      ;(merged as Record<string, SchemaNode>)[name] = str(Object.keys(entry.cases))
    }
  }
  return { type: 'object', keys: merged, oneOf: oneOf.length ? oneOf : undefined }
}

export function arr(items: SchemaNode, detail?: string): SchemaNode {
  return { type: 'array', items, detail }
}

export function str(values?: readonly string[], detail?: string): SchemaNode {
  return { type: 'string', values, detail }
}

export function bool(detail?: string): SchemaNode {
  return { type: 'boolean', detail }
}

export function num(detail?: string): SchemaNode {
  return { type: 'number', detail }
}

export function any(detail?: string): SchemaNode {
  return { type: 'any', detail }
}

export function map(values: SchemaNode, detail?: string): SchemaNode {
  return { type: 'object', wildcard: values, detail }
}

export function by(
  discriminator: string | readonly string[],
  cases: Readonly<Record<string, SchemaNode>>,
  common?: Readonly<Record<string, SchemaNode>>
): OneOfCase {
  const names = typeof discriminator === 'string' ? [discriminator] : discriminator
  if (!common) return { by: names, cases }
  const merged: Record<string, SchemaNode> = {}
  for (const [name, node] of Object.entries(cases)) {
    merged[name] = node.type === 'object' ? { ...node, keys: { ...common, ...node.keys } } : node
  }
  return { by: names, cases: merged }
}

function selectedCase(entry: OneOfCase, getSibling: (key: string) => string | undefined): SchemaNode | undefined {
  for (const name of entry.by) {
    const value = getSibling(name)
    if (value !== undefined) return entry.cases[value]
  }
  return undefined
}

export function lookupSchema(root: SchemaNode, path: readonly string[], getSibling: GetSibling): SchemaNode | undefined {
  let node: SchemaNode | undefined = root
  for (let depth = 0; depth < path.length; depth++) {
    if (!node) return undefined
    const segment = path[depth]
    if (node.type === 'array') {
      node = segment === '*' ? node.items : undefined
      continue
    }
    const keys = effectiveKeys(node, (key) => getSibling(depth, key))
    if (keys && Object.prototype.hasOwnProperty.call(keys, segment)) {
      node = keys[segment]
    } else {
      node = node.wildcard
    }
  }
  return node
}

export function effectiveKeys(node: SchemaNode, getSibling: (key: string) => string | undefined): Record<string, SchemaNode> | undefined {
  if (node.type !== 'object') return undefined
  if (!node.oneOf?.length) return node.keys ? { ...node.keys } : undefined
  const merged: Record<string, SchemaNode> = { ...node.keys }
  for (const entry of node.oneOf) {
    const matched = selectedCase(entry, getSibling)
    if (matched) {
      Object.assign(merged, matched.keys)
    } else {
      for (const candidate of Object.values(entry.cases)) Object.assign(merged, candidate.keys)
    }
  }
  return merged
}

/** Enum lists longer than this are shown as `enum` instead of being spelled out in the completion detail. */
const MAX_DETAIL_VALUES = 4

export function detailOf(node: SchemaNode): string | undefined {
  if (node.detail) return node.detail
  if (node.values?.length) return node.values.length > MAX_DETAIL_VALUES ? 'enum' : node.values.join(' | ')
  if (node.type === 'array') return 'array'
  if (node.type === 'object') return node.wildcard ? 'map' : 'object'
  if (node.type === 'boolean') return 'boolean'
  if (node.type === 'number') return 'number'
  return undefined
}
