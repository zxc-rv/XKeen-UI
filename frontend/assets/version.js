;(function () {
  const run = async () => {
    const appVersion = document.getElementById("appVersion")
    const versionText = document.getElementById("versionText")
    if (!appVersion || !versionText) return
    try {
      const r = await fetch("/api/version")
      if (!r.ok) return
      const d = await r.json()
      if (d.success && d.version) {
        versionText.textContent = d.version
        appVersion.style.display = "block"
      }
      if (d.show_toast?.ui) showToast({ title: "Доступно обновление", body: "Доступна новая версия XKeen UI" })
      if (d.show_toast?.core) showToast({ title: "Доступно обновление", body: `Доступная новая версия ${currentCore}` })
      appVersion.classList.toggle("outdated", !!d.outdated?.ui)
    } catch (e) {
      console.error("Ошибка проверки обновлений:", e)
    }
  }
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", run) : run()
})()
