import assert from 'node:assert/strict'
import test from 'node:test'

import { canCommitMeasurement, isPassMeasurementCurrent, isSelectedPassPath, resolvePassBootstrapPlan } from '../src/lib/passMeasurement.ts'

const proxies = {
  YouTube: { type: 'Selector', now: 'Интернет' },
  Интернет: { type: 'Selector', now: 'Авто · по назначениям' },
  'Авто · по назначениям': { type: 'Selector', now: 'PASS' },
  PASS: { type: 'Pass' },
  'Авто · исходный маршрут': { type: 'URLTest', now: 'node-a' },
  'node-a': { type: 'VLESS' },
}

const rules = [
  { type: 'DOMAIN', payload: 'example.com', proxy: 'YouTube' },
  { type: 'Match', payload: '', proxy: 'Авто · исходный маршрут' },
]

test('resolves a selector chain ending in PASS to the terminal MATCH exit', () => {
  assert.equal(isSelectedPassPath('YouTube', proxies), true)
  assert.deepEqual(resolvePassBootstrapPlan('YouTube', proxies, rules), {
    signature: JSON.stringify({
      option: [
        { name: 'YouTube', type: 'selector', now: 'Интернет' },
        { name: 'Интернет', type: 'selector', now: 'Авто · по назначениям' },
        { name: 'Авто · по назначениям', type: 'selector', now: 'PASS' },
        { name: 'PASS', type: 'pass', now: null },
      ],
      terminalMatch: { type: 'Match', payload: '', proxy: 'Авто · исходный маршрут' },
      fallback: [
        { name: 'Авто · исходный маршрут', type: 'urltest', now: 'node-a' },
        { name: 'node-a', type: 'vless', now: null },
      ],
    }),
    initialMatchTarget: 'Авто · исходный маршрут',
    actualProxyName: 'node-a',
  })
})

test('fails closed for missing, nonterminal, or malformed MATCH targets', () => {
  assert.equal(resolvePassBootstrapPlan('YouTube', proxies, []), null)
  assert.equal(resolvePassBootstrapPlan('YouTube', proxies, [...rules, { type: 'DOMAIN', payload: 'other.test', proxy: 'node-a' }]), null)
  assert.equal(resolvePassBootstrapPlan('YouTube', proxies, [{ type: 'MATCH', payload: 'not-empty', proxy: 'node-a' }]), null)
  assert.equal(resolvePassBootstrapPlan('YouTube', proxies, [{ type: 'MATCH', payload: '', proxy: 'missing' }]), null)
})

test('fails closed for cycles and non-egress fallback leaves', () => {
  const cyclic = { ...proxies, 'Авто · исходный маршрут': { type: 'Selector', now: 'loop' }, loop: { type: 'Selector', now: 'loop' } }
  assert.equal(resolvePassBootstrapPlan('YouTube', cyclic, rules), null)

  const rejected = { ...proxies, 'Авто · исходный маршрут': { type: 'Selector', now: 'REJECT' }, REJECT: { type: 'Reject' } }
  assert.equal(resolvePassBootstrapPlan('YouTube', rejected, rules), null)
})

test('invalidates measurements when route, context, URL, or age changes', () => {
  const plan = resolvePassBootstrapPlan('YouTube', proxies, rules)
  assert.ok(plan)
  const measurement = {
    delay: 42,
    measuredAt: 10_000,
    contextKey: 'router-a',
    selectionSignature: plan.signature,
    initialMatchTarget: plan.initialMatchTarget,
    actualProxyName: plan.actualProxyName,
    testUrl: 'https://example.test/generate_204',
    timeoutMs: 5_000,
  }

  assert.equal(isPassMeasurementCurrent(measurement, 'YouTube', proxies, rules, 'router-a', measurement.testUrl, 5_000, 10_001), true)
  assert.equal(isPassMeasurementCurrent(measurement, 'YouTube', proxies, rules, 'router-b', measurement.testUrl, 5_000, 10_001), false)
  assert.equal(isPassMeasurementCurrent(measurement, 'YouTube', proxies, rules, 'router-a', 'https://other.test/', 5_000, 10_001), false)
  assert.equal(isPassMeasurementCurrent(measurement, 'YouTube', proxies, rules, 'router-a', measurement.testUrl, 5_000, 200_001), false)

  const changed = { ...proxies, 'Авто · по назначениям': { type: 'Selector', now: 'node-a' } }
  assert.equal(isPassMeasurementCurrent(measurement, 'YouTube', changed, rules, 'router-a', measurement.testUrl, 5_000, 10_001), false)
})

test('an old async result cannot commit after a newer request or context arrives', async () => {
  let release
  const response = new Promise((resolve) => {
    release = resolve
  })

  let current = { contextKey: 'router-a', requestId: 1, selectionSignature: 'old-route' }
  const delayedCommit = response.then(() =>
    canCommitMeasurement({ contextKey: 'router-a', requestId: 1, selectionSignature: 'old-route' }, current)
  )

  current = { contextKey: 'router-b', requestId: 2, selectionSignature: 'new-route' }
  release()
  assert.equal(await delayedCommit, false)
})
