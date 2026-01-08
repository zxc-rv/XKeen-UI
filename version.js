const APP_VERSION = "dev"
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
      const response = await fetch(`http://${window.location.host}/cgi/version`)
      const data = await response.json()
      if (data.success && data.version) {
        versionElement.textContent = data.version
        return
      }
    } catch (e) {}

    versionElement.textContent = APP_VERSION
  }
})()
