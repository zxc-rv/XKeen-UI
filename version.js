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
      const response = await fetch("/api/version")
      const data = await response.json()
      if (data.success && data.version) {
        versionElement.querySelector("#versionText").textContent = data.version
        versionElement.style.display = "block"
      }
    } catch (e) {}
  }
})()
