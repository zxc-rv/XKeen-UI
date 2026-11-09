import assert from 'node:assert/strict'
import test from 'node:test'
import { revertConfigChange } from '../src/components/configuration/config-history-diff.ts'

test('reverts a changed line when later edits modified neighboring context', () => {
  const before = 'rules:\n  - DOMAIN-SUFFIX,ntc.party\n  - KEEP'
  const after = 'rules:\n  - ntc.party\n  - KEEP'
  const current = 'rules:\n  - ntc.party\n  - KEEP-EDITED'

  assert.equal(revertConfigChange(current, before, after), 'rules:\n  - DOMAIN-SUFFIX,ntc.party\n  - KEEP-EDITED')
})

test('reverts repeated lines by their position in the saved revision', () => {
  const before = 'first:\n  - KEEP\n  - DOMAIN-SUFFIX,ntc.party\nsecond:\n  - KEEP\n  - DOMAIN-SUFFIX,ntc.party'
  const after = 'first:\n  - KEEP\n  - ntc.party\nsecond:\n  - KEEP\n  - DOMAIN-SUFFIX,ntc.party'

  assert.equal(revertConfigChange(after, before, after), before)
})

test('keeps refusing rollback if the changed line itself was edited later', () => {
  const before = 'rules:\n  - DOMAIN-SUFFIX,ntc.party'
  const after = 'rules:\n  - ntc.party'
  const current = 'rules:\n  - ntc-party-edited'

  assert.throws(() => revertConfigChange(current, before, after), /изменена позже/)
})
