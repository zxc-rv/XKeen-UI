const safeBase64 = (str) =>
  atob(
    str
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(str.length + ((4 - (str.length % 4)) % 4), "="),
  )

const toYaml = (obj, indent = 0) => {
  const padding = " ".repeat(indent)
  return Object.entries(obj).reduce((result, [key, value]) => {
    if (value == null || value === "") return result
    if (Array.isArray(value))
      return value.length ? result + `${padding}${key}:\n` + value.map((item) => `${padding}  - ${item}`).join("\n") + "\n" : result
    if (typeof value === "object") return result + `${padding}${key}:\n${toYaml(value, indent + 2)}`
    return result + `${padding}${key}: ${key === "name" ? `'${String(value).replace(/'/g, "''")}'` : value}\n`
  }, "")
}

const getStreamSettings = (type, params) => {
  const number = (val) => (val ? +val : undefined)
  const bool = (val) => val === "true" || val === true || val === "1" || undefined
  const string = (val) => val || undefined
  const output = {
    network: type,
    security: string(params.security),
    tlsSettings:
      params.security === "tls"
        ? {
            fingerprint: string(params.fp) || "chrome",
            serverName: string(params.sni),
            alpn: params.alpn?.split(","),
            allowInsecure: bool(params.allowInsecure || params.insecure),
          }
        : undefined,
    realitySettings:
      params.security === "reality"
        ? {
            fingerprint: string(params.fp) || "chrome",
            serverName: string(params.sni),
            publicKey: string(params.pbk),
            shortId: string(params.sid),
            spiderX: string(params.spx),
            mldsa65Verify: string(params.pqv),
          }
        : undefined,
  }
  if (type === "tcp" && params.headerType) output.tcpSettings = { header: { type: params.headerType } }
  if (type === "raw" && params.headerType) output.rawSettings = { header: { type: params.headerType } }
  if (type === "xhttp") {
    let extra
    try {
      extra = params.extra ? JSON.parse(decodeURIComponent(params.extra)) : undefined
    } catch {}
    output.xhttpSettings = { host: string(params.host), path: params.path || "/", mode: params.mode || "auto", extra }
  }
  if (type === "kcp")
    output.kcpSettings = {
      mtu: number(params.mtu),
      tti: number(params.tti),
      uplinkCapacity: number(params.uplinkCapacity),
      downlinkCapacity: number(params.downlinkCapacity),
      congestion: bool(params.congestion),
      readBufferSize: number(params.readBufferSize),
      writeBufferSize: number(params.writeBufferSize),
      header: params.headerType ? { type: params.headerType } : undefined,
      seed: string(params.seed),
    }
  if (type === "grpc")
    output.grpcSettings = {
      serviceName: string(params.serviceName || params.path),
      authority: string(params.authority),
      multiMode: params.mode === "multi",
      user_agent: string(params.user_agent),
      idle_timeout: number(params.idle_timeout),
      health_check_timeout: number(params.health_check_timeout),
      permit_without_stream: bool(params.permit_without_stream),
      initial_windows_size: number(params.initial_windows_size),
    }
  if (type === "ws")
    output.wsSettings = {
      path: params.path || "/",
      host: string(params.host),
      heartbeatPeriod: number(params.heartbeatPeriod),
    }
  if (type === "httpupgrade") output.httpupgradeSettings = { path: params.path || "/", host: string(params.host) }
  return output
}

const parseUrl = (uri, protocol, settingsMapper) => {
  const url = new URL(uri)
  const params = Object.fromEntries(url.searchParams)
  const baseConfig = {
    tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
    protocol: protocol,
    settings: settingsMapper(url, params),
  }

  if (!["shadowsocks", "hysteria2"].includes(protocol)) {
    baseConfig.streamSettings = getStreamSettings(params.type || "tcp", { ...params, sni: params.sni })
  }

  return baseConfig
}

const protocols = {
  vless: (uri) =>
    parseUrl(uri, "vless", (url, params) => ({
      address: url.hostname,
      port: +url.port || 443,
      id: url.username,
      encryption: params.encryption || "none",
      flow: params.flow || undefined,
    })),

  trojan: (uri) => parseUrl(uri, "trojan", (url) => ({ address: url.hostname, port: +url.port || 443, password: url.username })),

  hysteria2: (uri) =>
    parseUrl(uri, "hysteria2", (url, params) => ({
      address: url.hostname,
      port: +url.port || 443,
      password: decodeURIComponent(url.username),
      sni: params.sni,
      insecure: params.insecure === "1" || params.allowInsecure === "1",
    })),

  ss: (uri) => {
    const url = new URL(uri)
    let method, password
    if (url.username && !url.password) {
      const decoded = safeBase64(url.username).split(":")
      method = decoded[0]
      password = decoded.slice(1).join(":")
    } else {
      method = url.username
      password = url.password
    }
    return {
      tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
      protocol: "shadowsocks",
      settings: { address: url.hostname, port: +url.port, method, password },
    }
  },

  vmess: (uri) => {
    const data = JSON.parse(safeBase64(uri.slice(8)))
    if (data.tls === "tls") {
      data.security = "tls"
      data.sni = data.sni || data.host
    }
    return {
      tag: data.ps || "PROXY",
      protocol: "vmess",
      settings: {
        address: data.add,
        port: +data.port,
        id: data.id,
        alterId: +data.aid || 0,
        security: data.scy || "auto",
      },
      streamSettings: getStreamSettings(data.net || "tcp", data),
    }
  },
}

function parseProxyUri(uri) {
  const protocol = uri.split(":")[0]
  if (!protocols[protocol]) throw new Error("Неизвестная ссылка")
  return protocols[protocol](uri)
}

function convertToMihomoYaml(proxyConfig) {
  const settings = proxyConfig.settings
  const streamSettings = proxyConfig.streamSettings || {}
  const common = {
    name: proxyConfig.tag,
    type: proxyConfig.protocol,
    server: settings.address,
    port: settings.port,
    udp: true,
  }

  if (proxyConfig.protocol === "vless") {
    Object.assign(common, { uuid: settings.id, flow: settings.flow, "packet-encoding": "xudp" })
    if (settings.encryption) common.encryption = settings.encryption
  } else if (proxyConfig.protocol === "vmess")
    Object.assign(common, { uuid: settings.id, alterId: settings.alterId, cipher: settings.security })
  else if (proxyConfig.protocol === "trojan") {
    common.password = settings.password
  } else if (proxyConfig.protocol === "hysteria2") {
    common.password = settings.password
    common["fast-open"] = true
  } else if (proxyConfig.protocol === "shadowsocks") Object.assign(common, { cipher: settings.method, password: settings.password })

  if (streamSettings.network) common.network = streamSettings.network
  if (["tls", "reality"].includes(streamSettings.security)) {
    const tls = streamSettings.tlsSettings || {}
    const reality = streamSettings.realitySettings || {}
    const serverName = tls.serverName || reality.serverName
    Object.assign(common, {
      tls: true,
      tfo: true,
      "client-fingerprint": tls.fingerprint || reality.fingerprint,
      alpn: tls.alpn,
    })
    if (["trojan", "hysteria2"].includes(proxyConfig.protocol)) {
      if (serverName) common.sni = serverName
    } else {
      if (serverName) common.servername = serverName
    }
    if (tls.allowInsecure) common["skip-cert-verify"] = true
    if (streamSettings.security === "reality")
      common["reality-opts"] = {
        "public-key": reality.publicKey,
        "short-id": reality.shortId,
        "support-x25519mlkem768": true,
      }
  }

  if (streamSettings.network === "ws")
    common["ws-opts"] = {
      path: streamSettings.wsSettings?.path,
      headers: streamSettings.wsSettings?.host ? { Host: streamSettings.wsSettings.host } : undefined,
    }
  else if (streamSettings.network === "grpc") common["grpc-opts"] = { "grpc-service-name": streamSettings.grpcSettings?.serviceName }
  else if (streamSettings.network === "httpupgrade")
    common["http-upgrade-opts"] = {
      path: streamSettings.httpupgradeSettings?.path,
      headers: streamSettings.httpupgradeSettings?.host ? { Host: streamSettings.httpupgradeSettings.host } : undefined,
    }

  return `  - ${toYaml(common).trim().replace(/\n/g, "\n    ")}`
}

function generateConfigForCore(uri, core = "xray", existingConfig = "") {
  const generateName = (base) => {
    let index = 1
    while (existingConfig.includes(`${base}_${index}`)) index++
    return `${base}_${index}`
  }

  if (uri.startsWith("http") && core === "mihomo") {
    const name = generateName("subscription")
    return {
      type: "proxy-provider",
      content: toYaml(
        {
          [name]: {
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
        },
        2,
      ),
    }
  }

  if (core === "mihomo" && uri.includes("type=xhttp")) throw new Error("XHTTP в Mihomo не поддерживается")
  if (core !== "mihomo" && uri.startsWith("http")) throw new Error("Подписки в Xray не поддерживаются")
  if (core !== "mihomo" && uri.startsWith("hysteria2")) throw new Error("Hysteria2 в Xray не поддерживается")

  const config = parseProxyUri(uri)
  if (config.tag === "PROXY" || existingConfig.includes(config.tag)) config.tag = generateName(config.protocol)

  return core === "mihomo"
    ? { type: "proxy", content: convertToMihomoYaml(config) + "\n" }
    : { type: "outbound", content: JSON.stringify(config, null, 2) }
}
