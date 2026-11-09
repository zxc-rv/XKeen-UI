import assert from 'node:assert/strict'
import test from 'node:test'
import { rollbackRestartAction } from '../src/lib/config-history-policy.ts'

test('Mihomo rollback hot reloads without restarting when auto-close is disabled', () => {
  assert.equal(rollbackRestartAction('mihomo', false), null)
})

test('Mihomo rollback fully restarts when auto-close is enabled', () => {
  assert.equal(rollbackRestartAction('mihomo', true), 'hardRestart')
})

test('Xray rollback uses a full restart by default', () => {
  assert.equal(rollbackRestartAction('xray', false), 'hardRestart')
  assert.equal(rollbackRestartAction('xray', true), 'hardRestart')
})
