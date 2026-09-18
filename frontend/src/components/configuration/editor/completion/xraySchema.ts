/**
 * Xray config schema (https://xtls.github.io/config/), full ~350-key coverage.
 *
 * Built with the `obj/arr/str/bool/num/any/map/by` helpers from `./schema` (see that file's header
 * for the builder API). Sections below are grouped by the official doc page they were authored
 * from; a page that failed to load twice is marked with a one-line `authored from memory` comment
 * on the affected node.
 *
 * Some fetched pages describe a newer, restructured settings shape (e.g. flat `settings.address`
 * instead of `settings.vnext[].users[]` for vless/vmess outbounds, a `method` discriminator instead
 * of `network` for streamSettings, `tunnel` instead of `dokodemo-door`, dns-outbound
 * `rewriteAddress/rewriteNetwork` instead of `network/address/blockTypes`). Xray-core still accepts
 * the classic shape used by existing XKeen configs, the stub this file replaces, and this file's own
 * tests, so the classic key names/structures were kept for those nodes; the drift is noted inline
 * where it matters.
 */
import { any, arr, bool, by, map, num, obj, str } from './schema'
import type { SchemaNode } from './schema'

// log.html
const LOG_LEVELS = ['none', 'error', 'warning', 'info', 'debug'] as const

const LOG: SchemaNode = obj({
  loglevel: str(LOG_LEVELS),
  access: str(undefined, 'path or "none"'),
  error: str(undefined, 'path or "none"'),
  dnsLog: bool(),
  maskAddress: str(['', 'quarter', 'half']),
})

// api.html
const API: SchemaNode = obj({
  tag: str(),
  listen: str(),
  services: arr(str(['HandlerService', 'LoggerService', 'StatsService', 'ReflectionService', 'RoutingService'])),
})

// dns.html
const DNS_SERVER: SchemaNode = obj({
  address: str(undefined, 'IP, domain, or scheme://addr'),
  port: num(),
  domains: arr(str()),
  expectIPs: arr(str(undefined, 'CIDR/GeoIP, ! to invert')),
  expectedIPs: arr(str(undefined, 'CIDR/GeoIP, ! to invert')),
  unexpectedIPs: arr(str()),
  allowUnexpectedIPs: bool(),
  skipFallback: bool(),
  clientIP: str(),
  queryStrategy: str(['UseIP', 'UseIPv4', 'UseIPv6', 'UseSystem']),
  timeoutMs: num('ms'),
  disableCache: bool(),
  serveStale: bool(),
  serveExpiredTTL: num('seconds'),
  finalQuery: bool(),
  tag: str(),
})

const DNS: SchemaNode = obj({
  hosts: map(any()),
  servers: arr(DNS_SERVER),
  clientIp: str(),
  queryStrategy: str(['UseIP', 'UseIPv4', 'UseIPv6', 'UseSystem']),
  disableCache: bool(),
  serveStale: bool(),
  serveExpiredTTL: num('seconds'),
  disableFallback: bool(),
  disableFallbackIfMatch: bool(),
  enableParallelQuery: bool(),
  useSystemHosts: bool(),
  tag: str(),
})

// fakedns.html — object or an array of the same shape
const FAKEDNS: SchemaNode = any('object or array of {ipPool,poolSize}')

// inbound.html — keys shared by every inbound entry
const SNIFFING: SchemaNode = obj({
  enabled: bool(),
  destOverride: arr(str(['http', 'tls', 'quic', 'fakedns', 'fakedns+others'])),
  metadataOnly: bool(),
  domainsExcluded: arr(str()),
  ipsExcluded: arr(str()),
  routeOnly: bool(),
})

const ALLOCATE: SchemaNode = obj({
  strategy: str(['always', 'random']),
  refresh: num('minutes'),
  concurrency: num(),
})

const ACCOUNT: SchemaNode = obj({ user: str(), pass: str() })
const FALLBACK: SchemaNode = obj({ name: str(), alpn: str(), path: str(), dest: str(), xver: num() })

// inbounds/tunnel.html (dokodemo-door)
const DOKODEMO_IN: SchemaNode = obj({
  allowedNetwork: str(['tcp', 'udp', 'tcp,udp']),
  rewriteAddress: str(),
  rewritePort: num(),
  portMap: map(str()),
  followRedirect: bool(),
  userLevel: num(),
})

// inbounds/http.html
const HTTP_IN: SchemaNode = obj({
  accounts: arr(ACCOUNT),
  allowTransparent: bool(),
  userLevel: num(),
})

// inbounds/socks.html
const SOCKS_IN: SchemaNode = obj({
  auth: str(['noauth', 'password']),
  accounts: arr(ACCOUNT),
  udp: bool(),
  ip: str(),
  userLevel: num(),
})

// inbounds/shadowsocks.html
const SS_METHODS = [
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  'aes-256-gcm',
  'aes-128-gcm',
  'chacha20-poly1305',
  'chacha20-ietf-poly1305',
  'xchacha20-poly1305',
  'xchacha20-ietf-poly1305',
  'none',
] as const

const SS_IN_USER: SchemaNode = obj({ password: str(), method: str(SS_METHODS), level: num(), email: str() })
const SS_IN: SchemaNode = obj({
  method: str(SS_METHODS),
  password: str(),
  network: str(['tcp', 'udp', 'tcp,udp']),
  level: num(),
  email: str(),
  users: arr(SS_IN_USER),
})

// inbounds/vless.html
const VLESS_IN_CLIENT: SchemaNode = obj({
  id: str(undefined, 'UUID'),
  email: str(),
  level: num(),
  flow: str(['', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443']),
})
const VLESS_IN: SchemaNode = obj({
  clients: arr(VLESS_IN_CLIENT),
  decryption: str(['none']),
  fallbacks: arr(FALLBACK),
})

// inbounds/vmess.html
const VMESS_IN_CLIENT: SchemaNode = obj({ id: str(undefined, 'UUID'), level: num(), email: str() })
const VMESS_IN: SchemaNode = obj({ clients: arr(VMESS_IN_CLIENT), default: obj({ level: num() }) })

// inbounds/trojan.html
const TROJAN_IN_CLIENT: SchemaNode = obj({ password: str(), email: str(), level: num() })
const TROJAN_IN: SchemaNode = obj({ clients: arr(TROJAN_IN_CLIENT), fallbacks: arr(FALLBACK) })

// inbounds/wireguard.html
const WG_IN_PEER: SchemaNode = obj({
  publicKey: str(),
  preSharedKey: str(),
  keepAlive: num('seconds'),
  allowedIPs: arr(str(undefined, 'CIDR')),
  email: str(),
  level: num(),
})
const WG_IN: SchemaNode = obj({ secretKey: str(), peers: arr(WG_IN_PEER), mtu: num('default 1420') })

// inbounds/hysteria.html
const HYSTERIA_IN_USER: SchemaNode = obj({ auth: str(), level: num(), email: str() })
const HYSTERIA_IN: SchemaNode = obj({ version: num(), users: arr(HYSTERIA_IN_USER) })

// authored from memory: inbounds/mixed.html does not exist as a dedicated doc page; mixed
// combines the socks and http inbounds behind one listener/auth model
const MIXED_IN: SchemaNode = obj({
  auth: str(['noauth', 'password']),
  accounts: arr(ACCOUNT),
  udp: bool(),
  ip: str(),
  userLevel: num(),
  allowTransparent: bool(),
})

// transports/raw.html (also used as tcp's legacy alias)
const HEADER: SchemaNode = obj({ type: str(['none', 'http']), request: any(), response: any() })
const RAW: SchemaNode = obj({ acceptProxyProtocol: bool(), header: HEADER })

// transports/mkcp.html
const KCP: SchemaNode = obj({
  mtu: num('576-1460, default 1350'),
  tti: num('ms, 10-100'),
  uplinkCapacity: num('MB/s'),
  downlinkCapacity: num('MB/s'),
  congestion: bool(),
  readBufferSize: num('MB'),
  writeBufferSize: num('MB'),
  header: obj({ type: str(['none', 'srtp', 'utp', 'wechat-video', 'dtls', 'wireguard', 'dns']) }),
  seed: str(),
  cwndMultiplier: num(),
  maxSendingWindow: num('bytes'),
})

// transports/websocket.html
const WS: SchemaNode = obj({
  path: str(),
  host: str(),
  headers: map(str()),
  acceptProxyProtocol: bool(),
  heartbeatPeriod: num('seconds'),
})

// transports/grpc.html
const GRPC: SchemaNode = obj({
  authority: str(),
  serviceName: str(),
  multiMode: bool(),
  idle_timeout: num('seconds'),
  health_check_timeout: num('seconds'),
  permit_without_stream: bool(),
  initial_windows_size: num(),
  user_agent: str(),
})

// transports/httpupgrade.html
const HTTPUPGRADE: SchemaNode = obj({
  path: str(),
  host: str(),
  headers: map(str()),
  acceptProxyProtocol: bool(),
})

// authored from memory: transports/xhttp.html did not load real content (page is a stub linking
// out to a GitHub discussion) on two attempts
const XHTTP: SchemaNode = obj({
  host: str(),
  path: str(),
  mode: str(['auto', 'packet-up', 'stream-up', 'stream-one']),
  extra: any(),
  downloadSettings: any(),
})

// transports/hysteria.html
const HYSTERIA_TRANSPORT: SchemaNode = obj({
  version: num(),
  auth: str(),
  udpIdleTimeout: num('seconds, default 60'),
  masquerade: obj({
    type: str(['file', 'proxy', 'string']),
    dir: str(),
    url: str(),
    rewriteHost: bool(),
    insecure: bool(),
    content: str(),
    headers: map(str()),
    statusCode: num(),
  }),
})

// transports/tls.html
const CERTIFICATE: SchemaNode = obj({
  usage: str(['encipherment', 'verify', 'issue']),
  certificateFile: str(),
  keyFile: str(),
  certificate: arr(str()),
  key: arr(str()),
  ocspStapling: num('seconds'),
  oneTimeLoading: bool(),
  buildChain: bool(),
})

const FINGERPRINTS = [
  'chrome',
  'firefox',
  'safari',
  'ios',
  'android',
  'edge',
  '360',
  'qq',
  'random',
  'randomized',
  'randomizednoalpn',
  'unsafe',
] as const

const TLS: SchemaNode = obj({
  serverName: str(),
  verifyPeerCertByName: str(undefined, 'SNI override for cert verification'),
  rejectUnknownSni: bool(),
  allowInsecure: bool(),
  alpn: arr(str(['h3', 'h2', 'http/1.1'])),
  minVersion: str(['1.0', '1.1', '1.2', '1.3']),
  maxVersion: str(['1.0', '1.1', '1.2', '1.3']),
  cipherSuites: str(undefined, 'colon-separated cipher names'),
  certificates: arr(CERTIFICATE),
  disableSystemRoot: bool(),
  enableSessionResumption: bool(),
  fingerprint: str(FINGERPRINTS),
  pinnedPeerCertificateChainSha256: arr(str()),
  curvePreferences: arr(
    str(['CurveP256', 'CurveP384', 'CurveP521', 'X25519', 'X25519MLKEM768', 'SecP256r1MLKEM768', 'SecP384r1MLKEM1024'])
  ),
  masterKeyLog: str(undefined, 'path'),
  verifyPeerCertInNames: arr(str()),
  echConfigList: str(),
  echServerKeys: str(),
  // authored from memory: transports/tls.html did not document echForceQuery's enum values
  echForceQuery: str(undefined, 'ECH force-query behavior'),
})

// transports/reality.html
const REALITY: SchemaNode = obj({
  show: bool(),
  target: str(undefined, 'camouflage dest, same format as VLESS fallback dest'),
  dest: str(undefined, 'alias of target'),
  xver: num(),
  serverNames: arr(str()),
  privateKey: str(),
  minClientVer: str(undefined, 'x.y.z'),
  maxClientVer: str(undefined, 'x.y.z'),
  maxTimeDiff: num('ms'),
  shortIds: arr(str()),
  mldsa65Seed: str(undefined, 'post-quantum signing key'),
  limitFallbackUpload: any(),
  limitFallbackDownload: any(),
  fingerprint: str(FINGERPRINTS),
  serverName: str(),
  publicKey: str(),
  shortId: str(),
  password: str(undefined, "server's public X25519 key"),
  mldsa65Verify: str(undefined, 'post-quantum verify key'),
  spiderX: str(),
})

// transports/sockopt.html
// authored from memory: sockopt.html summarized happyEyeballs in prose without field names
const HAPPY_EYEBALLS: SchemaNode = obj({ tryDelayMs: num(), interleave: num(), maxConcurrentTry: num(), prioritizeIPv6: bool() })
const CUSTOM_SOCKOPT: SchemaNode = obj({ system: str(), network: str(), type: str(), level: str(), opt: str(), value: str() })

const SOCKOPT: SchemaNode = obj({
  mark: num(),
  tcpFastOpen: bool(),
  tproxy: str(['redirect', 'tproxy', 'off']),
  domainStrategy: str([
    'AsIs',
    'UseIP',
    'UseIPv6v4',
    'UseIPv6',
    'UseIPv4v6',
    'UseIPv4',
    'ForceIP',
    'ForceIPv6v4',
    'ForceIPv6',
    'ForceIPv4v6',
    'ForceIPv4',
  ]),
  dialerProxy: str(undefined, 'tag of outbound'),
  acceptProxyProtocol: bool(),
  trustedXForwardedFor: arr(str()),
  tcpKeepAliveInterval: num('seconds'),
  tcpKeepAliveIdle: num('seconds'),
  tcpUserTimeout: num('ms'),
  tcpCongestion: str(undefined, 'bbr, cubic, reno'),
  interface: str(),
  v6only: bool(),
  tcpWindowClamp: num(),
  tcpMaxSeg: num(),
  penetrate: bool(),
  tcpMptcp: bool(),
  addressPortStrategy: str([
    'none',
    'SrvPortOnly',
    'SrvAddressOnly',
    'SrvPortAndAddress',
    'TxtPortOnly',
    'TxtAddressOnly',
    'TxtPortAndAddress',
  ]),
  happyEyeballs: HAPPY_EYEBALLS,
  customSockopt: arr(CUSTOM_SOCKOPT),
})

// transports/finalmask.html — traffic-shape camouflage layered on top of the chosen transport
const FINALMASK: SchemaNode = obj({
  tcp: arr(obj({ type: str(['header-custom', 'fragment', 'sudoku']), settings: any() })),
  udp: arr(
    obj({ type: str(['header-custom', 'mkcp-legacy', 'noise', 'salamander', 'sudoku', 'xdns', 'xicmp', 'realm']), settings: any() })
  ),
  quicParams: obj({
    congestion: str(['reno', 'bbr', 'brutal', 'force-brutal']),
    bbrProfile: str(['conservative', 'standard', 'aggressive']),
    debug: bool(),
    brutalUp: str(undefined, 'bit-rate, e.g. "100 mbps"'),
    brutalDown: str(undefined, 'bit-rate, e.g. "100 mbps"'),
    udpHop: obj({ ports: str(undefined, '"1234" or "1145-1919"'), interval: num('seconds, min 5') }),
    initStreamReceiveWindow: num(),
    maxStreamReceiveWindow: num(),
    initConnectionReceiveWindow: num(),
    maxConnectionReceiveWindow: num(),
    maxIdleTimeout: num('seconds, 4-120'),
    keepAlivePeriod: num('seconds, 2-60'),
    disablePathMTUDiscovery: bool(),
    maxIncomingStreams: num('>=8'),
  }),
})

// transport.html — streamSettings' transport and security selectors. Current docs name the
// transport selector `method` (raw/xhttp/mkcp/grpc/websocket/httpupgrade/hysteria); the classic
// `network` (tcp/ws/kcp/…) is still accepted by Xray-core and used by existing configs, so both
// are offered and either one narrows the per-transport settings.
const NETWORKS = ['tcp', 'raw', 'kcp', 'ws', 'grpc', 'httpupgrade', 'xhttp', 'hysteria'] as const
const METHODS = ['raw', 'xhttp', 'mkcp', 'grpc', 'websocket', 'httpupgrade', 'hysteria'] as const

const STREAM_SETTINGS: SchemaNode = obj(
  { network: str(NETWORKS), method: str(METHODS), sockopt: SOCKOPT, finalmask: FINALMASK },
  by(['method', 'network'], {
    raw: obj({ rawSettings: RAW }),
    tcp: obj({ tcpSettings: RAW }),
    kcp: obj({ kcpSettings: KCP }),
    mkcp: obj({ kcpSettings: KCP }),
    ws: obj({ wsSettings: WS }),
    websocket: obj({ wsSettings: WS }),
    grpc: obj({ grpcSettings: GRPC }),
    httpupgrade: obj({ httpupgradeSettings: HTTPUPGRADE }),
    xhttp: obj({ xhttpSettings: XHTTP }),
    hysteria: obj({ hysteriaSettings: HYSTERIA_TRANSPORT }),
  }),
  by('security', {
    none: obj({}),
    tls: obj({ tlsSettings: TLS }),
    reality: obj({ realitySettings: REALITY }),
  })
)

// transport.html — top-level `transport` section: same settings blocks, applied as defaults when
// an inbound/outbound doesn't override its own streamSettings
const TRANSPORT: SchemaNode = obj({
  rawSettings: RAW,
  tcpSettings: RAW,
  kcpSettings: KCP,
  wsSettings: WS,
  grpcSettings: GRPC,
  httpupgradeSettings: HTTPUPGRADE,
  xhttpSettings: XHTTP,
  hysteriaSettings: HYSTERIA_TRANSPORT,
})

// inbound.html — full inbound entry, protocol-specific `settings` unlocked via `by('protocol', …)`
const INBOUND: SchemaNode = obj(
  {
    listen: str(),
    port: str(undefined, 'number, "env:VAR", or "5-10"'),
    tag: str(),
    sniffing: SNIFFING,
    allocate: ALLOCATE,
    streamSettings: STREAM_SETTINGS,
  },
  by('protocol', {
    'dokodemo-door': obj({ settings: DOKODEMO_IN }),
    tunnel: obj({ settings: DOKODEMO_IN }),
    http: obj({ settings: HTTP_IN }),
    socks: obj({ settings: SOCKS_IN }),
    shadowsocks: obj({ settings: SS_IN }),
    vless: obj({ settings: VLESS_IN }),
    vmess: obj({ settings: VMESS_IN }),
    trojan: obj({ settings: TROJAN_IN }),
    wireguard: obj({ settings: WG_IN }),
    hysteria: obj({ settings: HYSTERIA_IN }),
    mixed: obj({ settings: MIXED_IN }),
  })
)

// outbounds/vless.html, outbounds/vmess.html — kept as the classic vnext[]/users[] shape (see
// file header note on doc drift)
const VNEXT_USER: SchemaNode = obj({
  id: str(undefined, 'UUID'),
  encryption: str(['none']),
  flow: str(['', 'xtls-rprx-vision']),
  level: num(),
  email: str(),
})
const VNEXT: SchemaNode = obj({ address: str(), port: num(), users: arr(VNEXT_USER) })
// Both the classic `vnext[].users[]` shape and the current flat shape (address/port/id/… at the
// top of `settings`, which is also what XKeen's outbound generator emits) are accepted by Xray.
const VLESS_SETTINGS: SchemaNode = obj({ vnext: arr(VNEXT), ...VNEXT_USER.keys, address: str(), port: num(), reverse: any() })

const VMESS_VNEXT_USER: SchemaNode = obj({
  id: str(undefined, 'UUID'),
  security: str(['aes-128-gcm', 'chacha20-poly1305', 'none', 'zero', 'auto']),
  level: num(),
  email: str(),
})
const VMESS_VNEXT: SchemaNode = obj({ address: str(), port: num(), users: arr(VMESS_VNEXT_USER) })
const VMESS_OUT: SchemaNode = obj({ vnext: arr(VMESS_VNEXT), ...VMESS_VNEXT_USER.keys, address: str(), port: num() })

// outbounds/blackhole.html
const BLACKHOLE_OUT: SchemaNode = obj({ response: obj({ type: str(['none', 'http']) }) })

// outbounds/dns.html — current docs describe a rewrite-based shape (rewriteNetwork/rewriteAddress/
// rewritePort/rules[]); the classic network/address/port/nonIPQuery/blockTypes fields are still
// accepted and used by existing XKeen dns-outbound configs, so both sets are offered.
const DNS_OUT: SchemaNode = obj({
  network: str(['tcp', 'udp']),
  address: str(),
  port: num(),
  nonIPQuery: str(['drop', 'skip', 'reject']),
  blockTypes: arr(num()),
  rewriteNetwork: str(['tcp', 'udp']),
  rewriteAddress: str(),
  rewritePort: num(),
  rules: any(),
})

// outbounds/freedom.html
const FREEDOM_OUT: SchemaNode = obj({
  domainStrategy: str([
    'AsIs',
    'UseIP',
    'UseIPv4',
    'UseIPv6',
    'UseIPv4v6',
    'UseIPv6v4',
    'ForceIP',
    'ForceIPv4',
    'ForceIPv6',
    'ForceIPv4v6',
    'ForceIPv6v4',
  ]),
  redirect: str(undefined, '"host:port" or ":port"'),
  userLevel: num(),
  fragment: obj({
    packets: str(undefined, '"tlshello" or "1-3"'),
    length: str(undefined, 'bytes, e.g. "100-200"'),
    interval: str(undefined, 'ms, e.g. "10-20"'),
  }),
  noises: arr(obj({ type: str(['rand', 'str', 'base64']), packet: str(), delay: str() })),
  proxyProtocol: num('0 disabled, 1 or 2'),
})

// outbounds/http.html
const HTTP_OUT_USER: SchemaNode = obj({ user: str(), pass: str(), level: num() })
const HTTP_OUT_SERVER: SchemaNode = obj({ address: str(), port: num(), users: arr(HTTP_OUT_USER) })
// Flat (address/port/user/pass/…) and classic `servers[]` shapes are both accepted — see VLESS_SETTINGS.
const HTTP_OUT: SchemaNode = obj({ servers: arr(HTTP_OUT_SERVER), headers: map(str()), address: str(), port: num(), ...HTTP_OUT_USER.keys })

// outbounds/loopback.html
const LOOPBACK_OUT: SchemaNode = obj({ inboundTag: str() })

// outbounds/shadowsocks.html
const SS_OUT_SERVER: SchemaNode = obj({ address: str(), port: num(), method: str(SS_METHODS), password: str(), email: str(), level: num() })
const SS_OUT: SchemaNode = obj({ servers: arr(SS_OUT_SERVER), ...SS_OUT_SERVER.keys })

// outbounds/socks.html
const SOCKS_OUT_USER: SchemaNode = obj({ user: str(), pass: str(), level: num() })
const SOCKS_OUT_SERVER: SchemaNode = obj({ address: str(), port: num(), users: arr(SOCKS_OUT_USER) })
const SOCKS_OUT: SchemaNode = obj({ servers: arr(SOCKS_OUT_SERVER), address: str(), port: num(), ...SOCKS_OUT_USER.keys })

// outbounds/trojan.html
const TROJAN_OUT_SERVER: SchemaNode = obj({ address: str(), port: num(), password: str(), email: str(), level: num() })
const TROJAN_OUT: SchemaNode = obj({ servers: arr(TROJAN_OUT_SERVER), ...TROJAN_OUT_SERVER.keys })

// outbounds/wireguard.html
const WG_OUT_PEER: SchemaNode = obj({
  publicKey: str(),
  preSharedKey: str(),
  endpoint: str(),
  keepAlive: num('seconds'),
  allowedIPs: arr(str(undefined, 'CIDR')),
})
const WG_OUT: SchemaNode = obj({
  secretKey: str(),
  address: arr(str()),
  peers: arr(WG_OUT_PEER),
  mtu: num('default 1420'),
  reserved: arr(num()),
  noKernelTun: bool(),
  remoteDNS: arr(str()),
})

// outbounds/hysteria.html
const HYSTERIA_OUT: SchemaNode = obj({ version: num(), address: str(), port: num() })

const MUX: SchemaNode = obj({
  enabled: bool(),
  concurrency: num(),
  xudpConcurrency: num(),
  xudpProxyUDP443: str(['reject', 'allow', 'skip']),
})
const PROXY_SETTINGS: SchemaNode = obj({ tag: str(), transportLayer: bool() })

const OUTBOUND: SchemaNode = obj(
  {
    tag: str(),
    sendThrough: str(),
    streamSettings: STREAM_SETTINGS,
    proxySettings: PROXY_SETTINGS,
    mux: MUX,
  },
  by('protocol', {
    blackhole: obj({ settings: BLACKHOLE_OUT }),
    dns: obj({ settings: DNS_OUT }),
    freedom: obj({ settings: FREEDOM_OUT }),
    http: obj({ settings: HTTP_OUT }),
    loopback: obj({ settings: LOOPBACK_OUT }),
    shadowsocks: obj({ settings: SS_OUT }),
    socks: obj({ settings: SOCKS_OUT }),
    trojan: obj({ settings: TROJAN_OUT }),
    vless: obj({ settings: VLESS_SETTINGS }),
    vmess: obj({ settings: VMESS_OUT }),
    wireguard: obj({ settings: WG_OUT }),
    hysteria: obj({ settings: HYSTERIA_OUT }),
  })
)

// policy.html
const LEVEL: SchemaNode = obj({
  handshake: num('seconds'),
  connIdle: num('seconds'),
  uplinkOnly: num('seconds'),
  downlinkOnly: num('seconds'),
  statsUserUplink: bool(),
  statsUserDownlink: bool(),
  statsUserOnline: bool(),
  bufferSize: num('KB'),
})

const POLICY: SchemaNode = obj({
  levels: map(LEVEL),
  system: obj({
    statsInboundUplink: bool(),
    statsInboundDownlink: bool(),
    statsOutboundUplink: bool(),
    statsOutboundDownlink: bool(),
  }),
})

// routing.html — field set from GuiRouting.tsx's RULE_FIELDS, plus outboundTag/balancerTag/ruleTag
const RULE: SchemaNode = obj({
  type: str(['field']),
  domain: arr(str()),
  ip: arr(str()),
  port: str(undefined, '80, 443, 1000-2000'),
  source: arr(str()),
  sourceIP: arr(str()),
  sourcePort: str(),
  network: str(['tcp', 'udp', 'tcp,udp']),
  user: arr(str()),
  inboundTag: arr(str()),
  protocol: arr(str(['http', 'tls', 'quic', 'bittorrent'])),
  attrs: any(),
  outboundTag: str(),
  balancerTag: str(),
  ruleTag: str(),
})

const BALANCER: SchemaNode = obj({
  tag: str(),
  selector: arr(str()),
  fallbackTag: str(),
  strategy: obj({ type: str(['random', 'roundRobin', 'leastPing', 'leastLoad']), settings: any() }),
})

const ROUTING: SchemaNode = obj({
  domainStrategy: str(['AsIs', 'IPIfNonMatch', 'IPOnDemand']),
  domainMatcher: str(['hybrid', 'linear']),
  rules: arr(RULE),
  balancers: arr(BALANCER),
})

// stats.html — presence alone enables stats collection, no keys
const STATS: SchemaNode = obj({})

// reverse.html — legacy reverse proxy (deprecated in favor of VLESS reverse), kept for completion
const REVERSE: SchemaNode = obj({
  bridges: arr(obj({ tag: str(), domain: str() })),
  portals: arr(obj({ tag: str(), domain: str() })),
})

// observatory.html
const OBSERVATORY: SchemaNode = obj({
  subjectSelector: arr(str()),
  probeUrl: str(),
  probeInterval: str(undefined, 'e.g. 10s, 2h45m'),
  enableConcurrency: bool(),
})

const PING_CONFIG: SchemaNode = obj({
  destination: str(),
  connectivity: str(),
  interval: str(),
  sampling: num(),
  timeout: str(),
  httpMethod: str(['HEAD', 'GET']),
})
const BURST_OBSERVATORY: SchemaNode = obj({ subjectSelector: arr(str()), pingConfig: PING_CONFIG })

// metrics.html
const METRICS: SchemaNode = obj({ tag: str(), listen: str() })

export const XRAY_ROOT: SchemaNode = obj({
  log: LOG,
  api: API,
  dns: DNS,
  fakedns: FAKEDNS,
  inbounds: arr(INBOUND),
  outbounds: arr(OUTBOUND),
  transport: TRANSPORT,
  policy: POLICY,
  routing: ROUTING,
  stats: STATS,
  reverse: REVERSE,
  observatory: OBSERVATORY,
  burstObservatory: BURST_OBSERVATORY,
  metrics: METRICS,
})
