// Restarts the page when the user returns to the tab after it has been
// hidden (PWA/browser minimized or switched away) for longer than the
// threshold. Only applies to mobile devices, where suspended network
// connections and stale state are common after being backgrounded.

const HIDE_THRESHOLD_MS = 60_000

let hiddenAt = 0

function isMobileDevice(): boolean {
  const ua = navigator.userAgent
  // iPadOS reports itself as "Macintosh" but has touch points > 1.
  const isIpadOs = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1
  return /Android|webOS|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua) || isIpadOs
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now()
  } else if (document.visibilityState === 'visible' && hiddenAt > 0) {
    const hiddenFor = Date.now() - hiddenAt
    hiddenAt = 0
    if (hiddenFor > HIDE_THRESHOLD_MS) {
      window.location.reload()
    }
  }
}

export function initVisibilityReload() {
  if (!isMobileDevice()) return

  // The page may already be hidden when this runs (e.g. opened in background).
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now()
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
}
