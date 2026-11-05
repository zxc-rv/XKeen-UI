import { mihomoRuleColor } from '@/lib/mihomo-rule-color'

/** Keep provider names neutral; highlight only their format suffix. */
export function ProviderLabel({ name }: { name: string }) {
  const parts = name.match(/^(.*)(@(domain|ipcidr|inline|classical))$/i)
  if (!parts) return <span className="truncate">{name}</span>
  const type = { domain: 'DOMAIN', ipcidr: 'IP-CIDR', inline: 'IN-TYPE', classical: 'AND' }[parts[3].toLowerCase()] ?? 'RULE-SET'
  return (
    <span className="inline-flex max-w-full min-w-0">
      <span className="truncate">{parts[1]}</span>
      <span className={mihomoRuleColor(type, '', false)}>{parts[2]}</span>
    </span>
  )
}
