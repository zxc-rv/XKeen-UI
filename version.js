const APP_VERSION = "v0.4.0"
;(function () {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initVersion)
  } else {
    initVersion()
  }
  async function initVersion() {
    const versionElement = document.getElementById("versionText")
    if (!versionElement) return

    try {
      const response = await fetch(`/cgi/version`)
      const data = await response.json()
      if (data.success && data.version) {
        versionElement.textContent = data.version
        return
      }
    } catch (e) {}

    versionElement.textContent = APP_VERSION
  }
})()
