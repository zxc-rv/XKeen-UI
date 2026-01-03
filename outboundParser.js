const safeBase64 = (str) => {
  str = str.replace(/-/g, "+").replace(/_/g, "/")
  while (str.length % 4) str += "="
  return atob(str)
}

const toYaml = (obj, indent = 0) => {
  let res = ""
  const sp = " ".repeat(indent)
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue
    if (Array.isArray(v)) {
      if (v.length === 0) continue
      res += `${sp}${k}:\n`
      v.forEach((i) => (res += `${sp}  - ${i}\n`))
    } else if (typeof v === "object") {
      res += `${sp}${k}:\n${toYaml(v, indent + 2)}`
    } else {
      const value = k === "name" ? `'${String(v).replace(/'/g, "''")}'` : v
      res += `${sp}${k}: ${value}\n`
    }
  }
  return res
}

const getStreamSettings = (type, params) => {
  return {
    network: type,
    tcpSettings: type === "tcp" && params.headerType ? { header: { type: params.headerType } } : undefined,
    rawSettings: type === "raw" && params.headerType ? { header: { type: params.headerType } } : undefined,
    wsSettings:
      type === "ws"
        ? {
            path: params.path || "/",
            host: params.host || undefined,
            heartbeatPeriod: params.heartbeatPeriod ? parseInt(params.heartbeatPeriod) : undefined,
          }
        : undefined,
    httpupgradeSettings:
      type === "httpupgrade"
        ? {
            path: params.path || "/",
            host: params.host || undefined,
          }
        : undefined,
    grpcSettings:
      type === "grpc"
        ? {
            serviceName: params.serviceName || params.path || undefined,
            authority: params.authority || undefined,
            multiMode: params.multiMode === "true" || params.multiMode === true || undefined,
            user_agent: params.user_agent || undefined,
            idle_timeout: params.idle_timeout ? parseInt(params.idle_timeout) : undefined,
            health_check_timeout: params.health_check_timeout ? parseInt(params.health_check_timeout) : undefined,
            permit_without_stream:
              params.permit_without_stream === "true" || params.permit_without_stream === true || undefined,
            initial_windows_size: params.initial_windows_size ? parseInt(params.initial_windows_size) : undefined,
          }
        : undefined,
    kcpSettings:
      type === "kcp"
        ? {
            mtu: params.mtu ? parseInt(params.mtu) : undefined,
            tti: params.tti ? parseInt(params.tti) : undefined,
            uplinkCapacity: params.uplinkCapacity ? parseInt(params.uplinkCapacity) : undefined,
            downlinkCapacity: params.downlinkCapacity ? parseInt(params.downlinkCapacity) : undefined,
            congestion: params.congestion === "true" || params.congestion === true || undefined,
            readBufferSize: params.readBufferSize ? parseInt(params.readBufferSize) : undefined,
            writeBufferSize: params.writeBufferSize ? parseInt(params.writeBufferSize) : undefined,
            header: params.headerType ? { type: params.headerType } : undefined,
            seed: params.seed || undefined,
          }
        : undefined,
    xhttpSettings:
      type === "xhttp"
        ? {
            host: params.host || undefined,
            path: params.path || "/",
            mode: params.mode || "auto",
            extra: (() => {
              if (!params.extra) return undefined
              try {
                return JSON.parse(decodeURIComponent(params.extra))
              } catch {
                return undefined
              }
            })(),
          }
        : undefined,
    security: params.security || undefined,
    tlsSettings:
      params.security === "tls"
        ? {
            fingerprint: params.fp || undefined,
            serverName: params.sni || undefined,
            alpn: params.alpn?.split(","),
          }
        : undefined,
    realitySettings:
      params.security === "reality"
        ? {
            fingerprint: params.fp || undefined,
            serverName: params.sni || undefined,
            publicKey: params.pbk || undefined,
            shortId: params.sid || undefined,
          }
        : undefined,
  }
}

function parseVlessUri(uri) {
  if (!uri.startsWith("vless://")) throw new Error("Invalid VLESS")
  const url = new URL(uri)
  const p = Object.fromEntries(url.searchParams)

  return {
    tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
    protocol: "vless",
    settings: {
      address: url.hostname,
      port: parseInt(url.port) || 443,
      id: url.username,
      encryption: p.encryption || "none",
      flow: p.flow || undefined,
    },
    streamSettings: getStreamSettings(p.type || "tcp", p),
  }
}

function parseVmessUri(uri) {
  if (!uri.startsWith("vmess://")) throw new Error("Invalid VMESS")
  const d = JSON.parse(safeBase64(uri.slice(8)))

  if (d.tls === "tls") {
    d.security = "tls"
    if (!d.sni && d.host) d.sni = d.host
  }

  return {
    tag: d.ps || "PROXY",
    protocol: "vmess",
    settings: {
      address: d.add,
      port: parseInt(d.port),
      id: d.id,
      alterId: parseInt(d.aid || 0),
      security: d.scy || "auto",
    },
    streamSettings: getStreamSettings(d.net || "tcp", d),
  }
}

function parseTrojanUri(uri) {
  if (!uri.startsWith("trojan://")) throw new Error("Invalid TROJAN")
  const url = new URL(uri)
  const p = Object.fromEntries(url.searchParams)

  if (!p.security) p.security = "tls"
  if (!p.sni) p.sni = url.hostname

  return {
    tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
    protocol: "trojan",
    settings: {
      address: url.hostname,
      port: parseInt(url.port) || 443,
      password: url.username,
    },
    streamSettings: getStreamSettings(p.type || "tcp", p),
  }
}

function parseShadowsocksUri(uri) {
  if (!uri.startsWith("ss://")) throw new Error("Invalid SS")
  const url = new URL(uri)
  let method, password, address, port

  if (url.username && !url.password) {
    const decoded = safeBase64(url.username).split(":")
    method = decoded[0]
    password = decoded.slice(1).join(":")
    address = url.hostname
    port = url.port
  } else {
    method = url.username
    password = url.password
    address = url.hostname
    port = url.port
  }

  return {
    tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
    protocol: "shadowsocks",
    settings: {
      address,
      port: parseInt(port),
      method,
      password,
    },
  }
}

function parseHysteria2Uri(uri) {
  if (!uri.startsWith("hysteria2://")) throw new Error("Invalid HY2")
  const url = new URL(uri)
  return {
    tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
    protocol: "hysteria2",
    settings: {
      address: url.hostname,
      port: parseInt(url.port) || 443,
      password: decodeURIComponent(url.username),
      insecure: url.searchParams.get("insecure") === "1",
    },
  }
}

function parseProxyUri(uri) {
  const p = uri.split(":")[0]
  const map = {
    vless: parseVlessUri,
    vmess: parseVmessUri,
    trojan: parseTrojanUri,
    ss: parseShadowsocksUri,
    hysteria2: parseHysteria2Uri,
  }
  if (!map[p]) throw new Error("Unsupported protocol")
  return map[p](uri)
}

function convertToMihomoYaml(xc) {
  const s = xc.settings
  const ss = xc.streamSettings || {}

  const pMap = {
    vless: { uuid: s.id, flow: s.flow || undefined, "packet-encoding": "xudp" },
    vmess: { uuid: s.id, alterId: s.alterId, cipher: s.security },
    trojan: { password: s.password },
    shadowsocks: { cipher: s.method, password: s.password },
    hysteria2: { password: s.password, "fast-open": true },
  }

  const common = {
    name: xc.tag,
    type: xc.protocol,
    server: s.address,
    port: s.port,
    udp: true,
    ...pMap[xc.protocol],
  }

  if (ss.network) common.network = ss.network

  if (["tls", "reality"].includes(ss.security)) {
    common.tls = true
    common.tfo = true
    const tls = ss.tlsSettings || {}
    const reality = ss.realitySettings || {}

    common.servername = tls.serverName || reality.serverName
    common["client-fingerprint"] = tls.fingerprint || reality.fingerprint

    if (tls.alpn) common.alpn = tls.alpn

    if (ss.security === "reality") {
      common["reality-opts"] = {
        "public-key": reality.publicKey,
        "short-id": reality.shortId,
        "support-x25519mlkem768": true,
      }
    }
  }

  if (ss.network === "ws") {
    common["ws-opts"] = {
      path: ss.wsSettings?.path,
      headers: ss.wsSettings?.host ? { Host: ss.wsSettings.host } : undefined,
    }
  } else if (ss.network === "grpc") {
    common["grpc-opts"] = { "grpc-service-name": ss.grpcSettings?.serviceName }
  } else if (["h2", "http"].includes(ss.network)) {
    common["h2-opts"] = {
      host: ss.httpSettings?.host,
      path: ss.httpSettings?.path,
    }
  }

  return `  - ${toYaml(common).trim().replace(/\n/g, "\n    ")}`
}

function generateConfigForCore(uri, core = "xray", existingConfig = "") {
  const isSub = uri.startsWith("http")
  const genName = (base) => {
    let i = 1,
      n = `${base}_${i}`
    while (existingConfig.includes(n)) n = `${base}_${++i}`
    return n
  }

  if (core === "mihomo") {
    if (isSub) {
      const pContent = {
        [genName("subscription")]: {
          type: "http",
          url: uri,
          interval: 43200,
          "health-check": {
            enable: true,
            url: "https://www.gstatic.com/generate_204",
            interval: 300,
            "expected-status": 204,
          },
          override: { udp: true, tfo: true },
        },
      }
      return { type: "proxy-provider", content: toYaml(pContent, 2).trimEnd() + "\n" }
    }

    if (uri.includes("type=xhttp")) throw new Error("XHTTP в Mihomo не поддерживается")
    const conf = parseProxyUri(uri)
    if (conf.tag === "PROXY") conf.tag = genName(conf.protocol)
    return { type: "proxy", content: convertToMihomoYaml(conf) + "\n" }
  } else {
    if (isSub || uri.startsWith("hysteria2")) throw new Error("Hysteria2 в Xray не поддерживается")
    return { type: "outbound", content: JSON.stringify(parseProxyUri(uri), null, 2) }
  }
}
