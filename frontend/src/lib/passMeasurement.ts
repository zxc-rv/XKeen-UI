export interface ProxyRouteInfo {
  name?: string
  type?: string
  now?: string
}

export interface ClashRuleInfo {
  type?: unknown
  payload?: unknown
  proxy?: unknown
}

export interface PassBootstrapPlan {
  signature: string
  initialMatchTarget: string
  actualProxyName: string
}

export interface PassMeasurement {
  delay: number
  measuredAt: number
  contextKey: string
  selectionSignature: string
  initialMatchTarget: string
  actualProxyName: string
  testUrl: string
  timeoutMs: number
}

const SELECTOR_TYPES = new Set(['selector', 'fallback', 'urltest', 'loadbalance', 'smart'])
const NON_EGRESS_TYPES = new Set(['pass', 'reject', 'reject-drop', 'relay', 'dns'])

interface ResolvedLeaf {
  name: string
  type: string
  path: Array<{ name: string; type: string; now: string | null }>
}

function resolveSelectedLeaf(proxies: Record<string, ProxyRouteInfo | undefined>, startName: string): ResolvedLeaf | null {
  const path: ResolvedLeaf['path'] = []
  const visited = new Set<string>()
  let currentName = startName

  while (currentName) {
    if (visited.has(currentName)) return null
    visited.add(currentName)

    const proxy = proxies[currentName]
    if (!proxy || typeof proxy.type !== 'string' || !proxy.type.trim()) return null

    const type = proxy.type.toLowerCase()
    const now = typeof proxy.now === 'string' && proxy.now.trim() ? proxy.now : null
    path.push({ name: currentName, type, now })

    if (!SELECTOR_TYPES.has(type)) return { name: currentName, type, path }
    if (!now) return null
    currentName = now
  }

  return null
}

export function isSelectedPassPath(name: string, proxies: Record<string, ProxyRouteInfo | undefined>): boolean {
  return resolveSelectedLeaf(proxies, name)?.type === 'pass'
}

export function getSelectedPathSignature(name: string, proxies: Record<string, ProxyRouteInfo | undefined>): string | null {
  const leaf = resolveSelectedLeaf(proxies, name)
  return leaf ? JSON.stringify(leaf.path) : null
}

function getTerminalMatch(rules: ClashRuleInfo[]): { target: string; rule: ClashRuleInfo } | null {
  if (!Array.isArray(rules) || rules.length === 0) return null

  // Mihomo's terminal MATCH must be the final rule and have no payload.
  const rule = rules[rules.length - 1]
  if (!rule || typeof rule.type !== 'string' || rule.type.toUpperCase() !== 'MATCH') return null
  if (rule.payload !== undefined && rule.payload !== null && rule.payload !== '') return null
  if (typeof rule.proxy !== 'string' || !rule.proxy.trim()) return null

  return { target: rule.proxy, rule }
}

export function resolvePassBootstrapPlan(
  optionName: string,
  proxies: Record<string, ProxyRouteInfo | undefined>,
  rules: ClashRuleInfo[]
): PassBootstrapPlan | null {
  const option = resolveSelectedLeaf(proxies, optionName)
  if (!option || option.type !== 'pass') return null

  const terminalMatch = getTerminalMatch(rules)
  if (!terminalMatch) return null

  const fallback = resolveSelectedLeaf(proxies, terminalMatch.target)
  if (!fallback || NON_EGRESS_TYPES.has(fallback.type)) return null

  const signature = JSON.stringify({
    option: option.path,
    terminalMatch: {
      type: terminalMatch.rule.type,
      payload: terminalMatch.rule.payload ?? '',
      proxy: terminalMatch.target,
    },
    fallback: fallback.path,
  })

  return {
    signature,
    initialMatchTarget: terminalMatch.target,
    actualProxyName: fallback.name,
  }
}

export function isPassMeasurementCurrent(
  measurement: PassMeasurement,
  optionName: string,
  proxies: Record<string, ProxyRouteInfo | undefined>,
  rules: ClashRuleInfo[],
  contextKey: string,
  testUrl: string,
  timeoutMs: number,
  now = Date.now(),
  maxAgeMs = 120_000
): boolean {
  const plan = resolvePassBootstrapPlan(optionName, proxies, rules)
  return (
    !!plan &&
    Number.isFinite(measurement.delay) &&
    measurement.delay >= 0 &&
    now - measurement.measuredAt >= 0 &&
    now - measurement.measuredAt <= maxAgeMs &&
    measurement.contextKey === contextKey &&
    measurement.selectionSignature === plan.signature &&
    measurement.testUrl === testUrl &&
    measurement.timeoutMs === timeoutMs
  )
}

export interface MeasurementGuard {
  contextKey: string
  requestId: number
  selectionSignature: string
}

export function canCommitMeasurement(expected: MeasurementGuard, current: MeasurementGuard): boolean {
  return (
    expected.contextKey === current.contextKey &&
    expected.requestId === current.requestId &&
    expected.selectionSignature === current.selectionSignature
  )
}
