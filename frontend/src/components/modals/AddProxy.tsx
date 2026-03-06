import { useState } from 'react'
import { IconLink, IconCopy, IconCheck, IconX, IconPlus } from '@tabler/icons-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAppContext, useModalContext } from '../../lib/store'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'

function highlightYaml(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n')
    .map((line) => {
      if (/^\s*#/.test(line)) return `<span style="color:#565f89">${line}</span>`

      const listMatch = line.match(/^(\s*-\s)(.*)$/)
      if (listMatch) {
        const [, marker, rest] = listMatch
        return `<span style="color:#89ddff">${marker}</span>${highlightYamlValue(rest)}`
      }

      const kvMatch = line.match(/^(\s*)([a-zA-Z_][\w.-]*)(\s*:)(.*)?$/)
      if (kvMatch) {
        const [, indent, key, colon, rest] = kvMatch
        const value = rest ?? ''
        return `${indent}<span style="color:#7aa2f7">${key}</span>${colon}${highlightYamlValue(value)}`
      }

      return line
    })
    .join('\n')
}

function highlightYamlValue(value: string): string {
  if (!value.trim()) return value
  const trimmed = value.trim()
  const commentIdx = value.search(/\s+#/)
  if (commentIdx !== -1) {
    const main = value.slice(0, commentIdx)
    const comment = value.slice(commentIdx)
    return highlightYamlValue(main) + `<span style="color:#565f89">${comment}</span>`
  }

  if (/^-?\d+\.?\d*$/.test(trimmed)) return value.replace(trimmed, `<span style="color:#ff9e64">${trimmed}</span>`)
  if (/^(true|false|null|~)$/.test(trimmed)) return value.replace(trimmed, `<span style="color:#bb9af7">${trimmed}</span>`)
  if (/^["']/.test(trimmed)) return value.replace(trimmed, `<span style="color:#9ece6a">${trimmed}</span>`)
  if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[') && !trimmed.startsWith('*') && !trimmed.startsWith('&'))
    return value.replace(trimmed, `<span style="color:#9ece6a">${trimmed}</span>`)

  return value
}

function highlightJson(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"([^"]+)"(\s*:)/g, '<span style="color:#7aa2f7">"$1"</span>$2')
    .replace(/:\s*"([^"]*)"/g, ': <span style="color:#9ece6a">"$1"</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span style="color:#ff9e64">$1</span>')
    .replace(/:\s*(true|false|null)/g, ': <span style="color:#bb9af7">$1</span>')
}

function highlightCode(code: string): string {
  return code.trimStart().startsWith('{') ? highlightJson(code) : highlightYaml(code)
}

const SUPPORTED_PROTOCOLS = ['ss://', 'vless://', 'vmess://', 'hysteria2://', 'hy2://', 'http://', 'https://', 'trojan://']

interface Props {
  onGenerate: (uri: string) => { content: string; type: string } | null
  onAddToConfig: (content: string, type: string, position: 'start' | 'end') => void
}

export function ImportModal({ onGenerate, onAddToConfig }: Props) {
  const { showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()
  const [uri, setUri] = useState('')
  const [result, setResult] = useState<{
    content: string
    type: string
    protocol: string
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const isValidUri = SUPPORTED_PROTOCOLS.some((p) => uri.toLowerCase().startsWith(p))

  function close() {
    dispatch({ type: 'SHOW_MODAL', modal: 'showImportModal', show: false })
    setTimeout(() => {
      setUri('')
      setResult(null)
    }, 300)
  }

  function generate() {
    if (!uri.trim()) return
    try {
      const generated = onGenerate(uri.trim())
      if (generated) {
        const protocol = uri.match(/^([a-zA-Z0-9+\-.]+):\/\//)?.[1]?.toUpperCase() ?? ''
        setResult({ ...generated, protocol })
      } else {
        setResult(null)
      }
    } catch (e: any) {
      showToast(e.message, 'error')
    }
  }

  function copy(e: React.MouseEvent<HTMLButtonElement>) {
    if (!result) return
    try {
      if (navigator?.clipboard?.writeText) {
        navigator.clipboard.writeText(result.content)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = result.content
        textarea.style.cssText = 'position:absolute;opacity:0;pointer-events:none;z-index:-1;'
        const target = e.currentTarget || document.body
        target.appendChild(textarea)
        textarea.focus()
        textarea.select()
        textarea.setSelectionRange(0, 99999)
        document.execCommand('copy')
        target.removeChild(textarea)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      showToast('Ошибка копирования', 'error')
    }
  }

  function addToConfig(position: 'start' | 'end') {
    if (!result) return
    onAddToConfig(result.content, result.type, position)
    close()
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Dialog open={modals.showImportModal} onOpenChange={(open) => !open && close()}>
        <DialogContent className="flex flex-col max-h-[90dvh] w-auto! min-w-[min(90vw,480px)]! max-w-[min(90vw,900px)]! overflow-hidden">
          {/* Шапка модалки*/}
          <DialogHeader className="shrink-0 pb-1">
            <DialogTitle className="flex items-center gap-2 pb-2">
              <IconLink size={24} className="text-chart-2" /> Добавить прокси
            </DialogTitle>
            <DialogDescription>Вставьте ссылку в формате protocol://</DialogDescription>
          </DialogHeader>

          {/* Основная контентная часть */}
          <div className="flex flex-col flex-1 min-h-0 gap-4 overflow-hidden">
            {/* Блок с результатом */}
            {result && (
              <div className="flex flex-col flex-1 min-h-0 rounded-lg border border-border bg-card overflow-hidden">
                {/* Хедер результата */}
                <div className="shrink-0 flex items-center justify-between w-full px-3 py-2 border-b border-border bg-muted/30">
                  <Badge variant="outline" className="font-mono text-xs tracking-wide px-2 py-0.5">
                    {result.protocol}
                  </Badge>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" onClick={copy}>
                        {copied ? <IconCheck className="text-green-500" /> : <IconCopy />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">Скопировать</TooltipContent>
                  </Tooltip>
                </div>

                <div className="flex-1 overflow-auto min-h-0 bg-input-background">
                  <pre
                    className="p-3 text-[13px] font-mono tracking-tight m-0"
                    dangerouslySetInnerHTML={{
                      __html: highlightCode(result.content),
                    }}
                  />
                </div>

                {/* Футер результата с кнопками добавления */}
                <div className="shrink-0 flex gap-2 w-full p-2 border-t border-border bg-muted/10">
                  <Button variant="outline" size="sm" className="flex-1 text-xs gap-1.5" onClick={() => addToConfig('start')}>
                    <IconPlus /> В начало
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1 text-xs gap-1.5" onClick={() => addToConfig('end')}>
                    <IconPlus /> В конец
                  </Button>
                </div>
              </div>
            )}

            {/* Блок ввода*/}
            <div className="shrink-0 flex flex-col gap-3 mt-auto pt-1">
              <InputGroup>
                <InputGroupInput
                  value={uri}
                  onChange={(e) => setUri(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && isValidUri && generate()}
                  placeholder="vless://..."
                  className={uri ? 'pr-7' : ''}
                />
                <InputGroupAddon align="inline-end">
                  {uri && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setUri('')}
                      className="text-muted-foreground hover:text-destructive hover:bg-transparent!"
                    >
                      <IconX size={13} />
                    </Button>
                  )}
                </InputGroupAddon>
              </InputGroup>

              <Button onClick={generate} disabled={!isValidUri} className="w-full">
                Сгенерировать
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
