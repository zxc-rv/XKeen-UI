import type { EmojiFont, ThemeMode } from './types'

export const THEME_STORAGE_KEY = 'theme'
export const THEME_MEDIA_QUERY = '(prefers-color-scheme: dark)'

export function getStoredTheme(): ThemeMode {
  const theme = window.localStorage.getItem(THEME_STORAGE_KEY)
  return theme === 'light' || theme === 'dark' || theme === 'auto' ? theme : 'auto'
}

export function applyTheme(theme: ThemeMode) {
  const isDark = theme === 'dark' || (theme === 'auto' && window.matchMedia(THEME_MEDIA_QUERY).matches)
  document.documentElement.classList.toggle('dark', isDark)
  window.localStorage.setItem(THEME_STORAGE_KEY, theme)
}

export const EMOJI_FONT_STORAGE_KEY = 'emojiFont'

export function getStoredEmojiFont(): EmojiFont {
  return window.localStorage.getItem(EMOJI_FONT_STORAGE_KEY) === 'notocoloremoji' ? 'notocoloremoji' : 'twemoji'
}

const EMOJI_FONT_FAMILIES: Record<EmojiFont, string> = {
  twemoji: "'TwemojiMozilla'",
  notocoloremoji: "'Noto Color Emoji'",
}

export function applyEmojiFont(font: EmojiFont) {
  document.documentElement.style.setProperty('--emoji-font-family', EMOJI_FONT_FAMILIES[font] ?? EMOJI_FONT_FAMILIES.twemoji)
  window.localStorage.setItem(EMOJI_FONT_STORAGE_KEY, font)
}
