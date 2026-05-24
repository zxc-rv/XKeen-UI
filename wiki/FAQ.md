# FAQ

## 1. Не удалось запустить XKeen UI"

**Q**: UI не запускается и появляется следующая ошибка

```bash
xkeen-ui -v
Error relocating /opt/sbin/xkeen-ui: stat: symbol not found
Error relocating /opt/sbin/xkeen-ui: pthread_setname_np: symbol not found
Error relocating /opt/sbin/xkeen-ui: posix_spawnattr_setpgroup: symbol not found
Error relocating /opt/sbin/xkeen-ui: pthread_getattr_np: symbol not found
Error relocating /opt/sbin/xkeen-ui: posix_spawnp: symbol not found
Error relocating /opt/sbin/xkeen-ui: bcmp: symbol not found
Error relocating /opt/sbin/xkeen-ui: lstat: symbol not found
Error relocating /opt/sbin/xkeen-ui: clock_gettime: symbol not found
Error relocating /opt/sbin/xkeen-ui: fstat: symbol not found
Error relocating /opt/sbin/xkeen-ui: posix_spawn_file_actions_addchdir_np: symbol not found
Error relocating /opt/sbin/xkeen-ui: waitid: symbol not found
```

**A**: Понятно, ставьте [версию с припиской «gnu»](https://github.com/zxc-rv/XKeen-UI/releases/tag/v1.0.0).
Закинуть в `/opt/sbin` с названием `xkeen-ui`
затем `chmod +x /opt/sbin/xkeen-ui && xkeen-ui --start`
