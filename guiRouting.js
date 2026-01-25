let routingGUIState = {
  enabled: false,
  rules: [],
  availableOutbounds: [],
}
let autoApplyOutbound = false
let dragState = {
  dragging: false,
  originalCard: null,
  clone: null,
  shiftX: 0,
  shiftY: 0,
}
let restartDebounceTimer = null

function startEditRuleName(e, index) {
  e.stopPropagation()
  const rule = routingGUIState.rules[index]
  const nameSpan = e.target.closest(".rule-card-header").querySelector(".rule-name")
  const currentName = rule.ruleTag || ""

  const input = document.createElement("input")
  input.type = "text"
  input.className = "rule-name-input"
  input.value = currentName
  input.placeholder = "Название правила"

  nameSpan.replaceWith(input)
  input.focus()
  input.select()

  const saveName = () => {
    const newName = input.value.trim()
    if (newName) rule.ruleTag = newName
    else delete rule.ruleTag
    syncGUIToJSON()
    renderRoutingGUI()
  }

  input.addEventListener("blur", saveName)
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault()
      saveName()
    } else if (ev.key === "Escape") {
      ev.preventDefault()
      renderRoutingGUI()
    }
  })
}

const RULE_FIELDS = {
  domain: { type: "array", placeholder: "youtube.com, geosite:youtube" },
  ip: { type: "array", placeholder: "1.1.1.1/32, geoip:cloudflare" },
  port: { type: "string", placeholder: "80, 443, 1000-2000" },
  sourceIP: { type: "array", placeholder: "192.168.1.2" },
  sourcePort: { type: "string", placeholder: "80, 443, 1000-2000" },
  network: { type: "buttons", options: ["tcp", "udp"], isString: true },
  inboundTag: { type: "buttons" },
  protocol: { type: "buttons", options: ["http", "tls", "quic", "bittorrent"] },
}

function toggleAutoApplyOutbound() {
  const checkbox = document.getElementById("autoApplyOutboundCheckbox")
  if (checkbox) {
    autoApplyOutbound = checkbox.checked
    localStorage.setItem("autoApplyOutbound", autoApplyOutbound ? "1" : "0")
  }
}

function isRoutingFile() {
  const config = configs[activeConfigIndex]
  return config && config.filename.toLowerCase().includes("routing")
}

function loadAvailableOutbounds() {
  console.log("loadAvailableOutbounds called, stack:", new Error().stack)
  routingGUIState.availableOutbounds = []
  routingGUIState.availableBalancers = []
  routingGUIState.availableInbounds = []

  const config = configs[activeConfigIndex]
  if (!config) return

  try {
    const content = JSON.parse(config.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))

    const outboundsConfig = configs.find((c) => c.filename.toLowerCase().includes("outbound"))
    if (outboundsConfig) {
      const outboundsContent = JSON.parse(outboundsConfig.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
      if (outboundsContent.outbounds && Array.isArray(outboundsContent.outbounds)) {
        const tags = outboundsContent.outbounds.filter((o) => o.tag).map((o) => o.tag)
        routingGUIState.availableOutbounds = [...new Set(tags)]
      }
    }

    const inboundsConfig = configs.find(
      (c) => c.filename.toLowerCase().includes("inbound") || c.filename.toLowerCase().includes("03_inbounds"),
    )
    if (inboundsConfig) {
      const inboundsContent = JSON.parse(inboundsConfig.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
      if (inboundsContent.inbounds && Array.isArray(inboundsContent.inbounds)) {
        const tags = inboundsContent.inbounds.filter((i) => i.tag).map((i) => i.tag)
        routingGUIState.availableInbounds = [...new Set(tags)]
      }
    }

    if (content.routing && content.routing.balancers && Array.isArray(content.routing.balancers)) {
      const balancerTags = content.routing.balancers.filter((b) => b.tag).map((b) => b.tag)
      routingGUIState.availableBalancers = [...new Set(balancerTags)]
    }

    console.log("Loaded outbounds:", routingGUIState.availableOutbounds)
    console.log("Loaded balancers:", routingGUIState.availableBalancers)
    console.log("Loaded inbounds:", routingGUIState.availableInbounds)
  } catch (e) {
    console.error("Failed to parse outbounds/balancers/inbounds:", e)
  }
}

function loadAvailableInbounds() {
  routingGUIState.availableInbounds = []

  try {
    const inboundConfig = configs.find(
      (c) => c.filename.toLowerCase().includes("inbound") || c.filename.toLowerCase().includes("03_inbounds"),
    )

    if (inboundConfig) {
      const inboundContent = JSON.parse(inboundConfig.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
      if (inboundContent.inbounds && Array.isArray(inboundContent.inbounds)) {
        const tags = inboundContent.inbounds.filter((i) => i.tag).map((i) => i.tag)
        routingGUIState.availableInbounds = [...new Set(tags)]
      }
    }

    console.log("Loaded inbounds:", routingGUIState.availableInbounds)
  } catch (e) {
    console.error("Failed to parse inbounds:", e)
  }
}

function parseRoutingJSON(content) {
  try {
    const json = JSON.parse(content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
    if (json.routing && json.routing.rules) {
      routingGUIState.rules = JSON.parse(JSON.stringify(json.routing.rules))
      return true
    }
  } catch (e) {
    console.error("Parse error:", e)
  }
  return false
}

async function buildRoutingJSON() {
  const currentContent = monacoEditor.getValue()
  try {
    const json = JSON.parse(currentContent.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
    json.routing.rules = routingGUIState.rules

    const preFormatted = JSON.stringify(json, null, 2)

    const formatted = await window.prettier.format(preFormatted, {
      parser: "json",
      plugins: [window.prettierPlugins.babel],
      semi: false,
      singleQuote: false,
      trailingComma: "none",
      printWidth: 120,
      endOfLine: "lf",
    })

    const cleanedText = formatted
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s+$/gm, "")
      .replace(/\n$/, "")

    return cleanedText
  } catch (e) {
    console.error("Build JSON error:", e)
    return currentContent
  }
}

function syncJSONToGUI() {
  if (!routingGUIState.enabled || !isRoutingFile()) return
  const content = monacoEditor.getValue()
  parseRoutingJSON(content)
  renderRoutingGUI()
}

function syncGUIToJSON() {
  buildRoutingJSON()
    .then((newContent) => {
      monacoEditor.setValue(newContent)
      configs[activeConfigIndex].content = newContent
      configs[activeConfigIndex].isDirty = true
      updateUIDirtyState()
    })
    .catch((err) => {
      console.error("Error syncing GUI to JSON:", err)
    })
}

function saveGUIState() {
  if (!configs[activeConfigIndex]) return
  const filename = configs[activeConfigIndex].filename
  localStorage.setItem(`routingGUI_${filename}`, routingGUIState.enabled ? "1" : "0")
}

function loadGUIState() {
  if (!configs[activeConfigIndex]) return false
  const filename = configs[activeConfigIndex].filename
  const saved = localStorage.getItem(`routingGUI_${filename}`)
  return saved === "1"
}

function toggleRoutingGUI() {
  const checkbox = document.getElementById("routingGUICheckboxSettings")
  if (checkbox) {
    routingGUIState.enabled = checkbox.checked
    localStorage.setItem("routingGUI_enabled", routingGUIState.enabled ? "1" : "0")
  }

  if (typeof applyRoutingGUIState === "function") {
    applyRoutingGUIState()
  }
}

function applyRoutingGUIState() {
  if (!monacoEditor) return
  const editorContainer = document.getElementById("editorContainer")
  const routingContainer = document.getElementById("routingGUIContainer")
  const tabsContent = document.querySelector(".tabs-content")

  if (!editorContainer) return

  const config = configs[activeConfigIndex]
  if (!config) return

  const isLogActive = typeof logGUIState !== "undefined" && logGUIState.enabled && config.filename.toLowerCase().includes("log")
  let isRoutingActive = routingGUIState.enabled && config.filename.toLowerCase().includes("routing")

  if (isRoutingActive) {
    try {
      const json = JSON.parse(config.content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, ""))
      if (!json || typeof json !== "object" || !json.routing) isRoutingActive = false
    } catch {
      isRoutingActive = false
    }
  }

  editorContainer.style.display = "none"
  if (routingContainer) routingContainer.style.display = "none"
  if (tabsContent) tabsContent.classList.remove("no-border")

  if (isRoutingActive && !isLogActive) {
    let gui = routingContainer
    if (!gui) {
      gui = document.createElement("div")
      gui.id = "routingGUIContainer"
      gui.className = "routing-gui-container"
      editorContainer.parentNode.appendChild(gui)
    }
    gui.style.display = "block"
    tabsContent?.classList.add("no-border")

    loadAvailableOutbounds()
    syncJSONToGUI()
    renderRoutingGUI()
  } else if (isLogActive) {
    if (typeof applyLogGUIState === "function") applyLogGUIState()
  } else {
    editorContainer.style.display = "block"
  }
}

function renderRoutingGUI() {
  let container = document.getElementById("routingGUIContainer")
  if (!container) return

  container.innerHTML = `
    <div class="routing-rules-list" id="routingRulesList"></div>
    <button class="add-rule-btn" onclick="addRoutingRule()">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      Добавить правило
    </button>
  `

  const rulesList = document.getElementById("routingRulesList")
  routingGUIState.rules.forEach((rule, index) => {
    rulesList.appendChild(createRuleElement(rule, index))
  })
}

function initCustomSelects(container) {
  const selects = container.querySelectorAll(".custom-select")

  selects.forEach((select) => {
    const trigger = select.querySelector(".custom-select-trigger")
    const dropdown = select.querySelector(".custom-select-dropdown")
    const options = select.querySelectorAll(".custom-select-option")
    const ruleIndex = parseInt(select.dataset.rule)
    const fieldName = select.dataset.field

    trigger.addEventListener("click", (e) => {
      e.stopPropagation()

      document.querySelectorAll(".custom-select").forEach((s) => {
        if (s !== select && s.classList.contains("open")) {
          s.classList.remove("open")
        }
      })

      select.classList.toggle("open")
    })

    options.forEach((option) => {
      option.addEventListener("click", (e) => {
        e.stopPropagation()

        if (option.classList.contains("empty")) return

        const value = option.getAttribute("data-value") || option.textContent.trim()

        options.forEach((opt) => opt.classList.remove("selected"))
        option.classList.add("selected")

        trigger.querySelector("span").textContent = value

        select.classList.remove("open")

        updateRuleField(ruleIndex, fieldName, value)
      })
    })
  })

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".custom-select")) {
      document.querySelectorAll(".custom-select").forEach((select) => {
        select.classList.remove("open")
      })
    }
  })
}

function createRuleElement(rule, index) {
  const div = document.createElement("div")
  div.className = "routing-rule-card"
  div.dataset.index = index
  div.draggable = false

  const isBalancer = rule.balancerTag !== undefined
  const currentField = isBalancer ? "balancerTag" : "outboundTag"
  const val = rule[currentField] || ""
  const fields = Object.keys(rule).filter((k) => k !== "outboundTag" && k !== "balancerTag")
  const ruleName = rule.ruleTag || ""

  let outboundInputHTML = ""

  if (isBalancer) {
    outboundInputHTML = `
      <div class="custom-select outbound-select" data-rule="${index}" data-field="balancerTag">
        <div class="custom-select-trigger">
          <span>${val || "Select balancer..."}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="custom-select-dropdown">
          ${routingGUIState.availableBalancers
            .map((t) => `<div class="custom-select-option ${val === t ? "selected" : ""}" data-value="${t}">${t}</div>`)
            .join("")}
          ${routingGUIState.availableBalancers.length === 0 ? '<div class="custom-select-option empty">No balancers found</div>' : ""}
        </div>
      </div>`
  } else {
    outboundInputHTML = `
      <div class="custom-select outbound-select" data-rule="${index}" data-field="outboundTag">
        <div class="custom-select-trigger">
          <span>${val || "Select outbound..."}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <div class="custom-select-dropdown">
          ${routingGUIState.availableOutbounds
            .map((t) => `<div class="custom-select-option ${val === t ? "selected" : ""}" data-value="${t}">${t}</div>`)
            .join("")}
          ${routingGUIState.availableOutbounds.length === 0 ? '<div class="custom-select-option empty">No outbounds found</div>' : ""}
        </div>
      </div>`
  }

  div.innerHTML = `
    <div class="rule-card-header">
      <div class="drag-handle">
        <svg width="24px" height="24px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 6H9.01M15 6H15.01M15 12H15.01M9 12H9.01M9 18H9.01M15 18H15.01M10 6C10 6.55228 9.55228 7 9 7C8.44772 7 8 6.55228 8 6C8 5.44772 8.44772 5 9 5C9.55228 5 10 5.44772 10 6ZM16 6C16 6.55228 15.5523 7 15 7C14.4477 7 14 6.55228 14 6C14 5.44772 14.4477 5 15 5C15.5523 5 16 5.44772 16 6ZM10 12C10 12.5523 9.55228 13 9 13C8.44772 13 8 12.5523 8 12C8 11.4477 8.44772 11 9 11C9.55228 11 10 11.4477 10 12ZM16 12C16 12.5523 15.5523 13 15 13C14.4477 13 14 12.5523 14 12C14 11.4477 14.4477 11 15 11C15.5523 11 16 11.4477 16 12ZM10 18C10 18.5523 9.55228 19 9 19C8.44772 19 8 18.5523 8 18C8 17.4477 8.44772 17 9 17C9.55228 17 10 17.4477 10 18ZM16 18C16 18.5523 15.5523 19 15 19C14.4477 19 14 18.5523 14 18C14 17.4477 14.4477 17 15 17C15.5523 17 16 17.4477 16 18Z" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/> </svg>
      </div>
      <span class="rule-index">#${index + 1}</span>
      <span class="rule-name">${ruleName || ""}</span>
      <button class="edit-rule-name-btn" onclick="startEditRuleName(event, ${index})" title="Редактировать название">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
        </svg>
      </button>
      <button class="delete-rule-btn" onclick="deleteRule(${index})">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="rule-fields-wrapper">
      <div class="rule-fields">
        ${fields.map((f) => createFieldHTML(f, rule[f], index)).join("")}
        <button class="add-condition-btn-inline" onclick="showAddConditionMenu(event, ${index})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          Добавить условие
        </button>
      </div>
    </div>
    <div class="rule-field outbound-field full-width">
      <div class="field-input-group">
        <div class="field-name-btn" onclick="showSwitchOutboundMenu(event, ${index})">${currentField}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="menu-chevron"><polyline points="6 9 12 15 18 9"></polyline></svg></div>
        ${outboundInputHTML}
      </div>
    </div>
  `

  const dragHandle = div.querySelector(".drag-handle")
  dragHandle.addEventListener("mousedown", (e) => startDrag(e, index))
  dragHandle.addEventListener("touchstart", (e) => startDrag(e, index))

  setTimeout(() => {
    initCustomSelects(div)
    initTagInputsForFields(div, rule, index)
  }, 0)

  return div
}

function initTagInputsForFields(container, rule, ruleIndex) {
  const tagFields = ["domain", "ip", "port", "sourceIP", "sourcePort"]

  tagFields.forEach((fieldName) => {
    if (rule[fieldName] !== undefined) {
      const wrapper = container.querySelector(`.tag-input-container[data-rule="${ruleIndex}"][data-field="${fieldName}"]`)
      if (wrapper) {
        initTagInput(wrapper, ruleIndex, fieldName)
      }
    }
  })
}

function initTagInput(wrapper, ruleIndex, fieldName) {
  const input = wrapper.querySelector(".tag-input")
  if (!input) return

  wrapper.addEventListener("click", (e) => {
    if (e.target === wrapper) input.focus()
  })

  input.addEventListener("focus", () => wrapper.classList.add("focused"))
  input.addEventListener("blur", () => {
    wrapper.classList.remove("focused")
    const val = input.value.trim()
    if (val) {
      addTag(ruleIndex, fieldName, val)
      input.value = ""
    }
  })

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      const val = input.value.trim()
      if (val) {
        addTag(ruleIndex, fieldName, val)
        input.value = ""
      }
    } else if (e.key === " ") {
      e.preventDefault()
      const val = input.value.trim()
      if (val) {
        addTag(ruleIndex, fieldName, val)
        input.value = ""

        setTimeout(() => {
          const newWrapper = document.querySelector(`.tag-input-container[data-rule="${ruleIndex}"][data-field="${fieldName}"]`)
          if (newWrapper) {
            const newInput = newWrapper.querySelector(".tag-input")
            if (newInput) newInput.focus()
          }
        }, 10)
      }
    } else if (e.key === "Backspace" && input.value === "") {
      const tags = wrapper.querySelectorAll(".tag")
      if (tags.length > 0) {
        const lastTag = tags[tags.length - 1]
        removeTag(ruleIndex, fieldName, lastTag.dataset.value)
      }
    }
  })

  wrapper.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".tag-remove")
    const tagBody = e.target.closest(".tag")

    if (removeBtn) {
      e.stopPropagation()
      removeTag(ruleIndex, fieldName, removeBtn.parentElement.dataset.value)
    } else if (tagBody) {
      e.stopPropagation()
      const val = tagBody.dataset.value
      removeTag(ruleIndex, fieldName, val)

      setTimeout(() => {
        const newWrapper = document.querySelector(`.tag-input-container[data-rule="${ruleIndex}"][data-field="${fieldName}"]`)
        if (newWrapper) {
          const newInput = newWrapper.querySelector(".tag-input")
          if (newInput) {
            newInput.value = val
            newInput.focus()
            newInput.setSelectionRange(val.length, val.length)
          }
        }
      }, 10)
    }
  })
}

function showSwitchOutboundMenu(e, ruleIndex) {
  e.stopPropagation()
  const btn = e.currentTarget
  const isOpen = btn.classList.contains("menu-open")

  document.querySelectorAll(".condition-menu").forEach((m) => destroyMenu(m))
  document.querySelectorAll(".menu-open").forEach((b) => b.classList.remove("menu-open"))

  if (isOpen) return

  const rule = routingGUIState.rules[ruleIndex]
  const currentType = rule.balancerTag !== undefined ? "balancerTag" : "outboundTag"

  btn.classList.add("menu-open")
  const menu = document.createElement("div")
  menu.className = "condition-menu"
  menu.innerHTML = ["outboundTag", "balancerTag"]
    .map((f) => {
      const isSelected = f === currentType
      return `
        <div class="condition-menu-item ${isSelected ? "selected" : ""}"
             onclick="switchOutboundType(${ruleIndex}, '${f}'); document.querySelectorAll('.condition-menu').forEach(m => m.remove());">
          <span>${f}</span>
        </div>
      `
    })
    .join("")

  btn.parentElement.style.position = "relative"
  btn.parentElement.appendChild(menu)

  menu.style.cssText = `left: 0; top: calc(100% + 4px); position: absolute; z-index: 1000;`

  setTimeout(() => {
    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== btn) {
        menu.remove()
        btn.classList.remove("menu-open")
        document.removeEventListener("click", close)
      }
    }
    document.addEventListener("click", close)
  }, 0)
}

function switchOutboundType(ruleIndex, newType) {
  const rule = routingGUIState.rules[ruleIndex]
  if (newType === "outboundTag") {
    delete rule.balancerTag
    rule.outboundTag = routingGUIState.availableOutbounds[0] || ""
  } else {
    delete rule.outboundTag
    rule.balancerTag = routingGUIState.availableBalancers[0] || ""
  }
  syncGUIToJSON()
  renderRoutingGUI()
}

function destroyMenu(menu, btn) {
  if (!menu || menu.classList.contains("closing")) return

  menu.classList.add("closing")
  if (btn) btn.classList.remove("menu-open")

  setTimeout(() => menu.remove(), 100)
}

function initTagInputs(container) {
  const inputs = container.querySelectorAll(".tag-input-container")

  inputs.forEach((wrapper) => {
    const ruleIndex = parseInt(wrapper.dataset.rule)
    const fieldName = wrapper.dataset.field

    if (fieldName !== "protocol" && fieldName !== "inboundTag") {
      initTagInput(wrapper, ruleIndex, fieldName)
    }
  })
}

function addTag(ruleIndex, fieldName, value) {
  if (["port", "sourcePort"].includes(fieldName)) {
    if (!validatePortValue(value)) {
      showToast("Некорректное значение.\nДопустимы числа или диапазоны от 1 до 65535.", "error")
      return
    }
  }
  const rule = routingGUIState.rules[ruleIndex]
  let currentVal = rule[fieldName]
  const fieldConfig = RULE_FIELDS[fieldName]

  let valArray = []
  if (Array.isArray(currentVal)) {
    valArray = currentVal.map(String)
  } else if (typeof currentVal === "string" && currentVal.trim() !== "") {
    valArray = currentVal
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (currentVal !== undefined && currentVal !== null) {
    valArray = [currentVal.toString()]
  }

  if (!valArray.includes(value)) {
    valArray.push(value)
  }

  saveTagsToRule(ruleIndex, fieldName, valArray, fieldConfig.type)
}

function removeTag(ruleIndex, fieldName, value) {
  const rule = routingGUIState.rules[ruleIndex]
  let currentVal = rule[fieldName]
  const fieldConfig = RULE_FIELDS[fieldName]

  let valArray = []
  if (Array.isArray(currentVal)) {
    valArray = [...currentVal]
  } else if (typeof currentVal === "string" && currentVal.trim() !== "") {
    valArray = currentVal
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  } else if (typeof currentVal === "number") {
    valArray = [currentVal.toString()]
  }

  valArray = valArray.filter((v) => v.toString() !== value.toString())

  saveTagsToRule(ruleIndex, fieldName, valArray, fieldConfig.type)
}

function saveTagsToRule(ruleIndex, fieldName, valArray, fieldType) {
  const rule = routingGUIState.rules[ruleIndex]

  if (fieldType === "array") {
    rule[fieldName] = valArray
  } else {
    const portFields = ["port", "sourcePort"]
    if (portFields.includes(fieldName) && valArray.length === 1) {
      rule[fieldName] = valArray[0]
    } else {
      rule[fieldName] = valArray.join(",")
    }
  }

  syncGUIToJSON()
  renderRoutingGUI()

  setTimeout(() => {
    const wrapper = document.querySelector(`.tag-input-container[data-rule="${ruleIndex}"][data-field="${fieldName}"]`)
    if (wrapper) {
      wrapper.scrollLeft = wrapper.scrollWidth
    }
  }, 10)
}

function createFieldHTML(fieldName, value, ruleIndex) {
  const fieldConfig = RULE_FIELDS[fieldName]
  if (!fieldConfig) return ""

  const lowerName = fieldName.toLowerCase()
  let inputHTML = ""

  if (fieldConfig.type === "buttons" || fieldName === "inboundTag") {
    const availableValues = fieldName === "inboundTag" ? routingGUIState.availableInbounds || [] : fieldConfig.options || []
    const currentValues = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").filter(Boolean) : []

    inputHTML = `
      <div class="${lowerName}-buttons">
        ${availableValues
          .map((val) => {
            const displayValue = fieldName === "inboundTag" ? val : val.toUpperCase()
            return `
                <button type="button" class="${lowerName}-btn ${currentValues.includes(val) ? "active" : ""}"
                        onclick="toggleMultiField(${ruleIndex}, '${fieldName}', '${val}')">
                  ${displayValue}
                </button>`
          })
          .join("")}
      </div>`
  } else if (fieldConfig.type === "array" || ["port", "sourcePort"].includes(fieldName)) {
    const tags = Array.isArray(value) ? value : value ? String(value).split(",").filter(Boolean) : []
    inputHTML = `
      <div class="tag-input-container" data-rule="${ruleIndex}" data-field="${fieldName}">
        ${tags
          .map(
            (tag) => `
          <span class="tag tag-${lowerName}" data-value="${tag}">
            <span class="tag-text">${tag}</span>
            <span class="tag-remove">×</span>
          </span>`,
          )
          .join("")}
        <input type="text" class="tag-input" placeholder="${tags.length === 0 ? fieldConfig.placeholder || "" : ""}" />
      </div>`
  } else if (fieldConfig.type === "select") {
    inputHTML = `
      <div class="custom-select" data-rule="${ruleIndex}" data-field="${fieldName}">
        <div class="custom-select-trigger">
          <span>${value}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>
        <div class="custom-select-dropdown">
          ${fieldConfig.options.map((opt) => `<div class="custom-select-option ${value === opt ? "selected" : ""}" data-value="${opt}">${opt}</div>`).join("")}
        </div>
      </div>`
  } else {
    inputHTML = `<input type="text" value="${value}" placeholder="${fieldConfig.placeholder || ""}" onchange="updateRuleField(${ruleIndex}, '${fieldName}', this.value)">`
  }

  return `
    <div class="rule-field full-width">
      <div class="field-input-group">
        <div class="field-name-btn" onclick="changeConditionField(event, ${ruleIndex}, '${fieldName}')">
          ${fieldName}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="menu-chevron"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>
        ${inputHTML}
        <button class="remove-field-btn" onclick="removeRuleField(${ruleIndex}, '${fieldName}')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
    </div>`
}

function toggleMultiField(ruleIndex, fieldName, value) {
  const rule = routingGUIState.rules[ruleIndex]
  const cfg = RULE_FIELDS[fieldName]
  let current = []

  if (Array.isArray(rule[fieldName])) {
    current = [...rule[fieldName]]
  } else if (typeof rule[fieldName] === "string" && rule[fieldName].trim()) {
    current = rule[fieldName].split(",").map((s) => s.trim())
  }

  const idx = current.indexOf(value)
  if (idx > -1) current.splice(idx, 1)
  else current.push(value)

  if (cfg.options) {
    current = cfg.options.filter((opt) => current.includes(opt))
  }

  rule[fieldName] = cfg.isString ? current.join(",") : current

  syncGUIToJSON()
  renderRoutingGUI()
}

function changeConditionField(e, ruleIndex, oldField) {
  const btn = e.currentTarget
  const isOpen = btn.classList.contains("menu-open")

  document.querySelectorAll(".condition-menu").forEach((m) => destroyMenu(m))
  document.querySelectorAll(".field-name-btn").forEach((b) => b.classList.remove("menu-open"))

  if (isOpen) return

  const existingFields = Object.keys(routingGUIState.rules[ruleIndex])
  const availableFields = Object.keys(RULE_FIELDS).filter((f) => !existingFields.includes(f))
  if (!availableFields.length) return

  btn.classList.add("menu-open")
  const menu = document.createElement("div")
  menu.className = "condition-menu"
  menu.innerHTML = availableFields
    .map(
      (f) => `
    <div class="condition-menu-item" onclick="replaceConditionField(${ruleIndex}, '${oldField}', '${f}'); document.querySelectorAll('.condition-menu').forEach(m => m.remove());">${f}</div>
  `,
    )
    .join("")

  btn.parentElement.style.position = "relative"
  btn.parentElement.appendChild(menu)

  menu.style.cssText = `left: 0; top: calc(100% + 4px); position: absolute; z-index: 1000;`

  setTimeout(() => {
    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== btn) {
        menu.remove()
        btn.classList.remove("menu-open")
        document.removeEventListener("click", close)
      }
    }
    document.addEventListener("click", close)
  }, 0)
}

function replaceConditionField(ruleIndex, oldField, newField) {
  const rule = routingGUIState.rules[ruleIndex]
  delete rule[oldField]
  const cfg = RULE_FIELDS[newField]
  if (cfg.type === "array") rule[newField] = []
  else if (cfg.type === "select") rule[newField] = cfg.options[0]
  else rule[newField] = ""
  syncGUIToJSON()
  renderRoutingGUI()
}

function addRoutingRule() {
  const newRule = {
    domain: [],
    outboundTag: routingGUIState.availableOutbounds[0] || "direct",
  }
  routingGUIState.rules.push(newRule)
  syncGUIToJSON()
  renderRoutingGUI()
}

function deleteRule(index) {
  routingGUIState.rules.splice(index, 1)
  syncGUIToJSON()
  renderRoutingGUI()
}

function validatePortList(str) {
  if (!str || !str.trim()) return true

  const parts = str.split(",")

  for (const part of parts) {
    const p = part.trim()
    if (!p) return false

    if (/^\d+$/.test(p)) {
      const n = parseInt(p)
      if (n < 1 || n > 65535) return false
    } else if (/^\d+-\d+$/.test(p)) {
      const [a, b] = p.split("-").map((x) => parseInt(x))
      if (a < 1 || b < 1 || a > 65535 || b > 65535) return false
      if (a >= b) return false
    } else {
      return false
    }
  }

  return true
}

function validatePortValue(v) {
  if (/^\d+$/.test(v)) {
    const n = parseInt(v)
    return n >= 1 && n <= 65535
  }
  if (/^\d+-\d+$/.test(v)) {
    const [a, b] = v.split("-").map((x) => parseInt(x))
    return a >= 1 && b >= 1 && a <= 65535 && b <= 65535 && a < b
  }
  return false
}

function updateRuleField(ruleIndex, fieldName, value) {
  const fieldConfig = RULE_FIELDS[fieldName]

  if (["port", "sourcePort"].includes(fieldName)) {
    if (!validatePortList(value)) {
      showToast("Неверный формат портов", "error")
      return
    }
  }

  if (fieldConfig && fieldConfig.type === "array") {
    routingGUIState.rules[ruleIndex][fieldName] = value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v)
  } else {
    routingGUIState.rules[ruleIndex][fieldName] = value
  }

  syncGUIToJSON()

  if (autoApply && (fieldName === "outboundTag" || fieldName === "balancerTag")) {
    if (restartDebounceTimer) clearTimeout(restartDebounceTimer)

    restartDebounceTimer = setTimeout(() => {
      if (typeof saveAndRestart === "function") {
        saveAndRestart()
      }
      restartDebounceTimer = null
    }, 1000)
  }
}

function removeRuleField(ruleIndex, fieldName) {
  delete routingGUIState.rules[ruleIndex][fieldName]
  syncGUIToJSON()
  renderRoutingGUI()
}

function showAddConditionMenu(e, ruleIndex) {
  e.stopPropagation()
  const btn = e.currentTarget
  const isOpen = btn.classList.contains("menu-open")

  document.querySelectorAll(".condition-menu").forEach((m) => destroyMenu(m))
  document.querySelectorAll(".add-condition-btn-inline, .field-name-btn").forEach((b) => b.classList.remove("menu-open"))

  if (isOpen) return

  const existingFields = Object.keys(routingGUIState.rules[ruleIndex])
  const availableFields = Object.keys(RULE_FIELDS).filter((f) => !existingFields.includes(f))

  if (!availableFields.length) return showToast("Все доступные поля уже добавлены", "error")

  btn.classList.add("menu-open")
  const menu = document.createElement("div")
  menu.className = "condition-menu"
  menu.innerHTML = availableFields
    .map(
      (f) => `
    <div class="condition-menu-item" onclick="addConditionField(${ruleIndex}, '${f}'); document.querySelectorAll('.condition-menu').forEach(m => m.remove()); document.querySelectorAll('.menu-open').forEach(b => b.classList.remove('menu-open'));">${f}</div>
  `,
    )
    .join("")

  btn.parentElement.style.position = "relative"
  btn.parentElement.appendChild(menu)

  menu.style.cssText = `top: calc(100% + 6px); left: 0; position: absolute; z-index: 1000;`

  setTimeout(() => {
    const close = (ev) => {
      if (!menu.contains(ev.target) && ev.target !== btn) {
        menu.remove()
        btn.classList.remove("menu-open")
        document.removeEventListener("click", close)
      }
    }
    document.addEventListener("click", close)
  }, 0)
}

function addConditionField(ruleIndex, fieldName) {
  const fieldConfig = RULE_FIELDS[fieldName]

  if (fieldConfig.type === "array") {
    routingGUIState.rules[ruleIndex][fieldName] = []
  } else if (fieldConfig.type === "select") {
    routingGUIState.rules[ruleIndex][fieldName] = fieldConfig.options[0]
  } else {
    routingGUIState.rules[ruleIndex][fieldName] = ""
  }

  syncGUIToJSON()
  renderRoutingGUI()
}

function startDrag(event, index) {
  const isTouchEvent = event.type === "touchstart"

  if (!isTouchEvent && event.button !== 0) return
  if (event.target.tagName === "INPUT" || event.target.tagName === "SELECT") return

  const card = event.target.closest(".routing-rule-card")
  if (!card) return
  if (!event.target.closest(".drag-handle") && !event.target.closest(".rule-card-header")) return

  event.preventDefault()

  const clientX = isTouchEvent ? event.touches[0].clientX : event.clientX
  const clientY = isTouchEvent ? event.touches[0].clientY : event.clientY

  dragState.dragging = true
  dragState.originalCard = card

  const rect = card.getBoundingClientRect()
  dragState.shiftX = clientX - rect.left
  dragState.shiftY = clientY - rect.top

  const clone = card.cloneNode(true)
  clone.classList.add("dragging-clone")
  clone.style.width = `${rect.width}px`
  clone.style.height = `${rect.height}px`
  clone.style.left = `${rect.left}px`
  clone.style.top = `${rect.top}px`

  document.body.appendChild(clone)
  dragState.clone = clone

  card.classList.add("placeholder")

  if (isTouchEvent) {
    document.addEventListener("touchmove", onDragMove, { passive: false })
    document.addEventListener("touchend", onDragEnd)
  } else {
    document.addEventListener("mousemove", onDragMove)
    document.addEventListener("mouseup", onDragEnd)
  }
}

function onDragMove(event) {
  if (!dragState.dragging || !dragState.clone) return

  const isTouchEvent = event.type === "touchmove"
  if (isTouchEvent) event.preventDefault()

  const clientX = isTouchEvent ? event.touches[0].clientX : event.clientX
  const clientY = isTouchEvent ? event.touches[0].clientY : event.clientY

  const newLeft = clientX - dragState.shiftX
  const newTop = clientY - dragState.shiftY
  dragState.clone.style.left = `${newLeft}px`
  dragState.clone.style.top = `${newTop}px`

  const list = document.getElementById("routingRulesList")
  const placeholder = dragState.originalCard
  const cards = Array.from(list.querySelectorAll(".routing-rule-card"))
  const targetCard = cards.find((card) => {
    if (card === placeholder) return false
    const rect = card.getBoundingClientRect()
    return clientY >= rect.top && clientY <= rect.bottom
  })

  if (targetCard) {
    const position = placeholder.compareDocumentPosition(targetCard)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      targetCard.after(placeholder)
    } else if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      targetCard.before(placeholder)
    }
  }
}

function onDragEnd() {
  if (!dragState.dragging) return

  document.removeEventListener("mousemove", onDragMove)
  document.removeEventListener("mouseup", onDragEnd)
  document.removeEventListener("touchmove", onDragMove)
  document.removeEventListener("touchend", onDragEnd)

  if (dragState.clone) {
    dragState.clone.remove()
    dragState.clone = null
  }

  if (dragState.originalCard) {
    dragState.originalCard.classList.remove("placeholder")
  }

  const list = document.getElementById("routingRulesList")
  const cards = list.querySelectorAll(".routing-rule-card")
  const newRules = []

  cards.forEach((card) => {
    const oldIndex = parseInt(card.dataset.index)
    if (routingGUIState.rules[oldIndex]) {
      newRules.push(routingGUIState.rules[oldIndex])
    }
  })

  routingGUIState.rules = newRules

  dragState.dragging = false
  dragState.originalCard = null

  syncGUIToJSON()
  renderRoutingGUI()
}

// document.addEventListener("DOMContentLoaded", () => {
//   routingGUIState.enabled = loadGUIState()

//   const routingCheckboxSettings = document.getElementById("routingGUICheckboxSettings")
//   if (routingCheckboxSettings) {
//     routingCheckboxSettings.checked = routingGUIState.enabled
//   }

//   if (typeof applyRoutingGUIState === "function") {
//     setTimeout(() => {
//       applyRoutingGUIState()
//     }, 100)
//   }
// })
