import type { Completion } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import { useProxiesStore } from '../../../../lib/store'

interface RuleField {
  from: number
  to: number
  value: string
}

function ruleFieldsAtLine(state: EditorState, pos: number): { type: string; fields: RuleField[] } | null {
  const line = state.doc.lineAt(pos)
  const prefix = /^[ \t]*-[ \t]*/u.exec(line.text)
  if (!prefix) return null

  const fields: RuleField[] = []
  const contentStart = prefix[0].length
  let fieldStart = contentStart
  let depth = 0
  let quote = ''
  let escaped = false

  for (let index = contentStart; index < line.text.length; index++) {
    const character = line.text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') depth++
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth === 0) {
      fields.push(createField(line.from, line.text, fieldStart, index))
      fieldStart = index + 1
    }
  }
  fields.push(createField(line.from, line.text, fieldStart, line.text.length))

  const type = fields[0]?.value ?? ''
  const fieldIndex = fields.findIndex((field) => pos >= field.from && pos <= field.to)
  if (!type || fieldIndex < 0 || !isRuleListSection(state, line.number)) return null

  return { type, fields }
}

function createField(lineFrom: number, lineText: string, start: number, end: number): RuleField {
  const raw = lineText.slice(start, end)
  const leading = raw.length - raw.trimStart().length
  const value = raw.trim()
  const from = lineFrom + start + leading
  return { from, to: from + value.length, value }
}

function isRuleListSection(state: EditorState, lineNumber: number): boolean {
  let ruleListIndent: number | null = null
  for (let number = 1; number <= lineNumber; number++) {
    const text = state.doc.line(number).text
    if (!text.trim() || /^[ \t]*#/u.test(text)) continue
    const indent = /^[ \t]*/u.exec(text)?.[0].length ?? 0
    const section = /^([ \t]*)rules:[ \t]*(?:#.*)?$/iu.exec(text)
    if (section) {
      ruleListIndent = section[1].length
      continue
    }
    if (ruleListIndent !== null && indent <= ruleListIndent) ruleListIndent = null
    if (number === lineNumber) return ruleListIndent !== null && indent > ruleListIndent && /^[ \t]*-[ \t]*/u.test(text)
  }
  return false
}

function configuredSelectorOptions(state: EditorState): Completion[] {
  const names = new Set<string>()
  let inProxyGroups = false
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber++) {
    const text = state.doc.line(lineNumber).text
    const section = /^([\w-]+):[ \t]*(?:#.*)?$/u.exec(text)
    if (section) {
      inProxyGroups = section[1] === 'proxy-groups'
      continue
    }
    if (!inProxyGroups) continue

    const match = /^[ \t]*-[ \t]*name[ \t]*:[ \t]*(.*?)[ \t]*$/u.exec(text)
      ?? /^[ \t]+name[ \t]*:[ \t]*(.*?)[ \t]*$/u.exec(text)
    if (!match) continue
    const raw = (match[1] ?? '').replace(/[ \t]+#.*/u, '').trim()
    const quoted = /^(?:"([\s\S]*)"|'([\s\S]*)')$/u.exec(raw)
    const name = (quoted?.[1] ?? quoted?.[2] ?? raw).trim()
    if (name) names.add(name)
  }

  const proxies = useProxiesStore.getState().proxies as Record<string, { icon?: string; type?: string } | undefined>
  if (names.size === 0) {
    const selectorTypes = new Set(['Selector', 'Fallback', 'URLTest', 'LoadBalance', 'Smart'])
    for (const [name, proxy] of Object.entries(proxies)) {
      if (proxy?.type && selectorTypes.has(proxy.type)) names.add(name)
    }
  }

  return [...names].map((label, index) => ({ label, type: 'selector-target', sortText: String(index + 2).padStart(4, '0') }))
}

function ruleTargetOptions(state: EditorState): Completion[] {
  return [
    { label: 'DIRECT', type: 'rule-target', sortText: '0000' },
    { label: 'REJECT', type: 'rule-target', sortText: '0001' },
    ...configuredSelectorOptions(state),
  ]
}

export function mihomoRuleTargetOptionsAt(
  state: EditorState,
  pos: number,
): { from: number; to: number; options: Completion[]; validFor: RegExp } | null {
  const parsed = ruleFieldsAtLine(state, pos)
  if (!parsed || /^(?:NOT|OR|AND)$/iu.test(parsed.type)) return null

  const targetIndex = parsed.type.toUpperCase() === 'MATCH' ? 1 : 2
  const target = parsed.fields[targetIndex]
  if (!target || pos < target.from || pos > target.to) return null

  const options = ruleTargetOptions(state)
  if (!options.length) return null
  return { from: target.from, to: target.to, options, validFor: /^[^,\s]*$/u }
}

export function isMihomoRuleTargetStart(state: EditorState, pos: number): boolean {
  const context = mihomoRuleTargetOptionsAt(state, pos)
  return !!context && context.from === context.to && context.from === pos
}
