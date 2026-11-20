#!/bin/bash

APP_DIR="/home/j/Документы/Новопак/zakupki_projects"

if fuser 5055/tcp >/dev/null 2>&1; then
    fuser -k 5055/tcp >/dev/null 2>&1 || true
    pkill -9 -f "$APP_DIR/app.py" 2>/dev/null || true
    zenity --info --title="Система закупок" --text="🔴 Программа ВЫКЛЮЧЕНА." --timeout=3 2>/dev/null || true
else
    cd "$APP_DIR"
    "$APP_DIR/venv/bin/python3" "$APP_DIR/app.py" > "$APP_DIR/server.log" 2>&1 &
    sleep 1
    if fuser 5055/tcp >/dev/null 2>&1; then
        zenity --info --title="Система закупок" --text="🟢 Программа ВКЛЮЧЕНА!\n\nАдрес для браузера:\nhttp://127.0.0\n\n(Чтобы выключить — нажмите на ярлык ещё раз)" --timeout=4 2>/dev/null || true
    else
        zenity --error --title="Ошибка запуска" --text="Сервер не запустился. Проверьте файл server.log" 2>/dev/null || true
    fi
fi
