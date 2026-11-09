export type CoreRestartAction = 'hardRestart' | null

export function rollbackRestartAction(core: string, closeConnectionsOnApply: boolean): CoreRestartAction {
  if (core === 'xray') return 'hardRestart'
  if (core === 'mihomo' && closeConnectionsOnApply) return 'hardRestart'
  return null
}
