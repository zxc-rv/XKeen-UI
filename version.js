;(function () {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initVersion)
  } else {
    initVersion()
  }

  async function initVersion() {
    const versionElement = document.getElementById("appVersion")
    if (!versionElement) return

    try {
      const response = await fetch("/api/version?_=" + Date.now())
      const data = await response.json()

      if (data.success && data.version) {
        const savedVersion = localStorage.getItem("appVersion")

        if (savedVersion && savedVersion !== data.version) {
          console.log(`Обнаружено обновление: ${savedVersion} -> ${data.version}`)
          localStorage.setItem("appVersion", data.version)
          localStorage.setItem("appForceReload", "true")
          window.location.href = window.location.pathname + "?_=" + Date.now()
          return
        }

        localStorage.setItem("appVersion", data.version)
        versionElement.querySelector("#versionText").textContent = data.version
        versionElement.style.display = "block"
      }
    } catch (e) {}
  }
})()
