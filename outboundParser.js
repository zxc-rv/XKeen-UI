function parseVlessUri(uri) {
  if (!uri.startsWith("vless://")) throw new Error("Невалидная ссылка")

  const url = new URL(uri)
  const params = Object.fromEntries(url.searchParams)
  const [id, address] = url.username ? [url.username, url.hostname] : [url.hostname, ""]

  const config = {
    tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
    protocol: "vless",
    settings: {
      address: address || url.hostname,
      port: parseInt(url.port) || 443,
      id: id,
      encryption: params.encryption || "none",
    },
    streamSettings: {
      network: params.type || "tcp",
    },
  }

  if (params.flow) config.settings.flow = params.flow

  if (params.security) {
    config.streamSettings.security = params.security

    if (params.security === "reality") {
      config.streamSettings.realitySettings = {
        fingerprint: params.fp || "chrome",
        serverName: params.sni || "",
        publicKey: params.pbk || "",
        shortId: params.sid || "",
      }
    } else if (params.security === "tls") {
      config.streamSettings.tlsSettings = {
        fingerprint: params.fp || "chrome",
        serverName: params.sni || "",
        alpn: params.alpn ? params.alpn.split(",") : [],
      }
    }
  }

  if (params.type === "ws") {
    config.streamSettings.wsSettings = {
      path: params.path || "/",
      headers: params.host ? { Host: params.host } : {},
    }
  } else if (params.type === "grpc") {
    config.streamSettings.grpcSettings = {
      serviceName: params.serviceName || params.path || "",
    }
  } else if (params.type === "h2" || params.type === "http") {
    config.streamSettings.httpSettings = {
      host: params.host ? [params.host] : [],
      path: params.path || "/",
    }
  }

  if (params.headerType) {
    config.streamSettings.tcpSettings = {
      header: { type: params.headerType },
    }
  }

  return config
}

function parseVmessUri(uri) {
  if (!uri.startsWith("vmess://")) throw new Error("Невалидная ссылка")

  const decoded = JSON.parse(atob(uri.slice(8)))

  const config = {
    tag: decoded.ps || "PROXY",
    protocol: "vmess",
    settings: {
      address: decoded.add,
      port: parseInt(decoded.port),
      id: decoded.id,
      alterId: parseInt(decoded.aid || 0),
      security: decoded.scy || "auto",
    },
    streamSettings: {
      network: decoded.net || "tcp",
    },
  }

  if (decoded.tls === "tls") {
    config.streamSettings.security = "tls"
    config.streamSettings.tlsSettings = {
      serverName: decoded.sni || decoded.host || "",
      fingerprint: decoded.fp || "chrome",
      alpn: decoded.alpn ? decoded.alpn.split(",") : [],
    }
  }

  if (decoded.net === "ws") {
    config.streamSettings.wsSettings = {
      path: decoded.path || "/",
      headers: decoded.host ? { Host: decoded.host } : {},
    }
  } else if (decoded.net === "grpc") {
    config.streamSettings.grpcSettings = {
      serviceName: decoded.path || "",
    }
  }

  return config
}

function parseTrojanUri(uri) {
  if (!uri.startsWith("trojan://")) throw new Error("Невалидная ссылка")

  const url = new URL(uri)
  const params = Object.fromEntries(url.searchParams)

  const config = {
    tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
    protocol: "trojan",
    settings: {
      address: url.hostname,
      port: parseInt(url.port) || 443,
      password: url.username,
    },
    streamSettings: {
      security: params.security || "tls",
      network: params.type || "tcp",
    },
  }

  if (params.security === "tls" || !params.security) {
    config.streamSettings.tlsSettings = {
      serverName: params.sni || url.hostname,
      fingerprint: params.fp || "chrome",
      alpn: params.alpn ? params.alpn.split(",") : [],
    }
  }

  if (params.type === "ws") {
    config.streamSettings.wsSettings = {
      path: params.path || "/",
      headers: params.host ? { Host: params.host } : {},
    }
  }

  return config
}

function parseShadowsocksUri(uri) {
  if (!uri.startsWith("ss://")) throw new Error("Невалидная ссылка")

  const url = new URL(uri)
  const decoded = atob(url.username)
  const [method, password] = decoded.split(":")

  return {
    tag: decodeURIComponent(url.hash.slice(1)) || "PROXY",
    protocol: "shadowsocks",
    settings: {
      address: url.hostname,
      port: parseInt(url.port),
      method: method,
      password: password,
    },
  }
}

function parseProxyUri(uri) {
  const type = uri.split("://")[0]

  switch (type) {
    case "vless":
      return parseVlessUri(uri)
    case "vmess":
      return parseVmessUri(uri)
    case "trojan":
      return parseTrojanUri(uri)
    case "ss":
      return parseShadowsocksUri(uri)
    default:
      throw new Error(`Протокол ${type} не поддерживается`)
  }
}
