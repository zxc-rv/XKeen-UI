export type MihomoPalette = 'green' | 'blue' | 'purple'

const MIHOMO_PALETTE_KEY = 'mihomoPalette'

export function getStoredMihomoPalette(): MihomoPalette {
  const palette = window.localStorage.getItem(MIHOMO_PALETTE_KEY)
  return palette === 'green' || palette === 'purple' ? palette : 'blue'
}

export function saveMihomoPalette(palette: MihomoPalette): void {
  window.localStorage.setItem(MIHOMO_PALETTE_KEY, palette)
}
