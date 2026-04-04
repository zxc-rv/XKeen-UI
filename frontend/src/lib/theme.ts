import type { ThemeMode } from './types'

export const THEME_STORAGE_KEY = 'theme'
export const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)'

export function getStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  const theme = window.localStorage.getItem(THEME_STORAGE_KEY)
  return theme === 'light' || theme === 'dark' || theme === 'auto' ? theme : 'dark'
}

export function applyTheme(theme: ThemeMode) {
  if (typeof document === 'undefined') return
  const isDark = theme === 'dark' || (theme === 'auto' && window.matchMedia(THEME_MEDIA_QUERY).matches)
  document.documentElement.classList.toggle('dark', isDark)
  window.localStorage.setItem(THEME_STORAGE_KEY, theme)
}
