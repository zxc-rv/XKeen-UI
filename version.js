const APP_VERSION = "dev"

;(function () {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initVersion)
  } else {
    initVersion()
  }

  function initVersion() {
    const versionElement = document.getElementById("versionText")
    if (versionElement) {
      versionElement.textContent = APP_VERSION
    }
  }
})()
