import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const stripJsonComments = (s: string) => s.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* */
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none;z-index:-1;'
    const container = document.querySelector('[role="dialog"]') ?? document.body
    container.appendChild(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
  } catch {
    return false
  }
}

export function parseClashApiCredentials(yamlContent: string): { port: string | null; secret: string | null; unix: string | null } {
  const unixMatch = yamlContent.match(/^external-controller-unix:\s*(?:(["'])(.*?)\1|([^#\n]+?))(?:\s+#.*)?$/m)
  const unixPath = unixMatch ? (unixMatch[2] ?? unixMatch[3])?.trim() || null : null
  const unix = unixPath ? unixPath.split(/[\\/]/).pop() || null : null
  const port = yamlContent.match(/^external-controller:\s*['"']?[\w.-]+:(\d+)/m)?.[1] ?? null
  const secretMatch = yamlContent.match(/^secret:\s*(?:(["'])(.*?)\1|([^#\n]+?))(?:\s+#.*)?$/m)
  const secret = secretMatch ? (secretMatch[2] ?? secretMatch[3])?.trim() || null : null
  return { port, secret, unix }
}
