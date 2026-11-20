import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

export type MihomoSectionKey = string

export function getMihomoSections(source: string): MihomoSectionKey[] {
  try {
    const document = parseDocument(source, { keepSourceTokens: true })
    if (!isMap(document.contents)) return []
    return document.contents.items.flatMap((pair) => {
      const key = isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : null
      return key !== null && (isMap(pair.value) || isSeq(pair.value)) ? [key] : []
    })
  } catch {
    return []
  }
}

export function getMihomoSectionHeaderLine(source: string, key: MihomoSectionKey): number | null {
  try {
    const document = parseDocument(source, { keepSourceTokens: true })
    if (!isMap(document.contents)) return null

    const section = document.contents.items.find(
      (pair) => isScalar(pair.key) && typeof pair.key.value === 'string' && pair.key.value === key
    )
    const keyNode = section?.key
    const range = keyNode && typeof keyNode === 'object' && 'range' in keyNode ? keyNode.range : undefined
    const offset = Array.isArray(range) ? range[0] : undefined
    if (typeof offset !== 'number') return null

    return source.slice(0, offset).split(/\r?\n/u).length
  } catch {
    return null
  }
}
