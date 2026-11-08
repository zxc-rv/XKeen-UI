import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLMap, type YAMLSeq } from 'yaml'

function getString(node: unknown): string | undefined {
  if (!isScalar(node) || node.value == null) return undefined
  return String(node.value)
}

function inheritedValue(doc: Document, map: YAMLMap, key: string, seen = new Set<YAMLMap>()): unknown {
  if (seen.has(map)) return undefined
  seen.add(map)
  const own = map.get(key, true)
  if (own !== undefined) return own
  const merge = map.get('<<', true)
  const sources = isSeq(merge) ? merge.items : [merge]
  for (const source of sources) {
    const resolved = isAlias(source) ? source.resolve(doc) : source
    if (!isMap(resolved)) continue
    const value = inheritedValue(doc, resolved, key, seen)
    if (value !== undefined) return value
  }
  return undefined
}

function cloneWithoutAnchors<T extends YAMLMap | YAMLSeq>(doc: Document, node: T): T {
  const copy = node.clone(doc.schema) as T
  visit(copy, {
    Node(_, child) {
      if (isMap(child) || isSeq(child) || isScalar(child)) child.anchor = undefined
    },
  })
  return copy
}

function rootMap(doc: Document): YAMLMap {
  if (!isMap(doc.contents)) throw new Error('Корень YAML-конфигурации должен быть объектом')
  return doc.contents
}

function resolveAlias(doc: Document, value: unknown): unknown {
  return isAlias(value) ? value.resolve(doc) : value
}

export function getRuleProvidersInterval(content: string): number | undefined {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) throw new Error(`Не удалось разобрать YAML: ${doc.errors[0].message}`)
  const root = rootMap(doc)
  const providers = resolveAlias(doc, root.get('rule-providers', true))
  if (!isMap(providers)) return undefined

  let commonInterval: number | undefined
  for (const pair of providers.items) {
    const name = getString(pair.key)
    if (!name) continue
    const provider = resolveAlias(doc, providers.get(name, true))
    if (!isMap(provider) || getString(inheritedValue(doc, provider, 'type')) === 'inline') continue
    const rawInterval = inheritedValue(doc, provider, 'interval')
    const interval = resolveAlias(doc, rawInterval)
    const value = isScalar(interval) && typeof interval.value === 'number' ? interval.value : 86400
    if (commonInterval !== undefined && commonInterval !== value) return undefined
    commonInterval = value
  }
  return commonInterval
}

export function setRuleProvidersInterval(content: string, intervalSeconds: number): string {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60) throw new Error('Интервал должен быть не меньше 60 секунд')
  const doc = parseDocument(content)
  if (doc.errors.length > 0) throw new Error(`Не удалось разобрать YAML: ${doc.errors[0].message}`)
  const root = rootMap(doc)
  const rawProviders = root.get('rule-providers', true)
  const resolvedProviders = resolveAlias(doc, rawProviders)
  if (!isMap(resolvedProviders)) throw new Error('В конфигурации нет раздела rule-providers')

  let providers = resolvedProviders
  if (isAlias(rawProviders)) {
    providers = cloneWithoutAnchors(doc, providers)
    root.set('rule-providers', providers)
  }

  let changed = 0
  const updatedAnchors = new Set<YAMLMap>()
  for (const pair of providers.items) {
    const name = getString(pair.key)
    if (!name) continue
    const rawProvider = providers.get(name, true)
    const resolvedProvider = resolveAlias(doc, rawProvider)
    if (!isMap(resolvedProvider) || getString(inheritedValue(doc, resolvedProvider, 'type')) === 'inline') continue

    let provider = resolvedProvider
    if (isAlias(rawProvider)) {
      provider = cloneWithoutAnchors(doc, provider)
      providers.set(name, provider)
    }

    const merge = provider.get('<<', true)
    const sources = isSeq(merge) ? merge.items : [merge]
    const httpAnchors = sources
      .map((source) => resolveAlias(doc, source))
      .filter((source): source is YAMLMap => isMap(source) && getString(inheritedValue(doc, source, 'type')) === 'http')

    if (httpAnchors.length > 0) {
      for (const anchor of httpAnchors) {
        if (!updatedAnchors.has(anchor)) {
          anchor.set('interval', intervalSeconds)
          updatedAnchors.add(anchor)
        }
      }
      provider.delete('interval')
    } else {
      provider.set('interval', intervalSeconds)
    }
    changed += 1
  }

  if (changed === 0) throw new Error('В конфигурации нет обновляемых провайдеров правил')
  return doc.toString({ lineWidth: 0 })
}
