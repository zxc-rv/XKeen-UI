import type { Diagnostic } from '@codemirror/lint'
import * as jsyaml from 'js-yaml'
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser'
import type { EditorLanguage } from './types'

export interface ValidationResult {
  diagnostics: Diagnostic[]
  isValid: boolean
  error?: string
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function offsetToLine(content: string, offset: number) {
  return content.slice(0, clamp(offset, 0, content.length)).split('\n').length
}

function lineColumnToOffset(content: string, line: number, column: number) {
  const lines = content.split('\n')
  let offset = 0
  for (let i = 0; i < Math.max(0, line - 1) && i < lines.length; i++) offset += lines[i].length + 1
  return clamp(offset + Math.max(0, column - 1), 0, content.length)
}

function validateJson(content: string): ValidationResult {
  const errors: ParseError[] = []
  parseJsonc(content, errors, {
    disallowComments: false,
  })
  if (!errors.length) return { diagnostics: [], isValid: true }

  const first = errors[0]
  const from = clamp(first.offset, 0, content.length)
  const parsedTo = clamp(first.offset + Math.max(first.length, 1), 0, content.length)
  const to = parsedTo > from ? parsedTo : from
  const message = `${printParseErrorCode(first.error)
    .replace(/([A-Z])/g, ' $1')
    .trim()} [строка ${offsetToLine(content, from)}]`
    .replace(/([A-Z])/g, ' $1')
    .trim()
  return {
    diagnostics: [{ from, to, severity: 'error', message }],
    isValid: false,
    error: message,
  }
}

export function validateYaml(content: string): ValidationResult {
  try {
    jsyaml.load(content)
    return { diagnostics: [], isValid: true }
  } catch (error) {
    const yamlError = error as {
      message: string
      reason?: string
      mark?: { line: number; column: number }
    }
    const line = yamlError.mark ? yamlError.mark.line + 1 : 1
    const column = yamlError.mark ? yamlError.mark.column + 1 : 1
    const from = lineColumnToOffset(content, line, column)
    const lineEnd = content.indexOf('\n', from)
    const to = lineEnd === -1 ? content.length : lineEnd
    const message = yamlError.mark ? `${yamlError.reason || yamlError.message} [строка ${line}]` : yamlError.message
    return {
      diagnostics: [{ from, to, severity: 'error', message }],
      isValid: false,
      error: message,
    }
  }
}

export function validateByLanguage(content: string, language: EditorLanguage): ValidationResult {
  if (language === 'json') return validateJson(content)
  if (language === 'yaml') return validateYaml(content)
  return { diagnostics: [], isValid: true }
}
