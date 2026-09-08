import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/utils'
import { IconCheck, IconCopy, IconFileUpload, IconPlus, IconX } from '@tabler/icons-react'
import * as jsyaml from 'js-yaml'
import { useRef, useState } from 'react'
import { useModalContext, useAppContext } from '../../lib/store'

type AmneziaVersion = '1.0' | '1.5' | '2.0' | '3.0' | '3.1'

interface DetectedAmneziaVersion {
  version: AmneziaVersion
  confidence: 'exact' | 'minimum'
}

interface Props {
  onAddToConfig: (content: string, type: string, position: 'start' | 'end') => void
}

interface AmneziaConfig {
  interface: Record<string, string>
  peers: Array<Record<string, string>>
  detectedVersion: DetectedAmneziaVersion
}

function detectAmneziaVersion(iface: Record<string, string>): DetectedAmneziaVersion {
  /*
   * Explicit Version has the highest priority.
   */
  if (iface.Version) {
    const version = iface.Version.trim()

    if (['1', '1.0'].includes(version)) {
      return {
        version: '1.0',
        confidence: 'exact',
      }
    }

    if (version === '1.5') {
      return {
        version: '1.5',
        confidence: 'exact',
      }
    }

    if (['2', '2.0'].includes(version)) {
      return {
        version: '2.0',
        confidence: 'exact',
      }
    }

    if (['3', '3.0'].includes(version)) {
      return {
        version: '3.0',
        confidence: 'exact',
      }
    }

    if (version === '3.1') {
      return {
        version: '3.1',
        confidence: 'exact',
      }
    }

    throw new Error(`Неподдерживаемая версия AmneziaWG: ${version}`)
  }

  /*
   * AWG 3.1
   *
   * This params was be added in 3.1.
   */
  if (hasAny(iface, ['RandomTrailers', 'DisableCookies'])) {
    return {
      version: '3.1',
      confidence: 'minimum',
    }
  }

  /*
   * AWG 3.0+
   */
  if (
    hasAny(iface, [
      'HeaderProtectionKey',
      'ContentPaddingAddition',
      'RekeyAfterTime',
      'RekeyTimeout',
      'RejectAfterTime',
      'KeepaliveTimeout',
      'MaxHandshakeAttempts',
    ])
  ) {
    return {
      version: '3.0',
      confidence: 'minimum',
    }
  }

  /*
   * AWG 1.5+ / 2.x
   *
   * S3/S4 and I1-I5 was added from 1.5 version.
   *
   * If exists old J1-J3/ITime,
   * this allows to recognize exactly 1.5.
   */
  if (hasAny(iface, ['J1', 'J2', 'J3', 'Itime'])) {
    return {
      version: '1.5',
      confidence: 'minimum',
    }
  }

  /*
   * If there are S3/S4/I1-I5, this is already definitely not 1.0.
   *
   * But without Version it is impossible to reliably distinguish
   * AWG 1.5 from AWG 2.0.
   *
   * Therefore we choose 2.0 as the modern legacy branch,
   * but confidence = minimum.
   */
  if (hasAny(iface, ['S3', 'S4', 'I1', 'I2', 'I3', 'I4', 'I5'])) {
    return {
      version: '2.0',
      confidence: 'minimum',
    }
  }

  /*
   * AWG 1.0 remaining.
   */
  if (hasAny(iface, ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'H1', 'H2', 'H3', 'H4'])) {
    return {
      version: '1.0',
      confidence: 'minimum',
    }
  }

  throw new Error('Не удалось определить версию AmneziaWG: параметры AWG не найдены')
}

function hasAny(obj: Record<string, string>, keys: string[]): boolean {
  return keys.some((key) => obj[key] != null && obj[key] !== '')
}

function parseAmneziaConfig(content: string): AmneziaConfig {
  const sections: Record<string, Record<string, string>> = {}
  let currentSection = ''

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#') || line.startsWith(';')) continue

    const sectionMatch = line.match(/^\[([^\]]+)]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim()

      if (!sections[currentSection]) {
        sections[currentSection] = {}
      }

      continue
    }

    const separator = line.indexOf('=')

    if (separator === -1 || !currentSection) continue

    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()

    sections[currentSection][key] = value
  }

  const iface = sections.Interface

  if (!iface) {
    throw new Error('Секция [Interface] не найдена')
  }

  const peers = Object.entries(sections)
    .filter(([section]) => /^Peer(?:\s+\d+)?$/i.test(section))
    .map(([, values]) => values)

  if (!peers.length) {
    throw new Error('Секция [Peer] не найдена')
  }

  if (!iface.PrivateKey) {
    throw new Error('В [Interface] отсутствует PrivateKey')
  }

  const detectedVersion = detectAmneziaVersion(iface)

  return {
    interface: iface,
    peers,
    detectedVersion,
  }
}

function parseEndpoint(endpoint: string): { server: string; port: number } {
  const value = endpoint.trim()

  // [2001:db8::1]:51820
  const ipv6 = value.match(/^\[([^\]]+)]:(\d+)$/)

  if (ipv6) {
    return {
      server: ipv6[1],
      port: Number(ipv6[2]),
    }
  }

  // example.com:51820 / 1.2.3.4:51820
  const separator = value.lastIndexOf(':')

  if (separator === -1) {
    throw new Error(`Некорректный Endpoint: ${endpoint}`)
  }

  const server = value.slice(0, separator).trim()
  const port = Number(value.slice(separator + 1).trim())

  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Некорректный Endpoint: ${endpoint}`)
  }

  return { server, port }
}

function splitList(value?: string): string[] {
  if (!value) return []

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseNumber(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined

  const result = Number(value)

  if (!Number.isFinite(result)) {
    throw new Error(`Некорректное числовое значение: ${value}`)
  }

  return result
}

function parseRange(value: string | undefined): number | undefined {
  if (!value) {
    return undefined
  }

  const trimmed = value.trim()

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed)
  }

  const splittedRange = trimmed.split('-').map((part) => +part)

  if (splittedRange) {
    const ceilMin = Math.ceil(splittedRange[0])
    const floorMax = Math.floor(splittedRange[1])

    return Math.floor(Math.random() * (floorMax - ceilMin + 1)) + ceilMin
  }

  throw new Error(`Некорректное числовое значение: ${value}`)
}

function toMihomoKey(key: string): string {
  const map: Record<string, string> = {
    Version: 'version',
    Jc: 'jc',
    Jmin: 'jmin',
    Jmax: 'jmax',
    S1: 's1',
    S2: 's2',
    S3: 's3',
    S4: 's4',
    H1: 'h1',
    H2: 'h2',
    H3: 'h3',
    H4: 'h4',
    I1: 'i1',
    I2: 'i2',
    I3: 'i3',
    I4: 'i4',
    I5: 'i5',
    HeaderProtectionKey: 'header-protection-key',
    ContentPaddingAddition: 'content-padding-addition',
    RekeyAfterTime: 'rekey-after-time',
    RekeyTimeout: 'rekey-timeout',
    RejectAfterTime: 'reject-after-time',
    KeepaliveTimeout: 'keepalive-timeout',
    MaxHandshakeAttempts: 'max-handshake-attempts',
    RandomTrailers: 'random-trailers',
    DisableCookies: 'disable-cookies',
  }

  return map[key] ?? key
}

const AMNEZIA_OPTIONS = new Set([
  'Version',

  'Jc',
  'Jmin',
  'Jmax',

  'S1',
  'S2',
  'S3',
  'S4',

  'H1',
  'H2',
  'H3',
  'H4',

  'I1',
  'I2',
  'I3',
  'I4',
  'I5',

  'HeaderProtectionKey',
  'ContentPaddingAddition',

  'RekeyAfterTime',
  'RekeyTimeout',
  'RejectAfterTime',
  'KeepaliveTimeout',
  'MaxHandshakeAttempts',

  'RandomTrailers',
  'DisableCookies',
])

function createAmneziaOptions(
  iface: Record<string, string>,
  detectedVersion: DetectedAmneziaVersion
): Record<string, string | number | boolean> {
  const options: Record<string, string | number | boolean> = {
    version: detectedVersion.version === '3.0' || detectedVersion.version === '3.1' ? 3 : 2,
  }

  for (const key of AMNEZIA_OPTIONS) {
    const value = iface[key]

    if (value == null || value === '') {
      continue
    }

    const mihomoKey = toMihomoKey(key)

    if (key === 'RandomTrailers' || key === 'DisableCookies') {
      const normalized = value.toLowerCase()

      options[mihomoKey] = normalized === 'true' || normalized === 'on' || normalized === '1'

      continue
    }

    if (
      key === 'Jc' ||
      key === 'Jmin' ||
      key === 'Jmax' ||
      key === 'S1' ||
      key === 'S2' ||
      key === 'S3' ||
      key === 'S4' ||
      key === 'Version'
    ) {
      options[mihomoKey] = Number(value)
      continue
    }

    options[mihomoKey] = value
  }

  return options
}

function indentYaml(yaml: string, spaces: number): string {
  const indentation = ' '.repeat(spaces)

  return yaml
    .split('\n')
    .map((line) => (line ? indentation + line : line))
    .join('\n')
}

function addMtuComment(yaml: string): string {
  return yaml.replace(/^(\s*)(mtu:\s+\S+)$/gm, '$1# В случае недоступности сети, попробуйте увеличить MTU до 1420 или 1500\n$1$2')
}

function convertToMihomo(config: AmneziaConfig, fileName: string): string {
  const iface = config.interface

  const address = splitList(iface.Address)
  const dns = splitList(iface.DNS)

  if (!address.length) {
    throw new Error('В [Interface] отсутствует Address')
  }

  if (!iface.PrivateKey) {
    throw new Error('В [Interface] отсутствует PrivateKey')
  }

  const proxies = config.peers.map((peer, index) => {
    if (!peer.Endpoint) {
      throw new Error(`[Peer ${index + 1}] отсутствует Endpoint`)
    }

    if (!peer.PublicKey) {
      throw new Error(`[Peer ${index + 1}] отсутствует PublicKey`)
    }

    const { server, port } = parseEndpoint(peer.Endpoint)

    const proxy: Record<string, unknown> = {
      name: config.peers.length === 1 ? fileName.replace(/\.[^.]+$/, '') : `${fileName.replace(/\.[^.]+$/, '')}_${index + 1}`,

      type: 'wireguard',

      server,
      port,

      ip: address[0],

      'private-key': iface.PrivateKey,
      'public-key': peer.PublicKey,

      udp: true,

      mtu: iface.MTU ? parseNumber(iface.MTU) : 1280,
    }

    if (dns.length) {
      proxy.dns = dns
    }

    const allowedIps = splitList(peer.AllowedIPs)

    if (allowedIps.length) {
      proxy['allowed-ips'] = allowedIps
    }

    if (peer.PresharedKey) {
      proxy['pre-shared-key'] = peer.PresharedKey
    }

    if (peer.PersistentKeepalive) {
      proxy['persistent-keepalive'] = parseRange(peer.PersistentKeepalive)
    }

    const amneziaOptions = createAmneziaOptions(iface, config.detectedVersion)

    if (Object.keys(amneziaOptions).length) {
      proxy['amnezia-wg-option'] = amneziaOptions
    }

    return proxy
  })

  const yaml = jsyaml.dump(proxies, {
    noRefs: true,
    lineWidth: -1,
  })

  const indentedYaml = indentYaml(yaml, 2)

  if (!iface.MTU) {
    return addMtuComment(indentedYaml)
  }

  return indentedYaml
}

export function ImportAmneziaModal({ onAddToConfig }: Props) {
  const { showToast } = useAppContext()
  const { modals, dispatch } = useModalContext()

  const inputRef = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<string>('')
  const [copied, setCopied] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [detectedVersion, setDetectedVersion] = useState<DetectedAmneziaVersion | null>(null)

  function reset() {
    setFile(null)
    setResult('')
    setCopied(false)

    if (inputRef.current) {
      inputRef.current.value = ''
    }
  }

  function close() {
    dispatch({
      type: 'SHOW_MODAL',
      modal: 'showImportAmneziaModal',
      show: false,
    })

    setTimeout(reset, 300)
  }

  async function parseFile(selectedFile: File) {
    setResult('')
    setFile(selectedFile)

    try {
      const content = await selectedFile.text()

      const config = parseAmneziaConfig(content)

      setDetectedVersion(config.detectedVersion)

      const generated = convertToMihomo(config, selectedFile.name)

      setResult(generated)
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось обработать конфигурацию Amnezia'
      showToast({ title: 'Ошибка импорта', body: message }, 'error')
      setFile(null)
    }
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.target.files?.[0]

    if (selectedFile) {
      void parseFile(selectedFile)
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setIsDragging(false)

    const droppedFile = event.dataTransfer.files?.[0]

    if (droppedFile) {
      void parseFile(droppedFile)
    }
  }

  async function copy() {
    if (!result) return

    const ok = await copyText(result)

    if (!ok) {
      showToast('Ошибка копирования', 'error')
      return
    }

    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function addToConfig(position: 'start' | 'end') {
    if (!result) return

    onAddToConfig(result, 'proxy', position)
    close()
  }

  return (
    <TooltipProvider delayDuration={500}>
      <Dialog open={modals.showImportAmneziaModal} onOpenChange={(open) => !open && close()}>
        <DialogContent className="flex max-h-[90dvh] w-auto! max-w-[min(90vw,900px)]! min-w-[min(90vw,480px)]! flex-col overflow-hidden">
          <DialogHeader className="shrink-0 pb-1">
            <DialogTitle className="flex items-center gap-2 pb-2">
              <IconFileUpload size={24} className="text-chart-2" />
              Импорт AmneziaWG
            </DialogTitle>

            <DialogDescription>Выберите конфигурацию AmneziaWG (.conf) для преобразования в формат Mihomo</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
            {!result && (
              <Empty
                className={[
                  'min-h-48 cursor-pointer border p-6 transition-colors',
                  isDragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20 hover:bg-muted/40',
                ].join(' ')}
                onClick={() => inputRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault()
                  setIsDragging(true)
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
              >
                <input ref={inputRef} type="file" accept=".conf,.cfg,text/plain" className="hidden" onChange={handleFileChange} />

                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <IconFileUpload className="size-6" />
                  </EmptyMedia>
                  <EmptyTitle>Перетащите файл .conf сюда</EmptyTitle>
                  <EmptyDescription>или нажмите для выбора файла</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {file && !result && <div className="text-muted-foreground text-center text-xs">Обработка файла «{file.name}»…</div>}

            {result && (
              <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
                <div className="border-border bg-muted/30 flex w-full shrink-0 items-center justify-between border-b px-3 py-1">
                  <div>
                    <Badge className="bg-blue-500/10! px-2 pt-2.25 pb-2.5 text-[10px] tracking-wider text-blue-400">
                      WIREGUARD / AMNEZIAWG
                    </Badge>

                    {detectedVersion && (
                      <Badge
                        className="ml-2 bg-green-500/10! px-2 pt-2.25 pb-2.5 text-[10px] tracking-wider text-green-400"
                        variant={detectedVersion.confidence === 'exact' ? 'default' : 'secondary'}
                      >
                        AWG {detectedVersion.version} {detectedVersion.confidence === 'minimum' && '+'}
                      </Badge>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" onClick={copy}>
                            {copied ? <IconCheck className="text-green-500" /> : <IconCopy className="size-4.5" />}
                          </Button>
                        }
                      />
                      <TooltipContent side="left">Скопировать</TooltipContent>
                    </Tooltip>

                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" onClick={reset}>
                            <IconX className="size-4.5" />
                          </Button>
                        }
                      />
                      <TooltipContent side="left">Выбрать другой файл</TooltipContent>
                    </Tooltip>
                  </div>
                </div>

                <div className="bg-input-background min-h-0 flex-1 overflow-auto">
                  <pre className="m-0 p-3 font-mono text-[13px] tracking-tight">{result}</pre>
                </div>

                <div className="border-border bg-muted/10 flex w-full shrink-0 gap-2 border-t p-2">
                  <Button variant="outline" size="sm" className="flex-1 gap-1.5 text-xs" onClick={() => addToConfig('start')}>
                    <IconPlus />В начало
                  </Button>

                  <Button variant="outline" size="sm" className="flex-1 gap-1.5 text-xs" onClick={() => addToConfig('end')}>
                    <IconPlus />В конец
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}
