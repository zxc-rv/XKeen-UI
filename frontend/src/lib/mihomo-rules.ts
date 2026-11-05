import { Alias, isAlias, isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLMap, type YAMLSeq } from 'yaml'

export const MIHOMO_RULE_TYPES = [
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'DOMAIN',
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

export type MihomoRuleType = (typeof MIHOMO_RULE_TYPES)[number] | 'AND' | 'OR' | 'NOT'
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
  groupName?: string
  insertionIndex?: number
}

function getString(node: unknown): string | undefined {
  if (!isScalar(node) || node.value == null) return undefined
  return String(node.value)
}

function getCount(node: unknown, doc?: Document): number {
  const resolved = doc && isAlias(node) ? node.resolve(doc) : node
  return isSeq(resolved) ? resolved.items.length : 0
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
  const resolvedProviders = isAlias(providersNode) ? providersNode.resolve(doc) : providersNode
  const providers = isMap(resolvedProviders)
    ? resolvedProviders.items.flatMap(({ key, value }) => {
        const name = getString(key)
        const provider = isAlias(value) ? value.resolve(doc) : value
        if (!name || !isMap(provider)) return []
        return [
          {
            name,
            type: getString(inheritedValue(doc, provider, 'type')) ?? '',
            behavior: getString(inheritedValue(doc, provider, 'behavior')) ?? 'classical',
            payloadCount: getCount(inheritedValue(doc, provider, 'payload'), doc),
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
    hasRootPayload:
      root.has('payload') && (isSeq(payloadNode) || isAlias(payloadNode) || (isScalar(payloadNode) && payloadNode.value == null)),
    rootPayloadCount: getCount(payloadNode, doc),
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

export function getMihomoRuleInsertionIndex(rules: string[], _target = ''): number {
  const rejectIndexes = rules.flatMap((raw, index) =>
    /^REJECT(?:-DROP)?$/i.test(describeMihomoRoutingRule(raw).target) ? [index] : []
  )
  return rejectIndexes.length ? rejectIndexes[rejectIndexes.length - 1] : 0
}

function insertRoutingRule(doc: Document, seq: YAMLSeq, value: string, groupName?: string): void {
  if (seq.items.some((item) => getString(item) === value)) return
  const node = doc.createNode(value)
  if (groupName) node.comment = ` xkeen-ui-group: ${groupName.replace(/[\r\n]/g, ' ').trim()}`
  seq.items.splice(getMihomoRuleInsertionIndex(seq.items.map((item) => getString(item) ?? ''), describeMihomoRoutingRule(value).target), 0, node)
}

export interface MihomoRoutingRule {
  raw: string
  type: string
  matcher: string
  target: string
}

export interface MihomoPayloadGroup {
  name: string
  rules: string[]
  behavior?: string
}

export interface MihomoRuleCondition {
  field: string
  value: string
}

export interface MihomoConditionNode {
  type: string
  value?: string
  children?: MihomoConditionNode[]
  options?: string[]
}

export function parseMihomoCondition(raw: string): MihomoConditionNode {
  const fields = splitRuleFields(raw)
  const type = fields[0].toUpperCase()
  if (['AND', 'OR', 'NOT'].includes(type)) {
    const body = fields[1] ?? ''
    if (!body.startsWith('(') || !body.endsWith(')')) throw new Error('Некорректные скобки условия')
    const children = splitRuleFields(body.slice(1, -1)).map((part) => {
      if (!part.startsWith('(') || !part.endsWith(')')) throw new Error('Некорректные скобки условия')
      return parseMihomoCondition(part.slice(1, -1))
    })
    const node = { type, children, options: fields.slice(2) }
    serializeMihomoCondition(node)
    return node
  }
  const node = { type, value: fields[1] ?? '', options: fields.slice(2) }
  serializeMihomoCondition(node)
  return node
}

export function serializeMihomoCondition(node: MihomoConditionNode): string {
  const type = node.type.toUpperCase()
  const flags = node.options ?? []
  if (flags.some((flag) => !['no-resolve', 'src'].includes(flag))) throw new Error('Неизвестные параметры условия')
  if (['AND', 'OR', 'NOT'].includes(type)) {
    const children = node.children ?? []
    if (!children.length || (type === 'NOT' && children.length !== 1)) throw new Error('NOT требует одно условие; AND/OR — хотя бы одно')
    return [type, `(${children.map((child) => `(${serializeMihomoCondition(child)})`).join(',')})`, ...flags].join(',')
  }
  if (![...MIHOMO_RULE_TYPES, 'RULE-SET'].includes(type as MihomoRuleType)) throw new Error('Неподдерживаемый тип условия')
  const value = node.value?.trim() ?? ''
  if (!value || /[\r\n,]/.test(value)) throw new Error('Введите значение условия в одну строку без запятых')
  return [type, value, ...flags].join(',')
}

export function summarizeMihomoCondition(raw: string): string {
  const format = (node: MihomoConditionNode): string => {
    if (node.type === 'NOT') return `NOT (${format(node.children![0])})`
    if (node.type === 'AND' || node.type === 'OR') {
      return node
        .children!.map((child) => {
          const text = format(child)
          return child.type === 'AND' || child.type === 'OR' ? `(${text})` : text
        })
        .join(node.type === 'AND' ? ' И ' : ' / ')
    }
    return `${node.type}: ${node.value}${node.options?.length ? ` [${node.options.join(', ')}]` : ''}`
  }
  const node = parseMihomoCondition(raw)
  return node.type === 'NOT' ? format(node.children![0]) : format(node)
}

export function insertMihomoRoutingRuleAt(content: string, index: number, raw: string): string {
  const doc = parseDocument(content)
  if (doc.errors.length) throw new Error(doc.errors[0].message)
  const rules = asSequence(doc, ensureRootMap(doc), 'rules')
  if (!Number.isInteger(index) || index < 0 || index > rules.items.length) throw new Error('Некорректная позиция правила')
  rules.items.splice(index, 0, doc.createNode(raw))
  return doc.toString({ lineWidth: 0 })
}

export function completeMihomoRoutingDraft(raw: string): string {
  const rule = describeMihomoRoutingRule(raw)
  if (!rule.matcher || !rule.target) throw new Error('Заполните значение и маршрут')
  ensureTarget(rule.target)
  if (['AND', 'OR', 'NOT'].includes(rule.type)) {
    return [serializeMihomoCondition(parseMihomoCondition(`${rule.type},${rule.matcher}`)), rule.target, ...getMihomoRuleOptions(raw)].join(
      ','
    )
  }
  return editMihomoRuleMatcher(raw, rule.type, rule.matcher)
}

function splitRuleFields(rule: string): string[] {
  const fields: string[] = []
  let start = 0
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = 0; index < rule.length; index++) {
    const char = rule[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === '(' || char === '[' || char === '{') {
      depth++
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1)
    } else if (char === ',' && depth === 0) {
      fields.push(rule.slice(start, index).trim())
      start = index + 1
    }
  }
  fields.push(rule.slice(start).trim())
  return fields
}

function getRuleTargetIndex(fields: string[]): number {
  const type = (fields[0] ?? '').toUpperCase()
  if (type === 'MATCH') return 1
  if (type === 'RULE-SET') return 2
  let index = fields.length - 1
  // A destination is required before flags. Do not confuse a proxy named
  // "src" or "no-resolve" with an option when it occupies that position.
  while (index > 2 && ['no-resolve', 'src'].includes(fields[index].toLowerCase())) {
    index--
  }
  return index
}

export function getMihomoRuleOptions(rule: string, payload = false): string[] {
  const fields = splitRuleFields(rule)
  if (payload) return fields.slice(2).every((field) => ['no-resolve', 'src'].includes(field.toLowerCase())) ? fields.slice(2) : []
  return fields.slice(getRuleTargetIndex(fields) + 1)
}

export function setMihomoRuleOptions(rule: string, options: string[]): string {
  if (options.some((option) => !['no-resolve', 'src'].includes(option))) throw new Error('Неизвестный параметр правила')
  const fields = splitRuleFields(rule)
  const targetIndex = getRuleTargetIndex(fields)
  if (targetIndex < 2 || !fields[targetIndex]) throw new Error('Не удалось определить маршрут правила')
  return [...fields.slice(0, targetIndex + 1), ...new Set(options)].join(',')
}

/** Edits a single condition without changing its destination or trailing options. */
export function editMihomoRuleMatcher(rule: string, type: string, matcher: string, payload = false, behavior = 'classical'): string {
  const value = matcher.trim()
  if (!value || /[\r\n]/.test(value)) throw new Error('Введите непустое значение в одну строку')
  if (!/^[A-Z][A-Z0-9-]*$/.test(type)) throw new Error('Некорректный тип правила')
  if (!['AND', 'OR', 'NOT', 'SUB-RULE'].includes(type) && value.includes(',')) throw new Error('Значение не должно содержать запятых')
  if (payload && behavior === 'domain') {
    if (type === 'DOMAIN-SUFFIX') {
      if (/^\+?\./.test(value)) return value
      return `${rule.startsWith('.') ? '.' : '+.'}${value}`
    }
    return value.replace(/^\+?\./, '')
  }
  if (payload && behavior === 'ipcidr') return value
  if (payload) return [type, value, ...getMihomoRuleOptions(rule, true)].join(',')
  const original = describeMihomoRoutingRule(rule)
  if (!original.target) throw new Error('Не удалось определить маршрут правила')
  return [type, value, original.target, ...getMihomoRuleOptions(rule)].join(',')
}

export function describeMihomoRoutingRule(rule: string): MihomoRoutingRule {
  const fields = splitRuleFields(rule)
  const type = fields[0] || 'RULE'
  const normalizedType = type.toUpperCase()
  const isComposite = ['AND', 'OR', 'NOT'].includes(normalizedType)
  const targetIndex = getRuleTargetIndex(fields)
  const matcher =
    isComposite || normalizedType === 'RULE-SET'
      ? fields.slice(1, targetIndex).join(', ')
      : fields.slice(1, Math.max(1, targetIndex)).join(', ')
  const target = fields[targetIndex] ?? ''
  return { raw: rule, type, matcher, target }
}

export function groupMihomoRoutingRules(
  rules: string[],
  comments: string[] = []
): { key: string; label: string; target: string; indices: number[]; subrule: boolean }[] {
  const groups = new Map<string, { key: string; label: string; target: string; indices: number[]; subrule: boolean }>()
  rules.forEach((raw, index) => {
    const rule = describeMihomoRoutingRule(raw)
    const type = rule.type.toUpperCase()
    const subrule = type === 'SUB-RULE'
    const name = comments[index]
      ?.split('\n')
      .find((line) => line.trim().startsWith('xkeen-ui-group:'))
      ?.trim()
      .slice('xkeen-ui-group:'.length)
      .trim()
    const key =
      type === 'MATCH' ? `MATCH:${index}` : subrule ? `SUB-RULE:${rule.target}` : `group:${name || rule.target}:route:${rule.target}`
    const group = groups.get(key)
    if (group) group.indices.push(index)
    else
      groups.set(key, {
        key,
        label: type === 'MATCH' ? 'Остальной трафик · MATCH' : name || rule.target || rule.type,
        target: rule.target,
        indices: [index],
        subrule,
      })
  })
  return [...groups.values()]
}

/** Move only the selected block; all other rules retain their relative priority. */
export function moveMihomoRuleGroup(count: number, indices: number[], beforeIndex: number): number[] {
  const selected = new Set(indices)
  if (
    !indices.length ||
    selected.size !== indices.length ||
    indices.some((index) => !Number.isInteger(index) || index < 0 || index >= count) ||
    !Number.isInteger(beforeIndex) ||
    beforeIndex < 0 ||
    beforeIndex > count ||
    selected.has(beforeIndex)
  )
    throw new Error('Некорректная позиция перемещения блока')
  const order = Array.from({ length: count }, (_, index) => index).filter((index) => !selected.has(index))
  const position = beforeIndex === count ? order.length : order.indexOf(beforeIndex)
  order.splice(position, 0, ...[...indices].sort((a, b) => a - b))
  return order
}

function stripOuterParentheses(value: string): string {
  let result = value.trim()
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0
    let quote = ''
    let escaped = false
    let closesAtEnd = false
    for (let index = 0; index < result.length; index++) {
      const char = result[index]
      if (quote) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === quote) quote = ''
        continue
      }
      if (char === '"' || char === "'") quote = char
      else if (char === '(') depth++
      else if (char === ')' && --depth === 0) {
        closesAtEnd = index === result.length - 1
        break
      }
    }
    if (!closesAtEnd) break
    result = result.slice(1, -1).trim()
  }
  return result
}

function collectMihomoRuleConditions(expression: string, depth = 0): MihomoRuleCondition[] {
  if (depth > 8) return []
  const normalized = stripOuterParentheses(expression)
  const fields = splitRuleFields(normalized)
  if (fields.length === 2 && /^[a-z0-9_-]+$/i.test(fields[0]) && fields[1]) {
    return [{ field: fields[0], value: fields[1] }]
  }
  return fields.flatMap((field) => collectMihomoRuleConditions(field, depth + 1))
}

export function getMihomoRuleConditions(rule: string, payload = false): MihomoRuleCondition[] {
  const fields = splitRuleFields(rule)
  if (!['AND', 'OR', 'NOT'].includes((fields[0] ?? '').toUpperCase())) return []
  return collectMihomoRuleConditions(fields.slice(1, payload ? undefined : getRuleTargetIndex(fields)).join(','))
}

function parseMihomoRulesDocument(content: string): { doc: Document; rules: YAMLSeq } {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) throw new Error(`Не удалось разобрать YAML: ${doc.errors[0].message}`)
  const root = ensureRootMap(doc)
  const node = root.get('rules', true)
  const rules = isAlias(node) ? node.resolve(doc) : node
  if (!isSeq(rules)) throw new Error('Раздел «rules» должен быть списком YAML')
  return { doc, rules }
}

export function getMihomoRoutingRules(content: string): string[] {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) throw new Error(`Не удалось разобрать YAML: ${doc.errors[0].message}`)
  const root = ensureRootMap(doc)
  const node = root.get('rules', true)
  if (node === undefined) return []
  const rules = isAlias(node) ? node.resolve(doc) : node
  if (isScalar(rules) && rules.value == null) return []
  if (!isSeq(rules)) throw new Error('Раздел «rules» должен быть списком YAML')
  return rules.items.map((item) => {
    if (!isScalar(item) || item.value == null) throw new Error('Правила в разделе «rules» должны быть строками')
    return String(item.value)
  })
}

export function getMihomoRoutingRuleComments(content: string): string[] {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) throw new Error(`Не удалось разобрать YAML: ${doc.errors[0].message}`)
  const root = ensureRootMap(doc)
  const node = root.get('rules', true)
  const rules = isAlias(node) ? node.resolve(doc) : node
  if (rules === undefined || (isScalar(rules) && rules.value == null)) return []
  if (!isSeq(rules)) throw new Error('Раздел «rules» должен быть списком YAML')
  return rules.items.map((item) => (isScalar(item) ? [item.commentBefore, item.comment].filter(Boolean).join('\n').trim() : ''))
}

export function getMihomoPayloadGroups(content: string): MihomoPayloadGroup[] {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) throw new Error(`Не удалось разобрать YAML: ${doc.errors[0].message}`)
  const root = ensureRootMap(doc)
  const groups: MihomoPayloadGroup[] = []
  const getPayloadRules = (node: unknown, source: string, includeEmpty = false): MihomoPayloadGroup | undefined => {
    const resolved = isAlias(node) ? node.resolve(doc) : node
    if (resolved === undefined || (isScalar(resolved) && resolved.value == null))
      return includeEmpty ? { name: source, rules: [] } : undefined
    if (!isSeq(resolved)) throw new Error(`Payload в «${source}» должен быть списком YAML`)
    const rules = resolved.items.map((item) => {
      if (!isScalar(item) || item.value == null) throw new Error(`Элементы payload в «${source}» должны быть строками`)
      return String(item.value)
    })
    return { name: source, rules }
  }

  const rootPayload = getPayloadRules(root.get('payload', true), 'payload', root.has('payload'))
  if (rootPayload) groups.push(rootPayload)

  const providersNode = root.get('rule-providers', true)
  const providers = isAlias(providersNode) ? providersNode.resolve(doc) : providersNode
  if (isMap(providers)) {
    for (const { key, value } of providers.items) {
      const name = getString(key)
      const provider = isAlias(value) ? value.resolve(doc) : value
      if (!name || !isMap(provider)) continue
      const payload = inheritedValue(doc, provider, 'payload')
      const inline = getString(inheritedValue(doc, provider, 'type')) === 'inline'
      if (payload === undefined && !inline) continue
      const group = getPayloadRules(payload, name, inline)
      if (group) groups.push({ ...group, behavior: getString(inheritedValue(doc, provider, 'behavior')) ?? 'classical' })
    }
  }
  return groups
}

export function describeMihomoPayloadRule(rule: string, behavior = 'classical'): MihomoRoutingRule {
  if (behavior === 'domain')
    return { raw: rule, type: rule.startsWith('.') || rule.startsWith('+.') ? 'DOMAIN-SUFFIX' : 'DOMAIN', matcher: rule, target: '' }
  if (behavior === 'ipcidr') return { raw: rule, type: rule.includes(':') ? 'IP-CIDR6' : 'IP-CIDR', matcher: rule, target: '' }
  const fields = splitRuleFields(rule)
  const options = getMihomoRuleOptions(rule, true)
  return { raw: rule, type: fields[0] || 'PAYLOAD', matcher: fields.slice(1, fields.length - options.length).join(', '), target: '' }
}

export function reorderMihomoRoutingRules(content: string, order: number[]): string {
  const { doc, rules } = parseMihomoRulesDocument(content)
  if (order.length !== rules.items.length) throw new Error('Не удалось переставить правила: изменился их список')
  if (order.some((index) => !Number.isInteger(index) || index < 0 || index >= rules.items.length) || new Set(order).size !== order.length) {
    throw new Error('Не удалось переставить правила: некорректный порядок')
  }
  if (order.every((index, position) => index === position)) return content
  const originalItems = [...rules.items]
  rules.items.splice(0, rules.items.length, ...order.map((index) => originalItems[index]))
  return doc.toString({ lineWidth: 0 })
}

export function updateMihomoRoutingRule(content: string, index: number, value: string): string {
  const { doc, rules } = parseMihomoRulesDocument(content)
  const current = rules.items[index]
  if (!current || !isScalar(current)) throw new Error('Не найдено правило для изменения')
  current.value = value
  return doc.toString({ lineWidth: 0 })
}

export function updateMihomoRoutingRuleTargets(content: string, indices: number[], target: string, groupName?: string): string {
  const normalizedTarget = ensureTarget(target)
  const { doc, rules } = parseMihomoRulesDocument(content)
  const uniqueIndices = [...new Set(indices)]
  if (!uniqueIndices.length || uniqueIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= rules.items.length)) {
    throw new Error('Не найдены правила для изменения маршрута')
  }
  for (const index of uniqueIndices) {
    const item = rules.items[index]
    if (!isScalar(item) || item.value == null) throw new Error('Правило должно быть строкой YAML')
    const fields = splitRuleFields(String(item.value))
    if (fields[0]?.toUpperCase() === 'SUB-RULE') throw new Error('SUB-RULE ссылается на подправило, а не на маршрут прокси')
    const targetIndex = getRuleTargetIndex(fields)
    if (targetIndex <= 0 || targetIndex >= fields.length) throw new Error('Не удалось определить маршрут правила')
    fields[targetIndex] = normalizedTarget
    item.value = fields.join(',')
    if (groupName && fields[0]?.toUpperCase() !== 'MATCH') {
      const otherComments = item.comment ? item.comment.split('\n').filter((line) => !line.trim().startsWith('xkeen-ui-group:')) : []
      item.comment = [...otherComments, ` xkeen-ui-group: ${groupName.replace(/[\r\n]/g, ' ').trim()}`].join('\n')
    }
  }
  return doc.toString({ lineWidth: 0 })
}

export function getMihomoRoutingTargets(content: string): string[] {
  const options = inspectMihomoRuleConfig(content)
  return [...new Set(['DIRECT', 'REJECT', ...options.groups])].filter((target) => target !== 'REJECT-DROP')
}

export function deleteMihomoRoutingRule(content: string, index: number): string {
  const { doc, rules } = parseMihomoRulesDocument(content)
  if (index < 0 || index >= rules.items.length) throw new Error('Не найдено правило для удаления')
  rules.items.splice(index, 1)
  return doc.toString({ lineWidth: 0 })
}

function clonePayloadOwner<T extends YAMLMap | YAMLSeq>(doc: Document, node: T): T {
  const copy = node.clone(doc.schema) as T
  // The original alias target stays in the document. Copies must not shadow
  // its anchors; existing alias references continue to refer to that source.
  visit(copy, {
    Node(_, child) {
      if (isMap(child) || isSeq(child) || isScalar(child)) child.anchor = undefined
    },
  })
  return copy
}

function parseMihomoPayloadSequence(doc: Document, name: string, createEmpty = false): YAMLSeq {
  const root = ensureRootMap(doc)
  let owner = root
  if (name !== 'payload') {
    const providerNode = root.get('rule-providers', true)
    const providersValue = isAlias(providerNode) ? providerNode.resolve(doc) : providerNode
    if (!isMap(providersValue)) throw new Error('В конфигурации нет раздела rule-providers')
    let providers: YAMLMap = providersValue
    if (isAlias(providerNode)) {
      providers = clonePayloadOwner(doc, providers)
      providers.anchor = undefined
      root.set('rule-providers', providers)
    }
    const rawProvider = providers.get(name, true)
    const providerValue = isAlias(rawProvider) ? rawProvider.resolve(doc) : rawProvider
    if (!isMap(providerValue)) throw new Error(`Не найден rule-provider «${name}»`)
    let provider: YAMLMap = providerValue
    if (isAlias(rawProvider)) {
      provider = clonePayloadOwner(doc, provider)
      provider.anchor = undefined
      providers.set(name, provider)
    }
    owner = provider
  }
  const ownPayload: unknown = owner.get('payload', true)
  const payload = inheritedValue(doc, owner, 'payload')
  const resolved = isAlias(payload) ? payload.resolve(doc) : payload
  if (createEmpty && (resolved === undefined || (isScalar(resolved) && resolved.value == null))) return asSequence(doc, owner, 'payload')
  if (!isSeq(resolved)) throw new Error(`Payload в «${name}» должен быть списком YAML`)
  if (ownPayload !== resolved || isAlias(payload)) {
    const copy = clonePayloadOwner(doc, resolved)
    copy.anchor = undefined
    owner.set('payload', copy)
    return copy
  }
  return resolved
}

export function updateMihomoPayloadRule(content: string, name: string, index: number, value: string): string {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) throw new Error(`Не удалось разобрать YAML: ${doc.errors[0].message}`)
  const rules = parseMihomoPayloadSequence(doc, name)
  const current = rules.items[index]
  if (!current || !isScalar(current)) throw new Error('Не найдено правило payload для изменения')
  const normalized = value.trim()
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error('Правило payload должно занимать одну непустую строку')
  current.value = normalized
  return doc.toString({ lineWidth: 0 })
}

export function deleteMihomoPayloadRule(content: string, name: string, index: number): string {
  const doc = parseDocument(content)
  if (doc.errors.length > 0) throw new Error(`Не удалось разобрать YAML: ${doc.errors[0].message}`)
  const rules = parseMihomoPayloadSequence(doc, name)
  if (index < 0 || index >= rules.items.length) throw new Error('Не найдено правило payload для удаления')
  rules.items.splice(index, 1)
  return doc.toString({ lineWidth: 0 })
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
        if (['AND', 'OR', 'NOT'].includes(ruleType))
          return serializeMihomoCondition(parseMihomoCondition(`${ruleType},${line}`)).slice(ruleType.length + 1)
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
  const inlineIndex = providers.items.findIndex(({ value }) => isMap(value) && getString(inheritedValue(doc, value, 'type')) === 'inline')
  if (inlineIndex < 0) {
    providers.set(name, node)
    return
  }
  providers.items.splice(inlineIndex, 0, doc.createPair(name, node))
}

function ensureRuleReference(doc: Document, providerName: string, target: string, groupName?: string): void {
  const root = ensureRootMap(doc)
  const rules = asSequence(doc, root, 'rules')
  insertRoutingRule(doc, rules, `RULE-SET,${providerName},${target}`, groupName)
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
    const rawProviders = root.get('rule-providers', true)
    const providers = isAlias(rawProviders) ? rawProviders.resolve(doc) : rawProviders
    const rawProvider = isMap(providers) ? providers.get(providerName, true) : undefined
    const provider = isAlias(rawProvider) ? rawProvider.resolve(doc) : rawProvider
    if (!isMap(provider)) throw new Error(`Не найден rule-provider «${providerName}»`)
    const target = ensureTarget(request.target ?? '')
    if (request.insertionIndex === undefined) ensureRuleReference(doc, providerName, target, request.groupName)
    else {
      const rules = asSequence(doc, root, 'rules')
      if (request.insertionIndex < 0 || request.insertionIndex > rules.items.length) throw new Error('Некорректная позиция правила')
      rules.items.splice(request.insertionIndex, 0, doc.createNode(`RULE-SET,${providerName},${target}`))
    }
    return doc.toString({ lineWidth: 0 })
  }

  const ruleType = request.ruleType
  if (!ruleType) throw new Error('Выберите тип правила')
  const inputs = normalizeMihomoRuleValues(request.value ?? '', ruleType)

  if (request.operation === 'rules') {
    const target = ensureTarget(request.target ?? '')
    const rules = asSequence(doc, root, 'rules')
    const index = request.insertionIndex ?? getMihomoRuleInsertionIndex(rules.items.map((item) => getString(item) ?? ''), target)
    if (!Number.isInteger(index) || index < 0 || index > rules.items.length) throw new Error('Некорректная позиция правила')
    const nodes = inputs.map((input) => {
      const node = doc.createNode(`${ruleType},${input},${target}`)
      if (request.groupName) node.comment = ` xkeen-ui-group: ${request.groupName.replace(/[\r\n]/g, ' ').trim()}`
      return node
    })
    rules.items.splice(index, 0, ...nodes)
    return doc.toString({ lineWidth: 0 })
  }

  if (request.operation === 'payload') {
    const payload = parseMihomoPayloadSequence(doc, 'payload', true)
    for (const input of [...inputs].reverse()) prependUnique(doc, payload, buildProviderPayloadRule('classical', ruleType, input))
    return doc.toString({ lineWidth: 0 })
  }

  const providerName = request.providerName?.trim()
  if (!providerName) throw new Error('Выберите inline rule-provider')
  const rawProviderMap = root.get('rule-providers', true)
  const providerMap = isAlias(rawProviderMap) ? rawProviderMap.resolve(doc) : rawProviderMap
  if (!isMap(providerMap)) throw new Error('В конфигурации нет раздела rule-providers')
  const rawProviderNode = providerMap.get(providerName, true)
  const providerNode = isAlias(rawProviderNode) ? rawProviderNode.resolve(doc) : rawProviderNode
  if (!isMap(providerNode)) throw new Error(`Не найден rule-provider «${providerName}»`)
  const providerType = getString(inheritedValue(doc, providerNode, 'type'))
  if (providerType !== 'inline') throw new Error(`Provider «${providerName}» не является inline`)
  const behavior = getString(inheritedValue(doc, providerNode, 'behavior')) ?? 'classical'
  const payload = parseMihomoPayloadSequence(doc, providerName, true)
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
    return newNode.items.flatMap((item) => {
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
