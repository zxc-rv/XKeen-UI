import { isMap, isScalar, parseDocument } from 'yaml'

export const MIHOMO_SECTION_KEYS = ['rules', 'rule-providers', 'proxy-groups', 'proxies', 'proxy-providers', 'dns', 'sniffer', 'anchors'] as const

export type MihomoSectionKey = (typeof MIHOMO_SECTION_KEYS)[number]

export function getMihomoSections(source: string): MihomoSectionKey[] {
  try {
    const document = parseDocument(source, { keepSourceTokens: true })
    if (!isMap(document.contents)) return []
    const keys = new Set(
      document.contents.items.flatMap((pair) =>
        isScalar(pair.key) && typeof pair.key.value === 'string' ? [pair.key.value] : []
      )
    )
    return MIHOMO_SECTION_KEYS.filter((key) => keys.has(key))
  } catch {
    return []
  }
}

/** Returns the one-based line of a root-level section key for editor navigation. */
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
