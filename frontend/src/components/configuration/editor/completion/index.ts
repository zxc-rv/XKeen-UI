import {
  acceptCompletion,
  autocompletion,
  CompletionContext,
  completionStatus,
  pickedCompletion,
  selectedCompletionIndex,
  setSelectedCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { EditorLanguage, ThemeSpec } from '../types'
import { jsonKeyInsertion, jsonValueInsertion, toTransactionSpec, yamlKeyInsertion, yamlValueInsertion } from './apply'
import { resolveJsonContext, type ResolvedContext } from './jsonContext'
import { MIHOMO_ROOT } from './mihomoSchema'
import { detailOf, effectiveKeys, lookupSchema, type SchemaNode } from './schema'
import { resolveYamlContext } from './yamlContext'
import { XRAY_ROOT } from './xraySchema'

export interface CompletionTarget {
  file: string
  language: EditorLanguage
}

function basename(file: string): string {
  const idx = file.lastIndexOf('/')
  return idx === -1 ? file : file.slice(idx + 1)
}

/** Which schema (if any) applies to a file, based on its language and name. `null` disables completion. */
function schemaForFile(file: string, language: EditorLanguage): SchemaNode | null {
  if (language === 'json') return basename(file) === 'xkeen.json' ? null : XRAY_ROOT
  if (language === 'yaml') return MIHOMO_ROOT
  return null
}

function isEnumTrigger(node: SchemaNode): boolean {
  return node.type === 'boolean' || !!node.oneOf?.length || (node.type === 'string' && (node.values?.length ?? 0) > 0)
}

function keyCompletion(language: EditorLanguage, ctx: ResolvedContext, key: string, node: SchemaNode): Completion {
  return {
    label: key,
    type: isEnumTrigger(node) ? 'key-enum' : 'key',
    detail: detailOf(node),
    apply(view, completion) {
      const insertion = language === 'json' ? jsonKeyInsertion(view.state, ctx, key) : yamlKeyInsertion(view.state, ctx, key, node)
      view.dispatch({ ...toTransactionSpec(insertion), annotations: pickedCompletion.of(completion) })
    },
  }
}

function valueCompletion(language: EditorLanguage, ctx: ResolvedContext, value: string, node: SchemaNode, order: number): Completion {
  return {
    label: value,
    type: 'value',
    // Keep the authored enum order (e.g. `true` before `false`) among equally scored options.
    sortText: String(order).padStart(3, '0'),
    // The enum list itself is the popup, so only an explicitly authored hint is worth showing here.
    detail: node.detail,
    apply(view, completion) {
      const insertion = language === 'json' ? jsonValueInsertion(view.state, ctx, value, node) : yamlValueInsertion(ctx, value)
      view.dispatch({ ...toTransactionSpec(insertion), annotations: pickedCompletion.of(completion) })
    },
  }
}

/** Value/enum options for a leaf schema node — never offered for plain strings, numbers, objects or arrays. */
function valueOptions(language: EditorLanguage, ctx: ResolvedContext, node: SchemaNode): Completion[] {
  if (node.type === 'boolean') return ['true', 'false'].map((v, i) => valueCompletion(language, ctx, v, node, i))
  if (node.type === 'string' && node.values?.length) return node.values.map((v, i) => valueCompletion(language, ctx, v, node, i))
  return []
}

function buildOptions(language: EditorLanguage, ctx: ResolvedContext, node: SchemaNode): Completion[] {
  if (ctx.kind === 'key' && node.type === 'object') {
    const keys = effectiveKeys(node, (key) => ctx.getSibling(ctx.path.length, key))
    if (!keys) return []
    const options: Completion[] = []
    for (const [key, child] of Object.entries(keys)) {
      if (ctx.existingKeys.has(key)) continue
      options.push(keyCompletion(language, ctx, key, child))
    }
    return options
  }
  // Either a value position, or a key position whose path resolved to a scalar (an array item
  // that turned out to hold a leaf value rather than a mapping, e.g. a Mihomo `rules` entry).
  return valueOptions(language, ctx, node)
}

/** Exported alongside `configAutocompletion` so the source itself can be exercised in tests. */
export function configCompletionSource(getTarget: () => CompletionTarget): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const { file, language } = getTarget()
    const root = schemaForFile(file, language)
    if (!root) return null

    const resolve = language === 'json' ? resolveJsonContext : language === 'yaml' ? resolveYamlContext : null
    if (!resolve) return null

    const ctx = resolve(context.state, context.pos)
    if (!ctx) return null

    const tokenText = context.state.sliceDoc(ctx.from, ctx.to)
    if (ctx.kind === 'key' && !ctx.quoted && tokenText === '' && !context.explicit) return null

    const node = lookupSchema(root, ctx.path, ctx.getSibling)
    if (!node) return null

    const options = buildOptions(language, ctx, node)
    if (!options.length) return null
    if (options.length === 1 && options[0].label === tokenText) return null

    return { from: ctx.from, to: ctx.to, options, validFor: ctx.validFor }
  }
}

function acceptOrFirstCompletion(view: EditorView): boolean {
  if (completionStatus(view.state) !== 'active') return false
  if (selectedCompletionIndex(view.state) === null) view.dispatch({ effects: setSelectedCompletion(0) })
  return acceptCompletion(view)
}

export function configAutocompletion(getTarget: () => CompletionTarget): Extension {
  return [
    autocompletion({
      override: [configCompletionSource(getTarget)],
      selectOnOpen: false,
      icons: false,
      activateOnTyping: true,
      closeOnBlur: true,
      defaultKeymap: true,
      maxRenderedOptions: 60,
      activateOnCompletion: (completion) => completion.type === 'key-enum',
    }),
    Prec.high(keymap.of([{ key: 'Tab', run: acceptOrFirstCompletion }])),
  ]
}

export const completionThemeSpec: ThemeSpec = {
  '.cm-tooltip.cm-tooltip-autocomplete': {
    borderRadius: '6px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    maxHeight: '16em',
    minWidth: '18ch',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    padding: '2px 8px',
  },
  '.cm-completionMatchedText': {
    color: 'var(--cm-property)',
    fontWeight: '600',
    textDecoration: 'none',
  },
  '.cm-completionDetail': {
    color: 'var(--cm-comment)',
    fontSize: '0.85em',
    marginLeft: '1em',
    fontStyle: 'normal',
  },
}
