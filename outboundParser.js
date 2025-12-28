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

function parseVlessUri(uri) {
  if (!uri.startsWith("vless://")) throw new Error("Invalid VLESS")
  const url = new URL(uri)
  const p = Object.fromEntries(url.searchParams)

  let extraObj
  if (p.extra) {
    try {
      extraObj = JSON.parse(decodeURIComponent(p.extra))
    } catch {}
  }

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
    streamSettings: {
      network: p.type || "tcp",
      security: p.security || undefined,
      realitySettings:
        p.security === "reality"
          ? {
              fingerprint: p.fp || "chrome",
              serverName: p.sni || undefined,
              publicKey: p.pbk || undefined,
              shortId: p.sid || undefined,
            }
          : undefined,
      tlsSettings:
        p.security === "tls"
          ? {
              fingerprint: p.fp || "chrome",
              serverName: p.sni || undefined,
              alpn: p.alpn?.split(","),
            }
          : undefined,
      wsSettings:
        p.type === "ws"
          ? {
              path: p.path || "/",
              headers: p.host ? { Host: p.host } : undefined,
            }
          : undefined,
      grpcSettings:
        p.type === "grpc"
          ? {
              serviceName: p.serviceName || p.path || undefined,
            }
          : undefined,
      httpSettings: ["h2", "http"].includes(p.type)
        ? {
            host: p.host ? [p.host] : undefined,
            path: p.path || "/",
          }
        : undefined,
      xhttpSettings:
        p.type === "xhttp"
          ? {
              path: p.path || "/",
              host: p.host || undefined,
              mode: p.mode || "auto",
              extra: extraObj,
            }
          : undefined,
      tcpSettings: p.headerType ? { header: { type: p.headerType } } : undefined,
    },
  }
}

function parseVmessUri(uri) {
  if (!uri.startsWith("vmess://")) throw new Error("Invalid VMESS")
  const d = JSON.parse(safeBase64(uri.slice(8)))
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
    streamSettings: {
      network: d.net || "tcp",
      security: d.tls === "tls" ? "tls" : undefined,
      tlsSettings:
        d.tls === "tls"
          ? {
              serverName: d.sni || d.host || undefined,
              fingerprint: d.fp || "chrome",
              alpn: d.alpn?.split(","),
            }
          : undefined,
      wsSettings:
        d.net === "ws"
          ? {
              path: d.path || "/",
              headers: d.host ? { Host: d.host } : undefined,
            }
          : undefined,
      grpcSettings:
        d.net === "grpc"
          ? {
              serviceName: d.path || undefined,
            }
          : undefined,
    },
  }
}

function parseTrojanUri(uri) {
  if (!uri.startsWith("trojan://")) throw new Error("Invalid TROJAN")
  const url = new URL(uri)
  const p = Object.fromEntries(url.searchParams)
  return {
    tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
    protocol: "trojan",
    settings: {
      address: url.hostname,
      port: parseInt(url.port) || 443,
      password: url.username,
    },
    streamSettings: {
      network: p.type || "tcp",
      security: p.security || "tls",
      tlsSettings: {
        serverName: p.sni || url.hostname,
        fingerprint: p.fp || "chrome",
        alpn: p.alpn?.split(","),
      },
      wsSettings:
        p.type === "ws"
          ? {
              path: p.path || "/",
              headers: p.host ? { Host: p.host } : undefined,
            }
          : undefined,
    },
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
      headers: ss.wsSettings?.headers,
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
