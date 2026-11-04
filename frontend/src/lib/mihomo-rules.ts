import { Alias, isAlias, isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLMap, type YAMLSeq } from 'yaml'

export const MIHOMO_RULE_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-SUFFIX',
  'IP-ASN',
  'GEOIP',
  'SRC-GEOIP',
  'SRC-IP-ASN',
  'SRC-IP-CIDR',
  'SRC-IP-SUFFIX',
  'DST-PORT',
  'SRC-PORT',
  'IN-PORT',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'PROCESS-PATH',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME',
  'PROCESS-NAME-REGEX',
  'UID',
  'NETWORK',
  'DSCP',
] as const

export type MihomoRuleType = (typeof MIHOMO_RULE_TYPES)[number]
export type MihomoRuleOperation = 'rules' | 'inline' | 'rule-set' | 'payload' | 'provider-import'

export interface MihomoRuleProviderOption {
  name: string
  type: string
  behavior: string
  payloadCount: number
}

export interface MihomoRuleConfigOptions {
  groups: string[]
  groupIcons: Record<string, string>
  providers: MihomoRuleProviderOption[]
  hasRules: boolean
  rulesCount: number
  hasRootPayload: boolean
  rootPayloadCount: number
  error?: string
}

export interface AddMihomoRuleRequest {
  operation: MihomoRuleOperation
  ruleType?: MihomoRuleType
  value?: string
  providerName?: string
  target?: string
}

function getString(node: unknown): string | undefined {
  if (!isScalar(node) || node.value == null) return undefined
  return String(node.value)
}

function getCount(node: unknown): number {
  return isSeq(node) ? node.items.length : 0
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

export function inspectMihomoRuleConfig(content: string): MihomoRuleConfigOptions {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) {
    return {
      groups: [],
      groupIcons: {},
      providers: [],
      hasRules: false,
      rulesCount: 0,
      hasRootPayload: false,
      rootPayloadCount: 0,
      error: doc.errors[0].message,
    }
  }
  if (!isMap(doc.contents)) {
    return {
      groups: [],
      groupIcons: {},
      providers: [],
      hasRules: false,
      rulesCount: 0,
      hasRootPayload: false,
      rootPayloadCount: 0,
      error: 'Корень YAML-конфигурации должен быть объектом',
    }
  }

  const root = doc.contents
  const groupsNode = root.get('proxy-groups', true)
  const groupIcons: Record<string, string> = {}
  const groups = isSeq(groupsNode)
    ? groupsNode.items.flatMap((group) => {
        if (!isMap(group)) return []
        const name = getString(group.get('name', true))
        const icon = getString(inheritedValue(doc, group, 'icon'))
        if (name && icon) groupIcons[name] = icon
        return name ? [name] : []
      })
    : []

  const providersNode = root.get('rule-providers', true)
  const providers = isMap(providersNode)
    ? providersNode.items.flatMap(({ key, value }) => {
        const name = getString(key)
        if (!name || !isMap(value)) return []
        return [
          {
            name,
            type: getString(inheritedValue(doc, value, 'type')) ?? '',
            behavior: getString(inheritedValue(doc, value, 'behavior')) ?? 'classical',
            payloadCount: getCount(value.get('payload', true)),
          },
        ]
      })
    : []

  const rulesNode = root.get('rules', true)
  const payloadNode = root.get('payload', true)
  return {
    groups,
    groupIcons,
    providers,
    hasRules: isSeq(rulesNode),
    rulesCount: getCount(rulesNode),
    hasRootPayload: isSeq(payloadNode),
    rootPayloadCount: getCount(payloadNode),
  }
}

function asSequence(doc: Document, map: YAMLMap, key: string): YAMLSeq {
  const current = map.get(key, true)
  if (current !== undefined) {
    if (isSeq(current)) return current
    // YAML `payload:` (or `payload: null`) is parsed as a null scalar. Treat
    // it as an empty list so the first inline rule can initialize the payload.
    if (!isScalar(current) || current.value != null) throw new Error(`Раздел «${key}» должен быть списком YAML`)
  }
  const created = doc.createNode([])
  if (!isSeq(created)) throw new Error(`Не удалось создать список «${key}»`)
  map.set(key, created)
  return created
}

function prependUnique(doc: Document, seq: YAMLSeq, value: string): boolean {
  const exists = seq.items.some((item) => getString(item) === value)
  if (exists) return false
  seq.items.unshift(doc.createNode(value))
  return true
}

function insertRoutingRule(doc: Document, seq: YAMLSeq, value: string): void {
  if (seq.items.some((item) => getString(item) === value)) return
  const index = seq.items.findIndex((item) => {
    const fields = getString(item)
      ?.split(',')
      .map((field) => field.trim())
    return fields?.[0]?.toUpperCase() === 'RULE-SET'
      && /^quic(?:@[^,]+)?$/i.test(fields[1] ?? '')
      && /^REJECT(?:-DROP)?$/i.test(fields[2] ?? '')
  })
  seq.items.splice(index >= 0 ? index + 1 : 0, 0, doc.createNode(value))
}

function normalizeValue(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('Введите значение правила')
  if (/[\r\n,]/.test(normalized)) throw new Error('Значение должно быть одной строкой без запятых')
  return normalized
}

export function normalizeMihomoRuleValues(value: string, ruleType: MihomoRuleType): string[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) throw new Error('Введите значение правила')
  return [
    ...new Set(
      lines.map((line) => {
        let input = normalizeValue(line)
        if (ruleType === 'DOMAIN' || ruleType === 'DOMAIN-SUFFIX') {
          try {
            const url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`)
            if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error()
            input = url.hostname.replace(/^www\./i, '').toLowerCase()
          } catch {
            throw new Error(`Некорректный домен или URL: ${line}`)
          }
        }
        return input
      })
    ),
  ]
}

function providerFromUrl(doc: Document, link: string, suggestedName?: string): { name: string; node: YAMLMap } {
  const url = new URL(link)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Нужна HTTP или HTTPS ссылка')
  if (url.hostname.toLowerCase() === 'github.com') {
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length >= 5 && (segments[2] === 'blob' || segments[2] === 'raw')) {
      url.hostname = 'raw.githubusercontent.com'
      url.pathname = '/' + [...segments.slice(0, 2), ...segments.slice(3)].join('/')
      url.searchParams.delete('raw')
      link = url.toString()
    }
  }
  const path = decodeURIComponent(url.pathname)
  const filename = path.split('/').pop() ?? ''
  if (!/\.(mrs|yaml|yml|txt)$/i.test(filename)) throw new Error('Ссылка должна вести на файл .mrs, .yaml, .yml или .txt')
  const basename = suggestedName ?? filename.replace(/\.(mrs|yaml|yml|txt)$/i, '')
  if (!basename) throw new Error('Не удалось определить имя provider')
  const suffix = basename.match(/@(domain|ipcidr)$/i)?.[1]?.toLowerCase()
  const domainPath = /\/(geosite|domain)(\/|$)/i.test(path)
  const ipPath = /\/(geoip|ipcidr)(\/|$)/i.test(path)
  const pathBehavior = domainPath && !ipPath ? 'domain' : ipPath && !domainPath ? 'ipcidr' : undefined
  if (suffix && pathBehavior && suffix !== pathBehavior) throw new Error(`Суффикс имени противоречит пути ссылки: ${link}`)
  const behavior = suffix ?? pathBehavior
  if (!behavior)
    throw new Error(`Не удалось определить domain/ipcidr: ссылка должна содержать @domain, @ipcidr или путь geosite/geoip: ${link}`)
  const name = `${basename.replace(/@(domain|ipcidr)$/i, '')}@${behavior}`
  const format = /\.mrs$/i.test(filename) ? 'mrs' : /\.txt$/i.test(filename) ? 'text' : 'yaml'
  let anchorAvailable = false
  visit(doc, {
    Map(_, node) {
      if (node.anchor !== behavior) return
      const anchorBehavior = getString(node.get('behavior', true))
      const anchorFormat = getString(node.get('format', true)) ?? 'yaml'
      if (anchorBehavior === behavior && anchorFormat === format && getString(node.get('type', true)) === 'http') anchorAvailable = true
    },
  })
  const node: YAMLMap = doc.createNode(anchorAvailable ? { url: link } : { type: 'http', behavior, format, interval: 86400, url: link })
  if (!isMap(node)) throw new Error('Не удалось создать provider')
  if (anchorAvailable) {
    node.set('<<', new Alias(behavior))
    const merge = node.items.pop()!
    node.items.unshift(merge)
  }
  node.flow = true
  return { name, node }
}

function ensureTarget(target: string): string {
  const normalized = target.trim()
  if (!normalized) throw new Error('Выберите селектор')
  if (/[\r\n,]/.test(normalized)) throw new Error('Некорректное имя селектора')
  return normalized
}

function buildProviderPayloadRule(behavior: string, ruleType: MihomoRuleType, input: string): string {
  if (behavior === 'classical') return `${ruleType},${input}`
  if (behavior === 'domain') {
    if (ruleType === 'DOMAIN-SUFFIX') return `.${input.replace(/^\.+/, '')}`
    if (ruleType === 'DOMAIN') return input.replace(/^\.+/, '')
    throw new Error('Для provider с behavior: domain выберите DOMAIN или DOMAIN-SUFFIX')
  }
  if (behavior === 'ipcidr') {
    if (ruleType !== 'IP-CIDR' && ruleType !== 'IP-CIDR6') {
      throw new Error('Для provider с behavior: ipcidr выберите IP-CIDR или IP-CIDR6')
    }
    if (!input.includes('/')) throw new Error('Для IP-правила укажите сеть в формате CIDR')
    return input
  }
  throw new Error(`Неизвестный behavior rule-provider: ${behavior}`)
}

function ensureRootMap(doc: Document): YAMLMap {
  if (!isMap(doc.contents)) throw new Error('Корень YAML-конфигурации должен быть объектом')
  return doc.contents
}

function insertProviderBeforeInline(doc: Document, providers: YAMLMap, name: string, node: unknown): void {
  const inlineIndex = providers.items.findIndex(({ value }) =>
    isMap(value) && getString(inheritedValue(doc, value, 'type')) === 'inline'
  )
  if (inlineIndex < 0) {
    providers.set(name, node)
    return
  }
  providers.items.splice(inlineIndex, 0, doc.createPair(name, node))
}

function ensureRuleReference(doc: Document, providerName: string, target: string): void {
  const root = ensureRootMap(doc)
  const rules = asSequence(doc, root, 'rules')
  insertRoutingRule(doc, rules, `RULE-SET,${providerName},${target}`)
}

export function addMihomoRule(content: string, request: AddMihomoRuleRequest): string {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) throw new Error(`Не удалось разобрать YAML: ${doc.errors[0].message}`)
  const root = ensureRootMap(doc)

  if (request.operation === 'provider-import') {
    const raw = (request.value ?? '').trim()
    if (!raw) throw new Error('Вставьте ссылку или YAML-записи provider')
    let providers: unknown = root.get('rule-providers', true)
    if (providers === undefined) {
      providers = doc.createNode({})
      root.set('rule-providers', providers)
    }
    if (!isMap(providers)) throw new Error('rule-providers должен быть объектом')
    if (/^https?:\/\//i.test(raw)) {
      const urls = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      for (const link of urls) {
        const { name, node } = providerFromUrl(doc, link)
        if (providers.has(name)) throw new Error(`Provider «${name}» уже существует`)
        insertProviderBeforeInline(doc, providers, name, node)
      }
    } else {
      const body = raw.replace(/^rule-providers:\s*\n/, '')
      const lines = body.split(/\r?\n/)
      const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0))
      const importedDoc = parseDocument(
        content + '\n__import_rule_providers__:\n' + lines.map((line) => '  ' + line.slice(indent)).join('\n')
      )
      if (importedDoc.errors.length) throw new Error(importedDoc.errors[0].message)
      const imported = importedDoc.get('__import_rule_providers__', true)
      if (!isMap(imported) || !imported.items.length) throw new Error('Нужны YAML-записи с именем и url')
      for (const pair of imported.items) {
        const suppliedName = getString(pair.key)
        if (!suppliedName || !isMap(pair.value)) throw new Error('В каждой записи нужны имя и url')
        const link = getString(pair.value.get('url', true))
        if (!link) throw new Error('В каждой записи нужны имя и url')
        const { name, node } = providerFromUrl(doc, link, suppliedName)
        if (providers.has(name)) throw new Error(`Provider «${name}» уже существует`)
        insertProviderBeforeInline(doc, providers, name, node)
      }
    }
    return doc.toString({ lineWidth: 0 })
  }

  if (request.operation === 'rule-set') {
    const providerName = request.providerName?.trim()
    if (!providerName) throw new Error('Выберите rule-provider')
    const providers = root.get('rule-providers', true)
    const provider = isMap(providers) ? providers.get(providerName, true) : undefined
    if (!isMap(provider)) throw new Error(`Не найден rule-provider «${providerName}»`)
    const target = ensureTarget(request.target ?? '')
    ensureRuleReference(doc, providerName, target)
    return doc.toString({ lineWidth: 0 })
  }

  const ruleType = request.ruleType
  if (!ruleType) throw new Error('Выберите тип правила')
  const inputs = normalizeMihomoRuleValues(request.value ?? '', ruleType)

  if (request.operation === 'rules') {
    const target = ensureTarget(request.target ?? '')
    const rules = asSequence(doc, root, 'rules')
    for (const input of [...inputs].reverse()) insertRoutingRule(doc, rules, `${ruleType},${input},${target}`)
    return doc.toString({ lineWidth: 0 })
  }

  if (request.operation === 'payload') {
    const payload = asSequence(doc, root, 'payload')
    for (const input of [...inputs].reverse()) prependUnique(doc, payload, buildProviderPayloadRule('classical', ruleType, input))
    return doc.toString({ lineWidth: 0 })
  }

  const providerName = request.providerName?.trim()
  if (!providerName) throw new Error('Выберите inline rule-provider')
  const providerMap = root.get('rule-providers', true)
  if (!isMap(providerMap)) throw new Error('В конфигурации нет раздела rule-providers')
  const providerNode = providerMap.get(providerName, true)
  if (!isMap(providerNode)) throw new Error(`Не найден rule-provider «${providerName}»`)
  const providerType = getString(inheritedValue(doc, providerNode, 'type'))
  if (providerType !== 'inline') throw new Error(`Provider «${providerName}» не является inline`)
  const behavior = getString(inheritedValue(doc, providerNode, 'behavior')) ?? 'classical'
  const payload = asSequence(doc, providerNode, 'payload')
  for (const input of [...inputs].reverse()) prependUnique(doc, payload, buildProviderPayloadRule(behavior, ruleType, input))

  return doc.toString({ lineWidth: 0 })
}

export function findAddedMihomoRuleLines(before: string, after: string): { from: number; to: number } | undefined {
  const oldDoc = parseDocument(before)
  const newDoc = parseDocument(after)
  if (oldDoc.errors.length || newDoc.errors.length) return undefined
  const newItemOffsets = (oldNode: unknown, newNode: unknown): [number, number][] => {
    if (!isSeq(newNode)) return []
    const existing = new Set(isSeq(oldNode) ? oldNode.items.map(getString) : [])
    return newNode.items.flatMap(item => {
      if (existing.has(getString(item)) || !isScalar(item) || !item.range) return []
      return [[item.range[0], item.range[1]]]
    })
  }
  const rangesFor = (nodes: [number, number][]) => {
    if (!nodes.length) return undefined
    const start = Math.min(...nodes.map(([from]) => from))
    const end = Math.max(...nodes.map(([, to]) => to))
    const beforeStart = after.slice(0, start).split('\n').length
    const throughEnd = after.slice(0, end).split('\n').length
    return { from: beforeStart, to: throughEnd }
  }
  const rules = rangesFor(newItemOffsets(oldDoc.get('rules', true), newDoc.get('rules', true)))
  if (rules) return rules
  const rootPayload = rangesFor(newItemOffsets(oldDoc.get('payload', true), newDoc.get('payload', true)))
  if (rootPayload) return rootPayload

  const oldProviders = oldDoc.get('rule-providers', true)
  const newProviders = newDoc.get('rule-providers', true)
  if (isMap(newProviders)) {
    const addedRanges: [number, number][] = []
    for (const pair of newProviders.items) {
      const name = getString(pair.key)
      if (!name) continue
      const previous = isMap(oldProviders) ? oldProviders.get(name, true) : undefined
      if (!previous && isScalar(pair.key) && isMap(pair.value) && pair.value.range) {
        addedRanges.push([pair.value.range[0], pair.value.range[1]])
      } else if (isMap(pair.value)) {
        addedRanges.push(...newItemOffsets(isMap(previous) ? previous.get('payload', true) : undefined, pair.value.get('payload', true)))
      }
    }
    return rangesFor(addedRanges)
  }
  return undefined
}

