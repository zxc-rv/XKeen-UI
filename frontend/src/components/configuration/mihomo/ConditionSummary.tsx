import { Fragment } from 'react'
import { parseMihomoCondition, type MihomoConditionNode } from '@/lib/mihomo-rules'
import { mihomoRuleColor } from '@/lib/mihomo-rule-color'
import { ProviderLabel } from './ProviderLabel'

function ConditionText({ node, nested = false }: { node: MihomoConditionNode; nested?: boolean }) {
  if (node.type === 'NOT') {
    const child = <ConditionText node={node.children![0]} nested />
    return nested ? (
      <>
        <span className={mihomoRuleColor('NOT', '', false)}>NOT</span>
        {' ('}
        {child}
        {')'}
      </>
    ) : (
      child
    )
  }
  if (node.type === 'AND' || node.type === 'OR') {
    return (
      <>
        {node.children!.map((child, index) => {
          const grouped = child.type === 'AND' || child.type === 'OR'
          return (
            <Fragment key={index}>
              {index > 0 ? (node.type === 'AND' ? ' И ' : ' / ') : ''}
              {grouped ? '(' : ''}
              <ConditionText node={child} nested />
              {grouped ? ')' : ''}
            </Fragment>
          )
        })}
      </>
    )
  }
  return (
    <>
      <span className={mihomoRuleColor(node.type, '', false)}>{node.type}</span>
      {': '}
      {node.type === 'RULE-SET' ? <ProviderLabel name={node.value ?? ''} /> : node.value}
      {node.options?.length ? ` [${node.options.join(', ')}]` : ''}
    </>
  )
}

export function ConditionSummary({ raw, fallback }: { raw: string; fallback: string }) {
  try {
    return <ConditionText node={parseMihomoCondition(raw)} />
  } catch {
    return <>{fallback}</>
  }
}
