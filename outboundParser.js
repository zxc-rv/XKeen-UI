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

// Конвертация Xray конфига в Mihomo YAML формат
function convertToMihomoYaml(xrayConfig) {
  const yamlLines = []
  const name = xrayConfig.tag || "proxy_1"
  const protocol = xrayConfig.protocol
  const settings = xrayConfig.settings
  const streamSettings = xrayConfig.streamSettings

  yamlLines.push(`  - name: ${name}`)
  yamlLines.push(`    type: ${protocol}`)
  yamlLines.push(`    server: ${settings.address}`)
  yamlLines.push(`    port: ${settings.port}`)

  // Network type
  if (streamSettings && streamSettings.network) {
    yamlLines.push(`    network: ${streamSettings.network}`)
  }

  yamlLines.push(`    udp: true`)

  // TLS/Reality
  if (streamSettings && streamSettings.security) {
    if (streamSettings.security === "tls" || streamSettings.security === "reality") {
      yamlLines.push(`    tls: true`)
      yamlLines.push(`    tfo: true`)

      if (streamSettings.security === "reality" && streamSettings.realitySettings) {
        const reality = streamSettings.realitySettings
        yamlLines.push(`    servername: ${reality.serverName}`)
        yamlLines.push(`    reality-opts:`)
        yamlLines.push(`      public-key: ${reality.publicKey}`)
        if (reality.shortId) {
          yamlLines.push(`      short-id: ${reality.shortId}`)
        }
        yamlLines.push(`      support-x25519mlkem768: true`)
      } else if (streamSettings.security === "tls" && streamSettings.tlsSettings) {
        const tls = streamSettings.tlsSettings
        if (tls.serverName) {
          yamlLines.push(`    servername: ${tls.serverName}`)
        }
        if (tls.alpn && tls.alpn.length > 0) {
          yamlLines.push(`    alpn:`)
          tls.alpn.forEach((alpn) => yamlLines.push(`      - ${alpn}`))
        }
        if (tls.fingerprint) {
          yamlLines.push(`    client-fingerprint: ${tls.fingerprint}`)
        }
      }
    }
  }

  // Protocol specific settings
  if (protocol === "vless") {
    yamlLines.push(`    uuid: ${settings.id}`)
    if (settings.flow) {
      yamlLines.push(`    flow: ${settings.flow}`)
    }
    yamlLines.push(`    packet-encoding: xudp`)

    if (streamSettings.realitySettings && streamSettings.realitySettings.fingerprint) {
      yamlLines.push(`    client-fingerprint: ${streamSettings.realitySettings.fingerprint}`)
    }
  } else if (protocol === "vmess") {
    yamlLines.push(`    uuid: ${settings.id}`)
    yamlLines.push(`    alterId: ${settings.alterId || 0}`)
    yamlLines.push(`    cipher: ${settings.security}`)
  } else if (protocol === "trojan") {
    yamlLines.push(`    password: ${settings.password}`)
    if (streamSettings.tlsSettings && streamSettings.tlsSettings.fingerprint) {
      yamlLines.push(`    client-fingerprint: ${streamSettings.tlsSettings.fingerprint}`)
    }
  } else if (protocol === "shadowsocks") {
    yamlLines.push(`    cipher: ${settings.method}`)
    yamlLines.push(`    password: ${settings.password}`)
  }

  // WebSocket settings
  if (streamSettings && streamSettings.network === "ws" && streamSettings.wsSettings) {
    const ws = streamSettings.wsSettings
    yamlLines.push(`    ws-opts:`)
    yamlLines.push(`      path: ${ws.path || "/"}`)
    if (ws.headers && ws.headers.Host) {
      yamlLines.push(`      headers:`)
      yamlLines.push(`        Host: ${ws.headers.Host}`)
    }
  }

  // gRPC settings
  if (streamSettings && streamSettings.network === "grpc" && streamSettings.grpcSettings) {
    yamlLines.push(`    grpc-opts:`)
    yamlLines.push(`      grpc-service-name: ${streamSettings.grpcSettings.serviceName || ""}`)
  }

  // HTTP/2 settings
  if (
    streamSettings &&
    (streamSettings.network === "h2" || streamSettings.network === "http") &&
    streamSettings.httpSettings
  ) {
    const http = streamSettings.httpSettings
    yamlLines.push(`    h2-opts:`)
    if (http.host && http.host.length > 0) {
      yamlLines.push(`      host:`)
      http.host.forEach((h) => yamlLines.push(`        - ${h}`))
    }
    yamlLines.push(`      path: ${http.path || "/"}`)
  }

  return yamlLines.join("\n")
}

// Генерация уникального имени для proxy-provider
function generateUniqueProviderName(existingYaml) {
  let counter = 1
  let name = `subscription_${counter}`

  while (existingYaml.includes(`${name}:`)) {
    counter++
    name = `subscription_${counter}`
  }

  return name
}

// Генерация уникального имени для proxy
function generateUniqueProxyName(existingYaml) {
  let counter = 1
  let name = `proxy_${counter}`

  while (existingYaml.includes(`name: ${name}`)) {
    counter++
    name = `proxy_${counter}`
  }

  return name
}

// Генерация YAML для HTTP subscription (proxy-provider)
function generateProxyProviderYaml(url, existingYaml = "") {
  const name = generateUniqueProviderName(existingYaml)

  const yamlLines = [
    `  ${name}:`,
    `    type: http`,
    `    url: ${url}`,
    `    interval: 43200`,
    `    health-check:`,
    `      enable: true`,
    `      url: https://www.gstatic.com/generate_204`,
    `      interval: 300`,
    `      timeout: 5000`,
    `      expected-status: 204`,
    `    override:`,
    `      udp: true`,
    `      tfo: true`,
  ]

  return yamlLines.join("\n")
}

// Основная функция генерации конфига
function generateConfigForCore(uri, core = "xray", existingConfig = "") {
  // Проверяем тип ссылки
  const isHttpSubscription = uri.startsWith("http://") || uri.startsWith("https://")

  if (core === "mihomo") {
    if (isHttpSubscription) {
      // Генерируем proxy-provider для HTTP подписки
      return {
        type: "proxy-provider",
        content: generateProxyProviderYaml(uri, existingConfig),
      }
    } else {
      // Парсим прокси URI и конвертируем в YAML
      const xrayConfig = parseProxyUri(uri)

      // Если имя не указано в URI, генерируем уникальное
      if (xrayConfig.tag === "PROXY") {
        xrayConfig.tag = generateUniqueProxyName(existingConfig)
      }

      return {
        type: "proxy",
        content: convertToMihomoYaml(xrayConfig),
      }
    }
  } else {
    // Xray формат (JSON)
    if (isHttpSubscription) {
      throw new Error("HTTP подписки не поддерживаются для Xray. Используйте прокси URI.")
    }

    const config = parseProxyUri(uri)
    return {
      type: "outbound",
      content: JSON.stringify(config, null, 2),
    }
  }
}
