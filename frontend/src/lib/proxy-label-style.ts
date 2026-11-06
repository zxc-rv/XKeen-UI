export type ProxyLabelStyle = 'plain' | 'outlined'

export const PROXY_LABEL_STYLE_KEY = 'proxyLabelStyle'

export function getStoredProxyLabelStyle(): ProxyLabelStyle {
  const style = window.localStorage.getItem(PROXY_LABEL_STYLE_KEY)
  return style === 'outlined' ? style : 'plain'
}

export function saveProxyLabelStyle(style: ProxyLabelStyle): void {
  window.localStorage.setItem(PROXY_LABEL_STYLE_KEY, style)
}
