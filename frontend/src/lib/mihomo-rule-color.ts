const tones = {
  red: ['text-red-600 dark:text-red-400', 'bg-red-400/10 dark:bg-red-400/15 border-red-400/25'],
  blue: ['text-blue-600 dark:text-blue-400', 'bg-blue-400/10 dark:bg-blue-400/15 border-blue-400/25'],
  purple: ['text-purple-600 dark:text-purple-400', 'bg-purple-400/10 dark:bg-purple-400/15 border-purple-400/25'],
  yellow: ['text-amber-700 dark:text-yellow-400', 'bg-yellow-400/10 dark:bg-yellow-400/15 border-yellow-400/25'],
  green: ['text-green-700 dark:text-green-400', 'bg-green-400/10 dark:bg-green-400/15 border-green-400/25'],
  teal: ['text-teal-700 dark:text-teal-400', 'bg-teal-400/10 dark:bg-teal-400/15 border-teal-400/25'],
  neutral: ['text-muted-foreground', 'bg-muted/30 border-border'],
} as const

/** Same condition categories as Xray GuiRouting, with readable light-theme text. */
export function mihomoRuleColor(type: string, matcher = '', background = true): string {
  const field = type.toUpperCase()
  let tone: keyof typeof tones = 'teal'
  if (field === 'MATCH') tone = 'neutral'
  else if (['AND', 'OR', 'NOT'].includes(field)) tone = 'purple'
  else if (field.includes('DOMAIN') || field === 'GEOSITE' || (field === 'RULE-SET' && /@domain$/i.test(matcher))) tone = 'red'
  else if (field.startsWith('SRC-IP') || field === 'SRC-GEOIP' || field.startsWith('PROCESS') || field === 'UID') tone = 'purple'
  else if (field.includes('IP') || field === 'NETWORK' || (field === 'RULE-SET' && /@ipcidr$/i.test(matcher))) tone = 'blue'
  else if (field.includes('PORT') || field === 'DSCP') tone = 'yellow'
  else if (field.startsWith('IN-')) tone = 'green'
  return background ? tones[tone].join(' ') : tones[tone][0]
}
