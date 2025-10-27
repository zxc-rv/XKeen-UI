# ✨ XKeen UI
Веб-панель с современным дизайном для управления сервисом **XKeen** 🚀
  
<img width="2535" height="1308" alt="image" src="https://github.com/user-attachments/assets/d8cd3521-a62e-4395-89e4-73364abb9796" />

<br>  
  
## ⚡️ Функционал:
  - 📊 Мониторинг и управление сервисом
  - 📝 Редактирование JSON конфигов с валидацией и форматированием
  - 📜 Просмотр логов с автообновлением и фильтрацией
  - 🕒 Корректировка часового пояса в логах с UTC на UTC+3
  - 🔀 Переключение между ядрами Xray и Mihomo
  
Предполагается, что до начала установки веб-сервер `lighttpd` **не установлен**.
  
&nbsp;
>[!CAUTION]
>Панель тестировалась только на ARM роутере Keenetic KN-3811.  
>Работоспособность на других архитектурах не гарантируется, ставить на свой страх и риск.
  
&nbsp;

## 📥 Установка / обновление

```SH
opkg update && opkg install curl
```
```SH
curl -Ls https://raw.githubusercontent.com/zxc-rv/XKeen-UI/main/install.sh | sh
```
<br>
  
>[!TIP]
>По умолчанию ставится **последняя версия.**  
>Для установки конкретной версии добавьте `-s v1.2.3` **в конец команды.**  
  
<br>
  
## 🗑 Удаление
```SH
curl -Ls https://raw.githubusercontent.com/zxc-rv/XKeen-UI/main/remove.sh | sh
```
&nbsp;
  
## 🙏 Благодарности

- [Skrill0/XKeen](https://github.com/Skrill0/XKeen)  
- [jameszeroX/XKeen](https://github.com/jameszeroX/XKeen)  
- [Anonym-tsk/nfqws-keenetic](https://github.com/Anonym-tsk/nfqws-keenetic) 
