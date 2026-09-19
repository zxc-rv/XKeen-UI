/**
 * Mihomo (Clash Meta) config.yaml schema (https://wiki.metacubex.one/config/), for the
 * context-aware YAML autocompletion engine in `./schema.ts`.
 *
 * Sections mirror the doc site's structure: general root scalars, `dns`, `sniffer`, `ntp`,
 * `experimental`, `tun`, `proxies` (by `type`), `proxy-groups` (by `type`), `proxy-providers`
 * (by `type`), `rule-providers` (by `type`), `rules`/`sub-rules`/`payload` (rule-type strings),
 * `listeners` (by `type`) and `tunnels`. Shared sub-objects (TLS, transport, smux, …) are
 * factored into `const`s and spread into the cases that use them to stay DRY.
 */
import { any, arr, bool, by, map, num, obj, str } from './schema'
import type { SchemaNode } from './schema'

// rules/ — the complete rule-type prefix list (used by `rules`, `sub-rules` and `payload`).
const RULE_TYPES = [
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'DOMAIN-WILDCARD',
  'GEOSITE',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-SUFFIX',
  'IP-ASN',
  'GEOIP',
  'SRC-GEOIP',
  'SRC-IP-ASN',
  'SRC-IP-CIDR',
  'SRC-IP-SUFFIX',
  'DST-PORT',
  'SRC-PORT',
  'IN-PORT',
  'IN-TYPE',
  'IN-USER',
  'IN-NAME',
  'PROCESS-PATH',
  'PROCESS-PATH-REGEX',
  'PROCESS-NAME',
  'PROCESS-NAME-REGEX',
  'UID',
  'NETWORK',
  'DSCP',
  'RULE-SET',
  'AND',
  'OR',
  'NOT',
  'SUB-RULE',
  'MATCH',
] as const

const CLIENT_FINGERPRINTS = ['chrome', 'firefox', 'safari', 'iOS', 'android', 'edge', '360', 'qq', 'random'] as const

// proxies/ss/, proxies/ssr/ — shadowsocks cipher + plugin enums (shared by ss/ssr proxies and
// the shadowsocks listener).
const SS_CIPHERS = [
  'aes-128-ctr',
  'aes-192-ctr',
  'aes-256-ctr',
  'aes-128-cfb',
  'aes-192-cfb',
  'aes-256-cfb',
  'aes-128-gcm',
  'aes-192-gcm',
  'aes-256-gcm',
  'aes-128-ccm',
  'aes-192-ccm',
  'aes-256-ccm',
  'aes-128-gcm-siv',
  'aes-256-gcm-siv',
  'chacha20-ietf',
  'chacha20',
  'xchacha20',
  'chacha20-ietf-poly1305',
  'xchacha20-ietf-poly1305',
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
  'lea-128-gcm',
  'lea-192-gcm',
  'lea-256-gcm',
  'rabbit128-poly1305',
  'aegis-128l',
  'aegis-256',
  'rc4-md5',
  'none',
] as const

const SS_PLUGINS = ['obfs', 'v2ray-plugin', 'gost-plugin', 'shadow-tls', 'restls', 'kcptun', 'jls'] as const

// proxies/transport/ — transport sub-objects shared by vmess/vless/trojan(/listeners).
const WS_OPTS: SchemaNode = obj({
  path: str(),
  headers: map(str()),
  'max-early-data': num(),
  'early-data-header-name': str(),
  'v2ray-http-upgrade': bool(),
  'v2ray-http-upgrade-fast-open': bool(),
})

const GRPC_OPTS: SchemaNode = obj({
  'grpc-service-name': str(),
  'grpc-user-agent': str(),
  'ping-interval': num(),
  'max-connections': num(),
  'min-streams': num(),
  'max-streams': num(),
})

const H2_OPTS: SchemaNode = obj({ host: arr(str()), path: str() })

const HTTP_OPTS: SchemaNode = obj({ method: str(), path: arr(str()), headers: map(arr(str())) })

// proxies/tls/ — REALITY / ECH sub-objects shared by vmess/vless/trojan(/listeners).
const REALITY_OPTS: SchemaNode = obj({
  'public-key': str(),
  'short-id': str(),
  'support-x25519mlkem768': bool(),
})

const ECH_OPTS: SchemaNode = obj({ enable: bool(), config: str(), 'query-server-name': str() })

// proxies/ (common) — smux (stream multiplexing), shared by every TCP-capable proxy type.
const SMUX: SchemaNode = obj({
  enabled: bool(),
  protocol: str(['smux', 'yamux', 'h2mux']),
  'max-connections': num(),
  'min-streams': num(),
  'max-streams': num(),
  statistic: bool(),
  'only-tcp': bool(),
  padding: bool(),
  'brutal-opts': obj({ enabled: bool(), up: str(), down: str() }),
})

// proxies/ — keys shared by every proxy type.
const PROXY_COMMON = {
  name: str(),
  server: str(),
  port: num(),
  udp: bool(),
  'ip-version': str(['dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer']),
  'interface-name': str(),
  'routing-mark': num(),
  tfo: bool(),
  mptcp: bool(),
  'dialer-proxy': str(),
  smux: SMUX,
}

// proxies/vmess/, proxies/vless/ — `servername`-flavoured TLS + transport keys.
const VMESS_VLESS_TLS = {
  tls: bool(),
  servername: str(),
  alpn: arr(str()),
  fingerprint: str(),
  'client-fingerprint': str(CLIENT_FINGERPRINTS),
  'skip-cert-verify': bool(),
  'reality-opts': REALITY_OPTS,
  'ech-opts': ECH_OPTS,
}

const VMESS_VLESS_TRANSPORT = {
  network: str(['tcp', 'ws', 'grpc', 'h2', 'http', 'httpupgrade']),
  'ws-opts': WS_OPTS,
  'grpc-opts': GRPC_OPTS,
  'h2-opts': H2_OPTS,
  'http-opts': HTTP_OPTS,
}

const PROXY: SchemaNode = obj(
  PROXY_COMMON,
  by('type', {
    // proxies/ss/
    ss: obj({
      cipher: str(SS_CIPHERS),
      password: str(),
      'udp-over-tcp': bool(),
      'udp-over-tcp-version': num(),
      plugin: str(SS_PLUGINS),
      'plugin-opts': any(),
    }),
    // proxies/ssr/
    ssr: obj({
      cipher: str(SS_CIPHERS),
      password: str(),
      obfs: str(),
      protocol: str(),
      'obfs-param': str(),
      'protocol-param': str(),
    }),
    // proxies/vmess/
    vmess: obj({
      uuid: str(),
      alterId: num(),
      cipher: str(['auto', 'none', 'zero', 'aes-128-gcm', 'chacha20-poly1305']),
      'packet-encoding': str(['packetaddr', 'xudp']),
      'global-padding': bool(),
      'authenticated-length': bool(),
      ...VMESS_VLESS_TLS,
      ...VMESS_VLESS_TRANSPORT,
    }),
    // proxies/vless/
    vless: obj({
      uuid: str(),
      flow: str(['xtls-rprx-vision']),
      'packet-encoding': str(['packetaddr', 'xudp']),
      encryption: str(),
      ...VMESS_VLESS_TLS,
      ...VMESS_VLESS_TRANSPORT,
      network: str(['tcp', 'ws', 'grpc', 'h2', 'http', 'httpupgrade', 'xhttp']),
      'xhttp-opts': any(),
    }),
    // proxies/trojan/
    trojan: obj({
      password: str(),
      sni: str(),
      alpn: arr(str()),
      fingerprint: str(),
      'client-fingerprint': str(CLIENT_FINGERPRINTS),
      'skip-cert-verify': bool(),
      network: str(['ws', 'grpc']),
      'ws-opts': WS_OPTS,
      'grpc-opts': GRPC_OPTS,
      'ss-opts': obj({
        enabled: bool(),
        method: str(['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305']),
        password: str(),
      }),
      'reality-opts': REALITY_OPTS,
    }),
    // proxies/anytls/
    anytls: obj({
      password: str(),
      'client-fingerprint': str(CLIENT_FINGERPRINTS),
      udp: bool(),
      'idle-session-check-interval': num(),
      'idle-session-timeout': num(),
      'min-idle-session': num(),
      sni: str(),
      alpn: arr(str()),
      'skip-cert-verify': bool(),
      fingerprint: str(),
    }),
    // proxies/mieru/
    mieru: obj({
      username: str(),
      password: str(),
      'port-range': str(),
      transport: str(['TCP', 'UDP']),
      multiplexing: str(['MULTIPLEXING_OFF', 'MULTIPLEXING_LOW', 'MULTIPLEXING_MIDDLE', 'MULTIPLEXING_HIGH']),
      'handshake-mode': str(['HANDSHAKE_STANDARD', 'HANDSHAKE_NO_WAIT']),
      'traffic-pattern': str(),
    }),
    // proxies/hysteria/ (v1)
    hysteria: obj({
      'auth-str': str(),
      protocol: str(['udp', 'wechat-video', 'faketcp']),
      up: str(),
      down: str(),
      obfs: str(),
      alpn: arr(str()),
      sni: str(),
      'skip-cert-verify': bool(),
      fingerprint: str(),
      'recv-window-conn': num(),
      'recv-window': num(),
      'disable-mtu-discovery': bool(),
      'fast-open': bool(),
    }),
    // proxies/hysteria2/
    hysteria2: obj({
      password: str(),
      ports: str(),
      'hop-interval': num(),
      up: str(),
      down: str(),
      obfs: str(['salamander', 'gecko']),
      'obfs-password': str(),
      'obfs-min-packet-size': num(),
      'obfs-max-packet-size': num(),
      sni: str(),
      'skip-cert-verify': bool(),
      fingerprint: str(),
      alpn: arr(str()),
      ca: str(),
      'ca-str': str(),
      cwnd: num(),
      'udp-mtu': num(),
      'ech-opts': ECH_OPTS,
      'initial-stream-receive-window': num(),
      'max-stream-receive-window': num(),
      'initial-connection-receive-window': num(),
      'max-connection-receive-window': num(),
      'handshake-timeout': num(),
      'bbr-profile': str(),
    }),
    // proxies/tuic/
    tuic: obj({
      uuid: str(),
      password: str(),
      token: str(),
      ip: str(),
      'heartbeat-interval': num(),
      alpn: arr(str()),
      sni: str(),
      'disable-sni': bool(),
      'reduce-rtt': bool(),
      'request-timeout': num(),
      'udp-relay-mode': str(['native', 'quic']),
      'congestion-controller': str(['cubic', 'new_reno', 'bbr']),
      'max-udp-relay-packet-size': num(),
      'fast-open': bool(),
      'skip-cert-verify': bool(),
      'max-open-streams': num(),
      'udp-over-stream': bool(),
      'udp-over-stream-version': num(),
    }),
    // proxies/wg/
    wireguard: obj({
      ip: str(),
      ipv6: str(),
      'private-key': str(),
      'public-key': str(),
      'pre-shared-key': str(),
      'allowed-ips': arr(str()),
      reserved: arr(num()),
      mtu: num(),
      'remote-dns-resolve': bool(),
      dns: arr(str()),
      'refresh-server-ip-interval': num(),
      'persistent-keepalive': num(),
      peers: arr(any()),
      'ip-stack': obj({ mode: str(['auto', 'gvisor', 'mips']), 'congestion-controller': str(['cubic', 'reno', 'bbr', 'bbr3']) }),
      'amnezia-wg-option': obj({
        version: str(),
        jc: num(),
        jmin: num(),
        jmax: num(),
        s1: num(),
        s2: num(),
        s3: num(),
        s4: num(),
        h1: num(),
        h2: num(),
        h3: num(),
        h4: num(),
      }),
    }),
    // proxies/ssh/
    ssh: obj({
      username: str(),
      password: str(),
      'private-key': str(),
      'private-key-passphrase': str(),
      'host-key': arr(str()),
      'host-key-algorithms': arr(str()),
    }),
    // proxies/snell/
    snell: obj({
      psk: str(),
      version: num(),
      reuse: bool(),
      'obfs-opts': obj({
        mode: str(['http', 'tls', 'shadow-tls', 'restls', 'jls']),
        host: str(),
        password: str(),
        version: str(['v1', 'v2', 'v3']),
        alpn: arr(str(['h2', 'http/1.1'])),
        username: str(),
        'version-hint': str(['tls12', 'tls13']),
        'restls-script': str(),
      }),
    }),
    // proxies/http/
    http: obj({
      username: str(),
      password: str(),
      tls: bool(),
      sni: str(),
      'skip-cert-verify': bool(),
      fingerprint: str(),
      headers: map(str()),
    }),
    // proxies/socks/
    socks5: obj({
      username: str(),
      password: str(),
      tls: bool(),
      fingerprint: str(),
      'skip-cert-verify': bool(),
    }),
    // proxies/direct/
    direct: obj({}),
    // proxies/dns/
    dns: obj({}),
    // Exotic/niche outbound types — type enum only, no key details authored.
    sudoku: obj({}),
    shadowquic: obj({}),
    easytier: obj({}),
    tailscale: obj({}),
    masque: obj({}),
    trusttunnel: obj({}),
    zerotier: obj({}),
    openvpn: obj({}),
  })
)

// proxy-groups/
const PROXY_GROUP_COMMON = {
  name: str(),
  proxies: arr(str()),
  use: arr(str()),
  url: str(),
  interval: num(),
  lazy: bool(),
  'default-selected': str(),
  'empty-fallback': str(),
  timeout: num(),
  'max-failed-times': num(),
  'disable-udp': bool(),
  'interface-name': str(),
  'routing-mark': num(),
  'include-all': bool(),
  'include-all-proxies': bool(),
  'include-all-providers': bool(),
  filter: str(),
  'exclude-filter': str(),
  'exclude-type': str(),
  'expected-status': str(),
  hidden: bool(),
  icon: str(),
}

const PROXY_GROUP: SchemaNode = obj(
  PROXY_GROUP_COMMON,
  by('type', {
    select: obj({}),
    'url-test': obj({ tolerance: num() }),
    fallback: obj({}),
    'load-balance': obj({ strategy: str(['round-robin', 'consistent-hashing', 'sticky-sessions']) }),
    relay: obj({}), // deprecated in favour of dialer-proxy, kept for back-compat configs
  })
)

// proxy-providers/
const PROXY_PROVIDER_HEALTH_CHECK: SchemaNode = obj({
  enable: bool(),
  url: str(),
  interval: num(),
  timeout: num(),
  lazy: bool(),
  'expected-status': str(),
})

const PROXY_PROVIDER_OVERRIDE: SchemaNode = obj({
  udp: bool(),
  tfo: bool(),
  mptcp: bool(),
  'udp-over-tcp': bool(),
  'dialer-proxy': str(),
  'interface-name': str(),
  'routing-mark': num(),
  'ip-version': str(['dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer']),
  up: str(),
  down: str(),
  'skip-cert-verify': bool(),
  'additional-prefix': str(),
  'additional-suffix': str(),
  'proxy-name': any(),
  'override-expr': str(),
})

const PROXY_PROVIDER_COMMON = {
  path: str(),
  url: str(),
  interval: num(),
  proxy: str(),
  'size-limit': num(),
  'age-secret-key': str(),
  header: map(arr(str())),
  'health-check': PROXY_PROVIDER_HEALTH_CHECK,
  override: PROXY_PROVIDER_OVERRIDE,
  filter: str(),
  'exclude-filter': str(),
  'exclude-type': str(),
  payload: any(),
}

const PROXY_PROVIDER: SchemaNode = obj(PROXY_PROVIDER_COMMON, by('type', { http: obj({}), file: obj({}), inline: obj({}) }))

// rule-providers/
const RULE_PROVIDER_COMMON = {
  url: str(),
  path: str(),
  'path-in-bundle': str(),
  interval: num(),
  proxy: str(),
  'size-limit': num(),
  header: map(arr(str())),
  payload: any(),
  behavior: str(['domain', 'ipcidr', 'classical']),
  format: str(['yaml', 'text', 'mrs']),
}

const RULE_PROVIDER: SchemaNode = obj(RULE_PROVIDER_COMMON, by('type', { http: obj({}), file: obj({}), inline: obj({}) }))

// dns/, dns/hosts/
const DNS: SchemaNode = obj({
  enable: bool(),
  'cache-algorithm': str(['lru', 'arc']),
  'prefer-h3': bool(),
  listen: str(),
  ipv6: bool(),
  'ipv6-timeout': num(),
  'use-hosts': bool(),
  'use-system-hosts': bool(),
  'respect-rules': bool(),
  'default-nameserver': arr(str()),
  'enhanced-mode': str(['fake-ip', 'redir-host']),
  'fake-ip-range': str(),
  'fake-ip-range6': str(),
  'fake-ip-filter': arr(str()),
  'fake-ip-filter-mode': str(['blacklist', 'whitelist', 'rule']),
  'fake-ip-ttl': num(),
  nameserver: arr(str()),
  fallback: arr(str()),
  'nameserver-policy': map(any()),
  'proxy-server-nameserver': arr(str()),
  'proxy-server-nameserver-policy': map(str()),
  'direct-nameserver': arr(str()),
  'direct-nameserver-follow-policy': bool(),
  'fallback-filter': obj({
    geoip: bool(),
    'geoip-code': str(),
    geosite: arr(str()),
    ipcidr: arr(str()),
    domain: arr(str()),
    'fallback-lazy-query': bool(),
  }),
})

// sniff/
const SNIFFER: SchemaNode = obj({
  enable: bool(),
  'force-dns-mapping': bool(),
  'parse-pure-ip': bool(),
  'override-destination': bool(),
  sniff: obj({
    HTTP: obj({ ports: arr(str()), 'override-destination': bool() }),
    TLS: obj({ ports: arr(str()) }),
    QUIC: obj({ ports: arr(str()) }),
  }),
  'force-domain': arr(str()),
  'skip-domain': arr(str()),
  'skip-src-address': arr(str()),
  'skip-dst-address': arr(str()),
})

// ntp/
const NTP: SchemaNode = obj({
  enable: bool(),
  'write-to-system': bool(),
  server: str(),
  port: num(),
  interval: num(),
  'dialer-proxy': str(),
})

// experimental/
const EXPERIMENTAL: SchemaNode = obj({
  'quic-go-disable-gso': bool(),
  'quic-go-disable-ecn': bool(),
  'dialer-ip4p-convert': bool(),
})

// inbound/tun/ — root-level `tun`, also reused (spread) by the `tun` listener type below.
const TUN_KEYS = {
  enable: bool(),
  stack: str(['system', 'gvisor', 'mixed']),
  device: str(),
  'auto-route': bool(),
  'auto-redirect': bool(),
  'auto-detect-interface': bool(),
  'dns-hijack': arr(str()),
  'route-address': arr(str()),
  'route-address-set': arr(str()),
  'route-exclude-address': arr(str()),
  'route-exclude-address-set': arr(str()),
  'inet4-address': arr(str()),
  'inet6-address': arr(str()),
  mtu: num(),
  gso: bool(),
  'gso-max-size': num(),
  'strict-route': bool(),
  'endpoint-independent-nat': bool(),
  'udp-timeout': num(),
  'iproute2-table-index': num(),
  'iproute2-rule-index': num(),
  'include-interface': arr(str()),
  'exclude-interface': arr(str()),
  'include-uid': arr(str()),
  'include-uid-range': arr(str()),
  'exclude-uid': arr(str()),
  'exclude-uid-range': arr(str()),
  'include-mac-address': arr(str()),
  'exclude-mac-address': arr(str()),
  'include-android-user': arr(num()),
  'include-package': arr(str()),
  'exclude-package': arr(str()),
  'file-descriptor': num(),
  'disable-icmp-forwarding': bool(),
}

const TUN: SchemaNode = obj(TUN_KEYS)

// inbound/listeners/ — keys common to every listener entry, plus the shared TLS block used by
// the TLS-capable listener types.
const LISTENER_COMMON = { name: str(), listen: str(), port: num(), proxy: str(), udp: bool(), 'routing-mark': num() }

const LISTENER_TLS = {
  certificate: str(),
  'private-key': str(),
  'client-auth-type': str(['', 'request', 'require-any', 'verify-if-given', 'require-and-verify']),
  'client-auth-cert': str(),
  'ech-key': str(),
}

const LISTENER_USERS = arr(obj({ username: str(), password: str() }))

const LISTENER: SchemaNode = obj(
  LISTENER_COMMON,
  by('type', {
    // inbound/listeners/socks/
    socks: obj({ users: LISTENER_USERS, ...LISTENER_TLS, 'mux-option': any() }),
    // inbound/listeners/http/
    http: obj({ users: LISTENER_USERS, ...LISTENER_TLS }),
    // inbound/listeners/mixed/
    mixed: obj({ users: LISTENER_USERS, ...LISTENER_TLS }),
    // inbound/listeners/redirect/
    redir: obj({}),
    // inbound/listeners/tproxy/
    tproxy: obj({}),
    // inbound/listeners/ss/
    shadowsocks: obj({ cipher: str(SS_CIPHERS), password: str(), 'plugin-opts': any(), 'mux-option': any() }),
    // inbound/listeners/vmess/
    vmess: obj({
      users: arr(obj({ username: str(), uuid: str(), alterId: num() })),
      'ws-path': str(),
      'grpc-service-name': str(),
      ...LISTENER_TLS,
      'mux-option': any(),
    }),
    // inbound/listeners/vless/
    vless: obj({
      users: arr(obj({ username: str(), uuid: str(), flow: str(['xtls-rprx-vision']) })),
      'ws-path': str(),
      'grpc-service-name': str(),
      decryption: str(),
      ...LISTENER_TLS,
      'mux-option': any(),
    }),
    // inbound/listeners/trojan/
    trojan: obj({
      users: LISTENER_USERS,
      'ws-path': str(),
      'grpc-service-name': str(),
      'ss-option': any(),
      ...LISTENER_TLS,
      'mux-option': any(),
    }),
    // inbound/listeners/anytls/
    anytls: obj({ users: LISTENER_USERS, 'padding-scheme': str(), ...LISTENER_TLS }),
    // inbound/listeners/mieru/
    mieru: obj({
      transport: str(['TCP', 'UDP']),
      users: map(str()),
      'traffic-pattern': str(),
      'user-hint-is-mandatory': bool(),
    }),
    // inbound/listeners/tuic-v4/, inbound/listeners/tuic-v5/
    tuic: obj({
      users: map(str()),
      'congestion-controller': str(['cubic', 'new_reno', 'bbr']),
      'bbr-profile': str(),
      'max-idle-time': num(),
      'authentication-timeout': num(),
      alpn: arr(str()),
      'max-udp-relay-packet-size': num(),
      ...LISTENER_TLS,
      'mux-option': any(),
    }),
    // inbound/listeners/hysteria2/
    hysteria2: obj({
      users: map(str()),
      up: str(),
      down: str(),
      'ignore-client-bandwidth': bool(),
      'bbr-profile': str(['standard', 'conservative', 'aggressive']),
      obfs: str(['salamander']),
      'obfs-password': str(),
      masquerade: str(),
      'realm-opts': any(),
      alpn: arr(str()),
      ...LISTENER_TLS,
      'mux-option': any(),
    }),
    // inbound/listeners/tunnel/
    tunnel: obj({ network: arr(str(['tcp', 'udp'])), target: str() }),
    // inbound/listeners/tun/ (per-listener TUN, distinct from the root-level `tun` section)
    tun: obj(TUN_KEYS),
  })
)

// tunnels/
const TUNNEL: SchemaNode = obj({
  network: arr(str(['tcp', 'udp'])),
  address: str(),
  target: str(),
  proxy: str(),
})

export const MIHOMO_ROOT: SchemaNode = obj({
  // general/ — root scalars
  port: num(),
  'socks-port': num(),
  'redir-port': num(),
  'tproxy-port': num(),
  'mixed-port': num(),
  authentication: arr(str()),
  'skip-auth-prefixes': arr(str()),
  'lan-allowed-ips': arr(str()),
  'lan-disallowed-ips': arr(str()),
  'allow-lan': bool(),
  'bind-address': str(),
  mode: str(['rule', 'global', 'direct']),
  'log-level': str(['silent', 'error', 'warning', 'info', 'debug']),
  ipv6: bool(),
  'external-controller': str(),
  'external-controller-tls': str(),
  'external-controller-unix': str(),
  'external-controller-pipe': str(),
  'external-controller-cors': obj({ 'allow-origins': arr(str()), 'allow-private-network': bool() }),
  'external-controller-routing-mark': num(),
  'external-doh-server': str(),
  'external-ui': str(),
  'external-ui-name': str(),
  'external-ui-url': str(),
  secret: str(),
  'unified-delay': bool(),
  'tcp-concurrent': bool(),
  'interface-name': str(),
  'routing-mark': num(),
  'global-client-fingerprint': str(CLIENT_FINGERPRINTS),
  'geodata-mode': bool(),
  'geodata-loader': str(['standard', 'memconservative']),
  'geo-auto-update': bool(),
  'geo-update-interval': num(),
  'geox-url': obj({ geoip: str(), geosite: str(), mmdb: str(), asn: str() }),
  'global-ua': str(),
  'etag-support': bool(),
  'keep-alive-idle': num(),
  'keep-alive-interval': num(),
  'disable-keep-alive': bool(),
  'find-process-mode': str(['always', 'strict', 'off']),
  profile: obj({ 'store-selected': bool(), 'store-fake-ip': bool() }),
  tls: obj({ certificate: str(), 'private-key': str(), 'ech-key': str(), 'custom-certifactes': str() }),
  experimental: EXPERIMENTAL,
  ntp: NTP,
  // dns/hosts/
  hosts: map(any()),
  sniffer: SNIFFER,
  dns: DNS,
  tun: TUN,
  proxies: arr(PROXY),
  'proxy-groups': arr(PROXY_GROUP),
  'proxy-providers': map(PROXY_PROVIDER),
  'rule-providers': map(RULE_PROVIDER),
  // rules/, sub-rule/
  rules: arr(str(RULE_TYPES)),
  'sub-rules': map(arr(str(RULE_TYPES))),
  listeners: arr(LISTENER),
  tunnels: arr(TUNNEL),
  // Provider files are just `{ payload: [...] }`; keep it at the root so those resolve too.
  payload: arr(str(RULE_TYPES)),
})
