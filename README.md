<img width="2509" height="1270" alt="image" src="https://github.com/user-attachments/assets/9ca5cd85-0c87-4448-865a-d73b82fd0475" />  
<br>
<br>
Веб-панель с современным дизайном для управления сервисом XKeen. Функционал:
  1. Мониторинг и управление сервисом
  2. Редактирование конфигов с JSON валидацией и форматированием
  3. Просмотр логов с автообновлением и фильтрацией
  
Предполагается, что до начала установки веб-сервер lighttpd не установлен.  
  
&nbsp;
>[!WARNING]
>Панель на ранней стадии разработки и тестировалась только на ARM64 роутере Keenetic KN-3811.  
>Ставить на свой страх и риск!  
>Если ваш роутер взорвется после установки, автор данного репозитория нести ответственность не будет.
  
&nbsp;

Установка:

```
opkg update && opkg install curl
```
```
curl -Ls https://raw.githubusercontent.com/zxc-rv/XKeen-UI/refs/heads/main/install.sh | sh
```
  
---
Благодарности:

https://github.com/Skrill0/XKeen  
https://github.com/jameszeroX/XKeen  
https://github.com/Anonym-tsk/nfqws-keenetic
