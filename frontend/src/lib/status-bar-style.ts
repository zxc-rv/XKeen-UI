export type StatusBarStyle = 'standard' | 'accent'
export type StatusBarAccentColor = 'blue' | 'status'

export function getStoredStatusBarStyle(): StatusBarStyle {
  const style = window.localStorage.getItem('statusBarStyle')
  return style === 'accent' ? style : 'standard'
}

export function saveStatusBarStyle(style: StatusBarStyle): void {
  window.localStorage.setItem('statusBarStyle', style)
}

export function getStoredStatusBarAccentColor(): StatusBarAccentColor {
  const color = window.localStorage.getItem('statusBarAccentColor')
  return color === 'status' ? color : 'blue'
}

export function saveStatusBarAccentColor(color: StatusBarAccentColor): void {
  window.localStorage.setItem('statusBarAccentColor', color)
}
