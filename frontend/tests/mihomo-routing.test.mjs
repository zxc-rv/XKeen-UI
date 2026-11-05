import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from 'yaml'
import * as routing from '../src/lib/mihomo-rules.ts'

test('logical row summary displays domains and nested operators', () => {
  assert.equal(
    routing.summarizeMihomoCondition('OR,((DOMAIN-SUFFIX,example.org),(NETWORK,udp))'),
    'DOMAIN-SUFFIX: example.org / NETWORK: udp'
  )
  assert.equal(routing.summarizeMihomoCondition('NOT,((DOMAIN,example.net))'), 'DOMAIN: example.net')
  assert.equal(
    routing.summarizeMihomoCondition('AND,((DOMAIN,example.com),(NOT,((NETWORK,udp))))'),
    'DOMAIN: example.com И NOT (NETWORK: udp)'
  )
})

test('ordinary routing rules follow all REJECT rules and new REJECT rules insert first', () => {
  const input =
    'rule-providers: {p: {type: inline, behavior: classical, payload: []}}\nrules: ["DOMAIN,first.test,DIRECT", "DOMAIN,ads.test,REJECT", "GEOIP,private,REJECT,no-resolve", "MATCH,DIRECT"]\n'
  for (const request of [
    { operation: 'rules', ruleType: 'DOMAIN-SUFFIX', value: 'new.test', target: 'DIRECT' },
    { operation: 'rule-set', providerName: 'p', target: 'DIRECT' },
  ]) {
    const next = routing.getMihomoRoutingRules(routing.addMihomoRule(input, request))
    assert.equal(next[0], 'DOMAIN,first.test,DIRECT')
    assert.deepEqual(next.slice(1, 4), [
      'DOMAIN,ads.test,REJECT',
      request.ruleType === 'DOMAIN-SUFFIX' ? 'DOMAIN-SUFFIX,new.test,DIRECT' : 'RULE-SET,p,DIRECT',
      'GEOIP,private,REJECT,no-resolve',
    ])
  }
  const normalThenRuleSet = routing.getMihomoRoutingRules(routing.addMihomoRule(
    routing.addMihomoRule(input, { operation: 'rules', ruleType: 'DOMAIN-SUFFIX', value: 'new.test', target: 'DIRECT' }),
    { operation: 'rule-set', providerName: 'p', target: 'DIRECT' }
  ))
  assert.deepEqual(normalThenRuleSet.slice(1, 4), [
    'DOMAIN,ads.test,REJECT',
    'DOMAIN-SUFFIX,new.test,DIRECT',
    'RULE-SET,p,DIRECT',
  ])
  const reject = routing.getMihomoRoutingRules(routing.addMihomoRule(input, {
    operation: 'rules', ruleType: 'NOT', value: '((DOMAIN,new.test))', target: 'REJECT',
  }))
  assert.deepEqual(reject.slice(0, 4), [
    'DOMAIN,first.test,DIRECT',
    'DOMAIN,ads.test,REJECT',
    'NOT,((DOMAIN,new.test)),REJECT',
    'GEOIP,private,REJECT,no-resolve',
  ])
})

test('insertion falls back to first without REJECT and preserves multiple input order', () => {
  const base = 'rules: ["DOMAIN,keep.test,DIRECT", "GEOIP,private,REJECT,no-resolve", "MATCH,DIRECT"]\n'
  assert.equal(routing.getMihomoRuleInsertionIndex(routing.getMihomoRoutingRules(base)), 1)
  assert.equal(routing.getMihomoRuleInsertionIndex(['MATCH,DIRECT']), 0)
  const next = routing.addMihomoRule(base, { operation: 'rules', ruleType: 'DOMAIN', value: 'a.test\nb.test', target: 'DIRECT' })
  assert.deepEqual(routing.getMihomoRoutingRules(next).slice(0, 4), [
    'DOMAIN,keep.test,DIRECT',
    'DOMAIN,a.test,DIRECT',
    'DOMAIN,b.test,DIRECT',
    'GEOIP,private,REJECT,no-resolve',
  ])
  const noReject = routing.addMihomoRule('rules: ["MATCH,DIRECT"]\n', {
    operation: 'rules',
    ruleType: 'DOMAIN',
    value: 'a.test',
    target: 'REJECT',
  })
  assert.equal(routing.getMihomoRoutingRules(noReject)[0], 'DOMAIN,a.test,REJECT')
})

test('editable rule options preserve matcher and destination, including nested logical rules', () => {
  assert.equal(routing.setMihomoRuleOptions('GEOIP,private,DIRECT,no-resolve', []), 'GEOIP,private,DIRECT')
  assert.equal(routing.setMihomoRuleOptions('IP-CIDR,10.0.0.0/8,Main', ['no-resolve', 'src']), 'IP-CIDR,10.0.0.0/8,Main,no-resolve,src')
  assert.equal(routing.setMihomoRuleOptions('GEOIP,private,no-resolve', ['src']), 'GEOIP,private,no-resolve,src')
  assert.equal(
    routing.setMihomoRuleOptions('AND,((GEOIP,private),(NETWORK,tcp)),Main,no-resolve', ['src']),
    'AND,((GEOIP,private),(NETWORK,tcp)),Main,src'
  )
  assert.throws(() => routing.setMihomoRuleOptions('GEOIP,private,DIRECT', ['bogus']))
})

test('logical constructor round trips nested conditions and flags', () => {
  const raw = 'AND,((DOMAIN,baidu.com),(OR,((NETWORK,UDP),(NOT,((DST-PORT,443)))))),DIRECT,no-resolve'
  const parsed = routing.parseMihomoCondition(
    routing.describeMihomoRoutingRule(raw).type + ',' + routing.describeMihomoRoutingRule(raw).matcher
  )
  assert.equal(routing.serializeMihomoCondition(parsed), raw.slice(0, raw.lastIndexOf(',DIRECT')))
  assert.equal(parsed.children[1].children[1].type, 'NOT')
  assert.throws(() => routing.serializeMihomoCondition({ type: 'NOT', children: [] }))
  assert.throws(() => routing.serializeMihomoCondition({ type: 'DOMAIN', value: '' }))
  assert.throws(() => routing.parseMihomoCondition('AND,((NETWORK,UDP)'))
})

test('indexed insertion preserves priority and comments, including empty drafts', () => {
  const input = 'dns: {enable: true}\nrules:\n  - DOMAIN,a.com,DIRECT # first\n  - MATCH,DIRECT\n'
  const next = routing.insertMihomoRoutingRuleAt(input, 1, 'DOMAIN-SUFFIX,,DIRECT')
  assert.deepEqual(routing.getMihomoRoutingRules(next), ['DOMAIN,a.com,DIRECT', 'DOMAIN-SUFFIX,,DIRECT', 'MATCH,DIRECT'])
  assert.match(next, /# first/)
  assert.deepEqual(parse(next).dns, { enable: true })
  assert.throws(() => routing.insertMihomoRoutingRuleAt(input, 4, 'x'))
})

test('constructor inserts logical rules at selected position and classical payload without a route', () => {
  const input =
    'rule-providers:\n  inline: {type: inline, behavior: classical, payload: []}\nrules: ["DOMAIN,a.com,DIRECT", "MATCH,DIRECT"]\n'
  const request = { operation: 'rules', ruleType: 'AND', value: '((DOMAIN,baidu.com),(NETWORK,UDP))', target: 'REJECT', insertionIndex: 1 }
  const next = routing.addMihomoRule(input, request)
  assert.deepEqual(parse(next).rules, ['DOMAIN,a.com,DIRECT', 'AND,((DOMAIN,baidu.com),(NETWORK,UDP)),REJECT', 'MATCH,DIRECT'])
  const payload = routing.addMihomoRule(input, { ...request, operation: 'inline', providerName: 'inline' })
  assert.deepEqual(parse(payload)['rule-providers'].inline.payload, ['AND,((DOMAIN,baidu.com),(NETWORK,UDP))'])
  assert.throws(() => routing.addMihomoRule(input, { ...request, value: '((DOMAIN,))' }))
})

test('draft completion rejects comma-injected values and missing fields', () => {
  assert.throws(() => routing.completeMihomoRoutingDraft('DOMAIN-SUFFIX,foo,bar,DIRECT'))
  assert.throws(() => routing.completeMihomoRoutingDraft('DOMAIN-SUFFIX,,DIRECT'))
  assert.throws(() => routing.completeMihomoRoutingDraft('DOMAIN-SUFFIX,example.com,'))
  assert.equal(routing.completeMihomoRoutingDraft('DOMAIN-SUFFIX,example.com,DIRECT'), 'DOMAIN-SUFFIX,example.com,DIRECT')
  assert.equal(routing.completeMihomoRoutingDraft('NOT,((NETWORK,udp)),DIRECT'), 'NOT,((NETWORK,udp)),DIRECT')
})

test('constructor adds to an aliased root payload without mutating its source', () => {
  const input = 'base: &items ["DOMAIN,a.com"]\npayload: *items\n'
  const next = parse(routing.addMihomoRule(input, { operation: 'payload', ruleType: 'DOMAIN', value: 'b.com' }))
  assert.deepEqual(next.base, ['DOMAIN,a.com'])
  assert.deepEqual(next.payload, ['DOMAIN,b.com', 'DOMAIN,a.com'])
})
const {
  describeMihomoRoutingRule,
  describeMihomoPayloadRule,
  getMihomoRuleConditions,
  updateMihomoRoutingRuleTargets,
  updateMihomoRoutingRule,
  deleteMihomoPayloadRule,
  reorderMihomoRoutingRules,
} = routing

test('route choices omit REJECT-DROP without changing configured rules', () => {
  const yaml = 'proxy-groups: [{name: Main}, {name: REJECT-DROP}]\nrules: ["MATCH,REJECT-DROP"]\n'
  assert.deepEqual(routing.getMihomoRoutingTargets(yaml), ['DIRECT', 'REJECT', 'Main'])
  assert.deepEqual(routing.getMihomoRoutingRules(yaml), ['MATCH,REJECT-DROP'])
})

test('IP rules keep flags out of destination and preserve flags on route changes', () => {
  for (const type of ['IP-CIDR', 'IP-CIDR6', 'IP-ASN', 'GEOIP']) {
    const raw = `${type},10.0.0.0/8,DIRECT,no-resolve,src`
    assert.equal(describeMihomoRoutingRule(raw).target, 'DIRECT')
    assert.equal(describeMihomoRoutingRule(raw).matcher, '10.0.0.0/8')
    assert.deepEqual(parse(updateMihomoRoutingRuleTargets(`rules:\n  - ${raw}\n`, [0], 'Proxy')).rules, [
      `${type},10.0.0.0/8,Proxy,no-resolve,src`,
    ])
  }
})
test('a route whose name is a flag remains a route', () => {
  assert.equal(describeMihomoRoutingRule('DOMAIN,example.com,src').target, 'src')
  assert.equal(describeMihomoRoutingRule('MATCH,no-resolve').target, 'no-resolve')
})
test('compound payload displays every condition including the last', () => {
  assert.deepEqual(getMihomoRuleConditions('AND,((DST-PORT,443),(NETWORK,UDP))', true), [
    { field: 'DST-PORT', value: '443' },
    { field: 'NETWORK', value: 'UDP' },
  ])
})
test('domain and IP payloads are described using provider behavior', () => {
  assert.equal(describeMihomoPayloadRule('+.example.com', 'domain').matcher, '+.example.com')
  assert.equal(describeMihomoPayloadRule('10.0.0.0/8', 'ipcidr').type, 'IP-CIDR')
  assert.equal(describeMihomoPayloadRule('2001:db8::/32', 'ipcidr').type, 'IP-CIDR6')
})
test('inline matcher edits preserve route flags and payload format', () => {
  assert.equal(
    routing.editMihomoRuleMatcher('IP-CIDR,10.0.0.0/8,Proxy,no-resolve', 'IP-CIDR', '192.168.0.0/16'),
    'IP-CIDR,192.168.0.0/16,Proxy,no-resolve'
  )
  assert.equal(routing.editMihomoRuleMatcher('+.old.test', 'DOMAIN-SUFFIX', 'new.test', true, 'domain'), '+.new.test')
  assert.equal(routing.editMihomoRuleMatcher('10.0.0.0/8', 'IP-CIDR', '192.168.0.0/16', true, 'ipcidr'), '192.168.0.0/16')
  assert.throws(() => routing.editMihomoRuleMatcher('NETWORK,tcp,DIRECT', 'NETWORK', ''), /значение/i)
  assert.throws(() => routing.editMihomoRuleMatcher('DOMAIN,old.test,DIRECT', 'DOMAIN', 'new.test,REJECT'), /запят/i)
})
test('edits and reordering preserve unrelated YAML data, aliases and comments', () => {
  const yaml =
    '# user config\ndns: &dns {enable: true, nameserver: [1.1.1.1]}\ncopy: *dns\nrules:\n  # first\n  - DOMAIN,one.test,DIRECT\n  # second\n  - MATCH,Proxy\nrule-providers:\n  inline: {type: inline, behavior: classical, payload: [NETWORK,UDP]}\n'
  const changed = updateMihomoRoutingRule(yaml, 0, 'DOMAIN,two.test,DIRECT')
  assert.deepEqual(parse(changed).dns, parse(yaml).dns)
  assert.ok(changed.includes('&dns'))
  assert.ok(changed.includes('*dns'))
  assert.ok(changed.includes('# first'))
  assert.deepEqual(parse(reorderMihomoRoutingRules(changed, [1, 0])).rules, ['MATCH,Proxy', 'DOMAIN,two.test,DIRECT'])
  assert.deepEqual(parse(deleteMihomoPayloadRule(yaml, 'inline', 0)).rules, parse(yaml).rules)
})

test('classical payload edits preserve trailing IP flags', () => {
  assert.equal(describeMihomoPayloadRule('IP-CIDR,10.0.0.0/8,no-resolve,src').matcher, '10.0.0.0/8')
  assert.equal(
    routing.editMihomoRuleMatcher('IP-CIDR,10.0.0.0/8,no-resolve,src', 'IP-CIDR', '192.168.0.0/16', true),
    'IP-CIDR,192.168.0.0/16,no-resolve,src'
  )
})
test('domain payload edits retain explicit wildcard semantics', () => {
  assert.equal(routing.editMihomoRuleMatcher('.old.test', 'DOMAIN-SUFFIX', '.new.test', true, 'domain'), '.new.test')
  assert.equal(routing.editMihomoRuleMatcher('.old.test', 'DOMAIN-SUFFIX', 'new.test', true, 'domain'), '.new.test')
  assert.equal(routing.editMihomoRuleMatcher('+.old.test', 'DOMAIN-SUFFIX', 'new.test', true, 'domain'), '+.new.test')
})
test('proxy destination changes do not overwrite a SUB-RULE reference', () => {
  assert.throws(() => updateMihomoRoutingRuleTargets('rules:\n  - SUB-RULE,(NETWORK,tcp),custom-rules\n', [0], 'DIRECT'), /SUB-RULE/)
})
test('named service cards collect conditions without changing their real order', () => {
  const rules = ['RULE-SET,cloudflare@ipcidr,CDN', 'RULE-SET,speedtest@domain,Speedtest', 'GEOSITE,amazon,CDN', 'MATCH,DIRECT']
  assert.deepEqual(
    routing.groupMihomoRoutingRules(rules).map((group) => ({ label: group.label, indices: group.indices })),
    [
      { label: 'CDN', indices: [0, 2] },
      { label: 'Speedtest', indices: [1] },
      { label: 'Остальной трафик · MATCH', indices: [3] },
    ]
  )
  assert.equal(rules[1], 'RULE-SET,speedtest@domain,Speedtest')
})
test('moving one service block keeps unrelated priorities and MATCH intact', () => {
  assert.deepEqual(routing.moveMihomoRuleGroup(7, [1, 4], 6), [0, 2, 3, 5, 1, 4, 6])
  assert.deepEqual(routing.moveMihomoRuleGroup(7, [1, 4], 0), [1, 4, 0, 2, 3, 5, 6])
  assert.throws(() => routing.moveMihomoRuleGroup(3, [1], 1), /позици/i)
})
test('a named service block keeps its identity when its route changes', () => {
  const yaml = 'rules:\n  # user note\n  - GEOSITE,amazon,CDN\n  - GEOIP,cloudflare,CDN,no-resolve\n'
  const changed = updateMihomoRoutingRuleTargets(yaml, [0, 1], 'DIRECT', 'CDN')
  const groups = routing.groupMihomoRoutingRules(routing.getMihomoRoutingRules(changed), routing.getMihomoRoutingRuleComments(changed))
  assert.equal(groups[0].label, 'CDN')
  assert.equal(groups[0].target, 'DIRECT')
  assert.ok(changed.includes('# user note'))
})
test('new rules join an existing named block after a route round trip', () => {
  let yaml = updateMihomoRoutingRuleTargets('rules:\n  - GEOSITE,amazon,CDN\n', [0], 'DIRECT', 'CDN')
  yaml = updateMihomoRoutingRuleTargets(yaml, [0], 'CDN', 'CDN')
  yaml += '  - GEOSITE,cloudflare,CDN\n'
  assert.equal(routing.groupMihomoRoutingRules(routing.getMihomoRoutingRules(yaml), routing.getMihomoRoutingRuleComments(yaml)).length, 1)
})
test('empty inline payloads remain visible alongside populated providers', () => {
  const yaml =
    'inline: &inline {type: inline, behavior: classical}\nrule-providers:\n  empty:\n    <<: *inline\n    payload:\n  missing:\n    <<: *inline\n  populated:\n    <<: *inline\n    payload: ["NETWORK,UDP"]\n'
  assert.deepEqual(
    routing.getMihomoPayloadGroups(yaml).map((group) => ({ name: group.name, count: group.rules.length })),
    [
      { name: 'empty', count: 0 },
      { name: 'missing', count: 0 },
      { name: 'populated', count: 1 },
    ]
  )
})
test('payloads inherited through YAML merges are read', () => {
  const yaml =
    'defaults: &defaults {type: inline, behavior: domain, payload: [example.test]}\nrule-providers:\n  inherited:\n    <<: *defaults\n'
  assert.deepEqual(routing.getMihomoPayloadGroups(yaml), [{ name: 'inherited', rules: ['example.test'], behavior: 'domain' }])
})
test('editing inherited or aliased payload changes only the chosen provider', () => {
  for (const payload of ['    <<: *defaults\n', '    type: inline\n    behavior: domain\n    payload: *shared\n']) {
    const yaml =
      'shared: &shared [example.test]\ndefaults: &defaults {type: inline, behavior: domain, payload: *shared}\nrule-providers:\n  first:\n' +
      payload +
      '  second:\n    <<: *defaults\n'
    const changed = routing.updateMihomoPayloadRule(yaml, 'first', 0, 'new.test')
    assert.deepEqual(
      routing.getMihomoPayloadGroups(changed).map((group) => group.rules),
      [['new.test'], ['example.test']]
    )
    assert.deepEqual(parse(changed).shared, ['example.test'])
  }
})
test('prepending inside a named block keeps its identity and existing order', () => {
  let yaml = updateMihomoRoutingRuleTargets(
    'rules:\n  - DOMAIN,ads.test,REJECT\n  - DOMAIN,old.test,CDN\nrule-providers:\n  test: {type: http, behavior: domain, url: https://example.test/rules}\n',
    [1],
    'DIRECT',
    'CDN'
  )
  yaml = routing.addMihomoRule(yaml, { operation: 'rules', ruleType: 'DOMAIN-KEYWORD', value: 'new', target: 'DIRECT', groupName: 'CDN' })
  yaml = routing.addMihomoRule(yaml, { operation: 'rule-set', providerName: 'test', target: 'DIRECT', groupName: 'CDN' })
  assert.equal(routing.getMihomoRoutingRules(yaml)[0], 'DOMAIN-KEYWORD,new,DIRECT')
  assert.equal(routing.getMihomoRoutingRules(yaml)[1], 'RULE-SET,test,DIRECT')
  assert.equal(routing.getMihomoRoutingRules(yaml)[2], 'DOMAIN,ads.test,REJECT')
  const groups = routing.groupMihomoRoutingRules(routing.getMihomoRoutingRules(yaml), routing.getMihomoRoutingRuleComments(yaml))
  assert.deepEqual(
    groups.map((group) => ({ label: group.label, count: group.indices.length })),
    [
      { label: 'CDN', count: 3 },
      { label: 'REJECT', count: 1 },
    ]
  )
})
test('editing an aliased provider does not shadow nested anchors used by other providers', () => {
  const yaml =
    'defaults: &defaults {type: inline, behavior: domain, payload: &shared [example.test]}\nrule-providers:\n  first: *defaults\n  second: {type: inline, behavior: domain, payload: *shared}\n'
  const changed = routing.updateMihomoPayloadRule(yaml, 'first', 0, 'new.test')
  assert.deepEqual(
    routing.getMihomoPayloadGroups(changed).map((group) => group.rules),
    [['new.test'], ['example.test']]
  )
})
test('RULE-SET insertion accepts an aliased provider listed by the inspector', () => {
  const yaml =
    'defaults: &defaults {type: inline, behavior: domain, payload: [example.test]}\nrule-providers: {aliased: *defaults}\nrules: []\n'
  assert.equal(routing.inspectMihomoRuleConfig(yaml).providers[0].name, 'aliased')
  assert.deepEqual(parse(routing.addMihomoRule(yaml, { operation: 'rule-set', providerName: 'aliased', target: 'DIRECT' })).rules, [
    'RULE-SET,aliased,DIRECT',
  ])
})
